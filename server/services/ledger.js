'use strict';

const { db, nowIso } = require('../db');
const { newId, newReference } = require('../security');
const { formatUSD } = require('../money');
const { AppError, badRequest } = require('../errors');

const NORTHVALE_ROUTING = require('../config').brand.routingNumber;

function accountForUser(userId) {
  return (
    db.prepare("SELECT * FROM accounts WHERE user_id = ? AND status = 'active' ORDER BY opened_at ASC LIMIT 1").get(userId) ||
    db.prepare('SELECT * FROM accounts ORDER BY opened_at ASC LIMIT 0').get(userId) ||
    null
  );
}

function accountById(accountId) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) || null;
}

function accountByNumber(accountNumber) {
  return db.prepare('SELECT * FROM accounts WHERE account_number = ?').get(String(accountNumber)) || null;
}

function pendingDebitsCents(accountId) {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions WHERE account_id = ? AND direction = 'debit' AND status IN ('pending', 'on_hold')",
    )
    .get(accountId);
  return row.total;
}

function pendingCreditsCents(accountId) {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions WHERE account_id = ? AND direction = 'credit' AND status IN ('pending', 'on_hold')",
    )
    .get(accountId);
  return row.total;
}

function accountSummary(account) {
  if (!account) return null;
  const holds = pendingDebitsCents(account.id);
  const incoming = pendingCreditsCents(account.id);
  return {
    id: account.id,
    accountNumber: account.account_number,
    routingNumber: account.routing_number,
    accountType: account.account_type,
    nickname: account.nickname,
    status: account.status,
    openedAt: account.opened_at,
    currentBalanceCents: account.balance_cents,
    availableBalanceCents: Math.max(0, account.balance_cents - holds),
    pendingHoldsCents: holds,
    pendingCreditsCents: incoming,
    currentBalance: formatUSD(account.balance_cents),
    availableBalance: formatUSD(Math.max(0, account.balance_cents - holds)),
  };
}

function serializeTransaction(row) {
  if (!row) return null;
  let metadata = {};
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      metadata = {};
    }
  }
  return {
    id: row.id,
    reference: row.reference,
    type: row.type,
    direction: row.direction,
    amountCents: row.amount_cents,
    amount: formatUSD(row.amount_cents),
    status: row.status,
    description: row.description,
    channel: row.channel,
    method: row.method,
    counterparty: {
      name: row.counterparty_name,
      account: row.counterparty_account,
      bank: row.counterparty_bank,
      routing: row.counterparty_routing,
    },
    provider: row.provider,
    providerRef: row.provider_ref,
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
    accountId: row.account_id,
  };
}

function insertTransaction(data) {
  const id = newId('txn');
  const reference = data.reference || newReference();
  const now = nowIso();
  db.prepare(
    `INSERT INTO transactions (id, reference, user_id, account_id, type, direction, amount_cents, status, description,
      channel, method, counterparty_name, counterparty_account, counterparty_bank, counterparty_routing, provider,
      provider_ref, metadata, created_at, updated_at, settled_at)
     VALUES (@id, @reference, @user_id, @account_id, @type, @direction, @amount_cents, @status, @description,
      @channel, @method, @counterparty_name, @counterparty_account, @counterparty_bank, @counterparty_routing, @provider,
      @provider_ref, @metadata, @created_at, @updated_at, @settled_at)`,
  ).run({
    id,
    reference,
    status: 'pending',
    description: null,
    channel: 'internal',
    method: null,
    counterparty_name: null,
    counterparty_account: null,
    counterparty_bank: null,
    counterparty_routing: null,
    provider: null,
    provider_ref: null,
    metadata: null,
    created_at: now,
    updated_at: now,
    settled_at: null,
    ...data,
    metadata: data.metadata ? JSON.stringify(data.metadata) : null,
    id,
    reference,
  });
  return getTransaction(id);
}

function getTransaction(id) {
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) || null;
}

function getTransactionForUser(id, userId) {
  return db.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').get(id, userId) || null;
}

