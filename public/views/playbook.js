// Playbook detail (spec §55–§60): header, version switcher, lifecycle actions
// and the tab set Overview · Requirements · Workflow · Inputs · Dependencies ·
// Tools · Tests · Runs · Versions · Export.
import { api } from '../api.js';
import { h, icon, clear, button, badge, banner, menu, toast, errorMessage, confirmDialog, title, modal } from '../ui.js';
import { openJsonEditor } from './tabs/workflow.js';

export const TABS = [
  ['overview', 'Overview', 'target'],
  ['requirements', 'Requirements', 'list'],
  ['workflow', 'Workflow', 'workflow'],
  ['inputs', 'Inputs', 'database'],
  ['dependencies', 'Dependencies', 'link'],
  ['tools', 'Tools', 'wrench'],
  ['tests', 'Tests', 'flask'],
  ['runs', 'Runs', 'play'],
  ['versions', 'Versions', 'history'],
  ['export', 'Export', 'download'],
  ['files', 'Files', 'folder'],
];

const LOADERS = {
  overview: () => import('./tabs/overview.js'),
  requirements: () => import('./tabs/requirements.js'),
  workflow: () => import('./tabs/workflow.js'),
  inputs: () => import('./tabs/inputs.js'),
  dependencies: () => import('./tabs/dependencies.js'),
  tools: () => import('./tabs/tools.js'),
  tests: () => import('./tabs/tests.js'),
  runs: () => import('./tabs/runs.js'),
  versions: () => import('./tabs/versions.js'),
  export: () => import('./tabs/export.js'),
  files: () => import('./tabs/files.js'),
};

