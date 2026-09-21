// Scripted AI provider for offline self-tests. It recognises each role by its
// system prompt and returns realistic, typed envelopes — including a messy
// first compiler draft that must go through the quality-gate repair loop, and
// an optional "flaky" execution mode for repeatability warnings.
import { AIProvider, registerProvider } from '../server/ai/provider.js';
import { executeDeterministic } from '../server/engine/deterministic.js';
import { normalizePlaybook } from '../server/playbooks/schema.js';

export const mockState = { compilerCalls: 0, executionCalls: 0, flakyEvery: 0, useTools: true, calls: [], testPlanCalls: 0, testBatchCalls: 0, testFailBatch: 0, testEmptyBatch: 0 };

function opportunityPlaybook(draft) {
  return {
    name: 'Weekly Opportunity Risk Report',
    description: 'Flags inactive sales opportunities every Monday and produces a risk report.',
    objective: 'Identify inactive sales opportunities every Monday and produce a risk report.',
    scope: { in_scope: ['Active opportunities'], out_of_scope: ['Closed deals', 'CRM updates'] },
    requirements: {
      functional: ['Read active sales opportunities.', 'Evaluate inactivity for each opportunity.', 'Produce a report of flagged opportunities.'],
      data: ['Opportunity ID', 'Opportunity name', 'Owner', 'Last activity date'],
      business_rules: [{ text: 'No activity for 14 or more days = attention required.', rule: { field: 'days_since_activity', operator: '>=', value: 14 }, result: 'attention_required' }],
      output: ['Flagged count, total and flagged opportunity ids plus a report.'],
    },
    assumptions: 'Activity dates are ISO dates.\nThe CRM export contains every active opportunity.',
    dependencies: { systems: ['CRM access'], ai: ['Connected OpenRouter provider'], data: ['Opportunity records', 'Activity history'], permissions: ['Read access to CRM opportunities'] },
    inputs: [
      {
        id: 'opportunities',
        name: 'Active Opportunities',
        type: 'array',
        required: true,
        source: 'CRM',
        validation: ['Each opportunity must contain an ID.', 'Each opportunity must contain a name.'],
        example: [
          { id: 'op1', name: 'Acme renewal', owner: 'Dana', last_activity_date: '2026-08-01' },
          { id: 'op2', name: 'Globex expansion', owner: 'Lee', last_activity_date: '2099-01-01' },
        ],
      },
    ],
    configuration: { inactivity_threshold_days: 14, report_format: { value: 'markdown', allowed_values: ['markdown', 'json', 'table'], description: 'Report format.' } },
    tools: [{ name: 'CRM Read API', purpose: 'Retrieve active opportunity records.', permission: 'Read-only', required: 'yes', binding: { type: 'input', key: 'opportunities' } }],
    permissions: { allowed: ['Read CRM opportunities', 'Generate internal report'], not_allowed: ['Modify CRM records', 'Send external messages'] },
    trigger: { type: 'scheduled', frequency: 'weekly', day: 'monday', time: '09:00' },
    steps: [
      {
        name: 'Retrieve Opportunities',
        type: 'retrieve',
        purpose: 'Get all active opportunities.',
        why: 'Every later step needs the records.',
        inputs: ['CRM export'],
        instructions: ['Call the CRM Read API.', 'Keep only active opportunities.', 'Stop if the call fails twice. Do not fabricate CRM data.'],
        tools: ['crm_read_api'],
        output: 'records[] — raw opportunity records',
        validation: ['At least one record or an explicit empty list.'],
        failure_behavior: 'retry twice then stop',
        retry: 2,
        execution: { op: 'tool', tool_id: 'crm_read_api', assign: 'records' },
      },
      {
        name: 'Normalize Opportunities',
        type: 'transform',
        depends_on: ['Retrieve Opportunities'],
        purpose: 'Compute days since last activity.',
        why: 'The rule compares whole days.',
        inputs: ['state.records'],
        instructions: ['For each record, read last_activity_date.', 'Calculate days since that date.', 'Leave the value null when the date is missing.'],
        output: { name: 'normalized', type: 'array' },
        validation: ['Every record keeps its id.'],
        execution: { op: 'map', from: 'state.records', as: 'item', value: { id: 'item.id', owner: 'item.owner', days_since_activity: 'if(exists(item.last_activity_date), days_since(item.last_activity_date), null)' }, assign: 'normalized' },
      },
      {
        name: 'Evaluate Opportunity Activity',
        type: 'decision',
        dependencies: ['step_02'],
        purpose: 'Apply the inactivity rule to every opportunity.',
        why: 'Core business rule.',
        inputs: ['state.normalized', 'config.inactivity_threshold_days'],
        instructions: ['Compare days_since_activity with the threshold.', 'Flag when greater than or equal to the threshold.', 'Record the rule used.'],
        decision_logic: [
          { rule_id: 'rule_01', condition: 'days_since_activity >= inactivity_threshold_days', result: 'attention_required', next: 'step_04' },
          { rule_id: 'rule_02', condition: 'otherwise', result: 'no_attention', next: 'step_04' },
        ],
        output: { name: 'decisions', type: 'array' },
        validation: ['Every opportunity has exactly one decision.'],
        execution: { op: 'decide', for_each: 'state.normalized', rules: ['rule_01', 'rule_02'], assign: 'decisions', key: 'id' },
      },
      {
        name: 'Collect Flagged',
        type: 'transform',
        dependencies: ['step_03'],
        purpose: 'Keep the opportunities that need attention.',
        why: 'The report lists only flagged records.',
        inputs: ['state.decisions'],
        instructions: ['Select decisions equal to attention_required.', 'Keep their ids.'],
        output: { name: 'flagged', type: 'array' },
        validation: ['Only attention_required decisions are kept.'],
        execution: { op: 'filter', from: 'state.decisions', where: { field: 'item.result', operator: 'equals', value: 'attention_required' }, assign: 'flagged' },
      },
      {
        name: 'Write Report',
        type: 'generate',
        dependencies: ['step_04'],
        purpose: 'Write the risk report.',
        why: 'People act on a readable summary.',
        inputs: ['state.flagged'],
        instructions: draft ? ['Write it.'] : ['Write an executive summary.', 'List every flagged opportunity with its owner and days inactive.', 'Do not add facts that are not in the data.'],
        output: { name: 'report', type: 'string' },
        validation: ['Every flagged id appears in the report.'],
        execution: { op: 'llm', assign: 'report' },
      },
      {
        name: 'Assemble Output',
        type: 'output',
        dependencies: ['step_05'],
        purpose: 'Build the final result.',
        why: 'Fixed contract for tests.',
        inputs: ['state.flagged', 'state.report'],
        instructions: ['Count flagged opportunities.', 'Count all opportunities.', 'Attach the report.'],
        output: { name: 'result', type: 'object' },
        validation: ['All output fields present.'],
        execution: { op: 'output', mapping: { flagged_count: 'count(state.flagged)', total: 'count(state.normalized)', flagged_ids: "pluck(state.flagged, 'key')", report: "coalesce(state.report, '')" } },
      },
      {
        name: 'Validate Output',
        type: 'validate',
        dependencies: ['step_06'],
        purpose: 'Check the output contract.',
        why: 'Prevents broken results.',
        inputs: ['steps.step_06'],
        instructions: ['Validate against the output schema.', 'Stop with OUTPUT_INVALID on failure.'],
        output: { name: 'validation_report', type: 'object' },
        validation: ['Schema passes.'],
        execution: { op: 'validate_output' },
      },
    ],
    decision_rules: [
      { id: 'rule_01', name: 'Inactivity', step: 'Evaluate Opportunity Activity', when: { field: 'days_since_activity', operator: 'gte', value: '{{config.inactivity_threshold_days}}' }, result: 'attention_required' },
      { id: 'rule_02', name: 'Active', step_id: 'step_03', when: { otherwise: true }, result: 'no_attention' },
    ],
    output: {
      format: 'json',
      fields: [
        { name: 'flagged_count', type: 'integer', required: true },
        { name: 'total', type: 'integer', required: true },
        { name: 'flagged_ids', type: 'array', required: true },
        { name: 'report', type: 'string', required: true },
      ],
    },
    validation: { step: ['Each step output matches its schema.'], workflow: ['Every opportunity is evaluated once.'], output: ['Output matches schema.'], intent: ['Only inactivity drives the flag.'] },
    error_handling: { default: 'stop', strategies: [{ on: 'CRM request fails', strategy: 'retry', then: 'stop', notes: 'Do not fabricate CRM data.' }], retry: { enabled: true, max_attempts: 2, retry_on: ['timeout'] } },
    success_criteria: ['All required records are processed.', 'Every decision follows the configured rules.', 'The report contains all required fields.'],
  };
}

