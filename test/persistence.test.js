const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  TASK_SUBMISSION_SCHEMA_VERSION,
  TaskService,
} = require('../src/main/task-service');
const {
  WORKTREE_STORE_SCHEMA_VERSION,
  WorktreeService,
} = require('../src/main/worktree-service');

async function temporaryRoot(prefix, context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
}

test('legacy task records migrate submission metadata on read and retain legacy fields', async (context) => {
  const root = await temporaryRoot('patchwork-task-migration-', context);
  const taskId = 'legacy-task';
  const taskPath = path.join(root, 'tasks', taskId, 'task.json');
  const legacy = {
    taskId,
    createdAt: '2026-08-16T12:00:00.000Z',
    taskText: 'Keep this task intact.',
    state: 'submitted',
    submittedAt: ' 2026-08-16T12:01:00.000Z ',
    conversationUrl: ' https://chatgpt.com/c/example ',
    conversationId: ' conversation-id ',
    conversationTitle: ' Legacy title ',
    chatStatus: 'streaming',
    chatStatusRaw: ' IS_STREAMING ',
    chatFinishedAt: null,
    customLegacyField: { retained: true },
  };
  await writeJson(taskPath, legacy);

  const service = new TaskService(root);
  const task = await service.getTask(taskId);

  assert.equal(task.submission.schemaVersion, TASK_SUBMISSION_SCHEMA_VERSION);
  assert.equal(task.submission.conversationUrl, 'https://chatgpt.com/c/example');
  assert.equal(task.conversationUrl, task.submission.conversationUrl);
  assert.equal(task.conversationId, 'conversation-id');
  assert.equal(task.conversationTitle, 'Legacy title');
  assert.equal(task.chatStatusRaw, 'IS_STREAMING');
  assert.deepEqual(task.customLegacyField, { retained: true });

  const persisted = JSON.parse(await fs.readFile(taskPath, 'utf8'));
  assert.equal(persisted.submission.schemaVersion, TASK_SUBMISSION_SCHEMA_VERSION);
  assert.equal(persisted.submission.conversationId, 'conversation-id');
  assert.equal(persisted.conversationId, 'conversation-id');
  assert.deepEqual(persisted.customLegacyField, { retained: true });
  assert.deepEqual(await fs.readdir(path.dirname(taskPath)), ['task.json']);
});

test('task submission metadata round-trips and legacy update fields stay synchronized', async (context) => {
  const root = await temporaryRoot('patchwork-task-round-trip-', context);
  const service = new TaskService(root);
  await service.initialize();
  const taskId = 'round-trip-task';
  const created = await service.saveTask({
    taskId,
    createdAt: '2026-08-16T12:00:00.000Z',
    state: 'prepared',
    taskText: 'Round-trip metadata.',
    submission: {
      schemaVersion: TASK_SUBMISSION_SCHEMA_VERSION,
      conversationId: 'old-id',
      conversationUrl: 'https://chatgpt.com/c/old-id',
      conversationTitle: 'Old title',
      chatStatus: 'streaming',
      chatStatusRaw: 'IS_STREAMING',
    },
    customField: 'keep me',
  });
  const updated = await service.updateTask(taskId, {
    state: 'submitted',
    conversationId: 'new-id',
    conversationUrl: 'https://chatgpt.com/c/new-id',
    chatStatus: 'completed',
    chatFinishedAt: '2026-08-16T12:02:00.000Z',
  });
  const reloaded = await new TaskService(root).getTask(taskId);

  assert.equal(created.submission.conversationId, 'old-id');
  assert.equal(updated.submission.conversationId, 'new-id');
  assert.equal(updated.conversationId, 'new-id');
  assert.equal(updated.submission.chatStatus, 'completed');
  assert.equal(updated.chatFinishedAt, '2026-08-16T12:02:00.000Z');
  assert.equal(reloaded.submission.conversationUrl, 'https://chatgpt.com/c/new-id');
  assert.equal(reloaded.submission.conversationTitle, 'Old title');
  assert.equal(reloaded.customField, 'keep me');
});

test('task atomic persistence leaves no temporary file after a write failure', async (context) => {
  const root = await temporaryRoot('patchwork-task-atomic-', context);
  const service = new TaskService(root);
  const taskId = 'atomic-task';
  const taskDir = path.join(root, 'tasks', taskId);
  await fs.mkdir(path.join(taskDir, 'task.json'), { recursive: true });

  await assert.rejects(() => service.saveTask({ taskId, state: 'prepared' }));
  assert.deepEqual((await fs.readdir(taskDir)).sort(), ['task.json']);
});

test('legacy worktree stores migrate to a versioned normalized store', async (context) => {
  const root = await temporaryRoot('patchwork-worktree-migration-', context);
  const service = new WorktreeService(root);
  await fs.mkdir(root, { recursive: true });
  await writeJson(path.join(root, 'worktrees.json'), {
    customStoreField: 'retained',
    worktrees: [{
      id: 'tree-1',
      name: '  Existing tree  ',
      path: '/tmp/tree-1',
      taskIds: ['task-1', 'task-1', ''],
      customLegacyField: 'retained',
    }],
  });

  const records = await service.readRecords();
  const persisted = JSON.parse(await fs.readFile(path.join(root, 'worktrees.json'), 'utf8'));

  assert.equal(persisted.schemaVersion, WORKTREE_STORE_SCHEMA_VERSION);
  assert.equal(persisted.customStoreField, 'retained');
  assert.equal(records[0].name, 'Existing tree');
  assert.deepEqual(records[0].taskIds, ['task-1']);
  assert.equal(records[0].managed, true);
  assert.equal(records[0].discovered, false);
  assert.equal(records[0].customLegacyField, 'retained');
  assert.equal(persisted.worktrees[0].chatgptProject, null);
});

test('worktree records round-trip through atomic versioned writes', async (context) => {
  const root = await temporaryRoot('patchwork-worktree-round-trip-', context);
  const service = new WorktreeService(root);
  const input = [{
    id: 'tree-2',
    name: 'Tree',
    path: '/tmp/tree-2',
    taskIds: ['task-2'],
    managed: false,
    discovered: true,
    customField: { retained: true },
  }];

  await service.writeRecords(input);
  const records = await service.readRecords();
  assert.deepEqual(records[0].customField, { retained: true });
  assert.equal(records[0].managed, false);
  assert.equal(records[0].discovered, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'worktrees.json'), 'utf8')).schemaVersion, WORKTREE_STORE_SCHEMA_VERSION);
  assert.deepEqual((await fs.readdir(root)).sort(), ['merge-workspaces', 'worktrees', 'worktrees.json']);
});

test('worktree atomic persistence cleans up its temporary file after a write failure', async (context) => {
  const root = await temporaryRoot('patchwork-worktree-atomic-', context);
  const service = new WorktreeService(root);
  await fs.mkdir(path.join(root, 'worktrees.json'), { recursive: true });

  await assert.rejects(() => service.writeRecords([]));
  assert.deepEqual((await fs.readdir(root)).sort(), ['worktrees.json']);
});
