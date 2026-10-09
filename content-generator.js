
const fs = require("fs");
const path = require("path");

require("dotenv").config();

const { searchAllBrands } = require("./fetcher");

const {
  getPostedProducts,
  savePostedProductsToDb,
} = require("./database");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const POSTED_PRODUCTS_FILE =
  process.env.POSTED_PRODUCTS_FILE ||
  path.join(__dirname, "posted-products.json");

// ============================================================
// POSTED PRODUCT MEMORY — MONGODB + LOCAL BACKUP
// ============================================================

function loadLocalPostedProducts() {
  try {
    if (!fs.existsSync(POSTED_PRODUCTS_FILE)) return [];

    const data = fs
      .readFileSync(POSTED_PRODUCTS_FILE, "utf8")
      .trim();

    if (!data) return [];

    const parsed = JSON.parse(data);

    if (!Array.isArray(parsed)) {
      console.warn(
        "[S-Brand] Local history is not an array."
      );
      return [];
    }

    return parsed;
  } catch (error) {
    console.error(
      "[S-Brand] Failed to read local history:",
      error.message
    );
    return [];
  }
}

/**
 * MongoDB is the source of truth.
 * If Atlas is unavailable, throw an error rather than risk
 * publishing products that have already been posted.
 */
async function loadPostedProducts() {
  let products = await getPostedProducts();

  // One-time recovery/migration if Atlas is empty but the
  // local JSON backup already contains history.
  if (products.length === 0) {
    const localProducts = loadLocalPostedProducts();

    if (localProducts.length > 0) {
      console.log(
        `[S-Brand] Restoring ${localProducts.length} local records to MongoDB.`
      );

      await savePostedProductsToDb(localProducts);
      products = await getPostedProducts();
    }
  }

  return products;
}

/**
 * Save history to MongoDB first, then update the local backup.
 * MongoDB's unique key index prevents duplicate primary keys.
 */
async function savePostedProducts(products) {
  if (!Array.isArray(products)) {
    throw new Error("Posted products must be an array.");
  }

  await savePostedProductsToDb(products);

  try {
    const tmpFile = `${POSTED_PRODUCTS_FILE}.tmp`;
    const directory = path.dirname(POSTED_PRODUCTS_FILE);

    fs.mkdirSync(directory, { recursive: true });

    fs.writeFileSync(
      tmpFile,
      JSON.stringify(products, null, 2),
      "utf8"
    );

    fs.renameSync(tmpFile, POSTED_PRODUCTS_FILE);
  } catch (error) {
    // MongoDB has already saved the records.
    console.warn(
      "[S-Brand] MongoDB saved history, but local backup failed:",
      error.message
    );
  }
}

// ============================================================
// PRODUCT NORMALIZATION AND KEYS
// ============================================================

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeUrl(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .split("?")[0]
    .replace(/\/+$/, "")
    .replace(/-\d+$/, "");
}

function getProductName(product) {
  return (
    product.productName ||
    product.title ||
    product.name ||
    ""
  );
}

function getProductKey(product) {
  if (!product) return null;

  const brand = normalizeText(product.brand);
  const name = normalizeText(getProductName(product));

  if (brand && name) {
    return `product:${brand}:${name}`;
  }

  if (product.id) {
    return `id:${String(product.id).trim()}`;
  }

  if (product.productId) {
    return `productId:${String(product.productId).trim()}`;
  }

  const url = normalizeUrl(
    product.url || product.productUrl
  );

  if (url) return `url:${url}`;

  return null;
}

function getAllProductKeys(product) {
  const keys = new Set();

  if (!product) return keys;

  const primary = getProductKey(product);
  if (primary) keys.add(primary);

  if (product.id) {
    keys.add(`id:${String(product.id).trim()}`);
  }

  if (product.productId) {
    keys.add(`productId:${String(product.productId).trim()}`);
  }

  const rawUrl = String(
    product.url || product.productUrl || ""
  )
    .trim()
    .toLowerCase();

  if (rawUrl) keys.add(`url:${rawUrl}`);

  const normalizedUrl = normalizeUrl(rawUrl);
  if (normalizedUrl) {
    keys.add(`url:${normalizedUrl}`);
  }

  return keys;
}

function buildPostedKeySet(postedProducts) {
  const keys = new Set();

  for (const entry of postedProducts) {
    if (entry.key) keys.add(entry.key);

    const storedProduct = {
      id: entry.productId,
      brand: entry.brand,
      productName: entry.productName,
      url: entry.productUrl,
    };

    for (const key of getAllProductKeys(storedProduct)) {
      keys.add(key);
    }
  }

  return keys;
}

// ============================================================
// MARK PRODUCT AS POSTED
// Call ONLY after Instagram confirms successful publication.
// ============================================================

