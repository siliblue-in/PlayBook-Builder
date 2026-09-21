// Local AI provider (feature spec v2 §17): one provider class for models that
// run on this computer, with a small adapter per server type. Everything
// Ollama-specific lives in LOCAL_ADAPTERS.ollama — the rest of Playbook Builder
// only ever sees AIProvider.
//
//   LocalAIProvider
//     ├── OllamaAdapter          native /api/tags + /api/show, OpenAI-compatible /v1/chat
//     ├── LMStudioAdapter        OpenAI-compatible
//     ├── LlamaCppAdapter        OpenAI-compatible
//     ├── VLLMAdapter            OpenAI-compatible
//     └── CustomOpenAIAdapter    OpenAI-compatible (any base URL)
import { AIProvider, ProviderError, registerProvider } from './provider.js';
import { pool, sleep } from '../util.js';
import { httpRequest, isTimeoutError } from './transport.js';

export const READY_TOKEN = 'PLAYBOOK_READY';

/** Capabilities every playbook role needs, in display order (spec v2 §10). */
export const CAPABILITY_LABELS = [
  ['text_generation', 'Text Generation', 'The model can produce text at all.'],
  ['json_output', 'JSON Output', 'The model can be asked for a JSON object and return valid JSON.'],
  ['structured_output', 'Structured Output', 'The server can constrain the answer to a schema (Playbook JSON is large and strict).'],
  ['streaming', 'Streaming', 'Partial responses. Nice to have; Playbook Builder does not require it.'],
  ['tool_calling', 'Tool Calling', 'Needed only for playbooks whose steps call tools in AI Execution mode.'],
];

const OPTIONAL_CAPABILITIES = new Set(['streaming', 'tool_calling']);

function withTimeout(ms, external) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', () => controller.abort(external.reason), { once: true });
  }
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/** Join a base URL and a path without doubling an existing /v1 suffix. */
export function joinUrl(base, path) {
  let b = String(base || '').trim().replace(/\/+$/, '');
  let p = String(path || '');
  if (!p.startsWith('/')) p = `/${p}`;
  if (b.endsWith('/v1') && p.startsWith('/v1/')) b = b.slice(0, -3);
  return b + p;
}

