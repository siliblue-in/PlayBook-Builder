// PDF export of a playbook (spec §36): cover, objective, requirements,
// dependencies, tools, inputs, visual workflow, detailed steps, decision rules,
// output, validation, error handling, success criteria, tests, results, version.
import { PdfDocument, measure, wrap } from './writer.js';
import { buildGraph, layoutGraph, triggerLabel, topologicalOrder } from '../../shared/graph.js';
import { describeCondition } from '../engine/rules.js';
import { configMap } from '../playbooks/schema.js';

const PAGE = { w: 595.28, h: 841.89, ml: 54, mr: 54, mt: 70, mb: 58 };
const C = {
  text: '#1a1d23',
  muted: '#5b6270',
  faint: '#8a93a3',
  border: '#dfe3ea',
  fill: '#f5f6f9',
  accent: '#4f46e5',
  accentSoft: '#eef0ff',
  pass: '#15803d',
  passSoft: '#e7f5ec',
  warn: '#b45309',
  warnSoft: '#fdf3e2',
  fail: '#b91c1c',
  failSoft: '#fdecec',
  code: '#f4f5f7',
  white: '#ffffff',
};
export const TYPE_COLORS = {
  input: '#2563eb', retrieve: '#2563eb', validate: '#0e7490', transform: '#475569', calculate: '#475569', decision: '#7c3aed',
  action: '#c2410c', approval: '#b45309', generate: '#0f766e', output: '#15803d', notify: '#c2410c', wait: '#64748b', task: '#475569',
};
const STATUS = {
  pass: { label: 'PASS', color: C.pass, soft: C.passSoft },
  warning: { label: 'WARNING', color: C.warn, soft: C.warnSoft },
  fail: { label: 'FAIL', color: C.fail, soft: C.failSoft },
};
const title = (s) => String(s || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const pct = (v) => (typeof v === 'number' ? `${Math.round(v * 1000) / 10}%` : 'n/a');
const short = (v, max = 160) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > max ? `${s.slice(0, max - 1)}…` : s || '';
};

class Flow {
  constructor(doc, header) {
    this.doc = doc;
    this.header = header;
    this.x = PAGE.ml;
    this.width = PAGE.w - PAGE.ml - PAGE.mr;
    this.bottom = PAGE.h - PAGE.mb;
    this.y = PAGE.mt;
  }

  newPage() {
    this.doc.addPage();
    this.y = PAGE.mt;
    if (this.header) {
      this.doc.text(this.header, PAGE.ml, 34, { size: 7.5, color: C.faint });
      const right = 'Playbook Builder for AI · Powered By SiliBlue.in';
      this.doc.text(right, PAGE.w - PAGE.mr - measure(right, 'F1', 7.5), 34, { size: 7.5, color: C.faint });
      this.doc.line(PAGE.ml, 46, PAGE.w - PAGE.mr, 46, { color: C.border, width: 0.6 });
    }
  }

  ensure(h) {
    // Never add a page when we are already at the top of a fresh one.
    if (this.y + h > this.bottom && this.y > PAGE.mt + 1) this.newPage();
  }

  space(h) {
    this.y += h;
  }

  h1(text, bookmark = true, keep = 70) {
    this.ensure(keep);
    if (this.y > PAGE.mt + 4) this.space(12);
    if (bookmark) this.doc.bookmark(text, this.doc.pages.length - 1, this.y, 0);
    this.doc.rect(this.x, this.y + 2, 4, 17, { fill: C.accent, radius: 1.5 });
    this.doc.text(text, this.x + 12, this.y + 15, { font: 'F2', size: 15.5, color: C.text });
    this.y += 30;
  }

  h2(text, bookmark = false) {
    this.ensure(42);
    this.space(4);
    if (bookmark) this.doc.bookmark(text, this.doc.pages.length - 1, this.y, 1);
    this.doc.text(text, this.x, this.y + 11, { font: 'F2', size: 11.2, color: C.text });
    this.y += 18;
  }

  label(text) {
    this.ensure(26);
    this.doc.text(String(text).toUpperCase(), this.x, this.y + 8, { font: 'F2', size: 7.4, color: C.faint });
    this.y += 13;
  }

  para(text, { size = 9.4, font = 'F1', color = C.text, indent = 0, after = 6, width } = {}) {
    const w = (width || this.width) - indent;
    const lh = size * 1.42;
    for (const line of wrap(text, font, size, w)) {
      this.ensure(lh);
      this.doc.text(line, this.x + indent, this.y + size * 0.95, { font, size, color });
      this.y += lh;
    }
    this.y += after;
  }

