// ==UserScript==
// @name         ChatGPT Proxy Compatibility
// @namespace    https://github.com/patchwork/chatgpt-coder
// @version      1.0.0
// @description  Reduces corporate-proxy transformation and caching problems for ChatGPT API and SPA navigation requests.
// @match        https://chatgpt.com/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==

(() => {
  const INSTALL_KEY = '__patchworkProxyCompatibilityInstalled';
  if (window[INSTALL_KEY]) return;

  const nativeFetch = window.fetch.bind(window);
  const NativeXMLHttpRequest = window.XMLHttpRequest;
  const isChatGPTUrl = (value) => {
    try {
      const url = new URL(String(value || ''), window.location.href);
      return url.protocol === 'https:' && url.hostname === 'chatgpt.com';
    } catch {
      return false;
    }
  };
  const isSensitiveRequest = (url, headers) => {
    if (!isChatGPTUrl(url)) return false;
    const parsed = new URL(String(url), window.location.href);
    if (parsed.pathname.startsWith('/backend-api/')) return true;
    const accept = String(headers.get('accept') || '');
    return /(?:text\/html|text\/x-component)/i.test(accept);
  };
  const compatibleHeaders = (headers) => {
    const next = new Headers(headers);
    next.set('Cache-Control', 'no-transform, no-cache');
    next.set('Pragma', 'no-cache');
    return next;
  };

  window.fetch = (input, init = {}) => {
    try {
      const request = input instanceof Request ? input : null;
      const url = request?.url || input;
      const headers = new Headers(init.headers || request?.headers || undefined);
      if (!isSensitiveRequest(url, headers)) return nativeFetch(input, init);
      return nativeFetch(new Request(input, {
        ...init,
        cache: 'no-store',
        headers: compatibleHeaders(headers),
      }));
    } catch {
      return nativeFetch(input, init);
    }
  };

  class ProxyCompatibleXMLHttpRequest extends NativeXMLHttpRequest {
    open(method, url, ...rest) {
      this.__patchworkUrl = url;
      this.__patchworkHeaders = new Map();
      return super.open(method, url, ...rest);
    }

    setRequestHeader(name, value) {
      this.__patchworkHeaders?.set(String(name).toLowerCase(), String(value));
      return super.setRequestHeader(name, value);
    }

    send(body) {
      const headers = new Headers(Object.fromEntries(this.__patchworkHeaders || []));
      if (isSensitiveRequest(this.__patchworkUrl, headers)) {
        super.setRequestHeader('Cache-Control', 'no-transform, no-cache');
        super.setRequestHeader('Pragma', 'no-cache');
      }
      return super.send(body);
    }
  }

  window.fetch = window.fetch.bind(window);
  window.XMLHttpRequest = ProxyCompatibleXMLHttpRequest;
  window[INSTALL_KEY] = true;
  console.info('[Patchwork] ChatGPT proxy compatibility enabled at document-start.');
})();
