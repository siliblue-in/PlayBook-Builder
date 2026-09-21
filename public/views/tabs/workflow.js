// Workflow tab (spec §19–§21, §32, §58): visual graph, full step definitions,
// machine-readable decision rules (editable on drafts), raw JSON editing.
import { api } from '../../api.js';
import { h, icon, clear, card, button, badge, segmented, toast, errorMessage, modal, jsonEditor, title } from '../../ui.js';
import { workflowGraph } from '../../components/graph.js';
import { stepDetail, describeCondition, configMap, OPERATOR_OPTIONS, typeSwatch } from '../../components/common.js';

export function procedureForEdit(pb) {
  const { tests, status, metadata, id, version, ...rest } = JSON.parse(JSON.stringify(pb));
  return rest;
}

export function openJsonEditor(ctx) {
  const editor = jsonEditor(procedureForEdit(ctx.pb), { rows: 26 });
  const note = h('input', { class: 'input', placeholder: 'What changed? (optional)' });
  modal({
    title: `Edit playbook JSON · v${ctx.version}`,
    wide: true,
    body: h(
      'div',
      null,
      h('p', { class: 'small text-2', style: { marginTop: 0 } }, ctx.editable && !ctx.view.version.last_test ? 'This untested draft is edited in place.' : `v${ctx.version} is ${ctx.view.version.immutable ? 'published and immutable' : 'tested'}, so saving creates a new version and keeps v${ctx.version} for comparison.`),
      editor.el,
      h('div', { class: 'field mt-2' }, note),
    ),
    actions: [
      { label: 'Cancel', onClick: (c) => c() },
      {
        label: 'Save',
        kind: 'primary',
        icon: 'check',
        onClick: async (close) => {
          let playbook;
          try {
            playbook = editor.get();
          } catch (err) {
            toast(`Invalid JSON: ${err.message}`, 'error');
            return;
          }
          try {
            const res = await api.put(`/api/playbooks/${ctx.id}`, { playbook, change_note: note.value || 'Edited playbook JSON.', base_version: ctx.version });
            close();
            if (!res.saved.changed) toast('No changes to save');
            else ctx.afterSave(res, 'Playbook saved');
          } catch (err) {
            toast(errorMessage(err), 'error');
          }
        },
      },
    ],
  });
}

function rulesEditor(ctx) {
  const { pb } = ctx;
  const cfg = configMap(pb);
  if (!pb.decision_rules.length) return h('div', { class: 'muted small' }, 'This workflow has no machine-readable decision rules.');
  const edits = new Map();
  const rows = pb.decision_rules.map((r, i) => {
    const w = r.when || {};
    const simple = w.field && w.operator && !w.all && !w.any && !w.not;
    let opCell = h('code', null, describeCondition(w, cfg));
    if (ctx.editable && simple) {
      const opSel = h('select', { class: 'input sm', style: { width: 'auto' } }, OPERATOR_OPTIONS.map((o) => h('option', { value: o, selected: o === w.operator }, o.replace(/_/g, ' '))));
      const valueInput = w.value_ref ? h('span', { class: 'small' }, h('code', { class: 'inline' }, w.value_ref), h('span', { class: 'muted' }, ` = ${JSON.stringify(cfg[String(w.value_ref).replace(/^(config|configuration)\./, '')])}`)) : h('input', { class: 'input sm', style: { width: '120px' }, value: w.value === undefined ? '' : typeof w.value === 'string' ? w.value : JSON.stringify(w.value) });
      const mark = () => edits.set(i, { operator: opSel.value, value: valueInput.tagName === 'INPUT' ? valueInput.value : undefined });
      opSel.addEventListener('change', mark);
      if (valueInput.tagName === 'INPUT') valueInput.addEventListener('input', mark);
      opCell = h('div', { class: 'row nowrap' }, h('code', null, w.field), opSel, valueInput);
    }
    return h('tr', null, h('td', null, h('code', null, r.id)), h('td', null, h('div', { class: 'bold' }, r.name), r.description ? h('div', { class: 'xsmall muted' }, r.description) : null), h('td', null, h('code', null, r.step_id)), h('td', { class: 'num' }, String(r.priority)), h('td', null, opCell), h('td', null, badge('', String(r.result), 'violet')));
  });
  const save = button('Save rules', {
    kind: 'primary',
    size: 'sm',
    ic: 'check',
    onClick: async () => {
      if (!edits.size) {
        toast('No rule changes');
        return;
      }
      const pbEdit = procedureForEdit(pb);
      for (const [i, e] of edits) {
        const w = pbEdit.decision_rules[i].when;
        w.operator = e.operator;
        if (e.value !== undefined) {
          const n = Number(e.value);
          w.value = e.value.trim() !== '' && Number.isFinite(n) ? n : e.value;
        }
      }
      try {
        const res = await api.put(`/api/playbooks/${ctx.id}`, { playbook: pbEdit, change_note: `Decision rules edited (${[...edits.keys()].map((i) => pb.decision_rules[i].id).join(', ')}).`, base_version: ctx.version });
        ctx.afterSave(res, 'Rules saved');
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    },
  });
  return h(
    'div',
    null,
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'ID'), h('th', null, 'Rule'), h('th', null, 'Step'), h('th', { class: 'num' }, 'Priority'), h('th', null, 'Condition'), h('th', null, 'Result'))), h('tbody', null, rows))),
    h('div', { class: 'row between mt-2' }, h('div', { class: 'xsmall muted' }, 'Rules are evaluated in priority order; the first match wins. Thresholds that reference configuration are changed on the Requirements tab.'), ctx.editable ? save : null),
  );
}

