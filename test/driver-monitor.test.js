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
  assert.match(source, /async refreshTask\(task\)/);
  assert.doesNotMatch(source, /this\.api\.taskAttachment/);
  assert.match(source, /Supporting files are already bundled under attachments\//);

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

test('prepared tasks can adopt and reconcile a manually submitted conversation', async () => {
  const chatgpt = require('../src/userscript/src/chatgpt/api');
  const { Driver } = require('../src/userscript/src/driver');
  const previous = {
    conversation: chatgpt.conversation,
    conversationCompletionStatus: chatgpt.conversationCompletionStatus,
    conversationHasAttachment: chatgpt.conversationHasAttachment,
    document: global.document,
    location: global.location,
  };
  const taskId = '3f2b7f68-6d1a-4a7e-9d5e-0d3a5f7b1c22';
  const conversationId = '4a3c8e79-7e2b-4b8f-8e6f-1e4b6a8c2d33';
  const submitted = {
    taskId,
    state: 'submitted',
    answerOnly: true,
    packagePath: `/tmp/chatgpt-ide-task-${taskId}.zip`,
    conversationId,
    conversationUrl: `https://chatgpt.com/c/${conversationId}`,
  };
  global.location = { href: submitted.conversationUrl };
  global.document = { title: 'Manual Patchwork task' };
  chatgpt.conversation = async () => ({ mapping: {} });
  chatgpt.conversationHasAttachment = () => true;
  chatgpt.conversationCompletionStatus = () => 'completed';
  const calls = [];
  const driver = new Driver({
    api: {
      taskSubmitted: async (receivedTaskId, input) => {
        calls.push(['submitted', receivedTaskId, input.conversationId]);
        return { task: submitted };
      },
      taskChatStatus: async (receivedTaskId, input) => {
        calls.push(['status', receivedTaskId, input.status]);
        return { task: { ...submitted, state: 'completed', chatStatus: 'completed' } };
      },
    },
  });

  try {
    const refreshed = await driver.refreshTask({
      taskId,
      state: 'prepared',
      answerOnly: true,
      packagePath: submitted.packagePath,
      model: 'default',
      reasoningMode: 'default',
    });
    assert.equal(refreshed.state, 'completed');
    assert.deepEqual(calls, [
      ['submitted', taskId, conversationId],
      ['status', taskId, 'completed'],
    ]);
  } finally {
    chatgpt.conversation = previous.conversation;
    chatgpt.conversationCompletionStatus = previous.conversationCompletionStatus;
    chatgpt.conversationHasAttachment = previous.conversationHasAttachment;
    global.document = previous.document;
    global.location = previous.location;
  }
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
