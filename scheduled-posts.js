// scheduled-posts.js
// Handles manually scheduled one-off Instagram posts.

const fs = require("fs");
const path = require("path");

const SCHEDULE_FILE = path.join(__dirname, "scheduled-posts.json");

function loadScheduled() {
  try {
    if (!fs.existsSync(SCHEDULE_FILE)) {
      return [];
    }

    const data = fs.readFileSync(SCHEDULE_FILE, "utf-8");

    if (!data.trim()) {
      return [];
    }

    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("[Scheduled Posts] Failed to load:", error.message);
    return [];
  }
}

function saveScheduled(posts) {
  fs.writeFileSync(
    SCHEDULE_FILE,
    JSON.stringify(posts, null, 2),
    "utf-8"
  );
}

function addScheduledPost({ date, time, caption, image }) {
  const posts = loadScheduled();

  const scheduledFor = new Date(`${date}T${time}:00+05:30`);

  const entry = {
    id: `scheduled-${Date.now()}`,
    scheduledFor: scheduledFor.toISOString(),
    date,
    time,
    caption,
    image: image || null,
    status: "scheduled",
    createdAt: new Date().toISOString(),
  };

  posts.push(entry);
  saveScheduled(posts);

  return entry;
}

function getUpcoming() {
  const posts = loadScheduled();
  const now = Date.now();

  return posts
    .filter((post) => {
      return (
        post.status === "scheduled" &&
        new Date(post.scheduledFor).getTime() >= now
      );
    })
    .sort(
      (a, b) =>
        new Date(a.scheduledFor).getTime() -
        new Date(b.scheduledFor).getTime()
    );
}

function startScheduledPostsChecker() {
  console.log("[Scheduled Posts] One-off scheduler checker started.");

  setInterval(() => {
    const posts = loadScheduled();
    const now = Date.now();

    let changed = false;

    for (const post of posts) {
      if (
        post.status === "scheduled" &&
        new Date(post.scheduledFor).getTime() <= now
      ) {
        console.log(
          `[Scheduled Posts] Post ${post.id} is due.`
        );

        // The existing scheduler/state-machine remains responsible
        // for the main automatic posting pipeline.
        // Marking as due prevents repeated processing.
        post.status = "due";
        post.dueAt = new Date().toISOString();

        changed = true;
      }
    }

    if (changed) {
      saveScheduled(posts);
    }
  }, 30000);
}

module.exports = {
  addScheduledPost,
  getUpcoming,
  startScheduledPostsChecker,
};
