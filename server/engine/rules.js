// Machine-readable decision rules (spec §18). A rule's `when` is one of:
//   { field, operator, value }            literal comparison
//   { field, operator, value_ref }        compare with config/state value
//   { all: [...] } | { any: [...] } | { not: {...} }
//   { expression: "..." }                 expression language (expr.js)
//   { otherwise: true }                   fallback branch
import { evaluate, compare, looseEqual, parseExpression } from './expr.js';
import { getPath } from '../util.js';

export const OPERATORS = {
  equals: { symbol: '==', label: 'equals' },
  not_equals: { symbol: '!=', label: 'does not equal' },
  greater_than: { symbol: '>', label: 'greater than' },
  greater_than_or_equal: { symbol: '>=', label: 'greater than or equal to' },
  less_than: { symbol: '<', label: 'less than' },
  less_than_or_equal: { symbol: '<=', label: 'less than or equal to' },
  between: { symbol: 'between', label: 'between (inclusive)' },
  contains: { symbol: 'contains', label: 'contains' },
  not_contains: { symbol: 'not contains', label: 'does not contain' },
  in: { symbol: 'in', label: 'is one of' },
  not_in: { symbol: 'not in', label: 'is not one of' },
  exists: { symbol: 'exists', label: 'is present' },
  not_exists: { symbol: 'is missing', label: 'is missing' },
  is_empty: { symbol: 'is empty', label: 'is empty' },
  is_not_empty: { symbol: 'is not empty', label: 'is not empty' },
  matches: { symbol: 'matches', label: 'matches pattern' },
  starts_with: { symbol: 'starts with', label: 'starts with' },
  ends_with: { symbol: 'ends with', label: 'ends with' },
};

const ALIASES = {
  '>': 'greater_than',
  gt: 'greater_than',
  '>=': 'greater_than_or_equal',
  gte: 'greater_than_or_equal',
  greater_than_or_equals: 'greater_than_or_equal',
  greater_or_equal: 'greater_than_or_equal',
  '<': 'less_than',
  lt: 'less_than',
  '<=': 'less_than_or_equal',
  lte: 'less_than_or_equal',
  less_than_or_equals: 'less_than_or_equal',
  less_or_equal: 'less_than_or_equal',
  '==': 'equals',
  '=': 'equals',
  eq: 'equals',
  equal: 'equals',
  '!=': 'not_equals',
  neq: 'not_equals',
  not_equal: 'not_equals',
  missing: 'not_exists',
  is_missing: 'not_exists',
  is_null: 'not_exists',
  present: 'exists',
  is_present: 'exists',
  not_empty: 'is_not_empty',
  empty: 'is_empty',
  one_of: 'in',
  not_one_of: 'not_in',
  regex: 'matches',
};

export function normalizeOperator(op) {
  if (!op) return null;
  const key = String(op).trim().toLowerCase().replace(/\s+/g, '_');
  if (OPERATORS[key]) return key;
  if (ALIASES[key]) return ALIASES[key];
  if (ALIASES[String(op).trim()]) return ALIASES[String(op).trim()];
  return null;
}

const GLOBAL_ROOTS = ['input.', 'config.', 'configuration.', 'state.', 'steps.', 'item.', 'tools.'];

/** Resolve a rule field: subject-relative first, then state, then input. */
export function resolveField(field, scope, subjectPath) {
  const f = String(field || '').trim();
  if (!f) return { found: false, value: undefined, path: f };
  if (GLOBAL_ROOTS.some((r) => f.startsWith(r))) {
    const p = f.startsWith('configuration.') ? `config.${f.slice('configuration.'.length)}` : f;
    const value = getPath(scope, p);
    return { found: value !== undefined, value, path: p };
  }
  const candidates = [];
  if (scope.item !== undefined) candidates.push(`item.${f}`);
  if (subjectPath) candidates.push(`${subjectPath}.${f}`);
  candidates.push(`state.${f}`, `input.${f}`);
  for (const p of candidates) {
    const value = getPath(scope, p);
    if (value !== undefined) return { found: true, value, path: p };
  }
  return { found: false, value: undefined, path: candidates[0] || f };
}

/**
 * Scope for free-form rule expressions: bare names resolve against the item,
 * the decision subject, state and configuration (in that order), while the
 * explicit roots (input., config., state., steps., item.) keep working.
 */
export function flatScope(scope, subjectPath) {
  const subject = subjectPath ? getPath(scope, subjectPath) : undefined;
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  return {
    ...obj(scope.config),
    ...obj(scope.state),
    ...obj(subject),
    ...obj(scope.item),
    input: scope.input,
    config: scope.config,
    configuration: scope.config,
    state: scope.state,
    steps: scope.steps,
    item: scope.item,
    subject,
    __now: scope.__now,
  };
}

