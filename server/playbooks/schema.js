// Canonical Playbook structure (spec §5, §13) and normalization of loosely
// shaped input (AI output, user edits, imports) into that structure.
import { asArray, isPlainObject, newId, pad2, slugify, stableStringify, sha256 } from '../util.js';
import { normalizeOperator } from '../engine/rules.js';
import { schemaFromFields } from '../engine/jsonschema.js';

export const SCHEMA_VERSION = '1.0';

export const STEP_TYPES = ['input', 'retrieve', 'validate', 'transform', 'calculate', 'decision', 'action', 'approval', 'generate', 'output', 'notify', 'wait', 'task'];
export const FAILURE_STRATEGIES = ['retry', 'skip', 'fallback', 'stop', 'request_input', 'continue_with_warning'];
export const TRIGGER_TYPES = ['manual', 'schedule', 'webhook', 'event', 'api', 'user_request'];
export const DEPENDENCY_TYPES = ['data', 'system', 'tool', 'authentication', 'workflow', 'configuration', 'human', 'ai'];
export const REQUIREMENT_TYPES = ['functional', 'data', 'business_rule', 'output', 'non_functional', 'constraint'];
export const VALIDATION_LEVELS = ['step', 'workflow', 'output', 'intent'];
export const EXECUTION_OPS = ['validate', 'set', 'decide', 'filter', 'map', 'tool', 'llm', 'approval', 'output', 'validate_output', 'noop'];

const str = (v) => (v === undefined || v === null ? '' : typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : Array.isArray(v) ? v.map(str).filter(Boolean).join('; ') : isPlainObject(v) ? (v.text || v.description || v.name || JSON.stringify(v)) : String(v));

const bool = (v, dflt) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.toLowerCase().trim();
    if (['yes', 'true', 'required', 'y'].includes(s)) return true;
    if (['no', 'false', 'optional', 'n', 'not required'].includes(s)) return false;
  }
  return dflt;
};

export function stringList(v) {
  if (typeof v === 'string') {
    return v
      .split(/\r?\n/)
      .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
      .filter(Boolean);
  }
  return asArray(v).map(str).filter(Boolean);
}

function normId(v, fallback) {
  const s = str(v).replace(/[^A-Za-z0-9_.-]/g, '_');
  return s || fallback;
}

// ---------------------------------------------------------------- sections

const REQ_TYPE_ALIASES = {
  functional: 'functional',
  function: 'functional',
  data: 'data',
  business_rule: 'business_rule',
  business_rules: 'business_rule',
  business: 'business_rule',
  rule: 'business_rule',
  rules: 'business_rule',
  output: 'output',
  outputs: 'output',
  non_functional: 'non_functional',
  nonfunctional: 'non_functional',
  quality: 'non_functional',
  constraint: 'constraint',
  constraints: 'constraint',
};

function reqType(t) {
  const k = str(t).toLowerCase().replace(/[\s-]+/g, '_');
  return REQ_TYPE_ALIASES[k] || (REQUIREMENT_TYPES.includes(k) ? k : 'functional');
}

export function normRequirements(v) {
  const out = [];
  const add = (item, type) => {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ id: '', type: reqType(type), text: item.trim() });
      return;
    }
    if (!isPlainObject(item)) return;
    const text = str(item.text || item.requirement || item.description || item.name);
    if (!text) return;
    const req = { id: str(item.id), type: reqType(item.type || item.category || type), text };
    if (isPlainObject(item.rule)) {
      req.rule = normRuleCondition(item.rule);
      const result = item.result !== undefined ? item.result : item.rule.result;
      if (result !== undefined) req.result = result;
    }
    out.push(req);
  };
  if (isPlainObject(v)) {
    for (const [k, items] of Object.entries(v)) asArray(items).forEach((i) => add(i, k));
  } else {
    asArray(v).forEach((i) => add(i, 'functional'));
  }
  const used = new Set();
  out.forEach((r, i) => {
    let id = normId(r.id, `req_${pad2(i + 1)}`);
    while (used.has(id)) id = `${id}_${i + 1}`;
    used.add(id);
    r.id = id;
  });
  return out;
}

