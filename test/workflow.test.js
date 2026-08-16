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
  isDismissibleLimitNotice,
  resultTaskId,
} = require('../src/main/chatgpt-view');
const { runGit } = require('../src/main/git');
const { GitService, parsePorcelainStatus } = require('../src/main/git-service');
const { ResultService, parsePlainTextResult, safeArchivePath } = require('../src/main/result-service');
const { TaskService } = require('../src/main/task-service');
const { WorktreeService, parseMergeResult, validateCommitMessage } = require('../src/main/worktree-service');

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

  const resultPath = path.join(root, `chatgpt-ide-result-${task.taskId}.zip`);
  const zip = new AdmZip();
  zip.addFile('result.json', Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    taskId: task.taskId,
    status: 'completed',
    summary: 'Updated the uncommitted greeting.',
    repositories: [{
      id: taskRepository.id,
      baseCommit: taskRepository.baseCommit,
      patchFile: `patches/${taskRepository.id}.patch`,
    }],
  }, null, 2)}\n`));
  zip.addFile(`patches/${taskRepository.id}.patch`, Buffer.from(patchBody));
  zip.writeZip(resultPath);

  const results = new ResultService(tasks);
  let current = await results.ingest(task.taskId, resultPath);
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

  const resultPath = path.join(root, `chatgpt-ide-result-${task.taskId}.zip`);
  const zip = new AdmZip();
  zip.addFile('result.json', Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    taskId: task.taskId,
    status: 'completed',
    summary: 'Updated the greeting.',
    repositories: [{
      id: repository.id,
      baseCommit: repository.baseCommit,
      patchFile: `patches/${repository.id}.patch`,
    }],
  }, null, 2)}\n`));
  zip.addFile(`patches/${repository.id}.patch`, Buffer.from(patchBody));
  zip.writeZip(resultPath);

  const results = new ResultService(tasks);
  let current = await results.ingest(task.taskId, resultPath);
  assert.equal(current.state, 'ready');
  assert.match(current.result.patches[0].stat, /hello\.txt/);
  current = await results.apply(task.taskId);
  assert.equal(current.state, 'applied');
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'hello from ChatGPT\n');
  current = await results.rollback(task.taskId);
  assert.equal(current.state, 'rolled-back');
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'hello\n');
});

test('archive paths cannot escape the result container', () => {
  assert.equal(safeArchivePath('patches/repo.patch'), 'patches/repo.patch');
  assert.throws(() => safeArchivePath('../../outside.patch'), /unsafe path/);
  assert.throws(() => safeArchivePath('/absolute.patch'), /unsafe path/);
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

test('a downloaded text result validates and applies automatically', async (context) => {
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
  const responseText = `PATCHWORK_RESULT_V1\n${JSON.stringify({
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
  const downloadedPath = path.join(root, `chatgpt-ide-result-${task.taskId}.txt`);
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
  assert.match(request.prompt, /feat\(greeting\): update coding tree message/);
  await trees.markMergeSubmitted(tree.id, 'https://chatgpt.com/c/example');
  let mergeState = await trees.markMergeFailed(tree.id, new Error('Conflicting change'));
  assert.equal(mergeState.mergeState, 'failed');
  assert.equal(mergeState.mergeError, 'Conflicting change');
  const mergeText = `PATCHWORK_MERGE_V1\n${JSON.stringify({
    schemaVersion: 1,
    treeId: tree.id,
    summary: 'Updated the greeting.',
    commitMessage: 'feat(greeting): modernize greeting behavior',
  })}\nPATCHWORK_MERGE_END`;
  assert.equal(parseMergeResult(mergeText, tree.id).commitMessage, 'feat(greeting): modernize greeting behavior');
  const merged = await trees.mergeFromText(tree.id, mergeText);
  assert.match(merged.commit, /^[0-9a-f]{40}$/);
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'changed in coding tree\n');
  assert.equal((await runGit(repositoryPath, ['log', '-1', '--pretty=%s'])).stdout.trim(), 'feat(greeting): modernize greeting behavior');
  assert.equal((await trees.list()).length, 0);
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
  assert.match((await git.diff(repositoryPath, 'hello.txt', false)).content, /changed greeting/);
  assert.match((await git.diff(repositoryPath, 'new-file.txt', false)).content, /Untracked file/);

  status = await git.stage(repositoryPath, ['hello.txt']);
  assert.equal(status.stagedCount, 1);
  assert.match((await git.diff(repositoryPath, 'hello.txt', true)).content, /changed greeting/);
  status = await git.unstage(repositoryPath, ['hello.txt']);
  assert.equal(status.stagedCount, 0);
  status = await git.stageAll(repositoryPath);
  assert.equal(status.stagedCount, 2);
  status = await git.commit(repositoryPath, 'Update the greeting');
  assert.equal(status.changes.length, 0);
  assert.equal(status.history[0].subject, 'Update the greeting');
  assert.equal((await git.listRepositories())[0].path, await fs.realpath(repositoryPath));
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
