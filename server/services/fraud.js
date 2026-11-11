'use strict';

const config = require('../config');
const { db } = require('../db');
const { formatUSD } = require('../money');
const { createFraudAlert, notifyAdmins } = require('./audit');

/**
 * Rule-based fraud monitoring for outgoing money movement.
 * Returns alerts plus whether the transaction must be held for manual review.
 */
function evaluateOutgoing({ userId, accountId, amountCents, kind }) {
  const alerts = [];
  const now = Date.now();

  if (amountCents >= config.limits.reviewThresholdCents) {
    alerts.push({
      severity: 'high',
      ruleCode: 'LARGE_AMOUNT',
      message: `${kind} of ${formatUSD(amountCents)} meets the ${formatUSD(
        config.limits.reviewThresholdCents,
      )} manual review threshold.`,
    });
  }

  const since = new Date(now - config.limits.velocityWindowMinutes * 60000).toISOString();
  const recent = db
    .prepare(
      `SELECT COUNT(*) AS count FROM transactions
       WHERE account_id = ? AND direction = 'debit' AND created_at >= ?`,
    )
    .get(accountId, since).count;
  if (recent >= config.limits.velocityCount) {
    alerts.push({
      severity: 'high',
      ruleCode: 'VELOCITY',
      message: `${recent} outgoing transactions in the last ${config.limits.velocityWindowMinutes} minutes.`,
    });
  }

  const user = db.prepare('SELECT created_at FROM users WHERE id = ?').get(userId);
  const accountAgeHours = user ? (now - new Date(user.created_at).getTime()) / 3600000 : 999;
  if (accountAgeHours < 24 && amountCents >= 250000) {
    alerts.push({
      severity: 'medium',
      ruleCode: 'NEW_ACCOUNT_LARGE_OUTFLOW',
      message: `Outgoing ${formatUSD(amountCents)} within 24 hours of account opening.`,
    });
  }

  const requiresReview = alerts.some((alert) => alert.severity === 'high');
  return { alerts, requiresReview };
}

function recordAlerts({ userId, transactionId, alerts }) {
  for (const alert of alerts) {
    createFraudAlert({
      userId,
      transactionId,
      severity: alert.severity,
      ruleCode: alert.ruleCode,
      message: alert.message,
    });
    if (alert.severity === 'high') {
      notifyAdmins({
        title: 'Fraud review required',
        body: alert.message,
        kind: 'alert',
      });
    }
  }
}

function flagFailedPin(userId, attempts) {
  if (attempts < 3) return;
  createFraudAlert({
    userId,
    severity: attempts >= 5 ? 'high' : 'medium',
    ruleCode: 'PIN_FAILURES',
    message: `${attempts} failed transaction PIN attempts.`,
  });
  notifyAdmins({
    title: 'Repeated PIN failures',
    body: `A customer recorded ${attempts} failed transaction PIN attempts.`,
    kind: 'alert',
  });
}

module.exports = { evaluateOutgoing, recordAlerts, flagFailedPin };
