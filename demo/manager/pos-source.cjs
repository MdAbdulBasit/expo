'use strict';
/* ============================================================================
   POS DATA SOURCE  —  the Presto integration seam.

   In production this module is the ONLY place that talks to Presto's API:
   each query function below would call the corresponding Presto endpoint
   (orders, transactions, products, customers) for the requested store and
   normalise the response into the shapes the dashboard expects.

   For the demo it synthesises a realistic, deterministic ~14-month history for
   BOTH stores (anchored to today's date) plus a handful of live/active orders,
   so every Daily / Weekly / Monthly / Yearly view and the store comparison are
   populated. Replace the generator with real Presto calls and nothing else in
   the dashboard has to change.
   ============================================================================ */
const S = require('../shared.cjs');

const STORES = [
  { id: 'infirmary', name: 'Infirmary Road', postcode: 'S6 3DH' },
  { id: 'st-marys', name: "St Mary's Road", postcode: 'S2 4AX' }
];
const PAYMENT_METHODS = ['card', 'cash', 'apple_pay', 'google_pay'];
const PAYMENT_LABEL = { card: 'Card', cash: 'Cash', apple_pay: 'Apple Pay', google_pay: 'Google Pay' };

const PRODUCTS = Object.keys(S.CATALOG).map(function (id) { return { id: id, name: S.CATALOG[id].name, price: S.CATALOG[id].price }; });

/* deterministic PRNG so the dataset is stable within a run */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function round2(n) { return Math.round(n * 100) / 100; }

const FIRST = ['Aisha', 'Omar', 'Layla', 'Yusuf', 'Sara', 'Bilal', 'Hana', 'Zaid', 'Maryam', 'Imran', 'Noor', 'Adam', 'Fatima', 'Hassan', 'Sofia', 'Musa', 'Amir', 'Zara', 'Tariq', 'Leila', 'Karim', 'Nadia', 'Samir', 'Yasmin', 'Idris', 'Rania', 'Faisal', 'Dania', 'Hamza', 'Iman'];
const LAST = ['Khan', 'Ali', 'Ahmed', 'Hussain', 'Patel', 'Begum', 'Malik', 'Iqbal', 'Shah', 'Rahman', 'Aziz', 'Mahmood', 'Saeed', 'Younis', 'Bashir', 'Akhtar', ' Part', 'Hashmi', 'Ghani', 'Rizvi'];

let DATA = null;

