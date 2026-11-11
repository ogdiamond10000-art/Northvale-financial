'use strict';

const express = require('express');

const { db, nowIso } = require('../db');
const { requireAuth, requireAdmin, publicUser, destroySession } = require('../services/sessions');
const {
  serializeTransaction,
  settleTransaction,
  failTransaction,
  accountSummary,
} = require('../services/ledger');
const { recordAudit, notify } = require('../services/audit');
const directory = require('../services/directory');
const payments = require('../services/payments');
const { formatUSD } = require('../money');
const { badRequest, notFound, conflict, asyncHandler } = require('../errors');

const router = express.Router();

router.use(requireAuth, requireAdmin);

/** Stripe gateway + tax state, recent webhook deliveries and reconciliation totals. */
router.get('/payments', asyncHandler(async (req, res) => {
  const gateway = payments.gatewayStatus();
  const tax = await payments.taxStatus();

  const events = db
    .prepare(
      `SELECT id, type, livemode, transaction_id, status, detail, created_at, processed_at
       FROM stripe_events ORDER BY created_at DESC LIMIT 25`,
    )
    .all();

  const byStatus = db
    .prepare(
      `SELECT status, COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS volume
       FROM transactions WHERE provider = 'stripe' AND type = 'deposit' GROUP BY status`,
    )
    .all()
    .map((row) => ({ status: row.status, count: row.count, volumeCents: row.volume, volume: formatUSD(row.volume) }));

  const taxTotals = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(json_extract(metadata, '$.taxCents')), 0) AS taxCents,
              COALESCE(SUM(json_extract(metadata, '$.feeCents')), 0) AS feeCents,
              COALESCE(SUM(json_extract(metadata, '$.totalCents')), 0) AS totalCents
       FROM transactions
       WHERE provider = 'stripe' AND status = 'completed'`,
    )
    .get();

  const needsReview = db
    .prepare("SELECT COUNT(*) AS count FROM transactions WHERE provider = 'stripe' AND status = 'review'")
    .get();

  res.json({
    gateway,
    tax,
    events,
    deposits: byStatus,
    taxTotals: {
      count: taxTotals.count,
      taxCents: taxTotals.taxCents,
      feeCents: taxTotals.feeCents,
      totalCents: taxTotals.totalCents,
      tax: formatUSD(taxTotals.taxCents),
      fees: formatUSD(taxTotals.feeCents),
      total: formatUSD(taxTotals.totalCents),
    },
    needsReview: needsReview.count,
  });
}));

function adminUserRow(user) {
  const account = db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY opened_at ASC LIMIT 1').get(user.id);
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(amount_cents),0) AS volume FROM transactions
       WHERE user_id = ? AND status = 'completed'`,
    )
    .get(user.id);
  return {
    ...publicUser(user),
    ssnLast4: user.ssn_last4,
    idDocumentType: user.id_document_type,
    account: account ? accountSummary(account) : null,
    activity: { completedCount: totals.count, completedVolumeCents: totals.volume, completedVolume: formatUSD(totals.volume) },
    openAlerts: db
      .prepare("SELECT COUNT(*) AS count FROM fraud_alerts WHERE user_id = ? AND status = 'open'")
      .get(user.id).count,
  };
}

