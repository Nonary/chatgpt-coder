const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const AdmZip = require('adm-zip');
const {
  CHATGPT_URL,
  ChatGPTView,
  buildLimitNoticeDismissalScript,
  buildMergeResultDetectionScript,
  buildTaskResultDetectionScript,
  isChatGPTConversationUrl,
  isDismissibleLimitNotice,
  recoverUnconfirmedSubmissions,
  mergeTreeId,
  resultTaskId,
} = require('../src/main/chatgpt-view');
const { fingerprintRepository, runGit } = require('../src/main/git');
const { GitService, buildCompareRows, parsePorcelainStatus } = require('../src/main/git-service');
const { ResultService, parsePlainTextResult } = require('../src/main/result-service');
const { TaskService } = require('../src/main/task-service');
const {
  WorktreeService,
  mergeResultFilename,
  parseMergeResult,
  parseWorktreeList,
  validateCommitMessage,
} = require('../src/main/worktree-service');

async function createRepository(root) {
  const repositoryPath = path.join(root, 'sample-repository');
  await fs.mkdir(repositoryPath, { recursive: true });
  await runGit(repositoryPath, ['init', '-b', 'main']);
  await runGit(repositoryPath, ['config', 'user.email', 'patchwork@example.invalid']);
  await runGit(repositoryPath, ['config', 'user.name', 'Patchwork Test']);
  await fs.writeFile(path.join(repositoryPath, 'hello.txt'), 'hello\n');
  await runGit(repositoryPath, ['add', 'hello.txt']);
  await runGit(repositoryPath, ['commit', '-m', 'Initial commit']);
  return repositoryPath;
}

function plainTextResult(task, patch, commitMessage = 'fix(task): apply generated changes') {
  return `PATCHWORK_RESULT_V1\n${JSON.stringify({
    schemaVersion: 2,
    transport: 'plain-text-base64',
    taskId: task.taskId,
    status: 'completed',
    summary: 'Implemented the requested change.',
    commitMessage,
    repositories: [{
      id: task.repositories[0].id,
      baseCommit: task.repositories[0].baseCommit,
      patchEncoding: 'base64',
      patch: Buffer.from(patch).toString('base64'),
    }],
  })}\nPATCHWORK_RESULT_END`;
}

test('outbound task packages are ZIP archives containing real Git bundles', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-package-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const tasks = new TaskService(path.join(root, 'data'));
  await tasks.initialize();

  const repository = (await tasks.inspectRepositories([repositoryPath]))[0];
  const task = await tasks.createTask({
    taskText: 'Change the greeting.',
    repositories: [repository],
    autoApply: false,
  });

  assert.match(task.packagePath, /\.zip$/);
  assert.equal(task.transport, 'zip-git-bundle');
  assert.equal(task.resultTransport, 'downloaded-text-file');
  const zip = new AdmZip(task.packagePath);
  const entries = new Map(zip.getEntries().map((entry) => [entry.entryName, entry]));
  assert.ok(entries.has('AGENTS.md'));
  assert.ok(entries.has('TASK.md'));
  assert.ok(entries.has('manifest.json'));
  assert.ok(entries.has(`repositories/${repository.id}.bundle`));
  const manifest = JSON.parse(entries.get('manifest.json').getData().toString('utf8'));
  assert.equal(manifest.taskId, task.taskId);
  assert.equal(manifest.repositories[0].baseCommit, repository.baseCommit);
  assert.equal(JSON.stringify(manifest).includes(repositoryPath), false);
  const agentInstructions = entries.get('AGENTS.md').getData().toString('utf8');
  assert.match(agentInstructions, /PATCHWORK_RESULT_V1/);
  assert.match(agentInstructions, new RegExp(`chatgpt-ide-result-${task.taskId}\\.txt`));
  assert.match(agentInstructions, /do not print or paste the result envelope/i);
  const packagedBundle = entries.get(`repositories/${repository.id}.bundle`).getData();
  const sourceBundle = await fs.readFile(path.join(tasks.taskDirectory(task.taskId), 'repositories', `${repository.id}.bundle`));
  assert.deepEqual(packagedBundle, sourceBundle);
  const extractedBundle = path.join(root, 'uploaded-repository.bundle');
  await fs.writeFile(extractedBundle, packagedBundle);
  await runGit(repositoryPath, ['bundle', 'verify', extractedBundle]);
});

test('dirty repositories keep their full history and capture unstaged files as a task tip', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-working-snapshot-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  await fs.writeFile(path.join(repositoryPath, 'hello.txt'), 'locally changed\n');
  await fs.writeFile(path.join(repositoryPath, 'untracked.txt'), 'local context\n');
  const tasks = new TaskService(path.join(root, 'data'));
  await tasks.initialize();

  const task = await tasks.createTask({
    taskText: 'Continue from the supplied local changes.',
    repositories: [{ path: repositoryPath }],
    autoApply: false,
  });
  const taskRepository = task.repositories[0];
  assert.equal(taskRepository.isSnapshot, true);
  assert.equal(taskRepository.workingChanges, true);
  assert.notEqual(taskRepository.baseCommit, taskRepository.sourceHead);
  assert.equal((await runGit(repositoryPath, ['rev-parse', `${taskRepository.baseCommit}^`])).stdout.trim(), taskRepository.sourceHead);

  const zip = new AdmZip(task.packagePath);
  const bundleEntry = zip.getEntry(`repositories/${taskRepository.id}.bundle`);
  assert.equal(bundleEntry.header.method, 0);
  const manifest = JSON.parse(zip.getEntry('manifest.json').getData().toString('utf8'));
  assert.equal(manifest.repositories[0].workingChanges, true);
  assert.match(manifest.repositories[0].workingStatus, /hello\.txt/);
  assert.match(zip.getEntry('AGENTS.md').getData().toString('utf8'), /view those captured files as unstaged changes/i);

  const bundlePath = path.join(tasks.taskDirectory(task.taskId), 'repositories', `${taskRepository.id}.bundle`);
  const clonePath = path.join(root, 'history-clone');
  await runGit(root, ['clone', bundlePath, clonePath]);
  await runGit(clonePath, ['checkout', '--detach', taskRepository.baseCommit]);
  assert.equal((await runGit(clonePath, ['rev-list', '--count', taskRepository.baseCommit])).stdout.trim(), '2');
  assert.equal(await fs.readFile(path.join(clonePath, 'hello.txt'), 'utf8'), 'locally changed\n');
  assert.equal(await fs.readFile(path.join(clonePath, 'untracked.txt'), 'utf8'), 'local context\n');
  const { stdout: suppliedDiff } = await runGit(clonePath, [
    'diff', taskRepository.sourceHead, taskRepository.baseCommit, '--', '.',
  ]);
  assert.match(suppliedDiff, /locally changed/);
  assert.match(suppliedDiff, /untracked\.txt/);
});

