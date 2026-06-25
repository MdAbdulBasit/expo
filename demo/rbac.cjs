'use strict';
/* ============================================================================
   Roles, sessions, the order status state machine, and driver auto-assign.
   ============================================================================ */
const S = require('./shared.cjs');
const db = require('./db.cjs');

/* ---- sessions (in-memory; staff just log in again after a restart) --------- */
const SESSIONS = new Map();            // token -> { userId, role, name, exp }
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8h

function login(username, pin) {
  const u = db.findUser(x => x.username === String(username || '').toLowerCase() && x.active);
  if (!u || !S.verifySecret(pin, u.salt, u.hash)) return null;
  const token = S.randomToken(24);
  SESSIONS.set(token, { userId: u.id, role: u.role, name: u.name, store: u.store, exp: Date.now() + SESSION_TTL });
  return { token, user: publicUser(u) };
}
function sessionFrom(token) {
  const s = SESSIONS.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) { SESSIONS.delete(token); return null; }
  return s;
}
function logout(token) { SESSIONS.delete(token); }
function publicUser(u) { return { id: u.id, name: u.name, username: u.username, role: u.role, store: u.store, active: u.active }; }

/* ---- status state machine -------------------------------------------------- */
const STATUSES = ['PENDING', 'ACCEPTED', 'COOKING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'COMPLETED', 'REJECTED'];

// allowed next statuses from each status (a delivery order goes via OUT_FOR_DELIVERY;
// a collection order goes READY -> COMPLETED on hand-over)
const FLOW = {
  PENDING:          ['ACCEPTED', 'REJECTED'],
  ACCEPTED:         ['COOKING', 'REJECTED'],
  COOKING:          ['READY'],
  READY:            ['OUT_FOR_DELIVERY', 'COMPLETED'],
  OUT_FOR_DELIVERY: ['DELIVERED'],
  DELIVERED:        ['COMPLETED'],
  COMPLETED:        [],
  REJECTED:         []
};

// which target statuses each role may set (owner = master = all)
const ROLE_CAN_SET = {
  owner:    'ALL',
  vendor:   { ACCEPTED: 1, REJECTED: 1, COOKING: 1, READY: 1, COMPLETED: 1 },
  delivery: { OUT_FOR_DELIVERY: 1, DELIVERED: 1, COMPLETED: 1 }
};

const ACTIVE = ['PENDING', 'ACCEPTED', 'COOKING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED'];
const TERMINAL = ['COMPLETED', 'REJECTED'];

function isActive(status) { return ACTIVE.indexOf(status) > -1; }

/* validate a transition for a given role + order. Returns {ok} or {ok:false,error} */
function canTransition(role, order, to) {
  if (STATUSES.indexOf(to) < 0) return fail('Unknown status.');
  if (!(FLOW[order.status] || []).includes(to)) return fail('Cannot go from ' + order.status + ' to ' + to + '.');
  const rule = ROLE_CAN_SET[role];
  if (rule !== 'ALL' && !(rule && rule[to])) return fail('Your role cannot set ' + to + '.');
  // a collection order never goes out for delivery
  if (to === 'OUT_FOR_DELIVERY' && order.mode !== 'Delivery') return fail('Collection orders are not delivered.');
  // delivery actions require a driver to be on the order
  if (to === 'OUT_FOR_DELIVERY' && !order.driverId) return fail('Assign a driver first.');
  return { ok: true };
  function fail(error) { return { ok: false, error: error }; }
}

/* store isolation: a vendor may only act on their OWN store's orders; delivery
   drivers only on their own assigned jobs; owner (master) overrides everything. */
function canActOnOrder(session, order) {
  if (session.role === 'owner') return true;
  if (session.role === 'vendor') return order.store === session.store;
  if (session.role === 'delivery') return order.driverId === session.userId;
  return false;
}

/* ---- driver auto-assign: least-busy active driver IN THE SAME STORE --------- */
function activeDriverLoad(store) {
  const load = {};
  db.users().forEach(u => { if (u.role === 'delivery' && u.active && u.store === store) load[u.id] = 0; });
  db.orders().forEach(o => {
    if (o.driverId && load[o.driverId] != null && isActive(o.status)) load[o.driverId]++;
  });
  return load;
}
function pickDriver(store) {
  const load = activeDriverLoad(store);
  const ids = Object.keys(load);
  if (!ids.length) return null;
  ids.sort((a, b) => load[a] - load[b]);   // fewest active deliveries first
  return ids[0];
}

module.exports = {
  login, logout, sessionFrom, publicUser,
  STATUSES, FLOW, ROLE_CAN_SET, ACTIVE, TERMINAL, isActive,
  canTransition, canActOnOrder, pickDriver
};
