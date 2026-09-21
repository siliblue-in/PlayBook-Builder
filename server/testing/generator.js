// Automatic test generation (spec §43).
// 1) Deterministic analysis: normal, boundary, missing-data, negative, edge and
//    repeatability cases derived from machine-readable rules. Expectations come
//    from REQUIREMENT rules (the user's intent) when present, so a buggy decision
//    rule cannot write its own passing tests.
// 2) AI generation (testing model), also instructed to derive expectations from
//    intent and requirements rather than from the playbook's rules.
import { decide, conditionFields, normalizeOperator, resolveValue } from '../engine/rules.js';
import { decisionOutputFields } from '../engine/deterministic.js';
import { testGeneratorPrompt, testPlanPrompt } from '../ai/prompts.js';
import { mergeUsage } from '../ai/service.js';
import { nullReporter } from '../progress.js';
import { configMap, procedureOf } from '../playbooks/schema.js';
import { deepClone, getPath, setPath, deletePath, isPlainObject, stableStringify, pad2, asArray } from '../util.js';

export const CATEGORIES = ['normal', 'boundary', 'negative', 'missing_data', 'edge', 'repeatability', 'error_handling'];

function normCategory(c) {
  const s = String(c || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (CATEGORIES.includes(s)) return s;
  if (/bound/.test(s)) return 'boundary';
  if (/miss|null|absent/.test(s)) return 'missing_data';
  if (/neg|invalid|error/.test(s)) return 'negative';
  if (/repeat|consist/.test(s)) return 'repeatability';
  if (/edge|corner/.test(s)) return 'edge';
  return 'normal';
}

/** Normalize a test case from any source. */
export function normalizeTest(raw, index = 0, { repeatRuns = 20, source = 'manual' } = {}) {
  const t = isPlainObject(raw) ? raw : {};
  const category = normCategory(t.category);
  const runs = Number.isInteger(t.runs) && t.runs > 0 ? Math.min(100, t.runs) : category === 'repeatability' ? repeatRuns : 1;
  const test = {
    id: String(t.id || `tc_${pad2(index + 1)}`).replace(/[^A-Za-z0-9_-]/g, '_'),
    name: String(t.name || `Test ${index + 1}`).slice(0, 80),
    category,
    description: String(t.description || ''),
    input: isPlainObject(t.input) ? t.input : {},
    runs,
    covers: {
      requirements: asArray(t.covers && t.covers.requirements).map(String),
      rules: asArray(t.covers && t.covers.rules).map(String),
    },
    source: t.source || source,
  };
  if (t.expected !== undefined && t.expected !== null && !(isPlainObject(t.expected) && !Object.keys(t.expected).length)) test.expected = t.expected;
  const es = String(t.expected_status || '').toLowerCase();
  if (['completed', 'failed', 'needs_input', 'error', 'awaiting_approval'].includes(es)) test.expected_status = es;
  if (t.expected_error) test.expected_error = String(t.expected_error).toUpperCase();
  if (t.expected_status === 'failed' && !t.expected_error && !test.expected) test.expected_status = 'error';
  if (t.expected_behavior) test.expected_behavior = String(t.expected_behavior);
  if (isPlainObject(t.fixtures)) test.fixtures = t.fixtures;
  if (isPlainObject(t.configuration)) test.configuration = t.configuration;
  if (t.now) test.now = String(t.now);
  if (t.oracle) test.oracle = String(t.oracle);
  if (!test.expected && !test.expected_status && !test.expected_error && !test.expected_behavior) test.expected_status = 'completed';
  return test;
}

function testSignature(t) {
  return stableStringify({ input: t.input, expected: t.expected ?? null, s: t.expected_status ?? null, e: t.expected_error ?? null, r: t.runs > 1, c: t.configuration ?? null });
}

/** Merge new tests into an existing suite: skip duplicates, give fresh ids. */
export function mergeTests(existing, incoming) {
  const seen = new Set(existing.map(testSignature));
  const ids = new Set(existing.map((t) => t.id));
  let n = existing.reduce((m, t) => Math.max(m, Number((/^tc_(\d+)$/.exec(t.id) || [])[1] || 0)), 0);
  const added = [];
  for (const t of incoming) {
    const sig = testSignature(t);
    if (seen.has(sig)) continue;
    seen.add(sig);
    let id = t.id;
    if (!id || ids.has(id) || /^tc_\d+$/.test(id)) {
      do id = `tc_${pad2(++n)}`;
      while (ids.has(id));
    }
    ids.add(id);
    added.push({ ...t, id });
  }
  return { tests: existing.concat(added), added };
}

// ---------------------------------------------------------------- deterministic

function baseInput(pb) {
  const input = {};
  const missing = [];
  for (const i of pb.inputs || []) {
    if (i.example !== undefined) input[i.id] = deepClone(i.example);
    else if (i.required) missing.push(i.id);
  }
  return { input, missing };
}

/** Find where a rule field lives inside the input object. */
function locateField(field, input, subjectPath) {
  const f = String(field).replace(/^input\./, '');
  if (getPath(input, f) !== undefined) return f;
  if (subjectPath && subjectPath.startsWith('input.')) {
    const p = `${subjectPath.slice(6)}.${f}`;
    if (getPath(input, p) !== undefined || getPath(input, subjectPath.slice(6)) !== undefined) return p;
  }
  const last = f.split('.').pop();
  let found = null;
  const walk = (obj, prefix, depth) => {
    if (found || !isPlainObject(obj) || depth > 5) return;
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (k === last) {
        found = p;
        return;
      }
      walk(v, p, depth + 1);
    }
  };
  walk(input, '', 0);
  return found;
}

