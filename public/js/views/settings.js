import { api, ApiError } from '../api.js';
import * as ui from '../ui.js';

const ID_TYPES = [
  { id: 'drivers_license', label: "Driver's licence" },
  { id: 'state_id', label: 'State ID card' },
  { id: 'passport', label: 'Passport' },
  { id: 'us_passport', label: 'US passport card' },
];

export async function renderSettings(page, ctx) {
  ctx.setTitle('Profile & security', 'Account settings');
  const user = ctx.state.user || {};
  const account = ctx.state.account || {};
  const address = user.address || {};
  const addressLine = [address.line1, address.line2, address.city, address.state, address.postalCode]
    .filter(Boolean)
    .join(', ');

  page.innerHTML = `<div class="section-head">
      <div><h2>Profile &amp; security</h2><p>Your personal details, sign-in protection and transaction authorisation.</p></div>
      <span class="chip chip-lg">${ui.esc(ui.accountTypeLabel(account.accountType || account.type))} · ${ui.esc(ui.groupAccountNumber(account.accountNumber || ''))}</span>
    </div>

    <div class="settings-grid">
      <section class="card">
        <div class="card-head"><h3>Personal details</h3>${ui.kycBadge(user.kycStatus)}</div>
        <dl class="kv">
          <div><dt>Full name</dt><dd>${ui.esc(`${user.firstName || ''} ${user.lastName || ''}`.trim())}</dd></div>
          <div><dt>Email</dt><dd>${ui.esc(user.email || '')}</dd></div>
          <div><dt>Phone</dt><dd class="tabular">${ui.esc(user.phone || '')}</dd></div>
          <div><dt>Residential address</dt><dd>${ui.esc(addressLine || '—')}</dd></div>
          <div><dt>Date of birth</dt><dd class="tabular">${ui.esc(ui.fmtDate(user.dob))}</dd></div>
          <div><dt>Member since</dt><dd>${ui.esc(ui.fmtDate(user.createdAt))}</dd></div>
          <div><dt>Account status</dt><dd>${ui.esc(ui.titleCase(user.status || 'active'))}</dd></div>
          <div><dt>Last sign-in</dt><dd>${ui.esc(user.lastLoginAt ? ui.fmtDate(user.lastLoginAt, { timeStyle: 'short' }) : 'This session')}</dd></div>
        </dl>
        <hr class="rule" />
        <form class="stack" data-profile novalidate>
          <h4>Update personal details</h4>
          ${user.profileComplete ? '' : ui.notice('warn', 'Add your residential address and date of birth to finish identity verification.')}
          <div class="form-grid">
            ${ui.field({ label: 'Phone number', name: 'phone', type: 'tel', value: user.phone || '', attrs: 'autocomplete="tel"' })}
            ${ui.field({ label: 'Date of birth', name: 'dob', type: 'date', value: user.dob || '' })}
            <div class="span-2">${ui.field({ label: 'Street address', name: 'line1', value: address.line1 || '', attrs: 'autocomplete="address-line1"' })}</div>
            <div class="span-2">${ui.field({ label: 'Address line 2', name: 'line2', value: address.line2 || '', attrs: 'autocomplete="address-line2"' })}</div>
            ${ui.field({ label: 'City', name: 'city', value: address.city || '', attrs: 'autocomplete="address-level2"' })}
            ${ui.field({ label: 'State', name: 'state', value: address.state || '', attrs: 'autocomplete="address-level1" maxlength="2"' })}
            ${ui.field({ label: 'ZIP code', name: 'postalCode', value: address.postalCode || '', attrs: 'autocomplete="postal-code" inputmode="numeric" maxlength="10"' })}
          </div>
          <button class="btn btn-primary btn-sm" type="submit">Save personal details</button>
        </form>
        ${
          user.kycStatus === 'verified'
            ? ui.notice('success', 'Your identity is verified. All account features are available.')
            : `<div class="card-split">
                <div>
                  <h4>Identity verification</h4>
                  <p class="muted">${ui.esc(user.kycNote || 'Verification is pending operations review. Deposits and transfers stay limited until your identity is confirmed.')}</p>
                </div>
                <form class="form-inline" data-identity novalidate>
                  ${ui.field({ label: 'Last 4 of SSN', name: 'ssnLast4', inputmode: 'numeric', maxlength: '4', placeholder: '1234', autocomplete: 'off' })}
                  <label class="field"><span class="field-label">Document type</span>
                    <select class="select" name="idType">${ID_TYPES.map((type) => `<option value="${type.id}">${ui.esc(type.label)}</option>`).join('')}</select>
                  </label>
                  <button class="btn btn-primary btn-sm" type="submit">Resubmit verification</button>
                </form>
              </div>`
        }
      </section>

      <section class="card">
        <div class="card-head"><h3>Sign-in security</h3></div>
        <form class="stack" data-password novalidate>
          <h4>Change password</h4>
          ${ui.field({ label: 'Current password', name: 'currentPassword', type: 'password', autocomplete: 'current-password' })}
          ${ui.field({ label: 'New password', name: 'newPassword', type: 'password', autocomplete: 'new-password', hint: 'At least 12 characters with upper, lower, number and symbol.' })}
          ${ui.field({ label: 'Confirm new password', name: 'confirmPassword', type: 'password', autocomplete: 'new-password' })}
          <button class="btn btn-primary btn-sm" type="submit">Update password</button>
        </form>

        <hr class="rule" />

        <div class="stack">
          <h4>Two-factor authentication ${user.twoFactorEnabled ? '<span class="chip chip-ok">On</span>' : '<span class="chip chip-warn">Off</span>'}</h4>
          <p class="muted">${user.twoFactorEnabled ? 'A 6-digit authenticator code is required at every sign-in.' : 'Protect your sign-in with an authenticator app such as Google Authenticator, 1Password or Authy.'}</p>
          <div data-2fa>${user.twoFactorEnabled
            ? `<form class="form-inline" data-2fa-disable novalidate>
                 ${ui.field({ label: 'Password', name: 'password', type: 'password', autocomplete: 'current-password' })}
                 <button class="btn btn-danger btn-sm" type="submit">Turn off 2FA</button>
               </form>`
            : '<button class="btn btn-quiet btn-sm" type="button" data-2fa-start>Set up authenticator</button>'}</div>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h3>Transaction PIN</h3>${user.pinSet ? '<span class="chip chip-ok">Set</span>' : '<span class="chip chip-warn">Not set</span>'}</div>
        <p class="muted">Your 4-digit PIN authorises transfers and withdrawals. It is stored as a salted hash and locks after repeated failures.</p>
        <form class="stack" data-pin novalidate>
          ${ui.field({ label: 'Account password', name: 'password', type: 'password', autocomplete: 'current-password' })}
          ${ui.field({ label: user.pinSet ? 'New 4-digit PIN' : 'Create 4-digit PIN', name: 'pin', type: 'password', inputmode: 'numeric', maxlength: '4', autocomplete: 'off' })}
          ${ui.field({ label: 'Confirm PIN', name: 'confirmPin', type: 'password', inputmode: 'numeric', maxlength: '4', autocomplete: 'off' })}
          <button class="btn btn-primary btn-sm" type="submit">${user.pinSet ? 'Change PIN' : 'Create PIN'}</button>
        </form>
      </section>

      <section class="card">
        <div class="card-head"><h3>Sessions &amp; alerts</h3></div>
        <label class="toggle-row">
          <span>
            <strong>Sign-in notifications</strong>
            <small>Email-style alerts appear in your notification centre whenever this account signs in.</small>
          </span>
          <input type="checkbox" data-login-notifications ${user.loginNotifications ? 'checked' : ''} />
        </label>
        <hr class="rule" />
        <div class="stack">
          <h4>Active sessions</h4>
          <p class="muted">Signing out everywhere ends all other devices. This browser stays signed in.</p>
          <button class="btn btn-quiet btn-sm" type="button" data-revoke-all>Sign out other devices</button>
        </div>
        <hr class="rule" />
        <div class="stack">
          <h4>Account</h4>
          <p class="muted">Signed in as ${ui.esc(user.email || '')}.</p>
          <button class="btn btn-danger btn-sm" type="button" data-signout>Sign out of this device</button>
        </div>
      </section>
    </div>

    <p class="fine-print">Northvale Financial is a financial technology company, not a bank. Banking services are provided by partner institutions once established; deposits are held in custodial accounts.</p>`;

  // Personal details (address, date of birth, phone)
  const profileForm = page.querySelector('[data-profile]');
  if (profileForm) {
    profileForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = ui.formValues(profileForm);
      ui.clearErrors(profileForm);
      const button = profileForm.querySelector('button[type="submit"]');
      ui.busy(button, true, 'Saving…');
      try {
        const res = await api.patch('/api/account/profile', {
          phone: values.phone,
          dob: values.dob,
          address: {
            line1: values.line1,
            line2: values.line2,
            city: values.city,
            state: values.state,
            postalCode: values.postalCode,
          },
        });
        ui.toast(res.message || 'Personal details saved.', 'success');
        await ctx.refresh();
        await renderSettings(page, ctx);
      } catch (error) {
        if (error instanceof ApiError && error.field) ui.setFieldError(profileForm, error.field, error.message);
        ui.toast(error instanceof ApiError ? error.message : 'Details could not be saved.', 'error');
        ui.busy(button, false);
      }
    });
  }

  // Identity resubmission
  const identityForm = page.querySelector('[data-identity]');
  if (identityForm) {
    identityForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = ui.formValues(identityForm);
      ui.clearErrors(identityForm);
      if (!/^\d{4}$/.test(values.ssnLast4 || '')) {
        ui.setFieldError(identityForm, 'ssnLast4', 'Enter the last 4 digits of your SSN.');
        return;
      }
      const button = identityForm.querySelector('button[type="submit"]');
      ui.busy(button, true, 'Submitting…');
      try {
        await api.post('/api/auth/identity/resubmit', values);
        ui.toast('Identity verification resubmitted for review.', 'success');
        await ctx.refresh();
      } catch (error) {
        ui.toast(error instanceof ApiError ? error.message : 'Submission failed.', 'error');
        ui.busy(button, false);
      }
    });
  }

  // Password
  const passwordForm = page.querySelector('[data-password]');
  passwordForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = ui.formValues(passwordForm);
    ui.clearErrors(passwordForm);
    const button = passwordForm.querySelector('button[type="submit"]');
    ui.busy(button, true, 'Updating…');
    try {
      const res = await api.post('/api/settings/password', {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
        confirmPassword: values.confirmPassword,
      });
      ui.toast(res.message || 'Password updated.', 'success');
      passwordForm.reset();
    } catch (error) {
      if (error instanceof ApiError && error.field) ui.setFieldError(passwordForm, error.field, error.message);
      ui.toast(error instanceof ApiError ? error.message : 'Password could not be updated.', 'error');
    } finally {
      ui.busy(button, false);
    }
  });

  // 2FA
  const twofaHost = page.querySelector('[data-2fa]');
  async function bindTwofaDisable() {
    const form = twofaHost.querySelector('[data-2fa-disable]');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      ui.busy(button, true, 'Turning off…');
      try {
        const res = await api.post('/api/settings/2fa/disable', ui.formValues(form));
        ui.toast(res.message || 'Two-factor authentication disabled.', 'success');
        await ctx.refresh();
        await renderSettings(page, ctx);
      } catch (error) {
        ui.toast(error instanceof ApiError ? error.message : 'Could not disable 2FA.', 'error');
        ui.busy(button, false);
      }
    });
  }
  await bindTwofaDisable();

  twofaHost.addEventListener('click', async (event) => {
    const start = event.target.closest('[data-2fa-start]');
    if (!start) return;
    ui.busy(start, true, 'Preparing…');
    try {
      const data = await api.post('/api/settings/2fa/start', {});
      twofaHost.innerHTML = `<div class="stack">
        <p class="muted">Add this key to your authenticator app, then enter the 6-digit code it shows.</p>
        <div class="secret-box"><code>${ui.esc(data.secretFormatted || data.secret)}</code>
          <button class="icon-btn" type="button" data-copy-secret aria-label="Copy key">${ui.icon('copy')}</button></div>
        <p class="fine-print">Issuer: Northvale Financial · Account: ${ui.esc(data.account || ctx.state.user.email || '')}</p>
        <form class="form-inline" data-2fa-enable novalidate>
          ${ui.field({ label: '6-digit code', name: 'code', inputmode: 'numeric', maxlength: '6', autocomplete: 'one-time-code', placeholder: '000000' })}
          <button class="btn btn-primary btn-sm" type="submit">Activate 2FA</button>
        </form>
      </div>`;
      const secret = data.secret;
      twofaHost.querySelector('[data-copy-secret]').addEventListener('click', async () => {
        await ui.copyText(secret);
        ui.toast('Setup key copied.', 'success');
      });
      const form = twofaHost.querySelector('[data-2fa-enable]');
      form.addEventListener('submit', async (submitEvent) => {
        submitEvent.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        ui.busy(button, true, 'Verifying…');
        try {
          const res = await api.post('/api/settings/2fa/enable', ui.formValues(form));
          ui.toast(res.message || 'Two-factor authentication enabled.', 'success');
          await ctx.refresh();
          await renderSettings(page, ctx);
        } catch (error) {
          ui.toast(error instanceof ApiError ? error.message : 'That code did not match.', 'error');
          ui.busy(button, false);
        }
      });
      form.querySelector('input')?.focus();
    } catch (error) {
      ui.toast(error instanceof ApiError ? error.message : 'Could not start 2FA setup.', 'error');
      ui.busy(start, false);
    }
  });

  // PIN
  const pinForm = page.querySelector('[data-pin]');
  pinForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = ui.formValues(pinForm);
    ui.clearErrors(pinForm);
    if (!/^\d{4}$/.test(values.pin || '')) {
      ui.setFieldError(pinForm, 'pin', 'Your PIN must be exactly 4 digits.');
      return;
    }
    if (values.pin !== values.confirmPin) {
      ui.setFieldError(pinForm, 'confirmPin', 'PINs do not match.');
      return;
    }
    const button = pinForm.querySelector('button[type="submit"]');
    ui.busy(button, true, 'Saving…');
    try {
      const res = await api.post('/api/settings/pin', { password: values.password, pin: values.pin });
      ui.toast(res.message || 'Transaction PIN saved.', 'success');
      pinForm.reset();
      await ctx.refresh();
    } catch (error) {
      if (error instanceof ApiError && error.field) ui.setFieldError(pinForm, error.field, error.message);
      ui.toast(error instanceof ApiError ? error.message : 'PIN could not be saved.', 'error');
    } finally {
      ui.busy(button, false);
    }
  });

  // Login notifications
  const toggle = page.querySelector('[data-login-notifications]');
  toggle.addEventListener('change', async () => {
    toggle.disabled = true;
    try {
      await api.post('/api/settings/preferences', { loginNotifications: toggle.checked });
      ui.toast(`Sign-in notifications ${toggle.checked ? 'enabled' : 'disabled'}.`, 'success');
      await ctx.refresh();
    } catch (error) {
      toggle.checked = !toggle.checked;
      ui.toast(error instanceof ApiError ? error.message : 'Preference could not be saved.', 'error');
    } finally {
      toggle.disabled = false;
    }
  });

  page.querySelector('[data-revoke-all]').addEventListener('click', (event) => {
    const button = event.currentTarget;
    ui.openModal({
      title: 'Sign out other devices?',
      body: '<p class="modal-text">Every other browser and device signed in to this account will be signed out immediately.</p>',
      foot: `<button class="btn btn-quiet" type="button" data-close>Cancel</button>
             <button class="btn btn-primary" type="button" data-confirm>Sign out others</button>`,
      onMount(modal) {
        modal.querySelector('[data-close]').addEventListener('click', ui.closeModal);
        modal.querySelector('[data-confirm]').addEventListener('click', async () => {
          ui.busy(button, true, 'Signing out…');
          try {
            const res = await api.post('/api/settings/sessions/revoke-all', {});
            ui.closeModal();
            ui.toast(res.message || 'Other sessions signed out.', 'success');
          } catch (error) {
            ui.toast(error instanceof ApiError ? error.message : 'Sessions could not be revoked.', 'error');
          } finally {
            ui.busy(button, false);
          }
        });
      },
    });
  });

  page.querySelector('[data-signout]').addEventListener('click', () => ctx.signOut());
}

