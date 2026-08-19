const { Api } = require('./api');
const { App } = require('./app');
const { createTransport } = require('./transport');

const BOOT_FLAG = '__patchworkBooted';

function resolveSettings(settings) {
  const bootstrap = window.__patchworkBootstrap || {};
  const origin = bootstrap.origin
    || (settings.origin && !settings.origin.startsWith('__') ? settings.origin : 'http://127.0.0.1:8787');
  const token = bootstrap.token
    || (settings.token && !settings.token.startsWith('__') ? settings.token : '');
  return {
    ...settings,
    origin,
    token,
    // Set by the bookmarklet. The first tab owns the bridge window; later tabs
    // receive this bundle and their agent transport through that owner.
    prefer: ['bridge', 'tab-relay'].includes(bootstrap.transport) ? bootstrap.transport : null,
    bridgeWindow: bootstrap.bridgeWindow || null,
    relayRequest: bootstrap.relayRequest || null,
  };
}

async function boot(settings = {}) {
  if (window[BOOT_FLAG]) {
    window.__patchworkPanel?.toggle?.();
    return window.__patchworkPanel;
  }
  window[BOOT_FLAG] = true;

  const resolved = resolveSettings(settings);
  if (!resolved.token) {
    // Without a token nothing can be reached; say so once instead of failing on
    // every request.
    console.error('[patchwork] No agent token was injected. Reinstall the userscript from the agent install page.');
    return null;
  }

  const { transport, failures } = await createTransport(resolved);
  const api = new Api(transport);
  const app = new App({ api, transport, version: resolved.version });

  window.__patchworkPanel = {
    toggle: () => app.shell.toggle(),
    open: () => app.shell.open(),
    close: () => app.shell.close(),
    app,
  };

  window.addEventListener('keydown', (event) => {
    if (!event.altKey || event.metaKey || event.ctrlKey) return;
    if (String(event.key).toLowerCase() !== 'p') return;
    event.preventDefault();
    app.shell.toggle();
  });

  await app.start();
  if (failures?.length) {
    app.store.addActivity(`Transport fallback in use (${transport.kind}). Tried: ${failures.join('; ')}`);
  }
  return window.__patchworkPanel;
}

module.exports = { BOOT_FLAG, boot, resolveSettings };
