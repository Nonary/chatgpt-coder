const AI_CHAT_RUN_STATUS = Object.freeze({
  UNKNOWN: 'unknown',
  STREAMING: 'streaming',
  COMPLETED: 'completed',
  STOPPED: 'stopped',
  FAILED: 'failed',
});

const AI_CHAT_ATTACHMENT_STATUS = Object.freeze({
  MISSING: 'missing',
  UPLOADING: 'uploading',
  READY: 'ready',
  FAILED: 'failed',
});

const AI_CHAT_MESSAGE_ROLE = Object.freeze({
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system',
});

const AI_CHAT_ERROR_CODE = Object.freeze({
  AUTHENTICATION_REQUIRED: 'authentication-required',
  CONTROL_UNAVAILABLE: 'control-unavailable',
  INVALID_INPUT: 'invalid-input',
  PROVIDER_ERROR: 'provider-error',
  TIMED_OUT: 'timed-out',
});

/**
 * @typedef {'unknown'|'streaming'|'completed'|'stopped'|'failed'} AIChatRunStatus
 * @typedef {'missing'|'uploading'|'ready'|'failed'} AIChatAttachmentStatus
 * @typedef {'user'|'assistant'|'system'} AIChatMessageRole
 * @typedef {'authentication-required'|'control-unavailable'|'invalid-input'|'provider-error'|'timed-out'} AIChatErrorCode
 * @typedef {{id: string, name: string}} AIChatWorkspace
 * @typedef {{name: string, status: AIChatAttachmentStatus}} AIChatAttachment
 * @typedef {{id: string, role: AIChatMessageRole, text: string}} AIChatMessage
 * @typedef {{model: string, reasoning: string}} AIChatConfiguration
 * @typedef {{
 *   status: AIChatRunStatus,
 *   error: null|{code: AIChatErrorCode, message: string},
 *   configuration?: AIChatConfiguration,
 * }} AIChatRun
 * @typedef {{authenticated: boolean, status: 'authenticated'|'authentication-required'}} AIChatSession
 * @typedef {{resolved: boolean, notice: string|null}} AIChatSessionRecovery
 * @typedef {{
 *   id: string,
 *   title: string|null,
 *   messages: AIChatMessage[],
 *   thinkingSummary: string|null,
 *   attachments: AIChatAttachment[],
 *   run: AIChatRun,
 * }} AIChatSnapshot
 */

class AIChatError extends Error {
  constructor(code, message, options) {
    super(message, options);
    if (!Object.values(AI_CHAT_ERROR_CODE).includes(code)) throw new TypeError('Unknown AI chat error code.');
    this.name = 'AIChatError';
    this.code = code;
  }
}

class AIChat {
  #descriptor;
  #operations;

  constructor(descriptor, operations) {
    if (!descriptor?.id) throw new TypeError('AIChat requires a stable ID.');
    if (!operations
      || typeof operations.attach !== 'function'
      || typeof operations.configure !== 'function'
      || typeof operations.send !== 'function'
      || typeof operations.stop !== 'function'
      || typeof operations.current !== 'function'
      || typeof operations.downloadAttachment !== 'function') {
      throw new TypeError('AIChat requires a complete implementation.');
    }
    this.#descriptor = descriptor;
    this.#operations = operations;
  }

  get id() { return this.#descriptor.id; }

  get workspaceId() { return this.#descriptor.workspaceId || null; }

  get title() { return this.#descriptor.title || null; }

  get configuration() { return { ...this.#descriptor.configuration }; }

  attach(attachment) {
    return this.#operations.attach(attachment);
  }

  configure(configuration) {
    return this.#operations.configure(configuration);
  }

  send(message) {
    return this.#operations.send(message);
  }

  stop() {
    return this.#operations.stop();
  }

  current() {
    return this.#operations.current();
  }

  downloadAttachment(name) {
    return this.#operations.downloadAttachment(name);
  }
}

class AIChatService {
  listWorkspaces() { throw new Error('AIChatService.listWorkspaces() is not implemented.'); }

  createWorkspace(_input) { throw new Error('AIChatService.createWorkspace() is not implemented.'); }

  createChat(_input) { throw new Error('AIChatService.createChat() is not implemented.'); }

  openChat(_input) { throw new Error('AIChatService.openChat() is not implemented.'); }

  currentSession() { throw new Error('AIChatService.currentSession() is not implemented.'); }

  recoverSession() { throw new Error('AIChatService.recoverSession() is not implemented.'); }

  reloadSession() { throw new Error('AIChatService.reloadSession() is not implemented.'); }

  navigateSessionBack() { throw new Error('AIChatService.navigateSessionBack() is not implemented.'); }

  navigateSessionForward() { throw new Error('AIChatService.navigateSessionForward() is not implemented.'); }
}

module.exports = {
  AIChat,
  AIChatError,
  AI_CHAT_ATTACHMENT_STATUS,
  AI_CHAT_ERROR_CODE,
  AI_CHAT_MESSAGE_ROLE,
  AI_CHAT_RUN_STATUS,
  AIChatService,
};
