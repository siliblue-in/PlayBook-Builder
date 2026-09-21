// AI connections (spec §50–51) and role-based model calls. Credentials are
// encrypted at rest and referenced everywhere else by connection_id.
import { PROVIDERS, ProviderError, providerCatalog, isLocalProvider } from './provider.js';
import { extractJson } from './json.js';
import { runCompatHarness } from './compat.js';
import { normalizeTier, tierOf, tierTestCap } from './tiers.js';
import { HttpError } from '../http.js';
import { newId, nowIso, round } from '../util.js';
import { maskSecret } from '../secrets.js';
import { capabilityReport, normalizeBaseUrl, shortServer } from './local.js';

export const ROLES = ['clarification', 'generation', 'execution', 'testing', 'evaluation'];
export const ROLE_LABELS = {
  clarification: 'Clarification Model',
  generation: 'Playbook Generation Model',
  execution: 'Execution Model',
  testing: 'Testing Model',
  evaluation: 'Evaluation Model',
};

const MODELS_TTL_MS = 60 * 60 * 1000;

/**
 * Validate the Ollama context-window override (num_ctx). Null clears it —
 * the server then uses the model's own default. Values are clamped to what
 * Ollama can actually make use of.
 */
function contextWindowSize(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 512 || n > 1048576) {
    throw new HttpError(400, 'bad_request', 'Context window must be a whole number of tokens between 512 and 1,048,576.');
  }
  return n;
}

/**
 * Validate the PC Performance Tier (Low / Mid / High-End). Null clears it —
 * the connection then behaves as "Custom": no test-case cap, hand-set window.
 */
function tierValue(v) {
  if (v === undefined || v === null || v === '') return null;
  const t = normalizeTier(v);
  if (!t) throw new HttpError(400, 'bad_request', 'PC performance tier must be "low", "medium", "high", or empty for Custom.');
  return t;
}

export function emptyUsage() {
  return { calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0 };
}

export function mergeUsage(a, b) {
  const x = a || emptyUsage();
  const y = b || emptyUsage();
  return {
    calls: (x.calls || 0) + (y.calls || (y.total_tokens ? 1 : 0)),
    prompt_tokens: (x.prompt_tokens || 0) + (y.prompt_tokens || 0),
    completion_tokens: (x.completion_tokens || 0) + (y.completion_tokens || 0),
    total_tokens: (x.total_tokens || 0) + (y.total_tokens || 0),
    cost: round((x.cost || 0) + (y.cost || 0), 6),
  };
}

export class AIService {
  constructor({ store, settings, secrets }) {
    this.store = store;
    this.settings = settings;
    this.secrets = secrets;
  }

  catalog() {
    return providerCatalog();
  }

  publicConnection(conn) {
    if (!conn) return null;
    const { api_key_enc, models_cache, ...rest } = conn;
    const local = conn.type === 'local';
    return {
      ...rest,
      type: conn.type || 'cloud',
      is_local: local,
      // Spec v2 §18 calls a working connection "connected"; the stored status
      // stays ok/error/untested so older records keep working.
      state: conn.status === 'ok' ? 'connected' : conn.status === 'error' ? 'error' : 'untested',
      server: local ? shortServer(conn.base_url) : null,
      is_default: this.settings.get().ai.default_connection_id === conn.id,
      provider_label: PROVIDERS.get(conn.provider)?.label || conn.provider,
      models_cached: models_cache ? models_cache.list.length : 0,
      models_fetched_at: models_cache ? models_cache.fetched_at : null,
      allowed: this.isAllowed(conn),
    };
  }

  /** Privacy Mode (spec v2 §14): cloud_allowed | local_preferred | local_only. */
  privacyMode() {
    return this.settings.get().ai.privacy_mode || 'cloud_allowed';
  }

  isAllowed(conn) {
    if (!conn) return false;
    return this.privacyMode() !== 'local_only' || conn.type === 'local';
  }

  assertAllowed(conn) {
    if (this.isAllowed(conn)) return conn;
    throw new HttpError(403, 'local_only', `Privacy Mode is set to Local Only, so "${conn.name}" (${PROVIDERS.get(conn.provider)?.label || conn.provider}) cannot be used. Connect a local model, or change Privacy Mode in Settings.`);
  }

  list() {
    return this.store.connections.list().sort((a, b) => a.created_at.localeCompare(b.created_at)).map((c) => this.publicConnection(c));
  }

