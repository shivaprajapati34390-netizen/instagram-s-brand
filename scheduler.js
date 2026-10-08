// scheduler.js
// Runs the full content pipeline on a daily schedule using node-cron.
//
// Each run:
//   trend -> product -> caption -> image -> publish
//
// Duplicate protection is handled by content-generator.js
// using posted-products.json.
//
// This file additionally prevents two automation cycles from
// running at the same time (for example, scheduled run +
// Dashboard "Generate Now").

// ============================================================
// IMPORTS
// ============================================================

const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

const { runStateMachine } = require("./state-machine");


// ============================================================
// PATHS
// ============================================================

const PUBLIC_IMAGES_DIR = path.join(
  __dirname,
  "public",
  "generated"
);

const LOG_FILE = path.join(
  __dirname,
  "post-log.json"
);


// ============================================================
// POSTING TIMES
// ============================================================
//
// 3 automatic posts per day.
//
// IMPORTANT:
// These times use the server's timezone.
// On Render, configure the TZ environment variable if needed.
//

const POSTING_TIMES = [
  "08:00",
  "13:00",
  "19:00",
];


// ============================================================
// AUTOMATION LOCK
// ============================================================
//
// Prevents two automation cycles from running simultaneously.
//
// Example:
//
// Scheduled 08:00
//       ↓
// runAutomationCycle()
//       ↓
// automationRunning = true
//
// If Dashboard "Generate Now" is pressed during that run:
//       ↓
// second run is rejected/skipped
//
// This prevents two cycles from selecting the same product
// before posted-products.json is updated.
//

let automationRunning = false;


// ============================================================
// LOAD LOG
// ============================================================

function loadLog() {
  try {
    if (!fs.existsSync(LOG_FILE)) {
      return [];
    }

    const data = fs.readFileSync(
      LOG_FILE,
      "utf-8"
    );

    if (!data.trim()) {
      return [];
    }

    const parsed = JSON.parse(data);

    if (!Array.isArray(parsed)) {
      console.warn(
        "[S-Brand] post-log.json is not an array. Resetting."
      );

      return [];
    }

    return parsed;

  } catch (error) {

    console.error(
      "[S-Brand] Failed to load post-log.json:",
      error.message
    );

    return [];
  }
}


// ============================================================
// SAVE LOG
// ============================================================

function saveLog(log) {
  try {

    fs.writeFileSync(
      LOG_FILE,
      JSON.stringify(log, null, 2),
      "utf-8"
    );

  } catch (error) {

    console.error(
      "[S-Brand] Failed to save post-log.json:",
      error.message
    );

    throw error;
  }
}


// ============================================================
// APPEND LOG
// ============================================================
//
// Newest post is placed at the beginning.
//
// Dashboard history keeps the latest 50 entries.
//

function appendLog(entry) {

  const log = loadLog();

  log.unshift(entry);

  saveLog(
    log.slice(0, 50)
  );
}


// ============================================================
// SAVE GENERATED IMAGE
// ============================================================
//
// Saves a base64 image into:
//
// public/generated/
//
// and returns a public URL.
//
// BASE_URL should be set in Render:
//
// https://your-app.onrender.com
//

function saveGeneratedImage(
  base64,
  mimeType
) {

  if (!fs.existsSync(PUBLIC_IMAGES_DIR)) {

    fs.mkdirSync(
      PUBLIC_IMAGES_DIR,
      {
        recursive: true,
      }
    );
  }


  const ext =
    mimeType &&
    mimeType.includes("png")
      ? "png"
      : "jpg";


  const filename =
    `post-${Date.now()}.${ext}`;


  const filePath =
    path.join(
      PUBLIC_IMAGES_DIR,
      filename
    );


  fs.writeFileSync(
    filePath,
    Buffer.from(
      base64,
      "base64"
    )
  );


  const baseUrl =
    process.env.BASE_URL ||
    "http://localhost:4000";


  return `${baseUrl}/generated/${filename}`;
}


