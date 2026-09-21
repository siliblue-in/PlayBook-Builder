# Playbook Builder for AI — Product Specification

This is the specification the application implements. Section numbers are referenced throughout the source code as `§n`.

---

## 1. Product Definition

Playbook Builder for AI is a web application that converts a user's natural-language goal into a detailed, executable, testable, reusable AI playbook.

The system must not simply answer the user's request.

It must understand the user's intent, ask short dynamic questions, build a complete procedure, expose that procedure visually, export it as Markdown/PDF/JSON, test it repeatedly, and only then execute it.

The complete lifecycle is:

```
User Goal
   ↓
Intent Discovery
   ↓
Short Dynamic Questions
   ↓
Confirmed Requirements
   ↓
Playbook Compilation
   ↓
Detailed Playbook
   ↓
Visual Workflow
   ↓
Markdown / PDF / JSON
   ↓
Automated Test Generation
   ↓
Test Execution
   ↓
Accuracy / Consistency / Intent Evaluation
   ↓
Pass / Warning / Fail
   ↓
Publish
   ↓
Execute
   ↓
Final Result
```

## 2. Fundamental Product Principle

The product has four distinct artifacts:

- **INTENT** — What the user wants.
- **PLAYBOOK** — How the task must be performed.
- **TEST SUITE** — How the Playbook is verified.
- **EXECUTION RESULT** — What happened during a specific run.

Never collapse these into one LLM response.

The most important architectural rule is:

> The Playbook API returns the actual procedure, not the final answer produced by that procedure.

## 3. What Counts as a Playbook

A Playbook is an executable specification containing enough information for another AI agent or execution engine to perform the task without needing the original conversation.

A complete Playbook must include:

Objective · Scope · Requirements · Assumptions · Inputs · Dependencies · Configuration · Tools · Permissions · Trigger · Workflow Steps · Step Dependencies · Decision Rules · Actions · Expected Outputs · Output Schema · Validation Rules · Error Handling · Retry Policy · Test Cases · Success Criteria

## 4. Detailed-but-Concise Requirement

The Playbook should follow this style:

**Overview** — Concise. Example:

```
Objective:
Identify inactive sales opportunities every Monday and produce a risk report.
```

**Execution Detail** — Each step should be detailed. Example:

```
Step 3 — Evaluate Opportunity Activity

Purpose:
Determine whether each opportunity meets the inactivity rule.

Inputs:
- Validated opportunity records
- Last activity date
- Current evaluation date
- inactivity_threshold_days

Dependencies:
- Step 2 — Normalize Opportunities

Instructions:
1. Read the latest activity date.
2. Calculate days since activity.
3. Compare the value against inactivity_threshold_days.
4. Flag the opportunity when the value meets or exceeds the threshold.
5. Record the metric used to make the decision.
6. Do not infer a missing activity date.

Output:
risk_decision[]

Validation:
- Every decision must reference an input value.
- Missing activity dates must not be converted to zero.
```

The goal is: **Short enough to scan, detailed enough to execute.**

## 5. Playbook Structure

Use the following canonical structure.

```json
{
  "schema_version": "1.0",

  "id": "pb_123",
  "name": "string",
  "description": "string",
  "version": 1,

  "objective": "string",
  "scope": "string",

  "requirements": [],

  "assumptions": [],

  "dependencies": [],

  "ai": {
    "connection_id": "string",
    "model": "string"
  },

  "inputs": [],

  "configuration": [],

  "tools": [],

  "permissions": [],

  "trigger": {},

  "steps": [],

  "decision_rules": [],

  "output": {},

  "validation": [],

  "error_handling": {},

  "success_criteria": [],

  "tests": []
}
```

## 6. Requirements Section

Before listing steps, the Playbook must explicitly describe what is required. Example:

```
## Requirements

Functional:
- Read active sales opportunities.
- Evaluate inactivity.
- Identify opportunities meeting the configured threshold.
- Produce a report.

Data:
- Opportunity ID
- Opportunity name
- Owner
- Last activity date

Business Rule:
- No activity for 14 or more days = attention required.

Output:
- Opportunity
- Reason
- Days inactive
```

