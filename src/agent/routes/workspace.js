const path = require('node:path');

function register(router, context) {
  const {
    fsService, gitService, iacService, promptService, skillService,
  } = context;

  router.get('/v1/fs/roots', async () => ({ roots: await fsService.roots() }));

  router.post('/v1/fs/select-directory', async () => ({
    path: await fsService.selectDirectory(),
  }));

  router.get('/v1/fs/browse', async ({ url }) => {
    const listing = await fsService.browse(url.searchParams.get('path'));
    await gitService.rememberRepositories([
      ...(listing.repository ? [{ name: path.basename(listing.path), path: listing.path }] : []),
      ...listing.directories.filter((entry) => entry.repository),
    ]);
    return listing;
  });

  router.get('/v1/fs/discover', async ({ url }) => {
    const repositories = await fsService.discoverRepositories(
      url.searchParams.get('path'),
      Number.parseInt(url.searchParams.get('depth') || '', 10) || undefined,
    );
    await gitService.rememberRepositories(repositories);
    return { repositories };
  });

  router.post('/v1/fs/reveal', async ({ body }) => {
    await fsService.reveal(body.path);
    return { revealed: true };
  });

  router.get('/v1/workspace/repositories', async () => ({
    repositories: await gitService.listRepositories(),
  }));

  router.get('/v1/workspace/repository-catalog', async () => ({
    repositories: await gitService.listKnownRepositories(),
  }));

  router.post('/v1/workspace/repositories', async ({ body }) => {
    const paths = Array.isArray(body.paths) ? body.paths : [body.path].filter(Boolean);
    if (paths.length === 0) throw new Error('Choose at least one repository directory.');
    return { repositories: await gitService.addRepositories(paths) };
  });

  router.post('/v1/workspace/repositories/remove', async ({ body }) => ({
    repositories: await gitService.removeRepository(body.path),
  }));

  router.get('/v1/workspace/status', async ({ url }) => (
    gitService.status(url.searchParams.get('path'), {
      includeFingerprint: url.searchParams.get('fingerprint') === 'true',
    })
  ));

  router.get('/v1/workspace/history', async ({ url }) => ({
    commits: await gitService.history(
      url.searchParams.get('path'),
      Number.parseInt(url.searchParams.get('limit') || '', 10) || undefined,
    ),
  }));

  router.get('/v1/workspace/diff', async ({ url }) => gitService.diff(
    url.searchParams.get('path'),
    url.searchParams.get('file'),
    url.searchParams.get('staged') === 'true',
  ));

  router.post('/v1/workspace/stage', async ({ body }) => (
    body.all ? gitService.stageAll(body.path) : gitService.stage(body.path, body.files)
  ));

  router.post('/v1/workspace/unstage', async ({ body }) => (
    body.all ? gitService.unstageAll(body.path) : gitService.unstage(body.path, body.files)
  ));

  router.post('/v1/workspace/commit', async ({ body }) => (
    gitService.commit(body.path, body.message)
  ));

  router.get('/v1/skills', async ({ url }) => {
    const repositories = (url.searchParams.get('repositories') || '')
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean);
    const skills = await skillService.discover(repositories);
    return { skills: skills.map(({ sourcePath, skillFile, ...skill }) => skill) };
  });

  router.get('/v1/iac', async () => iacService.getConfig());

  router.get('/v1/prompts', async () => ({ prompts: await promptService.list() }));

  router.post('/v1/prompts', async ({ body }) => ({
    prompt: await promptService.save(body),
    prompts: await promptService.list(),
  }));

  router.delete('/v1/prompts/:promptId', async ({ params }) => ({
    prompts: await promptService.remove(params.promptId),
  }));
}

module.exports = { register };