const DEP_TYPE_ALIASES = {
  systems: 'system', system: 'system', data: 'data', tools: 'tool', tool: 'tool', ai: 'ai', model: 'ai',
  permissions: 'authentication', permission: 'authentication', auth: 'authentication', authentication: 'authentication',
  workflow: 'workflow', configuration: 'configuration', config: 'configuration', human: 'human', people: 'human',
};

export function normDependencies(v) {
  const out = [];
  const add = (item, type) => {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ id: '', type: DEP_TYPE_ALIASES[type] || 'system', name: item.trim(), description: '', required: true });
      return;
    }
    if (!isPlainObject(item)) return;
    const name = str(item.name || item.dependency || item.text || item.description);
    if (!name) return;
    const t = str(item.type || type).toLowerCase();
    out.push({
      id: str(item.id),
      type: DEP_TYPE_ALIASES[t] || (DEPENDENCY_TYPES.includes(t) ? t : 'system'),
      name,
      description: str(item.description && item.description !== name ? item.description : item.details),
      required: bool(item.required, true),
    });
  };
  if (isPlainObject(v)) {
    for (const [k, items] of Object.entries(v)) asArray(items).forEach((i) => add(i, k.toLowerCase()));
  } else asArray(v).forEach((i) => add(i, 'system'));
  out.forEach((d, i) => {
    d.id = normId(d.id, `dep_${pad2(i + 1)}`);
  });
  return out;
}

export function normInputs(v) {
  const list = isPlainObject(v) && !v.name && !v.id ? Object.entries(v).map(([k, val]) => ({ id: k, ...(isPlainObject(val) ? val : { description: str(val) }) })) : asArray(v);
  const out = [];
  list.forEach((item, i) => {
    if (typeof item === 'string') item = { name: item };
    if (!isPlainObject(item)) return;
    const name = str(item.name || item.id) || `Input ${i + 1}`;
    const input = {
      id: normId(item.id || slugify(name).replace(/-/g, '_'), `input_${i + 1}`),
      name,
      description: str(item.description),
      type: str(item.type) || 'object',
      required: bool(item.required, true),
      source: str(item.source) || 'Run input',
      validation: stringList(item.validation || item.validation_rules),
    };
    if (item.example !== undefined) input.example = item.example;
    if (isPlainObject(item.schema)) input.schema = item.schema;
    out.push(input);
  });
  return out;
}

function inferType(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  if (isPlainObject(value)) return 'object';
  return 'string';
}

export function normConfiguration(v) {
  const list = isPlainObject(v) ? Object.entries(v).map(([name, val]) => (isPlainObject(val) && 'value' in val ? { name, ...val } : { name, value: val })) : asArray(v);
  const out = [];
  const used = new Set();
  for (const item of list) {
    if (!isPlainObject(item)) continue;
    const name = str(item.name || item.key || item.id).replace(/[^A-Za-z0-9_]/g, '_');
    if (!name || used.has(name)) continue;
    used.add(name);
    let value = item.value !== undefined ? item.value : item.default;
    let type = str(item.type).toLowerCase() || inferType(value);
    if ((type === 'number' || type === 'integer') && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) value = Number(value);
    if (type === 'boolean' && typeof value === 'string') value = bool(value, false);
    const cfg = { name, type, value: value === undefined ? null : value, description: str(item.description) };
    const allowed = item.allowed_values || item.options || item.enum;
    if (Array.isArray(allowed) && allowed.length) {
      cfg.allowed_values = allowed;
      if (cfg.type !== 'enum' && typeof allowed[0] === 'string') cfg.type = 'enum';
    }
    if (typeof item.min === 'number') cfg.min = item.min;
    if (typeof item.max === 'number') cfg.max = item.max;
    out.push(cfg);
  }
  return out;
}

