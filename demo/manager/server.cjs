'use strict';
/* ============================================================================
   HARLEM HOUSE — Manager / Owner Dashboard backend  (http://localhost:4500)

   A standalone, secured web app for managers/owners. It reads ALL business data
   from the POS integration seam (pos-source.cjs → Presto in production) and adds
   its own manager accounts, RBAC, sessions and audit log.

   Security: HttpOnly+SameSite session cookie, CSRF token on mutations, scrypt
   password hashing + strong-password policy, idle/absolute session expiry,
   per-IP rate limiting, request validation, role-based access + store scoping +
   PII masking, security headers/CSP, and an audit trail of manager actions.
   ============================================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const S = require('../shared.cjs');
const POS = require('./pos-source.cjs');
const store = require('./store.cjs');
const auth = require('./auth.cjs');

const PORT = Number(process.env.HH_MANAGER_PORT) || 4500;
const ORIGIN = 'http://localhost:' + PORT;
const MAX_BODY = 16 * 1024;

const loginLimiter = S.makeRateLimiter(8, 8 / 60);     // 8 login attempts/min/IP
const apiLimiter = S.makeRateLimiter(600, 600 / 60);
const pinLimiter = S.makeRateLimiter(6, 6 / 60);       // master-PIN attempts/min/IP

const SUPPORT = { company: 'Harlem House Ltd', phone: '[To be added]', email: '[To be added]' };
const AUTO_REFRESH_MIN = 60;                            // dashboard auto-refreshes hourly

/* ---- http helpers ---------------------------------------------------------- */
function secHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}
function json(res, status, obj, extraHeaders) {
  const b = JSON.stringify(obj); secHeaders(res);
  const h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b) }, extraHeaders || {});
  res.writeHead(status, h); res.end(b);
}
async function readJson(req) {
  if ((req.headers['content-type'] || '').indexOf('application/json') !== 0) { const e = new Error('json'); e.status = 415; throw e; }
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) { const e = new Error('big'); e.status = 413; throw e; }
  const t = await S.readBody(req, MAX_BODY);
  try { return JSON.parse(t); } catch (e) { const er = new Error('bad json'); er.status = 400; throw er; }
}
function num(v, def) { const n = parseInt(v, 10); return isFinite(n) ? n : def; }

/* ---- auth guards ----------------------------------------------------------- */
function requireAuth(req, res) {
  const s = auth.fromReq(req);
  if (!s) { json(res, 401, { ok: false, error: 'Not signed in.' }); return null; }
  return s;
}
function requireCsrf(req, res, s) {
  if (!auth.csrfOk(req, s)) { json(res, 403, { ok: false, error: 'Invalid CSRF token.' }); return false; }
  return true;
}

