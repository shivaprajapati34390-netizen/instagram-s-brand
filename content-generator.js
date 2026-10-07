const fs = require("fs");
const path = require("path");

require("dotenv").config();

// content-generator.js
// Two modes:
// 1. generateWeeklyPost() — auto-agent pipeline
// 2. generateCustomCaption() — manual dashboard AI Content tool

const { searchAllBrands } = require("./fetcher");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent";

// ============================================================
// POSTED PRODUCT MEMORY
// ============================================================

const POSTED_PRODUCTS_FILE = path.join(
  __dirname,
  "posted-products.json"
);


/**
 * Load products that S-Brand has already posted.
 */
function loadPostedProducts() {
  try {

    if (!fs.existsSync(POSTED_PRODUCTS_FILE)) {
      return [];
    }

    const data = fs.readFileSync(
      POSTED_PRODUCTS_FILE,
      "utf8"
    ).trim();

    if (!data) {
      return [];
    }

    const parsed = JSON.parse(data);

    if (!Array.isArray(parsed)) {
      console.warn(
        "[S-Brand] posted-products.json is not an array. Resetting."
      );

      return [];
    }

    return parsed;

  } catch (error) {

    console.error(
      "[S-Brand] Failed to read posted-products.json:",
      error.message
    );

    return [];
  }
}


/**
 * Save posted-product history.
 */
function savePostedProducts(products) {

  try {

    fs.writeFileSync(
      POSTED_PRODUCTS_FILE,
      JSON.stringify(products, null, 2),
      "utf8"
    );

  } catch (error) {

    console.error(
      "[S-Brand] Failed to save posted-products.json:",
      error.message
    );

    throw error;
  }
}


/**
 * Generate a stable unique key for a product.
 *
 * Priority:
 * 1. Product ID
 * 2. Product URL
 * 3. Product name + brand
 */
function getProductKey(product) {

  if (!product) {
    return null;
  }

  // ----------------------------------------------------------
  // 1. Use a real product ID when the source provides one
  // ----------------------------------------------------------

  if (product.id) {
    return `id:${String(product.id).trim()}`;
  }

  if (product.productId) {
    return `productId:${String(product.productId).trim()}`;
  }

  // ----------------------------------------------------------
  // 2. For Shopify products without an ID, use:
  //    brand + normalized product name
  //
  //    This prevents the same product from being treated
  //    as different just because Shopify has multiple URLs:
  //
  //    /croc-textured-leather-jacket
  //    /croc-textured-leather-jacket-1
  //    /croc-textured-leather-jacket-2
  // ----------------------------------------------------------

  const brand =
    String(product.brand || "")
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ");

  const name =
    String(
      product.productName ||
      product.title ||
      product.name ||
      ""
    )
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ");

  if (brand && name) {
    return `product:${brand}:${name}`;
  }

  // ----------------------------------------------------------
  // 3. Final fallback: URL
  // ----------------------------------------------------------

  const url =
    product.url ||
    product.productUrl ||
    "";

  if (url) {
    return `url:${String(url).trim().toLowerCase()}`;
  }

  return null;
}


/**
 * Mark a product as successfully posted.
 *
 * IMPORTANT:
 * This function should ONLY be called after
 * Instagram confirms the post was published.
 */