function listTransactions(accountId, options = {}) {
  const clauses = ['account_id = ?'];
  const params = [accountId];
  if (options.status && options.status !== 'all') {
    clauses.push('status = ?');
    params.push(options.status);
  }
  if (options.type && options.type !== 'all') {
    clauses.push('type = ?');
    params.push(options.type);
  }
  if (options.direction && options.direction !== 'all') {
    clauses.push('direction = ?');
    params.push(options.direction);
  }
  if (options.from) {
    clauses.push('created_at >= ?');
    params.push(options.from);
  }
  if (options.to) {
    clauses.push('created_at <= ?');
    params.push(options.to);
  }
  if (options.search) {
    const term = `%${String(options.search).trim().toLowerCase()}%`;
    clauses.push(
      '(LOWER(reference) LIKE ? OR LOWER(COALESCE(description, \'\')) LIKE ? OR LOWER(COALESCE(counterparty_name, \'\')) LIKE ? OR LOWER(COALESCE(counterparty_account, \'\')) LIKE ?)',
    );
    params.push(term, term, term, term);
  }
  const limit = Math.min(Number(options.limit) || 50, 200);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const rows = db
    .prepare(
      `SELECT * FROM transactions WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  const total = db
    .prepare(`SELECT COUNT(*) AS count FROM transactions WHERE ${clauses.join(' AND ')}`)
    .get(...params).count;
  return { rows, total, limit, offset };
}

const settleTransactionTx = db.transaction((txId, { actorId, note, fromStatuses = ['pending'] } = {}) => {
  const row = getTransaction(txId);
  if (!row) throw new AppError(404, 'Transaction not found.', 'not_found');
  if (!fromStatuses.includes(row.status)) {
    throw new AppError(409, 'Only pending transactions can be settled.', 'not_pending');
  }
  const account = accountById(row.account_id);
  if (!account) throw new AppError(404, 'Account not found.', 'not_found');
  const now = nowIso();
  if (row.direction === 'credit') {
    db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?').run(row.amount_cents, account.id);
  } else {
    if (account.balance_cents < row.amount_cents) {
      throw new AppError(409, 'The account does not hold enough settled funds to complete this transaction.', 'insufficient_funds');
    }
    db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?').run(row.amount_cents, account.id);
  }
  let metadata = {};
  try {
    metadata = row.metadata ? JSON.parse(row.metadata) : {};
  } catch {
    metadata = {};
  }
  if (note) metadata.reconciliationNote = note;
  if (actorId) metadata.settledBy = actorId;
  db.prepare(
    'UPDATE transactions SET status = ?, updated_at = ?, settled_at = ?, metadata = ? WHERE id = ?',
  ).run('completed', now, now, JSON.stringify(metadata), txId);
  return getTransaction(txId);
});

function settleTransaction(txId, options) {
  return settleTransactionTx(txId, options);
}

const failTransactionTx = db.transaction((txId, { actorId, reason, nextStatus = 'failed' } = {}) => {
  const row = getTransaction(txId);
  if (!row) throw new AppError(404, 'Transaction not found.', 'not_found');
  if (row.status !== 'pending') {
    throw new AppError(409, 'Only pending transactions can be updated.', 'not_pending');
  }
  let metadata = {};
  try {
    metadata = row.metadata ? JSON.parse(row.metadata) : {};
  } catch {
    metadata = {};
  }
  if (reason) metadata.failureReason = reason;
  if (actorId) metadata.reviewedBy = actorId;
  db.prepare('UPDATE transactions SET status = ?, updated_at = ?, metadata = ? WHERE id = ?').run(
    nextStatus,
    nowIso(),
    JSON.stringify(metadata),
    txId,
  );
  return getTransaction(txId);
});

function failTransaction(txId, options) {
  return failTransactionTx(txId, options);
}

/**
 * Moves a pending transaction onto an operations hold. The funds stay committed
 * (available balance already nets holds) but nothing settles until an operator
 * releases it after verification.
 */
const holdTransactionTx = db.transaction((txId, { actorId, reason } = {}) => {
  const row = getTransaction(txId);
  if (!row) throw new AppError(404, 'Transaction not found.', 'not_found');
  if (row.status !== 'pending') {
    throw new AppError(409, 'Only pending transactions can be placed on hold.', 'not_holdable');
  }
  let metadata = {};
  try {
    metadata = row.metadata ? JSON.parse(row.metadata) : {};
  } catch {
    metadata = {};
  }
  const now = nowIso();
  metadata.holdReason = String(reason || 'Held for operations verification').slice(0, 200);
  metadata.heldBy = actorId || null;
  metadata.heldAt = now;
  db.prepare("UPDATE transactions SET status = 'on_hold', updated_at = ?, metadata = ? WHERE id = ?").run(
    now,
    JSON.stringify(metadata),
    txId,
  );
  return getTransaction(txId);
});

function holdTransaction(txId, options) {
  return holdTransactionTx(txId, options);
}

/** Releases a hold by settling the transaction through the normal ledger path. */
function releaseTransaction(txId, options = {}) {
  const row = getTransaction(txId);
  if (!row) throw new AppError(404, 'Transaction not found.', 'not_found');
  if (row.status !== 'on_hold') {
    throw new AppError(409, 'Only transactions on hold can be released.', 'not_on_hold');
  }
  return settleTransactionTx(txId, { ...options, fromStatuses: ['on_hold'] });
}

/**
 * Documented, auditable balance adjustment. Writes a completed ledger entry so
 * the customer sees the movement in their history and the reason is preserved.
 */
const adjustBalanceTx = db.transaction(({ accountId, amountCents, reason, actorId, actorEmail, ticket } = {}) => {
  const account = accountById(accountId);
  if (!account) throw new AppError(404, 'Account not found.', 'not_found');
  if (!Number.isInteger(amountCents) || amountCents === 0) {
    throw new AppError(400, 'Enter a non-zero adjustment amount.', 'amount_invalid');
  }
  const note = String(reason || '').trim();
  if (note.length < 8) {
    throw new AppError(400, 'Document the reason for this adjustment (at least 8 characters).', 'reason_required');
  }
  const before = account.balance_cents;
  const after = before + amountCents;
  if (after < 0) {
    throw new AppError(409, 'The adjustment would overdraw the account.', 'insufficient_funds');
  }
  db.prepare('UPDATE accounts SET balance_cents = ? WHERE id = ?').run(after, accountId);
  const now = nowIso();
  const transaction = insertTransaction({
    user_id: account.user_id,
    account_id: account.id,
    type: 'adjustment',
    direction: amountCents > 0 ? 'credit' : 'debit',
    amount_cents: Math.abs(amountCents),
    status: 'completed',
    description: `Balance adjustment — ${note}`,
    channel: 'internal',
    method: 'adjustment',
    settled_at: now,
    metadata: {
      adjustment: true,
      reason: note,
      ticket: ticket ? String(ticket).slice(0, 60) : null,
      balanceBeforeCents: before,
      balanceAfterCents: after,
      adjustedBy: actorId || null,
      adjustedByEmail: actorEmail || null,
    },
  });
  return { transaction, balanceBeforeCents: before, balanceAfterCents: after };
});

function adjustBalance(options) {
  return adjustBalanceTx(options);
}

const internalTransferTx = db.transaction(({ fromAccount, toAccount, amountCents, description, recipientName, channel = 'internal' }) => {
  const sender = accountById(fromAccount.id);
  if (!sender) throw new AppError(404, 'Account not found.', 'not_found');
  if (sender.balance_cents < amountCents) {
    throw new AppError(409, 'Insufficient available balance for this transfer.', 'insufficient_funds');
  }
  db.prepare('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?').run(amountCents, sender.id);
  db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?').run(amountCents, toAccount.id);

  const out = insertTransaction({
    user_id: sender.user_id,
    account_id: sender.id,
    type: 'transfer_out',
    direction: 'debit',
    amount_cents: amountCents,
    status: 'completed',
    description,
    channel,
    counterparty_name: recipientName,
    counterparty_account: toAccount.account_number,
    counterparty_bank: 'Northvale Financial',
    counterparty_routing: toAccount.routing_number,
    settled_at: nowIso(),
  });
  const incoming = insertTransaction({
    user_id: toAccount.user_id,
    account_id: toAccount.id,
    type: 'transfer_in',
    direction: 'credit',
    amount_cents: amountCents,
    status: 'completed',
    description: description || `Transfer from ${sender.nickname || 'Northvale account'}`,
    channel,
    counterparty_name: null,
    counterparty_account: sender.account_number,
    counterparty_bank: 'Northvale Financial',
    counterparty_routing: sender.routing_number,
    settled_at: nowIso(),
  });
  return { out: getTransaction(out.id), incoming: getTransaction(incoming.id) };
});

function validateAmount(cents, { min, max, label = 'amount' }) {
  if (cents < min) {
    throw badRequest(`The minimum ${label} is ${formatUSD(min)}.`, 'amount_below_minimum');
  }
  if (cents > max) {
    throw badRequest(`The maximum ${label} is ${formatUSD(max)}.`, 'amount_above_maximum');
  }
}

module.exports = {
  NORTHVALE_ROUTING,
  accountForUser,
  accountById,
  accountByNumber,
  pendingDebitsCents,
  pendingCreditsCents,
  accountSummary,
  serializeTransaction,
  insertTransaction,
  getTransaction,
  getTransactionForUser,
  listTransactions,
  holdTransaction,
  releaseTransaction,
  adjustBalance,
  settleTransaction,
  failTransaction,
  internalTransfer: (payload) => internalTransferTx(payload),
  validateAmount,
};
