const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { appendPromptInstructions } = require('../services/prompt-service');
const { resolveGitSummaryPrompt, resolveTreeTaskRepositories } = require('../services/task-service');
const { validateCommitMessage } = require('../services/worktree-service');
const { isChatGPTConversationUrl, normalizeConversationStreamStatus } = require('../../shared/chatgpt');

const MAX_RESULT_TEXT_BYTES = 128 * 1024 * 1024;

function buildConflictResolutionTaskText(task, conflict, additionalInstructions = '') {
  const base = `Resolve the failed Patchwork result application described below. Inspect the current coding tree, including any conflict markers, and the original result patch in CONFLICTS.md. Preserve the intended changes from both the original task and the returned result, then complete the work and verify the final diff.\n\nOriginal task:\n${task.taskText}\n\nApply failure:\n${conflict.error || task.error || 'The result could not be applied cleanly.'}`;
  const extra = String(additionalInstructions || '').replaceAll('\r\n', '\n').trim().slice(0, 12_000);
  return extra ? `${base}\n\nAdditional instructions from the user:\n${extra}` : base;
}

function sanitizeUploadName(value) {
  const name = path.basename(String(value || '').replaceAll('\\', '/')).trim();
  const safe = name.replace(/[^A-Za-z0-9._ ()+-]/g, '_');
  return safe && safe !== '.' && safe !== '..' ? safe.slice(0, 180) : 'attachment';
}

