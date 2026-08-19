const styles = require('./styles.css');
const {
  clear, h, replace, svg,
} = require('./dom');

const HOST_ID = 'patchwork-root';
const WIDTH_KEY = 'patchwork.dock-width';
const OPEN_KEY = 'patchwork.dock-open';
const LAYOUT_KEY = 'patchwork.dock-layout';

// Reserving room on <html> makes ChatGPT reflow into the remaining width instead
// of being covered by the dock. Applied through CSSOM so the page's style-src
// policy has no say, and reversible the moment the dock closes.
const PAGE_LAYOUT_CSS = `
html.patchwork-pushed {
  margin-right: var(--patchwork-dock-width, 0px) !important;
  width: auto !important;
  max-width: none !important;
  overflow-x: hidden !important;
}
html.patchwork-pushed body {
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

// Everything Patchwork renders lives in a shadow root, and its stylesheet is
// adopted through CSSOM rather than a <style> tag so the page's style-src CSP
// can never suppress it.
class Shell {
  constructor({ onNavigate } = {}) {
    this.onNavigate = onNavigate || (() => {});
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
      { class: 'launcher', title: 'Open Patchwork', onclick: () => this.open() },
      svg(ICONS.tasks, { size: 15 }),
      'Patchwork',
      this.launcherBadge = h('span', { class: 'badge', hidden: true }, '0'),
    );

    this.grip = h('div', { class: 'grip', title: 'Resize Patchwork' });
    this.navBar = h('nav', { class: 'nav' });
    this.viewport = h('div', { class: 'viewport', style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column', position: 'relative' } });

    this.statusDot = h('small', { class: 'field-help' }, 'Connecting…');
    this.header = h(
      'header',
      { class: 'dock-header' },
      h(
        'div',
        { class: 'brand' },
        h('div', { class: 'brand-mark' }, 'P'),
        h('div', { class: 'brand-text' }, h('strong', {}, 'Patchwork'), this.statusDot),
      ),
      h('div', { class: 'spacer' }),
      this.layoutButton = h('button', {
        class: 'icon-button',
        title: 'Dock covers the page instead',
        onclick: () => this.toggleLayoutMode(),
      }, svg(ICONS.layout, { size: 14 })),
      h('button', {
        class: 'icon-button', title: 'Toggle wide view', onclick: () => this.toggleExpanded(),
      }, svg(ICONS.expand, { size: 14 })),
      h('button', {
        class: 'icon-button', title: 'Hide Patchwork', onclick: () => this.close(),
      }, svg(ICONS.close, { size: 14 })),
    );

    this.dock = h('aside', { class: 'dock', hidden: true }, this.grip, this.header, this.navBar, this.viewport);
    this.toast = h('div', { class: 'toast', hidden: true, role: 'status' });
    this.modalHost = h('div', { class: 'modal-host' });

    this.root.append(this.launcher, this.dock, this.toast, this.modalHost);
    document.documentElement.append(this.host);

    this.layoutMode = readStorage(LAYOUT_KEY, 'push') === 'overlay' ? 'overlay' : 'push';
    this.installPageLayout();
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
    root.style.setProperty(
      '--patchwork-dock-width',
      pushed ? `${Math.round(this.dock.getBoundingClientRect().width)}px` : '0px',
    );
    root.classList.toggle('patchwork-pushed', pushed);
  }

  setLayoutMode(mode) {
    this.layoutMode = mode === 'overlay' ? 'overlay' : 'push';
    writeStorage(LAYOUT_KEY, this.layoutMode);
    this.applyPageLayout();
    this.layoutButton?.setAttribute(
      'title',
      this.layoutMode === 'push' ? 'Dock covers the page instead' : 'Dock makes room on the page',
    );
  }

  toggleLayoutMode() {
    this.setLayoutMode(this.layoutMode === 'push' ? 'overlay' : 'push');
  }

  syncTheme() {
    const update = () => {
      const dark = document.documentElement.classList.contains('dark')
        || matchMedia('(prefers-color-scheme: dark)').matches;
      this.host.classList.toggle('patchwork-light', !dark);
    };
    update();
    new MutationObserver(update).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', update);
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
        icon ? svg(ICONS[icon] || icon, { size: 13 }) : null,
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
        }, svg(ICONS.close, { size: 14 })),
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
    document.documentElement.classList.remove('patchwork-pushed');
    document.documentElement.style.removeProperty('--patchwork-dock-width');
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== this.pageSheet);
    this.host.remove();
  }
}

module.exports = {
  HOST_ID, ICONS, Shell, clear, replace,
};
