// Small, dependency-free helpers shared across the server.
import crypto from 'node:crypto';

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge `patch` into `base` (arrays are replaced, not merged). Returns a new object. */
export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return deepClone(patch);
  const out = deepClone(base);
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : deepClone(v);
  }
  return out;
}

/** JSON.stringify with sorted object keys, so equal objects hash equally. */
export function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v) => stableStringify(v)).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function slugify(text) {
  return String(text || 'playbook')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'playbook';
}

export function asArray(v) {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

export function asString(v, fallback = '') {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return fallback; }
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run async tasks with limited concurrency. */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  const lanes = [];
  for (let i = 0; i < Math.max(1, Math.min(limit, items.length)); i++) lanes.push(lane());
  await Promise.all(lanes);
  return results;
}

export function round(n, digits = 4) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return n;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function truncate(text, max = 200) {
  const s = asString(text);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Get a value at a dotted/bracket path, e.g. "customer.orders[0].id". */
export function getPath(obj, path) {
  if (path === undefined || path === null || path === '') return obj;
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (p === '__proto__' || p === 'constructor' || p === 'prototype') return undefined;
    if (typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, p)) return undefined;
    cur = cur[p];
  }
  return cur;
}

export function setPath(obj, path, value) {
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (p === '__proto__' || p === 'constructor' || p === 'prototype') return;
    if (!isPlainObject(cur[p]) && !Array.isArray(cur[p])) cur[p] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  if (last === '__proto__' || last === 'constructor' || last === 'prototype') return;
  cur[last] = value;
}

export function deletePath(obj, path) {
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur?.[parts[i]];
    if (cur === null || typeof cur !== 'object') return;
  }
  if (cur && typeof cur === 'object') delete cur[parts[parts.length - 1]];
}
