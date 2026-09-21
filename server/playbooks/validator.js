// Structural validation + the Playbook Quality Gate (spec §64).
import { buildGraph } from '../../shared/graph.js';
import { checkCondition, normalizeOperator } from '../engine/rules.js';
import { checkExpression } from '../engine/expr.js';
import { STEP_TYPES, EXECUTION_OPS, FAILURE_STRATEGIES } from './schema.js';

const VAGUE = [
  'use your judgment',
  'use your judgement',
  'use judgment',
  'use judgement',
  'analyze intelligently',
  'analyse intelligently',
  'figure out',
  'understand the data',
  'do your best',
  'as you see fit',
  'somehow',
  'whatever is needed',
  'be smart about',
];

export function vaguePhrases(text) {
  const s = String(text || '').toLowerCase();
  return VAGUE.filter((p) => s.includes(p));
}

function expressionsIn(execution) {
  const out = [];
  if (!execution || typeof execution !== 'object') return out;
  const add = (v, where) => {
    if (typeof v === 'string') out.push({ expr: v, where });
  };
  if (execution.assign && typeof execution.assign === 'object') for (const [k, v] of Object.entries(execution.assign)) add(v, `assign.${k}`);
  if (execution.values && typeof execution.values === 'object') for (const [k, v] of Object.entries(execution.values)) add(v, `values.${k}`);
  if (execution.mapping && typeof execution.mapping === 'object') for (const [k, v] of Object.entries(execution.mapping)) add(v, `mapping.${k}`);
  if (execution.value && typeof execution.value === 'object') for (const [k, v] of Object.entries(execution.value)) add(v, `value.${k}`);
  if (execution.args && typeof execution.args === 'object') for (const [k, v] of Object.entries(execution.args)) add(v, `args.${k}`);
  for (const [i, p] of (Array.isArray(execution.preconditions) ? execution.preconditions : []).entries()) add(p, `preconditions[${i}]`);
  if (typeof execution.fallback === 'string') add(execution.fallback, 'fallback');
  return out;
}

