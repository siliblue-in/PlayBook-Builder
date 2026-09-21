// Global controls (spec §52), AI behaviour controls (§53), testing thresholds
// and appearance (§54). Stored in data/settings.json and validated on update.
import { deepClone, deepMerge, isPlainObject } from './util.js';

export const DEFAULT_SETTINGS = {
  features: {
    intent_discovery: true,
    dynamic_questions: true,
    multiple_choice: true,
    objective_confirmation: true,
    playbook_generation: true,
    visual_workflow: true,
    markdown_export: true,
    pdf_export: true,
    json_export: true,
    automatic_test_generation: true,
    repeatability_testing: true,
    regression_testing: true,
    ai_evaluation: true,
    tool_calling: true,
    scheduled_playbooks: true,
    human_approval: true,
    production_actions: false,
  },
  behavior: {
    max_clarification_rounds: 5,
    max_questions_per_round: 1,
    require_objective_confirmation: true,
    show_assumptions: true,
    require_validation: true,
    require_tests_before_publish: true,
    default_repeatability_runs: 20,
  },
  testing: {
    default_mode: 'deterministic',
    pass_threshold: 1.0,
    warning_threshold: 0.9,
    alignment_pass_threshold: 0.85,
    alignment_warning_threshold: 0.7,
    ai_concurrency: 3,
    execution_temperature: 0,
  },
  appearance: {
    theme: 'system',
    compact_mode: false,
    reduced_motion: false,
    show_advanced_controls: false,
    show_execution_logs: true,
    show_cost_information: true,
  },
  ai: {
    default_connection_id: null,
    // Privacy Mode (feature spec v2 §14): cloud_allowed | local_preferred | local_only.
    privacy_mode: 'cloud_allowed',
    // Budget for ONE AI request before it is treated as timed out. Local
    // models on a CPU can take minutes for a single answer; the default is
    // deliberately generous and can be raised further in Settings.
    request_timeout_minutes: 10,
  },
};

const LIMITS = {
  'behavior.max_clarification_rounds': [1, 15],
  'behavior.max_questions_per_round': [1, 5],
  'behavior.default_repeatability_runs': [2, 100],
  'testing.pass_threshold': [0.5, 1],
  'testing.warning_threshold': [0, 1],
  'testing.alignment_pass_threshold': [0.5, 1],
  'testing.alignment_warning_threshold': [0, 1],
  'testing.ai_concurrency': [1, 10],
  'testing.execution_temperature': [0, 2],
  'ai.request_timeout_minutes': [1, 120],
};

const ENUMS = {
  'appearance.theme': ['light', 'dark', 'system'],
  'testing.default_mode': ['deterministic', 'ai'],
  'ai.privacy_mode': ['cloud_allowed', 'local_preferred', 'local_only'],
};

/** Validate a merged settings object against the defaults' shape. Returns a list of problems. */
function validate(settings) {
  const problems = [];
  for (const [section, defaults] of Object.entries(DEFAULT_SETTINGS)) {
    const values = settings[section];
    if (!isPlainObject(values)) {
      problems.push(`${section} must be an object`);
      continue;
    }
    for (const [key, def] of Object.entries(defaults)) {
      const v = values[key];
      const pathKey = `${section}.${key}`;
      if (def === null) continue; // free-form (ids)
      if (typeof def === 'boolean' && typeof v !== 'boolean') problems.push(`${pathKey} must be true or false`);
      if (typeof def === 'number') {
        if (typeof v !== 'number' || !Number.isFinite(v)) problems.push(`${pathKey} must be a number`);
        else if (LIMITS[pathKey] && (v < LIMITS[pathKey][0] || v > LIMITS[pathKey][1])) {
          problems.push(`${pathKey} must be between ${LIMITS[pathKey][0]} and ${LIMITS[pathKey][1]}`);
        }
      }
      if (typeof def === 'string') {
        if (typeof v !== 'string') problems.push(`${pathKey} must be text`);
        else if (ENUMS[pathKey] && !ENUMS[pathKey].includes(v)) problems.push(`${pathKey} must be one of ${ENUMS[pathKey].join(', ')}`);
      }
    }
  }
  if (settings.testing && settings.testing.warning_threshold > settings.testing.pass_threshold) {
    problems.push('testing.warning_threshold cannot exceed testing.pass_threshold');
  }
  if (settings.testing && settings.testing.alignment_warning_threshold > settings.testing.alignment_pass_threshold) {
    problems.push('testing.alignment_warning_threshold cannot exceed testing.alignment_pass_threshold');
  }
  return problems;
}

export class SettingsService {
  constructor(store) {
    this.store = store;
    const saved = store.readSettings();
    this.value = deepMerge(DEFAULT_SETTINGS, isPlainObject(saved) ? saved : {});
    // Drop unknown sections/keys from older files.
    for (const section of Object.keys(this.value)) if (!(section in DEFAULT_SETTINGS)) delete this.value[section];
    if (validate(this.value).length) this.value = deepClone(DEFAULT_SETTINGS);
    if (!saved) store.writeSettings(this.value);
    this.listeners = [];
  }

  /** Be told after every change (used to keep playbook workspaces current). */
  onChange(fn) {
    this.listeners.push(fn);
  }

  changed() {
    for (const fn of this.listeners) {
      try {
        fn(this.get());
      } catch { /* a listener must never break a settings change */ }
    }
  }

  get() {
    return deepClone(this.value);
  }

  feature(name) {
    return Boolean(this.value.features[name]);
  }

  update(patch) {
    if (!isPlainObject(patch)) throw Object.assign(new Error('Settings update must be an object.'), { status: 400, code: 'bad_request' });
    const clean = {};
    for (const [section, values] of Object.entries(patch)) {
      if (!(section in DEFAULT_SETTINGS) || !isPlainObject(values)) continue;
      clean[section] = {};
      for (const [k, v] of Object.entries(values)) if (k in DEFAULT_SETTINGS[section]) clean[section][k] = v;
    }
    const next = deepMerge(this.value, clean);
    const problems = validate(next);
    if (problems.length) {
      throw Object.assign(new Error(`Invalid settings: ${problems.join('; ')}.`), { status: 400, code: 'invalid_settings', details: problems });
    }
    this.value = next;
    this.store.writeSettings(next);
    this.changed();
    return this.get();
  }

  reset() {
    const keepConnection = this.value.ai.default_connection_id;
    const keepPrivacy = this.value.ai.privacy_mode;
    this.value = deepClone(DEFAULT_SETTINGS);
    this.value.ai.default_connection_id = keepConnection;
    this.value.ai.privacy_mode = keepPrivacy;
    this.store.writeSettings(this.value);
    this.changed();
    return this.get();
  }
}
