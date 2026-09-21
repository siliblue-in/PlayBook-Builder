// Compact JSON Schema (draft-07 subset) validator used for input contracts,
// step output schemas and the final output contract.

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  if (t === 'any') return true;
  return actual === t;
}

const FORMATS = {
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)),
  'date-time': (s) => /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s)),
  email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
  uri: (s) => /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(s),
};

export function validateSchema(value, schema, path = '$', errors = [], depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 40) return errors;
  const push = (message) => errors.push({ path, message });

  if (Array.isArray(schema.allOf)) schema.allOf.forEach((s) => validateSchema(value, s, path, errors, depth + 1));
  const alternatives = schema.anyOf || schema.oneOf;
  if (Array.isArray(alternatives) && alternatives.length) {
    const ok = alternatives.some((s) => validateSchema(value, s, path, [], depth + 1).length === 0);
    if (!ok) push('does not match any allowed shape');
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      push(`expected ${types.join(' or ')}, got ${value === undefined ? 'nothing' : typeOf(value)}`);
      return errors;
    }
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) push(`must equal ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    push(`must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) push(`must be ≥ ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) push(`must be ≤ ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) push(`must be > ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) push(`must be < ${schema.exclusiveMaximum}`);
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) push(schema.minLength === 1 ? 'must not be empty' : `must have at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) push(`must have at most ${schema.maxLength} characters`);
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) push(`must match pattern ${schema.pattern}`);
      } catch { /* ignore invalid patterns */ }
    }
    if (schema.format && FORMATS[schema.format] && !FORMATS[schema.format](value)) push(`must be a valid ${schema.format}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) push(`must have at least ${schema.minItems} item(s)`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) push(`must have at most ${schema.maxItems} item(s)`);
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, i) => validateSchema(item, schema.items, `${path}[${i}]`, errors, depth + 1));
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (value[key] === undefined) errors.push({ path: `${path}.${key}`, message: 'is required' });
    }
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [key, sub] of Object.entries(props)) {
      if (value[key] !== undefined) validateSchema(value[key], sub, `${path}.${key}`, errors, depth + 1);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in props)) errors.push({ path: `${path}.${key}`, message: 'is not an allowed field' });
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const key of Object.keys(value)) {
        if (!(key in props)) validateSchema(value[key], schema.additionalProperties, `${path}.${key}`, errors, depth + 1);
      }
    }
  }
  return errors;
}

export function formatSchemaErrors(errors, limit = 8) {
  const lines = errors.slice(0, limit).map((e) => `${e.path} ${e.message}`);
  if (errors.length > limit) lines.push(`…and ${errors.length - limit} more`);
  return lines;
}

/** Build a JSON schema from a simple field list: [{name, type, required, enum, description}]. */
export function schemaFromFields(fields) {
  const properties = {};
  const required = [];
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f || !f.name) continue;
    const s = {};
    const t = String(f.type || '').toLowerCase();
    const map = { string: 'string', text: 'string', number: 'number', integer: 'integer', int: 'integer', boolean: 'boolean', bool: 'boolean', array: 'array', list: 'array', object: 'object', date: 'string', datetime: 'string', enum: 'string' };
    if (map[t]) s.type = map[t];
    if (t === 'date') s.format = 'date';
    if (Array.isArray(f.enum) && f.enum.length) s.enum = f.enum;
    if (Array.isArray(f.allowed_values) && f.allowed_values.length) s.enum = f.allowed_values;
    if (f.nullable && s.type) s.type = [s.type, 'null'];
    if (f.description) s.description = f.description;
    properties[f.name] = s;
    if (f.required) required.push(f.name);
  }
  return { type: 'object', properties, required };
}
