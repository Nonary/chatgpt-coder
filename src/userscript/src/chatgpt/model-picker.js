const {
  TASK_MODEL_PICKER_OPTIONS,
  TASK_REASONING_PICKER_OPTIONS,
} = require('../../../shared/chatgpt');
const { isDarkTheme, observeTheme } = require('../ui/theme');

const PICKER_TAG = 'patchwork-model-selector';
const MENU_TAG = 'patchwork-model-menu';
const SLOT_TAG = 'patchwork-model-selector-slot';
const PICKER_ID = 'patchwork-task-model-selector';
const MENU_ID = 'patchwork-task-model-menu';
const SLOT_ID = 'patchwork-task-model-selector-slot';
const SUPPRESSION_ID = 'patchwork-native-model-selector-suppression';
const GUARD_INTERVAL_MILLISECONDS = 2_000;
const MUTATION_SETTLE_MILLISECONDS = 250;
const MENU_HEIGHT = 374;
const MENU_WIDTH = 260;

const NATIVE_PICKER_SELECTOR = [
  '[aria-label^="Model selector" i]',
  '[aria-label*="current model" i]',
  '[style*="--vt-thread-model-switcher"]',
  '[data-testid="model-switcher-dropdown"]',
  '[data-testid="model-switcher-dropdown-button"]',
  '[data-testid="model-switcher-dropdown"] > button',
  'button.composer-intelligence-button',
  'button[class*="composer-intelligence-button"]',
].join(', ');

const NATIVE_PICKER_LABEL = /^(?:ChatGPT(?:\s+5(?:\.\d+)*)?|GPT-5(?:\.\d+)*(?:\s+(?:Sol|Luna|Instant|Thinking|Auto|Pro))?|5\.6\s+(?:Sol|Luna)|Instant|Thinking(?:\s+mini)?|Auto|Pro)$/i;
const COMPOSER_PROMPT_SELECTOR = '#prompt-textarea, [data-testid=\"prompt-textarea\"]';
const COMPOSER_SEND_SELECTOR = '[data-testid=\"send-button\"], button[aria-label^=\"Send\" i]';

const MENU_ITEMS = [
  { section: 'Model' },
  { choice: 'model:sol', label: 'GPT-5.6 Sol' },
  { choice: 'model:luna', label: 'GPT-5.6 Luna' },
  { divider: true },
  { section: 'Thinking' },
  { choice: 'reasoning:default', label: 'Auto' },
  { choice: 'reasoning:instant', label: 'Instant' },
  { choice: 'reasoning:low', label: 'Low' },
  { choice: 'reasoning:medium', label: 'Medium' },
  { choice: 'reasoning:high', label: 'High' },
  { choice: 'reasoning:extra-high', label: 'Extra High' },
];

// Both shadow roots carry the same tokens the dock uses, taken from ChatGPT's
// own theme blocks, and switch on a data-theme attribute rather than reading the
// page's variables - the picker has to look native in a composer whose internal
// custom-property names are not ours to depend on.
const THEME_TOKENS = `
:host{--surface-elevated:#2f2f2f;--surface-hover:rgba(255,255,255,.08);
  --surface-active:rgba(255,255,255,.12);--border:rgba(255,255,255,.1);
  --text:#ececec;--text-secondary:rgba(255,255,255,.7);
  --shadow:0 10px 34px rgba(0,0,0,.5)}
:host([data-theme="light"]){--surface-elevated:#ffffff;--surface-hover:rgba(0,0,0,.05);
  --surface-active:rgba(0,0,0,.08);--border:rgba(0,0,0,.1);
  --text:#0d0d0d;--text-secondary:rgba(0,0,0,.6);
  --shadow:0 10px 34px rgba(0,0,0,.12)}
`;

const FONT_STACK = '"OpenAI Sans","OpenAI Sans Variable Scripts",ui-sans-serif,'
  + '-apple-system,system-ui,"Segoe UI",Helvetica,Arial,sans-serif';

const PICKER_CSS = `${THEME_TOKENS}
:host{display:inline-flex;align-items:center;color:var(--text);font-family:${FONT_STACK}}
button{display:inline-flex;height:32px;align-items:center;gap:4px;padding:0 10px;border:0;
  border-radius:999px;color:inherit;background:transparent;font:400 14px/20px inherit;
  white-space:nowrap;cursor:pointer;transition:background-color .15s ease}
button:hover{background:var(--surface-hover)}
button[aria-expanded="true"]{background:var(--surface-active)}
.chevron{width:16px;height:16px;transition:transform .15s ease}
button[aria-expanded="true"] .chevron{transform:rotate(180deg)}
`;

