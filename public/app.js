// ContractLens frontend: vanilla JS, hash router, no build step.
const state = { session: null, notifs: [], timer: null, vendors: [] };
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch('/api' + url, opts);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error || res.statusText), { status: res.status, data });
  return data;
}
function toast(msg, err) {
  const el = document.createElement('div'); el.className = 'toast' + (err ? ' err' : ''); el.textContent = msg;
  $('#toast').appendChild(el); setTimeout(() => el.remove(), err ? 6000 : 3500);
}
const modal = (html) => { $('#modal-root').innerHTML = `<div class="modal-back" data-act="modal-bg"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`; };
const closeModal = () => { $('#modal-root').innerHTML = ''; };

const FIELD_LABELS = { parties: 'Parties', effective_date: 'Effective date', expiration_date: 'Expiration date', renewal_terms: 'Renewal terms', payment_terms: 'Payment terms', termination_conditions: 'Termination conditions', service_obligations: 'Service obligations' };
const FLAG_LABELS = { auto_renewal: 'Auto-renewal', unilateral_termination: 'Unilateral termination', penalty: 'Penalty', indemnity: 'Indemnity / liability', other: 'Other risk' };
const STATUS = { processing: ['Reading…', 'neutral'], failed: ['Failed', 'low'], pending_review: ['Needs review', 'medium'], active: ['Active', 'high'], expired: ['Expired', 'neutral'], archived: ['Archived', 'neutral'] };
const CONF = { high: ['●', 'High confidence'], medium: ['◐', 'Medium confidence'], low: ['○', 'Low confidence'] };
const TYPES = { business_class: 'Business', regulatory_class: 'Regulatory' };
const fmtDate = (d) => (d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const statusBadge = (s) => `<span class="badge ${STATUS[s][1]}">${STATUS[s][0]}</span>`;
const confBadge = (c) => `<span class="badge ${c}" title="${CONF[c][1]}">${CONF[c][0]} ${c[0].toUpperCase() + c.slice(1)}</span>`;
function daysChip(days) {
  if (days == null) return '<span class="muted">—</span>';
  const label = days < 0 ? `Expired ${-days}d ago` : days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `${days} days`;
  return `<span class="days ${days < 0 ? 'expired' : days <= 7 ? 'urgent' : days <= 15 ? 'soon' : ''}">${label}</span>`;
}
const isHeading = (p) => !p.clause && /^[A-Z][A-Z0-9 \-&,'’:/().]{3,80}$/.test(p.text);
const refLabel = (p) => `Page ${p.page}, ¶${p.id.split('.')[1]}${p.clause ? ` (§${p.clause})` : ''}`;
const pid = (id) => 'p-' + id.replace('.', '_');

// ------------------------------------------------------------------ shell
const logoMark = () => { let l = ''; for (let i = 0; i < 24; i++) { const a = -Math.PI / 2 + (i / 24) * Math.PI * 2, f = (v) => v.toFixed(2);
  l += `<line x1="${f(26 + Math.cos(a) * 10.4)}" y1="${f(26 + Math.sin(a) * 10.4)}" x2="${f(26 + Math.cos(a) * 22.6)}" y2="${f(26 + Math.sin(a) * 22.6)}"/>`; }
  return `<svg viewBox="0 0 52 52" aria-hidden="true"><g stroke="#f4f4f4" stroke-width="1.4" stroke-linecap="round">${l}</g><circle cx="26" cy="26" r="7.4" fill="#fbfbfb"/></svg>`; };
function renderTop() {
  const s = state.session; if (!s) return;
  const unread = state.notifs.filter((n) => !n.read).length;
  const hash = location.hash || '#/';
  const act = (p) => (hash === p || (p !== '#/' && hash.startsWith(p)) ? 'active' : '');
  $('#top').innerHTML = `
    <a class="brand" href="#/dashboard">${logoMark()}ContractLens</a>
    <nav aria-label="Main">
      <a href="#/dashboard" class="${hash === '#/dashboard' ? 'active' : ''}">Dashboard</a>
      <a href="#/contracts" class="${act('#/contracts')}${hash.startsWith('#/contract/') ? ' active' : ''}">Contracts</a>
      <a href="#/vendors" class="${act('#/vendor')}">Vendors</a>
      <a href="#/upload" class="${act('#/upload')}">Upload</a>
    </nav>
    <span class="spacer"></span>
    <span class="mode ${s.mode}" title="${s.mode === 'live' ? 'Using Claude (' + esc(s.model) + ')' : 'No API key: replays pre-computed results for the /samples files'}">${s.mode === 'live' ? 'Live · Claude' : 'Offline demo'}</span>
    <div class="bell" style="position:relative">
      <button class="icon" data-act="bell" aria-label="Notifications">🔔</button>${unread ? `<span class="count">${unread}</span>` : ''}
      <div class="pop hidden" id="bell-pop"></div>
    </div>
    <button class="icon" data-act="settings" aria-label="Settings">⚙ Settings</button>`;
}
function renderBell() {
  const pop = $('#bell-pop'); if (!pop) return;
  pop.innerHTML = `<div class="row between" style="padding:4px 8px 8px"><strong>Reminders</strong>
      <span><button class="link small" data-act="run-reminders">Run check</button> · <button class="link small" data-act="read-all">Mark read</button></span></div>
    ${state.notifs.length ? state.notifs.map((n) => `<a class="item ${n.read ? '' : 'unread'}" style="display:block;color:inherit" href="#/contract/${n.contract_id}">${esc(n.message)}<div class="tiny muted">${new Date(n.created_at).toLocaleString()}</div></a>`).join('') : '<div class="empty small">No reminders yet.</div>'}`;
}
async function refreshNotifs() { try { state.notifs = (await api('GET', '/dashboard')).notifications; renderTop(); } catch { /* ignore */ } }

// ------------------------------------------------------------------ router
async function route() {
  clearInterval(state.timer);
  closeModal();
  document.body.classList.remove('landing', 'menu-open'); document.documentElement.classList.remove('entrance', 'entrance-s2', 'hero-ready');
  const h = location.hash.replace(/^#/, '') || '/';
  if (h === '/') return pageLanding();
  renderTop();
  try {
    let m;
    if (h === '/dashboard') await pageDashboard();
    else if (h === '/contracts') await pageContracts();
    else if (h === '/upload') await pageUpload();
    else if (h === '/vendors') await pageVendors();
    else if ((m = h.match(/^\/vendor\/(\d+)$/))) await pageVendor(m[1]);
    else if ((m = h.match(/^\/contract\/(\d+)$/))) await pageContract(m[1]);
    else app.innerHTML = '<div class="empty">Page not found. <a href="#/dashboard">Go to dashboard</a></div>';
  } catch (e) {
    app.innerHTML = `<div class="banner err">${esc(e.message)}</div>`;
  }
  refreshNotifs();
}


// ------------------------------------------------------------------ landing
function pageLanding() {
  document.body.classList.add('landing');
  $('#top').innerHTML = '';
  const feats = [
    ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3', 'Every term, with its source', 'Parties, dates, renewal, payment and termination pulled out automatically, each with a confidence rating and a link to the exact clause.'],
    ['M5 21V4M5 4h11l-2 4 2 4H5', 'Risky clauses flagged', 'Auto-renewal traps, one-sided termination rights, penalties and indemnities are called out in plain language.'],
    ['M4 5h16v11H9l-5 4z', 'Ask your contract', 'Ask “when can I cancel?” and get an answer that cites the clause, or says plainly when it is not sure.'],
    ['M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'Deadline reminders', 'See what is about to expire, and get reminded at 30, 15 and 7 days, or whatever windows you choose.'],
    ['M3 7h7l2 2h9v10H3z', 'Vendor history', 'Every contract with the same company in one timeline, even when the name is spelled differently.'],
    ['M5 12l4 4 10-10', 'You stay in control', 'Nothing is saved as active until you have reviewed the uncertain fields and flagged clauses yourself.'],
  ];
  const ic = (d) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  const links = [['features', 'Features'], ['audience', "Who it's for"], ['how', 'How it works']];
  app.innerHTML = `
  <div class="lp">
    <section class="s1" id="home"><div class="page">
      <header class="topbar">
        <a class="lp-logo" href="#/" aria-label="Home" data-enter>${logoMark()}</a>
        <ul class="nav-links">${links.map(([id, t]) => `<li data-enter><a href="#/" data-scroll="${id}">${t}</a></li>`).join('')}</ul>
        <div class="nav-right"><a class="pill-cta" href="#/dashboard" data-enter>Get started</a>
          <button class="burger" id="burger" aria-label="Menu" aria-expanded="false" aria-controls="navOverlay" data-enter><i></i><i></i><i></i></button></div>
      </header>
      <div class="hero">
        <span class="lp-badge" data-enter>Contract intelligence for people and teams</span>
        <h1><span class="hl-mask"><span class="hl-line">Know what you've signed.</span></span><span class="hl-mask"><span class="hl-line">Never miss a deadline.</span></span></h1>
        <p class="sub" data-enter>Upload a contract. ContractLens pulls out the key terms, flags the risky clauses in plain English, and reminds you before it expires. Every answer points back to the clause it came from.</p>
        <div class="composer-shell" data-enter><div class="composer"><div class="composer-glow"></div>
          <div class="ph" data-enter>Upload a contract to get started…</div>
          <div class="controls">
            <a class="chip round" href="#/upload" aria-label="Add attachment" data-enter><svg viewBox="0 0 24 24" width="46%" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></a>
            <a class="chip pillchip" href="#/dashboard" data-enter>Get started</a>
            <a class="chip pillchip" href="#/" data-scroll="how" data-enter>How it works</a>
            <span class="grow"></span>
            <span class="mic" aria-hidden="true" data-enter><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></span>
            <a class="send" href="#/upload" aria-label="Upload a contract" data-enter><span class="send-inner"><svg viewBox="0 0 24 24" width="44%" fill="none" stroke="#fafafa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg></span></a>
          </div></div></div>
        <div class="proto" data-enter>Prototype · summaries are not legal advice</div>
      </div></div></section>

    <section class="s2" id="features"><div class="wrap2">
      <div class="panel" id="panel"><div class="panel-in">${feats.map(([d, t, x]) => `<div class="fcard" data-msg><div class="fic">${ic(d)}</div><h3>${t}</h3><p>${x}</p></div>`).join('')}</div></div>
    </div></section>

    <section class="s3" id="audience"><div class="wrap2"><h2 class="lp-h2">Built for how you actually use contracts</h2><div class="two">
      <div class="lcard"><span class="lp-badge">Individual</span><h3>Your personal paperwork</h3><p>Rental agreements, insurance, loans, warranties and utility contracts, all in one place, with plain-language summaries and renewal reminders.</p></div>
      <div class="lcard"><span class="lp-badge">Business</span><h3>Your vendors and suppliers</h3><p>A shared workspace for supplier agreements, licences and regulatory consents. Invite your team; everyone gets the same access.</p></div></div></div></section>

    <section class="s3" id="how"><div class="wrap2"><h2 class="lp-h2">How it works</h2><div class="three">
      ${[['1', 'Upload', 'Add a PDF or a photo of the contract.'], ['2', 'Review', 'Check the terms and flagged clauses. Uncertain ones come first.'], ['3', 'Stay on top', 'Ask questions, browse by vendor, get reminded before it expires.']].map(([n, t, d]) => `<div class="lcard"><div class="stepnum">${n}</div><h3>${t}</h3><p>${d}</p></div>`).join('')}</div>
      <div class="center" style="margin-top:32px"><a class="pill-cta big" href="#/dashboard">Get started</a></div>
      <footer class="lfoot">ContractLens prototype · your data stays in this app's local database</footer></div></section>

    <div class="overlay" id="navOverlay" role="dialog" aria-modal="true" aria-label="Menu" hidden>
      <nav>${links.map(([id, t]) => `<a href="#/" data-scroll="${id}">${t}</a>`).join('')}</nav>
      <div class="ov-foot"><div class="bar"></div><a class="pill-cta big block" href="#/dashboard">Get started</a></div></div>
  </div>`;
  initLanding();
}

function initLanding() {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches, root = document.documentElement, D = innerWidth <= 680 ? 0.7 : 1;
  // smooth-scroll links + mobile overlay
  const ov = $('#navOverlay'), burger = $('#burger');
  const setMenu = (open) => { ov.hidden = false; requestAnimationFrame(() => ov.classList.toggle('open', open)); burger.setAttribute('aria-expanded', open); document.body.classList.toggle('menu-open', open); if (!open) setTimeout(() => { if (!ov.classList.contains('open')) ov.hidden = true; }, 360); };
  burger.onclick = () => setMenu(burger.getAttribute('aria-expanded') !== 'true');
  document.querySelectorAll('.lp [data-scroll]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); setMenu(false); document.getElementById(a.dataset.scroll)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' }); }));
  ov.querySelectorAll('a:not([data-scroll])').forEach((a) => a.addEventListener('click', () => setMenu(false)));
  const esc2 = (e) => { if (e.key === 'Escape') setMenu(false); }; document.addEventListener('keydown', esc2);
  addEventListener('resize', () => { if (innerWidth > 1024) setMenu(false); });
  if (reduce) { root.classList.add('hero-ready'); return; }

  // entrance choreography (Web Animations API)
  const REVEAL = 'cubic-bezier(0.16, 1, 0.3, 1)', LIFT = 'cubic-bezier(0.22, 1, 0.36, 1)';
  root.classList.add('entrance', 'entrance-s2');
  setTimeout(() => root.classList.remove('entrance'), 3500);
  setTimeout(() => { if (root.classList.contains('entrance-s2') && !document.getElementById('panel')?.getAnimations().length) { const r = document.getElementById('panel')?.getBoundingClientRect(); if (r && r.top < innerHeight) root.classList.remove('entrance-s2'); } }, 6000); // failsafe
  const anims = []; // hero animations only; later sections clean up after themselves
  const A = (el, kf, o) => { if (!el) return; const an = el.animate(kf, { fill: 'both', ...o }); anims.push(an); return an; };
  // Later sections: when an animation finishes, drop its inline start state and cancel it (the natural CSS is the end state).
  const A2 = (el, kf, o) => { if (!el) return; const an = el.animate(kf, { fill: 'both', ...o }); an.finished.then(() => { el.style.opacity = ''; an.cancel(); }).catch(() => {}); return an; };
  const lift = (els, y, delay, dur, stagger = 0, fn = A) => [].concat(els).forEach((el, i) => fn(el, [{ opacity: 0, transform: `translateY(${y}px)` }, { opacity: 1, transform: 'none' }], { duration: dur * 1000, delay: (delay + i * stagger) * 1000, easing: LIFT }));
  const q = (s) => [...document.querySelectorAll(s)];
  const mask = (lines, base) => lines.forEach((el, i) => A(el, [{ opacity: 0, transform: 'translateY(108%)' }, { opacity: 1, transform: 'translateY(0)', offset: 0.14 }, { opacity: 1, transform: 'translateY(0)' }], { duration: 950, delay: base + i * 90, easing: REVEAL }));
  const play = () => {
    A($('.lp-logo'), [{ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, transform: 'none' }], { duration: 600, easing: LIFT });
    lift(q('.nav-links li'), 10, 0.1, 0.5, 0.05); lift(q('.burger'), 10, 0.16, 0.5); lift(q('.pill-cta'), 10, 0.26, 0.5, 0.05);
    lift(q('.lp-badge')[0], 10, 0.14, 0.6);
    mask(q('.s1 .hl-line'), 200);
    lift(q('.s1 .sub'), 14, 0.52, 0.65);
    A($('.composer-shell'), [{ opacity: 0, transform: `translateY(${22 * D}px) scale(.985)` }, { opacity: 1, transform: 'none' }], { duration: 950, delay: 640, easing: REVEAL });
    lift(q('.ph'), 10, 0.78, 0.55); lift(q('.controls > *:not(.grow)'), 10, 0.84, 0.5, 0.055);
    A($('.composer-glow'), [{ clipPath: 'inset(0 40% 0 40%)', opacity: 0 }, { clipPath: 'inset(0 0% 0 0%)', opacity: 0.95 }], { duration: 800, delay: 940, easing: REVEAL });
    lift(q('.proto'), 12, 1.08, 0.6);
    setTimeout(() => { anims.forEach((a) => { try { a.cancel(); } catch { /* ignore */ } }); root.classList.remove('entrance'); root.classList.add('hero-ready'); }, 2000);
  };
  (document.fonts?.ready ? Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 400))]) : Promise.resolve()).then(play);

  // section 2 + later sections: once, when scrolled into view
  const io = new IntersectionObserver((ents) => { if (!ents.some((e) => e.isIntersecting)) return; io.disconnect();
    A2($('#panel'), [{ opacity: 0, transform: `translateY(${26 * D}px) scale(.985)` }, { opacity: 1, transform: 'none' }], { duration: 1000, delay: 0, easing: REVEAL });
    lift(q('.fcard'), 10, 0.3, 0.6, 0.065, A2);
    root.classList.remove('entrance-s2'); // fill:both keeps the start state through each delay
  }, { rootMargin: '0px 0px -20% 0px', threshold: 0 });
  io.observe($('#panel'));
  const io2 = new IntersectionObserver((ents) => ents.forEach((e) => { if (e.isIntersecting) { io2.unobserve(e.target); A2(e.target, [{ opacity: 0, transform: 'translateY(18px)' }, { opacity: 1, transform: 'none' }], { duration: 700, easing: LIFT }); } }), { rootMargin: '0px 0px -10% 0px' });
  q('.s3 .lp-h2, .s3 .lcard').forEach((el) => { el.style.opacity = 0; io2.observe(el); });
}