This lets the reader understand the task before reading the implementation details.

## 7. Dependencies Section

The Playbook must explicitly identify dependencies. Dependencies can include: data dependencies, system dependencies, tool dependencies, authentication dependencies, workflow dependencies, configuration dependencies, human dependencies.

```
## Dependencies

Systems:
- CRM access

AI:
- Connected OpenRouter provider
- Selected execution model

Data:
- Opportunity records
- Activity history

Permissions:
- Read access to CRM opportunities

Workflow:
- Step 3 depends on Step 2
- Step 4 depends on Step 3
```

Do not assume dependencies are obvious.

## 8. Tools Section

Every tool must have a purpose.

Bad:

```
Tools:
- CRM
- Web
```

Good:

```
## Tools

CRM Read API
Purpose:
Retrieve active opportunity records and recent activity.

Permission:
Read-only.

Required:
Yes.

Web Search
Purpose:
Not required for this Playbook.

Required:
No.
```

If a tool is not needed, do not add it just because it is available.

## 9. Permissions Section

The Playbook should specify what it may and may not do.

```
## Permissions

Allowed:
- Read CRM opportunities
- Read activity history
- Generate internal report

Not Allowed:
- Modify CRM records
- Delete CRM records
- Send external messages
```

This becomes part of execution validation.

## 10. Configuration

Variable values belong in configuration.

```json
{
  "configuration": [
    {
      "name": "inactivity_threshold_days",
      "type": "number",
      "value": 14,
      "description": "Days without activity before an opportunity is flagged."
    },
    {
      "name": "report_format",
      "type": "enum",
      "value": "markdown",
      "allowed_values": ["markdown", "json", "table"]
    }
  ]
}
```

Do not hard-code values inside multiple steps.

## 11. Inputs

Each input should include: Name, Description, Type, Required, Source, Validation, Example.

```json
{
  "id": "opportunities",
  "name": "Active Opportunities",
  "type": "array",
  "required": true,
  "source": "CRM",
  "validation": [
    "Each opportunity must contain an ID.",
    "Each opportunity must contain a name."
  ]
}
```

## 12. Trigger

The Playbook must define how it starts: Manual, Scheduled, Webhook, Event, API, User request.

```json
{
  "type": "schedule",
  "frequency": "weekly",
  "day": "monday"
}
```

## 13. Detailed Step Schema

Every step is required to contain: Step ID, Step Name, Step Type, Purpose, Why It Exists, Inputs, Dependencies, Preconditions, Instructions, Decision Logic, Tools, Expected Output, Output Schema, Validation, Failure Behavior, Retry Behavior.

Canonical structure:

```json
{
  "id": "step_03",
  "name": "Evaluate Opportunity Activity",
  "type": "decision",

  "purpose": "Determine whether an opportunity meets the inactivity rule.",

  "dependencies": ["step_02"],

  "inputs": [
    "validated_opportunities",
    "current_date",
    "configuration.inactivity_threshold_days"
  ],

  "preconditions": [
    "validated_opportunities exists",
    "inactivity_threshold_days is numeric"
  ],

  "instructions": [
    "Read the latest activity date.",
    "Calculate days since activity.",
    "Compare the result with the configured threshold.",
    "Flag the opportunity when the result is greater than or equal to the threshold.",
    "Record the evidence used for the decision.",
    "Do not fabricate missing activity information."
  ],

  "decision_logic": [
    { "condition": "days_since_activity >= inactivity_threshold_days", "result": "attention_required" },
    { "condition": "days_since_activity < inactivity_threshold_days", "result": "no_attention" }
  ],

  "tools": [],

  "output": { "name": "risk_decisions", "type": "array" },

  "validation": ["Every decision must reference the calculated days_since_activity."],

  "failure_behavior": "stop",

  "retry_behavior": "not_applicable"
}
```

