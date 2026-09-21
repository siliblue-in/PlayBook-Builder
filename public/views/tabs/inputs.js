// Inputs tab (spec §11): definitions, validation, examples, sample run input.
import { h, card, badge, button, kv, jsonView, copyText, title } from '../../ui.js';

export function sampleInput(pb) {
  const o = {};
  for (const i of pb.inputs || []) if (i.example !== undefined) o[i.id] = i.example;
  return o;
}

export async function render(el, ctx) {
  const { pb } = ctx;
  const sample = sampleInput(pb);
  el.append(
    h(
      'div',
      { class: 'grid sidebar-right' },
      h(
        'div',
        { class: 'stack' },
        pb.inputs.length
          ? pb.inputs.map((i) =>
              card({
                title: i.name,
                icon: 'database',
                actions: [badge(i.required ? 'accent' : '', i.required ? 'Required' : 'Optional', i.required ? 'accent' : 'outline')],
                body: h(
                  'div',
                  null,
                  i.description ? h('p', { style: { marginTop: 0 } }, i.description) : null,
                  kv([['ID', h('code', { class: 'inline' }, i.id)], ['Type', i.type], ['Source', i.source]]),
                  h('div', { class: 'section-label' }, 'Validation'),
                  i.validation.length ? h('ul', { class: 'bullets' }, i.validation.map((v) => h('li', null, v))) : h('div', { class: 'muted small' }, 'No validation rules.'),
                  i.example !== undefined ? h('div', null, h('div', { class: 'section-label' }, 'Example'), jsonView(i.example, { cls: 'short' })) : null,
                  i.schema ? h('details', { class: 'collapsible mt-2' }, h('summary', { class: 'small' }, 'JSON Schema'), h('div', { class: 'mt-1' }, jsonView(i.schema, { cls: 'short' }))) : null,
                ),
              }),
            )
          : card({ body: h('div', { class: 'muted' }, 'No inputs defined.') }),
      ),
      card({
        title: 'Sample run input',
        icon: 'code',
        hint: 'Built from the examples',
        body: h('div', null, jsonView(sample), h('div', { class: 'row mt-2' }, button('Copy', { size: 'sm', ic: 'copy', onClick: () => copyText(JSON.stringify(sample, null, 2)) }), button('Run with this input', { size: 'sm', kind: 'primary', ic: 'play', onClick: () => ctx.go('runs') }))),
      }),
    ),
  );
}

export { title };
