'use strict';
/* ============================================================================
   Shared, dependency-free security + domain helpers used by both servers.
   ============================================================================ */
const crypto = require('crypto');

/* ---- Server-side menu catalog (source of truth for pricing) ----------------
   The browser only ever sends { id, qty }. Prices and names are ALWAYS taken
   from here, so a tampered client cannot change what it is charged or claim a
   product that does not exist. Ids mirror the storefront MENU (category:index). */
const CATALOG = {
  'steaks:0': { name: 'Philly Cheesesteak', price: 9.99 },
  'steaks:1': { name: 'Smoked Out Philly', price: 10.99 },
  'steaks:2': { name: 'Chopped Cheese', price: 9.49 },
  'smash:0':  { name: 'El Classico', price: 7.99 },
  'smash:1':  { name: 'El Classico 2.0', price: 9.49 },
  'smash:2':  { name: 'Uptown Smash', price: 10.49 },
  'smash:3':  { name: "Mac N' Smash", price: 10.99 },
  'chicken:0': { name: 'Harlem Heat', price: 9.49 },
  'chicken:1': { name: 'Sweet Harlem', price: 9.49 },
  'chicken:2': { name: 'Double Barrel Chick', price: 10.99 },
  'chicken:3': { name: 'Chicken & Waffle', price: 9.99 },
  'chicken:4': { name: 'Chicken Tenders 3x', price: 5.49 },
  'chicken:5': { name: 'Kids Box', price: 6.99 },
  'fries:0': { name: 'Loaded Fries — Cheesesteak Original', price: 8.99 },
  'fries:1': { name: 'Loaded Fries — Cheesesteak Smoked', price: 9.49 },
  'fries:2': { name: 'Loaded Fries — Chopped Cheese', price: 8.49 },
  'fries:3': { name: 'Loaded Fries — Chopped Chick Heat', price: 8.49 },
  'fries:4': { name: 'Loaded Fries — Chopped Chick Sweet', price: 8.49 },
  'fries:5': { name: "Chopped N' Mixed", price: 9.49 },
  'sides:0': { name: "Mac N' Cheese", price: 4.49 },
  'sides:1': { name: 'Mozzy Sticks 3x', price: 4.49 },
  'sides:2': { name: 'Fries (Reg / Lrg)', price: 2.99 },
  'sides:3': { name: 'Mississippi Mudpie', price: 4.49 },
  'sides:4': { name: 'New York Cheesecake', price: 4.49 },
  'sides:5': { name: 'Biscoff Tiramisu', price: 4.99 },
  'sides:6': { name: 'Raspberry Tiramisu', price: 4.99 },
  'sides:7': { name: 'Waffle & Ice Cream', price: 5.49 },
  'shakes:0': { name: 'Harlem Shake 568ml', price: 4.99 },
  'shakes:1': { name: 'Biscoff Shake', price: 5.49 },
  'shakes:2': { name: 'Harlem Keys Shake 568ml', price: 5.49 },
  'shakes:3': { name: 'Soft Drinks 330ml', price: 1.49 },
  'shakes:4': { name: 'Koolaid 330ml', price: 1.79 }
};

const BRANCHES = ['Infirmary Road', "St Mary's Road"];
/* the two independent stores (id -> display name). Each store runs its own
   queue / completed / drivers / staff; nothing is shared between them. */
const STORES = { infirmary: 'Infirmary Road', stmarys: "St Mary's Road" };
function storeIdFromBranch(branch) { return Object.keys(STORES).find(k => STORES[k] === branch) || null; }
function storeName(id) { return STORES[id] || null; }
const DELIVERY_MIN = 20;

function round2(n) { return Math.round(n * 100) / 100; }

