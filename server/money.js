'use strict';

const { badRequest } = require('./errors');

/**
 * Parse a user supplied USD amount into integer cents.
 * Accepts "1250", "1,250.5", "$1,250.55" and numbers.
 */
function parseAmountToCents(input) {
  if (input === null || input === undefined || input === '') {
    throw badRequest('Enter an amount.', 'amount_required');
  }
  const raw = typeof input === 'number' ? input.toFixed(2) : String(input).trim();
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw badRequest('Enter a valid USD amount with up to two decimal places.', 'amount_invalid');
  }
  const [whole, fraction = ''] = cleaned.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw badRequest('Enter an amount greater than zero.', 'amount_invalid');
  }
  return cents;
}

function formatUSD(cents) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format((Number(cents) || 0) / 100);
}

module.exports = { parseAmountToCents, formatUSD };
