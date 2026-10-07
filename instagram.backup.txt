// instagram.js
// Publishes an image + caption to Instagram using the "Instagram API with
// Instagram Login" flow — this uses graph.instagram.com, NOT graph.facebook.com,
// because the access token type (starts with "IGAA") is an Instagram User
// access token, not a Facebook Page/User token.
//
// Requires:
//   INSTAGRAM_ACCESS_TOKEN  - the IGAA... token from "Generate token"
//   INSTAGRAM_USER_ID       - your Instagram User ID (from the /me lookup,
//                              NOT the Business Account ID from Business Manager —
//                              these are different IDs under this flow)
// Both go in .env.

const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const INSTAGRAM_USER_ID = process.env.INSTAGRAM_USER_ID;
const API_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.instagram.com/${API_VERSION}`;

function isConfigured() {
  return Boolean(INSTAGRAM_ACCESS_TOKEN && INSTAGRAM_USER_ID);
}

/**
 * Publishes a post. imageUrl must be a PUBLICLY accessible URL —
 * Instagram's servers fetch it directly, so localhost URLs won't work.
 */
async function publishPost(imageUrl, caption) {
  if (!isConfigured()) {
    throw new Error(
      "Instagram is not connected yet (missing INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_USER_ID in .env)."
    );
  }

  // Step 1: create a media container
  const containerRes = await fetch(`${GRAPH_BASE}/${INSTAGRAM_USER_ID}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image_url: imageUrl,
      caption: caption,
      access_token: INSTAGRAM_ACCESS_TOKEN,
    }),
  });
  const containerData = await containerRes.json();

  if (!containerData.id) {
    throw new Error("Failed to create media container: " + JSON.stringify(containerData));
  }

  // Step 2: publish the container
  const publishRes = await fetch(`${GRAPH_BASE}/${INSTAGRAM_USER_ID}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      creation_id: containerData.id,
      access_token: INSTAGRAM_ACCESS_TOKEN,
    }),
  });
  const publishData = await publishRes.json();

  if (!publishData.id) {
    throw new Error("Failed to publish: " + JSON.stringify(publishData));
  }

  return { postId: publishData.id };
}

/**
 * Verifies the token/account works, mirroring the manual browser test
 * we just ran. Useful as a quick health check from the dashboard later.
 */
async function verifyConnection() {
  const res = await fetch(
    `${GRAPH_BASE}/me?fields=user_id,username&access_token=${INSTAGRAM_ACCESS_TOKEN}`
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data; // { user_id, username, id }
}

module.exports = { publishPost, isConfigured, verifyConnection };

