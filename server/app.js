// Application wiring: services + HTTP API (spec §62) + static web UI.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter, readJsonBody, sendJson, serveStatic, errorBody, HttpError, raw } from './http.js';
import { Store } from './store.js';
import { SecretBox } from './secrets.js';
import { SettingsService } from './settings.js';
import { AIService, ROLES, ROLE_LABELS } from './ai/service.js';
import { ProviderError } from './ai/provider.js';
import './ai/openrouter.js';
import './ai/anthropic.js';
import './ai/local.js';
import { DiscoveryService } from './discovery/discovery.js';
import { PlaybookService } from './playbooks/service.js';
import { compilePlaybook } from './playbooks/compiler.js';
import { playbookMarkdown } from './playbooks/markdown.js';
import { playbookPdf } from './pdf/playbook-pdf.js';
import { qualityGate } from './playbooks/validator.js';
import { STEP_TYPES, FAILURE_STRATEGIES, TRIGGER_TYPES, DEPENDENCY_TYPES, REQUIREMENT_TYPES } from './playbooks/schema.js';
import { customerRiskEvaluator, customerRiskTests, boundaryBugPatch, EXAMPLE_KEY } from './playbooks/examples.js';
import { tierCatalog } from './ai/tiers.js';
import { TestRunner, ENGINE_VERSION } from './testing/runner.js';
import { generateDeterministicTests, generateAITests, mergeTests, normalizeTest, CATEGORIES } from './testing/generator.js';
import { heuristicSuggestions, aiSuggestions } from './testing/repair.js';
import { RunService } from './engine/runs.js';
import { Scheduler } from './engine/scheduler.js';
import { OPERATORS } from './engine/rules.js';
import { WorkspaceService, INPUT_CATEGORIES, STANDARD_DIRS } from './workspace/workspace.js';
import { reporter, snapshot as progressSnapshot } from './progress.js';
import { openFolder as openFolderOnComputer } from '../launcher/lib.js';
import { slugify, nowIso, isPlainObject } from './util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
export const RESPONSE_TYPES = ['clarification_question', 'clarification_complete', 'playbook', 'test_case', 'test_result', 'execution_result', 'repair_suggestion', 'progress', 'error'];

const envelope = (response_type, status, data, meta) => ({ response_type, status, data, ...(meta ? { meta } : {}) });

const BROKEN_KEY = 'customer_risk_evaluator_broken';

function exampleIntent() {
  return {
    title: 'Customer Risk Evaluator',
    goal: 'Classify a customer as at_risk or healthy based on inactivity.',
    subject: 'One customer record',
    rules: ['No activity for 14 or more days = at_risk (inclusive)', 'Fewer than 14 days = healthy', 'Missing activity data = insufficient_data; never inferred'],
    data_sources: ['Run input (customer record from a CRM export or manual request)'],
    inputs: ['customer.name', 'customer.days_since_activity'],
    actions: ['Return a classification with evidence'],
    trigger: { type: 'manual', frequency: '', day: '', time: '', description: 'On demand' },
    output: { format: 'json', destination: 'API response', description: 'customer, decision, reason, rule applied' },
    constraints: ['Never modify CRM records', 'Never contact the customer'],
    tools: [],
    success_criteria: ['14 days is at_risk', 'Identical input gives identical decisions'],
    assumptions: ['days_since_activity is computed upstream in whole days'],
    open_questions: [],
  };
}

