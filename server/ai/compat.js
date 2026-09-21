// Model Compatibility Harness (implementation spec §3, §8).
//
// "Connected" and "Compatible for Playbook Generation" are different things:
// a server can answer every discovery call and still return nothing a
// compiler can use (the reported qwen3.5:9b empty-response behaviour). Every
// model a user selects for playbook work can be put through these checks and
// gets one of three verdicts: compatible, compatible_with_limitations or
// incompatible — even when basic connectivity succeeds.
import { READY_TOKEN } from './local.js';

export const COMPAT_VERDICT_LABELS = {
  compatible: 'Compatible',
  compatible_with_limitations: 'Compatible with limitations',
  incompatible: 'Incompatible',
};

export const ENDPOINT_LABELS = {
  native_ollama_chat: 'Native Ollama Chat',
  openai_compatible: 'OpenAI-Compatible Chat',
};

// Four minutes per check: the playbook-shaped answers are small, but a large
// model on a CPU can still chew through them slowly — a timeout here would
// mislabel a slow-but-compatible model as broken.
const TIMEOUT_MS = 240000;

function sys(text) {
  return { role: 'system', content: text };
}

/** Validate the mini playbook shape the harness asks the model to produce. */
function playbookShapeOk(pb) {
  return Boolean(
    pb && typeof pb === 'object' &&
    typeof pb.name === 'string' && pb.name.trim() &&
    typeof pb.objective === 'string' && pb.objective.trim() &&
    Array.isArray(pb.steps) && pb.steps.length > 0 &&
    pb.steps.every((s) => s && typeof s === 'object' && (typeof s.name === 'string' || typeof s.id === 'string') && Array.isArray(s.instructions) && s.instructions.length > 0),
  );
}

/** Validate the app's response envelope for a dynamic clarification question. */
function questionShapeOk(env) {
  return Boolean(
    env && typeof env === 'object' &&
    env.response_type === 'clarification_question' &&
    env.status === 'needs_input' &&
    env.data && typeof env.data === 'object' &&
    Array.isArray(env.data.questions) && env.data.questions.length > 0 &&
    env.data.questions.every((q) => q && typeof q === 'object' && (q.id || q.text)),
  );
}

function parseJsonObject(text) {
  const t = String(text || '');
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(t);
  for (const candidate of [t, fence ? fence[1] : '', t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)]) {
    if (!candidate || !candidate.includes('{')) continue;
    try {
      const v = JSON.parse(candidate.trim());
      if (v && typeof v === 'object') return { ok: true, value: v };
    } catch { /* next candidate */ }
  }
  return { ok: false };
}

/**
 * Run every check against one model on one provider.
 * Returns { model, verdict, verdict_label, checks, endpoint_mode, reasoning_mode, reasons, checked_at }.
 */
