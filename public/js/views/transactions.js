import { api, ApiError } from '../api.js';
import * as ui from '../ui.js';

const STATUS_TABS = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'completed', label: 'Successful' },
  { id: 'failed', label: 'Failed' },
  { id: 'cancelled', label: 'Cancelled' },
];

const TYPES = [
  { id: '', label: 'All types' },
  { id: 'deposit', label: 'Deposits' },
  { id: 'transfer', label: 'Transfers' },
  { id: 'withdrawal', label: 'Withdrawals' },
];

const PAGE_SIZE = 12;

export async function renderTransactions(page, ctx, route = {}) {
  ctx.setTitle('Transactions', 'Account activity');
  const params = route.query || new URLSearchParams();
  const state = {
    status: params.get('status') || 'all',
    type: params.get('type') || '',
    q: params.get('q') || '',
    offset: 0,
    items: [],
    total: 0,
    loading: false,
  };

  page.innerHTML = `<div class="section-head">
      <div><h2>Transactions</h2><p>Every debit and credit on your Northvale account, with reference numbers and receipts.</p></div>
      <a class="btn btn-primary btn-sm" href="#/transfer">${ui.icon('send')} New transfer</a>
    </div>
    <div class="card flush">
      <div class="filter-bar">
        <div class="tabs" role="tablist">
          ${STATUS_TABS.map((tab) => `<button class="tab ${state.status === tab.id ? 'is-active' : ''}" role="tab" type="button" data-status="${tab.id}">${ui.esc(tab.label)}</button>`).join('')}
        </div>
        <div class="filter-controls">
          <div class="search-inline">${ui.icon('search')}
            <input class="input" type="search" placeholder="Search reference, recipient or description" value="${ui.esc(state.q)}" aria-label="Search transactions" />
          </div>
          <select class="select" aria-label="Filter by type">
            ${TYPES.map((type) => `<option value="${type.id}" ${state.type === type.id ? 'selected' : ''}>${ui.esc(type.label)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="tx-list"><div class="skeleton" style="height:260px;margin:18px"></div></div>
      <div class="table-foot">
        <span class="muted" data-count></span>
        <div class="row" style="gap:8px">
          <button class="btn btn-quiet btn-sm" type="button" data-prev disabled>Previous</button>
          <button class="btn btn-quiet btn-sm" type="button" data-next disabled>Next</button>
        </div>
      </div>
    </div>`;

  const list = page.querySelector('#tx-list');
  const countEl = page.querySelector('[data-count]');
  const prev = page.querySelector('[data-prev]');
  const next = page.querySelector('[data-next]');
  const searchInput = page.querySelector('input[type="search"]');
  const typeSelect = page.querySelector('select');
  let searchTimer = null;

  page.querySelectorAll('[data-status]').forEach((button) =>
    button.addEventListener('click', () => {
      state.status = button.dataset.status;
      state.offset = 0;
      page.querySelectorAll('[data-status]').forEach((el) => el.classList.toggle('is-active', el === button));
      load();
    }),
  );

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = searchInput.value.trim();
      state.offset = 0;
      load();
    }, 220);
  });

  typeSelect.addEventListener('change', () => {
    state.type = typeSelect.value;
    state.offset = 0;
    load();
  });

  prev.addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - PAGE_SIZE);
    load();
  });
  next.addEventListener('click', () => {
    state.offset += PAGE_SIZE;
    load();
  });

  async function load() {
    state.loading = true;
    list.innerHTML = '<div class="skeleton" style="height:260px;margin:18px"></div>';
    try {
      const query = new URLSearchParams({
        status: state.status,
        limit: String(PAGE_SIZE),
        offset: String(state.offset),
      });
      if (state.q) query.set('q', state.q);
      if (state.type) query.set('type', state.type);
      const data = await api.get(`/api/account/transactions?${query.toString()}`);
      state.items = data.transactions || [];
      state.total = data.total || 0;
      renderList();
    } catch (error) {
      list.innerHTML = `<div style="padding:18px">${ui.notice('danger', error instanceof ApiError ? error.message : 'Transactions could not be loaded.')}</div>`;
    } finally {
      state.loading = false;
    }
  }

  function renderList() {
    if (!state.items.length) {
      list.innerHTML = ui.emptyState({
        title: 'No transactions found',
        body: state.q || state.type || state.status !== 'all'
          ? 'Try a different search term or clear the filters.'
          : 'Your account activity will appear here after your first deposit or transfer.',
        iconName: 'list',
        action: '<a class="btn btn-primary btn-sm" href="#/deposit">Add funds</a>',
      });
    } else {
      list.innerHTML = `<div class="tx-table" role="table">
        <div class="tx-head" role="row">
          <span>Transaction</span><span>Reference</span><span>Date</span><span class="ta-right">Amount</span><span>Status</span><span></span>
        </div>
        ${state.items
          .map(
            (tx) => `<div class="tx-line" role="row" data-href="#/transactions/${ui.esc(tx.id)}" tabindex="0">
              <span class="tx-main">
                <span class="tx-avatar">${ui.icon(ui.txIconName(tx))}</span>
                <span class="tx-main-text">
                  <strong>${ui.esc(ui.txTitle(tx))}</strong>
                  <span>${ui.esc(tx.description || ui.titleCase(tx.type))}</span>
                </span>
              </span>
              <span class="tabular ref">${ui.esc(tx.reference)}</span>
              <span class="tabular">${ui.esc(ui.fmtDate(tx.createdAt))}</span>
              <span class="tabular ta-right ${tx.direction === 'credit' ? 'amt-in' : 'amt-out'}">${tx.direction === 'credit' ? '+' : '−'}${ui.esc(tx.amount)}</span>
              <span>${ui.statusBadge(tx.status)}</span>
              <span class="ta-right"><a class="icon-btn" href="/api/account/transactions/${ui.esc(tx.id)}/receipt" download aria-label="Download receipt" title="Download receipt">${ui.icon('download')}</a></span>
            </div>`,
          )
          .join('')}
      </div>`;
      list.querySelectorAll('[data-href]').forEach((row) => {
        row.addEventListener('click', (event) => {
          if (event.target.closest('a')) return;
          window.location.hash = row.dataset.href;
        });
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') window.location.hash = row.dataset.href;
        });
      });
    }
    const from = state.total === 0 ? 0 : state.offset + 1;
    const to = Math.min(state.offset + PAGE_SIZE, state.total);
    countEl.textContent = `Showing ${from}–${to} of ${state.total} transaction${state.total === 1 ? '' : 's'}`;
    prev.disabled = state.offset === 0;
    next.disabled = state.offset + PAGE_SIZE >= state.total;
  }

  await load();
}

export async function renderTransactionDetail(page, ctx, route = {}) {
  const id = route.params?.id;
  ctx.setTitle('Transaction', 'Receipt & details');

  page.innerHTML = `<a class="back-link" href="#/transactions">${ui.icon('chevron')} Back to transactions</a>
    <div id="detail"><div class="skeleton" style="height:320px"></div></div>`;
  const host = page.querySelector('#detail');

  let tx;
  try {
    const data = await api.get(`/api/account/transactions/${encodeURIComponent(id)}`);
    tx = data.transaction;
  } catch (error) {
    host.innerHTML = ui.notice('danger', error instanceof ApiError ? error.message : 'Transaction not found.');
    return;
  }

  const cp = tx.counterparty || {};
  const canCancel = tx.status === 'pending' && tx.type === 'transfer';
  host.innerHTML = `<div class="card receipt-card">
    <div class="receipt-top">
      <div>
        <span class="eyebrow">Transaction detail</span>
        <h2 class="tabular">${tx.direction === 'credit' ? '+' : '−'}${ui.esc(tx.amount)}</h2>
        <div class="row" style="gap:10px;margin-top:10px">${ui.statusBadge(tx.status)}<span class="chip">${ui.esc(ui.titleCase(tx.type))}</span></div>
      </div>
      <span class="receipt-mark">${ui.icon(ui.txIconName(tx))}</span>
    </div>

    <div class="detail-grid" style="margin-top:24px">
      <div><span>Reference</span><strong class="tabular">${ui.esc(tx.reference)}</strong></div>
      <div><span>Date &amp; time</span><strong>${ui.esc(ui.fmtDate(tx.createdAt, { timeStyle: 'short' }))}</strong></div>
      <div><span>Amount</span><strong class="tabular">${ui.esc(tx.amount)}</strong></div>
      <div><span>Fee</span><strong class="tabular">${ui.esc(tx.fee || ui.fmtUSD(0))}</strong></div>
      <div><span>Channel</span><strong>${ui.esc(ui.titleCase(tx.channel || 'internal'))}</strong></div>
      <div><span>Method</span><strong>${ui.esc(tx.method ? ui.titleCase(String(tx.method).replace('_', ' ')) : '—')}</strong></div>
      <div><span>Recipient</span><strong>${ui.esc(cp.name || 'Northvale Financial')}</strong></div>
      <div><span>Institution</span><strong>${ui.esc(cp.bankName || 'Northvale Financial')}</strong></div>
      <div><span>Account</span><strong class="tabular">${ui.esc(cp.accountNumberMasked || '—')}</strong></div>
      <div><span>Description</span><strong>${ui.esc(tx.description || '—')}</strong></div>
      <div><span>Posted</span><strong>${ui.esc(tx.settledAt ? ui.fmtDate(tx.settledAt, { timeStyle: 'short' }) : 'Not yet posted')}</strong></div>
      <div><span>Balance after</span><strong class="tabular">${ui.esc(tx.balanceAfter || '—')}</strong></div>
    </div>

    ${tx.failureReason ? ui.notice('danger', tx.failureReason, { strong: 'Failure reason.' }) : ''}

    <div class="row" style="margin-top:24px;flex-wrap:wrap">
      <a class="btn btn-primary" href="/api/account/transactions/${ui.esc(tx.id)}/receipt" download>${ui.icon('download')} Download receipt</a>
      <button class="btn btn-quiet" type="button" data-copy>${ui.icon('copy')} Copy reference</button>
      ${canCancel ? '<button class="btn btn-danger" type="button" data-cancel>Cancel transfer</button>' : ''}
    </div>
    <p class="fine-print" style="margin-top:16px">Receipts are generated from the account ledger. Northvale Financial is a financial technology service, not a bank.</p>
  </div>`;

  host.querySelector('[data-copy]').addEventListener('click', async () => {
    await ui.copyText(tx.reference);
    ui.toast('Reference copied.', 'success');
  });

  const cancel = host.querySelector('[data-cancel]');
  if (cancel) {
    cancel.addEventListener('click', async () => {
      ui.openModal({
        title: 'Cancel this transfer?',
        body: `<p class="modal-text">The held amount of <strong>${ui.esc(tx.amount)}</strong> returns to your available balance immediately. This cannot be undone.</p>`,
        foot: `<button class="btn btn-quiet" type="button" data-close>Keep transfer</button>
               <button class="btn btn-danger" type="button" data-confirm>Cancel transfer</button>`,
        onMount(modal) {
          modal.querySelector('[data-close]').addEventListener('click', ui.closeModal);
          modal.querySelector('[data-confirm]').addEventListener('click', async (event) => {
            ui.busy(event.currentTarget, true, 'Cancelling…');
            try {
              await api.post(`/api/transfers/${encodeURIComponent(tx.id)}/cancel`);
              ui.closeModal();
              ui.toast('Transfer cancelled and funds released.', 'success');
              await ctx.refresh();
              window.location.hash = '#/transactions';
            } catch (error) {
              ui.toast(error instanceof ApiError ? error.message : 'The transfer could not be cancelled.', 'error');
              ui.busy(event.currentTarget, false);
            }
          });
        },
      });
    });
  }
}