/* delivery ETA by Sheffield "S" postcode district (mirror of the storefront) */
function etaFor(postcode) {
  const p = String(postcode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^S\d/.test(p)) return null;
  const out = p.length > 4 ? p.slice(0, -3) : p;
  const m = out.match(/^S(\d{1,2})$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if ([1, 2, 3, 6].indexOf(n) > -1) return '20–30 min';
  if (n >= 1 && n <= 14) return '30–45 min';
  return null;
}

/* sanitise free text: drop control chars (code < 32 or 127), collapse
   whitespace, clamp length. No control-char literals in source on purpose. */
function clean(s, max) {
  s = String(s == null ? '' : s);
  let out = '';
  for (let i = 0; i < s.length && out.length <= max + 80; i++) {
    const code = s.charCodeAt(i);
    out += (code < 32 || code === 127) ? ' ' : s[i];
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}

const PHONE_RE = /^(?:\+44\d{9,10}|0\d{9,10})$/;
const POSTCODE_RE = /^S\d{1,2}\s?\d?[A-Z]{0,2}$/i;

/* ---- Strict order validation + server-side re-pricing ----------------------
   Input: the raw JSON object from the client. Output: { ok, order } or
   { ok:false, status, error }. Throws nothing. */
function validateOrder(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(400, 'Malformed order.');

  // honeypot — bots fill this hidden field
  if (raw.company !== undefined && String(raw.company) !== '') return fail(400, 'Rejected.');

  const mode = raw.mode === 'Delivery' ? 'Delivery' : raw.mode === 'Collection' ? 'Collection' : null;
  if (!mode) return fail(400, 'Choose collection or delivery.');

  const name = clean(raw.name, 60);
  if (name.length < 2) return fail(400, 'A valid name is required.');

  const phone = clean(raw.phone, 20).replace(/[\s\-()]/g, '');
  if (!PHONE_RE.test(phone)) return fail(400, 'A valid UK phone number is required.');

  if (!Array.isArray(raw.items) || raw.items.length === 0) return fail(400, 'Your order is empty.');
  if (raw.items.length > 40) return fail(400, 'Too many line items.');

  const merged = new Map();
  for (const it of raw.items) {
    if (!it || typeof it.id !== 'string' || !CATALOG[it.id]) return fail(400, 'Unknown item in order.');
    const q = Math.floor(Number(it.qty));
    if (!Number.isFinite(q) || q < 1 || q > 50) return fail(400, 'Invalid quantity.');
    merged.set(it.id, Math.min(50, (merged.get(it.id) || 0) + q));
  }

  const items = [];
  let subtotal = 0;
  for (const [id, qty] of merged) {
    const c = CATALOG[id];
    const lineTotal = round2(c.price * qty);
    subtotal = round2(subtotal + lineTotal);
    items.push({ id, name: c.name, price: c.price, qty, lineTotal });
  }

  const order = {
    schema: 'hh.order/1',
    ref: 'HH-' + (1000 + crypto.randomInt(9000)),
    placedAt: new Date().toISOString(),
    mode, name, phone,
    items, subtotal,
    currency: 'GBP'
  };

  if (mode === 'Delivery') {
    const address = clean(raw.address, 120);
    if (address.length < 5) return fail(400, 'A delivery address is required.');
    const postcode = clean(raw.postcode, 8).toUpperCase();
    if (!POSTCODE_RE.test(postcode)) return fail(400, 'A valid Sheffield postcode is required.');
    const eta = etaFor(postcode);
    if (!eta) return fail(400, 'That postcode is outside the delivery zone.');
    if (subtotal < DELIVERY_MIN) return fail(400, 'Delivery minimum is GBP ' + DELIVERY_MIN + '.');
    order.address = address;
    order.postcode = postcode;
    order.eta = eta;
    /* which store fulfils this delivery (client may pass a branch; else default) */
    const dBranch = BRANCHES.indexOf(raw.branch) > -1 ? raw.branch : BRANCHES[0];
    order.branch = dBranch;
    order.store = storeIdFromBranch(dBranch) || 'infirmary';
  } else {
    const branch = BRANCHES.indexOf(raw.branch) > -1 ? raw.branch : BRANCHES[0];
    order.branch = branch;
    order.store = storeIdFromBranch(branch) || 'infirmary';
    order.callback = raw.callback === true;
    order.eta = '15–20 min';
  }

  return { ok: true, order };

  function fail(status, error) { return { ok: false, status, error }; }
}

/* ---- HMAC signing (store -> vendor webhook integrity & authenticity) -------- */
function sign(secret, timestamp, nonce, body) {
  return crypto.createHmac('sha256', secret).update(timestamp + '.' + nonce + '.' + body).digest('hex');
}
function verifySignature(secret, timestamp, nonce, body, provided) {
  const expected = sign(secret, timestamp, nonce, body);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(provided || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/* constant-time compare for bearer tokens */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/* ---- Token-bucket rate limiter (per key, usually per IP) -------------------- */
function makeRateLimiter(capacity, refillPerSec) {
  const buckets = new Map();
  return function take(key) {
    const now = Date.now() / 1000;
    let b = buckets.get(key);
    if (!b) { b = { tokens: capacity, ts: now }; buckets.set(key, b); }
    b.tokens = Math.min(capacity, b.tokens + (now - b.ts) * refillPerSec);
    b.ts = now;
    if (buckets.size > 5000) buckets.clear(); // crude memory guard for the demo
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

/* ---- Replay-nonce store (reject re-used webhook nonces) --------------------- */
function makeNonceStore(ttlMs) {
  const seen = new Map();
  return function checkAndStore(nonce) {
    const now = Date.now();
    for (const [k, exp] of seen) if (exp < now) seen.delete(k);
    if (!nonce || seen.has(nonce)) return false;
    seen.set(nonce, now + ttlMs);
    return true;
  };
}

/* read a request body with a hard size cap (anti-DoS) */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* ---- password / PIN hashing (scrypt) + opaque tokens ----------------------- */
function hashSecret(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 32).toString('hex');
  return { salt, hash };
}
function verifySecret(plain, salt, hash) {
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(String(plain), salt, 32);
  const stored = Buffer.from(hash, 'hex');
  return calc.length === stored.length && crypto.timingSafeEqual(calc, stored);
}
function randomToken(bytes) { return crypto.randomBytes(bytes || 24).toString('hex'); }

module.exports = {
  CATALOG, BRANCHES, STORES, storeIdFromBranch, storeName, DELIVERY_MIN,
  etaFor, validateOrder, clean, round2,
  sign, verifySignature, safeEqual,
  makeRateLimiter, makeNonceStore, readBody, clientIp,
  hashSecret, verifySecret, randomToken
};
