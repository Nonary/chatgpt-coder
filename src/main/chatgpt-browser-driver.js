const { AI_CHAT_RUN_STATUS } = require('./ai-chat-service');
const { ipcMain } = require('electron');

const COMPOSER_SELECTOR = [
  '.wcDTda_prosemirror-parent .ProseMirror[contenteditable="true"]',
  '#prompt-textarea:not(.wcDTda_fallbackTextarea)',
  '[data-testid="prompt-textarea"]:not(.wcDTda_fallbackTextarea)',
  '[contenteditable="true"][role="textbox"]',
  '.ProseMirror[contenteditable="true"]',
].join(',');

const DISMISSIBLE_LIMIT_NOTICE = /(?:too many requests|messages? limit reached|usage (?:limit|cap) (?:reached|exceeded)|rate limit (?:reached|exceeded)|excess usage|extra usage|you(?:['’]ve| have) (?:reached|hit) (?:the |your )?(?:current |daily |monthly |plan )?(?:message |messages |usage |rate |chatgpt )?(?:limit|cap))/i;
const DISMISSIVE_NOTICE_ACTION = /^(?:got it|close|dismiss|ok|okay)$/i;
const CHATGPT_HOME_URL = 'https://chatgpt.com/';
const CHATGPT_PROJECTS_URL = 'https://chatgpt.com/library?tab=projects';
const BROWSER_NAVIGATION_TIMEOUT_MILLISECONDS = 15_000;
const BROWSER_ACTION_TIMEOUT_MILLISECONDS = 5_000;
const WORKSPACE_NAVIGATION_WAIT_ATTEMPTS = 24;
const CHAT_DOM_SNAPSHOT_CHANNEL = 'patchwork:chat-dom-snapshot';

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function projectsFromBrowserResponse(body, base64Encoded = false) {
  try {
    const text = base64Encoded ? Buffer.from(String(body || ''), 'base64').toString('utf8') : String(body || '');
    const data = JSON.parse(text);
    if (!Array.isArray(data?.items)) return [];
    const projects = [];
    for (const item of data.items) {
      const project = item?.gizmo?.gizmo || item?.gizmo;
      const id = String(project?.id || '');
      const name = String(project?.display?.name || '').trim();
      if (/^g-p-[A-Za-z0-9_-]+$/.test(id) && name) projects.push({ id, name });
    }
    return projects;
  } catch {
    return [];
  }
}

function isWorkspaceIndexResponse(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && url.hostname === 'chatgpt.com'
      && url.pathname.endsWith('/gizmos/snorlax/sidebar');
  } catch {
    return false;
  }
}

function isChatGPTBrowserUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname === 'chatgpt.com';
  } catch {
    return false;
  }
}

function conversationIdFromBrowserUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return null;
    return /^\/c\/([^/]+)\/?$/i.exec(url.pathname)?.[1]
      || /^\/g\/g-p-[A-Za-z0-9_-]+\/c\/([^/]+)\/?$/i.exec(url.pathname)?.[1]
      || null;
  } catch {
    return null;
  }
}

