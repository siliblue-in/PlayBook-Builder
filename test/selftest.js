// End-to-end self-test: `npm test`. Runs entirely offline with a scripted AI
// provider, against a throwaway data folder, through the real HTTP API.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import './mock-provider.js';
import { mockState } from './mock-provider.js';
import { startFakeOllama } from './fake-ollama.js';
import { createApp } from '../server/app.js';
import * as Launch from '../launcher/lib.js';
import { sanitizeName, STANDARD_DIRS } from '../server/workspace/workspace.js';
import { readZip, createZip } from '../server/workspace/zip.js';
import { compareExpected } from '../server/testing/compare.js';
import { nextRun } from '../server/engine/scheduler.js';
import { extractJson } from '../server/ai/json.js';
import { normalizeLocalResponse, emptyResponseError, isThinkingModel } from '../server/ai/local.js';
import { AnthropicProvider } from '../server/ai/anthropic.js';
import * as Progress from '../server/progress.js';
import { poll } from '../public/api.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbai-selftest-'));
// Never let a configured workspace folder receive test playbooks.
delete process.env.PBAI_WORKSPACES_DIR;
const scratchDirs = [];
const app = createApp({ dataDir, quiet: true });
await app.init();
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;

let passed = 0;
let failed = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) {
    passed++;
    results.push(`  ✓ ${name}`);
  } else {
    failed++;
    results.push(`  ✗ ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}` : ''}`);
  }
}
async function api(method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : type.includes('pdf') ? Buffer.from(await res.arrayBuffer()) : await res.text();
  return { status: res.status, data, type };
}
const section = (t) => results.push(`\n${t}`);

try {
  section('Built-in example');
  let r = await api('GET', '/api/playbooks');
  const good = r.data.playbooks.find((p) => p.example_key === 'customer_risk_evaluator');
  const broken = r.data.playbooks.find((p) => p.example_key === 'customer_risk_evaluator_broken');
  check('examples seeded', good && broken);
  check('example passes 7/7 with 20/20 repeatability', good.last_test.status === 'pass' && good.last_test.counts.passed === 7 && good.last_test.counts.repeatability_matched === 20, good.last_test);
  check('broken demo v2 fails', broken.current_version === 2 && broken.last_test.status === 'fail', broken.last_test);
  r = await api('GET', `/api/playbooks/${broken.id}/test-runs`);
  const brokenRun = (await api('GET', `/api/test-runs/${r.data.test_runs[0].id}`)).data;
  check('test run envelope typed', brokenRun.response_type === 'test_result');
  const b14 = brokenRun.data.test_run.results.find((x) => x.name === 'Boundary 14');
  check('Boundary 14: expected at_risk, actual healthy', b14.status === 'fail' && b14.runs[0].output.decision === 'healthy', b14.runs[0]);
  const sug = brokenRun.data.test_run.repair_suggestions[0];
  check('suggested fix is `>` → `>=` and verified', sug && /`>` to `>=`/.test(sug.fix_summary) && sug.verification.verified, sug);

  section('Regression + repair + publish');
  r = await api('POST', `/api/playbooks/${broken.id}/repair/apply`, { test_run_id: brokenRun.data.test_run.id, suggestion_id: sug.id });
  check('repair creates v3 and retest passes', r.data.current_version === 3 && r.data.retest.result_status === 'pass', r.data.retest && r.data.retest.metrics);
  r = await api('GET', `/api/playbooks/${broken.id}/compare?a=1&b=2`);
  check('compare shows accuracy drop and operator change', r.data.metrics.find((m) => m.metric === 'accuracy').delta < 0 && r.data.changes.some((c) => c.path.includes('operator')), r.data);
  r = await api('POST', `/api/playbooks/${broken.id}/publish`, { version: 2 });
  check('failed version cannot be published', r.status === 409, r.data);
  r = await api('POST', `/api/playbooks/${broken.id}/publish`, { version: 3 });
  check('v3 publishes', r.status === 200 && r.data.version.status === 'published', r.data);
  r = await api('PUT', `/api/playbooks/${broken.id}`, { playbook: { ...r.data.playbook, objective: 'Changed objective for immutability test.' }, change_note: 'edit' });
  check('editing a published version creates v4', r.data.saved && r.data.saved.created_new_version && r.data.saved.version === 4, r.data.saved);
  check('new version shows stale tests', r.data.stale.stale === true, r.data.stale);
  r = await api('POST', `/api/playbooks/${broken.id}/promote`, { version: 3 });
  check('promote v3 to production', r.data.production_version === 3);

  section('Runs + policies');
  r = await api('POST', `/api/playbooks/${broken.id}/run`, { input: { customer: { name: 'Stark', days_since_activity: 14 } }, wait: true });
  check('production run (v3) returns at_risk at 14', r.data.response_type === 'execution_result' && r.data.data.run.output.decision === 'at_risk' && r.data.data.run.environment === 'production' && r.data.data.run.version === 3, r.data.data && r.data.data.run);
  r = await api('POST', `/api/playbooks/${broken.id}/run`, { version: 4, environment: 'production', input: {} });
  check('draft cannot run in production', r.status === 409, r.data);
  r = await api('POST', `/api/playbooks/${broken.id}/run`, { version: 4, input: {}, wait: true });
  check('missing input → needs_input', r.data.data.run.status === 'needs_input', r.data.data.run);

  // Approval + external tool policy playbook (imported).
  const approvalPb = {
    name: 'Notify Owner After Approval',
    objective: 'Send an owner notification only after a human approves it.',
    requirements: ['Require approval before any external message.'],
    dependencies: [{ type: 'human', name: 'Approver' }],
    inputs: [{ id: 'owner', name: 'Owner', type: 'string', required: true, source: 'Run input', example: 'Dana' }],
    tools: [{ id: 'webhook', name: 'Notification webhook', purpose: 'Send the notification.', permission: 'write', required: true, side_effects: 'external', binding: { type: 'http_request', method: 'POST', url: 'https://example.invalid/notify' } }],
    permissions: { allowed: ['Send one notification after approval'], not_allowed: ['Send without approval'] },
    steps: [
      { id: 'step_01', name: 'Draft Message', type: 'transform', purpose: 'Compose the text.', inputs: ['input.owner'], instructions: ['Write the message.', 'Keep it short.'], output: { name: 'message' }, validation: ['Not empty.'], execution: { op: 'set', values: { message: "concat('Hello ', input.owner)" } } },
      { id: 'step_02', name: 'Human Approval', type: 'approval', dependencies: ['step_01'], purpose: 'Get approval.', inputs: ['state.message'], instructions: ['Show the message.', 'Wait for a decision.'], output: { name: 'approval' }, validation: ['Decision recorded.'], execution: { op: 'approval' } },
      { id: 'step_03', name: 'Send Notification', type: 'action', side_effects: 'external', dependencies: ['step_02'], tools: ['webhook'], purpose: 'Send it.', inputs: ['state.message'], instructions: ['Call the webhook.', 'Record the response.'], output: { name: 'sent' }, validation: ['Response recorded.'], execution: { op: 'tool', tool_id: 'webhook', args: { text: 'state.message' }, assign: 'sent' } },
      { id: 'step_04', name: 'Result', type: 'output', dependencies: ['step_03'], purpose: 'Return result.', inputs: ['state.message'], instructions: ['Return message.', 'Return status.'], output: { name: 'result' }, validation: ['Fields present.'], execution: { op: 'output', mapping: { message: 'state.message', sent: 'exists(state.sent)' } } },
    ],
    output: { format: 'json', fields: [{ name: 'message', type: 'string', required: true }, { name: 'sent', type: 'boolean', required: true }] },
    validation: ['Approval happens before sending.'],
    error_handling: { default_strategy: 'stop' },
    success_criteria: ['No message is sent without approval.'],
    tests: [{ name: 'Draft only', input: { owner: 'Dana' }, expected: { message: 'Hello Dana' } }],
  };
  r = await api('POST', '/api/playbooks', { playbook: approvalPb });
  check('import playbook with tests', r.status === 200 && r.data.suite.count === 1, r.data);
  const apId = r.data.id;
  r = await api('POST', `/api/playbooks/${apId}/run`, { input: { owner: 'Dana' }, wait: true });
  let run = r.data.data.run;
  check('sandbox run pauses for human approval', run.status === 'awaiting_approval' && run.pending_approval, run.status);
  r = await api('POST', `/api/runs/${run.id}/approvals/${run.pending_approval.id}`, { decision: 'approve' });
  run = r.data.data.run;
  check('after approval the external call is simulated in sandbox', run.status === 'completed' && run.warnings.some((w) => w.code === 'TOOL_SIMULATED'), run);
  r = await api('POST', `/api/playbooks/${apId}/run`, { input: { owner: 'Lee' }, wait: true });
  run = r.data.data.run;
  r = await api('POST', `/api/runs/${run.id}/approvals/${run.pending_approval.id}`, { decision: 'reject', note: 'Not now' });
  check('rejected approval stops the run', r.data.data.run.status === 'failed' && r.data.data.run.error.code === 'APPROVAL_REJECTED', r.data.data.run.error);

  section('Scheduled playbooks');
  r = await api('POST', '/api/playbooks', {
    playbook: {
      name: 'Scheduled Echo',
      objective: 'Echo the scheduled input so schedule triggering can be verified.',
      requirements: ['Return the input text.'],
      dependencies: [{ type: 'configuration', name: 'Schedule input' }],
      trigger: { type: 'schedule', frequency: 'every 1 minutes' },
      inputs: [{ id: 'x', name: 'Text', type: 'string', required: true, source: 'Schedule input', example: 'hello' }],
      steps: [
        { id: 'step_01', name: 'Read', type: 'validate', purpose: 'Check input.', inputs: ['input.x'], instructions: ['Confirm x is text.', 'Stop if missing.'], output: { name: 'ok' }, validation: ['x present'], execution: { op: 'validate', subject: 'input', checks: [{ path: 'x', required: true, type: 'string' }] } },
        { id: 'step_02', name: 'Echo', type: 'output', dependencies: ['step_01'], purpose: 'Return x.', inputs: ['input.x'], instructions: ['Copy x.', 'Return it.'], output: { name: 'result' }, validation: ['echo equals x'], execution: { op: 'output', mapping: { echo: 'input.x' } } },
      ],
      output: { format: 'json', fields: [{ name: 'echo', type: 'string', required: true }] },
      validation: ['echo equals input'],
      error_handling: { default_strategy: 'stop' },
      success_criteria: ['echo equals input'],
      tests: [{ name: 'Echo', input: { x: 'hello' }, expected: { echo: 'hello' } }],
    },
  });
  const schedId = r.data.id;
  r = await api('POST', `/api/playbooks/${schedId}/test`, { mode: 'deterministic', wait: true });
  check('scheduled playbook tests pass', r.data.data.test_run.result_status === 'pass', r.data.data.test_run.metrics && r.data.data.test_run.metrics.reasons);
  r = await api('POST', `/api/playbooks/${schedId}/publish`, {});
  check('scheduled playbook published', r.data.version && r.data.version.status === 'published', r.data);
  r = await api('PATCH', `/api/playbooks/${schedId}`, { schedule: { enabled: true, input: { x: 'from schedule' } } });
  check('schedule enabled', r.data.schedule.enabled === true);
  const started = await app.scheduler.tick(new Date(Date.now() + 120000));
  await new Promise((res) => setTimeout(res, 150));
  const schedRun = started.length ? (await api('GET', `/api/runs/${started[0]}`)).data.data.run : null;
  check('scheduler starts a production run with the schedule input', schedRun && schedRun.trigger === 'schedule' && schedRun.output && schedRun.output.echo === 'from schedule', schedRun);
  r = await api('POST', `/api/hooks/${schedId}/wrong-token`, { x: 'hook' });
  check('webhook rejects a wrong token', r.status === 403);

  section('AI connection (mock provider)');
  r = await api('POST', '/api/connections', { provider: 'mock', name: 'Mock', api_key: 'test-key-123456' });
  const connId = r.data.id;
  check('connection created with masked key', connId && r.data.api_key_masked && !JSON.stringify(r.data).includes('test-key-123456'), r.data);
  r = await api('POST', `/api/connections/${connId}/test`);
  check('connection test ok', r.data.status === 'ok', r.data);
  r = await api('GET', `/api/connections/${connId}/models`);
  check('models load', r.data.count === 2);
  r = await api('PUT', `/api/connections/${connId}`, { models: { clarification: 'mock/fast', generation: 'mock/smart', execution: 'mock/smart', testing: 'mock/smart', evaluation: 'mock/fast' } });
  check('role models saved', r.data.models.generation === 'mock/smart');
  const stored = fs.readFileSync(path.join(dataDir, 'connections', `${connId}.json`), 'utf8');
  check('API key encrypted at rest', !stored.includes('test-key-123456'));

  section('Discovery → confirm → compile');
  r = await api('POST', '/api/discovery/start', { goal: 'Flag inactive sales opportunities every Monday' });
  check('first response is a clarification_question', r.data.response_type === 'clarification_question' && r.data.data.questions.length === 1, r.data);
  const sid = r.data.data.session.id;
  const q1 = r.data.data.questions[0];
  check('options are dynamic and "Something else" removed', q1.options.length === 3 && q1.allow_other, q1.options);
  r = await api('POST', `/api/discovery/${sid}/answer`, { question_id: q1.id, option_ids: ['b'] });
  check('second question asks a new slot', r.data.response_type === 'clarification_question' && r.data.data.questions[0].slot === 'data_sources', r.data);
  const q2 = r.data.data.questions[0];
  r = await api('POST', '/api/playbooks/generate', { session_id: sid });
  check('generation blocked before completion/confirmation', r.status === 409, r.data);
  r = await api('POST', `/api/discovery/${sid}/answer`, { question_id: q2.id, option_ids: ['a'] });
  check('discovery completes with intent', r.data.response_type === 'clarification_complete' && r.data.data.summary.length >= 4, r.data);
  r = await api('POST', `/api/discovery/${sid}/intent`, { intent: { rules: ['No activity for 14 or more days = attention required', 'Closed deals are ignored'] } });
  check('intent edit keeps it unconfirmed', r.data.data.session.intent_confirmed === false && r.data.data.intent.rules.length === 2);
  r = await api('POST', `/api/discovery/${sid}/confirm`, {});
  check('intent confirmed', r.data.data.session.intent_confirmed === true);
  r = await api('POST', '/api/playbooks/generate', { session_id: sid });
  check('compiler returns typed playbook envelope', r.status === 200 && r.data.response_type === 'playbook', r.data);
  check('quality gate passes after repair loop', r.data.data && r.data.data.quality_gate.passed && mockState.compilerCalls === 2, { calls: mockState.compilerCalls, gate: r.data.data && r.data.data.quality_gate.checks.filter((c) => !c.passed) });
  const genId = r.data.data.id;
  const gpb = r.data.data.playbook;
  check('messy AI output normalized (ids, deps by name, value_ref, permissions)', gpb.steps[1].dependencies[0] === 'step_01' && gpb.decision_rules[0].when.value_ref === 'config.inactivity_threshold_days' && gpb.decision_rules[0].step_id === 'step_03' && gpb.permissions.some((p) => !p.allowed), { deps: gpb.steps[1].dependencies, rule: gpb.decision_rules[0] });
  check('playbook is a procedure, not a result', gpb.steps.length === 7 && !gpb.report);
  check('tests auto-generated', r.data.data.tests_generated >= 2, r.data.data);

  section('Tests on generated playbook');
  r = await api('POST', `/api/playbooks/${genId}/test`, { mode: 'deterministic', wait: true });
  const detRun = r.data.data.test_run;
  check('deterministic suite: every generated test passes', detRun.metrics.metrics.accuracy === 1 && detRun.metrics.counts.failed === 0, detRun.metrics && detRun.metrics.reasons);
  check('uncovered business rule reported as a coverage warning', detRun.result_status === 'warning' && detRun.metrics.coverage.requirements_uncovered.length > 0, detRun.metrics.coverage);
  r = await api('POST', `/api/playbooks/${genId}/tests/generate`, { strategy: 'ai' });
  check('AI test generation (typed test_case)', r.data.response_type === 'test_case' && r.data.data.added.length === 3, r.data);

  section('AI Execution mode + evaluation');
  mockState.flakyEvery = 0;
  r = await api('POST', `/api/playbooks/${good.id}/test`, { mode: 'ai', wait: true });
  let aiRun = r.data.data.test_run;
  check('AI mode suite passes with evaluator', aiRun.result_status === 'pass' && aiRun.metrics.metrics.task_alignment > 0.9 && aiRun.metrics.metrics.rule_adherence === 1, aiRun.metrics);
  check('usage and cost tracked', aiRun.usage.calls > 0 && aiRun.usage.cost > 0, aiRun.usage);
  mockState.flakyEvery = 20;
  mockState.executionCalls = 0;
  app.settings.update({ testing: { ai_concurrency: 1 } });
  r = await api('POST', `/api/playbooks/${good.id}/test`, { mode: 'ai', wait: true, test_ids: ['tc_07'], ai_evaluation: false });
  aiRun = r.data.data.test_run;
  const rep = aiRun.results[0];
  check('19/20 repeatability → WARNING, 95% accuracy & agreement', aiRun.result_status === 'warning' && rep.agreement === 0.95 && aiRun.metrics.metrics.accuracy === 0.95, { status: aiRun.result_status, agreement: rep.agreement, m: aiRun.metrics.metrics });
  check('model deviation detected by rule adherence', aiRun.metrics.metrics.rule_adherence === 0.95, aiRun.metrics.metrics);
  check('partial suite does not change version status', (await api('GET', `/api/playbooks/${good.id}`)).data.version.last_test.status === 'pass');
  mockState.flakyEvery = 0;

  r = await api('POST', `/api/playbooks/${good.id}/run`, { mode: 'ai', input: { customer: { name: 'AI Co', days_since_activity: 40 } }, wait: true });
  check('AI execution run completes', r.data.data.run.status === 'completed' && r.data.data.run.output.decision === 'at_risk' && r.data.data.run.model === 'mock/smart', r.data.data.run);
  r = await api('POST', `/api/playbooks/${genId}/run`, { mode: 'ai', input: { opportunities: [{ id: 'x1', name: 'Deal', owner: 'Kim', last_activity_date: '2020-01-01' }] }, wait: true });
  check('AI run uses tool calling loop', r.data.data.run.status === 'completed' && r.data.data.run.logs.some((l) => /Tool call/.test(l.message)), r.data.data.run.logs && r.data.data.run.logs.map((l) => l.message));

  section('Exports');
  r = await api('GET', `/api/playbooks/${good.id}/markdown`);
  const md = r.data;
  const sections = ['## Objective', '## Scope', '## Requirements', '## Dependencies', '## Configuration', '## Inputs', '## Tools', '## Permissions', '## Trigger', '## Workflow', '## Detailed Step Specifications', '## Decision Rules', '## Output', '## Validation', '## Error Handling', '## Success Criteria', '## Test Plan', '## Latest Test Results', '## Version'];
  const missing = sections.filter((s) => !md.includes(s));
  check('Markdown has every required section', !missing.length, missing);
  check('Markdown contains mermaid workflow', md.includes('```mermaid') && md.includes('flowchart TD'));
  r = await api('GET', `/api/playbooks/${good.id}/pdf`);
  check('PDF export is a valid PDF', r.type.includes('pdf') && r.data.slice(0, 5).toString() === '%PDF-' && r.data.includes(Buffer.from('%%EOF')), r.type);
  r = await api('GET', `/api/playbooks/${good.id}/json`);
  const exported = r.data;
  const keys = ['schema_version', 'id', 'name', 'description', 'version', 'objective', 'scope', 'requirements', 'assumptions', 'dependencies', 'ai', 'inputs', 'configuration', 'tools', 'permissions', 'trigger', 'steps', 'decision_rules', 'output', 'validation', 'error_handling', 'success_criteria', 'tests'];
  check('JSON export has the canonical structure', keys.every((k) => k in exported), keys.filter((k) => !(k in exported)));
  r = await api('POST', '/api/playbooks', { playbook: exported });
  check('exported JSON re-imports', r.status === 200 && r.data.suite.count === exported.tests.length, r.data);

  section('Settings & feature switches');
  app.settings.update({ features: { pdf_export: false } });
  r = await api('GET', `/api/playbooks/${good.id}/pdf`);
  check('PDF export switch enforced', r.status === 403 && r.data.error.code === 'feature_disabled');
  app.settings.update({ features: { pdf_export: true } });
  r = await api('PUT', '/api/settings', { behavior: { max_questions_per_round: 99 } });
  check('invalid settings rejected', r.status === 400);
  r = await api('PUT', '/api/settings', { appearance: { theme: 'dark' } });
  check('appearance saved', r.data.appearance.theme === 'dark');
  r = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  check('cross-origin writes blocked', r.status === 403);

  section('Validator');
  r = await api('POST', '/api/playbooks', { playbook: { name: 'Cyclic', objective: 'Test cycle detection works.', steps: [{ id: 'a', name: 'A', dependencies: ['b'], instructions: ['x', 'y'] }, { id: 'b', name: 'B', dependencies: ['a'], instructions: ['x', 'y'] }] } });
  const gate = r.data.version.quality_gate;
  check('circular dependency rejected by quality gate', !gate.passed && gate.failed_checks.some((c) => c.id === 'no_cycles'), gate.failed_checks);
  r = await api('POST', `/api/playbooks/${r.data.id}/publish`, {});
  check('gate failure blocks publishing', r.status === 409);

  section('LLM-only steps in deterministic mode');
  r = await api('POST', '/api/playbooks', {
    playbook: {
      name: 'Summarise Ticket',
      objective: 'Write a one-paragraph summary of a support ticket for the on-call engineer.',
      requirements: ['Summarise the ticket in one paragraph.'],
      dependencies: [{ type: 'data', name: 'Ticket text' }],
      inputs: [{ id: 'ticket', name: 'Ticket', type: 'string', required: true, source: 'Run input', example: 'Customer cannot log in since the update.' }],
      steps: [
        { id: 'step_01', name: 'Summarise', type: 'generate', purpose: 'Write the summary.', inputs: ['input.ticket'], instructions: ['Read the ticket.', 'Write one paragraph.'], output: { name: 'summary' }, validation: ['One paragraph.'], execution: { op: 'llm', assign: 'summary' } },
        { id: 'step_02', name: 'Return', type: 'output', dependencies: ['step_01'], purpose: 'Return it.', inputs: ['state.summary'], instructions: ['Map the summary.', 'Return it.'], output: { name: 'result' }, validation: ['Present.'], execution: { op: 'output', mapping: { summary: 'state.summary' } } },
      ],
      output: { format: 'json', fields: [{ name: 'summary', type: 'string', required: true }] },
      validation: ['Summary present.'],
      error_handling: { default_strategy: 'stop' },
      success_criteria: ['A summary is returned.'],
      tests: [{ name: 'Login ticket', input: { ticket: 'Cannot log in.' }, expected: { summary: { $contains: 'log' } } }],
    },
  });
  const llmId = r.data.id;
  r = await api('POST', `/api/playbooks/${llmId}/test`, { mode: 'deterministic', wait: true });
  const inc = r.data.data.test_run;
  check('LLM-only suite is INCONCLUSIVE in deterministic mode (not FAIL)', inc.result_status === 'inconclusive' && inc.results[0].skipped, { status: inc.result_status, reasons: inc.metrics.reasons });
  r = await api('GET', `/api/playbooks/${llmId}`);
  check('inconclusive run does not mark the version tested', r.data.version.status === 'draft' && !r.data.version.last_test, r.data.version.status);
  r = await api('POST', `/api/playbooks/${llmId}/run`, { input: { ticket: 'x' }, wait: true });
  check('deterministic run with simulated steps completes with a warning', r.data.data.run.status === 'completed' && r.data.data.run.warnings.some((w) => w.code === 'SIMULATED'), r.data.data.run.status);

  // ---------------------------------------------------------------- v2: local AI
  section('Local AI (Ollama)');
  const ollama = await startFakeOllama();
  const installed = ollama.state.models.slice();

  r = await api('GET', '/api/meta');
  const ollamaProvider = r.data.providers.find((p) => p.id === 'ollama');
  check('Ollama is registered as a local provider', Boolean(ollamaProvider) && ollamaProvider.type === 'local' && ollamaProvider.defaults.base_url === 'http://localhost:11434', ollamaProvider);
  check('the setup box has 7 steps, a copyable command and detailed instructions', ollamaProvider.setup.steps.length === 7 && ollamaProvider.setup.command === 'ollama pull llama3.2' && ollamaProvider.setup.detailed.length >= 9, ollamaProvider.setup);
  check('the other local adapters are registered', ['lmstudio', 'llamacpp', 'vllm', 'custom'].every((id) => r.data.providers.some((p) => p.id === id && p.type === 'local')), r.data.providers.map((p) => p.id));

  r = await api('POST', '/api/connections/detect', { provider: 'ollama', base_url: ollama.url });
  check('models are detected before the connection is saved', r.data.count === 3 && r.data.models.some((m) => m.id === 'llama3.2:latest'), r.data);
  const llama = r.data.models.find((m) => m.id === 'llama3.2:latest');
  check('detected models carry context, size and tool support', llama.context_length === 131072 && llama.parameter_size === '3.2B' && llama.supports.tools === true, llama);
  check('local models cost nothing', llama.pricing.prompt === 0 && llama.pricing.completion === 0, llama.pricing);

  r = await api('POST', '/api/connections/detect', { provider: 'ollama', base_url: 'http://127.0.0.1:1' });
  check('an unreachable server is reported as such', r.status >= 400 && r.data.error.code === 'SERVER_UNREACHABLE', r.data);

  r = await api('POST', '/api/connections/test', { provider: 'ollama', base_url: ollama.url, model: 'llama3.2:latest' });
  check('the connection test runs every check', r.data.ok === true && r.data.checks.length === 5 && r.data.checks.every((c) => c.status === 'ok'), r.data.checks);
  check('the test asks the model for PLAYBOOK_READY', /PLAYBOOK_READY/.test(r.data.checks.find((c) => c.id === 'generation').detail), r.data.checks);

  r = await api('POST', '/api/connections/capabilities', { provider: 'ollama', base_url: ollama.url, model: 'nomic-embed-text:latest' });
  check('an embedding model cannot support a playbook', r.data.ready === false && r.data.missing.includes('Text Generation'), r.data.missing);
  r = await api('POST', '/api/connections/capabilities', { provider: 'ollama', base_url: ollama.url, model: 'qwen2.5:7b', tools_required: true });
  check('tool calling is required only when the playbook needs tools', r.data.ready === false && r.data.capabilities.find((c) => c.id === 'tool_calling').status === 'fail', r.data.capabilities);

  r = await api('POST', '/api/connections', { provider: 'ollama', name: 'My Ollama', base_url: ollama.url, default_model: 'llama3.2:latest' });
  const localId = r.data.id;
  check('a local connection needs no API key', r.data.type === 'local' && r.data.authentication.type === 'none' && r.data.api_key_masked === null && r.data.base_url === ollama.url, r.data);
  r = await api('POST', `/api/connections/${localId}/test`, {});
  check('a saved local connection reports connected', r.data.state === 'connected' && r.data.status === 'ok', { state: r.data.state, err: r.data.last_error });
  r = await api('GET', `/api/connections/${localId}/capabilities?model=llama3.2:latest`);
  check('the selected model is ready for playbooks', r.data.ready === true && r.data.context_length === 131072, r.data.capabilities);

  ollama.state.models = [];
  r = await api('POST', `/api/connections/${localId}/test`, {});
  check('a server with no models installed says so', r.data.state === 'error' && r.data.last_error_code === 'NO_MODELS' && /ollama pull/.test(r.data.last_error), r.data.last_error);
  ollama.state.models = installed.slice();
  r = await api('POST', `/api/connections/${localId}/test`, {});
  check('it reconnects once a model is installed', r.data.state === 'connected', r.data.last_error);

  r = await api('POST', `/api/connections/${localId}/builtin-test`, { runs: 3, wait: true });
  const builtin = r.data.data.test_run;
  check('the built-in Customer Risk Evaluator passes on the local model', builtin.results[0].status === 'pass' && builtin.progress.total === 3, { status: builtin.result_status, results: builtin.results.map((x) => x.status) });
  check('repeatability reports agreement and latency', builtin.results[0].agreement === 1 && builtin.metrics.latency && builtin.metrics.latency.runs === 3, builtin.metrics.latency);
  check('the run records the local model and connection', builtin.environment.model === 'llama3.2:latest' && builtin.environment.connection_id === localId, builtin.environment);

  r = await api('PUT', '/api/settings', { ai: { privacy_mode: 'local_only' } });
  check('Privacy Mode saves', r.data.ai.privacy_mode === 'local_only', r.data.ai);
  r = await api('POST', '/api/connections', { provider: 'openrouter', api_key: 'sk-or-v1-0000000000' });
  check('Local Only blocks adding a cloud provider', r.status === 403 && r.data.error.code === 'local_only', r.data);
  r = await api('POST', `/api/connections/${connId}/test`);
  check('Local Only blocks using a cloud connection', r.status === 403 && r.data.error.code === 'local_only', r.data);
  r = await api('GET', '/api/connections');
  check('the local connection becomes the active one', r.data.status.connection.id === localId && r.data.status.local === true, r.data.status);
  check('blocked cloud connections are flagged', r.data.connections.find((c) => c.id === connId).allowed === false, r.data.connections.map((c) => [c.id, c.allowed]));

  r = await api('POST', '/api/discovery/start', { goal: 'Flag inactive sales opportunities every Monday' });
  const lsid = r.data.data.session.id;
  r = await api('POST', `/api/discovery/${lsid}/answer`, { question_id: r.data.data.questions[0].id, option_ids: ['b'] });
  r = await api('POST', `/api/discovery/${lsid}/answer`, { question_id: r.data.data.questions[0].id, option_ids: ['a'] });
  check('discovery completes on the local model', r.data.response_type === 'clarification_complete', r.data.response_type);
  await api('POST', `/api/discovery/${lsid}/confirm`, {});
  r = await api('POST', '/api/playbooks/generate', { session_id: lsid });
  const localPb = r.data.data.playbook;
  const localPbId = r.data.data.id;
  check('the local model compiles a full playbook', r.data.response_type === 'playbook' && localPb.steps.length >= 6 && r.data.meta.model === 'llama3.2:latest', { model: r.data.meta && r.data.meta.model, steps: localPb && localPb.steps.length });
  check('the playbook references the connection by id, never a credential', localPb.ai.connection_id === localId && !JSON.stringify(localPb).includes('api_key'), localPb.ai);
  r = await api('GET', `/api/playbooks/${localPbId}/markdown`);
  check('Markdown export works for a locally generated playbook', typeof r.data === 'string' && r.data.includes('## Detailed Step Specifications') && r.data.includes('Powered By SiliBlue.in'), r.status);
  r = await api('GET', `/api/playbooks/${localPbId}/pdf`);
  check('PDF export works for a locally generated playbook', r.type.includes('pdf') && r.data.slice(0, 5).toString() === '%PDF-', r.type);
  r = await api('POST', `/api/playbooks/${localPbId}/test`, { mode: 'ai', wait: true, runs: 2 });
  const localRun = r.data.data.test_run;
  check('AI-mode tests run against the local model', localRun.status === 'completed' && localRun.environment.model === 'llama3.2:latest' && localRun.metrics.metrics.accuracy === 1, { status: localRun.result_status, model: localRun.environment.model, acc: localRun.metrics && localRun.metrics.metrics.accuracy });

  r = await api('POST', '/api/connections/detect', { provider: 'lmstudio', base_url: ollama.url });
  check('OpenAI-compatible adapters read /v1/models', r.data.count === 3 && r.data.models.every((m) => m.local), r.data);
  check('the fake Ollama server saw only local HTTP traffic', ollama.state.chatCalls > 5 && ollama.state.calls.some((c) => c.includes('/api/tags')), { chats: ollama.state.chatCalls });

  await api('PUT', '/api/settings', { ai: { privacy_mode: 'cloud_allowed' } });
  await api('PUT', `/api/connections/${connId}`, { is_default: true });
  await ollama.close();

  // ---------------------------------------------------------------- v1.2.1: universal launcher
  section('Universal launcher (v1.2.1)');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const freePort = () => new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
  const tmpData = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pbai-launch-'));
    scratchDirs.push(d);
    return d;
  };
  const stackTrace = /\n\s+at .+:\d+:\d+/;
  // Run a Node script from the project the way npm does; resolve when `until`
  // matches the output (process keeps running) or when the process exits.
  function runNode(argv, { env = {}, until = null, timeoutMs = 60000 } = {}) {
    return new Promise((resolve) => {
      // Every child gets its own throwaway data folder unless a test sets one: the
      // self-test must never write into the real data folder (logs included).
      const child = spawn(process.execPath, argv, { cwd: ROOT, env: { ...process.env, BROWSER: 'none', PBAI_NO_OPEN: '1', CI: '1', PBAI_DATA_DIR: tmpData(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      const state = { child, output: '', code: null, exited: false };
      let settled = false;
      const settle = () => {
        if (!settled) {
          settled = true;
          resolve(state);
        }
      };
      const onData = (d) => {
        state.output += d.toString();
        if (until && until.test(state.output)) settle();
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', (code) => {
        state.code = code;
        state.exited = true;
        settle();
      });
      setTimeout(settle, timeoutMs).unref();
    });
  }
  const waitExit = (state, ms = 8000) => new Promise((resolve) => {
    if (state.exited) return resolve(state.code);
    const t = setTimeout(() => resolve('timeout'), ms);
    state.child.on('exit', (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });

  const scriptText = Object.values(pkg.scripts).join(' | ');
  check('npm scripts dev, launch, start, build and setup exist', ['dev', 'launch', 'start', 'build', 'setup'].every((k) => typeof pkg.scripts[k] === 'string'), pkg.scripts);
  check('npm scripts use no shell or platform-specific syntax', !/(&&|\|\||;|\\|\.bat\b|\.sh\b|\.cmd\b|\bset |\bexport |\$\w|%\w+%|[A-Za-z]:\/|\/Users\/|\/home\/)/.test(scriptText), scriptText);
  const rootLaunchers = fs.readdirSync(ROOT).filter((f) => /\.(bat|cmd|sh|command|ps1)$/i.test(f));
  check('no .bat, .sh or .command launcher is needed', rootLaunchers.length === 0, rootLaunchers);
  const launcherSources = ['launcher/lib.js', 'launcher/launch.js', 'launcher/check.js', 'launcher/setup.js', 'server.js'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));
  check('launcher code contains no hard-coded platform paths', launcherSources.every((t) => !/[A-Za-z]:\\\\|\/Users\/|\/home\//.test(t)));
  check('the server is started with the running Node binary, not npm.cmd or a shell', /spawn\(process\.execPath/.test(launcherSources[1]) && !/npm\.cmd|shell:\s*true/.test(launcherSources[1]));
  const win = Launch.browserCommands('http://localhost:4317/?a=1&b=2', 'win32', {});
  check('Windows opens the browser through cmd start with verbatim arguments', win[0].command === 'cmd' && win[0].args.includes('start') && win[0].args.includes('""') && win[0].options.windowsVerbatimArguments === true && win[0].args.at(-1).includes('^&'), win);
  check('macOS opens the browser with open', Launch.browserCommands('http://localhost:4317', 'darwin', {})[0].command === 'open');
  const lin = Launch.browserCommands('http://localhost:4317', 'linux', {}).map((c) => c.command);
  check('Linux tries xdg-open, then gio and sensible-browser', lin[0] === 'xdg-open' && lin.includes('gio'), lin);
  check('WSL prefers wslview', Launch.browserCommands('http://x', 'linux', { WSL_DISTRO_NAME: 'Ubuntu' })[0].command === 'wslview');
  check('every platform is detected by name', Launch.platformName('win32') === 'Windows' && Launch.platformName('darwin') === 'macOS' && Launch.platformName('linux') === 'Linux');
  check('the port comes from --port or PORT', Launch.resolveConfig({ args: { port: '5001' }, env: {} }).url === 'http://localhost:5001' && Launch.resolveConfig({ args: {}, env: { PORT: '5002' } }).port === 5002 && Launch.resolveConfig({ args: {}, env: {} }).port === 4317);

  r = await api('GET', '/api/meta');
  const versionLiteral = new RegExp(pkg.version.replace(/\./g, '\\.'));
  const hardcoded = [];
  for (const dir of ['public', 'server', 'launcher', 'shared']) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(js|html|css)$/.test(e.name) && versionLiteral.test(fs.readFileSync(full, 'utf8'))) hardcoded.push(path.relative(ROOT, full));
      }
    };
    walk(path.join(ROOT, dir));
  }
  check('the version comes only from package.json', r.data.version === pkg.version && Launch.APP_VERSION === pkg.version && hardcoded.length === 0, { meta: r.data.version, hardcoded });

  const p1 = await freePort();
  const data1 = tmpData();
  const launched = await runNode(['launcher/launch.js', '--no-open', '--port', String(p1)], { env: { PBAI_DATA_DIR: data1 }, until: /Ready at/ });
  const health1 = await Launch.probeHealth(p1, '127.0.0.1');
  check('npm run launch starts the server and waits until it is ready', /Ready at http:\/\/localhost:\d+/.test(launched.output) && health1 && health1.version === pkg.version, launched.output.slice(-600));
  check('the launcher names the detected platform', new RegExp(`${Launch.platformName()} ${os.arch()}`).test(launched.output), launched.output.slice(0, 300));
  const again = await runNode(['launcher/launch.js', '--no-open', '--port', String(p1)], { env: { PBAI_DATA_DIR: data1 } });
  check('a second launch finds the running copy instead of starting another', again.code === 0 && /already running/.test(again.output), again.output);
  launched.child.kill('SIGINT');
  const stopCode = await waitExit(launched);
  check('Ctrl+C stops the launcher and the server cleanly', stopCode === 0 && !(await Launch.probeHealth(p1, '127.0.0.1')), stopCode);

  const p2 = await freePort();
  const squatter = net.createServer((sock) => sock.end('not http\n'));
  await new Promise((res) => squatter.listen(p2, '127.0.0.1', res));
  const busy = await runNode(['launcher/launch.js', '--no-open', '--port', String(p2)], { env: { PBAI_DATA_DIR: tmpData() } });
  check('a busy port gives a readable explanation and a fix', busy.code === 1 && /could not start/.test(busy.output) && new RegExp(`Port ${p2} is already in use`).test(busy.output) && /--port \d+/.test(busy.output), busy.output);
  check('startup errors show no stack trace', !stackTrace.test(busy.output), busy.output);
  const busyServer = await runNode(['server.js', '--port', String(p2)], { env: { PBAI_DATA_DIR: tmpData() } });
  check('npm start on a busy port also explains it without a stack trace', busyServer.code === 1 && /already in use/.test(busyServer.output) && !stackTrace.test(busyServer.output), busyServer.output);
  squatter.close();

  const notAFolder = path.join(tmpData(), 'data-is-a-file');
  fs.writeFileSync(notAFolder, 'x');
  const badData = await runNode(['launcher/launch.js', '--no-open', '--port', String(await freePort())], { env: { PBAI_DATA_DIR: notAFolder } });
  const logMatch = badData.output.match(/Details for support: (.+)/);
  check('an unusable data folder is explained in plain words', badData.code === 1 && /cannot use its data folder/.test(badData.output) && !stackTrace.test(badData.output), badData.output);
  check('technical details are saved to a log file for support', Boolean(logMatch) && fs.existsSync(logMatch[1].trim()) && /Error:/.test(fs.readFileSync(logMatch[1].trim(), 'utf8')), logMatch && logMatch[1]);

  const badPort = await runNode(['launcher/launch.js', '--no-open', '--port', 'abc']);
  check('an invalid port setting is explained', badPort.code === 1 && /port setting is invalid/.test(badPort.output), badPort.output);

  const p3 = await freePort();
  const plainServer = await runNode(['server.js', '--port', String(p3)], { env: { PBAI_DATA_DIR: tmpData() }, until: /Running at/ });
  const health3 = await Launch.probeHealth(p3, '127.0.0.1');
  plainServer.child.kill('SIGINT');
  const code3 = await waitExit(plainServer);
  check('npm start runs the server without the launcher', Boolean(health3) && code3 === 0, { out: plainServer.output.slice(-300), code3 });

  const p4 = await freePort();
  const devRun = await runNode(['launcher/launch.js', '--dev', '--no-open', '--port', String(p4)], { env: { PBAI_DATA_DIR: tmpData() }, until: /Ready at/ });
  const health4 = await Launch.probeHealth(p4, '127.0.0.1');
  devRun.child.kill('SIGINT');
  const code4 = await waitExit(devRun);
  check('npm run dev starts with automatic restarts', /development/.test(devRun.output) && Boolean(health4) && code4 === 0, { out: devRun.output.slice(-400), code4 });

  const built = await runNode(['launcher/check.js']);
  check('npm run build verifies the installation', built.code === 0 && /Nothing to compile/.test(built.output), built.output.slice(-400));
  const setupRun = await runNode(['launcher/setup.js', '--port', String(await freePort())], { env: { PBAI_DATA_DIR: tmpData() } });
  check('npm run setup checks the computer and reports ready', setupRun.code === 0 && /Ready\./.test(setupRun.output), setupRun.output.slice(-500));

  // ---------------------------------------------------------------- v1.2.2: playbook workspaces
  section('Playbook workspaces (v1.2.2)');
  await app.workspaces.idleAll();
  const WS = app.workspaces.baseDir;
  const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64');
  const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const flatTree = (nodes, out = []) => {
    for (const n of nodes) {
      out.push(n);
      if (n.children) flatTree(n.children, out);
    }
    return out;
  };
  async function apiRaw(url) {
    const res = await fetch(base + url);
    return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
  }
  const q = (p) => encodeURIComponent(p);

  check('folder names are safe on Windows, macOS and Linux',
    sanitizeName('Customer Risk: Q4 / Enterprise') === 'Customer Risk Q4 Enterprise' && sanitizeName('CON') === 'CON Playbook' && sanitizeName(' Report. ') === 'Report' && sanitizeName('?*<>') === 'Untitled Playbook' && Array.from(sanitizeName('x'.repeat(200))).length === 60,
    [sanitizeName('Customer Risk: Q4 / Enterprise'), sanitizeName('CON'), sanitizeName(' Report. '), sanitizeName('?*<>')]);
  const live = app.store.playbooks.list((p) => !p.deleted);
  const liveFolders = live.map((p) => p.workspace && p.workspace.folder);
  check('every playbook gets its own folder automatically', live.length > 5 && liveFolders.every((f) => f && fs.existsSync(path.join(WS, f))) && new Set(liveFolders.map((f) => f.toLowerCase())).size === live.length, liveFolders);
  const twin = live.find((p) => p.name === 'Customer Risk Evaluator' && p.id !== good.id);
  check('two playbooks with the same name get separate folders', Boolean(twin) && twin.workspace.folder === 'Customer Risk Evaluator (2)', twin && twin.workspace);

  r = await api('GET', `/api/playbooks/${good.id}/workspace`);
  const goodWs = r.data;
  const goodDir = path.join(WS, goodWs.folder);
  const goodPaths = new Set(flatTree(goodWs.tree).map((n) => n.path));
  check('the folder is named after the playbook', goodWs.folder === 'Customer Risk Evaluator' && goodWs.root === goodDir && goodWs.playbook_id === good.id, goodWs.folder);
  const missingDirs = STANDARD_DIRS.filter((d) => !goodPaths.has(d));
  check('it has the standard structure', !missingDirs.length && goodWs.standard_dirs.length === STANDARD_DIRS.length, missingDirs);
  const expectedFiles = ['README.md', 'playbook/playbook.json', 'playbook/playbook.md', 'playbook/playbook.pdf', 'requirements/intent.json', 'requirements/requirements.md', 'requirements/assumptions.json', 'process/workflow.json', 'process/dependencies.json', 'process/tools.json', 'process/configuration.json', 'process/execution-plan.json', 'tests/test-suite.json', 'metadata/version.json', 'metadata/settings.json', 'metadata/activity.json', 'inputs/sample/example-input.json', 'versions/v1/playbook.json', 'exports/markdown/Customer Risk Evaluator.md', 'exports/pdf/Customer Risk Evaluator.pdf', 'exports/json/Customer Risk Evaluator.json'];
  const missingFiles = expectedFiles.filter((f) => !goodPaths.has(f));
  check('playbook, requirements, process, metadata and export files are written', !missingFiles.length, missingFiles);
  r = await api('GET', `/api/playbooks/${good.id}/json`);
  check('playbook/playbook.json is the canonical playbook JSON', JSON.stringify(readJson(path.join(goodDir, 'playbook', 'playbook.json'))) === JSON.stringify(r.data));
  r = await api('GET', `/api/playbooks/${good.id}/markdown`);
  const noStamp = (t) => String(t).replace(/_Generated by Playbook Builder[^\n]*/g, '');
  check('playbook.md matches the Markdown export and playbook.pdf is a PDF', noStamp(fs.readFileSync(path.join(goodDir, 'playbook', 'playbook.md'), 'utf8')) === noStamp(r.data) && fs.readFileSync(path.join(goodDir, 'playbook', 'playbook.pdf')).subarray(0, 5).toString() === '%PDF-');
  const intentFile = readJson(path.join(goodDir, 'requirements', 'intent.json'));
  check('requirements/intent.json holds the confirmed intent', intentFile.playbook_id === good.id && /at_risk/.test(intentFile.objective) && intentFile.criteria.length === 3 && Boolean(intentFile.details), intentFile);
  const suiteFile = readJson(path.join(goodDir, 'tests', 'test-suite.json'));
  const caseFiles = fs.readdirSync(path.join(goodDir, 'tests', 'test-cases'));
  r = await api('GET', `/api/playbooks/${good.id}/tests`);
  check('tests/ holds the suite and one file per test case', suiteFile.count === r.data.tests.length && caseFiles.length === r.data.tests.length && caseFiles.includes('boundary-14.json'), caseFiles);

  r = await api('GET', `/api/playbooks/${good.id}/test-runs`);
  const goodTestRuns = r.data.test_runs.slice().sort((a, b) => a.started_at.localeCompare(b.started_at));
  const lastTestRun = (await api('GET', `/api/test-runs/${goodTestRuns.at(-1).id}`)).data.data.test_run;
  const latestReport = readJson(path.join(goodDir, 'tests', 'reports', 'latest.json'));
  const reportHistory = fs.readdirSync(path.join(goodDir, 'tests', 'reports', 'history'));
  const testSummaries = readJson(path.join(goodDir, 'results', 'summaries', 'tests.json'));
  check('every test run is kept as a report; the newest is latest.json and latest.md', latestReport.test_run_id === lastTestRun.id && fs.existsSync(path.join(goodDir, 'tests', 'reports', 'latest.md')) && reportHistory.length === goodTestRuns.length && testSummaries.count === goodTestRuns.length, { latest: latestReport.test_run_id, expected: lastTestRun.id, history: reportHistory.length, runs: goodTestRuns.length });
  const repeated = lastTestRun.results.filter((x) => (x.runs || []).length > 1);
  const repFiles = fs.readdirSync(path.join(goodDir, 'tests', 'repeatability')).filter((n) => /^run-\d+\.json$/.test(n)).sort();
  check('tests/repeatability has one file per repeated run', repeated.length === 1 && repFiles.length === repeated[0].runs.length && readJson(path.join(goodDir, 'tests', 'repeatability', repFiles[0])).of === repeated[0].runs.length, repFiles);

  const runsBefore = fs.readdirSync(path.join(goodDir, 'executions')).filter((n) => /^run-\d{3}$/.test(n)).length;
  r = await api('POST', `/api/playbooks/${good.id}/run`, { input: { customer: { name: 'Initech', days_since_activity: 30 } }, wait: true });
  const wsRunId = r.data.data.run.id;
  await app.workspaces.idle(good.id);
  const wsRun = (await api('GET', `/api/runs/${wsRunId}`)).data.data.run;
  const runLabel = `run-${String(runsBefore + 1).padStart(3, '0')}`;
  const runDir = path.join(goodDir, 'executions', runLabel);
  check('each run gets the next executions/run-NNN folder', wsRun.workspace_run === runsBefore + 1 && wsRun.workspace_path === `executions/${runLabel}` && ['input.json', 'execution.json', 'step-results.json', 'output.json', 'report.md'].every((f) => fs.existsSync(path.join(runDir, f))), { before: runsBefore, path: wsRun.workspace_path });
  const execFile = readJson(path.join(runDir, 'execution.json'));
  const runVersion = app.store.playbooks.get(good.id).versions.find((v) => v.version === wsRun.version);
  check('execution.json names the exact playbook version it used', execFile.run_id === wsRun.id && execFile.version === wsRun.version && execFile.version_hash === runVersion.hash && fs.existsSync(path.join(goodDir, ...execFile.version_snapshot.split('/'))), execFile);
  check('input.json and output.json hold the data of that run', JSON.stringify(readJson(path.join(runDir, 'input.json'))) === JSON.stringify(wsRun.input) && readJson(path.join(runDir, 'output.json')).decision === 'at_risk' && /Initech/.test(fs.readFileSync(path.join(runDir, 'report.md'), 'utf8')));
  const latestResult = readJson(path.join(goodDir, 'results', 'latest', 'result.json'));
  const runsSummary = readJson(path.join(goodDir, 'results', 'summaries', 'runs.json'));
  check('results/ keeps the latest result, the history and a summary of all runs', latestResult.run_id === wsRun.id && fs.readdirSync(path.join(goodDir, 'results', 'history')).some((n) => n.endsWith(`-${runLabel}`)) && runsSummary.count === runsBefore + 1, { latest: latestResult.run_id, count: runsSummary.count });

  // Inputs: the user chooses sample, test or runtime; nothing else accepts uploads.
  const brokenWs = (await api('GET', `/api/playbooks/${broken.id}/workspace`)).data;
  const brokenDir = path.join(WS, brokenWs.folder);
  r = await api('POST', `/api/playbooks/${broken.id}/workspace/upload`, { folder: 'inputs/runtime', name: 'customers q4.json', content_base64: b64({ customer: { name: 'Globex', days_since_activity: 21 } }) });
  const runtimeFile = r.data.path;
  check('files are added to the input folder the user chooses', r.status === 200 && runtimeFile === 'inputs/runtime/customers q4.json' && r.data.category === 'runtime' && fs.existsSync(path.join(brokenDir, 'inputs', 'runtime', 'customers q4.json')), r.data);
  r = await api('POST', `/api/playbooks/${broken.id}/workspace/upload`, { folder: 'inputs/test', name: 'edge.json', content_base64: b64({ customer: { name: 'Edge', days_since_activity: 14 } }) });
  const testFile = r.data.path;
  r = await api('POST', `/api/playbooks/${broken.id}/workspace/upload`, { folder: 'inputs/runtime', name: 'customers q4.json', content_base64: b64({}) });
  check('a file with the same name is kept alongside as "(2)"', r.data.path === 'inputs/runtime/customers q4 (2).json', r.data);
  const uploadRejects = [];
  for (const folder of ['playbook', 'inputs', 'executions', 'results/latest', '../x', undefined]) {
    const x = await api('POST', `/api/playbooks/${broken.id}/workspace/upload`, { folder, name: 'x.json', content_base64: b64({}) });
    uploadRejects.push([folder, x.status, x.data.error && x.data.error.code]);
  }
  check('uploads only go into inputs/sample, inputs/test or inputs/runtime', uploadRejects.every(([, s]) => s >= 400), uploadRejects);
  r = await api('POST', `/api/playbooks/${broken.id}/workspace/upload`, { folder: 'inputs/sample', name: '../../../escape.json', content_base64: b64({}) });
  check('an uploaded file name cannot leave its folder', r.data.path === 'inputs/sample/escape.json' && !fs.existsSync(path.join(WS, 'escape.json')) && !fs.existsSync(path.join(path.dirname(WS), 'escape.json')), r.data);

  // Runs read workspace inputs; production only ever sees inputs/runtime.
  r = await api('POST', `/api/playbooks/${broken.id}/run`, { input_file: runtimeFile, environment: 'production', wait: true });
  const fileRun = r.data.data && r.data.data.run;
  check('a production run reads its input from inputs/runtime', r.status === 200 && fileRun.environment === 'production' && fileRun.input_source === runtimeFile && fileRun.output.decision === 'at_risk', fileRun);
  r = await api('POST', `/api/playbooks/${broken.id}/run`, { input_file: testFile, environment: 'production', wait: true });
  const prodTest = r;
  r = await api('POST', `/api/playbooks/${broken.id}/run`, { input_file: 'inputs/sample/example-input.json', environment: 'production', wait: true });
  check('test and sample data can never feed a production run', prodTest.status === 409 && prodTest.data.error.code === 'test_data_in_production' && r.status === 409 && r.data.error.code === 'test_data_in_production', [prodTest.data, r.data]);
  r = await api('POST', `/api/playbooks/${broken.id}/run`, { input_file: testFile, version: 4, environment: 'sandbox', wait: true });
  check('sandbox runs may use test data', r.status === 200 && r.data.data.run.environment === 'sandbox' && r.data.data.run.input_source === testFile, r.data.data && r.data.data.run.input_source);
  r = await api('POST', `/api/playbooks/${broken.id}/run`, { input_file: 'playbook/playbook.json', wait: true });
  const notInput = r;
  r = await api('POST', `/api/playbooks/${broken.id}/run`, { input: { customer: { name: 'X', days_since_activity: 1 } }, input_source: 'inputs/runtime/made-up.json', version: 4, environment: 'sandbox', wait: true });
  check('run inputs must come from inputs/, and the source cannot be faked', notInput.status === 400 && notInput.data.error.code === 'not_an_input' && r.data.data.run.input_source === null, [notInput.data, r.data.data && r.data.data.run.input_source]);

  // Path boundaries: a request for one playbook never reaches another folder.
  const served = [];
  for (const p of [`../${goodWs.folder}/playbook/playbook.json`, 'playbook/../../x', 'inputs\\..\\..\\x', 'C:/Windows/win.ini', '/etc/passwd', 'inputs/runtime/%2e%2e/%2e%2e/x', 'CON', '../../../../../../etc/hosts']) {
    const x = await api('GET', `/api/playbooks/${broken.id}/workspace/file?path=${q(p)}`);
    if (x.status < 400) served.push([p, x.status]);
  }
  check('the file API cannot reach another playbook or the rest of the computer', served.length === 0, served);
  const crossTarget = `../${goodWs.folder}/README.md`;
  const crossOps = [
    (await api('POST', `/api/playbooks/${broken.id}/workspace/delete`, { path: crossTarget, confirm: true })).status,
    (await api('POST', `/api/playbooks/${broken.id}/workspace/rename`, { path: crossTarget, name: 'x.md' })).status,
    (await api('POST', `/api/playbooks/${broken.id}/workspace/duplicate`, { path: crossTarget })).status,
    (await api('POST', `/api/playbooks/${broken.id}/run`, { input_file: `../${goodWs.folder}/inputs/sample/example-input.json`, version: 4, environment: 'sandbox' })).status,
  ];
  check('file actions and run inputs stay inside their own playbook', crossOps.every((s) => s === 403) && fs.existsSync(path.join(goodDir, 'README.md')), crossOps);
  const linkPath = path.join(brokenDir, 'inputs', 'sample', 'shortcut');
  let linked = false;
  try {
    fs.symlinkSync(goodDir, linkPath, 'junction');
    linked = true;
  } catch { /* links are not allowed on this computer: nothing to test */ }
  if (linked) {
    const viaLink = await api('GET', `/api/playbooks/${broken.id}/workspace/file?path=${q('inputs/sample/shortcut/README.md')}`);
    const delLink = await api('POST', `/api/playbooks/${broken.id}/workspace/delete`, { path: 'inputs/sample/shortcut/README.md' });
    const linkTree = (await api('GET', `/api/playbooks/${broken.id}/workspace`)).data;
    check('links inside a workspace cannot be followed out of it', viaLink.status === 403 && delLink.status === 403 && !flatTree(linkTree.tree).some((n) => n.path.startsWith('inputs/sample/shortcut')) && fs.existsSync(path.join(goodDir, 'README.md')), [viaLink.status, delLink.status]);
    try {
      fs.unlinkSync(linkPath);
    } catch {
      fs.rmdirSync(linkPath);
    }
  }

  // File actions: confirmation for playbook files, protection for the structure.
  r = await api('POST', `/api/playbooks/${good.id}/workspace/delete`, { path: 'playbook/playbook.json' });
  check('deleting a critical playbook file needs confirmation', r.status === 409 && r.data.error.code === 'confirm_required', r.data);
  r = await api('POST', `/api/playbooks/${good.id}/workspace/delete`, { path: 'playbook/playbook.json', confirm: true });
  const deletedCritical = !fs.existsSync(path.join(goodDir, 'playbook', 'playbook.json'));
  await api('POST', `/api/playbooks/${good.id}/workspace/sync`);
  check('a deleted playbook file is recreated from the playbook', r.status === 200 && r.data.recreated_on_change === true && deletedCritical && fs.existsSync(path.join(goodDir, 'playbook', 'playbook.json')), r.data);
  const twinDir = path.join(WS, twin.workspace.folder);
  const blockedPdf = path.join(twinDir, 'playbook', 'playbook.pdf');
  fs.rmSync(blockedPdf, { force: true });
  fs.mkdirSync(blockedPdf); // stands in for a file another program keeps open
  fs.rmSync(path.join(twinDir, 'requirements', 'intent.json'));
  const logMark = app.workspaceLog.length;
  r = await api('POST', `/api/playbooks/${twin.id}/workspace/sync`);
  const lockLog = app.workspaceLog.slice(logMark);
  check('a file that cannot be written does not stop the others from updating', r.status === 200 && fs.existsSync(path.join(twinDir, 'requirements', 'intent.json')) && lockLog.length === 1 && /could not update playbook\/playbook\.pdf/.test(lockLog[0]), lockLog);
  app.workspaceLog.splice(logMark);
  fs.rmdirSync(blockedPdf);
  await api('POST', `/api/playbooks/${twin.id}/workspace/sync`);
  r = await api('POST', `/api/playbooks/${good.id}/workspace/delete`, { path: `executions/${runLabel}/report.md` });
  check('deleting run history needs confirmation too', r.status === 409 && r.data.error.code === 'confirm_required', r.data);
  const protectedOps = [
    await api('POST', `/api/playbooks/${good.id}/workspace/delete`, { path: 'inputs', confirm: true }),
    await api('POST', `/api/playbooks/${good.id}/workspace/delete`, { path: 'executions', confirm: true }),
    await api('POST', `/api/playbooks/${good.id}/workspace/delete`, { path: '', confirm: true }),
    await api('POST', `/api/playbooks/${good.id}/workspace/rename`, { path: 'tests', name: 'x' }),
    await api('POST', `/api/playbooks/${good.id}/workspace/rename`, { path: 'playbook/playbook.md', name: 'x.md' }),
  ].map((x) => [x.status, x.data.error && x.data.error.code]);
  check('standard folders and generated files cannot be deleted or renamed', protectedOps.every(([s, c]) => s === 409 && c === 'protected'), protectedOps);
  r = await api('POST', `/api/playbooks/${broken.id}/workspace/duplicate`, { path: runtimeFile });
  const dupPath = r.data.path;
  r = await api('POST', `/api/playbooks/${broken.id}/workspace/rename`, { path: dupPath, name: 'globex.json' });
  const renamedPath = r.data.path;
  const clash = await api('POST', `/api/playbooks/${broken.id}/workspace/rename`, { path: renamedPath, name: 'customers q4.json' });
  const delUser = await api('POST', `/api/playbooks/${broken.id}/workspace/delete`, { path: renamedPath });
  check('input files can be duplicated, renamed and deleted', dupPath === 'inputs/runtime/customers q4 (copy).json' && renamedPath === 'inputs/runtime/globex.json' && clash.status === 409 && clash.data.error.code === 'exists' && delUser.status === 200 && !fs.existsSync(path.join(brokenDir, 'inputs', 'runtime', 'globex.json')), { dupPath, renamedPath, clash: clash.status, del: delUser.status });

  let raw = await apiRaw(`/api/playbooks/${good.id}/workspace/file?path=${q('playbook/playbook.md')}`);
  check('files preview inline, sandboxed', raw.status === 200 && /text\/markdown/.test(raw.headers.get('content-type')) && /^inline/.test(raw.headers.get('content-disposition')) && /sandbox/.test(raw.headers.get('content-security-policy') || '') && raw.headers.get('x-content-type-options') === 'nosniff', raw.headers.get('content-type'));
  await api('POST', `/api/playbooks/${broken.id}/workspace/upload`, { folder: 'inputs/sample', name: 'page.html', content_base64: b64('<script>alert(1)</script>') });
  raw = await apiRaw(`/api/playbooks/${broken.id}/workspace/file?path=${q('inputs/sample/page.html')}`);
  check('an uploaded web page is only ever downloaded, never run in the app', raw.status === 200 && raw.headers.get('content-type') === 'application/octet-stream' && /^attachment/.test(raw.headers.get('content-disposition')), [raw.headers.get('content-type'), raw.headers.get('content-disposition')]);
  raw = await apiRaw(`/api/playbooks/${good.id}/workspace/file?path=${q('exports/pdf/Customer Risk Evaluator.pdf')}&download=1`);
  check('downloads keep their file name', raw.status === 200 && /^attachment/.test(raw.headers.get('content-disposition')) && raw.headers.get('content-disposition').includes("filename*=UTF-8''Customer%20Risk%20Evaluator.pdf") && raw.buf.subarray(0, 5).toString() === '%PDF-', raw.headers.get('content-disposition'));

  const winOpen = Launch.folderCommands('C:\\Users\\A B\\Sales, Q4', 'win32', {})[0];
  check('Open folder uses Explorer, Finder or the Linux file manager', winOpen.command === 'explorer.exe' && winOpen.args[0] === '"C:\\Users\\A B\\Sales, Q4"' && winOpen.options.windowsVerbatimArguments === true && winOpen.options.windowsHide === false && Launch.folderCommands('/x', 'darwin', {})[0].command === 'open' && Launch.folderCommands('/x', 'linux', {})[0].command === 'xdg-open', winOpen);

  // Renaming the playbook renames its folder; the ID and every file stay.
  const echoBefore = app.store.playbooks.get(schedId).workspace.folder;
  await api('POST', `/api/playbooks/${schedId}/workspace/upload`, { folder: 'inputs/runtime', name: 'keep-me.json', content_base64: b64({ x: 'kept' }) });
  await api('PATCH', `/api/playbooks/${schedId}`, { name: 'Nightly Echo: EU / APAC' });
  await app.workspaces.idle(schedId);
  const echoAfter = app.store.playbooks.get(schedId).workspace.folder;
  const echoVersionFile = readJson(path.join(WS, echoAfter, 'metadata', 'version.json'));
  check('renaming a playbook renames its folder and keeps everything in it', echoBefore === 'Scheduled Echo' && echoAfter === 'Nightly Echo EU APAC' && !fs.existsSync(path.join(WS, echoBefore)) && fs.existsSync(path.join(WS, echoAfter, 'inputs', 'runtime', 'keep-me.json')) && fs.readdirSync(path.join(WS, echoAfter, 'executions')).length > 0, { echoBefore, echoAfter });
  check('the playbook ID stays the same and the rename is logged', echoVersionFile.playbook_id === schedId && echoVersionFile.folder === echoAfter && readJson(path.join(WS, echoAfter, 'metadata', 'activity.json')).some((a) => a.event === 'renamed'), echoVersionFile.folder);

  // Workspace storage is always local; the privacy mode only governs AI requests.
  const wsCloud = (await api('GET', `/api/playbooks/${good.id}/workspace`)).data;
  await api('PUT', '/api/settings', { ai: { privacy_mode: 'local_only' } });
  const wsLocal = (await api('GET', `/api/playbooks/${good.id}/workspace`)).data;
  await app.workspaces.idleAll();
  const settingsFile = readJson(path.join(goodDir, 'metadata', 'settings.json'));
  await api('PUT', '/api/settings', { ai: { privacy_mode: 'cloud_allowed' } });
  check('the workspace stays on this computer whatever the AI transport', wsCloud.local_workspace === true && wsCloud.privacy_mode === 'cloud_allowed' && wsCloud.ai.transport === 'cloud' && wsLocal.local_workspace === true && wsLocal.privacy_mode === 'local_only' && wsLocal.ai.transport === 'local', { cloud: [wsCloud.privacy_mode, wsCloud.ai], local: [wsLocal.privacy_mode, wsLocal.ai] });
  check('metadata/settings.json follows settings changes', settingsFile.ai.privacy_mode === 'local_only' && settingsFile.storage.workspace === 'local', settingsFile.ai);
  const secretValues = ['test-key-123456', ...app.store.playbooks.list().map((p) => p.webhook_token).filter(Boolean)];
  const leaks = [];
  const scanForSecrets = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) scanForSecrets(f);
      else if (e.isFile()) {
        const text = fs.readFileSync(f, 'latin1');
        if (secretValues.some((s) => text.includes(s))) leaks.push(path.relative(WS, f));
      }
    }
  };
  scanForSecrets(WS);
  check('no API key or webhook token is written to any workspace', leaks.length === 0 && secretValues.length > 3, leaks.slice(0, 5));

  // Package: the whole folder as a .zip; import it back without running anything.
  await app.workspaces.idleAll();
  raw = await apiRaw(`/api/playbooks/${good.id}/package`);
  const pkgBuf = raw.buf;
  const entries = readZip(pkgBuf);
  const top = `${goodWs.folder}/`;
  const entryNames = new Set(entries.map((e) => e.name));
  check('Download Playbook Package gives a .zip of the whole folder', raw.status === 200 && raw.headers.get('content-type') === 'application/zip' && raw.headers.get('content-disposition').includes('Customer%20Risk%20Evaluator.zip') && entries.every((e) => e.name.startsWith(top)), raw.headers.get('content-disposition'));
  check('the package keeps every folder, even empty ones', STANDARD_DIRS.every((d) => entryNames.has(`${top}${d}/`)) && entryNames.has(`${top}playbook/playbook.json`) && entryNames.has(`${top}executions/${runLabel}/execution.json`), STANDARD_DIRS.filter((d) => !entryNames.has(`${top}${d}/`)));
  const differs = entries.filter((e) => !e.dir && !e.name.endsWith('metadata/activity.json')).filter((e) => {
    try {
      return !fs.readFileSync(path.join(WS, ...e.name.split('/'))).equals(e.data);
    } catch {
      return true;
    }
  });
  check('package files match the workspace byte for byte', differs.length === 0, differs.map((e) => e.name).slice(0, 5));

  r = await api('POST', '/api/playbooks/import', { filename: 'Customer Risk Evaluator.zip', content_base64: pkgBuf.toString('base64') });
  const imp = r.data;
  const impDir = path.join(WS, imp.folder || 'missing');
  const impRuns = (await api('GET', `/api/playbooks/${imp.playbook_id}/runs`)).data.runs;
  const impTests = (await api('GET', `/api/playbooks/${imp.playbook_id}/test-runs`)).data.test_runs;
  check('a package imports as a new playbook with its intent, tests and inputs', r.status === 200 && imp.playbook_id !== good.id && /^Customer Risk Evaluator \(\d\)$/.test(imp.folder) && imp.imported.includes('confirmed intent') && imp.imported.some((x) => /^\d+ test cases$/.test(x)) && fs.existsSync(path.join(impDir, 'inputs', 'sample', 'example-input.json')) && readJson(path.join(impDir, 'requirements', 'intent.json')).criteria.length === 3, imp);
  check('importing never runs anything', imp.executed === false && impRuns.length === 0 && impTests.length === 0 && fs.readdirSync(path.join(impDir, 'executions')).length === 0 && imp.playbook.version.status === 'draft', { runs: impRuns.length, tests: impTests.length, status: imp.playbook && imp.playbook.version.status });
  check('run history stays with the original workspace', imp.skipped.some((s) => s.startsWith('executions/')), imp.skipped);
  const localJson = (await api('GET', `/api/playbooks/${localPbId}/json`)).data;
  r = await api('POST', '/api/playbooks/import', { filename: 'Local.playbook.json', content_base64: b64(localJson) });
  check('a .playbook.json imports; its AI connection is reset, never trusted', r.status === 200 && localJson.ai.connection_id === localId && r.data.playbook.playbook.ai.connection_id === null && r.data.warnings.some((w) => /AI connection was reset/.test(w)) && r.data.executed === false, r.data.warnings);
  const countBeforeBad = app.store.playbooks.count((p) => !p.deleted);
  const evilZip = createZip([{ name: 'X/playbook/playbook.json', data: JSON.stringify(localJson) }, { name: '../../escape.txt', data: 'pwned' }]);
  const damaged = Buffer.from(pkgBuf);
  const pbEntryAt = damaged.indexOf(Buffer.from(`${top}playbook/playbook.json`));
  damaged[pbEntryAt + Buffer.byteLength(`${top}playbook/playbook.json`) + 8] ^= 0xff;
  const bad = {
    unsafe: await api('POST', '/api/playbooks/import', { filename: 'evil.zip', content_base64: evilZip.toString('base64') }),
    empty: await api('POST', '/api/playbooks/import', { filename: 'notes.zip', content_base64: createZip([{ name: 'notes.txt', data: 'hello' }]).toString('base64') }),
    damaged: await api('POST', '/api/playbooks/import', { filename: 'damaged.zip', content_base64: damaged.toString('base64') }),
    truncated: await api('POST', '/api/playbooks/import', { filename: 'cut.zip', content_base64: pkgBuf.subarray(0, pkgBuf.length - 200).toString('base64') }),
    garbage: await api('POST', '/api/playbooks/import', { filename: 'x.json', content_base64: b64('not a playbook') }),
  };
  const badCodes = Object.fromEntries(Object.entries(bad).map(([k, x]) => [k, `${x.status} ${x.data.error && x.data.error.code}`]));
  check('unsafe, damaged or empty packages are refused and nothing is written', bad.unsafe.data.error.code === 'unsafe_package' && bad.empty.data.error.code === 'no_playbook' && bad.damaged.status === 400 && bad.truncated.status === 400 && bad.garbage.data.error.code === 'invalid_json' && app.store.playbooks.count((p) => !p.deleted) === countBeforeBad && !fs.existsSync(path.join(path.dirname(WS), 'escape.txt')), badCodes);

  r = await api('POST', `/api/playbooks/${broken.id}/duplicate`);
  const dupFolder = r.data.workspace && r.data.workspace.folder;
  check('a duplicate gets its own folder with the same inputs but no run history', dupFolder === `${brokenWs.folder} (copy)` && fs.existsSync(path.join(WS, dupFolder, 'inputs', 'runtime', 'customers q4.json')) && fs.readdirSync(path.join(WS, dupFolder, 'executions')).length === 0, dupFolder);
  r = await api('DELETE', `/api/playbooks/${imp.playbook_id}`);
  await app.workspaces.idleAll();
  check('deleting a playbook removes its folder and nothing else', r.status === 200 && !fs.existsSync(impDir) && fs.existsSync(goodDir) && fs.existsSync(brokenDir), imp.folder);

  // Upgrading from an earlier version: folders are created and earlier runs filed.
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbai-legacy-'));
  fs.writeFileSync(path.join(legacyDir, '.seeded'), 'legacy');
  const copyLegacy = (collection, id, drop) => {
    const doc = readJson(path.join(dataDir, collection, `${id}.json`));
    for (const k of drop) delete doc[k];
    fs.mkdirSync(path.join(legacyDir, collection), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, collection, `${id}.json`), JSON.stringify(doc));
  };
  copyLegacy('playbooks', good.id, ['workspace']);
  const legacyRuns = app.store.runs.list((x) => x.playbook_id === good.id);
  const legacyTests = app.store.testRuns.list((x) => x.playbook_id === good.id);
  for (const x of legacyRuns) copyLegacy('runs', x.id, ['workspace_run', 'workspace_path']);
  for (const x of legacyTests) copyLegacy('test-runs', x.id, ['workspace_test']);
  const legacy = createApp({ dataDir: legacyDir, quiet: true });
  await legacy.init();
  await legacy.workspaces.idleAll();
  const legacyFolder = legacy.store.playbooks.get(good.id).workspace;
  const legacyWs = legacyFolder ? path.join(legacyDir, 'workspaces', legacyFolder.folder) : '';
  const legacyExec = legacyWs ? fs.readdirSync(path.join(legacyWs, 'executions')).filter((n) => /^run-\d{3}$/.test(n)) : [];
  const firstRun = legacyRuns.slice().sort((a, b) => a.started_at.localeCompare(b.started_at))[0];
  check('after an upgrade, existing playbooks get their folders and past runs are filed', Boolean(legacyFolder) && legacyExec.length === legacyRuns.length && legacy.store.runs.get(firstRun.id).workspace_run === 1 && fs.readdirSync(path.join(legacyWs, 'tests', 'reports', 'history')).length === legacyTests.length && legacy.workspaceLog.length === 0, { folder: legacyFolder, exec: legacyExec.length, runs: legacyRuns.length, log: legacy.workspaceLog.slice(0, 2) });
  legacy.scheduler.stop();
  fs.rmSync(legacyDir, { recursive: true, force: true });

  await app.workspaces.idleAll();
  check('all workspace work finished without errors', app.workspaceLog.length === 0, app.workspaceLog.slice(0, 3));

  section('v1.3.0 fixes');
  // A malformed percent-encoding in a path is a 404, never a 500.
  r = await api('GET', '/api/playbooks/%zz');
  check('malformed percent-encoding in a route answers 404', r.status === 404 && r.data.error && r.data.error.code === 'not_found', r.status);
  // An oversized body gets the real 413 JSON, not a dropped connection.
  let tooBig;
  try {
    tooBig = await api('POST', '/api/discovery/start', { goal: 'x'.repeat(6 * 1024 * 1024) });
  } catch (err) {
    tooBig = { status: 0, data: {}, error: err };
  }
  check('an oversized request body is answered with 413, not a reset connection', tooBig.status === 413 && tooBig.data.error && tooBig.data.error.code === 'payload_too_large', tooBig.status);
  // Structured comparison accepts numbers the model returned as strings.
  check('numeric strings compare equal to the expected number', compareExpected(14, '14').length === 0 && compareExpected({ decision: 'at_risk', days: 14 }, { decision: 'at_risk', days: '14' }).length === 0, compareExpected(14, '14'));
  check('a wrong value still fails, string or not', compareExpected(14, '15').length === 1 && compareExpected('at_risk', 'healthy').length === 1, compareExpected(14, '15'));
  check('matchers accept numeric strings and compare loosely', compareExpected({ $gte: 10 }, '14').length === 0 && compareExpected({ $in: ['at_risk'] }, 'at_risk').length === 0 && compareExpected({ $ne: 5 }, '6').length === 0 && compareExpected({ $ne: 5 }, '5').length === 1, compareExpected({ $ne: 5 }, '5'));
  // Reasoning models: a <think> block must not win the JSON scan.
  const thinkJson = extractJson('<think>the user wants risk. Example: {"decision": "healthy", "x": 1}</think>\nHere is the result:\n```json\n{"response_type": "playbook", "status": "complete", "data": {}}\n```');
  check('a reasoning <think> block is ignored when extracting JSON', thinkJson.ok && thinkJson.value.response_type === 'playbook', thinkJson);
  // Schedules: an unknown day must never become Saturday.
  const wed = new Date('2025-06-04T10:00:00'); // Wednesday
  const weekdayNext = nextRun({ frequency: 'weekly', day: 'weekday', time: '09:00' }, wed);
  const monthNext = nextRun({ frequency: 'monthly', day: '15th', time: '09:00' }, wed);
  const unknownNext = nextRun({ frequency: 'weekly', day: 'someday', time: '09:00' }, wed);
  const mondayNext = nextRun({ frequency: 'weekly', day: 'monday', time: '09:00' }, wed);
  check('"weekday" schedules the next Monday–Friday, not Saturday', weekdayNext.getDay() === 4 && weekdayNext.getDate() === 5, weekdayNext.toString());
  check('a monthly day like "15th" schedules the 15th', monthNext.getDate() === 15, monthNext.toString());
  check('an unknown day name falls back to daily, never to a wrong weekday', unknownNext.getDate() === 5 && unknownNext.getHours() === 9, unknownNext.toString());
  check('a valid day name still schedules the next occurrence', mondayNext.getDay() === 1 && mondayNext.getDate() === 9, mondayNext.toString());
  // The browser poll survives transient errors and gives up eventually.
  await new Promise((resolve) => {
    let calls = 0;
    poll(async () => {
      calls += 1;
      if (calls < 3) throw new Error('transient');
      return 'fine';
    }, { interval: 5, done: () => { check('poll retries transient errors and finishes', calls === 3); resolve(); return true; }, onError: () => { check('poll retries transient errors and finishes', false); resolve(); return true; } });
  });
  await new Promise((resolve) => {
    let calls = 0;
    poll(async () => {
      calls += 1;
      throw new Error('down');
    }, { interval: 5, maxErrors: 2, onError: () => { check('poll reports the error after repeated failures', calls >= 2, calls); resolve(); } });
  });
  // A crash leaves nothing "running": interrupted docs are recovered at startup.
  app.playbooks.markTesting(broken.id, 4, true);
  const stuckRun = {
    id: 'run_zzstuck', playbook_id: broken.id, playbook_name: broken.name, version: 4, version_status: 'draft',
    mode: 'deterministic', environment: 'sandbox', trigger: 'manual', status: 'running',
    input: {}, input_source: null, configuration: {}, output: null, error: null, warnings: [], validation: null,
    trace: [], decisions: [], logs: [], approvals: [], pending_approval: null,
    policy: { production_actions: false, human_approval: true, tool_calling: true, require_validation: true },
    model: null, connection_id: null, usage: null,
    started_at: new Date().toISOString(), ended_at: null, duration_ms: null,
  };
  const stuckTest = {
    id: 'tr_zzstuck', playbook_id: broken.id, playbook_name: broken.name, version: 4, playbook_hash: 'x', suite_revision: 1,
    full_suite: false, test_ids: [], mode: 'deterministic', trigger: 'manual', status: 'running', result_status: null,
    started_at: new Date().toISOString(), ended_at: null, duration_ms: null,
    evaluation_time: new Date().toISOString(),
    environment: { engine_version: '1.0.0', node: process.version, platform: 'test', mode: 'deterministic', model: null, connection_id: null, temperature: null, configuration_hash: 'x', evaluation_model: null, repeatability_enabled: true },
    progress: { done: 0, total: 1 }, results: [], metrics: null, repair_suggestions: [],
    usage: { calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0 }, error: null,
  };
  app.store.runs.put(stuckRun);
  app.store.testRuns.put(stuckTest);
  await app.init();
  await app.workspaces.idleAll();
  const recRun = app.store.runs.get('run_zzstuck');
  const recTest = app.store.testRuns.get('tr_zzstuck');
  const v4After = app.store.playbooks.get(broken.id).versions.find((x) => x.version === 4);
  check('a run that was running when the server died is failed as INTERRUPTED', recRun.status === 'failed' && recRun.error.code === 'INTERRUPTED' && recRun.ended_at, recRun.error);
  check('an interrupted test run is failed and the version is not stuck in testing', recTest.status === 'error' && recTest.error.code === 'INTERRUPTED' && v4After.status !== 'testing', { test: recTest.error, version: v4After.status });
  app.store.runs.delete('run_zzstuck');
  app.store.testRuns.delete('tr_zzstuck');

  // --------------------------------------- v1.4.0: Ollama empty-response fix
  // The reported bug: qwen3.5:9b connects, then "The model returned an empty
  // response. Try another model." Root cause (Ollama issues #14793/#14645):
  // reasoning control was never sent, and the only control that works on
  // /api/chat is a TOP-LEVEL think:false — inside options it is ignored.
  section('v1.4.0 — Ollama qwen3.5 empty-response fix');
  check('qwen3.x is recognised as thinking-capable, llama3.2 is not', isThinkingModel('qwen3.5:9b') === true && isThinkingModel('deepseek-r1:8b') === true && isThinkingModel('llama3.2:latest') === false, { qwen: isThinkingModel('qwen3.5:9b'), llama: isThinkingModel('llama3.2:latest') });
  check('native Ollama replies normalize content, thinking and done_reason', (() => {
    const n = normalizeLocalResponse({ message: { role: 'assistant', content: '  hi  ', thinking: 'reasoning trace' }, done_reason: 'stop' });
    return n.content === 'hi' && n.thinking === 'reasoning trace' && n.finish_reason === 'stop';
  })());
  check('OpenAI-shaped replies normalize through the same function', (() => {
    const n = normalizeLocalResponse({ choices: [{ message: { role: 'assistant', content: 'x', reasoning_content: 'plan' }, finish_reason: 'length' }] });
    return n.content === 'x' && n.thinking === 'plan' && n.finish_reason === 'length';
  })());
  check('an empty reply is classified with the reasoning diagnosis, never "Try another model"', (() => {
    const err = emptyResponseError({ content: '', thinking: 'r'.repeat(300), finish_reason: 'length' }, { model: 'qwen3.5:9b', endpointMode: 'native_ollama_chat' });
    return err.code === 'EMPTY_RESPONSE' && err.retryable === true && /hidden reasoning/.test(err.message) && !/Try another model/i.test(err.message);
  })());

  const qfo = await startFakeOllama({ models: ['qwen3.5:9b'] });

  // Regression B: qwen3.5:9b + native /api/chat + top-level think:false must
  // produce non-empty visible content on the smoke test.
  r = await api('POST', '/api/connections/test', { provider: 'ollama', base_url: qfo.url, model: 'qwen3.5:9b' });
  check('qwen3.5:9b passes the full connection test through native /api/chat with reasoning off', r.data.ok === true && r.data.endpoint_mode === 'native_ollama_chat' && r.data.reasoning_mode === 'off', { ok: r.data.ok, error: r.data.error, failed: r.data.checks && r.data.checks.filter((c) => c.status !== 'ok') });

  // Regression A: the unsafe shapes are never sent — no /api/generate at all,
  // think:false top-level and never inside options.
  check('the adapter talks to /api/chat and never to /api/generate', qfo.state.nativeChatCalls > 0 && !qfo.state.calls.some((c) => c.includes('/api/generate')), { native: qfo.state.nativeChatCalls, paths: qfo.state.calls });
  check('think:false is a top-level field, never smuggled inside options', qfo.state.nativeRequests.length > 0 && qfo.state.nativeRequests.every((b) => b.think === false && !(b.options && 'think' in b.options)), qfo.state.lastNativeRequest);
  check('output limits map to options.num_predict on the native path', qfo.state.nativeRequests.every((b) => !b.options || typeof b.options.num_predict === 'number'), qfo.state.lastNativeRequest && qfo.state.lastNativeRequest.options);

  // Regression C: the OpenAI-compatible path controls reasoning with
  // reasoning_effort "none".
  const openAiBefore = qfo.state.openAiRequests.length;
  r = await api('POST', '/api/connections/test', { provider: 'lmstudio', base_url: qfo.url, model: 'qwen3.5:9b' });
  const lmReqs = qfo.state.openAiRequests.slice(openAiBefore);
  check('the OpenAI-compatible path sends reasoning_effort "none" for thinking models', lmReqs.length > 0 && lmReqs.every((b) => b.reasoning_effort === 'none') && r.data.ok === true && r.data.endpoint_mode === 'openai_compatible', { ok: r.data.ok, error: r.data.error, sent: qfo.state.lastRequest });

  // The fake simulates the reported bug: /api/chat answers empty without
  // think:false. When the native endpoint comes back empty anyway (old build,
  // ignored field), the adapter must repeat once and then switch endpoints
  // instead of giving up (impl spec §9).
  qfo.state.emptyNative = true;
  r = await api('POST', '/api/connections/test', { provider: 'ollama', base_url: qfo.url, model: 'qwen3.5:9b' });
  check('when /api/chat returns empty the adapter switches to the compatible endpoint and succeeds', r.data.ok === true && r.data.endpoint_mode === 'openai_compatible', { ok: r.data.ok, error: r.data.error });
  check('the native endpoint was retried before the switch', qfo.state.nativeRequests.length >= 2, qfo.state.nativeRequests.length);

  // Both endpoints empty: the failure is classified with the real reason.
  qfo.state.emptyOpenAI = true;
  r = await api('POST', '/api/connections/test', { provider: 'ollama', base_url: qfo.url, model: 'qwen3.5:9b' });
  check('after both endpoints fail the error is EMPTY_RESPONSE with the reasoning diagnosis', r.data.ok === false && r.data.error && r.data.error.code === 'EMPTY_RESPONSE' && /reasoning/i.test(r.data.error.message) && !/Try another model/i.test(r.data.error.message), r.data.error);
  check('the failing model is reported as-is, never silently swapped', r.data.model === 'qwen3.5:9b', r.data.model);
  qfo.state.emptyNative = false;
  qfo.state.emptyOpenAI = false;

  // The compatibility harness itself.
  r = await api('POST', '/api/connections/compat', { provider: 'ollama', base_url: qfo.url, model: 'qwen3.5:9b' });
  check('the compatibility harness runs all six checks', r.data.checks && r.data.checks.length === 6 && r.data.checks.every((c) => c.status === 'ok'), r.data.checks);
  check('qwen3.5:9b is compatible for playbook generation via the native endpoint', r.data.verdict === 'compatible' && r.data.endpoint_mode === 'native_ollama_chat' && r.data.reasoning_mode === 'off', { verdict: r.data.verdict, mode: r.data.endpoint_mode, reasons: r.data.reasons });
  r = await api('POST', '/api/connections/compat', { provider: 'ollama', base_url: 'http://127.0.0.1:1', model: 'qwen3.5:9b' });
  check('an unreachable server is incompatible, not merely untested', r.data.verdict === 'incompatible' && r.data.checks[0].id === 'connectivity', r.data.checks[0]);

  // Regression D + E: structured-output failures never create a playbook
  // record, and a successful generation stores the playbook JSON — never an
  // execution result.
  r = await api('POST', '/api/connections', { provider: 'ollama', name: 'Qwen 3.5 local', base_url: qfo.url, default_model: 'qwen3.5:9b' });
  const qid = r.data.id;
  check('the qwen3.5 connection saves as a local connection', r.data.type === 'local' && r.data.default_model === 'qwen3.5:9b', { type: r.data.type, model: r.data.default_model });
  r = await api('POST', `/api/connections/${qid}/test`, {});
  check('the saved connection reports connected and remembers the endpoint mode', r.data.state === 'connected' && r.data.last_endpoint_mode === 'native_ollama_chat', { state: r.data.state, err: r.data.last_error });
  r = await api('GET', `/api/connections/${qid}/compat?model=qwen3.5:9b&refresh=1`);
  check('the saved connection exposes the compatibility verdict', r.data.verdict === 'compatible', r.data.verdict);

  r = await api('PUT', '/api/settings', { ai: { privacy_mode: 'local_only' } });
  r = await api('PUT', `/api/connections/${qid}`, { is_default: true });
  r = await api('POST', '/api/discovery/start', { goal: 'Flag inactive sales opportunities every Monday' });
  const qsid = r.data.data.session.id;
  r = await api('POST', `/api/discovery/${qsid}/answer`, { question_id: r.data.data.questions[0].id, option_ids: ['b'] });
  r = await api('POST', `/api/discovery/${qsid}/answer`, { question_id: r.data.data.questions[0].id, option_ids: ['a'] });
  check('intent discovery completes on the thinking model', r.data.response_type === 'clarification_complete', r.data.response_type);
  r = await api('GET', '/api/playbooks');
  const pbCountBefore = r.data.playbooks.length;
  r = await api('POST', `/api/discovery/${qsid}/confirm`, {});
  qfo.state.brokenCompile = true;
  r = await api('POST', '/api/playbooks/generate', { session_id: qsid });
  check('a structured-output failure fails the generation request', r.status >= 400 && r.data.error && (r.data.error.code === 'INVALID_AI_RESPONSE' || r.data.error.code === 'EMPTY_RESPONSE'), { status: r.status, err: r.data.error });
  r = await api('GET', '/api/playbooks');
  check('the failed generation created no playbook record', r.data.playbooks.length === pbCountBefore, { before: pbCountBefore, after: r.data.playbooks.length });

  // Regression F: Local Only must prevent any cloud fallback after
  // empty-response / schema failures.
  r = await api('POST', `/api/connections/${connId}/test`);
  check('Local Only keeps blocking the cloud connection after local failures', r.status === 403 && r.data.error.code === 'local_only', r.data);
  r = await api('GET', '/api/connections');
  check('the active connection is still the local model — no silent cloud fallback', r.data.status.connection.id === qid && r.data.status.local === true, r.data.status.connection);
  check('the cloud connection stays flagged as not allowed', r.data.connections.find((c) => c.id === connId).allowed === false, null);

  qfo.state.brokenCompile = false;
  r = await api('POST', '/api/discovery/start', { goal: 'Flag inactive sales opportunities every Monday' });
  const qsid2 = r.data.data.session.id;
  r = await api('POST', `/api/discovery/${qsid2}/answer`, { question_id: r.data.data.questions[0].id, option_ids: ['b'] });
  r = await api('POST', `/api/discovery/${qsid2}/answer`, { question_id: r.data.data.questions[0].id, option_ids: ['a'] });
  r = await api('POST', `/api/discovery/${qsid2}/confirm`, {});
  r = await api('POST', '/api/playbooks/generate', { session_id: qsid2 });
  const qpbId = r.data.data && r.data.data.id;
  check('generation succeeds once the model produces valid JSON again', r.data.response_type === 'playbook' && r.data.data.playbook.steps.length >= 6, { type: r.data.response_type, err: r.data.error });
  r = await api('GET', `/api/playbooks/${qpbId}`);
  const qpbStored = JSON.stringify(r.data);
  check('the stored record holds the playbook JSON, never an execution result', r.data.playbook && r.data.playbook.steps && r.data.playbook.steps.length >= 6 && !qpbStored.includes('"execution_result"'), { steps: r.data.playbook && r.data.playbook.steps && r.data.playbook.steps.length });

  await api('PUT', '/api/settings', { ai: { privacy_mode: 'cloud_allowed' } });
  await api('PUT', `/api/connections/${connId}`, { is_default: true });
  await qfo.close();

  // --------------------------------------- v1.4.1: background-safe creation + smooth loaders
  section('v1.4.1 — background-safe creation + smooth loaders');
  r = await api('GET', '/views/create.js');
  const create1 = String(r.data);
  const bt = await api('GET', '/bg-tasks.js');
  const bt1 = String(bt.data);
  check('generations are registered at module scope so sidebar navigation cannot kill them', bt.status === 200 && /export const tasks = new Map/.test(bt1) && /export function beginTask/.test(bt1) && /from '..\/bg-tasks.js'/.test(create1), 'registry module');
  check('create view re-attaches to a running generation instead of offering a duplicate compile', /already in flight/.test(create1) && /watch\(existing\)/.test(create1) && /task\.attached = true/.test(create1), 're-attach path');
  check('a settled generation opens the playbook instead of recompiling a duplicate', /already compiled/.test(create1) && /existing\.result\.data\.id/.test(create1), 'settled guard');
  check('navigating away keeps the task and shows the corner progress card', /paintPill\(watched, 'running'\)/.test(create1) && /watched\.attached = false/.test(create1) && /paintPill/.test(bt1), 'cleanup handler');
  check('corner card handles running, done and failed states with jump-back links', /bg-task \$\{mode\}/.test(bt1) && /'Playbook ready — click to open'/.test(bt1) && /'Generation failed — click to review'/.test(bt1), 'pill states');
  check('the old discard-on-unmount behaviour is gone', !/gave up/.test(create1), 'removed silently-dropped result');
  check('generation progress rows are painted in place, not rebuilt every second', /painted in place|in place/i.test(create1) && create1.includes('clear(row.ic)') && /lastStatuses/.test(create1) && /rowIds/.test(create1), 'rows rebuild only when the step set changes; icons only when statuses change');
  r = await api('GET', '/ui.js');
  check('recreated spinners stay phase-synchronized (no restart stutter)', r.status === 200 && /SPIN_PERIOD_MS/.test(r.data) && /MutationObserver/.test(r.data) && /animationDelay/.test(r.data), r.status);
  r = await api('GET', '/styles.css');
  check('spinner is promoted to its own compositor layer', r.status === 200 && /\.spinner \{[\s\S]*?will-change: transform/.test(r.data), r.status);
  check('background progress card is styled (fixed bottom-left, done/failed verdicts)', /\.bg-tasks \{[\s\S]*?position: fixed/.test(r.data) && /\.bg-task\.done/.test(r.data) && /\.bg-task\.failed/.test(r.data), r.status);

  // --------------------------------------- v1.5.0: cloud API aggregators
  section('v1.5.0 — cloud API aggregators (NVIDIA, AMD, Google, Groq, custom…)');
  r = await api('GET', '/api/meta');
  const cloudIds = (r.data.providers || []).filter((p) => p.type === 'cloud').map((p) => p.id);
  const wanted = ['openrouter', 'nvidia', 'amd', 'google', 'groq', 'together', 'deepinfra', 'fireworks', 'mistral', 'cerebras', 'xai', 'github_models', 'custom_openai'];
  check('at least 12 cloud API aggregators are registered', cloudIds.length >= 12, cloudIds);
  check('the aggregator presets are present, including NVIDIA, AMD, Google and a custom endpoint', wanted.every((id) => cloudIds.includes(id)), cloudIds);
  const nv = (r.data.providers || []).find((p) => p.id === 'nvidia');
  check('NVIDIA preset ships its build.nvidia.com base URL and nvapi key hint', nv && nv.defaults && nv.defaults.base_url === 'https://integrate.api.nvidia.com/v1' && /nvapi/.test(nv.key_hint || ''), nv && nv.defaults);
  const cus = (r.data.providers || []).find((p) => p.id === 'custom_openai');
  check('custom preset allows a keyless endpoint and requires a base URL', cus && cus.allow_no_key === true && cus.requires_base_url === true, cus);

  // A tiny fake OpenAI-compatible aggregator: GET /v1/models + POST /v1/chat/completions.
  const aggRequests = [];
  const agg = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      aggRequests.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null, referer: req.headers['http-referer'] || null, xtitle: req.headers['x-title'] || null });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && /\/models$/.test(req.url)) {
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'meta/llama-3.3-70b', object: 'model', context_window: 8192 }, { id: 'qwen/qwen3-32b', object: 'model' }] }));
      } else if (req.method === 'POST' && /\/chat\/completions$/.test(req.url)) {
        res.end(JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', model: 'meta/llama-3.3-70b', choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: 'not found' } }));
      }
    });
  });
  await new Promise((res) => agg.listen(0, '127.0.0.1', res));
  const aggUrl = `http://127.0.0.1:${agg.address().port}/v1`;

  r = await api('POST', '/api/connections', { provider: 'nvidia', name: 'NVIDIA selftest', api_key: 'nvapi-selftest', base_url: aggUrl });
  const nvConn = r.data || null;
  check('creating an NVIDIA connection stores the overridable base URL and a masked key', r.status === 200 && nvConn && nvConn.base_url && nvConn.base_url.startsWith('http://127.0.0.1') && nvConn.api_key_masked, nvConn && nvConn.base_url);

  r = await api('GET', `/api/connections/${nvConn ? nvConn.id : 'x'}/models`);
  check('an NVIDIA connection lists models from an OpenAI-compatible catalog', r.status === 200 && r.data.count === 2 && (r.data.models || []).some((m) => m.id === 'meta/llama-3.3-70b'), { status: r.status, err: r.data && r.data.error });
  const aggLlama = ((r.data && r.data.models) || []).find((m) => m.id === 'meta/llama-3.3-70b');
  check('context_window (Groq/NVIDIA style) is picked up as the context length', aggLlama && aggLlama.context_length === 8192, aggLlama);

  r = await api('POST', `/api/connections/${nvConn ? nvConn.id : 'x'}/test`);
  check('the generic key check runs against /models (no provider-specific /key call)', r.data && r.data.status === 'ok', r.data);
  check('the preset adapter sends the bearer key and no OpenRouter-specific headers', aggRequests.length > 0 && aggRequests.every((q) => q.authorization === 'Bearer nvapi-selftest' && !q.referer && !q.xtitle), aggRequests[0]);

  r = await api('POST', '/api/connections', { provider: 'groq', name: 'Groq selftest', api_key: 'gsk-selftest', base_url: aggUrl });
  const groqConn = r.data || null;
  check('creating a Groq connection stores the overridable base URL', r.status === 200 && groqConn && groqConn.base_url && groqConn.base_url.startsWith('http://127.0.0.1'), groqConn && groqConn.base_url);
  r = await api('POST', `/api/connections/${groqConn ? groqConn.id : 'x'}/test`);
  check('the saved Groq connection tests OK against the aggregator API', r.data && r.data.status === 'ok', r.data);

  r = await api('POST', '/api/connections', { provider: 'custom_openai', name: 'Gateway', base_url: aggUrl });
  const gw = r.data || null;
  check('custom preset accepts a keyless OpenAI-compatible endpoint', r.status === 200 && gw && !gw.api_key_masked, { status: r.status });
  const before = aggRequests.length;
  r = await api('POST', `/api/connections/${gw ? gw.id : 'x'}/test`);
  check('keyless gateway requests carry no Authorization header', r.data && r.data.status === 'ok' && aggRequests.length > before && aggRequests.slice(before).every((q) => !q.authorization), aggRequests[aggRequests.length - 1]);

  r = await api('POST', '/api/connections', { provider: 'custom_openai', name: 'No URL' });
  check('custom preset without a base URL is rejected', r.status === 400 && r.data.error && r.data.error.code === 'base_url_required', r.data);
  r = await api('POST', '/api/connections', { provider: 'nvidia', base_url: aggUrl });
  check('a keyed preset still requires an API key', r.status === 400 && r.data.error && r.data.error.code === 'bad_request', r.data);

  r = await api('GET', `/api/connections/${nvConn ? nvConn.id : 'x'}/compat?model=${encodeURIComponent('meta/llama-3.3-70b')}`);
  check('the compatibility harness also runs against cloud presets', r.data && ['compatible', 'compatible_with_limitations', 'incompatible'].includes(r.data.verdict), r.data && r.data.verdict);

  r = await api('GET', '/views/connections.js');
  check('the connections UI serves the aggregator provider picker', r.status === 200 && /cloudDialog/.test(r.data) && /requires_base_url/.test(r.data) && /Service base URL/.test(r.data), r.status);
  agg.close();

  // --------------------------------------- v1.6.0: Anthropic API + Ollama context window + request timeout
  section('v1.6.0 — Anthropic API, Ollama context window, request timeout');

  r = await api('GET', '/api/meta');
  const ant = (r.data.providers || []).find((p) => p.id === 'anthropic');
  check('Anthropic is registered with its native base URL, key hint and a native-API note', ant && ant.type === 'cloud' && ant.defaults && ant.defaults.base_url === 'https://api.anthropic.com/v1' && /sk-ant/.test(ant.key_hint || '') && /native/i.test(ant.note || ''), ant && ant.defaults);

  // A tiny fake Anthropic Messages API: GET /v1/models + POST /v1/messages.
  const antRequests = [];
  const anthropicFake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; } catch { /* plain text */ }
      const pathname = req.url.split('?')[0];
      antRequests.push({ method: req.method, url: pathname, xapikey: req.headers['x-api-key'] || null, version: req.headers['anthropic-version'] || null, authorization: req.headers.authorization || null, body: payload });
      const done = (obj, status = 200) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(obj));
      };
      if (req.headers['x-api-key'] === 'sk-ant-wrong') {
        return done({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401);
      }
      if (req.method === 'GET' && /\/models$/.test(pathname)) {
        return done({ data: [{ type: 'model', id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', created_at: '2026-01-01T00:00:00Z' }, { type: 'model', id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2026-01-01T00:00:00Z' }] });
      }
      if (req.method === 'POST' && /\/messages$/.test(pathname)) {
        const user = String(((payload.messages || []).slice(-1)[0] || {}).content || '');
        if (/NEED_TOOL/.test(user)) {
          return done({ id: 'msg_tool', model: payload.model, content: [{ type: 'text', text: 'Calling the tool.' }, { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'acme' } }], stop_reason: 'tool_use', usage: { input_tokens: 15, output_tokens: 10 } });
        }
        if (/EMPTY_PLEASE/.test(user)) {
          return done({ id: 'msg_empty', model: payload.model, content: [{ type: 'text', text: '' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } });
        }
        if (/Return this JSON object exactly/i.test(user)) return done({ id: 'msg_1', model: payload.model, content: [{ type: 'text', text: '{"ready": true, "token": "PLAYBOOK_READY"}' }], stop_reason: 'end_turn', usage: { input_tokens: 21, output_tokens: 12 } });
        if (/PLAYBOOK_READY/.test(user)) return done({ id: 'msg_2', model: payload.model, content: [{ type: 'text', text: 'PLAYBOOK_READY' }], stop_reason: 'end_turn', usage: { input_tokens: 18, output_tokens: 4 } });
        if (/Report Builder/.test(user)) return done({ id: 'msg_3', model: payload.model, content: [{ type: 'text', text: '{"name": "Report Builder", "objective": "Build a short status report.", "steps": [{"id": "step_01", "name": "Collect", "type": "transform", "instructions": ["Collect the input."], "output": {"name": "data", "type": "array"}}]}' }], stop_reason: 'end_turn', usage: { input_tokens: 40, output_tokens: 90 } });
        if (/clarification_question/.test(user)) return done({ id: 'msg_4', model: payload.model, content: [{ type: 'text', text: '{"response_type": "clarification_question", "status": "needs_input", "data": {"questions": [{"id": "q1", "text": "What should the playbook do?", "input_type": "text", "options": []}]}}' }], stop_reason: 'end_turn', usage: { input_tokens: 40, output_tokens: 50 } });
        return done({ id: 'msg_9', model: payload.model, content: [{ type: 'text', text: 'ANTHROPIC_OK' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 3 } });
      }
      return done({ type: 'error', error: { type: 'not_found_error', message: 'not found' } }, 404);
    });
  });
  await new Promise((res) => anthropicFake.listen(0, '127.0.0.1', res));
  const antUrl = `http://127.0.0.1:${anthropicFake.address().port}/v1`;

  r = await api('POST', '/api/connections', { provider: 'anthropic', name: 'Anthropic selftest', base_url: antUrl });
  check('creating an Anthropic connection without a key is rejected', r.status === 400 && r.data.error && r.data.error.code === 'bad_request', r.data);
  r = await api('POST', '/api/connections', { provider: 'anthropic', name: 'Anthropic selftest', api_key: 'sk-ant-selftest', base_url: antUrl });
  const antConn = r.data || null;
  check('the Anthropic connection stores the overridable base URL and a masked key', r.status === 200 && antConn && antConn.base_url === antUrl && Boolean(antConn.api_key_masked), antConn && antConn.base_url);

  r = await api('POST', `/api/connections/${antConn ? antConn.id : 'x'}/test`);
  check('the Anthropic key check authenticates via x-api-key + anthropic-version, never a bearer header', r.data && r.data.status === 'ok' && antRequests.length > 0 && antRequests.every((q) => q.xapikey === 'sk-ant-selftest' && q.version === '2023-06-01' && !q.authorization), { status: r.data && r.data.status, last: antRequests[antRequests.length - 1] });

  r = await api('GET', `/api/connections/${antConn ? antConn.id : 'x'}/models`);
  check('the Anthropic connection lists the Claude catalog with the 200k context window', r.status === 200 && r.data.count === 2 && (r.data.models || []).some((m) => m.id === 'claude-sonnet-4-5' && m.context_length === 200000), { status: r.status, err: r.data && r.data.error });

  r = await api('GET', `/api/connections/${antConn ? antConn.id : 'x'}/compat?model=claude-sonnet-4-5`);
  check('the compatibility harness runs against Anthropic', r.data && ['compatible', 'compatible_with_limitations', 'incompatible'].includes(r.data.verdict), r.data && r.data.verdict);
  const antMsg = antRequests.filter((q) => /\/messages$/.test(q.url)).map((q) => q.body);
  const lastAntBody = antMsg[antMsg.length - 1] || null;
  check('Anthropic chat sends a required max_tokens, a top-level system field and no system message', lastAntBody && typeof lastAntBody.max_tokens === 'number' && typeof lastAntBody.system === 'string' && (lastAntBody.messages || []).every((m) => m.role !== 'system'), lastAntBody && { max_tokens: lastAntBody.max_tokens, system: lastAntBody.system });

  const antProvider = new AnthropicProvider({ base_url: antUrl }, 'sk-ant-selftest');
  const toolReply = await antProvider.chat({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'NEED_TOOL lookup' }], max_tokens: 512, retries: 0 });
  check('tool_use blocks come back as OpenAI-style tool_calls with structured arguments and mapped usage', toolReply.finish_reason === 'tool_calls' && toolReply.tool_calls[0] && toolReply.tool_calls[0].function.name === 'lookup' && JSON.parse(toolReply.tool_calls[0].function.arguments).q === 'acme' && toolReply.usage.prompt_tokens === 15, toolReply.tool_calls);
  const emptyReply = await antProvider.chat({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'EMPTY_PLEASE' }], retries: 0 }).catch((e) => e);
  check('an empty Anthropic reply is a retryable EMPTY_RESPONSE with a real diagnosis', emptyReply instanceof Error && emptyReply.code === 'EMPTY_RESPONSE' && emptyReply.retryable === true, emptyReply.code);
  const badKeyProvider = new AnthropicProvider({ base_url: antUrl }, 'sk-ant-wrong');
  const authErr = await badKeyProvider.chat({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }], retries: 0 }).catch((e) => e);
  check('a rejected Anthropic key is an AUTH_ERROR that points at the key', authErr instanceof Error && authErr.code === 'AUTH_ERROR' && /API key/.test(authErr.message), authErr.code);

  // --- Ollama context window (num_ctx) + keep_alive.
  const oll = await startFakeOllama();
  r = await api('POST', '/api/connections', { provider: 'ollama', name: 'Ollama ctx selftest', base_url: oll.url, default_model: 'llama3.2:latest', context_window: 8192 });
  const ollConn = r.data || null;
  check('a local connection stores the requested context window (num_ctx)', r.status === 200 && ollConn && ollConn.context_window === 8192, ollConn && ollConn.context_window);
  r = await api('PUT', `/api/connections/${ollConn ? ollConn.id : 'x'}`, { context_window: 'abc' });
  check('a non-numeric context window is rejected', r.status === 400 && r.data.error && r.data.error.code === 'bad_request', r.data);
  r = await api('PUT', `/api/connections/${ollConn ? ollConn.id : 'x'}`, { context_window: 16384 });
  check('updating the context window persists', r.status === 200 && r.data.context_window === 16384, r.data && r.data.context_window);
  r = await api('PUT', `/api/connections/${ollConn ? ollConn.id : 'x'}`, { context_window: null });
  check('a null context window clears back to the model default', r.status === 200 && r.data.context_window === null, r.data && r.data.context_window);
  await api('PUT', `/api/connections/${ollConn.id}`, { context_window: 16384 });

  const nativeBefore = oll.state.nativeRequests.length;
  r = await api('GET', `/api/connections/${ollConn.id}/compat?model=llama3.2:latest&refresh=1`);
  const nativeReq = oll.state.nativeRequests[nativeBefore] || null;
  check('with a context window set, a NON-thinking Ollama model is routed native-first', r.data && r.data.endpoint_mode === 'native_ollama_chat' && oll.state.nativeRequests.length > nativeBefore, { verdict: r.data && r.data.verdict, endpoint_mode: r.data && r.data.endpoint_mode });
  check('the native request carries options.num_ctx and a keep_alive window', nativeReq && nativeReq.options && nativeReq.options.num_ctx === 16384 && nativeReq.keep_alive === '15m', nativeReq && nativeReq.options);

  r = await api('POST', '/api/connections/test', { provider: 'ollama', base_url: oll.url, authentication: { type: 'none' }, context_window: 4096, model: 'qwen2.5:7b' });
  const draftNative = oll.state.nativeRequests[oll.state.nativeRequests.length - 1] || null;
  check('draft (unsaved) connection tests apply the context window as num_ctx too', r.data && r.data.ok === true && draftNative && draftNative.options && draftNative.options.num_ctx === 4096, { ok: r.data && r.data.ok, options: draftNative && draftNative.options });

  const { LOCAL_ADAPTERS, LocalAIProvider: LocalProvider } = await import('../server/ai/local.js');
  const toolLocal = new LocalProvider({ id: 'x', provider: 'ollama', type: 'local', base_url: oll.url, authentication: { type: 'none' }, context_window: 8192, models: {} }, '', LOCAL_ADAPTERS.ollama);
  const toolOpenAiBefore = oll.state.openAiRequests.length;
  await toolLocal.chat({ model: 'llama3.2:latest', messages: [{ role: 'system', content: 'Plain.' }, { role: 'user', content: 'TOOLS please' }], tools: [{ type: 'function', function: { name: 't1', description: '', parameters: { type: 'object', properties: {} } } }], retries: 0 });
  const toolReq = oll.state.openAiRequests[toolOpenAiBefore] || null;
  check('tool requests stay on the OpenAI-compatible endpoint and still carry options.num_ctx', toolReq && Array.isArray(toolReq.tools) && toolReq.options && toolReq.options.num_ctx === 8192, toolReq && toolReq.options);

  // --- Configurable request timeout (Ollama must not be cut off early).
  r = await api('GET', '/api/settings');
  check('the AI request timeout defaults to 10 minutes', r.data && r.data.ai && r.data.ai.request_timeout_minutes === 10, r.data && r.data.ai);
  r = await api('PUT', '/api/settings', { ai: { request_timeout_minutes: 500 } });
  check('an out-of-range request timeout is rejected', r.status === 400, r.status);
  r = await api('PUT', '/api/settings', { ai: { request_timeout_minutes: 30 } });
  check('the request timeout is configurable', r.status === 200 && r.data.ai.request_timeout_minutes === 30, r.data && r.data.ai);
  await api('PUT', '/api/settings', { ai: { request_timeout_minutes: 10 } });
  const serviceSrc = fs.readFileSync(path.join(ROOT, 'server/ai/service.js'), 'utf8');
  check('the service injects the configurable timeout when a caller sets none', /request_timeout_minutes/.test(serviceSrc) && /minutes \* 60000/.test(serviceSrc), 'timeout injection');
  const compilerSrc = fs.readFileSync(path.join(ROOT, 'server/playbooks/compiler.js'), 'utf8');
  check('the compiler no longer hardcodes a 5-minute cap', !/timeoutMs: 300000/.test(compilerSrc), 'no fixed cap');
  const localSrc = fs.readFileSync(path.join(ROOT, 'server/ai/local.js'), 'utf8');
  check('the local chat fallback budget is raised to 10 minutes and tests to 3 minutes', /LOCAL_CHAT_TIMEOUT_MS = 600000/.test(localSrc) && /LOCAL_TEST_TIMEOUT_MS = 180000/.test(localSrc) && !/300000/.test(localSrc), 'raised budgets');
  const compatSrc = fs.readFileSync(path.join(ROOT, 'server/ai/compat.js'), 'utf8');
  check('the compatibility harness allows 4 minutes per check', /TIMEOUT_MS = 240000/.test(compatSrc), '240s');

  r = await api('GET', '/views/connections-local.js');
  check('the local connection form exposes the Ollama context window field', r.status === 200 && /Context window \(num_ctx\)/.test(r.data) && /num_ctx/.test(r.data), r.status);
  r = await api('GET', '/views/settings.js');
  check('settings exposes the AI request timeout control', r.status === 200 && /request_timeout_minutes/.test(r.data) && /AI request timeout/.test(r.data), r.status);
  r = await api('GET', '/views/connections.js');
  check('the connections page documents Anthropic native support', r.status === 200 && /Anthropic/.test(r.data), r.status);

  anthropicFake.close();
  oll.close();

  section('v1.7.0 — live pipeline progress ("1 of X") + resilient test generation');

  // --- Registry behaviour (mid-run states cannot be caught over HTTP with instant mocks)
  Progress.beginJob('selftest_unit', [{ id: 'a', label: 'Step A' }, { id: 'b', label: 'Step B' }]);
  Progress.setStep('selftest_unit', 'a', { status: 'done', detail: 'first ok' });
  Progress.setStep('selftest_unit', 'b', { detail: 'working' });
  let usnap = Progress.snapshot('selftest_unit');
  check('registry numbers the active step ("2 of 2")', usnap.step_index === 2 && usnap.step_total === 2, usnap);
  check('registry keeps per-step status and detail lines', usnap.steps[0].detail === 'first ok' && usnap.steps[0].status === 'done' && usnap.steps[1].status === 'active', usnap.steps);
  Progress.finishJob('selftest_unit', new Error('boom'));
  usnap = Progress.snapshot('selftest_unit');
  check('registry: finishing with an error marks the active step failed', usnap.done && usnap.error === 'boom' && usnap.steps[1].status === 'failed', usnap);

  r = await api('GET', '/api/progress/nope');
  check('an unknown progress key answers 404', r.status === 404, r.status);

  // --- Compile with live progress (mock connection, 2 gate rounds)
  r = await api('POST', '/api/discovery/start', { goal: 'Progress probe: flag inactive sales opportunities every Monday' });
  const sidP = r.data.data.session.id;
  let qp = r.data.data.questions[0];
  r = await api('POST', `/api/discovery/${sidP}/answer`, { question_id: qp.id, option_ids: ['b'] });
  qp = r.data.data.questions[0];
  r = await api('POST', `/api/discovery/${sidP}/answer`, { question_id: qp.id, option_ids: ['a'] });
  await api('POST', `/api/discovery/${sidP}/confirm`, {});
  r = await api('POST', '/api/playbooks/generate', { session_id: sidP, progress_key: 'selftest_progress' });
  check('generate with a progress_key still returns the typed playbook envelope', r.status === 200 && r.data.response_type === 'playbook', r.data && r.data.response_type);
  r = await api('GET', '/api/progress/gen_selftest_progress');
  check('the final progress snapshot is pollable after completion', r.status === 200 && r.data.response_type === 'progress' && r.data.data.done === true, r.data && r.data.data);
  const psnap = (r.data && r.data.data) || { steps: [] };
  check('the pipeline reports 4 numbered steps, all done at the end', psnap.step_total === 4 && psnap.step_index === 4 && psnap.steps.every((s) => s.status === 'done'), psnap);
  check('compile step recorded the real attempt count', /Attempt 2 produced 7 steps/.test(psnap.steps[0].detail || ''), psnap.steps[0]);
  check('validate step reported a clean parse', /parsed cleanly/.test(psnap.steps[1].detail || ''), psnap.steps[1]);
  check('quality gate step shows the checks-passed count', /checks passed/.test(psnap.steps[2].detail || ''), psnap.steps[2]);
  check('tests step reports the deterministic suite size', /generated from your rules/.test(psnap.steps[3].detail || ''), psnap.steps[3]);

  // --- max_tokens is clamped to the connection's context window (16k num_ctx → 8k output budget)
  const oll17 = await startFakeOllama();
  r = await api('POST', '/api/connections', { provider: 'ollama', name: 'Ollama clamp selftest', base_url: oll17.url, default_model: 'llama3.2:latest', context_window: 16384 });
  const clampConn = r.data || null;
  check('the clamp connection stores a 16384 context window', r.status === 200 && clampConn && clampConn.context_window === 16384, clampConn && clampConn.context_window);
  await api('PUT', `/api/connections/${clampConn ? clampConn.id : 'x'}`, { models: { clarification: 'llama3.2:latest', generation: 'llama3.2:latest', execution: 'llama3.2:latest', testing: 'llama3.2:latest', evaluation: 'llama3.2:latest' }, is_default: true });
  r = await api('POST', '/api/discovery/start', { goal: 'Clamp probe: classify customers by inactivity' });
  const sidC = r.data.data.session.id;
  let qc = r.data.data.questions[0];
  r = await api('POST', `/api/discovery/${sidC}/answer`, { question_id: qc.id, option_ids: ['b'] });
  qc = r.data.data.questions[0];
  r = await api('POST', `/api/discovery/${sidC}/answer`, { question_id: qc.id, option_ids: ['a'] });
  await api('POST', `/api/discovery/${sidC}/confirm`, {});
  r = await api('POST', '/api/playbooks/generate', { session_id: sidC, progress_key: 'clamp' });
  check('compiling against the local connection still produces a playbook', r.status === 200 && r.data.response_type === 'playbook', r.data && r.data.response_type);
  const clampPbId = r.data && r.data.data && r.data.data.id;
  const nativeBodies = oll17.state.nativeRequests;
  check('the compile actually went through the native Ollama chat path with num_ctx', nativeBodies.length > 0 && nativeBodies.some((q) => q.options && q.options.num_ctx === 16384), nativeBodies.length);
  const budgets = nativeBodies.filter((q) => q.options && q.options.num_predict).map((q) => q.options.num_predict);
  check('no request asks for more than half of the 16k context window', budgets.length > 0 && budgets.every((n) => n <= 8192), budgets);
  check('the compile output budget is exactly clamped to 8192 tokens', budgets.includes(8192), budgets);

  // --- AI test generation: planned, then written in batches with live batch progress
  mockState.testPlanCalls = 0;
  mockState.testBatchCalls = 0;
  r = await api('POST', `/api/playbooks/${clampPbId}/tests/generate`, { strategy: 'ai', progress_key: 'clamp_tests' });
  check('AI test generation is planned and batched (typed test_case envelope)', r.status === 200 && r.data.response_type === 'test_case', r.data && r.data.response_type);
  check('the planner ran once and generation ran in batches', mockState.testPlanCalls === 1 && mockState.testBatchCalls === 2, { plan: mockState.testPlanCalls, batches: mockState.testBatchCalls });
  check('the batched suite adds the same tests as before (no duplicates)', r.data.data.added.length === 3, r.data.data && r.data.data.added && r.data.data.added.length);
  r = await api('GET', '/api/progress/tests_clamp_tests');
  const tsnap = (r.data && r.data.data) || { steps: [] };
  const tdets = (tsnap.steps || []).map((s) => s.detail || '').join(' | ');
  check('the tests snapshot ends with the plan and the written count', r.status === 200 && /Suite plan: about 6 tests/.test(tdets) && /3 AI test cases written in 2 batches/.test(tdets), tdets);
  const genSrc = fs.readFileSync(path.join(ROOT, 'server/testing/generator.js'), 'utf8');
  check('live batch updates use the "Batch x of y · n of target written" format', /Batch \$\{i\} of \$\{batches\} — writing/.test(genSrc) && /Batch \$\{i\} of \$\{batches\} added/.test(genSrc), 'live batch details');

  // --- A failing batch is skipped, not fatal
  mockState.testPlanCalls = 0;
  mockState.testBatchCalls = 0;
  mockState.testFailBatch = 1;
  r = await api('POST', `/api/playbooks/${good.id}/tests/generate`, { strategy: 'ai' });
  mockState.testFailBatch = 0;
  check('a failed batch is skipped and the endpoint still succeeds', r.status === 200 && r.data.response_type === 'test_case', r.data && r.data.response_type);
  check('the skipped batch is surfaced as a note', (r.data.data.notes || []).some((n) => /batch 1 of 2 failed/.test(n)), r.data.data && r.data.data.notes);
  check('tests from the healthy batch were still added', r.data.data.added.length === 3, r.data.data && r.data.data.added && r.data.data.added.length);

  // --- Static-ish source checks for the new machinery
  check('AI test generation writes in small batches with per-batch fault tolerance', /TEST_BATCH_SIZE = 4/.test(genSrc) && /TEST_MAX_BATCHES = 6/.test(genSrc) && /failedBatches/.test(genSrc), 'batching');
  const svcSrc = fs.readFileSync(path.join(ROOT, 'server/ai/service.js'), 'utf8');
  check('max_tokens is clamped to the connection context window', /ctxBudget/.test(svcSrc) && /conn\.context_window/.test(svcSrc), 'clamp');
  const progressSrc = fs.readFileSync(path.join(ROOT, 'server/progress.js'), 'utf8');
  check('the progress registry expires finished jobs', /DONE_TTL_MS/.test(progressSrc) && /JOB_TTL_MS/.test(progressSrc), 'ttl');
  r = await api('GET', '/views/create.js');
  check('the create view polls live progress and numbers every step', r.status === 200 && /api\/progress\/gen_/.test(r.data) && /gen-num/.test(r.data) && /gen-det/.test(r.data), r.status);
  check('the background pill shows the live step counter', bt.status === 200 && /pillLabel/.test(bt1) && /step \$\{p\.step_index\} of \$\{p\.step_total\}/.test(bt1), 'pill');
  r = await api('GET', '/styles.css');
  check('numbered stage rows have styles', r.status === 200 && /\.gen-num/.test(r.data) && /\.gen-det/.test(r.data), r.status);

  await api('PUT', `/api/connections/${connId}`, { is_default: true });
  oll17.close();

  section('v1.1.3 — Ollama transport fix (no hidden timeouts), PC tiers, reload-proof background runs');

  // --- The provider transport must not use fetch (undici's fixed 5-minute
  // headers timeout was the real "Could not reach Ollama (UND_ERR_HEADERS_TIMEOUT)"
  // while Ollama was running fine).
  const localSrc113 = fs.readFileSync(path.join(ROOT, 'server/ai/local.js'), 'utf8');
  check('the local provider no longer talks over fetch', !/await fetch\(/.test(localSrc113) && /httpRequest\(/.test(localSrc113), 'transport swap');
  const transportSrc = fs.readFileSync(path.join(ROOT, 'server/ai/transport.js'), 'utf8');
  check('the transport is node:http based with no undici dependency', /node:http/.test(transportSrc) && !/undici/.test(transportSrc.replace(/\/\/[^\n]*undici[^\n]*|\/\*[\s\S]*?\*\//g, '')), 'node:http transport');

  const freePort113 = () => new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const { LocalAIProvider: LProvider113, LOCAL_ADAPTERS: LAdapters113 } = await import('../server/ai/local.js');
  const dummyConn113 = (url) => ({ id: 'conn_t', provider: 'ollama', type: 'local', name: 't', base_url: url, authentication: { type: 'none' }, models: {} });

  const deadPort = await freePort113();
  const deadProvider = new LProvider113(dummyConn113(`http://127.0.0.1:${deadPort}`), '', LAdapters113.ollama);
  let tErr = null;
  try {
    await deadProvider.request('GET', '/api/tags', null, { timeoutMs: 3000 });
  } catch (err) {
    tErr = err;
  }
  check('a closed port is SERVER_UNREACHABLE ("Nothing is answering"), not a mystery', tErr && tErr.code === 'SERVER_UNREACHABLE' && /Nothing is answering/.test(tErr.message), tErr && `${tErr.code}: ${tErr.message}`);

  const silent = net.createServer((sock) => { sock.on('data', () => {}); /* accept, never answer */ });
  await new Promise((res) => silent.listen(0, '127.0.0.1', res));
  const silentProvider = new LProvider113(dummyConn113(`http://127.0.0.1:${silent.address().port}`), '', LAdapters113.ollama);
  tErr = null;
  try {
    await silentProvider.request('GET', '/api/tags', null, { timeoutMs: 1100 });
  } catch (err) {
    tErr = err;
  }
  silent.close();
  check('a silent server hits OUR deadline as retryable TIMEOUT, not "could not reach"', tErr && tErr.code === 'TIMEOUT' && tErr.retryable === true && /did not finish within/.test(tErr.message), tErr && `${tErr.code}: ${tErr.message.slice(0, 140)}`);
  check('the timeout message explains the model may still be working', tErr && /still loading|Performance Tier|smaller model/.test(tErr.message), tErr && tErr.message.slice(0, 200));

  // --- PC Performance Tiers: catalog, storage, validation.
  r = await api('GET', '/api/meta');
  const tiers = (r.data && r.data.tiers) || [];
  const tierById = Object.fromEntries(tiers.map((t) => [t.id, t]));
  check('meta serves the three PC performance tiers', ['low', 'medium', 'high'].every((id) => tierById[id]), tiers.map((t) => t.id));
  check('tiers document GPU VRAM and minimum RAM requirements', tiers.every((t) => /VRAM/.test(t.requirements.gpu) && /RAM/.test(t.requirements.ram)), tiers.map((t) => t.requirements && t.requirements.gpu));
  check('tier test-case caps are 4 / 8 / 16', tierById.low.test_cases === 4 && tierById.medium.test_cases === 8 && tierById.high.test_cases === 16, tiers.map((t) => [t.id, t.test_cases]));
  check('tiers carry trade-off and expectation copy', tiers.every((t) => t.tradeoffs && t.expect && t.context_window), tiers.map((t) => [t.id, Boolean(t.tradeoffs)]));

  const oll113 = await startFakeOllama();
  r = await api('POST', '/api/connections', { provider: 'ollama', name: 'Ollama tier selftest', base_url: oll113.url, default_model: 'llama3.2:latest', tier: 'low', context_window: 4096 });
  const tierConn = r.data || null;
  check('a local connection stores the low tier', r.status === 200 && tierConn && tierConn.tier === 'low' && tierConn.context_window === 4096, tierConn && tierConn.tier);
  r = await api('POST', '/api/connections', { provider: 'ollama', name: 'bad tier', base_url: oll113.url, tier: 'quantum' });
  check('an unknown tier is rejected with a readable 400', r.status === 400 && /performance tier/i.test(r.data.error.message), r.data);
  r = await api('PUT', `/api/connections/${tierConn.id}`, { tier: 'high' });
  check('the tier can be raised (medium/higher than low)', r.status === 200 && r.data.tier === 'high', r.data && r.data.tier);
  r = await api('PUT', `/api/connections/${tierConn.id}`, { tier: null });
  check('clearing the tier falls back to Custom (no cap)', r.status === 200 && r.data.tier === null, r.data && r.data.tier);

  // --- The tier caps AI test generation on the wire (low tier: fewer test cases).
  await api('PUT', `/api/connections/${tierConn.id}`, { tier: 'low', models: { clarification: 'llama3.2:latest', generation: 'llama3.2:latest', execution: 'llama3.2:latest', testing: 'llama3.2:latest', evaluation: 'llama3.2:latest' }, is_default: true });
  r = await api('POST', '/api/playbooks', { playbook: { name: 'Tier Cap Probe', description: 'Small playbook for the tier cap check.', objective: 'Classify the customer by inactivity days.', inputs: [{ id: 'customer', name: 'Customer', type: 'object', required: true, source: 'Run input', example: { name: 'Acme', days_since_activity: 21 } }], steps: [{ id: 'step_01', name: 'Decide', type: 'decision', purpose: 'Classify.', inputs: ['input.customer'], instructions: ['Apply the rules.'], output: { name: 'decision' }, execution: { op: 'decide', subject: 'input.customer' } }], output: { format: 'json', fields: [{ name: 'decision', type: 'string', required: true }] } } });
  const tierPb = r.data ? r.data.id : null;
  check('the tier-cap probe playbook is imported', Boolean(tierPb), r.status);
  mockState.testPlanCalls = 0;
  mockState.testBatchCalls = 0;
  r = await api('POST', `/api/playbooks/${tierPb}/tests/generate`, { strategy: 'ai', progress_key: 'tier113' });
  check('AI test generation against the low-tier connection succeeds', r.status === 200 && r.data.response_type === 'test_case', r.data && r.data.response_type);
  check('the low tier caps the suite: the planner wanted 6, only one batch was needed', mockState.testPlanCalls === 1 && mockState.testBatchCalls === 1, { plan: mockState.testPlanCalls, batches: mockState.testBatchCalls });
  r = await api('GET', '/api/progress/tests_tier113');
  const tierDet = ((r.data && r.data.data && r.data.data.steps) || []).map((s) => s.detail || '').join(' | ');
  check('the report line names the tier cap ("capped at 4 tests")', /PC Performance Tier caps this suite at 4 tests/.test(tierDet), tierDet.slice(0, 220));
  await api('PUT', `/api/connections/${tierConn.id}`, { tier: 'high' });
  r = await api('POST', '/api/playbooks', { playbook: { name: 'Tier Cap Probe B', description: 'Fresh playbook for the uncapped check.', objective: 'Classify the customer by inactivity days.', inputs: [{ id: 'customer', name: 'Customer', type: 'object', required: true, source: 'Run input', example: { name: 'Beta', days_since_activity: 7 } }], steps: [{ id: 'step_01', name: 'Decide', type: 'decision', purpose: 'Classify.', inputs: ['input.customer'], instructions: ['Apply the rules.'], output: { name: 'decision' }, execution: { op: 'decide', subject: 'input.customer' } }], output: { format: 'json', fields: [{ name: 'decision', type: 'string', required: true }] } } });
  const tierPbB = r.data ? r.data.id : null;
  mockState.testPlanCalls = 0;
  mockState.testBatchCalls = 0;
  r = await api('POST', `/api/playbooks/${tierPbB}/tests/generate`, { strategy: 'ai', progress_key: 'tier113b' });
  check('the high tier lets the planner run uncapped again (two batches)', mockState.testPlanCalls === 1 && mockState.testBatchCalls === 2, { plan: mockState.testPlanCalls, batches: mockState.testBatchCalls });
  await api('PUT', `/api/connections/${connId}`, { is_default: true });
  oll113.close();

  // --- Duplicate compiles are refused server-side (a reload must not queue a
  // second pipeline against the same local model).
  const appSrc113 = fs.readFileSync(path.join(ROOT, 'server/app.js'), 'utf8');
  check('a second compile for a running session answers 409 already_running', /already_running/.test(appSrc113) && /progressSnapshot\(pkey\)/.test(appSrc113), '409 guard');

  // --- Reload-proof background task machinery is served.
  r = await api('GET', '/bg-tasks.js');
  check('bg-tasks.js persists the active run and probes the server job', r.status === 200 && /pbai-active-generations/.test(r.data) && /probeTask/.test(r.data) && /reviveTask/.test(r.data) && /bootWatch/.test(r.data), r.status);
  r = await api('GET', '/app.js');
  check('the app shell re-attaches to surviving runs at boot', r.status === 200 && /bootWatch\(\)/.test(r.data), r.status);
  r = await api('GET', '/views/create.js');
  check('the create view probes the server-side job before starting a compile', r.status === 200 && /probeTask/.test(r.data) && /already_running/.test(r.data), r.status);
  r = await api('GET', '/views/connections-local.js');
  check('the local form serves the PC performance tier selector and requirements box', r.status === 200 && /PC performance tier/.test(r.data) && /tier-info/.test(r.data) && /requirements.gpu/.test(r.data) && /requirements.ram/.test(r.data), r.status);

  section('Static UI');
  r = await api('GET', '/');
  check('index.html served', typeof r.data === 'string' && r.data.includes('<'), r.status);
  r = await api('GET', '/shared/graph.js');
  check('shared graph module served to browser', r.status === 200 && String(r.data).includes('layoutGraph'));
  r = await api('GET', '/app.js');
  check('sidebar shows the version from the server and Powered By SiliBlue.in', /app\.meta\.version/.test(r.data) && /Powered By/.test(r.data) && /SiliBlue\.in/.test(r.data), r.status);
  r = await api('GET', '/views/tabs/files.js');
  check('the Files tab is served with the workspace and privacy labels', r.status === 200 && /Playbook Workspace/.test(r.data) && /Local Workspace/.test(r.data) && /Download Playbook Package/.test(r.data), r.status);
} catch (err) {
  failed++;
  results.push(`  ✗ Unexpected error: ${err.stack}`);
}

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
app.server.close();
app.scheduler.stop();
for (const d of [dataDir, ...scratchDirs]) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch { /* a file may still be held open on Windows; the OS cleans its temp folder */ }
}
process.exit(failed ? 1 : 0);
