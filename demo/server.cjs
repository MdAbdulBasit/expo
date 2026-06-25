'use strict';
/* ============================================================================
   HARLEM HOUSE — unified demo backend (http://localhost:4000)

   One server that:
     • serves the customer storefront + the three staff portals
     • takes customer orders (validated + RE-PRICED server-side)
     • runs the order lifecycle as a role-gated state machine (persisted)
     • pushes realtime updates to every portal via SSE
     • notifies the vendor on new order / successful payment
     • demo payments (Stripe/Dojo-shaped) and owner reports

   Roles:  owner (master) · vendor (cashier) · delivery (driver) · customer (public)
   ============================================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const cfg = require('./config.cjs');
const S = require('./shared.cjs');
const db = require('./db.cjs');
const rbac = require('./rbac.cjs');
const pay = require('./payments.cjs');

const ROOT = path.resolve(__dirname, '..');
const PORT = cfg.storePort || 4000;
const MAX_BODY = 16 * 1024;

const orderLimiter = S.makeRateLimiter(8, 8 / 60);     // customer orders
const loginLimiter = S.makeRateLimiter(10, 10 / 60);   // staff logins (brute-force guard)
const apiLimiter = S.makeRateLimiter(300, 300 / 60);

/* ---- SSE realtime hub ------------------------------------------------------ */
const clients = new Set();             // { res, role, userId }
function broadcast(event, data, filter) {
  const frame = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const c of clients) {
    if (filter && !filter(c)) continue;
    try { c.res.write(frame); } catch (e) { /* closed */ }
  }
}
/* an order / notification for a given store reaches that store's staff + the owner (master) */
const toStoreStaff = (store) => (c) => c.role === 'owner' || c.store === store;

/* ---- helpers --------------------------------------------------------------- */
function headers(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Cache-Control', 'no-store');
}
function json(res, status, obj) {
  const b = JSON.stringify(obj); headers(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}
async function readJson(req) {
  if ((req.headers['content-type'] || '').indexOf('application/json') !== 0) { const e = new Error('json required'); e.status = 415; throw e; }
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) { const e = new Error('too large'); e.status = 413; throw e; }
  const text = await S.readBody(req, MAX_BODY);
  try { return JSON.parse(text); } catch (e) { const er = new Error('bad json'); er.status = 400; throw er; }
}
function bearer(req, url) {
  const h = req.headers['authorization'] || '';
  if (h.indexOf('Bearer ') === 0) return h.slice(7).trim();
  return (url && url.searchParams.get('token')) || '';
}
function auth(req, url) { return rbac.sessionFrom(bearer(req, url)); }
function publicOrder(o) { /* what staff portals see */
  return o;
}
function notify(n) {
  n = Object.assign({ id: 'n_' + S.randomToken(6), at: new Date().toISOString(), read: false }, n);
  db.addNotification(n);
  broadcast('notification', n, toStoreStaff(n.store));
  return n;
}

/* ---- customer: place order ------------------------------------------------- */
async function placeOrder(req, res) {
  const origin = req.headers.origin;
  if (origin && origin !== cfg.allowOrigin) return json(res, 403, { ok: false, error: 'Origin not allowed.' });
  if (!orderLimiter(S.clientIp(req))) return json(res, 429, { ok: false, error: 'Too many orders — slow down.' });
  let raw; try { raw = await readJson(req); } catch (e) { return json(res, e.status || 400, { ok: false, error: 'Could not read order.' }); }

  const v = S.validateOrder(raw);
  if (!v.ok) return json(res, v.status || 400, { ok: false, error: v.error });

  const o = v.order;
  o.id = 'o_' + S.randomToken(8);
  o.ref = 'HH-' + db.nextOrderNo();
  o.status = 'PENDING';
  o.paid = false;
  o.payment = null;
  o.driverId = null;
  o.history = [{ to: 'PENDING', at: o.placedAt, by: 'customer' }];
  db.addOrder(o);

  broadcast('order.created', o, toStoreStaff(o.store));
  notify({ type: 'order', level: 'new', store: o.store, ref: o.ref, orderId: o.id, text: 'New order ' + o.ref + ' · ' + o.mode + ' · £' + o.subtotal.toFixed(2) });
  console.log('[order] %s placed (%s £%s) status=PENDING', o.ref, o.mode, o.subtotal.toFixed(2));
  return json(res, 200, { ok: true, ref: o.ref, orderId: o.id, total: o.subtotal, eta: o.eta, status: o.status, payable: !o.paid });
}