const MENU_CSS = `${THEME_TOKENS}
:host([hidden]){display:none!important}
.menu{box-sizing:border-box;width:${MENU_WIDTH}px;padding:6px;border:1px solid var(--border);
  border-radius:16px;background:var(--surface-elevated);box-shadow:var(--shadow);
  color:var(--text);font-family:${FONT_STACK};font-size:14px;line-height:20px}
.section{padding:8px 10px 4px;color:var(--text-secondary);font-size:13px;font-weight:500}
.divider{height:1px;margin:5px 4px;background:var(--border)}
button{display:flex;box-sizing:border-box;width:100%;align-items:center;justify-content:space-between;
  padding:9px 10px;border:0;border-radius:10px;color:inherit;background:transparent;font:inherit;
  text-align:left;cursor:pointer;transition:background-color .15s ease}
button:hover{background:var(--surface-hover)}
button[aria-checked="true"]{background:var(--surface-active)}
button[aria-checked="true"]::after{content:"\\2713";margin-left:16px;font-size:14px}
`;

let selection = { taskId: null, model: 'default', reasoningMode: 'default' };
let session = null;
const themedHosts = new Set();
let stopThemeWatch = null;

// One observer keeps every shadow host mounted into the composer on the same
// theme as the conversation behind it. Hosts are tracked before they are mounted,
// so the attribute is written straight away rather than waiting for a change, and
// the set is emptied by uninstallDom() when those hosts are torn down.
function trackTheme(host) {
  themedHosts.add(host);
  host.setAttribute('data-theme', isDarkTheme() ? 'dark' : 'light');
  if (stopThemeWatch) return;
  stopThemeWatch = observeTheme((dark) => {
    for (const tracked of themedHosts) tracked.setAttribute('data-theme', dark ? 'dark' : 'light');
  });
}

/* ------------------------------------------------------------------ pure logic */

function displayModel(current = selection) {
  return current.model === 'default' ? 'sol' : current.model;
}

function compactModelLabel(model) {
  return model === 'luna' ? 'Luna' : 'Sol';
}

function reasoningLabel(mode) {
  return TASK_REASONING_PICKER_OPTIONS[mode]?.label || 'Auto';
}

function displayLabel(current = selection) {
  const thinking = current.reasoningMode === 'default' ? 'Auto' : reasoningLabel(current.reasoningMode);
  return `${compactModelLabel(displayModel(current))} · ${thinking}`;
}

function selectedSlug(current = selection) {
  const option = TASK_MODEL_PICKER_OPTIONS[displayModel(current)];
  if (current.reasoningMode === 'instant') return option.instantSlug;
  if (current.reasoningMode === 'default') return option.defaultSlug;
  return option.thinkingSlug;
}

function isChecked(choice, current = selection) {
  const [kind, value] = choice.split(':');
  return kind === 'model' ? displayModel(current) === value : current.reasoningMode === value;
}

function applyChoice(choice, current = selection) {
  const [kind, value] = choice.split(':');
  if (kind === 'model') current.model = value;
  else current.reasoningMode = value;
  return current;
}

// What the request interceptor should enforce right now, including any change the
// user made in the picker after the task was created.
function currentSelection() {
  return { model: selection.model, reasoningMode: selection.reasoningMode };
}

// Lets the dock's model and reasoning controls drive the composer picker, so the
// two never disagree about what the next send will use.
function setSelection({ model, reasoningMode } = {}) {
  if (model) selection.model = model;
  if (reasoningMode) selection.reasoningMode = reasoningMode;
  const picker = document.getElementById(PICKER_ID);
  picker?.__patchworkRender?.();
  session?.menu?.renderMenu?.();
  return currentSelection();
}

function isInstalled() {
  return Boolean(session && document.getElementById(PICKER_ID));
}

/* ----------------------------------------------------------------- DOM helpers */

function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value == null) continue;
    if (name === 'style') node.style.cssText = value;
    else node.setAttribute(name, String(value));
  }
  for (const child of children) node.append(child);
  return node;
}

function adopt(root, css) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  root.adoptedStyleSheets = [sheet];
}

function chevron() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'chevron');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'm4 6 4 4 4-4');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

// ChatGPT records the last used model per account; keeping it in step stops the
// native picker from snapping back to a different model on the next render.
function persistSelection() {
  return fetch(
    `/backend-api/settings/user_last_used_model_config?model_slug=${encodeURIComponent(selectedSlug())}`,
    { method: 'PATCH', credentials: 'include' },
  ).catch(() => null);
}