function inputFieldSchema(pb, path) {
  const [root, ...rest] = path.split('.');
  const def = (pb.inputs || []).find((i) => i.id === root);
  let s = def && def.schema;
  for (const k of rest) {
    if (!s || !s.properties) return null;
    s = s.properties[k];
  }
  return s || null;
}

/**
 * Build the oracle: requirement rules when available (intent), else the
 * playbook's decision rules (flagged as self-derived).
 */
function buildOracle(pb) {
  const decisionSteps = (pb.steps || []).filter((s) => s.execution && s.execution.op === 'decide' && !s.execution.for_each);
  const fields = decisionOutputFields(pb);
  if (!decisionSteps.length || !fields.length) return null;
  const step = decisionSteps[0];
  const subject = step.execution.subject || null;
  const reqRules = (pb.requirements || [])
    .filter((r) => r.rule && r.result !== undefined)
    .map((r, i) => {
      const op = normalizeOperator(r.rule.operator);
      return { id: r.id, name: r.text, priority: op === 'not_exists' || op === 'is_empty' ? -1 : i, when: r.rule, result: r.result, requirement: r.id };
    });
  const stepRules = (pb.decision_rules || []).filter((r) => (step.execution.rules || []).includes(r.id) || r.step_id === step.id);
  const useReq = reqRules.length > 0;
  return {
    source: useReq ? 'requirements' : 'decision_rules',
    rules: useReq ? reqRules : stepRules,
    stepRules,
    subject,
    field: fields[0],
    step,
  };
}

function outputIdentityFields(pb) {
  // Output fields copied straight from the input (e.g. customer: input.customer.name).
  const out = [];
  for (const s of pb.steps || []) {
    const ex = s.execution;
    if (!ex || ex.op !== 'output' || !isPlainObject(ex.mapping)) continue;
    for (const [k, v] of Object.entries(ex.mapping)) {
      if (typeof v === 'string' && /^input(\.[A-Za-z0-9_]+)+$/.test(v.trim())) out.push({ field: k, path: v.trim().slice(6) });
    }
  }
  return out;
}

