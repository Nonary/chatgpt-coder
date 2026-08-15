const fsSync = require('node:fs');
const path = require('node:path');
const { BrowserWindow, WebContentsView, clipboard, dialog, shell } = require('electron');

const CHATGPT_URL = 'https://chatgpt.com/';
const PARTITION = 'persist:patchwork-chatgpt';

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class ChatGPTView {
  constructor(mainWindow, taskService, onResult, onEvent = () => {}) {
    this.mainWindow = mainWindow;
    this.taskService = taskService;
    this.onResult = onResult;
    this.onEvent = onEvent;
    this.activeTask = null;
    this.knownTasks = new Map();
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
    this.view.webContents.loadURL(CHATGPT_URL);
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
    contents.on('did-navigate', (_event, url) => this.onEvent({ type: 'browser-navigated', url }));
    contents.on('page-title-updated', (_event, title) => this.onEvent({ type: 'browser-title', title }));
    contents.on('render-process-gone', (_event, details) => {
      this.onEvent({ type: 'task-failed', message: `The embedded ChatGPT renderer stopped: ${details.reason}` });
    });
  }

  installDownloadListener() {
    this.view.webContents.session.on('will-download', (_event, item) => {
      const originalName = path.basename(item.getFilename());
      const resultMatch = /^chatgpt-ide-result-([0-9a-f-]{36})\.zip$/i.exec(originalName);
      const task = resultMatch ? this.knownTasks.get(resultMatch[1]) : null;
      // Downloads unrelated to an active Patchwork task use Chromium's normal behavior.
      if (!task) return;

      const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '-');
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
          await this.onEvent({
            type: 'task-failed',
            taskId: task.taskId,
            message: `The ChatGPT download ended with status: ${state}`,
          });
          return;
        }
        try {
          await this.onResult(task.taskId, savePath);
        } catch {
          // ResultService emits the detailed validation error.
        }
      });
    });
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
    this.activeTask = task;
    this.knownTasks.set(task.taskId, task);
    clipboard.writeText(task.handoffPrompt);
    await this.newChat();
    this.installResultWatcher();
    await this.onEvent({
      type: 'browser-prepared',
      taskId: task.taskId,
      message: 'A fresh embedded ChatGPT chat is ready for automated submission.',
    });
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
    const query = await debuggerApi.sendCommand('DOM.querySelector', {
      nodeId: documentResult.root.nodeId,
      selector: 'input[type="file"]',
    });
    return query.nodeId || 0;
  }

  async uploadPackage(packagePath) {
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
    } finally {
      if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
    }
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
    this.activeTask = task;
    this.knownTasks.set(task.taskId, task);
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
    const submittedTask = await this.taskService.updateTask(task.taskId, {
      state: 'submitted',
      submittedAt: new Date().toISOString(),
    });
    this.activeTask = submittedTask;
    this.knownTasks.set(task.taskId, submittedTask);
    this.installResultWatcher();
    await this.onEvent({
      type: 'task-submitted',
      task: submittedTask,
      message: 'Task uploaded and submitted through the ChatGPT page.',
    });
    return submittedTask;
  }

  installResultWatcher() {
    if (!this.activeTask || this.view.webContents.isDestroyed()) return;
    const expectedName = `chatgpt-ide-result-${this.activeTask.taskId}.zip`;
    const script = `(() => {
      clearInterval(window.__patchworkResultWatcher);
      const expected = ${JSON.stringify(expectedName.toLowerCase())};
      if (window.__patchworkResultName !== expected) {
        window.__patchworkResultName = expected;
        window.__patchworkResultDownloaded = false;
      }
      window.__patchworkResultWatcher = setInterval(() => {
        const links = [...document.querySelectorAll('a[href], a[download]')];
        const match = links.find((link) => {
          const text = [link.getAttribute('download'), link.textContent, link.getAttribute('href')]
            .filter(Boolean).join(' ').toLowerCase();
          return text.includes(expected);
        });
        if (match && !window.__patchworkResultDownloaded) {
          window.__patchworkResultDownloaded = true;
          match.dataset.patchworkDownloaded = 'true';
          match.click();
        }
      }, 1200);
      return true;
    })()`;
    this.view.webContents.executeJavaScript(script).catch(() => {});
  }

  copyPrompt(task) {
    clipboard.writeText(task.handoffPrompt);
  }

  revealPackage(task) {
    shell.showItemInFolder(task.packagePath);
  }

  async importResult(task) {
    const response = await dialog.showOpenDialog(this.mainWindow, {
      title: 'Choose the result downloaded from ChatGPT',
      properties: ['openFile'],
      filters: [
        { name: 'Patchwork results', extensions: ['zip', 'patch', 'diff'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (response.canceled || response.filePaths.length === 0) return null;
    return this.onResult(task.taskId, response.filePaths[0]);
  }
}

module.exports = { CHATGPT_URL, ChatGPTView };