async function markProductAsPosted(product) {
  if (!product) {
    console.warn(
      "[S-Brand] Cannot mark an empty product as posted."
    );
    return;
  }

  const key = getProductKey(product);

  if (!key) {
    console.warn(
      "[S-Brand] Product has no usable key. Not saved."
    );
    return;
  }

  const postedProducts = await loadPostedProducts();
  const postedKeys = buildPostedKeySet(postedProducts);

  const alreadyPosted = [...getAllProductKeys(product)].some(
    (candidateKey) => postedKeys.has(candidateKey)
  );

  if (alreadyPosted) {
    console.log(
      `[S-Brand] Product already exists in history: ${key}`
    );
    return;
  }

  const record = {
    key,
    productId: product.id || product.productId || null,
    productName: getProductName(product) || null,
    brand: product.brand || null,
    price: product.price || null,
    productUrl: product.url || product.productUrl || null,
    postedAt: new Date().toISOString(),
  };

  await savePostedProducts([...postedProducts, record]);

  console.log(
    `[S-Brand] Product saved to MongoDB history: ${key}`
  );
}

// ============================================================
// TREND TOPICS
// ============================================================

const TREND_SEED_TOPICS = [
  "oversized henley",
  "bootcut jeans",
  "waffle knit henley",
  "leather jacket",
  "ribbed henley",
  "cargo pants",
];

function pickWeeklyTopic() {
  const now = new Date();

  const weekNumber = Math.floor(
    (now - new Date(now.getFullYear(), 0, 1)) /
      (7 * 24 * 60 * 60 * 1000)
  );

  return TREND_SEED_TOPICS[
    weekNumber % TREND_SEED_TOPICS.length
  ];
}

// ============================================================
// FIND FEATURED PRODUCT — CHECK MONGODB HISTORY
// ============================================================

async function findFeaturedProduct(topic) {
  const results = await searchAllBrands(topic);

  const inStock = results.filter(
    (product) => product.stockStatus === "in"
  );

  if (inStock.length === 0) {
    throw new Error(
      `No in-stock products found for topic "${topic}"`
    );
  }

  // This is asynchronous because history comes from MongoDB.
  const postedProducts = await loadPostedProducts();
  const postedKeys = buildPostedKeySet(postedProducts);

  const seenThisRun = new Set();
  const unusedProducts = [];

  for (const product of inStock) {
    const keys = [...getAllProductKeys(product)];

    if (keys.length === 0) continue;

    if (keys.some((key) => postedKeys.has(key))) {
      continue;
    }

    const primary = getProductKey(product);

    if (!primary || seenThisRun.has(primary)) {
      continue;
    }

    seenThisRun.add(primary);
    unusedProducts.push(product);
  }

  console.log(
    `[S-Brand] Found ${inStock.length} in-stock products.`
  );

  console.log(
    `[S-Brand] ${postedProducts.length} products already in MongoDB history.`
  );

  console.log(
    `[S-Brand] ${unusedProducts.length} products have not been posted yet.`
  );

  if (unusedProducts.length === 0) {
    throw new Error(
      `All in-stock products for topic "${topic}" have already been posted.`
    );
  }

  unusedProducts.sort(
    (a, b) =>
      (b.availableSizes?.length || 0) -
      (a.availableSizes?.length || 0)
  );

  const selectedProduct = unusedProducts[0];

  console.log(
    `[S-Brand] NEW PRODUCT SELECTED: ${
      getProductName(selectedProduct) || "Unknown"
    }`
  );

  console.log(
    `[S-Brand] Product key: ${getProductKey(selectedProduct)}`
  );

  return selectedProduct;
}

