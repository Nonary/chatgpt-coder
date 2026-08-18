const fsSync = require('node:fs');
const path = require('node:path');
const { WebContentsView, clipboard, dialog, shell } = require('electron');
const { mergeResultFilename } = require('./worktree-service');
const { AI_CHAT_ERROR_CODE, AI_CHAT_RUN_STATUS } = require('./ai-chat-service');
const { ChatGPTBrowserAIChatService } = require('./chatgpt-browser-ai-chat-service');
const { SerialOperationQueue } = require('./serial-operation-queue');

const CHATGPT_URL = 'https://chatgpt.com/';
const PARTITION = 'persist:patchwork-chatgpt';
const RESULT_NAME_PATTERN = /chatgpt-ide-result-([0-9a-f-]{36})(?:\s*\(\d+\))?\.txt/i;
const RESULT_RETRY_MILLISECONDS = 6_000;
const TASK_MONITOR_INTERVAL_MILLISECONDS = 15_000;
const NOTICE_EVENT_COOLDOWN_MILLISECONDS = 60_000;
const GIT_SUMMARY_RESULT_TIMEOUT_MILLISECONDS = 180_000;
const CHATGPT_CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resultTaskId(filename) {
  const basename = path.basename(String(filename || ''));
  return RESULT_NAME_PATTERN.exec(basename)?.[1]?.toLowerCase() || null;
}


function conversationIdFromRouteUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return null;
    const routeId = /^\/c\/([^/]+)\/?$/i.exec(url.pathname)?.[1]
      || /^\/g\/g-p-[A-Za-z0-9_-]+\/c\/([^/]+)\/?$/i.exec(url.pathname)?.[1]
      || null;
    if (!routeId || !CHATGPT_CONVERSATION_ID_PATTERN.test(routeId)) return null;
    return routeId;
  } catch {
    return null;
  }
}


const MERGE_RESULT_NAME_PATTERN = /chatgpt-ide-merge-result-([0-9a-f-]{36})(?:\s*\(\d+\))?\.txt/i;

function mergeTreeId(filename) {
  return MERGE_RESULT_NAME_PATTERN.exec(path.basename(String(filename || '')))?.[1]?.toLowerCase() || null;
}

function isChatGPTConversationUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && url.hostname === 'chatgpt.com'
      && (/^\/c\/[^/]+\/?$/.test(url.pathname)
        || /^\/g\/g-p-[A-Za-z0-9_-]+\/c\/[^/]+\/?$/.test(url.pathname));
  } catch {
    return false;
  }
}

function normalizeConversationTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  if (!title || /^(?:ChatGPT|New chat)$/i.test(title)) return '';
  return title;
}

async function recoverUnconfirmedSubmissions(taskService, tasks) {
  return Promise.all(tasks.map((task) => {
    if (task.state !== 'submitted' || CHATGPT_CONVERSATION_ID_PATTERN.test(task.conversationId || '')
      || isChatGPTConversationUrl(task.conversationUrl)) return task;
    return taskService.updateTask(task.taskId, {
      state: 'prepared',
      submittedAt: null,
      conversationUrl: null,
      conversationId: null,
      conversationTitle: null,
      chatStatus: null,
      chatStatusRaw: null,
      chatFinishedAt: null,
    });
  }));
}


