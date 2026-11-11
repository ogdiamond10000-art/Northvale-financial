import { api, ApiError } from '../api.js';
import * as ui from '../ui.js';

const PRESETS = [100, 250, 500, 1000, 2500];

export async function renderDeposit(page, ctx) {
  ctx.setTitle('Deposit', 'Add funds');
  const account = ctx.state.account || {};

  page.innerHTML = `<div class="flow-wrap">
    <div class="flow-main">
      <div class="section-head">
        <div>
          <h2>Add funds</h2>
          <p>Fund your Northvale account from a payment method. Your balance updates only after the payment is confirmed by the gateway.</p>
        </div>
      </div>
      <div id="deposit-body"><div class="skeleton" style="height:240px"></div></div>
    </div>
    <aside class="flow-aside">
      <div class="card">
        <div class="card-head"><div><h3 style="font-size:15px">Depositing into</h3><p class="card-sub">Northvale account</p></div></div>
        <div class="kv"><span>Account</span><strong class="tabular">${ui.esc(ui.groupAccountNumber(account.accountNumber || ''))}</strong></div>
        <div class="kv"><span>Available</span><strong class="tabular">${ui.esc(account.availableBalance || ui.fmtUSD(0))}</strong></div>
        <div class="kv"><span>Type</span><strong>${ui.esc(account.typeLabel || account.type || '—')}</strong></div>
      </div>
      <div class="card aside-note">
        ${ui.icon('shield')}
        <div>
          <strong>No fictional credits</strong>
          <p>A deposit posts to your ledger only when the payment gateway reports the payment as paid and the amount and reference match. Anything unconfirmed stays pending for review.</p>
        </div>
      </div>
    </aside>
  </div>`;

  const body = page.querySelector('#deposit-body');
  let config;
  try {
    config = await api.get('/api/deposits/config');
  } catch (error) {
    body.innerHTML = ui.notice('danger', error instanceof ApiError ? error.message : 'Deposit options could not be loaded.');
    return;
  }

  const methods = config.methods || [];
  const usable = methods.filter((method) => method.available);
  const state = { method: usable[0] || methods[0] || null, amount: '' };

  function drawForm() {
    const gatewayReady = config.gateway?.configured;
    body.innerHTML = `
      ${
        gatewayReady
          ? ''
          : `<div class="notice warn" style="margin-bottom:18px">${ui.icon('shield')}<div>
              <strong>Payment gateway not connected.</strong>
              Card deposits require a payment gateway account. An administrator must add
              <code>${ui.esc((config.gateway?.requiredEnv || ['STRIPE_SECRET_KEY']).join('</code>, <code>'))}</code>
              in Settings → Environment variables before deposits can be accepted. No deposit will be simulated.
            </div></div>`
      }
      <div class="card">
        <div class="card-head"><div><h3>Deposit amount</h3><p class="card-sub">Choose an amount to add to your account.</p></div></div>

        <div class="field" data-field="amount">
          <label for="f-amount">Amount</label>
          <div class="amount-wrap">
            <span class="amount-prefix">$</span>
            <input class="input amount-input tabular" id="f-amount" name="amount" inputmode="decimal" placeholder="0.00" value="${ui.esc(state.amount)}" autocomplete="off" />
            <span class="amount-suffix">USD</span>
          </div>
          <div class="preset-row">
            ${PRESETS.map((value) => `<button class="preset" type="button" data-preset="${value}">$${value.toLocaleString('en-US')}</button>`).join('')}
          </div>
          <span class="error" data-error="amount" hidden></span>
        </div>

        <div class="field">
          <label>Payment method</label>
          <div class="option-grid">
            ${methods
              .map(
                (method) => `<button class="option-card ${state.method?.id === method.id ? 'is-selected' : ''} ${method.available ? '' : 'is-disabled'}"
                  type="button" data-method="${ui.esc(method.id)}" ${method.available ? '' : 'disabled aria-disabled="true"'}>
                  <span class="option-icon">${ui.icon('card')}</span>
                  <span class="option-text">
                    <strong>${ui.esc(method.label)}</strong>
                    <span>${ui.esc(method.available ? method.description : method.unavailableReason || method.description)}</span>
                  </span>
                  <span class="option-check">${state.method?.id === method.id ? ui.icon('check') : ''}</span>
                </button>`,
              )
              .join('')}
          </div>
        </div>

        <div class="row" style="margin-top:20px">
          <div class="spacer"></div>
          <button class="btn btn-primary" type="button" data-submit ${gatewayReady && usable.length ? '' : 'disabled'}>
            ${ui.icon('lock')} Continue to secure payment
          </button>
        </div>
        <p class="fine-print" style="margin-top:14px">
          You will be redirected to the payment gateway's hosted checkout. Northvale never stores your full card number.
        </p>
      </div>`;

    const input = body.querySelector('#f-amount');
    input.addEventListener('input', () => {
      state.amount = input.value;
      ui.setFieldError(body.querySelector('.card'), 'amount', '');
    });
    body.querySelectorAll('[data-preset]').forEach((button) =>
      button.addEventListener('click', () => {
        state.amount = Number(button.dataset.preset).toFixed(2);
        input.value = state.amount;
      }),
    );
    body.querySelectorAll('[data-method]').forEach((button) =>
      button.addEventListener('click', () => {
        state.method = methods.find((method) => method.id === button.dataset.method) || null;
        drawForm();
      }),
    );
    body.querySelector('[data-submit]').addEventListener('click', submit);
  }

  async function submit(event) {
    const button = event.currentTarget;
    const card = body.querySelector('.card');
    const normalized = state.amount.replace(/[$,]/g, '').trim();
    const value = Number(normalized);
    if (!normalized || !Number.isFinite(value) || value < 1) {
      return ui.setFieldError(card, 'amount', 'Enter an amount of at least $1.00.');
    }
    if (value > 25000) return ui.setFieldError(card, 'amount', 'Deposits above $25,000 require support assistance.');
    if (!state.method) return ui.toast('Select a payment method.', 'error');

    ui.busy(button, true, 'Opening secure checkout…');
    try {
      const data = await api.post('/api/deposits/checkout', {
        amount: value.toFixed(2),
        method: state.method.id,
      });
      if (data.checkoutUrl) {
        window.location.assign(data.checkoutUrl);
        return;
      }
      throw new ApiError('The payment gateway did not return a checkout link.', { code: 'checkout_missing' });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Checkout could not be started.';
      if (error instanceof ApiError && error.details?.field) ui.setFieldError(card, error.details.field, message);
      ui.toast(message, 'error');
      ui.busy(button, false);
    }
  }

  /* Returning from the hosted checkout: ?session_id=... */
  const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const sessionId = params.get('session_id');
  if (sessionId) {
    body.innerHTML = `<div class="card confirm-card"><div class="confirm-mark pending">${ui.icon('clock')}</div>
      <h3>Confirming your payment</h3><p>We are verifying the payment with the gateway. This takes a few seconds.</p></div>`;
    try {
      const result = await api.get(`/api/deposits/confirm?session_id=${encodeURIComponent(sessionId)}`);
      drawResult(result);
      ctx.refresh().catch(() => {});
      ctx.loadNotifications().catch(() => {});
    } catch (error) {
      body.innerHTML = `<div class="card confirm-card"><div class="confirm-mark fail">${ui.icon('x')}</div>
        <h3>We could not confirm this payment</h3>
        <p>${ui.esc(error instanceof ApiError ? error.message : 'The payment status could not be verified.')}</p>
        <div class="row" style="margin-top:20px"><a class="btn btn-primary" href="#/deposit">Try again</a>
        <a class="btn btn-quiet" href="#/transactions">View transactions</a></div></div>`;
    }
    return;
  }

  drawForm();

  function drawResult(result) {
    const tx = result.transaction || {};
    const ok = result.status === 'completed';
    body.innerHTML = `<div class="card confirm-card">
      <div class="confirm-mark ${ok ? 'ok' : 'pending'}">${ui.icon(ok ? 'check' : 'clock')}</div>
      <h3>${ok ? 'Deposit credited' : 'Deposit pending'}</h3>
      <p>${ui.esc(result.message || '')}</p>
      <div class="detail-grid" style="margin-top:20px">
        <div><span>Reference</span><strong class="tabular">${ui.esc(tx.reference || '—')}</strong></div>
        <div><span>Status</span><strong>${ui.statusBadge(tx.status || result.status)}</strong></div>
        <div><span>Amount</span><strong class="tabular">${ui.esc(tx.amount || '—')}</strong></div>
        <div><span>Method</span><strong>${ui.esc(tx.method ? ui.titleCase(String(tx.method).replace('_', ' ')) : 'Card')}</strong></div>
        <div><span>Date</span><strong>${ui.esc(ui.fmtDate(tx.createdAt || new Date().toISOString()))}</strong></div>
        <div><span>Credited to</span><strong class="tabular">${ui.esc(ui.groupAccountNumber(account.accountNumber || ''))}</strong></div>
      </div>
      <div class="row" style="margin-top:22px;flex-wrap:wrap">
        ${tx.id ? `<a class="btn btn-primary" href="/api/account/transactions/${ui.esc(tx.id)}/receipt" download>${ui.icon('download')} Download receipt</a>
        <a class="btn btn-quiet" href="#/transactions/${ui.esc(tx.id)}">View transaction</a>` : ''}
        <a class="btn btn-quiet" href="#/deposit">New deposit</a>
      </div>
    </div>`;
  }
}
