const chatgpt = require('./chatgpt/api');
const intercept = require('./chatgpt/intercept');
const modelPicker = require('./chatgpt/model-picker');
const navigate = require('./chatgpt/navigate');
const { Driver } = require('./driver');
const { Shell } = require('./ui/shell');
const { Store, writePreference } = require('./store');
const { h, replace } = require('./ui/dom');
const { openConflictResolution } = require('./ui/dialogs/conflict');
const { openPromptManager } = require('./ui/dialogs/prompts');
const { openRepositoryPicker } = require('./ui/dialogs/repository-picker');
const { openSkillDrawer } = require('./ui/dialogs/skills');
const { renderComposer, NEW_PROJECT_VALUE, NEW_TREE_VALUE } = require('./ui/views/composer');
const { renderDiffOverlay, renderSource } = require('./ui/views/source');
const { renderHistory } = require('./ui/views/history');
const { renderTaskDetail } = require('./ui/views/task-detail');
const { renderTrees } = require('./ui/views/trees');
const { taskLabel } = require('./ui/labels');
const { reportLayout } = require('./ui/layout-report');
const { taskRequestConfiguration } = require('../../shared/chatgpt');

const ELAPSED_TICK_MILLISECONDS = 1_000;

class App {
  constructor({ api, transport, version }) {
    this.api = api;
    this.transport = transport;
    this.version = version;
    this.store = new Store();
    this.shell = new Shell({
      onNavigate: () => this.renderActiveView(),
      onPushIneffective: (result) => {
        this.store.addActivity(`The page did not reflow around the dock (content reaches ${result.worst}px of ${result.limit}px). Use the layout button for overlay.`);
        this.toast('The page did not reflow around the panel. Try the layout button in the header.', true);
      },
    });
    this.driver = new Driver({ api, report: (event) => this.handleEvent(event) });
    this.diff = null;
    this.eventSequence = 0;
    this.actions = this.buildActions();
    this.setupViews();
  }

  setupViews() {
    this.shell.addView('tasks', { label: 'Tasks', icon: 'tasks' });
    this.shell.addView('source', { label: 'Source', icon: 'source' });
    this.shell.addView('trees', { label: 'Trees', icon: 'trees' });
    this.shell.addView('history', { label: 'History', icon: 'history' });
    this.shell.show('tasks');
    setInterval(() => this.tickElapsed(), ELAPSED_TICK_MILLISECONDS);
  }

  persist(key, value) {
    writePreference(key, value);
  }

  /* ---------------------------------------------------------------- rendering */

  renderActiveView() {
    const view = this.shell.activeView;
    if (view === 'tasks') this.renderTasksView();
    if (view === 'source') this.renderSourceView();
    if (view === 'trees') this.shell.render('trees', ...renderTrees(this));
    if (view === 'history') this.shell.render('history', ...renderHistory(this));
    this.shell.setCount('trees', this.store.state.trees.length);
    this.shell.setCount('history', this.store.state.tasks.length);
    this.shell.setCount('source', this.store.state.sourceStatus?.changes?.length || 0);
    this.shell.setPendingBadge(this.store.pendingCount());
  }

  renderTasksView() {
    const { state } = this.store;
    const active = state.activeTaskId ? this.store.task(state.activeTaskId) : null;
    const recent = state.tasks.slice(0, 5);
    const recentList = recent.length
      ? h('div', { class: 'list' }, ...recent.map((task) => h(
        'button',
        {
          class: `list-item ${task.taskId === state.activeTaskId ? 'active' : ''}`,
          onclick: () => this.actions.showTask(task.taskId),
        },
        h(
          'span',
          { class: 'grow' },
          h('span', { class: 'title' }, taskLabel(task)),
          h('span', { class: 'subtitle' }, require('./ui/labels').taskStateLabel(task)),
        ),
      )))
      : null;

    this.shell.render(
      'tasks',
      active ? null : h('button', { class: 'primary wide', onclick: () => this.actions.showComposer() }, '＋ New task'),
      ...(active ? renderTaskDetail(this, active) : renderComposer(this)),
      active ? null : recentList,
    );
  }

  renderSourceView() {
    const container = this.shell.render('source', ...renderSource(this));
    if (this.diff) container.append(renderDiffOverlay(this, this.diff));
  }

