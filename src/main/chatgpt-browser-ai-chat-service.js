const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  AIChat,
  AIChatError,
  AI_CHAT_ATTACHMENT_STATUS,
  AI_CHAT_ERROR_CODE,
  AI_CHAT_MESSAGE_ROLE,
  AI_CHAT_RUN_STATUS,
  AIChatService,
} = require('./ai-chat-service');
const { ChatGPTBrowserDriver } = require('./chatgpt-browser-driver');
const { SerialOperationQueue } = require('./serial-operation-queue');

const CHATGPT_HOME = 'https://chatgpt.com/';
const CHAT_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const WORKSPACE_ID_PATTERN = /^g-p-[A-Za-z0-9_-]+$/;
const MODEL_CONFIGURATION = Object.freeze({
  sol: Object.freeze({ default: 'gpt-5-6', instant: 'gpt-5-6-instant', thinking: 'gpt-5-6-thinking' }),
  luna: Object.freeze({ default: 'gpt-5-6-t-mini', instant: 'gpt-5-6-mini', thinking: 'gpt-5-6-t-mini' }),
});
const REASONING_EFFORT = Object.freeze({
  instant: null, low: 'min', medium: 'standard', high: 'extended', 'extra-high': 'max',
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function conversationId(value) {
  try {
    const route = new URL(value).pathname;
    const id = /^\/c\/([^/]+)\/?$/i.exec(route)?.[1]
      || /^\/g\/g-p-[A-Za-z0-9_-]+\/c\/([^/]+)\/?$/i.exec(route)?.[1];
    return CHAT_ID_PATTERN.test(id || '') ? id : null;
  } catch {
    return null;
  }
}

function workspaceId(value) {
  try {
    const routeId = /^\/g\/(g-p-[A-Za-z0-9_-]+)(?:\/|$)/i.exec(new URL(value).pathname)?.[1] || null;
    if (!routeId) return null;
    const parts = routeId.split('-');
    const id = parts.length > 2 && parts[0] === 'g' && parts[1] === 'p'
      ? `g-p-${parts[2]}`
      : routeId;
    return WORKSPACE_ID_PATTERN.test(id) ? id : null;
  } catch {
    return null;
  }
}

function workspaceUrl(workspaceId) {
  if (!WORKSPACE_ID_PATTERN.test(String(workspaceId || ''))) {
    throw new AIChatError(AI_CHAT_ERROR_CODE.INVALID_INPUT, 'The AI workspace ID is invalid.');
  }
  return `${CHATGPT_HOME}g/${workspaceId}/project`;
}

function normalizeConfiguration(input = {}) {
  const model = String(input.model || 'default').toLowerCase();
  const reasoning = String(input.reasoning || 'default').toLowerCase();
  const resolvedModel = model === 'default' ? 'sol' : model;
  if (!MODEL_CONFIGURATION[resolvedModel]) {
    throw new AIChatError(AI_CHAT_ERROR_CODE.INVALID_INPUT, `Unsupported AI chat model: ${input.model}.`);
  }
  if (reasoning !== 'default' && !Object.hasOwn(REASONING_EFFORT, reasoning)) {
    throw new AIChatError(AI_CHAT_ERROR_CODE.INVALID_INPUT, `Unsupported AI chat reasoning mode: ${input.reasoning}.`);
  }
  return { model, reasoning };
}

function providerRequestConfiguration(configuration) {
  const model = configuration.model === 'default' ? 'sol' : configuration.model;
  const option = MODEL_CONFIGURATION[model];
  return {
    modelSlug: configuration.reasoning === 'instant'
      ? option.instant
      : configuration.reasoning === 'default' ? option.default : option.thinking,
    thinkingEffort: configuration.reasoning === 'default'
      ? null
      : REASONING_EFFORT[configuration.reasoning],
  };
}

class ChatGPTBrowserAIChatService extends AIChatService {
  #attachmentsByChat = new Map();
  #browser;
  #operations = new SerialOperationQueue();
  #runStatusByChat = new Map();
  #webContents;

  constructor(webContents, browserDriver = new ChatGPTBrowserDriver(webContents)) {
    super();
    this.#webContents = webContents;
    this.#browser = browserDriver;
  }

  listWorkspaces() {
    return this.#operations.run(() => this.#listWorkspaces());
  }

  async #listWorkspaces() {
    let lastResult = { workspaces: [], authenticationRequired: false };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      lastResult = await this.#browser.listWorkspaces();
      if (lastResult.authenticationRequired && lastResult.workspaces.length === 0) {
        throw new AIChatError(
          AI_CHAT_ERROR_CODE.AUTHENTICATION_REQUIRED,
          'Sign in to the AI session before loading workspaces.',
        );
      }
      if (lastResult.workspaces.length > 0) break;
      if (attempt === 0) await this.#browser.revealWorkspaces?.().catch(() => false);
      await delay(250);
    }
    return lastResult.workspaces
      .map(({ id, name }) => ({ id, name }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  createWorkspace(input) {
    return this.#operations.run(() => this.#createWorkspace(input));
  }

  async #createWorkspace(input) {
    const name = String(input?.name || input || '').trim();
    if (!name) throw new AIChatError(AI_CHAT_ERROR_CODE.INVALID_INPUT, 'Enter a workspace name.');
    await this.#browser.revealWorkspaces?.().catch(() => false);
    let submitted = false;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 10_000) {
      await this.#browser.openCreateWorkspace().catch(() => false);
      const result = await this.#browser.submitCreateWorkspace(name).catch(() => ({ ready: false, submitted: false }));
      if (result.submitted) {
        submitted = true;
        break;
      }
      await delay(250);
    }
    if (!submitted) {
      throw new AIChatError(AI_CHAT_ERROR_CODE.CONTROL_UNAVAILABLE, 'The AI session does not expose workspace creation.');
    }
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const id = workspaceId(this.#webContents.getURL());
      if (id) return { id, name };
      const workspace = (await this.#listWorkspaces()).find((item) => item.name === name);
      if (workspace) return workspace;
      await delay(300);
    }
    throw new AIChatError(AI_CHAT_ERROR_CODE.TIMED_OUT, 'The AI session did not confirm workspace creation.');
  }

  createChat(input = {}) {
    return this.#operations.run(() => this.#createChat(input));
  }

  async #createChat(input = {}) {
    const workspaceId = input.workspaceId || input.workspace?.id || null;
    const target = workspaceId ? workspaceUrl(workspaceId) : CHATGPT_HOME;
    // Electron's reload() does not return a navigation promise. Always using
    // loadURL keeps configuration, attachment, and prompt work on the final document.
    await this.#webContents.loadURL(target);
    const descriptor = {
      id: `pending:${randomUUID()}`,
      workspaceId,
      title: null,
      configuration: normalizeConfiguration(input),
    };
    const chat = this.#chat(descriptor);
    await this.#configure(descriptor);
    return chat;
  }

  openChat(input) {
    return this.#operations.run(() => this.#openChat(input));
  }

  async #openChat(input) {
    const id = String(input?.id || input || '').trim();
    const workspaceId = input?.workspaceId || null;
    if (!CHAT_ID_PATTERN.test(id)) {
      throw new AIChatError(AI_CHAT_ERROR_CODE.INVALID_INPUT, 'The AI chat ID is invalid.');
    }
    const target = workspaceId
      ? `${CHATGPT_HOME}g/${workspaceId}/c/${id}`
      : `${CHATGPT_HOME}c/${id}`;
    if (conversationId(this.#webContents.getURL()) !== id) await this.#webContents.loadURL(target);
    return this.#chat({
      id,
      workspaceId,
      title: input?.title || null,
      configuration: normalizeConfiguration(input || {}),
    });
  }

  reloadSession() {
    return this.#operations.run(() => {
      this.#webContents.reload();
      return true;
    });
  }

  navigateSessionBack() {
    return this.#operations.run(() => {
      if (this.#webContents.navigationHistory.canGoBack()) this.#webContents.navigationHistory.goBack();
      return true;
    });
  }

  navigateSessionForward() {
    return this.#operations.run(() => {
      if (this.#webContents.navigationHistory.canGoForward()) this.#webContents.navigationHistory.goForward();
      return true;
    });
  }

  currentSession() {
    return this.#operations.run(async () => {
      const state = await this.#browser.readSessionState();
      return {
        authenticated: Boolean(state?.authenticated),
        status: state?.authenticated ? 'authenticated' : 'authentication-required',
      };
    });
  }

  recoverSession() {
    return this.#operations.run(() => this.#recoverSession());
  }

  #chat(descriptor) {
    return new AIChat(descriptor, {
      attach: (attachment) => this.#operations.run(() => this.#attach(descriptor, attachment)),
      configure: (configuration) => this.#operations.run(() => this.#configure(descriptor, configuration)),
      send: (message) => this.#operations.run(() => this.#send(descriptor, message)),
      stop: () => this.#operations.run(() => this.#stop(descriptor)),
      current: () => this.#operations.run(() => this.#current(descriptor)),
      downloadAttachment: (name) => this.#operations.run(async () => {
        await this.#ensureOpen(descriptor);
        return this.#browser.downloadAttachment(name);
      }),
    });
  }

  async #attach(descriptor, attachment) {
    await this.#ensureOpen(descriptor);
    const filePath = String(attachment?.path || attachment || '').trim();
    if (!filePath) throw new AIChatError(AI_CHAT_ERROR_CODE.INVALID_INPUT, 'An attachment path is required.');
    const name = String(attachment?.name || path.basename(filePath));
    const tracked = this.#attachmentsByChat.get(descriptor.id) || [];
    const record = tracked.find((item) => item.name === name)
      || { name, status: AI_CHAT_ATTACHMENT_STATUS.UPLOADING };
    record.status = AI_CHAT_ATTACHMENT_STATUS.UPLOADING;
    if (!tracked.includes(record)) tracked.push(record);
    this.#attachmentsByChat.set(descriptor.id, tracked);
    if (!await this.#waitFor(async () => {
      await this.#recoverSession();
      return this.#browser.hasComposer();
    }, 12_000, 350)) {
      record.status = AI_CHAT_ATTACHMENT_STATUS.FAILED;
      throw new AIChatError(AI_CHAT_ERROR_CODE.AUTHENTICATION_REQUIRED, 'The AI session is not ready. Sign in and retry.');
    }
    const existing = await this.#browser.attachmentState(name, { dismissDuplicate: true });
    if (existing.confirmed === true && !existing.busy) {
      record.status = AI_CHAT_ATTACHMENT_STATUS.READY;
      return { ...record };
    }
    if (!await this.#browser.attachFile(filePath, name)) {
      record.status = AI_CHAT_ATTACHMENT_STATUS.FAILED;
      throw new AIChatError(AI_CHAT_ERROR_CODE.CONTROL_UNAVAILABLE, `The AI session could not attach ${name}.`);
    }
    const startedAt = Date.now();
    let consecutiveReadyChecks = 0;
    while (Date.now() - startedAt < 60_000) {
      await this.#recoverSession();
      const state = await this.#browser.attachmentState(name, { dismissDuplicate: true });
      consecutiveReadyChecks = state.confirmed === true && !state.busy ? consecutiveReadyChecks + 1 : 0;
      if (consecutiveReadyChecks >= 2) {
        record.status = AI_CHAT_ATTACHMENT_STATUS.READY;
        return { ...record };
      }
      await delay(500);
    }
    record.status = AI_CHAT_ATTACHMENT_STATUS.FAILED;
    throw new AIChatError(AI_CHAT_ERROR_CODE.TIMED_OUT, `The AI session did not confirm ${name}.`);
  }

  async #send(descriptor, message) {
    await this.#ensureOpen(descriptor);
    const text = String(message?.text ?? message ?? '').trim();
    if (!text) throw new AIChatError(AI_CHAT_ERROR_CODE.INVALID_INPUT, 'A message is required.');
    if (!await this.#waitFor(async () => {
      await this.#recoverSession();
      return this.#browser.hasComposer();
    }, 12_000, 350)) {
      throw new AIChatError(AI_CHAT_ERROR_CODE.AUTHENTICATION_REQUIRED, 'The AI session is not ready. Sign in and retry.');
    }
    await this.#configure(descriptor);
    const inserted = await this.#browser.insertPrompt(text);
    const promptConfirmed = inserted?.present || await this.#waitFor(
      async () => (await this.#browser.promptState(text)).present,
      5_000,
      100,
    );
    if (!promptConfirmed) {
      throw new AIChatError(AI_CHAT_ERROR_CODE.CONTROL_UNAVAILABLE, 'The AI session did not retain the complete prompt.');
    }
    const messageAttachments = Array.isArray(message?.attachments) ? message.attachments : [];
    for (const attachment of messageAttachments) await this.#attach(descriptor, attachment);
    const selected = await this.#browser.readConfigurationPicker();
    if (selected) descriptor.configuration = normalizeConfiguration(selected);
    const requestConfiguration = providerRequestConfiguration(descriptor.configuration);
    let requestOverride;
    try {
      const expectedAttachments = (this.#attachmentsByChat.get(descriptor.id) || [])
        .filter(({ status }) => status === AI_CHAT_ATTACHMENT_STATUS.READY)
        .map(({ name }) => name);
      requestOverride = await this.#browser.interceptNextConversationRequest(requestConfiguration, {
        prompt: text,
        attachments: expectedAttachments,
      });
      if (!await this.#waitFor(async () => {
        await this.#recoverSession();
        return (await this.#browser.sendState()).enabled;
      }, 60_000, 500)) {
        throw new AIChatError(AI_CHAT_ERROR_CODE.TIMED_OUT, 'The AI session did not enable Send.');
      }
      if (!(await this.#browser.promptState(text)).present) {
        throw new AIChatError(AI_CHAT_ERROR_CODE.CONTROL_UNAVAILABLE, 'The confirmed prompt disappeared before Send.');
      }
      if (!(await this.#browser.clickSend()).enabled) {
        throw new AIChatError(AI_CHAT_ERROR_CODE.CONTROL_UNAVAILABLE, 'The AI session did not accept Send.');
      }
      await requestOverride.wait();
    } catch (error) {
      if (error instanceof AIChatError) throw error;
      throw new AIChatError(
        AI_CHAT_ERROR_CODE.PROVIDER_ERROR,
        `The AI chat configuration could not be applied: ${error.message}`,
        { cause: error },
      );
    } finally {
      await requestOverride?.dispose();
    }
    const id = await this.#waitForValue(() => conversationId(this.#webContents.getURL()), 30_000, 250);
    if (!id) throw new AIChatError(AI_CHAT_ERROR_CODE.TIMED_OUT, 'The AI session did not create a chat after Send.');
    const previousId = descriptor.id;
    descriptor.id = id;
    descriptor.title = this.#webContents.getTitle?.() || null;
    if (this.#attachmentsByChat.has(previousId)) {
      this.#attachmentsByChat.set(id, this.#attachmentsByChat.get(previousId));
      this.#attachmentsByChat.delete(previousId);
    }
    this.#runStatusByChat.delete(previousId);
    this.#runStatusByChat.set(id, AI_CHAT_RUN_STATUS.STREAMING);
    return {
      chatId: id,
      status: AI_CHAT_RUN_STATUS.STREAMING,
      error: null,
      configuration: { ...descriptor.configuration },
    };
  }

  async #stop(descriptor) {
    await this.#ensureOpen(descriptor);
    const stopped = await this.#browser.stopRun();
    if (stopped) this.#runStatusByChat.set(descriptor.id, AI_CHAT_RUN_STATUS.STOPPED);
    return { status: stopped ? AI_CHAT_RUN_STATUS.STOPPED : AI_CHAT_RUN_STATUS.UNKNOWN, error: null };
  }

  async #current(descriptor) {
    await this.#ensureOpen(descriptor);
    const [content, run] = await Promise.all([
      this.#browser.readChatSnapshot(),
      this.#browser.readRunStatus(),
    ]);
    const messages = (content.messages || []).map((message) => ({
      id: String(message.id),
      role: Object.values(AI_CHAT_MESSAGE_ROLE).includes(message.role) ? message.role : AI_CHAT_MESSAGE_ROLE.ASSISTANT,
      text: String(message.content || ''),
    }));
    const rememberedRunStatus = this.#runStatusByChat.get(descriptor.id);
    const runStatus = rememberedRunStatus === AI_CHAT_RUN_STATUS.STOPPED && run.status === AI_CHAT_RUN_STATUS.COMPLETED
      ? AI_CHAT_RUN_STATUS.STOPPED
      : run.status;
    this.#runStatusByChat.set(descriptor.id, runStatus);
    descriptor.title = this.#webContents.getTitle?.() || descriptor.title || null;
    const attachments = new Map();
    for (const attachment of content.attachments || []) {
      if (attachment?.name) attachments.set(attachment.name, {
        name: String(attachment.name),
        status: Object.values(AI_CHAT_ATTACHMENT_STATUS).includes(attachment.status)
          ? attachment.status
          : AI_CHAT_ATTACHMENT_STATUS.READY,
      });
    }
    for (const attachment of this.#attachmentsByChat.get(descriptor.id) || []) {
      attachments.set(attachment.name, { ...attachment });
    }
    return {
      id: descriptor.id,
      title: descriptor.title,
      messages,
      thinkingSummary: content.thinkingSummary || null,
      attachments: [...attachments.values()],
      run: {
        status: runStatus,
        error: runStatus === AI_CHAT_RUN_STATUS.FAILED
          ? { code: AI_CHAT_ERROR_CODE.PROVIDER_ERROR, message: 'The AI provider reported an error.' }
          : null,
      },
    };
  }

  async #ensureOpen(descriptor) {
    if (!CHAT_ID_PATTERN.test(descriptor.id) || conversationId(this.#webContents.getURL()) === descriptor.id) return;
    const target = descriptor.workspaceId
      ? `${CHATGPT_HOME}g/${descriptor.workspaceId}/c/${descriptor.id}`
      : `${CHATGPT_HOME}c/${descriptor.id}`;
    await this.#webContents.loadURL(target);
  }

  async #configure(descriptor, nextConfiguration = null) {
    if (nextConfiguration) descriptor.configuration = normalizeConfiguration(nextConfiguration);
    const installed = await this.#browser.installConfigurationPicker({
      chatKey: descriptor.id,
      modelConfigurations: MODEL_CONFIGURATION,
      ...descriptor.configuration,
    });
    if (installed) descriptor.configuration = normalizeConfiguration(installed);
    return { ...descriptor.configuration };
  }

  async #recoverSession() {
    const recovery = await this.#browser.dismissBlockingNotice();
    return {
      resolved: Boolean(recovery?.resolved),
      notice: recovery?.notice ? String(recovery.notice) : null,
    };
  }

  async #waitFor(check, timeout, interval) {
    return Boolean(await this.#waitForValue(async () => await check() ? true : null, timeout, interval));
  }

  async #waitForValue(read, timeout, interval) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      let value = null;
      try { value = await read(); } catch {}
      if (value) return value;
      await delay(interval);
    }
    return null;
  }
}

module.exports = {
  ChatGPTBrowserAIChatService,
  normalizeConfiguration,
  providerRequestConfiguration,
};
