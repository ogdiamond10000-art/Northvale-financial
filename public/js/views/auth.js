import { api, ApiError } from '../api.js';
import * as ui from '../ui.js';
import { navigate } from '../router.js';

const US_STATES = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'],
  ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'],
  ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'],
  ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'],
  ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'],
  ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'],
  ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'],
  ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
  ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
];

const ACCOUNT_TYPES = [
  { id: 'checking', name: 'Everyday Checking', blurb: 'Daily spending, direct deposits and bill pay. No monthly fee.' },
  { id: 'savings', name: 'Reserve Savings', blurb: 'Set money aside with a competitive rate and instant transfers.' },
  { id: 'money_market', name: 'Money Market', blurb: 'Higher balance tier with tiered rates and check access.' },
];

function brandAside() {
  return `<aside class="auth-aside">
    <a class="brand" href="#/" style="color:#fff">
      <span class="brand-mark" aria-hidden="true">N</span>
      <span class="brand-text"><span class="brand-name">Northvale</span><span class="brand-sub">Financial</span></span>
    </a>
    <div style="margin-top:auto">
      <span class="eyebrow" style="color:#9db3cd">${ui.icon('bank')} United States · USD</span>
      <h2 style="color:#fff;font-size:clamp(24px,3vw,32px);margin:16px 0 12px;line-height:1.18">A private-banking standard,<br />for everyday accounts.</h2>
      <p style="color:#b9cbe0;font-size:13.5px;max-width:44ch">Verified recipients, transparent settlement and a complete audit trail on every dollar that moves.</p>
      <div class="stack" style="margin-top:24px;gap:12px">
        <div class="row" style="gap:10px;color:#cfdae8;font-size:12.5px;flex-wrap:nowrap">${ui.icon('shield')}<span>Scrypt-hashed credentials · 2FA · transaction PIN</span></div>
        <div class="row" style="gap:10px;color:#cfdae8;font-size:12.5px;flex-wrap:nowrap">${ui.icon('lock')}<span>Server-side authorization on every money movement</span></div>
        <div class="row" style="gap:10px;color:#cfdae8;font-size:12.5px;flex-wrap:nowrap">${ui.icon('file')}<span>Reference numbers and downloadable receipts</span></div>
      </div>
    </div>
    <p style="font-size:11px;color:#8fa3bb;line-height:1.6;margin:0">Northvale Financial is a financial technology company, not a bank. Banking services are provided through partner institutions once those partnerships are finalized.</p>
  </aside>`;
}

function errorToField(form, error) {
  const field = error.details && error.details.field;
  if (field && form.querySelector(`[name="${field}"]`)) {
    ui.setFieldError(form, field, error.message);
    return true;
  }
  return false;
}

/* --------------------------------- sign in --------------------------------- */

export async function renderSignIn(root, ctx) {
  document.title = 'Sign in · Northvale Financial';
  root.innerHTML = `<div class="auth-wrap">
    ${brandAside()}
    <main class="auth-main">
      <div class="auth-card" id="auth-card">
        <div class="card-head">
          <div>
            <span class="eyebrow">${ui.icon('lock')} Secure sign in</span>
            <h1 style="margin:10px 0 6px;font-size:26px">Welcome back</h1>
            <p class="card-sub">Sign in to your Northvale online banking.</p>
          </div>
        </div>
        <form id="signin-form" class="stack" novalidate>
          ${ui.field({ label: 'Email address', name: 'email', type: 'email', placeholder: 'you@example.com', required: true, attrs: 'autocomplete="username"' })}
          <div class="field" data-field="password">
            <label for="f-password">Password</label>
            <div class="row" style="flex-wrap:nowrap;gap:8px">
              <input class="input" id="f-password" name="password" type="password" placeholder="Your password" required autocomplete="current-password" />
              <button class="btn btn-quiet btn-sm" type="button" data-toggle-password style="white-space:nowrap">Show</button>
            </div>
            <span class="error" data-error="password" hidden></span>
          </div>
          <button class="btn btn-primary btn-block" type="submit">Sign in securely</button>
        </form>
        <div id="twofa-slot"></div>
        <div class="auth-foot">
          <span>New to Northvale?</span>
          <a href="#/register">Open an account</a>
        </div>
        <div id="demo-slot" style="margin-top:18px"></div>
      </div>
    </main>
  </div>`;

  const card = root.querySelector('#auth-card');
  const form = root.querySelector('#signin-form');

  root.querySelector('[data-toggle-password]').addEventListener('click', (event) => {
    const input = form.querySelector('[name="password"]');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    event.currentTarget.textContent = showing ? 'Show' : 'Hide';
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    ui.clearErrors(form);
    const button = form.querySelector('button[type="submit"]');
    ui.busy(button, true, 'Signing in…');
    try {
      const data = await api.post('/api/auth/login', ui.formValues(form));
      if (data.twoFactorRequired) {
        renderTwoFactor(root, ctx, data.challengeId, form);
        return;
      }
      await ctx.refresh();
      ui.toast('Signed in. Welcome back.', 'success');
      navigate('/dashboard');
    } catch (error) {
      if (!errorToField(form, error)) ui.toast(error.message, 'error');
    } finally {
      ui.busy(button, false);
    }
  });

  loadDemoAccess(root, form, ctx);
}