export function resolveValue(when, scope) {
  if (when.value_ref !== undefined && when.value_ref !== null && when.value_ref !== '') {
    let ref = String(when.value_ref).trim().replace(/^\{\{\s*|\s*\}\}$/g, '');
    if (ref.startsWith('configuration.')) ref = `config.${ref.slice('configuration.'.length)}`;
    if (!ref.includes('.')) ref = `config.${ref}`;
    return { value: getPath(scope, ref), ref };
  }
  return { value: when.value, ref: null };
}

/**
 * Evaluate a condition. Returns { matched, missing: [paths], evidence: [...] }.
 * Missing fields never satisfy comparisons (they are reported instead).
 */
export function evaluateCondition(when, scope, subjectPath) {
  if (!when || typeof when !== 'object') return { matched: false, missing: [], evidence: [{ note: 'No condition defined' }] };
  if (when.otherwise || when.always || when.else) return { matched: true, missing: [], evidence: [{ note: 'Fallback branch (no earlier rule matched)' }] };
  if (Array.isArray(when.all)) {
    const parts = when.all.map((w) => evaluateCondition(w, scope, subjectPath));
    return { matched: parts.every((p) => p.matched), missing: parts.flatMap((p) => p.missing), evidence: parts.flatMap((p) => p.evidence) };
  }
  if (Array.isArray(when.any)) {
    const parts = when.any.map((w) => evaluateCondition(w, scope, subjectPath));
    return { matched: parts.some((p) => p.matched), missing: parts.flatMap((p) => p.missing), evidence: parts.flatMap((p) => p.evidence) };
  }
  if (when.not) {
    const inner = evaluateCondition(when.not, scope, subjectPath);
    return { matched: !inner.matched && !inner.missing.length, missing: inner.missing, evidence: inner.evidence };
  }
  if (typeof when.expression === 'string') {
    const result = evaluate(when.expression, flatScope(scope, subjectPath));
    return { matched: Boolean(result), missing: [], evidence: [{ expression: when.expression, result }] };
  }
  const op = normalizeOperator(when.operator);
  if (!op) throw Object.assign(new Error(`Unknown operator "${when.operator}"`), { code: 'INVALID_RULE' });
  const field = resolveField(when.field, scope, subjectPath);
  const { value: expected, ref } = resolveValue(when, scope);
  const actual = field.value;
  const evidence = { field: when.field, path: field.path, actual: actual === undefined ? null : actual, operator: op, expected: expected === undefined ? null : expected };
  if (ref) evidence.expected_ref = ref;
  const present = actual !== undefined && actual !== null;
  let matched;
  switch (op) {
    case 'exists':
      matched = present;
      break;
    case 'not_exists':
      matched = !present;
      break;
    case 'is_empty':
      matched = !present || actual === '' || (Array.isArray(actual) && actual.length === 0);
      break;
    case 'is_not_empty':
      matched = present && actual !== '' && !(Array.isArray(actual) && actual.length === 0);
      break;
    default: {
      if (!present) return { matched: false, missing: [field.path], evidence: [{ ...evidence, note: 'Field is missing; comparison not evaluated.' }] };
      if (ref && (expected === undefined || expected === null)) {
        return { matched: false, missing: [ref], evidence: [{ ...evidence, note: `Reference ${ref} is missing.` }] };
      }
      switch (op) {
        case 'equals':
          matched = looseEqual(actual, expected);
          break;
        case 'not_equals':
          matched = !looseEqual(actual, expected);
          break;
        case 'greater_than':
          matched = compare(actual, expected, '>');
          break;
        case 'greater_than_or_equal':
          matched = compare(actual, expected, '>=');
          break;
        case 'less_than':
          matched = compare(actual, expected, '<');
          break;
        case 'less_than_or_equal':
          matched = compare(actual, expected, '<=');
          break;
        case 'between': {
          const [lo, hi] = Array.isArray(expected) ? expected : [];
          matched = compare(actual, lo, '>=') && compare(actual, hi, '<=');
          break;
        }
        case 'contains':
          matched = Array.isArray(actual) ? actual.some((v) => looseEqual(v, expected)) : String(actual).toLowerCase().includes(String(expected).toLowerCase());
          break;
        case 'not_contains':
          matched = Array.isArray(actual) ? !actual.some((v) => looseEqual(v, expected)) : !String(actual).toLowerCase().includes(String(expected).toLowerCase());
          break;
        case 'in':
          matched = Array.isArray(expected) && expected.some((v) => looseEqual(actual, v));
          break;
        case 'not_in':
          matched = Array.isArray(expected) && !expected.some((v) => looseEqual(actual, v));
          break;
        case 'matches':
          try {
            matched = new RegExp(String(expected)).test(String(actual));
          } catch {
            throw Object.assign(new Error(`Invalid pattern "${expected}"`), { code: 'INVALID_RULE' });
          }
          break;
        case 'starts_with':
          matched = String(actual).startsWith(String(expected));
          break;
        case 'ends_with':
          matched = String(actual).endsWith(String(expected));
          break;
        default:
          matched = false;
      }
    }
  }
  return { matched: Boolean(matched), missing: [], evidence: [evidence] };
}

