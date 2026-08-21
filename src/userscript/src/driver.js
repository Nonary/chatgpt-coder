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
  normalizeConversationTitle,
  resultTaskId,
  taskRequestConfiguration,
} = require('../../shared/chatgpt');

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
    this.watchGeneration = 0;
    this.stopDomWatch = null;
  }

  stop() {
    this.watchGeneration += 1;
    this.stopDomWatch?.();
    this.stopDomWatch = null;
  }

  async submitTask(task, { project = undefined } = {}) {
    const destination = project === undefined ? task.chatgptProject : project;
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_SUBMISSION_RETRIES; attempt += 1) {
      try {
        return await this.submitTaskOnce(task, { project: destination, attempt });
      } catch (error) {
        lastError = error;
        if (!error.retrySubmission || attempt >= MAX_SUBMISSION_RETRIES) break;
        this.report({
          type: 'automation-retry',
          taskId: task.taskId,
          message: `${error.message} Reopening a fresh composer and retrying (${attempt + 1}/${MAX_SUBMISSION_RETRIES}).`,
        });
        await navigate.openFreshChat(destination, { taskId: task.taskId });
      }
    }
    await this.api.taskFailed(task.taskId, lastError.message).catch(() => {});
    throw lastError;
  }

  async submitTaskOnce(task, { project = null, attempt = 0 } = {}) {
    notices.dismissBlockingLimitNotice();
    this.activeTaskId = task.taskId;
    this.activeMerge = null;
    const destination = project;
    this.report({
      type: 'automation-started',
      taskId: task.taskId,
      message: task.summaryOnly
        ? 'Opening a chat for the Git Summary request…'
        : 'Opening a chat for this task…',
    });

    if (attempt === 0) await navigate.openFreshChat(destination, { taskId: task.taskId });
    if (!await composer.waitForComposer()) {
      throw new Error('Not signed in. Sign in and try again.');
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
      // Supporting files are already bundled under attachments/. Uploading them a
      // second time can make ChatGPT reject types such as .patch and stall Send.

      this.report({ type: 'automation-progress', taskId: task.taskId, message: 'Sending the task…' });
      await composer.clickSend({
        isConversationOpen: () => Boolean(conversationIdFromRouteUrl(location.href)),
      });
      const routeConfirmation = navigate.waitForConversationUrl().then(async (conversationUrl) => {
        if (!conversationUrl) return new Promise(() => {});
        // Give the request interceptor one turn to report a verified request or
        // a hard attachment failure before accepting navigation as proof that
        // ChatGPT sent the task through a transport the page wrapper could not see.
        await composer.delay(250);
        const selected = modelPicker.currentSelection();
        return {
          ok: true,
          requestVerified: false,
          conversationUrl,
          conversationId: conversationIdFromRouteUrl(conversationUrl),
          selectedModel: selected.model,
          selectedReasoningMode: selected.reasoningMode,
          selectionSource: modelPicker.isInstalled() ? 'patchwork-selector' : 'saved-task',
        };
      });
      verified = await enforcement.wait(45_000, routeConfirmation);
    } finally {
      enforcement.dispose();
    }

    if (verified.requestVerified === false) {
      this.report({
        type: 'task-request-unverified',
        taskId: task.taskId,
        message: 'The conversation opened, but the outgoing request could not be inspected. Continuing to monitor the task result.',
      });
    } else {
      this.report({
        type: 'task-request-verified',
        taskId: task.taskId,
        message: `Verified request from ${verified.selectionSource === 'patchwork-selector' ? 'the composer picker' : 'the saved task'}: ${verified.model}${verified.thinkingEffort ? ` · ${verified.thinkingEffort}` : ''}.`,
      });
    }

    // ChatGPT's own send request answers with an event stream that names the new
    // conversation, so the id is known before the SPA route catches up.
    const streamedId = await Promise.resolve(verified.conversationId).catch(() => null);
    const routeUrl = verified.conversationUrl
      || await navigate.waitForConversationUrl(streamedId ? 8_000 : 45_000);
    const conversationUrl = routeUrl || (streamedId ? `${CHATGPT_ORIGIN}/c/${streamedId}` : null);
    if (!conversationUrl) {
      throw new Error('No conversation could be confirmed after Send.');
    }
    const { task: submitted } = await this.api.taskSubmitted(task.taskId, {
      conversationUrl,
      conversationId: conversationIdFromRouteUrl(conversationUrl) || streamedId,
      conversationTitle: normalizeConversationTitle(document.title),
      model: verified.selectedModel,
      reasoningMode: verified.selectedReasoningMode,
    });
    this.activeTaskId = submitted.taskId;
    this.watchTask(submitted, { responseComplete: verified.responseComplete });
    return submitted;
  }

  async submitMerge(request) {
    this.activeTaskId = null;
    this.activeMerge = { treeId: request.treeId, resultFilename: request.resultFilename };
    await navigate.openFreshChat(request.chatgptProject, { merge: request });
    if (!await composer.waitForComposer()) {
      throw new Error('Not signed in. Sign in and try again.');
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
    this.watchMerge();
    return tree;
  }

  conversationIdFor(record) {
    return record?.conversationId
      || conversationIdFromRouteUrl(record?.conversationUrl)
      || conversationIdFromRouteUrl(location.href);
  }

  async reconcileTask(task, { knownStatus = null, record = undefined } = {}) {
    const conversationId = this.conversationIdFor(task);
    if (!conversationId) return;
    const conversationRecord = record === undefined
      ? await chatgpt.conversation(conversationId).catch(() => null)
      : record;
    const status = chatgpt.conversationCompletionStatus(conversationRecord) || knownStatus;
    let statusTask = null;
    if (status) {
      const result = await this.api.taskChatStatus(task.taskId, { status, conversationId }).catch(() => null);
      statusTask = result?.task || null;
    }
    if (task.answerOnly) {
      if (!status) return null;
      this.activeTaskId = null;
      return statusTask || task;
    }
    return this.ingestTaskResult(statusTask || task, conversationId, conversationRecord).catch((error) => {
      this.report({ type: 'task-result-error', taskId: task.taskId, message: error.message });
      return null;
    });
  }

  async refreshTask(task) {
    const conversationId = this.conversationIdFor(task);
    if (!conversationId) {
      throw new Error('Open the manually submitted ChatGPT conversation, then refresh this task.');
    }
    const record = await chatgpt.conversation(conversationId);
    let tracked = task;
    if (task.state !== 'submitted') {
      const expectedPackage = packageFilename(task);
      if (!chatgpt.conversationHasAttachment(record, expectedPackage)) {
        throw new Error(`The open conversation does not contain this task package (${expectedPackage}).`);
      }
      const currentConversationId = conversationIdFromRouteUrl(location.href);
      const conversationUrl = currentConversationId === conversationId
        ? location.href
        : task.conversationUrl || `${CHATGPT_ORIGIN}/c/${conversationId}`;
      const { task: submitted } = await this.api.taskSubmitted(task.taskId, {
        conversationUrl,
        conversationId,
        conversationTitle: normalizeConversationTitle(document.title),
        model: task.model,
        reasoningMode: task.reasoningMode,
      });
      tracked = submitted;
    }

    const updated = await this.reconcileTask(tracked, { record });
    const latest = updated || (await this.api.task(tracked.taskId)).task;
    if (latest.state === 'submitted') this.watchTask(latest);
    return latest;
  }

  async ingestTaskResult(task, conversationId, record = undefined) {
    const expectedName = String(task.resultFilename || `chatgpt-ide-result-${task.taskId}.txt`);
    const expected = expectedName.toLowerCase();
    const conversationRecord = record === undefined
      ? await chatgpt.conversation(conversationId).catch(() => null)
      : record;
    const file = (conversationRecord && chatgpt.findGeneratedFile(conversationRecord, (candidate) => {
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
    const text = await chatgpt.downloadFileText(file, conversationId);
    const { task: updated } = await this.api.taskResult(task.taskId, text);
    this.activeTaskId = updated.state === 'submitted' ? updated.taskId : null;
    return updated;
  }

  async ingestDomResult(task, file) {
    const text = await chatgpt.downloadFileText(file);
    const { task: updated } = await this.api.taskResult(task.taskId, text);
    this.activeTaskId = updated.state === 'submitted' ? updated.taskId : null;
    return updated;
  }

  watchTask(task, { responseComplete = null, recovery = false } = {}) {
    if (!task || task.state !== 'submitted') return;
    this.stop();
    this.activeTaskId = task.taskId;
    const generation = this.watchGeneration;
    const conversationId = this.conversationIdFor(task);
    const expectedName = String(task.resultFilename || `chatgpt-ide-result-${task.taskId}.txt`);
    let settled = false;

    const finish = async () => {
      if (settled || generation !== this.watchGeneration) return;
      settled = true;
      this.stopDomWatch?.();
      this.stopDomWatch = null;
      const updated = await this.reconcileTask(task, { knownStatus: 'completed' });
      if (!updated && !task.answerOnly && generation === this.watchGeneration) {
        settled = false;
        this.stopDomWatch = resultScan.observeConversation({
          expectedName,
          onResult: (file) => {
            if (generation !== this.watchGeneration) return;
            settled = true;
            this.ingestDomResult(task, file).catch((error) => {
              this.report({ type: 'task-result-error', taskId: task.taskId, message: error.message });
            });
          },
        });
      }
    };

    this.stopDomWatch = resultScan.observeConversation({
      expectedName: task.answerOnly ? null : expectedName,
      onFinished: finish,
      onResult: task.answerOnly ? null : (file) => {
        if (settled || generation !== this.watchGeneration) return;
        settled = true;
        this.ingestDomResult(task, file).catch((error) => {
          this.report({ type: 'task-result-error', taskId: task.taskId, message: error.message });
        });
      },
    });

    if (responseComplete) Promise.resolve(responseComplete).then((complete) => {
      if (complete) finish();
    });
    if (recovery) {
      // Recovery is a single reconciliation read. If the conversation is still
      // open, the DOM observer above will finish the task without API polling.
      this.reconcileTask(task).then((updated) => {
        if (updated) this.stop();
      }).catch(() => {});
    }
  }

  // Used by Retry apply: re-reads the saved conversation before reapplying.
  async refreshTaskResult(task) {
    const conversationId = this.conversationIdFor(task);
    if (!conversationId) throw new Error('This task has no conversation to re-read.');
    const updated = await this.ingestTaskResult(task, conversationId);
    if (!updated) throw new Error('That conversation does not contain a result file yet.');
    return updated;
  }

  async reconcileMerge() {
    if (!this.activeMerge) return null;
    const conversationId = this.activeMerge.conversationId || conversationIdFromRouteUrl(location.href);
    if (!conversationId) return null;

    const expectedName = String(this.activeMerge.resultFilename || '');
    const expected = expectedName.toLowerCase();
    const record = await chatgpt.conversation(conversationId).catch(() => null);
    const file = (record && chatgpt.findGeneratedFile(record, (candidate) => {
      const name = candidate.name.toLowerCase();
      return name === expected || mergeTreeId(name) === String(this.activeMerge.treeId).toLowerCase();
    }))
      || (!resultScan.isGenerating() ? resultScan.findResultFileInDom(expectedName) : null);
    if (!file) return null;
    const treeId = this.activeMerge.treeId;
    this.activeMerge = null;
    const text = await chatgpt.downloadFileText(file, conversationId);
    await this.api.treeMergeResult(treeId, text);
    return true;
  }

  watchMerge({ recovery = false } = {}) {
    if (!this.activeMerge) return;
    this.stop();
    const generation = this.watchGeneration;
    const expectedName = this.activeMerge.resultFilename;
    this.stopDomWatch = resultScan.observeConversation({
      expectedName,
      onFinished: () => this.reconcileMerge().catch(() => {}),
      onResult: (file) => {
        if (generation !== this.watchGeneration || !this.activeMerge) return;
        const treeId = this.activeMerge.treeId;
        this.activeMerge = null;
        chatgpt.downloadFileText(file)
          .then((text) => this.api.treeMergeResult(treeId, text))
          .catch(() => {});
      },
    });
    if (recovery) this.reconcileMerge().catch(() => {});
  }

  adoptTask(task) {
    if (task?.state === 'submitted') this.watchTask(task, { recovery: true });
  }

  adoptMerge(tree) {
    if (tree?.mergeState !== 'submitted') return;
    this.activeMerge = {
      treeId: tree.id,
      resultFilename: `chatgpt-ide-merge-result-${tree.id}.txt`,
      conversationId: conversationIdFromRouteUrl(tree.mergeConversationUrl),
    };
    this.watchMerge({ recovery: true });
  }
}

module.exports = { Driver, packageFilename, toFile };