export function normTools(v) {
  const out = [];
  asArray(v).forEach((item, i) => {
    if (typeof item === 'string') item = { name: item };
    if (!isPlainObject(item)) return;
    const name = str(item.name || item.id) || `Tool ${i + 1}`;
    const permission = str(item.permission || item.permissions || item.access).toLowerCase() || 'read-only';
    const tool = {
      id: normId(item.id || slugify(name).replace(/-/g, '_'), `tool_${i + 1}`),
      name,
      purpose: str(item.purpose || item.description),
      permission: /write|modify|update|create|delete|send|execute/.test(permission) ? (/read/.test(permission) ? 'read-write' : 'write') : /none|not/.test(permission) ? 'none' : 'read-only',
      required: bool(item.required, true),
    };
    if (isPlainObject(item.binding)) tool.binding = item.binding;
    if (item.side_effects) tool.side_effects = str(item.side_effects).toLowerCase();
    out.push(tool);
  });
  return out;
}

export function normPermissions(v) {
  const out = [];
  const add = (action, allowed) => {
    const a = str(action);
    if (a) out.push({ action: a, allowed });
  };
  if (isPlainObject(v)) {
    for (const [k, items] of Object.entries(v)) {
      const key = k.toLowerCase().replace(/[\s-]+/g, '_');
      const allowed = !/not|deny|denied|forbid|disallow|prohibit|never/.test(key);
      asArray(items).forEach((i) => (isPlainObject(i) ? add(i.action || i.name || i.text, bool(i.allowed, allowed)) : add(i, allowed)));
    }
  } else {
    for (const item of asArray(v)) {
      if (typeof item === 'string') {
        const denied = /^\s*(not allowed|never|do not|don't|must not|no )/i.test(item);
        add(item.replace(/^\s*(allowed|not allowed)\s*:\s*/i, ''), !denied);
      } else if (isPlainObject(item)) {
        add(item.action || item.name || item.permission || item.text, bool(item.allowed, !/deny|not/i.test(str(item.effect))));
      }
    }
  }
  return out;
}

export function normTrigger(v) {
  let t = isPlainObject(v) ? { ...v } : { type: str(v) };
  let type = str(t.type).toLowerCase().replace(/[\s-]+/g, '_');
  const alias = { scheduled: 'schedule', cron: 'schedule', timer: 'schedule', on_demand: 'manual', ondemand: 'manual', http: 'webhook', api_call: 'api', request: 'user_request', user: 'user_request' };
  type = alias[type] || type;
  if (!TRIGGER_TYPES.includes(type)) type = t.frequency || t.cron ? 'schedule' : 'manual';
  const out = { type };
  for (const k of ['frequency', 'day', 'time', 'timezone', 'cron', 'event', 'description', 'source']) {
    if (t[k] !== undefined && t[k] !== null && t[k] !== '') out[k] = str(t[k]);
  }
  if (typeof t.interval_minutes === 'number') out.interval_minutes = t.interval_minutes;
  return out;
}

function normFailure(v) {
  if (isPlainObject(v)) {
    const s = normStrategy(v.strategy || v.on_failure || v.behavior);
    return s;
  }
  return normStrategy(v);
}

export function normStrategy(v) {
  const s = str(v).toLowerCase().replace(/[\s-]+/g, '_');
  if (FAILURE_STRATEGIES.includes(s)) return s;
  if (/^retry/.test(s)) return 'retry';
  if (/request|ask|input/.test(s)) return 'request_input';
  if (/warn|continue/.test(s)) return 'continue_with_warning';
  if (/skip/.test(s)) return 'skip';
  if (/fallback|default/.test(s)) return 'fallback';
  return 'stop';
}

export function normRetry(v) {
  if (v === undefined || v === null || v === '' || v === false) return 'not_applicable';
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    if (/not.?applicable|none|no retry|never|n\/a/.test(s)) return 'not_applicable';
    const m = /(\d+)/.exec(s);
    return { enabled: true, max_attempts: m ? Math.max(1, Math.min(10, Number(m[1]))) : 2, retry_on: ['timeout', 'temporary_provider_error'], backoff_seconds: 2 };
  }
  if (typeof v === 'number') return { enabled: true, max_attempts: Math.max(1, Math.min(10, v)), retry_on: ['timeout', 'temporary_provider_error'], backoff_seconds: 2 };
  if (isPlainObject(v)) {
    if (v.enabled === false) return 'not_applicable';
    return {
      enabled: true,
      max_attempts: Math.max(1, Math.min(10, Number(v.max_attempts || v.attempts || v.max_retries || 2))),
      retry_on: stringList(v.retry_on || v.on || ['timeout', 'temporary_provider_error']),
      backoff_seconds: Number.isFinite(Number(v.backoff_seconds)) ? Number(v.backoff_seconds) : 2,
    };
  }
  return 'not_applicable';
}

