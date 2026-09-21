// DOM helpers, icons, toasts, modals, formatting. No framework.

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'marker', 'title', 'clipPath', 'pattern']);

// ---------------------------------------------------------------- smooth spinners
// Views that repaint on a timer (run/test polling, generation progress) recreate
// their .spinner nodes; a fresh node restarts the rotation from 0deg, which reads
// as a choppy, stuttering circle. Give every newly inserted spinner a negative
// animation-delay matching the current phase of the shared 0.75s cycle so a
// replacement continues exactly where the old one stopped — seamless to the eye.
const SPIN_PERIOD_MS = 750; // keep in sync with the .spinner animation-duration
if (typeof document !== 'undefined' && document.body) {
  new MutationObserver((muts) => {
    const delay = `-${Math.round(performance.now() % SPIN_PERIOD_MS)}ms`;
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (!n || n.nodeType !== 1) continue;
        if (n.classList && n.classList.contains('spinner')) n.style.animationDelay = delay;
        if (n.querySelectorAll) {
          for (const el of n.querySelectorAll('.spinner')) el.style.animationDelay = delay;
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}

/** Hyperscript: h('div', { class: 'x', onClick }, child, [children], 'text'). */
export function h(tag, attrs, ...children) {
  const svg = SVG_TAGS.has(tag);
  const el = svg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') {
      if (svg) el.setAttribute('class', v);
      else el.className = v;
    } else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
    else if (!svg && (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled' || k === 'indeterminate')) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// ------------------------------------------------------------------ icons
// Hand-drawn 24×24 stroke icons.
const I = {
  dashboard: [['rect', { x: 3, y: 3, width: 7.5, height: 7.5, rx: 1.5 }], ['rect', { x: 13.5, y: 3, width: 7.5, height: 7.5, rx: 1.5 }], ['rect', { x: 3, y: 13.5, width: 7.5, height: 7.5, rx: 1.5 }], ['rect', { x: 13.5, y: 13.5, width: 7.5, height: 7.5, rx: 1.5 }]],
  plus: ['M12 5v14', 'M5 12h14'],
  book: ['M3 5h6a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H3z', 'M21 5h-6a3 3 0 0 0-3 3v12a2 2 0 0 1 2-2h7z'],
  flask: ['M9 3h6', 'M10 3v6l-5.4 9.3A1.8 1.8 0 0 0 6.2 21h11.6a1.8 1.8 0 0 0 1.6-2.7L14 9V3', 'M7.5 15h9'],
  play: [['circle', { cx: 12, cy: 12, r: 9 }], 'M10 8.5l5.5 3.5-5.5 3.5z'],
  plug: ['M9 3v5', 'M15 3v5', 'M7 8h10v3a5 5 0 0 1-10 0z', 'M12 16v5'],
  sliders: ['M4 7h9', 'M17 7h3', ['circle', { cx: 15, cy: 7, r: 2 }], 'M4 17h3', 'M11 17h9', ['circle', { cx: 9, cy: 17, r: 2 }]],
  check: ['M5 12.5l4.5 4.5L19 7'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  alert: ['M12 3.5 2.5 20h19z', 'M12 10v4.5', 'M12 17.5v.3'],
  info: [['circle', { cx: 12, cy: 12, r: 9 }], 'M12 11v5.5', 'M12 7.6v.3'],
  copy: [['rect', { x: 8, y: 8, width: 12, height: 12, rx: 2 }], 'M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
  upload: ['M12 20V9', 'M7 14l5-5 5 5', 'M5 4h14'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'M9 13h6', 'M9 17h6'],
  code: ['M9 8l-4 4 4 4', 'M15 8l4 4-4 4'],
  maximize: ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'],
  minimize: ['M9 4v5H4', 'M15 4v5h5', 'M9 20v-5H4', 'M15 20v-5h5'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', ['circle', { cx: 12, cy: 12, r: 3 }]],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'M14 6l4 4'],
  refresh: ['M20 11a8 8 0 0 0-14.3-4.3L4 8', 'M4 4v4h4', 'M4 13a8 8 0 0 0 14.3 4.3L20 16', 'M20 20v-4h-4'],
  send: ['M4 12 20 4l-6 16-3-7z', 'M11 13l9-9'],
  sparkles: ['M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z', 'M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z'],
  workflow: [['rect', { x: 3, y: 3, width: 7, height: 5, rx: 1.2 }], ['rect', { x: 14, y: 16, width: 7, height: 5, rx: 1.2 }], ['rect', { x: 14, y: 3, width: 7, height: 5, rx: 1.2 }], 'M6.5 8v5.5a2.5 2.5 0 0 0 2.5 2.5h5', 'M10 5.5h4'],
  list: ['M9 6h11', 'M9 12h11', 'M9 18h11', 'M4.5 6h.01', 'M4.5 12h.01', 'M4.5 18h.01'],
  clock: [['circle', { cx: 12, cy: 12, r: 9 }], 'M12 7v5l3 2'],
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'],
  shieldCheck: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', 'M8.5 12l2.5 2.5 4.5-5'],
  zap: ['M13 2 4 14h7l-1 8 9-12h-7z'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  search: [['circle', { cx: 11, cy: 11, r: 7 }], 'M20 20l-4-4'],
  sun: [['circle', { cx: 12, cy: 12, r: 4 }], 'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'],
  moon: ['M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z'],
  monitor: [['rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 }], 'M8 20h8', 'M12 16v4'],
  arrowLeft: ['M19 12H5', 'M11 6l-6 6 6 6'],
  arrowRight: ['M5 12h14', 'M13 6l6 6-6 6'],
  more: [['circle', { cx: 5, cy: 12, r: 1.2 }], ['circle', { cx: 12, cy: 12, r: 1.2 }], ['circle', { cx: 19, cy: 12, r: 1.2 }]],
  flag: ['M5 21V4', 'M5 4h11l-2 4 2 4H5'],
  history: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5', 'M12 7v5l3 2'],
  target: [['circle', { cx: 12, cy: 12, r: 9 }], ['circle', { cx: 12, cy: 12, r: 5 }], ['circle', { cx: 12, cy: 12, r: 1.2 }]],
  database: ['M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z', 'M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6', 'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  wrench: ['M15 4a5 5 0 0 0-4.6 7L4 17.4 6.6 20 13 13.6A5 5 0 0 0 20 9l-3 1-3-3z'],
  lock: [['rect', { x: 5, y: 11, width: 14, height: 10, rx: 2 }], 'M8 11V7a4 4 0 0 1 8 0v4'],
  key: [['circle', { cx: 8, cy: 15, r: 4 }], 'M11 12l9-9', 'M17 6l3 3', 'M14.5 8.5l2 2'],
  user: [['circle', { cx: 12, cy: 8, r: 4 }], 'M4 21a8 8 0 0 1 16 0'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  chevronDown: ['M6 9l6 6 6-6'],
  chevronRight: ['M9 6l6 6-6 6'],
  ban: [['circle', { cx: 12, cy: 12, r: 9 }], 'M5.6 5.6l12.8 12.8'],
  compare: ['M7 7h13', 'M17 3l4 4-4 4', 'M17 17H4', 'M7 13l-4 4 4 4'],
  bug: ['M8 8V6a4 4 0 0 1 8 0v2', 'M6 8h12v5a6 6 0 0 1-12 0z', 'M3 9l3 2', 'M21 9l-3 2', 'M3 19l3-2', 'M21 19l-3-2', 'M2 14h4', 'M18 14h4', 'M12 12v8'],
  circleCheck: [['circle', { cx: 12, cy: 12, r: 9 }], 'M8 12.5l3 3 5-6'],
  circleX: [['circle', { cx: 12, cy: 12, r: 9 }], 'M9 9l6 6', 'M15 9l-6 6'],
  skip: ['M5 5l8 7-8 7z', 'M17 5v14'],
  pending: [['circle', { cx: 12, cy: 12, r: 9 }], ['circle', { cx: 12, cy: 12, r: 2 }]],
  rocket: ['M12 15l-3-3c1.5-4.5 5-8 11-9-1 6-4.5 9.5-9 11z', 'M9 12H5l2-4h4', 'M12 15v4l4-2v-4', 'M5 19c1-2 3-3 4-3'],
  cpu: [['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }], ['rect', { x: 9.5, y: 9.5, width: 5, height: 5 }], 'M9 2v4', 'M15 2v4', 'M9 18v4', 'M15 18v4', 'M2 9h4', 'M2 15h4', 'M18 9h4', 'M18 15h4'],
  message: ['M4 5h16v11H9l-5 4z'],
  pause: ['M9 5v14', 'M15 5v14'],
  logo: ['M12 3 4 7.5v9L12 21l8-4.5v-9z', 'M4 7.5l8 4.5 8-4.5', 'M12 12v9'],
  folder: ['M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z'],
  folderOpen: ['M3 17.5V6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h7.5A1.5 1.5 0 0 1 20 8.5V10', 'M3 17.5 5.6 11a1.5 1.5 0 0 1 1.4-1h13.2a1 1 0 0 1 .9 1.4L18.6 18a1.5 1.5 0 0 1-1.4 1H4.5A1.5 1.5 0 0 1 3 17.5z'],
  package: ['M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z', 'M3 7.5l9 4.5 9-4.5', 'M12 12v9', 'M7.5 5.25l9 4.5'],
};

export function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icon ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  for (const part of I[name] || I.info) {
    if (typeof part === 'string') {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', part);
      svg.appendChild(p);
    } else {
      const [tag, attrs] = part;
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.appendChild(el);
    }
  }
  return svg;
}

// ------------------------------------------------------------------ formatting

export const pct = (v, digits = 0) => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(digits).replace(/\.0+$/, '')}%` : '—');
export const title = (s) => String(s ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
export const upper = (s) => String(s ?? '').toUpperCase();

export function ago(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return d.toLocaleDateString();
}

export function when(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function duration(ms) {
  if (typeof ms !== 'number') return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
}

export function money(v) {
  if (typeof v !== 'number') return '—';
  if (v === 0) return '$0';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(3)}`;
}

export function compactJson(v, max = 120) {
  const s = JSON.stringify(v);
  if (s === undefined) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ------------------------------------------------------------------ status badges

const STATUS_LABEL = {
  pass: 'PASS',
  warning: 'WARNING',
  fail: 'FAIL',
  passed: 'Passed',
  failed: 'Failed',
  draft: 'Draft',
  testing: 'Testing',
  published: 'Published',
  production: 'Production',
  completed: 'Completed',
  running: 'Running',
  needs_input: 'Needs input',
  awaiting_approval: 'Awaiting approval',
  cancelled: 'Cancelled',
  error: 'Error',
  skipped: 'Skipped',
  simulated: 'Simulated',
  inconclusive: 'INCONCLUSIVE',
  ok: 'Connected',
  untested: 'Untested',
};

export function badge(status, label, extraClass = '') {
  const icons = { pass: 'check', passed: 'check', completed: 'check', ok: 'check', fail: 'x', failed: 'x', error: 'x', warning: 'alert', production: 'zap', published: 'flag', running: null, testing: null, awaiting_approval: 'clock', needs_input: 'alert' };
  const ic = icons[status];
  return h('span', { class: `badge ${status || ''} ${extraClass}`.trim() }, ic ? icon(ic) : status === 'running' || status === 'testing' ? h('span', { class: 'spinner', style: { width: '10px', height: '10px', borderWidth: '2px' } }) : null, label || STATUS_LABEL[status] || title(status));
}

export function versionBadge(v) {
  return h('span', { class: 'badge outline' }, `v${v}`);
}

// ------------------------------------------------------------------ layout helpers

export function pageHead({ title: t, subtitle, actions = [], crumbs = null, badges = [] }) {
  return h(
    'div',
    { class: 'page-head' },
    h('div', null, crumbs, h('div', { class: 'title-row' }, h('h1', null, t), ...badges), subtitle ? h('div', { class: 'subtitle' }, subtitle) : null),
    actions.length ? h('div', { class: 'actions' }, actions) : null,
  );
}

export function card({ title: t, icon: ic, actions = [], body, hint, tight = false, cls = '' }) {
  return h(
    'section',
    { class: `card ${cls}` },
    t ? h('div', { class: 'card-head' }, h('h2', null, ic ? icon(ic) : null, t), hint ? h('span', { class: 'hint' }, hint) : null, actions.length ? h('div', { class: 'row' }, actions) : null) : null,
    h('div', { class: `card-body ${tight ? 'tight' : ''}` }, body),
  );
}

export function button(label, { onClick, kind = '', size = '', ic, title: tip, disabled, type = 'button', href } = {}) {
  const cls = `btn ${kind} ${size} ${!label && ic ? 'icon-only' : ''}`.trim();
  if (href) return h('a', { class: cls, href, title: tip, target: href.startsWith('http') || href.startsWith('/api/') ? '_blank' : null, rel: 'noopener' }, ic ? icon(ic) : null, label);
  return h('button', { class: cls, type, onClick, title: tip || (label ? null : tip), 'aria-label': tip || label || null, disabled }, ic ? icon(ic) : null, label);
}

export function banner(kind, titleText, text, actions = []) {
  const ic = { warn: 'alert', fail: 'circleX', pass: 'circleCheck', info: 'info', accent: 'sparkles' }[kind] || 'info';
  return h('div', { class: `banner ${kind}` }, icon(ic), h('div', { class: 'banner-body' }, titleText ? h('div', { class: 'banner-title' }, titleText) : null, text ? h('div', { class: 'small text-2' }, text) : null), actions.length ? h('div', { class: 'row' }, actions) : null);
}

export function empty(ic, titleText, text, action) {
  return h('div', { class: 'empty' }, icon(ic), h('div', { class: 'empty-title' }, titleText), text ? h('div', { class: 'small mt-1' }, text) : null, action ? h('div', { class: 'mt-2' }, action) : null);
}

export function loading(text = 'Loading…') {
  return h('div', { class: 'loading-page' }, h('span', { class: 'spinner lg' }), text);
}

export function toggle(checked, onChange, { label, disabled } = {}) {
  const input = h('input', { type: 'checkbox', checked, disabled, 'aria-label': label || null, onChange: (e) => onChange(e.target.checked, e) });
  return h('label', { class: 'toggle' }, input, h('span', { class: 'track' }));
}

export function segmented(options, value, onChange) {
  const wrap = h('div', { class: 'segmented', role: 'tablist' });
  const render = (v) => {
    clear(wrap);
    for (const o of options) {
      wrap.appendChild(
        h('button', { type: 'button', class: o.value === v ? 'active' : '', role: 'tab', 'aria-selected': String(o.value === v), onClick: () => { render(o.value); onChange(o.value); } }, o.icon ? icon(o.icon) : null, o.label),
      );
    }
  };
  render(value);
  return wrap;
}

export function kv(rows) {
  return h('dl', { class: 'kv' }, rows.filter(Boolean).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v === undefined || v === null || v === '' ? h('span', { class: 'muted' }, '—') : v)]));
}

/** Dropdown menu button. items: [{ label, icon, onClick, danger, href }] | 'sep'. */
export function menu(trigger, items) {
  const wrap = h('div', { class: 'menu' });
  let list = null;
  const close = () => {
    if (list) list.remove();
    list = null;
    document.removeEventListener('click', onDoc, true);
  };
  const onDoc = (e) => {
    if (!wrap.contains(e.target)) close();
  };
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (list) return close();
    list = h(
      'div',
      { class: 'menu-list', role: 'menu' },
      items.filter(Boolean).map((it) =>
        it === 'sep'
          ? h('div', { class: 'menu-sep' })
          : it.href
            ? h('a', { href: it.href, target: it.href.startsWith('/api/') ? '_blank' : null, class: it.danger ? 'danger' : '', onClick: close }, it.icon ? icon(it.icon) : null, it.label)
            : h('button', { type: 'button', class: it.danger ? 'danger' : '', disabled: it.disabled, onClick: () => { close(); it.onClick && it.onClick(); } }, it.icon ? icon(it.icon) : null, it.label),
      ),
    );
    wrap.appendChild(list);
    setTimeout(() => document.addEventListener('click', onDoc, true));
  });
  wrap.appendChild(trigger);
  return wrap;
}

// ------------------------------------------------------------------ toasts & modals

let toastHost = null;
export function toast(message, kind = 'ok', ms = 3600) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const t = h('div', { class: `toast ${kind === 'error' ? 'error' : ''}` }, icon(kind === 'error' ? 'alert' : 'check'), h('div', null, message));
  toastHost.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

export function errorMessage(err) {
  if (!err) return 'Something went wrong.';
  return err.message || String(err);
}

export function modal({ title: t, body, actions = [], wide = false, onClose }) {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const dialog = h(
    'div',
    { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': t },
    h('div', { class: 'modal-head' }, h('h2', null, t), button('', { ic: 'x', kind: 'ghost', size: 'sm', title: 'Close', onClick: close })),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-foot' }, actions.map((a) => (a instanceof Node ? a : button(a.label, { kind: a.kind, ic: a.icon, onClick: () => a.onClick(close) })))) : null,
  );
  backdrop.appendChild(dialog);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
  const focusable = dialog.querySelector('textarea, input, select, button.primary');
  if (focusable) setTimeout(() => focusable.focus(), 30);
  return { close, dialog };
}

export function confirmDialog({ title: t, text, confirm = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title: t,
      body: h('p', { style: { margin: 0 } }, text),
      onClose: () => {
        if (!done) resolve(false);
      },
      actions: [
        { label: 'Cancel', onClick: (close) => close() },
        {
          label: confirm,
          kind: danger ? 'danger solid' : 'primary',
          onClick: (close) => {
            done = true;
            close();
            resolve(true);
          },
        },
      ],
    });
    return m;
  });
}

// ------------------------------------------------------------------ clipboard & files

export async function copyText(text, label = 'Copied to clipboard') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(label);
}

/** Read a browser File as base64 (for uploads through the JSON API). */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('The file could not be read.'));
    reader.onload = () => {
      const s = String(reader.result || '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function formatBytes(n) {
  if (typeof n !== 'number') return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function downloadText(text, filename, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------------ JSON view

export function jsonView(value, { cls = '' } = {}) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const pre = h('pre', { class: `code ${cls}` });
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let last = 0;
  let m;
  const src = text === undefined ? 'undefined' : text;
  while ((m = re.exec(src))) {
    if (m.index > last) pre.appendChild(document.createTextNode(src.slice(last, m.index)));
    let cls2 = 'j-num';
    if (m[1]) cls2 = m[2] ? 'j-key' : 'j-str';
    else if (m[3]) cls2 = 'j-bool';
    else if (m[0] === 'null') cls2 = 'j-null';
    pre.appendChild(h('span', { class: cls2 }, m[1] ? m[1] : m[0]));
    if (m[2]) pre.appendChild(document.createTextNode(m[2]));
    last = m.index + m[0].length;
  }
  if (last < src.length) pre.appendChild(document.createTextNode(src.slice(last)));
  return pre;
}

/** Textarea that validates JSON on input. Returns { el, get(): value | throws }. */
export function jsonEditor(value, { rows = 12, onChange } = {}) {
  const ta = h('textarea', { class: 'input code', rows, spellcheck: 'false' });
  ta.value = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const msg = h('div', { class: 'xsmall muted' }, 'Valid JSON');
  const validate = () => {
    try {
      JSON.parse(ta.value || 'null');
      ta.classList.remove('invalid');
      msg.textContent = 'Valid JSON';
      msg.style.color = '';
      return true;
    } catch (err) {
      ta.classList.add('invalid');
      msg.textContent = err.message;
      msg.style.color = 'var(--fail)';
      return false;
    }
  };
  ta.addEventListener('input', () => {
    validate();
    if (onChange) onChange();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ta.selectionStart;
      ta.setRangeText('  ', s, ta.selectionEnd, 'end');
    }
  });
  return {
    el: h('div', { class: 'field' }, ta, msg),
    textarea: ta,
    get() {
      return JSON.parse(ta.value || 'null');
    },
    set(v) {
      ta.value = JSON.stringify(v, null, 2);
      validate();
    },
    valid: validate,
  };
}

export const STEP_COLORS = {
  input: 'var(--t-input)',
  retrieve: 'var(--t-input)',
  validate: 'var(--t-validate)',
  transform: 'var(--t-transform)',
  calculate: 'var(--t-transform)',
  decision: 'var(--t-decision)',
  action: 'var(--t-action)',
  notify: 'var(--t-action)',
  approval: 'var(--t-approval)',
  generate: 'var(--t-generate)',
  output: 'var(--t-output)',
  wait: 'var(--t-transform)',
  task: 'var(--t-transform)',
};
