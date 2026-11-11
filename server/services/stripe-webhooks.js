'use strict';

const { db, nowIso } = require('../db');
const { getTransaction, settleTransaction, failTransaction } = require('./ledger');
const { notify, notifyAdmins, recordAudit, createFraudAlert } = require('./audit');
const { formatUSD } = require('../money');

/**
 * Stripe webhook processing.
 *
 * Rules that keep the ledger honest:
 *  - Every event is recorded in stripe_events, so redeliveries are idempotent.
 *  - A deposit is credited only when the session is paid, belongs to a pending
 *    deposit, is denominated in USD and its principal matches the amount we asked
 *    for (total minus tax minus our own fee line).
 *  - Anything else is parked in `review` with a fraud alert; nothing is credited.
 */

const PAID_EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);

function parseMetadata(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveMetadata(tx, patch) {
  const next = { ...parseMetadata(tx.metadata), ...patch };
  db.prepare('UPDATE transactions SET metadata = ? WHERE id = ?').run(JSON.stringify(next), tx.id);
  return next;
}

function remember(event, status, { transactionId = null, detail = null } = {}) {
  const at = nowIso();
  db.prepare(
    `INSERT INTO stripe_events (id, type, livemode, transaction_id, status, detail, created_at, processed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, detail = excluded.detail, processed_at = excluded.processed_at`,
  ).run(
    String(event.id),
    String(event.type || 'unknown'),
    event.livemode ? 1 : 0,
    transactionId,
    status,
    detail ? String(detail).slice(0, 500) : null,
    at,
    at,
  );
}

function alreadyProcessed(eventId) {
  const row = db.prepare('SELECT status FROM stripe_events WHERE id = ?').get(eventId);
  return Boolean(row && row.status === 'processed');
}

function resolveTransaction(session) {
  const id = session?.client_reference_id || session?.metadata?.transaction_id;
  return id ? getTransaction(id) : null;
}

function findByPaymentIntent(paymentIntentId) {
  if (!paymentIntentId) return null;
  try {
    const match = db
      .prepare(
        `SELECT * FROM transactions
         WHERE provider = 'stripe' AND json_extract(metadata, '$.stripePaymentIntent') = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(paymentIntentId);
    if (match) return match;
  } catch {
    /* fall through to the text match below on older SQLite builds */
  }
  return db
    .prepare("SELECT * FROM transactions WHERE provider = 'stripe' AND metadata LIKE ? ORDER BY created_at DESC LIMIT 1")
    .get(`%${paymentIntentId}%`);
}

function handleCheckoutPaid(event) {
  const session = event.data.object || {};
  const tx = resolveTransaction(session);
  if (!tx) return { status: 'ignored', detail: 'no matching transaction' };
  if (tx.status === 'completed') return { status: 'processed', detail: 'already credited', transactionId: tx.id };
  if (tx.type !== 'deposit') return { status: 'ignored', detail: 'not a deposit', transactionId: tx.id };
  if (session.payment_status && session.payment_status !== 'paid') {
    return { status: 'ignored', detail: `payment_status ${session.payment_status}`, transactionId: tx.id };
  }

  const taxCents = Number(session.total_details?.amount_tax || 0);
  const feeCents = Number(session.metadata?.fee_cents || 0);
  const totalCents = Number(session.amount_total || 0);
  const principalCents = totalCents - taxCents - feeCents;
  const currencyOk = String(session.currency || '').toLowerCase() === 'usd';
  const referenceOk = String(session.client_reference_id || '') === tx.id;
  const amountOk = principalCents === tx.amount_cents;

  if (!currencyOk || !referenceOk || !amountOk) {
    const parked = failTransaction(tx.id, { reason: 'gateway_amount_mismatch', nextStatus: 'review' });
    saveMetadata(parked, {
      stage: 'manual_review',
      stripeSessionId: session.id,
      expectedCents: tx.amount_cents,
      receivedCents: principalCents,
      taxCents,
      feeCents,
      reviewReason: currencyOk ? 'amount_mismatch' : 'currency_mismatch',
    });
    createFraudAlert({
      userId: tx.user_id,
      transactionId: tx.id,
      severity: 'high',
      ruleCode: 'gateway_amount_mismatch',
      message: `Stripe session ${session.id} reported ${formatUSD(totalCents)} (principal ${formatUSD(principalCents)}) for deposit ${tx.reference} of ${formatUSD(tx.amount_cents)}.`,
    });
    notifyAdmins({ title: 'Deposit needs review', body: `Gateway amount did not match deposit ${tx.reference}.`, kind: 'alert' });
    notify(tx.user_id, {
      title: 'Deposit under review',
      body: `We received a card payment for deposit ${tx.reference} that did not match the requested amount. No funds were credited yet; our team is reviewing it.`,
      kind: 'alert',
    });
    recordAudit({
      action: 'deposit.gateway_mismatch',
      targetType: 'transaction',
      targetId: tx.id,
      metadata: { sessionId: session.id, principalCents, taxCents, feeCents, totalCents },
    });
    return { status: 'review', detail: 'amount mismatch', transactionId: tx.id };
  }

  const settled = settleTransaction(tx.id, { note: `stripe ${event.type} ${event.id}` });
  saveMetadata(settled, {
    gateway: 'stripe_checkout',
    stage: 'paid',
    stripeSessionId: session.id,
    stripePaymentIntent:
      typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null,
    stripeEventId: event.id,
    taxCents,
    feeCents,
    totalCents,
    taxCountry: session.customer_details?.address?.country || null,
    taxIds: (session.customer_details?.tax_ids || [])
      .map((entry) => `${entry.type}:${entry.value}`)
      .filter(Boolean),
  });

  notify(tx.user_id, {
    title: 'Deposit credited',
    body: `${formatUSD(tx.amount_cents)} was credited after Stripe confirmed the card payment. Reference ${tx.reference}.`,
    kind: 'transaction',
  });
  recordAudit({
    action: 'deposit.settled',
    targetType: 'transaction',
    targetId: tx.id,
    metadata: { provider: 'stripe', sessionId: session.id, amountCents: tx.amount_cents, taxCents, feeCents },
  });
  return { status: 'processed', transactionId: tx.id };
}

function handleCheckoutFailed(event) {
  const session = event.data.object || {};
  const tx = resolveTransaction(session);
  if (!tx) return { status: 'ignored', detail: 'no matching transaction' };
  if (tx.status !== 'pending') return { status: 'ignored', detail: `status ${tx.status}`, transactionId: tx.id };

  const failureCode = session.last_payment_error?.code || 'async_payment_failed';
  const updated = failTransaction(tx.id, { reason: failureCode });
  saveMetadata(updated, { stage: 'failed', stripeSessionId: session.id, failureCode });
  notify(tx.user_id, {
    title: 'Deposit did not complete',
    body: `The card payment for deposit ${tx.reference} did not succeed. No funds were credited.`,
    kind: 'alert',
  });
  recordAudit({
    action: 'deposit.failed',
    targetType: 'transaction',
    targetId: tx.id,
    metadata: { provider: 'stripe', sessionId: session.id, failureCode },
  });
  return { status: 'processed', transactionId: tx.id };
}

function handleIntentFailed(event) {
  const intent = event.data.object || {};
  const tx = intent.metadata?.transaction_id ? getTransaction(intent.metadata.transaction_id) : null;
  if (!tx) return { status: 'ignored', detail: 'no matching transaction' };
  if (tx.status !== 'pending') return { status: 'ignored', detail: `status ${tx.status}`, transactionId: tx.id };

  const failureCode = intent.last_payment_error?.code || 'payment_intent_failed';
  const updated = failTransaction(tx.id, { reason: failureCode });
  saveMetadata(updated, { stage: 'failed', stripePaymentIntent: intent.id, failureCode });
  notify(tx.user_id, {
    title: 'Deposit did not complete',
    body: `The card payment for deposit ${tx.reference} was declined (${failureCode}). No funds were credited.`,
    kind: 'alert',
  });
  return { status: 'processed', transactionId: tx.id };
}

function handleRefund(event) {
  const charge = event.data.object || {};
  const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
  const tx = findByPaymentIntent(paymentIntentId);
  if (!tx) return { status: 'ignored', detail: 'no matching transaction' };

  const refundCents = Number(charge.amount_refunded || 0);
  saveMetadata(tx, { refundedCents: refundCents, refundedAt: nowIso(), stripeChargeId: charge.id });
  createFraudAlert({
    userId: tx.user_id,
    transactionId: tx.id,
    severity: 'medium',
    ruleCode: 'gateway_refund',
    message: `Stripe refunded ${formatUSD(refundCents)} on transaction ${tx.reference}. Reconcile the ledger entry.`,
  });
  notifyAdmins({
    title: 'Gateway refund recorded',
    body: `Stripe refunded ${formatUSD(refundCents)} on ${tx.reference}. Review the ledger before adjusting the balance.`,
    kind: 'alert',
  });
  recordAudit({
    action: 'deposit.refunded',
    targetType: 'transaction',
    targetId: tx.id,
    metadata: { provider: 'stripe', chargeId: charge.id, refundCents },
  });
  return { status: 'processed', detail: 'refund recorded', transactionId: tx.id };
}

function handleDispute(event) {
  const dispute = event.data.object || {};
  const paymentIntentId = typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent?.id;
  const tx = findByPaymentIntent(paymentIntentId);

  createFraudAlert({
    userId: tx?.user_id || null,
    transactionId: tx?.id || null,
    severity: 'high',
    ruleCode: 'gateway_dispute',
    message: `Stripe dispute ${dispute.id} opened for ${formatUSD(Number(dispute.amount || 0))} (reason: ${dispute.reason || 'unknown'}).`,
  });
  notifyAdmins({ title: 'Card dispute opened', body: `Dispute ${dispute.id} needs evidence in the Stripe dashboard.`, kind: 'alert' });
  recordAudit({
    action: 'dispute.opened',
    targetType: 'transaction',
    targetId: tx?.id || null,
    metadata: { provider: 'stripe', disputeId: dispute.id, reason: dispute.reason || null, amount: Number(dispute.amount || 0) },
  });
  return { status: 'processed', detail: 'dispute recorded', transactionId: tx?.id || null };
}

function processEvent(event) {
  if (!event || typeof event !== 'object' || !event.id || !event.type) {
    return { ok: false, status: 'malformed' };
  }
  if (alreadyProcessed(event.id)) {
    return { ok: true, duplicate: true, status: 'duplicate' };
  }

  let outcome;
  if (PAID_EVENTS.has(event.type)) outcome = handleCheckoutPaid(event);
  else if (event.type === 'checkout.session.async_payment_failed') outcome = handleCheckoutFailed(event);
  else if (event.type === 'payment_intent.payment_failed') outcome = handleIntentFailed(event);
  else if (event.type === 'charge.refunded') outcome = handleRefund(event);
  else if (event.type === 'charge.dispute.created') outcome = handleDispute(event);
  else outcome = { status: 'ignored', detail: `unhandled ${event.type}` };

  remember(event, outcome.status, { transactionId: outcome.transactionId, detail: outcome.detail });
  return { ok: true, status: outcome.status, transactionId: outcome.transactionId || null };
}

module.exports = { processEvent, PAID_EVENTS };
