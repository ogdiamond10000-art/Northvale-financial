'use strict';

/**
 * End-to-end API tests for Northvale Financial.
 *
 * Runs the real Express application against a temporary SQLite database with
 * the demo seed enabled, exercising registration, verification gating, the
 * ledger, withdrawals, deposit gateway guarding, transaction queries and the
 * administration console over HTTP.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'northvale-test-'));
process.env.DATA_DIR = tmpDir;
process.env.DATABASE_FILE = path.join(tmpDir, 'northvale.db');
process.env.SEED_DEMO_DATA = 'true';
process.env.NODE_ENV = 'test';

const app = require('../server/index.js');
const { db } = require('../server/db');
const config = require('../server/config');

const DEMO_ACCOUNT = '4400117742';
const RECIPIENT_ACCOUNT = '4400128871';
const DEMO_PASSWORD = 'Northvale#2026';
const DEMO_PIN = '246810';

const NEW_USER = {
  firstName: 'Dana',
  lastName: 'Whitfield',
  email: 'dana.whitfield@example.com',
  phone: '+1 (206) 555-0148',
  address: {
    line1: '1200 Fourth Avenue',
    line2: 'Apt 15B',
    city: 'Seattle',
    state: 'WA',
    postalCode: '98101',
  },
  dob: '1991-07-22',
  password: 'Harbor&Light#77',
  accountType: 'checking',
  identity: { ssnLast4: '4821', idType: 'drivers_license' },
  pin: '482913',
  consent: true,
};

let server;
let baseUrl;
let newCustomerId = null;

function collectCookies(res) {
  const raw =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
  return raw.map((entry) => entry.split(';')[0]).join('; ');
}

/** Minimal cookie-aware client (fetch does not persist cookies in Node). */
function makeClient() {
  let cookie = '';
  return async function request(pathname, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(baseUrl + pathname, {
      method,
      redirect: 'manual',
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers,
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
    return { status: response.status, ok: response.ok, json, text, headers: response.headers };
  };
}

function accountOf(payload) {
  return (payload && (payload.account || payload)) || {};
}

function balanceOfAccountNumber(accountNumber) {
  return db.prepare('SELECT balance_cents FROM accounts WHERE account_number = ?').get(accountNumber).balance_cents;
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '0.0.0.0', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // undici keeps keep-alive sockets open, which would otherwise stall shutdown.
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('health endpoint and application shell are served', async () => {
  const request = makeClient();
  const health = await request('/api/health');
  assert.equal(health.status, 200);

  const shell = await request('/');
  assert.equal(shell.status, 200);
  assert.match(shell.text, /Northvale/);
  assert.match(shell.text, /id="app"/);
});

test('bank autocomplete returns matching US banks for one or two letters', async () => {
  const request = makeClient();
  const short = await request('/api/banks?q=ch');
  assert.equal(short.status, 200);
  assert.ok(Array.isArray(short.json.banks) && short.json.banks.length > 0);
  assert.ok(short.json.banks.some((bank) => /chase/i.test(bank.name)));

  const single = await request('/api/banks?q=w');
  assert.equal(single.status, 200);
  assert.ok(single.json.banks.length > 0, 'a single letter should already match banks');
});

test('registration creates an account number, session and pending verification', async () => {
  const request = makeClient();
  const res = await request('/api/auth/register', { method: 'POST', body: NEW_USER });
  assert.equal(res.status, 201, res.text);
  const account = accountOf(res.json);
  assert.match(String(account.accountNumber), /^\d{10}$/);
  assert.equal(res.json.user.kycStatus || res.json.user.kyc_status, 'pending');
  assert.match(res.headers.get('set-cookie') || '', /nv_session=/);

  const session = await request('/api/auth/session');
  assert.equal(session.status, 200);
  assert.equal(session.json.user.email, NEW_USER.email);
  assert.ok(session.json.user.id);
  newCustomerId = session.json.user.id;

  const summary = await request('/api/account');
  assert.equal(summary.status, 200);
  assert.equal(typeof accountOf(summary.json).availableBalanceCents, 'number');
  assert.equal(accountOf(summary.json).accountNumber, account.accountNumber);
});

test('duplicate email registration is rejected', async () => {
  const request = makeClient();
  const res = await request('/api/auth/register', { method: 'POST', body: NEW_USER });
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'email_taken');
});

test('outgoing money is blocked until identity verification completes', async () => {
  const request = makeClient();
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email: NEW_USER.email, password: NEW_USER.password },
  });
  assert.equal(login.status, 200, login.text);

  const res = await request('/api/transfers', {
    method: 'POST',
    body: {
      amount: '5.00',
      pin: NEW_USER.pin,
      routingNumber: config.brand.routingNumber,
      accountNumber: RECIPIENT_ACCOUNT,
    },
  });
  assert.equal(res.status, 403);
  assert.equal(res.json.code, 'kyc_required');
});

