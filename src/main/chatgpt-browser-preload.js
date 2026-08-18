// The page-side half of the live transcript feed.
//
// This preload deliberately does not read the transcript. Scraping every
// mutation inside the page was the single largest cost of the old live path:
// each notification walked the whole document, rebuilt every message, and
// serialized the result. All this file does now is tell Patchwork that the
// rendered conversation changed. The main process then reads the page once,
// through the same transcript reader the slower poll uses.
//
// It talks to ChatGPT's rendered DOM and to Patchwork. It never calls
// ChatGPT's backend and never reads stored credentials.
const { ipcRenderer } = require('electron');

const CHAT_DOM_SNAPSHOT_CHANNEL = 'patchwork:chat-dom-snapshot';
const MESSAGE_SELECTOR = '[data-message-author-role], [data-message-id]';
const MINIMUM_SIGNAL_INTERVAL_MILLISECONDS = 90;

let lastSignal = '';
let lastUrl = '';
let sequence = 0;
let scheduled = false;
let lastSentAt = 0;

// A cheap stand-in for the transcript itself. Streaming only grows the last
// turn, so the last turn's length plus the turn count plus the streaming flag
// changes exactly when there is something new to read, without touching the
// rest of the conversation.
function transcriptSignal() {
  const messages = document.querySelectorAll(MESSAGE_SELECTOR);
  const last = messages[messages.length - 1];
  const streaming = Boolean(document.querySelector('[data-testid="stop-button"], .result-streaming'));
  return [
    location.href,
    messages.length,
    String(last?.getAttribute('data-message-id') || ''),
    String(last?.textContent || '').length,
    streaming ? 'streaming' : 'idle',
    document.title || '',
  ].join('|');
}

function publishSignal() {
  scheduled = false;
  if (location.hostname !== 'chatgpt.com') return;
  const signal = transcriptSignal();
  if (signal === lastSignal) return;
  lastSignal = signal;
  lastUrl = location.href;
  lastSentAt = Date.now();
  try {
    ipcRenderer.send(CHAT_DOM_SNAPSHOT_CHANNEL, {
      url: location.href,
      title: document.title || null,
      sequence: ++sequence,
      signal,
    });
  } catch {}
}

function scheduleSignal() {
  if (scheduled) return;
  scheduled = true;
  const elapsed = Date.now() - lastSentAt;
  setTimeout(publishSignal, Math.max(0, MINIMUM_SIGNAL_INTERVAL_MILLISECONDS - elapsed));
}

function installObserver() {
  if (!document.documentElement) return;
  // Attribute mutations are intentionally excluded. ChatGPT rewrites class
  // names constantly while streaming, and the transcript signal already covers
  // the one attribute change that matters through the stop control.
  const observer = new MutationObserver(scheduleSignal);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  window.addEventListener('popstate', scheduleSignal);
  window.addEventListener('hashchange', scheduleSignal);
  setInterval(() => {
    if (location.href !== lastUrl) scheduleSignal();
  }, 250);
  scheduleSignal();
  setTimeout(scheduleSignal, 250);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installObserver, { once: true });
} else {
  installObserver();
}
