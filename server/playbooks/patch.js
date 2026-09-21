// RFC 6902 JSON Patch (add, remove, replace, move, copy, test) + a small
// structural diff used for version comparison.
import { deepClone, isPlainObject } from '../util.js';

function parsePointer(pointer) {
  if (pointer === '' || pointer === '/') return [];
  if (!String(pointer).startsWith('/')) throw new Error(`Invalid JSON pointer "${pointer}"`);
  return String(pointer)
    .slice(1)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function locate(doc, tokens) {
  let parent = null;
  let key = null;
  let cur = doc;
  for (const t of tokens) {
    if (t === '__proto__' || t === 'constructor' || t === 'prototype') throw new Error('Forbidden path segment');
    parent = cur;
    key = Array.isArray(cur) ? (t === '-' ? cur.length : Number(t)) : t;
    if (cur === null || typeof cur !== 'object') throw new Error(`Path not found at "${t}"`);
    cur = cur[key];
  }
  return { parent, key, value: cur };
}

export function applyPatch(document, ops) {
  const doc = deepClone(document);
  let root = doc;
  for (const op of Array.isArray(ops) ? ops : []) {
    const tokens = parsePointer(op.path);
    if (!tokens.length) {
      if (op.op === 'replace' || op.op === 'add') root = deepClone(op.value);
      continue;
    }
    const parentTokens = tokens.slice(0, -1);
    const last = tokens[tokens.length - 1];
    const { value: parent } = locate(root, parentTokens);
    if (parent === null || typeof parent !== 'object') throw new Error(`Parent of ${op.path} does not exist`);
    const idx = Array.isArray(parent) ? (last === '-' ? parent.length : Number(last)) : last;
    if (Array.isArray(parent) && (!Number.isInteger(idx) || idx < 0 || idx > parent.length)) throw new Error(`Invalid array index in ${op.path}`);
    switch (op.op) {
      case 'add':
        if (Array.isArray(parent)) parent.splice(idx, 0, deepClone(op.value));
        else parent[idx] = deepClone(op.value);
        break;
      case 'remove':
        if (Array.isArray(parent)) {
          if (idx >= parent.length) throw new Error(`Nothing to remove at ${op.path}`);
          parent.splice(idx, 1);
        } else {
          if (!(idx in parent)) throw new Error(`Nothing to remove at ${op.path}`);
          delete parent[idx];
        }
        break;
      case 'replace':
        if (Array.isArray(parent) ? idx >= parent.length : !(idx in parent)) throw new Error(`Nothing to replace at ${op.path}`);
        parent[idx] = deepClone(op.value);
        break;
      case 'move':
      case 'copy': {
        const from = parsePointer(op.from);
        const src = locate(root, from);
        const value = deepClone(src.value);
        if (op.op === 'move') {
          if (Array.isArray(src.parent)) src.parent.splice(src.key, 1);
          else delete src.parent[src.key];
        }
        if (Array.isArray(parent)) parent.splice(idx, 0, value);
        else parent[idx] = value;
        break;
      }
      case 'test':
        if (JSON.stringify(parent[idx]) !== JSON.stringify(op.value)) throw new Error(`Test failed at ${op.path}`);
        break;
      default:
        throw new Error(`Unsupported patch op "${op.op}"`);
    }
  }
  return root;
}

export function validatePatch(ops) {
  if (!Array.isArray(ops) || !ops.length) return 'Patch must be a non-empty array of operations.';
  for (const op of ops) {
    if (!isPlainObject(op) || !['add', 'remove', 'replace', 'move', 'copy', 'test'].includes(op.op)) return 'Each operation needs a valid "op".';
    if (typeof op.path !== 'string') return 'Each operation needs a "path".';
  }
  return null;
}

/** Structural diff: list of { path, kind: added|removed|changed, before, after } (depth-limited). */
export function diff(a, b, path = '', out = [], depth = 0) {
  if (out.length > 400) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const bothObjects = isPlainObject(a) && isPlainObject(b);
  const bothArrays = Array.isArray(a) && Array.isArray(b);
  if (depth < 6 && bothObjects) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const p = `${path}/${k}`;
      if (!(k in a)) out.push({ path: p, kind: 'added', after: b[k] });
      else if (!(k in b)) out.push({ path: p, kind: 'removed', before: a[k] });
      else diff(a[k], b[k], p, out, depth + 1);
    }
    return out;
  }
  if (depth < 6 && bothArrays) {
    // Match by id when items have ids (steps, rules, requirements...).
    const hasIds = a.concat(b).every((x) => isPlainObject(x) && x.id);
    if (hasIds) {
      const mapA = new Map(a.map((x) => [x.id, x]));
      const mapB = new Map(b.map((x) => [x.id, x]));
      for (const [id, x] of mapA) {
        if (!mapB.has(id)) out.push({ path: `${path}[${id}]`, kind: 'removed', before: x });
        else diff(x, mapB.get(id), `${path}[${id}]`, out, depth + 1);
      }
      for (const [id, x] of mapB) if (!mapA.has(id)) out.push({ path: `${path}[${id}]`, kind: 'added', after: x });
      return out;
    }
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (i >= a.length) out.push({ path: `${path}/${i}`, kind: 'added', after: b[i] });
      else if (i >= b.length) out.push({ path: `${path}/${i}`, kind: 'removed', before: a[i] });
      else diff(a[i], b[i], `${path}/${i}`, out, depth + 1);
    }
    return out;
  }
  out.push({ path: path || '/', kind: 'changed', before: a, after: b });
  return out;
}