function renderTwoFactor(root, ctx, challengeId, form) {
  form.hidden = true;
  const slot = root.querySelector('#twofa-slot');
  slot.innerHTML = `<div class="notice info" style="margin-bottom:14px">${ui.icon('shield')}<div>Two-factor authentication is enabled on this account. Enter the 6-digit code from your authenticator app.</div></div>
    <form id="twofa-form" class="stack" novalidate>
      ${ui.field({ label: 'Authentication code', name: 'code', placeholder: '000000', required: true, attrs: 'inputmode="numeric" maxlength="6" pattern="[0-9]{6}" autocomplete="one-time-code"' })}
      <button class="btn btn-primary btn-block" type="submit">Verify and continue</button>
      <button class="btn btn-quiet btn-block" type="button" data-back>Use a different account</button>
    </form>`;

  const twoFactorForm = slot.querySelector('#twofa-form');
  slot.querySelector('[data-back]').addEventListener('click', () => {
    slot.innerHTML = '';
    form.hidden = false;
  });

  twoFactorForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = twoFactorForm.querySelector('button[type="submit"]');
    ui.busy(button, true, 'Verifying…');
    try {
      await api.post('/api/auth/login/verify-2fa', { challengeId, code: ui.formValues(twoFactorForm).code });
      await ctx.refresh();
      ui.toast('Signed in. Welcome back.', 'success');
      navigate('/dashboard');
    } catch (error) {
      ui.toast(error.message, 'error');
    } finally {
      ui.busy(button, false);
    }
  });
  twoFactorForm.querySelector('[name="code"]').focus();
}

async function loadDemoAccess(root, form, ctx) {
  const slot = root.querySelector('#demo-slot');
  if (!slot) return;
  try {
    const data = await api.get('/api/auth/demo-access');
    if (!data.enabled || !data.accounts?.length) return;
    slot.innerHTML = `<div class="notice info" style="flex-direction:column;align-items:stretch;gap:10px">
      ${ui.icon('user')}
      <div><strong>Demonstration accounts</strong><div style="margin-top:2px">This deployment seeds sample records so you can explore the platform.</div></div>
      <div class="row" style="gap:8px">
        ${data.accounts
          .map(
            (account, index) =>
              `<button class="btn btn-quiet btn-sm" type="button" data-demo="${index}">${ui.esc(account.label)}</button>`,
          )
          .join('')}
      </div>
      <div style="font-size:11.5px;color:var(--silver-500)">Selecting an account fills the form; nothing is submitted automatically.</div>
    </div>`;
    slot.querySelectorAll('[data-demo]').forEach((button) => {
      button.addEventListener('click', () => {
        const account = data.accounts[Number(button.dataset.demo)];
        form.querySelector('[name="email"]').value = account.email;
        form.querySelector('[name="password"]').value = account.password;
        ui.toast(`${account.label} credentials filled in.`, 'success');
      });
    });
  } catch {
    /* demo access is optional */
  }
}

/* -------------------------------- register -------------------------------- */

