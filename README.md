# Bike Care.cz — Inventory sync

Keeps Shopify stock in sync with the **Schindler B2B** XML feed, near-real-time
(~30 s), free. No app fees, no manual edits.

## How it works

`sync.js` (dependency-free Node) does, on every run:

1. Downloads the Schindler B2B feed (gzip) and decompresses it — with a
   conditional GET (ETag/Last-Modified) in loop runs, so an unchanged feed
   costs one 304 and nothing else.
2. Reads `STOCK_ITEM` per product `CODE`.
3. Matches feed `CODE` → Shopify variant **SKU** (they're identical, e.g. `DY-029`).
4. Sets the **available** quantity at the store location via
   `inventorySetQuantities` to `max(0, feed − committed)` — locally committed
   (unfulfilled-order) units are subtracted because Schindler's feed can't know
   about our sales until the B2B order is placed. Only actual diffs are written;
   if the parsed feed is identical to the previous loop iteration, all Shopify
   calls are skipped.
5. Forces `inventoryPolicy = DENY` on every managed variant, so items synced to
   0 actually show as **sold out** instead of "continue selling when out of
   stock" (which would keep them buyable at 0). Idempotent — a no-op once the
   catalogue is correct. Needs the `write_products` scope; without it the run
   logs a warning and continues (quantities still sync).

**Scope & safety**

- Only variants whose SKU starts with `DY-` **and** that exist in the feed are touched.
- Anything not in the feed (your `SADA-*` bundles, discontinued items) is **never** modified.
- If the feed comes back empty/broken (< `MIN_FEED_ITEMS`), the run **aborts without writing** — it can't zero out your catalogue.
- Stock only. Prices, descriptions, and images are left alone.

## One-time setup

### 1. Shopify Admin API token

Shopify admin → **Settings → Apps and sales channels → Develop apps → Create an app**
("Inventory Sync"). Under **Configuration → Admin API integration**, grant:

- `read_products`
- `write_products` (to enforce `inventoryPolicy = DENY`)
- `read_inventory`
- `write_inventory`

Install the app, then copy the **Admin API access token** (`shpat_…`, shown once).

### 2. Live feed URL

Log in to the Schindler B2B portal → your name (top right) → **B2B XML feed**.
Copy the full feed URL (it contains your private `?key=…`). It's gzip-compressed —
the script handles that automatically.

### 3. GitHub repo + secrets

Push this folder to a GitHub repo (public is fine — and gives unlimited free
Actions minutes; credentials live only in encrypted Actions secrets), then in
**Settings → Secrets and variables → Actions → New repository secret** add:

| Secret | Value |
| --- | --- |
| `SHOPIFY_STORE_DOMAIN` | `yy0cc2-y7.myshopify.com` |
| `SHOPIFY_ADMIN_TOKEN` | the `shpat_…` token from step 1 |
| `FEED_URL` | the feed URL from step 2 |

### 4. Scheduling: the self-chaining loop

The repo is **public**, so Actions minutes are unlimited and free. GitHub
**throttles and drops `schedule:` jobs** (delays of 1–5 h are normal), so the
cron is NOT the clock — it's only a fallback. The actual cadence comes from a
**self-perpetuating chain**: each "loop" run syncs every ~30 s for ~55 min,
then dispatches its own successor via `workflow_dispatch` using the built-in
`GITHUB_TOKEN` (workflow_dispatch is an explicit exception to GitHub's
no-recursion rule, so no PAT is needed). The hourly cron restarts the chain if
it ever dies; the concurrency group stops parallel chains from forming.

- **Start the chain:** Actions → Inventory sync → Run workflow → tick
  **chained** (or `gh workflow run sync.yml -f chained=true`).
- **Stop everything:** Actions → Inventory sync → ⋯ → **Disable workflow**
  (dispatches to a disabled workflow are rejected, which ends the chain).
- **One-off manual run:** Run workflow *without* chained — single pass; tick
  **Dry run** to preview without writing, **audit** for a read-only
  feed-vs-store health report, or set **debug_sku** (e.g. `DY-156`) to print
  Schindler's raw feed block for a CODE (wholesale prices redacted — logs are
  public).

## Run locally (testing)

```bash
# Dry run against the live feed (no writes)
SHOPIFY_STORE_DOMAIN=yy0cc2-y7.myshopify.com \
SHOPIFY_ADMIN_TOKEN=shpat_xxx \
FEED_URL='https://b2b.schindler.cz/api/export/...?key=...' \
npm run dry-run

# Real sync
SHOPIFY_STORE_DOMAIN=... SHOPIFY_ADMIN_TOKEN=... FEED_URL=... npm run sync

# Test parsing against a downloaded file, no Shopify writes
FEED_FILE='/path/to/feed.xml' DRY_RUN=1 \
SHOPIFY_STORE_DOMAIN=... SHOPIFY_ADMIN_TOKEN=... node sync.js
```

## Config (env)

| Var | Default | Notes |
| --- | --- | --- |
| `SHOPIFY_STORE_DOMAIN` | — | `*.myshopify.com` host |
| `SHOPIFY_ADMIN_TOKEN` | — | Admin API token |
| `FEED_URL` | — | live gzip feed URL |
| `SHOPIFY_LOCATION_ID` | `gid://shopify/Location/120161861972` | "Shop location" |
| `SKU_PREFIX` | `DY-` | which SKUs this sync owns |
| `API_VERSION` | `2025-07` | Admin API version |
| `MIN_FEED_ITEMS` | `10` | safety floor |
| `DRY_RUN` | — | `1` = log only |
| `AUDIT` | — | `1` = read-only report: feed vs live store qty + tracking, no writes |
| `DEBUG_SKU` | — | comma-separated CODE(s); print raw feed block(s), no writes |
| `FEED_FILE` | — | read local XML instead of `FEED_URL` |