/* ---- API ------------------------------------------------------------------- */
async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  const ip = S.clientIp(req);

  /* ---- login (public) ---- */
  if (p === '/api/login' && m === 'POST') {
    if (!loginLimiter(ip)) return json(res, 429, { ok: false, error: 'Too many attempts. Please wait a minute.' });
    let b; try { b = await readJson(req); } catch (e) { return json(res, e.status || 400, { ok: false, error: 'Bad request.' }); }
    const sess = auth.login(b.email, b.password, ip);
    if (!sess) { store.addAudit({ action: 'login_failed', email: String(b.email || '').slice(0, 60), ip }); return json(res, 401, { ok: false, error: 'Wrong email or password.' }); }
    store.addAudit({ action: 'login', managerId: sess.managerId, name: sess.name, ip });
    return json(res, 200, { ok: true, csrf: sess.csrf, user: userInfo(sess) }, { 'Set-Cookie': auth.sessionCookie(sess.token) });
  }

  if (!apiLimiter(ip)) return json(res, 429, { ok: false, error: 'Rate limited.' });

  /* ---- everything below needs a session ---- */
  const s = requireAuth(req, res); if (!s) return;

  if (p === '/api/logout' && m === 'POST') {
    const c = auth.parseCookies(req); if (c[auth.COOKIE]) auth.destroy(c[auth.COOKIE]);
    store.addAudit({ action: 'logout', managerId: s.managerId, name: s.name, ip });
    return json(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
  }
  if (p === '/api/me' && m === 'GET') return json(res, 200, { ok: true, csrf: s.csrf, user: userInfo(s), stores: POS.STORES, support: SUPPORT, autoRefreshMin: AUTO_REFRESH_MIN, paymentMethods: POS.PAYMENT_LABEL, masterPinRequired: true, idleLogoutMin: 30 });

  /* ---- read-only analytics (GET) ---- */
  if (m === 'GET') {
    const reqStore = url.searchParams.get('store');
    const sStore = auth.scopeStore(s, reqStore);
    const period = ['day', 'week', 'month', 'year'].indexOf(url.searchParams.get('period')) > -1 ? url.searchParams.get('period') : 'month';

    if (p === '/api/overview') return json(res, 200, { ok: true, store: sStore, data: POS.overview(sStore, period) });
    if (p === '/api/live') return json(res, 200, { ok: true, store: sStore, orders: POS.liveOrders(sStore) });
    if (p === '/api/revenue') return json(res, 200, { ok: true, store: sStore, data: POS.revenue(sStore, period) });
    if (p === '/api/top-items') return json(res, 200, { ok: true, store: sStore, items: POS.topItems(sStore, period, 12) });

    if (p === '/api/logs') {
      const out = POS.orderLogs({ store: sStore, status: url.searchParams.get('status'), q: url.searchParams.get('q'), from: url.searchParams.get('from'), to: url.searchParams.get('to'), page: num(url.searchParams.get('page'), 1), size: num(url.searchParams.get('size'), 20) });
      out.orders = out.orders.map(function (o) { return Object.assign({}, o, { customer: auth.maskCustomer(s, o.customer) }); });
      return json(res, 200, Object.assign({ ok: true, store: sStore }, out));
    }
    if (p === '/api/transactions') {
      const out = POS.transactions({ store: sStore, method: url.searchParams.get('method'), q: url.searchParams.get('q'), page: num(url.searchParams.get('page'), 1), size: num(url.searchParams.get('size'), 20) });
      return json(res, 200, Object.assign({ ok: true, store: sStore }, out));
    }
    if (p === '/api/customers') {
      const out = POS.customers({ store: sStore, q: url.searchParams.get('q'), page: num(url.searchParams.get('page'), 1), size: num(url.searchParams.get('size'), 20) });
      out.customers = out.customers.map(function (c) { return auth.maskCustomer(s, c); });
      store.addAudit({ action: 'view_customers', managerId: s.managerId, name: s.name, store: sStore, ip });
      return json(res, 200, Object.assign({ ok: true, store: sStore, pii: auth.perms(s.role).pii }, out));
    }
    if (p === '/api/receipt') {
      const o = POS.findOrder(url.searchParams.get('id') || '');
      if (!o) return json(res, 404, { ok: false, error: 'Order not found.' });
      if (!auth.perms(s.role).allStores && o.store !== s.storeId) return json(res, 403, { ok: false, error: 'Outside your store.' });
      store.addAudit({ action: 'view_receipt', managerId: s.managerId, name: s.name, ref: o.ref, ip });
      return json(res, 200, { ok: true, order: Object.assign({}, o, { customer: auth.maskCustomer(s, o.customer) }) });
    }
    if (p === '/api/compare') {
      if (!auth.can(s.role, 'compare')) return json(res, 403, { ok: false, error: 'Store comparison is not available for your role.' });
      return json(res, 200, { ok: true, stores: POS.compare(period) });
    }

    /* ---- owner-only reads ---- */
    if (p === '/api/managers') {
      if (!auth.can(s.role, 'manageManagers')) return json(res, 403, { ok: false, error: 'Owner access required.' });
      return json(res, 200, { ok: true, managers: store.managers().map(store.publicManager), roles: auth.ROLE_LABEL });
    }
    if (p === '/api/audit') {
      if (!auth.can(s.role, 'viewAudit')) return json(res, 403, { ok: false, error: 'Owner access required.' });
      return json(res, 200, { ok: true, audit: store.audit().slice(0, 200) });
    }
    return json(res, 404, { ok: false, error: 'Unknown endpoint.' });
  }

  /* ---- mutations (CSRF required) ---- */
  if (!requireCsrf(req, res, s)) return;

  /* change the Master Security PIN — Head Office Owner only */
  if (p === '/api/master-pin' && m === 'POST') {
    if (s.role !== 'owner') return json(res, 403, { ok: false, error: 'Only the Head Office Owner can change the Master PIN.' });
    if (!pinLimiter(ip)) return json(res, 429, { ok: false, error: 'Too many attempts. Wait a minute.' });
    let b; try { b = await readJson(req); } catch (e) { return json(res, e.status || 400, { ok: false, error: 'Bad request.' }); }
    if (!store.verifyMaster(b.currentPin)) { store.addAudit({ action: 'master_pin_change_failed', managerId: s.managerId, name: s.name, ip }); return json(res, 403, { ok: false, error: 'Current Master PIN is incorrect.' }); }
    if (!/^\d{4,6}$/.test(String(b.newPin || ''))) return json(res, 400, { ok: false, error: 'New PIN must be 4–6 digits.' });
    store.setMaster(String(b.newPin));
    store.addAudit({ action: 'master_pin_changed', managerId: s.managerId, name: s.name, ip });
    return json(res, 200, { ok: true });
  }

  /* manager account management — requires manageManagers role AND the Master PIN */
  const parts = p.split('/').filter(Boolean); // ['api','managers',':id']
  if (parts[1] === 'managers') {
    if (!auth.can(s.role, 'manageManagers')) return json(res, 403, { ok: false, error: 'Owner access required.' });
    if (!pinLimiter(ip)) return json(res, 429, { ok: false, error: 'Too many attempts. Wait a minute.' });
    if (!store.verifyMaster(req.headers['x-master-pin'] || '')) {
      store.addAudit({ action: 'master_pin_failed', managerId: s.managerId, name: s.name, ip });
      return json(res, 403, { ok: false, error: 'Master Security PIN required or incorrect.', needPin: true });
    }

    if (m === 'POST' && parts.length === 2) {
      let b; try { b = await readJson(req); } catch (e) { return json(res, e.status || 400, { ok: false, error: 'Bad request.' }); }
      const name = S.clean(b.name, 50), email = S.clean(b.email, 80).toLowerCase();
      const role = auth.ROLES.indexOf(b.role) > -1 ? b.role : null;
      const storeId = (role === 'store_manager') ? (POS.STORES.find(x => x.id === b.storeId) ? b.storeId : null) : null;
      if (name.length < 2) return json(res, 400, { ok: false, error: 'Enter a name.' });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { ok: false, error: 'Enter a valid email.' });
      if (!role) return json(res, 400, { ok: false, error: 'Pick a role.' });
      if (role === 'store_manager' && !storeId) return json(res, 400, { ok: false, error: 'Store managers need an assigned store.' });
      const pol = auth.passwordPolicy(b.password); if (!pol.ok) return json(res, 400, { ok: false, error: pol.error });
      if (store.findByEmail(email)) return json(res, 409, { ok: false, error: 'That email already exists.' });
      const h = S.hashSecret(b.password);
      const mm = { id: 'm_' + S.randomToken(6), name, email, role, storeId, salt: h.salt, hash: h.hash, active: true, createdAt: new Date().toISOString() };
      store.managers().push(mm); store.saveSoon();
      store.addAudit({ action: 'manager_create', managerId: s.managerId, name: s.name, target: email, role, ip });
      return json(res, 200, { ok: true, manager: store.publicManager(mm) });
    }

    const target = store.findById(parts[2]);
    if (!target) return json(res, 404, { ok: false, error: 'Manager not found.' });
    const owners = () => store.managers().filter(x => x.role === 'owner' && x.active);

    if (m === 'PATCH') {
      let b; try { b = await readJson(req); } catch (e) { return json(res, e.status || 400, { ok: false, error: 'Bad request.' }); }
      if (typeof b.name === 'string' && S.clean(b.name, 50).length >= 2) target.name = S.clean(b.name, 50);
      if (b.role && auth.ROLES.indexOf(b.role) > -1) {
        if (target.role === 'owner' && b.role !== 'owner' && owners().length <= 1) return json(res, 409, { ok: false, error: 'Cannot demote the last owner.' });
        target.role = b.role; if (b.role !== 'store_manager') target.storeId = null;
      }
      if (target.role === 'store_manager' && b.storeId && POS.STORES.find(x => x.id === b.storeId)) target.storeId = b.storeId;
      if (typeof b.active === 'boolean') {
        if (!b.active && target.id === s.managerId) return json(res, 409, { ok: false, error: 'You cannot deactivate yourself.' });
        if (!b.active && target.role === 'owner' && owners().length <= 1) return json(res, 409, { ok: false, error: 'Cannot deactivate the last owner.' });
        target.active = b.active;
      }
      if (b.password) { const pol = auth.passwordPolicy(b.password); if (!pol.ok) return json(res, 400, { ok: false, error: pol.error }); const h = S.hashSecret(b.password); target.salt = h.salt; target.hash = h.hash; }
      store.saveSoon();
      store.addAudit({ action: 'manager_update', managerId: s.managerId, name: s.name, target: target.email, ip });
      return json(res, 200, { ok: true, manager: store.publicManager(target) });
    }
    if (m === 'DELETE') {
      if (target.id === s.managerId) return json(res, 409, { ok: false, error: 'You cannot delete yourself.' });
      if (target.role === 'owner' && owners().length <= 1) return json(res, 409, { ok: false, error: 'Cannot delete the last owner.' });
      const arr = store.managers(); const i = arr.indexOf(target); if (i > -1) arr.splice(i, 1); store.saveSoon();
      store.addAudit({ action: 'manager_delete', managerId: s.managerId, name: s.name, target: target.email, ip });
      return json(res, 200, { ok: true });
    }
  }
  return json(res, 404, { ok: false, error: 'Unknown endpoint.' });
}

