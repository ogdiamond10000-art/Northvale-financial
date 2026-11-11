/**
 * Application shell: session bootstrap, sidebar/topbar chrome, routing.
 */
import { api, ApiError } from './api.js';
import { defineRoute, startRouter, navigate } from './router.js';
import * as ui from './ui.js';
import { renderLanding } from './views/landing.js';
import { renderSignIn, renderRegister } from './views/auth.js';
import { renderDashboard } from './views/dashboard.js';
import { renderTransfer } from './views/transfer.js';
import { renderWithdraw } from './views/withdraw.js';
import { renderDeposit } from './views/deposit.js';
import { renderTransactions, renderTransactionDetail } from './views/transactions.js';
import { renderSettings, renderNotifications } from './views/settings.js';
import { renderAdmin } from './views/admin.js';

const root = document.getElementById('app');

const state = {
  user: null,
  account: null,
  notifications: [],
  unreadCount: 0,
  loaded: false,
};

const ctx = {
  state,
  async refresh() {
    try {
      const data = await api.get('/api/auth/session');
      state.user = data.user;
      state.account = data.account;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        state.user = null;
        state.account = null;
      } else {
        throw error;
      }
    }
    state.loaded = true;
    return state;
  },
  async loadNotifications() {
    if (!state.user) return [];
    try {
      const data = await api.get('/api/notifications');
      state.notifications = data.notifications || [];
      state.unreadCount = data.unread ?? (data.notifications || []).filter((n) => !n.read).length;
    } catch {
      state.notifications = [];
    }
    return state.notifications;
  },
  async signOut() {
    try {
      await api.post('/api/auth/logout');
    } catch {
      /* session may already be gone */
    }
    state.user = null;
    state.account = null;
    state.notifications = [];
    ui.toast('You have been signed out.', 'success');
    navigate('/');
  },
  setTitle(title, eyebrow = 'Northvale Financial') {
    const heading = document.querySelector('.topbar-title');
    const kicker = document.querySelector('.topbar-eyebrow');
    if (heading) heading.textContent = title;
    if (kicker) kicker.textContent = eyebrow;
    document.title = `${title} · Northvale Financial`;
  },
};

/* ------------------------------- chrome ------------------------------- */

function brandBlock() {
  return `<a class="brand" href="#/dashboard" aria-label="Northvale Financial home">
    <span class="brand-mark" aria-hidden="true">N</span>
    <span class="brand-text">
      <span class="brand-name">Northvale</span>
      <span class="brand-sub">Financial</span>
    </span>
  </a>`;
}

function navLink(item, activePath) {
  const active = activePath === item.href || (item.href !== '/dashboard' && activePath.startsWith(item.href));
  const badge = item.badge && state.unreadCount ? `<span class="nav-badge">${state.unreadCount}</span>` : '';
  return `<a class="nav-link ${active ? 'is-active' : ''}" href="#${item.href}">${ui.icon(item.icon)}<span>${ui.esc(item.label)}</span>${badge}</a>`;
}

function shellHtml(activePath) {
  const user = state.user || {};
  const isAdmin = user.role === 'admin';
  const groups = [
    {
      label: 'Banking',
      items: [
        { href: '/dashboard', label: 'Overview', icon: 'home' },
        { href: '/transfer', label: 'Transfer', icon: 'send' },
        { href: '/withdraw', label: 'Withdraw', icon: 'withdraw' },
        { href: '/deposit', label: 'Deposit', icon: 'receive' },
        { href: '/transactions', label: 'Transactions', icon: 'list' },
      ],
    },
    {
      label: 'Account',
      items: [
        { href: '/notifications', label: 'Notifications', icon: 'bell', badge: true },
        { href: '/settings', label: 'Profile & security', icon: 'shield' },
      ],
    },
  ];
  if (isAdmin) {
    groups.push({
      label: 'Administration',
      items: [{ href: '/admin', label: 'Admin console', icon: 'grid' }],
    });
  }

  const nav = groups
    .map(
      (group) => `<div class="nav-group">
        <div class="nav-label">${ui.esc(group.label)}</div>
        ${group.items.map((item) => navLink(item, activePath)).join('')}
      </div>`,
    )
    .join('');

  return `<div class="app-shell">
    <aside class="sidebar">
      ${brandBlock()}
      ${nav}
      <div class="sidebar-foot">
        <div class="row" style="gap:10px;flex-wrap:nowrap">
          <span class="brand-mark" style="width:34px;height:34px;font-size:14px" aria-hidden="true">${ui.esc(ui.initials(user.firstName, user.lastName))}</span>
          <span style="min-width:0">
            <span style="display:block;font-size:13px;color:#fff;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${ui.esc(`${user.firstName || ''} ${user.lastName || ''}`.trim())}</span>
            <span style="display:block;font-size:11px;color:#8fa3bb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${ui.esc(user.email || '')}</span>
          </span>
        </div>
        <button class="nav-link" data-signout type="button" style="width:100%;text-align:left">${ui.icon('logout')}<span>Sign out</span></button>
      </div>
    </aside>
    <div class="main-col">
      <header class="topbar">
        <div>
          <div class="topbar-eyebrow">Northvale Financial</div>
          <h1 class="topbar-title">Overview</h1>
        </div>
        <div class="topbar-actions">
          <a class="icon-btn" href="#/notifications" aria-label="Notifications" style="position:relative">
            ${ui.icon('bell')}${state.unreadCount ? '<span class="dot"></span>' : ''}
          </a>
          <a class="icon-btn" href="#/settings" aria-label="Profile and security">${ui.icon('user')}</a>
        </div>
      </header>
      <main class="page" id="page-view"></main>
    </div>
    <nav class="mobile-nav" aria-label="Primary">
      <a href="#/dashboard" class="${activePath === '/dashboard' ? 'is-active' : ''}">${ui.icon('home')}<span>Home</span></a>
      <a href="#/transfer" class="${activePath === '/transfer' ? 'is-active' : ''}">${ui.icon('send')}<span>Transfer</span></a>
      <a href="#/deposit" class="${activePath === '/deposit' ? 'is-active' : ''}">${ui.icon('receive')}<span>Deposit</span></a>
      <a href="#/transactions" class="${activePath === '/transactions' ? 'is-active' : ''}">${ui.icon('list')}<span>Activity</span></a>
      <a href="#/settings" class="${activePath === '/settings' ? 'is-active' : ''}">${ui.icon('user')}<span>Profile</span></a>
    </nav>
  </div>`;
}

