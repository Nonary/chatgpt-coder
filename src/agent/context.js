const path = require('node:path');
const { EventLog } = require('./events');
const { FsService } = require('./services/fs-service');
const { GitService } = require('./services/git-service');
const { IacService } = require('./services/iac-service');
const { PromptService } = require('./services/prompt-service');
const { ResultService } = require('./services/result-service');
const { SkillService } = require('./services/skill-service');
const { TaskService } = require('./services/task-service');
const { WorktreeService } = require('./services/worktree-service');
const { isChatGPTConversationUrl } = require('../shared/chatgpt');

// A task that was marked submitted but never reached a real conversation URL is
// returned to "prepared" so the page can offer Submit again after a restart.
async function recoverUnconfirmedSubmissions(taskService) {
  const tasks = await taskService.listTasks();
  return Promise.all(tasks.map((task) => {
    if (task.state !== 'submitted' || isChatGPTConversationUrl(task.conversationUrl)) return task;
    return taskService.updateTask(task.taskId, {
      state: 'prepared',
      submittedAt: null,
      conversationUrl: null,
      conversationId: null,
      conversationTitle: null,
      chatStatus: null,
      chatStatusRaw: null,
      chatFinishedAt: null,
    });
  }));
}

async function createContext(config) {
  const dataRoot = path.join(config.dataRoot, 'patchwork');
  const events = new EventLog();
  const emit = (payload) => events.emit(payload);

  const fsService = new FsService();
  const skillService = new SkillService();
  const iacService = new IacService({ settingsPath: config.iacSettingsPath });
  const promptService = new PromptService(dataRoot);
  const taskService = new TaskService(dataRoot, skillService, iacService);
  await taskService.initialize();
  const gitService = new GitService(dataRoot);
  await gitService.initialize();
  const worktreeService = new WorktreeService(dataRoot, emit, () => gitService.listRepositories());
  await worktreeService.initialize();

  const resultService = new ResultService(taskService, async (event) => {
    // v2 immediately resubmitted the tree merge from the main process. The agent
    // cannot drive ChatGPT, so it hands the prepared merge request to the page.
    if (event.type === 'task-applied' && event.task?.mergeResolution && event.task.treeId
      && event.task.result?.commits?.length) {
      const sourceContext = event.task.repositories.find((repository) => repository.readOnly);
      await worktreeService.clearMergeFailure(
        event.task.treeId,
        sourceContext?.snapshotFingerprint || null,
      );
      emit(event);
      try {
        const request = await worktreeService.buildMergeRequest(event.task.treeId);
        emit({ type: 'merge-submit-requested', treeId: request.treeId, request });
      } catch (error) {
        await worktreeService.markMergeFailed(event.task.treeId, error).catch(() => {});
        emit({ type: 'merge-failed', treeId: event.task.treeId, message: error.message });
      }
      return;
    }
    emit(event);
  });

  const uploadsRoot = path.join(dataRoot, 'uploads');

  const context = {
    config,
    dataRoot,
    uploadsRoot,
    events,
    emit,
    fsService,
    gitService,
    iacService,
    promptService,
    resultService,
    skillService,
    taskService,
    worktreeService,
  };

  await recoverUnconfirmedSubmissions(taskService);
  return context;
}

module.exports = { createContext, recoverUnconfirmedSubmissions };
