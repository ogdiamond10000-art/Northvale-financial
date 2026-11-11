'use strict';

const { badRequest } = require('./errors');

const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY',
  'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH',
  'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
];

const ACCOUNT_TYPES = ['checking', 'savings', 'money_market'];

function text(value, label, { min = 1, max = 120, pattern, patternMessage } = {}) {
  const clean = String(value === undefined || value === null ? '' : value).trim();
  if (clean.length < min) throw badRequest(`${label} is required.`, 'field_required', { field: label });
  if (clean.length > max) throw badRequest(`${label} must be ${max} characters or fewer.`, 'field_too_long', { field: label });
  if (pattern && !pattern.test(clean)) {
    throw badRequest(patternMessage || `${label} is not valid.`, 'field_invalid', { field: label });
  }
  return clean;
}

function email(value) {
  const clean = text(value, 'Email address', { max: 200 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(clean)) {
    throw badRequest('Enter a valid email address.', 'email_invalid', { field: 'email' });
  }
  return clean;
}

function phone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  const normalized = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (!/^\d{10}$/.test(normalized)) {
    throw badRequest('Enter a valid 10-digit US phone number.', 'phone_invalid', { field: 'phone' });
  }
  return `+1 (${normalized.slice(0, 3)}) ${normalized.slice(3, 6)}-${normalized.slice(6)}`;
}

function password(value) {
  const clean = String(value || '');
  if (clean.length < 10) {
    throw badRequest('Password must be at least 10 characters long.', 'password_weak', { field: 'password' });
  }
  if (clean.length > 128) {
    throw badRequest('Password must be 128 characters or fewer.', 'password_too_long', { field: 'password' });
  }
  const checks = [
    [/[a-z]/, 'one lowercase letter'],
    [/[A-Z]/, 'one uppercase letter'],
    [/\d/, 'one number'],
    [/[^A-Za-z0-9]/, 'one symbol'],
  ];
  const missing = checks.filter(([pattern]) => !pattern.test(clean)).map(([, label]) => label);
  if (missing.length) {
    throw badRequest(`Password must include ${missing.join(', ')}.`, 'password_weak', { field: 'password' });
  }
  return clean;
}

function name(value, label) {
  return text(value, label, {
    min: 2,
    max: 60,
    pattern: /^[A-Za-z][A-Za-z' -]*$/,
    patternMessage: `${label} may only contain letters, spaces, hyphens and apostrophes.`,
  });
}

function state(value) {
  const clean = String(value || '').trim().toUpperCase();
  if (!US_STATES.includes(clean)) {
    throw badRequest('Select a valid US state.', 'state_invalid', { field: 'state' });
  }
  return clean;
}

function postalCode(value) {
  const clean = String(value || '').trim();
  if (!/^\d{5}(-\d{4})?$/.test(clean)) {
    throw badRequest('Enter a valid US ZIP code.', 'postal_invalid', { field: 'postalCode' });
  }
  return clean;
}

function dob(value) {
  const clean = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    throw badRequest('Enter your date of birth.', 'dob_invalid', { field: 'dob' });
  }
  const date = new Date(`${clean}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw badRequest('Enter a valid date of birth.', 'dob_invalid');
  const now = new Date();
  let age = now.getUTCFullYear() - date.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - date.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < date.getUTCDate())) age -= 1;
  if (age < 18) throw badRequest('You must be at least 18 years old to open an account.', 'underage', { field: 'dob' });
  if (age > 120) throw badRequest('Enter a valid date of birth.', 'dob_invalid', { field: 'dob' });
  return clean;
}

function accountType(value) {
  const clean = String(value || '').trim();
  if (!ACCOUNT_TYPES.includes(clean)) {
    throw badRequest('Choose an account type.', 'account_type_invalid', { field: 'accountType' });
  }
  return clean;
}

function ssnLast4(value) {
  const clean = String(value || '').replace(/\D/g, '');
  if (!/^\d{4}$/.test(clean)) {
    throw badRequest('Enter the last 4 digits of your SSN.', 'ssn_invalid', { field: 'ssnLast4' });
  }
  return clean;
}

function pin(value, { required = false } = {}) {
  const clean = String(value || '').replace(/\s/g, '');
  if (!clean && !required) return null;
  if (!/^\d{4,6}$/.test(clean)) {
    throw badRequest('Transaction PIN must be 4 to 6 digits.', 'pin_invalid', { field: 'pin' });
  }
  if (/^(\d)\1+$/.test(clean) || ['1234', '123456', '0000'].includes(clean)) {
    throw badRequest('Choose a stronger transaction PIN.', 'pin_weak', { field: 'pin' });
  }
  return clean;
}

function optional(value, validator) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return validator(value);
}

module.exports = {
  optional,
  US_STATES,
  ACCOUNT_TYPES,
  text,
  email,
  phone,
  password,
  name,
  state,
  postalCode,
  dob,
  accountType,
  ssnLast4,
  pin,
};
