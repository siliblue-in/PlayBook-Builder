# Feature Playbook v1.2.2 — Self-Contained Playbook Folder

**Product:** Playbook Builder for AI
**Version:** 1.2.2
**Feature:** A self-contained workspace folder for every playbook
**Brand:** Powered By SiliBlue.in

> The requirements of the v1.2.2 feature specification, grouped by topic. After them come the
> folder reference and build notes that record how each requirement was implemented, and
> where the implementation deliberately differs.

---

## 1. Objective

Every playbook should be self-contained. Everything needed to understand, test, run and review a playbook is kept in one folder that belongs to that playbook: the playbook itself, what was asked for, how it works, its data, its tests, its results and its exports.

## 2. One folder per playbook

- Each playbook gets its own folder, created automatically when the playbook is created.
- The folder is named after the playbook. The name is sanitized so it is valid on Windows, macOS and Linux.
- The playbook has a stable ID. Renaming the playbook renames its folder and changes nothing else.
- A request for Playbook A must never be able to reach Playbook B's folder through a manipulated path. This is enforced with server-side authorization and path validation.
- A user's playbook data is never exposed to other users or other playbooks.

## 3. Folder structure

```text
<Playbook Name>/
├── playbook/        playbook.json · playbook.md · playbook.pdf
├── requirements/    intent.json · requirements.md · assumptions.json
├── process/         workflow · dependencies · tools · configuration · execution-plan
├── inputs/          sample/ · test/ · runtime/
├── tests/           test-suite.json · test-cases/ · repeatability/ · reports/
├── results/         latest/ · history/ · summaries/
├── executions/      run-001/ · run-002/ …
├── exports/         markdown/ · pdf/ · json/
├── metadata/        version.json · settings.json · activity.json
└── versions/        (optional) earlier versions
```

Each execution folder holds `input.json`, `execution.json`, `step-results.json`, `output.json` and `report.md`. Each execution references the exact playbook version it ran.

## 4. Files / Workspace tab

- Show the playbook's folder, with **📁 Playbook Workspace** as its heading.
- The file actions are **Open, Preview, Copy, Download, Rename, Delete, Duplicate**.
- Deleting a critical playbook file requires confirmation.
- Files can be added by drag and drop. The user chooses whether they are **Sample**, **Test** or **Runtime** data.
- The application must not automatically treat arbitrary uploaded files as production inputs.

## 5. Test data and runtime data

Test data is never automatically mixed with production or runtime data. Tests use test data, and production runs use runtime data.

## 6. Package and import

- **Download Playbook Package** downloads the whole folder as a `.zip`.
- **Import** accepts a `.playbook.json` file or a `.zip` package.
- The package is validated before anything is imported. Imported tools and actions are never executed automatically.

## 7. Privacy

- Show a **🔒 Local Workspace** badge when Privacy Mode is Local Only.
- Make clear that workspace storage is not the same thing as AI provider transport. The files live on this computer. Privacy Mode governs where AI requests go.
- Credentials are never stored in the playbook, and provider credentials are referenced by `connection_id`.

## 8. Version and brand

The version is 1.2.2, kept in one place. Every surface carries **Powered By SiliBlue.in**.

---

## Folder reference

| Path | Contents |
|---|---|
| `README.md` | What the folder is, the playbook ID, the current and production versions, and what each folder holds. |
| `playbook/playbook.json` | The canonical Playbook JSON of the current version. It is identical to the JSON export. |
| `playbook/playbook.md`, `playbook.pdf` | Generated from the JSON. They are the same documents as the Markdown and PDF exports. |
| `requirements/intent.json` | The confirmed intent: objective, criteria, source, action, frequency, plus the full discovery details. A playbook without a discovery session gets an intent derived from the playbook, which says so. |
| `requirements/requirements.md` | Requirements grouped by type, constraints, success criteria, assumptions and open questions. |
| `requirements/assumptions.json` | Assumptions from the playbook and from the intent, and the open questions. |
| `process/workflow.json` | Trigger, execution order, parallel groups, steps and the workflow graph (nodes, edges, issues). |
| `process/dependencies.json`, `tools.json`, `configuration.json` | Dependencies (playbook and per step), tools with permissions, and configuration values. |
| `process/execution-plan.json` | Step by step: order, who runs it (engine, person or AI model), inputs, tools, decision rules, output, validation, failure and retry behavior. |
| `inputs/sample/` | Examples of the input format. `example-input.json` is written once from the playbook's input examples. |
| `inputs/test/` | Data for tests only. |
| `inputs/runtime/` | Real data. It is the only input folder a production run can read. |
| `tests/test-suite.json` | The suite, with its revision and every test. |
| `tests/test-cases/<test>.json` | One file per test case, named after the test (`boundary-14.json`). |
| `tests/repeatability/` | `run-01.json` … one file per run of the latest repeatability test. It holds the match, decisions, rule adherence and output of each run. With several repeatability tests, each gets a subfolder. |
| `tests/reports/latest.json`, `latest.md` | The newest test report, as structured data and as a readable report. |
| `tests/reports/history/<date>-test-NNN.json` | Every test run. |
| `executions/run-NNN/` | One folder per run: `input.json`, `execution.json`, `step-results.json`, `output.json`, `report.md`. |
| `results/latest/` | `result.json`, `result.md` and `summary.json` of the most recently finished run. |
| `results/history/<date>-run-NNN/` | The result of every finished run. |
| `results/summaries/runs.json`, `tests.json` | Tables of all runs and all test runs. |
| `exports/markdown/`, `pdf/`, `json/` | `<Playbook Name>.md`, `.pdf` and `.json`. Each is written only when that export is switched on in Settings. |
| `metadata/version.json` | Playbook ID, folder, current version, status and hash, production version, and the list of every version with its snapshot path. |
| `metadata/settings.json` | Settings that affect the playbook: AI transport and privacy mode, configuration, trigger, schedule, test thresholds and execution safety. It holds no secrets. |
| `metadata/activity.json` | The last 1,000 events: created, renamed, versions, status changes, promotions, tests, runs, files added, renamed and deleted, packages, imports. |
| `metadata/manifest.json` | The files generated from the playbook, so obsolete ones can be removed. |
| `versions/vN/` | `playbook.json` and `version.json` for every version. |

