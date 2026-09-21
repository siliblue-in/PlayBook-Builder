// Long-operation progress registry (v1.7). Compiling a playbook (or
// generating an AI test suite) can take minutes on a local model. The HTTP
// request that runs the work only answers when it is finished, so the UI needs
// a second, tiny endpoint to watch the work happen: GET /api/progress/:key.
//
// The worker registers a job under a client-chosen key, reports step
// transitions ("1 of 4"), and the UI polls a snapshot. Everything is
// in-memory: a job disappears after a TTL once it is finished (and the final
// state lingers briefly so the last poll can observe completion).
import { nowIso } from './util.js';

const jobs = new Map();
const JOB_TTL_MS = 30 * 60 * 1000; // hard cap for abandoned jobs
const DONE_TTL_MS = 2 * 60 * 1000; // keep finished snapshots around for late polls

/** Allowed step statuses. */
const STATUSES = new Set(['pending', 'active', 'done', 'failed']);

function sweep() {
  const now = Date.now();
  for (const [key, job] of jobs) {
    const age = now - Date.parse(job.updated_at || job.started_at || 0);
    const limit = job.done ? DONE_TTL_MS : JOB_TTL_MS;
    if (age > limit) jobs.delete(key);
  }
}

/**
 * Register a job with its full step list (labels shown in the UI, in order).
 * `key` is client-chosen (e.g. the discovery session id) so the UI can poll
 * before the long request answers.
 */
export function beginJob(key, steps, meta = {}) {
  if (!key) return null;
  const job = {
    key,
    steps: (Array.isArray(steps) ? steps : []).map((s) => ({
      id: String(s.id || s),
      label: String(s.label || s.id || s),
      status: 'pending',
      detail: null,
    })),
    meta,
    started_at: nowIso(),
    updated_at: nowIso(),
    done: false,
    error: null,
  };
  jobs.set(key, job);
  sweep();
  return job;
}

/** Move one step to a status (default: active) and attach a detail line. */
export function setStep(key, stepId, { status = 'active', detail = undefined } = {}) {
  const job = jobs.get(key);
  if (!job) return null;
  const step = job.steps.find((s) => s.id === stepId);
  if (!step) return null;
  if (STATUSES.has(status)) step.status = status;
  if (detail !== undefined) step.detail = detail === null ? null : String(detail);
  job.updated_at = nowIso();
  return step;
}

/** Update only the detail line of a step without touching its status. */
export function setDetail(key, stepId, detail) {
  return setStep(key, stepId, { detail });
}

/**
 * Mark the job finished. When `error` is given, the active step becomes
 * "failed" and the message is stored; otherwise the active step becomes
 * "done". Finished snapshots linger for DONE_TTL_MS so the last poll can
 * still observe completion.
 */
export function finishJob(key, error = null) {
  const job = jobs.get(key);
  if (!job) return null;
  const active = job.steps.find((s) => s.status === 'active');
  if (error) {
    if (active) active.status = 'failed';
    job.error = String(error && error.message ? error.message : error);
  } else if (active) {
    active.status = 'done';
  }
  job.done = true;
  job.updated_at = nowIso();
  return job;
}

/** Numbered view for the UI: active step index (1-based), total, steps. */
export function snapshot(key) {
  const job = jobs.get(key);
  if (!job) return null;
  let index = job.steps.findIndex((s) => s.status === 'active');
  if (index === -1 && !job.done) {
    const firstPending = job.steps.findIndex((s) => s.status === 'pending');
    index = firstPending === -1 ? job.steps.length - 1 : firstPending;
  }
  const total = job.steps.length;
  return {
    key: job.key,
    done: job.done,
    error: job.error,
    started_at: job.started_at,
    step_index: job.done ? total : index + 1,
    step_total: total,
    steps: job.steps.map((s) => ({ id: s.id, label: s.label, status: s.status, detail: s.detail })),
    meta: job.meta,
  };
}

/** No-op reporter used when a caller did not ask for progress. */
export const nullReporter = {
  begin: () => {},
  step: () => {},
  detail: () => {},
  finish: () => {},
  key: null,
};

/**
 * Reporter object handed to pipeline workers. With a key it maps to the
 * registry; without one every call is a no-op, so workers never need to care
 * whether progress was requested.
 */
export function reporter(key) {
  if (!key) return nullReporter;
  return {
    key,
    begin: (steps, meta) => beginJob(key, steps, meta),
    step: (stepId, status, detail) => setStep(key, stepId, { status, detail }),
    detail: (stepId, detail) => setDetail(key, stepId, detail),
    finish: (error) => finishJob(key, error),
  };
}

/** Test hook: drop every registered job. */
export function resetProgress() {
  jobs.clear();
}
