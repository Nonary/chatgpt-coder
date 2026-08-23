const { conversationIdFromRouteUrl } = require('../../../shared/chatgpt');

const CHATGPT_SOCKET_MESSAGE_EVENT = 'patchwork-chatgpt-websocket-message';
const SOCKET_QUIET_MILLISECONDS = 750;
const WRAPPED_FLAG = '__patchworkChatgptWebSocketWrapped';

function isChatGptSocketUrl(value) {
  try {
    const url = new URL(String(value || ''), location.href);
    return url.protocol === 'wss:'
      && (url.hostname === 'ws.chatgpt.com' || url.hostname.endsWith('.chatgpt.com'));
  } catch {
    return false;
  }
}

function dispatchSocketMessage(url, data) {
  window.dispatchEvent(new CustomEvent(CHATGPT_SOCKET_MESSAGE_EVENT, {
    detail: { url: String(url || ''), data },
  }));
}

// The installed userscript injects the same wrapper at document-start so it can
// see sockets ChatGPT opens during boot. Installing again here keeps bookmarklet
// and development runtime injection useful when no early userscript bootstrap ran.
function installWebSocketObserver() {
  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket !== 'function' || NativeWebSocket[WRAPPED_FLAG]) return false;

  function PatchworkWebSocket(url, protocols) {
    const socket = arguments.length > 1
      ? new NativeWebSocket(url, protocols)
      : new NativeWebSocket(url);
    if (isChatGptSocketUrl(url)) {
      socket.addEventListener('message', (event) => dispatchSocketMessage(url, event.data));
    }
    return socket;
  }

  Object.setPrototypeOf(PatchworkWebSocket, NativeWebSocket);
  PatchworkWebSocket.prototype = NativeWebSocket.prototype;
  Object.defineProperty(PatchworkWebSocket, WRAPPED_FLAG, { value: true });
  Object.defineProperty(PatchworkWebSocket, '__patchworkNativeWebSocket', { value: NativeWebSocket });
  window.WebSocket = PatchworkWebSocket;
  return true;
}

async function messageText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof Blob) return data.text().catch(() => '');
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return '';
}

async function messageTargetsConversation(data, conversationId, routeUrl = location.href) {
  const target = String(conversationId || '').toLowerCase();
  if (!target) return false;

  // On the task's own page every ChatGPT socket update is useful as an invalidation
  // signal. A trailing debounce collapses token/update bursts into one reconciliation.
  if (conversationIdFromRouteUrl(routeUrl)?.toLowerCase() === target) return true;

  // A background task can still be woken by a notification that names its
  // conversation, without reconciling unrelated conversations in the same account.
  const text = (await messageText(data)).toLowerCase();
  return Boolean(text && text.includes(target));
}

function observeConversationUpdates(conversationId, onInvalidate, {
  quietMilliseconds = SOCKET_QUIET_MILLISECONDS,
} = {}) {
  if (!conversationId || typeof onInvalidate !== 'function') return () => {};
  installWebSocketObserver();
  let stopped = false;
  let timer = null;

  const schedule = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!stopped) onInvalidate();
    }, quietMilliseconds);
  };

  const onMessage = (event) => {
    if (stopped || !isChatGptSocketUrl(event?.detail?.url)) return;
    Promise.resolve(messageTargetsConversation(event.detail.data, conversationId))
      .then((relevant) => {
        if (relevant) schedule();
      })
      .catch(() => {});
  };

  window.addEventListener(CHATGPT_SOCKET_MESSAGE_EVENT, onMessage);
  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    timer = null;
    window.removeEventListener(CHATGPT_SOCKET_MESSAGE_EVENT, onMessage);
  };
}

module.exports = {
  CHATGPT_SOCKET_MESSAGE_EVENT,
  SOCKET_QUIET_MILLISECONDS,
  installWebSocketObserver,
  isChatGptSocketUrl,
  messageTargetsConversation,
  messageText,
  observeConversationUpdates,
};