export async function render(el, ctx) {
  const { pb, app } = ctx;
  const visual = app.feature('visual_workflow');
  let mode = visual ? 'graph' : 'list';
  let selected = ctx.query.step || (pb.steps[0] && pb.steps[0].id);
  let graph = null;

  const panel = h('div');
  const main = h('div');
  const toolbar = h(
    'div',
    { class: 'row between mb-2' },
    visual
      ? segmented(
          [
            { value: 'graph', label: 'Graph', icon: 'workflow' },
            { value: 'list', label: 'Steps', icon: 'list' },
          ],
          mode,
          (v) => {
            mode = v;
            paint();
          },
        )
      : h('div', { class: 'small muted' }, 'Visual Workflow is off in Settings — showing the step list.'),
    h('div', { class: 'row' }, h('span', { class: 'small muted' }, `${pb.steps.length} steps · ${pb.decision_rules.length} decision rules`), button('Edit JSON', { size: 'sm', ic: 'code', onClick: () => openJsonEditor(ctx) })),
  );

  const showStep = (id) => {
    selected = id;
    clear(panel).append(card({ title: 'Step definition', icon: 'info', cls: 'step-panel', body: stepDetail(pb.steps.find((s) => s.id === id), pb) }));
  };

  function listView() {
    return card({
      tight: true,
      body: h(
        'div',
        null,
        pb.steps.map((s, i) =>
          h(
            'div',
            { class: `step-list-item ${s.id === selected ? 'selected' : ''}`, onClick: () => { selected = s.id; paint(); }, tabindex: '0', onKeydown: (e) => { if (e.key === 'Enter') { selected = s.id; paint(); } } },
            h('span', { class: 'step-num' }, i + 1),
            h('div', { style: { minWidth: 0 } }, h('div', { class: 'row nowrap' }, typeSwatch(s.type), h('span', { class: 'bold' }, s.name), h('span', { class: 'xsmall muted' }, `${s.id} · ${s.type}`)), h('div', { class: 'small text-2' }, s.purpose), s.dependencies.length ? h('div', { class: 'xsmall muted mt-1' }, `after ${s.dependencies.join(', ')}`) : h('div', { class: 'xsmall muted mt-1' }, 'entry step'), s.decision_logic.length ? h('div', { class: 'row mt-1' }, s.decision_logic.map((b) => badge('', `${b.result} → ${[].concat(b.next || []).join(', ') || 'end'}`, 'violet'))) : null),
          ),
        ),
      ),
    });
  }

  function paint() {
    if (graph) {
      graph.destroy();
      graph = null;
    }
    clear(main);
    if (mode === 'graph') {
      graph = workflowGraph(pb, { selected, height: 'auto', onSelect: (s) => showStep(s.id) });
      main.append(graph.el);
      if (graph.issues.length) main.append(h('div', { class: 'banner fail mt-2' }, icon('alert'), h('div', { class: 'banner-body small' }, graph.issues.map((i) => h('div', null, i.message)))));
    } else main.append(listView());
    showStep(selected);
  }

  el.append(
    toolbar,
    h('div', { class: 'graph-layout' }, main, panel),
    h('div', { class: 'mt-3' }),
    card({ title: 'Decision rules', icon: 'compare', hint: 'Machine-readable (spec §18)', body: rulesEditor(ctx) }),
  );
  paint();
  return () => graph && graph.destroy();
}