test('results apply and commit after the coding tree HEAD advances', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-advanced-head-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const dataRoot = path.join(root, 'data');
  const trees = new WorktreeService(dataRoot);
  const tasks = new TaskService(dataRoot);
  await Promise.all([trees.initialize(), tasks.initialize()]);
  const tree = await trees.create(repositoryPath, 'Advanced head');
  const task = await tasks.createTask({
    taskText: 'Update the greeting.', repositories: [{ path: tree.path }], tree, autoApply: true,
  });

  const bundlePath = path.join(tasks.taskDirectory(task.taskId), 'repositories', `${task.repositories[0].id}.bundle`);
  const clonePath = path.join(root, 'chatgpt-advanced');
  await runGit(root, ['clone', bundlePath, clonePath]);
  await runGit(clonePath, ['checkout', '--detach', task.repositories[0].baseCommit]);
  await fs.writeFile(path.join(clonePath, 'hello.txt'), 'hello from ChatGPT\n');
  const { stdout: patchBody } = await runGit(clonePath, [
    'diff', '--binary', task.repositories[0].baseCommit, '--', '.',
  ]);

  await fs.writeFile(path.join(tree.path, 'advanced.txt'), 'newer tree commit\n');
  await runGit(tree.path, ['add', 'advanced.txt']);
  await runGit(tree.path, ['commit', '-m', 'chore: advance coding tree']);

  const result = await new ResultService(tasks).ingestText(
    task.taskId,
    plainTextResult(task, patchBody, 'fix(greeting): apply after advanced head'),
  );
  assert.equal(result.state, 'applied');
  assert.equal(await fs.readFile(path.join(tree.path, 'advanced.txt'), 'utf8'), 'newer tree commit\n');
  assert.equal(await fs.readFile(path.join(tree.path, 'hello.txt'), 'utf8'), 'hello from ChatGPT\n');
  assert.equal((await runGit(tree.path, ['log', '-1', '--pretty=%s'])).stdout.trim(), 'fix(greeting): apply after advanced head');
});

test('conflicting results remain in the tree and can be resubmitted with unstaged context', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-conflict-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const dataRoot = path.join(root, 'data');
  const trees = new WorktreeService(dataRoot);
  const tasks = new TaskService(dataRoot);
  await Promise.all([trees.initialize(), tasks.initialize()]);
  const tree = await trees.create(repositoryPath, 'Conflict flow');
  const task = await tasks.createTask({
    taskText: 'Change the greeting one way.', repositories: [{ path: tree.path }], tree, autoApply: true,
  });

  const bundlePath = path.join(tasks.taskDirectory(task.taskId), 'repositories', `${task.repositories[0].id}.bundle`);
  const clonePath = path.join(root, 'chatgpt-conflict');
  await runGit(root, ['clone', bundlePath, clonePath]);
  await runGit(clonePath, ['checkout', '--detach', task.repositories[0].baseCommit]);
  await fs.writeFile(path.join(clonePath, 'hello.txt'), 'ChatGPT version\n');
  const { stdout: patchBody } = await runGit(clonePath, [
    'diff', '--binary', task.repositories[0].baseCommit, '--', '.',
  ]);

  await fs.writeFile(path.join(tree.path, 'hello.txt'), 'newer coding tree version\n');
  await runGit(tree.path, ['add', 'hello.txt']);
  await runGit(tree.path, ['commit', '-m', 'chore: change the same greeting']);
  const conflicted = await new ResultService(tasks).ingestText(
    task.taskId,
    plainTextResult(task, patchBody, 'fix(greeting): change greeting'),
  );
  assert.equal(conflicted.state, 'conflicted');
  assert.deepEqual(conflicted.result.conflicts[0].files, ['hello.txt']);
  assert.match(await fs.readFile(path.join(tree.path, 'hello.txt'), 'utf8'), /<<<<<<<|>>>>>>>/);

  const resolutionTask = await tasks.createTask({
    taskText: 'Resolve the supplied merge conflict.',
    repositories: [{ path: tree.path }],
    tree,
    autoApply: true,
    conflictContext: {
      originalTaskId: task.taskId,
      error: conflicted.result.conflicts[0].error,
      files: conflicted.result.conflicts[0].files,
      patches: conflicted.result.patches,
    },
  });
  assert.equal(resolutionTask.repositories[0].workingChanges, true);
  const resolutionZip = new AdmZip(resolutionTask.packagePath);
  assert.ok(resolutionZip.getEntry('CONFLICTS.md'));
  assert.ok(resolutionZip.getEntry(`conflicts/${task.repositories[0].id}.patch`));

  const resolutionBundle = path.join(
    tasks.taskDirectory(resolutionTask.taskId), 'repositories', `${resolutionTask.repositories[0].id}.bundle`,
  );
  const resolutionClone = path.join(root, 'chatgpt-resolution');
  await runGit(root, ['clone', resolutionBundle, resolutionClone]);
  await runGit(resolutionClone, ['checkout', '--detach', resolutionTask.repositories[0].baseCommit]);
  assert.match(await fs.readFile(path.join(resolutionClone, 'hello.txt'), 'utf8'), /<<<<<<<|>>>>>>>/);
  await fs.writeFile(path.join(resolutionClone, 'hello.txt'), 'resolved greeting\n');
  const { stdout: resolutionPatch } = await runGit(resolutionClone, [
    'diff', '--binary', resolutionTask.repositories[0].baseCommit, '--', '.',
  ]);
  const resolved = await new ResultService(tasks).ingestText(
    resolutionTask.taskId,
    plainTextResult(resolutionTask, resolutionPatch, 'fix(greeting): resolve concurrent changes'),
  );
  assert.equal(resolved.state, 'applied');
  assert.equal(await fs.readFile(path.join(tree.path, 'hello.txt'), 'utf8'), 'resolved greeting\n');
  assert.equal((await runGit(tree.path, ['status', '--porcelain'])).stdout, '');
});

