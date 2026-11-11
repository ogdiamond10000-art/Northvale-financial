'use strict';

/**
 * Stripe integration tests.
 *
 * Stripe's API is never called: webhook payloads are signed locally with the
 * configured signing secret, which is exactly what Stripe does in production.
 * These tests cover signature verification, idempotent crediting, quarantine of
 * mismatched payments, failed payments and the admin payments view.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'northvale-stripe-'));
process.env.DATA_DIR = tmpDir;
process.env.DATABASE_FILE = path.join(tmpDir, 'northvale.db');
process.env.SEED_DEMO_DATA = 'true';
process.env.NODE_ENV = 'test';
process.env.STRIPE_SECRET_KEY = 'sk_test_northvale_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_northvale_test';
process.env.STRIPE_TAX_ENABLED = 'true';

const app = require('../server/index.js');
const { db } = require('../server/db');
const { insertTransaction } = require('../server/services/ledger');

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const DEMO_EMAIL = 'alex.morgan@example.com';
const DEMO_PASSWORD = 'Northvale#2026';
const ADMIN_EMAIL = 'admin@northvale.com';
const ADMIN_PASSWORD = 'Admin#2026';
const DEMO_ACCOUNT_NUMBER = '4400117742';

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '0.0.0.0', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function sign(payload, secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const digest = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

/** Minimal cookie-aware client (fetch does not persist cookies in Node). */
function client() {
  let cookie = '';
  return async function request(pathname, { method = 'GET', body } = {}) {
    const response = await fetch(baseUrl + pathname, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, text };
  };
}

async function signIn(email, password) {
  const request = client();
  const response = await request('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(response.status, 200, response.text);
  return request;
}

function postWebhook(event, { signature } = {}) {
  const payload = JSON.stringify(event);
  return fetch(`${baseUrl}/api/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature ?? sign(payload) },
    body: payload,
  });
}

function demoAccount() {
  return db.prepare('SELECT * FROM accounts WHERE account_number = ?').get(DEMO_ACCOUNT_NUMBER);
}

function balanceCents() {
  return demoAccount().balance_cents;
}

function pendingDeposit(amountCents, feeCents = 0) {
  const account = demoAccount();
  return insertTransaction({
    user_id: account.user_id,
    account_id: account.id,
    type: 'deposit',
    direction: 'credit',
    amount_cents: amountCents,
    status: 'pending',
    description: 'Card deposit via Stripe Checkout',
    channel: 'card',
    method: 'card',
    provider: 'stripe',
    metadata: { gateway: 'stripe_checkout', stage: 'awaiting_payment', feeCents },
  });
}

function sessionEvent(tx, options = {}) {
  const { taxCents = 0, feeCents = 0, totalCents, eventId, type = 'checkout.session.completed', currency = 'usd' } = options;
  const total = totalCents ?? tx.amount_cents + taxCents + feeCents;
  return {
    id: eventId || `evt_${crypto.randomUUID()}`,
    type,
    livemode: false,
    data: {
      object: {
        id: `cs_test_${crypto.randomUUID()}`,
        object: 'checkout.session',
        payment_status: 'paid',
        client_reference_id: tx.id,
        currency,
        amount_total: total,
        amount_subtotal: total - taxCents,
        total_details: { amount_tax: taxCents },
        payment_intent: `pi_${crypto.randomUUID()}`,
        metadata: { transaction_id: tx.id, fee_cents: String(feeCents) },
        customer_details: { address: { country: 'US' }, tax_ids: [] },
      },
    },
  };
}

test('deposit config reports Stripe connected with automatic tax', async () => {
  const request = await signIn(DEMO_EMAIL, DEMO_PASSWORD);
  const response = await request('/api/deposits/config');
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.gateway.configured, true);
  assert.equal(response.json.gateway.mode, 'test');
  assert.equal(response.json.tax.enabled, true);
  const card = response.json.methods.find((method) => method.id === 'card');
  assert.equal(card.available, true);
});

test('webhook rejects an invalid signature and credits nothing', async () => {
  const tx = pendingDeposit(5000);
  const response = await postWebhook(sessionEvent(tx), { signature: 't=1,v1=deadbeef' });
  assert.equal(response.status, 400);
  assert.equal(db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id).status, 'pending');
});

test('a signed paid session credits the deposit and records tax', async () => {
  const tx = pendingDeposit(10000, 300);
  const before = balanceCents();
  const response = await postWebhook(sessionEvent(tx, { taxCents: 825, feeCents: 300 }));
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.status, 'processed');
  assert.equal(balanceCents(), before + 10000, 'only the deposit principal is credited');

  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
  assert.equal(row.status, 'completed');
  const meta = JSON.parse(row.metadata);
  assert.equal(meta.taxCents, 825);
  assert.equal(meta.feeCents, 300);
  assert.equal(meta.totalCents, 11125);
  assert.equal(meta.taxCountry, 'US');
});

test('redelivering the same event never credits twice', async () => {
  const tx = pendingDeposit(4000);
  const before = balanceCents();
  const event = sessionEvent(tx);

  await postWebhook(event);
  const afterFirst = balanceCents();
  assert.equal(afterFirst, before + 4000);

  const second = await postWebhook(event);
  assert.equal(second.status, 200);
  const payload = await second.json();
  assert.equal(payload.duplicate, true);
  assert.equal(balanceCents(), afterFirst);
});

test('a session whose principal does not match is quarantined for review', async () => {
  const tx = pendingDeposit(20000);
  const before = balanceCents();
  const response = await postWebhook(sessionEvent(tx, { totalCents: 5000 }));

  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'review');
  assert.equal(balanceCents(), before, 'nothing is credited on a mismatch');
  assert.equal(db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id).status, 'review');

  const alert = db
    .prepare("SELECT * FROM fraud_alerts WHERE transaction_id = ? AND rule_code = 'gateway_amount_mismatch'")
    .get(tx.id);
  assert.ok(alert, 'a fraud alert is raised for reconciliation');
});

test('a failed asynchronous payment marks the deposit failed', async () => {
  const tx = pendingDeposit(7000);
  const before = balanceCents();
  const event = sessionEvent(tx, { type: 'checkout.session.async_payment_failed' });
  event.data.object.payment_status = 'unpaid';
  event.data.object.last_payment_error = { code: 'card_declined' };

  await postWebhook(event);

  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
  assert.equal(row.status, 'failed');
  assert.equal(balanceCents(), before);
});

test('the admin payments view requires staff access and reports gateway state', async () => {
  const customer = await signIn(DEMO_EMAIL, DEMO_PASSWORD);
  const denied = await customer('/api/admin/payments');
  assert.equal(denied.status, 403);

  const admin = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  const response = await admin('/api/admin/payments');
  assert.equal(response.status, 200, response.text);

  assert.equal(response.json.gateway.configured, true);
  assert.equal(response.json.gateway.webhookConfigured, true);
  assert.equal(response.json.tax.enabled, true);
  assert.ok(Array.isArray(response.json.events));
  assert.ok(
    response.json.events.some((event) => event.type === 'checkout.session.completed'),
    'webhook deliveries are listed for reconciliation',
  );
  assert.ok(response.json.needsReview >= 1);
});