---

## Build notes

| Requirement | Implementation |
|---|---|
| Folder per playbook (§2) | `server/workspace/workspace.js` (`WorkspaceService`). Folders live in `data/workspaces/`, or in `PBAI_WORKSPACES_DIR` when that is set. The service observes the store's playbooks, runs and test runs, so every change lands in the folder, whether it comes from the UI, the API, the scheduler or a webhook. Work for one playbook is serialized in its own queue, and playbook edits are debounced (120 ms). |
| Safe names (§2) | `sanitizeName()`: <ul><li>removes `< > : " / \ | ? *` and control characters, and collapses spaces</li><li>trims leading and trailing dots and spaces</li><li>limits names to 60 characters</li><li>turns reserved device names (`CON`, `NUL`, `COM1` …) into `CON Playbook`</li><li>uses "Untitled Playbook" when nothing is left</li></ul>Folder names are unique without regard to case, as Windows and macOS require, so a second playbook with the same name gets `Name (2)`. |
| Stable ID, rename (§2) | The folder name is stored with the playbook record (`workspace.folder`). A rename moves the folder in place and logs it in `activity.json`. If Windows refuses because a file inside is open, the old name is kept and the rename is retried at the next change. |
| Structure (§3) | All standard folders are created up front, so empty ones exist too. Generated files are rewritten only when their content changes, so file dates stay meaningful. A file another program keeps open (a PDF viewer on Windows) is skipped and logged, the rest still update, and it is updated at the next change. |
| Executions reference the version (§3) | `execution.json` has `version`, `version_status`, `version_hash` and `version_snapshot` (`versions/vN/playbook.json`). Runs are numbered per playbook, and numbers are never reused, even after a run folder is deleted. |
| Files tab (§4) | `public/views/tabs/files.js`. <ul><li>A tree in the order the structure above uses, with a description for every standard folder.</li><li>Previews: JSON, Markdown (rendered), PDF, images, CSV (table) and text.</li><li>Actions: **Open** (new tab), **Copy** (content), **Download**, **Duplicate**, **Rename**, **Delete**.</li><li>Header: **Download Playbook Package**, **Add input files**, **Open folder** (Explorer / Finder / file manager), **Copy path**, and **Refresh**, which rewrites the generated files.</li></ul> |
| Confirmation (§4) | Server-enforced: the delete API answers `409 confirm_required` without `confirm: true` for playbook files and history. The UI explains that generated files come back. The standard folders cannot be deleted or renamed (`409 protected`). Generated files cannot be renamed. User files in `inputs/` need no confirmation. |
| Drag and drop (§4) | Dropping files on the tab asks **Sample / Test / Runtime**. Dropping on an `inputs/…` folder uses that folder. The upload API accepts only `inputs/sample`, `inputs/test` and `inputs/runtime`, at up to 20 MB per file. Names are sanitized, and an existing name gets ` (2)`. |
| Test vs runtime data (§5) | A run can take its input from a workspace file (`input_file`). Production runs may read only `inputs/runtime/`, and the server answers `409 test_data_in_production` for sample or test data. Sandbox runs may use any input folder. The file used is recorded as `input_source` and shown on the run page. The client cannot set `input_source` itself. |
| Package (§6) | `server/workspace/zip.js`, a dependency-free ZIP writer: <ul><li>deflate, UTF-8 names and CRC-32</li><li>explicit folder entries, so empty folders survive</li><li>Unix permissions for macOS and Linux</li></ul>The archive's top folder is the playbook folder, and the download is named `<Playbook Name>.zip`. |
| Import (§6) | **Playbooks → Import Playbook** (drop or choose a `.zip` or `.json`, or paste JSON). The package is validated before anything is written: <ul><li>it needs `playbook/playbook.json` (or a `*.playbook.json`) with a non-empty steps array</li><li>paths are checked for zip-slip (`..`, absolute paths and drive letters)</li><li>archives are checked for encryption, ZIP64, unknown compression and CRC mismatches</li><li>size limits: 5,000 entries, 50 MB per file and 200 MB in total</li></ul>The playbook then goes through the same normalization and quality gate as every other playbook. It becomes a **draft** with its intent, tests and input files. Nothing is run, tested or called. |
| Credentials (§7) | Nothing secret is written to a workspace: <ul><li>`settings.json` holds the AI transport and `connection_id`, never a key</li><li>webhook tokens are not written</li><li>an imported playbook's `ai.connection_id` is reset, with a warning, so a package can never point at a connection on another computer</li></ul>The self-test scans every workspace file for API keys and webhook tokens. |
| Privacy UI (§7) | The Files tab header reads **Playbook Workspace** (folder icon) with "All Playbook files, test artifacts, process definitions and execution results are organized under this Playbook." It shows a **🔒 Local Workspace** badge under Local Only and "Stored on this computer" otherwise. Two lines separate **Workspace storage** (this computer) from **AI transport** (the actual provider and model, local or cloud). Settings → Privacy says the same. |
| Path boundaries (§2) | Every file request is resolved through the playbook ID. `cleanRel()` rejects: <ul><li>`..`</li><li>backslashes and `:` (drive letters and streams)</li><li>control characters</li><li>reserved device names</li><li>trailing dots and spaces</li></ul>`resolve()` then checks both the lexical path and the real path (following links) against the playbook's own folder, without regard to case on Windows and macOS. Links are never listed, packaged or copied. |
| Safe previews (§2, §4) | Every file response carries `X-Content-Type-Options: nosniff`, and every file except PDFs and images gets `Content-Security-Policy: sandbox`. Unknown types, including HTML, are served only as `attachment` with `application/octet-stream`. An uploaded file is stored and never run. |
| Settings changes | Changing an export switch, Privacy Mode, the default connection or a test threshold refreshes every workspace (`exports/`, `metadata/settings.json`). |
| Upgrades | At startup, playbooks without a folder get one. Earlier runs and test runs are filed into `executions/` and `tests/reports/` in date order. |

