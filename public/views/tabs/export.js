// Export tab (spec §33–§36, §59): in-app Markdown container (preview / raw /
// fullscreen / copy / download), PDF, and the canonical JSON.
import { api } from '../../api.js';
import { h, icon, clear, card, button, segmented, copyText, downloadText, jsonView, banner } from '../../ui.js';
import { renderMarkdown } from '../../markdown.js';
import { workflowGraph } from '../../components/graph.js';

export async function render(el, ctx) {
  const { app, pb } = ctx;
  const v = ctx.version;
  const slug = String(pb.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'playbook';
  const cleanups = [];

  if (app.feature('markdown_export')) {
    const md = await api.text(`/api/playbooks/${ctx.id}/markdown?version=${v}`);
    let mode = 'preview';
    const scroll = h('div', { class: 'md-scroll' });
    const container = h('div', { class: 'md-container' });
    const paint = () => {
      clear(scroll);
      if (mode === 'raw') scroll.append(h('pre', { class: 'md-raw' }, md));
      else
        scroll.append(
          renderMarkdown(md, {
            renderMermaid: () => {
              if (!app.feature('visual_workflow')) return null;
              const g = workflowGraph(pb, { height: 520, legend: false, interactive: false });
              cleanups.push(() => g.destroy());
              return h('div', { class: 'md-diagram' }, g.el);
            },
          }),
        );
    };
    const fullBtn = button('Fullscreen', { size: 'sm', ic: 'maximize' });
    const toggleFull = () => {
      const on = !container.classList.contains('fullscreen');
      container.classList.toggle('fullscreen', on);
      fullBtn.replaceChildren(icon(on ? 'minimize' : 'maximize'), on ? 'Exit fullscreen' : 'Fullscreen');
    };
    fullBtn.addEventListener('click', toggleFull);
    const onKey = (e) => {
      if (e.key === 'Escape' && container.classList.contains('fullscreen')) toggleFull();
    };
    document.addEventListener('keydown', onKey);
    cleanups.push(() => document.removeEventListener('keydown', onKey));
    container.append(
      h(
        'div',
        { class: 'md-toolbar' },
        h('span', { class: 'file-name' }, icon('file'), `${slug}-v${v}.md`),
        segmented(
          [
            { value: 'preview', label: 'Preview', icon: 'eye' },
            { value: 'raw', label: 'Raw', icon: 'code' },
          ],
          mode,
          (m) => {
            mode = m;
            paint();
          },
        ),
        h('span', { class: 'spacer' }),
        fullBtn,
        button('Copy', { size: 'sm', ic: 'copy', onClick: () => copyText(md, 'Markdown copied') }),
        button('Download .md', { size: 'sm', ic: 'download', onClick: () => downloadText(md, `${slug}-v${v}.md`, 'text/markdown') }),
        app.feature('pdf_export') ? button('Download PDF', { size: 'sm', ic: 'download', kind: 'primary', href: `/api/playbooks/${ctx.id}/pdf?version=${v}&download=1` }) : null,
      ),
      scroll,
    );
    paint();
    el.append(container);
  } else {
    el.append(banner('info', 'Markdown export is off', 'Turn it on in Settings to preview the playbook document here.'));
  }

  const row = h('div', { class: 'grid two mt-3' });
  if (app.feature('pdf_export')) {
    row.append(
      card({
        title: 'PDF',
        icon: 'file',
        body: h(
          'div',
          null,
          h('p', { class: 'small text-2', style: { marginTop: 0 } }, 'Cover, objective, requirements, dependencies, tools, inputs, the visual workflow, every step in detail, decision rules, output, validation, error handling, success criteria, test cases, latest test results and version history.'),
          h('div', { class: 'row' }, button('Open PDF', { ic: 'eye', href: `/api/playbooks/${ctx.id}/pdf?version=${v}` }), button('Download PDF', { ic: 'download', kind: 'primary', href: `/api/playbooks/${ctx.id}/pdf?version=${v}&download=1` })),
        ),
      }),
    );
  }
  if (app.feature('json_export')) {
    const jsonHost = h('div');
    let shown = false;
    let json = null;
    const load = async () => {
      if (!json) json = await api.text(`/api/playbooks/${ctx.id}/json?version=${v}`);
      return typeof json === 'string' ? json : JSON.stringify(json, null, 2);
    };
    const viewBtn = button('View JSON', {
      ic: 'eye',
      onClick: async () => {
        try {
          const text = await load();
          shown = true;
          clear(jsonHost);
          jsonHost.append(h('div', { class: 'mt-2' }, jsonView(text, { cls: 'tall' })));
          viewBtn.replaceChildren(icon('eye'), 'Hide JSON');
        } catch (err) {
          shown = false;
          clear(jsonHost);
          viewBtn.replaceChildren(icon('eye'), 'View JSON');
          toast(errorMessage(err), 'error');
        }
      },
    });
    row.append(
      card({
        title: 'JSON',
        icon: 'code',
        body: h(
          'div',
          null,
          h('p', { class: 'small text-2', style: { marginTop: 0 } }, 'The canonical, machine-readable playbook (schema 1.0) — importable and executable by another engine.'),
          h('div', { class: 'row' }, viewBtn, button('Copy JSON', { ic: 'copy', onClick: async () => {
            try {
              copyText(await load(), 'JSON copied');
            } catch (err) {
              toast(errorMessage(err), 'error');
            }
          } }), button('Download JSON', { ic: 'download', kind: 'primary', href: `/api/playbooks/${ctx.id}/json?version=${v}&download=1` })),
          jsonHost,
        ),
      }),
    );
  }
  if (row.children.length) el.append(row);
  return () => cleanups.forEach((fn) => fn());
}