function markProductAsPosted(product) {

  if (!product) {
    console.warn(
      "[S-Brand] Cannot mark empty product as posted."
    );

    return;
  }

  const postedProducts =
    loadPostedProducts();

  const key =
    getProductKey(product);

  // Prevent duplicate history entries
  const alreadyPosted =
    postedProducts.some(
      (item) => item.key === key
    );

  if (alreadyPosted) {

    console.log(
      `[S-Brand] Product already exists in posting history: ${key}`
    );

    return;
  }

  const historyEntry = {

    key,

    productId:
      product.id ||
      product.productId ||
      null,

    productName:
      product.productName ||
      product.title ||
      product.name ||
      null,

    brand:
      product.brand ||
      null,

    price:
      product.price ||
      null,

    productUrl:
      product.url ||
      product.productUrl ||
      null,

    postedAt:
      new Date().toISOString()
  };

  postedProducts.push(historyEntry);

  savePostedProducts(
    postedProducts
  );

  console.log(
    `[S-Brand] ✅ Product saved to posting history: ${key}`
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
// FIND FEATURED PRODUCT
// ============================================================

async function findFeaturedProduct(topic) {

  const results =
    await searchAllBrands(topic);

  const inStock =
    results.filter(
      (r) => r.stockStatus === "in"
    );

  if (inStock.length === 0) {

    throw new Error(
      `No in-stock products found for topic "${topic}"`
    );
  }


  // ----------------------------------------------------------
  // Load previously posted products
  // ----------------------------------------------------------

  const postedProducts =
    loadPostedProducts();

  const postedKeys =
    new Set(
      postedProducts.map(
        (p) => p.key
      )
    );


  // ----------------------------------------------------------
  // Remove products that have already been posted
  // ----------------------------------------------------------

  const unusedProducts =
    inStock.filter(
      (product) => {

        const key =
          getProductKey(product);

        return !postedKeys.has(key);
      }
    );


  console.log(
    `[S-Brand] Found ${inStock.length} in-stock products.`
  );

  console.log(
    `[S-Brand] ${postedProducts.length} products already posted.`
  );

  console.log(
    `[S-Brand] ${unusedProducts.length} products have not been posted yet.`
  );


  // ----------------------------------------------------------
  // No unused products
  // ----------------------------------------------------------

  if (unusedProducts.length === 0) {

    throw new Error(
      `All in-stock products for topic "${topic}" have already been posted.`
    );
  }


  // ----------------------------------------------------------
  // Prefer products with more available sizes
  // ----------------------------------------------------------

  unusedProducts.sort(
    (a, b) =>
      (b.availableSizes?.length || 0) -
      (a.availableSizes?.length || 0)
  );


  // ----------------------------------------------------------
  // Select new product
  // ----------------------------------------------------------

  const selectedProduct =
    unusedProducts[0];


  console.log(
    `[S-Brand] 🆕 NEW PRODUCT SELECTED: ${
      selectedProduct.productName ||
      selectedProduct.title ||
      selectedProduct.name ||
      "Unknown"
    }`
  );

  console.log(
    `[S-Brand] Product key: ${
      getProductKey(selectedProduct)
    }`
  );


  return selectedProduct;
}


// ============================================================
// GEMINI API
// ============================================================

async function callGemini(
  prompt,
  maxTokens = 1200
) {

  if (!GEMINI_API_KEY) {

    throw new Error(
      "GEMINI_API_KEY is missing from your .env file"
    );
  }


  const models = [
    "gemini-3.8-flash",
    "gemini-3.7-flash"
  ];


  let lastError = null;


  for (const model of models) {

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;


    for (
      let attempt = 1;
      attempt <= 3;
      attempt++
    ) {

      try {

        console.log(
          `[Gemini] ${model} → Attempt ${attempt}/3`
        );


        const response =
          await fetch(
            `${url}?key=${GEMINI_API_KEY}`,
            {
              method: "POST",

              headers: {
                "Content-Type": "application/json"
              },

              body: JSON.stringify({

                contents: [
                  {
                    parts: [
                      {
                        text: prompt
                      }
                    ]
                  }
                ],

                generationConfig: {
                  maxOutputTokens: maxTokens,
                  temperature: 0.7
                }

              })
            }
          );


        const responseText =
          await response.text();


        if (response.ok) {

          const data =
            JSON.parse(responseText);


          const result =
            data.candidates?.[0]?.content?.parts?.[0]?.text;


          if (!result) {

            throw new Error(
              `Gemini ${model} returned an empty response`
            );
          }


          console.log(
            `[Gemini] ${model} → SUCCESS`
          );


          return result.trim();
        }


        lastError =
          new Error(
            `Gemini ${model} API error ${response.status}: ${responseText}`
          );


        // Retry temporary errors
        if (
          [429, 500, 503].includes(
            response.status
          )
        ) {

          if (attempt < 3) {

            const delay =
              5000 *
              Math.pow(
                2,
                attempt - 1
              );


            console.log(
              `[Gemini] ${model} returned ${response.status}. ` +
              `Retrying in ${delay / 1000}s...`
            );


            await new Promise(
              resolve =>
                setTimeout(
                  resolve,
                  delay
                )
            );


            continue;
          }


          console.log(
            `[Gemini] ${model} failed after 3 attempts.`
          );


          break;
        }


        // Don't retry permanent errors
        throw lastError;


      } catch (error) {

        lastError =
          error;


        if (attempt < 3) {

          const delay =
            5000 *
            Math.pow(
              2,
              attempt - 1
            );


          console.log(
            `[Gemini] Request failed. ` +
            `Retrying in ${delay / 1000}s...`
          );


          await new Promise(
            resolve =>
              setTimeout(
                resolve,
                delay
              )
          );
        }
      }
    }


    console.log(
      `[Gemini] Trying fallback model: ${
        models[
          models.indexOf(model) + 1
        ] || "none"
      }`
    );
  }


  throw (
    lastError ||
    new Error(
      "All Gemini models failed"
    )
  );
}


// ============================================================
// AUTOMATIC CAPTION GENERATOR
// ============================================================

async function generateCaptionAndHashtags(
  product,
  topic
) {

  const prompt =
`You are writing an Instagram caption for S-Brand, a platform that compares live price and stock across 17+ Indian D2C fashion brands.

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


  const text =
    await callGemini(prompt);


  try {

    // Remove markdown code fences
    let cleaned =
      text
        .trim()
        .replace(
          /^```json\s*/i,
          ""
        )
        .replace(
          /^```\s*/i,
          ""
        )
        .replace(
          /\s*```$/i,
          ""
        )
        .trim();


    // Find JSON object if Gemini adds extra text
    const start =
      cleaned.indexOf("{");

    const end =
      cleaned.lastIndexOf("}");


    if (
      start !== -1 &&
      end !== -1 &&
      end > start
    ) {

      cleaned =
        cleaned.slice(
          start,
          end + 1
        );
    }


    const parsed =
      JSON.parse(cleaned);


    // Validate required fields
    if (
      !parsed.caption ||
      !parsed.cta ||
      !Array.isArray(
        parsed.hashtags
      )
    ) {

      throw new Error(
        "Gemini returned incomplete caption JSON"
      );
    }


    return {

      caption:
        parsed.caption.trim(),

      cta:
        parsed.cta.trim(),

      hashtags:
        parsed.hashtags
          .map(
            tag =>
              String(tag).trim()
          )
          .filter(Boolean)

    };


  } catch (error) {

    console.log(
      "[Gemini] Caption JSON parsing failed."
    );

    console.log(
      "[Gemini] Raw response:",
      text
    );


    throw new Error(
      "Could not parse Gemini caption response as JSON"
    );
  }
}


