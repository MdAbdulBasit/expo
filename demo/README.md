# Harlem House — Order Workflow Demo

A working, end-to-end test of the **whole order lifecycle** across four roles
(customer → vendor → delivery → owner) before the real system is built.

It is **dependency-free Node** (built-ins only, no `npm install`) and stores
data in a local JSON file so everything **persists across logout/login and
restarts** — that was the bug in the old dashboard (status lived only in the
browser, so it reverted). It's structured so swapping the storage layer for
**Supabase** later is a contained change (see `db.cjs`).

---

## 1. Run it

You need Node installed. From the project root:

```bash
node demo/server.cjs
```

That single server hosts everything on **http://localhost:4000**:

| Page | URL | Who |
|------|-----|-----|
| Customer storefront | http://localhost:4000/ | customers |
| Staff login | http://localhost:4000/login | all staff |
| Vendor (cashier) | http://localhost:4000/vendor | vendor + owner |
| Owner (manager) | http://localhost:4000/owner | owner only |
| Delivery (driver) | http://localhost:4000/delivery | delivery + owner |

**Demo staff logins** (also shown on the login page). Each store runs
**independently** — a store's vendor only ever sees that store's queue,
completed orders, drivers and revenue. The owner is master over both.

| Username | PIN | Role | Store |
|----------|-----|------|-------|
| `owner` | `1234` | Owner / Manager (master) | both |
| `ahmed` | `1111` | Vendor / Counter | St Mary's Road |
| `mohammed` | `1112` | Vendor / Counter | St Mary's Road |
| `omar` | `2221` | Vendor / Counter | Infirmary Road |
| `ibrahim` | `2222` | Vendor / Counter | Infirmary Road |

Drivers: `baran` / `azad` (St Mary's), `mustafa` / `kawa` (Infirmary).
Log in with a St Mary's account and you land on St Mary's; log in with an
Infirmary account and you land on Infirmary. Reset the demo any time by
stopping the server and deleting `demo/data/db.json`.

> Tip: open the storefront and the staff portals in **separate browser tabs**
> (or windows) so you can watch updates happen live across all of them.

---

## 2. Walk the full workflow (what to do)

1. **Customer** — on `/` add food → **Order now** → checkout → choose Collection
   or Delivery → **Place order**. On the confirmation you can **Pay by card
   (demo)** and watch the **Live status** tracker.
2. **Vendor** (`/vendor`, login `cashier/1111`) — the new order pops in instantly
   with a chime + a 🔔 notification (and a second notification when payment lands).
   **Accept** → **Start cooking** → **Mark ready**. For delivery orders a driver is
   **auto-assigned** on accept (least-busy); you can also re-assign manually.
3. **Delivery** (`/delivery`, login `driver1/2222`) — your assigned job appears.
   **Pick up · out for delivery** → **Mark delivered** → **Complete order**.
4. **Owner** (`/owner`, login `owner/1234`) — master view of all live orders, plus:
   - **Reports** — revenue/orders/avg for **Today / This month / This year**,
     revenue-over-time bars and top items.
   - **Staff & roles** — add staff, change roles, activate/deactivate, reset PIN.
5. **Prove persistence** — set an order to COOKING, **stop the server (Ctrl-C) and
   run it again**, or log out and back in: the status is still COOKING. ✅

A Collection order skips delivery (READY → Completed on hand-over). A Delivery
order goes READY → Out for delivery → Delivered → Completed.

---

## 3. Roles & permissions (enforced server-side)

| Action | Customer | Vendor | Delivery | Owner |
|--------|:--:|:--:|:--:|:--:|
| Place order, pay, track status | ✅ | | | |
| See order queue | | ✅ | own jobs | ✅ |
| Accept / reject | | ✅ | | ✅ |
| Cooking → Ready | | ✅ | | ✅ |
| Assign driver (auto + manual) | | ✅ | | ✅ |
| Out for delivery / Delivered / Completed | | | ✅ (own) | ✅ |
| Reports (day/month/year) | | | | ✅ |
| Manage staff & roles | | | | ✅ |

The **owner is master** — can do anything. **Vendor cannot** see reports or manage
staff. **Delivery** only sees and advances orders **assigned to them**. Every
restriction is checked on the server (the UI just reflects it), so it can't be
bypassed from the browser.

---

## 4. Status lifecycle (state machine)

```
PENDING ─accept→ ACCEPTED ─cook→ COOKING ─ready→ READY ┬─(delivery)→ OUT_FOR_DELIVERY → DELIVERED → COMPLETED
   └─reject→ REJECTED                                  └─(collection)──────────────────────────────→ COMPLETED
```
Completed/Rejected orders drop out of the active queues and feed the owner's
reports. Invalid jumps are rejected by the server.

---

## 5. Notifications & payments

- **Notifications** — the vendor (and owner) get a live event + 🔔 feed entry when
  an **order is placed** and when a **payment succeeds**. Realtime via SSE.
- **Payments** — `payments.cjs` is shaped like **Stripe/Dojo** (PaymentIntent →
  confirm). The demo always succeeds and takes no real money. To go live, drop the
  real SDK into `payments.cjs` and verify the provider's webhook server-side —
  the secret key stays on the server, never in the browser. Set `HH_PAYMENTS=stripe`
  when wired.

---

## 6. Security carried over

Server-side **re-pricing** (browser sends only `{id, qty}`), strict input
validation, per-IP **rate limiting**, body-size caps, login brute-force limit,
PINs hashed with **scrypt**, opaque session tokens, role checks on every endpoint,
output escaped in every portal, security headers. (Storefront keeps its CSP, XSS
escaping and hardened cart from the earlier pass.)

---

## 7. Going to production (next steps)

- **Storage:** replace `db.cjs` with **Supabase** (Postgres) — same accessor
  surface; add row-level security per role.
- **Transport:** serve over **HTTPS/TLS** + HSTS (tokens/SSE need it).
- **Auth:** swap PIN+bearer for proper login + **HttpOnly SameSite session
  cookies**; short-lived signed token for the SSE stream.
- **Payments:** real Stripe/Dojo keys + verified webhooks + idempotency.
- **Realtime/scale:** move SSE/notifications to Supabase Realtime or a broker;
  add an audit log and retry queue.

## 8. Files

| File | Role |
|------|------|
| `server.cjs` | the one backend: pages, order intake, RBAC API, SSE, reports |
| `db.cjs` | persistent JSON store (orders/users/notifications) — swap for Supabase |
| `rbac.cjs` | sessions, role permissions, status state machine, driver auto-assign |
| `payments.cjs` | demo Stripe/Dojo-shaped payment provider |
| `shared.cjs` | catalog (server prices), validation, rate-limit, hashing |
| `login.html · vendor.html · owner.html · delivery.html` | the four role portals |
| `data/db.json` | the saved data (delete it to reset the demo) |

Reset the demo any time by stopping the server and deleting `demo/data/db.json`.
