// AI-assisted repair (spec §48): Test → Failure → Identify Step → Explain →
// Suggest Change → User Approves → New Version → Retest.
// Heuristics handle rule-boundary mistakes exactly (e.g. `>` vs `>=`) and every
// suggestion is verified by re-running the suite on a patched copy before it is
// shown. Nothing is applied without the user's approval.
import { REPAIR_SYSTEM } from '../ai/prompts.js';
import { applyPatch } from '../playbooks/patch.js';
import { normalizePlaybook } from '../playbooks/schema.js';
import { executeDeterministic, decisionOutputFields } from '../engine/deterministic.js';
import { normalizeOperator, resolveField, resolveValue, OPERATORS } from '../engine/rules.js';
import { configMap } from '../playbooks/schema.js';
import { judgeRun } from './compare.js';
import { newId, nowIso, isPlainObject, deepClone } from '../util.js';

const FLIP = {
  greater_than: 'greater_than_or_equal',
  greater_than_or_equal: 'greater_than',
  less_than: 'less_than_or_equal',
  less_than_or_equal: 'less_than',
};

const sym = (op) => (OPERATORS[op] ? OPERATORS[op].symbol : op);

/** Run the whole suite deterministically against a playbook; returns { passed:Set, failed:Set }. */
export async function simulateSuite(pb, tests, { now } = {}) {
  const passed = new Set();
  const failed = new Set();
  for (const t of tests) {
    const run = await executeDeterministic(pb, { input: t.input, configuration: t.configuration, fixtures: t.fixtures, now: t.now ? new Date(t.now) : now || new Date(), autoApprove: true, backoff: false });
    (judgeRun(t, run).matched ? passed : failed).add(t.id);
  }
  return { passed, failed };
}

async function verify(pb, patch, tests, failingIds) {
  let patched;
  try {
    patched = normalizePlaybook(applyPatch(pb, patch), { id: pb.id, version: pb.version });
  } catch (err) {
    return { verified: false, error: `Patch does not apply: ${err.message}`, fixed: [], broken: [], still_failing: failingIds };
  }
  const before = await simulateSuite(pb, tests);
  const after = await simulateSuite(patched, tests);
  const fixed = failingIds.filter((id) => after.passed.has(id));
  const broken = [...before.passed].filter((id) => after.failed.has(id));
  return {
    verified: fixed.length > 0 && broken.length === 0,
    fixed,
    broken,
    still_failing: [...after.failed],
    all_pass_after: after.failed.size === 0,
  };
}

/** Deterministic diagnosis of decision-rule failures. */
export async function heuristicSuggestions(pb, testRun, tests) {
  const failures = (testRun.results || []).filter((r) => r.status === 'fail' || r.status === 'warning');
  if (!failures.length) return [];
  const decisionFields = decisionOutputFields(pb);
  const config = configMap(pb);
  const suggestions = [];
  const seen = new Set();

  for (const res of failures) {
    const test = tests.find((t) => t.id === res.test_id);
    if (!test || !isPlainObject(test.expected)) continue;
    const field = decisionFields.find((f) => test.expected[f] !== undefined);
    if (!field) continue;
    const expected = test.expected[field];
    const badRun = (res.runs || []).find((r) => !r.matched) || (res.runs || [])[0];
    const actual = badRun && badRun.output ? badRun.output[field] : undefined;
    if (actual === expected) continue;
    const decision = (badRun && badRun.decisions && badRun.decisions[0]) || null;
    const stepId = decision ? decision.step_id : (pb.steps.find((s) => s.execution && s.execution.op === 'decide') || {}).id;
    const step = pb.steps.find((s) => s.id === stepId);
    if (!step) continue;
    const subject = step.execution && step.execution.subject;
    const ruleIds = (step.execution && step.execution.rules) || pb.decision_rules.filter((r) => r.step_id === step.id).map((r) => r.id);
    const candidates = pb.decision_rules.filter((r) => ruleIds.includes(r.id) && String(r.result) === String(expected));
    const scope = { input: test.input, config: { ...config, ...(test.configuration || {}) }, state: {}, steps: {} };

    for (const rule of candidates) {
      const when = rule.when || {};
      const op = normalizeOperator(when.operator);
      if (!FLIP[op]) continue;
      const f = resolveField(when.field, scope, subject);
      const { value: threshold, ref } = resolveValue(when, scope);
      if (typeof f.value !== 'number' || typeof threshold !== 'number') continue;
      const ruleIndex = pb.decision_rules.findIndex((r) => r.id === rule.id);
      let patch = null;
      let problem;
      let explanation;
      let fixSummary;
      if (f.value === threshold) {
        const newOp = FLIP[op];
        patch = [{ op: 'replace', path: `/decision_rules/${ruleIndex}/when/operator`, value: newOp }];
        const bi = (step.decision_logic || []).findIndex((b) => b.rule_id === rule.id);
        if (bi >= 0 && step.decision_logic[bi].condition && step.decision_logic[bi].condition.includes(sym(op))) {
          const si = pb.steps.findIndex((s) => s.id === step.id);
          const updated = step.decision_logic[bi].condition.replace(sym(op), sym(newOp));
          patch.push({ op: 'replace', path: `/steps/${si}/decision_logic/${bi}/condition`, value: updated });
        }
        problem = 'Boundary condition violated.';
        explanation = `Expected: ${f.value} → ${expected}. Actual: ${f.value} → ${actual ?? 'no result'}. ${rule.id} (${rule.name}) uses \`${sym(op)}\`, so a value exactly equal to ${ref ? `${ref.replace(/^config\./, '')} (${threshold})` : threshold} does not match and falls through to ${decision && decision.rule_id ? decision.rule_id : 'another rule'}.`;
        fixSummary = `Change \`${sym(op)}\` to \`${sym(newOp)}\` in ${rule.id} (${rule.name}).`;
      } else {
        // Threshold mismatch: requirement literal vs configured value.
        const req = (pb.requirements || []).find((r) => r.rule && String(r.result) === String(expected) && typeof r.rule.value === 'number' && normalizeOperator(r.rule.operator) === op);
        if (req && req.rule.value !== threshold && ref && ref.startsWith('config.')) {
          const name = ref.slice(7);
          const ci = pb.configuration.findIndex((c) => c.name === name);
          if (ci >= 0) {
            patch = [{ op: 'replace', path: `/configuration/${ci}/value`, value: req.rule.value }];
            problem = 'Configured threshold differs from the requirement.';
            explanation = `${req.id} says "${req.text}", but ${name} is ${threshold}. With ${f.value} the rule ${rule.id} does not produce ${expected}.`;
            fixSummary = `Set ${name} to ${req.rule.value}.`;
          }
        }
      }
      if (!patch) continue;
      const key = JSON.stringify(patch);
      if (seen.has(key)) {
        const existing = suggestions.find((s) => JSON.stringify(s.patch) === key);
        if (existing && !existing.test_ids.includes(res.test_id)) existing.test_ids.push(res.test_id);
        continue;
      }
      seen.add(key);
      suggestions.push({
        id: newId('fix'),
        source: 'heuristic',
        status: 'proposed',
        test_ids: [res.test_id],
        test_name: res.name,
        step_id: step.id,
        rule_id: rule.id,
        problem,
        explanation,
        fix_summary: fixSummary,
        expected: { input_value: f.value, result: expected },
        actual: { result: actual ?? null },
        patch,
        created_at: nowIso(),
      });
    }
  }
  const failingIds = failures.map((r) => r.test_id);
  for (const s of suggestions) s.verification = await verify(pb, s.patch, tests, failingIds);
  return suggestions.filter((s) => s.verification.fixed.length > 0);
}

