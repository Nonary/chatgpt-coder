const { readStorage, writeStorage } = require('../ui/storage');

const STORAGE_KEY = 'patchwork.saved-conversations';
const MAX_SAVED_CONVERSATIONS = 50;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeSavedConversation(value) {
  if (!value || typeof value !== 'object' || !ID_PATTERN.test(String(value.id || ''))) return null;
  const id = String(value.id).toLowerCase();
  return {
    id,
    conversationUrl: `https://chatgpt.com/c/${id}`,
    title: String(value.title || `Conversation ${id.slice(0, 8)}`).replace(/\s+/g, ' ').trim().slice(0, 200),
    sourceName: String(value.sourceName || 'HAR snapshot').split(/[\\/]/).pop().slice(0, 200),
    capturedAt: value.capturedAt || null,
    importedAt: value.importedAt || null,
  };
}

function normalizeList(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map(normalizeSavedConversation)
    .filter((value) => {
      if (!value || seen.has(value.id)) return false;
      seen.add(value.id);
      return true;
    })
    .slice(0, MAX_SAVED_CONVERSATIONS);
}

function readSavedConversations() {
  const raw = readStorage(STORAGE_KEY, '');
  if (!raw) return [];
  try {
    return normalizeList(JSON.parse(raw));
  } catch {
    return [];
  }
}

function writeSavedConversations(values) {
  writeStorage(STORAGE_KEY, JSON.stringify(normalizeList(values)));
  return readSavedConversations();
}

function mergeSavedConversations(current, imported) {
  const merged = new Map();
  for (const item of normalizeList(imported).concat(normalizeList(current))) {
    if (!merged.has(item.id)) merged.set(item.id, item);
  }
  return [...merged.values()].slice(0, MAX_SAVED_CONVERSATIONS);
}

function removeSavedConversation(current, id) {
  return normalizeList(current).filter((item) => item.id !== String(id || '').toLowerCase());
}

module.exports = {
  MAX_SAVED_CONVERSATIONS,
  mergeSavedConversations,
  normalizeSavedConversation,
  readSavedConversations,
  removeSavedConversation,
  writeSavedConversations,
};
