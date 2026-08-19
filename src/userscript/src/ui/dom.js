const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function applyAttribute(element, name, value) {
  if (value == null || value === false) return;
  if (name === 'class') {
    element.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
    return;
  }
  if (name === 'dataset') {
    for (const [key, item] of Object.entries(value)) {
      if (item != null) element.dataset[key] = String(item);
    }
    return;
  }
  if (name === 'style' && typeof value === 'object') {
    Object.assign(element.style, value);
    return;
  }
  if (name.startsWith('on') && typeof value === 'function') {
    element.addEventListener(name.slice(2).toLowerCase(), value);
    return;
  }
  if (name in element && name !== 'list' && typeof value !== 'object') {
    try {
      element[name] = value;
      return;
    } catch {
      // Fall through to setAttribute for read-only properties.
    }
  }
  element.setAttribute(name, value === true ? '' : String(value));
}

function append(element, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

// A very small hyperscript. The dock never uses innerHTML with task or repository
// text, so nothing the user or ChatGPT produces can inject markup.
function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  if (attributes && (attributes instanceof Node || typeof attributes !== 'object' || Array.isArray(attributes))) {
    append(element, [attributes, ...children]);
    return element;
  }
  for (const [name, value] of Object.entries(attributes || {})) applyAttribute(element, name, value);
  append(element, children);
  return element;
}

function svg(path, { size = 16, viewBox = '0 0 24 24', strokeWidth = 1.7 } = {}) {
  const element = document.createElementNS(SVG_NAMESPACE, 'svg');
  element.setAttribute('viewBox', viewBox);
  element.setAttribute('width', String(size));
  element.setAttribute('height', String(size));
  element.setAttribute('fill', 'none');
  element.setAttribute('stroke', 'currentColor');
  element.setAttribute('stroke-width', String(strokeWidth));
  element.setAttribute('stroke-linecap', 'round');
  element.setAttribute('stroke-linejoin', 'round');
  element.setAttribute('aria-hidden', 'true');
  for (const definition of [].concat(path)) {
    const node = document.createElementNS(SVG_NAMESPACE, 'path');
    node.setAttribute('d', definition);
    element.append(node);
  }
  return element;
}

function clear(element) {
  while (element.firstChild) element.firstChild.remove();
  return element;
}

function replace(element, ...children) {
  clear(element);
  append(element, children);
  return element;
}

function option(value, label, selected = false) {
  return h('option', { value, selected }, label);
}

function formatBytes(size) {
  const bytes = Number(size) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(value = new Date()) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

function formatElapsed(startedAt, now = Date.now()) {
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return '';
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(remainder)}` : `${minutes}:${pad(remainder)}`;
}

function shortCommit(commit) {
  return String(commit || '').slice(0, 8);
}

module.exports = {
  clear,
  formatBytes,
  formatDateTime,
  formatElapsed,
  formatTime,
  h,
  option,
  replace,
  shortCommit,
  svg,
};
