// Tool execution under policy (spec §8, §9, §21, §52): permissions, the
// Production Actions switch, sandbox vs production and human approval.
// Built-in bindings:
//   { type: "input", key }                      data supplied in the run input
//   { type: "builtin", name: "current_datetime" }
//   { type: "http_request", method, url, headers?, body? }   real HTTP call
import { isPlainObject } from '../util.js';

export const BUILTIN_TOOLS = {
  current_datetime: {
    description: 'Current date and time.',
    run: async () => {
      const now = new Date();
      return { iso: now.toISOString(), date: now.toISOString().slice(0, 10), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    },
  },
};

export function classifyTool(tool) {
  const b = tool.binding || {};
  if (b.type === 'input') return { kind: 'input', write: false, external: false };
  if (b.type === 'builtin') return { kind: 'builtin', write: false, external: false };
  if (b.type === 'http_request') {
    const method = String(b.method || 'GET').toUpperCase();
    const write = !['GET', 'HEAD'].includes(method);
    return { kind: 'http', write, external: write || tool.side_effects === 'external', method };
  }
  const write = ['write', 'read-write'].includes(tool.permission) || tool.side_effects === 'external';
  return { kind: 'unbound', write, external: tool.side_effects === 'external' || write };
}

function fill(template, args) {
  return String(template || '').replace(/\{\{\s*(?:args\.)?([A-Za-z0-9_]+)\s*\}\}|\{([A-Za-z0-9_]+)\}/g, (_, a, b) => {
    const v = args[a || b];
    return v === undefined || v === null ? '' : encodeURIComponent(String(v));
  });
}

async function httpCall(binding, args) {
  const method = String(binding.method || 'GET').toUpperCase();
  const url = fill(binding.url, args);
  if (!/^https?:\/\//i.test(url)) throw Object.assign(new Error(`Invalid tool URL: ${url}`), { code: 'TOOL_CONFIG_ERROR' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const headers = { Accept: 'application/json', ...(isPlainObject(binding.headers) ? binding.headers : {}) };
    let body;
    if (!['GET', 'HEAD'].includes(method)) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      body = JSON.stringify(isPlainObject(binding.body) ? { ...binding.body, ...args } : args);
    }
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    const text = (await res.text()).slice(0, 50000);
    let data = text;
    try {
      data = JSON.parse(text);
    } catch { /* keep text */ }
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} from ${url}`), { code: res.status >= 500 ? 'TOOL_ERROR' : 'TOOL_REQUEST_REJECTED', retryable: res.status >= 500 });
    return { status: res.status, data };
  } catch (err) {
    if (err.name === 'AbortError') throw Object.assign(new Error(`Tool request to ${url} timed out.`), { code: 'TIMEOUT', retryable: true });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the tool runner used by the execution engines.
 * ctx: { input, settings, environment: 'sandbox'|'production', approved(key) -> 'approved'|'rejected'|undefined, onEvent }
 */
export function createToolRunner(ctx) {
  const { input = {}, settings, environment = 'sandbox', approved = () => undefined, onEvent = () => {} } = ctx;
  const log = (level, message, data) => onEvent({ ts: new Date().toISOString(), level, message, data });
  return async (tool, args = {}, meta = {}) => {
    const cls = classifyTool(tool);
    const key = meta.call_id ? `call:${meta.call_id}` : meta.step ? `step:${meta.step.id}` : `tool:${tool.id}`;
    if (cls.kind === 'input') {
      const k = tool.binding.key || tool.id;
      const value = input[k];
      if (value === undefined) return { error: `The run input has no "${k}" for tool ${tool.name}.` };
      return { result: value };
    }
    if (cls.kind === 'builtin') {
      const impl = BUILTIN_TOOLS[tool.binding.name];
      if (!impl) return { error: `Unknown built-in tool "${tool.binding.name}".` };
      return { result: await impl.run(args) };
    }
    if (cls.write && tool.permission === 'read-only') {
      log('error', `Blocked: ${tool.name} is read-only but the call would write.`);
      return { error: `Permission denied: ${tool.name} is read-only.` };
    }
    if (cls.external) {
      if (environment !== 'production') {
        log('warn', `Simulated ${tool.name}: sandbox runs never perform external actions.`);
        return { simulated: true, result: null, note: `Sandbox run: ${tool.name} was not executed.` };
      }
      if (!settings.features.production_actions) {
        log('warn', `Simulated ${tool.name}: Production Actions are OFF.`);
        return { simulated: true, result: null, note: `Production Actions are off: ${tool.name} was not executed.` };
      }
      if (settings.features.human_approval) {
        const decision = approved(key);
        if (decision === 'rejected') return { error: `A person rejected the call to ${tool.name}.` };
        if (decision !== 'approved') return { awaiting_approval: true, key, reason: `Approve external action: ${tool.name}`, args };
      }
    }
    if (cls.kind === 'http') {
      log('info', `Calling ${tool.name} (${cls.method} ${tool.binding.url}).`);
      return { result: await httpCall(tool.binding, args) };
    }
    return { error: `Tool ${tool.name} has no binding. Supply its data in the run input or configure a binding.` };
  };
}
