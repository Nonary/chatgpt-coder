const { ipcRenderer } = require('electron');

const CHAT_DOM_SNAPSHOT_CHANNEL = 'patchwork:chat-dom-snapshot';
const MESSAGE_SELECTOR = [
  '[data-message-author-role]',
  '[data-message-id]',
  '[data-testid*="conversation-turn" i]',
  'article[data-testid*="turn" i]',
  '[data-role]',
  '[data-author]',
].join(',');

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function readableText(element) {
  return String(element?.innerText || element?.textContent || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function roleFromValue(value) {
  const normalized = String(value || '').toLowerCase();
  if (/\b(?:assistant|chatgpt|model|completion|response)\b/.test(normalized)) return 'assistant';
  if (/\b(?:user|human|prompt|you)\b/.test(normalized)) return 'user';
  if (/\bsystem\b/.test(normalized)) return 'system';
  return null;
}

function roleFromElement(element) {
  return roleFromValue([
    element?.getAttribute?.('data-message-author-role'),
    element?.getAttribute?.('data-role'),
    element?.getAttribute?.('data-author'),
    element?.getAttribute?.('aria-label'),
    element?.getAttribute?.('data-testid'),
  ].filter(Boolean).join(' '));
}

function pageRoots() {
  const roots = [document];
  const visited = new Set();
  while (roots.length) {
    const root = roots.shift();
    if (!root || visited.has(root)) continue;
    visited.add(root);
    for (const element of root.querySelectorAll?.('*') || []) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  return [...visited];
}

function queryAll(selector) {
  return pageRoots().flatMap((root) => [...(root.querySelectorAll?.(selector) || [])]);
}

function readChatSnapshot() {
  const candidates = queryAll(MESSAGE_SELECTOR);
  const messages = [];
  const seen = new Set();
  for (const [index, element] of candidates.entries()) {
    const role = roleFromElement(element)
      || roleFromElement(element.querySelector?.('[data-message-author-role], [data-role], [data-author]'));
    if (!role || element.parentElement?.closest?.('[data-message-author-role]')) continue;
    const text = readableText(element);
    if (!text) continue;
    const id = element.getAttribute?.('data-message-id')
      || element.getAttribute?.('data-testid')
      || `${role}-${index}`;
    if (seen.has(id)) continue;
    seen.add(id);
    messages.push({ id, role, text });
  }

  const controls = queryAll('button, [role="button"]');
  const streaming = controls.some((element) => /stop(?: generating| streaming| response)?/i.test([
    element.getAttribute?.('aria-label'),
    element.getAttribute?.('title'),
    element.textContent,
    element.dataset?.testid,
  ].filter(Boolean).join(' ')));
  const alerts = queryAll('[role="alert"], [role="alertdialog"], [data-testid*="error" i]')
    .map((element) => readableText(element)).filter(Boolean).join(' ');
  const failed = !streaming && /(?:something went wrong|generation failed|error generating|unable to generate|network error)/i.test(alerts);
  const run = {
    status: streaming ? 'streaming' : failed ? 'failed' : messages.some(({ role }) => role === 'assistant') ? 'completed' : 'unknown',
    error: failed ? { message: alerts.slice(0, 240) } : null,
  };
  const thinkingSummary = queryAll('[data-testid*="reasoning" i], details')
    .map((element) => readableText(element)).find(Boolean) || null;
  const attachments = queryAll('[data-testid*="attachment" i], [class*="attachment" i]')
    .map((element) => readableText(element) || normalize(element.getAttribute?.('aria-label')))
    .filter(Boolean)
    .map((name) => ({ name, status: 'ready' }));
  return { messages, thinkingSummary, attachments, run };
}

let lastFingerprint = '';
let lastUrl = '';
let sequence = 0;
let scheduled = false;

function publishSnapshot() {
  scheduled = false;
  if (location.hostname !== 'chatgpt.com') return;
  const snapshot = readChatSnapshot();
  const url = location.href;
  const fingerprint = JSON.stringify({ url, snapshot });
  if (fingerprint === lastFingerprint) return;
  lastFingerprint = fingerprint;
  lastUrl = url;
  try {
    ipcRenderer.send(CHAT_DOM_SNAPSHOT_CHANNEL, {
      url,
      title: document.title || null,
      sequence: ++sequence,
      snapshot,
    });
  } catch {}
}

function scheduleSnapshot() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(publishSnapshot, 40);
}

function installObserver() {
  if (!document.documentElement) return;
  const observer = new MutationObserver(scheduleSnapshot);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  window.addEventListener('popstate', scheduleSnapshot);
  window.addEventListener('hashchange', scheduleSnapshot);
  setInterval(() => {
    if (location.href !== lastUrl) scheduleSnapshot();
  }, 250);
  scheduleSnapshot();
  setTimeout(scheduleSnapshot, 250);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installObserver, { once: true });
} else {
  installObserver();
}
