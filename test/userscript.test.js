const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const {
  chatGPTProjectUrl,
  conversationIdFromRouteUrl,
  conversationRequestIncludesAttachment,
  isChatGPTConversationUrl,
  mergeTreeId,
  normalizeConversationStreamStatus,
  normalizeConversationTitle,
  resultTaskId,
  rewriteConversationRequestBody,
  taskRequestConfiguration,
} = require('../src/shared/chatgpt');
const { element, installDocument, text } = require('./helpers/dom-stub');

test('result and merge filenames identify their task even with duplicate suffixes', () => {
  const taskId = '3f2b7f68-6d1a-4a7e-9d5e-0d3a5f7b1c22';
  assert.equal(resultTaskId(`chatgpt-ide-result-${taskId}.txt`), taskId);
  assert.equal(resultTaskId(`chatgpt-ide-result-${taskId} (1).txt`), taskId);
  assert.equal(resultTaskId(`/downloads/chatgpt-ide-result-${taskId}.txt`), taskId);
  assert.equal(resultTaskId('chatgpt-ide-result.txt'), null);
  assert.equal(resultTaskId(`chatgpt-ide-result-${taskId}.zip`), null);
  assert.equal(mergeTreeId(`chatgpt-ide-merge-result-${taskId} (2).txt`), taskId);
  assert.equal(mergeTreeId(`chatgpt-ide-result-${taskId}.txt`), null);
});

test('only real ChatGPT conversation routes are accepted as submission proof', () => {
  assert.equal(isChatGPTConversationUrl('https://chatgpt.com/c/3f2b7f68-6d1a-4a7e-9d5e-0d3a5f7b1c22'), true);
  assert.equal(isChatGPTConversationUrl('https://chatgpt.com/g/g-p-abc/c/3f2b7f68'), true);
  assert.equal(isChatGPTConversationUrl('https://chatgpt.com/'), false);
  assert.equal(isChatGPTConversationUrl('https://example.com/c/1234'), false);
  assert.equal(isChatGPTConversationUrl('http://chatgpt.com/c/1234'), false);

  assert.equal(
    conversationIdFromRouteUrl('https://chatgpt.com/c/3f2b7f68-6d1a-4a7e-9d5e-0d3a5f7b1c22'),
    '3f2b7f68-6d1a-4a7e-9d5e-0d3a5f7b1c22',
  );
  assert.equal(
    conversationIdFromRouteUrl('https://chatgpt.com/g/g-p-abc/c/3f2b7f68-6d1a-4a7e-9d5e-0d3a5f7b1c22'),
    '3f2b7f68-6d1a-4a7e-9d5e-0d3a5f7b1c22',
  );
  assert.equal(conversationIdFromRouteUrl('https://chatgpt.com/c/not-a-uuid'), null);
});

test('project URLs reject identifiers that do not belong to the project', () => {
  assert.equal(chatGPTProjectUrl('g-p-abc123'), 'https://chatgpt.com/g/g-p-abc123/project');
  assert.equal(chatGPTProjectUrl('g-p-abc123', 'g-p-abc123-tasks'), 'https://chatgpt.com/g/g-p-abc123-tasks/project');
  assert.throws(() => chatGPTProjectUrl('not-a-project'), /invalid project identifier/);
  assert.throws(() => chatGPTProjectUrl('g-p-abc123', 'g-p-other'), /invalid project URL/);
});

test('fresh project routes are distinguished from project conversations and other projects', () => {
  const { workspaceRouteMatches } = require('../src/userscript/src/chatgpt/navigate');
  const projectId = 'g-p-6a81d72f0e9c81918ec8a18a72244337';
  assert.equal(workspaceRouteMatches(
    `https://chatgpt.com/g/${projectId}-coding/project`,
    projectId,
  ), true);
  assert.equal(workspaceRouteMatches(
    `https://chatgpt.com/g/${projectId}-coding/c/3f2b7f68-6d1a-4a7e-9d5e-0d3a5f7b1c22`,
    projectId,
  ), false, 'an existing project conversation is not a fresh destination');
  assert.equal(workspaceRouteMatches('https://chatgpt.com/g/g-p-other/project', projectId), false);
  assert.equal(workspaceRouteMatches('https://chatgpt.com/', null), true);
});

test('a selected project already open as a fresh route is reused instead of clicking global New chat', () => {
  const { navigateInPage } = require('../src/userscript/src/chatgpt/navigate');
  const projectId = 'g-p-6a81d72f0e9c81918ec8a18a72244337';
  const projectUrl = `https://chatgpt.com/g/${projectId}-coding/project`;
  const previous = {
    document: global.document,
    getComputedStyle: global.getComputedStyle,
    HTMLAnchorElement: global.HTMLAnchorElement,
    location: global.location,
  };
  const newChat = {
    disabled: false,
    clicks: 0,
    click() { this.clicks += 1; },
    getAttribute: (name) => (name === 'aria-label' ? 'New chat' : null),
    matches: () => true,
    textContent: 'New chat',
  };
  global.document = { querySelectorAll: (selector) => (selector === 'a[href], button' ? [newChat] : []) };
  global.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  global.HTMLAnchorElement = class HTMLAnchorElement {};
  global.location = {
    href: projectUrl,
    origin: 'https://chatgpt.com',
    pathname: `/g/${projectId}-coding/project`,
    search: '',
    hash: '',
  };
  try {
    assert.deepEqual(navigateInPage(projectUrl, { preferNewChat: true, workspaceId: projectId }), {
      navigated: true,
      method: 'reuse-fresh-route',
    });
    assert.equal(newChat.clicks, 0, 'global New chat would drop the project context');
  } finally {
    global.document = previous.document;
    global.getComputedStyle = previous.getComputedStyle;
    global.HTMLAnchorElement = previous.HTMLAnchorElement;
    global.location = previous.location;
  }
});

