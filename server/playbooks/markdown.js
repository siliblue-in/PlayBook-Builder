// Markdown generated directly from the Playbook JSON (spec §33). The Markdown
// is a first-class artifact: complete enough to execute from on its own.
import { buildGraph, topologicalOrder, parallelGroups, triggerLabel } from '../../shared/graph.js';
import { describeCondition } from '../engine/rules.js';
import { configMap } from './schema.js';

const cell = (v) => String(v === undefined || v === null || v === '' ? '—' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const code = (v) => '`' + String(v).replace(/`/g, 'ˋ') + '`';
const json = (v) => JSON.stringify(v, null, 2);
const inline = (v, max = 90) => {
  const s = JSON.stringify(v);
  return s && s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const pct = (v) => (typeof v === 'number' ? `${Math.round(v * 1000) / 10}%` : 'n/a');
const title = (s) => String(s || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const yes = (b) => (b ? 'Yes' : 'No');

const REQ_TITLES = { functional: 'Functional', data: 'Data', business_rule: 'Business Rules', output: 'Output', non_functional: 'Non-functional', constraint: 'Constraints' };
const DEP_TITLES = { data: 'Data', system: 'Systems', tool: 'Tools', authentication: 'Authentication & Permissions', workflow: 'Workflow', configuration: 'Configuration', human: 'Human', ai: 'AI' };

export function mermaidFlowchart(pb) {
  const g = buildGraph(pb, { terminals: true });
  const id = (x) => (x === '__start' ? 'START' : x === '__end' ? 'END' : String(x).replace(/[^A-Za-z0-9_]/g, '_'));
  const esc = (s) => String(s).replace(/"/g, "'").replace(/[\[\]{}<>]/g, ' ');
  const lines = ['flowchart TD'];
  for (const n of g.nodes) {
    if (n.kind === 'start') lines.push(`  ${id(n.id)}(["${esc(`Start · ${n.sublabel}`)}"])`);
    else if (n.kind === 'end') lines.push(`  ${id(n.id)}(["${esc(`Output · ${n.sublabel}`)}"])`);
    else if (n.type === 'decision') lines.push(`  ${id(n.id)}{"${esc(n.label)}"}`);
    else if (n.type === 'approval') lines.push(`  ${id(n.id)}[/"${esc(`Approval: ${n.label}`)}"/]`);
    else lines.push(`  ${id(n.id)}["${esc(n.label)}"]`);
  }
  for (const e of g.edges) {
    const label = e.label ? `|${esc(e.label)}|` : '';
    lines.push(`  ${id(e.from)} -->${label} ${id(e.to)}`);
  }
  return lines.join('\n');
}

export function playbookMarkdown(pb, { versions = [], lastRun = null, stale = null, generatedAt = new Date() } = {}) {
  const out = [];
  const p = (...lines) => out.push(...lines);
  const cfg = configMap(pb);
  const stepName = new Map((pb.steps || []).map((s, i) => [s.id, `Step ${i + 1} — ${s.name}`]));

  // ---- Title
  p(`# ${pb.name}`, '');
  if (pb.description) p(`> ${pb.description}`, '');
  const lt = pb.metadata && pb.metadata.last_test;
  p('| Property | Value |', '|---|---|');
  p(`| **Version** | v${pb.version} · ${title(pb.status || 'draft')} |`);
  p(`| **Schema** | ${pb.schema_version} |`);
  p(`| **Trigger** | ${cell(triggerLabel(pb.trigger))} |`);
  p(`| **AI** | ${cell(pb.ai && pb.ai.model ? `${pb.ai.model}${pb.ai.connection_id ? ` · connection ${pb.ai.connection_id}` : ''}` : 'Not set (deterministic execution available)')} |`);
  p(`| **Quality gate** | ${pb.metadata && pb.metadata.quality_gate_passed ? 'Passed' : 'Not passed'} |`);
  p(`| **Latest test** | ${lt ? `${lt.status.toUpperCase()} · ${lt.mode} · ${lt.at ? lt.at.slice(0, 10) : ''}${lt.stale ? ' · stale' : ''}` : 'Not tested'} |`);
  p('');

  // ---- Objective / Scope
  p('## Objective', '', pb.objective || '—', '');
  p('## Scope', '', pb.scope || '—', '');

  // ---- Requirements
  p('## Requirements', '');
  const reqGroups = {};
  for (const r of pb.requirements || []) (reqGroups[r.type] = reqGroups[r.type] || []).push(r);
  if (!(pb.requirements || []).length) p('_No requirements defined._', '');
  for (const type of Object.keys(REQ_TITLES)) {
    const list = reqGroups[type];
    if (!list) continue;
    p(`**${REQ_TITLES[type]}**`, '');
    for (const r of list) {
      p(`- **${r.id}** — ${r.text}`);
      if (r.rule) p(`  - Rule: ${code(describeCondition(r.rule, cfg))}${r.result !== undefined ? ` → ${code(r.result)}` : ''}`);
    }
    p('');
  }

  // ---- Assumptions
  p('## Assumptions', '');
  if ((pb.assumptions || []).length) for (const a of pb.assumptions) p(`- ${a}`);
  else p('_None._');
  p('');

  // ---- Dependencies
  p('## Dependencies', '');
  const depGroups = {};
  for (const d of pb.dependencies || []) (depGroups[d.type] = depGroups[d.type] || []).push(d);
  for (const type of Object.keys(DEP_TITLES)) {
    const list = depGroups[type];
    if (!list) continue;
    p(`**${DEP_TITLES[type]}**`, '');
    for (const d of list) p(`- **${d.name}**${d.required ? '' : ' _(optional)_'}${d.description ? ` — ${d.description}` : ''}`);
    p('');
  }
  const wf = [];
  for (const s of pb.steps || []) for (const d of s.dependencies || []) wf.push(`- ${s.id} depends on ${d}`);
  if (wf.length) p('**Workflow (derived from step dependencies)**', '', ...wf, '');

  // ---- Configuration
  p('## Configuration', '');
  if ((pb.configuration || []).length) {
    p('| Name | Type | Value | Description |', '|---|---|---|---|');
    for (const c of pb.configuration) {
      const extra = c.allowed_values ? ` (allowed: ${c.allowed_values.join(', ')})` : typeof c.min === 'number' || typeof c.max === 'number' ? ` (range ${c.min ?? '−∞'}–${c.max ?? '∞'})` : '';
      p(`| ${code(c.name)} | ${cell(c.type)} | ${cell(inline(c.value, 60))} | ${cell((c.description || '') + extra)} |`);
    }
  } else p('_No configuration values._');
  p('');

  // ---- Inputs
  p('## Inputs', '');
  if (!(pb.inputs || []).length) p('_No inputs defined._', '');
  for (const i of pb.inputs || []) {
    p(`### ${i.name} (${code(i.id)})`, '');
    if (i.description) p(i.description, '');
    p(`- **Type:** ${i.type} · **Required:** ${yes(i.required)} · **Source:** ${i.source}`);
    if ((i.validation || []).length) {
      p('- **Validation:**');
      for (const v of i.validation) p(`  - ${v}`);
    }
    p('');
    if (i.example !== undefined) p('**Example**', '', '```json', json(i.example), '```', '');
  }

  // ---- Tools
  p('## Tools', '');
  if (!(pb.tools || []).length) p('_No tools are required — every input is supplied directly to the run._', '');
  for (const t of pb.tools || []) {
    p(`### ${t.name} (${code(t.id)})`, '');
    p(`- **Purpose:** ${t.purpose || '—'}`);
    p(`- **Permission:** ${title(t.permission)}`);
    p(`- **Required:** ${yes(t.required)}`);
    if (t.binding) p(`- **Binding:** ${code(inline(t.binding, 120))}`);
    p('');
  }

  // ---- Permissions
  p('## Permissions', '');
  const allowed = (pb.permissions || []).filter((x) => x.allowed);
  const denied = (pb.permissions || []).filter((x) => !x.allowed);
  p('**Allowed**', '');
  if (allowed.length) for (const a of allowed) p(`- ${a.action}`);
  else p('- _Nothing explicitly allowed._');
  p('', '**Not allowed**', '');
  if (denied.length) for (const a of denied) p(`- ${a.action}`);
  else p('- _Nothing explicitly forbidden._');
  p('');

  // ---- Trigger
  p('## Trigger', '');
  p(`- **Type:** ${triggerLabel(pb.trigger)}`);
  for (const k of ['frequency', 'day', 'time', 'timezone', 'event', 'description']) if (pb.trigger && pb.trigger[k]) p(`- **${title(k)}:** ${pb.trigger[k]}`);
  p('');

  // ---- Workflow
  p('## Workflow', '');
  p('```mermaid', mermaidFlowchart(pb), '```', '');
  p('**Execution order**', '');
  const order = topologicalOrder(pb);
  order.forEach((id, i) => {
    const s = pb.steps.find((x) => x.id === id);
    if (!s) return;
    const deps = (s.dependencies || []).length ? ` ← after ${s.dependencies.join(', ')}` : '';
    p(`${i + 1}. **${s.id} — ${s.name}** (${s.type})${deps}`);
  });
  p('');
  const par = parallelGroups(pb);
  if (par.length) {
    p('**Parallel groups** — these steps are independent and may run at the same time:', '');
    for (const g of par) p(`- ${g.steps.join(', ')}${g.after.length ? ` (after ${g.after.join(', ')})` : ' (at start)'}`);
    p('');
  }

  // ---- Detailed steps
  p('## Detailed Step Specifications', '');
  (pb.steps || []).forEach((s, idx) => {
    p(`### Step ${idx + 1} — ${s.name}`, '');
    p(`${code(s.id)} · ${s.type}${s.requires_approval ? ' · requires human approval' : ''}${s.side_effects && s.side_effects !== 'none' ? ` · side effects: ${s.side_effects}` : ''}`, '');
    p(`**Purpose:** ${s.purpose || '—'}`, '');
    if (s.rationale) p(`**Why it exists:** ${s.rationale}`, '');
    p('**Inputs:**', '');
    if ((s.inputs || []).length) for (const x of s.inputs) p(`- ${x}`);
    else p('- _None._');
    p('', '**Dependencies:**', '');
    if ((s.dependencies || []).length) for (const d of s.dependencies) p(`- ${d} — ${stepName.get(d) || 'unknown step'}`);
    else p('- _None — entry step._');
    p('');
    if ((s.preconditions || []).length) {
      p('**Preconditions:**', '');
      for (const x of s.preconditions) p(`- ${x}`);
      p('');
    }
    p('**Instructions:**', '');
    (s.instructions || []).forEach((x, i) => p(`${i + 1}. ${x}`));
    p('');
    if ((s.decision_logic || []).length) {
      p('**Decision logic:**', '', '| Rule | Condition | Result | Next |', '|---|---|---|---|');
      for (const b of s.decision_logic) {
        const rule = (pb.decision_rules || []).find((r) => r.id === b.rule_id);
        const cond = rule ? describeCondition(rule.when, cfg) : b.condition;
        p(`| ${cell(b.rule_id)} | ${cell(cond)} | ${cell(b.result)} | ${cell([].concat(b.next || []).join(', '))} |`);
      }
      p('');
    }
    p(`**Tools:** ${(s.tools || []).length ? s.tools.map(code).join(', ') : 'none'}`, '');
    p(`**Output:** ${code(s.output.name)} (${s.output.type})${s.output.description ? ` — ${s.output.description}` : ''}`, '');
    if (s.output.schema) p('**Output schema:**', '', '```json', json(s.output.schema), '```', '');
    p('**Validation:**', '');
    if ((s.validation || []).length) for (const x of s.validation) p(`- ${x}`);
    else p('- _None._');
    p('');
    if ((s.postconditions || []).length) {
      p('**Postconditions:**', '');
      for (const x of s.postconditions) p(`- ${x}`);
      p('');
    }
    const retry = typeof s.retry_behavior === 'object' ? `up to ${s.retry_behavior.max_attempts} attempts on ${(s.retry_behavior.retry_on || []).join(', ') || 'retryable errors'}` : 'not applicable';
    p(`**On failure:** ${title(s.failure_behavior)} · **Retry:** ${retry}`, '');
    if (s.execution) p('**Machine-readable execution:**', '', '```json', json(s.execution), '```', '');
  });

  // ---- Decision rules
  p('## Decision Rules', '');
  if ((pb.decision_rules || []).length) {
    p('| ID | Name | Step | Priority | Condition | Result |', '|---|---|---|---|---|---|');
    for (const r of pb.decision_rules) p(`| ${code(r.id)} | ${cell(r.name)} | ${cell(r.step_id)} | ${cell(r.priority)} | ${cell(describeCondition(r.when, cfg))} | ${cell(r.result)} |`);
    p('', 'Rules are evaluated in priority order; the first matching rule wins.', '');
  } else p('_No machine-readable decision rules._', '');

  // ---- Output
  p('## Output', '');
  p(`- **Format:** ${pb.output.format}`);
  if (pb.output.destination) p(`- **Destination:** ${pb.output.destination}`);
  if (pb.output.description) p(`- **Description:** ${pb.output.description}`);
  p('');
  if ((pb.output.sections || []).length) {
    p('**Sections**', '');
    pb.output.sections.forEach((x, i) => p(`${i + 1}. ${x}`));
    p('');
  }
  if ((pb.output.fields || []).length) {
    p('| Field | Type | Required | Description |', '|---|---|---|---|');
    for (const f of pb.output.fields) p(`| ${code(f.name)} | ${cell(f.type + (f.enum ? ` (${f.enum.join(' \\| ')})` : ''))} | ${yes(f.required)} | ${cell(f.description)} |`);
    p('');
  }
  if (pb.output.schema) p('**Output schema**', '', '```json', json(pb.output.schema), '```', '');
  if (pb.output.example !== undefined) p('**Example output**', '', '```json', json(pb.output.example), '```', '');

  // ---- Validation
  p('## Validation', '');
  for (const level of ['step', 'workflow', 'output', 'intent']) {
    const list = (pb.validation || []).filter((v) => v.level === level);
    if (!list.length) continue;
    p(`**${title(level)} validation**`, '');
    for (const v of list) p(`- ${v.rule}`);
    p('');
  }
  if (!(pb.validation || []).length) p('_No validation rules._', '');

  // ---- Error handling
  p('## Error Handling', '');
  const eh = pb.error_handling || {};
  p(`- **Default strategy:** ${title(eh.default_strategy || 'stop')}`);
  const rp = eh.retry || {};
  p(`- **Retry policy:** ${rp.enabled ? `enabled — up to ${rp.max_attempts} attempts on ${(rp.retry_on || []).join(', ')}${rp.backoff_seconds ? `, ${rp.backoff_seconds}s backoff` : ''}` : 'disabled'}`);
  p('- Deterministic validation failures are never retried.', '');
  if ((eh.strategies || []).length) {
    p('| When | Strategy | Then | Notes |', '|---|---|---|---|');
    for (const s of eh.strategies) p(`| ${cell(s.on)}${s.step_id ? ` (${s.step_id})` : ''} | ${cell(title(s.strategy))} | ${cell(s.then ? title(s.then) : '')} | ${cell(s.notes)} |`);
    p('');
  }

  // ---- Success criteria
  p('## Success Criteria', '', 'The playbook succeeds when:', '');
  for (const c of pb.success_criteria || []) p(`- ${c.text}`);
  if (!(pb.success_criteria || []).length) p('- _No success criteria defined._');
  p('');

  // ---- Test plan
  p('## Test Plan', '');
  const tests = pb.tests || [];
  if (tests.length) {
    p('| ID | Test | Category | Input | Expected | Runs |', '|---|---|---|---|---|---|');
    for (const t of tests) {
      const expected = t.expected !== undefined ? inline(t.expected, 70) : t.expected_error ? `error ${t.expected_error}` : t.expected_status ? `status ${t.expected_status}` : t.expected_behavior || '';
      p(`| ${code(t.id)} | ${cell(t.name)} | ${cell(t.category)} | ${cell(code(inline(t.input, 70)))} | ${cell(expected)} | ${t.runs || 1} |`);
    }
    p('');
  } else p('_No test cases yet._', '');

  // ---- Latest results
  p('## Latest Test Results', '');
  if (lastRun && lastRun.metrics) {
    const m = lastRun.metrics;
    if (stale && stale.stale) p(`> ⚠ Playbook changed since last test (${stale.reason === 'suite_changed' ? 'test suite changed' : 'procedure changed'}). Run the tests again.`, '');
    p(`**Status: ${String(lastRun.result_status || '').toUpperCase()}** · ${lastRun.mode === 'ai' ? 'AI Execution' : 'Deterministic Fixture'} · ${lastRun.ended_at ? lastRun.ended_at.replace('T', ' ').slice(0, 16) : ''} UTC${lastRun.environment && lastRun.environment.model ? ` · model ${lastRun.environment.model}` : ''}`, '');
    p(`- ${m.counts.passed} / ${m.counts.executed} tests passed`);
    if (m.counts.repeatability_runs) p(`- ${m.counts.repeatability_matched} / ${m.counts.repeatability_runs} repeatability runs matched`);
    p('');
    p('| Metric | Value |', '|---|---|');
    const rows = [
      ['Task Alignment', m.metrics.task_alignment],
      ['Requirement Coverage', m.metrics.requirement_coverage],
      ['Rule Adherence', m.metrics.rule_adherence],
      ['Accuracy', m.metrics.accuracy],
      ['Consistency', m.metrics.consistency],
      ['Output Compliance', m.metrics.output_compliance],
      ['Error Handling', m.metrics.error_handling],
    ];
    for (const [k, v] of rows) p(`| ${k} | ${pct(v)} |`);
    p('');
    const failed = (lastRun.results || []).filter((r) => r.status !== 'pass');
    if (failed.length) {
      p('**Failures**', '');
      for (const r of failed) p(`- **${r.name}** (${r.status.toUpperCase()}): ${(r.diagnosis || []).join(' ')}`);
      p('');
    }
    p(`_${m.disclaimer}_`, '');
  } else p('_Not tested yet._', '');

  // ---- Version
  p('## Version', '');
  p(`Current: **v${pb.version}** (${title(pb.status || 'draft')}) · hash ${code((pb.metadata && pb.metadata.hash) || '')}`, '');
  if (versions.length) {
    p('| Version | Status | Created | Source | Note | Last test |', '|---|---|---|---|---|---|');
    for (const v of versions) p(`| v${v.version} | ${title(v.status)} | ${cell((v.created_at || '').slice(0, 10))} | ${cell(v.source)} | ${cell(v.change_note)} | ${cell(v.last_test ? v.last_test.status.toUpperCase() : '')} |`);
    p('');
  }
  p('---', '', `_Generated by Playbook Builder for AI from the canonical Playbook JSON on ${generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC. Powered By SiliBlue.in_`, '');
  return out.join('\n');
}