function discovery(user) {
  const conv = user.conversation || [];
  if (conv.length === 0 && user.rounds_remaining > 0) {
    return {
      response_type: 'clarification_question',
      status: 'needs_input',
      data: {
        questions: [{ id: 'q1', slot: 'criteria', text: 'How should I define an inactive opportunity?', input_type: 'single_choice', options: [{ id: 'a', label: 'No activity for 7 days' }, { id: 'b', label: 'No activity for 14 days' }, { id: 'c', label: 'No activity for 30 days' }, { id: 'd', label: 'Something else' }] }],
        requirement_state: { goal: { value: user.original_request, source: 'user' } },
        reasoning: 'The threshold drives every decision.',
      },
    };
  }
  if (conv.length === 1 && user.rounds_remaining > 0) {
    // Deliberately repeat the first question once: the server must drop it and complete.
    if (String(user.original_request).includes('repeat')) {
      return { response_type: 'clarification_question', status: 'needs_input', data: { questions: [{ id: 'q9', slot: 'criteria', text: 'How should I define an inactive opportunity?', input_type: 'text', options: [] }] } };
    }
    return {
      response_type: 'clarification_question',
      status: 'needs_input',
      data: { questions: [{ id: 'q2', slot: 'data_sources', text: 'Where is the opportunity data?', input_type: 'single_choice', options: ['CRM', 'Spreadsheet', 'Database', 'API'] }] },
    };
  }
  return {
    response_type: 'clarification_complete',
    status: 'complete',
    data: {
      intent: {
        title: 'Weekly Opportunity Risk Report',
        goal: 'Identify inactive sales opportunities every Monday and produce a risk report.',
        rules: ['No activity for 14 or more days = attention required'],
        data_sources: ['CRM'],
        actions: ['Report findings'],
        trigger: { type: 'schedule', frequency: 'weekly', day: 'monday', time: '09:00' },
        output: { format: 'json', description: 'Risk report' },
        constraints: ['Never modify CRM records'],
        assumptions: ['Activity dates are ISO dates'],
      },
    },
  };
}