## 14. Step Writing Rules

The AI must write steps in executable language.

Prefer:

```
Retrieve all active records.
Validate that each record contains an ID.
Calculate days since the latest activity.
Apply the configured threshold.
Record the evidence.
```

Avoid:

```
Understand the data.
Analyze intelligently.
Figure out which records are important.
Use your judgment.
```

The instructions must minimize ambiguity.

## 15. Every Step Must Answer Six Questions

1. What is this step doing?
2. Why is it doing it?
3. What does it need?
4. What previous step does it depend on?
5. What exactly should it do?
6. What should it produce?

## 16. Preconditions

A step should not execute until its requirements are available.

```
Preconditions:
- CRM response exists.
- Records are valid.
- Activity date field exists.
```

If preconditions fail, use the configured failure behavior.

## 17. Postconditions

Optionally define what must be true after completion.

```
Postconditions:
- Every valid opportunity has a risk classification.
- No opportunity is silently dropped.
```

Postconditions are particularly useful for complex workflows.

## 18. Decision Rules

Decision logic should be explicit and machine-readable.

```json
{
  "id": "rule_01",
  "name": "Inactivity Rule",
  "when": {
    "field": "days_since_activity",
    "operator": "greater_than_or_equal",
    "value": 14
  },
  "result": "attention_required"
}
```

Branching should be represented in the visual workflow.

## 19. Workflow Dependencies

The Playbook must contain a dependency graph.

```
Step 1
   ↓
Step 2
   ↓
Step 3
   ├── YES → Step 4
   └── NO  → Step 5
                  ↓
               Step 6
```

A step must not depend on a step that does not exist. The validator must reject circular dependencies.

## 20. Parallel Steps

Independent work can execute in parallel.

```
             ┌── Retrieve CRM ──────┐
Start ───────┼── Retrieve Support ──┼──→ Analyze
             └── Retrieve Renewal ──┘
```

The Playbook should explicitly declare when steps are independent.

## 21. Human Approval

If a workflow contains sensitive external actions:

```
Analyze
  ↓
Generate Action
  ↓
Human Approval
  ↓
Execute Action
```

The approval point must be explicit.

## 22. Output Specification

The Playbook must define the final output precisely.

```
## Output

Format:
Markdown report

Sections:
1. Executive Summary
2. Flagged Opportunities
3. Reasons
4. Recommended Follow-up

Each opportunity must contain:
- ID
- Name
- Owner
- Risk
- Reason
- Evidence
```

## 23. Success Criteria

A Playbook needs explicit success criteria.

```
## Success Criteria

The Playbook succeeds when:

- All required records are processed.
- Every decision follows the configured rules.
- Every flagged record has evidence.
- The final report contains all required fields.
- No unsupported facts are introduced.
- Validation passes.
```

This is also what the Test Engine uses to evaluate success.

## 24. Validation

Validation must exist at multiple levels.

- **Step Validation** — Did the step produce the expected structure?
- **Workflow Validation** — Did dependencies and decisions execute correctly?
- **Output Validation** — Does the final result satisfy the output contract?
- **Intent Validation** — Did the workflow actually do what the user asked?

## 25. Error Handling

Each step needs failure behavior. Supported strategies: `retry`, `skip`, `fallback`, `stop`, `request_input`, `continue_with_warning`.

```
If CRM request fails:
    Retry twice.

If retry fails:
    Stop execution.

Do not fabricate CRM data.
```

## 26. Retry Policy

Retries should be explicit.

```json
{
  "retry": {
    "enabled": true,
    "max_attempts": 2,
    "retry_on": ["timeout", "temporary_provider_error"]
  }
}
```

Do not retry deterministic validation failures indefinitely.

## 27. Intent Discovery

Before building the Playbook, the AI should conduct a short adaptive interview.

```
User:
"Monitor customers."

AI:
What should I watch for?

○ Churn risk
○ Low engagement
○ Support issues
○ Renewal risk
○ Something else
```

Next:

