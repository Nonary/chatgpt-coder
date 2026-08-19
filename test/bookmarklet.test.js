const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('ChatGPT proxy bookmarklet is generated as a single JavaScript URL', async () => {
  const bookmarklet = await fs.readFile(
    path.join(__dirname, '../scripts/chatgpt-proxy-bookmarklet.txt'),
    'utf8',
  );
  assert.match(bookmarklet, /^javascript:\(\(\)=>\{/);
  assert.match(bookmarklet, /Cache-Control/);
  assert.match(bookmarklet, /backend-api/);
  assert.doesNotMatch(bookmarklet.trim(), /[\r\n]/);
  assert.doesNotThrow(() => new vm.Script(bookmarklet.trim().slice('javascript:'.length)));
});


test('Tampermonkey proxy script runs at document-start in the page context', async () => {
  const userscript = await fs.readFile(
    path.join(__dirname, '../scripts/chatgpt-proxy-compatibility.user.js'),
    'utf8',
  );
  assert.match(userscript, /@match\s+https:\/\/chatgpt\.com\/\*/);
  assert.match(userscript, /@run-at\s+document-start/);
  assert.match(userscript, /@inject-into\s+page/);
  assert.match(userscript, /Cache-Control/);
  assert.match(userscript, /backend-api/);
  const body = userscript.replace(/^\/\/ ==UserScript==[\s\S]*?^\/\/ ==\/UserScript==\s*/m, '');
  assert.doesNotThrow(() => new vm.Script(body));
});