test('an unborn repository is snapshotted without changing the source and accepts its result', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-unborn-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = path.join(root, 'brand-new-repository');
  await fs.mkdir(repositoryPath, { recursive: true });
  await runGit(repositoryPath, ['init', '-b', 'main']);
  await runGit(repositoryPath, ['config', 'user.email', 'patchwork@example.invalid']);
  await runGit(repositoryPath, ['config', 'user.name', 'Patchwork Test']);
  await fs.writeFile(path.join(repositoryPath, '.gitignore'), 'ignored.txt\n');
  await fs.writeFile(path.join(repositoryPath, 'hello.txt'), 'uncommitted hello\n');
  await fs.writeFile(path.join(repositoryPath, 'ignored.txt'), 'do not package\n');

  const tasks = new TaskService(path.join(root, 'data'));
  await tasks.initialize();
  const inspected = (await tasks.inspectRepositories([repositoryPath]))[0];
  assert.equal(inspected.hasHead, false);
  assert.equal(inspected.isClean, false);
  const { stdout: statusBefore } = await runGit(repositoryPath, ['status', '--porcelain=v1', '--untracked-files=all']);

  const task = await tasks.createTask({
    taskText: 'Update the uncommitted greeting.',
    repositories: [inspected],
    autoApply: false,
  });
  const taskRepository = task.repositories[0];
  assert.equal(taskRepository.isSnapshot, true);
  assert.equal(taskRepository.sourceHead, null);
  assert.match(taskRepository.baseCommit, /^[0-9a-f]{40}$/);
  const { stdout: statusAfter } = await runGit(repositoryPath, ['status', '--porcelain=v1', '--untracked-files=all']);
  assert.equal(statusAfter, statusBefore);
  await assert.rejects(runGit(repositoryPath, ['rev-parse', '--verify', 'HEAD']), /single revision/);

  const clonePath = path.join(root, 'chatgpt-workspace');
  const bundlePath = path.join(tasks.taskDirectory(task.taskId), 'repositories', `${taskRepository.id}.bundle`);
  await runGit(root, ['clone', bundlePath, clonePath]);
  assert.equal(await fs.readFile(path.join(clonePath, 'hello.txt'), 'utf8'), 'uncommitted hello\n');
  await assert.rejects(fs.stat(path.join(clonePath, 'ignored.txt')), { code: 'ENOENT' });
  await fs.writeFile(path.join(clonePath, 'hello.txt'), 'updated by ChatGPT\n');
  const { stdout: patchBody } = await runGit(clonePath, [
    'diff', '--binary', taskRepository.baseCommit, '--', '.',
  ]);

  const resultText = `PATCHWORK_RESULT_V1\n${JSON.stringify({
    schemaVersion: 2,
    transport: 'plain-text-base64',
    taskId: task.taskId,
    status: 'completed',
    summary: 'Updated the uncommitted greeting.',
    repositories: [{
      id: taskRepository.id,
      baseCommit: taskRepository.baseCommit,
      patchEncoding: 'base64',
      patch: Buffer.from(patchBody).toString('base64'),
    }],
  })}\nPATCHWORK_RESULT_END`;

  const results = new ResultService(tasks);
  let current = await results.ingestText(task.taskId, resultText);
  assert.equal(current.state, 'ready');
  current = await results.apply(task.taskId);
  assert.equal(current.state, 'applied');
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'updated by ChatGPT\n');
  current = await results.rollback(task.taskId);
  assert.equal(current.state, 'rolled-back');
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'uncommitted hello\n');
});

test('a matching ChatGPT result validates, applies, and rolls back', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-result-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const tasks = new TaskService(path.join(root, 'data'));
  await tasks.initialize();
  const repository = (await tasks.inspectRepositories([repositoryPath]))[0];
  const task = await tasks.createTask({
    taskText: 'Change the greeting.', repositories: [repository], autoApply: false,
  });

  await fs.writeFile(path.join(repositoryPath, 'hello.txt'), 'hello from ChatGPT\n');
  const { stdout: patchBody } = await runGit(repositoryPath, ['diff', '--binary', task.repositories[0].baseCommit, '--', '.']);
  await runGit(repositoryPath, ['restore', 'hello.txt']);

  const resultText = `PATCHWORK_RESULT_V1\n${JSON.stringify({
    schemaVersion: 2,
    transport: 'plain-text-base64',
    taskId: task.taskId,
    status: 'completed',
    summary: 'Updated the greeting.',
    repositories: [{
      id: repository.id,
      baseCommit: repository.baseCommit,
      patchEncoding: 'base64',
      patch: Buffer.from(patchBody).toString('base64'),
    }],
  })}\nPATCHWORK_RESULT_END`;

  const results = new ResultService(tasks);
  let current = await results.ingestText(task.taskId, resultText);
  assert.equal(current.state, 'ready');
  assert.match(current.result.patches[0].stat, /hello\.txt/);
  current = await results.apply(task.taskId);
  assert.equal(current.state, 'applied');
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'hello from ChatGPT\n');
  current = await results.rollback(task.taskId);
  assert.equal(current.state, 'rolled-back');
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'hello\n');
});

test('result downloads accept only task text filenames including duplicate suffixes', () => {
  const taskId = '9f1fae65-e106-4c76-acbe-8ea3928810e7';
  assert.equal(resultTaskId(`chatgpt-ide-result-${taskId}.txt`), taskId);
  assert.equal(resultTaskId(`chatgpt-ide-result-${taskId} (2).txt`), taskId);
  assert.equal(resultTaskId(`chatgpt-ide-result-${taskId}.zip`), null);
  assert.equal(resultTaskId('unrelated.txt'), null);
});

test('result downloads match ChatGPT filenames including duplicate suffixes', () => {
  const taskId = '9f1fae65-e106-4c76-acbe-8ea3928810e7';
  assert.equal(resultTaskId(`chatgpt-ide-result-${taskId}.txt`), taskId);
  assert.equal(resultTaskId(`chatgpt-ide-result-${taskId} (2).txt`), taskId);
  assert.equal(resultTaskId(`chatgpt-ide-result-${taskId}.zip`), null);
  assert.equal(resultTaskId('unrelated.txt'), null);
});

test('opening a task loads its saved ChatGPT conversation', async () => {
  const loaded = [];
  const events = [];
  const task = {
    taskId: '9f1fae65-e106-4c76-acbe-8ea3928810e7',
    state: 'submitted',
    conversationUrl: 'https://chatgpt.com/c/6a80f4cf-1650-83ea-8609-adb411b3e4bc',
  };
  const view = Object.create(ChatGPTView.prototype);
  view.view = { webContents: { getURL: () => CHATGPT_URL, loadURL: async (url) => loaded.push(url) } };
  view.activeTask = null;
  view.activeMerge = { id: 'merge-in-progress' };
  view.knownTasks = new Map();
  view.taskService = { updateTask: async () => task };
  view.onEvent = async (event) => events.push(event);
  view.installResultWatcher = () => {};

  const result = await view.openTaskConversation(task);
  assert.equal(result.opened, true);
  assert.deepEqual(loaded, [task.conversationUrl]);
  assert.equal(view.activeTask, task);
  assert.equal(view.activeMerge, null);
  assert.equal(events[0].type, 'task-chat-opened');
  await assert.rejects(
    view.openTaskConversation({ ...task, conversationUrl: 'https://example.com/not-chatgpt' }),
    /invalid saved ChatGPT conversation URL/,
  );
});

