// Intent Discovery (spec §27–§29): a short adaptive interview, one question at
// a time by default, with dynamic multiple-choice options, ending in a
// Confirmed Intent the user approves before compilation.
import { HttpError } from '../http.js';
import { discoveryPrompt } from '../ai/prompts.js';
import { emptyUsage, mergeUsage } from '../ai/service.js';
import { newId, nowIso, isPlainObject, asArray } from '../util.js';

export const SLOTS = ['goal', 'subject', 'criteria', 'data_sources', 'actions', 'trigger', 'output', 'constraints', 'tools', 'success_criteria', 'audience'];

/** Fixed questions used when Dynamic Questions is off. */
const STATIC_QUESTIONS = [
  {
    slot: 'criteria',
    text: 'What rule or condition should drive the decision?',
    input_type: 'text',
    options: [],
  },
  {
    slot: 'data_sources',
    text: 'Where does the input data come from?',
    input_type: 'single_choice',
    options: ['CRM', 'Spreadsheet', 'Database', 'API', 'Manual input'],
  },
  {
    slot: 'actions',
    text: 'What should happen with the results?',
    input_type: 'single_choice',
    options: ['Produce a report', 'Send an alert', 'Update records', 'Draft messages for review'],
  },
  {
    slot: 'trigger',
    text: 'How should the playbook start?',
    input_type: 'single_choice',
    options: ['Manually', 'On a schedule', 'When an event happens', 'Via API request'],
  },
  {
    slot: 'output',
    text: 'What format should the result have?',
    input_type: 'single_choice',
    options: ['Markdown report', 'JSON', 'Table', 'Email draft'],
  },
  {
    slot: 'constraints',
    text: 'What must the playbook never do?',
    input_type: 'multi_choice',
    options: ['Modify records', 'Send external messages', 'Delete data', 'No restrictions'],
  },
];

function normalizeQuestion(q, i, { multipleChoice, round }) {
  const text = String(q.text || q.question || '').trim();
  let inputType = String(q.input_type || q.type || '').toLowerCase();
  let options = asArray(q.options)
    .map((o, j) => (typeof o === 'string' ? { id: String.fromCharCode(97 + j), label: o } : isPlainObject(o) ? { id: String(o.id || String.fromCharCode(97 + j)), label: String(o.label || o.text || o.value || '').trim(), description: o.description ? String(o.description) : undefined } : null))
    .filter((o) => o && o.label && !/^(other|something else|none of (the )?above)\b/i.test(o.label))
    .slice(0, 6);
  if (!multipleChoice) options = [];
  if (!['single_choice', 'multi_choice', 'text', 'number'].includes(inputType)) inputType = options.length ? 'single_choice' : 'text';
  if ((inputType === 'single_choice' || inputType === 'multi_choice') && !options.length) inputType = 'text';
  return {
    id: `q${round}_${i + 1}`,
    slot: SLOTS.includes(q.slot) ? q.slot : 'other',
    text,
    input_type: inputType,
    options,
    allow_other: true,
  };
}

function similar(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter((w) => w.length > 3);
  const A = new Set(norm(a));
  const B = new Set(norm(b));
  if (!A.size || !B.size) return false;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common / Math.min(A.size, B.size) >= 0.8;
}

function answerText(q, a) {
  if (!a) return '';
  const parts = [];
  const ids = asArray(a.option_ids);
  for (const id of ids) {
    const o = (q.options || []).find((x) => x.id === id);
    if (o) parts.push(o.label);
  }
  if (a.text && String(a.text).trim()) parts.push(String(a.text).trim());
  if (a.value !== undefined && a.value !== null && a.value !== '' && !parts.length) parts.push(String(a.value));
  return parts.join('; ');
}

function normalizeIntent(raw, goal) {
  const i = isPlainObject(raw) ? raw : {};
  const list = (v) => asArray(v).map((x) => (typeof x === 'string' ? x.trim() : isPlainObject(x) ? String(x.text || x.description || x.name || JSON.stringify(x)) : String(x))).filter(Boolean);
  const trigger = isPlainObject(i.trigger) ? i.trigger : { type: typeof i.trigger === 'string' ? i.trigger : 'manual', description: typeof i.trigger === 'string' ? i.trigger : '' };
  const output = isPlainObject(i.output) ? i.output : { format: 'markdown', description: typeof i.output === 'string' ? i.output : '' };
  return {
    title: String(i.title || i.name || '').trim() || String(goal).slice(0, 48),
    goal: String(i.goal || goal || '').trim(),
    subject: String(i.subject || '').trim(),
    rules: list(i.rules || i.criteria),
    data_sources: list(i.data_sources || i.data),
    inputs: list(i.inputs),
    actions: list(i.actions || i.action),
    trigger: {
      type: String(trigger.type || 'manual').toLowerCase(),
      frequency: trigger.frequency ? String(trigger.frequency) : '',
      day: trigger.day ? String(trigger.day) : '',
      time: trigger.time ? String(trigger.time) : '',
      description: trigger.description ? String(trigger.description) : '',
    },
    output: { format: String(output.format || 'markdown'), destination: output.destination ? String(output.destination) : '', description: output.description ? String(output.description) : '' },
    constraints: list(i.constraints),
    tools: list(i.tools),
    success_criteria: list(i.success_criteria),
    assumptions: list(i.assumptions),
    open_questions: list(i.open_questions),
  };
}

