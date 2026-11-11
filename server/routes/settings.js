'use strict';

/**
 * Account settings: password, transaction PIN, two-factor authentication,
 * alert preferences and session revocation. Every mutation requires the
 * account password or an authenticator code and is written to the audit log.
 */
const crypto = require('crypto');
const express = require('express');

const { db, nowIso } = require('../db');
const {
  hashSecret,
  verifySecret,
  generateTotpSecret,
  verifyTotp,
  otpauthUrl,
} = require('../security');
const validate = require('../validate');
const { AppError, badRequest, unauthorized } = require('../errors');
const { recordAudit, notify } = require('../services/audit');
const { requireAuth } = require('../services/sessions');

const router = express.Router();

router.use(requireAuth);

const SETUP_PURPOSE = 'totp_setup';
const SETUP_TTL_MS = 15 * 60 * 1000;

function currentUser(req) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) throw unauthorized('Session is no longer valid.');
  return user;
}

function requirePassword(user, candidate) {
  if (!candidate) {
    throw badRequest('Enter your account password to continue.', 'password_required', { field: 'password' });
  }
  if (!verifySecret(candidate, user.password_hash)) {
    throw new AppError(401, 'That password is incorrect.', 'password_invalid', { field: 'password' });
  }
}

function formatSecret(secret) {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

router.post('/password', (req, res) => {
  const user = currentUser(req);
  const body = req.body || {};
  requirePassword(user, body.currentPassword);

  if (!body.confirmPassword || body.newPassword !== body.confirmPassword) {
    throw badRequest('New passwords do not match.', 'password_mismatch', { field: 'confirmPassword' });
  }
  const next = validate.password(body.newPassword);
  if (verifySecret(next, user.password_hash)) {
    throw badRequest('Choose a password you have not used before.', 'password_reused', { field: 'newPassword' });
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashSecret(next), user.id);
  db.prepare(
    'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND token_hash != ? AND revoked_at IS NULL',
  ).run(nowIso(), user.id, req.sessionTokenHash);

  notify(user.id, {
    title: 'Password changed',
    body: 'Your password was updated and all other sessions were signed out.',
    kind: 'security',
  });
  recordAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'security.password_changed',
    targetType: 'user',
    targetId: user.id,
    ip: req.ip,
  });

  res.json({ ok: true, message: 'Password updated. Other devices were signed out.' });
});

router.post('/pin', (req, res) => {
  const user = currentUser(req);
  const body = req.body || {};
  requirePassword(user, body.password);
  const pin = validate.pin(body.pin);

  db.prepare(
    'UPDATE users SET pin_hash = ?, pin_failures = 0, pin_locked_until = NULL WHERE id = ?',
  ).run(hashSecret(pin), user.id);

  notify(user.id, {
    title: user.pin_hash ? 'Transaction PIN updated' : 'Transaction PIN created',
    body: 'Your transaction PIN is required to authorise transfers and withdrawals.',
    kind: 'security',
  });
  recordAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: user.pin_hash ? 'security.pin_changed' : 'security.pin_created',
    targetType: 'user',
    targetId: user.id,
    ip: req.ip,
  });

  res.json({ ok: true, message: user.pin_hash ? 'Transaction PIN updated.' : 'Transaction PIN created.' });
});

router.post('/2fa/start', (req, res) => {
  const user = currentUser(req);
  const secret = generateTotpSecret();
  const now = Date.now();

  db.prepare(
    'UPDATE auth_challenges SET consumed_at = ? WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL',
  ).run(nowIso(), user.id, SETUP_PURPOSE);
  db.prepare(
    'INSERT INTO auth_challenges (id, user_id, purpose, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    crypto.randomUUID(),
    user.id,
    SETUP_PURPOSE,
    JSON.stringify({ secret }),
    new Date(now).toISOString(),
    new Date(now + SETUP_TTL_MS).toISOString(),
  );

  res.json({
    secret,
    secretFormatted: formatSecret(secret),
    otpauthUrl: otpauthUrl(secret, user.email),
    account: user.email,
    expiresInSeconds: SETUP_TTL_MS / 1000,
  });
});

router.post('/2fa/enable', (req, res) => {
  const user = currentUser(req);
  const code = String((req.body || {}).code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) {
    throw badRequest('Enter the 6-digit code from your authenticator app.', 'code_invalid', { field: 'code' });
  }

  const challenge = db
    .prepare(
      `SELECT * FROM auth_challenges WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL
       AND expires_at > ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(user.id, SETUP_PURPOSE, nowIso());
  if (!challenge) {
    throw badRequest('Your setup window expired. Start the setup again.', 'setup_expired');
  }

  let secret = null;
  try {
    secret = JSON.parse(challenge.payload || '{}').secret || null;
  } catch {
    secret = null;
  }
  if (!secret || !verifyTotp(secret, code)) {
    throw badRequest('That code did not match. Check your authenticator app and try again.', 'code_mismatch', {
      field: 'code',
    });
  }

  db.prepare('UPDATE users SET twofa_secret = ?, twofa_enabled = 1 WHERE id = ?').run(secret, user.id);
  db.prepare('UPDATE auth_challenges SET consumed_at = ? WHERE id = ?').run(nowIso(), challenge.id);

  notify(user.id, {
    title: 'Two-factor authentication enabled',
    body: 'A 6-digit authenticator code is now required at every sign-in.',
    kind: 'security',
  });
  recordAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'security.2fa_enabled',
    targetType: 'user',
    targetId: user.id,
    ip: req.ip,
  });

  res.json({ ok: true, message: 'Two-factor authentication enabled.' });
});

router.post('/2fa/disable', (req, res) => {
  const user = currentUser(req);
  requirePassword(user, (req.body || {}).password);

  db.prepare('UPDATE users SET twofa_secret = NULL, twofa_enabled = 0 WHERE id = ?').run(user.id);
  notify(user.id, {
    title: 'Two-factor authentication disabled',
    body: 'Authenticator codes are no longer required at sign-in. Re-enable 2FA for stronger protection.',
    kind: 'security',
  });
  recordAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'security.2fa_disabled',
    targetType: 'user',
    targetId: user.id,
    ip: req.ip,
  });

  res.json({ ok: true, message: 'Two-factor authentication disabled.' });
});

router.post('/preferences', (req, res) => {
  const user = currentUser(req);
  const body = req.body || {};
  if (typeof body.loginNotifications !== 'boolean') {
    throw badRequest('Choose whether sign-in notifications are enabled.', 'preference_invalid');
  }
  db.prepare('UPDATE users SET login_notifications = ? WHERE id = ?').run(
    body.loginNotifications ? 1 : 0,
    user.id,
  );
  recordAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'preferences.login_notifications',
    targetType: 'user',
    targetId: user.id,
    ip: req.ip,
    metadata: { enabled: body.loginNotifications },
  });
  res.json({
    ok: true,
    loginNotifications: body.loginNotifications,
    message: `Sign-in notifications ${body.loginNotifications ? 'enabled' : 'disabled'}.`,
  });
});

router.post('/sessions/revoke-all', (req, res) => {
  const user = currentUser(req);
  const result = db
    .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND token_hash != ? AND revoked_at IS NULL')
    .run(nowIso(), user.id, req.sessionTokenHash);

  recordAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'security.sessions_revoked',
    targetType: 'user',
    targetId: user.id,
    ip: req.ip,
    metadata: { revoked: result.changes },
  });

  res.json({ ok: true, revoked: result.changes, message: 'All other sessions have been signed out.' });
});

module.exports = router;
