// Self-contained playbook workspaces.
//
// Every playbook gets one folder named after it, holding everything needed
// to understand, test, run and review it:
//
//   <Playbook Name>/
//     playbook/      playbook.json (canonical), playbook.md, playbook.pdf
//     requirements/  intent.json, requirements.md, assumptions.json
//     process/       workflow, dependencies, tools, configuration, execution plan
//     inputs/        sample/ · test/ · runtime/        ← the user's own data
//     tests/         test-suite.json, test-cases/, repeatability/, reports/
//     results/       latest/, history/, summaries/
//     executions/    run-001/, run-002/ …              ← one folder per run
//     exports/       markdown/, pdf/, json/
//     metadata/      version.json, settings.json (no secrets), activity.json
//     versions/      v1/, v2/ … (snapshot of every version)
//
// The JSON store stays the database (ids, versions, run metadata). This
// service mirrors every change into the folder: it watches the store, so any
// change — from the UI, the API, the scheduler or a webhook — lands in the
// workspace. All paths are resolved through the playbook id; a request for
// one playbook can never reach another playbook's folder.
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../http.js';
import { nowIso, slugify, isPlainObject } from '../util.js';
import { playbookMarkdown } from '../playbooks/markdown.js';
import { playbookPdf } from '../pdf/playbook-pdf.js';
import { configMap } from '../playbooks/schema.js';
import { buildGraph, topologicalOrder, parallelGroups, triggerLabel } from '../../shared/graph.js';
import { createZip, readZip, isZip, ZipError } from './zip.js';

export const STANDARD_DIRS = [
  'playbook',
  'requirements',
  'process',
  'inputs',
  'inputs/sample',
  'inputs/test',
  'inputs/runtime',
  'tests',
  'tests/test-cases',
  'tests/repeatability',
  'tests/reports',
  'results',
  'results/latest',
  'results/history',
  'results/summaries',
  'executions',
  'exports',
  'exports/markdown',
  'exports/pdf',
  'exports/json',
  'metadata',
  'versions',
];
const STANDARD = new Set(STANDARD_DIRS);
// Show folders in the order people read them: what → how → data → tests → results → exports.
const RANK = new Map(STANDARD_DIRS.map((d, i) => [d, i]));
RANK.set('tests/test-suite.json', RANK.get('tests') + 0.5);
const rankOf = (n) => (RANK.has(n.path) ? RANK.get(n.path) : n.path === 'README.md' ? 5000 : n.type === 'dir' ? 1000 : 2000);
function sortTree(nodes) {
  nodes.sort((a, b) => rankOf(a) - rankOf(b) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const n of nodes) if (n.children) sortTree(n.children);
  return nodes;
}

export const INPUT_CATEGORIES = {
  sample: 'Examples that show the input format',
  test: 'Data used only by tests',
  runtime: 'Real data for runs',
};

/** Files that describe the playbook itself: deleting them needs confirmation, and they come back on the next change. */
export const CRITICAL_FILES = new Set(['playbook/playbook.json', 'playbook/playbook.md', 'playbook/playbook.pdf', 'requirements/intent.json', 'tests/test-suite.json', 'metadata/version.json']);

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_TREE_ENTRIES = 5000;
const ACTIVITY_LIMIT = 1000;
const TERMINAL_RUN = new Set(['completed', 'failed', 'needs_input', 'cancelled']);
const FINISHED_TEST = new Set(['completed', 'cancelled', 'error']);

// ------------------------------------------------------------------ names

const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * A folder or file name that works on Windows, macOS and Linux:
 * "Customer Risk: Q4 / Enterprise" → "Customer Risk Q4 Enterprise".
 */
