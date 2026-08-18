const path = require('node:path');
const fs = require('node:fs/promises');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { PatchworkAIChatController, recoverUnconfirmedSubmissions } = require('./chatgpt-view');
const { GitService } = require('./git-service');
const { ResultService } = require('./result-service');
const { SkillService } = require('./skill-service');
const { resolveGitSummaryPrompt, TaskService } = require('./task-service');
const { validateCommitMessage, WorktreeService } = require('./worktree-service');

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
let chatController;

function emit(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('task:event', payload);
}

function publicTask(task) {
  return task;
}

function taskTitle(task) {
  if (task.summaryOnly) {
    const repositoryName = task.repositories?.[0]?.name;
    return repositoryName ? `Git Summary · ${repositoryName}` : 'Git Summary';
  }
  const firstLine = String(task.taskText || 'this task').split('\n')[0].trim();
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

function buildConflictResolutionTaskText(task, conflict, additionalInstructions = '') {
  const base = `Resolve the failed Patchwork result application described below. Inspect the current coding tree, including any conflict markers, and the original result patch in CONFLICTS.md. Preserve the intended changes from both the original task and the returned result, then complete the work and verify the final diff.\n\nOriginal task:\n${task.taskText}\n\nApply failure:\n${conflict.error || task.error || 'The result could not be applied cleanly.'}`;
  const extra = String(additionalInstructions || '').replaceAll('\r\n', '\n').trim().slice(0, 12_000);
  return extra ? `${base}\n\nAdditional instructions from the user:\n${extra}` : base;
}

async function retryTaskApplication(task) {
  let current = task;
  if (current.conversationId || current.conversationUrl) {
    try {
      current = await chatController.refreshTaskResult(current);
      current = await taskService.getTask(current.taskId);
    } catch (error) {
      const savedTask = await taskService.getTask(current.taskId);
      if (savedTask.state !== 'conflicted' || !savedTask.result?.patches?.length) throw error;
      current = savedTask;
    }
  }
  if (current.state === 'ready') {
    return resultService.apply(current.taskId);
  }
  if (current.state === 'conflicted') {
    return resultService.apply(current.taskId);
  }
  return current;
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

async function attachChatController() {
  const [storedTasks, trees] = await Promise.all([taskService.listTasks(), worktreeService.list()]);
  const tasks = await recoverUnconfirmedSubmissions(taskService, storedTasks);
  chatController = new PatchworkAIChatController(
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

  ipcMain.handle('projects:list', async () => chatController.listProjects());
  ipcMain.handle('projects:create', async (_event, name) => chatController.createProject(name));
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
  ipcMain.handle('git:summary', async (_event, repositoryPath, customPrompt) => {
    const status = await gitService.status(repositoryPath);
    if (status.changes.length === 0) throw new Error('There are no uncommitted changes to summarize.');

    const suspendedTaskId = chatController.activeTask?.taskId || null;
    const suspendedMergeId = chatController.activeMerge?.id || null;
    const prompt = resolveGitSummaryPrompt(customPrompt);
    const task = await taskService.createTask({
      taskText: prompt,
      repositories: [{ path: status.repository.path }],
      model: 'luna',
      reasoningMode: 'medium',
      autoApply: false,
      summaryOnly: true,
    });
    const usedCustomPrompt = String(customPrompt || '').trim().length > 0;
    emit({ type: 'task-prepared', task: publicTask(task) });
    emit({
      type: 'git-summary-started',
      repositoryPath: status.repository.path,
      message: `Packaging ${status.changes.length} uncommitted change${status.changes.length === 1 ? '' : 's'} for Git Summary…`,
    });
    try {
      await chatController.enqueue(() => chatController.prepare(task));
      const completed = await chatController.submitAndWaitForResult(task);
      const commitMessage = validateCommitMessage(completed?.result?.commitMessage);
      emit({
        type: 'git-summary-ready',
        task: publicTask(completed),
        repositoryPath: status.repository.path,
        commitMessage,
        message: 'AI generated a Conventional Commit message. Use it in Source Control when ready.',
      });
      return { taskId: task.taskId, commitMessage, usedCustomPrompt };
    } catch (error) {
      let failedTask = null;
      try {
        const currentTask = await taskService.getTask(task.taskId);
        failedTask = currentTask.state === 'failed'
          ? currentTask
          : await taskService.updateTask(task.taskId, { state: 'failed', error: error.message });
      } catch {
        // The task may have been explicitly deleted while the summary was running.
      }
      emit({
        type: 'git-summary-failed',
        task: failedTask ? publicTask(failedTask) : undefined,
        repositoryPath: status.repository.path,
        message: error.message,
      });
      throw error;
    } finally {
      chatController.forgetTask(task.taskId);

      const [suspendedTask, suspendedMerge] = await Promise.all([
        suspendedTaskId ? taskService.getTask(suspendedTaskId).catch(() => null) : null,
        suspendedMergeId ? worktreeService.get(suspendedMergeId).catch(() => null) : null,
      ]);
      await chatController.enqueue(
        () => chatController.restoreActiveContext(suspendedTask, suspendedMerge),
      ).catch(() => {});
    }
  });

  ipcMain.handle('task:use-git-summary', async (_event, taskId) => {
    const task = await taskService.getTask(taskId);
    if (!task.summaryOnly || !task.result?.commitMessage) {
      throw new Error('This task does not contain a Git Summary result.');
    }
    if (!['ready', 'completed'].includes(task.state)) {
      throw new Error('This Git Summary is not ready to use in Source Control.');
    }
    validateCommitMessage(task.result.commitMessage);
    const completed = task.state === 'completed'
      ? task
      : await taskService.updateTask(task.taskId, {
        state: 'completed',
        completedAt: new Date().toISOString(),
      });
    emit({
      type: 'git-summary-applied',
      task: publicTask(completed),
      repositoryPath: completed.sourceRepositoryPath || completed.repositories?.[0]?.path,
      commitMessage: completed.result.commitMessage,
      message: 'Git Summary moved to the Source Control commit editor.',
    });
    return publicTask(completed);
  });

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
      await chatController.enqueue(() => chatController.submitMerge(request));
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
    await chatController.enqueue(() => chatController.prepare(task));
    return publicTask(await chatController.enqueue(() => chatController.submit(task)));
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
    await chatController.enqueue(() => chatController.prepare(task));
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
    chatController.forgetTask(task.taskId);
    await taskService.deleteTask(task.taskId);
    emit({ type: 'task-deleted', taskId: task.taskId });
    return true;
  });
  ipcMain.handle('task:open', async (_event, taskId) => {
    chatController.setVisible(false);
    const task = await taskService.getTask(taskId);
    if (task.conversationId || task.conversationUrl) {
      await chatController.enqueue(() => chatController.openTaskConversation(task));
    }
    return publicTask(task);
  });
  ipcMain.handle('task:submit', async (_event, taskId) => {
    const task = await taskService.getTask(taskId);
    return publicTask(await chatController.enqueue(() => chatController.submit(task)));
  });
  ipcMain.handle('task:chat', async (_event, taskId) => {
    const task = await taskService.getTask(taskId);
    const snapshot = await chatController.enqueue(() => chatController.readTaskChat(task));
    return { task: publicTask(await taskService.getTask(taskId)), snapshot };
  });
  ipcMain.handle('task:chat-send', async (_event, taskId, text, configuration = {}) => {
    const task = await taskService.getTask(taskId);
    const result = await chatController.enqueue(() => chatController.sendTaskMessage(task, text, configuration));
    return { task: publicTask(result.task), snapshot: result.snapshot };
  });
  ipcMain.handle('task:chat-stop', async (_event, taskId) => {
    const task = await taskService.getTask(taskId);
    const result = await chatController.enqueue(() => chatController.stopTaskChat(task));
    return { task: publicTask(result.task), snapshot: result.snapshot };
  });
  ipcMain.handle('session:chat', async () => chatController.enqueue(() => chatController.readSessionChat()));
  ipcMain.handle('session:chat-send', async (_event, text, configuration = {}) => (
    chatController.enqueue(() => chatController.sendSessionMessage(text, configuration))
  ));
  ipcMain.handle('session:chat-stop', async () => chatController.enqueue(() => chatController.stopSessionChat()));
  ipcMain.handle('session:chat-new', async () => chatController.enqueue(() => chatController.newSessionChat()));
  ipcMain.handle('task:set-target', async (_event, taskId, input = {}) => {
    const task = await taskService.getTask(taskId);
    const writableRepositories = (Array.isArray(task.repositories) ? task.repositories : [])
      .filter((repository) => !repository.readOnly);
    if (['applied', 'rolled-back', 'resolved'].includes(task.state)) {
      throw new Error('This task can no longer change its apply target.');
    }
    if (writableRepositories.length !== 1) {
      throw new Error('Worktree selection is only available for tasks with one writable repository.');
    }

    const previousTreeId = task.treeId || null;
    const selection = input && typeof input === 'object' ? input : {};
    let tree = null;
    let repositoryPath = task.sourceRepositoryPath || writableRepositories[0].path;

    if (selection.createTree) {
      tree = await worktreeService.create(repositoryPath, selection.treeName);
      repositoryPath = tree.path;
    } else if (selection.treeId) {
      const candidate = await worktreeService.get(String(selection.treeId));
      tree = await worktreeService.inspect(candidate);
      if (!tree.available) throw new Error(tree.error || 'The selected coding tree is unavailable.');
      if (tree.mergeState === 'submitted') throw new Error('The selected coding tree is already being merged.');
      const sourcePath = task.sourceRepositoryPath || writableRepositories[0].path;
      const [expectedRoot, selectedRoot] = await Promise.all([
        fs.realpath(sourcePath).catch(() => path.resolve(sourcePath)),
        fs.realpath(tree.repositoryPath).catch(() => path.resolve(tree.repositoryPath)),
      ]);
      if (expectedRoot !== selectedRoot) {
        throw new Error('Choose a worktree from the same repository as this task.');
      }
      repositoryPath = tree.path;
    } else if (task.sourceRepositoryPath) {
      repositoryPath = task.sourceRepositoryPath;
    }

    const updated = await taskService.setTarget(taskId, { repositoryPath, tree });
    if (previousTreeId && previousTreeId !== tree?.id) {
      await worktreeService.detachTask(previousTreeId, taskId).catch(() => {});
    }
    if (tree) {
      await worktreeService.attachTask(tree.id, taskId);
    }
    emit({
      type: 'task-target-changed',
      task: publicTask(updated),
      message: tree ? `Task target changed to ${tree.name}.` : 'Task target changed to the original repository.',
    });
    return publicTask(updated);
  });
  ipcMain.handle('task:retry-apply', async (_event, taskId) => {
    const task = await taskService.getTask(taskId);
    if (task.state !== 'conflicted' || !task.result?.patches?.length) {
      throw new Error('This task does not have a result conflict to retry.');
    }
    return publicTask(await retryTaskApplication(task));
  });
  ipcMain.handle('task:resolve-conflict', async (_event, taskId, options = {}) => {
    let task = await taskService.getTask(taskId);
    if (task.state !== 'conflicted' || !task.result?.patches?.length) {
      throw new Error('This task does not have a result conflict to resolve.');
    }
    task = await retryTaskApplication(task);
    if (task.state === 'applied') return publicTask(task);
    if (task.state !== 'conflicted') {
      throw new Error('The result could not be retried before conflict resolution.');
    }
    let tree = null;
    if (task.treeId) {
      const candidate = await worktreeService.get(task.treeId).catch(() => null);
      if (candidate) {
        const inspected = await worktreeService.inspect(candidate);
        if (inspected.available) tree = inspected;
      }
    }
    if (!tree) tree = await worktreeService.findForTask(task);
    const writableRepositories = task.repositories
      .filter((repository) => !repository.readOnly)
      .map((repository) => ({ path: repository.path }));
    let repositories = tree
      ? [{ path: tree.path }]
      : writableRepositories;
    if (!tree && task.sourceRepositoryPath && writableRepositories.length === 1) {
      repositories = [{ path: task.sourceRepositoryPath }];
    }
    if (repositories.length === 0) throw new Error('This conflicted task has no writable repository to resolve.');
    const conflict = task.result.conflicts?.[0] || {};
    await resultService.prepareConflictResolution(task.taskId);
    const resolutionOptions = options && typeof options === 'object' ? options : {};
    const resolutionTask = await taskService.createTask({
      taskText: buildConflictResolutionTaskText(task, conflict, resolutionOptions.additionalInstructions),
      repositories,
      attachments: task.attachments || [],
      tree,
      autoApply: true,
      model: Object.prototype.hasOwnProperty.call(resolutionOptions, 'model') ? resolutionOptions.model : task.model,
      reasoningMode: Object.prototype.hasOwnProperty.call(resolutionOptions, 'reasoningMode')
        ? resolutionOptions.reasoningMode
        : task.reasoningMode,
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
    return chatController.enqueue(async () => {
      await chatController.prepare(resolutionTask);
      return publicTask(await chatController.submit(resolutionTask));
    });
  });
  ipcMain.handle('task:copy-prompt', async (_event, taskId) => {
    const task = await taskService.getTask(taskId);
    chatController.copyPrompt(task);
    return true;
  });
  ipcMain.handle('task:reveal-package', async (_event, taskId) => {
    const task = await taskService.getTask(taskId);
    chatController.revealPackage(task);
    return true;
  });
  ipcMain.handle('task:import-result', async (_event, taskId) => {
    const task = await taskService.getTask(taskId);
    return publicTask(await chatController.importResult(task));
  });
  ipcMain.handle('browser:set-bounds', async (_event, bounds) => chatController.setBounds(bounds));
  ipcMain.handle('browser:set-visible', async (_event, visible) => chatController.setVisible(visible));
  ipcMain.handle('browser:new-chat', async () => chatController.enqueue(() => chatController.newChat()));
  ipcMain.handle('browser:reload', async () => chatController.enqueue(() => chatController.reload()));
  ipcMain.handle('browser:back', async () => chatController.enqueue(() => chatController.goBack()));
  ipcMain.handle('browser:forward', async () => chatController.enqueue(() => chatController.goForward()));
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
        await chatController.enqueue(() => chatController.submitMerge(request));
      } catch (error) {
        await worktreeService.markMergeFailed(event.task.treeId, error).catch(() => {});
        emit({ type: 'merge-failed', treeId: event.task.treeId, message: error.message });
      }
      return;
    }
    emit(event);
  });
  createMainWindow();
  await attachChatController();
  registerIpc();
  await loadMainWindow();

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow();
      attachChatController()
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
