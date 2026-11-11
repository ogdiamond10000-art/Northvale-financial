'use strict';

const express = require('express');

const config = require('../config');
const { requireAuth, requireActiveAccount, requireVerified, verifyTransactionPin } = require('../services/sessions');
const {
  accountSummary,
  insertTransaction,
  serializeTransaction,
  validateAmount,
} = require('../services/ledger');
const { lookupRecipient } = require('../services/lookup');
const { evaluateOutgoing, recordAlerts } = require('../services/fraud');
const { assertOutgoingAllowed } = require('../services/system');
const { recordAudit, notify } = require('../services/audit');
const { parseAmountToCents, formatUSD } = require('../money');
const { badRequest, conflict, asyncHandler } = require('../errors');

const router = express.Router();

const METHODS = [
  {
    id: 'ach',
    label: 'Bank transfer (ACH)',
    description: 'Funds are held while operations verifies the destination account, then released to the receiving bank.',
    requiresBank: true,
    processingTime: '1–3 business days',
  },
  {
    id: 'wire',
    label: 'Domestic wire',
    description: 'Same-business-day wire to a US institution after operations approval.',
    requiresBank: true,
    processingTime: 'Same business day',
  },
  {
    id: 'check',
    label: 'Paper check',
    description: 'A check is mailed to the residential address on your profile.',
    requiresBank: false,
    processingTime: '5–7 business days',
  },
];

router.get('/methods', requireAuth, (req, res) => {
  res.json({ methods: METHODS });
});

router.post('/', requireAuth, requireActiveAccount, requireVerified, asyncHandler(async (req, res) => {
  const body = req.body || {};
  assertOutgoingAllowed({ internal: false });
  const method = METHODS.find((entry) => entry.id === body.method);
  if (!method) throw badRequest('Select a withdrawal method.', 'method_invalid');

  const amountCents = parseAmountToCents(body.amount);
  validateAmount(amountCents, {
    min: config.limits.minWithdrawalCents,
    max: config.limits.maxWithdrawalCents,
    label: 'withdrawal amount',
  });
  const description = String(body.description || '').trim().slice(0, 140);
  verifyTransactionPin(req.user, body.pin);

  const available = accountSummary(req.account).availableBalanceCents;
  if (amountCents > available) {
    throw conflict(`Insufficient available balance. Available to withdraw: ${formatUSD(available)}.`, 'insufficient_funds');
  }

  let lookup = null;
  let destination = null;
  if (method.requiresBank) {
    lookup = await lookupRecipient({
      bankId: body.bankId,
      routingNumber: body.routingNumber,
      accountNumber: body.accountNumber,
    });
    if (lookup.status === 'not_found') {
      throw badRequest(lookup.message || 'We could not verify that destination account.', 'recipient_not_found', { lookup });
    }
    destination = {
      name: lookup.name || null,
      account: String(body.accountNumber || '').replace(/\D/g, ''),
      bank: lookup.bankName,
      routing: lookup.routingNumber,
    };
  }

  const fraud = evaluateOutgoing({
    userId: req.user.id,
    accountId: req.account.id,
    amountCents,
    kind: 'Withdrawal',
  });

  const tx = insertTransaction({
    user_id: req.user.id,
    account_id: req.account.id,
    type: 'withdrawal',
    direction: 'debit',
    amount_cents: amountCents,
    status: 'pending',
    description: description || `${method.label} withdrawal`,
    channel: method.id === 'check' ? 'check' : 'external',
    method: method.id,
    counterparty_name: destination ? destination.name : 'Check payable to account holder',
    counterparty_account: destination ? destination.account : null,
    counterparty_bank: destination ? destination.bank : config.brand.name,
    counterparty_routing: destination ? destination.routing : null,
    metadata: {
      methodLabel: method.label,
      processingTime: method.processingTime,
      recipientVerification: lookup ? lookup.status : 'not_required',
      requiresReview: true,
      reviewReason: fraud.requiresReview ? 'High-risk withdrawal rules' : 'Operations verification before payout',
      payoutRailConnected: false,
      mailTo: method.id === 'check' ? `${req.user.address_line1}, ${req.user.city}, ${req.user.state} ${req.user.postal_code}` : null,
    },
  });

  recordAlerts({ userId: req.user.id, transactionId: tx.id, alerts: fraud.alerts });
  notify(req.user.id, {
    title: 'Withdrawal submitted',
    body: `${formatUSD(amountCents)} ${method.label.toLowerCase()} withdrawal is pending. Funds are on hold until operations completes verification. Reference ${tx.reference}.`,
    kind: 'transaction',
  });
  recordAudit({
    actorId: req.user.id,
    actorEmail: req.user.email,
    action: 'withdrawal.submitted',
    targetType: 'transaction',
    targetId: tx.id,
    ip: req.ip,
    metadata: { amountCents, method: method.id },
  });

  res.status(201).json({
    transaction: serializeTransaction(tx),
    lookup,
    method,
    status: 'pending',
    message: `Withdrawal submitted for processing. ${formatUSD(amountCents)} is on hold until the payout is verified and released.`,
    receiptUrl: `/api/account/transactions/${tx.id}/receipt`,
  });
}));

module.exports = router;
