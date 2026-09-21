// Dependencies tab (spec §7, §19, §20): declared dependencies by type, the
// step dependency graph as a list, and parallel groups.
import { h, icon, card, badge, title } from '../../ui.js';
import { parallelGroups, topologicalOrder } from '/shared/graph.js';
import { typeSwatch } from '../../components/common.js';

const TYPE_TITLES = { data: 'Data', system: 'Systems', tool: 'Tools', authentication: 'Authentication & permissions', workflow: 'Workflow', configuration: 'Configuration', human: 'Human', ai: 'AI' };
const TYPE_ICONS = { data: 'database', system: 'cpu', tool: 'wrench', authentication: 'key', workflow: 'workflow', configuration: 'sliders', human: 'user', ai: 'sparkles' };

export async function render(el, ctx) {
  const { pb } = ctx;
  const groups = {};
  for (const d of pb.dependencies) (groups[d.type] = groups[d.type] || []).push(d);
  const order = topologicalOrder(pb);
  const par = parallelGroups(pb);
  const idx = new Map(pb.steps.map((s, i) => [s.id, i + 1]));
  const stepById = new Map(pb.steps.map((s) => [s.id, s]));

  el.append(
    h(
      'div',
      { class: 'grid two' },
      h(
        'div',
        { class: 'stack' },
        Object.keys(TYPE_TITLES)
          .filter((k) => groups[k])
          .map((k) =>
            card({
              title: TYPE_TITLES[k],
              icon: TYPE_ICONS[k],
              body: h('ul', { class: 'list-clean' }, groups[k].map((d) => h('li', null, h('div', { class: 'row between' }, h('span', { class: 'bold' }, d.name), d.required ? badge('', 'Required', 'accent') : badge('', 'Optional', 'outline')), d.description ? h('div', { class: 'small text-2 mt-1' }, d.description) : null))),
            }),
          ),
        pb.dependencies.length ? null : card({ body: h('div', { class: 'muted' }, 'No dependencies declared. Dependencies should never be assumed obvious.') }),
      ),
      h(
        'div',
        { class: 'stack' },
        card({
          title: 'Step dependencies',
          icon: 'workflow',
          hint: 'Execution order (topological)',
          body: h(
            'ol',
            { class: 'list-clean' },
            order.map((id) => {
              const s = stepById.get(id);
              if (!s) return null;
              return h(
                'li',
                { class: 'row nowrap', style: { alignItems: 'flex-start' } },
                h('span', { class: 'step-num' }, idx.get(id)),
                h('div', null, h('div', { class: 'row nowrap' }, typeSwatch(s.type), h('span', { class: 'bold' }, s.name), h('code', { class: 'xsmall muted' }, s.id)), h('div', { class: 'small text-2' }, s.dependencies.length ? ['Depends on ', s.dependencies.map((d, i) => [i ? ', ' : '', h('a', { href: `#/playbooks/${ctx.id}/workflow?step=${d}${ctx.version !== ctx.view.current_version ? `&v=${ctx.version}` : ''}` }, `Step ${idx.get(d) || '?'} (${d})`)])] : 'Entry step — no upstream dependency')),
              );
            }),
          ),
        }),
        card({
          title: 'Parallel groups',
          icon: 'compare',
          body: par.length
            ? h('ul', { class: 'list-clean' }, par.map((g) => h('li', null, h('div', { class: 'row' }, g.steps.map((id) => badge('', `${id} · ${(stepById.get(id) || {}).name || ''}`, 'outline'))), h('div', { class: 'xsmall muted mt-1' }, g.after.length ? `Independent steps after ${g.after.join(', ')} — may run at the same time.` : 'Independent entry steps — may run at the same time.'))))
            : h('div', { class: 'small muted' }, 'No independent steps: the workflow runs sequentially, branching only at decision steps.'),
        }),
        card({
          title: 'Validation',
          icon: 'shieldCheck',
          body: h('div', { class: 'small text-2' }, icon('circleCheck'), ' Every dependency references an existing step and the graph has no cycles — both are enforced by the quality gate.'),
        }),
      ),
    ),
  );
}

export { title };
