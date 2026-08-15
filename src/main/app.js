const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { ChatGPTView } = require('./chatgpt-view');
const { GitService } = require('./git-service');
const { ResultService } = require('./result-service');
const { TaskService } = require('./task-service');

let mainWindow;
let taskService;
let gitService;
let resultService;
let chatGPTView;

function emit(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('task:event', payload);
}

function publicTask(task) {
  return task;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
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

function attachChatGPTView() {
  chatGPTView = new ChatGPTView(
    mainWindow,
    taskService,
    (taskId, resultPath) => resultService.ingest(taskId, resultPath),
    emit,
  );
}

function registerIpc() {
  ipcMain.handle('repositories:choose', async () => {
    const response = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Git repositories',
      properties: ['openDirectory', 'multiSelections'],
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

  ipcMain.handle('task:create', async (_event, input) => {
    const task = await taskService.createTask(input);
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
  resultService = new ResultService(taskService, emit);
  createMainWindow();
  attachChatGPTView();
  registerIpc();

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow();
      attachChatGPTView();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (error) => {
  emit({ type: 'task-failed', message: error.message });
});
