'use strict';

const express = require('express');

const config = require('../config');
const { db, nowIso } = require('../db');
const { requireAuth, requireActiveAccount, requireVerified, verifyTransactionPin } = require('../services/sessions');
const {
  accountSummary,
  accountByNumber,
  insertTransaction,
  serializeTransaction,
  getTransactionForUser,
  internalTransfer,
  validateAmount,
} = require('../services/ledger');
const { lookupRecipient } = require('../services/lookup');
const { evaluateOutgoing, recordAlerts } = require('../services/fraud');
const { recordAudit, notify } = require('../services/audit');
const { parseAmountToCents, formatUSD } = require('../money');
const { badRequest, conflict, notFound, AppError } = require('../errors');

const router = express.Router();

router.post('/', requireAuth, requireActiveAccount, requireVerified, async (req, res) => {
  const body = req.body || {};
  const amountCents = parseAmountToCents(body.amount);
  validateAmount(amountCents, {
    min: config.limits.minTransferCents,
    max: config.limits.maxTransferCents,
    label: 'transfer amount',
  });
  const description = String(body.description || '').trim().slice(0, 140);
  verifyTransactionPin(req.user, body.pin);

  if (body.idempotencyKey) {
    const existing = db
      .prepare("SELECT * FROM transactions WHERE user_id = ? AND provider_ref = ? AND type = 'transfer_out'")
      .get(req.user.id, String(body.idempotencyKey));
    if (existing) {
      return res.json({
        transaction: serializeTransaction(existing),
        duplicate: true,
        message: 'This transfer was already submitted.',
      });
    }
  }

  const lookup = await lookupRecipient({
    bankId: body.bankId,
    routingNumber: body.routingNumber,
    accountNumber: body.accountNumber,
  });

  if (lookup.status === 'not_found') {
    throw badRequest(lookup.message || 'We could not verify that recipient account.', 'recipient_not_found', {
      lookup,
    });
  }

  const available = accountSummary(req.account).availableBalanceCents;
  if (amountCents > available) {
    throw conflict(
      `Insufficient available balance. Available to transfer: ${formatUSD(available)}.`,
      'insufficient_funds',
    );
  }

  const internalAccount =
    lookup.internal && lookup.status === 'verified' ? accountByNumber(String(body.accountNumber).replace(/\D/g, '')) : null;
  if (internalAccount && internalAccount.id === req.account.id) {
    throw badRequest('You cannot transfer to the same account.', 'same_account');
  }

  const fraud = evaluateOutgoing({
    userId: req.user.id,
    accountId: req.account.id,
    amountCents,
    kind: 'Transfer',
  });

  // Internal transfers settle immediately between Northvale accounts.
  if (internalAccount) {
    const result = internalTransfer({
      fromAccount: req.account,
      toAccount: internalAccount,
      amountCents,
      description: description || `Transfer to ${lookup.name}`,
      recipientName: lookup.name,
    });
    db.prepare('UPDATE transactions SET provider_ref = ? WHERE id = ?').run(
      body.idempotencyKey ? String(body.idempotencyKey) : null,
      result.out.id,
    );
    recordAlerts({ userId: req.user.id, transactionId: result.out.id, alerts: fraud.alerts });
    notify(req.user.id, {
      title: 'Transfer completed',
      body: `${formatUSD(amountCents)} was sent to ${lookup.name} (reference ${result.out.reference}).`,
      kind: 'transaction',
    });
    notify(internalAccount.user_id, {
      title: 'Money received',
      body: `${formatUSD(amountCents)} was deposited to your account (reference ${result.incoming.reference}).`,
      kind: 'transaction',
    });
    recordAudit({
      actorId: req.user.id,
      actorEmail: req.user.email,
      action: 'transfer.internal_completed',
      targetType: 'transaction',
      targetId: result.out.id,
      ip: req.ip,
      metadata: { amountCents, recipient: lookup.name },
    });
    return res.status(201).json({
      transaction: serializeTransaction(result.out),
      lookup,
      status: 'completed',
      message: `Transfer complete. ${formatUSD(amountCents)} was sent to ${lookup.name}.`,
      receiptUrl: `/api/account/transactions/${result.out.id}/receipt`,
    });
  }

  // External transfers are queued: funds are held until settlement is confirmed.
  const requiresReview = fraud.requiresReview;
  const tx = insertTransaction({
    user_id: req.user.id,
    account_id: req.account.id,
    type: 'transfer_out',
    direction: 'debit',
    amount_cents: amountCents,
    status: 'pending',
    description: description || `External transfer to ${lookup.name || 'recipient'}`,
    channel: 'external',
    method: 'ach',
    counterparty_name: lookup.name || null,
    counterparty_account: String(body.accountNumber || '').replace(/\D/g, ''),
    counterparty_bank: lookup.bankName,
    counterparty_routing: lookup.routingNumber,
    provider: lookup.source === 'external_directory' ? 'bank_directory' : 'manual_review',
    provider_ref: body.idempotencyKey ? String(body.idempotencyKey) : null,
    metadata: {
      recipientVerification: lookup.status,
      recipientVerificationSource: lookup.source,
      requiresReview,
      reviewReason: requiresReview ? 'High-risk transfer rules' : null,
      internalRecipient: false,
    },
  });

  recordAlerts({ userId: req.user.id, transactionId: tx.id, alerts: fraud.alerts });
  notify(req.user.id, {
    title: requiresReview ? 'Transfer held for review' : 'Transfer submitted',
    body: requiresReview
      ? `Your ${formatUSD(amountCents)} transfer is on hold while our fraud team reviews it. Reference ${tx.reference}.`
      : `Your ${formatUSD(amountCents)} transfer was submitted and is awaiting settlement. Reference ${tx.reference}.`,
    kind: 'transaction',
  });
  recordAudit({
    actorId: req.user.id,
    actorEmail: req.user.email,
    action: 'transfer.external_submitted',
    targetType: 'transaction',
    targetId: tx.id,
    ip: req.ip,
    metadata: { amountCents, bank: lookup.bankName, verification: lookup.status },
  });

  res.status(201).json({
    transaction: serializeTransaction(tx),
    lookup,
    status: 'pending',
    message: requiresReview
      ? 'Transfer submitted and held for fraud review. Funds are on hold until the review completes.'
      : 'Transfer submitted. Funds are on hold until the receiving institution confirms settlement.',
    receiptUrl: `/api/account/transactions/${tx.id}/receipt`,
  });
});

router.post('/:id/cancel', requireAuth, (req, res) => {
  const tx = getTransactionForUser(req.params.id, req.user.id);
  if (!tx) throw notFound('Transfer not found.');
  if (tx.type !== 'transfer_out') throw badRequest('Only outgoing transfers can be cancelled.', 'not_transfer');
  if (tx.status !== 'pending') {
    throw conflict('Only pending transfers can be cancelled.', 'not_cancellable');
  }
  const now = nowIso();
  db.prepare("UPDATE transactions SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, tx.id);
  notify(req.user.id, {
    title: 'Transfer cancelled',
    body: `Transfer ${tx.reference} was cancelled and the held funds were released.`,
    kind: 'transaction',
  });
  recordAudit({
    actorId: req.user.id,
    actorEmail: req.user.email,
    action: 'transfer.cancelled',
    targetType: 'transaction',
    targetId: tx.id,
    ip: req.ip,
  });
  res.json({ ok: true, transaction: serializeTransaction(db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id)) });
});

module.exports = router;