export async function renderRegister(root, ctx) {
  document.title = 'Open an account · Northvale Financial';
  const draft = {
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    dob: '',
    address: { line1: '', line2: '', city: '', state: '', postalCode: '' },
    accountType: 'checking',
    password: '',
    pin: '',
    identity: { ssnLast4: '', idType: 'drivers_license' },
    consent: false,
  };
  let step = 1;

  root.innerHTML = `<div class="auth-wrap">
    ${brandAside()}
    <main class="auth-main">
      <div class="auth-card" id="reg-card"></div>
    </main>
  </div>`;

  const card = root.querySelector('#reg-card');

  function stepper() {
    const labels = ['Your details', 'Account setup', 'Identity verification'];
    return `<div class="stepper">
      ${labels
        .map(
          (label, index) => `
        <div class="step ${step === index + 1 ? 'is-active' : ''} ${step > index + 1 ? 'is-done' : ''}">
          <span class="n">${step > index + 1 ? '✓' : index + 1}</span><span>${label}</span>
        </div>
        ${index < labels.length - 1 ? '<div class="step-line"></div>' : ''}`,
        )
        .join('')}
    </div>`;
  }

  function renderStep() {
    if (step === 1) {
      card.innerHTML = `${stepper()}
        <div class="card-head"><div><span class="eyebrow">${ui.icon('user')} Account application</span>
          <h1 style="margin:10px 0 6px;font-size:25px">Open your Northvale account</h1>
          <p class="card-sub">Step 1 of 3 · Personal details. All fields are required unless marked optional.</p></div></div>
        <form id="step-form" class="stack" novalidate>
          <div class="grid cols-2">
            ${ui.field({ label: 'First name', name: 'firstName', value: draft.firstName, required: true, placeholder: 'Jordan' })}
            ${ui.field({ label: 'Last name', name: 'lastName', value: draft.lastName, required: true, placeholder: 'Ellis' })}
          </div>
          <div class="grid cols-2">
            ${ui.field({ label: 'Email address', name: 'email', type: 'email', value: draft.email, required: true, placeholder: 'you@example.com' })}
            ${ui.field({ label: 'Phone number', name: 'phone', type: 'tel', value: draft.phone, required: true, placeholder: '(415) 555-0188', hint: 'US 10-digit number' })}
          </div>
          ${ui.field({ label: 'Date of birth', name: 'dob', type: 'date', value: draft.dob, required: true, hint: 'You must be at least 18 years old.' })}
          ${ui.field({ label: 'Street address', name: 'line1', value: draft.address.line1, required: true, placeholder: '1180 Harbor View Drive' })}
          ${ui.field({ label: 'Apartment, suite or unit', name: 'line2', value: draft.address.line2, placeholder: 'Apt 4B' })}
          <div class="grid cols-2">
            ${ui.field({ label: 'City', name: 'city', value: draft.address.city, required: true, placeholder: 'San Francisco' })}
            <div class="field"><label for="f-state">State</label>
              <select class="select" id="f-state" name="state" required>
                <option value="">Select state</option>
                ${US_STATES.map(([code, name]) => `<option value="${code}" ${draft.address.state === code ? 'selected' : ''}>${name}</option>`).join('')}
              </select>
              <span class="error" data-error="state" hidden></span>
            </div>
          </div>
          <div class="grid cols-2">
            ${ui.field({ label: 'ZIP code', name: 'postalCode', value: draft.address.postalCode, required: true, placeholder: '94105', attrs: 'inputmode="numeric" maxlength="10"' })}
            <div></div>
          </div>
          <button class="btn btn-primary btn-block" type="submit">Continue to account setup</button>
          <p style="font-size:11.5px;color:var(--silver-500);text-align:center;margin:0">Already have an account? <a href="#/signin">Sign in</a></p>
        </form>`;

      const form = card.querySelector('#step-form');
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        ui.clearErrors(form);
        const values = ui.formValues(form);
        const required = ['firstName', 'lastName', 'email', 'phone', 'dob', 'line1', 'city', 'state', 'postalCode'];
        let valid = true;
        required.forEach((name) => {
          if (!values[name]) {
            ui.setFieldError(form, name, 'This field is required.');
            valid = false;
          }
        });
        if (!valid) return;
        draft.firstName = values.firstName;
        draft.lastName = values.lastName;
        draft.email = values.email;
        draft.phone = values.phone;
        draft.dob = values.dob;
        draft.address = { line1: values.line1, line2: values.line2, city: values.city, state: values.state, postalCode: values.postalCode };
        step = 2;
        renderStep();
      });
      return;
    }

    if (step === 2) {
      card.innerHTML = `${stepper()}
        <div class="card-head"><div><span class="eyebrow">${ui.icon('bank')} Account setup</span>
          <h1 style="margin:10px 0 6px;font-size:25px">Choose your account</h1>
          <p class="card-sub">Step 2 of 3 · Account type, password and transaction PIN.</p></div></div>
        <form id="step-form" class="stack" novalidate>
          <div class="account-type-grid">
            ${ACCOUNT_TYPES.map(
              (type) => `<label class="type-option ${draft.accountType === type.id ? 'is-selected' : ''}" data-type="${type.id}">
                <input type="radio" name="accountType" value="${type.id}" ${draft.accountType === type.id ? 'checked' : ''} />
                <span><strong>${ui.esc(type.name)}</strong><span>${ui.esc(type.blurb)}</span></span>
              </label>`,
            ).join('')}
          </div>
          ${ui.field({ label: 'Password', name: 'password', type: 'password', required: true, hint: 'At least 10 characters with upper and lower case, a number and a symbol.' })}
          ${ui.field({ label: 'Confirm password', name: 'confirmPassword', type: 'password', required: true })}
          ${ui.field({ label: 'Transaction PIN', name: 'pin', type: 'password', required: true, hint: '4–6 digits. Required to approve transfers and withdrawals.', attrs: 'inputmode="numeric" maxlength="6"' })}
          <label class="checkbox"><input type="checkbox" name="consent" ${draft.consent ? 'checked' : ''} />
            <span>I agree to the Northvale account agreement and electronic disclosures, and I confirm I am a US resident aged 18 or older.</span></label>
          <span class="error" data-error="consent" hidden></span>
          <div class="row" style="gap:10px">
            <button class="btn btn-quiet" type="button" data-back>Back</button>
            <button class="btn btn-primary" type="submit" style="flex:1">Continue to verification</button>
          </div>
        </form>`;

      const form = card.querySelector('#step-form');
      form.querySelectorAll('[data-type]').forEach((label) => {
        label.addEventListener('click', () => {
          form.querySelectorAll('[data-type]').forEach((other) => other.classList.remove('is-selected'));
          label.classList.add('is-selected');
        });
      });
      form.querySelector('[data-back]').addEventListener('click', () => {
        step = 1;
        renderStep();
      });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        ui.clearErrors(form);
        const values = ui.formValues(form);
        const password = form.querySelector('[name="password"]').value;
        const confirm = form.querySelector('[name="confirmPassword"]').value;
        const pin = form.querySelector('[name="pin"]').value.replace(/\D/g, '');
        let valid = true;
        if (password.length < 10 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
          ui.setFieldError(form, 'password', 'Use 10+ characters with upper and lower case, a number and a symbol.');
          valid = false;
        }
        if (password !== confirm) {
          ui.setFieldError(form, 'confirmPassword', 'Passwords do not match.');
          valid = false;
        }
        if (!/^\d{4,6}$/.test(pin)) {
          ui.setFieldError(form, 'pin', 'Enter a 4–6 digit PIN.');
          valid = false;
        }
        if (!values.consent) {
          ui.setFieldError(form, 'consent', 'You must accept the agreement to continue.');
          valid = false;
        }
        if (!valid) return;
        draft.accountType = values.accountType || 'checking';
        draft.password = password;
        draft.pin = pin;
        draft.consent = true;
        step = 3;
        renderStep();
      });
      return;
    }

    card.innerHTML = `${stepper()}
      <div class="card-head"><div><span class="eyebrow">${ui.icon('shield')} Identity verification</span>
        <h1 style="margin:10px 0 6px;font-size:25px">Verify your identity</h1>
        <p class="card-sub">Step 3 of 3 · Required by federal customer-identification rules. Your application is reviewed by our operations team.</p></div></div>
      <form id="step-form" class="stack" novalidate>
        ${ui.field({ label: 'Last 4 digits of SSN', name: 'ssnLast4', required: true, hint: 'Only the final four digits are stored, encrypted at rest.', attrs: 'inputmode="numeric" maxlength="4"' })}
        <div class="field"><label for="f-idType">Identity document</label>
          <select class="select" id="f-idType" name="idType">
            <option value="drivers_license">Driver’s licence</option>
            <option value="state_id">State identification card</option>
            <option value="passport">Passport</option>
            <option value="us_passport">US passport card</option>
          </select>
        </div>
        <div class="card" style="background:var(--silver-50);box-shadow:none">
          <div class="detail-grid">
            <div><span class="bc-label">Applicant</span><strong>${ui.esc(`${draft.firstName} ${draft.lastName}`)}</strong></div>
            <div><span class="bc-label">Email</span><strong>${ui.esc(draft.email)}</strong></div>
            <div><span class="bc-label">Address</span><strong>${ui.esc(`${draft.address.line1}, ${draft.address.city}, ${draft.address.state} ${draft.address.postalCode}`)}</strong></div>
            <div><span class="bc-label">Account</span><strong>${ui.esc(ui.accountTypeLabel(draft.accountType))}</strong></div>
          </div>
        </div>
        <div class="notice info">${ui.icon('lock')}<div>Your account number is issued immediately after registration. Money movement is enabled once identity verification is approved.</div></div>
        <div class="row" style="gap:10px">
          <button class="btn btn-quiet" type="button" data-back>Back</button>
          <button class="btn btn-primary" type="submit" style="flex:1">Submit application</button>
        </div>
      </form>`;

    const form = card.querySelector('#step-form');
    form.querySelector('[data-back]').addEventListener('click', () => {
      step = 2;
      renderStep();
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      ui.clearErrors(form);
      const button = form.querySelector('button[type="submit"]');
      ui.busy(button, true, 'Submitting…');
      const values = ui.formValues(form);
      try {
        const data = await api.post('/api/auth/register', {
          firstName: draft.firstName,
          lastName: draft.lastName,
          email: draft.email,
          phone: draft.phone,
          dob: draft.dob,
          address: draft.address,
          accountType: draft.accountType,
          password: draft.password,
          pin: draft.pin,
          consent: draft.consent,
          identity: { ssnLast4: values.ssnLast4, idType: values.idType },
        });
        await ctx.refresh();
        card.innerHTML = `<div class="success-mark">${ui.icon('check')}</div>
          <h1 style="text-align:center;font-size:25px;margin-bottom:8px">Your account is open</h1>
          <p style="text-align:center;color:var(--ink-soft);font-size:13.5px;margin:0 0 18px">${ui.esc(data.message || 'Identity verification is under review.')}</p>
          <div class="card" style="background:var(--silver-50);box-shadow:none">
            <div class="detail-grid">
              <div><span class="bc-label">Account number</span><strong class="tabular">${ui.esc(ui.groupAccountNumber(data.account.accountNumber))}</strong></div>
              <div><span class="bc-label">Routing number</span><strong class="tabular">${ui.esc(data.account.routingNumber)}</strong></div>
              <div><span class="bc-label">Account type</span><strong>${ui.esc(ui.accountTypeLabel(data.account.accountType))}</strong></div>
              <div><span class="bc-label">Status</span><strong>Verification pending</strong></div>
            </div>
          </div>
          <div class="notice warn" style="margin-top:16px">${ui.icon('alert')}<div>Keep your account number safe. Deposits, transfers and withdrawals unlock as soon as our operations team approves your identity documents.</div></div>
          <a class="btn btn-primary btn-block" href="#/dashboard" style="margin-top:16px">Go to your dashboard</a>`;
        ui.toast('Account created. Welcome to Northvale.', 'success');
      } catch (error) {
        if (!errorToField(form, error)) ui.toast(error.message, 'error');
        ui.busy(button, false);
      }
    });
  }

  renderStep();
}
