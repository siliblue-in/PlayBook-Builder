// Tests tab (spec §37–§48, §60): run the suite in Deterministic Fixture or AI
// Execution mode, repeatability, metrics, failures, AI-assisted repair,
// regression comparison and the editable test suite.
import { api, poll } from '../../api.js';
import { h, icon, clear, card, button, badge, banner, toast, errorMessage, modal, jsonEditor, segmented, toggle, compactJson, title, pct, confirmDialog, menu } from '../../ui.js';
import { testRunSummary, testResults, suggestionCards } from '../../components/common.js';

const CATEGORIES = ['normal', 'boundary', 'negative', 'missing_data', 'edge', 'repeatability', 'error_handling'];

function testDialog(ctx, test, onSaved) {
  const isNew = !test;
  const t = test || { name: '', category: 'normal', description: '', input: {}, runs: 1 };
  const name = h('input', { class: 'input', value: t.name, placeholder: 'e.g. Boundary 14' });
  const category = h('select', { class: 'input' }, CATEGORIES.map((c) => h('option', { value: c, selected: c === t.category }, title(c))));
  const runs = h('input', { class: 'input', type: 'number', min: 1, max: 100, value: t.runs || 1 });
  const desc = h('input', { class: 'input', value: t.description || '', placeholder: 'What this test proves' });
  const input = jsonEditor(t.input || {}, { rows: 7 });
  const expected = jsonEditor(t.expected === undefined ? {} : t.expected, { rows: 5 });
  const status = h('select', { class: 'input' }, ['', 'completed', 'error', 'failed', 'needs_input', 'awaiting_approval'].map((s) => h('option', { value: s, selected: (t.expected_status || '') === s }, s ? title(s) : '(from expected values)')));
  const errCode = h('input', { class: 'input', value: t.expected_error || '', placeholder: 'e.g. INVALID_INPUT' });
  const behavior = h('input', { class: 'input', value: t.expected_behavior || '', placeholder: 'Semantic expectation for the evaluator (optional)' });
  const field = (label, control, help) => h('div', { class: 'field' }, h('label', null, label), control, help ? h('div', { class: 'help' }, help) : null);
  modal({
    title: isNew ? 'Add test case' : `Edit ${t.id}`,
    wide: true,
    body: h(
      'div',
      { class: 'grid two' },
      h('div', null, field('Name', name), field('Category', category), field('Description', desc), field('Runs', runs, 'More than 1 makes this a repeatability test.'), field('Expected status', status), field('Expected error code', errCode), field('Expected behaviour', behavior)),
      h('div', null, field('Input (run input JSON)', input.el), field('Expected output fields', expected.el, 'Structured fields only. Matchers such as {"$contains": "14"} or {"$gte": 1} are allowed. Leave {} for none.')),
    ),
    actions: [
      { label: 'Cancel', onClick: (c) => c() },
      {
        label: isNew ? 'Add test' : 'Save test',
        kind: 'primary',
        icon: 'check',
        onClick: async (close) => {
          let inputVal;
          let expectedVal;
          try {
            inputVal = input.get();
            expectedVal = expected.get();
          } catch (err) {
            toast(`Invalid JSON: ${err.message}`, 'error');
            return;
          }
          const body = {
            name: name.value.trim() || 'Untitled test',
            category: category.value,
            description: desc.value,
            input: inputVal,
            runs: Number(runs.value) || 1,
          };
          if (expectedVal && Object.keys(expectedVal).length) body.expected = expectedVal;
          if (status.value) body.expected_status = status.value;
          if (errCode.value.trim()) body.expected_error = errCode.value.trim();
          if (behavior.value.trim()) body.expected_behavior = behavior.value.trim();
          try {
            if (isNew) await api.post(`/api/playbooks/${ctx.id}/tests`, { test: body });
            else await api.put(`/api/playbooks/${ctx.id}/tests/${t.id}`, { test: body });
            close();
            toast(isNew ? 'Test added' : 'Test saved');
            onSaved();
          } catch (err) {
            toast(errorMessage(err), 'error');
          }
        },
      },
    ],
  });
}

