'use strict';

const Stripe = require('stripe');

const config = require('../config');
const { AppError } = require('../errors');

/**
 * Stripe gateway adapter.
 *
 * Everything is env-gated: without STRIPE_SECRET_KEY the gateway reports itself
 * unconfigured, the deposit route refuses to create a payment and no balance is
 * ever credited from a client-side claim. Crediting only happens from a
 * signature-verified Stripe webhook (see services/stripe-webhooks.js).
 */

let cached = null;

function isConfigured() {
  return Boolean(config.stripe.secretKey);
}

function isWebhookConfigured() {
  return Boolean(config.stripe.webhookSecret);
}

function mode() {
  const key = config.stripe.secretKey || '';
  if (!key) return 'unconfigured';
  return key.startsWith('sk_live') || key.startsWith('rk_live') ? 'live' : 'test';
}

function gatewayRequiredError() {
  return new AppError(
    503,
    'Card deposits are not available because a payment gateway is not connected yet. Add STRIPE_SECRET_KEY (and STRIPE_WEBHOOK_SECRET) in Settings → Environment variables to enable live card payments.',
    'gateway_not_configured',
    { requiredEnv: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] },
  );
}

function client() {
  if (!isConfigured()) throw gatewayRequiredError();
  if (!cached || cached.key !== config.stripe.secretKey) {
    cached = {
      key: config.stripe.secretKey,
      sdk: new Stripe(config.stripe.secretKey, {
        maxNetworkRetries: 2,
        timeout: 20000,
        appInfo: { name: 'Northvale Financial', version: '1.0.0' },
      }),
    };
  }
  return cached.sdk;
}

/** Optional card processing fee, in cents, passed to the payer as its own line item. */
function computeFeeCents(amountCents) {
  const percent = Number(config.stripe.feePercent) || 0;
  if (!(percent > 0) || !(amountCents > 0)) return 0;
  return Math.min(Math.round((amountCents * percent) / 100), amountCents);
}

function taxEnabled() {
  return Boolean(config.stripe.taxEnabled);
}

/**
 * Create a Stripe Checkout Session for a pending deposit.
 * automatic_tax lets Stripe calculate sales tax from the customer's billing
 * address, and tax_id_collection captures a business tax ID when the payer has one.
 */
async function createCheckoutSession({
  amountCents,
  feeCents = 0,
  transactionId,
  reference,
  customerEmail,
  description,
  origin,
}) {
  if (!isConfigured()) throw gatewayRequiredError();

  const tax = taxEnabled();
  const lineItems = [
    {
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: amountCents,
        product_data: {
          name: description || 'Northvale account deposit',
          tax_code: config.stripe.taxCode,
        },
      },
    },
  ];

  if (feeCents > 0) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: feeCents,
        product_data: {
          name: 'Card processing fee',
          tax_code: config.stripe.taxCode,
        },
      },
    });
  }

  const session = await client().checkout.sessions.create(
    {
      mode: 'payment',
      success_url: `${origin}/#/deposit?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/#/deposit?canceled=1`,
      customer_email: customerEmail,
      client_reference_id: transactionId,
      line_items: lineItems,
      automatic_tax: { enabled: tax },
      tax_id_collection: { enabled: tax },
      billing_address_collection: tax ? 'required' : 'auto',
      metadata: {
        transaction_id: transactionId,
        reference,
        fee_cents: String(feeCents),
        deposit_cents: String(amountCents),
      },
      payment_intent_data: {
        description: description || 'Northvale deposit',
        metadata: { transaction_id: transactionId, reference },
      },
    },
    { idempotencyKey: `northvale-checkout-${transactionId}` },
  );

  return session;
}

async function retrieveCheckoutSession(sessionId) {
  if (!isConfigured()) throw gatewayRequiredError();
  return client().checkout.sessions.retrieve(sessionId, { expand: ['payment_intent'] });
}

/** Normalise the money fields of a Checkout Session for storage and display. */
function breakdown(session) {
  const taxCents = Number(session?.total_details?.amount_tax || 0);
  const feeCents = Number(session?.metadata?.fee_cents || 0);
  const totalCents = Number(session?.amount_total ?? 0);
  const subtotalCents = Number(session?.amount_subtotal ?? 0);
  return {
    taxCents,
    feeCents,
    subtotalCents,
    totalCents,
    depositCents: Math.max(0, totalCents - taxCents - feeCents),
    currency: String(session?.currency || 'usd').toUpperCase(),
  };
}

/**
 * Verify the Stripe-Signature header against the raw request body.
 * Returns the parsed event on success so callers never trust unsigned JSON.
 */
function verifyWebhookSignature(rawBody, signatureHeader, secret = config.stripe.webhookSecret) {
  if (!secret) return { valid: false, reason: 'webhook_secret_missing' };
  if (!signatureHeader) return { valid: false, reason: 'signature_missing' };
  if (!rawBody || !rawBody.length) return { valid: false, reason: 'payload_missing' };

  try {
    const event = Stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
    return { valid: true, event };
  } catch (error) {
    const mismatch = error && (error.type === 'StripeSignatureVerificationError' || /signature/i.test(error.message || ''));
    return { valid: false, reason: mismatch ? 'signature_mismatch' : 'signature_invalid' };
  }
}

function gatewayStatus() {
  return {
    provider: 'stripe',
    configured: isConfigured(),
    webhookConfigured: isWebhookConfigured(),
    mode: mode(),
    taxEnabled: taxEnabled(),
    taxCode: config.stripe.taxCode,
    feePercent: Number(config.stripe.feePercent) || 0,
    requiredEnv: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
  };
}

/**
 * Live Stripe Tax state: whether automatic tax is on and how many active tax
 * registrations exist. Never throws — the console shows the reason instead.
 */
async function taxStatus() {
  const enabled = taxEnabled();
  if (!isConfigured()) {
    return { enabled, available: false, reason: 'gateway_not_configured', activeRegistrations: 0, countries: [] };
  }
  if (!enabled) {
    return { enabled: false, available: true, reason: 'tax_disabled', activeRegistrations: 0, countries: [] };
  }

  try {
    const list = await client().tax.registrations.list({ limit: 10, status: 'active' });
    return {
      enabled: true,
      available: true,
      activeRegistrations: list.data.length,
      hasMore: Boolean(list.has_more),
      countries: list.data.map((registration) => registration.country).filter(Boolean),
    };
  } catch (error) {
    return {
      enabled: true,
      available: false,
      reason: 'stripe_error',
      message: String(error?.message || 'Stripe Tax status could not be read.').slice(0, 200),
      activeRegistrations: 0,
      countries: [],
    };
  }
}

module.exports = {
  isConfigured,
  isWebhookConfigured,
  mode,
  gatewayRequiredError,
  gatewayStatus,
  taxStatus,
  taxEnabled,
  computeFeeCents,
  createCheckoutSession,
  retrieveCheckoutSession,
  breakdown,
  verifyWebhookSignature,
};
