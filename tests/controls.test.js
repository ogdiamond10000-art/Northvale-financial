'use strict';

/**
 * Operations-control tests.
 *
 * Covers the administrator switches that govern money movement (global transfer
 * kill switch, outgoing pause, new-transfer holds), placing a transaction on
 * hold and releasing it after verification, documented balance adjustments with
 * audit trails, and preservation of the pre-existing customer database.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'northvale-controls-'));
process.env.DATA_DIR = tmpDir;
process.env.DATABASE_FILE = path.join(tmpDir, 'northvale.db');
process.env.SEED_DEMO_DATA = 'true';
process.env.NODE_ENV = 'test';

const app = require('../server/index.js');
const { db } = require('../server/db');
const config = require('../server/config');
const { insertTransaction } = require('../server/services/ledger');

const DEMO_ACCOUNT = '4400117742';
const INTERNAL_RECIPIENT = '4400128871';
const DEMO_PASSWORD = 'Northvale#2026';
const DEMO_PIN = '246810';

let server;
let baseUrl;
let seededTransactionCount = 0;
let seededBalanceCents = 0;

function collectCookies(res) {
  const raw =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
  return raw.map((entry) => entry.split(';')[0]).join('; ');
}

function makeClient() {
  let cookie = '';
  return async function request(pathname, { method = 'GET', body } = {}) {
    const response = await fetch(baseUrl + pathname, {
      method,
      redirect: 'manual',
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const nextCookie = collectCookies(response);
    if (nextCookie) cookie = nextCookie;
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, text };
  };
}

async function signIn(email, password) {
  const client = makeClient();
  const res = await client('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(res.status, 200, res.text);
  return client;
}

function demoAccount() {
  return db.prepare('SELECT * FROM accounts WHERE account_number = ?').get(DEMO_ACCOUNT);
}

function demoBalance() {
  return demoAccount().balance_cents;
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '0.0.0.0', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  seededTransactionCount = db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count;
  seededBalanceCents = demoBalance();
  assert.ok(seededTransactionCount > 0, 'demo seed should have created transactions');
  assert.ok(seededBalanceCents > 0, 'demo seed should have funded the demo account');
});

after(async () => {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('customers see the current money-movement availability, admins see the switches', async () => {
  const customer = await signIn('alex.morgan@example.com', DEMO_PASSWORD);
  const view = await customer('/api/system/controls');
  assert.equal(view.status, 200, view.text);
  assert.equal(view.json.controls.transfersEnabled, true);
  assert.equal(view.json.controls.outgoingPaused, false);
  // Operator identity must never leak to a customer.
  assert.equal(view.json.controls.updatedBy, undefined);

  const denied = await customer('/api/admin/controls');
  assert.equal(denied.status, 403, 'a customer must not read the admin console');

  const admin = await signIn('admin@northvale.com', 'Admin#2026');
  const full = await admin('/api/admin/controls');
  assert.equal(full.status, 200, full.text);
  assert.equal(full.json.controls.holdNewExternal, false);
  assert.ok(Array.isArray(full.json.recent));
});

test('global transfer switch blocks every transfer and withdrawal until re-enabled', async () => {
  const admin = await signIn('admin@northvale.com', 'Admin#2026');
  const customer = await signIn('alex.morgan@example.com', DEMO_PASSWORD);
  const balanceBefore = demoBalance();

  const off = await admin('/api/admin/controls', {
    method: 'PATCH',
    body: { transfersEnabled: false, message: 'Scheduled maintenance window.' },
  });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.json.controls.transfersEnabled, false);

  const customerView = await customer('/api/system/controls');
  assert.equal(customerView.json.controls.transfersEnabled, false);
  assert.equal(customerView.json.controls.message, 'Scheduled maintenance window.');

  const blocked = await customer('/api/transfers', {
    method: 'POST',
    body: {
      amount: '10.00',
      pin: DEMO_PIN,
      routingNumber: config.brand.routingNumber,
      accountNumber: INTERNAL_RECIPIENT,
    },
  });
  assert.equal(blocked.status, 423, blocked.text);
  assert.equal(blocked.json.code, 'transfers_disabled');

  const withdrawal = await customer('/api/withdrawals', {
    method: 'POST',
    body: { amount: '10.00', method: 'bank', bankName: 'Chase', accountNumber: INTERNAL_RECIPIENT },
  });
  assert.equal(withdrawal.status, 423, withdrawal.text);
  assert.equal(withdrawal.json.code, 'transfers_disabled');

  assert.equal(demoBalance(), balanceBefore, 'a blocked request must not move money');

  const on = await admin('/api/admin/controls', { method: 'PATCH', body: { transfersEnabled: true, message: '' } });
  assert.equal(on.json.controls.transfersEnabled, true);

  const allowed = await customer('/api/transfers', {
    method: 'POST',
    body: {
      amount: '10.00',
      pin: DEMO_PIN,
      routingNumber: config.brand.routingNumber,
      accountNumber: INTERNAL_RECIPIENT,
    },
  });
  assert.equal(allowed.status, 201, allowed.text);
  assert.equal(allowed.json.transaction.status, 'completed');
  assert.ok(allowed.json.transaction.reference);
});

test('outgoing pause stops external movement while internal transfers still settle', async () => {
  const admin = await signIn('admin@northvale.com', 'Admin#2026');
  const customer = await signIn('alex.morgan@example.com', DEMO_PASSWORD);

  const paused = await admin('/api/admin/controls', { method: 'PATCH', body: { outgoingPaused: true } });
  assert.equal(paused.json.controls.outgoingPaused, true);

  const withdrawal = await customer('/api/withdrawals', {
    method: 'POST',
    body: { amount: '5.00', method: 'bank', bankName: 'Chase', accountNumber: INTERNAL_RECIPIENT },
  });
  assert.equal(withdrawal.status, 423, withdrawal.text);
  assert.equal(withdrawal.json.code, 'outgoing_paused');

  const internal = await customer('/api/transfers', {
    method: 'POST',
    body: {
      amount: '5.00',
      pin: DEMO_PIN,
      routingNumber: config.brand.routingNumber,
      accountNumber: INTERNAL_RECIPIENT,
    },
  });
  assert.equal(internal.status, 201, internal.text);

  await admin('/api/admin/controls', { method: 'PATCH', body: { outgoingPaused: false } });
});

test('a pending transaction can be held, nets the available balance, then released', async () => {
  const account = demoAccount();
  const created = insertTransaction({
    user_id: account.user_id,
    account_id: account.id,
    type: 'withdrawal',
    direction: 'debit',
    amount_cents: 4500,
    status: 'pending',
    description: 'Withdrawal to Chase Bank',
    channel: 'external',
    method: 'bank',
  });
  const txId = created.id;
  assert.ok(txId, 'the pending transaction must be created');

  const customer = await signIn('alex.morgan@example.com', DEMO_PASSWORD);
  const before = await customer('/api/account');
  const availableBefore = before.json.account.availableBalanceCents;
  const currentBefore = before.json.account.balanceCents;

  const admin = await signIn('admin@northvale.com', 'Admin#2026');
  const held = await admin(`/api/admin/transactions/${encodeURIComponent(txId)}/hold`, {
    method: 'POST',
    body: { reason: 'Awaiting counterparty verification.' },
  });
  assert.equal(held.status, 200, held.text);
  assert.equal(held.json.transaction.status, 'on_hold');

  const afterHold = await customer('/api/account');
  assert.equal(afterHold.json.account.balanceCents, currentBefore, 'a hold must not change the ledger balance');
  assert.equal(availableBefore, currentBefore - 4500, 'a pending debit already nets the available balance');
  assert.equal(
    afterHold.json.account.availableBalanceCents,
    availableBefore,
    'held funds stay committed and remain excluded from the available balance',
  );

  // Settling a hold directly is refused; release is the supported path.
  const premature = await admin(`/api/admin/transactions/${encodeURIComponent(txId)}/settle`, { method: 'POST' });
  assert.equal(premature.status, 409, premature.text);

  const released = await admin(`/api/admin/transactions/${encodeURIComponent(txId)}/release`, {
    method: 'POST',
    body: { note: 'Counterparty verified.' },
  });
  assert.equal(released.status, 200, released.text);
  assert.equal(released.json.transaction.status, 'completed');

  const afterRelease = await customer('/api/account');
  assert.equal(afterRelease.json.account.balanceCents, currentBefore - 4500);
});

test('documented balance adjustments post to the ledger and are audited', async () => {
  const admin = await signIn('admin@northvale.com', 'Admin#2026');
  const customer = await signIn('alex.morgan@example.com', DEMO_PASSWORD);
  const before = demoBalance();

  // A reason is mandatory for every adjustment.
  const noReason = await admin(`/api/admin/customers/${DEMO_ACCOUNT}/adjustment`, {
    method: 'POST',
    body: { direction: 'credit', amount: '100.00', reason: 'short' },
  });
  assert.equal(noReason.status, 400, noReason.text);
  assert.equal(demoBalance(), before);

  const credit = await admin(`/api/admin/customers/${DEMO_ACCOUNT}/adjustment`, {
    method: 'POST',
    body: {
      direction: 'credit',
      amount: '250.00',
      reason: 'Reversal of duplicate ACH debit from merchant.',
      ticket: 'FIN-4471',
    },
  });
  assert.equal(credit.status, 201, credit.text);
  assert.equal(demoBalance(), before + 25000);

  const debit = await admin(`/api/admin/customers/${DEMO_ACCOUNT}/adjustment`, {
    method: 'POST',
    body: { direction: 'debit', amount: '50.00', reason: 'Correction of misposted teller credit.' },
  });
  assert.equal(debit.status, 201, debit.text);
  assert.equal(demoBalance(), before + 20000);

  const overdraw = await admin(`/api/admin/customers/${DEMO_ACCOUNT}/adjustment`, {
    method: 'POST',
    body: { direction: 'debit', amount: '9999999.00', reason: 'Should be refused by the ledger.' },
  });
  assert.equal(overdraw.status, 409, overdraw.text);

  // The customer sees the adjustment in their own history.
  const history = await customer('/api/account/transactions?limit=50');
  assert.equal(history.status, 200, history.text);
  const rows = history.json.transactions || [];
  assert.ok(
    rows.some((tx) => tx.type === 'adjustment' && tx.status === 'completed'),
    'the adjustment should appear in the customer transaction history',
  );

  const audit = await admin('/api/admin/audit-logs?limit=50');
  const actions = (audit.json.logs || audit.json.auditLogs || []).map((row) => row.action);
  assert.ok(
    actions.some((action) => String(action).includes('adjustment')),
    `an adjustment audit entry should exist, saw ${actions.slice(0, 12).join(', ')}`,
  );
});

test('existing customer data is preserved across the upgrade', async () => {
  const users = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  assert.ok(users >= 2, 'seeded users must still exist');

  const transactions = db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count;
  assert.ok(
    transactions >= seededTransactionCount,
    'no historical transaction may be dropped by the upgrade',
  );

  // The seeded customer can still sign in and read their original account.
  const customer = await signIn('alex.morgan@example.com', DEMO_PASSWORD);
  const summary = await customer('/api/account');
  assert.equal(summary.status, 200, summary.text);
  assert.equal(summary.json.account.accountNumber, DEMO_ACCOUNT);

  const controls = db.prepare('SELECT COUNT(*) AS count FROM system_settings').get().count;
  assert.equal(controls, 1, 'controls persist in their own table without touching customer rows');
});