function register(router, context) {
  const {
    emit, promptService, resultService, skillService, taskService, worktreeService, uploadsRoot,
  } = context;

  // Attachments arrive as bytes from a real file input in the page; there is no
  // path to hand to the packager until they are staged on disk.
  router.post('/v1/uploads', async ({ url, rawBody }) => {
    if (!rawBody || rawBody.length === 0) throw new Error('The uploaded file is empty.');
    const name = sanitizeUploadName(url.searchParams.get('name'));
    const directory = path.join(uploadsRoot, crypto.randomUUID());
    await fs.mkdir(directory, { recursive: true });
    const filePath = path.join(directory, name);
    await fs.writeFile(filePath, rawBody);
    return { name, path: filePath, size: rawBody.length };
  });

  router.get('/v1/tasks', async () => ({ tasks: await taskService.listTasks() }));

  router.post('/v1/tasks', async ({ body }) => {
    const baseTaskText = String(body.taskText || '').trim();
    if (!baseTaskText) throw new Error('Describe the software task before creating a task package.');
    const selectedPrompts = await promptService.resolveSelected(body.promptIds);
    const taskText = appendPromptInstructions(baseTaskText, selectedPrompts);

    let tree = null;
    let taskRepositories = body.repositories;
    let skillsResolved = false;
    let skillRepositoryPaths = Array.isArray(body.repositories)
      ? body.repositories.map((item) => item.path)
      : [];

    if (body.treeId) {
      tree = await worktreeService.get(body.treeId);
      const inspected = await worktreeService.inspect(tree);
      if (!inspected.available) throw new Error(inspected.error);
      if (!inspected.clean) throw new Error('Commit or discard local coding-tree changes before starting a follow-up task.');
    } else if (body.createTree) {
      if (!Array.isArray(body.repositories) || body.repositories.length === 0) {
        throw new Error('Choose at least one repository when creating a coding tree.');
      }
      await skillService.resolveSelectedSkillIds(body.skillIds, skillRepositoryPaths);
      skillsResolved = true;
      const suggestedName = String(body.treeName || taskText || '').split('\n')[0].trim();
      tree = await worktreeService.create(body.repositories[0].path, suggestedName);
    }
    if (tree) {
      taskRepositories = await resolveTreeTaskRepositories(tree, body.repositories);
      skillRepositoryPaths = taskRepositories.map((item) => item.path);
    }
    if (!skillsResolved) await skillService.resolveSelectedSkillIds(body.skillIds, skillRepositoryPaths);

    const task = await taskService.createTask({
      ...body,
      taskText,
      skillRepositoryPaths,
      repositories: taskRepositories,
      tree,
      // The apply-target picker is authoritative. Keep the validated result in
      // the ready state until the user applies it to the selected target.
      autoApply: false,
    });
    if (tree) {
      const hasChatGPTProject = Object.prototype.hasOwnProperty.call(body, 'chatgptProject');
      await worktreeService.attachTask(
        tree.id,
        task.taskId,
        hasChatGPTProject ? body.chatgptProject : undefined,
      );
    }
    emit({ type: 'task-prepared', task });
    return { task };
  });

  // Source control's AI summary is an ordinary read-only task; the page submits it
  // and posts the result back like any other.
  router.post('/v1/git-summary', async ({ body }) => {
    const status = await context.gitService.status(body.path);
    if (status.changes.length === 0) throw new Error('There are no uncommitted changes to summarize.');
    const savedPrompt = await promptService.gitSummaryPrompt();
    const prompt = resolveGitSummaryPrompt(body.prompt || savedPrompt);
    const task = await taskService.createTask({
      taskText: prompt,
      repositories: [{ path: status.repository.path, readOnly: true }],
      model: body.model || 'luna',
      reasoningMode: body.reasoningMode || 'medium',
      autoApply: false,
      summaryOnly: true,
    });
    emit({ type: 'task-prepared', task });
    emit({
      type: 'git-summary-started',
      taskId: task.taskId,
      repositoryPath: status.repository.path,
      message: `Packaging ${status.changes.length} uncommitted change${status.changes.length === 1 ? '' : 's'} for Git Summary…`,
    });
    return { task, usedCustomPrompt: Boolean(savedPrompt || body.prompt) };
  });

  router.get('/v1/tasks/:taskId', async ({ params }) => ({ task: await taskService.getTask(params.taskId) }));

  router.delete('/v1/tasks/:taskId', async ({ params }) => {
    const task = await taskService.getTask(params.taskId);
    await taskService.deleteTask(task.taskId);
    emit({ type: 'task-deleted', taskId: task.taskId });
    return { deleted: true, taskId: task.taskId };
  });

  router.get('/v1/tasks/:taskId/package', async ({ params, sendFile }) => {
    const task = await taskService.getTask(params.taskId);
    return sendFile(task.packagePath, 'application/zip', path.basename(task.packagePath));
  });

  router.get('/v1/tasks/:taskId/attachments/:name', async ({ params, sendFile }) => {
    const task = await taskService.getTask(params.taskId);
    const attachment = (task.attachments || []).find((item) => item.name === params.name);
    if (!attachment) throw new Error(`Unknown task attachment: ${params.name}`);
    return sendFile(attachment.path, 'application/octet-stream', attachment.name);
  });

  router.post('/v1/tasks/:taskId/submitted', async ({ params, body }) => {
    const task = await taskService.getTask(params.taskId);
    if (!isChatGPTConversationUrl(body.conversationUrl)) {
      throw new Error('A submitted task needs a real ChatGPT conversation URL.');
    }
    const submitted = await taskService.updateTask(task.taskId, {
      state: 'submitted',
      submittedAt: new Date().toISOString(),
      conversationUrl: body.conversationUrl,
      conversationId: body.conversationId || null,
      conversationTitle: body.conversationTitle || task.conversationTitle || null,
      chatStatus: 'streaming',
      chatStatusRaw: 'IS_STREAMING',
      chatFinishedAt: null,
      model: body.model || task.model,
      reasoningMode: body.reasoningMode || task.reasoningMode,
      error: null,
    });
    emit({
      type: 'task-submitted',
      task: submitted,
      message: submitted.summaryOnly
        ? 'Git Summary uploaded and submitted through the ChatGPT page.'
        : 'Task uploaded and submitted through the ChatGPT page.',
    });
    return { task: submitted };
  });

  router.post('/v1/tasks/:taskId/chat-status', async ({ params, body }) => {
    const task = await taskService.getTask(params.taskId);
    const chatStatus = normalizeConversationStreamStatus(body.status);
    if (task.chatStatus === chatStatus && task.chatStatusRaw === body.status) return { task };
    const saved = await taskService.updateTask(task.taskId, {
      state: task.answerOnly
        ? (chatStatus === 'completed' ? 'completed' : chatStatus === 'failed' ? 'failed' : task.state)
        : task.state,
      conversationId: body.conversationId || task.conversationId || null,
      chatStatus,
      chatStatusRaw: body.status || null,
      chatFinishedAt: chatStatus === 'streaming' ? null : task.chatFinishedAt || new Date().toISOString(),
      error: task.answerOnly && chatStatus === 'failed'
        ? 'ChatGPT stopped before completing the answer.'
        : task.error || null,
    });
    emit({
      type: 'task-chat-status',
      task: saved,
      taskId: saved.taskId,
      chatStatus,
      chatStatusRaw: saved.chatStatusRaw,
    });
    return { task: saved };
  });

  router.post('/v1/tasks/:taskId/failed', async ({ params, body }) => {
    const message = String(body.message || 'The task failed in the ChatGPT page.');
    const task = await taskService.updateTask(params.taskId, { state: 'failed', error: message });
    emit({ type: 'task-failed', task, message });
    return { task };
  });

  // The page downloads the result text from ChatGPT and hands it to the agent for
  // envelope validation and, when auto-apply is on, application.
  router.post('/v1/tasks/:taskId/result', async ({ params, body, rawBody }) => {
    const current = await taskService.getTask(params.taskId);
    if (current.answerOnly) throw new Error('Answer-only tasks do not accept Patchwork result files.');
    const text = typeof body?.text === 'string' ? body.text : rawBody?.toString('utf8');
    if (!text) throw new Error('The result upload contained no text.');
    if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_TEXT_BYTES) {
      throw new Error('The result text is larger than the 128 MB safety limit.');
    }
    const task = await resultService.ingestResult(
      params.taskId,
      'Validating the downloaded text result…',
      (current) => resultService.readPlainTextResult(current, text),
    );
    if (task.summaryOnly && task.result?.commitMessage) {
      emit({
        type: 'git-summary-ready',
        task,
        repositoryPath: task.sourceRepositoryPath || task.repositories?.[0]?.path,
        commitMessage: task.result.commitMessage,
        message: 'AI generated a Conventional Commit message. Use it in Source Control when ready.',
      });
    }
    return { task };
  });

  router.post('/v1/tasks/:taskId/apply', async ({ params }) => ({
    task: await resultService.apply(params.taskId),
  }));

  router.post('/v1/tasks/:taskId/retry-apply', async ({ params }) => {
    const task = await taskService.getTask(params.taskId);
    if (task.state !== 'conflicted' || !task.result?.patches?.length) {
      throw new Error('This task does not have a result conflict to retry.');
    }
    return { task: await resultService.apply(task.taskId) };
  });

  router.post('/v1/tasks/:taskId/rollback', async ({ params }) => ({
    task: await resultService.rollback(params.taskId),
  }));

  router.post('/v1/tasks/:taskId/use-git-summary', async ({ params }) => {
    const task = await taskService.getTask(params.taskId);
    if (!task.summaryOnly || !task.result?.commitMessage) {
      throw new Error('This task does not contain a Git Summary result.');
    }
    if (!['ready', 'completed'].includes(task.state)) {
      throw new Error('This Git Summary is not ready to use in Source Control.');
    }
    validateCommitMessage(task.result.commitMessage);
    const completed = task.state === 'completed'
      ? task
      : await taskService.updateTask(task.taskId, {
        state: 'completed',
        completedAt: new Date().toISOString(),
      });
    emit({
      type: 'git-summary-applied',
      task: completed,
      repositoryPath: completed.sourceRepositoryPath || completed.repositories?.[0]?.path,
      commitMessage: completed.result.commitMessage,
      message: 'Git Summary moved to the Source Control commit editor.',
    });
    return { task: completed };
  });

  router.post('/v1/tasks/:taskId/target', async ({ params, body }) => {
    const task = await taskService.getTask(params.taskId);
    const writableRepositories = (Array.isArray(task.repositories) ? task.repositories : [])
      .filter((repository) => !repository.readOnly);
    if (['applied', 'rolled-back', 'resolved'].includes(task.state)) {
      throw new Error('This task can no longer change its apply target.');
    }
    // Choosing the original repository for a task that already targets it is a
    // no-op. Do not run worktree-only validation for that explicit choice.
    if (!body.createTree && !body.treeId && !task.treeId) {
      return { task };
    }
    if (writableRepositories.length !== 1) {
      throw new Error('Worktree selection is only available for tasks with one writable repository.');
    }

    const previousTreeId = task.treeId || null;
    let tree = null;
    let repositoryPath = task.sourceRepositoryPath || writableRepositories[0].path;

    if (body.createTree) {
      tree = await worktreeService.create(repositoryPath, body.treeName);
      repositoryPath = tree.path;
    } else if (body.treeId) {
      const candidate = await worktreeService.get(String(body.treeId));
      tree = await worktreeService.inspect(candidate);
      if (!tree.available) throw new Error(tree.error || 'The selected coding tree is unavailable.');
      if (tree.mergeState === 'submitted') throw new Error('The selected coding tree is already being merged.');
      const sourcePath = task.sourceRepositoryPath || writableRepositories[0].path;
      const [expectedRoot, selectedRoot] = await Promise.all([
        fs.realpath(sourcePath).catch(() => path.resolve(sourcePath)),
        fs.realpath(tree.repositoryPath).catch(() => path.resolve(tree.repositoryPath)),
      ]);
      if (expectedRoot !== selectedRoot) {
        throw new Error('Choose a worktree from the same repository as this task.');
      }
      repositoryPath = tree.path;
    } else if (task.sourceRepositoryPath) {
      repositoryPath = task.sourceRepositoryPath;
    }

    const updated = await taskService.setTarget(task.taskId, { repositoryPath, tree });
    if (previousTreeId && previousTreeId !== tree?.id) {
      await worktreeService.detachTask(previousTreeId, task.taskId).catch(() => {});
    }
    if (tree) await worktreeService.attachTask(tree.id, task.taskId);
    emit({
      type: 'task-target-changed',
      task: updated,
      message: tree ? `Task target changed to ${tree.name}.` : 'Task target changed to the original repository.',
    });
    return { task: updated };
  });

  router.post('/v1/tasks/:taskId/resolve-conflict', async ({ params, body }) => {
    let task = await taskService.getTask(params.taskId);
    if (task.state !== 'conflicted' || !task.result?.patches?.length) {
      throw new Error('This task does not have a result conflict to resolve.');
    }
    task = await resultService.apply(task.taskId);
    if (task.state === 'applied') return { task, resolutionTask: null };
    if (task.state !== 'conflicted') {
      throw new Error('The result could not be retried before conflict resolution.');
    }

    let tree = null;
    if (task.treeId) {
      const candidate = await worktreeService.get(task.treeId).catch(() => null);
      if (candidate) {
        const inspected = await worktreeService.inspect(candidate);
        if (inspected.available) tree = inspected;
      }
    }
    if (!tree) tree = await worktreeService.findForTask(task);
    const writableRepositories = task.repositories
      .filter((repository) => !repository.readOnly)
      .map((repository) => ({ path: repository.path }));
    let repositories = tree ? [{ path: tree.path }] : writableRepositories;
    if (!tree && task.sourceRepositoryPath && writableRepositories.length === 1) {
      repositories = [{ path: task.sourceRepositoryPath }];
    }
    if (repositories.length === 0) throw new Error('This conflicted task has no writable repository to resolve.');

    const conflict = task.result.conflicts?.[0] || {};
    await resultService.prepareConflictResolution(task.taskId);
    const resolutionTask = await taskService.createTask({
      taskText: buildConflictResolutionTaskText(task, conflict, body.additionalInstructions),
      repositories,
      attachments: task.attachments || [],
      tree,
      autoApply: true,
      model: Object.prototype.hasOwnProperty.call(body, 'model') ? body.model : task.model,
      reasoningMode: Object.prototype.hasOwnProperty.call(body, 'reasoningMode')
        ? body.reasoningMode
        : task.reasoningMode,
      chatgptProject: task.chatgptProject || null,
      resolvesTaskId: task.taskId,
      conflictContext: {
        originalTaskId: task.taskId,
        error: conflict.error || task.error,
        files: conflict.files || [],
        patches: task.result.patches,
      },
    });
    if (tree) await worktreeService.attachTask(tree.id, resolutionTask.taskId);
    emit({ type: 'task-prepared', task: resolutionTask });
    return { task, resolutionTask };
  });
}

module.exports = { buildConflictResolutionTaskText, register };
