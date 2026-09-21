// Shared playbook UI pieces: step definition, quality gate, lifecycle,
// metric tiles, test results, repair suggestions.
import { h, icon, badge, pct, title, compactJson, jsonView, STEP_COLORS, button, kv } from '../ui.js';

const OPS = {
  equals: '==', not_equals: '!=', greater_than: '>', greater_than_or_equal: '≥', less_than: '<', less_than_or_equal: '≤', between: 'between',
  contains: 'contains', not_contains: 'does not contain', in: 'in', not_in: 'not in', exists: 'exists', not_exists: 'is missing',
  is_empty: 'is empty', is_not_empty: 'is not empty', matches: 'matches', starts_with: 'starts with', ends_with: 'ends with',
};
export const OPERATOR_OPTIONS = Object.keys(OPS);

export function configMap(pb) {
  const m = {};
  for (const c of pb.configuration || []) m[c.name] = c.value;
  return m;
}

export function describeCondition(when, cfg = {}) {
  if (!when || typeof when !== 'object') return '—';
  if (when.otherwise || when.always) return 'otherwise (no earlier rule matched)';
  if (Array.isArray(when.all)) return when.all.map((w) => describeCondition(w, cfg)).join(' AND ');
  if (Array.isArray(when.any)) return `(${when.any.map((w) => describeCondition(w, cfg)).join(' OR ')})`;
  if (when.not) return `NOT (${describeCondition(when.not, cfg)})`;
  if (when.expression) return when.expression;
  const op = OPS[when.operator] || when.operator;
  if (['exists', 'not_exists', 'is_empty', 'is_not_empty'].includes(when.operator)) return `${when.field} ${op}`;
  let rhs;
  if (when.value_ref) {
    const ref = String(when.value_ref).replace(/^(config|configuration)\./, '');
    rhs = ref in cfg ? `${ref} (${JSON.stringify(cfg[ref])})` : ref;
  } else rhs = typeof when.value === 'string' ? when.value : JSON.stringify(when.value);
  return `${when.field} ${op} ${rhs}`;
}

export function typeSwatch(type) {
  return h('span', { class: 'type-swatch', style: { background: STEP_COLORS[type] || STEP_COLORS.task } });
}

function listOrNone(items, ordered = false) {
  if (!items || !items.length) return h('div', { class: 'muted small' }, 'None');
  return h(ordered ? 'ol' : 'ul', { class: ordered ? 'numbers' : 'bullets' }, items.map((x) => h('li', null, x)));
}