function userInfo(s) {
  return { id: s.managerId, name: s.name, email: s.email, role: s.role, roleLabel: auth.ROLE_LABEL[s.role], storeId: s.storeId, perms: auth.perms(s.role) };
}

/* ---- static (login + dashboard pages only; never serve .cjs/.json) --------- */
const PAGES = { '/': 'login.html', '/login': 'login.html', '/dashboard': 'manager.html', '/manager': 'manager.html' };
function servePage(res, file) {
  fs.readFile(path.join(__dirname, file), function (err, buf) {
    if (err) { secHeaders(res); res.writeHead(404); return res.end('not found'); }
    secHeaders(res);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
    res.end(buf);
  });
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname.indexOf('/api/') === 0) { api(req, res, url).catch(function () { json(res, 500, { ok: false, error: 'Server error.' }); }); return; }
  if (req.method === 'GET' && PAGES[url.pathname]) return servePage(res, PAGES[url.pathname]);
  secHeaders(res); res.writeHead(404); res.end('not found');
});

server.listen(PORT, function () {
  console.log('===================================================');
  console.log(' HARLEM HOUSE — Manager Dashboard  http://localhost:' + PORT);
  console.log('   Login            : http://localhost:' + PORT + '/login');
  console.log('   Data source      : pos-source.cjs (Presto seam, demo data, 2 stores)');
  console.log('   Secure cookies   : ' + (process.env.HH_SECURE_COOKIE === '1' ? 'on (HTTPS)' : 'off (set HH_SECURE_COOKIE=1 behind TLS)'));
  console.log('   Demo logins:');
  console.log('     owner@harlemhouse.co.uk     / Harlem#2026   (Owner — full access)');
  console.log('     senior@harlemhouse.co.uk    / Senior#2026   (Senior Manager)');
  console.log('     infirmary@harlemhouse.co.uk / Store#2026    (Store Manager — Infirmary only)');
  console.log('     analyst@harlemhouse.co.uk   / Analyst#2026  (Read-Only Analyst — PII masked)');
  console.log('===================================================');
});
