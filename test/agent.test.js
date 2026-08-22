const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const gitConfigPath = path.join(os.tmpdir(), 'patchwork-agent-test-gitconfig');
require('node:fs').writeFileSync(gitConfigPath, '[core]\n\tautocrlf = false\n\teol = lf\n');
process.env.GIT_CONFIG_GLOBAL = gitConfigPath;
process.env.GIT_CONFIG_SYSTEM = gitConfigPath;

const { isAllowedOrigin, loadConfig } = require('../src/agent/config');
const { EventLog } = require('../src/agent/events');
const { FsService } = require('../src/agent/services/fs-service');
const { PromptService, appendPromptInstructions, normalizePrompt } = require('../src/agent/services/prompt-service');
const { Router } = require('../src/agent/router');
const { runGit } = require('../src/agent/services/git');
const { startServer } = require('../src/agent/server');
const { installPage, bookmarkletSource, bridgePage } = require('../src/agent/install');

async function createRepository(root, name = 'sample-repository') {
  const repositoryPath = path.join(root, name);
  await fs.mkdir(repositoryPath, { recursive: true });
  await runGit(repositoryPath, ['init', '-b', 'main']);
  await runGit(repositoryPath, ['config', 'user.email', 'patchwork@example.invalid']);
  await runGit(repositoryPath, ['config', 'user.name', 'Patchwork Test']);
  await runGit(repositoryPath, ['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(repositoryPath, 'hello.txt'), 'hello\n');
  await runGit(repositoryPath, ['add', 'hello.txt']);
  await runGit(repositoryPath, ['commit', '-m', 'Initial commit']);
  return repositoryPath;
}

async function startAgent(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-agent-'));
  const config = await loadConfig({ dataRoot: root, port: 0 });
  const started = await startServer(config);
  const { port } = started.server.address();
  context.after(async () => {
    await new Promise((resolve) => started.server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const call = async (method, route, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    return { status: response.status, payload, response };
  };

  return {
    root, config, port, call, context: started.context,
  };
}

test('the agent refuses every workspace route without its token and allows only ChatGPT origins', async (context) => {
  const agent = await startAgent(context);

  const unauthenticated = await fetch(`http://127.0.0.1:${agent.port}/v1/tasks`);
  assert.equal(unauthenticated.status, 401);
  assert.match((await unauthenticated.json()).error, /token is missing or incorrect/);

  const wrongToken = await agent.call('GET', '/v1/tasks', undefined, { Authorization: 'Bearer not-the-token' });
  assert.equal(wrongToken.status, 401);

  const health = await fetch(`http://127.0.0.1:${agent.port}/health`);
  assert.equal(health.status, 200, 'health is public so the page can probe transports cheaply');
  assert.equal((await health.json()).ok, true);

  assert.equal(isAllowedOrigin('https://chatgpt.com'), true);
  assert.equal(isAllowedOrigin('https://chat.openai.com'), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:8787'), true);
  assert.equal(isAllowedOrigin('https://evil.example'), false);
  assert.equal(isAllowedOrigin('null'), false);
  assert.equal(isAllowedOrigin(undefined), false);
});

test('an occupied configured port falls back until a random port can be bound', async (context) => {
  const blockers = [http.createServer(), http.createServer()];
  await Promise.all(blockers.map((blocker) => (
    new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  )));
  const occupiedPorts = blockers.map((blocker) => blocker.address().port);
  context.after(() => Promise.all(blockers.map((blocker) => (
    new Promise((resolve) => blocker.close(resolve))
  ))));

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-port-fallback-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = await loadConfig({ dataRoot: root, port: occupiedPorts[0] });
  const candidates = [occupiedPorts[1], 0];
  const started = await startServer(config, { randomPort: () => candidates.shift() });
  context.after(() => new Promise((resolve) => started.server.close(resolve)));

  assert.ok(!occupiedPorts.includes(started.address.port));
  assert.deepEqual(candidates, [], 'the second collision causes another candidate to be tried');
  assert.equal(config.port, started.address.port, 'generated install assets use the port that actually bound');
  const source = await (await fetch(`http://127.0.0.1:${started.address.port}/patchwork.user.js`)).text();
  assert.ok(source.includes(`http://127.0.0.1:${started.address.port}`));
  assert.doesNotMatch(source, /127\.0\.0\.1:0\b/);
});

test('preflight answers the Private Network Access and embedder policy checks chatgpt.com needs', async (context) => {
  const agent = await startAgent(context);
  const response = await fetch(`http://127.0.0.1:${agent.port}/v1/tasks`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://chatgpt.com',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Private-Network': 'true',
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://chatgpt.com');
  assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.match(response.headers.get('access-control-allow-headers'), /Authorization/);

  const foreign = await fetch(`http://127.0.0.1:${agent.port}/health`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(foreign.headers.get('access-control-allow-origin'), null, 'unknown origins get no CORS grant');
});

test('unknown routes and wrong methods are reported distinctly', async (context) => {
  const agent = await startAgent(context);
  const missing = await agent.call('GET', '/v1/nope');
  assert.equal(missing.status, 404);
  const wrongMethod = await agent.call('POST', '/v1/trees');
  assert.equal(wrongMethod.status, 405);
  assert.match(wrongMethod.payload.error, /not allowed/);
});

test('choosing the original repositories never runs coding-tree validation', async (context) => {
  const agent = await startAgent(context);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-original-target-'));
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const firstRepository = await createRepository(workspace, 'first-repository');
  const secondRepository = await createRepository(workspace, 'second-repository');

  const created = await agent.call('POST', '/v1/tasks', {
    taskText: 'Update both original repositories.',
    repositories: [{ path: firstRepository }, { path: secondRepository }],
  });
  assert.equal(created.status, 200);
  assert.equal(created.payload.task.treeId, null);

  const selected = await agent.call(
    'POST',
    `/v1/tasks/${created.payload.task.taskId}/target`,
    { treeId: null },
  );
  assert.equal(selected.status, 200);
  assert.equal(selected.payload.task.treeId, null);
  assert.deepEqual(
    selected.payload.task.repositories.map((repository) => repository.path),
    [firstRepository, secondRepository],
  );
});

test('a task travels create, download, submit, result, and apply entirely over HTTP', async (context) => {
  const agent = await startAgent(context);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-agent-repo-'));
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const repositoryPath = await createRepository(workspace);

  const added = await agent.call('POST', '/v1/workspace/repositories', { paths: [repositoryPath] });
  assert.equal(added.status, 200);
  assert.equal(added.payload.repositories.length, 1);

  const created = await agent.call('POST', '/v1/tasks', {
    taskText: 'Add a goodbye file.',
    repositories: [{ path: repositoryPath }],
    model: 'sol',
    reasoningMode: 'high',
  });
  assert.equal(created.status, 200);
  const task = created.payload.task;
  assert.equal(task.state, 'prepared');
  assert.equal(task.model, 'sol');
  assert.equal(task.reasoningMode, 'high');
  assert.equal(task.resultFilename, `chatgpt-ide-result-${task.taskId}.txt`);

  const zip = await fetch(`http://127.0.0.1:${agent.port}/v1/tasks/${task.taskId}/package`, {
    headers: { Authorization: `Bearer ${agent.config.token}` },
  });
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  const bytes = Buffer.from(await zip.arrayBuffer());
  assert.ok(bytes.length > 0);
  assert.equal(bytes.subarray(0, 2).toString('utf8'), 'PK', 'the page receives a real ZIP to attach');

  const conversationUrl = 'https://chatgpt.com/c/3f2b7f68-6d1a-4a7e-9d5e-0d3a5f7b1c22';
  const submitted = await agent.call('POST', `/v1/tasks/${task.taskId}/submitted`, {
    conversationUrl,
    conversationId: '3f2b7f68-6d1a-4a7e-9d5e-0d3a5f7b1c22',
    conversationTitle: 'Add a goodbye file',
  });
  assert.equal(submitted.payload.task.state, 'submitted');
  assert.equal(submitted.payload.task.chatStatus, 'streaming');

  const renamed = await agent.call('POST', `/v1/tasks/${task.taskId}/title`, {
    conversationId: '3f2b7f68-6d1a-4a7e-9d5e-0d3a5f7b1c22',
    title: '  Generated   task title  ',
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.payload.task.conversationTitle, 'Generated task title');

  const wrongConversation = await agent.call('POST', `/v1/tasks/${task.taskId}/title`, {
    conversationId: '4a3c8e79-7e2b-4b8f-8e6f-1e4b6a8c2d33',
    title: 'Wrong conversation',
  });
  assert.equal(wrongConversation.status, 400);

  const rejected = await agent.call('POST', `/v1/tasks/${task.taskId}/submitted`, { conversationUrl: 'https://chatgpt.com/' });
  assert.equal(rejected.status, 400, 'a task is never marked submitted without a real conversation');

  const status = await agent.call('POST', `/v1/tasks/${task.taskId}/chat-status`, { status: 'COMPLETED' });
  assert.equal(status.payload.task.chatStatus, 'completed');
  assert.ok(status.payload.task.chatFinishedAt, 'the elapsed timer stops when ChatGPT finishes');

  const patch = [
    'diff --git a/goodbye.txt b/goodbye.txt',
    'new file mode 100644',
    'index 0000000..dd7e1c6',
    '--- /dev/null',
    '+++ b/goodbye.txt',
    '@@ -0,0 +1 @@',
    '+goodbye',
    '',
  ].join('\n');
  const envelope = `PATCHWORK_RESULT_V1\n${JSON.stringify({
    schemaVersion: 2,
    transport: 'plain-text-base64',
    taskId: task.taskId,
    status: 'completed',
    summary: 'Added goodbye.txt.',
    commitMessage: 'feat(sample): add a goodbye file',
    repositories: [{
      id: task.repositories[0].id,
      baseCommit: task.repositories[0].baseCommit,
      patchEncoding: 'base64',
      patch: Buffer.from(patch).toString('base64'),
    }],
  })}\nPATCHWORK_RESULT_END`;

  const ready = await agent.call('POST', `/v1/tasks/${task.taskId}/result`, { text: envelope });
  assert.equal(ready.status, 200);
  assert.equal(ready.payload.task.state, 'ready', 'validated changes wait for the selected apply target');
  assert.equal(await fs.access(path.join(repositoryPath, 'goodbye.txt')).then(() => true, () => false), false);

  const applied = await agent.call('POST', `/v1/tasks/${task.taskId}/apply`);
  assert.equal(applied.payload.task.state, 'applied');
  assert.equal(await fs.readFile(path.join(repositoryPath, 'goodbye.txt'), 'utf8'), 'goodbye\n');

  const rolledBack = await agent.call('POST', `/v1/tasks/${task.taskId}/rollback`);
  assert.equal(rolledBack.payload.task.state, 'rolled-back');

  const listed = await agent.call('GET', '/v1/tasks');
  assert.equal(listed.payload.tasks.length, 1);
  const deleted = await agent.call('DELETE', `/v1/tasks/${task.taskId}`);
  assert.equal(deleted.payload.deleted, true);
  assert.equal((await agent.call('GET', '/v1/tasks')).payload.tasks.length, 0);
});

test('creating an apply target sends the ready result to that new tree', async (context) => {
  const agent = await startAgent(context);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-new-apply-tree-'));
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const repositoryPath = await createRepository(workspace);
  const created = await agent.call('POST', '/v1/tasks', {
    taskText: 'Add a file in a newly selected coding tree.',
    repositories: [{ path: repositoryPath }],
  });
  const task = created.payload.task;
  const patch = [
    'diff --git a/tree-only.txt b/tree-only.txt',
    'new file mode 100644',
    'index 0000000..ce01362',
    '--- /dev/null',
    '+++ b/tree-only.txt',
    '@@ -0,0 +1 @@',
    '+tree only',
    '',
  ].join('\n');
  const envelope = `PATCHWORK_RESULT_V1\n${JSON.stringify({
    schemaVersion: 2,
    transport: 'plain-text-base64',
    taskId: task.taskId,
    status: 'completed',
    summary: 'Added a tree-only file.',
    commitMessage: 'feat(tree): add tree-only file',
    repositories: [{
      id: task.repositories[0].id,
      baseCommit: task.repositories[0].baseCommit,
      patchEncoding: 'base64',
      patch: Buffer.from(patch).toString('base64'),
    }],
  })}\nPATCHWORK_RESULT_END`;

  const ready = await agent.call('POST', `/v1/tasks/${task.taskId}/result`, { text: envelope });
  assert.equal(ready.payload.task.state, 'ready');
  const targeted = await agent.call('POST', `/v1/tasks/${task.taskId}/target`, {
    createTree: true,
    treeName: 'New apply target',
  });
  assert.equal(targeted.status, 200);
  assert.equal(targeted.payload.task.treeName, 'New apply target');

  const applied = await agent.call('POST', `/v1/tasks/${task.taskId}/apply`);
  assert.equal(applied.payload.task.state, 'applied');
  assert.equal(await fs.readFile(path.join(applied.payload.task.repositories[0].path, 'tree-only.txt'), 'utf8'), 'tree only\n');
  assert.equal(await fs.access(path.join(repositoryPath, 'tree-only.txt')).then(() => true, () => false), false);
  assert.equal(
    (await runGit(applied.payload.task.repositories[0].path, ['log', '-1', '--pretty=%s'])).stdout.trim(),
    'feat(tree): add tree-only file',
  );
});

test('a ready result applies to an existing coding tree when that target is selected', async (context) => {
  const agent = await startAgent(context);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-existing-apply-tree-'));
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const repositoryPath = await createRepository(workspace);
  const tree = await agent.context.worktreeService.create(repositoryPath, 'Existing apply target');
  const created = await agent.call('POST', '/v1/tasks', {
    taskText: 'Add a file in an existing coding tree.',
    repositories: [{ path: repositoryPath }],
  });
  const task = created.payload.task;
  const patch = [
    'diff --git a/existing-tree.txt b/existing-tree.txt',
    'new file mode 100644',
    'index 0000000..aead3b7',
    '--- /dev/null',
    '+++ b/existing-tree.txt',
    '@@ -0,0 +1 @@',
    '+existing tree',
    '',
  ].join('\n');
  const envelope = `PATCHWORK_RESULT_V1\n${JSON.stringify({
    schemaVersion: 2,
    transport: 'plain-text-base64',
    taskId: task.taskId,
    status: 'completed',
    summary: 'Added existing-tree.txt.',
    commitMessage: 'feat(tree): apply to existing tree',
    repositories: [{
      id: task.repositories[0].id,
      baseCommit: task.repositories[0].baseCommit,
      patchEncoding: 'base64',
      patch: Buffer.from(patch).toString('base64'),
    }],
  })}\nPATCHWORK_RESULT_END`;

  const ready = await agent.call('POST', `/v1/tasks/${task.taskId}/result`, { text: envelope });
  assert.equal(ready.payload.task.state, 'ready');
  const targeted = await agent.call('POST', `/v1/tasks/${task.taskId}/target`, { treeId: tree.id });
  assert.equal(targeted.status, 200);
  assert.equal(targeted.payload.task.treeId, tree.id);

  const applied = await agent.call('POST', `/v1/tasks/${task.taskId}/apply`);
  assert.equal(applied.payload.task.state, 'applied');
  assert.equal(await fs.readFile(path.join(tree.path, 'existing-tree.txt'), 'utf8'), 'existing tree\n');
  assert.equal(await fs.access(path.join(repositoryPath, 'existing-tree.txt')).then(() => true, () => false), false);
  assert.equal(
    (await runGit(tree.path, ['log', '-1', '--pretty=%s'])).stdout.trim(),
    'feat(tree): apply to existing tree',
  );
});

test('answer-only tasks complete with the ChatGPT response and reject result uploads', async (context) => {
  const agent = await startAgent(context);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-agent-answer-only-'));
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const repositoryPath = await createRepository(workspace);

  const created = await agent.call('POST', '/v1/tasks', {
    taskText: 'Explain how hello.txt is used.',
    repositories: [{ path: repositoryPath }],
    answerOnly: true,
  });
  assert.equal(created.status, 200);
  const task = created.payload.task;
  assert.equal(task.answerOnly, true);
  assert.equal(task.resultFilename, null);

  const conversationUrl = 'https://chatgpt.com/c/3f2b7f68-6d1a-4a7e-9d5e-0d3a5f7b1c22';
  await agent.call('POST', `/v1/tasks/${task.taskId}/submitted`, { conversationUrl });
  const completed = await agent.call('POST', `/v1/tasks/${task.taskId}/chat-status`, {
    status: 'COMPLETED',
  });
  assert.equal(completed.payload.task.state, 'completed');
  assert.equal(completed.payload.task.chatStatus, 'completed');
  assert.ok(completed.payload.task.chatFinishedAt);

  const result = await agent.call('POST', `/v1/tasks/${task.taskId}/result`, {
    text: 'PATCHWORK_RESULT_V1',
  });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /ask tasks do not accept/i);
});

test('Ask-first tasks can apply a result after an Agent follow-up has completed', async (context) => {
  const agent = await startAgent(context);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-agent-follow-up-result-'));
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const repositoryPath = await createRepository(workspace);

  const created = await agent.call('POST', '/v1/tasks', {
    taskText: 'Explain hello.txt, then implement the requested refinement.',
    repositories: [{ path: repositoryPath }],
    answerOnly: true,
    autoApply: true,
  });
  assert.equal(created.status, 200);
  const task = created.payload.task;
  const conversationId = '4b2d8e79-7f2c-4b9f-8f6f-1e4b6a8c2d44';
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  await agent.call('POST', `/v1/tasks/${task.taskId}/submitted`, {
    conversationUrl,
    conversationId,
  });
  await agent.call('POST', `/v1/tasks/${task.taskId}/chat-status`, { status: 'COMPLETED' });

  const followUp = await agent.call('POST', `/v1/tasks/${task.taskId}/follow-ups`, {
    mode: 'agent',
    prompt: 'Implement the refinement.',
    model: 'luna',
    reasoningMode: 'medium',
  });
  assert.equal(followUp.status, 200);
  assert.equal(followUp.payload.task.answerOnly, true);
  assert.equal(followUp.payload.turn.mode, 'agent');
  assert.equal(followUp.payload.task.repositories[0].readOnly, false);

  await agent.context.taskService.completeFollowUpResult(
    task.taskId,
    followUp.payload.turn.id,
    { id: 'file-follow-up-result-123456' },
  );

  const patch = [
    'diff --git a/follow-up.txt b/follow-up.txt',
    'new file mode 100644',
    'index 0000000..48cad33',
    '--- /dev/null',
    '+++ b/follow-up.txt',
    '@@ -0,0 +1 @@',
    '+follow-up result',
    '',
  ].join('\n');
  const envelope = `PATCHWORK_RESULT_V1\n${JSON.stringify({
    schemaVersion: 2,
    transport: 'plain-text-base64',
    taskId: task.taskId,
    status: 'completed',
    summary: 'Added the follow-up result.',
    commitMessage: 'feat(task): apply follow-up result',
    repositories: [{
      id: task.repositories[0].id,
      baseCommit: task.repositories[0].baseCommit,
      patchEncoding: 'base64',
      patch: Buffer.from(patch).toString('base64'),
    }],
  })}\nPATCHWORK_RESULT_END`;

  const applied = await agent.call('POST', `/v1/tasks/${task.taskId}/result`, { text: envelope });
  assert.equal(applied.status, 200);
  assert.equal(applied.payload.task.state, 'applied');
  assert.equal(applied.payload.task.activeTurnId, null);
  assert.equal(applied.payload.task.turns.at(-1).mode, 'agent');
  assert.equal(await fs.readFile(path.join(repositoryPath, 'follow-up.txt'), 'utf8'), 'follow-up result\n');
});

test('a result envelope for a different task is refused before anything is applied', async (context) => {
  const agent = await startAgent(context);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-agent-mismatch-'));
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const repositoryPath = await createRepository(workspace);

  const { payload } = await agent.call('POST', '/v1/tasks', {
    taskText: 'Do something.',
    repositories: [{ path: repositoryPath }],
  });
  const task = payload.task;
  const envelope = `PATCHWORK_RESULT_V1\n${JSON.stringify({
    schemaVersion: 2,
    transport: 'plain-text-base64',
    taskId: '00000000-0000-4000-8000-000000000000',
    status: 'completed',
    summary: 'Wrong task.',
    repositories: [],
  })}\nPATCHWORK_RESULT_END`;

  const rejected = await agent.call('POST', `/v1/tasks/${task.taskId}/result`, { text: envelope });
  assert.equal(rejected.status, 400);
  assert.match(rejected.payload.error, /different Patchwork task/);
  assert.equal((await agent.call('GET', `/v1/tasks/${task.taskId}`)).payload.task.state, 'failed');
});

test('uploaded attachments are staged on disk and reach the task package', async (context) => {
  const agent = await startAgent(context);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-agent-upload-'));
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const repositoryPath = await createRepository(workspace);

  const upload = await fetch(`http://127.0.0.1:${agent.port}/v1/uploads?name=${encodeURIComponent('notes: draft.txt')}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${agent.config.token}`, 'Content-Type': 'application/octet-stream' },
    body: 'requirement one\n',
  });
  assert.equal(upload.status, 200);
  const staged = await upload.json();
  assert.equal(staged.name, 'notes_ draft.txt', 'unsafe filename characters are replaced');
  assert.equal(await fs.readFile(staged.path, 'utf8'), 'requirement one\n');

  const { payload } = await agent.call('POST', '/v1/tasks', {
    taskText: 'Use the attached notes.',
    repositories: [{ path: repositoryPath }],
    attachments: [{ path: staged.path }],
  });
  assert.equal(payload.task.attachments.length, 1);
  assert.equal(payload.task.attachments[0].name, staged.name);

  const download = await fetch(
    `http://127.0.0.1:${agent.port}/v1/tasks/${payload.task.taskId}/attachments/${encodeURIComponent(staged.name)}`,
    { headers: { Authorization: `Bearer ${agent.config.token}` } },
  );
  assert.equal(await download.text(), 'requirement one\n', 'the page can re-upload attachments to ChatGPT');
});

test('saved prompts live in the agent and are appended to the task text', async (context) => {
  const agent = await startAgent(context);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-agent-prompts-'));
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const repositoryPath = await createRepository(workspace);

  const saved = await agent.call('POST', '/v1/prompts', {
    name: 'Accessibility review',
    description: 'Keyboard and labels',
    content: 'Check keyboard navigation and accessible names.',
  });
  assert.equal(saved.status, 200);
  const promptId = saved.payload.prompt.id;

  const duplicate = await agent.call('POST', '/v1/prompts', { name: 'accessibility review', content: 'Other text.' });
  assert.equal(duplicate.status, 400);
  assert.match(duplicate.payload.error, /already exists/);

  const created = await agent.call('POST', '/v1/tasks', {
    taskText: 'Improve the settings dialog.',
    repositories: [{ path: repositoryPath }],
    promptIds: [promptId],
  });
  assert.match(created.payload.task.taskText, /Improve the settings dialog\./);
  assert.match(created.payload.task.taskText, /Additional instructions from the prompt library/);
  assert.match(created.payload.task.taskText, /### Accessibility review/);

  const removed = await agent.call('DELETE', `/v1/prompts/${promptId}`);
  assert.deepEqual(removed.payload.prompts, []);
});

test('the Git summary route packages a read-only task using the saved Git Summary prompt', async (context) => {
  const agent = await startAgent(context);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-agent-summary-'));
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const repositoryPath = await createRepository(workspace);
  await fs.writeFile(path.join(repositoryPath, 'hello.txt'), 'hello again\n');

  const empty = await agent.call('POST', '/v1/git-summary', { path: repositoryPath });
  assert.equal(empty.status, 200);
  assert.equal(empty.payload.task.summaryOnly, true);
  assert.equal(empty.payload.task.model, 'luna');
  assert.equal(empty.payload.task.reasoningMode, 'medium');
  assert.equal(empty.payload.task.repositories[0].readOnly, true);
  assert.equal(empty.payload.usedCustomPrompt, false);
  assert.match(empty.payload.task.taskText, /Review all \*\*uncommitted Git changes\*\*/);

  await agent.call('POST', '/v1/prompts', { name: 'Git Summary', content: 'Summarize the diff my way.' });
  const custom = await agent.call('POST', '/v1/git-summary', { path: repositoryPath });
  assert.equal(custom.payload.usedCustomPrompt, true);
  assert.equal(custom.payload.task.taskText, 'Summarize the diff my way.');
});

test('the event log is replayed from a sequence so a page reload misses nothing', async (context) => {
  const agent = await startAgent(context);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-agent-events-'));
  context.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const repositoryPath = await createRepository(workspace);

  await agent.call('POST', '/v1/tasks', { taskText: 'One.', repositories: [{ path: repositoryPath }] });
  const first = await agent.call('GET', '/v1/events?since=0&wait=false');
  assert.ok(first.payload.events.length >= 1);
  assert.equal(first.payload.events[0].type, 'task-prepared');
  assert.equal(first.payload.events[0].seq, 1);

  await agent.call('POST', '/v1/tasks', { taskText: 'Two.', repositories: [{ path: repositoryPath }] });
  const second = await agent.call('GET', `/v1/events?since=${first.payload.seq}&wait=false`);
  assert.ok(second.payload.events.every((event) => event.seq > first.payload.seq));
  assert.equal((await agent.call('GET', '/v1/events?since=999&wait=false')).payload.events.length, 0);
});

test('event long-polling resolves as soon as an event arrives and otherwise times out empty', async () => {
  const events = new EventLog();
  const waiting = events.wait(0, 5_000);
  events.emit({ type: 'task-prepared' });
  const delivered = await waiting;
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].type, 'task-prepared');
  assert.ok(delivered[0].at, 'events carry a timestamp for the activity feed');
  assert.deepEqual(await events.wait(events.sequence, 20), []);
  assert.deepEqual(events.since(0).map((event) => event.seq), [1]);
});

test('the filesystem service browses directories and finds repositories for the in-page picker', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-fs-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await createRepository(path.join(root, 'projects'), 'alpha');
  await fs.mkdir(path.join(root, 'projects', 'plain'), { recursive: true });
  await fs.mkdir(path.join(root, 'projects', 'node_modules'), { recursive: true });

  const service = new FsService();
  const listing = await service.browse(path.join(root, 'projects'));
  const names = listing.directories.map((entry) => entry.name).sort();
  assert.deepEqual(names, ['alpha', 'node_modules', 'plain']);
  assert.equal(listing.directories.find((entry) => entry.name === 'alpha').repository, true);
  assert.equal(listing.directories.find((entry) => entry.name === 'plain').repository, false);
  assert.ok(listing.parent, 'the picker can walk back up');
  assert.ok(listing.roots.length > 0, 'the picker offers drive or filesystem roots');

  const discovered = await service.discoverRepositories(root);
  assert.deepEqual(discovered.map((entry) => entry.name), ['alpha']);
  await assert.rejects(() => service.browse(path.join(root, 'missing')));
});

test('the filesystem service opens the Windows folder picker and returns its selected directory', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-native-picker-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const service = new FsService({
    platform: 'win32',
    homeDirectory: root,
    execute: async (...args) => {
      calls.push(args);
      return { stdout: `${root}\r\n` };
    },
  });

  assert.equal(await service.selectDirectory(), await fs.realpath(root));
  assert.equal(calls[0][0], 'powershell.exe');
  assert.ok(calls[0][1].includes('-STA'), 'the Windows dialog runs in a single-threaded apartment');
  assert.equal(calls[0][2].env.PATCHWORK_PICKER_INITIAL_DIRECTORY, root);
});

test('canceling the native folder picker returns no directory', async () => {
  const service = new FsService({
    platform: 'win32',
    execute: async () => ({ stdout: '' }),
  });
  assert.equal(await service.selectDirectory(), null);
});

test('filesystem discovery adds repositories to the durable picker catalog', async (context) => {
  const agent = await startAgent(context);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-catalog-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root, 'remember-me');
  const query = new URLSearchParams({ path: root });

  const discovered = await agent.call('GET', `/v1/fs/discover?${query}`);
  assert.equal(discovered.status, 200);
  assert.deepEqual(discovered.payload.repositories.map((repository) => repository.name), ['remember-me']);

  const catalog = await agent.call('GET', '/v1/workspace/repository-catalog');
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.payload.repositories, [{ name: 'remember-me', path: repositoryPath }]);
});

test('prompt records are normalized and clamped before they are stored', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-prompt-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));

  assert.equal(normalizePrompt({ name: '  ', content: 'x' }), null);
  assert.equal(normalizePrompt({ name: 'x', content: '  ' }), null);
  const normalized = normalizePrompt({ name: 'A'.repeat(80), content: 'body\r\nmore\r\n' });
  assert.equal(normalized.name.length, 60);
  assert.equal(normalized.content, 'body\nmore');
  assert.match(normalized.id, /^prompt-/);

  const service = new PromptService(root);
  assert.deepEqual(await service.list(), []);
  const saved = await service.save({ name: 'Git Summary', content: 'Summarize.' });
  assert.equal(await service.gitSummaryPrompt(), 'Summarize.');
  const updated = await service.save({ id: saved.id, name: 'Git Summary', content: 'Summarize better.' });
  assert.equal(updated.id, saved.id);
  assert.equal((await service.list()).length, 1);
  assert.equal(await service.gitSummaryPrompt(), 'Summarize better.');
  await assert.rejects(() => service.remove('missing'), /no longer exists/);

  assert.equal(appendPromptInstructions('Task.', []), 'Task.');
  assert.match(
    appendPromptInstructions('Task.', [{ name: 'Review', content: 'Look closely.' }]),
    /Task\.\n\nAdditional instructions from the prompt library:\n\n### Review\nLook closely\./,
  );
});

