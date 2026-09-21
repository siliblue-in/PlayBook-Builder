// Built-in executable example (spec §38–§42): Customer Risk Evaluator.
// This is a real fixture — the deterministic engine runs it, the Test Center
// scores it, and the broken-rule variant demonstrates failure detection.

export const EXAMPLE_KEY = 'customer_risk_evaluator';

export function customerRiskEvaluator() {
  return {
    schema_version: '1.0',
    name: 'Customer Risk Evaluator',
    description: 'Classifies one customer as at_risk or healthy from the number of days since their last activity.',
    objective: 'Classify a customer as at_risk or healthy based on inactivity, using an inclusive 14-day threshold.',
    scope:
      'In scope: one customer record per run, inactivity-based classification, an explanation of the decision. Out of scope: other risk signals (billing, support, sentiment), writing to any system, contacting the customer.',
    requirements: [
      { id: 'req_01', type: 'functional', text: 'Accept one customer record containing a name and days_since_activity.' },
      {
        id: 'req_02',
        type: 'business_rule',
        text: 'A customer with no activity for 14 or more days is at_risk (the threshold is inclusive).',
        rule: { field: 'customer.days_since_activity', operator: 'greater_than_or_equal', value: 14 },
        result: 'at_risk',
      },
      {
        id: 'req_03',
        type: 'business_rule',
        text: 'A customer with activity within the last 13 days is healthy.',
        rule: { field: 'customer.days_since_activity', operator: 'less_than', value: 14 },
        result: 'healthy',
      },
      {
        id: 'req_04',
        type: 'data',
        text: 'Missing activity data must never be inferred or converted to zero; the result is insufficient_data.',
        rule: { field: 'customer.days_since_activity', operator: 'not_exists' },
        result: 'insufficient_data',
      },
      { id: 'req_05', type: 'output', text: 'Return customer, decision, days_since_activity, threshold_days, rule_applied and reason.' },
      { id: 'req_06', type: 'non_functional', text: 'Identical input and configuration must always produce the identical decision.' },
    ],
    assumptions: [
      'days_since_activity is computed upstream as whole days between the last activity and the evaluation date.',
      'Each run evaluates exactly one customer; batch evaluation is out of scope.',
      'The run input is trusted to come from the CRM export or a manual request; no live CRM lookup is needed.',
    ],
    dependencies: [
      { id: 'dep_01', type: 'data', name: 'Customer record', description: 'customer.name and customer.days_since_activity supplied in the run input.', required: true },
      { id: 'dep_02', type: 'configuration', name: 'inactivity_threshold_days', description: 'Threshold used by the inactivity rule (default 14).', required: true },
      { id: 'dep_03', type: 'ai', name: 'Execution model (AI mode only)', description: 'An AI connection (local Ollama or a cloud provider) and an execution model are needed only for AI Execution runs; deterministic runs need no AI.', required: false },
      { id: 'dep_04', type: 'workflow', name: 'Validated input before evaluation', description: 'step_02 depends on step_01; the result steps depend on the branch taken in step_02.', required: true },
    ],
    ai: { connection_id: null, model: null },
    inputs: [
      {
        id: 'customer',
        name: 'Customer',
        description: 'The customer to evaluate.',
        type: 'object',
        required: true,
        source: 'Run input (manual request, API call or CRM export)',
        validation: [
          'customer.name must be a non-empty string.',
          'customer.days_since_activity, when present, must be a whole number ≥ 0.',
          'A missing days_since_activity must be left missing — never replaced with 0 or an estimate.',
        ],
        example: { name: 'Acme Corp', days_since_activity: 21 },
        schema: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1 },
            days_since_activity: { type: ['integer', 'null'], minimum: 0 },
          },
        },
      },
    ],
    configuration: [
      { name: 'inactivity_threshold_days', type: 'integer', value: 14, min: 1, max: 365, description: 'Days without activity at which a customer becomes at_risk (inclusive).' },
    ],
    tools: [],
    permissions: [
      { action: 'Read the customer record supplied in the run input', allowed: true },
      { action: 'Produce a classification result with evidence', allowed: true },
      { action: 'Modify, create or delete customer or CRM records', allowed: false },
      { action: 'Send emails, messages or notifications', allowed: false },
      { action: 'Infer or fabricate missing activity data', allowed: false },
    ],
    trigger: { type: 'manual', description: 'Run on demand from the Runs tab or via POST /api/playbooks/:id/run.' },
    steps: [
      {
        id: 'step_01',
        name: 'Validate Input',
        type: 'validate',
        purpose: 'Confirm the customer record is complete and well-formed before any decision is made.',
        rationale: 'Decisions on malformed records are unreliable; failing early makes errors visible instead of silently wrong.',
        dependencies: [],
        inputs: ['input.customer'],
        preconditions: ['A customer object is present in the run input.'],
        instructions: [
          'Confirm customer.name is a non-empty string.',
          'If customer.days_since_activity is present, confirm it is a whole number greater than or equal to 0.',
          'If customer.days_since_activity is missing or null, record activity_status = "missing". Do not substitute 0 or any estimate.',
          'If customer.days_since_activity is present but invalid, stop with error INVALID_INPUT.',
          'Pass the validated record to step_02 unchanged.',
        ],
        decision_logic: [],
        tools: [],
        output: {
          name: 'validated_customer',
          type: 'object',
          description: 'The unchanged customer record plus activity_status (present | missing).',
          schema: { type: 'object', required: ['valid', 'activity_status'], properties: { valid: { type: 'boolean' }, activity_status: { enum: ['present', 'missing'] } } },
        },
        validation: ['customer.name is non-empty.', 'activity_status is "present" or "missing" and matches the input.'],
        postconditions: ['Every valid record continues to step_02; invalid records stop the run with INVALID_INPUT.'],
        failure_behavior: 'stop',
        retry_behavior: 'not_applicable',
        execution: {
          op: 'validate',
          subject: 'input.customer',
          checks: [
            { path: 'name', required: true, type: 'string', min_length: 1, error_code: 'INVALID_INPUT' },
            { path: 'days_since_activity', required: false, type: 'integer', minimum: 0, error_code: 'INVALID_INPUT' },
          ],
          assign: { activity_status: "if(exists(input.customer.days_since_activity), 'present', 'missing')" },
        },
      },
      {
        id: 'step_02',
        name: 'Evaluate Inactivity',
        type: 'decision',
        purpose: 'Apply the inactivity rules to decide whether the customer is at_risk, healthy or lacks data.',
        rationale: 'This is the core business rule; it must be explicit and machine-checkable so tests can verify the boundary.',
        dependencies: ['step_01'],
        inputs: ['steps.step_01.validated_customer', 'input.customer.days_since_activity', 'config.inactivity_threshold_days'],
        preconditions: ['step_01 completed successfully.', 'inactivity_threshold_days is a positive integer.'],
        instructions: [
          'If days_since_activity is missing, return insufficient_data (rule_00). Do not guess a value.',
          'Otherwise compare days_since_activity with inactivity_threshold_days.',
          'If days_since_activity is greater than or equal to the threshold, return at_risk (rule_01). 14 days is at_risk.',
          'Otherwise return healthy (rule_02).',
          'Record the rule id and the compared values as evidence.',
        ],
        decision_logic: [
          { rule_id: 'rule_00', condition: 'days_since_activity is missing', result: 'insufficient_data', next: 'step_05' },
          { rule_id: 'rule_01', condition: 'days_since_activity >= inactivity_threshold_days', result: 'at_risk', next: 'step_03' },
          { rule_id: 'rule_02', condition: 'otherwise (days_since_activity < inactivity_threshold_days)', result: 'healthy', next: 'step_04' },
        ],
        tools: [],
        output: {
          name: 'risk_decision',
          type: 'object',
          description: 'The decision (at_risk | healthy | insufficient_data), the rule applied and its evidence.',
          schema: { type: 'object', required: ['result', 'rule_id'], properties: { result: { enum: ['at_risk', 'healthy', 'insufficient_data'] }, rule_id: { type: 'string' } } },
        },
        validation: ['Exactly one rule is applied.', 'The decision references the compared days_since_activity and threshold.'],
        postconditions: ['state.decision and state.decision_rule are set.'],
        failure_behavior: 'stop',
        retry_behavior: 'not_applicable',
        execution: { op: 'decide', subject: 'input.customer', rules: ['rule_00', 'rule_01', 'rule_02'], assign: 'decision' },
      },
      {
        id: 'step_03',
        name: 'Record At-Risk Evidence',
        type: 'transform',
        purpose: 'Explain why the customer was flagged as at_risk.',
        rationale: 'Every flagged record must carry evidence so a person can verify the decision.',
        dependencies: ['step_02'],
        inputs: ['state.decision', 'input.customer.days_since_activity', 'config.inactivity_threshold_days'],
        preconditions: ['step_02 returned at_risk.'],
        instructions: [
          'Write the reason using the actual days_since_activity and the configured threshold.',
          'State that the threshold is inclusive.',
          'Do not add facts that are not in the input.',
        ],
        decision_logic: [],
        tools: [],
        output: { name: 'reason', type: 'string', description: 'One-sentence explanation of the at_risk decision.' },
        validation: ['The reason mentions the number of inactive days and the threshold.'],
        failure_behavior: 'stop',
        retry_behavior: 'not_applicable',
        execution: {
          op: 'set',
          values: { reason: "concat('No activity for ', input.customer.days_since_activity, ' days, which meets or exceeds the ', config.inactivity_threshold_days, '-day threshold.')" },
        },
      },
      {
        id: 'step_04',
        name: 'Record Healthy Evidence',
        type: 'transform',
        purpose: 'Explain why the customer is healthy.',
        rationale: 'Healthy decisions also need evidence so boundary behavior can be audited.',
        dependencies: ['step_02'],
        inputs: ['state.decision', 'input.customer.days_since_activity', 'config.inactivity_threshold_days'],
        preconditions: ['step_02 returned healthy.'],
        instructions: ['Write the reason using the actual days_since_activity and the configured threshold.', 'Do not add facts that are not in the input.'],
        decision_logic: [],
        tools: [],
        output: { name: 'reason', type: 'string', description: 'One-sentence explanation of the healthy decision.' },
        validation: ['The reason mentions the number of inactive days and the threshold.'],
        failure_behavior: 'stop',
        retry_behavior: 'not_applicable',
        execution: {
          op: 'set',
          values: { reason: "concat('Last activity ', input.customer.days_since_activity, ' days ago, below the ', config.inactivity_threshold_days, '-day threshold.')" },
        },
      },
      {
        id: 'step_05',
        name: 'Record Missing Data',
        type: 'transform',
        purpose: 'Explain that no decision could be made because activity data is missing.',
        rationale: 'Missing data must be surfaced, not hidden behind a guessed classification.',
        dependencies: ['step_02'],
        inputs: ['state.decision', 'input.customer.name'],
        preconditions: ['step_02 returned insufficient_data.'],
        instructions: ['State that days_since_activity is missing.', 'State that no value was inferred.'],
        decision_logic: [],
        tools: [],
        output: { name: 'reason', type: 'string', description: 'Explanation that activity data is missing.' },
        validation: ['The reason states that days_since_activity is missing.'],
        failure_behavior: 'stop',
        retry_behavior: 'not_applicable',
        execution: { op: 'set', values: { reason: "'days_since_activity is missing; the decision was not inferred.'" } },
      },
      {
        id: 'step_06',
        name: 'Assemble Result',
        type: 'output',
        purpose: 'Build the final result object from the decision and its evidence.',
        rationale: 'A fixed output contract lets tests compare structured fields instead of free text.',
        dependencies: ['step_03', 'step_04', 'step_05'],
        inputs: ['input.customer', 'state.decision', 'state.decision_rule', 'state.reason', 'config.inactivity_threshold_days'],
        preconditions: ['Exactly one of step_03, step_04 or step_05 completed.'],
        instructions: [
          'Set customer to customer.name.',
          'Set decision to the result of step_02.',
          'Copy days_since_activity as given (null when missing).',
          'Set threshold_days to the configured threshold.',
          'Set rule_applied to the id of the rule that matched.',
          'Set reason to the explanation from the branch step.',
        ],
        decision_logic: [],
        tools: [],
        output: { name: 'result', type: 'object', description: 'The final result matching the output contract.' },
        validation: ['All required output fields are present.'],
        failure_behavior: 'stop',
        retry_behavior: 'not_applicable',
        execution: {
          op: 'output',
          mapping: {
            customer: 'input.customer.name',
            decision: 'state.decision',
            days_since_activity: 'coalesce(input.customer.days_since_activity, null)',
            threshold_days: 'config.inactivity_threshold_days',
            rule_applied: 'state.decision_rule',
            reason: 'state.reason',
          },
        },
      },
      {
        id: 'step_07',
        name: 'Validate Output',
        type: 'validate',
        purpose: 'Check the result against the output contract before it is returned.',
        rationale: 'Output validation catches contract drift and unsupported values before anyone relies on them.',
        dependencies: ['step_06'],
        inputs: ['steps.step_06.result', 'output.schema'],
        preconditions: ['step_06 produced a result.'],
        instructions: [
          'Validate the result against the output schema.',
          'Confirm decision is at_risk, healthy or insufficient_data.',
          'Confirm decision equals at_risk exactly when days_since_activity ≥ threshold_days.',
          'Stop with OUTPUT_INVALID if any check fails.',
        ],
        decision_logic: [],
        tools: [],
        output: { name: 'validation_report', type: 'object', description: '{ valid: true } when every check passes.' },
        validation: ['No unsupported values are returned.'],
        failure_behavior: 'stop',
        retry_behavior: 'not_applicable',
        execution: {
          op: 'validate_output',
          checks: [
            {
              expression: "output.decision == 'insufficient_data' || ((output.days_since_activity >= output.threshold_days) == (output.decision == 'at_risk'))",
              message: 'decision must be at_risk exactly when days_since_activity ≥ threshold_days',
            },
          ],
        },
      },
    ],
    decision_rules: [
      {
        id: 'rule_00',
        name: 'Missing Activity',
        step_id: 'step_02',
        priority: 0,
        when: { field: 'days_since_activity', operator: 'not_exists' },
        result: 'insufficient_data',
        description: 'Missing activity data is never inferred.',
      },
      {
        id: 'rule_01',
        name: 'Inactivity Rule',
        step_id: 'step_02',
        priority: 1,
        when: { field: 'days_since_activity', operator: 'greater_than_or_equal', value_ref: 'config.inactivity_threshold_days' },
        result: 'at_risk',
        description: 'Inclusive threshold: 14 days of inactivity is at_risk.',
      },
      {
        id: 'rule_02',
        name: 'Recent Activity',
        step_id: 'step_02',
        priority: 2,
        when: { otherwise: true },
        result: 'healthy',
        description: 'Applies when no earlier rule matched (days_since_activity below the threshold).',
      },
    ],
    output: {
      format: 'json',
      description: 'One classification result per run.',
      sections: [],
      fields: [
        { name: 'customer', type: 'string', required: true, description: 'Customer name from the input.' },
        { name: 'decision', type: 'string', required: true, enum: ['at_risk', 'healthy', 'insufficient_data'], description: 'Classification.' },
        { name: 'days_since_activity', type: 'integer', required: false, nullable: true, description: 'Input value; null when missing.' },
        { name: 'threshold_days', type: 'integer', required: true, description: 'Threshold used.' },
        { name: 'rule_applied', type: 'string', required: true, description: 'Id of the rule that matched.' },
        { name: 'reason', type: 'string', required: true, description: 'Evidence-based explanation.' },
      ],
      schema: {
        type: 'object',
        required: ['customer', 'decision', 'threshold_days', 'rule_applied', 'reason'],
        properties: {
          customer: { type: 'string', minLength: 1 },
          decision: { type: 'string', enum: ['at_risk', 'healthy', 'insufficient_data'] },
          days_since_activity: { type: ['integer', 'null'] },
          threshold_days: { type: 'integer' },
          rule_applied: { type: 'string' },
          reason: { type: 'string', minLength: 1 },
        },
      },
      example: { customer: 'Acme Corp', decision: 'at_risk', days_since_activity: 21, threshold_days: 14, rule_applied: 'rule_01', reason: 'No activity for 21 days, which meets or exceeds the 14-day threshold.' },
    },
    validation: [
      { id: 'val_01', level: 'step', rule: 'Each step produces the output declared in its output schema.' },
      { id: 'val_02', level: 'workflow', rule: 'Exactly one branch of step_02 executes; the other branch steps are skipped.' },
      { id: 'val_03', level: 'output', rule: 'The result validates against the output schema and decision is one of the allowed values.' },
      { id: 'val_04', level: 'intent', rule: 'The decision is based only on inactivity and the inclusive 14-day threshold the user confirmed.' },
    ],
    error_handling: {
      default_strategy: 'stop',
      strategies: [
        { id: 'err_01', on: 'INVALID_INPUT', strategy: 'stop', notes: 'Malformed input stops the run; nothing is guessed.' },
        { id: 'err_02', on: 'MISSING_INPUT', strategy: 'request_input', notes: 'Ask for the missing customer record.' },
        { id: 'err_03', on: 'timeout', strategy: 'retry', then: 'stop', notes: 'AI mode only: retry provider timeouts, then stop. Never fabricate a decision.' },
        { id: 'err_04', on: 'OUTPUT_INVALID', strategy: 'stop', notes: 'Do not return a result that breaks the output contract.' },
      ],
      retry: { enabled: true, max_attempts: 2, retry_on: ['timeout', 'temporary_provider_error'], backoff_seconds: 2 },
    },
    success_criteria: [
      { id: 'sc_01', text: 'The customer record is evaluated exactly once.' },
      { id: 'sc_02', text: 'The decision follows rule_00–rule_02 with the configured threshold.' },
      { id: 'sc_03', text: '14 days of inactivity is classified as at_risk (inclusive boundary).' },
      { id: 'sc_04', text: 'Missing activity yields insufficient_data and is never converted to 0.' },
      { id: 'sc_05', text: 'The result contains customer, decision, threshold_days, rule_applied and reason.' },
      { id: 'sc_06', text: 'Repeated runs with identical input return identical decisions.' },
    ],
    tests: [],
  };
}