  get(id) {
    const conn = this.store.connections.get(id);
    if (!conn) throw new HttpError(404, 'not_found', 'AI connection not found.');
    return conn;
  }

  defaultConnection() {
    const mode = this.privacyMode();
    const all = this.store.connections.list().sort((a, b) => a.created_at.localeCompare(b.created_at));
    const usable = mode === 'local_only' ? all.filter((c) => c.type === 'local') : all;
    const id = this.settings.get().ai.default_connection_id;
    const chosen = id ? usable.find((c) => c.id === id) : null;
    if (mode === 'local_preferred') {
      // Prefer a working local connection over the saved default.
      const localOk = usable.find((c) => c.type === 'local' && c.status === 'ok') || usable.find((c) => c.type === 'local');
      if (localOk && (!chosen || chosen.type !== 'local')) return localOk;
    }
    if (chosen) return chosen;
    return usable.length ? usable[0] : null;
  }

  status() {
    const conn = this.defaultConnection();
    const privacy_mode = this.privacyMode();
    const counts = this.store.connections.list().reduce((acc, c) => ({ ...acc, [c.type === 'local' ? 'local' : 'cloud']: (acc[c.type === 'local' ? 'local' : 'cloud'] || 0) + 1 }), { local: 0, cloud: 0 });
    if (!conn) return { configured: false, connection: null, roles: {}, privacy_mode, local: false, counts };
    const roles = {};
    for (const r of ROLES) roles[r] = (conn.models && (conn.models[r] || conn.default_model)) || null;
    return { configured: true, connection: this.publicConnection(conn), roles, ready: Object.values(roles).every(Boolean), privacy_mode, local: conn.type === 'local', counts };
  }