test('the router matches parameters and distinguishes an unknown path from a wrong method', () => {
  const router = new Router();
  router.get('/v1/tasks/:taskId/package', () => null);
  router.post('/v1/tasks/:taskId/result', () => null);

  const match = router.resolve('GET', '/v1/tasks/abc%2F123/package');
  assert.deepEqual(match.params, { taskId: 'abc/123' });
  assert.equal(router.resolve('DELETE', '/v1/tasks/abc/package').methodNotAllowed, true);
  assert.equal(router.resolve('GET', '/v1/tasks/abc'), null);
  assert.equal(router.resolve('GET', '/v1/tasks/abc/package/extra'), null);
});

test('install assets carry the token and describe both injection routes', async (context) => {
  const agent = await startAgent(context);

  const install = await fetch(`http://127.0.0.1:${agent.port}/install`);
  assert.equal(install.status, 200);
  assert.match(install.headers.get('content-type'), /text\/html/);
  const page = await install.text();
  assert.match(page, /patchwork\.user\.js/);
  assert.match(page, /Tampermonkey/);
  assert.match(page, /bookmarklet/i);

  const bookmarklet = await fetch(`http://127.0.0.1:${agent.port}/bookmarklet.js`);
  assert.match(bookmarklet.headers.get('content-type'), /javascript/);
  const source = await bookmarklet.text();
  assert.ok(source.includes(agent.config.token), 'the bookmarklet carries the agent token');
  assert.match(source, /window\.open\(/);
  assert.match(source, /createObjectURL/);
  assert.doesNotMatch(source, /\beval\b/);

  const bridge = await fetch(`http://127.0.0.1:${agent.port}/bridge`);
  const bridgeHtml = await bridge.text();
  assert.match(bridgeHtml, /addEventListener\('message'/);
  assert.match(bridgeHtml, /https:\/\/chatgpt\.com/);

  assert.match(installPage(agent.config), /Patchwork v3/);
  assert.match(bridgePage(agent.config), /patchwork-bridge/);
  assert.ok(bookmarkletSource(agent.config).includes('__patchworkBootstrap'));
});

test('the served userscript has its placeholders replaced and no CORS grant', async (context) => {
  const agent = await startAgent(context);
  const response = await fetch(`http://127.0.0.1:${agent.port}/patchwork.user.js`, {
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.equal(
    response.headers.get('access-control-allow-origin'),
    null,
    'no other origin may read the token baked into the script',
  );
  const source = await response.text();
  assert.doesNotMatch(source, /__PATCHWORK_TOKEN__/);
  assert.doesNotMatch(source, /__PATCHWORK_ORIGIN__/);
  assert.ok(source.includes(agent.config.token));
  assert.ok(source.includes(`http://127.0.0.1:${agent.config.port}`));
  assert.match(source, /patchwork\.runtime\.js/, 'the installed script loads the current runtime from the agent');

  const runtimeResponse = await fetch(`http://127.0.0.1:${agent.port}/patchwork.runtime.js`);
  assert.equal(runtimeResponse.status, 200);
  const runtime = await runtimeResponse.text();
  assert.doesNotMatch(runtime, /__PATCHWORK_TOKEN__/);
  assert.ok(runtime.includes(agent.config.token));
  assert.match(runtime, /__patchworkRequire/, 'the runtime contains the compiled application');
});

test('a submitted task without a confirmed conversation is recovered on agent start', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-recover-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-recover-repo-'));
  context.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(workspace, { recursive: true, force: true }),
  ]));
  const repositoryPath = await createRepository(workspace);

  const config = await loadConfig({ dataRoot: root, port: 0 });
  const first = await startServer(config);
  const created = await first.context.taskService.createTask({
    taskText: 'Recover me.',
    repositories: [{ path: repositoryPath }],
  });
  await first.context.taskService.updateTask(created.taskId, {
    state: 'submitted',
    submittedAt: new Date().toISOString(),
    conversationUrl: null,
    chatStatus: 'streaming',
  });
  await new Promise((resolve) => first.server.close(resolve));

  const second = await startServer(await loadConfig({ dataRoot: root, port: 0 }));
  context.after(() => new Promise((resolve) => second.server.close(resolve)));
  const recovered = await second.context.taskService.getTask(created.taskId);
  assert.equal(recovered.state, 'prepared');
  assert.equal(recovered.submittedAt, null);
  assert.equal(recovered.chatStatus, null);
});

