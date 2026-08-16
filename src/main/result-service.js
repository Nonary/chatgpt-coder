const fs = require('node:fs/promises');
const path = require('node:path');
const {
  applyPatch,
  checkPatch,
  fingerprintRepository,
  inspectPatch,
  inspectRepository,
  listConflictedFiles,
  runGit,
} = require('./git');
const { validateCommitMessage } = require('./worktree-service');

const MAX_RESULT_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PATCH_BYTES = 64 * 1024 * 1024;
const TEXT_RESULT_START = 'PATCHWORK_RESULT_V1';
const TEXT_RESULT_END = 'PATCHWORK_RESULT_END';

function parsePlainTextResult(value) {
  const text = String(value || '');
  if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) {
    throw new Error('The plain-text result is larger than the 128 MB safety limit.');
  }
  const start = text.indexOf(TEXT_RESULT_START);
  const end = text.indexOf(TEXT_RESULT_END, start + TEXT_RESULT_START.length);
  if (start < 0 || end < 0) throw new Error('The ChatGPT response does not contain a complete Patchwork result envelope.');
  let jsonText = text.slice(start + TEXT_RESULT_START.length, end).trim();
  jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (Buffer.byteLength(jsonText, 'utf8') > MAX_MANIFEST_BYTES + (MAX_PATCH_BYTES * 2)) {
    throw new Error('The plain-text result envelope is unexpectedly large.');
  }
  let manifest;
  try {
    manifest = JSON.parse(jsonText);
  } catch {
    throw new Error('The plain-text Patchwork result contains invalid JSON.');
  }
  if (manifest.schemaVersion !== 2 || manifest.transport !== 'plain-text-base64') {
    throw new Error('The ChatGPT response uses an unsupported plain-text result format.');
  }
  if (!Array.isArray(manifest.repositories)) throw new Error('Result manifest has no repository list.');
  return manifest;
}

