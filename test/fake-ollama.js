// A stand-in for a locally installed Ollama, used by the self-test so the real
// HTTP path (detect → capabilities → test → generate → execute) is exercised
// end to end without installing anything.
//
//   GET  /api/tags              installed models
//   POST /api/show              model details + capabilities
//   GET  /v1/models             OpenAI-compatible listing
//   POST /v1/chat/completions   chat, answered by the shared scripted brain
//   POST /api/chat              native chat (v1.4.0) — simulates the reported
//                               qwen3.5 behaviour: without a TOP-LEVEL
//                               think:false the thinking tokens consume the
//                               whole answer budget and content comes back
//                               empty (Ollama issue #14793)
import http from 'node:http';
import { scriptedReply } from './mock-provider.js';

const MODELS = [
  { name: 'llama3.2:latest', size: 2019393189, family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M', capabilities: ['completion', 'tools'], context_length: 131072 },
  { name: 'qwen2.5:7b', size: 4683087332, family: 'qwen2', parameter_size: '7.6B', quantization_level: 'Q4_K_M', capabilities: ['completion'], context_length: 32768 },
  { name: 'nomic-embed-text:latest', size: 274302450, family: 'nomic-bert', parameter_size: '137M', quantization_level: 'F16', capabilities: ['embedding'], context_length: 2048 },
  { name: 'qwen3.5:9b', size: 6098857332, family: 'qwen3', parameter_size: '9.2B', quantization_level: 'Q4_K_M', capabilities: ['completion', 'thinking'], context_length: 131072 },
];

// The default list keeps the historical three models so older assertions hold.
const DEFAULT_MODELS = new Set(['llama3.2:latest', 'qwen2.5:7b', 'nomic-embed-text:latest']);

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/**
 * @param opts.models       model names the fake server reports (default: the three historical models)
 * @param opts.requireToken when set, requests must send this bearer token
 */
export async function startFakeOllama(opts = {}) {
  const state = {
    models: opts.models ? MODELS.filter((m) => opts.models.includes(m.name)) : MODELS.filter((m) => DEFAULT_MODELS.has(m.name)),
    requireToken: opts.requireToken || null,
    calls: [],
    chatCalls: 0,
    nativeChatCalls: 0,
    lastRequest: null,
    lastNativeRequest: null,
    openAiRequests: [],
    nativeRequests: [],
    // Bug simulation switches for the reported qwen3.5 behaviour:
    emptyNative: false,   // /api/chat returns empty content + thinking, even with think:false
    emptyOpenAI: false,   // /v1/chat/completions returns empty content, even with reasoning_effort:none
    brokenCompile: false, // compiler-role prompts get prose instead of JSON
    notOllama: false,
  };
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    state.calls.push(`${req.method} ${url.pathname}`);
    if (state.requireToken && req.headers.authorization !== `Bearer ${state.requireToken}`) {
      return json(res, 401, { error: { message: 'invalid token' } });
    }
    if (state.notOllama) return json(res, 200, { hello: 'not ollama' });

    if (req.method === 'GET' && url.pathname === '/api/tags') {
      return json(res, 200, {
        models: state.models.map((m) => ({
          name: m.name,
          model: m.name,
          modified_at: '2026-09-01T10:00:00Z',
          size: m.size,
          digest: 'abc123',
          details: { family: m.family, parameter_size: m.parameter_size, quantization_level: m.quantization_level, format: 'gguf' },
        })),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/show') {
      const body = await readBody(req);
      const want = String(body.model || body.name || '');
      const m = state.models.find((x) => x.name === want || x.name.replace(/:latest$/, '') === want.replace(/:latest$/, ''));
      if (!m) return json(res, 404, { error: 'model not found, try pulling it first' });
      return json(res, 200, {
        details: { family: m.family, parameter_size: m.parameter_size, quantization_level: m.quantization_level, format: 'gguf' },
        model_info: { [`${m.family}.context_length`]: m.context_length, 'general.parameter_count': 3200000000 },
        capabilities: m.capabilities,
        template: m.capabilities.includes('tools') ? '{{ if .Tools }}{{ end }}' : '{{ .Prompt }}',
      });
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return json(res, 200, { object: 'list', data: state.models.map((m) => ({ id: m.name, object: 'model', owned_by: 'library' })) });
    }

    // The reported empty-response bug lives here: /api/chat only honours
    // reasoning control when think is a TOP-LEVEL field, and this fake
    // answers like the affected builds do when it is missing.
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const body = await readBody(req);
      state.nativeChatCalls++;
      state.lastNativeRequest = body;
      state.nativeRequests.push(body);
      const model = state.models.find((m) => m.name === body.model || m.name.replace(/:latest$/, '') === String(body.model).replace(/:latest$/, ''));
      if (!model) return json(res, 404, { error: `model "${body.model}" not found, try pulling it first` });
      const chatReply = (content, thinking) =>
        json(res, 200, {
          model: body.model,
          created_at: '2026-09-21T08:00:00Z',
          message: { role: 'assistant', content, ...(thinking ? { thinking } : {}) },
          done: true,
          done_reason: 'stop',
          usage: { prompt_tokens: 120, prompt_eval_count: 120, completion_tokens: 40, eval_count: 40, total_tokens: 160 },
        });
      const emptyReply = () =>
        json(res, 200, {
          model: body.model,
          created_at: '2026-09-21T08:00:00Z',
          message: { role: 'assistant', content: '', thinking: 'The user wants JSON output. Let me plan the playbook structure step by step. First I will think about the objective, then the steps, then the rules, and only then write the final answer for the user to see.' },
          done: true,
          done_reason: 'length',
          usage: { prompt_tokens: 120, prompt_eval_count: 120, completion_tokens: 512, eval_count: 512, total_tokens: 632 },
        });
      const messages = body.messages || [];
      const system = String((messages[0] || {}).content || '');
      const text = String((messages[messages.length - 1] || {}).content || '');
      const thinking = model.capabilities.includes('thinking');
      if (state.brokenCompile && system.includes('Playbook Compiler')) return chatReply('Sure! Here is a playbook for you. It has steps and rules and everything you asked for.');
      if (thinking && (state.emptyNative || body.think !== false)) return emptyReply();
      if (/Return this JSON object exactly/i.test(text)) return chatReply('{"ready": true, "token": "PLAYBOOK_READY"}');
      if (/PLAYBOOK_READY/.test(text)) return chatReply('PLAYBOOK_READY');
      // The Model Compatibility Harness prompts (impl spec §8).
      if (/Report Builder/.test(text)) return chatReply('{"name": "Report Builder", "objective": "Build a short status report.", "steps": [{"id": "step_01", "name": "Collect", "type": "transform", "instructions": ["Collect the input."], "output": {"name": "data", "type": "array"}}]}');
      if (/clarification_question/.test(text)) return chatReply('{"response_type": "clarification_question", "status": "needs_input", "data": {"questions": [{"id": "q1", "text": "What should the playbook do?", "input_type": "text", "options": []}]}}');
      const r = await scriptedReply({ messages, tools: body.tools, model: body.model });
      return chatReply(r.content || '');
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = await readBody(req);
      state.chatCalls++;
      state.lastRequest = body;
      state.openAiRequests.push(body);
      const model = state.models.find((m) => m.name === body.model || m.name.replace(/:latest$/, '') === String(body.model).replace(/:latest$/, ''));
      if (!model) return json(res, 404, { error: { message: `model "${body.model}" not found, try pulling it first` } });
      const messages = body.messages || [];
      const system = String((messages[0] || {}).content || '');
      const text = String((messages[messages.length - 1] || {}).content || '');
      const finish = (content, tool_calls = [], reason = 'stop', extraMessage = {}) =>
        json(res, 200, {
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content, ...extraMessage, tool_calls: tool_calls.length ? tool_calls : undefined }, finish_reason: reason }],
          usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
        });

      // The reported empty-response bug on the OpenAI-compatible endpoint:
      // a thinking model without reasoning_effort "none" spends everything
      // on hidden reasoning (Ollama issue #14820 context).
      const reasoningOff = body.reasoning_effort === 'none';
      if (model.capabilities.includes('thinking')) {
        if (state.brokenCompile && system.includes('Playbook Compiler')) return finish('Sure! Here is a playbook for you. It has steps and rules and everything you asked for.');
        if (state.emptyOpenAI || !reasoningOff) {
          return finish('', [], 'length', { reasoning_content: 'Let me plan the JSON structure carefully. I will think through the steps first. Then the decision rules. Then the output fields. After all this thinking I would write the answer, but the budget is gone.' });
        }
      }

      // The connection test (spec v2 §11).
      if (/Return this JSON object exactly/i.test(text)) return finish('{"ready": true, "token": "PLAYBOOK_READY"}');
      if (/PLAYBOOK_READY/.test(text)) return finish('PLAYBOOK_READY');
      // The Model Compatibility Harness prompts (impl spec §8).
      if (/Report Builder/.test(text)) return finish('{"name": "Report Builder", "objective": "Build a short status report.", "steps": [{"id": "step_01", "name": "Collect", "type": "transform", "instructions": ["Collect the input."], "output": {"name": "data", "type": "array"}}]}');
      if (/clarification_question/.test(text)) return finish('{"response_type": "clarification_question", "status": "needs_input", "data": {"questions": [{"id": "q1", "text": "What should the playbook do?", "input_type": "text", "options": []}]}}');

      const r = await scriptedReply({ messages, tools: body.tools, model: body.model });
      return finish(r.content || '', r.tool_calls || [], r.finish_reason || 'stop');
    }

    if (req.method === 'GET' && url.pathname === '/') return json(res, 200, { status: 'Ollama is running' });
    return json(res, 404, { error: 'not found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    server,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
