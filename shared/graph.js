// Workflow graph model + layered layout. Shared by the server (validation,
// Markdown, PDF) and the browser (SVG workflow view). No Node-only imports.

export const LAYOUT = {
  nodeW: 236,
  nodeH: 72,
  termW: 176,
  termH: 46,
  dummyW: 14,
  gapX: 44,
  gapY: 70,
  margin: 28,
};

const asList = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v]);

export function branchLabel(branch) {
  if (!branch || typeof branch !== 'object') return '';
  return String(branch.label || branch.result || branch.outcome || '').trim();
}

export function triggerLabel(trigger) {
  const t = (trigger && trigger.type) || 'manual';
  const names = {
    manual: 'Manual',
    schedule: 'Scheduled',
    webhook: 'Webhook',
    event: 'Event',
    api: 'API request',
    user_request: 'User request',
  };
  let label = names[t] || t;
  if (t === 'schedule') {
    const bits = [trigger.frequency, trigger.day, trigger.time].filter(Boolean);
    if (bits.length) label += ` · ${bits.join(' ')}`;
  }
  return label;
}

/**
 * Build the workflow graph: one node per step, edges from dependencies and
 * decision branches, optional Start/Output terminals, plus structural issues
 * (missing references, self-dependencies, cycles).
 */
export function buildGraph(playbook, { terminals = true } = {}) {
  const steps = asList(playbook && playbook.steps).filter((s) => s && typeof s === 'object' && s.id);
  const ids = new Set();
  const issues = [];
  for (const s of steps) {
    if (ids.has(s.id)) {
      issues.push({ severity: 'error', code: 'DUPLICATE_STEP_ID', step_id: s.id, message: `Step id "${s.id}" is used more than once.` });
    }
    ids.add(s.id);
  }

  const nodes = [];
  const seen = new Set();
  steps.forEach((s, i) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    nodes.push({ id: s.id, kind: 'step', type: s.type || 'task', label: s.name || s.id, index: i, step: s });
  });

  const edges = [];
  const byKey = new Map();
  const addEdge = (from, to, label = '', kind = 'dependency') => {
    const key = `${from}\u0000${to}`;
    const existing = byKey.get(key);
    if (existing) {
      if (label && !existing.label) {
        existing.label = label;
        existing.kind = kind;
      }
      return existing;
    }
    const e = { id: `e${edges.length}`, from, to, label, kind };
    edges.push(e);
    byKey.set(key, e);
    return e;
  };

  for (const s of steps) {
    for (const d of asList(s.dependencies)) {
      if (d === s.id) {
        issues.push({ severity: 'error', code: 'SELF_DEPENDENCY', step_id: s.id, message: `Step "${s.id}" depends on itself.` });
        continue;
      }
      if (!ids.has(d)) {
        issues.push({ severity: 'error', code: 'MISSING_DEPENDENCY', step_id: s.id, message: `Step "${s.id}" depends on "${d}", which does not exist.` });
        continue;
      }
      addEdge(d, s.id);
    }
  }
  for (const s of steps) {
    for (const b of asList(s.decision_logic)) {
      for (const t of asList(b && b.next)) {
        if (!t) continue;
        if (!ids.has(t)) {
          issues.push({ severity: 'error', code: 'MISSING_BRANCH_TARGET', step_id: s.id, message: `A branch of "${s.id}" points to "${t}", which does not exist.` });
          continue;
        }
        if (t === s.id) continue;
        const e = addEdge(s.id, t, branchLabel(b), 'branch');
        e.kind = 'branch';
        e.branch_results = (e.branch_results || []).concat(String(b.result ?? ''));
        e.branch_labels = (e.branch_labels || []).concat(branchLabel(b));
        if (e.branch_labels.length > 1) e.label = e.branch_labels.filter(Boolean).join(' / ');
      }
    }
  }

  const cycles = findCycles(nodes.map((n) => n.id), edges);
  for (const c of cycles) {
    issues.push({ severity: 'error', code: 'CIRCULAR_DEPENDENCY', step_id: c[0], message: `Circular dependency: ${c.concat(c[0]).join(' → ')}.` });
  }

  if (terminals) {
    const incoming = new Set(edges.filter((e) => !e.back).map((e) => e.to));
    const outgoing = new Set(edges.filter((e) => !e.back).map((e) => e.from));
    const start = { id: '__start', kind: 'start', type: 'start', label: 'Start', sublabel: triggerLabel(playbook && playbook.trigger) };
    const out = (playbook && playbook.output) || {};
    const end = { id: '__end', kind: 'end', type: 'end', label: 'Output', sublabel: out.format ? String(out.format).toUpperCase() : 'Result' };
    const stepNodes = nodes.slice();
    nodes.unshift(start);
    nodes.push(end);
    for (const n of stepNodes) {
      if (!incoming.has(n.id)) addEdge('__start', n.id, '', 'terminal');
      if (!outgoing.has(n.id)) addEdge(n.id, '__end', '', 'terminal');
    }
    if (!stepNodes.length) addEdge('__start', '__end', '', 'terminal');
  }

  return { nodes, edges, issues, cycles };
}

