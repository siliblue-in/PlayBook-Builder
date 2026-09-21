// Playbook records: versions, lifecycle (Draft → Testing → Passed → Published →
// Production, spec §49), the test suite artifact, staleness for regression
// testing (§47) and exports of the canonical JSON (§35).
import crypto from 'node:crypto';
import { HttpError } from '../http.js';
import { deepClone, newId, nowIso, isPlainObject, stableStringify } from '../util.js';
import { normalizePlaybook, procedureHash } from './schema.js';
import { normalizeTest } from '../testing/generator.js';
import { qualityGate } from './validator.js';
import { applyPatch, validatePatch, diff } from './patch.js';

export const LIFECYCLE = ['draft', 'testing', 'passed', 'published', 'production'];
const IMMUTABLE = new Set(['published', 'production']);

function gateSummary(pb) {
  const g = qualityGate(pb);
  return {
    passed: g.passed,
    failed_checks: g.checks.filter((c) => !c.passed).map((c) => ({ id: c.id, label: c.label, details: c.details })),
    warnings: g.warnings.length,
    stats: g.stats,
  };
}

export class PlaybookService {
  constructor({ store, settings }) {
    this.store = store;
    this.settings = settings;
  }

  // ------------------------------------------------------------ records

  get(id) {
    const rec = this.store.playbooks.get(id);
    if (!rec || rec.deleted) throw new HttpError(404, 'not_found', 'Playbook not found.');
    return rec;
  }

  save(rec) {
    rec.updated_at = nowIso();
    const cur = rec.versions.find((v) => v.version === rec.current_version);
    if (cur) rec.name = cur.playbook.name;
    return this.store.playbooks.put(rec);
  }

  version(rec, v) {
    const n = v === undefined || v === null || v === '' || v === 'current' ? rec.current_version : v === 'production' ? rec.production_version : Number(v);
    const ver = rec.versions.find((x) => x.version === n);
    if (!ver) throw new HttpError(404, 'not_found', `Version ${v} not found.`);
    return ver;
  }

  create({ playbook, source = 'generated', intent = null, session_id = null, tests = [], change_note = '', example_key = null, generation = null }) {
    const id = newId('pb');
    const pb = normalizePlaybook(playbook, { id, version: 1 });
    const suiteTests = (tests && tests.length ? tests : pb.tests || []).map((t) => deepClone(t));
    pb.tests = [];
    const now = nowIso();
    const rec = {
      id,
      name: pb.name,
      created_at: now,
      updated_at: now,
      example_key,
      session_id,
      intent,
      generation,
      current_version: 1,
      production_version: null,
      suite: { revision: 1, updated_at: now, tests: suiteTests },
      schedule: { enabled: false, input: null, last_run_at: null },
      webhook_token: crypto.randomBytes(18).toString('base64url'),
      versions: [
        {
          version: 1,
          status: 'draft',
          revision: 1,
          hash: procedureHash(pb),
          playbook: pb,
          source,
          change_note: change_note || (source === 'generated' ? 'Generated from confirmed intent.' : ''),
          parent_version: null,
          created_at: now,
          updated_at: now,
          quality_gate: gateSummary(pb),
          last_test: null,
          test_history: [],
        },
      ],
    };
    return this.save(rec);
  }

