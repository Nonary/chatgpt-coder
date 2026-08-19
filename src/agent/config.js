const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_PORT = 8787;
const ALLOWED_ORIGINS = new Set([
  'https://chatgpt.com',
  'https://chat.openai.com',
]);

function defaultDataRoot() {
  if (process.env.PATCHWORK_HOME) return path.resolve(process.env.PATCHWORK_HOME);
  return path.join(os.homedir(), '.patchwork');
}

function defaultPort() {
  const raw = Number.parseInt(process.env.PATCHWORK_PORT || '', 10);
  return Number.isInteger(raw) && raw > 0 && raw < 65_536 ? raw : DEFAULT_PORT;
}

function isAllowedOrigin(value) {
  if (!value || value === 'null') return false;
  if (ALLOWED_ORIGINS.has(value)) return true;
  try {
    const url = new URL(value);
    // The bridge page and the install page are served by the agent itself.
    return (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.protocol === 'http:';
  } catch {
    return false;
  }
}

async function loadConfig(overrides = {}) {
  const dataRoot = overrides.dataRoot || defaultDataRoot();
  await fs.mkdir(dataRoot, { recursive: true });
  const configPath = path.join(dataRoot, 'agent.json');

  let stored = {};
  try {
    stored = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch {
    // A missing or unreadable file simply means this is a first run.
  }

  const token = overrides.token || stored.token || crypto.randomBytes(24).toString('base64url');
  // Port 0 is meaningful - it asks the OS for an ephemeral port - so it cannot
  // be collapsed into the default with `||`.
  const port = Number.isInteger(overrides.port) ? overrides.port : defaultPort();
  if (stored.token !== token) {
    await fs.writeFile(configPath, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600 });
  }

  return {
    dataRoot,
    configPath,
    token,
    port,
    host: overrides.host || '127.0.0.1',
    iacSettingsPath: overrides.iacSettingsPath
      || process.env.PATCHWORK_IAC_SETTINGS
      || path.join(dataRoot, 'settings.json'),
  };
}

module.exports = {
  ALLOWED_ORIGINS,
  DEFAULT_PORT,
  defaultDataRoot,
  isAllowedOrigin,
  loadConfig,
};
