// Versions tab (spec §47, §49): history, lifecycle actions and comparison.
import { api } from '../../api.js';
import { h, icon, clear, card, button, badge, toast, errorMessage, when, pct, compactJson, title, confirmDialog } from '../../ui.js';

export async function render(el, ctx) {
  const { view } = ctx;
  const versions = view.versions;
  let a = versions.length > 1 ? versions[1].version : versions[0].version;
  let b = versions[0].version;
  const cmpHost = h('div');

  const selA = h('select', { class: 'input sm', style: { width: 'auto' } });
  const selB = h('select', { class: 'input sm', style: { width: 'auto' } });
  for (const [sel, val] of [
    [selA, a],
    [selB, b],
  ]) {
    for (const x of versions) sel.append(h('option', { value: x.version, selected: x.version === val }, `v${x.version} · ${title(x.status)}`));
  }
  selA.addEventListener('change', () => {
    a = Number(selA.value);
    compare();
  });
  selB.addEventListener('change', () => {
    b = Number(selB.value);
    compare();
  });

  async function compare() {
    clear(cmpHost);
    if (a === b) {
      cmpHost.append(h('div', { class: 'small muted' }, 'Choose two different versions.'));
      return;
    }
    let c;
    try {
      c = await api.get(`/api/playbooks/${ctx.id}/compare?a=${a}&b=${b}`);
    } catch (err) {
      cmpHost.append(h('div', { class: 'small', style: { color: 'var(--fail)' } }, errorMessage(err)));
      return;
    }
    const labels = { accuracy: 'Accuracy', consistency: 'Consistency', rule_adherence: 'Rule Adherence', requirement_coverage: 'Requirement Coverage', output_compliance: 'Output Compliance', task_alignment: 'Task Alignment' };
    cmpHost.append(
      h(
        'div',
        { class: 'grid two' },
        h(
          'div',
          null,
          h('div', { class: 'section-label' }, 'Test metrics'),
          h(
            'table',
            { class: 'table' },
            h('thead', null, h('tr', null, h('th', null, 'Metric'), h('th', { class: 'num' }, `v${a}`), h('th', { class: 'num' }, `v${b}`), h('th', { class: 'num' }, 'Change'))),
            h('tbody', null, c.metrics.map((m) => h('tr', null, h('td', null, labels[m.metric]), h('td', { class: 'num' }, pct(m.a, 1)), h('td', { class: 'num' }, pct(m.b, 1)), h('td', { class: 'num' }, m.delta === null ? '—' : m.delta === 0 ? '0' : h('span', { class: m.delta > 0 ? 'delta-up' : 'delta-down' }, `${m.delta > 0 ? '+' : ''}${(m.delta * 100).toFixed(1)} pts`))))),
          ),
          h('div', { class: 'row mt-2 small' }, 'Last test:', c.a.last_test ? badge(c.a.last_test.status, `v${a} ${c.a.last_test.status.toUpperCase()}`) : badge('', `v${a} untested`, 'outline'), c.b.last_test ? badge(c.b.last_test.status, `v${b} ${c.b.last_test.status.toUpperCase()}`) : badge('', `v${b} untested`, 'outline')),
        ),
        h(
          'div',
          null,
          h('div', { class: 'section-label' }, `Procedure changes (${c.changes.length})`),
          c.changes.length
            ? h('ul', { class: 'list-clean diff-list' }, c.changes.slice(0, 40).map((d) => h('li', null, h('span', { class: `k-${d.kind}` }, d.kind.toUpperCase()), ' ', d.path, d.kind === 'changed' ? ` : ${compactJson(d.before, 50)} → ${compactJson(d.after, 50)}` : d.kind === 'added' ? ` : ${compactJson(d.after, 60)}` : '')))
            : h('div', { class: 'small muted' }, 'No procedure changes (only cosmetic or test-suite changes).'),
        ),
      ),
    );
  }

  const rows = versions.map((x) => {
    const actions = [];
    actions.push(button('View', { size: 'xs', onClick: () => ctx.go('overview', x.version) }));
    if (!['published', 'production'].includes(x.status) && x.version === view.current_version) actions.push(button('Test', { size: 'xs', onClick: () => ctx.go('tests', x.version) }));
    if (x.status === 'published')
      actions.push(
        button('Promote', {
          size: 'xs',
          onClick: async () => {
            if (!(await confirmDialog({ title: `Promote v${x.version} to production?`, text: 'Scheduled, webhook and default runs will use this version.', confirm: 'Promote' }))) return;
            try {
              await api.post(`/api/playbooks/${ctx.id}/promote`, { version: x.version });
              toast(`v${x.version} promoted`);
              ctx.reload();
            } catch (err) {
              toast(errorMessage(err), 'error');
            }
          },
        }),
      );
    if (x.version !== view.current_version)
      actions.push(
        button('Restore', {
          size: 'xs',
          kind: 'ghost',
          title: 'Create a new draft from this version',
          onClick: async () => {
            const r = await api.post(`/api/playbooks/${ctx.id}/restore`, { version: x.version });
            toast(`Restored as v${r.version.version}`);
            ctx.go('overview', r.version.version);
          },
        }),
      );
    return h(
      'tr',
      null,
      h('td', null, h('div', { class: 'cell-title row nowrap' }, `v${x.version}`, x.version === view.current_version ? badge('', 'current', 'accent') : null, x.version === view.production_version ? badge('production') : null)),
      h('td', null, badge(x.status)),
      h('td', null, h('div', { class: 'small' }, title(x.source)), h('div', { class: 'cell-sub' }, x.change_note)),
      h('td', null, x.last_test ? h('div', { class: 'row nowrap' }, badge(x.last_test.status), h('span', { class: 'small muted' }, pct(x.last_test.metrics && x.last_test.metrics.accuracy)), x.last_test.stale ? badge('warning', 'stale') : null) : h('span', { class: 'small muted' }, 'Not tested')),
      h('td', null, x.quality_gate_passed ? h('span', { class: 'small', style: { color: 'var(--pass)' } }, '✓ passed') : h('span', { class: 'small', style: { color: 'var(--fail)' } }, '✕ failed')),
      h('td', { class: 'small muted' }, when(x.created_at), x.published_at ? h('div', { class: 'xsmall' }, `published ${when(x.published_at)}`) : null),
      h('td', { class: 'num' }, h('div', { class: 'row nowrap', style: { justifyContent: 'flex-end' } }, actions)),
    );
  });

  el.append(
    card({
      title: 'Version history',
      icon: 'history',
      hint: 'Drafts may be edited; published versions are immutable — changes create a new version',
      tight: true,
      body: h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'Version'), h('th', null, 'Status'), h('th', null, 'Source / note'), h('th', null, 'Last test'), h('th', null, 'Quality gate'), h('th', null, 'Created'), h('th', null, ''))), h('tbody', null, rows))),
    }),
    h('div', { class: 'mt-3' }),
    card({ title: 'Compare versions', icon: 'compare', actions: [h('div', { class: 'row' }, selA, icon('arrowRight'), selB)], body: cmpHost }),
  );
  compare();
}
