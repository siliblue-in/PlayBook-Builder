# Playbook Builder for AI

Turns a plain-language goal into a **detailed, executable, testable, reusable AI playbook** — and refuses to shortcut straight to an answer.

Runs on **models on your own computer (Ollama, LM Studio, llama.cpp, vLLM)** or on cloud models — **Anthropic (native Messages API)** and the API aggregators OpenRouter, NVIDIA NIM (build.nvidia.com), AMD Developer Cloud, Google AI (Gemini), Groq, Together AI, DeepInfra, Fireworks AI, Mistral, Cerebras, xAI (Grok), GitHub Models, or any custom OpenAI-compatible endpoint. Same pipeline either way.

```
Goal → short dynamic questions → confirmed intent → compiled playbook → visual workflow
     → Markdown / PDF / JSON → generated tests → accuracy · consistency · intent checks
     → PASS / WARNING / FAIL → publish → execute → result
```

**Build the playbook first. Test the playbook second. Execute the playbook third.**

---

## Launch Playbook Builder

The same four steps on **Windows, macOS and Linux**. There are no `.bat`, `.sh` or `.command` files to run.

### 1. Install Node.js

Install **Node.js 18.17 or newer**, the free LTS version from <https://nodejs.org>.

### 2. Install dependencies

Open a terminal in the Playbook Builder folder and run:

```bash
npm install
```

It finishes in a second because there is nothing to download: Playbook Builder uses only what ships with Node.js. There is no database and no `.env` file.

### 3. Start

```bash
npm run dev
```

The launcher detects the operating system and starts the server. It waits until the server answers, then opens your browser.

### 4. Open the application

The browser opens by itself. If it doesn't, open the URL shown in the terminal (**http://localhost:4317** by default). Keep the terminal open while you use the app, and press **Ctrl+C** to stop.

| Command | What it does |
|---|---|
| `npm run dev` | Start and open the browser. The server restarts automatically when source files change. |
| `npm run launch` | Start and open the browser, for everyday use. |
| `npm start` | Start the server only, with no browser (production). |
| `npm run build` | Verify the installation. There is nothing to compile, so this only checks the files. |
| `npm run setup` | Check this computer: Node.js, application files, data folder, port, and Ollama if present. |
| `npm test` | Run the end-to-end self-test. |

Options work the same everywhere: `npm run launch -- --port 4318` (or set `PORT`), and `--no-open` to skip the browser.

**Opening a terminal in the folder:**

- **Windows:** in File Explorer, type `cmd` in the address bar and press Enter.
- **macOS:** right-click the folder in Finder and choose **New Terminal at Folder**.
- **Linux:** use your file manager's **Open in Terminal**.

### If it does not start

The launcher explains the problem in plain words, with no stack trace. It names the likely cause (Node.js too old, missing files, port already in use, invalid configuration) and the fix, and offers **[R] Retry** or **[S] View setup instructions**. The technical details are saved to `data/logs/launch-error.log` for support. If Playbook Builder is already running, a second launch opens the running copy instead of starting another one.

### First five minutes (no API key needed)

1. Open **Playbooks → Customer Risk Evaluator**. It is a real, executable example that has already been tested: **7 / 7 tests passed, 20 / 20 repeatability runs matched**.
2. Look at **Workflow** (click any node for its full definition), **Requirements**, and **Export** (Markdown preview, PDF, JSON).
3. On the **Tests** tab click **Demo: introduce boundary bug**. That creates v2 with `>=` changed to `>`. Click **Run Tests** and you get **FAIL — Boundary condition violated. Expected 14 → at_risk, actual 14 → healthy. Suggested fix: change `>` to `>=`.**
4. Click **Approve & create new version**. That creates v3 and runs the tests again, which pass. Then **Publish** it and run it from the **Runs** tab.

The **Broken Rule Demo** playbook shows the same failure already recorded, with v1 (pass) and v2 (fail) side by side for regression comparison.

