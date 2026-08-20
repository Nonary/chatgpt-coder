const { Router } = require('../router');
const { TASK_MODEL_PICKER_OPTIONS, TASK_REASONING_PICKER_OPTIONS } = require('../../shared/chatgpt');
const tasks = require('./tasks');
const trees = require('./trees');
const workspace = require('./workspace');

const { version } = require('../../../package.json');

function registerSystem(router, context) {
  router.get('/health', async () => ({
    ok: true,
    service: 'patchwork-agent',
    version,
    revision: context.updateService.runningRevision,
  }), { public: true });

  router.get('/v1/config', async () => ({
    version,
    dataRoot: context.dataRoot,
    iacSettingsPath: context.config.iacSettingsPath,
    models: TASK_MODEL_PICKER_OPTIONS,
    reasoningModes: TASK_REASONING_PICKER_OPTIONS,
  }));

  router.get('/v1/update', async () => context.updateService.status({ fetch: true }));

  router.post('/v1/update', async () => {
    if (typeof context.requestRestart !== 'function') {
      throw new Error('This Patchwork process cannot restart itself. Start it with patchwork-agent and try again.');
    }
    const result = await context.updateService.applyUpdate();
    setTimeout(() => context.requestRestart(), 150).unref?.();
    return result;
  });

  // A place for the page to post what it actually measured, so layout and
  // selector problems are diagnosed from real numbers instead of guessed at.
  router.post('/v1/diagnostics', async ({ body }) => {
    context.lastDiagnostics = { ...body, at: new Date().toISOString() };
    process.stdout.write(`[diagnostics] ${JSON.stringify(context.lastDiagnostics)}\n`);
    return { received: true };
  });

  router.get('/v1/diagnostics', async () => ({ diagnostics: context.lastDiagnostics || null }));

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