function normDecisionLogic(v) {
  const out = [];
  for (const item of asArray(v)) {
    if (typeof item === 'string') {
      const m = /^(.*?)\s*(?:→|->|=>|:)\s*(.+)$/.exec(item);
      out.push(m ? { condition: m[1].trim(), result: m[2].trim() } : { condition: item, result: '' });
      continue;
    }
    if (!isPlainObject(item)) continue;
    const b = {
      condition: str(item.condition || item.if || item.when_text || (typeof item.when === 'string' ? item.when : '')),
      result: str(item.result || item.outcome || item.then || item.label),
    };
    const next = item.next || item.next_step || item.goto || item.then_step;
    if (next) b.next = Array.isArray(next) ? next.map(str) : str(next);
    if (item.rule_id) b.rule_id = str(item.rule_id);
    if (item.label && item.label !== b.result) b.label = str(item.label);
    out.push(b);
  }
  return out;
}

function normStepOutput(step) {
  const o = step.output;
  let out;
  if (isPlainObject(o)) {
    out = { name: str(o.name) || 'result', type: str(o.type) || 'object', description: str(o.description) };
    if (isPlainObject(o.schema)) out.schema = o.schema;
  } else if (typeof o === 'string' && o.trim()) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(\[\])?/.exec(o.trim());
    out = { name: m ? m[1] : 'result', type: m && m[2] ? 'array' : 'object', description: m ? o.trim().slice(m[0].length).replace(/^[\s:—-]+/, '') : o.trim() };
  } else {
    out = { name: 'result', type: 'object', description: '' };
  }
  const schema = step.output_schema || step.outputSchema;
  if (isPlainObject(schema) && !out.schema) out.schema = schema;
  if (step.expected_output && !out.description) out.description = str(step.expected_output);
  return out;
}

