'use strict';

/**
 * Bank-directory integration tests.
 *
 * A local HTTP server stands in for the provider: the adapter is exercised over
 * real HTTP (auth header, query parameters, response normalisation, timeouts and
 * fallback), so no third-party account or network access is required.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'northvale-directory-'));
process.env.DATA_DIR = tmpDir;
process.env.DATABASE_FILE = path.join(tmpDir, 'northvale.db');
process.env.SEED_DEMO_DATA = 'true';
process.env.NODE_ENV = 'test';

let app;
let server;
let provider;
let base;
const seen = { auth: null, searchParams: null, resolveBody: null };

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

before(async () => {
  provider = http.createServer((req, res) => {
    seen.auth = req.headers.authorization || null;

    if (req.method === 'GET' && req.url.startsWith('/banks')) {
      const url = new URL(req.url, 'http://127.0.0.1');
      seen.searchParams = Object.fromEntries(url.searchParams.entries());
      const query = String(url.searchParams.get('query') || url.searchParams.get('q') || '').toLowerCase();
      if (query.startsWith('zzz')) return json(res, 200, { banks: [] });
      return json(res, 200, {
        banks: [
          { name: 'JPMorgan Chase Bank, N.A.', routing_number: '021000021', city: 'New York', state: 'NY' },
          { name: 'Chase Bank USA, N.A.', routing_number: '021000089', city: 'Wilmington', state: 'DE' },
        ],
      });
    }

    if (req.method === 'POST' && req.url.startsWith('/accounts/resolve')) {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch (error) {
          body = {};
        }
        seen.resolveBody = body;
        if (String(body.routing_number) === '999999999') {
          return json(res, 500, { error: 'provider unavailable' });
        }
        if (String(body.account_number) === '0000000000') {
          return json(res, 200, { valid: false });
        }
        return json(res, 200, { valid: true, account_name: 'Jordan P Reyes' });
      });
      return;
    }

    json(res, 404, { error: 'not found' });
  });

  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const providerUrl = `http://127.0.0.1:${provider.address().port}`;

  // Set before the app is required: config reads the environment at load time.
  process.env.BANK_DIRECTORY_API_URL = providerUrl;
  process.env.BANK_DIRECTORY_API_KEY = 'test_directory_key';

  app = require('../server/index.js');
  await new Promise((resolve) => {
    server = app.listen(0, '0.0.0.0', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (provider) await new Promise((resolve) => provider.close(resolve));
});

async function signIn(email, password) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200, `sign-in failed for ${email}`);
  const cookies = response.headers.getSetCookie
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')];
  return cookies.filter(Boolean).map((value) => value.split(';')[0]).join('; ');
}

async function getJson(pathname, cookie) {
  const response = await fetch(`${base}${pathname}`, {
    headers: cookie ? { cookie } : {},
  });
  return { status: response.status, body: await response.json() };
}

async function postJson(pathname, body, cookie) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('bank autocomplete is served by the live directory', async () => {
  const { status, body } = await getJson('/api/banks?q=cha');
  assert.equal(status, 200);
  assert.equal(body.source, 'directory');
  assert.ok(body.banks.length >= 1);
  assert.match(body.banks[0].name, /Chase/);
  assert.equal(body.banks[0].routingNumber, '021000021');
  // The API key travels as a bearer token and the search term is forwarded.
  assert.equal(seen.auth, 'Bearer test_directory_key');
  assert.equal(seen.searchParams.query, 'cha');
  assert.equal(seen.searchParams.country, 'US');
});

test('bank autocomplete falls back to the bundled list when the provider returns nothing', async () => {
  const { status, body } = await getJson('/api/banks?q=zzz');
  assert.equal(status, 200);
  assert.equal(body.source, 'local');
  assert.deepEqual(body.banks, []);
});

test('recipient lookup returns the verified name from the directory', async () => {
  const cookie = await signIn('alex.morgan@example.com', 'Northvale#2026');
  const { status, body } = await postJson(
    '/api/recipients/lookup',
    { routingNumber: '021000021', accountNumber: '123456789', bankName: 'JPMorgan Chase Bank, N.A.' },
    cookie,
  );
  assert.equal(status, 200);
  assert.equal(body.status, 'verified');
  assert.equal(body.name, 'Jordan P Reyes');
  assert.equal(body.source, 'external_directory');
  assert.equal(body.bankName, 'JPMorgan Chase Bank, N.A.');
  assert.equal(seen.resolveBody.routing_number, '021000021');
  assert.equal(seen.resolveBody.account_number, '123456789');
});

test('an unverifiable account is reported as not found', async () => {
  const cookie = await signIn('alex.morgan@example.com', 'Northvale#2026');
  const { status, body } = await postJson(
    '/api/recipients/lookup',
    { routingNumber: '021000021', accountNumber: '0000000000' },
    cookie,
  );
  assert.equal(status, 200);
  assert.equal(body.status, 'not_found');
  assert.match(body.message, /could not verify/i);
});

test('a provider outage is reported as unavailable instead of verifying', async () => {
  const cookie = await signIn('alex.morgan@example.com', 'Northvale#2026');
  const { status, body } = await postJson(
    '/api/recipients/lookup',
    { routingNumber: '999999999', accountNumber: '123456789' },
    cookie,
  );
  assert.equal(status, 200);
  assert.equal(body.status, 'unavailable');
  assert.match(body.message, /500/);
});

test('recipient lookup requires an authenticated session', async () => {
  const { status } = await postJson('/api/recipients/lookup', {
    routingNumber: '021000021',
    accountNumber: '123456789',
  });
  assert.equal(status, 401);
});

test('admin directory status reports the provider without leaking the key', async () => {
  const cookie = await signIn('admin@northvale.com', 'Admin#2026');
  const { status, body } = await getJson('/api/admin/directory', cookie);
  assert.equal(status, 200);
  assert.equal(body.directory.configured, true);
  assert.ok(body.directory.host);
  assert.ok(!JSON.stringify(body).includes('test_directory_key'));

  const probe = await postJson('/api/admin/directory/test', {}, cookie);
  assert.equal(probe.status, 200);
  assert.equal(probe.body.ok, true);
  assert.ok(probe.body.count >= 1);
});

test('customers cannot read directory diagnostics', async () => {
  const cookie = await signIn('alex.morgan@example.com', 'Northvale#2026');
  const { status } = await getJson('/api/admin/directory', cookie);
  assert.equal(status, 403);
});
