const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  conversationIdFromUrl,
  parseHarText,
} = require('../src/userscript/src/chatgpt/har');
const {
  mergeSavedConversations,
  normalizeSavedConversation,
} = require('../src/userscript/src/chatgpt/saved-conversations');

const conversationId = '6aa98da2-52e0-8330-87a3-d013ac6108cc';

test('HAR parsing extracts conversation IDs and generated titles without retaining payloads', () => {
  const har = {
    log: {
      entries: [
        {
          startedDateTime: '2026-09-15T18:20:00.000Z',
          request: { url: `https://chatgpt.com/backend-api/conversation/${conversationId}/stream_status` },
          response: { content: { mimeType: 'application/json', text: '{"status":"IS_STREAMING"}' } },
        },
        {
          startedDateTime: '2026-09-15T18:20:01.000Z',
          request: { url: 'https://chatgpt.com/backend-api/f/conversation' },
          response: {
            content: {
              mimeType: 'text/event-stream',
              text: [
                'event: delta_encoding',
                'data: {"type":"title_generation","conversation_id":"' + conversationId + '","title":"Greeting exchange"}',
                'data: {"type":"resume_conversation_token","token":"secret-token"}',
              ].join('\n'),
            },
          },
        },
        {
          request: { url: 'https://chatgpt.com/backend-api/conversations?limit=28' },
          response: {
            content: {
              mimeType: 'application/json',
              text: JSON.stringify({
                items: [{
                  id: '11111111-1111-4111-8111-111111111111',
                  title: 'An unrelated saved conversation',
                }],
              }),
            },
          },
        },
      ],
    },
  };

  const records = parseHarText(JSON.stringify(har), 'tempchat.har');
  assert.deepEqual(records, [{
    id: conversationId,
    conversationUrl: `https://chatgpt.com/c/${conversationId}`,
    title: 'Greeting exchange',
    sourceName: 'tempchat.har',
    capturedAt: '2026-09-15T18:20:00.000Z',
    importedAt: records[0].importedAt,
  }]);
  assert.equal(records[0].token, undefined);
  assert.equal(records.length, 1, 'sidebar history must not turn every old chat into an import');
});

test('conversation ID extraction accepts ChatGPT route and backend URLs only', () => {
  assert.equal(
    conversationIdFromUrl(`https://chatgpt.com/c/${conversationId}`),
    conversationId,
  );
  assert.equal(
    conversationIdFromUrl(`https://chatgpt.com/backend-api/conversation/${conversationId}/textdocs`),
    conversationId,
  );
  assert.equal(conversationIdFromUrl('https://chatgpt.com/backend-api/files/not-a-conversation'), null);
});

test('saved conversation records keep only reopenable local metadata', () => {
  const saved = normalizeSavedConversation({
    id: conversationId,
    title: '  Greeting   exchange ',
    sourceName: 'tempchat.har',
    token: 'must-not-survive',
  });
  assert.deepEqual(saved, {
    id: conversationId,
    conversationUrl: `https://chatgpt.com/c/${conversationId}`,
    title: 'Greeting exchange',
    sourceName: 'tempchat.har',
    capturedAt: null,
    importedAt: null,
  });
  assert.equal(saved.token, undefined);
  assert.equal(mergeSavedConversations([], [saved, saved]).length, 1);
});
