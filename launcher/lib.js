// Shared launch helpers — used by launcher/launch.js, launcher/setup.js,
// launcher/check.js and server.js.
//
// Rules this file follows so it behaves the same on Windows, macOS and Linux:
//   • Node built-ins only.
//   • No hard-coded platform paths: everything is resolved from this file's own
//     location with path.join(), from process.cwd() and from process.env.
//   • No shells and no npm.cmd: the server is started with the Node binary that
//     is already running (process.execPath). Current Node versions refuse to
//     spawn .cmd/.bat files without a shell on Windows, so that path is avoided.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SERVER_ENTRY = path.join(ROOT, 'server.js');
export const README = path.join(ROOT, 'README.md');
export const MIN_NODE = [18, 17];
export const DEFAULT_PORT = 4317;
export const STARTUP_ERROR_PREFIX = 'PBAI_STARTUP_ERROR ';

/** package.json is the single source of the application version (spec §22). */
export function readPackage() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
}
export const APP_VERSION = readPackage().version;

const PLATFORM_NAMES = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
export function platformName(platform = process.platform) {
  return PLATFORM_NAMES[platform] || platform;
}

export function nodeVersionOk(version = process.versions.node) {
  const [major, minor] = String(version).split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

/** Terminal symbols: Unicode where the console can show it, plain ASCII otherwise. */
export function symbols(platform = process.platform, env = process.env) {
  const plain = platform === 'win32' && !env.WT_SESSION && env.TERM_PROGRAM !== 'vscode';
  return plain ? { ok: '+', bad: 'x', warn: '!', info: '-', bullet: '-', arrow: '>' } : { ok: '✓', bad: '✗', warn: '!', info: '·', bullet: '•', arrow: '›' };
}

/** --port 4318 · --port=4318 · --no-open · --open · --dev · --verbose · --no-prompt */
export function parseArgs(argv = []) {
  const out = { flags: new Set(), port: undefined, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = argv[++i];
    else if (a.startsWith('--port=')) out.port = a.slice('--port='.length);
    else if (a.startsWith('--')) out.flags.add(a.slice(2));
    else out.rest.push(a);
  }
  out.open = out.flags.has('open');
  out.noOpen = out.flags.has('no-open');
  out.dev = out.flags.has('dev');
  out.verbose = out.flags.has('verbose');
  out.noPrompt = out.flags.has('no-prompt');
  return out;
}

/** Port, host, URL and data folder from arguments and environment (spec §13). */
export function resolveConfig({ args = {}, env = process.env } = {}) {
  const raw = args.port ?? env.PORT ?? env.PBAI_PORT ?? DEFAULT_PORT;
  const port = Number(raw);
  const host = env.PBAI_HOST || '127.0.0.1';
  const dataDir = path.resolve(env.PBAI_DATA_DIR || path.join(ROOT, 'data'));
  const cfg = { port, host, dataDir, url: '', probeHost: '127.0.0.1' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const err = new Error(`The port must be a whole number between 1 and 65535 (got "${raw}").`);
    err.code = 'INVALID_PORT';
    err.cfg = { ...cfg, port: DEFAULT_PORT, url: `http://localhost:${DEFAULT_PORT}` };
    throw err;
  }
  const loopback = ['127.0.0.1', '0.0.0.0', '::', '::1', 'localhost'].includes(host);
  cfg.url = `http://${loopback ? 'localhost' : host}:${port}`;
  cfg.probeHost = loopback ? (host === '::1' ? '::1' : '127.0.0.1') : host;
  return cfg;
}

/** The command a user should run again — the npm script they used, when there is one. */
export function commandHint(extra = '', env = process.env) {
  const script = env.npm_lifecycle_event;
  const base = script === 'start' ? 'npm start' : script ? `npm run ${script}` : 'npm run launch';
  return extra ? `${base} -- ${extra}` : base;
}

// ------------------------------------------------------------------ network

/** Is the port free on this host? Resolves { free, code }. */
export function checkPort(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', (err) => resolve({ free: false, code: err.code || 'EADDRINUSE' }));
    srv.once('listening', () => srv.close(() => resolve({ free: true })));
    srv.listen(port, host);
  });
}

/** GET /api/health. Resolves { ok, version } when Playbook Builder answers, else null. */
export function probeHealth(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/api/health', timeout: timeoutMs, headers: { Accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > 65536) req.destroy();
      });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(res.statusCode === 200 && j && j.ok === true ? { ok: true, version: j.version || null } : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ browser (spec §12)

/**
 * Commands that open a URL in the default browser, in the order to try them.
 * Pure function so every platform can be tested on any platform.
 */
export function browserCommands(url, platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    // cmd's "start" with verbatim arguments; "" is the window title, ^& escapes query separators.
    return [{ command: 'cmd', args: ['/c', 'start', '""', '/b', String(url).replace(/&/g, '^&')], options: { windowsVerbatimArguments: true } }];
  }
  if (platform === 'darwin') return [{ command: 'open', args: [url], options: {} }];
  const list = [];
  if (env.WSL_DISTRO_NAME) list.push({ command: 'wslview', args: [url], options: {} });
  list.push({ command: 'xdg-open', args: [url], options: {} }, { command: 'gio', args: ['open', url], options: {} }, { command: 'sensible-browser', args: [url], options: {} });
  return list;
}