  /** Mixed-font paragraph: segments [{ text, font, color }]. */
  rich(segments, { size = 9.4, indent = 0, after = 5 } = {}) {
    const w = this.width - indent;
    const lh = size * 1.42;
    const words = [];
    for (const seg of segments) {
      const parts = String(seg.text ?? '').split(/(\s+)/).filter((p) => p.length);
      for (const p of parts) words.push({ text: p, font: seg.font || 'F1', color: seg.color || C.text, space: /^\s+$/.test(p) });
    }
    const lines = [];
    let line = [];
    let lineW = 0;
    for (const word of words) {
      const ww = measure(word.text, word.font, size);
      if (word.space) {
        if (line.length) {
          line.push(word);
          lineW += ww;
        }
        continue;
      }
      if (lineW + ww > w && line.length) {
        while (line.length && line[line.length - 1].space) line.pop();
        lines.push(line);
        line = [];
        lineW = 0;
      }
      if (ww > w) {
        for (const piece of wrap(word.text, word.font, size, w)) {
          if (line.length) {
            lines.push(line);
            line = [];
            lineW = 0;
          }
          line.push({ ...word, text: piece });
          lineW = measure(piece, word.font, size);
        }
        continue;
      }
      line.push(word);
      lineW += ww;
    }
    if (line.length) lines.push(line);
    for (const l of lines) {
      this.ensure(lh);
      let x = this.x + indent;
      for (const word of l) {
        if (!word.space) this.doc.text(word.text, x, this.y + size * 0.95, { font: word.font, size, color: word.color });
        x += measure(word.text, word.font, size);
      }
      this.y += lh;
    }
    this.y += after;
  }

  field(labelText, value, opts = {}) {
    if (value === undefined || value === null || value === '') return;
    this.rich([{ text: `${labelText}: `, font: 'F2' }, { text: String(value) }], opts);
  }

  bullets(items, { size = 9.2, indent = 0, after = 5, marker = '•', color = C.text, font = 'F1' } = {}) {
    const lh = size * 1.42;
    items.forEach((item, i) => {
      const mark = marker === 'number' ? `${i + 1}.` : marker;
      const mw = marker === 'number' ? 16 : 11;
      const lines = wrap(item, font, size, this.width - indent - mw);
      lines.forEach((line, j) => {
        this.ensure(lh);
        if (j === 0) this.doc.text(mark, this.x + indent + (marker === 'number' ? 0 : 2), this.y + size * 0.95, { size, color: marker === 'number' ? C.muted : C.accent, font: marker === 'number' ? 'F2' : 'F1' });
        this.doc.text(line, this.x + indent + mw, this.y + size * 0.95, { size, color, font });
        this.y += lh;
      });
      this.y += 1.5;
    });
    this.y += after;
  }

  table(columns, rows, { size = 8.4, after = 10, zebra = true, headerFill = C.fill } = {}) {
    const total = columns.reduce((s, c) => s + c.w, 0);
    const widths = columns.map((c) => (c.w / total) * this.width);
    const pad = 5;
    const lh = size * 1.36;
    const drawHeader = () => {
      const h = lh + pad * 1.6;
      this.ensure(h + lh * 2);
      this.doc.rect(this.x, this.y, this.width, h, { fill: headerFill });
      let x = this.x;
      columns.forEach((c, i) => {
        this.doc.text(c.label, x + pad, this.y + pad * 0.8 + size * 0.95, { font: 'F2', size: size - 0.4, color: C.muted });
        x += widths[i];
      });
      this.y += h;
    };
    drawHeader();
    rows.forEach((row, ri) => {
      const cells = row.map((v, i) => {
        const font = (columns[i].mono && 'F4') || (columns[i].bold && 'F2') || 'F1';
        const s = columns[i].mono ? size - 0.8 : size;
        return { lines: wrap(v === undefined || v === null ? '' : String(v), font, s, widths[i] - pad * 2), font, s, color: typeof row.colors === 'object' && row.colors[i] ? row.colors[i] : columns[i].color || C.text };
      });
      const h = Math.max(...cells.map((c) => c.lines.length)) * lh + pad * 1.4;
      if (this.y + h > this.bottom) {
        this.newPage();
        drawHeader();
      }
      if (zebra && ri % 2 === 1) this.doc.rect(this.x, this.y, this.width, h, { fill: '#fafbfc' });
      let x = this.x;
      cells.forEach((c, i) => {
        c.lines.forEach((line, j) => this.doc.text(line, x + pad, this.y + pad * 0.7 + j * lh + c.s * 0.95, { font: c.font, size: c.s, color: c.color }));
        x += widths[i];
      });
      this.y += h;
      this.doc.line(this.x, this.y, this.x + this.width, this.y, { color: C.border, width: 0.5 });
    });
    this.y += after;
  }

