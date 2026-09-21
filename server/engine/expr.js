// Safe expression language for deterministic playbook logic.
// No eval: a small tokenizer + Pratt-style parser + tree-walking evaluator.
//
//   days_since(input.customer.last_activity) >= config.inactivity_threshold_days
//   concat('No activity for ', input.customer.days_since_activity, ' days')
//   if(exists(state.decision), state.decision, 'unknown')

export class ExprError extends Error {
  constructor(message, code = 'EXPRESSION_ERROR') {
    super(message);
    this.code = code;
  }
}

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const s = String(src);
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
      let j = i;
      while (j < s.length && /[0-9._eE]/.test(s[j])) {
        if ((s[j] === 'e' || s[j] === 'E') && /[+-]/.test(s[j + 1] || '')) j++;
        j++;
      }
      const text = s.slice(i, j).replace(/_/g, '');
      const n = Number(text);
      if (!Number.isFinite(n)) throw new ExprError(`Invalid number "${text}"`);
      tokens.push({ t: 'num', v: n });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let out = '';
      while (j < s.length && s[j] !== c) {
        if (s[j] === '\\' && j + 1 < s.length) {
          const n = s[j + 1];
          out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          j += 2;
          continue;
        }
        out += s[j++];
      }
      if (s[j] !== c) throw new ExprError('Unterminated string');
      tokens.push({ t: 'str', v: out });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_$]/.test(s[j])) j++;
      const word = s.slice(i, j);
      tokens.push({ t: 'id', v: word });
      i = j;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (['>=', '<=', '==', '!=', '&&', '||'].includes(two)) {
      tokens.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('+-*/%<>!()[],.?:='.includes(c)) {
      tokens.push({ t: 'op', v: c === '=' ? '==' : c });
      i++;
      continue;
    }
    throw new ExprError(`Unexpected character "${c}"`);
  }
  tokens.push({ t: 'eof' });
  return tokens;
}

const BINARY = {
  '||': 1, or: 1,
  '&&': 2, and: 2,
  '==': 3, '!=': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
};

export function parseExpression(src) {
  const tokens = tokenize(src);
  let p = 0;
  const peek = () => tokens[p];
  const next = () => tokens[p++];
  const isOp = (v) => {
    const t = peek();
    return (t.t === 'op' && t.v === v) || (t.t === 'id' && t.v === v && (v === 'and' || v === 'or' || v === 'not'));
  };
  const expect = (v) => {
    if (!isOp(v)) throw new ExprError(`Expected "${v}"`);
    next();
  };

  function parsePrimary() {
    const t = next();
    if (t.t === 'num') return { k: 'lit', v: t.v };
    if (t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'op' && t.v === '(') {
      const e = parseExpr(0);
      expect(')');
      return e;
    }
    if (t.t === 'op' && t.v === '[') {
      const items = [];
      if (!isOp(']')) {
        do items.push(parseExpr(0));
        while (isOp(',') && next());
      }
      expect(']');
      return { k: 'arr', items };
    }
    if (t.t === 'id') {
      if (t.v === 'true') return { k: 'lit', v: true };
      if (t.v === 'false') return { k: 'lit', v: false };
      if (t.v === 'null') return { k: 'lit', v: null };
      if (isOp('(')) {
        next();
        const args = [];
        if (!isOp(')')) {
          do args.push(parseExpr(0));
          while (isOp(',') && next());
        }
        expect(')');
        return { k: 'call', name: t.v, args };
      }
      return { k: 'var', name: t.v };
    }
    throw new ExprError(t.t === 'eof' ? 'Unexpected end of expression' : `Unexpected token "${t.v}"`);
  }

  function parsePostfix() {
    let node = parsePrimary();
    for (;;) {
      if (isOp('.')) {
        next();
        const t = next();
        if (t.t !== 'id' && t.t !== 'num') throw new ExprError('Expected a property name after "."');
        node = { k: 'get', obj: node, key: { k: 'lit', v: String(t.v) } };
      } else if (isOp('[')) {
        next();
        const key = parseExpr(0);
        expect(']');
        node = { k: 'get', obj: node, key };
      } else break;
    }
    return node;
  }

  function parseUnary() {
    if (isOp('!') || isOp('not')) {
      next();
      return { k: 'not', e: parseUnary() };
    }
    if (isOp('-')) {
      next();
      return { k: 'neg', e: parseUnary() };
    }
    return parsePostfix();
  }

  function parseExpr(minPrec) {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      const op = t.t === 'op' || (t.t === 'id' && (t.v === 'and' || t.v === 'or')) ? t.v : null;
      if (op === '?' && minPrec === 0) {
        next();
        const a = parseExpr(0);
        expect(':');
        const b = parseExpr(0);
        left = { k: 'cond', c: left, a, b };
        continue;
      }
      const prec = op ? BINARY[op] : undefined;
      if (!prec || prec < minPrec) break;
      next();
      const right = parseExpr(prec + 1);
      left = { k: 'bin', op: op === 'and' ? '&&' : op === 'or' ? '||' : op, l: left, r: right };
    }
    return left;
  }

  const ast = parseExpr(0);
  if (peek().t !== 'eof') throw new ExprError(`Unexpected token "${peek().v}"`);
  return ast;
}