/** Commands that show a folder in the file manager (Explorer, Finder, Files). */
export function folderCommands(dir, platform = process.platform, env = process.env) {
  // Windows: the path is quoted by hand so commas (Explorer's own separator) stay
  // part of it, and the window must not be hidden: Explorer is a GUI program.
  if (platform === 'win32') return [{ command: 'explorer.exe', args: [`"${dir}"`], options: { windowsVerbatimArguments: true, windowsHide: false } }];
  if (platform === 'darwin') return [{ command: 'open', args: [dir], options: {} }];
  const list = [];
  if (env.WSL_DISTRO_NAME) list.push({ command: 'wslview', args: [dir], options: {} });
  list.push({ command: 'xdg-open', args: [dir], options: {} }, { command: 'gio', args: ['open', dir], options: {} });
  return list;
}

/** Show a folder in the computer's file manager. Resolves true when a file manager was started. */
export function openFolder(dir, { platform = process.platform, env = process.env } = {}) {
  return startFirst(folderCommands(dir, platform, env));
}

/** Open the browser. Resolves true when an opener was started, false when none exists. */
export function openBrowser(url, { platform = process.platform, env = process.env } = {}) {
  if (env.BROWSER === 'none' || env.PBAI_NO_OPEN === '1') return Promise.resolve(false);
  return startFirst(browserCommands(url, platform, env));
}

/** Start the first command that exists on this computer (no shell, detached). */
function startFirst(candidates) {
  return new Promise((resolve) => {
    const next = (i) => {
      if (i >= candidates.length) return resolve(false);
      const c = candidates[i];
      let child;
      try {
        child = spawn(c.command, c.args, { stdio: 'ignore', detached: true, windowsHide: true, ...c.options });
      } catch {
        return next(i + 1);
      }
      child.once('error', () => next(i + 1));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    };
    next(0);
  });
}

// ------------------------------------------------------------------ diagnostics (spec §11)

/** One line on stderr that the launcher can parse (the server never prints a stack to the user). */
export function serializeStartupError(err, cfg = {}) {
  return (
    STARTUP_ERROR_PREFIX +
    JSON.stringify({ code: err && err.code, name: err && err.name, syscall: err && err.syscall, path: err && err.path, message: String((err && err.message) || err), stack: err && err.stack, port: cfg.port })
  );
}

export function parseStartupError(text) {
  const line = String(text || '')
    .split(/\r?\n/)
    .find((l) => l.startsWith(STARTUP_ERROR_PREFIX));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(STARTUP_ERROR_PREFIX.length));
  } catch {
    return null;
  }
}

const GENERIC_CAUSES = ['Node.js is not installed, or the version is too old', 'Dependencies or application files are missing — run: npm install', 'Another process is using the required port', 'The configuration is invalid (PORT, PBAI_HOST or PBAI_DATA_DIR)'];

