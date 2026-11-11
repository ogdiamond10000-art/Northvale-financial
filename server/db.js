'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const config = require('./config');
const {
  newId,
  newReference,
  hashSecret,
  generateAccountNumber,
  generateRoutingNumber,
} = require('./security');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  dob TEXT NOT NULL,
  ssn_last4 TEXT,
  id_document_type TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer',
  kyc_status TEXT NOT NULL DEFAULT 'unverified',
  kyc_note TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  twofa_secret TEXT,
  twofa_enabled INTEGER NOT NULL DEFAULT 0,
  pin_hash TEXT,
  pin_failures INTEGER NOT NULL DEFAULT 0,
  pin_locked_until TEXT,
  login_notifications INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  verified_at TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_number TEXT NOT NULL UNIQUE,
  routing_number TEXT NOT NULL,
  account_type TEXT NOT NULL,
  nickname TEXT,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  opened_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  direction TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  description TEXT,
  channel TEXT NOT NULL,
  method TEXT,
  counterparty_name TEXT,
  counterparty_account TEXT,
  counterparty_bank TEXT,
  counterparty_routing TEXT,
  provider TEXT,
  provider_ref TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'info',
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  actor_email TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  ip TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fraud_alerts (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  transaction_id TEXT,
  severity TEXT NOT NULL,
  rule_code TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT
);

-- Every Stripe webhook delivery, so redelivered events are never applied twice.
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 0,
  transaction_id TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  detail TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS biometric_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
