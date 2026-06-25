'use strict';
/* ============================================================================
   Tiny persistent store (file-backed JSON, atomic writes).

   This is what makes order status STICK: every change is written to
   demo/data/db.json, so a "Mark done" / "Accepted" survives logout, login and
   server restarts. (The earlier dashboard only changed a CSS class in the
   browser, which is why it reverted.)

   Swap to Supabase later: replace the read/write helpers here with Supabase
   queries — the rest of the app calls db.orders(), db.addOrder(), db.save()
   etc., so the surface stays the same.
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const S = require('./shared.cjs');

const DIR = path.join(__dirname, 'data');
const FILE = path.join(DIR, 'db.json');

function seedUsers() {
  // demo staff — each staff member belongs to ONE store (owner = master, store:null).
  // (PINs shown on the login page.) Counter staff are named per the real team.
  const mk = (id, name, username, role, store, pin) => {
    const h = S.hashSecret(pin);
    return { id, name, username, role, store, salt: h.salt, hash: h.hash, active: true, createdAt: new Date().toISOString() };
  };
  return [
    mk('u_owner',  'Harlem House — Owner', 'owner',    'owner',    null,        '1234'),
    // ---- St Mary's Road ----
    mk('u_stm_v1', 'Ahmed',    'ahmed',    'vendor',   'stmarys',   '1111'),
    mk('u_stm_v2', 'Mohammed', 'mohammed', 'vendor',   'stmarys',   '1112'),
    mk('u_stm_d1', 'Baran',    'baran',    'delivery', 'stmarys',   '5551'),
    mk('u_stm_d2', 'Azad',     'azad',     'delivery', 'stmarys',   '5552'),
    // ---- Infirmary Road ----
    mk('u_inf_v1', 'Omar',     'omar',     'vendor',   'infirmary', '2221'),
    mk('u_inf_v2', 'Ibrahim',  'ibrahim',  'vendor',   'infirmary', '2222'),
    mk('u_inf_d1', 'Mustafa',  'mustafa',  'delivery', 'infirmary', '6661'),
    mk('u_inf_d2', 'Kawa',     'kawa',     'delivery', 'infirmary', '6662')
  ];
}

/* demo orders per store (different on each, so the isolation is obvious). */
function seedOrders() {
  const C = S.CATALOG, now = Date.now();
  const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
  let seq = 1000;
  function mk(store, branch, mode, status, who, minAgo, lines, extra) {
    seq++;
    const items = lines.map(([id, qty]) => ({ id, name: C[id].name, price: C[id].price, qty, lineTotal: S.round2(C[id].price * qty) }));
    const subtotal = S.round2(items.reduce((s, it) => s + it.lineTotal, 0));
    const o = Object.assign({
      schema: 'hh.order/1', id: 'o_seed' + seq, ref: 'HH-' + seq, placedAt: iso(minAgo),
      mode, name: who.name, phone: who.phone, items, subtotal, currency: 'GBP',
      branch, store, status, paid: status !== 'PENDING', payment: null, driverId: null,
      history: [{ to: 'PENDING', at: iso(minAgo), by: 'seed' }]
    }, extra || {});
    if (mode === 'Delivery') { o.address = who.address; o.postcode = who.postcode; o.eta = who.eta || '20–30 min'; }
    else { o.eta = '15–20 min'; o.callback = false; }
    return o;
  }
  return [
    // ===== St Mary's Road =====
    mk('stmarys', "St Mary's Road", 'Collection', 'PENDING',  { name: 'Sarah K.', phone: '07811240661' }, 3, [['smash:1', 2], ['fries:0', 1]]),
    mk('stmarys', "St Mary's Road", 'Delivery',   'COOKING',  { name: 'Yusuf A.', phone: '07700118245', address: '12 Sharrow Lane', postcode: 'S11 8AB' }, 9, [['steaks:0', 1], ['shakes:1', 1]], { driverId: 'u_stm_d1' }),
    mk('stmarys', "St Mary's Road", 'Collection', 'READY',    { name: 'Leah M.', phone: '07533902117' }, 15, [['smash:2', 1]]),
    mk('stmarys', "St Mary's Road", 'Delivery',   'OUT_FOR_DELIVERY', { name: 'Imran S.', phone: '07458661203', address: '4 Ecclesall Road', postcode: 'S11 8PG' }, 22, [['smash:3', 3]], { driverId: 'u_stm_d2' }),
    mk('stmarys', "St Mary's Road", 'Collection', 'COMPLETED',{ name: 'Aisha R.', phone: '07900112233' }, 38, [['chicken:3', 1], ['shakes:0', 1]], { completedAt: iso(18) }),
    mk('stmarys', "St Mary's Road", 'Delivery',   'COMPLETED',{ name: 'Daniel P.', phone: '07901445566', address: '7 Hunters Bar', postcode: 'S11 8TG' }, 55, [['steaks:0', 2], ['smash:1', 1]], { driverId: 'u_stm_d2', completedAt: iso(35) }),
    // ===== Infirmary Road =====
    mk('infirmary', 'Infirmary Road', 'Collection', 'PENDING',  { name: 'Tom B.', phone: '07912334109' }, 2, [['smash:3', 1], ['sides:1', 1]]),
    mk('infirmary', 'Infirmary Road', 'Delivery',   'PENDING',  { name: 'Fatima Z.', phone: '07845770612', address: '88 Firth Park Road', postcode: 'S5 6HG', eta: '30–45 min' }, 5, [['chicken:0', 2], ['fries:1', 1]]),
    mk('infirmary', 'Infirmary Road', 'Collection', 'ACCEPTED', { name: 'Jack W.', phone: '07401558823' }, 11, [['steaks:2', 1], ['sides:2', 1]]),
    mk('infirmary', 'Infirmary Road', 'Collection', 'READY',    { name: 'Noah K.', phone: '07733210984' }, 16, [['smash:0', 1]]),
    mk('infirmary', 'Infirmary Road', 'Delivery',   'COMPLETED',{ name: 'Priya N.', phone: '07811556677', address: '15 Page Hall', postcode: 'S4 7AB', eta: '30–45 min' }, 46, [['smash:2', 2]], { driverId: 'u_inf_d1', completedAt: iso(25) }),
    mk('infirmary', 'Infirmary Road', 'Collection', 'COMPLETED',{ name: 'Mo F.', phone: '07822667788' }, 60, [['chicken:2', 1], ['shakes:1', 1]], { completedAt: iso(40) })
  ];
}

