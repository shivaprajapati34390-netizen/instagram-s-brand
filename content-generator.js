const fs = require("fs");
const path = require("path");

require("dotenv").config();

const { searchAllBrands } = require("./fetcher");

const {
  getPostedProducts,
  savePostedProductsToDb,
} = require("./database");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODELS = (
  process.env.GEMINI_MODELS ||
  "gemini-2.5-flash"
)
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);

const POSTED_PRODUCTS_FILE =
  process.env.POSTED_PRODUCTS_FILE ||
  path.join(__dirname, "posted-products.json");

// ============================================================
// LOCAL BACKUP
// ============================================================

function loadLocalPostedProducts() {
  try {
    if (!fs.existsSync(POSTED_PRODUCTS_FILE)) {
      return [];
    }

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

// ============================================================
// MONGODB PRODUCT MEMORY
// ============================================================

async function loadPostedProducts() {
  // MongoDB is the source of truth.
  // If MongoDB is unavailable, stop rather than risk duplicates.
  let products = await getPostedProducts();

  if (!Array.isArray(products)) {
    throw new Error(
      "MongoDB returned invalid product history."
    );
  }

  // Recover local history if the database is empty.
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

async function savePostedProducts(products) {
  if (!Array.isArray(products)) {
    throw new Error(
      "Posted products must be an array."
    );
  }

  // Save to MongoDB first.
  await savePostedProductsToDb(products);

  // Then update the local backup.
  try {
    const directory = path.dirname(
      POSTED_PRODUCTS_FILE
    );

    fs.mkdirSync(directory, {
      recursive: true,
    });

    const tempFile =
      `${POSTED_PRODUCTS_FILE}.tmp`;

    fs.writeFileSync(
      tempFile,
      JSON.stringify(products, null, 2),
      "utf8"
    );

    fs.renameSync(
      tempFile,
      POSTED_PRODUCTS_FILE
    );
  } catch (error) {
    console.warn(
      "[S-Brand] MongoDB saved history, but local backup failed:",
      error.message
    );
  }
}

// ============================================================
// PRODUCT NORMALIZATION
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
    product?.productName ||
    product?.title ||
    product?.name ||
    ""
  );
}

function getProductUrl(product) {
  return (
    product?.url ||
    product?.productUrl ||
    ""
  );
}

function getProductKey(product) {
  if (!product) return null;

  const brand = normalizeText(product.brand);
  const name = normalizeText(
    getProductName(product)
  );

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
    getProductUrl(product)
  );

  if (url) {
    return `url:${url}`;
  }

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
    keys.add(
      `productId:${String(product.productId).trim()}`
    );
  }

  const rawUrl = String(
    getProductUrl(product) || ""
  )
    .trim()
    .toLowerCase();

  if (rawUrl) {
    keys.add(`url:${rawUrl}`);
  }

  const normalizedUrl = normalizeUrl(rawUrl);

  if (normalizedUrl) {
    keys.add(`url:${normalizedUrl}`);
  }

  return keys;
}

function buildPostedKeySet(postedProducts) {
  const keys = new Set();

  for (const entry of postedProducts) {
    if (entry.key) {
      keys.add(entry.key);
    }

    // Support older history record formats.
    const storedProduct = {
      id: entry.productId || entry.id,
      productId: entry.productId,
      brand: entry.brand,
      productName:
        entry.productName ||
        entry.title ||
        entry.name,
      url:
        entry.productUrl ||
        entry.url ||
        "",
    };

    for (const key of getAllProductKeys(
      storedProduct
    )) {
      keys.add(key);
    }
  }

  return keys;
}

// ============================================================
// MARK PRODUCT AS POSTED
// Call only after successful Instagram publication.
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

  const postedProducts =
    await loadPostedProducts();

  const postedKeys =
    buildPostedKeySet(postedProducts);

  const alreadyPosted = [
    ...getAllProductKeys(product),
  ].some((candidateKey) =>
    postedKeys.has(candidateKey)
  );

  if (alreadyPosted) {
    console.log(
      `[S-Brand] Product already exists in history: ${key}`
    );
    return;
  }

  const record = {
    key,
    productId:
      product.id ||
      product.productId ||
      null,
    productName:
      getProductName(product) || null,
    brand: product.brand || null,
    price: product.price ?? null,
    productUrl:
      getProductUrl(product) || null,
    postedAt: new Date().toISOString(),
  };

  await savePostedProducts([
    ...postedProducts,
    record,
  ]);

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
    (
      now -
      new Date(now.getFullYear(), 0, 1)
    ) /
      (7 * 24 * 60 * 60 * 1000)
  );

  return TREND_SEED_TOPICS[
    weekNumber % TREND_SEED_TOPICS.length
  ];
}

// ============================================================
// GEMINI API
// ============================================================

const sleep = (ms) =>
  new Promise((resolve) =>
    setTimeout(resolve, ms)
  );

