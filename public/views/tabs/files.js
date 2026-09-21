// Files tab: the playbook's own workspace folder — browse, preview,
// copy, download, rename, delete, duplicate, add input files, download the
// whole playbook as a package.
import { api } from '../../api.js';
import { h, icon, clear, card, button, badge, banner, toast, errorMessage, modal, confirmDialog, jsonView, copyText, fileToBase64, formatBytes, when } from '../../ui.js';
import { renderMarkdown } from '../../markdown.js';

const FOLDER_HELP = {
  '': 'Everything about this playbook in one folder.',
  playbook: 'The playbook itself. playbook.json is canonical; the Markdown and PDF are generated from it.',
  requirements: 'What was asked for: the confirmed intent, the requirements and the assumptions.',
  process: 'How the playbook works: workflow, dependencies, tools, configuration and the execution plan.',
  inputs: 'Your data, kept in three separate places so test data never mixes with real data.',
  'inputs/sample': 'Examples that show the input format. Sandbox runs can use them.',
  'inputs/test': 'Data for testing only. Production runs never read it.',
  'inputs/runtime': 'Real data for runs — the only input folder production runs can read.',
  tests: 'The test suite, one file per test case, repeatability runs and test reports.',
  'tests/test-cases': 'One file per test case, named after the test.',
  'tests/repeatability': 'Every run of the latest repeatability test.',
  'tests/reports': 'latest.json / latest.md, plus the history of every test run.',
  results: 'The latest result, the history of results and summaries of all runs.',
  'results/latest': 'The most recent finished run.',
  'results/history': 'One folder per finished run, by date.',
  'results/summaries': 'Tables of all runs (runs.json) and test runs (tests.json).',
  executions: 'One folder per run: input, step results, output and a readable report.',
  exports: 'Markdown, PDF and JSON exports of the current version.',
  metadata: 'Version, settings (never secrets) and the activity log.',
  versions: 'A snapshot of every version. Each execution names the version it used.',
};

const TEXT_EXT = ['.json', '.md', '.txt', '.csv', '.tsv', '.log', '.yaml', '.yml'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
const ext = (name) => (name.match(/\.[^.]+$/) || [''])[0].toLowerCase();

function parseCsv(text, max = 200) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < max; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === '\t') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) row.push(cell);
  if (row.length) rows.push(row);
  return rows;
}

