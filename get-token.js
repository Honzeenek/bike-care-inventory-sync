#!/usr/bin/env node
/**
 * One-shot helper to mint an OFFLINE Admin API access token for a custom app
 * via the OAuth authorization-code flow with a localhost redirect.
 *
 * Run:
 *   SHOP=yy0cc2-y7.myshopify.com \
 *   CLIENT_ID=... CLIENT_SECRET=shpss_... \
 *   node get-token.js
 *
 * Prereq: add  http://localhost:53913/callback  to the app's
 * "Allowed redirection URL(s)" in the Dev Dashboard, then open the printed URL.
 * On success the token is written to /tmp/admin_token.json (not printed in full).
 */
"use strict";
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");

const SHOP = process.env.SHOP || "yy0cc2-y7.myshopify.com";
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const PORT = parseInt(process.env.PORT || "53913", 10);
const SCOPES = process.env.SCOPES || "read_products,read_inventory,write_inventory";
const REDIRECT = `http://localhost:${PORT}/callback`;
const state = crypto.randomBytes(8).toString("hex");

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("CLIENT_ID and CLIENT_SECRET are required.");
  process.exit(1);
}

const authUrl =
  `https://${SHOP}/admin/oauth/authorize?client_id=${CLIENT_ID}` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
  `&state=${state}`;

fs.writeFileSync(
  "/tmp/oauth_links.txt",
  `REDIRECT_TO_ALLOWLIST\n${REDIRECT}\n\nAUTHORIZE_URL\n${authUrl}\n`,
);
console.log("Redirect to allowlist:", REDIRECT);
console.log("Authorize URL:", authUrl);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname !== "/callback") {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const code = u.searchParams.get("code");
  const gotState = u.searchParams.get("state");
  if (!code || gotState !== state) {
    res.writeHead(400);
    res.end("Missing code or state mismatch.");
    console.error("Missing code or state mismatch", { code: !!code, gotState, state });
    return;
  }
  try {
    const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code }),
    });
    const j = await r.json();
    if (!r.ok || !j.access_token) {
      res.writeHead(500);
      res.end("Token exchange failed: " + JSON.stringify(j));
      console.error("EXCHANGE FAILED", r.status, j);
      return;
    }
    fs.writeFileSync("/tmp/admin_token.json", JSON.stringify(j));
    console.log("GOT_TOKEN scope=" + j.scope + " prefix=" + String(j.access_token).slice(0, 10));
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("✓ Token captured. Close this tab and return to Claude.");
    setTimeout(() => process.exit(0), 400);
  } catch (e) {
    res.writeHead(500);
    res.end("error: " + e.message);
    console.error(e);
  }
});
server.listen(PORT, () => console.log("Listening on " + REDIRECT));
