const chatgpt = require('./chatgpt/api');
const composer = require('./chatgpt/composer');
const navigate = require('./chatgpt/navigate');
const modelPicker = require('./chatgpt/model-picker');
const notices = require('./chatgpt/notices');
const resultScan = require('./chatgpt/result-scan');
const { beginEnforcement } = require('./chatgpt/intercept');
const {
  CHATGPT_ORIGIN,
  conversationIdFromRouteUrl,
  mergeTreeId,
  normalizeConversationStreamStatus,
  normalizeConversationTitle,
  resultTaskId,
  taskRequestConfiguration,
} = require('../../shared/chatgpt');

const MONITOR_INTERVAL_MILLISECONDS = 2_500;
const CONVERSATION_SWEEP_MILLISECONDS = 15_000;
const MAX_SUBMISSION_RETRIES = 2;

function toFile(buffer, name, type) {
  return new File([buffer], name, { type: type || 'application/octet-stream' });
}

function packageFilename(task) {
  return String(task.packagePath || '').split(/[\\/]/).pop() || `chatgpt-ide-task-${task.taskId}.zip`;
}

// Everything that used to live in the Electron main process now runs here, in the
// same JavaScript realm as ChatGPT itself.
class Driver {
  constructor({ api, report }) {
    this.api = api;
    this.report = report || (() => {});
    this.activeTaskId = null;
    this.activeMerge = null;
    this.monitorTimer = null;
    this.lastConversationSweepAt = 0;
    this.busy = false;
  }

  start() {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(() => {
      this.monitor().catch(() => {});
    }, MONITOR_INTERVAL_MILLISECONDS);
  }

  stop() {
    clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }

  async submitTask(task, { project = null } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_SUBMISSION_RETRIES; attempt += 1) {
      try {
        return await this.submitTaskOnce(task, { project, attempt });
      } catch (error) {
        lastError = error;
        if (!error.retrySubmission || attempt >= MAX_SUBMISSION_RETRIES) break;
        this.report({
          type: 'automation-retry',
          taskId: task.taskId,
          message: `${error.message} Reopening a fresh composer and retrying (${attempt + 1}/${MAX_SUBMISSION_RETRIES}).`,
        });
        await navigate.openFreshChat(project || task.chatgptProject);
      }
    }
    await this.api.taskFailed(task.taskId, lastError.message).catch(() => {});
    throw lastError;
  }

  async submitTaskOnce(task, { project = null, attempt = 0 } = {}) {
    this.activeTaskId = task.taskId;
    this.activeMerge = null;
    const destination = project === undefined ? task.chatgptProject : (project || task.chatgptProject);
    this.report({
      type: 'automation-started',
      taskId: task.taskId,
      message: task.summaryOnly
        ? 'Opening a ChatGPT chat for the Git Summary request…'
        : 'Opening a ChatGPT chat for this task…',
    });

    if (attempt === 0) await navigate.openFreshChat(destination);
    if (!await composer.waitForComposer()) {
      throw new Error('ChatGPT is not ready. Sign in and try again.');
    }

    // The composer's Patchwork picker is the live source of truth: whatever it
    // shows when Send fires is what the request is rewritten to.
    modelPicker.setSelection({ model: task.model, reasoningMode: task.reasoningMode });
    await modelPicker.installWhenReady({
      taskId: task.taskId,
      model: task.model,
      reasoningMode: task.reasoningMode,
      keepSelection: true,
    }).catch((error) => {
      this.report({ type: 'automation-progress', taskId: task.taskId, message: error.message });
    });

    const enforcement = beginEnforcement({
      configuration: () => {
        const selected = modelPicker.currentSelection();
        return {
          ...taskRequestConfiguration(selected.model, selected.reasoningMode),
          source: modelPicker.isInstalled() ? 'patchwork-selector' : 'saved-task',
        };
      },
      packageFilename: packageFilename(task),
    });

    let verified;
    try {
      composer.setPrompt(task.handoffPrompt);

      this.report({ type: 'automation-progress', taskId: task.taskId, message: 'Attaching the task package…' });
      const zipName = packageFilename(task);
      const zipBytes = await this.api.taskPackage(task.taskId);
      await composer.attachFile(toFile(zipBytes, zipName, 'application/zip'));
      await composer.waitForAttachment(zipName);

      for (const attachment of task.attachments || []) {
        const bytes = await this.api.taskAttachment(task.taskId, attachment.name);
        await composer.attachFile(toFile(bytes, attachment.name));
        await composer.waitForAttachment(attachment.name);
      }

      this.report({ type: 'automation-progress', taskId: task.taskId, message: 'Sending the task to ChatGPT…' });
      await composer.clickSend({
        isConversationOpen: () => Boolean(conversationIdFromRouteUrl(location.href)),
      });
      verified = await enforcement.wait();
    } finally {
      enforcement.dispose();
    }

    this.report({
      type: 'task-request-verified',
      taskId: task.taskId,
      message: `Verified ChatGPT request from ${verified.selectionSource === 'patchwork-selector' ? 'the composer picker' : 'the saved task'}: ${verified.model}${verified.thinkingEffort ? ` · ${verified.thinkingEffort}` : ''}.`,
    });

    // ChatGPT's own send request answers with an event stream that names the new
    // conversation, so the id is known before the SPA route catches up.
    const streamedId = await Promise.resolve(verified.conversationId).catch(() => null);
    const routeUrl = await navigate.waitForConversationUrl(streamedId ? 8_000 : 45_000);
    const conversationUrl = routeUrl || (streamedId ? `${CHATGPT_ORIGIN}/c/${streamedId}` : null);
    if (!conversationUrl) {
      throw new Error('Patchwork could not confirm a ChatGPT conversation after Send.');
    }
    const { task: submitted } = await this.api.taskSubmitted(task.taskId, {
      conversationUrl,
      conversationId: conversationIdFromRouteUrl(conversationUrl) || streamedId,
      conversationTitle: normalizeConversationTitle(document.title),
      model: verified.selectedModel,
      reasoningMode: verified.selectedReasoningMode,
    });
    this.activeTaskId = submitted.taskId;
    this.start();
    return submitted;
  }

  async submitMerge(request) {
    this.activeTaskId = null;
    this.activeMerge = { treeId: request.treeId, resultFilename: request.resultFilename };
    await navigate.openFreshChat(request.chatgptProject);
    if (!await composer.waitForComposer()) {
      throw new Error('ChatGPT is not ready. Sign in and try again.');
    }
    composer.setPrompt(request.prompt);
    await composer.clickSend({
      isConversationOpen: () => Boolean(conversationIdFromRouteUrl(location.href)),
    });
    const conversationUrl = await navigate.waitForConversationUrl();
    const { tree } = await this.api.treeMergeSubmitted(request.treeId, conversationUrl);
    this.activeMerge = {
      treeId: request.treeId,
      resultFilename: request.resultFilename,
      conversationId: conversationIdFromRouteUrl(conversationUrl),
    };
    this.start();
    return tree;
  }

  conversationIdFor(record) {
    return record?.conversationId
      || conversationIdFromRouteUrl(record?.conversationUrl)
      || conversationIdFromRouteUrl(location.href);
  }

  async monitor() {
    if (this.busy) return;
    this.busy = true;
    try {
      notices.dismissBlockingLimitNotice();
      await this.monitorActiveTask();
      await this.monitorActiveMerge();
    } finally {
      this.busy = false;
    }
  }

  async monitorActiveTask() {
    if (!this.activeTaskId) return;
    const { task } = await this.api.task(this.activeTaskId).catch(() => ({ task: null }));
    if (!task) {
      this.activeTaskId = null;
      return;
    }
    if (task.state !== 'submitted') {
      if (['applied', 'ready', 'failed', 'conflicted', 'completed', 'resolved'].includes(task.state)) {
        this.activeTaskId = null;
      }
      return;
    }

    const conversationId = this.conversationIdFor(task);
    if (!conversationId) return;

    const status = await chatgpt.streamStatus(conversationId).catch(() => null);
    if (status?.ok && status.status) {
      const normalized = normalizeConversationStreamStatus(status.status);
      if (normalized !== task.chatStatus || status.status !== task.chatStatusRaw) {
        await this.api.taskChatStatus(task.taskId, { status: status.status, conversationId }).catch(() => {});
      }
      const finished = normalized !== 'streaming';
      const sweepDue = Date.now() - this.lastConversationSweepAt >= CONVERSATION_SWEEP_MILLISECONDS;
      if (!finished && !sweepDue) return;
    }

    this.lastConversationSweepAt = Date.now();
    await this.ingestTaskResult(task, conversationId).catch((error) => {
      this.report({ type: 'task-result-error', taskId: task.taskId, message: error.message });
    });
  }

  async ingestTaskResult(task, conversationId) {
    const expectedName = String(task.resultFilename || `chatgpt-ide-result-${task.taskId}.txt`);
    const expected = expectedName.toLowerCase();
    const record = await chatgpt.conversation(conversationId).catch(() => null);
    const file = (record && chatgpt.findGeneratedFile(record, (candidate) => {
      const name = candidate.name.toLowerCase();
      return name === expected || resultTaskId(name) === String(task.taskId).toLowerCase();
    }))
      // The rendered transcript carries the same file id, so a changed or
      // unavailable conversation endpoint does not strand a finished task.
      || (!resultScan.isGenerating() ? resultScan.findResultFileInDom(expectedName) : null);
    if (!file) return null;
    this.report({
      type: 'result-downloading',
      taskId: task.taskId,
      message: `Downloading ${file.name}…`,
    });
    const text = await chatgpt.downloadFileText(file.id);
    const { task: updated } = await this.api.taskResult(task.taskId, text);
    this.activeTaskId = updated.state === 'submitted' ? updated.taskId : null;
    return updated;
  }

  // Used by Retry apply: re-reads the saved conversation before reapplying.
  async refreshTaskResult(task) {
    const conversationId = this.conversationIdFor(task);
    if (!conversationId) throw new Error('This task has no ChatGPT conversation to re-read.');
    const updated = await this.ingestTaskResult(task, conversationId);
    if (!updated) throw new Error('That ChatGPT conversation does not contain a Patchwork result file yet.');
    return updated;
  }

  async monitorActiveMerge() {
    if (!this.activeMerge) return;
    const conversationId = this.activeMerge.conversationId || conversationIdFromRouteUrl(location.href);
    if (!conversationId) return;
    const status = await chatgpt.streamStatus(conversationId).catch(() => null);
    if (status?.ok && normalizeConversationStreamStatus(status.status) === 'streaming') return;

    const expectedName = String(this.activeMerge.resultFilename || '');
    const expected = expectedName.toLowerCase();
    const record = await chatgpt.conversation(conversationId).catch(() => null);
    const file = (record && chatgpt.findGeneratedFile(record, (candidate) => {
      const name = candidate.name.toLowerCase();
      return name === expected || mergeTreeId(name) === String(this.activeMerge.treeId).toLowerCase();
    }))
      || (!resultScan.isGenerating() ? resultScan.findResultFileInDom(expectedName) : null);
    if (!file) return;
    const treeId = this.activeMerge.treeId;
    this.activeMerge = null;
    const text = await chatgpt.downloadFileText(file.id);
    await this.api.treeMergeResult(treeId, text);
  }

  adoptTask(task) {
    this.activeTaskId = task?.state === 'submitted' ? task.taskId : this.activeTaskId;
    if (this.activeTaskId) this.start();
  }

  adoptMerge(tree) {
    if (tree?.mergeState !== 'submitted') return;
    this.activeMerge = {
      treeId: tree.id,
      resultFilename: `chatgpt-ide-merge-result-${tree.id}.txt`,
      conversationId: conversationIdFromRouteUrl(tree.mergeConversationUrl),
    };
    this.start();
  }
}

module.exports = { Driver, MONITOR_INTERVAL_MILLISECONDS, packageFilename, toFile };
