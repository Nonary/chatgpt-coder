const fsSync = require('node:fs');
const path = require('node:path');
const { BrowserWindow, WebContentsView, clipboard, dialog, shell } = require('electron');
const { mergeResultFilename } = require('./worktree-service');

const CHATGPT_URL = 'https://chatgpt.com/';
const PARTITION = 'persist:patchwork-chatgpt';
const RESULT_NAME_PATTERN = /chatgpt-ide-result-([0-9a-f-]{36})(?:\s*\(\d+\))?\.txt/i;
const RESULT_RETRY_MILLISECONDS = 6_000;
const NOTICE_EVENT_COOLDOWN_MILLISECONDS = 60_000;
const SUBMISSION_CONFIRMATION_TIMEOUT_MILLISECONDS = 30_000;
const DISMISSIBLE_LIMIT_NOTICE = /(?:too many requests|messages? limit reached|usage (?:limit|cap) (?:reached|exceeded)|rate limit (?:reached|exceeded)|you(?:['’]ve| have) (?:reached|hit) (?:the |your )?(?:current |daily |monthly |plan )?(?:message |messages |usage |rate |chatgpt )?(?:limit|cap))/i;
const DISMISSIVE_NOTICE_ACTION = /^(?:got it|close|dismiss|ok|okay)$/i;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resultTaskId(filename) {
  return RESULT_NAME_PATTERN.exec(path.basename(String(filename || '')))?.[1]?.toLowerCase() || null;
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
      && /^\/c\/[^/]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

async function recoverUnconfirmedSubmissions(taskService, tasks) {
  return Promise.all(tasks.map((task) => {
    if (task.state !== 'submitted' || isChatGPTConversationUrl(task.conversationUrl)) return task;
    return taskService.updateTask(task.taskId, {
      state: 'prepared',
      submittedAt: null,
      conversationUrl: null,
    });
  }));
}

function isDismissibleLimitNotice(value) {
  return DISMISSIBLE_LIMIT_NOTICE.test(String(value || '').replace(/\s+/g, ' ').trim());
}

function buildLimitNoticeDismissalScript() {
  return `(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const noticePattern = new RegExp(${JSON.stringify(DISMISSIBLE_LIMIT_NOTICE.source)}, 'i');
    const actionPattern = new RegExp(${JSON.stringify(DISMISSIVE_NOTICE_ACTION.source)}, 'i');
    const exactModal = document.querySelector('[data-testid="modal-conversation-history-rate-limit"]');
    const containers = [
      exactModal,
      ...document.querySelectorAll([
        '[role="alertdialog"]',
        '[role="dialog"]',
        '[role="alert"]',
        '[data-sonner-toast]',
        '[data-testid*="toast"]',
      ].join(', ')),
    ].filter((item, index, all) => item && all.indexOf(item) === index);
    for (const container of containers) {
      const notice = normalize(container.textContent);
      if (container !== exactModal && !noticePattern.test(notice)) continue;
      const actions = [...container.querySelectorAll('button, [role="button"]')];
      const enabledActions = actions.filter((item) => (
        !item.disabled && item.getAttribute('aria-disabled') !== 'true'
      ));
      const button = enabledActions.find((item) => {
        const visibleText = normalize(item.textContent);
        const accessibleLabel = normalize([
          item.getAttribute('aria-label'),
          item.getAttribute('title'),
          item.getAttribute('data-testid'),
        ].filter(Boolean).join(' '));
        return actionPattern.test(visibleText) || /(?:close|dismiss)/i.test(accessibleLabel);
      }) || (container === exactModal ? enabledActions[0] : null);
      if (!button) continue;
      const action = normalize(button.textContent || button.getAttribute('aria-label'));
      button.click();
      return { dismissed: true, notice: notice.slice(0, 240), action };
    }
    return { dismissed: false };
  })()`;
}

function buildTaskResultDetectionScript(taskId) {
  const expectedName = `chatgpt-ide-result-${taskId}.txt`;
  return `(() => {
    const expected = ${JSON.stringify(expectedName.toLowerCase())};
    const stopButton = document.querySelector('[data-testid="stop-button"]');
    if (stopButton && !stopButton.disabled && stopButton.getAttribute('aria-disabled') !== 'true') {
      return { kind: 'generating' };
    }
    const roots = [document];
    const candidates = [];
    const visited = new Set();
    while (roots.length) {
      const root = roots.shift();
      if (!root || visited.has(root)) continue;
      visited.add(root);
      candidates.push(...root.querySelectorAll('a[href], a[download], button, [role="link"], [role="button"]'));
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    const match = candidates.find((element) => {
      const label = [
        element.getAttribute('download'),
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.textContent,
        element.getAttribute('href'),
      ].filter(Boolean).join(' ').toLowerCase();
      return label.includes(expected);
    });
    if (!match) return { kind: 'none' };
    match.scrollIntoView({ block: 'center', inline: 'center' });
    match.click();
    return { kind: 'download', label: String(match.textContent || match.getAttribute('aria-label') || '').trim() };
  })()`;
}

function buildMergeResultDetectionScript(treeId) {
  const expectedName = mergeResultFilename(treeId);
  return `(() => {
    const expected = ${JSON.stringify(expectedName.toLowerCase())};
    const stopButton = document.querySelector('[data-testid="stop-button"]');
    if (stopButton && !stopButton.disabled && stopButton.getAttribute('aria-disabled') !== 'true') {
      return { kind: 'generating' };
    }
    const roots = [document];
    const candidates = [];
    const visited = new Set();
    while (roots.length) {
      const root = roots.shift();
      if (!root || visited.has(root)) continue;
      visited.add(root);
      candidates.push(...root.querySelectorAll('a[href], a[download], button, [role="link"], [role="button"]'));
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    const match = candidates.find((element) => {
      const label = [
        element.getAttribute('download'),
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.textContent,
        element.getAttribute('href'),
      ].filter(Boolean).join(' ').toLowerCase();
      return label.includes(expected);
    });
    if (!match) return { kind: 'none' };
    match.scrollIntoView({ block: 'center', inline: 'center' });
    match.click();
    return { kind: 'download', label: String(match.textContent || match.getAttribute('aria-label') || '').trim() };
  })()`;
}

class ChatGPTView {
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
    this.mainWindow = mainWindow;
    this.taskService = taskService;
    this.onResult = onResult;
    this.onEvent = onEvent;
    this.worktreeService = worktreeService;
    this.onMergeResult = onMergeResult;
    this.knownTasks = new Map(restoredTasks
      .filter((task) => !['applied', 'rolled-back'].includes(task.state))
      .map((task) => [task.taskId.toLowerCase(), task]));
    this.activeTask = restoredTasks
      .filter((task) => task.state === 'submitted' && isChatGPTConversationUrl(task.conversationUrl))
      .sort((left, right) => String(right.updatedAt || right.createdAt)
      .localeCompare(String(left.updatedAt || left.createdAt)))[0] || null;
    this.activeMerge = restoredTrees
      .filter((tree) => tree.mergeState === 'submitted')
      .sort((left, right) => String(right.updatedAt || right.createdAt)
        .localeCompare(String(left.updatedAt || left.createdAt)))[0] || null;
    this.resultAttempts = new Map();
    this.pendingDownload = null;
    this.processingTasks = new Set();
    this.monitorBusy = false;
    this.dismissalBusy = false;
    this.dismissedNoticeEvents = new Map();
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
    this.installNavigationHandlers();
    this.installDownloadListener();
    this.installMergeDownloadListener();
    this.resultMonitor = setInterval(() => this.monitorPage().catch(() => {}), 1_500);
    this.resultMonitor.unref?.();
    this.mainWindow.once('closed', () => clearInterval(this.resultMonitor));
    this.view.webContents.loadURL(
      this.activeMerge?.mergeConversationUrl || this.activeTask?.conversationUrl || CHATGPT_URL,
    );
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
    contents.on('dom-ready', () => this.installResultWatcher());
    contents.on('did-navigate', (_event, url) => this.handleNavigation(url));
    contents.on('did-navigate-in-page', (_event, url) => this.handleNavigation(url));
    contents.on('page-title-updated', (_event, title) => this.onEvent({ type: 'browser-title', title }));
    contents.on('render-process-gone', (_event, details) => {
      this.onEvent({ type: 'task-failed', message: `The embedded ChatGPT renderer stopped: ${details.reason}` });
    });
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
      const safeName = `chatgpt-ide-result-${task.taskId}.txt`;
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
        if (state !== 'completed') {
          this.processingTasks.delete(task.taskId);
          await this.onEvent({
            type: 'task-failed',
            taskId: task.taskId,
            message: `The ChatGPT download ended with status: ${state}`,
          });
          return;
        }
        try {
          await this.onResult(task.taskId, savePath, 'text-file');
          this.knownTasks.delete(task.taskId.toLowerCase());
          if (this.activeTask?.taskId === task.taskId) this.activeTask = null;
        } catch {
          // ResultService emits the detailed validation error.
        } finally {
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
    if (this.activeMerge && isChatGPTConversationUrl(url)) {
      if (this.activeMerge.mergeConversationUrl !== url && this.worktreeService) {
        const treeId = this.activeMerge.id;
        this.worktreeService.markMergeSubmitted(treeId, url).then((tree) => {
          if (this.activeMerge?.id === treeId) this.activeMerge = tree;
        }).catch(() => {});
      }
      return;
    }
    if (!this.activeTask || !['prepared', 'submitted'].includes(this.activeTask.state)) return;
    if (!/^https:\/\/chatgpt\.com\/c\//i.test(url)) return;
    if (this.activeTask.conversationUrl === url) return;
    const taskId = this.activeTask.taskId;
    this.taskService.updateTask(taskId, { conversationUrl: url }).then((task) => {
      if (this.activeTask?.taskId === taskId) this.activeTask = task;
      this.knownTasks.set(taskId.toLowerCase(), task);
    }).catch(() => {});
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
    await this.newChat();
    this.installResultWatcher();
    await this.onEvent({
      type: 'browser-prepared',
      taskId: task.taskId,
      message: 'A fresh embedded ChatGPT chat is ready for automated submission.',
    });
  }

  async openTaskConversation(task) {
    if (!isChatGPTConversationUrl(task?.conversationUrl)) {
      throw new Error('This task has an invalid saved ChatGPT conversation URL.');
    }
    this.activeMerge = null;
    this.activeTask = task;
    this.knownTasks.set(task.taskId.toLowerCase(), task);
    if (this.view.webContents.getURL() !== task.conversationUrl) {
      await this.view.webContents.loadURL(task.conversationUrl);
    }
    this.installResultWatcher();
    await this.onEvent({
      type: 'task-chat-opened',
      taskId: task.taskId,
      message: 'Opened this task’s saved ChatGPT conversation.',
    });
    return { opened: true, task };
  }

  async newChat() {
    if (this.view.webContents.getURL() !== CHATGPT_URL) {
      await this.view.webContents.loadURL(CHATGPT_URL);
    } else {
      await this.view.webContents.reload();
    }
    return true;
  }

  async reload() {
    this.view.webContents.reload();
    return true;
  }

  async goBack() {
    if (this.view.webContents.navigationHistory.canGoBack()) {
      this.view.webContents.navigationHistory.goBack();
    }
    return true;
  }

  async goForward() {
    if (this.view.webContents.navigationHistory.canGoForward()) {
      this.view.webContents.navigationHistory.goForward();
    }
    return true;
  }

  async waitForComposer(timeoutMilliseconds = 12_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMilliseconds) {
      const found = await this.view.webContents.executeJavaScript(`Boolean(
        document.querySelector('#prompt-textarea') ||
        document.querySelector('[data-testid="prompt-textarea"]') ||
        document.querySelector('textarea[placeholder]') ||
        document.querySelector('[contenteditable="true"][role="textbox"]')
      )`).catch(() => false);
      if (found) return true;
      await delay(350);
    }
    return false;
  }

  async injectPrompt(prompt) {
    const script = `(() => {
      const composer =
        document.querySelector('#prompt-textarea') ||
        document.querySelector('[data-testid="prompt-textarea"]') ||
        document.querySelector('textarea[placeholder]') ||
        document.querySelector('[contenteditable="true"][role="textbox"]');
      if (!composer) return { ok: false, reason: 'composer-not-found' };
      const prompt = ${JSON.stringify(prompt)};
      composer.focus();
      if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
        const prototype = composer instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
        setter.call(composer, prompt);
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        composer.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(composer);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('insertText', false, prompt);
        composer.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: prompt,
        }));
      }
      return { ok: true };
    })()`;
    const result = await this.view.webContents.executeJavaScript(script, true);
    if (!result?.ok) throw new Error('Could not find ChatGPT’s prompt composer. Reload the embedded browser and try again.');
  }

  async findFileInputNodeId() {
    const debuggerApi = this.view.webContents.debugger;
    const documentResult = await debuggerApi.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    for (const selector of [
      '#upload-files',
      'input[type="file"][multiple]:not([accept="image/*"])',
      'input[type="file"]',
    ]) {
      const query = await debuggerApi.sendCommand('DOM.querySelector', {
        nodeId: documentResult.root.nodeId,
        selector,
      });
      if (query.nodeId) return query.nodeId;
    }
    return 0;
  }

  async uploadPackage(packagePath) {
    const filename = path.basename(packagePath);
    const existingAttachment = await this.packageAttachmentStatus(filename, true);
    if (existingAttachment.attached && !existingAttachment.busy) return true;
    const debuggerApi = this.view.webContents.debugger;
    let attachedHere = false;
    try {
      if (!debuggerApi.isAttached()) {
        debuggerApi.attach('1.3');
        attachedHere = true;
      }
      let nodeId = await this.findFileInputNodeId();
      if (!nodeId) {
        await this.view.webContents.executeJavaScript(`(() => {
          const candidates = [...document.querySelectorAll('button')];
          const button =
            document.querySelector('[data-testid="composer-plus-btn"]') ||
            document.querySelector('[data-testid*="attach"]') ||
            candidates.find((item) => /attach|add files|upload/i.test([
              item.getAttribute('aria-label'), item.getAttribute('title'), item.textContent,
            ].filter(Boolean).join(' ')));
          if (button) button.click();
          return Boolean(button);
        })()`, true);
        await delay(500);
        nodeId = await this.findFileInputNodeId();
      }
      if (!nodeId) {
        throw new Error('Could not locate ChatGPT’s attachment input. Attach the package manually or reload and retry.');
      }
      await debuggerApi.sendCommand('DOM.setFileInputFiles', {
        files: [packagePath],
        nodeId,
      });
      const eventDispatched = await this.view.webContents.executeJavaScript(`(() => {
        const filename = ${JSON.stringify(filename)};
        const input = [...document.querySelectorAll('input[type="file"]')]
          .find((element) => [...element.files].some((file) => file.name === filename));
        if (!input) return false;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`, true);
      if (!eventDispatched) throw new Error('ChatGPT did not accept the selected task package. Nothing was submitted.');
    } finally {
      if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
    }
    await this.waitForPackageAttachment(path.basename(packagePath));
  }

  async packageAttachmentStatus(filename, dismissDuplicateNotice = false) {
    return this.view.webContents.executeJavaScript(`(() => {
      const filename = ${JSON.stringify(filename)};
      const visible = (element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0;
      };
      const notices = [...document.querySelectorAll('[role="dialog"], [role="alert"], [aria-live]')]
        .filter(visible);
      const duplicateNotice = notices.find((element) => /already (?:been )?uploaded|already uploaded|duplicate file/i.test(
        [element.textContent, element.getAttribute('aria-label')].filter(Boolean).join(' '),
      ));
      let dismissedDuplicate = false;
      if (duplicateNotice && ${Boolean(dismissDuplicateNotice)}) {
        const buttons = [...duplicateNotice.querySelectorAll('button')];
        const dismiss = buttons.find((button) => /^(?:got it|close|dismiss|ok|okay)$/i.test([
          button.textContent, button.getAttribute('aria-label'), button.getAttribute('title'),
        ].filter(Boolean).join(' ').trim()))
          || duplicateNotice.querySelector('button[data-testid*="close"], button[aria-label="Close"]');
        if (dismiss) {
          dismiss.click();
          dismissedDuplicate = true;
        }
      }
      const candidates = [...document.querySelectorAll(
        '[data-testid*="file"], [data-testid*="attach"], [aria-label], [title], span, div'
      )].filter(visible);
      const attachment = candidates.find((element) => [
        element.textContent,
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
      ].filter(Boolean).some((value) => String(value).includes(filename)));
      if (!attachment) return {
        attached: false,
        busy: false,
        duplicateNotice: Boolean(duplicateNotice),
        dismissedDuplicate,
      };
      const card = attachment.closest('[data-testid*="file"], [data-testid*="attach"]') || attachment.parentElement;
      const statusText = [card?.textContent, card?.getAttribute?.('aria-label')].filter(Boolean).join(' ');
      const busy = /uploading|processing|attaching/i.test(statusText)
        || Boolean(card?.querySelector?.('[role="progressbar"], progress, [aria-busy="true"]'));
      return {
        attached: true,
        busy,
        duplicateNotice: Boolean(duplicateNotice),
        dismissedDuplicate,
      };
    })()`, true).catch(() => ({
      attached: false,
      busy: false,
      duplicateNotice: false,
      dismissedDuplicate: false,
    }));
  }

  async waitForPackageAttachment(filename, timeoutMilliseconds = 60_000) {
    const startedAt = Date.now();
    let consecutiveReadyChecks = 0;
    while (Date.now() - startedAt < timeoutMilliseconds) {
      const status = await this.packageAttachmentStatus(filename, true);
      consecutiveReadyChecks = status.attached && !status.busy ? consecutiveReadyChecks + 1 : 0;
      if (consecutiveReadyChecks >= 2) return true;
      await delay(500);
    }
    throw new Error(`ChatGPT did not confirm the attachment ${filename}. Nothing was submitted; reload the embedded browser and try again.`);
  }

  async waitForConversationUrl(timeoutMilliseconds = SUBMISSION_CONFIRMATION_TIMEOUT_MILLISECONDS) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMilliseconds) {
      const url = this.view.webContents.getURL();
      if (isChatGPTConversationUrl(url)) return url;
      await delay(250);
    }
    return null;
  }

  async clickSend(timeoutMilliseconds = 60_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMilliseconds) {
      const result = await this.view.webContents.executeJavaScript(`(() => {
        const candidates = [...document.querySelectorAll('button')];
        const button =
          document.querySelector('[data-testid="send-button"]') ||
          candidates.find((item) => /send prompt|send message|^send$/i.test([
            item.getAttribute('aria-label'), item.getAttribute('title'), item.textContent,
          ].filter(Boolean).join(' ').trim()));
        if (!button) return { found: false, enabled: false };
        if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
          return { found: true, enabled: false };
        }
        button.click();
        return { found: true, enabled: true };
      })()`, true).catch(() => ({ found: false, enabled: false }));
      if (result.enabled) return true;
      await delay(500);
    }
    throw new Error('ChatGPT did not enable the Send button. The attachment may still be uploading.');
  }

  async submit(task) {
    this.activeMerge = null;
    this.activeTask = task;
    this.knownTasks.set(task.taskId.toLowerCase(), task);
    await this.onEvent({
      type: 'automation-started',
      taskId: task.taskId,
      message: 'Injecting the task into the embedded ChatGPT composer…',
    });
    const composerReady = await this.waitForComposer();
    if (!composerReady) {
      await this.onEvent({
        type: 'browser-login-required',
        taskId: task.taskId,
        message: 'Sign in to ChatGPT in the embedded browser, then choose Submit automatically.',
      });
      throw new Error('ChatGPT is not ready. Sign in inside the embedded browser and retry.');
    }
    await this.injectPrompt(task.handoffPrompt);
    await this.uploadPackage(task.packagePath);
    await this.clickSend();
    const conversationUrl = await this.waitForConversationUrl();
    if (!conversationUrl) {
      await this.onEvent({
        type: 'task-submit-unconfirmed',
        taskId: task.taskId,
        message: 'ChatGPT did not create a conversation after Send, so the task was not marked submitted.',
      });
      throw new Error('Patchwork could not confirm a ChatGPT conversation after Send. Check the embedded browser before retrying.');
    }
    const submittedTask = await this.taskService.updateTask(task.taskId, {
      state: 'submitted',
      submittedAt: new Date().toISOString(),
      conversationUrl,
    });
    this.activeTask = submittedTask;
    this.knownTasks.set(task.taskId.toLowerCase(), submittedTask);
    this.installResultWatcher();
    await this.onEvent({
      type: 'task-submitted',
      task: submittedTask,
      message: 'Task uploaded and submitted through the ChatGPT page.',
    });
    return submittedTask;
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
    await this.newChat();
    const composerReady = await this.waitForComposer();
    if (!composerReady) throw new Error('ChatGPT is not ready. Sign in inside the embedded browser and retry.');
    await this.injectPrompt(request.prompt);
    await this.clickSend();
    this.activeMerge = await this.worktreeService.markMergeSubmitted(request.treeId);
    await this.onEvent({
      type: 'merge-submitted',
      treeId: request.treeId,
      message: 'ChatGPT is preparing the squash commit message.',
    });
    return true;
  }

  installResultWatcher() {
    if (this.view.webContents.isDestroyed()) return;
    this.monitorPage().catch(() => {});
  }

  async monitorPage() {
    await this.dismissBlockingLimitNotice();
    return this.checkForResult();
  }

  async dismissBlockingLimitNotice() {
    if (this.dismissalBusy || this.view.webContents.isDestroyed()) return false;
    this.dismissalBusy = true;
    try {
      const result = await this.view.webContents.executeJavaScript(
        buildLimitNoticeDismissalScript(),
        true,
      ).catch(() => ({ dismissed: false }));
      if (!result?.dismissed) return false;

      const eventKey = String(result.notice || 'limit-notice').toLowerCase();
      const lastEventAt = this.dismissedNoticeEvents.get(eventKey) || 0;
      if (Date.now() - lastEventAt >= NOTICE_EVENT_COOLDOWN_MILLISECONDS) {
        this.dismissedNoticeEvents.set(eventKey, Date.now());
        await this.onEvent({
          type: 'browser-notice-dismissed',
          message: 'Dismissed ChatGPT’s temporary request-limit notice; background monitoring continues.',
        });
      }
      return true;
    } finally {
      this.dismissalBusy = false;
    }
  }

  async checkForResult() {
    if (this.activeMerge) return this.checkForMerge();
    const task = this.activeTask;
    if (this.monitorBusy || !task || task.state !== 'submitted') return false;
    if (this.processingTasks.has(task.taskId) || this.view.webContents.isDestroyed()) return false;
    const attemptedAt = this.resultAttempts.get(task.taskId) || 0;
    if (Date.now() - attemptedAt < RESULT_RETRY_MILLISECONDS) return false;

    this.monitorBusy = true;
    try {
      const expectedName = `chatgpt-ide-result-${task.taskId}.txt`;
      const script = `(() => {
        const expected = ${JSON.stringify(expectedName.toLowerCase())};
        const roots = [document];
        const candidates = [];
        const visited = new Set();
        while (roots.length) {
          const root = roots.shift();
          if (!root || visited.has(root)) continue;
          visited.add(root);
          candidates.push(...root.querySelectorAll('a[href], a[download], button, [role="link"], [role="button"]'));
          for (const element of root.querySelectorAll('*')) {
            if (element.shadowRoot) roots.push(element.shadowRoot);
          }
        }
        const match = candidates.find((element) => {
          const label = [
            element.getAttribute('download'),
            element.getAttribute('aria-label'),
            element.getAttribute('title'),
            element.textContent,
            element.getAttribute('href'),
          ].filter(Boolean).join(' ').toLowerCase();
          return label.includes(expected);
        });
        if (!match) return { kind: 'none' };
        match.scrollIntoView({ block: 'center', inline: 'center' });
        match.click();
        return { kind: 'download', label: String(match.textContent || match.getAttribute('aria-label') || '').trim() };
      })()`;
      // A fresh, synchronous user gesture is required for ChatGPT's generated-file link.
      // A click fired later by a page-owned timer can be silently blocked by Chromium.
      const result = await this.view.webContents.executeJavaScript(script, true).catch(() => ({ kind: 'none' }));
      if (result?.kind !== 'download') return false;
      this.resultAttempts.set(task.taskId, Date.now());
      this.pendingDownload = { kind: 'task', taskId: task.taskId, startedAt: Date.now() };
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

  async checkForMerge() {
    const tree = this.activeMerge;
    if (this.monitorBusy || !tree || tree.mergeState !== 'submitted') return false;
    if (this.pendingDownload?.kind === 'merge' && this.pendingDownload.treeId === tree.id) return false;
    this.monitorBusy = true;
    try {
      const result = await this.view.webContents.executeJavaScript(
        buildMergeResultDetectionScript(tree.id),
        true,
      ).catch(() => ({ kind: 'none' }));
      if (result?.kind !== 'download') return false;
      this.pendingDownload = { kind: 'merge', treeId: tree.id, startedAt: Date.now() };
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
    clipboard.writeText(task.handoffPrompt);
  }

  revealPackage(task) {
    shell.showItemInFolder(task.packagePath);
  }

  async finishTaskResult(task, result, transport) {
    const completed = await this.onResult(task.taskId, result, transport);
    this.knownTasks.delete(task.taskId.toLowerCase());
    if (this.activeTask?.taskId === task.taskId) this.activeTask = null;
    return completed;
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
    if (selectedPath.toLowerCase().endsWith('.txt')) return this.onResult(task.taskId, selectedPath, 'text-file');
    return this.onResult(task.taskId, selectedPath);
  }
}

module.exports = {
  CHATGPT_URL,
  ChatGPTView,
  buildLimitNoticeDismissalScript,
  buildMergeResultDetectionScript,
  buildTaskResultDetectionScript,
  isChatGPTConversationUrl,
  isDismissibleLimitNotice,
  recoverUnconfirmedSubmissions,
  mergeTreeId,
  resultTaskId,
};
