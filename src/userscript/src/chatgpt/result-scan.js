const { deepQueryAll } = require('./composer');

// Real ChatGPT file ids are `file-`/`file_` plus a long alphanumeric run that always
// contains digits. Requiring a digit keeps test ids such as `file-attachment` out.
const FILE_ID_PATTERN = /\b(file[-_](?=[A-Za-z0-9]*\d)[A-Za-z0-9]{10,})\b/;
const LABEL_ATTRIBUTES = ['download', 'aria-label', 'title', 'href', 'data-file-id', 'data-testid'];
const ID_ATTRIBUTES = ['href', 'data-file-id', 'download'];

function labelOf(element) {
  return [
    ...LABEL_ATTRIBUTES.map((name) => element.getAttribute(name)),
    element.textContent,
  ].filter(Boolean).join(' ');
}

function idSourceOf(element) {
  return ID_ATTRIBUTES.map((name) => element.getAttribute(name)).filter(Boolean).join(' ');
}

function fileIdNear(element) {
  let node = element;
  for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
    const direct = FILE_ID_PATTERN.exec(idSourceOf(node))?.[1];
    if (direct) return direct;
    const nested = node.querySelectorAll?.('a[href], [data-file-id]') || [];
    for (const child of nested) {
      const found = FILE_ID_PATTERN.exec(idSourceOf(child))?.[1];
      if (found) return found;
    }
  }
  return null;
}

function isGenerating() {
  const stop = document.querySelector('[data-testid="stop-button"]');
  return Boolean(stop && !stop.disabled && stop.getAttribute('aria-disabled') !== 'true');
}

// A fallback for `GET /backend-api/conversation/:id`: the generated file is also
// rendered in the transcript, and its element carries the file id Patchwork needs
// to download the text through the files API. Unlike v2 this never clicks the
// download control, because a browser download would land in the filesystem
// instead of in the page.
const CANDIDATE_SELECTOR = [
  'a[href]',
  'a[download]',
  'button',
  '[role="link"]',
  '[role="button"]',
  '[data-file-id]',
  '[data-testid]',
].join(', ');

function findResultFileInDom(expectedName) {
  const expected = String(expectedName || '').toLowerCase();
  if (!expected) return null;
  const matches = deepQueryAll(CANDIDATE_SELECTOR)
    .filter((element) => labelOf(element).toLowerCase().includes(expected));
  if (matches.length === 0) return null;
  // The filename also appears in every ancestor's aggregated text, so the
  // tightest match is the one that actually represents the file.
  matches.sort((left, right) => (
    (left.querySelectorAll?.('*').length || 0) - (right.querySelectorAll?.('*').length || 0)
  ));
  for (const match of matches) {
    const id = fileIdNear(match);
    if (id) return { id, name: expectedName, source: 'dom' };
  }
  return null;
}

function observeConversation({ expectedName = null, onFinished, onResult }) {
  if (typeof MutationObserver !== 'function') return () => {};
  let sawGenerating = isGenerating();
  let stopped = false;
  const observer = new MutationObserver(() => check());

  function stop() {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
  }

  function check() {
    if (stopped) return;
    const generating = isGenerating();
    if (generating) sawGenerating = true;
    const file = expectedName ? findResultFileInDom(expectedName) : null;
    if (file && onResult) {
      stop();
      onResult(file);
      return;
    }
    if (sawGenerating && !generating && onFinished) {
      stop();
      onFinished();
    }
  }

  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-disabled', 'disabled', 'href', 'data-file-id'],
  });
  check();
  return stop;
}

module.exports = {
  CANDIDATE_SELECTOR, FILE_ID_PATTERN, fileIdNear, findResultFileInDom, idSourceOf, isGenerating, labelOf,
  observeConversation,
};