export async function runCompatHarness(provider, { model } = {}) {
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail });
  let endpointMode = null;
  let reasoningMode = null;
  const rememberMode = (reply) => {
    if (reply && reply.endpoint_mode) endpointMode = reply.endpoint_mode;
    if (reply && reply.reasoning_mode) reasoningMode = reply.reasoning_mode;
  };

  // 1 — connectivity: the server answers and lists models.
  try {
    const models = await provider.listModels();
    const known = models.some((m) => m.id === model || m.id.replace(/:latest$/, '') === String(model).replace(/:latest$/, ''));
    add('connectivity', 'Connectivity', 'ok', `The server answered and lists ${models.length} model${models.length === 1 ? '' : 's'}${known ? `, including ${model}` : ''}.`);
  } catch (err) {
    add('connectivity', 'Connectivity', 'fail', err.message);
    return finish('incompatible', ['The server could not be reached, so no playbook generation is possible.']);
  }

  // 2 — text response: the exact failure point reported for qwen3.5:9b. A
  // thinking model that burns its budget on hidden reasoning fails here with
  // a classified EMPTY_RESPONSE instead of a vague error.
  try {
    const r = await provider.chat({
      model,
      messages: [sys('You follow instructions exactly. Reply with the requested text and nothing else.'), { role: 'user', content: `Return exactly:\n${READY_TOKEN}` }],
      temperature: 0,
      max_tokens: 64,
      timeoutMs: TIMEOUT_MS,
      retries: 1,
    });
    rememberMode(r);
    const said = String(r.content || '').trim();
    if (!said) add('text_response', 'Text response', 'fail', 'The model returned no visible content.');
    else if (!said.toUpperCase().includes(READY_TOKEN)) add('text_response', 'Text response', 'warn', `Answered, but not with the exact requested text: "${said.slice(0, 80)}".`);
    else add('text_response', 'Text response', 'ok', `Answered "${READY_TOKEN}" — visible content is produced with reasoning disabled.`);
  } catch (err) {
    add('text_response', 'Text response', 'fail', err.message);
    return finish('incompatible', [`The model cannot produce visible text output${err.code === 'EMPTY_RESPONSE' ? ' (hidden reasoning consumed the answer budget)' : ''}, so it cannot generate playbooks.`]);
  }

  // 3 — JSON mode: the smallest valid JSON object, prompted and parsed.
  let firstJson = '';
  try {
    const r = await provider.chat({
      model,
      messages: [sys('You reply with a single JSON object and nothing else.'), { role: 'user', content: 'Return this JSON object exactly: {"ready": true, "token": "PLAYBOOK_READY"}' }],
      temperature: 0,
      max_tokens: 120,
      json: true,
      timeoutMs: TIMEOUT_MS,
      retries: 1,
    });
    rememberMode(r);
    firstJson = String(r.content || '');
    const parsed = parseJsonObject(firstJson);
    if (parsed.ok && parsed.value.ready === true) add('json_output', 'JSON output', 'ok', 'Returned the requested JSON object.');
    else if (parsed.ok) add('json_output', 'JSON output', 'warn', 'Returned JSON, but not the requested object.');
    else add('json_output', 'JSON output', 'fail', `The answer was not valid JSON: "${firstJson.slice(0, 120) || 'nothing'}"`);
  } catch (err) {
    add('json_output', 'JSON output', 'fail', err.message);
  }

  // 4 — Playbook schema: the canonical nested shape the compiler expects.
  try {
    const r = await provider.chat({
      model,
      messages: [
        sys('You reply with a single JSON object and nothing else. Follow the requested structure exactly.'),
        {
          role: 'user',
          content: 'Return ONLY a JSON object with this exact structure: {"name": "Report Builder", "objective": "Build a short status report.", "steps": [{"id": "step_01", "name": "Collect", "type": "transform", "instructions": ["Collect the input."], "output": {"name": "data", "type": "array"}}]}',
        },
      ],
      temperature: 0,
      max_tokens: 400,
      json: true,
      timeoutMs: TIMEOUT_MS,
      retries: 1,
    });
    rememberMode(r);
    const parsed = parseJsonObject(r.content);
    if (parsed.ok && playbookShapeOk(parsed.value)) add('playbook_schema', 'Playbook schema', 'ok', 'Returned the nested playbook JSON shape.');
    else if (parsed.ok) add('playbook_schema', 'Playbook schema', 'fail', 'The JSON was missing required playbook fields (name, objective, steps with instructions).');
    else add('playbook_schema', 'Playbook schema', 'fail', `The answer was not valid JSON: "${String(r.content || '').slice(0, 120) || 'nothing'}"`);
  } catch (err) {
    add('playbook_schema', 'Playbook schema', 'fail', err.message);
  }

  // 5 — dynamic question: the response envelope used by Intent Discovery.
  try {
    const r = await provider.chat({
      model,
      messages: [
        sys('You reply with a single JSON object and nothing else. Follow the requested structure exactly.'),
        {
          role: 'user',
          content: 'Return ONLY a JSON envelope: {"response_type": "clarification_question", "status": "needs_input", "data": {"questions": [{"id": "q1", "text": "What should the playbook do?", "input_type": "text", "options": []}]}}',
        },
      ],
      temperature: 0,
      max_tokens: 300,
      json: true,
      timeoutMs: TIMEOUT_MS,
      retries: 1,
    });
    rememberMode(r);
    const parsed = parseJsonObject(r.content);
    if (parsed.ok && questionShapeOk(parsed.value)) add('dynamic_question', 'Dynamic question', 'ok', 'Returned the clarification-question envelope.');
    else if (parsed.ok) add('dynamic_question', 'Dynamic question', 'fail', 'The envelope did not match the required response_type/status/data shape.');
    else add('dynamic_question', 'Dynamic question', 'fail', `The answer was not valid JSON: "${String(r.content || '').slice(0, 120) || 'nothing'}"`);
  } catch (err) {
    add('dynamic_question', 'Dynamic question', 'fail', err.message);
  }

  // 6 — repeatability: the same JSON request twice at temperature 0.
  try {
    const ask = () => provider.chat({
      model,
      messages: [sys('You reply with a single JSON object and nothing else.'), { role: 'user', content: 'Return this JSON object exactly: {"ready": true, "token": "PLAYBOOK_READY"}' }],
      temperature: 0,
      max_tokens: 120,
      json: true,
      timeoutMs: TIMEOUT_MS,
      retries: 1,
    });
    const a = await ask();
    rememberMode(a);
    const b = await ask();
    rememberMode(b);
    const same = String(a.content || '').trim() === String(b.content || '').trim();
    if (same) add('repeatability', 'Repeatability', 'ok', 'Two identical requests returned identical answers.');
    else add('repeatability', 'Repeatability', 'warn', 'Two identical requests returned different answers — this model is not deterministic at temperature 0, so expect repeatability warnings.');
  } catch (err) {
    add('repeatability', 'Repeatability', 'warn', `The repeat check could not run: ${err.message}`);
  }

  // Acceptance gate (impl spec §3).
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
  const reasons = [];
  let verdict = 'compatible';
  if (byId.connectivity.status === 'fail' || byId.text_response.status === 'fail') {
    verdict = 'incompatible';
  } else {
    for (const id of ['json_output', 'playbook_schema', 'dynamic_question']) {
      if (byId[id].status === 'fail') {
        verdict = 'compatible_with_limitations';
        reasons.push(`${byId[id].label} failed: the model may need retries, or playbook generation could fail on this server build.`);
      }
    }
    if (byId.repeatability.status !== 'ok' && verdict === 'compatible') {
      verdict = 'compatible_with_limitations';
      reasons.push('Repeatability is not perfect: identical requests can produce different answers.');
    }
    if (byId.text_response.status === 'warn' && verdict === 'compatible') {
      verdict = 'compatible_with_limitations';
      reasons.push('The model drifts from strict instructions; expect more repair rounds during generation.');
    }
  }
  return finish(verdict, reasons);

  function finish(v, why) {
    return {
      model,
      verdict: v,
      verdict_label: COMPAT_VERDICT_LABELS[v],
      checks,
      endpoint_mode: endpointMode,
      reasoning_mode: reasoningMode || (endpointMode ? 'off' : null),
      reasons: why || [],
      checked_at: new Date().toISOString(),
    };
  }
}
