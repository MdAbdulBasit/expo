'use strict';
/* ============================================================================
   Persistence for manager accounts + the audit log (file-backed JSON).
   Only password HASHES are stored (scrypt). No plaintext secrets on disk.
   For production move this to your DB with at-rest encryption + row-level
   security — the accessor surface below stays the same.
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const S = require('../shared.cjs');

const DIR = path.join(__dirname, 'data');
const FILE = path.join(DIR, 'managers.json');

function seed() {
  const mk = (id, name, email, role, storeId, pw) => {
    const h = S.hashSecret(pw);
    return { id, name, email: email.toLowerCase(), role, storeId: storeId || null, salt: h.salt, hash: h.hash, active: true, createdAt: new Date().toISOString() };
  };
  const mp = S.hashSecret('246810');   // default Master Security PIN — owner should change it
  return {
    managers: [
      mk('m_owner', 'Head Office Owner', 'owner@harlemhouse.co.uk', 'owner', null, 'Harlem#2026'),
      mk('m_senior', 'Senior Manager', 'senior@harlemhouse.co.uk', 'senior_manager', null, 'Senior#2026'),
      mk('m_store', 'Infirmary Store Manager', 'infirmary@harlemhouse.co.uk', 'store_manager', 'infirmary', 'Store#2026'),
      mk('m_analyst', 'Data Analyst', 'analyst@harlemhouse.co.uk', 'read_only_analyst', null, 'Analyst#2026')
    ],
    audit: [],
    master: { salt: mp.salt, hash: mp.hash }
  };
}

let db = null;
function load() {
  if (db) return db;
  try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); db.audit = db.audit || []; if (!db.managers || !db.managers.length) db.managers = seed().managers; if (!db.master) { const mp = S.hashSecret('246810'); db.master = { salt: mp.salt, hash: mp.hash }; save(); } }
  catch (e) { db = seed(); save(); }
  return db;
}
let timer = null;
function save() {
  try { fs.mkdirSync(DIR, { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 }); fs.renameSync(tmp, FILE); }
  catch (e) { console.error('[manager-store] save failed:', e.message); }
}
function saveSoon() { if (timer) return; timer = setTimeout(function () { timer = null; save(); }, 50); }
load();

function publicManager(m) { return { id: m.id, name: m.name, email: m.email, role: m.role, storeId: m.storeId, active: m.active, createdAt: m.createdAt, lastLogin: m.lastLogin || null }; }

function addAudit(entry) {
  db.audit.unshift(Object.assign({ at: new Date().toISOString() }, entry));
  if (db.audit.length > 1000) db.audit.length = 1000;
  saveSoon();
}

function verifyMaster(pin) { return !!(db.master && S.verifySecret(pin, db.master.salt, db.master.hash)); }
function setMaster(pin) { const h = S.hashSecret(pin); db.master = { salt: h.salt, hash: h.hash }; save(); }

module.exports = {
  managers: () => db.managers,
  audit: () => db.audit,
  findByEmail: (email) => db.managers.find(m => m.email === String(email || '').toLowerCase()),
  findById: (id) => db.managers.find(m => m.id === id),
  publicManager, addAudit, save, saveSoon,
  verifyMaster, setMaster
};
