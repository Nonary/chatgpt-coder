const { Router } = require('../router');
const { TASK_MODEL_PICKER_OPTIONS, TASK_REASONING_PICKER_OPTIONS } = require('../../shared/chatgpt');
const tasks = require('./tasks');
const trees = require('./trees');
const workspace = require('./workspace');

const { version } = require('../../../package.json');

function registerSystem(router, context) {
  router.get('/health', async () => ({ ok: true, service: 'patchwork-agent', version }), { public: true });

  router.get('/v1/config', async () => ({
    version,
    dataRoot: context.dataRoot,
    iacSettingsPath: context.config.iacSettingsPath,
    models: TASK_MODEL_PICKER_OPTIONS,
    reasoningModes: TASK_REASONING_PICKER_OPTIONS,
  }));

  router.get('/v1/events', async ({ url }) => {
    const since = Number.parseInt(url.searchParams.get('since') || '0', 10) || 0;
    const wait = url.searchParams.get('wait') !== 'false';
    const events = wait
      ? await context.events.wait(since)
      : context.events.since(since);
    return { events, seq: context.events.sequence };
  });
}

function createRouter(context) {
  const router = new Router();
  registerSystem(router, context);
  workspace.register(router, context);
  tasks.register(router, context);
  trees.register(router, context);
  return router;
}

module.exports = { createRouter, version };