/* --------------------------------------------------------------------- widgets */

function buildMenu(picker, renderPicker) {
  document.getElementById(MENU_ID)?.remove();
  const host = el(MENU_TAG, {
    id: MENU_ID,
    style: 'position:fixed;z-index:2147483647;left:0;top:0;',
  });
  host.hidden = true;
  trackTheme(host);
  const shadow = host.attachShadow({ mode: 'closed' });
  adopt(shadow, MENU_CSS);

  const menu = el('div', { class: 'menu', role: 'menu' });
  const options = [];
  for (const item of MENU_ITEMS) {
    if (item.section) {
      menu.append(el('div', { class: 'section' }, [item.section]));
    } else if (item.divider) {
      menu.append(el('div', { class: 'divider' }));
    } else {
      const option = el('button', {
        type: 'button', role: 'menuitemradio', 'data-choice': item.choice,
      }, [item.label]);
      option.addEventListener('click', () => {
        applyChoice(item.choice);
        renderPicker();
        // eslint-disable-next-line no-use-before-define
        renderMenu();
        // eslint-disable-next-line no-use-before-define
        close();
        persistSelection();
        session?.onChange?.(currentSelection());
      });
      options.push(option);
      menu.append(option);
    }
  }
  shadow.append(menu);

  const renderMenu = () => {
    for (const option of options) {
      option.setAttribute('aria-checked', String(isChecked(option.getAttribute('data-choice'))));
    }
  };
  const close = () => {
    host.hidden = true;
    picker.__patchworkSetExpanded?.(false);
  };
  const open = () => {
    const bounds = picker.getBoundingClientRect();
    const below = bounds.bottom + 6;
    const above = bounds.top - MENU_HEIGHT - 6;
    const dockWidth = Number.parseInt(
      getComputedStyle(document.documentElement).getPropertyValue('--patchwork-dock-width'), 10,
    ) || 0;
    const rightEdge = window.innerWidth - dockWidth - MENU_WIDTH - 8;
    host.style.left = `${Math.max(8, Math.min(bounds.left, rightEdge))}px`;
    host.style.top = `${below + MENU_HEIGHT <= window.innerHeight - 8 ? below : Math.max(8, above)}px`;
    renderMenu();
    host.hidden = false;
    picker.__patchworkSetExpanded?.(true);
  };

  picker.__patchworkToggleMenu = () => (host.hidden ? open() : close());
  picker.__patchworkCloseMenu = close;
  document.body.append(host);
  return { host, options, renderMenu };
}

// The picker is mounted inside the slot that replaced ChatGPT's own control, so
// it inherits the composer's position and moves with it. Nothing is positioned
// against the viewport, which is what previously left it stranded over the dock.
function mountPicker(picker, slot) {
  if (!slot || picker.parentElement === slot) return;
  slot.append(picker);
}

// The native control is replaced by a same-sized invisible slot so the composer's
// flex layout does not reflow when Patchwork's picker floats over it.
function resizeLayoutSlot(picker) {
  const slot = document.getElementById(SLOT_ID);
  if (!slot) return;
  const bounds = picker.getBoundingClientRect();
  const width = Math.ceil(Math.max(Number(slot.dataset.nativeWidth || 0), bounds.width));
  const height = Math.ceil(Math.max(Number(slot.dataset.nativeHeight || 0), bounds.height));
  const values = {
    display: 'inline-flex',
    alignItems: 'center',
    verticalAlign: 'middle',
    minWidth: `${Math.min(width, 220)}px`,
    minHeight: `${height}px`,
  };
  for (const [property, value] of Object.entries(values)) {
    if (slot.style[property] !== value) slot.style[property] = value;
  }
}

function buildPicker() {
  const picker = el(PICKER_TAG, {
    id: PICKER_ID,
    'data-task-id': String(selection.taskId || ''),
    style: 'display:inline-flex;align-items:center;min-width:0;vertical-align:middle;',
  });
  trackTheme(picker);
  const shadow = picker.attachShadow({ mode: 'closed' });
  adopt(shadow, PICKER_CSS);

  const label = el('span', { class: 'label' });
  const button = el('button', {
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    'aria-label': 'Model and thinking selector',
  }, [label, chevron()]);
  shadow.append(button);

  const renderPicker = () => {
    picker.setAttribute('data-model', selection.model);
    picker.setAttribute('data-reasoning-mode', selection.reasoningMode);
    label.textContent = displayLabel();
    requestAnimationFrame(() => resizeLayoutSlot(picker));
  };
  picker.__patchworkSetExpanded = (expanded) => button.setAttribute('aria-expanded', String(expanded));
  picker.__patchworkRender = renderPicker;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    picker.__patchworkToggleMenu?.();
  });

  renderPicker();
  session.menu = buildMenu(picker, renderPicker);
  return picker;
}

