'use strict';
/* ============================================================================
   DEMO payment provider — shaped like Stripe/Dojo so the real one drops in.

   Real integration later (server side, secret key NEVER in the browser):
     Stripe:  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
              const intent = await stripe.paymentIntents.create({ amount, currency:'gbp',
                 metadata:{ orderRef } });
              // browser confirms with intent.client_secret via Stripe.js / Elements
              // confirm server-side via webhook (payment_intent.succeeded)
     Dojo:    create a payment session via Dojo API, redirect/confirm, verify webhook.

   This demo simulates that handshake and always succeeds. No real charge.
   ============================================================================ */
const crypto = require('crypto');

const PROVIDER = process.env.HH_PAYMENTS || 'demo';   // 'demo' | (future) 'stripe' | 'dojo'
const intents = new Map();                            // intentId -> { orderId, amount, status }

/* amount in minor units (pence), like Stripe */
function createIntent(order) {
  const id = 'pi_demo_' + crypto.randomBytes(8).toString('hex');
  const amount = Math.round(order.subtotal * 100);
  const rec = {
    id,
    orderId: order.id,
    orderRef: order.ref,
    amount,
    currency: 'gbp',
    status: 'requires_confirmation',
    clientSecret: id + '_secret_' + crypto.randomBytes(6).toString('hex'),
    provider: PROVIDER,
    createdAt: new Date().toISOString()
  };
  intents.set(id, rec);
  // what the browser needs (never expose secrets beyond the client_secret)
  return { id: rec.id, clientSecret: rec.clientSecret, amount: rec.amount, currency: rec.currency, provider: PROVIDER };
}

/* confirm — in the demo this always succeeds; a real provider confirms via
   client_secret + a webhook we'd verify before marking the order paid. */
function confirmIntent(intentId, clientSecret) {
  const rec = intents.get(intentId);
  if (!rec) return { ok: false, error: 'Unknown payment.' };
  if (rec.clientSecret !== clientSecret) return { ok: false, error: 'Bad client secret.' };
  if (rec.status === 'succeeded') return { ok: true, payment: receipt(rec) };
  rec.status = 'succeeded';
  rec.confirmedAt = new Date().toISOString();
  return { ok: true, payment: receipt(rec) };
}

function receipt(rec) {
  return {
    provider: rec.provider,
    intentId: rec.id,
    amount: rec.amount,
    currency: rec.currency,
    status: rec.status,
    last4: '4242',                 // demo card
    paidAt: rec.confirmedAt || new Date().toISOString()
  };
}

module.exports = { PROVIDER, createIntent, confirmIntent };