/** Full step definition (§13, §15, §58). */
export function stepDetail(step, pb) {
  if (!step) return h('div', { class: 'empty' }, icon('workflow'), h('div', { class: 'empty-title' }, 'Select a step'), h('div', { class: 'small mt-1' }, 'Click any node to see its complete definition.'));
  const idx = (pb.steps || []).findIndex((s) => s.id === step.id) + 1;
  const cfg = configMap(pb);
  const names = new Map((pb.steps || []).map((s, i) => [s.id, `Step ${i + 1} — ${s.name}`]));
  const retry = typeof step.retry_behavior === 'object' ? `Up to ${step.retry_behavior.max_attempts} attempts on ${(step.retry_behavior.retry_on || []).join(', ') || 'retryable errors'}` : 'Not applicable';
  return h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'step-head' },
      h('span', { class: 'step-num', style: { background: STEP_COLORS[step.type], color: '#fff' } }, idx),
      h('div', null, h('div', { class: 'bold', style: { fontSize: '16px' } }, step.name), h('div', { class: 'row small muted mt-1' }, h('code', { class: 'inline' }, step.id), h('span', { class: 'badge outline' }, typeSwatch(step.type), title(step.type)), step.requires_approval ? badge('warning', 'Human approval') : null, step.side_effects && step.side_effects !== 'none' ? badge('', `Side effects: ${step.side_effects}`, 'outline') : null)),
    ),
    h('div', null, h('div', { class: 'section-label' }, '1 · What it does'), h('div', null, step.purpose || h('span', { class: 'muted' }, '—'))),
    h('div', null, h('div', { class: 'section-label' }, '2 · Why it exists'), h('div', null, step.rationale || h('span', { class: 'muted' }, '—'))),
    h('div', null, h('div', { class: 'section-label' }, '3 · What it needs'), listOrNone(step.inputs)),
    h('div', null, h('div', { class: 'section-label' }, '4 · Depends on'), listOrNone((step.dependencies || []).map((d) => `${d} — ${names.get(d) || 'unknown step'}`))),
    step.preconditions && step.preconditions.length ? h('div', null, h('div', { class: 'section-label' }, 'Preconditions'), listOrNone(step.preconditions)) : null,
    h('div', null, h('div', { class: 'section-label' }, '5 · Instructions'), listOrNone(step.instructions, true)),
    step.decision_logic && step.decision_logic.length
      ? h(
          'div',
          null,
          h('div', { class: 'section-label' }, 'Decision logic'),
          h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'table' },
              h('thead', null, h('tr', null, h('th', null, 'Condition'), h('th', null, 'Result'), h('th', null, 'Next'))),
              h(
                'tbody',
                null,
                step.decision_logic.map((b) => {
                  const rule = (pb.decision_rules || []).find((r) => r.id === b.rule_id);
                  return h('tr', null, h('td', null, rule ? h('code', null, describeCondition(rule.when, cfg)) : b.condition, rule ? h('div', { class: 'xsmall muted' }, rule.id) : null), h('td', null, badge('', b.result, 'violet')), h('td', null, h('code', null, [].concat(b.next || []).join(', ') || '—')));
                }),
              ),
            ),
          ),
        )
      : null,
    h('div', null, h('div', { class: 'section-label' }, 'Tools'), step.tools && step.tools.length ? h('div', { class: 'row' }, step.tools.map((t) => badge('', t, 'outline'))) : h('div', { class: 'muted small' }, 'None')),
    h('div', null, h('div', { class: 'section-label' }, '6 · What it produces'), h('div', null, h('code', { class: 'inline' }, step.output.name), ` (${step.output.type})`, step.output.description ? ` — ${step.output.description}` : ''), step.output.schema ? h('details', { class: 'collapsible mt-1' }, h('summary', { class: 'small' }, 'Output schema'), jsonView(step.output.schema, { cls: 'inline' })) : null),
    h('div', null, h('div', { class: 'section-label' }, 'Validation'), listOrNone(step.validation)),
    step.postconditions && step.postconditions.length ? h('div', null, h('div', { class: 'section-label' }, 'Postconditions'), listOrNone(step.postconditions)) : null,
    h('div', null, h('div', { class: 'section-label' }, 'Failure handling'), kv([['On failure', title(step.failure_behavior)], ['Retry', retry]])),
    step.execution ? h('details', { class: 'collapsible' }, h('summary', { class: 'small' }, 'Machine-readable execution'), h('div', { class: 'mt-1' }, jsonView(step.execution, { cls: 'inline' }))) : null,
  );
}

export function qualityGateList(gate) {
  if (!gate) return null;
  const checks = gate.checks || [];
  if (checks.length) {
    return h(
      'div',
      null,
      checks.map((c) => h('div', { class: `gate-item ${c.passed ? 'ok' : 'bad'}` }, icon(c.passed ? 'circleCheck' : 'circleX'), h('div', null, h('div', null, c.label), c.details && c.details.length ? h('div', { class: 'gate-details' }, c.details.slice(0, 3).join(' ')) : null))),
    );
  }
  // Summary form stored on versions.
  const failed = gate.failed_checks || [];
  return h(
    'div',
    null,
    gate.passed
      ? h('div', { class: 'gate-item ok' }, icon('circleCheck'), h('div', null, 'All 16 quality checks passed'))
      : failed.map((c) => h('div', { class: 'gate-item bad' }, icon('circleX'), h('div', null, h('div', null, c.label), c.details && c.details.length ? h('div', { class: 'gate-details' }, c.details.slice(0, 3).join(' ')) : null))),
  );
}