/* ------------------------------------------------------- native picker takeover */

function findNativePickers(scanLabels = true) {
  const selectorMatched = [...document.querySelectorAll(NATIVE_PICKER_SELECTOR)];
  // The semantic fallback measures every button on the page. Use it only for
  // the initial/periodic guard scan; ordinary ChatGPT mutations first take the
  // cheap selector path used by its current composer.
  const labelMatched = selectorMatched.length > 0 || !scanLabels
    ? []
    : [...document.querySelectorAll('button, [role="button"]')].filter((candidate) => {
      const bounds = candidate.getBoundingClientRect();
      const labels = [candidate, ...candidate.querySelectorAll(':scope > span')]
        .map((value) => String(value?.textContent ?? '').replace(/\s+/g, ' ').trim());
      return bounds.width > 0 && bounds.width <= 360
        && bounds.height > 0 && bounds.height <= 64
        && labels.some((text) => NATIVE_PICKER_LABEL.test(text));
    });
  return [...new Set([...selectorMatched, ...labelMatched]
    .map((anchor) => anchor.closest('button, [role="button"], [aria-haspopup="menu"]') || anchor))]
    .filter((candidate) => !candidate.closest(PICKER_TAG));
}

function findComposerActionRow() {
  const prompt = document.querySelector(COMPOSER_PROMPT_SELECTOR);
  const composer = prompt?.closest('form, [data-composer-surface]');
  const sendButton = composer?.querySelector(COMPOSER_SEND_SELECTOR);
  if (!prompt || !composer || !sendButton) return null;

  let candidate = sendButton.parentElement;
  let fallback = candidate;
  while (candidate && candidate !== composer) {
    if (!candidate.contains(prompt)) {
      fallback = candidate;
      if (candidate.querySelectorAll('button, [role=\"button\"]').length > 1) return candidate;
    }
    candidate = candidate.parentElement;
  }
  return fallback;
}

function ensureComposerFallbackSlot(slot) {
  if (slot?.isConnected) return slot;
  const actionRow = findComposerActionRow();
  if (!actionRow) return null;
  const fallbackSlot = el(SLOT_TAG, { id: SLOT_ID, 'data-fallback': 'composer-actions' });
  actionRow.insertBefore(fallbackSlot, actionRow.firstChild);
  fallbackSlot.dataset.nativeWidth = '0';
  fallbackSlot.dataset.nativeHeight = String(actionRow.getBoundingClientRect().height || 32);
  return fallbackSlot;
}

function replaceNativePickers(scanLabels = true) {
  const nativePickers = findNativePickers(scanLabels);
  const visible = nativePickers.find((candidate) => {
    const bounds = candidate.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0;
  }) || null;

  let slot = document.getElementById(SLOT_ID);
  for (const nativePicker of nativePickers) {
    if (!nativePicker.isConnected) continue;
    if (nativePicker !== visible) {
      nativePicker.remove();
      continue;
    }
    if (slot && slot.parentElement !== nativePicker.parentElement) {
      slot.remove();
      slot = null;
    }
    const nativeBounds = nativePicker.getBoundingClientRect();
    if (!slot) {
      slot = el(SLOT_TAG, { id: SLOT_ID });
      nativePicker.replaceWith(slot);
    } else {
      nativePicker.remove();
    }
    slot.dataset.nativeWidth = String(nativeBounds.width);
    slot.dataset.nativeHeight = String(nativeBounds.height);
  }

  // Project conversations can omit ChatGPT's native model control. In that case
  // use the composer's own action row rather than falling back to viewport
  // coordinates, so the picker remains attached to the composer as it moves.
  slot = ensureComposerFallbackSlot(slot);
  if (!slot?.isConnected) {
    document.getElementById(PICKER_ID)?.remove();
    return null;
  }

  let picker = document.getElementById(PICKER_ID);
  if (!picker) {
    picker = buildPicker();
    persistSelection();
  }
  mountPicker(picker, slot);
  resizeLayoutSlot(picker);
  return picker;
}