/* ---- customer: track order (ref + phone, no login) ------------------------- */
function trackOrder(res, url) {
  const ref = (url.searchParams.get('ref') || '').trim();
  const phone = (url.searchParams.get('phone') || '').replace(/[\s\-()]/g, '');
  const o = db.orders().find(x => x.ref === ref && x.phone === phone);
  if (!o) return json(res, 404, { ok: false, error: 'Order not found. Check the reference and phone number.' });
  return json(res, 200, { ok: true, ref: o.ref, status: o.status, mode: o.mode, eta: o.eta, paid: o.paid,
    history: o.history, items: o.items.map(i => ({ name: i.name, qty: i.qty })), total: o.subtotal,
    driver: o.driverId ? (db.findUser(u => u.id === o.driverId) || {}).name || null : null });
}

/* ---- payments (demo) ------------------------------------------------------- */
async function payIntent(req, res) {
  let b; try { b = await readJson(req); } catch (e) { return json(res, e.status || 400, { ok: false, error: 'bad request' }); }
  const o = db.findOrder(b.orderId);
  if (!o) return json(res, 404, { ok: false, error: 'Order not found.' });
  if (o.paid) return json(res, 409, { ok: false, error: 'Already paid.' });
  return json(res, 200, { ok: true, intent: pay.createIntent(o) });
}
async function payConfirm(req, res) {
  let b; try { b = await readJson(req); } catch (e) { return json(res, e.status || 400, { ok: false, error: 'bad request' }); }
  const o = db.findOrder(b.orderId);
  if (!o) return json(res, 404, { ok: false, error: 'Order not found.' });
  const r = pay.confirmIntent(b.intentId, b.clientSecret);
  if (!r.ok) return json(res, 402, { ok: false, error: r.error });
  o.paid = true; o.payment = r.payment; db.saveSoon();
  broadcast('order.updated', o, toStoreStaff(o.store));
  notify({ type: 'payment', level: 'paid', store: o.store, ref: o.ref, orderId: o.id, text: 'Payment received for ' + o.ref + ' · £' + o.subtotal.toFixed(2) });
  console.log('[pay] %s paid via %s', o.ref, r.payment.provider);
  return json(res, 200, { ok: true, paid: true, payment: r.payment });
}

/* ---- staff: auth ----------------------------------------------------------- */
async function doLogin(req, res) {
  if (!loginLimiter(S.clientIp(req))) return json(res, 429, { ok: false, error: 'Too many attempts. Wait a moment.' });
  let b; try { b = await readJson(req); } catch (e) { return json(res, e.status || 400, { ok: false, error: 'bad request' }); }
  const r = rbac.login(b.username, b.pin);
  if (!r) return json(res, 401, { ok: false, error: 'Wrong username or PIN.' });
  return json(res, 200, { ok: true, token: r.token, user: r.user });
}

/* ---- staff: orders list (role-filtered) ------------------------------------ */
function listOrders(res, s, url) {
  const scope = url.searchParams.get('scope') || 'active';
  let list = db.orders();
  if (s.role === 'vendor') list = list.filter(o => o.store === s.store);   // vendor sees ONLY their own store
  if (s.role === 'delivery') {
    list = list.filter(o => o.driverId === s.userId && (rbac.isActive(o.status) || o.status === 'COMPLETED'));
    if (scope === 'active') list = list.filter(o => rbac.isActive(o.status));
  } else {
    if (scope === 'active') list = list.filter(o => rbac.isActive(o.status));
    else if (scope === 'completed') list = list.filter(o => o.status === 'COMPLETED' || o.status === 'REJECTED');
    // scope 'all' -> everything
  }
  return json(res, 200, { ok: true, orders: list });
}

