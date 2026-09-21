#!/usr/bin/env node
// Universal launcher — one implementation for Windows, macOS and Linux.
//
//   npm run launch            start Playbook Builder, open the browser when it is ready
//   npm run dev               the same, and restart the server when source files change
//
//   Options (after --):  --port 4318   --no-open   --verbose   --no-prompt
//   Environment:         PORT, PBAI_HOST, PBAI_DATA_DIR, BROWSER=none
//
// Flow (spec §5): detect the platform → check Node → check the port → start the
// server with this same Node binary → wait until /api/health answers → open the
// browser. If anything fails, explain it in plain words and offer Retry.
import os from 'node:os';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import * as L from './lib.js';

const args = L.parseArgs(process.argv.slice(2));
const dev = args.dev;
const verbose = args.verbose || process.env.PBAI_VERBOSE === '1';
const shouldOpen = !args.noOpen && process.env.PBAI_NO_OPEN !== '1' && process.env.BROWSER !== 'none';
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !args.noPrompt && !process.env.CI;
const READY_TIMEOUT_MS = Number(process.env.PBAI_READY_TIMEOUT_MS) || 90000;
const s = L.symbols();

let child = null;
let stopping = false;

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

function banner(cfg) {
  say('');
  say(`  Starting Playbook Builder v${L.APP_VERSION}${dev ? ' (development: restarts when files change)' : ''}`);
  say(`  ${L.platformName()} ${os.arch()} · Node.js ${process.versions.node} · port ${cfg.port}`);
}

/** Start once. Resolves { ok: true } when running, or { ok: false, error, cfg, output }. */
async function startOnce() {
  if (!L.nodeVersionOk()) return { ok: false, error: { code: 'NODE_TOO_OLD' }, cfg: { port: L.DEFAULT_PORT } };

  let cfg;
  try {
    cfg = L.resolveConfig({ args });
  } catch (err) {
    return { ok: false, error: err, cfg: err.cfg || { port: L.DEFAULT_PORT } };
  }
  banner(cfg);

  // Already running? Then just open it — never start a second copy on the same data.
  const existing = await L.probeHealth(cfg.port, cfg.probeHost);
  if (existing) {
    say(`  ${s.ok} Playbook Builder${existing.version ? ` v${existing.version}` : ''} is already running at ${cfg.url}`);
    if (shouldOpen) {
      const opened = await L.openBrowser(cfg.url);
      say(opened ? `  ${s.arrow} Opened ${cfg.url} in your browser.` : `  ${s.arrow} Open ${cfg.url} in your browser.`);
    }
    say('');
    return { ok: true, attached: false };
  }

  const port = await L.checkPort(cfg.port, cfg.host);
  if (!port.free) return { ok: false, error: { code: port.code, syscall: 'listen' }, cfg };

  // Same Node binary, absolute script path, no shell: identical on every platform.
  const nodeArgs = [];
  if (dev) nodeArgs.push('--watch');
  else nodeArgs.push('--no-warnings');
  nodeArgs.push(L.SERVER_ENTRY);
  child = spawn(process.execPath, nodeArgs, {
    cwd: L.ROOT,
    env: { ...process.env, PORT: String(cfg.port), PBAI_LAUNCHER: '1', ...(dev ? { PBAI_DEV: '1' } : {}) },
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  let ready = false;
  let exited = null;
  let output = '';
  let structured = null;
  let watchFailed = false;
  child.stdout.on('data', (d) => {
    process.stdout.write(d);
    if (!ready) output += d.toString();
  });
  child.stderr.on('data', (d) => {
    const text = d.toString();
    if (ready || verbose) {
      // After startup the server's own messages are shown as they are,
      // except the machine-readable line meant for this launcher.
      const visible = text
        .split(/(?<=\n)/)
        .filter((l) => !l.startsWith(L.STARTUP_ERROR_PREFIX))
        .join('');
      if (visible) process.stderr.write(visible);
    }
    if (!ready) {
      output += text;
      structured = structured || L.parseStartupError(output);
      if (dev && /Failed running/.test(output)) watchFailed = true;
    }
  });
  child.on('exit', (code, signal) => {
    exited = { code, signal };
    if (ready) process.exit(stopping ? 0 : code ?? 0);
  });
  child.on('error', (err) => {
    exited = { code: 1, error: err };
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (exited || structured || watchFailed) break;
    const health = await L.probeHealth(cfg.port, cfg.probeHost, 1000);
    if (health) {
      ready = true;
      break;
    }
    if (Date.now() > deadline) {
      structured = { code: 'NOT_READY', message: `No answer from ${cfg.url} after ${Math.round(READY_TIMEOUT_MS / 1000)} seconds.` };
      break;
    }
    await L.sleep(250);
  }

  if (!ready) {
    await stopChild();
    const error = structured || (exited && exited.error) || { code: 'EXITED', message: `The server stopped during startup (exit code ${exited ? exited.code : 'unknown'}).` };
    return { ok: false, error, cfg, output };
  }

  say(`  ${s.ok} Ready at ${cfg.url}`);
  if (shouldOpen) {
    const opened = await L.openBrowser(cfg.url);
    say(opened ? `  ${s.arrow} Opening ${cfg.url} in your browser…` : `  ${s.arrow} Open ${cfg.url} in your browser.`);
  }
  say(`  Keep this window open while you use Playbook Builder. Press Ctrl+C to stop.`);
  say('');
  return { ok: true, attached: true };
}

function stopChild() {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const done = () => resolve();
    child.once('exit', done);
    try {
      child.kill('SIGTERM');
    } catch { /* already gone */ }
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch { /* already gone */ }
      resolve();
    }, 4000).unref();
  });
}

