const {
  conversationIdFromRouteUrl,
  normalizeConversationTitle,
} = require('../../../shared/chatgpt');

function textOf(element) {
  return normalizeConversationTitle(
    element?.getAttribute?.('aria-label')
      || element?.getAttribute?.('title')
      || element?.innerText
      || element?.textContent
      || '',
  );
}

function pageTitle(value) {
  return normalizeConversationTitle(
    String(value || '').replace(/\s*(?:\||-)\s*ChatGPT(?:.*)?$/i, ''),
  );
}

function conversationTitleFromDom(conversationId, {
  root = typeof document !== 'undefined' ? document : null,
  currentUrl = typeof location !== 'undefined' ? location.href : '',
} = {}) {
  const id = String(conversationId || '').trim().toLowerCase();
  if (!id || !root?.querySelectorAll) return '';

  const currentId = conversationIdFromRouteUrl(currentUrl);
  if (currentId === id) {
    const namedElement = root.querySelector?.('[data-testid="conversation-name"]');
    const namedTitle = textOf(namedElement);
    if (namedTitle) return namedTitle;
  }

  const links = root.querySelectorAll(`a[href*="/c/${id}"]`);
  for (const link of links) {
    let hrefId = null;
    try {
      hrefId = conversationIdFromRouteUrl(link.href || link.getAttribute?.('href') || '');
    } catch {
      hrefId = null;
    }
    if (hrefId !== id) continue;
    const title = textOf(link);
    if (title) return title;
  }

  if (currentId === id) return pageTitle(root.title);
  return '';
}

function observeConversationTitle(conversationId, { onTitle } = {}) {
  if (typeof onTitle !== 'function' || typeof MutationObserver !== 'function') return () => {};

  let lastTitle = '';
  let pendingTitle = null;
  let stopped = false;
  let scheduled = false;
  const observer = new MutationObserver(() => scheduleCheck());

  function stop() {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
  }

  function check() {
    scheduled = false;
    if (stopped) return;
    const title = conversationTitleFromDom(conversationId);
    if (!title || title === lastTitle || title === pendingTitle) return;
    pendingTitle = title;
    Promise.resolve(onTitle(title, stop)).then((accepted) => {
      if (accepted !== false) lastTitle = title;
      if (pendingTitle === title) pendingTitle = null;
    }).catch(() => {
      if (pendingTitle === title) pendingTitle = null;
    });
  }

  function scheduleCheck() {
    if (stopped || scheduled) return;
    scheduled = true;
    queueMicrotask(check);
  }

  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-label', 'title', 'href'],
  });
  check();
  return stop;
}

module.exports = {
  conversationTitleFromDom,
  observeConversationTitle,
  pageTitle,
  textOf,
};