export function generateDeterministicTests(pb, { repeatRuns = 20 } = {}) {
  const notes = [];
  const { input: base, missing } = baseInput(pb);
  if (missing.length) {
    return { tests: [], notes: [`Add example values for required inputs (${missing.join(', ')}) so tests can be generated.`] };
  }
  const oracle = buildOracle(pb);
  const config = configMap(pb);
  const identity = outputIdentityFields(pb);
  const tests = [];
  const covers = (extra = []) => ({ requirements: [...new Set(extra)], rules: [] });
  const reqsOfType = (...types) => (pb.requirements || []).filter((r) => types.includes(r.type)).map((r) => r.id);

  const expectFor = (input) => {
    if (!oracle) return null;
    const scope = { input, config, state: {}, steps: {} };
    const d = decide(oracle.rules, scope, oracle.source === 'requirements' ? null : oracle.subject);
    if (!d.matched) return null;
    const exp = {};
    for (const idf of identity) {
      const v = getPath(input, idf.path);
      if (v !== undefined && (typeof v !== 'object' || v === null)) exp[idf.field] = v;
    }
    exp[oracle.field] = d.result;
    const ruleHit = decide(oracle.stepRules, scope, oracle.subject);
    return { expected: exp, requirement: d.rule_id, rule: ruleHit.matched ? ruleHit.rule_id : null };
  };

  const add = (name, category, description, input, extra = {}) => {
    const e = expectFor(input);
    const t = {
      id: '',
      name,
      category,
      description,
      input,
      runs: 1,
      covers: covers(),
      source: 'generated_deterministic',
      oracle: oracle ? oracle.source : 'none',
      ...extra,
    };
    if (!extra.expected_status && !extra.expected_error) {
      if (e) {
        t.expected = e.expected;
        if (e.requirement && oracle.source === 'requirements') t.covers.requirements.push(e.requirement);
        if (e.rule) t.covers.rules.push(e.rule);
      } else t.expected_status = 'completed';
    }
    if (category === 'normal') t.covers.requirements.push(...reqsOfType('functional', 'output'));
    if (category === 'repeatability') t.covers.requirements.push(...reqsOfType('non_functional'));
    if (category === 'missing_data' || category === 'negative') t.covers.requirements.push(...reqsOfType('data', 'constraint'));
    t.covers.requirements = [...new Set(t.covers.requirements)];
    tests.push(t);
  };

  add('Baseline example', 'normal', 'The documented example input runs end to end.', deepClone(base));

  if (!oracle) {
    notes.push('No machine-readable decision rules with an output mapping were found, so only mechanics tests were generated. Use AI generation for semantic tests.');
  } else {
    if (oracle.source !== 'requirements') notes.push('Expectations were derived from the playbook\'s own decision rules (no machine-readable requirement rules). Review them against your intent.');
    const seenOutcomes = new Set();
    const e0 = expectFor(base);
    if (e0) seenOutcomes.add(String(e0.expected[oracle.field]));
    const numericRules = [];
    for (const r of oracle.rules) {
      const when = r.when || {};
      const op = normalizeOperator(when.operator);
      for (const f of conditionFields(when)) {
        const path = locateField(f, base, oracle.source === 'requirements' ? null : oracle.subject);
        if (!path) continue;
        if (['greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal'].includes(op)) {
          const { value } = resolveValue(when, { input: base, config, state: {} });
          if (typeof value === 'number') numericRules.push({ rule: r, path, op, t: value });
        } else if (op === 'equals' || op === 'in') {
          const v = op === 'in' ? asArray(when.value)[0] : when.value;
          if (v !== undefined) {
            const input = deepClone(base);
            setPath(input, path, v);
            const e = expectFor(input);
            if (e && !seenOutcomes.has(String(e.expected[oracle.field]))) {
              seenOutcomes.add(String(e.expected[oracle.field]));
              add(`Normal · ${e.expected[oracle.field]}`, 'normal', `Input that should produce ${e.expected[oracle.field]}.`, input);
            }
          }
        }
      }
    }
    const seenBoundary = new Set();
    const negatedFields = new Set();
    for (const nr of numericRules) {
      const schema = inputFieldSchema(pb, nr.path) || {};
      const integer = Number.isInteger(getPath(base, nr.path)) || Number.isInteger(nr.t) || [].concat(schema.type || []).includes('integer');
      const delta = integer ? 1 : 0.01;
      const min = typeof schema.minimum === 'number' ? schema.minimum : null;
      // Normal case for this rule's outcome.
      const far = nr.op.startsWith('greater') ? nr.t + Math.max(delta * 5, Math.abs(nr.t) * 0.5) : nr.t - Math.max(delta * 5, Math.abs(nr.t) * 0.5);
      const farVal = integer ? Math.round(far) : Math.round(far * 100) / 100;
      if (min === null || farVal >= min) {
        const input = deepClone(base);
        setPath(input, nr.path, farVal);
        const e = expectFor(input);
        if (e && !seenOutcomes.has(String(e.expected[oracle.field]))) {
          seenOutcomes.add(String(e.expected[oracle.field]));
          add(`Normal · ${e.expected[oracle.field]}`, 'normal', `${nr.path} = ${farVal} should produce ${e.expected[oracle.field]}.`, input);
        }
      }
      for (const [label, v] of [
        ['below', nr.t - delta],
        ['at', nr.t],
        ['above', nr.t + delta],
      ]) {
        const val = integer ? Math.round(v) : Math.round(v * 100) / 100;
        const key = `${nr.path}=${val}`;
        if (seenBoundary.has(key) || (min !== null && val < min)) continue;
        seenBoundary.add(key);
        const input = deepClone(base);
        setPath(input, nr.path, val);
        add(`Boundary ${val}`, 'boundary', `${nr.path} = ${val} (${label} the threshold ${nr.t}).`, input);
      }
      // Edge: zero and a very large value.
      for (const [name, v] of [
        ['Zero', 0],
        ['Very large', integer ? 100000 : 100000.5],
      ]) {
        const key = `${nr.path}=${v}`;
        if (seenBoundary.has(key) || (min !== null && v < min)) continue;
        seenBoundary.add(key);
        const input = deepClone(base);
        setPath(input, nr.path, v);
        add(`${name} ${nr.path.split('.').pop()}`, 'edge', `${nr.path} = ${v}.`, input);
      }
      // Negative: wrong type, and below minimum when a minimum exists.
      if (negatedFields.has(nr.path)) continue;
      negatedFields.add(nr.path);
      const neg = deepClone(base);
      setPath(neg, nr.path, 'not-a-number');
      add(`Invalid ${nr.path.split('.').pop()} type`, 'negative', `${nr.path} is text instead of a number; the run must reject it.`, neg, { expected_status: 'error' });
      if (min !== null) {
        const below = deepClone(base);
        setPath(below, nr.path, min - (integer ? 1 : 0.5));
        add(`${nr.path.split('.').pop()} below minimum`, 'negative', `${nr.path} below its minimum (${min}); the run must reject it.`, below, { expected_status: 'error' });
      }
    }
    // Missing data for every field referenced by the rules.
    const fields = new Set();
    for (const r of oracle.rules) for (const f of conditionFields(r.when)) {
      const p = locateField(f, base, oracle.source === 'requirements' ? null : oracle.subject);
      if (p) fields.add(p);
    }
    for (const p of fields) {
      const input = deepClone(base);
      deletePath(input, p);
      const e = expectFor(input);
      if (e) add(`Missing ${p.split('.').pop()}`, 'missing_data', `${p} is absent; the playbook must not infer it.`, input);
      else add(`Missing ${p.split('.').pop()}`, 'missing_data', `${p} is absent; the run must stop and report it.`, input, { expected_status: 'error' });
    }
  }
  // Missing required input fields (from input schemas).
  for (const i of pb.inputs || []) {
    const req = (i.schema && Array.isArray(i.schema.required) ? i.schema.required : []).map((k) => `${i.id}.${k}`);
    for (const p of req) {
      const input = deepClone(base);
      deletePath(input, p);
      add(`Missing ${p.split('.').pop()}`, 'missing_data', `Required field ${p} is absent; the run must stop.`, input, { expected_status: 'error' });
    }
    if (i.required) {
      const input = deepClone(base);
      delete input[i.id];
      add(`Missing ${i.name}`, 'missing_data', `Required input ${i.id} is absent; the run must stop or ask for input.`, input, { expected_status: 'error' });
    }
  }
  add('Repeatability', 'repeatability', `The baseline input run ${repeatRuns} times must produce the same structured result every time.`, deepClone(base), {});
  tests[tests.length - 1].runs = repeatRuns;
  return { tests: tests.map((t, i) => normalizeTest({ ...t, id: `tc_${pad2(i + 1)}` }, i, { repeatRuns, source: 'generated_deterministic' })), notes };
}

