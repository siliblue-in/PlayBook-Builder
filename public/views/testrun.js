// Full report of one test run.
import { api, poll } from '../api.js';
import { h, icon, clear, pageHead, card, button, badge, kv, when, duration, money, title, toast, errorMessage, jsonView } from '../ui.js';
import { testRunSummary, testResults, suggestionCards } from '../components/common.js';

export async function render(el, { params, app }) {
  let run = (await api.get(`/api/test-runs/${params[0]}`)).data.test_run;
  let stop = null;
  const body = h('div');
  const summary = h('div');
  const results = h('div');
  const repair = h('div');
  el.append(body);

  const paint = () => {
    clear(body).append(
      pageHead({
        title: `Test run · ${run.playbook_name}`,
        crumbs: h('div', { class: 'crumbs' }, h('a', { href: '#/test-center' }, 'Test Center'), icon('chevronRight'), h('span', null, run.id)),
        badges: [badge(run.result_status || run.status)],
        actions: [button('Open playbook', { ic: 'book', href: `#/playbooks/${run.playbook_id}/tests${run.version ? `?v=${run.version}` : ''}` })],
      }),
      h(
        'div',
        { class: 'grid sidebar-right' },
        h('div', { class: 'stack' }, summary, repair, results),
        sideColumn(),
      ),
    );
    summary.replaceChildren(card({ title: 'Result', icon: 'flask', body: testRunSummary(run, { stale: run.stale }) }));
    results.replaceChildren(run.status === 'running' ? h('div') : card({ title: 'Per-test results', icon: 'list', tight: true, body: testResults(run) }));
    const cards = run.status === 'completed' ? suggestionCards(run, { onApply: apply }) : null;
    repair.replaceChildren(cards ? card({ title: 'Suggested fixes', icon: 'wrench', body: cards }) : h('div'));
  };

  // Rebuilt on every paint: the Coverage and Error cards only exist once the
  // run has finished, so they cannot be built once at render time.
  const sideColumn = () =>
    h(
      'div',
      { class: 'stack' },
      card({
        title: 'Environment',
        icon: 'cpu',
        hint: 'Held constant across repeated runs',
        body: kv([
          ['Playbook', h('a', { href: `#/playbooks/${run.playbook_id}` }, run.playbook_name)],
          ['Version', `v${run.version} · ${run.playbook_hash}`],
          ['Mode', run.mode === 'ai' ? 'AI Execution' : 'Deterministic Fixture'],
          ['Model', run.environment.model ? h('code', { class: 'inline' }, run.environment.model) : '—'],
          ['Evaluator', run.environment.evaluation_model ? h('code', { class: 'inline' }, run.environment.evaluation_model) : 'Off'],
          ['Temperature', run.environment.temperature ?? '—'],
          ['Configuration', run.environment.configuration_hash],
          ['Engine', `${run.environment.engine_version} · ${run.environment.node}`],
          ['Suite', `${run.test_ids.length} test(s)${run.full_suite ? ' · full suite' : ' · partial'}`],
          ['Started', when(run.started_at)],
          ['Duration', duration(run.duration_ms)],
          ['Tokens', run.usage && run.usage.calls ? `${run.usage.total_tokens.toLocaleString()} in ${run.usage.calls} calls` : '—'],
          ['Cost', h('span', { class: 'cost' }, run.usage && run.usage.calls ? money(run.usage.cost) : '—')],
        ]),
      }),
      run.metrics
        ? card({
            title: 'Coverage',
            icon: 'target',
            body: h(
              'div',
              { class: 'small' },
              kv([
                ['Requirements', run.metrics.coverage.requirements_uncovered.length ? h('span', null, `Missing: ${run.metrics.coverage.requirements_uncovered.join(', ')}`) : 'All covered'],
                ['Rules exercised', `${run.metrics.coverage.rules_exercised.length} / ${run.metrics.coverage.rules_exercised.length + run.metrics.coverage.rules_not_exercised.length}`],
                ['Branches taken', `${run.metrics.coverage.branches_taken.length} / ${run.metrics.coverage.branches_taken.length + run.metrics.coverage.branches_not_taken.length}`],
                ['Error handling', run.metrics.metrics.error_handling === null ? '—' : `${Math.round(run.metrics.metrics.error_handling * 100)}%`],
              ]),
              h('div', { class: 'section-label' }, 'By category'),
              h('ul', { class: 'list-clean' }, Object.entries(run.metrics.by_category).map(([c, x]) => h('li', { class: 'row between' }, h('span', null, title(c)), h('span', { class: 'muted' }, `${x.passed}/${x.total} passed${x.warning ? ` · ${x.warning} warn` : ''}${x.failed ? ` · ${x.failed} failed` : ''}`)))),
            ),
          })
        : null,
      run.error ? card({ title: 'Error', icon: 'alert', body: jsonView(run.error, { cls: 'inline' }) }) : null,
    );

  async function apply(sg) {
    try {
      const res = await api.post(`/api/playbooks/${run.playbook_id}/repair/apply`, { test_run_id: run.id, suggestion_id: sg.id });
      toast(`Fix applied as v${res.applied.version}`);
      app.navigate(`/playbooks/${run.playbook_id}/tests?v=${res.applied.version}`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  paint();
  if (run.status === 'running') {
    stop = poll(() => api.get(`/api/test-runs/${run.id}`), {
      onUpdate: (r) => {
        run = r.data.test_run;
        paint();
      },
      done: (r) => r.data.test_run.status !== 'running',
    });
  }
  return () => stop && stop();
}
