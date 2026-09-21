// AI execution mode (spec §44): the execution model runs the playbook as an
// agent — tools are executed by the engine under policy, approvals pause the
// run — and returns a typed execution_result that is validated afterwards.
import { EXECUTION_SYSTEM } from '../ai/prompts.js';
import { extractJson } from '../ai/json.js';
import { emptyUsage, mergeUsage } from '../ai/service.js';
import { configMap, procedureOf } from '../playbooks/schema.js';
import { validateSchema, formatSchemaErrors } from './jsonschema.js';
import { isPlainObject, sleep } from '../util.js';

const MAX_TOOL_ROUNDS = 10;

function toolName(tool) {
  return String(tool.id || tool.name).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
}

export function toolSchemas(pb) {
  return (pb.tools || [])
    .filter((t) => t.required !== false || t.binding)
    .map((t) => ({
      type: 'function',
      function: {
        name: toolName(t),
        description: `${t.name}: ${t.purpose || 'Playbook tool.'} Permission: ${t.permission}.`.slice(0, 1000),
        parameters: {
          type: 'object',
          properties: { arguments: { type: 'object', description: 'Arguments for the tool call.', additionalProperties: true } },
        },
      },
    }));
}

function normalizeTrace(pb, trace) {
  const list = Array.isArray(trace) ? trace.filter(isPlainObject) : [];
  const byId = new Map(list.map((t) => [String(t.step_id), t]));
  return (pb.steps || []).map((s) => {
    const t = byId.get(s.id);
    if (!t) return { step_id: s.id, name: s.name, type: s.type, status: 'unreported', message: 'The model did not report this step.' };
    const entry = {
      step_id: s.id,
      name: s.name,
      type: s.type,
      status: ['completed', 'skipped', 'failed'].includes(t.status) ? t.status : 'completed',
      message: String(t.summary || t.message || '').slice(0, 400),
    };
    if (t.decision !== undefined && t.decision !== null && t.decision !== '') entry.decision = t.decision;
    if (t.rule_id) entry.rule_id = String(t.rule_id);
    if (t.evidence !== undefined) entry.evidence = t.evidence;
    return entry;
  });
}

/**
 * Execute with the AI execution model.
 * opts: { ai, input, configuration, now, connectionId, model, temperature, toolRunner, toolCalling,
 *         requireValidation, onEvent, resume, role }
 * toolRunner(tool, args) -> { result } | { simulated, result, note } | { awaiting_approval, reason } | { error }
 */