test('the install page embeds the bootstrap instead of loading it from the agent', async (context) => {
  const agent = await startAgent(context);
  const page = await (await fetch(`http://127.0.0.1:${agent.port}/install`)).text();
  const href = /<a class="button bookmarklet" href="javascript:([^"]+)"/.exec(page);
  assert.ok(href, 'the install page offers a bookmarklet');
  const source = decodeURIComponent(href[1]);

  // chatgpt.com's script-src-elem has no loopback entry, so a bookmarklet that
  // injected <script src="http://127.0.0.1:…"> would be refused outright.
  assert.doesNotMatch(source, /<script/i);
  assert.doesNotMatch(source, /\.src = ['"]?\s*origin/);
  assert.doesNotMatch(source, /\beval\b/);
  assert.match(source, /window\.open\(/);
  assert.match(source, /createObjectURL\(new Blob\(/);
  assert.ok(source.includes(agent.config.token));
});

test('only one bridge window survives, and an orphaned one closes itself', async (context) => {
  const agent = await startAgent(context);
  const page = await (await fetch(`http://127.0.0.1:${agent.port}/bridge`)).text();

  // A window name only dedupes within one browsing context group, so a second
  // tab could otherwise leave a second bridge behind.
  assert.match(page, /new BroadcastChannel\('patchwork-bridge'\)/);
  assert.match(page, /type: 'claim'/);
  assert.match(page, /event\.data\.id !== instanceId\) window\.close\(\)/);
  assert.match(page, /window\.opener\.closed/, 'an orphaned bridge closes itself');

  const transport = await fs.readFile(
    path.join(__dirname, '..', 'src', 'userscript', 'src', 'transport.js'),
    'utf8',
  );
  assert.match(transport, /addEventListener\('pagehide'/);
  assert.match(transport, /popup\.close\(\)/);
  assert.match(transport, /'patchwork-bridge',/, 'the window is named so it is reused, not duplicated');
  assert.match(transport, /new MessageChannel\(\)/, 'requests transfer a durable response port');
  assert.match(page, /event\.ports\?\.\[0\]/, 'the bridge replies through the transferred port');
});