test('ChatGPT request-limit dialogs are recognized and dismissed without broad clicking', () => {
  assert.equal(isDismissibleLimitNotice('Too many requests'), true);
  assert.equal(isDismissibleLimitNotice('Messages limit reached'), true);
  assert.equal(isDismissibleLimitNotice('You’ve reached your daily usage limit.'), true);
  assert.equal(isDismissibleLimitNotice('This patch exceeds its configured size limit.'), false);

  let clicked = false;
  const button = {
    textContent: 'Got it',
    disabled: false,
    getAttribute: () => null,
    click: () => { clicked = true; },
  };
  const modal = {
    textContent: 'Too many requests Please wait a few minutes before trying again. Got it',
    querySelectorAll: () => [button],
  };
  const document = {
    querySelector: (selector) => (
      selector === '[data-testid="modal-conversation-history-rate-limit"]' ? modal : null
    ),
    querySelectorAll: () => [],
  };
  const result = vm.runInNewContext(buildLimitNoticeDismissalScript(), { document });
  assert.equal(result.dismissed, true);
  assert.equal(result.action, 'Got it');
  assert.equal(clicked, true);
});

test('a downloaded text result file validates and applies automatically', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-text-result-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const tasks = new TaskService(path.join(root, 'data'));
  await tasks.initialize();
  const repository = (await tasks.inspectRepositories([repositoryPath]))[0];
  const task = await tasks.createTask({
    taskText: 'Change the greeting.', repositories: [repository], autoApply: true,
  });

  await fs.writeFile(path.join(repositoryPath, 'hello.txt'), 'plain text result\n');
  const { stdout: patchBody } = await runGit(repositoryPath, ['diff', '--binary', task.repositories[0].baseCommit, '--', '.']);
  await runGit(repositoryPath, ['restore', 'hello.txt']);
  const responseText = `Implementation complete.\nPATCHWORK_RESULT_V1\n${JSON.stringify({
    schemaVersion: 2,
    transport: 'plain-text-base64',
    taskId: task.taskId,
    status: 'completed',
    summary: 'Changed the greeting through text transport.',
    repositories: [{
      id: repository.id,
      baseCommit: repository.baseCommit,
      patchEncoding: 'base64',
      patch: Buffer.from(patchBody).toString('base64'),
    }],
  })}\nPATCHWORK_RESULT_END`;
  assert.equal(parsePlainTextResult(responseText).taskId, task.taskId);

  const results = new ResultService(tasks);
  const downloadedPath = path.join(root, task.resultFilename);
  await fs.writeFile(downloadedPath, responseText);
  const current = await results.ingestTextFile(task.taskId, downloadedPath);
  assert.equal(current.state, 'applied');
  assert.equal(current.result.transport, 'plain-text-base64');
  assert.equal(current.result.downloadedPath, downloadedPath);
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'plain text result\n');
});

test('coding trees commit task results, accept follow-ups, and squash merge', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-tree-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const dataRoot = path.join(root, 'data');
  const trees = new WorktreeService(dataRoot);
  const tasks = new TaskService(dataRoot);
  await Promise.all([trees.initialize(), tasks.initialize()]);

  const tree = await trees.create(repositoryPath, 'Modern source control');
  assert.equal(tree.clean, true);
  assert.match(tree.branch, /^patchwork\/modern-source-control-/);
  const task = await tasks.createTask({
    taskText: 'Change the greeting in the coding tree.',
    repositories: [{ path: tree.path }],
    tree,
    autoApply: true,
  });
  await trees.attachTask(tree.id, task.taskId);

  await fs.writeFile(path.join(tree.path, 'hello.txt'), 'changed in coding tree\n');
  const { stdout: patchBody } = await runGit(tree.path, ['diff', '--binary', task.repositories[0].baseCommit, '--', '.']);
  await runGit(tree.path, ['restore', 'hello.txt']);
  const responseText = `PATCHWORK_RESULT_V1\n${JSON.stringify({
    schemaVersion: 2,
    transport: 'plain-text-base64',
    taskId: task.taskId,
    status: 'completed',
    summary: 'Changed the coding-tree greeting.',
    commitMessage: 'feat(greeting): update coding tree message',
    repositories: [{
      id: task.repositories[0].id,
      baseCommit: task.repositories[0].baseCommit,
      patchEncoding: 'base64',
      patch: Buffer.from(patchBody).toString('base64'),
    }],
  })}\nPATCHWORK_RESULT_END`;
  const result = await new ResultService(tasks).ingestText(task.taskId, responseText);
  assert.equal(result.state, 'applied');
  assert.match(result.result.commits[0].commit, /^[0-9a-f]{40}$/);
  assert.equal((await runGit(tree.path, ['log', '-1', '--pretty=%s'])).stdout.trim(), 'feat(greeting): update coding tree message');
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'hello\n');

  const followUp = await tasks.createTask({
    taskText: 'Follow up on the same tree.', repositories: [{ path: tree.path }], tree, autoApply: true,
  });
  assert.equal(followUp.repositories[0].baseCommit, result.result.commits[0].commit);

  const request = await trees.buildMergeRequest(tree.id);
  assert.equal(request.resultFilename, mergeResultFilename(tree.id));
  assert.match(request.prompt, /feat\(greeting\): update coding tree message/);
  assert.match(request.prompt, /UTF-8 plain-text file/);
  assert.match(request.prompt, new RegExp(mergeResultFilename(tree.id)));
  assert.match(request.prompt, /Do not paste the PATCHWORK_MERGE_V1 envelope into the chat/);
  assert.match(request.prompt, /apply the squash merge automatically/);
  await trees.markMergeSubmitted(tree.id, 'https://chatgpt.com/c/example');
  let mergeState = await trees.markMergeFailed(tree.id, new Error('Conflicting change'));
  assert.equal(mergeState.mergeState, 'failed');
  assert.equal(mergeState.mergeError, 'Conflicting change');
  mergeState = await trees.clearMergeFailure(tree.id);
  assert.equal(mergeState.mergeState, null);
  assert.equal(mergeState.mergeError, null);
  const mergeText = `PATCHWORK_MERGE_V1\n${JSON.stringify({
    schemaVersion: 1,
    treeId: tree.id,
    summary: 'Updated the greeting.',
    commitMessage: 'feat(greeting): modernize greeting behavior',
  })}\nPATCHWORK_MERGE_END`;
  assert.equal(parseMergeResult(mergeText, tree.id).commitMessage, 'feat(greeting): modernize greeting behavior');
  await fs.writeFile(path.join(repositoryPath, 'local-staged.txt'), 'keep staged\n');
  await runGit(repositoryPath, ['add', 'local-staged.txt']);
  await fs.writeFile(path.join(repositoryPath, 'local-untracked.txt'), 'keep untracked\n');
  const merged = await trees.mergeFromText(tree.id, mergeText);
  assert.match(merged.commit, /^[0-9a-f]{40}$/);
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'changed in coding tree\n');
  assert.equal((await runGit(repositoryPath, ['log', '-1', '--pretty=%s'])).stdout.trim(), 'feat(greeting): modernize greeting behavior');
  assert.equal(await fs.readFile(path.join(repositoryPath, 'local-staged.txt'), 'utf8'), 'keep staged\n');
  assert.equal(await fs.readFile(path.join(repositoryPath, 'local-untracked.txt'), 'utf8'), 'keep untracked\n');
  const { stdout: restoredStatus } = await runGit(repositoryPath, ['status', '--porcelain=v1']);
  assert.match(restoredStatus, /^A  local-staged\.txt$/m);
  assert.match(restoredStatus, /^\?\? local-untracked\.txt$/m);
  assert.equal((await trees.list()).length, 0);
});

