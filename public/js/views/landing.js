import * as ui from '../ui.js';

const FEATURES = [
  {
    icon: 'send',
    title: 'Transfers with verified recipients',
    body: 'Search any US institution, confirm the legal name on the receiving account, and review every detail before you approve.',
  },
  {
    icon: 'shield',
    title: 'Security without friction',
    body: 'Two-factor authentication, a six-digit transaction PIN and biometric unlock where your device supports it.',
  },
  {
    icon: 'list',
    title: 'A ledger you can audit',
    body: 'Every movement carries a reference number, timestamp and downloadable receipt. Filter by status or search by name.',
  },
  {
    icon: 'receive',
    title: 'Deposits that post on proof',
    body: 'Card deposits are credited only after the payment gateway confirms settlement. No provisional balances.',
  },
  {
    icon: 'withdraw',
    title: 'Withdrawals with clear status',
    body: 'ACH, domestic wire or mailed check — each with the processing window stated up front and tracked to completion.',
  },
  {
    icon: 'scale',
    title: 'Operations oversight',
    body: 'Identity review, fraud alerts, reconciliation and immutable audit logs are built into the platform, not bolted on.',
  },
];

export async function renderLanding(root, ctx) {
  document.title = 'Northvale Financial — Modern American Banking';
  root.innerHTML = `
  <div class="landing">
    <header class="landing-nav">
      <a class="brand" href="#/" aria-label="Northvale Financial">
        <span class="brand-mark" aria-hidden="true">N</span>
        <span class="brand-text">
          <span class="brand-name">Northvale</span>
          <span class="brand-sub">Financial</span>
        </span>
      </a>
      <nav class="landing-links" aria-label="Sections">
        <a href="#/" data-scroll="banking">Banking</a>
        <a href="#/" data-scroll="security">Security</a>
        <a href="#/" data-scroll="platform">Platform</a>
        <a href="#/" data-scroll="disclosures">Disclosures</a>
      </nav>
      <div class="landing-actions">
        <a class="btn btn-ghost btn-sm" href="#/signin">Sign in</a>
        <a class="btn btn-primary btn-sm" href="#/register">Open an account</a>
      </div>
    </header>

    <section class="hero">
      <div>
        <span class="eyebrow">${ui.icon('bank')} United States · Digital Banking</span>
        <h1>Banking with the composure of a private institution.<br /><em>Built for everyday America.</em></h1>
        <p class="hero-lede">
          Northvale Financial brings institutional-grade controls to a personal account: verified transfers,
          transparent deposit settlement, and a ledger you can inspect line by line — in dollars, on your schedule.
        </p>
        <div class="hero-cta">
          <a class="btn btn-primary" href="#/register">Open your account ${ui.icon('chevron')}</a>
          <a class="btn btn-ghost" href="#/signin">Sign in to online banking</a>
        </div>
        <div class="hero-points">
          <div><div class="k">$0</div><div class="d">Monthly maintenance fee</div></div>
          <div><div class="k">24/7</div><div class="d">Account visibility</div></div>
          <div><div class="k">2FA</div><div class="d">On every sign-in</div></div>
        </div>
      </div>

      <div class="hero-visual">
        <div class="balance-card">
          <div class="bc-top">
            <div>
              <div class="bc-label">Available balance</div>
              <div class="bc-amount">$18,420<span class="cents">.55</span></div>
            </div>
            <span class="card-chip" aria-hidden="true"></span>
          </div>
          <div class="bc-meta">
            <div><div class="k">Account</div><div class="v">•••• 8841</div></div>
            <div><div class="k">Type</div><div class="v">Checking</div></div>
            <div><div class="k">Status</div><div class="v">Verified</div></div>
          </div>
          <div class="bc-foot">
            <span>Northvale Financial · Member FDIC partner network</span>
            <span>USD</span>
          </div>
        </div>
        <div class="hero-float">
          <div class="row" style="gap:10px;flex-wrap:nowrap">
            <span class="tx-icon debit">${ui.icon('send')}</span>
            <div style="min-width:0">
              <div class="tx-title">Transfer to Meridian Holdings</div>
              <div class="tx-sub">Chase · •••• 4192 · verified</div>
            </div>
            <div class="spacer"></div>
            <span class="badge success">Completed</span>
          </div>
          <div class="tx-sub" style="margin-top:10px">Illustrative dashboard · reference NV-8F2K-4417</div>
        </div>
      </div>
    </section>

    <section class="section alt" id="banking">
      <div class="section-head">
        <span class="eyebrow">Everyday banking</span>
        <h2>One account. Every movement accounted for.</h2>
        <p>Deposits, withdrawals and transfers share the same verification path, so what you see in the dashboard is what operations sees in the ledger.</p>
      </div>
      <div class="feature-grid">
        ${FEATURES.map(
          (feature) => `<article class="feature">
            <span class="ic">${ui.icon(feature.icon)}</span>
            <h3>${ui.esc(feature.title)}</h3>
            <p>${ui.esc(feature.body)}</p>
          </article>`,
        ).join('')}
      </div>
    </section>

    <section class="section" id="security">
      <div class="grid split">
        <div>
          <div class="section-head">
            <span class="eyebrow">${ui.icon('lock')} Security architecture</span>
            <h2>Controls that hold under scrutiny.</h2>
            <p>Northvale authenticates every request on the server. The browser never holds a balance, a permission or a key.</p>
          </div>
          <div class="stack">
            <div class="assure-item">
              <span class="tx-icon credit">${ui.icon('lock')}</span>
              <div><strong>Scrypt password hashing</strong><p>Passwords and transaction PINs are salted and hashed with scrypt. Plaintext secrets are never stored.</p></div>
            </div>
            <div class="assure-item">
              <span class="tx-icon credit">${ui.icon('fingerprint')}</span>
              <div><strong>Two-factor and biometrics</strong><p>Time-based one-time codes protect sign-in. Transaction PINs protect money movement, with device biometrics where available.</p></div>
            </div>
            <div class="assure-item">
              <span class="tx-icon credit">${ui.icon('shield')}</span>
              <div><strong>Server-side authorization</strong><p>Account ownership, account status and identity verification are re-checked on every money movement request.</p></div>
            </div>
            <div class="assure-item">
              <span class="tx-icon credit">${ui.icon('alert')}</span>
              <div><strong>Fraud monitoring and rate limits</strong><p>Velocity rules, new-recipient review and failed-PIN lockouts raise alerts for operations in real time.</p></div>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-head">
            <div>
              <h3>What we will never do</h3>
              <p class="card-sub">Plain commitments, written the way they should be.</p>
            </div>
          </div>
          <ul class="stack" style="list-style:none;padding:0;margin:0;font-size:13.5px;color:var(--ink-soft)">
            <li class="row" style="flex-wrap:nowrap;align-items:flex-start;gap:10px">${ui.icon('check')}<span>Show a balance that is not backed by a posted ledger entry.</span></li>
            <li class="row" style="flex-wrap:nowrap;align-items:flex-start;gap:10px">${ui.icon('check')}<span>Mark a transfer successful before the receiving institution confirms settlement.</span></li>
            <li class="row" style="flex-wrap:nowrap;align-items:flex-start;gap:10px">${ui.icon('check')}<span>Expose payment gateway keys, secrets or session tokens to the browser.</span></li>
            <li class="row" style="flex-wrap:nowrap;align-items:flex-start;gap:10px">${ui.icon('check')}<span>Move money without a verified identity on the account.</span></li>
          </ul>
          <div class="notice info" style="margin-top:16px">${ui.icon('shield')}<div>Session cookies are httpOnly and expire automatically. Sign-in and money movement are rate limited per network and account.</div></div>
        </div>
      </div>
    </section>

    <section class="section alt" id="platform">
      <div class="section-head">
        <span class="eyebrow">Platform</span>
        <h2>Built as a complete banking system.</h2>
        <p>Customer application, ledger, operations console and audit trail — one coherent product.</p>
      </div>
      <div class="grid cols-3">
        <div class="stat"><span class="k">Customer</span><span class="v">Application</span><span class="d">Identity verification, account issuance, profile and security controls.</span></div>
        <div class="stat"><span class="k">Money movement</span><span class="v">Ledger</span><span class="d">Holds, settlements, cancellations and receipts with reference numbers.</span></div>
        <div class="stat"><span class="k">Operations</span><span class="v">Console</span><span class="d">KYC review, monitoring, fraud alerts, reconciliation and audit logs.</span></div>
      </div>
    </section>

    <footer class="disclosure" id="disclosures">
      <h4>Important disclosures</h4>
      <p><strong style="color:#fff">Northvale Financial is a financial technology company, not a bank.</strong> Banking services are provided through partner institutions once those partnerships are finalized and disclosed here. Northvale does not currently hold a national bank charter and does not itself accept deposits for lending or investment.</p>
      <p>Funds shown in this environment are held on the platform ledger. Transfers to external institutions are submitted for settlement through partner rails and remain pending until confirmed; withdrawals are held pending operations verification. Card deposits are processed by a connected payment gateway and are credited only after the gateway confirms payment.</p>
      <p>Nothing on this site is an offer of credit, a guarantee of availability, or a representation of FDIC insurance. Account applications are subject to identity verification and approval.</p>
      <div class="landing-foot">
        <span>© ${new Date().getFullYear()} Northvale Financial</span>
        <a href="#/register">Open an account</a>
        <a href="#/signin">Sign in</a>
        <span style="margin-left:auto">USD · United States</span>
      </div>
    </footer>
  </div>`;

  root.querySelectorAll('[data-scroll]').forEach((link) => {
    link.addEventListener('click', (event) => {
      const target = document.getElementById(link.dataset.scroll);
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}