async function mountShell(activePath) {
  root.innerHTML = shellHtml(activePath);
  root.querySelector('[data-signout]')?.addEventListener('click', () => ctx.signOut());
  return root.querySelector('#page-view');
}

/* ------------------------------- guards ------------------------------- */

async function requireSession() {
  if (!state.loaded) await ctx.refresh();
  if (!state.user) {
    ui.toast('Please sign in to continue.', 'error');
    navigate('/signin', { replace: true });
    return false;
  }
  return true;
}

async function appPage(path, view, { adminOnly = false } = {}) {
  if (!(await requireSession())) return;
  if (adminOnly && state.user.role !== 'admin') {
    const page = await mountShell(path);
    page.innerHTML = ui.notice('danger', 'This area is restricted to Northvale operations staff.', { strong: 'Access denied.' });
    ctx.setTitle('Restricted');
    return;
  }
  const page = await mountShell(path);
  await ctx.loadNotifications();
  // Re-render nav badge now that unread count is known.
  const badgeHost = root.querySelector('.nav-link[href="#/notifications"]');
  if (badgeHost && state.unreadCount) {
    badgeHost.insertAdjacentHTML('beforeend', `<span class="nav-badge">${state.unreadCount}</span>`);
  }
  const bell = root.querySelector('.topbar-actions .icon-btn');
  if (bell && state.unreadCount) bell.insertAdjacentHTML('beforeend', '<span class="dot"></span>');
  await view(page, ctx, { params: {}, query: new URLSearchParams() });
}

/* ------------------------------- routes ------------------------------- */

defineRoute('/', async () => {
  if (!state.loaded) await ctx.refresh();
  if (state.user) {
    navigate('/dashboard', { replace: true });
    return;
  }
  await renderLanding(root, ctx);
});

defineRoute('/signin', async () => {
  if (!state.loaded) await ctx.refresh();
  if (state.user) {
    navigate('/dashboard', { replace: true });
    return;
  }
  await renderSignIn(root, ctx);
});

defineRoute('/register', async () => {
  if (!state.loaded) await ctx.refresh();
  if (state.user) {
    navigate('/dashboard', { replace: true });
    return;
  }
  await renderRegister(root, ctx);
});

const simple = (path, view, opts) =>
  defineRoute(path, async (route) => {
    if (!(await requireSession())) return;
    if (opts?.adminOnly && state.user.role !== 'admin') {
      const page = await mountShell(path);
      page.innerHTML = ui.notice('danger', 'This area is restricted to Northvale operations staff.', { strong: 'Access denied.' });
      ctx.setTitle('Restricted');
      return;
    }
    const page = await mountShell(path);
    await ctx.loadNotifications();
    await view(page, ctx, route);
  });

simple('/dashboard', renderDashboard);
simple('/transfer', renderTransfer);
simple('/withdraw', renderWithdraw);
simple('/deposit', renderDeposit);
simple('/transactions', renderTransactions);
simple('/transactions/:id', renderTransactionDetail);
simple('/settings', renderSettings);
simple('/notifications', renderNotifications);
simple('/admin', renderAdmin, { adminOnly: true });

defineRoute('*', async () => {
  const page = await mountShell('/dashboard');
  page.innerHTML = `<div class="card">${ui.emptyState({
    title: 'Page not found',
    body: 'That page does not exist. Use the navigation to continue.',
    iconName: 'search',
    action: '<a class="btn btn-primary btn-sm" href="#/dashboard">Back to overview</a>',
  })}</div>`;
  ctx.setTitle('Not found');
});

/* ------------------------------- boot ------------------------------- */

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  if (reason instanceof ApiError && reason.status === 401) {
    state.user = null;
    navigate('/signin', { replace: true });
    return;
  }
  console.error(reason);
});

(async function boot() {
  await ctx.refresh().catch(() => {});
  const matched = await startRouter(ctx);
  if (!matched) {
    navigate(state.user ? '/dashboard' : '/', { replace: true });
  }
})();
