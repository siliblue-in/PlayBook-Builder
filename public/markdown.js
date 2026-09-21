// Safe Markdown → DOM renderer (no innerHTML). Covers what the Playbook
// Markdown export uses: headings, paragraphs, lists (nested), tables, fenced
// code, blockquotes, rules, bold/italic/code/links.
import { h } from './ui.js';

function inline(text) {
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(_[^_\s][^_]*_)|(\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m;
  const s = String(text).replace(/\\\|/g, '|');
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const tok = m[0];
    if (m[1]) out.push(h('code', null, tok.slice(1, -1)));
    else if (m[2]) out.push(h('strong', null, inline(tok.slice(2, -2))));
    else if (m[3]) {
      const label = tok.slice(1, tok.indexOf(']('));
      out.push(h('a', { href: m[4], target: '_blank', rel: 'noopener noreferrer' }, label));
    } else out.push(h('em', null, inline(tok.slice(1, -1))));
    last = m.index + tok.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (t[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** Parse list items starting at index i; returns [element, nextIndex]. */
function parseList(lines, i, indent) {
  const ordered = /^\s*\d+[.)]\s/.test(lines[i]);
  const list = h(ordered ? 'ol' : 'ul');
  while (i < lines.length) {
    const line = lines[i];
    const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!m) break;
    const ind = m[1].length;
    if (ind < indent) break;
    if (ind > indent) {
      const [sub, next] = parseList(lines, i, ind);
      (list.lastElementChild || list).appendChild(sub);
      i = next;
      continue;
    }
    const li = h('li', null, inline(m[3].replace(/^\[( |x)\]\s+/, (_, c) => (c === 'x' ? '☑ ' : '☐ '))));
    list.appendChild(li);
    i++;
    // Continuation lines (indented text that is not a list item).
    while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
      li.appendChild(document.createTextNode(' '));
      li.append(...inline(lines[i].trim()));
      i++;
    }
  }
  return [list, i];
}

/**
 * Render markdown into a container element.
 * opts.renderMermaid(code) -> Node|null : replace ```mermaid blocks (e.g. with the live workflow graph).
 */
export function renderMarkdown(src, opts = {}) {
  const root = h('div', { class: 'markdown' });
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let para = [];
  const flush = () => {
    if (para.length) {
      root.appendChild(h('p', null, inline(para.join(' '))));
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const lang = line.slice(3).trim();
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      const text = code.join('\n');
      const custom = lang === 'mermaid' && opts.renderMermaid ? opts.renderMermaid(text) : null;
      root.appendChild(custom || h('pre', null, h('code', { class: lang ? `lang-${lang}` : null }, text)));
      continue;
    }
    const hm = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hm) {
      flush();
      root.appendChild(h(`h${hm[1].length}`, null, inline(hm[2])));
      i++;
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      flush();
      root.appendChild(h('hr'));
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      root.appendChild(h('blockquote', null, inline(quote.join(' '))));
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
      root.appendChild(
        h('table', null, h('thead', null, h('tr', null, head.map((c) => h('th', null, inline(c))))), h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => h('td', null, inline(c))))))),
      );
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const [list, next] = parseList(lines, i, (/^(\s*)/.exec(line) || ['', ''])[1].length);
      root.appendChild(list);
      i = next;
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return root;
}
