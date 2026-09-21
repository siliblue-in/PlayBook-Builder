// Test Center engine (spec §37–§47). Runs the suite in Deterministic Fixture
// or AI Execution mode, repeats runs for repeatability, compares structured
// fields, checks rule adherence against the deterministic oracle, optionally
// asks the evaluation model for semantic judgement, and scores the run.
import os from 'node:os';
import { HttpError } from '../http.js';
import { newId, nowIso, pool, deepClone, round } from '../util.js';
import { executeDeterministic, decisionOutputFields } from '../engine/deterministic.js';
import { executeWithAI } from '../engine/ai-executor.js';
import { validateSchema } from '../engine/jsonschema.js';
import { judgeRun, signatureFields, runSignature, expectedStatus } from './compare.js';
import { computeMetrics, testStatus } from './metrics.js';
import { heuristicSuggestions } from './repair.js';
import { evaluateCondition } from '../engine/rules.js';
import { looseEqual } from '../engine/expr.js';
import { EVALUATOR_SYSTEM } from '../ai/prompts.js';
import { emptyUsage, mergeUsage } from '../ai/service.js';
import { stableStringify, sha256 } from '../util.js';

export const ENGINE_VERSION = '1.0.0';

/**
 * Requirements a test covers. Explicit `covers.requirements` wins; otherwise
 * coverage is inferred: business-rule requirements whose rule matches the
 * test input and whose result is the expected decision, functional/output
 * requirements for normal/boundary/edge tests that expect completion, data
 * and constraint requirements for missing-data/negative tests, and
 * non-functional requirements for repeatability tests.
 */
export function coveredRequirements(test, pb) {
  const explicit = (test.covers && test.covers.requirements) || [];
  if (explicit.length) return { requirements: explicit, rules: (test.covers && test.covers.rules) || [], inferred: false };
  const reqs = pb.requirements || [];
  const out = new Set();
  const expectsCompletion = expectedStatus(test) === 'completed';
  const decisionValues = isPlainObjectLike(test.expected) ? Object.values(test.expected).map((v) => JSON.stringify(v)) : [];
  for (const r of reqs) {
    if (r.rule && r.result !== undefined) {
      try {
        const m = evaluateCondition(r.rule, { input: test.input || {}, config: {}, state: {}, steps: {} }, null);
        if (m.matched && decisionValues.includes(JSON.stringify(r.result))) out.add(r.id);
      } catch { /* ignore */ }
      continue;
    }
    if (['functional', 'output'].includes(r.type) && expectsCompletion && ['normal', 'boundary', 'edge'].includes(test.category)) out.add(r.id);
    if (['data', 'constraint'].includes(r.type) && ['missing_data', 'negative', 'error_handling'].includes(test.category)) out.add(r.id);
    if (r.type === 'non_functional' && (test.category === 'repeatability' || (test.runs || 1) > 1)) out.add(r.id);
  }
  return { requirements: [...out], rules: (test.covers && test.covers.rules) || [], inferred: true };
}

