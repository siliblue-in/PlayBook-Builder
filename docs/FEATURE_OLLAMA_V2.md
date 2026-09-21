# Feature Playbook v2 — Ollama Local AI + Concise Setup Box

**Product:** Playbook Builder for AI
**Feature:** Local LLM support using Ollama
**Version:** 2.0
**Brand:** Powered By SiliBlue.in

> This is the feature specification this release implements. The build notes at the
> end record how each section was implemented and where.

---

## 1. Feature Objective

Allow users to connect a locally running Ollama instance, detect available models, select a model, test it, and use it throughout Playbook Builder.

The feature must also provide a small, immediately visible setup box so users can get started without opening separate documentation.

Core flow:

```text
Install Ollama
   ↓
Install Model
   ↓
Start Ollama
   ↓
Open Playbook Builder
   ↓
Local AI → Ollama
   ↓
Concise Setup Box
   ↓
Detect Models
   ↓
Select Model
   ↓
Test
   ↓
Save
   ↓
Use Local AI
```

## 2. Local AI Connection Screen

Navigate to:

```text
Settings
→ AI Connections
→ Add Connection
→ Local AI
```

Screen structure:

```text
┌─────────────────────────────────────────────────────────┐
│ Connect Local AI                                        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ Provider                                                │
│ [ Ollama ▼ ]                                            │
│                                                         │
│ Server URL                                              │
│ [ http://localhost:11434 ]                              │
│                                                         │
│ [ Detect Models ]                                       │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ 🦙 Set up Ollama locally                                │
│                                                         │
│ 1. Install Ollama                                       │
│ 2. Start Ollama                                         │
│ 3. Install a model                                      │
│    ollama pull llama3.2                                 │
│ 4. Return here                                          │
│ 5. Detect Models                                        │
│ 6. Select Model                                         │
│ 7. Test Connection                                      │
│                                                         │
│ Server: localhost:11434                                 │
│                                                         │
│ [ Open Ollama ]                    [ Copy Command ]     │
├─────────────────────────────────────────────────────────┤
│ ▸ Need detailed instructions?                           │
└─────────────────────────────────────────────────────────┘
```

The setup box should be compact and visible without scrolling.

## 3. Concise Setup Box — Exact UI Specification

Create a reusable component:

```text
OllamaSetupCard
```

It should contain:

```text
Icon
Title
7 setup steps
Server URL
Primary action
Secondary action
Expand-details action
```

Component

```text
┌──────────────────────────────────────────────┐
│ 🦙  Set up Ollama locally                    │
│                                              │
│ ① Install Ollama                             │
│ ② Start Ollama                               │
│ ③ Install a model                            │
│    ollama pull llama3.2                      │
│ ④ Return here                                │
│ ⑤ Click Detect Models                        │
│ ⑥ Select your model                          │
│ ⑦ Test Connection                            │
│                                              │
│ Server                                       │
│ localhost:11434                              │
│                                              │
│ [ Open Ollama ]      [ Detect Models ]       │
│                                              │
│ ▸ Need detailed instructions?                │
└──────────────────────────────────────────────┘
```

## 4. Setup Box Behavior

**Before Connection** — show the complete setup box.

**While Detecting** — keep the setup box visible, but change the primary action:

```text
Detecting models...
```

**Connected** — replace the setup instructions with a compact success card:

```text
┌──────────────────────────────────────────────┐
│ ✓ Ollama Connected                           │
│                                              │
│ Server: localhost:11434                      │
│ Model: llama3.2                              │
│                                              │
│ Local AI is ready.                           │
│                                              │
│ [ Test AI ]   [ Change Model ]               │
└──────────────────────────────────────────────┘
```

**Connection Failed** — show the compact troubleshooting state:

```text
┌──────────────────────────────────────────────┐
│ ⚠ Can't connect to Ollama                    │
│                                              │
│ Check that Ollama is running and that the    │
│ server address is correct.                   │
│                                              │
│ Server: localhost:11434                      │
│                                              │
│ [ Retry ]  [ Setup Instructions ]            │
└──────────────────────────────────────────────┘
```

## 5. Detailed Instructions Expansion

The concise box must have:

```text
▸ Need detailed instructions?
```

When clicked:

```text
▼ Ollama Setup Instructions
```

Display:

**Step 1 — Install Ollama.** Install Ollama for your operating system.

**Step 2 — Start Ollama.** Open/start the Ollama application.

**Step 3 — Install a Model.** Example:

```bash
ollama pull llama3.2
```

**Step 4 — Return to Playbook Builder.** Open:

```text
Settings
→ AI Connections
→ Add Connection
→ Local AI
→ Ollama
```

**Step 5 — Enter Server**

```text
http://localhost:11434
```

**Step 6 — Detect Models.** Click:

```text
[ Detect Models ]
```

**Step 7 — Select Model.** Choose a detected local model.

**Step 8 — Test.** Click:

```text
[ Test Connection ]
```

**Step 9 — Save.** Save the connection and use Local AI.

## 6. Copyable Command

The setup box should make the installation command easy to copy.

```text
Model installation

ollama pull llama3.2                    [ Copy ]
```

After copy:

```text
✓ Copied
```

Do not automatically execute terminal commands from the web application.

## 7. Ollama Provider Form

```text
Provider
[ Ollama ▼ ]

Server URL
[ http://localhost:11434 ]

Authentication
[ None / Local ]

[ Detect Models ]
```

Authentication should default to `None / Local`. The user should not be asked for an API key for normal local Ollama usage.

## 8. Model Detection

When the user clicks `[ Detect Models ]` the backend should:

```text
Check server
   ↓
Retrieve available models
   ↓
Validate response
   ↓
Display models
```

Example:

```text
Available Models

○ llama3.2
○ qwen-model
○ another-model

[ Select ]
```

## 9. Model Selection

Once models are detected:

```text
Selected Model

[ llama3.2 ▼ ]
```

Allow a separate model per role:

```text
Intent Discovery      [ llama3.2 ]
Playbook Generation   [ llama3.2 ]
Testing               [ llama3.2 ]
Evaluation            [ another-model ]
Execution             [ llama3.2 ]
```

## 10. Model Capability Check

Before allowing a model to be used for a Playbook, test its required capabilities.

```text
Model Compatibility

✓ Text Generation
✓ JSON Output
✓ Structured Output
✓ Streaming
⚠ Tool Calling
```

If a required capability is missing:

```text
This model cannot support this Playbook.

[ Choose Another Model ]
```

## 11. Test Connection

The connection test should verify:

```text
Server reachable
Model available
Model responds
Required output format works
```

Use a minimal test:

```text
Prompt:
Return exactly:

PLAYBOOK_READY
```

Expected: `PLAYBOOK_READY`

Result:

```text
✓ Connection successful
✓ Model generation successful
```

## 12. Built-In Playbook Test

After connection succeeds:

```text
Your local model is ready.

Test it with the built-in Customer Risk Evaluator.

[ Run Built-in Test ]
```

Use the existing fixture:

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

## 13. Repeatability Test

Provide `[ Repeat Test ]`, default 20 runs.

```text
Runs                   [ 20 ]
Same Input             ✓
Same Playbook Version  ✓
Same Model             ✓
Same Configuration     ✓
```

Measure:

```text
Accuracy
Decision Agreement
Rule Adherence
Required Field Compliance
Latency
```

## 14. Local-Only Privacy Mode

```text
Privacy Mode

○ Cloud Allowed
○ Local Preferred
● Local Only
```

When Local Only is enabled:

```text
✓ Ollama
✕ OpenRouter
✕ OpenAI
✕ Other Cloud Providers
```

The backend must enforce this restriction.

## 15. Local AI Status

