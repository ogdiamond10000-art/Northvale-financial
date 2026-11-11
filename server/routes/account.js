'use strict';

const express = require('express');

const config = require('../config');
const { db, nowIso } = require('../db');
const { requireAuth, publicUser } = require('../services/sessions');
const {
  accountSummary,
  listTransactions,
  serializeTransaction,
  getTransactionForUser,
} = require('../services/ledger');
const { searchBanks } = require('../data/banks');
const directory = require('../services/directory');
const { lookupRecipient } = require('../services/lookup');
const { notFound, badRequest, asyncHandler } = require('../errors');
const validate = require('../validate');
const { recordAudit } = require('../services/audit');
const { formatUSD } = require('../money');

const router = express.Router();

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (char) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}

router.get('/account', requireAuth, (req, res) => {
  const account = req.account;
  if (!account) return res.json({ user: null, account: null });
  const summary = accountSummary(account);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const totals = db
    .prepare(
      `SELECT direction, COALESCE(SUM(amount_cents), 0) AS total
       FROM transactions WHERE account_id = ? AND status = 'completed' AND created_at >= ?
       GROUP BY direction`,
    )
    .all(account.id, monthStart.toISOString());
  const pending = db
    .prepare("SELECT COUNT(*) AS count FROM transactions WHERE account_id = ? AND status = 'pending'")
    .get(account.id).count;
  const unread = db
    .prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read = 0')
    .get(req.user.id).count;

  res.json({
    account: summary,
    stats: {
      monthInCents: totals.find((row) => row.direction === 'credit')?.total || 0,
      monthOutCents: totals.find((row) => row.direction === 'debit')?.total || 0,
      monthIn: formatUSD(totals.find((row) => row.direction === 'credit')?.total || 0),
      monthOut: formatUSD(totals.find((row) => row.direction === 'debit')?.total || 0),
      pendingCount: pending,
      unreadNotifications: unread,
    },
    bank: {
      name: config.brand.name,
      routingNumber: config.brand.routingNumber,
    },
  });
});

router.get('/account/transactions', requireAuth, (req, res) => {
  if (!req.account) return res.json({ transactions: [], total: 0 });
  const { rows, total, limit, offset } = listTransactions(req.account.id, {
    status: req.query.status,
    type: req.query.type,
    direction: req.query.direction,
    search: req.query.q,
    from: req.query.from,
    to: req.query.to,
    limit: req.query.limit,
    offset: req.query.offset,
  });
  res.json({ transactions: rows.map(serializeTransaction), total, limit, offset });
});

router.get('/account/transactions/:id', requireAuth, (req, res) => {
  const row = getTransactionForUser(req.params.id, req.user.id);
  if (!row) throw notFound('Transaction not found.');
  res.json({ transaction: serializeTransaction(row) });
});

