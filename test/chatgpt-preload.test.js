const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('ChatGPT preload injects proxy compatibility into the main world', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/chatgpt-preload.js'), 'utf8');
  let executionScript = null;
  vm.runInNewContext(source, {
    require: (name) => {
      assert.equal(name, 'electron');
      return {
        contextBridge: {
          executeInMainWorld: (script) => { executionScript = script; },
        },
      };
    },
  });

  assert.equal(typeof executionScript?.func, 'function');
  const serialized = executionScript.func.toString();
  assert.match(serialized, /cache: 'no-store'/);
  assert.match(serialized, /no-transform, no-cache/);
  assert.match(serialized, /ProxyCompatibleXMLHttpRequest/);
  assert.match(serialized, /hostname !== 'chatgpt.com'/);
});

test('embedded ChatGPT view loads the document-start proxy preload', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/chatgpt-view.js'), 'utf8');
  assert.match(source, /preload: path\.join\(__dirname, '\.\.', 'chatgpt-preload\.js'\)/);
});