function decodePatch(value, repositoryId) {
  if (typeof value !== 'string') throw new Error(`${repositoryId} has no plain-text patch data.`);
  if (value.length > Math.ceil(MAX_PATCH_BYTES / 3) * 4 + 4) {
    throw new Error(`${repositoryId} exceeds the 64 MB decoded patch limit.`);
  }
  const compact = value.replace(/\s/g, '');
  if (compact && (!/^[a-zA-Z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0)) {
    throw new Error(`${repositoryId} contains invalid base64 patch data.`);
  }
  const patch = Buffer.from(compact, 'base64');
  if (patch.length > MAX_PATCH_BYTES) throw new Error(`${repositoryId} exceeds the 64 MB patch limit.`);
  const expected = compact.replace(/=+$/, '');
  const actual = patch.toString('base64').replace(/=+$/, '');
  if (actual !== expected) throw new Error(`${repositoryId} contains invalid base64 patch data.`);
  return patch;
}

function requireTaskRepository(task, repositoryId) {
  if (typeof repositoryId !== 'string' || !/^[a-z0-9._-]+$/i.test(repositoryId)) {
    throw new Error('Result contains an invalid repository id.');
  }
  const repository = task.repositories.find((item) => item.id === repositoryId);
  if (!repository) throw new Error(`Unknown repository in result: ${repositoryId}`);
  return repository;
}

async function matchesPackagedState(repository, current) {
  if (repository.isSnapshot) {
    if (current.baseCommit !== repository.sourceHead) return false;
    return (await fingerprintRepository(repository.path)) === repository.snapshotFingerprint;
  }
  return current.baseCommit === repository.baseCommit && current.isClean;
}

class ResultService {
  constructor(taskService, onEvent = () => {}) {
    this.taskService = taskService;
    this.onEvent = onEvent;
  }

  async ingestTextFile(taskId, downloadedPath) {
    return this.ingestResult(taskId, 'Validating the downloaded text result…', async (task) => {
      const stat = await fs.stat(downloadedPath);
      if (stat.size > MAX_RESULT_BYTES) {
        throw new Error('The downloaded text result is larger than the 128 MB safety limit.');
      }
      const text = await fs.readFile(downloadedPath, 'utf8');
      return this.readPlainTextResult(task, text, downloadedPath);
    });
  }

  async ingestResult(taskId, message, readResult) {
    const task = await this.taskService.getTask(taskId);
    await this.onEvent({ type: 'result-processing', taskId, message });

    try {
      const result = await readResult(task);
      const validated = await this.validate(task, result);
      const readyTask = await this.taskService.updateTask(taskId, {
        state: 'ready',
        result: validated,
      });
      await this.onEvent({ type: 'result-ready', task: readyTask });
      if (readyTask.autoApply) return this.apply(taskId);
      return readyTask;
    } catch (error) {
      const failedTask = await this.taskService.updateTask(taskId, {
        state: 'failed',
        error: error.message,
      });
      await this.onEvent({ type: 'task-failed', task: failedTask, message: error.message });
      throw error;
    }
  }

  async readPlainTextResult(task, text, downloadedPath = null) {
    const manifest = parsePlainTextResult(text);
    if (manifest.taskId !== task.taskId) throw new Error('This result belongs to a different Patchwork task.');
    if (manifest.status !== 'completed') throw new Error(`ChatGPT returned task status: ${manifest.status}`);

    const resultDir = path.join(this.taskService.taskDirectory(task.taskId), 'result');
    await fs.mkdir(resultDir, { recursive: true });
    const patches = [];
    for (const item of manifest.repositories) {
      requireTaskRepository(task, item?.id);
      if (item.patchEncoding !== 'base64') throw new Error(`${item.id} does not use base64 patch encoding.`);
      const outputPath = path.join(resultDir, `${item.id}.patch`);
      await fs.writeFile(outputPath, decodePatch(item.patch, item.id));
      patches.push({
        id: item.id,
        baseCommit: item.baseCommit,
        patchEncoding: item.patchEncoding,
        localPath: outputPath,
      });
    }
    return {
      summary: String(manifest.summary || '').trim(),
      commitMessage: task.treeId ? validateCommitMessage(manifest.commitMessage) : null,
      transport: 'plain-text-base64',
      downloadedPath,
      patches,
    };
  }

  async validate(task, result) {
    const expectedIds = new Set(task.repositories.map((repository) => repository.id));
    const actualIds = new Set(result.patches.map((patch) => patch.id));
    if (result.patches.length !== expectedIds.size
      || expectedIds.size !== actualIds.size
      || [...expectedIds].some((id) => !actualIds.has(id))) {
      throw new Error('The result repository list does not match the original task package.');
    }

    const previews = [];
    for (const patch of result.patches) {
      const repository = task.repositories.find((item) => item.id === patch.id);
      if (!repository) throw new Error(`Unknown repository in result: ${patch.id}`);
      if (patch.baseCommit !== repository.baseCommit) {
        throw new Error(`${repository.name} patch targets the wrong base commit.`);
      }
      const patchBody = await fs.readFile(patch.localPath, 'utf8');
      if (repository.readOnly && patchBody.length > 0) {
        throw new Error(`${repository.name} was supplied as read-only conflict context, but ChatGPT tried to change it.`);
      }
      if (patchBody.length === 0) {
        previews.push({ ...patch, name: repository.name, stat: 'No changes', numstat: '', preview: '' });
        continue;
      }
      const current = await inspectRepository(repository.path);
      const exactState = await matchesPackagedState(repository, current);
      let stats;
      let applyMode = 'direct';
      if (exactState) {
        stats = await checkPatch(repository.path, patch.localPath);
      } else {
        stats = await inspectPatch(repository.path, patch.localPath);
        if (!current.isClean) {
          applyMode = 'conflict';
        } else {
          try {
            await checkPatch(repository.path, patch.localPath);
          } catch {
            applyMode = 'three-way';
          }
        }
      }
      previews.push({
        ...patch,
        name: repository.name,
        ...stats,
        applyMode,
        preview: patchBody.slice(0, 200_000),
        previewTruncated: patchBody.length > 200_000,
      });
    }
    return {
      ...result,
      validatedAt: new Date().toISOString(),
      patches: previews,
    };
  }

  async apply(taskId) {
    let task = await this.taskService.getTask(taskId);
    if (!task.result || !['ready', 'failed', 'conflicted'].includes(task.state)) {
      if (task.state === 'applied') return task;
      throw new Error('This result is not ready to apply.');
    }

    const applied = [];
    const committed = [];
    try {
      for (const patch of task.result.patches) {
        const repository = task.repositories.find((item) => item.id === patch.id);
        const body = await fs.readFile(patch.localPath);
        if (body.length === 0) continue;
        const current = await inspectRepository(repository.path);
        const exactState = await matchesPackagedState(repository, current);
        if (!exactState && !current.isClean) {
          return this.markConflicted(task, repository, new Error(
            `${repository.name} has new uncommitted or unmerged changes since this task was packaged.`,
          ));
        }
        let applyMode = 'direct';
        if (!exactState) {
          try {
            await checkPatch(repository.path, patch.localPath);
          } catch {
            applyMode = 'three-way';
          }
        } else {
          await checkPatch(repository.path, patch.localPath);
        }
        try {
          await applyPatch(repository.path, patch.localPath, applyMode === 'three-way'
            ? { threeWay: true, index: true }
            : {});
        } catch (error) {
          return this.markConflicted(task, repository, error);
        }
        applied.push({ repository, patch, applyMode, wasClean: current.isClean, headBefore: current.baseCommit });
      }
      if (task.treeId) {
        for (const item of applied) {
          await runGit(item.repository.path, ['add', '-A', '--', '.']);
          await runGit(item.repository.path, ['commit', '-m', task.result.commitMessage]);
          const { stdout } = await runGit(item.repository.path, ['rev-parse', 'HEAD']);
          committed.push({ ...item, commit: stdout.trim(), message: task.result.commitMessage });
        }
      }
    } catch (error) {
      for (const item of committed.reverse()) {
        try {
          await runGit(item.repository.path, ['reset', '--hard', `${item.commit}^`]);
        } catch {
          // Preserve the original error and the worktree for manual recovery.
        }
      }
      for (const item of applied.reverse()) {
        if (committed.some((commit) => commit.repository.path === item.repository.path)) continue;
        try {
          if (item.wasClean && item.headBefore) {
            await runGit(item.repository.path, ['reset', '--hard', item.headBefore]);
          } else {
            await runGit(item.repository.path, ['reset', '--mixed', '--quiet', 'HEAD']).catch(() => {});
            await applyPatch(item.repository.path, item.patch.localPath, { reverse: true });
          }
        } catch {
          // Preserve the original error; the UI will point the user to the saved patch.
        }
      }
      task = await this.taskService.updateTask(taskId, { state: 'failed', error: error.message });
      await this.onEvent({ type: 'task-failed', task, message: error.message });
      throw error;
    }

    const appliedAt = new Date().toISOString();
    task = await this.taskService.updateTask(taskId, {
      state: 'applied',
      appliedAt,
      error: null,
      result: { ...task.result, commits: committed.map(({ repository, commit, message }) => ({
        repositoryId: repository.id,
        commit,
        message,
      })) },
    });
    await this.onEvent({ type: 'task-applied', task });

    if (task.resolvesTaskId) {
      try {
        const originalTask = await this.taskService.getTask(task.resolvesTaskId);
        if (originalTask.state === 'conflicted') {
          const resolvedTask = await this.taskService.updateTask(originalTask.taskId, {
            state: 'resolved',
            error: null,
            resolvedAt: appliedAt,
            resolutionTaskId: task.taskId,
          });
          await this.onEvent({
            type: 'task-resolved',
            task: resolvedTask,
            resolutionTask: task,
            message: 'The original task conflict has been resolved.',
          });
        }
      } catch {
        // A deleted original task should not invalidate the successful resolution.
      }
    }

    return task;
  }

  async markConflicted(task, repository, error) {
    const files = await listConflictedFiles(repository.path).catch(() => []);
    const detail = String(error?.message || error || 'The patch did not apply cleanly.');
    const message = files.length
      ? `${repository.name} has merge conflicts in ${files.length} file${files.length === 1 ? '' : 's'}.`
      : `${repository.name} changed and the result could not be applied cleanly.`;
    const conflictedTask = await this.taskService.updateTask(task.taskId, {
      state: 'conflicted',
      error: `${message} Resubmit a conflict-resolution task to preserve both versions.`,
      result: {
        ...task.result,
        conflicts: [{
          repositoryId: repository.id,
          repositoryName: repository.name,
          files,
          error: detail,
        }],
      },
    });
    await this.onEvent({ type: 'task-conflicted', task: conflictedTask, message });
    return conflictedTask;
  }

  async rollback(taskId) {
    let task = await this.taskService.getTask(taskId);
    if (task.state !== 'applied' || !task.result) throw new Error('This task has not been applied.');

    const reverts = [];
    if (task.result.commits?.length) {
      for (const item of [...task.result.commits].reverse()) {
        const repository = task.repositories.find((entry) => entry.id === item.repositoryId);
        const current = await inspectRepository(repository.path);
        if (!current.isClean || current.baseCommit !== item.commit) {
          throw new Error('The task target changed after this task was applied; revert it from Source Control instead.');
        }
        await runGit(repository.path, ['revert', '--no-edit', item.commit]);
        const { stdout } = await runGit(repository.path, ['rev-parse', 'HEAD']);
        reverts.push({ repositoryId: repository.id, commit: stdout.trim() });
      }
    } else {
      for (const patch of [...task.result.patches].reverse()) {
        const repository = task.repositories.find((item) => item.id === patch.id);
        const body = await fs.readFile(patch.localPath);
        if (body.length === 0) continue;
        await applyPatch(repository.path, patch.localPath, true);
      }
    }
    task = await this.taskService.updateTask(taskId, {
      state: 'rolled-back',
      rolledBackAt: new Date().toISOString(),
      result: { ...task.result, reverts },
    });
    await this.onEvent({ type: 'task-rolled-back', task });
    return task;
  }
}

module.exports = { ResultService, parsePlainTextResult };