test('administrator signs in, sees the customer and verifies their identity', async () => {
  const admin = makeClient();
  const login = await admin('/api/auth/login', {
    method: 'POST',
    body: { email: 'admin@northvale.com', password: 'Admin#2026' },
  });
  assert.equal(login.status, 200, login.text);

  const list = await admin('/api/admin/customers');
  assert.equal(list.status, 200);
  const target = list.json.customers.find((customer) => customer.email === NEW_USER.email);
  assert.ok(target, 'newly registered customer should appear in the admin console');
  newCustomerId = target.id;

  const decision = await admin(`/api/admin/customers/${target.id}/kyc`, {
    method: 'POST',
    body: { decision: 'verified', note: 'Documents matched in test run.' },
  });
  assert.equal(decision.status, 200, decision.text);

  const overview = await admin('/api/admin/overview');
  assert.equal(overview.status, 200);
  assert.ok(overview.json.totals);
});

test('customers cannot reach the administration console', async () => {
  const request = makeClient();
  await request('/api/auth/login', { method: 'POST', body: { email: NEW_USER.email, password: NEW_USER.password } });
  const res = await request('/api/admin/overview');
  assert.equal(res.status, 403);
});

test('deposits are never credited without a configured payment gateway', async () => {
  const request = makeClient();
  await request('/api/auth/login', { method: 'POST', body: { email: NEW_USER.email, password: NEW_USER.password } });

  const cfg = await request('/api/deposits/config');
  assert.equal(cfg.status, 200);
  assert.match(JSON.stringify(cfg.json), /"configured":false/);

  const before = accountOf((await request('/api/account')).json).availableBalanceCents;
  const checkout = await request('/api/deposits/checkout', { method: 'POST', body: { amount: '50.00' } });
  assert.ok(checkout.status >= 400, 'unconfigured gateway must refuse the checkout');
  assert.ok(checkout.json.error);

  const after = accountOf((await request('/api/account')).json).availableBalanceCents;
  assert.equal(after, before, 'balance must not change without a verified payment');
});

test('transaction PIN and available balance are enforced server-side', async () => {
  const request = makeClient();
  await request('/api/auth/login', { method: 'POST', body: { email: NEW_USER.email, password: NEW_USER.password } });

  const wrongPin = await request('/api/transfers', {
    method: 'POST',
    body: {
      amount: '5.00',
      pin: '000000',
      routingNumber: config.brand.routingNumber,
      accountNumber: RECIPIENT_ACCOUNT,
    },
  });
  assert.ok([400, 401, 403].includes(wrongPin.status), `expected PIN rejection, got ${wrongPin.status}`);

  const noFunds = await request('/api/transfers', {
    method: 'POST',
    body: {
      amount: '25.00',
      pin: NEW_USER.pin,
      routingNumber: config.brand.routingNumber,
      accountNumber: RECIPIENT_ACCOUNT,
    },
  });
  assert.equal(noFunds.status, 409);
  assert.equal(noFunds.json.code, 'insufficient_funds');
});

