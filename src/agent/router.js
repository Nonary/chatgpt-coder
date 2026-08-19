function compile(pattern) {
  const segments = pattern.split('/').filter(Boolean);
  return {
    segments,
    match(pathname) {
      const parts = pathname.split('/').filter(Boolean);
      if (parts.length !== segments.length) return null;
      const params = {};
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(parts[index]);
          continue;
        }
        if (segment !== parts[index]) return null;
      }
      return params;
    },
  };
}

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, options = {}) {
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      compiled: compile(pattern),
      handler,
      public: Boolean(options.public),
    });
    return this;
  }

  get(pattern, handler, options) { return this.add('GET', pattern, handler, options); }

  post(pattern, handler, options) { return this.add('POST', pattern, handler, options); }

  patch(pattern, handler, options) { return this.add('PATCH', pattern, handler, options); }

  delete(pattern, handler, options) { return this.add('DELETE', pattern, handler, options); }

  resolve(method, pathname) {
    let pathExists = false;
    for (const route of this.routes) {
      const params = route.compiled.match(pathname);
      if (!params) continue;
      pathExists = true;
      if (route.method === method.toUpperCase()) return { route, params };
    }
    return pathExists ? { methodNotAllowed: true } : null;
  }
}

module.exports = { Router };
