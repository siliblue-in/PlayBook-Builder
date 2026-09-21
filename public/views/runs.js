// Runs: every execution (manual, API, schedule, webhook), filterable.
import { api } from '../api.js';
import { h, clear, pageHead, card, badge, empty, ago, duration, money, title, icon } from '../ui.js';

const FILTERS = [
  ['', 'All'],
  ['awaiting_approval', 'Awaiting approval'],
  ['running', 'Running'],
  ['completed', 'Completed'],
  ['failed', 'Failed'],
  ['needs_input', 'Needs input'],
  ['cancelled', 'Cancelled'],
];

export async function render(el, { app, query }) {
  let status = query.status || '';
  const all = (await api.get('/api/runs?limit=300')).runs;
  const chips = h('div', { class: 'row mb-2' });
  const host = h('div');
  el.append(pageHead({ title: 'Runs', subtitle: 'Executions of published playbooks and sandbox trials of drafts. Each run records its version, input, trace, logs, approvals, validation and output.' }), chips, card({ tight: true, body: host }));

  function paint() {
    clear(chips);
    for (const [k, l] of FILTERS) {
      const n = k ? all.filter((r) => r.status === k).length : all.length;
      if (k && !n) continue;
      chips.append(h('button', { type: 'button', class: `chip ${status === k ? 'active' : ''}`, onClick: () => { status = k; paint(); } }, l, h('span', { class: 'muted' }, String(n))));
    }
    const rows = all.filter((r) => !status || r.status === status);
    clear(host);
    if (!rows.length) {
      host.append(empty('play', 'No runs', 'Open a playbook and use its Runs tab to execute it.'));
      return;
    }
    host.append(
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'table' },
          h('thead', null, h('tr', null, h('th', null, 'Playbook'), h('th', null, 'Status'), h('th', null, 'Mode'), h('th', null, 'Trigger'), h('th', null, 'Result'), h('th', { class: 'num cost' }, 'Cost'), h('th', { class: 'num' }, 'Duration'), h('th', { class: 'num' }, 'Started'))),
          h(
            'tbody',
            null,
            rows.map((r) =>
              h(
                'tr',
                { class: 'clickable', onClick: () => app.navigate(`/runs/${r.id}`) },
                h('td', null, h('div', { class: 'cell-title' }, r.playbook_name), h('div', { class: 'cell-sub' }, `v${r.version} · ${r.environment}`)),
                h('td', null, badge(r.status), r.pending_approvals ? h('div', { class: 'xsmall mt-1', style: { color: 'var(--warn)' } }, icon('clock'), ' approval pending') : null),
                h('td', null, r.mode === 'ai' ? badge('', 'AI', 'accent') : badge('', 'Deterministic', 'outline')),
                h('td', { class: 'small' }, title(r.trigger)),
                h('td', { class: 'small' }, r.error ? h('span', { style: { color: 'var(--fail)' } }, r.error.code) : r.status === 'completed' ? 'Output validated' : '—'),
                h('td', { class: 'num small cost' }, r.usage ? money(r.usage.cost) : '—'),
                h('td', { class: 'num small muted' }, duration(r.duration_ms)),
                h('td', { class: 'num small muted' }, ago(r.started_at)),
              ),
            ),
          ),
        ),
      ),
    );
  }
  paint();
}
