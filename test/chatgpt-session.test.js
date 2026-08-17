const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');

const { scheduleTransportRecovery } = require('../src/main/chatgpt-view');

const root = path.join(__dirname, '..');

test('ChatGPT session navigation is restricted to ChatGPT and OpenAI auth hosts', async () => {
  const viewSource = await fs.readFile(path.join(root, 'src/main/chatgpt-view.js'), 'utf8');
  assert.match(viewSource, /const CHATGPT_ALLOWED_HOSTS = new Set\(\[/);
  assert.match(viewSource, /'chatgpt\.com'/);
  assert.match(viewSource, /'auth\.openai\.com'/);
  assert.match(viewSource, /url\.protocol !== 'https:'/);
  assert.match(viewSource, /hostname\.endsWith\('\.chatgpt\.com'\)/);
});

test('ChatGPT transports are window-hosted and the renderer only gets explicit session controls', async () => {
  const viewSource = await fs.readFile(path.join(root, 'src/main/chatgpt-view.js'), 'utf8');
  const preload = await fs.readFile(path.join(root, 'src/preload.js'), 'utf8');
  const app = await fs.readFile(path.join(root, 'src/main/app.js'), 'utf8');

  assert.match(viewSource, /this\.view = new BrowserWindow\(transportWindowOptions/);
  assert.match(viewSource, /this\.chatView = new BrowserWindow\(transportWindowOptions/);
  assert.doesNotMatch(viewSource, /contentView\.addChildView/);
  assert.match(app, /ipcMain\.handle\('session:open'/);
  assert.match(app, /ipcMain\.handle\('session:status'/);
  assert.match(preload, /openSession:[\s\S]*getSessionStatus:/);
  assert.match(app, /renderer-dist.*index\.html/);
});

test('a crashed ChatGPT transport reloads once and can recover again after loading', async () => {
  const contents = new EventEmitter();
  contents.id = 42;
  contents.isDestroyed = () => false;
  let reloads = 0;
  contents.reload = () => { reloads += 1; };
  const transportWindow = { webContents: contents, isDestroyed: () => false };
  const attempts = new Set();

  assert.equal(scheduleTransportRecovery(transportWindow, { reason: 'crashed' }, attempts, assert.fail, 0), true);
  assert.equal(scheduleTransportRecovery(transportWindow, { reason: 'crashed' }, attempts, assert.fail, 0), false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reloads, 1);

  contents.emit('did-finish-load');
  assert.equal(scheduleTransportRecovery(transportWindow, { reason: 'oom' }, attempts, assert.fail, 0), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reloads, 2);
  assert.equal(scheduleTransportRecovery(transportWindow, { reason: 'clean-exit' }, new Set(), assert.fail, 0), false);
});

test('native Chat accepts structured sends with positional compatibility', async () => {
  const viewSource = await fs.readFile(path.join(root, 'src/main/chatgpt-view.js'), 'utf8');
  assert.match(viewSource, /function normalizeChatSendRequest\(conversationIdOrRequest, message, model, reasoningMode\)/);
  assert.match(viewSource, /conversationId: request\.conversationId/);
  assert.match(viewSource, /message: request\.message \?\? request\.text/);
  assert.match(viewSource, /reasoningMode: request\.reasoningMode \|\| request\.reasoning \|\| 'default'/);
  assert.match(viewSource, /attachments: Array\.isArray\(request\.attachments\)/);
  assert.match(viewSource, /sendChatMessage\(conversationIdOrRequest, message, model = 'default', reasoningMode = 'default'\)/);
});

test('titlebar and native Chat attachment changes remain main-process scoped', async () => {
  const app = await fs.readFile(path.join(root, 'src/main/app.js'), 'utf8');
  const viewSource = await fs.readFile(path.join(root, 'src/main/chatgpt-view.js'), 'utf8');
  const preload = await fs.readFile(path.join(root, 'src/preload.js'), 'utf8');
  const renderer = await fs.readFile(path.join(root, 'src/renderer/app.tsx'), 'utf8');

  assert.match(app, /minWidth: 800/);
  assert.match(app, /minHeight: 600/);
  assert.match(app, /titleBarStyle: 'hiddenInset'/);
  assert.match(app, /titleBarOverlay:/);
  assert.match(app, /ipcMain\.handle\('appearance:set-theme'/);
  assert.match(preload, /setAppearanceTheme:/);
  assert.match(renderer, /bridge\.setAppearanceTheme\?\.\(theme\)/);
  assert.match(app, /validateChatAttachments/);
  assert.match(viewSource, /uploadAttachments\(attachments = \[\], webContents = null\)/);
  assert.match(viewSource, /uploadAttachments\(attachments, this\.chatView\.webContents\)/);
  assert.match(preload, /sendChatMessage: \(conversationIdOrRequest, message, model, reasoningMode\)/);
});