// ---------------------------------------------------------------- AI

// Small batches keep AI test generation reliable: a 4-test JSON answer is a
// few hundred tokens, which even a 9B model on a 16k context produces without
// being cut off. The old single 8,000-token "write the whole suite" call was
// the stage that failed again and again on local models.
const TEST_BATCH_SIZE = 4;
const TEST_MAX_BATCHES = 6;
const TEST_BATCH_MAX_TOKENS = 3500;

/** Fallback suite size when the planner call fails (still bounded and sane). */
function heuristicTarget(pb) {
  const reqs = pb.requirements || {};
  const n =
    4 +
    asArray(reqs.functional).length +
    asArray(reqs.business_rules).length +
    asArray(reqs.data).length +
    (pb.decision_rules || []).length;
  return Math.max(6, Math.min(16, n));
}

/**
 * AI test generation (spec §43, v1.7): plan the suite, then write it in
 * small batches. Every batch is merged immediately, retried by the JSON
 * repair loop, and — if it still fails — skipped with a note instead of
 * throwing the whole generation away. Partial success beats nothing.
 *
 * `maxTests` is the PC Performance Tier cap for local models (Low Tier = 4,
 * Mid Range = 8, High End = 16; null = uncapped): a weak PC must never be
 * asked for a huge suite, because that is exactly how generation ended in a
 * loop of timeouts. `report` is a progress reporter ({ step, detail }) from
 * server/progress.js; batch progress ("Batch 2 of 5 — 8 of 20 tests")
 * reaches the UI live.
 */