```
How should I define low engagement?

○ No activity for 7 days
○ No activity for 14 days
○ No activity for 30 days
○ I'll define it later
```

Next:

```
Where is the customer data?

○ CRM
○ Spreadsheet
○ Database
○ API
○ Manual input
```

The AI stops once it knows enough.

## 28. Dynamic Question Requirements

Questions must be: short, contextual, one-at-a-time by default, multiple-choice when appropriate, generated dynamically, based on previous answers.

Options must also be dynamic. The AI must never repeatedly ask for already-known information.

## 29. Confirmed Intent

Show the final understanding before compilation:

```
Here's what I understand:

Goal:
Monitor customers for low engagement.

Rule:
No activity for 14+ days.

Data:
CRM.

Action:
Report findings.

Frequency:
Weekly.

Output:
Dashboard report.

[ Generate Playbook ]
[ Edit ]
```

## 30. Playbook Compiler

The compiler receives: Original Request + Discovery Conversation + Confirmed Intent + User Answers + Constraints + Selected Tools + Selected AI Connection.

It returns the actual Playbook JSON. The compiler must not perform the task.

## 31. Anti-Final-Answer Protection

The compiler prompt must explicitly state:

```
Do not perform the user's task.

Do not return the requested report.

Do not return the final result.

Do not summarize the result.

Create the reusable procedure required to perform the task.

Return the complete Playbook structure.
```

## 32. Visual Playbook

Render the Playbook as a graph.

```
┌───────────────┐
│ Input         │
│ CRM Records   │
└───────┬───────┘
        ↓
┌───────────────┐
│ Validate      │
│ Input         │
└───────┬───────┘
        ↓
┌───────────────┐
│ Calculate     │
│ Inactivity    │
└───────┬───────┘
        ↓
┌───────────────┐
│ Decision      │
│ >= 14 days?   │
└───────┬───────┘
       / \
     YES  NO
      ↓    ↓
   Flag   Healthy
      \    /
       ↓  ↓
   ┌───────────────┐
   │ Generate      │
   │ Report        │
   └───────┬───────┘
           ↓
   ┌───────────────┐
   │ Validate      │
   │ Output        │
   └───────────────┘
```

Clicking a node should show the complete step definition.

## 33. Markdown as a First-Class Artifact

Generate Markdown directly from Playbook JSON. The Markdown should contain:

Title · Objective · Scope · Requirements · Dependencies · Configuration · Inputs · Tools · Permissions · Trigger · Workflow · Detailed Step Specifications · Decision Rules · Output · Validation · Error Handling · Success Criteria · Test Plan · Latest Test Results · Version

## 34. Markdown Preview

The web application must render the Markdown inside a dedicated container.

```
┌──────────────────────────────────────────────────────────┐
│ Playbook.md                                              │
├──────────────────────────────────────────────────────────┤
│                                                          │
│ # Customer Risk Evaluator                                │
│                                                          │
│ ## Objective                                             │
│ Identify customers requiring attention.                  │
│                                                          │
│ ## Requirements                                          │
│ ...                                                      │
│                                                          │
│ ## Workflow                                              │
│                                                          │
│ ### Step 1 — Validate Input                              │
│ ...                                                      │
│                                                          │
└──────────────────────────────────────────────────────────┘

[ Copy ] [ Download .md ] [ Download PDF ]
```

Support: Preview, Raw Markdown, Fullscreen.

## 35. JSON Export

Provide: `[ View JSON ]`, `[ Copy JSON ]`, `[ Download JSON ]`.

The JSON is the canonical machine-readable Playbook.

## 36. PDF Export

The PDF should contain: Cover, Objective, Requirements, Dependencies, Tools, Inputs, Visual Workflow, Detailed Steps, Decision Rules, Output, Validation, Error Handling, Success Criteria, Test Cases, Test Results, Version.

The PDF must document the actual workflow, not merely the conversation.

## 37. Test Center

The Test Center must verify: Accuracy, Consistency, Requirement Coverage, Rule Adherence, Intent Alignment, Output Compliance, Error Handling, Edge Cases.

