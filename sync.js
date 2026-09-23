#!/usr/bin/env node
/**
 * Bike Care.cz — Schindler B2B → Shopify inventory sync.
 *
 * Pulls the Schindler B2B XML feed (gzip), reads STOCK_ITEM per product CODE,
 * matches CODE → Shopify variant SKU, and sets the "available" quantity at the
 * store's location. Only variants whose SKU starts with one of SKU_PREFIX
 * (default "DY-" = Dynamic, plus KMC chain/link codes) AND that exist in the feed are touched — anything not in the feed
 * (custom bundles, discontinued items) is never modified.
 *
 * It also enforces inventoryPolicy = DENY on every managed SKU_PREFIX variant
 * (whether or not it's in the feed). Without this, a variant set to "continue
 * selling when out of stock" (CONTINUE) keeps showing as in stock on the
 * storefront even after its quantity is synced to 0 — so the 0 we write would
 * be invisible to customers. Enforcing DENY makes 0-quantity items show as
 * sold out. This needs the write_products scope; if the token lacks it, the
 * run warns loudly and continues (quantity sync is unaffected).
 *
 * Stock only. Prices/descriptions/images are left alone.
 *
 * Required env:
 *   SHOPIFY_STORE_DOMAIN   e.g. yy0cc2-y7.myshopify.com
 *   SHOPIFY_ADMIN_TOKEN    Admin API access token
 *                          (scopes: read_products, write_products, read_inventory, write_inventory)
 *   FEED_URL               live gzip feed URL from the B2B portal (contains the ?key=...)
 * Optional env:
 *   SHOPIFY_LOCATION_ID    default gid://shopify/Location/120161861972
 *   SKU_PREFIX             comma-separated prefixes, default "DY-,BX,BE,BS,BY,WC"
 *                          (DY- = Dynamic; BX/BE/BS/BY = KMC chains, WC = KMC links)
 *   API_VERSION            default "2025-07"
 *   MIN_FEED_ITEMS         safety floor; abort if fewer matching items parsed (default 10)
 *   DRY_RUN                "1" = log what would change, write nothing
 *   FEED_FILE              read a local XML file instead of FEED_URL (for testing)
 *   FEED_STATE_FILE        path to a JSON state file persisted between runs of a
 *                          loop job. Enables (a) conditional GET on the feed
 *                          (ETag/Last-Modified → HTTP 304 = skip run) and
 *                          (b) skipping all Shopify calls when the parsed stock
 *                          map is identical to the previous run's.
 *   FORCE                  "1" = do a full pass even if the feed is unchanged
 */

"use strict";

const fs = require("fs");
const crypto = require("crypto");
const zlib = require("zlib");

const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_ADMIN_TOKEN,
  FEED_URL,
  FEED_FILE,
  SHOPIFY_LOCATION_ID = "gid://shopify/Location/120161861972",
  SKU_PREFIX = "DY-,BX,BE,BS,BY,WC",
  API_VERSION = "2025-07",
  MIN_FEED_ITEMS = "10",
  DRY_RUN = "",
  DEBUG_SKU = "", // comma-separated CODE(s) → print raw feed block(s) and exit-safe
  DEBUG_FIND = "", // substring → search ALL feed items (any CODE) by CODE/PRODUCTNAME, no writes
  AUDIT = "", // "1" = read-only health report (feed vs live store qty + tracking), no writes
  FEED_STATE_FILE = "",
  FORCE = "",
} = process.env;

const SKU_PREFIXES = SKU_PREFIX.split(",").map((p) => p.trim()).filter(Boolean);
const owned = (sku) => SKU_PREFIXES.some((p) => sku.startsWith(p));

const dryRun = DRY_RUN === "1" || DRY_RUN === "true";
const auditMode = AUDIT === "1" || AUDIT === "true";
const force = FORCE === "1" || FORCE === "true";
// Conditional GET + unchanged-skip only apply to plain sync runs in a loop job.
const useState = Boolean(FEED_STATE_FILE) && !DEBUG_SKU && !DEBUG_FIND && !auditMode && !dryRun;

