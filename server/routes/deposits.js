'use strict';

const express = require('express');

const config = require('../config');
const { db } = require('../db');
const { requireAuth, requireActiveAccount } = require('../services/sessions');
const {
  insertTransaction,
  serializeTransaction,
  getTransactionForUser,
  settleTransaction,
  failTransaction,
  validateAmount,
} = require('../services/ledger');
const payments = require('../services/payments');
const { recordAudit, notify } = require('../services/audit');
const { parseAmountToCents, formatUSD } = require('../money');
const { badRequest, conflict, notFound } = require('../errors');

const router = express.Router();

router.get('/config', requireAuth, (req, res) => {
  res.json({
    gateway: {
      provider: 'stripe',
      configured: payments.isConfigured(),
      requiredEnv: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
    },
    methods: [
      {
        id: 'card',
        label: 'Debit or credit card',
        description: 'Processed by our card payment gateway. Funds post only after the payment is confirmed.',
        available: payments.isConfigured(),
        unavailableReason: payments.isConfigured()
          ? null
          : 'A card payment gateway is not connected yet. Add STRIPE_SECRET_KEY in Settings → Environment variables.',
      },
      {
        id: 'ach',
        label: 'Bank transfer (ACH pull)',
        description: 'Requires a connected account-verification provider before pull transfers can be authorised.',
        available: false,
        unavailableReason: 'ACH pull deposits require a connected bank-linking provider. Use a card deposit instead.',
      },
    ],
    limits: {
      minCents: config.limits.minDepositCents,
      maxCents: config.limits.maxDepositCents,
      min: formatUSD(config.limits.minDepositCents),
      max: formatUSD(config.limits.maxDepositCents),
    },
  });
});

router.post('/checkout', requireAuth, requireActiveAccount, async (req, res) => {
  if (!payments.isConfigured()) throw payments.gatewayRequiredError();
  const amountCents = parseAmountToCents(req.body?.amount);
  validateAmount(amountCents, {
    min: config.limits.minDepositCents,
    max: config.limits.maxDepositCents,
    label: 'deposit amount',
  });

  const tx = insertTransaction({
    user_id: req.user.id,
    account_id: req.account.id,
    type: 'deposit',
    direction: 'credit',
    amount_cents: amountCents,
    status: 'pending',
    description: 'Card deposit via Stripe Checkout',
    channel: 'card',
    method: 'card',
    provider: 'stripe',
    metadata: { gateway: 'stripe_checkout', stage: 'awaiting_payment' },
  });

  const origin = `${req.protocol}://${req.get('host')}`;
  let session;
  try {
    session = await payments.createCheckoutSession({
      amountCents,
      transactionId: tx.id,
      reference: tx.reference,
      customerEmail: req.user.email,
      description: `Northvale Financial deposit ${tx.reference}`,
      origin,
    });
  } catch (error) {
    failTransaction(tx.id, { reason: 'checkout_session_failed' });
    throw error;
  }

  db.prepare('UPDATE transactions SET provider_ref = ?, metadata = ? WHERE id = ?').run(
    session.id,
    JSON.stringify({ gateway: 'stripe_checkout', stage: 'awaiting_payment', checkoutUrl: session.url }),
    tx.id,
  );

  recordAudit({
    actorId: req.user.id,
    actorEmail: req.user.email,
    action: 'deposit.checkout_created',
    targetType: 'transaction',
    targetId: tx.id,
    ip: req.ip,
    metadata: { amountCents, provider: 'stripe' },
  });

  res.status(201).json({
    transaction: serializeTransaction(db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id)),
    checkoutUrl: session.url,
    message: 'Complete the card payment to fund your deposit.',
  });
});

/** Called by the browser when Stripe redirects back. Credits only on a paid session. */
router.get('/confirm', requireAuth, async (req, res) => {
  const sessionId = String(req.query.session_id || '');
  if (!sessionId) throw badRequest('Missing payment session.', 'session_missing');
  if (!payments.isConfigured()) throw payments.gatewayRequiredError();

  const tx = db
    .prepare("SELECT * FROM transactions WHERE provider = 'stripe' AND provider_ref = ? AND user_id = ?")
    .get(sessionId, req.user.id);
  if (!tx) throw notFound('Deposit not found for this payment session.');

  if (tx.status === 'completed') {
    return res.json({
      transaction: serializeTransaction(tx),
      status: 'completed',
      message: 'This deposit has already been credited to your account.',
    });
  }

  const session = await payments.retrieveCheckoutSession(sessionId);
  const paid = session.payment_status === 'paid';
  const amountMatches = Number(session.amount_total) === tx.amount_cents;
  const referenceMatches = session.client_reference_id === tx.id;

  if (!paid || !amountMatches || !referenceMatches) {
    return res.json({
      transaction: serializeTransaction(tx),
      status: 'pending',
      message: paid
        ? 'The payment details did not match this deposit. Our team will review it before crediting funds.'
        : 'The payment has not been confirmed by the gateway yet. Funds will post once the payment settles.',
      paymentStatus: session.payment_status || 'unknown',
    });
  }

  const settled = settleTransaction(tx.id, { actorId: req.user.id, note: `stripe session ${sessionId}` });
  notify(req.user.id, {
    title: 'Deposit credited',
    body: `${formatUSD(tx.amount_cents)} was credited to your account after the card payment was confirmed. Reference ${tx.reference}.`,
    kind: 'transaction',
  });
  recordAudit({
    actorId: req.user.id,
    actorEmail: req.user.email,
    action: 'deposit.settled',
    targetType: 'transaction',
    targetId: tx.id,
    ip: req.ip,
    metadata: { provider: 'stripe', sessionId, amountCents: tx.amount_cents },
  });
  res.json({
    transaction: serializeTransaction(settled),
    status: 'completed',
    message: `Deposit confirmed. ${formatUSD(tx.amount_cents)} is now available.`,
  });
});

router.post('/:id/cancel', requireAuth, (req, res) => {
  const tx = getTransactionForUser(req.params.id, req.user.id);
  if (!tx) throw notFound('Deposit not found.');
  if (tx.type !== 'deposit') throw badRequest('Only deposits can be cancelled.', 'not_deposit');
  if (tx.status !== 'pending') throw conflict('Only pending deposits can be cancelled.', 'not_cancellable');
  const updated = failTransaction(tx.id, { actorId: req.user.id, reason: 'cancelled_by_customer', nextStatus: 'cancelled' });
  notify(req.user.id, {
    title: 'Deposit cancelled',
    body: `Deposit ${tx.reference} was cancelled. No funds were moved.`,
    kind: 'transaction',
  });
  res.json({ ok: true, transaction: serializeTransaction(updated) });
});

module.exports = router;
