// scheduled-posts.js
// Handles ONE-OFF posts scheduled manually from the dashboard's
// Scheduler page (different from the recurring 3x/day auto-agent
// in scheduler.js). Stores entries in a JSON file and checks every
// minute for anything due to publish.

const fs = require("fs");
const path = require("path");
const { publishPost, isConfigured } = require("./instagram");

const FILE = path.join(__dirname, "scheduled-posts.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8"));
  } catch {
    return [];
  }
}

function save(list) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

function addScheduledPost({ date, time, caption, image }) {
  const list = load();
  const entry = {
    id: Date.now().toString(),
    scheduledFor: `${date}T${time}:00`,
    caption,
    image,
    status: "scheduled",
    createdAt: new Date().toISOString(),
  };
  list.push(entry);
  save(list);
  return entry;
}

function getUpcoming() {
  return load().filter((p) => p.status === "scheduled");
}

function getAll() {
  return load();
}

/**
 * Call once a minute. Publishes anything whose time has arrived.
 */
async function checkAndPublishDue() {
  const list = load();
  const now = new Date();
  let changed = false;

  for (const post of list) {
    if (post.status !== "scheduled") continue;
    if (new Date(post.scheduledFor) > now) continue;

    changed = true;
    if (!isConfigured()) {
      post.status = "failed";
      post.error = "Instagram not connected";
      continue;
    }

    try {
      const result = await publishPost(post.image, post.caption);
      post.status = "published";
      post.postId = result.postId;
    } catch (err) {
      post.status = "failed";
      post.error = err.message;
    }
  }

  if (changed) save(list);
}

function startScheduledPostsChecker() {
  setInterval(() => {
    checkAndPublishDue().catch((err) => console.error("Scheduled-post check error:", err));
  }, 60 * 1000); // every minute
  console.log("One-off post scheduler checker started (every 60s)");
}

module.exports = { addScheduledPost, getUpcoming, getAll, startScheduledPostsChecker };
