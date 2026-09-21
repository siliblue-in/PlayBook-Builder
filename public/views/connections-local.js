// Local AI connection page (feature spec v2 §2, §7–§13, §23):
// Provider → Server URL → Detect Models → Select Model → Test → Save → Use.
// The compact setup box stays visible the whole way.
import { api, poll } from '../api.js';
import { h, append, icon, clear, pageHead, card, button, badge, banner, toast, errorMessage, confirmDialog, pct, duration } from '../ui.js';
import { setupCard, connectedCard, troubleCard, noModelsCard, capabilityCard, checkList, modelPicker, detailedInstructions } from '../components/local-setup.js';

const ROLE_HELP = {
  clarification: 'Intent discovery questions.',
  generation: 'Compiles the playbook JSON — the hardest job for a small model.',
  execution: 'Runs playbooks in AI Execution mode.',
  testing: 'AI-mode test runs and AI-written test cases.',
  evaluation: 'Scores task alignment and suggests repairs.',
};

// Endpoint / reasoning wording from the implementation spec §10: the UI must
// show HOW a model is being talked to, not just that it answered.
const ENDPOINT_LABELS = {
  native_ollama_chat: 'Native Ollama Chat',
  openai_compatible: 'OpenAI-Compatible Chat',
};
const VERDICT_BADGE = { compatible: 'pass', compatible_with_limitations: 'warning', incompatible: 'fail' };

// PC Performance Tier copy shown next to the selector (from /api/meta.tiers).
const TIER_FALLBACK = {
  low: { label: 'Low-Tier PC', test_cases: 4 },
  medium: { label: 'Mid-Range PC', test_cases: 8 },
  high: { label: 'High-End PC', test_cases: 16 },
};

function tierMeta(app, id) {
  const list = (app.meta && app.meta.tiers) || [];
  return list.find((t) => t.id === id) || TIER_FALLBACK[id] || null;
}

function endpointLine(mode, reasoning) {
  if (!mode) return null;
  const label = ENDPOINT_LABELS[mode] || mode;
  const parts = ['Endpoint: ' + label];
  if (reasoning) parts.push('Reasoning: ' + (reasoning === 'off' ? 'Off' : reasoning));
  return h('div', { class: 'xsmall muted mt-1' }, parts.join(' \u00b7 '));
}