export function customerRiskTests(repeatRuns = 20) {
  const t = (id, name, category, description, customer, expected, covers, extra = {}) => ({
    id,
    name,
    category,
    description,
    input: { customer },
    expected,
    runs: 1,
    covers,
    source: 'builtin',
    ...extra,
  });
  return [
    t('tc_01', 'Normal Risk', 'normal', '21 days of inactivity is at_risk.', { name: 'Acme Corp', days_since_activity: 21 }, { customer: 'Acme Corp', decision: 'at_risk' }, { requirements: ['req_01', 'req_02', 'req_05'], rules: ['rule_01'] }),
    t('tc_02', 'Normal Healthy', 'normal', '3 days since activity is healthy.', { name: 'Initech', days_since_activity: 3 }, { customer: 'Initech', decision: 'healthy' }, { requirements: ['req_01', 'req_03', 'req_05'], rules: ['rule_02'] }),
    t('tc_03', 'Boundary 13', 'boundary', 'One day below the threshold stays healthy.', { name: 'Boundary Co', days_since_activity: 13 }, { customer: 'Boundary Co', decision: 'healthy' }, { requirements: ['req_03'], rules: ['rule_02'] }),
    t('tc_04', 'Boundary 14', 'boundary', 'Exactly at the threshold is at_risk (inclusive).', { name: 'Boundary Co', days_since_activity: 14 }, { customer: 'Boundary Co', decision: 'at_risk' }, { requirements: ['req_02'], rules: ['rule_01'] }),
    t('tc_05', 'Boundary 15', 'boundary', 'One day above the threshold is at_risk.', { name: 'Boundary Co', days_since_activity: 15 }, { customer: 'Boundary Co', decision: 'at_risk' }, { requirements: ['req_02'], rules: ['rule_01'] }),
    t('tc_06', 'Missing Activity', 'missing_data', 'Missing days_since_activity must not be inferred.', { name: 'Globex' }, { customer: 'Globex', decision: 'insufficient_data' }, { requirements: ['req_04'], rules: ['rule_00'] }),
    {
      ...t('tc_07', 'Repeatability', 'repeatability', `The same input run ${repeatRuns} times must return the same decision every time.`, { name: 'Acme Corp', days_since_activity: 21 }, { customer: 'Acme Corp', decision: 'at_risk' }, { requirements: ['req_06'], rules: ['rule_01'] }),
      runs: repeatRuns,
    },
  ];
}

/** JSON Patch that introduces the spec's boundary bug: `>=` becomes `>` (§42). */
export function boundaryBugPatch(pb) {
  const i = (pb.decision_rules || []).findIndex((r) => r.id === 'rule_01');
  if (i < 0) return null;
  const s = (pb.steps || []).findIndex((x) => x.id === 'step_02');
  const ops = [{ op: 'replace', path: `/decision_rules/${i}/when/operator`, value: 'greater_than' }];
  if (s >= 0) {
    const b = (pb.steps[s].decision_logic || []).findIndex((x) => x.rule_id === 'rule_01');
    if (b >= 0) ops.push({ op: 'replace', path: `/steps/${s}/decision_logic/${b}/condition`, value: 'days_since_activity > inactivity_threshold_days' });
  }
  return ops;
}
