// Three ways for chatgpt.com to reach the local agent, probed in order.
//
//   1. GM_xmlhttpRequest - runs in the userscript manager, so neither the page CSP
//                          nor CORS applies. This is the supported path.
//   2. fetch             - needs connect-src to allow http://127.0.0.1. A capture of
//                          a real chatgpt.com session shows it does not, so this is
//                          expected to fail there; it is still probed because it is
//                          free and would light up if that ever changes.
//   3. popup bridge      - window.open + postMessage. Navigation is not covered by
//                          connect-src, postMessage is not covered by CSP at all, and
//                          chatgpt.com sends COOP: same-origin-allow-popups, so the
//                          opener link survives. This is what the bookmarklet uses.

const BRIDGE_CHANNEL = 'patchwork-bridge';
const DEFAULT_TIMEOUT = 45_000;

function gmRequest() {
  if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest;
  if (typeof GM !== 'undefined' && typeof GM?.xmlHttpRequest === 'function') return GM.xmlHttpRequest.bind(GM);
  return null;
}

function normalizeBody(body) {
  if (body == null) return null;
  if (typeof body === 'string') return body;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body;
  return JSON.stringify(body);
}

function contentTypeFor(body, headers) {
  if (headers && Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) return null;
  if (body == null) return null;
  if (typeof body === 'string') return 'application/json';
  return 'application/octet-stream';
}

function createGmTransport({ origin, token }) {
  const send = gmRequest();
  return {
    kind: 'userscript',
    request(options) {
      const body = normalizeBody(options.body);
      const headers = {
        Authorization: `Bearer ${token}`,
        ...(contentTypeFor(body, options.headers) ? { 'Content-Type': contentTypeFor(body, options.headers) } : {}),
        ...options.headers,
      };
      return new Promise((resolve, reject) => {
        send({
          method: options.method || 'GET',
          url: origin + options.path,
          headers,
          data: body,
          responseType: options.responseType === 'arraybuffer' ? 'arraybuffer' : undefined,
          timeout: options.timeout || DEFAULT_TIMEOUT,
          binary: body instanceof ArrayBuffer || ArrayBuffer.isView(body),
          onload: (response) => resolve({
            status: response.status,
            text: options.responseType === 'arraybuffer' ? null : response.responseText,
            buffer: options.responseType === 'arraybuffer' ? response.response : null,
          }),
          onerror: () => reject(new Error('The Patchwork agent is not reachable. Is `pnpm agent` running?')),
          ontimeout: () => reject(new Error('The Patchwork agent did not respond in time.')),
        });
      });
    },
  };
}

function createFetchTransport({ origin, token }) {
  return {
    kind: 'fetch',
    async request(options) {
      const body = normalizeBody(options.body);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeout || DEFAULT_TIMEOUT);
      try {
        const response = await fetch(origin + options.path, {
          method: options.method || 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            ...(contentTypeFor(body, options.headers) ? { 'Content-Type': contentTypeFor(body, options.headers) } : {}),
            ...options.headers,
          },
          body,
          signal: controller.signal,
          credentials: 'omit',
          cache: 'no-store',
        });
        return options.responseType === 'arraybuffer'
          ? { status: response.status, text: null, buffer: await response.arrayBuffer() }
          : { status: response.status, text: await response.text(), buffer: null };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function createBridgeTransport({ origin, token, bridgeWindow = null }) {
  let popup = bridgeWindow && !bridgeWindow.closed ? bridgeWindow : null;
  let ready = popup ? Promise.resolve(true) : null;
  let nextId = 0;
  const pending = new Map();

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.channel !== BRIDGE_CHANNEL) return;
    if (message.type === 'ready') return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error));
    else waiter.resolve({ status: message.status, text: message.text ?? null, buffer: message.buffer ?? null });
  });

  // The bridge exists to serve this page; when this page goes away it should not
  // outlive it as a stray window.
  window.addEventListener('pagehide', () => {
    try {
      if (popup && !popup.closed) popup.close();
    } catch {
      // A cross-origin popup that already navigated away cannot be closed here.
    }
  });

  function open() {
    if (popup && !popup.closed) return ready;
    popup = window.open(
      `${origin}/bridge?token=${encodeURIComponent(token)}`,
      'patchwork-bridge',
      'width=460,height=340',
    );
    if (!popup) return Promise.reject(new Error('The browser blocked the Patchwork bridge window. Allow pop-ups for chatgpt.com.'));
    ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The Patchwork bridge window did not respond.')), 15_000);
      const onMessage = (event) => {
        if (event.data?.channel !== BRIDGE_CHANNEL || event.data.type !== 'ready') return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(true);
      };
      window.addEventListener('message', onMessage);
    });
    return ready;
  }

  return {
    kind: 'bridge',
    async request(options) {
      await open();
      const id = `patchwork-${nextId += 1}`;
      const body = normalizeBody(options.body);
      const request = {
        path: options.path,
        method: options.method || 'GET',
        headers: {
          ...(contentTypeFor(body, options.headers) ? { 'Content-Type': contentTypeFor(body, options.headers) } : {}),
          ...options.headers,
        },
        body: typeof body === 'string' ? body : null,
        responseType: options.responseType || 'text',
      };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('The Patchwork bridge did not answer in time.'));
        }, options.timeout || DEFAULT_TIMEOUT);
        const settle = (handler) => (value) => { clearTimeout(timer); handler(value); };
        pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
        popup.postMessage({ channel: BRIDGE_CHANNEL, type: 'request', id, request }, origin);
      });
    },
  };
}

async function probe(transport) {
  const response = await transport.request({ path: '/health', timeout: 4_000 });
  const payload = JSON.parse(response.text || '{}');
  if (!payload.ok) throw new Error('The Patchwork agent answered unexpectedly.');
  return payload;
}

// A blocked loopback request and a stopped agent both surface as a generic network
// error, so the page's own CSP report tells the two apart.
function watchPolicyViolations(origin) {
  const violations = [];
  const listener = (event) => {
    if (String(event.blockedURI || '').startsWith(origin)) violations.push(event.effectiveDirective || event.violatedDirective);
  };
  document.addEventListener('securitypolicyviolation', listener);
  return {
    blockedDirective: () => violations[violations.length - 1] || null,
    dispose: () => document.removeEventListener('securitypolicyviolation', listener),
  };
}

async function createTransport({
  origin, token, prefer = null, bridgeWindow = null,
}) {
  const bridge = () => createBridgeTransport({ origin, token, bridgeWindow });
  // The bookmarklet already opened a bridge to deliver this bundle, so there is
  // nothing to discover.
  if (prefer === 'bridge') return { transport: bridge(), health: null, failures: [] };

  const candidates = [];
  if (gmRequest()) candidates.push(createGmTransport({ origin, token }));
  candidates.push(createFetchTransport({ origin, token }));

  const watcher = watchPolicyViolations(origin);
  const failures = [];
  try {
    for (const transport of candidates) {
      try {
        const health = await probe(transport);
        return { transport, health, failures };
      } catch (error) {
        const directive = transport.kind === 'fetch' ? watcher.blockedDirective() : null;
        failures.push(directive
          ? `${transport.kind}: blocked by the page's ${directive} policy`
          : `${transport.kind}: ${error.message}`);
      }
    }
  } finally {
    watcher.dispose();
  }
  // The bridge is never probed silently, because probing it opens a window.
  return { transport: bridge(), health: null, failures };
}

module.exports = {
  BRIDGE_CHANNEL,
  createBridgeTransport,
  createFetchTransport,
  createGmTransport,
  createTransport,
  probe,
};
