'use strict';
/* ============================================================================
   Authentication + authorization for the manager dashboard.
   - email + strong password (scrypt), login rate-limited at the server
   - server-side sessions keyed by an HttpOnly, SameSite=Strict cookie
   - CSRF token (returned at login, required on every mutating request)
   - idle (30m) + absolute (8h) session expiry
   - RBAC: owner / senior_manager / store_manager / read_only_analyst
   ============================================================================ */
const crypto = require('crypto');
const S = require('../shared.cjs');
const store = require('./store.cjs');

const COOKIE = 'hh_mgr';
const IDLE_MS = 30 * 60 * 1000;
const ABS_MS = 8 * 60 * 60 * 1000;
const SECURE = process.env.HH_SECURE_COOKIE === '1';   // set when served over HTTPS

const ROLES = ['owner', 'senior_manager', 'store_manager', 'read_only_analyst'];
const ROLE_LABEL = { owner: 'Owner', senior_manager: 'Senior Manager', store_manager: 'Store Manager', read_only_analyst: 'Read-Only Analyst' };

/* capability matrix */
const PERMS = {
  owner:             { allStores: true,  manageManagers: true,  viewAudit: true,  pii: true,  compare: true,  settings: 'edit' },
  senior_manager:    { allStores: true,  manageManagers: false, viewAudit: false, pii: true,  compare: true,  settings: 'view' },
  store_manager:     { allStores: false, manageManagers: false, viewAudit: false, pii: true,  compare: false, settings: 'view' },
  read_only_analyst: { allStores: true,  manageManagers: false, viewAudit: false, pii: false, compare: true,  settings: 'view' }
};
function can(role, perm) { const p = PERMS[role]; return !!(p && p[perm] && p[perm] !== false); }
function perms(role) { return PERMS[role] || PERMS.read_only_analyst; }

/* ---- password policy ------------------------------------------------------- */
function passwordPolicy(pw) {
  pw = String(pw || '');
  if (pw.length < 10) return { ok: false, error: 'Password must be at least 10 characters.' };
  if (!/[a-z]/.test(pw)) return { ok: false, error: 'Password needs a lowercase letter.' };
  if (!/[A-Z]/.test(pw)) return { ok: false, error: 'Password needs an uppercase letter.' };
  if (!/[0-9]/.test(pw)) return { ok: false, error: 'Password needs a digit.' };
  if (!/[^A-Za-z0-9]/.test(pw)) return { ok: false, error: 'Password needs a symbol.' };
  return { ok: true };
}

/* ---- sessions -------------------------------------------------------------- */
const SESSIONS = new Map();
function login(email, password, ip) {
  const m = store.findByEmail(email);
  if (!m || !m.active || !S.verifySecret(password, m.salt, m.hash)) return null;
  const token = S.randomToken(32);
  const now = Date.now();
  const sess = { token, managerId: m.id, role: m.role, storeId: m.storeId, name: m.name, email: m.email, csrf: S.randomToken(18), created: now, lastSeen: now, ip: ip };
  SESSIONS.set(token, sess);
  m.lastLogin = new Date().toISOString(); store.saveSoon();
  return sess;
}
function getSession(token) {
  const s = SESSIONS.get(token);
  if (!s) return null;
  const now = Date.now();
  if (now - s.created > ABS_MS || now - s.lastSeen > IDLE_MS) { SESSIONS.delete(token); return null; }
  s.lastSeen = now;
  return s;
}
function destroy(token) { SESSIONS.delete(token); }

/* ---- cookies --------------------------------------------------------------- */
function parseCookies(req) {
  const out = {}; const h = req.headers.cookie; if (!h) return out;
  h.split(';').forEach(function (p) { const i = p.indexOf('='); if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function sessionCookie(token) {
  return COOKIE + '=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + Math.floor(ABS_MS / 1000) + (SECURE ? '; Secure' : '');
}
function clearCookie() { return COOKIE + '=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' + (SECURE ? '; Secure' : ''); }

function fromReq(req) {
  const c = parseCookies(req);
  return c[COOKIE] ? getSession(c[COOKIE]) : null;
}
function csrfOk(req, sess) {
  const h = req.headers['x-csrf-token'] || '';
  return S.safeEqual(h, sess.csrf);
}

/* ---- store scoping + PII masking ------------------------------------------- */
function scopeStore(sess, requested) {
  if (!perms(sess.role).allStores) return sess.storeId || 'infirmary';   // store managers locked to their store
  return requested || 'all';
}
function maskPhone(p) { p = String(p || ''); return p.length < 5 ? '•••' : p.slice(0, 2) + '•••••' + p.slice(-3); }
function maskEmail(e) { e = String(e || ''); const i = e.indexOf('@'); if (i < 1) return '•••'; return e[0] + '•••' + e.slice(i); }
function maskCustomer(sess, c) {
  if (perms(sess.role).pii) return c;
  return Object.assign({}, c, { phone: maskPhone(c.phone), email: maskEmail(c.email) });
}

module.exports = {
  COOKIE, ROLES, ROLE_LABEL, PERMS,
  can, perms, passwordPolicy,
  login, getSession, destroy,
  parseCookies, sessionCookie, clearCookie, fromReq, csrfOk,
  scopeStore, maskCustomer
};