export async function executeWithAI(pb, opts) {
  const {
    ai,
    input = {},
    configuration,
    now = new Date(),
    connectionId,
    model,
    temperature = 0,
    toolRunner = null,
    toolCalling = true,
    requireValidation = true,
    onEvent = () => {},
    resume = null,
    role = 'execution',
    signal = null,
  } = opts;
  const started = Date.now();
  const log = (level, message, step_id, data) => onEvent({ ts: new Date().toISOString(), level, message, step_id, data });
  const config = configMap(pb, configuration);
  const tools = toolCalling && toolRunner ? toolSchemas(pb) : [];
  const warnings = resume ? resume.warnings.slice() : [];
  let usage = resume ? resume.usage : emptyUsage();
  let modelUsed = model;

  const messages = resume
    ? resume.messages.slice()
    : [
        { role: 'system', content: EXECUTION_SYSTEM },
        {
          role: 'user',
          content: JSON.stringify(
            {
              instruction: 'Execute this playbook for the run input below. Return only the execution_result JSON.',
              evaluation_time: (now instanceof Date ? now : new Date(now)).toISOString(),
              configuration: config,
              input,
              tools_available: tools.map((t) => t.function.name),
              playbook: procedureOf({ ...pb, ai: undefined }),
            },
            null,
            2,
          ),
        },
      ];

  const result = (status, extra = {}) => ({
    status,
    output: null,
    error: null,
    warnings,
    trace: [],
    decisions: [],
    validation: { passed: false, issues: [] },
    usage,
    model: modelUsed,
    duration_ms: Date.now() - started,
    engine: 'ai',
    ...extra,
  });

  const retry = (pb.error_handling && pb.error_handling.retry) || { enabled: false, max_attempts: 1 };
  const maxAttempts = retry.enabled ? Math.max(1, retry.max_attempts || 1) : 1;

  let pendingToolCalls = resume && resume.pending_tool_calls ? resume.pending_tool_calls.slice() : [];
  let repairs = 0;
  for (let round = 0; round < MAX_TOOL_ROUNDS + 3; round++) {
    if (signal && signal.cancelled) return result('cancelled', { error: { code: 'CANCELLED', message: 'Run was cancelled.' } });

    // Resolve outstanding tool calls (possibly after an approval).
    if (pendingToolCalls.length) {
      while (pendingToolCalls.length) {
        const call = pendingToolCalls[0];
        const tool = (pb.tools || []).find((t) => toolName(t) === call.function.name);
        let args = {};
        try {
          const parsed = JSON.parse(call.function.arguments || '{}');
          args = isPlainObject(parsed.arguments) ? parsed.arguments : parsed;
        } catch {
          args = {};
        }
        let content;
        if (!tool) content = { error: `Unknown tool ${call.function.name}` };
        else {
          log('info', `Tool call: ${tool.name}`, null, { args });
          const r = await toolRunner(tool, args, { call_id: call.id });
          if (r && r.awaiting_approval) {
            log('info', `Paused for approval: ${tool.name}`);
            return result('awaiting_approval', {
              pending_approval: { tool_id: tool.id, tool_call_id: call.id, reason: r.reason || `Approve tool call: ${tool.name}`, args },
              resume: { messages, pending_tool_calls: pendingToolCalls, warnings, usage },
            });
          }
          if (r && r.simulated) warnings.push({ code: 'TOOL_SIMULATED', message: r.note || `${tool.name} was simulated by policy.` });
          content = r && r.error ? { error: r.error } : { result: r ? r.result : null, ...(r && r.simulated ? { simulated: true, note: r.note } : {}) };
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(content).slice(0, 20000) });
        pendingToolCalls.shift();
      }
    }

    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await ai.chat(role, { messages, temperature, max_tokens: 6000, json: !tools.length, tools: tools.length ? tools : undefined }, { connectionId, model });
        break;
      } catch (err) {
        const retryable = err.retryable || ['TIMEOUT', 'RATE_LIMITED', 'TEMPORARY_PROVIDER_ERROR'].includes(err.code);
        if (retryable && attempt < maxAttempts) {
          log('warn', `Provider error (${err.code}); retry ${attempt + 1}/${maxAttempts}.`);
          await sleep(Math.min(8000, (retry.backoff_seconds || 2) * 1000 * attempt));
          continue;
        }
        log('error', `Provider error: ${err.message}`);
        return result('failed', { error: { code: err.code || 'PROVIDER_ERROR', message: err.message } });
      }
    }
    usage = mergeUsage(usage, res.usage);
    modelUsed = res.model || modelUsed;

    if (res.tool_calls && res.tool_calls.length) {
      if (round >= MAX_TOOL_ROUNDS) return result('failed', { error: { code: 'TOO_MANY_TOOL_CALLS', message: 'The model kept calling tools without finishing.' } });
      messages.push({ role: 'assistant', content: res.content || null, tool_calls: res.tool_calls });
      pendingToolCalls = res.tool_calls.slice();
      continue;
    }

    const parsed = extractJson(res.content);
    const env = parsed.ok ? parsed.value : null;
    const typeOk = env && env.response_type === 'execution_result' && isPlainObject(env.data);
    if (!typeOk) {
      if (repairs < 1) {
        repairs++;
        messages.push({ role: 'assistant', content: String(res.content || '').slice(0, 12000) });
        messages.push({ role: 'user', content: 'That reply was not a valid execution_result JSON object. Return ONLY {"response_type":"execution_result","status":…,"data":{"output":…,"trace":[…],"error":…,"warnings":[…]}}.' });
        continue;
      }
      return result('failed', { error: { code: 'INVALID_AI_RESPONSE', message: parsed.ok ? 'The model did not return an execution_result.' : parsed.error }, raw: String(res.content || '').slice(0, 4000) });
    }

    const data = env.data;
    const status = ['completed', 'failed', 'needs_input'].includes(env.status) ? env.status : data.output !== undefined && data.output !== null ? 'completed' : 'failed';
    const trace = normalizeTrace(pb, data.trace);
    const decisions = trace.filter((t) => t.decision !== undefined).map((t) => ({ step_id: t.step_id, result: t.decision, rule_id: t.rule_id || null, evidence: t.evidence }));
    for (const w of Array.isArray(data.warnings) ? data.warnings : []) warnings.push({ code: 'MODEL_WARNING', message: String(typeof w === 'string' ? w : JSON.stringify(w)).slice(0, 300) });
    const output = data.output === undefined ? null : data.output;
    const issues = [];
    if (status === 'completed') {
      if (output === null) issues.push('No output was produced.');
      else if (pb.output && isPlainObject(pb.output.schema)) issues.push(...formatSchemaErrors(validateSchema(output, pb.output.schema, 'output'), 20));
    }
    const unreported = trace.filter((t) => t.status === 'unreported').length;
    if (unreported) warnings.push({ code: 'TRACE_INCOMPLETE', message: `${unreported} step(s) missing from the model's trace.` });
    const validation = { passed: issues.length === 0 && status === 'completed', issues };
    const error = isPlainObject(data.error) && (data.error.code || data.error.message) ? { code: String(data.error.code || 'EXECUTION_ERROR').toUpperCase(), message: String(data.error.message || ''), step_id: data.error.step_id || null } : null;
    if (status === 'completed' && issues.length && requireValidation) {
      log('error', `Output validation failed: ${issues.join('; ')}`);
      return result('failed', { output, trace, decisions, validation, error: { code: 'OUTPUT_INVALID', message: issues.join('; ') } });
    }
    log(status === 'completed' ? 'info' : 'error', `AI execution ${status}.`);
    return result(status, { output, trace, decisions, validation, error: status === 'completed' ? null : error || { code: 'EXECUTION_FAILED', message: 'The model reported a failure.' } });
  }
  return result('failed', { error: { code: 'NO_FINAL_ANSWER', message: 'The model did not finish the run.' } });
}
