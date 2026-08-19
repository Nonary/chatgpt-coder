const { isAllowedOrigin } = require('./config');

const MAX_BODY_BYTES = 192 * 1024 * 1024;

function readBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('The request body is larger than the agent safety limit.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function readJson(request) {
  const body = await readBody(request);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('The request body is not valid JSON.');
  }
}

function applyCors(request, response) {
  const origin = request.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Credentials', 'false');
  }
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Patchwork-Token');
  response.setHeader('Access-Control-Max-Age', '600');
  // chatgpt.com sends Cross-Origin-Embedder-Policy: require-corp, so every
  // subresource it loads has to opt in explicitly.
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  // Chrome's Private Network Access preflight for public -> loopback requests.
  if (request.headers['access-control-request-private-network'] === 'true') {
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
}

function sendJson(response, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function sendBuffer(response, status, buffer, contentType, headers = {}) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(buffer);
}

function sendText(response, status, text, contentType = 'text/plain; charset=utf-8') {
  sendBuffer(response, status, Buffer.from(text, 'utf8'), contentType);
}

function requestToken(request, url) {
  const header = String(request.headers.authorization || '');
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1];
  return bearer
    || (request.headers['x-patchwork-token'] ? String(request.headers['x-patchwork-token']) : null)
    || url.searchParams.get('token');
}

function timingSafeEquals(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  // eslint-disable-next-line global-require
  return require('node:crypto').timingSafeEqual(a, b);
}

module.exports = {
  MAX_BODY_BYTES,
  applyCors,
  readBody,
  readJson,
  requestToken,
  sendBuffer,
  sendJson,
  sendText,
  timingSafeEquals,
};
