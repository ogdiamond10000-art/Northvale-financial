'use strict';

/**
 * External US bank-directory / account-verification provider.
 *
 * Configured through BANK_DIRECTORY_API_URL and BANK_DIRECTORY_API_KEY.
 *
 * The adapter tolerates the response shapes used by the common bank-directory
 * and account-verification providers, and it never throws into a request
 * handler: search returns `null` so the caller can fall back to the bundled
 * directory, and resolve returns an `unavailable` result so the UI can tell the
 * customer to retry instead of silently accepting an unverified recipient.
 */

const config = require('../config');

const TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 250;

const cache = new Map();
const state = {
  lastError: null,
  lastCheckedAt: null,
  lastLatencyMs: null,
  lastSource: null,
};

function isConfigured() {
  return Boolean(config.directory.apiUrl && config.directory.apiKey);
}

/**
 * Derive the search and resolve endpoints from the configured base URL.
 * A URL that already points at a resource (…/banks, …/accounts/resolve) is used
 * as-is for that operation so operators can paste either a base URL or a full
 * endpoint.
 */
function endpoints() {
  const raw = String(config.directory.apiUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  const path = parsed.pathname.replace(/\/+$/, '');
  const looksLikeResolve = /(resolve|lookup|verify|validation)$/i.test(path);
  const looksLikeSearch = /(banks|search|institutions)$/i.test(path);
  return {
    host: parsed.host,
    search: looksLikeSearch ? raw : `${raw}/banks`,
    resolve: looksLikeResolve ? raw : `${raw}/accounts/resolve`,
  };
}

function headers() {
  // Sent together for provider compatibility; both carry the same key.
  return {
    accept: 'application/json',
    authorization: `Bearer ${config.directory.apiKey}`,
    'x-api-key': config.directory.apiKey,
  };
}

async function request(url, options = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      headers: { ...headers(), ...(options.headers || {}) },
      signal: controller.signal,
    });
    const latency = Date.now() - started;
    state.lastLatencyMs = latency;
    state.lastCheckedAt = new Date().toISOString();
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (error) {
        body = null;
      }
    }
    return { ok: response.ok, status: response.status, body, latency };
  } catch (error) {
    state.lastError =
      error && error.name === 'AbortError'
        ? 'The bank directory did not respond in time.'
        : 'The bank directory could not be reached.';
    state.lastCheckedAt = new Date().toISOString();
    return { ok: false, status: 0, body: null, latency: Date.now() - started, error: state.lastError };
  } finally {
    clearTimeout(timer);
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function pickList(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  for (const key of ['banks', 'results', 'institutions', 'items', 'data']) {
    const value = body[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function normalizeBank(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const name = firstString(
    entry.name,
    entry.bank_name,
    entry.institution_name,
    entry.full_name,
    entry.legal_name,
  );
  if (!name) return null;
  const routing = firstString(
    entry.routing_number,
    entry.routingNumber,
    entry.aba,
    entry.aba_number,
    entry.routing,
  );
  const cleanRouting = routing ? routing.replace(/\D/g, '') : null;
  const id =
    firstString(entry.id, entry.bank_id, entry.bankId, entry.institution_id) ||
    (cleanRouting ? `routing_${cleanRouting}` : name.toLowerCase().replace(/[^a-z0-9]+/g, '_'));
  return {
    id,
    name,
    shortName: firstString(entry.short_name, entry.shortName, entry.display_name) || name,
    routingNumber: cleanRouting,
    city: firstString(entry.city, entry.address_city),
    state: firstString(entry.state, entry.address_state, entry.state_code),
    source: 'directory',
  };
}

/**
 * Search the live directory. Returns null when the provider is not configured
 * or did not return usable data, so callers fall back to the bundled list.
 */
async function searchDirectory(query, limit = 8) {
  const q = String(query || '').trim();
  if (!q || !isConfigured()) return null;
  const ep = endpoints();
  if (!ep) return null;

  const key = `${q.toLowerCase()}|${limit}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.banks;

  const build = (param) => {
    const url = new URL(ep.search);
    url.searchParams.set(param, q);
    url.searchParams.set('country', 'US');
    url.searchParams.set('limit', String(limit));
    return url.toString();
  };

  let result = await request(build('query'), { method: 'GET' });
  // Some providers only accept `q`; retry once on a validation-style status.
  if (!result.ok && [400, 404, 422].includes(result.status)) {
    result = await request(build('q'), { method: 'GET' });
  }

  if (!result.ok) {
    state.lastError =
      result.error || `Bank directory search failed (HTTP ${result.status}).`;
    return null;
  }

  const banks = pickList(result.body)
    .map(normalizeBank)
    .filter(Boolean)
    .slice(0, limit);

  if (!banks.length) {
    state.lastError = 'The bank directory returned no matches.';
    return null;
  }

  state.lastError = null;
  state.lastSource = 'directory';
  cache.set(key, { banks, expires: Date.now() + CACHE_TTL_MS });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return banks;
}

/**
 * Resolve the legal name on a recipient account.
 * Returns null when the provider is not configured.
 */
async function resolveAccountName({ routingNumber, accountNumber }) {
  if (!isConfigured()) return null;
  const ep = endpoints();
  if (!ep) return null;

  const result = await request(ep.resolve, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      routing_number: routingNumber,
      account_number: accountNumber,
      country: 'US',
    }),
  });

  if (!result.ok) {
    return {
      status: 'unavailable',
      source: 'external_directory',
      httpStatus: result.status,
      message: result.error
        ? 'The bank directory service could not be reached. Recipient verification is temporarily unavailable.'
        : `The bank directory service responded with ${result.status}. Recipient verification is temporarily unavailable.`,
    };
  }

  const body = result.body || {};
  const nested = body.data && typeof body.data === 'object' ? body.data : {};
  const name = firstString(
    body.account_name,
    body.name,
    body.recipient_name,
    body.account_holder_name,
    body.holder_name,
    body.owner_name,
    nested.account_name,
    nested.name,
    nested.account_holder_name,
  );
  const invalid =
    body.valid === false ||
    body.is_valid === false ||
    body.found === false ||
    nested.valid === false;

  if (invalid || !name) {
    return {
      status: 'not_found',
      source: 'external_directory',
      httpStatus: result.status,
      message: 'The bank directory could not verify a name for this account and routing number.',
    };
  }

  return {
    status: 'verified',
    name,
    source: 'external_directory',
    httpStatus: result.status,
  };
}

/** Non-secret diagnostics for the admin console. */
function status() {
  const ep = endpoints();
  return {
    configured: isConfigured(),
    host: ep ? ep.host : null,
    lastError: state.lastError,
    lastCheckedAt: state.lastCheckedAt,
    lastLatencyMs: state.lastLatencyMs,
    cachedQueries: cache.size,
  };
}

/** Live probe used by the admin console "Test connection" button. */
async function testConnection() {
  if (!isConfigured()) {
    return {
      ok: false,
      reason: 'not_configured',
      message: 'Add BANK_DIRECTORY_API_URL and BANK_DIRECTORY_API_KEY to enable live bank search and recipient verification.',
    };
  }
  cache.clear();
  const started = Date.now();
  const banks = await searchDirectory('chase', 3);
  if (!banks) {
    return {
      ok: false,
      reason: 'provider_error',
      message: state.lastError || 'The bank directory did not return usable results.',
    };
  }
  return {
    ok: true,
    latencyMs: Date.now() - started,
    count: banks.length,
    sample: banks.slice(0, 3).map((bank) => bank.name),
  };
}

module.exports = {
  isConfigured,
  searchDirectory,
  resolveAccountName,
  status,
  testConnection,
};