/* ---- staff: transition ----------------------------------------------------- */
async function transition(req, res, s, id) {
  let b; try { b = await readJson(req); } catch (e) { return json(res, e.status || 400, { ok: false, error: 'bad request' }); }
  const o = db.findOrder(id);
  if (!o) return json(res, 404, { ok: false, error: 'Order not found.' });
  if (!rbac.canActOnOrder(s, o)) return json(res, 403, { ok: false, error: 'Not your order.' });
  const chk = rbac.canTransition(s.role, o, b.to);
  if (!chk.ok) return json(res, 409, { ok: false, error: chk.error });

  o.status = b.to;
  if (b.to === 'COMPLETED') o.completedAt = new Date().toISOString();
  o.history.push({ to: b.to, at: new Date().toISOString(), by: s.name + ' (' + s.role + ')' });

  // auto-assign a driver the moment a delivery order is accepted (if none yet)
  if (b.to === 'ACCEPTED' && o.mode === 'Delivery' && !o.driverId) {
    const d = rbac.pickDriver(o.store);   // least-busy driver IN THIS STORE
    if (d) { o.driverId = d; o.history.push({ to: 'ASSIGNED', at: new Date().toISOString(), by: 'auto-assign' });
      notify({ type: 'assign', store: o.store, ref: o.ref, orderId: o.id, driverId: d, text: 'Driver auto-assigned to ' + o.ref }); }
  }
  db.saveSoon();
  broadcast('order.updated', o, toStoreStaff(o.store));
  console.log('[order] %s -> %s by %s', o.ref, b.to, s.name);
  return json(res, 200, { ok: true, order: o });
}

/* ---- staff: manual driver assignment (vendor + owner) ---------------------- */
async function assignDriver(req, res, s, id) {
  if (s.role !== 'vendor' && s.role !== 'owner') return json(res, 403, { ok: false, error: 'Not allowed.' });
  let b; try { b = await readJson(req); } catch (e) { return json(res, e.status || 400, { ok: false, error: 'bad request' }); }
  const o = db.findOrder(id);
  if (!o) return json(res, 404, { ok: false, error: 'Order not found.' });
  if (o.mode !== 'Delivery') return json(res, 409, { ok: false, error: 'Collection orders need no driver.' });
  // a vendor can only assign a driver from their OWN store (owner may assign within the order's store)
  const drv = db.findUser(u => u.id === b.driverId && u.role === 'delivery' && u.active && u.store === o.store);
  if (!drv) return json(res, 400, { ok: false, error: 'Pick an active driver from this store.' });
  o.driverId = drv.id;
  o.history.push({ to: 'ASSIGNED', at: new Date().toISOString(), by: s.name + ' -> ' + drv.name });
  db.saveSoon();
  broadcast('order.updated', o, toStoreStaff(o.store));
  notify({ type: 'assign', store: o.store, ref: o.ref, orderId: o.id, driverId: drv.id, text: drv.name + ' assigned to ' + o.ref });
  return json(res, 200, { ok: true, order: o });
}

/* ---- drivers list (vendor + owner) ----------------------------------------- */
function listDrivers(res, s) {
  const sameStore = (u) => s.role === 'owner' || u.store === s.store;   // vendor → own store's drivers only
  const load = {};
  db.users().forEach(u => { if (u.role === 'delivery' && u.active && sameStore(u)) load[u.id] = 0; });
  db.orders().forEach(o => { if (o.driverId != null && load[o.driverId] != null && rbac.isActive(o.status)) load[o.driverId]++; });
  const drivers = db.users().filter(u => u.role === 'delivery' && u.active && sameStore(u)).map(u => ({ id: u.id, name: u.name, activeJobs: load[u.id] || 0 }));
  return json(res, 200, { ok: true, drivers: drivers });
}