  tickElapsed() {
    const view = this.shell.view('tasks');
    if (!view) return;
    for (const element of view.querySelectorAll('.elapsed[data-started-at]')) {
      const endedAt = element.dataset.endedAt ? new Date(element.dataset.endedAt).getTime() : Date.now();
      element.textContent = require('./ui/dom').formatElapsed(element.dataset.startedAt, endedAt);
    }
  }

  toast(message, isError = false) {
    this.shell.showToast(message, isError);
  }

  async run(work, { success = null, failure = null } = {}) {
    try {
      const result = await work();
      if (success) this.toast(typeof success === 'function' ? success(result) : success);
      return result;
    } catch (error) {
      this.toast(failure ? `${failure} ${error.message}` : error.message, true);
      this.store.addActivity(error.message);
      throw error;
    }
  }

  /* ------------------------------------------------------------------- events */

  handleEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.task) this.store.upsertTask(event.task);
    if (event.taskId && !event.task && event.type === 'task-deleted') this.store.removeTask(event.taskId);
    if (event.message) this.store.addActivity(event.message);

    if (event.type === 'merge-submit-requested' && event.request) {
      this.driver.submitMerge(event.request).catch((error) => {
        this.api.treeMergeFailed(event.treeId, error.message).catch(() => {});
        this.toast(error.message, true);
      });
    }
    if (event.type === 'git-summary-ready' && event.commitMessage) {
      this.store.set({ sourceCommitMessage: event.commitMessage, gitSummaryTaskId: event.task?.taskId || null });
    }
    if (['merge-completed', 'merge-failed', 'merge-submitted', 'tree-created', 'tree-removed'].includes(event.type)) {
      this.refreshTrees().catch(() => {});
    }
    if (['task-applied', 'task-rolled-back', 'task-conflicted'].includes(event.type)) {
      this.refreshSource().catch(() => {});
    }
    this.renderActiveView();
  }

  async pollEvents() {
    for (;;) {
      try {
        const { events, seq } = await this.api.events(this.eventSequence);
        this.eventSequence = seq ?? this.eventSequence;
        for (const event of events || []) {
          this.eventSequence = Math.max(this.eventSequence, event.seq || 0);
          this.handleEvent(event);
        }
        this.shell.setStatus(`Connected · ${this.transport.kind}`);
        this.store.set({ connected: true }, 'silent');
      } catch (error) {
        this.shell.setStatus('Agent unreachable — is `pnpm agent` running?');
        this.store.set({ connected: false }, 'silent');
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
  }

  /* ------------------------------------------------------------------ loaders */

  async refreshTasks() {
    const { tasks } = await this.api.tasks();
    this.store.set({ tasks }, 'tasks');
    const running = tasks.find((task) => task.state === 'submitted');
    if (running) this.driver.adoptTask(running);
    return tasks;
  }

  async refreshTrees() {
    const { trees } = await this.api.trees();
    this.store.set({ trees }, 'trees');
    const merging = trees.find((tree) => tree.mergeState === 'submitted');
    if (merging) this.driver.adoptMerge(merging);
    return trees;
  }

  async refreshRepositories() {
    const { repositories } = await this.api.repositories();
    this.store.set({ repositories }, 'repositories');
    return repositories;
  }

  async refreshPrompts() {
    const { prompts } = await this.api.prompts();
    this.store.set({ prompts }, 'prompts');
    return prompts;
  }

  async refreshIac() {
    const iac = await this.api.iac();
    this.store.set({ iac }, 'iac');
    return iac;
  }

  async refreshSource() {
    const path = this.store.state.sourceRepositoryPath;
    if (!path) {
      this.store.set({ sourceStatus: null }, 'source');
      return null;
    }
    try {
      const status = await this.api.gitStatus(path);
      this.store.set({ sourceStatus: status }, 'source');
      return status;
    } catch (error) {
      this.store.set({ sourceStatus: null }, 'source');
      this.toast(error.message, true);
      return null;
    }
  }

  async refreshProjects(showErrors = false) {
    try {
      const projects = await chatgpt.listProjects();
      this.store.set({ projects }, 'projects');
      return projects;
    } catch (error) {
      if (showErrors) this.toast(error.message, true);
      return [];
    }
  }

  /* ------------------------------------------------------------------ actions */

  buildActions() {
    const app = this;
    return {
      showComposer() {
        app.store.set({ activeTaskId: null }, 'tasks');
        app.shell.show('tasks');
      },

      showTask(taskId) {
        app.store.set({ activeTaskId: taskId, activity: [] }, 'tasks');
        app.shell.show('tasks');
      },

      async chooseRepositories({ forSource = false } = {}) {
        openRepositoryPicker({
          shell: app.shell,
          api: app.api,
          onChoose: async (paths) => {
            if (paths.length === 0) return;
            await app.run(async () => {
              const { repositories } = await app.api.addRepositories(paths);
              app.store.set({ repositories }, 'repositories');
              const added = repositories.filter((repository) => paths.includes(repository.path));
              if (forSource) {
                app.actions.selectSourceRepository(added[0]?.path || paths[0]);
                return;
              }
              const existing = app.store.state.composer.repositories;
              const merged = [...existing];
              for (const repository of added) {
                if (!merged.some((item) => item.path === repository.path)) merged.push(repository);
              }
              app.store.setComposer({ repositories: merged });
              app.renderActiveView();
            }, { success: 'Repository added.' });
          },
        });
      },

      removeComposerRepository(path) {
        app.store.setComposer({
          repositories: app.store.state.composer.repositories.filter((item) => item.path !== path),
        });
        app.renderActiveView();
      },

      async addAttachments(files) {
        if (!files?.length) return;
        await app.run(async () => {
          const uploaded = [];
          for (const file of files) {
            const buffer = await file.arrayBuffer();
            uploaded.push(await app.api.uploadAttachment(file.name, buffer));
          }
          app.store.setComposer({
            attachments: [...app.store.state.composer.attachments, ...uploaded],
          });
          app.renderActiveView();
        }, { success: `${files.length} attachment${files.length === 1 ? '' : 's'} staged.` });
      },

      openSkillDrawer() {
        openSkillDrawer({
          shell: app.shell,
          api: app.api,
          repositoryPaths: app.store.state.composer.repositories.map((repository) => repository.path),
          selectedIds: app.store.state.composer.skillIds,
          onDone: (skillIds) => {
            app.store.setComposer({ skillIds });
            app.renderActiveView();
          },
        });
      },

      openPromptManager() {
        openPromptManager({
          shell: app.shell,
          api: app.api,
          onChange: (prompts) => {
            app.store.set({ prompts }, 'prompts');
            app.renderActiveView();
          },
        });
      },

      refreshProjects(showErrors) {
        return app.refreshProjects(showErrors).then(() => app.renderActiveView());
      },

      async createTask({ submit = true } = {}) {
        const { composer } = app.store.state;
        if (!composer.taskText.trim()) {
          app.toast('Describe the software task before creating a task package.', true);
          return null;
        }
        if (composer.repositories.length === 0 && composer.treeSelection !== NEW_TREE_VALUE
          && !composer.treeSelection) {
          app.toast('Add at least one Git repository.', true);
          return null;
        }

        return app.run(async () => {
          let chatgptProject = null;
          if (composer.projectSelection === NEW_PROJECT_VALUE) {
            if (!composer.newProjectName.trim()) throw new Error('Enter a name for the new project.');
            chatgptProject = await chatgpt.createProject(composer.newProjectName.trim());
            await app.refreshProjects();
            app.store.setComposer({ projectSelection: chatgptProject.id, newProjectName: '' }, 'silent');
            app.persist('task-project', chatgptProject.id);
          } else if (composer.projectSelection) {
            chatgptProject = app.store.state.projects
              .find((project) => project.id === composer.projectSelection) || null;
          }

          const input = {
            taskText: composer.taskText,
            repositories: composer.repositories.map((repository) => ({ path: repository.path })),
            attachments: composer.attachments.map((attachment) => ({ path: attachment.path })),
            skillIds: composer.skillIds,
            promptIds: composer.promptIds,
            model: composer.model,
            reasoningMode: composer.reasoningMode,
            includeIac: composer.includeIac,
            answerOnly: composer.answerOnly,
            chatgptProject,
          };
          if (composer.treeSelection === NEW_TREE_VALUE) {
            input.createTree = true;
            input.treeName = composer.treeName;
          } else if (composer.treeSelection) {
            input.treeId = composer.treeSelection;
          }

          const { task } = await app.api.createTask(input);
          app.store.upsertTask(task);
          app.store.setComposer({ taskText: '', attachments: [], treeName: '' }, 'silent');
          app.store.set({ activeTaskId: task.taskId, activity: [] }, 'tasks');
          await app.refreshTrees().catch(() => {});
          app.renderActiveView();
          if (submit) await app.actions.submitTask(task.taskId);
          return task;
        }, { failure: 'The task package could not be created.' });
      },

      async submitTask(taskId) {
        const task = app.store.task(taskId) || (await app.api.task(taskId)).task;
        return app.run(async () => {
          const submitted = await app.driver.submitTask(task);
          app.store.upsertTask(submitted);
          app.renderActiveView();
          return submitted;
        }, { failure: 'The send failed.' });
      },

      async openConversation(taskId) {
        const task = app.store.task(taskId);
        if (!task?.conversationUrl) return;
        app.driver.adoptTask(task);
        await navigate.openConversation(task.conversationUrl);
      },

      async copyPrompt(taskId) {
        const task = app.store.task(taskId);
        if (!task) return;
        await app.run(
          () => navigator.clipboard.writeText(task.handoffPrompt),
          { success: 'Handoff prompt copied.', failure: 'The prompt could not be copied.' },
        );
      },

      revealPackage(taskId) {
        const task = app.store.task(taskId);
        if (!task?.packagePath) return;
        app.run(() => app.api.reveal(task.packagePath), { success: 'Opened the task package folder.' });
      },

      importResult(taskId) {
        const input = h('input', { type: 'file', accept: '.txt,text/plain', style: { display: 'none' } });
        input.addEventListener('change', async () => {
          const file = input.files?.[0];
          if (!file) return;
          await app.run(async () => {
            const { task } = await app.api.taskResult(taskId, await file.text());
            app.store.upsertTask(task);
            app.renderActiveView();
          }, { success: 'Result imported and validated.' });
        });
        input.click();
      },

      async deleteTask(taskId) {
        const task = app.store.task(taskId);
        const confirmed = await app.shell.confirm({
          title: 'Delete task history?',
          message: task?.state === 'submitted'
            ? 'This removes the saved task history. The running task stops being tracked, but the chat keeps going.'
            : 'This removes the saved task history and task package. It does not change the coding tree.',
          confirmLabel: 'Delete task',
          danger: true,
        });
        if (!confirmed) return;
        await app.run(async () => {
          await app.api.deleteTask(taskId);
          app.store.removeTask(taskId);
          app.renderActiveView();
        }, { success: 'Task deleted.' });
      },

      applyTask(taskId) {
        return app.run(async () => {
          const { task } = await app.api.applyTask(taskId);
          app.store.upsertTask(task);
          app.renderActiveView();
        }, { success: 'Result applied.' });
      },

      retryApply(taskId) {
        return app.run(async () => {
          const current = app.store.task(taskId);
          if (current?.conversationUrl) {
            await app.driver.refreshTaskResult(current).catch(() => {});
          }
          const { task } = await app.api.retryApply(taskId);
          app.store.upsertTask(task);
          app.renderActiveView();
        }, { success: 'Retried the saved result.' });
      },

      resolveConflict(taskId) {
        const task = app.store.task(taskId);
        if (!task) return;
        openConflictResolution({
          shell: app.shell,
          task,
          onSubmit: async (options) => {
            const { task: original, resolutionTask } = await app.api.resolveConflict(taskId, options);
            app.store.upsertTask(original);
            if (!resolutionTask) {
              app.toast('The saved result applied cleanly on retry.');
              app.renderActiveView();
              return;
            }
            app.store.upsertTask(resolutionTask);
            app.store.set({ activeTaskId: resolutionTask.taskId, activity: [] }, 'tasks');
            app.renderActiveView();
            await app.actions.submitTask(resolutionTask.taskId);
          },
        });
      },

      async rollbackTask(taskId) {
        const confirmed = await app.shell.confirm({
          title: 'Roll back applied changes?',
          message: 'The commits or patches this task applied to its target are reverted.',
          confirmLabel: 'Roll back',
          danger: true,
        });
        if (!confirmed) return;
        await app.run(async () => {
          const { task } = await app.api.rollbackTask(taskId);
          app.store.upsertTask(task);
          app.renderActiveView();
        }, { success: 'Changes rolled back.' });
      },

      useGitSummary(taskId) {
        return app.run(async () => {
          const { task } = await app.api.useGitSummary(taskId);
          app.store.upsertTask(task);
          app.store.set({ sourceCommitMessage: task.result.commitMessage });
          app.shell.show('source');
        }, { success: 'Commit message moved to Source control.' });
      },

      setTaskTarget(taskId, input) {
        if (input.createTree && !input.treeName) {
          app.toast('Enter a name for the new coding tree.', true);
          return null;
        }
        return app.run(async () => {
          const { task } = await app.api.setTaskTarget(taskId, input);
          app.store.upsertTask(task);
          await app.refreshTrees();
          app.renderActiveView();
        }, { success: 'Task target changed.' });
      },

      /* -------------------------------------------------------- source control */

      selectSourceRepository(path) {
        app.store.set({ sourceRepositoryPath: path, sourceStatus: null });
        app.persist('source-repository', path);
        app.refreshSource().then(() => app.renderActiveView());
      },

      refreshSource() {
        return app.refreshSource().then(() => app.renderActiveView());
      },

      async removeSourceRepository() {
        const path = app.store.state.sourceRepositoryPath;
        if (!path) return;
        const confirmed = await app.shell.confirm({
          title: 'Remove from workspace?',
          message: 'This only removes the repository from the workspace. Nothing on disk changes.',
          confirmLabel: 'Remove',
        });
        if (!confirmed) return;
        await app.run(async () => {
          const { repositories } = await app.api.removeRepository(path);
          app.store.set({ repositories, sourceRepositoryPath: repositories[0]?.path || '', sourceStatus: null });
          app.persist('source-repository', repositories[0]?.path || '');
          await app.refreshSource();
          app.renderActiveView();
        }, { success: 'Repository removed from the workspace.' });
      },

      gitStage(files) {
        return app.actions.mutateSource(() => app.api.gitStage(app.store.state.sourceRepositoryPath, files));
      },

      gitStageAll() {
        return app.actions.mutateSource(() => app.api.gitStageAll(app.store.state.sourceRepositoryPath));
      },

      gitUnstage(files) {
        return app.actions.mutateSource(() => app.api.gitUnstage(app.store.state.sourceRepositoryPath, files));
      },

      gitUnstageAll() {
        return app.actions.mutateSource(() => app.api.gitUnstageAll(app.store.state.sourceRepositoryPath));
      },

      mutateSource(operation) {
        return app.run(async () => {
          const status = await operation();
          app.store.set({ sourceStatus: status }, 'source');
          app.renderActiveView();
        });
      },

      commit(message) {
        if (!message.trim()) {
          app.toast('Write a commit message first.', true);
          return null;
        }
        return app.run(async () => {
          const status = await app.api.gitCommit(app.store.state.sourceRepositoryPath, message);
          app.store.set({ sourceStatus: status, sourceCommitMessage: '' });
          app.renderActiveView();
        }, { success: 'Commit created.' });
      },

      generateGitSummary() {
        return app.run(async () => {
          const { task } = await app.api.gitSummary({ path: app.store.state.sourceRepositoryPath });
          app.store.upsertTask(task);
          const submitted = await app.driver.submitTask(task);
          app.store.upsertTask(submitted);
          app.renderActiveView();
        }, { failure: 'The Git summary could not be generated.' });
      },

      async openDiff(path, staged) {
        await app.run(async () => {
          app.diff = await app.api.gitDiff(app.store.state.sourceRepositoryPath, path, staged);
          app.renderSourceView();
        });
      },

      closeDiff() {
        app.diff = null;
        app.renderSourceView();
      },

      /* ---------------------------------------------------------- coding trees */

      startTreeTask(treeId = NEW_TREE_VALUE) {
        app.store.setComposer({ treeSelection: treeId });
        app.persist('task-tree', treeId);
        app.store.set({ activeTaskId: null }, 'tasks');
        app.shell.show('tasks');
      },

      inspectTreeInSource(tree) {
        app.actions.selectSourceRepository(tree.path);
        app.shell.show('source');
      },

      revealTree(treeId) {
        return app.run(() => app.api.revealTree(treeId), { success: 'Opened the coding tree folder.' });
      },

      async removeTree(treeId) {
        const tree = app.store.state.trees.find((item) => item.id === treeId);
        const confirmed = await app.shell.confirm({
          title: 'Discard coding tree?',
          message: `Discard “${tree?.name || treeId}” and all commits that have not been merged? This removes the worktree and its coding branch.`,
          confirmLabel: 'Discard tree',
          danger: true,
        });
        if (!confirmed) return;
        await app.run(async () => {
          const { trees } = await app.api.removeTree(treeId);
          app.store.set({ trees }, 'trees');
          app.renderActiveView();
        }, { success: 'Coding tree discarded.' });
      },

      mergeTree(treeId, projectId) {
        return app.run(async () => {
          const project = projectId
            ? app.store.state.projects.find((item) => item.id === projectId) || null
            : null;
          const { request } = await app.api.treeMergeRequest(treeId, project);
          await app.driver.submitMerge(request);
          await app.refreshTrees();
          app.renderActiveView();
        }, { failure: 'The coding tree merge could not be started.' });
      },

      resolveTreeMerge(treeId) {
        return app.run(async () => {
          const { task } = await app.api.resolveTreeMerge(treeId);
          app.store.upsertTask(task);
          app.store.set({ activeTaskId: task.taskId, activity: [] }, 'tasks');
          app.shell.show('tasks');
          await app.actions.submitTask(task.taskId);
        }, { failure: 'The merge resolution task could not be created.' });
      },
    };
  }

  // The composer picker belongs to ChatGPT, not to the dock: it is installed on
  // boot and stays whether or not Patchwork is open.
  installComposerPicker() {
    const { composer } = this.store.state;
    modelPicker.install({
      model: composer.model,
      reasoningMode: composer.reasoningMode,
      onChange: (selection) => {
        this.store.setComposer(selection, 'silent');
        this.persist('task-model', selection.model);
        this.persist('task-reasoning', selection.reasoningMode);
        this.store.addActivity(`Model set to ${selection.model} · ${selection.reasoningMode} from the composer.`);
        this.renderActiveView();
      },
    });
    // Ordinary chats are sent with whatever the picker shows too, not only the
    // chats Patchwork drives; without this the picker would be decorative.
    intercept.setAmbientConfiguration(() => {
      if (!modelPicker.isInstalled()) return null;
      const selected = modelPicker.currentSelection();
      return {
        ...taskRequestConfiguration(selected.model, selected.reasoningMode),
        source: 'patchwork-selector',
      };
    });

    // Keep ChatGPT's composer in step when the choice is made in the dock instead.
    this.store.subscribe((state, reason) => {
      if (reason === 'composer' || reason === 'silent') {
        modelPicker.setSelection({
          model: state.composer.model,
          reasoningMode: state.composer.reasoningMode,
        });
      }
    });
  }

  /* -------------------------------------------------------------------- boot */

  async start() {
    this.store.subscribe((_state, reason) => {
      if (reason !== 'silent') this.renderActiveView();
    });
    this.shell.setStatus(`Connecting via ${this.transport.kind}…`);

    await Promise.allSettled([
      this.refreshRepositories(),
      this.refreshTasks(),
      this.refreshTrees(),
      this.refreshPrompts(),
      this.refreshIac(),
      this.refreshSource(),
    ]);
    this.refreshProjects().catch(() => {});

    const composerRepositories = this.store.state.repositories.filter((repository) => !repository.unavailable);
    if (this.store.state.composer.repositories.length === 0 && composerRepositories.length === 1) {
      this.store.setComposer({ repositories: composerRepositories }, 'silent');
    }

    this.installComposerPicker();
    this.renderActiveView();
    // Report the real layout once it has settled, so the agent log shows what
    // the page actually did rather than what Patchwork assumed.
    setTimeout(() => reportLayout(this.api, this.shell), 2500);
    this.driver.start();
    this.pollEvents().catch(() => {});

    const pending = navigate.takePendingNavigation();
    if (pending?.taskId) {
      this.actions.submitTask(pending.taskId).catch(() => {});
    }
  }
}

module.exports = { App, replace };