/**
 * The scripted brain, shared by the in-process mock provider and the fake
 * Ollama server in test/fake-ollama.js (so the local HTTP path is exercised
 * with exactly the same answers).
 */
export async function scriptedReply(req) {
  {
    const system = String(req.messages[0].content || '');
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    let user = {};
    try {
      user = JSON.parse(lastUser.content);
    } catch { /* plain text */ }
    const usage = { prompt_tokens: 1000, completion_tokens: 300, total_tokens: 1300, cost: null };
    const reply = (obj) => ({ content: JSON.stringify(obj), tool_calls: [], finish_reason: 'stop', usage, model: req.model });
    mockState.calls.push(system.slice(0, 40));

    if (system.includes('Intent Discovery engine')) return reply(discovery(user));
    if (system.includes('Playbook Compiler')) {
      mockState.compilerCalls++;
      const first = !req.messages.some((m) => m.role === 'assistant');
      return reply({ response_type: 'playbook', status: 'complete', data: { playbook: opportunityPlaybook(first) } });
    }
    if (system.includes('Execution Engine')) {
      const hasToolResult = req.messages.some((m) => m.role === 'tool');
      if (req.tools && req.tools.length && mockState.useTools && !hasToolResult) {
        return { content: '', tool_calls: [{ id: `call_${Date.now()}`, type: 'function', function: { name: req.tools[0].function.name, arguments: '{"arguments":{}}' } }], finish_reason: 'tool_calls', usage, model: req.model };
      }
      const payload = JSON.parse(req.messages[1].content);
      const pb = normalizePlaybook(payload.playbook);
      const run = await executeDeterministic(pb, { input: payload.input, configuration: payload.configuration, now: new Date(payload.evaluation_time), autoApprove: true, backoff: false });
      mockState.executionCalls++;
      const output = run.output ? { ...run.output } : null;
      if (mockState.flakyEvery && mockState.executionCalls % mockState.flakyEvery === 0 && output && output.decision === 'at_risk') output.decision = 'healthy';
      return reply({
        response_type: 'execution_result',
        status: run.status === 'completed' ? 'completed' : run.status === 'needs_input' ? 'needs_input' : 'failed',
        data: {
          output,
          trace: run.trace.map((t) => ({ step_id: t.step_id, status: t.status === 'simulated' ? 'completed' : t.status, summary: t.message || t.name, decision: t.decision, rule_id: t.rule_id })),
          error: run.error,
          warnings: [],
        },
      });
    }
    if (system.includes('Evaluation Model')) return reply({ response_type: 'test_result', status: 'complete', data: { passed: true, task_alignment: 0.96, requirement_coverage: 1, issues: [], notes: 'Output matches the objective.' } });
    if (system.includes('Test Planner')) {
      mockState.testPlanCalls++;
      return reply({ response_type: 'test_plan', status: 'complete', data: { total: 6, focus: ['boundary', 'negative'], notes: 'Two outcomes, thresholds and required fields drive the size.' } });
    }
    if (system.includes('Test Generator')) {
      mockState.testBatchCalls++;
      // Scripted failure: fail EVERY call of the batch named in testFailBatch
      // ("1 of 2", …) — including the JSON repair attempt, whose last user
      // message is plain correction text rather than the batch payload, so the
      // tag is searched across all user messages.
      let batchNo = 0;
      for (const m of req.messages) {
        if (m.role !== 'user') continue;
        const mm = /"batch"\s*:\s*"(\d+) of/.exec(String(m.content));
        if (mm) {
          batchNo = Number(mm[1]);
          break;
        }
      }
      if (mockState.testFailBatch && batchNo === mockState.testFailBatch) {
        return { content: 'not-json-on-purpose', tool_calls: [], finish_reason: 'stop', usage, model: req.model };
      }
      if (mockState.testEmptyBatch && mockState.testBatchCalls === mockState.testEmptyBatch) {
        return reply({ response_type: 'test_case', status: 'complete', data: { tests: [] } });
      }
      return reply({
        response_type: 'test_case',
        status: 'complete',
        data: {
          tests: [
            { name: 'AI normal case', category: 'normal', input: { customer: { name: 'Umbrella', days_since_activity: 30 } }, expected: { decision: 'at_risk' }, expected_status: 'completed', covers: { requirements: ['req_02'] } },
            { name: 'AI boundary', category: 'boundary', input: { customer: { name: 'Umbrella', days_since_activity: 14 } }, expected: { decision: 'at_risk', reason: { $contains: '14' } }, covers: { requirements: ['req_02'] } },
            { name: 'AI semantic', category: 'edge', input: { customer: { name: 'Hooli', days_since_activity: 0 } }, expected_behavior: 'A customer active today is healthy.' },
          ],
        },
      });
    }
    if (system.includes('Repair Assistant')) {
      return reply({ response_type: 'repair_suggestion', status: 'complete', data: { suggestions: [{ step_id: 'step_02', rule_id: 'rule_01', problem: 'Boundary excluded.', explanation: 'rule_01 uses >.', fix_summary: 'Change > to >=.', patch: [{ op: 'replace', path: '/decision_rules/1/when/operator', value: 'greater_than_or_equal' }] }] } });
    }
    return reply({ response_type: 'error', status: 'error', data: { message: 'unknown role' } });
  }
}

class MockProvider extends AIProvider {
  async testConnection() {
    if (this.apiKey === 'bad-key') throw Object.assign(new Error('Mock rejected key'), { code: 'AUTH_ERROR' });
    return { ok: true, account: { label: 'mock', is_free_tier: false, limit: null, limit_remaining: null, usage: 0 } };
  }

  async listModels() {
    return [
      { id: 'mock/smart', name: 'Mock Smart', context_length: 128000, max_completion_tokens: 16000, pricing: { prompt: 0.000001, completion: 0.000002 }, supports: { json: true, tools: true, seed: true } },
      { id: 'mock/fast', name: 'Mock Fast', context_length: 32000, max_completion_tokens: 8000, pricing: { prompt: 0, completion: 0 }, supports: { json: true, tools: false, seed: false } },
    ];
  }

  async chat(req) {
    return scriptedReply(req);
  }
}

registerProvider('mock', { label: 'Mock (self-test)', description: 'Offline scripted provider used by npm test.', hidden: true, create: (conn, key) => new MockProvider(conn, key) });
