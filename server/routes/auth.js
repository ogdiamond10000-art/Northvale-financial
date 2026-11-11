'use strict';

const express = require('express');

const config = require('../config');
const { db, nowIso } = require('../db');
const {
  hashSecret,
  verifySecret,
  generateAccountNumber,
  generateRoutingNumber,
  generateTotpSecret,
  verifyTotp,
  newId,
  createRateLimiter,
} = require('../security');
const validate = require('../validate');
const { AppError, badRequest, unauthorized } = require('../errors');
const { recordAudit, notify, notifyAdmins } = require('../services/audit');
const {
  publicUser,
  createSession,
  destroySession,
  requireAuth,
  recordLogin,
  currentContext,
} = require('../services/sessions');
const { accountSummary } = require('../services/ledger');

const router = express.Router();

const registerLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Too many account applications from this network. Please try again later.',
});

const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 8,
  message: 'Too many sign-in attempts. Please wait 15 minutes before trying again.',
  keyFn: (req) => `${req.ip}:${String(req.body?.email || '').toLowerCase()}`,
});

function uniqueAccountNumber() {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = generateAccountNumber();
    const exists = db.prepare('SELECT 1 FROM accounts WHERE account_number = ?').get(candidate);
    if (!exists) return candidate;
  }
  throw new AppError(500, 'Could not allocate an account number. Please try again.', 'account_number_failed');
}

router.post('/register', registerLimiter, (req, res) => {
  const body = req.body || {};
  const address = body.address || {};
  const identity = body.identity || {};

  const firstName = validate.name(body.firstName, 'First name');
  const lastName = validate.name(body.lastName, 'Last name');
  const email = validate.email(body.email);
  const phone = validate.phone(body.phone);
  const line1 = validate.text(address.line1, 'Street address', { max: 120 });
  const line2 = address.line2 ? validate.text(address.line2, 'Address line 2', { max: 120 }) : null;
  const city = validate.text(address.city, 'City', { max: 80 });
  const state = validate.state(address.state);
  const postalCode = validate.postalCode(address.postalCode);
  const dateOfBirth = validate.dob(body.dob);
  const password = validate.password(body.password);
  const accountType = validate.accountType(body.accountType);
  const ssnLast4 = validate.ssnLast4(identity.ssnLast4);
  const idType = ['drivers_license', 'state_id', 'passport', 'us_passport'].includes(identity.idType)
    ? identity.idType
    : 'drivers_license';
  const transactionPin = validate.pin(body.pin, { required: true });
  if (body.consent !== true) {
    throw badRequest('You must accept the account agreement and electronic disclosures.', 'consent_required');
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    throw new AppError(409, 'An account already exists for that email address.', 'email_taken');
  }

  const now = nowIso();
  const userId = newId('usr');
  const accountNumber = uniqueAccountNumber();

  const create = db.transaction(() => {
    db.prepare(
      `INSERT INTO users (id, first_name, last_name, email, phone, address_line1, address_line2, city, state,
        postal_code, dob, ssn_last4, id_document_type, password_hash, role, kyc_status, status, pin_hash,
        login_notifications, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'customer', 'pending', 'active', ?, 1, ?)`,
    ).run(
      userId,
      firstName,
      lastName,
      email,
      phone,
      line1,
      line2,
      city,
      state,
      postalCode,
      dateOfBirth,
      ssnLast4,
      idType,
      hashSecret(password),
      hashSecret(transactionPin),
      now,
    );

    db.prepare(
      `INSERT INTO accounts (id, user_id, account_number, routing_number, account_type, nickname, balance_cents, status, opened_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?)`,
    ).run(newId('acct'), userId, accountNumber, generateRoutingNumber(), accountType, null, now);

    notify(userId, {
      title: 'Welcome to Northvale Financial',
      body: `Your ${accountType.replace('_', ' ')} account ending ${accountNumber.slice(-4)} is open. Identity verification is now under review.`,
      kind: 'account',
    });
    notifyAdmins({
      title: 'New identity verification request',
      body: `${firstName} ${lastName} submitted an application for a ${accountType.replace('_', ' ')} account.`,
      kind: 'admin',
    });
    recordAudit({
      actorId: userId,
      actorEmail: email,
      action: 'account.registered',
      targetType: 'user',
      targetId: userId,
      ip: req.ip,
      metadata: { accountNumber, accountType },
    });
  });
  create();

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  createSession(userId, req, res);
  recordLogin(user, req);

  const account = db.prepare('SELECT * FROM accounts WHERE user_id = ?').get(userId);
  res.status(201).json({
    user: publicUser(user),
    account: accountSummary(account),
    message: 'Account created. Identity verification is under review.',
  });
});

