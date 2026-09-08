const path = require('node:path');

function register(router, context) {
  const {
    fsService, gitService, iacService, libraryService, promptService, skillService,
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

  router.get('/v1/workspace/submodules', async ({ url }) => (
    gitService.submodules(url.searchParams.get('path'))
  ));

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

  const listSkills = async (repositoryPaths) => {
    const discovered = await skillService.discover(repositoryPaths);
    const skills = await libraryService.decorate('skills', discovered);
    return skills.map(({ sourcePath, skillFile, rootPath, ...skill }) => skill);
  };

  router.get('/v1/skills', async ({ url }) => {
    const repositories = (url.searchParams.get('repositories') || '')
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean);
    return { skills: await listSkills(repositories) };
  });

  router.get('/v1/skills/:skillId', async ({ params, url }) => {
    const repositories = (url.searchParams.get('repositories') || '')
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean);
    const skill = await skillService.get(params.skillId, repositories);
    const [decorated] = await libraryService.decorate('skills', [skill]);
    const { sourcePath, skillFile, rootPath, ...safeSkill } = decorated;
    return { skill: safeSkill };
  });

  router.post('/v1/skills', async ({ body }) => {
    const repositoryPath = String(body.repositoryPath || '').trim() || null;
    const repositories = Array.isArray(body.repositories)
      ? body.repositories.map((value) => String(value).trim()).filter(Boolean)
      : (repositoryPath ? [repositoryPath] : []);
    const skill = await skillService.create(body);
    const decorated = (await libraryService.decorate('skills', [skill]))[0];
    const { sourcePath, skillFile, rootPath, ...safeSkill } = decorated;
    return { skill: safeSkill, skills: await listSkills(repositories) };
  });

  router.patch('/v1/skills/:skillId', async ({ params, body }) => {
    const repositories = Array.isArray(body.repositories)
      ? body.repositories.map((value) => String(value).trim()).filter(Boolean)
      : [];
    const skill = await skillService.update(params.skillId, body, repositories);
    const decorated = (await libraryService.decorate('skills', [skill]))[0];
    const { sourcePath, skillFile, rootPath, ...safeSkill } = decorated;
    return { skill: safeSkill, skills: await listSkills(repositories) };
  });

  router.delete('/v1/skills/:skillId', async ({ params, body }) => {
    const repositories = Array.isArray(body?.repositories)
      ? body.repositories.map((value) => String(value).trim()).filter(Boolean)
      : [];
    await skillService.remove(params.skillId, repositories);
    await libraryService.remove('skills', params.skillId);
    return { skills: await listSkills(repositories) };
  });

  router.patch('/v1/skills/:skillId/enabled', async ({ params, body }) => {
    const repositories = Array.isArray(body.repositories)
      ? body.repositories.map((value) => String(value).trim()).filter(Boolean)
      : [];
    const skills = await skillService.discover(repositories);
    if (!skills.some((skill) => skill.id === params.skillId)) throw new Error('That skill no longer exists.');
    await libraryService.setEnabled('skills', params.skillId, body.enabled !== false);
    return { skills: await listSkills(repositories) };
  });

  router.get('/v1/iac', async () => iacService.getConfig());

  const listPrompts = async () => libraryService.decorate('prompts', await promptService.list());

  router.get('/v1/prompts', async () => ({ prompts: await listPrompts() }));

  router.post('/v1/prompts', async ({ body }) => {
    const prompt = await promptService.save(body);
    const prompts = await listPrompts();
    return { prompt: prompts.find((item) => item.id === prompt.id) || prompt, prompts };
  });

  router.get('/v1/prompts/:promptId/file', async ({ params, sendFile }) => {
    const prompt = await promptService.getFile(params.promptId);
    return sendFile(prompt.path, 'text/markdown; charset=utf-8', prompt.name);
  });

  router.patch('/v1/prompts/:promptId/enabled', async ({ params, body }) => {
    const prompts = await listPrompts();
    if (!prompts.some((prompt) => prompt.id === params.promptId)) throw new Error('That prompt no longer exists.');
    await libraryService.setEnabled('prompts', params.promptId, body.enabled !== false);
    return { prompts: await listPrompts() };
  });

  router.delete('/v1/prompts/:promptId', async ({ params }) => {
    const prompts = await promptService.remove(params.promptId);
    await libraryService.remove('prompts', params.promptId);
    return { prompts: await libraryService.decorate('prompts', prompts) };
  });
}

module.exports = { register };