export async function render(el, { query, app }) {
  const meta = app.meta;
  const locals = (meta.providers || []).filter((p) => p.type === 'local');
  if (!locals.length) {
    el.append(banner('warn', 'No local providers are available', 'This build has no local AI adapters registered.'));
    return;
  }
  const data = await api.get('/api/connections');
  const roleDefs = data.roles;

  // Without an explicit id, continue with the local connection that already
  // exists instead of silently creating a second one.
  const existing = query.id
    ? data.connections.find((c) => c.id === query.id) || null
    : data.connections.find((c) => c.is_local && c.provider === query.provider) || data.connections.find((c) => c.is_local) || null;

  const st = {
    provider: locals.find((p) => p.id === query.provider) || locals[0],
    conn: existing,
    baseUrl: '',
    auth: 'none',
    token: '',
    ctx: '',
    tier: '',
    models: [],
    model: null,
    roles: {},
    detecting: false,
    detectError: null,
    noModels: false,
    testing: false,
    testResult: null,
    caps: null,
    capsError: null,
    compat: null,
    compatBusy: false,
    saving: false,
    instructionsOpen: false,
    builtin: null,
    builtinRuns: (app.settings.behavior && app.settings.behavior.default_repeatability_runs) || 20,
    builtinBusy: false,
  };
  if (st.conn) {
    st.provider = locals.find((p) => p.id === st.conn.provider) || st.provider;
    st.baseUrl = st.conn.base_url;
    st.auth = (st.conn.authentication && st.conn.authentication.type) || 'none';
    st.model = st.conn.default_model || (st.conn.models && st.conn.models.generation) || null;
    st.roles = { ...(st.conn.models || {}) };
    st.ctx = st.conn.context_window ? String(st.conn.context_window) : '';
    st.tier = st.conn.tier || '';
  } else {
    st.baseUrl = st.provider.defaults.base_url;
  }

  let stopPoll = null;
  const body = h('div');
  el.append(
    pageHead({
      title: 'Connect Local AI',
      crumbs: h('div', { class: 'crumbs' }, h('a', { href: '#/connections' }, 'AI Connections'), icon('chevronRight'), h('span', null, 'Local AI')),
      subtitle: 'Run models on this computer. Nothing leaves the machine, there is no API key and there are no usage costs.',
      badges: [badge('', 'Local AI', 'accent')],
    }),
    body,
  );

  const draftPayload = (extra = {}) => ({
    provider: st.provider.id,
    base_url: st.baseUrl,
    authentication: { type: st.auth },
    api_key: st.auth === 'bearer' ? st.token : undefined,
    // Ollama context window (num_ctx) — applied by draft test/compat runs too.
    context_window: st.ctx !== '' ? Number(st.ctx) : undefined,
    // PC Performance Tier: caps the AI test-suite size on this hardware.
    tier: st.tier || undefined,
    ...extra,
  });

  // True when the form no longer matches the saved connection (edited URL,
  // authentication or token). In that state the saved-connection endpoints
  // would silently probe the OLD address, so the draft endpoints are used
  // until the change is saved.
  const normUrl = (u) => String(u || '').trim().replace(/\/+$/, '');
  function draftDirty() {
    if (!st.conn) return false;
    if (normUrl(st.baseUrl) !== normUrl(st.conn.base_url)) return true;
    if (st.auth !== ((st.conn.authentication && st.conn.authentication.type) || 'none')) return true;
    if (st.auth === 'bearer' && st.token) return true;
    if ((st.ctx === '' ? null : Number(st.ctx)) !== (st.conn.context_window || null)) return true;
    if ((st.tier || null) !== (st.conn.tier || null)) return true;
    return false;
  }

  async function detect() {
    st.detecting = true;
    st.detectError = null;
    paint();
    try {
      // Probe the address the form shows — saved connection or draft.
      const useDraft = !st.conn || draftDirty();
      const r = useDraft ? await api.post('/api/connections/detect', draftPayload()).then((x) => ({ models: x.models })) : await api.get(`/api/connections/${st.conn.id}/models?refresh=1`).then((x) => ({ models: x.models }));
      st.models = r.models || [];
      st.noModels = st.models.length === 0;
      if (st.models.length && !st.models.find((m) => m.id === st.model)) st.model = st.models[0].id;
      if (st.models.length) loadCapabilities();
      else {
        st.caps = null;
        toast(`${st.provider.label} answered, but no models are installed`, 'error');
      }
    } catch (err) {
      st.models = [];
      st.noModels = false;
      st.detectError = errorMessage(err);
    }
    st.detecting = false;
    paint();
  }

  async function loadCapabilities() {
    st.caps = null;
    st.capsError = null;
    const model = st.model;
    try {
      const useDraft = !st.conn || draftDirty();
      const r = useDraft ? await api.post('/api/connections/capabilities', draftPayload({ model })) : await api.get(`/api/connections/${st.conn.id}/capabilities?model=${encodeURIComponent(model)}`);
      if (st.model === model) st.caps = r;
    } catch (err) {
      st.capsError = errorMessage(err);
    }
    paint();
  }

  async function testConnection() {
    if (!st.model) {
      toast('Select a model first', 'error');
      return;
    }
    st.testing = true;
    st.testResult = null;
    paint();
    try {
      if (st.conn && !draftDirty()) {
        const c = await api.post(`/api/connections/${st.conn.id}/test`, { model: st.model });
        st.conn = c;
        st.testResult = { ok: c.state === 'connected', checks: c.checks || [], error: c.last_error ? { message: c.last_error, code: c.last_error_code } : null, endpoint_mode: c.last_endpoint_mode, reasoning_mode: c.last_reasoning_mode };
      } else {
        st.testResult = await api.post('/api/connections/test', draftPayload({ model: st.model }));
      }
      toast(st.testResult.ok ? 'Connection successful' : 'The test did not pass', st.testResult.ok ? 'ok' : 'error');
      await app.refreshStatus();
    } catch (err) {
      st.testResult = { ok: false, checks: [], error: { message: errorMessage(err) } };
    }
    st.testing = false;
    paint();
  }

  // Model Compatibility Harness (impl spec §10): a separate, explicit action —
  // connected only means the server answers; this proves the model can
  // produce the JSON playbooks are built from.
  async function runCompat() {
    if (!st.model) {
      toast('Select a model first', 'error');
      return;
    }
    st.compatBusy = true;
    st.compat = null;
    paint();
    try {
      const useDraft = !st.conn || draftDirty();
      st.compat = useDraft
        ? await api.post('/api/connections/compat', draftPayload({ model: st.model }))
        : await api.get(`/api/connections/${st.conn.id}/compat?model=${encodeURIComponent(st.model)}&refresh=1`);
    } catch (err) {
      st.compat = { verdict: 'incompatible', verdict_label: 'Test failed', checks: [], reasons: [errorMessage(err)] };
    }
    st.compatBusy = false;
    paint();
  }

  async function save({ silent = false } = {}) {
    st.saving = true;
    paint();
    try {
      const models = {};
      for (const r of roleDefs) models[r.id] = st.roles[r.id] || st.model || null;
      const isNew = !st.conn;
      if (st.conn) {
        st.conn = await api.put(`/api/connections/${st.conn.id}`, { base_url: st.baseUrl, authentication: { type: st.auth }, default_model: st.model, models, context_window: st.ctx === '' ? null : Number(st.ctx), tier: st.tier || null, ...(st.auth === 'bearer' && st.token ? { api_key: st.token } : {}) });
      } else {
        st.conn = await api.post('/api/connections', draftPayload({ name: `${st.provider.label} (local)`, default_model: st.model, models }));
      }
      // Confirm the saved connection really works, so the status is not a guess.
      try {
        st.conn = await api.post(`/api/connections/${st.conn.id}/test`, { model: st.model });
        st.testResult = { ok: st.conn.state === 'connected', checks: st.conn.checks || [], error: st.conn.last_error ? { message: st.conn.last_error, code: st.conn.last_error_code } : null };
      } catch { /* the card shows the untested state */ }
      st.roles = { ...(st.conn.models || {}) };
      await app.refreshStatus();
      if (!silent) toast(st.conn.state === 'connected' ? 'Local AI saved and connected' : 'Saved — the connection test did not pass');
      if (isNew) {
        location.hash = `#/connections/local?provider=${st.provider.id}&id=${st.conn.id}`;
        return;
      }
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
    st.saving = false;
    paint();
  }

  async function disconnect() {
    if (!st.conn) return;
    const ok = await confirmDialog({ title: `Disconnect ${st.conn.name}?`, text: 'The connection is removed from Playbook Builder. Nothing is uninstalled and no model is deleted.', confirm: 'Disconnect', danger: true });
    if (!ok) return;
    await api.del(`/api/connections/${st.conn.id}`);
    await app.refreshStatus();
    toast('Disconnected');
    app.navigate('/connections');
  }

  // --------------------------------------------- built-in test (§12–13)
  async function runBuiltin(runs) {
    if (!st.conn) {
      toast('Save the connection first', 'error');
      return;
    }
    st.builtinBusy = true;
    st.builtin = null;
    paint();
    try {
      const r = await api.post(`/api/connections/${st.conn.id}/builtin-test`, { runs, model: st.model });
      const id = r.data.test_run.id;
      st.builtin = r.data.test_run;
      paint();
      if (stopPoll) stopPoll();
      stopPoll = poll(() => api.get(`/api/test-runs/${id}`), {
        onUpdate: (x) => {
          st.builtin = x.data.test_run;
          paint();
        },
        done: (x) => x.data.test_run.status !== 'running',
        onError: () => {
          st.builtinBusy = false;
          paint();
        },
      });
    } catch (err) {
      toast(errorMessage(err), 'error');
      st.builtinBusy = false;
      paint();
    }
    if (st.builtin && st.builtin.status !== 'running') st.builtinBusy = false;
  }

  function builtinCard() {
    if (!st.conn || st.conn.state !== 'connected') return null;
    const run = st.builtin;
    if (run && run.status !== 'running') st.builtinBusy = false;
    const runsInput = h('input', { class: 'input sm', type: 'number', min: '1', max: '100', value: String(st.builtinRuns), style: { width: '90px' } });
    runsInput.addEventListener('change', () => {
      st.builtinRuns = Math.max(1, Math.min(100, Number(runsInput.value) || 20));
    });
    const sameList = h('ul', { class: 'check-list xsmall' }, ['Same input', 'Same playbook version', 'Same model', 'Same configuration'].map((t) => h('li', null, icon('check'), t)));
    // The five measurements from spec v2 §13, for this test only — a whole-suite
    // status would be dominated by coverage of tests we did not run here.
    const tile = (label, value, status) => h('div', { class: `metric ${status || ''}` }, h('div', { class: 'metric-label' }, label), h('div', { class: 'metric-value' }, value === null || value === undefined ? h('span', { class: 'muted', style: { fontSize: '15px' } }, 'n/a') : value));
    const m = run && run.metrics ? run.metrics.metrics : null;
    const first = run && run.results && run.results[0];
    const lat = run && run.metrics ? run.metrics.latency : null;
    const grade = (v) => (typeof v !== 'number' ? '' : v >= 1 ? 'pass' : v >= 0.9 ? 'warning' : 'fail');
    const result = run
      ? h(
          'div',
          { class: 'mt-2' },
          h(
            'div',
            { class: 'row between' },
            h('div', { class: 'bold small' }, run.status === 'running' ? `Running ${run.progress.done} / ${run.progress.total}…` : `${run.progress.total} run${run.progress.total === 1 ? '' : 's'} · ${duration(run.duration_ms)}`),
            first && first.status ? badge(first.status === 'pass' ? 'pass' : first.status === 'warning' ? 'warning' : first.status === 'skipped' ? 'untested' : 'fail', first.status.toUpperCase()) : run.status === 'running' ? badge('running', 'Running') : null,
          ),
          m
            ? h(
                'div',
                { class: 'metrics' },
                tile('Accuracy', pct(m.accuracy, m.accuracy < 1 ? 1 : 0), grade(m.accuracy)),
                tile('Decision Agreement', first && first.agreement !== null && first.agreement !== undefined ? pct(first.agreement, first.agreement < 1 ? 1 : 0) : pct(m.consistency, 0), grade(first && first.agreement !== null ? first.agreement : m.consistency)),
                tile('Rule Adherence', m.rule_adherence === null ? null : pct(m.rule_adherence, 0), grade(m.rule_adherence)),
                tile('Required Fields', m.output_compliance === null ? null : pct(m.output_compliance, 0), grade(m.output_compliance)),
                tile('Latency', lat ? `${lat.avg_ms} ms` : null, ''),
              )
            : null,
          lat ? h('div', { class: 'small mt-1' }, 'Latency: ', h('b', null, `${lat.avg_ms} ms`), ' average · ', `${lat.min_ms}–${lat.max_ms} ms`, lat.runs > 2 ? ` · p95 ${lat.p95_ms} ms` : '') : null,
          first && first.distinct_outcomes && first.distinct_outcomes.length > 1 ? h('div', { class: 'small mt-1', style: { color: 'var(--warn)' } }, `${first.distinct_outcomes.length} different outcomes across the runs — this model is not deterministic on this input.`) : null,
          first && first.diagnosis && first.diagnosis.length ? h('div', { class: 'small mt-1' }, first.diagnosis.join(' ')) : null,
          run.error ? h('div', { class: 'small', style: { color: 'var(--fail)' } }, run.error.message) : null,
          run.id && run.status !== 'running' ? h('div', { class: 'mt-1' }, button('Open full results', { size: 'sm', ic: 'flask', href: `#/test-runs/${run.id}` })) : null,
        )
      : null;
    return card({
      title: 'Test with the built-in playbook',
      icon: 'flask',
      hint: 'Customer Risk Evaluator',
      body: h(
        'div',
        null,
        h('div', { class: 'small text-2' }, 'Your local model is ready. Run the built-in Customer Risk Evaluator against it: Acme Corp, 21 days since activity, expected decision ', h('code', { class: 'inline' }, 'at_risk'), '.'),
        h('div', { class: 'row mt-2 wrap' }, button(st.builtinBusy ? 'Running…' : 'Run Built-in Test', { kind: 'primary', ic: 'play', disabled: st.builtinBusy, onClick: () => runBuiltin(1) }), h('span', { class: 'spacer' }), h('span', { class: 'xsmall muted' }, 'Runs'), runsInput, button(st.builtinBusy ? 'Running…' : 'Repeat Test', { ic: 'refresh', disabled: st.builtinBusy, onClick: () => runBuiltin(st.builtinRuns) })),
        h('div', { class: 'mt-1' }, sameList),
        result,
      ),
    });
  }

  // --------------------------------------------- form
  function formCard() {
    const providerSel = h('select', { class: 'input' }, locals.map((p) => h('option', { value: p.id }, p.label)));
    providerSel.value = st.provider.id;
    providerSel.disabled = Boolean(st.conn);
    providerSel.addEventListener('change', () => {
      st.provider = locals.find((p) => p.id === providerSel.value) || st.provider;
      st.baseUrl = st.provider.defaults.base_url;
      st.models = [];
      st.model = null;
      st.caps = null;
      st.testResult = null;
      st.compat = null;
      paint();
    });

    const urlInput = h('input', { class: 'input', value: st.baseUrl, spellcheck: 'false', placeholder: st.provider.defaults.base_url });
    urlInput.addEventListener('change', () => {
      st.baseUrl = urlInput.value.trim() || st.provider.defaults.base_url;
      st.models = [];
      st.caps = null;
      st.testResult = null;
      st.compat = null;
      paint();
    });

    const authSel = h('select', { class: 'input' }, h('option', { value: 'none' }, 'None / Local'), h('option', { value: 'bearer' }, 'Bearer token'));
    authSel.value = st.auth;
    authSel.addEventListener('change', () => {
      st.auth = authSel.value;
      paint();
    });
    const tokenInput = h('input', { class: 'input', type: 'password', value: st.token, placeholder: 'Token for a server that requires one', autocomplete: 'off' });
    tokenInput.addEventListener('change', () => {
      st.token = tokenInput.value.trim();
    });

    // Ollama context window (num_ctx): Ollama defaults to a small window and
    // silently truncates longer prompts, which shows up later as broken
    // playbooks. The override rides to the server on the connection.
    const ctxField = () => {
      if (st.provider.id !== 'ollama') return null;
      const input = h('input', { class: 'input sm', type: 'number', min: '512', step: '512', value: st.ctx, placeholder: 'Model default', style: { maxWidth: '180px' }, 'aria-label': 'Context window in tokens' });
      input.addEventListener('change', () => {
        const n = Math.floor(Number(input.value));
        st.ctx = input.value.trim() === '' || !Number.isFinite(n) || n <= 0 ? '' : String(n);
        input.value = st.ctx;
      });
      const modelDefault = st.caps && st.caps.context_length ? ` This model reports ${st.caps.context_length.toLocaleString('en-US')} tokens by default.` : '';
      return h('div', { class: 'field' }, h('label', null, 'Context window (num_ctx)'), input, h('div', { class: 'help' }, `Ollama truncates prompts to a small default window (often 2048–4096 tokens) and long playbook prompts then fail invisibly. Set the window to use, e.g. 8192 or 16384 — larger windows need more memory. Picking a PC Performance Tier fills in its recommended value; you can still adjust it.${modelDefault} Sent as num_ctx on Ollama's native endpoint.`));
    };

    // PC Performance Tier (Low / Mid / High-End): tells Playbook Builder what
    // this computer can take. It fills in a safe context window, caps how
    // many AI test cases one generation writes, and documents the hardware
    // requirements and trade-offs so a weak PC is never handed a marathon.
    const tierField = () => {
      const sel = h(
        'select',
        { class: 'input sm', style: { maxWidth: '240px' }, 'aria-label': 'PC performance tier' },
        h('option', { value: '' }, 'Custom — I set the limits myself'),
        ['low', 'medium', 'high'].map((id) => {
          const t = tierMeta(app, id) || TIER_FALLBACK[id];
          return h('option', { value: id }, `${t.label} — up to ${t.test_cases} test cases`);
        }),
      );
      sel.value = st.tier || '';
      sel.addEventListener('change', () => {
        st.tier = sel.value || '';
        // Fill in the tier's recommended context window (editable afterwards).
        if (st.tier && st.provider.id === 'ollama') {
          const t = tierMeta(app, st.tier);
          if (t && t.context_window) st.ctx = String(t.context_window);
        }
        paint();
      });
      const info = () => {
        if (!st.tier) return null;
        const t = tierMeta(app, st.tier) || TIER_FALLBACK[st.tier];
        if (!t || !t.requirements) {
          return h('div', { class: 'small muted mt-1' }, `${t ? t.label : st.tier}: AI test generations are capped at ${t ? t.test_cases : 8} test cases.`);
        }
        return h(
          'div',
          { class: 'tier-info small mt-1' },
          h('div', { class: 'bold' }, `${t.label} — what this tier needs`),
          h('ul', { class: 'bullets xsmall mt-1' }, [
            ['GPU / VRAM', t.requirements.gpu],
            ['Memory', t.requirements.ram],
            ['Model size', t.requirements.model],
            ['Disk', t.requirements.disk],
          ].filter(([, v]) => v).map(([k, v]) => h('li', null, h('b', null, `${k}: `), v))),
          t.expect ? h('div', { class: 'xsmall mt-1' }, h('b', null, 'What to expect: '), t.expect) : null,
          t.tradeoffs ? h('div', { class: 'xsmall mt-1' }, h('b', null, 'Trade-offs: '), t.tradeoffs) : null,
          t.tips ? h('div', { class: 'xsmall muted mt-1' }, t.tips) : null,
        );
      };
      return h('div', { class: 'field' }, h('label', null, 'PC performance tier'), sel, h('div', { class: 'help' }, 'How strong is the computer running the model? The tier sets a safe context window and caps the AI test suite (Low 4 · Mid 8 · High-End 16 test cases) so generation finishes instead of timing out. Pick Custom to control everything yourself.'), info());
    };

    return card({
      title: st.conn ? 'Connection' : 'Connect Local AI',
      icon: 'plug',
      body: h(
        'div',
        null,
        h('div', { class: 'field' }, h('label', null, 'Provider'), providerSel, h('div', { class: 'help' }, st.provider.description)),
        h('div', { class: 'field' }, h('label', null, 'Server URL'), urlInput, h('div', { class: 'help' }, `The address ${st.provider.label} listens on. Default: ${st.provider.defaults.base_url}`)),
        h('div', { class: 'field' }, h('label', null, 'Authentication'), authSel, st.auth === 'bearer' ? tokenInput : null, h('div', { class: 'help' }, 'Local servers normally need no key. Use a bearer token only if your server is protected.')),
        tierField(),
        ctxField(),
        h('div', { class: 'row' }, button(st.detecting ? 'Detecting models…' : 'Detect Models', { kind: 'primary', ic: 'search', disabled: st.detecting, onClick: detect }), st.models.length ? h('span', { class: 'small muted' }, `${st.models.length} model${st.models.length === 1 ? '' : 's'} found`) : null),
      ),
    });
  }

  function modelsCard() {
    if (!st.models.length) return null;
    const roleRows = roleDefs.map((r) => {
      const sel = h('select', { class: 'input sm' }, st.models.map((m) => h('option', { value: m.id }, m.name)));
      sel.value = st.roles[r.id] || st.model || st.models[0].id;
      sel.addEventListener('change', () => {
        st.roles[r.id] = sel.value;
      });
      return h('div', { class: 'model-select' }, h('div', null, h('div', { class: 'bold small' }, r.label), h('div', { class: 'xsmall muted' }, ROLE_HELP[r.id] || '')), sel);
    });
    return card({
      title: 'Available Models',
      icon: 'cpu',
      actions: [button('Refresh', { size: 'sm', ic: 'refresh', onClick: detect })],
      body: h(
        'div',
        null,
        modelPicker(st.models, st.model, (id) => {
          st.model = id;
          for (const r of roleDefs) st.roles[r.id] = id;
          st.testResult = null;
          st.compat = null;
          loadCapabilities();
          paint();
        }),
        h('hr', { class: 'sep' }),
        h('div', { class: 'row between' }, h('div', { class: 'bold small' }, 'A model per role'), h('span', { class: 'xsmall muted' }, 'Optional — the selected model is used for everything by default')),
        h('div', { class: 'mt-1' }, roleRows),
        h(
          'div',
          { class: 'row mt-2' },
          button(st.testing ? 'Testing…' : 'Test Connection', { ic: 'zap', disabled: st.testing || !st.model, onClick: testConnection }),
          button(st.compatBusy ? 'Testing…' : 'Run Compatibility Test', { ic: 'shieldCheck', disabled: st.testing || st.compatBusy || !st.model, onClick: runCompat }),
          button(st.saving ? 'Saving…' : st.conn ? 'Save changes' : 'Save & use Local AI', { kind: 'primary', ic: 'check', disabled: st.saving || !st.model, onClick: () => save() }),
        ),
      ),
    });
  }

  function testCard() {
    if (!st.testResult) return null;
    const r = st.testResult;
    return card({
      title: r.ok ? 'Connection successful' : 'Connection test',
      icon: r.ok ? 'circleCheck' : 'alert',
      actions: [badge(r.ok ? 'pass' : 'fail', r.ok ? 'PASS' : 'FAIL')],
      body: h(
        'div',
        null,
        checkList(r.checks),
        endpointLine(r.endpoint_mode, r.reasoning_mode),
        r.error ? h('div', { class: 'small mt-1', style: { color: 'var(--fail)' } }, r.error.message) : null,
        r.error && r.error.code === 'EMPTY_RESPONSE' ? h('div', { class: 'small mt-1' }, 'Run the Compatibility Test below for per-check results — connected does not always mean compatible for playbook generation.') : null,
        r.ok ? h('div', { class: 'small mt-1' }, '✓ Connection successful  ✓ Model generation successful') : null,
      ),
    });
  }

  function compatCard() {
    if (!st.compat && !st.compatBusy) return null;
    const r = st.compat;
    const kind = r ? VERDICT_BADGE[r.verdict] || 'fail' : 'running';
    const label = r ? r.verdict_label || r.verdict : 'Running…';
    return card({
      title: 'Compatible for Playbook Generation?',
      icon: 'shieldCheck',
      actions: [badge(kind, String(label).toUpperCase())],
      body: h(
        'div',
        null,
        h('div', { class: 'small text-2' }, 'Connected only means the server answered. This runs the six compatibility checks for ', h('b', null, st.model || 'the model'), ' — text output, JSON, the playbook JSON shape, the question envelope and repeatability — and shows how the model is being addressed.'),
        r
          ? h(
              'div',
              { class: 'mt-2' },
              checkList(r.checks),
              endpointLine(r.endpoint_mode, r.reasoning_mode),
              r.reasons && r.reasons.length ? h('ul', { class: 'small mt-1' }, r.reasons.map((x) => h('li', null, x))) : null,
              r.verdict === 'compatible' ? h('div', { class: 'small mt-1', style: { color: 'var(--ok)' } }, '✓ This model can generate playbooks on this server.') : null,
              r.verdict === 'incompatible' ? h('div', { class: 'small mt-1', style: { color: 'var(--fail)' } }, '✗ Do not use this model for playbook generation. Connected status alone is not enough.') : null,
            )
          : h('div', { class: 'small muted mt-2' }, 'Running the compatibility checks — this sends a few small prompts to the model…'),
      ),
    });
  }

  function sideCard() {
    const p = st.provider;
    const server = st.baseUrl;
    const connected = st.conn && st.conn.state === 'connected';
    if (st.detectError) {
      return troubleCard({
        provider: p.label,
        server,
        message: st.detectError,
        command: p.setup.command,
        onRetry: detect,
        onInstructions: () => {
          st.instructionsOpen = true;
          paint();
        },
      });
    }
    if (!st.detecting && (st.noModels || (st.testResult && st.testResult.error && st.testResult.error.code === 'NO_MODELS'))) {
      return noModelsCard({ provider: p.label, server, command: p.setup.command, onDetect: detect });
    }
    if (connected) {
      return connectedCard({
        provider: p.label,
        server: st.conn.server || server,
        model: st.model,
        testing: st.testing,
        onTest: testConnection,
        onChange: () => {
          st.conn.state = 'untested';
          detect();
        },
      });
    }
    return setupCard(p, {
      server,
      detecting: st.detecting,
      onDetect: detect,
      onOpen: () => window.open(st.models.length ? server : p.setup.install_url || server, '_blank', 'noopener'),
    });
  }

  function paint() {
    append(clear(body), [
      st.conn && st.conn.state === 'connected' && !st.noModels && !st.detectError
        ? banner('pass', 'Local AI is connected', `${st.provider.label} at ${st.conn.server || st.baseUrl} · ${st.model || 'no model'}. Intent discovery, playbook generation, testing and AI execution now run on this computer.`)
        : null,
      st.conn && st.conn.compat && st.conn.compat.verdict === 'incompatible'
        ? banner('fail', 'Connected, but not compatible for playbook generation', `${st.conn.compat.model || st.model || 'This model'} failed the compatibility checks on this server. ${((st.conn.compat.reasons || [])[0] || 'Run the Compatibility Test for details.')} Playbook generation may fail until a compatible model is selected.`)
        : null,
      h(
        'div',
        { class: 'grid sidebar-right' },
        h('div', { class: 'stack' }, formCard(), modelsCard(), st.capsError ? banner('warn', 'Capability check unavailable', st.capsError) : null, st.caps ? capabilityCard(st.caps, { onChoose: () => document.querySelector('.model-list') && document.querySelector('.model-list').scrollIntoView({ behavior: 'smooth', block: 'center' }) }) : null, testCard(), compatCard(), builtinCard()),
        h(
          'div',
          { class: 'stack' },
          sideCard(),
          st.instructionsOpen ? card({ title: 'Setup instructions', icon: 'book', body: detailedInstructions(st.provider.setup, { open: true, summary: 'Hide detailed instructions' }) }) : null,
          st.conn
            ? card({
                title: 'This connection',
                icon: 'info',
                body: h(
                  'div',
                  null,
                  h(
                    'div',
                    { class: 'kv-lines' },
                    h('div', null, h('span', null, 'Connection ID'), h('code', { class: 'inline' }, st.conn.id)),
                    h('div', null, h('span', null, 'Type'), h('span', null, 'Local · no API key')),
                    h('div', null, h('span', null, 'Cost'), h('span', null, 'Free — runs on this computer')),
                    st.conn.context_window ? h('div', null, h('span', null, 'Context window'), h('span', null, `${st.conn.context_window.toLocaleString('en-US')} tokens (num_ctx)`)) : null,
                    st.conn.tier ? h('div', null, h('span', null, 'PC performance tier'), h('span', null, `${(tierMeta(app, st.conn.tier) || TIER_FALLBACK[st.conn.tier] || {}).label || st.conn.tier} — up to ${(tierMeta(app, st.conn.tier) || TIER_FALLBACK[st.conn.tier] || {}).test_cases || '—'} AI test cases per generation`)) : null,
                    st.conn.last_endpoint_mode ? h('div', null, h('span', null, 'Endpoint'), h('span', null, ENDPOINT_LABELS[st.conn.last_endpoint_mode] || st.conn.last_endpoint_mode)) : null,
                    st.conn.compat ? h('div', null, h('span', null, 'Compatibility'), h('span', null, st.conn.compat.verdict_label || st.conn.compat.verdict)) : null,
                  ),
                  h(
                    'div',
                    { class: 'row mt-2' },
                    button('All connections', { size: 'sm', ic: 'plug', href: '#/connections' }),
                    h('span', { class: 'spacer' }),
                    button('Disconnect', { size: 'sm', kind: 'danger', ic: 'ban', onClick: disconnect }),
                  ),
                ),
              })
            : null,
        ),
      ),
    ]);
  }

  paint();
  // A saved connection lists what is installed right away.
  if (st.conn) detect();
  return () => {
    if (stopPoll) stopPoll();
  };
}
