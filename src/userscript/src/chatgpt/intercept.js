const {
  conversationRequestIncludesAttachment,
  rewriteConversationRequestBody,
} = require('../../../shared/chatgpt');

const CONVERSATION_PATH = '/backend-api/f/conversation';
const PREPARE_PATH = '/backend-api/f/conversation/prepare';

let installed = false;
let enforcement = null;
let nativeFetch = null;

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input?.url || '';
}

function pathOf(input) {
  try {
    return new URL(requestUrl(input), location.origin).pathname;
  } catch {
    return '';
  }
}

function methodOf(input, init) {
  return String(init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
}

async function readRequestBody(input, init) {
  if (init && 'body' in init) {
    const { body } = init;
    if (typeof body === 'string') return body;
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
    if (body instanceof Blob) return body.text();
    return null;
  }
  if (input instanceof Request) return input.clone().text();
  return null;
}

// Replaces v2's Chrome DevTools Protocol Fetch.requestPaused interception: the
// outgoing conversation body is rewritten to the exact model and reasoning effort
// the task asked for, and the send is aborted when the ZIP is not attached.
function installInterceptor() {
  if (installed) return;
  installed = true;
  nativeFetch = window.fetch.bind(window);

  window.fetch = async function patchworkFetch(input, init) {
    const path = pathOf(input);
    const isConversation = path === CONVERSATION_PATH;
    const isPrepare = path === PREPARE_PATH;
    if (!enforcement || methodOf(input, init) !== 'POST' || (!isConversation && !isPrepare)) {
      return nativeFetch(input, init);
    }

    let text;
    try {
      text = await readRequestBody(input, init);
    } catch {
      text = null;
    }
    if (typeof text !== 'string') return nativeFetch(input, init);

    // Resolved per request, not once up front, so a change made in the composer's
    // Patchwork picker after the task was created still wins.
    let configuration;
    let rewritten;
    try {
      configuration = enforcement.resolveConfiguration();
      rewritten = rewriteConversationRequestBody(text, configuration);
    } catch (error) {
      if (isConversation) enforcement.settle({ ok: false, error: error.message });
      return nativeFetch(input, init);
    }

    if (isConversation && enforcement.packageFilename
      && !conversationRequestIncludesAttachment(rewritten.text, enforcement.packageFilename)) {
      const message = `ChatGPT's outgoing request did not include the task ZIP attachment (${enforcement.packageFilename}).`;
      enforcement.settle({ ok: false, retrySubmission: true, error: message });
      throw new DOMException(message, 'AbortError');
    }

    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('Content-Type', 'application/json');
    const nextInit = {
      ...(input instanceof Request ? {
        method: input.method,
        credentials: input.credentials,
        mode: input.mode,
        cache: input.cache,
        redirect: input.redirect,
        referrer: input.referrer,
        integrity: input.integrity,
      } : {}),
      ...init,
      method: 'POST',
      headers,
      body: rewritten.text,
    };
    const response = await nativeFetch(requestUrl(input), nextInit);
    if (isConversation) {
      enforcement.settle({
        ok: true,
        model: rewritten.model,
        thinkingEffort: rewritten.thinkingEffort,
        selectedModel: configuration.model,
        selectedReasoningMode: configuration.reasoningMode,
        selectionSource: configuration.source || 'patchwork-task',
        // The reply is an event stream whose first events already name the
        // conversation, so submission is confirmed without waiting for the SPA
        // route to catch up.
        conversationId: readConversationId(response),
      });
    }
    return response;
  };
}

const CONVERSATION_ID_PATTERN = /"conversation_id"\s*:\s*"([0-9a-f-]{36})"/i;
const MAX_SNIFFED_BYTES = 64 * 1024;

// Resolves from a clone of the event stream, so the page's own reader is untouched.
function readConversationId(response) {
  if (!response.ok || !response.body) return Promise.resolve(null);
  let clone;
  try {
    clone = response.clone();
  } catch {
    return Promise.resolve(null);
  }
  return (async () => {
    const reader = clone.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return null;
        buffered += decoder.decode(value, { stream: true });
        const match = CONVERSATION_ID_PATTERN.exec(buffered);
        if (match) return match[1];
        if (buffered.length > MAX_SNIFFED_BYTES) return null;
      }
    } catch {
      return null;
    } finally {
      reader.cancel().catch(() => {});
    }
  })();
}

function beginEnforcement({ configuration, packageFilename = null }) {
  const resolveConfiguration = typeof configuration === 'function' ? configuration : () => configuration;
  installInterceptor();
  let settled = false;
  let resolveResult;
  const resultPromise = new Promise((resolve) => { resolveResult = resolve; });
  enforcement = {
    resolveConfiguration,
    packageFilename,
    settle(result) {
      if (settled) return;
      settled = true;
      resolveResult(result);
    },
  };
  const active = enforcement;

  return {
    async wait(timeoutMilliseconds = 45_000) {
      const timeout = new Promise((resolve) => {
        const timer = setTimeout(
          () => resolve({ ok: false, error: 'ChatGPT did not send a conversation request after Send.' }),
          timeoutMilliseconds,
        );
        resultPromise.then(() => clearTimeout(timer));
      });
      const result = await Promise.race([resultPromise, timeout]);
      if (!result.ok) {
        const error = new Error(result.error || 'Could not verify ChatGPT’s outgoing model request.');
        error.retrySubmission = Boolean(result.retrySubmission);
        throw error;
      }
      return result;
    },
    dispose() {
      if (enforcement === active) enforcement = null;
    },
  };
}

function isInstalled() {
  return installed;
}

module.exports = {
  CONVERSATION_ID_PATTERN, beginEnforcement, installInterceptor, isInstalled, readConversationId,
};