### Connect Local AI — Ollama (free, private, no API key)

**AI Connections → Add Connection → Local AI → Detect Models → select a model → Test Connection → Save.**

1. Install Ollama from <https://ollama.com/download> and start it.
2. Install a model: `ollama pull llama3.2` (3B, fine on a laptop; a larger model writes better playbooks).
3. In Playbook Builder open **AI Connections → Add Connection → Local AI**. The compact setup box on that page repeats these steps and copies the command for you.
4. Server URL is `http://localhost:11434` unless you changed `OLLAMA_HOST`. Authentication stays **None / Local**.
5. **Detect Models** lists everything you have pulled, with context length, size and whether the model supports tool calling.
6. Pick a model. **Model Compatibility** checks text generation, JSON output, structured output, streaming and tool calling, and says plainly when a model (an embedding model, for example) cannot run a playbook.
7. **Test Connection** checks the server, the model, a real generation (it asks for `PLAYBOOK_READY`) and JSON output.
8. **Save**, then **Run Built-in Test** / **Repeat Test** to measure accuracy, decision agreement, rule adherence, required-field compliance and latency for that model on the built-in Customer Risk Evaluator.

Nothing leaves the machine, there is no key to manage and there are no usage costs. LM Studio, llama.cpp, vLLM and any other OpenAI-compatible server are in the same Local AI list.

**PC performance tier — tell Playbook Builder what your computer can take.** The Local AI form has a **PC performance tier** selector with three presets (or *Custom* to set everything yourself). Each tier fills in a safe context window, **caps how many AI test cases one generation writes**, and shows its requirements and trade-offs right in the form:

| Tier | Hardware (what it needs) | Context window | Test cases | What to expect |
|---|---|---|---|---|
| **Low-Tier PC** | No GPU needed (CPU-only) or ≤ 4 GB VRAM · **8 GB RAM minimum** · 1–4B Q4 models | 4096 | **up to 4** | 3–25 min per AI step on CPU — slow, but generation finishes |
| **Mid-Range PC** | 6–8 GB VRAM GPU · **16 GB RAM minimum** · 7–9B Q4 models | 8192 | **up to 8** | 1–4 min per AI step with the model fully in VRAM |
| **High-End PC** | 12–24 GB+ VRAM · **32 GB RAM recommended** · 9–14B+ models | 16384 | **up to 16** | Seconds to ~2 min per AI step; best coverage |

Trade-offs are documented per tier in the UI: a low tier writes fewer, smaller tests and wants shorter playbooks; pushing a bigger model or window than the GPU can hold spills to CPU and slows everything down (`ollama ps` shows the GPU share).

**Privacy Mode** (Settings → Privacy) has three settings: *Cloud Allowed*, *Local Preferred* (a working local connection wins) and *Local Only* (the server refuses to add, test or use any cloud provider).

### Connect a cloud provider (Anthropic, OpenRouter, NVIDIA, AMD, Google, Groq and more)

**AI Connections → Add Connection → Cloud API key → pick a provider → paste your key → Save & test → pick a model for each role → Save models.**
Every provider is pre-filled with its service base URL (editable for a custom gateway) and links to where you create the key — for example <https://openrouter.ai/keys> for OpenRouter, <https://console.anthropic.com/settings/keys> for Anthropic or <https://build.nvidia.com> for NVIDIA NIM. The key is encrypted on this computer and only ever shown masked. Anthropic talks to the native Messages API (`x-api-key` + `anthropic-version`) — no OpenAI compatibility layer involved.

