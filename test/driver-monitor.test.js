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
  assert.match(source, /observeConversationTitle/);
  assert.match(source, /taskTitle/);
  assert.match(source, /Reconcile once before attaching the DOM observer/);
  assert.match(source, /seenTaskResultFiles/);
  assert.match(source, /latestTaskResultFile/);
  assert.match(source, /if \(generation === this\.watchGeneration\) arm\(\)/);
  assert.match(source, /activeFollowUp\(currentTask\)/);
  assert.match(source, /resultFileFreshForTurn/);
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

test('generated result discovery keeps follow-up files newest first', () => {
  const { findGeneratedFiles, resultFileKey } = require('../src/userscript/src/chatgpt/api');
  const filename = 'chatgpt-ide-result-3f2b7f68-6d1a-4a7e-9d5e-0d3a5f7b1c22.txt';
  const record = {
    mapping: {
      first: { message: {
        id: 'message-first',
        author: { role: 'assistant' },
        create_time: 10,
        metadata: { attachments: [{ id: 'file-first123456', name: filename }] },
      } },
      second: { message: {
        id: 'message-second',
        author: { role: 'assistant' },
        create_time: 20,
        metadata: { attachments: [
          { id: 'file-second123456', name: filename },
          { id: 'file-second123456', name: filename },
        ] },
      } },
    },
  };

  const files = findGeneratedFiles(record, (file) => file.name === filename);
  assert.deepEqual(files.map((file) => file.id), ['file-second123456', 'file-first123456']);
  assert.equal(resultFileKey(files[0]), 'id:file-second123456');
  assert.equal(resultFileKey({ messageId: 'message-3', sandboxPath: '/mnt/data/result.txt' }),
    'sandbox:message-3:/mnt/data/result.txt');
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

test('follow-up result freshness is anchored to the saved turn timestamp', () => {
  const { resultFileFreshForTurn } = require('../src/userscript/src/driver');
  const turn = {
    createdAt: '2026-08-21T18:00:00.000Z',
    submittedAt: '2026-08-21T18:00:10.000Z',
  };

  assert.equal(resultFileFreshForTurn({ createTime: Date.parse('2026-08-21T18:00:20.000Z') }, turn), true);
  assert.equal(resultFileFreshForTurn({ createTime: Date.parse('2026-08-21T18:00:04.000Z') }, turn), false);
  assert.equal(resultFileFreshForTurn({ createTime: 0 }, turn), true, 'files without a usable timestamp defer to the existing seen-file guard');
});

test('an unsent follow-up turn does not reconcile against the previous completed conversation', async () => {
  const { Driver } = require('../src/userscript/src/driver');
  const task = {
    taskId: 'created-follow-up',
    state: 'applied',
    answerOnly: false,
    conversationId: '4a3c8e79-7e2b-4b8f-8e6f-1e4b6a8c2d33',
    conversationUrl: 'https://chatgpt.com/c/4a3c8e79-7e2b-4b8f-8e6f-1e4b6a8c2d33',
    activeTurnId: 'turn-created',
    turns: [{ id: 'turn-created', mode: 'ask', state: 'created' }],
  };
  const calls = [];
  const driver = new Driver({
    api: {
      taskChatStatus: async () => { calls.push('status'); return { task: { ...task, activeTurnId: null } }; },
      taskResult: async () => { calls.push('result'); return { task }; },
    },
  });

  const updated = await driver.reconcileTask(task, {
    record: {
      current_node: 'answer',
      mapping: { answer: { message: { status: 'finished_successfully', end_turn: true } } },
    },
  });

  assert.equal(updated, task);
  assert.deepEqual(calls, []);
});

test('Ask follow-up reconciliation completes without ingesting a result file', async () => {
  const { Driver } = require('../src/userscript/src/driver');
  const taskId = '3f2b7f68-6d1a-4a7e-9d5e-0d3a5f7b1c22';
  const conversationId = '4a3c8e79-7e2b-4b8f-8e6f-1e4b6a8c2d33';
  const task = {
    taskId,
    state: 'applied',
    answerOnly: false,
    conversationId,
    conversationUrl: `https://chatgpt.com/c/${conversationId}`,
    activeTurnId: 'turn-ask',
    turns: [{ id: 'turn-ask', mode: 'ask', state: 'submitted' }],
  };
  const completed = {
    ...task,
    activeTurnId: null,
    chatStatus: 'completed',
    turns: [{ ...task.turns[0], state: 'completed', completedAt: '2026-08-21T18:01:00.000Z' }],
  };
  const calls = [];
  const driver = new Driver({
    api: {
      taskChatStatus: async () => {
        calls.push('status');
        return { task: completed };
      },
      taskResult: async () => {
        calls.push('result');
        throw new Error('Ask turns must not ingest result files');
      },
    },
  });

  const updated = await driver.reconcileTask(task, {
    record: {
      current_node: 'answer',
      mapping: { answer: { message: { status: 'finished_successfully', end_turn: true } } },
    },
  });

  assert.equal(updated.activeTurnId, null);
  assert.deepEqual(calls, ['status']);
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