  create({ provider = 'openrouter', name, api_key, models, base_url, authentication, default_model, context_window, tier } = {}) {
    if (!PROVIDERS.has(provider)) throw new HttpError(400, 'unknown_provider', `Unknown provider "${provider}".`);
    const def = PROVIDERS.get(provider);
    const local = isLocalProvider(provider);
    if (!local && this.privacyMode() === 'local_only') {
      throw new HttpError(403, 'local_only', `Privacy Mode is set to Local Only, so cloud providers cannot be added. Change it in Settings first.`);
    }
    const key = String(api_key || '').trim();
    const authType = local ? ((authentication && authentication.type) || (key ? 'bearer' : 'none')) : 'bearer';
    if (!local && !key && !def.allow_no_key) throw new HttpError(400, 'bad_request', 'An API key is required.');
    if (local && authType === 'bearer' && !key) throw new HttpError(400, 'bad_request', 'This connection is set to Bearer token, so a token is required. Use "None / Local" for a normal local server.');
    // Cloud presets pin their service base URL but it stays editable on the
    // connection (enterprise gateway, proxy, self-hosted vLLM). Presets marked
    // requires_base_url (custom endpoint) have no default and must be given one.
    const cloudBase = local ? null : normalizeBaseUrl(base_url, (def.defaults && def.defaults.base_url) || null);
    if (!local && !cloudBase && def.requires_base_url) {
      throw new HttpError(400, 'base_url_required', `${def.label} needs a service base URL (it usually ends in /v1).`);
    }
    const conn = {
      id: newId(local ? 'conn_local' : 'conn'),
      provider,
      type: local ? 'local' : 'cloud',
      name: String(name || def.label).trim().slice(0, 80),
      base_url: local ? normalizeBaseUrl(base_url, def.defaults.base_url) : cloudBase,
      authentication: { type: authType },
      default_model: local ? String(default_model || '').trim() || null : null,
      // Ollama only: the context window (num_ctx) playbooks should get.
      context_window: local ? contextWindowSize(context_window) : null,
      // PC Performance Tier (Low / Mid / High-End) for local connections: it
      // caps the AI test-suite size and documents the hardware expectations.
      tier: local ? tierValue(tier) : null,
      api_key_enc: key ? this.secrets.encrypt(key) : null,
      api_key_masked: key ? maskSecret(key) : null,
      status: 'untested',
      last_tested_at: null,
      last_error: null,
      last_error_code: null,
      checks: null,
      capabilities: null,
      account: null,
      models: Object.fromEntries(ROLES.map((r) => [r, (models && models[r]) || (local ? default_model || null : null)])),
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.store.connections.put(conn);
    if (!this.settings.get().ai.default_connection_id || !this.store.connections.has(this.settings.get().ai.default_connection_id)) {
      this.settings.update({ ai: { default_connection_id: conn.id } });
    }
    return this.publicConnection(conn);
  }

  update(id, patch = {}) {
    const conn = this.get(id);
    if (patch.name !== undefined) conn.name = String(patch.name).trim().slice(0, 80) || conn.name;
    if (patch.api_key) {
      conn.api_key_enc = this.secrets.encrypt(String(patch.api_key).trim());
      conn.api_key_masked = maskSecret(String(patch.api_key).trim());
      conn.status = 'untested';
      conn.models_cache = undefined;
    }
    if (conn.type === 'local') {
      if (patch.base_url !== undefined) {
        const next = normalizeBaseUrl(patch.base_url, conn.base_url);
        if (next !== conn.base_url) {
          conn.base_url = next;
          conn.status = 'untested';
          conn.models_cache = undefined;
          conn.checks = null;
        }
      }
      if (patch.authentication && patch.authentication.type) conn.authentication = { type: patch.authentication.type === 'bearer' ? 'bearer' : 'none' };
      if (patch.default_model !== undefined) {
        conn.default_model = String(patch.default_model || '').trim() || null;
        if (conn.default_model) for (const r of ROLES) if (!conn.models[r]) conn.models[r] = conn.default_model;
      }
      if (patch.context_window !== undefined) conn.context_window = contextWindowSize(patch.context_window);
      if (patch.tier !== undefined) conn.tier = tierValue(patch.tier);
    }
    if (patch.models && typeof patch.models === 'object') {
      for (const r of ROLES) if (patch.models[r] !== undefined) conn.models[r] = patch.models[r] || null;
    }
    if (patch.is_default) this.settings.update({ ai: { default_connection_id: conn.id } });
    conn.updated_at = nowIso();
    this.store.connections.put(conn);
    return this.publicConnection(conn);
  }

  remove(id) {
    this.get(id);
    this.store.connections.delete(id);
    if (this.settings.get().ai.default_connection_id === id) {
      const next = this.store.connections.list()[0];
      this.settings.update({ ai: { default_connection_id: next ? next.id : null } });
    }
  }

  providerFor(conn) {
    const def = PROVIDERS.get(conn.provider);
    if (!def) throw new HttpError(400, 'unknown_provider', `Provider "${conn.provider}" is not available.`);
    let key = '';
    if (conn.api_key_enc) {
      try {
        key = this.secrets.decrypt(conn.api_key_enc);
      } catch {
        throw new HttpError(500, 'secret_unreadable', 'The stored API key could not be decrypted. Re-enter it in AI Connections.');
      }
    }
    return def.create(conn, key);
  }

  /** Provider for a connection that has not been saved yet (local detection). */
  draftProvider({ provider, base_url, authentication, api_key, context_window }) {
    const def = PROVIDERS.get(provider);
    if (!def) throw new HttpError(400, 'unknown_provider', `Unknown provider "${provider}".`);
    if (!isLocalProvider(provider)) throw new HttpError(400, 'bad_request', 'Only local providers can be probed before they are saved.');
    const draft = {
      id: 'draft',
      provider,
      type: 'local',
      name: def.label,
      base_url: normalizeBaseUrl(base_url, def.defaults.base_url),
      authentication: { type: (authentication && authentication.type) || 'none' },
      context_window: contextWindowSize(context_window),
      models: {},
    };
    return { provider: def.create(draft, String(api_key || '')), draft };
  }

  /** Detect models on a local server (spec v2 §8), saved or not. */
  async detect({ provider, base_url, authentication, api_key, context_window, connection_id } = {}) {
    if (connection_id) {
      const conn = this.get(connection_id);
      const list = await this.models(connection_id, { refresh: true });
      return { server: conn.base_url, provider: conn.provider, models: list, count: list.length };
    }
    const { provider: p, draft } = this.draftProvider({ provider, base_url, authentication, api_key, context_window });
    const list = await p.listModels();
    return { server: draft.base_url, provider: draft.provider, models: list, count: list.length };
  }

  /** Test a local server that has not been saved yet (spec v2 §11). */
  async testDraft({ provider, base_url, authentication, api_key, context_window, model } = {}) {
    const { provider: p, draft } = this.draftProvider({ provider, base_url, authentication, api_key, context_window });
    try {
      const r = await p.testConnection({ model });
      return { ...r, server: draft.base_url, provider: draft.provider };
    } catch (err) {
      return { ok: false, checks: [{ id: 'server', label: 'Server reachable', status: 'fail', detail: err.message }], models: [], error: { code: err.code || 'TEST_FAILED', message: err.message }, server: draft.base_url, provider: draft.provider };
    }
  }

  /** Capability check for an unsaved local connection (spec v2 §10). */
  async capabilitiesDraft({ provider, base_url, authentication, api_key, model, toolsRequired = false } = {}) {
    if (!model) throw new HttpError(400, 'model_not_selected', 'Choose a model first.');
    const { provider: p } = this.draftProvider({ provider, base_url, authentication, api_key });
    const d = await p.describeModel(model, []);
    const capabilities = capabilityReport(d.capabilities, { toolsRequired });
    const missing = capabilities.filter((c) => c.required && c.status === 'fail');
    return { model, context_length: d.context_length, details: d.details || {}, capabilities, missing: missing.map((c) => c.label), ready: missing.length === 0 };
  }

  /** Compatibility harness for an unsaved local connection (impl spec §8). */
  async compatDraft({ provider, base_url, authentication, api_key, context_window, model } = {}) {
    if (!model) throw new HttpError(400, 'model_not_selected', 'Choose a model first.');
    const { provider: p } = this.draftProvider({ provider, base_url, authentication, api_key, context_window });
    return runCompatHarness(p, { model });
  }

  /**
   * Compatibility harness for a saved connection (impl spec §8): "connected"
   * must never be treated as "compatible for playbook generation". The report
   * is stored on the connection so the UI can show the verdict next to it.
   */
  async compat(id, { model, refresh = false } = {}) {
    const conn = this.get(id);
    this.assertAllowed(conn);
    const chosen = model || conn.default_model || (conn.models && (conn.models.generation || conn.models.execution)) || null;
    if (!chosen) throw new HttpError(400, 'model_not_selected', 'Choose a model first.');
    if (!refresh && conn.compat && conn.compat.model === chosen) return conn.compat;
    const report = await runCompatHarness(this.providerFor(conn), { model: chosen });
    conn.compat = { ...report, checked_at: nowIso() };
    conn.updated_at = nowIso();
    this.store.connections.put(conn);
    return report;
  }

  async test(id, { model } = {}) {
    const conn = this.get(id);
    this.assertAllowed(conn);
    try {
      const r = await this.providerFor(conn).testConnection({ model });
      if (r && r.ok === false) {
        conn.status = 'error';
        conn.last_error = (r.error && r.error.message) || 'The connection test failed.';
        conn.last_error_code = (r.error && r.error.code) || 'TEST_FAILED';
        conn.checks = r.checks || null;
      } else {
        conn.status = 'ok';
        conn.account = (r && r.account) || null;
        conn.last_error = null;
        conn.last_error_code = null;
        conn.checks = (r && r.checks) || null;
        // Which endpoint and reasoning mode actually produced the answers —
        // shown in the UI so "Native Ollama Chat" vs the OpenAI-compatible
        // path is never a guess (impl spec §10).
        conn.last_endpoint_mode = (r && r.endpoint_mode) || null;
        conn.last_reasoning_mode = (r && r.reasoning_mode) || null;
        if (r && r.model && conn.type === 'local' && !conn.default_model) conn.default_model = r.model;
        if (r && Array.isArray(r.models) && r.models.length) conn.models_cache = { fetched_at: nowIso(), list: r.models };
      }
    } catch (err) {
      conn.status = 'error';
      conn.last_error = err.message;
      conn.last_error_code = err.code || 'TEST_FAILED';
    }
    conn.last_tested_at = nowIso();
    this.store.connections.put(conn);
    return this.publicConnection(conn);
  }

  async models(id, { refresh = false } = {}) {
    const conn = this.get(id);
    this.assertAllowed(conn);
    const cache = conn.models_cache;
    if (!refresh && cache && Date.now() - Date.parse(cache.fetched_at) < MODELS_TTL_MS) return cache.list;
    const list = await this.providerFor(conn).listModels();
    conn.models_cache = { fetched_at: nowIso(), list };
    this.store.connections.put(conn);
    return list;
  }

  /**
   * Capability check for one model (spec v2 §10). `toolsRequired` comes from the
   * playbook being run, so "cannot support this playbook" is a real answer.
   */
  async capabilities(id, { model, toolsRequired = false, refresh = false } = {}) {
    const conn = this.get(id);
    this.assertAllowed(conn);
    const chosen = model || conn.default_model || (conn.models && (conn.models.generation || conn.models.execution)) || null;
    if (!chosen) throw new HttpError(400, 'model_not_selected', 'Choose a model first.');
    const cached = conn.capabilities && conn.capabilities.model === chosen ? conn.capabilities : null;
    let raw = cached ? cached.raw : null;
    let context_length = cached ? cached.context_length : null;
    let details = cached ? cached.details : {};
    if (!raw || refresh) {
      const p = this.providerFor(conn);
      if (typeof p.describeModel !== 'function') throw new HttpError(400, 'unsupported', 'This provider does not report model capabilities.');
      const list = (conn.models_cache && conn.models_cache.list) || [];
      const d = await p.describeModel(chosen, list);
      raw = d.capabilities;
      context_length = d.context_length;
      details = d.details || {};
      conn.capabilities = { model: chosen, raw, context_length, details, checked_at: nowIso() };
      // Keep the cached model list in step with what we just learned.
      if (conn.models_cache) {
        const entry = conn.models_cache.list.find((m) => m.id === chosen);
        if (entry) {
          entry.context_length = context_length;
          entry.supports = { ...entry.supports, tools: raw.tool_calling, json: raw.json_output !== false };
        }
      }
      this.store.connections.put(conn);
    }
    const capabilities = capabilityReport(raw, { toolsRequired });
    const missing = capabilities.filter((c) => c.required && c.status === 'fail');
    return { model: chosen, context_length, details, capabilities, missing: missing.map((c) => c.label), ready: missing.length === 0 };
  }

  modelInfo(conn, modelId) {
    const list = (conn && conn.models_cache && conn.models_cache.list) || [];
    return list.find((m) => m.id === modelId) || null;
  }

  /** Pick connection + model for a role. Throws a friendly 412 when not configured. */
  resolve(role, { connectionId, model } = {}) {
    const conn = connectionId ? this.store.connections.get(connectionId) || this.defaultConnection() : this.defaultConnection();
    if (!conn) {
      const localOnly = this.privacyMode() === 'local_only';
      throw new HttpError(
        412,
        'ai_not_configured',
        localOnly
          ? 'Privacy Mode is Local Only and no local AI connection is set up. Add a Local AI connection (Ollama) in AI Connections.'
          : 'No AI connection is set up. Add a connection in AI Connections — OpenRouter for cloud models, or Local AI (Ollama) to run models on this computer.',
      );
    }
    this.assertAllowed(conn);
    const chosen = model || (conn.models && (conn.models[role] || conn.default_model || conn.models.generation || conn.models.execution || Object.values(conn.models).find(Boolean)));
    if (!chosen) {
      throw new HttpError(412, 'model_not_selected', `Choose a ${ROLE_LABELS[role] || role} for the "${conn.name}" connection in AI Connections.`);
    }
    return { conn, provider: this.providerFor(conn), model: chosen };
  }

  /**
   * PC Performance Tier cap for AI test suites on the role's connection.
   * Low-tier PCs must not be asked for a 40-test suite — the tier answers
   * "how many test cases it will run". Null = no cap (Custom tier, a cloud
   * connection, or nothing configured).
   */
  tierTestCapFor(role = 'testing') {
    try {
      const { conn } = this.resolve(role);
      if (!conn || conn.type !== 'local') return null;
      return tierTestCap(tierOf(conn));
    } catch {
      return null;
    }
  }

  isAvailable(role) {
    try {
      this.resolve(role);
      return true;
    } catch {
      return false;
    }
  }

  costOf(conn, modelId, usage) {
    if (usage && typeof usage.cost === 'number') return usage.cost;
    const info = this.modelInfo(conn, modelId);
    if (!info || !usage) return 0;
    return (usage.prompt_tokens || 0) * (info.pricing.prompt || 0) + (usage.completion_tokens || 0) * (info.pricing.completion || 0);
  }

  /** Raw chat call with usage + cost accounting. */
  async chat(role, request, { connectionId, model } = {}) {
    const { conn, provider, model: m } = this.resolve(role, { connectionId, model });
    const req = { ...request, model: m };
    // One AI request can legitimately take minutes on a local model. When the
    // caller did not set its own budget, the configurable request timeout
    // applies (Settings → Privacy & AI, default 10 minutes) so Ollama is
    // never cut off by a hardcoded cap while it is still generating.
    if (!req.timeoutMs) {
      const minutes = Number(this.settings.get().ai.request_timeout_minutes);
      if (Number.isFinite(minutes) && minutes > 0) req.timeoutMs = minutes * 60000;
    }
    // Respect what the model supports (from the loaded model list, when available).
    const info = this.modelInfo(conn, m);
    if (info) {
      const cap = info.max_completion_tokens || (info.context_length ? Math.floor(info.context_length / 2) : null);
      // Never raise max_tokens above the model's own cap to reach a floor.
      if (cap && req.max_tokens) req.max_tokens = Math.min(req.max_tokens, cap);
      if (req.json && info.supports && info.supports.json === false) req.json = false;
      if (req.tools && info.supports && info.supports.tools === false) delete req.tools;
    }
    // The connection's own context window (num_ctx) is the hard budget Ollama
    // actually enforces: prompt + completion must fit inside it. Asking a
    // 16k-num_ctx model for 16k completion tokens makes Ollama silently
    // truncate the prompt and/or cut the JSON off mid-object — the classic
    // "generation fails again and again" on local models. Keep at least half
    // of the window for the prompt and the repair turns.
    const ctxBudget = conn.type === 'local' && conn.context_window ? Math.floor(conn.context_window / 2) : null;
    if (ctxBudget && req.max_tokens) req.max_tokens = Math.min(req.max_tokens, ctxBudget);
    const res = await provider.chat(req);
    const cost = this.costOf(conn, m, res.usage);
    return { ...res, model: res.model || m, connection_id: conn.id, usage: { calls: 1, ...res.usage, cost: round(cost, 6) } };
  }

  /**
   * JSON call that enforces the response envelope (spec §63):
   * { response_type, status, data }. Retries with a correction message when
   * the output is not valid JSON, has the wrong type, or fails `validate`.
   */
  async json(role, { system, user, expect, temperature = 0.2, max_tokens = 4000, connectionId, model, maxRepairs = 1, validate, coerce, messages: prior, timeoutMs } = {}) {
    const expected = Array.isArray(expect) ? expect : [expect];
    const messages = prior ? prior.slice() : [
      { role: 'system', content: system },
      { role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user, null, 2) },
    ];
    let usage = emptyUsage();
    let problem = '';
    let lastModel = model;
    let connection_id = null;
    for (let attempt = 0; attempt <= maxRepairs; attempt++) {
      const res = await this.chat(role, { messages, temperature, max_tokens, json: true, timeoutMs }, { connectionId, model });
      usage = mergeUsage(usage, res.usage);
      lastModel = res.model;
      connection_id = res.connection_id;
      if (res.finish_reason === 'length') {
        problem = 'The response was cut off because it reached the maximum length. Return a complete but more concise JSON object.';
      } else {
        const parsed = extractJson(res.content);
        if (!parsed.ok) problem = parsed.error;
        else {
          let env = parsed.value;
          if (coerce) env = coerce(env) || env;
          if (!env || typeof env !== 'object') problem = 'The response must be a JSON object.';
          else if (!expected.includes(env.response_type)) problem = `"response_type" must be ${expected.map((e) => `"${e}"`).join(' or ')} (got ${JSON.stringify(env.response_type ?? null)}).`;
          else if (!env.data || typeof env.data !== 'object') problem = 'The response needs a "data" object.';
          else {
            const v = validate ? validate(env) : null;
            if (v) problem = v;
            else return { envelope: env, usage, model: lastModel, connection_id, content: res.content };
          }
        }
      }
      messages.push({ role: 'assistant', content: String(res.content || '').slice(0, 24000) });
      messages.push({ role: 'user', content: `Your previous reply could not be used: ${problem}\nReturn ONLY the corrected JSON object with the required "response_type", "status" and "data" fields.` });
    }
    const err = new ProviderError('INVALID_AI_RESPONSE', `The ${ROLE_LABELS[role] || role} did not return a usable response: ${problem}`);
    err.usage = usage;
    throw err;
  }
}
