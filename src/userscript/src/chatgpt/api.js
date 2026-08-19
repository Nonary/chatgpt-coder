const { authorizedFetch } = require('./session');
const { CHATGPT_PROJECT_ID_PATTERN, chatGPTProjectUrl } = require('../../../shared/chatgpt');

async function readJson(response, what) {
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`The ${what} response was unreadable.`);
  }
  if (!response.ok) {
    throw new Error(`The ${what} request was rejected (${response.status}).`);
  }
  return data;
}

async function listProjects() {
  const projects = new Map();
  let cursor = null;
  let page = 0;
  do {
    const url = new URL('/backend-api/gizmos/snorlax/sidebar', location.origin);
    url.searchParams.set('conversations_per_gizmo', '0');
    url.searchParams.set('owned_only', 'true');
    url.searchParams.set('limit', '20');
    if (cursor) url.searchParams.set('cursor', cursor);
    const data = await readJson(await authorizedFetch(url.toString()), 'project list');
    for (const item of data.items || []) {
      const gizmo = item?.gizmo?.gizmo || item?.gizmo;
      const id = gizmo?.id;
      const name = gizmo?.display?.name;
      if (typeof id !== 'string' || !CHATGPT_PROJECT_ID_PATTERN.test(id)) continue;
      if (typeof name !== 'string' || !name.trim()) continue;
      projects.set(id, {
        id,
        shortUrl: typeof gizmo?.short_url === 'string' ? gizmo.short_url : null,
        name: name.trim(),
      });
    }
    cursor = data.cursor || null;
    page += 1;
  } while (cursor && page < 20);
  return [...projects.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function createProject(name) {
  const projectName = String(name || '').trim();
  if (!projectName) throw new Error('Enter a name for the new project.');
  const data = await readJson(await authorizedFetch('/backend-api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: projectName, instructions: '' }),
  }), 'project creation');

  const candidate = data?.resource?.gizmo || data?.gizmo?.gizmo || data?.gizmo
    || data?.project?.gizmo || data?.project || data;
  let project = {
    id: candidate?.id || candidate?.gizmo_id || data?.id || data?.gizmo_id || data?.project_id || null,
    shortUrl: candidate?.short_url || null,
    name: candidate?.display?.name || candidate?.name || data?.name || projectName,
  };
  if (!CHATGPT_PROJECT_ID_PATTERN.test(String(project.id || ''))) {
    project = (await listProjects()).find((item) => item.name === projectName) || null;
  }
  if (!project || !CHATGPT_PROJECT_ID_PATTERN.test(project.id)) {
    throw new Error('The project was created, but its identifier could not be determined.');
  }
  const shortUrl = CHATGPT_PROJECT_ID_PATTERN.test(String(project.shortUrl || '')) ? project.shortUrl : null;
  return {
    id: project.id,
    shortUrl,
    name: String(project.name || projectName).trim(),
    url: chatGPTProjectUrl(project.id, shortUrl),
  };
}

async function streamStatus(conversationId) {
  const response = await authorizedFetch(
    `/backend-api/conversation/${encodeURIComponent(conversationId)}/stream_status`,
  );
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  return {
    ok: response.ok,
    httpStatus: response.status,
    status: typeof data?.status === 'string' ? data.status : null,
  };
}

async function conversation(conversationId) {
  return readJson(
    await authorizedFetch(`/backend-api/conversation/${encodeURIComponent(conversationId)}`),
    'conversation',
  );
}

function messageAttachments(message) {
  const files = [];
  for (const attachment of message?.metadata?.attachments || []) {
    if (attachment?.id && attachment?.name) {
      files.push({ id: String(attachment.id), name: String(attachment.name), size: attachment.size ?? null });
    }
  }
  for (const part of message?.content?.parts || []) {
    if (!part || typeof part !== 'object') continue;
    const pointer = String(part.asset_pointer || '');
    const id = pointer.startsWith('file-service://') ? pointer.slice('file-service://'.length) : part.file_id;
    const name = part.metadata?.name || part.name || part.file_name;
    if (id && name) files.push({ id: String(id), name: String(name), size: part.size_bytes ?? null });
  }
  return files;
}

// Generated result files are read straight out of the conversation record instead
// of scraped from rendered markup.
function findGeneratedFile(conversationRecord, predicate) {
  const nodes = Object.values(conversationRecord?.mapping || {});
  const matches = [];
  for (const node of nodes) {
    const message = node?.message;
    if (!message || message.author?.role !== 'assistant') continue;
    for (const file of messageAttachments(message)) {
      if (predicate(file)) {
        matches.push({ ...file, createTime: message.create_time || 0, messageId: message.id });
      }
    }
  }
  matches.sort((left, right) => (right.createTime || 0) - (left.createTime || 0));
  return matches[0] || null;
}

async function downloadFileText(fileId) {
  const data = await readJson(
    await authorizedFetch(`/backend-api/files/${encodeURIComponent(fileId)}/download`),
    'file download',
  );
  const downloadUrl = data?.download_url || data?.url;
  if (!downloadUrl) throw new Error('No download URL came back for the result file.');
  const response = await fetch(downloadUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`The generated result file could not be downloaded (${response.status}).`);
  return response.text();
}

module.exports = {
  conversation,
  createProject,
  downloadFileText,
  findGeneratedFile,
  listProjects,
  messageAttachments,
  streamStatus,
};
