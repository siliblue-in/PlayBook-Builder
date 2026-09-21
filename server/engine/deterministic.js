// Deterministic execution engine. Walks the step graph in dependency order and
// executes each step's machine-readable `execution` block:
//   validate | set | decide | filter | map | tool | llm | approval | output | validate_output | noop
// Non-deterministic work (LLM generation, external tools) comes from fixtures,
// which is what makes "Deterministic Fixture" tests exact and repeatable (§44).
import { buildGraph, topologicalOrder } from '../../shared/graph.js';
import { evaluate } from './expr.js';
import { decide, evaluateCondition } from './rules.js';
import { validateSchema, formatSchemaErrors } from './jsonschema.js';
import { configMap } from '../playbooks/schema.js';
import { deepClone, getPath, setPath, isPlainObject, sleep } from '../util.js';

export class StepError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

const RETRYABLE_CODES = new Set(['TIMEOUT', 'TOOL_TIMEOUT', 'TEMPORARY_PROVIDER_ERROR', 'RATE_LIMITED', 'TOOL_ERROR', 'PROVIDER_ERROR']);

function typeOk(value, type) {
  const t = String(type || '').toLowerCase();
  switch (t) {
    case '':
    case 'any':
      return true;
    case 'integer':
    case 'int':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
    case 'text':
      return typeof value === 'string';
    case 'boolean':
    case 'bool':
      return typeof value === 'boolean';
    case 'array':
    case 'list':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    case 'date':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value));
    default:
      return true;
  }
}

/** Fields of the final output that carry decision results (used for rule adherence). */
export function decisionOutputFields(pb) {
  const vars = new Set();
  for (const s of pb.steps || []) {
    if (s.execution && s.execution.op === 'decide') vars.add(s.execution.assign || 'decision');
  }
  const fields = [];
  for (const s of pb.steps || []) {
    const ex = s.execution;
    if (!ex || ex.op !== 'output' || !isPlainObject(ex.mapping)) continue;
    for (const [field, expr] of Object.entries(ex.mapping)) {
      if (typeof expr !== 'string') continue;
      for (const v of vars) {
        const re = new RegExp(`\\bstate\\.${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b(?!_)`);
        if (re.test(expr)) fields.push(field);
      }
    }
  }
  return [...new Set(fields)];
}

function strategyFor(pb, step, error) {
  const list = (pb.error_handling && pb.error_handling.strategies) || [];
  const code = String(error.code || '').toLowerCase();
  const match = list.find((s) => (!s.step_id || s.step_id === step.id) && s.on && code && String(s.on).toLowerCase().replace(/\s+/g, '_').includes(code));
  if (match) return { strategy: match.strategy, then: match.then, source: match.id };
  return { strategy: step.failure_behavior || (pb.error_handling && pb.error_handling.default_strategy) || 'stop', source: 'step' };
}

function retryPolicy(pb, step) {
  if (isPlainObject(step.retry_behavior) && step.retry_behavior.enabled !== false) return step.retry_behavior;
  const global = pb.error_handling && pb.error_handling.retry;
  if (step.retry_behavior === 'not_applicable') return { enabled: false, max_attempts: 1, retry_on: [] };
  return global && global.enabled ? global : { enabled: false, max_attempts: 1, retry_on: [] };
}

function isRetryable(err, policy) {
  if (!policy.enabled || !err) return false;
  if (err.retryable === false) return false;
  const code = String(err.code || '').toUpperCase();
  const on = (policy.retry_on || []).map((x) => String(x).toUpperCase().replace(/[\s-]+/g, '_'));
  if (on.includes(code)) return true;
  if (code.includes('TIMEOUT') && on.some((x) => x.includes('TIMEOUT'))) return true;
  if (on.some((x) => x.includes('TEMPORARY') || x.includes('PROVIDER')) && (code === 'TEMPORARY_PROVIDER_ERROR' || code === 'RATE_LIMITED')) return true;
  return err.retryable === true && RETRYABLE_CODES.has(code);
}

