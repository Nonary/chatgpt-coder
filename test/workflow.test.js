const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const AdmZip = require('adm-zip');
const { runGit } = require('../src/main/git');
const { GitService, parsePorcelainStatus } = require('../src/main/git-service');
const { ResultService, safeArchivePath } = require('../src/main/result-service');
const { TaskService } = require('../src/main/task-service');

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

test('task packages contain instructions, a manifest, and a verified Git bundle', async (context) => {
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

  const zip = new AdmZip(task.packagePath);
  const entries = zip.getEntries().map((entry) => entry.entryName);
  assert.ok(entries.includes('AGENTS.md'));
  assert.ok(entries.includes('TASK.md'));
  assert.ok(entries.includes('manifest.json'));
  assert.ok(entries.includes(`repositories/${repository.id}.bundle`));
  const manifest = JSON.parse(zip.getEntry('manifest.json').getData().toString('utf8'));
  assert.equal(manifest.taskId, task.taskId);
  assert.equal(manifest.repositories[0].baseCommit, repository.baseCommit);
  assert.equal(JSON.stringify(manifest).includes(repositoryPath), false);
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