function isPlainObjectLike(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function slimRun(run, keepDetail) {
  const r = {
    index: run.index,
    status: run.status,
    matched: run.matched,
    signature: run.signature,
    output_compliant: run.output_compliant,
    rule_adherent: run.rule_adherent,
    inconclusive: run.inconclusive || undefined,
    simulated_steps: run.simulated_steps && run.simulated_steps.length ? run.simulated_steps : undefined,
    decisions: (run.decisions || []).map((d) => ({ step_id: d.step_id, result: d.result, rule_id: d.rule_id })),
    duration_ms: run.duration_ms,
    usage: run.usage || null,
  };
  if (keepDetail) {
    r.output = run.output;
    r.error = run.error;
    r.mismatches = run.mismatches;
    r.trace = (run.trace || []).map((t) => ({ step_id: t.step_id, name: t.name, status: t.status, decision: t.decision, rule_id: t.rule_id, message: t.message, error: t.error }));
    r.warnings = (run.warnings || []).slice(0, 10);
    r.oracle = run.oracle;
  }
  return r;
}

export class TestRunner {
  constructor({ store, settings, playbooks, ai }) {
    this.store = store;
    this.settings = settings;
    this.playbooks = playbooks;
    this.ai = ai;
    this.active = new Map();
  }

  get(id) {
    const doc = this.store.testRuns.get(id);
    if (!doc) throw new HttpError(404, 'not_found', 'Test run not found.');
    return doc;
  }

  list({ playbookId, limit = 50 } = {}) {
    return this.store.testRuns
      .list((d) => !playbookId || d.playbook_id === playbookId)
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .slice(0, limit)
      .map((d) => ({
        id: d.id,
        playbook_id: d.playbook_id,
        playbook_name: d.playbook_name,
        version: d.version,
        mode: d.mode,
        status: d.status,
        result_status: d.result_status,
        started_at: d.started_at,
        ended_at: d.ended_at,
        duration_ms: d.duration_ms,
        progress: d.progress,
        full_suite: d.full_suite,
        stale: this.isStale(d),
        metrics: d.metrics ? d.metrics.metrics : null,
        counts: d.metrics ? d.metrics.counts : null,
        usage: d.usage,
        trigger: d.trigger,
      }));
  }

  isStale(doc) {
    const rec = this.store.playbooks.peek(doc.playbook_id);
    if (!rec) return false;
    const ver = rec.versions.find((v) => v.version === doc.version);
    return Boolean(ver && (ver.hash !== doc.playbook_hash || rec.suite.revision !== doc.suite_revision));
  }

  cancel(id) {
    const flag = this.active.get(id);
    if (flag) flag.cancelled = true;
    return this.get(id);
  }

  /**
   * Start a test run. Returns the run document (status "running").
   * opts: { version, mode, test_ids, runs, ai_evaluation, trigger }
   */
  async start(playbookId, opts = {}) {
    const settings = this.settings.get();
    const rec = this.playbooks.get(playbookId);
    const ver = this.playbooks.version(rec, opts.version);
    const mode = opts.mode === 'ai' ? 'ai' : opts.mode === 'deterministic' ? 'deterministic' : settings.testing.default_mode;
    const allTests = rec.suite.tests;
    const selected = Array.isArray(opts.test_ids) && opts.test_ids.length ? allTests.filter((t) => opts.test_ids.includes(t.id)) : allTests;
    if (!selected.length) throw new HttpError(400, 'no_tests', 'There are no tests to run. Generate or add test cases first.');

    let aiContext = null;
    if (mode === 'ai') {
      const role = 'testing';
      // An explicit connection/model (e.g. checking a local model) wins over the
      // playbook's own connection, which wins over the default connection.
      const resolved = this.ai.resolve(role, {
        connectionId: opts.connection_id || ver.playbook.ai.connection_id || undefined,
        model: opts.model || undefined,
      });
      aiContext = { role, connectionId: resolved.conn.id, model: resolved.model };
    }
    // The global AI Evaluation switch always wins; a request can only opt out.
    const evaluate = settings.features.ai_evaluation && opts.ai_evaluation !== false && this.ai.isAvailable('evaluation');
    const repeatEnabled = settings.features.repeatability_testing;
    const plan = selected.map((t) => ({ test: t, runs: repeatEnabled ? Math.max(1, Math.min(100, opts.runs && t.runs > 1 ? opts.runs : t.runs || 1)) : 1 }));
    const now = new Date();
    const doc = {
      id: newId('tr'),
      playbook_id: rec.id,
      playbook_name: ver.playbook.name,
      version: ver.version,
      playbook_hash: ver.hash,
      suite_revision: rec.suite.revision,
      full_suite: selected.length === allTests.length,
      test_ids: selected.map((t) => t.id),
      mode,
      trigger: opts.trigger || 'manual',
      status: 'running',
      result_status: null,
      started_at: nowIso(),
      ended_at: null,
      duration_ms: null,
      evaluation_time: now.toISOString(),
      environment: {
        engine_version: ENGINE_VERSION,
        node: process.version,
        platform: `${os.platform()}-${os.arch()}`,
        mode,
        model: aiContext ? aiContext.model : null,
        connection_id: aiContext ? aiContext.connectionId : null,
        temperature: mode === 'ai' ? settings.testing.execution_temperature : null,
        configuration_hash: sha256(stableStringify(ver.playbook.configuration)).slice(0, 12),
        evaluation_model: evaluate ? this.ai.resolve('evaluation').model : null,
        repeatability_enabled: repeatEnabled,
      },
      progress: { done: 0, total: plan.reduce((s, p) => s + p.runs, 0) },
      results: [],
      metrics: null,
      repair_suggestions: [],
      usage: emptyUsage(),
      error: null,
    };
    this.store.testRuns.put(doc);
    this.playbooks.markTesting(rec.id, ver.version, true);
    const flag = { cancelled: false };
    this.active.set(doc.id, flag);
    const promise = this.execute(doc, ver, rec, plan, { mode, aiContext, evaluate, settings, flag, now }).catch((err) => {
      const d = this.store.testRuns.get(doc.id);
      d.status = 'error';
      d.error = { code: err.code || 'TEST_RUN_ERROR', message: err.message };
      d.ended_at = nowIso();
      this.store.testRuns.put(d);
      try {
        this.playbooks.recordTestRun(rec.id, ver.version, d);
      } catch { /* playbook removed */ }
    }).finally(() => this.active.delete(doc.id));
    if (opts.wait) await promise;
    return this.get(doc.id);
  }

  async execute(doc, ver, rec, plan, { mode, aiContext, evaluate, settings, flag, now }) {
    const pb = deepClone(ver.playbook);
    const thresholds = {
      pass: settings.testing.pass_threshold,
      warning: settings.testing.warning_threshold,
      alignment_pass: settings.testing.alignment_pass_threshold,
      alignment_warning: settings.testing.alignment_warning_threshold,
    };
    const requireValidation = settings.behavior.require_validation;
    const decisionFields = decisionOutputFields(pb);
    let usage = emptyUsage();
    let done = 0;
    const results = [];
    let lastSave = 0;
    const save = (force) => {
      if (!force && Date.now() - lastSave < 400) return;
      lastSave = Date.now();
      const d = this.store.testRuns.get(doc.id);
      if (!d) return;
      d.progress.done = done;
      d.results = results.map((r) => ({ ...r }));
      d.usage = usage;
      this.store.testRuns.put(d);
    };

    const oracleCache = new Map();
    const oracleFor = async (test) => {
      if (!oracleCache.has(test.id)) {
        oracleCache.set(test.id, await executeDeterministic(pb, { input: test.input, configuration: test.configuration, fixtures: test.fixtures, now: test.now ? new Date(test.now) : now, autoApprove: true, requireValidation, backoff: false }));
      }
      return oracleCache.get(test.id);
    };

    const runOnce = async (test, index) => {
      const testNow = test.now ? new Date(test.now) : now;
      let run;
      if (mode === 'deterministic') {
        run = await executeDeterministic(pb, { input: test.input, configuration: test.configuration, fixtures: test.fixtures, now: testNow, autoApprove: true, requireValidation, backoff: false });
      } else {
        const toolRunner = async (tool) => {
          const fx = test.fixtures && test.fixtures.tools && test.fixtures.tools[tool.id];
          if (fx !== undefined) return { result: deepClone(fx) };
          if (tool.binding && tool.binding.type === 'input') return { result: test.input[tool.binding.key || tool.id] ?? null };
          return { simulated: true, result: null, note: `No fixture for ${tool.name} in test mode; tool not executed.` };
        };
        run = await executeWithAI(pb, {
          ai: this.ai,
          input: test.input,
          configuration: test.configuration,
          now: testNow,
          connectionId: aiContext.connectionId,
          model: aiContext.model,
          role: aiContext.role,
          temperature: settings.testing.execution_temperature,
          toolRunner,
          toolCalling: settings.features.tool_calling,
          requireValidation,
          signal: flag,
        });
        usage = mergeUsage(usage, run.usage);
      }
      const judged = judgeRun(test, run);
      const out = {
        index,
        status: run.status,
        output: run.output,
        error: run.error,
        trace: run.trace,
        warnings: run.warnings,
        decisions: run.decisions,
        matched: judged.matched,
        mismatches: judged.mismatches,
        duration_ms: run.duration_ms,
        usage: run.usage || null,
      };
      // Output compliance: only meaningful when the run is expected to complete.
      if (expectedStatus(test) === 'completed') {
        out.output_compliant = run.output !== null && run.output !== undefined && (!pb.output.schema || validateSchema(run.output, pb.output.schema).length === 0);
      } else out.output_compliant = null;
      // Deterministic runs with simulated (LLM) steps cannot judge fields those steps produce.
      const simulated = run.simulated_steps || [];
      if (mode === 'deterministic' && simulated.length) {
        out.simulated_steps = simulated;
        out.output_compliant = null;
        const concrete = judged.mismatches.filter((m) => m.path !== 'status' && m.actual !== null && m.actual !== undefined && m.message !== 'missing');
        if (!judged.matched && !concrete.length) out.inconclusive = true;
      }
      // Rule adherence: compare decision fields with the deterministic oracle.
      if (decisionFields.length) {
        if (mode === 'deterministic') out.rule_adherent = (run.decisions || []).length ? true : null;
        else {
          const oracle = await oracleFor(test);
          if ((oracle.decisions || []).length && oracle.output) {
            // Compare like the expression engine does: a model that returns 14
            // as "14" did follow the rule.
            out.rule_adherent = decisionFields.every((f) => looseEqual(oracle.output[f] ?? null, run.output ? run.output[f] ?? null : null));
            out.oracle = Object.fromEntries(decisionFields.map((f) => [f, oracle.output[f] ?? null]));
          } else out.rule_adherent = null;
        }
      } else out.rule_adherent = null;
      return out;
    };

    const concurrency = mode === 'ai' ? settings.testing.ai_concurrency : 1;
    for (const { test, runs } of plan) {
      if (flag.cancelled) break;
      const indices = Array.from({ length: runs }, (_, i) => i);
      const executed = await pool(indices, concurrency, async (i) => {
        if (flag.cancelled) return null;
        const r = await runOnce(test, i + 1);
        done++;
        save(false);
        return r;
      });
      const runList = executed.filter(Boolean);
      const fields = signatureFields(test, pb);
      for (const r of runList) r.signature = runSignature(r, fields);
      const counts = new Map();
      for (const r of runList) counts.set(r.signature, (counts.get(r.signature) || 0) + 1);
      const modal = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      const agreement = runList.length ? (modal ? modal[1] : 0) / runList.length : 0;
      const semanticOnly = test.expected === undefined && !test.expected_error && !test.expected_status && Boolean(test.expected_behavior);
      const result = {
        test_id: test.id,
        name: test.name,
        category: test.category,
        description: test.description,
        covers: coveredRequirements(test, pb),
        expected: test.expected,
        expected_status: expectedStatus(test),
        expected_error: test.expected_error || null,
        expected_behavior: test.expected_behavior || null,
        input: test.input,
        runs: runList.map((r, i) => slimRun(r, !r.matched || i === 0)),
        agreement: runList.length > 1 ? round(agreement, 4) : null,
        accuracy: runList.length ? round(runList.filter((r) => r.matched).length / runList.length, 4) : 0,
        distinct_outcomes: runList.length > 1 ? [...counts.entries()].map(([sig, n]) => ({ outcome: JSON.parse(sig), runs: n })) : undefined,
        semantic_only: semanticOnly,
      };
      if (runList.length && runList.every((r) => r.inconclusive)) {
        result.skipped = true;
        result.skip_reason = `Not machine-executable in deterministic mode: ${[...new Set(runList.flatMap((r) => r.simulated_steps || []))].join(', ')} ran simulated. Run AI Execution mode or add step fixtures.`;
      }
      if (evaluate && runList.length && !flag.cancelled && !result.skipped) {
        try {
          const first = runList.find((r) => !r.matched) || runList[0];
          const ev = await this.evaluateSemantics(pb, rec.intent, test, first);
          result.evaluation = ev.data;
          usage = mergeUsage(usage, ev.usage);
        } catch (err) {
          result.evaluation_error = err.message;
        }
      } else if (semanticOnly && !evaluate) {
        result.skipped = true;
        result.skip_reason = 'This test has only a semantic expectation and AI Evaluation is off or not configured.';
      }
      result.status = testStatus(result, thresholds);
      result.diagnosis = this.diagnose(result, test, pb, mode);
      results.push(result);
      save(true);
    }

    const d = this.store.testRuns.get(doc.id);
    d.results = results;
    d.progress.done = done;
    d.usage = usage;
    d.ended_at = nowIso();
    d.duration_ms = Date.parse(d.ended_at) - Date.parse(d.started_at);
    if (flag.cancelled) {
      d.status = 'cancelled';
      d.metrics = computeMetrics(results, pb, thresholds, { repeatabilityEnabled: settings.features.repeatability_testing });
      d.result_status = null;
    } else {
      d.status = 'completed';
      d.metrics = computeMetrics(results, pb, thresholds, { repeatabilityEnabled: settings.features.repeatability_testing });
      d.result_status = d.metrics.status;
      if (!['pass', 'inconclusive'].includes(d.result_status)) {
        try {
          d.repair_suggestions = await heuristicSuggestions(pb, d, rec.suite.tests);
        } catch (err) {
          d.repair_error = err.message;
        }
      }
    }
    this.store.testRuns.put(d);
    this.playbooks.recordTestRun(rec.id, ver.version, d);
    return d;
  }

  diagnose(result, test, pb, mode) {
    if (result.status === 'pass' || result.skipped) return null;
    const lines = [];
    const bad = result.runs.find((r) => !r.matched);
    if (bad && bad.mismatches) {
      for (const m of bad.mismatches.slice(0, 4)) {
        lines.push(m.path === 'status' ? `Run ended with status "${m.actual}" (expected ${m.expected})${m.message && m.message !== 'status differs' ? ` — ${m.message}` : ''}.` : `${m.path.replace(/^output\./, '')}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.actual)}.`);
      }
    }
    if (bad && bad.decisions && bad.decisions.length) {
      const d = bad.decisions[0];
      const rule = (pb.decision_rules || []).find((r) => r.id === d.rule_id);
      lines.push(`Decision made in ${d.step_id} by ${d.rule_id || 'no rule'}${rule ? ` (${rule.name})` : ''} → ${JSON.stringify(d.result)}.`);
    }
    if (mode === 'ai' && bad) {
      if (bad.rule_adherent === false) lines.push(`The model did not follow the playbook's rules: the deterministic oracle returns ${JSON.stringify(bad.oracle)}.`);
      else if (bad.rule_adherent === true) lines.push('The model followed the rules as written, so the rules themselves disagree with the expected behavior.');
    } else if (mode === 'deterministic' && bad && bad.rule_adherent) {
      lines.push('The engine applied the rules exactly as written, so the playbook logic disagrees with the expected behavior.');
    }
    if (result.agreement !== null && result.agreement < 1) lines.push(`${Math.round(result.agreement * 100)}% of ${result.runs.length} runs agreed on the same structured result.`);
    if (result.evaluation && result.evaluation.issues && result.evaluation.issues.length) lines.push(`Evaluator: ${result.evaluation.issues.slice(0, 2).join(' ')}`);
    return lines;
  }

  async evaluateSemantics(pb, intent, test, run) {
    const res = await this.ai.json('evaluation', {
      system: EVALUATOR_SYSTEM,
      user: {
        objective: pb.objective,
        requirements: pb.requirements,
        confirmed_intent: intent || null,
        output_contract: pb.output,
        test: { name: test.name, category: test.category, input: test.input, expected: test.expected ?? null, expected_status: expectedStatus(test), expected_behavior: test.expected_behavior || null },
        actual: { status: run.status, output: run.output, error: run.error },
        deterministic_mismatches: run.mismatches,
      },
      expect: 'test_result',
      temperature: 0,
      max_tokens: 1200,
      validate: (env) => (typeof env.data.passed === 'boolean' ? null : 'data.passed must be true or false.'),
    });
    const data = res.envelope.data;
    const clamp = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : null);
    return {
      data: {
        passed: data.passed,
        task_alignment: clamp(data.task_alignment),
        requirement_coverage: clamp(data.requirement_coverage),
        issues: Array.isArray(data.issues) ? data.issues.map(String).slice(0, 6) : [],
        notes: data.notes ? String(data.notes) : '',
        model: res.model,
      },
      usage: res.usage,
    };
  }
}
