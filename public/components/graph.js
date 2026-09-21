// Interactive SVG workflow graph (spec §32, §58): layered layout from the
// shared module, branch labels, pan/zoom, keyboard-selectable nodes and an
// optional run-status overlay.
import { h, icon, button, STEP_COLORS } from '../ui.js';
import { buildGraph, layoutGraph, edgePath } from '/shared/graph.js';

let counter = 0;
let ctx = null;

function textWidth(text, font) {
  if (!ctx) ctx = document.createElement('canvas').getContext('2d');
  ctx.font = font;
  return ctx.measureText(text).width;
}

function wrap(text, maxW, font, maxLines = 2) {
  const words = [];
  for (const w of String(text || '').split(/\s+/).filter(Boolean)) {
    if (textWidth(w, font) <= maxW) {
      words.push(w);
      continue;
    }
    let chunk = '';
    for (const ch of w) {
      if (chunk && textWidth(chunk + ch, font) > maxW) {
        words.push(chunk);
        chunk = ch;
      } else chunk += ch;
    }
    if (chunk) words.push(chunk);
  }
  const lines = [];
  let line = '';
  for (const w of words) {
    const cand = line ? `${line} ${w}` : w;
    if (textWidth(cand, font) <= maxW || !line) line = cand;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last.length > 1 && textWidth(`${last}…`, font) > maxW) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last}…`;
    return kept;
  }
  return lines;
}

const STATUS_GLYPH = { completed: '✓', failed: '✕', skipped: '–', awaiting_approval: '❚❚', simulated: '~', unreported: '?' };

export function workflowGraph(pb, { selected = null, onSelect = null, statusMap = null, height = 640, legend = true, interactive = true } = {}) {
  const uid = `wg${++counter}`;
  const graph = buildGraph(pb, { terminals: true });
  const layout = layoutGraph(graph);
  const stepIndex = new Map((pb.steps || []).map((s, i) => [s.id, i + 1]));
  const box = h('div', { class: 'graph-box', style: { height: typeof height === 'number' ? `${height}px` : height === 'auto' ? '600px' : height } });
  const svg = h('svg', { role: 'group', 'aria-label': `Workflow diagram: ${pb.name}` });
  const marker = (id, color) =>
    h('marker', { id: `${uid}-${id}`, viewBox: '0 0 10 10', refX: '8.5', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' }, h('path', { d: 'M0,0 L10,5 L0,10 z', style: { fill: color } }));
  svg.appendChild(h('defs', null, marker('a', 'var(--border-strong)'), marker('b', 'var(--violet)'), marker('x', 'var(--accent)'), marker('r', 'var(--fail)')));
  const viewport = h('g');
  svg.appendChild(viewport);

  const edgeEls = [];
  for (const e of layout.edges) {
    const kind = e.back ? 'r' : e.kind === 'branch' ? 'b' : 'a';
    const path = h('path', { d: edgePath(e.points, e.back), 'marker-end': `url(#${uid}-${kind})` });
    const g = h('g', { class: `gedge ${e.kind === 'branch' ? 'branch' : ''} ${e.back ? 'back' : ''}` }, path);
    viewport.appendChild(g);
    edgeEls.push({ e, g, path, kind });
  }
  for (const { e } of edgeEls) {
    if (!e.label) continue;
    const font = '700 10.5px system-ui, sans-serif';
    const w = textWidth(e.label, font) + 14;
    viewport.appendChild(
      h(
        'g',
        { class: 'glabel', transform: `translate(${e.labelPos.x - w / 2},${e.labelPos.y - 10})` },
        h('rect', { width: w, height: 20, rx: 10 }),
        h('text', { x: w / 2, y: 14, 'text-anchor': 'middle' }, e.label),
      ),
    );
  }

  const nodeEls = new Map();
  for (const n of layout.nodes) {
    const status = statusMap && statusMap[n.id];
    if (n.kind !== 'step') {
      const g = h(
        'g',
        { class: `gnode terminal ${n.kind}`, transform: `translate(${n.x},${n.y})` },
        h('rect', { class: 'box', width: n.w, height: n.h, rx: n.h / 2 }),
        h('text', { x: n.w / 2, y: n.h / 2 + 4.5, 'text-anchor': 'middle', style: { fill: n.kind === 'start' ? 'var(--accent)' : 'var(--pass)' } }, wrap(`${n.label} · ${n.sublabel}`, n.w - 22, '700 12px system-ui, sans-serif', 1)[0]),
        h('title', null, `${n.label} · ${n.sublabel}`),
      );
      viewport.appendChild(g);
      nodeEls.set(n.id, g);
      continue;
    }
    const color = STEP_COLORS[n.type] || STEP_COLORS.task;
    const nameLines = wrap(n.label, n.w - 34, '650 13px system-ui, sans-serif', 2);
    const step = n.step || {};
    const metaBits = [];
    if ((step.tools || []).length) metaBits.push(`${step.tools.length} tool${step.tools.length > 1 ? 's' : ''}`);
    if (step.requires_approval) metaBits.push('approval');
    const g = h(
      'g',
      {
        class: `gnode ${n.type}${status ? ` st-${status}` : ''}`,
        transform: `translate(${n.x},${n.y})`,
        tabindex: interactive ? '0' : null,
        role: interactive ? 'button' : null,
        'aria-label': `Step ${stepIndex.get(n.id)}: ${n.label} (${n.type})${status ? `, ${status}` : ''}`,
        dataset: { id: n.id },
      },
      h('rect', { class: 'box', width: n.w, height: n.h, rx: 10 }),
      h('rect', { x: 0, y: 10, width: 4, height: n.h - 20, rx: 2, style: { fill: color } }),
      h('text', { class: 'gtype', x: 16, y: 21, style: { fill: color } }, `${stepIndex.get(n.id)} · ${String(n.type).toUpperCase()}${metaBits.length ? `  ·  ${metaBits.join(' · ')}` : ''}`),
      ...nameLines.map((line, i) => h('text', { class: 'gname', x: 16, y: 41 + i * 16 }, line)),
    );
    if (status) {
      const c = { completed: 'var(--pass)', failed: 'var(--fail)', awaiting_approval: 'var(--warn)', skipped: 'var(--text-3)', simulated: 'var(--text-3)', unreported: 'var(--text-3)' }[status] || 'var(--text-3)';
      g.appendChild(h('circle', { cx: n.w - 14, cy: 14, r: 9, style: { fill: c } }));
      g.appendChild(h('text', { x: n.w - 14, y: 18, 'text-anchor': 'middle', style: { fill: '#fff', fontSize: '10px', fontWeight: 800 } }, STATUS_GLYPH[status] || '•'));
    }
    if (interactive) {
      g.addEventListener('click', (ev) => {
        ev.stopPropagation();
        select(n.id);
        if (onSelect) onSelect(n.step);
      });
      g.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          select(n.id);
          if (onSelect) onSelect(n.step);
        }
      });
      g.addEventListener('mouseenter', () => highlight(n.id, true));
      g.addEventListener('mouseleave', () => highlight(selectedId, false));
    }
    viewport.appendChild(g);
    nodeEls.set(n.id, g);
  }

  // Taken path in run overlays.
  if (statusMap) {
    for (const { e, g, path } of edgeEls) {
      const a = e.from === '__start' ? 'completed' : statusMap[e.from];
      const b = e.to === '__end' ? 'completed' : statusMap[e.to];
      if (['completed', 'simulated'].includes(a) && ['completed', 'simulated', 'failed', 'awaiting_approval'].includes(b)) {
        g.classList.add('active');
        path.setAttribute('marker-end', `url(#${uid}-x)`);
      }
    }
  }

  let selectedId = null;
  function highlight(id, on) {
    for (const { e, g, path, kind } of edgeEls) {
      const hit = id && (e.from === id || e.to === id);
      const runActive = statusMap && g.classList.contains('active') && !on;
      if (!statusMap) {
        g.classList.toggle('active', Boolean(hit));
        path.setAttribute('marker-end', `url(#${uid}-${hit ? 'x' : kind})`);
      } else if (!runActive && hit) g.classList.add('active');
    }
  }
  function select(id) {
    selectedId = id;
    for (const [nid, el] of nodeEls) el.classList.toggle('selected', nid === id);
    highlight(id, false);
  }

  // ---- pan & zoom
  const t = { x: 0, y: 0, k: 1 };
  const apply = () => viewport.setAttribute('transform', `translate(${t.x},${t.y}) scale(${t.k})`);
  const autoHeight = height === 'auto';
  let lastW = 0;
  function fit() {
    const W = box.clientWidth || 800;
    if (autoHeight) {
      // Grow the canvas so the whole workflow is readable at (nearly) full size.
      const kw = Math.max(0.55, Math.min(1, (W - 40) / layout.width));
      const want = Math.round(Math.min(1150, Math.max(380, layout.height * kw + 56)));
      if (Math.abs((parseFloat(box.style.height) || 0) - want) > 2) box.style.height = `${want}px`;
    }
    const H = box.clientHeight || (typeof height === 'number' ? height : 600);
    const k = Math.min(1.1, (W - 40) / layout.width, (H - 50) / layout.height);
    t.k = Math.max(0.2, k);
    t.x = (W - layout.width * t.k) / 2;
    t.y = Math.max(12, (H - layout.height * t.k) / 2);
    apply();
    lastW = W;
  }
  function zoom(factor, cx, cy) {
    const W = box.clientWidth;
    const H = box.clientHeight;
    const px = cx ?? W / 2;
    const py = cy ?? H / 2;
    const nk = Math.max(0.2, Math.min(2.5, t.k * factor));
    t.x = px - ((px - t.x) * nk) / t.k;
    t.y = py - ((py - t.y) * nk) / t.k;
    t.k = nk;
    apply();
  }
  let drag = null;
  svg.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    drag = { x: ev.clientX, y: ev.clientY, tx: t.x, ty: t.y, moved: false };
    box.classList.add('dragging');
  });
  const onMove = (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    t.x = drag.tx + dx;
    t.y = drag.ty + dy;
    apply();
  };
  const onUp = () => {
    drag = null;
    box.classList.remove('dragging');
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  svg.addEventListener(
    'wheel',
    (ev) => {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      const r = box.getBoundingClientRect();
      zoom(ev.deltaY < 0 ? 1.12 : 1 / 1.12, ev.clientX - r.left, ev.clientY - r.top);
    },
    { passive: false },
  );

  box.appendChild(svg);
  box.appendChild(
    h(
      'div',
      { class: 'graph-tools' },
      button('', { ic: 'plus', size: 'sm', title: 'Zoom in', onClick: () => zoom(1.2) }),
      button('', { ic: 'minimize', size: 'sm', title: 'Zoom out', onClick: () => zoom(1 / 1.2) }),
      button('Fit', { size: 'sm', title: 'Fit to view', onClick: fit }),
    ),
  );
  if (legend) {
    const types = [...new Set((pb.steps || []).map((s) => s.type))];
    box.appendChild(h('div', { class: 'graph-legend' }, types.map((ty) => h('span', null, h('i', { style: { background: STEP_COLORS[ty] || STEP_COLORS.task } }), ty))));
  }
  box.appendChild(h('div', { class: 'graph-hint' }, 'Drag to pan · Ctrl + scroll to zoom'));

  // Re-fit only when the width changes (height changes are our own doing).
  const ro = new ResizeObserver(() => {
    if (Math.abs((box.clientWidth || 0) - lastW) > 1) fit();
  });
  ro.observe(box);
  requestAnimationFrame(fit);
  if (selected) select(selected);

  return {
    el: box,
    select,
    fit,
    issues: graph.issues,
    destroy() {
      ro.disconnect();
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    },
  };
}

export { icon };
