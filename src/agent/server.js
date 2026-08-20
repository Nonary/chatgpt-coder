const crypto = require('node:crypto');
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
const MAX_RANDOM_PORT_ATTEMPTS = 20;
const MIN_RANDOM_PORT = 1024;
const MAX_RANDOM_PORT = 65_535;

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

function randomPort() {
  return crypto.randomInt(MIN_RANDOM_PORT, MAX_RANDOM_PORT + 1);
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      server.off('error', onError);
      server.off('listening', onListening);
      reject(error);
    }
  });
}

async function startServer(config, options = {}) {
  const created = await createServer(config);
  const chooseRandomPort = options.randomPort || randomPort;
  const attemptedPorts = new Set();
  let candidate = config.port;

  for (let attempt = 0; ; attempt += 1) {
    attemptedPorts.add(candidate);
    try {
      await listen(created.server, candidate, config.host);
      break;
    } catch (error) {
      if (error?.code !== 'EADDRINUSE' || attempt >= MAX_RANDOM_PORT_ATTEMPTS) {
        created.context.events.close();
        throw error;
      }
      do candidate = chooseRandomPort(); while (attemptedPorts.has(candidate));
    }
  }

  // Install assets are generated from this same object after startup. Publish
  // the port that actually won the bind, including when port 0 asked the OS to
  // choose one or the configured port was occupied.
  config.port = created.server.address().port;
  return { ...created, address: created.server.address() };
}

module.exports = { createServer, randomPort, startServer };
