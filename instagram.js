// instagram.js
// S-Brand Instagram Publishing
//
// Flow:
// 1. Create media container
// 2. Wait for Instagram to process the image
// 3. Check container status
// 4. Publish when READY
// 5. Retry if Instagram is still processing

const INSTAGRAM_ACCESS_TOKEN =
  process.env.INSTAGRAM_ACCESS_TOKEN;

const INSTAGRAM_USER_ID =
  process.env.INSTAGRAM_USER_ID;

const API_VERSION = "v21.0";

const GRAPH_BASE =
  `https://graph.instagram.com/${API_VERSION}`;


// --------------------------------------------------
// CONFIG CHECK
// --------------------------------------------------

function isConfigured() {
  return Boolean(
    INSTAGRAM_ACCESS_TOKEN &&
    INSTAGRAM_USER_ID
  );
}


// --------------------------------------------------
// WAIT HELPER
// --------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}


// --------------------------------------------------
// GET MEDIA CONTAINER STATUS
// --------------------------------------------------

async function getContainerStatus(containerId) {

  const url =
    `${GRAPH_BASE}/${containerId}` +
    `?fields=status_code,status` +
    `&access_token=${encodeURIComponent(INSTAGRAM_ACCESS_TOKEN)}`;

  const response = await fetch(url);

  const data = await response.json();

  if (!response.ok || data.error) {

    throw new Error(
      "Failed to check Instagram media status: " +
      JSON.stringify(data)
    );
  }

  return data;
}


// --------------------------------------------------
// WAIT UNTIL INSTAGRAM MEDIA IS READY
// --------------------------------------------------

async function waitForMediaReady(
  containerId,
  maxAttempts = 12,
  delayMs = 5000
) {

  console.log(
    `[Instagram] Waiting for media ${containerId} to become ready...`
  );


  for (let attempt = 1; attempt <= maxAttempts; attempt++) {

    try {

      const status =
        await getContainerStatus(containerId);

      console.log(
        `[Instagram] Media status attempt ${attempt}/${maxAttempts}:`,
        status
      );


      // Instagram normally returns:
      //
      // IN_PROGRESS
      // FINISHED
      // ERROR
      //
      // Some API responses may also expose READY.

      const statusCode =
        status.status_code ||
        status.status ||
        "";


      const normalized =
        String(statusCode).toUpperCase();


      if (
        normalized === "FINISHED" ||
        normalized === "READY"
      ) {

        console.log(
          `[Instagram] Media ${containerId} is ready.`
        );

        return true;
      }


      if (
        normalized === "ERROR" ||
        normalized === "EXPIRED"
      ) {

        throw new Error(
          `Instagram media processing failed: ${JSON.stringify(status)}`
        );
      }


      // Still processing.
      console.log(
        `[Instagram] Media still processing. Waiting ${delayMs / 1000}s...`
      );

      await sleep(delayMs);

    } catch (error) {

      // Don't hide actual processing errors.
      throw error;
    }
  }


  throw new Error(
    `Instagram media was not ready after ${maxAttempts} attempts.`
  );
}


// --------------------------------------------------
// PUBLISH INSTAGRAM POST
// --------------------------------------------------

async function publishPost(imageUrl, caption) {

  if (!isConfigured()) {

    throw new Error(
      "Instagram is not connected yet. " +
      "Missing INSTAGRAM_ACCESS_TOKEN or INSTAGRAM_USER_ID."
    );
  }


  if (!imageUrl) {
    throw new Error("Instagram publish failed: image URL is missing.");
  }


  if (!caption) {
    throw new Error("Instagram publish failed: caption is missing.");
  }


  console.log(
    `[Instagram] Creating media container for: ${imageUrl}`
  );


  // --------------------------------------------------
  // STEP 1 — CREATE MEDIA CONTAINER
  // --------------------------------------------------

  const containerRes = await fetch(
    `${GRAPH_BASE}/${INSTAGRAM_USER_ID}/media`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        image_url: imageUrl,
        caption: caption,
        access_token: INSTAGRAM_ACCESS_TOKEN,
      }),
    }
  );


  const containerData =
    await containerRes.json();


  if (
    !containerRes.ok ||
    !containerData.id
  ) {

    throw new Error(
      "Failed to create media container: " +
      JSON.stringify(containerData)
    );
  }


  const containerId =
    containerData.id;


  console.log(
    `[Instagram] Media container created: ${containerId}`
  );


  // --------------------------------------------------
  // STEP 2 — WAIT FOR INSTAGRAM PROCESSING
  // --------------------------------------------------

  await waitForMediaReady(
    containerId,
    12,
    5000
  );


  // --------------------------------------------------
  // STEP 3 — PUBLISH
  // --------------------------------------------------

  console.log(
    `[Instagram] Publishing media container: ${containerId}`
  );


  const publishRes = await fetch(
    `${GRAPH_BASE}/${INSTAGRAM_USER_ID}/media_publish`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        creation_id: containerId,
        access_token: INSTAGRAM_ACCESS_TOKEN,
      }),
    }
  );


  const publishData =
    await publishRes.json();


  if (
    !publishRes.ok ||
    !publishData.id
  ) {

    throw new Error(
      "Failed to publish: " +
      JSON.stringify(publishData)
    );
  }


  // --------------------------------------------------
  // SUCCESS
  // --------------------------------------------------

  console.log(
    `[Instagram] Successfully published! Post ID: ${publishData.id}`
  );


  return {
    postId: publishData.id,
    containerId,
  };
}


// --------------------------------------------------
// VERIFY INSTAGRAM CONNECTION
// --------------------------------------------------

async function verifyConnection() {

  if (!isConfigured()) {

    throw new Error(
      "Instagram credentials are missing."
    );
  }


  const res = await fetch(
    `${GRAPH_BASE}/me?fields=user_id,username` +
    `&access_token=${encodeURIComponent(INSTAGRAM_ACCESS_TOKEN)}`
  );


  const data =
    await res.json();


  if (!res.ok || data.error) {

    throw new Error(
      data.error?.message ||
      "Instagram connection verification failed."
    );
  }


  return data;
}


// --------------------------------------------------
// EXPORTS
// --------------------------------------------------

module.exports = {
  publishPost,
  isConfigured,
  verifyConnection,
};