/* ---- staff management (owner only) ----------------------------------------- */
async function staffRoutes(req, res, s, parts) {
  if (s.role !== 'owner') return json(res, 403, { ok: false, error: 'Owner only.' });
  const method = req.method;
  if (method === 'GET' && parts.length === 2) return json(res, 200, { ok: true, staff: db.users().map(rbac.publicUser) });
  if (method === 'POST' && parts.length === 2) {
    let b; try { b = await readJson(req); } catch (e) { return json(res, e.status || 400, { ok: false, error: 'bad request' }); }
    const name = S.clean(b.name, 40), username = S.clean(b.username, 24).toLowerCase().replace(/[^a-z0-9_]/g, '');
    const role = ['owner', 'vendor', 'delivery'].indexOf(b.role) > -1 ? b.role : null;
    const pin = String(b.pin || '');
    if (name.length < 2 || username.length < 3 || !role || !/^\d{4,6}$/.test(pin)) return json(res, 400, { ok: false, error: 'Name, username, role and a 4–6 digit PIN are required.' });
    if (db.findUser(u => u.username === username)) return json(res, 409, { ok: false, error: 'Username already exists.' });
    const h = S.hashSecret(pin);
    const u = { id: 'u_' + S.randomToken(5), name, username, role, salt: h.salt, hash: h.hash, active: true, createdAt: new Date().toISOString() };
    db.users().push(u); db.saveSoon();
    return json(res, 200, { ok: true, user: rbac.publicUser(u) });
  }
  const id = parts[2];
  const target = db.findUser(u => u.id === id);
  if (!target) return json(res, 404, { ok: false, error: 'Staff not found.' });
  if (method === 'PATCH') {
    let b; try { b = await readJson(req); } catch (e) { return json(res, e.status || 400, { ok: false, error: 'bad request' }); }
    if (b.role && ['owner', 'vendor', 'delivery'].indexOf(b.role) > -1) {
      if (target.role === 'owner' && b.role !== 'owner' && db.users().filter(u => u.role === 'owner' && u.active).length <= 1) return json(res, 409, { ok: false, error: 'Cannot demote the last owner.' });
      target.role = b.role;
    }
    if (typeof b.active === 'boolean') {
      if (!b.active && target.id === s.userId) return json(res, 409, { ok: false, error: 'You cannot deactivate yourself.' });
      target.active = b.active;
    }
    if (b.pin && /^\d{4,6}$/.test(String(b.pin))) { const h = S.hashSecret(String(b.pin)); target.salt = h.salt; target.hash = h.hash; }
    db.saveSoon();
    return json(res, 200, { ok: true, user: rbac.publicUser(target) });
  }
  if (method === 'DELETE') {
    if (target.id === s.userId) return json(res, 409, { ok: false, error: 'You cannot delete yourself.' });
    if (target.role === 'owner' && db.users().filter(u => u.role === 'owner' && u.active).length <= 1) return json(res, 409, { ok: false, error: 'Cannot delete the last owner.' });
    db.data().users = db.users().filter(u => u.id !== id); db.saveSoon();
    return json(res, 200, { ok: true });
  }
  return json(res, 405, { ok: false, error: 'method' });
}

