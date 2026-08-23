const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
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
const { followUpTurn } = require('./task-service');

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

function normalizeResultSource(source) {
  if (!source || typeof source !== 'object') return null;
  const normalized = {};
  for (const key of ['id', 'name', 'messageId', 'sandboxPath', 'source']) {
    if (source[key] != null) normalized[key] = String(source[key]).slice(0, 4096);
  }
  const createTime = Number(source.createTime);
  if (Number.isFinite(createTime)) normalized.createTime = createTime;
  return Object.keys(normalized).length > 0 ? normalized : null;
}

async function fingerprintIndex(repositoryPath) {
  const { stdout } = await runGit(repositoryPath, ['ls-files', '-s', '-z']);
  return crypto.createHash('sha256').update(stdout).digest('hex');
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

class ApplyConflictError extends Error {
  constructor(repository, error, applyAttempted = false) {
    super(String(error?.message || error || 'The patch did not apply cleanly.'));
    this.name = 'ApplyConflictError';
    this.repository = repository;
    this.applyAttempted = Boolean(applyAttempted);
    this.originalError = error instanceof Error ? error : new Error(this.message);
  }
}

class ResultService {
  constructor(taskService, onEvent = () => {}) {
    this.taskService = taskService;
    this.onEvent = onEvent;
    this.activeTaskMutations = new Set();
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
    const activeTurn = followUpTurn(task);
    await this.onEvent({ type: 'result-processing', taskId, message });

    let readyTask;
    try {
      const result = await readResult(task);
      if (activeTurn?.mode === 'agent' && result.sourceFile?.createTime != null) {
        const turnStartedAt = Date.parse(activeTurn.submittedAt || activeTurn.createdAt || '');
        const rawResultTime = Number(result.sourceFile.createTime);
        const resultCreatedAt = Number.isFinite(rawResultTime)
          ? (rawResultTime > 100000000000 ? rawResultTime : rawResultTime * 1000)
          : NaN;
        if (Number.isFinite(turnStartedAt) && Number.isFinite(resultCreatedAt)
          && resultCreatedAt < turnStartedAt - 5000) {
          throw new Error('The generated result predates the active Agent follow-up and was ignored as stale.');
        }
      }
      if (task.result?.contentHash && task.result.contentHash === result.contentHash) {
        if (!result.sourceFile) return task;
        const updated = await this.taskService.updateTask(taskId, {
          result: { ...task.result, sourceFile: result.sourceFile },
        });
        if (activeTurn?.mode === 'agent') {
          const completed = await this.taskService.completeFollowUpResult(taskId, activeTurn.id, result.sourceFile, updated.state);
          await this.onEvent({
            type: 'task-follow-up-completed',
            task: completed,
            turn: completed.turns?.find((item) => item.id === activeTurn.id) || null,
          });
          return completed;
        }
        return updated;
      }
      const validated = await this.validate(task, result);
      if (task.state === 'applied' && task.result
        && !Array.isArray(task.result.appliedRepositories)) {
        throw new Error(
          'This task was applied before follow-up replacement tracking was available. Roll it back, then refresh this follow-up result.',
        );
      }
      const update = {
        state: 'ready',
        result: validated,
        error: null,
      };
      if (!task.appliedResult && task.state === 'applied' && task.result) {
        update.appliedResult = task.result;
      }
      readyTask = await this.taskService.transitionTask(taskId, [task.state], update, 'accept its result');
      await this.onEvent({ type: 'result-ready', task: readyTask });
    } catch (error) {
      if (activeTurn?.mode === 'agent') {
        const failedTask = await this.taskService.failFollowUp(
          taskId,
          activeTurn.id,
          `Follow-up result ignored: ${error.message}`,
        );
        await this.onEvent({ type: 'task-failed', task: failedTask, message: error.message });
      } else {
        const failedTask = task.result
          ? await this.taskService.updateTask(taskId, { error: `Follow-up result ignored: ${error.message}` })
          : await this.taskService.transitionTask(
            taskId,
            [task.state],
            { state: 'failed', error: error.message },
            'reject its invalid result',
          );
        await this.onEvent({ type: 'task-failed', task: failedTask, message: error.message });
      }
      throw error;
    }

    // Application owns its failure state. Keep it outside the validation catch
    // so a failed automatic follow-up cannot be relabeled as applied while its
    // newer cumulative result has not actually reached the target repository.
    if (readyTask.autoApply) {
      let appliedTask;
      try {
        appliedTask = await this.apply(taskId);
      } catch (error) {
        if (activeTurn?.mode === 'agent') {
          const failedTask = await this.taskService.failFollowUp(
            taskId,
            activeTurn.id,
            `Follow-up result could not be applied: ${error.message}`,
          );
          await this.onEvent({ type: 'task-failed', task: failedTask, message: error.message });
        }
        throw error;
      }
      if (activeTurn?.mode === 'agent') {
        const completed = await this.taskService.completeFollowUpResult(
          taskId,
          activeTurn.id,
          readyTask.result?.sourceFile,
          appliedTask.state,
        );
        await this.onEvent({
          type: 'task-follow-up-completed',
          task: completed,
          turn: completed.turns?.find((item) => item.id === activeTurn.id) || null,
        });
        return completed;
      }
      return appliedTask;
    }
    if (activeTurn?.mode === 'agent') {
      const completed = await this.taskService.completeFollowUpResult(
        taskId,
        activeTurn.id,
        readyTask.result?.sourceFile,
        readyTask.state,
      );
      await this.onEvent({
        type: 'task-follow-up-completed',
        task: completed,
        turn: completed.turns?.find((item) => item.id === activeTurn.id) || null,
      });
      return completed;
    }
    return readyTask;
  }

  async readPlainTextResult(task, text, downloadedPath = null, sourceFile = null) {
    const contentHash = crypto.createHash('sha256').update(text).digest('hex');
    const manifest = parsePlainTextResult(text);
    if (manifest.taskId !== task.taskId) throw new Error('This result belongs to a different Patchwork task.');
    if (manifest.status !== 'completed') throw new Error(`ChatGPT returned task status: ${manifest.status}`);

    const resultDir = path.join(this.taskService.taskDirectory(task.taskId), 'result', contentHash);
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
    // The result payload is the source of truth for the AI-generated commit
    // message. Require and validate it so Source Control never falls back to a
    // generic message after a task is applied or redirected to a coding tree.
    const commitMessage = validateCommitMessage(manifest.commitMessage);
    return {
      summary: String(manifest.summary || '').trim(),
      commitMessage,
      transport: 'plain-text-base64',
      downloadedPath,
      contentHash,
      sourceFile: normalizeResultSource(sourceFile),
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
      if (task.summaryOnly && patchBody.length > 0) {
        throw new Error('Git summary results must not contain repository changes.');
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

  async materializeResultTree(repositoryPath, startCommit, patchPath) {
    await runGit(repositoryPath, ['reset', '--hard', startCommit]);
    await runGit(repositoryPath, ['clean', '-fd']);
    const body = await fs.readFile(patchPath);
    if (body.length > 0) {
      try {
        await checkPatch(repositoryPath, patchPath);
        await applyPatch(repositoryPath, patchPath);
      } catch {
        await runGit(repositoryPath, ['reset', '--hard', startCommit]);
        await runGit(repositoryPath, ['clean', '-fd']);
        await applyPatch(repositoryPath, patchPath, { threeWay: true, index: true });
      }
    }
    await runGit(repositoryPath, ['add', '-A', '--', '.']);
    const { stdout } = await runGit(repositoryPath, ['write-tree']);
    return stdout.trim();
  }

  async createReplacementPatch(task, repository, previousPatch, nextPatch, appliedState) {
    if (!appliedState?.fingerprintAfter) {
      throw new Error(`${repository.name} was applied before follow-up replacement tracking was available. Roll back that result before applying this follow-up.`);
    }
    const current = await inspectRepository(repository.path);
    const fingerprint = await fingerprintRepository(repository.path);
    const indexFingerprint = appliedState.indexFingerprintAfter
      ? await fingerprintIndex(repository.path)
      : null;
    if ((appliedState.headAfter && current.baseCommit !== appliedState.headAfter)
      || fingerprint !== appliedState.fingerprintAfter
      || (appliedState.indexFingerprintAfter && indexFingerprint !== appliedState.indexFingerprintAfter)) {
      throw new Error(`${repository.name} changed after the previous result was applied. Preserve those changes in a new Patchwork task before applying this follow-up.`);
    }

    const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-follow-up-'));
    const scratchPath = path.join(scratchRoot, 'repository');
    try {
      let startCommit;
      if (appliedState.contextWasClean && appliedState.contextHead) {
        await runGit(scratchRoot, ['clone', '--no-checkout', repository.path, scratchPath]);
        startCommit = appliedState.contextHead;
      } else {
        const bundlePath = path.join(
          this.taskService.taskDirectory(task.taskId),
          'repositories',
          `${repository.id}.bundle`,
        );
        await runGit(scratchRoot, ['clone', '--no-checkout', bundlePath, scratchPath]);
        startCommit = repository.baseCommit;
      }
      await runGit(scratchPath, ['checkout', '--detach', startCommit]);

      const previousTree = await this.materializeResultTree(scratchPath, startCommit, previousPatch.localPath);
      const nextTree = await this.materializeResultTree(scratchPath, startCommit, nextPatch.localPath);
      const { stdout: delta } = await runGit(
        scratchPath,
        ['diff', '--binary', previousTree, nextTree, '--', '.'],
        { maxBuffer: MAX_PATCH_BYTES * 2 },
      );
      const replacementDir = path.join(path.dirname(nextPatch.localPath), 'replacement');
      await fs.mkdir(replacementDir, { recursive: true });
      const replacementPath = path.join(replacementDir, `${repository.id}.patch`);
      await fs.writeFile(replacementPath, delta);
      if (delta.length > 0) {
        if (appliedState.indexApplied) {
          await runGit(repository.path, ['apply', '--check', '--index', '--binary', replacementPath]);
        } else {
          await checkPatch(repository.path, replacementPath);
        }
      }
      return replacementPath;
    } finally {
      await fs.rm(scratchRoot, { recursive: true, force: true });
    }
  }

  async prepareReplacementPatches(task) {
    if (!task.appliedResult) return new Map();
    const previousStates = new Map((task.appliedResult.appliedRepositories || [])
      .map((item) => [item.repositoryId, item]));
    const previousPatches = new Map((task.appliedResult.patches || [])
      .map((item) => [item.id, item]));
    const replacements = new Map();

    for (const nextPatch of task.result.patches || []) {
      const repository = task.repositories.find((item) => item.id === nextPatch.id);
      if (!repository || repository.readOnly) continue;
      const previousPatch = previousPatches.get(nextPatch.id);
      const appliedState = previousStates.get(nextPatch.id);
      if (!previousPatch || !appliedState) {
        throw new Error(`${repository.name} is missing the previously applied result needed for this follow-up.`);
      }
      const localPath = await this.createReplacementPatch(
        task,
        repository,
        previousPatch,
        nextPatch,
        appliedState,
      );
      replacements.set(nextPatch.id, { localPath, appliedState });
    }
    return replacements;
  }

  async prepareConflictResolution(taskId) {
    let task = await this.taskService.getTask(taskId);
    if (task.state !== 'conflicted' || !task.result?.patches?.length) {
      throw new Error('This task does not have a result conflict to resolve.');
    }
    task = await this.rebindMissingResolutionTarget(task, false);

    const conflict = task.result.conflicts?.[0];
    const repository = task.repositories.find((item) => item.id === conflict?.repositoryId);
    const patch = task.result.patches.find((item) => item.id === conflict?.repositoryId);
    if (!repository || !patch) {
      throw new Error('The conflicted result is missing its repository patch.');
    }
    if (repository.readOnly) {
      throw new Error(`${repository.name} is read-only conflict context and cannot be reapplied.`);
    }

    const body = await fs.readFile(patch.localPath);
    if (body.length === 0) return inspectRepository(repository.path);

    const conflictedFiles = await listConflictedFiles(repository.path);
    const wasApplyAttempted = typeof conflict?.applyAttempted === 'boolean'
      ? conflict.applyAttempted
      : !/new uncommitted or unmerged changes since this task was packaged/i.test(String(conflict?.error || ''));
    if (conflictedFiles.length > 0) {
      // The unresolved index already contains the conflict context that the
      // resolution task needs. Do not attempt another apply (which could
      // replace those entries); package it alongside the saved result patch.
      return inspectRepository(repository.path);
    }

    try {
      // `git apply --3way --index` needs the index to represent the current
      // local version. Stage it before creating the three-way conflict so Git
      // can retain the user's changes as the "ours" side of the resolution.
      if (!wasApplyAttempted) await runGit(repository.path, ['add', '-A', '--', '.']);
      await applyPatch(repository.path, patch.localPath, { threeWay: true, index: true });
    } catch (error) {
      const afterConflict = await listConflictedFiles(repository.path).catch(() => []);
      if (afterConflict.length > 0) return inspectRepository(repository.path);

      try {
        await runGit(repository.path, ['apply', '--reverse', '--check', '--binary', patch.localPath]);
        return inspectRepository(repository.path);
      } catch {
        throw new Error(`Could not re-apply the conflicted result for ${repository.name}: ${error.message}`);
      }
    }

    return inspectRepository(repository.path);
  }

  async apply(taskId) {
    if (this.activeTaskMutations.has(taskId)) {
      throw new Error('This task result is already being changed.');
    }
    this.activeTaskMutations.add(taskId);
    let markedInProgress = false;
    try {
      const current = await this.taskService.getTask(taskId);
      if (current.applyInProgress) throw new Error('This task result is already being applied.');
      await this.taskService.updateTask(taskId, { applyInProgress: true });
      markedInProgress = true;
      return await this._applyTask(taskId);
    } finally {
      if (markedInProgress) {
        await this.taskService.updateTask(taskId, { applyInProgress: false }).catch(() => {});
      }
      this.activeTaskMutations.delete(taskId);
    }
  }

  async _applyTask(taskId) {
    let task = await this.taskService.getTask(taskId);
    task = await this.rebindMissingResolutionTarget(task);
    if (!task.result || !['ready', 'failed', 'conflicted'].includes(task.state)) {
      if (task.state === 'applied') return task;
      throw new Error('This result is not ready to apply.');
    }

    const applied = [];
    const committed = [];
    const applicationContexts = new Map();
    const appliedRepositories = [];
    try {
      const replacementPatches = await this.prepareReplacementPatches(task);
      const plan = [];

      // Preflight every writable repository before mutating any of them. This
      // keeps a later conflict from leaving earlier repositories partially applied.
      for (const patch of task.result.patches) {
        const repository = task.repositories.find((item) => item.id === patch.id);
        if (!repository || repository.readOnly) continue;
        const replacement = replacementPatches.get(patch.id) || null;
        const effectivePatch = replacement ? { ...patch, localPath: replacement.localPath } : patch;
        const current = await inspectRepository(repository.path);
        applicationContexts.set(repository.id, replacement ? {
          contextHead: replacement.appliedState.contextHead || null,
          contextWasClean: Boolean(replacement.appliedState.contextWasClean),
        } : {
          contextHead: current.baseCommit || null,
          contextWasClean: current.isClean,
        });

        const body = await fs.readFile(effectivePatch.localPath);
        if (body.length === 0) continue;

        if (replacement) {
          try {
            if (replacement.appliedState.indexApplied) {
              await runGit(repository.path, [
                'apply', '--check', '--index', '--binary', effectivePatch.localPath,
              ]);
            } else {
              await checkPatch(repository.path, effectivePatch.localPath);
            }
          } catch (error) {
            throw new ApplyConflictError(repository, error, false);
          }
          plan.push({
            repository,
            patch: effectivePatch,
            applyMode: 'direct',
            replacement: true,
            indexApplied: Boolean(replacement.appliedState.indexApplied),
            wasClean: current.isClean,
            headBefore: current.baseCommit,
          });
          continue;
        }

        const exactState = await matchesPackagedState(repository, current);
        if (!exactState && !current.isClean) {
          const previousConflict = task.result.conflicts?.find((item) => item.repositoryId === repository.id);
          throw new ApplyConflictError(repository, new Error(
            `${repository.name} has new uncommitted or unmerged changes since this task was packaged.`,
          ), previousConflict?.applyAttempted === true);
        }

        let applyMode = 'direct';
        try {
          await checkPatch(repository.path, effectivePatch.localPath);
        } catch (error) {
          if (exactState) throw new ApplyConflictError(repository, error, false);
          applyMode = 'three-way';
          try {
            await runGit(repository.path, [
              'apply', '--check', '--3way', '--binary', effectivePatch.localPath,
            ]);
          } catch (threeWayError) {
            throw new ApplyConflictError(repository, threeWayError, false);
          }
        }

        plan.push({
          repository,
          patch: effectivePatch,
          applyMode,
          replacement: false,
          indexApplied: applyMode === 'three-way',
          wasClean: current.isClean,
          headBefore: current.baseCommit,
        });
      }

      for (const item of plan) {
        try {
          await applyPatch(item.repository.path, item.patch.localPath, item.replacement
            ? { index: item.indexApplied }
            : item.applyMode === 'three-way'
              ? { threeWay: true, index: true }
              : {});
        } catch (error) {
          if (item.wasClean && item.headBefore) {
            await runGit(item.repository.path, ['reset', '--hard', item.headBefore]).catch(() => {});
          } else if (item.applyMode === 'three-way') {
            await runGit(item.repository.path, ['reset', '--mixed', '--quiet', 'HEAD']).catch(() => {});
          }
          throw new ApplyConflictError(item.repository, error, true);
        }
        applied.push(item);
      }

      if (task.treeId) {
        const commitMessage = validateCommitMessage(task.result.commitMessage);
        for (const item of applied) {
          await runGit(item.repository.path, ['add', '-A', '--', '.']);
          await runGit(item.repository.path, ['commit', '-m', commitMessage]);
          const { stdout } = await runGit(item.repository.path, ['rev-parse', 'HEAD']);
          committed.push({ ...item, commit: stdout.trim(), message: commitMessage });
        }
      }

      for (const [repositoryId, context] of applicationContexts) {
        const repository = task.repositories.find((item) => item.id === repositoryId);
        const appliedItem = applied.find((item) => item.repository.id === repositoryId);
        const previousState = task.appliedResult?.appliedRepositories
          ?.find((item) => item.repositoryId === repositoryId);
        const current = await inspectRepository(repository.path);
        appliedRepositories.push({
          repositoryId,
          ...context,
          headAfter: current.baseCommit || null,
          indexApplied: previousState
            ? Boolean(previousState.indexApplied)
            : appliedItem?.applyMode === 'three-way',
          fingerprintAfter: await fingerprintRepository(repository.path),
          indexFingerprintAfter: await fingerprintIndex(repository.path),
        });
      }
    } catch (error) {
      for (const item of [...committed].reverse()) {
        try {
          await runGit(item.repository.path, ['reset', '--hard', `${item.commit}^`]);
        } catch {
          // Preserve the original error and the worktree for manual recovery.
        }
      }
      for (const item of [...applied].reverse()) {
        if (committed.some((commit) => commit.repository.path === item.repository.path)) continue;
        try {
          if (item.wasClean && item.headBefore) {
            await runGit(item.repository.path, ['reset', '--hard', item.headBefore]);
          } else if (item.replacement) {
            await applyPatch(item.repository.path, item.patch.localPath, {
              reverse: true,
              index: item.indexApplied,
            });
          } else {
            await runGit(item.repository.path, ['reset', '--mixed', '--quiet', 'HEAD']).catch(() => {});
            await applyPatch(item.repository.path, item.patch.localPath, { reverse: true });
          }
        } catch {
          // Preserve the original error; the UI will point the user to the saved patch.
        }
      }

      if (error instanceof ApplyConflictError) {
        return this.markConflicted(
          task,
          error.repository,
          error.originalError,
          error.applyAttempted,
        );
      }

      task = await this.taskService.transitionTask(
        taskId,
        ['ready', 'failed', 'conflicted'],
        { state: 'failed', error: error.message },
        'record its apply failure',
      );
      await this.onEvent({ type: 'task-failed', task, message: error.message });
      throw error;
    }

    const previousCommits = Array.isArray(task.appliedResult?.commits) ? task.appliedResult.commits : [];
    const newCommits = committed.map(({ repository, commit, message }) => ({
      repositoryId: repository.id,
      commit,
      message,
    }));
    const appliedAt = new Date().toISOString();
    task = await this.taskService.transitionTask(taskId, ['ready', 'failed', 'conflicted'], {
      state: 'applied',
      appliedAt,
      error: null,
      appliedResult: null,
      result: {
        ...task.result,
        commits: [...previousCommits, ...newCommits],
        appliedRepositories,
      },
    }, 'mark its result applied');
    await this.onEvent({ type: 'task-applied', task });

    if (task.resolvesTaskId) {
      try {
        const originalTask = await this.taskService.getTask(task.resolvesTaskId);
        if (originalTask.state === 'conflicted') {
          const resolvedTask = await this.taskService.transitionTask(originalTask.taskId, ['conflicted'], {
            state: 'resolved',
            error: null,
            resolvedAt: appliedAt,
            resolutionTaskId: task.taskId,
          }, 'mark its conflict resolved');
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

  async rebindMissingResolutionTarget(task, requireResolutionTask = true) {
    if (!task?.treeId || (requireResolutionTask && !task?.resolvesTaskId)) return task;
    const writableRepository = (Array.isArray(task.repositories) ? task.repositories : [])
      .find((repository) => !repository.readOnly);
    if (!writableRepository) return task;
    const current = await inspectRepository(writableRepository.path).catch(() => null);
    if (current) return task;
    if (!task.sourceRepositoryPath) {
      throw new Error('The conflict-resolution worktree is unavailable and no original repository target was saved.');
    }
    const source = await inspectRepository(task.sourceRepositoryPath).catch(() => null);
    if (!source) {
      throw new Error('The conflict-resolution worktree was deleted and the original repository is unavailable.');
    }
    return this.taskService.setTarget(task.taskId, { repositoryPath: source.path, tree: null });
  }

  async markConflicted(task, repository, error, applyAttempted = false) {
    const files = await listConflictedFiles(repository.path).catch(() => []);
    const detail = String(error?.message || error || 'The patch did not apply cleanly.');
    const message = files.length
      ? `${repository.name} has merge conflicts in ${files.length} file${files.length === 1 ? '' : 's'}.`
      : `${repository.name} changed and the result could not be applied cleanly.`;
    const recovery = files.length > 0 || applyAttempted
      ? 'Clean up the target and retry the saved result, or resubmit a conflict-resolution task to preserve both versions.'
      : 'The workspace was left unchanged. Retry the saved result after updating the target, or use conflict resolution to preserve both versions.';
    const conflictedTask = await this.taskService.transitionTask(task.taskId, ['ready', 'failed', 'conflicted'], {
      state: 'conflicted',
      error: `${message} ${recovery}`,
      result: {
        ...task.result,
        conflicts: [{
          repositoryId: repository.id,
          repositoryName: repository.name,
          files,
          error: detail,
          applyAttempted: Boolean(applyAttempted),
        }],
      },
    }, 'record its apply conflict');
    await this.onEvent({ type: 'task-conflicted', task: conflictedTask, message });
    return conflictedTask;
  }

  async rollback(taskId) {
    if (this.activeTaskMutations.has(taskId)) {
      throw new Error('This task result is already being changed.');
    }
    this.activeTaskMutations.add(taskId);
    try {
      let task = await this.taskService.getTask(taskId);
      if (task.state !== 'applied' || !task.result) throw new Error('This task has not been applied.');

      const reverts = [];
      if (task.result.commits?.length) {
        const latestCommits = new Map();
        for (const item of task.result.commits) latestCommits.set(item.repositoryId, item.commit);
        const appliedStates = new Map((task.result.appliedRepositories || [])
          .map((item) => [item.repositoryId, item]));
        for (const [repositoryId, latestCommit] of latestCommits) {
          const repository = task.repositories.find((entry) => entry.id === repositoryId);
          const current = await inspectRepository(repository.path);
          const appliedState = appliedStates.get(repositoryId);
          const fingerprintMatches = !appliedState?.fingerprintAfter
            || await fingerprintRepository(repository.path) === appliedState.fingerprintAfter;
          if (!current.isClean || current.baseCommit !== latestCommit || !fingerprintMatches) {
            throw new Error('The task target changed after this task was applied; revert it from Source Control instead.');
          }
        }
        for (const item of [...task.result.commits].reverse()) {
          const repository = task.repositories.find((entry) => entry.id === item.repositoryId);
          await runGit(repository.path, ['revert', '--no-edit', item.commit]);
          const { stdout } = await runGit(repository.path, ['rev-parse', 'HEAD']);
          reverts.push({ repositoryId: repository.id, commit: stdout.trim() });
        }
      } else {
        const appliedStates = new Map((task.result.appliedRepositories || [])
          .map((item) => [item.repositoryId, item]));
        for (const patch of [...task.result.patches].reverse()) {
          const repository = task.repositories.find((item) => item.id === patch.id);
          const body = await fs.readFile(patch.localPath);
          if (body.length === 0) continue;
          await applyPatch(repository.path, patch.localPath, {
            reverse: true,
            index: Boolean(appliedStates.get(repository.id)?.indexApplied),
          });
        }
      }
      task = await this.taskService.transitionTask(taskId, ['applied'], {
        state: 'rolled-back',
        rolledBackAt: new Date().toISOString(),
        result: { ...task.result, reverts },
      }, 'roll it back');
      await this.onEvent({ type: 'task-rolled-back', task });
      return task;
    } finally {
      this.activeTaskMutations.delete(taskId);
    }
  }
}

module.exports = { ResultService, parsePlainTextResult };
