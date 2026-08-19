const COMPOSER_SELECTORS = [
  '#prompt-textarea',
  '[data-testid="prompt-textarea"]',
  'textarea[placeholder]',
  '[contenteditable="true"][role="textbox"]',
];

const FILE_INPUT_SELECTORS = [
  '#upload-files',
  'input[type="file"][multiple]:not([accept="image/*"])',
  'input[type="file"]',
];

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// ChatGPT renders parts of the composer inside shadow roots, so every lookup
// walks them as well.
function deepQueryAll(selector, root = document) {
  const found = [];
  const roots = [root];
  const visited = new Set();
  while (roots.length > 0) {
    const current = roots.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    found.push(...current.querySelectorAll(selector));
    for (const element of current.querySelectorAll('*')) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  return found;
}

function deepQuery(selector, root = document) {
  return deepQueryAll(selector, root)[0] || null;
}

function findComposer() {
  for (const selector of COMPOSER_SELECTORS) {
    const element = deepQuery(selector);
    if (element) return element;
  }
  return null;
}

async function waitForComposer(timeoutMilliseconds = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMilliseconds) {
    const composer = findComposer();
    if (composer) return composer;
    await delay(250);
  }
  return null;
}

function setPrompt(prompt) {
  const composer = findComposer();
  if (!composer) throw new Error('Could not find the prompt composer. Reload the page and try again.');
  composer.focus();
  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    const prototype = composer instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    // React tracks the last value it wrote, so the native setter is required.
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(composer, prompt);
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    composer.dispatchEvent(new Event('change', { bubbles: true }));
    return composer;
  }
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand('insertText', false, prompt);
  composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
  return composer;
}

function findFileInput() {
  for (const selector of FILE_INPUT_SELECTORS) {
    const element = deepQuery(selector);
    if (element) return element;
  }
  return null;
}

async function openAttachmentMenu() {
  const button = deepQuery('[data-testid="composer-plus-btn"]')
    || deepQuery('[data-testid*="attach"]')
    || deepQueryAll('button').find((item) => /attach|add files|upload/i.test([
      item.getAttribute('aria-label'), item.getAttribute('title'), item.textContent,
    ].filter(Boolean).join(' ')));
  if (!button) return false;
  button.click();
  await delay(400);
  return true;
}

async function requireFileInput() {
  let input = findFileInput();
  if (input) return input;
  await openAttachmentMenu();
  input = findFileInput();
  if (!input) throw new Error('Could not locate the attachment input. Reload the page and try again.');
  return input;
}

// v2 needed Chrome DevTools Protocol here because the file only existed on disk.
// In the page the bytes are already in hand, so a DataTransfer is enough.
async function attachFile(file) {
  const input = await requireFileInput();
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return input;
}

function redispatchSelection(filename) {
  const input = deepQueryAll('input[type="file"]')
    .find((element) => [...(element.files || [])].some((file) => file.name === filename));
  if (!input) return false;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function attachmentStatus(filename, dismissDuplicateNotice = false) {
  const target = String(filename).toLowerCase();
  const isVisible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0;
  };

  const notices = deepQueryAll('[role="dialog"], [role="alert"], [aria-live]');
  const duplicateNotice = notices.filter(isVisible).find((element) => /already (?:been )?uploaded|duplicate file/i.test(
    [element.textContent, element.getAttribute('aria-label')].filter(Boolean).join(' '),
  ));
  let dismissedDuplicate = false;
  if (duplicateNotice && dismissDuplicateNotice) {
    const dismiss = [...duplicateNotice.querySelectorAll('button')].find((button) => /^(?:got it|close|dismiss|ok|okay)$/i.test(
      [button.textContent, button.getAttribute('aria-label'), button.getAttribute('title')]
        .filter(Boolean).join(' ').trim(),
    )) || duplicateNotice.querySelector('button[data-testid*="close"], button[aria-label="Close"]');
    if (dismiss) {
      dismiss.click();
      dismissedDuplicate = true;
    }
  }

  const selectedByInput = deepQueryAll('input[type="file"]')
    .some((input) => [...(input.files || [])].some((file) => file.name === filename));

  const attachment = deepQueryAll('[data-testid*="file"], [data-testid*="attach"], [aria-label], [title], span, div')
    .find((element) => {
      const labels = [element.textContent, element.getAttribute('aria-label'), element.getAttribute('title')]
        .filter(Boolean)
        .map((value) => String(value).replace(/\s+/g, ' ').trim().toLowerCase());
      if (!labels.some((value) => value.includes(target))) return false;
      return Boolean(element.closest?.('[data-testid*="file"], [data-testid*="attach"]'))
        || labels.some((value) => value === target)
        || /file|attach/i.test([element.getAttribute('data-testid'), element.getAttribute('aria-label')]
          .filter(Boolean).join(' '));
    });

  if (!attachment) {
    return {
      attached: false,
      busy: selectedByInput,
      selectedByInput,
      duplicateNotice: Boolean(duplicateNotice),
      dismissedDuplicate,
    };
  }

  const card = attachment.closest?.('[role="group"][aria-label]')
    || attachment.closest?.('[data-testid*="file"], [data-testid*="attach"]')
    || attachment.parentElement
    || attachment;
  const statusText = [card?.textContent, card?.getAttribute?.('aria-label')].filter(Boolean).join(' ');
  const busy = /uploading|processing|attaching/i.test(statusText)
    || Boolean(card?.matches?.('.cursor-wait, [aria-busy="true"]'))
    || Boolean(card?.querySelector?.('.cursor-wait, [role="progressbar"], progress, [aria-busy="true"]'));
  return {
    attached: true,
    busy,
    selectedByInput,
    duplicateNotice: Boolean(duplicateNotice),
    dismissedDuplicate,
  };
}

