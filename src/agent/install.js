const fs = require('node:fs/promises');
const path = require('node:path');
const { sendBuffer, sendText } = require('./http');

const USERSCRIPT_PATH = path.join(__dirname, '..', 'userscript', 'dist', 'patchwork.user.js');

function agentOrigin(config) {
  return `http://127.0.0.1:${config.port}`;
}

async function readUserscript(config) {
  let source;
  try {
    source = await fs.readFile(USERSCRIPT_PATH, 'utf8');
  } catch {
    // The bundle is build output rather than a checked-in artifact, so the agent
    // builds it on demand the first time someone opens the install page.
    // eslint-disable-next-line global-require
    source = require('../userscript/build').bundle();
  }
  return source
    .replaceAll('__PATCHWORK_TOKEN__', config.token)
    .replaceAll('__PATCHWORK_ORIGIN__', agentOrigin(config))
    .replaceAll('__PATCHWORK_PORT__', String(config.port));
}

function bookmarkletSource(config) {
  const origin = agentOrigin(config);
  const token = config.token;
  // chatgpt.com's Content-Security-Policy decides what is possible here, and it
  // was read from a real session capture rather than guessed:
  //
  //   connect-src   has no loopback entry  -> fetch/WebSocket to the agent is blocked
  //   script-src    has no 'unsafe-eval'   -> eval() of downloaded source is blocked
  //   script-src-elem lists blob:          -> a Blob script element IS allowed
  //
  // Popups are governed by none of those (COOP is same-origin-allow-popups, so the
  // opener link survives) and postMessage is not a CSP-controlled channel. So the
  // bookmarklet opens the agent's bridge window, receives the bundle through
  // postMessage, and injects it as a blob: script.
  return `(async () => {
  const origin = ${JSON.stringify(origin)};
  const token = ${JSON.stringify(token)};
  if (window.__patchworkBooted) { window.__patchworkPanel?.toggle?.(); return; }
  const bridgeUrl = origin + '/bridge?token=' + encodeURIComponent(token) + '&boot=1';
  const bridgeWindow = window.open(bridgeUrl, 'patchwork-bridge', 'width=460,height=340');
  if (!bridgeWindow) {
    alert('Patchwork needs a pop-up window to reach its local agent.\\n\\nAllow pop-ups for chatgpt.com and click the bookmarklet again, or install the userscript instead: ' + origin + '/install');
    return;
  }
  window.__patchworkBootstrap = { origin, token, transport: 'bridge', bridgeWindow };
  try {
    const source = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        reject(new Error('The Patchwork bridge window did not answer. Is the agent still running?'));
      }, 15000);
      const onMessage = (event) => {
        if (event.source !== bridgeWindow || event.data?.channel !== 'patchwork-bridge') return;
        if (event.data.type !== 'boot-source') return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(event.data.source);
      };
      window.addEventListener('message', onMessage);
    });
    const element = document.createElement('script');
    element.src = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    element.addEventListener('load', () => URL.revokeObjectURL(element.src));
    element.addEventListener('error', () => {
      alert('chatgpt.com blocked the Patchwork script (script-src). Install the userscript with Tampermonkey instead: ' + origin + '/install');
    });
    document.documentElement.append(element);
  } catch (error) {
    bridgeWindow.close();
    alert('Patchwork could not start.\\n\\n' + error.message + '\\n\\nThe supported install is the userscript: ' + origin + '/install');
  }
})();`;
}

function installPage(config) {
  const origin = agentOrigin(config);
  // The bootstrap is embedded rather than loaded from the agent: a
  // <script src="http://127.0.0.1:…"> element is exactly what chatgpt.com's
  // script-src-elem refuses. It only has to survive long enough to open the
  // bridge, which then delivers the real bundle.
  const bookmarklet = `javascript:${encodeURIComponent(bookmarkletSource(config))}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Install Patchwork</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 48px 24px; font: 15px/1.6 ui-sans-serif, system-ui, sans-serif;
         background: #101210; color: #e8ece8; }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  p.lede { color: #9aa79a; margin: 0 0 32px; }
  section { border: 1px solid #263026; border-radius: 12px; padding: 20px 24px; margin: 0 0 20px;
            background: #161a16; }
  h2 { font-size: 15px; margin: 0 0 8px; letter-spacing: .04em; text-transform: uppercase; color: #9ad39a; }
  a.button { display: inline-block; margin-top: 12px; padding: 10px 18px; border-radius: 8px;
             background: #2f7d32; color: #fff; text-decoration: none; font-weight: 600; }
  a.bookmarklet { background: #33413a; }
  code { background: #0c0e0c; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  ol { padding-left: 20px; }
  small { color: #78857a; display: block; margin-top: 10px; }
</style>
</head>
<body><main>
<h1>Patchwork v3</h1>
<p class="lede">The agent is running on <code>${origin}</code>. Patchwork's interface lives inside chatgpt.com itself.</p>

<section>
  <h2>Recommended · userscript</h2>
  <ol>
    <li>Install <a href="https://www.tampermonkey.net/">Tampermonkey</a> or Violentmonkey.</li>
    <li>Open the script below and confirm the install.</li>
    <li>Reload <code>chatgpt.com</code>.</li>
  </ol>
  <a class="button" href="/patchwork.user.js">Install patchwork.user.js</a>
  <small>Your agent token is baked into the script, so nothing has to be typed.</small>
</section>

<section>
  <h2>Fallback · bookmarklet</h2>
  <p>No userscript manager? Drag this to your bookmarks bar and click it while on chatgpt.com.</p>
  <a class="button bookmarklet" href="${bookmarklet}">Patchwork</a>
  <small>Opens a small bridge window and keeps it open: chatgpt.com's Content-Security-Policy forbids the page from reaching 127.0.0.1 directly, so that window carries every request. Allow pop-ups for chatgpt.com. The userscript path is the supported one.</small>
</section>

<section>
  <h2>Keep the agent running</h2>
  <p><code>pnpm agent</code> starts it; Patchwork needs it for every Git and filesystem operation.</p>
</section>
</main></body>
</html>`;
}

