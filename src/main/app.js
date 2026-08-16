const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { ChatGPTView } = require('./chatgpt-view');
const { GitService } = require('./git-service');
const { ResultService } = require('./result-service');
const { TaskService } = require('./task-service');
const { WorktreeService } = require('./worktree-service');

const HEADLESS = process.env.PATCHWORK_HEADLESS === '1';
if (process.env.PATCHWORK_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.PATCHWORK_DEBUG_PORT);
}
if (process.env.PATCHWORK_USER_DATA) app.setPath('userData', process.env.PATCHWORK_USER_DATA);

let mainWindow;
let taskService;
let gitService;
let resultService;
let worktreeService;
let chatGPTView;

function emit(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('task:event', payload);
}

function publicTask(task) {
  return task;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    show: !HEADLESS,
    width: 1320,
    height: 900,
    minWidth: 960,
    minHeight: 680,
    title: 'Patchwork IDE',
    backgroundColor: '#111310',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

async function attachChatGPTView() {
  const [tasks, trees] = await Promise.all([taskService.listTasks(), worktreeService.list()]);
  chatGPTView = new ChatGPTView(
    mainWindow,
    taskService,
    (taskId, result, transport) => (
      transport === 'text' ? resultService.ingestText(taskId, result) : resultService.ingest(taskId, result)
    ),
    emit,
    tasks,
    worktreeService,
    (treeId, resultText) => worktreeService.mergeFromText(treeId, resultText),
    trees,
  );
}

function registerIpc() {
  ipcMain.handle('repositories:choose', async () => {
    const response = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a Git repository',
      properties: ['openDirectory'],
    });
    if (response.canceled) return [];
    return gitService.addRepositories(response.filePaths);
  });

  ipcMain.handle('workspace:list', async () => gitService.listRepositories());
  ipcMain.handle('workspace:remove', async (_event, repositoryPath) => gitService.removeRepository(repositoryPath));
  ipcMain.handle('git:status', async (_event, repositoryPath) => gitService.status(repositoryPath));
  ipcMain.handle('git:stage', async (_event, repositoryPath, files) => gitService.stage(repositoryPath, files));
  ipcMain.handle('git:stage-all', async (_event, repositoryPath) => gitService.stageAll(repositoryPath));
  ipcMain.handle('git:unstage', async (_event, repositoryPath, files) => gitService.unstage(repositoryPath, files));
  ipcMain.handle('git:unstage-all', async (_event, repositoryPath) => gitService.unstageAll(repositoryPath));
  ipcMain.handle('git:commit', async (_event, repositoryPath, message) => gitService.commit(repositoryPath, message));
  ipcMain.handle('git:diff', async (_event, repositoryPath, filePath, staged) => (
    gitService.diff(repositoryPath, filePath, staged)
  ));

  ipcMain.handle('trees:list', async () => worktreeService.list());
  ipcMain.handle('trees:reveal', async (_event, treeId) => {
    const tree = await worktreeService.get(treeId);
    shell.showItemInFolder(tree.path);
    return true;
  });
  ipcMain.handle('trees:remove', async (_event, treeId) => {
    const tree = await worktreeService.get(treeId);
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Discard coding tree?',
      message: `Discard “${tree.name}” and all commits that have not been merged?`,
      detail: 'This removes the worktree and its Patchwork branch. This action cannot be undone from Patchwork.',
      buttons: ['Cancel', 'Discard tree'],
      defaultId: 0,
      cancelId: 0,
    });
    if (confirmation.response !== 1) return worktreeService.list();
    return worktreeService.remove(treeId, true);
  });
  ipcMain.handle('trees:merge', async (_event, treeId) => {
    const request = await worktreeService.buildMergeRequest(treeId);
    await chatGPTView.submitMerge(request);
    return worktreeService.list();
  });

  ipcMain.handle('task:create', async (_event, input) => {
    if (!String(input.taskText || '').trim()) {
      throw new Error('Describe the software task before creating a coding tree.');
    }
    let tree;
    if (input.treeId) {
      tree = await worktreeService.get(input.treeId);
      const inspected = await worktreeService.inspect(tree);
      if (!inspected.available) throw new Error(inspected.error);
      if (!inspected.clean) throw new Error('Commit or discard local coding-tree changes before starting a follow-up task.');
    } else {
      if (!Array.isArray(input.repositories) || input.repositories.length !== 1) {
        throw new Error('Choose exactly one repository when creating a coding tree.');
      }
      const suggestedName = String(input.treeName || input.taskText || '').split('\n')[0].trim();
      tree = await worktreeService.create(input.repositories[0].path, suggestedName);
    }
    const task = await taskService.createTask({
      ...input,
      repositories: [{ path: tree.path }],
      tree,
      autoApply: true,
    });
    await worktreeService.attachTask(tree.id, task.taskId);
    emit({ type: 'task-prepared', task: publicTask(task) });
    await chatGPTView.prepare(task);
    return publicTask(task);
  });

  ipcMain.handle('task:list', async () => (await taskService.listTasks()).map(publicTask));
  ipcMain.handle('task:get', async (_event, taskId) => publicTask(await taskService.getTask(taskId)));
  ipcMain.handle('task:submit', async (_event, taskId) => {
    const task = await taskService.getTask(taskId);
    return publicTask(await chatGPTView.submit(task));
  });
  ipcMain.handle('task:copy-prompt', async (_event, taskId) => {
    const task = await taskService.getTask(taskId);
    chatGPTView.copyPrompt(task);
    return true;
  });
  ipcMain.handle('task:reveal-package', async (_event, taskId) => {
    const task = await taskService.getTask(taskId);
    chatGPTView.revealPackage(task);
    return true;
  });
  ipcMain.handle('task:import-result', async (_event, taskId) => {
    const task = await taskService.getTask(taskId);
    return publicTask(await chatGPTView.importResult(task));
  });
  ipcMain.handle('browser:set-bounds', async (_event, bounds) => chatGPTView.setBounds(bounds));
  ipcMain.handle('browser:set-visible', async (_event, visible) => chatGPTView.setVisible(visible));
  ipcMain.handle('browser:new-chat', async () => chatGPTView.newChat());
  ipcMain.handle('browser:reload', async () => chatGPTView.reload());
  ipcMain.handle('browser:back', async () => chatGPTView.goBack());
  ipcMain.handle('browser:forward', async () => chatGPTView.goForward());
  ipcMain.handle('task:apply', async (_event, taskId) => publicTask(await resultService.apply(taskId)));
  ipcMain.handle('task:rollback', async (_event, taskId) => publicTask(await resultService.rollback(taskId)));
  ipcMain.handle('path:reveal', async (_event, targetPath) => {
    shell.showItemInFolder(targetPath);
    return true;
  });
}

app.whenReady().then(async () => {
  taskService = new TaskService(path.join(app.getPath('userData'), 'patchwork'));
  await taskService.initialize();
  gitService = new GitService(path.join(app.getPath('userData'), 'patchwork'));
  await gitService.initialize();
  worktreeService = new WorktreeService(path.join(app.getPath('userData'), 'patchwork'), emit);
  await worktreeService.initialize();
  resultService = new ResultService(taskService, emit);
  createMainWindow();
  await attachChatGPTView();
  registerIpc();

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow();
      attachChatGPTView().catch((error) => emit({ type: 'task-failed', message: error.message }));
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (error) => {
  emit({ type: 'task-failed', message: error.message });
});
