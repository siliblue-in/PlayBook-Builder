// Minimal, dependency-free PDF writer: standard Type 1 fonts (WinAnsi),
// text, rectangles, rounded boxes, lines, Bézier paths, polygons, compressed
// content streams and document outline (bookmarks).
import zlib from 'node:zlib';

// Adobe AFM advance widths (1/1000 em) for codes 32..126.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
// Widths for the WinAnsi specials we emit: [helvetica, bold].
const SPECIAL = {
  0x80: [556, 556], 0x85: [1000, 1000], 0x91: [222, 278], 0x92: [222, 278], 0x93: [333, 500], 0x94: [333, 500], 0x95: [350, 350],
  0x96: [556, 556], 0x97: [1000, 1000], 0x99: [1000, 1000], 0xa0: [278, 278], 0xa7: [556, 556], 0xa9: [737, 737], 0xae: [737, 737],
  0xb0: [400, 400], 0xb1: [584, 584], 0xb7: [278, 278], 0xd7: [584, 584],
};

export const FONTS = {
  F1: { base: 'Helvetica', widths: HELVETICA, bold: false },
  F2: { base: 'Helvetica-Bold', widths: HELVETICA_BOLD, bold: true },
  F3: { base: 'Helvetica-Oblique', widths: HELVETICA, bold: false },
  F4: { base: 'Courier', mono: true },
  F5: { base: 'Courier-Bold', mono: true },
};

const UNICODE_TO_WINANSI = {
  '€': 0x80, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99,
};
const REPLACEMENTS = {
  '→': '->', '⟶': '->', '←': '<-', '↔': '<->', '⇒': '=>', '≥': '>=', '≤': '<=', '≠': '!=', '≈': '~', '✓': 'v', '✔': 'v', '✕': 'x', '✗': 'x', '✘': 'x',
  '⚠': '!', '★': '*', '·': '·', 'ˋ': '`', '−': '-', '‐': '-', '‑': '-', '­': '', '\t': '  ', '′': "'", '″': '"', '▸': '>', '►': '>', '▶': '>', '●': '•', '◦': '-', '○': 'o',
};

/** Convert a JS string to WinAnsi byte values (numbers 0..255). */
export function toWinAnsi(str) {
  const out = [];
  for (const ch of String(str ?? '')) {
    const cp = ch.codePointAt(0);
    if (cp === 10 || cp === 13) continue;
    if (cp >= 32 && cp < 127) {
      out.push(cp);
      continue;
    }
    if (UNICODE_TO_WINANSI[ch]) {
      out.push(UNICODE_TO_WINANSI[ch]);
      continue;
    }
    if (REPLACEMENTS[ch] !== undefined) {
      for (const c of REPLACEMENTS[ch]) {
        const code = c.codePointAt(0);
        out.push(code === 0xb7 ? 0xb7 : UNICODE_TO_WINANSI[c] || (code < 256 ? code : 63));
      }
      continue;
    }
    if (cp >= 0xa0 && cp <= 0xff) {
      out.push(cp);
      continue;
    }
    const stripped = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    if (stripped && stripped.codePointAt(0) < 127) {
      out.push(stripped.codePointAt(0));
      continue;
    }
    out.push(63); // '?'
  }
  return out;
}

const LATIN1_BASE = 'AAAAAAACEEEEIIIIDNOOOOOxOUUUUYPsaaaaaaaceeeeiiiidnooooo/ouuuuypy';

function charWidth(code, font) {
  const f = FONTS[font] || FONTS.F1;
  if (f.mono) return 600;
  if (code >= 32 && code <= 126) return f.widths[code - 32];
  if (SPECIAL[code]) return SPECIAL[code][f.bold ? 1 : 0];
  if (code >= 0xc0 && code <= 0xff) {
    const base = LATIN1_BASE.charCodeAt(code - 0xc0);
    return f.widths[base - 32] || 556;
  }
  return 556;
}

export function measure(str, font = 'F1', size = 10) {
  let w = 0;
  for (const c of toWinAnsi(str)) w += charWidth(c, font);
  return (w * size) / 1000;
}

/** Word-wrap text into lines that fit maxWidth. Long words are broken. */
export function wrap(str, font, size, maxWidth) {
  const lines = [];
  const breakWord = (w) => {
    const chunks = [];
    let chunk = '';
    for (const ch of w) {
      if (chunk && measure(chunk + ch, font, size) > maxWidth) {
        chunks.push(chunk);
        chunk = ch;
      } else chunk += ch;
    }
    if (chunk) chunks.push(chunk);
    return chunks;
  };
  for (const para of String(str ?? '').split(/\r?\n/)) {
    const words = para.split(/(\s+)/).filter((w) => w.length);
    let line = '';
    for (const w of words) {
      if (/^\s+$/.test(w)) {
        if (line) line += w;
        continue;
      }
      const candidate = line + w;
      if (measure(candidate.trimEnd(), font, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line.trim()) lines.push(line.trimEnd());
      line = '';
      if (measure(w, font, size) <= maxWidth) line = w;
      else {
        // Break a token that is wider than the whole line.
        const chunks = breakWord(w);
        lines.push(...chunks.slice(0, -1));
        line = chunks[chunks.length - 1] || '';
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function pdfString(str) {
  const bytes = toWinAnsi(str);
  let s = '(';
  for (const b of bytes) {
    if (b === 40 || b === 41 || b === 92) s += '\\' + String.fromCharCode(b);
    else if (b < 32 || b > 126) s += '\\' + b.toString(8).padStart(3, '0');
    else s += String.fromCharCode(b);
  }
  return s + ')';
}

const n = (v) => (Math.round(v * 100) / 100).toString();

export function hexToRgb(hex) {
  const h = String(hex || '#000').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const v = parseInt(full, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export class PdfDocument {
  constructor({ width = 595.28, height = 841.89, title = 'Document', author = '', subject = '', date = null } = {}) {
    this.width = width;
    this.height = height;
    this.pages = [];
    this.outline = [];
    this.info = { title, author, subject, date };
  }

  addPage() {
    this.pages.push({ ops: [] });
    return this.pages.length - 1;
  }

  get ops() {
    return this.pages[this.pages.length - 1].ops;
  }

  onPage(index) {
    const saved = this.pages;
    return {
      ops: saved[index].ops,
    };
  }

  // Coordinates are top-left based; converted to PDF space here.
  Y(y) {
    return this.height - y;
  }

  fillColor(hex, ops = this.ops) {
    const [r, g, b] = hexToRgb(hex);
    ops.push(`${n(r)} ${n(g)} ${n(b)} rg`);
  }

  strokeColor(hex, ops = this.ops) {
    const [r, g, b] = hexToRgb(hex);
    ops.push(`${n(r)} ${n(g)} ${n(b)} RG`);
  }

  text(str, x, y, { font = 'F1', size = 10, color = '#1a1d23', ops = this.ops } = {}) {
    if (str === undefined || str === null || str === '') return;
    ops.push('BT');
    this.fillColor(color, ops);
    ops.push(`/${font} ${n(size)} Tf`, `${n(x)} ${n(this.Y(y))} Td`, `${pdfString(str)} Tj`, 'ET');
  }

  rect(x, y, w, h, { fill = null, stroke = null, lineWidth = 0.75, radius = 0, ops = this.ops } = {}) {
    ops.push('q');
    if (fill) this.fillColor(fill, ops);
    if (stroke) {
      this.strokeColor(stroke, ops);
      ops.push(`${n(lineWidth)} w`);
    }
    if (radius > 0) this.roundedPath(x, y, w, h, Math.min(radius, w / 2, h / 2), ops);
    else ops.push(`${n(x)} ${n(this.Y(y + h))} ${n(w)} ${n(h)} re`);
    ops.push(fill && stroke ? 'B' : fill ? 'f' : 'S', 'Q');
  }

  roundedPath(x, y, w, h, r, ops = this.ops) {
    const k = 0.5523 * r;
    const X = (v) => n(v);
    const Yp = (v) => n(this.Y(v));
    ops.push(`${X(x + r)} ${Yp(y)} m`);
    ops.push(`${X(x + w - r)} ${Yp(y)} l`);
    ops.push(`${X(x + w - r + k)} ${Yp(y)} ${X(x + w)} ${Yp(y + r - k)} ${X(x + w)} ${Yp(y + r)} c`);
    ops.push(`${X(x + w)} ${Yp(y + h - r)} l`);
    ops.push(`${X(x + w)} ${Yp(y + h - r + k)} ${X(x + w - r + k)} ${Yp(y + h)} ${X(x + w - r)} ${Yp(y + h)} c`);
    ops.push(`${X(x + r)} ${Yp(y + h)} l`);
    ops.push(`${X(x + r - k)} ${Yp(y + h)} ${X(x)} ${Yp(y + h - r + k)} ${X(x)} ${Yp(y + h - r)} c`);
    ops.push(`${X(x)} ${Yp(y + r)} l`);
    ops.push(`${X(x)} ${Yp(y + r - k)} ${X(x + r - k)} ${Yp(y)} ${X(x + r)} ${Yp(y)} c`);
    ops.push('h');
  }

  line(x1, y1, x2, y2, { color = '#d9dde5', width = 0.75, dash = null, ops = this.ops } = {}) {
    ops.push('q');
    this.strokeColor(color, ops);
    ops.push(`${n(width)} w`);
    if (dash) ops.push(`[${dash.join(' ')}] 0 d`);
    ops.push(`${n(x1)} ${n(this.Y(y1))} m`, `${n(x2)} ${n(this.Y(y2))} l`, 'S', 'Q');
  }

  /** Stroke a path of cubic Bézier segments given as [[x0,y0],[c1x,c1y,c2x,c2y,x,y],...]. */
  curve(start, segments, { color = '#8a93a3', width = 1, dash = null, ops = this.ops } = {}) {
    ops.push('q');
    this.strokeColor(color, ops);
    ops.push(`${n(width)} w`, '1 J', '1 j');
    if (dash) ops.push(`[${dash.join(' ')}] 0 d`);
    ops.push(`${n(start[0])} ${n(this.Y(start[1]))} m`);
    for (const s of segments) {
      if (s.length === 2) ops.push(`${n(s[0])} ${n(this.Y(s[1]))} l`);
      else ops.push(`${n(s[0])} ${n(this.Y(s[1]))} ${n(s[2])} ${n(this.Y(s[3]))} ${n(s[4])} ${n(this.Y(s[5]))} c`);
    }
    ops.push('S', 'Q');
  }

  polygon(points, { fill = '#8a93a3', ops = this.ops } = {}) {
    ops.push('q');
    this.fillColor(fill, ops);
    points.forEach(([x, y], i) => ops.push(`${n(x)} ${n(this.Y(y))} ${i ? 'l' : 'm'}`));
    ops.push('h', 'f', 'Q');
  }

  circle(cx, cy, r, { fill = null, stroke = null, lineWidth = 0.75, ops = this.ops } = {}) {
    this.rect(cx - r, cy - r, 2 * r, 2 * r, { fill, stroke, lineWidth, radius: r, ops });
  }

  bookmark(title, pageIndex, y, level = 0) {
    this.outline.push({ title, page: pageIndex, y, level });
  }

  toBuffer() {
    const chunks = [];
    const offsets = [];
    let size = 0;
    const push = (buf) => {
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'latin1');
      chunks.push(b);
      size += b.length;
    };
    const objects = [];
    const alloc = () => {
      objects.push(null);
      return objects.length;
    };
    const catalogId = alloc();
    const pagesId = alloc();
    const fontIds = {};
    for (const key of Object.keys(FONTS)) fontIds[key] = alloc();
    const pageIds = this.pages.map(() => alloc());
    const contentIds = this.pages.map(() => alloc());
    const infoId = alloc();
    const outlineRoot = this.outline.length ? alloc() : null;
    const outlineIds = this.outline.map(() => alloc());

    const body = {};
    body[catalogId] = `<< /Type /Catalog /Pages ${pagesId} 0 R${outlineRoot ? ` /Outlines ${outlineRoot} 0 R /PageMode /UseOutlines` : ''} >>`;
    body[pagesId] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
    for (const [key, f] of Object.entries(FONTS)) {
      body[fontIds[key]] = `<< /Type /Font /Subtype /Type1 /BaseFont /${f.base} /Encoding /WinAnsiEncoding >>`;
    }
    const fontDict = Object.keys(FONTS).map((k) => `/${k} ${fontIds[k]} 0 R`).join(' ');
    this.pages.forEach((p, i) => {
      body[pageIds[i]] = `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n(this.width)} ${n(this.height)}] /Resources << /Font << ${fontDict} >> >> /Contents ${contentIds[i]} 0 R >>`;
      const raw = Buffer.from(p.ops.join('\n'), 'latin1');
      const z = zlib.deflateSync(raw);
      body[contentIds[i]] = Buffer.concat([Buffer.from(`<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), z, Buffer.from('\nendstream', 'latin1')]);
    });
    // A fixed date (the playbook's own timestamp) keeps the file identical when nothing changed.
    const d = this.info.date instanceof Date && !Number.isNaN(this.info.date.getTime()) ? this.info.date : new Date();
    const pad = (v) => String(v).padStart(2, '0');
    const date = `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
    body[infoId] = `<< /Title ${pdfString(this.info.title)} /Author ${pdfString(this.info.author || 'Playbook Builder for AI')} /Subject ${pdfString(this.info.subject || '')} /Creator (Playbook Builder for AI) /Producer (Playbook Builder for AI PDF writer) /CreationDate (${date}) >>`;
    if (outlineRoot) {
      // Two-level outline: level-0 items at the root, level-1 under the previous level-0 item.
      const items = this.outline.map((o, i) => ({ ...o, id: outlineIds[i], children: [] }));
      const roots = [];
      for (const it of items) {
        if (it.level > 0 && roots.length) roots[roots.length - 1].children.push(it);
        else roots.push(it);
      }
      const link = (list, parentId) => {
        list.forEach((it, i) => {
          const parts = [`/Title ${pdfString(it.title)}`, `/Parent ${parentId} 0 R`, `/Dest [${pageIds[it.page]} 0 R /XYZ 0 ${n(this.height - it.y + 8)} null]`];
          if (i > 0) parts.push(`/Prev ${list[i - 1].id} 0 R`);
          if (i < list.length - 1) parts.push(`/Next ${list[i + 1].id} 0 R`);
          if (it.children.length) {
            parts.push(`/First ${it.children[0].id} 0 R`, `/Last ${it.children[it.children.length - 1].id} 0 R`, `/Count ${-it.children.length}`);
            link(it.children, it.id);
          }
          body[it.id] = `<< ${parts.join(' ')} >>`;
        });
      };
      link(roots, outlineRoot);
      body[outlineRoot] = `<< /Type /Outlines /First ${roots[0].id} 0 R /Last ${roots[roots.length - 1].id} 0 R /Count ${roots.length} >>`;
    }

    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    for (let id = 1; id <= objects.length; id++) {
      offsets[id] = size;
      push(`${id} 0 obj\n`);
      push(body[id]);
      push('\nendobj\n');
    }
    const xref = size;
    push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
    for (let id = 1; id <= objects.length; id++) push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
    push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return Buffer.concat(chunks);
  }
}
