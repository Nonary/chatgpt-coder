const fs = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { applyPatch, checkPatch, verifyHead } = require('./git');

const MAX_RESULT_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PATCH_BYTES = 64 * 1024 * 1024;

function safeArchivePath(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Result contains an invalid patch path.');
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized.startsWith('/') || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`Result contains an unsafe path: ${value}`);
  }
  return normalized;
}

class ResultService {
  constructor(taskService, onEvent = () => {}) {
    this.taskService = taskService;
    this.onEvent = onEvent;
  }

  async ingest(taskId, downloadedPath) {
    const task = await this.taskService.getTask(taskId);
    await this.onEvent({ type: 'result-processing', taskId, message: 'Validating the downloaded result…' });

    try {
      const result = downloadedPath.toLowerCase().endsWith('.zip')
        ? await this.readZipResult(task, downloadedPath)
        : await this.readSinglePatchResult(task, downloadedPath);
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

  async readZipResult(task, downloadedPath) {
    const archiveStat = await fs.stat(downloadedPath);
    if (archiveStat.size > MAX_RESULT_BYTES) {
      throw new Error('The downloaded result is larger than the 128 MB safety limit.');
    }
    const zip = new AdmZip(downloadedPath);
    const manifestEntry = zip.getEntry('result.json');
    if (!manifestEntry) throw new Error('The downloaded ZIP does not contain result.json at its root.');
    if (manifestEntry.header.size > MAX_MANIFEST_BYTES) throw new Error('result.json is unexpectedly large.');
    const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
    if (manifest.schemaVersion !== 1) throw new Error(`Unsupported result schema: ${manifest.schemaVersion}`);
    if (manifest.taskId !== task.taskId) throw new Error('This result belongs to a different Patchwork task.');
    if (manifest.status !== 'completed') throw new Error(`ChatGPT returned task status: ${manifest.status}`);
    if (!Array.isArray(manifest.repositories)) throw new Error('Result manifest has no repository list.');

    const resultDir = path.join(this.taskService.taskDirectory(task.taskId), 'result');
    await fs.mkdir(resultDir, { recursive: true });
    const patches = [];
    for (const item of manifest.repositories) {
      const patchFile = safeArchivePath(item.patchFile);
      const entry = zip.getEntry(patchFile);
      if (!entry) throw new Error(`Result is missing ${patchFile}.`);
      if (entry.header.size > MAX_PATCH_BYTES) throw new Error(`${patchFile} exceeds the 64 MB patch limit.`);
      const outputName = `${item.id}.patch`;
      const outputPath = path.join(resultDir, outputName);
      await fs.writeFile(outputPath, entry.getData());
      patches.push({
        id: item.id,
        baseCommit: item.baseCommit,
        patchFile,
        localPath: outputPath,
      });
    }
    return {
      summary: String(manifest.summary || '').trim(),
      downloadedPath,
      patches,
    };
  }

  async readSinglePatchResult(task, downloadedPath) {
    if (task.repositories.length !== 1) {
      throw new Error('A raw patch can only be used for a task containing one repository.');
    }
    const repository = task.repositories[0];
    const resultDir = path.join(this.taskService.taskDirectory(task.taskId), 'result');
    await fs.mkdir(resultDir, { recursive: true });
    const outputPath = path.join(resultDir, `${repository.id}.patch`);
    await fs.copyFile(downloadedPath, outputPath);
    return {
      summary: 'Patch downloaded from ChatGPT.',
      downloadedPath,
      patches: [{ id: repository.id, baseCommit: repository.baseCommit, localPath: outputPath }],
    };
  }

  async validate(task, result) {
    const expectedIds = new Set(task.repositories.map((repository) => repository.id));
    const actualIds = new Set(result.patches.map((patch) => patch.id));
    if (expectedIds.size !== actualIds.size || [...expectedIds].some((id) => !actualIds.has(id))) {
      throw new Error('The result repository list does not match the original task package.');
    }

    const previews = [];
    for (const patch of result.patches) {
      const repository = task.repositories.find((item) => item.id === patch.id);
      if (!repository) throw new Error(`Unknown repository in result: ${patch.id}`);
      if (patch.baseCommit !== repository.baseCommit) {
        throw new Error(`${repository.name} patch targets the wrong base commit.`);
      }
      await verifyHead(repository);
      const patchBody = await fs.readFile(patch.localPath, 'utf8');
      if (patchBody.length === 0) {
        previews.push({ ...patch, name: repository.name, stat: 'No changes', numstat: '', preview: '' });
        continue;
      }
      const stats = await checkPatch(repository.path, patch.localPath);
      previews.push({
        ...patch,
        name: repository.name,
        ...stats,
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
    if (!task.result || !['ready', 'failed'].includes(task.state)) {
      if (task.state === 'applied') return task;
      throw new Error('This result is not ready to apply.');
    }

    const applied = [];
    try {
      for (const patch of task.result.patches) {
        const repository = task.repositories.find((item) => item.id === patch.id);
        await verifyHead(repository);
        const body = await fs.readFile(patch.localPath);
        if (body.length === 0) continue;
        await checkPatch(repository.path, patch.localPath);
      }
      for (const patch of task.result.patches) {
        const repository = task.repositories.find((item) => item.id === patch.id);
        const body = await fs.readFile(patch.localPath);
        if (body.length === 0) continue;
        await applyPatch(repository.path, patch.localPath);
        applied.push({ repository, patch });
      }
    } catch (error) {
      for (const item of applied.reverse()) {
        try {
          await applyPatch(item.repository.path, item.patch.localPath, true);
        } catch {
          // Preserve the original error; the UI will point the user to the saved patch.
        }
      }
      task = await this.taskService.updateTask(taskId, { state: 'failed', error: error.message });
      await this.onEvent({ type: 'task-failed', task, message: error.message });
      throw error;
    }

    task = await this.taskService.updateTask(taskId, {
      state: 'applied',
      appliedAt: new Date().toISOString(),
      error: null,
    });
    await this.onEvent({ type: 'task-applied', task });
    return task;
  }

  async rollback(taskId) {
    let task = await this.taskService.getTask(taskId);
    if (task.state !== 'applied' || !task.result) throw new Error('This task has not been applied.');

    for (const patch of [...task.result.patches].reverse()) {
      const repository = task.repositories.find((item) => item.id === patch.id);
      const body = await fs.readFile(patch.localPath);
      if (body.length === 0) continue;
      await applyPatch(repository.path, patch.localPath, true);
    }
    task = await this.taskService.updateTask(taskId, {
      state: 'rolled-back',
      rolledBackAt: new Date().toISOString(),
    });
    await this.onEvent({ type: 'task-rolled-back', task });
    return task;
  }
}

module.exports = { ResultService, safeArchivePath };
