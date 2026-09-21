// Execution Engine (spec §61): runs a playbook version on real input,
// enforcing policies (sandbox vs production, Production Actions, permissions,
// human approval), with logs, pause/resume for approvals, and validation.
import { HttpError } from '../http.js';
import { newId, nowIso, deepClone, isPlainObject } from '../util.js';
import { executeDeterministic } from './deterministic.js';
import { executeWithAI } from './ai-executor.js';
import { createToolRunner } from './tools.js';
import { validateSchema, formatSchemaErrors } from './jsonschema.js';

const IMMUTABLE = new Set(['published', 'production']);
const MAX_LOGS = 500;

export class RunService {
  constructor({ store, settings, playbooks, ai }) {
    this.store = store;
    this.settings = settings;
    this.playbooks = playbooks;
    this.ai = ai;
    this.active = new Map();
  }

  get(id) {
    const r = this.store.runs.get(id);
    if (!r) throw new HttpError(404, 'not_found', 'Run not found.');
    return r;
  }

  view(r) {
    const { resume, ...rest } = r;
    return rest;
  }

  list({ playbookId, status, limit = 100 } = {}) {
    return this.store.runs
      .list((r) => (!playbookId || r.playbook_id === playbookId) && (!status || r.status === status))
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        playbook_id: r.playbook_id,
        playbook_name: r.playbook_name,
        version: r.version,
        version_status: r.version_status,
        mode: r.mode,
        environment: r.environment,
        trigger: r.trigger,
        status: r.status,
        started_at: r.started_at,
        ended_at: r.ended_at,
        duration_ms: r.duration_ms,
        error: r.error ? { code: r.error.code, message: r.error.message } : null,
        usage: r.usage || null,
        model: r.model || null,
        pending_approvals: (r.approvals || []).filter((a) => a.status === 'pending').length,
      }));
  }

  /**
   * Start a run.
   * body: { version, input, mode: deterministic|ai, environment: sandbox|production, configuration, trigger, wait }
   */
  async start(playbookId, body = {}) {
    const settings = this.settings.get();
    const rec = this.playbooks.get(playbookId);
    const ver = body.version !== undefined && body.version !== null && body.version !== '' ? this.playbooks.version(rec, body.version) : this.playbooks.runnableVersion(rec);
    const published = IMMUTABLE.has(ver.status);
    const environment = body.environment === 'production' ? 'production' : body.environment === 'sandbox' ? 'sandbox' : published ? 'production' : 'sandbox';
    if (environment === 'production' && !published) {
      throw new HttpError(409, 'not_published', `v${ver.version} is a ${ver.status} version. Publish it before running in production, or run it in the sandbox.`);
    }
    const mode = body.mode === 'ai' ? 'ai' : 'deterministic';
    const input = isPlainObject(body.input) ? body.input : {};
    const pb = deepClone(ver.playbook);
    let aiContext = null;
    if (mode === 'ai') {
      const r = this.ai.resolve('execution', { connectionId: pb.ai.connection_id || undefined, model: pb.ai.model || undefined });
      aiContext = { connectionId: r.conn.id, model: r.model };
    }
    const run = {
      id: newId('run'),
      playbook_id: rec.id,
      playbook_name: pb.name,
      version: ver.version,
      version_status: ver.status,
      hash: ver.hash,
      mode,
      environment,
      trigger: body.trigger || 'manual',
      status: 'running',
      input,
      // Where the input came from: a workspace file (inputs/runtime/…) or the app.
      input_source: typeof body.input_source === 'string' ? body.input_source : null,
      configuration: isPlainObject(body.configuration) ? body.configuration : {},
      output: null,
      error: null,
      warnings: [],
      validation: null,
      trace: [],
      decisions: [],
      logs: [],
      approvals: [],
      pending_approval: null,
      policy: {
        production_actions: settings.features.production_actions,
        human_approval: settings.features.human_approval,
        tool_calling: settings.features.tool_calling,
        require_validation: settings.behavior.require_validation,
      },
      model: aiContext ? aiContext.model : null,
      connection_id: aiContext ? aiContext.connectionId : null,
      usage: null,
      started_at: nowIso(),
      ended_at: null,
      duration_ms: null,
    };
    // Required inputs must be present before anything executes.
    const missing = (pb.inputs || []).filter((i) => i.required && (input[i.id] === undefined || input[i.id] === null)).map((i) => i.id);
    const schemaIssues = [];
    for (const i of pb.inputs || []) {
      if (input[i.id] !== undefined && i.schema) schemaIssues.push(...formatSchemaErrors(validateSchema(input[i.id], { ...i.schema, required: [] }, `input.${i.id}`), 5));
    }
    this.log(run, 'info', `Run started: ${pb.name} v${ver.version} (${mode}, ${environment}).`);
    if (missing.length) {
      run.status = 'needs_input';
      run.error = { code: 'MISSING_INPUT', message: `Missing required input: ${missing.join(', ')}.`, missing };
      this.finish(run);
      this.store.runs.put(run);
      return this.view(run);
    }
    if (schemaIssues.length) this.log(run, 'warn', `Input does not match the declared schema: ${schemaIssues.join('; ')}`);
    this.store.runs.put(run);
    const p = this.execute(run.id).catch((err) => {
      const r = this.store.runs.get(run.id);
      if (!r) return;
      r.status = 'failed';
      r.error = { code: err.code || 'ENGINE_ERROR', message: err.message };
      this.finish(r);
      this.store.runs.put(r);
    });
    if (body.wait) await p;
    return this.view(this.get(run.id));
  }

  log(run, level, message, step_id, data) {
    run.logs.push({ ts: nowIso(), level, message, ...(step_id ? { step_id } : {}), ...(data ? { data } : {}) });
    if (run.logs.length > MAX_LOGS) run.logs.splice(0, run.logs.length - MAX_LOGS);
  }

  finish(run) {
    run.ended_at = nowIso();
    run.duration_ms = Date.parse(run.ended_at) - Date.parse(run.started_at);
    run.pending_approval = null;
    if (run.status === 'completed') this.log(run, 'info', 'Run completed.');
  }

  async execute(runId) {
    const run = this.get(runId);
    const rec = this.playbooks.get(run.playbook_id);
    const ver = this.playbooks.version(rec, run.version);
    const pb = deepClone(ver.playbook);
    const settings = this.settings.get();
    const flag = { cancelled: false };
    this.active.set(run.id, flag);
    const onEvent = (e) => this.log(run, e.level, e.message, e.step_id, e.data);
    const approvedMap = new Map(run.approvals.filter((a) => a.status !== 'pending').map((a) => [a.key, a.status]));
    const toolRunner = createToolRunner({
      input: run.input,
      settings: { ...settings, features: { ...settings.features, production_actions: run.policy.production_actions, human_approval: run.policy.human_approval } },
      environment: run.environment,
      approved: (key) => approvedMap.get(key),
      onEvent,
    });
    const stepApprovals = {};
    for (const a of run.approvals) if (a.kind === 'step' && a.status !== 'pending') stepApprovals[a.step_id] = a.status;

    let result;
    try {
      if (run.mode === 'deterministic') {
        result = await executeDeterministic(pb, {
          input: run.input,
          configuration: run.configuration,
          now: new Date(run.started_at),
          approvals: run.policy.human_approval ? stepApprovals : {},
          autoApprove: !run.policy.human_approval,
          toolRunner,
          requireValidation: run.policy.require_validation,
          onEvent,
          resume: run.resume || null,
          signal: flag,
        });
      } else {
        result = await executeWithAI(pb, {
          ai: this.ai,
          input: run.input,
          configuration: run.configuration,
          now: new Date(run.started_at),
          connectionId: run.connection_id,
          model: run.model,
          temperature: settings.testing.execution_temperature,
          toolRunner,
          toolCalling: run.policy.tool_calling,
          requireValidation: run.policy.require_validation,
          onEvent,
          resume: run.resume || null,
          signal: flag,
        });
      }
    } finally {
      this.active.delete(run.id);
    }

    const latest = this.get(run.id);
    latest.logs = run.logs;
    // A cancel that landed while the last step was still executing must win:
    // the executor only checks the flag between steps, so it can return
    // "completed" after the run was already recorded as cancelled.
    if (latest.status === 'cancelled' && result.status !== 'awaiting_approval') {
      latest.trace = result.trace || [];
      latest.decisions = result.decisions || [];
      if (result.usage) latest.usage = result.usage;
      this.store.runs.put(latest);
      return latest;
    }
    latest.status = result.status;
    latest.output = result.output ?? null;
    latest.error = result.error || null;
    latest.warnings = result.warnings || [];
    latest.validation = result.validation || null;
    latest.trace = result.trace || [];
    latest.decisions = result.decisions || [];
    if (result.usage) latest.usage = result.usage;
    if (result.model) latest.model = result.model;
    if (result.status === 'awaiting_approval') {
      const pa = result.pending_approval || {};
      const approval = {
        id: newId('ap'),
        kind: pa.tool_id || pa.key ? 'tool' : 'step',
        key: pa.key || (pa.tool_call_id ? `call:${pa.tool_call_id}` : `step:${pa.step_id}`),
        step_id: pa.step_id || null,
        tool_id: pa.tool_id || null,
        reason: pa.reason || 'Human approval required.',
        args: pa.args || null,
        status: 'pending',
        requested_at: nowIso(),
      };
      latest.approvals.push(approval);
      latest.pending_approval = approval;
      latest.resume = result.resume;
      this.log(latest, 'info', `Waiting for approval: ${approval.reason}`, approval.step_id);
    } else {
      latest.resume = undefined;
      this.finish(latest);
    }
    this.store.runs.put(latest);
    return latest;
  }

  async decide(runId, approvalId, { decision, note } = {}) {
    const run = this.get(runId);
    const a = run.approvals.find((x) => x.id === approvalId);
    if (!a) throw new HttpError(404, 'not_found', 'Approval not found.');
    if (a.status !== 'pending') throw new HttpError(409, 'already_decided', 'This approval was already decided.');
    if (!['approve', 'approved', 'reject', 'rejected'].includes(decision)) throw new HttpError(400, 'bad_request', 'decision must be "approve" or "reject".');
    a.status = decision.startsWith('approve') ? 'approved' : 'rejected';
    a.decided_at = nowIso();
    a.note = note ? String(note).slice(0, 500) : '';
    run.pending_approval = null;
    run.status = 'running';
    this.log(run, 'info', `Approval ${a.status}${a.note ? `: ${a.note}` : ''}.`, a.step_id);
    this.store.runs.put(run);
    const p = this.execute(run.id).catch((err) => {
      const r = this.store.runs.get(run.id);
      r.status = 'failed';
      r.error = { code: err.code || 'ENGINE_ERROR', message: err.message };
      this.finish(r);
      this.store.runs.put(r);
    });
    await p;
    return this.view(this.get(run.id));
  }

  cancel(runId) {
    const run = this.get(runId);
    const flag = this.active.get(runId);
    if (flag) flag.cancelled = true;
    if (run.status === 'awaiting_approval' || run.status === 'running') {
      run.status = 'cancelled';
      run.error = { code: 'CANCELLED', message: 'Run was cancelled.' };
      run.resume = undefined;
      for (const a of run.approvals) if (a.status === 'pending') a.status = 'cancelled';
      this.finish(run);
      this.store.runs.put(run);
    }
    return this.view(run);
  }
}
