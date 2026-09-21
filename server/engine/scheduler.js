// Scheduled Playbooks (spec §12, §52). Runs the production (or latest
// published) version of playbooks whose trigger is "schedule" and whose
// schedule is enabled, using local time on this machine.

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
// Common spellings that mean "Monday to Friday"; an unknown name must never
// silently become Saturday (index -1) or the 1st of the month (NaN).
const WEEKDAY_ALIASES = new Set(['weekday', 'weekdays', 'workday', 'workdays']);

function parseTime(t) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(String(t || '').trim());
  if (!m) return { h: 9, m: 0 };
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (m[3]) {
    const pm = m[3].toLowerCase() === 'pm';
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  return { h: Math.min(23, h), m: Math.min(59, min) };
}

/** Next occurrence strictly after `after` (Date) for a schedule trigger. */
export function nextRun(trigger, after = new Date()) {
  const freq = String(trigger.frequency || 'daily').toLowerCase();
  const { h, m } = parseTime(trigger.time);
  const base = new Date(after.getTime());
  const every = /every\s+(\d+)\s*(minute|min|hour)/.exec(freq);
  if (typeof trigger.interval_minutes === 'number' && trigger.interval_minutes > 0) return new Date(after.getTime() + trigger.interval_minutes * 60000);
  if (every) return new Date(after.getTime() + Number(every[1]) * (every[2].startsWith('hour') ? 3600000 : 60000));
  if (/hour/.test(freq)) {
    const d = new Date(base);
    d.setMinutes(m, 0, 0);
    if (d <= after) d.setHours(d.getHours() + 1);
    return d;
  }
  const rawDay = String(trigger.day ?? '').toLowerCase().trim();
  if (/week/.test(freq) || DAYS.includes(rawDay) || WEEKDAY_ALIASES.has(rawDay)) {
    const d = new Date(base);
    d.setHours(h, m, 0, 0);
    if (WEEKDAY_ALIASES.has(rawDay)) {
      // "weekday": the next Monday–Friday occurrence strictly after `after`.
      for (;;) {
        if (d <= after || d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
        else return d;
      }
    }
    const target = DAYS.indexOf(rawDay || 'monday');
    if (target !== -1) {
      let add = (target - d.getDay() + 7) % 7;
      if (add === 0 && d <= after) add = 7;
      d.setDate(d.getDate() + add);
      return d;
    }
    console.warn(`[scheduler] Unknown schedule day "${trigger.day}"; treating the schedule as daily at ${h}:${String(m).padStart(2, '0')}.`);
    // Fall through to the daily branch instead of guessing a weekday.
  }
  if (/month/.test(freq)) {
    const dm = /^\s*(\d{1,2})/.exec(String(trigger.day ?? ''));
    const day = Math.min(28, Math.max(1, dm ? Number(dm[1]) : 1));
    const d = new Date(base.getFullYear(), base.getMonth(), day, h, m, 0, 0);
    if (d <= after) d.setMonth(d.getMonth() + 1);
    return d;
  }
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  if (d <= after) d.setDate(d.getDate() + 1);
  return d;
}

export class Scheduler {
  constructor({ store, settings, playbooks, runs, intervalMs = 30000 }) {
    this.store = store;
    this.settings = settings;
    this.playbooks = playbooks;
    this.runs = runs;
    this.intervalMs = intervalMs;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((err) => console.warn('[scheduler]', err.message)), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Upcoming scheduled runs, for the UI. */
  upcoming() {
    const out = [];
    for (const rec of this.store.playbooks.list((r) => !r.deleted && !r.archived && r.schedule && r.schedule.enabled)) {
      const ver = this.playbooks.runnableVersion(rec);
      if (!ver || !['published', 'production'].includes(ver.status) || ver.playbook.trigger.type !== 'schedule') continue;
      const after = rec.schedule.last_run_at ? new Date(rec.schedule.last_run_at) : new Date(rec.schedule.enabled_at || Date.now());
      out.push({ playbook_id: rec.id, name: rec.name, version: ver.version, next_run_at: nextRun(ver.playbook.trigger, after).toISOString() });
    }
    return out.sort((a, b) => a.next_run_at.localeCompare(b.next_run_at));
  }

  async tick(now = new Date()) {
    if (!this.settings.get().features.scheduled_playbooks) return [];
    const started = [];
    for (const item of this.upcoming()) {
      if (new Date(item.next_run_at) > now) continue;
      const rec = this.store.playbooks.get(item.playbook_id);
      rec.schedule.last_run_at = now.toISOString();
      this.store.playbooks.put(rec);
      try {
        const run = await this.runs.start(rec.id, { version: item.version, input: rec.schedule.input || {}, trigger: 'schedule', environment: 'production' });
        started.push(run.id);
      } catch (err) {
        console.warn(`[scheduler] ${rec.name}: ${err.message}`);
      }
    }
    return started;
  }
}
