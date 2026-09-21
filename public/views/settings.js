// Settings: Global Controls (§52), AI Behavior Controls (§53), testing
// thresholds, Appearance (§54) and data management. Changes save instantly.
import { api } from '../api.js';
import { h, append, icon, pageHead, card, button, toggle, toast, errorMessage, confirmDialog, segmented, banner, badge } from '../ui.js';

const PRIVACY_LABEL = { cloud_allowed: 'Cloud allowed', local_preferred: 'Local preferred', local_only: 'Local only' };
const badgeFor = (mode) => badge('', PRIVACY_LABEL[mode] || PRIVACY_LABEL.cloud_allowed, mode === 'local_only' ? 'accent' : 'outline');

const FEATURE_GROUPS = [
  ['Discovery', 'message', [
    ['intent_discovery', 'Intent Discovery', 'Interview the user before compiling a playbook.'],
    ['dynamic_questions', 'Dynamic Questions', 'Questions and options are generated from the goal and previous answers. Off = a fixed question set.'],
    ['multiple_choice', 'Multiple Choice', 'Offer answer options (a free-text “Something else” is always available).'],
    ['objective_confirmation', 'Objective Confirmation', 'Show “Here’s what I understand” before generating.'],
  ]],
  ['Playbooks', 'book', [
    ['playbook_generation', 'Playbook Generation', 'Allow compiling confirmed intents into playbooks.'],
    ['visual_workflow', 'Visual Workflow', 'Render the workflow as an interactive graph.'],
  ]],
  ['Exports', 'download', [
    ['markdown_export', 'Markdown Export', 'Generate and preview Playbook.md.'],
    ['pdf_export', 'PDF Export', 'Generate the PDF document.'],
    ['json_export', 'JSON Export', 'Download the canonical Playbook JSON.'],
  ]],
  ['Testing', 'flask', [
    ['automatic_test_generation', 'Automatic Test Generation', 'Generate normal, boundary, negative, missing-data, edge and repeatability cases.'],
    ['repeatability_testing', 'Repeatability Testing', 'Run repeatability tests many times and measure agreement.'],
    ['regression_testing', 'Regression Testing', 'Flag stale results when a playbook changes and compare versions.'],
    ['ai_evaluation', 'AI Evaluation', 'Use the evaluation model for semantic task alignment.'],
  ]],
  ['Execution', 'play', [
    ['tool_calling', 'Tool Calling', 'Let the execution model call the playbook’s bound tools.'],
    ['scheduled_playbooks', 'Scheduled Playbooks', 'Run published playbooks on their schedule while the app is running.'],
    ['human_approval', 'Human Approval', 'Pause for a person before approval steps and external actions.'],
    ['production_actions', 'Production Actions', 'Allow external side effects (sending, writing) in production runs. When off, they are simulated and logged.', true],
  ]],
];

const BEHAVIOR = [
  ['max_clarification_rounds', 'Maximum Clarification Rounds', 'number', 1, 15],
  ['max_questions_per_round', 'Maximum Questions Per Round', 'number', 1, 5],
  ['require_objective_confirmation', 'Require Objective Confirmation', 'bool'],
  ['show_assumptions', 'Show Assumptions', 'bool'],
  ['require_validation', 'Require Validation', 'bool', null, null, 'Fail runs whose output breaks the output contract.'],
  ['require_tests_before_publish', 'Require Tests Before Publish', 'bool', null, null, 'Publishing needs a fresh, passing full-suite run.'],
  ['default_repeatability_runs', 'Default Repeatability Runs', 'number', 2, 100],
];

const TESTING = [
  ['pass_threshold', 'Pass threshold', 'Accuracy, consistency, rule adherence and output compliance at or above this value pass.', 0.5, 1],
  ['warning_threshold', 'Warning threshold', 'Below the pass threshold but at or above this value is a WARNING; lower is a FAIL.', 0, 1],
  ['alignment_pass_threshold', 'Task alignment pass', 'Semantic task alignment (evaluator) needed to pass.', 0.5, 1],
  ['alignment_warning_threshold', 'Task alignment warning', 'Semantic task alignment below this fails.', 0, 1],
  ['ai_concurrency', 'AI test concurrency', 'Parallel AI executions during test runs.', 1, 10, 1],
  ['execution_temperature', 'Execution temperature', 'Temperature for AI execution. 0 maximises consistency.', 0, 2, 0.1],
];

