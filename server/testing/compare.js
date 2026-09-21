// Structured comparison of expected vs actual results (spec §40: compare
// structured fields, not raw text). Supports a few matchers for fields whose
// exact value cannot be known up front:
//   {"$exists":true} {"$type":"string"} {"$contains":"x"} {"$regex":"^a"}
//   {"$gte":1} {"$lte":5} {"$gt":0} {"$lt":9} {"$in":[...]} {"$ne":x}
//   {"$approx":[value, tolerance]} {"$len":3} {"$not_empty":true} {"$any":true}
import { isPlainObject, stableStringify, getPath } from '../util.js';
import { looseEqual } from '../engine/expr.js';

const EPS = 1e-9;

const isMatcher = (v) => isPlainObject(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith('$'));

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function checkMatcher(m, actual) {
  const fails = [];
  for (const [k, v] of Object.entries(m)) {
    switch (k) {
      case '$any':
        break;
      case '$exists':
        if (Boolean(v) !== (actual !== undefined && actual !== null)) fails.push(v ? 'expected a value' : 'expected no value');
        break;
      case '$not_empty':
        if (actual === undefined || actual === null || actual === '' || (Array.isArray(actual) && !actual.length)) fails.push('expected a non-empty value');
        break;
      case '$type': {
        const t = typeName(actual);
        const ok = v === 'number' ? t === 'number' || t === 'integer' || (t === 'string' && actual.trim() !== '' && Number.isFinite(Number(actual))) : t === v;
        if (!ok) fails.push(`expected type ${v}, got ${t}`);
        break;
      }
      case '$contains':
        if (Array.isArray(actual) ? !actual.some((x) => looseEqual(x, v)) : !String(actual ?? '').toLowerCase().includes(String(v).toLowerCase())) fails.push(`expected to contain ${JSON.stringify(v)}`);
        break;
      case '$regex':
        try {
          if (!new RegExp(v, 'i').test(String(actual ?? ''))) fails.push(`expected to match /${v}/`);
        } catch {
          fails.push(`invalid pattern ${v}`);
        }
        break;
      case '$gte':
        if (!compareNumeric(actual, v, (a, b) => a >= b - EPS)) fails.push(`expected ≥ ${v}`);
        break;
      case '$lte':
        if (!compareNumeric(actual, v, (a, b) => a <= b + EPS)) fails.push(`expected ≤ ${v}`);
        break;
      case '$gt':
        if (!compareNumeric(actual, v, (a, b) => a > b)) fails.push(`expected > ${v}`);
        break;
      case '$lt':
        if (!compareNumeric(actual, v, (a, b) => a < b)) fails.push(`expected < ${v}`);
        break;
      case '$in':
        if (!Array.isArray(v) || !v.some((x) => looseEqual(x, actual))) fails.push(`expected one of ${JSON.stringify(v)}`);
        break;
      case '$ne':
        if (looseEqual(v, actual)) fails.push(`expected anything but ${JSON.stringify(v)}`);
        break;
      case '$approx': {
        const [target, tol = 0.01] = Array.isArray(v) ? v : [v, 0.01];
        if (!(typeof actual === 'number' && Math.abs(actual - target) <= tol)) fails.push(`expected ≈ ${target} (±${tol})`);
        break;
      }
      case '$len': {
        const n = typeof actual === 'string' || Array.isArray(actual) ? actual.length : -1;
        if (n !== v) fails.push(`expected length ${v}, got ${n < 0 ? 'none' : n}`);
        break;
      }
      default:
        fails.push(`unknown matcher ${k}`);
    }
  }
  return fails;
}

/** Ordered numeric comparison that accepts numbers the model returned as strings ("14"). */
function compareNumeric(actual, expected, ok) {
  if (typeof actual === 'number') return ok(actual, expected);
  if (typeof actual === 'string' && actual.trim() !== '' && Number.isFinite(Number(actual))) return ok(Number(actual), expected);
  return false;
}