/** Ask the repair model for suggestions, then verify each patch by simulation. */
export async function aiSuggestions(ai, pb, testRun, tests) {
  const failures = (testRun.results || []).filter((r) => r.status === 'fail' || r.status === 'warning');
  if (!failures.length) return { suggestions: [], usage: null };
  const user = {
    playbook: { ...deepClone(pb), tests: undefined },
    failing_tests: failures.slice(0, 8).map((r) => {
      const t = tests.find((x) => x.id === r.test_id) || {};
      const bad = (r.runs || []).find((x) => !x.matched) || (r.runs || [])[0] || {};
      return {
        id: r.test_id,
        name: r.name,
        category: r.category,
        input: t.input,
        expected: t.expected,
        expected_status: t.expected_status,
        expected_behavior: t.expected_behavior,
        actual_status: bad.status,
        actual_output: bad.output,
        error: bad.error,
        mismatches: bad.mismatches,
        trace: (bad.trace || []).slice(0, 20),
        evaluation_issues: r.evaluation ? r.evaluation.issues : undefined,
      };
    }),
    mode: testRun.mode,
    note: testRun.mode === 'ai' ? 'In AI mode a failure can come from the model not following clear rules; then strengthen the step instructions or rules.' : 'Deterministic mode: the playbook logic itself produced these results.',
  };
  const res = await ai.json('evaluation', {
    system: REPAIR_SYSTEM,
    user,
    expect: 'repair_suggestion',
    temperature: 0.1,
    max_tokens: 4000,
    validate: (env) => (Array.isArray(env.data.suggestions) ? null : 'data.suggestions must be an array.'),
  });
  const failingIds = failures.map((r) => r.test_id);
  const suggestions = [];
  for (const s of res.envelope.data.suggestions.slice(0, 4)) {
    if (!isPlainObject(s)) continue;
    const patch = Array.isArray(s.patch) ? s.patch.filter((op) => isPlainObject(op) && op.op && typeof op.path === 'string') : [];
    const sug = {
      id: newId('fix'),
      source: 'ai',
      status: 'proposed',
      test_ids: failingIds,
      step_id: s.step_id || null,
      rule_id: s.rule_id || null,
      problem: String(s.problem || 'Test failure'),
      explanation: String(s.explanation || ''),
      fix_summary: String(s.fix_summary || ''),
      patch,
      created_at: nowIso(),
    };
    sug.verification = patch.length ? await verify(pb, patch, tests, failingIds) : { verified: false, fixed: [], broken: [], still_failing: failingIds, note: 'No patch proposed.' };
    if (testRun.mode === 'ai' && patch.length) sug.verification.note = 'Verified with the deterministic engine; rerun AI tests after applying to confirm model behavior.';
    suggestions.push(sug);
  }
  return { suggestions, usage: res.usage };
}