test('a fresh route is not ready while the previous conversation is still rendered', () => {
  const { freshRouteReady } = require('../src/userscript/src/chatgpt/navigate');
  const projectId = 'g-p-6a81d72f0e9c81918ec8a18a72244337';
  const previous = {
    document: global.document,
    getComputedStyle: global.getComputedStyle,
    location: global.location,
  };
  const oldTurn = {
    getBoundingClientRect: () => ({ width: 700, height: 180 }),
  };
  global.document = { querySelectorAll: () => [oldTurn] };
  global.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  global.location = {
    href: `https://chatgpt.com/g/${projectId}-coding/project`,
  };
  try {
    assert.equal(freshRouteReady(projectId), false);
    oldTurn.getBoundingClientRect = () => ({ width: 0, height: 0 });
    assert.equal(freshRouteReady(projectId), true);
  } finally {
    global.document = previous.document;
    global.getComputedStyle = previous.getComputedStyle;
    global.location = previous.location;
  }
});

test('stream status and conversation titles normalize the way the task timer expects', () => {
  assert.equal(normalizeConversationStreamStatus('IS_STREAMING'), 'streaming');
  assert.equal(normalizeConversationStreamStatus('FAILURE'), 'failed');
  assert.equal(normalizeConversationStreamStatus('COMPLETED'), 'completed');
  assert.equal(normalizeConversationStreamStatus(''), 'unknown');
  assert.equal(normalizeConversationTitle('  Fix   the parser  '), 'Fix the parser');
  assert.equal(normalizeConversationTitle('ChatGPT'), '');
  assert.equal(normalizeConversationTitle('New chat'), '');
});

test('task request configuration maps models and reasoning to ChatGPT slugs', () => {
  assert.deepEqual(taskRequestConfiguration('sol', 'high'), {
    model: 'sol', reasoningMode: 'high', modelSlug: 'gpt-5-6-thinking', thinkingEffort: 'extended',
  });
  assert.deepEqual(taskRequestConfiguration('sol', 'instant'), {
    model: 'sol', reasoningMode: 'instant', modelSlug: 'gpt-5-6-instant', thinkingEffort: null,
  });
  assert.deepEqual(taskRequestConfiguration('luna', 'medium'), {
    model: 'luna', reasoningMode: 'medium', modelSlug: 'gpt-5-6-t-mini', thinkingEffort: 'standard',
  });
  assert.equal(taskRequestConfiguration('default', 'default').modelSlug, 'gpt-5-6');
  assert.throws(() => taskRequestConfiguration('gemini', 'high'), /Unsupported ChatGPT model/);
  assert.throws(() => taskRequestConfiguration('sol', 'ludicrous'), /Unsupported ChatGPT reasoning mode/);
});

test('the fetch interceptor rewrites the outgoing conversation body in place', () => {
  const configuration = taskRequestConfiguration('luna', 'low');
  const rewritten = rewriteConversationRequestBody(
    JSON.stringify({ model: 'gpt-4o', thinking_effort: 'standard', messages: [] }),
    configuration,
  );
  const payload = JSON.parse(rewritten.text);
  assert.equal(payload.model, 'gpt-5-6-t-mini');
  assert.equal(payload.thinking_effort, 'min');
  assert.deepEqual(payload.messages, []);
  assert.equal(rewritten.model, 'gpt-5-6-t-mini');
  assert.equal(rewritten.thinkingEffort, 'min');

  const instant = rewriteConversationRequestBody(
    JSON.stringify({ model: 'gpt-4o', thinking_effort: 'max' }),
    taskRequestConfiguration('sol', 'instant'),
  );
  assert.equal(JSON.parse(instant.text).thinking_effort, undefined);
  assert.throws(() => rewriteConversationRequestBody('[]', configuration), /invalid conversation request/);
});

test('attachment verification accepts ChatGPT file assets as well as the original filename', () => {
  const filename = 'chatgpt-ide-task-3f2b7f68.zip';
  assert.equal(conversationRequestIncludesAttachment(
    JSON.stringify({ messages: [{ content: { parts: [`Uploaded ${filename}`] } }] }),
    filename,
  ), true);
  assert.equal(conversationRequestIncludesAttachment(
    JSON.stringify({ messages: [{ content: { parts: [{ asset_pointer: 'file-service://file-abc' }] } }] }),
    filename,
  ), true);
  assert.equal(conversationRequestIncludesAttachment(
    JSON.stringify({ messages: [{ attachments: [{ id: 'file-abc' }] }] }),
    filename,
  ), true);
  assert.equal(conversationRequestIncludesAttachment(
    JSON.stringify({ messages: [{ content: { parts: ['Just some text'] } }] }),
    filename,
  ), false);
  assert.equal(conversationRequestIncludesAttachment('not json', filename), false);
});

test('generated result files are found in the conversation record, newest first', () => {
  const { findGeneratedFile } = require('../src/userscript/src/chatgpt/api');
  const record = {
    mapping: {
      a: {
        message: {
          id: 'a',
          create_time: 10,
          author: { role: 'assistant' },
          metadata: { attachments: [{ id: 'file-old', name: 'chatgpt-ide-result-1.txt' }] },
        },
      },
      b: {
        message: {
          id: 'b',
          create_time: 20,
          author: { role: 'assistant' },
          content: { parts: [{ asset_pointer: 'file-service://file-new', metadata: { name: 'chatgpt-ide-result-1.txt' } }] },
        },
      },
      c: {
        message: {
          id: 'c',
          create_time: 30,
          author: { role: 'user' },
          metadata: { attachments: [{ id: 'file-user', name: 'chatgpt-ide-result-1.txt' }] },
        },
      },
    },
  };
  const found = findGeneratedFile(record, (file) => file.name === 'chatgpt-ide-result-1.txt');
  assert.equal(found.id, 'file-new', 'the newest assistant attachment wins and user uploads are ignored');
  assert.equal(findGeneratedFile(record, () => false), null);
});

