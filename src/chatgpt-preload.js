const { contextBridge } = require('electron');

contextBridge.executeInMainWorld({
  func: () => {
    const INSTALL_KEY = '__patchworkProxyCompatibilityInstalled';
    if (window[INSTALL_KEY]) return window[INSTALL_KEY];
    if (location.protocol !== 'https:' || location.hostname !== 'chatgpt.com') return false;

    const nativeFetch = window.fetch.bind(window);
    const NativeXMLHttpRequest = window.XMLHttpRequest;
    const isChatGPTUrl = (value) => {
      try {
        const url = new URL(String(value || ''), location.href);
        return url.protocol === 'https:' && url.hostname === 'chatgpt.com';
      } catch {
        return false;
      }
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
        if (!isChatGPTUrl(url)) return nativeFetch(input, init);
        const headers = compatibleHeaders(init.headers || request?.headers || undefined);
        return nativeFetch(new Request(input, {
          ...init,
          cache: 'no-store',
          headers,
        }));
      } catch {
        return nativeFetch(input, init);
      }
    };

    class ProxyCompatibleXMLHttpRequest extends NativeXMLHttpRequest {
      open(method, url, ...rest) {
        this.__patchworkUrl = url;
        return super.open(method, url, ...rest);
      }

      send(body) {
        if (isChatGPTUrl(this.__patchworkUrl)) {
          super.setRequestHeader('Cache-Control', 'no-transform, no-cache');
          super.setRequestHeader('Pragma', 'no-cache');
        }
        return super.send(body);
      }
    }

    window.fetch = window.fetch.bind(window);
    window.XMLHttpRequest = ProxyCompatibleXMLHttpRequest;
    window[INSTALL_KEY] = Object.freeze({ version: '2.0.0', installedAt: Date.now() });
    console.info('[Patchwork] ChatGPT proxy compatibility enabled at document-start.');
    return window[INSTALL_KEY];
  },
});