**Slow local model?** Two dials keep Ollama from giving up early: **Settings → Privacy & AI → AI request timeout** (default 10 minutes, how long one AI request may run) and the **Context window (num_ctx)** field on the Ollama connection (Ollama's small default window silently truncates long prompts — raise it, e.g. 8192 or 16384, if you see broken playbooks; larger windows need more memory). Picking a **PC performance tier** sets both to sane values and caps the AI test suite for the hardware.

Ollama calls also travel over a dedicated `node:http` transport with **no hidden timeouts**: the old "Could not reach Ollama … (UND_ERR_HEADERS_TIMEOUT) while Ollama is running" error was Node's `fetch` aborting any call whose first byte took longer than a fixed 5 minutes — big prompt evaluations on modest hardware exceed that. The only budget now is the AI request timeout you set, and the error messages distinguish a dead server ("Nothing is answering at …") from a slow one ("Ollama is running, but the model did not finish in time …").

You can choose a separate model for each role, with either kind of connection:

| Role | Used for | Tip |
|---|---|---|
| Clarification | The short discovery questions | a fast, small local model is fine |
| Playbook Generation | Compiling the playbook JSON | use your strongest model; locally, 7B+ with a large context |
| Execution | Running playbooks in AI mode | should follow rules precisely; temperature 0 |
| Testing | AI-mode test runs and AI-written test cases | usually the same as Execution |
| Evaluation | Scoring semantic task alignment and suggesting repairs | a strong reasoning model |

Then use **Create Playbook**: describe the goal, answer a few one-at-a-time questions (multiple choice, with *Something else* always available), confirm **"Here's what I understand"**, and generate.

---

## Every playbook has its own folder

Each playbook keeps everything about itself in one folder named after it. The folder is created automatically, in `data/workspaces/<Playbook Name>/`:

```
Customer Risk Evaluator/
├── README.md             what this folder is, the current and production versions
├── playbook/             playbook.json (canonical) · playbook.md · playbook.pdf
├── requirements/         intent.json · requirements.md · assumptions.json
├── process/              workflow · dependencies · tools · configuration · execution-plan
├── inputs/
│   ├── sample/           examples of the input format
│   ├── test/             data used only by tests
│   └── runtime/          real data for runs
├── tests/                test-suite.json · test-cases/ · repeatability/ · reports/
├── results/              latest/ · history/ · summaries/
├── executions/           run-001/ · run-002/ … (input, execution, step results, output, report)
├── exports/              markdown/ · pdf/ · json/
├── metadata/             version.json · settings.json · activity.json
└── versions/             v1/ · v2/ … a snapshot of every version
```

- **Open it from the app.** Every playbook has a **Files** tab: browse the folder; preview JSON, Markdown, PDF, CSV and images; open, copy, download, duplicate, rename or delete files; **Open folder** in Explorer, Finder or your file manager.
- **Add your data.** Drag files onto the Files tab (or click **Add input files**) and choose **Sample**, **Test** or **Runtime**. Uploads go into `inputs/` only.
- **Test data never reaches production.** A run can load its input from a workspace file (**Runs → Load input from a workspace file**). Production runs can only read `inputs/runtime/`; sample and test data are refused. The run records which file it used.
- **Every run is filed.** `executions/run-NNN/` holds the input, the execution record, the step results, the output and a report. `execution.json` names the exact playbook version, its hash and the snapshot in `versions/`. The newest result is also in `results/latest/`.
- **Rename freely.** The playbook keeps its ID; renaming it renames the folder. Names are made safe for Windows, macOS and Linux (`Customer Risk: Q4 / Enterprise` → `Customer Risk Q4 Enterprise`). Two playbooks with the same name get `Name` and `Name (2)`.
- **Share a playbook.** **Download Playbook Package** gives the whole folder as a `.zip`. **Playbooks → Import Playbook** accepts that `.zip` or a `.playbook.json`. The import is validated first, becomes a new draft with its intent, tests and input files, and **nothing is run**. Run history stays with the original, and the AI connection is reset to the ones on this computer.
- **The app is the source of truth.** Files in `playbook/`, `requirements/`, `process/`, `tests/`, `metadata/`, `versions/` and `exports/` are written from the playbook. Change the playbook in the app, or import an edited JSON. Editing those files by hand is overwritten at the next change, and a deleted one is recreated. Your own files belong in `inputs/`.

**Privacy.** The workspace always stays on this computer, whatever the AI connection. Privacy Mode only decides where AI requests go. The Files tab shows both: *Workspace storage* and *AI transport*. With Privacy Mode set to Local Only it shows **🔒 Local Workspace**. API keys and webhook tokens are never written to a workspace.

Existing playbooks get their folders the first time v1.2.2 starts, and earlier runs and test runs are filed into them.

---

## What you get

| Area | What it does |
|---|---|
| **Intent discovery** | Short adaptive interview (one question at a time by default), dynamic options, never re-asks known information, stops as soon as it knows enough, and shows the confirmed intent with assumptions before compiling. |
| **Playbook compiler** | Returns the *procedure*, never the final answer. It runs anti-final-answer rules plus automatic detection, and a repair loop against the 16-point quality gate. Every step answers the six questions: what, why, needs, depends on, exactly how, produces. |
| **Canonical Playbook JSON** | Objective, scope, typed requirements (with machine-readable business rules), assumptions, dependencies, AI connection, inputs, configuration, tools, permissions, trigger, detailed steps, decision rules, output contract, validation (step/workflow/output/intent), error handling and retry, success criteria, tests. |
| **Machine-readable steps** | Each step can carry an `execution` block (`validate`, `set`, `decide`, `filter`, `map`, `tool`, `llm`, `approval`, `output`, `validate_output`). This lets the engine run the logic deterministically and test it exactly. |
| **Visual workflow** | Layered graph with decision branches, parallel groups and cycle detection. Click a node to see its complete definition. The same graph shows each run's taken path. |
| **Markdown / PDF / JSON** | Generated from the JSON. The in-app Markdown container has Preview, Raw, Fullscreen, Copy, Download .md and Download PDF. The PDF includes a cover, a vector workflow diagram, every step, tests, results and version history. |
| **Test Center** | Deterministic Fixture and AI Execution modes, and repeatability runs (default 20). Structured-field comparison (not raw text), with matchers for values that cannot be exact. Metrics: accuracy, consistency, rule adherence, requirement coverage, output compliance, task alignment and error handling, with a PASS / WARNING / FAIL status. |
| **Test generation** | Normal, boundary (threshold −1/at/+1), negative, missing-data, edge and repeatability cases. Expectations come from the **requirements** (your intent), not from the possibly-buggy rules. AI generation is also available. |
| **Regression & repair** | Edits after testing create a new version and flag results as stale. You can compare versions' metrics and changes. Failures are traced to the step and rule. Fixes are proposed as JSON Patches and verified by re-running the suite on a patched copy. Nothing is applied until you approve. |
| **Lifecycle** | Draft → Testing → Passed → Published → Production. Published versions are immutable. Publishing requires the quality gate and (by default) a fresh passing full-suite run. |
| **Execution engine** | Sandbox and production runs, deterministic or AI execution, input validation, per-step trace and logs, output validation, and tool calls under policy (permissions, Production Actions, Human Approval with pause/resume). Also scheduled runs and webhook triggers. |
| **Local AI** | Ollama, LM Studio, llama.cpp, vLLM and any OpenAI-compatible server, behind the same `AIProvider` interface. Model detection, per-model capability checks, a `PLAYBOOK_READY` connection test, a built-in playbook test with repeatability and latency, and a Privacy Mode that can block cloud providers entirely. |
| **Playbook workspace** | A self-contained folder per playbook: the playbook, requirements, process, inputs, tests, results, one folder per execution, exports, metadata and version snapshots. It has a Files tab, drag-and-drop inputs, and `.zip` packages for export and import. |
| **Settings** | Every global control, AI behaviour control, privacy mode and appearance option from the spec. Changes take effect immediately. |

---

## How the Test Center scores a run

| Metric | Meaning |
|---|---|
| **Accuracy** | Share of runs whose structured fields match the expected values (repeatability runs count individually: 19/20 = 95%). |
| **Consistency** | For repeatability tests: share of runs agreeing with the most common structured outcome (decision agreement). |
| **Rule Adherence** | Did execution follow the playbook's own decision rules? In AI mode each output is checked against the deterministic rule engine on the same input. This separates *"the model didn't follow the rule"* from *"the rule itself is wrong"*. |
| **Requirement Coverage** | Share of requirements exercised by at least one test (explicit `covers`, or inferred). |
| **Output Compliance** | Share of runs whose output validates against the output contract (JSON Schema). |
| **Task Alignment** | Semantic score from the evaluation model (when AI Evaluation is on). |
| **Error Handling** | Share of negative / missing-data tests that behaved as specified. |

**Status:** any failed functional test → **FAIL**. Otherwise each metric is compared with the thresholds in Settings (default: pass = 100%, warning ≥ 90%; task alignment pass ≥ 85%). A repeatability test at 19/20 is a **WARNING**.
Deterministic mode cannot judge fields produced by LLM steps (for example, a written report). Those tests are skipped. If nothing could be judged, the run is **INCONCLUSIVE** and the version stays untested; run it in AI Execution mode instead.
*These metrics describe performance on the configured tests; they are not guarantees of correctness for every possible input.*

---

## API

Every AI-facing response is a typed envelope, so a client never has to guess what it received:

```json
{ "response_type": "playbook", "status": "complete", "data": { "playbook": { } } }
```

Response types: `clarification_question`, `clarification_complete`, `playbook`, `test_case`, `test_result`, `execution_result`, `repair_suggestion`, `error`.

| Endpoint | Purpose |
|---|---|
| `POST /api/discovery/start` `{ goal }` | Start intent discovery |
| `POST /api/discovery/:sessionId/answer` `{ question_id, option_ids, text }` | Answer (add `finish: true` to stop asking) |
| `POST /api/discovery/:sessionId/confirm` | Confirm the intent (optional edits) |
| `POST /api/playbooks/generate` `{ session_id }` | Compile the playbook |
| `POST /api/playbooks/:id/test` `{ mode, version, runs, test_ids, wait }` | Run the test suite |
| `POST /api/playbooks/:id/run` `{ input, mode, environment, version, wait }` | Execute (or `input_file: "inputs/runtime/…"` to use a workspace file) |
| `GET /api/playbooks/:id/markdown` · `/pdf` · `/json` (`?version=&download=1`) | Exports |
| `POST /api/connections` · `POST /api/connections/:id/test` · `GET /api/connections/:id/models` | AI connections |
| `POST /api/connections/detect` · `POST /api/connections/test` · `POST /api/connections/capabilities` | Local AI: probe a server before saving it |
| `GET /api/connections/:id/capabilities` · `POST /api/connections/:id/builtin-test` | Model capabilities · run the built-in playbook on this connection |
| `GET /api/playbooks/:id/workspace` · `GET …/workspace/file?path=&download=1` | The playbook's folder tree · one file |
| `POST /api/playbooks/:id/workspace/upload` `{ folder: "inputs/test", name, content_base64 }` | Add an input file (`inputs/sample`, `inputs/test` or `inputs/runtime`) |
| `POST …/workspace/rename` · `/delete` `{ path, confirm }` · `/duplicate` · `/sync` · `/open` | File actions (playbook files need `confirm: true` to delete) |
| `GET /api/playbooks/:id/package` · `POST /api/playbooks/import` `{ filename, content_base64 }` | Download the folder as a `.zip` · import a `.zip` or `.playbook.json` (never runs anything) |

Also available: `GET/PUT /api/playbooks/:id`, `POST /api/playbooks/:id/patch` (JSON Patch), `publish`, `promote`, `restore`, `compare?a=&b=`, `tests` CRUD, `tests/generate`, `repair`, `repair/apply`, `GET /api/test-runs/:id`, `GET /api/runs/:id`, `POST /api/runs/:id/approvals/:approvalId`, `POST /api/hooks/:id/:token` (webhook), `GET/PUT /api/settings`.

Example:

```bash
curl -s -X POST http://localhost:4317/api/playbooks/<id>/run \
  -H "Content-Type: application/json" \
  -d '{"input":{"customer":{"name":"Acme Corp","days_since_activity":21}},"wait":true}'
```

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4317` | Port to listen on |
| `PBAI_HOST` | `127.0.0.1` | Bind address. `0.0.0.0` exposes it on your network — only do that on a trusted network. |
| `PBAI_DATA_DIR` | `./data` | Where everything is stored |
| `PBAI_WORKSPACES_DIR` | `<data folder>/workspaces` | Where the playbook folders are kept |
| `PBAI_ALLOWED_HOSTS` | — | Extra host names allowed to reach the API (comma-separated) |

The same on every platform: `npm run launch -- --port 4318` (or `npm start -- --port 4318`).

## Data & security

- Everything lives in the `data` folder as plain JSON files: playbooks and versions, test suites, test runs, runs, discovery sessions, settings. The playbook folders are in `data/workspaces`. Back it all up by copying the `data` folder.
- A request for one playbook can only reach that playbook's folder. Paths are checked on the server: `..`, absolute paths, drive letters, device names and links that lead out of the folder are all refused. Uploaded files are stored, never run. Web pages and other active content are only offered as downloads, and previews are sandboxed.
- Imported packages are checked before anything is written. Unsafe paths, damaged or encrypted archives and oversized content are rejected, and imported tools and actions are never run automatically.
- API keys are encrypted with AES-256-GCM using a key file generated in `data/.secret.key`. The browser only ever sees a masked key. Keep the `data` folder private.
- The server listens on localhost only, rejects foreign `Host` headers, and blocks cross-origin writes.
- **Production Actions is off by default**, so external side effects (HTTP writes) are simulated and logged. **Human Approval is on by default**, so approval steps and external actions pause for a person. Draft versions only run in the sandbox.

## Self-test

```bash
npm test
```

This runs 331 end-to-end checks through the real HTTP API with a scripted offline AI provider. It covers discovery, compilation with the quality-gate repair loop, normalization of messy AI output, deterministic and AI test modes, the 19/20 WARNING case, the `>` vs `>=` failure and its verified fix, versioning, publishing, approvals, scheduling, webhooks, exports and feature switches — plus, since v1.3.0, lenient structured comparison of AI output, scheduler day handling, crash recovery for interrupted runs, oversized-body and malformed-path handling, and the browser poll's retry behaviour — and, since v1.4.0, the Ollama empty-response fix for thinking-capable models: the qwen3.5 regressions (native `/api/chat` with top-level `think:false`, `reasoning_effort:"none"` on the compatible path, endpoint-switching retries, classified empty responses), the model compatibility harness and the Local Only no-cloud-fallback guarantee — since v1.4.1, the background-safe creation regressions (module-scope generation tasks, re-attach instead of duplicate compiles, the corner progress card) and the smooth-loader regressions (in-place progress painting, spinner phase synchronization, compositor promotion) — since v1.5.0, the cloud API aggregators: the preset registry (NVIDIA, AMD, Google, Groq, Together, DeepInfra, Fireworks, Mistral, Cerebras, xAI, GitHub Models, custom OpenAI-compatible), base-URL defaulting and overriding, the generic /models key check, per-preset headers, keyless custom endpoints and the compatibility harness against a saved cloud connection — and, since v1.6.0, the Anthropic native Messages API against a fake Anthropic server (headers, system/max_tokens wiring, tool_use mapping, empty/auth error classification, the compatibility harness) plus the Ollama context window (storage and validation, native-first routing with `num_ctx` + `keep_alive` on the wire, draft-path application, tool requests carrying `num_ctx`) and the configurable AI request timeout (default, range validation, service injection, no hardcoded caps) — and, since v1.7.0, the live pipeline progress registry (step numbering, detail lines, failure marking, 404 handling, a full compile observed through `/api/progress`), the `max_tokens` clamp to the connection's context window on the wire, and planned + batched AI test generation with a scripted batch failure that is skipped while healthy batches still add tests — and, since v1.1.3, the transport regressions (the local provider no longer uses `fetch`, a closed port answers `SERVER_UNREACHABLE`, a silent server answers retryable `TIMEOUT` with the new wording), the PC performance tiers (catalog with VRAM/RAM requirements and 4/8/16 caps, storage, validation, the tier cap observed on the wire with a low-tier connection, the 409 duplicate-compile guard) and the served UI markers for the tier selector, tier info box and the reload-proof `bg-tasks` module.

32 checks cover Local AI against a fake Ollama server over real HTTP: model detection, capability checks, the connection test, the no-models and unreachable-server states, Privacy Mode enforcement, the built-in repeatability test, and a complete discovery → compile → test → export pipeline driven entirely by the local model. A further 27 checks (a fake server that reproduces the reported qwen3.5 bug) prove the v1.4.0 empty-response fix end to end: reasoning control on both endpoints, retry-then-switch behaviour, the classified error message, the compatibility harness verdicts and the four-artifact guarantees.

26 checks cover the universal launcher by starting real processes:
- the npm scripts, and the per-platform browser commands for Windows, macOS, Linux and WSL
- readiness before the browser opens, detection of a copy that is already running, and a clean Ctrl+C
- readable errors, with no stack trace, for a busy port, an unusable data folder and an invalid port
- `npm start`, `npm run dev`, `npm run build` and `npm run setup`
- a single source for the version number

54 checks cover the playbook workspaces:
- the folder structure and every generated file, with safe names and same-name playbooks
- one `executions/run-NNN` per run that names its exact version, plus results, test reports and repeatability files
- uploads that only go into `inputs/`, and production runs that refuse test and sample data
- path attacks, cross-playbook access and links out of the folder
- confirmation for playbook files, protection for the standard folders, and a locked file that does not block the rest
- renaming, duplicating and deleting playbooks
- the Local-workspace vs AI-transport privacy information, and a scan that finds no API key or webhook token in any folder
- the `.zip` package round trip, imports that never run anything, and rejected unsafe or damaged packages
- upgrading an existing data folder

## Project structure

```
server.js                  the server (npm start)
launcher/                  universal launcher: launch.js (npm run dev / launch),
                           check.js (npm run build), setup.js (npm run setup),
                           lib.js (platform, port, readiness, browser, diagnostics)
server/app.js              HTTP API + wiring
server/ai/                 AIProvider interface, the native Anthropic adapter,
                           OpenRouter + the cloud API aggregator presets
                           (NVIDIA, AMD, Google, Groq, …),
                           local providers (Ollama/LM Studio/llama.cpp/vLLM),
                           prompts, typed JSON calls
server/discovery/          intent discovery sessions
server/playbooks/          schema & normalization, validator + quality gate, compiler,
                           versions/lifecycle, Markdown, JSON Patch, built-in example
server/engine/             expression language, decision rules, deterministic executor,
                           AI executor, tools & policies, runs, scheduler
server/testing/            runner, metrics, comparison, test generation, repair
server/pdf/                dependency-free PDF writer + playbook PDF layout
server/workspace/          playbook folders: structure, sync, files API, safe paths,
                           .zip packages (dependency-free writer/reader) and import
shared/graph.js            workflow graph + layered layout (used by server and browser)
public/                    web UI (plain ES modules, no build step);
                           public/views/tabs/files.js is the Files tab
test/                      self-test + scripted provider
docs/PRODUCT_SPEC.md       the product specification this app implements
docs/FEATURE_OLLAMA_V2.md  the Local AI feature specification
docs/FEATURE_LAUNCH_V1.2.1.md  the universal launch + branding specification
docs/FEATURE_WORKSPACE_V1.2.2.md  the self-contained playbook folder specification
CHANGELOG.md               what changed in each version
```

## Troubleshooting

- **"Port 4317 is already in use"**: another program uses that port. If that program is Playbook Builder, the launcher simply opens it. Otherwise start on another port: `npm run launch -- --port 4318`.
- **"npm is not recognized" / "command not found: npm"**: Node.js is not installed, or the terminal was opened before installing it. Install the LTS version from nodejs.org, then open a new terminal.
- **Anything else at startup**: run `npm run setup` for a checklist, and `npm run build` to verify the files. The details of the last failure are in `data/logs/launch-error.log`.
- **Connection test fails (cloud)**: check the key at openrouter.ai/keys and that your network allows `openrouter.ai`. The error text says whether the key was rejected, credits ran out, or the network blocked it.
- **"Can't connect to Ollama"**: Ollama is not running, or it listens somewhere else. Start it, then check `http://localhost:11434` in a browser — it answers "Ollama is running". If you set `OLLAMA_HOST`, put that address in the Server URL field.
- **"Ollama is connected, but no models were found"**: run `ollama pull llama3.2` (or any other model), then **Detect Models** again.
- **A local model is slow on the first call**: the model is being loaded into memory. The connection test allows two minutes for it; later calls are much faster.
- **Generation fails with "did not return a usable response"**: pick a stronger or larger-context model for *Playbook Generation*. Detailed playbooks are long JSON documents.
- **A model ignores JSON mode or tools**: the app falls back automatically. Choose models whose details show "JSON mode" and "tools" for the best results.
- **A playbook was renamed but its folder kept the old name**: a file inside was probably open in another program (Windows does not rename folders with open files). Close it. The folder is renamed at the next change to the playbook.
- **A change made by hand in `playbook/playbook.json` disappeared**: the files outside `inputs/` are written from the playbook. Edit the playbook in the app, or import the edited file with **Import Playbook**.
- **"Production runs only read inputs/runtime"**: the file you picked is sample or test data. Add the real data under **Runtime** in the Files tab, or run in the sandbox.

## Limits worth knowing

- Tool bindings are generic: `input` (data supplied with the run), `http_request` (a real HTTP API) and `builtin` (`current_datetime`). There are no built-in CRM or database connectors. Supply that data in the run input, or point a tool at an HTTP endpoint.
- Scheduled playbooks run only while the app is running.
- AI-mode results depend on the chosen model. That is exactly what repeatability and rule-adherence testing measure. Small local models drift more: compile with the largest model you can run, then use repeatability testing before you publish.
- Local generation needs a large context window. Playbook JSON is long, so a 2k-context model will fail at generation even though it passes the connection test. When you set **Context window (num_ctx)** on a local connection, the app automatically keeps the requested output tokens to half of that window so prompt + answer always fit — if a playbook still comes back cut off, raise `num_ctx` or pick a smaller playbook scope.
- Watch the **Create** screen while generating: every step shows a real "1 of 4" counter with live detail ("Attempt 2 of 3", "12/16 checks passed · repairing gaps", "Batch 2 of 5 — 8 of 20 tests written"). If a step fails, the failing step is marked red and the error banner explains why.
- Generation always runs in the background and survives **anything the UI does** — sidebar navigation, a full page reload, even an app restart (the run is remembered in `localStorage` and the server-side progress job is probed at boot). Reopening the Create screen re-attaches to the live run; a second compile for the same session is refused with `409 already_running` instead of queueing two pipelines against one local model.
- This is a single-user, local application.
- Input files can be up to 20 MB each (10 MB for a file used as run input). Imported packages can be up to 200 MB unpacked.
- The version shown in the sidebar (and returned by `/api/health`) comes from `package.json`. Quote it when you ask for support.

---

Powered By [SiliBlue.in](https://siliblue.in)