```text
┌──────────────────────────────────────────────┐
│ 🟢 Local AI                                  │
│                                              │
│ Provider: Ollama                             │
│ Server:   localhost:11434                    │
│ Model:    llama3.2                           │
│                                              │
│ Status: Connected                            │
│                                              │
│ [ Test ] [ Change Model ] [ Disconnect ]     │
└──────────────────────────────────────────────┘
```

## 16. Troubleshooting

If the connection fails:

```text
┌──────────────────────────────────────────────┐
│ Can't connect to Ollama?                     │
│                                              │
│ Check:                                       │
│ ✓ Ollama is installed                        │
│ ✓ Ollama is running                          │
│ ✓ Server URL is correct                      │
│ ✓ At least one model is installed            │
│                                              │
│ Server: localhost:11434                      │
│                                              │
│ [ Retry ] [ Setup Instructions ]             │
└──────────────────────────────────────────────┘
```

If no models are detected:

```text
Ollama is connected, but no models were found.

Install a model, then detect models again.

ollama pull llama3.2                  [ Copy ]

[ Detect Models ]
```

## 17. Local Provider Architecture

```text
AIProvider
   │
   ├── OpenRouterProvider
   ├── OpenAIProvider
   ├── AnthropicProvider
   └── LocalAIProvider
             │
             ├── OllamaAdapter
             ├── LMStudioAdapter
             ├── LlamaCppAdapter
             ├── VLLMAdapter
             └── CustomOpenAIAdapter
```

The Playbook Builder should not contain Ollama-specific logic outside the adapter.

## 18. Connection Data Model

```json
{
  "id": "conn_local_123",
  "provider": "ollama",
  "type": "local",
  "name": "My Ollama",
  "base_url": "http://localhost:11434",
  "authentication": { "type": "none" },
  "default_model": "llama3.2",
  "status": "connected"
}
```

Playbooks reference:

```json
{
  "connection_id": "conn_local_123",
  "model": "llama3.2"
}
```

Never store credentials in the Playbook.

## 19. Playbook Integration

A local model must work with exactly the same Playbook pipeline as cloud models:

```text
User Task → Intent Discovery → Dynamic Questions → Confirmed Intent
→ Playbook Compiler → Playbook JSON → Visual Workflow → Test Center → Execution
```

Only the selected provider changes.

## 20. Markdown / PDF / JSON

The actual Playbook generated using Ollama must still support:

```text
View Markdown
Copy Markdown
Download .md
Download PDF
View JSON
Copy JSON
Download JSON
```

The Markdown must be generated from the Playbook JSON. The final task result must never replace the Playbook.

## 21. Acceptance Criteria

```text
✓ Open Local AI settings
✓ See the concise Ollama Setup Box
✓ Copy the model installation command
✓ Install/start Ollama
✓ Enter localhost:11434
✓ Detect models
✓ Select a model
✓ Test the connection
✓ See capabilities
✓ Use Ollama for Intent Discovery
✓ Use Ollama for Playbook Generation
✓ View the actual Playbook
✓ View it as Markdown in-app
✓ Copy/download Markdown
✓ Export PDF/JSON
✓ Run the built-in test
✓ Repeat the test 20 times
✓ View consistency and accuracy
✓ Use the local model for execution
```

## 22. Implementation Order

```text
1. Create Local AI provider abstraction
2. Implement Ollama adapter
3. Build AI Connections UI
4. Add Concise Ollama Setup Box
5. Add expandable detailed instructions
6. Add model detection
7. Add model selection
8. Add capability detection
9. Add connection testing
10. Connect Ollama to Intent Discovery
11. Connect Ollama to Playbook Compiler
12. Connect Ollama to Test Center
13. Connect Ollama to Execution Engine
14. Add Local-Only privacy mode
15. Add built-in repeatability test
16. Verify Markdown/PDF/JSON export
17. Add troubleshooting states
18. Run end-to-end regression tests
```

## 23. UI Component Breakdown

