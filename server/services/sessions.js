'use strict';

const config = require('../config');
const { db, nowIso } = require('../db');
const { randomToken, sha256, newId, verifySecret, verifyTotp } = require('../security');
const { unauthorized, forbidden, badRequest, AppError } = require('../errors');
const { accountForUser, accountSummary } = require('./ledger');
const { recordAudit, notify } = require('./audit');
const { flagFailedPin } = require('./fraud');

const SESSION = config.session;

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    firstName: user.first_name,
    lastName: user.last_name,
    email: user.email,
    phone: user.phone,
    address: {
      line1: user.address_line1,
      line2: user.address_line2,
      city: user.city,
      state: user.state,
      postalCode: user.postal_code,
    },
    dob: user.dob,
    role: user.role,
    kycStatus: user.kyc_status,
    kycNote: user.kyc_note,
    status: user.status,
    twoFactorEnabled: Boolean(user.twofa_enabled),
    pinSet: Boolean(user.pin_hash),
    loginNotifications: Boolean(user.login_notifications),
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at,
    verifiedAt: user.verified_at,
  };
}

function sessionCookieOptions(req) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: SESSION.idleMinutes * 60 * 1000,
  };
}

function createSession(userId, req, res) {
  const token = randomToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION.idleMinutes * 60000);
  const absoluteExpiresAt = new Date(now.getTime() + SESSION.absoluteHours * 3600000);
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, absolute_expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sha256(token),
    userId,
    now.toISOString(),
    now.toISOString(),
    expiresAt.toISOString(),
    absoluteExpiresAt.toISOString(),
    req.ip || null,
    String(req.headers['user-agent'] || '').slice(0, 250),
  );
  res.cookie(SESSION.cookieName, token, sessionCookieOptions(req));
  return token;
}

function readSessionToken(req) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  for (const part of String(cookieHeader).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === SESSION.cookieName) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}

function resolveSession(req) {
  const token = readSessionToken(req);
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
  if (!row || row.revoked_at) return null;
  const now = Date.now();
  if (new Date(row.expires_at).getTime() <= now) return null;
  if (new Date(row.absolute_expires_at).getTime() <= now) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user || user.status === 'closed') return null;
  const nextExpiry = new Date(Math.min(now + SESSION.idleMinutes * 60000, new Date(row.absolute_expires_at).getTime()));
  db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(
    new Date(now).toISOString(),
    nextExpiry.toISOString(),
    row.token_hash,
  );
  return { user, session: row, tokenHash: row.token_hash };
}

function destroySession(req, res) {
  const token = readSessionToken(req);
  if (token) {
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?').run(nowIso(), sha256(token));
  }
  res.clearCookie(SESSION.cookieName, { path: '/' });
}

function requireAuth(req, res, next) {
  const resolved = resolveSession(req);
  if (!resolved) {
    return res.status(401).json({ error: 'Your session has expired. Please sign in again.', code: 'session_expired' });
  }
  req.user = resolved.user;
  req.sessionTokenHash = resolved.tokenHash;
  req.account = accountForUser(resolved.user.id);
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.', code: 'unauthorized' });
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access is required.', code: 'forbidden' });
  }
  return next();
}

function requireActiveAccount(req, res, next) {
  if (req.user.status !== 'active') {
    return res.status(403).json({
      error:
        req.user.status === 'frozen'
          ? 'Your account is frozen. Contact support to restore access.'
          : 'Your account is closed.',
      code: 'account_inactive',
    });
  }
  if (!req.account) return res.status(409).json({ error: 'No open account found.', code: 'no_account' });
  if (req.account.status !== 'active') {
    return res.status(403).json({ error: 'Your account is not active.', code: 'account_inactive' });
  }
  return next();
}

function requireVerified(req, res, next) {
  if (req.user.kyc_status !== 'verified') {
    return res.status(403).json({
      error:
        req.user.kyc_status === 'pending'
          ? 'Identity verification is still under review. Outgoing transfers unlock once your identity is verified.'
          : 'Complete identity verification before sending money.',
      code: 'kyc_required',
      kycStatus: req.user.kyc_status,
    });
  }
  return next();
}

function verifyTransactionPin(user, pin) {
  if (!user.pin_hash) {
    throw new AppError(409, 'Set a transaction PIN in Security settings before sending money.', 'pin_not_set');
  }
  if (user.pin_locked_until && new Date(user.pin_locked_until).getTime() > Date.now()) {
    throw new AppError(429, 'Too many incorrect PIN attempts. Try again in a few minutes.', 'pin_locked');
  }
  if (!pin || !/^\d{4,6}$/.test(String(pin))) {
    throw badRequest('Enter your 4–6 digit transaction PIN.', 'pin_invalid');
  }
  if (!verifySecret(String(pin), user.pin_hash)) {
    const failures = (user.pin_failures || 0) + 1;
    const lockedUntil = failures >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : null;
    db.prepare('UPDATE users SET pin_failures = ?, pin_locked_until = ? WHERE id = ?').run(
      failures,
      lockedUntil,
      user.id,
    );
    flagFailedPin(user.id, failures);
    throw new AppError(401, 'That transaction PIN is incorrect.', 'pin_incorrect');
  }
  if (user.pin_failures) db.prepare('UPDATE users SET pin_failures = 0, pin_locked_until = NULL WHERE id = ?').run(user.id);
  return true;
}

function recordLogin(user, req) {
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);
  if (user.login_notifications) {
    const agent = String(req.headers['user-agent'] || 'Unknown device').slice(0, 80);
    notify(user.id, {
      title: 'New sign-in to your Northvale account',
      body: `A sign-in was recorded from IP ${req.ip || 'unknown'} using ${agent}. If this was not you, change your password immediately.`,
      kind: 'security',
    });
  }
  recordAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'auth.login',
    targetType: 'user',
    targetId: user.id,
    ip: req.ip,
  });
}

function currentContext(req) {
  const account = req.account ? accountSummary(req.account) : null;
  return { user: publicUser(req.user), account };
}

module.exports = {
  publicUser,
  createSession,
  resolveSession,
  destroySession,
  requireAuth,
  requireAdmin,
  requireActiveAccount,
  requireVerified,
  verifyTransactionPin,
  recordLogin,
  currentContext,
  sessionCookieOptions,
  newId,
  verifyTotp,
  unauthorized,
  forbidden,
};
