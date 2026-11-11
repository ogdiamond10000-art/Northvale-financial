'use strict';

const crypto = require('crypto');
const config = require('../config');
const { AppError } = require('../errors');

function isConfigured() {
  return Boolean(config.stripe.secretKey);
}

function gatewayRequiredError() {
  return new AppError(
    503,
    'Card deposits are not available because a payment gateway is not connected yet. Add STRIPE_SECRET_KEY (and STRIPE_WEBHOOK_SECRET) in Settings → Environment variables to enable live card payments.',
    'gateway_not_configured',
    { requiredEnv: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] },
  );
}

async function stripeRequest(path, params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) body.append(key, String(value));
  }
  const response = await fetch(`${config.stripe.apiBase}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.stripe.secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': params.idempotency_key || crypto.randomUUID(),
    },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `Payment gateway error (${response.status}).`;
    throw new AppError(502, message, 'gateway_error');
  }
  return data;
}

async function createCheckoutSession({ amountCents, transactionId, reference, customerEmail, description, origin }) {
  if (!isConfigured()) throw gatewayRequiredError();
  const session = await stripeRequest('/checkout/sessions', {
    mode: 'payment',
    success_url: `${origin}/#/deposit/return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/#/deposit?canceled=1`,
    customer_email: customerEmail,
    client_reference_id: transactionId,
    'line_items[0][quantity]': 1,
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': amountCents,
    'line_items[0][price_data][product_data][name]': description || 'Northvale account deposit',
    'metadata[transaction_id]': transactionId,
    'metadata[reference]': reference,
    'payment_intent_data[metadata][transaction_id]': transactionId,
  });
  return session;
}

async function retrieveCheckoutSession(sessionId) {
  if (!isConfigured()) throw gatewayRequiredError();
  const response = await fetch(
    `${config.stripe.apiBase}/checkout/sessions/${encodeURIComponent(sessionId)}`,
    { headers: { authorization: `Bearer ${config.stripe.secretKey}` } },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AppError(502, data?.error?.message || 'Could not retrieve the payment session.', 'gateway_error');
  }
  return data;
}

function verifyWebhookSignature(rawBody, signatureHeader, secret = config.stripe.webhookSecret) {
  if (!secret) return { valid: false, reason: 'webhook_secret_missing' };
  if (!signatureHeader) return { valid: false, reason: 'signature_missing' };
  const parts = Object.fromEntries(
    String(signatureHeader)
      .split(',')
      .map((part) => part.split('='))
      .filter((pair) => pair.length === 2),
  );
  const timestamp = Number(parts.t);
  if (!timestamp || !parts.v1) return { valid: false, reason: 'signature_malformed' };
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return { valid: false, reason: 'timestamp_out_of_tolerance' };
  const payload = Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const provided = Buffer.from(parts.v1, 'hex');
  const computed = Buffer.from(expected, 'hex');
  if (provided.length !== computed.length || !crypto.timingSafeEqual(provided, computed)) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  return { valid: true };
}

module.exports = {
  isConfigured,
  gatewayRequiredError,
  createCheckoutSession,
  retrieveCheckoutSession,
  verifyWebhookSignature,
};
