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
  assert.match(source, /observeConversationUpdates/);
  assert.match(source, /COMPLETION_RETRY_DELAYS/);
  assert.match(source, /knownStatus: 'completed'/);
  assert.match(source, /taskChatStatus/);
  assert.match(source, /observeConversationTitle/);
  assert.match(source, /taskTitle/);
  assert.match(source, /initialTitle: currentTitle/);
  assert.doesNotMatch(source, /if \(currentTitle\) return;/);
  assert.match(source, /Reconcile once before attaching the DOM observer/);
  assert.match(source, /push invalidation channel/);
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


test('ChatGPT WebSocket messages invalidate only the relevant conversation', async () => {
  const previousLocation = global.location;
  const conversationId = '4a3c8e79-7e2b-4b8f-8e6f-1e4b6a8c2d33';
  const otherConversationId = '5b4d9f80-8f3c-4c9f-9f70-2f5c7b9d3e44';
  global.location = { href: `https://chatgpt.com/c/${conversationId}` };
  const {
    isChatGptSocketUrl,
    messageTargetsConversation,
  } = require('../src/userscript/src/chatgpt/websocket');

  try {
    assert.equal(isChatGptSocketUrl('wss://ws.chatgpt.com/ws'), true);
    assert.equal(isChatGptSocketUrl('wss://example.com/ws'), false);
    assert.equal(await messageTargetsConversation('unstructured update', conversationId), true,
      'socket activity on the open task conversation is an invalidation signal');
    assert.equal(await messageTargetsConversation(
      JSON.stringify({ conversation_id: otherConversationId }),
      otherConversationId,
      'https://chatgpt.com/c/unrelated',
    ), true, 'background notifications can target a task by conversation id');
    assert.equal(await messageTargetsConversation(
      JSON.stringify({ conversation_id: otherConversationId }),
      conversationId,
      'https://chatgpt.com/c/unrelated',
    ), false, 'unrelated background notifications do not trigger reconciliation');
  } finally {
    global.location = previousLocation;
  }
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


test('completed tasks remain watchable while result metadata is still propagating', async () => {
  const { Driver } = require('../src/userscript/src/driver');
  const conversationId = '4a3c8e79-7e2b-4b8f-8e6f-1e4b6a8c2d33';
  const task = {
    taskId: 'metadata-lag',
    state: 'submitted',
    answerOnly: false,
    conversationId,
    conversationUrl: `https://chatgpt.com/c/${conversationId}`,
    chatStatus: 'streaming',
  };
  const completed = { ...task, chatStatus: 'completed' };
  const driver = new Driver({
    api: {
      taskChatStatus: async () => ({ task: completed }),
    },
  });
  driver.ingestTaskResult = async () => null;

  const updated = await driver.reconcileTask(task, {
    record: {
      current_node: 'answer',
      mapping: { answer: { message: { status: 'finished_successfully', end_turn: true } } },
    },
  });

  assert.equal(updated, completed, 'the completed status must survive until a later bounded retry finds the file');
  assert.equal(driver.canWatchTask(updated), true);
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

test('stale Git Summary tasks from another conversation are reconciled without becoming the active Source Control generation', async () => {
  const chatgpt = require('../src/userscript/src/chatgpt/api');
  const { Driver } = require('../src/userscript/src/driver');
  const previous = {
    conversation: chatgpt.conversation,
    document: global.document,
    location: global.location,
  };
  const summaryConversationId = '4a3c8e79-7e2b-4b8f-8e6f-1e4b6a8c2d33';
  const task = {
    taskId: 'stale-summary',
    summaryOnly: true,
    state: 'submitted',
    chatStatus: 'streaming',
    conversationId: summaryConversationId,
    conversationUrl: `https://chatgpt.com/c/${summaryConversationId}`,
  };
  global.location = { href: 'https://chatgpt.com/c/another-conversation' };
  global.document = { title: 'Source Control' };
  chatgpt.conversation = async () => ({ mapping: {} });
  const driver = new Driver({
    api: {
      taskChatStatus: async () => ({ task }),
    },
  });

  try {
    await driver.adoptTask(task);
    assert.equal(driver.activeTaskId, null);
  } finally {
    chatgpt.conversation = previous.conversation;
    global.document = previous.document;
    global.location = previous.location;
  }
});

test('a failed submission clears the driver active task so Source Control cannot remain stuck generating', async () => {
  const { Driver } = require('../src/userscript/src/driver');
  const failed = new Error('Send failed.');
  const calls = [];
  const task = { taskId: 'failed-summary', summaryOnly: true };
  const driver = new Driver({
    api: {
      taskFailed: async (taskId, message) => calls.push([taskId, message]),
    },
  });
  driver.submitTaskOnce = async () => {
    driver.activeTaskId = task.taskId;
    throw failed;
  };

  await assert.rejects(() => driver.submitTask(task), failed);
  assert.deepEqual(calls, [['failed-summary', 'Send failed.']]);
  assert.equal(driver.activeTaskId, null);
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