test('coding tree merge leaves conflicting source changes untouched', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-tree-conflict-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const trees = new WorktreeService(path.join(root, 'data'));
  const tree = await trees.create(repositoryPath, 'Conflicting source changes');
  await fs.writeFile(path.join(tree.path, 'hello.txt'), 'tree version\n');
  await runGit(tree.path, ['add', 'hello.txt']);
  await runGit(tree.path, ['commit', '-m', 'feat: update hello in tree']);
  await fs.writeFile(path.join(repositoryPath, 'hello.txt'), 'local version\n');
  const { stdout: headBefore } = await runGit(repositoryPath, ['rev-parse', 'HEAD']);
  const mergeText = `PATCHWORK_MERGE_V1\n${JSON.stringify({
    schemaVersion: 1,
    treeId: tree.id,
    summary: 'Update hello.',
    commitMessage: 'feat: update hello',
  })}\nPATCHWORK_MERGE_END`;

  await assert.rejects(
    trees.mergeFromText(tree.id, mergeText),
    /conflicts with local changes.*left unchanged/i,
  );
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'local version\n');
  assert.equal((await runGit(repositoryPath, ['rev-parse', 'HEAD'])).stdout, headBefore);
  assert.match((await runGit(repositoryPath, ['status', '--porcelain=v1'])).stdout, /^ M hello\.txt$/m);
  assert.equal((await runGit(repositoryPath, ['stash', 'list'])).stdout, '');
  assert.equal((await trees.list()).length, 1);

  await fs.writeFile(path.join(tree.path, 'hello.txt'), 'combined version\n');
  await runGit(tree.path, ['add', 'hello.txt']);
  await runGit(tree.path, ['commit', '-m', 'fix: reconcile local hello change']);
  await trees.clearMergeFailure(tree.id, await fingerprintRepository(repositoryPath));
  const merged = await trees.mergeFromText(tree.id, mergeText);
  assert.match(merged.commit, /^[0-9a-f]{40}$/);
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'combined version\n');
  assert.equal((await runGit(repositoryPath, ['status', '--porcelain=v1'])).stdout, '');
  assert.equal((await runGit(repositoryPath, ['stash', 'list'])).stdout, '');
});

test('a resolved tree can immediately prepare the resumed final merge', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-resumed-merge-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const trees = new WorktreeService(path.join(root, 'data'));
  const tree = await trees.create(repositoryPath, 'Resume final merge');
  await fs.writeFile(path.join(tree.path, 'hello.txt'), 'resolved tree\n');
  await runGit(tree.path, ['add', 'hello.txt']);
  await runGit(tree.path, ['commit', '-m', 'fix: resolve final merge']);
  await trees.markMergeFailed(tree.id, new Error('Initial merge conflict'));
  await trees.clearMergeFailure(tree.id);

  const request = await trees.buildMergeRequest(tree.id);
  assert.equal(request.treeId, tree.id);
  assert.match(request.prompt, /fix: resolve final merge/);
  assert.equal((await trees.list()).length, 1);
});

test('existing Git worktrees are discovered from workspace repositories', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-discovered-tree-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const existingPath = path.join(root, 'existing-worktree');
  await runGit(repositoryPath, ['worktree', 'add', '-b', 'feature/existing-tree', existingPath]);
  await fs.writeFile(path.join(existingPath, 'existing.txt'), 'existing worktree\n');
  await runGit(existingPath, ['add', 'existing.txt']);
  await runGit(existingPath, ['commit', '-m', 'feat: add existing worktree change']);

  const trees = new WorktreeService(
    path.join(root, 'data'),
    () => {},
    async () => [{ path: repositoryPath }],
  );
  await trees.initialize();
  let [tree] = await trees.list();
  assert.equal(tree.path, await fs.realpath(existingPath));
  assert.equal(tree.repositoryPath, await fs.realpath(repositoryPath));
  assert.equal(tree.branch, 'feature/existing-tree');
  assert.equal(tree.sourceBranch, 'main');
  assert.equal(tree.managed, false);
  assert.equal(tree.discovered, true);
  assert.equal(tree.available, true);
  assert.equal(tree.clean, true);
  assert.equal(tree.commitCount, 1);

  tree = await trees.attachTask(tree.id, 'existing-tree-task');
  assert.deepEqual(tree.taskIds, ['existing-tree-task']);

  const reloaded = await new WorktreeService(
    path.join(root, 'data'),
    () => {},
    async () => [{ path: repositoryPath }],
  ).list();
  assert.equal(reloaded.length, 1);
  assert.deepEqual(reloaded[0].taskIds, ['existing-tree-task']);

  const mergeRequest = await trees.buildMergeRequest(tree.id);
  assert.equal(mergeRequest.treeId, tree.id);
  await trees.remove(tree.id, true);
  await assert.rejects(fs.stat(existingPath), { code: 'ENOENT' });
  assert.equal((await trees.list()).length, 0);
});

test('Git porcelain worktree records parse paths and branches', () => {
  const parsed = parseWorktreeList([
    'worktree /repo', 'HEAD a'.padEnd(45, 'a'), 'branch refs/heads/main', '',
    'worktree /repo-feature', 'HEAD b'.padEnd(45, 'b'), 'branch refs/heads/feature/test', '',
  ].join('\0'));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].path, '/repo');
  assert.equal(parsed[1].branch, 'refs/heads/feature/test');
});

test('commit messages used for coding trees must be conventional', () => {
  assert.equal(validateCommitMessage('fix(parser): preserve blank lines'), 'fix(parser): preserve blank lines');
  assert.throws(() => validateCommitMessage('Updated the parser'), /Conventional Commit/);
});

test('source control stages, diffs, commits, and records history', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-git-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  await fs.writeFile(path.join(repositoryPath, 'hello.txt'), 'changed greeting\n');
  await fs.writeFile(path.join(repositoryPath, 'new-file.txt'), 'brand new\n');

  const git = new GitService(path.join(root, 'data'));
  await git.initialize();
  await git.addRepositories([repositoryPath]);
  let status = await git.status(repositoryPath);
  assert.equal(status.unstagedCount, 2);
  assert.equal(status.stagedCount, 0);
  let diff = await git.diff(repositoryPath, 'hello.txt', false);
  assert.match(diff.content, /changed greeting/);
  assert.equal(diff.beforeLabel, 'Index');
  assert.equal(diff.afterLabel, 'Working Tree');
  assert.equal(diff.rows.find((row) => row.beforeType === 'removed').beforeText, 'hello');
  assert.equal(diff.rows.find((row) => row.afterType === 'added').afterText, 'changed greeting');
  diff = await git.diff(repositoryPath, 'new-file.txt', false);
  assert.match(diff.content, /Untracked file/);
  assert.equal(diff.rows[0].beforeNumber, null);
  assert.equal(diff.rows[0].afterType, 'added');

  status = await git.stage(repositoryPath, ['hello.txt']);
  assert.equal(status.stagedCount, 1);
  diff = await git.diff(repositoryPath, 'hello.txt', true);
  assert.match(diff.content, /changed greeting/);
  assert.equal(diff.beforeLabel, 'HEAD');
  assert.equal(diff.afterLabel, 'Index');
  status = await git.unstage(repositoryPath, ['hello.txt']);
  assert.equal(status.stagedCount, 0);
  status = await git.stageAll(repositoryPath);
  assert.equal(status.stagedCount, 2);
  status = await git.commit(repositoryPath, 'Update the greeting');
  assert.equal(status.changes.length, 0);
  assert.equal(status.history[0].subject, 'Update the greeting');
  assert.equal((await git.listRepositories())[0].path, await fs.realpath(repositoryPath));

  await runGit(repositoryPath, ['mv', 'hello.txt', 'greeting.txt']);
  diff = await git.diff(repositoryPath, 'greeting.txt', true);
  assert.equal(diff.rows[0].beforeText, 'changed greeting');
  assert.equal(diff.rows[0].afterText, 'changed greeting');
  assert.equal(diff.rows[0].beforeType, 'unchanged');
  assert.equal(diff.rows[0].afterType, 'unchanged');
});

test('source control can unstage and create the first commit', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-git-unborn-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = path.join(root, 'unborn');
  await fs.mkdir(repositoryPath);
  await runGit(repositoryPath, ['init', '-b', 'main']);
  await runGit(repositoryPath, ['config', 'user.email', 'patchwork@example.invalid']);
  await runGit(repositoryPath, ['config', 'user.name', 'Patchwork Test']);
  await fs.writeFile(path.join(repositoryPath, 'first.txt'), 'first\n');

  const git = new GitService(path.join(root, 'data'));
  await git.initialize();
  let status = await git.stageAll(repositoryPath);
  assert.equal(status.stagedCount, 1);
  status = await git.unstageAll(repositoryPath);
  assert.equal(status.stagedCount, 0);
  status = await git.stageAll(repositoryPath);
  status = await git.commit(repositoryPath, 'Initial commit');
  assert.equal(status.repository.hasHead, true);
  assert.equal(status.history[0].subject, 'Initial commit');
});

test('porcelain parser represents files with staged and unstaged changes in both groups', () => {
  const [change] = parsePorcelainStatus('MM src/app.js\0');
  assert.equal(change.staged, true);
  assert.equal(change.unstaged, true);
  assert.equal(change.path, 'src/app.js');
});

test('source control compare rows align replacements for red and green split views', () => {
  const rows = buildCompareRows(
    'first\nbefore\nlast\n',
    'first\nafter\nlast\n',
    '@@ -2 +2 @@\n-before\n+after\n',
  );
  assert.deepEqual(rows.map((row) => [row.beforeText, row.beforeType, row.afterText, row.afterType]), [
    ['first', 'unchanged', 'first', 'unchanged'],
    ['before', 'removed', 'after', 'added'],
    ['last', 'unchanged', 'last', 'unchanged'],
  ]);
});
// Coding-tree regression coverage retained across the UX merge.

test('task packages contain instructions and Git bundles in one ZIP', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-package-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const tasks = new TaskService(path.join(root, 'data'));
  await tasks.initialize();

  const repository = (await tasks.inspectRepositories([repositoryPath]))[0];
  const task = await tasks.createTask({
    taskText: 'Change the greeting.',
    repositories: [repository],
    autoApply: false,
  });

  assert.match(task.packagePath, /\.zip$/);
  assert.equal(task.transport, 'zip-git-bundle');
  const archive = new AdmZip(task.packagePath);
  const entries = new Map(archive.getEntries().map((entry) => [entry.entryName, entry]));
  assert.ok(entries.has('AGENTS.md'));
  assert.ok(entries.has('TASK.md'));
  assert.ok(entries.has('manifest.json'));
  assert.ok(entries.has(`repositories/${repository.id}.bundle`));
  const manifest = JSON.parse(entries.get('manifest.json').getData().toString('utf8'));
  assert.equal(manifest.taskId, task.taskId);
  assert.equal(manifest.repositories[0].baseCommit, repository.baseCommit);
  assert.equal(JSON.stringify(manifest).includes(repositoryPath), false);
  const agentInstructions = entries.get('AGENTS.md').getData().toString('utf8');
  assert.match(agentInstructions, /PATCHWORK_RESULT_V1/);
  assert.match(agentInstructions, new RegExp(`chatgpt-ide-result-${task.taskId}\\.txt`));
  assert.match(agentInstructions, /Never print the result envelope or patch contents/i);
  assert.match(agentInstructions, /Do not attempt any of the following/i);
  assert.match(agentInstructions, /running builds, tests, linters, type checks/i);
  assert.match(agentInstructions, /accessing package registries or other external network resources/i);
  assert.match(task.handoffPrompt, /Do not install dependencies or run builds, tests/i);
  assert.match(task.handoffPrompt, /Do not paste PATCHWORK_RESULT_V1/i);
  assert.equal(task.resultFilename, `chatgpt-ide-result-${task.taskId}.txt`);
});

test('task history persists across service instances and lists newest tasks first', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-task-history-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'data');
  const tasks = new TaskService(dataRoot);
  await tasks.initialize();
  await tasks.saveTask({
    taskId: 'older-task',
    taskText: 'Older saved task',
    state: 'applied',
    createdAt: '2026-08-14T12:00:00.000Z',
    repositories: [],
  });
  await tasks.saveTask({
    taskId: 'newer-task',
    taskText: 'Newer saved task',
    state: 'failed',
    createdAt: '2026-08-15T12:00:00.000Z',
    repositories: [],
  });

  const reloadedTasks = await new TaskService(dataRoot).listTasks();
  assert.deepEqual(reloadedTasks.map((task) => task.taskId), ['newer-task', 'older-task']);
  assert.equal(reloadedTasks[0].state, 'failed');
  assert.equal(reloadedTasks[1].taskText, 'Older saved task');
});

