const { AI_CHAT_RUN_STATUS } = require('./ai-chat-service');

const COMPOSER_SELECTOR = [
  '.wcDTda_prosemirror-parent .ProseMirror[contenteditable="true"]',
  '#prompt-textarea:not(.wcDTda_fallbackTextarea)',
  '[data-testid="prompt-textarea"]:not(.wcDTda_fallbackTextarea)',
  '[contenteditable="true"][role="textbox"]',
  '.ProseMirror[contenteditable="true"]',
].join(',');

const DISMISSIBLE_LIMIT_NOTICE = /(?:too many requests|messages? limit reached|usage (?:limit|cap) (?:reached|exceeded)|rate limit (?:reached|exceeded)|excess usage|extra usage|you(?:['’]ve| have) (?:reached|hit) (?:the |your )?(?:current |daily |monthly |plan )?(?:message |messages |usage |rate |chatgpt )?(?:limit|cap))/i;
const DISMISSIVE_NOTICE_ACTION = /^(?:got it|close|dismiss|ok|okay)$/i;

function hasComposerAction(input) {
  return Boolean(document.querySelector(input.composerSelector));
}

function readSessionStateAction(input) {
  const hasComposer = Boolean(document.querySelector(input.composerSelector));
  const hasSignIn = [...document.querySelectorAll('button, a')]
    .some((node) => /log in|sign in/i.test(String(node.textContent || node.getAttribute('aria-label') || '')));
  return { authenticated: hasComposer && !hasSignIn };
}

function dismissBlockingNoticeAction(input) {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const noticePattern = new RegExp(input.noticePattern, 'i');
  const actionPattern = new RegExp(input.actionPattern, 'i');
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
    const enabledActions = [...container.querySelectorAll('button, [role="button"]')]
      .filter((item) => !item.disabled && item.getAttribute('aria-disabled') !== 'true');
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
    return { resolved: true, notice: notice.slice(0, 240), action };
  }
  return { resolved: false, notice: null, action: null };
}

function listWorkspacesAction() {
  const workspaces = new Map();
  for (const link of document.querySelectorAll('a[href]')) {
    const match = /\/g\/(g-p-[A-Za-z0-9_-]+)/.exec(link.href || '');
    const name = String(link.textContent || link.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (match && name) workspaces.set(match[1], { id: match[1], routeId: match[1], name });
  }
  const authenticationRequired = [...document.querySelectorAll('button, a')]
    .some((node) => /log in|sign in/i.test(String(node.textContent || node.getAttribute('aria-label') || '')));
  return { workspaces: [...workspaces.values()], authenticationRequired };
}

function openCreateWorkspaceAction() {
  const control = [...document.querySelectorAll('button, [role="button"]')].find((node) => (
    /new project|create project/i.test([
      node.textContent,
      node.getAttribute('aria-label'),
      node.getAttribute('title'),
    ].filter(Boolean).join(' '))
  ));
  control?.click();
  return Boolean(control);
}

function submitCreateWorkspaceAction(args) {
  const { name } = args;
  const input = [...document.querySelectorAll('input, textarea')].find((node) => /project name|name/i.test([
    node.getAttribute('placeholder'), node.getAttribute('aria-label'), node.name,
  ].filter(Boolean).join(' ')));
  if (!input) return { ready: false, submitted: false };
  input.focus();
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, name);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const submit = [...document.querySelectorAll('button, [role="button"]')].find((node) => (
    /^(?:create|save)$/i.test(String(node.textContent || '').trim())
      && !node.disabled && node.getAttribute('aria-disabled') !== 'true'
  ));
  submit?.click();
  return { ready: true, submitted: Boolean(submit) };
}

async function installConfigurationPickerAction(input) {
  const pickerId = 'patchwork-ai-chat-configuration';
  const menuId = 'patchwork-ai-chat-configuration-menu';
  const styleId = 'patchwork-ai-chat-native-model-suppression';
  const nativeSelector = [
    '[aria-label^="Model selector" i]',
    '[aria-label*="current model" i]',
    '[style*="--vt-thread-model-switcher"]',
    '[data-testid="model-switcher-dropdown"]',
    '[data-testid="model-switcher-dropdown-button"]',
    '[data-testid="model-switcher-dropdown"] > button',
    'button.composer-intelligence-button',
    'button[class*="composer-intelligence-button"]',
  ].join(',');
  const visible = (node) => {
    const bounds = node?.getBoundingClientRect?.();
    return Boolean(bounds && bounds.width > 0 && bounds.height > 0);
  };
  const nativeLabel = /^(?:ChatGPT(?:\s+5(?:\.\d+)*)?|GPT-5(?:\.\d+)*(?:\s+(?:Instant|Thinking|Auto|Pro))?|Instant|Thinking(?:\s+mini)?|Auto|Pro)$/i;
  const findAnchor = () => {
    const semantic = [...document.querySelectorAll('button, [role="button"], [aria-haspopup="menu"]')]
      .find((candidate) => visible(candidate) && nativeLabel.test(String(candidate.textContent || '').replace(/\s+/g, ' ').trim()));
    const selected = [...document.querySelectorAll(nativeSelector)]
      .map((node) => node.closest('button, [role="button"], [aria-haspopup="menu"]') || node)
      .find(visible);
    return selected || semantic || null;
  };
  const state = globalThis.__patchworkAIChatConfiguration;
  const selection = state?.chatKey === input.chatKey
    ? state
    : { chatKey: input.chatKey, model: input.model, reasoning: input.reasoning };
  globalThis.__patchworkAIChatConfiguration = selection;
  const currentSelection = () => globalThis.__patchworkAIChatConfiguration;

  let picker = document.getElementById(pickerId);
  let menu = document.getElementById(menuId);
  if (!picker) {
    picker = document.createElement('patchwork-ai-chat-configuration');
    picker.id = pickerId;
    picker.style.cssText = 'display:inline-flex;position:fixed;z-index:2147483646;color:#f4f4f4;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
    const shadow = picker.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>button{display:inline-flex;min-height:32px;align-items:center;gap:5px;padding:0 9px;border:0;border-radius:8px;color:inherit;background:#212121;font:500 14px/20px inherit;box-shadow:0 1px 5px #0003;white-space:nowrap;cursor:pointer}button:hover,button[aria-expanded="true"]{background:#2f2f2f}</style><button type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Patchwork model and reasoning"><span></span><span aria-hidden="true">⌄</span></button>';
    document.body.append(picker);

    menu = document.createElement('patchwork-ai-chat-configuration-menu');
    menu.id = menuId;
    menu.hidden = true;
    menu.style.cssText = 'position:fixed;z-index:2147483647;width:250px;padding:6px;border:1px solid #ffffff1f;border-radius:14px;background:#212121;color:#f4f4f4;box-shadow:0 14px 36px #0007;font:14px/20px ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
    menu.innerHTML = '<div data-heading>Model</div><button data-model="sol">GPT-5.6 Sol</button><button data-model="luna">GPT-5.6 Luna</button><hr><div data-heading>Thinking</div><button data-reasoning="default">Model default</button><button data-reasoning="instant">Instant</button><button data-reasoning="low">Low</button><button data-reasoning="medium">Medium</button><button data-reasoning="high">High</button><button data-reasoning="extra-high">Extra High</button><style>:scope{box-sizing:border-box}:scope button{display:flex;width:100%;justify-content:space-between;padding:8px 10px;border:0;border-radius:8px;color:inherit;background:transparent;font:inherit;text-align:left;cursor:pointer}:scope button:hover,:scope button[aria-checked="true"]{background:#2f2f2f}:scope button[aria-checked="true"]::after{content:"✓"}:scope [data-heading]{padding:6px 10px 3px;color:#aaa;font-size:12px;font-weight:600}:scope hr{height:1px;margin:5px 4px;border:0;background:#ffffff1f}</style>';
    document.body.append(menu);

    const trigger = shadow.querySelector('button');
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const bounds = picker.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(bounds.left, innerWidth - 266))}px`;
      menu.style.top = `${Math.min(bounds.bottom + 6, innerHeight - 390)}px`;
      menu.hidden = !menu.hidden;
      trigger.setAttribute('aria-expanded', String(!menu.hidden));
    });
    menu.addEventListener('click', (event) => {
      const option = event.target.closest('button');
      if (!option) return;
      const current = currentSelection();
      if (option.dataset.model) current.model = option.dataset.model;
      if (option.dataset.reasoning) current.reasoning = option.dataset.reasoning;
      picker.__patchworkRender?.();
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    });
    document.addEventListener('pointerdown', (event) => {
      if (event.target === picker || event.target === menu || menu.contains(event.target)) return;
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }, true);
  }

  const render = () => {
    const current = globalThis.__patchworkAIChatConfiguration;
    if (picker.getAttribute('data-model') !== current.model) picker.setAttribute('data-model', current.model);
    if (picker.getAttribute('data-reasoning') !== current.reasoning) picker.setAttribute('data-reasoning', current.reasoning);
    const modelLabel = current.model === 'luna' ? 'Luna' : 'Sol';
    const reasoningLabel = {
      default: 'Auto', instant: 'Instant', low: 'Low', medium: 'Medium', high: 'High', 'extra-high': 'Extra High',
    }[current.reasoning] || 'Auto';
    picker.shadowRoot.querySelector('span').textContent = `${modelLabel} · ${reasoningLabel}`;
    for (const option of menu.querySelectorAll('button')) {
      const checked = option.dataset.model === current.model || option.dataset.reasoning === current.reasoning;
      option.setAttribute('aria-checked', String(checked));
    }
    const anchor = findAnchor();
    if (anchor) {
      const bounds = anchor.getBoundingClientRect();
      picker.style.left = `${Math.max(8, bounds.left)}px`;
      picker.style.top = `${Math.max(4, bounds.top)}px`;
      let suppression = document.getElementById(styleId);
      if (!suppression) {
        suppression = document.createElement('style');
        suppression.id = styleId;
        document.head.append(suppression);
      }
      const rule = `${nativeSelector}{visibility:hidden!important;pointer-events:none!important}`;
      if (suppression.textContent !== rule) suppression.textContent = rule;
    } else {
      picker.style.left = '48px';
      picker.style.top = '8px';
    }
  };
  picker.__patchworkRender = render;
  render();
  globalThis.__patchworkAIChatConfigurationObserver?.disconnect();
  let renderPending = false;
  const observer = new MutationObserver((mutations) => {
    const externalChange = mutations.some(({ target }) => (
      target !== picker && target !== menu && !picker.contains(target) && !menu.contains(target)
    ));
    if (!externalChange || renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      render();
    });
  });
  observer.observe(document.body, { attributes: true, childList: true, subtree: true });
  globalThis.__patchworkAIChatConfigurationObserver = observer;
  return {
    model: currentSelection().model,
    reasoning: currentSelection().reasoning,
  };
}

function readConfigurationPickerAction() {
  const picker = document.getElementById('patchwork-ai-chat-configuration');
  if (!picker) return null;
  return { model: picker.getAttribute('data-model'), reasoning: picker.getAttribute('data-reasoning') };
}

function promptStateAction(input) {
  const { composerSelector, prompt } = input;
  const candidates = [...document.querySelectorAll(composerSelector)].filter((element) => (
    element.isConnected !== false
      && !element.disabled
      && element.getAttribute('aria-disabled') !== 'true'
      && !element.closest('[aria-hidden="true"], [inert]')
  ));
  const composer = candidates.find((element) => element === document.activeElement)
    || [...candidates].reverse().find((element) => element.closest('form'))
    || candidates.at(-1);
  if (!composer) return { available: false, present: false, length: 0 };
  const value = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
    ? composer.value
    : composer.innerText || composer.textContent || '';
  const normalize = (text) => String(text || '')
    .normalize('NFC')
    .replace(/[\u200b-\u200d\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    available: true,
    present: normalize(value) === normalize(prompt),
    length: String(value || '').length,
  };
}

function preparePromptInputAction(input) {
  const candidates = [...document.querySelectorAll(input.composerSelector)].filter((element) => (
    element.isConnected !== false
      && !element.disabled
      && element.getAttribute('aria-disabled') !== 'true'
      && !element.closest('[aria-hidden="true"], [inert]')
  ));
  const composer = candidates.find((element) => element === document.activeElement)
    || [...candidates].reverse().find((element) => element.closest('form'))
    || candidates.at(-1);
  if (!composer) return { available: false };
  composer.focus();
  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    composer.setSelectionRange?.(0, composer.value.length);
    composer.select?.();
  } else {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return { available: true };
}

function insertPromptAction(input) {
  const { composerSelector, prompt } = input;
  const composer = document.querySelector(composerSelector);
  if (!composer) return { available: false, present: false, length: 0 };
  composer.focus();
  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    const prototype = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(composer, prompt);
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    composer.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, prompt);
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
  }
  const value = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
    ? composer.value
    : composer.innerText || composer.textContent || '';
  const normalize = (text) => String(text || '').replaceAll('\r\n', '\n').replaceAll('\u00a0', ' ').trim();
  return { available: true, present: normalize(value) === normalize(prompt), length: String(value || '').length };
}

function sendStateAction() {
  const candidates = [...document.querySelectorAll('button')];
  const button = document.querySelector('[data-testid="send-button"]')
    || candidates.find((item) => /send prompt|send message|^send$/i.test([
      item.getAttribute('aria-label'), item.getAttribute('title'), item.textContent,
    ].filter(Boolean).join(' ').trim()));
  return {
    available: Boolean(button),
    enabled: Boolean(button && !button.disabled && button.getAttribute('aria-disabled') !== 'true'),
  };
}

function clickSendAction() {
  const candidates = [...document.querySelectorAll('button')];
  const button = document.querySelector('[data-testid="send-button"]')
    || candidates.find((item) => /send prompt|send message|^send$/i.test([
      item.getAttribute('aria-label'), item.getAttribute('title'), item.textContent,
    ].filter(Boolean).join(' ').trim()));
  if (!button) return { available: false, enabled: false };
  if (button.disabled || button.getAttribute('aria-disabled') === 'true') return { available: true, enabled: false };
  button.click();
  return { available: true, enabled: true };
}

function attachmentStateAction(input) {
  const { filename } = input;
  const roots = [document];
  const visited = new Set();
  const fileInputs = [];
  const candidates = [];
  const notices = [];
  while (roots.length) {
    const root = roots.shift();
    if (!root || visited.has(root)) continue;
    visited.add(root);
    fileInputs.push(...root.querySelectorAll('input[type="file"]'));
    notices.push(...root.querySelectorAll('[role="dialog"], [role="alert"], [aria-live]'));
    candidates.push(...root.querySelectorAll(
      '[data-testid*="file" i], [data-testid*="attach" i], [aria-label], [title], span, div',
    ));
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
  }
  const selected = fileInputs.some((input) => [...(input.files || [])]
    .some((file) => file.name === filename));
  const duplicateNotice = notices.find((element) => /already (?:been )?uploaded|duplicate file/i.test(
    [element.textContent, element.getAttribute('aria-label')].filter(Boolean).join(' '),
  ));
  if (duplicateNotice && input.dismissDuplicate) {
    const dismiss = [...duplicateNotice.querySelectorAll('button, [role="button"]')]
      .find((button) => /^(?:got it|close|dismiss|ok|okay)$/i.test([
        button.textContent, button.getAttribute('aria-label'), button.getAttribute('title'),
      ].filter(Boolean).join(' ').trim()));
    dismiss?.click();
  }
  const rendered = candidates.map((element) => {
    const values = [element.textContent, element.getAttribute('aria-label'), element.getAttribute('title')]
      .filter(Boolean).map((value) => String(value).replace(/\s+/g, ' ').trim());
    const matching = values.filter((value) => (
      value === filename || (value.includes(filename) && value.length <= filename.length + 160)
    )).sort((left, right) => left.length - right.length)[0];
    return matching ? { element, length: matching.length } : null;
  }).filter(Boolean).sort((left, right) => left.length - right.length)[0]?.element;
  if (!rendered) return { present: selected, busy: selected, confirmed: false };
  const card = rendered.closest('[data-testid*="file" i], [data-testid*="attach" i]') || rendered.parentElement;
  const statusText = [card?.textContent, card?.getAttribute?.('aria-label')].filter(Boolean).join(' ');
  const busy = /uploading|processing|attaching/i.test(statusText)
    || Boolean(card?.querySelector?.('[role="progressbar"], progress, [aria-busy="true"]'));
  return { present: true, busy, confirmed: !busy };
}

function dispatchFileSelectionAction(input) {
  const fileInput = document.querySelector('#upload-files');
  if (![...(fileInput?.files || [])].some((file) => file.name === input.filename)) return false;
  if (!fileInput) return false;
  fileInput.dispatchEvent(new Event('input', { bubbles: true }));
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function stopRunAction() {
  const control = [...document.querySelectorAll('button, [role="button"]')].find((element) => (
    /stop(?: generating| streaming| response)?/i.test([
      element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent, element.dataset?.testid,
    ].filter(Boolean).join(' '))
  ));
  control?.click();
  return Boolean(control);
}

function readRunStatusAction() {
  const controls = [...document.querySelectorAll('button, [role="button"]')];
  const streaming = controls.some((element) => /stop(?: generating| streaming| response)?/i.test([
    element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent, element.dataset?.testid,
  ].filter(Boolean).join(' ')));
  if (streaming) return { status: 'streaming', evidence: 'stop-control' };
  const alerts = [...document.querySelectorAll('[role="alert"], [role="alertdialog"], [data-testid*="error" i]')]
    .map((element) => String(element.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
  if (/(?:something went wrong|generation failed|error generating|unable to generate|network error)/i.test(alerts)) {
    return { status: 'failed', evidence: 'error-notice' };
  }
  const responses = document.querySelectorAll('[data-message-author-role="assistant"], article [data-testid*="conversation-turn" i]');
  return responses.length > 0
    ? { status: 'completed', evidence: 'assistant-turn' }
    : { status: 'unknown', evidence: 'empty-transcript' };
}

function readChatSnapshotAction() {
  const messages = [...document.querySelectorAll('[data-message-author-role]')].map((element, index) => {
    const role = element.getAttribute('data-message-author-role');
    const content = String(element.textContent || '').replace(/\s+/g, ' ').trim();
    return { id: element.getAttribute('data-message-id') || `${role}-${index}`, role, content };
  }).filter((message) => message.content && ['user', 'assistant', 'system'].includes(message.role));
  const thinking = [...document.querySelectorAll('[data-testid*="reasoning" i], details')]
    .map((element) => String(element.textContent || '').replace(/\s+/g, ' ').trim())
    .find(Boolean) || null;
  const attachments = [...document.querySelectorAll('[data-testid*="attachment" i], [class*="attachment" i]')]
    .map((element) => String(element.textContent || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((name) => ({ name, status: 'ready' }));
  return { messages, thinkingSummary: thinking, attachments };
}

function downloadAttachmentAction(input) {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const matches = [...document.querySelectorAll('a, button, [role="button"], [data-testid*="attachment" i]')]
    .filter((element) => normalize(element.textContent || element.getAttribute('aria-label')).includes(input.name));
  for (const match of matches) {
    const container = match.closest('article, [data-message-author-role="assistant"], li, div') || match.parentElement;
    const control = (match.matches('a[download], button[aria-label*="download" i]') ? match : null)
      || container?.querySelector('a[download], button[aria-label*="download" i], [role="button"][aria-label*="download" i]');
    if (!control || control.disabled || control.getAttribute('aria-disabled') === 'true') continue;
    control.click();
    return true;
  }
  return false;
}

class ChatGPTBrowserDriver {
  constructor(webContents) {
    if (!webContents) throw new TypeError('ChatGPTBrowserDriver requires Electron webContents.');
    this.webContents = webContents;
  }

  hasComposer() { return this.#execute(hasComposerAction, { composerSelector: COMPOSER_SELECTOR }); }

  readSessionState() { return this.#execute(readSessionStateAction, { composerSelector: COMPOSER_SELECTOR }); }

  dismissBlockingNotice() {
    return this.#execute(dismissBlockingNoticeAction, {
      noticePattern: DISMISSIBLE_LIMIT_NOTICE.source,
      actionPattern: DISMISSIVE_NOTICE_ACTION.source,
    });
  }

  listWorkspaces() { return this.#execute(listWorkspacesAction); }

  openCreateWorkspace() { return this.#execute(openCreateWorkspaceAction); }

  submitCreateWorkspace(name) { return this.#execute(submitCreateWorkspaceAction, { name }); }

  installConfigurationPicker(configuration) {
    return this.#execute(installConfigurationPickerAction, configuration);
  }

  readConfigurationPicker() { return this.#execute(readConfigurationPickerAction); }

  async insertPrompt(prompt) {
    this.webContents.focus?.();
    const prepared = await this.#execute(preparePromptInputAction, { composerSelector: COMPOSER_SELECTOR });
    if (!prepared?.available) return { available: false, present: false, length: 0 };
    const debuggerApi = this.webContents.debugger;
    let attachedHere = false;
    try {
      if (debuggerApi?.sendCommand) {
        if (!debuggerApi.isAttached()) {
          debuggerApi.attach('1.3');
          attachedHere = true;
        }
        await debuggerApi.sendCommand('Input.insertText', { text: prompt });
      } else if (typeof this.webContents.insertText === 'function') {
        await this.webContents.insertText(prompt);
      } else {
        return this.#execute(insertPromptAction, { composerSelector: COMPOSER_SELECTOR, prompt });
      }
    } finally {
      if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    return this.promptState(prompt);
  }

  promptState(prompt) { return this.#execute(promptStateAction, { composerSelector: COMPOSER_SELECTOR, prompt }); }

  sendState() { return this.#execute(sendStateAction); }

  clickSend() { return this.#execute(clickSendAction); }

  async interceptNextConversationRequest(configuration, expectedDraft = {}) {
    const debuggerApi = this.webContents.debugger;
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
    const continueUnmodified = (requestId) => debuggerApi.sendCommand('Fetch.continueRequest', { requestId }).catch(() => {});
    const handlePausedRequest = async (params) => {
      const requestId = params?.requestId;
      const request = params?.request || {};
      if (!requestId) return;
      let pathname = '';
      try { pathname = new URL(request.url).pathname; } catch {
        await continueUnmodified(requestId);
        return;
      }
      const isConversation = request.method === 'POST' && pathname === '/backend-api/f/conversation';
      const isPrepare = request.method === 'POST' && pathname === '/backend-api/f/conversation/prepare';
      if (!isConversation && !isPrepare) {
        await continueUnmodified(requestId);
        return;
      }
      try {
        let postData = request.postData;
        if (typeof postData !== 'string' && request.postDataEntries?.length === 1) {
          postData = Buffer.from(request.postDataEntries[0].bytes, 'base64').toString('utf8');
        }
        if (typeof postData !== 'string' && params.networkId) {
          const body = await debuggerApi.sendCommand('Network.getRequestPostData', { requestId: params.networkId });
          postData = body?.postData;
        }
        const payload = JSON.parse(String(postData || ''));
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          throw new Error('ChatGPT sent an invalid conversation request.');
        }
        const containsText = (value, expected) => {
          if (typeof value === 'string') return value.includes(expected);
          if (Array.isArray(value)) return value.some((item) => containsText(item, expected));
          if (value && typeof value === 'object') return Object.values(value)
            .some((item) => containsText(item, expected));
          return false;
        };
        if (isConversation && expectedDraft.prompt && !containsText(payload, expectedDraft.prompt)) {
          await debuggerApi.sendCommand('Fetch.failRequest', { requestId, errorReason: 'Aborted' });
          complete({ applied: false, error: 'The outgoing ChatGPT request did not contain the confirmed prompt.' });
          return;
        }
        const missingAttachment = isConversation && (expectedDraft.attachments || [])
          .find((filename) => !containsText(payload, filename));
        if (missingAttachment) {
          await debuggerApi.sendCommand('Fetch.failRequest', { requestId, errorReason: 'Aborted' });
          complete({
            applied: false,
            error: `The outgoing ChatGPT request did not contain the confirmed attachment ${missingAttachment}.`,
          });
          return;
        }
        payload.model = configuration.modelSlug;
        if (configuration.thinkingEffort) payload.thinking_effort = configuration.thinkingEffort;
        else delete payload.thinking_effort;
        await debuggerApi.sendCommand('Fetch.continueRequest', {
          requestId,
          postData: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
        });
        if (isConversation) complete({
          applied: true,
          attachmentsConfirmed: [...(expectedDraft.attachments || [])],
          modelSlug: configuration.modelSlug,
          promptConfirmed: Boolean(expectedDraft.prompt),
        });
      } catch (error) {
        await continueUnmodified(requestId);
        if (isConversation) complete({ applied: false, error: error.message });
      }
    };
    const onDebuggerMessage = (_event, method, params) => {
      if (method === 'Fetch.requestPaused') handlePausedRequest(params).catch((error) => {
        complete({ applied: false, error: error.message });
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
      throw error;
    }

    return {
      wait: async (timeoutMilliseconds = 30_000) => {
        const result = await Promise.race([
          resultPromise,
          new Promise((resolve) => setTimeout(
            () => resolve({ applied: false, error: 'ChatGPT did not send a conversation request after Send.' }),
            timeoutMilliseconds,
          )),
        ]);
        if (!result.applied) throw new Error(result.error || 'The AI chat configuration was not applied.');
        return result;
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        debuggerApi.removeListener?.('message', onDebuggerMessage);
        if (fetchEnabled && debuggerApi.isAttached()) await debuggerApi.sendCommand('Fetch.disable').catch(() => {});
        if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
      },
    };
  }

  async attachFile(filePath, filename) {
    const debuggerApi = this.webContents.debugger;
    let attachedHere = false;
    try {
      if (!debuggerApi.isAttached()) {
        debuggerApi.attach('1.3');
        attachedHere = true;
      }
      const nodeId = await this.#findFileInputNodeId(debuggerApi, '#upload-files');
      if (!nodeId) return false;
      await debuggerApi.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId });
      return this.#execute(dispatchFileSelectionAction, { filename });
    } finally {
      if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
    }
  }

  attachmentState(filename, options = {}) {
    return this.#execute(attachmentStateAction, { filename, dismissDuplicate: Boolean(options.dismissDuplicate) });
  }

  stopRun() { return this.#execute(stopRunAction); }

  async readRunStatus() {
    const result = await this.#execute(readRunStatusAction);
    if (!Object.values(AI_CHAT_RUN_STATUS).includes(result?.status)) {
      return { status: AI_CHAT_RUN_STATUS.UNKNOWN, evidence: 'invalid-browser-result' };
    }
    return result;
  }

  readChatSnapshot() { return this.#execute(readChatSnapshotAction); }

  downloadAttachment(name) { return this.#execute(downloadAttachmentAction, { name }); }

  async #findFileInputNodeId(debuggerApi, selector) {
    const documentResult = await debuggerApi.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    const query = await debuggerApi.sendCommand('DOM.querySelector', {
      nodeId: documentResult.root.nodeId,
      selector,
    });
    return query.nodeId || 0;
  }

  #execute(action, input = {}) {
    const source = `(${action.toString()})(${JSON.stringify(input)})`;
    return this.webContents.executeJavaScript(source, true);
  }
}

module.exports = { ChatGPTBrowserDriver };