// ---------------------------------------------------------------- functions

function toDate(v) {
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

const DAY = 86400000;
const num = (v, fn) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  throw new ExprError(`${fn}() expects a number, got ${v === undefined ? 'nothing' : JSON.stringify(v)}`, 'TYPE_ERROR');
};
const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const pick = (item, field) => (field ? item?.[field] : item);

export const FUNCTIONS = {
  exists: (v) => v !== undefined && v !== null,
  missing: (v) => v === undefined || v === null,
  is_empty: (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length),
  is_number: (v) => typeof v === 'number' && Number.isFinite(v),
  is_integer: (v) => Number.isInteger(v),
  is_string: (v) => typeof v === 'string',
  len: (v) => (typeof v === 'string' || Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0),
  length: (v) => FUNCTIONS.len(v),
  count: (v) => list(v).length,
  lower: (v) => String(v ?? '').toLowerCase(),
  upper: (v) => String(v ?? '').toUpperCase(),
  trim: (v) => String(v ?? '').trim(),
  concat: (...a) => a.map((v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))).join(''),
  join: (arr, sep = ', ') => list(arr).map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(sep),
  coalesce: (...a) => a.find((v) => v !== undefined && v !== null) ?? null,
  if: (c, a, b) => (c ? a : b),
  round: (v, d = 0) => {
    const f = 10 ** num(d, 'round');
    return Math.round(num(v, 'round') * f) / f;
  },
  floor: (v) => Math.floor(num(v, 'floor')),
  ceil: (v) => Math.ceil(num(v, 'ceil')),
  abs: (v) => Math.abs(num(v, 'abs')),
  min: (...a) => Math.min(...(a.length === 1 ? list(a[0]) : a).map((v) => num(v, 'min'))),
  max: (...a) => Math.max(...(a.length === 1 ? list(a[0]) : a).map((v) => num(v, 'max'))),
  sum: (arr, field) => list(arr).reduce((s, it) => s + num(pick(it, field), 'sum'), 0),
  avg: (arr, field) => {
    const l = list(arr);
    return l.length ? FUNCTIONS.sum(l, field) / l.length : null;
  },
  pluck: (arr, field) => list(arr).map((it) => it?.[field]),
  unique: (arr) => [...new Set(list(arr).map((v) => (typeof v === 'object' ? JSON.stringify(v) : v)))],
  contains: (hay, needle) => (Array.isArray(hay) ? hay.includes(needle) : String(hay ?? '').includes(String(needle ?? ''))),
  starts_with: (s, p) => String(s ?? '').startsWith(String(p ?? '')),
  ends_with: (s, p) => String(s ?? '').endsWith(String(p ?? '')),
  to_number: (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  },
  to_string: (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)),
  keys: (v) => (v && typeof v === 'object' ? Object.keys(v) : []),
  parse_date: (v) => {
    const d = toDate(v);
    return d ? d.toISOString() : null;
  },
  date_diff_days: (a, b) => {
    const da = toDate(a);
    const db = toDate(b);
    if (!da || !db) throw new ExprError('date_diff_days() needs two valid dates', 'TYPE_ERROR');
    return Math.floor((da.getTime() - db.getTime()) / DAY);
  },
  add_days: (d, n) => {
    const dd = toDate(d);
    if (!dd) throw new ExprError('add_days() needs a valid date', 'TYPE_ERROR');
    return new Date(dd.getTime() + num(n, 'add_days') * DAY).toISOString();
  },
};

// ---------------------------------------------------------------- evaluation

/**
 * Evaluate an expression string (or parsed AST) against a scope object.
 * Scope roots are plain objects: input, config, state, steps, item, now...
 * Special functions `now()`/`today()`/`days_since()` use scope.__now.
 */