/** Structural validation. Returns { valid, errors: [...], warnings: [...] }. */
export function validatePlaybook(pb) {
  const errors = [];
  const warnings = [];
  const err = (code, message, where) => errors.push({ code, message, ...(where ? { where } : {}) });
  const warn = (code, message, where) => warnings.push({ code, message, ...(where ? { where } : {}) });

  if (!pb || typeof pb !== 'object') {
    err('NOT_AN_OBJECT', 'Playbook must be a JSON object.');
    return { valid: false, errors, warnings };
  }
  if (!pb.name) err('MISSING_NAME', 'Playbook needs a name.');
  if (!pb.objective) err('MISSING_OBJECTIVE', 'Playbook needs an objective.');
  const steps = Array.isArray(pb.steps) ? pb.steps : [];
  if (!steps.length) err('NO_STEPS', 'Playbook has no workflow steps. It must describe the procedure, not a final answer.');

  const graph = buildGraph(pb, { terminals: false });
  for (const issue of graph.issues) err(issue.code, issue.message, issue.step_id);

  const toolIds = new Set((pb.tools || []).flatMap((t) => [t.id, t.name && t.name.toLowerCase()]));
  const configNames = new Set((pb.configuration || []).map((c) => c.name));
  const rulesByStep = new Map();
  for (const r of pb.decision_rules || []) {
    if (!rulesByStep.has(r.step_id)) rulesByStep.set(r.step_id, []);
    rulesByStep.get(r.step_id).push(r);
  }
  const stepIds = new Set(steps.map((s) => s.id));

  for (const s of steps) {
    const where = s.id;
    if (!STEP_TYPES.includes(s.type)) err('INVALID_STEP_TYPE', `Step ${s.id} has an unknown type "${s.type}".`, where);
    if (!s.purpose) warn('STEP_NO_PURPOSE', `Step ${s.id} has no purpose.`, where);
    if (!Array.isArray(s.instructions) || !s.instructions.length) warn('STEP_NO_INSTRUCTIONS', `Step ${s.id} has no instructions.`, where);
    if (!FAILURE_STRATEGIES.includes(s.failure_behavior)) err('INVALID_FAILURE_BEHAVIOR', `Step ${s.id} has an unknown failure behavior.`, where);
    for (const t of s.tools || []) {
      if (!toolIds.has(t) && !toolIds.has(String(t).toLowerCase())) err('UNKNOWN_TOOL', `Step ${s.id} uses tool "${t}", which is not declared in the Tools section.`, where);
    }
    if (s.type === 'decision') {
      const branches = s.decision_logic || [];
      if (!branches.length) err('DECISION_WITHOUT_LOGIC', `Decision step ${s.id} has no decision logic.`, where);
      else if (branches.length < 2) warn('DECISION_SINGLE_BRANCH', `Decision step ${s.id} has only one branch; add the alternative outcome.`, where);
      for (const b of branches) if (!b.result) err('BRANCH_WITHOUT_RESULT', `A branch of ${s.id} has no result.`, where);
      if (!rulesByStep.has(s.id) && !(s.execution && s.execution.op === 'decide')) {
        warn('DECISION_NOT_MACHINE_READABLE', `Decision step ${s.id} has no machine-readable decision rules; deterministic tests cannot check it.`, where);
      }
      for (const b of branches) {
        for (const t of [].concat(b.next || [])) {
          const target = steps.find((x) => x.id === t);
          if (target && !(target.dependencies || []).includes(s.id)) {
            warn('BRANCH_TARGET_NOT_DEPENDENT', `Step ${t} is a branch of ${s.id} but does not list it as a dependency.`, t);
          }
        }
      }
    }
    for (const ref of (s.inputs || []).join(' ').match(/(?:config|configuration)\.([A-Za-z0-9_]+)/g) || []) {
      const name = ref.split('.')[1];
      if (configNames.size && !configNames.has(name)) warn('UNKNOWN_CONFIG_REFERENCE', `Step ${s.id} references ${ref}, which is not defined in configuration.`, where);
    }
    const ex = s.execution;
    if (ex) {
      if (!EXECUTION_OPS.includes(ex.op)) warn('UNKNOWN_EXECUTION_OP', `Step ${s.id} execution op "${ex.op}" is not supported; deterministic mode will treat it as non-deterministic.`, where);
      for (const { expr, where: w } of expressionsIn(ex)) {
        const problem = checkExpression(expr);
        if (problem) warn('INVALID_EXPRESSION', `Step ${s.id} execution ${w}: ${problem}.`, where);
      }
      if (ex.op === 'decide') {
        const ids = Array.isArray(ex.rules) ? ex.rules : [];
        for (const id of ids) if (!(pb.decision_rules || []).some((r) => r.id === id)) err('UNKNOWN_RULE', `Step ${s.id} uses rule "${id}", which does not exist.`, where);
      }
      if (ex.op === 'tool' && ex.tool_id && !toolIds.has(ex.tool_id)) err('UNKNOWN_TOOL', `Step ${s.id} execution calls undeclared tool "${ex.tool_id}".`, where);
    }
  }

  for (const r of pb.decision_rules || []) {
    const where = r.id;
    if (r.step_id && !stepIds.has(r.step_id)) err('RULE_UNKNOWN_STEP', `Rule ${r.id} refers to step "${r.step_id}", which does not exist.`, where);
    for (const p of checkCondition(r.when, configNames)) err('INVALID_RULE', `Rule ${r.id} ${p}.`, where);
    if (r.result === undefined || r.result === '') err('RULE_WITHOUT_RESULT', `Rule ${r.id} has no result.`, where);
    const step = steps.find((s) => s.id === r.step_id);
    if (step && step.decision_logic && step.decision_logic.length) {
      const results = step.decision_logic.map((b) => String(b.result));
      if (!results.includes(String(r.result))) warn('RULE_RESULT_NOT_A_BRANCH', `Rule ${r.id} returns "${r.result}", which is not a branch of ${step.id}.`, where);
    }
    if (r.when && r.when.operator && !normalizeOperator(r.when.operator)) err('INVALID_OPERATOR', `Rule ${r.id} uses unknown operator "${r.when.operator}".`, where);
  }

  for (const c of pb.configuration || []) {
    if (c.type === 'enum' && Array.isArray(c.allowed_values) && c.value !== null && !c.allowed_values.includes(c.value)) {
      err('CONFIG_NOT_ALLOWED', `Configuration ${c.name} = ${JSON.stringify(c.value)} is not one of its allowed values.`, c.name);
    }
    if ((c.type === 'number' || c.type === 'integer') && c.value !== null && typeof c.value !== 'number') {
      err('CONFIG_TYPE', `Configuration ${c.name} must be a number.`, c.name);
    }
    if (typeof c.value === 'number' && ((typeof c.min === 'number' && c.value < c.min) || (typeof c.max === 'number' && c.value > c.max))) {
      err('CONFIG_RANGE', `Configuration ${c.name} is outside its allowed range.`, c.name);
    }
  }

  if (!pb.inputs || !pb.inputs.length) warn('NO_INPUTS', 'No inputs are defined.');
  if (!pb.output || (!pb.output.fields?.length && !pb.output.schema && !pb.output.sections?.length)) warn('OUTPUT_UNDEFINED', 'The output contract has no fields, schema or sections.');

  return { valid: errors.length === 0, errors, warnings };
}