export async function render(el, { params, query, app }) {
  const id = params[0];
  const tab = LOADERS[params[1]] ? params[1] : 'overview';
  const requested = query.v ? Number(query.v) : undefined;
  let view = await api.get(`/api/playbooks/${id}${requested ? `?version=${requested}` : ''}`);
  const cleanups = [];

  const go = (t = tab, v = view.version.version, extra = '') => {
    const q = v && v !== view.current_version ? `?v=${v}${extra ? `&${extra}` : ''}` : extra ? `?${extra}` : '';
    app.navigate(`/playbooks/${id}/${t}${q}`);
  };

  const ctx = {
    app,
    id,
    tab,
    query,
    get view() {
      return view;
    },
    get pb() {
      return view.playbook;
    },
    get version() {
      return view.version.version;
    },
    get editable() {
      return view.version.editable;
    },
    go,
    onCleanup(fn) {
      cleanups.push(fn);
    },
    /** Reload the view; switch to another version/tab if given. */
    async reload({ version, tab: t } = {}) {
      if (version !== undefined || t !== undefined) {
        go(t || tab, version !== undefined ? version : view.version.version);
        return;
      }
      view = await api.get(`/api/playbooks/${id}?version=${view.version.version}`);
      paint();
    },
    /** After a save that may have created a new version. */
    afterSave(res, message) {
      const s = res && res.saved;
      if (s && s.created_new_version) {
        toast(`${message || 'Saved'} as new version v${s.version}`);
        go(tab, s.version);
      } else {
        toast(message || 'Saved');
        view = res;
        paint();
      }
    },
  };

  const header = h('div');
  const banners = h('div');
  const tabsBar = h('nav', { class: 'tabs', 'aria-label': 'Playbook sections' });
  const content = h('div');
  el.append(header, banners, tabsBar, content);

  async function publish() {
    const v = view.version.version;
    const check = view.publish_check;
    if (check.blockers && check.blockers.length) {
      modal({ title: `Publish v${v}`, body: h('div', null, h('p', { style: { marginTop: 0 } }, 'This version cannot be published yet:'), h('ul', { class: 'bullets' }, check.blockers.map((b) => h('li', null, b)))), actions: [{ label: 'Close', onClick: (c) => c() }, { label: 'Go to Tests', kind: 'primary', onClick: (c) => { c(); go('tests'); } }] });
      return;
    }
    let ack = false;
    if (check.needs_acknowledgement) {
      ack = await confirmDialog({ title: `Publish v${v} with warnings?`, text: `${check.warnings.join(' ')} Published versions are immutable; later edits create a new version.`, confirm: 'Publish anyway' });
      if (!ack) return;
    } else if (!(await confirmDialog({ title: `Publish v${v}?`, text: 'Published versions are immutable. Any later edit creates a new draft version, and the published one keeps running.', confirm: 'Publish' }))) return;
    try {
      view = await api.post(`/api/playbooks/${id}/publish`, { version: v, acknowledge_warnings: ack });
      toast(`v${v} published`);
      paint();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function promote() {
    const v = view.version.version;
    if (!(await confirmDialog({ title: `Promote v${v} to production?`, text: 'Scheduled, webhook and default runs will use this version. The previous production version stays published.', confirm: 'Promote' }))) return;
    try {
      view = await api.post(`/api/playbooks/${id}/promote`, { version: v });
      toast(`v${v} is now in production`);
      paint();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  function paintHeader() {
    const v = view.version;
    const versionSelect = h(
      'select',
      { class: 'input sm', style: { width: 'auto' }, 'aria-label': 'Version', onChange: (e) => go(tab, Number(e.target.value)) },
      view.versions.map((x) => h('option', { value: x.version, selected: x.version === v.version }, `v${x.version} · ${title(x.status)}${x.version === view.production_version ? ' (production)' : ''}${x.version === view.current_version ? ' · current' : ''}`)),
    );
    const moreItems = [
      { label: 'Duplicate', icon: 'copy', onClick: async () => { const r = await api.post(`/api/playbooks/${id}/duplicate`); toast('Duplicated into its own workspace folder'); app.navigate(`/playbooks/${r.id}`); } },
      { label: 'Download Playbook Package (.zip)', icon: 'package', href: `/api/playbooks/${id}/package` },
      v.version !== view.current_version ? { label: `Restore v${v.version} as a new draft`, icon: 'history', onClick: async () => { const r = await api.post(`/api/playbooks/${id}/restore`, { version: v.version }); toast(`Restored as v${r.version.version}`); go(tab, r.version.version); } } : null,
      view.example_key ? 'sep' : null,
      view.example_key
        ? {
            label: 'Demo: introduce the boundary bug (>= → >)',
            icon: 'bug',
            onClick: async () => {
              try {
                const r = await api.post(`/api/playbooks/${id}/demo/break`);
                toast(`Created v${r.version.version} with rule_01 changed to >. Run the tests to catch it.`);
                go('tests', r.version.version);
              } catch (err) {
                toast(errorMessage(err), 'error');
              }
            },
          }
        : null,
      'sep',
      { label: view.archived ? 'Unarchive' : 'Archive', icon: 'book', onClick: async () => { await api.patch(`/api/playbooks/${id}`, { archived: !view.archived }); toast(view.archived ? 'Unarchived' : 'Archived'); ctx.reload(); } },
      {
        label: 'Delete playbook',
        icon: 'trash',
        danger: true,
        onClick: async () => {
          if (!(await confirmDialog({ title: 'Delete this playbook?', text: `All versions, the test suite and the playbook's workspace folder${view.workspace ? ` "${view.workspace.folder}"` : ''} (inputs, executions, results and exports) are deleted. Download the playbook package from the Files tab first if you want to keep a copy.`, confirm: 'Delete', danger: true }))) return;
          await api.del(`/api/playbooks/${id}`);
          toast('Playbook deleted');
          app.navigate('/playbooks');
        },
      },
    ];
    const exportMenu = menu(button('Export', { ic: 'download' }), [
      app.feature('markdown_export') ? { label: 'Download Markdown (.md)', icon: 'file', href: `/api/playbooks/${id}/markdown?version=${v.version}&download=1` } : null,
      app.feature('pdf_export') ? { label: 'Download PDF', icon: 'file', href: `/api/playbooks/${id}/pdf?version=${v.version}&download=1` } : null,
      app.feature('json_export') ? { label: 'Download JSON', icon: 'code', href: `/api/playbooks/${id}/json?version=${v.version}&download=1` } : null,
      'sep',
      { label: 'Open Export tab', icon: 'eye', onClick: () => go('export') },
    ]);
    const lifecycleAction = v.status === 'published'
      ? button('Promote to production', { kind: 'primary', ic: 'zap', onClick: promote })
      : v.status === 'production'
        ? null
        : button('Publish', { kind: view.publish_check.can_publish ? 'primary' : '', ic: 'flag', onClick: publish, title: view.publish_check.can_publish ? 'Publish this version' : view.publish_check.blockers.join(' ') });
    clear(header).append(
      h(
        'div',
        { class: 'page-head' },
        h(
          'div',
          null,
          h('div', { class: 'crumbs' }, h('a', { href: '#/playbooks' }, 'Playbooks'), icon('chevronRight'), h('span', null, view.name)),
          h('div', { class: 'title-row' }, h('h1', null, view.name), badge(v.status), view.example_key ? h('span', { class: 'badge accent' }, 'Built-in example') : null, view.archived ? h('span', { class: 'badge outline' }, 'Archived') : null),
          h('div', { class: 'subtitle' }, view.playbook.objective),
        ),
        h('div', { class: 'actions' }, versionSelect, button('Edit', { ic: 'edit', title: v.immutable ? 'Published versions are immutable — saving creates a new version' : 'Edit the playbook JSON', onClick: () => openJsonEditor(ctx) }), button('Test', { ic: 'flask', onClick: () => go('tests') }), button('Run', { ic: 'play', onClick: () => go('runs') }), exportMenu, lifecycleAction, menu(button('', { ic: 'more', title: 'More actions' }), moreItems)),
      ),
    );
  }

  function paintBanners() {
    clear(banners);
    const v = view.version;
    if (v.version !== view.current_version) {
      banners.append(banner('info', `You are viewing v${v.version}`, `The current version is v${view.current_version}.`, [button(`Go to v${view.current_version}`, { size: 'sm', onClick: () => go(tab, view.current_version) })]));
    }
    if (view.stale && view.stale.stale && app.feature('regression_testing')) {
      const since = view.stale.since_version ? ` (last tested: v${view.stale.since_version})` : '';
      banners.append(banner('warn', '⚠ Playbook changed since last test.', `${view.stale.reason === 'suite_changed' ? 'The test suite changed since the last run.' : 'The procedure changed, so earlier results no longer describe it'}${since}. Run the tests to see whether behaviour regressed.`, [button('Run Tests', { size: 'sm', kind: 'primary', ic: 'flask', onClick: () => go('tests', v.version, 'autorun=1') })]));
    }
    if (!v.quality_gate.passed) {
      banners.append(banner('fail', 'Quality gate not passed', `${v.quality_gate.failed_checks.map((c) => c.label).join(' · ')}. Fix these before publishing.`, tab !== 'overview' ? [button('See details', { size: 'sm', onClick: () => go('overview') })] : []));
    }
  }

  function paintTabs() {
    clear(tabsBar);
    const v = view.version;
    for (const [key, label, ic] of TABS) {
      if (key === 'export' && !app.feature('markdown_export') && !app.feature('json_export') && !app.feature('pdf_export')) continue;
      let extra = null;
      if (key === 'tests') extra = view.stale && view.stale.stale ? h('span', { class: 'alert', title: 'Stale' }) : h('span', { class: 'count' }, String(view.suite.count));
      if (key === 'versions') extra = h('span', { class: 'count' }, String(view.versions.length));
      if (key === 'overview' && !v.quality_gate.passed) extra = h('span', { class: 'alert' });
      tabsBar.append(h('a', { class: `tab ${key === tab ? 'active' : ''}`, href: `#/playbooks/${id}/${key}${v.version !== view.current_version ? `?v=${v.version}` : ''}` }, icon(ic), label, extra));
    }
    // On narrow screens the bar scrolls: keep the current tab in view.
    const active = tabsBar.querySelector('.tab.active');
    if (active && tabsBar.scrollWidth > tabsBar.clientWidth) requestAnimationFrame(() => active.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }

  let tabCleanup = null;
  let contentSeq = 0;
  async function paintContent() {
    const seq = ++contentSeq;
    if (tabCleanup) {
      tabCleanup();
      tabCleanup = null;
    }
    clear(content).append(h('div', { class: 'loading-page' }, h('span', { class: 'spinner lg' })));
    try {
      const mod = await LOADERS[tab]();
      const host = h('div');
      const r = await mod.render(host, ctx);
      // A newer paint (a reload that raced this one) has won; discard this one.
      if (seq !== contentSeq) {
        if (typeof r === 'function') r();
        return;
      }
      tabCleanup = typeof r === 'function' ? r : null;
      clear(content).append(host);
    } catch (err) {
      if (seq !== contentSeq) return;
      console.error(err);
      clear(content).append(banner('fail', 'This tab could not be loaded', errorMessage(err)));
    }
  }

  function paint() {
    paintHeader();
    paintBanners();
    paintTabs();
    paintContent();
  }

  paint();
  return () => {
    if (tabCleanup) tabCleanup();
    for (const fn of cleanups) fn();
  };
}