/** Rules sorted by priority (lower first), stable by declaration order. */
export function orderedRules(rules) {
  return rules
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (Number(a.r.priority ?? 1e9) - Number(b.r.priority ?? 1e9)) || a.i - b.i)
    .map((x) => x.r);
}

/**
 * First matching rule wins. Returns
 * { result, rule_id, rule_name, evidence, matched: bool, missing: [...] }.
 */
export function decide(rules, scope, subjectPath) {
  const ordered = orderedRules(rules);
  const missing = [];
  const considered = [];
  for (const rule of ordered) {
    const r = evaluateCondition(rule.when, scope, subjectPath);
    considered.push({ rule_id: rule.id, matched: r.matched, evidence: r.evidence });
    missing.push(...r.missing);
    if (r.matched) {
      return { matched: true, result: rule.result, rule_id: rule.id, rule_name: rule.name, evidence: r.evidence, considered, missing };
    }
  }
  return { matched: false, result: undefined, rule_id: null, rule_name: null, evidence: [], considered, missing };
}

function fmtValue(v) {
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/** Human-readable condition, e.g. "days_since_activity >= inactivity_threshold_days (14)". */
export function describeCondition(when, configMap = {}, { unicode = false } = {}) {
  if (!when || typeof when !== 'object') return '—';
  if (when.otherwise || when.always || when.else) return 'otherwise (no earlier rule matched)';
  if (Array.isArray(when.all)) return when.all.map((w) => describeCondition(w, configMap, { unicode })).join(' AND ');
  if (Array.isArray(when.any)) return '(' + when.any.map((w) => describeCondition(w, configMap, { unicode })).join(' OR ') + ')';
  if (when.not) return `NOT (${describeCondition(when.not, configMap, { unicode })})`;
  if (typeof when.expression === 'string') return when.expression;
  const op = normalizeOperator(when.operator);
  const meta = op ? OPERATORS[op] : null;
  let sym = meta ? meta.symbol : String(when.operator);
  if (unicode) sym = { '>=': '≥', '<=': '≤', '!=': '≠' }[sym] || sym;
  const field = String(when.field || '?');
  if (op === 'exists' || op === 'not_exists' || op === 'is_empty' || op === 'is_not_empty') return `${field} ${sym}`;
  let rhs;
  if (when.value_ref) {
    const ref = String(when.value_ref).replace(/^\{\{\s*|\s*\}\}$/g, '').replace(/^(config|configuration)\./, '');
    rhs = ref;
    if (Object.prototype.hasOwnProperty.call(configMap, ref)) rhs += ` (${fmtValue(configMap[ref])})`;
  } else {
    rhs = fmtValue(when.value);
  }
  return `${field} ${sym} ${rhs}`;
}

/** Collect every field referenced by a condition. */
export function conditionFields(when, out = []) {
  if (!when || typeof when !== 'object') return out;
  if (Array.isArray(when.all)) when.all.forEach((w) => conditionFields(w, out));
  else if (Array.isArray(when.any)) when.any.forEach((w) => conditionFields(w, out));
  else if (when.not) conditionFields(when.not, out);
  else if (when.field) out.push(String(when.field));
  return out;
}

/** Validate a condition's structure. Returns a list of problems. */
export function checkCondition(when, configNames = new Set()) {
  const problems = [];
  const walk = (w, where) => {
    if (!w || typeof w !== 'object') {
      problems.push(`${where}: condition must be an object`);
      return;
    }
    if (w.otherwise || w.always || w.else) return;
    if (Array.isArray(w.all)) return w.all.forEach((x, i) => walk(x, `${where}.all[${i}]`));
    if (Array.isArray(w.any)) return w.any.forEach((x, i) => walk(x, `${where}.any[${i}]`));
    if (w.not) return walk(w.not, `${where}.not`);
    if (typeof w.expression === 'string') {
      try {
        parseExpression(w.expression);
      } catch (err) {
        problems.push(`${where}: expression error — ${err.message}`);
      }
      return;
    }
    if (!w.field) problems.push(`${where}: missing field`);
    const op = normalizeOperator(w.operator);
    if (!op) problems.push(`${where}: unknown operator "${w.operator}"`);
    const needsValue = op && !['exists', 'not_exists', 'is_empty', 'is_not_empty'].includes(op);
    if (needsValue && w.value === undefined && !w.value_ref) problems.push(`${where}: missing value or value_ref`);
    if (w.value_ref) {
      const ref = String(w.value_ref).replace(/^\{\{\s*|\s*\}\}$/g, '');
      const m = /^(?:config|configuration)\.([A-Za-z0-9_]+)$/.exec(ref) || (/^[A-Za-z0-9_]+$/.test(ref) ? [null, ref] : null);
      if (m && configNames.size && !configNames.has(m[1])) problems.push(`${where}: value_ref "${w.value_ref}" is not a configuration value`);
    }
  };
  walk(when, 'when');
  return problems;
}