test('conflict-resolution tasks bundle the original checkout as read-only context', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-read-only-context-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const writablePath = await createRepository(path.join(root, 'writable'));
  const contextPath = await createRepository(path.join(root, 'context'));
  await fs.writeFile(path.join(contextPath, 'local.txt'), 'local context\n');
  const tasks = new TaskService(path.join(root, 'data'));
  const task = await tasks.createTask({
    taskText: 'Resolve the failed merge.',
    repositories: [{ path: writablePath }, { path: contextPath, readOnly: true }],
    tree: { id: 'tree-with-conflict', name: 'Conflict tree', repositoryPath: contextPath },
    autoApply: true,
  });
  const contextRepository = task.repositories.find((repository) => repository.readOnly);
  assert.ok(contextRepository);
  assert.equal(contextRepository.readOnly, true);
  const archive = new AdmZip(task.packagePath);
  const files = new Map(archive.getEntries().map((entry) => [entry.entryName, entry]));
  const manifest = JSON.parse(files.get('manifest.json').getData().toString('utf8'));
  assert.equal(manifest.repositories.find((repository) => repository.id === contextRepository.id).readOnly, true);
  assert.match(files.get('AGENTS.md').getData().toString('utf8'), /never edit them/i);

  await fs.writeFile(path.join(contextPath, 'after-package.txt'), 'changed after packaging\n');
  const responseText = `PATCHWORK_RESULT_V1\n${JSON.stringify({
    schemaVersion: 2,
    transport: 'plain-text-base64',
    taskId: task.taskId,
    status: 'completed',
    summary: 'No resolution was required.',
    commitMessage: 'fix: reconcile merge context',
    repositories: task.repositories.map((repository) => ({
      id: repository.id,
      baseCommit: repository.baseCommit,
      patchEncoding: 'base64',
      patch: '',
    })),
  })}\nPATCHWORK_RESULT_END`;
  const applied = await new ResultService(tasks).ingestText(task.taskId, responseText);
  assert.equal(applied.state, 'applied');
  assert.equal(await fs.readFile(path.join(contextPath, 'after-package.txt'), 'utf8'), 'changed after packaging\n');
});

test('ChatGPT task submission only accepts real conversation URLs', () => {
  assert.equal(isChatGPTConversationUrl('https://chatgpt.com/c/abc123'), true);
  assert.equal(isChatGPTConversationUrl('https://chatgpt.com/c/abc123/'), true);
  assert.equal(isChatGPTConversationUrl('https://chatgpt.com/'), false);
  assert.equal(isChatGPTConversationUrl('https://chatgpt.com/c/'), false);
  assert.equal(isChatGPTConversationUrl('https://example.com/c/abc123'), false);
});

test('unconfirmed submitted tasks are restored to prepared state', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-submit-recovery-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const tasks = new TaskService(path.join(root, 'data'));
  await tasks.initialize();
  const repository = (await tasks.inspectRepositories([repositoryPath]))[0];
  const task = await tasks.createTask({
    taskText: 'Change the greeting.', repositories: [repository], autoApply: true,
  });
  const broken = await tasks.updateTask(task.taskId, {
    state: 'submitted',
    submittedAt: new Date().toISOString(),
  });

  const [recovered] = await recoverUnconfirmedSubmissions(tasks, [broken]);
  assert.equal(recovered.state, 'prepared');
  assert.equal(recovered.submittedAt, null);
  assert.equal(recovered.conversationUrl, null);
  assert.equal((await tasks.getTask(task.taskId)).state, 'prepared');
});

test('task submit does not report success until a ChatGPT conversation exists', async () => {
  const task = { taskId: '9f1fae65-e106-4c76-acbe-8ea3928810e7', handoffPrompt: 'Task', packagePath: '/task.txt' };
  const events = [];
  let updateCount = 0;
  const view = {
    activeMerge: null,
    activeTask: null,
    knownTasks: new Map(),
    taskService: {
      updateTask: async () => {
        updateCount += 1;
        return task;
      },
    },
    onEvent: async (event) => events.push(event),
    waitForComposer: async () => true,
    injectPrompt: async () => {},
    uploadPackage: async () => {},
    clickSend: async () => true,
    waitForConversationUrl: async () => null,
    installResultWatcher: () => {},
  };

  await assert.rejects(
    ChatGPTView.prototype.submit.call(view, task),
    /could not confirm a ChatGPT conversation/i,
  );
  assert.equal(updateCount, 0);
  assert.equal(events.at(-1).type, 'task-submit-unconfirmed');
});