export function evaluate(exprOrAst, scope, { maxSteps = 20000 } = {}) {
  const ast = typeof exprOrAst === 'string' ? parseExpression(exprOrAst) : exprOrAst;
  let steps = 0;
  const now = scope && scope.__now instanceof Date ? scope.__now : new Date();

  const ev = (n) => {
    if (++steps > maxSteps) throw new ExprError('Expression too complex');
    switch (n.k) {
      case 'lit':
        return n.v;
      case 'arr':
        return n.items.map(ev);
      case 'var': {
        if (FORBIDDEN.has(n.name)) throw new ExprError(`"${n.name}" is not allowed`);
        if (n.name === 'now') return now.toISOString();
        if (n.name === 'today') return now.toISOString().slice(0, 10);
        if (scope && Object.prototype.hasOwnProperty.call(scope, n.name)) return scope[n.name];
        if (n.name === 'configuration' && scope && scope.config) return scope.config;
        return undefined;
      }
      case 'get': {
        const obj = ev(n.obj);
        const key = ev(n.key);
        if (obj === undefined || obj === null) return undefined;
        const k = String(key);
        if (FORBIDDEN.has(k)) throw new ExprError(`"${k}" is not allowed`);
        if (typeof obj !== 'object' && typeof obj !== 'string') return undefined;
        if (typeof obj === 'string') return k === 'length' ? obj.length : undefined;
        if (Array.isArray(obj) && k === 'length') return obj.length;
        return Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : undefined;
      }
      case 'call': {
        const args = n.args.map(ev);
        if (n.name === 'now') return now.toISOString();
        if (n.name === 'today') return now.toISOString().slice(0, 10);
        if (n.name === 'days_since') {
          const d = toDate(args[0]);
          if (!d) throw new ExprError('days_since() needs a valid date', 'TYPE_ERROR');
          return Math.floor((now.getTime() - d.getTime()) / DAY);
        }
        const fn = Object.prototype.hasOwnProperty.call(FUNCTIONS, n.name) ? FUNCTIONS[n.name] : null;
        if (!fn) throw new ExprError(`Unknown function "${n.name}"`, 'UNKNOWN_FUNCTION');
        return fn(...args);
      }
      case 'not':
        return !ev(n.e);
      case 'neg':
        return -num(ev(n.e), 'negation');
      case 'cond':
        return ev(n.c) ? ev(n.a) : ev(n.b);
      case 'bin': {
        if (n.op === '&&') return Boolean(ev(n.l)) && Boolean(ev(n.r));
        if (n.op === '||') return Boolean(ev(n.l)) || Boolean(ev(n.r));
        const a = ev(n.l);
        const b = ev(n.r);
        switch (n.op) {
          case '==':
            return looseEqual(a, b);
          case '!=':
            return !looseEqual(a, b);
          case '<':
          case '<=':
          case '>':
          case '>=':
            return compare(a, b, n.op);
          case '+':
            if (typeof a === 'string' || typeof b === 'string') return `${a ?? ''}${b ?? ''}`;
            return num(a, '+') + num(b, '+');
          case '-':
            return num(a, '-') - num(b, '-');
          case '*':
            return num(a, '*') * num(b, '*');
          case '/': {
            const d = num(b, '/');
            if (d === 0) throw new ExprError('Division by zero', 'DIVISION_BY_ZERO');
            return num(a, '/') / d;
          }
          case '%':
            return num(a, '%') % num(b, '%');
          default:
            throw new ExprError(`Unknown operator ${n.op}`);
        }
      }
      default:
        throw new ExprError('Invalid expression');
    }
  };
  return ev(ast);
}

export function looseEqual(a, b) {
  if (a === b) return true;
  if ((a === undefined || a === null) && (b === undefined || b === null)) return true;
  if (typeof a === 'number' && typeof b === 'string' && b.trim() !== '') return a === Number(b);
  if (typeof b === 'number' && typeof a === 'string' && a.trim() !== '') return b === Number(a);
  if (typeof a === 'object' && typeof b === 'object' && a && b) return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/** Ordered comparison; missing values never satisfy a comparison. */
export function compare(a, b, op) {
  if (a === undefined || a === null || b === undefined || b === null) return false;
  let x = a;
  let y = b;
  const numeric = (v) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));
  if (numeric(x) && numeric(y)) {
    x = Number(x);
    y = Number(y);
  } else if (typeof x === 'string' && typeof y === 'string') {
    const dx = /^\d{4}-\d{2}-\d{2}/.test(x) ? toDate(x) : null;
    const dy = /^\d{4}-\d{2}-\d{2}/.test(y) ? toDate(y) : null;
    if (dx && dy) {
      x = dx.getTime();
      y = dy.getTime();
    }
  } else {
    return false;
  }
  switch (op) {
    case '<':
      return x < y;
    case '<=':
      return x <= y;
    case '>':
      return x > y;
    case '>=':
      return x >= y;
    default:
      return false;
  }
}

/** Returns null when the expression parses, or the error message. */
export function checkExpression(src) {
  try {
    parseExpression(src);
    return null;
  } catch (err) {
    return err.message;
  }
}