A Playbook is not considered production-ready merely because it generated valid JSON.

## 38. Executable Built-In Example

Ship the application with a working example: **Customer Risk Evaluator**.

Objective: Classify a customer as at_risk or healthy based on inactivity.

Rule:

```
days_since_activity >= 14
→ at_risk

days_since_activity < 14
→ healthy
```

Input:

```json
{
  "customer": {
    "name": "Acme Corp",
    "days_since_activity": 21
  }
}
```

Expected:

```json
{
  "customer": "Acme Corp",
  "decision": "at_risk"
}
```

This is a real executable fixture, not just an example description.

## 39. Built-In Test Cases

Include: Normal Risk, Normal Healthy, Boundary 13, Boundary 14, Boundary 15, Missing Activity, Repeatability.

Expected behavior:

```
13 → healthy
14 → at_risk
15 → at_risk
```

## 40. Repeatability Test

Run the same fixture repeatedly. Example: `Runs = 20`.

Every run must use: Same Playbook Version, Same Input, Same Configuration, Same Model, Same Test Environment.

Compare structured fields: decision, customer, numeric values, required fields.

Do not compare raw text alone.

## 41. Repeatability Example

Expected:

```
Run 01 → at_risk
Run 02 → at_risk
Run 03 → at_risk
...
Run 20 → at_risk
```

Evaluation:

```
Accuracy:
20 / 20 = 100%

Decision Agreement:
20 / 20 = 100%
```

If one run produces healthy:

```
19 / 20 correct

Accuracy = 95%

Decision Agreement = 95%

Status = WARNING
```

## 42. Broken Playbook Test

The built-in example must also demonstrate failure detection.

Change `>= 14` to `> 14`.

Run `days_since_activity = 14`.

Expected: `at_risk`. Actual: `healthy`.

Test Center:

```
✕ FAIL

Boundary condition violated.

Expected:
14 → at_risk

Actual:
14 → healthy

Suggested fix:
Change `>` to `>=`.
```

This demonstrates that the Test Center actually evaluates workflow behavior.

## 43. Automatic Test Generation

Provide: `[ Generate Test Cases ]`

The AI analyzes: Objective, Rules, Conditions, Branches, Inputs, Output, Failure Handling

and generates: Normal Cases, Negative Cases, Boundary Cases, Missing Data Cases, Edge Cases, Repeatability Cases.

## 44. Test Execution Modes

Support: Deterministic Fixture, AI Execution.

- **Deterministic Fixture** — Used to test workflow mechanics and exact logic.
- **AI Execution** — Used to test actual LLM behavior.

The same test suite can be run in both modes.

## 45. AI Evaluation

When semantic judgment is required, an evaluator model can compare: Original Objective, Confirmed Requirements, Test Input, Expected Behavior, Actual Output.

It returns structured evaluation. Example:

```json
{
  "passed": true,
  "task_alignment": 1.0,
  "requirement_coverage": 1.0,
  "issues": []
}
```

Use deterministic checks wherever possible. Use semantic evaluation only where needed.

## 46. Test Results

Show:

```
Task Alignment       96%
Requirement Coverage 100%
Rule Adherence       100%
Accuracy              94%
Consistency           92%
Output Compliance    100%
```

Statuses: PASS, WARNING, FAIL.

These metrics describe performance on the configured tests; they are not guarantees of correctness for every possible input.

## 47. Regression Testing

Whenever the Playbook changes:

```
Version 1
   ↓
Edit
   ↓
Version 2
   ↓
Tests become stale
```

Show:

```
⚠ Playbook changed since last test.

[ Run Tests ]
```

Compare versions: Accuracy, Consistency, Rule Adherence, Requirement Coverage.

## 48. AI-Assisted Repair

When a test fails:

```
Test
 ↓
Failure
 ↓
Identify Step
 ↓
Explain Problem
 ↓
Suggest Playbook Change
 ↓
User Approves
 ↓
New Playbook Version
 ↓
Retest
```

