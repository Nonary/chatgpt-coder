const {
  conversationRequestIncludesAttachment,
  rewriteConversationRequestBody,
} = require('../../../shared/chatgpt');

const CONVERSATION_PATH = '/backend-api/f/conversation';
const PREPARE_PATH = '/backend-api/f/conversation/prepare';

let installed = false;
let enforcement = null;
let ambient = null;
let nativeFetch = null;

// Patchwork replaces ChatGPT's model control, so it owes every send the model that
// control shows - not just the sends it makes itself. The ambient resolver applies
// the composer picker to ordinary chats; a task submission layers its own
// enforcement (which also verifies the attachment) on top.
function setAmbientConfiguration(resolver) {
  ambient = typeof resolver === 'function' ? resolver : null;
  if (ambient) installInterceptor();
  return ambient;
}

function activeEnforcement() {
  if (enforcement) return enforcement;
  if (!ambient) return null;
  return { resolveConfiguration: ambient, packageFilename: null, settle: () => {} };
}

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
    const method = methodOf(input, init);
    const isConversation = path === CONVERSATION_PATH;
    const isPrepare = path === PREPARE_PATH;
    const active = activeEnforcement();
    if (!active || method !== 'POST' || (!isConversation && !isPrepare)) {
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
      configuration = active.resolveConfiguration();
      // A resolver may decline - the picker is not installed, for instance - and
      // then ChatGPT's own request is left exactly as it was.
      if (!configuration) return nativeFetch(input, init);
      rewritten = rewriteConversationRequestBody(text, configuration);
    } catch (error) {
      if (isConversation) active.settle({ ok: false, error: error.message });
      return nativeFetch(input, init);
    }

    if (isConversation && active.packageFilename
      && !conversationRequestIncludesAttachment(rewritten.text, active.packageFilename)) {
      const message = `The outgoing request did not include the task ZIP attachment (${active.packageFilename}).`;
      active.settle({ ok: false, retrySubmission: true, error: message });
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
      active.settle({
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
        // The cloned response stream closes when ChatGPT finishes generating.
        // Monitoring that event avoids repeatedly polling ChatGPT's conversation
        // endpoints while the answer is in flight.
        responseComplete: waitForResponseCompletion(response),
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

function waitForResponseCompletion(response) {
  if (!response.ok || !response.body) return Promise.resolve(false);
  let clone;
  try {
    clone = response.clone();
  } catch {
    return Promise.resolve(false);
  }
  return (async () => {
    const reader = clone.body.getReader();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) return true;
      }
    } catch {
      return false;
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
    async wait(timeoutMilliseconds = 45_000, fallbackConfirmation = null) {
      let timeoutId;
      const timeout = new Promise((resolve) => {
        timeoutId = setTimeout(
          () => resolve({ ok: false, error: 'No conversation request was sent after Send.' }),
          timeoutMilliseconds,
        );
      });
      const candidates = [resultPromise, timeout];
      if (fallbackConfirmation) candidates.push(Promise.resolve(fallbackConfirmation));
      let result;
      try {
        result = await Promise.race(candidates);
      } finally {
        clearTimeout(timeoutId);
      }
      if (!result.ok) {
        const error = new Error(result.error || 'Could not verify the outgoing model request.');
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
  CONVERSATION_ID_PATTERN,
  beginEnforcement,
  installInterceptor,
  isInstalled,
  readConversationId,
  setAmbientConfiguration,
  waitForResponseCompletion,
};
