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
const { latestGitSummaryTask, renderDiffOverlay, renderSource } = require('./ui/views/source');
const { renderHistory } = require('./ui/views/history');
const { renderTaskDetail } = require('./ui/views/task-detail');
const { renderTrees } = require('./ui/views/trees');
const { taskLabel } = require('./ui/labels');
const { canFollowUp, canSendFollowUp } = require('./ui/views/task-follow-up');
const { closeComposerPopover } = require('./ui/composer-controls');
const { reportLayout } = require('./ui/layout-report');
const { conversationIdFromRouteUrl, taskRequestConfiguration } = require('../../shared/chatgpt');
const { createTaskInput } = require('./task-input');
const { repositoryPathKey } = require('../../shared/repository-paths');

const ELAPSED_TICK_MILLISECONDS = 1_000;
const UPDATE_CHECK_INTERVAL_MILLISECONDS = 30 * 60 * 1_000;
const UPDATE_RECONNECT_TIMEOUT_MILLISECONDS = 60_000;


class App {
  constructor({ api, transport, version }) {
    this.api = api;
    this.transport = transport;
    this.version = version;
    this.store = new Store();
    this.shell = new Shell({
      onNavigate: () => this.renderActiveView(),
      onCheckForUpdates: () => this.actions?.checkForUpdates(),
      onPushIneffective: (result) => {
        this.store.addActivity(`The page did not reflow around the dock (content reaches ${result.worst}px of ${result.limit}px). Use the layout button for overlay.`);
        this.toast('The page did not reflow around the panel. Try the layout button in the header.', true);
      },
    });
    this.driver = new Driver({ api, report: (event) => this.handleEvent(event) });
    this.diff = null;
    this.eventSequence = 0;
    this.notifiedUpdateKey = null;
    this.taskTargetUpdates = new Map();
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

  setRepositoryScope(paths, { reason = 'repository-scope' } = {}) {
    const normalized = this.store.setRepositoryScope(paths, reason);
    this.persist('repository-scope', JSON.stringify(normalized));
    this.persist('source-repository', '');
    return normalized;
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
    this.shell.setCount('source', Object.values(this.store.state.sourceStatuses)
      .reduce((count, status) => count + (status?.changes?.length || 0), 0));
    this.shell.setPendingBadge(this.store.pendingCount());
  }

  renderTasksView() {
    const { state } = this.store;
    const active = state.activeTaskId ? this.store.task(state.activeTaskId) : null;
    if (active && state.followUp.taskId !== active.taskId) this.store.resetFollowUp(active, 'silent');
    const view = this.shell.view('tasks');
    const previousTaskId = view?.dataset.activeTaskId || '';
    const focusedElement = this.shell.root.activeElement;
    const focusedPopover = this.shell.root.querySelector('.composer-popover');
    const preserveFocus = Boolean(focusedElement)
      && (view?.contains(focusedElement) || focusedPopover?.contains(focusedElement));
    const focusSelection = preserveFocus && typeof focusedElement.selectionStart === 'number'
      ? { start: focusedElement.selectionStart, end: focusedElement.selectionEnd }
      : null;
    const sameTask = Boolean(active) && previousTaskId === active.taskId;
    const existingFollowUpComposer = view?.querySelector('.task-follow-up-card');
    const existingComposer = view?.querySelector('.composer-root');
    const followUpComposer = sameTask && existingFollowUpComposer && canFollowUp(active)
      ? existingFollowUpComposer
      : null;
    const composer = !active && previousTaskId === '' && existingComposer?.updateComposer
      ? existingComposer
      : null;
    if ((existingFollowUpComposer && existingFollowUpComposer !== followUpComposer)
      || (existingComposer && existingComposer !== composer)) closeComposerPopover();
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
      ...(active
        ? renderTaskDetail(this, active, { followUpComposer })
        : composer ? [composer] : renderComposer(this)),
      active ? null : recentList,
    );
    if (view) view.dataset.activeTaskId = active?.taskId || '';
    if (active) followUpComposer?.updateTaskFollowUp?.(active);
    else composer?.updateComposer?.();
    if (preserveFocus && focusedElement?.isConnected) {
      focusedElement.focus?.({ preventScroll: true });
      if (focusSelection && typeof focusedElement.setSelectionRange === 'function') {
        focusedElement.setSelectionRange(focusSelection.start, focusSelection.end);
      }
    }
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
    if (event.taskId && !event.task && event.type === 'task-deleted') {
      this.driver.forgetTask(event.taskId);
      this.store.removeTask(event.taskId);
    }
    if (event.message) this.store.addActivity(event.message);

    if (event.type === 'merge-submit-requested' && event.request) {
      this.driver.submitMerge(event.request).catch((error) => {
        this.api.treeMergeFailed(event.treeId, error.message).catch(() => {});
        this.toast(error.message, true);
      });
    }
    if (event.type === 'git-summary-ready' && event.commitMessage) {
      const repositoryPath = event.repositoryPath || event.task?.sourceRepositoryPath || event.task?.repositories?.[0]?.path;
      if (this.store.state.repositoryScopePaths.includes(repositoryPath)) {
        this.refreshSource(repositoryPath)
          .then(() => {
            if (this.shell.activeView === 'source') this.renderActiveView();
          })
          .catch(() => {});
      }
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
    const conversationId = conversationIdFromRouteUrl(location.href);
    const current = conversationId
      ? tasks.find((task) => (
        task.conversationId || conversationIdFromRouteUrl(task.conversationUrl)
      ) === conversationId)
      : null;
    const running = tasks.find((task) => task.activeTurnId || task.state === 'submitted');
    if (current) {
      this.store.set({ activeTaskId: current.taskId }, 'silent');
      this.store.resetFollowUp(current, 'silent');
      this.driver.adoptTask(current).catch(() => {});
    } else if (running) {
      this.driver.adoptTask(running).catch(() => {});
    }
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

  mergeRepositories(repositories, reason = 'repositories') {
    const merged = new Map(
      this.store.state.repositories.map((repository) => [repositoryPathKey(repository.path), repository]),
    );
    for (const repository of repositories || []) {
      if (!repository?.path) continue;
      merged.set(repositoryPathKey(repository.path), repository);
    }
    const next = [...merged.values()];
    this.store.set({ repositories: next }, reason);
    return next;
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

  async refreshSourcePaths(paths) {
    const uniquePaths = [...new Set((paths || []).filter(Boolean))];
    if (uniquePaths.length === 0) return { ...this.store.state.sourceStatuses };

    const next = { ...this.store.state.sourceStatuses };
    await Promise.all(uniquePaths.map(async (path) => {
      try {
        const summaryTask = latestGitSummaryTask(this.store.state.tasks, path);
        next[path] = await this.api.gitStatus(path, { fingerprint: Boolean(summaryTask) });
      } catch (error) {
        delete next[path];
        this.toast(error.message, true);
      }
    }));
    this.store.set({ sourceStatuses: next }, 'source');
    return next;
  }

  async refreshSource(repositoryPath = null) {
    const paths = repositoryPath ? [repositoryPath] : this.store.state.repositoryScopePaths;
    if (paths.length === 0) {
      this.store.set({ sourceStatuses: {} }, 'source');
      return repositoryPath ? null : {};
    }

    const next = await this.refreshSourcePaths(paths);
    return repositoryPath ? next[repositoryPath] || null : next;
  }

  showUpdateStatus(status, { manual = false } = {}) {
    if (!status?.supported) {
      this.shell.setUpdateNotice(manual ? {
        message: status?.reason || 'Patchwork could not inspect its Git checkout.',
        actionLabel: 'Check again',
        blocked: true,
        onAction: () => this.actions.checkForUpdates(),
      } : null);
      return;
    }
    if (!status?.updateAvailable) {
      const currentMessage = status.ahead > 0
        ? `Patchwork is not behind ${status.upstream} and has ${status.ahead} local commit${status.ahead === 1 ? '' : 's'} ahead.`
        : `Patchwork is up to date with ${status.upstream}.`;
      this.shell.setUpdateNotice(manual ? {
        message: currentMessage,
        actionLabel: 'Rebuild and restart',
        onAction: () => this.actions.updateAgent({ rebuild: true }),
      } : null);
      return;
    }
    const behind = status.behind > 0
      ? `${status.behind} new commit${status.behind === 1 ? '' : 's'} on ${status.upstream}`
      : 'Downloaded update ready to rebuild';
    this.shell.setUpdateNotice({
      message: status.canUpdate ? `${behind}.` : `${behind}. ${status.reason || 'Automatic update is unavailable.'}`,
      actionLabel: status.canUpdate ? (status.restartPending && status.behind === 0 ? 'Rebuild and restart' : 'Update') : 'Check again',
      blocked: !status.canUpdate,
      onAction: status.canUpdate
        ? () => this.actions.updateAgent({ rebuild: status.behind === 0 })
        : () => this.actions.checkForUpdates(),
    });
  }

  async checkForUpdate({ announce = false, manual = false } = {}) {
    this.shell.setUpdateButtonState({ checking: true });
    try {
      const status = await this.api.updateStatus();
      this.showUpdateStatus(status, { manual });
      this.shell.setUpdateButtonState({
        available: status.updateAvailable,
        blocked: status.updateAvailable && !status.canUpdate,
      });
      const updateKey = `${status.latestRevision || ''}:${status.runningRevision || ''}`;
      if (announce && status.updateAvailable && this.notifiedUpdateKey !== updateKey) {
        this.notifiedUpdateKey = updateKey;
        const message = status.canUpdate
          ? (status.behind > 0 ? 'A Patchwork update is available.' : 'Patchwork needs to rebuild and restart.')
          : `Patchwork needs attention before it can update. ${status.reason || ''}`;
        this.toast(message, !status.canUpdate);
      } else if (manual && !status.updateAvailable) {
        this.toast('Patchwork is up to date. You can rebuild and restart it from the update panel.');
      }
      return status;
    } catch (error) {
      // Update discovery depends on the configured Git remote. A temporary
      // network failure must not interfere with the local coding workspace.
      this.shell.setUpdateButtonState({ blocked: true });
      if (manual) this.toast(error.message, true);
      return null;
    }
  }

  async waitForRevision(revision) {
    const deadline = Date.now() + UPDATE_RECONNECT_TIMEOUT_MILLISECONDS;
    while (Date.now() < deadline) {
      try {
        const health = await this.api.health();
        if (health.revision === revision) return health;
      } catch {
        // The expected gap while the old process releases the port.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Patchwork rebuilt, but the restarted agent did not come back on this port.');
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

  async startGitSummaryTask(repositoryPath) {
    const { task } = await this.api.gitSummary({ path: repositoryPath });
    this.store.upsertTask(task);
    const submitted = await this.driver.submitTask(task);
    this.store.upsertTask(submitted);
    await this.refreshSource(repositoryPath);
    this.renderActiveView();
    return submitted;
  }

  /* ------------------------------------------------------------------ actions */

  buildActions() {
    const app = this;
    return {
      showComposer() {
        app.store.setComposer({ mode: 'ask' }, 'silent');
        app.store.set({ activeTaskId: null }, 'tasks');
        app.shell.show('tasks');
      },

      showTask(taskId) {
        const task = app.store.task(taskId);
        if (task) app.store.resetFollowUp(task, 'silent');
        app.store.set({ activeTaskId: taskId, activity: [] }, 'tasks');
        app.shell.show('tasks');
      },

      checkForUpdates() {
        return app.checkForUpdate({ announce: true, manual: true });
      },

      async updateAgent({ rebuild = false } = {}) {
        const confirmed = await app.shell.confirm({
          title: rebuild ? 'Rebuild Patchwork?' : 'Update Patchwork?',
          message: rebuild
            ? 'Patchwork will rebuild the current checkout and restart on this same port. Local source changes are kept.'
            : 'Patchwork will fast-forward from Git, refresh dependencies if needed, rebuild, and restart on this same port.',
          confirmLabel: rebuild ? 'Rebuild and restart' : 'Update and restart',
        });
        if (!confirmed) return;
        app.shell.setUpdateNotice({
          message: 'Updating and rebuilding Patchwork…',
          actionLabel: 'Updating…',
          disabled: true,
        });
        try {
          const result = await app.api.applyUpdate({ rebuild });
          app.shell.setStatus('Restarting agent…');
          app.shell.setUpdateNotice({ message: 'Rebuild complete. Waiting for Patchwork to restart…' });
          await app.waitForRevision(result.revision);
          app.shell.setUpdateNotice(null);
          app.shell.setStatus(`Connected · ${app.transport.kind}`);
          app.toast('Patchwork updated and reconnected.');
        } catch (error) {
          app.toast(error.message, true);
          await app.checkForUpdate();
        }
      },

      manageRepositoryScope({ onDone = null } = {}) {
        openRepositoryPicker({
          shell: app.shell,
          api: app.api,
          repositories: app.store.state.repositories,
          selectedPaths: app.store.state.repositoryScopePaths,
          allowEmpty: true,
          title: 'Manage repositories',
          confirmLabel: 'Done',
          onChoose: async (paths) => {
            await app.run(async () => {
              const previousScope = new Set(app.store.state.repositoryScopePaths);
              if (paths.length > 0) {
                const { repositories } = await app.api.addRepositories(paths);
                app.mergeRepositories(repositories, 'silent');
              }
              app.setRepositoryScope(paths, { reason: 'repository-scope' });
              const pathsToRefresh = paths.filter((path) => (
                !previousScope.has(path) || !app.store.state.sourceStatuses[path]
              ));
              await app.refreshSourcePaths(pathsToRefresh);
              app.renderActiveView();
              onDone?.();
            }, { success: 'Repository scope updated.' });
          },
        });
      },

      removeRepositoryFromScope(path, { onDone = null } = {}) {
        app.setRepositoryScope(
          app.store.state.repositoryScopePaths.filter((repositoryPath) => repositoryPath !== path),
        );
        app.renderActiveView();
        onDone?.();
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

      addFollowUpAttachments(files) {
        if (!files?.length) return;
        const current = app.store.state.followUp.attachments || [];
        app.store.setFollowUp({ attachments: [...current, ...files] });
        app.renderActiveView();
      },

      async sendFollowUp(taskId) {
        const task = app.store.task(taskId) || (await app.api.task(taskId)).task;
        const followUp = app.store.state.followUp;
        if (!task || followUp.taskId !== taskId) return null;
        if (!canSendFollowUp(task, followUp)) {
          app.toast('Finish the current follow-up before sending another message.', true);
          return null;
        }
        const attachments = [...followUp.attachments];
        return app.run(async () => {
          const { task: prepared, turn } = await app.api.createFollowUp(taskId, {
            prompt: followUp.taskText,
            mode: followUp.mode,
            model: followUp.model,
            reasoningMode: followUp.reasoningMode,
            skillIds: followUp.skillIds,
            promptIds: followUp.promptIds,
            attachments: attachments.map((file) => ({ name: file.name, size: file.size })),
          });
          app.store.upsertTask(prepared);
          app.renderActiveView();
          const submitted = await app.driver.submitFollowUp(prepared, turn, attachments);
          app.store.upsertTask(submitted);
          app.store.setFollowUp({ taskId, taskText: '', attachments: [], skillIds: [], promptIds: [] }, 'silent');
          app.renderActiveView();
          return submitted;
        }, { failure: 'The follow-up could not be sent.' });
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
        const existingTreeWithoutWorkspace = composer.treeSelection
          && composer.treeSelection !== NEW_TREE_VALUE
          && composer.repositories.length === 0;
        if (composer.treeSelection && !existingTreeWithoutWorkspace) {
          const editableCount = Number.isInteger(composer.submodules?.summary?.editable)
            ? composer.submodules.summary.editable
            : composer.repositories.filter(
              (repository) => repository.access !== 'context' && repository.readOnly !== true,
            ).length;
          if (editableCount !== 1) {
            app.toast(
              'Coding trees currently support one editable repository. Use current checkouts or mark the other repositories as Context.',
              true,
            );
            return null;
          }
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

          const input = createTaskInput(composer, chatgptProject);

          const { task } = await app.api.createTask(input);
          app.store.upsertTask(task);
          app.store.setComposer({ taskText: '', attachments: [], treeName: '' }, 'silent');
          app.store.set({ activeTaskId: task.taskId, activity: [] }, 'tasks');
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

      async refreshTask(taskId) {
        const task = app.store.task(taskId) || (await app.api.task(taskId)).task;
        return app.run(async () => {
          const refreshed = await app.driver.refreshTask(task);
          app.store.upsertTask(refreshed);
          app.renderActiveView();
          return refreshed;
        }, {
          success: (refreshed) => (['ready', 'completed'].includes(refreshed.state)
            ? 'Task completion detected.'
            : 'Task status refreshed.'),
          failure: 'The task could not be refreshed.',
        });
      },

      openConversation(taskId) {
        const task = app.store.task(taskId);
        if (!task?.conversationUrl) return;
        navigate.openConversation(task.conversationUrl);
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
          message: task?.state === 'submitted' || task?.activeTurnId
            ? 'This removes the saved task history. The running task stops being tracked, but the chat keeps going.'
            : 'This removes the saved task history and task package. It does not change the coding tree.',
          confirmLabel: 'Delete task',
          danger: true,
        });
        if (!confirmed) return;
        await app.run(async () => {
          await app.api.deleteTask(taskId);
          app.driver.forgetTask(taskId);
          app.store.removeTask(taskId);
          app.renderActiveView();
        }, { success: 'Task deleted.' });
      },

      applyTask(taskId) {
        return app.run(async () => {
          const pendingTarget = app.taskTargetUpdates.get(taskId);
          if (pendingTarget) await pendingTarget;
          const { task } = await app.api.applyTask(taskId);
          app.store.upsertTask(task);
          app.renderActiveView();
          if (task.state !== 'applied') {
            throw new Error(task.error || 'The result could not be applied to the selected target.');
          }
          return task;
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
          const existing = app.store.task(taskId) || (await app.api.task(taskId)).task;
          const repositoryPath = existing?.sourceRepositoryPath || existing?.repositories?.[0]?.path;
          if (!existing?.summaryOnly || !repositoryPath) throw new Error('This Git Summary is not associated with a repository.');
          if (!app.store.state.repositories.some((repository) => repository.path === repositoryPath)) {
            const { repositories } = await app.api.addRepositories([repositoryPath]);
            app.mergeRepositories(repositories, 'silent');
          }
          if (!app.store.state.repositoryScopePaths.includes(repositoryPath)) {
            app.setRepositoryScope([...app.store.state.repositoryScopePaths, repositoryPath], { reason: 'silent' });
          }
          const { task } = await app.api.useGitSummary(taskId);
          app.store.upsertTask(task);
          app.actions.setSourceCommitMessage(repositoryPath, task.result.commitMessage);
          await app.refreshSource(repositoryPath);
          app.actions.expandSourceRepository(repositoryPath);
          app.shell.show('source');
          app.renderActiveView();
        }, { success: 'Commit message added to Source Control.' });
      },

      useTaskCommitMessage(taskId, repositoryPath) {
        return app.run(async () => {
          const task = app.store.task(taskId) || (await app.api.task(taskId)).task;
          const appliesToRepository = (task?.repositories || []).some((repository) => (
            !repository.readOnly && repository.path === repositoryPath
          ));
          if (task?.state !== 'applied' || !task?.result?.commitMessage || !appliesToRepository) {
            throw new Error('This task does not contain a commit message for that Source Control repository.');
          }
          if (!app.store.state.repositories.some((repository) => repository.path === repositoryPath)) {
            const { repositories } = await app.api.addRepositories([repositoryPath]);
            app.mergeRepositories(repositories, 'silent');
          }
          if (!app.store.state.repositoryScopePaths.includes(repositoryPath)) {
            app.setRepositoryScope([...app.store.state.repositoryScopePaths, repositoryPath], { reason: 'silent' });
          }
          app.actions.setSourceCommitMessage(repositoryPath, task.result.commitMessage);
          app.actions.expandSourceRepository(repositoryPath);
          app.shell.show('source');
          app.renderActiveView();
        }, { success: 'Commit message added to Source Control.' });
      },

      openTaskInSource(taskId) {
        return app.run(async () => {
          const task = app.store.task(taskId) || (await app.api.task(taskId)).task;
          const repositoryPaths = (task?.repositories || [])
            .filter((repository) => !repository.readOnly && repository.path)
            .map((repository) => repository.path);
          if (repositoryPaths.length === 0) throw new Error('This task has no writable repositories to inspect.');
          const { repositories } = await app.api.addRepositories(repositoryPaths);
          app.mergeRepositories(repositories, 'silent');
          app.setRepositoryScope(repositoryPaths, { reason: 'repository-scope' });
          await app.refreshSource();
          app.shell.show('source');
          app.renderActiveView();
        }, { success: 'Task repositories opened in Source Control.' });
      },

      setTaskTarget(taskId, input) {
        if (input.createTree && !input.treeName) {
          app.toast('Enter a name for the new coding tree.', true);
          return null;
        }
        const previous = app.taskTargetUpdates.get(taskId);
        const update = (previous ? previous.catch(() => {}) : Promise.resolve()).then(() => app.run(async () => {
          const { task } = await app.api.setTaskTarget(taskId, input);
          app.store.upsertTask(task);
          if (input.createTree) await app.refreshTrees();
          app.renderActiveView();
          return task;
        }, { success: 'Task target changed.' }));
        app.taskTargetUpdates.set(taskId, update);
        update.finally(() => {
          if (app.taskTargetUpdates.get(taskId) === update) app.taskTargetUpdates.delete(taskId);
        }).catch(() => {});
        return update;
      },

      /* -------------------------------------------------------- source control */

      toggleSourceRepository(repositoryPath) {
        const expanded = new Set(app.store.state.sourceExpandedPaths);
        if (expanded.has(repositoryPath)) expanded.delete(repositoryPath);
        else expanded.add(repositoryPath);
        app.store.set({ sourceExpandedPaths: [...expanded] }, 'source');
      },

      expandSourceRepository(repositoryPath) {
        if (app.store.state.sourceExpandedPaths.includes(repositoryPath)) return;
        app.store.set({ sourceExpandedPaths: [...app.store.state.sourceExpandedPaths, repositoryPath] }, 'source');
      },

      setSourceCommitMessage(repositoryPath, message) {
        app.store.set({
          sourceCommitMessages: {
            ...app.store.state.sourceCommitMessages,
            [repositoryPath]: message,
          },
        }, 'silent');
      },

      refreshSource(repositoryPath = null) {
        return app.refreshSource(repositoryPath)
          .then((result) => {
            app.renderActiveView();
            return result;
          });
      },

      async removeWorkspaceRepository(path) {
        if (!path) return;
        const confirmed = await app.shell.confirm({
          title: 'Forget repository from workspace?',
          message: 'This removes the repository from Patchwork and from the shared repository scope. Nothing on disk changes.',
          confirmLabel: 'Forget',
        });
        if (!confirmed) return;
        await app.run(async () => {
          const { repositories } = await app.api.removeRepository(path);
          app.store.set({ repositories }, 'silent');
          app.setRepositoryScope(
            app.store.state.repositoryScopePaths.filter((repositoryPath) => repositoryPath !== path),
            { reason: 'repository-scope' },
          );
          await app.refreshSource();
          app.renderActiveView();
        }, { success: 'Repository forgotten from the workspace.' });
      },

      gitStage(repositoryPath, files) {
        return app.actions.mutateSource(repositoryPath, () => app.api.gitStage(repositoryPath, files));
      },

      gitStageAll(repositoryPath) {
        return app.actions.mutateSource(repositoryPath, () => app.api.gitStageAll(repositoryPath));
      },

      gitUnstage(repositoryPath, files) {
        return app.actions.mutateSource(repositoryPath, () => app.api.gitUnstage(repositoryPath, files));
      },

      gitUnstageAll(repositoryPath) {
        return app.actions.mutateSource(repositoryPath, () => app.api.gitUnstageAll(repositoryPath));
      },

      mutateSource(repositoryPath, operation) {
        return app.run(async () => {
          const status = await operation();
          const summaryTask = latestGitSummaryTask(app.store.state.tasks, repositoryPath);
          if (summaryTask) await app.refreshSource(repositoryPath);
          else app.store.set({
            sourceStatuses: { ...app.store.state.sourceStatuses, [repositoryPath]: status },
          }, 'source');
          app.renderActiveView();
        });
      },

      commit(repositoryPath, message) {
        if (!message.trim()) {
          app.toast('Write a commit message first.', true);
          return null;
        }
        return app.run(async () => {
          const status = await app.api.gitCommit(repositoryPath, message);
          const summaryTask = latestGitSummaryTask(app.store.state.tasks, repositoryPath);
          const sourceCommitMessages = { ...app.store.state.sourceCommitMessages, [repositoryPath]: '' };
          app.store.set({
            sourceStatuses: { ...app.store.state.sourceStatuses, [repositoryPath]: status },
            sourceCommitMessages,
          }, 'source');
          if (summaryTask) await app.refreshSource(repositoryPath);
          app.renderActiveView();
        }, { success: 'Commit created.' });
      },

      generateGitSummary(repositoryPath) {
        return app.run(
          () => app.startGitSummaryTask(repositoryPath),
          { failure: 'The Git summary could not be generated.' },
        );
      },

      async openDiff(repositoryPath, path, staged) {
        await app.run(async () => {
          app.diff = await app.api.gitDiff(repositoryPath, path, staged);
          app.renderSourceView();
        });
      },

      closeDiff() {
        app.diff = null;
        app.renderSourceView();
      },

      /* ---------------------------------------------------------- coding trees */

      startTreeTask(treeId = NEW_TREE_VALUE) {
        app.store.setComposer({ mode: 'ask', treeSelection: treeId });
        app.persist('task-tree', treeId);
        app.store.set({ activeTaskId: null }, 'tasks');
        app.shell.show('tasks');
      },

      inspectTreeInSource(tree) {
        return app.run(async () => {
          const { repositories } = await app.api.addRepositories([tree.path]);
          app.mergeRepositories(repositories, 'silent');
          app.setRepositoryScope([tree.path], { reason: 'repository-scope' });
          await app.refreshSource(tree.path);
          app.shell.show('source');
          app.renderActiveView();
        }, { failure: 'The coding tree could not be opened in Source Control.' });
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
        const target = this.store.setActiveComposerSelection(selection, 'silent');
        if (target === 'composer') {
          this.persist('task-model', selection.model);
          this.persist('task-reasoning', selection.reasoningMode);
        }
        this.store.addActivity(`Model set to ${selection.model} · ${selection.reasoningMode} from the composer.`);
        this.renderActiveView();
      },
    });
    // Ordinary chats are sent with whatever the picker shows too, not only the
    // chats Patchwork drives; without this the picker would be decorative.
    intercept.setAmbientConfiguration(() => {
      // ChatGPT tears down the composer while navigating to a fresh chat. That
      // DOM gap must not turn the first message into an unmodified native send:
      // the choice remains active until Patchwork itself is uninstalled.
      if (!modelPicker.hasActiveSelection()) return null;
      const selected = modelPicker.currentSelection();
      return {
        ...taskRequestConfiguration(selected.model, selected.reasoningMode),
        source: 'patchwork-selector',
      };
    });

    // Keep ChatGPT's composer in step when the choice is made in the dock instead.
    this.store.subscribe((_state, reason) => {
      if (reason === 'composer' || reason === 'silent') {
        const selection = this.store.activeComposerSelection();
        const current = modelPicker.currentSelection();
        if (current.model === selection.model && current.reasoningMode === selection.reasoningMode) return;
        // Silent updates include every form-field keystroke. Do not repaint the
        // picker inside ChatGPT's composer unless its actual selection changed;
        // Safari can otherwise move focus back to the host composer on each DOM mutation.
        modelPicker.setSelection({
          model: selection.model,
          reasoningMode: selection.reasoningMode,
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
    ]);
    this.refreshProjects().catch(() => {});

    const availableRepositories = this.store.state.repositories.filter((repository) => !repository.unavailable);
    let repositoryScopePaths = this.store.state.repositoryScopePaths
      .filter((repositoryPath) => availableRepositories.some((repository) => repository.path === repositoryPath));
    if (repositoryScopePaths.length === 0 && availableRepositories.length === 1) {
      repositoryScopePaths = [availableRepositories[0].path];
    }
    this.setRepositoryScope(repositoryScopePaths, { reason: 'silent' });
    await this.refreshSource();

    this.installComposerPicker();
    this.renderActiveView();
    // Report the real layout once it has settled, so the agent log shows what
    // the page actually did rather than what Patchwork assumed.
    setTimeout(() => reportLayout(this.api, this.shell), 2500);
    this.pollEvents().catch(() => {});
    this.checkForUpdate({ announce: true }).catch(() => {});
    setInterval(() => this.checkForUpdate({ announce: true }).catch(() => {}), UPDATE_CHECK_INTERVAL_MILLISECONDS);

    const pending = navigate.takePendingNavigation();
    if (pending?.taskId) {
      this.actions.submitTask(pending.taskId).catch(() => {});
    } else if (pending?.merge?.treeId) {
      this.driver.submitMerge(pending.merge).catch(() => {});
    }
  }
}

module.exports = { App, replace };