const LC = ['draft', 'testing', 'passed', 'published', 'production'];
export function lifecycle(status, lastTest) {
  const map = { draft: 0, testing: 1, failed: 1, warning: 2, passed: 2, published: 3, production: 4 };
  const at = map[status] ?? 0;
  const bad = status === 'failed';
  const parts = [];
  LC.forEach((s, i) => {
    if (i) parts.push(h('span', { class: `lc-line ${i <= at ? 'done' : ''}` }));
    const reached = i < at || (i === at && ['passed', 'warning', 'published', 'production'].includes(status));
    const cls = [i === at ? (bad ? 'bad' : 'current') : '', reached ? 'done' : ''].join(' ');
    parts.push(h('span', { class: `lc-step ${cls}` }, h('span', { class: 'lc-dot' }, reached ? icon('check') : bad && i === at ? icon('x') : null), title(i === 2 && status === 'warning' ? 'Passed (warnings)' : i === 1 && bad ? 'Tests failed' : s)));
  });
  return h('div', { class: 'lifecycle', 'aria-label': `Lifecycle: ${status}` }, parts);
}

const METRIC_ORDER = [
  ['task_alignment', 'Task Alignment'],
  ['requirement_coverage', 'Requirement Coverage'],
  ['rule_adherence', 'Rule Adherence'],
  ['accuracy', 'Accuracy'],
  ['consistency', 'Consistency'],
  ['output_compliance', 'Output Compliance'],
];

export function metricTiles(metricsDoc, { compact = false } = {}) {
  if (!metricsDoc) return null;
  const m = metricsDoc.metrics || metricsDoc;
  const st = metricsDoc.statuses || {};
  return h(
    'div',
    { class: 'metrics' },
    METRIC_ORDER.map(([k, label]) => {
      const v = m[k];
      const s = st[k] || (typeof v === 'number' ? (v >= 1 ? 'pass' : v >= 0.9 ? 'warning' : 'fail') : '');
      return h(
        'div',
        { class: `metric ${v === null || v === undefined ? '' : s}`, title: v === null || v === undefined ? 'Not measured in this run' : '' },
        h('div', { class: 'metric-label' }, label),
        h('div', { class: 'metric-value' }, v === null || v === undefined ? h('span', { class: 'muted', style: { fontSize: '15px' } }, 'n/a') : pct(v, v < 1 ? 1 : 0)),
        compact ? null : h('div', { class: 'metric-bar' }, h('span', { style: { width: `${Math.round((v || 0) * 100)}%` } })),
      );
    }),
  );
}

export function checkLines(counts) {
  if (!counts) return null;
  const lines = [];
  const f = counts.functional_total;
  if (f) lines.push(h('div', { class: counts.functional_passed === f ? 'ok' : 'bad' }, `${counts.functional_passed === f ? '✓' : '✕'} ${counts.functional_passed} / ${f} functional tests passed`));
  if (counts.repeatability_runs) lines.push(h('div', { class: counts.repeatability_matched === counts.repeatability_runs ? 'ok' : 'meh' }, `${counts.repeatability_matched === counts.repeatability_runs ? '✓' : '⚠'} ${counts.repeatability_matched} / ${counts.repeatability_runs} repeatability runs matched`));
  if (counts.skipped) lines.push(h('div', { class: 'meh' }, `⚠ ${counts.skipped} test(s) skipped`));
  return h('div', { class: 'checks-line' }, lines);
}

