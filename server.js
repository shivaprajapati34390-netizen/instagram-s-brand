// server.js
// Main entry point. Wires the dashboard's every button to real backend logic:
//   - Brand Fetcher    -> fetcher.js (live Shopify data, 17 brands)
//   - AI Content       -> content-generator.js (Claude)
//   - AI Images        -> gemini-image.js (Gemini/Imagen)
//   - Publisher        -> instagram.js (real Instagram publish)
//   - Scheduler         -> scheduled-posts.js (one-off scheduled posts)
// Also runs the recurring 3x/day AUTO-AGENT (scheduler.js) in the background —
// this is the fully automatic pipeline: trend -> product -> caption -> image -> post.

require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");

const { BRANDS, searchAllBrands } = require("./fetcher");
const { generateCustomCaption, generateWeeklyPost } = require("./content-generator");
const { generateCustomImage } = require("./gemini-image");
const { publishPost, isConfigured } = require("./instagram");
const { startScheduler, runAutomationCycle, loadLog, getNextPostTime, POSTING_TIMES } = require("./scheduler");
const { addScheduledPost, getUpcoming, startScheduledPostsChecker } = require("./scheduled-posts");

const app = express();
const PORT = process.env.PORT || 4000;
const GENERATED_DIR = path.join(__dirname, "public", "generated");

app.use(express.json());
app.use("/generated", express.static(GENERATED_DIR));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// ---------- Helper: save a base64 image and return its public URL ----------
function saveImageAndGetUrl(base64, mimeType) {
  if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR, { recursive: true });
  const ext = mimeType.includes("png") ? "png" : "jpg";
  const filename = `img-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(GENERATED_DIR, filename), Buffer.from(base64, "base64"));
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  return `${baseUrl}/generated/${filename}`;
}

// ---------- Overview / status ----------
app.get("/api/status", (req, res) => {
  const log = loadLog();
  res.json({
    instagramConnected: isConfigured(),
    postingTimes: POSTING_TIMES,
    nextPostTime: getNextPostTime(),
    recentPosts: log.slice(0, 10),
    publishedCount: log.filter((p) => p.status === "published").length,
    aiCount: log.length,
    brandCount: BRANDS.length,
    scheduledUpcoming: getUpcoming(),
  });
});

// Manual trigger for the full auto-agent cycle (same one that runs 3x/day)
app.post("/api/generate-now", async (req, res) => {
  try {
    const result = await runAutomationCycle(true);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- Brand Fetcher page ----------
app.get("/api/brands", (req, res) => {
  res.json({ brands: BRANDS });
});

app.post("/api/products", async (req, res) => {
  const { brand, query } = req.body;
  try {
    const brandDomain = brand && brand !== "all" ? brand : null;
    const products = await searchAllBrands(query || "", brandDomain);
    res.json({ products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- AI Content page ----------
app.post("/api/generate-content", async (req, res) => {
  const { product, style, prompt } = req.body;
  try {
    const content = await generateCustomCaption(product, style, prompt);
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- AI Images page ----------
app.post("/api/generate-image", async (req, res) => {
  const { prompt, ratio } = req.body;
  if (!prompt) return res.status(400).json({ error: "Missing prompt" });
  try {
    const image = await generateCustomImage(prompt, ratio || "1:1");
    const imageUrl = saveImageAndGetUrl(image.base64, image.mimeType);
    res.json({ imageUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Publisher page ----------
app.post("/api/publish", async (req, res) => {
  const { image, caption } = req.body;
  if (!image || !caption) return res.status(400).json({ error: "Missing image or caption" });
  try {
    const result = await publishPost(image, caption);
    res.json({ success: true, postId: result.postId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- Scheduler page (one-off scheduled posts) ----------
app.post("/api/schedule", (req, res) => {
  const { date, time, caption, image } = req.body;
  if (!date || !time || !caption) {
    return res.status(400).json({ error: "Missing date, time, or caption" });
  }
  const entry = addScheduledPost({ date, time, caption, image });
  res.json({ success: true, entry });
});

app.get("/api/schedule", (req, res) => {
  res.json({ scheduled: getUpcoming() });
});

app.listen(PORT, () => {
  console.log(`S-Brand Instagram Autopilot running on http://localhost:${PORT}`);
  startScheduler();               // recurring 3x/day auto-agent
  startScheduledPostsChecker();   // one-off manually scheduled posts
});