`);

const nowIso = () => new Date().toISOString();
const daysAgo = (days, hours = 0) =>
  new Date(Date.now() - days * 86400000 - hours * 3600000).toISOString();

function insertUser(user) {
  const id = user.id || newId('usr');
  db.prepare(
    `INSERT INTO users (id, first_name, last_name, email, phone, address_line1, address_line2, city, state,
       postal_code, dob, ssn_last4, id_document_type, password_hash, role, kyc_status, status, twofa_secret,
       twofa_enabled, pin_hash, login_notifications, created_at, last_login_at, verified_at)
     VALUES (@id, @first_name, @last_name, @email, @phone, @address_line1, @address_line2, @city, @state,
       @postal_code, @dob, @ssn_last4, @id_document_type, @password_hash, @role, @kyc_status, @status, @twofa_secret,
       @twofa_enabled, @pin_hash, @login_notifications, @created_at, @last_login_at, @verified_at)`,
  ).run({
    id,
    address_line2: null,
    ssn_last4: null,
    id_document_type: null,
    twofa_secret: null,
    twofa_enabled: 0,
    pin_hash: null,
    login_notifications: 1,
    last_login_at: null,
    verified_at: null,
    status: 'active',
    kyc_status: 'verified',
    role: 'customer',
    ...user,
    id,
  });
  return id;
}

function insertAccount(account) {
  const id = account.id || newId('acct');
  db.prepare(
    `INSERT INTO accounts (id, user_id, account_number, routing_number, account_type, nickname, balance_cents, status, opened_at)
     VALUES (@id, @user_id, @account_number, @routing_number, @account_type, @nickname, @balance_cents, @status, @opened_at)`,
  ).run({
    id,
    nickname: null,
    balance_cents: 0,
    status: 'active',
    routing_number: generateRoutingNumber(),
    ...account,
    id,
  });
  return id;
}

function insertSeedTransaction(tx) {
  const id = newId('txn');
  db.prepare(
    `INSERT INTO transactions (id, reference, user_id, account_id, type, direction, amount_cents, status, description,
      channel, method, counterparty_name, counterparty_account, counterparty_bank, counterparty_routing, provider,
      provider_ref, metadata, created_at, updated_at, settled_at)
     VALUES (@id, @reference, @user_id, @account_id, @type, @direction, @amount_cents, @status, @description,
      @channel, @method, @counterparty_name, @counterparty_account, @counterparty_bank, @counterparty_routing, @provider,
      @provider_ref, @metadata, @created_at, @updated_at, @settled_at)`,
  ).run({
    id,
    reference: newReference(),
    method: null,
    counterparty_name: null,
    counterparty_account: null,
    counterparty_bank: null,
    counterparty_routing: null,
    provider: null,
    provider_ref: null,
    metadata: null,
    settled_at: tx.created_at,
    ...tx,
    id,
  });
  return id;
}

function seed() {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM users').get();
  if (existing.count > 0 || !config.seedDemoData) return;

  const run = db.transaction(() => {
    const adminId = insertUser({
      first_name: 'Jordan',
      last_name: 'Reyes',
      email: 'admin@northvale.com',
      phone: '+1 (415) 555-0110',
      address_line1: '500 Market Street',
      address_line2: 'Suite 2100',
      city: 'San Francisco',
      state: 'CA',
      postal_code: '94105',
      dob: '1984-04-18',
      password_hash: hashSecret('Admin#2026'),
      role: 'admin',
      kyc_status: 'verified',
      created_at: daysAgo(420),
      verified_at: daysAgo(418),
    });
    insertAccount({
      user_id: adminId,
      account_number: '4400100021',
      account_type: 'checking',
      nickname: 'Operations',
      balance_cents: 2500000,
      opened_at: daysAgo(420),
    });

    const demoId = insertUser({
      first_name: 'Alex',
      last_name: 'Morgan',
      email: 'alex.morgan@example.com',
      phone: '+1 (212) 555-0148',
      address_line1: '1180 Sixth Avenue',
      address_line2: 'Apt 12B',
      city: 'New York',
      state: 'NY',
      postal_code: '10036',
      dob: '1991-09-02',
      ssn_last4: '4417',
      id_document_type: 'drivers_license',
      password_hash: hashSecret('Northvale#2026'),
      pin_hash: hashSecret('246810'),
      kyc_status: 'verified',
      created_at: daysAgo(180),
      last_login_at: daysAgo(1),
      verified_at: daysAgo(179),
    });
    const checkingId = insertAccount({
      user_id: demoId,
      account_number: '4400117742',
      account_type: 'checking',
      nickname: 'Everyday Checking',
      balance_cents: 1248055,
      opened_at: daysAgo(180),
    });
    insertAccount({
      user_id: demoId,
      account_number: '4400117743',
      account_type: 'savings',
      nickname: 'High-Yield Savings',
      balance_cents: 3150000,
      opened_at: daysAgo(180),
    });

    const recipientId = insertUser({
      first_name: 'Priya',
      last_name: 'Nair',
      email: 'priya.nair@example.com',
      phone: '+1 (312) 555-0173',
      address_line1: '233 South Wacker Drive',
      address_line2: null,
      city: 'Chicago',
      state: 'IL',
      postal_code: '60606',
      dob: '1988-01-25',
      password_hash: hashSecret('Northvale#2026'),
      pin_hash: hashSecret('135790'),
      kyc_status: 'verified',
      created_at: daysAgo(240),
      verified_at: daysAgo(239),
    });
    insertAccount({
      user_id: recipientId,
      account_number: '4400128871',
      account_type: 'checking',
      nickname: 'Everyday Checking',
      balance_cents: 842300,
      opened_at: daysAgo(240),
    });

    insertSeedTransaction({
      user_id: demoId,
      account_id: checkingId,
      type: 'deposit',
      direction: 'credit',
      amount_cents: 425000,
      status: 'completed',
      description: 'Payroll deposit — Meridian Studio',
      channel: 'external',
      method: 'ach',
      counterparty_name: 'Meridian Studio LLC',
      provider: 'demo_seed',
      created_at: daysAgo(12),
      updated_at: daysAgo(12),
    });
    insertSeedTransaction({
      user_id: demoId,
      account_id: checkingId,
      type: 'transfer_out',
      direction: 'debit',
      amount_cents: 125000,
      status: 'completed',
      description: 'Rent — September',
      channel: 'external',
      method: 'ach',
      counterparty_name: 'Hudson Property Group',
      counterparty_bank: 'JPMorgan Chase Bank, N.A.',
      counterparty_account: '•••• 4412',
      created_at: daysAgo(9),
      updated_at: daysAgo(9),
    });
    insertSeedTransaction({
      user_id: demoId,
      account_id: checkingId,
      type: 'withdrawal',
      direction: 'debit',
      amount_cents: 20000,
      status: 'completed',
      description: 'ATM withdrawal — Midtown branch',
      channel: 'external',
      method: 'atm',
      created_at: daysAgo(6),
      updated_at: daysAgo(6),
    });
    insertSeedTransaction({
      user_id: demoId,
      account_id: checkingId,
      type: 'transfer_out',
      direction: 'debit',
      amount_cents: 45000,
      status: 'completed',
      description: 'Dinner split',
      channel: 'internal',
      counterparty_name: 'Priya Nair',
      counterparty_account: '4400128871',
      counterparty_bank: 'Northvale Financial',
      counterparty_routing: generateRoutingNumber(),
      created_at: daysAgo(3),
      updated_at: daysAgo(3),
    });
    insertSeedTransaction({
      user_id: demoId,
      account_id: checkingId,
      type: 'deposit',
      direction: 'credit',
      amount_cents: 75000,
      status: 'pending',
      description: 'Card deposit awaiting settlement',
      channel: 'card',
      method: 'card',
      provider: 'demo_seed',
      created_at: daysAgo(0, 5),
      updated_at: daysAgo(0, 5),
      settled_at: null,
    });

    const notification = db.prepare(
      'INSERT INTO notifications (id, user_id, title, body, kind, read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    notification.run(
      newId('ntf'),
      demoId,
      'Welcome to Northvale',
      'Your Everyday Checking account ending 7742 is open and ready to use.',
      'account',
      1,
      daysAgo(180),
    );
    notification.run(
      newId('ntf'),
      demoId,
      'Payroll deposit posted',
      'A deposit of $4,250.00 from Meridian Studio LLC posted to your account.',
      'transaction',
      1,
      daysAgo(12),
    );
    notification.run(
      newId('ntf'),
      demoId,
      'Card deposit in review',
      'A $750.00 card deposit is awaiting settlement confirmation from the payment processor.',
      'transaction',
      0,
      daysAgo(0, 5),
    );
  });

  run();
}

seed();

module.exports = { db, nowIso, daysAgo };
