const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const ENTRY = path.join(__dirname, 'src', 'main.js');
const OUTPUT = path.join(__dirname, 'dist', 'patchwork.user.js');
const RUNTIME_OUTPUT = path.join(__dirname, 'dist', 'patchwork.runtime.js');
const REQUIRE_PATTERN = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g;

const { version } = require(path.join(ROOT, 'package.json'));

function moduleId(filePath) {
  return path.relative(ROOT, filePath).replaceAll('\\', '/');
}

function resolveModule(fromFile, specifier) {
  if (!specifier.startsWith('.')) {
    throw new Error(`The userscript bundle only supports relative requires: ${specifier} in ${fromFile}`);
  }
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.css`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Cannot resolve ${specifier} from ${fromFile}`);
}

function collect(entryFile) {
  const modules = new Map();
  const queue = [entryFile];
  while (queue.length > 0) {
    const filePath = queue.shift();
    const id = moduleId(filePath);
    if (modules.has(id)) continue;
    const source = fs.readFileSync(filePath, 'utf8');
    if (filePath.endsWith('.css')) {
      modules.set(id, `module.exports = ${JSON.stringify(source)};`);
      continue;
    }
    const rewritten = source.replace(REQUIRE_PATTERN, (match, quote, specifier) => {
      const resolved = resolveModule(filePath, specifier);
      queue.push(resolved);
      return `__patchworkRequire(${JSON.stringify(moduleId(resolved))})`;
    });
    modules.set(id, rewritten);
  }
  return modules;
}

function header() {
  return `// ==UserScript==
// @name         Patchwork for ChatGPT
// @namespace    https://github.com/patchwork/chatgpt-coder
// @version      ${version}
// @description  Turn chatgpt.com into a coding workspace backed by a local Git agent.
// @author       Patchwork
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @updateURL    __PATCHWORK_ORIGIN__/patchwork.user.js?token=__PATCHWORK_TOKEN__
// @downloadURL  __PATCHWORK_ORIGIN__/patchwork.user.js?token=__PATCHWORK_TOKEN__
// @noframes
// ==/UserScript==
`;
}

function bundle() {
  const modules = collect(ENTRY);
  const entries = [...modules.entries()].map(([id, source]) => (
    `  ${JSON.stringify(id)}: function (module, exports) {\n${source}\n  },`
  )).join('\n');
  return `${header()}
(function () {
  'use strict';
  var __patchworkToken = '__PATCHWORK_TOKEN__';
  var __patchworkOrigin = '__PATCHWORK_ORIGIN__';
  var __patchworkModules = {
${entries}
  };
  var __patchworkCache = {};
  function __patchworkRequire(id) {
    if (__patchworkCache[id]) return __patchworkCache[id].exports;
    var factory = __patchworkModules[id];
    if (!factory) throw new Error('Patchwork bundle is missing module ' + id);
    var module = { exports: {} };
    __patchworkCache[id] = module;
    factory(module, module.exports);
    return module.exports;
  }
  __patchworkRequire(${JSON.stringify(moduleId(ENTRY))}).boot({
    token: __patchworkToken,
    origin: __patchworkOrigin,
    version: ${JSON.stringify(version)},
  });
})();
`;
}


function webSocketBootstrap() {
  return `(function () {
  var EVENT_NAME = 'patchwork-chatgpt-websocket-message';
  var WRAPPED_FLAG = '__patchworkChatgptWebSocketWrapped';
  var NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket !== 'function' || NativeWebSocket[WRAPPED_FLAG]) return;

  function isChatGptSocketUrl(value) {
    try {
      var url = new URL(String(value || ''), location.href);
      return url.protocol === 'wss:'
        && (url.hostname === 'ws.chatgpt.com' || url.hostname.endsWith('.chatgpt.com'));
    } catch (_) {
      return false;
    }
  }

  function PatchworkWebSocket(url, protocols) {
    var socket = arguments.length > 1
      ? new NativeWebSocket(url, protocols)
      : new NativeWebSocket(url);
    if (isChatGptSocketUrl(url)) {
      socket.addEventListener('message', function (event) {
        window.dispatchEvent(new CustomEvent(EVENT_NAME, {
          detail: { url: String(url || ''), data: event.data },
        }));
      });
    }
    return socket;
  }

  Object.setPrototypeOf(PatchworkWebSocket, NativeWebSocket);
  PatchworkWebSocket.prototype = NativeWebSocket.prototype;
  Object.defineProperty(PatchworkWebSocket, WRAPPED_FLAG, { value: true });
  Object.defineProperty(PatchworkWebSocket, '__patchworkNativeWebSocket', { value: NativeWebSocket });
  window.WebSocket = PatchworkWebSocket;
})();`;
}