const APPEARANCE = [
  ['compact_mode', 'Compact Mode', 'Tighter spacing.'],
  ['reduced_motion', 'Reduced Motion', 'Turn off animations.'],
  ['show_advanced_controls', 'Show Advanced Controls', 'Reveal binding JSON and other advanced details.'],
  ['show_execution_logs', 'Show Execution Logs', 'Show the step-by-step log on run pages.'],
  ['show_cost_information', 'Show Cost Information', 'Show token usage and cost estimates.'],
];

export async function render(el, { app }) {
  const s = await app.refreshSettings();
  let meta = app.meta;

  async function save(patch, label = 'Saved') {
    try {
      app.settings = await api.put('/api/settings', patch);
      await app.refreshSettings();
      toast(label);
      return true;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return false;
    }
  }

  const row = (label, help, control, danger) => h('div', { class: `setting-row ${danger ? 'danger' : ''}` }, h('div', null, h('div', { class: 'setting-label' }, label), help ? h('div', { class: 'setting-help' }, help) : null), control);

  const featureCards = FEATURE_GROUPS.map(([group, ic, items]) =>
    card({
      title: group,
      icon: ic,
      body: h(
        'div',
        null,
        items.map(([key, label, help, danger]) =>
          row(
            label,
            help,
            toggle(s.features[key], async (on, e) => {
              if (key === 'production_actions' && on) {
                const ok = await confirmDialog({ title: 'Turn on Production Actions?', text: 'Production runs will perform external actions for real (HTTP requests that write, send or modify). Keep Human Approval on to review each one.', confirm: 'Turn on', danger: true });
                if (!ok) {
                  e.target.checked = false;
                  return;
                }
              }
              const okSave = await save({ features: { [key]: on } }, `${label} ${on ? 'ON' : 'OFF'}`);
              if (!okSave) e.target.checked = !on;
            }, { label }),
            danger && s.features[key],
          ),
        ),
      ),
    }),
  );

  const behaviorCard = card({
    title: 'AI Behavior Controls',
    icon: 'sparkles',
    body: h(
      'div',
      null,
      BEHAVIOR.map(([key, label, type, min, max, help]) => {
        if (type === 'bool') return row(label, help, toggle(s.behavior[key], (on) => save({ behavior: { [key]: on } }, `${label} ${on ? 'ON' : 'OFF'}`), { label }));
        const inp = h('input', { class: 'input', type: 'number', min, max, value: s.behavior[key], 'aria-label': label });
        inp.addEventListener('change', async () => {
          const v = Number(inp.value);
          if (!(await save({ behavior: { [key]: v } }, `${label}: ${v}`))) inp.value = app.settings.behavior[key];
        });
        return row(label, key === 'max_questions_per_round' ? 'Default is one question at a time.' : null, inp);
      }),
    ),
  });

  const modeCtl = segmented(
    [
      { value: 'deterministic', label: 'Deterministic' },
      { value: 'ai', label: 'AI Execution' },
    ],
    s.testing.default_mode,
    (v) => save({ testing: { default_mode: v } }, 'Default test mode saved'),
  );
  const testingCard = card({
    title: 'Test scoring',
    icon: 'flask',
    body: h(
      'div',
      null,
      row('Default test mode', 'Mode preselected in the Tests tab.', modeCtl),
      TESTING.map(([key, label, help, min, max, step]) => {
        const pctField = max === 1 && key !== 'execution_temperature';
        const inp = h('input', { class: 'input', type: 'number', min: pctField ? min * 100 : min, max: pctField ? 100 : max, step: step || (pctField ? 1 : 0.1), value: pctField ? Math.round(s.testing[key] * 100) : s.testing[key], 'aria-label': label });
        inp.addEventListener('change', async () => {
          const v = pctField ? Number(inp.value) / 100 : Number(inp.value);
          if (!(await save({ testing: { [key]: v } }, `${label} saved`))) inp.value = pctField ? Math.round(app.settings.testing[key] * 100) : app.settings.testing[key];
        });
        return row(`${label}${pctField ? ' (%)' : ''}`, help, inp);
      }),
    ),
  });

  // ------------------------------------------------ Privacy Mode (spec v2 §14)
  const PRIVACY = [
    ['cloud_allowed', 'Cloud Allowed', 'Local and cloud providers can both be used.'],
    ['local_preferred', 'Local Preferred', 'A working local connection is used before any cloud connection.'],
    ['local_only', 'Local Only', 'Only models running on this computer. Cloud providers are blocked by the server, not just hidden.'],
  ];
  const privacyRows = PRIVACY.map(([value, label, help]) => {
    const input = h('input', { type: 'radio', name: 'privacy-mode', value });
    input.checked = (s.ai.privacy_mode || 'cloud_allowed') === value;
    input.addEventListener('change', async () => {
      if (!(await save({ ai: { privacy_mode: value } }, `Privacy Mode: ${label}`))) return;
      await app.refreshStatus();
      app.navigate('/settings');
    });
    return h('label', { class: `choice-row${input.checked ? ' selected' : ''}` }, input, h('div', null, h('div', { class: 'bold small' }, label), h('div', { class: 'xsmall text-2' }, help)));
  });
  const localOnly = (s.ai.privacy_mode || 'cloud_allowed') === 'local_only';
  const privacyCard = card({
    title: 'Privacy Mode',
    icon: 'lock',
    actions: [badgeFor(s.ai.privacy_mode)],
    body: h(
      'div',
      null,
      h('div', { class: 'stack-sm' }, privacyRows),
      h(
        'ul',
        { class: 'check-list small mt-2' },
        h('li', { class: 'yes' }, icon('check'), 'Local AI — Ollama, LM Studio, llama.cpp, vLLM, custom OpenAI-compatible servers'),
        h('li', { class: localOnly ? 'no' : 'yes' }, icon(localOnly ? 'x' : 'check'), 'Cloud API providers (OpenRouter, NVIDIA NIM, AMD, Google, Groq…)'),
        h('li', { class: 'yes' }, icon('lock'), `${localOnly ? '🔒 Local Workspace: ' : ''}playbook workspaces (inputs, tests, results, executions, exports) always stay on this computer`),
      ),
      h('div', { class: 'row mt-2' }, button('AI Connections', { size: 'sm', ic: 'plug', href: '#/connections' }), button('Connect Local AI', { size: 'sm', ic: 'cpu', href: '#/connections/local' })),
      h('hr', { class: 'sep' }),
      h('div', { class: 'bold small mb-1' }, 'AI request timing'),
      timeoutRow(),
    ),
  });

  function timeoutRow() {
    const input = h('input', { class: 'input', type: 'number', min: '1', max: '120', step: '1', value: s.ai.request_timeout_minutes ?? 10, 'aria-label': 'AI request timeout in minutes', style: { maxWidth: '120px' } });
    input.addEventListener('change', async () => {
      const v = Math.floor(Number(input.value));
      if (!(await save({ ai: { request_timeout_minutes: v } }, 'AI request timeout saved'))) input.value = app.settings.ai.request_timeout_minutes;
    });
    return row('AI request timeout (minutes)', 'How long ONE AI request may run before Playbook Builder treats it as timed out and retries. Raise it for slow local models — Ollama on a CPU can easily need more than 5 minutes for one long answer.', input);
  }

  const aiStatus = app.aiStatus;
  const aiCard = card({
    title: 'AI connection in use',
    icon: 'plug',
    body: aiStatus && aiStatus.configured
      ? h(
          'div',
          null,
          h(
            'div',
            { class: 'kv-lines' },
            h('div', null, h('span', null, 'Connection'), h('span', null, `${aiStatus.connection.name} · ${aiStatus.connection.provider_label}`)),
            h('div', null, h('span', null, 'Runs'), h('span', null, aiStatus.local ? 'On this computer' : 'In the cloud')),
            h('div', null, h('span', null, 'Generation model'), h('code', { class: 'inline' }, aiStatus.roles.generation || '—')),
            h('div', null, h('span', null, 'Status'), h('span', { class: 'row nowrap' }, h('span', { class: `dot ${aiStatus.connection.state === 'connected' ? 'ok' : 'warn'}` }), aiStatus.connection.state === 'connected' ? 'Connected' : 'Untested')),
          ),
          h('div', { class: 'small text-2 mt-2' }, 'Deterministic testing, the built-in example, exports and the workflow view all work without any AI connection.'),
        )
      : h('div', null, h('div', { class: 'small' }, 'No AI connection yet. Deterministic testing and the built-in example still work.'), h('div', { class: 'row mt-2' }, button('Connect Local AI (free)', { size: 'sm', kind: 'primary', ic: 'cpu', href: '#/connections/local' }), button('Add a cloud key', { size: 'sm', ic: 'key', href: '#/connections' }))),
  });

  const themeCtl = segmented(
    [
      { value: 'light', label: 'Light', icon: 'sun' },
      { value: 'dark', label: 'Dark', icon: 'moon' },
      { value: 'system', label: 'System', icon: 'monitor' },
    ],
    s.appearance.theme,
    (v) => save({ appearance: { theme: v } }, `Theme: ${v}`),
  );
  const appearanceCard = card({
    title: 'Appearance',
    icon: 'sun',
    body: h('div', null, row('Theme', null, themeCtl), APPEARANCE.map(([key, label, help]) => row(label, help, toggle(s.appearance[key], (on) => save({ appearance: { [key]: on } }, `${label} ${on ? 'ON' : 'OFF'}`), { label })))),
  });

  const dataCard = card({
    title: 'Data',
    icon: 'database',
    body: h(
      'div',
      null,
      row('Data folder', 'Playbooks, versions, test runs, runs, settings and the encrypted key file live here.', h('code', { class: 'inline', style: { maxWidth: '420px', overflowWrap: 'anywhere' } }, meta.data_dir)),
      row(
        'Playbook workspaces',
        'One folder per playbook with its playbook, requirements, process, inputs, tests, results, executions, exports and metadata.',
        h(
          'div',
          { class: 'stack-sm', style: { textAlign: 'right' } },
          h('code', { class: 'inline', style: { maxWidth: '420px', overflowWrap: 'anywhere' } }, meta.workspaces_dir || ''),
          h('div', null, button('Open folder', { size: 'sm', ic: 'folder', onClick: async () => { try { const r = await api.post('/api/workspaces/open'); toast(r.opened ? 'Opened in your file manager' : 'Could not open a file manager here'); } catch (err) { toast(errorMessage(err), 'error'); } } })),
        ),
      ),
      row(
        'Built-in examples',
        'Re-create the Customer Risk Evaluator and the Broken Rule Demo, then re-run their tests.',
        button('Restore examples', {
          size: 'sm',
          ic: 'refresh',
          onClick: async () => {
            if (!(await confirmDialog({ title: 'Restore the built-in examples?', text: 'The two example playbooks are deleted and re-created with fresh test runs. Your own playbooks are not touched.', confirm: 'Restore' }))) return;
            try {
              await api.post('/api/examples/reset');
              toast('Examples restored');
            } catch (err) {
              toast(errorMessage(err), 'error');
            }
          },
        }),
      ),
      row(
        'Reset settings',
        'Return every switch and control to its default. AI connections are kept.',
        button('Reset to defaults', {
          size: 'sm',
          kind: 'danger',
          onClick: async () => {
            if (!(await confirmDialog({ title: 'Reset all settings?', text: 'Every switch, control and appearance option returns to its default.', confirm: 'Reset', danger: true }))) return;
            await api.post('/api/settings/reset');
            await app.refreshSettings();
            toast('Settings reset');
            app.navigate('/settings');
          },
        }),
      ),
      row('Version', null, h('span', { class: 'small muted' }, `Playbook Builder ${meta.version} · engine ${meta.engine_version} · Node ${meta.node}`)),
    ),
  });

  append(el, [
    pageHead({ title: 'Settings', subtitle: 'Every switch takes effect immediately.' }),
    s.features.production_actions ? banner('warn', 'Production Actions are ON', 'Production runs can perform external actions for real. Human Approval is ' + (s.features.human_approval ? 'ON — each action waits for a person.' : 'OFF — actions run without review.')) : null,
    h('div', { class: 'section-label' }, 'Global controls'),
    h('div', { class: 'grid two' }, featureCards),
    h('div', { class: 'section-label mt-3' }, 'Behavior & scoring'),
    h('div', { class: 'grid two' }, behaviorCard, testingCard),
    h('div', { class: 'section-label mt-3' }, 'Privacy & AI'),
    h('div', { class: 'grid two' }, privacyCard, aiCard),
    h('div', { class: 'section-label mt-3' }, 'Appearance & data'),
    h('div', { class: 'grid two' }, appearanceCard, dataCard),
  ]);
  void icon;
}
