#!/usr/bin/env node
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

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const config = await loadConfig(options);
  const { server } = await startServer(config);
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

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`patchwork-agent failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArguments };
