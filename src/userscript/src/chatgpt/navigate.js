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

function workspaceRouteMatches(value, workspaceId = null) {
  try {
    const url = new URL(String(value || ''), CHATGPT_ORIGIN);
    if (url.origin !== CHATGPT_ORIGIN || conversationIdFromRouteUrl(url.href)) return false;
    if (!workspaceId) return url.pathname === '/';
    const escaped = String(workspaceId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^/g/${escaped}(?:-[^/]+)?(?:/project)?/?$`, 'i').test(url.pathname);
  } catch {
    return false;
  }
}

function isVisible(element) {
  if (!element) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function hasVisibleConversation() {
  return [...document.querySelectorAll([
    '[data-message-author-role]',
    '[data-testid^="conversation-turn-"]',
    'article[data-testid^="conversation-turn-"]',
  ].join(', '))].some((element) => {
    if (!isVisible(element)) return false;
    const bounds = element.getBoundingClientRect?.();
    return !bounds || (bounds.width > 0 && bounds.height > 0);
  });
}

function freshRouteReady(workspaceId = null) {
  return workspaceRouteMatches(location.href, workspaceId) && !hasVisibleConversation();
}

function labelOf(element) {
  return [element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent]
    .filter(Boolean).join(' ').trim();
}

// A hard load restarts the userscript, so navigation always tries ChatGPT's own
// client-side router first.
function navigateInPage(targetUrl, { preferNewChat = false, workspaceId = null } = {}) {
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
  const workspaceLink = workspaceId ? controls.find((element) => {
    if (!(element instanceof HTMLAnchorElement)) return false;
    try {
      return workspaceRouteMatches(element.href || element.getAttribute('href'), workspaceId);
    } catch {
      return false;
    }
  }) : null;
  const newChatControl = controls.find((element) => element.matches(
    '[data-testid="create-new-chat-button"], [data-testid="new-chat-button"]',
  ) || /^(?:new chat|start new chat|new conversation)$/i.test(labelOf(element)));

  // A project landing route with no conversation ID already is a fresh chat.
  // Clicking ChatGPT's global New chat control from here can leave the project,
  // which is how a selected project used to turn into an ordinary conversation.
  if (preferNewChat && freshRouteReady(workspaceId)) {
    return { navigated: true, method: 'reuse-fresh-route' };
  }

  const control = preferNewChat
    ? (workspaceId ? workspaceLink || exactLink : exactLink || newChatControl)
    : exactLink;
  if (control) {
    control.click();
    return { navigated: true, method: 'in-page-control' };
  }
  if (currentRoute() === targetRoute) return { navigated: true, method: 'reuse-current-page' };
  return { navigated: false, method: 'unavailable' };
}

function activateRouteInPage(targetUrl) {
  const target = new URL(targetUrl, location.origin);
  if (target.origin !== location.origin) return false;
  const route = target.pathname + target.search + target.hash;
  try {
    history.pushState(history.state, '', route);
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    return true;
  } catch {
    return false;
  }
}

async function waitForFreshRoute(workspaceId = null, timeoutMilliseconds = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMilliseconds) {
    if (freshRouteReady(workspaceId)) return true;
    await delay(100);
  }
  return false;
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

function forgetPendingNavigation() {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // A blocked sessionStorage cannot retain a stale navigation record.
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
  const targetUrl = projectUrl(project);
  const workspaceId = project?.id || null;
  if (freshRouteReady(workspaceId)) {
    return { navigated: true, method: 'reuse-fresh-route' };
  }

  // Record recovery before clicking anything: ChatGPT sometimes turns a
  // rendered project link into a document navigation instead of an SPA route.
  if (pending) rememberPendingNavigation(pending);
  const inPage = navigateInPage(targetUrl, { preferNewChat: true, workspaceId });
  if (inPage.navigated && await waitForFreshRoute(workspaceId)) {
    // ChatGPT updates the route just before its composer render settles. Give
    // that render one turn so the upload cannot bind to the outgoing composer.
    await delay(100);
    forgetPendingNavigation();
    return inPage;
  }

  // This is the same-document fallback used by the hardened browser branches:
  // it asks ChatGPT's router to activate the project without replacing the
  // authenticated page or waiting through a complete document load.
  if (activateRouteInPage(targetUrl) && await waitForFreshRoute(workspaceId, 2_000)) {
    await delay(100);
    forgetPendingNavigation();
    return { navigated: true, method: 'in-page-route' };
  }

  // If ChatGPT's router is unhealthy, preserve enough state for the new page to
  // resume the submission instead of silently abandoning it during navigation.
  location.assign(targetUrl);
  await delay(5_000);
  if (!freshRouteReady(workspaceId)) {
    throw new Error('ChatGPT did not open a fresh chat. The existing conversation was left unchanged.');
  }
  forgetPendingNavigation();
  return { navigated: true, method: 'hard-load' };
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
  activateRouteInPage,
  freshRouteReady,
  navigate,
  navigateInPage,
  openConversation,
  openFreshChat,
  projectUrl,
  rememberPendingNavigation,
  takePendingNavigation,
  waitForConversationUrl,
  waitForFreshRoute,
  workspaceRouteMatches,
};