export function sanitizeName(name, { max = 60, fallback = 'Untitled Playbook' } = {}) {
  let s = String(name ?? '')
    .normalize('NFC')
    .replace(INVALID_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  const chars = Array.from(s);
  if (chars.length > max) s = chars.slice(0, max).join('').replace(/[.\s]+$/, '');
  if (!s) s = fallback;
  if (RESERVED.test(s)) s = `${s} Playbook`;
  return s;
}

/** A safe file name that keeps its extension ("data: Q4?.csv" → "data Q4.csv"). */
export function sanitizeFileName(name, { max = 80 } = {}) {
  const raw = String(name ?? '').split(/[\\/]/).pop();
  const ext = (raw.match(/(\.[A-Za-z0-9]{1,10})$/) || [''])[0];
  const base = sanitizeName(ext ? raw.slice(0, -ext.length) : raw, { max: max - ext.length, fallback: 'file' });
  const out = `${RESERVED.test(base) ? `_${base}` : base}${ext.toLowerCase()}`;
  return out;
}

const runFolder = (n) => `run-${String(n).padStart(3, '0')}`;
const testLabel = (n) => `test-${String(n).padStart(3, '0')}`;
const day = (iso) => String(iso || nowIso()).slice(0, 10);
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
const fold = (p) => (caseInsensitive ? p.toLowerCase() : p);

/**
 * Validate a workspace-relative path ("inputs/runtime/data.json").
 * Rejects anything that could leave the folder or confuse a filesystem:
 * "..", absolute paths, backslashes, drive letters, device names.
 */
export function cleanRel(rel) {
  if (rel === undefined || rel === null || rel === '' || rel === '/' || rel === '.') return '';
  if (typeof rel !== 'string') throw new HttpError(400, 'invalid_path', 'The path must be text.');
  if (/[\u0000-\u001f\\:]/.test(rel)) throw new HttpError(400, 'invalid_path', 'The path contains characters that are not allowed (\\, : or control characters).');
  const parts = rel.split('/').filter((p) => p !== '' && p !== '.');
  for (const p of parts) {
    if (p === '..') throw new HttpError(403, 'outside_workspace', "Paths must stay inside this playbook's workspace.");
    if (/[<>"|?*]/.test(p) || /[. ]$/.test(p) || RESERVED.test(p)) throw new HttpError(400, 'invalid_path', `"${p}" is not a valid file or folder name.`);
  }
  return parts.join('/');
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Write only when the content changed, so file dates mean something. */
function writeIfChanged(file, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  try {
    const cur = fs.readFileSync(file);
    if (cur.equals(buf)) return false;
  } catch { /* new file */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(file, buf);
      return true;
    } catch (err) {
      // Windows can hold a file for a moment (antivirus, indexer). Retry briefly;
      // a file kept open by another program (a PDF viewer) fails for the caller.
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(err.code) || attempt >= 3) throw err;
      const until = Date.now() + 20 * (attempt + 1);
      while (Date.now() < until) { /* brief wait */ }
    }
  }
}

function walk(dir, rel = '', out = [], limit = MAX_TREE_ENTRIES) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.isDirectory() ? -1 : 1));
  for (const e of entries) {
    if (out.length >= limit) break;
    if (e.isSymbolicLink()) continue; // never follow links out of the workspace
    const r = rel ? `${rel}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push({ rel: r, full, dir: true });
      walk(full, r, out, limit);
    } else if (e.isFile()) out.push({ rel: r, full, dir: false });
  }
  return out;
}

function mdCell(v) {
  return String(v === undefined || v === null || v === '' ? '—' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function durationText(ms) {
  if (typeof ms !== 'number') return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// ------------------------------------------------------------------ service

export class WorkspaceService {
  constructor({ store, settings, playbooks, ai, baseDir, appVersion, openFolder = null, log = console.warn }) {
    this.store = store;
    this.settings = settings;
    this.playbooks = playbooks;
    this.ai = ai;
    this.baseDir = path.resolve(baseDir);
    this.appVersion = appVersion;
    this.openFolderImpl = openFolder;
    this.log = log;
    this.chains = new Map();
    this.timers = new Map();
    this.selfWrite = 0;
    this.seenRuns = new Map();
    this.seenTests = new Set();
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  /** Watch the store so every change lands in its workspace, whoever made it. */
  attach() {
    this.store.playbooks.onPut = (rec) => {
      if (!this.selfWrite && !rec.deleted) this.schedule(rec.id);
    };
    this.store.playbooks.onDelete = (rec) => this.onPlaybookDeleted(rec);
    this.store.runs.onPut = (run) => this.onRunSaved(run);
    this.store.testRuns.onPut = (doc) => this.onTestRunSaved(doc);
    // Export switches, privacy mode and test thresholds are written into every
    // workspace (exports/, metadata/settings.json): refresh them when they change.
    if (typeof this.settings.onChange === 'function') {
      this.settingsDigest = this.digestSettings(this.settings.get());
      this.settings.onChange((s) => {
        const digest = this.digestSettings(s);
        if (digest === this.settingsDigest) return;
        this.settingsDigest = digest;
        this.store.playbooks.forEachRaw((r) => {
          if (!r.deleted && r.workspace) this.schedule(r.id, 400);
        });
      });
    }
    return this;
  }

  /** The settings that end up in workspace files. */
  digestSettings(s) {
    const f = s.features || {};
    return JSON.stringify([
      f.pdf_export, f.markdown_export, f.json_export, f.production_actions, f.human_approval,
      s.ai && s.ai.privacy_mode, s.ai && s.ai.default_connection_id,
      s.testing && [s.testing.default_mode, s.testing.pass_threshold, s.testing.warning_threshold],
      s.behavior && [s.behavior.default_repeatability_runs, s.behavior.require_validation],
    ]);
  }

  // ---------------------------------------------------------------- queue

  /** Work for one playbook runs strictly in order. Errors are logged, never thrown into the app. */
  enqueue(id, fn) {
    const prev = this.chains.get(id) || Promise.resolve();
    const next = prev
      .then(() => fn())
      .catch((err) => this.log(`[workspace] ${id}: ${err.stack || err.message}`));
    this.chains.set(id, next);
    next.then(() => {
      if (this.chains.get(id) === next) this.chains.delete(id);
    });
    return next;
  }

  /** Queue work for a playbook and get its result (or its error) back. */
  run(id, fn) {
    return new Promise((resolve, reject) => {
      this.enqueue(id, () => Promise.resolve().then(fn).then(resolve, reject));
    });
  }

  schedule(id, delay = 120) {
    if (this.timers.has(id)) clearTimeout(this.timers.get(id));
    const t = setTimeout(() => {
      this.timers.delete(id);
      this.enqueue(id, () => this.syncNow(id));
    }, delay);
    if (t.unref) t.unref();
    this.timers.set(id, t);
  }

  /** Wait until everything pending for this playbook is on disk. */
  async idle(id) {
    if (this.timers.has(id)) {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      this.enqueue(id, () => this.syncNow(id));
    }
    while (this.chains.get(id)) await this.chains.get(id);
  }

  async idleAll() {
    for (;;) {
      const ids = new Set([...this.timers.keys(), ...this.chains.keys()]);
      if (!ids.size) return;
      for (const id of ids) await this.idle(id);
    }
  }

  // ---------------------------------------------------------------- records

  record(id) {
    const rec = this.store.playbooks.get(id);
    if (!rec || rec.deleted) throw new HttpError(404, 'not_found', 'Playbook not found.');
    return rec;
  }

  dirOf(rec) {
    return path.join(this.baseDir, rec.workspace.folder);
  }

  saveMeta(id, patch) {
    this.selfWrite++;
    try {
      return this.store.playbooks.update(id, (r) => {
        r.workspace = { ...(r.workspace || {}), ...patch };
        return r;
      });
    } finally {
      this.selfWrite--;
    }
  }

  /** A folder name nobody else uses (case-insensitive, like Windows and macOS). */
  uniqueFolder(base, ownId, current = null) {
    const taken = new Set();
    this.store.playbooks.forEachRaw((r) => {
      if (r.id !== ownId && r.workspace && r.workspace.folder) taken.add(r.workspace.folder.toLowerCase());
    });
    try {
      for (const n of fs.readdirSync(this.baseDir)) if (!current || n.toLowerCase() !== current.toLowerCase()) taken.add(n.toLowerCase());
    } catch { /* base folder missing */ }
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base} (${i})`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${base} ${ownId}`;
  }

  /** Make sure the folder exists, has the right name and the standard structure. */
  ensureFolder(rec) {
    let created = false;
    if (!rec.workspace || !rec.workspace.folder) {
      const folder = this.uniqueFolder(sanitizeName(rec.name), rec.id);
      rec = this.saveMeta(rec.id, { folder, created_at: nowIso(), run_seq: 0, test_seq: 0 });
      created = true;
    } else {
      rec = this.renameIfNeeded(rec);
    }
    const dir = this.dirOf(rec);
    if (!fs.existsSync(dir)) created = true;
    for (const d of STANDARD_DIRS) fs.mkdirSync(path.join(dir, ...d.split('/')), { recursive: true });
    if (created) {
      this.activity(rec, 'workspace_created', `Workspace "${rec.workspace.folder}" created.`);
      this.writeSampleInputs(rec);
    }
    return rec;
  }

  /** Renaming the playbook renames the folder; nothing inside is copied or lost. */
  renameIfNeeded(rec) {
    const current = rec.workspace.folder;
    const desired = this.uniqueFolder(sanitizeName(rec.name), rec.id, current);
    if (desired === current) return rec;
    const from = path.join(this.baseDir, current);
    const to = path.join(this.baseDir, desired);
    try {
      if (fs.existsSync(from)) fs.renameSync(from, to);
    } catch (err) {
      // A file may be open in another program (Windows). Keep the old name and try again next time.
      this.log(`[workspace] Could not rename "${current}" to "${desired}" yet: ${err.code || err.message}`);
      return rec;
    }
    const next = this.saveMeta(rec.id, { folder: desired, previous_folders: [...(rec.workspace.previous_folders || []), current].slice(-10) });
    this.activity(next, 'renamed', `Folder renamed from "${current}" to "${desired}".`);
    return next;
  }

  writeSampleInputs(rec) {
    const ver = rec.versions.find((v) => v.version === rec.current_version);
    const pb = ver && ver.playbook;
    if (!pb || !(pb.inputs || []).some((i) => i.example !== undefined)) return;
    const sample = {};
    for (const i of pb.inputs) if (i.example !== undefined) sample[i.id] = i.example;
    const file = path.join(this.dirOf(rec), 'inputs', 'sample', 'example-input.json');
    if (!fs.existsSync(file)) fs.writeFileSync(file, json(sample));
  }

  onPlaybookDeleted(rec) {
    if (!rec || !rec.workspace || !rec.workspace.folder) return;
    if (this.timers.has(rec.id)) {
      clearTimeout(this.timers.get(rec.id));
      this.timers.delete(rec.id);
    }
    const dir = path.join(this.baseDir, rec.workspace.folder);
    this.enqueue(rec.id, () => {
      if (path.dirname(dir) === this.baseDir) fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  // ---------------------------------------------------------------- sync (derived files)

  /** Rewrite everything derived from the playbook record. */
  syncNow(id) {
    let rec = this.store.playbooks.get(id);
    if (!rec || rec.deleted) return;
    rec = this.ensureFolder(rec);
    const dir = this.dirOf(rec);
    const files = this.derivedFiles(rec);
    const manifestFile = path.join(dir, 'metadata', 'manifest.json');
    const manifest = readJsonFile(manifestFile) || {};
    // One locked file (a PDF open in a viewer on Windows) must not stop the rest from updating.
    const locked = [];
    for (const [rel, content] of files) {
      try {
        writeIfChanged(path.join(dir, ...rel.split('/')), content);
      } catch (err) {
        locked.push(`${rel} (${err.code || err.message})`);
      }
    }
    if (locked.length) this.log(`[workspace] "${rec.workspace.folder}": could not update ${locked.join(', ')}. Close the file if it is open in another program; it is updated at the next change.`);
    // Files this service created earlier that no longer exist in the playbook (a deleted test, an old export name).
    for (const rel of manifest.derived || []) {
      if (files.has(rel) || rel === 'metadata/manifest.json') continue;
      try {
        const clean = cleanRel(rel);
        if (clean) fs.rmSync(path.join(dir, ...clean.split('/')), { force: true });
      } catch { /* ignore */ }
    }
    const state = { version: rec.current_version, status: this.currentVersion(rec).status, suite_revision: rec.suite.revision, production_version: rec.production_version };
    const prev = manifest.state || null;
    if (prev) {
      if (prev.version !== state.version) this.activity(rec, 'version_created', `Version v${state.version} is now the current version.`);
      else if (prev.status !== state.status) this.activity(rec, 'status_changed', `v${state.version} is now ${state.status}.`);
      if (prev.suite_revision !== state.suite_revision) this.activity(rec, 'tests_changed', `The test suite changed (${rec.suite.tests.length} tests).`);
      if (prev.production_version !== state.production_version && state.production_version) this.activity(rec, 'promoted', `v${state.production_version} is in production.`);
    }
    writeIfChanged(manifestFile, json({ playbook_id: rec.id, app_version: this.appVersion, updated_at: rec.updated_at, state, derived: ['metadata/manifest.json', ...[...files.keys()].sort()] }));
  }

  currentVersion(rec) {
    return rec.versions.find((v) => v.version === rec.current_version) || rec.versions[rec.versions.length - 1];
  }

  exportBaseName(rec) {
    return sanitizeName(rec.name);
  }

  derivedFiles(rec) {
    const s = this.settings.get();
    const ctx = this.playbooks.exportContext(rec);
    const pb = ctx.pb;
    const at = new Date(rec.updated_at || Date.now());
    const files = new Map();
    const name = this.exportBaseName(rec);

    files.set('README.md', this.readme(rec, pb));
    files.set('playbook/playbook.json', json(pb));
    const md = playbookMarkdown(pb, { ...ctx, generatedAt: at });
    files.set('playbook/playbook.md', md);
    let pdf = null;
    if (s.features.pdf_export) {
      pdf = playbookPdf(pb, { ...ctx, generatedAt: at });
      files.set('playbook/playbook.pdf', pdf);
    }

    files.set('requirements/intent.json', json(this.intentFile(rec, pb)));
    files.set('requirements/requirements.md', this.requirementsMd(rec, pb));
    files.set('requirements/assumptions.json', json(this.assumptionsFile(rec, pb)));

    files.set('process/workflow.json', json(this.workflowFile(pb)));
    files.set('process/dependencies.json', json({ playbook_id: rec.id, version: pb.version, dependencies: pb.dependencies, step_dependencies: pb.steps.map((st) => ({ step_id: st.id, name: st.name, depends_on: st.dependencies })) }));
    files.set('process/tools.json', json({ playbook_id: rec.id, version: pb.version, tools: pb.tools, permissions: pb.permissions }));
    files.set('process/configuration.json', json({ playbook_id: rec.id, version: pb.version, values: configMap(pb), configuration: pb.configuration }));
    files.set('process/execution-plan.json', json(this.executionPlan(pb)));

    files.set('tests/test-suite.json', json({ playbook_id: rec.id, version: pb.version, suite_revision: rec.suite.revision, updated_at: rec.suite.updated_at, count: rec.suite.tests.length, tests: rec.suite.tests }));
    const used = new Set();
    for (const t of rec.suite.tests) {
      let slug = slugify(t.name || t.id).slice(0, 50) || t.id;
      if (used.has(slug)) slug = `${slug}-${t.id}`;
      used.add(slug);
      files.set(`tests/test-cases/${slug}.json`, json(t));
    }

    files.set('metadata/version.json', json(this.versionFile(rec, pb)));
    files.set('metadata/settings.json', json(this.settingsFile(rec, pb, s)));

    for (const v of rec.versions) {
      files.set(`versions/v${v.version}/playbook.json`, json(this.playbooks.exportJson(rec, v.version)));
      files.set(
        `versions/v${v.version}/version.json`,
        json({ version: v.version, status: v.status, hash: v.hash, source: v.source, change_note: v.change_note, parent_version: v.parent_version, created_at: v.created_at, updated_at: v.updated_at, published_at: v.published_at || null, quality_gate_passed: v.quality_gate ? v.quality_gate.passed : null, last_test: v.last_test || null }),
      );
    }

    if (s.features.markdown_export) files.set(`exports/markdown/${name}.md`, md);
    if (s.features.pdf_export && pdf) files.set(`exports/pdf/${name}.pdf`, pdf);
    if (s.features.json_export) files.set(`exports/json/${name}.json`, json(pb));
    return files;
  }

  readme(rec, pb) {
    const ver = this.currentVersion(rec);
    return [
      `# ${pb.name}`,
      '',
      pb.description || pb.objective || '',
      '',
      'This folder is the playbook\'s workspace: everything needed to understand, test, run and review it.',
      '',
      '| | |',
      '|---|---|',
      `| Playbook ID | \`${rec.id}\` |`,
      `| Current version | v${ver.version} (${ver.status}) |`,
      `| Production version | ${rec.production_version ? `v${rec.production_version}` : '—'} |`,
      `| Last updated | ${String(rec.updated_at || '').replace('T', ' ').slice(0, 16)} UTC |`,
      '',
      '| Folder | What it holds |',
      '|---|---|',
      '| `playbook/` | The playbook itself: `playbook.json` (canonical), `playbook.md`, `playbook.pdf` |',
      '| `requirements/` | What was asked for: the confirmed intent, requirements and assumptions |',
      '| `process/` | How it works: workflow, dependencies, tools, configuration, execution plan |',
      '| `inputs/` | Your data: `sample/` (examples), `test/` (test data only), `runtime/` (real data for runs) |',
      '| `tests/` | The test suite, one file per test case, repeatability runs and test reports |',
      '| `results/` | `latest/` result, `history/` of results, `summaries/` of all runs and test runs |',
      '| `executions/` | One folder per run (`run-001`, `run-002`, …): input, step results, output, report |',
      '| `exports/` | Markdown, PDF and JSON exports |',
      '| `metadata/` | Version, settings (never secrets) and the activity log |',
      '| `versions/` | A snapshot of every version (`v1`, `v2`, …) — executions name the version they used |',
      '',
      'The playbook is the procedure; executions are results. Test data in `inputs/test` is never used by production runs.',
      '',
      `Generated by Playbook Builder for AI v${this.appVersion} · Powered By SiliBlue.in`,
      '',
    ].join('\n');
  }

  intentFile(rec, pb) {
    const it = rec.intent;
    if (it && typeof it === 'object') {
      const trig = it.trigger || {};
      return {
        playbook_id: rec.id,
        objective: it.goal || pb.objective,
        criteria: it.rules || [],
        source: (it.data_sources || []).join(', '),
        action: (it.actions || []).join(', '),
        frequency: trig.frequency || (trig.type === 'manual' ? 'On demand' : trig.type || ''),
        confirmed: rec.session_id ? true : null,
        session_id: rec.session_id || null,
        captured_at: rec.created_at,
        details: it,
      };
    }
    return {
      playbook_id: rec.id,
      objective: pb.objective,
      criteria: (pb.requirements || []).filter((r) => r.type === 'business_rule').map((r) => r.text),
      source: (pb.inputs || []).map((i) => i.source).filter(Boolean).join(', '),
      action: '',
      frequency: triggerLabel(pb.trigger),
      confirmed: null,
      note: 'No discovery session: this intent is derived from the playbook itself (for example, an imported playbook).',
      captured_at: rec.created_at,
    };
  }

  requirementsMd(rec, pb) {
    const groups = {};
    for (const r of pb.requirements || []) (groups[r.type] = groups[r.type] || []).push(r);
    const titles = { functional: 'Functional', data: 'Data', business_rule: 'Business rules', output: 'Output', non_functional: 'Non-functional', constraint: 'Constraints' };
    const out = [`# Requirements — ${pb.name}`, '', `**Objective:** ${pb.objective || '—'}`, ''];
    for (const [type, label] of Object.entries(titles)) {
      if (!groups[type]) continue;
      out.push(`## ${label}`, '');
      for (const r of groups[type]) out.push(`- **${r.id}** — ${r.text}`);
      out.push('');
    }
    const it = rec.intent || {};
    if ((it.constraints || []).length) out.push('## Constraints from the confirmed intent', '', ...it.constraints.map((c) => `- ${c}`), '');
    if ((pb.success_criteria || []).length) out.push('## Success criteria', '', ...pb.success_criteria.map((c) => `- ${typeof c === 'string' ? c : c.text}`), '');
    if ((pb.assumptions || []).length) out.push('## Assumptions', '', ...pb.assumptions.map((a) => `- ${typeof a === 'string' ? a : a.text || JSON.stringify(a)}`), '');
    if ((it.open_questions || []).length) out.push('## Open questions', '', ...it.open_questions.map((q) => `- ${q}`), '');
    out.push(`_From ${rec.intent ? 'the confirmed intent and ' : ''}playbook v${pb.version}. The full intent is in intent.json._`, '');
    return out.join('\n');
  }

  assumptionsFile(rec, pb) {
    const it = rec.intent || {};
    return { playbook_id: rec.id, version: pb.version, playbook: pb.assumptions || [], intent: it.assumptions || [], open_questions: it.open_questions || [] };
  }

  workflowFile(pb) {
    const g = buildGraph(pb, { terminals: true });
    return {
      version: pb.version,
      trigger: { ...pb.trigger, label: triggerLabel(pb.trigger) },
      order: topologicalOrder(pb),
      parallel_groups: parallelGroups(pb),
      steps: pb.steps.map((s) => ({ id: s.id, name: s.name, type: s.type, purpose: s.purpose, depends_on: s.dependencies, tools: s.tools, decision_logic: s.decision_logic, output: s.output, requires_approval: Boolean(s.requires_approval) })),
      graph: {
        nodes: g.nodes.map((n) => ({ id: n.id, kind: n.kind, type: n.type, label: n.label })),
        edges: g.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind, label: e.label || '' })),
        issues: g.issues || [],
      },
    };
  }

  executionPlan(pb) {
    const order = topologicalOrder(pb);
    const groups = parallelGroups(pb);
    const rulesByStep = {};
    for (const r of pb.decision_rules || []) (rulesByStep[r.step_id] = rulesByStep[r.step_id] || []).push(r.id);
    return {
      version: pb.version,
      steps: order
        .map((id, i) => {
          const s = pb.steps.find((x) => x.id === id);
          if (!s) return null;
          const group = groups.find((g) => g.steps.includes(id));
          return {
            order: i + 1,
            step_id: s.id,
            name: s.name,
            type: s.type,
            runs: s.execution ? `engine (${s.execution.op})` : s.type === 'approval' ? 'person (approval)' : 'AI model',
            depends_on: s.dependencies,
            inputs: s.inputs,
            tools: s.tools,
            decision_rules: rulesByStep[s.id] || [],
            output: s.output,
            validation: s.validation,
            on_failure: s.failure_behavior,
            retry: s.retry_behavior,
            parallel_with: group ? group.steps.filter((x) => x !== id) : [],
          };
        })
        .filter(Boolean),
      error_handling: pb.error_handling,
      output_contract: pb.output,
    };
  }

  aiTransport(pb) {
    try {
      const r = this.ai.resolve('execution', { connectionId: pb.ai.connection_id || undefined });
      return { transport: r.conn.type === 'local' ? 'local' : 'cloud', provider: r.conn.provider, connection_id: r.conn.id, model: r.model };
    } catch {
      return { transport: 'none', provider: null, connection_id: pb.ai.connection_id || null, model: pb.ai.model || null };
    }
  }

  versionFile(rec, pb) {
    const ver = this.currentVersion(rec);
    return {
      playbook_id: rec.id,
      name: pb.name,
      folder: rec.workspace.folder,
      version: ver.version,
      version_label: `v${ver.version}`,
      status: ver.status,
      hash: ver.hash,
      production_version: rec.production_version,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
      schema_version: pb.schema_version,
      app_version: this.appVersion,
      versions: rec.versions.map((v) => ({ version: v.version, status: v.status, hash: v.hash, created_at: v.created_at, change_note: v.change_note, last_test: v.last_test ? v.last_test.status : null, snapshot: `versions/v${v.version}/playbook.json` })),
    };
  }

  settingsFile(rec, pb, s) {
    return {
      playbook_id: rec.id,
      note: 'Settings that affect this playbook. Secrets (API keys, webhook tokens) are never written here.',
      ai: { ...this.aiTransport(pb), privacy_mode: s.ai.privacy_mode },
      storage: { workspace: 'local', note: 'Workspace storage is separate from AI transport: files stay in this folder; the AI provider only receives the requests made to it.' },
      configuration: configMap(pb),
      trigger: pb.trigger,
      schedule: { enabled: Boolean(rec.schedule && rec.schedule.enabled) },
      testing: { default_mode: s.testing.default_mode, pass_threshold: s.testing.pass_threshold, warning_threshold: s.testing.warning_threshold, repeatability_runs: s.behavior.default_repeatability_runs },
      execution: { production_actions: s.features.production_actions, human_approval: s.features.human_approval, require_validation: s.behavior.require_validation },
    };
  }

  // ---------------------------------------------------------------- activity

  activity(rec, event, detail, data) {
    const file = path.join(this.dirOf(rec), 'metadata', 'activity.json');
    let list = readJsonFile(file);
    if (!Array.isArray(list)) list = [];
    list.push({ at: nowIso(), event, detail, ...(data ? { data } : {}) });
    if (list.length > ACTIVITY_LIMIT) list = list.slice(-ACTIVITY_LIMIT);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, json(list));
  }

  logActivity(id, event, detail, data) {
    return this.enqueue(id, () => {
      const rec = this.ensureFolder(this.record(id));
      this.activity(rec, event, detail, data);
    });
  }

  // ---------------------------------------------------------------- executions

  onRunSaved(run) {
    if (this.selfWrite || !run || !run.playbook_id) return;
    const sig = `${run.status}|${(run.approvals || []).length}|${run.ended_at || ''}`;
    if (this.seenRuns.get(run.id) === sig) return;
    this.rememberRun(run.id, sig);
    this.enqueue(run.playbook_id, () => this.recordRun(run.id));
  }

  /** Keep the seen-books bounded: a long-lived server must not grow them forever. */
  rememberRun(id, sig) {
    this.seenRuns.set(id, sig);
    if (this.seenRuns.size > 2000) {
      const oldest = this.seenRuns.keys().next().value;
      this.seenRuns.delete(oldest);
    }
  }

  rememberTest(id) {
    this.seenTests.add(id);
    if (this.seenTests.size > 2000) {
      const oldest = this.seenTests.values().next().value;
      this.seenTests.delete(oldest);
    }
  }

  maxOnDisk(dir, pattern) {
    let max = 0;
    try {
      for (const n of fs.readdirSync(dir)) {
        const m = pattern.exec(n);
        if (m) max = Math.max(max, Number(m[1]));
      }
    } catch { /* none yet */ }
    return max;
  }

  /** Write executions/run-NNN/ and, when the run has finished, the results. */
  recordRun(runId) {
    let run = this.store.runs.get(runId);
    if (!run) return;
    let rec = this.store.playbooks.get(run.playbook_id);
    if (!rec || rec.deleted) return;
    rec = this.ensureFolder(rec);
    const dir = this.dirOf(rec);
    let number = run.workspace_run;
    if (!number) {
      number = Math.max(rec.workspace.run_seq || 0, this.maxOnDisk(path.join(dir, 'executions'), /^run-(\d+)$/)) + 1;
      rec = this.saveMeta(rec.id, { run_seq: number });
      this.selfWrite++;
      try {
        run = this.store.runs.update(run.id, (r) => {
          r.workspace_run = number;
          r.workspace_path = `executions/${runFolder(number)}`;
          return r;
        });
      } finally {
        this.selfWrite--;
      }
      this.activity(rec, 'run_started', `${runFolder(number)} started (v${run.version}, ${run.environment}, ${run.mode}).`, { run_id: run.id });
    }
    const folder = path.join(dir, 'executions', runFolder(number));
    const report = this.runReport(rec, run, number);
    writeIfChanged(path.join(folder, 'input.json'), json(run.input ?? {}));
    writeIfChanged(path.join(folder, 'execution.json'), json(this.executionFile(rec, run, number)));
    writeIfChanged(path.join(folder, 'step-results.json'), json({ run_id: run.id, steps: run.trace || [], decisions: run.decisions || [], logs: run.logs || [] }));
    writeIfChanged(path.join(folder, 'output.json'), json(run.output ?? null));
    writeIfChanged(path.join(folder, 'report.md'), report);
    if (!TERMINAL_RUN.has(run.status)) {
      if (run.status === 'awaiting_approval') this.activity(rec, 'run_waiting', `${runFolder(number)} is waiting for approval.`, { run_id: run.id });
      return;
    }
    const summary = this.runSummary(rec, run, number);
    const latest = readJsonFile(path.join(dir, 'results', 'latest', 'summary.json'));
    if (!latest || !latest.ended_at || String(run.ended_at || '') >= String(latest.ended_at)) {
      writeIfChanged(path.join(dir, 'results', 'latest', 'result.json'), json({ ...summary, output: run.output ?? null, validation: run.validation, error: run.error }));
      writeIfChanged(path.join(dir, 'results', 'latest', 'result.md'), report);
      writeIfChanged(path.join(dir, 'results', 'latest', 'summary.json'), json(summary));
    }
    const hist = path.join(dir, 'results', 'history', `${day(run.started_at)}-${runFolder(number)}`);
    writeIfChanged(path.join(hist, 'result.json'), json({ ...summary, output: run.output ?? null, validation: run.validation, error: run.error }));
    writeIfChanged(path.join(hist, 'result.md'), report);
    this.writeRunSummaries(rec);
    this.activity(rec, 'run_finished', `${runFolder(number)} ${run.status} (v${run.version}, ${run.environment}).`, { run_id: run.id, status: run.status });
  }

  executionFile(rec, run, number) {
    const ver = rec.versions.find((v) => v.version === run.version);
    return {
      run_id: run.id,
      run_number: number,
      folder: `executions/${runFolder(number)}`,
      playbook_id: rec.id,
      playbook_name: run.playbook_name,
      version: run.version,
      version_status: run.version_status,
      version_hash: run.hash || (ver && ver.hash) || null,
      version_snapshot: `versions/v${run.version}/playbook.json`,
      status: run.status,
      mode: run.mode,
      environment: run.environment,
      trigger: run.trigger,
      input_source: run.input_source || (run.trigger === 'schedule' ? 'schedule' : run.trigger === 'webhook' ? 'webhook request' : 'entered in the app'),
      started_at: run.started_at,
      ended_at: run.ended_at,
      duration_ms: run.duration_ms,
      model: run.model || null,
      connection_id: run.connection_id || null,
      usage: run.usage || null,
      policy: run.policy,
      approvals: (run.approvals || []).map((a) => ({ id: a.id, reason: a.reason, status: a.status, requested_at: a.requested_at, decided_at: a.decided_at || null, note: a.note || '' })),
      validation: run.validation,
      warnings: run.warnings || [],
      error: run.error || null,
    };
  }

  runSummary(rec, run, number) {
    const decisions = {};
    const ver = rec.versions.find((v) => v.version === run.version);
    const fields = ver ? (ver.playbook.output.fields || []).filter((f) => f.enum || f.type === 'boolean' || f.type === 'number' || f.type === 'integer') : [];
    if (run.output && typeof run.output === 'object') for (const f of fields) if (run.output[f.name] !== undefined) decisions[f.name] = run.output[f.name];
    return {
      run_id: run.id,
      run_number: number,
      execution: `executions/${runFolder(number)}`,
      playbook_id: rec.id,
      version: run.version,
      environment: run.environment,
      mode: run.mode,
      trigger: run.trigger,
      status: run.status,
      started_at: run.started_at,
      ended_at: run.ended_at,
      duration_ms: run.duration_ms,
      key_results: decisions,
    };
  }

  runReport(rec, run, number) {
    const trace = run.trace || [];
    const lines = [
      `# ${runFolder(number)} — ${run.playbook_name} v${run.version}`,
      '',
      '| | |',
      '|---|---|',
      `| Run ID | \`${run.id}\` |`,
      `| Status | **${run.status}** |`,
      `| Environment | ${run.environment} · ${run.mode === 'ai' ? `AI execution${run.model ? ` (${run.model})` : ''}` : 'deterministic'} |`,
      `| Playbook version | v${run.version} (${run.version_status}) — \`versions/v${run.version}/playbook.json\` |`,
      `| Input | ${mdCell(run.input_source || (run.trigger === 'schedule' ? 'schedule' : run.trigger === 'webhook' ? 'webhook request' : 'entered in the app'))} |`,
      `| Started | ${mdCell(run.started_at)} |`,
      `| Duration | ${durationText(run.duration_ms)} |`,
      '',
      '## Output',
      '',
      run.output !== null && run.output !== undefined ? ['```json', JSON.stringify(run.output, null, 2), '```'].join('\n') : '_No output._',
      '',
    ];
    if (run.error) lines.push('## Error', '', `**${run.error.code || 'ERROR'}** — ${run.error.message || ''}`, '');
    if (run.validation) lines.push('## Validation', '', run.validation.passed ? 'The output matches the output contract.' : `Issues: ${(run.validation.issues || []).join('; ') || 'see execution.json'}`, '');
    if (trace.length) {
      lines.push('## Steps', '', '| # | Step | Status | Decision | Duration |', '|---|---|---|---|---|');
      trace.forEach((t, i) => lines.push(`| ${i + 1} | ${mdCell(t.name || t.step_id)} | ${mdCell(t.status)} | ${mdCell(t.decision !== undefined ? `${t.decision}${t.rule_id ? ` (${t.rule_id})` : ''}` : '')} | ${durationText(t.duration_ms)} |`));
      lines.push('');
    }
    if ((run.approvals || []).length) {
      lines.push('## Approvals', '');
      for (const a of run.approvals) lines.push(`- ${a.status} — ${a.reason}${a.note ? ` (${a.note})` : ''}`);
      lines.push('');
    }
    if ((run.warnings || []).length) lines.push('## Warnings', '', ...run.warnings.map((w) => `- ${w.message || w.code}`), '');
    lines.push('_The playbook is the procedure; this report is the result of one execution._', '');
    return lines.join('\n');
  }

  writeRunSummaries(rec) {
    const runs = this.store.runs.list((r) => r.playbook_id === rec.id && r.workspace_run).sort((a, b) => a.workspace_run - b.workspace_run);
    writeIfChanged(
      path.join(this.dirOf(rec), 'results', 'summaries', 'runs.json'),
      json({ playbook_id: rec.id, count: runs.length, runs: runs.map((r) => ({ run_number: r.workspace_run, run_id: r.id, folder: r.workspace_path, version: r.version, environment: r.environment, mode: r.mode, status: r.status, started_at: r.started_at, duration_ms: r.duration_ms })) }),
    );
  }

  // ---------------------------------------------------------------- test runs

  onTestRunSaved(doc) {
    if (this.selfWrite || !doc || !FINISHED_TEST.has(doc.status) || this.seenTests.has(doc.id)) return;
    this.rememberTest(doc.id);
    this.enqueue(doc.playbook_id, () => this.recordTestRun(doc.id));
  }

  recordTestRun(id) {
    let doc = this.store.testRuns.get(id);
    if (!doc) return;
    let rec = this.store.playbooks.get(doc.playbook_id);
    if (!rec || rec.deleted) return;
    rec = this.ensureFolder(rec);
    const dir = this.dirOf(rec);
    const histDir = path.join(dir, 'tests', 'reports', 'history');
    let number = doc.workspace_test;
    if (!number) {
      number = Math.max(rec.workspace.test_seq || 0, this.maxOnDisk(histDir, /-test-(\d+)\.json$/)) + 1;
      rec = this.saveMeta(rec.id, { test_seq: number });
      this.selfWrite++;
      try {
        doc = this.store.testRuns.update(doc.id, (d) => {
          d.workspace_test = number;
          return d;
        });
      } finally {
        this.selfWrite--;
      }
    }
    const report = this.testReport(rec, doc, number);
    writeIfChanged(path.join(histDir, `${day(doc.started_at)}-${testLabel(number)}.json`), json(report));
    const latest = readJsonFile(path.join(dir, 'tests', 'reports', 'latest.json'));
    const isLatest = !latest || !latest.started_at || String(doc.started_at) >= String(latest.started_at);
    if (isLatest) {
      writeIfChanged(path.join(dir, 'tests', 'reports', 'latest.json'), json(report));
      writeIfChanged(path.join(dir, 'tests', 'reports', 'latest.md'), this.testReportMd(rec, doc, number));
      this.writeRepeatability(rec, doc);
    }
    this.writeTestSummaries(rec);
    this.activity(rec, 'test_run', `${testLabel(number)}: v${doc.version} ${String(doc.result_status || doc.status).toUpperCase()} (${doc.mode}).`, { test_run_id: doc.id });
  }

  testReport(rec, doc, number) {
    const m = doc.metrics || {};
    return {
      test_run_id: doc.id,
      test_number: number,
      playbook_id: rec.id,
      playbook_name: doc.playbook_name,
      version: doc.version,
      version_hash: doc.playbook_hash,
      version_snapshot: `versions/v${doc.version}/playbook.json`,
      suite_revision: doc.suite_revision,
      mode: doc.mode,
      trigger: doc.trigger,
      status: doc.status,
      result: doc.result_status,
      started_at: doc.started_at,
      ended_at: doc.ended_at,
      duration_ms: doc.duration_ms,
      environment: doc.environment,
      metrics: m.metrics || null,
      statuses: m.statuses || null,
      counts: m.counts || null,
      latency: m.latency || null,
      reasons: m.reasons || [],
      results: (doc.results || []).map((r) => ({ test_id: r.test_id, name: r.name, category: r.category, status: r.status, accuracy: r.accuracy, agreement: r.agreement, runs: (r.runs || []).length, diagnosis: r.diagnosis || null, skip_reason: r.skip_reason || null })),
      repair_suggestions: (doc.repair_suggestions || []).map((s) => ({ id: s.id, fix_summary: s.fix_summary, verified: s.verification ? s.verification.verified : null })),
      disclaimer: m.disclaimer || null,
    };
  }

  testReportMd(rec, doc, number) {
    const m = (doc.metrics && doc.metrics.metrics) || {};
    const pct = (v) => (typeof v === 'number' ? `${Math.round(v * 1000) / 10}%` : 'n/a');
    const lines = [
      `# Test report ${testLabel(number)} — ${doc.playbook_name} v${doc.version}`,
      '',
      `**${String(doc.result_status || doc.status).toUpperCase()}** · ${doc.mode === 'ai' ? `AI execution${doc.environment && doc.environment.model ? ` (${doc.environment.model})` : ''}` : 'deterministic'} · ${(doc.results || []).length} tests · ${doc.progress ? doc.progress.total : 0} runs · ${String(doc.started_at || '').replace('T', ' ').slice(0, 16)} UTC`,
      '',
      '| Metric | Value |',
      '|---|---|',
      ...['accuracy', 'consistency', 'rule_adherence', 'requirement_coverage', 'output_compliance', 'task_alignment', 'error_handling'].map((k) => `| ${k.replace(/_/g, ' ')} | ${pct(m[k])} |`),
      '',
      '| Test | Category | Status | Accuracy | Agreement |',
      '|---|---|---|---|---|',
      ...(doc.results || []).map((r) => `| ${mdCell(r.name)} | ${mdCell(r.category)} | ${mdCell(r.status)} | ${pct(r.accuracy)} | ${r.agreement === null || r.agreement === undefined ? '—' : pct(r.agreement)} |`),
      '',
    ];
    const failed = (doc.results || []).filter((r) => r.status !== 'pass');
    if (failed.length) {
      lines.push('## Findings', '');
      for (const r of failed) lines.push(`- **${r.name}** (${r.status})${r.diagnosis && r.diagnosis.length ? `: ${r.diagnosis.join(' ')}` : r.skip_reason ? `: ${r.skip_reason}` : ''}`);
      lines.push('');
    }
    if ((doc.repair_suggestions || []).length) lines.push('## Suggested fixes', '', ...doc.repair_suggestions.map((s) => `- ${s.fix_summary}${s.verification && s.verification.verified ? ' (verified)' : ''}`), '');
    if (doc.metrics && doc.metrics.disclaimer) lines.push(`_${doc.metrics.disclaimer}_`, '');
    return lines.join('\n');
  }

  /** tests/repeatability/: one file per run of the latest repeatability test(s). */
  writeRepeatability(rec, doc) {
    const base = path.join(this.dirOf(rec), 'tests', 'repeatability');
    // Clear what an earlier test run wrote (only our own names).
    try {
      for (const e of fs.readdirSync(base, { withFileTypes: true })) {
        if (e.isFile() && /^run-\d+\.json$/.test(e.name)) fs.rmSync(path.join(base, e.name), { force: true });
        if (e.isDirectory() && fs.existsSync(path.join(base, e.name, '.repeatability'))) fs.rmSync(path.join(base, e.name), { recursive: true, force: true });
      }
    } catch { /* nothing yet */ }
    const repeat = (doc.results || []).filter((r) => (r.runs || []).length > 1);
    const pad = (n, total) => String(n).padStart(Math.max(2, String(total).length), '0');
    for (const r of repeat) {
      const target = repeat.length === 1 ? base : path.join(base, slugify(r.name || r.test_id).slice(0, 50));
      if (repeat.length > 1) {
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, '.repeatability'), `${doc.id}\n`);
      }
      r.runs.forEach((run, i) =>
        writeIfChanged(
          path.join(target, `run-${pad(i + 1, r.runs.length)}.json`),
          json({ test_run_id: doc.id, test_id: r.test_id, test: r.name, version: doc.version, run: i + 1, of: r.runs.length, matched: run.matched, status: run.status, signature: run.signature ? JSON.parse(run.signature) : null, decisions: run.decisions, rule_adherent: run.rule_adherent, output_compliant: run.output_compliant, output: run.output !== undefined ? run.output : undefined, duration_ms: run.duration_ms }),
        ),
      );
    }
  }

  writeTestSummaries(rec) {
    const list = this.store.testRuns.list((d) => d.playbook_id === rec.id && d.workspace_test).sort((a, b) => a.workspace_test - b.workspace_test);
    writeIfChanged(
      path.join(this.dirOf(rec), 'results', 'summaries', 'tests.json'),
      json({
        playbook_id: rec.id,
        count: list.length,
        test_runs: list.map((d) => ({ test_number: d.workspace_test, test_run_id: d.id, version: d.version, mode: d.mode, result: d.result_status, status: d.status, started_at: d.started_at, accuracy: d.metrics && d.metrics.metrics ? d.metrics.metrics.accuracy : null, consistency: d.metrics && d.metrics.metrics ? d.metrics.metrics.consistency : null })),
      }),
    );
  }

  // ---------------------------------------------------------------- startup

  /** Create missing workspaces and record runs / test runs that are not in a folder yet (upgrades and restarts). */
  ensureAll() {
    const ids = [];
    this.store.playbooks.forEachRaw((r) => {
      if (!r.deleted) ids.push(r.id);
    });
    for (const id of ids) this.enqueue(id, () => this.syncNow(id));
    const runs = this.store.runs.list((r) => !r.workspace_run && ids.includes(r.playbook_id)).sort((a, b) => a.started_at.localeCompare(b.started_at));
    for (const r of runs) {
      this.rememberRun(r.id, `${r.status}|${(r.approvals || []).length}|${r.ended_at || ''}`);
      this.enqueue(r.playbook_id, () => this.recordRun(r.id));
    }
    const testRuns = this.store.testRuns.list((d) => !d.workspace_test && FINISHED_TEST.has(d.status) && ids.includes(d.playbook_id)).sort((a, b) => a.started_at.localeCompare(b.started_at));
    for (const d of testRuns) {
      this.rememberTest(d.id);
      this.enqueue(d.playbook_id, () => this.recordTestRun(d.id));
    }
  }

  // ---------------------------------------------------------------- files: tree, actions, safe paths

  /** Resolve a relative path inside one playbook's workspace — the only way files are reached. */
  resolve(rec, rel) {
    if (!rec.workspace || !rec.workspace.folder) throw new HttpError(409, 'workspace_not_ready', 'The workspace for this playbook is still being prepared. Try again in a moment.');
    const root = this.dirOf(rec);
    const clean = cleanRel(rel);
    const full = clean ? path.join(root, ...clean.split('/')) : root;
    const r = path.relative(root, full);
    if (r.startsWith('..') || path.isAbsolute(r)) throw new HttpError(403, 'outside_workspace', "Paths must stay inside this playbook's workspace.");
    if (fs.existsSync(full)) {
      const realRoot = fold(fs.realpathSync.native(root));
      const real = fold(fs.realpathSync.native(full));
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new HttpError(403, 'outside_workspace', "Paths must stay inside this playbook's workspace.");
    }
    return { root, full, rel: clean };
  }

  derivedSet(rec) {
    const m = readJsonFile(path.join(this.dirOf(rec), 'metadata', 'manifest.json'));
    return new Set((m && m.derived) || []);
  }

  /** What may be done with a path. */
  classify(rel, isDir, derived) {
    if (!rel || STANDARD.has(rel)) return { kind: 'standard', rename: false, delete: false, duplicate: false, confirm: false };
    if (CRITICAL_FILES.has(rel)) return { kind: 'critical', rename: false, delete: true, duplicate: !isDir, confirm: true };
    if (rel.startsWith('inputs/')) return { kind: 'user', rename: true, delete: true, duplicate: !isDir, confirm: false };
    if (derived.has(rel)) return { kind: 'generated', rename: false, delete: true, duplicate: !isDir, confirm: true };
    return { kind: 'history', rename: true, delete: true, duplicate: !isDir, confirm: true };
  }

  async tree(id) {
    await this.idle(id);
    let rec = this.record(id);
    if (!rec.workspace || !fs.existsSync(this.dirOf(rec))) {
      await this.enqueue(id, () => this.syncNow(id));
      rec = this.record(id);
    }
    const root = this.dirOf(rec);
    const derived = this.derivedSet(rec);
    const flat = walk(root);
    const nodes = new Map();
    const top = [];
    let files = 0;
    let bytes = 0;
    for (const e of flat) {
      const st = fs.statSync(e.full);
      const node = { name: path.basename(e.full), path: e.rel, type: e.dir ? 'dir' : 'file', ...this.classify(e.rel, e.dir, derived) };
      if (e.dir) node.children = [];
      else {
        node.size = st.size;
        node.modified = st.mtime.toISOString();
        files++;
        bytes += st.size;
      }
      nodes.set(e.rel, node);
      const parent = e.rel.includes('/') ? e.rel.slice(0, e.rel.lastIndexOf('/')) : '';
      if (parent && nodes.has(parent)) nodes.get(parent).children.push(node);
      else top.push(node);
    }
    return { playbook_id: rec.id, folder: rec.workspace.folder, root, files, bytes, truncated: flat.length >= MAX_TREE_ENTRIES, tree: sortTree(top) };
  }

  fileInfo(id, rel) {
    const rec = this.record(id);
    const { full, rel: clean } = this.resolve(rec, rel);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      throw new HttpError(404, 'not_found', 'That file does not exist.');
    }
    if (!st.isFile()) throw new HttpError(400, 'not_a_file', 'That path is a folder.');
    return { rec, full, rel: clean, name: path.basename(full), size: st.size };
  }

  async upload(id, { folder, name, content_base64 }) {
    const f = cleanRel(folder);
    const m = /^inputs\/(sample|test|runtime)$/.exec(f);
    if (!m) throw new HttpError(400, 'choose_input_folder', 'Choose where the file belongs: inputs/sample, inputs/test or inputs/runtime.');
    if (typeof content_base64 !== 'string') throw new HttpError(400, 'bad_request', 'content_base64 is required.');
    const data = Buffer.from(content_base64, 'base64');
    if (data.length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'file_too_large', `Files can be up to ${MAX_UPLOAD_BYTES / 1048576} MB.`);
    const fileName = sanitizeFileName(name);
    return this.run(id, () => {
      const rec = this.ensureFolder(this.record(id));
      const { full } = this.resolve(rec, f);
      fs.mkdirSync(full, { recursive: true });
      let target = fileName;
      const ext = path.extname(fileName);
      const base = ext ? fileName.slice(0, -ext.length) : fileName;
      for (let i = 2; fs.existsSync(path.join(full, target)); i++) target = `${base} (${i})${ext}`;
      fs.writeFileSync(path.join(full, target), data);
      const saved = `${f}/${target}`;
      this.activity(rec, 'file_added', `${saved} added (${m[1]} data).`, { size: data.length });
      return { path: saved, category: m[1], size: data.length };
    });
  }

  async renamePath(id, { path: rel, name }) {
    return this.run(id, () => {
      {
        const rec = this.ensureFolder(this.record(id));
        const { full, rel: clean } = this.resolve(rec, rel);
        if (!fs.existsSync(full)) throw new HttpError(404, 'not_found', 'That file does not exist.');
        const isDir = fs.statSync(full).isDirectory();
        const c = this.classify(clean, isDir, this.derivedSet(rec));
        if (!c.rename) throw new HttpError(409, 'protected', c.kind === 'standard' ? 'The standard workspace folders cannot be renamed.' : 'This file is generated from the playbook. Rename the playbook or duplicate the file instead.');
        const next = isDir ? sanitizeName(name, { max: 80, fallback: 'folder' }) : sanitizeFileName(name);
        const parent = clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/')) : '';
        const target = this.resolve(rec, parent ? `${parent}/${next}` : next);
        if (fs.existsSync(target.full) && fold(target.full) !== fold(full)) throw new HttpError(409, 'exists', `"${next}" already exists here.`);
        fs.renameSync(full, target.full);
        this.activity(rec, 'file_renamed', `${clean} renamed to ${target.rel}.`);
        return { path: target.rel };
      }
    });
  }

  async deletePath(id, { path: rel, confirm = false }) {
    return this.run(id, () => {
      {
        const rec = this.ensureFolder(this.record(id));
        const { full, rel: clean } = this.resolve(rec, rel);
        if (!fs.existsSync(full)) throw new HttpError(404, 'not_found', 'That file does not exist.');
        const isDir = fs.statSync(full).isDirectory();
        const c = this.classify(clean, isDir, this.derivedSet(rec));
        if (!c.delete) throw new HttpError(409, 'protected', 'The standard workspace folders cannot be deleted.');
        if (c.confirm && !confirm) {
          throw new HttpError(409, 'confirm_required', c.kind === 'critical' || c.kind === 'generated' ? 'This file is part of the playbook. It will be recreated the next time the playbook changes. Confirm to delete it.' : 'Confirm to delete this item.');
        }
        fs.rmSync(full, { recursive: true, force: true });
        this.activity(rec, 'file_deleted', `${clean} deleted.`);
        return { deleted: clean, recreated_on_change: c.kind === 'critical' || c.kind === 'generated' };
      }
    });
  }

  async duplicatePath(id, { path: rel }) {
    return this.run(id, () => {
      {
        const rec = this.ensureFolder(this.record(id));
        const { full, rel: clean } = this.resolve(rec, rel);
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new HttpError(400, 'not_a_file', 'Only files can be duplicated.');
        const ext = path.extname(full);
        const base = path.basename(full, ext);
        let n = 1;
        let target;
        do {
          target = path.join(path.dirname(full), `${base} (copy${n > 1 ? ` ${n}` : ''})${ext}`);
          n++;
        } while (fs.existsSync(target));
        fs.copyFileSync(full, target);
        const out = path.relative(this.dirOf(rec), target).split(path.sep).join('/');
        this.activity(rec, 'file_duplicated', `${clean} duplicated as ${out}.`);
        return { path: out };
      }
    });
  }

  // ---------------------------------------------------------------- run inputs: test and runtime data stay apart

  /** JSON files a run can use as its input. Production runs only see inputs/runtime. */
  inputFiles(id) {
    const rec = this.record(id);
    if (!rec.workspace) return [];
    const out = [];
    for (const cat of Object.keys(INPUT_CATEGORIES)) {
      const dir = path.join(this.dirOf(rec), 'inputs', cat);
      for (const e of walk(dir)) if (!e.dir && /\.json$/i.test(e.rel)) out.push({ path: `inputs/${cat}/${e.rel}`, category: cat, size: fs.statSync(e.full).size });
    }
    return out;
  }

  readRunInput(id, rel, { environment, pb }) {
    const { full, rel: clean, size } = this.fileInfo(id, rel);
    const m = /^inputs\/(sample|test|runtime)\//.exec(clean);
    if (!m) throw new HttpError(400, 'not_an_input', 'Run inputs come from inputs/sample, inputs/test or inputs/runtime.');
    if (environment === 'production' && m[1] !== 'runtime') {
      throw new HttpError(409, 'test_data_in_production', `Production runs only read inputs/runtime. ${m[1] === 'test' ? 'Test' : 'Sample'} data stays separate from real data.`);
    }
    if (size > MAX_INPUT_BYTES) throw new HttpError(413, 'file_too_large', 'Input files can be up to 10 MB.');
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      throw new HttpError(400, 'invalid_json', `${clean} is not valid JSON.`);
    }
    const ids = (pb.inputs || []).map((i) => i.id);
    let input;
    if (isPlainObject(parsed) && (!ids.length || ids.some((k) => Object.prototype.hasOwnProperty.call(parsed, k)))) input = parsed;
    else if (ids.length === 1) input = { [ids[0]]: parsed };
    else throw new HttpError(400, 'input_shape', `${clean} must be a JSON object with the playbook's inputs (${ids.join(', ')}).`);
    return { input, source: clean, category: m[1] };
  }

  // ---------------------------------------------------------------- package and import

  async package(id) {
    await this.idle(id);
    return this.run(id, () => {
      const rec = this.ensureFolder(this.record(id));
      const root = this.dirOf(rec);
      const top = rec.workspace.folder;
      const entries = [{ name: `${top}/`, dir: true }];
      for (const e of walk(root, '', [], 50000)) {
        if (e.dir) entries.push({ name: `${top}/${e.rel}/`, dir: true });
        else entries.push({ name: `${top}/${e.rel}`, data: fs.readFileSync(e.full), mtime: fs.statSync(e.full).mtime });
      }
      const buffer = createZip(entries);
      this.activity(rec, 'package_downloaded', `Playbook package created (${entries.length} entries).`);
      return { buffer, filename: `${top}.zip`, entries: entries.length };
    });
  }

  /**
   * Read an import: a package (.zip) or a playbook JSON (.playbook.json / .json).
   * Nothing is executed. Returns what to create and what was left out.
   */
  parseImport(buffer, filename = '') {
    const warnings = [];
    const skipped = [];
    if (isZip(buffer)) {
      let entries;
      try {
        entries = readZip(buffer);
      } catch (err) {
        throw new HttpError(400, err instanceof ZipError ? err.code : 'invalid_package', err.message);
      }
      const unsafe = entries.filter((e) => e.name.startsWith('/') || /^[A-Za-z]:/.test(e.name) || e.name.split('/').includes('..'));
      if (unsafe.length) throw new HttpError(400, 'unsafe_package', `The package contains unsafe paths and was not imported (${unsafe.slice(0, 3).map((e) => e.name).join(', ')}).`);
      const files = entries.filter((e) => !e.dir);
      const firsts = new Set(entries.map((e) => e.name.split('/')[0]));
      const prefix = firsts.size === 1 && !files.some((e) => e.name === 'playbook/playbook.json') && entries.some((e) => e.name.includes('/')) ? `${[...firsts][0]}/` : '';
      const get = (rel) => files.find((e) => e.name === `${prefix}${rel}`);
      const pbEntry = get('playbook/playbook.json') || files.find((e) => /(^|\/)[^/]*\.playbook\.json$/i.test(e.name)) || get('playbook.json');
      if (!pbEntry) throw new HttpError(400, 'no_playbook', 'The package has no playbook/playbook.json, so there is nothing to import.');
      const pb = this.parseJsonEntry(pbEntry);
      const suite = get('tests/test-suite.json') ? this.parseJsonEntry(get('tests/test-suite.json'), true) : null;
      const intentFile = get('requirements/intent.json') ? this.parseJsonEntry(get('requirements/intent.json'), true) : null;
      const inputs = [];
      for (const e of files) {
        if (!e.name.startsWith(`${prefix}inputs/`)) continue;
        const rest = e.name.slice(`${prefix}inputs/`.length);
        const m = /^(sample|test|runtime)\/(.+)$/.exec(rest);
        if (!m) continue;
        let rel;
        try {
          rel = cleanRel(m[2]);
        } catch {
          warnings.push(`Skipped an input with an invalid name: ${m[2]}`);
          continue;
        }
        if (rel) inputs.push({ category: m[1], rel, data: e.data });
      }
      for (const d of ['executions', 'results', 'exports', 'versions']) {
        if (entries.some((e) => e.name.startsWith(`${prefix}${d}/`) && !e.dir)) skipped.push(d);
      }
      const tests = Array.isArray(pb.tests) && pb.tests.length ? pb.tests : suite && Array.isArray(suite.tests) ? suite.tests : [];
      const intent = intentFile && isPlainObject(intentFile.details) ? intentFile.details : null;
      return this.checkImported({ pb, tests, intent, inputs, skipped, warnings, kind: 'package', filename });
    }
    let obj;
    try {
      obj = JSON.parse(buffer.toString('utf8').replace(/^﻿/, ''));
    } catch {
      throw new HttpError(400, 'invalid_json', 'The file is neither a playbook package (.zip) nor valid JSON.');
    }
    const pb = isPlainObject(obj) && isPlainObject(obj.playbook) ? obj.playbook : obj;
    const intent = isPlainObject(obj) && isPlainObject(obj.intent) ? obj.intent : null;
    return this.checkImported({ pb, tests: Array.isArray(pb.tests) ? pb.tests : [], intent, inputs: [], skipped, warnings, kind: 'json', filename });
  }

  parseJsonEntry(entry, optional = false) {
    try {
      return JSON.parse(entry.data.toString('utf8').replace(/^﻿/, ''));
    } catch {
      if (optional) return null;
      throw new HttpError(400, 'invalid_json', `${entry.name} is not valid JSON.`);
    }
  }

  checkImported(result) {
    const pb = result.pb;
    if (!isPlainObject(pb) || !Array.isArray(pb.steps) || !pb.steps.length) throw new HttpError(400, 'no_playbook', 'This is not a playbook: it needs a JSON object with a non-empty "steps" array.');
    const clean = { ...pb, tests: [] };
    delete clean.id;
    delete clean.metadata;
    delete clean.status;
    if (clean.ai && clean.ai.connection_id) {
      clean.ai = { ...clean.ai, connection_id: null };
      result.warnings.push('The AI connection was reset: imported playbooks use the connections on this computer.');
    }
    return { ...result, pb: clean };
  }

  /** After an import: put the package's inputs into the new workspace. Nothing runs. */
  async writeImportedInputs(id, inputs, { filename } = {}) {
    await this.idle(id);
    return this.run(id, () => {
      const rec = this.ensureFolder(this.record(id));
      for (const f of inputs) {
        const { full } = this.resolve(rec, `inputs/${f.category}/${f.rel}`);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, f.data);
      }
      this.activity(rec, 'imported', `Imported from ${filename || 'a file'}${inputs.length ? ` with ${inputs.length} input file(s)` : ''}. Nothing was executed.`);
    });
  }

  /** Duplicate: the copy gets its own folder with the same input files. */
  async copyInputs(fromId, toId) {
    await this.idle(fromId);
    await this.idle(toId);
    const src = this.record(fromId);
    if (!src.workspace) return;
    const srcInputs = path.join(this.dirOf(src), 'inputs');
    return this.run(toId, () => {
      const rec = this.ensureFolder(this.record(toId));
      const dest = path.join(this.dirOf(rec), 'inputs');
      for (const e of walk(srcInputs)) {
        const target = path.join(dest, ...e.rel.split('/'));
        if (e.dir) fs.mkdirSync(target, { recursive: true });
        else if (!fs.existsSync(target)) fs.copyFileSync(e.full, target);
      }
      this.activity(rec, 'duplicated', `Duplicated from "${src.workspace.folder}" (playbook, intent, tests and inputs).`);
    });
  }

  async openFolder(id) {
    const rec = id ? this.record(id) : null;
    if (rec) await this.run(id, () => this.ensureFolder(this.record(id)));
    const dir = rec ? this.dirOf(this.record(id)) : this.baseDir;
    const opened = this.openFolderImpl ? await this.openFolderImpl(dir) : false;
    return { opened, path: dir };
  }
}