function readState() {
  try {
    return JSON.parse(fs.readFileSync(FEED_STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    fs.writeFileSync(FEED_STATE_FILE, JSON.stringify(state));
  } catch (e) {
    log("⚠ Could not write FEED_STATE_FILE: " + e.message);
  }
}

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
// Returns { xml } on fresh content, or { notModified: true } when the server
// answered 304 to a conditional GET (loop runs only).
async function loadFeed(state) {
  let buf;
  if (FEED_FILE) {
    log(`Reading feed from file: ${FEED_FILE}`);
    buf = fs.readFileSync(FEED_FILE);
  } else {
    if (!FEED_URL) fail("FEED_URL (or FEED_FILE) is required.");
    const headers = { "User-Agent": "BikeCare-InventorySync/1.0" };
    if (useState && !force) {
      if (state.etag) headers["If-None-Match"] = state.etag;
      if (state.lastModified) headers["If-Modified-Since"] = state.lastModified;
    }
    const res = await fetch(FEED_URL, { headers });
    if (res.status === 304) return { notModified: true };
    if (!res.ok) fail(`Feed download failed: HTTP ${res.status}`);
    state.etag = res.headers.get("etag") || "";
    state.lastModified = res.headers.get("last-modified") || "";
    buf = Buffer.from(await res.arrayBuffer());
  }
  // gzip magic bytes 0x1f 0x8b → decompress; otherwise assume plain XML.
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    buf = zlib.gunzipSync(buf);
  }
  return { xml: buf.toString("utf8") };
}

// ---------------------------------------------------------------------------
// 2. Parse the feed → { sku: quantity } for SKUs starting with SKU_PREFIX.
// ---------------------------------------------------------------------------
function parseFeed(xml) {
  const items = xml.split("<SHOPITEM>").slice(1);
  const stock = {};
  const raw = {};
  for (const it of items) {
    const codeM = it.match(/<CODE>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/CODE>/);
    if (!codeM) continue;
    const code = codeM[1].trim();
    if (!owned(code)) continue;
    const stockM = it.match(/<STOCK_ITEM>\s*(\d+)\s*<\/STOCK_ITEM>/);
    stock[code] = stockM ? parseInt(stockM[1], 10) : 0; // missing STOCK_ITEM ⇒ out of stock
    // For DEBUG_SKU. Wholesale prices are redacted — Actions logs are public.
    raw[code] = ("<SHOPITEM>" + it.split("</SHOPITEM>")[0] + "</SHOPITEM>")
      .replace(/<PURCHASE_PRICE>[\s\S]*?<\/PURCHASE_PRICE>/g, "<PURCHASE_PRICE>[redacted]</PURCHASE_PRICE>");
  }
  return { stock, raw };
}

// Search EVERY feed item (regardless of SKU_PREFIX) by CODE or PRODUCTNAME
// substring. Answers "does Schindler carry X, and under what CODE?" — e.g. when
// a store SKU is missing from the feed and we need to know if it was
// discontinued or just re-coded. Prints matches; writes nothing.
function debugFind(xml, term) {
  const needle = term.toLowerCase();
  const items = xml.split("<SHOPITEM>").slice(1);
  const hits = [];
  for (const it of items) {
    const codeM = it.match(/<CODE>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/CODE>/);
    const nameM = it.match(/<PRODUCTNAME>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/PRODUCTNAME>/);
    const stockM = it.match(/<STOCK_ITEM>\s*(\d+)\s*<\/STOCK_ITEM>/);
    const code = codeM ? codeM[1].trim() : "";
    const name = nameM ? nameM[1].trim() : "";
    if (code.toLowerCase().includes(needle) || name.toLowerCase().includes(needle)) {
      hits.push(`  CODE=${code}  stock=${stockM ? stockM[1] : "(none)"}  ${name}`);
    }
  }
  log(`\n── DEBUG_FIND "${term}" → ${hits.length} match(es) in the full feed ──`);
  log(hits.length ? hits.join("\n") : "  (nothing in the feed matches that term)");
}

// ---------------------------------------------------------------------------
// 3. Shopify Admin GraphQL helper.
// ---------------------------------------------------------------------------
// Low-level call: returns the raw { ok, status, json } so callers can decide
// whether an error is fatal.
async function gql(query, variables) {
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
  return { ok: res.ok, status: res.status, json: await res.json() };
}

// Strict call: any transport or GraphQL error aborts the run.
async function shopify(query, variables) {
  const { ok, status, json } = await gql(query, variables);
  if (!ok || json.errors) {
    fail("Shopify API error: " + JSON.stringify(json.errors || status));
  }
  return json.data;
}

// Fetch every variant with the SKU prefix as a record:
// { sku, inventoryItemId, variantId, productId, inventoryPolicy, available, committed }.
// available/committed are the CURRENT quantities at the store location — needed
// to (a) subtract locally-committed units from the feed quantity and (b) write
// only actual diffs.
async function fetchVariants() {
  const out = [];
  let cursor = null;
  do {
    const data = await shopify(
      `query($cursor: String, $loc: ID!) {
        productVariants(first: 250, after: $cursor) {
          edges { node {
            id sku inventoryPolicy product { id }
            inventoryItem {
              id
              inventoryLevel(locationId: $loc) {
                quantities(names: ["available", "committed"]) { name quantity }
              }
            }
          } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { cursor, loc: SHOPIFY_LOCATION_ID },
    );
    const conn = data.productVariants;
    for (const { node } of conn.edges) {
      if (node.sku && owned(node.sku) && node.inventoryItem) {
        const qs = {};
        const lvl = node.inventoryItem.inventoryLevel;
        for (const q of (lvl && lvl.quantities) || []) qs[q.name] = q.quantity;
        out.push({
          sku: node.sku,
          inventoryItemId: node.inventoryItem.id,
          variantId: node.id,
          productId: node.product.id,
          inventoryPolicy: node.inventoryPolicy,
          available: qs.available ?? null,
          committed: qs.committed ?? 0,
        });
      }
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

// Read-only health audit: for every managed variant, fetch tracking flag and
// the CURRENT "available" quantity at the location, then diff against the feed.
// Surfaces exactly why a product can misbehave on the storefront:
//   • tracked=false  → storefront ignores quantity AND policy → always buyable
//   • not in feed    → quantity is frozen (never synced); may be stale
//   • store ≠ feed   → last write didn't stick, or feed changed since last sync
//   • feed=0         → should read sold-out (only works if tracked && DENY)
// Writes nothing.
async function auditVariants() {
  const out = [];
  let cursor = null;
  do {
    const data = await shopify(
      `query($cursor: String, $loc: ID!) {
        productVariants(first: 250, after: $cursor) {
          edges { node {
            sku inventoryPolicy
            inventoryItem {
              tracked
              inventoryLevel(locationId: $loc) {
                quantities(names: ["available", "committed"]) { name quantity }
              }
            }
          } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { cursor, loc: SHOPIFY_LOCATION_ID },
    );
    const conn = data.productVariants;
    for (const { node } of conn.edges) {
      if (!node.sku || !owned(node.sku) || !node.inventoryItem) continue;
      const lvl = node.inventoryItem.inventoryLevel;
      const qs = {};
      for (const q of (lvl && lvl.quantities) || []) qs[q.name] = q.quantity;
      out.push({
        sku: node.sku,
        policy: node.inventoryPolicy,
        tracked: node.inventoryItem.tracked,
        available: qs.available ?? null,
        committed: qs.committed ?? 0,
      });
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

function runAudit(records, feed) {
  records.sort((a, b) => a.sku.localeCompare(b.sku, undefined, { numeric: true }));
  const untracked = [];
  const notInFeed = [];
  const mismatch = []; // in feed but store qty != feed qty
  const soldOut = []; // feed=0
  for (const r of records) {
    const inFeed = Object.prototype.hasOwnProperty.call(feed, r.sku);
    const fq = inFeed ? feed[r.sku] : null;
    if (r.tracked === false) untracked.push(r.sku);
    if (!inFeed) { notInFeed.push(`${r.sku}(store=${r.available})`); continue; }
    if (fq === 0) soldOut.push(`${r.sku}(store=${r.available}${r.tracked === false ? ",UNTRACKED!" : ""}${r.policy !== "DENY" ? ",CONTINUE!" : ""})`);
    // Expected available = feed − locally committed (units sold here that
    // Schindler doesn't know about yet), floored at 0.
    const expected = Math.max(0, fq - r.committed);
    if (r.available !== expected) mismatch.push(`${r.sku}: store=${r.available} expected=${expected} (feed=${fq} committed=${r.committed})`);
  }
  log("\n================ AUDIT REPORT ================");
  log(`Variants checked: ${records.length}\n`);

  log(`⚠ UNTRACKED (inventory tracking OFF → always buyable, sync can't help): ${untracked.length}`);
  if (untracked.length) log("   " + untracked.join(", "));

  log(`\n⚠ NOT IN FEED (stock frozen, never synced): ${notInFeed.length}`);
  if (notInFeed.length) log("   " + notInFeed.join(", "));

  log(`\n⚠ STORE ≠ FEED (write didn't stick or feed moved since last sync): ${mismatch.length}`);
  if (mismatch.length) log("   " + mismatch.join("\n   "));

  log(`\n• FEED=0 (should show sold-out; flagged if untracked/CONTINUE): ${soldOut.length}`);
  if (soldOut.length) log("   " + soldOut.join(", "));
  log("=============================================\n");
}

const SET_POLICY = `
  mutation SetPolicy($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors { field message }
    }
  }`;

// Ensure every managed variant is DENY so out-of-stock items hide from the
// storefront. Idempotent: variants already DENY are left alone, so once the
// catalogue is corrected this is a no-op. Needs the write_products scope; if
// the token lacks it we warn and continue rather than failing the quantity sync.
async function enforceDenyPolicy(records) {
  const offenders = records.filter((r) => r.inventoryPolicy !== "DENY");
  if (!offenders.length) {
    log("Policy: all managed variants already DENY.");
    return;
  }
  log(`Policy: ${offenders.length} variant(s) on CONTINUE → setting DENY: ${offenders.map((r) => r.sku).join(", ")}`);
  if (dryRun) {
    log("DRY_RUN — would set inventoryPolicy=DENY on the above.");
    return;
  }

  // productVariantsBulkUpdate is per-product, so group the offenders by product.
  const byProduct = new Map();
  for (const r of offenders) {
    if (!byProduct.has(r.productId)) byProduct.set(r.productId, []);
    byProduct.get(r.productId).push({ id: r.variantId, inventoryPolicy: "DENY" });
  }

  for (const [productId, variants] of byProduct) {
    const { ok, status, json } = await gql(SET_POLICY, { productId, variants });
    if (!ok || json.errors) {
      const msg = JSON.stringify(json.errors || status);
      if (/access denied|write_products|ACCESS_DENIED/i.test(msg)) {
        log("⚠ Could not set inventoryPolicy=DENY — the Admin token is missing the 'write_products' scope.");
        log("⚠ Out-of-stock items still on CONTINUE will keep showing as in stock.");
        log("⚠ Fix: add write_products to the 'Stock Sync' app's scopes, re-run get-token.js to mint a new token, and update the SHOPIFY_ADMIN_TOKEN secret.");
        return; // one warning is enough; don't spam per product
      }
      fail("inventoryPolicy update error: " + msg);
    }
    const errs = json.data.productVariantsBulkUpdate.userErrors;
    if (errs && errs.length) fail("productVariantsBulkUpdate: " + JSON.stringify(errs));
  }
  log(`✓ Set inventoryPolicy=DENY on ${offenders.length} variant(s).`);
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

  const state = useState ? readState() : {};
  const loaded = await loadFeed(state);
  if (loaded.notModified) {
    log("Feed not modified (HTTP 304) — nothing to do.");
    return;
  }
  const xml = loaded.xml;

  // Full-feed name/code search (any vendor, ignores SKU_PREFIX). No writes.
  if (DEBUG_FIND) {
    debugFind(xml, DEBUG_FIND);
    log("\nDEBUG_FIND set — no writes performed.");
    return;
  }

  const { stock: feed, raw: feedRaw } = parseFeed(xml);
  const feedCount = Object.keys(feed).length;
  log(`Feed: ${feedCount} '${SKU_PREFIXES.join("|")}*' items.`);

  // Debug: dump the raw feed block(s) for the given CODE(s) so we can inspect
  // how Schindler represents availability. Prints and exits without writing.
  if (DEBUG_SKU) {
    for (const code of DEBUG_SKU.split(",").map((s) => s.trim()).filter(Boolean)) {
      log(`\n── DEBUG ${code} ── stock=${code in feed ? feed[code] : "(not in feed)"}`);
      log(feedRaw[code] || "(no SHOPITEM block for this CODE)");
    }
    log("\nDEBUG_SKU set — no writes performed.");
    return;
  }

  // Read-only audit: report feed vs live store state and exit without writing.
  if (auditMode) {
    const audited = await auditVariants();
    log(`Store: ${audited.length} '${SKU_PREFIXES.join("|")}*' variants.`);
    runAudit(audited, feed);
    return;
  }

  // Safety floor: a broken/empty feed must never zero out the catalogue.
  if (feedCount < parseInt(MIN_FEED_ITEMS, 10)) {
    fail(`Only ${feedCount} feed items (< MIN_FEED_ITEMS=${MIN_FEED_ITEMS}); aborting without writes.`);
  }

  // Loop-run optimization: if the parsed stock map is byte-identical to the
  // previous run's, the store is already consistent — Shopify itself maintains
  // available = feed − committed between feed changes (orders decrement
  // available as they commit units). Skip all Shopify calls.
  const feedHash = crypto.createHash("sha1").update(JSON.stringify(feed)).digest("hex");
  if (useState && !force && state.feedHash === feedHash) {
    writeState({ ...state }); // keep etag/lastModified fresh
    log("Feed unchanged since last run — skipping Shopify calls.");
    return;
  }

  const records = await fetchVariants();
  log(`Store: ${records.length} '${SKU_PREFIXES.join("|")}*' variants.`);

  // Target available = feed quantity MINUS units committed to local unfulfilled
  // orders. Schindler's feed can't know about our sales until we place the B2B
  // order, so writing the raw feed value would re-list units our customers
  // already bought. Floored at 0. Only actual diffs are written.
  const quantities = [];
  const updated = [];
  for (const r of records) {
    if (!Object.prototype.hasOwnProperty.call(feed, r.sku)) continue;
    const target = Math.max(0, feed[r.sku] - r.committed);
    if (r.available === target) continue;
    quantities.push({ inventoryItemId: r.inventoryItemId, locationId: SHOPIFY_LOCATION_ID, quantity: target });
    updated.push(`${r.sku}=${target}${r.committed ? ` (feed=${feed[r.sku]}−committed=${r.committed})` : ""}`);
  }

  const skipped = records.map((r) => r.sku).filter((s) => !(s in feed));
  log(`Diffs to write: ${quantities.length}. Skipped (in store, not in feed): ${skipped.length}${skipped.length ? " → " + skipped.join(", ") : ""}`);

  // 1) Sync quantities for feed-matched variants that differ from target.
  if (!quantities.length) {
    log("Nothing to update (quantities).");
  } else if (dryRun) {
    log("DRY_RUN — would set: " + updated.join(", "));
  } else {
    await setQuantities(quantities);
    log(`✓ Updated: ${updated.join(", ")} at ${new Date().toISOString()}.`);
  }

  // 2) Enforce DENY on every managed variant (feed-matched or not) so 0-stock
  //    items actually show as sold out instead of "continue selling".
  await enforceDenyPolicy(records);

  // Only mark this feed content as fully applied after successful writes.
  if (useState && !dryRun) writeState({ ...state, feedHash });
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