export async function render(el, ctx) {
  const { app, view } = ctx;
  const s = app.settings;
  const v = view.version;
  let suite = (await api.get(`/api/playbooks/${ctx.id}/tests`)).tests;
  const lastRunId = (v.test_history || [])[0];
  let run = lastRunId ? (await api.get(`/api/test-runs/${lastRunId}`)).data.test_run : null;
  let stopPoll = null;
  let mode = s.testing.default_mode;
  let runsOverride = s.behavior.default_repeatability_runs;
  let aiEval = s.features.ai_evaluation;
  const aiReady = Boolean(app.aiStatus && app.aiStatus.configured);

  const summaryHost = h('div');
  const repairHost = h('div');
  const resultsHost = h('div');
  const regressionHost = h('div');
  const suiteHost = h('div');

  // ---------------------------------------------------------- run controls
  const runBtn = button('Run Tests', { kind: 'primary', ic: 'flask' });
  const cancelBtn = button('Cancel', { ic: 'x', kind: 'ghost' });
  cancelBtn.style.display = 'none';
  const runsInput = h('input', { class: 'input sm', type: 'number', min: 2, max: 100, value: runsOverride, style: { width: '76px' }, 'aria-label': 'Repeatability runs', onInput: (e) => (runsOverride = Number(e.target.value) || runsOverride) });
  const modeCtl = segmented(
    [
      { value: 'deterministic', label: 'Deterministic Fixture', icon: 'cpu' },
      { value: 'ai', label: 'AI Execution', icon: 'sparkles' },
    ],
    mode,
    (m) => {
      mode = m;
      paintControlsHint();
    },
  );
  const hint = h('div', { class: 'xsmall muted' });
  function paintControlsHint() {
    hint.textContent =
      mode === 'ai'
        ? aiReady
          ? `Runs the playbook with your testing model (${(app.aiStatus.roles && app.aiStatus.roles.testing) || 'not selected'}). Costs tokens: ${suite.reduce((n, t) => n + (t.runs > 1 ? runsOverride : 1), 0)} executions.`
          : 'AI Execution needs an AI connection.'
        : 'Executes the machine-readable logic with fixtures — exact, free and instant.';
    runBtn.disabled = starting || (mode === 'ai' && !aiReady) || !suite.length || (run && run.status === 'running');
  }

  let starting = false;
  async function startRun(testIds) {
    // A double-click must not start two test runs.
    if (starting || (run && run.status === 'running')) return;
    starting = true;
    paintControlsHint();
    try {
      const res = await api.post(`/api/playbooks/${ctx.id}/test`, { mode, version: v.version, runs: runsOverride, ai_evaluation: aiEval, test_ids: testIds });
      run = res.data.test_run;
      paintAll();
      watch();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
    starting = false;
    paintControlsHint();
  }
  runBtn.addEventListener('click', () => startRun());
  cancelBtn.addEventListener('click', async () => {
    if (run) await api.post(`/api/test-runs/${run.id}/cancel`);
  });

  function watch() {
    if (stopPoll) stopPoll();
    if (!run || run.status !== 'running') return;
    stopPoll = poll(() => api.get(`/api/test-runs/${run.id}`), {
      interval: 700,
      onUpdate: (r) => {
        run = r.data.test_run;
        paintSummary();
      },
      done: (r) => {
        if (r.data.test_run.status !== 'running') {
          const st = r.data.test_run.result_status;
          toast(st ? `Tests finished: ${st.toUpperCase()}` : `Test run ${r.data.test_run.status}`, st === 'fail' ? 'error' : 'ok');
          ctx.reload();
          return true;
        }
        return false;
      },
      onError: (err) => toast(errorMessage(err), 'error'),
    });
  }

  // ---------------------------------------------------------- generation
  async function generate(strategy) {
    try {
      toast(strategy === 'deterministic' ? 'Analysing rules and boundaries…' : 'Asking the testing model for test cases…');
      const res = await api.post(`/api/playbooks/${ctx.id}/tests/generate`, { strategy, version: v.version });
      suite = res.data.tests;
      toast(`${res.data.added.length} new test case${res.data.added.length === 1 ? '' : 's'} added`);
      for (const n of res.data.notes || []) toast(n, 'ok', 7000);
      ctx.reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  const genMenu = app.feature('automatic_test_generation')
    ? menu(button('Generate Test Cases', { ic: 'sparkles' }), [
        { label: 'From rules & boundaries (instant)', icon: 'cpu', onClick: () => generate('deterministic') },
        { label: 'With the AI testing model', icon: 'sparkles', disabled: !aiReady, onClick: () => generate('ai') },
        { label: 'Both', icon: 'plus', disabled: !aiReady, onClick: () => generate('both') },
      ])
    : null;

  const controls = card({
    title: 'Run the test suite',
    icon: 'flask',
    hint: `v${v.version} · ${suite.length} test cases`,
    body: h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'row between' },
        h('div', { class: 'row' }, modeCtl, s.features.repeatability_testing ? h('label', { class: 'row small' }, 'Repeatability runs', runsInput) : h('span', { class: 'small muted' }, 'Repeatability testing is off'), s.features.ai_evaluation ? h('label', { class: 'row small', title: aiReady ? 'Semantic evaluation of outputs by the evaluation model' : 'Needs an AI connection' }, toggle(aiReady && aiEval, (x) => (aiEval = x), { label: 'AI evaluation', disabled: !aiReady }), h('span', { class: aiReady ? '' : 'muted' }, 'AI evaluation')) : null),
        h('div', { class: 'row' }, cancelBtn, runBtn),
      ),
      hint,
      h('div', { class: 'row' }, genMenu, button('Add test', { ic: 'plus', onClick: () => testDialog(ctx, null, () => ctx.reload()) }), view.example_key && v.version === view.current_version && (ctx.pb.decision_rules.find((r) => r.id === 'rule_01') || { when: {} }).when.operator === 'greater_than_or_equal' ? button('Demo: introduce boundary bug', { ic: 'bug', kind: 'ghost', onClick: async () => { const r = await api.post(`/api/playbooks/${ctx.id}/demo/break`); toast(`v${r.version.version} created with rule_01 using >. Run the tests.`); ctx.go('tests', r.version.version); } }) : null),
    ),
  });

  // ---------------------------------------------------------- painting
  function paintSummary() {
    clear(summaryHost);
    const running = run && run.status === 'running';
    cancelBtn.style.display = running ? '' : 'none';
    paintControlsHint();
    if (!run) {
      summaryHost.append(banner('info', 'This version has not been tested', 'A playbook is not production-ready just because its JSON is valid. Run the suite to measure accuracy, consistency and rule adherence.'));
      return;
    }
    const stale = !running && run.stale;
    summaryHost.append(
      card({
        title: running ? 'Test run in progress' : 'Latest results',
        icon: 'flask',
        actions: running ? [] : [run.full_suite ? null : badge('', 'Partial run', 'outline'), button('Full report', { size: 'sm', kind: 'ghost', href: `#/test-runs/${run.id}` })].filter(Boolean),
        body: testRunSummary(run, { stale }),
      }),
    );
  }

  const DISMISS_KEY = 'pbai.dismissed_suggestions';
  const loadDismissed = () => {
    try {
      return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]'));
    } catch {
      return new Set();
    }
  };
  const saveDismissed = (set) => {
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify([...set].slice(-200)));
    } catch { /* private mode: dismissal lasts for this visit */ }
  };
  const dismissedSuggestions = loadDismissed();

  async function paintRepair() {
    clear(repairHost);
    if (!run || run.status !== 'completed' || run.result_status === 'pass') return;
    const failing = (run.results || []).filter((r) => r.status === 'fail' || r.status === 'warning');
    if (!failing.length) return;
    const apply = async (sg) => {
      if (!(await confirmDialog({ title: 'Approve this fix?', text: `${sg.fix_summary} This creates a new version from v${run.version}, then re-runs the deterministic suite. v${run.version} stays unchanged.`, confirm: 'Approve & create version' }))) return;
      try {
        const res = await api.post(`/api/playbooks/${ctx.id}/repair/apply`, { test_run_id: run.id, suggestion_id: sg.id });
        toast(`Fix applied as v${res.applied.version}${res.retest ? ` · retest ${String(res.retest.result_status).toUpperCase()}` : ''}`);
        ctx.go('tests', res.applied.version);
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    };
    const askAi = button('Ask AI for a fix', {
      ic: 'sparkles',
      size: 'sm',
      disabled: !aiReady,
      onClick: async () => {
        askAi.disabled = true;
        askAi.replaceChildren(h('span', { class: 'spinner' }), 'Analysing failures…');
        try {
          await api.post(`/api/playbooks/${ctx.id}/repair`, { test_run_id: run.id, use_ai: true });
          run = (await api.get(`/api/test-runs/${run.id}`)).data.test_run;
          paintRepair();
        } catch (err) {
          toast(errorMessage(err), 'error');
          askAi.disabled = false;
          askAi.replaceChildren('Ask AI for a fix');
        }
      },
    });
    const applicable = { ...run, repair_suggestions: (run.repair_suggestions || []).filter((s) => s.status !== 'dismissed' && !dismissedSuggestions.has(s.id)) };
    const cards = suggestionCards(applicable, {
      onApply: apply,
      onDismiss: (sg) => {
        // Persist the dismissal so it survives the reloads this tab performs.
        dismissedSuggestions.add(sg.id);
        saveDismissed(dismissedSuggestions);
        paintRepair();
      },
    });
    repairHost.append(
      card({
        title: 'Failures & suggested fixes',
        icon: 'wrench',
        hint: 'Test → failure → step → explanation → suggested change → your approval → new version → retest',
        actions: [askAi],
        body: h(
          'div',
          { class: 'stack' },
          failing.map((r) => h('div', { class: `failure-card ${r.status}` }, h('div', { class: 'row between' }, h('div', { class: 'row' }, badge(r.status), h('span', { class: 'bold' }, r.name)), h('code', { class: 'xsmall' }, compactJson(r.input, 80))), h('ul', { class: 'bullets small', style: { marginBottom: 0 } }, (r.diagnosis || []).map((d) => h('li', null, d))))),
          cards || h('div', { class: 'small muted' }, aiReady ? 'No automatic fix was found by rule analysis. Ask the AI for a suggestion.' : 'No automatic fix was found by rule analysis.'),
        ),
      }),
    );
  }

  function paintResults() {
    clear(resultsHost);
    if (!run || run.status === 'running' || !(run.results || []).length) return;
    resultsHost.append(card({ title: 'Test results', icon: 'list', tight: true, body: testResults(run) }));
  }

  async function paintRegression() {
    clear(regressionHost);
    if (!app.feature('regression_testing') || !view.regression) return;
    const other = view.regression.compare_with;
    let cmp;
    try {
      cmp = await api.get(`/api/playbooks/${ctx.id}/compare?a=${other}&b=${v.version}`);
    } catch {
      return;
    }
    const label = { accuracy: 'Accuracy', consistency: 'Consistency', rule_adherence: 'Rule Adherence', requirement_coverage: 'Requirement Coverage', output_compliance: 'Output Compliance', task_alignment: 'Task Alignment' };
    regressionHost.append(
      card({
        title: `Regression: v${other} → v${v.version}`,
        icon: 'compare',
        hint: v.last_test ? 'Both versions tested' : `v${v.version} not tested yet`,
        body: h(
          'div',
          { class: 'grid two' },
          h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'table' },
              h('thead', null, h('tr', null, h('th', null, 'Metric'), h('th', { class: 'num' }, `v${other}`), h('th', { class: 'num' }, `v${v.version}`), h('th', { class: 'num' }, 'Change'))),
              h('tbody', null, cmp.metrics.map((m) => h('tr', null, h('td', null, label[m.metric]), h('td', { class: 'num' }, pct(m.a, 1)), h('td', { class: 'num' }, pct(m.b, 1)), h('td', { class: 'num' }, m.delta === null ? '—' : m.delta === 0 ? '0' : h('span', { class: m.delta > 0 ? 'delta-up' : 'delta-down' }, `${m.delta > 0 ? '+' : ''}${(m.delta * 100).toFixed(1)} pts`))))),
            ),
          ),
          h('div', null, h('div', { class: 'section-label' }, `What changed (${cmp.changes.length})`), cmp.changes.length ? h('ul', { class: 'list-clean diff-list' }, cmp.changes.slice(0, 12).map((c) => h('li', null, h('span', { class: `k-${c.kind}` }, c.kind.toUpperCase()), ' ', c.path, c.kind === 'changed' ? ` : ${compactJson(c.before, 40)} → ${compactJson(c.after, 40)}` : ''))) : h('div', { class: 'small muted' }, 'Only cosmetic changes.')),
        ),
      }),
    );
  }

  function paintSuite() {
    clear(suiteHost);
    const lastById = new Map(((run && run.results) || []).map((r) => [r.test_id, r.status]));
    suiteHost.append(
      card({
        title: 'Test suite',
        icon: 'list',
        hint: 'Shared by every version of this playbook',
        tight: true,
        actions: view.example_key ? [button('Restore built-in tests', { size: 'sm', kind: 'ghost', onClick: async () => { if (await confirmDialog({ title: 'Restore the built-in suite?', text: 'Replaces the current test cases with the 7 built-in tests.', confirm: 'Restore' })) { await api.post(`/api/playbooks/${ctx.id}/tests/restore-builtin`); toast('Built-in tests restored'); ctx.reload(); } } })] : [],
        body: suite.length
          ? h(
              'div',
              { class: 'table-wrap' },
              h(
                'table',
                { class: 'table' },
                h('thead', null, h('tr', null, h('th', null, 'Test'), h('th', null, 'Category'), h('th', null, 'Input'), h('th', null, 'Expected'), h('th', { class: 'num' }, 'Runs'), h('th', null, 'Last'), h('th', null, ''))),
                h(
                  'tbody',
                  null,
                  suite.map((t) =>
                    h(
                      'tr',
                      null,
                      h('td', null, h('div', { class: 'cell-title' }, t.name), h('div', { class: 'cell-sub' }, h('code', null, t.id), t.source ? ` · ${String(t.source).replace(/_/g, ' ')}` : '', t.oracle === 'decision_rules' ? ' · expectations from rules' : '')),
                      h('td', null, h('span', { class: 'badge outline' }, title(t.category))),
                      h('td', null, h('code', null, compactJson(t.input, 60))),
                      h('td', null, h('code', null, t.expected !== undefined ? compactJson(t.expected, 60) : t.expected_error ? `error ${t.expected_error}` : t.expected_status ? `status ${t.expected_status}` : t.expected_behavior || '')),
                      h('td', { class: 'num' }, t.runs > 1 ? h('span', { class: 'bold' }, `× ${s.features.repeatability_testing ? runsOverride : 1}`) : '1'),
                      h('td', null, lastById.has(t.id) ? badge(lastById.get(t.id)) : h('span', { class: 'muted small' }, '—')),
                      h('td', { class: 'num' }, h('div', { class: 'row nowrap', style: { justifyContent: 'flex-end' } }, button('', { ic: 'play', size: 'xs', kind: 'ghost', title: 'Run only this test', onClick: () => startRun([t.id]) }), button('', { ic: 'edit', size: 'xs', kind: 'ghost', title: 'Edit', onClick: () => testDialog(ctx, t, () => ctx.reload()) }), button('', { ic: 'trash', size: 'xs', kind: 'ghost', title: 'Delete', onClick: async () => { if (await confirmDialog({ title: `Delete ${t.name}?`, text: 'The test is removed from the suite for every version.', confirm: 'Delete', danger: true })) { await api.del(`/api/playbooks/${ctx.id}/tests/${t.id}`); toast('Test deleted'); ctx.reload(); } } }))),
                    ),
                  ),
                ),
              ),
            )
          : h('div', { class: 'empty' }, icon('flask'), h('div', { class: 'empty-title' }, 'No test cases'), h('div', { class: 'small mt-1' }, 'Generate tests from the rules and boundaries, or add your own.')),
      }),
    );
  }

  function paintAll() {
    paintSummary();
    paintRepair();
    paintResults();
    paintRegression();
    paintSuite();
  }

  el.append(controls, h('div', { class: 'mt-3' }), summaryHost, h('div', { class: 'mt-3' }), repairHost, h('div', { class: 'mt-3' }), resultsHost, h('div', { class: 'mt-3' }), regressionHost, h('div', { class: 'mt-3' }), suiteHost);
  paintAll();
  watch();

  const autorun = ctx.query.autorun === '1';
  if (autorun) {
    // Consume the flag so later in-place reloads of this view never re-run the suite.
    delete ctx.query.autorun;
    history.replaceState(null, '', location.hash.replace(/([?&])autorun=1&?/, '$1').replace(/[?&]$/, ''));
  }
  if (autorun && !(run && run.status === 'running') && suite.length) {
    mode = 'deterministic';
    startRun();
  }

  return () => stopPoll && stopPoll();
}