export function normSteps(v) {
  const list = asArray(v).filter(isPlainObject);
  const steps = list.map((s, i) => {
    let type = str(s.type || s.step_type).toLowerCase().replace(/[\s-]+/g, '_');
    const typeAlias = { validation: 'validate', validator: 'validate', fetch: 'retrieve', read: 'retrieve', collect: 'retrieve', calculation: 'calculate', compute: 'calculate', branch: 'decision', condition: 'decision', human_approval: 'approval', review: 'approval', report: 'generate', llm: 'generate', analysis: 'transform', analyze: 'transform', normalize: 'transform', send: 'notify', notification: 'notify' };
    type = typeAlias[type] || type;
    if (!STEP_TYPES.includes(type)) type = 'task';
    const step = {
      id: normId(s.id, `step_${pad2(i + 1)}`),
      name: str(s.name || s.title) || `Step ${i + 1}`,
      type,
      purpose: str(s.purpose || s.description || s.goal),
      rationale: str(s.rationale || s.why || s.why_it_exists || s.reason),
      dependencies: stringList(s.dependencies || s.depends_on || s.after),
      inputs: asArray(s.inputs).map((x) => (isPlainObject(x) ? str(x.name || x.id || x.source) : str(x))).filter(Boolean),
      preconditions: stringList(s.preconditions),
      instructions: stringList(s.instructions || s.actions_list || s.procedure),
      decision_logic: normDecisionLogic(s.decision_logic || s.branches || s.decisions),
      tools: asArray(s.tools).map((t) => (isPlainObject(t) ? str(t.id || t.name) : str(t))).filter(Boolean),
      output: normStepOutput(s),
      validation: stringList(s.validation),
      postconditions: stringList(s.postconditions),
      failure_behavior: normFailure(s.failure_behavior || s.on_failure || s.error_handling),
      retry_behavior: normRetry(s.retry_behavior ?? s.retry),
    };
    if (s.requires_approval || type === 'approval') step.requires_approval = true;
    if (s.parallel_group) step.parallel_group = str(s.parallel_group);
    if (s.side_effects) step.side_effects = str(s.side_effects).toLowerCase();
    if (isPlainObject(s.execution) && s.execution.op) step.execution = s.execution;
    if (isPlainObject(s.failure_behavior) && s.failure_behavior.fallback !== undefined) step.fallback = s.failure_behavior.fallback;
    if (s.fallback !== undefined) step.fallback = s.fallback;
    return step;
  });
  // Unique ids.
  const used = new Set();
  steps.forEach((s, i) => {
    if (used.has(s.id)) s.id = `${s.id}_${i + 1}`;
    used.add(s.id);
  });
  // Allow dependencies / branch targets written as step names or numbers.
  const byName = new Map();
  steps.forEach((s, i) => {
    byName.set(s.name.toLowerCase(), s.id);
    byName.set(`step ${i + 1}`, s.id);
    byName.set(String(i + 1), s.id);
  });
  const resolve = (ref) => {
    if (used.has(ref)) return ref;
    const key = String(ref).toLowerCase().replace(/^step\s*[-—:]?\s*/, 'step ').trim();
    return byName.get(key) || byName.get(String(ref).toLowerCase()) || byName.get(key.replace(/^step\s*/, '')) || ref;
  };
  for (const s of steps) {
    s.dependencies = [...new Set(s.dependencies.map(resolve))];
    for (const b of s.decision_logic) {
      if (Array.isArray(b.next)) b.next = b.next.map(resolve);
      else if (b.next) b.next = resolve(b.next);
    }
  }
  return steps;
}

/** Normalize a rule condition; also converts "{{config.x}}" strings into value_ref. */
export function normRuleCondition(w) {
  if (!isPlainObject(w)) {
    if (typeof w === 'string' && w.trim()) return { expression: w.trim() };
    return { otherwise: true };
  }
  if (w.otherwise || w.always || w.else || w.default) return { otherwise: true };
  if (Array.isArray(w.all)) return { all: w.all.map(normRuleCondition) };
  if (Array.isArray(w.any)) return { any: w.any.map(normRuleCondition) };
  if (w.not) return { not: normRuleCondition(w.not) };
  if (typeof w.expression === 'string') return { expression: w.expression };
  const out = { field: str(w.field || w.metric || w.variable), operator: normalizeOperator(w.operator || w.op || w.comparison) || str(w.operator) };
  let value = w.value !== undefined ? w.value : w.threshold;
  const refPattern = /^\s*(?:\{\{\s*)?((?:config|configuration)\.[A-Za-z0-9_]+)(?:\s*\}\})?\s*$/;
  if (w.value_ref) out.value_ref = str(w.value_ref).replace(/^\{\{\s*|\s*\}\}$/g, '').replace(/^configuration\./, 'config.');
  else if (typeof value === 'string' && refPattern.test(value)) out.value_ref = refPattern.exec(value)[1].replace(/^configuration\./, 'config.');
  else if (value !== undefined) out.value = value;
  return out;
}