export function createApp({ dataDir, host = '127.0.0.1', quiet = false } = {}) {
  const store = new Store(dataDir);
  const settings = new SettingsService(store);
  const secrets = new SecretBox(dataDir);
  const ai = new AIService({ store, settings, secrets });
  const playbooks = new PlaybookService({ store, settings });
  const discovery = new DiscoveryService({ store, settings, ai });
  const tests = new TestRunner({ store, settings, playbooks, ai });
  const runs = new RunService({ store, settings, playbooks, ai });
  const scheduler = new Scheduler({ store, settings, playbooks, runs });
  const loopback = !(host === '0.0.0.0' || host === '::');
  const workspaceLog = [];
  // Every playbook's own folder (workspace spec). Mirrors every change made through the store.
  const workspaces = new WorkspaceService({
    store,
    settings,
    playbooks,
    ai,
    baseDir: process.env.PBAI_WORKSPACES_DIR ? path.resolve(process.env.PBAI_WORKSPACES_DIR) : path.join(dataDir, 'workspaces'),
    appVersion: APP_VERSION,
    // Showing a folder in Explorer/Finder only makes sense for someone sitting at this computer.
    openFolder: loopback ? (dir) => openFolderOnComputer(dir) : null,
    log: (msg) => {
      workspaceLog.push(msg);
      if (workspaceLog.length > 200) workspaceLog.shift();
      if (!quiet) console.warn(msg);
    },
  }).attach();
  const router = createRouter();
  const publicDir = path.join(ROOT, 'public');
  const sharedDir = path.join(ROOT, 'shared');
  const allowAnyHost = host === '0.0.0.0' || host === '::' || process.env.PBAI_ALLOW_ANY_HOST === '1';
  const extraHosts = String(process.env.PBAI_ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);

  const feature = (name, label) => {
    if (!settings.feature(name)) throw new HttpError(403, 'feature_disabled', `${label} is turned off in Settings.`);
  };
  const versionParam = (q) => (q.version === undefined || q.version === '' ? undefined : q.version);

  // ------------------------------------------------------------ meta
  router.get('/api/health', () => ({ ok: true, version: APP_VERSION, time: nowIso() }));
  router.get('/api/meta', () => ({
    version: APP_VERSION,
    engine_version: ENGINE_VERSION,
    node: process.version,
    data_dir: dataDir,
    workspaces_dir: workspaces.baseDir,
    providers: ai.catalog(),
    roles: ROLES.map((r) => ({ id: r, label: ROLE_LABELS[r] })),
    step_types: STEP_TYPES,
    failure_strategies: FAILURE_STRATEGIES,
    trigger_types: TRIGGER_TYPES,
    dependency_types: DEPENDENCY_TYPES,
    requirement_types: REQUIREMENT_TYPES,
    operators: Object.entries(OPERATORS).map(([id, o]) => ({ id, ...o })),
    test_categories: CATEGORIES,
    response_types: RESPONSE_TYPES,
    // PC Performance Tiers for Local LLMs (requirements, trade-offs, caps).
    tiers: tierCatalog(),
  }));

  router.get('/api/dashboard', () => {
    const list = playbooks.list();
    const byStatus = {};
    for (const p of list) byStatus[p.status] = (byStatus[p.status] || 0) + 1;
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const allRuns = runs.list({ limit: 1000 });
    const recentTestRuns = tests.list({ limit: 6 });
    return {
      counts: {
        playbooks: list.length,
        published: list.filter((p) => p.published_versions.length).length,
        in_production: list.filter((p) => p.production_version).length,
        tests_passing: list.filter((p) => p.last_test && p.last_test.status === 'pass' && !p.stale).length,
        tests_failing: list.filter((p) => p.last_test && p.last_test.status === 'fail').length,
        stale: list.filter((p) => p.stale).length,
        runs_7d: allRuns.filter((r) => r.started_at >= weekAgo).length,
        pending_approvals: allRuns.reduce((s, r) => s + r.pending_approvals, 0),
      },
      by_status: byStatus,
      playbooks: list.slice(0, 8),
      runs: allRuns.slice(0, 8),
      test_runs: recentTestRuns,
      ai: ai.status(),
      schedules: scheduler.upcoming().slice(0, 5),
    };
  });

  // ------------------------------------------------------------ settings
  router.get('/api/settings', () => settings.get());
  router.put('/api/settings', ({ body }) => settings.update(body));
  router.post('/api/settings/reset', () => settings.reset());

  // ------------------------------------------------------------ AI connections (§50–51)
  router.get('/api/connections', () => ({ connections: ai.list(), providers: ai.catalog(), roles: ROLES.map((r) => ({ id: r, label: ROLE_LABELS[r] })), status: ai.status() }));
  router.post('/api/connections', ({ body }) => ai.create(body || {}));
  router.put('/api/connections/:id', ({ params, body }) => ai.update(params.id, body || {}));
  router.delete('/api/connections/:id', ({ params }) => {
    ai.remove(params.id);
    return { deleted: true };
  });
  router.post('/api/connections/:id/test', async ({ params, body }) => ai.test(params.id, { model: body && body.model }));
  router.get('/api/connections/:id/models', async ({ params, query }) => {
    const list = await ai.models(params.id, { refresh: query.refresh === '1' || query.refresh === 'true' });
    return { models: list, count: list.length };
  });

  // ---------------------------------------------- local AI (feature spec v2)
  // Detect models on a local server — before the connection is saved (§8).
  router.post('/api/connections/detect', async ({ body }) => ai.detect(body || {}));
  // Test / capability-check a local server before it is saved (§10–§11).
  router.post('/api/connections/test', async ({ body }) => ai.testDraft(body || {}));
  router.post('/api/connections/capabilities', async ({ body }) => ai.capabilitiesDraft({ ...(body || {}), toolsRequired: Boolean(body && body.tools_required) }));
  // Model Compatibility Harness (impl spec §8): before and after the
  // connection is saved. "Connected" is not "compatible for playbook
  // generation" — this runs the six per-model checks and returns a verdict.
  router.post('/api/connections/compat', async ({ body }) => ai.compatDraft(body || {}));
  router.get('/api/connections/:id/compat', async ({ params, query }) => ai.compat(params.id, { model: query.model, refresh: query.refresh === '1' }));
  // Capability check for one model (§10). tools_required comes from a playbook.
  router.get('/api/connections/:id/capabilities', async ({ params, query }) => {
    let toolsRequired = query.tools_required === '1' || query.tools_required === 'true';
    if (query.playbook_id) {
      const rec = playbooks.get(query.playbook_id);
      const ver = playbooks.version(rec, versionParam(query));
      toolsRequired = (ver.playbook.tools || []).length > 0;
    }
    return ai.capabilities(params.id, { model: query.model, toolsRequired, refresh: query.refresh === '1' });
  });
  // Run the built-in Customer Risk Evaluator against this connection (§12–13).
  router.post('/api/connections/:id/builtin-test', async ({ params, body }) => {
    const conn = ai.get(params.id);
    ai.assertAllowed(conn);
    const runs_ = Math.max(1, Math.min(100, Number((body && body.runs) || 1)));
    const model = (body && body.model) || conn.default_model || (conn.models && conn.models.execution) || undefined;
    let rec = store.playbooks.list((r) => r.example_key === EXAMPLE_KEY)[0];
    if (!rec) {
      await seedExamples();
      rec = store.playbooks.list((r) => r.example_key === EXAMPLE_KEY)[0];
    }
    if (!rec) throw new HttpError(404, 'no_example', 'The built-in Customer Risk Evaluator is not available.');
    const suite = playbooks.get(rec.id).suite.tests;
    const test = suite.find((t) => t.category === 'repeatability') || suite.find((t) => t.id === 'tc_01') || suite[0];
    const doc = await tests.start(rec.id, {
      mode: 'ai',
      test_ids: [test.id],
      runs: runs_,
      connection_id: conn.id,
      model,
      ai_evaluation: false,
      trigger: 'connection_check',
      wait: Boolean(body && body.wait),
    });
    return envelope('test_result', doc.status === 'running' ? 'running' : 'complete', { test_run: doc, playbook_id: rec.id, test_id: test.id, model: doc.environment.model });
  });

  // ------------------------------------------------------------ discovery (§27–29)
  router.post('/api/discovery/start', async ({ body }) => discovery.start(body && (body.goal || body.request || body.task)));
  router.get('/api/discovery/:sessionId', ({ params }) => discovery.envelopeFor(discovery.get(params.sessionId)));
  router.post('/api/discovery/:sessionId/answer', async ({ params, body }) => discovery.answer(params.sessionId, body || {}));
  router.post('/api/discovery/:sessionId/intent', ({ params, body }) => discovery.editIntent(params.sessionId, body && body.intent ? body.intent : body));
  router.post('/api/discovery/:sessionId/confirm', ({ params, body }) => discovery.confirm(params.sessionId, body && body.intent));
  router.post('/api/discovery/:sessionId/more', async ({ params }) => discovery.askMore(params.sessionId));

  // ------------------------------------------------------------ compile (§30–31)
  // Live progress (v1.7): the client may pass progress_key; the pipeline then
  // reports every stage so the UI can show real "2 of 4" progress by polling
  // GET /api/progress/:key while the long compile request is in flight.
  router.get('/api/progress/:key', ({ params }) => {
    const snap = progressSnapshot(String(params.key || ''));
    if (!snap) throw new HttpError(404, 'not_found', 'No progress is being tracked for that key (the operation may have finished more than two minutes ago).');
    return envelope('progress', snap.done ? 'complete' : 'running', snap);
  });
  router.post('/api/playbooks/generate', async ({ body }) => {
    feature('playbook_generation', 'Playbook Generation');
    const s = settings.get();
    let session = null;
    let intent = body && isPlainObject(body.intent) ? body.intent : null;
    if (body && body.session_id) {
      session = discovery.get(body.session_id);
      if (!session.intent) throw new HttpError(409, 'intent_missing', 'Discovery has not produced an intent yet.');
      if (s.features.objective_confirmation && s.behavior.require_objective_confirmation && !session.intent_confirmed) {
        throw new HttpError(409, 'intent_not_confirmed', 'Confirm the objective before generating the playbook.');
      }
      intent = session.intent;
    }
    if (!intent) throw new HttpError(400, 'bad_request', 'Provide session_id or intent.');
    const exec = ai.resolve('execution', { connectionId: body.connection_id });
    const pkey = body && typeof body.progress_key === 'string' && body.progress_key.trim() ? `gen_${String(body.progress_key).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}` : null;
    // One compile per session at a time. A page reload wipes the browser's
    // memory of the running task, and the reloaded Create screen would
    // otherwise fire a SECOND compile against the same (local) model while
    // the first is still running — double the load, timeouts everywhere.
    const liveJob = pkey ? progressSnapshot(pkey) : null;
    if (liveJob && !liveJob.done) {
      throw new HttpError(409, 'already_running', 'A playbook for this request is already being generated. Reopen the Create screen to watch it finish — it keeps running in the background.');
    }
    const report = reporter(pkey);
    report.begin([
      { id: 'compile', label: 'Compiling the procedure from your confirmed intent' },
      { id: 'validate', label: 'Validating structure, dependencies and decision rules' },
      { id: 'quality', label: 'Running the quality gate (and repairing gaps)' },
      { id: 'tests', label: 'Generating test cases' },
    ], { session_id: session ? session.id : null });
    let result = null;
    try {
      result = await compilePlaybook(ai, {
        session,
        intent,
        constraints: Array.isArray(body.constraints) ? body.constraints : [],
        tools: Array.isArray(body.tools) ? body.tools : [],
        connectionId: exec.conn.id,
        executionModel: exec.model,
        report,
      });
    } catch (err) {
      report.finish(err);
      throw err;
    }
    const rec = playbooks.create({
      playbook: result.playbook,
      source: 'generated',
      intent,
      session_id: session ? session.id : null,
      generation: { model: result.model, attempts: result.attempts, usage: result.usage, at: nowIso() },
    });
    if (session) discovery.markCompiled(session.id, rec.id);
    let testsGenerated = 0;
    const notes = [];
    if (s.features.automatic_test_generation) {
      report.step('tests', 'active', 'Analysing rules and boundaries for the deterministic suite');
      const ver = playbooks.version(rec, 1);
      const gen = generateDeterministicTests(ver.playbook, { repeatRuns: s.behavior.default_repeatability_runs });
      notes.push(...gen.notes);
      if (gen.tests.length) {
        playbooks.setTests(rec.id, gen.tests);
        testsGenerated = gen.tests.length;
      }
      report.step('tests', 'done', `${testsGenerated} test case${testsGenerated === 1 ? '' : 's'} generated from your rules`);
    } else {
      report.step('tests', 'done', null);
    }
    report.finish();
    const view = playbooks.view(playbooks.get(rec.id));
    return envelope('playbook', 'complete', {
      id: rec.id,
      version: 1,
      playbook: view.playbook,
      quality_gate: result.quality_gate,
      tests_generated: testsGenerated,
      notes,
    }, { usage: result.usage, model: result.model, attempts: result.attempts });
  });

  // ------------------------------------------------------------ playbooks
  router.get('/api/playbooks', ({ query }) => ({ playbooks: playbooks.list({ includeArchived: query.archived === '1' }) }));
  router.post('/api/playbooks', ({ body }) => {
    const pb = body && isPlainObject(body.playbook) ? body.playbook : body;
    if (!isPlainObject(pb) || !Array.isArray(pb.steps)) throw new HttpError(400, 'bad_request', 'Import a playbook JSON object with a steps array.');
    const s = settings.get();
    const importedTests = (Array.isArray(pb.tests) ? pb.tests : []).map((t, i) => normalizeTest(t, i, { repeatRuns: s.behavior.default_repeatability_runs, source: t.source || 'imported' }));
    const rec = playbooks.create({ playbook: { ...pb, tests: [] }, source: 'import', tests: importedTests, change_note: 'Imported from JSON.' });
    return playbooks.view(rec);
  });
  router.get('/api/playbooks/:id', ({ params, query }) => playbooks.view(playbooks.get(params.id), versionParam(query)));
  router.put('/api/playbooks/:id', ({ params, body }) => {
    if (!body || !isPlainObject(body.playbook)) throw new HttpError(400, 'bad_request', 'Body must contain a playbook object.');
    const r = playbooks.update(params.id, { playbook: body.playbook, change_note: body.change_note, baseVersion: body.base_version });
    return { ...playbooks.view(r.record, r.version), saved: { version: r.version, created_new_version: r.created, changed: r.changed } };
  });
  router.patch('/api/playbooks/:id', ({ params, body }) => {
    let r = null;
    if (body && body.name) r = playbooks.rename(params.id, body.name);
    if (body && isPlainObject(body.configuration)) r = playbooks.setConfiguration(params.id, body.configuration, { change_note: body.change_note });
    if (body && isPlainObject(body.schedule)) {
      if (body.schedule.enabled && !settings.feature('scheduled_playbooks')) throw new HttpError(403, 'feature_disabled', 'Scheduled Playbooks is turned off in Settings.');
      playbooks.setSchedule(params.id, body.schedule);
    }
    if (body && typeof body.archived === 'boolean') playbooks.archive(params.id, body.archived);
    const rec = playbooks.get(params.id);
    return { ...playbooks.view(rec, r ? r.version : undefined), ...(r ? { saved: { version: r.version, created_new_version: r.created, changed: r.changed } } : {}) };
  });
  router.post('/api/playbooks/:id/patch', ({ params, body }) => {
    const r = playbooks.patch(params.id, body && body.ops, { change_note: body && body.change_note, baseVersion: body && body.base_version });
    return { ...playbooks.view(r.record, r.version), saved: { version: r.version, created_new_version: r.created, changed: r.changed } };
  });
  router.delete('/api/playbooks/:id', ({ params }) => {
    playbooks.remove(params.id);
    return { deleted: true };
  });
  router.post('/api/playbooks/:id/duplicate', async ({ params }) => {
    const copy = playbooks.duplicate(params.id);
    // The copy gets its own folder with the same playbook, intent, tests and input files.
    await workspaces.copyInputs(params.id, copy.id);
    return playbooks.view(playbooks.get(copy.id));
  });
  router.post('/api/playbooks/:id/restore', ({ params, body }) => {
    const v = playbooks.restore(params.id, body && body.version);
    return playbooks.view(playbooks.get(params.id), v);
  });
  router.post('/api/playbooks/:id/publish', ({ params, body }) => {
    const v = playbooks.publish(params.id, body && body.version !== undefined ? body.version : undefined, { acknowledge_warnings: Boolean(body && body.acknowledge_warnings) });
    return playbooks.view(playbooks.get(params.id), v);
  });
  router.post('/api/playbooks/:id/promote', ({ params, body }) => {
    const v = playbooks.promote(params.id, body && body.version);
    return playbooks.view(playbooks.get(params.id), v);
  });
  router.get('/api/playbooks/:id/quality-gate', ({ params, query }) => {
    const rec = playbooks.get(params.id);
    return qualityGate(playbooks.version(rec, versionParam(query)).playbook);
  });
  router.get('/api/playbooks/:id/compare', ({ params, query }) => playbooks.compare(params.id, query.a, query.b));

  // ------------------------------------------------------------ exports (§33–36)
  const exportContext = (rec, v) => playbooks.exportContext(rec, v);
  const fileName = (pb, ext) => `${slugify(pb.name)}-v${pb.version}.${ext}`;
  router.get('/api/playbooks/:id/markdown', ({ params, query }) => {
    feature('markdown_export', 'Markdown Export');
    const ctx = exportContext(playbooks.get(params.id), versionParam(query));
    const md = playbookMarkdown(ctx.pb, ctx);
    const headers = query.download ? { 'Content-Disposition': `attachment; filename="${fileName(ctx.pb, 'md')}"` } : {};
    return raw(md, { contentType: 'text/markdown; charset=utf-8', headers });
  });
  router.get('/api/playbooks/:id/pdf', ({ params, query }) => {
    feature('pdf_export', 'PDF Export');
    const ctx = exportContext(playbooks.get(params.id), versionParam(query));
    const buf = playbookPdf(ctx.pb, ctx);
    const disposition = query.download ? 'attachment' : 'inline';
    return raw(buf, { contentType: 'application/pdf', headers: { 'Content-Disposition': `${disposition}; filename="${fileName(ctx.pb, 'pdf')}"` } });
  });
  router.get('/api/playbooks/:id/json', ({ params, query }) => {
    feature('json_export', 'JSON Export');
    const rec = playbooks.get(params.id);
    const pb = playbooks.exportJson(rec, versionParam(query));
    const headers = query.download ? { 'Content-Disposition': `attachment; filename="${fileName(pb, 'json')}"` } : {};
    return raw(JSON.stringify(pb, null, 2), { contentType: 'application/json; charset=utf-8', headers });
  });

  // ------------------------------------------------------------ playbook workspaces
  const privacyInfo = (rec) => {
    const ver = playbooks.version(rec, rec.current_version);
    const s = settings.get();
    return { privacy_mode: s.ai.privacy_mode, local_workspace: true, ai: workspaces.aiTransport(ver.playbook) };
  };
  const PREVIEW_TYPES = {
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.tsv': 'text/tab-separated-values; charset=utf-8',
    '.log': 'text/plain; charset=utf-8',
    '.yaml': 'text/plain; charset=utf-8',
    '.yml': 'text/plain; charset=utf-8',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  const disposition = (kind, name) => {
    const ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  };

  router.get('/api/playbooks/:id/workspace', async ({ params }) => {
    const tree = await workspaces.tree(params.id);
    const rec = playbooks.get(params.id);
    return { ...tree, ...privacyInfo(rec), input_categories: INPUT_CATEGORIES, standard_dirs: STANDARD_DIRS, can_open_folder: loopback };
  });
  router.get('/api/playbooks/:id/workspace/file', async ({ params, query }) => {
    await workspaces.idle(params.id);
    const f = workspaces.fileInfo(params.id, query.path);
    const ext = path.extname(f.name).toLowerCase();
    const type = PREVIEW_TYPES[ext];
    const download = query.download === '1' || !type;
    const headers = {
      'Content-Disposition': disposition(download ? 'attachment' : 'inline', f.name),
      'X-Content-Type-Options': 'nosniff',
    };
    // Files may come from anywhere: never let one run scripts in this app.
    if (!['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) headers['Content-Security-Policy'] = "sandbox; default-src 'none'";
    return raw(fs.readFileSync(f.full), { contentType: download ? type || 'application/octet-stream' : type, headers });
  });
  router.get('/api/playbooks/:id/workspace/inputs', async ({ params }) => {
    await workspaces.idle(params.id);
    return { files: workspaces.inputFiles(params.id), categories: INPUT_CATEGORIES };
  });
  router.post('/api/playbooks/:id/workspace/upload', async ({ params, body }) => workspaces.upload(params.id, body || {}), { bodyLimit: 30 * 1024 * 1024 });
  router.post('/api/playbooks/:id/workspace/rename', async ({ params, body }) => workspaces.renamePath(params.id, body || {}));
  router.post('/api/playbooks/:id/workspace/delete', async ({ params, body }) => workspaces.deletePath(params.id, body || {}));
  router.post('/api/playbooks/:id/workspace/duplicate', async ({ params, body }) => workspaces.duplicatePath(params.id, body || {}));
  router.post('/api/playbooks/:id/workspace/sync', async ({ params }) => {
    playbooks.get(params.id);
    await workspaces.run(params.id, () => workspaces.syncNow(params.id));
    return workspaces.tree(params.id);
  });
  router.post('/api/playbooks/:id/workspace/open', async ({ params }) => {
    playbooks.get(params.id);
    if (!loopback) throw new HttpError(403, 'not_local', 'Folders can only be opened on the computer that runs Playbook Builder.');
    return workspaces.openFolder(params.id);
  });
  router.get('/api/playbooks/:id/package', async ({ params }) => {
    playbooks.get(params.id);
    const pkg = await workspaces.package(params.id);
    return raw(pkg.buffer, { contentType: 'application/zip', headers: { 'Content-Disposition': disposition('attachment', pkg.filename) } });
  });
  router.post(
    '/api/playbooks/import',
    async ({ body }) => {
      if (!body || typeof body.content_base64 !== 'string') throw new HttpError(400, 'bad_request', 'Send { filename, content_base64 } with a .zip package or a .playbook.json file.');
      const filename = String(body.filename || 'playbook');
      const parsed = workspaces.parseImport(Buffer.from(body.content_base64, 'base64'), filename);
      const s = settings.get();
      const tests = parsed.tests.map((t, i) => normalizeTest(t, i, { repeatRuns: s.behavior.default_repeatability_runs, source: t.source || 'imported' }));
      // Imported playbooks start as drafts. Nothing is run and no tool is called.
      const rec = playbooks.create({ playbook: parsed.pb, source: 'import', intent: parsed.intent, tests, change_note: `Imported from ${filename}.` });
      await workspaces.writeImportedInputs(rec.id, parsed.inputs, { filename });
      const fresh = playbooks.get(rec.id);
      return {
        playbook_id: rec.id,
        name: fresh.name,
        folder: fresh.workspace ? fresh.workspace.folder : null,
        imported: ['playbook definition', ...(parsed.intent ? ['confirmed intent'] : []), `${tests.length} test case${tests.length === 1 ? '' : 's'}`, ...(parsed.inputs.length ? [`${parsed.inputs.length} input file${parsed.inputs.length === 1 ? '' : 's'}`] : [])],
        skipped: parsed.skipped.map((d) => `${d}/ (history and exports stay with the original workspace)`),
        warnings: parsed.warnings,
        executed: false,
        playbook: playbooks.view(fresh),
      };
    },
    { bodyLimit: 80 * 1024 * 1024 },
  );
  router.get('/api/workspaces', () => ({ root: workspaces.baseDir, count: playbooks.list({ includeArchived: true }).length, privacy_mode: settings.get().ai.privacy_mode, can_open_folder: loopback }));
  router.post('/api/workspaces/open', async () => {
    if (!loopback) throw new HttpError(403, 'not_local', 'Folders can only be opened on the computer that runs Playbook Builder.');
    return workspaces.openFolder(null);
  });

  // ------------------------------------------------------------ test suite
  router.get('/api/playbooks/:id/tests', ({ params }) => {
    const rec = playbooks.get(params.id);
    return { tests: rec.suite.tests, revision: rec.suite.revision, updated_at: rec.suite.updated_at };
  });
  router.post('/api/playbooks/:id/tests', ({ params, body }) => {
    const rec = playbooks.get(params.id);
    const s = settings.get();
    const t = normalizeTest(body && body.test ? body.test : body, rec.suite.tests.length, { repeatRuns: s.behavior.default_repeatability_runs, source: 'manual' });
    const merged = mergeTests(rec.suite.tests, [{ ...t, id: '' }]);
    if (!merged.added.length) throw new HttpError(409, 'duplicate_test', 'An identical test already exists.');
    playbooks.setTests(rec.id, merged.tests);
    return { test: merged.added[0], tests: merged.tests };
  });
  router.put('/api/playbooks/:id/tests/:testId', ({ params, body }) => {
    const s = settings.get();
    const t = normalizeTest({ ...(body && body.test ? body.test : body), id: params.testId }, 0, { repeatRuns: s.behavior.default_repeatability_runs, source: 'manual' });
    const rec = playbooks.updateTest(params.id, params.testId, t);
    return { test: t, tests: rec.suite.tests };
  });
  router.delete('/api/playbooks/:id/tests/:testId', ({ params }) => ({ tests: playbooks.deleteTest(params.id, params.testId).suite.tests }));
  router.post('/api/playbooks/:id/tests/generate', async ({ params, body }) => {
    feature('automatic_test_generation', 'Automatic Test Generation');
    const s = settings.get();
    const rec = playbooks.get(params.id);
    const ver = playbooks.version(rec, body && body.version);
    const strategy = (body && body.strategy) || 'deterministic';
    const repeatRuns = s.behavior.default_repeatability_runs;
    // AI generation now runs in small batches (v1.7). When the client asks
    // for it, every batch is reported to the progress registry so the UI can
    // show "Batch 2 of 5" instead of a silent spinner.
    const pkey = body && typeof body.progress_key === 'string' && body.progress_key.trim() ? `tests_${String(body.progress_key).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}` : null;
    const report = reporter(pkey);
    if (strategy === 'ai' || strategy === 'both') {
      report.begin([
        { id: 'plan', label: 'Planning the test suite' },
        { id: 'tests', label: 'Writing test cases with the testing model' },
      ], { playbook_id: rec.id });
    }
    let incoming = [];
    const notes = [];
    let usage = null;
    let model = null;
    if (strategy === 'deterministic' || strategy === 'both') {
      const gen = generateDeterministicTests(ver.playbook, { repeatRuns });
      incoming = incoming.concat(gen.tests);
      notes.push(...gen.notes);
    }
    if (strategy === 'ai' || strategy === 'both') {
      try {
        // The connection's PC Performance Tier caps the suite on weak local
        // hardware (Low = 4, Mid = 8, High End = 16; null = uncapped).
        const maxTests = ai.tierTestCapFor('testing');
        const gen = await generateAITests(ai, ver.playbook, { intent: rec.intent, repeatRuns, existing: rec.suite.tests, report, maxTests });
        incoming = incoming.concat(gen.tests);
        usage = gen.usage;
        model = gen.model;
        notes.push(...(gen.notes || []));
        report.finish();
      } catch (err) {
        report.finish(err);
        throw err;
      }
    }
    const base = body && body.replace ? [] : rec.suite.tests;
    const merged = mergeTests(base, incoming.map((t) => ({ ...t, id: '' })));
    playbooks.setTests(rec.id, merged.tests);
    return envelope('test_case', 'complete', { added: merged.added, tests: merged.tests, notes, strategy }, usage ? { usage, model } : undefined);
  });
  router.post('/api/playbooks/:id/tests/restore-builtin', ({ params }) => {
    const rec = playbooks.get(params.id);
    if (!rec.example_key) throw new HttpError(400, 'not_example', 'Only built-in examples have a built-in test suite.');
    const suite = customerRiskTests(settings.get().behavior.default_repeatability_runs);
    playbooks.setTests(rec.id, suite);
    return { tests: suite };
  });

  // ------------------------------------------------------------ test runs (§37–47)
  router.post('/api/playbooks/:id/test', async ({ params, body }) => {
    const doc = await tests.start(params.id, { ...(body || {}), trigger: 'manual' });
    return envelope('test_result', doc.status === 'running' ? 'running' : 'complete', { test_run: doc });
  });
  router.get('/api/playbooks/:id/test-runs', ({ params }) => ({ test_runs: tests.list({ playbookId: params.id }) }));
  router.get('/api/test-runs', ({ query }) => ({ test_runs: tests.list({ playbookId: query.playbook_id, limit: Number(query.limit) || 100 }) }));
  router.get('/api/test-runs/:id', ({ params }) => {
    const doc = tests.get(params.id);
    return envelope('test_result', doc.status === 'running' ? 'running' : 'complete', { test_run: { ...doc, stale: tests.isStale(doc) } });
  });
  router.post('/api/test-runs/:id/cancel', ({ params }) => envelope('test_result', 'cancelling', { test_run: tests.cancel(params.id) }));

  // ------------------------------------------------------------ repair (§48)
  router.post('/api/playbooks/:id/repair', async ({ params, body }) => {
    const rec = playbooks.get(params.id);
    const run = tests.get(body && body.test_run_id);
    if (run.playbook_id !== rec.id) throw new HttpError(400, 'bad_request', 'That test run belongs to another playbook.');
    const ver = playbooks.version(rec, run.version);
    let suggestions = await heuristicSuggestions(ver.playbook, run, rec.suite.tests);
    let usage = null;
    if (body && body.use_ai) {
      const r = await aiSuggestions(ai, ver.playbook, run, rec.suite.tests);
      suggestions = suggestions.concat(r.suggestions);
      usage = r.usage;
    }
    const doc = tests.get(run.id);
    const keep = (doc.repair_suggestions || []).filter((s) => s.status !== 'proposed');
    doc.repair_suggestions = keep.concat(suggestions);
    store.testRuns.put(doc);
    return envelope('repair_suggestion', 'complete', { suggestions, test_run_id: run.id, version: ver.version }, usage ? { usage } : undefined);
  });
  router.post('/api/playbooks/:id/repair/apply', async ({ params, body }) => {
    const rec = playbooks.get(params.id);
    const run = tests.get(body && body.test_run_id);
    const sug = (run.repair_suggestions || []).find((s) => s.id === (body && body.suggestion_id));
    if (!sug) throw new HttpError(404, 'not_found', 'Suggestion not found.');
    if (sug.status === 'applied') throw new HttpError(409, 'already_applied', 'This suggestion was already applied.');
    const r = playbooks.patch(rec.id, sug.patch, { change_note: `Repair: ${sug.fix_summary || sug.problem} (approved from test run ${run.id}).`, source: 'repair', baseVersion: run.version });
    const doc = tests.get(run.id);
    const s = doc.repair_suggestions.find((x) => x.id === sug.id);
    s.status = 'applied';
    s.applied_at = nowIso();
    s.applied_version = r.version;
    store.testRuns.put(doc);
    let retest = null;
    if (body && body.retest !== false) retest = await tests.start(rec.id, { version: r.version, mode: 'deterministic', trigger: 'repair', wait: true });
    return { ...playbooks.view(playbooks.get(rec.id), r.version), applied: { suggestion_id: sug.id, version: r.version }, retest };
  });

  // Demo: introduce the boundary bug (§42) as a new version of an example.
  router.post('/api/playbooks/:id/demo/break', async ({ params }) => {
    const rec = playbooks.get(params.id);
    if (!rec.example_key) throw new HttpError(400, 'not_example', 'The boundary-bug demo is only available on the built-in examples.');
    const cur = playbooks.version(rec, rec.current_version);
    const patch = boundaryBugPatch(cur.playbook);
    if (!patch) throw new HttpError(409, 'cannot_break', 'rule_01 was not found in this version.');
    const r = playbooks.patch(rec.id, patch, { change_note: 'Demo edit: rule_01 changed from >= to > (boundary bug).', source: 'edit' });
    return playbooks.view(r.record, r.version);
  });

  // ------------------------------------------------------------ runs (§61)
  router.post('/api/playbooks/:id/run', async ({ params, body }) => {
    const b = { ...(body || {}) };
    delete b.input_source;
    if (b.input_file) {
      // Input from this playbook's workspace. Production runs may only read inputs/runtime.
      const rec = playbooks.get(params.id);
      const ver = b.version !== undefined && b.version !== null && b.version !== '' ? playbooks.version(rec, b.version) : playbooks.runnableVersion(rec);
      const published = ['published', 'production'].includes(ver.status);
      const environment = b.environment === 'production' ? 'production' : b.environment === 'sandbox' ? 'sandbox' : published ? 'production' : 'sandbox';
      await workspaces.idle(params.id);
      const file = workspaces.readRunInput(params.id, b.input_file, { environment, pb: ver.playbook });
      b.input = file.input;
      b.input_source = file.source;
    }
    const run = await runs.start(params.id, { ...b, trigger: b.trigger || 'manual' });
    return envelope('execution_result', run.status === 'running' ? 'running' : run.status === 'completed' ? 'complete' : run.status, { run });
  });
  router.get('/api/playbooks/:id/runs', ({ params }) => ({ runs: runs.list({ playbookId: params.id }) }));
  router.get('/api/runs', ({ query }) => ({ runs: runs.list({ playbookId: query.playbook_id, status: query.status, limit: Number(query.limit) || 100 }) }));
  router.get('/api/runs/:id', ({ params }) => {
    const r = runs.view(runs.get(params.id));
    return envelope('execution_result', r.status === 'running' ? 'running' : r.status === 'completed' ? 'complete' : r.status, { run: r });
  });
  router.post('/api/runs/:id/approvals/:approvalId', async ({ params, body }) => {
    const r = await runs.decide(params.id, params.approvalId, body || {});
    return envelope('execution_result', r.status === 'completed' ? 'complete' : r.status, { run: r });
  });
  router.post('/api/runs/:id/cancel', ({ params }) => envelope('execution_result', 'cancelled', { run: runs.cancel(params.id) }));
  router.get('/api/schedules', () => ({ enabled: settings.feature('scheduled_playbooks'), upcoming: scheduler.upcoming() }));

  // Webhook trigger: POST body becomes the run input; runs the production version.
  router.post('/api/hooks/:id/:token', async ({ params, body }) => {
    const rec = playbooks.get(params.id);
    if (params.token !== rec.webhook_token) throw new HttpError(403, 'invalid_token', 'Invalid webhook token.');
    const ver = playbooks.runnableVersion(rec);
    if (!['published', 'production'].includes(ver.status)) throw new HttpError(409, 'not_published', 'Publish the playbook before triggering it by webhook.');
    const run = await runs.start(rec.id, { version: ver.version, input: isPlainObject(body) ? body : {}, trigger: 'webhook', environment: 'production', wait: true });
    return envelope('execution_result', run.status === 'completed' ? 'complete' : run.status, { run });
  });

  // ------------------------------------------------------------ examples
  async function seedExamples() {
    const repeatRuns = settings.get().behavior.default_repeatability_runs;
    for (const rec of store.playbooks.list((r) => r.example_key === EXAMPLE_KEY || r.example_key === BROKEN_KEY)) store.playbooks.delete(rec.id);
    const good = playbooks.create({ playbook: customerRiskEvaluator(), source: 'example', example_key: EXAMPLE_KEY, intent: exampleIntent(), tests: customerRiskTests(repeatRuns), change_note: 'Built-in executable example.' });
    await tests.start(good.id, { mode: 'deterministic', wait: true, trigger: 'seed' });

    const brokenBase = customerRiskEvaluator();
    brokenBase.name = 'Customer Risk Evaluator — Broken Rule Demo';
    brokenBase.description = 'Failure-detection demo: v1 uses the correct inclusive rule (>=); v2 changes it to > and the Test Center catches the boundary bug.';
    const broken = playbooks.create({ playbook: brokenBase, source: 'example', example_key: BROKEN_KEY, intent: exampleIntent(), tests: customerRiskTests(repeatRuns), change_note: 'v1: correct inclusive rule (>=).' });
    await tests.start(broken.id, { mode: 'deterministic', wait: true, trigger: 'seed' });
    const v1 = playbooks.version(playbooks.get(broken.id), 1);
    playbooks.patch(broken.id, boundaryBugPatch(v1.playbook), { change_note: 'Demo edit: rule_01 changed from >= to > (boundary bug).', source: 'edit' });
    await tests.start(broken.id, { mode: 'deterministic', wait: true, trigger: 'seed' });
    fs.writeFileSync(path.join(dataDir, '.seeded'), nowIso());
    return { good: good.id, broken: broken.id };
  }
  router.post('/api/examples/reset', async () => seedExamples());

  // ------------------------------------------------------------ HTTP handling
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1', ...extraHosts]);
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const hostname = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    if (!allowAnyHost && hostname && !localHosts.has(hostname)) {
      sendJson(res, 403, errorBody(new HttpError(403, 'host_not_allowed', 'Requests must come from localhost.')));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.headers.origin) {
        let originHost = '';
        try {
          originHost = new URL(req.headers.origin).host.toLowerCase();
        } catch { /* invalid */ }
        if (originHost !== String(req.headers.host || '').toLowerCase()) {
          sendJson(res, 403, errorBody(new HttpError(403, 'cross_origin', 'Cross-origin requests are not allowed.')));
          return;
        }
      }
      const m = router.match(req.method, url.pathname);
      if (!m) return sendJson(res, 404, errorBody(new HttpError(404, 'not_found', `No API route for ${url.pathname}.`)));
      if (m.methodNotAllowed) return sendJson(res, 405, errorBody(new HttpError(405, 'method_not_allowed', `${req.method} is not allowed on ${url.pathname}.`)));
      try {
        const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readJsonBody(req, m.bodyLimit) : {};
        const query = Object.fromEntries(url.searchParams.entries());
        const result = await m.handler({ req, res, params: m.params, query, body });
        if (result && result.__raw) {
          res.writeHead(result.status, { 'Cache-Control': 'no-store', ...result.headers });
          res.end(result.body);
        } else sendJson(res, 200, result === undefined ? { ok: true } : result);
      } catch (err) {
        let status = err instanceof HttpError ? err.status : err.status || 500;
        if (err instanceof ProviderError) status = err.code === 'INVALID_AI_RESPONSE' ? 502 : err.status === 401 || err.status === 403 ? 502 : 502;
        if (status >= 500 && !(err instanceof ProviderError) && !quiet) console.error(err);
        const body = errorBody(err);
        if (err instanceof ProviderError) body.error.provider_error = true;
        sendJson(res, status, body);
      }
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end();
      return;
    }
    if (url.pathname.startsWith('/shared/') && serveStatic(req, res, sharedDir, url.pathname.slice('/shared'.length))) return;
    if (url.pathname !== '/' && serveStatic(req, res, publicDir, url.pathname)) return;
    serveStatic(req, res, publicDir, '/index.html');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!quiet) console.error(err);
      if (!res.headersSent) sendJson(res, 500, errorBody(err));
    });
  });

  async function init() {
    if (!fs.existsSync(path.join(dataDir, '.seeded'))) await seedExamples();
    // Crash recovery: anything still "running" when the process died can never
    // finish. Mark it interrupted so restarts do not show phantom active runs
    // or versions locked in "testing". Runs paused for approval keep waiting —
    // a person can still decide them after the restart.
    for (const r of store.runs.list((d) => d.status === 'running')) {
      const doc = store.runs.get(r.id);
      doc.status = 'failed';
      doc.error = { code: 'INTERRUPTED', message: 'The server was stopped or restarted while this run was executing.' };
      runs.finish(doc);
      store.runs.put(doc);
    }
    for (const d of store.testRuns.list((x) => x.status === 'running')) {
      const doc = store.testRuns.get(d.id);
      doc.status = 'error';
      doc.error = { code: 'INTERRUPTED', message: 'The server was stopped or restarted while this test run was executing.' };
      doc.ended_at = nowIso();
      doc.duration_ms = doc.started_at ? Date.parse(doc.ended_at) - Date.parse(doc.started_at) : null;
      store.testRuns.put(doc);
      try {
        playbooks.recordTestRun(doc.playbook_id, doc.version, doc);
      } catch { /* playbook removed */ }
    }
    // Create missing workspaces and file away runs recorded before this version.
    workspaces.ensureAll();
  }

  return { server, store, settings, ai, playbooks, discovery, tests, runs, scheduler, workspaces, workspaceLog, init, seedExamples };
}
