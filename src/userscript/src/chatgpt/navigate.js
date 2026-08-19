const { delay } = require('./composer');
const {
  CHATGPT_ORIGIN,
  chatGPTProjectUrl,
  conversationIdFromRouteUrl,
  isChatGPTConversationUrl,
} = require('../../../shared/chatgpt');

const PENDING_KEY = 'patchwork.pending-navigation';

function currentRoute() {
  return location.pathname + location.search + location.hash;
}

function isVisible(element) {
  if (!element) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function labelOf(element) {
  return [element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent]
    .filter(Boolean).join(' ').trim();
}

// A hard load restarts the userscript, so navigation always tries ChatGPT's own
// client-side router first.
function navigateInPage(targetUrl, { preferNewChat = false } = {}) {
  const target = new URL(targetUrl, location.origin);
  const targetRoute = target.pathname + target.search + target.hash;
  const controls = [...document.querySelectorAll('a[href], button')].filter(isVisible);

  const exactLink = controls.find((element) => {
    if (!(element instanceof HTMLAnchorElement)) return false;
    try {
      const url = new URL(element.href, location.href);
      return url.origin === target.origin && url.pathname + url.search + url.hash === targetRoute;
    } catch {
      return false;
    }
  });
  const newChatControl = controls.find((element) => element.matches(
    '[data-testid="create-new-chat-button"], [data-testid="new-chat-button"]',
  ) || /^(?:new chat|start new chat|new conversation)$/i.test(labelOf(element)));

  const control = preferNewChat
    ? (currentRoute() === targetRoute ? newChatControl || exactLink : exactLink || newChatControl)
    : exactLink;
  if (control) {
    control.click();
    return { navigated: true, method: 'in-page-control' };
  }
  if (currentRoute() === targetRoute) return { navigated: true, method: 'reuse-current-page' };
  return { navigated: false, method: 'unavailable' };
}

function rememberPendingNavigation(pending) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    // A blocked sessionStorage only costs the automatic resume after a hard load.
  }
}

function takePendingNavigation() {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function navigate(targetUrl, options = {}) {
  const result = navigateInPage(targetUrl, options);
  if (result.navigated) {
    await delay(400);
    return result;
  }
  if (options.pending) rememberPendingNavigation(options.pending);
  location.assign(targetUrl);
  // The page is being torn down; nothing after this runs.
  await delay(5_000);
  return { navigated: true, method: 'hard-load' };
}

function projectUrl(project) {
  if (!project?.id) return `${CHATGPT_ORIGIN}/`;
  return chatGPTProjectUrl(project.id, project.shortUrl);
}

async function openFreshChat(project = null, pending = null) {
  return navigate(projectUrl(project), { preferNewChat: true, pending });
}

async function openConversation(conversationUrl) {
  if (!isChatGPTConversationUrl(conversationUrl)) {
    throw new Error('This task has an invalid saved conversation URL.');
  }
  const targetId = conversationIdFromRouteUrl(conversationUrl);
  const openId = conversationIdFromRouteUrl(location.href);
  // Reloading a streaming conversation tears down live page state that has not
  // been persisted yet.
  if (location.href === conversationUrl || (targetId && openId === targetId)) {
    return { navigated: true, method: 'already-open' };
  }
  return navigate(conversationUrl);
}

async function waitForConversationUrl(timeoutMilliseconds = 45_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMilliseconds) {
    if (isChatGPTConversationUrl(location.href)) return location.href;
    await delay(250);
  }
  return null;
}

module.exports = {
  PENDING_KEY,
  navigate,
  navigateInPage,
  openConversation,
  openFreshChat,
  projectUrl,
  rememberPendingNavigation,
  takePendingNavigation,
  waitForConversationUrl,
};