```text
LocalAIConnectionPage
├── ProviderSelector
├── OllamaSetupCard
│   ├── SetupSteps
│   ├── CopyCommand
│   ├── OpenOllamaButton
│   └── DetailedInstructions
├── ServerUrlInput
├── DetectModelsButton
├── ModelSelector
├── CapabilityCard
├── TestConnectionButton
└── LocalAIStatusCard
```

## 24. Final UX

```text
Settings → AI Connections → Local AI → Ollama

┌─────────────────────────────────────┐
│ 🦙 Set up Ollama locally            │
│                                     │
│ 1. Install Ollama                   │
│ 2. Start Ollama                     │
│ 3. ollama pull llama3.2             │
│ 4. Return here                      │
│ 5. Detect Models                    │
│ 6. Select Model                     │
│ 7. Test Connection                  │
│                                     │
│ [ Open Ollama ] [ Detect Models ]   │
│                                     │
│ ▸ Need detailed instructions?       │
└─────────────────────────────────────┘

        ↓

Models Detected   [ llama3.2 ▼ ]

        ↓

✓ Connection Tested

        ↓

[ Use Local AI ]
```

The feature should make local AI feel like a normal, first-class connection inside Playbook Builder: Install → Connect → Detect → Select → Test → Use.

---

## Build notes — where each section lives

| Spec | Implementation |
|---|---|
| §1, §19, §22 | The local provider is registered like any other, so discovery, the compiler, the Test Center and the execution engine use it unchanged. |
| §2, §23 | `public/views/connections-local.js` (LocalAIConnectionPage) and `public/components/local-setup.js` (the components). |
| §3–§6 | `setupCard`, `copyCommand`, `detailedInstructions` in `public/components/local-setup.js`. The 7 steps, the command and the 9 detailed steps come from the adapter's `setup` block (`/api/meta`), not from the UI, so another local adapter gets its own box for free. |
| §7, §18 | `POST /api/connections` with `provider`, `base_url`, `authentication` and `default_model`. A local connection stores no key; `authentication.type` defaults to `none`. Stored `status` stays `ok` / `error` / `untested`, and the API also exposes `state: connected \| error \| untested` for the UI. |
| §8 | `POST /api/connections/detect` (before saving) and `GET /api/connections/:id/models`. Ollama uses `/api/tags`, other adapters use `/v1/models`. |
| §9 | `default_model` plus a model per role (clarification, generation, execution, testing, evaluation). |
| §10 | `POST /api/connections/capabilities` and `GET /api/connections/:id/capabilities`. Ollama's `/api/show` reports context length and capabilities; `tools_required` (or `playbook_id`) decides whether tool calling is required. |
| §11 | `LocalAIProvider.testConnection()` — server reachable → models installed → model available → `PLAYBOOK_READY` generation → JSON output. |
| §12–§13 | `POST /api/connections/:id/builtin-test` runs the built-in Customer Risk Evaluator (Acme Corp / 21 days) in AI Execution mode; the UI shows accuracy, decision agreement, rule adherence, required-field compliance and latency. |
| §14 | `settings.ai.privacy_mode`. Enforced in `AIService.resolve()`, `test()`, `models()` and `create()` — a cloud connection cannot be added, tested or used while Local Only is on. |
| §15–§16 | `localStatusCard`, `troubleCard`, `noModelsCard`. |
| §17 | `server/ai/local.js`: `LocalAIProvider` plus `LOCAL_ADAPTERS` (ollama, lmstudio, llamacpp, vllm, custom). Nothing outside that file knows about Ollama. |
| §20 | Markdown, PDF and JSON export are generated from the Playbook JSON regardless of which model produced it (covered by the self-test). |
| §21 | Every acceptance criterion is covered by `npm test` — see the "Local AI (Ollama)" section of `test/selftest.js`, which runs against a fake Ollama server over real HTTP. |

Powered By SiliBlue.in
