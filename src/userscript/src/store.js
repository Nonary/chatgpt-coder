const PREFERENCE_PREFIX = 'patchwork.';
const { readStorage, writeStorage } = require('./ui/storage');

function readPreference(key, fallback = '') {
  return readStorage(PREFERENCE_PREFIX + key, fallback);
}

function readJsonPreference(key, fallback) {
  const raw = readPreference(key, '');
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function initialRepositoryScope() {
  const stored = readJsonPreference('repository-scope', null);
  if (Array.isArray(stored)) return stored.filter((value) => typeof value === 'string' && value);
  const legacy = readPreference('source-repository');
  return legacy ? [legacy] : [];
}

function writePreference(key, value) {
  writeStorage(PREFERENCE_PREFIX + key, value);
}

class Store {
  constructor() {
    this.listeners = new Set();
    this.state = {
      connected: false,
      transport: null,
      tasks: [],
      trees: [],
      repositories: [],
      prompts: [],
      skills: [],
      projects: [],
      iac: { exists: false, valid: true, selectors: [] },
      activity: [],
      activeTaskId: null,
      repositoryScopePaths: initialRepositoryScope(),
      sourceStatuses: {},
      sourceExpandedPaths: [],
      sourceCommitMessages: {},
      historySearch: '',
      historyState: 'all',
      composer: {
        repositories: [],
        submodules: {
          mode: 'none',
          selections: {},
        },
        attachments: [],
        skillIds: [],
        promptIds: [],
        treeSelection: readPreference('task-tree', ''),
        treeName: '',
        model: readPreference('task-model', 'default'),
        reasoningMode: readPreference('task-reasoning', 'default'),
        projectSelection: readPreference('task-project', ''),
        newProjectName: '',
        includeIac: readPreference('task-iac', 'false') === 'true',
        mode: 'ask',
        taskText: '',
      },
      followUp: {
        taskId: null,
        attachments: [],
        skillIds: [],
        promptIds: [],
        model: 'default',
        reasoningMode: 'default',
        mode: 'ask',
        taskText: '',
      },
    };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(reason = 'update') {
    for (const listener of [...this.listeners]) listener(this.state, reason);
  }

  set(patch, reason) {
    Object.assign(this.state, patch);
    this.notify(reason);
  }

  setRepositoryScope(paths, reason = 'repository-scope') {
    const repositoryByPath = new Map(this.state.repositories.map((repository) => [repository.path, repository]));
    const composerRepositoryByPath = new Map(
      this.state.composer.repositories.map((repository) => [repository.path, repository]),
    );
    const normalized = [];
    const seen = new Set();
    for (const repositoryPath of paths || []) {
      if (seen.has(repositoryPath)) continue;
      const repository = repositoryByPath.get(repositoryPath);
      if (!repository || repository.unavailable) continue;
      seen.add(repositoryPath);
      normalized.push(repositoryPath);
    }

    const sourceStatuses = Object.fromEntries(
      Object.entries(this.state.sourceStatuses)
        .filter(([repositoryPath]) => normalized.includes(repositoryPath)),
    );
    const sourceExpandedPaths = this.state.sourceExpandedPaths
      .filter((repositoryPath) => normalized.includes(repositoryPath));
    if (normalized.length > 0 && sourceExpandedPaths.length === 0) sourceExpandedPaths.push(normalized[0]);

    this.state.repositoryScopePaths = normalized;
    this.state.composer.repositories = normalized.map((repositoryPath) => {
      const repository = repositoryByPath.get(repositoryPath);
      const current = composerRepositoryByPath.get(repositoryPath);
      return current ? { ...repository, access: current.access || 'edit' } : { ...repository, access: 'edit' };
    });
    this.state.sourceStatuses = sourceStatuses;
    this.state.sourceExpandedPaths = sourceExpandedPaths;
    this.notify(reason);
    return normalized;
  }

  setComposer(patch, reason = 'composer') {
    Object.assign(this.state.composer, patch);
    this.notify(reason);
  }

  setFollowUp(patch, reason = 'follow-up') {
    Object.assign(this.state.followUp, patch);
    this.notify(reason);
  }

  activeComposerSelection() {
    return this.state.activeTaskId ? this.state.followUp : this.state.composer;
  }

  setActiveComposerSelection(patch, reason = 'silent') {
    if (this.state.activeTaskId) {
      this.setFollowUp(patch, reason);
      return 'follow-up';
    }
    this.setComposer(patch, reason);
    return 'composer';
  }

  resetFollowUp(task, reason = 'follow-up') {
    const turns = Array.isArray(task?.turns) ? task.turns : [];
    const lastTurn = turns[turns.length - 1] || null;
    const mode = lastTurn?.mode || (task?.answerOnly ? 'ask' : 'agent');
    this.state.followUp = {
      taskId: task?.taskId || null,
      attachments: [],
      skillIds: [],
      promptIds: [],
      model: lastTurn?.model || task?.model || 'default',
      reasoningMode: lastTurn?.reasoningMode || task?.reasoningMode || 'default',
      mode,
      taskText: '',
    };
    this.notify(reason);
  }

  task(taskId) {
    return this.state.tasks.find((task) => task.taskId === taskId) || null;
  }

  upsertTask(task) {
    if (!task?.taskId) return;
    const index = this.state.tasks.findIndex((item) => item.taskId === task.taskId);
    if (index < 0) this.state.tasks = [task, ...this.state.tasks];
    else {
      const current = this.state.tasks[index];
      const bothRevisioned = Number.isSafeInteger(current.revision) && Number.isSafeInteger(task.revision);
      const olderRevision = bothRevisioned && task.revision < current.revision;
      const currentUpdatedAt = Date.parse(current.updatedAt || current.createdAt || '') || 0;
      const incomingUpdatedAt = Date.parse(task.updatedAt || task.createdAt || '') || 0;
      if (olderRevision || (!bothRevisioned && incomingUpdatedAt < currentUpdatedAt)) return;
      this.state.tasks = this.state.tasks.map((item) => (item.taskId === task.taskId ? task : item));
    }
    this.notify('tasks');
  }

  removeTask(taskId) {
    this.state.tasks = this.state.tasks.filter((task) => task.taskId !== taskId);
    if (this.state.activeTaskId === taskId) this.state.activeTaskId = null;
    this.notify('tasks');
  }

  addActivity(message, timestamp = new Date()) {
    if (!message) return;
    this.state.activity = [{ message, at: timestamp.toISOString() }, ...this.state.activity].slice(0, 60);
    this.notify('activity');
  }

  pendingCount() {
    return this.state.tasks.filter((task) => ['submitted', 'ready', 'conflicted'].includes(task.state)).length;
  }
}

module.exports = { Store, readJsonPreference, readPreference, writePreference };