function workspaceRouteMatches(value, workspaceId = null) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return false;
    if (!workspaceId) return url.pathname === '/';
    const escaped = String(workspaceId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^/g/${escaped}(?:-[^/]+)?(?:/project)?/?$`, 'i').test(url.pathname);
  } catch {
    return false;
  }
}

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

function readWorkspaceIndexAction() {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const roots = [document];
  const visited = new Set();
  const links = [];
  const controls = [];
  while (roots.length) {
    const root = roots.shift();
    if (!root || visited.has(root)) continue;
    visited.add(root);
    links.push(...root.querySelectorAll('a[href]'));
    controls.push(...root.querySelectorAll('button, a, [role="button"], [role="alert"]'));
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
  }
  const workspaces = new Map();
  for (const link of links) {
    let routeId = null;
    try {
      const pathname = new URL(link.getAttribute('href') || link.href || '', location.href).pathname;
      routeId = /^\/g\/(g-p-[A-Za-z0-9_-]+)(?:\/project)?\/?$/i.exec(pathname)?.[1] || null;
    } catch {}
    if (!routeId) continue;
    const id = /^(g-p-[a-f0-9]{32})(?:-|$)/i.exec(routeId)?.[1] || routeId;
    const row = link.closest('tr, li, article, [role="row"], [data-testid*="project" i]');
    const optionsLabel = [...(row?.querySelectorAll?.('button, [role="button"]') || [])]
      .map((node) => normalize(node.getAttribute('aria-label')))
      .find((label) => /^open project options for .+/i.test(label));
    const name = normalize(link.textContent)
      || optionsLabel?.replace(/^open project options for /i, '')
      || normalize(link.getAttribute('title'));
    if (name && !workspaces.has(id)) workspaces.set(id, { id, name });
  }
  const labels = controls.map((node) => normalize([
    node.textContent,
    node.getAttribute?.('aria-label'),
    node.getAttribute?.('title'),
  ].filter(Boolean).join(' ')));
  const pageText = normalize(document.body?.textContent);
  const authenticationRequired = labels.some((label) => /^(?:log in|sign in)(?:\s|$)/i.test(label));
  const error = labels.find((label) => /unable to load projects/i.test(label))
    || (/unable to load projects/i.test(pageText) ? 'Unable to load projects' : null);
  const empty = /no projects yet|no projects$/i.test(pageText);
  const projectsPage = location.pathname === '/library' && /(?:^|[?&])tab=projects(?:&|$)/.test(location.search);
  // The library shell and its labels render before its project data. Only an
  // actual project or ChatGPT's explicit empty state means loading has ended.
  const ready = workspaces.size > 0 || (projectsPage && empty);
  return {
    workspaces: [...workspaces.values()],
    authenticationRequired,
    ready,
    empty,
    error,
    projectsPage,
  };
}

function openWorkspaceIndexAction() {
  const roots = [document];
  const visited = new Set();
  const links = [];
  while (roots.length) {
    const root = roots.shift();
    if (!root || visited.has(root)) continue;
    visited.add(root);
    links.push(...root.querySelectorAll('a[href]'));
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
  }
  const projectControl = links.find((node) => {
    try {
      const url = new URL(node.getAttribute('href') || node.href || '', location.href);
      return url.pathname === '/library' && url.searchParams.get('tab') === 'projects';
    } catch {}
    return false;
  });
  if (projectControl && !projectControl.disabled && projectControl.getAttribute('aria-disabled') !== 'true') {
    projectControl.click();
    return { activated: true, renderedControl: true };
  }
  return { activated: false, renderedControl: false };
}

function navigateChatGPTRouteAction(input) {
  const target = new URL(input.url, location.href);
  if (target.origin !== location.origin) return { activated: false, renderedControl: false };
  const route = `${target.pathname}${target.search}${target.hash}`;
  if (`${location.pathname}${location.search}${location.hash}` === route) {
    return { activated: true, renderedControl: false, unchanged: true };
  }

  if (!input.localRouteOnly) {
    const roots = [document];
    const visited = new Set();
    while (roots.length) {
      const root = roots.shift();
      if (!root || visited.has(root)) continue;
      visited.add(root);
      for (const link of root.querySelectorAll('a[href]')) {
        try {
          const url = new URL(link.getAttribute('href') || link.href || '', location.href);
          if (url.origin !== target.origin
            || `${url.pathname}${url.search}${url.hash}` !== route
            || link.getAttribute('aria-disabled') === 'true') continue;
          link.click();
          return { activated: true, renderedControl: true, unchanged: false };
        } catch {}
      }
      for (const element of root.querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }

  // ChatGPT's router observes same-document history transitions. Keep the
  // authenticated WebContents alive instead of replacing its document.
  try {
    history.pushState(history.state, '', route);
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    return { activated: true, renderedControl: false, unchanged: false };
  } catch {
    return { activated: false, renderedControl: false, unchanged: false };
  }
}

function startNewChatAction(input) {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = (node) => {
    const bounds = node?.getBoundingClientRect?.();
    return !bounds || (bounds.width > 0 && bounds.height > 0);
  };
  const workspaceId = String(input?.workspaceId || '').trim();
  const controls = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"]')]
    .filter((node) => visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true');
  const label = (node) => normalize([
    node.textContent,
    node.getAttribute('aria-label'),
    node.getAttribute('title'),
    node.getAttribute('data-testid'),
  ].filter(Boolean).join(' '));
  const routeOf = (node) => {
    try {
      const href = node.getAttribute('href') || node.href || '';
      return new URL(href, location.href);
    } catch {
      return null;
    }
  };
  const workspaceLink = workspaceId
    ? controls.find((node) => {
      const route = routeOf(node);
      if (!route || route.origin !== location.origin) return false;
      const escaped = workspaceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`^/g/${escaped}(?:-[^/]+)?(?:/project)?/?$`, 'i').test(route.pathname);
    })
    : null;
  const currentIsTarget = workspaceId
    ? new RegExp(`^/g/${workspaceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-[^/]+)?(?:/project)?/?$`, 'i')
      .test(location.pathname)
    : location.pathname === '/';
  const routeMatchesWorkspace = (route) => {
    if (!workspaceId) return route.pathname === '/';
    const escaped = workspaceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^/g/${escaped}(?:-[^/]+)?(?:/project)?/?$`, 'i').test(route.pathname);
  };
  if (workspaceLink && !currentIsTarget) {
    workspaceLink.click();
    return { activated: true, action: 'workspace-route' };
  }
  const newChat = controls.find((node) => /^(?:new chat|new conversation|start a new chat)$/i.test(label(node))
    || /\bnew chat\b/i.test(label(node)));
  if (newChat) {
    newChat.click();
    return { activated: true, action: 'new-chat' };
  }
  const targetLink = controls.find((node) => {
    const route = routeOf(node);
    if (!route || route.origin !== location.origin) return false;
    if (workspaceId) return currentIsTarget && routeMatchesWorkspace(route);
    return route.pathname === '/' && !/\/c\//i.test(route.pathname);
  });
  if (targetLink) {
    targetLink.click();
    return { activated: true, action: 'new-chat-route' };
  }
  return { activated: false, action: null };
}

