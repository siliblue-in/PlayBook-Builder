// Test metrics (spec §37, §41, §46) and PASS / WARNING / FAIL status.
// Metrics describe performance on the configured tests only — they are not
// guarantees of correctness for every possible input.
import { round } from '../util.js';

const FUNCTIONAL_EXCLUDED = new Set(['repeatability']);
const ERROR_CATEGORIES = new Set(['negative', 'missing_data', 'error_handling']);

function ratio(n, d) {
  return d > 0 ? n / d : null;
}

export function metricStatus(value, thresholds) {
  if (value === null || value === undefined) return null;
  if (value >= thresholds.pass - 1e-9) return 'pass';
  if (value >= thresholds.warning - 1e-9) return 'warning';
  return 'fail';
}

const worst = (statuses) => (statuses.includes('fail') ? 'fail' : statuses.includes('warning') ? 'warning' : 'pass');

/** Status of a single test from its runs. */
export function testStatus(result, thresholds) {
  const runs = result.runs || [];
  if (result.skipped) return 'skipped';
  if (!runs.length) return 'fail';
  const accuracy = ratio(runs.filter((r) => r.matched).length, runs.length);
  // The evaluator's semantic verdict decides semantic-only tests; for tests with
  // deterministic expectations it can only downgrade a pass to a warning.
  const evaluatorFailed = Boolean(result.evaluation && result.evaluation.passed === false);
  if (runs.length === 1) {
    if (!runs[0].matched || (result.semantic_only && evaluatorFailed)) return 'fail';
    return evaluatorFailed ? 'warning' : 'pass';
  }
  const agreement = result.agreement ?? 1;
  const s = worst([metricStatus(accuracy, thresholds), metricStatus(agreement, thresholds)].filter(Boolean));
  return s === 'pass' && evaluatorFailed ? 'warning' : s;
}

/**
 * Aggregate metrics for a test run.
 * @param results per-test results (each with runs[], category, covers, evaluation)
 * @param pb playbook (for requirement / rule / branch coverage)
 * @param thresholds { pass, warning }
 */