function isRetryableStatus(status) {
  return [
    408,
    429,
    500,
    502,
    503,
    504,
  ].includes(status);
}

async function callGemini(
  prompt,
  maxTokens = 1200
) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY is missing from environment variables."
    );
  }

  let lastError = null;

  for (const model of GEMINI_MODELS) {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    for (
      let attempt = 1;
      attempt <= 3;
      attempt++
    ) {
      try {
        console.log(
          `[Gemini] ${model} â†’ Attempt ${attempt}/3`
        );

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_API_KEY,
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: prompt,
                  },
                ],
              },
            ],
            generationConfig: {
              maxOutputTokens: maxTokens,
            },
          }),
        });

        const responseText =
          await response.text();

        let data;

        try {
          data = JSON.parse(responseText);
        } catch {
          data = {};
        }

        if (response.ok) {
          const result =
            data.candidates?.[0]?.content?.parts
              ?.map((part) => part.text || "")
              .join("")
              .trim();

          if (!result) {
            lastError = new Error(
              `Gemini ${model} returned no text.`
            );
            break;
          }

          console.log(
            `[Gemini] ${model} â†’ SUCCESS`
          );

          return result;
        }

        lastError = new Error(
          `Gemini ${model} API error ${response.status}: ${responseText}`
        );

        if (
          !isRetryableStatus(response.status)
        ) {
          // Invalid model, key or request: try next model.
          break;
        }

        if (attempt < 3) {
          const delay =
            3000 * Math.pow(2, attempt - 1);

          console.warn(
            `[Gemini] HTTP ${response.status}. Retrying in ${delay / 1000}s.`
          );

          await sleep(delay);
        }
      } catch (error) {
        lastError = error;

        if (attempt < 3) {
          const delay =
            3000 * Math.pow(2, attempt - 1);

          console.warn(
            `[Gemini] Request failed. Retrying in ${delay / 1000}s.`
          );

          await sleep(delay);
        }
      }
    }

    console.warn(
      `[Gemini] Model ${model} failed. Trying next fallback.`
    );
  }

  throw (
    lastError ||
    new Error("All configured Gemini models failed.")
  );
}

// ============================================================
// AUTOMATIC CAPTION GENERATOR
// ============================================================

async function generateCaptionAndHashtags(
  product,
  topic
) {
  const productName =
    getProductName(product) ||
    "Featured fashion product";

  const brand =
    product.brand ||
    "an Indian fashion brand";

  const price =
    product.price !== undefined &&
    product.price !== null
      ? `â‚¹${product.price}`
      : "check the product page for price";

  const prompt = `You are writing an Instagram caption for S-Brand, a platform that compares prices and stock across 17+ Indian D2C fashion brands.

Featured product: "${productName}" from ${brand}, priced at ${price}.
Trend angle: ${topic}

Write:
1. A short, punchy Instagram caption (2-3 sentences maximum), casual Gen-Z-friendly Indian English.
2. A call to action inviting people to check "link in bio" to compare.
3. 15-18 relevant hashtags mixing broad, niche, #sbrand, and India-specific tags.

Return ONLY valid JSON.
Do not use markdown fences or add an explanation.

Use exactly this structure:
{
  "caption": "your caption",
  "cta": "your call to action",
  "hashtags": ["#tag1", "#tag2", "#tag3"]
}`;

  const rawText = await callGemini(
    prompt,
    1200
  );

  try {
    let cleaned = rawText
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (
      start !== -1 &&
      end !== -1 &&
      end > start
    ) {
      cleaned = cleaned.slice(
        start,
        end + 1
      );
    }

    const parsed = JSON.parse(cleaned);

    if (
      typeof parsed.caption !== "string" ||
      typeof parsed.cta !== "string" ||
      !Array.isArray(parsed.hashtags)
    ) {
      throw new Error(
        "Gemini returned incomplete caption JSON."
      );
    }

    return {
      caption: parsed.caption.trim(),
      cta: parsed.cta.trim(),
      hashtags: parsed.hashtags
        .map((tag) =>
          String(tag).trim()
        )
        .filter(Boolean)
        .map((tag) =>
          tag.startsWith("#")
            ? tag
            : `#${tag}`
        ),
    };
  } catch (error) {
    console.error(
      "[Gemini] Caption JSON parsing failed:",
      error.message
    );

    console.error(
      "[Gemini] Raw response:",
      rawText
    );

    throw new Error(
      "Could not parse Gemini caption response as JSON."
    );
  }
}

// ============================================================
// FIND FEATURED PRODUCT â€” MONGODB DUPLICATE CHECK
// ============================================================

