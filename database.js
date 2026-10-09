
require("dotenv").config();

const { MongoClient } = require("mongodb");
const fs = require("fs");
const path = require("path");

const MONGODB_URI = process.env.MONGODB_URI;
const DATABASE_NAME = "sbrand";
const COLLECTION_NAME = "postedProducts";

let client;
let collection;

async function connectDatabase() {
  if (collection) return collection;

  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is missing from .env");
  }

  client = new MongoClient(MONGODB_URI);
  await client.connect();

  const db = client.db(DATABASE_NAME);
  collection = db.collection(COLLECTION_NAME);

  // Prevent duplicate records for the same product key.
  await collection.createIndex(
    { key: 1 },
    { unique: true }
  );

  console.log("[MongoDB] Connected to sbrand.");
  return collection;
}

async function migratePostedProducts() {
  const productsFile = path.join(
    __dirname,
    "posted-products.json"
  );

  const products = JSON.parse(
    fs.readFileSync(productsFile, "utf8")
  );

  if (!Array.isArray(products)) {
    throw new Error("Posted products history must be an array.");
  }

  const productsCollection = await connectDatabase();

  if (products.length > 0) {
    await productsCollection.bulkWrite(
      products.map((product) => ({
        updateOne: {
          filter: { key: product.key },
          update: { $setOnInsert: product },
          upsert: true
        }
      })),
      { ordered: true }
    );
  }

  console.log(
    `[MongoDB] History migration checked ${products.length} local records.`
  );

  console.log(
    `[MongoDB] Total stored records: ${await productsCollection.countDocuments()}`
  );
}

async function getPostedProducts() {
  const productsCollection = await connectDatabase();
  return productsCollection.find({}).toArray();
}

async function savePostedProductsToDb(products) {
  const productsCollection = await connectDatabase();

  const validProducts = products.filter(
    (product) => product && product.key
  );

  if (validProducts.length === 0) return;

  await productsCollection.bulkWrite(
    validProducts.map((product) => ({
      updateOne: {
        filter: { key: product.key },
        update: { $setOnInsert: product },
        upsert: true
      }
    })),
    { ordered: false }
  );
}

module.exports = {
  connectDatabase,
  migratePostedProducts,
  getPostedProducts,
  savePostedProductsToDb
};