### Deliberate differences

| Topic | Decision |
|---|---|
| Source of truth | The JSON document store stays the database, and the folder is a faithful, always-current mirror of it. Versions are immutable once published, writes are atomic, and one playbook's work is serialized. Reading hand-edited files back from disk would weaken all three. So the files outside `inputs/` are written from the playbook: editing them by hand is overwritten at the next change, and a deleted one is recreated. To change a playbook from a file, import it. |
| `versions/` | Always written, rather than optional. Each execution's `version_snapshot` points into it, which makes a package complete on its own. |
| Import scope | Imports bring the playbook, intent, tests and input files. They do not bring execution history, results, exports or version snapshots: an imported playbook starts fresh as a draft, and its history stays with the original. The import result lists what was skipped. |
| Deleting a playbook | Deletes its folder too, and the confirmation says so. Archiving a playbook keeps it. |
| Open folder | Only available when Playbook Builder listens on this computer (localhost). Opening a file manager makes no sense for a remote browser. |

### Verification

`npm test` runs 54 workspace checks among its 182. Each group was checked through the real HTTP API, on Linux:

- **Folder and files:** the structure, every generated file, and safe and colliding names.
- **Runs and tests:**
  - the run folder, and the version reference with its hash and snapshot
  - `results/latest`, history and summaries
  - test reports, and repeatability files
- **Inputs:**
  - uploads confined to `inputs/`
  - production refusing test and sample data
  - an `input_source` that cannot be faked
- **Security:**
  - path attacks: `..`, backslashes, drive letters, `/etc/passwd`, device names
  - cross-playbook access, and links out of the folder
  - an uploaded HTML page served only as a download
- **File actions:** confirmation, recreation, protection, duplicate/rename/delete, a file that cannot be written, and renaming the playbook.
- **Privacy and secrets:**
  - the local workspace vs the cloud and local AI transport
  - `settings.json` following settings changes
  - a secrets scan of every workspace
- **Package and import:**
  - the package round trip, byte for byte, including empty folders
  - import of a `.zip` and a `.playbook.json`, with nothing run and the connection reset
  - unsafe, empty, damaged, truncated and non-JSON uploads refused, with nothing written
- **Lifecycle:** duplicate (inputs copied, no history), delete, and an upgrade of a pre-1.2.2 data folder.

The Windows and macOS code paths are covered by platform-parameterized checks (the Explorer and Finder commands) and by case-insensitive path handling. A real Windows or Mac run of `npm test` is the final check.

Powered By SiliBlue.in