// ============================================================
// GEMINI API
// ============================================================

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function callGemini(prompt, maxTokens = 1200) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY is missing from your .env file"
    );
  }

  const models = [
    "gemini-3.8-flash",
    "gemini-3.7-flash",
  ];

  let lastError = null;

  for (const model of models) {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(
          `[Gemini] ${model} → Attempt ${attempt}/3`
        );

        const response = await fetch(
          `${url}?key=${GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              contents: [
                {
                  parts: [{ text: prompt }],
                },
              ],
              generationConfig: {
                maxOutputTokens: maxTokens,
                temperature: 0.7,
              },
            }),
          }
        );

        const responseText = await response.text();

        if (response.ok) {
          const data = JSON.parse(responseText);

          const result =
            data.candidates?.[0]?.content?.parts?.[0]?.text;

          if (!result) {
            throw new Error(
              `Gemini ${model} returned an empty response`
            );
          }

          console.log(`[Gemini] ${model} → SUCCESS`);

          return result.trim();
        }

        lastError = new Error(
          `Gemini ${model} API error ${response.status}: ${responseText}`
        );

        if ([429, 500, 503].includes(response.status)) {
          if (attempt < 3) {
            const delay =
              5000 * Math.pow(2, attempt - 1);

            console.log(
              `[Gemini] ${response.status}. Retrying in ${delay / 1000}s...`
            );

            await sleep(delay);
            continue;
          }

          console.log(
            `[Gemini] ${model} failed after 3 attempts.`
          );
          break;
        }

        lastError.permanent = true;
        throw lastError;
      } catch (error) {
        lastError = error;

        if (error.permanent) {
          console.log(
            `[Gemini] ${model} permanent error. Skipping retries.`
          );
          break;
        }

        if (attempt < 3) {
          const delay =
            5000 * Math.pow(2, attempt - 1);

          console.log(
            `[Gemini] Request failed. Retrying in ${delay / 1000}s...`
          );

          await sleep(delay);
        }
      }
    }

    console.log(
      `[Gemini] Trying fallback model: ${
        models[models.indexOf(model) + 1] || "none"
      }`
    );
  }

  throw lastError || new Error("All Gemini models failed");
}

// ============================================================
// AUTOMATIC CAPTION GENERATOR
// ============================================================

async function generateCaptionAndHashtags(product, topic) {
  const prompt = `You are writing an Instagram caption for S-Brand, a platform that compares live price and stock across 17+ Indian D2C fashion brands.

Featured product this week: "${product.productName}" from ${product.brand}, priced at ₹${product.price}.
Trend angle: ${topic}

Write:
1. A short, punchy Instagram caption (2-3 sentences max), casual Gen-Z-friendly Indian English.
2. A line inviting people to check "link in bio" to compare.
3. 15-18 Instagram hashtags (broad + niche + #sbrand + India-specific).

IMPORTANT:
Return ONLY valid JSON.
Do NOT use markdown code fences.
Do NOT add any explanation before or after the JSON.

Use exactly this structure:
{
  "caption": "your caption",
  "cta": "your call to action",
  "hashtags": ["#tag1", "#tag2", "#tag3"]
}`;

  const text = await callGemini(prompt);

  try {
    let cleaned = text
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start !== -1 && end !== -1 && end > start) {
      cleaned = cleaned.slice(start, end + 1);
    }

    const parsed = JSON.parse(cleaned);

    if (
      !parsed.caption ||
      !parsed.cta ||
      !Array.isArray(parsed.hashtags)
    ) {
      throw new Error(
        "Gemini returned incomplete caption JSON"
      );
    }

    return {
      caption: parsed.caption.trim(),
      cta: parsed.cta.trim(),
      hashtags: parsed.hashtags
        .map((tag) => String(tag).trim())
        .filter(Boolean),
    };
  } catch (error) {
    console.log(
      "[Gemini] Caption JSON parsing failed."
    );
    console.log("[Gemini] Raw response:", text);

    throw new Error(
      "Could not parse Gemini caption response as JSON"
    );
  }
}

// ============================================================
// AUTO AGENT PIPELINE
// ============================================================

async function generateWeeklyPost(useAiImage = false) {
  const { generateTrendImage } = require("./gemini-image");

  const topic = pickWeeklyTopic();

  console.log(`[S-Brand] Weekly topic: ${topic}`);

  const product = await findFeaturedProduct(topic);

  const content = await generateCaptionAndHashtags(
    product,
    topic
  );

  let imageData = {
    imageUrl: product.image,
    aiGenerated: false,
  };

  if (useAiImage) {
    try {
      const aiImage = await generateTrendImage(
        product,
        topic
      );

      imageData = {
        imageBase64: aiImage.base64,
        imageMimeType: aiImage.mimeType,
        aiGenerated: true,
      };
    } catch (error) {
      console.warn(
        "Gemini image generation failed; using product photo:",
        error.message
      );

      imageData = {
        imageUrl: product.image,
        aiGenerated: false,
      };
    }
  }

  return {
    ...imageData,

    productName: product.productName,
    brand: product.brand,
    price: product.price,
    productUrl: product.url,

    // Used by state-machine.js after successful publication.
    product,

    caption: content.caption,
    cta: content.cta,
    hashtags: content.hashtags,

    fullCaptionText:
      `${content.caption}\n\n` +
      `${content.cta}\n\n` +
      content.hashtags
        .map((tag) => `#${tag.replace(/^#/, "")}`)
        .join(" "),
  };
}

// ============================================================
// MANUAL DASHBOARD AI CONTENT
// ============================================================

async function generateCustomCaption(
  product,
  style,
  extraPrompt
) {
  const prompt = `You are writing an Instagram caption for S-Brand, a platform that compares live price and stock across 17+ Indian D2C fashion brands.

Product: ${product || "a trending fashion item"}
Style: ${style || "Streetwear"}
${extraPrompt ? `Additional instructions: ${extraPrompt}` : ""}

Write a ready-to-post Instagram caption (2-4 sentences), a line inviting people to compare on S-Brand (link in bio), then 15-18 hashtags (broad + niche + #sbrand + India-specific).

Respond with ONLY the final caption text, fully formatted, ready to paste into Instagram — no JSON, no explanation.`;

  return callGemini(prompt, 500);
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  generateWeeklyPost,
  pickWeeklyTopic,
  findFeaturedProduct,
  generateCustomCaption,

  // Product memory functions
  loadPostedProducts,
  savePostedProducts,
  getProductKey,
  markProductAsPosted,
};
