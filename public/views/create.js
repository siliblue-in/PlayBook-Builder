// Create Playbook: goal → short dynamic questions → confirmed intent →
// compile (spec §27–§31).
import { api } from '../api.js';
import { h, icon, clear, pageHead, card, button, banner, badge, toast, errorMessage, title } from '../ui.js';
import { tasks, beginTask, probeTask, paintPill, hidePill } from '../bg-tasks.js';

// The generation task itself lives in ../bg-tasks.js: a module-level Map that
// survives sidebar navigation, a localStorage slot that survives a full page
// reload, and a server-side progress job that is probed when both are gone.
// Navigating away NEVER cancels the compile — the server owns the work, the
// corner card shows its live "step X of Y" progress, and reopening this
// screen re-attaches instead of starting a duplicate.

const EXAMPLES = [
  'Monitor customers and flag the ones with low engagement',
  'Every Monday, find sales opportunities with no activity for 14 days and produce a risk report',
  'Triage incoming support tickets by urgency and suggest the right team',
  'Check invoices for possible duplicate payments before they are approved',
];

const SLOT_LABELS = {
  goal: 'Goal',
  subject: 'Subject',
  criteria: 'Rules & criteria',
  data_sources: 'Data sources',
  actions: 'Actions',
  trigger: 'Trigger',
  output: 'Output',
  constraints: 'Constraints',
};

