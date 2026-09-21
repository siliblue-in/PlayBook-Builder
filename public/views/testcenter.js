// Test Center (spec §37, §46, §60): health of every playbook's current
// version, quick deterministic runs, and the test-run history.
import { api } from '../api.js';
import { h, icon, pageHead, card, button, badge, pct, ago, toast, errorMessage, empty, duration, money } from '../ui.js';

export async function render(el, { app }) {
  const [{ playbooks }, { test_runs: runs }] = await Promise.all([api.get('/api/playbooks'), api.get('/api/test-runs?limit=60')]);
  const tested = playbooks.filter((p) => p.last_test);
  const passing = tested.filter((p) => p.last_test.status === 'pass' && !p.stale).length;
  const failing = tested.filter((p) => p.last_test.status === 'fail').length;
  const stale = playbooks.filter((p) => p.stale).length;

  el.append(
    pageHead({
      title: 'Test Center',
      subtitle: 'Accuracy, consistency, requirement coverage, rule adherence, intent alignment, output compliance and error handling — measured on configured tests, not assumed from valid JSON.',
    }),
    h(
      'div',
      { class: 'grid four' },
      [
        ['Playbooks tested', `${tested.length} / ${playbooks.length}`, 'flask'],
        ['Passing', passing, 'circleCheck'],
        ['Failing', failing, 'circleX'],
        ['Stale results', stale, 'alert'],
      ].map(([l, v, ic]) => h('div', { class: 'card stat' }, h('div', { class: 'stat-label' }, icon(ic), l), h('div', { class: 'stat-value' }, v))),
    ),
    h('div', { class: 'mt-3' }),
  );

  const quickRun = async (p, btn) => {
    btn.disabled = true;
    btn.replaceChildren(h('span', { class: 'spinner' }));
    try {
      const r = await api.post(`/api/playbooks/${p.id}/test`, { mode: 'deterministic', wait: true });
      const st = r.data.test_run.result_status;
      toast(`${p.name}: ${String(st || r.data.test_run.status).toUpperCase()}`, st === 'fail' ? 'error' : 'ok');
      app.navigate(`/test-runs/${r.data.test_run.id}`);
    } catch (err) {
      toast(errorMessage(err), 'error');
      btn.disabled = false;
      btn.replaceChildren(icon('play'), 'Run');
    }
  };

  el.append(
    card({
      title: 'Current versions',
      icon: 'book',
      tight: true,
      body: playbooks.length
        ? h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'table' },
              h('thead', null, h('tr', null, h('th', null, 'Playbook'), h('th', null, 'Status'), h('th', { class: 'num' }, 'Accuracy'), h('th', { class: 'num' }, 'Consistency'), h('th', { class: 'num' }, 'Rule adherence'), h('th', { class: 'num' }, 'Req. coverage'), h('th', { class: 'num' }, 'Tested'), h('th', null, ''))),
              h(
                'tbody',
                null,
                playbooks.map((p) => {
                  const m = p.last_test && p.last_test.metrics;
                  const btn = button('Run', { size: 'xs', ic: 'play', title: 'Run the deterministic suite' });
                  btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    quickRun(p, btn);
                  });
                  if (!p.tests) btn.disabled = true;
                  return h(
                    'tr',
                    { class: 'clickable', onClick: () => app.navigate(`/playbooks/${p.id}/tests`) },
                    h('td', null, h('div', { class: 'cell-title' }, p.name), h('div', { class: 'cell-sub' }, `v${p.current_version} · ${p.tests} tests`)),
                    h('td', null, p.last_test ? h('div', { class: 'row nowrap' }, badge(p.last_test.status), p.stale ? badge('warning', 'stale') : null) : p.stale ? badge('warning', 'untested change') : h('span', { class: 'muted small' }, 'Not tested')),
                    h('td', { class: 'num' }, m ? pct(m.accuracy, 1) : '—'),
                    h('td', { class: 'num' }, m ? pct(m.consistency, 1) : '—'),
                    h('td', { class: 'num' }, m ? pct(m.rule_adherence, 1) : '—'),
                    h('td', { class: 'num' }, m ? pct(m.requirement_coverage) : '—'),
                    h('td', { class: 'num small muted' }, p.last_test ? ago(p.last_test.at) : '—'),
                    h('td', { class: 'num' }, btn),
                  );
                }),
              ),
            ),
          )
        : empty('flask', 'No playbooks yet'),
    }),
    h('div', { class: 'mt-3' }),
    card({
      title: 'Test run history',
      icon: 'history',
      tight: true,
      body: runs.length
        ? h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'table' },
              h('thead', null, h('tr', null, h('th', null, 'Playbook'), h('th', null, 'Mode'), h('th', null, 'Result'), h('th', { class: 'num' }, 'Passed'), h('th', { class: 'num' }, 'Accuracy'), h('th', { class: 'num' }, 'Consistency'), h('th', { class: 'num cost' }, 'Cost'), h('th', { class: 'num' }, 'Duration'), h('th', { class: 'num' }, 'When'))),
              h(
                'tbody',
                null,
                runs.map((t) =>
                  h(
                    'tr',
                    { class: 'clickable', onClick: () => app.navigate(`/test-runs/${t.id}`) },
                    h('td', null, h('div', { class: 'cell-title' }, t.playbook_name), h('div', { class: 'cell-sub' }, `v${t.version}${t.full_suite ? '' : ' · partial'}${t.stale ? ' · stale' : ''}${t.trigger === 'seed' ? ' · built-in' : ''}`)),
                    h('td', null, t.mode === 'ai' ? badge('', 'AI Execution', 'accent') : badge('', 'Deterministic', 'outline')),
                    h('td', null, t.status === 'running' ? badge('running') : badge(t.result_status || t.status)),
                    h('td', { class: 'num' }, t.counts ? `${t.counts.passed} / ${t.counts.executed}` : '—'),
                    h('td', { class: 'num' }, t.metrics ? pct(t.metrics.accuracy, 1) : '—'),
                    h('td', { class: 'num' }, t.metrics ? pct(t.metrics.consistency, 1) : '—'),
                    h('td', { class: 'num small cost' }, t.usage && t.usage.calls ? money(t.usage.cost) : '—'),
                    h('td', { class: 'num small muted' }, duration(t.duration_ms)),
                    h('td', { class: 'num small muted' }, ago(t.started_at)),
                  ),
                ),
              ),
            ),
          )
        : empty('flask', 'No test runs yet'),
    }),
  );
}
