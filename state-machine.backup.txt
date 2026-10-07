/**
 * state-machine.js
 *
 * S-Brand Autopilot State Machine
 *
 * Flow:
 *
 * START
 *   ↓
 * GENERATE_POST
 *   ↓
 * SAVE_IMAGE
 *   ↓
 * PUBLISH / PENDING
 *   ↓
 * SUCCESS
 *
 * Temporary failures are retried.
 */

const {
  generateWeeklyPost,
  markProductAsPosted,
} = require("./content-generator");

const {
  publishPost,
  isConfigured,
} = require("./instagram");


// ============================================================
// STATES
// ============================================================

const STATES = {
  START: "START",

  GENERATE_POST: "GENERATE_POST",

  SAVE_IMAGE: "SAVE_IMAGE",

  PUBLISH: "PUBLISH",

  PENDING: "PENDING",

  SUCCESS: "SUCCESS",

  FAILED: "FAILED",
};


// ============================================================
// CONFIG
// ============================================================

const MAX_RETRIES = 3;

const RETRY_DELAY = 5000;


// ============================================================
// WAIT
// ============================================================

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}


// ============================================================
// STATE LOGGER
// ============================================================

function logState(state, message = "") {
  const timestamp = new Date().toISOString();

  console.log(
    `[${timestamp}] [FSM] ${state}` +
      (message ? ` → ${message}` : "")
  );
}


// ============================================================
// RETRY HELPER
// ============================================================

async function retryOperation(
  operation,
  operationName,
  maxRetries = MAX_RETRIES
) {
  let lastError;

  for (
    let attempt = 1;
    attempt <= maxRetries;
    attempt++
  ) {

    try {

      logState(
        operationName,
        `Attempt ${attempt}/${maxRetries}`
      );

      const result = await operation();

      return result;

    } catch (error) {

      lastError = error;

      console.warn(
        `[FSM] ${operationName} failed ` +
        `(attempt ${attempt}/${maxRetries}): ` +
        error.message
      );

      if (attempt < maxRetries) {

        const delay =
          RETRY_DELAY *
          Math.pow(2, attempt - 1);

        console.log(
          `[FSM] Retrying ${operationName} ` +
          `in ${delay / 1000}s...`
        );

        await wait(delay);
      }
    }
  }

  throw lastError;
}


// ============================================================
// MAIN FSM
// ============================================================

async function runStateMachine({
  useAiImage = true,
  saveImage,
}) {

  let state = STATES.START;

  let post = null;

  let imageUrl = null;

  let publishResult = null;


  logState(
    state,
    "S-Brand autopilot started"
  );


  try {

    // ========================================================
    // STATE 1
    // GENERATE POST
    // ========================================================

    state = STATES.GENERATE_POST;

    logState(
      state,
      "Finding product + generating content..."
    );


    post = await retryOperation(
      async () => {

        return await generateWeeklyPost(
          useAiImage
        );

      },
      "GENERATE_POST"
    );


    if (!post) {
      throw new Error(
        "generateWeeklyPost() returned nothing"
      );
    }


    if (!post.fullCaptionText) {
      throw new Error(
        "Generated post has no caption"
      );
    }


    logState(
      state,
      `Product: ${post.productName} | Brand: ${post.brand}`
    );


    // ========================================================
    // STATE 2
    // SAVE IMAGE
    // ========================================================

    state = STATES.SAVE_IMAGE;

    logState(
      state,
      "Preparing image..."
    );


    if (post.aiGenerated) {

      if (
        !post.imageBase64 ||
        !post.imageMimeType
      ) {
        throw new Error(
          "AI image was marked as generated but image data is missing"
        );
      }


      if (
        typeof saveImage !== "function"
      ) {
        throw new Error(
          "saveImage() function was not provided"
        );
      }


      imageUrl = saveImage(
        post.imageBase64,
        post.imageMimeType
      );


    } else {

      imageUrl = post.imageUrl;
    }


    if (!imageUrl) {
      throw new Error(
        "No image URL available"
      );
    }


    logState(
      state,
      `Image ready: ${imageUrl}`
    );


    // ========================================================
    // STATE 3
    // PUBLISH / PENDING
    // ========================================================

    if (!isConfigured()) {

      state = STATES.PENDING;

      logState(
        state,
        "Instagram not configured — saving as pending"
      );


      return {

        success: true,

        state,

        status: "pending",

        imageUrl,

        caption: post.fullCaptionText,

        productName:
          post.productName,

        brand:
          post.brand,

        price:
          post.price,

        post,

      };
    }


    // ========================================================
    // STATE 4
    // PUBLISH
    // ========================================================

    state = STATES.PUBLISH;

    logState(
      state,
      "Publishing to Instagram..."
    );


    publishResult =
      await retryOperation(
        async () => {

          return await publishPost(
            imageUrl,
            post.fullCaptionText
          );

        },
        "PUBLISH_INSTAGRAM"
      );


    // ========================================================
    // MARK PRODUCT AS POSTED
    // ========================================================
    //
    // IMPORTANT:
    // Only mark the product AFTER Instagram confirms
    // that the post was successfully published.
    //
    // This prevents a failed Instagram upload from
    // permanently blocking the product.
    // ========================================================

    if (post.product) {

      markProductAsPosted(
        post.product
      );

      logState(
        state,
        `Product marked as posted: ${post.productName}`
      );

    } else {

      console.warn(
        "[FSM] Product data missing — could not save posted-product history"
      );

    }


    // ========================================================
    // STATE 5
    // SUCCESS
    // ========================================================

    state = STATES.SUCCESS;

    logState(
      state,
      "Instagram post published successfully"
    );


    return {

      success: true,

      state,

      status: "published",

      postId:
        publishResult?.postId || null,

      imageUrl,

      caption:
        post.fullCaptionText,

      productName:
        post.productName,

      brand:
        post.brand,

      price:
        post.price,

      post,

      publishResult,

    };


  } catch (error) {

    // ========================================================
    // FAILED
    // ========================================================

    state = STATES.FAILED;

    logState(
      state,
      error.message
    );


    return {

      success: false,

      state,

      status: "error",

      error:
        error.message,

      imageUrl,

      post,

      failedAt:
        new Date().toISOString(),

    };
  }
}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {

  STATES,

  runStateMachine,

  retryOperation,

};