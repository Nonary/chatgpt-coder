const { CHATGPT_ORIGIN, CHATGPT_CONVERSATION_ID_PATTERN } = require('../../../shared/chatgpt');

const DATA_PREFIX = /^data:\s*/;

function conversationId(value) {
  const match = String(value || '').match(CHATGPT_CONVERSATION_ID_PATTERN);
  return match ? match[0].toLowerCase() : null;
}

function conversationIdFromUrl(value) {
  try {
    const url = new URL(String(value || ''), CHATGPT_ORIGIN);
    const match = url.pathname.match(
      /\/(?:c|backend-api\/conversation)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i,
    );
    return conversationId(match?.[1]);
  } catch {
    return null;
  }
}

function safeTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  return title.length > 200 ? title.slice(0, 200).trim() : title;
}

function addRecord(records, id, patch = {}) {
  if (!id) return;
  const current = records.get(id) || {
    id,
    conversationUrl: `${CHATGPT_ORIGIN}/c/${id}`,
    title: '',
    sourceName: '',
    capturedAt: null,
    importedAt: null,
  };
  const next = { ...current };
  if (safeTitle(patch.title)) next.title = safeTitle(patch.title);
  if (patch.sourceName && !next.sourceName) next.sourceName = String(patch.sourceName).slice(0, 200);
  if (patch.capturedAt && !next.capturedAt) next.capturedAt = patch.capturedAt;
  if (!next.importedAt) next.importedAt = patch.importedAt || new Date().toISOString();
  records.set(id, next);
}

function inspectPayload(payload, records, context, { allowItems = true } = {}) {
  if (!payload || typeof payload !== 'object') return;
  if (Array.isArray(payload)) {
    for (const item of payload) inspectPayload(item, records, context, { allowItems });
    return;
  }

  const id = conversationId(payload.conversation_id);
  if (id) addRecord(records, id, { ...context, title: payload.title });

  if (payload.type === 'title_generation' && id) {
    addRecord(records, id, { ...context, title: payload.title });
  }

  if (allowItems && Array.isArray(payload.items)) {
    for (const item of payload.items) {
      if (!item || typeof item !== 'object') continue;
      const itemId = conversationId(item.id || item.conversation_id);
      if (itemId && records.has(itemId)) addRecord(records, itemId, { ...context, title: item.title });
    }
  }
}

function inspectResponseBody(text, mimeType, records, context) {
  if (!text || /base64/i.test(context.encoding || '')) return;
  if (String(mimeType || '').includes('text/event-stream')) {
    for (const line of String(text).split(/\r?\n/)) {
      if (!DATA_PREFIX.test(line)) continue;
      const raw = line.replace(DATA_PREFIX, '').trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        inspectPayload(JSON.parse(raw), records, context);
      } catch {
        // HAR event streams can contain non-JSON framing; ignore it.
      }
    }
    return;
  }
  if (!String(mimeType || '').includes('json')) return;
  try {
    inspectPayload(JSON.parse(text), records, context, { allowItems: false });
  } catch {
    // An unrelated or truncated response must not make the whole import fail.
  }
}

function parseHarText(text, sourceName = '') {
  let har;
  try {
    har = JSON.parse(String(text || ''));
  } catch {
    throw new Error('The selected file is not valid JSON.');
  }
  const entries = Array.isArray(har?.log?.entries) ? har.log.entries : [];
  if (!entries.length) throw new Error('The selected JSON is not a HAR file.');

  const importedAt = new Date().toISOString();
  const records = new Map();
  for (const entry of entries) {
    const request = entry?.request || {};
    const response = entry?.response || {};
    const capturedAt = entry?.startedDateTime || null;
    const context = {
      sourceName: String(sourceName || '').split(/[\\/]/).pop().slice(0, 200),
      capturedAt,
      importedAt,
    };
    const requestId = conversationIdFromUrl(request.url);
    if (requestId) addRecord(records, requestId, context);
    const responseContent = response.content || {};
    inspectResponseBody(responseContent.text, responseContent.mimeType, records, {
      ...context,
      encoding: responseContent.encoding,
    });
  }
  return [...records.values()]
    .sort((left, right) => String(left.capturedAt || '').localeCompare(String(right.capturedAt || '')))
    .map((record) => ({
      ...record,
      title: record.title || `Conversation ${record.id.slice(0, 8)}`,
    }));
}

module.exports = {
  conversationId,
  conversationIdFromUrl,
  parseHarText,
};
