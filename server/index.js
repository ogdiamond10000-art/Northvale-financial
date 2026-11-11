'use strict';

const path = require('path');
const express = require('express');

const config = require('./config');
require('./db'); // initialise schema + seed before routes read data
const payments = require('./services/payments');
const stripeWebhooks = require('./services/stripe-webhooks');
const { createRateLimiter } = require('./security');
const { settleTransaction, getTransaction } = require('./services/ledger');
const { notify } = require('./services/audit');
const { formatUSD } = require('./money');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

/* ----------------------------- security headers ----------------------------- */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self' https://api.stripe.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  );
  next();
});

/* --------------------------- Stripe webhook (raw) --------------------------- */
// Stripe signs the exact raw body, so this route is registered before express.json().
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const verification = payments.verifyWebhookSignature(req.body, req.headers['stripe-signature']);
  if (!verification.valid) {
    return res.status(400).json({ error: 'Invalid webhook signature.', reason: verification.reason });
  }

  let result;
  try {
    result = stripeWebhooks.processEvent(verification.event);
  } catch (error) {
    // Non-2xx makes Stripe retry; the event stays recorded for reconciliation.
    console.error('[stripe] webhook processing failed:', error?.message || error);
    return res.status(500).json({ error: 'Webhook processing failed.' });
  }

  res.json({ received: true, status: result.status, duplicate: Boolean(result.duplicate) });
});

/* -------------------------------- api routes -------------------------------- */
app.use(express.json({ limit: '64kb' }));

const apiLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 240,
  message: 'Too many requests. Please wait a moment and try again.',
});

app.use('/api', apiLimiter);
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/transfers', require('./routes/transfers'));
app.use('/api/withdrawals', require('./routes/withdrawals'));
app.use('/api/deposits', require('./routes/deposits'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/system', require('./routes/system'));
app.use('/api', require('./routes/account'));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    brand: config.brand.name,
    bankPartnerStatus: 'not_yet_authorised',
    gatewayConfigured: payments.isConfigured(),
    directoryConfigured: config.directory.enabled,
    time: new Date().toISOString(),
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found.', code: 'not_found' });
});

/* ------------------------------- static files ------------------------------- */
app.use(
  express.static(config.publicDir, {
    index: false,
    etag: true,
    maxAge: config.isProd ? '1h' : 0,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

app.get('*', (req, res) => {
  res.sendFile(path.join(config.publicDir, 'index.html'));
});

/* ------------------------------- error handler ------------------------------ */
// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  const status = error.status || 500;
  if (status >= 500) {
    console.error('[northvale]', error);
  }
  res.status(status).json({
    error: status >= 500 ? 'Something went wrong on our side. Please try again.' : error.message,
    code: error.code || 'server_error',
    details: error.details,
  });
});

if (require.main === module) {
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`Northvale Financial listening on 0.0.0.0:${config.port}`);
  });
}

module.exports = app;