export function intentSummary(intent) {
  if (!intent) return [];
  const t = intent.trigger || {};
  const freq = [t.frequency, t.day, t.time].filter(Boolean).join(' ');
  return [
    { label: 'Goal', value: intent.goal },
    { label: 'Rule', value: intent.rules.join('; ') },
    { label: 'Data', value: intent.data_sources.join(', ') },
    { label: 'Action', value: intent.actions.join('; ') },
    { label: 'Frequency', value: freq || (t.type ? t.type.replace(/_/g, ' ') : '') },
    { label: 'Output', value: [intent.output.format, intent.output.description].filter(Boolean).join(' — ') },
    { label: 'Constraints', value: intent.constraints.join('; ') },
  ].filter((x) => x.value);
}

export class DiscoveryService {
  constructor({ store, settings, ai }) {
    this.store = store;
    this.settings = settings;
    this.ai = ai;
  }

  get(id) {
    const s = this.store.sessions.get(id);
    if (!s) throw new HttpError(404, 'not_found', 'Discovery session not found.');
    return s;
  }

  view(s) {
    const pending = s.turns.filter((t) => t.role === 'assistant' && t.kind === 'question').slice(-1)[0];
    const answered = pending ? s.turns.some((t) => t.role === 'user' && t.reply_to === pending.id) : true;
    return {
      id: s.id,
      goal: s.goal,
      status: s.status,
      rounds: s.rounds,
      max_rounds: s.settings.max_rounds,
      turns: s.turns,
      pending_question: s.status === 'questioning' && pending && !answered ? pending : null,
      requirement_state: s.requirement_state,
      intent: s.intent,
      intent_summary: intentSummary(s.intent),
      intent_confirmed: s.intent_confirmed,
      settings: s.settings,
      playbook_id: s.playbook_id,
      usage: s.usage,
      created_at: s.created_at,
      updated_at: s.updated_at,
    };
  }

  envelopeFor(s) {
    const v = this.view(s);
    if (s.status === 'questioning' && v.pending_question) {
      return { response_type: 'clarification_question', status: 'needs_input', data: { session: v, questions: v.pending_question.questions } };
    }
    return { response_type: 'clarification_complete', status: 'complete', data: { session: v, intent: s.intent, summary: intentSummary(s.intent) } };
  }

