#!/usr/bin/env node
// `npm run setup`: check that this computer is ready to run Playbook
// Builder and prepare the data folder. Same checks on Windows, macOS and Linux.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import * as L from './lib.js';

const s = L.symbols();
const args = L.parseArgs(process.argv.slice(2));
let blocking = 0;
const line = (state, text, hint) => {
  const mark = state === 'ok' ? s.ok : state === 'bad' ? s.bad : state === 'warn' ? s.warn : s.info;
  process.stdout.write(`  ${mark} ${text}\n`);
  if (hint) process.stdout.write(`      ${hint}\n`);
  if (state === 'bad') blocking++;
};

function ollamaModels(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 11434, path: '/api/tags', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(Array.isArray(j.models) ? j.models.length : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

process.stdout.write(`\n  Playbook Builder v${L.APP_VERSION} — setup check\n  ${L.platformName()} ${os.release()} (${os.arch()})\n\n`);

// 1. Node.js
if (L.nodeVersionOk()) line('ok', `Node.js ${process.versions.node}`);
else line('bad', `Node.js ${process.versions.node} is too old`, `Install ${L.MIN_NODE.join('.')} or newer (LTS) from https://nodejs.org`);

// 2. npm (present when this runs through npm)
const agent = process.env.npm_config_user_agent || '';
const npmVersion = (agent.match(/npm\/([\d.]+)/) || [])[1];
line(npmVersion ? 'ok' : 'info', npmVersion ? `npm ${npmVersion}` : 'npm not detected (fine when you run node directly)');

// 3. Dependencies
line('ok', 'Dependencies: none to download — Playbook Builder uses Node.js built-ins only');

// 4. Application files
try {
  await import('../server/app.js');
  line('ok', 'Application files are complete');
} catch (err) {
  line('bad', 'Application files are missing or damaged', `${String(err.message).split('\n')[0]} — copy the folder again`);
}

// 5. Data folder
let cfg;
try {
  cfg = L.resolveConfig({ args });
} catch (err) {
  cfg = err.cfg;
  line('bad', err.message, 'Remove the PORT setting or pass a valid one, e.g. --port 4317');
}
try {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  // A fixed name, overwritten each time, so nothing accumulates.
  fs.writeFileSync(path.join(cfg.dataDir, '.setup-check'), `${new Date().toISOString()} ${L.platformName()} node ${process.versions.node}\n`);
  line('ok', `Data folder is writable: ${cfg.dataDir}`);
} catch (err) {
  line('bad', `Data folder is not writable: ${cfg.dataDir}`, `${err.code || err.message} — choose another folder with PBAI_DATA_DIR`);
}

// 6. Port
const running = await L.probeHealth(cfg.port, cfg.probeHost);
if (running) line('ok', `Playbook Builder is already running at ${cfg.url}`);
else {
  const port = await L.checkPort(cfg.port, cfg.host);
  if (port.free) line('ok', `Port ${cfg.port} is free`);
  else line('warn', `Port ${cfg.port} is used by another program`, `Start on another port:  npm run launch -- --port ${cfg.port + 1}`);
}

// 7. Local AI (optional)
const models = await ollamaModels();
if (models === null) line('info', 'Ollama not detected at http://localhost:11434 (optional — for Local AI)');
else line('ok', `Ollama detected at http://localhost:11434 with ${models} model${models === 1 ? '' : 's'}`);

process.stdout.write('\n');
if (blocking) {
  process.stdout.write(`  ${blocking} problem${blocking === 1 ? '' : 's'} to fix before starting. See README.md → "Launch Playbook Builder".\n\n`);
  process.exit(1);
}
process.stdout.write('  Ready. Start Playbook Builder with:  npm run launch   (or npm run dev)\n\n');