function build() {
  const rng = mulberry32(20260621);
  const now = new Date();
  const customers = [];
  const nCust = 260;
  for (let i = 0; i < nCust; i++) {
    const fn = pick(rng, FIRST), ln = pick(rng, LAST);
    const phone = '07' + String(Math.floor(rng() * 900000000) + 100000000);
    customers.push({
      id: 'c_' + i,
      name: fn + ' ' + ln,
      phone: phone,
      email: (fn + '.' + ln).toLowerCase().replace(/[^a-z.]/g, '') + '@example.com'
    });
  }

  const orders = [];
  let seq = 5000;
  const start = new Date(now); start.setMonth(start.getMonth() - 14); start.setHours(0, 0, 0, 0);
  const msDay = 86400000;

  for (let t = start.getTime(); t <= now.getTime(); t += msDay) {
    const day = new Date(t);
    const dow = day.getDay();                       // 0 Sun .. 6 Sat
    const weekendBoost = (dow === 5 || dow === 6) ? 1.5 : (dow === 0 ? 1.2 : 1);
    STORES.forEach(function (store, si) {
      // St Mary's slightly busier in this dataset, to make comparison interesting
      const storeFactor = si === 1 ? 1.18 : 1;
      const base = 16 * weekendBoost * storeFactor;
      const count = Math.max(2, Math.round(base * (0.7 + rng() * 0.6)));
      for (let k = 0; k < count; k++) {
        // opening hours ~ 12:00–23:59 (Fri from 15:00); minutes from midnight
        const openMin = (dow === 5) ? 900 : 720;
        const mins = openMin + Math.floor(rng() * (1439 - openMin));
        const placed = new Date(day); placed.setHours(0, mins, Math.floor(rng() * 60), 0);
        if (placed.getTime() > now.getTime()) continue;

        const cust = customers[Math.floor(rng() * customers.length)];
        const lines = 1 + Math.floor(rng() * 4);
        const items = []; let subtotal = 0;
        for (let li = 0; li < lines; li++) {
          const p = pick(rng, PRODUCTS); const qty = 1 + Math.floor(rng() * 3);
          const lineTotal = round2(p.price * qty); subtotal = round2(subtotal + lineTotal);
          items.push({ id: p.id, name: p.name, price: p.price, qty: qty, lineTotal: lineTotal });
        }
        const mode = rng() < 0.55 ? 'Collection' : 'Delivery';
        const method = (function () { const r = rng(); return r < 0.5 ? 'card' : r < 0.66 ? 'cash' : r < 0.85 ? 'apple_pay' : 'google_pay'; })();
        const cancelled = rng() < 0.05;
        const order = {
          id: 'o_' + (seq), ref: 'HH-' + (seq++),
          store: store.id,
          placedAt: placed.toISOString(),
          mode: mode,
          status: cancelled ? 'CANCELLED' : 'COMPLETED',
          items: items,
          subtotal: subtotal,
          customerId: cust.id,
          customer: { name: cust.name, phone: cust.phone, email: cust.email },
          payment: {
            method: method,
            status: cancelled ? 'refunded' : 'paid',
            txnId: 'txn_' + method.slice(0, 2) + (1000000 + Math.floor(rng() * 8999999)),
            amount: subtotal,
            last4: (method === 'card' || method === 'apple_pay' || method === 'google_pay') ? String(1000 + Math.floor(rng() * 8999)) : null
          }
        };
        orders.push(order);
      }
    });
  }

  // live / active orders for "now" (last ~75 min), a few per store
  const ACTIVE = ['PENDING', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY'];
  STORES.forEach(function (store) {
    const n = 3 + Math.floor(rng() * 5);
    for (let k = 0; k < n; k++) {
      const placed = new Date(now.getTime() - Math.floor(rng() * 75 * 60000));
      const cust = customers[Math.floor(rng() * customers.length)];
      const lines = 1 + Math.floor(rng() * 3); const items = []; let subtotal = 0;
      for (let li = 0; li < lines; li++) { const p = pick(rng, PRODUCTS); const qty = 1 + Math.floor(rng() * 2); const lt = round2(p.price * qty); subtotal = round2(subtotal + lt); items.push({ id: p.id, name: p.name, price: p.price, qty: qty, lineTotal: lt }); }
      const mode = rng() < 0.55 ? 'Collection' : 'Delivery';
      const method = pick(rng, PAYMENT_METHODS);
      const paid = method !== 'cash';
      orders.push({
        id: 'o_' + (seq), ref: 'HH-' + (seq++), store: store.id, placedAt: placed.toISOString(),
        mode: mode, status: ACTIVE[Math.floor(rng() * ACTIVE.length)], items: items, subtotal: subtotal,
        customerId: cust.id, customer: { name: cust.name, phone: cust.phone, email: cust.email },
        payment: { method: method, status: paid ? 'paid' : 'unpaid', txnId: 'txn_' + (1000000 + Math.floor(rng() * 8999999)), amount: subtotal, last4: paid && method !== 'cash' ? String(1000 + Math.floor(rng() * 8999)) : null }
      });
    }
  });

  orders.sort(function (a, b) { return new Date(b.placedAt) - new Date(a.placedAt); });
  DATA = { orders: orders, customers: customers, generatedAt: now.toISOString() };
  return DATA;
}
function data() { return DATA || build(); }

/* ---- period helpers (anchored to now) -------------------------------------- */
function periodStart(period, now) {
  now = now || new Date();
  const d = new Date(now);
  if (period === 'day') { d.setHours(0, 0, 0, 0); return d; }
  if (period === 'week') { const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); d.setHours(0, 0, 0, 0); return d; } // Monday start
  if (period === 'month') { d.setDate(1); d.setHours(0, 0, 0, 0); return d; }
  if (period === 'year') { d.setMonth(0, 1); d.setHours(0, 0, 0, 0); return d; }
  return new Date(0);
}
function isCompleted(o) { return o.status === 'COMPLETED'; }
function isActive(o) { return ['PENDING', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY'].indexOf(o.status) > -1; }

function byStore(list, store) { return (store && store !== 'all') ? list.filter(function (o) { return o.store === store; }) : list; }

/* ---- queries (what the dashboard calls) ------------------------------------ */
function liveOrders(store) {
  return byStore(data().orders, store).filter(isActive).sort(function (a, b) { return new Date(b.placedAt) - new Date(a.placedAt); });
}

function orderLogs(opts) {
  opts = opts || {};
  let list = byStore(data().orders, opts.store);
  if (opts.status && opts.status !== 'all') list = list.filter(function (o) { return o.status === opts.status; });
  if (opts.from) { const f = new Date(opts.from).getTime(); list = list.filter(function (o) { return new Date(o.placedAt).getTime() >= f; }); }
  if (opts.to) { const tt = new Date(opts.to).getTime() + 86400000; list = list.filter(function (o) { return new Date(o.placedAt).getTime() < tt; }); }
  if (opts.q) {
    const q = String(opts.q).toLowerCase();
    list = list.filter(function (o) { return o.ref.toLowerCase().indexOf(q) > -1 || o.customer.name.toLowerCase().indexOf(q) > -1 || o.customer.phone.indexOf(q) > -1; });
  }
  const total = list.length;
  const page = Math.max(1, opts.page || 1), size = Math.min(100, opts.size || 20);
  const slice = list.slice((page - 1) * size, page * size);
  return { total: total, page: page, size: size, pages: Math.ceil(total / size) || 1, orders: slice };
}

function revenue(store, period) {
  const now = new Date();
  const startNow = periodStart(period, now);
  const list = byStore(data().orders, store).filter(isCompleted);
  const inNow = list.filter(function (o) { return new Date(o.placedAt) >= startNow; });
  const sum = function (arr) { return round2(arr.reduce(function (s, o) { return s + o.subtotal; }, 0)); };
  // headline metrics across standard windows
  const windows = ['day', 'week', 'month', 'year'].reduce(function (acc, p) {
    const s = periodStart(p, now); const a = list.filter(function (o) { return new Date(o.placedAt) >= s; });
    acc[p] = { revenue: sum(a), orders: a.length, avg: a.length ? round2(sum(a) / a.length) : 0 };
    return acc;
  }, {});
  // trend buckets for the selected period
  const buckets = trend(inNow, period, now);
  return {
    period: period,
    selected: { revenue: sum(inNow), orders: inNow.length, avg: inNow.length ? round2(sum(inNow) / inNow.length) : 0 },
    windows: windows,
    trend: buckets,
    avgDailyOrders: avgPerUnit(list, 'day', now),
    avgWeeklyOrders: avgPerUnit(list, 'week', now),
    avgMonthlyOrders: avgPerUnit(list, 'month', now)
  };
}

function trend(list, period, now) {
  // returns [{label, revenue, orders}] across the selected period
  const out = [];
  function add(label, from, to) { const a = list.filter(function (o) { const t = new Date(o.placedAt).getTime(); return t >= from && t < to; }); out.push({ label: label, revenue: round2(a.reduce(function (s, o) { return s + o.subtotal; }, 0)), orders: a.length }); }
  if (period === 'day') {
    const base = periodStart('day', now);
    for (let h = 11; h <= 23; h++) { const f = new Date(base); f.setHours(h); add(String(h).padStart(2, '0'), f.getTime(), f.getTime() + 3600000); }
  } else if (period === 'week') {
    const base = periodStart('week', now); const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    for (let i = 0; i < 7; i++) { const f = new Date(base); f.setDate(base.getDate() + i); add(names[i], f.getTime(), f.getTime() + 86400000); }
  } else if (period === 'month') {
    const base = periodStart('month', now); const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    for (let i = 1; i <= days; i++) { const f = new Date(base); f.setDate(i); add(String(i), f.getTime(), f.getTime() + 86400000); }
  } else { // year
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    for (let m = 0; m <= now.getMonth(); m++) { const f = new Date(now.getFullYear(), m, 1); const to = new Date(now.getFullYear(), m + 1, 1); add(names[m], f.getTime(), to.getTime()); }
  }
  return out;
}

function avgPerUnit(list, unit, now) {
  // average completed orders per day/week/month over the last ~90 days
  const since = new Date(now.getTime() - 90 * 86400000);
  const a = list.filter(function (o) { return new Date(o.placedAt) >= since; });
  const units = unit === 'day' ? 90 : unit === 'week' ? 90 / 7 : 3;
  return Math.round(a.length / units);
}

function topItems(store, period, limit) {
  const start = periodStart(period, new Date());
  const list = byStore(data().orders, store).filter(isCompleted).filter(function (o) { return new Date(o.placedAt) >= start; });
  const agg = {};
  list.forEach(function (o) { o.items.forEach(function (it) { const k = it.name; if (!agg[k]) agg[k] = { name: k, qty: 0, revenue: 0 }; agg[k].qty += it.qty; agg[k].revenue = round2(agg[k].revenue + it.lineTotal); }); });
  return Object.keys(agg).map(function (k) { return agg[k]; }).sort(function (a, b) { return b.qty - a.qty; }).slice(0, limit || 10);
}

function transactions(opts) {
  opts = opts || {};
  let list = byStore(data().orders, opts.store);
  if (opts.method && opts.method !== 'all') list = list.filter(function (o) { return o.payment.method === opts.method; });
  if (opts.q) { const q = String(opts.q).toLowerCase(); list = list.filter(function (o) { return o.payment.txnId.toLowerCase().indexOf(q) > -1 || o.ref.toLowerCase().indexOf(q) > -1; }); }
  const total = list.length; const page = Math.max(1, opts.page || 1), size = Math.min(100, opts.size || 20);
  const slice = list.slice((page - 1) * size, page * size).map(function (o) {
    return { ref: o.ref, store: o.store, at: o.placedAt, txnId: o.payment.txnId, method: o.payment.method, methodLabel: PAYMENT_LABEL[o.payment.method], status: o.payment.status, amount: o.payment.amount, last4: o.payment.last4 };
  });
  // method breakdown for the (store-filtered) set
  const breakdown = {};
  byStore(data().orders, opts.store).filter(isCompleted).forEach(function (o) { breakdown[o.payment.method] = (breakdown[o.payment.method] || 0) + 1; });
  return { total: total, page: page, size: size, pages: Math.ceil(total / size) || 1, transactions: slice, breakdown: breakdown };
}

function findOrder(id) { return data().orders.find(function (o) { return o.id === id || o.ref === id; }) || null; }

function customers(opts) {
  opts = opts || {};
  // aggregate per customer from (store-filtered) completed+active orders
  const list = byStore(data().orders, opts.store);
  const agg = {};
  list.forEach(function (o) {
    const c = agg[o.customerId] || (agg[o.customerId] = { id: o.customerId, name: o.customer.name, phone: o.customer.phone, email: o.customer.email, orders: 0, spend: 0, last: null });
    if (o.status !== 'CANCELLED') { c.orders++; c.spend = round2(c.spend + o.subtotal); }
    if (!c.last || new Date(o.placedAt) > new Date(c.last)) c.last = o.placedAt;
  });
  let arr = Object.keys(agg).map(function (k) { return agg[k]; });
  if (opts.q) { const q = String(opts.q).toLowerCase(); arr = arr.filter(function (c) { return c.name.toLowerCase().indexOf(q) > -1 || c.phone.indexOf(q) > -1 || c.email.toLowerCase().indexOf(q) > -1; }); }
  arr.sort(function (a, b) { return b.spend - a.spend; });
  const total = arr.length; const page = Math.max(1, opts.page || 1), size = Math.min(100, opts.size || 20);
  return { total: total, page: page, size: size, pages: Math.ceil(total / size) || 1, customers: arr.slice((page - 1) * size, page * size) };
}

function compare(period) {
  const now = new Date();
  return STORES.map(function (s) {
    const rev = revenue(s.id, period);
    const top = topItems(s.id, period, 3);
    return { store: s.id, name: s.name, revenue: rev.selected.revenue, orders: rev.selected.orders, avg: rev.selected.avg, trend: rev.trend, topItems: top };
  });
}

function overview(store, period) {
  const rev = revenue(store, period);
  const live = liveOrders(store);
  const top = topItems(store, period, 5);
  return { period: period, store: store, selected: rev.selected, windows: rev.windows, trend: rev.trend, liveCount: live.length, topItems: top };
}

module.exports = {
  STORES, PAYMENT_METHODS, PAYMENT_LABEL,
  liveOrders, orderLogs, revenue, topItems, transactions, customers, compare, overview, findOrder,
  rebuild: build
};