async function waitForAttachment(filename, timeoutMilliseconds = 120_000) {
  const startedAt = Date.now();
  let readyChecks = 0;
  let lastRedispatchAt = startedAt;
  while (Date.now() - startedAt < timeoutMilliseconds) {
    const status = attachmentStatus(filename, true);
    readyChecks = status.attached && !status.busy ? readyChecks + 1 : 0;
    if (readyChecks >= 2) return true;
    if (!status.attached && status.selectedByInput && Date.now() - lastRedispatchAt >= 1_000) {
      lastRedispatchAt = Date.now();
      redispatchSelection(filename);
    }
    await delay(500);
  }
  throw new Error(`The attachment ${filename} was never confirmed. Nothing was sent.`);
}

function sendButtonState(allowClick) {
  const candidates = deepQueryAll('button, [role="button"]');
  const stop = candidates.find((item) => {
    const label = [item.getAttribute('data-testid'), item.getAttribute('aria-label'), item.getAttribute('title')]
      .filter(Boolean).join(' ');
    return /stop-button|stop generating|stop response/i.test(label)
      && !item.disabled && item.getAttribute('aria-disabled') !== 'true';
  });
  if (stop) return { found: true, enabled: false, submitted: true, clicked: false };

  const button = candidates.find((item) => item.getAttribute('data-testid') === 'send-button')
    || candidates.find((item) => /send prompt|send message|^send$/i.test(
      [item.getAttribute('aria-label'), item.getAttribute('title'), item.textContent]
        .filter(Boolean).join(' ').trim(),
    ));
  if (!button) return { found: false, enabled: false, submitted: false, clicked: false };
  const enabled = !button.disabled && button.getAttribute('aria-disabled') !== 'true';
  if (!enabled || !allowClick) return { found: true, enabled, submitted: false, clicked: false };
  button.scrollIntoView?.({ block: 'center', inline: 'center' });
  button.click();
  return { found: true, enabled: true, submitted: false, clicked: true };
}

async function clickSend({ isConversationOpen, timeoutMilliseconds = 90_000 } = {}) {
  const startedAt = Date.now();
  let clicked = false;
  let lastClickedAt = 0;
  while (Date.now() - startedAt < timeoutMilliseconds) {
    if (clicked && isConversationOpen?.()) return true;
    const allowClick = !clicked || Date.now() - lastClickedAt >= 1_500;
    const state = sendButtonState(allowClick);
    if (state.submitted || (clicked && state.found && !state.enabled)) return true;
    if (state.clicked) {
      clicked = true;
      lastClickedAt = Date.now();
    }
    await delay(clicked ? 250 : 500);
  }
  throw new Error(clicked
    ? 'The conversation did not start after Send. The composer may still be processing the attachment.'
    : 'The Send button never became enabled. The attachment may still be uploading.');
}

module.exports = {
  attachFile,
  attachmentStatus,
  clickSend,
  deepQuery,
  deepQueryAll,
  delay,
  findComposer,
  findFileInput,
  redispatchSelection,
  sendButtonState,
  setPrompt,
  waitForAttachment,
  waitForComposer,
};
