// AIProvider abstraction (spec §51). Every provider implements:
//   testConnection() -> { ok, account }
//   listModels()     -> [{ id, name, context_length, pricing:{prompt,completion}, supports:{json,tools}, max_completion_tokens }]
//   chat(request)    -> { content, tool_calls, finish_reason, usage, model }
// New providers register in PROVIDERS; the rest of the app only sees AIProvider.

export class ProviderError extends Error {
  constructor(code, message, { status, retryable = false, details } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

export class AIProvider {
  constructor(connection, apiKey) {
    this.connection = connection;
    this.apiKey = apiKey;
  }

  // eslint-disable-next-line class-methods-use-this
  async testConnection() {
    throw new ProviderError('not_implemented', 'testConnection() is not implemented.');
  }

  // eslint-disable-next-line class-methods-use-this
  async listModels() {
    throw new ProviderError('not_implemented', 'listModels() is not implemented.');
  }

  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async chat(request) {
    throw new ProviderError('not_implemented', 'chat() is not implemented.');
  }
}

/** Provider registry: id -> { label, description, create(connection, apiKey) }. */
export const PROVIDERS = new Map();

export function registerProvider(id, definition) {
  PROVIDERS.set(id, definition);
}

export function providerCatalog() {
  return [...PROVIDERS.entries()]
    .filter(([, d]) => !d.hidden)
    .map(([id, d]) => ({
      id,
      label: d.label,
      description: d.description,
      key_hint: d.key_hint || '',
      docs_url: d.docs_url || '',
      note: d.note || '',
      type: d.type || 'cloud',
      // Local providers describe their own setup so the UI stays generic.
      defaults: d.defaults || null,
      setup: d.setup || null,
      // Cloud presets: some gateways run without a key, one preset needs a URL.
      allow_no_key: Boolean(d.allow_no_key),
      requires_base_url: Boolean(d.requires_base_url),
    }));
}

/** True when a provider runs on this computer (no cloud, no API key). */
export function isLocalProvider(id) {
  const d = PROVIDERS.get(id);
  return Boolean(d && d.type === 'local');
}