export async function generateAITests(ai, pb, { intent = null, repeatRuns = 20, existing = [], report = nullReporter, maxTests = null } = {}) {
  const proc = procedureOf(pb);
  const base = {
    objective: pb.objective,
    scope: pb.scope,
    confirmed_intent: intent,
    requirements: pb.requirements,
    inputs: pb.inputs,
    configuration: pb.configuration,
    output_contract: pb.output,
    error_handling: pb.error_handling,
    workflow_summary: (pb.steps || []).map((s) => ({ id: s.id, name: s.name, type: s.type, decision_logic: s.decision_logic, failure_behavior: s.failure_behavior })),
    decision_rules_for_reference_only: proc.decision_rules,
  };

  // 1) Plan the suite (cheap call, ~100 output tokens). Never fatal.
  let target = null;
  let focus = [];
  let planned = null;
  try {
    report.step('plan', 'active', 'Deciding how many tests the suite needs');
    const res = await ai.json('testing', {
      system: testPlanPrompt({ repeatRuns }),
      user: { ...base, existing_test_names: existing.map((t) => t.name), instruction: 'Plan the suite: how many tests, and which categories need the most coverage.' },
      expect: 'test_plan',
      temperature: 0.2,
      max_tokens: 800,
      maxRepairs: 0,
      validate: (env) => (!Number.isInteger(env.data.total) || env.data.total < 1 || env.data.total > 40 ? 'data.total must be an integer between 1 and 40.' : null),
    });
    target = res.envelope.data.total;
    focus = asArray(res.envelope.data.focus).map(String).slice(0, 3);
    report.step('plan', 'done', `Suite plan: about ${target} tests${focus.length ? ` · focus on ${focus.join(', ')}` : ''}`);
  } catch {
    target = heuristicTarget(pb);
    report.step('plan', 'done', `Planner unavailable — aiming for about ${target} tests`);
  }

  // 2) The PC Performance Tier caps the suite on local hardware so a weak PC
  // is never handed a marathon it cannot finish.
  planned = target;
  if (Number.isInteger(maxTests) && maxTests > 0 && target > maxTests) {
    target = maxTests;
    report.step('plan', 'done', `PC Performance Tier caps this suite at ${maxTests} tests (the planner wanted ${planned}) — smaller suite, shorter run`);
  }

  // 3) Write the suite in batches, merging as we go.
  const batches = Math.max(1, Math.min(TEST_MAX_BATCHES, Math.ceil(target / TEST_BATCH_SIZE)));
  const suite = [];
  const names = new Set(existing.map((t) => t.name));
  const notes = [];
  let usage = null;
  let model = null;
  let failedBatches = 0;
  let batchesUsed = 0;
  for (let i = 1; i <= batches; i++) {
    batchesUsed = i;
    report.step('tests', 'active', `Batch ${i} of ${batches} — writing up to ${TEST_BATCH_SIZE} tests (${suite.length} of about ${target} written)`);
    try {
      const res = await ai.json('testing', {
        system: testGeneratorPrompt({ repeatRuns, count: TEST_BATCH_SIZE, existing: [...names], focus }),
        user: { ...base, existing_test_names: [...names], batch: `${i} of ${batches}`, instruction: `Write up to ${TEST_BATCH_SIZE} MORE test cases (batch ${i} of ${batches}). Follow the requirements and intent, even if a decision rule disagrees.` },
        expect: 'test_case',
        temperature: 0.2,
        max_tokens: TEST_BATCH_MAX_TOKENS,
        maxRepairs: 1,
        validate: (env) => (Array.isArray(env.data.tests) ? null : 'data.tests must be an array.'),
      });
      usage = mergeUsage(usage, res.usage);
      model = res.model || model;
      const normalized = res.envelope.data.tests.map((t, idx) => normalizeTest(t, idx, { repeatRuns, source: 'generated_ai' }));
      const { added } = mergeTests([...existing, ...suite], normalized);
      if (!added.length) {
        report.step('tests', 'active', `Batch ${i} of ${batches} added nothing new — the suite covers the playbook (${suite.length} AI tests)`);
        break;
      }
      for (const t of added) names.add(t.name);
      suite.push(...added);
      report.step('tests', 'active', `Batch ${i} of ${batches} added ${added.length} — ${suite.length} of about ${target} tests written`);
    } catch (err) {
      failedBatches++;
      notes.push(`AI test batch ${i} of ${batches} failed (${err.message}). The tests written so far were kept.`);
      report.step('tests', 'active', `Batch ${i} of ${batches} failed — keeping the ${suite.length} tests written so far`);
    }
  }
  if (!suite.length) {
    const err = new Error(`The testing model did not return usable test cases${failedBatches ? ` — ${failedBatches} of ${batches} batches failed` : ''}.`);
    err.code = 'INVALID_AI_RESPONSE';
    throw err;
  }
  report.step('tests', 'done', `${suite.length} AI test case${suite.length === 1 ? '' : 's'} written in ${batchesUsed} batch${batchesUsed === 1 ? '' : 'es'}${failedBatches ? ` · ${failedBatches} batch${failedBatches === 1 ? '' : 'es'} skipped` : ''}`);
  return { tests: suite, usage, model, notes };
}
