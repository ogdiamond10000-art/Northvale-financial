import { api, ApiError } from '../api.js';
import * as ui from '../ui.js';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'customers', label: 'Customers' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'alerts', label: 'Fraud alerts' },
  { id: 'reconciliation', label: 'Reconciliation' },
  { id: 'audit', label: 'Audit logs' },
];

export async function renderAdmin(page, ctx, route = {}) {
  ctx.setTitle('Operations console', 'Administration');
  if (ctx.state.user?.role !== 'admin') {
    page.innerHTML = ui.emptyState({
      title: 'Administrator access required',
      body: 'This console is limited to Northvale operations staff.',
      iconName: 'shield',
      action: '<a class="btn btn-primary btn-sm" href="#/dashboard">Back to dashboard</a>',
    });
    return;
  }

  let tab = route.query?.get('tab') || 'overview';
  if (!TABS.some((item) => item.id === tab)) tab = 'overview';

  page.innerHTML = `<div class="section-head">
      <div><h2>Operations console</h2><p>Customer verification, transaction monitoring, fraud review and reconciliation.</p></div>
      <span class="chip chip-lg">Signed in as ${ui.esc(ctx.state.user.email)}</span>
    </div>
    <div class="tabs tabs-bar" role="tablist">
      ${TABS.map((item) => `<button class="tab ${tab === item.id ? 'is-active' : ''}" type="button" role="tab" data-tab="${item.id}">${ui.esc(item.label)}</button>`).join('')}
    </div>
    <div id="admin-body"><div class="skeleton" style="height:340px"></div></div>`;

  const body = page.querySelector('#admin-body');
  const loaded = {};

  page.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      tab = button.dataset.tab;
      page.querySelectorAll('[data-tab]').forEach((el) => el.classList.toggle('is-active', el === button));
      load();
    });
  });

  async function load(force = false) {
    body.innerHTML = '<div class="skeleton" style="height:340px"></div>';
    try {
      if (tab === 'overview' && (force || !loaded.overview)) loaded.overview = await api.get('/api/admin/overview');
      if (tab === 'customers' && (force || !loaded.customers)) loaded.customers = await api.get('/api/admin/customers');
      if (tab === 'transactions' && (force || !loaded.transactions)) loaded.transactions = await api.get('/api/admin/transactions');
      if (tab === 'alerts' && (force || !loaded.alerts)) loaded.alerts = await api.get('/api/admin/alerts?status=open');
      if (tab === 'reconciliation' && (force || !loaded.reconciliation)) loaded.reconciliation = await api.get('/api/admin/reconciliation');
      if (tab === 'audit' && (force || !loaded.audit)) loaded.audit = await api.get('/api/admin/audit-logs');
      render();
    } catch (error) {
      body.innerHTML = ui.notice('danger', error instanceof ApiError ? error.message : 'Console data could not be loaded.');
    }
  }

  async function reload() {
    loaded[tab] = null;
    await load(true);
  }

  function render() {
    if (tab === 'overview') renderOverview(loaded.overview || {});
    if (tab === 'customers') renderCustomers(loaded.customers || { customers: [] });
    if (tab === 'transactions') renderTransactions(loaded.transactions || { transactions: [] });
    if (tab === 'alerts') renderAlerts(loaded.alerts || { alerts: [] });
    if (tab === 'reconciliation') renderReconciliation(loaded.reconciliation || {});
    if (tab === 'audit') renderAudit(loaded.audit || { logs: [] });
  }

  function renderOverview(data) {
    const totals = data.totals || {};
    const stats = [
      { label: 'Customers', value: totals.customers ?? 0, tone: 'navy' },
      { label: 'Pending verification', value: totals.pendingKyc ?? 0, tone: 'warn' },
      { label: 'Pending transactions', value: totals.pendingTx ?? 0, tone: 'warn' },
      { label: 'Open fraud alerts', value: totals.openAlerts ?? 0, tone: 'danger' },
      { label: 'Deposits held', value: totals.depositsHeldFormatted || ui.fmtUSD(0), tone: 'ok' },
      { label: 'Pending outflows', value: totals.pendingOutFormatted || ui.fmtUSD(0), tone: 'navy' },
    ];
    body.innerHTML = `<div class="stat-grid">${stats
      .map(
        (stat) => `<div class="stat-card tone-${stat.tone}">
          <span>${ui.esc(stat.label)}</span>
          <strong class="tabular">${ui.esc(String(stat.value))}</strong>
        </div>`,
      )
      .join('')}</div>
      <div class="card flush" style="margin-top:22px">
        <div class="card-head pad"><h3>Latest activity</h3><button class="btn btn-quiet btn-sm" type="button" data-refresh>Refresh</button></div>
        ${adminTxTable(data.recent || [], { showCustomer: true })}
      </div>`;
    body.querySelector('[data-refresh]').addEventListener('click', () => reload());
    bindTxActions(body, reload);
  }

  function renderCustomers(data) {
    const customers = data.customers || [];
    body.innerHTML = `<div class="card flush">
      <div class="filter-bar">
        <div class="search-inline">${ui.icon('search')}
          <input class="input" type="search" placeholder="Search name, email, phone or account number" data-cust-search aria-label="Search customers" />
        </div>
        <div class="filter-controls">
          <select class="select" data-cust-status aria-label="Filter by status">
            <option value="all">All statuses</option><option value="active">Active</option><option value="frozen">Frozen</option><option value="closed">Closed</option>
          </select>
          <select class="select" data-cust-kyc aria-label="Filter by verification">
            <option value="all">All verification</option><option value="pending">Pending</option><option value="verified">Verified</option><option value="rejected">Rejected</option><option value="unverified">Unverified</option>
          </select>
        </div>
      </div>
      <div data-cust-list>${customerTable(customers)}</div>
    </div>`;

    const list = body.querySelector('[data-cust-list]');
    const search = body.querySelector('[data-cust-search]');
    const status = body.querySelector('[data-cust-status]');
    const kyc = body.querySelector('[data-cust-kyc]');
    let timer = null;

    async function refetch() {
      const query = new URLSearchParams({ status: status.value, kyc: kyc.value });
      if (search.value.trim()) query.set('q', search.value.trim());
      try {
        const fresh = await api.get(`/api/admin/customers?${query.toString()}`);
        loaded.customers = fresh;
        list.innerHTML = customerTable(fresh.customers || []);
        bindCustomerRows(list);
      } catch (error) {
        ui.toast(error instanceof ApiError ? error.message : 'Search failed.', 'error');
      }
    }

    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(refetch, 250);
    });
    status.addEventListener('change', refetch);
    kyc.addEventListener('change', refetch);
    bindCustomerRows(list);
  }

  function customerTable(customers) {
    if (!customers.length) return ui.emptyState({ title: 'No customers match', body: 'Adjust the search or filters.', iconName: 'users' });
    return `<div class="tx-table admin-table">
      <div class="tx-head"><span>Customer</span><span>Account</span><span>Balance</span><span>Verification</span><span>Status</span><span></span></div>
      ${customers
        .map(
          (customer) => `<div class="tx-line" data-customer="${ui.esc(customer.id)}" tabindex="0">
            <span class="tx-main">
              <span class="tx-avatar">${ui.esc(ui.initials(...String(customer.name || ' ').split(' ')))}</span>
              <span class="tx-main-text"><strong>${ui.esc(customer.name)}</strong><span>${ui.esc(customer.email)}</span></span>
            </span>
            <span class="tabular">${ui.esc(customer.accountNumber || '—')}<br /><small class="muted">${ui.esc(ui.accountTypeLabel(customer.accountType))}</small></span>
            <span class="tabular">${ui.esc(customer.balance || ui.fmtUSD(0))}</span>
            <span>${ui.kycBadge(customer.kycStatus)}</span>
            <span><span class="badge ${customer.status === 'active' ? 'success' : customer.status === 'frozen' ? 'pending' : 'failed'}">${ui.esc(ui.titleCase(customer.status))}</span></span>
            <span class="ta-right"><button class="btn btn-quiet btn-sm" type="button" data-open="${ui.esc(customer.id)}">Review</button></span>
          </div>`,
        )
        .join('')}
    </div>`;
  }

  function bindCustomerRows(host) {
    host.querySelectorAll('[data-customer]').forEach((row) => {
      const open = () => openCustomer(row.dataset.customer);
      row.addEventListener('click', open);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') open();
      });
    });
  }

  async function openCustomer(id) {
    ui.openModal({
      title: 'Customer record',
      wide: true,
      body: '<div class="skeleton" style="height:280px"></div>',
      onMount: async (modal) => {
        const host = modal.querySelector('.modal-body');
        let record;
        try {
          record = await api.get(`/api/admin/customers/${encodeURIComponent(id)}`);
        } catch (error) {
          host.innerHTML = ui.notice('danger', error instanceof ApiError ? error.message : 'Customer could not be loaded.');
          return;
        }
        const customer = record.customer || {};
        const address = customer.address || {};
        host.innerHTML = `<div class="admin-detail">
          <div class="row" style="justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap">
            <div>
              <h3 style="margin:0">${ui.esc(customer.name || '')}</h3>
              <p class="muted" style="margin:4px 0 0">${ui.esc(customer.email || '')} · ${ui.esc(customer.phone || '')}</p>
            </div>
            <div class="row" style="gap:8px">${ui.kycBadge(customer.kycStatus)}<span class="chip">${ui.esc(ui.titleCase(customer.status || 'active'))}</span></div>
          </div>

          <dl class="kv" style="margin-top:16px">
            <div><dt>Account</dt><dd class="tabular">${ui.esc(customer.accountNumber || '—')} · ${ui.esc(ui.accountTypeLabel(customer.accountType))}</dd></div>
            <div><dt>Balance</dt><dd class="tabular">${ui.esc(customer.balance || ui.fmtUSD(0))}</dd></div>
            <div><dt>Address</dt><dd>${ui.esc([address.line1, address.city, address.state, address.postalCode].filter(Boolean).join(', ') || '—')}</dd></div>
            <div><dt>Date of birth</dt><dd class="tabular">${ui.esc(ui.fmtDate(customer.dob))}</dd></div>
            <div><dt>Joined</dt><dd>${ui.esc(ui.fmtDate(customer.createdAt))}</dd></div>
            <div><dt>Last sign-in</dt><dd>${ui.esc(customer.lastLoginAt ? ui.fmtDate(customer.lastLoginAt, { timeStyle: 'short' }) : 'Never')}</dd></div>
          </dl>

          <div class="admin-actions">
            <button class="btn btn-primary btn-sm" type="button" data-kyc="verified">Verify identity</button>
            <button class="btn btn-quiet btn-sm" type="button" data-kyc="rejected">Reject verification</button>
            <button class="btn btn-quiet btn-sm" type="button" data-kyc="pending">Return to review</button>
            <button class="btn btn-quiet btn-sm" type="button" data-status="frozen">Freeze</button>
            <button class="btn btn-quiet btn-sm" type="button" data-status="active">Reactivate</button>
            <button class="btn btn-danger btn-sm" type="button" data-status="closed">Close account</button>
          </div>

          <h4 style="margin-top:22px">Recent transactions</h4>
          ${adminTxTable(record.transactions || [], { compact: true })}
          <h4 style="margin-top:22px">Fraud alerts</h4>
          ${
            (record.alerts || []).length
              ? `<ul class="plain-list">${record.alerts
                  .map(
                    (alert) =>
                      `<li><strong>${ui.esc(alert.title || alert.ruleCode || alert.rule_code || 'Alert')}</strong><span class="muted">${ui.esc(alert.detail || alert.message || '')} · ${ui.esc(ui.fmtDate(alert.createdAt || alert.created_at, { timeStyle: 'short' }))}</span></li>`,
                  )
                  .join('')}</ul>`
              : '<p class="muted">No fraud alerts recorded.</p>'
          }
          <h4 style="margin-top:22px">Audit trail</h4>
          ${
            (record.audits || []).length
              ? `<ul class="plain-list">${record.audits
                  .map(
                    (entry) =>
                      `<li><strong>${ui.esc(entry.action)}</strong><span class="muted">${ui.esc(ui.fmtDate(entry.createdAt || entry.created_at, { timeStyle: 'short' }))} · ${ui.esc(entry.actorEmail || entry.actor_email || 'system')}</span></li>`,
                  )
                  .join('')}</ul>`
              : '<p class="muted">No audit entries.</p>'
          }
        </div>`;

        host.querySelectorAll('[data-kyc]').forEach((button) =>
          button.addEventListener('click', () => {
            ui.closeModal();
            decisionModal('kyc', id, button.dataset.kyc, customer.name);
          }),
        );
        host.querySelectorAll('[data-status]').forEach((button) =>
          button.addEventListener('click', () => {
            ui.closeModal();
            decisionModal('status', id, button.dataset.status, customer.name);
          }),
        );
      },
    });
  }

  function decisionModal(kind, customerId, decision, name) {
    const isKyc = kind === 'kyc';
    ui.openModal({
      title: isKyc ? `Verification: ${ui.titleCase(decision)}` : `Account status: ${ui.titleCase(decision)}`,
      body: `<p class="modal-text">${ui.esc(name || 'This customer')} will be updated to <strong>${ui.esc(decision)}</strong>. The customer is notified and the change is written to the audit log.</p>
        <label class="field"><span class="field-label">Note${isKyc ? '' : ' / reason'} (optional)</span>
          <textarea class="input" rows="3" data-note maxlength="400" placeholder="${isKyc ? 'Documents reviewed, address matched credit file.' : 'Reason shared with the customer.'}"></textarea>
        </label>`,
      foot: `<button class="btn btn-quiet" type="button" data-close>Cancel</button>
             <button class="btn ${decision === 'closed' || decision === 'rejected' ? 'btn-danger' : 'btn-primary'}" type="button" data-apply>Confirm</button>`,
      onMount(modal) {
        modal.querySelector('[data-close]').addEventListener('click', ui.closeModal);
        modal.querySelector('[data-apply]').addEventListener('click', async (event) => {
          const button = event.currentTarget;
          const note = modal.querySelector('[data-note]').value.trim();
          ui.busy(button, true, 'Saving…');
          try {
            if (isKyc) {
              await api.post(`/api/admin/customers/${encodeURIComponent(customerId)}/kyc`, { decision, note });
            } else {
              await api.post(`/api/admin/customers/${encodeURIComponent(customerId)}/status`, { status: decision, reason: note });
            }
            ui.closeModal();
            ui.toast('Customer record updated.', 'success');
            await reload();
          } catch (error) {
            ui.toast(error instanceof ApiError ? error.message : 'Update failed.', 'error');
            ui.busy(button, false);
          }
        });
      },
    });
  }

  function renderTransactions(data) {
    body.innerHTML = `<div class="card flush">
      <div class="filter-bar">
        <div class="search-inline">${ui.icon('search')}
          <input class="input" type="search" placeholder="Search reference, customer or description" data-tx-search aria-label="Search transactions" />
        </div>
        <div class="filter-controls">
          <select class="select" data-tx-status aria-label="Filter by status">
            <option value="all">All statuses</option><option value="pending">Pending</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option>
          </select>
          <select class="select" data-tx-type aria-label="Filter by type">
            <option value="all">All types</option><option value="deposit">Deposits</option><option value="transfer">Transfers</option><option value="withdrawal">Withdrawals</option>
          </select>
        </div>
      </div>
      <div data-tx-list>${adminTxTable(data.transactions || [], { showCustomer: true, actions: true })}</div>
    </div>`;

    const list = body.querySelector('[data-tx-list]');
    const search = body.querySelector('[data-tx-search]');
    const status = body.querySelector('[data-tx-status]');
    const type = body.querySelector('[data-tx-type]');
    let timer = null;

    async function refetch() {
      const query = new URLSearchParams({ status: status.value, type: type.value });
      if (search.value.trim()) query.set('q', search.value.trim());
      try {
        const fresh = await api.get(`/api/admin/transactions?${query.toString()}`);
        loaded.transactions = fresh;
        list.innerHTML = adminTxTable(fresh.transactions || [], { showCustomer: true, actions: true });
        bindTxActions(list, reload);
      } catch (error) {
        ui.toast(error instanceof ApiError ? error.message : 'Search failed.', 'error');
      }
    }

    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(refetch, 250);
    });
    status.addEventListener('change', refetch);
    type.addEventListener('change', refetch);
    bindTxActions(list, reload);
  }

  function renderAlerts(data) {
    const alerts = data.alerts || [];
    body.innerHTML = `<div class="card flush">
      <div class="card-head pad"><h3>Open fraud alerts</h3><button class="btn btn-quiet btn-sm" type="button" data-refresh>Refresh</button></div>
      ${
        alerts.length
          ? `<ul class="alert-list">${alerts
              .map(
                (alert) => `<li class="alert-item sev-${ui.esc(alert.severity || 'medium')}">
                  <div>
                    <div class="row" style="gap:8px;align-items:center">
                      <span class="badge ${alert.severity === 'high' ? 'failed' : 'pending'}">${ui.esc(ui.titleCase(alert.severity || 'medium'))}</span>
                      <strong>${ui.esc(alert.title || alert.ruleCode || alert.rule_code || 'Risk signal')}</strong>
                    </div>
                    <p class="muted" style="margin:6px 0 0">${ui.esc(alert.detail || alert.message || '')}</p>
                    <p class="fine-print">${ui.esc(alert.customerName || alert.customer_name || alert.email || '')} · ${ui.esc(alert.reference || '')} · ${ui.esc(ui.fmtDate(alert.createdAt || alert.created_at, { timeStyle: 'short' }))}</p>
                  </div>
                  <div class="row" style="gap:8px">
                    <button class="btn btn-quiet btn-sm" type="button" data-alert="resolved" data-id="${ui.esc(alert.id)}">Resolve</button>
                    <button class="btn btn-quiet btn-sm" type="button" data-alert="dismissed" data-id="${ui.esc(alert.id)}">Dismiss</button>
                  </div>
                </li>`,
              )
              .join('')}</ul>`
          : ui.emptyState({ title: 'No open alerts', body: 'Fraud monitoring has not raised any open cases.', iconName: 'shield' })
      }
    </div>`;

    body.querySelector('[data-refresh]').addEventListener('click', () => reload());
    body.querySelectorAll('[data-alert]').forEach((button) =>
      button.addEventListener('click', async () => {
        ui.busy(button, true, 'Saving…');
        try {
          await api.post(`/api/admin/alerts/${encodeURIComponent(button.dataset.id)}`, { status: button.dataset.alert });
          ui.toast(`Alert ${button.dataset.alert}.`, 'success');
          await reload();
        } catch (error) {
          ui.toast(error instanceof ApiError ? error.message : 'Alert could not be updated.', 'error');
          ui.busy(button, false);
        }
      }),
    );
  }

  function renderReconciliation(data) {
    const summary = data.summary || [];
    body.innerHTML = `<div class="stat-grid">${summary
      .map(
        (row) => `<div class="stat-card tone-navy"><span>${ui.esc(ui.titleCase(String(row.status || '')))} ${ui.esc(ui.titleCase(String(row.type || '')))}</span>
          <strong class="tabular">${ui.esc(row.totalFormatted || ui.fmtUSD(row.total || 0))}</strong>
          <small class="muted">${ui.esc(String(row.count ?? 0))} transaction(s)</small></div>`,
      )
      .join('')}</div>
      <div class="card flush" style="margin-top:22px">
        <div class="card-head pad"><h3>Deposits</h3></div>
        ${adminTxTable(data.deposits || [], { showCustomer: true })}
      </div>
      <div class="card flush" style="margin-top:18px">
        <div class="card-head pad"><h3>Withdrawals</h3></div>
        ${adminTxTable(data.withdrawals || [], { showCustomer: true, actions: true })}
      </div>`;
    bindTxActions(body, reload);
  }

  function renderAudit(data) {
    const logs = data.logs || [];
    body.innerHTML = `<div class="card flush">
      <div class="filter-bar">
        <div class="search-inline">${ui.icon('search')}
          <input class="input" type="search" placeholder="Search action or actor email" data-audit-search aria-label="Search audit logs" />
        </div>
      </div>
      <div data-audit-list>${auditTable(logs)}</div>
    </div>`;
    const list = body.querySelector('[data-audit-list]');
    const search = body.querySelector('[data-audit-search]');
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const query = search.value.trim() ? `?q=${encodeURIComponent(search.value.trim())}` : '';
        try {
          const fresh = await api.get(`/api/admin/audit-logs${query}`);
          loaded.audit = fresh;
          list.innerHTML = auditTable(fresh.logs || []);
        } catch (error) {
          ui.toast(error instanceof ApiError ? error.message : 'Search failed.', 'error');
        }
      }, 250);
    });
  }

  function auditTable(logs) {
    if (!logs.length) return ui.emptyState({ title: 'No audit entries', body: 'Administrative and customer actions appear here.', iconName: 'list' });
    return `<div class="tx-table admin-table">
      <div class="tx-head"><span>Action</span><span>Actor</span><span>Target</span><span>IP</span><span>When</span><span></span></div>
      ${logs
        .map(
          (log) => `<div class="tx-line">
            <span class="tx-main"><span class="tx-avatar">${ui.icon('shield')}</span><span class="tx-main-text"><strong>${ui.esc(log.action)}</strong><span>${ui.esc(log.targetType || log.target_type || '')} ${ui.esc(log.targetId || log.target_id || '')}</span></span></span>
            <span>${ui.esc(log.actorEmail || log.actor_email || 'system')}</span>
            <span class="tabular">${ui.esc((log.targetId || log.target_id || '').slice(0, 12))}</span>
            <span class="tabular">${ui.esc(log.ip || '—')}</span>
            <span class="tabular">${ui.esc(ui.fmtDate(log.createdAt || log.created_at, { timeStyle: 'short' }))}</span>
            <span></span>
          </div>`,
        )
        .join('')}
    </div>`;
  }

  function bindTxActions(host, refreshFn) {
    host.querySelectorAll('[data-settle]').forEach((button) =>
      button.addEventListener('click', async () => {
        ui.busy(button, true, 'Settling…');
        try {
          await api.post(`/api/admin/transactions/${encodeURIComponent(button.dataset.settle)}/settle`, {});
          ui.toast('Transaction settled.', 'success');
          await refreshFn();
        } catch (error) {
          ui.toast(error instanceof ApiError ? error.message : 'Settlement failed.', 'error');
          ui.busy(button, false);
        }
      }),
    );
    host.querySelectorAll('[data-fail]').forEach((button) =>
      button.addEventListener('click', async () => {
        ui.busy(button, true, 'Updating…');
        try {
          await api.post(`/api/admin/transactions/${encodeURIComponent(button.dataset.fail)}/fail`, {
            reason: 'Declined by operations review.',
          });
          ui.toast('Transaction marked failed and funds released.', 'success');
          await refreshFn();
        } catch (error) {
          ui.toast(error instanceof ApiError ? error.message : 'Update failed.', 'error');
          ui.busy(button, false);
        }
      }),
    );
  }

  await load();
}

