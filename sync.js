#!/usr/bin/env node
/**
 * Bike Care.cz — Schindler B2B → Shopify inventory sync.
 *
 * Pulls the Schindler B2B XML feed (gzip), reads STOCK_ITEM per product CODE,
 * matches CODE → Shopify variant SKU, and sets the "available" quantity at the
 * store's location. Only variants whose SKU starts with SKU_PREFIX (default
 * "DY-") AND that exist in the feed are touched — anything not in the feed
 * (custom bundles, discontinued items) is never modified.
 *
 * Stock only. Prices/descriptions/images are left alone.
 *
 * Required env:
 *   SHOPIFY_STORE_DOMAIN   e.g. yy0cc2-y7.myshopify.com
 *   SHOPIFY_ADMIN_TOKEN    Admin API access token (scopes: read_products, read_inventory, write_inventory)
 *   FEED_URL               live gzip feed URL from the B2B portal (contains the ?key=...)
 * Optional env:
 *   SHOPIFY_LOCATION_ID    default gid://shopify/Location/120161861972
 *   SKU_PREFIX             default "DY-"
 *   API_VERSION            default "2025-07"
 *   MIN_FEED_ITEMS         safety floor; abort if fewer matching items parsed (default 10)
 *   DRY_RUN                "1" = log what would change, write nothing
 *   FEED_FILE              read a local XML file instead of FEED_URL (for testing)
 */

"use strict";

const fs = require("fs");
const zlib = require("zlib");

const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_ADMIN_TOKEN,
  FEED_URL,
  FEED_FILE,
  SHOPIFY_LOCATION_ID = "gid://shopify/Location/120161861972",
  SKU_PREFIX = "DY-",
  API_VERSION = "2025-07",
  MIN_FEED_ITEMS = "10",
  DRY_RUN = "",
} = process.env;

const dryRun = DRY_RUN === "1" || DRY_RUN === "true";

function fail(msg) {
  console.error("✖ " + msg);
  process.exit(1);
}

function log(msg) {
  console.log(msg);
}

// ---------------------------------------------------------------------------
// 1. Load the feed (local file or remote gzip URL) and decompress if needed.
// ---------------------------------------------------------------------------
async function loadFeed() {
  let buf;
  if (FEED_FILE) {
    log(`Reading feed from file: ${FEED_FILE}`);
    buf = fs.readFileSync(FEED_FILE);
  } else {
    if (!FEED_URL) fail("FEED_URL (or FEED_FILE) is required.");
    log("Downloading feed…");
    const res = await fetch(FEED_URL, {
      headers: { "User-Agent": "BikeCare-InventorySync/1.0" },
    });
    if (!res.ok) fail(`Feed download failed: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  }
  // gzip magic bytes 0x1f 0x8b → decompress; otherwise assume plain XML.
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    buf = zlib.gunzipSync(buf);
  }
  return buf.toString("utf8");
}

// ---------------------------------------------------------------------------
// 2. Parse the feed → { sku: quantity } for SKUs starting with SKU_PREFIX.
// ---------------------------------------------------------------------------
function parseFeed(xml) {
  const items = xml.split("<SHOPITEM>").slice(1);
  const map = {};
  for (const it of items) {
    const codeM = it.match(/<CODE>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/CODE>/);
    if (!codeM) continue;
    const code = codeM[1].trim();
    if (!code.startsWith(SKU_PREFIX)) continue;
    const stockM = it.match(/<STOCK_ITEM>\s*(\d+)\s*<\/STOCK_ITEM>/);
    map[code] = stockM ? parseInt(stockM[1], 10) : 0; // missing STOCK_ITEM ⇒ out of stock
  }
  return map;
}

// ---------------------------------------------------------------------------
// 3. Shopify Admin GraphQL helper.
// ---------------------------------------------------------------------------
async function shopify(query, variables) {
  const res = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    },
  );
  const json = await res.json();
  if (!res.ok || json.errors) {
    fail("Shopify API error: " + JSON.stringify(json.errors || res.status));
  }
  return json.data;
}

// Fetch every variant with the SKU prefix → { sku: inventoryItemId }.
async function fetchVariantMap() {
  const map = {};
  let cursor = null;
  do {
    const data = await shopify(
      `query($cursor: String) {
        productVariants(first: 250, after: $cursor) {
          edges { node { sku inventoryItem { id } } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { cursor },
    );
    const conn = data.productVariants;
    for (const { node } of conn.edges) {
      if (node.sku && node.sku.startsWith(SKU_PREFIX) && node.inventoryItem) {
        map[node.sku] = node.inventoryItem.id;
      }
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return map;
}

const SET_QUANTITIES = `
  mutation SetStock($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      userErrors { field message }
    }
  }`;

async function setQuantities(quantities) {
  // inventorySetQuantities accepts up to 250 quantities per call.
  for (let i = 0; i < quantities.length; i += 250) {
    const chunk = quantities.slice(i, i + 250);
    const data = await shopify(SET_QUANTITIES, {
      input: {
        name: "available",
        reason: "correction",
        ignoreCompareQuantity: true,
        quantities: chunk,
      },
    });
    const errs = data.inventorySetQuantities.userErrors;
    if (errs && errs.length) fail("inventorySetQuantities: " + JSON.stringify(errs));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  if (!FEED_FILE && (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN)) {
    fail("SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN are required.");
  }

  const xml = await loadFeed();
  const feed = parseFeed(xml);
  const feedCount = Object.keys(feed).length;
  log(`Feed: ${feedCount} '${SKU_PREFIX}*' items.`);

  // Safety floor: a broken/empty feed must never zero out the catalogue.
  if (feedCount < parseInt(MIN_FEED_ITEMS, 10)) {
    fail(`Only ${feedCount} feed items (< MIN_FEED_ITEMS=${MIN_FEED_ITEMS}); aborting without writes.`);
  }

  const variants = await fetchVariantMap();
  log(`Store: ${Object.keys(variants).length} '${SKU_PREFIX}*' variants.`);

  const quantities = [];
  const updated = [];
  for (const [sku, inventoryItemId] of Object.entries(variants)) {
    if (Object.prototype.hasOwnProperty.call(feed, sku)) {
      quantities.push({ inventoryItemId, locationId: SHOPIFY_LOCATION_ID, quantity: feed[sku] });
      updated.push(`${sku}=${feed[sku]}`);
    }
  }

  const skipped = Object.keys(variants).filter((s) => !(s in feed));
  log(`Matched ${quantities.length} variants. Skipped (in store, not in feed): ${skipped.length}${skipped.length ? " → " + skipped.join(", ") : ""}`);

  if (!quantities.length) {
    log("Nothing to update.");
    return;
  }

  if (dryRun) {
    log("DRY_RUN — would set: " + updated.join(", "));
    return;
  }

  await setQuantities(quantities);
  log(`✓ Updated ${quantities.length} variants at ${new Date().toISOString()}.`);
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