  async start(goal) {
    const text = String(goal || '').trim();
    if (text.length < 3) throw new HttpError(400, 'bad_request', 'Describe what you want the playbook to do.');
    const settings = this.settings.get();
    const f = settings.features;
    const b = settings.behavior;
    const s = {
      id: newId('ds'),
      goal: text.slice(0, 4000),
      status: 'questioning',
      rounds: 0,
      settings: {
        intent_discovery: f.intent_discovery,
        dynamic_questions: f.dynamic_questions,
        multiple_choice: f.multiple_choice,
        objective_confirmation: f.objective_confirmation,
        max_rounds: b.max_clarification_rounds,
        max_questions: b.max_questions_per_round,
        show_assumptions: b.show_assumptions,
      },
      turns: [{ id: 't0', role: 'user', kind: 'goal', text: text.slice(0, 4000), at: nowIso() }],
      requirement_state: { goal: { value: text, source: 'user' } },
      asked_slots: [],
      intent: null,
      intent_confirmed: false,
      playbook_id: null,
      usage: emptyUsage(),
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    if (!f.intent_discovery) {
      await this.complete(s, { force: true, reason: 'Intent Discovery is off; building the intent directly from the request.' });
    } else {
      await this.nextTurn(s);
    }
    this.save(s);
    return this.envelopeFor(s);
  }

  save(s) {
    s.updated_at = nowIso();
    this.store.sessions.put(s);
  }

  conversation(s) {
    const pairs = [];
    for (const t of s.turns) {
      if (t.role !== 'assistant' || t.kind !== 'question') continue;
      const reply = s.turns.find((u) => u.role === 'user' && u.reply_to === t.id);
      for (const q of t.questions) {
        const a = reply && reply.answers ? reply.answers.find((x) => x.question_id === q.id) : null;
        pairs.push({ slot: q.slot, question: q.text, answer: a ? a.text : reply ? '(skipped)' : '(pending)' });
      }
    }
    return pairs;
  }

  async nextTurn(s) {
    const remaining = s.settings.max_rounds - s.rounds;
    if (remaining <= 0) return this.complete(s, { force: true });
    if (!s.settings.dynamic_questions) return this.staticTurn(s);
    const res = await this.ai.json('clarification', {
      system: discoveryPrompt({ maxQuestions: s.settings.max_questions, multipleChoice: s.settings.multiple_choice, remaining }),
      user: {
        original_request: s.goal,
        conversation: this.conversation(s),
        requirement_state: s.requirement_state,
        slots_already_asked: s.asked_slots,
        rounds_used: s.rounds,
        rounds_remaining: remaining,
      },
      expect: ['clarification_question', 'clarification_complete'],
      temperature: 0.3,
      max_tokens: 2500,
      validate: (env) => {
        if (env.response_type === 'clarification_question') {
          const qs = asArray(env.data.questions);
          if (!qs.length || !qs.every((q) => isPlainObject(q) && (q.text || q.question))) return 'data.questions must contain at least one question with "text".';
        }
        if (env.response_type === 'clarification_complete' && !isPlainObject(env.data.intent)) return 'data.intent must be an object.';
        return null;
      },
    });
    s.usage = mergeUsage(s.usage, res.usage);
    const env = res.envelope;
    if (isPlainObject(env.data.requirement_state)) s.requirement_state = { ...s.requirement_state, ...env.data.requirement_state };
    if (env.response_type === 'clarification_complete') return this.applyIntent(s, env.data.intent);

    // Guard: never re-ask known slots or repeat questions (§28).
    const asked = s.turns.filter((t) => t.kind === 'question').flatMap((t) => t.questions);
    let questions = asArray(env.data.questions)
      .slice(0, s.settings.max_questions)
      .map((q, i) => normalizeQuestion(q, i, { multipleChoice: s.settings.multiple_choice, round: s.rounds + 1 }))
      .filter((q) => q.text && !asked.some((a) => similar(a.text, q.text)) && !(q.slot !== 'other' && s.asked_slots.includes(q.slot) && q.slot !== 'criteria'));
    if (!questions.length) {
      return this.complete(s, { force: true, reason: 'The model tried to repeat a question; completing with what is known.' });
    }
    questions = questions.map((q, i) => ({ ...q, id: `q${s.rounds + 1}_${i + 1}` }));
    s.turns.push({ id: `t${s.turns.length}`, role: 'assistant', kind: 'question', questions, reasoning: env.data.reasoning ? String(env.data.reasoning) : '', at: nowIso() });
    s.status = 'questioning';
    return null;
  }

  staticTurn(s) {
    const next = STATIC_QUESTIONS.filter((q) => !s.asked_slots.includes(q.slot)).slice(0, s.settings.max_questions);
    if (!next.length) return this.complete(s, { force: true });
    const questions = next.map((q, i) =>
      normalizeQuestion({ ...q, options: q.options.map((label, j) => ({ id: String.fromCharCode(97 + j), label })) }, i, { multipleChoice: s.settings.multiple_choice, round: s.rounds + 1 }),
    );
    s.turns.push({ id: `t${s.turns.length}`, role: 'assistant', kind: 'question', questions, static: true, at: nowIso() });
    s.status = 'questioning';
    return null;
  }

  async answer(id, body) {
    const s = this.get(id);
    if (s.status !== 'questioning') throw new HttpError(409, 'not_questioning', 'This session is not waiting for an answer.');
    const pending = s.turns.filter((t) => t.role === 'assistant' && t.kind === 'question').slice(-1)[0];
    if (!pending || s.turns.some((t) => t.role === 'user' && t.reply_to === pending.id)) throw new HttpError(409, 'no_pending_question', 'There is no open question.');
    const incoming = Array.isArray(body.answers) ? body.answers : [body];
    const answers = [];
    for (const q of pending.questions) {
      const a = incoming.find((x) => x && x.question_id === q.id) || (pending.questions.length === 1 ? incoming[0] : null);
      const text = answerText(q, a || {});
      answers.push({ question_id: q.id, slot: q.slot, option_ids: asArray(a && a.option_ids), text: text || '(skipped)', skipped: !text });
      if (q.slot !== 'other' && !s.asked_slots.includes(q.slot)) s.asked_slots.push(q.slot);
      if (text && q.slot !== 'other') s.requirement_state[q.slot] = { value: text, source: 'user' };
    }
    s.turns.push({ id: `t${s.turns.length}`, role: 'user', kind: 'answer', reply_to: pending.id, answers, at: nowIso() });
    s.rounds++;
    if (body.finish) await this.complete(s, { force: true, reason: 'The user asked to finish questions.' });
    else await this.nextTurn(s);
    this.save(s);
    return this.envelopeFor(s);
  }

  /** Ask the model for the final intent (forced completion). */
  async complete(s, { force = false, reason = '' } = {}) {
    if (!s.settings.dynamic_questions && !this.ai.isAvailable('clarification')) {
      return this.applyIntent(s, this.intentFromAnswers(s));
    }
    const res = await this.ai.json('clarification', {
      system: discoveryPrompt({ maxQuestions: s.settings.max_questions, multipleChoice: s.settings.multiple_choice, remaining: 0 }),
      user: {
        original_request: s.goal,
        conversation: this.conversation(s),
        requirement_state: s.requirement_state,
        instruction: `${reason ? `${reason} ` : ''}Return clarification_complete now. Record every unknown as an explicit assumption.`,
      },
      expect: 'clarification_complete',
      temperature: 0.2,
      max_tokens: 2500,
      validate: (env) => (isPlainObject(env.data.intent) ? null : 'data.intent must be an object.'),
    });
    s.usage = mergeUsage(s.usage, res.usage);
    if (force && reason) s.turns.push({ id: `t${s.turns.length}`, role: 'system', kind: 'note', text: reason, at: nowIso() });
    return this.applyIntent(s, res.envelope.data.intent);
  }

  intentFromAnswers(s) {
    const get = (slot) => (s.requirement_state[slot] && s.requirement_state[slot].value) || '';
    const trig = get('trigger').toLowerCase();
    return {
      title: s.goal.slice(0, 48),
      goal: s.goal,
      rules: get('criteria') ? [get('criteria')] : [],
      data_sources: get('data_sources') ? [get('data_sources')] : [],
      actions: get('actions') ? [get('actions')] : [],
      trigger: { type: /schedule/.test(trig) ? 'schedule' : /event/.test(trig) ? 'event' : /api/.test(trig) ? 'api' : 'manual', description: get('trigger') },
      output: { format: get('output') || 'markdown' },
      constraints: get('constraints') ? get('constraints').split(/;\s*/) : [],
      assumptions: [],
    };
  }

  applyIntent(s, raw) {
    s.intent = normalizeIntent(raw, s.goal);
    s.status = s.settings.objective_confirmation ? 'confirming' : 'confirmed';
    s.intent_confirmed = !s.settings.objective_confirmation;
    s.turns.push({ id: `t${s.turns.length}`, role: 'assistant', kind: 'intent', intent: s.intent, at: nowIso() });
    return null;
  }

  /** Edit the understanding before confirming (the [Edit] button, §29). */
  editIntent(id, patch) {
    const s = this.get(id);
    if (!s.intent) throw new HttpError(409, 'no_intent', 'There is no intent to edit yet.');
    s.intent = normalizeIntent({ ...s.intent, ...(isPlainObject(patch) ? patch : {}) }, s.goal);
    s.intent_confirmed = false;
    if (s.status === 'confirmed' || s.status === 'compiled') s.status = 'confirming';
    s.turns.push({ id: `t${s.turns.length}`, role: 'user', kind: 'intent_edit', at: nowIso() });
    this.save(s);
    return this.envelopeFor(s);
  }

  confirm(id, patch) {
    const s = this.get(id);
    if (!s.intent) throw new HttpError(409, 'no_intent', 'Discovery has not produced an intent yet.');
    if (isPlainObject(patch) && Object.keys(patch).length) s.intent = normalizeIntent({ ...s.intent, ...patch }, s.goal);
    s.intent_confirmed = true;
    s.status = 'confirmed';
    s.turns.push({ id: `t${s.turns.length}`, role: 'user', kind: 'confirm', at: nowIso() });
    this.save(s);
    return this.envelopeFor(s);
  }

  /** Re-open questioning after the intent was shown ("ask me more"). */
  async askMore(id) {
    const s = this.get(id);
    if (s.rounds >= s.settings.max_rounds) throw new HttpError(409, 'max_rounds', 'The maximum number of clarification rounds has been reached. Edit the intent instead.');
    s.status = 'questioning';
    s.intent_confirmed = false;
    await this.nextTurn(s);
    this.save(s);
    return this.envelopeFor(s);
  }

  markCompiled(id, playbookId) {
    const s = this.get(id);
    s.status = 'compiled';
    s.playbook_id = playbookId;
    this.save(s);
  }
}
