// fetcher.js
// Fetches live product data from Shopify-based D2C brands.
// Failed/slow brands are skipped so they cannot stop the whole pipeline.

const BRANDS = [
  { name: "Mecnex", domain: "mecnex.com" },
  { name: "Offduty India", domain: "offduty.in" },
  { name: "The Bear House", domain: "thebearhouse.com" },
  { name: "LoveGen", domain: "lovegen.com" },
  { name: "Gritstones", domain: "gritstones.com" },
  { name: "5feet11", domain: "5feet11.com" },
  { name: "Fugazee", domain: "fugazee.com" },
  { name: "Vastrado", domain: "vastrado.com" },
  { name: "Snitch", domain: "snitch.co.in" },
  { name: "Offdaze", domain: "offdaze.in" },
  { name: "Bewakoof", domain: "bewakoof.com" },
  { name: "The Souled Store", domain: "thesouledstore.com" },
  { name: "Urban Monkey", domain: "urbanmonkey.com" },
  { name: "Bonkers Corner", domain: "bonkerscorner.com" },
  { name: "Veirdo", domain: "veirdo.in" },
  { name: "Gen Rage", domain: "genrage.com" },
  { name: "Chokore", domain: "chokore.com" },
];

const FETCH_TIMEOUT_MS = 6000;
const RESULTS_PER_BRAND = 5;
const MAX_CONCURRENT_BRANDS = 4;

/**
 * Fetch JSON with timeout and proper content-type validation.
 */
async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; S-BrandBot/1.0)",
        "Accept": "application/json",
      },
    });

    const contentType = res.headers.get("content-type") || "";

    // Handle HTTP errors cleanly.
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    // Some stores return HTML instead of JSON.
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error(`Expected JSON but received ${contentType || "unknown content"}`);
    }

    return await res.json();

  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch one brand.
 */
async function fetchBrandProducts(brand, query) {
  const url = `https://${brand.domain}/products.json?limit=250`;

  let data;

  try {
    data = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);

  } catch (err) {

    if (err.name === "AbortError") {
      console.warn(`[${brand.name}] skipped: request timed out`);
    } else {
      console.warn(
        `[${brand.name}] skipped: ${err.message}`
      );
    }

    return [];
  }

  const products = Array.isArray(data.products)
    ? data.products
    : [];

  if (products.length === 0) {
    console.warn(`[${brand.name}] skipped: no products returned`);
    return [];
  }

  const q = (query || "").toLowerCase().trim();

  const matches = products.filter((p) => {

    if (!q) return true;

    const title = (p.title || "").toLowerCase();

    const tags = Array.isArray(p.tags)
      ? p.tags.join(" ").toLowerCase()
      : String(p.tags || "").toLowerCase();

    const productType =
      (p.product_type || "").toLowerCase();

    return (
      title.includes(q) ||
      tags.includes(q) ||
      productType.includes(q)
    );
  });

  return matches
    .slice(0, RESULTS_PER_BRAND)
    .map((p) => normalizeProduct(p, brand));
}

/**
 * Normalize Shopify product.
 */
function normalizeProduct(product, brand) {

  const variants = Array.isArray(product.variants)
    ? product.variants
    : [];

  const inStockVariants =
    variants.filter((v) => v.available);

  let stockStatus = "out";

  if (inStockVariants.length > 0) {
    stockStatus =
      inStockVariants.length <= 2
        ? "low"
        : "in";
  }

  const prices = variants
    .map((v) => parseFloat(v.price))
    .filter((n) => !Number.isNaN(n));

  const minPrice =
    prices.length > 0
      ? Math.min(...prices)
      : null;

  const image =
    product.images &&
    product.images.length > 0
      ? product.images[0].src
      : null;

  return {
    brand: brand.name,
    productName: product.title,
    price: minPrice,
    currency: "INR",
    stockStatus,
    image,
    url: `https://${brand.domain}/products/${product.handle}`,
    availableSizes: inStockVariants.map(
      (v) => v.title
    ),
  };
}

/**
 * Process brands with limited concurrency.
 * This prevents all 17 stores from being hit simultaneously.
 */
async function runWithConcurrency(items, worker, limit) {

  const results = [];
  let index = 0;

  async function runner() {

    while (true) {

      const currentIndex = index++;

      if (currentIndex >= items.length) {
        return;
      }

      try {
        results[currentIndex] =
          await worker(items[currentIndex]);
      } catch (err) {

        console.warn(
          `[Brand worker] skipped: ${err.message}`
        );

        results[currentIndex] = [];
      }
    }
  }

  const workers = Math.min(limit, items.length);

  await Promise.all(
    Array.from(
      { length: workers },
      () => runner()
    )
  );

  return results;
}

/**
 * Searches all configured brands,
 * or a single brand if brandDomain is given.
 */
async function searchAllBrands(
  query,
  brandDomain = null
) {

  const targets = brandDomain
    ? BRANDS.filter(
        (b) => b.domain === brandDomain
      )
    : BRANDS;

  console.log(
    `[Fetcher] Searching ${targets.length} brand(s) for: "${query}"`
  );

  const brandResults =
    await runWithConcurrency(
      targets,
      (brand) =>
        fetchBrandProducts(brand, query),
      MAX_CONCURRENT_BRANDS
    );

  const merged =
    brandResults.flat();

  merged.sort(
    (a, b) =>
      (a.price ?? Infinity) -
      (b.price ?? Infinity)
  );

  console.log(
    `[Fetcher] Found ${merged.length} matching product(s)`
  );

  return merged;
}

module.exports = {
  searchAllBrands,
  BRANDS,
};