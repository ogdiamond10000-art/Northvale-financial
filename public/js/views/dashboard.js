import { api } from '../api.js';
import * as ui from '../ui.js';

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function todayLabel() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function quickAction({ href, iconName, label, sub }) {
  return `<a class="quick-action" href="#${href}">
    <span class="qa-icon">${ui.icon(iconName)}</span>
    <span class="qa-text"><strong>${ui.esc(label)}</strong><span>${ui.esc(sub)}</span></span>
    <span class="qa-chevron">${ui.icon('chevron')}</span>
  </a>`;
}

export async function renderDashboard(page, ctx) {
  ctx.setTitle('Overview');
  page.innerHTML = `<div class="stack">
    <div class="skeleton" style="height:22px;width:280px"></div>
    <div class="skeleton" style="height:220px"></div>
    <div class="skeleton" style="height:180px"></div>
  </div>`;

  const [accountData, txData] = await Promise.all([
    api.get('/api/account'),
    api.get('/api/account/transactions?limit=6'),
  ]);

  const user = ctx.state.user || {};
  const account = accountData.account;
  const stats = accountData.stats || {};
  const transactions = txData.transactions || [];
  const notifications = ctx.state.notifications || [];

  if (!account) {
    page.innerHTML = `<div class="card">${ui.emptyState({
      title: 'No account on file',
      body: 'Your profile does not have an active Northvale account yet. Contact support to finish onboarding.',
      iconName: 'bank',
      action: '<a class="btn btn-primary btn-sm" href="#/settings">Open profile</a>',
    })}</div>`;
    return;
  }

  const kycNotice =
    user.kycStatus === 'verified'
      ? ''
      : user.kycStatus === 'rejected'
        ? ui.notice('danger', 'Your identity verification was not approved. Resubmit your documents from Profile & security.', { strong: 'Verification required.' })
        : ui.notice('warn', 'Your identity documents are with our operations team. Deposits, transfers and withdrawals unlock once verification is approved.', { strong: 'Verification pending.' });

  page.innerHTML = `<div class="stack">
    <div class="welcome-row">
      <div>
        <span class="eyebrow">${ui.icon('bank')} ${ui.esc(todayLabel())}</span>
        <h2 class="welcome-title">${greeting()}, ${ui.esc(user.firstName || 'there')}</h2>
        <p class="welcome-sub">Here is the latest across your Northvale account.</p>
      </div>
      <div class="row" style="gap:10px">
        <a class="btn btn-quiet btn-sm" href="#/transactions">${ui.icon('list')} Activity</a>
        <a class="btn btn-primary btn-sm" href="#/transfer">${ui.icon('send')} New transfer</a>
      </div>
    </div>

    ${kycNotice}

    <div class="dash-grid">
      <section class="balance-card">
        <div class="bc-top">
          <div>
            <span class="bc-label">Available balance</span>
            <div class="bc-amount tabular" id="avail">${ui.esc(account.availableBalance)}</div>
            <span class="bc-sub">Current balance ${ui.esc(account.currentBalance)}${
              account.pendingHoldsCents > 0 ? ` · ${ui.fmtUSD(account.pendingHoldsCents)} on hold` : ''
            }</span>
          </div>
          <span class="badge light">${ui.esc(ui.accountTypeLabel(account.accountType))}</span>
        </div>
        <div class="bc-meta">
          <div><span class="bc-label">Account number</span><strong class="tabular">${ui.esc(ui.groupAccountNumber(account.accountNumber))}</strong></div>
          <div><span class="bc-label">Routing number</span><strong class="tabular">${ui.esc(account.routingNumber)}</strong></div>
          <div><span class="bc-label">Status</span><strong>${ui.esc(ui.titleCase(account.status))}</strong></div>
        </div>
        <div class="bc-actions">
          <a class="btn btn-onnavy" href="#/deposit">${ui.icon('receive')} Deposit</a>
          <a class="btn btn-onnavy" href="#/withdraw">${ui.icon('withdraw')} Withdraw</a>
          <a class="btn btn-onnavy" href="#/transfer">${ui.icon('send')} Transfer</a>
        </div>
        <div class="bc-foot">
          <button class="btn btn-quiet btn-sm" type="button" data-copy-account style="color:#cfe0f2;border-color:rgba(255,255,255,.24)">${ui.icon('copy')} Copy account details</button>
          <span>Northvale Financial · USD</span>
        </div>
      </section>

      <div class="stack">
        <div class="stat-row">
          <div class="stat">
            <span class="stat-label">Money in this month</span>
            <strong class="tabular">${ui.esc(stats.monthIn || ui.fmtUSD(0))}</strong>
            <span class="stat-foot">${ui.icon('receive')} settled credits</span>
          </div>
          <div class="stat">
            <span class="stat-label">Money out this month</span>
            <strong class="tabular">${ui.esc(stats.monthOut || ui.fmtUSD(0))}</strong>
            <span class="stat-foot">${ui.icon('send')} settled debits</span>
          </div>
          <div class="stat">
            <span class="stat-label">Pending</span>
            <strong class="tabular">${Number(stats.pendingCount || 0)}</strong>
            <span class="stat-foot">${ui.icon('clock')} awaiting settlement</span>
          </div>
        </div>

        <div class="card flush">
          <div class="card-head" style="padding:18px 20px 0;margin-bottom:10px">
            <div><h3 style="font-size:15px">Quick actions</h3><p class="card-sub">Every action posts to the Northvale ledger.</p></div>
          </div>
          <div class="quick-actions">
            ${quickAction({ href: '/deposit', iconName: 'receive', label: 'Add money', sub: 'Fund with a card via our gateway' })}
            ${quickAction({ href: '/withdraw', iconName: 'withdraw', label: 'Withdraw funds', sub: 'Pay out to a verified account' })}
            ${quickAction({ href: '/transfer', iconName: 'send', label: 'Send a transfer', sub: 'US bank or Northvale customer' })}
          </div>
        </div>
      </div>
    </div>

    <div class="dash-grid wide-left">
      <section class="card flush">
        <div class="card-head" style="padding:20px 22px 0">
          <div><h3 style="font-size:15px">Recent activity</h3><p class="card-sub">Your six most recent transactions.</p></div>
          <div class="spacer"></div>
          <a class="btn btn-quiet btn-sm" href="#/transactions">View all ${ui.icon('chevron')}</a>
        </div>
        <div class="tx-list" style="padding:10px 12px 16px">
          ${
            transactions.length
              ? transactions.map((tx) => ui.txRow(tx)).join('')
              : ui.emptyState({ title: 'No transactions yet', body: 'Fund your account to see activity here.', iconName: 'list' })
          }
        </div>
      </section>

      <section class="card flush">
        <div class="card-head" style="padding:20px 22px 0">
          <div><h3 style="font-size:15px">Notifications</h3><p class="card-sub">Security and account alerts.</p></div>
          <div class="spacer"></div>
          <a class="icon-btn" href="#/notifications" aria-label="All notifications">${ui.icon('bell')}</a>
        </div>
        <div class="notif-list" style="padding:8px 12px 16px">
          ${
            notifications.length
              ? notifications
                  .slice(0, 5)
                  .map(
                    (item) => `<div class="notif ${item.read ? '' : 'is-unread'}">
                      <span class="notif-dot" aria-hidden="true"></span>
                      <div><strong>${ui.esc(item.title)}</strong><p>${ui.esc(item.body)}</p><span>${ui.esc(ui.timeAgo(item.createdAt))}</span></div>
                    </div>`,
                  )
                  .join('')
              : ui.emptyState({ title: 'Nothing new', body: 'Alerts about logins, transfers and verification will appear here.', iconName: 'bell' })
          }
        </div>
      </section>
    </div>

    <div class="disclosure">
      ${ui.icon('shield')}
      <div><strong>Northvale Financial is a financial technology company, not a bank.</strong>
      Banking services are provided by partner institutions once those partnerships are authorised; until then all activity shown here is recorded in the Northvale platform ledger. Deposits are only credited after a payment gateway confirms them.</div>
    </div>
  </div>`;

  page.querySelector('[data-copy-account]')?.addEventListener('click', () =>
    ui.copyText(`Northvale Financial · ${ui.accountTypeLabel(account.accountType)} · Account ${account.accountNumber} · Routing ${account.routingNumber}`),
  );
}