Do not silently modify production Playbooks.

## 49. Playbook Publishing

Lifecycle:

```
Draft
 ↓
Testing
 ↓
Passed
 ↓
Published
 ↓
Production
```

A draft may be edited freely. A published version should be immutable. Changes create a new version.

## 50. AI Connections

Users connect providers through the web UI.

```
Settings
 ↓
AI Connections
 ↓
Add Connection
 ↓
OpenRouter
 ↓
API Key
 ↓
Test
 ↓
Load Models
 ↓
Select Model
 ↓
Save
```

Never require the user to edit `.env`.

Provider credentials are securely stored and referenced using `connection_id`.

## 51. OpenRouter Configuration

Support separate model choices: Clarification Model, Playbook Generation Model, Execution Model, Testing Model, Evaluation Model.

The provider integration should remain abstracted behind `AIProvider` so additional providers can be added later.

## 52. Global Controls

Provide switches for:

```
Intent Discovery                 [ ON ]
Dynamic Questions                [ ON ]
Multiple Choice                  [ ON ]
Objective Confirmation           [ ON ]

Playbook Generation              [ ON ]
Visual Workflow                  [ ON ]

Markdown Export                  [ ON ]
PDF Export                       [ ON ]
JSON Export                      [ ON ]

Automatic Test Generation        [ ON ]
Repeatability Testing            [ ON ]
Regression Testing               [ ON ]
AI Evaluation                    [ ON ]

Tool Calling                     [ ON ]
Scheduled Playbooks              [ ON ]
Human Approval                   [ ON ]

Production Actions               [ OFF ]
```

## 53. AI Behavior Controls

```
Maximum Clarification Rounds
[ 5 ]

Maximum Questions Per Round
[ 1 ]

Require Objective Confirmation
[ ON ]

Show Assumptions
[ ON ]

Require Validation
[ ON ]

Require Tests Before Publish
[ ON ]

Default Repeatability Runs
[ 20 ]
```

The default should be one question at a time.

## 54. Appearance

Theme: ○ Light ○ Dark ● System

Also:

```
Compact Mode                     [ OFF ]
Reduced Motion                   [ OFF ]
Show Advanced Controls           [ OFF ]
Show Execution Logs              [ ON ]
Show Cost Information            [ ON ]
```

## 55. Main Navigation

Dashboard · Create Playbook · Playbooks · Test Center · Runs · AI Connections · Settings

Within each Playbook: Overview · Requirements · Workflow · Inputs · Dependencies · Tools · Tests · Runs · Versions · Export

## 56. Playbook Overview

```
Customer Risk Evaluator

Status:
✓ Tested

Version:
1.0

AI:
OpenRouter

Model:
Configured Model

Objective:
Classify customer risk using inactivity.

[ Edit ]
[ Test ]
[ Run ]
[ Export ]
```

## 57. Requirements View

Show: Goal, Scope, Requirements, Assumptions, Dependencies, Tools, Permissions, Configuration.

This makes the Playbook understandable without opening every step.

## 58. Workflow View

Show the full visual workflow. Selecting any node opens its complete details: Purpose, Inputs, Dependencies, Instructions, Decision Logic, Tools, Output, Validation, Failure Handling.

## 59. Markdown View

The user can inspect the complete generated Markdown inside the browser.

Actions: `[ Preview ]` `[ Raw ]` `[ Copy ]` `[ Download .md ]`

No need to leave the app.

## 60. Testing View

Show: Test Cases, Repeatability Tests, Last Run, Accuracy, Consistency, Failures, Regression Status.

Example:

```
✓ 7 / 7 functional tests passed
✓ 20 / 20 repeatability runs matched

Accuracy       100%
Consistency    100%
Rule Adherence 100%

Status:
PASS
```

## 61. Complete System Architecture

