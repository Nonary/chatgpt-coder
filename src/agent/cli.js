#!/usr/bin/env node
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadConfig } = require('./config');
const { startServer } = require('./server');
const { version } = require('./routes');

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--port') options.port = Number.parseInt(argv[index += 1], 10);
    else if (argument === '--home') options.dataRoot = argv[index += 1];
    else if (argument === '--iac-settings') options.iacSettingsPath = argv[index += 1];
    else if (argument === '--help' || argument === '-h') options.help = true;
  }
  return options;
}

const HELP = `patchwork-agent ${version}

  pnpm agent [--port 8787] [--home <directory>] [--iac-settings <file>]

The agent serves Patchwork's local Git, packaging, and filesystem API to the
Patchwork userscript running inside chatgpt.com. Open its install page to add the
userscript to your browser.
`;

function buildRestartArguments(argv, config) {
  const cleaned = [argv[0]];
  for (let index = 1; index < argv.length; index += 1) {
    if (['--port', '--home', '--iac-settings'].includes(argv[index])) {
      index += 1;
      continue;
    }
    cleaned.push(argv[index]);
  }
  return [
    ...cleaned,
    '--port', String(config.port),
    '--home', config.dataRoot,
    '--iac-settings', config.iacSettingsPath,
  ];
}

function relaunch(config) {
  const child = spawn(process.execPath, buildRestartArguments(process.argv.slice(1), config), {
    cwd: path.resolve(__dirname, '..', '..'),
    env: process.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const config = await loadConfig(options);
  const { context, server } = await startServer(config);
  const origin = `http://127.0.0.1:${config.port}`;
  process.stdout.write([
    `patchwork-agent ${version}`,
    `  listening   ${origin}`,
    `  data        ${config.dataRoot}`,
    `  install     ${origin}/install`,
    '',
    'Keep this running while you use Patchwork inside chatgpt.com.',
    '',
  ].join('\n'));

  let shuttingDown = false;
  let finished = false;
  const shutdown = (restart = false) => {
    if (shuttingDown) return;
    shuttingDown = true;
    context.events.close();
    const finish = () => {
      if (finished) return;
      finished = true;
      if (restart) relaunch(config);
      process.exit(0);
    };
    server.close(finish);
    setTimeout(() => {
      server.closeAllConnections?.();
      finish();
    }, 2_000).unref();
  };
  context.requestRestart = () => shutdown(true);
  process.on('SIGINT', () => shutdown(false));
  process.on('SIGTERM', () => shutdown(false));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`patchwork-agent failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildRestartArguments, main, parseArguments, relaunch };