/** http://localhost:11434 -> localhost:11434 (for the compact setup box). */
export function shortServer(url) {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return String(url || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
}

export function normalizeBaseUrl(url, fallback) {
  let v = String(url || '').trim();
  if (!v) return fallback;
  if (!/^https?:\/\//i.test(v)) v = `http://${v}`;
  try {
    const u = new URL(v);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------- thinking-model routing
//
// Thinking-capable models (Qwen 3.x "thinking", DeepSeek-R1, …) can spend the
// whole generation budget on hidden reasoning and return an empty visible
// response. Ollama issue #14793: /api/generate ignores think:false when it is
// supplied inside options; the working control is the native /api/chat
// endpoint with think as a TOP-LEVEL request field. The OpenAI-compatible
// /v1/chat/completions exposes the same control as reasoning_effort:"none"
// (Ollama OpenAI compatibility docs, issue #14820). The adapter owns both
// mappings — higher-level services only ever see AIProvider (impl spec §3–§5).

/** Name patterns that mark a model as reasoning/thinking-capable. */
export const THINKING_MODEL_RE = /qwen3|qwq|deepseek-?r1|reasoner|think|gpt-oss|magistral|openthinker|exaone-?deep|phi-4-?reasoning|nemotron-?ultra|glm-?zero/i;

/** thinking flags learned from /api/show, keyed "baseUrl|model". */
const thinkingCache = new Map();
/** Adapters/base URLs that rejected reasoning_effort, learned at runtime. */
const reasoningEffortUnsupported = new Map();

/** Smallest context window (num_ctx) we are willing to send to Ollama. */
export const MIN_CONTEXT_WINDOW = 512;
/** Keep the model loaded between calls so it never cold-loads mid-job. */
export const LOCAL_KEEP_ALIVE = '15m';
/** Fallback budget for one local chat when the caller did not set its own. */
export const LOCAL_CHAT_TIMEOUT_MS = 600000;
/** Budget for one connection-test generation (interactive, but slow on CPU). */
export const LOCAL_TEST_TIMEOUT_MS = 180000;

/** Parse the connection's context-window override; null when not set. */
export function contextWindowOf(connection) {
  const n = Math.floor(Number(connection && connection.context_window));
  return Number.isFinite(n) && n >= MIN_CONTEXT_WINDOW ? n : null;
}

export function isThinkingModel(model, connection) {
  const id = String(model || '');
  const list = connection && connection.models_cache && Array.isArray(connection.models_cache.list) ? connection.models_cache.list : [];
  const entry = list.find((m) => m && m.id === id);
  // A flag measured on this exact server wins over the name heuristic.
  if (entry && typeof entry.thinking === 'boolean') return entry.thinking;
  return THINKING_MODEL_RE.test(id);
}

// ------------------------------------------------ response normalization (§6)
//
// Never read a single field and declare an empty response: every local reply
// goes through normalizeLocalResponse first, which understands the native
// Ollama shapes (message.content / response, message.thinking / thinking) and
// the OpenAI-compatible shapes (choices[0].message.content, reasoning_content).

export function normalizeLocalResponse(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const msg = p.message && typeof p.message === 'object' ? p.message : null;
  const choice = Array.isArray(p.choices) && p.choices[0] ? p.choices[0] : {};
  const cm = choice.message || {};
  let content = msg ? msg.content : cm.content;
  if (content === undefined || content === null) content = p.response; // legacy /api/generate shape
  if (Array.isArray(content)) content = content.map((part) => (typeof part === 'string' ? part : (part && part.text) || '')).join('');
  const thinking = String((msg && (msg.thinking ?? msg.reasoning)) || cm.reasoning_content || cm.reasoning || (typeof p.thinking === 'string' ? p.thinking : '') || '').trim();
  return {
    content: String(content ?? '').trim(),
    thinking,
    finish_reason: p.done_reason || choice.finish_reason || null,
    raw: p,
  };
}

/**
 * The classified EMPTY_RESPONSE failure (impl spec §6/§9). It carries the raw
 * metadata that explains WHY nothing visible came back — most importantly a
 * reasoning budget that was consumed by hidden thinking — and is retryable so
 * the caller repeats the request once before switching endpoints.
 */
export function emptyResponseError(norm, { model, endpointMode } = {}) {
  const thinking = norm.thinking || '';
  const finish = norm.finish_reason || null;
  const how = endpointMode === 'native_ollama_chat' ? '/api/chat with top-level "think": false' : 'the OpenAI-compatible endpoint with reasoning_effort "none"';
  let message;
  if (thinking) {
    message = `${model} produced ${thinking.length} characters of hidden reasoning but no visible content${finish === 'length' ? ' before the output limit was reached' : ''}. Playbook Builder disabled reasoning for this request (${how}), so a full reasoning pass should not consume the answer budget. If this keeps happening: update the server, raise the output limit, or run the Compatibility Test for this model.`;
  } else {
    message = `${model} returned no visible content${finish ? ` (finish reason: ${finish})` : ''}. Make sure the model is fully loaded, then run the Compatibility Test for this model — connected does not always mean compatible.`;
  }
  return new ProviderError('EMPTY_RESPONSE', message, {
    retryable: true,
    details: { endpoint_mode: endpointMode || null, finish_reason: finish, thinking_chars: thinking ? thinking.length : undefined },
  });
}

// --------------------------------------------------------------- adapters

const openAiModels = async (ctx) => {
  const payload = await ctx.request('GET', '/v1/models', null, { timeoutMs: 15000 });
  const list = Array.isArray(payload && payload.data) ? payload.data : Array.isArray(payload && payload.models) ? payload.models : [];
  return list
    .filter((m) => m && (m.id || m.name))
    .map((m) => ({
      id: m.id || m.name,
      name: m.id || m.name,
      context_length: m.context_length || m.max_model_len || null,
      max_completion_tokens: null,
      pricing: { prompt: 0, completion: 0 },
      supports: { json: true, tools: null, seed: true },
      local: true,
    }));
};

const openAiDescribe = async (ctx, model, models) => {
  const info = (models || []).find((m) => m.id === model) || null;
  return {
    context_length: info ? info.context_length : null,
    details: {},
    capabilities: { text_generation: true, json_output: true, structured_output: null, streaming: true, tool_calling: null },
  };
};

/**
 * Ollama: native endpoints for discovery AND native /api/chat for
 * thinking-capable models (top-level think:false — see the routing note above);
 * the OpenAI-compatible /v1/chat/completions stays available as the alternative
 * endpoint with reasoning_effort:"none".
 */
const ollamaAdapter = {
  id: 'ollama',
  label: 'Ollama',
  blurb: 'Run models on this computer. Free, private, no API key.',
  default_base_url: 'http://localhost:11434',
  example_model: 'llama3.2',
  pull_command: 'ollama pull llama3.2',
  install_url: 'https://ollama.com/download',
  docs_url: 'https://ollama.com/library',
  chat_path: '/v1/chat/completions',
  native_chat_path: '/api/chat',
  async listModels(ctx) {
    const payload = await ctx.request('GET', '/api/tags', null, { timeoutMs: 15000 });
    if (!payload || !Array.isArray(payload.models)) {
      throw new ProviderError('NOT_A_LOCAL_SERVER', `Something is listening at ${ctx.baseUrl}, but it did not answer like Ollama. Check the server address.`);
    }
    const base = payload.models
      .filter((m) => m && (m.model || m.name))
      .map((m) => {
        const details = m.details || {};
        return {
          id: m.model || m.name,
          name: m.name || m.model,
          context_length: null,
          max_completion_tokens: null,
          pricing: { prompt: 0, completion: 0 },
          supports: { json: true, tools: null, seed: true },
          local: true,
          size_bytes: m.size || null,
          family: details.family || null,
          parameter_size: details.parameter_size || null,
          quantization: details.quantization_level || null,
          modified_at: m.modified_at || null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    // Ask Ollama what each model can do. Local and fast; failures just leave
    // the capability unknown.
    await pool(base.slice(0, 24), 4, async (m) => {
      try {
        const d = await ollamaAdapter.describeModel(ctx, m.id);
        m.context_length = d.context_length;
        m.supports.tools = d.capabilities.tool_calling;
        m.family = m.family || d.details.family || null;
        m.thinking = d.capabilities.thinking === true || THINKING_MODEL_RE.test(m.id);
      } catch { /* capability stays unknown */ }
    });
    return base;
  },
  async describeModel(ctx, model) {
    const payload = await ctx.request('POST', '/api/show', { model, name: model }, { timeoutMs: 20000 });
    const info = (payload && payload.model_info) || {};
    const ctxKey = Object.keys(info).find((k) => k.endsWith('.context_length'));
    const caps = Array.isArray(payload && payload.capabilities) ? payload.capabilities : null;
    const template = String((payload && payload.template) || '');
    const hasTools = caps ? caps.includes('tools') : /\.Tools|ToolCalls/i.test(template) ? true : null;
    const generates = caps ? caps.includes('completion') : true;
    // Recent Ollama versions report a "thinking" capability for reasoning
    // models (Qwen 3.x thinking, DeepSeek-R1, …). Remember it per server+model
    // so chat() can route them through the native endpoint even before any
    // model list has been cached on the connection.
    const thinking = caps ? caps.includes('thinking') : null;
    if (thinking !== null) thinkingCache.set(`${ctx.baseUrl}|${model}`, thinking);
    return {
      context_length: ctxKey ? Number(info[ctxKey]) || null : null,
      details: (payload && payload.details) || {},
      capabilities: {
        text_generation: generates,
        json_output: true,
        structured_output: true,
        streaming: true,
        tool_calling: hasTools,
        thinking,
      },
    };
  },
};

const openAiCompatible = (id, label, blurb, baseUrl, extras = {}) => ({
  id,
  label,
  blurb,
  default_base_url: baseUrl,
  chat_path: '/v1/chat/completions',
  listModels: openAiModels,
  describeModel: openAiDescribe,
  ...extras,
});

export const LOCAL_ADAPTERS = {
  ollama: ollamaAdapter,
  lmstudio: openAiCompatible('lmstudio', 'LM Studio', 'Desktop app with a built-in model browser. Start its local server first.', 'http://localhost:1234', {
    install_url: 'https://lmstudio.ai',
    example_model: 'a model loaded in LM Studio',
    setup_hint: 'In LM Studio open Developer → Start Server, then detect models here.',
  }),
  llamacpp: openAiCompatible('llamacpp', 'llama.cpp', 'The llama.cpp server (llama-server) speaks the OpenAI API.', 'http://localhost:8080', {
    install_url: 'https://github.com/ggml-org/llama.cpp',
    setup_hint: 'Start it with llama-server -m <model.gguf> --port 8080.',
  }),
  vllm: openAiCompatible('vllm', 'vLLM', 'High-throughput server for a workstation or a machine on your network.', 'http://localhost:8000', {
    install_url: 'https://docs.vllm.ai',
    setup_hint: 'Start it with vllm serve <model>.',
  }),
  custom: openAiCompatible('custom', 'Custom (OpenAI-compatible)', 'Any other server that implements /v1/chat/completions.', 'http://localhost:8000', {
    setup_hint: 'Point this at any OpenAI-compatible server, on this computer or your network.',
  }),
};

// --------------------------------------------------------------- provider

export class LocalAIProvider extends AIProvider {
  constructor(connection, apiKey, adapter) {
    super(connection, apiKey);
    this.adapter = adapter;
    this.baseUrl = normalizeBaseUrl(connection && connection.base_url, adapter.default_base_url);
  }

  get label() {
    return this.adapter.label;
  }

  headers() {
    const h = { 'Content-Type': 'application/json' };
    const auth = (this.connection && this.connection.authentication) || { type: 'none' };
    if (auth.type === 'bearer' && this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  classify(status, body, path) {
    const message = (body && body.error && (body.error.message || body.error)) || (typeof body === 'string' && body) || `HTTP ${status}`;
    const text = String(message).slice(0, 400);
    if (status === 404 && /model|not found|pull/i.test(text)) {
      return new ProviderError('MODEL_NOT_FOUND', `${this.label} does not have that model installed (${text}).`, { status });
    }
    if (status === 404) return new ProviderError('NOT_A_LOCAL_SERVER', `${this.baseUrl}${path} was not found. Check that the server address points at ${this.label}.`, { status });
    if (status === 401 || status === 403) return new ProviderError('AUTH_ERROR', `${this.label} refused the request (${text}). If your server needs a token, set Authentication to Bearer token.`, { status });
    if (status === 408 || status === 504) return new ProviderError('TIMEOUT', `${this.label} timed out (${text}).`, { status, retryable: true });
    if (status === 413) return new ProviderError('CONTEXT_TOO_SMALL', `The request was too large for this model's context window (${text}).`, { status });
    if (status === 429) return new ProviderError('RATE_LIMITED', `${this.label} is busy (${text}).`, { status, retryable: true });
    if (status >= 500) return new ProviderError('TEMPORARY_PROVIDER_ERROR', `${this.label} returned an error (${text}).`, { status, retryable: true });
    return new ProviderError('BAD_REQUEST', `${this.label} rejected the request: ${text}`, { status, details: body && body.error });
  }

  async request(method, path, body, { timeoutMs = 60000, signal } = {}) {
    const url = joinUrl(this.baseUrl, path);
    const t = withTimeout(timeoutMs, signal);
    let res;
    try {
      // node:http transport — NOT fetch. Node's fetch (undici) aborts any call
      // whose response headers take longer than a fixed, non-configurable 5
      // minutes (UND_ERR_HEADERS_TIMEOUT), so a big prompt eval on a slow PC
      // looked like "Could not reach Ollama" while Ollama was running. The
      // only budget now is the caller's explicit timeoutMs (Settings → AI
      // request timeout), which can be raised up to two hours.
      res = await httpRequest(url, { method, headers: this.headers(), body: body ? JSON.stringify(body) : undefined, timeoutMs, signal: t.signal });
    } catch (err) {
      t.done();
      const code = (err && err.code) || (err && err.cause && err.cause.code) || '';
      const slow = isTimeoutError(err) || t.signal.aborted || err.name === 'AbortError' || /timeout/i.test(String(err && err.message));
      if (slow) {
        throw new ProviderError(
          'TIMEOUT',
          `${this.label} is running, but the model did not finish within ${Math.round(timeoutMs / 1000)}s. That usually means the model was still loading, the prompt is large for this PC, or the machine is too slow for the current context window. Raise Settings → "AI request timeout", pick a lower PC Performance Tier on this connection (smaller context, fewer test cases), or use a smaller model.`,
          { retryable: true },
        );
      }
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
        throw new ProviderError('SERVER_UNREACHABLE', `Nothing is answering at ${this.baseUrl}. Start ${this.label} and try again.`, { retryable: true });
      }
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        throw new ProviderError('SERVER_UNREACHABLE', `The server address ${this.baseUrl} could not be resolved.`);
      }
      throw new ProviderError('SERVER_UNREACHABLE', `Could not reach ${this.label} at ${this.baseUrl}. Start ${this.label} and check the server address. (${code || (err && err.message) || 'connection failed'})`, { retryable: true });
    }
    const text = res.text;
    t.done();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = text;
    }
    if (!res.ok) throw this.classify(res.status, payload, path);
    if (payload && payload.error && !payload.choices) throw this.classify(400, payload, path);
    return payload;
  }

  async listModels() {
    return this.adapter.listModels(this);
  }

  /** Capability report for one model (spec v2 §10). */
  async describeModel(model, models) {
    return this.adapter.describeModel(this, model, models);
  }

  /**
   * Connection test (spec v2 §11): server reachable → model available →
   * model responds → required output format works. Never throws: the caller
   * gets the individual checks so the UI can explain what to fix.
   */
  async testConnection({ model, quick = false } = {}) {
    const started = Date.now();
    const checks = [];
    const add = (id, label, status, detail) => checks.push({ id, label, status, detail });
    let models = [];
    try {
      models = await this.listModels();
    } catch (err) {
      add('server', 'Server reachable', 'fail', err.message);
      return { ok: false, checks, models: [], error: { code: err.code, message: err.message }, server: this.baseUrl };
    }
    add('server', 'Server reachable', 'ok', `${this.label} answered at ${this.baseUrl}.`);
    if (!models.length) {
      add('models', 'Models installed', 'fail', `${this.label} is running but has no models installed.`);
      return {
        ok: false,
        checks,
        models,
        error: { code: 'NO_MODELS', message: `${this.label} is connected, but no models were found. Install one${this.adapter.pull_command ? ` with "${this.adapter.pull_command}"` : ''}, then detect models again.` },
        server: this.baseUrl,
      };
    }
    add('models', 'Models installed', 'ok', `${models.length} model${models.length === 1 ? '' : 's'} available.`);

    const wanted = model || (this.connection && (this.connection.default_model || (this.connection.models && this.connection.models.generation)));
    const found = wanted ? models.find((m) => m.id === wanted || m.id.replace(/:latest$/, '') === String(wanted).replace(/:latest$/, '')) : null;
    if (!wanted) {
      add('model', 'Model selected', 'warn', 'No model chosen yet — pick one below.');
      return { ok: false, checks, models, error: { code: 'MODEL_NOT_SELECTED', message: 'Select a model, then test the connection.' }, server: this.baseUrl };
    }
    if (!found) {
      add('model', 'Model available', 'fail', `"${wanted}" is not installed on this server.`);
      return { ok: false, checks, models, error: { code: 'MODEL_NOT_FOUND', message: `"${wanted}" is not installed. Install it${this.adapter.pull_command ? ` (ollama pull ${wanted})` : ''} or choose another model.` }, server: this.baseUrl };
    }
    add('model', 'Model available', 'ok', `${found.name}${found.parameter_size ? ` · ${found.parameter_size}` : ''}${found.quantization ? ` · ${found.quantization}` : ''}.`);
    if (quick) return { ok: true, checks, models, model: found.id, latency_ms: Date.now() - started, server: this.baseUrl, account: { server: this.baseUrl, models: models.length, model: found.id } };

    // The model actually generates.
    const t0 = Date.now();
    let reply;
    try {
      reply = await this.chat({
        model: found.id,
        messages: [
          { role: 'system', content: 'You follow instructions exactly. Reply with the requested text and nothing else.' },
          { role: 'user', content: `Return exactly:\n${READY_TOKEN}` },
        ],
        temperature: 0,
        max_tokens: 32,
        timeoutMs: LOCAL_TEST_TIMEOUT_MS,
        retries: 0,
      });
    } catch (err) {
      add('generation', 'Model responds', 'fail', err.message);
      return { ok: false, checks, models, model: found.id, error: { code: err.code, message: err.message }, server: this.baseUrl };
    }
    const latency = Date.now() - t0;
    const said = String(reply.content || '').trim();
    if (!said) {
      // Defensive: chat() classifies empty replies itself, so this only fires
      // for a provider that returns empty without an error. Never diagnose it
      // as just "try another model" — show what actually happened.
      add('generation', 'Model responds', 'fail', `${found.name} returned no visible content. Run the Compatibility Test for per-check results — connected does not always mean compatible.`);
      return { ok: false, checks, models, model: found.id, error: { code: 'EMPTY_RESPONSE', message: `${found.name} returned no visible content. Run the Compatibility Test for this model — connected does not always mean compatible.` }, server: this.baseUrl };
    }
    const exact = said.toUpperCase().includes(READY_TOKEN);
    add('generation', 'Model responds', exact ? 'ok' : 'warn', exact ? `Answered "${READY_TOKEN}" in ${latency} ms.` : `Answered in ${latency} ms, but not with the exact text asked for: "${said.slice(0, 80)}". A model that drifts from instructions will need more repeatability testing.`);

    // The model can return the JSON that playbooks are built from.
    let jsonOk = false;
    let jsonDetail = '';
    try {
      const j = await this.chat({
        model: found.id,
        messages: [
          { role: 'system', content: 'You reply with a single JSON object and nothing else.' },
          { role: 'user', content: 'Return this JSON object exactly: {"ready": true, "token": "PLAYBOOK_READY"}' },
        ],
        temperature: 0,
        max_tokens: 120,
        json: true,
        timeoutMs: LOCAL_TEST_TIMEOUT_MS,
        retries: 0,
      });
      const text = String(j.content || '');
      const match = text.match(/\{[\s\S]*\}/);
      const parsed = match ? JSON.parse(match[0]) : null;
      jsonOk = Boolean(parsed && parsed.ready === true);
      jsonDetail = jsonOk ? 'Returned a valid JSON object.' : `Returned ${text.slice(0, 80) || 'nothing'}`;
    } catch (err) {
      jsonDetail = err.message;
    }
    add('json', 'Required output format works', jsonOk ? 'ok' : 'warn', jsonOk ? jsonDetail : `JSON output could not be confirmed: ${jsonDetail}. Playbook generation needs strict JSON — try a larger or instruct-tuned model if generation fails.`);

    return {
      ok: true,
      checks,
      models,
      model: found.id,
      latency_ms: latency,
      server: this.baseUrl,
      endpoint_mode: reply.endpoint_mode || null,
      reasoning_mode: reply.reasoning_mode || null,
      account: { server: this.baseUrl, models: models.length, model: found.id, latency_ms: latency, label: `${this.label} · ${shortServer(this.baseUrl)}` },
    };
  }

  /**
   * Endpoint router (impl spec §4/§5/§9).
   *
   * Thinking-capable models go to the adapter's native chat endpoint first
   * (Ollama /api/chat with TOP-LEVEL think:false — the only control that
   * reliably stops reasoning from consuming the answer budget, Ollama issue
   * #14793). A connection-level context window also pins the native endpoint
   * first: options.num_ctx is only honoured there. Requests that carry tools
   * stay on the OpenAI-compatible endpoint, where tool-calling is exercised.
   * The alternative endpoint is tried when the first one fails with an
   * ENDPOINT_CAPABILITY_MISMATCH or a classified EMPTY_RESPONSE (spec §9
   * "Retry 2") — never on timeouts or model errors.
   */
  async chat(request) {
    const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
    const nativeAvailable = Boolean(this.adapter.native_chat_path) && !hasTools;
    const thinking = isThinkingModel(request.model, this.connection) || (this.adapter.native_chat_path && [...thinkingCache.entries()].some(([k, v]) => v && k.endsWith(`|${request.model}`)));
    const nativePreferred = thinking || Boolean(nativeAvailable && contextWindowOf(this.connection));
    const order = [];
    if (nativeAvailable && nativePreferred) order.push('native');
    order.push('openai');
    if (nativeAvailable && !nativePreferred) order.push('native');
    let lastErr = null;
    for (const mode of order) {
      try {
        return mode === 'native' ? await this.nativeChat(request) : await this.openAiChat(request);
      } catch (err) {
        lastErr = err;
        const switchable = err.code === 'ENDPOINT_CAPABILITY_MISMATCH' || err.code === 'EMPTY_RESPONSE';
        if (!switchable || mode === order[order.length - 1]) throw err;
      }
    }
    throw lastErr;
  }

  /**
   * Native Ollama /api/chat (impl spec §4). think:false is a TOP-LEVEL field
   * here; putting it inside options is the documented-ineffective shape. JSON
   * mode is deliberately NOT sent as a format constraint: for the qwen3.5
   * series, disabling thinking interacts badly with structured output (issue
   * #14645), so the prompt plus the robust JSON extraction stay in charge.
   *
   * When the connection sets a context window it rides along as
   * options.num_ctx — the only endpoint that honours it. Ollama otherwise
   * defaults to a small window (2048–4096 tokens) and silently truncates
   * long prompts, which reads back as a broken playbook for no visible
   * reason. keep_alive keeps the model resident between calls so the many
   * requests of compile → test → run never pay a cold load.
   */
  async nativeChat(request) {
    const numCtx = contextWindowOf(this.connection);
    const buildBody = (withThink) => {
      const body = { model: request.model, messages: request.messages, stream: false, keep_alive: LOCAL_KEEP_ALIVE };
      if (withThink) body.think = false; // top-level native Ollama field (spec §4)
      const options = {};
      if (numCtx) options.num_ctx = numCtx;
      if (typeof request.temperature === 'number') options.temperature = request.temperature;
      if (request.max_tokens) options.num_predict = request.max_tokens;
      if (Number.isInteger(request.seed)) options.seed = request.seed;
      if (Object.keys(options).length) body.options = options;
      return body;
    };
    let allowThink = true;
    const attempts = request.retries ?? 1;
    for (let attempt = 0; ; attempt++) {
      try {
        const payload = await this.request('POST', this.adapter.native_chat_path, buildBody(allowThink), { timeoutMs: request.timeoutMs || LOCAL_CHAT_TIMEOUT_MS, signal: request.signal });
        const norm = normalizeLocalResponse(payload);
        // /api/chat can answer with tool_calls and no content; that is a valid
        // reply, not an empty one.
        const nativeToolCalls = payload && payload.message && Array.isArray(payload.message.tool_calls) ? payload.message.tool_calls : [];
        if (!norm.content && !nativeToolCalls.length) throw emptyResponseError(norm, { model: request.model, endpointMode: 'native_ollama_chat' });
        const usage = (payload && payload.usage) || {};
        const promptTokens = usage.prompt_tokens ?? usage.prompt_eval_count ?? 0;
        const completionTokens = usage.completion_tokens ?? usage.eval_count ?? 0;
        return {
          content: norm.content,
          thinking: norm.thinking || undefined,
          tool_calls: nativeToolCalls,
          finish_reason: norm.finish_reason || null,
          endpoint_mode: 'native_ollama_chat',
          reasoning_mode: allowThink ? 'off' : null,
          model: payload.model || request.model,
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: usage.total_tokens ?? promptTokens + completionTokens,
            cost: 0,
          },
        };
      } catch (err) {
        // An old server that rejects the think field still gets one try without
        // it before this endpoint is declared incompatible.
        if (allowThink && err.code === 'BAD_REQUEST') {
          allowThink = false;
          continue;
        }
        if (err.code === 'NOT_A_LOCAL_SERVER') {
          // 404 on /api/chat itself: the endpoint does not exist on this build.
          throw new ProviderError('ENDPOINT_CAPABILITY_MISMATCH', `${this.label} at ${this.baseUrl} does not expose the native chat endpoint; the OpenAI-compatible endpoint will be used.`, { status: err.status });
        }
        if (err.retryable && attempt < attempts) {
          await sleep(800 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * OpenAI-format chat (impl spec §5): /v1/chat/completions with
   * reasoning_effort:"none" for thinking-capable models — the documented
   * reasoning control on Ollama's compatible endpoint (issue #14820). Servers
   * that do not know the field are learned at runtime and retried without it.
   */
  async openAiChat(request) {
    const body = { model: request.model, messages: request.messages, stream: false };
    if (typeof request.temperature === 'number') body.temperature = request.temperature;
    if (request.max_tokens) body.max_tokens = request.max_tokens;
    if (Number.isInteger(request.seed)) body.seed = request.seed;
    // A context-window override is only guaranteed on the native endpoint; when
    // this path is the first try anyway (tool requests, non-Ollama adapters),
    // pass it through Ollama's options field as well. Servers that do not know
    // the field either ignore it or reject it — the rejection is learned and
    // retried without it, exactly like reasoning_effort above.
    const ollamaNumCtx = this.adapter.id === 'ollama' ? contextWindowOf(this.connection) : null;
    if (Array.isArray(request.tools) && request.tools.length) {
      body.tools = request.tools;
      body.tool_choice = request.tool_choice || 'auto';
    }
    const reasonKey = `${this.adapter.id}|${this.baseUrl}`;
    let sendReasoningNone = isThinkingModel(request.model, this.connection) && !reasoningEffortUnsupported.get(reasonKey);
    let sendOptions = Boolean(ollamaNumCtx);
    let useJson = Boolean(request.json);
    const attempts = request.retries ?? 1;
    for (let attempt = 0; ; attempt++) {
      if (useJson) body.response_format = { type: 'json_object' };
      else delete body.response_format;
      if (sendReasoningNone) body.reasoning_effort = 'none';
      else delete body.reasoning_effort;
      if (sendOptions) body.options = { num_ctx: ollamaNumCtx };
      else delete body.options;
      try {
        const payload = await this.request('POST', this.adapter.chat_path, body, { timeoutMs: request.timeoutMs || LOCAL_CHAT_TIMEOUT_MS, signal: request.signal });
        const norm = normalizeLocalResponse(payload);
        const choice = (payload.choices && payload.choices[0]) || {};
        const toolCalls = Array.isArray(choice.message && choice.message.tool_calls) ? choice.message.tool_calls : [];
        // A tool-call reply has no visible content by design — that is not an
        // empty response. Only a truly content-less, tool-less reply is one.
        if (!norm.content && !toolCalls.length) throw emptyResponseError(norm, { model: request.model, endpointMode: 'openai_compatible' });
        const usage = payload.usage || {};
        return {
          content: norm.content,
          thinking: norm.thinking || undefined,
          tool_calls: toolCalls,
          finish_reason: norm.finish_reason || choice.finish_reason || null,
          endpoint_mode: 'openai_compatible',
          reasoning_mode: sendReasoningNone ? 'off' : null,
          model: payload.model || request.model,
          usage: {
            prompt_tokens: usage.prompt_tokens || 0,
            completion_tokens: usage.completion_tokens || 0,
            total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
            cost: 0,
          },
        };
      } catch (err) {
        // A server that rejects the options field gets the plain request instead.
        if (sendOptions && err.code === 'BAD_REQUEST' && /options|num_ctx|context/i.test(err.message)) {
          sendOptions = false;
          continue;
        }
        // A server that rejects reasoning_effort gets the plain request instead.
        if (sendReasoningNone && err.code === 'BAD_REQUEST' && /reasoning/i.test(err.message)) {
          sendReasoningNone = false;
          reasoningEffortUnsupported.set(reasonKey, true);
          continue;
        }
        if (useJson && (err.code === 'BAD_REQUEST' || err.code === 'TEMPORARY_PROVIDER_ERROR') && /response_format|json|format/i.test(err.message)) {
          useJson = false;
          continue;
        }
        if (err.retryable && attempt < attempts) {
          await sleep(800 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
  }
}

// --------------------------------------------------------------- registry

/** The 7 short steps shown in the compact setup box (spec v2 §3). */
function setupFor(adapter) {
  const server = shortServer(adapter.default_base_url);
  if (adapter.id === 'ollama') {
    return {
      title: 'Set up Ollama locally',
      mark: '🦙',
      server,
      steps: ['Install Ollama', 'Start Ollama', 'Install a model', 'Return here', 'Click Detect Models', 'Select your model', 'Test Connection'],
      command: adapter.pull_command,
      command_label: 'Model installation',
      command_step: 3,
      install_url: adapter.install_url,
      open_url: adapter.default_base_url,
      detailed: [
        { title: 'Step 1 — Install Ollama', body: 'Download Ollama for your operating system and run the installer.', link: adapter.install_url, link_label: 'ollama.com/download' },
        { title: 'Step 2 — Start Ollama', body: 'Open the Ollama application. On Windows and macOS it keeps running in the menu bar or system tray; on Linux run "ollama serve".' },
        { title: 'Step 3 — Install a model', body: 'In a terminal, pull a model. llama3.2 (3B) is a good first model on a laptop; larger models give better playbooks.', command: adapter.pull_command },
        { title: 'Step 4 — Return to Playbook Builder', body: 'Settings → AI Connections → Add Connection → Local AI → Ollama.' },
        { title: 'Step 5 — Enter the server address', body: 'Ollama listens on http://localhost:11434 unless you changed OLLAMA_HOST.' },
        { title: 'Step 6 — Detect models', body: 'Click Detect Models. Everything you have pulled appears in the list.' },
        { title: 'Step 7 — Select a model', body: 'Choose the model to use. You can give each role its own model afterwards.' },
        { title: 'Step 8 — Test the connection', body: `Click Test Connection. Playbook Builder checks the server, the model, a real generation (it asks for "${READY_TOKEN}") and JSON output.` },
        { title: 'Step 9 — Save and use local AI', body: 'Save the connection. Intent discovery, playbook generation, testing, evaluation and AI execution now run on this computer.' },
      ],
    };
  }
  return {
    title: `Set up ${adapter.label} locally`,
    mark: '💻',
    server,
    steps: [`Install ${adapter.label}`, `Start the ${adapter.label} server`, 'Load a model', 'Return here', 'Click Detect Models', 'Select your model', 'Test Connection'],
    command: adapter.pull_command || null,
    command_label: null,
    install_url: adapter.install_url || null,
    open_url: adapter.default_base_url,
    hint: adapter.setup_hint || '',
    detailed: [
      { title: `Step 1 — Install ${adapter.label}`, body: adapter.setup_hint || `Install ${adapter.label} and start its OpenAI-compatible server.`, link: adapter.install_url || null },
      { title: 'Step 2 — Enter the server address', body: `The default is ${adapter.default_base_url}. Any OpenAI-compatible endpoint works.` },
      { title: 'Step 3 — Detect models', body: 'Click Detect Models to read /v1/models from the server.' },
      { title: 'Step 4 — Test the connection', body: `Playbook Builder asks the model for "${READY_TOKEN}" and for a small JSON object.` },
    ],
  };
}

for (const adapter of Object.values(LOCAL_ADAPTERS)) {
  registerProvider(adapter.id, {
    label: adapter.label,
    description: adapter.blurb,
    type: 'local',
    docs_url: adapter.docs_url || adapter.install_url || '',
    defaults: { base_url: adapter.default_base_url, authentication: 'none', example_model: adapter.example_model || null },
    setup: setupFor(adapter),
    create: (connection, apiKey) => new LocalAIProvider(connection, apiKey, adapter),
  });
}

/** Turn a raw capability map into the labelled list the UI shows. */
export function capabilityReport(caps, { toolsRequired = false } = {}) {
  return CAPABILITY_LABELS.map(([id, label, help]) => {
    const v = caps ? caps[id] : null;
    const required = id === 'tool_calling' ? toolsRequired : !OPTIONAL_CAPABILITIES.has(id);
    const status = v === true ? 'ok' : v === false ? (required ? 'fail' : 'warn') : 'unknown';
    return { id, label, help, required, status, supported: v === true ? true : v === false ? false : null };
  });
}
