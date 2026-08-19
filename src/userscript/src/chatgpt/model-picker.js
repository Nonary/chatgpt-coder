const {
  TASK_MODEL_PICKER_OPTIONS,
  TASK_REASONING_PICKER_OPTIONS,
} = require('../../../shared/chatgpt');

const PICKER_TAG = 'patchwork-model-selector';
const MENU_TAG = 'patchwork-model-menu';
const SLOT_TAG = 'patchwork-model-selector-slot';
const PICKER_ID = 'patchwork-task-model-selector';
const MENU_ID = 'patchwork-task-model-menu';
const SLOT_ID = 'patchwork-task-model-selector-slot';
const SUPPRESSION_ID = 'patchwork-native-model-selector-suppression';
const GUARD_INTERVAL_MILLISECONDS = 400;
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

const PICKER_CSS = `
:host{display:inline-flex;align-items:center;color:var(--text-primary,#f4f4f4);
  font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
button{display:inline-flex;min-height:32px;align-items:center;gap:4px;padding:0 8px;border:0;
  border-radius:8px;color:inherit;background:transparent;font:400 14px/20px inherit;
  white-space:nowrap;cursor:pointer}
button:hover,button[aria-expanded="true"]{background:var(--surface-hover,var(--main-surface-secondary,rgba(255,255,255,.08)))}
.chevron{width:16px;height:16px;transition:transform .15s}
button[aria-expanded="true"] .chevron{transform:rotate(180deg)}
`;

const MENU_CSS = `
:host([hidden]){display:none!important}
.menu{box-sizing:border-box;width:${MENU_WIDTH}px;padding:6px;border:1px solid rgba(255,255,255,.12);
  border-radius:16px;background:#212121;box-shadow:0 14px 36px rgba(0,0,0,.4);font-size:14px;line-height:20px}
.section{padding:7px 10px 5px;color:#aaa;font-size:12px;font-weight:600}
.divider{height:1px;margin:5px 4px;background:rgba(255,255,255,.12)}
button{display:flex;box-sizing:border-box;width:100%;align-items:center;justify-content:space-between;
  padding:9px 10px;border:0;border-radius:9px;color:#f4f4f4;background:transparent;font:inherit;
  text-align:left;cursor:pointer}
button:hover,button[aria-checked="true"]{background:#2f2f2f}
button[aria-checked="true"]::after{content:"\\2713";margin-left:16px;font-size:14px}
`;

let selection = { taskId: null, model: 'default', reasoningMode: 'default' };
let session = null;

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
    style: 'position:fixed;z-index:2147483647;left:0;top:0;color:#f4f4f4;'
      + 'font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
  });
  host.hidden = true;
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
    host.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - MENU_WIDTH - 8))}px`;
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

function rememberBounds(nativePicker) {
  const bounds = nativePicker?.getBoundingClientRect();
  if (bounds && bounds.width > 0 && bounds.height > 0) {
    session.bounds = { left: bounds.left, top: bounds.top, height: bounds.height };
  }
  return session.bounds;
}

function positionPicker(picker, nativePicker = null) {
  const saved = rememberBounds(nativePicker);
  picker.style.left = `${Math.max(8, saved?.left ?? 48)}px`;
  picker.style.top = `${Math.max(4, saved?.top ?? 8)}px`;
  if (saved?.height > 0) picker.style.minHeight = `${saved.height}px`;
}

// The native control is replaced by a same-sized invisible slot so the composer's
// flex layout does not reflow when Patchwork's picker floats over it.
function resizeLayoutSlot(picker) {
  const slot = document.getElementById(SLOT_ID);
  if (!slot) return;
  const bounds = picker.getBoundingClientRect();
  const width = Math.ceil(Math.max(Number(slot.dataset.nativeWidth || 0), bounds.width));
  const height = Math.ceil(Math.max(Number(slot.dataset.nativeHeight || 0), bounds.height));
  slot.style.cssText = `display:inline-block;flex:0 0 ${width}px;width:${width}px;`
    + `min-width:${width}px;height:${height}px;visibility:hidden;pointer-events:none;vertical-align:middle;`;
}

function buildPicker(nativePicker = null) {
  const picker = el(PICKER_TAG, {
    id: PICKER_ID,
    'data-task-id': String(selection.taskId || ''),
    style: 'display:inline-flex;position:fixed;z-index:2147483646;align-items:center;'
      + 'min-width:0;vertical-align:middle;',
  });
  positionPicker(picker, nativePicker);
  const shadow = picker.attachShadow({ mode: 'closed' });
  adopt(shadow, PICKER_CSS);

  const label = el('span', { class: 'label' });
  const button = el('button', {
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    'aria-label': 'Patchwork model selector',
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

function findNativePickers() {
  const labelMatched = [...document.querySelectorAll('button, [role="button"]')].filter((candidate) => {
    const bounds = candidate.getBoundingClientRect();
    const labels = [candidate, ...candidate.querySelectorAll(':scope > span')]
      .map((value) => String(value?.textContent ?? '').replace(/\s+/g, ' ').trim());
    return bounds.width > 0 && bounds.width <= 360
      && bounds.height > 0 && bounds.height <= 64
      && labels.some((text) => NATIVE_PICKER_LABEL.test(text));
  });
  return [...new Set([...document.querySelectorAll(NATIVE_PICKER_SELECTOR), ...labelMatched]
    .map((anchor) => anchor.closest('button, [role="button"], [aria-haspopup="menu"]') || anchor))]
    .filter((candidate) => !candidate.closest(PICKER_TAG));
}

function replaceNativePickers() {
  let picker = document.getElementById(PICKER_ID);
  const nativePickers = findNativePickers();
  const visible = nativePickers.find((candidate) => {
    const bounds = candidate.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0;
  }) || null;

  if (!picker) {
    picker = buildPicker(visible);
    document.body.append(picker);
    persistSelection();
  } else if (visible) {
    positionPicker(picker, visible);
  }

  for (const nativePicker of nativePickers) {
    if (!nativePicker.isConnected) continue;
    if (nativePicker !== visible) {
      nativePicker.remove();
      continue;
    }
    let slot = document.getElementById(SLOT_ID);
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
    resizeLayoutSlot(picker);
  }
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
  uninstallDom();
  session = { bounds: previous?.bounds || null, onChange: onChange || previous?.onChange || null };
  previous?.observer?.disconnect();
  clearInterval(previous?.guard);
  if (previous?.outsideHandler) {
    document.removeEventListener('pointerdown', previous.outsideHandler, true);
  }

  installSuppressionStyle();
  const picker = replaceNativePickers();

  let pending = false;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      if (session) replaceNativePickers();
    });
  });
  if (document.body) {
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['aria-label', 'data-testid', 'role', 'style'],
      characterData: true,
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
  throw new Error('Could not replace ChatGPT’s model selector with Patchwork’s selector.');
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
