# Harlem House — Manager / Owner Dashboard

A standalone, secured web app for managers and owners to see everything that
flows across **both stores**. It reads all business data from the **Presto POS
integration seam** (`pos-source.cjs`) — swap that one module for real Presto API
calls and the whole dashboard keeps working unchanged.

> This is separate from the customer website and the staff order portals. It does
> **not** include a vendor POS or delivery page — Presto handles those. Customer
> website orders flow into Presto directly; this dashboard reads back the data.

---

## 1. Run it

```bash
node demo/manager/server.cjs
```

Open **http://localhost:4500/** and sign in.

| Role | Email | Password | What they get |
|------|-------|----------|----------------|
| **Owner** | `owner@harlemhouse.co.uk` | `Harlem#2026` | Everything + manage managers + audit log |
| **Senior Manager** | `senior@harlemhouse.co.uk` | `Senior#2026` | Both stores, all analytics — no account admin |
| **Store Manager** | `infirmary@harlemhouse.co.uk` | `Store#2026` | **Infirmary Road only**, no comparison |
| **Read-Only Analyst** | `analyst@harlemhouse.co.uk` | `Analyst#2026` | View-only, **customer contact details masked** |

> Demo accounts are shown on the login page (tap to fill).

---

## 2. What's inside (left sidebar)

- **Dashboard Overview** — header store selector + revenue snapshot for Today / Week / Month / Year + revenue trend chart + a live-orders card (ref, customer, value, status, time, "View full details") + top items
- **Live Orders** — orders currently in progress (ref, store, customer, status, payment, type, value, time) + Receipt
- **Order Logs** — full history with **search, status filter, date range, pagination** + Receipt on every row
- **Analytics & Reports** *(merged)* — daily/weekly/monthly/yearly revenue, total orders, avg order value, avg daily/weekly/monthly orders + revenue (area) and order-volume (bar) charts, switchable Daily/Weekly/Monthly/Yearly
- **Customer & Product Insights** *(merged)* — *Customer analytics* (name, phone, email, orders, spend, last order — PII masked for analysts) and *Product analytics* (top sellers ranked by units + revenue)
- **Transactions** — full payment ledger: txn ID, order ref, store, method (Card / Cash / Apple Pay / Google Pay), status, amount, time (no method-mix widget)
- **Store Comparison** — both stores head-to-head: multi-line revenue trend, revenue/orders bar charts and per-store cards with a "who's leading" insight (Daily/Weekly/Monthly/Yearly)
- **Manager Accounts** *(owner)* — add / edit / disable / delete managers, assign roles — **every change requires the Master Security PIN**
- **Settings** — your access summary + security/session info + (owner) audit log & Change Master PIN
- **Support** — company contact + a dedicated **IT Support Team** box (phone/email placeholders for now)

Every numeric figure is shown **both as a number and on a chart**. There's a
**store selector** in the header (Both stores / each store), a **Refresh** button,
and the dashboard also **auto-refreshes hourly**. **Receipts** open in a modal with
a full breakdown and **Print / Download**.

---

## 3. Roles & permissions (enforced server-side)

| Capability | Owner | Senior Mgr | Store Mgr | Analyst |
|------------|:--:|:--:|:--:|:--:|
| View analytics / orders / transactions | ✅ | ✅ | ✅ (own store) | ✅ |
| See both stores + comparison | ✅ | ✅ | ❌ (locked to store) | ✅ |
| See customer phone/email | ✅ | ✅ | ✅ | ❌ (masked) |
| Manage manager accounts | ✅ | ❌ | ❌ | ❌ |
| View audit log | ✅ | ❌ | ❌ | ❌ |

A Store Manager is **hard-locked** to their store on the server — requesting
another store just returns their own. Analysts get masked PII even in API
responses. The UI hides what a role can't use, **and** the server rejects it.

---

## 4. Security posture

- **Auth** — email + **strong password** (≥10 chars, upper/lower/digit/symbol), hashed with **scrypt**.
- **Sessions** — server-side, keyed by an **HttpOnly, SameSite=Strict** cookie; **idle (30 min) + absolute (8 h) expiry**.
- **CSRF** — every mutating request must carry the session's CSRF token (verified `403` without it).
- **RBAC** — role + per-store scoping + PII masking, checked on every endpoint.
- **API** — per-IP **rate limiting** (login brute-force limited separately), JSON-only, body-size caps, strict request validation.
- **Audit log** — logins (incl. failures), logouts, manager CRUD, and customer/receipt PII access are recorded with who/when/IP (Owner can view under Settings).
- **Headers** — `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, plus a strict CSP on every page. No third-party scripts.
- **Least exposure** — only hashed passwords are stored on disk; the server never serves its own `.cjs`/data files.

**For production** (high priority): serve over **HTTPS** and set `HH_SECURE_COOKIE=1`
so the session cookie gets the `Secure` flag; move accounts/audit to a managed DB
with **at-rest encryption** + row-level security; keep all POS API keys server-side.

---

## 5. Presto integration

`pos-source.cjs` is the single integration point. Each query function
(`liveOrders`, `orderLogs`, `revenue`, `topItems`, `transactions`, `customers`,
`compare`, `findOrder`) currently returns synthesised two-store data; in
production each calls the corresponding **Presto endpoint** for the requested
store and normalises the result. Nothing else in the dashboard changes.

The same integration layer is what the customer website uses to push orders into
Presto, so all numbers stay consistent across both stores.

---

## 6. Files

| File | Role |
|------|------|
| `server.cjs` | dashboard backend: auth, RBAC, all endpoints, security headers, audit |
| `pos-source.cjs` | **Presto seam** — two-store data + all query functions |
| `auth.cjs` | sessions, cookies, CSRF, password policy, roles, PII masking |
| `store.cjs` | manager accounts + audit log (persisted, hashed passwords) |
| `login.html` · `manager.html` | the dashboard UI (Harlem House theme) |
| `data/managers.json` | saved manager accounts + audit (delete to reseed demo accounts) |

Reset the manager accounts/audit any time by stopping the server and deleting
`demo/manager/data/managers.json`.

Config via env: `HH_MANAGER_PORT` (default 4500), `HH_SECURE_COOKIE=1` (behind TLS).