  list({ includeArchived = false } = {}) {
    return this.store.playbooks
      .list((r) => !r.deleted && (includeArchived || !r.archived))
      .map((r) => this.summary(r))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  summary(rec) {
    const cur = rec.versions.find((v) => v.version === rec.current_version) || rec.versions[rec.versions.length - 1];
    const st = this.staleness(rec, cur);
    return {
      id: rec.id,
      name: rec.name,
      description: cur.playbook.description,
      objective: cur.playbook.objective,
      example_key: rec.example_key || null,
      archived: Boolean(rec.archived),
      current_version: rec.current_version,
      production_version: rec.production_version,
      published_versions: rec.versions.filter((v) => IMMUTABLE.has(v.status)).map((v) => v.version),
      status: cur.status,
      quality_gate_passed: cur.quality_gate.passed,
      last_test: cur.last_test ? { status: cur.last_test.status, mode: cur.last_test.mode, at: cur.last_test.at, metrics: cur.last_test.metrics, counts: cur.last_test.counts, test_run_id: cur.last_test.test_run_id } : null,
      stale: st.stale,
      stale_reason: st.reason,
      steps: cur.playbook.steps.length,
      tests: rec.suite.tests.length,
      trigger: cur.playbook.trigger.type,
      model: cur.playbook.ai.model,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
    };
  }

  staleness(rec, ver) {
    const lt = ver.last_test;
    if (!lt) {
      // A new version of a playbook whose earlier version was tested: tests are stale (§47).
      const prev = this.previousTested(rec, ver);
      if (prev) return { stale: true, never_tested: true, reason: 'playbook_changed', since_version: prev.version, last_test: prev.last_test };
      return { stale: false, never_tested: true, reason: 'never_tested' };
    }
    if (lt.hash !== ver.hash) return { stale: true, reason: 'playbook_changed', last_test: lt };
    if (lt.suite_revision !== rec.suite.revision) return { stale: true, reason: 'suite_changed', last_test: lt };
    return { stale: false, reason: null, last_test: lt };
  }

  /** Previous version that has test results (for regression comparison). */
  previousTested(rec, ver) {
    return rec.versions
      .filter((v) => v.version < ver.version && v.last_test)
      .sort((a, b) => b.version - a.version)[0] || null;
  }

  /** Full API view of one version. */
  view(rec, v) {
    const ver = this.version(rec, v);
    const st = this.staleness(rec, ver);
    const settings = this.settings.get();
    const prev = this.previousTested(rec, ver);
    return {
      id: rec.id,
      name: ver.playbook.name,
      example_key: rec.example_key || null,
      archived: Boolean(rec.archived),
      current_version: rec.current_version,
      production_version: rec.production_version,
      intent: rec.intent,
      generation: rec.generation || null,
      workspace: rec.workspace ? { folder: rec.workspace.folder, created_at: rec.workspace.created_at } : null,
      schedule: rec.schedule,
      webhook_path: `/api/hooks/${rec.id}/${rec.webhook_token}`,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
      version: {
        version: ver.version,
        status: ver.status,
        revision: ver.revision,
        hash: ver.hash,
        source: ver.source,
        change_note: ver.change_note,
        parent_version: ver.parent_version,
        created_at: ver.created_at,
        updated_at: ver.updated_at,
        published_at: ver.published_at || null,
        immutable: IMMUTABLE.has(ver.status),
        editable: !IMMUTABLE.has(ver.status),
        quality_gate: ver.quality_gate,
        last_test: ver.last_test,
        test_history: ver.test_history,
      },
      stale: settings.features.regression_testing ? st : { stale: false, reason: null, last_test: st.last_test },
      regression: prev && settings.features.regression_testing ? { compare_with: prev.version, last_test: prev.last_test } : null,
      playbook: this.exportJson(rec, ver.version),
      suite: { revision: rec.suite.revision, updated_at: rec.suite.updated_at, count: rec.suite.tests.length },
      versions: rec.versions
        .slice()
        .sort((a, b) => b.version - a.version)
        .map((x) => ({
          version: x.version,
          status: x.status,
          source: x.source,
          change_note: x.change_note,
          created_at: x.created_at,
          published_at: x.published_at || null,
          hash: x.hash,
          quality_gate_passed: x.quality_gate.passed,
          last_test: x.last_test ? { status: x.last_test.status, mode: x.last_test.mode, at: x.last_test.at, metrics: x.last_test.metrics, counts: x.last_test.counts, test_run_id: x.last_test.test_run_id, stale: x.last_test.hash !== x.hash } : null,
        })),
      publish_check: this.publishCheck(rec, ver),
    };
  }

  /** Canonical playbook JSON for a version, with the test suite embedded. */
  exportJson(rec, v) {
    const ver = this.version(rec, v);
    const pb = deepClone(ver.playbook);
    pb.id = rec.id;
    pb.version = ver.version;
    pb.tests = deepClone(IMMUTABLE.has(ver.status) && ver.tests_snapshot ? ver.tests_snapshot : rec.suite.tests);
    pb.status = ver.status;
    pb.metadata = {
      hash: ver.hash,
      created_at: ver.created_at,
      updated_at: ver.updated_at,
      published_at: ver.published_at || null,
      quality_gate_passed: ver.quality_gate.passed,
      last_test: ver.last_test
        ? { status: ver.last_test.status, mode: ver.last_test.mode, at: ver.last_test.at, metrics: ver.last_test.metrics, stale: ver.last_test.hash !== ver.hash }
        : null,
    };
    return pb;
  }

  /** Everything the Markdown and PDF generators need for one version. */
  exportContext(rec, v) {
    const ver = this.version(rec, v);
    const pb = this.exportJson(rec, ver.version);
    const view = this.view(rec, ver.version);
    const lastRun = ver.last_test ? this.store.testRuns.get(ver.last_test.test_run_id) : ver.test_history && ver.test_history[0] ? this.store.testRuns.get(ver.test_history[0]) : null;
    return { pb, versions: view.versions, lastRun, stale: view.stale };
  }

  // ------------------------------------------------------------ editing

  /**
   * Save an edited playbook. Untested drafts are edited in place; tested or
   * published versions are never modified — the edit becomes a new version.
   */
  update(id, { playbook, change_note = '', source = 'edit', baseVersion } = {}) {
    const rec = this.get(id);
    const base = this.version(rec, baseVersion ?? rec.current_version);
    if (!isPlainObject(playbook)) throw new HttpError(400, 'bad_request', 'playbook must be a JSON object.');
    // Tests embedded in an edited export replace the suite only when they differ.
    let incomingTests = Array.isArray(playbook.tests) && playbook.tests.length ? playbook.tests.map((t, i) => normalizeTest(t, i, { repeatRuns: this.settings.get().behavior.default_repeatability_runs, source: t.source || 'manual' })) : null;
    if (incomingTests && stableStringify(incomingTests) === stableStringify(rec.suite.tests)) incomingTests = null;
    const pb = normalizePlaybook({ ...playbook, tests: [] }, { id: rec.id, version: base.version });
    const hash = procedureHash(pb);
    const cosmeticOnly = hash === base.hash;
    if (cosmeticOnly && pb.name === base.playbook.name && pb.description === base.playbook.description) {
      if (incomingTests) this.replaceSuite(rec, incomingTests);
      return { record: this.save(rec), version: base.version, created: false, changed: false };
    }
    const latest = base.version === rec.current_version;
    const inPlace = latest && !IMMUTABLE.has(base.status) && !base.last_test && base.status !== 'testing';
    const now = nowIso();
    let target;
    if (inPlace) {
      base.playbook = pb;
      base.hash = hash;
      base.revision = (base.revision || 1) + 1;
      base.updated_at = now;
      if (change_note) base.change_note = change_note;
      base.quality_gate = gateSummary(pb);
      target = base.version;
    } else {
      const next = Math.max(...rec.versions.map((v) => v.version)) + 1;
      pb.version = next;
      rec.versions.push({
        version: next,
        status: 'draft',
        revision: 1,
        hash,
        playbook: pb,
        source,
        change_note: change_note || `Edited from v${base.version}.`,
        parent_version: base.version,
        created_at: now,
        updated_at: now,
        quality_gate: gateSummary(pb),
        last_test: null,
        test_history: [],
      });
      rec.current_version = next;
      target = next;
    }
    if (incomingTests) this.replaceSuite(rec, incomingTests);
    return { record: this.save(rec), version: target, created: !inPlace, changed: true };
  }

  patch(id, ops, { change_note, source = 'edit', baseVersion } = {}) {
    const problem = validatePatch(ops);
    if (problem) throw new HttpError(400, 'invalid_patch', problem);
    const rec = this.get(id);
    const base = this.version(rec, baseVersion ?? rec.current_version);
    let next;
    try {
      next = applyPatch(base.playbook, ops);
    } catch (err) {
      throw new HttpError(400, 'invalid_patch', `Patch could not be applied: ${err.message}`);
    }
    return this.update(id, { playbook: next, change_note, source, baseVersion: base.version });
  }

  setConfiguration(id, values, { change_note } = {}) {
    const rec = this.get(id);
    const base = this.version(rec, rec.current_version);
    const pb = deepClone(base.playbook);
    for (const c of pb.configuration) if (Object.prototype.hasOwnProperty.call(values || {}, c.name)) c.value = values[c.name];
    return this.update(id, { playbook: pb, change_note: change_note || `Configuration changed: ${Object.keys(values || {}).join(', ')}.` });
  }

  restore(id, v) {
    const rec = this.get(id);
    const ver = this.version(rec, v);
    const next = Math.max(...rec.versions.map((x) => x.version)) + 1;
    const pb = deepClone(ver.playbook);
    pb.version = next;
    const now = nowIso();
    rec.versions.push({
      version: next,
      status: 'draft',
      revision: 1,
      hash: ver.hash,
      playbook: pb,
      source: 'restore',
      change_note: `Restored from v${ver.version}.`,
      parent_version: ver.version,
      created_at: now,
      updated_at: now,
      quality_gate: gateSummary(pb),
      last_test: null,
      test_history: [],
    });
    rec.current_version = next;
    this.save(rec);
    return next;
  }

  rename(id, name) {
    const rec = this.get(id);
    const cur = this.version(rec, rec.current_version);
    const pb = deepClone(cur.playbook);
    pb.name = String(name || '').trim() || pb.name;
    return this.update(id, { playbook: pb, change_note: 'Renamed.' });
  }

  archive(id, archived = true) {
    const rec = this.get(id);
    rec.archived = archived;
    return this.save(rec);
  }

  remove(id) {
    this.get(id);
    this.store.playbooks.delete(id);
  }

  duplicate(id) {
    const rec = this.get(id);
    const cur = this.version(rec, rec.current_version);
    const pb = deepClone(cur.playbook);
    pb.name = `${pb.name} (copy)`;
    return this.create({ playbook: pb, source: 'duplicate', intent: rec.intent, tests: deepClone(rec.suite.tests), change_note: `Duplicated from ${rec.name} v${cur.version}.` });
  }

  setSchedule(id, { enabled, input }) {
    const rec = this.get(id);
    rec.schedule = rec.schedule || {};
    if (enabled !== undefined) {
      if (enabled && !rec.schedule.enabled) rec.schedule.enabled_at = nowIso();
      rec.schedule.enabled = Boolean(enabled);
    }
    if (input !== undefined) rec.schedule.input = input;
    return this.save(rec);
  }

  // ------------------------------------------------------------ test suite

  replaceSuite(rec, tests) {
    rec.suite.tests = deepClone(tests);
    rec.suite.revision++;
    rec.suite.updated_at = nowIso();
  }

  setTests(id, tests) {
    const rec = this.get(id);
    this.replaceSuite(rec, tests);
    return this.save(rec);
  }

  addTests(id, tests) {
    const rec = this.get(id);
    this.replaceSuite(rec, rec.suite.tests.concat(tests));
    return this.save(rec);
  }

  updateTest(id, testId, test) {
    const rec = this.get(id);
    const i = rec.suite.tests.findIndex((t) => t.id === testId);
    if (i < 0) throw new HttpError(404, 'not_found', 'Test not found.');
    const next = rec.suite.tests.slice();
    next[i] = { ...test, id: testId };
    this.replaceSuite(rec, next);
    return this.save(rec);
  }

  deleteTest(id, testId) {
    const rec = this.get(id);
    if (!rec.suite.tests.some((t) => t.id === testId)) throw new HttpError(404, 'not_found', 'Test not found.');
    this.replaceSuite(rec, rec.suite.tests.filter((t) => t.id !== testId));
    return this.save(rec);
  }

  // ------------------------------------------------------------ lifecycle

  markTesting(id, v, on) {
    const rec = this.get(id);
    const ver = this.version(rec, v);
    if (IMMUTABLE.has(ver.status)) return;
    if (on) {
      ver.status_before_test = ver.status === 'testing' ? ver.status_before_test : ver.status;
      ver.status = 'testing';
    } else if (ver.status === 'testing') {
      ver.status = ver.status_before_test || 'draft';
    }
    this.save(rec);
  }

  recordTestRun(id, v, run) {
    const rec = this.get(id);
    const ver = this.version(rec, v);
    ver.test_history = [run.id, ...(ver.test_history || []).filter((x) => x !== run.id)].slice(0, 50);
    const full = run.full_suite && run.suite_revision === rec.suite.revision;
    const conclusive = run.result_status && run.result_status !== 'inconclusive';
    if (run.status === 'completed' && full && conclusive && run.playbook_hash === ver.hash) {
      ver.last_test = {
        test_run_id: run.id,
        status: run.result_status,
        mode: run.mode,
        at: run.ended_at,
        hash: run.playbook_hash,
        suite_revision: run.suite_revision,
        metrics: run.metrics ? run.metrics.metrics : null,
        counts: run.metrics ? run.metrics.counts : null,
      };
      if (!IMMUTABLE.has(ver.status)) ver.status = run.result_status === 'pass' ? 'passed' : run.result_status === 'warning' ? 'warning' : 'failed';
    } else if (ver.status === 'testing') {
      ver.status = ver.status_before_test || 'draft';
    }
    delete ver.status_before_test;
    this.save(rec);
  }

  publishCheck(rec, ver) {
    const settings = this.settings.get();
    const blockers = [];
    const warnings = [];
    if (IMMUTABLE.has(ver.status)) return { can_publish: false, already_published: true, blockers: ['This version is already published.'], warnings };
    if (!ver.quality_gate.passed) blockers.push(`Quality gate: ${ver.quality_gate.failed_checks.map((c) => c.label).join(', ')}.`);
    if (settings.behavior.require_tests_before_publish) {
      const st = this.staleness(rec, ver);
      if (!ver.last_test) blockers.push('Run the full test suite on this version before publishing.');
      else if (st.stale) blockers.push(st.reason === 'suite_changed' ? 'The test suite changed since the last run. Run tests again.' : 'The playbook changed since the last test. Run tests again.');
      else if (ver.last_test.status === 'fail') blockers.push('The latest test run failed.');
      else if (ver.last_test.status === 'warning') warnings.push('The latest test run finished with warnings.');
      if (!rec.suite.tests.length) blockers.push('The test suite is empty.');
    }
    return { can_publish: blockers.length === 0, needs_acknowledgement: warnings.length > 0, blockers, warnings };
  }

  publish(id, v, { acknowledge_warnings = false } = {}) {
    const rec = this.get(id);
    const ver = this.version(rec, v);
    const check = this.publishCheck(rec, ver);
    if (!check.can_publish) throw new HttpError(409, 'publish_blocked', check.blockers.join(' '), check);
    if (check.needs_acknowledgement && !acknowledge_warnings) throw new HttpError(409, 'publish_needs_acknowledgement', check.warnings.join(' '), check);
    ver.status = 'published';
    ver.published_at = nowIso();
    ver.tests_snapshot = deepClone(rec.suite.tests);
    this.save(rec);
    return ver.version;
  }

  promote(id, v) {
    const rec = this.get(id);
    const ver = this.version(rec, v);
    if (!IMMUTABLE.has(ver.status)) throw new HttpError(409, 'not_published', 'Only published versions can be promoted to production.');
    for (const x of rec.versions) if (x.status === 'production' && x.version !== ver.version) x.status = 'published';
    ver.status = 'production';
    rec.production_version = ver.version;
    this.save(rec);
    return ver.version;
  }

  /** Version used for runs when none is specified: production, else latest published, else current draft. */
  runnableVersion(rec) {
    if (rec.production_version) return this.version(rec, rec.production_version);
    const pub = rec.versions.filter((v) => IMMUTABLE.has(v.status)).sort((a, b) => b.version - a.version)[0];
    return pub || this.version(rec, rec.current_version);
  }

  compare(id, a, b) {
    const rec = this.get(id);
    const va = this.version(rec, a);
    const vb = this.version(rec, b);
    const metricKeys = ['accuracy', 'consistency', 'rule_adherence', 'requirement_coverage', 'output_compliance', 'task_alignment'];
    const ma = (va.last_test && va.last_test.metrics) || {};
    const mb = (vb.last_test && vb.last_test.metrics) || {};
    const metrics = metricKeys.map((k) => ({
      metric: k,
      a: ma[k] ?? null,
      b: mb[k] ?? null,
      delta: typeof ma[k] === 'number' && typeof mb[k] === 'number' ? Math.round((mb[k] - ma[k]) * 10000) / 10000 : null,
    }));
    return {
      a: { version: va.version, status: va.status, last_test: va.last_test, hash: va.hash },
      b: { version: vb.version, status: vb.status, last_test: vb.last_test, hash: vb.hash },
      metrics,
      changes: diff(va.playbook, vb.playbook).filter((d) => !/^\/version$/.test(d.path)).slice(0, 200),
    };
  }
}