export async function render(el, ctx) {
  const { id, app } = ctx;
  let ws = null;
  let selected = ctx.query.path || '';
  const expanded = new Set(['playbook', 'inputs']);
  for (let p = selected; p.includes('/'); p = p.slice(0, p.lastIndexOf('/'))) expanded.add(p.slice(0, p.lastIndexOf('/')));
  if (selected) expanded.add(selected);

  const headerHost = h('div');
  const treeHost = h('div', { class: 'ws-tree' });
  const previewHost = h('div');
  const fileUrl = (p, download = false) => `/api/playbooks/${id}/workspace/file?path=${encodeURIComponent(p)}${download ? '&download=1' : ''}`;

  function findNode(p, nodes = ws ? ws.tree : []) {
    for (const n of nodes) {
      if (n.path === p) return n;
      if (n.children) {
        const f = findNode(p, n.children);
        if (f) return f;
      }
    }
    return null;
  }

  async function load() {
    ws = await api.get(`/api/playbooks/${id}/workspace`);
    if (selected && !findNode(selected)) selected = '';
    paint();
  }

  /** Rewrite the files generated from the playbook (brings back a deleted one), then reload. */
  async function refresh() {
    try {
      await api.post(`/api/playbooks/${id}/workspace/sync`);
      await load();
      toast('The workspace is up to date');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  // ------------------------------------------------------------ uploads (the user picks sample, test or runtime)
  function chooseCategory(files) {
    return new Promise((resolve) => {
      let choice = null;
      const opts = Object.entries(ws.input_categories).map(([key, help]) => {
        const input = h('input', { type: 'radio', name: 'ws-cat', value: key });
        input.addEventListener('change', () => {
          choice = key;
          for (const o of opts) o.classList.toggle('selected', o.querySelector('input').checked);
          go.disabled = false;
        });
        return h('label', { class: 'choice-row' }, input, h('div', null, h('div', { class: 'bold small' }, `${key[0].toUpperCase()}${key.slice(1)}  `, h('code', { class: 'inline' }, `inputs/${key}`)), h('div', { class: 'xsmall text-2' }, help)));
      });
      const go = button('Add files', { kind: 'primary', ic: 'upload', disabled: true });
      const m = modal({
        title: `Add ${files.length} file${files.length === 1 ? '' : 's'} to this playbook`,
        body: h('div', { class: 'stack-sm' }, h('p', { class: 'small text-2', style: { marginTop: 0 } }, 'Where do these files belong? Uploaded files are never treated as real run data unless you put them in Runtime.'), opts, h('div', { class: 'xsmall muted' }, files.map((f) => f.name).join(', '))),
        actions: [{ label: 'Cancel', onClick: (c) => { c(); resolve(null); } }, go],
        onClose: () => resolve(choice && go.dataset.done ? choice : null),
      });
      go.addEventListener('click', () => {
        go.dataset.done = '1';
        resolve(choice);
        m.close();
      });
    });
  }

  async function upload(files, category) {
    if (!files.length) return;
    const cat = category || (await chooseCategory(files));
    if (!cat) return;
    let last = null;
    for (const f of files) {
      try {
        const r = await api.post(`/api/playbooks/${id}/workspace/upload`, { folder: `inputs/${cat}`, name: f.name, content_base64: await fileToBase64(f) });
        last = r.path;
      } catch (err) {
        toast(`${f.name}: ${errorMessage(err)}`, 'error');
      }
    }
    if (last) {
      toast(`${files.length === 1 ? last : `${files.length} files`} added to inputs/${cat}`);
      expanded.add('inputs');
      expanded.add(`inputs/${cat}`);
      selected = last;
      await load();
    }
  }

  const picker = h('input', { type: 'file', multiple: true, style: { display: 'none' } });
  let pickerCategory = null;
  picker.addEventListener('change', () => {
    const files = [...(picker.files || [])];
    picker.value = '';
    upload(files, pickerCategory);
  });
  const pick = (category = null) => {
    pickerCategory = category;
    picker.click();
  };

  // ------------------------------------------------------------ file actions
  async function act(kind, node) {
    try {
      if (kind === 'duplicate') {
        const r = await api.post(`/api/playbooks/${id}/workspace/duplicate`, { path: node.path });
        selected = r.path;
        toast(`Duplicated as ${r.path.split('/').pop()}`);
      } else if (kind === 'rename') {
        const input = h('input', { class: 'input', value: node.name });
        const r = await new Promise((resolve) => {
          modal({
            title: `Rename ${node.type === 'dir' ? 'folder' : 'file'}`,
            body: h('div', { class: 'field' }, h('label', null, 'New name'), input),
            actions: [
              { label: 'Cancel', onClick: (c) => { c(); resolve(null); } },
              { label: 'Rename', kind: 'primary', onClick: async (c) => {
                try {
                  const res = await api.post(`/api/playbooks/${id}/workspace/rename`, { path: node.path, name: input.value });
                  c();
                  resolve(res);
                } catch (err) {
                  toast(errorMessage(err), 'error');
                }
              } },
            ],
          });
          setTimeout(() => input.select(), 40);
        });
        if (!r) return;
        selected = r.path;
        toast('Renamed');
      } else if (kind === 'delete') {
        const what = node.type === 'dir' ? 'folder and everything in it' : 'file';
        const text =
          node.kind === 'critical' || node.kind === 'generated'
            ? `${node.path} is generated from the playbook. Refresh, or the next change to the playbook, recreates it.`
            : node.kind === 'history'
              ? `${node.path} is part of this playbook's history. Deleting it removes the saved files; the Runs and Test Center lists are not changed.`
              : `This deletes ${node.path} from the workspace. It cannot be undone.`;
        if (!(await confirmDialog({ title: `Delete this ${what}?`, text, confirm: 'Delete', danger: true }))) return;
        await api.post(`/api/playbooks/${id}/workspace/delete`, { path: node.path, confirm: true });
        selected = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
        toast('Deleted');
      }
      await load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  // ------------------------------------------------------------ header: workspace storage vs AI transport
  function paintHeader() {
    const localOnly = ws.privacy_mode === 'local_only';
    const t = ws.ai || {};
    const provider = (app.meta.providers || []).find((p) => p.id === t.provider);
    const aiLine =
      t.transport === 'local'
        ? `AI requests go to ${provider ? provider.label : 'a local model'} on this computer${t.model ? ` (${t.model})` : ''}.`
        : t.transport === 'cloud'
          ? `AI requests go to ${provider ? provider.label : 'a cloud provider'}${t.model ? ` (${t.model})` : ''}. Only the requests you run are sent; the files stay in this folder.`
          : 'No AI connection is used: deterministic runs and tests work without one.';
    clear(headerHost).append(
      card({
        title: 'Playbook Workspace',
        icon: 'folder',
        actions: [localOnly ? badge('', '🔒 Local Workspace', 'accent') : badge('', 'Stored on this computer', 'outline'), badge('', `${ws.files} files · ${formatBytes(ws.bytes)}`, 'outline')],
        body: h(
          'div',
          null,
          h('div', { class: 'small text-2' }, 'All Playbook files, test artifacts, process definitions and execution results are organized under this Playbook.'),
          h('div', { class: 'row mt-2 nowrap' }, icon('folder'), h('span', { class: 'ws-path' }, ws.root)),
          h(
            'div',
            { class: 'ws-transport mt-2' },
            h('div', null, h('span', { class: 'bold small' }, 'Workspace storage  '), h('span', { class: 'small text-2' }, localOnly ? 'This computer only (Privacy Mode: Local Only).' : 'This computer.')),
            h('div', null, h('span', { class: 'bold small' }, 'AI transport  '), h('span', { class: 'small text-2' }, aiLine)),
          ),
          h(
            'div',
            { class: 'row mt-2' },
            button('Download Playbook Package', { kind: 'primary', ic: 'package', href: `/api/playbooks/${id}/package` }),
            button('Add input files', { ic: 'upload', onClick: () => pick() }),
            ws.can_open_folder ? button('Open folder', { ic: 'external', onClick: async () => { try { const r = await api.post(`/api/playbooks/${id}/workspace/open`); toast(r.opened ? 'Opened in your file manager' : 'Could not open a file manager here — the path is shown above'); } catch (err) { toast(errorMessage(err), 'error'); } } }) : null,
            button('Copy path', { ic: 'copy', onClick: () => copyText(ws.root, 'Path copied') }),
            h('span', { class: 'spacer' }),
            button('Refresh', { ic: 'refresh', size: 'sm', onClick: refresh }),
          ),
        ),
      }),
    );
  }

  // ------------------------------------------------------------ tree
  function nodeEl(n, depth) {
    const isDir = n.type === 'dir';
    const open = expanded.has(n.path);
    const row = h(
      'button',
      {
        type: 'button',
        class: `ws-node${n.path === selected ? ' selected' : ''}`,
        'data-path': n.path,
        title: n.path,
        onClick: () => {
          if (isDir) {
            if (open && n.path === selected) expanded.delete(n.path);
            else expanded.add(n.path);
          }
          selected = n.path;
          paintTree();
          paintPreview();
        },
      },
      h('span', { class: 'twisty' }, isDir ? (open ? '▾' : '▸') : ''),
      icon(isDir ? (open ? 'folderOpen' : 'folder') : 'file'),
      h('span', { class: 'ws-name' }, n.name),
      isDir ? (n.children && n.children.length ? h('span', { class: 'ws-size' }, String(n.children.length)) : h('span', { class: 'ws-size' }, 'empty')) : h('span', { class: 'ws-size' }, formatBytes(n.size)),
    );
    // Drop straight onto inputs/sample, inputs/test or inputs/runtime.
    const cat = /^inputs\/(sample|test|runtime)$/.exec(n.path);
    if (cat) {
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.add('drop-target');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove('drop-target');
        treeCard.classList.remove('dragging');
        upload([...(e.dataTransfer.files || [])], cat[1]);
      });
    }
    const kids = isDir && open && n.children && n.children.length ? h('div', { class: 'ws-children' }, n.children.map((c) => nodeEl(c, depth + 1))) : null;
    return h('div', null, row, kids);
  }

  function paintTree() {
    clear(treeHost).append(h('div', { class: 'ws-root-label xsmall muted' }, ws.folder), ...ws.tree.map((n) => nodeEl(n, 0)));
    if (ws.truncated) treeHost.append(h('div', { class: 'xsmall muted mt-1' }, 'Showing the first 5,000 items.'));
  }

  // ------------------------------------------------------------ preview
  async function paintPreview() {
    const n = selected ? findNode(selected) : null;
    if (!n || n.type === 'dir') {
      const p = n ? n.path : '';
      const help = FOLDER_HELP[p];
      const cat = /^inputs\/(sample|test|runtime)$/.exec(p);
      const children = n ? n.children || [] : ws.tree;
      clear(previewHost).append(
        card({
          title: n ? n.name : ws.folder,
          icon: 'folderOpen',
          actions: n && n.kind !== 'standard' ? [button('Rename', { size: 'sm', ic: 'edit', onClick: () => act('rename', n) }), button('Delete', { size: 'sm', kind: 'danger', ic: 'trash', onClick: () => act('delete', n) })] : [],
          body: h(
            'div',
            null,
            h('div', { class: 'ws-path xsmall muted mb-1' }, p || '/'),
            help ? h('p', { class: 'small text-2', style: { marginTop: 0 } }, help) : null,
            cat || p === 'inputs' ? h('div', { class: 'ws-drop-hint' }, icon('upload'), h('div', null, h('div', { class: 'bold small' }, 'Drop files here'), h('div', { class: 'xsmall text-2' }, cat ? `They go straight into inputs/${cat[1]}.` : 'You choose Sample, Test or Runtime for each upload.')), button('Choose files', { size: 'sm', onClick: () => pick(cat ? cat[1] : null) })) : null,
            children.length
              ? h(
                  'ul',
                  { class: 'list-clean small mt-2' },
                  children.map((c) => {
                    const count = (c.children || []).length;
                    return h(
                      'li',
                      { class: 'row between nowrap' },
                      h(
                        'div',
                        { style: { minWidth: 0 } },
                        h('a', { style: { cursor: 'pointer' }, onClick: () => { if (c.type === 'dir') expanded.add(c.path); selected = c.path; paintTree(); paintPreview(); } }, icon(c.type === 'dir' ? 'folder' : 'file'), ` ${c.name}`),
                        FOLDER_HELP[c.path] && c.type === 'dir' ? h('div', { class: 'xsmall muted' }, FOLDER_HELP[c.path]) : null,
                      ),
                      h('span', { class: 'xsmall muted', style: { whiteSpace: 'nowrap' } }, c.type === 'dir' ? (count ? `${count} item${count === 1 ? '' : 's'}` : 'empty') : formatBytes(c.size)),
                    );
                  }),
                )
              : h('div', { class: 'small muted mt-2' }, 'This folder is empty.'),
          ),
        }),
      );
      return;
    }
    const e = ext(n.name);
    const kindLabel = { critical: 'Playbook file', generated: 'Generated', history: 'History', user: 'Your file' }[n.kind] || n.kind;
    const actions = [
      button('Open', { size: 'sm', ic: 'external', href: fileUrl(n.path) }),
      TEXT_EXT.includes(e) ? button('Copy', { size: 'sm', ic: 'copy', onClick: async () => { const r = await fetch(fileUrl(n.path)); copyText(await r.text(), 'Copied'); } }) : null,
      button('Download', { size: 'sm', ic: 'download', href: fileUrl(n.path, true) }),
      n.duplicate ? button('Duplicate', { size: 'sm', ic: 'copy', onClick: () => act('duplicate', n) }) : null,
      n.rename ? button('Rename', { size: 'sm', ic: 'edit', onClick: () => act('rename', n) }) : null,
      n.delete ? button('Delete', { size: 'sm', kind: 'danger', ic: 'trash', onClick: () => act('delete', n) }) : null,
    ].filter(Boolean);
    const body = h('div', { class: 'ws-preview' }, h('div', { class: 'loading-page' }, h('span', { class: 'spinner' })));
    clear(previewHost).append(
      card({
        title: n.name,
        icon: 'file',
        actions: [badge('', kindLabel, n.kind === 'user' ? 'ok' : 'outline')],
        body: h('div', null, h('div', { class: 'row between mb-2' }, h('div', { class: 'ws-path xsmall muted' }, `${n.path} · ${formatBytes(n.size)}${n.modified ? ` · ${when(n.modified)}` : ''}`), h('div', { class: 'row' }, actions)), n.kind === 'critical' ? h('div', { class: 'xsmall muted mb-2' }, 'Generated from the playbook. Edit the playbook to change it.') : null, body),
      }),
    );
    try {
      if (e === '.pdf') {
        clear(body).append(h('iframe', { src: fileUrl(n.path), title: n.name }));
      } else if (IMAGE_EXT.includes(e)) {
        clear(body).append(h('img', { src: fileUrl(n.path), alt: n.name }));
      } else if (TEXT_EXT.includes(e)) {
        if (n.size > 2 * 1024 * 1024) {
          clear(body).append(h('div', { class: 'small muted' }, 'This file is large. Download it to view it.'));
          return;
        }
        const text = await (await fetch(fileUrl(n.path))).text();
        if (e === '.json') {
          let v;
          try {
            v = JSON.parse(text);
          } catch {
            v = text;
          }
          clear(body).append(jsonView(v));
        } else if (e === '.md') {
          clear(body).append(h('div', { class: 'md-preview' }, renderMarkdown(text)));
        } else if (e === '.csv' || e === '.tsv') {
          const rows = parseCsv(text);
          clear(body).append(h('div', { class: 'ws-csv' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, (rows[0] || []).map((c) => h('th', null, c)))), h('tbody', null, rows.slice(1).map((r) => h('tr', null, r.map((c) => h('td', { class: 'small' }, c))))))), rows.length >= 200 ? h('div', { class: 'xsmall muted mt-1' }, 'Showing the first 200 rows.') : null);
        } else clear(body).append(h('pre', { class: 'code' }, text));
      } else {
        clear(body).append(h('div', { class: 'small muted' }, 'No preview for this type of file. Download it to open it.'));
      }
    } catch (err) {
      clear(body).append(banner('fail', 'Could not load the file', errorMessage(err)));
    }
  }

  // Drag files anywhere onto the tree: you choose the input folder.
  const treeCard = card({
    title: 'Files',
    icon: 'folder',
    tight: true,
    actions: [button('', { size: 'sm', ic: 'upload', title: 'Add input files', onClick: () => pick() })],
    body: h('div', { class: 'ws-tree-wrap' }, treeHost, h('div', { class: 'ws-drop-foot xsmall muted' }, icon('upload'), 'Drag files here to add them to inputs/')),
  });
  treeCard.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || ![...(e.dataTransfer.types || [])].includes('Files')) return;
    e.preventDefault();
    treeCard.classList.add('dragging');
  });
  treeCard.addEventListener('dragleave', (e) => {
    if (!treeCard.contains(e.relatedTarget)) treeCard.classList.remove('dragging');
  });
  treeCard.addEventListener('drop', (e) => {
    e.preventDefault();
    treeCard.classList.remove('dragging');
    upload([...(e.dataTransfer.files || [])], null);
  });

  function paint() {
    paintHeader();
    paintTree();
    paintPreview();
  }

  el.append(picker, headerHost, h('div', { class: 'grid sidebar-left mt-3' }, treeCard, previewHost));
  await load();
}