  code(text, { size = 7.6, maxLines = 80, after = 8 } = {}) {
    const pad = 7;
    const lh = size * 1.34;
    let lines = wrap(text, 'F4', size, this.width - pad * 2);
    if (lines.length > maxLines) lines = lines.slice(0, maxLines).concat(['… (truncated — see the JSON export for the full content)']);
    let i = 0;
    while (i < lines.length) {
      this.ensure(lh * 2 + pad * 2);
      const room = Math.max(1, Math.floor((this.bottom - this.y - pad * 2) / lh));
      const chunk = lines.slice(i, i + room);
      const h = chunk.length * lh + pad * 2;
      this.doc.rect(this.x, this.y, this.width, h, { fill: C.code, stroke: C.border, lineWidth: 0.5, radius: 3 });
      chunk.forEach((line, j) => this.doc.text(line, this.x + pad, this.y + pad + j * lh + size * 0.92, { font: 'F4', size, color: '#2d3340' }));
      this.y += h;
      i += chunk.length;
      if (i < lines.length) this.newPage();
    }
    this.y += after;
  }

  callout(text, { kind = 'info', heading = '', size = 9.2, after = 10 } = {}) {
    const colors = { info: [C.accent, C.accentSoft], pass: [C.pass, C.passSoft], warning: [C.warn, C.warnSoft], fail: [C.fail, C.failSoft] }[kind] || [C.accent, C.accentSoft];
    const pad = 9;
    const lh = size * 1.42;
    const lines = wrap(text, 'F1', size, this.width - pad * 2 - 6);
    const h = (heading ? lh + 2 : 0) + lines.length * lh + pad * 2 - 2;
    this.ensure(h);
    this.doc.rect(this.x, this.y, this.width, h, { fill: colors[1], radius: 3 });
    this.doc.rect(this.x, this.y, 3.5, h, { fill: colors[0] });
    let y = this.y + pad;
    if (heading) {
      this.doc.text(heading, this.x + pad + 6, y + size * 0.95, { font: 'F2', size, color: colors[0] });
      y += lh + 2;
    }
    for (const line of lines) {
      this.doc.text(line, this.x + pad + 6, y + size * 0.95, { size, color: C.text });
      y += lh;
    }
    this.y += h + after;
  }

  badge(text, x, y, { color = C.accent, soft = C.accentSoft, size = 7.6 } = {}) {
    const w = measure(text, 'F2', size) + 10;
    this.doc.rect(x, y, w, size + 7, { fill: soft, radius: (size + 7) / 2 });
    this.doc.text(text, x + 5, y + size + 1.6, { font: 'F2', size, color });
    return w;
  }

  tiles(items, { perRow = 3, after = 10 } = {}) {
    const gap = 8;
    const w = (this.width - gap * (perRow - 1)) / perRow;
    const h = 46;
    for (let i = 0; i < items.length; i += perRow) {
      this.ensure(h + gap);
      items.slice(i, i + perRow).forEach((it, j) => {
        const x = this.x + j * (w + gap);
        const st = it.status ? STATUS[it.status] : null;
        this.doc.rect(x, this.y, w, h, { fill: C.white, stroke: C.border, lineWidth: 0.6, radius: 4 });
        if (st) this.doc.rect(x, this.y + 6, 2.5, h - 12, { fill: st.color });
        this.doc.text(it.label, x + 10, this.y + 15, { size: 7.6, color: C.muted, font: 'F2' });
        this.doc.text(it.value, x + 10, this.y + 35, { size: 15, font: 'F2', color: st ? st.color : C.text });
      });
      this.y += h + gap;
    }
    this.y += after - gap;
  }

  diagramLayout(pb) {
    const graph = buildGraph(pb, { terminals: true });
    const L = layoutGraph(graph, { nodeW: 178, nodeH: 50, termW: 150, termH: 34, gapX: 28, gapY: 40, margin: 8 });
    const maxH = this.bottom - PAGE.mt - 40;
    const s = Math.max(0.35, Math.min(1, this.width / L.width, maxH / L.height));
    return { L, s, h: L.height * s };
  }