test('internal transfer settles, debits the sender and credits the recipient', async () => {
  const demoEmail = db
    .prepare('SELECT u.email FROM users u JOIN accounts a ON a.user_id = u.id WHERE a.account_number = ?')
    .get(DEMO_ACCOUNT).email;

  const request = makeClient();
  const login = await request('/api/auth/login', { method: 'POST', body: { email: demoEmail, password: DEMO_PASSWORD } });
  assert.equal(login.status, 200, login.text);

  const senderBefore = balanceOfAccountNumber(DEMO_ACCOUNT);
  const recipientBefore = balanceOfAccountNumber(RECIPIENT_ACCOUNT);

  const res = await request('/api/transfers', {
    method: 'POST',
    body: {
      amount: '50.00',
      description: 'Test suite transfer',
      pin: DEMO_PIN,
      routingNumber: config.brand.routingNumber,
      accountNumber: RECIPIENT_ACCOUNT,
      idempotencyKey: 'test-transfer-1',
    },
  });
  assert.ok(res.status < 300, res.text);
  assert.equal(res.json.transaction.status, 'completed');
  assert.ok(res.json.transaction.reference);
  assert.equal(balanceOfAccountNumber(DEMO_ACCOUNT), senderBefore - 5000);
  assert.equal(balanceOfAccountNumber(RECIPIENT_ACCOUNT), recipientBefore + 5000);

  const replay = await request('/api/transfers', {
    method: 'POST',
    body: {
      amount: '50.00',
      description: 'Test suite transfer',
      pin: DEMO_PIN,
      routingNumber: config.brand.routingNumber,
      accountNumber: RECIPIENT_ACCOUNT,
      idempotencyKey: 'test-transfer-1',
    },
  });
  assert.equal(replay.status, 200);
  assert.equal(balanceOfAccountNumber(RECIPIENT_ACCOUNT), recipientBefore + 5000, 'replay must not move money twice');
});

test('withdrawals return pending status and a downloadable receipt', async () => {
  const demoEmail = db
    .prepare('SELECT u.email FROM users u JOIN accounts a ON a.user_id = u.id WHERE a.account_number = ?')
    .get(DEMO_ACCOUNT).email;
  const request = makeClient();
  await request('/api/auth/login', { method: 'POST', body: { email: demoEmail, password: DEMO_PASSWORD } });

  const methods = await request('/api/withdrawals/methods');
  assert.equal(methods.status, 200);
  assert.ok(methods.json.methods.some((method) => method.id === 'ach'));

  const res = await request('/api/withdrawals', {
    method: 'POST',
    body: {
      method: 'ach',
      amount: '25.00',
      description: 'Test withdrawal',
      pin: DEMO_PIN,
      routingNumber: '021000021',
      accountNumber: '000123456789',
    },
  });
  assert.ok(res.status < 300, res.text);
  assert.ok(['pending', 'review', 'processing'].includes(res.json.transaction.status));
  assert.ok(res.json.transaction.reference);

  const receipt = await request(`/api/account/transactions/${res.json.transaction.id}/receipt`);
  assert.equal(receipt.status, 200);
  assert.match(receipt.headers.get('content-type') || '', /html/);
  assert.match(receipt.text, /Northvale/);
});

test('transaction history supports status filters and search', async () => {
  const demoEmail = db
    .prepare('SELECT u.email FROM users u JOIN accounts a ON a.user_id = u.id WHERE a.account_number = ?')
    .get(DEMO_ACCOUNT).email;
  const request = makeClient();
  await request('/api/auth/login', { method: 'POST', body: { email: demoEmail, password: DEMO_PASSWORD } });

  const completed = await request('/api/account/transactions?status=completed');
  assert.equal(completed.status, 200);
  assert.ok(completed.json.transactions.length > 0);
  assert.ok(completed.json.transactions.every((tx) => tx.status === 'completed'));

  const pending = await request('/api/account/transactions?status=pending');
  assert.equal(pending.status, 200);
  assert.ok(pending.json.transactions.every((tx) => tx.status === 'pending'));

  const search = await request('/api/account/transactions?q=Rent');
  assert.equal(search.status, 200);
  assert.ok(search.json.transactions.some((tx) => /rent/i.test(tx.description || '')));

  const unknown = await request('/api/account/transactions/does-not-exist');
  assert.equal(unknown.status, 404);
});

test('administrator can monitor transactions, alerts, reconciliation and audit logs', async () => {
  const admin = makeClient();
  await admin('/api/auth/login', { method: 'POST', body: { email: 'admin@northvale.com', password: 'Admin#2026' } });

  const transactions = await admin('/api/admin/transactions');
  assert.equal(transactions.status, 200);
  assert.ok(Array.isArray(transactions.json.transactions));

  for (const route of ['/api/admin/alerts', '/api/admin/reconciliation', '/api/admin/audit-logs']) {
    const res = await admin(route);
    assert.equal(res.status, 200, `${route} should be readable by an administrator`);
  }

  const audit = await admin('/api/admin/audit-logs');
  const actions = (audit.json.logs || audit.json.auditLogs || []).map((entry) => entry.action);
  assert.ok(actions.includes('account.registered'), 'registration must be audited');
});
