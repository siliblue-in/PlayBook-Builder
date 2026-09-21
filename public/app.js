// App shell: navigation (spec §55), hash router, theme/appearance (§54).
import { api } from './api.js';
import { h, icon, clear, loading, banner, errorMessage, button } from './ui.js';
import { bootWatch } from './bg-tasks.js';

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', href: '#/' },
  { id: 'create', label: 'Create Playbook', icon: 'sparkles', href: '#/create' },
  { id: 'playbooks', label: 'Playbooks', icon: 'book', href: '#/playbooks' },
  { id: 'test-center', label: 'Test Center', icon: 'flask', href: '#/test-center' },
  { id: 'runs', label: 'Runs', icon: 'play', href: '#/runs' },
  { id: 'connections', label: 'AI Connections', icon: 'plug', href: '#/connections' },
  { id: 'settings', label: 'Settings', icon: 'sliders', href: '#/settings' },
];

const ROUTES = [
  { re: /^\/?$/, nav: 'dashboard', load: () => import('./views/dashboard.js') },
  { re: /^\/dashboard$/, nav: 'dashboard', load: () => import('./views/dashboard.js') },
  { re: /^\/create(?:\/([\w-]+))?$/, nav: 'create', load: () => import('./views/create.js') },
  { re: /^\/playbooks$/, nav: 'playbooks', load: () => import('./views/playbooks.js') },
  { re: /^\/playbooks\/([\w-]+)(?:\/([\w-]+))?$/, nav: 'playbooks', load: () => import('./views/playbook.js') },
  { re: /^\/test-center$/, nav: 'test-center', load: () => import('./views/testcenter.js') },
  { re: /^\/test-runs\/([\w-]+)$/, nav: 'test-center', load: () => import('./views/testrun.js') },
  { re: /^\/runs$/, nav: 'runs', load: () => import('./views/runs.js') },
  { re: /^\/runs\/([\w-]+)$/, nav: 'runs', load: () => import('./views/run.js') },
  { re: /^\/connections$/, nav: 'connections', load: () => import('./views/connections.js') },
  { re: /^\/connections\/local$/, nav: 'connections', load: () => import('./views/connections-local.js') },
  { re: /^\/settings$/, nav: 'settings', load: () => import('./views/settings.js') },
];

const app = {
  settings: null,
  meta: null,
  aiStatus: null,
  navigate(path) {
    if (location.hash === `#${path}`) route();
    else location.hash = path;
  },
  async refreshSettings() {
    app.settings = await api.get('/api/settings');
    applyAppearance(app.settings.appearance);
    return app.settings;
  },
  async refreshStatus() {
    try {
      const c = await api.get('/api/connections');
      app.aiStatus = c.status;
      renderConnPill();
    } catch { /* offline */ }
    return app.aiStatus;
  },
  feature(name) {
    return Boolean(app.settings && app.settings.features[name]);
  },
};

const media = window.matchMedia('(prefers-color-scheme: dark)');
function applyAppearance(a) {
  if (!a) return;
  const root = document.documentElement;
  const dark = a.theme === 'dark' || (a.theme === 'system' && media.matches);
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  root.setAttribute('data-compact', String(Boolean(a.compact_mode)));
  root.setAttribute('data-reduced-motion', String(Boolean(a.reduced_motion)));
  root.setAttribute('data-advanced', String(Boolean(a.show_advanced_controls)));
  document.body.classList.toggle('hide-cost', !a.show_cost_information);
  try {
    localStorage.setItem('pbai-theme', a.theme);
  } catch { /* storage unavailable */ }
}
media.addEventListener('change', () => app.settings && applyAppearance(app.settings.appearance));

let shell;
let main;
let navEls = {};
let connPill;
let cleanup = null;
let routeToken = 0;