export function computeMetrics(results, pb, thresholds, { repeatabilityEnabled = true } = {}) {
  const executed = results.filter((r) => !r.skipped);
  const runs = executed.flatMap((r) => r.runs || []);
  const judged = runs.filter((r) => r.matched !== null && r.matched !== undefined);
  const accuracy = ratio(judged.filter((r) => r.matched).length, judged.length);

  const repeat = executed.filter((r) => (r.runs || []).length > 1);
  const consistency = repeatabilityEnabled && repeat.length ? repeat.reduce((s, r) => s + (r.agreement ?? 0), 0) / repeat.length : null;

  const adherenceRuns = runs.filter((r) => r.rule_adherent === true || r.rule_adherent === false);
  const ruleAdherence = ratio(adherenceRuns.filter((r) => r.rule_adherent).length, adherenceRuns.length);

  const complianceRuns = runs.filter((r) => r.output_compliant === true || r.output_compliant === false);
  const outputCompliance = ratio(complianceRuns.filter((r) => r.output_compliant).length, complianceRuns.length);

  const reqIds = (pb.requirements || []).map((r) => r.id);
  const covered = new Set();
  for (const r of executed) for (const id of (r.covers && r.covers.requirements) || []) if (reqIds.includes(id)) covered.add(id);
  const requirementCoverage = reqIds.length ? covered.size / reqIds.length : null;

  const ruleIds = (pb.decision_rules || []).map((r) => r.id);
  const rulesHit = new Set();
  const resultsSeen = new Set();
  for (const run of runs) {
    for (const d of run.decisions || []) {
      if (d.rule_id) rulesHit.add(d.rule_id);
      resultsSeen.add(`${d.step_id}:${d.result}`);
    }
  }
  const branches = [];
  for (const s of pb.steps || []) for (const b of s.decision_logic || []) if (b.result !== undefined && b.result !== '') branches.push(`${s.id}:${b.result}`);
  const uniqueBranches = [...new Set(branches)];
  const ruleCoverage = ruleIds.length ? ruleIds.filter((id) => rulesHit.has(id)).length / ruleIds.length : null;
  const branchCoverage = uniqueBranches.length ? uniqueBranches.filter((b) => resultsSeen.has(b)).length / uniqueBranches.length : null;

  const errorTests = executed.filter((r) => ERROR_CATEGORIES.has(r.category));
  const errorHandling = ratio(errorTests.filter((r) => r.status === 'pass').length, errorTests.length);

  const byCategory = {};
  for (const r of results) {
    const c = r.category || 'other';
    byCategory[c] = byCategory[c] || { total: 0, passed: 0, warning: 0, failed: 0, skipped: 0 };
    byCategory[c].total++;
    if (r.status === 'pass') byCategory[c].passed++;
    else if (r.status === 'warning') byCategory[c].warning++;
    else if (r.status === 'skipped') byCategory[c].skipped++;
    else byCategory[c].failed++;
  }

  const evaluated = executed.filter((r) => r.evaluation && typeof r.evaluation.task_alignment === 'number');
  const taskAlignment = evaluated.length ? evaluated.reduce((s, r) => s + r.evaluation.task_alignment, 0) / evaluated.length : null;
  const semanticCoverage = evaluated.filter((r) => typeof r.evaluation.requirement_coverage === 'number');
  const evaluatorCoverage = semanticCoverage.length ? semanticCoverage.reduce((s, r) => s + r.evaluation.requirement_coverage, 0) / semanticCoverage.length : null;

  // Latency of the executed runs (spec v2 §13) — the only metric that differs
  // meaningfully between a cloud model and one running on this computer.
  const durations = runs.map((r) => r.duration_ms).filter((d) => typeof d === 'number' && Number.isFinite(d)).sort((a, b) => a - b);
  const latency = durations.length
    ? {
        runs: durations.length,
        avg_ms: Math.round(durations.reduce((s, d) => s + d, 0) / durations.length),
        median_ms: durations[Math.floor((durations.length - 1) / 2)],
        p95_ms: durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)],
        min_ms: durations[0],
        max_ms: durations[durations.length - 1],
      }
    : null;

  const functional = executed.filter((r) => !FUNCTIONAL_EXCLUDED.has(r.category) && (r.runs || []).length <= 1);
  const functionalPassed = functional.filter((r) => r.status === 'pass').length;
  const repeatRuns = repeat.flatMap((r) => r.runs);

  const metrics = {
    task_alignment: taskAlignment,
    requirement_coverage: requirementCoverage,
    rule_adherence: ruleAdherence,
    accuracy,
    consistency,
    output_compliance: outputCompliance,
    error_handling: errorHandling,
    rule_coverage: ruleCoverage,
    branch_coverage: branchCoverage,
    evaluator_requirement_coverage: evaluatorCoverage,
  };
  for (const k of Object.keys(metrics)) metrics[k] = metrics[k] === null ? null : round(metrics[k], 4);

  const statuses = {
    accuracy: metricStatus(metrics.accuracy, thresholds),
    consistency: metricStatus(metrics.consistency, thresholds),
    rule_adherence: metricStatus(metrics.rule_adherence, thresholds),
    output_compliance: metricStatus(metrics.output_compliance, thresholds),
    task_alignment: metricStatus(metrics.task_alignment, { pass: thresholds.alignment_pass ?? 0.85, warning: thresholds.alignment_warning ?? 0.7 }),
    requirement_coverage: metrics.requirement_coverage === null ? null : metrics.requirement_coverage >= 1 - 1e-9 ? 'pass' : 'warning',
  };

  const reasons = [];
  const skippedCount = results.filter((r) => r.skipped).length;
  if (skippedCount && executed.length) reasons.push(`${skippedCount} test(s) skipped: ${results.find((r) => r.skipped).skip_reason || 'not evaluable in this mode'}`);
  const failedFunctional = functional.filter((r) => r.status === 'fail');
  if (failedFunctional.length) reasons.push(`${failedFunctional.length} functional test(s) failed: ${failedFunctional.map((r) => r.name).join(', ')}.`);
  for (const r of repeat) if (r.status !== 'pass') reasons.push(`${r.name}: ${Math.round((r.agreement ?? 0) * 100)}% decision agreement over ${r.runs.length} runs.`);
  for (const [k, s] of Object.entries(statuses)) {
    if (s && s !== 'pass' && k !== 'accuracy' && k !== 'consistency') reasons.push(`${k.replace(/_/g, ' ')} is ${Math.round((metrics[k] ?? 0) * 100)}%.`);
  }
  if (metrics.requirement_coverage !== null && metrics.requirement_coverage < 1) {
    const missing = reqIds.filter((id) => !covered.has(id));
    reasons.push(`Requirements without tests: ${missing.join(', ')}.`);
  }

  let status;
  const skipped = results.filter((r) => r.skipped);
  if (!executed.length && skipped.length) {
    status = 'inconclusive';
    reasons.unshift(skipped[0].skip_reason || 'No test could be evaluated in this mode.');
  } else if (!executed.length) {
    status = 'fail';
    reasons.push('No tests were executed.');
  } else if (failedFunctional.length || repeat.some((r) => r.status === 'fail')) status = 'fail';
  else status = worst([...Object.values(statuses).filter(Boolean), ...repeat.map((r) => r.status)]);

  return {
    status,
    reasons,
    metrics,
    statuses,
    latency,
    counts: {
      tests: results.length,
      executed: executed.length,
      passed: executed.filter((r) => r.status === 'pass').length,
      warnings: executed.filter((r) => r.status === 'warning').length,
      failed: executed.filter((r) => r.status === 'fail').length,
      skipped: results.length - executed.length,
      functional_total: functional.length,
      functional_passed: functionalPassed,
      repeatability_tests: repeat.length,
      repeatability_runs: repeatRuns.length,
      repeatability_matched: repeatRuns.filter((r) => r.matched).length,
      total_runs: runs.length,
      correct_runs: judged.filter((r) => r.matched).length,
    },
    coverage: {
      requirements_covered: [...covered],
      requirements_uncovered: reqIds.filter((id) => !covered.has(id)),
      rules_exercised: ruleIds.filter((id) => rulesHit.has(id)),
      rules_not_exercised: ruleIds.filter((id) => !rulesHit.has(id)),
      branches_taken: uniqueBranches.filter((b) => resultsSeen.has(b)),
      branches_not_taken: uniqueBranches.filter((b) => !resultsSeen.has(b)),
    },
    by_category: byCategory,
    thresholds,
    disclaimer: 'These metrics describe performance on the configured tests; they are not guarantees of correctness for every possible input.',
  };
}