export async function render(el, { params, app }) {
  let env = null;
  let busy = false;
  let error = null;
  let editing = false;
  let genTimer = null;
  let genStart = 0;
  let unmounted = false;
  let watched = null; // background generation task this view is following

  if (params[0]) {
    try {
      env = await api.get(`/api/discovery/${params[0]}`);
    } catch (err) {
      error = err;
    }
    // Re-attach to a generation that is still running in the background —
    // whether it is remembered by this page (sidebar navigation) or only by
    // the server (full page reload / app restart).
    let running = params[0] ? tasks.get(params[0]) : null;
    if (!running) {
      try {
        running = await probeTask(params[0]); // probes GET /api/progress/gen_<session>
      } catch { /* never fatal for rendering */ }
    }
    if (running && !running.settled) {
      running.attached = true;
      hidePill(running);
      busy = 'generate';
      genStart = running.start;
      watch(running);
    } else if (running && running.settled && running.error) {
      error = running.error; // surface a failure that happened while away
    }
  }

  const header = pageHead({ title: 'Create Playbook', subtitle: 'Describe the outcome you want. I will ask a few short questions, confirm my understanding, then compile a detailed, testable playbook — not the final answer.' });
  const stepper = h('div', { class: 'stepper' });
  const body = h('div');
  el.append(header, stepper, body);

  const session = () => (env ? env.data.session : null);
  const stage = () => {
    const s = session();
    if (busy === 'generate') return 'generate';
    if (!s) return 'describe';
    if (s.status === 'questioning') return 'questions';
    if (s.status === 'compiled') return 'done';
    return 'confirm';
  };

  function renderStepper() {
    const order = ['describe', 'questions', 'confirm', 'generate'];
    const labels = { describe: 'Describe', questions: 'Clarify', confirm: 'Confirm', generate: 'Generate' };
    const cur = stage() === 'done' ? 4 : order.indexOf(stage());
    clear(stepper);
    order.forEach((k, i) => {
      if (i) stepper.append(h('span', { class: 'bar' }));
      stepper.append(h('span', { class: `st ${i < cur ? 'done' : i === cur ? 'current' : ''}` }, h('span', { class: 'n' }, i < cur ? '✓' : String(i + 1)), labels[k]));
    });
  }

  function aiMissing() {
    const s = app.aiStatus;
    return !s || !s.configured;
  }

  function errorBanner() {
    if (!error) return null;
    const needsAi = ['ai_not_configured', 'model_not_selected'].includes(error.code);
    return banner('fail', needsAi ? 'AI connection required' : 'Something went wrong', errorMessage(error), needsAi ? [button('Open AI Connections', { size: 'sm', href: '#/connections' })] : []);
  }

  // ------------------------------------------------------------ describe
  function renderDescribe() {
    const ta = h('textarea', { class: 'input', placeholder: 'e.g. Monitor customers and flag the ones that need attention…', 'aria-label': 'What should the playbook do?' });
    const go = button(app.feature('intent_discovery') ? 'Continue' : 'Build intent', { kind: 'primary', ic: 'arrowRight' });
    const s = app.settings;
    const start = async () => {
      const goal = ta.value.trim();
      if (goal.length < 3) {
        ta.focus();
        return;
      }
      busy = true;
      error = null;
      go.disabled = true;
      go.replaceChildren(h('span', { class: 'spinner', style: { borderTopColor: '#fff' } }), 'Thinking…');
      try {
        env = await api.post('/api/discovery/start', { goal });
        history.replaceState(null, '', `#/create/${env.data.session.id}`);
      } catch (err) {
        error = err;
      }
      busy = false;
      renderAll();
      const sess = session();
      if (sess && sess.status === 'confirmed' && !sess.settings.objective_confirmation) generate();
    };
    go.addEventListener('click', start);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) start();
    });
    const disabled = aiMissing();
    if (disabled) go.disabled = true;
    return h(
      'div',
      { class: 'stack' },
      disabled ? banner('warn', 'Connect an AI model first', 'Intent discovery and playbook compilation need a model: Local AI (Ollama) on this computer, or a cloud API key (OpenRouter, NVIDIA, AMD, Google, Groq…). The built-in example works without either.', [button('Connect Local AI', { size: 'sm', kind: 'primary', ic: 'cpu', href: '#/connections/local' }), button('Add a cloud key', { size: 'sm', ic: 'key', href: '#/connections' }), button('Open the example', { size: 'sm', href: '#/playbooks' })]) : null,
      errorBanner(),
      card({
        title: 'What should the AI playbook do?',
        icon: 'target',
        body: h(
          'div',
          { class: 'goal-box' },
          ta,
          h('div', { class: 'row between mt-2' }, h('div', { class: 'example-chips' }, EXAMPLES.map((x) => h('button', { type: 'button', class: 'chip', onClick: () => { ta.value = x; ta.focus(); } }, x))), null),
          h(
            'div',
            { class: 'row between mt-3' },
            h('div', { class: 'small muted' }, s.features.intent_discovery ? `Up to ${s.behavior.max_clarification_rounds} short questions · ${s.behavior.max_questions_per_round === 1 ? 'one at a time' : `${s.behavior.max_questions_per_round} per round`}${s.features.multiple_choice ? ' · multiple choice' : ''} · ` : 'Intent discovery is off · ', h('a', { href: '#/settings' }, 'change')),
            go,
          ),
        ),
      }),
    );
  }

  // ------------------------------------------------------------ questions
  function renderQuestions() {
    const s = session();
    const pending = s.pending_question;
    const thread = h('div', { class: 'thread' });
    for (const t of s.turns) {
      if (t.kind === 'goal') thread.append(h('div', { class: 'bubble user' }, h('div', { class: 'who' }, 'You'), t.text));
      else if (t.kind === 'question') {
        const reply = s.turns.find((u) => u.reply_to === t.id);
        if (!reply) continue;
        for (const q of t.questions) {
          thread.append(h('div', { class: 'bubble ai' }, h('div', { class: 'who' }, 'Playbook Builder'), q.text));
          const a = reply.answers.find((x) => x.question_id === q.id);
          thread.append(h('div', { class: 'bubble user' }, a && !a.skipped ? a.text : h('i', null, 'Skipped')));
        }
      } else if (t.kind === 'note') thread.append(h('div', { class: 'bubble note' }, t.text));
    }
    const answers = {};
    let submit;
    const qCards = (pending ? pending.questions : []).map((q) => {
      const state = (answers[q.id] = { option_ids: [], text: '' });
      const multi = q.input_type === 'multi_choice';
      const opts = [];
      const otherInput = h('input', { class: 'input sm mt-1', placeholder: 'Type your answer…', style: { display: 'none' } });
      const refresh = () => {
        for (const o of opts) o.row.classList.toggle('selected', o.input.checked);
        otherInput.style.display = otherRadio && otherRadio.input.checked ? '' : 'none';
        if (submit) submit.disabled = !Object.values(answers).some((a) => a.option_ids.length || a.text.trim());
      };
      const makeOption = (value, label, desc) => {
        const input = h('input', { type: multi ? 'checkbox' : 'radio', name: q.id, value });
        const row = h('label', { class: 'option' }, input, h('div', null, h('div', { class: 'opt-label' }, label), desc ? h('div', { class: 'opt-desc' }, desc) : null));
        input.addEventListener('change', () => {
          if (value === '__other') {
            if (!multi) state.option_ids = [];
            if (input.checked) setTimeout(() => otherInput.focus());
          } else if (multi) {
            state.option_ids = opts.filter((o) => o.value !== '__other' && o.input.checked).map((o) => o.value);
          } else {
            state.option_ids = [value];
            state.text = '';
            otherInput.value = '';
          }
          refresh();
        });
        const o = { value, input, row };
        opts.push(o);
        return o;
      };
      let otherRadio = null;
      let control;
      if (q.options && q.options.length) {
        const rows = q.options.map((o) => makeOption(o.id, o.label, o.description).row);
        otherRadio = makeOption('__other', 'Something else', 'Describe it in your own words');
        otherInput.addEventListener('input', () => {
          state.text = otherInput.value;
          refresh();
        });
        control = h('div', null, rows, otherRadio.row, otherInput);
      } else {
        const inp = q.input_type === 'number' ? h('input', { class: 'input', type: 'number' }) : h('textarea', { class: 'input', rows: 3, placeholder: 'Your answer…' });
        inp.addEventListener('input', () => {
          state.text = inp.value;
          refresh();
        });
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && submit && !submit.disabled) submit.click();
        });
        control = inp;
      }
      return h('div', { class: 'question-card' }, h('div', { class: 'xsmall muted bold', style: { textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '4px' } }, `Question ${s.rounds + 1} of up to ${s.max_rounds}${q.slot && SLOT_LABELS[q.slot] ? ` · ${SLOT_LABELS[q.slot]}` : ''}`), h('div', { class: 'q-text' }, q.text), control);
    });

    const send = async (payload) => {
      busy = true;
      error = null;
      renderAll();
      try {
        env = await api.post(`/api/discovery/${s.id}/answer`, payload);
      } catch (err) {
        error = err;
      }
      busy = false;
      renderAll();
    };
    submit = button('Continue', { kind: 'primary', ic: 'send', disabled: true, onClick: () => send({ answers: Object.entries(answers).map(([question_id, a]) => ({ question_id, option_ids: a.option_ids, text: a.text })) }) });
    const skip = button('Skip question', { kind: 'ghost', onClick: () => send({ answers: Object.keys(answers).map((question_id) => ({ question_id })) }) });
    const finish = button('That’s enough — summarize', { onClick: () => send({ answers: Object.entries(answers).map(([question_id, a]) => ({ question_id, option_ids: a.option_ids, text: a.text })), finish: true }) });

    const known = h(
      'ul',
      { class: 'list-clean slot-list' },
      Object.entries(SLOT_LABELS).map(([slot, label]) => {
        const v = s.requirement_state && s.requirement_state[slot];
        const has = v && v.value;
        return h('li', { class: has ? 'known' : 'unknown' }, icon(has ? 'circleCheck' : 'pending'), h('div', null, h('div', { class: 'bold small' }, label), has ? h('div', { class: 'small text-2' }, String(v.value).slice(0, 140), v.source && v.source !== 'user' ? h('span', { class: 'muted' }, ` (${v.source})`) : null) : h('div', { class: 'xsmall muted' }, 'Not known yet')));
      }),
    );

    return h(
      'div',
      { class: 'discovery' },
      h(
        'div',
        { class: 'stack' },
        errorBanner(),
        card({ title: 'Clarifying your goal', icon: 'message', body: h('div', { class: 'stack' }, thread, busy ? h('div', { class: 'bubble ai row' }, h('span', { class: 'spinner' }), 'Thinking about what to ask next…') : qCards, !busy && pending ? h('div', { class: 'row between' }, h('div', { class: 'row' }, skip, finish), submit) : null) }),
      ),
      card({ title: 'What I know so far', icon: 'list', hint: `${s.rounds} / ${s.max_rounds} rounds`, body: known }),
    );
  }

  // ------------------------------------------------------------ confirm
  function intentRows(intent) {
    const t = intent.trigger || {};
    const freq = [t.type && t.type !== 'manual' ? title(t.type) : 'Manual', t.frequency, t.day, t.time].filter(Boolean).join(' · ');
    const rows = [
      ['Goal', intent.goal],
      ['Rule', intent.rules.length > 1 ? h('ul', { class: 'bullets', style: { margin: 0 } }, intent.rules.map((r) => h('li', null, r))) : intent.rules[0]],
      ['Data', intent.data_sources.join(', ')],
      ['Action', intent.actions.join('; ')],
      ['Frequency', freq + (t.description ? ` — ${t.description}` : '')],
      ['Output', [/^(json|csv|pdf|html|xml|md|api)$/i.test(intent.output.format || '') ? String(intent.output.format).toUpperCase() : title(intent.output.format), intent.output.description, intent.output.destination].filter(Boolean).join(' — ')],
      ['Constraints', intent.constraints.join('; ')],
      intent.tools && intent.tools.length ? ['Tools', intent.tools.join(', ')] : null,
      intent.success_criteria && intent.success_criteria.length ? ['Success', intent.success_criteria.join('; ')] : null,
    ].filter((r) => r && r[1] && (typeof r[1] !== 'string' || r[1].trim()));
    return h('dl', { class: 'intent-card' }, rows.map(([k, v]) => h('div', { class: 'intent-row' }, h('dt', null, k), h('dd', null, v))));
  }

  function renderEdit(intent) {
    const f = {};
    const area = (key, label, value, help) => {
      f[key] = h('textarea', { class: 'input', rows: 3 });
      f[key].value = value;
      return h('div', { class: 'field' }, h('label', null, label), f[key], help ? h('div', { class: 'help' }, help) : null);
    };
    const t = intent.trigger || {};
    f.trigger_type = h('select', { class: 'input' }, ['manual', 'schedule', 'webhook', 'event', 'api', 'user_request'].map((x) => h('option', { value: x, selected: x === t.type }, title(x))));
    f.frequency = h('input', { class: 'input', value: t.frequency || '', placeholder: 'weekly' });
    f.day = h('input', { class: 'input', value: t.day || '', placeholder: 'monday' });
    f.time = h('input', { class: 'input', value: t.time || '', placeholder: '09:00' });
    f.out_format = h('input', { class: 'input', value: intent.output.format || '' });
    const lines = (v) => v.split('\n').map((x) => x.trim()).filter(Boolean);
    const save = button('Save changes', {
      kind: 'primary',
      ic: 'check',
      onClick: async () => {
        const patch = {
          goal: f.goal.value.trim(),
          rules: lines(f.rules.value),
          data_sources: lines(f.data.value),
          actions: lines(f.actions.value),
          constraints: lines(f.constraints.value),
          assumptions: lines(f.assumptions.value),
          trigger: { type: f.trigger_type.value, frequency: f.frequency.value, day: f.day.value, time: f.time.value, description: t.description || '' },
          output: { ...intent.output, format: f.out_format.value, description: f.out_desc.value },
        };
        try {
          env = await api.post(`/api/discovery/${session().id}/intent`, { intent: patch });
          editing = false;
          toast('Understanding updated');
        } catch (err) {
          error = err;
        }
        renderAll();
      },
    });
    return h(
      'div',
      null,
      area('goal', 'Goal', intent.goal),
      area('rules', 'Rules (one per line)', intent.rules.join('\n'), 'Make each rule explicit and testable, e.g. "No activity for 14 or more days = at risk".'),
      area('data', 'Data sources (one per line)', intent.data_sources.join('\n')),
      area('actions', 'Actions (one per line)', intent.actions.join('\n')),
      h('div', { class: 'field' }, h('label', null, 'Trigger'), h('div', { class: 'inline-fields' }, h('div', { class: 'field', style: { flex: 1 } }, f.trigger_type), h('div', { class: 'field', style: { flex: 1 } }, f.frequency), h('div', { class: 'field', style: { flex: 1 } }, f.day), h('div', { class: 'field', style: { flex: 1 } }, f.time))),
      h('div', { class: 'field' }, h('label', null, 'Output'), h('div', { class: 'inline-fields' }, h('div', { class: 'field', style: { width: '160px' } }, f.out_format), h('div', { class: 'field', style: { flex: 1 } }, (f.out_desc = h('input', { class: 'input', value: intent.output.description || '', placeholder: 'What the result contains' }))))),
      area('constraints', 'Constraints (one per line)', intent.constraints.join('\n')),
      area('assumptions', 'Assumptions (one per line)', intent.assumptions.join('\n')),
      h('div', { class: 'row mt-3' }, save, button('Cancel', { kind: 'ghost', onClick: () => { editing = false; renderAll(); } })),
    );
  }

  function renderConfirm() {
    const s = session();
    const intent = s.intent;
    if (!intent) return banner('warn', 'No intent yet', 'Discovery did not produce an understanding.');
    const showAssumptions = s.settings.show_assumptions && intent.assumptions.length;
    const gen = button('Generate Playbook', { kind: 'primary', ic: 'sparkles', disabled: !app.feature('playbook_generation'), onClick: generate });
    return h(
      'div',
      { class: 'grid sidebar-right' },
      h(
        'div',
        { class: 'stack' },
        errorBanner(),
        card({
          title: editing ? 'Edit my understanding' : 'Here’s what I understand',
          icon: 'target',
          hint: s.intent_confirmed ? 'Confirmed' : 'Please review',
          body: editing
            ? renderEdit(intent)
            : h(
                'div',
                null,
                h('div', { class: 'bold', style: { fontSize: '18px', marginBottom: '8px' } }, intent.title),
                intentRows(intent),
                showAssumptions ? h('div', { class: 'mt-3' }, h('div', { class: 'section-label' }, 'Assumptions I made'), h('ul', { class: 'bullets small text-2' }, intent.assumptions.map((a) => h('li', null, a)))) : null,
                h(
                  'div',
                  { class: 'row mt-3' },
                  gen,
                  button('Edit', { ic: 'edit', onClick: () => { editing = true; renderAll(); } }),
                  s.rounds < s.max_rounds ? button('Ask me more questions', { kind: 'ghost', onClick: askMore }) : null,
                ),
                app.feature('playbook_generation') ? null : h('div', { class: 'small muted mt-1' }, 'Playbook Generation is turned off in Settings.'),
              ),
        }),
      ),
      card({
        title: 'What happens next',
        icon: 'info',
        body: h(
          'ol',
          { class: 'numbers small text-2' },
          h('li', null, 'The compiler writes the procedure — steps, rules, tools, validation — not the final answer.'),
          h('li', null, 'A quality gate checks every step is explicit and the workflow has no cycles.'),
          h('li', null, 'Test cases are generated from your rules.'),
          h('li', null, 'You review, test and publish before anything runs.'),
        ),
      }),
    );
  }

  async function askMore() {
    busy = true;
    renderAll();
    try {
      env = await api.post(`/api/discovery/${session().id}/more`);
    } catch (err) {
      error = err;
    }
    busy = false;
    renderAll();
  }

  async function watch(task) {
    watched = task;
    task.promise.then(
      (res) => {
        if (unmounted) return; // the module-level handler shows the corner card + toast
        hidePill(task);
        clearInterval(genTimer);
        busy = false;
        toast(`Playbook generated${res.data.tests_generated ? ` · ${res.data.tests_generated} tests created` : ''}`);
        app.navigate(`/playbooks/${res.data.id}`);
      },
      async (err) => {
        if (unmounted) return;
        // A 409 "already running" means another window (or a pre-reload page)
        // started this exact compile — follow it instead of failing.
        if (err && (err.code === 'already_running' || /already being generated/i.test(String(err.message || '')))) {
          try {
            const live = await probeTask(task.sessionId);
            if (live && !live.settled) {
              live.attached = true;
              hidePill(live);
              busy = 'generate';
              genStart = live.start;
              renderAll();
              watch(live);
              return;
            }
          } catch { /* fall through to the error banner */ }
        }
        clearInterval(genTimer);
        busy = false;
        error = err;
        try {
          env = await api.get(`/api/discovery/${task.sessionId}`);
        } catch { /* keep */ }
        renderAll();
      },
    );
  }
  async function generate() {
    const s = session();
    if (!s) return;
    error = null;
    const existing = tasks.get(s.id);
    if (existing && !existing.settled) {
      // A compile for this session is already in flight — never start a duplicate.
      existing.attached = true;
      hidePill(existing);
      busy = 'generate';
      genStart = existing.start;
      renderAll();
      watch(existing);
      return;
    }
    if (existing && existing.settled && existing.result && existing.result.data && existing.result.data.id) {
      // It already finished (e.g. while the user was on another page) — open it.
      hidePill(existing);
      toast('This request was already compiled');
      app.navigate(`/playbooks/${existing.result.data.id}`);
      return;
    }
    if (existing && existing.settled) hidePill(existing); // clear a stale failed card
    // The compile may also be running server-side without this page knowing
    // (page reload, second window). Probe the progress registry FIRST so the
    // local model never gets two pipelines queued at once.
    busy = 'generate';
    genStart = Date.now();
    renderAll();
    try {
      const live = await probeTask(s.id);
      if (live && !live.settled) {
        live.attached = true;
        hidePill(live);
        genStart = live.start;
        renderAll();
        watch(live);
        return;
      }
    } catch { /* probe failure must not block a legitimate generate */ }
    const task = beginTask(s);
    task.attached = true;
    watch(task);
  }

  function renderGenerating() {
    const fallbackStages = ['Compiling the procedure from your confirmed intent', 'Validating structure, dependencies and decision rules', 'Running the quality gate (and repairing gaps)', 'Generating test cases'];
    const list = h('ul', { class: 'list-clean gen-stages' });
    // Build the stage rows once per step set and update them in place: recreating
    // the active row every second restarted the spinner's CSS animation and looked
    // choppy. Rows show real server progress ("2 of 4 · attempt 2 of 3") whenever
    // a snapshot from /api/progress is available; the timed estimate below is only
    // a fallback while the first poll is in flight.
    let rows = [];
    let rowIds = '';
    let lastStatuses = '';
    const buildRows = (steps) => {
      clear(list);
      rows = steps.map((s, i) => {
        const ic = h('span', { class: 'gen-ic' });
        const num = h('span', { class: 'gen-num' }, `${i + 1} of ${steps.length}`);
        const det = h('div', { class: 'gen-det small muted' });
        const li = h('li', { class: 'gen-row' }, ic, h('div', { class: 'gen-main' }, h('div', { class: 'gen-top' }, h('span', { class: 'gen-label' }, s.label), num), det));
        list.append(li);
        return { li, ic, det, num, id: s.id };
      });
      rowIds = steps.map((s) => s.id).join('|');
      lastStatuses = '';
    };
    const paintReal = (steps) => {
      if (steps.map((s) => s.id).join('|') !== rowIds) buildRows(steps);
      const statuses = steps.map((s) => s.status).join('|');
      if (statuses !== lastStatuses) {
        lastStatuses = statuses;
        rows.forEach((row, i) => {
          const st = steps[i].status;
          row.li.classList.toggle('done', st === 'done');
          row.li.classList.toggle('active', st === 'active');
          row.li.classList.toggle('failed', st === 'failed');
          clear(row.ic);
          row.ic.append(st === 'done' ? icon('check') : st === 'active' ? h('span', { class: 'spinner', style: { width: '16px', height: '16px' } }) : st === 'failed' ? icon('circleX') : icon('pending'));
        });
      }
      rows.forEach((row, i) => {
        const s = steps[i];
        row.num.textContent = `${i + 1} of ${steps.length}`;
        const det = s.detail || '';
        if (row.det.textContent !== det) row.det.textContent = det;
        row.det.classList.toggle('show', Boolean(det));
      });
    };
    const clock = h('span', { class: 'small muted' });
    const paint = () => {
      const secs = Math.floor((Date.now() - genStart) / 1000);
      clock.textContent = `${secs}s`;
      const p = watched && watched.progress && Array.isArray(watched.progress.steps) && watched.progress.steps.length ? watched.progress : null;
      if (p) paintReal(p.steps);
      else {
        const at = Math.min(fallbackStages.length - 1, Math.floor(secs / 12));
        paintReal(fallbackStages.map((label, i) => ({ id: `fb_${i}`, label, status: i < at ? 'done' : i === at ? 'active' : 'pending', detail: null })));
      }
    };
    paint();
    clearInterval(genTimer);
    genTimer = setInterval(paint, 1000);
    return card({
      title: 'Generating your playbook',
      icon: 'sparkles',
      actions: [clock],
      body: h(
        'div',
        null,
        list,
        h('div', { class: 'small muted mt-2' }, 'Each step shows its live progress ("1 of 4"). Large models can take a minute or two per step — you can freely visit other pages, the generation keeps running and this page picks it up again when you come back.'),
      ),
    });
  }

  function renderDone() {
    const s = session();
    return banner('pass', 'This request was already compiled', 'Open the playbook to review, test and publish it.', [button('Open playbook', { kind: 'primary', size: 'sm', href: `#/playbooks/${s.playbook_id}` }), button('Start a new one', { size: 'sm', onClick: () => { env = null; history.replaceState(null, '', '#/create'); renderAll(); } })]);
  }

  function renderAll() {
    renderStepper();
    clear(body);
    const st = stage();
    if (st === 'describe') body.append(renderDescribe());
    else if (st === 'questions') body.append(renderQuestions());
    else if (st === 'confirm') body.append(renderConfirm());
    else if (st === 'generate') body.append(renderGenerating());
    else body.append(renderDone());
  }

  renderAll();
  // If confirmation is disabled, compile straight away.
  const s = session();
  if (s && s.status === 'confirmed' && !s.settings.objective_confirmation && !s.playbook_id) generate();

  return () => {
    unmounted = true;
    clearInterval(genTimer);
    // Keep the generation alive in the background and make it visible:
    // the corner pill shows progress while this screen is not mounted.
    if (watched && !watched.settled) {
      watched.attached = false;
      paintPill(watched, 'running');
    }
  };
}