test('task submit persists the confirmed ChatGPT conversation with submitted state', async () => {
  const task = { taskId: '9f1fae65-e106-4c76-acbe-8ea3928810e7', handoffPrompt: 'Task', packagePath: '/task.txt' };
  const conversationUrl = 'https://chatgpt.com/c/confirmed-conversation';
  let update;
  const view = {
    activeMerge: null,
    activeTask: null,
    knownTasks: new Map(),
    taskService: {
      updateTask: async (_taskId, next) => {
        update = next;
        return { ...task, ...next };
      },
    },
    onEvent: async () => {},
    waitForComposer: async () => true,
    injectPrompt: async () => {},
    uploadPackage: async () => {},
    clickSend: async () => true,
    waitForConversationUrl: async () => conversationUrl,
    installResultWatcher: () => {},
  };

  const submitted = await ChatGPTView.prototype.submit.call(view, task);
  assert.equal(update.state, 'submitted');
  assert.equal(update.conversationUrl, conversationUrl);
  assert.match(update.submittedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(submitted.conversationUrl, conversationUrl);
});

test('task upload selects the composer file input and dispatches its change event', async () => {
  const commands = [];
  const scripts = [];
  let attachmentWaitedFor = null;
  const debuggerApi = {
    isAttached: () => true,
    sendCommand: async (command, params) => {
      commands.push({ command, params });
      return {};
    },
  };
  const view = {
    view: {
      webContents: {
        debugger: debuggerApi,
        executeJavaScript: async (script) => {
          scripts.push(script);
          return true;
        },
      },
    },
    findFileInputNodeId: async () => 42,
    packageAttachmentStatus: async () => ({ attached: false, busy: false }),
    waitForPackageAttachment: async (filename) => {
      attachmentWaitedFor = filename;
    },
  };

  await ChatGPTView.prototype.uploadPackage.call(view, '/tasks/chatgpt-ide-task-example.txt');
  assert.deepEqual(commands.at(-1), {
    command: 'DOM.setFileInputFiles',
    params: { files: ['/tasks/chatgpt-ide-task-example.txt'], nodeId: 42 },
  });
  assert.match(scripts[0], /dispatchEvent\(new Event\('change'/);
  assert.equal(attachmentWaitedFor, 'chatgpt-ide-task-example.txt');
});

test('task upload reuses an attachment that is already in the composer', async () => {
  let debuggerAccessed = false;
  const view = {
    view: {
      webContents: {
        get debugger() {
          debuggerAccessed = true;
          return {};
        },
      },
    },
    packageAttachmentStatus: async () => ({ attached: true, busy: false }),
  };

  assert.equal(await ChatGPTView.prototype.uploadPackage.call(view, '/tasks/already-attached.txt'), true);
  assert.equal(debuggerAccessed, false);
});

test('task result detection accepts only the requested text attachment after generation stops', () => {
  const taskId = '9f1fae65-e106-4c76-acbe-8ea3928810e7';
  const resultFilename = `chatgpt-ide-result-${taskId}.txt`;
  let clicked = false;
  const link = {
    getAttribute: (name) => (name === 'download' ? resultFilename : null),
    textContent: resultFilename,
    scrollIntoView: () => {},
    click: () => { clicked = true; },
  };
  const stopButton = {
    disabled: false,
    getAttribute: (name) => (name === 'aria-disabled' ? 'false' : null),
  };
  const buildDocument = (generating) => ({
    querySelector: (selector) => (selector === '[data-testid="stop-button"]' && generating ? stopButton : null),
    querySelectorAll: (selector) => {
      if (selector === 'a[href], a[download], button, [role="link"], [role="button"]') return [link];
      if (selector === '*') return [];
      return [];
    },
  });
  const script = buildTaskResultDetectionScript(taskId);

  const generating = vm.runInNewContext(script, { document: buildDocument(true) });
  assert.equal(generating.kind, 'generating');
  assert.equal(clicked, false);

  const completed = vm.runInNewContext(script, { document: buildDocument(false) });
  assert.equal(completed.kind, 'download');
  assert.equal(clicked, true);

  const visibleEnvelopeOnly = vm.runInNewContext(script, {
    document: {
      querySelector: () => null,
      querySelectorAll: (selector) => (
        selector === '[data-message-author-role="assistant"]'
          ? [{ textContent: `PATCHWORK_RESULT_V1\n{"taskId":"${taskId}"}\nPATCHWORK_RESULT_END` }]
          : []
      ),
    },
  });
  assert.equal(visibleEnvelopeOnly.kind, 'none');
});

test('task result detection clicks ChatGPT’s download control instead of opening its file preview', () => {
  const taskId = '9f1fae65-e106-4c76-acbe-8ea3928810e7';
  const resultFilename = `chatgpt-ide-result-${taskId}.txt`;
  let previewOpened = false;
  let downloaded = false;
  const download = {
    disabled: false,
    getAttribute: () => null,
    scrollIntoView: () => {},
    click: () => { downloaded = true; },
  };
  const row = {
    parentElement: null,
    querySelectorAll: () => [download],
  };
  const preview = {
    parentElement: row,
    getAttribute: (name) => (name === 'aria-label' ? resultFilename : null),
    textContent: resultFilename,
    scrollIntoView: () => {},
    click: () => { previewOpened = true; },
  };
  const document = {
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector === 'a[href], a[download], button, [role="link"], [role="button"]') return [preview, download];
      if (selector === '*') return [];
      return [];
    },
  };

  const result = vm.runInNewContext(buildTaskResultDetectionScript(taskId), { document });
  assert.equal(result.kind, 'download');
  assert.equal(downloaded, true);
  assert.equal(previewOpened, false);
});

test('merge result detection accepts the requested text file after generation stops', () => {
  const treeId = '4b2d7b31-06ad-4ec3-99b9-7e54bc8dd3e8';
  let clicked = false;
  const link = {
    getAttribute: (name) => (name === 'download' ? mergeResultFilename(treeId) : null),
    textContent: mergeResultFilename(treeId),
    scrollIntoView: () => {},
    click: () => { clicked = true; },
  };
  const stopButton = {
    disabled: false,
    getAttribute: (name) => (name === 'aria-disabled' ? 'false' : null),
  };
  const buildDocument = (generating) => ({
    querySelector: (selector) => (selector === '[data-testid="stop-button"]' && generating ? stopButton : null),
    querySelectorAll: (selector) => {
      if (selector === '[data-message-author-role="assistant"]') return [];
      if (selector === 'a[href], a[download], button, [role="link"], [role="button"]') return [link];
      if (selector === '*') return [];
      return [];
    },
  });
  const script = buildMergeResultDetectionScript(treeId);

  const generating = vm.runInNewContext(script, { document: buildDocument(true) });
  assert.equal(generating.kind, 'generating');
  assert.equal(clicked, false);

  const completed = vm.runInNewContext(script, { document: buildDocument(false) });
  assert.equal(completed.kind, 'download');
  assert.equal(clicked, true);
  assert.equal(mergeTreeId(`${mergeResultFilename(treeId).replace('.txt', '')} (2).txt`), treeId);
});

test('finishing a task result retires it from ChatGPT monitoring', async () => {
  const task = { taskId: '9f1fae65-e106-4c76-acbe-8ea3928810e7' };
  const view = {
    activeTask: task,
    knownTasks: new Map([[task.taskId, task]]),
    onResult: async (taskId, result, transport) => ({ taskId, result, transport }),
  };

  const completed = await ChatGPTView.prototype.finishTaskResult.call(view, task, 'result text', 'text');
  assert.equal(completed.taskId, task.taskId);
  assert.equal(view.activeTask, null);
  assert.equal(view.knownTasks.has(task.taskId), false);
});

test('a downloaded plain-text ChatGPT result validates and applies automatically', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-text-result-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const tasks = new TaskService(path.join(root, 'data'));
  await tasks.initialize();
  const repository = (await tasks.inspectRepositories([repositoryPath]))[0];
  const task = await tasks.createTask({
    taskText: 'Change the greeting.', repositories: [repository], autoApply: true,
  });

  await fs.writeFile(path.join(repositoryPath, 'hello.txt'), 'plain text result\n');
  const { stdout: patchBody } = await runGit(repositoryPath, ['diff', '--binary', task.repositories[0].baseCommit, '--', '.']);
  await runGit(repositoryPath, ['restore', 'hello.txt']);
  const responseText = `Implementation complete.\nPATCHWORK_RESULT_V1\n${JSON.stringify({
    schemaVersion: 2,
    transport: 'plain-text-base64',
    taskId: task.taskId,
    status: 'completed',
    summary: 'Changed the greeting through text transport.',
    repositories: [{
      id: repository.id,
      baseCommit: repository.baseCommit,
      patchEncoding: 'base64',
      patch: Buffer.from(patchBody).toString('base64'),
    }],
  })}\nPATCHWORK_RESULT_END`;
  assert.equal(parsePlainTextResult(responseText).taskId, task.taskId);

  const results = new ResultService(tasks);
  const current = await results.ingestText(task.taskId, responseText);
  assert.equal(current.state, 'applied');
  assert.equal(current.result.transport, 'plain-text-base64');
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'plain text result\n');
});