// ------------------------------------------------------------------ dashboard
async function pageDashboard() {
  const d = await api('GET', '/dashboard');
  state.notifs = d.notifications; renderTop();
  const c = d.counts;
  app.innerHTML = `
    <div class="page-head"><div><h1>Dashboard</h1><div class="muted">Reminder windows: ${d.windows.join(' / ')} days</div></div>
      <a class="btn primary" href="#/upload">Upload contract</a></div>
    <div class="grid cols-3" style="margin-bottom:16px">
      <a class="card stat" href="#/contracts" style="text-decoration:none"><span class="muted">Active contracts</span><span class="n">${c.active || 0}</span></a>
      <a class="card stat" href="#/contracts" style="text-decoration:none"><span class="muted">Waiting for your review</span><span class="n">${c.pending_review || 0}</span></a>
      <a class="card stat" href="#/contracts" style="text-decoration:none"><span class="muted">Expired</span><span class="n">${c.expired || 0}</span></a>
    </div>
    ${d.pending.length ? `<div class="card" style="margin-bottom:16px"><h2>Needs your review</h2>${d.pending.map((p) => `<div class="row between" style="padding:6px 0"><span>${esc(p.title)}</span><a class="btn" href="#/contract/${p.id}">Review</a></div>`).join('')}</div>` : ''}
    <div class="card" style="margin-bottom:16px"><h2>Expiring soon <span class="muted small">(passive reminders)</span></h2>
      ${d.expiring.length ? `<table class="responsive"><thead><tr><th>Contract</th><th>Vendor</th><th>Expires</th><th>Time left</th><th>Window</th></tr></thead><tbody>
        ${d.expiring.map((e) => `<tr><td><a href="#/contract/${e.id}">${esc(e.title)}</a></td><td>${e.vendor_id ? `<a href="#/vendor/${e.vendor_id}">${esc(e.vendor_name)}</a>` : '—'}</td><td>${fmtDate(e.expiration_date)}</td><td>${daysChip(e.days_left)}</td><td>${e.window ? `<span class="badge ${e.window <= 7 ? 'low' : e.window <= 15 ? 'medium' : 'neutral'}">within ${e.window}d</span>` : '<span class="badge neutral">expired</span>'}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">Nothing expires inside your reminder window. 🎉</div>'}
    </div>
    <div class="grid cols-2">
      <div class="card"><div class="row between"><h2>Reminder notifications <span class="muted small">(active)</span></h2><button data-act="run-reminders" class="small">Run check now</button></div>
        ${d.notifications.length ? d.notifications.slice(0, 6).map((n) => `<div style="padding:6px 0;border-bottom:1px solid var(--border)"><a href="#/contract/${n.contract_id}">${esc(n.message)}</a></div>`).join('') : '<div class="empty small">No reminders sent yet. They fire once per contract when it enters a window.</div>'}
        <p class="tiny muted" style="margin-bottom:0">Delivered in-app and appended to <code>data/outbox.log</code> (email stand-in). Set <code>ALERT_WEBHOOK_URL</code> to also POST to a webhook.</p></div>
      <div class="card"><h2>Regulatory changes <span class="badge medium">DEMO · mocked</span></h2>
        ${d.regulatory_changes.length ? d.regulatory_changes.map((r) => `<div style="margin-bottom:12px"><strong>${esc(r.title)}</strong><div class="tiny muted">${esc(r.authority)} · effective ${fmtDate(r.effective)}</div><div class="small">${esc(r.summary)}</div>
          <div class="small" style="margin-top:4px">Affects: ${r.affected.map((a) => `<a href="#/contract/${a.id}">${esc(a.title)}</a> <span class="tiny muted">(matched: ${esc(a.matched_keywords.join(', '))})</span>`).join(', ')}</div></div>`).join('')
          : '<div class="empty small">No stored regulatory-class contracts are affected by the seeded demo updates.</div>'}
        <p class="tiny muted" style="margin-bottom:0">Seeded fake records mapped by keyword. No live government monitoring.</p></div>
    </div>`;
}

// ------------------------------------------------------------------ contracts list
async function pageContracts() {
  const rows = await api('GET', '/contracts');
  const render = () => {
    const q = ($('#q')?.value || '').toLowerCase(), st = $('#st')?.value || '';
    const list = rows.filter((r) => (!st || r.status === st) && (`${r.title} ${r.vendor_name || ''}`.toLowerCase().includes(q)));
    $('#clist').innerHTML = list.length ? `<table class="responsive"><thead><tr><th>Contract</th><th>Vendor</th><th>Type</th><th>Status</th><th>Expires</th><th>Open flags</th></tr></thead><tbody>
      ${list.map((r) => `<tr><td><a href="#/contract/${r.id}"><strong>${esc(r.title)}</strong></a></td><td>${r.vendor_id ? `<a href="#/vendor/${r.vendor_id}">${esc(r.vendor_name)}</a>` : '<span class="muted">—</span>'}</td>
        <td>${r.contract_type ? TYPES[r.contract_type] : '—'}</td><td>${statusBadge(r.status)}</td><td>${fmtDate(r.expiration_date)} ${r.days_left != null ? '· ' + daysChip(r.days_left) : ''}</td>
        <td>${r.open_flags ? `<span class="badge medium">⚑ ${r.open_flags}</span>` : '—'}${r.low_fields && r.status === 'pending_review' ? ` <span class="badge low">○ ${r.low_fields} low</span>` : ''}</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">No contracts match.</div>';
  };
  app.innerHTML = `<div class="page-head"><h1>Contracts</h1><a class="btn primary" href="#/upload">Upload contract</a></div>
    <div class="row wrap" style="margin-bottom:12px"><input id="q" placeholder="Search title or vendor…" style="max-width:280px" aria-label="Search"><select id="st" style="max-width:180px" aria-label="Status"><option value="">All statuses</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('')}</select></div>
    <div class="card" id="clist"></div>`;
  render(); $('#q').oninput = render; $('#st').onchange = render;
}

// ------------------------------------------------------------------ upload
const SAMPLES = [
  ['nimbus-master-services-agreement.pdf', 'SaaS agreement (business)', 'Auto-renewal, one-sided termination, penalties, uncapped indemnity. Expires in ~20 days.'],
  ['nimbus-hosting-order-form-2024.pdf', 'Older Nimbus order form', 'Different spelling of the same vendor: try the merge prompt. Already expired.'],
  ['sunrise-apartment-lease.pdf', 'Apartment lease (customer)', 'Rent, deposit forfeiture, landlord-favouring notice. Expires in ~52 days.'],
  ['spcb-consent-to-operate.pdf', 'Pollution consent (regulatory)', 'Fee amount is in a missing schedule → low-confidence field. Expires in ~27 days.'],
];
async function pageUpload() {
  app.innerHTML = `<div class="page-head"><div><h1>Upload a contract</h1><div class="muted">PDF, PNG, JPG or WebP · up to 25 MB. You'll review everything before it's saved.</div></div></div>
    <label class="drop" id="drop" style="display:block;cursor:pointer"><div style="font-size:32px">📄</div><strong>Drop files here or click to choose</strong>
      <div class="muted small">Photos and scans need live mode (Claude API key).</div><input id="file" type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*" class="hidden"></label>
    <div id="up-status" style="margin:12px 0"></div>
    <h2 style="margin-top:24px">Try a sample</h2>
    <div class="samples">${SAMPLES.map(([f, t, d]) => `<div class="card sample"><strong>${t}</strong><span class="small muted">${d}</span><div class="row"><button class="primary" data-act="sample" data-file="${f}">Upload this</button><a class="small" href="/samples/${f}">download</a></div></div>`).join('')}</div>`;
  const drop = $('#drop');
  $('#file').onchange = (e) => uploadFiles([...e.target.files]);
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => uploadFiles([...e.dataTransfer.files]));
}
async function uploadFiles(files) {
  const st = $('#up-status'); const ids = [];
  for (const f of files) {
    st.innerHTML = `<div class="banner info">Uploading ${esc(f.name)}…</div>`;
    let q = '';
    for (;;) {
      const fd = new FormData(); fd.append('file', f);
      try { ids.push((await api('POST', '/contracts' + q, fd)).id); break; }
      catch (e) {
        if (e.status === 409 && e.data?.duplicate_of && !q && confirm(`${e.message}\n\nUpload it again anyway?`)) { q = '?allow_duplicate=1'; continue; }
        toast(`${f.name}: ${e.message}`, true); break;
      }
    }
  }
  if (ids.length === 1) location.hash = '#/contract/' + ids[0]; else if (ids.length) location.hash = '#/contracts'; else st.innerHTML = '';
}

// ------------------------------------------------------------------ vendors
async function pageVendors() {
  const vs = await api('GET', '/vendors');
  app.innerHTML = `<div class="page-head"><div><h1>Vendors</h1><div class="muted">Every counterparty and their contract history.</div></div></div>
    <div class="card">${vs.length ? `<table class="responsive"><thead><tr><th>Vendor</th><th>Also known as</th><th>Contracts</th><th>Active</th><th>Next expiry</th></tr></thead><tbody>
      ${vs.map((v) => `<tr><td><a href="#/vendor/${v.id}"><strong>${esc(v.canonical_name)}</strong></a></td><td class="small muted">${esc(v.aliases.join(', ')) || '—'}</td><td>${v.contract_count}</td><td>${v.active_count || 0}</td><td>${v.next_expiry ? fmtDate(v.next_expiry) + ' · ' + daysChip(v.next_expiry_days) : '—'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No vendors yet. They are created when you confirm a contract.</div>'}</div>`;
}
async function pageVendor(id) {
  const v = await api('GET', '/vendors/' + id);
  app.innerHTML = `<div class="page-head"><div><a class="small" href="#/vendors">← Vendors</a><h1>${esc(v.canonical_name)}</h1>${v.aliases.length ? `<div class="small muted">Also written as: ${esc(v.aliases.join(', '))}</div>` : ''}</div></div>
    <h2>Contract history <span class="muted small">(oldest first)</span></h2>
    <div class="timeline">${v.contracts.map((c) => `<div class="tl-item ${c.status === 'expired' ? 'expired' : ''}"><div class="card">
      <div class="row between wrap"><a href="#/contract/${c.id}"><strong>${esc(c.title)}</strong></a><span>${statusBadge(c.status)} ${c.open_flags ? `<span class="badge medium">⚑ ${c.open_flags}</span>` : ''}</span></div>
      <div class="small muted">${fmtDate(c.effective_date)} → ${fmtDate(c.expiration_date)} ${c.days_left != null && c.status === 'active' ? '· ' + daysChip(c.days_left) : ''} · ${TYPES[c.contract_type]}</div>
      ${c.payment_terms ? `<div class="small" style="margin-top:4px">${c.payment_terms.amount != null ? esc(`${c.payment_terms.currency || ''} ${Number(c.payment_terms.amount).toLocaleString('en-US')} · ${c.payment_terms.recurrence}`) : 'Amount not stated · ' + esc(c.payment_terms.recurrence)}</div>` : ''}
      <p class="small" style="margin:6px 0 0">${esc((c.summary_text || '').slice(0, 220))}${(c.summary_text || '').length > 220 ? '…' : ''}</p></div></div>`).join('') || '<div class="empty">No confirmed contracts for this vendor yet.</div>'}</div>`;
}

// ------------------------------------------------------------------ contract page (review / detail / source / chat)
let ed = null;
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const sameJ = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const canEdit = () => ed.editing;
const changed = (n) => !sameJ(ed.vals[n], ed.d.fields.find((f) => f.field_name === n).value);
const fieldDone = (f) => f.confidence === 'high' || ed.ackF.has(f.field_name) || changed(f.field_name);

async function pageContract(id) {
  const d = await api('GET', '/contracts/' + id);
  const c = d.contract;
  if (c.status === 'processing') {
    app.innerHTML = `<div class="card empty"><div class="spinner"></div><strong>Reading your contract…</strong><div class="small">Extracting terms, flagging risky clauses, writing a summary.</div></div>`;
    state.timer = setInterval(async () => { const x = await api('GET', '/contracts/' + id).catch(() => null); if (x && x.contract.status !== 'processing') { clearInterval(state.timer); route(); } }, 1000);
    return;
  }
  if (c.status === 'failed') {
    app.innerHTML = `<div class="banner err"><strong>Couldn't read this document.</strong><br>${esc(c.error || 'Unknown error')}</div>
      <p><a class="btn" href="#/upload">Back to upload</a> <button class="danger" data-act="delete" data-id="${c.id}">Delete this upload</button></p>`;
    return;
  }
  const chat = await api('GET', `/contracts/${id}/chat`);
  state.vendors = await api('GET', '/vendors');
  const pending = c.status === 'pending_review';
  const best = d.vendor_candidates[0];
  let vendor = d.vendor ? { id: d.vendor.id, name: d.vendor.canonical_name } : { id: null, name: c.suggested_vendor || '' };
  let autoNote = '';
  if (pending && d.vendor_mode === 'automatic' && best && best.score >= d.auto_threshold) { vendor = { id: best.id, name: best.canonical_name }; autoNote = `Automatic vendor chain linked "${c.suggested_vendor}" to existing vendor "${best.canonical_name}" (${Math.round(best.score * 100)}% match). Change it if that's wrong.`; }
  ed = {
    d, editing: pending, title: c.title || '', type: c.contract_type || 'business_class', summary: c.summary_text || '', vendor, autoNote,
    vals: Object.fromEntries(d.fields.map((f) => [f.field_name, clone(f.value)])), ackF: new Set(), ackFl: new Set(),
    resolved: Object.fromEntries(d.flags.map((f) => [f.id, f.resolved])), tab: 'source', hl: new Set(), chat, busy: false,
  };
  drawContract();
}

function fieldView(name, v) {
  if (v == null || (Array.isArray(v) && !v.length)) return '<span class="muted">Not found in the document</span>';
  if (name === 'parties') return `<ul>${v.map((p) => `<li>${esc(p.name)} <span class="muted">— ${esc(p.role)}</span></li>`).join('')}</ul>`;
  if (name === 'service_obligations') return `<ul>${v.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  if (name.endsWith('_date')) return esc(fmtDate(v));
  if (name === 'payment_terms') return `${v.amount != null ? `<strong>${esc(v.currency || '')} ${Number(v.amount).toLocaleString('en-US')}</strong>` : '<strong>Amount not stated</strong>'} · ${esc(v.recurrence)}${v.due_rule ? `<div class="small muted">${esc(v.due_rule)}</div>` : ''}`;
  return esc(v);
}
function fieldEditor(name, v) {
  const a = `data-field="${name}"`;
  if (name === 'parties') { const ps = v || []; return `${ps.map((p, i) => `<div class="party-row"><input ${a} data-i="${i}" data-k="name" value="${esc(p.name)}" placeholder="Name" aria-label="Party name"><input ${a} data-i="${i}" data-k="role" value="${esc(p.role)}" placeholder="Role" aria-label="Party role"><button data-act="party-del" data-i="${i}" aria-label="Remove party">✕</button></div>`).join('')}<button data-act="party-add" class="small">+ Add party</button>`; }
  if (name.endsWith('_date')) return `<input type="date" ${a} value="${esc(v || '')}" aria-label="${FIELD_LABELS[name]}"><div class="tiny muted">Clear the box if the document has no such date.</div>`;
  if (name === 'payment_terms') { const p = v || { amount: null, currency: null, recurrence: 'unknown', due_rule: null }; return `<div class="pay-grid">
    <input type="number" step="any" ${a} data-k="amount" value="${p.amount ?? ''}" placeholder="Amount" aria-label="Amount"><input ${a} data-k="currency" value="${esc(p.currency || '')}" placeholder="USD" aria-label="Currency">
    <select ${a} data-k="recurrence" aria-label="Recurrence">${['one-time', 'monthly', 'quarterly', 'annual', 'other', 'unknown'].map((r) => `<option ${p.recurrence === r ? 'selected' : ''}>${r}</option>`).join('')}</select>
    <input class="wide" ${a} data-k="due_rule" value="${esc(p.due_rule || '')}" placeholder="When it's due, late fees, extras…" aria-label="Due rule"></div>`; }
  if (name === 'service_obligations') return `<textarea ${a} rows="4" aria-label="Service obligations" placeholder="One obligation per line">${esc((v || []).join('\n'))}</textarea>`;
  return `<textarea ${a} rows="3" aria-label="${FIELD_LABELS[name]}">${esc(v || '')}</textarea>`;
}
function citeChips(ids) {
  const byId = Object.fromEntries(ed.d.paragraphs.map((p) => [p.id, p]));
  return ids.length ? ids.map((i) => byId[i] ? `<button class="cite" data-act="cite" data-ids="${i}" title="Show source text">📎 ${esc(refLabel(byId[i]))}</button>` : '').join(' ') : '<span class="tiny muted">no source found</span>';
}

function drawContract() {
  const { d } = ed, c = d.contract, pending = c.status === 'pending_review', edit = canEdit(), write = true;
  const q = d.vendor_candidates.filter((v) => v.id !== ed.vendor.id);
  const clean = /^(no issues|clean)/i.test(c.doc_quality || '');
  app.innerHTML = `
    <div class="page-head"><div><a class="small" href="#/contracts">← Contracts</a>
      <div class="row wrap"><h1 style="margin:0">${esc(ed.title || c.file_name)}</h1>${statusBadge(c.status)}</div>
      <div class="small muted">${esc(c.file_name)} · uploaded ${new Date(c.uploaded_at).toLocaleDateString()} · ${c.extraction_mode === 'live' ? 'read by Claude' : 'offline demo extraction'} ·
        <a href="/api/contracts/${c.id}/file" target="_blank" rel="noopener">open original file</a></div></div>
      <div class="row">${write && !pending && !ed.editing ? '<button data-act="edit">Edit details</button>' : ''}${write ? `<button class="danger" data-act="delete" data-id="${c.id}">Delete</button>` : ''}</div></div>
    ${pending ? `<div class="banner info" style="margin-bottom:12px"><strong>Review required.</strong> Nothing is saved as active until you have checked every ${CONF.low[0]} low/${CONF.medium[0]} medium-confidence field and every ⚑ flagged clause below.${!write ? ' Your role (Viewer) cannot confirm.' : ''}</div>` : ''}
    ${c.status === 'expired' ? `<div class="banner warn" style="margin-bottom:12px">This contract expired on ${fmtDate(c.expiration_date)}.</div>` : ''}
    ${!clean && c.doc_quality ? `<div class="banner warn" style="margin-bottom:12px"><strong>Document quality:</strong> ${esc(c.doc_quality)}</div>` : ''}
    ${d.regulatory_alerts.map((r) => `<div class="banner warn" style="margin-bottom:12px"><span class="badge medium">DEMO · mocked</span> <strong>${esc(r.title)}</strong> (${esc(r.authority)}, effective ${fmtDate(r.effective)}) may affect this contract: ${esc(r.summary)}</div>`).join('')}
    <div class="contract-layout"><div class="stack">
      <div class="card stack"><div class="grid cols-2">
        <div><label class="small muted" for="f-title">Contract name</label><input id="f-title" data-bind="title" value="${esc(ed.title)}" ${edit ? '' : 'disabled'}></div>
        <div><label class="small muted" for="f-type">Contract type</label><select id="f-type" data-bind="type" ${edit ? '' : 'disabled'}><option value="business_class" ${ed.type === 'business_class' ? 'selected' : ''}>Business (bills, land, loans, supply)</option><option value="regulatory_class" ${ed.type === 'regulatory_class' ? 'selected' : ''}>Regulatory (government, licences, insurance)</option></select></div></div>
        <div><label class="small muted" for="f-vendor">Vendor <span class="tiny">· ${d.vendor_mode === 'automatic' ? 'automatic' : 'manual'} vendor chain (change in Settings)</span></label>
          <input id="f-vendor" data-bind="vendor" list="vendor-list" value="${esc(ed.vendor.name)}" ${edit ? '' : 'disabled'} placeholder="Who is the other party?">
          <datalist id="vendor-list">${state.vendors.map((v) => `<option value="${esc(v.canonical_name)}">`).join('')}</datalist>
          ${ed.vendor.id ? `<div class="tiny" style="margin-top:4px"><span class="badge high">✓ linked to existing vendor</span></div>` : ''}
          ${ed.autoNote ? `<div class="tiny muted" style="margin-top:4px">${esc(ed.autoNote)}</div>` : ''}
          ${edit && q.length ? `<div class="tiny" style="margin-top:6px">Similar existing vendors: ${q.map((v) => `<button class="cite" data-act="pick-vendor" data-id="${v.id}" data-name="${esc(v.canonical_name)}">${esc(v.canonical_name)} · ${Math.round(v.score * 100)}%</button>`).join(' ')}</div>` : ''}
        </div></div>

      <div class="card"><h2>Summary <span class="muted small">(plain language)</span></h2>${edit ? `<textarea data-bind="summary" rows="7">${esc(ed.summary)}</textarea>` : `<p style="margin:0;white-space:pre-wrap">${esc(ed.summary)}</p>`}</div>

      <div class="stack"><h2 style="margin:0">⚑ Clauses to review (${d.flags.length})</h2>
        ${d.flags.map((f) => `<div class="flag ${ed.resolved[f.id] && !pending ? 'done' : ''}"><div class="row between wrap"><span class="type">${FLAG_LABELS[f.flag_type] || f.flag_type}</span>
          ${f.source ? `<button class="cite" data-act="cite" data-ids="${f.source.id}">📎 ${esc(f.source.label)}</button>` : '<span class="tiny muted">source not located</span>'}</div>
          <div style="margin:6px 0">${esc(f.description)}</div>${f.source ? `<div class="quote">“${esc(f.source.text.slice(0, 260))}${f.source.text.length > 260 ? '…' : ''}”</div>` : ''}
          ${edit && pending ? `<label class="check" style="margin-top:8px"><input type="checkbox" data-act="ack-flag" data-id="${f.id}" ${ed.ackFl.has(f.id) ? 'checked' : ''}> I've read this clause</label>` : ''}
          ${edit && !pending ? `<label class="check" style="margin-top:8px"><input type="checkbox" data-act="resolve-flag" data-id="${f.id}" ${ed.resolved[f.id] ? 'checked' : ''}> Mark as dealt with</label>` : ''}</div>`).join('') || '<div class="card empty small">No risky clauses were flagged.</div>'}</div>

      <div class="stack"><h2 style="margin:0">Extracted terms <span class="muted small">(least certain first)</span></h2>
        ${d.fields.map((f) => `<div class="field ${f.confidence}" id="field-${f.field_name}"><div class="row between wrap"><span class="label">${FIELD_LABELS[f.field_name]}</span>${confBadge(f.confidence)}</div>
          <div class="val">${edit ? fieldEditor(f.field_name, ed.vals[f.field_name]) : fieldView(f.field_name, ed.vals[f.field_name])}</div>
          <div class="row wrap between"><div>${citeChips(f.source_refs)}</div>${edit && pending && f.confidence !== 'high' ? `<label class="check"><input type="checkbox" data-act="ack-field" data-name="${f.field_name}" ${fieldDone(f) ? 'checked' : ''}> I've checked this</label>` : ''}</div>
          ${f.rationale ? `<div class="rationale" style="margin-top:6px">${esc(f.rationale)}</div>` : ''}
          ${f.was_corrected ? `<div class="orig">Corrected by a person. Original extraction: ${fieldView(f.field_name, f.extracted_value).replace(/<[^>]+>/g, ' ')}</div>` : ''}</div>`).join('')}</div>

      ${edit ? `<div class="confirm-bar"><div><div id="prog-text" class="small"></div><div class="progress" aria-hidden="true"><i id="prog-bar"></i></div></div>
        <div class="row">${!pending ? '<button data-act="cancel-edit">Cancel</button>' : ''}<button class="primary" id="btn-confirm" data-act="confirm">${pending ? 'Confirm & activate' : 'Save changes'}</button></div></div>` : ''}
    </div>
    <aside class="card side"><div class="tabs" role="tablist"><button role="tab" data-act="tab" data-tab="source" class="${ed.tab === 'source' ? 'active' : ''}">Source text</button><button role="tab" data-act="tab" data-tab="chat" class="${ed.tab === 'chat' ? 'active' : ''}">Ask about this contract</button></div>
      <div id="side-body" style="display:flex;flex-direction:column;flex:1;min-height:0"></div></aside></div>`;
  drawSide(); updateProgress();
}

function drawSide() {
  const body = $('#side-body'); if (!body) return;
  if (ed.tab === 'source') {
    body.innerHTML = `<div class="src-list">${ed.d.paragraphs.map((p) => isHeading(p) ? `<div class="para heading" id="${pid(p.id)}">${esc(p.text)}</div>` : `<div class="para ${ed.hl.has(p.id) ? 'hl' : ''}" id="${pid(p.id)}"><span class="pid">${esc(refLabel(p))}</span>${esc(p.text)}</div>`).join('')}</div>`;
    const first = [...ed.hl][0]; if (first) $('#' + pid(first))?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  const sugg = ['When does this contract expire?', 'How much do I pay and when?', 'How can this be terminated?', 'What are the biggest risks?'];
  body.innerHTML = `<div class="chat"><div class="msgs" id="msgs" aria-live="polite"></div>
    ${ed.chat.length ? '' : `<div class="chips">${sugg.map((s) => `<button data-act="ask" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>`}
    <form id="chat-form"><input id="chat-q" placeholder="Ask about a clause, date, fee…" maxlength="2000" autocomplete="off" aria-label="Question"><button class="primary" ${ed.busy ? 'disabled' : ''}>Ask</button></form>
    <div class="tiny muted" style="margin-top:6px">Answers come only from this contract and always cite the clause. Not legal advice.</div></div>`;
  drawMsgs();
  $('#chat-form').onsubmit = (e) => { e.preventDefault(); const v = $('#chat-q').value.trim(); if (v) ask(v); };
}
function drawMsgs() {
  const el = $('#msgs'); if (!el) return;
  el.innerHTML = ed.chat.map((m) => m.role === 'user' ? `<div class="msg user">${esc(m.content)}</div>` : `<div class="msg assistant">${esc(m.content)}
    <div class="meta">${m.confidence ? confBadge(m.confidence) : ''}${(m.citations || []).map((c) => `<button class="cite" data-act="cite" data-ids="${c.para_id}">📎 ${esc(c.label || c.para_id)}</button>`).join('')}</div>
    ${m.confidence === 'low' ? '<div class="tiny" style="margin-top:6px;color:var(--low)">Low confidence — check the cited clause yourself.</div>' : ''}
    ${(m.citations || []).slice(0, 2).map((c) => `<div class="quote">“${esc((c.quote || '').slice(0, 200))}”</div>`).join('')}</div>`).join('') + (ed.busy ? '<div class="msg assistant muted">Reading the contract…</div>' : '');
  el.scrollTop = el.scrollHeight;
}
async function ask(q) {
  if (ed.busy) return;
  ed.chat.push({ role: 'user', content: q }); ed.busy = true; drawSide();
  try { const r = await api('POST', `/contracts/${ed.d.contract.id}/chat`, { question: q }); ed.chat.push({ role: 'assistant', content: r.content, citations: r.citations, confidence: r.confidence }); }
  catch (e) { ed.chat.push({ role: 'assistant', content: `Sorry, that failed: ${e.message}`, confidence: 'low', citations: [] }); }
  ed.busy = false; drawSide();
}

function progress() {
  const need = ed.d.fields.filter((f) => f.confidence !== 'high'), doneF = need.filter(fieldDone).length;
  const doneFl = ed.d.flags.filter((f) => ed.ackFl.has(f.id)).length;
  return { total: need.length + ed.d.flags.length, done: doneF + doneFl };
}
function updateProgress() {
  if (!$('#prog-text')) return;
  const pending = ed.d.contract.status === 'pending_review', p = progress();
  if (!pending) { $('#prog-text').textContent = 'Editing details'; $('#prog-bar').style.width = '100%'; return; }
  $('#prog-text').textContent = p.done === p.total ? 'All items reviewed. Ready to confirm.' : `${p.total - p.done} of ${p.total} items still need your review`;
  $('#prog-bar').style.width = (p.total ? (p.done / p.total) * 100 : 100) + '%';
  $('#btn-confirm').disabled = p.done < p.total;
}

async function confirmContract(decision = {}) {
  const c = ed.d.contract, pending = c.status === 'pending_review';
  const body = {
    title: ed.title, contract_type: ed.type, summary_text: ed.summary, fields: ed.vals,
    acknowledged_fields: ed.d.fields.filter(fieldDone).map((f) => f.field_name), acknowledged_flags: [...ed.ackFl],
    flag_resolved: ed.resolved, vendor: ed.vendor.id ? { id: ed.vendor.id, name: ed.vendor.name } : { name: ed.vendor.name }, ...decision,
  };
  try {
    const r = await api('POST', `/contracts/${c.id}/confirm`, body);
    toast(pending ? `Saved and activated · vendor: ${r.vendor.canonical_name}` : 'Changes saved');
    if (r.auto_merged) toast(`Automatic vendor chain merged it into "${r.auto_merged.name}"`);
    route();
  } catch (e) {
    if (e.status === 409 && e.data?.needs_vendor_decision) vendorModal(e.data);
    else { toast(e.message, true); if (e.data?.missing_fields?.[0]) $('#field-' + e.data.missing_fields[0])?.scrollIntoView({ block: 'center' }); }
  }
}
function vendorModal(data) {
  modal(`<h2>Merge with an existing vendor?</h2><p>You entered <strong>${esc(data.entered)}</strong>. These vendors already exist and look similar:</p>
    ${data.candidates.map((v) => `<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--border)"><span>${esc(v.canonical_name)} <span class="muted small">· ${Math.round(v.score * 100)}% match</span></span><button class="primary" data-act="merge" data-id="${v.id}">Merge</button></div>`).join('')}
    <div class="row" style="margin-top:16px;justify-content:flex-end"><button data-act="close-modal">Cancel</button><button data-act="new-vendor">No, create new vendor</button></div>`);
}

// ------------------------------------------------------------------ settings
function settingsModal() {
  const s = state.session;
  modal(`<h2>Settings</h2>
    <fieldset style="border:0;padding:0;margin:0 0 14px"><legend><strong>Vendor chain</strong></legend>
      <label class="check" style="margin:6px 0"><input type="radio" name="vm" value="manual" ${s.settings.vendor_mode === 'manual' ? 'checked' : ''}><span><strong>Manual</strong> — I pick or create the vendor for each contract; I'm asked before merging similar names.</span></label>
      <label class="check" style="margin:6px 0"><input type="radio" name="vm" value="automatic" ${s.settings.vendor_mode === 'automatic' ? 'checked' : ''}><span><strong>Automatic</strong> — strong matches (85%+) are linked to the existing vendor for me. I still review before saving.</span></label></fieldset>
    <label for="aw"><strong>Reminder windows</strong> <span class="muted small">(days before expiry, comma-separated)</span></label>
    <input id="aw" value="${s.settings.alert_windows.join(', ')}">
    <p class="tiny muted">Passive: the dashboard always shows contracts inside the widest window. Active: a notification fires once per window.</p>
    <div class="row" style="justify-content:flex-end;margin-top:16px"><button data-act="close-modal">Cancel</button><button class="primary" data-act="save-settings">Save</button></div>`);
}

// ------------------------------------------------------------------ events
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]');
  if (!e.target.closest('.bell')) $('#bell-pop')?.classList.add('hidden');
  if (!t) return;
  const a = t.dataset.act;
  try {
    if (a === 'modal-bg') { if (e.target === t) closeModal(); }
    else if (a === 'close-modal') closeModal();
    else if (a === 'bell') { renderBell(); $('#bell-pop').classList.toggle('hidden'); e.stopPropagation(); }
    else if (a === 'read-all') { await api('POST', '/notifications/read-all'); await refreshNotifs(); renderBell(); $('#bell-pop').classList.remove('hidden'); }
    else if (a === 'run-reminders') { const r = await api('POST', '/reminders/run'); toast(r.created ? `${r.created} new reminder(s) sent` : 'No new reminders due'); route(); }
    else if (a === 'settings') settingsModal();
    else if (a === 'save-settings') {
      const windows = $('#aw').value.split(/[ ,]+/).filter(Boolean).map(Number);
      const body = { vendor_mode: $('input[name=vm]:checked').value }; body.alert_windows = windows;
      await api('PUT', '/settings', body); await loadSession(); closeModal(); toast('Settings saved'); route();
    }
    else if (a === 'sample') { t.disabled = true; const blob = await (await fetch('/samples/' + t.dataset.file)).blob(); await uploadFiles([new File([blob], t.dataset.file, { type: 'application/pdf' })]); t.disabled = false; }
    else if (a === 'delete') { if (confirm('Delete this contract and its file? This cannot be undone.')) { await api('DELETE', '/contracts/' + t.dataset.id); toast('Deleted'); location.hash = '#/contracts'; } }
    // contract page
    else if (a === 'edit') { ed.editing = true; drawContract(); }
    else if (a === 'cancel-edit') route();
    else if (a === 'tab') { ed.tab = t.dataset.tab; drawContract(); }
    else if (a === 'cite') { ed.hl = new Set(t.dataset.ids.split(',')); ed.tab = 'source'; document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'source')); drawSide(); }
    else if (a === 'ask') ask(t.dataset.q);
    else if (a === 'ack-flag') { t.checked ? ed.ackFl.add(Number(t.dataset.id)) : ed.ackFl.delete(Number(t.dataset.id)); updateProgress(); }
    else if (a === 'resolve-flag') ed.resolved[t.dataset.id] = t.checked;
    else if (a === 'ack-field') { t.checked ? ed.ackF.add(t.dataset.name) : ed.ackF.delete(t.dataset.name); updateProgress(); }
    else if (a === 'party-add') { (ed.vals.parties ||= []).push({ name: '', role: '' }); drawContract(); }
    else if (a === 'party-del') { ed.vals.parties.splice(Number(t.dataset.i), 1); drawContract(); }
    else if (a === 'pick-vendor') { ed.vendor = { id: Number(t.dataset.id), name: t.dataset.name }; ed.autoNote = ''; drawContract(); }
    else if (a === 'confirm') confirmContract();
    else if (a === 'merge') { closeModal(); confirmContract({ vendor_decision: 'merge', merge_id: Number(t.dataset.id) }); }
    else if (a === 'new-vendor') { closeModal(); confirmContract({ vendor_decision: 'new' }); }
  } catch (err) { toast(err.message, true); }
});

function onEdit(e) {
  const t = e.target;
  if (t.dataset.bind) { // title / type / summary / vendor
    const b = t.dataset.bind;
    if (b === 'vendor') { ed.vendor = { id: null, name: t.value }; ed.autoNote = ''; } else ed[b] = t.value;
    if (b === 'title') $('h1').textContent = t.value || ed.d.contract.file_name;
    return;
  }
  const name = t.dataset.field; if (!name || !ed) return;
  if (name === 'parties') { ed.vals.parties[Number(t.dataset.i)][t.dataset.k] = t.value; }
  else if (name === 'payment_terms') {
    const p = (ed.vals.payment_terms ||= { amount: null, currency: null, recurrence: 'unknown', due_rule: null }); const k = t.dataset.k;
    p[k] = k === 'amount' ? (t.value === '' ? null : Number(t.value)) : (t.value === '' && k !== 'recurrence' ? null : t.value);
  }
  else if (name === 'service_obligations') ed.vals[name] = t.value.split('\n').map((s) => s.trim()).filter(Boolean);
  else if (name.endsWith('_date')) ed.vals[name] = t.value || null;
  else ed.vals[name] = t.value || null;
  const box = document.querySelector(`[data-act=ack-field][data-name=${name}]`); if (box) box.checked = fieldDone(ed.d.fields.find((f) => f.field_name === name));
  updateProgress();
}
document.addEventListener('input', onEdit);
document.addEventListener('change', (e) => { if (e.target.dataset?.field === 'recurrence') onEdit(e); });
window.addEventListener('hashchange', route);

async function loadSession() { state.session = await api('GET', '/session'); }
loadSession().then(() => { if (!location.hash) location.hash = '#/'; route(); }).catch((e) => { app.innerHTML = `<div class="banner err">Could not reach the server: ${esc(e.message)}</div>`; });
