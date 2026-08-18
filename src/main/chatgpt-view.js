const fsSync = require('node:fs');
const path = require('node:path');
const { WebContentsView, clipboard, dialog, shell } = require('electron');
const { mergeResultFilename } = require('./worktree-service');
const { AI_CHAT_ERROR_CODE, AI_CHAT_RUN_STATUS } = require('./ai-chat-service');
const { ChatGPTBrowserAIChatService } = require('./chatgpt-browser-ai-chat-service');
const { ChatGPTBrowserDriver } = require('./chatgpt-browser-driver');
const { SerialOperationQueue } = require('./serial-operation-queue');

const CHATGPT_URL = 'https://chatgpt.com/';
const PARTITION = 'persist:patchwork-chatgpt';
const RESULT_NAME_PATTERN = /chatgpt-ide-result-([0-9a-f-]{36})(?:\s*\(\d+\))?\.txt/i;
const RESULT_RETRY_MILLISECONDS = 6_000;
const TASK_MONITOR_INTERVAL_MILLISECONDS = 15_000;
const TASK_CHAT_DOM_POLL_INTERVAL_MILLISECONDS = 2_000;
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

function chatSnapshotFingerprint(snapshot) {
  return JSON.stringify({
    id: snapshot?.id || null,
    messages: (Array.isArray(snapshot?.messages) ? snapshot.messages : []).map((message) => ({
      id: String(message?.id || ''),
      role: String(message?.role || ''),
      text: String(message?.text ?? message?.content ?? ''),
    })),
    thinkingSummary: String(snapshot?.thinkingSummary || ''),
    run: {
      status: String(snapshot?.run?.status || AI_CHAT_RUN_STATUS.UNKNOWN),
      error: String(snapshot?.run?.error?.message || ''),
    },
  });
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
    // There is exactly one authenticated ChatGPT browser session. These are
    // conversation descriptors routed through that same WebContentsView; they
    // never create another BrowserWindow, partition, or provider session.
    this.activeChat = null;
    this.sessionChat = null;
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
    this.resultMisses = new Map();
    this.resultWaiters = new Map();
    this.pendingDownload = null;
    this.processingTasks = new Set();
    this.monitorBusy = false;
    this.conversationStatusBusy = false;
    this.dismissalBusy = false;
    this.dismissedNoticeEvents = new Map();
    this.liveChatFingerprints = new Map();
    this.liveChatSnapshotQueue = Promise.resolve();
    this.chatAwaitingEmptyTranscript = null;
    this.monitorQueued = false;
    this.taskChatPollTimer = null;
    this.taskChatPollQueued = false;
    this.taskChatPollTaskId = null;
    this.lastTaskChatFingerprint = null;
    this.sessionChatPollTimer = null;
    this.sessionChatPollQueued = false;
    this.sessionChatPollChatId = null;
    this.lastSessionChatFingerprint = null;
    this.activeChatMode = null;
    this.visible = false;
    this.view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'chatgpt-browser-preload.js'),
        partition: PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        spellcheck: true,
      },
    });
    this.mainWindow.contentView.addChildView(this.view);
    this.view.setBackgroundColor('#11130f');
    this.view.setBounds(this.parkedBounds());
    this.view.setVisible(true);
    this.mainWindow.on('resize', () => {
      if (!this.visible) this.view.setBounds(this.parkedBounds());
    });
    const browserDriver = new ChatGPTBrowserDriver(this.view.webContents, {
      onWorkspaceStatus: ({ message, recovery }) => this.onEvent({
        type: 'project-browser-status',
        message,
        recovery,
      }),
      onChatSnapshot: (payload) => this.handleBrowserChatSnapshot(payload),
    });
    this.chatService = new ChatGPTBrowserAIChatService(
      this.view.webContents,
      browserDriver,
    );
    this.operations = new SerialOperationQueue();
    this.installNavigationHandlers();
    this.installDownloadListener();
    this.installMergeDownloadListener();
    this.resultMonitor = setInterval(() => this.requestMonitor(), TASK_MONITOR_INTERVAL_MILLISECONDS);
    this.resultMonitor.unref?.();
    this.mainWindow.once('closed', () => {
      clearInterval(this.resultMonitor);
      this.stopTaskChatPolling();
      this.stopSessionChatPolling();
    });
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

  startTaskChatPolling(task, snapshot) {
    if (!task?.taskId || task.state !== 'submitted'
      || snapshot?.run?.status !== AI_CHAT_RUN_STATUS.STREAMING || !this.activeChat) return;
    const taskId = String(task.taskId);
    if (this.taskChatPollTaskId !== taskId) {
      this.stopTaskChatPolling();
      this.taskChatPollTaskId = taskId;
    }
    if (this.taskChatPollTimer) return;
    this.taskChatPollTimer = setInterval(
      () => this.requestTaskChatPoll(),
      TASK_CHAT_DOM_POLL_INTERVAL_MILLISECONDS,
    );
    this.taskChatPollTimer.unref?.();
  }

  stopTaskChatPolling() {
    if (this.taskChatPollTimer) clearInterval(this.taskChatPollTimer);
    this.taskChatPollTimer = null;
    this.taskChatPollTaskId = null;
    this.taskChatPollQueued = false;
    this.lastTaskChatFingerprint = null;
  }

  updateTaskChatPolling(task, snapshot) {
    if (snapshot?.run?.status === AI_CHAT_RUN_STATUS.STREAMING) {
      this.startTaskChatPolling(task, snapshot);
    } else if ([
      AI_CHAT_RUN_STATUS.COMPLETED,
      AI_CHAT_RUN_STATUS.STOPPED,
      AI_CHAT_RUN_STATUS.FAILED,
    ].includes(snapshot?.run?.status)) {
      this.stopTaskChatPolling();
    }
  }

  async emitTaskChatSnapshot(task, snapshot, { force = false } = {}) {
    if (!task || this.activeTask?.taskId !== task.taskId) return false;
    const fingerprint = chatSnapshotFingerprint(snapshot);
    if (!force && fingerprint === this.lastTaskChatFingerprint) return false;
    this.lastTaskChatFingerprint = fingerprint;
    await this.onEvent({ type: 'task-chat-snapshot', taskId: task.taskId, snapshot });
    return true;
  }

  requestTaskChatPoll() {
    if (this.taskChatPollQueued || !this.taskChatPollTimer || this.visible
      || this.view.webContents.isDestroyed()) return;
    const taskId = this.taskChatPollTaskId;
    const task = this.activeTask;
    if (!task || task.taskId !== taskId || !this.activeChat) {
      this.stopTaskChatPolling();
      return;
    }
    this.taskChatPollQueued = true;
    this.enqueue(async () => {
      if (this.visible || this.activeTask?.taskId !== taskId || !this.activeChat) return;
      // Reading through the chat re-opens its route on the shared browser when
      // something else borrowed it, instead of silently dropping the stream.
      const currentTask = this.knownTasks.get(taskId.toLowerCase()) || this.activeTask;
      const snapshot = await this.activeChat.current();
      const savedTask = await this.updateTaskFromChatSnapshot(currentTask, snapshot);
      const taskForPolling = savedTask || currentTask;
      await this.emitTaskChatSnapshot(taskForPolling, snapshot);
      this.updateTaskChatPolling(taskForPolling, snapshot);
    })
      .catch(() => {})
      .finally(() => { this.taskChatPollQueued = false; });
  }

  startSessionChatPolling(snapshot) {
    if (this.activeChatMode !== 'session' || !this.activeChat
      || snapshot?.run?.status !== AI_CHAT_RUN_STATUS.STREAMING) return;
    const chatId = this.activeChat.id;
    if (this.sessionChatPollChatId !== chatId) {
      this.stopSessionChatPolling();
      this.sessionChatPollChatId = chatId;
    }
    if (this.sessionChatPollTimer) return;
    this.sessionChatPollTimer = setInterval(
      () => this.requestSessionChatPoll(),
      TASK_CHAT_DOM_POLL_INTERVAL_MILLISECONDS,
    );
    this.sessionChatPollTimer.unref?.();
  }

  stopSessionChatPolling() {
    if (this.sessionChatPollTimer) clearInterval(this.sessionChatPollTimer);
    this.sessionChatPollTimer = null;
    this.sessionChatPollChatId = null;
    this.sessionChatPollQueued = false;
    this.lastSessionChatFingerprint = null;
  }

  updateSessionChatPolling(snapshot) {
    if (snapshot?.run?.status === AI_CHAT_RUN_STATUS.STREAMING) {
      this.startSessionChatPolling(snapshot);
    } else if ([
      AI_CHAT_RUN_STATUS.COMPLETED,
      AI_CHAT_RUN_STATUS.STOPPED,
      AI_CHAT_RUN_STATUS.FAILED,
    ].includes(snapshot?.run?.status)) {
      this.stopSessionChatPolling();
    }
  }

  async emitSessionChatSnapshot(snapshot, { force = false } = {}) {
    const fingerprint = chatSnapshotFingerprint(snapshot);
    if (!force && fingerprint === this.lastSessionChatFingerprint) return false;
    this.lastSessionChatFingerprint = fingerprint;
    await this.onEvent({ type: 'session-chat-snapshot', snapshot });
    return true;
  }

  requestSessionChatPoll() {
    if (this.sessionChatPollQueued || !this.sessionChatPollTimer || this.visible
      || this.view.webContents.isDestroyed()) return;
    const chatId = this.sessionChatPollChatId;
    if (this.activeChatMode !== 'session' || !this.activeChat || this.activeChat.id !== chatId) {
      this.stopSessionChatPolling();
      return;
    }
    this.sessionChatPollQueued = true;
    this.enqueue(async () => {
      if (this.visible || this.activeChatMode !== 'session' || !this.activeChat
        || this.activeChat.id !== chatId) return;
      const snapshot = await this.activeChat.current();
      await this.emitSessionChatSnapshot(snapshot);
      this.updateSessionChatPolling(snapshot);
    })
      .catch(() => {})
      .finally(() => { this.sessionChatPollQueued = false; });
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

  handleBrowserChatSnapshot(payload) {
    this.liveChatSnapshotQueue = this.liveChatSnapshotQueue
      .then(() => this.processBrowserChatSnapshot(payload))
      .catch(() => {});
  }

  async processBrowserChatSnapshot(payload) {
    if (!payload?.snapshot) return;
    const url = String(payload?.url || this.view.webContents.getURL?.() || '');
    const routeId = conversationIdFromRouteUrl(url);
    // A brand-new chat has no conversation route until Send creates one.
    // Between the two, the page holds the only copy of the user's turn and the
    // start of the response, so the native session chat still follows it.
    const pendingSessionId = !routeId && this.activeChatMode === 'session'
      && String(this.sessionChat?.id || '').startsWith('pending:')
      ? this.sessionChat.id
      : null;
    const conversationId = routeId || pendingSessionId;
    if (!conversationId) return;
    if (pendingSessionId) {
      // ChatGPT's router clears the old transcript a beat after its New chat
      // control is activated. Until the page has actually shown an empty
      // transcript once, anything it reports still belongs to the chat that was
      // left behind, and painting it here is what made a new chat open holding
      // the previous conversation.
      const messageCount = Array.isArray(payload.snapshot.messages) ? payload.snapshot.messages.length : 0;
      if (this.chatAwaitingEmptyTranscript === pendingSessionId) {
        if (messageCount > 0) return;
        this.chatAwaitingEmptyTranscript = null;
      }
    }
    const snapshot = {
      ...payload.snapshot,
      id: conversationId,
      title: String(payload.title || this.view.webContents.getTitle?.() || '').trim() || null,
      messages: (Array.isArray(payload.snapshot.messages) ? payload.snapshot.messages : []).map((message) => ({
        id: String(message?.id || ''),
        role: ['user', 'assistant', 'system'].includes(message?.role)
          ? message.role
          : 'assistant',
        text: String(message?.text ?? message?.content ?? ''),
        ...(Array.isArray(message?.parts) ? { parts: message.parts } : {}),
      })),
      // ChatGPT's own progress line, read alongside the turns. Keeping it on
      // the normalized snapshot lets the native transcript show movement
      // instead of waiting for the finished assistant turn.
      thinkingSummary: String(payload.snapshot.thinkingSummary || '').trim() || null,
      run: {
        status: Object.values(AI_CHAT_RUN_STATUS).includes(payload.snapshot.run?.status)
          ? payload.snapshot.run.status
          : AI_CHAT_RUN_STATUS.UNKNOWN,
        error: payload.snapshot.run?.error || null,
        configuration: payload.snapshot.run?.configuration
          || this.activeChat?.configuration
          || { model: 'default', reasoning: 'default' },
      },
    };
    const fingerprint = chatSnapshotFingerprint(snapshot);
    if (this.liveChatFingerprints.get(conversationId) === fingerprint) return;
    this.liveChatFingerprints.set(conversationId, fingerprint);

    const task = [...this.knownTasks.values()].find((candidate) => (
      candidate.state === 'submitted'
        && (candidate.conversationId === conversationId
          || conversationIdFromRouteUrl(candidate.conversationUrl) === conversationId)
    ));
    if (task) {
      const currentTask = await this.updateTaskFromChatSnapshot(task, snapshot);
      await this.emitTaskChatSnapshot(currentTask || task, snapshot);
      this.updateTaskChatPolling(currentTask || task, snapshot);
      if (currentTask?.chatStatus !== AI_CHAT_RUN_STATUS.STREAMING) this.requestMonitor();
      return;
    }

    if (this.sessionChat?.id === conversationId || (!this.activeTask && this.activeChat?.id === conversationId)) {
      await this.emitSessionChatSnapshot(snapshot);
      this.updateSessionChatPolling(snapshot);
    }
  }

  // Where the browser sits while Patchwork is mirroring it instead of showing
  // it: full size, so ChatGPT lays out and renders exactly as it would on
  // screen, shifted down until only its top pixel row is inside the window.
  //
  // It is deliberately never given empty bounds and never marked invisible.
  // Either one makes Chromium stop compositing the frame, and a frame that is
  // not composited runs no requestAnimationFrame callbacks at all. ChatGPT
  // reveals streamed tokens through rAF, so a suspended frame freezes
  // mid-answer and only catches up when the run finishes. That is what made a
  // mirrored reply show a garbled fragment, sit still, then jump to the
  // finished text.
  parkedBounds() {
    const { width, height } = this.mainWindow.getContentBounds();
    return {
      x: 0,
      y: Math.max(0, Math.round(height) - 1),
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    };
  }

  setBounds(bounds) {
    if (!this.visible) {
      this.view.setBounds(this.parkedBounds());
      return;
    }
    this.view.setBounds({
      x: Math.max(0, Math.round(bounds.x || 0)),
      y: Math.max(0, Math.round(bounds.y || 0)),
      width: Math.max(1, Math.round(bounds.width || 0)),
      height: Math.max(1, Math.round(bounds.height || 0)),
    });
  }

  setVisible(visible) {
    this.visible = Boolean(visible);
    this.view.setVisible(true);
    if (!this.visible) this.view.setBounds(this.parkedBounds());
  }

  async prepare(task) {
    this.stopTaskChatPolling();
    this.stopSessionChatPolling();
    this.activeChatMode = null;
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
    this.stopTaskChatPolling();
    this.stopSessionChatPolling();
    this.activeChatMode = task ? 'task' : null;
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

  // The conversation the native UI is showing right now. Background work runs
  // on the same single browser session, so it has to know whose route it would
  // be taking before it navigates.
  focusedConversationId() {
    if (this.activeChatMode === 'session') return this.sessionChat?.id || null;
    const task = this.activeTask;
    return task?.conversationId
      || conversationIdFromRouteUrl(task?.conversationUrl)
      || (this.activeChatMode === 'task' ? this.activeChat?.id || null : null);
  }

  // Background work may only borrow the shared browser when the conversation on
  // screen can be handed it back. A chat that has never been sent lives on
  // ChatGPT's fresh-chat route, and re-establishing that route means clicking
  // New chat again, which would discard whatever the user is composing. So a
  // pending chat is never interrupted; its tasks wait for the next sweep.
  focusedConversationIsBusy() {
    if (String(this.focusedConversationId() || '').startsWith('pending:')) return true;
    return this.focusedConversationIsStreaming();
  }

  focusedConversationIsStreaming() {
    if (this.activeChatMode === 'session') return Boolean(this.sessionChatPollTimer);
    const task = this.activeTask;
    if (!task) return false;
    const current = this.knownTasks.get(task.taskId.toLowerCase()) || task;
    return current.chatStatus === AI_CHAT_RUN_STATUS.STREAMING;
  }

  // A chat handle for background reads. It deliberately does not become the
  // active chat: the monitor borrows the browser, it does not take ownership of
  // what the native transcript is pointed at.
  async backgroundChat(task) {
    const id = task?.conversationId || conversationIdFromRouteUrl(task?.conversationUrl);
    if (!id) throw new Error('This task has no saved AI chat.');
    if (this.activeChat?.id === id) return this.activeChat;
    return this.chatService.openChat({
      id,
      workspaceId: task.chatgptProject?.id || null,
      title: task.conversationTitle || null,
      model: task.model || 'default',
      reasoning: task.reasoningMode || 'default',
    });
  }

  // Hand the shared browser back to the conversation on screen and give the
  // native transcript whatever it missed while the route was borrowed.
  async restoreFocusedConversation(conversationId) {
    if (!conversationId || String(conversationId).startsWith('pending:')) return;
    if (this.visible || this.view.webContents.isDestroyed()) return;
    if (conversationIdFromRouteUrl(this.view.webContents.getURL()) === conversationId) return;
    const chat = this.activeChat?.id === conversationId ? this.activeChat : null;
    if (!chat) return;
    const snapshot = await chat.current();
    if (this.activeChatMode === 'session') {
      await this.emitSessionChatSnapshot(snapshot);
      this.updateSessionChatPolling(snapshot);
      return;
    }
    const task = this.activeTask;
    if (!task) return;
    const currentTask = await this.updateTaskFromChatSnapshot(task, snapshot);
    await this.emitTaskChatSnapshot(currentTask || task, snapshot);
    this.updateTaskChatPolling(currentTask || task, snapshot);
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
    this.stopTaskChatPolling();
    this.stopSessionChatPolling();
    this.activeChatMode = 'task';
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
    this.stopSessionChatPolling();
    this.activeChatMode = 'task';
    const chat = await this.ensureTaskChat(task);
    this.activeTask = task;
    const snapshot = await chat.current();
    const currentTask = await this.updateTaskFromChatSnapshot(task, snapshot);
    await this.emitTaskChatSnapshot(currentTask || task, snapshot, { force: true });
    this.updateTaskChatPolling(currentTask || task, snapshot);
    return snapshot;
  }

  async sendTaskMessage(task, text, configuration = {}) {
    const message = String(text || '').trim();
    if (!message) throw new Error('Enter a chat message.');
    this.stopSessionChatPolling();
    this.activeChatMode = 'task';
    this.activeMerge = null;
    this.activeTask = task;
    this.knownTasks.set(task.taskId.toLowerCase(), task);
    const chat = await this.ensureTaskChat(task);
    const selectedConfiguration = {
      model: String(configuration?.model || task.model || 'default'),
      reasoning: String(configuration?.reasoning || configuration?.reasoningMode || task.reasoningMode || 'default'),
    };
    await chat.configure(selectedConfiguration);
    const run = await chat.send({ text: message });
    let currentTask = this.knownTasks.get(task.taskId.toLowerCase()) || task;
    if (currentTask.state === 'submitted') {
      currentTask = await this.taskService.updateTask(task.taskId, {
        chatStatus: run.status,
        chatStatusRaw: null,
        chatFinishedAt: null,
        model: run.configuration?.model || selectedConfiguration.model,
        reasoningMode: run.configuration?.reasoning || selectedConfiguration.reasoning,
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
    await this.emitTaskChatSnapshot(currentTask || task, snapshot, { force: true });
    this.updateTaskChatPolling(currentTask || task, snapshot);
    this.requestMonitor();
    return { task: currentTask, snapshot };
  }

  async readSessionChat() {
    this.stopTaskChatPolling();
    this.activeChatMode = 'session';
    if (!this.sessionChat) {
      this.activeTask = null;
      this.activeMerge = null;
      this.sessionChat = await this.chatService.createChat();
    }
    this.activeChat = this.sessionChat;
    const snapshot = await this.sessionChat.current();
    this.lastSessionChatFingerprint = chatSnapshotFingerprint(snapshot);
    this.updateSessionChatPolling(snapshot);
    return { snapshot, configuration: this.sessionChat.configuration };
  }

  async sendSessionMessage(text, configuration = {}) {
    const message = String(text || '').trim();
    if (!message) throw new Error('Enter a chat message.');
    this.stopTaskChatPolling();
    this.activeChatMode = 'session';
    if (!this.sessionChat) {
      this.activeTask = null;
      this.activeMerge = null;
      this.sessionChat = await this.chatService.createChat(configuration || {});
    }
    this.activeChat = this.sessionChat;
    const selectedConfiguration = {
      model: String(configuration?.model || this.sessionChat.configuration.model || 'default'),
      reasoning: String(configuration?.reasoning || configuration?.reasoningMode || this.sessionChat.configuration.reasoning || 'default'),
    };
    await this.sessionChat.configure(selectedConfiguration);
    const run = await this.sessionChat.send({ text: message });
    const snapshot = await this.sessionChat.current();
    this.lastSessionChatFingerprint = chatSnapshotFingerprint(snapshot);
    this.updateSessionChatPolling(snapshot);
    return { snapshot, configuration: run.configuration || selectedConfiguration };
  }

  async stopSessionChat() {
    this.stopTaskChatPolling();
    this.activeChatMode = 'session';
    if (!this.sessionChat) return { snapshot: null, configuration: null };
    this.activeChat = this.sessionChat;
    await this.sessionChat.stop();
    const snapshot = await this.sessionChat.current();
    this.lastSessionChatFingerprint = chatSnapshotFingerprint(snapshot);
    this.updateSessionChatPolling(snapshot);
    return {
      snapshot,
      configuration: this.sessionChat.configuration,
    };
  }

  async newSessionChat(configuration = null) {
    this.stopTaskChatPolling();
    this.stopSessionChatPolling();
    this.activeChatMode = 'session';
    this.activeTask = null;
    this.activeMerge = null;
    // Starting a new chat is not a request to go back to the default model.
    const carried = configuration || this.sessionChat?.configuration || {};
    this.sessionChat = await this.chatService.createChat({
      model: carried.model || 'default',
      reasoning: carried.reasoning || 'default',
    });
    this.activeChat = this.sessionChat;
    this.liveChatFingerprints.delete(this.sessionChat.id);
    this.lastSessionChatFingerprint = null;
    this.chatAwaitingEmptyTranscript = this.sessionChat.id;
    const snapshot = await this.sessionChat.current();
    await this.emitSessionChatSnapshot(snapshot, { force: true });
    return { snapshot, configuration: this.sessionChat.configuration };
  }

  async stopTaskChat(task) {
    this.stopSessionChatPolling();
    this.activeChatMode = 'task';
    this.activeTask = task;
    this.knownTasks.set(task.taskId.toLowerCase(), task);
    const chat = await this.ensureTaskChat(task);
    await chat.stop();
    const snapshot = await chat.current();
    const currentTask = await this.updateTaskFromChatSnapshot(task, snapshot);
    await this.emitTaskChatSnapshot(currentTask || task, snapshot, { force: true });
    this.updateTaskChatPolling(currentTask || task, snapshot);
    return { task: currentTask, snapshot };
  }

  async newChat(projectId = null, projectShortUrl = null, configuration = {}) {
    this.stopTaskChatPolling?.();
    this.stopSessionChatPolling?.();
    this.activeChatMode = null;
    this.activeChat = await this.chatService.createChat({
      workspaceId: projectId || null,
      model: configuration.model || 'default',
      reasoning: configuration.reasoning || 'default',
    });
    return this.activeChat;
  }

  async listProjects() {
    await this.ready;
    return this.chatService.listWorkspaces();
  }

  async createProject(name) {
    await this.ready;
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
    this.activeChatMode = 'task';
    this.knownTasks.set(task.taskId.toLowerCase(), submittedTask);
    this.installResultWatcher();
    // Hand the task view the running conversation now and start following it.
    // Without this the transcript stays blank until the first background sweep,
    // which reads as nothing happening for up to fifteen seconds.
    await this.emitTaskChatSnapshot(submittedTask, current, { force: true });
    this.updateTaskChatPolling(submittedTask, current);
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
    this.stopTaskChatPolling();
    this.stopSessionChatPolling();
    this.activeChatMode = null;
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
    if (this.view.webContents.isDestroyed()) return false;
    // Dismissing a blocking notice is worth doing whether or not the browser is
    // on screen: while one is up it swallows clicks on the composer, Send, and
    // New chat, so every automated step below would fail for the same reason.
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

    if (this.visible) return false;

    if (this.activeMerge?.mergeState === 'submitted' && await this.checkForMerge()) return true;

    // Every submitted task shares the one authenticated browser, so this sweep
    // is the only place that decides whose turn it is. The conversation on
    // screen goes first, a live stream is never interrupted for a background
    // check, and a borrowed route is always handed back.
    const focusedId = this.focusedConversationId();
    const busyFocus = this.focusedConversationIsBusy();
    const conversationOf = (task) => task.conversationId || conversationIdFromRouteUrl(task.conversationUrl);
    const tasks = [...this.knownTasks.values()]
      .filter((task) => task.state === 'submitted' && (
        task.conversationId || isChatGPTConversationUrl(task.conversationUrl)
      ))
      .sort((left, right) => String(left.submittedAt || left.createdAt || '')
        .localeCompare(String(right.submittedAt || right.createdAt || '')))
      .sort((left, right) => Number(conversationOf(right) === focusedId)
        - Number(conversationOf(left) === focusedId));
    let borrowedRoute = false;
    try {
      for (const task of tasks) {
        if (this.visible) break;
        if (focusedId && conversationOf(task) !== focusedId) {
          if (busyFocus) continue;
          borrowedRoute = true;
        }
        await this.checkConversationStatus(task);
        const currentTask = this.knownTasks.get(task.taskId.toLowerCase()) || task;
        if (await this.checkForResult({ task: currentTask })) return true;
      }
      return false;
    } finally {
      if (borrowedRoute && !this.pendingDownload) {
        await this.restoreFocusedConversation(focusedId).catch(() => {});
      }
    }
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
      const chat = await this.backgroundChat({ ...task, conversationId });
      const current = await chat.current();
      const currentTask = await this.updateTaskFromChatSnapshot(task, current);
      if (typeof this.emitTaskChatSnapshot === 'function') {
        await this.emitTaskChatSnapshot(currentTask || task, current);
      } else if (this.activeTask?.taskId === task.taskId) {
        await this.onEvent({ type: 'task-chat-snapshot', taskId: task.taskId, snapshot: current });
      }
      if (typeof this.updateTaskChatPolling === 'function') {
        this.updateTaskChatPolling(currentTask || task, current);
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
    // Each miss widens the gap before the next look. A task whose conversation
    // never produces a result would otherwise pull the one shared browser back
    // to it every single sweep, forever.
    const retryDelay = RESULT_RETRY_MILLISECONDS * Math.min(this.resultMisses.get(task.taskId) || 1, 20);
    if (!force && Date.now() - attemptedAt < retryDelay) return false;

    this.monitorBusy = true;
    try {
      const expectedName = task.resultFilename || `chatgpt-ide-result-${task.taskId}.txt`;
      const chat = await this.backgroundChat(task);
      const current = await chat.current();
      if (typeof this.emitTaskChatSnapshot === 'function') {
        await this.emitTaskChatSnapshot(task, current);
      }
      if (typeof this.updateTaskChatPolling === 'function') {
        this.updateTaskChatPolling(task, current);
      }
      const ready = force || current.run.status !== AI_CHAT_RUN_STATUS.STREAMING;
      if (!ready) return false;
      this.pendingDownload = { kind: 'task', taskId: task.taskId, startedAt: Date.now() };
      const started = await chat.downloadAttachment(expectedName).catch(() => false);
      if (!started) {
        if (this.pendingDownload?.kind === 'task' && this.pendingDownload.taskId === task.taskId) {
          this.pendingDownload = null;
        }
        this.resultAttempts.set(task.taskId, Date.now());
        this.resultMisses.set(task.taskId, (this.resultMisses.get(task.taskId) || 0) + 1);
        return false;
      }
      this.resultMisses.delete(task.taskId);
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
      // Merge polling borrows the shared browser too, so it uses its own chat
      // handle rather than repointing whatever the native transcript shows.
      const chat = this.activeChat?.id === tree.mergeConversationId
        ? this.activeChat
        : tree.mergeConversationId
          ? await this.chatService.openChat({
            id: tree.mergeConversationId,
            workspaceId: tree.chatgptProject?.id || null,
          })
          : null;
      const started = chat && await chat.downloadAttachment(expectedName).catch(() => false);
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
    this.resultMisses.delete(taskId);
    if (this.activeTask?.taskId === taskId) {
      this.activeTask = null;
      this.stopTaskChatPolling();
      this.stopSessionChatPolling();
      this.activeChatMode = null;
    }
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
