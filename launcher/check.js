#!/usr/bin/env node
// `npm run build`. Playbook Builder has no compile step — the server and
// the web UI run straight from source — so "build" verifies that this copy is
// complete and runnable on this computer, the same way on every platform.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as L from './lib.js';

const s = L.symbols();
const problems = [];
const line = (ok, text) => process.stdout.write(`  ${ok === true ? s.ok : ok === false ? s.bad : s.warn} ${text}\n`);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

process.stdout.write(`\n  Checking Playbook Builder v${L.APP_VERSION} on ${L.platformName()} (Node.js ${process.versions.node})\n\n`);

if (L.nodeVersionOk()) line(true, `Node.js ${process.versions.node} (needs ${L.MIN_NODE.join('.')}+)`);
else {
  line(false, `Node.js ${process.versions.node} is too old — install ${L.MIN_NODE.join('.')} or newer from https://nodejs.org`);
  problems.push('node');
}

if (/^\d+\.\d+\.\d+$/.test(L.APP_VERSION)) line(true, `Version ${L.APP_VERSION} (from package.json)`);
else {
  line(false, `package.json has an invalid version "${L.APP_VERSION}"`);
  problems.push('version');
}

// Server code: loading the app imports every server module.
const serverFiles = walk(path.join(L.ROOT, 'server'));
try {
  await import('../server/app.js');
  line(true, `Server modules load (${serverFiles.length} files)`);
} catch (err) {
  line(false, `Server modules do not load: ${String(err.message).split('\n')[0]}`);
  problems.push('server');
}

// Browser code and shared code: syntax check with this same Node binary.
const clientFiles = [...walk(path.join(L.ROOT, 'public')), ...walk(path.join(L.ROOT, 'shared')), ...walk(path.join(L.ROOT, 'launcher')), L.SERVER_ENTRY];
const broken = [];
for (const file of clientFiles) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) broken.push(`${path.relative(L.ROOT, file)}: ${String(r.stderr).split('\n').find((l) => /Error/.test(l)) || 'syntax error'}`);
}
if (!broken.length) line(true, `Web UI, shared and launcher files parse (${clientFiles.length} files)`);
else {
  line(false, `${broken.length} file(s) have syntax errors:`);
  for (const b of broken) process.stdout.write(`      ${b}\n`);
  problems.push('syntax');
}

for (const required of ['public/index.html', 'public/styles.css', 'README.md']) {
  if (!fs.existsSync(path.join(L.ROOT, required))) {
    line(false, `Missing file: ${required}`);
    problems.push(required);
  }
}

process.stdout.write('\n');
if (problems.length) {
  process.stdout.write('  This copy is not complete. Copy the Playbook Builder folder again, then run: npm install\n\n');
  process.exit(1);
}
process.stdout.write('  Nothing to compile — Playbook Builder runs directly from source.\n  Start it with:  npm start   (or npm run launch to open the browser too)\n\n');
