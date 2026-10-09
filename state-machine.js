
/**
 * state-machine.js
 *
 * S-Brand Instagram Autopilot State Machine
 *
 * Flow:
 * START -> GENERATE_POST -> SAVE_IMAGE
 *       -> PUBLISH / PENDING -> SUCCESS / FAILED
 *
 * Includes a final MongoDB duplicate check before publishing.
 */

const {
  generateWeeklyPost,
  markProductAsPosted,
  loadPostedProducts,
  getProductKey,
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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// STATE LOGGER
// ============================================================

function logState(state, message = "") {
  const timestamp = new Date().toISOString();

  console.log(
    `[${timestamp}] [FSM] ${state}` +
      (message ? ` -> ${message}` : "")
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

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logState(
        operationName,
        `Attempt ${attempt}/${maxRetries}`
      );

      return await operation();
    } catch (error) {
      lastError = error;

      console.warn(
        `[FSM] ${operationName} failed ` +
          `(attempt ${attempt}/${maxRetries}): ${error.message}`
      );

      if (attempt < maxRetries) {
        const delay =
          RETRY_DELAY * Math.pow(2, attempt - 1);

        console.log(
          `[FSM] Retrying ${operationName} in ${delay / 1000}s...`
        );

        await wait(delay);
      }
    }
  }

  throw lastError;
}

// ============================================================
// FINAL DUPLICATE CHECK
// ============================================================

async function isProductAlreadyPosted(product) {
  if (!product) {
    throw new Error(
      "[FSM] Publishing blocked: product data is missing."
    );
  }

  const currentKey = getProductKey(product);

  if (!currentKey) {
    throw new Error(
      "[FSM] Publishing blocked: product key is missing."
    );
  }

  // Read the latest saved history from MongoDB.
  const postedProducts = await loadPostedProducts();

  // Check the primary normalized product key.
  const duplicate = postedProducts.some(
    (entry) => entry && entry.key === currentKey
  );

  if (duplicate) {
    console.warn(
      `[FSM] DUPLICATE BLOCKED: ${currentKey}`
    );
  } else {
    console.log(
      `[FSM] Final duplicate check passed: ${currentKey}`
    );
  }

  return duplicate;
}

// ============================================================
// MAIN STATE MACHINE
// ============================================================

async function runStateMachine({
  useAiImage = true,
  saveImage,
} = {}) {
  let state = STATES.START;
  let post = null;
  let imageUrl = null;
  let publishResult = null;

  logState(state, "S-Brand autopilot started");

  try {
    // ========================================================
    // STATE 1: GENERATE POST
    // ========================================================

    state = STATES.GENERATE_POST;

    logState(
      state,
      "Finding product and generating content..."
    );

    post = await retryOperation(
      async () => generateWeeklyPost(useAiImage),
      "GENERATE_POST"
    );

    if (!post) {
      throw new Error(
        "generateWeeklyPost() returned nothing."
      );
    }

    if (!post.fullCaptionText) {
      throw new Error(
        "Generated post has no caption."
      );
    }

    if (!post.product) {
      throw new Error(
        "Generated post has no product data. Publishing is blocked."
      );
    }

    logState(
      state,
      `Product: ${post.productName || "Unknown"} | ` +
        `Brand: ${post.brand || "Unknown"}`
    );

    // ========================================================
    // STATE 2: SAVE IMAGE
    // ========================================================

    state = STATES.SAVE_IMAGE;

    logState(state, "Preparing image...");

    if (post.aiGenerated) {
      if (!post.imageBase64 || !post.imageMimeType) {
        throw new Error(
          "AI image data is missing."
        );
      }

      if (typeof saveImage !== "function") {
        throw new Error(
          "saveImage() function was not provided."
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
        "No image URL available."
      );
    }

    logState(state, "Image ready.");

    // ========================================================
    // STATE 3: PUBLISH OR SAVE AS PENDING
    // ========================================================

    if (!isConfigured()) {
      state = STATES.PENDING;

      logState(
        state,
        "Instagram is not configured; saving as pending."
      );

      return {
        success: true,
        state,
        status: "pending",
        imageUrl,
        caption: post.fullCaptionText,
        productName: post.productName,
        brand: post.brand,
        price: post.price,
        post,
      };
    }

    // ========================================================
    // FINAL DUPLICATE CHECK
    // Must happen before publishPost().
    // ========================================================

    const alreadyPosted = await isProductAlreadyPosted(
      post.product
    );

    if (alreadyPosted) {
      state = STATES.FAILED;

      logState(
        state,
        "Publishing stopped because this product is already in history."
      );

      return {
        success: false,
        state,
        status: "duplicate",
        reason: "product_already_posted",
        productName: post.productName || null,
        brand: post.brand || null,
        post,
      };
    }

    // ========================================================
    // STATE 4: PUBLISH
    // ========================================================

    state = STATES.PUBLISH;

    logState(state, "Publishing to Instagram...");

    /*
     * Do not automatically retry an ambiguous Instagram publish
     * failure here. Instagram might have published the post even
     * if the response was lost. Retrying could create a duplicate.
     */

    publishResult = await publishPost(
      imageUrl,
      post.fullCaptionText
    );

    if (
      !publishResult ||
      publishResult === false ||
      publishResult.success === false
    ) {
      throw new Error(
        "Instagram did not confirm a successful publish. " +
          "Check Instagram and its logs before manually retrying."
      );
    }

    // ========================================================
    // MARK PRODUCT AS POSTED
    // Only after publishPost returns a non-failure result.
    // ========================================================

    await markProductAsPosted(post.product);

    logState(
      state,
      `Product saved to history: ${post.productName || "Unknown"}`
    );

    // ========================================================
    // STATE 5: SUCCESS
    // ========================================================

    state = STATES.SUCCESS;

    logState(
      state,
      "Instagram post published successfully."
    );

    return {
      success: true,
      state,
      status: "published",
      postId: publishResult?.postId || null,
      imageUrl,
      caption: post.fullCaptionText,
      productName: post.productName,
      brand: post.brand,
      price: post.price,
      post,
      publishResult,
    };
  } catch (error) {
    state = STATES.FAILED;

    logState(state, error.message);

    return {
      success: false,
      state,
      status: "error",
      error: error.message,
      imageUrl,
      post,
      failedAt: new Date().toISOString(),
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
  isProductAlreadyPosted,
};