/** Turn an error into a readable explanation: what happened, why, what to do. */
export function diagnose(err, cfg = {}) {
  const e = err || {};
  const code = String(e.code || '');
  const msg = String(e.message || e || '');
  const port = cfg.port || DEFAULT_PORT;
  const other = port < 65535 ? port + 1 : port - 1;
  if (code === 'NODE_TOO_OLD') {
    return { id: 'node', title: `Node.js ${process.versions.node} is too old.`, detail: `Playbook Builder needs Node.js ${MIN_NODE.join('.')} or newer.`, causes: ['Node.js is out of date'], fixes: ['Install the current LTS version from https://nodejs.org', 'Then run the same command again'] };
  }
  if (code === 'INVALID_PORT') {
    return { id: 'config', title: 'The port setting is invalid.', detail: msg, causes: ['Configuration is invalid'], fixes: [`Use a port such as ${DEFAULT_PORT}:  ${commandHint(`--port ${DEFAULT_PORT}`)}`, 'Or remove the PORT environment variable to use the default'] };
  }
  if (code === 'EADDRINUSE') {
    return { id: 'port', title: `Port ${port} is already in use.`, detail: 'Another program is using the port Playbook Builder needs.', causes: ['Another process is using the required port'], fixes: [`Close the program that uses port ${port}, or`, `start on another port:  ${commandHint(`--port ${other}`)}`] };
  }
  if ((code === 'EACCES' || code === 'EPERM') && (e.syscall === 'listen' || e.syscall === 'bind')) {
    return { id: 'port', title: `This computer does not allow port ${port}.`, detail: 'Ports below 1024 usually need administrator rights.', causes: ['The port is restricted'], fixes: [`Use a higher port:  ${commandHint(`--port ${DEFAULT_PORT}`)}`] };
  }
  if (code === 'EADDRNOTAVAIL' || code === 'ENOTFOUND') {
    return { id: 'config', title: `The address "${cfg.host}" is not available on this computer.`, detail: msg, causes: ['PBAI_HOST is set to an address this computer does not have'], fixes: ['Remove PBAI_HOST to use 127.0.0.1 (this computer only)'] };
  }
  if (['EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'EEXIST', 'ENOSPC', 'EISDIR', 'EBUSY'].includes(code)) {
    return {
      id: 'data',
      title: 'Playbook Builder cannot use its data folder.',
      detail: `${cfg.dataDir || 'data'} — ${msg}`,
      causes: code === 'ENOSPC' ? ['The disk is full'] : ['The data folder is read-only, locked, or is not a folder'],
      fixes: ['Make sure the folder is writable and the disk has free space', 'Or choose another folder with the PBAI_DATA_DIR environment variable'],
    };
  }
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || e.name === 'SyntaxError' || /Cannot find (module|package)|Unexpected (token|end)|SyntaxError/.test(msg)) {
    return { id: 'files', title: 'Some application files are missing or damaged.', detail: msg.split('\n')[0], causes: ['Dependencies or application files are missing'], fixes: ['Copy the complete Playbook Builder folder again', 'Then run:  npm install', 'Check the installation with:  npm run build'] };
  }
  if (code === 'NOT_READY') {
    return { id: 'timeout', title: 'Playbook Builder started but did not respond.', detail: msg, causes: ['The computer is very busy, or a firewall blocks local connections'], fixes: ['Try again', `Or open ${cfg.url || `http://localhost:${port}`} yourself in a minute`] };
  }
  return { id: 'unknown', title: 'Something unexpected stopped the server.', detail: msg.split('\n')[0], causes: GENERIC_CAUSES, fixes: ['Try again', 'Check the installation with:  npm run build', 'If it keeps failing, send the details file below to support'] };
}

/** The readable startup-error panel. No stack traces — those go to the details file. */
export function formatPanel(diag, { logPath = null, interactive = false } = {}) {
  const s = symbols();
  const lines = ['', `  ${s.bad} Playbook Builder could not start.`, '', `  ${diag.title}`];
  if (diag.detail) lines.push(`  ${diag.detail}`);
  lines.push('', '  Possible causes:');
  for (const c of diag.causes || GENERIC_CAUSES) lines.push(`    ${s.bullet} ${c}`);
  lines.push('', '  What to do:');
  for (const f of diag.fixes || []) lines.push(`    ${s.bullet} ${f}`);
  lines.push('');
  if (logPath) lines.push(`  Details for support: ${logPath}`);
  lines.push(`  Setup instructions:  README.md → "Launch Playbook Builder"${interactive ? '  (or press S)' : ''}`);
  if (!interactive) lines.push(`  Retry:               ${commandHint()}`);
  lines.push('');
  return lines.join('\n');
}

/** Setup steps shown by "View Setup Instructions" (spec §14). */
export function setupInstructions() {
  const s = symbols();
  return [
    '',
    '  Launch Playbook Builder',
    '',
    '  1. Install Node.js',
    `     Install Node.js ${MIN_NODE.join('.')} or newer (the LTS version) from https://nodejs.org`,
    '  2. Install dependencies',
    '     In the Playbook Builder folder run:  npm install',
    '  3. Start',
    '     npm run dev       start, open the browser, restart when source files change',
    '     npm run launch    start and open the browser',
    '     npm start         start the server only (no browser)',
    '  4. Open the application',
    `     The browser opens by itself. If it does not, open the URL shown in the terminal (default http://localhost:${DEFAULT_PORT}).`,
    '',
    `  ${s.info} Another port:     npm run launch -- --port 4318   (or set PORT)`,
    `  ${s.info} Check the setup:  npm run setup`,
    `  ${s.info} Full guide:       ${README}`,
    '',
  ].join('\n');
}

/** Write the technical details (stack, server output) where support can find them. */
export function writeErrorLog(cfg, { error = null, output = '' } = {}) {
  const e = error || {};
  const text = [
    `Playbook Builder ${APP_VERSION} — startup error`,
    `Time:        ${new Date().toISOString()}`,
    `Platform:    ${platformName()} ${os.release()} (${process.arch})`,
    `Node.js:     ${process.version}`,
    `Port:        ${cfg.port}`,
    `Data folder: ${cfg.dataDir}`,
    '',
    'Error:',
    e.stack || e.message || String(error),
    '',
    output ? `Server output:\n${output}` : '',
  ].join('\n');
  const targets = [path.join(cfg.dataDir || path.join(ROOT, 'data'), 'logs', 'launch-error.log'), path.join(os.tmpdir(), 'playbook-builder-launch-error.log')];
  for (const file of targets) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return file;
    } catch { /* try the next location */ }
  }
  return null;
}