/** Headline summary of a test run. */
export function testRunSummary(run, { stale = false } = {}) {
  if (!run) return null;
  if (run.status === 'running') {
    const p = run.progress || { done: 0, total: 1 };
    return h('div', null, h('div', { class: 'row' }, h('span', { class: 'spinner' }), h('span', { class: 'bold' }, `Running ${run.mode === 'ai' ? 'AI Execution' : 'Deterministic Fixture'} tests…`), h('span', { class: 'muted small' }, `${p.done} / ${p.total} runs`)), h('div', { class: 'progress mt-2' }, h('span', { style: { width: `${Math.round((p.done / Math.max(1, p.total)) * 100)}%` } })));
  }
  if (run.status === 'error') return h('div', { class: 'banner fail' }, icon('circleX'), h('div', null, h('div', { class: 'banner-title' }, 'Test run failed to execute'), h('div', { class: 'small' }, run.error && run.error.message)));
  const m = run.metrics;
  const status = run.result_status || (run.status === 'cancelled' ? 'cancelled' : 'fail');
  return h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'status-hero' },
      h('span', { class: `status-word ${status}` }, status === 'cancelled' ? 'CANCELLED' : status.toUpperCase()),
      m ? checkLines(m.counts) : null,
      h('div', { class: 'spacer' }),
      h('div', { class: 'small muted', style: { textAlign: 'right' } }, `${run.mode === 'ai' ? 'AI Execution' : 'Deterministic Fixture'} · v${run.version}`, h('br'), run.environment && run.environment.model ? `${run.environment.model} · ` : '', new Date(run.ended_at || run.started_at).toLocaleString()),
    ),
    stale ? h('div', { class: 'banner warn', style: { marginBottom: 0 } }, icon('alert'), h('div', { class: 'banner-body' }, h('div', { class: 'banner-title' }, 'Playbook changed since this test run'), h('div', { class: 'small' }, 'These results describe an earlier revision. Run the tests again.'))) : null,
    m ? metricTiles(m) : null,
    m && m.reasons && m.reasons.length && status !== 'pass' ? h('ul', { class: 'bullets small text-2' }, m.reasons.map((r) => h('li', null, r))) : null,
    m ? h('div', { class: 'xsmall muted' }, m.disclaimer) : null,
  );
}

function expectedText(r) {
  if (r.expected !== undefined && r.expected !== null) return compactJson(r.expected, 90);
  if (r.expected_error) return `error ${r.expected_error}`;
  if (r.expected_behavior) return r.expected_behavior;
  return `status: ${r.expected_status}`;
}

function actualText(run) {
  if (!run) return '—';
  if (run.output !== undefined && run.output !== null) return compactJson(run.output, 90);
  if (run.error) return `${run.status}: ${run.error.code}`;
  return run.status;
}

/** Per-test results with diagnosis. */
export function testResults(run) {
  const results = run.results || [];
  if (!results.length) return h('div', { class: 'muted small' }, 'No results yet.');
  const rows = [];
  for (const r of results) {
    const first = (r.runs || [])[0];
    const bad = (r.runs || []).find((x) => !x.matched);
    rows.push(
      h(
        'tr',
        null,
        h('td', null, h('div', { class: 'cell-title' }, r.name), h('div', { class: 'cell-sub' }, h('code', null, r.test_id), ' · ', title(r.category))),
        h('td', null, h('code', null, compactJson(r.input, 70))),
        h('td', null, h('code', null, expectedText(r))),
        h('td', null, h('code', null, actualText(bad || first))),
        h('td', { class: 'num' }, (r.runs || []).length > 1 ? h('div', null, h('div', { class: 'run-dots', title: `${r.runs.filter((x) => x.matched).length} of ${r.runs.length} runs matched` }, r.runs.map((x) => h('span', { class: x.matched ? '' : 'bad' }))), h('div', { class: 'xsmall muted mt-1' }, `agreement ${pct(r.agreement)}`)) : '1'),
        h('td', null, badge(r.status === 'skipped' ? 'skipped' : r.status)),
      ),
    );
    if (r.skipped && r.skip_reason) {
      rows.push(h('tr', null, h('td', { colspan: 6, class: 'small text-2', style: { background: 'var(--surface-2)' } }, r.skip_reason)));
    }
    if (r.diagnosis && r.diagnosis.length) {
      rows.push(h('tr', null, h('td', { colspan: 6, style: { background: r.status === 'fail' ? 'var(--fail-soft)' : 'var(--warn-soft)' } }, h('ul', { class: 'bullets small', style: { margin: 0 } }, r.diagnosis.map((d) => h('li', null, d))))));
    }
    if (r.evaluation && (r.evaluation.issues || []).length && r.status === 'pass') {
      rows.push(h('tr', null, h('td', { colspan: 6, class: 'small muted' }, `Evaluator notes: ${r.evaluation.issues.join(' ')}`)));
    }
  }
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'table fixed results-table' },
      h('colgroup', null, h('col', { class: 'c-test' }), h('col', { class: 'c-json' }), h('col', { class: 'c-json' }), h('col', { class: 'c-json' }), h('col', { class: 'c-runs' }), h('col', { class: 'c-status' })),
      h('thead', null, h('tr', null, h('th', null, 'Test'), h('th', null, 'Input'), h('th', null, 'Expected'), h('th', null, 'Actual'), h('th', { class: 'num' }, 'Runs'), h('th', null, 'Status'))),
      h('tbody', null, rows),
    ),
  );
}