function installSuppressionStyle() {
  const style = document.getElementById(SUPPRESSION_ID) || document.createElement('style');
  style.id = SUPPRESSION_ID;
  style.textContent = `${NATIVE_PICKER_SELECTOR} { visibility: hidden !important; pointer-events: none !important; }`;
  if (!style.parentElement) document.head.append(style);
  return style;
}

/* ----------------------------------------------------------------- lifecycle */

function install({
  taskId = null, model = 'default', reasoningMode = 'default', onChange = null, keepSelection = false,
} = {}) {
  // A re-install for the same task keeps whatever the user chose in the picker.
  if (!keepSelection && (!session || selection.taskId !== taskId)) {
    selection = { taskId, model, reasoningMode };
  } else {
    selection.taskId = taskId;
  }
  const previous = session;
  const currentPicker = document.getElementById(PICKER_ID);
  const currentSlot = document.getElementById(SLOT_ID);
  // Task submission updates the existing picker; rebuilding it used to remove
  // ChatGPT's already-replaced native control and then poll for up to four
  // seconds waiting for React to render another one.
  if (previous && currentPicker?.isConnected && currentSlot?.isConnected) {
    previous.onChange = onChange || previous.onChange || null;
    currentPicker.setAttribute('data-task-id', String(selection.taskId || ''));
    currentPicker.__patchworkRender?.();
    previous.menu?.renderMenu?.();
    return {
      installed: true,
      reason: null,
      selection: currentSelection(),
    };
  }
  uninstallDom();
  session = { onChange: onChange || previous?.onChange || null };
  previous?.observer?.disconnect();
  clearInterval(previous?.guard);
  if (previous?.outsideHandler) {
    document.removeEventListener('pointerdown', previous.outsideHandler, true);
  }

  installSuppressionStyle();
  const picker = replaceNativePickers();

  let pending = false;
  const activeSession = session;
  const observer = new MutationObserver((records) => {
    const externalMutation = records.some((record) => {
      const target = record.target?.nodeType === 1 ? record.target : record.target?.parentElement;
      return !target?.closest?.(`${PICKER_TAG}, ${MENU_TAG}, ${SLOT_TAG}, #${SUPPRESSION_ID}`);
    });
    if (!externalMutation) return;
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      if (session === activeSession) replaceNativePickers(false);
    }, MUTATION_SETTLE_MILLISECONDS);
  });
  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }
  const guard = setInterval(() => {
    if (session) replaceNativePickers();
  }, GUARD_INTERVAL_MILLISECONDS);

  const outsideHandler = (event) => {
    const current = document.getElementById(PICKER_ID);
    const menu = document.getElementById(MENU_ID);
    if (event.target !== current && event.target !== menu) current?.__patchworkCloseMenu?.();
  };
  document.addEventListener('pointerdown', outsideHandler, true);

  Object.assign(session, { observer, guard, outsideHandler });
  return {
    installed: Boolean(picker),
    reason: picker ? null : 'model-picker-anchor-not-found',
    selection: currentSelection(),
  };
}

function uninstallDom() {
  themedHosts.clear();
  document.getElementById(MENU_ID)?.remove();
  document.getElementById(PICKER_ID)?.remove();
  document.getElementById(SLOT_ID)?.remove();
  document.getElementById(SUPPRESSION_ID)?.remove();
}

// The picker normally stays for the whole session so ChatGPT's composer always
// offers Sol/Luna, with or without the Patchwork dock open. Uninstalling tears
// down every hook and lets ChatGPT's own control re-render.
function uninstall() {
  if (!session) {
    uninstallDom();
    return false;
  }
  session.observer?.disconnect();
  clearInterval(session.guard);
  if (session.outsideHandler) {
    document.removeEventListener('pointerdown', session.outsideHandler, true);
  }
  uninstallDom();
  stopThemeWatch?.();
  stopThemeWatch = null;
  session = null;
  return true;
}

async function installWhenReady(options, attempts = 20, delayMilliseconds = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = install(options);
    if (result.installed) return result;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, delayMilliseconds); });
  }
  throw new Error('Could not replace the model selector.');
}

module.exports = {
  MENU_ID,
  MENU_ITEMS,
  NATIVE_PICKER_LABEL,
  NATIVE_PICKER_SELECTOR,
  PICKER_ID,
  SLOT_ID,
  SUPPRESSION_ID,
  applyChoice,
  compactModelLabel,
  currentSelection,
  displayLabel,
  displayModel,
  install,
  installWhenReady,
  isChecked,
  isInstalled,
  reasoningLabel,
  selectedSlug,
  setSelection,
  uninstall,
};