function bridgePage(config) {
  const origin = agentOrigin(config);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Patchwork bridge</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; display: grid; place-items: center; height: 100vh; background: #101210;
         color: #9aa79a; font: 14px/1.6 ui-sans-serif, system-ui, sans-serif; text-align: center; }
  strong { color: #e8ece8; display: block; font-size: 16px; margin-bottom: 6px; }
</style>
</head>
<body>
<div><strong>Patchwork bridge</strong>Keep this window open while Patchwork is in use.</div>
<script>
(() => {
  const AGENT = ${JSON.stringify(origin)};
  const ALLOWED = new Set(['https://chatgpt.com', 'https://chat.openai.com']);
  const params = new URLSearchParams(location.search);
  const token = params.get('token') || '';

  // Exactly one bridge, ever. A window name only dedupes within one browsing
  // context group, so opening the bookmarklet from a second tab used to leave a
  // second window behind. The newest instance claims the role over a
  // BroadcastChannel and every older one closes itself.
  const instanceId = crypto.randomUUID();
  let channel = null;
  try {
    channel = new BroadcastChannel('patchwork-bridge');
    channel.addEventListener('message', (event) => {
      if (event.data?.type === 'claim' && event.data.id !== instanceId) window.close();
    });
    channel.postMessage({ type: 'claim', id: instanceId });
  } catch {
    // Without BroadcastChannel the orphan check below is the only cleanup.
  }

  // An orphaned bridge helps nobody: if the tab that opened it is gone, so is
  // its reason to exist.
  setInterval(() => {
    let orphaned = false;
    try {
      orphaned = !window.opener || window.opener.closed;
    } catch {
      orphaned = false;
    }
    if (orphaned) {
      channel?.close();
      window.close();
    }
  }, 4000);

  window.addEventListener('pagehide', () => channel?.close());

  // The opener cannot reach the agent when the page CSP blocks connect-src, so
  // this same-origin page performs the request and relays the answer back.
  async function perform(request) {
    const response = await fetch(AGENT + request.path, {
      method: request.method || 'GET',
      headers: { Authorization: 'Bearer ' + token, ...(request.headers || {}) },
      body: request.body ?? null,
    });
    const contentType = response.headers.get('content-type') || '';
    if (request.responseType === 'arraybuffer' || /octet-stream|zip/.test(contentType)) {
      return { status: response.status, buffer: await response.arrayBuffer() };
    }
    return { status: response.status, text: await response.text() };
  }

  window.addEventListener('message', async (event) => {
    if (!ALLOWED.has(event.origin)) return;
    const message = event.data;
    if (!message || message.channel !== 'patchwork-bridge' || message.type !== 'request') return;
    const reply = (payload, transfer = []) => event.source.postMessage(
      { channel: 'patchwork-bridge', type: 'response', id: message.id, ...payload },
      event.origin,
      transfer,
    );
    try {
      const result = await perform(message.request);
      reply(result, result.buffer ? [result.buffer] : []);
    } catch (error) {
      reply({ error: String(error && error.message || error) });
    }
  });

  if (params.get('boot') === '1' && window.opener) {
    fetch(AGENT + '/patchwork.user.js?token=' + encodeURIComponent(token))
      .then((response) => response.text())
      .then((source) => {
        for (const target of ALLOWED) {
          window.opener.postMessage({ channel: 'patchwork-bridge', type: 'boot-source', source }, target);
        }
      })
      .catch(() => {});
  }

  for (const target of ALLOWED) {
    window.opener?.postMessage({ channel: 'patchwork-bridge', type: 'ready' }, target);
  }
})();
</script>
</body>
</html>`;
}

function register(router, context) {
  const { config } = context;

  router.get('/', async ({ response }) => {
    response.writeHead(302, { Location: '/install' });
    response.end();
    return null;
  }, { public: true });

  router.get('/install', async ({ response }) => {
    sendText(response, 200, installPage(config), 'text/html; charset=utf-8');
    return null;
  }, { public: true });

  router.get('/bridge', async ({ response }) => {
    sendText(response, 200, bridgePage(config), 'text/html; charset=utf-8');
    return null;
  }, { public: true });

  router.get('/bookmarklet.js', async ({ response }) => {
    sendText(response, 200, bookmarkletSource(config), 'text/javascript; charset=utf-8');
    return null;
  }, { public: true });

  // Served without CORS headers on purpose: a userscript manager installs it by
  // navigation, and no other origin should be able to read the token inside it.
  router.get('/patchwork.user.js', async ({ response }) => {
    const source = await readUserscript(config);
    sendBuffer(response, 200, Buffer.from(source, 'utf8'), 'text/javascript; charset=utf-8');
    return null;
  }, { public: true });
}

module.exports = {
  USERSCRIPT_PATH,
  agentOrigin,
  bookmarkletSource,
  bridgePage,
  installPage,
  readUserscript,
  register,
};
