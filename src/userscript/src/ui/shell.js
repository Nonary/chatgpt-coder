const styles = require('./styles.css');
const {
  clear, h, replace, svg,
} = require('./dom');
const { observeTheme } = require('./theme');

const HOST_ID = 'patchwork-root';
const WIDTH_KEY = 'patchwork.dock-width';
const OPEN_KEY = 'patchwork.dock-open';
const LAYOUT_KEY = 'patchwork.dock-layout';

// Reserving room for the dock is not as simple as a margin on <html>: ChatGPT's
// shell is positioned against the viewport, so it ignores one entirely. Narrowing
// <body> AND giving it a transform is what works - a transformed element becomes
// the containing block for its position:fixed descendants, so ChatGPT's header,
// composer, and modals resolve against the narrowed body instead of the viewport.
//
// The dock itself is appended to <html>, outside <body>, so the transform never
// applies to it. Applied through CSSOM so the page's style-src policy has no say,
// and fully reversed the moment the dock closes.
const PAGE_LAYOUT_CSS = `
html.patchwork-pushed {
  overflow-x: hidden !important;
}
html.patchwork-pushed > body {
  width: calc(100% - var(--patchwork-dock-width, 0px)) !important;
  max-width: calc(100% - var(--patchwork-dock-width, 0px)) !important;
  min-width: 0 !important;
  margin-right: 0 !important;
  overflow-x: hidden !important;
  transform: translateZ(0) !important;
  transform-origin: top left !important;
}
/* Viewport units are measured against the window, not the narrowed body. */
html.patchwork-pushed > body .w-screen,
html.patchwork-pushed > body [style*="100vw"] {
  width: 100% !important;
  max-width: 100% !important;
}
`;

const ICONS = {
  tasks: 'M4 6h16M4 12h16M4 18h10',
  source: 'M6 3v12a3 3 0 0 0 3 3h6M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  trees: 'M12 3v18M12 9l5-4M12 15l-5-4',
  history: 'M3 12a9 9 0 1 0 3-6.7M3 4v4h4M12 7v5l3 2',
  close: 'M6 6l12 12M18 6L6 18',
  expand: 'M8 3H3v5M16 21h5v-5M21 8V3h-5M3 16v5h5',
  refresh: 'M3 12a9 9 0 0 1 15-6.7L21 8M21 12a9 9 0 0 1-15 6.7L3 16M21 3v5h-5M3 21v-5h5',
  layout: 'M3 5h18v14H3zM15 5v14',
};

function readStorage(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // A blocked localStorage only costs the remembered dock geometry.
  }
}

// Everything the panel renders lives in a shadow root, and its stylesheet is
// adopted through CSSOM rather than a <style> tag so the page's style-src CSP
// can never suppress it.
class Shell {
  constructor({ onNavigate, onPushIneffective, onCheckForUpdates } = {}) {
    this.onNavigate = onNavigate || (() => {});
    this.onPushIneffective = onPushIneffective || null;
    this.onCheckForUpdates = onCheckForUpdates || (() => {});
    this.pushWarned = false;
    this.views = new Map();
    this.navButtons = new Map();
    this.activeView = null;
    this.toastTimer = null;
    this.build();
  }