/* ---- reports (owner only) -------------------------------------------------- */
function reports(res, url) {
  const period = url.searchParams.get('period') || 'day';
  const now = new Date();
  const done = db.orders().filter(o => o.status === 'COMPLETED');
  function inPeriod(o) {
    const d = new Date(o.placedAt);
    if (period === 'day') return d.toDateString() === now.toDateString();
    if (period === 'month') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    if (period === 'year') return d.getFullYear() === now.getFullYear();
    return true;
  }
  const rows = done.filter(inPeriod);
  const revenue = rows.reduce((s, o) => s + o.subtotal, 0);
  const itemCount = {};
  rows.forEach(o => o.items.forEach(it => { itemCount[it.name] = (itemCount[it.name] || 0) + it.qty; }));
  const topItems = Object.keys(itemCount).map(k => ({ name: k, qty: itemCount[k] })).sort((a, b) => b.qty - a.qty).slice(0, 6);
  // simple time buckets
  const buckets = {};
  rows.forEach(o => {
    const d = new Date(o.placedAt);
    const key = period === 'day' ? (String(d.getHours()).padStart(2, '0') + ':00')
      : period === 'month' ? ('Day ' + d.getDate())
      : (['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]);
    buckets[key] = (buckets[key] || 0) + o.subtotal;
  });
  return json(res, 200, { ok: true, period,
    summary: { orders: rows.length, revenue: Math.round(revenue * 100) / 100, avg: rows.length ? Math.round(revenue / rows.length * 100) / 100 : 0 },
    topItems, buckets,
    active: db.orders().filter(o => rbac.isActive(o.status)).length
  });
}

/* ---- static serving -------------------------------------------------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const PORTAL_PAGES = { '/login': 'login.html', '/login.html': 'login.html', '/vendor': 'vendor.html', '/vendor.html': 'vendor.html', '/owner': 'owner.html', '/owner.html': 'owner.html', '/delivery': 'delivery.html', '/delivery.html': 'delivery.html' };
function sendFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { headers(res); res.writeHead(404); return res.end('not found'); }
    headers(res);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}
function serveStatic(req, res, url) {
  if (PORTAL_PAGES[url.pathname]) return sendFile(res, path.join(__dirname, PORTAL_PAGES[url.pathname]));
  let p; try { p = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end('bad'); }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  if (path.relative(ROOT, file).split(path.sep)[0] === 'demo') { res.writeHead(404); return res.end('not found'); } // never serve server code/secrets
  sendFile(res, file);
}

/* ---- router ---------------------------------------------------------------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, cfg.allowOrigin);
  const p = url.pathname;
  const m = req.method;

  // public API
  if (p === '/api/health') return json(res, 200, { ok: true, service: 'harlem-house', orders: db.orders().length });
  if (p === '/api/orders' && m === 'POST') return placeOrder(req, res).catch(() => json(res, 500, { ok: false, error: 'server error' }));
  if (p === '/api/track' && m === 'GET') return trackOrder(res, url);
  if (p === '/api/payments/intent' && m === 'POST') return payIntent(req, res).catch(() => json(res, 500, { ok: false, error: 'server error' }));
  if (p === '/api/payments/confirm' && m === 'POST') return payConfirm(req, res).catch(() => json(res, 500, { ok: false, error: 'server error' }));
  if (p === '/api/auth/login' && m === 'POST') return doLogin(req, res).catch(() => json(res, 500, { ok: false, error: 'server error' }));

  // SSE (auth via ?token=)
  if (p === '/api/stream' && m === 'GET') {
    const s = auth(req, url); if (!s) return json(res, 401, { ok: false, error: 'unauthorized' });
    headers(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'Cache-Control': 'no-store' });
    res.write('retry: 3000\n\n');
    const c = { res, role: s.role, userId: s.userId, store: s.store }; clients.add(c);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(c); });
    return;
  }

  // authenticated staff API
  if (p.indexOf('/api/') === 0) {
    if (!apiLimiter(S.clientIp(req))) return json(res, 429, { ok: false, error: 'rate limited' });
    const s = auth(req, url);
    if (!s) return json(res, 401, { ok: false, error: 'unauthorized' });

    if (p === '/api/auth/logout' && m === 'POST') { rbac.logout(bearer(req, url)); return json(res, 200, { ok: true }); }
    if (p === '/api/auth/me' && m === 'GET') return json(res, 200, { ok: true, user: { id: s.userId, name: s.name, role: s.role, store: s.store, storeName: S.storeName(s.store) } });
    if (p === '/api/orders' && m === 'GET') return listOrders(res, s, url);
    if (p === '/api/drivers' && m === 'GET') { if (s.role === 'delivery') return json(res, 403, { ok: false, error: 'forbidden' }); return listDrivers(res, s); }
    if (p === '/api/notifications' && m === 'GET') { if (s.role === 'delivery') return json(res, 200, { ok: true, notifications: [] }); const ns = db.notifications().filter(n => s.role === 'owner' || n.store === s.store).slice(0, 40); return json(res, 200, { ok: true, notifications: ns }); }
    if (p === '/api/reports' && m === 'GET') { if (s.role !== 'owner') return json(res, 403, { ok: false, error: 'Owner only.' }); return reports(res, url); }

    const parts = p.split('/').filter(Boolean); // ['api','orders',':id','transition']
    if (parts[1] === 'orders' && parts[3] === 'transition' && m === 'POST') return transition(req, res, s, parts[2]).catch(() => json(res, 500, { ok: false, error: 'server error' }));
    if (parts[1] === 'orders' && parts[3] === 'assign' && m === 'POST') return assignDriver(req, res, s, parts[2]).catch(() => json(res, 500, { ok: false, error: 'server error' }));
    if (parts[1] === 'staff') return staffRoutes(req, res, s, parts).catch(() => json(res, 500, { ok: false, error: 'server error' }));

    return json(res, 404, { ok: false, error: 'unknown endpoint' });
  }

  // pages / assets
  if (m === 'GET' || m === 'HEAD') return serveStatic(req, res, url);
  res.writeHead(405); res.end('method not allowed');
});

server.listen(PORT, () => {
  console.log('===================================================');
  console.log(' HARLEM HOUSE — demo backend on http://localhost:' + PORT);
  console.log('   Customer storefront : http://localhost:' + PORT + '/');
  console.log('   Staff login         : http://localhost:' + PORT + '/login');
  console.log('   Vendor (cashier)    : http://localhost:' + PORT + '/vendor');
  console.log('   Owner (manager)     : http://localhost:' + PORT + '/owner');
  console.log('   Delivery (driver)   : http://localhost:' + PORT + '/delivery');
  console.log('   Payments provider   : ' + pay.PROVIDER + '  (demo, no real charge)');
  console.log('   Data file           : demo/data/db.json  (orders persist here)');
  console.log('   St Mary\'s Road — ahmed/1111 · mohammed/1112   (drivers: baran, azad)');
  console.log('   Infirmary Road — omar/2221 · ibrahim/2222     (drivers: mustafa, kawa)');
  console.log('   Owner (master) — owner/1234');
  console.log('===================================================');
});