/** Repair suggestion cards (§48): never applied without approval. */
export function suggestionCards(run, { onApply, onDismiss } = {}) {
  const list = (run.repair_suggestions || []).filter((s) => s.status !== 'dismissed');
  if (!list.length) return null;
  return h(
    'div',
    null,
    list.map((s) =>
      h(
        'div',
        { class: 'suggestion' },
        h('div', { class: 'row between' }, h('div', { class: 'row' }, badge('fail', 'FAIL'), h('span', { class: 'bold' }, s.problem)), h('div', { class: 'row' }, badge(s.source === 'ai' ? 'accent' : '', s.source === 'ai' ? 'AI suggestion' : 'Rule analysis', s.source === 'ai' ? 'accent' : 'outline'), s.verification && s.verification.verified ? badge('pass', 'Verified by re-running tests') : badge('warning', 'Not verified'))),
        s.expected && s.actual
          ? h('dl', { class: 'expect-grid' }, h('dt', null, 'Expected'), h('dd', null, `${s.expected.input_value} → ${s.expected.result}`), h('dt', null, 'Actual'), h('dd', null, `${s.expected.input_value} → ${s.actual.result}`))
          : null,
        h('div', { class: 'small text-2 mt-1' }, s.explanation),
        h('div', { class: 'fix' }, 'Suggested fix: ', s.fix_summary),
        s.verification ? h('div', { class: 'xsmall muted' }, s.verification.verified ? `Fixes ${s.verification.fixed.join(', ')} · breaks nothing${s.verification.all_pass_after ? ' · whole suite passes afterwards' : ''}` : s.verification.error || s.verification.note || `Still failing: ${(s.verification.still_failing || []).join(', ')}`) : null,
        h('details', { class: 'collapsible mt-1' }, h('summary', { class: 'small' }, 'Patch (JSON Patch)'), h('div', { class: 'mt-1' }, jsonView(s.patch, { cls: 'inline' }))),
        s.status === 'applied'
          ? h('div', { class: 'row mt-2' }, badge('pass', `Applied as v${s.applied_version}`))
          : h('div', { class: 'row mt-2' }, onApply ? button('Approve & create new version', { kind: 'primary', size: 'sm', ic: 'check', onClick: () => onApply(s) }) : null, onDismiss ? button('Dismiss', { size: 'sm', kind: 'ghost', onClick: () => onDismiss(s) }) : null, h('span', { class: 'xsmall muted' }, 'Nothing changes until you approve. Published versions stay untouched.')),
      ),
    ),
  );
}

export function statusMapFromTrace(trace) {
  const m = {};
  for (const t of trace || []) m[t.step_id] = t.status;
  return m;
}