export async function renderNotifications(page, ctx) {
  ctx.setTitle('Notifications', 'Account alerts');
  const items = ctx.state.notifications || [];

  page.innerHTML = `<div class="section-head">
      <div><h2>Notifications</h2><p>Security alerts, transfer updates and account notices.</p></div>
      <button class="btn btn-quiet btn-sm" type="button" data-read-all ${items.some((n) => !n.read) ? '' : 'disabled'}>Mark all as read</button>
    </div>
    <div class="card flush" data-list>${renderItems(items)}</div>`;

  const list = page.querySelector('[data-list]');
  const readAll = page.querySelector('[data-read-all]');

  async function markRead(id) {
    try {
      await api.post(`/api/account/notifications/${encodeURIComponent(id)}/read`, {});
      const item = (ctx.state.notifications || []).find((n) => n.id === id);
      if (item) item.read = true;
      list.innerHTML = renderItems(ctx.state.notifications || []);
      readAll.disabled = !(ctx.state.notifications || []).some((n) => !n.read);
      ctx.refreshNotifications?.();
    } catch (error) {
      ui.toast(error instanceof ApiError ? error.message : 'Could not update notification.', 'error');
    }
  }

  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-read]');
    if (!button) return;
    markRead(button.dataset.read);
  });

  readAll.addEventListener('click', async () => {
    ui.busy(readAll, true, 'Updating…');
    try {
      await api.post('/api/account/notifications/read-all', {});
      (ctx.state.notifications || []).forEach((n) => {
        n.read = true;
      });
      list.innerHTML = renderItems(ctx.state.notifications || []);
      readAll.disabled = true;
      await ctx.refresh();
    } catch (error) {
      ui.toast(error instanceof ApiError ? error.message : 'Could not update notifications.', 'error');
    } finally {
      ui.busy(readAll, false);
    }
  });
}

function renderItems(items) {
  if (!items.length) {
    return ui.emptyState({
      title: 'No notifications yet',
      body: 'Account activity, security alerts and transfer updates will appear here.',
      iconName: 'bell',
    });
  }
  return `<ul class="notif-list">${items
    .map(
      (item) => `<li class="notif-item ${item.read ? '' : 'is-unread'}">
        <span class="notif-icon notif-${ui.esc(item.kind || 'info')}">${ui.icon(item.kind === 'security' ? 'shield' : item.kind === 'transaction' ? 'swap' : 'bell')}</span>
        <div class="notif-body">
          <div class="notif-top"><strong>${ui.esc(item.title)}</strong><span class="muted">${ui.esc(ui.timeAgo(item.createdAt))}</span></div>
          <p>${ui.esc(item.body)}</p>
        </div>
        ${item.read ? '' : `<button class="icon-btn" type="button" data-read="${ui.esc(item.id)}" title="Mark as read" aria-label="Mark as read">${ui.icon('check')}</button>`}
      </li>`,
    )
    .join('')}</ul>`;
}