  /** Visual workflow diagram (shared layered layout, vector drawing). */
  diagram(pb) {
    const { L, s, h } = this.diagramLayout(pb);
    if (this.y + h > this.bottom) this.newPage();
    const ox = this.x + (this.width - L.width * s) / 2;
    const oy = this.y;
    const X = (v) => ox + v * s;
    const Y = (v) => oy + v * s;
    const d = this.doc;
    // Edges.
    for (const e of L.edges) {
      const pts = e.points.map(([px, py]) => [X(px), Y(py)]);
      const color = e.kind === 'branch' ? '#7c3aed' : '#9aa3b2';
      if (e.back) {
        d.curve(pts[0], pts.slice(1), { color: C.fail, width: 0.9, dash: [3, 2] });
        continue;
      }
      const last = pts[pts.length - 1];
      const endY = last[1] - 5 * s;
      const segs = [];
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1];
        const [x1, y1raw] = pts[i];
        const y1 = i === pts.length - 1 ? endY : y1raw;
        const dy = (y1 - y0) / 2;
        segs.push([x0, y0 + dy, x1, y1 - dy, x1, y1]);
      }
      d.curve(pts[0], segs, { color, width: 0.9 });
      d.polygon([[last[0], last[1]], [last[0] - 3.4 * s, last[1] - 6.2 * s], [last[0] + 3.4 * s, last[1] - 6.2 * s]], { fill: color });
    }
    // Branch labels.
    for (const e of L.edges) {
      if (!e.label) continue;
      const size = Math.max(5.2, 6.8 * s);
      const tw = measure(e.label, 'F2', size) + 8;
      const lx = X(e.labelPos.x) - tw / 2;
      const ly = Y(e.labelPos.y) - (size + 5) / 2;
      d.rect(lx, ly, tw, size + 5, { fill: '#f3edff', stroke: '#c4b5fd', lineWidth: 0.5, radius: (size + 5) / 2 });
      d.text(e.label, lx + 4, ly + size + 1.3, { font: 'F2', size, color: '#6d28d9' });
    }
    // Nodes.
    for (const nd of L.nodes) {
      const x = X(nd.x);
      const y = Y(nd.y);
      const w = nd.w * s;
      const hh = nd.h * s;
      if (nd.kind !== 'step') {
        const isStart = nd.kind === 'start';
        d.rect(x, y, w, hh, { fill: isStart ? C.accentSoft : C.passSoft, stroke: isStart ? '#c7cbff' : '#b7e0c4', lineWidth: 0.7, radius: hh / 2 });
        const size = Math.max(5.5, 8 * s);
        const txt = `${nd.label} · ${nd.sublabel}`;
        const lines = wrap(txt, 'F2', size, w - 12 * s);
        d.text(lines[0], x + (w - measure(lines[0], 'F2', size)) / 2, y + hh / 2 + size * 0.35, { font: 'F2', size, color: isStart ? C.accent : C.pass });
        continue;
      }
      const color = TYPE_COLORS[nd.type] || TYPE_COLORS.task;
      d.rect(x, y, w, hh, { fill: nd.type === 'decision' ? '#faf7ff' : C.white, stroke: color, lineWidth: 0.9, radius: 5 * s });
      d.rect(x, y, 3.5 * s, hh, { fill: color });
      const size = Math.max(5.4, 8.2 * s);
      const small = Math.max(4.6, 6.2 * s);
      d.text(`${nd.id} · ${String(nd.type).toUpperCase()}`, x + 9 * s, y + 6 * s + small, { font: 'F2', size: small, color });
      const lines = wrap(nd.label, 'F2', size, w - 16 * s).slice(0, 2);
      lines.forEach((line, i) => d.text(line, x + 9 * s, y + 12 * s + small + (i + 1) * size * 1.15, { font: 'F2', size, color: C.text }));
    }
    this.y += h + 12;
  }
}

/**
 * Build the PDF buffer.
 * @param pb export JSON (with tests, status, metadata)
 * @param ctx { versions, lastRun, stale }
 */
