'use strict';

const { db, nowIso } = require('../db');
const { AppError } = require('../errors');

const KEY = 'transfer_controls';

const DEFAULTS = {
  transfersEnabled: true,
  outgoingPaused: false,
  holdNewExternal: false,
  message: '',
  updatedAt: null,
  updatedBy: null,
};

/**
 * Operations controls are stored in the database so they survive restarts and
 * apply to every request on every server process. Missing rows fall back to the
 * open defaults, which keeps an existing deployment working after an upgrade.
 */
function getControls() {
  const row = db.prepare('SELECT value, updated_at, updated_by FROM system_settings WHERE key = ?').get(KEY);
  if (!row) return { ...DEFAULTS };
  let parsed = {};
  try {
    parsed = JSON.parse(row.value) || {};
  } catch {
    parsed = {};
  }
  return {
    ...DEFAULTS,
    transfersEnabled: parsed.transfersEnabled !== false,
    outgoingPaused: parsed.outgoingPaused === true,
    holdNewExternal: parsed.holdNewExternal === true,
    message: typeof parsed.message === 'string' ? parsed.message : '',
    updatedAt: row.updated_at || null,
    updatedBy: row.updated_by || null,
  };
}

function setControls(patch = {}, actor = {}) {
  const current = getControls();
  const next = {
    transfersEnabled: patch.transfersEnabled === undefined ? current.transfersEnabled : patch.transfersEnabled === true,
    outgoingPaused: patch.outgoingPaused === undefined ? current.outgoingPaused : patch.outgoingPaused === true,
    holdNewExternal: patch.holdNewExternal === undefined ? current.holdNewExternal : patch.holdNewExternal === true,
    message: patch.message === undefined ? current.message : String(patch.message || '').trim().slice(0, 240),
  };
  db.prepare(
    `INSERT INTO system_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(KEY, JSON.stringify(next), nowIso(), actor.email || actor.id || null);
  return getControls();
}

/** Customer-facing view: no operator identity leaks into the public payload. */
function publicControls() {
  const controls = getControls();
  return {
    transfersEnabled: controls.transfersEnabled,
    outgoingPaused: controls.outgoingPaused,
    message: controls.message,
    updatedAt: controls.updatedAt,
  };
}

/**
 * Returns the blocking reason, or null when outgoing money movement is allowed.
 * `internal` marks a transfer between two Northvale accounts, which stays
 * available during an outgoing pause because no external network is involved.
 */
function outgoingBlockReason({ internal = false } = {}) {
  const controls = getControls();
  if (!controls.transfersEnabled) {
    return {
      code: 'transfers_disabled',
      message:
        controls.message ||
        'Money movement is temporarily unavailable while Northvale completes scheduled maintenance. No funds have left your account.',
    };
  }
  if (controls.outgoingPaused && !internal) {
    return {
      code: 'outgoing_paused',
      message:
        controls.message ||
        'Outgoing transfers to other institutions are temporarily paused by Northvale operations. Transfers between Northvale accounts are still available.',
    };
  }
  return null;
}

function assertOutgoingAllowed(ctx = {}) {
  const blocked = outgoingBlockReason(ctx);
  if (blocked) throw new AppError(423, blocked.message, blocked.code, { controls: publicControls() });
}

module.exports = { getControls, setControls, publicControls, outgoingBlockReason, assertOutgoingAllowed };
