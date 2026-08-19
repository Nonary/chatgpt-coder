const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const http = require('node:http');
const { createContext } = require('./context');
const {
  applyCors, readBody, requestToken, sendJson, timingSafeEquals,
} = require('./http');
const install = require('./install');
const { createRouter } = require('./routes');

const JSON_METHODS = new Set(['POST', 'PATCH', 'DELETE']);
const RAW_BODY_ROUTES = [/^\/v1\/uploads$/, /^\/v1\/tasks\/[^/]+\/result$/, /^\/v1\/trees\/[^/]+\/merge-result$/];

function wantsRawBody(pathname, contentType) {
  if (!RAW_BODY_ROUTES.some((pattern) => pattern.test(pathname))) return false;
  return !String(contentType || '').includes('application/json');
}

async function sendFile(response, filePath, contentType, filename) {
  const stat = await fs.stat(filePath);
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${String(filename || 'download').replace(/"/g, '')}"`,
  });
  await new Promise((resolve, reject) => {
    const stream = fsSync.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(response);
  });
  return null;
}

async function createServer(config) {
  const context = await createContext(config);
  const router = createRouter(context);
  install.register(router, context);

  const server = http.createServer(async (request, response) => {
    let url;
    try {
      url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    } catch {
      sendJson(response, 400, { error: 'Malformed request URL.' });
      return;
    }

    applyCors(request, response);
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    const match = router.resolve(request.method, url.pathname);
    if (!match) {
      sendJson(response, 404, { error: `Unknown Patchwork route: ${url.pathname}` });
      return;
    }
    if (match.methodNotAllowed) {
      sendJson(response, 405, { error: `${request.method} is not allowed for ${url.pathname}.` });
      return;
    }

    const { route, params } = match;
    if (!route.public && !timingSafeEquals(requestToken(request, url), config.token)) {
      sendJson(response, 401, { error: 'The Patchwork agent token is missing or incorrect.' });
      return;
    }

    try {
      let body = {};
      let rawBody = null;
      if (JSON_METHODS.has(request.method)) {
        rawBody = await readBody(request);
        if (rawBody.length > 0 && !wantsRawBody(url.pathname, request.headers['content-type'])) {
          try {
            body = JSON.parse(rawBody.toString('utf8'));
          } catch {
            throw new Error('The request body is not valid JSON.');
          }
        }
      }
      const payload = await route.handler({
        request,
        response,
        url,
        params,
        body: body || {},
        rawBody,
        context,
        sendFile: (filePath, contentType, filename) => sendFile(response, filePath, contentType, filename),
      });
      if (payload !== null && !response.writableEnded) sendJson(response, 200, payload ?? {});
    } catch (error) {
      if (response.writableEnded) return;
      const message = String(error?.message || error || 'The Patchwork agent failed.');
      const status = /not found|no longer exists|unknown/i.test(message) ? 404 : 400;
      sendJson(response, status, { error: message });
    }
  });

  server.on('close', () => context.events.close());
  return { context, router, server };
}

async function startServer(config) {
  const created = await createServer(config);
  await new Promise((resolve, reject) => {
    created.server.once('error', reject);
    created.server.listen(config.port, config.host, resolve);
  });
  return { ...created, address: created.server.address() };
}

module.exports = { createServer, startServer };
