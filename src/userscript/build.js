const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const ENTRY = path.join(__dirname, 'src', 'main.js');
const OUTPUT = path.join(__dirname, 'dist', 'patchwork.user.js');
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
// @run-at       document-idle
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

function build() {
  const output = bundle();
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, output);
  return { path: OUTPUT, bytes: Buffer.byteLength(output, 'utf8') };
}

if (require.main === module) {
  const result = build();
  process.stdout.write(`Built ${path.relative(ROOT, result.path)} (${(result.bytes / 1024).toFixed(1)} KB)\n`);
}

module.exports = { ENTRY, OUTPUT, build, bundle, collect, resolveModule };