export function normRules(v, steps = []) {
  const stepIds = new Set(steps.map((s) => s.id));
  const out = [];
  asArray(v).forEach((r, i) => {
    if (!isPlainObject(r)) return;
    let when = r.when;
    if (!when && r.condition && isPlainObject(r.condition)) when = r.condition;
    if (!when && typeof r.condition === 'string') when = { expression: r.condition };
    if (!when && (r.field || r.operator)) when = { field: r.field, operator: r.operator, value: r.value, value_ref: r.value_ref };
    const rule = {
      id: normId(r.id, `rule_${pad2(i + 1)}`),
      name: str(r.name) || `Rule ${i + 1}`,
      step_id: str(r.step_id || r.step) || '',
      priority: Number.isFinite(Number(r.priority)) ? Number(r.priority) : i + 1,
      when: normRuleCondition(when),
      result: r.result === undefined ? str(r.outcome || r.then) : typeof r.result === 'string' ? r.result.trim() : r.result,
      description: str(r.description),
    };
    if (rule.step_id && !stepIds.has(rule.step_id)) {
      const match = steps.find((s) => s.name.toLowerCase() === rule.step_id.toLowerCase());
      if (match) rule.step_id = match.id;
    }
    out.push(rule);
  });
  const used = new Set();
  out.forEach((r, i) => {
    if (used.has(r.id)) r.id = `${r.id}_${i + 1}`;
    used.add(r.id);
  });
  return out;
}

export function normOutput(v) {
  const o = isPlainObject(v) ? v : { description: str(v) };
  const out = {
    format: str(o.format).toLowerCase() || 'json',
    description: str(o.description),
    sections: stringList(o.sections),
    fields: [],
  };
  const fields = asArray(o.fields || o.required_fields).map((f) => {
    if (typeof f === 'string') return { name: f.replace(/[^A-Za-z0-9_]/g, '_'), type: 'string', required: true, description: '' };
    if (!isPlainObject(f)) return null;
    const field = { name: str(f.name), type: str(f.type) || 'string', required: bool(f.required, true), description: str(f.description) };
    if (Array.isArray(f.enum)) field.enum = f.enum;
    if (Array.isArray(f.allowed_values)) field.enum = f.allowed_values;
    if (f.nullable) field.nullable = true;
    return field.name ? field : null;
  });
  out.fields = fields.filter(Boolean);
  if (isPlainObject(o.schema)) out.schema = o.schema;
  if (!out.schema && out.fields.length && out.format === 'json') out.schema = schemaFromFields(out.fields);
  if (!out.fields.length && isPlainObject(out.schema) && isPlainObject(out.schema.properties)) {
    const req = new Set(asArray(out.schema.required));
    out.fields = Object.entries(out.schema.properties).map(([name, s]) => {
      const f = { name, type: Array.isArray(s.type) ? s.type.filter((t) => t !== 'null')[0] || 'string' : s.type || 'string', required: req.has(name), description: str(s.description) };
      if (Array.isArray(s.enum)) f.enum = s.enum;
      return f;
    });
  }
  if (o.destination) out.destination = str(o.destination);
  if (o.example !== undefined) out.example = o.example;
  return out;
}

function levelOf(text, dflt) {
  const s = String(text || '').toLowerCase();
  if (VALIDATION_LEVELS.includes(s)) return s;
  return dflt;
}

export function normValidation(v) {
  const out = [];
  const add = (item, level) => {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ id: '', level, rule: item.trim() });
    } else if (isPlainObject(item)) {
      const rule = str(item.rule || item.check_text || item.description || item.text);
      if (!rule) return;
      const entry = { id: str(item.id), level: levelOf(item.level, level), rule };
      if (isPlainObject(item.check)) entry.check = item.check;
      out.push(entry);
    }
  };
  if (isPlainObject(v)) {
    for (const [k, items] of Object.entries(v)) asArray(items).forEach((i) => add(i, levelOf(k.replace(/_validation$/, ''), 'output')));
  } else asArray(v).forEach((i) => add(i, 'output'));
  out.forEach((e, i) => {
    e.id = normId(e.id, `val_${pad2(i + 1)}`);
  });
  return out;
}

