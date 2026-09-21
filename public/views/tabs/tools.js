// Tools tab (spec §8, §9): purpose, permission, required flag, runtime binding,
// and the execution policies that apply to them.
import { h, icon, card, badge, kv, jsonView, title, button } from '../../ui.js';

const BINDING_TEXT = {
  input: (b) => `Reads "${b.key || 'the tool id'}" from the run input.`,
  builtin: (b) => `Built-in tool: ${b.name}.`,
  http_request: (b) => `${String(b.method || 'GET').toUpperCase()} ${b.url}`,
};

export async function render(el, ctx) {
  const { pb, app } = ctx;
  const f = app.settings.features;
  const usedBy = (tid) => pb.steps.filter((s) => (s.tools || []).includes(tid) || (s.execution && s.execution.tool_id === tid)).map((s) => s.id);
  el.append(
    h(
      'div',
      { class: 'grid sidebar-right' },
      h(
        'div',
        { class: 'stack' },
        pb.tools.length
          ? pb.tools.map((t) =>
              card({
                title: t.name,
                icon: 'wrench',
                actions: [badge(t.permission === 'read-only' ? 'pass' : 'warning', title(t.permission)), t.required ? badge('', 'Required', 'accent') : badge('', 'Not required', 'outline')],
                body: h(
                  'div',
                  null,
                  kv([
                    ['Purpose', t.purpose],
                    ['ID', h('code', { class: 'inline' }, t.id)],
                    ['Used by', usedBy(t.id).join(', ') || h('span', { class: 'muted' }, 'No step uses this tool')],
                    ['Binding', t.binding ? (BINDING_TEXT[t.binding.type] || (() => JSON.stringify(t.binding)))(t.binding) : h('span', { class: 'muted' }, 'Not bound — supply its data in the run input or add a binding (Edit JSON).')],
                    t.side_effects ? ['Side effects', title(t.side_effects)] : null,
                  ]),
                  t.binding ? h('details', { class: 'collapsible mt-2 advanced-only' }, h('summary', { class: 'small' }, 'Binding JSON'), h('div', { class: 'mt-1' }, jsonView(t.binding, { cls: 'inline' }))) : null,
                ),
              }),
            )
          : card({ body: h('div', { class: 'empty' }, icon('wrench'), h('div', { class: 'empty-title' }, 'No tools required'), h('div', { class: 'small mt-1' }, 'Every input is supplied directly to the run. Tools are only added when a step needs them.')) }),
      ),
      h(
        'div',
        { class: 'stack' },
        card({
          title: 'Execution policy',
          icon: 'shield',
          actions: [button('Settings', { size: 'sm', kind: 'ghost', href: '#/settings' })],
          body: h(
            'ul',
            { class: 'list-clean small' },
            h('li', null, h('div', { class: 'row between' }, h('span', { class: 'bold' }, 'Tool Calling'), badge(f.tool_calling ? 'pass' : '', f.tool_calling ? 'ON' : 'OFF')), h('div', { class: 'text-2' }, 'Lets the execution model call bound tools during AI runs.')),
            h('li', null, h('div', { class: 'row between' }, h('span', { class: 'bold' }, 'Production Actions'), badge(f.production_actions ? 'warning' : '', f.production_actions ? 'ON' : 'OFF')), h('div', { class: 'text-2' }, f.production_actions ? 'External actions run for real in production runs.' : 'External actions are simulated and logged, never sent.')),
            h('li', null, h('div', { class: 'row between' }, h('span', { class: 'bold' }, 'Human Approval'), badge(f.human_approval ? 'pass' : 'warning', f.human_approval ? 'ON' : 'OFF')), h('div', { class: 'text-2' }, 'External actions and approval steps pause until a person approves.')),
            h('li', null, h('div', { class: 'row between' }, h('span', { class: 'bold' }, 'Sandbox runs'), badge('pass', 'Always safe')), h('div', { class: 'text-2' }, 'Draft versions run in the sandbox, where external actions are always simulated.')),
          ),
        }),
        card({
          title: 'Permissions',
          icon: 'lock',
          body: h(
            'div',
            null,
            h('div', { class: 'section-label' }, 'Allowed'),
            h('ul', { class: 'bullets small' }, pb.permissions.filter((p) => p.allowed).map((p) => h('li', null, p.action))),
            h('div', { class: 'section-label' }, 'Not allowed'),
            h('ul', { class: 'bullets small' }, pb.permissions.filter((p) => !p.allowed).map((p) => h('li', null, p.action))),
          ),
        }),
      ),
    ),
  );
}