// One readline interface for every prompt, with a queue so answers typed ahead
// of the prompt are not lost.
let rl = null;
let waiter = null;
const typedAhead = [];
async function ask(question) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', (line) => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(line);
      } else typedAhead.push(line);
    });
    rl.on('close', () => {
      rl = null;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w('q');
      }
    });
  }
  rl.setPrompt(question);
  rl.prompt();
  const line = typedAhead.length ? typedAhead.shift() : await new Promise((r) => {
    waiter = r;
  });
  return String(line || '').trim().toLowerCase();
}

function closePrompt() {
  typedAhead.length = 0;
  if (rl) rl.close();
}

async function main() {
  for (;;) {
    const result = await startOnce();
    if (result.ok) {
      if (!result.attached) process.exit(0);
      return; // the launcher lives as long as the server
    }
    if (stopping) process.exit(0); // Ctrl+C during startup is not an error
    const diag = L.diagnose(result.error, result.cfg);
    const logPath = L.writeErrorLog(result.cfg, { error: result.error, output: result.output });
    process.stdout.write(L.formatPanel(diag, { logPath, interactive }));
    if (verbose && result.output) process.stdout.write(`\n  Server output:\n${result.output}\n`);
    if (!interactive) process.exit(1);
    for (;;) {
      const a = await ask(`  [R] Retry   [S] View setup instructions   [Q] Quit  ${s.arrow} `);
      if (a === 's' || a === 'setup') {
        process.stdout.write(L.setupInstructions());
        continue;
      }
      if (a === 'r' || a === 'retry') {
        closePrompt(); // the server needs the console again
        break;
      }
      process.exit(1);
    }
  }
}

// Ctrl+C reaches the server too (same console); give it a moment to shut down
// cleanly, then make sure it is gone. SIGTERM (from a process manager) is passed on.
process.on('SIGINT', () => {
  stopping = true;
  if (!child || child.exitCode !== null) process.exit(0);
  setTimeout(() => stopChild().then(() => process.exit(0)), 1500).unref();
});
process.on('SIGTERM', () => {
  stopping = true;
  stopChild().then(() => process.exit(0));
});

main().catch((err) => {
  // The launcher itself failed: still no stack trace for the user.
  const cfg = { port: L.DEFAULT_PORT, dataDir: '' };
  const logPath = L.writeErrorLog(cfg, { error: err });
  process.stdout.write(L.formatPanel(L.diagnose(err, cfg), { logPath, interactive: false }));
  process.exit(1);
});