test('request-limit notices are dismissed but ordinary ChatGPT dialogs are not', () => {
  const notices = require('../src/userscript/src/chatgpt/notices');
  assert.equal(notices.isDismissibleLimitNotice('You have reached your daily message limit'), true);
  assert.equal(notices.isDismissibleLimitNotice('Too many requests'), true);
  assert.equal(notices.isDismissibleLimitNotice('Thinking…'), false);
  assert.equal(notices.isDismissibleLimitNotice('Share this chat'), false);

  const gotIt = text('button', 'Got it');
  const dialog = element('div', { role: 'alertdialog' }, [text('p', 'You have reached your daily message limit'), gotIt]);
  const unrelated = element('div', { role: 'alertdialog' }, [text('p', 'Thinking about your request'), text('button', 'Stop')]);
  const restore = installDocument(element('body', {}, [unrelated, dialog]));
  try {
    const result = notices.dismissBlockingLimitNotice();
    assert.equal(result.dismissed, true);
    assert.equal(result.action, 'Got it');
    assert.equal(gotIt.clicks, 1);
    assert.equal(unrelated.querySelector('button').clicks, 0);
  } finally {
    restore();
  }
});

test('attachment confirmation waits for the upload chip and reports busy processing', () => {
  const composer = require('../src/userscript/src/chatgpt/composer');
  const filename = 'chatgpt-ide-task-3f2b7f68.zip';

  const input = element('input', { type: 'file' });
  input.files = [{ name: filename }];
  const selectedOnly = element('body', {}, [input]);
  let restore = installDocument(selectedOnly);
  try {
    const status = composer.attachmentStatus(filename);
    assert.equal(status.attached, false, 'a selected input alone is not a confirmed attachment');
    assert.equal(status.selectedByInput, true);
    assert.equal(status.busy, true);
  } finally {
    restore();
  }

  const busyChip = element('div', { 'data-testid': 'file-attachment' }, [
    text('span', filename),
    element('div', { role: 'progressbar' }),
  ]);
  restore = installDocument(element('body', {}, [busyChip]));
  try {
    assert.deepEqual(
      (({ attached, busy }) => ({ attached, busy }))(composer.attachmentStatus(filename)),
      { attached: true, busy: true },
    );
  } finally {
    restore();
  }

  const readyChip = element('div', { 'data-testid': 'file-attachment' }, [text('span', filename)]);
  restore = installDocument(element('body', {}, [readyChip]));
  try {
    assert.deepEqual(
      (({ attached, busy }) => ({ attached, busy }))(composer.attachmentStatus(filename)),
      { attached: true, busy: false },
    );
  } finally {
    restore();
  }
});

test('the Send control is found by test id and never clicked while generation runs', () => {
  const composer = require('../src/userscript/src/chatgpt/composer');

  const sendButton = element('button', { 'data-testid': 'send-button' });
  let restore = installDocument(element('body', {}, [sendButton]));
  try {
    const state = composer.sendButtonState(true);
    assert.deepEqual(state, {
      found: true, enabled: true, submitted: false, clicked: true,
    });
    assert.equal(sendButton.clicks, 1);
    composer.sendButtonState(false);
    assert.equal(sendButton.clicks, 1, 'allowClick=false inspects without clicking');
  } finally {
    restore();
  }

  const stopButton = element('button', { 'data-testid': 'stop-button' });
  restore = installDocument(element('body', {}, [stopButton, element('button', { 'data-testid': 'send-button' })]));
  try {
    const state = composer.sendButtonState(true);
    assert.equal(state.submitted, true);
    assert.equal(state.clicked, false);
    assert.equal(stopButton.clicks, 0);
  } finally {
    restore();
  }

  const shadowHost = element('div', {});
  const shadow = shadowHost.attachShadow();
  const shadowSend = element('button', { 'data-testid': 'send-button' });
  shadow.append(shadowSend);
  restore = installDocument(element('body', {}, [shadowHost]));
  try {
    assert.equal(composer.sendButtonState(true).clicked, true, 'the composer walks shadow roots');
    assert.equal(shadowSend.clicks, 1);
  } finally {
    restore();
  }
});

test('the agent client builds authenticated request paths for every workspace call', async () => {
  const { Api } = require('../src/userscript/src/api');
  const calls = [];
  const api = new Api({
    kind: 'test',
    request(options) {
      calls.push(options);
      return Promise.resolve({ status: 200, text: '{"ok":true}', buffer: null });
    },
  });

  await api.gitDiff('C:/repo', 'src/app.js', true);
  assert.equal(calls.at(-1).path, '/v1/workspace/diff?path=C%3A%2Frepo&file=src%2Fapp.js&staged=true');

  await api.repositoryCatalog();
  assert.equal(calls.at(-1).path, '/v1/workspace/repository-catalog');

  await api.selectDirectory();
  assert.equal(calls.at(-1).path, '/v1/fs/select-directory');
  assert.equal(calls.at(-1).timeout, 600_000);

  await api.skills(['C:/one', 'C:/two']);
  assert.equal(calls.at(-1).path, '/v1/skills?repositories=C%3A%2Fone%0AC%3A%2Ftwo');

  await api.taskResult('task-1', 'PATCHWORK_RESULT_V1');
  assert.equal(calls.at(-1).method, 'POST');
  assert.equal(calls.at(-1).path, '/v1/tasks/task-1/result');
  assert.deepEqual(calls.at(-1).body, { text: 'PATCHWORK_RESULT_V1' });

  await api.uploadAttachment('notes v2.txt', new ArrayBuffer(4));
  assert.equal(calls.at(-1).path, '/v1/uploads?name=notes+v2.txt');

  await api.events(12);
  assert.equal(calls.at(-1).path, '/v1/events?since=12');
});

