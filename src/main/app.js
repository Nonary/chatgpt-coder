const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { ChatGPTView, recoverUnconfirmedSubmissions } = require('./chatgpt-view');
const { GitService } = require('./git-service');
const { ResultService } = require('./result-service');
const { SkillService } = require('./skill-service');
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
let skillService;
let worktreeService;
let chatGPTView;

function emit(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('task:event', payload);
}

function publicTask(task) {
  return task;
}

function taskTitle(task) {
  const firstLine = String(task.taskText || 'this task').split('\n')[0].trim();
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

function buildConflictResolutionTaskText(task, conflict, additionalInstructions = '') {
  const base = `Resolve the failed Patchwork result application described below. Inspect the current coding tree, including any conflict markers, and the original result patch in CONFLICTS.md. Preserve the intended changes from both the original task and the returned result, then complete the work and verify the final diff.\n\nOriginal task:\n${task.taskText}\n\nApply failure:\n${conflict.error || task.error || 'The result could not be applied cleanly.'}`;
  const extra = String(additionalInstructions || '').replaceAll('\r\n', '\n').trim().slice(0, 12_000);
  return extra ? `${base}\n\nAdditional instructions from the user:\n${extra}` : base;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    show: false,
    width: 1320,
    height: 900,
    minWidth: 960,
    minHeight: 680,
    title: 'ChatGPT - Coder',
    backgroundColor: '#111310',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

async function loadMainWindow() {
  await mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (!HEADLESS) mainWindow.show();
}

async function attachChatGPTView() {
  const [storedTasks, trees] = await Promise.all([taskService.listTasks(), worktreeService.list()]);
  const tasks = await recoverUnconfirmedSubmissions(taskService, storedTasks);
  chatGPTView = new ChatGPTView(
    mainWindow,
    taskService,
    (taskId, downloadedPath) => resultService.ingestTextFile(taskId, downloadedPath),
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

  ipcMain.handle('projects:list', async () => chatGPTView.listProjects());
  ipcMain.handle('projects:create', async (_event, name) => chatGPTView.createProject(name));
  ipcMain.handle('skills:list', async (_event, repositoryPaths) => {
    const skills = await skillService.discover(Array.isArray(repositoryPaths) ? repositoryPaths : []);
    return skills.map(({ sourcePath, skillFile, ...skill }) => skill);
  });

  ipcMain.handle('attachments:choose', async () => {
    const response = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose task attachments',
      properties: ['openFile', 'multiSelections'],
    });
    if (response.canceled) return [];
    return response.filePaths.map((filePath) => ({
      name: path.basename(filePath),
      path: filePath,
    }));
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
  ipcMain.handle('trees:merge', async (_event, treeId, chatgptProject) => {
    try {
      if (chatgptProject !== undefined) {
        await worktreeService.setChatGPTProject(treeId, chatgptProject);
      }
      const request = await worktreeService.buildMergeRequest(treeId);
      await chatGPTView.submitMerge(request);
      return worktreeService.list();
    } catch (error) {
      await worktreeService.markMergeFailed(treeId, error).catch(() => {});
      throw error;
    }
  });
  ipcMain.handle('trees:resolve-merge', async (_event, treeId) => {
    const tree = await worktreeService.get(treeId);
    if (tree.mergeState !== 'failed') throw new Error('This coding tree does not have a failed merge to resolve.');
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Resolve merge with ChatGPT?',
      message: `Ask ChatGPT to resolve the failed merge for “${tree.name}”?`,
      detail: 'Patchwork will send the coding tree as the writable repository and a read-only snapshot of the original checkout, including its local changes.',
      buttons: ['Cancel', 'Submit resolution task'],
      defaultId: 1,
      cancelId: 0,
    });
    if (confirmation.response !== 1) return null;
    const taskText = `Resolve the failed coding-tree merge described below. Use the read-only original-checkout snapshot to understand the target state and local changes. Make every required resolution in the writable coding-tree repository only, preserve both sides' intended changes, and verify the result.\n\nMerge failure:\n${tree.mergeError || 'The coding tree could not be merged.'}`;
    const task = await taskService.createTask({
      taskText,
      repositories: [
        { path: tree.path },
        { path: tree.repositoryPath, readOnly: true },
      ],
      tree,
      chatgptProject: tree.chatgptProject || null,
      autoApply: true,
      mergeResolution: true,
    });
    await worktreeService.attachTask(tree.id, task.taskId);
    emit({ type: 'task-prepared', task: publicTask(task) });
    await chatGPTView.prepare(task);
    return publicTask(await chatGPTView.submit(task));
  });

  ipcMain.handle('task:create', async (_event, input) => {
    if (!String(input.taskText || '').trim()) {
      throw new Error('Describe the software task before creating a task package.');
    }
    let tree = null;
    let skillRepositoryPaths = Array.isArray(input.repositories)
      ? input.repositories.map((item) => item.path)
      : [];
    if (input.treeId) {
      tree = await worktreeService.get(input.treeId);
      const inspected = await worktreeService.inspect(tree);
      if (!inspected.available) throw new Error(inspected.error);
      if (!inspected.clean) throw new Error('Commit or discard local coding-tree changes before starting a follow-up task.');
      skillRepositoryPaths = [tree.path];
    } else if (input.createTree) {
      if (!Array.isArray(input.repositories) || input.repositories.length !== 1) {
        throw new Error('Choose exactly one repository when creating a coding tree.');
      }
      await skillService.resolveSelectedSkillIds(input.skillIds, skillRepositoryPaths);
      const suggestedName = String(input.treeName || input.taskText || '').split('\n')[0].trim();
      tree = await worktreeService.create(input.repositories[0].path, suggestedName);
    }
    if (!input.createTree) await skillService.resolveSelectedSkillIds(input.skillIds, skillRepositoryPaths);
    const task = await taskService.createTask({
      ...input,
      skillRepositoryPaths,
      repositories: tree ? [{ path: tree.path }] : input.repositories,
      tree,
      autoApply: true,
    });
    if (tree) {
      const hasChatGPTProject = Object.prototype.hasOwnProperty.call(input, 'chatgptProject');
      await worktreeService.attachTask(
        tree.id,
        task.taskId,
        hasChatGPTProject ? input.chatgptProject : undefined,
      );
    }
    emit({ type: 'task-prepared', task: publicTask(task) });
    await chatGPTView.prepare(task);
    return publicTask(task);
  });

  ipcMain.handle('task:list', async () => (await taskService.listTasks()).map(publicTask));
  ipcMain.handle('task:get', async (_event, taskId) => publicTask(await taskService.getTask(taskId)));
  ipcMain.handle('task:delete', async (_event, taskId) => {
    const task = await taskService.getTask(taskId);
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Delete task history?',
      message: `Remove “${taskTitle(task)}” from task history?`,
      detail: task.state === 'submitted'
        ? 'This only removes the saved task history. Patchwork will stop tracking the running task, but it will not cancel ChatGPT.'
        : 'This removes the saved task history and task package. It does not change the coding tree.',
      buttons: ['Cancel', 'Delete task'],
      defaultId: 0,
      cancelId: 0,
    });
    if (confirmation.response !== 1) return false;
    chatGPTView.forgetTask(task.taskId);
    await taskService.deleteTask(task.taskId);
    emit({ type: 'task-deleted', taskId: task.taskId });
    return true;
  });
  ipcMain.handle('task:open', async (_event, taskId) => {
    const task = await taskService.getTask(taskId);
    if (task.conversationUrl) await chatGPTView.openTaskConversation(task);
    return publicTask(task);
  });
  ipcMain.handle('task:submit', async (_event, taskId) => {
    const task = await taskService.getTask(taskId);
    return publicTask(await chatGPTView.submit(task));
  });
  ipcMain.handle('task:resolve-conflict', async (_event, taskId, options = {}) => {
    const task = await taskService.getTask(taskId);
    if (task.state !== 'conflicted' || !task.result?.patches?.length) {
      throw new Error('This task does not have a result conflict to resolve.');
    }
    let tree = null;
    if (task.treeId) tree = await worktreeService.get(task.treeId).catch(() => null);
    if (!tree) tree = await worktreeService.findForTask(task);
    const repositories = tree
      ? [{ path: tree.path }]
      : task.repositories.filter((repository) => !repository.readOnly).map((repository) => ({ path: repository.path }));
    if (repositories.length === 0) throw new Error('This conflicted task has no writable repository to resolve.');
    const conflict = task.result.conflicts?.[0] || {};
    const resolutionOptions = options && typeof options === 'object' ? options : {};
    const resolutionTask = await taskService.createTask({
      taskText: buildConflictResolutionTaskText(task, conflict, resolutionOptions.additionalInstructions),
      repositories,
      attachments: task.attachments || [],
      tree,
      autoApply: true,
      model: Object.prototype.hasOwnProperty.call(resolutionOptions, 'model') ? resolutionOptions.model : task.model,
      reasoningMode: task.reasoningMode,
      resolvesTaskId: task.taskId,
      conflictContext: {
        originalTaskId: task.taskId,
        error: conflict.error || task.error,
        files: conflict.files || [],
        patches: task.result.patches,
      },
    });
    if (tree) await worktreeService.attachTask(tree.id, resolutionTask.taskId);
    emit({ type: 'task-prepared', task: publicTask(resolutionTask) });
    await chatGPTView.prepare(resolutionTask);
    return publicTask(await chatGPTView.submit(resolutionTask));
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
  const dataRoot = path.join(app.getPath('userData'), 'patchwork');
  skillService = new SkillService();
  taskService = new TaskService(dataRoot, skillService);
  await taskService.initialize();
  gitService = new GitService(dataRoot);
  await gitService.initialize();
  worktreeService = new WorktreeService(
    dataRoot,
    emit,
    () => gitService.listRepositories(),
  );
  await worktreeService.initialize();
  resultService = new ResultService(taskService, async (event) => {
    if (event.type === 'task-applied' && event.task?.mergeResolution && event.task.treeId
      && event.task.result?.commits?.length) {
      const sourceContext = event.task.repositories.find((repository) => repository.readOnly);
      await worktreeService.clearMergeFailure(
        event.task.treeId,
        sourceContext?.snapshotFingerprint || null,
      );
      emit(event);
      try {
        const request = await worktreeService.buildMergeRequest(event.task.treeId);
        await chatGPTView.submitMerge(request);
      } catch (error) {
        await worktreeService.markMergeFailed(event.task.treeId, error).catch(() => {});
        emit({ type: 'merge-failed', treeId: event.task.treeId, message: error.message });
      }
      return;
    }
    emit(event);
  });
  createMainWindow();
  await attachChatGPTView();
  registerIpc();
  await loadMainWindow();

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow();
      attachChatGPTView()
        .then(loadMainWindow)
        .catch((error) => emit({ type: 'task-failed', message: error.message }));
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (error) => {
  emit({ type: 'task-failed', message: error.message });
});
