// Anthropic (Claude) through the NATIVE Messages API — not the OpenAI
// compatibility layer. The dialects differ in the parts that matter:
//
//   auth          x-api-key header + anthropic-version (no Bearer token)
//   system        top-level "system" field, NOT a system message
//   max_tokens    required on every call (OpenAI makes it optional)
//   reply         content blocks [{type:'text'|'thinking'|'tool_use'}], not choices
//   tool calls    tool_use blocks carrying a structured `input`, not a JSON string
//   tools         {name, description, input_schema}, not {function:{...}}
//
// Everything else in Playbook Builder only ever sees the AIProvider shape
// (provider.js), so the mapping lives here and nowhere else.
//
//   GET  {base}/models     model catalog + key check (List Models API)
//   POST {base}/messages   chat / tools / JSON-by-prompt
import { AIProvider, ProviderError, registerProvider } from './provider.js';
import { sleep } from '../util.js';
import { httpRequest, isTimeoutError } from './transport.js';

export const ANTHROPIC_PRESET = {
  id: 'anthropic',
  label: 'Anthropic',
  base_url: 'https://api.anthropic.com/v1',
  api_version: '2023-06-01',
  // The public catalog does not report a context size per model; every Claude 3
  // and 4 family model runs with a 200k window.
  context_length: 200000,
};

function withTimeout(ms, external) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', () => controller.abort(external.reason), { once: true });
  }
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

const FINISH_REASONS = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
};

/** Anthropic needs a token budget on every call; callers may omit it. */
const DEFAULT_MAX_TOKENS = 4096;

export class AnthropicProvider extends AIProvider {
  constructor(connection, apiKey) {
    super(connection, apiKey);
    // A connection may pin its own base URL (corporate gateway / proxy).
    this.base = String((connection && connection.base_url) || ANTHROPIC_PRESET.base_url).replace(/\/+$/, '');
  }

  get label() {
    return 'Anthropic';
  }