/** Find cycles with an iterative DFS; marks the closing edges as back edges. */
function findCycles(ids, edges) {
  const succ = new Map(ids.map((id) => [id, []]));
  for (const e of edges) if (succ.has(e.from) && succ.has(e.to)) succ.get(e.from).push(e);
  const color = new Map(ids.map((id) => [id, 0]));
  const cycles = [];
  const signatures = new Set();
  for (const root of ids) {
    if (color.get(root) !== 0) continue;
    const stack = [{ id: root, i: 0 }];
    const path = [root];
    color.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const out = succ.get(top.id);
      if (top.i >= out.length) {
        color.set(top.id, 2);
        stack.pop();
        path.pop();
        continue;
      }
      const e = out[top.i++];
      const c = color.get(e.to);
      if (c === 0) {
        color.set(e.to, 1);
        stack.push({ id: e.to, i: 0 });
        path.push(e.to);
      } else if (c === 1) {
        e.back = true;
        const at = path.indexOf(e.to);
        const cyc = path.slice(at);
        const sig = cyc.slice().sort().join('|');
        if (!signatures.has(sig)) {
          signatures.add(sig);
          cycles.push(cyc);
        }
      }
    }
  }
  return cycles;
}

/** Topological order of step ids (ignores back edges). Unreachable/cyclic nodes are appended in declared order. */
export function topologicalOrder(playbook) {
  const g = buildGraph(playbook, { terminals: false });
  const ids = g.nodes.map((n) => n.id);
  const indeg = new Map(ids.map((id) => [id, 0]));
  const succ = new Map(ids.map((id) => [id, []]));
  for (const e of g.edges) {
    if (e.back) continue;
    indeg.set(e.to, indeg.get(e.to) + 1);
    succ.get(e.from).push(e.to);
  }
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const t of succ.get(id)) {
      indeg.set(t, indeg.get(t) - 1);
      if (indeg.get(t) === 0) queue.push(t);
    }
  }
  for (const id of ids) if (!order.includes(id)) order.push(id);
  return order;
}

/**
 * Groups of steps that can run in parallel: same dependency set, not mutually
 * exclusive branches of one decision, plus any explicit `parallel_group`.
 */
export function parallelGroups(playbook) {
  const steps = asList(playbook && playbook.steps).filter((s) => s && s.id);
  const branchOf = new Map();
  for (const s of steps) {
    for (const b of asList(s.decision_logic)) {
      for (const t of asList(b && b.next)) branchOf.set(t, s.id);
    }
  }
  const groups = new Map();
  for (const s of steps) {
    const deps = asList(s.dependencies).slice().sort();
    if (branchOf.has(s.id)) continue;
    const key = deps.join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s.id);
  }
  const result = [];
  for (const [key, members] of groups) {
    if (members.length > 1) result.push({ after: key ? key.split('|') : [], steps: members, source: 'dependencies' });
  }
  const explicit = new Map();
  for (const s of steps) {
    if (!s.parallel_group) continue;
    if (!explicit.has(s.parallel_group)) explicit.set(s.parallel_group, []);
    explicit.get(s.parallel_group).push(s.id);
  }
  for (const [name, members] of explicit) {
    if (members.length > 1 && !result.some((r) => r.steps.join() === members.join())) {
      result.push({ name, after: [], steps: members, source: 'declared' });
    }
  }
  return result;
}

/**
 * Layered (Sugiyama-style) layout: longest-path layering, dummy nodes for long
 * edges, barycenter ordering and balanced x placement. Returns absolute
 * coordinates (top-left x/y plus centers) and routed edge polylines.
 */
