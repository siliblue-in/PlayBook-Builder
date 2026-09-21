// Background generation tracker.
//
// Compiling a playbook takes minutes and MUST keep running no matter what the
// UI does. Two layers make that true:
//
//   1. The server owns the work. The POST /api/playbooks/generate handler
//      finishes even if the browser navigates away, and GET /api/progress/
//      gen_<session> reports the live step counter ("2 of 4").
//   2. This module remembers the task across the whole app:
//        - a module-level Map survives sidebar navigation (SPA never reloads),
//        - localStorage survives a full page reload (F5, app restart),
//        - and if both are gone, the server-side progress job is probed
//          directly when the Create screen is reopened.
//
// While the Create screen is not mounted, a corner card shows the live
// progress; clicking it returns to the generation.
import { api, poll } from './api.js';
import { h, icon, clear, toast, errorMessage } from './ui.js';

export const tasks = new Map(); // discovery session id -> task

const LS_KEY = 'pbai-active-generations';

function readSaved() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function saveSlot(sessionId, rec) {
  try {
    const all = readSaved();
    if (rec) all[sessionId] = rec;
    else delete all[sessionId];
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch {
    // storage unavailable (private mode) — the Map + server probe still cover it
  }
}

function taskHost() {
  let host = document.getElementById('bg-tasks');
  if (!host) {
    host = h('div', { id: 'bg-tasks', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(host);
  }
  return host;
}

function paintPill(task, mode) {
  if (!task.pill || !task.pill.isConnected) {
    task.pill = h('button', { type: 'button', class: 'bg-task', title: 'Playbook generation' });
    taskHost().appendChild(task.pill);
  }
  clearInterval(task.clockTimer);
  clearTimeout(task.removeTimer);
  const el = task.pill;
  el.className = `bg-task ${mode}`;
  clear(el);
  if (mode === 'running') {
    el.append(
      h('span', { class: 'spinner', style: { width: '15px', height: '15px', borderWidth: '2px' } }),
      h('span', { class: 'bg-task-label' }, pillLabel(task)),
      h('span', { class: 'bg-task-clock' }, `${Math.floor((Date.now() - task.start) / 1000)}s`),
    );
    el.onclick = () => { location.hash = `#/create/${task.sessionId}`; };
    task.clockTimer = setInterval(() => {
      const c = el.querySelector('.bg-task-clock');
      if (c) c.textContent = `${Math.floor((Date.now() - task.start) / 1000)}s`;
    }, 1000);
  } else if (mode === 'done') {
    el.append(icon('circleCheck'), h('span', null, 'Playbook ready — click to open'));
    el.onclick = () => {
      el.remove();
      if (task.result && task.result.data && task.result.data.id) location.hash = `#/playbooks/${task.result.data.id}`;
    };
    task.removeTimer = setTimeout(() => el.remove(), 15000);
  } else {
    el.append(icon('circleX'), h('span', null, 'Generation failed — click to review'));
    el.onclick = () => {
      el.remove();
      location.hash = `#/create/${task.sessionId}`;
    };
    task.removeTimer = setTimeout(() => el.remove(), 15000);
  }
}

function hidePill(task) {
  clearInterval(task.clockTimer);
  clearTimeout(task.removeTimer);
  if (task.pill) task.pill.remove();
}
// Corner card painters are shared with the Create view (attach / detach).
export { paintPill, hidePill };

/** Pill label with the live step counter from the progress registry. */
export function pillLabel(task) {
  const p = task.progress;
  if (p && !p.done && p.step_total) return `Generating playbook — step ${p.step_index} of ${p.step_total}`;
  return 'Generating playbook — it keeps running in the background';
}

/** Progress poll shared by fresh and revived tasks; purely cosmetic. */
function attachPoll(task) {
  task.poll = poll(
    () => api.get(`/api/progress/gen_${task.sessionId}`),
    {
      interval: 1500,
      onUpdate: (r) => {
        if (r && r.data && r.data.response_type === 'progress') {
          task.progress = r.data.data;
          if (!task.attached && task.pill && task.pill.isConnected) {
            const lbl = task.pill.querySelector('.bg-task-label');
            if (lbl) lbl.textContent = pillLabel(task);
          }
        }
      },
    },
  );
}

function settleTask(task) {
  task.promise.then(
    (res) => {
      task.settled = true;
      task.result = res;
      saveSlot(task.sessionId, null);
      if (task.poll) task.poll();
      if (task.attached) return; // the mounted Create view handles toast + navigation
      paintPill(task, 'done');
      toast(`Playbook generated${res.data && res.data.tests_generated ? ` · ${res.data.tests_generated} tests created` : ''} — open it from the corner card`);
    },
    (err) => {
      task.settled = true;
      task.error = err;
      saveSlot(task.sessionId, null);
      if (task.poll) task.poll();
      if (task.attached) return; // the mounted Create view shows the error banner
      paintPill(task, 'failed');
      toast(`Playbook generation failed: ${errorMessage(err)}`, 'error', 6000);
    },
  );
}

/** Start the compile for session `s` and remember it everywhere that matters. */
export function beginTask(s) {
  const task = {
    sessionId: s.id,
    start: Date.now(),
    settled: false,
    result: null,
    error: null,
    attached: false, // a live Create view is watching this task
    pill: null,
    clockTimer: null,
    removeTimer: null,
    progress: null, // latest snapshot from GET /api/progress/gen_<session>
    poll: null,
    revived: false,
  };
  task.promise = (async () => {
    if (!s.intent_confirmed) await api.post(`/api/discovery/${s.id}/confirm`, {});
    return await api.post('/api/playbooks/generate', { session_id: s.id, progress_key: s.id });
  })();
  // The slot makes the run reload-proof: after F5 or an app restart the
  // Create screen reads it and re-attaches to the still-running server job.
  saveSlot(s.id, { session: s.id, start: task.start });
  attachPoll(task);
  tasks.set(s.id, task);
  settleTask(task);
  return task;
}

/**
 * Re-create a task for a generation that is already running server-side but
 * that this page has no memory of (full reload, app restart). The original
 * POST answered nobody, so the outcome is read from the progress registry
 * and then from the discovery session.
 */
export function reviveTask(sessionId, start = Date.now()) {
  const task = {
    sessionId,
    start: Number.isFinite(start) ? start : Date.now(),
    settled: false,
    result: null,
    error: null,
    attached: false,
    pill: null,
    clockTimer: null,
    removeTimer: null,
    progress: null,
    poll: null,
    revived: true,
  };
  task.promise = (async () => {
    for (;;) {
      let snap = null;
      try {
        const r = await api.get(`/api/progress/gen_${sessionId}`);
        snap = r && r.data && r.data.data ? r.data.data : null;
      } catch (err) {
        if (err && (err.status === 404 || err.code === 'not_found')) break;
      }
      if (snap) {
        task.progress = snap;
        if (snap.done) break;
      }
      await new Promise((res) => setTimeout(res, 1500));
    }
    const env = await api.get(`/api/discovery/${sessionId}`);
    const s = env && env.data && env.data.session ? env.data.session : null;
    if (s && (s.playbook_id || s.status === 'compiled')) {
      return { data: { id: s.playbook_id, revived: true } };
    }
    const progErr = task.progress && task.progress.error;
    const err = new Error(progErr ? progErr : 'The background generation is no longer running — the app server was restarted or the generation failed while you were away. Start it again from this screen.');
    err.code = progErr ? 'GENERATION_FAILED' : 'GENERATION_LOST';
    throw err;
  })();
  saveSlot(sessionId, { session: sessionId, start: task.start });
  attachPoll(task);
  tasks.set(sessionId, task);
  settleTask(task);
  return task;
}

/**
 * Return the task to watch for this session — the in-memory one, or a revived
 * copy when a job is still running on the server. Null when nothing is
 * running (a stale localStorage slot is cleared on the way).
 */
export async function probeTask(sessionId) {
  const known = tasks.get(sessionId);
  if (known) return known;
  let snap = null;
  try {
    const r = await api.get(`/api/progress/gen_${sessionId}`);
    snap = r && r.data && r.data.data;
  } catch {
    return null; // no job tracked → nothing to revive
  }
  if (!snap || (snap.done && !snap.error)) {
    saveSlot(sessionId, null); // finished cleanly (or expired) — the Create screen shows the session state
    return null;
  }
  return reviveTask(sessionId, snap.started_at ? Date.parse(snap.started_at) : Date.now());
}

/** Called once at app boot: re-attach to runs that survived a reload. */
export function bootWatch() {
  const saved = readSaved();
  for (const [sessionId, rec] of Object.entries(saved)) {
    if (!sessionId || !rec) continue;
    probeTask(sessionId).then((task) => {
      if (task && !task.attached) {
        // Nothing mounted owns it — show the corner card until it settles.
        if (!task.settled) paintPill(task, 'running');
      }
    });
  }
}
