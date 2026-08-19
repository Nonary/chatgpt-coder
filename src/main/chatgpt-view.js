const fsSync = require('node:fs');
const path = require('node:path');
const { BrowserWindow, WebContentsView, clipboard, dialog, shell } = require('electron');
const { mergeResultFilename } = require('./worktree-service');

const CHATGPT_URL = 'https://chatgpt.com/';
const CHATGPT_PROJECT_ID_PATTERN = /^g-p-[A-Za-z0-9_-]+$/;
const PARTITION = 'persist:patchwork-chatgpt';
const RESULT_NAME_PATTERN = /chatgpt-ide-result-([0-9a-f-]{36})(?:\s*\(\d+\))?\.txt/i;
const RESULT_RETRY_MILLISECONDS = 6_000;
const TASK_MONITOR_INTERVAL_MILLISECONDS = 1_500;
const NOTICE_EVENT_COOLDOWN_MILLISECONDS = 60_000;
const SUBMISSION_CONFIRMATION_TIMEOUT_MILLISECONDS = 30_000;
const TASK_REQUEST_CONFIRMATION_TIMEOUT_MILLISECONDS = 30_000;
const HIDDEN_VIEW_BOUNDS = Object.freeze({ x: 0, y: 0, width: 0, height: 0 });
const USE_SYSTEM_PROXY = process.env.PATCHWORK_USE_SYSTEM_PROXY === '1';
const CONNECTIVITY_FAILURE_WINDOW_MILLISECONDS = 2_500;
const CONNECTIVITY_RECOVERY_DELAY_MILLISECONDS = 1_500;
const RECOVERABLE_NETWORK_ERRORS = new Set([
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_RESET',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NETWORK_CHANGED',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_TIMED_OUT',
  'ERR_TUNNEL_CONNECTION_FAILED',
]);
const DISMISSIBLE_LIMIT_NOTICE = /(?:too many requests|messages? limit reached|usage (?:limit|cap) (?:reached|exceeded)|rate limit (?:reached|exceeded)|you(?:['’]ve| have) (?:reached|hit) (?:the |your )?(?:current |daily |monthly |plan )?(?:message |messages |usage |rate |chatgpt )?(?:limit|cap))/i;
const DISMISSIVE_NOTICE_ACTION = /^(?:got it|close|dismiss|ok|okay)$/i;
const CHATGPT_STREAM_STATUS_URL_PATTERN = /^https:\/\/chatgpt\.com\/backend-api\/conversation\/([^/]+)\/stream_status(?:\?.*)?$/i;
const CHATGPT_CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TASK_MODEL_PICKER_OPTIONS = {
  sol: {
    label: 'GPT-5.6 Sol',
    defaultSlug: 'gpt-5-6',
    instantSlug: 'gpt-5-6-instant',
    thinkingSlug: 'gpt-5-6-thinking',
  },
  luna: {
    label: 'GPT-5.6 Luna',
    defaultSlug: 'gpt-5-6-t-mini',
    instantSlug: 'gpt-5-6-mini',
    thinkingSlug: 'gpt-5-6-t-mini',
  },
};

const TASK_REASONING_PICKER_OPTIONS = {
  instant: { label: 'Instant', thinkingEffort: null },
  low: { label: 'Low', thinkingEffort: 'min' },
  medium: { label: 'Medium', thinkingEffort: 'standard' },
  high: { label: 'High', thinkingEffort: 'extended' },
  'extra-high': { label: 'Extra High', thinkingEffort: 'max' },
};

function sameBounds(left, right) {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function isRecoverableChatGPTNetworkFailure(details = {}) {
  const error = String(details.error || '').replace(/^net::/i, '').toUpperCase();
  if (!RECOVERABLE_NETWORK_ERRORS.has(error)) return false;
  let url;
  try {
    url = new URL(String(details.url || ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return false;
  if (details.resourceType === 'mainFrame') return true;
  return url.pathname.startsWith('/backend-api/') || url.pathname.startsWith('/cdn/assets/');
}

function taskRequestConfiguration(model, reasoningMode) {
  const requestedModel = String(model || 'default').toLowerCase();
  const requestedReasoning = String(reasoningMode || 'default').toLowerCase();
  const modelKey = requestedModel === 'default' ? 'sol' : requestedModel;
  const modelOption = TASK_MODEL_PICKER_OPTIONS[modelKey];
  const reasoningOption = TASK_REASONING_PICKER_OPTIONS[requestedReasoning] || null;
  if (!modelOption) throw new Error(`Unsupported ChatGPT model: ${model}`);
  if (requestedReasoning !== 'default' && !reasoningOption) {
    throw new Error(`Unsupported ChatGPT reasoning mode: ${reasoningMode}`);
  }
  const modelSlug = requestedReasoning === 'instant'
    ? modelOption.instantSlug
    : requestedReasoning === 'default'
      ? modelOption.defaultSlug
      : modelOption.thinkingSlug;
  return {
    model: requestedModel,
    reasoningMode: requestedReasoning,
    modelSlug,
    thinkingEffort: reasoningOption?.thinkingEffort || null,
  };
}

function rewriteConversationRequestBody(postData, configuration) {
  const payload = JSON.parse(String(postData || ''));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('ChatGPT sent an invalid conversation request.');
  }
  payload.model = configuration.modelSlug;
  if (configuration.thinkingEffort) payload.thinking_effort = configuration.thinkingEffort;
  else delete payload.thinking_effort;
  return {
    text: JSON.stringify(payload),
    model: payload.model,
    thinkingEffort: payload.thinking_effort || null,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resultTaskId(filename) {
  const basename = path.basename(String(filename || ''));
  return RESULT_NAME_PATTERN.exec(basename)?.[1]?.toLowerCase() || null;
}

function conversationIdFromStreamStatusUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return null;
    const match = CHATGPT_STREAM_STATUS_URL_PATTERN.exec(url.href);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function conversationIdFromRouteUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return null;
    const routeId = /^\/c\/([^/]+)\/?$/i.exec(url.pathname)?.[1]
      || /^\/g\/g-p-[A-Za-z0-9_-]+\/c\/([^/]+)\/?$/i.exec(url.pathname)?.[1]
      || null;
    if (!routeId || !CHATGPT_CONVERSATION_ID_PATTERN.test(routeId)) return null;
    return routeId;
  } catch {
    return null;
  }
}

function normalizeConversationStreamStatus(value) {
  const status = String(value || '').trim().toUpperCase();
  if (!status) return 'unknown';
  if (status === 'IS_STREAMING') return 'streaming';
  if (status === 'FAILURE') return 'failed';
  return 'completed';
}

function buildConversationStatusScript(conversationId) {
  const id = String(conversationId || '').trim();
  return `(async () => {
    const conversationId = ${JSON.stringify(id)};
    try {
      const response = await fetch('/backend-api/conversation/' + encodeURIComponent(conversationId) + '/stream_status', {
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch {}
      return {
        ok: response.ok,
        httpStatus: response.status,
        status: typeof data?.status === 'string' ? data.status : null,
      };
    } catch (error) {
      return { ok: false, httpStatus: 0, status: null, error: error?.message || String(error) };
    }
  })()`;
}

const MERGE_RESULT_NAME_PATTERN = /chatgpt-ide-merge-result-([0-9a-f-]{36})(?:\s*\(\d+\))?\.txt/i;

function mergeTreeId(filename) {
  return MERGE_RESULT_NAME_PATTERN.exec(path.basename(String(filename || '')))?.[1]?.toLowerCase() || null;
}

function chatGPTProjectUrl(projectId, shortUrl = null) {
  const id = String(projectId || '').trim();
  if (!CHATGPT_PROJECT_ID_PATTERN.test(id)) throw new Error('ChatGPT returned an invalid project identifier.');
  const routeId = String(shortUrl || id).trim();
  if (!CHATGPT_PROJECT_ID_PATTERN.test(routeId) || (routeId !== id && !routeId.startsWith(`${id}-`))) {
    throw new Error('ChatGPT returned an invalid project URL.');
  }
  return `https://chatgpt.com/g/${routeId}/project`;
}

function isChatGPTConversationUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && url.hostname === 'chatgpt.com'
      && (/^\/c\/[^/]+\/?$/.test(url.pathname)
        || /^\/g\/g-p-[A-Za-z0-9_-]+\/c\/[^/]+\/?$/.test(url.pathname));
  } catch {
    return false;
  }
}

function normalizeConversationTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  if (!title || /^(?:ChatGPT|New chat)$/i.test(title)) return '';
  return title;
}

async function recoverUnconfirmedSubmissions(taskService, tasks) {
  return Promise.all(tasks.map((task) => {
    if (task.state !== 'submitted' || isChatGPTConversationUrl(task.conversationUrl)) return task;
    return taskService.updateTask(task.taskId, {
      state: 'prepared',
      submittedAt: null,
      conversationUrl: null,
      conversationId: null,
      conversationTitle: null,
      chatStatus: null,
      chatStatusRaw: null,
      chatFinishedAt: null,
    });
  }));
}

function isDismissibleLimitNotice(value) {
  return DISMISSIBLE_LIMIT_NOTICE.test(String(value || '').replace(/\s+/g, ' ').trim());
}

function buildLimitNoticeDismissalScript() {
  return `(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const noticePattern = new RegExp(${JSON.stringify(DISMISSIBLE_LIMIT_NOTICE.source)}, 'i');
    const actionPattern = new RegExp(${JSON.stringify(DISMISSIVE_NOTICE_ACTION.source)}, 'i');
    const exactModal = document.querySelector('[data-testid="modal-conversation-history-rate-limit"]');
    const containers = [
      exactModal,
      ...document.querySelectorAll([
        '[role="alertdialog"]',
        '[role="alert"]',
        '[data-sonner-toast]',
        '[data-testid*="toast"]',
      ].join(', ')),
    ].filter((item, index, all) => item && all.indexOf(item) === index);
    for (const container of containers) {
      const notice = normalize(container.textContent);
      if (container !== exactModal && !noticePattern.test(notice)) continue;
      const actions = [...container.querySelectorAll('button, [role="button"]')];
      const enabledActions = actions.filter((item) => (
        !item.disabled && item.getAttribute('aria-disabled') !== 'true'
      ));
      const button = enabledActions.find((item) => {
        const visibleText = normalize(item.textContent);
        const accessibleLabel = normalize([
          item.getAttribute('aria-label'),
          item.getAttribute('title'),
          item.getAttribute('data-testid'),
        ].filter(Boolean).join(' '));
        return actionPattern.test(visibleText) || /(?:close|dismiss)/i.test(accessibleLabel);
      }) || (container === exactModal ? enabledActions[0] : null);
      if (!button) continue;
      const action = normalize(button.textContent || button.getAttribute('aria-label'));
      button.click();
      return { dismissed: true, notice: notice.slice(0, 240), action };
    }
    return { dismissed: false };
  })()`;
}

function buildTaskConfigurationScript(model, reasoningMode, taskId = null) {
  const requestConfiguration = taskRequestConfiguration(model, reasoningMode);
  return `(() => {
    const taskId = ${JSON.stringify(taskId)};
    const initialModel = ${JSON.stringify(model || 'default')};
    const initialReasoningMode = ${JSON.stringify(reasoningMode || 'default')};
    const modelOptions = ${JSON.stringify(TASK_MODEL_PICKER_OPTIONS)};
    const reasoningOptions = ${JSON.stringify(TASK_REASONING_PICKER_OPTIONS)};
    const pickerId = 'patchwork-task-model-selector';
    const menuId = 'patchwork-task-model-menu';
    const slotId = 'patchwork-task-model-selector-slot';
    const nativePickerSelector = [
      '[aria-label^="Model selector" i]',
      '[aria-label*="current model" i]',
      '[style*="--vt-thread-model-switcher"]',
      '[data-testid="model-switcher-dropdown"]',
      '[data-testid="model-switcher-dropdown-button"]',
      '[data-testid="model-switcher-dropdown"] > button',
      'button.composer-intelligence-button',
      'button[class*="composer-intelligence-button"]',
    ].join(', ');
    const nativePickerLabel = /^(?:ChatGPT(?:\\s+5(?:\\.\\d+)*)?|GPT-5(?:\\.\\d+)*(?:\\s+(?:Sol|Luna|Instant|Thinking|Auto|Pro))?|5\\.6\\s+(?:Sol|Luna)|Instant|Thinking(?:\\s+mini)?|Auto|Pro)$/i;
    const previousSelection = globalThis.__patchworkOwnedModelSelection;
    const selected = previousSelection?.taskId === taskId
      ? previousSelection
      : { taskId, model: initialModel, reasoningMode: initialReasoningMode };
    globalThis.__patchworkOwnedModelSelection = selected;

    const stalePicker = document.getElementById(pickerId);
    if (stalePicker && stalePicker.getAttribute('data-task-id') !== String(taskId || '')) stalePicker.remove();
    const staleMenu = document.getElementById(menuId);
    if (staleMenu && staleMenu.getAttribute('data-task-id') !== String(taskId || '')) staleMenu.remove();

    const compactModelLabel = (value) => value === 'luna' ? 'Luna' : 'Sol';
    const reasoningLabel = (value) => reasoningOptions[value]?.label || 'Auto';
    const displayModel = () => selected.model === 'default' ? 'sol' : selected.model;
    const displayLabel = () => compactModelLabel(displayModel())
      + ' · ' + (selected.reasoningMode === 'default' ? 'Auto' : reasoningLabel(selected.reasoningMode));
    const selectedSlug = () => {
      const option = modelOptions[displayModel()];
      if (selected.reasoningMode === 'instant') return option.instantSlug;
      if (selected.reasoningMode === 'default') return option.defaultSlug;
      return option.thinkingSlug;
    };
    const persistSelection = () => fetch(
      '/backend-api/settings/user_last_used_model_config?model_slug=' + encodeURIComponent(selectedSlug()),
      { method: 'PATCH', credentials: 'include' },
    ).catch(() => null);

    const suppressionStyle = document.getElementById('patchwork-native-model-selector-suppression')
      || document.createElement('style');
    suppressionStyle.id = 'patchwork-native-model-selector-suppression';
    suppressionStyle.textContent = nativePickerSelector
      + ' { visibility: hidden !important; pointer-events: none !important; }';
    if (!suppressionStyle.parentElement) document.head.append(suppressionStyle);

    const createMenu = (picker, renderPicker) => {
      document.getElementById(menuId)?.remove();
      const menuHost = document.createElement('patchwork-model-menu');
      menuHost.id = menuId;
      menuHost.setAttribute('data-task-id', String(taskId || ''));
      menuHost.hidden = true;
      menuHost.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;color:#f4f4f4;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
      const menu = menuHost.attachShadow({ mode: 'closed' });
      menu.innerHTML = [
        '<style>',
        ':host([hidden]){display:none!important}',
        '.menu{box-sizing:border-box;width:260px;padding:6px;border:1px solid rgba(255,255,255,.12);border-radius:16px;background:#212121;box-shadow:0 14px 36px rgba(0,0,0,.4);font-size:14px;line-height:20px}',
        '.section{padding:7px 10px 5px;color:#aaa;font-size:12px;font-weight:600}',
        '.divider{height:1px;margin:5px 4px;background:rgba(255,255,255,.12)}',
        'button{display:flex;box-sizing:border-box;width:100%;align-items:center;justify-content:space-between;padding:9px 10px;border:0;border-radius:9px;color:#f4f4f4;background:transparent;font:inherit;text-align:left;cursor:pointer}',
        'button:hover,button[aria-checked="true"]{background:#2f2f2f}',
        'button[aria-checked="true"]::after{content:"✓";margin-left:16px;font-size:14px}',
        '</style>',
        '<div class="menu" role="menu">',
        '<div class="section">Model</div>',
        '<button type="button" role="menuitemradio" data-choice="model:sol">GPT-5.6 Sol</button>',
        '<button type="button" role="menuitemradio" data-choice="model:luna">GPT-5.6 Luna</button>',
        '<div class="divider"></div>',
        '<div class="section">Thinking</div>',
        '<button type="button" role="menuitemradio" data-choice="reasoning:default">Auto</button>',
        '<button type="button" role="menuitemradio" data-choice="reasoning:instant">Instant</button>',
        '<button type="button" role="menuitemradio" data-choice="reasoning:low">Low</button>',
        '<button type="button" role="menuitemradio" data-choice="reasoning:medium">Medium</button>',
        '<button type="button" role="menuitemradio" data-choice="reasoning:high">High</button>',
        '<button type="button" role="menuitemradio" data-choice="reasoning:extra-high">Extra High</button>',
        '</div>',
      ].join('');
      const renderMenu = () => menu.querySelectorAll('[data-choice]').forEach((option) => {
        const [kind, value] = option.getAttribute('data-choice').split(':');
        const checked = kind === 'model' ? displayModel() === value : selected.reasoningMode === value;
        option.setAttribute('aria-checked', String(checked));
      });
      const closeMenu = () => {
        menuHost.hidden = true;
        picker.__patchworkSetExpanded?.(false);
      };
      const openMenu = () => {
        const bounds = picker.getBoundingClientRect();
        const menuHeight = 374;
        const below = bounds.bottom + 6;
        const above = bounds.top - menuHeight - 6;
        menuHost.style.left = Math.max(8, Math.min(bounds.left, innerWidth - 268)) + 'px';
        menuHost.style.top = (below + menuHeight <= innerHeight - 8 ? below : Math.max(8, above)) + 'px';
        renderMenu();
        menuHost.hidden = false;
        picker.__patchworkSetExpanded?.(true);
      };
      menu.querySelectorAll('[data-choice]').forEach((option) => option.addEventListener('click', () => {
        const [kind, value] = option.getAttribute('data-choice').split(':');
        if (kind === 'model') selected.model = value;
        else selected.reasoningMode = value;
        renderPicker();
        renderMenu();
        closeMenu();
        persistSelection();
      }));
      picker.__patchworkToggleMenu = () => menuHost.hidden ? openMenu() : closeMenu();
      picker.__patchworkCloseMenu = closeMenu;
      document.body.append(menuHost);
      return menuHost;
    };

    const positionPicker = (picker, nativePicker = null) => {
      const bounds = nativePicker?.getBoundingClientRect();
      if (bounds && bounds.width > 0 && bounds.height > 0) {
        globalThis.__patchworkOwnedModelPickerBounds = {
          left: bounds.left,
          top: bounds.top,
          height: bounds.height,
        };
      }
      const saved = globalThis.__patchworkOwnedModelPickerBounds;
      picker.style.left = Math.max(8, saved?.left ?? 48) + 'px';
      picker.style.top = Math.max(4, saved?.top ?? 8) + 'px';
      if (saved?.height > 0) picker.style.minHeight = saved.height + 'px';
    };

    const resizeLayoutSlot = (picker) => {
      const slot = document.getElementById(slotId);
      if (!slot) return;
      const pickerBounds = picker.getBoundingClientRect();
      const width = Math.ceil(Math.max(Number(slot.dataset.nativeWidth || 0), pickerBounds.width));
      const height = Math.ceil(Math.max(Number(slot.dataset.nativeHeight || 0), pickerBounds.height));
      slot.style.cssText = 'display:inline-block;flex:0 0 ' + width + 'px;width:' + width
        + 'px;min-width:' + width + 'px;height:' + height
        + 'px;visibility:hidden;pointer-events:none;vertical-align:middle;';
    };

    const createPicker = (nativePicker = null) => {
      const picker = document.createElement('patchwork-model-selector');
      picker.id = pickerId;
      picker.setAttribute('data-task-id', String(taskId || ''));
      picker.style.cssText = 'display:inline-flex;position:fixed;z-index:2147483646;align-items:center;min-width:0;vertical-align:middle;';
      positionPicker(picker, nativePicker);
      const shadow = picker.attachShadow({ mode: 'closed' });
      shadow.innerHTML = [
        '<style>',
        ':host{display:inline-flex;align-items:center;color:var(--text-primary,#f4f4f4);font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
        'button{display:inline-flex;min-height:32px;align-items:center;gap:4px;padding:0 8px;border:0;border-radius:8px;color:inherit;background:transparent;font:400 14px/20px inherit;white-space:nowrap;cursor:pointer}',
        'button:hover,button[aria-expanded="true"]{background:var(--surface-hover,var(--main-surface-secondary,rgba(255,255,255,.08)))}',
        '.chevron{width:16px;height:16px;transition:transform .15s}',
        'button[aria-expanded="true"] .chevron{transform:rotate(180deg)}',
        '</style>',
        '<button type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Patchwork model selector"><span class="label"></span><svg class="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>',
      ].join('');
      const button = shadow.querySelector('button');
      const renderPicker = () => {
        picker.setAttribute('data-model', selected.model);
        picker.setAttribute('data-reasoning-mode', selected.reasoningMode);
        shadow.querySelector('.label').textContent = displayLabel();
        requestAnimationFrame(() => resizeLayoutSlot(picker));
      };
      picker.__patchworkSetExpanded = (expanded) => button.setAttribute('aria-expanded', String(expanded));
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        picker.__patchworkToggleMenu?.();
      });
      renderPicker();
      createMenu(picker, renderPicker);
      return picker;
    };

    const replaceNativePickers = () => {
      let picker = document.getElementById(pickerId);
      const labelMatchedPickers = [...document.querySelectorAll('button, [role="button"]')]
        .filter((candidate) => {
          const bounds = candidate.getBoundingClientRect();
          const labels = [candidate.textContent, ...candidate.querySelectorAll(':scope > span')]
            .map((value) => String(value?.textContent ?? value ?? '').replace(/\\s+/g, ' ').trim());
          return bounds.width > 0 && bounds.width <= 360
            && bounds.height > 0 && bounds.height <= 64
            && labels.some((label) => nativePickerLabel.test(label));
        });
      const nativePickers = [...new Set([
        ...document.querySelectorAll(nativePickerSelector),
        ...labelMatchedPickers,
      ]
        .map((anchor) => anchor.closest('button, [role="button"], [aria-haspopup="menu"]') || anchor))]
        .filter((candidate) => !candidate.closest('patchwork-model-selector'));
      const visible = nativePickers.find((candidate) => {
        const bounds = candidate.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
      }) || null;
      if (!picker) {
        picker = createPicker(visible);
        document.body.append(picker);
        persistSelection();
      } else if (visible) positionPicker(picker, visible);
      for (const nativePicker of nativePickers) {
        if (!nativePicker.isConnected) continue;
        if (nativePicker === visible) {
          let slot = document.getElementById(slotId);
          if (slot && slot.parentElement !== nativePicker.parentElement) {
            slot.remove();
            slot = null;
          }
          const nativeBounds = nativePicker.getBoundingClientRect();
          if (!slot) {
            slot = document.createElement('patchwork-model-selector-slot');
            slot.id = slotId;
            nativePicker.replaceWith(slot);
          } else {
            nativePicker.remove();
          }
          slot.dataset.nativeWidth = String(nativeBounds.width);
          slot.dataset.nativeHeight = String(nativeBounds.height);
          resizeLayoutSlot(picker);
        } else {
          nativePicker.remove();
        }
      }
      return picker;
    };

    globalThis.__patchworkModelPickerObserver?.disconnect();
    const picker = replaceNativePickers();
    let observerPending = false;
    const observer = new MutationObserver(() => {
      if (observerPending) return;
      observerPending = true;
      queueMicrotask(() => {
        observerPending = false;
        replaceNativePickers();
      });
    });
    if (document.body) observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['aria-label', 'data-testid', 'role', 'style'],
      characterData: true,
      childList: true,
      subtree: true,
    });
    globalThis.__patchworkModelPickerObserver = observer;
    clearInterval(globalThis.__patchworkNativeModelPickerGuard);
    globalThis.__patchworkNativeModelPickerGuard = setInterval(replaceNativePickers, 400);

    if (globalThis.__patchworkPickerOutsideHandler) {
      document.removeEventListener('pointerdown', globalThis.__patchworkPickerOutsideHandler, true);
    }
    globalThis.__patchworkPickerOutsideHandler = (event) => {
      const currentPicker = document.getElementById(pickerId);
      const currentMenu = document.getElementById(menuId);
      if (event.target !== currentPicker && event.target !== currentMenu) currentPicker?.__patchworkCloseMenu?.();
    };
    document.addEventListener('pointerdown', globalThis.__patchworkPickerOutsideHandler, true);

    return {
      ok: true,
      pickerInstalled: Boolean(picker),
      reason: picker ? null : 'model-picker-anchor-not-found',
      identity: picker?.tagName || null,
      model: ${JSON.stringify(requestConfiguration.modelSlug)},
      thinkingEffort: ${JSON.stringify(requestConfiguration.thinkingEffort)},
    };
  })()`;
}

function buildPackageAttachmentStatusScript(filename, dismissDuplicateNotice = false) {
  return `(() => {
    const filename = ${JSON.stringify(filename)};
    const target = filename.toLowerCase();
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0;
    };
    const roots = [document];
    const visited = new Set();
    const notices = [];
    const candidates = [];
    const fileInputs = [];
    while (roots.length) {
      const root = roots.shift();
      if (!root || visited.has(root)) continue;
      visited.add(root);
      notices.push(...root.querySelectorAll('[role="dialog"], [role="alert"], [aria-live]'));
      fileInputs.push(...root.querySelectorAll('input[type="file"]'));
      candidates.push(...root.querySelectorAll(
        '[data-testid*="file"], [data-testid*="attach"], [aria-label], [title], span, div'
      ));
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    const duplicateNotice = notices.filter(visible).find((element) => /already (?:been )?uploaded|already uploaded|duplicate file/i.test(
      [element.textContent, element.getAttribute('aria-label')].filter(Boolean).join(' '),
    ));
    let dismissedDuplicate = false;
    if (duplicateNotice && ${Boolean(dismissDuplicateNotice)}) {
      const buttons = [...duplicateNotice.querySelectorAll('button')];
      const dismiss = buttons.find((button) => /^(?:got it|close|dismiss|ok|okay)$/i.test([
        button.textContent, button.getAttribute('aria-label'), button.getAttribute('title'),
      ].filter(Boolean).join(' ').trim()))
        || duplicateNotice.querySelector('button[data-testid*="close"], button[aria-label="Close"]');
      if (dismiss) {
        dismiss.click();
        dismissedDuplicate = true;
      }
    }
    const selectedByInput = fileInputs.some((input) => [...(input.files || [])]
      .some((file) => file.name === filename));
    // Source Control intentionally keeps the embedded ChatGPT view hidden at
    // zero bounds while a summary runs. Attachment chips still exist in the
    // page DOM in that state, but their client rectangles are empty. The task
    // package filename contains a unique task ID, so DOM presence is the
    // reliable confirmation signal here; rendered geometry is not.
    const attachment = candidates.find((element) => {
      const labels = [
        element.textContent,
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
      ].filter(Boolean).map((value) => String(value).replace(/\\s+/g, ' ').trim().toLowerCase());
      const matchesFilename = labels.some((value) => value.includes(target));
      if (!matchesFilename) return false;
      return Boolean(element.closest?.('[data-testid*="file"], [data-testid*="attach"]'))
        || labels.some((value) => value === target)
        || /file|attach/i.test([
          element.getAttribute('data-testid'),
          element.getAttribute('aria-label'),
        ].filter(Boolean).join(' '));
    });
    if (!attachment) return {
      attached: false,
      busy: selectedByInput,
      selectedByInput,
      duplicateNotice: Boolean(duplicateNotice),
      dismissedDuplicate,
    };
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
  })()`;
}


function buildFileInputEventScript(filename) {
  return `(async () => {
    const filename = ${JSON.stringify(filename)};
    const deadline = Date.now() + 2_000;
    const findInput = () => {
      const roots = [document];
      const visited = new Set();
      while (roots.length) {
        const root = roots.shift();
        if (!root || visited.has(root)) continue;
        visited.add(root);
        const input = [...root.querySelectorAll('input[type="file"]')]
          .find((element) => [...(element.files || [])]
            .some((file) => file.name === filename));
        if (input) return input;
        for (const element of root.querySelectorAll('*')) {
          if (element.shadowRoot) roots.push(element.shadowRoot);
        }
      }
      return null;
    };
    while (Date.now() < deadline) {
      const input = findInput();
      if (input) {
        const eventOptions = { bubbles: true, composed: true };
        input.dispatchEvent(new Event('input', eventOptions));
        input.dispatchEvent(new Event('change', eventOptions));
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  })()`;
}

function buildTaskResultDetectionScript(taskOrId, streamFinished = false) {
  const task = typeof taskOrId === 'string' ? { taskId: taskOrId } : taskOrId;
  const expectedName = task.resultFilename || `chatgpt-ide-result-${task.taskId}.txt`;
  return `(() => {
    const expected = ${JSON.stringify(expectedName.toLowerCase())};
    const streamFinished = ${Boolean(streamFinished)};
    const stopButton = document.querySelector('[data-testid="stop-button"]');
    if (!streamFinished && stopButton && !stopButton.disabled && stopButton.getAttribute('aria-disabled') !== 'true') {
      return { kind: 'generating' };
    }
    const roots = [document];
    const candidates = [];
    const visited = new Set();
    while (roots.length) {
      const root = roots.shift();
      if (!root || visited.has(root)) continue;
      visited.add(root);
      candidates.push(...root.querySelectorAll('a[href], a[download], button, [role="link"], [role="button"]'));
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    const match = candidates.find((element) => {
      const label = [
        element.getAttribute('download'),
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.textContent,
        element.getAttribute('href'),
      ].filter(Boolean).join(' ').toLowerCase();
      return label.includes(expected);
    });
    if (!match) return { kind: 'none' };
    let control = match;
    let container = match;
    for (let depth = 0; container && depth < 6; depth += 1, container = container.parentElement) {
      const download = [...(container.querySelectorAll?.([
        'a[download]',
        'button[aria-label="Download file"]',
        'button[aria-label="Download"]',
        '[role="button"][aria-label="Download file"]',
      ].join(', ')) || [])].find((element) => (
        element !== match && !element.disabled && element.getAttribute('aria-disabled') !== 'true'
      ));
      if (download) {
        control = download;
        break;
      }
    }
    control.scrollIntoView({ block: 'center', inline: 'center' });
    control.click();
    return {
      kind: 'download',
      label: String(match.textContent || match.getAttribute('aria-label') || '').trim(),
    };
  })()`;
}

function buildMergeResultDetectionScript(treeId) {
  const expectedName = mergeResultFilename(treeId);
  return `(() => {
    const expected = ${JSON.stringify(expectedName.toLowerCase())};
    const stopButton = document.querySelector('[data-testid="stop-button"]');
    if (stopButton && !stopButton.disabled && stopButton.getAttribute('aria-disabled') !== 'true') {
      return { kind: 'generating' };
    }
    const roots = [document];
    const candidates = [];
    const visited = new Set();
    while (roots.length) {
      const root = roots.shift();
      if (!root || visited.has(root)) continue;
      visited.add(root);
      candidates.push(...root.querySelectorAll('a[href], a[download], button, [role="link"], [role="button"]'));
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    const match = candidates.find((element) => {
      const label = [
        element.getAttribute('download'),
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.textContent,
        element.getAttribute('href'),
      ].filter(Boolean).join(' ').toLowerCase();
      return label.includes(expected);
    });
    if (!match) return { kind: 'none' };
    let control = match;
    let container = match;
    for (let depth = 0; container && depth < 6; depth += 1, container = container.parentElement) {
      const download = [...(container.querySelectorAll?.([
        'a[download]',
        'button[aria-label="Download file"]',
        'button[aria-label="Download"]',
        '[role="button"][aria-label="Download file"]',
      ].join(', ')) || [])].find((element) => (
        element !== match && !element.disabled && element.getAttribute('aria-disabled') !== 'true'
      ));
      if (download) {
        control = download;
        break;
      }
    }
    control.scrollIntoView({ block: 'center', inline: 'center' });
    control.click();
    return {
      kind: 'download',
      label: String(match.textContent || match.getAttribute('aria-label') || '').trim(),
    };
  })()`;
}

class ChatGPTView {
  constructor(
    mainWindow,
    taskService,
    onResult,
    onEvent = () => {},
    restoredTasks = [],
    worktreeService = null,
    onMergeResult = async () => {},
    restoredTrees = [],
  ) {
    this.mainWindow = mainWindow;
    this.taskService = taskService;
    this.onResult = onResult;
    this.onEvent = onEvent;
    this.worktreeService = worktreeService;
    this.onMergeResult = onMergeResult;
    this.knownTasks = new Map(restoredTasks
      .filter((task) => !['applied', 'completed', 'resolved', 'rolled-back'].includes(task.state))
      .map((task) => [task.taskId.toLowerCase(), task]));
    this.activeTask = restoredTasks
      .filter((task) => task.state === 'submitted' && isChatGPTConversationUrl(task.conversationUrl))
      .sort((left, right) => String(right.updatedAt || right.createdAt)
      .localeCompare(String(left.updatedAt || left.createdAt)))[0] || null;
    this.activeMerge = restoredTrees
      .filter((tree) => tree.mergeState === 'submitted')
      .sort((left, right) => String(right.updatedAt || right.createdAt)
        .localeCompare(String(left.updatedAt || left.createdAt)))[0] || null;
    this.resultAttempts = new Map();
    this.resultWaiters = new Map();
    this.pendingDownload = null;
    this.processingTasks = new Set();
    this.monitorBusy = false;
    this.conversationStatusBusy = false;
    this.conversationStatusUrls = new Map();
    this.dismissalBusy = false;
    this.dismissedNoticeEvents = new Map();
    this.configurationPickerTimer = null;
    this.connectivityFailures = [];
    this.connectivityRecoveryTimer = null;
    this.visible = false;
    this.windowFocused = this.mainWindow.isFocused?.() ?? false;
    this.browserBounds = { ...HIDDEN_VIEW_BOUNDS };
    this.renderedBrowserVisible = false;
    this.renderedBrowserBounds = { ...HIDDEN_VIEW_BOUNDS };
    this.view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        spellcheck: true,
      },
    });
    this.mainWindow.contentView.addChildView(this.view);
    this.view.setBackgroundColor('#11130f');
    this.view.setBounds(HIDDEN_VIEW_BOUNDS);
    this.view.setVisible(false);
    this.mainWindow.on('blur', () => {
      this.windowFocused = false;
      this.syncViewPresentation();
    });
    this.mainWindow.on('focus', () => {
      this.windowFocused = true;
      setImmediate(() => this.syncViewPresentation());
    });
    this.installNavigationHandlers();
    this.installConnectivityRecovery();
    this.installConversationStatusListener();
    this.installDownloadListener();
    this.installMergeDownloadListener();
    this.resultMonitor = setInterval(() => this.monitorPage().catch(() => {}), TASK_MONITOR_INTERVAL_MILLISECONDS);
    this.resultMonitor.unref?.();
    this.mainWindow.once('closed', () => {
      clearInterval(this.resultMonitor);
      clearTimeout(this.configurationPickerTimer);
      clearTimeout(this.connectivityRecoveryTimer);
    });
    this.networkReady = this.configureBrowserSessionNetwork();
    this.networkReady.then(() => this.view.webContents.loadURL(
      this.activeMerge?.mergeConversationUrl || this.activeTask?.conversationUrl || CHATGPT_URL,
    )).catch((error) => {
      this.handleConnectivityFailure({
        url: this.view.webContents.getURL() || CHATGPT_URL,
        error: error?.code || error?.message,
        resourceType: 'mainFrame',
      });
    });
  }

  async configureBrowserSessionNetwork() {
    if (USE_SYSTEM_PROXY) return 'system';
    try {
      await this.view.webContents.session.setProxy({ mode: 'direct' });
      return 'direct';
    } catch (error) {
      await this.onEvent({
        type: 'browser-network-warning',
        message: `Could not bypass the system proxy for ChatGPT: ${error.message}`,
      });
      return 'system';
    }
  }

  installNavigationHandlers() {
    const contents = this.view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (!url.startsWith('https://') || !this.windowFocused) return { action: 'deny' };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: this.mainWindow,
          width: 520,
          height: 720,
          webPreferences: {
            partition: PARTITION,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          },
        },
      };
    });
    contents.on('did-start-loading', () => this.onEvent({ type: 'browser-loading', loading: true }));
    contents.on('did-stop-loading', () => {
      this.onEvent({ type: 'browser-loading', loading: false, url: contents.getURL() });
      this.installResultWatcher();
      this.scheduleTaskConfigurationPicker();
    });
    contents.on('did-fail-load', (_event, _errorCode, errorDescription, validatedURL, isMainFrame) => {
      this.handleConnectivityFailure({
        url: validatedURL || contents.getURL(),
        error: errorDescription,
        resourceType: isMainFrame ? 'mainFrame' : 'subFrame',
      });
    });
    contents.on('dom-ready', () => {
      this.installResultWatcher();
      this.scheduleTaskConfigurationPicker();
    });
    contents.on('did-navigate', (_event, url) => {
      this.handleNavigation(url);
      this.scheduleTaskConfigurationPicker();
    });
    contents.on('did-navigate-in-page', (_event, url) => {
      this.handleNavigation(url);
      this.scheduleTaskConfigurationPicker();
    });
    contents.on('page-title-updated', (_event, title) => {
      this.handlePageTitleUpdated(title).catch(() => {});
    });
    contents.on('render-process-gone', (_event, details) => {
      this.onEvent({ type: 'task-failed', message: `The embedded ChatGPT renderer stopped: ${details.reason}` });
    });
  }

  installConnectivityRecovery() {
    this.connectivityErrorListener = (details) => {
      if (details.webContentsId && details.webContentsId !== this.view.webContents.id) return;
      this.handleConnectivityFailure(details);
    };
    this.view.webContents.session.webRequest.onErrorOccurred(
      { urls: ['https://chatgpt.com/*'] },
      this.connectivityErrorListener,
    );
  }

  handleConnectivityFailure(details) {
    if (!isRecoverableChatGPTNetworkFailure(details)) return;
    const now = Date.now();
    this.connectivityFailures = this.connectivityFailures
      .filter((startedAt) => now - startedAt <= CONNECTIVITY_FAILURE_WINDOW_MILLISECONDS);
    this.connectivityFailures.push(now);
    if (details.resourceType !== 'mainFrame' && this.connectivityFailures.length < 2) return;
    this.scheduleConnectivityRecovery();
  }

  canAutomaticallyRecoverConnectivity() {
    return this.activeTask?.state !== 'submitted'
      && this.activeMerge?.mergeState !== 'submitted';
  }

  scheduleConnectivityRecovery() {
    if (!this.canAutomaticallyRecoverConnectivity() || this.connectivityRecoveryTimer) return;
    this.connectivityRecoveryTimer = setTimeout(() => {
      this.connectivityRecoveryTimer = null;
      this.recoverConnectivity().catch(() => {});
    }, CONNECTIVITY_RECOVERY_DELAY_MILLISECONDS);
    this.connectivityRecoveryTimer.unref?.();
  }

  async recoverConnectivity() {
    if (!this.canAutomaticallyRecoverConnectivity()) return false;
    await this.networkReady;
    const contents = this.view.webContents;
    const currentUrl = contents.getURL();
    const targetUrl = /^https:\/\/chatgpt\.com\//i.test(currentUrl) ? currentUrl : CHATGPT_URL;
    this.connectivityFailures = [];
    await this.onEvent({
      type: 'browser-network-recovery',
      message: 'ChatGPT networking stalled. Retrying the embedded page…',
    });
    await contents.loadURL(targetUrl);
    return true;
  }

  async handlePageTitleUpdated(title) {
    const normalizedTitle = normalizeConversationTitle(title);
    const event = { type: 'browser-title', title };
    const task = this.activeTask;
    if (!normalizedTitle || !task?.conversationUrl) {
      await this.onEvent(event);
      return;
    }

    const currentUrl = this.view.webContents.getURL();
    const currentConversationId = conversationIdFromRouteUrl(currentUrl);
    const taskConversationId = conversationIdFromRouteUrl(task.conversationUrl) || task.conversationId;
    const sameConversation = currentUrl === task.conversationUrl
      || Boolean(taskConversationId && currentConversationId === taskConversationId);
    if (!sameConversation || task.conversationTitle === normalizedTitle) {
      await this.onEvent(event);
      return;
    }

    try {
      const saved = await this.taskService.updateTask(task.taskId, { conversationTitle: normalizedTitle });
      if (this.activeTask?.taskId === task.taskId) this.activeTask = saved;
      this.knownTasks.set(task.taskId.toLowerCase(), saved);
      await this.onEvent({ ...event, task: saved });
    } catch {
      await this.onEvent(event);
    }
  }

  installConversationStatusListener() {
    this.conversationStatusRequestListener = (details, callback) => {
      const conversationId = conversationIdFromStreamStatusUrl(details?.url);
      if (conversationId) {
        this.conversationStatusUrls.set(conversationId, details.url);
        if (this.conversationStatusUrls.size > 32) {
          const oldest = this.conversationStatusUrls.keys().next().value;
          if (oldest) this.conversationStatusUrls.delete(oldest);
        }
        this.rememberConversationId(conversationId).catch(() => {});
      }
      callback({});
    };
    this.view.webContents.session.webRequest.onBeforeRequest(
      { urls: ['https://chatgpt.com/backend-api/conversation/*/stream_status*'] },
      this.conversationStatusRequestListener,
    );
  }

  async rememberConversationId(conversationId) {
    const task = this.activeTask;
    if (!task || task.state !== 'submitted' || task.conversationId === conversationId) return task;
    const taskRouteId = conversationIdFromRouteUrl(task.conversationUrl);
    if (taskRouteId && taskRouteId !== conversationId) return task;
    if (!taskRouteId) {
      const currentRouteId = conversationIdFromRouteUrl(this.view.webContents.getURL?.() || '');
      if (currentRouteId && currentRouteId !== conversationId) return task;
    }
    const next = { ...task, conversationId };
    this.activeTask = next;
    this.knownTasks.set(task.taskId.toLowerCase(), next);
    try {
      const saved = await this.taskService.updateTask(task.taskId, { conversationId });
      if (this.activeTask?.taskId === task.taskId) this.activeTask = saved;
      this.knownTasks.set(task.taskId.toLowerCase(), saved);
      return saved;
    } catch {
      return next;
    }
  }

  installDownloadListener() {
    this.view.webContents.session.on('will-download', (_event, item) => {
      const originalName = path.basename(item.getFilename());
      const namedTaskId = resultTaskId(originalName);
      const pending = this.pendingDownload && Date.now() - this.pendingDownload.startedAt < 20_000
        ? this.pendingDownload
        : null;
      const taskId = namedTaskId || (pending && /\.txt$/i.test(originalName) ? pending.taskId : null);
      const task = taskId ? this.knownTasks.get(taskId.toLowerCase()) : null;
      // Downloads unrelated to an active Patchwork task or merge use Chromium's normal behavior.
      if (!task) return;

      this.pendingDownload = null;
      this.processingTasks.add(task.taskId);
      const safeName = task.resultFilename || `chatgpt-ide-result-${task.taskId}.txt`;
      const incomingDir = path.join(this.taskService.taskDirectory(task.taskId), 'incoming');
      const savePath = path.join(incomingDir, safeName);
      try {
        fsSync.mkdirSync(incomingDir, { recursive: true });
        item.setSavePath(savePath);
        this.onEvent({
          type: 'result-download-started',
          taskId: task.taskId,
          message: `Downloading ${safeName}…`,
        });
      } catch (error) {
        this.onEvent({ type: 'task-failed', taskId: task.taskId, message: error.message });
      }

      item.once('done', async (_downloadEvent, state) => {
        const taskKey = task.taskId.toLowerCase();
        const waiter = this.resultWaiters.get(taskKey);
        if (state !== 'completed') {
          waiter?.reject(new Error(`The ChatGPT download ended with status: ${state}`));
          this.resultWaiters.delete(taskKey);
          this.processingTasks.delete(task.taskId);
          await this.onEvent({
            type: 'task-failed',
            taskId: task.taskId,
            message: `The ChatGPT download ended with status: ${state}`,
          });
          return;
        }
        try {
          const processedTask = await this.onResult(task.taskId, savePath);
          waiter?.resolve(processedTask);
          this.knownTasks.delete(taskKey);
          if (this.activeTask?.taskId === task.taskId) this.activeTask = null;
        } catch (error) {
          waiter?.reject(error);
          // ResultService emits the detailed validation error.
        } finally {
          this.resultWaiters.delete(taskKey);
          this.processingTasks.delete(task.taskId);
        }
      });
    });
  }


  installMergeDownloadListener() {
    this.view.webContents.session.on('will-download', (_event, item) => {
      const originalName = path.basename(item.getFilename());
      const pending = this.pendingDownload && Date.now() - this.pendingDownload.startedAt < 20_000
        ? this.pendingDownload
        : null;
      const namedMergeId = mergeTreeId(originalName);
      const pendingMergeId = pending?.kind === 'merge' && /\.txt$/i.test(originalName)
        ? pending.treeId
        : null;
      const mergeId = namedMergeId || pendingMergeId;
      const merge = mergeId && this.activeMerge?.id.toLowerCase() === mergeId.toLowerCase()
        ? this.activeMerge
        : null;
      if (!merge) return;

      this.pendingDownload = null;
      this.activeMerge = { ...merge, mergeState: 'downloading' };
      const safeName = mergeResultFilename(merge.id);
      const incomingDir = path.join(this.worktreeService.mergesRoot, 'incoming');
      const savePath = path.join(incomingDir, safeName);
      try {
        fsSync.mkdirSync(incomingDir, { recursive: true });
        item.setSavePath(savePath);
        this.onEvent({
          type: 'merge-result-download-started',
          treeId: merge.id,
          message: `Downloading ${safeName}…`,
        });
      } catch (error) {
        this.worktreeService.markMergeFailed(merge.id, error).catch(() => {});
        this.activeMerge = null;
        this.onEvent({ type: 'merge-failed', treeId: merge.id, message: error.message });
        return;
      }

      item.once('done', async (_downloadEvent, state) => {
        if (state !== 'completed') {
          const error = new Error(`The ChatGPT download ended with status: ${state}`);
          await this.worktreeService.markMergeFailed(merge.id, error).catch(() => {});
          this.activeMerge = null;
          await this.onEvent({ type: 'merge-failed', treeId: merge.id, message: error.message });
          return;
        }
        try {
          const text = fsSync.readFileSync(savePath, 'utf8');
          await this.finishMergeResult(merge, text);
        } catch (error) {
          await this.worktreeService.markMergeFailed(merge.id, error).catch(() => {});
          this.activeMerge = null;
          await this.onEvent({ type: 'merge-failed', treeId: merge.id, message: error.message });
        }
      });
    });
  }

  handleNavigation(url) {
    this.onEvent({ type: 'browser-navigated', url });
    if (this.activeMerge && isChatGPTConversationUrl(url)) {
      if (this.activeMerge.mergeConversationUrl !== url && this.worktreeService) {
        const treeId = this.activeMerge.id;
        this.worktreeService.markMergeSubmitted(treeId, url).then((tree) => {
          if (this.activeMerge?.id === treeId) this.activeMerge = tree;
        }).catch(() => {});
      }
      return;
    }
    if (!this.activeTask || !['prepared', 'submitted'].includes(this.activeTask.state)) return;
    if (!/^https:\/\/chatgpt\.com\/c\//i.test(url)) return;
    if (this.activeTask.conversationUrl === url) return;
    const taskId = this.activeTask.taskId;
    this.taskService.updateTask(taskId, { conversationUrl: url }).then((task) => {
      if (this.activeTask?.taskId === taskId) this.activeTask = task;
      this.knownTasks.set(taskId.toLowerCase(), task);
    }).catch(() => {});
  }

  setBounds(bounds) {
    const next = {
      x: Math.max(0, Math.round(bounds.x || 0)),
      y: Math.max(0, Math.round(bounds.y || 0)),
      width: Math.max(0, Math.round(bounds.width || 0)),
      height: Math.max(0, Math.round(bounds.height || 0)),
    };
    this.browserBounds = next;
    this.syncViewPresentation();
  }

  setVisible(visible) {
    this.visible = Boolean(visible);
    this.syncViewPresentation();
  }

  syncViewPresentation() {
    const shouldShow = this.visible && this.windowFocused;
    const nextBounds = shouldShow ? this.browserBounds : HIDDEN_VIEW_BOUNDS;
    if (!sameBounds(this.renderedBrowserBounds, nextBounds)) {
      this.view.setBounds(nextBounds);
      this.renderedBrowserBounds = { ...nextBounds };
    }
    if (this.renderedBrowserVisible !== shouldShow) {
      this.view.setVisible(shouldShow);
      this.renderedBrowserVisible = shouldShow;
    }
  }

  async prepare(task) {
    this.activeMerge = null;
    this.activeTask = task;
    this.knownTasks.set(task.taskId.toLowerCase(), task);
    clipboard.writeText(task.handoffPrompt);
    await this.newChat(task.chatgptProject?.id, task.chatgptProject?.shortUrl);
    this.installResultWatcher();
    await this.onEvent({
      type: 'browser-prepared',
      taskId: task.taskId,
      message: task.chatgptProject?.name
        ? `A fresh chat in ChatGPT project “${task.chatgptProject.name}” is ready for automated submission.`
        : 'A fresh embedded ChatGPT chat is ready for automated submission.',
    });
  }

  async restoreActiveContext(task = null, merge = null) {
    this.activeTask = task || null;
    this.activeMerge = merge || null;
    if (task?.taskId) this.knownTasks.set(task.taskId.toLowerCase(), task);

    const conversationUrl = merge?.mergeConversationUrl || task?.conversationUrl || null;
    if (conversationUrl && isChatGPTConversationUrl(conversationUrl)) {
      const currentUrl = this.view.webContents.getURL();
      const currentConversationId = conversationIdFromRouteUrl(currentUrl);
      const targetConversationId = conversationIdFromRouteUrl(conversationUrl);
      const conversationAlreadyOpen = currentUrl === conversationUrl
        || Boolean(targetConversationId && currentConversationId === targetConversationId);
      if (!conversationAlreadyOpen) await this.view.webContents.loadURL(conversationUrl);
    }
    this.installResultWatcher();
  }

  async openTaskConversation(task) {
    if (!isChatGPTConversationUrl(task?.conversationUrl)) {
      throw new Error('This task has an invalid saved ChatGPT conversation URL.');
    }
    this.activeMerge = null;
    this.activeTask = task;
    this.knownTasks.set(task.taskId.toLowerCase(), task);
    const currentUrl = this.view.webContents.getURL();
    const currentConversationId = conversationIdFromRouteUrl(currentUrl);
    const taskConversationId = conversationIdFromRouteUrl(task.conversationUrl) || task.conversationId;
    const conversationAlreadyOpen = currentUrl === task.conversationUrl
      || Boolean(taskConversationId && currentConversationId === taskConversationId);
    // Reloading an in-progress conversation tears down ChatGPT's live page state. Partial
    // streamed thoughts may not be persisted yet, so keep the existing renderer alive when
    // both routes identify the same conversation.
    if (!conversationAlreadyOpen) {
      await this.view.webContents.loadURL(task.conversationUrl);
    }
    this.installResultWatcher();
    await this.onEvent({
      type: 'task-chat-opened',
      taskId: task.taskId,
      message: 'Opened this task’s saved ChatGPT conversation.',
    });
    return { opened: true, task };
  }

  async newChat(projectId = null, projectShortUrl = null) {
    await this.networkReady;
    const targetUrl = projectId ? chatGPTProjectUrl(projectId, projectShortUrl) : CHATGPT_URL;
    if (this.view.webContents.getURL() !== targetUrl) {
      await this.view.webContents.loadURL(targetUrl);
    } else {
      await this.view.webContents.reload();
    }
    return true;
  }

  async listProjects() {
    const result = await this.view.webContents.executeJavaScript(`(async () => {
      const sessionResponse = await fetch('/api/auth/session', {
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!sessionResponse.ok) return { ok: false, kind: 'auth', status: sessionResponse.status };
      let session = null;
      try {
        session = await sessionResponse.json();
      } catch {
        return { ok: false, kind: 'auth', status: 401 };
      }
      const accessToken = session?.accessToken || session?.access_token;
      if (!accessToken) return { ok: false, kind: 'auth', status: 401 };
      const readStorage = (key) => {
        try { return localStorage.getItem(key); } catch { return null; }
      };
      const deviceId = readStorage('oai-device-id')
        || readStorage('oai/apps/uuid')
        || document.cookie.match(/(?:^|;\s*)oai-did=([^;]+)/)?.[1]
        || null;
      const headers = {
        Accept: 'application/json',
        Authorization: 'Bearer ' + accessToken,
      };
      if (deviceId) headers['oai-device-id'] = deviceId;
      const accountId = session?.account?.id || session?.accountId || null;
      if (accountId) headers['ChatGPT-Account-Id'] = accountId;

      const projects = [];
      let cursor = null;
      let page = 0;
      do {
        const url = new URL('/backend-api/gizmos/snorlax/sidebar', location.origin);
        url.searchParams.set('conversations_per_gizmo', '0');
        url.searchParams.set('owned_only', 'true');
        url.searchParams.set('limit', '20');
        if (cursor) url.searchParams.set('cursor', cursor);
        const response = await fetch(url.toString(), {
          credentials: 'include',
          cache: 'no-store',
          headers,
        });
        if (!response.ok) {
          return { ok: false, kind: 'projects', status: response.status, message: (await response.text()).slice(0, 240) };
        }
        const data = await response.json();
        for (const item of data.items || []) {
          const gizmo = item?.gizmo?.gizmo || item?.gizmo;
          const id = gizmo?.id;
          const shortUrl = gizmo?.short_url;
          const name = gizmo?.display?.name;
          if (typeof id === 'string' && id.startsWith('g-p-') && typeof name === 'string' && name.trim()) {
            projects.push({ id, shortUrl: typeof shortUrl === 'string' ? shortUrl : null, name: name.trim() });
          }
        }
        cursor = data.cursor || null;
        page += 1;
      } while (cursor && page < 20);
      return { ok: true, projects };
    })()`, true).catch((error) => ({ ok: false, kind: 'projects', status: 0, message: error.message }));
    if (!result?.ok) {
      if (result?.kind === 'auth') throw new Error('Sign in to ChatGPT before loading projects.');
      throw new Error(`Could not load ChatGPT projects${result?.status ? ` (${result.status})` : ''}.`);
    }
    const unique = new Map();
    for (const project of result.projects || []) {
      if (CHATGPT_PROJECT_ID_PATTERN.test(project.id)) unique.set(project.id, project);
    }
    return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async createProject(name) {
    const projectName = String(name || '').trim();
    if (!projectName) throw new Error('Enter a name for the new ChatGPT project.');
    const result = await this.view.webContents.executeJavaScript(`(async () => {
      const sessionResponse = await fetch('/api/auth/session', {
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!sessionResponse.ok) return { ok: false, kind: 'auth', status: sessionResponse.status };
      let session = null;
      try {
        session = await sessionResponse.json();
      } catch {
        return { ok: false, kind: 'auth', status: 401 };
      }
      const accessToken = session?.accessToken || session?.access_token;
      if (!accessToken) return { ok: false, kind: 'auth', status: 401 };
      const readStorage = (key) => {
        try { return localStorage.getItem(key); } catch { return null; }
      };
      const deviceId = readStorage('oai-device-id')
        || readStorage('oai/apps/uuid')
        || document.cookie.match(/(?:^|;\s*)oai-did=([^;]+)/)?.[1]
        || null;
      const headers = {
        Accept: 'application/json',
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
      };
      if (deviceId) headers['oai-device-id'] = deviceId;
      const accountId = session?.account?.id || session?.accountId || null;
      if (accountId) headers['ChatGPT-Account-Id'] = accountId;
      const response = await fetch('/backend-api/projects', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers,
        body: JSON.stringify({ name: ${JSON.stringify(projectName)}, instructions: '' }),
      });
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch {}
      if (!response.ok) return { ok: false, kind: 'projects', status: response.status, message: text.slice(0, 240) };
      const candidate = data?.resource?.gizmo || data?.gizmo?.gizmo || data?.gizmo || data?.project?.gizmo || data?.project || data;
      return {
        ok: true,
        project: {
          id: candidate?.id || candidate?.gizmo_id || data?.id || data?.gizmo_id || data?.project_id || null,
          shortUrl: candidate?.short_url || null,
          name: candidate?.display?.name || candidate?.name || data?.name || ${JSON.stringify(projectName)},
        },
      };
    })()`, true).catch((error) => ({ ok: false, kind: 'projects', status: 0, message: error.message }));
    if (!result?.ok) {
      if (result?.kind === 'auth') throw new Error('Sign in to ChatGPT before creating a project.');
      throw new Error(`Could not create the ChatGPT project${result?.status ? ` (${result.status})` : ''}.`);
    }
    let project = result.project;
    if (!CHATGPT_PROJECT_ID_PATTERN.test(String(project?.id || ''))) {
      const projects = await this.listProjects();
      project = projects.find((item) => item.name === projectName) || null;
    }
    if (!project || !CHATGPT_PROJECT_ID_PATTERN.test(project.id)) {
      throw new Error('ChatGPT created the project, but Patchwork could not determine its project identifier.');
    }
    const shortUrl = CHATGPT_PROJECT_ID_PATTERN.test(String(project.shortUrl || '')) ? project.shortUrl : null;
    return {
      id: project.id,
      shortUrl,
      name: String(project.name || projectName).trim(),
      url: chatGPTProjectUrl(project.id, shortUrl),
    };
  }

  async reload() {
    await this.networkReady;
    this.view.webContents.reload();
    return true;
  }

  async goBack() {
    if (this.view.webContents.navigationHistory.canGoBack()) {
      this.view.webContents.navigationHistory.goBack();
    }
    return true;
  }

  async goForward() {
    if (this.view.webContents.navigationHistory.canGoForward()) {
      this.view.webContents.navigationHistory.goForward();
    }
    return true;
  }

  async waitForComposer(timeoutMilliseconds = 12_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMilliseconds) {
      const found = await this.view.webContents.executeJavaScript(`Boolean(
        document.querySelector('#prompt-textarea') ||
        document.querySelector('[data-testid="prompt-textarea"]') ||
        document.querySelector('textarea[placeholder]') ||
        document.querySelector('[contenteditable="true"][role="textbox"]')
      )`).catch(() => false);
      if (found) return true;
      await delay(350);
    }
    return false;
  }

  async configureTaskModel(task) {
    const model = String(task?.model || 'default').toLowerCase();
    const reasoningMode = String(task?.reasoningMode || 'default').toLowerCase();
    const modelOption = TASK_MODEL_PICKER_OPTIONS[model];
    const reasoningOption = TASK_REASONING_PICKER_OPTIONS[reasoningMode];
    if (model !== 'default' && !modelOption) throw new Error(`Unsupported task model: ${task.model}`);
    if (reasoningMode !== 'default' && !reasoningOption) {
      throw new Error(`Unsupported task reasoning mode: ${task.reasoningMode}`);
    }
    let result = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      result = await this.view.webContents.executeJavaScript(
        buildTaskConfigurationScript(model, reasoningMode, task?.taskId || null),
        true,
      ).catch((error) => ({ ok: false, reason: error.message || 'picker-script-failed' }));
      if (!result?.ok) {
        throw new Error(`Could not install Patchwork’s model selector: ${result?.reason || 'the replacement script failed'}`);
      }
      if (result.pickerInstalled) return true;
      await delay(200);
    }
    const requested = modelOption?.label || reasoningOption?.label || 'the requested task configuration';
    throw new Error(`Could not replace ChatGPT’s model selector with Patchwork’s selector for ${requested}.`);
  }

  scheduleTaskConfigurationPicker(delayMilliseconds = 180) {
    clearTimeout(this.configurationPickerTimer);
    this.configurationPickerTimer = setTimeout(async () => {
      const task = this.activeTask;
      if (!task || this.view.webContents.isDestroyed()) return;
      const composerReady = await this.waitForComposer(10_000);
      if (!composerReady || this.activeTask?.taskId !== task.taskId) return;
      await this.configureTaskModel(task).catch(() => {});
    }, delayMilliseconds);
    this.configurationPickerTimer.unref?.();
  }

  async beginTaskRequestEnforcement(task) {
    const debuggerApi = this.view.webContents.debugger;
    let attachedHere = false;
    let fetchEnabled = false;
    let disposed = false;
    let completed = false;
    let resolveResult;
    const resultPromise = new Promise((resolve) => { resolveResult = resolve; });
    const complete = (result) => {
      if (completed) return;
      completed = true;
      resolveResult(result);
    };
    const readConfiguration = async () => {
      const selected = await this.view.webContents.executeJavaScript(
        `(() => {
          const picker = document.querySelector('patchwork-model-selector#patchwork-task-model-selector');
          if (!picker) return null;
          return {
            model: picker.getAttribute('data-model'),
            reasoningMode: picker.getAttribute('data-reasoning-mode'),
          };
        })()`,
        true,
      ).catch(() => null);
      return {
        ...taskRequestConfiguration(
        selected?.model || task?.model || 'default',
        selected?.reasoningMode || task?.reasoningMode || 'default',
        ),
        selectionSource: selected ? 'patchwork-selector' : 'saved-task',
      };
    };
    const continueUnmodified = async (requestId) => {
      await debuggerApi.sendCommand('Fetch.continueRequest', { requestId }).catch(() => {});
    };
    const handlePausedRequest = async (params) => {
      const requestId = params?.requestId;
      const request = params?.request || {};
      if (!requestId) return;
      let pathname = '';
      try {
        pathname = new URL(request.url).pathname;
      } catch {
        await continueUnmodified(requestId);
        return;
      }
      const isConversation = request.method === 'POST'
        && pathname === '/backend-api/f/conversation';
      const isPrepare = request.method === 'POST'
        && pathname === '/backend-api/f/conversation/prepare';
      if (!isConversation && !isPrepare) {
        await continueUnmodified(requestId);
        return;
      }
      try {
        const configuration = await readConfiguration();
        let postData = request.postData;
        if (typeof postData !== 'string' && request.postDataEntries?.length === 1) {
          postData = Buffer.from(request.postDataEntries[0].bytes, 'base64').toString('utf8');
        }
        if (typeof postData !== 'string' && params.networkId) {
          const body = await debuggerApi.sendCommand('Network.getRequestPostData', {
            requestId: params.networkId,
          });
          postData = body?.postData;
        }
        const rewritten = rewriteConversationRequestBody(postData, configuration);
        await debuggerApi.sendCommand('Fetch.continueRequest', {
          requestId,
          postData: Buffer.from(rewritten.text, 'utf8').toString('base64'),
        });
        if (isConversation) {
          complete({
            ok: true,
            model: rewritten.model,
            thinkingEffort: rewritten.thinkingEffort,
            selectedModel: configuration.model,
            selectedReasoningMode: configuration.reasoningMode,
            selectionSource: configuration.selectionSource,
          });
        }
      } catch (error) {
        await continueUnmodified(requestId);
        if (isConversation) complete({ ok: false, error: error.message });
      }
    };
    const onDebuggerMessage = (_event, method, params) => {
      if (method === 'Fetch.requestPaused') handlePausedRequest(params).catch((error) => {
        complete({ ok: false, error: error.message });
      });
    };

    try {
      if (!debuggerApi.isAttached()) {
        debuggerApi.attach('1.3');
        attachedHere = true;
      }
      debuggerApi.on('message', onDebuggerMessage);
      await debuggerApi.sendCommand('Fetch.enable', {
        patterns: [{
          urlPattern: 'https://chatgpt.com/backend-api/f/conversation*',
          requestStage: 'Request',
        }],
      });
      fetchEnabled = true;
    } catch (error) {
      debuggerApi.removeListener?.('message', onDebuggerMessage);
      if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
      throw new Error(`Could not verify ChatGPT’s outgoing model request: ${error.message}`);
    }

    return {
      wait: async (timeoutMilliseconds = TASK_REQUEST_CONFIRMATION_TIMEOUT_MILLISECONDS) => {
        const result = await Promise.race([
          resultPromise,
          delay(timeoutMilliseconds).then(() => ({
            ok: false,
            error: 'ChatGPT did not send a conversation request after Send.',
          })),
        ]);
        if (!result.ok) throw new Error(result.error || 'Could not verify ChatGPT’s outgoing model request.');
        return result;
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        debuggerApi.removeListener?.('message', onDebuggerMessage);
        if (fetchEnabled && debuggerApi.isAttached()) {
          await debuggerApi.sendCommand('Fetch.disable').catch(() => {});
        }
        if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
      },
    };
  }

  async injectPrompt(prompt) {
    const script = `(() => {
      const composer =
        document.querySelector('#prompt-textarea') ||
        document.querySelector('[data-testid="prompt-textarea"]') ||
        document.querySelector('textarea[placeholder]') ||
        document.querySelector('[contenteditable="true"][role="textbox"]');
      if (!composer) return { ok: false, reason: 'composer-not-found' };
      const prompt = ${JSON.stringify(prompt)};
      composer.focus();
      if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
        const prototype = composer instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
        setter.call(composer, prompt);
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        composer.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(composer);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('insertText', false, prompt);
        composer.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: prompt,
        }));
      }
      return { ok: true };
    })()`;
    const result = await this.view.webContents.executeJavaScript(script, true);
    if (!result?.ok) throw new Error('Could not find ChatGPT’s prompt composer. Reload the embedded browser and try again.');
  }

  async findFileInputNodeId() {
    const debuggerApi = this.view.webContents.debugger;
    const documentResult = await debuggerApi.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    for (const selector of [
      '#upload-files',
      'input[type="file"][multiple]:not([accept="image/*"])',
      'input[type="file"]',
    ]) {
      const query = await debuggerApi.sendCommand('DOM.querySelector', {
        nodeId: documentResult.root.nodeId,
        selector,
      });
      if (query.nodeId) return query.nodeId;
    }
    return 0;
  }

  async uploadPackage(packagePath) {
    const filename = path.basename(packagePath);
    const existingAttachment = await this.packageAttachmentStatus(filename, true);
    if (existingAttachment.attached && !existingAttachment.busy) return true;
    const debuggerApi = this.view.webContents.debugger;
    let attachedHere = false;
    try {
      if (!debuggerApi.isAttached()) {
        debuggerApi.attach('1.3');
        attachedHere = true;
      }
      let nodeId = await this.findFileInputNodeId();
      if (!nodeId) {
        await this.view.webContents.executeJavaScript(`(() => {
          const candidates = [...document.querySelectorAll('button')];
          const button =
            document.querySelector('[data-testid="composer-plus-btn"]') ||
            document.querySelector('[data-testid*="attach"]') ||
            candidates.find((item) => /attach|add files|upload/i.test([
              item.getAttribute('aria-label'), item.getAttribute('title'), item.textContent,
            ].filter(Boolean).join(' ')));
          if (button) button.click();
          return Boolean(button);
        })()`, true);
        await delay(500);
        nodeId = await this.findFileInputNodeId();
      }
      if (!nodeId) {
        throw new Error('Could not locate ChatGPT’s attachment input. Attach the package manually or reload and retry.');
      }
      await debuggerApi.sendCommand('DOM.setFileInputFiles', {
        files: [packagePath],
        nodeId,
      });
      const dispatchSelectedFileInput = this.dispatchSelectedFileInput
        || ChatGPTView.prototype.dispatchSelectedFileInput;
      const eventDispatched = await dispatchSelectedFileInput.call(this, filename);
      if (!eventDispatched) throw new Error('ChatGPT did not accept the selected task package. Nothing was submitted.');
    } finally {
      if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
    }
    await this.waitForPackageAttachment(path.basename(packagePath));
  }

  async dispatchSelectedFileInput(filename) {
    return this.view.webContents.executeJavaScript(
      buildFileInputEventScript(filename),
      true,
    ).catch(() => false);
  }

  async uploadAttachments(attachments = []) {
    for (const attachment of attachments) {
      const attachmentPath = typeof attachment === 'string' ? attachment : attachment?.path;
      if (!attachmentPath) continue;
      await this.uploadPackage(attachmentPath);
    }
    return true;
  }

  async packageAttachmentStatus(filename, dismissDuplicateNotice = false) {
    return this.view.webContents.executeJavaScript(
      buildPackageAttachmentStatusScript(filename, dismissDuplicateNotice),
      true,
    ).catch(() => ({
      attached: false,
      busy: false,
      duplicateNotice: false,
      dismissedDuplicate: false,
    }));
  }

  async waitForPackageAttachment(filename, timeoutMilliseconds = 60_000) {
    const startedAt = Date.now();
    let consecutiveReadyChecks = 0;
    let lastRedispatchAt = startedAt;
    while (Date.now() - startedAt < timeoutMilliseconds) {
      const status = await this.packageAttachmentStatus(filename, true);
      consecutiveReadyChecks = status.attached && !status.busy ? consecutiveReadyChecks + 1 : 0;
      if (consecutiveReadyChecks >= 2) return true;
      if (!status.attached && status.selectedByInput && Date.now() - lastRedispatchAt >= 1_000) {
        lastRedispatchAt = Date.now();
        await this.dispatchSelectedFileInput(filename);
      }
      await delay(500);
    }
    throw new Error(`ChatGPT did not confirm the attachment ${filename}. Nothing was submitted; reload the embedded browser and try again.`);
  }

  async waitForConversationUrl(timeoutMilliseconds = SUBMISSION_CONFIRMATION_TIMEOUT_MILLISECONDS) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMilliseconds) {
      const url = this.view.webContents.getURL();
      if (isChatGPTConversationUrl(url)) return url;
      await delay(250);
    }
    return null;
  }

  async clickSend(timeoutMilliseconds = 60_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMilliseconds) {
      const result = await this.view.webContents.executeJavaScript(`(() => {
        const candidates = [...document.querySelectorAll('button')];
        const button =
          document.querySelector('[data-testid="send-button"]') ||
          candidates.find((item) => /send prompt|send message|^send$/i.test([
            item.getAttribute('aria-label'), item.getAttribute('title'), item.textContent,
          ].filter(Boolean).join(' ').trim()));
        if (!button) return { found: false, enabled: false };
        if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
          return { found: true, enabled: false };
        }
        button.click();
        return { found: true, enabled: true };
      })()`, true).catch(() => ({ found: false, enabled: false }));
      if (result.enabled) return true;
      await delay(500);
    }
    throw new Error('ChatGPT did not enable the Send button. The attachment may still be uploading.');
  }

  async submit(task) {
    this.activeMerge = null;
    this.activeTask = task;
    this.knownTasks.set(task.taskId.toLowerCase(), task);
    const summaryOnly = Boolean(task.summaryOnly);
    await this.onEvent({
      type: 'automation-started',
      taskId: task.taskId,
      message: summaryOnly
        ? 'Injecting the Git Summary request into the embedded ChatGPT composer…'
        : 'Injecting the task into the embedded ChatGPT composer…',
    });
    const composerReady = await this.waitForComposer();
    if (!composerReady) {
      await this.onEvent({
        type: 'browser-login-required',
        taskId: task.taskId,
        message: 'Sign in to ChatGPT in the embedded browser, then choose Submit automatically.',
      });
      throw new Error('ChatGPT is not ready. Sign in inside the embedded browser and retry.');
    }
    await this.configureTaskModel(task);
    const requestEnforcement = await this.beginTaskRequestEnforcement(task);
    let verifiedRequest;
    try {
      await this.injectPrompt(task.handoffPrompt);
      await this.uploadPackage(task.packagePath);
      await ChatGPTView.prototype.uploadAttachments.call(this, task.attachments);
      await this.clickSend();
      verifiedRequest = await requestEnforcement.wait();
    } finally {
      await requestEnforcement.dispose();
    }
    await this.onEvent({
      type: 'task-request-verified',
      taskId: task.taskId,
      message: `Verified ChatGPT request from ${verifiedRequest.selectionSource === 'patchwork-selector' ? 'Patchwork’s selector' : 'the saved task'}: ${verifiedRequest.model}${verifiedRequest.thinkingEffort ? ` · ${verifiedRequest.thinkingEffort}` : ''}.`,
    });
    const conversationUrl = await this.waitForConversationUrl();
    if (!conversationUrl) {
      await this.onEvent({
        type: 'task-submit-unconfirmed',
        taskId: task.taskId,
        message: 'ChatGPT did not create a conversation after Send, so the task was not marked submitted.',
      });
      throw new Error('Patchwork could not confirm a ChatGPT conversation after Send. Check the embedded browser before retrying.');
    }
    this.conversationStatusUrls?.clear();
    const currentConversationTitle = normalizeConversationTitle(this.view?.webContents?.getTitle?.());
    const submittedTask = await this.taskService.updateTask(task.taskId, {
      state: 'submitted',
      submittedAt: new Date().toISOString(),
      conversationUrl,
      conversationTitle: currentConversationTitle || task.conversationTitle || null,
      chatStatus: 'streaming',
      chatStatusRaw: 'IS_STREAMING',
      chatFinishedAt: null,
      model: verifiedRequest.selectedModel || task.model,
      reasoningMode: verifiedRequest.selectedReasoningMode || task.reasoningMode,
    });
    this.activeTask = submittedTask;
    this.knownTasks.set(task.taskId.toLowerCase(), submittedTask);
    this.installResultWatcher();
    await this.onEvent({
      type: 'task-submitted',
      task: submittedTask,
      message: summaryOnly
        ? 'Git Summary uploaded and submitted through the ChatGPT page.'
        : 'Task uploaded and submitted through the ChatGPT page.',
    });
    return submittedTask;
  }

  async submitMerge(request) {
    this.activeTask = null;
    this.activeMerge = {
      ...(await this.worktreeService.get(request.treeId)),
      mergeState: 'submitting',
    };
    await this.onEvent({
      type: 'merge-automation-started',
      treeId: request.treeId,
      message: `Opening a fresh ChatGPT chat to summarize ${request.treeName}…`,
    });
    await this.newChat(request.chatgptProject?.id, request.chatgptProject?.shortUrl);
    const composerReady = await this.waitForComposer();
    if (!composerReady) throw new Error('ChatGPT is not ready. Sign in inside the embedded browser and retry.');
    await this.injectPrompt(request.prompt);
    await this.clickSend();
    this.activeMerge = await this.worktreeService.markMergeSubmitted(request.treeId);
    await this.onEvent({
      type: 'merge-submitted',
      treeId: request.treeId,
      message: 'ChatGPT is preparing the squash commit message.',
    });
    return true;
  }

  installResultWatcher() {
    if (this.view.webContents.isDestroyed()) return;
    this.monitorPage().catch(() => {});
  }

  async monitorPage() {
    await this.dismissBlockingLimitNotice();
    await this.checkConversationStatus();
    return this.checkForResult();
  }

  async discoverConversationId(task) {
    if (task.conversationId) return task.conversationId;
    const taskRouteId = conversationIdFromRouteUrl(task.conversationUrl);
    if (taskRouteId) {
      const remembered = await this.rememberConversationId(taskRouteId);
      return remembered?.conversationId === taskRouteId ? taskRouteId : null;
    }
    const currentUrl = this.view.webContents.getURL?.() || '';
    const currentRouteId = conversationIdFromRouteUrl(currentUrl);
    if (currentRouteId && currentUrl === task.conversationUrl) {
      const remembered = await this.rememberConversationId(currentRouteId);
      return remembered?.conversationId === currentRouteId ? currentRouteId : null;
    }
    const observedId = [...this.conversationStatusUrls.keys()].at(-1) || null;
    if (observedId) {
      const remembered = await this.rememberConversationId(observedId);
      if (remembered?.conversationId === observedId) return observedId;
    }
    const discovered = await this.view.webContents.executeJavaScript(`(() => {
      const entries = performance.getEntriesByType('resource');
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const url = String(entries[index]?.name || '');
        const match = /^https:\/\/chatgpt\\.com\/backend-api\/conversation\/([^/]+)\/stream_status(?:\\?.*)?$/i.exec(url);
        if (match) return decodeURIComponent(match[1]);
      }
      return null;
    })()`, true).catch(() => null);
    if (!discovered) return null;
    const remembered = await this.rememberConversationId(discovered);
    return remembered?.conversationId === discovered ? discovered : null;
  }

  async checkConversationStatus() {
    const task = this.activeTask;
    if (this.conversationStatusBusy || !task || task.state !== 'submitted'
      || task.chatStatus === 'completed' || task.chatStatus === 'failed'
      || this.view.webContents.isDestroyed()) {
      return null;
    }
    this.conversationStatusBusy = true;
    try {
      const conversationId = this.discoverConversationId
        ? await this.discoverConversationId(task)
        : task.conversationId || conversationIdFromRouteUrl(this.view.webContents.getURL?.() || '');
      if (!conversationId) return null;
      const result = await this.view.webContents.executeJavaScript(
        buildConversationStatusScript(conversationId),
        true,
      ).catch(() => ({ ok: false }));
      if (!result?.ok || !result.status) return result;

      const nextChatStatus = normalizeConversationStreamStatus(result.status);
      const currentTask = this.activeTask?.taskId === task.taskId ? this.activeTask : task;
      const changed = currentTask.chatStatus !== nextChatStatus || currentTask.chatStatusRaw !== result.status;
      if (!changed) return result;

      const update = {
        conversationId,
        chatStatus: nextChatStatus,
        chatStatusRaw: result.status,
        chatFinishedAt: nextChatStatus === 'streaming'
          ? null
          : currentTask.chatFinishedAt || new Date().toISOString(),
      };
      const saved = await this.taskService.updateTask(task.taskId, update);
      if (this.activeTask?.taskId === task.taskId) this.activeTask = saved;
      this.knownTasks.set(task.taskId.toLowerCase(), saved);
      await this.onEvent({
        type: 'task-chat-status',
        task: saved,
        taskId: task.taskId,
        chatStatus: nextChatStatus,
        chatStatusRaw: result.status,
        message: nextChatStatus === 'streaming'
          ? 'ChatGPT is still generating the task result.'
          : nextChatStatus === 'failed'
            ? 'ChatGPT reported a generation failure for this task.'
            : 'ChatGPT finished generating; Patchwork is checking for the result file.',
      });
      return result;
    } finally {
      this.conversationStatusBusy = false;
    }
  }

  async dismissBlockingLimitNotice() {
    if (this.dismissalBusy || this.view.webContents.isDestroyed()) return false;
    this.dismissalBusy = true;
    try {
      const result = await this.view.webContents.executeJavaScript(
        buildLimitNoticeDismissalScript(),
        true,
      ).catch(() => ({ dismissed: false }));
      if (!result?.dismissed) return false;

      const eventKey = String(result.notice || 'limit-notice').toLowerCase();
      const lastEventAt = this.dismissedNoticeEvents.get(eventKey) || 0;
      if (Date.now() - lastEventAt >= NOTICE_EVENT_COOLDOWN_MILLISECONDS) {
        this.dismissedNoticeEvents.set(eventKey, Date.now());
        await this.onEvent({
          type: 'browser-notice-dismissed',
          message: 'Dismissed ChatGPT’s temporary request-limit notice; background monitoring continues.',
        });
      }
      return true;
    } finally {
      this.dismissalBusy = false;
    }
  }

  async checkForResult({ force = false } = {}) {
    if (this.activeMerge) return this.checkForMerge();
    const task = this.activeTask;
    const allowedState = force ? ['submitted', 'conflicted'] : ['submitted'];
    if (this.monitorBusy || !task || !allowedState.includes(task.state)) return false;
    if (task.chatStatus === 'failed') return false;
    if (this.processingTasks.has(task.taskId) || this.view.webContents.isDestroyed()) return false;
    const attemptedAt = this.resultAttempts.get(task.taskId) || 0;
    if (!force && Date.now() - attemptedAt < RESULT_RETRY_MILLISECONDS) return false;

    this.monitorBusy = true;
    try {
      const expectedName = task.resultFilename || `chatgpt-ide-result-${task.taskId}.txt`;
      this.pendingDownload = { kind: 'task', taskId: task.taskId, startedAt: Date.now() };
      // A fresh, synchronous user gesture is required for ChatGPT's generated-file link.
      // A click fired later by a page-owned timer can be silently blocked by Chromium.
      const result = await this.view.webContents.executeJavaScript(
        buildTaskResultDetectionScript(task, task.chatStatus === 'completed'),
        true,
      ).catch(() => ({ kind: 'none' }));
      if (result?.kind !== 'download') {
        if (this.pendingDownload?.kind === 'task' && this.pendingDownload.taskId === task.taskId) {
          this.pendingDownload = null;
        }
        return false;
      }
      this.resultAttempts.set(task.taskId, Date.now());
      await this.onEvent({
        type: 'result-link-activated',
        taskId: task.taskId,
        message: `Found ${expectedName}; starting the secure download…`,
      });
      return true;
    } finally {
      this.monitorBusy = false;
    }
  }

  async refreshTaskResult(task) {
    if (!task?.taskId || !isChatGPTConversationUrl(task.conversationUrl)) {
      throw new Error('This task has no saved ChatGPT conversation to refresh its result from.');
    }
    const taskId = task.taskId;
    const key = taskId.toLowerCase();
    if (this.resultWaiters.has(key)) {
      throw new Error('A result download is already in progress for this task.');
    }

    this.activeMerge = null;
    this.activeTask = task;
    this.knownTasks.set(key, task);
    let resultTimeout = null;
    const waitForResult = new Promise((resolve, reject) => {
      resultTimeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for chatgpt-ide-result-${taskId}.txt to finish downloading.`));
      }, 30_000);
      this.resultWaiters.set(key, {
        resolve: (value) => {
          clearTimeout(resultTimeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(resultTimeout);
          reject(error);
        },
      });
    });

    try {
      const currentUrl = this.view.webContents.getURL();
      const currentConversationId = conversationIdFromRouteUrl(currentUrl);
      const taskConversationId = conversationIdFromRouteUrl(task.conversationUrl) || task.conversationId;
      const conversationAlreadyOpen = currentUrl === task.conversationUrl
        || Boolean(taskConversationId && currentConversationId === taskConversationId);
      if (!conversationAlreadyOpen) {
        await this.view.webContents.loadURL(task.conversationUrl);
      }

      this.resultAttempts.delete(taskId);
      let started = false;
      for (let attempt = 0; attempt < 10 && !started; attempt += 1) {
        while (this.monitorBusy) await delay(100);
        started = await this.checkForResult({ force: true });
        if (!started) await delay(250);
      }
      if (!started && !this.processingTasks.has(taskId)) {
        throw new Error(`Could not find chatgpt-ide-result-${taskId}.txt in the saved ChatGPT conversation.`);
      }

      return await waitForResult;
    } catch (error) {
      this.resultWaiters.get(key)?.reject(error);
      throw error;
    } finally {
      clearTimeout(resultTimeout);
      this.resultWaiters.delete(key);
    }
  }

  async checkForMerge() {
    const tree = this.activeMerge;
    if (this.monitorBusy || !tree || tree.mergeState !== 'submitted') return false;
    if (this.pendingDownload?.kind === 'merge' && this.pendingDownload.treeId === tree.id) return false;
    this.monitorBusy = true;
    try {
      this.pendingDownload = { kind: 'merge', treeId: tree.id, startedAt: Date.now() };
      const result = await this.view.webContents.executeJavaScript(
        buildMergeResultDetectionScript(tree.id),
        true,
      ).catch(() => ({ kind: 'none' }));
      if (result?.kind !== 'download') {
        if (this.pendingDownload?.kind === 'merge' && this.pendingDownload.treeId === tree.id) {
          this.pendingDownload = null;
        }
        return false;
      }
      await this.onEvent({
        type: 'merge-result-link-activated',
        treeId: tree.id,
        message: `Found ${mergeResultFilename(tree.id)}; starting the secure download…`,
      });
      return true;
    } finally {
      this.monitorBusy = false;
    }
  }

  copyPrompt(task) {
    clipboard.writeText(task.taskText);
  }

  revealPackage(task) {
    shell.showItemInFolder(task.packagePath);
  }

  forgetTask(taskId) {
    const key = String(taskId).toLowerCase();
    const waiter = this.resultWaiters.get(key);
    if (waiter) waiter.reject(new Error('This task was removed while its result was being downloaded.'));
    this.resultWaiters.delete(key);
    this.knownTasks.delete(key);
    this.processingTasks.delete(taskId);
    this.resultAttempts.delete(taskId);
    if (this.activeTask?.taskId === taskId) this.activeTask = null;
    if (this.pendingDownload?.kind === 'task' && this.pendingDownload.taskId === taskId) {
      this.pendingDownload = null;
    }
  }

  async finishMergeResult(tree, resultText) {
    const completed = await this.onMergeResult(tree.id, resultText);
    this.pendingDownload = null;
    if (this.activeMerge?.id === tree.id) this.activeMerge = null;
    return completed;
  }

  async importResult(task) {
    const response = await dialog.showOpenDialog(this.mainWindow, {
      title: 'Choose a saved ChatGPT result',
      properties: ['openFile'],
      filters: [
        { name: 'Patchwork text results', extensions: ['txt'] },
      ],
    });
    if (response.canceled || response.filePaths.length === 0) return null;
    const selectedPath = response.filePaths[0];
    return this.onResult(task.taskId, selectedPath);
  }
}

module.exports = {
  CHATGPT_URL,
  ChatGPTView,
  buildTaskConfigurationScript,
  chatGPTProjectUrl,
  buildLimitNoticeDismissalScript,
  buildPackageAttachmentStatusScript,
  buildFileInputEventScript,
  buildMergeResultDetectionScript,
  buildTaskResultDetectionScript,
  buildConversationStatusScript,
  conversationIdFromRouteUrl,
  conversationIdFromStreamStatusUrl,
  isChatGPTConversationUrl,
  isDismissibleLimitNotice,
  isRecoverableChatGPTNetworkFailure,
  normalizeConversationStreamStatus,
  recoverUnconfirmedSubmissions,
  rewriteConversationRequestBody,
  taskRequestConfiguration,
  mergeTreeId,
  resultTaskId,
};