function advanceWorkspaceIndexAction() {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = (node) => {
    const bounds = node?.getBoundingClientRect?.();
    return !bounds || (bounds.width > 0 && bounds.height > 0);
  };
  const controls = [...document.querySelectorAll('button, [role="button"], a')];
  const retry = controls.find((node) => visible(node) && /^retry$/i.test(normalize([
    node.textContent, node.getAttribute('aria-label'), node.getAttribute('title'),
  ].filter(Boolean).join(' '))));
  if (retry && !retry.disabled && retry.getAttribute('aria-disabled') !== 'true') {
    retry.click();
    return { acted: true, action: 'retry' };
  }
  const more = controls.find((node) => visible(node) && /^(?:show more|load more|more projects)$/i.test(normalize([
    node.textContent, node.getAttribute('aria-label'), node.getAttribute('title'),
  ].filter(Boolean).join(' '))));
  if (more && !more.disabled && more.getAttribute('aria-disabled') !== 'true') {
    more.click();
    return { acted: true, action: 'more' };
  }
  const scroller = document.scrollingElement || document.documentElement;
  if (scroller && scroller.scrollHeight > scroller.scrollTop + scroller.clientHeight + 2) {
    scroller.scrollTo?.({ top: scroller.scrollHeight, behavior: 'instant' });
    if (!scroller.scrollTo) scroller.scrollTop = scroller.scrollHeight;
    return { acted: true, action: 'scroll' };
  }
  return { acted: false, action: null };
}

function openCreateWorkspaceAction() {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = (node) => {
    const bounds = node?.getBoundingClientRect?.();
    return !bounds || (bounds.width > 0 && bounds.height > 0);
  };
  const controls = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"]')];
  const label = (node) => normalize([
    node.textContent, node.getAttribute('aria-label'), node.getAttribute('title'),
  ].filter(Boolean).join(' '));
  const exact = controls.find((node) => visible(node) && /^(?:new project|create project)$/i.test(label(node)));
  const menuProject = controls.find((node) => visible(node) && /^project$/i.test(label(node))
    && Boolean(node.closest('[role="menu"], [data-radix-menu-content], [data-headlessui-state]')));
  const projectsPageNew = controls.find((node) => visible(node) && /^new$/i.test(label(node))
    && /projects/i.test(normalize(node.closest('main, [role="main"]')?.textContent || document.body?.textContent)));
  const control = exact || menuProject || projectsPageNew;
  if (!control || control.disabled || control.getAttribute('aria-disabled') === 'true') return false;
  control.click();
  return true;
}

