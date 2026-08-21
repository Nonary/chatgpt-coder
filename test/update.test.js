const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { buildRestartArguments } = require('../src/agent/cli');
const { runGit } = require('../src/agent/services/git');
const { UpdateService, parseRevisionCounts } = require('../src/agent/services/update-service');
const { Api } = require('../src/userscript/src/api');

async function configureAuthor(repositoryPath) {
  await runGit(repositoryPath, ['config', 'user.email', 'patchwork@example.invalid']);
  await runGit(repositoryPath, ['config', 'user.name', 'Patchwork Test']);
  await runGit(repositoryPath, ['config', 'core.autocrlf', 'false']);
}

async function createUpdateRepositories(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-update-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  const author = path.join(root, 'author');
  await fs.mkdir(remote, { recursive: true });
  await fs.mkdir(local, { recursive: true });
  await runGit(remote, ['init', '--bare']);
  await runGit(local, ['init', '-b', 'main']);
  await configureAuthor(local);
  await fs.writeFile(path.join(local, 'package.json'), '{"name":"update-test","version":"1.0.0"}\n');
  await fs.writeFile(path.join(local, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  await fs.writeFile(path.join(local, 'app.txt'), 'first\n');
  await runGit(local, ['add', '.']);
  await runGit(local, ['commit', '-m', 'Initial version']);
  await runGit(local, ['remote', 'add', 'origin', remote]);
  await runGit(local, ['push', '-u', 'origin', 'main']);
  await runGit(root, ['clone', '-b', 'main', remote, author]);
  await configureAuthor(author);
  return { author, local };
}

test('revision counts map Git left/right output to ahead and behind', () => {
  assert.deepEqual(parseRevisionCounts('2\t7\n'), { ahead: 2, behind: 7 });
});

test('the updater detects its upstream, fast-forwards, installs changed dependencies, and builds', async (context) => {
  const { author, local } = await createUpdateRepositories(context);
  const commands = [];
  const updater = new UpdateService({
    projectRoot: local,
    runPackageManager: async (_root, args) => { commands.push(args); },
  });
  await updater.initialize();
  const oldRevision = updater.runningRevision;

  await fs.writeFile(path.join(author, 'package.json'), '{"name":"update-test","version":"1.1.0"}\n');
  await runGit(author, ['add', 'package.json']);
  await runGit(author, ['commit', '-m', 'Release update']);
  await runGit(author, ['push', 'origin', 'main']);

  const status = await updater.status();
  assert.equal(status.supported, true);
  assert.equal(status.upstream, 'origin/main');
  assert.equal(status.remote, 'origin');
  assert.equal(status.ahead, 0);
  assert.equal(status.behind, 1);
  assert.equal(status.updateAvailable, true);
  assert.equal(status.canUpdate, true);

  const result = await updater.applyUpdate();
  assert.notEqual(result.revision, oldRevision);
  assert.equal(result.dependenciesChanged, true);
  assert.deepEqual(commands, [
    ['install', '--frozen-lockfile'],
    ['build'],
  ]);
  assert.equal((await runGit(local, ['rev-parse', 'HEAD'])).stdout.trim(), result.revision);
});

test('the updater refuses to replace a checkout with local changes', async (context) => {
  const { author, local } = await createUpdateRepositories(context);
  const updater = new UpdateService({
    projectRoot: local,
    runPackageManager: async () => { throw new Error('build should not run'); },
  });
  await updater.initialize();
  await fs.writeFile(path.join(author, 'app.txt'), 'second\n');
  await runGit(author, ['add', 'app.txt']);
  await runGit(author, ['commit', '-m', 'New application']);
  await runGit(author, ['push', 'origin', 'main']);
  await fs.writeFile(path.join(local, 'local-note.txt'), 'do not overwrite\n');

  const status = await updater.status();
  assert.equal(status.updateAvailable, true);
  assert.equal(status.dirty, true);
  assert.equal(status.canUpdate, false);
  assert.match(status.reason, /local changes/i);
  await assert.rejects(() => updater.applyUpdate(), /local changes/i);
  assert.equal(await fs.readFile(path.join(local, 'local-note.txt'), 'utf8'), 'do not overwrite\n');
});

test('a pending restart can rebuild dirty local source when no pull is needed', async (context) => {
  const { local } = await createUpdateRepositories(context);
  const commands = [];
  const updater = new UpdateService({
    projectRoot: local,
    runPackageManager: async (_root, args) => { commands.push(args); },
  });
  await updater.initialize();
  await fs.writeFile(path.join(local, 'app.txt'), 'second\n');
  await runGit(local, ['add', 'app.txt']);
  await runGit(local, ['commit', '-m', 'New local revision']);
  await fs.writeFile(path.join(local, 'local-note.txt'), 'keep this change\n');

  const status = await updater.status();
  assert.equal(status.behind, 0);
  assert.equal(status.restartPending, true);
  assert.equal(status.dirty, true);
  assert.equal(status.canUpdate, true, 'no Git mutation is needed, so dirty source can be rebuilt');
  const result = await updater.applyUpdate({ rebuild: true });
  assert.equal(result.rebuilt, true);
  assert.deepEqual(commands, [['build']]);
  assert.equal(await fs.readFile(path.join(local, 'local-note.txt'), 'utf8'), 'keep this change\n');
});

test('an up-to-date checkout can be rebuilt and restarted manually', async (context) => {
  const { local } = await createUpdateRepositories(context);
  const commands = [];
  const updater = new UpdateService({
    projectRoot: local,
    runPackageManager: async (_root, args) => { commands.push(args); },
  });
  await updater.initialize();
  assert.equal((await updater.status()).updateAvailable, false);
  const result = await updater.applyUpdate({ rebuild: true });
  assert.equal(result.revision, updater.runningRevision);
  assert.deepEqual(commands, [['build']]);
});

test('restart arguments preserve ordinary flags while pinning the live agent settings', () => {
  assert.deepEqual(buildRestartArguments([
    'D:/sources/chatgpt-coder/src/agent/cli.js',
    '--port', '8787',
    '--home', 'C:/old-home',
    '--unknown', 'kept',
  ], {
    port: 9123,
    dataRoot: 'C:/Patchwork Data',
    iacSettingsPath: 'C:/Patchwork Data/settings.json',
  }), [
    'D:/sources/chatgpt-coder/src/agent/cli.js',
    '--unknown', 'kept',
    '--port', '9123',
    '--home', 'C:/Patchwork Data',
    '--iac-settings', 'C:/Patchwork Data/settings.json',
  ]);
});

test('the userscript API exposes update status, apply, and revision health calls', async () => {
  const calls = [];
  const api = new Api({
    request: async (request) => {
      calls.push(request);
      return { status: 200, text: '{}' };
    },
  });
  await api.health();
  await api.updateStatus();
  await api.applyUpdate({ rebuild: true });
  assert.deepEqual(calls.map(({ method, path, timeout }) => ({ method, path, timeout })), [
    { method: 'GET', path: '/health', timeout: 3_000 },
    { method: 'GET', path: '/v1/update', timeout: 60_000 },
    { method: 'POST', path: '/v1/update', timeout: 600_000 },
  ]);
  assert.deepEqual(calls.at(-1).body, { rebuild: true });
});

test('the dock always exposes a manual update control and rebuild action', async () => {
  const shellSource = await fs.readFile(
    path.join(__dirname, '..', 'src', 'userscript', 'src', 'ui', 'shell.js'),
    'utf8',
  );
  const appSource = await fs.readFile(
    path.join(__dirname, '..', 'src', 'userscript', 'src', 'app.js'),
    'utf8',
  );
  assert.match(shellSource, /title: 'Check for Patchwork updates'/);
  assert.match(shellSource, /class: 'icon-button update-button'/);
  assert.match(appSource, /actionLabel: 'Rebuild and restart'/);
  assert.match(appSource, /checkForUpdate\(\{ announce: true, manual: true \}\)/);
});
