const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('the userscript monitors generation without recurring ChatGPT API polling', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'userscript', 'src', 'driver.js'), 'utf8');

  assert.doesNotMatch(source, /setInterval\s*\(/);
  assert.doesNotMatch(source, /streamStatus\s*\(/);
  assert.doesNotMatch(source, /CONVERSATION_SWEEP_MILLISECONDS/);
  assert.match(source, /responseComplete/);
  assert.match(source, /observeConversation/);
  assert.match(source, /knownStatus: 'completed'/);
  assert.match(source, /taskChatStatus/);
  assert.match(source, /Recovery is a single reconciliation read/);

  const apiSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'userscript', 'src', 'chatgpt', 'api.js'),
    'utf8',
  );
  assert.doesNotMatch(apiSource, /stream_status/);
  assert.match(apiSource, /interpreter\/download/);
  assert.match(apiSource, /sandbox_path/);
});

test('the model picker reacts to real DOM changes without a periodic remount guard', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'userscript', 'src', 'chatgpt', 'model-picker.js'),
    'utf8',
  );

  assert.doesNotMatch(source, /setInterval\s*\(/);
  assert.doesNotMatch(source, /GUARD_INTERVAL_MILLISECONDS/);
  assert.match(source, /new MutationObserver/);
});

test('conversation recovery recognizes terminal records without polling stream status', () => {
  const { conversationCompletionStatus } = require('../src/userscript/src/chatgpt/api');
  const record = {
    current_node: 'answer',
    mapping: { answer: { message: { status: 'finished_successfully', end_turn: true } } },
  };

  assert.equal(conversationCompletionStatus(record), 'completed');
  assert.equal(conversationCompletionStatus({ current_node: 'answer', mapping: {
    answer: { message: { status: 'in_progress' } },
  } }), null);
});

test('the cloned send stream signals generation completion', async () => {
  const { waitForResponseCompletion } = require('../src/userscript/src/chatgpt/intercept');
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: first\n\n'));
      controller.close();
    },
  }));

  assert.equal(await waitForResponseCompletion(response), true);
  assert.equal(await response.text(), 'data: first\n\n', 'the page response remains readable');
});