test('agent errors surface their message instead of a generic failure', async () => {
  const { AgentError, Api } = require('../src/userscript/src/api');
  const api = new Api({
    request: () => Promise.resolve({ status: 400, text: '{"error":"Add at least one Git repository."}' }),
  });
  await assert.rejects(() => api.tasks(), (error) => {
    assert.ok(error instanceof AgentError);
    assert.equal(error.message, 'Add at least one Git repository.');
    assert.equal(error.status, 400);
    return true;
  });
});

test('task labels and states match the states the agent can report', () => {
  const { taskLabel, taskStateLabel, taskStatusText } = require('../src/userscript/src/ui/labels');
  assert.equal(taskLabel({ taskText: 'Fix the parser\nmore detail' }), 'Fix the parser');
  assert.equal(taskLabel({ conversationTitle: 'Parser work', taskText: 'Fix' }), 'Parser work');
  assert.equal(taskLabel({ summaryOnly: true, repositories: [{ name: 'sunshine' }] }), 'Git Summary · sunshine');

  assert.equal(taskStateLabel({ state: 'submitted' }), 'Running');
  assert.equal(taskStateLabel({ state: 'submitted', chatStatus: 'completed' }), 'Response complete');
  assert.equal(taskStateLabel({ state: 'submitted', chatStatus: 'failed' }), 'Generation stopped');
  assert.equal(taskStateLabel({ answerOnly: true, state: 'completed' }), 'Answered');
  assert.equal(taskStateLabel({ state: 'conflicted' }), 'Needs conflict resolution');
  assert.equal(taskStateLabel({ summaryOnly: true, state: 'ready' }), 'Summary ready');

  assert.equal(taskStatusText({ state: 'conflicted' })[0], 'Conflict needs resolution');
  assert.equal(taskStatusText({ summaryOnly: true, state: 'completed' })[0], 'Git Summary applied');
  assert.equal(taskStatusText({ answerOnly: true, state: 'submitted' })[0], 'Answer is running');
  assert.equal(taskStatusText({ answerOnly: true, state: 'completed' })[0], 'Answer complete');
});

test('repository search remembers unique paths and ranks names before path-only matches', () => {
  const {
    mergeRepositoryCatalog,
    searchRepositoryCatalog,
  } = require('../src/userscript/src/ui/dialogs/repository-picker');
  const catalog = mergeRepositoryCatalog(
    [{ name: 'sunshine', path: 'D:\\sources\\sunshine' }],
    [
      { name: 'Vibepollo', path: 'D:\\sources\\Vibepollo' },
      { name: 'duplicate', path: 'd:/sources/SUNSHINE/' },
      { name: 'tools', path: 'D:\\archive\\sunshine-tools' },
    ],
  );

  assert.deepEqual(catalog.map((repository) => repository.name), ['sunshine', 'Vibepollo', 'tools']);
  assert.deepEqual(
    searchRepositoryCatalog(catalog, 'sunshine').map((repository) => repository.name),
    ['sunshine', 'tools'],
    'an exact repository name ranks before a path-only match',
  );
  assert.deepEqual(
    searchRepositoryCatalog(catalog, 'sources vibe').map((repository) => repository.name),
    ['Vibepollo'],
    'search terms can match across the repository name and full path',
  );
});