router.post('/login', loginLimiter, (req, res) => {
  const body = req.body || {};
  const email = validate.email(body.email);
  const passwordValue = String(body.password || '');
  if (!passwordValue) throw badRequest('Enter your password.', 'password_required');

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifySecret(passwordValue, user.password_hash)) {
    recordAudit({
      action: 'auth.login_failed',
      actorEmail: email,
      targetType: 'user',
      targetId: user ? user.id : null,
      ip: req.ip,
    });
    throw unauthorized('Email or password is incorrect.', 'invalid_credentials');
  }
  if (user.status === 'closed') {
    throw new AppError(403, 'This account is closed. Contact support for assistance.', 'account_closed');
  }

  if (user.twofa_enabled) {
    const challengeId = newId('chl');
    db.prepare(
      'INSERT INTO auth_challenges (id, user_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      challengeId,
      user.id,
      'login_2fa',
      nowIso(),
      new Date(Date.now() + 5 * 60000).toISOString(),
    );
    return res.json({
      twoFactorRequired: true,
      challengeId,
      message: 'Enter the 6-digit code from your authenticator app.',
    });
  }

  createSession(user.id, req, res);
  recordLogin(user, req);
  const account = db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY opened_at LIMIT 1').get(user.id);
  return res.json({ user: publicUser(user), account: accountSummary(account) });
});

router.post('/login/verify-2fa', loginLimiter, (req, res) => {
  const { challengeId, code } = req.body || {};
  if (!challengeId) throw badRequest('Verification session missing. Sign in again.', 'challenge_missing');
  const challenge = db.prepare('SELECT * FROM auth_challenges WHERE id = ?').get(challengeId);
  if (!challenge || challenge.purpose !== 'login_2fa' || challenge.consumed_at) {
    throw unauthorized('That verification session is no longer valid. Sign in again.', 'challenge_invalid');
  }
  if (new Date(challenge.expires_at).getTime() < Date.now()) {
    throw unauthorized('The verification code expired. Sign in again.', 'challenge_expired');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(challenge.user_id);
  if (!user || !user.twofa_enabled) throw unauthorized('Two-factor authentication is not enabled.', 'twofa_disabled');
  if (!verifyTotp(user.twofa_secret, code)) {
    recordAudit({
      actorId: user.id,
      actorEmail: user.email,
      action: 'auth.2fa_failed',
      targetType: 'user',
      targetId: user.id,
      ip: req.ip,
    });
    throw unauthorized('That authentication code is incorrect.', 'invalid_code');
  }
  db.prepare('UPDATE auth_challenges SET consumed_at = ? WHERE id = ?').run(nowIso(), challenge.id);
  createSession(user.id, req, res);
  recordLogin(user, req);
  const account = db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY opened_at LIMIT 1').get(user.id);
  return res.json({ user: publicUser(user), account: accountSummary(account) });
});

router.post('/logout', (req, res) => {
  if (req.user) {
    recordAudit({
      actorId: req.user.id,
      actorEmail: req.user.email,
      action: 'auth.logout',
      targetType: 'user',
      targetId: req.user.id,
      ip: req.ip,
    });
  }
  destroySession(req, res);
  res.json({ ok: true });
});

router.get('/session', requireAuth, (req, res) => {
  res.json(currentContext(req));
});

router.post('/identity/resubmit', requireAuth, (req, res) => {
  const identity = req.body || {};
  const ssnLast4 = validate.ssnLast4(identity.ssnLast4);
  const idType = ['drivers_license', 'state_id', 'passport', 'us_passport'].includes(identity.idType)
    ? identity.idType
    : 'drivers_license';
  if (req.user.kyc_status === 'verified') {
    throw new AppError(409, 'Your identity is already verified.', 'already_verified');
  }
  db.prepare("UPDATE users SET kyc_status = 'pending', kyc_note = NULL, ssn_last4 = ?, id_document_type = ? WHERE id = ?").run(
    ssnLast4,
    idType,
    req.user.id,
  );
  notifyAdmins({
    title: 'Identity verification resubmitted',
    body: `${req.user.first_name} ${req.user.last_name} resubmitted identity documents for review.`,
    kind: 'admin',
  });
  recordAudit({
    actorId: req.user.id,
    actorEmail: req.user.email,
    action: 'kyc.resubmitted',
    targetType: 'user',
    targetId: req.user.id,
    ip: req.ip,
  });
  res.json({ ok: true, message: 'Identity verification submitted for review.' });
});

router.get('/demo-access', (req, res) => {
  res.json({
    enabled: config.seedDemoData,
    accounts: config.seedDemoData
      ? [
          {
            label: 'Customer',
            email: 'alex.morgan@example.com',
            password: 'Northvale#2026',
            note: 'Verified customer with checking and savings accounts.',
          },
          {
            label: 'Administrator',
            email: 'admin@northvale.com',
            password: 'Admin#2026',
            note: 'Operations console for verification, monitoring and reconciliation.',
          },
        ]
      : [],
    internalRecipient: config.seedDemoData
      ? { name: 'Priya Nair', accountNumber: '4400128871', routingNumber: config.brand.routingNumber }
      : null,
  });
});

module.exports = router;
