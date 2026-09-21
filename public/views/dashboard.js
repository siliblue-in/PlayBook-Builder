// Dashboard: lifecycle overview, health of the library, recent activity.
import { api } from '../api.js';
import { h, icon, pageHead, card, button, badge, banner, empty, ago, pct, duration, title } from '../ui.js';

function stat(label, value, ic, foot) {
  return h('div', { class: 'card stat' }, h('div', { class: 'stat-label' }, icon(ic), label), h('div', { class: 'stat-value' }, value), foot ? h('div', { class: 'stat-foot' }, foot) : null);
}

export async function render(el, { app }) {
  const d = await api.get('/api/dashboard');
  const c = d.counts;
  const ai = d.ai;

  el.append(
    pageHead({
      title: 'Dashboard',
      subtitle: 'Build the playbook first. Test the playbook second. Execute the playbook third.',
      actions: [button('Create Playbook', { kind: 'primary', ic: 'sparkles', href: '#/create' })],
    }),
  );

  if (!ai.configured) {
    el.append(
      h(
        'div',
        { class: 'cta-hero' },
        h(
          'div',
          null,
          h('h2', null, 'Turn a goal into a tested, executable AI playbook'),
          h('p', null, 'Connect a model to create playbooks from plain language — Ollama on this computer (free, private, no key) or a cloud API key (OpenRouter, NVIDIA, Google, Groq and more). The built-in Customer Risk Evaluator already works without either — open it to see the workflow, tests and exports.'),
          h('div', { class: 'flow' }, ['Goal', 'Questions', 'Confirmed intent', 'Playbook', 'Tests', 'Publish', 'Run'].map((s) => h('span', null, s))),
        ),
        h('div', { class: 'row' }, button('Connect Local AI', { ic: 'cpu', href: '#/connections/local' }), button('Use a cloud key', { ic: 'plug', href: '#/connections' })),
      ),
    );
  } else if (ai.connection.status === 'error') {
    el.append(banner('fail', 'AI connection problem', ai.connection.last_error || 'The last connection test failed.', [button('Open AI Connections', { size: 'sm', href: '#/connections' })]));
  } else if (!ai.ready) {
    el.append(banner('warn', 'Choose models for every role', 'Pick a model for clarification, generation, execution, testing and evaluation.', [button('Choose models', { size: 'sm', href: '#/connections' })]));
  }

  if (c.pending_approvals) {
    el.append(banner('warn', `${c.pending_approvals} run${c.pending_approvals > 1 ? 's are' : ' is'} waiting for human approval`, 'External actions pause until a person approves them.', [button('Review runs', { size: 'sm', href: '#/runs' })]));
  }

  el.append(
    h(
      'div',
      { class: 'grid four' },
      stat('Playbooks', c.playbooks, 'book', `${c.stale} with stale tests`),
      stat('Tests passing', c.tests_passing, 'flask', `${c.tests_failing} failing`),
      stat('Published', c.published, 'flag', `${c.in_production} in production`),
      stat('Runs · 7 days', c.runs_7d, 'play', c.pending_approvals ? `${c.pending_approvals} awaiting approval` : 'no approvals pending'),
    ),
  );

  const stages = [
    ['draft', 'Draft'],
    ['testing', 'Testing'],
    ['passed', 'Passed'],
    ['warning', 'Warnings'],
    ['failed', 'Failed'],
    ['published', 'Published'],
    ['production', 'Production'],
  ];
  el.append(
    h('div', { class: 'mt-3' }),
    card({
      title: 'Lifecycle',
      icon: 'workflow',
      hint: 'Current version of each playbook',
      body: h('div', { class: 'pipeline' }, stages.map(([k, l]) => h('div', { class: 'stage' }, h('div', { class: 'n' }, d.by_status[k] || 0), h('div', { class: 'l' }, l)))),
    }),
  );

  const pbRows = d.playbooks.map((p) =>
    h(
      'tr',
      { class: 'clickable', onClick: () => app.navigate(`/playbooks/${p.id}`) },
      h('td', null, h('div', { class: 'cell-title' }, p.name), h('div', { class: 'cell-sub' }, p.objective)),
      h('td', null, badge(p.status), ' ', h('span', { class: 'badge outline' }, `v${p.current_version}`)),
      h('td', null, p.last_test ? h('div', { class: 'row nowrap' }, badge(p.last_test.status), p.stale ? h('span', { class: 'badge warning', title: 'Playbook changed since last test' }, icon('alert'), 'stale') : null) : h('span', { class: 'muted small' }, 'Not tested')),
      h('td', { class: 'num small muted' }, ago(p.updated_at)),
    ),
  );
  const trRows = d.test_runs.map((t) =>
    h(
      'tr',
      { class: 'clickable', onClick: () => app.navigate(`/test-runs/${t.id}`) },
      h('td', null, h('div', { class: 'cell-title' }, t.playbook_name), h('div', { class: 'cell-sub' }, `v${t.version} · ${t.mode === 'ai' ? 'AI Execution' : 'Deterministic'}${t.full_suite ? '' : ' · partial'}`)),
      h('td', null, t.status === 'running' ? badge('running') : badge(t.result_status || t.status)),
      h('td', { class: 'num small' }, t.metrics ? pct(t.metrics.accuracy) : '—'),
      h('td', { class: 'num small muted' }, ago(t.started_at)),
    ),
  );
  el.append(
    h(
      'div',
      { class: 'grid two mt-3' },
      card({
        title: 'Recent playbooks',
        icon: 'book',
        actions: [button('All playbooks', { size: 'sm', kind: 'ghost', href: '#/playbooks' })],
        tight: true,
        body: pbRows.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'Playbook'), h('th', null, 'Status'), h('th', null, 'Tests'), h('th', { class: 'num' }, 'Updated'))), h('tbody', null, pbRows)))
          : empty('book', 'No playbooks yet', 'Create one from a plain-language goal.', button('Create Playbook', { kind: 'primary', href: '#/create' })),
      }),
      card({
        title: 'Recent test runs',
        icon: 'flask',
        actions: [button('Test Center', { size: 'sm', kind: 'ghost', href: '#/test-center' })],
        tight: true,
        body: trRows.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'Playbook'), h('th', null, 'Result'), h('th', { class: 'num' }, 'Accuracy'), h('th', { class: 'num' }, 'When'))), h('tbody', null, trRows)))
          : empty('flask', 'No test runs yet'),
      }),
    ),
  );

  const runRows = d.runs.map((r) =>
    h(
      'tr',
      { class: 'clickable', onClick: () => app.navigate(`/runs/${r.id}`) },
      h('td', null, h('div', { class: 'cell-title' }, r.playbook_name), h('div', { class: 'cell-sub' }, `v${r.version} · ${title(r.trigger)} · ${r.environment}`)),
      h('td', null, badge(r.status)),
      h('td', null, r.mode === 'ai' ? badge('', 'AI', 'accent') : badge('', 'Deterministic', 'outline')),
      h('td', { class: 'num small muted' }, duration(r.duration_ms)),
      h('td', { class: 'num small muted' }, ago(r.started_at)),
    ),
  );
  el.append(
    h('div', { class: 'mt-3' }),
    card({
      title: 'Recent runs',
      icon: 'play',
      actions: [button('All runs', { size: 'sm', kind: 'ghost', href: '#/runs' })],
      tight: true,
      body: runRows.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'Playbook'), h('th', null, 'Status'), h('th', null, 'Mode'), h('th', { class: 'num' }, 'Duration'), h('th', { class: 'num' }, 'Started'))), h('tbody', null, runRows)))
        : empty('play', 'No runs yet', 'Publish a playbook, then run it from its Runs tab.'),
    }),
  );

  if (d.schedules.length) {
    el.append(
      h('div', { class: 'mt-3' }),
      card({
        title: 'Upcoming scheduled runs',
        icon: 'clock',
        body: h('ul', { class: 'list-clean' }, d.schedules.map((s) => h('li', { class: 'row between' }, h('a', { href: `#/playbooks/${s.playbook_id}` }, `${s.name} · v${s.version}`), h('span', { class: 'small muted' }, new Date(s.next_run_at).toLocaleString())))),
      }),
    );
  }
}