// ============================================================
// RUN AUTOMATION CYCLE
// ============================================================
//
// This function is used by:
//
// 1. Automatic scheduler
// 2. Dashboard "Generate Now"
//
// The automation lock is important because otherwise:
//
// Scheduler
//     ↓
// Product A selected
//
// Generate Now
//     ↓
// Product A selected again
//
// Both could publish Product A before the first one is
// recorded inside posted-products.json.
//

async function runAutomationCycle(
  useAiImage = true
) {

  // ==========================================================
  // DUPLICATE RUN PROTECTION
  // ==========================================================

  if (automationRunning) {

    console.log(
      "[S-Brand] ⏭️ Automation already running. " +
      "Skipping this cycle."
    );

    return {

      success: false,

      status: "skipped",

      reason:
        "automation_already_running",

    };
  }


  // ==========================================================
  // LOCK
  // ==========================================================

  automationRunning = true;


  const timestamp =
    new Date().toISOString();


  console.log(
    `[${timestamp}] 🔒 Automation lock acquired.`
  );


  try {

    // ========================================================
    // RUN STATE MACHINE
    // ========================================================

    const result =
      await runStateMachine({

        useAiImage,

        saveImage:
          saveGeneratedImage,

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
          result.postId ||
          null,

        error:
          null,

        imageUrl:
          result.imageUrl ||
          null,

        productName:
          result.productName ||
          null,

        brand:
          result.brand ||
          null,

        caption:
          result.caption ||
          null,

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
        result.error ||
        "Unknown state-machine error",

      productName:
        result.post?.productName ||
        null,

      brand:
        result.post?.brand ||
        null,

    });


    console.error(
      `[${timestamp}] Cycle failed:`,
      result.error
    );


    return result;


  } catch (err) {

    // ========================================================
    // UNEXPECTED ERROR
    // ========================================================

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

      success: false,

      status: "error",

      error:
        err.message,

    };


  } finally {

    // ========================================================
    // ALWAYS RELEASE LOCK
    // ========================================================
    //
    // Even if the cycle fails, the lock must be released.
    //
    // Otherwise the scheduler would remain permanently locked.
    //

    automationRunning = false;


    console.log(
      `[${new Date().toISOString()}] ` +
      "🔓 Automation lock released."
    );
  }
}


// ============================================================
// START SCHEDULER
// ============================================================
//
// Creates one cron job for each posting time.
//
// Example:
//
// 08:00
// 13:00
// 19:00
//
// The lock inside runAutomationCycle() prevents overlapping
// scheduled/manual runs.
//

function startScheduler() {

  POSTING_TIMES.forEach(
    (time) => {

      const [
        hour,
        minute,
      ] = time.split(":");


      const cronExpression =
        `${minute} ${hour} * * *`;


      cron.schedule(
        cronExpression,
        () => {

          console.log(
            `[S-Brand] ⏰ Scheduled run triggered for ${time}`
          );


          runAutomationCycle(
            true
          ).catch(
            (err) => {

              console.error(
                "[S-Brand] Scheduled run error:",
                err
              );

            }
          );

        }
      );


      console.log(
        `[S-Brand] Scheduled daily post at ${time}`
      );

    }
  );
}


// ============================================================
// GET NEXT POST TIME
// ============================================================
//
// Used by the dashboard to display the next scheduled run.
//

function getNextPostTime() {

  const now =
    new Date();


  const todayTimes =
    POSTING_TIMES.map(
      (time) => {

        const [
          h,
          m,
        ] = time
          .split(":")
          .map(Number);


        const date =
          new Date(now);


        date.setHours(
          h,
          m,
          0,
          0
        );


        return date;
      }
    );


  const upcoming =
    todayTimes.find(
      (date) =>
        date > now
    );


  if (upcoming) {

    return upcoming;
  }


  // ==========================================================
  // NEXT DAY
  // ==========================================================

  const [
    h,
    m,
  ] =
    POSTING_TIMES[0]
      .split(":")
      .map(Number);


  const tomorrow =
    new Date(now);


  tomorrow.setDate(
    tomorrow.getDate() + 1
  );


  tomorrow.setHours(
    h,
    m,
    0,
    0
  );


  return tomorrow;
}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {

  startScheduler,

  runAutomationCycle,

  loadLog,

  getNextPostTime,

  POSTING_TIMES,

};