```
                              USER
                                │
                                ▼
                         TASK DESCRIPTION
                                │
                                ▼
                       INTENT DISCOVERY
                                │
                                ▼
                     SHORT DYNAMIC QUESTION
                                │
                                ▼
                           USER ANSWER
                                │
                                ▼
                     REQUIREMENT STATE
                                │
                         Enough info?
                         /          \
                       NO            YES
                        │              │
                        └──────┐       ▼
                               │  CONFIRMED INTENT
                               │       │
                               │       ▼
                               │ PLAYBOOK COMPILER
                               │       │
                               │       ▼
                               │ PLAYBOOK JSON
                               │       │
             ┌─────────────────┼───────┼────────────────────┐
             │                 │       │                    │
             ▼                 ▼       ▼                    ▼
         Visual Graph       Markdown  PDF                JSON
             │
             └──────────────────────┐
                                    ▼
                                TEST CENTER
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
           Accuracy            Consistency         Intent Alignment
              │                     │                     │
              └─────────────────────┼─────────────────────┘
                                    ▼
                             PASS / WARNING / FAIL
                                    │
                                    ▼
                                  PUBLISH
                                    │
                                    ▼
                              EXECUTION ENGINE
                                    │
                      ┌─────────────┼─────────────┐
                      ▼             ▼             ▼
                 AI Provider     Tools         Policies
                      │
                      ▼
                  OpenRouter
                      │
                      ▼
                    Model
                      │
                      ▼
                  Validation
                      │
                      ▼
                    RESULT
```

## 62. Final API Boundaries

The implementation must keep these APIs separate:

```
POST /api/discovery/start
POST /api/discovery/:sessionId/answer
POST /api/playbooks/generate
POST /api/playbooks/:id/test
POST /api/playbooks/:id/run
GET  /api/playbooks/:id/markdown
GET  /api/playbooks/:id/pdf
GET  /api/playbooks/:id/json
POST /api/connections
POST /api/connections/:id/test
GET  /api/connections/:id/models
```

## 63. AI Response Types

Every AI response should explicitly identify its type: `clarification_question`, `clarification_complete`, `playbook`, `test_case`, `test_result`, `execution_result`, `error`.

```json
{
  "response_type": "playbook",
  "status": "complete",
  "data": {
    "playbook": {}
  }
}
```

The frontend must never infer "this is a Playbook" simply because the response contains text.

## 64. Playbook Quality Gate

Before a Playbook can be saved as a production candidate, verify:

```
✓ Objective is explicit
✓ Requirements are explicit
✓ Dependencies are defined
✓ Tools are defined
✓ Inputs are defined
✓ Every step has a purpose
✓ Every step has inputs
✓ Every step has dependencies
✓ Every step has detailed instructions
✓ Decision logic is explicit
✓ Outputs are defined
✓ Validation exists
✓ Error handling exists
✓ Success criteria exist
✓ No circular dependencies
✓ Playbook JSON is valid
```

## 65. Final Definition of "Detailed"

The AI must produce a Playbook that is **concise in presentation but complete in execution detail**.

Each step should be detailed enough that another AI, another developer, or a human operator can understand: what to do, why to do it, what is required, what tools to use, what it depends on, what decisions to make, what output to produce, how to validate it, and what to do if it fails — without needing to ask the original author what they meant.

## 66. Final Definition of Success

A Playbook Builder run is successful only when:

```
The user's intent was understood
        +
Necessary questions were asked
        +
Requirements were confirmed
        +
A real Playbook was generated
        +
Every step is sufficiently detailed
        +
Dependencies are explicit
        +
Tools are explicit
        +
Inputs/outputs are explicit
        +
Decision rules are explicit
        +
Validation exists
        +
The Playbook can be visualized
        +
The Playbook can be exported
        +
The Playbook passes tests
        +
The Playbook demonstrates acceptable accuracy
        +
The Playbook demonstrates acceptable consistency
        +
The behavior aligns with the user's intended task
```

The central idea is:

> **Build the Playbook first. Test the Playbook second. Execute the Playbook third.**

And the generated Playbook should always be detailed enough to stand alone as an executable specification.