router.get('/overview', (req, res) => {
  const totals = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE role = 'customer') AS customers,
         (SELECT COUNT(*) FROM users WHERE role = 'customer' AND kyc_status = 'pending') AS pendingKyc,
         (SELECT COUNT(*) FROM users WHERE role = 'customer' AND status = 'frozen') AS frozen,
         (SELECT COALESCE(SUM(balance_cents),0) FROM accounts) AS depositsHeld,
         (SELECT COUNT(*) FROM transactions WHERE status = 'pending') AS pendingTx,
         (SELECT COALESCE(SUM(amount_cents),0) FROM transactions WHERE status = 'pending' AND direction = 'debit') AS pendingOut,
         (SELECT COUNT(*) FROM fraud_alerts WHERE status = 'open') AS openAlerts,
         (SELECT COUNT(*) FROM transactions WHERE status = 'completed') AS completedTx,
         (SELECT COUNT(*) FROM transactions WHERE status = 'failed') AS failedTx,
         (SELECT COUNT(*) FROM transactions WHERE status = 'cancelled') AS cancelledTx`,
    )
    .get();

  const recent = db
    .prepare(
      `SELECT t.*, u.first_name, u.last_name, u.email FROM transactions t
       JOIN users u ON u.id = t.user_id
       ORDER BY t.created_at DESC LIMIT 8`,
    )
    .all();

  res.json({
    totals: {
      ...totals,
      depositsHeldFormatted: formatUSD(totals.depositsHeld),
      pendingOutFormatted: formatUSD(totals.pendingOut),
    },
    recent: recent.map((row) => ({
      ...serializeTransaction(row),
      customer: { name: `${row.first_name} ${row.last_name}`, email: row.email },
    })),
  });
});

router.get('/directory', (req, res) => {
  res.json({ directory: directory.status() });
});

router.post(
  '/directory/test',
  asyncHandler(async (req, res) => {
    const result = await directory.testConnection();
    recordAudit({
      actorId: req.user.id,
      actorEmail: req.user.email,
      action: 'admin.directory_test',
      targetType: 'system',
      targetId: 'bank_directory',
      ip: req.ip,
      metadata: { ok: result.ok, reason: result.reason || null, latencyMs: result.latencyMs || null },
    });
    res.json(result);
  }),
);

router.get('/customers', (req, res) => {
  const search = String(req.query.q || '').trim().toLowerCase();
  const status = String(req.query.status || 'all');
  const kyc = String(req.query.kyc || 'all');
  const clauses = ["u.role = 'customer'"];
  const params = [];
  if (search) {
    clauses.push(
      "(LOWER(u.first_name || ' ' || u.last_name) LIKE ? OR LOWER(u.email) LIKE ? OR u.phone LIKE ? OR a.account_number LIKE ?)",
    );
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (status !== 'all') {
    clauses.push('u.status = ?');
    params.push(status);
  }
  if (kyc !== 'all') {
    clauses.push('u.kyc_status = ?');
    params.push(kyc);
  }
  const rows = db
    .prepare(
      `SELECT u.*, a.account_number, a.account_type, a.balance_cents, a.status AS account_status
       FROM users u LEFT JOIN accounts a ON a.user_id = u.id
       WHERE ${clauses.join(' AND ')}
       GROUP BY u.id
       ORDER BY u.created_at DESC LIMIT 100`,
    )
    .all(...params);

  res.json({
    customers: rows.map((row) => ({
      id: row.id,
      name: `${row.first_name} ${row.last_name}`,
      email: row.email,
      phone: row.phone,
      state: row.state,
      accountNumber: row.account_number,
      accountType: row.account_type,
      balanceCents: row.balance_cents || 0,
      balance: formatUSD(row.balance_cents || 0),
      status: row.status,
      kycStatus: row.kyc_status,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
    })),
  });
});

router.get('/customers/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) throw notFound('Customer not found.');
  const accounts = db.prepare('SELECT * FROM accounts WHERE user_id = ?').all(user.id).map(accountSummary);
  const transactions = db
    .prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(user.id)
    .map(serializeTransaction);
  const alerts = db
    .prepare('SELECT * FROM fraud_alerts WHERE user_id = ? ORDER BY created_at DESC LIMIT 25')
    .all(user.id);
  const audits = db
    .prepare('SELECT * FROM audit_logs WHERE target_id = ? OR actor_id = ? ORDER BY created_at DESC LIMIT 25')
    .all(user.id, user.id);
  res.json({ customer: adminUserRow(user), accounts, transactions, alerts, audits });
});

router.post('/customers/:id/kyc', (req, res) => {
  const { decision, note } = req.body || {};
  if (!['verified', 'rejected', 'pending'].includes(decision)) {
    throw badRequest('Choose a verification decision.', 'decision_invalid');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) throw notFound('Customer not found.');
  if (user.role === 'admin') throw conflict('Administrator accounts are verified automatically.', 'admin_target');

  const now = nowIso();
  db.prepare('UPDATE users SET kyc_status = ?, kyc_note = ?, verified_at = ? WHERE id = ?').run(
    decision,
    String(note || '').slice(0, 400) || null,
    decision === 'verified' ? now : null,
    user.id,
  );
  notify(user.id, {
    title:
      decision === 'verified'
        ? 'Identity verified'
        : decision === 'rejected'
          ? 'Identity verification needs attention'
          : 'Identity verification under review',
    body:
      decision === 'verified'
        ? 'Your identity has been verified. All account features are now available.'
        : decision === 'rejected'
          ? `We could not verify your identity. ${String(note || 'Contact support for next steps.').slice(0, 200)}`
          : 'Your identity documents are back in review.',
    kind: 'security',
  });
  recordAudit({
    actorId: req.user.id,
    actorEmail: req.user.email,
    action: `kyc.${decision}`,
    targetType: 'user',
    targetId: user.id,
    ip: req.ip,
    metadata: { note: note || null },
  });
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({ customer: adminUserRow(updated), message: `Verification status set to ${decision}.` });
});

router.post('/customers/:id/status', (req, res) => {
  const { status, reason } = req.body || {};
  if (!['active', 'frozen', 'closed'].includes(status)) {
    throw badRequest('Choose a valid account status.', 'status_invalid');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) throw notFound('Customer not found.');
  if (user.role === 'admin' && status !== 'active') {
    throw conflict('Administrator accounts cannot be frozen from this console.', 'admin_target');
  }
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, user.id);
  if (status !== 'active') {
    db.prepare('UPDATE accounts SET status = ? WHERE user_id = ?').run(status === 'closed' ? 'closed' : 'frozen', user.id);
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(nowIso(), user.id);
  } else {
    db.prepare("UPDATE accounts SET status = 'active' WHERE user_id = ?").run(user.id);
  }
  notify(user.id, {
    title:
      status === 'frozen'
        ? 'Account access restricted'
        : status === 'closed'
          ? 'Account closed'
          : 'Account restored',
    body:
      status === 'active'
        ? 'Your account access has been restored.'
        : `Your account status changed to ${status}. ${String(reason || 'Contact support for details.').slice(0, 200)}`,
    kind: 'security',
  });
  recordAudit({
    actorId: req.user.id,
    actorEmail: req.user.email,
    action: `customer.status_${status}`,
    targetType: 'user',
    targetId: user.id,
    ip: req.ip,
    metadata: { reason: reason || null },
  });
  res.json({ customer: adminUserRow(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
});

router.get('/transactions', (req, res) => {
  const clauses = ['1 = 1'];
  const params = [];
  const status = String(req.query.status || 'all');
  const type = String(req.query.type || 'all');
  const search = String(req.query.q || '').trim().toLowerCase();
  if (status !== 'all') {
    clauses.push('t.status = ?');
    params.push(status);
  }
  if (type !== 'all') {
    clauses.push('t.type = ?');
    params.push(type);
  }
  if (search) {
    clauses.push(
      "(LOWER(t.reference) LIKE ? OR LOWER(COALESCE(t.description,'')) LIKE ? OR LOWER(COALESCE(t.counterparty_name,'')) LIKE ? OR LOWER(u.email) LIKE ?)",
    );
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  const limit = Math.min(Number(req.query.limit) || 100, 300);
  const rows = db
    .prepare(
      `SELECT t.*, u.first_name, u.last_name, u.email FROM transactions t
       JOIN users u ON u.id = t.user_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY t.created_at DESC LIMIT ?`,
    )
    .all(...params, limit);
  res.json({
    transactions: rows.map((row) => ({
      ...serializeTransaction(row),
      customer: { id: row.user_id, name: `${row.first_name} ${row.last_name}`, email: row.email },
    })),
  });
});

router.post('/transactions/:id/settle', (req, res) => {
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('Transaction not found.');
  const settled = settleTransaction(row.id, { actorId: req.user.id, note: req.body?.note });
  notify(row.user_id, {
    title: 'Transaction completed',
    body: `${formatUSD(row.amount_cents)} ${row.type.replace(/_/g, ' ')} (${row.reference}) has been processed and settled.`,
    kind: 'transaction',
  });
  recordAudit({
    actorId: req.user.id,
    actorEmail: req.user.email,
    action: 'transaction.settled',
    targetType: 'transaction',
    targetId: row.id,
    ip: req.ip,
    metadata: { reference: row.reference, amountCents: row.amount_cents },
  });
  res.json({ transaction: serializeTransaction(settled), message: 'Transaction settled.' });
});

router.post('/transactions/:id/fail', (req, res) => {
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('Transaction not found.');
  const nextStatus = req.body?.status === 'cancelled' ? 'cancelled' : 'failed';
  const updated = failTransaction(row.id, {
    actorId: req.user.id,
    reason: String(req.body?.reason || 'declined_by_operations').slice(0, 200),
    nextStatus,
  });
  notify(row.user_id, {
    title: nextStatus === 'cancelled' ? 'Transaction cancelled' : 'Transaction failed',
    body: `${formatUSD(row.amount_cents)} ${row.type.replace(/_/g, ' ')} (${row.reference}) was ${
      nextStatus === 'cancelled' ? 'cancelled' : 'declined'
    }. ${String(req.body?.reason || '').slice(0, 160)}`.trim(),
    kind: 'transaction',
  });
  recordAudit({
    actorId: req.user.id,
    actorEmail: req.user.email,
    action: `transaction.${nextStatus}`,
    targetType: 'transaction',
    targetId: row.id,
    ip: req.ip,
    metadata: { reason: req.body?.reason || null },
  });
  res.json({ transaction: serializeTransaction(updated), message: `Transaction marked ${nextStatus}.` });
});

router.get('/alerts', (req, res) => {
  const status = String(req.query.status || 'open');
  const rows = db
    .prepare(
      `SELECT f.*, u.first_name, u.last_name, u.email, t.reference FROM fraud_alerts f
       LEFT JOIN users u ON u.id = f.user_id
       LEFT JOIN transactions t ON t.id = f.transaction_id
       ${status === 'all' ? '' : 'WHERE f.status = ?'}
       ORDER BY f.created_at DESC LIMIT 100`,
    )
    .all(...(status === 'all' ? [] : [status]));
  res.json({
    alerts: rows.map((row) => ({
      id: row.id,
      severity: row.severity,
      ruleCode: row.rule_code,
      message: row.message,
      status: row.status,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
      transactionId: row.transaction_id,
      reference: row.reference,
      customer: row.user_id ? { id: row.user_id, name: `${row.first_name} ${row.last_name}`, email: row.email } : null,
    })),
  });
});

router.post('/alerts/:id', (req, res) => {
  const alert = db.prepare('SELECT * FROM fraud_alerts WHERE id = ?').get(req.params.id);
  if (!alert) throw notFound('Alert not found.');
  const status = req.body?.status === 'dismissed' ? 'dismissed' : 'resolved';
  db.prepare('UPDATE fraud_alerts SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?').run(
    status,
    nowIso(),
    req.user.id,
    alert.id,
  );
  recordAudit({
    actorId: req.user.id,
    actorEmail: req.user.email,
    action: `fraud_alert.${status}`,
    targetType: 'fraud_alert',
    targetId: alert.id,
    ip: req.ip,
    metadata: { ruleCode: alert.rule_code },
  });
  res.json({ ok: true, status });
});

router.get('/reconciliation', (req, res) => {
  const deposits = db
    .prepare(
      `SELECT t.*, u.first_name, u.last_name, u.email FROM transactions t JOIN users u ON u.id = t.user_id
       WHERE t.type = 'deposit' AND t.status IN ('pending','completed','failed','cancelled')
       ORDER BY t.created_at DESC LIMIT 60`,
    )
    .all();
  const withdrawals = db
    .prepare(
      `SELECT t.*, u.first_name, u.last_name, u.email FROM transactions t JOIN users u ON u.id = t.user_id
       WHERE t.type = 'withdrawal'
       ORDER BY t.created_at DESC LIMIT 60`,
    )
    .all();
  const summary = db
    .prepare(
      `SELECT type, status, COUNT(*) AS count, COALESCE(SUM(amount_cents),0) AS total
       FROM transactions GROUP BY type, status`,
    )
    .all();
  const decorate = (row) => ({
    ...serializeTransaction(row),
    customer: { id: row.user_id, name: `${row.first_name} ${row.last_name}`, email: row.email },
  });
  res.json({
    deposits: deposits.map(decorate),
    withdrawals: withdrawals.map(decorate),
    summary: summary.map((row) => ({ ...row, totalFormatted: formatUSD(row.total) })),
    ledgerTotalCents: db.prepare('SELECT COALESCE(SUM(balance_cents),0) AS total FROM accounts').get().total,
  });
});

router.get('/audit-logs', (req, res) => {
  const search = String(req.query.q || '').trim().toLowerCase();
  const rows = db
    .prepare(
      `SELECT * FROM audit_logs
       ${search ? "WHERE LOWER(action) LIKE ? OR LOWER(COALESCE(actor_email,'')) LIKE ?" : ''}
       ORDER BY created_at DESC LIMIT 200`,
    )
    .all(...(search ? [`%${search}%`, `%${search}%`] : []));
  res.json({
    logs: rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorEmail: row.actor_email,
      targetType: row.target_type,
      targetId: row.target_id,
      ip: row.ip,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      createdAt: row.created_at,
    })),
  });
});

router.post('/sign-out-all', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

module.exports = router;
