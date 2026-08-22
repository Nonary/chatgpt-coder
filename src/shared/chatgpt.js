// Pure ChatGPT domain helpers shared by the agent and the in-page userscript.
// Nothing here may touch Node built-ins or the DOM.

const CHATGPT_ORIGIN = 'https://chatgpt.com';
const CHATGPT_PROJECT_ID_PATTERN = /^g-p-[A-Za-z0-9_-]+$/;
const CHATGPT_CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESULT_NAME_PATTERN = /chatgpt-ide-result-([0-9a-f-]{36})(?:\s*\(\d+\))?\.txt/i;
const MERGE_RESULT_NAME_PATTERN = /chatgpt-ide-merge-result-([0-9a-f-]{36})(?:\s*\(\d+\))?\.txt/i;

const TASK_MODEL_PICKER_OPTIONS = {
  sol: {
    label: 'GPT-5.6 Sol',
    defaultSlug: 'gpt-5-6',
    instantSlug: 'gpt-5-6-instant',
    thinkingSlug: 'gpt-5-6-thinking',
    proSlug: 'gpt-5-6-pro',
    reasoningModes: ['default', 'instant', 'low', 'medium', 'high', 'extra-high', 'pro'],
  },
  luna: {
    label: 'GPT-5.6 Luna',
    defaultSlug: 'gpt-5-6-t-mini',
    instantSlug: 'gpt-5-6-mini',
    thinkingSlug: 'gpt-5-6-t-mini',
    reasoningModes: ['default', 'instant', 'low', 'medium', 'high', 'extra-high'],
  },
};

const TASK_REASONING_PICKER_OPTIONS = {
  instant: { label: 'Instant', thinkingEffort: null },
  low: { label: 'Low', thinkingEffort: 'min' },
  medium: { label: 'Medium', thinkingEffort: 'standard' },
  high: { label: 'High', thinkingEffort: 'extended' },
  'extra-high': { label: 'Extra High', thinkingEffort: 'max' },
  pro: { label: 'Pro', thinkingEffort: null },
};

function taskModelSupportsReasoning(model, reasoningMode) {
  const modelKey = String(model || 'default').toLowerCase() === 'default' ? 'sol' : String(model || '').toLowerCase();
  return Boolean(TASK_MODEL_PICKER_OPTIONS[modelKey]?.reasoningModes.includes(reasoningMode));
}

function basename(value) {
  return String(value || '').split(/[\\/]/).pop() || '';
}

function resultTaskId(filename) {
  return RESULT_NAME_PATTERN.exec(basename(filename))?.[1]?.toLowerCase() || null;
}

function mergeTreeId(filename) {
  return MERGE_RESULT_NAME_PATTERN.exec(basename(filename))?.[1]?.toLowerCase() || null;
}

function conversationIdFromRouteUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return null;
    const routeId = /^\/c\/([^/]+)\/?$/i.exec(url.pathname)?.[1]
      || /^\/g\/g-p-[A-Za-z0-9_-]+\/c\/([^/]+)\/?$/i.exec(url.pathname)?.[1]
      || null;
    if (!routeId || !CHATGPT_CONVERSATION_ID_PATTERN.test(routeId)) return null;
    return routeId;
  } catch {
    return null;
  }
}

function isChatGPTConversationUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && url.hostname === 'chatgpt.com'
      && (/^\/c\/[^/]+\/?$/.test(url.pathname)
        || /^\/g\/g-p-[A-Za-z0-9_-]+\/c\/[^/]+\/?$/.test(url.pathname));
  } catch {
    return false;
  }
}

function normalizeConversationStreamStatus(value) {
  const status = String(value || '').trim().toUpperCase();
  if (!status) return 'unknown';
  if (status === 'IS_STREAMING') return 'streaming';
  if (status === 'FAILURE') return 'failed';
  return 'completed';
}

function normalizeConversationTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  if (!title || /^(?:ChatGPT|New chat)$/i.test(title)) return '';
  return title;
}