/** Returns a list of mismatches: [{ path, expected, actual, message }]. */
export function compareExpected(expected, actual, path = 'output', out = []) {
  if (expected === undefined) return out;
  if (isMatcher(expected)) {
    for (const message of checkMatcher(expected, actual)) out.push({ path, expected, actual: actual === undefined ? null : actual, message });
    return out;
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) {
      out.push({ path, expected, actual: actual === undefined ? null : actual, message: 'expected an object' });
      return out;
    }
    for (const [k, v] of Object.entries(expected)) compareExpected(v, actual[k], `${path}.${k}`, out);
    return out;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      out.push({ path, expected, actual: actual === undefined ? null : actual, message: 'expected a list' });
      return out;
    }
    if (expected.length !== actual.length) out.push({ path, expected: `${expected.length} item(s)`, actual: `${actual.length} item(s)`, message: 'list length differs' });
    expected.forEach((v, i) => compareExpected(v, actual[i], `${path}[${i}]`, out));
    return out;
  }
  if (typeof expected === 'number' && typeof actual === 'number') {
    if (Math.abs(expected - actual) > EPS * Math.max(1, Math.abs(expected))) out.push({ path, expected, actual, message: 'number differs' });
    return out;
  }
  if (expected === null) {
    if (actual !== null && actual !== undefined) out.push({ path, expected: null, actual, message: 'expected null' });
    return out;
  }
  // AI execution often returns numbers as strings ("14" for 14) and booleans as
  // "true"/"false". Compare scalars the way the expression engine does, so a
  // semantically correct answer is not scored as a failure over its type.
  const numericExp = typeof expected === 'number' || (typeof expected === 'string' && expected.trim() !== '' && Number.isFinite(Number(expected)));
  const numericAct = typeof actual === 'number' || (typeof actual === 'string' && actual.trim() !== '' && Number.isFinite(Number(actual)));
  if (numericExp && numericAct) {
    const e = Number(expected);
    const a = Number(actual);
    if (Math.abs(e - a) > EPS * Math.max(1, Math.abs(e))) out.push({ path, expected, actual, message: 'number differs' });
    return out;
  }
  if (typeof expected === 'boolean' && (typeof actual === 'boolean' || actual === 'true' || actual === 'false')) {
    const a = actual === 'true' ? true : actual === 'false' ? false : actual;
    if (a !== expected) out.push({ path, expected, actual, message: 'value differs' });
    return out;
  }
  if (expected !== actual) out.push({ path, expected, actual: actual === undefined ? null : actual, message: actual === undefined ? 'missing' : 'value differs' });
  return out;
}

/** Keys to project for consistency: expected keys + structured (enum/number/boolean) output fields. */
export function signatureFields(test, pb) {
  const fields = new Set();
  const walk = (obj, prefix) => {
    if (!isPlainObject(obj) || isMatcher(obj)) return;
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (isPlainObject(v) && !isMatcher(v)) walk(v, p);
      else fields.add(p);
    }
  };
  walk(test && test.expected, '');
  for (const f of (pb && pb.output && pb.output.fields) || []) {
    const t = String(f.type || '').toLowerCase();
    if (Array.isArray(f.enum) || ['number', 'integer', 'boolean', 'enum'].includes(t)) fields.add(f.name);
  }
  for (const f of (test && test.compare && test.compare.fields) || []) fields.add(f);
  return [...fields].sort();
}

/** Stable signature of a run's structured outcome. */
export function runSignature(run, fields) {
  const projection = { __status: run.status };
  if (run.error && run.error.code) projection.__error = run.error.code;
  for (const f of fields) {
    const v = getPath(run.output, f);
    projection[f] = v === undefined ? null : v;
  }
  return stableStringify(projection);
}

/** Expected run status for a test: completed | failed | needs_input | error (failed or needs_input) | awaiting_approval. */
export function expectedStatus(test) {
  if (test.expected_status) return test.expected_status;
  if (test.expected_error) return 'error';
  return 'completed';
}

/** Judge one execution of a test. */
export function judgeRun(test, run) {
  const mismatches = [];
  const want = expectedStatus(test);
  if (want === 'error') {
    if (!['failed', 'needs_input'].includes(run.status)) mismatches.push({ path: 'status', expected: 'an error (failed or needs_input)', actual: run.status, message: 'expected the run to stop with an error' });
  } else if (run.status !== want) {
    mismatches.push({ path: 'status', expected: want, actual: run.status, message: run.error ? `${run.error.code}: ${run.error.message}` : 'status differs' });
  }
  if (test.expected_error) {
    const code = run.error && run.error.code;
    if (String(code || '').toUpperCase() !== String(test.expected_error).toUpperCase()) {
      mismatches.push({ path: 'error.code', expected: test.expected_error, actual: code || null, message: 'error code differs' });
    }
  }
  if (test.expected !== undefined && test.expected !== null) compareExpected(test.expected, run.output, 'output', mismatches);
  return { matched: mismatches.length === 0, mismatches };
}
