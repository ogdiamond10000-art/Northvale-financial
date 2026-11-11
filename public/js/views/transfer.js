import { api, ApiError } from '../api.js';
import * as ui from '../ui.js';
import { navigate } from '../router.js';

const STEP_LABELS = ['Recipient', 'Amount & details', 'Review & approve'];

function freshState() {
  return {
    step: 1,
    bank: null,
    accountNumber: '',
    recipient: null,
    lookupMessage: '',
    amount: '',
    description: '',
    pin: '',
    idempotencyKey: null,
    result: null,
    biometricOk: false,
  };
}

export async function renderTransfer(page, ctx) {
  ctx.setTitle('Transfer', 'Move money');
  const state = freshState();
  const user = ctx.state.user || {};
  const account = ctx.state.account || {};

  page.innerHTML = `<div class="flow-wrap">
    <div class="flow-main">
      <div class="section-head">
        <div>
          <h2>Send a transfer</h2>
          <p>Verified recipients, reviewed details and a transaction PIN for every payment.</p>
        </div>
      </div>
      <div id="flow-body"></div>
    </div>
    <aside class="flow-aside">
      <div class="card">
        <div class="card-head"><div><h3 style="font-size:15px">Paying from</h3><p class="card-sub">Northvale account</p></div></div>
        <div class="kv"><span>Account</span><strong class="tabular">${ui.esc(ui.groupAccountNumber(account.accountNumber || ''))}</strong></div>
        <div class="kv"><span>Type</span><strong>${ui.esc(ui.accountTypeLabel(account.accountType || 'checking'))}</strong></div>
        <div class="kv"><span>Available</span><strong class="tabular">${ui.esc(account.availableBalance || ui.fmtUSD(0))}</strong></div>
        <div class="kv"><span>Account holder</span><strong>${ui.esc(`${user.firstName || ''} ${user.lastName || ''}`.trim())}</strong></div>
      </div>
      <div class="card aside-note">
        ${ui.icon('shield')}
        <div>
          <strong>How settlement works</strong>
          <p>Transfers to Northvale customers settle instantly. Transfers to other US banks are queued, the amount is held, and operations release it once the receiving institution confirms the credit.</p>
        </div>
      </div>
    </aside>
  </div>`;

  const body = page.querySelector('#flow-body');

  function stepper() {
    return `<ol class="stepper">${STEP_LABELS.map(
      (label, index) => `<li class="step ${state.step === index + 1 ? 'is-active' : ''} ${state.step > index + 1 ? 'is-done' : ''}">
        <span class="step-num">${state.step > index + 1 ? ui.icon('check') : index + 1}</span>
        <span class="step-label">${ui.esc(label)}</span>
      </li>`,
    ).join('')}</ol>`;
  }

  /* ------------------------------ step 1 ------------------------------ */

  function drawRecipient() {
    body.innerHTML = `${stepper()}
      <div class="card">
        <div class="card-head">
          <div><h3>Who are you paying?</h3><p class="card-sub">Start typing a bank name — matching US institutions appear immediately.</p></div>
        </div>
        <div class="field" data-field="bank">
          <label for="bank-search">Recipient bank</label>
          <div class="combo" id="bank-combo">
            <div class="combo-input">
              ${ui.icon('search')}
              <input class="input" id="bank-search" type="text" role="combobox" aria-expanded="false" aria-controls="bank-list"
                aria-autocomplete="list" placeholder="Type “ba”, “cha”, “well”…" autocomplete="off" value="${ui.esc(state.bank?.name || '')}" />
            </div>
            <div class="combo-list" id="bank-list" role="listbox" hidden></div>
          </div>
          <span class="hint">Search by bank name, short name or routing number.</span>
          <span class="error" data-error="bank" hidden></span>
        </div>

        <div class="field" data-field="accountNumber">
          <label for="f-accountNumber">Recipient account number</label>
          <input class="input tabular" id="f-accountNumber" name="accountNumber" inputmode="numeric" maxlength="17"
            placeholder="Account number" value="${ui.esc(state.accountNumber)}" autocomplete="off" />
          <span class="hint">Northvale accounts are 10 digits. Other US accounts may be 4–17 digits.</span>
          <span class="error" data-error="accountNumber" hidden></span>
        </div>

        <div id="lookup-result">${state.recipient ? recipientCard() : ''}</div>

        <div class="row" style="margin-top:18px">
          <button class="btn btn-quiet" type="button" data-verify ${state.recipient ? 'disabled' : ''}>${ui.icon('search')} Verify recipient name</button>
          <div class="spacer"></div>
          <button class="btn btn-primary" type="button" data-next ${state.recipient ? '' : 'disabled'}>Continue ${ui.icon('chevron')}</button>
        </div>
      </div>`;

    const combo = body.querySelector('#bank-combo');
    const input = body.querySelector('#bank-search');
    const list = body.querySelector('#bank-list');
    let items = [];
    let active = -1;
    let timer = null;

    function closeList() {
      list.hidden = true;
      list.innerHTML = '';
      input.setAttribute('aria-expanded', 'false');
      active = -1;
    }

    function highlight() {
      list.querySelectorAll('[role="option"]').forEach((el, index) => {
        el.classList.toggle('is-active', index === active);
        el.setAttribute('aria-selected', String(index === active));
      });
    }

    function choose(bank) {
      state.bank = bank;
      state.recipient = null;
      input.value = bank.name;
      closeList();
      body.querySelector('#lookup-result').innerHTML = '';
      body.querySelector('[data-verify]').disabled = false;
      body.querySelector('[data-next]').disabled = true;
      ui.setFieldError(body.querySelector('.card'), 'bank', '');
    }

    function paintList(banks) {
      items = banks;
      if (!banks.length) {
        list.innerHTML = `<div class="combo-empty">No matching US bank found. Check the spelling and try again.</div>`;
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        return;
      }
      list.innerHTML = banks
        .map(
          (bank, index) => `<button class="combo-item ${index === active ? 'is-active' : ''}" type="button" role="option" aria-selected="${index === active}" data-index="${index}">
            <span class="ci-mark">${ui.esc((bank.shortName || bank.name).slice(0, 2).toUpperCase())}</span>
            <span class="ci-text"><strong>${ui.esc(bank.name)}</strong><span>Routing ${ui.esc(bank.routingNumber)}${bank.city ? ` · ${ui.esc(bank.city)}, ${ui.esc(bank.state)}` : ''}</span></span>
          </button>`,
        )
        .join('');
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }

    async function search(term) {
      try {
        const data = await api.get(`/api/banks?q=${encodeURIComponent(term)}`);
        paintList(data.banks || []);
      } catch {
        paintList([]);
      }
    }

    input.addEventListener('input', () => {
      const term = input.value.trim();
      state.bank = null;
      state.recipient = null;
      body.querySelector('[data-next]').disabled = true;
      clearTimeout(timer);
      if (!term) {
        closeList();
        return;
      }
      timer = setTimeout(() => search(term), 110);
    });

    input.addEventListener('keydown', (event) => {
      if (list.hidden) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        active = Math.min(active + 1, items.length - 1);
        highlight();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        active = Math.max(active - 1, 0);
        highlight();
      } else if (event.key === 'Enter') {
        if (items[active]) {
          event.preventDefault();
          choose(items[active]);
        }
      } else if (event.key === 'Escape') {
        closeList();
      }
    });

    list.addEventListener('click', (event) => {
      const button = event.target.closest('.combo-item');
      if (!button) return;
      const bank = items[Number(button.dataset.index)];
      if (bank) choose(bank);
    });

    document.addEventListener('click', (event) => {
      if (!combo.contains(event.target)) closeList();
    });

    const accountInput = body.querySelector('#f-accountNumber');
    accountInput.addEventListener('input', () => {
      accountInput.value = accountInput.value.replace(/[^\d\s]/g, '');
      state.accountNumber = accountInput.value.replace(/\s/g, '');
      state.recipient = null;
      body.querySelector('#lookup-result').innerHTML = '';
      body.querySelector('[data-next]').disabled = true;
    });

    body.querySelector('[data-verify]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const card = body.querySelector('.card');
      ui.clearErrors(card);
      let invalid = false;
      if (!state.bank) {
        ui.setFieldError(card, 'bank', 'Select the recipient bank from the list.');
        invalid = true;
      }
      if (state.accountNumber.length < 4) {
        ui.setFieldError(card, 'accountNumber', 'Enter the recipient account number.');
        invalid = true;
      }
      if (invalid) return;

      ui.busy(button, true, 'Verifying…');
      try {
        const data = await api.post('/api/recipients/lookup', {
          bankId: state.bank.id,
          bankName: state.bank.name,
          routingNumber: state.bank.routingNumber,
          accountNumber: state.accountNumber,
        });
        state.recipient = data;
        state.lookupMessage = data.message || '';
        body.querySelector('#lookup-result').innerHTML = recipientCard();
        const verified = data.status === 'verified';
        body.querySelector('[data-next]').disabled = !verified;
        if (!verified) ui.toast(data.message || 'Recipient could not be verified.', 'error');
      } catch (error) {
        const message = error instanceof ApiError ? error.message : 'Recipient verification failed.';
        ui.toast(message, 'error');
        if (error instanceof ApiError && error.details?.field) ui.setFieldError(card, error.details.field, message);
      } finally {
        ui.busy(button, false);
      }
    });

    body.querySelector('[data-next]').addEventListener('click', () => {
      if (!state.recipient || state.recipient.status !== 'verified') return;
      state.step = 2;
      drawAmount();
    });
  }

  function recipientCard() {
    const r = state.recipient;
    if (!r) return '';
    if (r.status === 'verified') {
      return `<div class="verified-card">
        <span class="vc-check">${ui.icon('check')}</span>
        <div>
          <span class="vc-label">Verified recipient</span>
          <strong>${ui.esc(r.name)}</strong>
          <span class="vc-sub">${ui.esc(r.bankName)} · ${ui.esc(r.accountNumberMasked)}${r.internal ? ' · Northvale customer (instant)' : ''}</span>
        </div>
        <span class="badge success">Verified</span>
      </div>`;
    }
    if (r.status === 'not_found') {
      return ui.notice('danger', r.message || 'No account matches those details at that bank.', { strong: 'Recipient not found.' });
    }
    return ui.notice(
      'warn',
      r.message ||
        'Recipient name verification is not available right now. A connected bank directory service is required before external transfers can be approved.',
      { strong: 'Verification unavailable.' },
    );
  }

  /* ------------------------------ step 2 ------------------------------ */

  function drawAmount() {
    body.innerHTML = `${stepper()}
      <div class="card">
        <div class="card-head">
          <div><h3>How much are you sending?</h3><p class="card-sub">Amounts are in US dollars. Available balance ${ui.esc(account.availableBalance || ui.fmtUSD(0))}.</p></div>
        </div>
        <div class="review-recipient">
          <span class="ci-mark">${ui.esc((state.recipient.bankName || 'NV').slice(0, 2).toUpperCase())}</span>
          <div><strong>${ui.esc(state.recipient.name)}</strong><span>${ui.esc(state.recipient.bankName)} · ${ui.esc(state.recipient.accountNumberMasked)}</span></div>
          <button class="btn btn-quiet btn-sm" type="button" data-back>${ui.icon('chevron')} Change</button>
        </div>

        <div class="field" data-field="amount">
          <label for="f-amount">Transfer amount</label>
          <div class="amount-wrap">
            <span class="amount-prefix">$</span>
            <input class="input amount-input tabular" id="f-amount" name="amount" inputmode="decimal" placeholder="0.00" value="${ui.esc(state.amount)}" autocomplete="off" />
            <span class="amount-suffix">USD</span>
          </div>
          <span class="error" data-error="amount" hidden></span>
        </div>

        <div class="field" data-field="description">
          <label for="f-description">Payment description</label>
          <input class="input" id="f-description" name="description" maxlength="120" placeholder="e.g. November rent" value="${ui.esc(state.description)}" autocomplete="off" />
          <span class="hint">Appears on your statement and the recipient's record.</span>
          <span class="error" data-error="description" hidden></span>
        </div>

        <div class="row" style="margin-top:18px">
          <button class="btn btn-quiet" type="button" data-back>Back</button>
          <div class="spacer"></div>
          <button class="btn btn-primary" type="button" data-review>Review transfer ${ui.icon('chevron')}</button>
        </div>
      </div>`;

    const amountInput = body.querySelector('#f-amount');
    amountInput.addEventListener('input', () => {
      state.amount = amountInput.value;
      ui.setFieldError(body.querySelector('.card'), 'amount', '');
    });
    body.querySelector('#f-description').addEventListener('input', (event) => {
      state.description = event.target.value;
    });

    body.querySelectorAll('[data-back]').forEach((button) =>
      button.addEventListener('click', () => {
        state.step = 1;
        drawRecipient();
      }),
    );

    body.querySelector('[data-review]').addEventListener('click', () => {
      const card = body.querySelector('.card');
      ui.clearErrors(card);
      const normalized = state.amount.replace(/[$,]/g, '').trim();
      const value = Number(normalized);
      if (!normalized || !Number.isFinite(value) || value <= 0) {
        ui.setFieldError(card, 'amount', 'Enter an amount greater than zero.');
        return;
      }
      if (value < 1) {
        ui.setFieldError(card, 'amount', 'The minimum transfer is $1.00.');
        return;
      }
      state.amount = value.toFixed(2);
      state.step = 3;
      drawReview();
    });
  }

  /* ------------------------------ step 3 ------------------------------ */

  function drawReview() {
    state.idempotencyKey = state.idempotencyKey || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
    const amountCents = Math.round(Number(state.amount) * 100);
    body.innerHTML = `${stepper()}
      <div class="card">
        <div class="card-head">
          <div><h3>Review before you approve</h3><p class="card-sub">Confirm every detail. Transfers cannot be recalled once the recipient bank settles them.</p></div>
          <span class="badge info">USD</span>
        </div>

        <div class="review-amount">
          <span>Amount</span>
          <strong class="tabular">${ui.esc(ui.fmtUSD(amountCents))}</strong>
          <span class="review-amount-sub">${ui.esc(state.description || 'No description')}</span>
        </div>

        <div class="detail-grid">
          <div><span>Recipient</span><strong>${ui.esc(state.recipient.name)}</strong></div>
          <div><span>Bank</span><strong>${ui.esc(state.recipient.bankName)}</strong></div>
          <div><span>Account</span><strong class="tabular">${ui.esc(state.recipient.accountNumberMasked)}</strong></div>
          <div><span>Routing number</span><strong class="tabular">${ui.esc(state.recipient.routingNumber || state.bank.routingNumber)}</strong></div>
          <div><span>From</span><strong class="tabular">${ui.esc(ui.groupAccountNumber(account.accountNumber || ''))}</strong></div>
          <div><span>Settlement</span><strong>${state.recipient.internal ? 'Instant · Northvale ledger' : 'Next business day · receiving bank'}</strong></div>
        </div>

        <form class="pin-block" id="pin-form" novalidate>
          <div class="pin-head">
            <div><strong>Transaction PIN</strong><span>Required to authorise this transfer.</span></div>
            <button class="btn btn-quiet btn-sm" type="button" data-biometric hidden>${ui.icon('fingerprint')} Use device biometrics</button>
          </div>
          <input class="input pin-input tabular" name="pin" inputmode="numeric" maxlength="6" autocomplete="one-time-code"
            placeholder="••••••" aria-label="Six digit transaction PIN" />
          <span class="error" data-error="pin" hidden></span>
          <span class="hint" id="bio-hint"></span>
        </form>

        <div class="row" style="margin-top:18px">
          <button class="btn btn-quiet" type="button" data-back>Back</button>
          <div class="spacer"></div>
          <button class="btn btn-primary" type="button" data-submit>${ui.icon('lock')} Approve transfer</button>
        </div>
      </div>`;

    const pinForm = body.querySelector('#pin-form');
    const pinInput = pinForm.querySelector('[name="pin"]');
    const bioButton = body.querySelector('[data-biometric]');
    const bioHint = body.querySelector('#bio-hint');

    pinInput.addEventListener('input', () => {
      pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 6);
      ui.setFieldError(pinForm, 'pin', '');
    });

    (async () => {
      try {
        const available = await window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.();
        if (available) {
          bioButton.hidden = false;
          bioHint.textContent = 'Device biometrics can approve the step locally; your transaction PIN is still verified by Northvale.';
        } else {
          bioHint.textContent = 'This device does not offer a platform biometric authenticator, so the transaction PIN is required.';
        }
      } catch {
        bioHint.textContent = 'Biometric availability could not be checked on this device.';
      }
    })();

    bioButton.addEventListener('click', async () => {
      ui.busy(bioButton, true, 'Prompting…');
      try {
        const challenge = crypto.getRandomValues(new Uint8Array(32));
        const id = crypto.getRandomValues(new Uint8Array(16));
        await navigator.credentials.create({
          publicKey: {
            challenge,
            rp: { name: 'Northvale Financial' },
            user: { id, name: ctx.state.user?.email || 'customer', displayName: `${ctx.state.user?.firstName || 'Northvale'} customer` },
            pubKeyCredParams: [
              { type: 'public-key', alg: -7 },
              { type: 'public-key', alg: -257 },
            ],
            authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
            timeout: 60000,
          },
        });
        state.biometricOk = true;
        bioHint.textContent = 'Device check completed. Enter your transaction PIN to authorise the transfer.';
        ui.toast('Device biometric check completed.', 'success');
        pinInput.focus();
      } catch {
        bioHint.textContent = 'The device check was cancelled. Enter your transaction PIN to continue.';
      } finally {
        ui.busy(bioButton, false);
      }
    });

    body.querySelectorAll('[data-back]').forEach((button) =>
      button.addEventListener('click', () => {
        state.step = 2;
        drawAmount();
      }),
    );

    body.querySelector('[data-submit]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      ui.clearErrors(pinForm);
      if (!/^\d{6}$/.test(pinInput.value)) {
        ui.setFieldError(pinForm, 'pin', 'Enter your six-digit transaction PIN.');
        return;
      }
      ui.busy(button, true, 'Submitting…');
      try {
        const data = await api.post('/api/transfers', {
          bankId: state.bank.id,
          routingNumber: state.bank.routingNumber,
          accountNumber: state.accountNumber,
          amount: state.amount,
          description: state.description,
          pin: pinInput.value,
          idempotencyKey: state.idempotencyKey,
        });
        state.result = data;
        state.step = 4;
        drawConfirmation();
        ctx.refresh().catch(() => {});
        ctx.loadNotifications().catch(() => {});
      } catch (error) {
        const message = error instanceof ApiError ? error.message : 'The transfer could not be submitted.';
        if (error instanceof ApiError && error.details?.field) ui.setFieldError(pinForm, error.details.field, message);
        ui.toast(message, 'error');
        if (error instanceof ApiError && error.code === 'pin_incorrect') pinInput.value = '';
      } finally {
        ui.busy(button, false);
      }
    });
  }

  /* ------------------------------ step 4 ------------------------------ */

  function drawConfirmation() {
    const { transaction, message, receiptUrl, status } = state.result;
    body.innerHTML = `<div class="card confirm-card">
      <div class="confirm-mark ${status === 'completed' ? 'ok' : 'pending'}">${ui.icon(status === 'completed' ? 'check' : 'clock')}</div>
      <h3>${status === 'completed' ? 'Transfer complete' : 'Transfer submitted'}</h3>
      <p>${ui.esc(message)}</p>
      <div class="detail-grid" style="margin-top:20px">
        <div><span>Reference</span><strong class="tabular">${ui.esc(transaction.reference)}</strong></div>
        <div><span>Status</span><strong>${ui.statusBadge(transaction.status)}</strong></div>
        <div><span>Amount</span><strong class="tabular">${ui.esc(transaction.amount)}</strong></div>
        <div><span>Recipient</span><strong>${ui.esc(transaction.counterparty?.name || state.recipient.name)}</strong></div>
        <div><span>Bank</span><strong>${ui.esc(transaction.counterparty?.bank || state.recipient.bankName)}</strong></div>
        <div><span>Submitted</span><strong>${ui.esc(ui.fmtDate(transaction.createdAt))}</strong></div>
      </div>
      <div class="row" style="margin-top:22px;flex-wrap:wrap">
        <a class="btn btn-primary" href="${ui.esc(receiptUrl)}" download>${ui.icon('download')} Download receipt</a>
        <a class="btn btn-quiet" href="#/transactions/${ui.esc(transaction.id)}">View transaction</a>
        <button class="btn btn-quiet" type="button" data-again>New transfer</button>
      </div>
      <p class="confirm-foot">Keep your reference number for support. Funds are held until settlement is confirmed by the receiving institution.</p>
    </div>`;

    body.querySelector('[data-again]').addEventListener('click', () => {
      Object.assign(state, freshState());
      drawRecipient();
    });
  }

  drawRecipient();
}
