// A deliberately small DOM good enough for Patchwork's in-page heuristics:
// deep querying through shadow roots, attribute and class selectors, closest(),
// textContent, and click/dispatch bookkeeping. It exists so the composer,
// attachment, and notice logic stay covered without pulling in a full DOM
// implementation.

const SELECTOR_PATTERN = /^([a-zA-Z*]*)((?:[#.][\w-]+|\[[^\]]+\])*)$/;

function parseSimpleSelector(selector) {
  const match = SELECTOR_PATTERN.exec(selector.trim());
  if (!match) throw new Error(`dom-stub cannot parse selector: ${selector}`);
  const [, tag, rest] = match;
  const conditions = [];
  const parts = rest.match(/[#.][\w-]+|\[[^\]]+\]/g) || [];
  for (const part of parts) {
    if (part.startsWith('#')) conditions.push((element) => element.getAttribute('id') === part.slice(1));
    else if (part.startsWith('.')) conditions.push((element) => element.classList.has(part.slice(1)));
    else {
      const body = part.slice(1, -1);
      const attribute = /^([\w-]+)(?:([*^$]?=)"?([^"\]]*)"?)?$/.exec(body);
      if (!attribute) throw new Error(`dom-stub cannot parse attribute selector: ${part}`);
      const [, name, operator, value] = attribute;
      conditions.push((element) => {
        const actual = element.getAttribute(name);
        if (actual == null) return false;
        if (!operator) return true;
        if (operator === '=') return actual === value;
        if (operator === '*=') return actual.includes(value);
        if (operator === '^=') return actual.startsWith(value);
        return actual.endsWith(value);
      });
    }
  }
  return (element) => {
    if (tag && tag !== '*' && element.tagName !== tag.toUpperCase()) return false;
    return conditions.every((condition) => condition(element));
  };
}

function compileSelector(selector) {
  const matchers = String(selector).split(',').map((part) => parseSimpleSelector(part));
  return (element) => matchers.some((matcher) => matcher(element));
}

class StubElement {
  constructor(tag, attributes = {}, children = []) {
    this.tagName = String(tag).toUpperCase();
    this.attributes = new Map(Object.entries(attributes).filter(([, value]) => value != null)
      .map(([key, value]) => [key, String(value)]));
    this.children = [];
    this.parentElement = null;
    this.shadowRoot = null;
    this.text = '';
    this.files = [];
    this.disabled = false;
    this.clicks = 0;
    this.events = [];
    this.bounds = { width: 100, height: 20 };
    this.styles = { display: 'block', visibility: 'visible' };
    for (const child of children) this.append(child);
  }

  get classList() {
    return new Set(String(this.attributes.get('class') || '').split(/\s+/).filter(Boolean));
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
    return this;
  }

  attachShadow() {
    this.shadowRoot = new StubRoot();
    return this.shadowRoot;
  }

  getAttribute(name) {
    if (name === 'id' && this.attributes.has('id')) return this.attributes.get('id');
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  get textContent() {
    return [this.text, ...this.children.map((child) => child.textContent)].filter(Boolean).join(' ');
  }

  set textContent(value) {
    this.text = String(value);
    this.children = [];
  }

  descendants() {
    const found = [];
    for (const child of this.children) {
      found.push(child, ...child.descendants());
    }
    return found;
  }

  querySelectorAll(selector) {
    const matches = compileSelector(selector);
    return this.descendants().filter(matches);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  matches(selector) {
    return compileSelector(selector)(this);
  }

  closest(selector) {
    const matches = compileSelector(selector);
    let node = this;
    while (node) {
      if (matches(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  getBoundingClientRect() {
    return { ...this.bounds };
  }

  scrollIntoView() {}

  click() {
    this.clicks += 1;
  }

  dispatchEvent(event) {
    this.events.push(event?.type || String(event));
    return true;
  }

  addEventListener() {}
}

class StubRoot extends StubElement {
  constructor(children = []) {
    super('#root', {}, children);
    this.tagName = '#ROOT';
  }
}

function element(tag, attributes, children) {
  return new StubElement(tag, attributes, children);
}

function text(tag, value, attributes = {}) {
  const node = new StubElement(tag, attributes);
  node.textContent = value;
  return node;
}

// Installs the globals the in-page modules read. Returns a restore function.
function installDocument(root) {
  const previous = {
    document: global.document,
    getComputedStyle: global.getComputedStyle,
    Event: global.Event,
  };
  global.document = root;
  global.getComputedStyle = (node) => node.styles || { display: 'block', visibility: 'visible' };
  global.Event = class StubEvent {
    constructor(type) {
      this.type = type;
    }
  };
  return () => {
    global.document = previous.document;
    global.getComputedStyle = previous.getComputedStyle;
    global.Event = previous.Event;
  };
}

module.exports = {
  StubElement,
  StubRoot,
  compileSelector,
  element,
  installDocument,
  text,
};
