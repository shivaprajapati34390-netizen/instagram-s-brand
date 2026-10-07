// gemini-image.js
// Two modes:
//  1. generateTrendImage() — auto-agent pipeline, builds its own prompt
//     from the featured product + trend topic.
//  2. generateCustomImage() — manual dashboard tool, uses whatever prompt
//     the user typed in the "AI Images" page.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_IMAGE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict";

if (!GEMINI_API_KEY) {
  console.warn("WARNING: GEMINI_API_KEY is not set. Image generation will not work.");
}

function buildTrendPrompt(product, topic) {
  return `A bold, modern square Instagram advertisement image for an Indian streetwear fashion comparison platform called S-Brand.

Scene: An editorial, magazine-style studio photograph of a ${topic}, similar in style to "${product.productName}" from an Indian D2C streetwear brand. Dramatic side lighting, deep charcoal/black studio background, high contrast, premium streetwear photography style.

Composition: Leave clean negative space in the upper third for text overlay. The garment should be the clear visual focus.

Mood: Confident, urban, youth-driven, contemporary Indian streetwear culture.

Avoid: visible brand logos, text baked into the image, cluttered backgrounds, low contrast lighting.`;
}

async function callImagen(prompt, aspectRatio = "1:1") {
  const response = await fetch(`${GEMINI_IMAGE_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { sampleCount: 1, aspectRatio },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini image API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const prediction = data.predictions?.[0];
  if (!prediction?.bytesBase64Encoded) {
    throw new Error("Gemini did not return image data: " + JSON.stringify(data));
  }

  return {
    base64: prediction.bytesBase64Encoded,
    mimeType: prediction.mimeType || "image/png",
    promptUsed: prompt,
  };
}

async function generateTrendImage(product, topic) {
  return callImagen(buildTrendPrompt(product, topic), "1:1");
}

/**
 * Manual dashboard tool — generates from whatever prompt the user typed.
 * ratio: "1:1" | "4:5" | "9:16"
 */
async function generateCustomImage(userPrompt, ratio = "1:1") {
  const fullPrompt = `${userPrompt}\n\nStyle: premium Indian streetwear photography, suitable for an Instagram post. No text baked into the image.`;
  return callImagen(fullPrompt, ratio);
}

module.exports = { generateTrendImage, generateCustomImage, buildTrendPrompt };
