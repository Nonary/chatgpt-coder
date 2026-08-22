// Native editing events are composed, so they cross an open shadow root and are
// retargeted to its host. ChatGPT can mistake those retargeted events for global
// typing and focus its own composer. Stop them at Patchwork's boundary, after
// controls inside the shadow root have handled them but before the page sees them.
const PRIVATE_EVENT_TYPES = [
  'beforeinput',
  'change',
  'compositionend',
  'compositionstart',
  'compositionupdate',
  'focusin',
  'focusout',
  'input',
  'keydown',
  'keypress',
  'keyup',
  'textInput',
];

const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function isPlainTyping(event) {
  const key = String(event.key || '');
  if (event.ctrlKey || event.metaKey) return false;
  if (event.altKey && key.toLowerCase() === 'p') return false;
  return Array.from(key).length === 1
    || event.isComposing
    || key === 'Dead'
    || key === 'Process';
}

function installEventBoundary(root, pageWindow = root.ownerDocument?.defaultView) {
  const contain = (event) => event.stopPropagation();
  for (const type of PRIVATE_EVENT_TYPES) root.addEventListener(type, contain);

  // A capture listener on the page can run before an event reaches the shadow
  // root. Safari exposes the focused shadow host as document.activeElement, so
  // ChatGPT's type-to-focus handling can treat a task keystroke as global. Catch
  // plain typing at window capture (which precedes document capture). Stopping
  // propagation does not cancel the native edit, so the focused control still
  // receives the character and emits its normal input event.
  const containEarlyTyping = (event) => {
    if (!isPlainTyping(event)) return;
    if (!root.activeElement?.matches?.(EDITABLE_SELECTOR)) return;
    event.stopImmediatePropagation();
  };
  pageWindow?.addEventListener('keydown', containEarlyTyping, true);

  return () => {
    for (const type of PRIVATE_EVENT_TYPES) root.removeEventListener(type, contain);
    pageWindow?.removeEventListener('keydown', containEarlyTyping, true);
  };
}

module.exports = {
  EDITABLE_SELECTOR, PRIVATE_EVENT_TYPES, installEventBoundary, isPlainTyping,
};