async function findFeaturedProduct(topic) {
  const results =
    await searchAllBrands(topic);

  const inStock = results.filter(
    (product) =>
      product &&
      product.stockStatus === "in"
  );

  if (inStock.length === 0) {
    throw new Error(
      `No in-stock products found for topic "${topic}".`
    );
  }

  const postedProducts =
    await loadPostedProducts();

  const postedKeys =
    buildPostedKeySet(postedProducts);

  const seenThisRun = new Set();
  const unusedProducts = [];

  for (const product of inStock) {
    const keys = [
      ...getAllProductKeys(product),
    ];

    if (keys.length === 0) continue;

    if (
      keys.some((key) =>
        postedKeys.has(key)
      )
    ) {
      continue;
    }

    const primary =
      getProductKey(product);

    if (
      !primary ||
      seenThisRun.has(primary)
    ) {
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

  const selectedProduct =
    unusedProducts[0];

  console.log(
    `[S-Brand] NEW PRODUCT SELECTED: ${
      getProductName(selectedProduct) ||
      "Unknown"
    }`
  );

  console.log(
    `[S-Brand] Product key: ${getProductKey(selectedProduct)}`
  );

  return selectedProduct;
}

// ============================================================
// AUTOMATIC POST CONTENT PIPELINE
// ============================================================



async function generateWeeklyPost(useAiImage = false) {
  const preferredTopic = pickWeeklyTopic();

  const topicsToTry = [
    preferredTopic,
    ...TREND_SEED_TOPICS.filter(
      (item) => item !== preferredTopic
    ),
  ];

  let topic = null;
  let product = null;
  let lastError = null;

  // Try the preferred topic first, then other topics.
  for (const candidateTopic of topicsToTry) {
    console.log(
      `[S-Brand] Trying topic: ${candidateTopic}`
    );

    try {
      const selectedProduct =
        await findFeaturedProduct(candidateTopic);

      if (selectedProduct) {
        product = selectedProduct;
        topic = candidateTopic;
        break;
      }
    } catch (error) {
      lastError = error;

      const message = String(
        error?.message || error
      );

      const isDatabaseError =
        /MONGODB_URI|MongoDB|MongoServer|MongoNetwork|MongoTopology|ECONNREFUSED|ENOTFOUND|querySrv|authentication failed/i.test(
          message
        );

      if (isDatabaseError) {
        console.error(
          "[S-Brand] Database error. Stopping product selection:",
          message
        );
        throw error;
      }

      console.warn(
        `[S-Brand] Topic "${candidateTopic}" unavailable: ${message}`
      );
    }
  }

  if (!product) {
    throw new Error(
      "No unused in-stock products found across any trend topic." +
        (lastError
          ? ` Last error: ${lastError.message}`
          : "")
    );
  }

  console.log(
    `[S-Brand] Selected topic: ${topic}`
  );

  console.log(
    `[S-Brand] Selected product: ${
      getProductName(product) || "Unknown product"
    }`
  );

  // Generate caption, CTA, and hashtags.
  const content =
    await generateCaptionAndHashtags(
      product,
      topic
    );

  // Use the product photo by default.
  let imageData = {
    imageUrl:
      product.image ||
      product.imageUrl ||
      null,
    aiGenerated: false,
  };

  // Optionally generate an AI image.
  if (useAiImage) {
    try {
      const {
        generateTrendImage,
      } = require("./gemini-image");

      const aiImage =
        await generateTrendImage(
          product,
          topic
        );

      if (
        !aiImage?.base64 ||
        !aiImage?.mimeType
      ) {
        throw new Error(
          "Image generator returned incomplete image data."
        );
      }

      imageData = {
        imageBase64: aiImage.base64,
        imageMimeType: aiImage.mimeType,
        aiGenerated: true,
      };
    } catch (error) {
      console.warn(
        "[S-Brand] Gemini image generation failed; using product photo:",
        error.message
      );

      imageData = {
        imageUrl:
          product.image ||
          product.imageUrl ||
          null,
        aiGenerated: false,
      };
    }
  }

  const hashtags = (
    Array.isArray(content.hashtags)
      ? content.hashtags
      : []
  )
    .map(
      (tag) =>
        `#${String(tag).replace(/^#+/, "")}`
    )
    .join(" ");

  const fullCaptionText = [
    content.caption,
    content.cta,
    hashtags,
  ]
    .filter(Boolean)
    .join("\n\n");

  if (!fullCaptionText.trim()) {
    throw new Error(
      "Caption generation returned empty content."
    );
  }

  return {
    ...imageData,

    productName: getProductName(product),
    brand: product.brand || null,
    price: product.price ?? null,
    productUrl: getProductUrl(product) || null,

    topic,
    product,

    caption: content.caption,
    cta: content.cta,
    hashtags: content.hashtags,

    fullCaptionText,
  };
}


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
${
  extraPrompt
    ? `Additional instructions: ${extraPrompt}`
    : ""
}

Write a ready-to-post Instagram caption (2-4 sentences), a line inviting people to compare on S-Brand (link in bio), then 15-18 hashtags (broad, niche, #sbrand, and India-specific).

Respond with ONLY the final caption text, fully formatted and ready to paste into Instagram. No JSON and no explanation.`;

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

  loadPostedProducts,
  savePostedProducts,
  getProductKey,
  markProductAsPosted,
};