export function normErrorHandling(v, topRetry) {
  const e = isPlainObject(v) ? v : {};
  const strategies = [];
  const list = Array.isArray(v) ? v : asArray(e.strategies || e.rules || e.cases);
  list.forEach((item, i) => {
    if (typeof item === 'string') {
      strategies.push({ id: `err_${pad2(i + 1)}`, on: 'error', strategy: normStrategy(item), notes: item });
      return;
    }
    if (!isPlainObject(item)) return;
    const s = {
      id: normId(item.id, `err_${pad2(i + 1)}`),
      on: str(item.on || item.error || item.condition || item.when) || 'error',
      strategy: normStrategy(item.strategy || item.action || item.then),
    };
    if (item.step_id) s.step_id = str(item.step_id);
    if (item.then_strategy || item.after || item.then) {
      const after = normStrategy(item.then_strategy || item.after || item.then);
      if (after !== s.strategy) s.then = after;
    }
    if (item.notes || item.description) s.notes = str(item.notes || item.description);
    strategies.push(s);
  });
  const retrySrc = e.retry || e.retry_policy || topRetry;
  const retry = normRetry(retrySrc === undefined ? { enabled: true, max_attempts: 2 } : retrySrc);
  return {
    default_strategy: normStrategy(e.default_strategy || e.default || 'stop'),
    strategies,
    retry: retry === 'not_applicable' ? { enabled: false, max_attempts: 1, retry_on: [], backoff_seconds: 0 } : retry,
  };
}

export function normCriteria(v) {
  return asArray(v)
    .map((c, i) => (typeof c === 'string' ? { id: `sc_${pad2(i + 1)}`, text: c.trim() } : isPlainObject(c) ? { id: normId(c.id, `sc_${pad2(i + 1)}`), text: str(c.text || c.criterion || c.description) } : null))
    .filter((c) => c && c.text);
}

// ---------------------------------------------------------------- playbook

export function normalizePlaybook(raw, { id, version } = {}) {
  const src = isPlainObject(raw) ? raw : {};
  const pb = {
    schema_version: SCHEMA_VERSION,
    id: id || str(src.id) || newId('pb'),
    name: str(src.name || src.title) || 'Untitled Playbook',
    description: str(src.description),
    version: version ?? (Number.isInteger(src.version) ? src.version : 1),
    objective: str(src.objective),
    scope: isPlainObject(src.scope)
      ? [src.scope.in_scope && `In scope: ${stringList(src.scope.in_scope).join('; ')}`, src.scope.out_of_scope && `Out of scope: ${stringList(src.scope.out_of_scope).join('; ')}`].filter(Boolean).join('. ')
      : str(src.scope),
    requirements: normRequirements(src.requirements),
    assumptions: stringList(src.assumptions),
    dependencies: normDependencies(src.dependencies),
    ai: {
      connection_id: isPlainObject(src.ai) && src.ai.connection_id ? str(src.ai.connection_id) : null,
      model: isPlainObject(src.ai) && src.ai.model ? str(src.ai.model) : null,
    },
    inputs: normInputs(src.inputs),
    configuration: normConfiguration(src.configuration),
    tools: normTools(src.tools),
    permissions: normPermissions(src.permissions),
    trigger: normTrigger(src.trigger),
    steps: [],
    decision_rules: [],
    output: normOutput(src.output),
    validation: normValidation(src.validation),
    error_handling: normErrorHandling(src.error_handling, src.retry || src.retry_policy),
    success_criteria: normCriteria(src.success_criteria),
    tests: Array.isArray(src.tests) ? src.tests : [],
  };
  pb.steps = normSteps(src.steps);
  pb.decision_rules = normRules(src.decision_rules, pb.steps);
  return pb;
}

/** Map of configuration name → value. */
export function configMap(pb, overrides) {
  const map = {};
  for (const c of asArray(pb && pb.configuration)) map[c.name] = c.value;
  if (isPlainObject(overrides)) for (const [k, v] of Object.entries(overrides)) map[k] = v;
  return map;
}

/** The procedure without identity, tests or cosmetic fields — used for change detection. */
export function procedureOf(pb) {
  const { id, version, tests, name, description, ...rest } = pb || {};
  return rest;
}

export function procedureHash(pb) {
  return sha256(stableStringify(procedureOf(pb))).slice(0, 16);
}
