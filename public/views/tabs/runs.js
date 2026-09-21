// Runs tab: execute a version (sandbox or production, deterministic or AI)
// and see this playbook's run history.
import { api } from '../../api.js';
import { h, icon, clear, card, button, badge, banner, toast, errorMessage, jsonEditor, segmented, ago, duration, title, money } from '../../ui.js';
import { sampleInput } from './inputs.js';

export async function render(el, ctx) {
  const { app, view, pb } = ctx;
  const [history, wsInputs] = await Promise.all([
    api.get(`/api/playbooks/${ctx.id}/runs`).then((r) => r.runs),
    api.get(`/api/playbooks/${ctx.id}/workspace/inputs`).then((r) => r.files).catch(() => []),
  ]);
  const v = view.version;
  const published = ['published', 'production'].includes(v.status);
  let mode = 'deterministic';
  let environment = published ? 'production' : 'sandbox';
  const aiReady = Boolean(app.aiStatus && app.aiStatus.configured);

  const input = jsonEditor(sampleInput(pb), { rows: 10 });
  // Input from the workspace: production runs only see inputs/runtime.
  let loadedFrom = null;
  let loadedText = null;
  const fileSelect = h('select', { class: 'input sm', style: { width: 'auto', maxWidth: '100%' }, 'aria-label': 'Load input from the workspace' });
  const sourceNote = h('div', { class: 'xsmall muted' });
  const paintFiles = () => {
    const allowed = wsInputs.filter((f) => environment !== 'production' || f.category === 'runtime');
    clear(fileSelect).append(h('option', { value: '' }, allowed.length ? 'Load input from a workspace file…' : environment === 'production' ? 'No files in inputs/runtime' : 'No JSON files in inputs/'), ...allowed.map((f) => h('option', { value: f.path, selected: f.path === loadedFrom }, f.path)));
    fileSelect.disabled = !allowed.length;
    if (loadedFrom && !allowed.some((f) => f.path === loadedFrom)) {
      loadedFrom = null;
      loadedText = null;
    }
    sourceNote.textContent = loadedFrom ? (input.textarea.value === loadedText ? `Input from ${loadedFrom} — recorded with the run.` : `Edited after loading ${loadedFrom}: the run records it as entered in the app.`) : environment === 'production' ? 'Production runs can only load real data from inputs/runtime.' : 'Sandbox runs can load sample, test or runtime files.';
  };
  fileSelect.addEventListener('change', async () => {
    const p = fileSelect.value;
    if (!p) return;
    try {
      const text = await (await fetch(`/api/playbooks/${ctx.id}/workspace/file?path=${encodeURIComponent(p)}`)).text();
      const parsed = JSON.parse(text);
      const ids = (pb.inputs || []).map((i) => i.id);
      input.set(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (!ids.length || ids.some((k) => k in parsed)) ? parsed : ids.length === 1 ? { [ids[0]]: parsed } : parsed);
      loadedFrom = p;
      loadedText = input.textarea.value;
      paintFiles();
    } catch (err) {
      toast(`${p}: ${errorMessage(err)}`, 'error');
    }
  });
  input.textarea.addEventListener('input', () => paintFiles());
  const cfgEditor = jsonEditor({}, { rows: 4 });
  const runBtn = button('Run playbook', { kind: 'primary', ic: 'play' });
  const envHint = h('div', { class: 'xsmall muted' });
  const modeHint = h('div', { class: 'xsmall muted' });

  const paintHints = () => {
    envHint.textContent =
      environment === 'production'
        ? app.feature('production_actions')
          ? `Production: external actions are performed${app.feature('human_approval') ? ' after human approval' : ''}.`
          : 'Production: Production Actions is OFF, so external actions are simulated and logged.'
        : 'Sandbox: external actions are always simulated. Drafts can only run here.';
    modeHint.textContent = mode === 'ai' ? (aiReady ? `The execution model (${pb.ai.model || (app.aiStatus.roles && app.aiStatus.roles.execution) || 'default'}) performs the steps; the engine executes tools and validates the output.` : 'AI execution needs an AI connection.') : 'The engine executes the machine-readable logic. Steps without it are simulated.';
    runBtn.disabled = mode === 'ai' && !aiReady;
  };

  runBtn.addEventListener('click', async () => {
    let inp;
    let cfg;
    try {
      inp = input.get();
      cfg = cfgEditor.get();
    } catch (err) {
      toast(`Invalid JSON: ${err.message}`, 'error');
      return;
    }
    runBtn.disabled = true;
    runBtn.replaceChildren(h('span', { class: 'spinner' }), 'Starting…');
    try {
      const fromFile = loadedFrom && input.textarea.value === loadedText;
      const res = await api.post(`/api/playbooks/${ctx.id}/run`, { version: v.version, ...(fromFile ? { input_file: loadedFrom } : { input: inp }), mode, environment, configuration: cfg && Object.keys(cfg).length ? cfg : undefined });
      app.navigate(`/runs/${res.data.run.id}`);
    } catch (err) {
      toast(errorMessage(err), 'error');
      runBtn.disabled = false;
      runBtn.replaceChildren(icon('play'), 'Run playbook');
    }
  });

  const envCtlHost = h('div');
  function makeEnv() {
    return segmented(
      [
        { value: 'sandbox', label: 'Sandbox', icon: 'shield' },
        { value: 'production', label: 'Production', icon: 'zap' },
      ],
      environment,
      (x) => {
        if (x === 'production' && !published) {
          toast('Publish this version before running it in production.', 'error');
          environment = 'sandbox';
          envCtlHost.replaceChildren(makeEnv());
        } else environment = x;
        paintHints();
        paintFiles();
      },
    );
  }
  envCtlHost.append(makeEnv());
  const modeCtl = segmented(
    [
      { value: 'deterministic', label: 'Deterministic', icon: 'cpu' },
      { value: 'ai', label: 'AI Execution', icon: 'sparkles' },
    ],
    mode,
    (x) => {
      mode = x;
      paintHints();
    },
  );
  paintHints();
  paintFiles();

  const historyRows = history.map((r) =>
    h(
      'tr',
      { class: 'clickable', onClick: () => app.navigate(`/runs/${r.id}`) },
      h('td', null, h('div', { class: 'cell-title' }, `v${r.version}`), h('div', { class: 'cell-sub' }, `${title(r.trigger)} · ${r.environment}`)),
      h('td', null, badge(r.status), r.pending_approvals ? h('div', { class: 'xsmall mt-1', style: { color: 'var(--warn)' } }, 'approval pending') : null),
      h('td', null, r.mode === 'ai' ? badge('', 'AI', 'accent') : badge('', 'Deterministic', 'outline')),
      h('td', { class: 'small' }, r.error ? `${r.error.code}` : '—'),
      h('td', { class: 'num small cost' }, r.usage ? money(r.usage.cost) : '—'),
      h('td', { class: 'num small muted' }, duration(r.duration_ms)),
      h('td', { class: 'num small muted' }, ago(r.started_at)),
    ),
  );

  el.append(
    h(
      'div',
      { class: 'grid sidebar-right' },
      card({
        title: `Run v${v.version}`,
        icon: 'play',
        hint: published ? 'Published version' : 'Draft — sandbox only',
        body: h(
          'div',
          { class: 'stack' },
          !published ? banner('info', 'This version is not published', 'Build first, test second, execute third: drafts run in the sandbox so you can try them safely. Publish to run in production.') : null,
          h('div', { class: 'row between' }, h('div', null, h('div', { class: 'label mb-2' }, 'Environment'), envCtlHost, envHint), h('div', null, h('div', { class: 'label mb-2' }, 'Mode'), modeCtl, modeHint)),
          h('div', { class: 'field' }, h('div', { class: 'row between' }, h('label', null, 'Run input'), fileSelect), input.el, sourceNote),
          h('details', { class: 'collapsible' }, h('summary', { class: 'small' }, 'Configuration overrides for this run'), h('div', { class: 'mt-1' }, cfgEditor.el, h('div', { class: 'xsmall muted' }, `Available: ${pb.configuration.map((c) => c.name).join(', ') || 'none'}`))),
          h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, runBtn),
        ),
      }),
      card({
        title: 'How runs work',
        icon: 'info',
        body: h(
          'ol',
          { class: 'numbers small text-2' },
          h('li', null, 'Required inputs are checked before anything executes.'),
          h('li', null, 'Steps run in dependency order; decision rules pick the branch.'),
          h('li', null, 'Tools run under the playbook’s permissions and the execution policy.'),
          h('li', null, 'Approval steps and external actions pause for a person.'),
          h('li', null, 'The output is validated against the output contract.'),
        ),
      }),
    ),
    h('div', { class: 'mt-3' }),
    card({
      title: 'Run history',
      icon: 'history',
      tight: true,
      body: historyRows.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'Version'), h('th', null, 'Status'), h('th', null, 'Mode'), h('th', null, 'Error'), h('th', { class: 'num cost' }, 'Cost'), h('th', { class: 'num' }, 'Duration'), h('th', { class: 'num' }, 'Started'))), h('tbody', null, historyRows)))
        : h('div', { class: 'empty' }, icon('play'), h('div', { class: 'empty-title' }, 'No runs yet')),
    }),
  );
  void clear;
}
