// OpenAI-compatible cloud providers. One adapter class serves every aggregator:
// OpenRouter, NVIDIA NIM (build.nvidia.com), AMD Developer Cloud, Google AI
// (Gemini), Groq, Together, DeepInfra, Fireworks, Mistral, Cerebras, xAI,
// GitHub Models and any custom OpenAI-compatible gateway. Each provider is a
// small preset (base URL, key hint, docs link); behaviour and error handling
// are shared.
//
//   GET  {base}/models            model catalog + key check
//   POST {base}/chat/completions  chat / tools / JSON mode
//   GET  https://openrouter.ai/api/v1/key   OpenRouter-only account check
import { AIProvider, ProviderError, registerProvider } from './provider.js';
import { sleep } from '../util.js';
import { httpRequest, isTimeoutError } from './transport.js';

const APP_TITLE = 'Playbook Builder for AI';

export const OPENROUTER_PRESET = {
  id: 'openrouter',
  label: 'OpenRouter',
  base_url: 'https://openrouter.ai/api/v1',
  description: 'One API key for hundreds of models (OpenAI, Anthropic, Google, Meta, Mistral, DeepSeek and more).',
  key_hint: 'sk-or-v1-…',
  docs_url: 'https://openrouter.ai/keys',
  router_headers: true,
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

/** Generic OpenAI-compatible provider for every registered cloud preset. */
export class OpenAICompatProvider extends AIProvider {
  constructor(connection, apiKey, preset) {
    super(connection, apiKey);
    this.preset = preset || OPENROUTER_PRESET;
    // A connection may pin its own base URL (enterprise gateway / proxy /
    // self-hosted vLLM). Otherwise the preset default applies.
    this.base = String((connection && connection.base_url) || this.preset.base_url || '').replace(/\/+$/, '');
  }

  get label() {
    return this.preset.label;
  }

  headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    if (this.preset.router_headers) {
      h['HTTP-Referer'] = 'http://localhost';
      h['X-Title'] = APP_TITLE;
      h['X-OpenRouter-Title'] = APP_TITLE;
    }
    return h;
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
        throw new ProviderError('TIMEOUT', `${this.label} did not respond within ${Math.round(timeoutMs / 1000)}s.`, { retryable: true });
      }
      throw new ProviderError('NETWORK_ERROR', `Could not reach ${this.label}: ${err.cause ? err.cause.code || err.cause.message : err.message}`, { retryable: true });
    }
    let payload;
    const text = res.text;
    t.done();
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = text;
    }
    if (!res.ok) throw classify(res.status, payload, this.label, this.base);
    if (payload && payload.error) throw classify(payload.error.code && Number(payload.error.code) >= 400 ? Number(payload.error.code) : 502, payload, this.label, this.base);
    return payload;
  }

  // Every OpenAI-compatible catalog answers GET /models — that doubles as the
  // key check on providers that have no dedicated account endpoint.
  async testConnection() {
    const payload = await this.request('GET', '/models', null, { timeoutMs: 20000 });
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
    const payload = await this.request('GET', '/models', null, { timeoutMs: 30000 });
    const list = Array.isArray(payload && payload.data) ? payload.data : [];
    return list
      .filter((m) => m && m.id)
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        // Context size is reported under different names across aggregators.
        context_length: m.context_length || m.context_window || m.max_model_len || null,
        max_completion_tokens: m.max_completion_tokens || m.max_output_tokens || null,
        pricing: {
          prompt: Number((m.pricing && m.pricing.prompt) || 0),
          completion: Number((m.pricing && m.pricing.completion) || 0),
        },
        // Most hosted catalog models accept JSON mode and tools; the chat
        // adapter falls back gracefully when a specific model refuses one.
        supports: { json: true, tools: true, seed: true },
        created: m.created || null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * request: { model, messages, temperature, max_tokens, json, tools, tool_choice, seed, timeoutMs, signal }
   */
  async chat(request) {
    const body = {
      model: request.model,
      messages: request.messages,
    };
    if (typeof request.temperature === 'number') body.temperature = request.temperature;
    if (request.max_tokens) body.max_tokens = request.max_tokens;
    if (Number.isInteger(request.seed)) body.seed = request.seed;
    if (Array.isArray(request.tools) && request.tools.length) {
      body.tools = request.tools;
      body.tool_choice = request.tool_choice || 'auto';
    }
    let useJson = Boolean(request.json);
    const attempts = request.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      if (useJson) body.response_format = { type: 'json_object' };
      else delete body.response_format;
      try {
        const payload = await this.request('POST', '/chat/completions', body, { timeoutMs: request.timeoutMs || 600000, signal: request.signal });
        const choice = (payload.choices && payload.choices[0]) || {};
        const msg = choice.message || {};
        let content = msg.content;
        if (Array.isArray(content)) content = content.map((p) => (typeof p === 'string' ? p : p.text || '')).join('');
        // Reasoning models can spend the whole budget in msg.reasoning /
        // msg.reasoning_content and return empty content. Never report that
        // as a bare empty response: keep the reasoning, classify the failure
        // and let the retry below repeat the request once (impl spec §6/§9).
        // A tool-call reply has no content by design and stays valid.
        const thinking = String(msg.reasoning_content || msg.reasoning || '').trim();
        const replyToolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        if (!String(content || '').trim() && !replyToolCalls.length) {
          const err = new ProviderError(
            'EMPTY_RESPONSE',
            thinking
              ? `The model produced ${thinking.length} characters of hidden reasoning but no visible content${choice.finish_reason === 'length' ? ' before the output limit was reached' : ''}. Raise the output limit or pick a model that keeps its reasoning inside the answer.`
              : `The model returned no visible content${choice.finish_reason ? ` (finish reason: ${choice.finish_reason})` : ''}.`,
            { retryable: true, details: { finish_reason: choice.finish_reason || null, thinking_chars: thinking ? thinking.length : undefined } },
          );
          throw err;
        }
        const usage = payload.usage || {};
        return {
          content: content || '',
          thinking: thinking || undefined,
          tool_calls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
          finish_reason: choice.finish_reason || null,
          model: payload.model || request.model,
          usage: {
            prompt_tokens: usage.prompt_tokens || 0,
            completion_tokens: usage.completion_tokens || 0,
            total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
            cost: typeof usage.cost === 'number' ? usage.cost : null,
          },
        };
      } catch (err) {
        // Some models reject response_format; fall back to plain text JSON.
        if (useJson && err.code === 'BAD_REQUEST' && /response_format|json|structured/i.test(err.message)) {
          useJson = false;
          continue;
        }
        if (err.retryable && attempt < attempts) {
          await sleep(1000 * (attempt + 1) * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
  }
}

function classify(status, body, label, base) {
  const message = (body && body.error && (body.error.message || body.error.code)) || (typeof body === 'string' ? body : '') || `HTTP ${status}`;
  const text = String(message);
  const host = String(base || '').replace(/^https?:\/\//, '').split('/')[0] || label;
  if (status === 401) return new ProviderError('AUTH_ERROR', `${label} rejected the API key (${text}).`, { status });
  if (status === 403 && /allowlist|proxy|blocked|firewall|egress/i.test(text)) {
    return new ProviderError('NETWORK_BLOCKED', `A network proxy or firewall blocked the request to ${host} (${text}).`, { status });
  }
  if (status === 403) return new ProviderError('FORBIDDEN', `${label} refused the request (${text}).`, { status });
  if (status === 402) return new ProviderError('INSUFFICIENT_CREDITS', `Your ${label} account has insufficient credits (${text}).`, { status });
  if (status === 404) return new ProviderError('MODEL_NOT_FOUND', `${label} could not find that model or endpoint (${text}).`, { status });
  if (status === 408 || status === 504) return new ProviderError('TIMEOUT', `${label} timed out (${text}).`, { status, retryable: true });
  if (status === 429) return new ProviderError('RATE_LIMITED', `${label} rate limit reached (${text}).`, { status, retryable: true });
  if (status >= 500) return new ProviderError('TEMPORARY_PROVIDER_ERROR', `${label} provider error (${text}).`, { status, retryable: true });
  return new ProviderError('BAD_REQUEST', `${label} request failed: ${text}`, { status, details: body && body.error });
}

/** OpenRouter adds an account endpoint and a rich model catalog on top. */
export class OpenRouterProvider extends OpenAICompatProvider {
  constructor(connection, apiKey) {
    super(connection, apiKey, OPENROUTER_PRESET);
  }

  async testConnection() {
    const payload = await this.request('GET', '/key', null, { timeoutMs: 20000 });
    const d = (payload && payload.data) || {};
    return {
      ok: true,
      account: {
        label: d.label || null,
        is_free_tier: d.is_free_tier ?? null,
        limit: d.limit ?? null,
        limit_remaining: d.limit_remaining ?? null,
        usage: d.usage ?? null,
      },
    };
  }

  async listModels() {
    const payload = await this.request('GET', '/models', null, { timeoutMs: 30000 });
    const list = Array.isArray(payload && payload.data) ? payload.data : [];
    return list
      .filter((m) => m && m.id)
      .filter((m) => {
        const out = m.architecture && m.architecture.output_modalities;
        return !Array.isArray(out) || out.includes('text');
      })
      .map((m) => {
        const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
        return {
          id: m.id,
          name: m.name || m.id,
          context_length: m.context_length || (m.top_provider && m.top_provider.context_length) || null,
          max_completion_tokens: (m.top_provider && m.top_provider.max_completion_tokens) || null,
          pricing: {
            prompt: Number((m.pricing && m.pricing.prompt) || 0),
            completion: Number((m.pricing && m.pricing.completion) || 0),
          },
          supports: {
            json: params.includes('response_format') || params.includes('structured_outputs'),
            tools: params.includes('tools'),
            seed: params.includes('seed'),
          },
          created: m.created || null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

// ------------------------------------------------------------------ presets
// Every preset speaks the OpenAI Chat Completions dialect. Base URLs can be
// overridden per connection (enterprise gateways, proxies, self-hosted vLLM).
const CLOUD_PRESETS = [
  OPENROUTER_PRESET,
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    base_url: 'https://integrate.api.nvidia.com/v1',
    description: 'NVIDIA-hosted catalog models (Llama, DeepSeek, Qwen, Nemotron and more) from build.nvidia.com.',
    key_hint: 'nvapi-…',
    docs_url: 'https://build.nvidia.com/',
  },
  {
    id: 'amd',
    label: 'AMD Developer Cloud',
    base_url: 'https://api.developer.amd.com/v1',
    description: 'Instinct-GPU-hosted open models from the AMD Developer Cloud (OpenAI-compatible API).',
    key_hint: 'AMD API key',
    docs_url: 'https://developer.amd.com/developer-cloud/',
    note: 'AMD evolves this endpoint; the base URL is editable — copy the current one from the AMD console if needed.',
  },
  {
    id: 'google',
    label: 'Google AI (Gemini)',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    description: 'Gemini models through Google’s OpenAI-compatible endpoint (API key from AI Studio).',
    key_hint: 'AIza…',
    docs_url: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'groq',
    label: 'Groq',
    base_url: 'https://api.groq.com/openai/v1',
    description: 'Extremely fast LPU inference for open models (Llama, Mixtral, Gemma…).',
    key_hint: 'gsk_…',
    docs_url: 'https://console.groq.com/keys',
  },
  {
    id: 'together',
    label: 'Together AI',
    base_url: 'https://api.together.xyz/v1',
    description: '200+ open-source and frontier models behind one API key.',
    key_hint: 'tgp_…',
    docs_url: 'https://api.together.xyz/settings/api-keys',
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra',
    base_url: 'https://api.deepinfra.com/v1/openai',
    description: 'Pay-per-token hosting of open models with an OpenAI-compatible API.',
    key_hint: 'API key',
    docs_url: 'https://deepinfra.com/dash/api_keys',
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    base_url: 'https://api.fireworks.ai/inference/v1',
    description: 'Fast, production-grade inference for open and custom models.',
    key_hint: 'fw_…',
    docs_url: 'https://fireworks.ai/account/api-keys',
  },
  {
    id: 'mistral',
    label: 'Mistral La Plateforme',
    base_url: 'https://api.mistral.ai/v1',
    description: 'Mistral’s own models (Large, Medium, Small, Codestral…) with one key.',
    key_hint: 'API key',
    docs_url: 'https://console.mistral.ai/api-keys/',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    base_url: 'https://api.cerebras.ai/v1',
    description: 'Wafer-scale inference — among the fastest tokens-per-second available.',
    key_hint: 'csk-…',
    docs_url: 'https://cloud.cerebras.ai/',
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    base_url: 'https://api.x.ai/v1',
    description: 'Grok models through the OpenAI-compatible xAI API.',
    key_hint: 'xai-…',
    docs_url: 'https://console.x.ai/',
  },
  {
    id: 'github_models',
    label: 'GitHub Models',
    base_url: 'https://models.github.ai/inference',
    description: 'Try frontier models (OpenAI, Meta, Mistral, DeepSeek…) with a GitHub token.',
    key_hint: 'ghp_… / github_pat_…',
    docs_url: 'https://github.com/settings/personal-access-tokens',
  },
  {
    id: 'custom_openai',
    label: 'Custom OpenAI-compatible',
    base_url: '',
    description: 'Any OpenAI-compatible endpoint: self-hosted vLLM, LM Studio tunnel, corporate gateway… Provide the base URL (it usually ends in /v1).',
    key_hint: 'key, if the endpoint needs one',
    docs_url: '',
    allow_no_key: true,
    requires_base_url: true,
  },
];

registerProvider('openrouter', {
  ...OPENROUTER_PRESET,
  type: 'cloud',
  defaults: { base_url: OPENROUTER_PRESET.base_url },
  create: (connection, apiKey) => new OpenRouterProvider(connection, apiKey),
});

for (const preset of CLOUD_PRESETS) {
  if (preset.id === 'openrouter') continue;
  registerProvider(preset.id, {
    label: preset.label,
    description: preset.description,
    key_hint: preset.key_hint || '',
    docs_url: preset.docs_url || '',
    note: preset.note || '',
    type: 'cloud',
    defaults: { base_url: preset.base_url || null },
    allow_no_key: Boolean(preset.allow_no_key),
    requires_base_url: Boolean(preset.requires_base_url),
    create: (connection, apiKey) => new OpenAICompatProvider(connection, apiKey, preset),
  });
}
