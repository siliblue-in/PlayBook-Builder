#!/usr/bin/env node
// Playbook Builder for AI — the server.
//
//   npm start                    start the server (no browser)            — any platform
//   npm run launch / npm run dev start it through the universal launcher,
//                                which opens the browser when it is ready
//   node server.js --port 4318   choose a port (or set PORT); --open opens the browser
//
// Environment: PORT, PBAI_HOST (default 127.0.0.1), PBAI_DATA_DIR (default ./data)
// Startup problems are explained in plain words; technical details go to a log file.

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 18 || (major === 18 && minor < 17)) {
  console.error(`\n  Playbook Builder could not start.\n\n  Node.js ${process.versions.node} is too old — version 18.17 or newer is needed.\n  Install the current LTS version from https://nodejs.org, then run the same command again.\n`);
  process.exit(1);
}

let L;
try {
  L = await import('./launcher/lib.js');
} catch (err) {
  console.error(`\n  Playbook Builder could not start.\n\n  Some application files are missing or damaged (launcher/lib.js: ${err.code || err.message}).\n  Copy the complete Playbook Builder folder again, then run: npm install\n`);
  process.exit(1);
}

const args = L.parseArgs(process.argv.slice(2));
const underLauncher = process.env.PBAI_LAUNCHER === '1';

/** Stop with a readable explanation — or, under the launcher, one line it can explain. */
function fatal(err, cfg) {
  if (underLauncher) {
    process.stderr.write(`${L.serializeStartupError(err, cfg)}\n`);
  } else {
    const logPath = L.writeErrorLog(cfg, { error: err });
    process.stderr.write(L.formatPanel(L.diagnose(err, cfg), { logPath }));
  }
  process.exit(1);
}

let cfg;
try {
  cfg = L.resolveConfig({ args });
} catch (err) {
  fatal(err, err.cfg || { port: L.DEFAULT_PORT });
}

let app;
try {
  const { createApp } = await import('./server/app.js');
  app = createApp({ dataDir: cfg.dataDir, host: cfg.host });
} catch (err) {
  fatal(err, cfg);
}
try {
  await app.init();
} catch (err) {
  // The examples are a convenience; the app still works without them.
  console.error(`  Note: the built-in examples could not be prepared (${err.message}).`);
}

app.server.on('error', async (err) => {
  if (err.code === 'EADDRINUSE' && !underLauncher) {
    const running = await L.probeHealth(cfg.port, cfg.probeHost);
    if (running) {
      console.log(`\n  Playbook Builder${running.version ? ` v${running.version}` : ''} is already running at ${cfg.url}\n`);
      if (args.open) await L.openBrowser(cfg.url);
      process.exit(0);
    }
  }
  fatal(err, cfg);
});

app.server.listen(cfg.port, cfg.host, () => {
  app.scheduler.start();
  console.log('');
  console.log(`  Playbook Builder for AI  v${L.APP_VERSION}`);
  console.log(`  Running at   ${cfg.url}`);
  console.log(`  Data folder  ${cfg.dataDir}`);
  console.log(`  Platform     ${L.platformName()} · Node.js ${process.versions.node}`);
  console.log('  Press Ctrl+C to stop.');
  console.log('');
  if (args.open) L.openBrowser(cfg.url);
});

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  app.scheduler.stop();
  app.server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