// ============================================================
// AUTO AGENT PIPELINE
// ============================================================

async function generateWeeklyPost(
  useAiImage = false
) {

  const {
    generateTrendImage
  } = require("./gemini-image");


  const topic =
    pickWeeklyTopic();


  console.log(
    `[S-Brand] Weekly topic: ${topic}`
  );


  const product =
    await findFeaturedProduct(
      topic
    );


  const content =
    await generateCaptionAndHashtags(
      product,
      topic
    );


  // Default to real product photo
  let imageData = {

    imageUrl:
      product.image,

    aiGenerated:
      false,

  };


  // ----------------------------------------------------------
  // Optional AI image
  // ----------------------------------------------------------

  if (useAiImage) {

    try {

      const aiImage =
        await generateTrendImage(
          product,
          topic
        );


      imageData = {

        imageBase64:
          aiImage.base64,

        imageMimeType:
          aiImage.mimeType,

        aiGenerated:
          true,

      };


    } catch (err) {

      console.warn(
        "Gemini image generation failed, falling back to real product photo:",
        err.message
      );


      imageData = {

        imageUrl:
          product.image,

        aiGenerated:
          false,

      };
    }
  }


  // ----------------------------------------------------------
  // Return generated post
  // ----------------------------------------------------------

  return {

    ...imageData,


    productName:
      product.productName,

    brand:
      product.brand,

    price:
      product.price,

    productUrl:
      product.url,


    // IMPORTANT:
    // Keep original product available so
    // state-machine.js can mark it as posted
    // after Instagram succeeds.
    product,


    caption:
      content.caption,

    cta:
      content.cta,

    hashtags:
      content.hashtags,


    fullCaptionText:
      `${content.caption}\n\n` +
      `${content.cta}\n\n` +
      content.hashtags
        .map(
          h =>
            `#${h.replace(/^#/, "")}`
        )
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

  const prompt =
`You are writing an Instagram caption for S-Brand, a platform that compares live price and stock across 17+ Indian D2C fashion brands.

Product: ${product || "a trending fashion item"}
Style: ${style || "Streetwear"}
${extraPrompt ? `Additional instructions: ${extraPrompt}` : ""}

Write a ready-to-post Instagram caption (2-4 sentences), a line inviting people to compare on S-Brand (link in bio), then 15-18 hashtags (broad + niche + #sbrand + India-specific).

Respond with ONLY the final caption text, fully formatted, ready to paste into Instagram — no JSON, no explanation.`;


  return callGemini(
    prompt,
    500
  );
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