// Playbooks library: filter by lifecycle status, search, import a package or JSON.
import { api } from '../api.js';
import { h, icon, clear, pageHead, card, button, badge, empty, ago, pct, modal, toast, errorMessage, jsonEditor, fileToBase64, formatBytes } from '../ui.js';

const FILTERS = [
  ['all', 'All'],
  ['draft', 'Draft'],
  ['testing', 'Testing'],
  ['passed', 'Passed'],
  ['warning', 'Warnings'],
  ['failed', 'Failed'],
  ['published', 'Published'],
  ['production', 'Production'],
];

/**
 * Import Playbook: a package (.zip) or a playbook JSON file,
 * or pasted JSON. The server validates it first; nothing is run or called.
 */
function importDialog(app) {
  let chosen = null;
  const editor = jsonEditor('{\n  "name": "",\n  "objective": "",\n  "steps": []\n}', { rows: 12 });
  const fileInput = h('input', { type: 'file', accept: '.zip,.json,application/zip,application/json', style: { display: 'none' } });
  const fileLabel = h('div', { class: 'small text-2' }, 'No file chosen');
  const drop = h(
    'div',
    { class: 'ws-drop-hint import-drop' },
    icon('package'),
    h('div', null, h('div', { class: 'bold small' }, 'Drop a playbook package (.zip) or a .playbook.json file'), fileLabel),
    button('Choose file', { size: 'sm', onClick: () => fileInput.click() }),
  );
  const setFile = (f) => {
    if (!f) return;
    chosen = f;
    fileLabel.textContent = `${f.name} · ${formatBytes(f.size)}`;
  };
  fileInput.addEventListener('change', () => setFile(fileInput.files && fileInput.files[0]));
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('drop-target');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('drop-target'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drop-target');
    setFile(e.dataTransfer.files && e.dataTransfer.files[0]);
  });
  const status = h('div', { class: 'small' });
  modal({
    title: 'Import Playbook',
    wide: true,
    body: h(
      'div',
      null,
      h('p', { class: 'small text-2', style: { marginTop: 0 } }, 'A package brings the playbook, its intent, its test suite and its input files into a new workspace folder. The import is checked first, starts as a draft, and nothing in it is run or called.'),
      fileInput,
      drop,
      h('details', { class: 'collapsible mt-2' }, h('summary', { class: 'small' }, 'Or paste playbook JSON'), h('div', { class: 'mt-1' }, editor.el)),
      status,
    ),
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Import',
        kind: 'primary',
        icon: 'upload',
        onClick: async (close) => {
          let payload;
          try {
            if (chosen) payload = { filename: chosen.name, content_base64: await fileToBase64(chosen) };
            else {
              const pb = editor.get();
              payload = { filename: 'pasted.playbook.json', content_base64: btoa(unescape(encodeURIComponent(JSON.stringify(pb)))) };
            }
          } catch (err) {
            toast(`Invalid JSON: ${err.message}`, 'error');
            return;
          }
          status.replaceChildren(h('span', { class: 'row' }, h('span', { class: 'spinner' }), 'Checking and importing…'));
          try {
            const r = await api.post('/api/playbooks/import', payload);
            close();
            modal({
              title: `Imported: ${r.name}`,
              body: h(
                'div',
                { class: 'stack-sm' },
                h('div', { class: 'small' }, 'Workspace folder: ', h('code', { class: 'inline' }, r.folder || '—')),
                h('ul', { class: 'check-list small' }, r.imported.map((x) => h('li', null, icon('check'), x))),
                r.skipped.length ? h('div', { class: 'small text-2' }, h('div', { class: 'bold' }, 'Not imported'), h('ul', { class: 'bullets' }, r.skipped.map((x) => h('li', null, x)))) : null,
                r.warnings.length ? h('div', { class: 'small', style: { color: 'var(--warn)' } }, r.warnings.join(' ')) : null,
                h('div', { class: 'small text-2' }, 'Nothing was run. Review the playbook and run its tests before you publish it.'),
              ),
              actions: [{ label: 'Open playbook', kind: 'primary', onClick: (c) => { c(); app.navigate(`/playbooks/${r.playbook_id}`); } }],
            });
          } catch (err) {
            status.replaceChildren(h('span', { style: { color: 'var(--fail)' } }, errorMessage(err)));
          }
        },
      },
    ],
  });
}