function freshDb() {
  return { version: 2, users: seedUsers(), orders: seedOrders(), notifications: [], counters: { order: 1100 } };
}

let db = null;

function load() {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    // make sure newer fields exist if an old file is loaded
    db.notifications = db.notifications || [];
    db.counters = db.counters || { order: 1000 };
    if (!db.users || !db.users.length) db.users = seedUsers();
    // backfill the store dimension on pre-separation records (keeps old data usable)
    db.users.forEach(u => { if (u.store === undefined) u.store = (u.role === 'owner' ? null : 'infirmary'); });
    db.orders.forEach(o => { if (!o.store) o.store = S.storeIdFromBranch(o.branch) || 'infirmary'; });
  } catch (e) {
    db = freshDb();
    save();
  }
  return db;
}

let saveTimer = null;
function save() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, FILE);          // atomic replace
  } catch (e) {
    console.error('[db] save failed:', e.message);
  }
}
/* coalesce rapid writes but never lose the final state */
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, 50);
}

load();

module.exports = {
  data: () => db,
  users: () => db.users,
  orders: () => db.orders,
  notifications: () => db.notifications,
  nextOrderNo: () => (++db.counters.order),
  save, saveSoon,
  /* convenience accessors */
  findUser: (pred) => db.users.find(pred),
  findOrder: (id) => db.orders.find(o => o.id === id),
  addOrder: (o) => { db.orders.unshift(o); saveSoon(); return o; },
  addNotification: (n) => { db.notifications.unshift(n); if (db.notifications.length > 200) db.notifications.length = 200; saveSoon(); return n; }
};
