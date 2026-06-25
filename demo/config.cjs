'use strict';
/* ============================================================================
   Shared secrets / config for the demo order pipeline.

   Resolution order:
     1. Environment variables (use these in production — never commit real secrets).
        HH_HMAC_SECRET     - shared secret signing the store -> vendor webhook
        HH_DASHBOARD_TOKEN - bearer token the vendor dashboard uses to read orders
        HH_KEY_ID          - key identifier (supports rotation), default "hh-store-1"
        HH_VENDOR_URL      - where the store forwards webhooks, default http://127.0.0.1:4100
        HH_STORE_PORT / HH_VENDOR_PORT / HH_ALLOW_ORIGIN
     2. A locally generated demo/.secret.json (git-ignored, mode 0600), created on
        first run so BOTH servers share the same secret on this machine.

   In production the two services live on different hosts and read the secret from
   their own secret manager / env — not a shared file.
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECRET_FILE = path.join(__dirname, '.secret.json');

function fromEnv() {
  if (process.env.HH_HMAC_SECRET && process.env.HH_DASHBOARD_TOKEN) {
    return {
      hmacSecret: process.env.HH_HMAC_SECRET,
      dashboardToken: process.env.HH_DASHBOARD_TOKEN,
      keyId: process.env.HH_KEY_ID || 'hh-store-1',
      generated: false
    };
  }
  return null;
}

function loadOrCreate() {
  const env = fromEnv();
  if (env) return env;

  try {
    const cfg = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
    if (cfg && cfg.hmacSecret && cfg.dashboardToken) { cfg.generated = true; return cfg; }
  } catch (_) { /* not created yet */ }

  const cfg = {
    hmacSecret: crypto.randomBytes(32).toString('hex'),
    dashboardToken: crypto.randomBytes(24).toString('hex'),
    keyId: 'hh-store-1',
    generated: true
  };
  try {
    fs.writeFileSync(SECRET_FILE, JSON.stringify({ hmacSecret: cfg.hmacSecret, dashboardToken: cfg.dashboardToken, keyId: cfg.keyId }, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn('[config] could not persist .secret.json:', e.message);
  }
  return cfg;
}

const secrets = loadOrCreate();

module.exports = {
  hmacSecret: secrets.hmacSecret,
  dashboardToken: secrets.dashboardToken,
  keyId: secrets.keyId,
  generated: secrets.generated,
  storePort: Number(process.env.HH_STORE_PORT) || 4000,
  vendorPort: Number(process.env.HH_VENDOR_PORT) || 4100,
  vendorUrl: process.env.HH_VENDOR_URL || 'http://127.0.0.1:4100',
  // browser origins allowed to POST orders to the store API
  allowOrigin: process.env.HH_ALLOW_ORIGIN || 'http://localhost:4000',
  // anti-replay window for signed webhooks
  webhookSkewMs: 5 * 60 * 1000
};
