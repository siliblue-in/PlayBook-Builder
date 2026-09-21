// Playbook Compiler (spec §30–§31). Input: original request + discovery
// conversation + confirmed intent + answers + constraints + tools + AI
// connection. Output: the Playbook JSON — never the task's final answer.
import { COMPILER_SYSTEM } from '../ai/prompts.js';
import { normalizePlaybook } from './schema.js';
import { qualityGate } from './validator.js';
import { mergeUsage } from '../ai/service.js';
import { nullReporter } from '../progress.js';
import { isPlainObject } from '../util.js';

const FINAL_ANSWER_HINTS = ['report', 'result', 'results', 'answer', 'summary', 'findings', 'analysis'];

/** Heuristic: did the model return a finished deliverable instead of a procedure? */
export function looksLikeFinalAnswer(data) {
  if (!isPlainObject(data)) return 'The response was not an object.';
  const pb = isPlainObject(data.playbook) ? data.playbook : null;
  if (!pb) {
    const keys = Object.keys(data).map((k) => k.toLowerCase());
    if (keys.some((k) => FINAL_ANSWER_HINTS.includes(k))) return 'The response contains a final result instead of a playbook. Return the procedure, not the result.';
    return 'data.playbook is missing.';
  }
  if (!Array.isArray(pb.steps) || pb.steps.length < 2) return 'The playbook must contain the workflow steps (at least 2) that perform the task — not the task\'s result.';
  const topKeys = Object.keys(pb).map((k) => k.toLowerCase());
  if (topKeys.some((k) => ['report', 'final_answer', 'answer', 'findings'].includes(k))) return 'The playbook contains a finished deliverable. Remove it and describe how to produce it.';
  return null;
}

function coerceEnvelope(env) {
  if (!isPlainObject(env)) return env;
  if (!env.response_type && Array.isArray(env.steps)) return { response_type: 'playbook', status: 'complete', data: { playbook: env } };
  if (env.response_type === 'playbook' && isPlainObject(env.data) && !env.data.playbook && Array.isArray(env.data.steps)) {
    return { ...env, data: { playbook: env.data } };
  }
  return env;
}

function gateFeedback(gate) {
  const lines = [];
  for (const c of gate.checks.filter((x) => !x.passed)) lines.push(`- ${c.label}: ${c.details.slice(0, 4).join(' ') || 'not satisfied'}`);
  for (const e of gate.errors.slice(0, 10)) lines.push(`- ${e.message}`);
  return lines.join('\n');
}

/**
 * Compile a playbook with the generation model. Runs up to `maxRepairs`
 * correction rounds when the quality gate or structural validation fails.
 */
export async function compilePlaybook(ai, { session, intent, constraints = [], tools = [], connectionId, executionModel, maxRepairs = 2, report = nullReporter }) {
  const conversation = [];
  if (session) {
    for (const t of session.turns) {
      if (t.kind !== 'question') continue;
      const reply = session.turns.find((u) => u.reply_to === t.id);
      for (const q of t.questions) {
        const a = reply && reply.answers ? reply.answers.find((x) => x.question_id === q.id) : null;
        conversation.push({ question: q.text, answer: a ? a.text : '(no answer)' });
      }
    }
  }
  const user = [
    'Compile a playbook from the confirmed intent below.',
    '',
    `ORIGINAL REQUEST:\n${session ? session.goal : intent.goal}`,
    '',
    `CONFIRMED INTENT:\n${JSON.stringify(intent, null, 2)}`,
    '',
    `DISCOVERY CONVERSATION:\n${conversation.length ? conversation.map((c) => `Q: ${c.question}\nA: ${c.answer}`).join('\n') : '(no questions were needed)'}`,
    '',
    `CONSTRAINTS:\n${[...(intent.constraints || []), ...constraints].map((c) => `- ${c}`).join('\n') || '- none stated'}`,
    '',
    `SELECTED TOOLS (use only when a step needs them):\n${tools.length ? tools.map((t) => `- ${t}`).join('\n') : '- none selected; declare only tools the workflow truly needs'}`,
    '',
    `SELECTED AI CONNECTION: connection_id=${connectionId || 'default'}, execution model=${executionModel || 'default'}`,
    '',
    'REMINDER: Do not perform the task. Return the reusable procedure as the complete Playbook JSON envelope.',
  ].join('\n');

  const messages = [
    { role: 'system', content: COMPILER_SYSTEM },
    { role: 'user', content: user },
  ];
  let usage = null;
  let best = null;
  let attempts = 0;
  for (let round = 0; round <= maxRepairs; round++) {
    attempts++;
    // Live progress (v1.7): the UI polls /api/progress/:key while this runs,
    // so every attempt and every quality-gate round is reported honestly —
    // "Attempt 2 of 3", "12/16 checks passed · repairing gaps" — instead of a
    // client-side guess.
    report.step('compile', 'active', `Attempt ${round + 1} of ${maxRepairs + 1} — the model is writing the playbook`);
    const res = await ai.json('generation', {
      messages,
      expect: 'playbook',
      temperature: 0.2,
      max_tokens: 16000,
      // No explicit timeout: the request inherits the configurable AI request
      // timeout (Settings → Privacy & AI, default 10 minutes) so a slow local
      // model is never cut off mid-compile by a hardcoded cap. max_tokens is
      // additionally clamped to the connection's context window in AIService
      // so a 16k num_ctx model is never asked for a 16k-token answer.
      coerce: coerceEnvelope,
      validate: (env) => looksLikeFinalAnswer(env.data),
      connectionId,
      maxRepairs: 1,
    });
    usage = mergeUsage(usage, res.usage);
    const raw = res.envelope.data.playbook;
    const pb = normalizePlaybook(raw);
    report.step('compile', 'done', `Attempt ${round + 1} produced ${pb.steps.length} steps`);
    report.step('validate', 'done', 'Structure, dependencies and decision rules parsed cleanly');
    pb.ai = { connection_id: connectionId || null, model: executionModel || null };
    const gate = qualityGate(pb);
    const passed = gate.checks.filter((c) => c.passed).length;
    const score = passed - gate.errors.length;
    if (!best || score > best.score) best = { pb, gate, score, model: res.model };
    if (gate.passed) {
      report.step('quality', 'done', `${passed}/${gate.checks.length} quality checks passed`);
      break;
    }
    if (round < maxRepairs) {
      report.step('quality', 'active', `Round ${round + 1} — ${passed}/${gate.checks.length} checks passed · repairing gaps (next: attempt ${round + 2} of ${maxRepairs + 1})`);
      messages.push({ role: 'assistant', content: res.content.slice(0, 60000) });
      messages.push({
        role: 'user',
        content: `The playbook failed the quality gate:\n${gateFeedback(gate)}\n\nFix every issue and return the COMPLETE corrected playbook in the same JSON envelope. Keep everything that was already correct. Remember: the procedure, not the result.`,
      });
    } else {
      report.step('quality', 'done', `Best of ${attempts} attempts kept — ${passed}/${gate.checks.length} checks passed`);
    }
  }
  return { playbook: best.pb, quality_gate: best.gate, usage, model: best.model, attempts };
}
