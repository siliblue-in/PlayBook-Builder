# Feature Playbook v1.2.1 — Universal Launch + Sidebar Branding

**Product:** Playbook Builder for AI
**Version:** 1.2.1
**Feature:** Cross-platform application launch + improved SiliBlue.in branding
**Brand:** Powered By SiliBlue.in

> The specification this release implements, followed by build notes that record
> how each section was implemented and where the implementation deliberately differs.

---

## 1. Version Objective

Version **1.2.1** introduces two focused improvements.

**Universal Launch** — the application must launch consistently on macOS, Windows and Linux without relying on a Windows-specific `.bat` file.

**Sidebar Branding** — increase the visibility of **Powered By SiliBlue.in** in the application sidebar by making it slightly larger and bolder while keeping it professional.

## 2. Universal Launch Requirement

Do **not** make `.bat` the primary launcher. Avoid `launch.bat`, `start.bat` and `run.bat` as the required way to start the application. The application should use a platform-independent launch mechanism.

## 3. Recommended Launch Architecture

If the application uses Node.js / Next.js, use the package manager as the primary launcher — `npm run dev` or `npm start`. These commands work across macOS, Windows and Linux. The application should define launch scripts in `package.json`:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  }
}
```

Do not embed platform-specific paths or shell syntax in these commands.

## 4. Universal Launcher

For a one-click desktop-style launcher, create a platform-independent launcher using Node.js rather than `.bat`.

```text
launcher/
├── launch.js
└── package.json
```

```javascript
const { spawn } = require("child_process");

const command = process.platform === "win32"
  ? "npm.cmd"
  : "npm";

const child = spawn(
  command,
  ["run", "dev"],
  {
    stdio: "inherit",
    shell: false
  }
);

child.on("exit", code => {
  process.exit(code ?? 0);
});
```

This gives the project one launcher implementation instead of maintaining separate Windows and Unix launch scripts.

## 5. Launch Flow

```text
User launches application
        ↓
Universal Launcher
        ↓
Detect operating system automatically
        ↓
Start Node/npm process
        ↓
Start Playbook Builder
        ↓
Open application
```

The user should not need to know whether the machine is Windows, macOS or Linux.

## 6. Windows Behavior

Windows must not depend on `.bat`. The launcher should work using the same project command (`npm run dev`) or the universal Node launcher. If a packaged desktop executable is eventually provided, Windows-specific packaging can be added later, but it must not change the Playbook Builder's core launch architecture.

## 7. macOS Behavior

Support `npm run dev` or the universal launcher `node launcher/launch.js`. No `.command` file should be required.

## 8. Linux Behavior

Support `npm run dev` or `node launcher/launch.js`. No `.sh` file should be required as the only launcher.

## 9. Optional Convenience Commands

```text
Development:
npm run dev

Production:
npm run build
npm start
```

The same commands should work on macOS, Windows and Linux.

## 10. No Hard-Coded Platform Paths

Do not use `C:\...`, `/Users/...` or `/home/...` in launcher logic. Use `process.cwd()`, `process.env` and `path.join()` for platform-independent paths. Prefer Node's `path` APIs instead of manually constructing path strings.

## 11. Launch Diagnostics

If startup fails, show a readable error:

```text
Playbook Builder could not start.

Possible causes:
• Node.js is not installed
• Dependencies are not installed
• Another process is using the required port
• Configuration is invalid

[ Retry ]
[ View Setup Instructions ]
```

Do not expose raw stack traces to normal users.

## 12. Automatic Browser Launch

After the local server starts successfully, optionally open the default browser.

```text
Launcher
   ↓
Start server
   ↓
Wait until server is reachable
   ↓
Open:
http://localhost:3000
```

Do not open the browser before the server is ready.

## 13. Port Configuration

Allow an environment-based port (`PORT=3000`). Use `http://localhost:${PORT}` rather than hard-coding the browser URL throughout the launcher. If the default port is unavailable, show a useful error or allow a configured alternative.

