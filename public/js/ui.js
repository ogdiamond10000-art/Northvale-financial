/** Shared UI helpers: formatting, icons, toasts, modals and small components. */

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function fmtUSD(cents) {
  const value = Number(cents || 0) / 100;
  return usd.format(value);
}

/** Split "$1,240.50" into whole and cents for display. */
export function splitUSD(cents) {
  const [whole, decimals] = fmtUSD(cents).split('.');
  return { whole, cents: decimals ? `.${decimals}` : '' };
}

export function fmtDate(iso, opts = {}) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: opts.year === false ? undefined : 'numeric',
    hour: opts.time === false ? undefined : 'numeric',
    minute: opts.time === false ? undefined : '2-digit',
  });
}

export function fmtDay(iso) {
  return fmtDate(iso, { time: false });
}

export function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (!then) return '';
  const diff = Math.max(0, Date.now() - then);
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return fmtDay(iso);
}

export function initials(first, last) {
  return `${(first || '').charAt(0)}${(last || '').charAt(0)}`.toUpperCase() || 'NF';
}

export function maskAccount(number) {
  const digits = String(number || '').replace(/\D/g, '');
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : '••••';
}

export function groupAccountNumber(number) {
  return String(number || '').replace(/(\d{3})(?=\d)/g, '$1 ').trim();
}

export function titleCase(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/* ------------------------------- icons ------------------------------- */

const ICONS = {
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/>',
  receive: '<path d="M12 3v13"/><path d="m6 11 6 6 6-6"/><path d="M4 21h16"/>',
  withdraw: '<path d="M12 21V8"/><path d="m6 13 6-6 6 6"/><path d="M4 3h16"/>',
  transfer: '<path d="M4 7h13"/><path d="m13 3 4 4-4 4"/><path d="M20 17H7"/><path d="m11 13-4 4 4 4"/>',
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
  shield: '<path d="M12 3 5 6v6c0 4.5 3 8 7 9 4-1 7-4.5 7-9V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 6-3 7-3 7h18s-3-1-3-7"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  check: '<path d="m5 13 4 4L19 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 9v5"/><circle cx="12" cy="17" r=".6"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20"/>',
  bank: '<path d="m3 10 9-6 9 6"/><path d="M5 10v9M19 10v9M9 19v-6h6v6"/><path d="M2 21h20"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  logout: '<path d="M15 17l5-5-5-5"/><path d="M20 12H9"/><path d="M13 3H5a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h8"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5H6a2 2 0 0 0-2 2v9"/>',
  fingerprint: '<path d="M12 3a9 9 0 0 0-9 9v3"/><path d="M12 7a5 5 0 0 1 5 5v2"/><path d="M7 12a5 5 0 0 1 10 0v5"/><path d="M12 12v6"/><path d="M17 19a9 9 0 0 0 2-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.3 3.1-5 7-5s7 1.7 7 5"/><path d="M17 11a3 3 0 1 0 0-6"/><path d="M18 20c0-2.2-.8-3.6-2-4.4"/>',
  flag: '<path d="M5 21V4h9l-1 4h7l-2 5 2 5H5"/>',
  scale: '<path d="M12 3v18"/><path d="M5 7h14"/><path d="m5 7-3 7h6L5 7Z"/><path d="m19 7-3 7h6l-3-7Z"/>',
  file: '<path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4Z"/><path d="M14 3v4h4"/><path d="M9 13h6M9 17h4"/>',
  trend: '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
};

export function icon(name, cls = '') {
  const body = ICONS[name] || ICONS.grid;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">${body}</svg>`;
}

/* ------------------------------ components ------------------------------ */

export function statusBadge(status) {
  const map = { completed: 'success', pending: 'pending', failed: 'failed', cancelled: 'cancelled' };
  return `<span class="badge ${map[status] || 'info'}">${esc(titleCase(status))}</span>`;
}

export function kycBadge(status) {
  const map = { verified: 'success', pending: 'pending', unverified: 'info', rejected: 'failed' };
  return `<span class="badge ${map[status] || 'info'}">${esc(titleCase(status))}</span>`;
}

export function txIconName(tx) {
  if (tx.type === 'deposit') return 'receive';
  if (tx.type === 'withdrawal') return 'withdraw';
  if (tx.direction === 'credit') return 'receive';
  return 'send';
}

export function txTitle(tx) {
  if (tx.type === 'deposit') return tx.description || 'Deposit';
  if (tx.type === 'withdrawal') return `Withdrawal · ${tx.counterparty?.bank || titleCase(tx.method || '')}`;
  return `Transfer to ${tx.counterparty?.name || tx.description || 'recipient'}`;
}

export function txRow(tx, { href = true } = {}) {
  const dir = tx.direction === 'credit' ? 'credit' : 'debit';
  const sign = dir === 'credit' ? '+' : '−';
  const inner = `
    <span class="tx-icon ${dir}">${icon(txIconName(tx))}</span>
    <span class="tx-main">
      <span class="tx-title">${esc(txTitle(tx))}</span>
      <span class="tx-sub">${esc(fmtDate(tx.createdAt))} · ${esc(tx.reference)}</span>
    </span>
    <span class="tx-amt ${dir}">${sign}${esc(tx.amount)}</span>
    ${statusBadge(tx.status)}`;
  if (!href) return `<div class="tx-row">${inner}</div>`;
  return `<a class="tx-row" href="#/transactions/${esc(tx.id)}">${inner}</a>`;
}

export function emptyState({ title, body, iconName = 'list', action = '' }) {
  return `<div class="empty">${icon(iconName)}<strong>${esc(title)}</strong><span>${esc(body)}</span>${action}</div>`;
}

export function sectionHead(title, sub, actions = '') {
  return `<div class="section-head"><div><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div><div class="spacer"></div>${actions}</div>`;
}

export function notice(kind, text, { strong = '' } = {}) {
  const iconName = kind === 'danger' || kind === 'warn' ? 'alert' : kind === 'success' ? 'check' : 'shield';
  return `<div class="notice ${kind}">${icon(iconName)}<div>${strong ? `<strong>${esc(strong)}</strong> ` : ''}${esc(text)}</div></div>`;
}

export function field({ label, name, type = 'text', value = '', placeholder = '', hint = '', required = false, attrs = '', error = '' }) {
  return `<div class="field" data-field="${esc(name)}">
    <label for="f-${esc(name)}">${esc(label)}${required ? '' : ' <span style="color:var(--silver-400);font-weight:500">(optional)</span>'}</label>
    <input class="input" id="f-${esc(name)}" name="${esc(name)}" type="${esc(type)}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${required ? 'required' : ''} ${attrs} autocomplete="off" />
    ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}
    <span class="error" data-error="${esc(name)}" ${error ? '' : 'hidden'}>${esc(error)}</span>
  </div>`;
}

/* -------------------------------- toasts -------------------------------- */

function toastRoot() {
  let root = document.querySelector('.toast-root');
  if (!root) {
    root = document.createElement('div');
    root.className = 'toast-root';
    document.body.append(root);
  }
  return root;
}

export function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : type === 'success' ? 'success' : ''}`;
  el.innerHTML = `${icon(type === 'error' ? 'alert' : type === 'success' ? 'check' : 'shield')}<span>${esc(message)}</span>`;
  toastRoot().append(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(-6px)';
    el.style.transition = 'opacity .25s, transform .25s';
    setTimeout(() => el.remove(), 260);
  }, 4600);
}

/* -------------------------------- modal -------------------------------- */

let activeModal = null;

export function closeModal() {
  if (!activeModal) return;
  const { backdrop, onKey } = activeModal;
  activeModal = null;
  document.removeEventListener('keydown', onKey);
  backdrop.style.opacity = '0';
  setTimeout(() => backdrop.remove(), 150);
}

export function openModal({ title, body, foot = '', wide = false, onMount }) {
  closeModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="modal-body">${body}</div>
      ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
    </div>`;
  document.body.append(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('is-open'));
  const onKey = (event) => {
    if (event.key === 'Escape') closeModal();
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop || event.target.closest('[data-close]')) closeModal();
  });
  activeModal = { backdrop, onKey };
  if (onMount) onMount(backdrop.querySelector('.modal'));
  return backdrop.querySelector('.modal');
}