/** Quality gate (spec §64). Returns { passed, checks: [{id,label,passed,details}], stats }. */
export function qualityGate(pb) {
  const v = validatePlaybook(pb);
  const steps = Array.isArray(pb?.steps) ? pb.steps : [];
  const checks = [];
  const check = (id, label, passed, details = []) => checks.push({ id, label, passed: Boolean(passed), details });

  const objectiveWords = String(pb?.objective || '').trim().split(/\s+/).filter(Boolean).length;
  check('objective', 'Objective is explicit', objectiveWords >= 4, objectiveWords >= 4 ? [] : ['State what the playbook achieves in at least one full sentence.']);

  const reqs = pb?.requirements || [];
  check('requirements', 'Requirements are explicit', reqs.length > 0 && reqs.every((r) => r.text), reqs.length ? [] : ['Add functional, data, business-rule and output requirements.']);

  const deps = pb?.dependencies || [];
  check('dependencies', 'Dependencies are defined', deps.length > 0, deps.length ? [] : ['List the data, system, tool, permission and workflow dependencies.']);

  const tools = pb?.tools || [];
  const toolProblems = tools.filter((t) => !t.purpose).map((t) => `Tool ${t.name} has no purpose.`);
  const undeclared = v.errors.filter((e) => e.code === 'UNKNOWN_TOOL').map((e) => e.message);
  check('tools', 'Tools are defined', Array.isArray(pb?.tools) && !toolProblems.length && !undeclared.length, [...toolProblems, ...undeclared, ...(tools.length ? [] : ['No tools declared (valid when every input is supplied directly).'])].slice(0, 6));

  const inputs = pb?.inputs || [];
  const inputProblems = inputs.filter((i) => !i.type || !i.source).map((i) => `Input ${i.name} needs a type and source.`);
  check('inputs', 'Inputs are defined', inputs.length > 0 && !inputProblems.length, inputs.length ? inputProblems : ['Define at least one input with type, source and validation.']);

  const noPurpose = steps.filter((s) => !s.purpose).map((s) => s.id);
  check('step_purpose', 'Every step has a purpose', steps.length && !noPurpose.length, noPurpose.map((id) => `${id} has no purpose.`));

  const noInputs = steps.filter((s) => !s.inputs || !s.inputs.length).map((s) => s.id);
  check('step_inputs', 'Every step has inputs', steps.length && !noInputs.length, noInputs.map((id) => `${id} has no inputs.`));

  const noDeps = steps.filter((s) => !Array.isArray(s.dependencies)).map((s) => s.id);
  const roots = steps.filter((s) => Array.isArray(s.dependencies) && !s.dependencies.length).length;
  check('step_dependencies', 'Every step has dependencies', steps.length && !noDeps.length && roots <= Math.max(1, steps.length), [
    ...noDeps.map((id) => `${id} does not declare dependencies.`),
    ...(roots ? [`${roots} entry step(s) with no upstream dependency.`] : []),
  ]);

  const thin = [];
  for (const s of steps) {
    if (!s.instructions || s.instructions.length < 2) thin.push(`${s.id} needs at least 2 concrete instructions.`);
    const vague = vaguePhrases((s.instructions || []).join(' '));
    if (vague.length) thin.push(`${s.id} uses vague language: "${vague.join('", "')}".`);
  }
  check('step_instructions', 'Every step has detailed instructions', steps.length && !thin.length, thin.slice(0, 8));

  const decisionSteps = steps.filter((s) => s.type === 'decision');
  const decisionProblems = [];
  for (const s of decisionSteps) {
    if (!s.decision_logic || s.decision_logic.length < 2) decisionProblems.push(`${s.id} needs every outcome spelled out (at least 2 branches).`);
    const hasRules = (pb.decision_rules || []).some((r) => r.step_id === s.id) || (s.execution && s.execution.op === 'decide');
    if (!hasRules) decisionProblems.push(`${s.id} has no machine-readable decision rules.`);
  }
  if (!decisionSteps.length && (pb?.decision_rules || []).length === 0) decisionProblems.length = 0;
  check('decision_logic', 'Decision logic is explicit', !decisionProblems.length && !v.errors.some((e) => ['INVALID_RULE', 'INVALID_OPERATOR', 'RULE_WITHOUT_RESULT'].includes(e.code)), [
    ...decisionProblems,
    ...v.errors.filter((e) => ['INVALID_RULE', 'INVALID_OPERATOR', 'RULE_WITHOUT_RESULT'].includes(e.code)).map((e) => e.message),
    ...(decisionSteps.length ? [] : ['No decision steps in this workflow.']),
  ]);

  const out = pb?.output || {};
  const outputProblems = [];
  if (!out.format) outputProblems.push('Output format is missing.');
  if (!out.fields?.length && !out.schema && !out.sections?.length) outputProblems.push('Output needs fields, a schema or sections.');
  for (const s of steps) if (!s.output || !s.output.name) outputProblems.push(`${s.id} has no expected output.`);
  check('outputs', 'Outputs are defined', !outputProblems.length, outputProblems.slice(0, 6));

  const valProblems = [];
  if (!(pb?.validation || []).length) valProblems.push('Add workflow, output and intent validation rules.');
  for (const s of steps) if (!s.validation || !s.validation.length) valProblems.push(`${s.id} has no validation.`);
  check('validation', 'Validation exists', !valProblems.length, valProblems.slice(0, 6));

  const eh = pb?.error_handling || {};
  const ehProblems = [];
  if (!eh.default_strategy && !(eh.strategies || []).length) ehProblems.push('Define error handling strategies.');
  for (const s of steps) if (!s.failure_behavior) ehProblems.push(`${s.id} has no failure behavior.`);
  check('error_handling', 'Error handling exists', !ehProblems.length, ehProblems);

  const sc = pb?.success_criteria || [];
  check('success_criteria', 'Success criteria exist', sc.length > 0, sc.length ? [] : ['Add measurable success criteria.']);

  const graphErrors = v.errors.filter((e) => ['CIRCULAR_DEPENDENCY', 'MISSING_DEPENDENCY', 'SELF_DEPENDENCY', 'MISSING_BRANCH_TARGET', 'DUPLICATE_STEP_ID'].includes(e.code));
  check('no_cycles', 'No circular dependencies', !graphErrors.length, graphErrors.map((e) => e.message));

  check('json_valid', 'Playbook JSON is valid', v.valid, v.errors.map((e) => e.message).slice(0, 8));

  const machine = steps.filter((s) => s.execution && s.execution.op && s.execution.op !== 'llm').length;
  return {
    passed: checks.every((c) => c.passed),
    checks,
    errors: v.errors,
    warnings: v.warnings,
    stats: {
      steps: steps.length,
      decision_steps: decisionSteps.length,
      rules: (pb?.decision_rules || []).length,
      machine_executable_steps: machine,
      deterministic_coverage: steps.length ? machine / steps.length : 0,
    },
  };
}