## 14. Universal Setup Documentation

```text
## Launch Playbook Builder

### 1. Install Node.js
Install a supported Node.js version.

### 2. Install Dependencies
Run:
npm install

### 3. Start Development
Run:
npm run dev

### 4. Open the Application
Open the URL shown by the terminal.
```

Do not instruct users to run `launch.bat` as the primary setup path.

## 15. Optional One-Command Setup

For a future packaged version, support `npm run setup` and `npm run launch`. The commands should remain cross-platform.

```json
{
  "scripts": {
    "setup": "...",
    "launch": "node launcher/launch.js"
  }
}
```

## 16. Sidebar Branding Update

Increase the visibility of **Powered By SiliBlue.in**. The branding should be slightly larger, bold, highly legible and visually separated from navigation.

## 17. Sidebar Branding UI

```text
┌──────────────────────────────┐
│ ✦ Playbook Builder           │
│                              │
│ Dashboard                    │
│ Create Playbook              │
│ Playbooks                    │
│ Test Center                  │
│ Runs                         │
│ AI Connections               │
│ Settings                     │
│                              │
│ ──────────────────────────── │
│                              │
│ Powered By                   │
│ SiliBlue.in                  │
└──────────────────────────────┘
```

Make **SiliBlue.in** slightly more prominent than **Powered By**.

## 18. Recommended Styling

- **Powered By:** 12–13px, medium weight
- **SiliBlue.in:** 14–15px, 600–700 font weight

The exact values can be adjusted to fit the design system. The branding should remain compact enough that it does not compete with the primary navigation.

## 19. Sidebar Branding Placement

Place the branding at the bottom of the sidebar: Navigation → flexible space → Version → Powered By SiliBlue.in.

## 20. Branding Visibility

The branding should remain visible when the sidebar is expanded or collapsed, in light mode and in dark mode. When the sidebar collapses, use a compact representation such as `SB` or `SiliBlue.in` depending on available width. Do not completely hide the branding unless the user's interface preferences require a minimal sidebar.

## 21. Version Display

Show `v1.2.1` near the bottom of the sidebar, above **Powered By SiliBlue.in**. This makes the current application version visible to users and useful for support/debugging.

## 22. Version Constant

Maintain the version in one place (`"version": "1.2.1"`). Avoid hard-coding `1.2.1` independently in multiple files. The UI should obtain the displayed version from the application version source.

## 23. Acceptance Criteria — Universal Launch

```text
✓ macOS launches successfully
✓ Windows launches successfully
✓ Linux launches successfully
✓ No .bat file is required
✓ npm run dev works on all three platforms
✓ npm start works on all three platforms
✓ Launcher does not depend on OS-specific paths
✓ Browser opens after the server is ready
✓ Startup errors are understandable
```

## 24. Acceptance Criteria — Branding

```text
✓ "Powered By SiliBlue.in" is visible in sidebar
✓ Branding is larger than previous version
✓ Branding is bolder than previous version
✓ Works in light mode
✓ Works in dark mode
✓ Remains visible in normal sidebar state
✓ Version displays as v1.2.1
```

## 25. Version 1.2.1 Final Flow

```text
Launch → Universal Node/npm Launcher → Detect Platform → Start Application → Open Browser
→ Playbook Builder v1.2.1 (AI Connections, Intent Discovery, Playbook Builder, Visual Workflow,
  Markdown / PDF, Test Center, Execution)
→ Sidebar Footer: v1.2.1 · Powered By SiliBlue.in
```

## 26. Implementation Checklist

Remove `.bat` as primary launcher · add universal Node.js launcher · verify npm scripts · test Windows, macOS, Linux · add automatic browser launch · add startup error handling · centralize application version · set version to 1.2.1 · increase sidebar branding size and weight · verify light and dark mode · display v1.2.1 · regression-test application startup.

