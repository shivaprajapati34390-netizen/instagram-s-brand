// scheduler.js
// Runs the full content pipeline on a daily schedule using node-cron.
// Each run: pick trend -> find product -> generate caption/hashtags ->
// generate AI image -> attempt to publish. If Instagram isn't connected
// yet, the post is saved to a "pending" queue instead of failing silently,
// so the dashboard can show it and you can publish manually in the meantime.

const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const { runStateMachine } = require("./state-machine");

const PUBLIC_IMAGES_DIR = path.join(__dirname, "public", "generated");
const LOG_FILE = path.join(__dirname, "post-log.json");

// Posting times (24-hour, server time — set your server's timezone via TZ env var)
const POSTING_TIMES = ["08:00", "13:00", "19:00"];

// In-memory log, also persisted to disk so it survives restarts.
function loadLog() {
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveLog(log) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function appendLog(entry) {
  const log = loadLog();
  log.unshift(entry); // newest first
  saveLog(log.slice(0, 50)); // keep last 50 entries
}

/**
 * Saves a base64 image to the public folder and returns its public URL.
 * BASE_URL must be set in .env to your deployed server's URL
 * (e.g. https://your-app.onrender.com) so Instagram can fetch it.
 */
function saveGeneratedImage(base64, mimeType) {
  if (!fs.existsSync(PUBLIC_IMAGES_DIR)) {
    fs.mkdirSync(PUBLIC_IMAGES_DIR, { recursive: true });
  }
  const ext = mimeType.includes("png") ? "png" : "jpg";
  const filename = `post-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(PUBLIC_IMAGES_DIR, filename), Buffer.from(base64, "base64"));

  const baseUrl = process.env.BASE_URL || "http://localhost:4000";
  return `${baseUrl}/generated/${filename}`;
}

/**
 * Runs one full cycle: generate content, then publish (or queue).
 * Exported so the dashboard's "Generate Now" button can trigger it manually too.
 */
async function runAutomationCycle(useAiImage = true) {
  const timestamp = new Date().toISOString();

  try {

    const result = await runStateMachine({
      useAiImage,

      saveImage: saveGeneratedImage,
    });


    // ========================================================
    // SUCCESS / PENDING
    // ========================================================

    if (
      result.status === "published" ||
      result.status === "pending"
    ) {

      appendLog({

        timestamp,

        status:
          result.status,

        postId:
          result.postId || null,

        error:
          null,

        imageUrl:
          result.imageUrl,

        productName:
          result.productName,

        brand:
          result.brand,

        caption:
          result.caption,

      });


      console.log(
        `[${timestamp}] Cycle complete — ` +
        `status: ${result.status}`
      );


      return result;
    }


    // ========================================================
    // FSM ERROR
    // ========================================================

    appendLog({

      timestamp,

      status: "error",

      error:
        result.error,

      productName:
        result.post?.productName || null,

      brand:
        result.post?.brand || null,

    });


    console.error(
      `[${timestamp}] Cycle failed:`,
      result.error
    );


    return result;


  } catch (err) {

    appendLog({

      timestamp,

      status: "error",

      error:
        err.message,

    });


    console.error(
      `[${timestamp}] Cycle failed:`,
      err.message
    );


    return {

      status: "error",

      error:
        err.message,

    };
  }
}
function startScheduler() {
  POSTING_TIMES.forEach((time) => {
    const [hour, minute] = time.split(":");

    const cronExpression = `${minute} ${hour} * * *`;

    cron.schedule(cronExpression, () => {
      console.log(`Scheduled run triggered for ${time}`);

      runAutomationCycle(true).catch((err) => {
        console.error("Scheduled run error:", err);
      });
    });

    console.log(`Scheduled daily post at ${time}`);
  });
}

function getNextPostTime() {
  const now = new Date();

  const todayTimes = POSTING_TIMES.map((t) => {
    const [h, m] = t.split(":").map(Number);

    const d = new Date(now);
    d.setHours(h, m, 0, 0);

    return d;
  });

  const upcoming = todayTimes.find((d) => d > now);

  if (upcoming) {
    return upcoming;
  }

  const [h, m] = POSTING_TIMES[0].split(":").map(Number);

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(h, m, 0, 0);

  return tomorrow;
}


// EXPORTS
module.exports = {
  startScheduler,
  runAutomationCycle,
  loadLog,
  getNextPostTime,
  POSTING_TIMES,
};