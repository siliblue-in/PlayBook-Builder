// Requirements tab (spec §57): goal, scope, requirements, assumptions,
// dependencies, tools, permissions, configuration, trigger, output, success.
import { api } from '../../api.js';
import { h, icon, card, badge, button, title, toast, errorMessage, toggle, jsonEditor, kv, copyText } from '../../ui.js';
import { describeCondition, configMap } from '../../components/common.js';

const REQ_TITLES = { functional: 'Functional', data: 'Data', business_rule: 'Business rules', output: 'Output', non_functional: 'Non-functional', constraint: 'Constraints' };

function configEditor(ctx) {
  const { pb } = ctx;
  if (!pb.configuration.length) return h('div', { class: 'muted small' }, 'No configuration values. Variable values (thresholds, formats, limits) belong here.');
  const inputs = {};
  const rows = pb.configuration.map((c) => {
    let control;
    if (c.type === 'boolean') {
      control = toggle(Boolean(c.value), (v) => (inputs[c.name] = () => v));
      inputs[c.name] = () => Boolean(c.value);
    } else if (Array.isArray(c.allowed_values) && c.allowed_values.length) {
      const sel = h('select', { class: 'input sm' }, c.allowed_values.map((a) => h('option', { value: JSON.stringify(a), selected: a === c.value }, String(a))));
      control = sel;
      inputs[c.name] = () => JSON.parse(sel.value);
    } else if (c.type === 'number' || c.type === 'integer') {
      const inp = h('input', { class: 'input sm', type: 'number', value: c.value ?? '', step: c.type === 'integer' ? '1' : 'any', min: c.min ?? null, max: c.max ?? null, style: { width: '120px' } });
      control = inp;
      inputs[c.name] = () => (inp.value === '' ? null : Number(inp.value));
    } else {
      const inp = h('input', { class: 'input sm', value: typeof c.value === 'string' ? c.value : JSON.stringify(c.value) });
      control = inp;
      inputs[c.name] = () => {
        if (c.type === 'string' || c.type === 'text') return inp.value;
        try {
          return JSON.parse(inp.value);
        } catch {
          return inp.value;
        }
      };
    }
    return h('tr', null, h('td', null, h('code', null, c.name)), h('td', { class: 'small muted' }, c.type), h('td', null, ctx.editable ? control : h('code', null, JSON.stringify(c.value))), h('td', { class: 'small text-2' }, c.description, typeof c.min === 'number' || typeof c.max === 'number' ? h('div', { class: 'xsmall muted' }, `Allowed range ${c.min ?? '−∞'}–${c.max ?? '∞'}`) : null));
  });
  const save = button('Save configuration', {
    kind: 'primary',
    size: 'sm',
    ic: 'check',
    onClick: async () => {
      const values = {};
      for (const [k, get] of Object.entries(inputs)) values[k] = get();
      try {
        const res = await api.patch(`/api/playbooks/${ctx.id}`, { configuration: values });
        ctx.afterSave(res, 'Configuration saved');
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    },
  });
  const willVersion = !ctx.editable || ctx.view.version.last_test;
  return h(
    'div',
    null,
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Type'), h('th', null, 'Value'), h('th', null, 'Description'))), h('tbody', null, rows))),
    h('div', { class: 'row between mt-2' }, h('div', { class: 'xsmall muted' }, willVersion ? `Saving creates a new version (v${ctx.view.versions[0].version + 1}); v${ctx.version} is kept for comparison.` : 'This untested draft is edited in place.'), save),
  );
}

function scheduleCard(ctx) {
  const { view, pb } = ctx;
  const t = pb.trigger || {};
  const published = view.versions.some((x) => ['published', 'production'].includes(x.status));
  const sched = view.schedule || {};
  const editor = jsonEditor(sched.input || {}, { rows: 6 });
  const enabledToggle = toggle(Boolean(sched.enabled), async (on) => {
    try {
      let input;
      try {
        input = editor.get();
      } catch {
        input = sched.input || {};
      }
      await api.patch(`/api/playbooks/${ctx.id}`, { schedule: { enabled: on, input } });
      toast(on ? 'Schedule enabled' : 'Schedule disabled');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });
  return card({
    title: 'Schedule',
    icon: 'clock',
    body: h(
      'div',
      null,
      h('div', { class: 'setting-row' }, h('div', null, h('div', { class: 'setting-label' }, `Run ${[t.frequency, t.day, t.time].filter(Boolean).join(' · ') || 'on schedule'}`), h('div', { class: 'setting-help' }, published ? 'Uses the production version (or latest published). External actions still follow Production Actions and Human Approval.' : 'Publish a version first — schedules never run drafts.')), enabledToggle),
      h('div', { class: 'field mt-2' }, h('label', null, 'Input for scheduled runs'), editor.el),
      h('div', { class: 'row mt-2' }, button('Save input', { size: 'sm', onClick: async () => { try { await api.patch(`/api/playbooks/${ctx.id}`, { schedule: { input: editor.get() } }); toast('Schedule input saved'); } catch (err) { toast(errorMessage(err), 'error'); } } })),
    ),
  });
}

export async function render(el, ctx) {
  const { pb, view } = ctx;
  const cfg = configMap(pb);
  const groups = {};
  for (const r of pb.requirements) (groups[r.type] = groups[r.type] || []).push(r);
  const t = pb.trigger || {};
  const allowed = pb.permissions.filter((p) => p.allowed);
  const denied = pb.permissions.filter((p) => !p.allowed);

  el.append(
    h(
      'div',
      { class: 'grid sidebar-right' },
      h(
        'div',
        { class: 'stack' },
        card({ title: 'Goal & scope', icon: 'target', body: h('div', null, h('div', { class: 'section-label' }, 'Goal'), h('div', null, pb.objective), h('div', { class: 'section-label' }, 'Scope'), h('div', { class: 'text-2' }, pb.scope || '—')) }),
        card({
          title: 'Requirements',
          icon: 'list',
          hint: `${pb.requirements.length} requirements`,
          body: h(
            'div',
            null,
            Object.keys(REQ_TITLES)
              .filter((k) => groups[k])
              .map((k) =>
                h(
                  'div',
                  null,
                  h('div', { class: 'section-label' }, REQ_TITLES[k]),
                  h(
                    'ul',
                    { class: 'list-clean' },
                    groups[k].map((r) =>
                      h('li', null, h('div', { class: 'row nowrap', style: { alignItems: 'flex-start' } }, h('code', { class: 'inline' }, r.id), h('div', null, r.text, r.rule ? h('div', { class: 'small mt-1' }, h('span', { class: 'muted' }, 'Rule: '), h('code', null, describeCondition(r.rule, cfg)), r.result !== undefined ? [' → ', badge('', String(r.result), 'violet')] : null) : null))),
                    ),
                  ),
                ),
              ),
            pb.requirements.length ? null : h('div', { class: 'muted' }, 'No requirements.'),
          ),
        }),
        card({ title: 'Assumptions', icon: 'info', body: pb.assumptions.length ? h('ul', { class: 'bullets' }, pb.assumptions.map((a) => h('li', null, a))) : h('div', { class: 'muted small' }, 'None stated.') }),
        card({ title: 'Configuration', icon: 'sliders', hint: 'Variable values live here — never hard-coded in steps', body: configEditor(ctx) }),
        card({
          title: 'Output',
          icon: 'file',
          body: h(
            'div',
            null,
            kv([['Format', pb.output.format], ['Destination', pb.output.destination], ['Description', pb.output.description]]),
            pb.output.sections.length ? h('div', null, h('div', { class: 'section-label' }, 'Sections'), h('ol', { class: 'numbers' }, pb.output.sections.map((s) => h('li', null, s)))) : null,
            pb.output.fields.length
              ? h('div', { class: 'table-wrap mt-2' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'Field'), h('th', null, 'Type'), h('th', null, 'Required'), h('th', null, 'Description'))), h('tbody', null, pb.output.fields.map((f) => h('tr', null, h('td', null, h('code', null, f.name)), h('td', { class: 'small' }, f.type, f.enum ? h('div', { class: 'xsmall muted' }, f.enum.join(' | ')) : null), h('td', null, f.required ? 'Yes' : 'No'), h('td', { class: 'small text-2' }, f.description))))))
              : null,
          ),
        }),
        card({ title: 'Success criteria', icon: 'circleCheck', body: h('ul', { class: 'bullets' }, pb.success_criteria.map((c) => h('li', null, c.text))) }),
      ),
      h(
        'div',
        { class: 'stack' },
        card({
          title: 'Permissions',
          icon: 'lock',
          body: h(
            'div',
            null,
            h('div', { class: 'section-label' }, 'Allowed'),
            allowed.length ? h('ul', { class: 'list-clean' }, allowed.map((p) => h('li', { class: 'row nowrap small' }, icon('circleCheck'), p.action))) : h('div', { class: 'muted small' }, 'Nothing explicitly allowed.'),
            h('div', { class: 'section-label' }, 'Not allowed'),
            denied.length ? h('ul', { class: 'list-clean' }, denied.map((p) => h('li', { class: 'row nowrap small', style: { color: 'var(--fail)' } }, icon('ban'), h('span', { style: { color: 'var(--text)' } }, p.action)))) : h('div', { class: 'muted small' }, 'Nothing explicitly forbidden.'),
          ),
        }),
        card({
          title: 'Trigger',
          icon: 'zap',
          body: h(
            'div',
            null,
            kv([['Type', title(t.type)], ['Frequency', t.frequency], ['Day', t.day], ['Time', t.time], ['Timezone', t.timezone], ['Event', t.event], ['Description', t.description]]),
            ['webhook', 'api', 'event'].includes(t.type) || ctx.app.settings.appearance.show_advanced_controls
              ? h('div', { class: 'mt-2' }, h('div', { class: 'section-label' }, 'Webhook URL (production version)'), h('div', { class: 'row nowrap' }, h('code', { class: 'inline', style: { overflowWrap: 'anywhere' } }, `${location.origin}${view.webhook_path}`), button('', { ic: 'copy', size: 'sm', title: 'Copy URL', onClick: () => copyText(`${location.origin}${view.webhook_path}`) })), h('div', { class: 'xsmall muted mt-1' }, 'POST a JSON body; it becomes the run input.'))
              : null,
          ),
        }),
        t.type === 'schedule' ? scheduleCard(ctx) : null,
        card({ title: 'Dependencies', icon: 'link', actions: [button('Details', { size: 'sm', kind: 'ghost', onClick: () => ctx.go('dependencies') })], body: h('ul', { class: 'list-clean' }, pb.dependencies.map((d) => h('li', { class: 'small' }, h('span', { class: 'badge outline', style: { marginRight: '6px' } }, d.type), d.name, d.required ? null : h('span', { class: 'muted' }, ' (optional)')))) }),
        card({ title: 'Tools', icon: 'wrench', actions: [button('Details', { size: 'sm', kind: 'ghost', onClick: () => ctx.go('tools') })], body: pb.tools.length ? h('ul', { class: 'list-clean' }, pb.tools.map((tl) => h('li', { class: 'small' }, h('div', { class: 'bold' }, tl.name), h('div', { class: 'text-2' }, tl.purpose)))) : h('div', { class: 'muted small' }, 'No tools required — all data arrives in the run input.') }),
      ),
    ),
  );
}