class PatchworkAIChatController {
  constructor(
    mainWindow,
    taskService,
    onResult,
    onEvent = () => {},
    restoredTasks = [],
    worktreeService = null,
    onMergeResult = async () => {},
    restoredTrees = [],
  ) {
    this.activeChat = null;
    this.mainWindow = mainWindow;
    this.taskService = taskService;
    this.onResult = onResult;
    this.onEvent = onEvent;
    this.worktreeService = worktreeService;
    this.onMergeResult = onMergeResult;
    this.knownTasks = new Map(restoredTasks
      .filter((task) => !['applied', 'completed', 'resolved', 'rolled-back'].includes(task.state))
      .map((task) => [task.taskId.toLowerCase(), task]));
    this.activeTask = restoredTasks
      .filter((task) => task.state === 'submitted' && (
        CHATGPT_CONVERSATION_ID_PATTERN.test(task.conversationId || '') || isChatGPTConversationUrl(task.conversationUrl)
      ))
      .sort((left, right) => String(right.updatedAt || right.createdAt)
      .localeCompare(String(left.updatedAt || left.createdAt)))[0] || null;
    this.activeMerge = restoredTrees
      .filter((tree) => tree.mergeState === 'submitted')
      .sort((left, right) => String(right.updatedAt || right.createdAt)
        .localeCompare(String(left.updatedAt || left.createdAt)))[0] || null;
    this.resultAttempts = new Map();
    this.resultWaiters = new Map();
    this.pendingDownload = null;
    this.processingTasks = new Set();
    this.monitorBusy = false;
    this.conversationStatusBusy = false;
    this.dismissalBusy = false;
    this.dismissedNoticeEvents = new Map();
    this.monitorQueued = false;
    this.visible = false;
    this.view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        spellcheck: true,
      },
    });
    this.mainWindow.contentView.addChildView(this.view);
    this.view.setBackgroundColor('#11130f');
    this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    this.chatService = new ChatGPTBrowserAIChatService(this.view.webContents);
    this.operations = new SerialOperationQueue();
    this.installNavigationHandlers();
    this.installDownloadListener();
    this.installMergeDownloadListener();
    this.resultMonitor = setInterval(() => this.requestMonitor(), TASK_MONITOR_INTERVAL_MILLISECONDS);
    this.resultMonitor.unref?.();
    this.mainWindow.once('closed', () => clearInterval(this.resultMonitor));
    const legacyConversationUrl = this.activeMerge?.mergeConversationUrl || this.activeTask?.conversationUrl || null;
    this.ready = Promise.resolve(this.view.webContents.loadURL(legacyConversationUrl || CHATGPT_URL)).then(async () => {
      const id = this.activeTask?.conversationId || this.activeMerge?.mergeConversationId || null;
      if (!legacyConversationUrl && id) {
        this.activeChat = await this.chatService.openChat({
          id,
          workspaceId: this.activeTask?.chatgptProject?.id || this.activeMerge?.chatgptProject?.id || null,
          title: this.activeTask?.conversationTitle || null,
        });
      }
    });
  }

  enqueue(operation) {
    return this.operations.run(async () => {
      await this.ready;
      return operation();
    });
  }

  requestMonitor() {
    if (this.monitorQueued || this.view.webContents.isDestroyed()) return;
    this.monitorQueued = true;
    this.enqueue(() => this.monitorPage())
      .catch(() => {})
      .finally(() => { this.monitorQueued = false; });
  }

  installNavigationHandlers() {
    const contents = this.view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (!url.startsWith('https://')) return { action: 'deny' };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: this.mainWindow,
          width: 520,
          height: 720,
          webPreferences: {
            partition: PARTITION,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          },
        },
      };
    });
    contents.on('did-start-loading', () => this.onEvent({ type: 'browser-loading', loading: true }));
    contents.on('did-stop-loading', () => {
      this.onEvent({ type: 'browser-loading', loading: false, url: contents.getURL() });
      this.installResultWatcher();
    });
    contents.on('dom-ready', () => {
      this.installResultWatcher();
    });
    contents.on('did-navigate', (_event, url) => {
      this.handleNavigation(url);
    });
    contents.on('did-navigate-in-page', (_event, url) => {
      this.handleNavigation(url);
    });
    contents.on('page-title-updated', (_event, title) => {
      this.handlePageTitleUpdated(title).catch(() => {});
    });
    contents.on('render-process-gone', (_event, details) => {
      this.onEvent({ type: 'task-failed', message: `The embedded ChatGPT renderer stopped: ${details.reason}` });
    });
  }

  async handlePageTitleUpdated(title) {
    const normalizedTitle = normalizeConversationTitle(title);
    const event = { type: 'browser-title', title };
    const task = this.activeTask;
    if (!normalizedTitle || (!task?.conversationId && !task?.conversationUrl)) {
      await this.onEvent(event);
      return;
    }

    const currentUrl = this.view.webContents.getURL();
    const currentConversationId = conversationIdFromRouteUrl(currentUrl);
    const taskConversationId = conversationIdFromRouteUrl(task.conversationUrl) || task.conversationId;
    const sameConversation = currentUrl === task.conversationUrl
      || Boolean(taskConversationId && currentConversationId === taskConversationId);
    if (!sameConversation || task.conversationTitle === normalizedTitle) {
      await this.onEvent(event);
      return;
    }

    try {
      const saved = await this.taskService.updateTask(task.taskId, { conversationTitle: normalizedTitle });
      if (this.activeTask?.taskId === task.taskId) this.activeTask = saved;
      this.knownTasks.set(task.taskId.toLowerCase(), saved);
      await this.onEvent({ ...event, task: saved });
    } catch {
      await this.onEvent(event);
    }
  }

  async rememberConversationId(conversationId, task = this.activeTask) {
    if (!task || task.state !== 'submitted' || task.conversationId === conversationId) return task;
    const taskRouteId = conversationIdFromRouteUrl(task.conversationUrl);
    if (taskRouteId && taskRouteId !== conversationId) return task;
    const next = { ...task, conversationId };
    if (this.activeTask?.taskId === task.taskId) this.activeTask = next;
    this.knownTasks.set(task.taskId.toLowerCase(), next);
    try {
      const saved = await this.taskService.updateTask(task.taskId, { conversationId });
      if (this.activeTask?.taskId === task.taskId) this.activeTask = saved;
      this.knownTasks.set(task.taskId.toLowerCase(), saved);
      return saved;
    } catch {
      return next;
    }
  }

  installDownloadListener() {
    this.view.webContents.session.on('will-download', (_event, item) => {
      const originalName = path.basename(item.getFilename());
      const namedTaskId = resultTaskId(originalName);
      const pending = this.pendingDownload && Date.now() - this.pendingDownload.startedAt < 20_000
        ? this.pendingDownload
        : null;
      const taskId = namedTaskId || (pending && /\.txt$/i.test(originalName) ? pending.taskId : null);
      const task = taskId ? this.knownTasks.get(taskId.toLowerCase()) : null;
      // Downloads unrelated to an active Patchwork task or merge use Chromium's normal behavior.
      if (!task) return;

      this.pendingDownload = null;
      this.processingTasks.add(task.taskId);
      const safeName = task.resultFilename || `chatgpt-ide-result-${task.taskId}.txt`;
      const incomingDir = path.join(this.taskService.taskDirectory(task.taskId), 'incoming');
      const savePath = path.join(incomingDir, safeName);
      try {
        fsSync.mkdirSync(incomingDir, { recursive: true });
        item.setSavePath(savePath);
        this.onEvent({
          type: 'result-download-started',
          taskId: task.taskId,
          message: `Downloading ${safeName}…`,
        });
      } catch (error) {
        this.onEvent({ type: 'task-failed', taskId: task.taskId, message: error.message });
      }

      item.once('done', async (_downloadEvent, state) => {
        const taskKey = task.taskId.toLowerCase();
        const waiter = this.resultWaiters.get(taskKey);
        if (state !== 'completed') {
          waiter?.reject(new Error(`The ChatGPT download ended with status: ${state}`));
          this.resultWaiters.delete(taskKey);
          this.processingTasks.delete(task.taskId);
          await this.onEvent({
            type: 'task-failed',
            taskId: task.taskId,
            message: `The ChatGPT download ended with status: ${state}`,
          });
          return;
        }
        try {
          const processedTask = await this.onResult(task.taskId, savePath);
          waiter?.resolve(processedTask);
          this.knownTasks.delete(taskKey);
          if (this.activeTask?.taskId === task.taskId) this.activeTask = null;
        } catch (error) {
          waiter?.reject(error);
          // ResultService emits the detailed validation error.
        } finally {
          this.resultWaiters.delete(taskKey);
          this.processingTasks.delete(task.taskId);
        }
      });
    });
  }


  installMergeDownloadListener() {
    this.view.webContents.session.on('will-download', (_event, item) => {
      const originalName = path.basename(item.getFilename());
      const pending = this.pendingDownload && Date.now() - this.pendingDownload.startedAt < 20_000
        ? this.pendingDownload
        : null;
      const namedMergeId = mergeTreeId(originalName);
      const pendingMergeId = pending?.kind === 'merge' && /\.txt$/i.test(originalName)
        ? pending.treeId
        : null;
      const mergeId = namedMergeId || pendingMergeId;
      const merge = mergeId && this.activeMerge?.id.toLowerCase() === mergeId.toLowerCase()
        ? this.activeMerge
        : null;
      if (!merge) return;

      this.pendingDownload = null;
      this.activeMerge = { ...merge, mergeState: 'downloading' };
      const safeName = mergeResultFilename(merge.id);
      const incomingDir = path.join(this.worktreeService.mergesRoot, 'incoming');
      const savePath = path.join(incomingDir, safeName);
      try {
        fsSync.mkdirSync(incomingDir, { recursive: true });
        item.setSavePath(savePath);
        this.onEvent({
          type: 'merge-result-download-started',
          treeId: merge.id,
          message: `Downloading ${safeName}…`,
        });
      } catch (error) {
        this.worktreeService.markMergeFailed(merge.id, error).catch(() => {});
        this.activeMerge = null;
        this.onEvent({ type: 'merge-failed', treeId: merge.id, message: error.message });
        return;
      }

      item.once('done', async (_downloadEvent, state) => {
        if (state !== 'completed') {
          const error = new Error(`The ChatGPT download ended with status: ${state}`);
          await this.worktreeService.markMergeFailed(merge.id, error).catch(() => {});
          this.activeMerge = null;
          await this.onEvent({ type: 'merge-failed', treeId: merge.id, message: error.message });
          return;
        }
        try {
          const text = fsSync.readFileSync(savePath, 'utf8');
          await this.finishMergeResult(merge, text);
        } catch (error) {
          await this.worktreeService.markMergeFailed(merge.id, error).catch(() => {});
          this.activeMerge = null;
          await this.onEvent({ type: 'merge-failed', treeId: merge.id, message: error.message });
        }
      });
    });
  }

  handleNavigation(url) {
    this.onEvent({ type: 'browser-navigated', url });
    const id = conversationIdFromRouteUrl(url);
    if (this.activeMerge?.mergeState === 'submitting' && id && this.worktreeService) {
      const treeId = this.activeMerge.id;
      this.worktreeService.markMergeSubmitted(treeId, id).then((tree) => {
        if (this.activeMerge?.id === treeId) this.activeMerge = tree;
      }).catch(() => {});
    }
  }

  setBounds(bounds) {
    const next = {
      x: Math.max(0, Math.round(bounds.x || 0)),
      y: Math.max(0, Math.round(bounds.y || 0)),
      width: Math.max(0, Math.round(bounds.width || 0)),
      height: Math.max(0, Math.round(bounds.height || 0)),
    };
    this.view.setBounds(this.visible ? next : { x: 0, y: 0, width: 0, height: 0 });
  }

  setVisible(visible) {
    this.visible = Boolean(visible);
    this.view.setVisible(this.visible);
    if (!this.visible) this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }

  async prepare(task) {
    this.activeMerge = null;
    this.activeTask = task;
    this.knownTasks.set(task.taskId.toLowerCase(), task);
    clipboard.writeText(task.handoffPrompt);
    await this.newChat(task.chatgptProject?.id, task.chatgptProject?.shortUrl, {
      model: task.model || 'default',
      reasoning: task.reasoningMode || 'default',
    });
    this.installResultWatcher();
    await this.onEvent({
      type: 'browser-prepared',
      taskId: task.taskId,
      message: task.chatgptProject?.name
        ? `A fresh chat in ChatGPT project “${task.chatgptProject.name}” is ready for automated submission.`
        : 'A fresh chat in the persistent ChatGPT session is ready for automated submission.',
    });
  }

  async restoreActiveContext(task = null, merge = null) {
    this.activeTask = task || null;
    this.activeMerge = merge || null;
    if (task?.taskId) this.knownTasks.set(task.taskId.toLowerCase(), task);

    const id = task?.conversationId || merge?.mergeConversationId || conversationIdFromRouteUrl(task?.conversationUrl)
      || conversationIdFromRouteUrl(merge?.mergeConversationUrl);
    if (id) this.activeChat = await this.chatService.openChat({
      id,
      workspaceId: task?.chatgptProject?.id || merge?.chatgptProject?.id || null,
      title: task?.conversationTitle || null,
      model: task?.model || 'default',
      reasoning: task?.reasoningMode || 'default',
    });
    this.installResultWatcher();
  }

  async ensureTaskChat(task) {
    const id = task?.conversationId || conversationIdFromRouteUrl(task?.conversationUrl);
    if (!id) throw new Error('This task has no saved AI chat.');
    this.activeChat = await this.chatService.openChat({
      id,
      workspaceId: task.chatgptProject?.id || null,
      title: task.conversationTitle || null,
      model: task.model || 'default',
      reasoning: task.reasoningMode || 'default',
    });
    return this.activeChat;
  }

  async openTaskConversation(task) {
    this.activeMerge = null;
    this.activeTask = task;
    this.knownTasks.set(task.taskId.toLowerCase(), task);
    await this.ensureTaskChat(task);
    await this.onEvent({
      type: 'task-chat-opened',
      taskId: task.taskId,
      message: 'Loaded this task’s saved ChatGPT conversation into the native chat view.',
    });
    return { opened: true, task };
  }

  async readTaskChat(task) {
    const chat = await this.ensureTaskChat(task);
    const snapshot = await chat.current();
    await this.updateTaskFromChatSnapshot(task, snapshot);
    await this.onEvent({ type: 'task-chat-snapshot', taskId: task.taskId, snapshot });
    return snapshot;
  }

  async sendTaskMessage(task, text) {
    const message = String(text || '').trim();
    if (!message) throw new Error('Enter a chat message.');
    this.activeMerge = null;
    this.activeTask = task;
    this.knownTasks.set(task.taskId.toLowerCase(), task);
    const chat = await this.ensureTaskChat(task);
    const run = await chat.send({ text: message });
    let currentTask = this.knownTasks.get(task.taskId.toLowerCase()) || task;
    if (currentTask.state === 'submitted') {
      currentTask = await this.taskService.updateTask(task.taskId, {
        chatStatus: run.status,
        chatStatusRaw: null,
        chatFinishedAt: null,
      });
      this.activeTask = currentTask;
      this.knownTasks.set(task.taskId.toLowerCase(), currentTask);
      await this.onEvent({
        type: 'task-chat-status',
        task: currentTask,
        taskId: task.taskId,
        chatStatus: run.status,
        chatStatusRaw: null,
        message: 'Message sent through the hidden ChatGPT session.',
      });
    }
    const snapshot = await chat.current();
    await this.onEvent({ type: 'task-chat-snapshot', taskId: task.taskId, snapshot });
    this.requestMonitor();
    return { task: currentTask, snapshot };
  }

  async stopTaskChat(task) {
    this.activeTask = task;
    this.knownTasks.set(task.taskId.toLowerCase(), task);
    const chat = await this.ensureTaskChat(task);
    await chat.stop();
    const snapshot = await chat.current();
    const currentTask = await this.updateTaskFromChatSnapshot(task, snapshot);
    await this.onEvent({ type: 'task-chat-snapshot', taskId: task.taskId, snapshot });
    return { task: currentTask, snapshot };
  }

  async newChat(projectId = null, projectShortUrl = null, configuration = {}) {
    this.activeChat = await this.chatService.createChat({
      workspaceId: projectId || null,
      model: configuration.model || 'default',
      reasoning: configuration.reasoning || 'default',
    });
    return this.activeChat;
  }

  async listProjects() {
    return this.chatService.listWorkspaces();
  }

  async createProject(name) {
    const projectName = String(name || '').trim();
    if (!projectName) throw new Error('Enter a name for the new ChatGPT project.');
    const workspace = await this.chatService.createWorkspace({ name: projectName });
    return { ...workspace, shortUrl: workspace.id };
  }

  async reload() {
    return this.chatService.reloadSession();
  }

  async goBack() {
    return this.chatService.navigateSessionBack();
  }

  async goForward() {
    return this.chatService.navigateSessionForward();
  }


  async submit(task) {
    this.activeMerge = null;
    this.activeTask = task;
    this.knownTasks.set(task.taskId.toLowerCase(), task);
    const summaryOnly = Boolean(task.summaryOnly);
    await this.onEvent({
      type: 'automation-started',
      taskId: task.taskId,
      message: summaryOnly
        ? 'Injecting the Git Summary request into the hidden ChatGPT composer…'
        : 'Injecting the task into the hidden ChatGPT composer…',
    });
    if (!this.activeChat) {
      this.activeChat = await this.chatService.createChat({
        workspaceId: task.chatgptProject?.id || null,
        model: task.model || 'default',
        reasoning: task.reasoningMode || 'default',
      });
    }
    let run;
    try {
      run = await this.activeChat.send({
        text: task.handoffPrompt,
        attachments: [
          { path: task.packagePath, name: path.basename(task.packagePath) },
          ...(task.attachments || []),
        ],
      });
    } catch (error) {
      await this.onEvent(error?.code === AI_CHAT_ERROR_CODE.AUTHENTICATION_REQUIRED
        ? {
          type: 'browser-login-required',
          taskId: task.taskId,
          message: 'Sign in on the ChatGPT session page, then choose Submit automatically.',
        }
        : {
          type: 'task-failed',
          taskId: task.taskId,
          message: error?.message || 'The AI chat could not accept the task.',
        });
      throw error;
    }
    await this.onEvent({
      type: 'task-request-verified',
      taskId: task.taskId,
      message: 'The AI chat accepted the message and attachments.',
    });
    if (!run?.chatId) {
      await this.onEvent({
        type: 'task-submit-unconfirmed',
        taskId: task.taskId,
        message: 'The AI provider did not create a chat after Send, so the task was not marked submitted.',
      });
      throw new Error('Patchwork could not confirm an AI chat after Send.');
    }
    const current = await this.activeChat.current();
    const submittedTask = await this.taskService.updateTask(task.taskId, {
      state: 'submitted',
      submittedAt: new Date().toISOString(),
      conversationUrl: null,
      conversationId: this.activeChat.id,
      conversationTitle: current.title || task.conversationTitle || null,
      chatStatus: run.status,
      chatStatusRaw: null,
      chatFinishedAt: null,
      model: run.configuration?.model || task.model,
      reasoningMode: run.configuration?.reasoning || task.reasoningMode,
    });
    this.activeTask = submittedTask;
    this.knownTasks.set(task.taskId.toLowerCase(), submittedTask);
    this.installResultWatcher();
    await this.onEvent({
      type: 'task-submitted',
      task: submittedTask,
      message: summaryOnly
        ? 'Git Summary uploaded and submitted through the ChatGPT page.'
        : 'Task uploaded and submitted through the ChatGPT page.',
    });
    return submittedTask;
  }

  async submitAndWaitForResult(task, timeoutMilliseconds = GIT_SUMMARY_RESULT_TIMEOUT_MILLISECONDS) {
    const taskId = String(task?.taskId || '').trim();
    if (!taskId) throw new Error('The Git summary task is missing its task ID.');
    const key = taskId.toLowerCase();
    if (this.resultWaiters.has(key)) {
      throw new Error('A result download is already in progress for this task.');
    }

    let resultTimeout = null;
    const resultPromise = new Promise((resolve, reject) => {
      resultTimeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for ${task.resultFilename || `chatgpt-ide-result-${taskId}.txt`} to finish downloading.`));
      }, timeoutMilliseconds);
      this.resultWaiters.set(key, {
        resolve: (value) => {
          clearTimeout(resultTimeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(resultTimeout);
          reject(error);
        },
      });
    });

    try {
      await this.enqueue(() => this.submit(task));
      return await resultPromise;
    } catch (error) {
      this.resultWaiters.get(key)?.reject(error);
      throw error;
    } finally {
      clearTimeout(resultTimeout);
      this.resultWaiters.delete(key);
    }
  }

  async submitMerge(request) {
    this.activeTask = null;
    this.activeMerge = {
      ...(await this.worktreeService.get(request.treeId)),
      mergeState: 'submitting',
    };
    await this.onEvent({
      type: 'merge-automation-started',
      treeId: request.treeId,
      message: `Opening a fresh ChatGPT chat to summarize ${request.treeName}…`,
    });
    this.activeChat = await this.chatService.createChat({ workspaceId: request.chatgptProject?.id || null });
    const run = await this.activeChat.send({ text: request.prompt });
    this.activeMerge = await this.worktreeService.markMergeSubmitted(request.treeId, run.chatId);
    await this.onEvent({
      type: 'merge-submitted',
      treeId: request.treeId,
      message: 'ChatGPT is preparing the squash commit message.',
    });
    return true;
  }

  installResultWatcher() {
    if (this.view.webContents.isDestroyed()) return;
    this.requestMonitor();
  }

  async monitorPage() {
    if (this.visible || this.view.webContents.isDestroyed()) return false;
    const recovery = await this.chatService.recoverSession();
    if (recovery.resolved) {
      const eventKey = String(recovery.notice || 'blocking-notice').toLowerCase();
      const lastEventAt = this.dismissedNoticeEvents.get(eventKey) || 0;
      if (Date.now() - lastEventAt >= NOTICE_EVENT_COOLDOWN_MILLISECONDS) {
        this.dismissedNoticeEvents.set(eventKey, Date.now());
        await this.onEvent({
          type: 'browser-notice-dismissed',
          message: 'Dismissed ChatGPT’s temporary usage notice; background automation continues.',
        });
      }
    }

    if (this.activeMerge?.mergeState === 'submitted' && await this.checkForMerge()) return true;

    const tasks = [...this.knownTasks.values()]
      .filter((task) => task.state === 'submitted' && (
        task.conversationId || isChatGPTConversationUrl(task.conversationUrl)
      ))
      .sort((left, right) => String(left.submittedAt || left.createdAt || '')
        .localeCompare(String(right.submittedAt || right.createdAt || '')));
    for (const task of tasks) {
      if (this.visible) break;
      await this.checkConversationStatus(task);
      const currentTask = this.knownTasks.get(task.taskId.toLowerCase()) || task;
      if (await this.checkForResult({ task: currentTask })) return true;
    }
    return false;
  }

  async discoverConversationId(task) {
    if (task.conversationId) return task.conversationId;
    const taskRouteId = conversationIdFromRouteUrl(task.conversationUrl);
    if (taskRouteId) {
      const remembered = await this.rememberConversationId(taskRouteId, task);
      return remembered?.conversationId === taskRouteId ? taskRouteId : null;
    }
    return null;
  }

  async updateTaskFromChatSnapshot(task, current) {
    if (!task || task.state !== 'submitted') return task;
    const nextChatStatus = current?.run?.status;
    if (!nextChatStatus || nextChatStatus === AI_CHAT_RUN_STATUS.UNKNOWN) return task;
    const key = task.taskId.toLowerCase();
    const currentTask = this.knownTasks.get(key) || task;
    const changed = currentTask.chatStatus !== nextChatStatus || currentTask.chatStatusRaw !== null;
    if (!changed) return currentTask;

    const saved = await this.taskService.updateTask(task.taskId, {
      conversationId: current?.id || currentTask.conversationId,
      chatStatus: nextChatStatus,
      chatStatusRaw: null,
      chatFinishedAt: nextChatStatus === AI_CHAT_RUN_STATUS.STREAMING
        ? null
        : currentTask.chatFinishedAt || new Date().toISOString(),
    });
    if (this.activeTask?.taskId === task.taskId) this.activeTask = saved;
    this.knownTasks.set(key, saved);
    const message = nextChatStatus === AI_CHAT_RUN_STATUS.STREAMING
      ? 'ChatGPT is still generating the task result.'
      : nextChatStatus === AI_CHAT_RUN_STATUS.FAILED
        ? 'ChatGPT reported a generation failure for this task.'
        : nextChatStatus === AI_CHAT_RUN_STATUS.STOPPED
          ? 'ChatGPT generation was stopped for this task.'
          : 'ChatGPT finished generating; Patchwork is checking for the result file.';
    await this.onEvent({
      type: 'task-chat-status',
      task: saved,
      taskId: task.taskId,
      chatStatus: nextChatStatus,
      chatStatusRaw: null,
      message,
    });
    return saved;
  }

  async checkConversationStatus(task = this.activeTask) {
    if (this.conversationStatusBusy || !task || task.state !== 'submitted'
      || task.chatStatus === AI_CHAT_RUN_STATUS.COMPLETED || task.chatStatus === AI_CHAT_RUN_STATUS.FAILED
      || this.view.webContents.isDestroyed()) {
      return null;
    }
    this.conversationStatusBusy = true;
    try {
      const conversationId = task.conversationId || await this.discoverConversationId(task);
      if (!conversationId) return null;
      const chat = await this.ensureTaskChat({ ...task, conversationId });
      const current = await chat.current();
      await this.updateTaskFromChatSnapshot(task, current);
      if (this.activeTask?.taskId === task.taskId) {
        await this.onEvent({ type: 'task-chat-snapshot', taskId: task.taskId, snapshot: current });
      }
      return current;
    } finally {
      this.conversationStatusBusy = false;
    }
  }

  async checkForResult({ force = false, task = this.activeTask } = {}) {
    const allowedState = force ? ['submitted', 'conflicted'] : ['submitted'];
    if (this.monitorBusy || !task || !allowedState.includes(task.state)) return false;
    if (task.chatStatus === AI_CHAT_RUN_STATUS.FAILED) return false;
    if (this.processingTasks.has(task.taskId) || this.view.webContents.isDestroyed()) return false;
    if (this.pendingDownload && Date.now() - this.pendingDownload.startedAt < 20_000) return false;
    const attemptedAt = this.resultAttempts.get(task.taskId) || 0;
    if (!force && Date.now() - attemptedAt < RESULT_RETRY_MILLISECONDS) return false;

    this.monitorBusy = true;
    try {
      const expectedName = task.resultFilename || `chatgpt-ide-result-${task.taskId}.txt`;
      const chat = await this.ensureTaskChat(task);
      const current = await chat.current();
      if (this.activeTask?.taskId === task.taskId) {
        await this.onEvent({ type: 'task-chat-snapshot', taskId: task.taskId, snapshot: current });
      }
      const ready = force || current.run.status !== AI_CHAT_RUN_STATUS.STREAMING;
      if (!ready) return false;
      this.pendingDownload = { kind: 'task', taskId: task.taskId, startedAt: Date.now() };
      const started = await chat.downloadAttachment(expectedName).catch(() => false);
      if (!started) {
        if (this.pendingDownload?.kind === 'task' && this.pendingDownload.taskId === task.taskId) {
          this.pendingDownload = null;
        }
        return false;
      }
      this.resultAttempts.set(task.taskId, Date.now());
      await this.onEvent({
        type: 'result-link-activated',
        taskId: task.taskId,
        message: `Found ${expectedName}; starting the secure download…`,
      });
      return true;
    } finally {
      this.monitorBusy = false;
    }
  }

  async refreshTaskResult(task) {
    if (!task?.taskId || (!task.conversationId && !isChatGPTConversationUrl(task.conversationUrl))) {
      throw new Error('This task has no saved AI chat to refresh its result from.');
    }
    const taskId = task.taskId;
    const key = taskId.toLowerCase();
    if (this.resultWaiters.has(key)) {
      throw new Error('A result download is already in progress for this task.');
    }

    this.activeMerge = null;
    this.activeTask = task;
    this.knownTasks.set(key, task);
    let resultTimeout = null;
    const waitForResult = new Promise((resolve, reject) => {
      resultTimeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for chatgpt-ide-result-${taskId}.txt to finish downloading.`));
      }, 30_000);
      this.resultWaiters.set(key, {
        resolve: (value) => {
          clearTimeout(resultTimeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(resultTimeout);
          reject(error);
        },
      });
    });

    try {
      await this.openTaskConversation(task);

      this.resultAttempts.delete(taskId);
      let started = false;
      for (let attempt = 0; attempt < 10 && !started; attempt += 1) {
        while (this.monitorBusy) await delay(100);
        started = await this.checkForResult({ force: true });
        if (!started) await delay(250);
      }
      if (!started && !this.processingTasks.has(taskId)) {
        throw new Error(`Could not find chatgpt-ide-result-${taskId}.txt in the saved ChatGPT conversation.`);
      }

      return await waitForResult;
    } catch (error) {
      this.resultWaiters.get(key)?.reject(error);
      throw error;
    } finally {
      clearTimeout(resultTimeout);
      this.resultWaiters.delete(key);
    }
  }

  async checkForMerge() {
    const tree = this.activeMerge;
    if (this.monitorBusy || !tree || tree.mergeState !== 'submitted') return false;
    if (this.pendingDownload && Date.now() - this.pendingDownload.startedAt < 20_000) return false;
    this.monitorBusy = true;
    try {
      this.pendingDownload = { kind: 'merge', treeId: tree.id, startedAt: Date.now() };
      const expectedName = mergeResultFilename(tree.id);
      if ((!this.activeChat || this.activeChat.id !== tree.mergeConversationId) && tree.mergeConversationId) {
        this.activeChat = await this.chatService.openChat({
          id: tree.mergeConversationId,
          workspaceId: tree.chatgptProject?.id || null,
        });
      }
      const started = this.activeChat
        && await this.activeChat.downloadAttachment(expectedName).catch(() => false);
      if (!started) {
        if (this.pendingDownload?.kind === 'merge' && this.pendingDownload.treeId === tree.id) {
          this.pendingDownload = null;
        }
        return false;
      }
      await this.onEvent({
        type: 'merge-result-link-activated',
        treeId: tree.id,
        message: `Found ${mergeResultFilename(tree.id)}; starting the secure download…`,
      });
      return true;
    } finally {
      this.monitorBusy = false;
    }
  }

  copyPrompt(task) {
    clipboard.writeText(task.taskText);
  }

  revealPackage(task) {
    shell.showItemInFolder(task.packagePath);
  }

  forgetTask(taskId) {
    const key = String(taskId).toLowerCase();
    const waiter = this.resultWaiters.get(key);
    if (waiter) waiter.reject(new Error('This task was removed while its result was being downloaded.'));
    this.resultWaiters.delete(key);
    this.knownTasks.delete(key);
    this.processingTasks.delete(taskId);
    this.resultAttempts.delete(taskId);
    if (this.activeTask?.taskId === taskId) this.activeTask = null;
    if (this.pendingDownload?.kind === 'task' && this.pendingDownload.taskId === taskId) {
      this.pendingDownload = null;
    }
  }

  async finishMergeResult(tree, resultText) {
    const completed = await this.onMergeResult(tree.id, resultText);
    this.pendingDownload = null;
    if (this.activeMerge?.id === tree.id) this.activeMerge = null;
    return completed;
  }

  async importResult(task) {
    const response = await dialog.showOpenDialog(this.mainWindow, {
      title: 'Choose a saved ChatGPT result',
      properties: ['openFile'],
      filters: [
        { name: 'Patchwork text results', extensions: ['txt'] },
      ],
    });
    if (response.canceled || response.filePaths.length === 0) return null;
    const selectedPath = response.filePaths[0];
    return this.onResult(task.taskId, selectedPath);
  }
}

const ChatGPTView = PatchworkAIChatController;

module.exports = {
  CHATGPT_URL,
  ChatGPTView,
  PatchworkAIChatController,
  conversationIdFromRouteUrl,
  isChatGPTConversationUrl,
  recoverUnconfirmedSubmissions,
  mergeTreeId,
  resultTaskId,
};
