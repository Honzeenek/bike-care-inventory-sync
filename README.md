# Bike Care.cz — Inventory sync

Keeps Shopify stock in sync with the **Schindler B2B** XML feed, automatically,
several times a day. No app fees, no manual edits.

## How it works

`sync.js` (dependency-free Node) does, on every run:

1. Downloads the Schindler B2B feed (gzip) and decompresses it.
2. Reads `STOCK_ITEM` per product `CODE`.
3. Matches feed `CODE` → Shopify variant **SKU** (they're identical, e.g. `DY-029`).
4. Sets the **available** quantity at the store location via `inventorySetQuantities`.
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

Push this folder to a **private** GitHub repo, then in
**Settings → Secrets and variables → Actions → New repository secret** add:

| Secret | Value |
| --- | --- |
| `SHOPIFY_STORE_DOMAIN` | `yy0cc2-y7.myshopify.com` |
| `SHOPIFY_ADMIN_TOKEN` | the `shpat_…` token from step 1 |
| `FEED_URL` | the feed URL from step 2 |

Actions are scheduled in `.github/workflows/sync.yml` (hourly at `:17`). Open the
**Actions** tab → **Inventory sync** → **Run workflow** to trigger it manually;
tick **Dry run** the first time to preview without writing, **audit** for a
read-only feed-vs-store health report, or set **debug_sku** (e.g. `DY-156`) to
print Schindler's raw feed block for a CODE without writing.

### 4. Reliable scheduling (external pinger) — recommended

GitHub **throttles and drops `schedule:` jobs** — they can be delayed hours or
skipped, which is what makes stock look stale. The fix is to trigger the workflow
from an outside clock; GitHub runs *dispatched* jobs immediately, no throttling.
The `schedule:` above stays as a best-effort fallback.

1. **Fine-grained GitHub token** — github.com → Settings → Developer settings →
   Personal access tokens → Fine-grained tokens → **Generate new token**.
   Repository access: *Only select repositories* → `bike-care-inventory-sync`.
   Permissions → **Actions: Read and write** (Metadata read is added
   automatically). Copy the `github_pat_…` token.
2. **cron-job.org** (free) → **Create cronjob**, **Every 1 hour**, Advanced:
   - URL: `https://api.github.com/repos/Honzeenek/bike-care-inventory-sync/actions/workflows/sync.yml/dispatches`
   - Method: `POST` · Body: `{"ref":"main"}`
   - Headers: `Authorization: Bearer github_pat_…` · `Accept: application/vnd.github+json` · `X-GitHub-Api-Version: 2022-11-28`

GitHub returns `204` on success. The token only triggers runs on this one repo —
it can't read code or secrets. ~1 Actions minute per run (~720/month hourly).

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