export function layoutGraph(graph, opts = {}) {
  const L = { ...LAYOUT, ...opts };
  const nodes = graph.nodes.map((n) => ({
    ...n,
    w: n.kind === 'step' ? L.nodeW : L.termW,
    h: n.kind === 'step' ? L.nodeH : L.termH,
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = graph.edges.filter((e) => byId.has(e.from) && byId.has(e.to)).map((e) => ({ ...e }));
  const fwd = edges.filter((e) => !e.back);

  // 1. Layering (longest path from sources).
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const succ = new Map(nodes.map((n) => [n.id, []]));
  const pred = new Map(nodes.map((n) => [n.id, []]));
  for (const e of fwd) {
    indeg.set(e.to, indeg.get(e.to) + 1);
    succ.get(e.from).push(e.to);
    pred.get(e.to).push(e.from);
  }
  const layer = new Map();
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const remaining = new Map(indeg);
  for (const id of queue) layer.set(id, 0);
  const topo = [];
  while (queue.length) {
    const id = queue.shift();
    topo.push(id);
    for (const t of succ.get(id)) {
      layer.set(t, Math.max(layer.get(t) || 0, layer.get(id) + 1));
      remaining.set(t, remaining.get(t) - 1);
      if (remaining.get(t) === 0) queue.push(t);
    }
  }
  for (const n of nodes) {
    if (!layer.has(n.id)) {
      const ps = pred.get(n.id).filter((p) => layer.has(p));
      layer.set(n.id, ps.length ? Math.max(...ps.map((p) => layer.get(p))) + 1 : 0);
    }
  }
  // Keep the End terminal on the last row.
  const maxLayer = Math.max(0, ...layer.values());
  if (byId.has('__end')) layer.set('__end', Math.max(maxLayer, layer.get('__end')));

  // 2. Dummy nodes for edges that span several layers.
  const all = nodes.slice();
  const chains = new Map();
  let dummyCount = 0;
  for (const e of fwd) {
    const a = layer.get(e.from);
    const b = layer.get(e.to);
    const chain = [e.from];
    for (let l = a + 1; l < b; l++) {
      const d = { id: `__d${dummyCount++}`, kind: 'dummy', w: L.dummyW, h: 1, edge: e.id };
      layer.set(d.id, l);
      all.push(d);
      byId.set(d.id, d);
      chain.push(d.id);
    }
    chain.push(e.to);
    chains.set(e.id, chain);
  }
  const up = new Map(all.map((n) => [n.id, []]));
  const down = new Map(all.map((n) => [n.id, []]));
  for (const chain of chains.values()) {
    for (let i = 0; i < chain.length - 1; i++) {
      down.get(chain[i]).push(chain[i + 1]);
      up.get(chain[i + 1]).push(chain[i]);
    }
  }

  // 3. Ordering: DFS seed order, then barycenter sweeps.
  const layers = [];
  const visitOrder = new Map();
  let counter = 0;
  const visit = (id) => {
    if (visitOrder.has(id)) return;
    visitOrder.set(id, counter++);
    for (const t of down.get(id)) visit(t);
  };
  for (const n of all) if (up.get(n.id).length === 0) visit(n.id);
  for (const n of all) visit(n.id);
  for (const n of all) {
    const l = layer.get(n.id);
    while (layers.length <= l) layers.push([]);
    layers[l].push(n.id);
  }
  for (const row of layers) row.sort((x, y) => visitOrder.get(x) - visitOrder.get(y));
  const pos = new Map();
  const reindex = () => layers.forEach((row) => row.forEach((id, i) => pos.set(id, i)));
  reindex();
  const bary = (id, neigh) => {
    const ns = neigh.get(id);
    if (!ns.length) return pos.get(id);
    return ns.reduce((s, n) => s + pos.get(n), 0) / ns.length;
  };
  for (let iter = 0; iter < 6; iter++) {
    const downward = iter % 2 === 0;
    const range = downward ? layers.map((_, i) => i).slice(1) : layers.map((_, i) => i).reverse().slice(1);
    for (const li of range) {
      const row = layers[li];
      const neigh = downward ? up : down;
      const keyed = row.map((id, i) => ({ id, k: bary(id, neigh), i }));
      keyed.sort((a, b) => a.k - b.k || a.i - b.i);
      layers[li] = keyed.map((x) => x.id);
      reindex();
    }
  }

  // 4. X placement: iterate toward neighbour averages, keep order and spacing.
  const x = new Map();
  const sep = (a, b) => (byId.get(a).w + byId.get(b).w) / 2 + (byId.get(a).kind === 'dummy' || byId.get(b).kind === 'dummy' ? L.gapX / 2 : L.gapX);
  for (const row of layers) {
    let cursor = 0;
    row.forEach((id, i) => {
      if (i === 0) cursor = byId.get(id).w / 2;
      else cursor += sep(row[i - 1], id);
      x.set(id, cursor);
    });
  }
  const center = (row) => {
    const w = row.length ? x.get(row[row.length - 1]) - x.get(row[0]) : 0;
    return w / 2;
  };
  const widest = Math.max(0, ...layers.map((r) => center(r) * 2));
  for (const row of layers) {
    const shift = widest / 2 - center(row) - (row.length ? x.get(row[0]) : 0);
    for (const id of row) x.set(id, x.get(id) + shift);
  }
  for (let iter = 0; iter < 16; iter++) {
    const downward = iter % 2 === 0;
    const order = downward ? layers.map((_, i) => i) : layers.map((_, i) => i).reverse();
    for (const li of order) {
      const row = layers[li];
      if (!row.length) continue;
      const neigh = downward ? up : down;
      const desired = row.map((id) => {
        const ns = neigh.get(id).concat(iter > 8 ? (downward ? down : up).get(id) : []);
        if (!ns.length) return x.get(id);
        return ns.reduce((s, n) => s + x.get(n), 0) / ns.length;
      });
      const left = desired.slice();
      for (let i = 1; i < row.length; i++) left[i] = Math.max(desired[i], left[i - 1] + sep(row[i - 1], row[i]));
      const right = desired.slice();
      for (let i = row.length - 2; i >= 0; i--) right[i] = Math.min(desired[i], right[i + 1] - sep(row[i], row[i + 1]));
      row.forEach((id, i) => x.set(id, (left[i] + right[i]) / 2));
    }
  }
  let minX = Infinity;
  let maxX = -Infinity;
  for (const n of all) {
    minX = Math.min(minX, x.get(n.id) - n.w / 2);
    maxX = Math.max(maxX, x.get(n.id) + n.w / 2);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    maxX = 0;
  }
  const hasBack = edges.some((e) => e.back);
  const offsetX = L.margin - minX;
  const rowPitch = L.nodeH + L.gapY;
  const cy = (id) => L.margin + layer.get(id) * rowPitch + L.nodeH / 2;
  const cx = (id) => x.get(id) + offsetX;

  const placed = nodes.map((n) => ({
    ...n,
    layer: layer.get(n.id),
    order: pos.get(n.id),
    cx: cx(n.id),
    cy: cy(n.id),
    x: cx(n.id) - n.w / 2,
    y: cy(n.id) - n.h / 2,
  }));
  const placedById = new Map(placed.map((n) => [n.id, n]));

  // 5. Edge routing with spread ports.
  const outPorts = new Map();
  const inPorts = new Map();
  for (const e of fwd) {
    const chain = chains.get(e.id);
    const nextId = chain[1];
    const prevId = chain[chain.length - 2];
    if (!outPorts.has(e.from)) outPorts.set(e.from, []);
    outPorts.get(e.from).push({ e, key: cx(nextId) });
    if (!inPorts.has(e.to)) inPorts.set(e.to, []);
    inPorts.get(e.to).push({ e, key: cx(prevId) });
  }
  const portX = new Map();
  const spread = (list, nodeId, which) => {
    const n = placedById.get(nodeId);
    list.sort((a, b) => a.key - b.key);
    const k = list.length;
    const step = k > 1 ? Math.min(46, (n.w * 0.7) / (k - 1)) : 0;
    list.forEach((p, i) => portX.set(`${which}:${p.e.id}`, n.cx + (i - (k - 1) / 2) * step));
  };
  for (const [id, list] of outPorts) spread(list, id, 'out');
  for (const [id, list] of inPorts) spread(list, id, 'in');

  const routed = edges.map((e) => {
    const src = placedById.get(e.from);
    const tgt = placedById.get(e.to);
    if (e.back) {
      const lane = maxX + offsetX + 26;
      const points = [
        [src.x + src.w, src.cy],
        [lane, src.cy],
        [lane, tgt.cy],
        [tgt.x + tgt.w, tgt.cy],
      ];
      return { ...e, points, labelPos: { x: lane, y: (src.cy + tgt.cy) / 2 } };
    }
    const chain = chains.get(e.id);
    const points = [[portX.get(`out:${e.id}`), src.y + src.h]];
    for (const d of chain.slice(1, -1)) points.push([cx(d), cy(d)]);
    points.push([portX.get(`in:${e.id}`), tgt.y]);
    const [p0, p1] = points;
    const t = 0.42;
    const labelPos = { x: p0[0] + (p1[0] - p0[0]) * t, y: p0[1] + (p1[1] - p0[1]) * t };
    return { ...e, points, labelPos };
  });

  const width = maxX - minX + L.margin * 2 + (hasBack ? 60 : 0);
  const height = L.margin * 2 + (layers.length - 1) * rowPitch + L.nodeH;
  return { nodes: placed, edges: routed, width, height, layers: layers.length };
}

/** SVG path data for an edge: smooth vertical Béziers through its points. */
export function edgePath(points, back = false) {
  if (!points || points.length < 2) return '';
  if (back) return 'M' + points.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L');
  let d = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const dy = (y1 - y0) / 2;
    d += ` C${x0.toFixed(1)},${(y0 + dy).toFixed(1)} ${x1.toFixed(1)},${(y1 - dy).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}

/** Convenience: graph + layout in one call. */
export function workflowLayout(playbook, opts) {
  const graph = buildGraph(playbook, { terminals: opts?.terminals !== false });
  return { graph, layout: layoutGraph(graph, opts) };
}
