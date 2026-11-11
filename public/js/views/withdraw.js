import { api, ApiError } from '../api.js';
import * as ui from '../ui.js';

const STEP_LABELS = ['Method', 'Destination', 'Review & approve'];

function freshState() {
  return {
    step: 1,
    methods: [],
    method: null,
    bank: null,
    accountNumber: '',
    recipient: null,
    amount: '',
    description: '',
    idempotencyKey: null,
    result: null,
  };
}

export async function renderWithdraw(page, ctx) {
  ctx.setTitle('Withdraw', 'Move money');
  const state = freshState();
  const account = ctx.state.account || {};
  const user = ctx.state.user || {};

  const controls = await api
    .get('/api/system/controls')
    .then((data) => data.controls || {})
    .catch(() => ({ transfersEnabled: true, outgoingPaused: false, message: '' }));
  const controlsNotice = !controls.transfersEnabled
    ? ui.notice('danger', controls.message || 'Money movement is temporarily unavailable.', { strong: 'Withdrawals are paused.' })
    : controls.outgoingPaused
      ? ui.notice('warn', controls.message || 'Outgoing transfers and withdrawals are temporarily paused.', {
          strong: 'Withdrawals are paused.',
        })
      : '';

  page.innerHTML = `<div class="flow-wrap">
    <div class="flow-main">
      <div class="section-head">
        <div>
          <h2>Withdraw funds</h2>
          <p>Choose a payout method, verify the destination account, then approve with your PIN.</p>
        </div>
      </div>
      ${controlsNotice}
      <div id="flow-body"><div class="skeleton" style="height:240px"></div></div>
    </div>
    <aside class="flow-aside">
      <div class="card">
        <div class="card-head"><div><h3 style="font-size:15px">Withdrawing from</h3><p class="card-sub">Northvale account</p></div></div>
        <div class="kv"><span>Account</span><strong class="tabular">${ui.esc(ui.groupAccountNumber(account.accountNumber || ''))}</strong></div>
        <div class="kv"><span>Available</span><strong class="tabular">${ui.esc(account.availableBalance || ui.fmtUSD(0))}</strong></div>
        <div class="kv"><span>On hold</span><strong class="tabular">${ui.esc(account.pendingHoldsCents ? ui.fmtUSD(account.pendingHoldsCents) : ui.fmtUSD(0))}</strong></div>
        <div class="kv"><span>Holder</span><strong>${ui.esc(`${user.firstName || ''} ${user.lastName || ''}`.trim())}</strong></div>
      </div>
      <div class="card aside-note">
        ${ui.icon('clock')}
        <div>
          <strong>Payout timing</strong>
          <p>Withdrawals are authorised immediately and the amount is held. Operations releases the payout once the destination account is verified, then your receipt shows the final status.</p>
        </div>
      </div>
    </aside>
  </div>`;

  const body = page.querySelector('#flow-body');

  try {
    const data = await api.get('/api/withdrawals/methods');
    state.methods = data.methods || [];
  } catch (error) {
    body.innerHTML = ui.notice('danger', error instanceof ApiError ? error.message : 'Withdrawal methods could not be loaded.');
    return;
  }

  function stepper() {
    return `<ol class="stepper">${STEP_LABELS.map(
      (label, index) => `<li class="step ${state.step === index + 1 ? 'is-active' : ''} ${state.step > index + 1 ? 'is-done' : ''}">
        <span class="step-num">${state.step > index + 1 ? ui.icon('check') : index + 1}</span>
        <span class="step-label">${ui.esc(label)}</span>
      </li>`,
    ).join('')}</ol>`;
  }

  /* ------------------------------ step 1 ------------------------------ */

  function drawMethod() {
    body.innerHTML = `${stepper()}
      <div class="card">
        <div class="card-head"><div><h3>How should we pay you?</h3><p class="card-sub">Select a withdrawal method to continue.</p></div></div>
        <div class="option-grid">
          ${state.methods
            .map(
              (method) => `<button class="option-card ${state.method?.id === method.id ? 'is-selected' : ''}" type="button" data-method="${ui.esc(method.id)}">
                <span class="option-icon">${ui.icon(method.id === 'wire' ? 'trend' : method.id === 'debit_card' ? 'card' : 'bank')}</span>
                <span class="option-text">
                  <strong>${ui.esc(method.label)}</strong>
                  <span>${ui.esc(method.description)}</span>
                  <em>${ui.icon('clock')} ${ui.esc(method.processingTime || '')}</em>
                </span>
                <span class="option-check">${state.method?.id === method.id ? ui.icon('check') : ''}</span>
              </button>`,
            )
            .join('')}
        </div>
        <div class="row" style="margin-top:18px">
          <div class="spacer"></div>
          <button class="btn btn-primary" type="button" data-next ${state.method ? '' : 'disabled'}>Continue ${ui.icon('chevron')}</button>
        </div>
      </div>`;

    body.querySelectorAll('[data-method]').forEach((button) =>
      button.addEventListener('click', () => {
        state.method = state.methods.find((entry) => entry.id === button.dataset.method) || null;
        drawMethod();
      }),
    );
    body.querySelector('[data-next]').addEventListener('click', () => {
      if (!state.method) return;
      state.step = 2;
      drawDestination();
    });
  }

  /* ------------------------------ step 2 ------------------------------ */

  function drawDestination() {
    const needsBank = state.method.requiresBank !== false;
    body.innerHTML = `${stepper()}
      <div class="card">
        <div class="card-head">
          <div><h3>Where should the money go?</h3><p class="card-sub">${ui.esc(state.method.label)} · ${ui.esc(state.method.processingTime || '')}</p></div>
          <button class="btn btn-quiet btn-sm" type="button" data-back>Change method</button>
        </div>

        ${
          needsBank
            ? `<div class="field" data-field="bank">
                <label for="bank-search">Destination bank</label>
                <div class="combo" id="bank-combo">
                  <div class="combo-input">${ui.icon('search')}
                    <input class="input" id="bank-search" type="text" role="combobox" aria-expanded="false" aria-controls="bank-list" aria-autocomplete="list"
                      placeholder="Type a bank name…" autocomplete="off" value="${ui.esc(state.bank?.name || '')}" />
                  </div>
                  <div class="combo-list" id="bank-list" role="listbox" hidden></div>
                </div>
                <span class="error" data-error="bank" hidden></span>
              </div>
              <div class="field" data-field="accountNumber">
                <label for="f-accountNumber">Destination account number</label>
                <input class="input tabular" id="f-accountNumber" name="accountNumber" inputmode="numeric" maxlength="17"
                  placeholder="Account number" value="${ui.esc(state.accountNumber)}" autocomplete="off" />
                <span class="error" data-error="accountNumber" hidden></span>
              </div>
              <div id="lookup-result">${state.recipient ? recipientCard() : ''}</div>
              <button class="btn btn-quiet" type="button" data-verify style="margin-top:12px">${ui.icon('search')} Verify destination account</button>`
            : `<div class="notice info">${ui.icon('card')}<div><strong>Card payout.</strong> The payout is issued to the card on file for your account after operations review. No bank details are required.</div></div>`
        }

        <div class="row" style="margin-top:18px">
          <button class="btn btn-quiet" type="button" data-back>Back</button>
          <div class="spacer"></div>
          <button class="btn btn-primary" type="button" data-next ${needsBank && !state.recipient ? 'disabled' : ''}>Continue ${ui.icon('chevron')}</button>
        </div>
      </div>`;

    body.querySelectorAll('[data-back]').forEach((button) =>
      button.addEventListener('click', () => {
        state.step = 1;
        drawMethod();
      }),
    );

    if (needsBank) {
      const input = body.querySelector('#bank-search');
      const list = body.querySelector('#bank-list');
      const combo = body.querySelector('#bank-combo');
      let items = [];
      let active = -1;
      let timer = null;

      const close = () => {
        list.hidden = true;
        list.innerHTML = '';
        input.setAttribute('aria-expanded', 'false');
        active = -1;
      };

      async function search(term) {
        try {
          const data = await api.get(`/api/banks?q=${encodeURIComponent(term)}`);
          items = data.banks || [];
        } catch {
          items = [];
        }
        if (!items.length) {
          list.innerHTML = '<div class="combo-empty">No matching US bank found.</div>';
        } else {
          list.innerHTML = items
            .map(
              (bank, index) => `<button class="combo-item ${index === active ? 'is-active' : ''}" type="button" role="option" data-index="${index}">
                <span class="ci-mark">${ui.esc((bank.shortName || bank.name).slice(0, 2).toUpperCase())}</span>
                <span class="ci-text"><strong>${ui.esc(bank.name)}</strong><span>Routing ${ui.esc(bank.routingNumber)}</span></span>
              </button>`,
            )
            .join('');
        }
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
      }

      input.addEventListener('input', () => {
        state.bank = null;
        state.recipient = null;
        body.querySelector('[data-next]').disabled = true;
        clearTimeout(timer);
        const term = input.value.trim();
        if (!term) return close();
        timer = setTimeout(() => search(term), 110);
      });

      input.addEventListener('keydown', (event) => {
        if (list.hidden) return;
        if (event.key === 'ArrowDown') {
          active = Math.min(active + 1, items.length - 1);
          list.querySelectorAll('.combo-item').forEach((el, i) => el.classList.toggle('is-active', i === active));
        } else if (event.key === 'Enter' && items[active]) {
          event.preventDefault();
          pick(items[active]);
        } else if (event.key === 'Escape') {
          close();
        }
      });

      function pick(bank) {
        state.bank = bank;
        state.recipient = null;
        input.value = bank.name;
        close();
        body.querySelector('#lookup-result').innerHTML = '';
        body.querySelector('[data-next]').disabled = true;
      }

      list.addEventListener('click', (event) => {
        const button = event.target.closest('.combo-item');
        if (!button) return;
        const bank = items[Number(button.dataset.index)];
        if (bank) pick(bank);
      });
      document.addEventListener('click', (event) => {
        if (!combo.contains(event.target)) close();
      });

      body.querySelector('#f-accountNumber').addEventListener('input', (event) => {
        event.target.value = event.target.value.replace(/[^\d\s]/g, '');
        state.accountNumber = event.target.value.replace(/\s/g, '');
        state.recipient = null;
        body.querySelector('#lookup-result').innerHTML = '';
        body.querySelector('[data-next]').disabled = true;
      });

      body.querySelector('[data-verify]').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const card = body.querySelector('.card');
        ui.clearErrors(card);
        if (!state.bank) return ui.setFieldError(card, 'bank', 'Select the destination bank.');
        if (state.accountNumber.length < 4) return ui.setFieldError(card, 'accountNumber', 'Enter the destination account number.');
        ui.busy(button, true, 'Verifying…');
        try {
          const data = await api.post('/api/recipients/lookup', {
            bankId: state.bank.id,
            bankName: state.bank.name,
            routingNumber: state.bank.routingNumber,
            accountNumber: state.accountNumber,
          });
          state.recipient = data;
          body.querySelector('#lookup-result').innerHTML = recipientCard();
          body.querySelector('[data-next]').disabled = data.status !== 'verified';
          if (data.status !== 'verified') ui.toast(data.message || 'Destination could not be verified.', 'error');
        } catch (error) {
          ui.toast(error instanceof ApiError ? error.message : 'Verification failed.', 'error');
        } finally {
          ui.busy(button, false);
        }
      });
    }

    body.querySelector('[data-next]').addEventListener('click', () => {
      if (state.method.requiresBank !== false && state.recipient?.status !== 'verified') return;
      state.step = 3;
      drawReview();
    });
  }

  function recipientCard() {
    const r = state.recipient;
    if (!r) return '';
    if (r.status === 'verified') {
      return `<div class="verified-card">
        <span class="vc-check">${ui.icon('check')}</span>
        <div><span class="vc-label">Verified destination</span><strong>${ui.esc(r.name)}</strong>
        <span class="vc-sub">${ui.esc(r.bankName)} · ${ui.esc(r.accountNumberMasked)}</span></div>
        <span class="badge success">Verified</span>
      </div>`;
    }
    if (r.status === 'not_found') return ui.notice('danger', r.message || 'No account matches those details.', { strong: 'Not found.' });
    return ui.notice('warn', r.message || 'Destination verification is unavailable. A connected bank directory service is required.', { strong: 'Unavailable.' });
  }

  /* ------------------------------ step 3 ------------------------------ */

  function drawReview() {
    state.idempotencyKey = state.idempotencyKey || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
    body.innerHTML = `${stepper()}
      <div class="card">
        <div class="card-head"><div><h3>Review your withdrawal</h3><p class="card-sub">Confirm the amount and destination, then authorise with your transaction PIN.</p></div></div>

        <div class="field" data-field="amount">
          <label for="f-amount">Withdrawal amount</label>
          <div class="amount-wrap">
            <span class="amount-prefix">$</span>
            <input class="input amount-input tabular" id="f-amount" name="amount" inputmode="decimal" placeholder="0.00" value="${ui.esc(state.amount)}" autocomplete="off" />
            <span class="amount-suffix">USD</span>
          </div>
          <span class="hint">Available to withdraw ${ui.esc(account.availableBalance || ui.fmtUSD(0))}</span>
          <span class="error" data-error="amount" hidden></span>
        </div>

        <div class="field" data-field="description">
          <label for="f-description">Withdrawal description</label>
          <input class="input" id="f-description" name="description" maxlength="120" placeholder="e.g. Payout to savings" value="${ui.esc(state.description)}" autocomplete="off" />
          <span class="error" data-error="description" hidden></span>
        </div>

        <div class="detail-grid" style="margin-top:8px">
          <div><span>Method</span><strong>${ui.esc(state.method.label)}</strong></div>
          <div><span>Processing</span><strong>${ui.esc(state.method.processingTime || '')}</strong></div>
          ${
            state.recipient
              ? `<div><span>Recipient</span><strong>${ui.esc(state.recipient.name)}</strong></div>
                 <div><span>Bank</span><strong>${ui.esc(state.recipient.bankName)}</strong></div>
                 <div><span>Account</span><strong class="tabular">${ui.esc(state.recipient.accountNumberMasked)}</strong></div>`
              : '<div><span>Destination</span><strong>Card on file</strong></div>'
          }
          <div><span>From</span><strong class="tabular">${ui.esc(ui.groupAccountNumber(account.accountNumber || ''))}</strong></div>
        </div>

        <form class="pin-block" id="pin-form" novalidate>
          <div class="pin-head"><div><strong>Transaction PIN</strong><span>Required to authorise this withdrawal.</span></div></div>
          <input class="input pin-input tabular" name="pin" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="••••••" aria-label="Six digit transaction PIN" />
          <span class="error" data-error="pin" hidden></span>
        </form>

        <div class="row" style="margin-top:18px">
          <button class="btn btn-quiet" type="button" data-back>Back</button>
          <div class="spacer"></div>
          <button class="btn btn-primary" type="button" data-submit>${ui.icon('lock')} Confirm withdrawal</button>
        </div>
      </div>`;

    const amountInput = body.querySelector('#f-amount');
    amountInput.addEventListener('input', () => {
      state.amount = amountInput.value;
    });
    body.querySelector('#f-description').addEventListener('input', (event) => {
      state.description = event.target.value;
    });
    body.querySelectorAll('[data-back]').forEach((button) =>
      button.addEventListener('click', () => {
        state.step = 2;
        drawDestination();
      }),
    );

    const pinForm = body.querySelector('#pin-form');
    const pinInput = pinForm.querySelector('[name="pin"]');
    pinInput.addEventListener('input', () => {
      pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 6);
      ui.setFieldError(pinForm, 'pin', '');
    });

    body.querySelector('[data-submit]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const card = body.querySelector('.card');
      ui.clearErrors(card);
      const normalized = state.amount.replace(/[$,]/g, '').trim();
      const value = Number(normalized);
      if (!normalized || !Number.isFinite(value) || value <= 0) return ui.setFieldError(card, 'amount', 'Enter an amount greater than zero.');
      if (!/^\d{6}$/.test(pinInput.value)) return ui.setFieldError(pinForm, 'pin', 'Enter your six-digit transaction PIN.');

      ui.busy(button, true, 'Submitting…');
      try {
        const payload = {
          method: state.method.id,
          amount: value.toFixed(2),
          description: state.description,
          pin: pinInput.value,
        };
        if (state.bank) {
          payload.bankId = state.bank.id;
          payload.routingNumber = state.bank.routingNumber;
          payload.accountNumber = state.accountNumber;
        }
        const data = await api.post('/api/withdrawals', payload);
        state.result = data;
        drawConfirmation();
        ctx.refresh().catch(() => {});
        ctx.loadNotifications().catch(() => {});
      } catch (error) {
        const message = error instanceof ApiError ? error.message : 'The withdrawal could not be submitted.';
        if (error instanceof ApiError && error.details?.field) ui.setFieldError(card, error.details.field, message);
        ui.toast(message, 'error');
      } finally {
        ui.busy(button, false);
      }
    });
  }

  function drawConfirmation() {
    const { transaction, message, receiptUrl, status } = state.result;
    body.innerHTML = `<div class="card confirm-card">
      <div class="confirm-mark ${status === 'completed' ? 'ok' : 'pending'}">${ui.icon(status === 'completed' ? 'check' : 'clock')}</div>
      <h3>${status === 'completed' ? 'Withdrawal complete' : 'Withdrawal submitted'}</h3>
      <p>${ui.esc(message)}</p>
      <div class="detail-grid" style="margin-top:20px">
        <div><span>Reference</span><strong class="tabular">${ui.esc(transaction.reference)}</strong></div>
        <div><span>Status</span><strong>${ui.statusBadge(transaction.status)}</strong></div>
        <div><span>Amount</span><strong class="tabular">${ui.esc(transaction.amount)}</strong></div>
        <div><span>Method</span><strong>${ui.esc(transaction.method ? ui.titleCase(String(transaction.method).replace('_', ' ')) : state.method.label)}</strong></div>
        <div><span>Submitted</span><strong>${ui.esc(ui.fmtDate(transaction.createdAt))}</strong></div>
        <div><span>Recipient</span><strong>${ui.esc(transaction.counterparty?.name || state.recipient?.name || 'Card on file')}</strong></div>
      </div>
      <div class="row" style="margin-top:22px;flex-wrap:wrap">
        <a class="btn btn-primary" href="${ui.esc(receiptUrl)}" download>${ui.icon('download')} Download receipt</a>
        <a class="btn btn-quiet" href="#/transactions/${ui.esc(transaction.id)}">View transaction</a>
        <button class="btn btn-quiet" type="button" data-again>New withdrawal</button>
      </div>
      <p class="confirm-foot">You can track the status of this payout from your transactions page.</p>
    </div>`;

    body.querySelector('[data-again]').addEventListener('click', () => {
      const method = state.method;
      Object.assign(state, freshState(), { method, methods: state.methods });
      drawMethod();
    });
  }

  drawMethod();
}