/* -------------------------------- forms -------------------------------- */

export function formValues(form) {
  const data = {};
  for (const [key, value] of new FormData(form).entries()) {
    data[key] = typeof value === 'string' ? value.trim() : value;
  }
  return data;
}

export function setFieldError(form, name, message) {
  const holder = form.querySelector(`[data-error="${name}"]`);
  if (!holder) return;
  holder.textContent = message || '';
  holder.hidden = !message;
  const input = form.querySelector(`[name="${name}"]`);
  if (input) input.classList.toggle('is-invalid', Boolean(message));
}

export function clearErrors(form) {
  form.querySelectorAll('[data-error]').forEach((el) => {
    el.textContent = '';
    el.hidden = true;
  });
  form.querySelectorAll('.is-invalid').forEach((el) => el.classList.remove('is-invalid'));
}

export function busy(button, isBusy, label) {
  if (!button) return;
  if (isBusy) {
    button.dataset.label = button.innerHTML;
    button.disabled = true;
    button.classList.add('btn-loading');
    button.innerHTML = label || 'Working…';
  } else {
    button.disabled = false;
    button.classList.remove('btn-loading');
    if (button.dataset.label) button.innerHTML = button.dataset.label;
  }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard', 'success');
  } catch {
    toast('Copy is unavailable in this browser.', 'error');
  }
}

export function accountTypeLabel(type) {
  return { checking: 'Northvale Checking', savings: 'Northvale Savings', money_market: 'Northvale Money Market' }[type] || titleCase(type);
}