/** Fixture value for a tool call; supports injected failures: {"$error":"timeout","$times":1,"$then":{...}}. */
function consumeToolFixture(fixture, counters, toolId) {
  if (isPlainObject(fixture) && fixture.$error) {
    const n = (counters[toolId] = (counters[toolId] || 0) + 1);
    const times = Number.isFinite(Number(fixture.$times)) ? Number(fixture.$times) : Infinity;
    if (n <= times) {
      const code = String(fixture.$error).toUpperCase().replace(/[\s-]+/g, '_');
      throw new StepError(code.includes('TIMEOUT') ? 'TIMEOUT' : code, `Simulated ${fixture.$error} from tool ${toolId}`, { retryable: true });
    }
    return deepClone(fixture.$then);
  }
  return deepClone(fixture);
}

/**
 * Execute a playbook deterministically.
 * @returns {Promise<object>} run result (status, output, trace, decisions, validation, warnings, error, resume)
 */
export async function executeDeterministic(pb, opts = {}) {
  const {
    input = {},
    configuration: configOverrides,
    fixtures = {},
    now = new Date(),
    approvals = {},
    autoApprove = false,
    toolRunner = null,
    requireValidation = true,
    onEvent = () => {},
    resume = null,
    signal = null,
    backoff = true,
  } = opts;

  const started = Date.now();
  const graph = buildGraph(pb, { terminals: false });
  const warnings = resume ? resume.warnings.slice() : [];
  const trace = resume ? resume.trace.slice() : [];
  const decisions = resume ? resume.decisions.slice() : [];
  // Steps whose real work could not be done deterministically (LLM steps without fixtures).
  const simulatedSteps = resume && resume.simulatedSteps ? resume.simulatedSteps.slice() : [];
  const log = (level, message, step_id, data) => onEvent({ ts: new Date().toISOString(), level, message, step_id, data });

  const result = (status, extra = {}) => ({
    status,
    output: null,
    error: null,
    warnings,
    trace,
    decisions,
    simulated_steps: simulatedSteps,
    validation: { passed: status === 'completed', issues: [] },
    duration_ms: Date.now() - started,
    engine: 'deterministic',
    ...extra,
  });

  const structural = graph.issues.filter((i) => i.severity === 'error');
  if (structural.length) {
    log('error', `Workflow is invalid: ${structural[0].message}`);
    return result('failed', { error: { code: 'WORKFLOW_INVALID', message: structural.map((i) => i.message).join(' ') } });
  }

  const config = configMap(pb, configOverrides);
  const scope = {
    input: deepClone(input),
    config,
    state: resume ? deepClone(resume.state) : {},
    steps: resume ? deepClone(resume.steps) : {},
    __now: now instanceof Date ? now : new Date(now),
  };
  const status = resume ? { ...resume.status } : {};
  const taken = new Map(resume ? Object.entries(resume.taken).map(([k, v]) => [k, new Set(v)]) : []);
  const toolCounters = resume ? { ...resume.toolCounters } : {};
  const stepById = new Map((pb.steps || []).map((s) => [s.id, s]));
  const incoming = new Map((pb.steps || []).map((s) => [s.id, []]));
  for (const e of graph.edges) if (!e.back && incoming.has(e.to)) incoming.get(e.to).push(e);
  const order = topologicalOrder(pb);
  const rulesFor = (step, ids) => {
    const all = pb.decision_rules || [];
    if (Array.isArray(ids) && ids.length) return ids.map((id) => all.find((r) => r.id === id)).filter(Boolean);
    return all.filter((r) => r.step_id === step.id);
  };
  const snapshot = () => ({
    status: { ...status },
    state: deepClone(scope.state),
    steps: deepClone(scope.steps),
    taken: Object.fromEntries([...taken].map(([k, v]) => [k, [...v]])),
    toolCounters: { ...toolCounters },
    trace: trace.slice(),
    warnings: warnings.slice(),
    decisions: decisions.slice(),
    simulatedSteps: simulatedSteps.slice(),
  });

  const edgeActive = (e) => {
    const s = status[e.from];
    if (!['completed', 'simulated'].includes(s)) return false;
    if (e.kind === 'branch') {
      const set = taken.get(e.from);
      return Boolean(set && (e.branch_results || []).some((r) => set.has(String(r))));
    }
    return true;
  };

  async function runOp(step, entry) {
    const ex = step.execution;
    const fixtureOut = fixtures.steps && Object.prototype.hasOwnProperty.call(fixtures.steps, step.id) ? deepClone(fixtures.steps[step.id]) : undefined;
    if (ex && Array.isArray(ex.preconditions)) {
      for (const p of ex.preconditions) {
        let ok;
        try {
          ok = evaluate(p, scope);
        } catch (err) {
          throw new StepError('PRECONDITION_ERROR', `Precondition "${p}" could not be evaluated: ${err.message}`);
        }
        if (!ok) throw new StepError('PRECONDITION_FAILED', `Precondition not met: ${p}`);
      }
    }
    if (!ex || !ex.op) {
      if (fixtureOut !== undefined) return { output: fixtureOut, note: 'Output supplied by fixture.' };
      if (step.type === 'approval' || step.requires_approval) return runApproval(step);
      return { output: undefined, simulated: true, note: 'No machine-readable execution block and no fixture; step simulated.' };
    }
    const assignTo = (name, value) => {
      if (name) setPath(scope.state, name, value);
    };
    const evalMap = (obj, where) => {
      const out = {};
      for (const [k, expr] of Object.entries(obj || {})) {
        try {
          out[k] = typeof expr === 'string' ? evaluate(expr, scope) : deepClone(expr);
        } catch (err) {
          throw new StepError(err.code === 'TYPE_ERROR' ? 'INVALID_DATA' : 'EXPRESSION_ERROR', `${where}.${k}: ${err.message}`);
        }
      }
      return out;
    };

    switch (ex.op) {
      case 'noop':
        return { output: fixtureOut };
      case 'validate': {
        const subjectPath = ex.subject || 'input';
        const subject = getPath(scope, subjectPath);
        if (subject === undefined) throw new StepError(ex.missing_code || 'MISSING_INPUT', `${subjectPath} is missing.`, { missing: [subjectPath] });
        if (isPlainObject(ex.schema)) {
          const errs = validateSchema(subject, ex.schema, subjectPath);
          if (errs.length) throw new StepError(ex.error_code || 'INVALID_INPUT', formatSchemaErrors(errs).join('; '));
        }
        let passed = 0;
        for (const c of Array.isArray(ex.checks) ? ex.checks : []) {
          const value = getPath(subject, c.path);
          const label = `${subjectPath}.${c.path}`;
          const fail = (code, message) => {
            if (c.on_fail === 'warn') {
              warnings.push({ step_id: step.id, code, message });
              log('warn', message, step.id);
            } else throw new StepError(code, c.message || message, { missing: code === 'MISSING_INPUT' ? [label] : undefined });
          };
          if (value === undefined || value === null) {
            if (c.required) fail(c.error_code || 'MISSING_INPUT', `${label} is required but missing.`);
            else passed++;
            continue;
          }
          if (c.type && !typeOk(value, c.type)) {
            fail(c.error_code || 'INVALID_INPUT', `${label} must be ${c.type}; got ${JSON.stringify(value)}.`);
            continue;
          }
          if (typeof c.minimum === 'number' && typeof value === 'number' && value < c.minimum) {
            fail(c.error_code || 'INVALID_INPUT', `${label} must be ≥ ${c.minimum}; got ${value}.`);
            continue;
          }
          if (typeof c.maximum === 'number' && typeof value === 'number' && value > c.maximum) {
            fail(c.error_code || 'INVALID_INPUT', `${label} must be ≤ ${c.maximum}; got ${value}.`);
            continue;
          }
          if (typeof c.min_length === 'number' && typeof value === 'string' && value.trim().length < c.min_length) {
            fail(c.error_code || 'INVALID_INPUT', `${label} must not be empty.`);
            continue;
          }
          if (Array.isArray(c.enum) && !c.enum.includes(value)) {
            fail(c.error_code || 'INVALID_INPUT', `${label} must be one of ${c.enum.join(', ')}.`);
            continue;
          }
          if (c.pattern) {
            let ok = true;
            try {
              ok = new RegExp(c.pattern).test(String(value));
            } catch { /* ignore bad pattern */ }
            if (!ok) {
              fail(c.error_code || 'INVALID_INPUT', `${label} does not match the expected format.`);
              continue;
            }
          }
          passed++;
        }
        const assigned = ex.assign && isPlainObject(ex.assign) ? evalMap(ex.assign, 'assign') : {};
        for (const [k, v] of Object.entries(assigned)) assignTo(k, v);
        return { output: { valid: true, checks_passed: passed, ...assigned } };
      }
      case 'set': {
        const values = evalMap(ex.values || ex.assign, 'values');
        for (const [k, v] of Object.entries(values)) assignTo(k, v);
        return { output: values };
      }
      case 'decide': {
        const rules = rulesFor(step, ex.rules);
        if (!rules.length) throw new StepError('NO_RULES', `Decision step ${step.id} has no decision rules.`);
        const assign = ex.assign || 'decision';
        if (ex.for_each) {
          const items = getPath(scope, ex.for_each);
          if (!Array.isArray(items)) throw new StepError('INVALID_DATA', `${ex.for_each} is not a list.`);
          const results = [];
          const set = new Set();
          items.forEach((item, index) => {
            const d = decide(rules, { ...scope, item }, null);
            let res = d.result;
            if (!d.matched) {
              if (ex.default === undefined) throw new StepError('NO_RULE_MATCHED', `No decision rule matched item ${index} in ${step.id}.`);
              res = ex.default;
              warnings.push({ step_id: step.id, code: 'DEFAULT_RESULT', message: `Item ${index}: no rule matched; used default "${res}".` });
            }
            set.add(String(res));
            const row = { index, result: res, rule_id: d.rule_id, evidence: d.evidence };
            if (ex.key) row.key = getPath(item, ex.key);
            results.push(row);
            decisions.push({ step_id: step.id, item: index, result: res, rule_id: d.rule_id, evidence: d.evidence });
          });
          assignTo(assign, results);
          taken.set(step.id, set);
          entry.decision = [...set].join(', ');
          return { output: results };
        }
        const d = decide(rules, scope, ex.subject || null);
        let res = d.result;
        if (!d.matched) {
          if (ex.default === undefined) {
            throw new StepError('NO_RULE_MATCHED', `No decision rule matched in ${step.id}${d.missing.length ? ` (missing: ${[...new Set(d.missing)].join(', ')})` : ''}.`, { missing: d.missing });
          }
          res = ex.default;
          warnings.push({ step_id: step.id, code: 'DEFAULT_RESULT', message: `No rule matched; used default "${res}".` });
        }
        assignTo(assign, res);
        assignTo(`${assign}_rule`, d.rule_id);
        assignTo(`${assign}_evidence`, d.evidence);
        taken.set(step.id, new Set([String(res)]));
        decisions.push({ step_id: step.id, result: res, rule_id: d.rule_id, evidence: d.evidence });
        entry.decision = res;
        entry.rule_id = d.rule_id;
        entry.evidence = d.evidence;
        return { output: { result: res, rule_id: d.rule_id, rule_name: d.rule_name, evidence: d.evidence } };
      }
      case 'filter': {
        const items = getPath(scope, ex.from);
        if (!Array.isArray(items)) throw new StepError('INVALID_DATA', `${ex.from} is not a list.`);
        const kept = items.filter((item) => evaluateCondition(ex.where, { ...scope, item }, null).matched);
        assignTo(ex.assign, kept);
        return { output: kept };
      }
      case 'map': {
        const items = getPath(scope, ex.from);
        if (!Array.isArray(items)) throw new StepError('INVALID_DATA', `${ex.from} is not a list.`);
        const as = ex.as || 'item';
        const mapped = items.map((item, index) => {
          const local = { ...scope, [as]: item, item, index };
          if (typeof ex.value === 'string') return evaluate(ex.value, local);
          const out = {};
          for (const [k, expr] of Object.entries(ex.value || {})) out[k] = typeof expr === 'string' ? evaluate(expr, local) : expr;
          return out;
        });
        assignTo(ex.assign, mapped);
        return { output: mapped };
      }
      case 'tool': {
        const tool = (pb.tools || []).find((t) => t.id === ex.tool_id || t.name === ex.tool_id);
        if (!tool) throw new StepError('UNKNOWN_TOOL', `Tool ${ex.tool_id} is not declared.`, { retryable: false });
        const args = evalMap(ex.args, 'args');
        let value;
        if (fixtures.tools && Object.prototype.hasOwnProperty.call(fixtures.tools, tool.id)) {
          value = consumeToolFixture(fixtures.tools[tool.id], toolCounters, tool.id);
          entry.note = 'Tool result supplied by fixture.';
        } else if (toolRunner) {
          const r = await toolRunner(tool, args, { step });
          if (r && r.awaiting_approval) return { awaiting: r };
          if (r && r.error) throw new StepError('TOOL_ERROR', r.error, { retryable: false });
          value = r ? r.result : undefined;
          if (r && r.simulated) {
            entry.note = r.note || 'Tool call simulated by policy.';
            warnings.push({ step_id: step.id, code: 'TOOL_SIMULATED', message: entry.note });
          }
        } else if (tool.binding && tool.binding.type === 'input') {
          value = getPath(scope.input, tool.binding.key || tool.id);
          if (value === undefined) throw new StepError('MISSING_INPUT', `Tool ${tool.name} reads "${tool.binding.key || tool.id}" from the run input, but it is missing.`, { missing: [`input.${tool.binding.key || tool.id}`] });
          entry.note = `Tool data read from input.${tool.binding.key || tool.id}.`;
        } else {
          throw new StepError('FIXTURE_MISSING', `No fixture or binding provides data for tool ${tool.name}.`, { retryable: false });
        }
        assignTo(ex.assign, value);
        return { output: value };
      }
      case 'llm': {
        if (fixtureOut !== undefined) {
          if (ex.assign) assignTo(ex.assign, fixtureOut);
          return { output: fixtureOut, note: 'Output supplied by fixture.' };
        }
        return { output: undefined, simulated: true, note: 'LLM step simulated (no fixture). Use AI Execution mode to run it for real.' };
      }
      case 'approval':
        return runApproval(step);
      case 'output': {
        let out;
        if (typeof ex.value === 'string') {
          try {
            out = evaluate(ex.value, scope);
          } catch (err) {
            throw new StepError('EXPRESSION_ERROR', `output: ${err.message}`);
          }
        } else out = evalMap(ex.mapping, 'mapping');
        for (const [k, v] of Object.entries(isPlainObject(out) ? out : {})) if (v === undefined) out[k] = null;
        scope.state.__output = out;
        return { output: out };
      }
      case 'validate_output': {
        const out = scope.state.__output;
        const issues = [];
        if (out === undefined || out === null) issues.push('No output was produced.');
        else if (pb.output && isPlainObject(pb.output.schema)) issues.push(...formatSchemaErrors(validateSchema(out, pb.output.schema, 'output'), 20));
        for (const c of Array.isArray(ex.checks) ? ex.checks : []) {
          if (typeof c.expression === 'string') {
            let ok = false;
            try {
              ok = evaluate(c.expression, { ...scope, output: out });
            } catch (err) {
              issues.push(`${c.message || c.expression}: ${err.message}`);
              continue;
            }
            if (!ok) issues.push(c.message || `Check failed: ${c.expression}`);
          }
        }
        if (issues.length && simulatedSteps.length) {
          // Fields produced by simulated (LLM) steps are empty in deterministic mode.
          warnings.push({ step_id: step.id, code: 'VALIDATION_INCONCLUSIVE', message: `Output checks not conclusive: ${simulatedSteps.join(', ')} ran simulated. ${issues.join('; ')}` });
          return { output: { valid: null, inconclusive: true }, note: 'Output validation inconclusive because some steps were simulated.' };
        }
        if (issues.length) throw new StepError('OUTPUT_INVALID', issues.join('; '), { retryable: false, issues });
        return { output: { valid: true } };
      }
      default:
        if (fixtureOut !== undefined) return { output: fixtureOut, note: 'Output supplied by fixture.' };
        return { output: undefined, simulated: true, note: `Unsupported op "${ex.op}"; step simulated.` };
    }
  }

  function runApproval(step) {
    const decision = approvals[step.id];
    if (decision === 'approved' || decision === true) return { output: { approved: true } };
    if (decision === 'rejected' || decision === false) throw new StepError('APPROVAL_REJECTED', `Approval for ${step.name} was rejected.`, { retryable: false });
    if (autoApprove) return { output: { approved: true, auto: true }, note: 'Auto-approved (test mode).' };
    return { awaiting: { step_id: step.id, reason: `Human approval required: ${step.name}` } };
  }

  for (const id of order) {
    if (signal && signal.cancelled) return result('cancelled', { error: { code: 'CANCELLED', message: 'Run was cancelled.' }, resume: snapshot() });
    if (status[id] && status[id] !== 'awaiting_approval') continue;
    const step = stepById.get(id);
    if (!step) continue;
    const ins = incoming.get(id);
    if (ins.length) {
      const unresolved = ins.filter((e) => !status[e.from] || status[e.from] === 'awaiting_approval');
      if (unresolved.length) continue; // upstream still pending (e.g. paused)
      if (!ins.some(edgeActive)) {
        status[id] = 'skipped';
        const reason = ins.some((e) => e.kind === 'branch' && ['completed', 'simulated'].includes(status[e.from])) ? 'Branch not taken.' : 'All upstream steps were skipped.';
        trace.push({ step_id: id, name: step.name, type: step.type, status: 'skipped', message: reason, attempts: 0 });
        log('info', `Skipped ${step.name}: ${reason}`, id);
        continue;
      }
    }

    const entry = { step_id: id, name: step.name, type: step.type, status: 'running', attempts: 0, started_at: new Date().toISOString() };
    const t0 = Date.now();
    log('info', `Started ${step.name}`, id);
    const policy = retryPolicy(pb, step);
    const maxAttempts = policy.enabled ? Math.max(1, policy.max_attempts || 1) : 1;
    let outcome = null;
    let failure = null;
    for (;;) {
      entry.attempts++;
      try {
        outcome = await runOp(step, entry);
        failure = null;
        break;
      } catch (err) {
        failure = err instanceof StepError ? err : new StepError(err.code || 'STEP_ERROR', err.message, { retryable: err.retryable });
        if (entry.attempts < maxAttempts && isRetryable(failure, policy)) {
          log('warn', `Attempt ${entry.attempts} failed (${failure.code}); retrying.`, id);
          if (backoff && policy.backoff_seconds) await sleep(Math.min(2000, policy.backoff_seconds * 1000 * 0.05));
          continue;
        }
        break;
      }
    }
    entry.ended_at = new Date().toISOString();
    entry.duration_ms = Date.now() - t0;

    if (outcome && outcome.awaiting) {
      status[id] = 'awaiting_approval';
      entry.status = 'awaiting_approval';
      entry.message = outcome.awaiting.reason;
      trace.push(entry);
      log('info', `Paused for approval: ${step.name}`, id);
      const snap = snapshot();
      snap.trace = trace.filter((t) => t !== entry);
      return result('awaiting_approval', { pending_approval: { step_id: id, ...outcome.awaiting }, resume: snap });
    }

    if (!failure) {
      status[id] = outcome.simulated ? 'simulated' : 'completed';
      entry.status = status[id];
      if (outcome.note) entry.message = outcome.note;
      entry.output = outcome.output === undefined ? null : outcome.output;
      scope.steps[id] = outcome.output === undefined ? null : outcome.output;
      if (step.output && step.output.name && outcome.output !== undefined && !scope.state[step.output.name] && ex_assigns_nothing(step)) {
        scope.state[step.output.name] = outcome.output;
      }
      if (outcome.simulated) {
        warnings.push({ step_id: id, code: 'SIMULATED', message: outcome.note });
        simulatedSteps.push(id);
      }
      trace.push(entry);
      log(outcome.simulated ? 'warn' : 'info', `${outcome.simulated ? 'Simulated' : 'Completed'} ${step.name}${entry.decision !== undefined ? ` → ${entry.decision}` : ''}`, id);
      continue;
    }

    // Failure handling (§25).
    const { strategy, then } = strategyFor(pb, step, failure);
    let effective = strategy === 'retry' ? then || 'stop' : strategy;
    entry.error = { code: failure.code, message: failure.message };
    log('error', `${step.name} failed: ${failure.message}`, id);
    if (effective === 'fallback') {
      const fb = step.fallback !== undefined ? step.fallback : step.execution && step.execution.fallback;
      if (fb !== undefined) {
        let value = fb;
        if (typeof fb === 'string' && step.execution && step.execution.fallback === fb) {
          try {
            value = evaluate(fb, scope);
          } catch {
            value = fb;
          }
        }
        status[id] = 'completed';
        entry.status = 'completed';
        entry.output = value;
        entry.message = `Fallback used after ${failure.code}.`;
        scope.steps[id] = value;
        warnings.push({ step_id: id, code: 'FALLBACK_USED', message: `${step.name}: ${failure.message} — fallback used.` });
        trace.push(entry);
        continue;
      }
      effective = 'stop';
    }
    if (effective === 'skip') {
      status[id] = 'skipped';
      entry.status = 'skipped';
      entry.message = `Skipped after ${failure.code}.`;
      warnings.push({ step_id: id, code: failure.code, message: `${step.name}: ${failure.message} (skipped)` });
      trace.push(entry);
      continue;
    }
    if (effective === 'continue_with_warning') {
      status[id] = 'completed';
      entry.status = 'completed';
      entry.warning = true;
      entry.output = null;
      entry.message = `Continued with warning after ${failure.code}.`;
      scope.steps[id] = null;
      warnings.push({ step_id: id, code: failure.code, message: `${step.name}: ${failure.message}` });
      trace.push(entry);
      continue;
    }
    status[id] = 'failed';
    entry.status = 'failed';
    trace.push(entry);
    const runStatus = effective === 'request_input' ? 'needs_input' : 'failed';
    return result(runStatus, {
      output: scope.state.__output === undefined ? null : scope.state.__output,
      error: { code: failure.code, message: failure.message, step_id: id, strategy: effective, ...(failure.missing ? { missing: failure.missing.filter(Boolean) } : {}) },
      validation: { passed: false, issues: [failure.message] },
      state: scope.state,
    });
  }

  // Final output.
  let output = scope.state.__output;
  if (output === undefined) {
    for (let i = trace.length - 1; i >= 0; i--) {
      if (trace[i].status === 'completed' && trace[i].output !== undefined && trace[i].output !== null) {
        output = trace[i].output;
        break;
      }
    }
  }
  if (output === undefined) output = null;
  const issues = [];
  if (output === null) issues.push('No output was produced.');
  else if (pb.output && isPlainObject(pb.output.schema)) issues.push(...formatSchemaErrors(validateSchema(output, pb.output.schema, 'output'), 20));
  const validation = { passed: issues.length === 0, issues };
  if (!validation.passed && simulatedSteps.length) {
    validation.inconclusive = true;
    warnings.push({ code: 'VALIDATION_INCONCLUSIVE', message: `Output validation is inconclusive because ${simulatedSteps.join(', ')} ran simulated: ${issues.join('; ')}` });
    log('warn', 'Output validation inconclusive (simulated steps).');
    return result('completed', { output, validation, state: scope.state });
  }
  if (!validation.passed && requireValidation) {
    log('error', `Output validation failed: ${issues.join('; ')}`);
    return result('failed', { output, error: { code: 'OUTPUT_INVALID', message: issues.join('; ') }, validation, state: scope.state });
  }
  if (!validation.passed) warnings.push({ code: 'OUTPUT_INVALID', message: issues.join('; ') });
  log('info', 'Run completed.');
  return result('completed', { output, validation, state: scope.state });
}

function ex_assigns_nothing(step) {
  const ex = step.execution;
  if (!ex) return true;
  return !ex.assign && !ex.values;
}