function loader() {
  return `${header()}
(function () {
  'use strict';
  var token = '__PATCHWORK_TOKEN__';
  var origin = '__PATCHWORK_ORIGIN__';
  var socketBootstrapUrl = URL.createObjectURL(new Blob([${JSON.stringify(webSocketBootstrap())}], { type: 'text/javascript' }));
  var socketBootstrap = document.createElement('script');
  socketBootstrap.src = socketBootstrapUrl;
  socketBootstrap.async = false;
  socketBootstrap.addEventListener('load', function () {
    URL.revokeObjectURL(socketBootstrapUrl);
    socketBootstrap.remove();
  });
  socketBootstrap.addEventListener('error', function () {
    URL.revokeObjectURL(socketBootstrapUrl);
    socketBootstrap.remove();
  });
  var socketRoot = document.documentElement || document.head || document.body;
  if (socketRoot) socketRoot.append(socketBootstrap);
  else {
    document.addEventListener('readystatechange', function installSocketBootstrap() {
      var root = document.documentElement || document.head || document.body;
      if (root) root.append(socketBootstrap);
    }, { once: true });
  }

  function injectRuntime(source) {
    window.__patchworkBootstrap = { origin: origin, token: token, transport: 'gm' };
    var element = document.createElement('script');
    element.src = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    element.addEventListener('load', function () { URL.revokeObjectURL(element.src); });
    element.addEventListener('error', function () {
      URL.revokeObjectURL(element.src);
      console.error('[patchwork] ChatGPT blocked the local Patchwork runtime.');
    });
    document.documentElement.append(element);
  }

  var request = typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function'
    ? GM.xmlHttpRequest.bind(GM)
    : (typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : null);
  if (!request) {
    console.error('[patchwork] The userscript manager did not provide GM_xmlhttpRequest.');
    return;
  }
  request({
    method: 'GET',
    url: origin + '/patchwork.runtime.js?token=' + encodeURIComponent(token),
    headers: { Authorization: 'Bearer ' + token },
    onload: function (response) {
      if (response.status < 200 || response.status >= 300) {
        console.error('[patchwork] The local agent refused the runtime request (' + response.status + ').');
        return;
      }
      var source = response.responseText;
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { injectRuntime(source); }, { once: true });
      } else {
        injectRuntime(source);
      }
    },
    onerror: function () {
      console.error('[patchwork] The local Patchwork agent is not reachable at ' + origin + '.');
    },
  });
})();
`;
}

function build() {
  const output = loader();
  const runtime = bundle();
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, output);
  fs.writeFileSync(RUNTIME_OUTPUT, runtime);
  return {
    path: OUTPUT,
    bytes: Buffer.byteLength(output, 'utf8'),
    runtimePath: RUNTIME_OUTPUT,
    runtimeBytes: Buffer.byteLength(runtime, 'utf8'),
  };
}

if (require.main === module) {
  const result = build();
  process.stdout.write([
    `Built ${path.relative(ROOT, result.path)} (${(result.bytes / 1024).toFixed(1)} KB)`,
    `Built ${path.relative(ROOT, result.runtimePath)} (${(result.runtimeBytes / 1024).toFixed(1)} KB)`,
    '',
  ].join('\n'));
}

module.exports = {
  ENTRY, OUTPUT, RUNTIME_OUTPUT, build, bundle, collect, loader, resolveModule, webSocketBootstrap,
};