  build() {
    document.getElementById(HOST_ID)?.remove();
    this.host = h('div', { id: HOST_ID });
    this.root = this.host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(styles);
    this.root.adoptedStyleSheets = [sheet];

    this.launcher = h(
      'button',
      { class: 'launcher', title: 'Open workspace', onclick: () => this.open() },
      svg(ICONS.layout, { size: 16 }),
      'Workspace',
      this.launcherBadge = h('span', { class: 'badge', hidden: true }, '0'),
    );

    this.grip = h('div', { class: 'grip', title: 'Resize the panel' });
    this.navBar = h('nav', { class: 'nav' });
    this.viewport = h('div', { class: 'viewport', style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column', position: 'relative' } });

    this.statusDot = h('small', { class: 'field-help' }, 'Connecting…');
    this.header = h(
      'header',
      { class: 'dock-header' },
      h('div', { class: 'panel-title' }, h('strong', {}, 'Workspace'), this.statusDot),
      h('div', { class: 'spacer' }),
      this.updateButton = h('button', {
        class: 'icon-button update-button',
        title: 'Check for Patchwork updates',
        onclick: () => this.onCheckForUpdates(),
      }, svg(ICONS.refresh, { size: 18 })),
      this.layoutButton = h('button', {
        class: 'icon-button',
        title: 'Dock covers the page instead',
        onclick: () => this.toggleLayoutMode(),
      }, svg(ICONS.layout, { size: 18 })),
      h('button', {
        class: 'icon-button', title: 'Toggle wide view', onclick: () => this.toggleExpanded(),
      }, svg(ICONS.expand, { size: 18 })),
      h('button', {
        class: 'icon-button', title: 'Hide the workspace', onclick: () => this.close(),
      }, svg(ICONS.close, { size: 18 })),
    );

    this.updateNotice = h('div', { class: 'update-notice', hidden: true });

    this.dock = h(
      'aside',
      { class: 'dock', hidden: true },
      this.grip,
      this.header,
      this.updateNotice,
      this.navBar,
      this.viewport,
    );
    this.toast = h('div', { class: 'toast', hidden: true, role: 'status' });
    this.modalHost = h('div', { class: 'modal-host' });

    this.root.append(this.launcher, this.dock, this.toast, this.modalHost);
    document.documentElement.append(this.host);

    this.installPageLayout();
    this.setLayoutMode(readStorage(LAYOUT_KEY, 'push'));
    this.applyWidth(Number.parseInt(readStorage(WIDTH_KEY, '460'), 10) || 460);
    this.installResize();
    this.syncTheme();
    if (readStorage(OPEN_KEY, 'true') === 'true') this.open();
  }

  installPageLayout() {
    this.pageSheet = new CSSStyleSheet();
    this.pageSheet.replaceSync(PAGE_LAYOUT_CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.pageSheet];
  }

  applyPageLayout() {
    const root = document.documentElement;
    const pushed = this.layoutMode === 'push' && !this.dock.hidden;
    const width = pushed ? Math.round(this.dock.getBoundingClientRect().width) : 0;
    root.style.setProperty('--patchwork-dock-width', `${width}px`);
    root.classList.toggle('patchwork-pushed', pushed);
    if (pushed) requestAnimationFrame(() => this.reportPushEffect(width));
  }

  // Whether the page actually moved is a fact about ChatGPT's layout, not
  // something to assume: measure it and say so rather than leaving the dock
  // sitting on top of the conversation with no explanation.
  measurePush(width) {
    const limit = window.innerWidth - width;
    const probes = ['main', 'form', '[data-testid="composer-root"]', '#thread', 'body > div']
      .map((selector) => document.querySelector(selector))
      .filter(Boolean);
    const worst = probes.reduce((right, node) => Math.max(right, node.getBoundingClientRect().right), 0);
    return { effective: probes.length === 0 || worst <= limit + 8, worst: Math.round(worst), limit: Math.round(limit) };
  }

  reportPushEffect(width) {
    const result = this.measurePush(width);
    if (result.effective) {
      this.pushWarned = false;
      return result;
    }
    if (!this.pushWarned) {
      this.pushWarned = true;
      this.onPushIneffective?.(result);
    }
    return result;
  }

  setLayoutMode(mode) {
    this.layoutMode = mode === 'overlay' ? 'overlay' : 'push';
    writeStorage(LAYOUT_KEY, this.layoutMode);
    this.applyPageLayout();
    if (this.layoutButton) {
      const pushing = this.layoutMode === 'push';
      this.layoutButton.setAttribute(
        'title',
        pushing ? 'Making room on the page — click to overlay instead' : 'Overlaying the page — click to make room',
      );
      this.layoutButton.classList.toggle('active', pushing);
    }
  }

  toggleLayoutMode() {
    this.setLayoutMode(this.layoutMode === 'push' ? 'overlay' : 'push');
  }

  syncTheme() {
    this.stopThemeWatch = observeTheme((dark) => {
      this.host.classList.toggle('patchwork-light', !dark);
    });
  }

  applyWidth(width) {
    const clamped = Math.min(Math.max(width, 360), Math.round(window.innerWidth * 0.96));
    this.dock.style.setProperty('--dock-width', `${clamped}px`);
    writeStorage(WIDTH_KEY, clamped);
    this.applyPageLayout?.();
  }

  installResize() {
    let startX = 0;
    let startWidth = 0;
    const onMove = (event) => this.applyWidth(startWidth + (startX - event.clientX));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
    };
    this.grip.addEventListener('pointerdown', (event) => {
      startX = event.clientX;
      startWidth = this.dock.getBoundingClientRect().width;
      document.body.style.userSelect = 'none';
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  toggleExpanded() {
    this.dock.classList.toggle('expanded');
    this.applyPageLayout();
  }

  open() {
    this.dock.hidden = false;
    this.launcher.hidden = true;
    writeStorage(OPEN_KEY, 'true');
    this.applyPageLayout();
  }

  close() {
    this.dock.hidden = true;
    this.launcher.hidden = false;
    writeStorage(OPEN_KEY, 'false');
    this.applyPageLayout();
  }

  toggle() {
    if (this.dock.hidden) this.open();
    else this.close();
  }

  addView(id, { label, icon, hidden = false }) {
    const container = h('section', { class: 'view', dataset: { view: id } });
    this.viewport.append(container);
    this.views.set(id, container);
    if (!hidden) {
      const count = h('span', { class: 'count', hidden: true }, '0');
      const button = h(
        'button',
        { dataset: { view: id }, onclick: () => this.show(id) },
        icon ? svg(ICONS[icon] || icon, { size: 16 }) : null,
        label,
        count,
      );
      button.countElement = count;
      this.navBar.append(button);
      this.navButtons.set(id, button);
    }
    return container;
  }

  setCount(id, value) {
    const button = this.navButtons.get(id);
    if (!button) return;
    button.countElement.hidden = !value;
    button.countElement.textContent = String(value || 0);
  }

  show(id) {
    if (!this.views.has(id)) return;
    for (const [viewId, container] of this.views) container.classList.toggle('active', viewId === id);
    for (const [viewId, button] of this.navButtons) button.classList.toggle('active', viewId === id);
    this.activeView = id;
    this.open();
    this.onNavigate(id);
  }

  view(id) {
    return this.views.get(id);
  }

  render(id, ...children) {
    const container = this.views.get(id);
    if (container) replace(container, ...children);
    return container;
  }

  setStatus(text) {
    this.statusDot.textContent = text;
  }

  setUpdateButtonState({ checking = false, available = false, blocked = false } = {}) {
    this.updateButton.disabled = checking;
    this.updateButton.classList.toggle('checking', checking);
    this.updateButton.classList.toggle('update-available', available);
    this.updateButton.classList.toggle('blocked', blocked);
    if (checking) this.updateButton.title = 'Checking for Patchwork updates…';
    else if (available && blocked) this.updateButton.title = 'Patchwork update needs attention';
    else if (available) this.updateButton.title = 'Patchwork update available';
    else this.updateButton.title = 'Check for Patchwork updates';
  }

  setUpdateNotice(notice) {
    clear(this.updateNotice);
    if (!notice) {
      this.updateNotice.hidden = true;
      return;
    }
    this.updateNotice.hidden = false;
    this.updateNotice.classList.toggle('blocked', Boolean(notice.blocked));
    this.updateNotice.append(
      h('span', { class: 'grow' }, notice.message),
      notice.actionLabel ? h('button', {
        class: 'secondary',
        disabled: Boolean(notice.disabled),
        onclick: notice.onAction,
      }, notice.actionLabel) : null,
    );
  }

  setPendingBadge(value) {
    this.launcherBadge.hidden = !value;
    this.launcherBadge.textContent = String(value || 0);
  }

  showToast(message, isError = false) {
    clearTimeout(this.toastTimer);
    this.toast.textContent = message;
    this.toast.classList.toggle('error', Boolean(isError));
    this.toast.hidden = false;
    this.toastTimer = setTimeout(() => { this.toast.hidden = true; }, isError ? 7_000 : 4_000);
  }

  openModal(node) {
    const backdrop = h('div', {
      class: 'modal-backdrop',
      onclick: (event) => {
        if (event.target === backdrop) close();
      },
    }, node);
    const close = () => backdrop.remove();
    this.modalHost.append(backdrop);
    return { backdrop, close };
  }

  modal({
    title, body, footer, width,
  }) {
    let handle;
    const dialog = h(
      'div',
      { class: 'modal', style: width ? { width } : null },
      h(
        'div',
        { class: 'modal-header' },
        h('h2', {}, title),
        h('div', { class: 'spacer', style: { flex: '1' } }),
        h('button', {
          class: 'icon-button', title: 'Close', onclick: () => handle.close(),
        }, svg(ICONS.close, { size: 18 })),
      ),
      h('div', { class: 'modal-body' }, body),
      footer ? h('div', { class: 'modal-footer' }, footer) : null,
    );
    handle = this.openModal(dialog);
    return handle;
  }

  confirm({
    title, message, confirmLabel = 'Confirm', danger = false,
  }) {
    return new Promise((resolve) => {
      let handle;
      const answer = (value) => {
        handle.close();
        resolve(value);
      };
      handle = this.modal({
        title,
        width: '440px',
        body: h('p', { class: 'muted', style: { margin: '0' } }, message),
        footer: [
          h('div', { class: 'spacer' }),
          h('button', { class: 'secondary', onclick: () => answer(false) }, 'Cancel'),
          h('button', { class: danger ? 'danger' : 'primary', onclick: () => answer(true) }, confirmLabel),
        ],
      });
      handle.backdrop.addEventListener('click', (event) => {
        if (event.target === handle.backdrop) resolve(false);
      });
    });
  }

  destroy() {
    this.stopThemeWatch?.();
    document.documentElement.classList.remove('patchwork-pushed');
    document.documentElement.style.removeProperty('--patchwork-dock-width');
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== this.pageSheet);
    this.host.remove();
  }
}

module.exports = {
  HOST_ID, ICONS, Shell, clear, replace,
};