export async function render(el, { app, query }) {
  const data = await api.get('/api/playbooks');
  let filter = query.status || 'all';
  let search = '';
  const list = data.playbooks;

  el.append(
    pageHead({
      title: 'Playbooks',
      subtitle: 'Every playbook is a versioned, testable procedure. Drafts can be edited freely; published versions are immutable.',
      actions: [button('Import Playbook', { ic: 'upload', onClick: () => importDialog(app) }), button('Create Playbook', { kind: 'primary', ic: 'sparkles', href: '#/create' })],
    }),
  );

  const chips = h('div', { class: 'row' });
  const searchBox = h('input', { class: 'input', placeholder: 'Search playbooks…', style: { maxWidth: '280px' }, 'aria-label': 'Search playbooks' });
  const tableHost = h('div');
  el.append(h('div', { class: 'row between mb-2' }, chips, searchBox), card({ tight: true, body: tableHost }));

  function paintChips() {
    clear(chips);
    for (const [k, label] of FILTERS) {
      const n = k === 'all' ? list.length : list.filter((p) => p.status === k).length;
      chips.append(h('button', { type: 'button', class: `chip ${filter === k ? 'active' : ''}`, onClick: () => { filter = k; paint(); } }, label, h('span', { class: 'muted' }, String(n))));
    }
  }

  function paint() {
    paintChips();
    const q = search.toLowerCase();
    const rows = list.filter((p) => (filter === 'all' || p.status === filter) && (!q || `${p.name} ${p.objective}`.toLowerCase().includes(q)));
    clear(tableHost);
    if (!rows.length) {
      tableHost.append(list.length ? empty('search', 'No playbooks match') : empty('book', 'No playbooks yet', 'Describe a goal and the builder will compile a detailed playbook.', button('Create Playbook', { kind: 'primary', href: '#/create' })));
      return;
    }
    tableHost.append(
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'table' },
          h('thead', null, h('tr', null, h('th', null, 'Playbook'), h('th', null, 'Version'), h('th', null, 'Status'), h('th', null, 'Latest test'), h('th', { class: 'num' }, 'Accuracy'), h('th', { class: 'num' }, 'Consistency'), h('th', { class: 'num' }, 'Steps'), h('th', { class: 'num' }, 'Tests'), h('th', { class: 'num' }, 'Updated'))),
          h(
            'tbody',
            null,
            rows.map((p) =>
              h(
                'tr',
                { class: 'clickable', onClick: () => app.navigate(`/playbooks/${p.id}`) },
                h('td', null, h('div', { class: 'cell-title row nowrap' }, p.name, p.example_key ? h('span', { class: 'badge accent' }, 'Example') : null), h('div', { class: 'cell-sub' }, p.objective)),
                h('td', null, h('span', { class: 'badge outline' }, `v${p.current_version}`), p.production_version && p.production_version !== p.current_version ? h('div', { class: 'xsmall muted mt-1' }, `prod v${p.production_version}`) : null),
                h('td', null, badge(p.status), p.quality_gate_passed ? null : h('div', { class: 'xsmall mt-1', style: { color: 'var(--fail)' } }, 'Quality gate not passed')),
                h('td', null, p.last_test ? h('div', { class: 'row nowrap' }, badge(p.last_test.status), p.stale ? h('span', { class: 'badge warning', title: 'Changed since last test' }, icon('alert'), 'stale') : null) : p.stale ? h('span', { class: 'badge warning' }, icon('alert'), 'untested change') : h('span', { class: 'muted small' }, '—')),
                h('td', { class: 'num' }, p.last_test && p.last_test.metrics ? pct(p.last_test.metrics.accuracy) : '—'),
                h('td', { class: 'num' }, p.last_test && p.last_test.metrics ? pct(p.last_test.metrics.consistency) : '—'),
                h('td', { class: 'num' }, p.steps),
                h('td', { class: 'num' }, p.tests),
                h('td', { class: 'num small muted' }, ago(p.updated_at)),
              ),
            ),
          ),
        ),
      ),
    );
  }
  searchBox.addEventListener('input', () => {
    search = searchBox.value;
    paint();
  });
  paint();
}