function renderShell(root) {
  navEls = {};
  const nav = NAV.map((n) => {
    const a = h('a', { class: 'nav-item', href: n.href }, icon(n.icon), n.label);
    navEls[n.id] = a;
    return a;
  });
  connPill = h('a', { class: 'conn-pill', href: '#/connections' });
  const sidebar = h(
    'aside',
    { class: 'sidebar', 'aria-label': 'Main navigation' },
    h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark' }, (() => { const i = icon('logo'); i.style.color = '#fff'; i.style.width = '19px'; i.style.height = '19px'; return i; })()), h('span', null, h('div', { class: 'brand-name' }, 'Playbook Builder'), h('div', { class: 'brand-sub' }, 'for AI'))),
    h('nav', null, nav.slice(0, 2), h('div', { class: 'nav-section' }, 'Library'), nav.slice(2, 5), h('div', { class: 'nav-section' }, 'Setup'), nav.slice(5)),
    // Navigation → flexible space → connection → version → Powered By SiliBlue.in
    h('div', { class: 'sidebar-status' }, connPill),
    h(
      'div',
      { class: 'sidebar-footer' },
      // The version comes from the server (package.json) — never hard-coded here.
      h('div', { class: 'app-version', title: 'Playbook Builder version' }, app.meta ? `v${app.meta.version}` : ''),
      h(
        'a',
        { class: 'powered-by', href: 'https://siliblue.in', target: '_blank', rel: 'noopener', 'aria-label': 'Powered By SiliBlue.in' },
        h('span', { class: 'powered-by-label' }, 'Powered By'),
        h('span', { class: 'powered-by-name' }, 'SiliBlue.in'),
      ),
    ),
  );
  main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  // Collapsed sidebar (narrow windows): keep the brand visible in the top bar.
  const mobile = h(
    'div',
    { class: 'mobile-bar' },
    button('', { ic: 'menu', kind: 'ghost', size: 'sm', title: 'Menu', onClick: () => shell.classList.toggle('nav-open') }),
    h('span', { class: 'mobile-title' }, 'Playbook Builder'),
    h('a', { class: 'brand-compact', href: 'https://siliblue.in', target: '_blank', rel: 'noopener', title: 'Powered By SiliBlue.in' }, h('span', { class: 'brand-compact-long' }, 'SiliBlue.in'), h('span', { class: 'brand-compact-short' }, 'SB')),
  );
  shell = h('div', { class: 'shell' }, sidebar, h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' } }, mobile, main));
  sidebar.addEventListener('click', (e) => {
    if (e.target.closest('a')) shell.classList.remove('nav-open');
  });
  clear(root).appendChild(shell);
  renderConnPill();
}

function renderConnPill() {
  if (!connPill) return;
  clear(connPill);
  const s = app.aiStatus;
  if (!s || !s.configured) {
    connPill.append(h('span', { class: 'dot warn' }), h('span', null, 'No AI connection'));
  } else {
    const ok = s.connection.status === 'ok';
    connPill.append(h('span', { class: `dot ${ok ? 'ok' : s.connection.status === 'error' ? 'err' : 'warn'}` }), h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${s.connection.provider_label} · ${s.roles.generation || 'no model'}`));
  }
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(qs || '')) };
}

async function route() {
  const token = ++routeToken;
  const { path, query } = parseHash();
  const r = ROUTES.find((x) => x.re.test(path));
  if (cleanup) {
    try {
      cleanup();
    } catch { /* ignore */ }
    cleanup = null;
  }
  for (const [id, el] of Object.entries(navEls)) el.classList.toggle('active', Boolean(r && r.nav === id));
  clear(main).appendChild(h('div', { class: 'page' }, loading()));
  main.scrollTop = 0;
  if (!r) {
    clear(main).appendChild(h('div', { class: 'page' }, banner('warn', 'Page not found', `Nothing lives at ${path}.`, [button('Go to Dashboard', { href: '#/' })])));
    return;
  }
  try {
    const mod = await r.load();
    if (token !== routeToken) return;
    const params = (r.re.exec(path) || []).slice(1);
    const container = h('div', { class: 'page' });
    clear(main).appendChild(container);
    const result = await mod.render(container, { params, query, app, path });
    if (token !== routeToken) {
      if (typeof result === 'function') result();
      return;
    }
    cleanup = typeof result === 'function' ? result : null;
    const heading = container.querySelector('h1');
    document.title = heading ? `${heading.textContent} · Playbook Builder` : 'Playbook Builder for AI';
  } catch (err) {
    if (token !== routeToken) return;
    console.error(err);
    clear(main).appendChild(h('div', { class: 'page' }, banner('fail', 'This page could not be loaded', errorMessage(err), [button('Retry', { onClick: route })])));
  }
}

async function boot() {
  const root = document.getElementById('app');
  try {
    [app.settings, app.meta] = await Promise.all([api.get('/api/settings'), api.get('/api/meta')]);
  } catch (err) {
    clear(root).appendChild(h('div', { class: 'page' }, banner('fail', 'Cannot reach the Playbook Builder server', `${errorMessage(err)} Start it with "npm run launch" (or "npm start") in the Playbook Builder folder, then reload.`)));
    return;
  }
  applyAppearance(app.settings.appearance);
  renderShell(root);
  app.refreshStatus();
  // A playbook generation that survived a page reload re-attaches here: the
  // corner card reappears on any page while the server keeps compiling.
  bootWatch();
  window.addEventListener('hashchange', route);
  route();
}

boot();

export { app };