function submitCreateWorkspaceAction(input) {
  const name = String(input.name || '').trim();
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = (node) => {
    const bounds = node?.getBoundingClientRect?.();
    return !bounds || (bounds.width > 0 && bounds.height > 0);
  };
  const signIn = [...document.querySelectorAll('button, a')].some((node) => (
    /^(?:log in|sign in)(?:\s|$)/i.test(normalize(node.textContent || node.getAttribute('aria-label')))
  ));
  if (signIn) return { ready: false, submitted: false, authenticationRequired: true, error: null };
  const dialog = [...document.querySelectorAll('[role="dialog"], dialog')].find((node) => visible(node));
  if (!dialog) return { ready: false, submitted: false, authenticationRequired: false, error: null };
  const labels = [...dialog.querySelectorAll('label')];
  const nameLabel = labels.find((label) => /project name/i.test(normalize(label.textContent)));
  let inputElement = nameLabel?.htmlFor ? document.getElementById(nameLabel.htmlFor) : null;
  inputElement ||= nameLabel?.querySelector('input, textarea') || null;
  inputElement ||= [...dialog.querySelectorAll('input, textarea')].find((node) => /project name/i.test(normalize([
    node.getAttribute('aria-label'), node.name, node.id,
  ].filter(Boolean).join(' ')))) || null;
  inputElement ||= [...dialog.querySelectorAll('input, textarea')].find((node) => visible(node) && !node.disabled) || null;
  if (!inputElement) return { ready: false, submitted: false, authenticationRequired: false, error: null };
  if (inputElement.value !== name) {
    inputElement.focus();
    const prototype = inputElement instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(inputElement, name);
    inputElement.dispatchEvent(new Event('input', { bubbles: true }));
    inputElement.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const error = [...dialog.querySelectorAll('[role="alert"], [data-testid*="error" i]')]
    .map((node) => normalize(node.textContent)).find(Boolean) || null;
  const submit = [...dialog.querySelectorAll('button, [role="button"]')].find((node) => (
    /^(?:create|create project|save)$/i.test(normalize(node.textContent || node.getAttribute('aria-label')))
      && visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true'
  ));
  submit?.click();
  return {
    ready: true,
    submitted: Boolean(submit),
    authenticationRequired: false,
    error,
  };
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
    picker.style.cssText = 'display:inline-flex;position:fixed;z-index:2147483646;align-items:center;min-width:0;vertical-align:middle;';
    const shadow = picker.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>:host{display:inline-flex;align-items:center;color:var(--text-primary,#f4f4f4);font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button{display:inline-flex;min-height:32px;align-items:center;gap:4px;padding:0 8px;border:0;border-radius:8px;color:inherit;background:transparent;font:400 14px/20px inherit;white-space:nowrap;cursor:pointer}button:hover,button[aria-expanded="true"]{background:var(--surface-hover,var(--main-surface-secondary,rgba(255,255,255,.08)))}</style><button type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Patchwork model and reasoning"><span></span><span aria-hidden="true">⌄</span></button>';
    document.body.append(picker);

    menu = document.createElement('patchwork-ai-chat-configuration-menu');
    menu.id = menuId;
    menu.hidden = true;
    menu.style.cssText = 'position:fixed;z-index:2147483647;width:250px;padding:6px;border:1px solid #ffffff1f;border-radius:14px;background:#212121;color:#f4f4f4;box-shadow:0 14px 36px #0007;font:14px/20px ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
    menu.innerHTML = '<div data-heading>Model</div><button data-model="sol">GPT-5.6 Sol</button><button data-model="luna">GPT-5.6 Luna</button><hr><div data-heading>Thinking</div><button data-reasoning="default">Model default</button><button data-reasoning="instant">Instant</button><button data-reasoning="low">Low</button><button data-reasoning="medium">Medium</button><button data-reasoning="high">High</button><button data-reasoning="extra-high">Extra High</button><style>#patchwork-ai-chat-configuration-menu{box-sizing:border-box}#patchwork-ai-chat-configuration-menu>button{display:flex;width:100%;justify-content:space-between;padding:9px 10px;border:0;border-radius:9px;color:inherit;background:transparent;font:inherit;text-align:left;cursor:pointer}#patchwork-ai-chat-configuration-menu>button:hover,#patchwork-ai-chat-configuration-menu>button[aria-checked="true"]{background:#2f2f2f}#patchwork-ai-chat-configuration-menu>button[aria-checked="true"]::after{content:"✓";margin-left:16px;font-size:14px}#patchwork-ai-chat-configuration-menu>[data-heading]{padding:7px 10px 5px;color:#aaa;font-size:12px;font-weight:600}#patchwork-ai-chat-configuration-menu>hr{height:1px;margin:5px 4px;border:0;background:#ffffff1f}</style>';
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
  const readableText = (element) => String(element?.innerText || element?.textContent || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const roleFromValue = (value) => {
    const normalized = String(value || '').toLowerCase();
    if (/\b(?:assistant|chatgpt|model|completion|response)\b/.test(normalized)) return 'assistant';
    if (/\b(?:user|human|prompt|you)\b/.test(normalized)) return 'user';
    if (/\bsystem\b/.test(normalized)) return 'system';
    return null;
  };
  const roleFromElement = (element) => roleFromValue([
    element.getAttribute?.('data-message-author-role'),
    element.getAttribute?.('data-role'),
    element.getAttribute?.('data-author'),
    element.getAttribute?.('aria-label'),
    element.getAttribute?.('data-testid'),
  ].filter(Boolean).join(' '));
  const roots = [document];
  const visitedRoots = new Set();
  while (roots.length) {
    const root = roots.shift();
    if (!root || visitedRoots.has(root)) continue;
    visitedRoots.add(root);
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
  }
  const queryAll = (selector) => [...visitedRoots].flatMap((root) => [...root.querySelectorAll(selector)]);
  const primary = queryAll('[data-message-author-role]');
  const fallback = queryAll(
    '[data-message-id], [data-testid*="conversation-turn" i], article[data-testid*="turn" i], [data-role], [data-author]',
  );
  const collect = (candidates) => {
    const messages = [];
    const seen = new Set();
    for (const [index, element] of candidates.entries()) {
      const role = roleFromElement(element)
        || roleFromElement(element.querySelector?.('[data-message-author-role], [data-role], [data-author]'));
      if (!role || element.parentElement?.closest?.('[data-message-author-role]')) continue;
      const content = readableText(element);
      if (!content) continue;
      const id = element.getAttribute('data-message-id')
        || element.getAttribute('data-testid')
        || `${role}-${index}`;
      if (seen.has(id)) continue;
      seen.add(id);
      messages.push({ id, role, content });
    }
    return messages;
  };
  const messages = collect(primary);
  if (messages.length === 0) messages.push(...collect(fallback));
  const thinking = [...document.querySelectorAll('[data-testid*="reasoning" i], details')]
    .map(readableText)
    .find(Boolean) || null;
  const attachments = [...document.querySelectorAll('[data-testid*="attachment" i], [class*="attachment" i]')]
    .map((element) => readableText(element) || String(element.getAttribute('aria-label') || '').trim())
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
    const control = (match.matches('a[download], button[aria-label*="download" i], [role="button"][aria-label*="download" i]')
      ? match
      : null)
      || container?.querySelector('a[download], button[aria-label*="download" i], [role="button"][aria-label*="download" i]')
      || (match.matches('a[href], button, [role="button"]') ? match : null)
      || match.closest('a[href], button, [role="button"]');
    if (!control || control.disabled || control.getAttribute('aria-disabled') === 'true') continue;
    control.click();
    return true;
  }
  return false;
}

class ChatGPTBrowserDriver {
  constructor(webContents, options = {}) {
    if (!webContents) throw new TypeError('ChatGPTBrowserDriver requires Electron webContents.');
    this.webContents = webContents;
    this.onWorkspaceStatus = typeof options.onWorkspaceStatus === 'function'
      ? options.onWorkspaceStatus
      : () => {};
    this.onChatSnapshot = typeof options.onChatSnapshot === 'function'
      ? options.onChatSnapshot
      : null;
    if (this.onChatSnapshot) {
      this.chatSnapshotHandler = (_event, payload) => {
        if (_event?.sender !== this.webContents || !payload || typeof payload !== 'object') return;
        try {
          this.onChatSnapshot(payload);
        } catch {}
      };
      ipcMain.on(CHAT_DOM_SNAPSHOT_CHANNEL, this.chatSnapshotHandler);
      this.webContents.once?.('destroyed', () => {
        ipcMain.removeListener(CHAT_DOM_SNAPSHOT_CHANNEL, this.chatSnapshotHandler);
      });
    }
  }

  hasComposer() { return this.#execute(hasComposerAction, { composerSelector: COMPOSER_SELECTOR }); }

  readSessionState() { return this.#execute(readSessionStateAction, { composerSelector: COMPOSER_SELECTOR }); }

  dismissBlockingNotice() {
    return this.#execute(dismissBlockingNoticeAction, {
      noticePattern: DISMISSIBLE_LIMIT_NOTICE.source,
      actionPattern: DISMISSIVE_NOTICE_ACTION.source,
    });
  }

  async navigate(url) {
    const target = new URL(String(url || ''), CHATGPT_HOME_URL);
    if (target.protocol !== 'https:' || target.hostname !== 'chatgpt.com') {
      throw new Error('The browser route must stay on ChatGPT.');
    }
    const currentUrl = String(this.webContents.getURL?.() || '');
    if (!currentUrl || currentUrl === 'about:blank') {
      await this.#loadBrowserSurface(CHATGPT_HOME_URL);
    } else if (!isChatGPTBrowserUrl(currentUrl)) {
      throw new Error('The persistent browser is outside ChatGPT. Restore the ChatGPT session before retrying.');
    }
    const route = `${target.pathname}${target.search}${target.hash}`;
    const current = new URL(String(this.webContents.getURL?.() || CHATGPT_HOME_URL));
    if (`${current.pathname}${current.search}${current.hash}` === route) return true;

    const switchingConversation = /\/c\/[0-9a-f-]{36}\/?$/i.test(target.pathname);
    const previousSnapshot = switchingConversation
      ? await this.readChatSnapshot().catch(() => null)
      : null;
    const snapshotFingerprint = (snapshot) => (snapshot?.messages || [])
      .map((message) => `${message.role}:${message.id}:${message.content}`)
      .join('\n');
    const previousFingerprint = snapshotFingerprint(previousSnapshot);

    let documentNavigationBlocked = false;
    const preventDocumentNavigation = (event) => {
      documentNavigationBlocked = true;
      event.preventDefault?.();
    };
    this.webContents.on?.('will-navigate', preventDocumentNavigation);
    let navigation;
    try {
      navigation = await this.#execute(
        navigateChatGPTRouteAction,
        { url: target.toString(), localRouteOnly: false },
      );
      await delay(50);
    } finally {
      this.webContents.removeListener?.('will-navigate', preventDocumentNavigation);
    }
    if (documentNavigationBlocked) {
      navigation = await this.#execute(
        navigateChatGPTRouteAction,
        { url: target.toString(), localRouteOnly: true },
      );
    }
    if (!navigation?.activated) {
      throw new Error('ChatGPT did not accept the in-app route change. Patchwork did not reload the browser.');
    }

    const routeMatches = () => {
      const active = new URL(String(this.webContents.getURL?.() || CHATGPT_HOME_URL));
      return `${active.pathname}${active.search}${active.hash}` === route;
    };
    const waitForRoute = async (milliseconds) => {
      const deadline = Date.now() + milliseconds;
      while (Date.now() < deadline) {
        if (routeMatches()) return true;
        await delay(50);
      }
      return routeMatches();
    };

    let reachedRoute = await waitForRoute(navigation.renderedControl ? 750 : BROWSER_ACTION_TIMEOUT_MILLISECONDS);
    if (!reachedRoute && navigation.renderedControl) {
      navigation = await this.#execute(
        navigateChatGPTRouteAction,
        { url: target.toString(), localRouteOnly: true },
      );
      if (navigation?.activated) reachedRoute = await waitForRoute(BROWSER_ACTION_TIMEOUT_MILLISECONDS);
    }
    if (!reachedRoute) throw new Error('ChatGPT did not finish the in-app route change.');

    if (switchingConversation) {
      const renderDeadline = Date.now() + BROWSER_ACTION_TIMEOUT_MILLISECONDS;
      while (Date.now() < renderDeadline) {
        const snapshot = await this.readChatSnapshot().catch(() => null);
        const fingerprint = snapshotFingerprint(snapshot);
        if (fingerprint && fingerprint !== previousFingerprint) return true;
        await delay(100);
      }
      throw new Error('ChatGPT changed conversations, but the target transcript did not finish rendering.');
    }

    // Give the app router one render turn before composer automation begins.
    await delay(100);
    return true;
  }

  async startNewChat(workspaceId = null) {
    const normalizedWorkspaceId = String(workspaceId || '').trim() || null;
    if (normalizedWorkspaceId && !/^g-p-[A-Za-z0-9_-]+$/.test(normalizedWorkspaceId)) {
      throw new Error('The ChatGPT project ID is invalid.');
    }
    const target = normalizedWorkspaceId
      ? `${CHATGPT_HOME_URL}g/${normalizedWorkspaceId}/project`
      : CHATGPT_HOME_URL;
    const currentUrl = String(this.webContents.getURL?.() || '');
    if (!currentUrl || currentUrl === 'about:blank') await this.#loadBrowserSurface(CHATGPT_HOME_URL);
    else if (!isChatGPTBrowserUrl(currentUrl)) {
      throw new Error('The persistent browser is outside ChatGPT. Restore the ChatGPT session before retrying.');
    }

    const previousConversationId = conversationIdFromBrowserUrl(this.webContents.getURL?.());
    const deadline = Date.now() + BROWSER_ACTION_TIMEOUT_MILLISECONDS;
    while (Date.now() < deadline) {
      const state = await this.#execute(startNewChatAction, { workspaceId: normalizedWorkspaceId });
      await delay(state?.action === 'new-chat' ? 75 : 125);
      const activeUrl = String(this.webContents.getURL?.() || '');
      const activeConversationId = conversationIdFromBrowserUrl(activeUrl);
      if (!activeConversationId && workspaceRouteMatches(activeUrl, normalizedWorkspaceId)) {
        return { activated: true, action: state?.action || 'already-new-chat', url: activeUrl };
      }
      if (!state?.activated) await delay(125);
      // A page-side click can update location asynchronously. Continue giving
      // ChatGPT's router time to clear the old conversation before falling
      // back to a document navigation below.
      if (previousConversationId && activeConversationId !== previousConversationId && !activeConversationId) {
        return { activated: true, action: state?.action || 'new-chat', url: activeUrl };
      }
    }

    // A stale SPA route is worse than a short recovery load: accepting the
    // old /c/<id> would silently append the next message to the wrong chat.
    await this.#loadBrowserSurface(target);
    const activeUrl = String(this.webContents.getURL?.() || target);
    if (conversationIdFromBrowserUrl(activeUrl) || !workspaceRouteMatches(activeUrl, normalizedWorkspaceId)) {
      throw new Error('ChatGPT did not open a fresh chat. The existing conversation was left unchanged.');
    }
    return { activated: true, action: 'document-recovery', url: activeUrl };
  }

  async listWorkspaces() {
    let browserCapture = null;
    let captureError = null;
    let initialState = null;
    try {
      await this.#reportWorkspaceStatus('Checking the shared embedded ChatGPT browser…');
      // Reuse the one persistent ChatGPT document and authenticated session.
      // A newly-created hidden browser starts at about:blank and needs one real
      // document before Chromium observation is available.
      const currentUrl = String(this.webContents.getURL?.() || '');
      if (!currentUrl || currentUrl === 'about:blank') {
        await this.#loadBrowserSurface(CHATGPT_HOME_URL);
      } else if (!isChatGPTBrowserUrl(currentUrl)) {
        return {
          ok: false,
          workspaces: [],
          authenticationRequired: false,
          message: 'The shared ChatGPT browser is outside ChatGPT. Restore the embedded session and retry.',
        };
      }
      initialState = await this.#executeWorkspaceAction(readWorkspaceIndexAction, {}, 'reading projects');
    } catch (error) {
      return {
        ok: false,
        workspaces: [],
        authenticationRequired: false,
        message: String(error?.message || error || 'The projects page could not be opened.').slice(0, 240),
      };
    }
    if (initialState?.authenticationRequired) {
      return { ok: false, workspaces: [], authenticationRequired: true, message: null };
    }
    if (!(initialState?.projectsPage && initialState?.ready)) {
      try {
        browserCapture = await this.#startWorkspaceNetworkCapture();
      } catch (error) {
        // Response observation is an enhancement, never a prerequisite. The
        // rendered Projects library remains the browser-only fallback.
        captureError = error;
        await browserCapture?.dispose().catch(() => {});
        browserCapture = null;
      }
      if (!initialState?.projectsPage) {
        let activated = false;
        let documentNavigationBlocked = false;
        await this.#reportWorkspaceStatus('Waiting for ChatGPT’s Projects control…');
        for (let attempt = 0; attempt < WORKSPACE_NAVIGATION_WAIT_ATTEMPTS; attempt += 1) {
          const preventDocumentNavigation = (event) => {
            documentNavigationBlocked = true;
            event.preventDefault?.();
          };
          this.webContents.on?.('will-navigate', preventDocumentNavigation);
          try {
            const navigation = await this.#executeWorkspaceAction(
              openWorkspaceIndexAction,
              {},
              'opening projects',
            );
            activated = Boolean(navigation?.activated);
            await delay(50);
          } catch (error) {
            captureError ||= error;
          } finally {
            this.webContents.removeListener?.('will-navigate', preventDocumentNavigation);
          }
          if (activated || documentNavigationBlocked) break;
          await delay(200);
        }
        if (activated && !documentNavigationBlocked) {
          await this.#reportWorkspaceStatus('Opening Projects inside ChatGPT…');
          // Clicking a control is not proof of navigation. Wait until the
          // shared browser itself reports the canonical Projects route.
          activated = false;
          for (let attempt = 0; attempt < 12; attempt += 1) {
            const routeState = await this.#executeWorkspaceAction(
              readWorkspaceIndexAction,
              {},
              'confirming the Projects route',
            );
            if (routeState?.authenticationRequired) {
              await browserCapture?.dispose().catch(() => {});
              return { ok: false, workspaces: [], authenticationRequired: true, message: null };
            }
            if (routeState?.projectsPage) {
              initialState = routeState;
              activated = true;
              break;
            }
            await delay(100);
          }
        }
        if (!activated || documentNavigationBlocked) {
          // Raw history mutation does not activate ChatGPT's private router.
          // Make the reliable document-navigation fallback explicit to the
          // native UI before using it as recovery.
          await this.#reportWorkspaceStatus(
            'Recovery: loading Projects as a new page in the shared ChatGPT browser…',
            true,
          );
          try {
            await this.#loadBrowserSurface(CHATGPT_PROJECTS_URL);
          } catch (error) {
            await browserCapture?.dispose().catch(() => {});
            return {
              ok: false,
              workspaces: [],
              authenticationRequired: false,
              message: String(error?.message || error || 'The Projects recovery navigation failed.').slice(0, 240),
            };
          }
        }
      }
    }
    await this.#reportWorkspaceStatus('Reading projects rendered by ChatGPT…');
    const workspaces = new Map();
    let ready = false;
    let unchangedReads = 0;
    let previousCount = -1;
    try {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const state = await this.#executeWorkspaceAction(readWorkspaceIndexAction, {}, 'reading projects');
        if (state?.authenticationRequired) {
          return { ok: false, workspaces: [], authenticationRequired: true, message: null };
        }
        if (!state?.projectsPage) {
          await delay(250);
          continue;
        }
        for (const workspace of [
          ...(browserCapture?.workspaces.values() || []),
          ...(state?.workspaces || []),
        ]) {
          const id = String(workspace?.id || '');
          const name = String(workspace?.name || '').trim();
          if (/^g-p-[A-Za-z0-9_-]+$/.test(id) && name) workspaces.set(id, { id, name });
        }
        ready ||= Boolean(state?.ready) || workspaces.size > 0;
        if (state?.error) {
          const recovery = await this.#executeWorkspaceAction(
            advanceWorkspaceIndexAction,
            {},
            'recovering the projects page',
          );
          if (!recovery?.acted) {
            return {
              ok: false,
              workspaces: [...workspaces.values()],
              authenticationRequired: false,
              message: state.error,
            };
          }
          await delay(300);
          continue;
        }
        const advance = await this.#executeWorkspaceAction(
          advanceWorkspaceIndexAction,
          {},
          'advancing the projects page',
        );
        unchangedReads = workspaces.size === previousCount ? unchangedReads + 1 : 0;
        previousCount = workspaces.size;
        const requiredUnchangedReads = workspaces.size === 0 && !state?.empty ? 8 : 2;
        if (ready && !advance?.acted && unchangedReads >= requiredUnchangedReads) {
          return {
            ok: true,
            workspaces: [...workspaces.values()],
            authenticationRequired: false,
            message: null,
          };
        }
        await delay(advance?.acted || requiredUnchangedReads > 2 ? 250 : 100);
      }
      return ready
        ? { ok: true, workspaces: [...workspaces.values()], authenticationRequired: false, message: null }
        : {
          ok: false,
          workspaces: [],
          authenticationRequired: false,
          message: captureError
            ? `ChatGPT did not render Projects after navigation. ${String(captureError?.message || captureError).slice(0, 160)}`
            : 'ChatGPT did not render Projects after navigation.',
        };
    } finally {
      await browserCapture?.dispose().catch(() => {});
    }
  }

  async createWorkspace(name) {
    const projectName = String(name || '').trim();
    if (!projectName) {
      return {
        ok: false,
        workspace: null,
        authenticationRequired: false,
        message: 'Enter a project name.',
      };
    }
    const projects = await this.listWorkspaces();
    if (!projects?.ok) {
      return {
        ok: false,
        workspace: null,
        authenticationRequired: Boolean(projects?.authenticationRequired),
        message: projects?.message || null,
      };
    }
    const existing = projects.workspaces?.find((workspace) => workspace.name === projectName) || null;
    if (existing) return { ok: true, workspace: existing, authenticationRequired: false, message: null };
    let submitted = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const index = await this.#executeWorkspaceAction(readWorkspaceIndexAction, {}, 'reading projects');
      if (index?.authenticationRequired) {
        return { ok: false, workspace: null, authenticationRequired: true, message: null };
      }
      await this.#executeWorkspaceAction(openCreateWorkspaceAction, {}, 'opening project creation');
      const form = await this.#executeWorkspaceAction(
        submitCreateWorkspaceAction,
        { name: projectName },
        'submitting project creation',
      );
      if (form?.authenticationRequired) {
        return { ok: false, workspace: null, authenticationRequired: true, message: null };
      }
      if (form?.error) {
        return {
          ok: false,
          workspace: null,
          authenticationRequired: false,
          message: form.error,
        };
      }
      if (form?.submitted) {
        submitted = true;
        break;
      }
      await delay(250);
    }
    if (!submitted) {
      return {
        ok: false,
        workspace: null,
        authenticationRequired: false,
        message: 'The projects page did not expose project creation.',
      };
    }
    await delay(400);
    const listed = await this.listWorkspaces();
    const workspace = listed.workspaces?.find((item) => item.name === projectName) || null;
    if (workspace) return { ok: true, workspace, authenticationRequired: false, message: null };
    return {
      ok: false,
      workspace: null,
      authenticationRequired: Boolean(listed.authenticationRequired),
      message: listed.message || 'The projects page did not confirm project creation.',
    };
  }

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

  async #startWorkspaceNetworkCapture() {
    const debuggerApi = this.webContents.debugger;
    if (!debuggerApi?.sendCommand || !debuggerApi?.on) return null;
    let attachedHere = false;
    const candidateResponses = new Set();
    const pendingReads = new Set();
    const workspaces = new Map();
    const readResponse = (requestId) => {
      const pending = this.#withTimeout(
        debuggerApi.sendCommand('Network.getResponseBody', { requestId }),
        BROWSER_ACTION_TIMEOUT_MILLISECONDS,
        'The shared ChatGPT browser timed out while reading its response cache.',
      ).then((response) => {
        for (const workspace of projectsFromBrowserResponse(response?.body, response?.base64Encoded)) {
          workspaces.set(workspace.id, workspace);
        }
      }).catch(() => {}).finally(() => pendingReads.delete(pending));
      pendingReads.add(pending);
    };
    const onDebuggerMessage = (_event, method, parameters) => {
      if (method === 'Network.responseReceived') {
        const response = parameters?.response;
        const mimeType = String(response?.mimeType || '');
        if (/json/i.test(mimeType)
          && isWorkspaceIndexResponse(response?.url)
          && parameters?.requestId) candidateResponses.add(parameters.requestId);
        return;
      }
      if (method === 'Network.loadingFinished' && candidateResponses.delete(parameters?.requestId)) {
        readResponse(parameters.requestId);
      }
    };
    try {
      if (!debuggerApi.isAttached()) {
        debuggerApi.attach('1.3');
        attachedHere = true;
      }
      debuggerApi.on('message', onDebuggerMessage);
      await this.#withTimeout(
        debuggerApi.sendCommand('Network.enable'),
        BROWSER_ACTION_TIMEOUT_MILLISECONDS,
        'The shared ChatGPT browser timed out while enabling its response cache observer.',
      );
      return {
        workspaces,
        dispose: async () => {
          debuggerApi.removeListener?.('message', onDebuggerMessage);
          await Promise.allSettled([...pendingReads]);
          if (debuggerApi.isAttached()) {
            await this.#withTimeout(
              debuggerApi.sendCommand('Network.disable'),
              BROWSER_ACTION_TIMEOUT_MILLISECONDS,
              'The shared ChatGPT browser timed out while closing its response observer.',
            ).catch(() => {});
          }
          if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
        },
      };
    } catch (error) {
      debuggerApi.removeListener?.('message', onDebuggerMessage);
      if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
      throw error;
    }
  }

  async #loadBrowserSurface(url) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error('The ChatGPT browser did not finish loading.'));
      }, BROWSER_NAVIGATION_TIMEOUT_MILLISECONDS);
    });
    try {
      await Promise.race([this.webContents.loadURL(url), timeout]);
    } catch (error) {
      this.webContents.stop?.();
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  #executeWorkspaceAction(action, input, description) {
    return this.#withTimeout(
      this.#execute(action, input),
      BROWSER_ACTION_TIMEOUT_MILLISECONDS,
      `The shared ChatGPT browser timed out while ${description}.`,
    );
  }

  async #reportWorkspaceStatus(message, recovery = false) {
    try {
      await this.onWorkspaceStatus({ message, recovery });
    } catch {}
  }

  #withTimeout(promise, milliseconds, message) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(message)), milliseconds);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
  }

  #execute(action, input = {}) {
    const source = `(${action.toString()})(${JSON.stringify(input)})`;
    return this.webContents.executeJavaScript(source, true);
  }
}

module.exports = { ChatGPTBrowserDriver };
