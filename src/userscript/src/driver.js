const chatgpt = require('./chatgpt/api');
const composer = require('./chatgpt/composer');
const navigate = require('./chatgpt/navigate');
const modelPicker = require('./chatgpt/model-picker');
const notices = require('./chatgpt/notices');
const resultScan = require('./chatgpt/result-scan');
const { conversationTitleFromDom, observeConversationTitle } = require('./chatgpt/conversation-title');
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

function activeFollowUp(task) {
  if (!task?.activeTurnId || !Array.isArray(task.turns)) return null;
  return task.turns.find((turn) => turn.id === task.activeTurnId) || null;
}

function turnStartMilliseconds(turn) {
  const value = Date.parse(turn?.submittedAt || turn?.createdAt || '');
  return Number.isFinite(value) ? value : null;
}

function resultFileCreatedMilliseconds(file) {
  const raw = Number(file?.createTime);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw > 100000000000 ? raw : raw * 1000;
}

function resultFileFreshForTurn(file, turn, toleranceMilliseconds = 5000) {
  const startedAt = turnStartMilliseconds(turn);
  const createdAt = resultFileCreatedMilliseconds(file);
  if (!Number.isFinite(startedAt) || createdAt == null) return true;
  return createdAt >= startedAt - toleranceMilliseconds;
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
    this.stopConversationTitleWatch = null;
    this.seenTaskResultFiles = new Map();
  }

  stop() {
    this.watchGeneration += 1;
    this.stopDomWatch?.();
    this.stopDomWatch = null;
    this.stopConversationTitleWatch?.();
    this.stopConversationTitleWatch = null;
  }

  forgetTask(taskId) {
    if (this.activeTaskId === taskId) {
      this.stop();
      this.activeTaskId = null;
    }
    this.seenTaskResultFiles.delete(taskId);
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
      conversationTitle: conversationTitleFromDom(
        conversationIdFromRouteUrl(conversationUrl) || streamedId,
      ) || normalizeConversationTitle(document.title),
      model: verified.selectedModel,
      reasoningMode: verified.selectedReasoningMode,
    });
    this.activeTaskId = submitted.taskId;
    this.watchTask(submitted, { responseComplete: verified.responseComplete });
    return submitted;
  }

  async submitFollowUp(task, turn, files = []) {
    if (!turn || turn.id !== task?.activeTurnId) {
      throw new Error('The follow-up turn is no longer active. Refresh the task and try again.');
    }
    const conversationId = this.conversationIdFor(task);
    if (!conversationId) throw new Error('This task has no ChatGPT conversation for the follow-up.');

    notices.dismissBlockingLimitNotice();
    this.stop();
    this.activeTaskId = task.taskId;
    this.activeMerge = null;
    const conversationUrl = task.conversationUrl || `${CHATGPT_ORIGIN}/c/${conversationId}`;
    const existingRecord = await chatgpt.conversation(conversationId).catch(() => null);
    this.primeTaskResultFiles(task, existingRecord);
    let sendStarted = false;
    let verified = null;
    let enforcement = null;
    try {
      await navigate.openConversation(conversationUrl);
      if (!await composer.waitForComposer()) throw new Error('Not signed in. Sign in and try again.');

      modelPicker.setSelection({ model: turn.model, reasoningMode: turn.reasoningMode });
      await modelPicker.installWhenReady({
        taskId: task.taskId,
        model: turn.model,
        reasoningMode: turn.reasoningMode,
        keepSelection: true,
      }).catch((error) => {
        this.report({ type: 'automation-progress', taskId: task.taskId, message: error.message });
      });

      enforcement = beginEnforcement({
        configuration: () => {
          const selected = modelPicker.currentSelection();
          return {
            ...taskRequestConfiguration(selected.model, selected.reasoningMode),
            source: modelPicker.isInstalled() ? 'patchwork-follow-up-selector' : 'saved-follow-up',
          };
        },
      });
      composer.setPrompt(turn.resolvedPrompt || turn.prompt);
      for (const file of files) {
        this.report({ type: 'automation-progress', taskId: task.taskId, message: `Attaching ${file.name}…` });
        await composer.attachFile(file);
        await composer.waitForAttachment(file.name);
      }
      this.report({ type: 'automation-progress', taskId: task.taskId, message: `Sending ${turn.mode === 'ask' ? 'Ask' : 'Agent'} follow-up…` });
      await composer.clickSend({
        isConversationOpen: () => conversationIdFromRouteUrl(location.href) === conversationId,
      });
      sendStarted = true;
      verified = await enforcement.wait(45_000);
    } catch (error) {
      enforcement?.dispose();
      if (!sendStarted) {
        await this.api.followUpFailed(task.taskId, turn.id, error.message).catch(() => {});
        throw error;
      }
      let recovered = await this.api.task(task.taskId).then((result) => result.task).catch(() => null);
      if (recovered) {
        const recoveredTurn = activeFollowUp(recovered);
        if (recoveredTurn?.id === turn.id && recoveredTurn.state === 'created') {
          const promoted = await this.api.taskChatStatus(task.taskId, {
            status: 'streaming',
            conversationId,
          }).catch(() => null);
          if (promoted?.task) recovered = promoted.task;
        }
        this.report({
          type: 'automation-recovery',
          taskId: task.taskId,
          message: 'The follow-up send could not be fully acknowledged. Resuming from the saved turn.',
        });
        this.watchTask(recovered, { recovery: true });
        return recovered;
      }
      throw error;
    } finally {
      enforcement?.dispose();
    }

    const selectedModel = verified?.selectedModel || turn.model;
    const selectedReasoningMode = verified?.selectedReasoningMode || turn.reasoningMode;
    try {
      const { task: submitted } = await this.api.followUpSubmitted(task.taskId, turn.id, {
        conversationUrl,
        conversationId,
        model: selectedModel,
        reasoningMode: selectedReasoningMode,
      });
      this.activeTaskId = submitted.taskId;
      this.watchTask(submitted, { responseComplete: verified?.responseComplete || null });
      return submitted;
    } catch (error) {
      let recovered = await this.api.task(task.taskId).then((result) => result.task).catch(() => null);
      if (recovered) {
        const recoveredTurn = activeFollowUp(recovered);
        if (recoveredTurn?.id === turn.id && recoveredTurn.state === 'created') {
          const promoted = await this.api.taskChatStatus(task.taskId, {
            status: 'streaming',
            conversationId,
          }).catch(() => null);
          if (promoted?.task) recovered = promoted.task;
        }
        this.report({
          type: 'automation-recovery',
          taskId: task.taskId,
          message: 'The follow-up was sent, but persistence acknowledgement failed. Monitoring the saved task for completion.',
        });
        this.watchTask(recovered, { recovery: true });
        return recovered;
      }
      throw error;
    }
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

  canWatchTask(task) {
    const conversationId = task?.conversationId || conversationIdFromRouteUrl(task?.conversationUrl);
    if (!task || !conversationId) return false;
    const turn = activeFollowUp(task);
    if (turn) return ['created', 'submitted', 'awaiting-result'].includes(turn.state);
    return task.answerOnly ? task.state === 'submitted' : task.state === 'submitted';
  }

  watchConversationTitle(task) {
    const conversationId = this.conversationIdFor(task);
    if (!conversationId) return;
    this.stopConversationTitleWatch?.();
    this.stopConversationTitleWatch = null;

    const currentTitle = normalizeConversationTitle(task.conversationTitle);
    this.stopConversationTitleWatch = observeConversationTitle(conversationId, {
      initialTitle: currentTitle,
      onTitle: async (title) => {
        try {
          const { task: updated } = await this.api.taskTitle(task.taskId, {
            conversationId,
            title,
          });
          this.report({ type: 'task-renamed', task: updated });
          return true;
        } catch (error) {
          this.report({
            type: 'task-title-error',
            taskId: task.taskId,
            message: error.message,
          });
          return false;
        }
      },
    });
  }

  resultFileSet(taskId) {
    let files = this.seenTaskResultFiles.get(taskId);
    if (!files) {
      files = new Set();
      this.seenTaskResultFiles.set(taskId, files);
    }
    return files;
  }

  rememberResultFile(taskId, file) {
    const key = chatgpt.resultFileKey(file);
    if (key) this.resultFileSet(taskId).add(key);
  }

  hasSeenResultFile(taskId, file) {
    const key = chatgpt.resultFileKey(file);
    return Boolean(key && this.resultFileSet(taskId).has(key));
  }

  resultFileMatches(task, candidate) {
    const expectedName = String(task.resultFilename || `chatgpt-ide-result-${task.taskId}.txt`);
    const expected = expectedName.toLowerCase();
    const name = String(candidate?.name || '').toLowerCase();
    return name === expected || resultTaskId(name) === String(task.taskId).toLowerCase();
  }

  primeTaskResultFiles(task, conversationRecord) {
    const turn = activeFollowUp(task);
    if (!turn || turn.mode !== 'agent' || !conversationRecord) return;
    const files = chatgpt.findGeneratedFiles(
      conversationRecord,
      (candidate) => this.resultFileMatches(task, candidate),
    );
    // This snapshot was taken before the Send click, so every matching file
    // already present belongs to an earlier response and must be treated as seen.
    for (const file of files) this.rememberResultFile(task.taskId, file);
  }

  latestTaskResultFile(task, conversationRecord, { includeSeen = false } = {}) {
    let files = chatgpt.findGeneratedFiles(
      conversationRecord,
      (candidate) => this.resultFileMatches(task, candidate),
    );
    if (files.length === 0) return null;

    const turn = activeFollowUp(task);
    if (turn?.mode === 'agent') {
      for (const file of files) {
        if (!resultFileFreshForTurn(file, turn)) this.rememberResultFile(task.taskId, file);
      }
      files = files.filter((file) => resultFileFreshForTurn(file, turn));
    }
    if (files.length === 0) return null;

    const newest = files[0];
    // Follow-up results are cumulative, so when several accumulated while the
    // page was closed only the newest one should be ingested. Mark the older
    // generated files as consumed so a DOM fallback cannot regress the task.
    for (const older of files.slice(1)) this.rememberResultFile(task.taskId, older);
    const currentSourceKey = chatgpt.resultFileKey(task.result?.sourceFile);
    const newestKey = chatgpt.resultFileKey(newest);
    if (currentSourceKey && newestKey === currentSourceKey) this.rememberResultFile(task.taskId, newest);
    if (!includeSeen && this.hasSeenResultFile(task.taskId, newest)) return null;
    return newest;
  }

  async reconcileTask(task, { knownStatus = null, record = undefined } = {}) {
    const conversationId = this.conversationIdFor(task);
    if (!conversationId) return;
    const priorTurn = activeFollowUp(task);
    if (priorTurn?.state === 'created') return task;
    const conversationRecord = record === undefined
      ? await chatgpt.conversation(conversationId).catch(() => null)
      : record;
    const status = chatgpt.conversationCompletionStatus(conversationRecord) || knownStatus;
    let statusTask = task;
    if (status) {
      const result = await this.api.taskChatStatus(task.taskId, { status, conversationId }).catch(() => null);
      statusTask = result?.task || statusTask;
    }
    const turn = activeFollowUp(statusTask);
    if (priorTurn?.mode === 'ask') {
      if (!status || ['streaming'].includes(status)) return statusTask;
      this.activeTaskId = null;
      return statusTask;
    }
    if (turn?.mode === 'ask') {
      if (!status || ['streaming'].includes(status)) return statusTask;
      this.activeTaskId = null;
      return statusTask;
    }
    if (turn?.mode === 'agent') {
      if (status !== 'completed') return statusTask;
      return this.ingestTaskResult(statusTask, conversationId, conversationRecord).catch((error) => {
        this.report({ type: 'task-result-error', taskId: task.taskId, message: error.message });
        return this.api.task(task.taskId).then((result) => result.task).catch(() => null);
      });
    }
    if (statusTask.answerOnly) {
      if (!status) return null;
      this.activeTaskId = null;
      return statusTask;
    }
    if (status !== 'completed') return statusTask;
    return this.ingestTaskResult(statusTask, conversationId, conversationRecord).catch((error) => {
      this.report({ type: 'task-result-error', taskId: task.taskId, message: error.message });
      return this.api.task(task.taskId).then((result) => result.task).catch(() => null);
    });
  }

  async refreshTask(task) {
    const conversationId = this.conversationIdFor(task);
    if (!conversationId) {
      throw new Error('Open the manually submitted ChatGPT conversation, then refresh this task.');
    }
    const record = await chatgpt.conversation(conversationId);
    let tracked = task;
    if (!task.conversationId && !conversationIdFromRouteUrl(task.conversationUrl)) {
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
        conversationTitle: conversationTitleFromDom(conversationId) || normalizeConversationTitle(document.title),
        model: task.model,
        reasoningMode: task.reasoningMode,
      });
      tracked = submitted;
    }

    const updated = await this.reconcileTask(tracked, { record });
    const latest = updated || (await this.api.task(tracked.taskId)).task;
    if (this.canWatchTask(latest)) this.watchTask(latest);
    return latest;
  }

  async ingestTaskResult(task, conversationId, record = undefined, { includeSeen = false } = {}) {
    const expectedName = String(task.resultFilename || `chatgpt-ide-result-${task.taskId}.txt`);
    const conversationRecord = record === undefined
      ? await chatgpt.conversation(conversationId).catch(() => null)
      : record;
    const file = (conversationRecord && this.latestTaskResultFile(task, conversationRecord, { includeSeen }))
      // The rendered transcript carries the same file id, so a changed or
      // unavailable conversation endpoint does not strand a finished task.
      || (!resultScan.isGenerating() ? resultScan.findResultFileInDom(
        expectedName,
        includeSeen ? null : (candidate) => {
          const turn = activeFollowUp(task);
          if (turn?.mode === 'agent' && !resultFileFreshForTurn(candidate, turn)) return false;
          return !this.hasSeenResultFile(task.taskId, candidate);
        },
      ) : null);
    if (!file) return null;
    const turn = activeFollowUp(task);
    if (turn?.mode === 'agent' && !resultFileFreshForTurn(file, turn)) return null;
    this.report({
      type: 'result-downloading',
      taskId: task.taskId,
      message: `Downloading ${file.name}…`,
    });
    this.rememberResultFile(task.taskId, file);
    const text = await chatgpt.downloadFileText(file, conversationId);
    const { task: updated } = await this.api.taskResult(task.taskId, text, file);
    this.activeTaskId = activeFollowUp(updated) || (!updated.answerOnly && updated.state === 'submitted')
      ? task.taskId
      : null;
    return updated;
  }

  async ingestDomResult(task, file) {
    const turn = activeFollowUp(task);
    if (turn?.mode === 'agent' && !resultFileFreshForTurn(file, turn)) return null;
    this.rememberResultFile(task.taskId, file);
    const text = await chatgpt.downloadFileText(file, this.conversationIdFor(task));
    const { task: updated } = await this.api.taskResult(task.taskId, text, file);
    this.activeTaskId = activeFollowUp(updated) ? task.taskId : null;
    return updated;
  }

  watchTask(task, { responseComplete = null, recovery = false } = {}) {
    if (!this.canWatchTask(task)) return;
    this.stop();
    this.activeTaskId = task.taskId;
    this.watchConversationTitle(task);
    const generation = this.watchGeneration;
    const expectedName = String(task.resultFilename || `chatgpt-ide-result-${task.taskId}.txt`);
    let currentTask = task;
    let reconciling = false;
    this.rememberResultFile(task.taskId, task.result?.sourceFile);

    const arm = () => {
      const turn = activeFollowUp(currentTask);
      const wantsResult = Boolean(turn?.mode === 'agent' || (!turn && !currentTask.answerOnly));
      if (generation !== this.watchGeneration || !this.canWatchTask(currentTask)) return;
      this.stopDomWatch?.();
      this.stopDomWatch = resultScan.observeConversation({
        expectedName: wantsResult ? expectedName : null,
        acceptResult: wantsResult
          ? (file) => {
            const currentTurn = activeFollowUp(currentTask);
            if (currentTurn?.mode === 'agent' && !resultFileFreshForTurn(file, currentTurn)) return false;
            return !this.hasSeenResultFile(currentTask.taskId, file);
          }
          : null,
        onFinished: () => finish(),
        onResult: wantsResult ? (file) => handleResult(file) : null,
      });
    };

    const finish = async () => {
      if (reconciling || generation !== this.watchGeneration) return;
      reconciling = true;
      this.stopDomWatch?.();
      this.stopDomWatch = null;
      try {
        const updated = await this.reconcileTask(currentTask, { knownStatus: 'completed' });
        if (updated) currentTask = updated;
        if (!this.canWatchTask(currentTask)) {
          this.stopConversationTitleWatch?.();
          this.stopConversationTitleWatch = null;
          this.activeTaskId = null;
          return;
        }
      } catch (error) {
        this.report({ type: 'task-result-error', taskId: currentTask.taskId, message: error.message });
      } finally {
        reconciling = false;
      }
      if (generation === this.watchGeneration) arm();
    };

    const handleResult = async (file) => {
      if (generation !== this.watchGeneration) return;
      this.stopDomWatch = null;
      try {
        const updated = await this.ingestDomResult(currentTask, file);
        if (updated) currentTask = updated;
      } catch (error) {
        this.report({ type: 'task-result-error', taskId: currentTask.taskId, message: error.message });
        const latest = await this.api.task(currentTask.taskId).then((result) => result.task).catch(() => null);
        if (latest) currentTask = latest;
      }
      if (generation === this.watchGeneration && this.canWatchTask(currentTask)) arm();
      else if (!this.canWatchTask(currentTask)) {
        this.stopConversationTitleWatch?.();
        this.stopConversationTitleWatch = null;
      }
    };

    if (responseComplete) Promise.resolve(responseComplete).then((complete) => {
      if (complete) finish();
    });
    if (recovery) {
      // Reconcile once before attaching the DOM observer. This establishes the
      // newest result as the baseline and avoids re-ingesting older transcript
      // files when a completed task is reopened.
      this.reconcileTask(currentTask).then((updated) => {
        if (updated) currentTask = updated;
        if (!this.canWatchTask(currentTask)) {
          this.activeTaskId = null;
          return;
        }
        if (generation === this.watchGeneration) arm();
      }).catch((error) => {
        this.report({ type: 'task-result-error', taskId: currentTask.taskId, message: error.message });
        if (generation === this.watchGeneration) arm();
      });
    } else {
      arm();
    }
  }

  // Used by Retry apply: re-reads the saved conversation before reapplying.
  async refreshTaskResult(task) {
    const conversationId = this.conversationIdFor(task);
    if (!conversationId) throw new Error('This task has no conversation to re-read.');
    const updated = await this.ingestTaskResult(task, conversationId, undefined, { includeSeen: true });
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
    if (this.canWatchTask(task)) this.watchTask(task, { recovery: true });
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

module.exports = {
  Driver,
  activeFollowUp,
  packageFilename,
  resultFileCreatedMilliseconds,
  resultFileFreshForTurn,
  toFile,
  turnStartMilliseconds,
};