test('the userscript bundles every module it requires and keeps its install placeholders', () => {
  const build = require('../src/userscript/build');
  const bundle = build.bundle();
  assert.match(bundle, /^\/\/ ==UserScript==/);
  assert.match(bundle, /@match\s+https:\/\/chatgpt\.com\/\*/);
  assert.match(bundle, /@grant\s+GM_xmlhttpRequest/);
  assert.match(bundle, /@connect\s+127\.0\.0\.1/);
  assert.ok(bundle.includes('__PATCHWORK_TOKEN__'), 'the agent injects the token at download time');
  assert.ok(bundle.includes('__PATCHWORK_ORIGIN__'), 'the agent injects its own origin at download time');

  const modules = build.collect(build.ENTRY);
  const ids = [...modules.keys()];
  assert.ok(ids.includes('src/shared/chatgpt.js'), 'the shared ChatGPT helpers are shared, not duplicated');
  assert.ok(ids.includes('src/userscript/src/ui/styles.css'), 'the stylesheet is inlined as a module');
  for (const [id, source] of modules) {
    assert.doesNotMatch(source, /\brequire\((['"])[^'"]+\1\)/, `${id} still has an unresolved require`);
  }
  assert.doesNotMatch(bundle, /require\(['"]node:/, 'no Node built-in leaks into the page bundle');
});

test('the built userscript on disk is current', () => {
  const build = require('../src/userscript/build');
  if (!fs.existsSync(build.OUTPUT)) return;
  const digest = (value) => require('node:crypto').createHash('sha256').update(value).digest('hex').slice(0, 16);
  // Compared by digest so a stale bundle reports one line instead of 160 KB.
  assert.equal(
    digest(fs.readFileSync(build.OUTPUT, 'utf8')),
    digest(build.bundle()),
    'run `pnpm build:userscript` after changing userscript sources',
  );
});

test('the architecture note documents the transports the userscript actually implements', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'ARCHITECTURE-V3.md'), 'utf8');
  const transport = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'userscript', 'src', 'transport.js'),
    'utf8',
  );
  for (const name of ['GM_xmlhttpRequest', 'Access-Control-Allow-Private-Network', 'postMessage']) {
    assert.ok(doc.includes(name), `the architecture note should explain ${name}`);
  }
  assert.match(transport, /createGmTransport/);
  assert.match(transport, /createFetchTransport/);
  assert.match(transport, /createBridgeTransport/);
});

test('the send request stream yields the conversation id without waiting for the route', async () => {
  const { CONVERSATION_ID_PATTERN, readConversationId } = require('../src/userscript/src/chatgpt/intercept');
  // Shaped after the real event stream: delta_encoding, then resume_conversation_token.
  const chunks = [
    'event: delta_encoding\ndata: "v1"\n\n',
    'data: {"type":"resume_conversation_token","kind":"topic","token":"eyJhbGciOi",'
      + '"conversation_id":"6a8614e8-6f4c-83ea-ac44-57685def48df"}\n\n',
    'event: delta\ndata: {"p":"","o":"add"}\n\n',
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const response = new Response(stream, { status: 200 });
  assert.equal(await readConversationId(response), '6a8614e8-6f4c-83ea-ac44-57685def48df');
  assert.equal(response.bodyUsed, false, 'the page keeps its own readable copy of the stream');
  assert.equal(await new Response('nothing here').text(), 'nothing here');
  assert.equal(CONVERSATION_ID_PATTERN.exec('"conversation_id":"not-a-uuid"'), null);
});

test('the transcript fallback finds the generated file id without triggering a download', () => {
  const scan = require('../src/userscript/src/chatgpt/result-scan');
  const name = 'chatgpt-ide-result-3f2b7f68-6d1a-4a7e-9d5e-0d3a5f7b1c22.txt';

  const link = element('a', { href: '/backend-api/files/file-AbCd1234EfGh/download' });
  const card = element('div', { 'data-testid': 'file-attachment' }, [text('span', name), link]);
  let restore = installDocument(element('body', {}, [card]));
  try {
    const found = scan.findResultFileInDom(name);
    assert.deepEqual(found, { id: 'file-AbCd1234EfGh', name, source: 'dom' });
    assert.equal(link.clicks, 0, 'a browser download would land on disk, not in the page');
    assert.equal(scan.findResultFileInDom('chatgpt-ide-result-other.txt'), null);
    assert.equal(scan.isGenerating(), false);
  } finally {
    restore();
  }

  const stop = element('button', { 'data-testid': 'stop-button' });
  restore = installDocument(element('body', {}, [stop]));
  try {
    assert.equal(scan.isGenerating(), true, 'a running generation is never scanned for a result');
  } finally {
    restore();
  }
});

test('the bookmarklet uses only injection routes chatgpt.com actually permits', () => {
  const { bookmarkletSource, bridgePage } = require('../src/agent/install');
  const source = bookmarkletSource({ port: 8787, token: 'test-token' });

  assert.match(source, /window\.open\(/, 'popups are not governed by connect-src');
  assert.match(source, /createObjectURL\(new Blob\(/, 'script-src-elem allows blob:');
  assert.doesNotMatch(source, /\beval\b/, "chatgpt.com's script-src has no 'unsafe-eval'");
  assert.doesNotMatch(source, /element\.src = origin/, 'script-src-elem has no loopback entry');
  assert.doesNotMatch(source, /\bimport\(/, 'dynamic import is governed by script-src too');
  assert.match(source, /transport: 'bridge'/, 'the app reuses the bridge the bookmarklet opened');
  assert.ok(source.includes('test-token'));

  assert.match(bridgePage({ port: 8787, token: 'test-token' }), /boot-source/);
});

test('bookmarklets in later ChatGPT tabs reuse the existing popup without opening or focusing it', async () => {
  const { bookmarkletSource } = require('../src/agent/install');
  const source = bookmarkletSource({ port: 8787, token: 'test-token' });
  const channels = new Map();
  let popupOpens = 0;

  class FakeBroadcastChannel {
    constructor(name) {
      this.name = name;
      this.listeners = new Set();
      if (!channels.has(name)) channels.set(name, new Set());
      channels.get(name).add(this);
    }

    addEventListener(type, listener) {
      if (type === 'message') this.listeners.add(listener);
    }

    removeEventListener(type, listener) {
      if (type === 'message') this.listeners.delete(listener);
    }

    postMessage(data) {
      for (const peer of channels.get(this.name) || []) {
        if (peer === this) continue;
        queueMicrotask(() => {
          for (const listener of peer.listeners) listener({ data });
        });
      }
    }

    close() {
      channels.get(this.name)?.delete(this);
    }
  }

  function fakeTab() {
    const windowListeners = new Map();
    const appended = [];
    const alerts = [];
    const tabWindow = {
      addEventListener(type, listener) {
        if (!windowListeners.has(type)) windowListeners.set(type, new Set());
        windowListeners.get(type).add(listener);
      },
      removeEventListener(type, listener) {
        windowListeners.get(type)?.delete(listener);
      },
      open() {
        popupOpens += 1;
        const popup = { closed: false, close() { this.closed = true; }, postMessage() {} };
        queueMicrotask(() => {
          for (const listener of windowListeners.get('message') || []) {
            listener({
              source: tabWindow.__patchworkBootstrap?.bridgeWindow || popup,
              data: { channel: 'patchwork-bridge', type: 'boot-source', source: 'void 0;' },
            });
          }
        });
        return popup;
      },
    };
    const document = {
      createElement: () => ({ addEventListener() {}, src: '' }),
      documentElement: { append: (element) => appended.push(element) },
    };
    const context = vm.createContext({
      window: tabWindow,
      document,
      navigator: {},
      BroadcastChannel: FakeBroadcastChannel,
      Blob,
      URL: { createObjectURL: () => 'blob:patchwork', revokeObjectURL() {} },
      crypto: require('node:crypto'),
      alert: (message) => alerts.push(message),
      setTimeout,
      clearTimeout,
      queueMicrotask,
    });
    return { context, window: tabWindow, appended, alerts };
  }

  async function runBookmarklet(tab, label) {
    let timer;
    try {
      return await Promise.race([
        vm.runInContext(source, tab.context),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} bookmarklet timed out`)), 2_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  const owner = fakeTab();
  await runBookmarklet(owner, 'owner');
  const follower = fakeTab();
  await runBookmarklet(follower, 'follower');

  assert.equal(popupOpens, 1, 'the follower discovers the owner before it calls window.open');
  assert.equal(owner.window.__patchworkBootstrap.transport, 'bridge');
  assert.equal(follower.window.__patchworkBootstrap.transport, 'tab-relay');
  assert.equal(owner.appended.length, 1);
  assert.equal(follower.appended.length, 1);
  assert.deepEqual([...owner.alerts, ...follower.alerts], []);
});

test('the tab-relay transport never probes or opens a bridge window', async () => {
  const { createTransport } = require('../src/userscript/src/transport');
  const relayRequest = async (request) => ({ status: 200, text: request.path });
  const result = await createTransport({
    origin: 'http://127.0.0.1:8787',
    token: 'test-token',
    prefer: 'tab-relay',
    relayRequest,
  });

  assert.equal(result.transport.kind, 'tab-relay');
  assert.deepEqual(await result.transport.request({ path: '/health' }), { status: 200, text: '/health' });
  assert.deepEqual(result.failures, []);
});

test('a bootstrapped bridge is used directly instead of probing blocked transports', async () => {
  const { createTransport } = require('../src/userscript/src/transport');
  const previous = { window: global.window, document: global.document };
  const posted = [];
  global.window = {
    open: () => ({ closed: false, postMessage: (message) => posted.push(message) }),
    addEventListener: () => {},
  };
  global.document = { addEventListener: () => {}, removeEventListener: () => {} };
  try {
    const result = await createTransport({
      origin: 'http://127.0.0.1:8787',
      token: 'test-token',
      prefer: 'bridge',
    });
    assert.equal(result.transport.kind, 'bridge');
    assert.deepEqual(result.failures, [], 'no blocked fetch is attempted first');
  } finally {
    global.window = previous.window;
    global.document = previous.document;
  }
});

test('the popup bridge returns asynchronous replies over a transferred message port', async () => {
  const { createBridgeTransport } = require('../src/userscript/src/transport');
  const previousWindow = global.window;
  const popup = {
    closed: false,
    postMessage(message, origin, transfer) {
      assert.equal(origin, 'http://127.0.0.1:8787');
      assert.equal(message.request.path, '/health');
      assert.equal(transfer.length, 1);
      transfer[0].postMessage({ status: 200, text: '{"ok":true}' });
    },
  };
  global.window = {
    addEventListener: () => {},
  };
  try {
    const transport = createBridgeTransport({
      origin: 'http://127.0.0.1:8787', token: 'test-token', bridgeWindow: popup,
    });
    assert.deepEqual(await transport.request({ path: '/health', timeout: 1_000 }), {
      status: 200, text: '{"ok":true}', buffer: null,
    });
  } finally {
    global.window = previousWindow;
  }
});

test('the popup bridge forwards attachment bytes instead of dropping binary request bodies', async () => {
  const { createBridgeTransport } = require('../src/userscript/src/transport');
  const previousWindow = global.window;
  const bytes = new Uint8Array([11, 22, 33, 44]).buffer;
  const popup = {
    closed: false,
    postMessage(message, origin, transfer) {
      assert.equal(origin, 'http://127.0.0.1:8787');
      assert.equal(message.request.path, '/v1/uploads?name=notes.txt');
      assert.equal(message.request.method, 'POST');
      assert.equal(message.request.headers['Content-Type'], 'application/octet-stream');
      assert.deepEqual([...new Uint8Array(message.request.body)], [11, 22, 33, 44]);
      assert.equal(transfer.length, 2, 'the reply port and attachment buffer are transferred');
      assert.equal(transfer[1], message.request.body);
      transfer[0].postMessage({ status: 200, text: '{"name":"notes.txt"}' });
    },
  };
  global.window = {
    addEventListener: () => {},
  };
  try {
    const transport = createBridgeTransport({
      origin: 'http://127.0.0.1:8787', token: 'test-token', bridgeWindow: popup,
    });
    assert.deepEqual(await transport.request({
      method: 'POST', path: '/v1/uploads?name=notes.txt', body: bytes, timeout: 1_000,
    }), {
      status: 200, text: '{"name":"notes.txt"}', buffer: null,
    });
  } finally {
    global.window = previousWindow;
  }
});

test('project listing matches the sidebar shape a real session returns', async () => {
  const { installDocument: install } = require('./helpers/dom-stub');
  const previous = { fetch: global.fetch, location: global.location, localStorage: global.localStorage };
  const restore = install(element('body', {}));
  global.location = { origin: 'https://chatgpt.com' };
  global.localStorage = { getItem: () => null };
  global.document.cookie = '';
  const pages = [{
    items: [
      { gizmo: { gizmo: { id: 'g-p-6a81d72f0e9c81918ec8a18a72244337', short_url: 'g-p-6a81d72f0e9c81918ec8a18a72244337-coding', display: { name: 'Coding' } } } },
      { gizmo: { gizmo: { id: 'g-p-0000', display: { name: 'Zebra' } } } },
      { gizmo: { gizmo: { id: 'not-a-project', display: { name: 'Ignored' } } } },
    ],
    cursor: null,
  }];
  global.fetch = async (url) => {
    if (String(url).includes('/api/auth/session')) {
      return new Response(JSON.stringify({ accessToken: 'token', account: { id: 'acct' } }), { status: 200 });
    }
    return new Response(JSON.stringify(pages.shift() || { items: [], cursor: null }), { status: 200 });
  };
  try {
    delete require.cache[require.resolve('../src/userscript/src/chatgpt/session')];
    delete require.cache[require.resolve('../src/userscript/src/chatgpt/api')];
    const { listProjects } = require('../src/userscript/src/chatgpt/api');
    const projects = await listProjects();
    assert.deepEqual(projects, [
      { id: 'g-p-6a81d72f0e9c81918ec8a18a72244337', shortUrl: 'g-p-6a81d72f0e9c81918ec8a18a72244337-coding', name: 'Coding' },
      { id: 'g-p-0000', shortUrl: null, name: 'Zebra' },
    ], 'sorted by name, non-project gizmos dropped');
    assert.equal(
      chatGPTProjectUrl(projects[0].id, projects[0].shortUrl),
      'https://chatgpt.com/g/g-p-6a81d72f0e9c81918ec8a18a72244337-coding/project',
    );
  } finally {
    restore();
    global.fetch = previous.fetch;
    global.location = previous.location;
    global.localStorage = previous.localStorage;
    delete require.cache[require.resolve('../src/userscript/src/chatgpt/session')];
    delete require.cache[require.resolve('../src/userscript/src/chatgpt/api')];
  }
});

test('the composer picker maps every menu choice to the slug ChatGPT expects', () => {
  const picker = require('../src/userscript/src/chatgpt/model-picker');

  assert.equal(picker.displayLabel({ model: 'default', reasoningMode: 'default' }), 'Sol · Auto');
  assert.equal(picker.displayLabel({ model: 'luna', reasoningMode: 'high' }), 'Luna · High');
  assert.equal(picker.displayLabel({ model: 'sol', reasoningMode: 'extra-high' }), 'Sol · Extra High');

  assert.equal(picker.selectedSlug({ model: 'default', reasoningMode: 'default' }), 'gpt-5-6');
  assert.equal(picker.selectedSlug({ model: 'sol', reasoningMode: 'instant' }), 'gpt-5-6-instant');
  assert.equal(picker.selectedSlug({ model: 'sol', reasoningMode: 'high' }), 'gpt-5-6-thinking');
  assert.equal(picker.selectedSlug({ model: 'luna', reasoningMode: 'instant' }), 'gpt-5-6-mini');
  assert.equal(picker.selectedSlug({ model: 'luna', reasoningMode: 'medium' }), 'gpt-5-6-t-mini');

  const current = { model: 'default', reasoningMode: 'default' };
  assert.equal(picker.isChecked('model:sol', current), true, 'default resolves to Sol in the menu');
  assert.equal(picker.isChecked('model:luna', current), false);
  assert.equal(picker.isChecked('reasoning:default', current), true);
  picker.applyChoice('model:luna', current);
  picker.applyChoice('reasoning:extra-high', current);
  assert.deepEqual(current, { model: 'luna', reasoningMode: 'extra-high' });
  assert.equal(picker.isChecked('model:luna', current), true);

  const choices = picker.MENU_ITEMS.filter((item) => item.choice).map((item) => item.choice);
  assert.deepEqual(choices, [
    'model:sol', 'model:luna',
    'reasoning:default', 'reasoning:instant', 'reasoning:low',
    'reasoning:medium', 'reasoning:high', 'reasoning:extra-high',
  ]);
});

test('the picker recognizes ChatGPT model controls without matching ordinary buttons', () => {
  const { NATIVE_PICKER_LABEL, NATIVE_PICKER_SELECTOR } = require('../src/userscript/src/chatgpt/model-picker');
  for (const label of ['ChatGPT', 'ChatGPT 5.6', 'GPT-5.6 Sol', '5.6 Luna', 'Thinking', 'Thinking mini', 'Auto', 'Pro', 'Instant']) {
    assert.equal(NATIVE_PICKER_LABEL.test(label), true, `${label} should be recognized`);
  }
  for (const label of ['Send', 'Attach files', 'Share', 'New chat', 'Sol Invictus', 'ChatGPT said:']) {
    assert.equal(NATIVE_PICKER_LABEL.test(label), false, `${label} should not be recognized`);
  }
  assert.match(NATIVE_PICKER_SELECTOR, /model-switcher-dropdown/);
  assert.match(NATIVE_PICKER_SELECTOR, /composer-intelligence-button/);
});

test('the request enforcer reads the picker at send time, not at task creation', async () => {
  const { beginEnforcement } = require('../src/userscript/src/chatgpt/intercept');
  const { taskRequestConfiguration } = require('../src/shared/chatgpt');

  const live = { model: 'sol', reasoningMode: 'low' };
  const previous = { window: global.window, location: global.location };
  global.location = { origin: 'https://chatgpt.com' };
  let sent = null;
  global.window = {
    fetch: async (url, init) => {
      sent = { url: String(url), body: init.body };
      return new Response('data: {}', { status: 200 });
    },
  };
  try {
    const enforcement = beginEnforcement({
      configuration: () => ({
        ...taskRequestConfiguration(live.model, live.reasoningMode),
        source: 'patchwork-selector',
      }),
    });
    // The user switches to Luna Extra High in the composer after the task existed.
    live.model = 'luna';
    live.reasoningMode = 'extra-high';

    await window.fetch('https://chatgpt.com/backend-api/f/conversation', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });
    const verified = await enforcement.wait(1_000);
    enforcement.dispose();

    assert.equal(JSON.parse(sent.body).model, 'gpt-5-6-t-mini', 'the live Luna choice is what goes out');
    assert.equal(JSON.parse(sent.body).thinking_effort, 'max');
    assert.equal(verified.selectedModel, 'luna');
    assert.equal(verified.selectedReasoningMode, 'extra-high');
    assert.equal(verified.selectionSource, 'patchwork-selector');
  } finally {
    global.window = previous.window;
    global.location = previous.location;
    delete require.cache[require.resolve('../src/userscript/src/chatgpt/intercept')];
  }
});

test('conversation navigation can confirm a send that the page fetch wrapper did not observe', async () => {
  delete require.cache[require.resolve('../src/userscript/src/chatgpt/intercept')];
  const { beginEnforcement } = require('../src/userscript/src/chatgpt/intercept');
  const previous = { window: global.window, location: global.location };
  global.location = { origin: 'https://chatgpt.com' };
  global.window = { fetch: async () => new Response('', { status: 200 }) };
  try {
    const enforcement = beginEnforcement({ configuration: () => null });
    const fallback = Promise.resolve({
      ok: true,
      requestVerified: false,
      conversationUrl: 'https://chatgpt.com/c/3f2b7f68-6d1a-4a7e-9d5e-0d3a5f7b1c22',
    });
    const confirmed = await enforcement.wait(1_000, fallback);
    enforcement.dispose();

    assert.equal(confirmed.requestVerified, false);
    assert.equal(confirmed.conversationUrl, 'https://chatgpt.com/c/3f2b7f68-6d1a-4a7e-9d5e-0d3a5f7b1c22');
  } finally {
    global.window = previous.window;
    global.location = previous.location;
    delete require.cache[require.resolve('../src/userscript/src/chatgpt/intercept')];
  }
});

test('conversation navigation does not override an intercepted attachment failure', async () => {
  delete require.cache[require.resolve('../src/userscript/src/chatgpt/intercept')];
  const { beginEnforcement } = require('../src/userscript/src/chatgpt/intercept');
  const previous = { window: global.window, location: global.location };
  global.location = { origin: 'https://chatgpt.com' };
  global.window = { fetch: async () => new Response('', { status: 200 }) };
  try {
    const enforcement = beginEnforcement({
      configuration: () => ({ model: 'sol', reasoningMode: 'high', modelSlug: 'gpt-5-6-thinking' }),
      packageFilename: 'chatgpt-ide-task-expected.zip',
    });
    await assert.rejects(
      window.fetch('https://chatgpt.com/backend-api/f/conversation', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
      }),
      /did not include the task ZIP attachment/,
    );
    await assert.rejects(
      enforcement.wait(1_000, Promise.resolve({ ok: true, requestVerified: false })),
      (error) => error.retrySubmission === true && /did not include the task ZIP attachment/.test(error.message),
    );
    enforcement.dispose();
  } finally {
    global.window = previous.window;
    global.location = previous.location;
    delete require.cache[require.resolve('../src/userscript/src/chatgpt/intercept')];
  }
});

test('the picker governs ordinary sends, not only Patchwork task sends', async () => {
  delete require.cache[require.resolve('../src/userscript/src/chatgpt/intercept')];
  const intercept = require('../src/userscript/src/chatgpt/intercept');
  const { taskRequestConfiguration } = require('../src/shared/chatgpt');

  const previous = { window: global.window, location: global.location };
  global.location = { origin: 'https://chatgpt.com' };
  let sent = null;
  global.window = {
    fetch: async (url, init) => {
      sent = { url: String(url), body: init?.body ?? null };
      return new Response('data: {}', { status: 200 });
    },
  };
  try {
    // No task is in flight; only the composer picker is set.
    let pickerInstalled = true;
    intercept.setAmbientConfiguration(() => (pickerInstalled
      ? { ...taskRequestConfiguration('luna', 'high'), source: 'patchwork-selector' }
      : null));

    await window.fetch('https://chatgpt.com/backend-api/f/conversation', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5-6', messages: [] }),
    });
    const rewritten = JSON.parse(sent.body);
    assert.equal(rewritten.model, 'gpt-5-6-t-mini', 'an ordinary chat is sent as Luna');
    assert.equal(rewritten.thinking_effort, 'extended');

    // With no picker installed Patchwork must not touch ChatGPT's own request.
    pickerInstalled = false;
    const original = JSON.stringify({ model: 'gpt-5-6', messages: [] });
    await window.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST', body: original });
    assert.equal(sent.body, original, 'declining the resolver leaves the request untouched');

    // Unrelated endpoints are never rewritten.
    await window.fetch('https://chatgpt.com/backend-api/conversations', { method: 'POST', body: '{"a":1}' });
    assert.equal(sent.body, '{"a":1}');
  } finally {
    intercept.setAmbientConfiguration(null);
    global.window = previous.window;
    global.location = previous.location;
    delete require.cache[require.resolve('../src/userscript/src/chatgpt/intercept')];
  }
});

test('the picker mounts inside the composer rather than floating over the page', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'userscript', 'src', 'chatgpt', 'model-picker.js'),
    'utf8',
  );
  // A viewport-positioned picker cannot follow the composer, which is how it
  // ended up sitting on top of the dock.
  assert.doesNotMatch(source, /position:fixed[^`]*id: PICKER_ID/);
  assert.match(source, /function mountPicker/);
  assert.match(source, /slot\.append\(picker\)/);
  assert.doesNotMatch(source, /positionPicker/, 'no snapshotted viewport coordinates remain');
  assert.doesNotMatch(source, /visibility:hidden/, 'the slot now shows the picker instead of hiding');
  // Project composers can omit ChatGPT's native model control, so the picker
  // falls back to the composer's action row without using viewport coordinates.
  assert.match(source, /function findComposerActionRow/);
  assert.match(source, /data-fallback': 'composer-actions'/);
  assert.match(source, /ensureComposerFallbackSlot\(slot\)/);
  assert.match(source, /if \(!slot\?\.isConnected\)/);
  assert.match(source, /--patchwork-dock-width/, 'the menu is kept clear of the dock');
  assert.match(source, /if \(!externalMutation\) return/, 'the observer ignores Patchwork-owned mutations');
  assert.doesNotMatch(source, /slot\.style\.cssText\s*=/, 'slot resizing does not blindly retrigger style observation');
  assert.doesNotMatch(source, /characterData:\s*true/, 'streamed transcript text does not retrigger picker discovery');
  assert.doesNotMatch(source, /attributes:\s*true/, 'unrelated page attribute churn does not retrigger picker discovery');
  assert.match(source, /currentPicker\?\.isConnected && currentSlot\?\.isConnected/, 'task sends reuse the live picker');
  assert.match(source, /MUTATION_SETTLE_MILLISECONDS = 250/, 'composer replacement scans are throttled');
});
