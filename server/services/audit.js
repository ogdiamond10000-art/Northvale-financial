'use strict';

const { db, nowIso } = require('../db');
const { newId } = require('../security');

function recordAudit({ actorId, actorEmail, action, targetType, targetId, ip, metadata }) {
  db.prepare(
    `INSERT INTO audit_logs (id, actor_id, actor_email, action, target_type, target_id, ip, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId('aud'),
    actorId || null,
    actorEmail || null,
    action,
    targetType || null,
    targetId || null,
    ip || null,
    metadata ? JSON.stringify(metadata) : null,
    nowIso(),
  );
}

function notify(userId, { title, body, kind = 'info' }) {
  db.prepare(
    'INSERT INTO notifications (id, user_id, title, body, kind, read, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
  ).run(newId('ntf'), userId, title, body, kind, nowIso());
}

function notifyAdmins({ title, body, kind = 'alert' }) {
  const admins = db.prepare("SELECT id FROM users WHERE role = 'admin'").all();
  for (const admin of admins) notify(admin.id, { title, body, kind });
}

function createFraudAlert({ userId, transactionId, severity, ruleCode, message }) {
  const id = newId('frd');
  db.prepare(
    `INSERT INTO fraud_alerts (id, user_id, transaction_id, severity, rule_code, message, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
  ).run(id, userId || null, transactionId || null, severity, ruleCode, message, nowIso());
  return id;
}

module.exports = { recordAudit, notify, notifyAdmins, createFraudAlert };