function adminTxTable(rows, { showCustomer = false, actions = false, compact = false } = {}) {
  if (!rows.length) {
    return ui.emptyState({ title: 'Nothing to show', body: 'No transactions match this view.', iconName: 'list' });
  }
  return `<div class="tx-table admin-table ${compact ? 'compact' : ''}">
    <div class="tx-head"><span>Transaction</span>${showCustomer ? '<span>Customer</span>' : ''}<span>Reference</span><span>Amount</span><span>Status</span><span></span></div>
    ${rows
      .map(
        (tx) => `<div class="tx-line">
          <span class="tx-main"><span class="tx-avatar">${ui.icon(ui.txIconName(tx))}</span>
            <span class="tx-main-text"><strong>${ui.esc(ui.txTitle(tx))}</strong><span>${ui.esc(ui.fmtDate(tx.createdAt || tx.created_at, { timeStyle: 'short' }))}</span></span>
          </span>
          ${showCustomer ? `<span>${ui.esc(tx.customer?.name || tx.customerName || '—')}</span>` : ''}
          <span class="tabular ref">${ui.esc(tx.reference || '')}</span>
          <span class="tabular">${ui.esc(tx.amount || '')}</span>
          <span>${ui.statusBadge(tx.status)}</span>
          <span class="ta-right row" style="gap:6px;justify-content:flex-end">
            ${actions && tx.status === 'pending' ? `<button class="btn btn-quiet btn-sm" type="button" data-settle="${ui.esc(tx.id)}">Settle</button><button class="btn btn-quiet btn-sm" type="button" data-fail="${ui.esc(tx.id)}">Fail</button>` : ''}
          </span>
        </div>`,
      )
      .join('')}
  </div>`;
}