function chatGPTProjectUrl(projectId, shortUrl = null) {
  const id = String(projectId || '').trim();
  if (!CHATGPT_PROJECT_ID_PATTERN.test(id)) throw new Error('ChatGPT returned an invalid project identifier.');
  const routeId = String(shortUrl || id).trim();
  if (!CHATGPT_PROJECT_ID_PATTERN.test(routeId) || (routeId !== id && !routeId.startsWith(`${id}-`))) {
    throw new Error('ChatGPT returned an invalid project URL.');
  }
  return `${CHATGPT_ORIGIN}/g/${routeId}/project`;
}

function taskRequestConfiguration(model, reasoningMode) {
  const requestedModel = String(model || 'default').toLowerCase();
  const requestedReasoning = String(reasoningMode || 'default').toLowerCase();
  const modelKey = requestedModel === 'default' ? 'sol' : requestedModel;
  const modelOption = TASK_MODEL_PICKER_OPTIONS[modelKey];
  const reasoningOption = TASK_REASONING_PICKER_OPTIONS[requestedReasoning] || null;
  if (!modelOption) throw new Error(`Unsupported ChatGPT model: ${model}`);
  if (requestedReasoning !== 'default' && !reasoningOption) {
    throw new Error(`Unsupported ChatGPT reasoning mode: ${reasoningMode}`);
  }
  if (!taskModelSupportsReasoning(requestedModel, requestedReasoning)) {
    throw new Error(`Unsupported ChatGPT reasoning mode for ${model}: ${reasoningMode}`);
  }
  const modelSlug = requestedReasoning === 'pro'
    ? modelOption.proSlug
    : requestedReasoning === 'instant'
    ? modelOption.instantSlug
    : requestedReasoning === 'default'
      ? modelOption.defaultSlug
      : modelOption.thinkingSlug;
  return {
    model: requestedModel,
    reasoningMode: requestedReasoning,
    modelSlug,
    thinkingEffort: reasoningOption?.thinkingEffort || null,
  };
}

function rewriteConversationRequestBody(postData, configuration) {
  const payload = JSON.parse(String(postData || ''));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('ChatGPT sent an invalid conversation request.');
  }
  payload.model = configuration.modelSlug;
  if (configuration.thinkingEffort) payload.thinking_effort = configuration.thinkingEffort;
  else delete payload.thinking_effort;
  return {
    text: JSON.stringify(payload),
    model: payload.model,
    thinkingEffort: payload.thinking_effort || null,
  };
}

function conversationRequestIncludesAttachment(postData, filename) {
  const target = String(filename || '').trim().toLowerCase();
  try {
    const payload = typeof postData === 'string' ? JSON.parse(postData) : postData;
    const visit = (value, key = '') => {
      if (typeof value === 'string') {
        const normalized = value.toLowerCase();
        return (target && normalized.includes(target))
          || normalized.startsWith('file-service://')
          || normalized.includes('file_asset_pointer');
      }
      if (Array.isArray(value)) {
        if (/attachments?|files?/i.test(key) && value.length > 0) return true;
        return value.some((item) => visit(item, key));
      }
      if (!value || typeof value !== 'object') return false;
      return Object.entries(value).some(([childKey, childValue]) => {
        if (/^(?:asset_pointer|file_id|upload_id)$/i.test(childKey) && childValue) return true;
        return visit(childValue, childKey);
      });
    };
    return visit(payload);
  } catch {
    return false;
  }
}

module.exports = {
  CHATGPT_CONVERSATION_ID_PATTERN,
  CHATGPT_ORIGIN,
  CHATGPT_PROJECT_ID_PATTERN,
  MERGE_RESULT_NAME_PATTERN,
  RESULT_NAME_PATTERN,
  TASK_MODEL_PICKER_OPTIONS,
  TASK_REASONING_PICKER_OPTIONS,
  taskModelSupportsReasoning,
  chatGPTProjectUrl,
  conversationIdFromRouteUrl,
  conversationRequestIncludesAttachment,
  isChatGPTConversationUrl,
  mergeTreeId,
  normalizeConversationStreamStatus,
  normalizeConversationTitle,
  resultTaskId,
  rewriteConversationRequestBody,
  taskRequestConfiguration,
};
