'use strict';

const path = require('path');

const rootDir = path.join(__dirname, '..');
const dataDir = process.env.DATA_DIR || path.join(rootDir, 'data');

const config = {
  rootDir,
  dataDir,
  publicDir: path.join(rootDir, 'public'),
  dbFile: process.env.DATABASE_FILE || path.join(dataDir, 'northvale.db'),
  port: Number(process.env.PORT || 3000),
  isProd: process.env.NODE_ENV === 'production',

  brand: {
    name: 'Northvale Financial',
    legalName: 'Northvale Financial Technologies, Inc.',
    currency: 'USD',
    routingNumber: '099000012',
  },

  session: {
    cookieName: 'nv_session',
    idleMinutes: Number(process.env.SESSION_IDLE_MINUTES || 30),
    absoluteHours: Number(process.env.SESSION_ABSOLUTE_HOURS || 12),
  },

  limits: {
    minDepositCents: 500,
    maxDepositCents: 2500000,
    minTransferCents: 100,
    maxTransferCents: 5000000,
    minWithdrawalCents: 100,
    maxWithdrawalCents: 2500000,
    reviewThresholdCents: 1000000, // $10,000 -> held for manual review
    velocityCount: 4,
    velocityWindowMinutes: 10,
  },

  // Payment gateway (Stripe). Deposit crediting only happens on a verified payment.
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    apiBase: 'https://api.stripe.com/v1',
  },

  // External bank directory / recipient name verification provider.
  directory: {
    apiUrl: process.env.BANK_DIRECTORY_API_URL || '',
    apiKey: process.env.BANK_DIRECTORY_API_KEY || '',
  },

  seedDemoData: process.env.SEED_DEMO_DATA !== 'false',
};

config.stripe.enabled = Boolean(config.stripe.secretKey);
config.directory.enabled = Boolean(config.directory.apiUrl && config.directory.apiKey);

module.exports = config;
