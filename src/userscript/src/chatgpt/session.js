const SESSION_TTL_MILLISECONDS = 4 * 60 * 1000;

let cached = null;
let cachedAt = 0;

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function deviceId() {
  return readStorage('oai-device-id')
    || readStorage('oai/apps/uuid')
    || document.cookie.match(/(?:^|;\s*)oai-did=([^;]+)/)?.[1]
    || null;
}

async function readSession(force = false) {
  if (!force && cached && Date.now() - cachedAt < SESSION_TTL_MILLISECONDS) return cached;
  const response = await fetch('/api/auth/session', {
    credentials: 'include',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Sign in before using the workspace.');
  let session;
  try {
    session = await response.json();
  } catch {
    throw new Error('Sign in before using the workspace.');
  }
  const accessToken = session?.accessToken || session?.access_token;
  if (!accessToken) throw new Error('Sign in before using the workspace.');
  cached = {
    accessToken,
    accountId: session?.account?.id || session?.accountId || null,
    email: session?.user?.email || null,
    deviceId: deviceId(),
  };
  cachedAt = Date.now();
  return cached;
}

async function authHeaders(extra = {}, force = false) {
  const session = await readSession(force);
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${session.accessToken}`,
    ...extra,
  };
  if (session.deviceId) headers['oai-device-id'] = session.deviceId;
  if (session.accountId) headers['ChatGPT-Account-Id'] = session.accountId;
  return headers;
}

// Every backend call retries once with a fresh session so a rotated access token
// never surfaces as a user-visible failure.
async function authorizedFetch(path, options = {}) {
  const send = async (force) => fetch(path, {
    credentials: 'include',
    cache: 'no-store',
    ...options,
    headers: await authHeaders(options.headers, force),
  });
  let response = await send(false);
  if (response.status === 401 || response.status === 403) response = await send(true);
  return response;
}

function invalidateSession() {
  cached = null;
  cachedAt = 0;
}

module.exports = {
  authHeaders,
  authorizedFetch,
  deviceId,
  invalidateSession,
  readSession,
};