## 27. Final Requirement

Version 1.2.1 must feel like a platform release rather than a Windows-specific application: Install → `npm install` → `npm run dev` → Playbook Builder. No `.bat` dependency. The sidebar should clearly show **Powered By SiliBlue.in** with increased size and weight, while remaining consistent with the application's visual design.

---

## Build notes

| Spec | Implementation |
|---|---|
| §2, §6–§8, §27 | `start.bat` and `start.sh` are removed. Every platform uses `npm install` → `npm run dev`. |
| §3, §9, §15 | `package.json` scripts, with no shell syntax, no `&&` and no paths beyond forward-slash project-relative ones: `dev` (launcher with auto-restart), `launch` (launcher), `start` (`node server.js`), `build`, `setup` and `test`. |
| §4 | `launcher/launch.js`, with shared helpers in `launcher/lib.js` and `launcher/package.json`. It uses ES modules, like the rest of the project. |
| §4 (deliberate difference) | The launcher does **not** spawn `npm.cmd` as the example does. Node.js releases since April 2024 (18.20.2, 20.12.2, 21.7.3 and later) throw `EINVAL` when a `.cmd` or `.bat` file is spawned without a shell on Windows, so the example would fail on current Node versions. The launcher starts `server.js` with `process.execPath` (the Node binary already running) and an absolute script path, with no shell. It is the same call on every platform. |
| §3 (deliberate difference) | This is not a Next.js app and has no compile step. `npm run build` therefore verifies the installation: Node version, server modules load, every browser/shared/launcher file parses. |
| §5 | Launch flow: detect the platform (shown in the banner), check Node.js, check whether Playbook Builder is already running, check the port, start the server, wait for `/api/health`, then open the browser. |
| §10 | Paths come from `import.meta.url`, `path.join()` and `process.env`. The self-test scans the launcher files for `C:\`, `/Users/` and `/home/`. |
| §11 | `diagnose()` and `formatPanel()` in `launcher/lib.js`. The panel covers Node.js too old, missing/damaged files, port in use, port not allowed, unusable data folder, invalid port/host, and a generic fallback listing the spec's four causes. **[R] Retry** and **[S] View setup instructions** are offered when a person is at the terminal. Stack traces go only to `data/logs/launch-error.log`. `server.js` explains its own startup errors the same way when run with `npm start`. |
| §12 | The browser opens only after `/api/health` answers. The commands are `cmd /c start "" <url>` with verbatim arguments on Windows, `open` on macOS, and `xdg-open`, then `gio open`, then `sensible-browser` on Linux (`wslview` first under WSL). `--no-open` or `BROWSER=none` skips it. |
| §13 (deliberate difference) | The default port stays **4317**, as in earlier versions, so existing bookmarks keep working and it does not collide with common dev servers on 3000. `PORT` or `--port` changes it, and the URL is always built from the resolved port. A busy port gets a clear explanation and a ready-to-copy `--port` command. If the busy port is Playbook Builder itself, the running copy is opened. |
| §14 | README → "Launch Playbook Builder". |
| §16–§19 | Sidebar footer, separated by a rule: `v1.2.1` (12 px, 600), **Powered By** (12.5 px, 500) and **SiliBlue.in** (15 px, 700), linking to siliblue.in. The AI-connection pill sits above the rule. |
| §20 | Below 900 px wide the sidebar collapses behind the menu button. The top bar then shows **SiliBlue.in**, or **SB** below 380 px. |
| §21–§22 | The version exists only in `package.json`. The server reads it (`/api/meta`, `/api/health`, banner) and the UI displays it from `/api/meta`. The self-test fails if the version literal appears in any source file. |
| §23 | Linux was run for real in the self-test, which starts real processes. The Windows and macOS code paths (browser command, no shell, no platform paths) are covered by platform-parameterised tests. Running `npm run dev` on a real Windows or Mac is the final check. |

Powered By SiliBlue.in