  headers() {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey || '',
      'anthropic-version': ANTHROPIC_PRESET.api_version,
    };
  }

  async request(method, path, body, { timeoutMs = 60000, signal } = {}) {
    const t = withTimeout(timeoutMs, signal);
    let res;
    try {
      // node:http transport (no undici timeouts — see server/ai/transport.js).
      res = await httpRequest(`${this.base}${path}`, { method, headers: this.headers(), body: body ? JSON.stringify(body) : undefined, timeoutMs, signal: t.signal });
    } catch (err) {
      t.done();
      if (isTimeoutError(err) || t.signal.aborted || err.name === 'AbortError' || /timeout/i.test(String(err.message)) || /timeout/i.test(String(err.cause))) {
        throw new ProviderError('TIMEOUT', `Anthropic did not respond within ${Math.round(timeoutMs / 1000)}s.`, { retryable: true });
      }
      throw new ProviderError('NETWORK_ERROR', `Could not reach Anthropic: ${err.cause ? err.cause.code || err.cause.message : err.message}`, { retryable: true });
    }
    let payload;
    const text = res.text;
    t.done();
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = text;
    }
    if (!res.ok) throw classify(res.status, payload);
    if (payload && payload.error) throw classify(502, payload);
    return payload;
  }

  // GET /models doubles as the key check: 200 with a catalog, 401 with a bad key.
  async testConnection() {
    const payload = await this.request('GET', '/models?limit=1000', null, { timeoutMs: 20000 });
    const list = Array.isArray(payload && payload.data) ? payload.data : [];
    return {
      ok: true,
      account: {
        label: this.label,
        models: list.filter((m) => m && m.id).length,
      },
    };
  }

  async listModels() {
    const payload = await this.request('GET', '/models?limit=1000', null, { timeoutMs: 30000 });
    const list = Array.isArray(payload && payload.data) ? payload.data : [];
    return list
      .filter((m) => m && m.id)
      .map((m) => ({
        id: m.id,
        name: m.display_name || m.id,
        context_length: ANTHROPIC_PRESET.context_length,
        max_completion_tokens: null,
        pricing: { prompt: 0, completion: 0 },
        supports: { json: true, tools: true, seed: false },
        created: m.created_at || null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Split the shared message list into the native system + turns shape. */
  splitMessages(messages) {
    const system = [];
    const turns = [];
    for (const m of Array.isArray(messages) ? messages : []) {
      if (!m || typeof m.content !== 'string') continue;
      if (m.role === 'system') system.push(m.content);
      else turns.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
    }
    return { system: system.join('\n\n') || null, turns };
  }

  /** Shared OpenAI tool format -> native {name, description, input_schema}. */
  nativeTools(tools) {
    return (Array.isArray(tools) ? tools : []).map((t) => ({
      name: t && t.function && t.function.name,
      description: (t && t.function && t.function.description) || '',
      input_schema: (t && t.function && t.function.parameters) || { type: 'object', properties: {} },
    })).filter((t) => t.name);
  }

  /**
   * request: { model, messages, temperature, max_tokens, json, tools, tool_choice, timeoutMs, signal }
   * `json` needs no wire flag: Playbook Builder's prompts + robust JSON
   * extraction already own structured output (the same path as local models).
   */
  async chat(request) {
    const { system, turns } = this.splitMessages(request.messages);
    const body = {
      model: request.model,
      max_tokens: request.max_tokens || DEFAULT_MAX_TOKENS,
      messages: turns,
      stream: false,
    };
    if (system) body.system = system;
    if (typeof request.temperature === 'number') body.temperature = Math.min(1, Math.max(0, request.temperature));
    const tools = this.nativeTools(request.tools);
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = request.tool_choice === 'required' ? { type: 'any' } : { type: 'auto' };
    }
    const attempts = request.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      try {
        const payload = await this.request('POST', '/messages', body, { timeoutMs: request.timeoutMs || 180000, signal: request.signal });
        const parts = Array.isArray(payload && payload.content) ? payload.content : [];
        // Text, hidden reasoning and tool calls ride back together as blocks.
        const content = parts.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('');
        const thinking = parts.filter((p) => p && p.type === 'thinking').map((p) => p.thinking || '').join('\n').trim();
        const toolCalls = parts
          .filter((p) => p && p.type === 'tool_use')
          .map((p) => ({ id: p.id, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.input || {}) } }));
        // A tool-call reply has no visible content by design — that is not an
        // empty response. Only a truly content-less, tool-less reply is one.
        if (!String(content || '').trim() && !toolCalls.length) {
          throw new ProviderError(
            'EMPTY_RESPONSE',
            thinking
              ? `The model produced ${thinking.length} characters of hidden reasoning but no visible content${payload.stop_reason === 'max_tokens' ? ' before the output limit was reached' : ''}. Raise the output limit or pick a model that keeps its reasoning inside the answer.`
              : `The model returned no visible content${payload.stop_reason ? ` (stop reason: ${payload.stop_reason})` : ''}.`,
            { retryable: true, details: { stop_reason: payload.stop_reason || null, thinking_chars: thinking ? thinking.length : undefined } },
          );
        }
        const usage = (payload && payload.usage) || {};
        return {
          content,
          thinking: thinking || undefined,
          tool_calls: toolCalls,
          finish_reason: FINISH_REASONS[payload.stop_reason] || null,
          model: payload.model || request.model,
          usage: {
            prompt_tokens: usage.input_tokens || 0,
            completion_tokens: usage.output_tokens || 0,
            total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
            cost: null,
          },
        };
      } catch (err) {
        if (err.retryable && attempt < attempts) {
          await sleep(1000 * (attempt + 1) * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
  }
}

function classify(status, body) {
  const raw = body && body.error && typeof body.error === 'object' ? body.error : {};
  const message = raw.message || (body && body.error && body.error.type) || (typeof body === 'string' ? body : '') || `HTTP ${status}`;
  const text = String(message);
  if (status === 401 || status === 403) {
    return new ProviderError('AUTH_ERROR', `Anthropic rejected the API key (${text}). Check the key in AI Connections.`, { status });
  }
  if (status === 404) {
    return new ProviderError('MODEL_NOT_FOUND', `Anthropic could not find that model or endpoint (${text}).`, { status });
  }
  if (status === 408 || status === 504) {
    return new ProviderError('TIMEOUT', `Anthropic timed out (${text}).`, { status, retryable: true });
  }
  if (status === 429) {
    return new ProviderError('RATE_LIMITED', `Anthropic rate limit reached (${text}).`, { status, retryable: true });
  }
  if (status === 413 || (status === 400 && /context|too large|too long|token limit|maximum.*tokens|prompt is too long/i.test(text))) {
    return new ProviderError('CONTEXT_TOO_SMALL', `The request did not fit the model's context window (${text}).`, { status });
  }
  if (status === 529 || status >= 500) {
    return new ProviderError('TEMPORARY_PROVIDER_ERROR', `Anthropic is temporarily overloaded or unavailable (${text}).`, { status, retryable: true });
  }
  return new ProviderError('BAD_REQUEST', `Anthropic rejected the request: ${text}`, { status, details: raw });
}

registerProvider(ANTHROPIC_PRESET.id, {
  label: ANTHROPIC_PRESET.label,
  description: 'Claude models (Opus, Sonnet, Haiku) through the native Anthropic Messages API.',
  key_hint: 'sk-ant-…',
  docs_url: 'https://console.anthropic.com/settings/keys',
  type: 'cloud',
  note: 'Uses the native Messages API (x-api-key + anthropic-version) — no OpenAI compatibility layer involved. The base URL only changes for a gateway or proxy.',
  defaults: { base_url: ANTHROPIC_PRESET.base_url },
  create: (connection, apiKey) => new AnthropicProvider(connection, apiKey),
});