export function playbookPdf(pb, { versions = [], lastRun = null, stale = null, generatedAt = new Date() } = {}) {
  const doc = new PdfDocument({ title: `${pb.name} — Playbook v${pb.version}`, subject: pb.objective || '', date: generatedAt });
  const f = new Flow(doc, `${pb.name} · v${pb.version} · ${title(pb.status || 'draft')}`);
  const cfg = configMap(pb);
  const stepIndex = new Map((pb.steps || []).map((s, i) => [s.id, i + 1]));

  // ------------------------------------------------------------ cover
  doc.addPage();
  doc.rect(0, 0, PAGE.w, 250, { fill: '#1e1b4b' });
  doc.rect(0, 250, PAGE.w, 5, { fill: C.accent });
  doc.text('PLAYBOOK', PAGE.ml, 78, { font: 'F2', size: 9.5, color: '#a5b4fc' });
  const nameLines = wrap(pb.name, 'F2', 27, PAGE.w - PAGE.ml * 2).slice(0, 3);
  nameLines.forEach((l, i) => doc.text(l, PAGE.ml, 118 + i * 33, { font: 'F2', size: 27, color: C.white }));
  const descY = 118 + nameLines.length * 33 + 4;
  wrap(pb.description || pb.objective || '', 'F1', 11, PAGE.w - PAGE.ml * 2)
    .slice(0, 3)
    .forEach((l, i) => doc.text(l, PAGE.ml, descY + i * 16, { size: 11, color: '#c7d2fe' }));
  doc.bookmark('Cover', 0, 0, 0);

  f.y = 290;
  const lt = pb.metadata && pb.metadata.last_test;
  const st = lt ? STATUS[lt.status] : null;
  let bx = f.x;
  bx += f.badge(`v${pb.version}`, bx, f.y, { color: C.accent, soft: C.accentSoft, size: 8.4 }) + 6;
  bx += f.badge(title(pb.status || 'draft').toUpperCase(), bx, f.y, { color: C.muted, soft: C.fill, size: 8.4 }) + 6;
  bx += f.badge(pb.metadata && pb.metadata.quality_gate_passed ? 'QUALITY GATE PASSED' : 'QUALITY GATE NOT PASSED', bx, f.y, pb.metadata && pb.metadata.quality_gate_passed ? { color: C.pass, soft: C.passSoft, size: 8.4 } : { color: C.warn, soft: C.warnSoft, size: 8.4 }) + 6;
  if (st) f.badge(`TESTS ${st.label}${lt.stale ? ' (STALE)' : ''}`, bx, f.y, { color: st.color, soft: st.soft, size: 8.4 });
  f.y += 34;
  f.callout(pb.objective || '—', { heading: 'Objective', kind: 'info', size: 10 });
  f.table(
    [
      { label: 'Property', w: 1, bold: true },
      { label: 'Value', w: 3 },
    ],
    [
      ['Version', `v${pb.version} · ${title(pb.status || 'draft')}`],
      ['Trigger', triggerLabel(pb.trigger)],
      ['Workflow', `${(pb.steps || []).length} steps · ${(pb.decision_rules || []).length} decision rules · ${(pb.tools || []).length} tools`],
      ['Inputs', (pb.inputs || []).map((i) => i.name).join(', ') || '—'],
      ['Output', `${pb.output.format}${pb.output.fields && pb.output.fields.length ? ` · ${pb.output.fields.map((x) => x.name).join(', ')}` : ''}`],
      ['AI execution model', pb.ai && pb.ai.model ? pb.ai.model : 'Not set (deterministic execution available)'],
      ['Tests', `${(pb.tests || []).length} test cases${lt ? ` · latest ${lt.status.toUpperCase()} (${lt.mode}) on ${String(lt.at || '').slice(0, 10)}` : ' · not tested yet'}`],
      ['Fingerprint', (pb.metadata && pb.metadata.hash) || '—'],
      ['Generated', new Date(generatedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'],
    ],
    { size: 9 },
  );
  f.para('This document specifies the procedure — how the task is performed — generated from the canonical Playbook JSON. It is not the output of a run.', { size: 8.4, color: C.muted });
  f.para('Playbook Builder for AI · Powered By SiliBlue.in', { size: 8.4, color: C.muted });

  // ------------------------------------------------------------ objective & scope
  f.newPage();
  f.h1('Objective & Scope');
  f.label('Objective');
  f.para(pb.objective || '—');
  f.label('Scope');
  f.para(pb.scope || '—');
  f.label('Trigger');
  f.para([triggerLabel(pb.trigger), pb.trigger && pb.trigger.description].filter(Boolean).join(' — '));

  // ------------------------------------------------------------ requirements
  f.h1('Requirements');
  const groups = [['functional', 'Functional'], ['data', 'Data'], ['business_rule', 'Business rules'], ['output', 'Output'], ['non_functional', 'Non-functional'], ['constraint', 'Constraints']];
  for (const [type, label] of groups) {
    const list = (pb.requirements || []).filter((r) => r.type === type);
    if (!list.length) continue;
    f.label(label);
    for (const r of list) {
      f.rich([{ text: `${r.id}  `, font: 'F2', color: C.accent }, { text: r.text }], { after: r.rule ? 1 : 4 });
      if (r.rule) f.rich([{ text: 'Rule: ', font: 'F2', color: C.muted }, { text: `${describeCondition(r.rule, cfg)}${r.result !== undefined ? ` -> ${r.result}` : ''}`, font: 'F4' }], { size: 8.4, indent: 34, after: 5 });
    }
  }
  if ((pb.assumptions || []).length) {
    f.label('Assumptions');
    f.bullets(pb.assumptions);
  }

  // ------------------------------------------------------------ dependencies
  f.h1('Dependencies');
  if ((pb.dependencies || []).length) {
    f.table(
      [
        { label: 'Type', w: 1.1, bold: true },
        { label: 'Dependency', w: 1.8 },
        { label: 'Details', w: 3.2 },
        { label: 'Required', w: 0.8 },
      ],
      pb.dependencies.map((d) => [title(d.type), d.name, d.description || '', d.required ? 'Yes' : 'No']),
    );
  }
  const wf = [];
  for (const s of pb.steps || []) for (const d of s.dependencies || []) wf.push(`Step ${stepIndex.get(s.id)} (${s.id}) depends on Step ${stepIndex.get(d) || '?'} (${d})`);
  if (wf.length) {
    f.label('Workflow dependencies');
    f.bullets(wf, { size: 8.8 });
  }

  // ------------------------------------------------------------ tools & permissions
  f.h1('Tools & Permissions');
  if ((pb.tools || []).length) {
    f.table(
      [
        { label: 'Tool', w: 1.5, bold: true },
        { label: 'Purpose', w: 3.4 },
        { label: 'Permission', w: 1 },
        { label: 'Required', w: 0.8 },
      ],
      pb.tools.map((t) => [t.name, t.purpose || '—', title(t.permission), t.required ? 'Yes' : 'No']),
    );
  } else f.callout('No tools are required — every input is supplied directly to the run.', { kind: 'info' });
  const allowed = (pb.permissions || []).filter((p) => p.allowed).map((p) => p.action);
  const denied = (pb.permissions || []).filter((p) => !p.allowed).map((p) => p.action);
  f.label('Allowed');
  f.bullets(allowed.length ? allowed : ['Nothing explicitly allowed.']);
  f.label('Not allowed');
  f.bullets(denied.length ? denied : ['Nothing explicitly forbidden.'], { color: C.fail });

  // ------------------------------------------------------------ inputs & configuration
  f.h1('Inputs & Configuration');
  for (const i of pb.inputs || []) {
    f.h2(`${i.name} (${i.id})`);
    if (i.description) f.para(i.description);
    f.rich([{ text: 'Type: ', font: 'F2' }, { text: `${i.type}   ` }, { text: 'Required: ', font: 'F2' }, { text: `${i.required ? 'Yes' : 'No'}   ` }, { text: 'Source: ', font: 'F2' }, { text: i.source }]);
    if ((i.validation || []).length) f.bullets(i.validation, { size: 8.8 });
    if (i.example !== undefined) {
      f.label('Example');
      f.code(JSON.stringify(i.example, null, 2), { maxLines: 30 });
    }
  }
  if ((pb.configuration || []).length) {
    f.h2('Configuration');
    f.table(
      [
        { label: 'Name', w: 2.3, mono: true },
        { label: 'Type', w: 0.8 },
        { label: 'Value', w: 0.9, mono: true },
        { label: 'Description', w: 3 },
      ],
      pb.configuration.map((c) => [c.name, c.type, JSON.stringify(c.value), c.description || '']),
    );
  }

  // ------------------------------------------------------------ visual workflow
  f.h1('Visual Workflow', true, f.diagramLayout(pb).h + 50);
  f.diagram(pb);
  const order = topologicalOrder(pb);
  f.label('Execution order');
  f.bullets(
    order.map((id) => {
      const s = pb.steps.find((x) => x.id === id);
      return s ? `${s.id} — ${s.name} (${s.type})${(s.dependencies || []).length ? ` after ${s.dependencies.join(', ')}` : ''}` : id;
    }),
    { marker: 'number', size: 8.8 },
  );

  // ------------------------------------------------------------ detailed steps
  f.h1('Detailed Steps', true, 170);
  (pb.steps || []).forEach((s, idx) => {
    f.ensure(90);
    f.space(4);
    const color = TYPE_COLORS[s.type] || TYPE_COLORS.task;
    doc.bookmark(`Step ${idx + 1} — ${s.name}`, doc.pages.length - 1, f.y, 1);
    doc.rect(f.x, f.y, f.width, 26, { fill: C.fill, radius: 3 });
    doc.rect(f.x, f.y, 3.5, 26, { fill: color });
    doc.text(`Step ${idx + 1} — ${s.name}`, f.x + 11, f.y + 17, { font: 'F2', size: 11, color: C.text });
    const tag = `${s.id} · ${String(s.type).toUpperCase()}${s.requires_approval ? ' · APPROVAL' : ''}`;
    doc.text(tag, f.x + f.width - measure(tag, 'F2', 7.4) - 9, f.y + 16.5, { font: 'F2', size: 7.4, color });
    f.y += 34;
    f.field('Purpose', s.purpose);
    f.field('Why it exists', s.rationale);
    f.field('Inputs', (s.inputs || []).join(', ') || 'none');
    f.field('Dependencies', (s.dependencies || []).length ? s.dependencies.map((d) => `${d} (Step ${stepIndex.get(d) || '?'})`).join(', ') : 'none — entry step');
    if ((s.preconditions || []).length) f.field('Preconditions', s.preconditions.join(' · '));
    f.rich([{ text: 'Instructions:', font: 'F2' }], { after: 2 });
    f.bullets(s.instructions || [], { marker: 'number', size: 9, indent: 6 });
    if ((s.decision_logic || []).length) {
      f.rich([{ text: 'Decision logic:', font: 'F2' }], { after: 3 });
      f.table(
        [
          { label: 'Rule', w: 0.8, mono: true },
          { label: 'Condition', w: 3.2 },
          { label: 'Result', w: 1.2, bold: true },
          { label: 'Next', w: 0.9, mono: true },
        ],
        s.decision_logic.map((b) => {
          const rule = (pb.decision_rules || []).find((r) => r.id === b.rule_id);
          return [b.rule_id || '—', rule ? describeCondition(rule.when, cfg) : b.condition, b.result, [].concat(b.next || []).join(', ') || '—'];
        }),
        { size: 8.2, after: 6 },
      );
    }
    f.field('Tools', (s.tools || []).join(', ') || 'none');
    f.field('Output', `${s.output.name} (${s.output.type})${s.output.description ? ` — ${s.output.description}` : ''}`);
    if ((s.validation || []).length) f.field('Validation', s.validation.join(' · '));
    if ((s.postconditions || []).length) f.field('Postconditions', s.postconditions.join(' · '));
    const retry = typeof s.retry_behavior === 'object' ? `up to ${s.retry_behavior.max_attempts} attempts (${(s.retry_behavior.retry_on || []).join(', ')})` : 'not applicable';
    f.field('On failure', `${title(s.failure_behavior)} · Retry: ${retry}`, { after: 8 });
  });

  // ------------------------------------------------------------ decision rules
  f.h1('Decision Rules');
  if ((pb.decision_rules || []).length) {
    f.table(
      [
        { label: 'ID', w: 0.8, mono: true },
        { label: 'Name', w: 1.5, bold: true },
        { label: 'Step', w: 0.8, mono: true },
        { label: 'Priority', w: 0.7 },
        { label: 'Condition', w: 3 },
        { label: 'Result', w: 1.2 },
      ],
      pb.decision_rules.map((r) => [r.id, r.name, r.step_id, String(r.priority), describeCondition(r.when, cfg), String(r.result)]),
    );
    f.para('Rules are evaluated in priority order; the first matching rule wins.', { size: 8.4, color: C.muted });
  } else f.para('No machine-readable decision rules.', { color: C.muted });

  // ------------------------------------------------------------ output
  f.h1('Output');
  f.rich([{ text: 'Format: ', font: 'F2' }, { text: pb.output.format }, ...(pb.output.destination ? [{ text: '   Destination: ', font: 'F2' }, { text: pb.output.destination }] : [])]);
  if (pb.output.description) f.para(pb.output.description);
  if ((pb.output.sections || []).length) {
    f.label('Sections');
    f.bullets(pb.output.sections, { marker: 'number' });
  }
  if ((pb.output.fields || []).length) {
    f.table(
      [
        { label: 'Field', w: 1.4, mono: true },
        { label: 'Type', w: 1.6 },
        { label: 'Required', w: 0.8 },
        { label: 'Description', w: 3 },
      ],
      pb.output.fields.map((x) => [x.name, `${x.type}${x.enum ? ` (${x.enum.join(' | ')})` : ''}`, x.required ? 'Yes' : 'No', x.description || '']),
    );
  }
  if (pb.output.example !== undefined) {
    f.label('Example output');
    f.code(JSON.stringify(pb.output.example, null, 2), { maxLines: 30 });
  }

  // ------------------------------------------------------------ validation
  f.h1('Validation');
  for (const level of ['step', 'workflow', 'output', 'intent']) {
    const list = (pb.validation || []).filter((v) => v.level === level);
    if (!list.length) continue;
    f.label(`${title(level)} validation`);
    f.bullets(list.map((v) => v.rule));
  }

  // ------------------------------------------------------------ error handling
  f.h1('Error Handling');
  const eh = pb.error_handling || {};
  const rp = eh.retry || {};
  f.field('Default strategy', title(eh.default_strategy || 'stop'));
  f.field('Retry policy', rp.enabled ? `up to ${rp.max_attempts} attempts on ${(rp.retry_on || []).join(', ')}${rp.backoff_seconds ? ` with ${rp.backoff_seconds}s backoff` : ''}. Deterministic validation failures are never retried.` : 'disabled');
  if ((eh.strategies || []).length) {
    f.table(
      [
        { label: 'When', w: 1.6, mono: true },
        { label: 'Strategy', w: 1.2, bold: true },
        { label: 'Then', w: 0.9 },
        { label: 'Notes', w: 3 },
      ],
      eh.strategies.map((s) => [`${s.on}${s.step_id ? ` (${s.step_id})` : ''}`, title(s.strategy), s.then ? title(s.then) : '—', s.notes || '']),
    );
  }

  // ------------------------------------------------------------ success criteria
  f.h1('Success Criteria');
  f.para('The playbook succeeds when:', { color: C.muted });
  f.bullets((pb.success_criteria || []).map((c) => c.text));

  // ------------------------------------------------------------ tests
  f.h1('Test Cases');
  if ((pb.tests || []).length) {
    f.table(
      [
        { label: 'ID', w: 0.7, mono: true },
        { label: 'Test', w: 1.5, bold: true },
        { label: 'Category', w: 1 },
        { label: 'Input', w: 2.6, mono: true },
        { label: 'Expected', w: 2, mono: true },
        { label: 'Runs', w: 0.5 },
      ],
      pb.tests.map((t) => [t.id, t.name, title(t.category), short(t.input, 140), t.expected !== undefined ? short(t.expected, 110) : t.expected_error ? `error ${t.expected_error}` : t.expected_status ? `status: ${t.expected_status}` : short(t.expected_behavior || '', 110), String(t.runs || 1)]),
      { size: 8 },
    );
  } else f.para('No test cases yet.', { color: C.muted });

  f.h1('Test Results');
  if (lastRun && lastRun.metrics) {
    const m = lastRun.metrics;
    const s2 = STATUS[lastRun.result_status] || STATUS.fail;
    if (stale && stale.stale) f.callout('The playbook changed since this test run. Run the tests again for current results.', { kind: 'warning', heading: 'Stale results' });
    f.ensure(30);
    f.badge(s2.label, f.x, f.y, { color: s2.color, soft: s2.soft, size: 10 });
    doc.text(`${lastRun.mode === 'ai' ? 'AI Execution' : 'Deterministic Fixture'} · v${lastRun.version} · ${String(lastRun.ended_at || '').replace('T', ' ').slice(0, 16)} UTC${lastRun.environment && lastRun.environment.model ? ` · ${lastRun.environment.model}` : ''}`, f.x + 78, f.y + 12, { size: 8.6, color: C.muted });
    f.y += 28;
    f.para(`${m.counts.passed} / ${m.counts.executed} tests passed${m.counts.repeatability_runs ? ` · ${m.counts.repeatability_matched} / ${m.counts.repeatability_runs} repeatability runs matched` : ''}`, { font: 'F2', size: 9.6 });
    const tile = (label, key) => ({ label, value: pct(m.metrics[key]), status: m.statuses[key] || null });
    f.tiles([
      tile('Task Alignment', 'task_alignment'),
      tile('Requirement Coverage', 'requirement_coverage'),
      tile('Rule Adherence', 'rule_adherence'),
      tile('Accuracy', 'accuracy'),
      tile('Consistency', 'consistency'),
      tile('Output Compliance', 'output_compliance'),
    ]);
    f.table(
      [
        { label: 'Test', w: 2, bold: true },
        { label: 'Category', w: 1.1 },
        { label: 'Runs', w: 0.6 },
        { label: 'Accuracy', w: 0.9 },
        { label: 'Agreement', w: 0.9 },
        { label: 'Status', w: 0.9, bold: true },
      ],
      (lastRun.results || []).map((r) => {
        const row = [r.name, title(r.category), String(r.runs.length), pct(r.accuracy), r.agreement === null || r.agreement === undefined ? '—' : pct(r.agreement), (r.status || '').toUpperCase()];
        row.colors = { 5: (STATUS[r.status] || { color: C.muted }).color };
        return row;
      }),
    );
    const failed = (lastRun.results || []).filter((r) => r.status !== 'pass' && r.status !== 'skipped');
    for (const r of failed) {
      f.callout((r.diagnosis || []).join(' ') || 'See the Test Center for details.', { kind: r.status === 'warning' ? 'warning' : 'fail', heading: `${(r.status || '').toUpperCase()} — ${r.name}` });
    }
    for (const sgn of (lastRun.repair_suggestions || []).slice(0, 3)) {
      f.callout(`${sgn.explanation} Suggested fix: ${sgn.fix_summary}${sgn.verification && sgn.verification.verified ? ' (verified by re-running the suite on a patched copy)' : ''}`, { kind: 'info', heading: sgn.problem });
    }
    f.para(m.disclaimer, { size: 8, color: C.muted, font: 'F3' });
  } else f.para('Not tested yet.', { color: C.muted });

  // ------------------------------------------------------------ version
  f.h1('Version');
  f.field('Current version', `v${pb.version} · ${title(pb.status || 'draft')} · fingerprint ${(pb.metadata && pb.metadata.hash) || '—'}`);
  if (versions.length) {
    f.table(
      [
        { label: 'Version', w: 0.7, bold: true },
        { label: 'Status', w: 0.9 },
        { label: 'Created', w: 1 },
        { label: 'Source', w: 0.9 },
        { label: 'Change note', w: 2.6 },
        { label: 'Last test', w: 0.9 },
      ],
      versions.map((v) => [`v${v.version}`, title(v.status), String(v.created_at || '').slice(0, 10), title(v.source), v.change_note || '', v.last_test ? String(v.last_test.status).toUpperCase() : '—']),
    );
  }

  // Footer with page numbers.
  const total = doc.pages.length;
  doc.pages.forEach((p, i) => {
    if (i === 0) return;
    const label = `Page ${i + 1} of ${total}`;
    doc.line(PAGE.ml, PAGE.h - 40, PAGE.w - PAGE.mr, PAGE.h - 40, { color: C.border, width: 0.5, ops: p.ops });
    doc.text(label, PAGE.w - PAGE.mr - measure(label, 'F1', 7.5), PAGE.h - 28, { size: 7.5, color: C.faint, ops: p.ops });
    doc.text('Generated from the canonical Playbook JSON', PAGE.ml, PAGE.h - 28, { size: 7.5, color: C.faint, ops: p.ops });
  });
  return doc.toBuffer();
}
