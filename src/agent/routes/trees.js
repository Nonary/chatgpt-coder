function buildMergeResolutionTaskText(tree) {
  return `Resolve the failed coding-tree merge described below. Use the read-only original-checkout snapshot to understand the target state and local changes. Make every required resolution in the writable coding-tree repository only, preserve both sides' intended changes, and verify the result.\n\nMerge failure:\n${tree.mergeError || 'The coding tree could not be merged.'}`;
}

function register(router, context) {
  const {
    emit, fsService, taskService, worktreeService,
  } = context;

  router.get('/v1/trees', async () => ({ trees: await worktreeService.list() }));

  router.get('/v1/trees/:treeId', async ({ params }) => ({
    tree: await worktreeService.inspect(await worktreeService.get(params.treeId)),
  }));

  router.post('/v1/trees/:treeId/reveal', async ({ params }) => {
    const tree = await worktreeService.get(params.treeId);
    await fsService.reveal(tree.path);
    return { revealed: true };
  });

  // The discard confirmation is an in-page modal now, so the route trusts the
  // caller and only refuses when the worktree service itself refuses.
  router.delete('/v1/trees/:treeId', async ({ params, url }) => ({
    trees: await worktreeService.remove(params.treeId, url.searchParams.get('force') !== 'false'),
  }));

  router.post('/v1/trees/:treeId/project', async ({ params, body }) => ({
    tree: await worktreeService.setChatGPTProject(params.treeId, body.chatgptProject ?? null),
  }));

  // Returns the prompt the page submits to ChatGPT; the agent never drives the page.
  router.post('/v1/trees/:treeId/merge-request', async ({ params, body }) => {
    try {
      if (body && Object.prototype.hasOwnProperty.call(body, 'chatgptProject')) {
        await worktreeService.setChatGPTProject(params.treeId, body.chatgptProject);
      }
      const request = await worktreeService.buildMergeRequest(params.treeId);
      emit({
        type: 'merge-automation-started',
        treeId: request.treeId,
        message: `Opening a fresh ChatGPT chat to summarize ${request.treeName}…`,
      });
      return { request };
    } catch (error) {
      await worktreeService.markMergeFailed(params.treeId, error).catch(() => {});
      throw error;
    }
  });

  router.post('/v1/trees/:treeId/merge-submitted', async ({ params, body }) => {
    const tree = await worktreeService.markMergeSubmitted(params.treeId, body.conversationUrl || null);
    emit({
      type: 'merge-submitted',
      treeId: params.treeId,
      message: 'ChatGPT is preparing the squash commit message.',
    });
    return { tree };
  });

  router.post('/v1/trees/:treeId/merge-failed', async ({ params, body }) => {
    const tree = await worktreeService.markMergeFailed(params.treeId, body.message);
    emit({ type: 'merge-failed', treeId: params.treeId, message: tree.mergeError });
    return { tree };
  });

  router.post('/v1/trees/:treeId/merge-result', async ({ params, body, rawBody }) => {
    const text = typeof body?.text === 'string' ? body.text : rawBody?.toString('utf8');
    if (!text) throw new Error('The merge result upload contained no text.');
    try {
      const trees = await worktreeService.mergeFromText(params.treeId, text);
      return { trees };
    } catch (error) {
      await worktreeService.markMergeFailed(params.treeId, error).catch(() => {});
      emit({ type: 'merge-failed', treeId: params.treeId, message: error.message });
      throw error;
    }
  });

  router.post('/v1/trees/:treeId/resolve-merge', async ({ params }) => {
    const tree = await worktreeService.get(params.treeId);
    if (tree.mergeState !== 'failed') throw new Error('This coding tree does not have a failed merge to resolve.');
    const task = await taskService.createTask({
      taskText: buildMergeResolutionTaskText(tree),
      repositories: [
        { path: tree.path },
        { path: tree.repositoryPath, readOnly: true },
      ],
      tree,
      chatgptProject: tree.chatgptProject || null,
      autoApply: true,
      mergeResolution: true,
    });
    await worktreeService.attachTask(tree.id, task.taskId);
    emit({ type: 'task-prepared', task });
    return { task };
  });
}

module.exports = { buildMergeResolutionTaskText, register };
