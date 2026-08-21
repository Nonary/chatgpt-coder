const PREFERENCE_PREFIX = 'patchwork.';

function readPreference(key, fallback = '') {
  try {
    const value = localStorage.getItem(PREFERENCE_PREFIX + key);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

function writePreference(key, value) {
  try {
    if (value == null || value === '') localStorage.removeItem(PREFERENCE_PREFIX + key);
    else localStorage.setItem(PREFERENCE_PREFIX + key, String(value));
  } catch {
    // Sticky selections are a convenience; a blocked localStorage is not fatal.
  }
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
      sourceRepositoryPath: readPreference('source-repository'),
      sourceStatus: null,
      sourceHistory: [],
      sourceCommitMessage: '',
      gitSummaryTaskId: null,
      historySearch: '',
      historyState: 'all',
      composer: {
        repositories: [],
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
      taskConversation: {
        taskId: null,
        loading: false,
        error: null,
        messages: [],
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

  setComposer(patch, reason = 'composer') {
    Object.assign(this.state.composer, patch);
    this.notify(reason);
  }

  setFollowUp(patch, reason = 'follow-up') {
    Object.assign(this.state.followUp, patch);
    this.notify(reason);
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

  setTaskConversation(patch, reason = 'task-conversation') {
    Object.assign(this.state.taskConversation, patch);
    this.notify(reason);
  }

  task(taskId) {
    return this.state.tasks.find((task) => task.taskId === taskId) || null;
  }

  upsertTask(task) {
    if (!task?.taskId) return;
    const index = this.state.tasks.findIndex((item) => item.taskId === task.taskId);
    if (index < 0) this.state.tasks = [task, ...this.state.tasks];
    else this.state.tasks = this.state.tasks.map((item) => (item.taskId === task.taskId ? task : item));
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

module.exports = { Store, readPreference, writePreference };
