'use strict';

const config = require('../config');
const { db } = require('../db');
const { findBankByRouting, findBankById } = require('../data/banks');
const { badRequest } = require('../errors');

function maskAccount(accountNumber) {
  const clean = String(accountNumber || '').replace(/\s/g, '');
  return `•••• ${clean.slice(-4)}`;
}

function validateBankAccountInput({ routingNumber, accountNumber, bankId }) {
  const routing = String(routingNumber || '').replace(/\D/g, '');
  const account = String(accountNumber || '').replace(/\D/g, '');
  if (bankId && !routing) {
    const bank = findBankById(bankId);
    if (!bank) throw badRequest('Select a bank from the list.', 'bank_invalid');
    return { routingNumber: bank.routingNumber, accountNumber: account, bank };
  }
  if (!/^\d{9}$/.test(routing)) {
    throw badRequest('Enter a valid 9-digit routing number.', 'routing_invalid');
  }
  if (!/^\d{4,17}$/.test(account)) {
    throw badRequest('Enter a valid account number (4–17 digits).', 'account_invalid');
  }
  return { routingNumber: routing, accountNumber: account, bank: findBankByRouting(routing) };
}

async function lookupWithProvider({ routingNumber, accountNumber }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(config.directory.apiUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.directory.apiKey}`,
      },
      body: JSON.stringify({ routing_number: routingNumber, account_number: accountNumber, country: 'US' }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        status: 'unavailable',
        message: `The bank directory service responded with ${response.status}. Recipient verification is temporarily unavailable.`,
        source: 'external_directory',
      };
    }
    const data = await response.json();
    const name = data.account_name || data.name || data.recipient_name || null;
    if (data.valid === false || !name) {
      return {
        status: 'not_found',
        message: 'The bank directory could not verify a name for this account and routing number.',
        source: 'external_directory',
      };
    }
    return { status: 'verified', name: String(name), source: 'external_directory' };
  } catch (error) {
    return {
      status: 'unavailable',
      message: 'The bank directory service could not be reached. Recipient verification is temporarily unavailable.',
      source: 'external_directory',
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolve the legal name on a recipient account.
 * Northvale-to-Northvale transfers resolve against the internal ledger.
 * External accounts require a configured bank directory provider.
 */
async function lookupRecipient({ routingNumber, accountNumber, bankId }) {
  const input = validateBankAccountInput({ routingNumber, accountNumber, bankId });
  const bankName = input.bank ? input.bank.name : 'External financial institution';

  if (input.routingNumber === config.brand.routingNumber) {
    const account = db.prepare('SELECT * FROM accounts WHERE account_number = ?').get(input.accountNumber);
    if (!account) {
      return {
        status: 'not_found',
        bankName: config.brand.name,
        routingNumber: input.routingNumber,
        accountNumberMasked: maskAccount(input.accountNumber),
        message: 'No Northvale account matches that account number.',
        source: 'northvale_ledger',
      };
    }
    const user = db.prepare('SELECT first_name, last_name, status FROM users WHERE id = ?').get(account.user_id);
    if (!user || user.status === 'closed') {
      return {
        status: 'not_found',
        bankName: config.brand.name,
        routingNumber: input.routingNumber,
        accountNumberMasked: maskAccount(input.accountNumber),
        message: 'That account is closed and cannot receive transfers.',
        source: 'northvale_ledger',
      };
    }
    return {
      status: 'verified',
      name: `${user.first_name} ${user.last_name}`,
      bankName: config.brand.name,
      routingNumber: input.routingNumber,
      accountNumberMasked: maskAccount(input.accountNumber),
      source: 'northvale_ledger',
      internal: true,
    };
  }

  if (!config.directory.enabled) {
    return {
      status: 'unavailable',
      bankName,
      routingNumber: input.routingNumber,
      accountNumberMasked: maskAccount(input.accountNumber),
      message:
        'External recipient verification requires a connected bank directory service. Add BANK_DIRECTORY_API_URL and BANK_DIRECTORY_API_KEY to enable live name verification.',
      source: 'none',
      internal: false,
    };
  }

  const result = await lookupWithProvider(input);
  return {
    ...result,
    bankName,
    routingNumber: input.routingNumber,
    accountNumberMasked: maskAccount(input.accountNumber),
    internal: false,
  };
}

module.exports = { lookupRecipient, validateBankAccountInput, maskAccount };