router.get('/account/transactions/:id/receipt', requireAuth, (req, res) => {
  const row = getTransactionForUser(req.params.id, req.user.id);
  if (!row) throw notFound('Transaction not found.');
  const tx = serializeTransaction(row);
  const account = req.account;
  const statusLabel = tx.status.charAt(0).toUpperCase() + tx.status.slice(1);
  const created = new Date(tx.createdAt);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Northvale Financial receipt ${escapeHtml(tx.reference)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: Georgia, 'Times New Roman', serif; margin: 0; background: #f4f6f9; color: #0b1522; }
  .sheet { max-width: 720px; margin: 32px auto; background: #fff; padding: 48px; border: 1px solid #dfe4ea; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #0a1f3c; padding-bottom: 20px; }
  .brand { font-size: 24px; letter-spacing: 4px; text-transform: uppercase; color: #0a1f3c; font-weight: bold; }
  .brand span { display: block; font-family: Arial, sans-serif; font-size: 10px; letter-spacing: 3px; color: #6b7a8d; margin-top: 6px; }
  .amount { text-align: right; font-size: 30px; color: #0a1f3c; }
  .amount small { display: block; font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 2px; color: #6b7a8d; text-transform: uppercase; }
  table { width: 100%; border-collapse: collapse; margin-top: 28px; font-family: Arial, sans-serif; font-size: 13px; }
  td { padding: 11px 0; border-bottom: 1px solid #eef1f5; vertical-align: top; }
  td:first-child { color: #6b7a8d; width: 42%; text-transform: uppercase; letter-spacing: 1px; font-size: 11px; }
  .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; background: #e8eef7; color: #0a1f3c; }
  footer { margin-top: 32px; font-family: Arial, sans-serif; font-size: 11px; line-height: 1.6; color: #6b7a8d; border-top: 1px solid #eef1f5; padding-top: 16px; }
  @media print { body { background: #fff; } .sheet { border: none; margin: 0; padding: 24px; } }
</style></head>
<body><div class="sheet">
  <header>
    <div>
      <div class="brand">Northvale<span>Financial</span></div>
      <div style="font-family:Arial,sans-serif;font-size:11px;color:#6b7a8d;margin-top:10px;">Transaction receipt</div>
    </div>
    <div class="amount">${escapeHtml(tx.direction === 'debit' ? `-${tx.amount}` : tx.amount)}
      <small>${escapeHtml(tx.direction === 'debit' ? 'Debited' : 'Credited')} · USD</small>
    </div>
  </header>
  <table>
    <tr><td>Reference</td><td>${escapeHtml(tx.reference)}</td></tr>
    <tr><td>Status</td><td><span class="badge">${escapeHtml(statusLabel)}</span></td></tr>
    <tr><td>Date &amp; time</td><td>${escapeHtml(created.toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }))} UTC</td></tr>
    <tr><td>Type</td><td>${escapeHtml(tx.type.replace(/_/g, ' '))}</td></tr>
    <tr><td>Description</td><td>${escapeHtml(tx.description || '—')}</td></tr>
    <tr><td>From account</td><td>${escapeHtml(account ? `${account.nickname || account.account_type} · ${account.account_number}` : '—')}</td></tr>
    <tr><td>Recipient</td><td>${escapeHtml(tx.counterparty.name || (tx.direction === 'credit' ? 'Northvale Financial' : '—'))}</td></tr>
    <tr><td>Recipient account</td><td>${escapeHtml(tx.counterparty.account || '—')}</td></tr>
    <tr><td>Institution</td><td>${escapeHtml(tx.counterparty.bank || config.brand.name)}</td></tr>
    <tr><td>Routing number</td><td>${escapeHtml(tx.counterparty.routing || config.brand.routingNumber)}</td></tr>
    <tr><td>Channel</td><td>${escapeHtml(tx.channel)}</td></tr>
    <tr><td>Method</td><td>${escapeHtml(tx.method || '—')}</td></tr>
  </table>
  <footer>
    Northvale Financial is a financial technology company, not a bank. Banking services are provided by partner
    institutions once authorised; until then this receipt records activity within the Northvale platform ledger only.
    Questions? Reference ${escapeHtml(tx.reference)} when contacting support.
  </footer>
</div></body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="northvale-receipt-${tx.reference}.html"`);
  res.send(html);
});

router.get('/notifications', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(req.user.id);
  res.json({
    notifications: rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      kind: row.kind,
      read: Boolean(row.read),
      createdAt: row.created_at,
    })),
    unread: rows.filter((row) => !row.read).length,
  });
});

router.post('/notifications/:id/read', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

router.post('/notifications/read-all', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

router.get(
  '/banks',
  asyncHandler(async (req, res) => {
    const query = String(req.query.q || '').trim().slice(0, 60);
    const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 20);

    // Live directory first; the bundled list keeps the selector usable when the
    // provider is not configured, is rate limited or returns nothing.
    const live = await directory.searchDirectory(query, limit);
    if (live && live.length) {
      return res.json({ banks: live, query, source: 'directory' });
    }
    res.json({ banks: searchBanks(query, limit), query, source: 'local' });
  }),
);

router.post('/recipients/lookup', requireAuth, async (req, res, next) => {
  try {
    const result = await lookupRecipient(req.body || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Fast-registration follow-up: customers add their address, date of birth and
// contact details after the account already exists.
router.patch('/account/profile', requireAuth, (req, res) => {
  const user = req.user;
  const body = req.body || {};

  const phone = body.phone ? validate.phone(body.phone) : user.phone;
  const dateOfBirth = body.dob ? validate.dob(body.dob) : user.dob || '';

  let address = {
    line1: user.address_line1 || '',
    line2: user.address_line2 || null,
    city: user.city || '',
    state: user.state || '',
    postalCode: user.postal_code || '',
  };
  if (body.address && Object.keys(body.address).length > 0) {
    const incoming = body.address;
    address = {
      line1: validate.text(incoming.line1, 'Street address', { max: 120 }),
      line2: incoming.line2 ? validate.text(incoming.line2, 'Address line 2', { max: 120 }) : null,
      city: validate.text(incoming.city, 'City', { max: 80 }),
      state: validate.state(incoming.state),
      postalCode: validate.postalCode(incoming.postalCode),
    };
  }

  if (!address.line1 && !address.city && !address.state && !address.postalCode && !dateOfBirth) {
    throw badRequest('Add your address and date of birth to complete your profile.', 'profile_empty');
  }

  db.prepare(
    `UPDATE users
        SET phone = ?, address_line1 = ?, address_line2 = ?, city = ?, state = ?, postal_code = ?, dob = ?
      WHERE id = ?`,
  ).run(
    phone,
    address.line1,
    address.line2,
    address.city,
    address.state,
    address.postalCode,
    dateOfBirth,
    user.id,
  );

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  recordAudit({
    actorId: user.id,
    actorRole: user.role,
    action: 'customer.profile_updated',
    targetType: 'user',
    targetId: user.id,
    metadata: {
      phone: phone !== user.phone,
      address: address.line1 !== (user.address_line1 || ''),
      dateOfBirth: dateOfBirth !== (user.dob || ''),
      at: nowIso(),
    },
  });

  res.json({
    user: publicUser(updated),
    message: publicUser(updated).profileComplete
      ? 'Profile complete. Identity verification is under review.'
      : 'Profile saved. Add the remaining details to finish verification.',
  });
});

module.exports = router;
