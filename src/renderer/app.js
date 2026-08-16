const state = {
  repositories: [],
  workspaceRepositories: [],
  tasks: [],
  trees: [],
  activeTask: null,
  activity: [],
  gitStatus: null,
  selectedGitPath: null,
  selectedDiffKey: null,
  diffTabs: [],
  attachments: [],
  chatgptProjects: [],
};

const elements = Object.fromEntries(
  [
    'new-task-button', 'chatgpt-session-button', 'task-list', 'page-title',
    'composer-view', 'task-view', 'session-view', 'source-view',
    'trees-view', 'trees-button', 'tree-count', 'trees-list', 'trees-new-task',
    'history-view', 'task-history-button', 'task-history-count', 'task-history-list',
    'task-history-search', 'task-history-state',
    'add-repository-button', 'repository-list', 'task-text', 'auto-apply',
    'add-attachment-button', 'attachment-list',
    'task-tree-select', 'new-tree-fields', 'tree-name',
    'task-model-select', 'task-reasoning-select',
    'chatgpt-project-select', 'new-project-fields', 'new-project-name',
    'refresh-projects-button', 'project-list-status',
    'create-task-button', 'task-status-title', 'task-status-copy', 'status-badge',
    'submit-task-button', 'copy-prompt-button', 'reveal-package-button',
    'import-result-button', 'result-card', 'result-summary', 'patch-list',
    'apply-button', 'resolve-conflict-button', 'rollback-button', 'activity-list', 'toast', 'connection-pill',
    'chatgpt-surface', 'browser-back-button', 'browser-forward-button',
    'browser-reload-button', 'new-chat-button', 'browser-title', 'browser-status',
    'browser-status-dot',
    'session-chatgpt-surface', 'session-back-button', 'session-forward-button',
    'session-reload-button', 'session-new-chat-button', 'session-browser-title',
    'session-browser-status', 'session-status-dot',
    'source-control-button', 'source-count', 'source-repository-select',
    'source-add-repository', 'source-refresh', 'source-remove-repository',
    'source-branch', 'source-commit-message', 'source-commit-button',
    'staged-count', 'unstaged-count', 'staged-files', 'unstaged-files',
    'stage-all-button', 'unstage-all-button', 'commit-history',
    'diff-tabs', 'diff-title', 'diff-subtitle', 'diff-kind', 'diff-compare',
    'diff-before-label', 'diff-after-label', 'diff-rows',
  ].map((id) => [id, document.getElementById(id)]),
);

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function shortCommit(commit) {
  return commit ? commit.slice(0, 9) : '';
}

function showToast(message, error = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', error);
  elements.toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.add('hidden'), 5000);
}

function formatTime(value = new Date()) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function addActivity(message, timestamp = new Date()) {
  state.activity.unshift({ message, timestamp });
  state.activity = state.activity.slice(0, 20);
  elements['activity-list'].innerHTML = state.activity
    .map((item) => `<div class="activity-item"><strong>${escapeHtml(item.message)}</strong><time>${escapeHtml(formatTime(item.timestamp))}</time></div>`)
    .join('');
}

function renderRepositories() {
  const container = elements['repository-list'];
  const selectedTree = state.trees.find((tree) => tree.id === elements['task-tree-select'].value);
  elements['add-repository-button'].disabled = Boolean(selectedTree);
  if (selectedTree) {
    container.className = 'repository-list';
    container.innerHTML = `<div class="repository-row">
      <div class="repo-icon">${escapeHtml(selectedTree.repositoryName[0]?.toUpperCase() || 'G')}</div>
      <div class="repo-info"><strong>${escapeHtml(selectedTree.repositoryName)}</strong><span>${escapeHtml(selectedTree.path)}</span></div>
      <div class="repo-meta">${escapeHtml(selectedTree.branch)}</div>
      <div class="repo-state">Attached tree</div>
    </div>`;
    return;
  }
  if (state.repositories.length === 0) {
    container.className = 'repository-list empty-state';
    container.innerHTML = '<div class="empty-icon">⌘</div><strong>No repository selected</strong><span>Add one Git repository to begin.</span>';
    return;
  }
  container.className = 'repository-list';
  container.innerHTML = state.repositories.map((repository) => `
    <div class="repository-row">
      <div class="repo-icon">${escapeHtml(repository.name[0]?.toUpperCase() || 'G')}</div>
      <div class="repo-info"><strong>${escapeHtml(repository.name)}</strong><span>${escapeHtml(repository.path)}</span></div>
      <div class="repo-meta">${escapeHtml(repository.branch)} · ${repository.hasHead ? escapeHtml(shortCommit(repository.baseCommit)) : 'No commits'}</div>
      <div class="repo-state ${repository.isClean ? '' : 'dirty'}">${repository.isClean ? 'Ready' : 'Commit or stash'}</div>
      <button class="remove-repo" data-repository-id="${escapeHtml(repository.id)}" aria-label="Remove ${escapeHtml(repository.name)}">×</button>
    </div>`).join('');
  container.querySelectorAll('.remove-repo').forEach((button) => {
    button.addEventListener('click', () => {
      state.repositories = state.repositories.filter((item) => item.id !== button.dataset.repositoryId);
      renderRepositories();
    });
  });
}

function renderAttachments() {
  const container = elements['attachment-list'];
  if (state.attachments.length === 0) {
    container.className = 'attachment-list attachment-empty';
    container.innerHTML = '<span>No task attachments selected.</span>';
    return;
  }
  container.className = 'attachment-list';
  container.innerHTML = state.attachments.map((attachment) => `
    <div class="attachment-row">
      <div class="attachment-icon">↥</div>
      <div class="attachment-info"><strong>${escapeHtml(attachment.name)}</strong><span>${escapeHtml(attachment.path)}</span></div>
      <button class="remove-attachment" data-attachment-path="${escapeHtml(attachment.path)}" aria-label="Remove ${escapeHtml(attachment.name)}">×</button>
    </div>`).join('');
  container.querySelectorAll('.remove-attachment').forEach((button) => {
    button.addEventListener('click', () => {
      state.attachments = state.attachments.filter((item) => item.path !== button.dataset.attachmentPath);
      renderAttachments();
    });
  });
}

function renderChatGPTProjects() {
  const select = elements['chatgpt-project-select'];
  const previous = select.value;
  select.innerHTML = '<option value="">New chat (no project)</option>'
    + state.chatgptProjects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join('')
    + '<option value="__new__">Create a new ChatGPT project…</option>';
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  const creating = select.value === '__new__';
  elements['new-project-fields'].classList.toggle('hidden', !creating);
  elements['new-project-name'].disabled = !creating;
}

async function refreshChatGPTProjects(showErrors = false) {
  elements['refresh-projects-button'].disabled = true;
  elements['project-list-status'].classList.remove('error');
  elements['project-list-status'].textContent = 'Loading ChatGPT projects…';
  try {
    state.chatgptProjects = await window.patchwork.listChatGPTProjects();
    renderChatGPTProjects();
    elements['project-list-status'].textContent = state.chatgptProjects.length
      ? `${state.chatgptProjects.length} ChatGPT project${state.chatgptProjects.length === 1 ? '' : 's'} available.`
      : 'No ChatGPT projects found. You can create one below.';
  } catch (error) {
    state.chatgptProjects = [];
    renderChatGPTProjects();
    elements['project-list-status'].classList.add('error');
    elements['project-list-status'].textContent = error.message;
    if (showErrors) showToast(error.message, true);
  } finally {
    elements['refresh-projects-button'].disabled = false;
  }
}

function renderTaskTreeOptions() {
  const select = elements['task-tree-select'];
  const previous = select.value;
  select.innerHTML = '<option value="">Create a new coding tree</option>' + state.trees
    .filter((tree) => tree.available && tree.mergeState !== 'submitted')
    .map((tree) => `<option value="${escapeHtml(tree.id)}">${escapeHtml(tree.name)} · ${escapeHtml(tree.repositoryName)}${tree.managed === false ? ' · Git worktree' : ''}</option>`)
    .join('');
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  const existing = Boolean(select.value);
  elements['new-tree-fields'].classList.toggle('hidden', existing);
  elements['tree-name'].disabled = existing;
  renderRepositories();
}

function renderTrees() {
  elements['tree-count'].textContent = String(state.trees.length);
  elements['tree-count'].classList.toggle('hidden', state.trees.length === 0);
  const container = elements['trees-list'];
  if (state.trees.length === 0) {
    container.className = 'trees-list empty-state';
    container.innerHTML = '<div class="empty-icon">⑃</div><strong>No coding trees yet</strong><span>Start a task to create an isolated workstream.</span>';
    renderTaskTreeOptions();
    return;
  }
  container.className = 'trees-list';
  container.innerHTML = state.trees.map((tree) => `<article class="tree-card">
    <div class="tree-card-heading">
      <div class="repo-icon">${escapeHtml(tree.repositoryName[0]?.toUpperCase() || 'T')}</div>
      <div><strong>${escapeHtml(tree.name)}</strong><small>${escapeHtml(tree.branch)}${tree.managed === false ? ' · Detected by Git' : ''}</small></div>
      <span class="tree-state ${tree.clean && tree.mergeState !== 'failed' ? '' : 'dirty'}">${tree.available ? (tree.mergeState === 'submitted' ? 'Merging' : tree.mergeState === 'failed' ? 'Merge failed' : tree.managed === false && tree.clean ? 'Detected' : tree.clean ? 'Clean' : 'Changes') : 'Missing'}</span>
    </div>
    <div class="tree-stats">
      <div class="tree-stat"><strong>${escapeHtml(tree.commitCount || 0)}</strong><small>Tree commits</small></div>
      <div class="tree-stat"><strong>${escapeHtml((tree.taskIds || []).length)}</strong><small>Tasks</small></div>
    </div>
    <div class="tree-last">${tree.lastSubject ? `${escapeHtml(tree.lastCommit)} · ${escapeHtml(tree.lastSubject)}` : 'No task commits yet.'}</div>
    ${tree.mergeError ? `<div class="tree-last tree-error">${escapeHtml(tree.mergeError)}</div>` : ''}
    <div class="tree-actions">
      <button class="primary tree-continue" data-tree-id="${escapeHtml(tree.id)}" ${!tree.available || tree.mergeState === 'submitted' ? 'disabled' : ''}>Continue task</button>
      <button class="secondary tree-source" data-tree-id="${escapeHtml(tree.id)}" ${!tree.available ? 'disabled' : ''}>Source control</button>
      <button class="secondary tree-merge" data-tree-id="${escapeHtml(tree.id)}" ${!tree.available || !tree.clean || !tree.commitCount || tree.mergeState === 'submitted' ? 'disabled' : ''}>Merge tree</button>
      ${tree.mergeState === 'failed' ? `<button class="primary tree-resolve" data-tree-id="${escapeHtml(tree.id)}">Resolve with ChatGPT</button>` : ''}
      <button class="secondary tree-reveal" data-tree-id="${escapeHtml(tree.id)}">Reveal</button>
      <button class="danger tree-remove" data-tree-id="${escapeHtml(tree.id)}">Discard</button>
    </div>
  </article>`).join('');
  container.querySelectorAll('.tree-continue').forEach((button) => button.addEventListener('click', () => {
    showComposer();
    elements['task-tree-select'].value = button.dataset.treeId;
    renderTaskTreeOptions();
    elements['task-text'].focus();
  }));
  container.querySelectorAll('.tree-source').forEach((button) => button.addEventListener('click', async () => {
    const tree = state.trees.find((item) => item.id === button.dataset.treeId);
    if (!tree) return;
    if (!state.workspaceRepositories.some((item) => item.path === tree.path)) {
      state.workspaceRepositories.push({ name: tree.name, path: tree.path, branch: tree.branch });
    }
    state.selectedGitPath = tree.path;
    await showSourceControl();
  }));
  container.querySelectorAll('.tree-merge').forEach((button) => button.addEventListener('click', async () => {
    try {
      await window.patchwork.mergeTree(button.dataset.treeId);
      showSession();
      showToast('Fresh ChatGPT chat opened to prepare the squash commit.');
      await refreshTrees();
    } catch (error) {
      showToast(error.message, true);
      await refreshTrees();
    }
  }));
  container.querySelectorAll('.tree-resolve').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const task = await window.patchwork.resolveTreeMerge(button.dataset.treeId);
      if (!task) return;
      upsertTask(task);
      await refreshTrees();
      showTask(task);
      showToast('Conflict-resolution task submitted to ChatGPT.');
    } catch (error) {
      showToast(error.message, true);
    } finally {
      button.disabled = false;
    }
  }));
  container.querySelectorAll('.tree-reveal').forEach((button) => button.addEventListener('click', () => (
    window.patchwork.revealTree(button.dataset.treeId).catch((error) => showToast(error.message, true))
  )));
  container.querySelectorAll('.tree-remove').forEach((button) => button.addEventListener('click', async () => {
    try {
      state.trees = await window.patchwork.removeTree(button.dataset.treeId);
      renderTrees();
    } catch (error) {
      showToast(error.message, true);
    }
  }));
  renderTaskTreeOptions();
}

async function refreshTrees() {
  state.trees = await window.patchwork.listTrees();
  renderTrees();
}

function taskLabel(task) {
  const firstLine = String(task.taskText || 'Untitled task').split('\n')[0];
  return firstLine.length > 34 ? `${firstLine.slice(0, 34)}…` : firstLine;
}

function formatElapsed(startedAt, now = Date.now()) {
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return '0s';
  const elapsedSeconds = Math.max(0, Math.floor((now - started) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function updateTaskElapsedTimes() {
  document.querySelectorAll('.task-elapsed[data-started-at]').forEach((element) => {
    element.textContent = formatElapsed(element.dataset.startedAt);
  });
}

function taskStateLabel(task) {
  const labels = {
    prepared: 'Prepared',
    submitted: 'Running',
    ready: 'Waiting to apply',
    applied: 'Applied',
    'rolled-back': 'Rolled back',
    conflicted: 'Needs conflict resolution',
    failed: 'Needs attention',
  };
  return labels[task.state] || task.state;
}

function taskElapsedMarkup(task) {
  if (task.state !== 'submitted' || !task.submittedAt) return '';
  return `<time class="task-elapsed" data-started-at="${escapeHtml(task.submittedAt)}">${escapeHtml(formatElapsed(task.submittedAt))}</time>`;
}

function renderTaskList() {
  const recentTasks = state.tasks.slice(0, 5);
  elements['task-history-count'].textContent = String(state.tasks.length);
  elements['task-history-count'].classList.toggle('hidden', state.tasks.length === 0);
  elements['task-list'].innerHTML = recentTasks.length
    ? recentTasks.map((task) => `
      <button class="task-nav-item ${state.activeTask?.taskId === task.taskId ? 'active' : ''}" data-task-id="${escapeHtml(task.taskId)}">
        <span class="task-name-row">
          <strong>${escapeHtml(taskLabel(task))}</strong>
          ${taskElapsedMarkup(task)}
        </span>
        <span class="task-state-row ${escapeHtml(task.state)}">${escapeHtml(taskStateLabel(task))} · ${escapeHtml(formatTime(task.createdAt))}</span>
      </button>`).join('') + (state.tasks.length > recentTasks.length
      ? `<button id="task-list-more" class="task-list-more">View all ${state.tasks.length} tasks</button>`
      : '')
    : '<p class="muted small">No tasks yet.</p>';
  elements['task-list'].querySelectorAll('.task-nav-item').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        showTask(await window.patchwork.openTask(button.dataset.taskId));
      } catch (error) {
        showToast(error.message, true);
      }
    });
  });
  document.getElementById('task-list-more')?.addEventListener('click', showTaskHistory);
}

function taskHistorySearchText(task) {
  return [
    task.taskText,
    task.treeName,
    task.model,
    task.reasoningMode,
    task.state,
    task.error,
    task.result?.summary,
    task.result?.commitMessage,
    ...(task.repositories || []).flatMap((repository) => [repository.name, repository.branch, repository.path]),
  ].filter(Boolean).join(' ').toLowerCase();
}

function renderTaskHistory() {
  const search = elements['task-history-search'].value.trim().toLowerCase();
  const stateFilter = elements['task-history-state'].value;
  const tasks = state.tasks.filter((task) => (
    (!stateFilter || task.state === stateFilter)
    && (!search || taskHistorySearchText(task).includes(search))
  ));

  if (tasks.length === 0) {
    elements['task-history-list'].className = 'task-history-list empty-state';
    elements['task-history-list'].innerHTML = state.tasks.length
      ? '<div class="empty-icon">⌕</div><strong>No matching tasks</strong><span>Try a different search or status filter.</span>'
      : '<div class="empty-icon">◷</div><strong>No task history yet</strong><span>Prepared tasks will be saved here automatically.</span>';
    return;
  }

  elements['task-history-list'].className = 'task-history-list';
  elements['task-history-list'].innerHTML = tasks.map((task) => {
    const repositoryNames = (task.repositories || []).map((repository) => repository.name).filter(Boolean);
    const context = task.treeName || repositoryNames.join(', ') || 'Local task';
    const configuration = taskConfigurationLabel(task);
    const detail = task.result?.summary || task.error || 'No result summary recorded.';
    const commitMessage = task.result?.commitMessage?.split('\n')[0] || '';
    return `<article class="task-history-card">
      <div class="task-history-heading">
        <div>
          <strong>${escapeHtml(taskLabel(task))}</strong>
          <small>${escapeHtml(formatDateTime(task.createdAt))} · ${escapeHtml(context)} · ${escapeHtml(configuration)}</small>
        </div>
        <span class="history-state ${escapeHtml(task.state)}">${escapeHtml(taskStateLabel(task))}${taskElapsedMarkup(task)}</span>
      </div>
      <p class="task-history-description">${escapeHtml(task.taskText || 'Untitled task')}</p>
      <div class="task-history-result">
        <span>${escapeHtml(detail)}</span>
        ${commitMessage ? `<code>${escapeHtml(commitMessage)}</code>` : ''}
      </div>
      <div class="task-history-actions">
        <button class="primary history-open-task" data-task-id="${escapeHtml(task.taskId)}">View task</button>
        ${task.packagePath ? `<button class="secondary history-reveal-package" data-task-id="${escapeHtml(task.taskId)}">Show package</button>` : ''}
      </div>
    </article>`;
  }).join('');

  elements['task-history-list'].querySelectorAll('.history-open-task').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        showTask(await window.patchwork.openTask(button.dataset.taskId));
      } catch (error) {
        showToast(error.message, true);
      }
    });
  });
  elements['task-history-list'].querySelectorAll('.history-reveal-package').forEach((button) => {
    button.addEventListener('click', () => {
      window.patchwork.revealPackage(button.dataset.taskId).catch((error) => showToast(error.message, true));
    });
  });
}

const statusText = {
  prepared: ['Package prepared', 'Attach the package in ChatGPT and send the copied instructions.'],
  submitted: ['Task is running', 'ChatGPT is still working in the embedded browser. Patchwork is actively watching for the result.'],
  ready: ['Waiting to apply', 'The plain-text result is validated and waiting for you to apply it.'],
  conflicted: ['Conflict needs resolution', 'The result could not be applied cleanly. Send a resolution task to ChatGPT to preserve both versions.'],
  applied: ['Changes committed', 'The validated patch is committed in this task’s coding tree.'],
  'rolled-back': ['Changes reverted', 'A revert commit was created in this task’s coding tree.'],
  failed: ['Task needs attention', 'Patchwork stopped before making unsafe or conflicting changes.'],
};

function taskConfigurationLabel(task) {
  const models = {
    default: 'ChatGPT default',
    sol: 'GPT-5.6 Sol',
    luna: 'GPT-5.6 Luna',
  };
  const reasoning = {
    default: 'default reasoning',
    instant: 'Instant',
    medium: 'Medium',
    high: 'High',
    'extra-high': 'Extra High',
  };
  return `${models[task.model || 'default'] || task.model} · ${reasoning[task.reasoningMode || 'default'] || task.reasoningMode}`;
}

function renderResult(task) {
  const hasResult = Boolean(task.result);
  elements['result-card'].classList.toggle('hidden', !hasResult);
  if (!hasResult) return;
  elements['result-summary'].textContent = task.result.summary || 'ChatGPT returned a validated result.';
  elements['patch-list'].innerHTML = task.result.patches.map((patch) => `
    <div class="patch-item">
      <strong>${escapeHtml(patch.name || patch.id)}</strong>
      <pre>${escapeHtml(patch.stat || 'No changes')}</pre>
    </div>`).join('') + (task.result.commitMessage ? `<div class="patch-item"><strong>Commit</strong><pre>${escapeHtml(task.result.commitMessage)}${task.result.commits?.[0]?.commit ? `\n${escapeHtml(shortCommit(task.result.commits[0].commit))}` : ''}</pre></div>` : '');
  elements['apply-button'].classList.toggle('hidden', task.state !== 'ready');
  elements['resolve-conflict-button'].classList.toggle('hidden', task.state !== 'conflicted' || !task.treeId);
  elements['rollback-button'].classList.toggle('hidden', task.state !== 'applied');
}

function showTask(task) {
  state.activeTask = task;
  state.activity = [];
  elements['composer-view'].classList.add('hidden');
  elements['session-view'].classList.add('hidden');
  elements['source-view'].classList.add('hidden');
  elements['trees-view'].classList.add('hidden');
  elements['history-view'].classList.add('hidden');
  elements['task-view'].classList.remove('hidden');
  elements['chatgpt-session-button'].classList.remove('active');
  elements['source-control-button'].classList.remove('active');
  elements['trees-button'].classList.remove('active');
  elements['task-history-button'].classList.remove('active');
  elements['page-title'].textContent = taskLabel(task);
  const [title, copy] = statusText[task.state] || statusText.prepared;
  elements['task-status-title'].textContent = title;
  elements['task-status-copy'].textContent = task.error || copy;
  elements['status-badge'].textContent = taskStateLabel(task);
  elements['status-badge'].className = `status-badge ${task.state}`;
  addActivity(`Task ${task.state}`, task.updatedAt || task.createdAt);
  addActivity(`${task.repositories.length} repository snapshot${task.repositories.length === 1 ? '' : 's'} prepared`, task.createdAt);
  addActivity(`Model: ${taskConfigurationLabel(task)}`, task.createdAt);
  if (task.attachments?.length) {
    addActivity(`${task.attachments.length} task attachment${task.attachments.length === 1 ? '' : 's'} prepared`, task.createdAt);
  }
  if (task.chatgptProject?.name) {
    addActivity(`ChatGPT project: ${task.chatgptProject.name}`, task.createdAt);
  }
  renderResult(task);
  renderTaskList();
  window.patchwork.setBrowserVisible(true);
  requestAnimationFrame(() => requestAnimationFrame(syncBrowserBounds));
}

function showComposer() {
  state.activeTask = null;
  elements['task-view'].classList.add('hidden');
  elements['session-view'].classList.add('hidden');
  elements['source-view'].classList.add('hidden');
  elements['trees-view'].classList.add('hidden');
  elements['history-view'].classList.add('hidden');
  elements['composer-view'].classList.remove('hidden');
  elements['page-title'].textContent = 'Prepare a coding task';
  elements['chatgpt-session-button'].classList.remove('active');
  elements['source-control-button'].classList.remove('active');
  elements['trees-button'].classList.remove('active');
  elements['task-history-button'].classList.remove('active');
  window.patchwork.setBrowserVisible(false);
  renderTaskTreeOptions();
  renderChatGPTProjects();
  refreshChatGPTProjects().catch(() => {});
  renderTaskList();
}

function showSession() {
  elements['composer-view'].classList.add('hidden');
  elements['task-view'].classList.add('hidden');
  elements['source-view'].classList.add('hidden');
  elements['trees-view'].classList.add('hidden');
  elements['history-view'].classList.add('hidden');
  elements['session-view'].classList.remove('hidden');
  elements['page-title'].textContent = 'ChatGPT session';
  elements['chatgpt-session-button'].classList.add('active');
  elements['source-control-button'].classList.remove('active');
  elements['trees-button'].classList.remove('active');
  elements['task-history-button'].classList.remove('active');
  window.patchwork.setBrowserVisible(true);
  requestAnimationFrame(() => requestAnimationFrame(syncBrowserBounds));
  renderTaskList();
}

async function showSourceControl() {
  elements['composer-view'].classList.add('hidden');
  elements['task-view'].classList.add('hidden');
  elements['session-view'].classList.add('hidden');
  elements['trees-view'].classList.add('hidden');
  elements['history-view'].classList.add('hidden');
  elements['source-view'].classList.remove('hidden');
  elements['page-title'].textContent = 'Source control';
  elements['chatgpt-session-button'].classList.remove('active');
  elements['source-control-button'].classList.add('active');
  elements['trees-button'].classList.remove('active');
  elements['task-history-button'].classList.remove('active');
  window.patchwork.setBrowserVisible(false);
  renderSourceRepositories();
  await loadGitStatus(elements['source-repository-select'].value || state.selectedGitPath);
}

function showTrees() {
  elements['composer-view'].classList.add('hidden');
  elements['task-view'].classList.add('hidden');
  elements['session-view'].classList.add('hidden');
  elements['source-view'].classList.add('hidden');
  elements['history-view'].classList.add('hidden');
  elements['trees-view'].classList.remove('hidden');
  elements['page-title'].textContent = 'Coding trees';
  elements['chatgpt-session-button'].classList.remove('active');
  elements['source-control-button'].classList.remove('active');
  elements['trees-button'].classList.add('active');
  elements['task-history-button'].classList.remove('active');
  window.patchwork.setBrowserVisible(false);
  refreshTrees().catch((error) => showToast(error.message, true));
}

function showTaskHistory() {
  state.activeTask = null;
  elements['composer-view'].classList.add('hidden');
  elements['task-view'].classList.add('hidden');
  elements['session-view'].classList.add('hidden');
  elements['source-view'].classList.add('hidden');
  elements['trees-view'].classList.add('hidden');
  elements['history-view'].classList.remove('hidden');
  elements['page-title'].textContent = 'Task history';
  elements['chatgpt-session-button'].classList.remove('active');
  elements['source-control-button'].classList.remove('active');
  elements['trees-button'].classList.remove('active');
  elements['task-history-button'].classList.add('active');
  window.patchwork.setBrowserVisible(false);
  renderTaskList();
  renderTaskHistory();
}

function syncBrowserBounds() {
  const surface = !elements['session-view'].classList.contains('hidden')
    ? elements['session-chatgpt-surface']
    : !elements['task-view'].classList.contains('hidden')
      ? elements['chatgpt-surface']
      : null;
  if (!surface) return;
  const bounds = surface.getBoundingClientRect();
  window.patchwork.setBrowserBounds({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  });
}

async function chooseRepositories() {
  try {
    const repositories = await window.patchwork.chooseRepositories();
    if (repositories[0]) state.repositories = [repositories[0]];
    const workspace = new Map(state.workspaceRepositories.map((repository) => [repository.path, repository]));
    repositories.forEach((repository) => workspace.set(repository.path, repository));
    state.workspaceRepositories = [...workspace.values()];
    renderRepositories();
    renderSourceRepositories();
    return repositories;
  } catch (error) {
    showToast(error.message, true);
    return [];
  }
}

async function chooseAttachments() {
  try {
    const selected = await window.patchwork.chooseAttachments();
    const byPath = new Map(state.attachments.map((item) => [item.path, item]));
    for (const attachment of selected) byPath.set(attachment.path, attachment);
    state.attachments = [...byPath.values()];
    renderAttachments();
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderSourceRepositories() {
  const select = elements['source-repository-select'];
  const previous = state.selectedGitPath || select.value;
  select.replaceChildren();
  for (const repository of state.workspaceRepositories.filter((item) => !item.unavailable)) {
    const option = document.createElement('option');
    option.value = repository.path;
    option.textContent = repository.name;
    select.append(option);
  }
  const availablePaths = [...select.options].map((option) => option.value);
  select.value = availablePaths.includes(previous) ? previous : (availablePaths[0] || '');
  state.selectedGitPath = select.value || null;
  elements['source-remove-repository'].disabled = !select.value;
}

function gitDiffKey(filePath, staged) {
  return `${staged ? 'staged' : 'working'}:${filePath}`;
}

function renderDiffTabs() {
  const container = elements['diff-tabs'];
  if (state.diffTabs.length === 0) {
    container.innerHTML = '<span class="diff-tabs-empty">Open a changed file to compare it.</span>';
    return;
  }
  container.innerHTML = state.diffTabs.map((tab) => {
    const fileName = tab.filePath.split('/').pop();
    const active = tab.key === state.selectedDiffKey;
    return `<div class="diff-tab ${active ? 'active' : ''}">
      <button class="diff-tab-open" role="tab" aria-selected="${active}" data-key="${escapeHtml(tab.key)}" title="${escapeHtml(tab.filePath)}">
        <span class="diff-tab-status">${tab.staged ? 'S' : 'W'}</span>
        <span class="diff-tab-name">${escapeHtml(fileName)}</span>
      </button>
      <button class="diff-tab-close" data-key="${escapeHtml(tab.key)}" title="Close comparison" aria-label="Close ${escapeHtml(fileName)}">×</button>
    </div>`;
  }).join('');
  container.querySelectorAll('.diff-tab-open').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedDiffKey = button.dataset.key;
      renderDiffTabs();
      renderActiveDiff();
      renderGitStatus();
    });
  });
  container.querySelectorAll('.diff-tab-close').forEach((button) => {
    button.addEventListener('click', () => closeGitDiff(button.dataset.key));
  });
}

function renderDiffRows(rows) {
  if (!rows || rows.length === 0) {
    return '<div class="diff-empty-state">No textual changes to compare.</div>';
  }
  return rows.map((row) => `
    <div class="diff-line ${escapeHtml(row.beforeType)}">
      <span class="diff-line-number">${row.beforeNumber ?? ''}</span>
      <code>${row.beforeText ? escapeHtml(row.beforeText) : '&nbsp;'}</code>
    </div>
    <div class="diff-line ${escapeHtml(row.afterType)}">
      <span class="diff-line-number">${row.afterNumber ?? ''}</span>
      <code>${row.afterText ? escapeHtml(row.afterText) : '&nbsp;'}</code>
    </div>
  `).join('');
}

function renderActiveDiff() {
  const tab = state.diffTabs.find((item) => item.key === state.selectedDiffKey);
  if (!tab) {
    elements['diff-title'].textContent = 'Select a changed file';
    elements['diff-subtitle'].textContent = 'Its before and after comparison will appear here.';
    elements['diff-kind'].classList.add('hidden');
    elements['diff-before-label'].textContent = 'Before';
    elements['diff-after-label'].textContent = 'After';
    elements['diff-rows'].innerHTML = '<div class="diff-empty-state">No file selected.</div>';
    return;
  }

  elements['diff-title'].textContent = tab.filePath;
  elements['diff-kind'].textContent = tab.staged ? 'Staged' : 'Working tree';
  elements['diff-kind'].classList.remove('hidden');
  if (tab.loading) {
    elements['diff-subtitle'].textContent = 'Loading comparison…';
    elements['diff-before-label'].textContent = tab.staged ? 'HEAD' : 'Index';
    elements['diff-after-label'].textContent = tab.staged ? 'Index' : 'Working Tree';
    elements['diff-rows'].innerHTML = '<div class="diff-empty-state">Loading before and after…</div>';
    return;
  }
  if (tab.error) {
    elements['diff-subtitle'].textContent = 'Unable to load comparison';
    elements['diff-rows'].innerHTML = `<div class="diff-empty-state error">${escapeHtml(tab.error)}</div>`;
    return;
  }

  const diff = tab.diff;
  elements['diff-before-label'].textContent = diff.beforeLabel || 'Before';
  elements['diff-after-label'].textContent = diff.afterLabel || 'After';
  if (diff.binary) {
    elements['diff-subtitle'].textContent = 'Binary file';
    elements['diff-rows'].innerHTML = '<div class="diff-empty-state">Binary file comparison is unavailable.</div>';
    return;
  }
  elements['diff-subtitle'].textContent = diff.truncated
    ? 'Comparison truncated to keep the preview responsive'
    : (tab.staged ? 'HEAD compared with the staged file' : 'Index compared with the working file');
  elements['diff-rows'].innerHTML = renderDiffRows(diff.rows);
}

function closeGitDiff(key) {
  const index = state.diffTabs.findIndex((tab) => tab.key === key);
  if (index === -1) return;
  const wasSelected = state.selectedDiffKey === key;
  state.diffTabs.splice(index, 1);
  if (wasSelected) {
    const next = state.diffTabs[index] || state.diffTabs[index - 1] || null;
    state.selectedDiffKey = next?.key || null;
  }
  renderDiffTabs();
  renderActiveDiff();
  renderGitStatus();
}

function resetGitDiffTabs() {
  state.diffTabs = [];
  state.selectedDiffKey = null;
  renderDiffTabs();
  renderActiveDiff();
}

function pruneGitDiffTabs() {
  if (!state.gitStatus) {
    resetGitDiffTabs();
    return;
  }
  const validKeys = new Set();
  for (const change of state.gitStatus.changes) {
    if (change.staged) validKeys.add(gitDiffKey(change.path, true));
    if (change.unstaged) validKeys.add(gitDiffKey(change.path, false));
  }
  state.diffTabs = state.diffTabs.filter((tab) => validKeys.has(tab.key));
  if (!state.diffTabs.some((tab) => tab.key === state.selectedDiffKey)) {
    state.selectedDiffKey = state.diffTabs.at(-1)?.key || null;
  }
  renderDiffTabs();
  renderActiveDiff();
}

function gitFileMarkup(change, staged) {
  const parts = change.path.split('/');
  const fileName = parts.pop();
  const directory = parts.join('/') || 'repository root';
  const status = staged ? change.indexStatus : (change.untracked ? '?' : change.worktreeStatus);
  const key = gitDiffKey(change.path, staged);
  return `<div class="git-file-row">
    <button class="git-file-open ${state.selectedDiffKey === key ? 'active' : ''}" data-path="${escapeHtml(change.path)}" data-staged="${staged}">
      <span class="git-status-letter">${escapeHtml(status)}</span>
      <span class="git-file-name"><strong>${escapeHtml(fileName)}</strong><small>${escapeHtml(directory)}</small></span>
    </button>
    <button class="git-file-action" data-path="${escapeHtml(change.path)}" data-staged="${staged}" title="${staged ? 'Unstage' : 'Stage'}">${staged ? '−' : '+'}</button>
  </div>`;
}

function bindGitFileList(container) {
  container.querySelectorAll('.git-file-open').forEach((button) => {
    button.addEventListener('click', () => openGitDiff(button.dataset.path, button.dataset.staged === 'true'));
  });
  container.querySelectorAll('.git-file-action').forEach((button) => {
    button.addEventListener('click', () => {
      const staged = button.dataset.staged === 'true';
      const action = staged ? window.patchwork.gitUnstage : window.patchwork.gitStage;
      performGitMutation(() => action(state.selectedGitPath, [button.dataset.path]), staged ? 'File unstaged.' : 'File staged.');
    });
  });
}

function renderGitStatus() {
  const status = state.gitStatus;
  if (!status) {
    elements['source-branch'].textContent = 'No repository selected';
    elements['staged-count'].textContent = '0';
    elements['unstaged-count'].textContent = '0';
    elements['staged-files'].innerHTML = '';
    elements['unstaged-files'].innerHTML = '';
    elements['commit-history'].innerHTML = '';
    elements['source-count'].classList.add('hidden');
    return;
  }
  const repository = status.repository;
  elements['source-branch'].textContent = `${repository.branch} · ${repository.hasHead ? shortCommit(repository.baseCommit) : 'No commits yet'}`;
  elements['staged-count'].textContent = String(status.stagedCount);
  elements['unstaged-count'].textContent = String(status.unstagedCount);
  const total = status.changes.length;
  elements['source-count'].textContent = String(total);
  elements['source-count'].classList.toggle('hidden', total === 0);
  const staged = status.changes.filter((change) => change.staged);
  const unstaged = status.changes.filter((change) => change.unstaged);
  elements['staged-files'].innerHTML = staged.map((change) => gitFileMarkup(change, true)).join('');
  elements['unstaged-files'].innerHTML = unstaged.map((change) => gitFileMarkup(change, false)).join('');
  bindGitFileList(elements['staged-files']);
  bindGitFileList(elements['unstaged-files']);
  elements['stage-all-button'].disabled = unstaged.length === 0;
  elements['unstage-all-button'].disabled = staged.length === 0;
  elements['source-commit-button'].disabled = staged.length === 0;
  elements['commit-history'].innerHTML = status.history.map((commit) => `
    <div class="commit-item"><strong>${escapeHtml(commit.subject)}</strong><small>${escapeHtml(commit.shortCommit)} · ${escapeHtml(commit.author)}</small></div>
  `).join('');
}

async function loadGitStatus(repositoryPath) {
  if (!repositoryPath) {
    state.gitStatus = null;
    state.selectedGitPath = null;
    resetGitDiffTabs();
    renderGitStatus();
    return;
  }
  const repositoryChanged = Boolean(state.selectedGitPath && state.selectedGitPath !== repositoryPath);
  if (repositoryChanged) resetGitDiffTabs();
  state.selectedGitPath = repositoryPath;
  elements['source-repository-select'].value = repositoryPath;
  elements['source-branch'].textContent = 'Refreshing…';
  try {
    state.gitStatus = await window.patchwork.gitStatus(repositoryPath);
    const updated = state.gitStatus.repository;
    state.workspaceRepositories = state.workspaceRepositories.map((item) => item.path === updated.path ? updated : item);
    state.repositories = state.repositories.map((item) => item.path === updated.path ? updated : item);
    renderRepositories();
    renderGitStatus();
    pruneGitDiffTabs();
    const active = state.diffTabs.find((tab) => tab.key === state.selectedDiffKey);
    if (active) await openGitDiff(active.filePath, active.staged);
  } catch (error) {
    state.gitStatus = null;
    resetGitDiffTabs();
    renderGitStatus();
    showToast(error.message, true);
  }
}

async function openGitDiff(filePath, staged) {
  if (!state.selectedGitPath) return;
  const key = gitDiffKey(filePath, staged);
  let tab = state.diffTabs.find((item) => item.key === key);
  if (!tab) {
    tab = { key, filePath, staged, loading: true, diff: null, error: null };
    state.diffTabs.push(tab);
  } else {
    tab.loading = true;
    tab.error = null;
  }
  state.selectedDiffKey = key;
  renderDiffTabs();
  renderActiveDiff();
  renderGitStatus();
  try {
    const diff = await window.patchwork.gitDiff(state.selectedGitPath, filePath, staged);
    const current = state.diffTabs.find((item) => item.key === key);
    if (!current) return;
    current.loading = false;
    current.diff = diff;
    current.error = null;
  } catch (error) {
    const current = state.diffTabs.find((item) => item.key === key);
    if (!current) return;
    current.loading = false;
    current.error = error.message;
  } finally {
    renderDiffTabs();
    renderActiveDiff();
  }
}

async function performGitMutation(operation, successMessage) {
  if (!state.selectedGitPath) return;
  try {
    state.gitStatus = await operation();
    const updated = state.gitStatus.repository;
    state.workspaceRepositories = state.workspaceRepositories.map((item) => item.path === updated.path ? updated : item);
    state.repositories = state.repositories.map((item) => item.path === updated.path ? updated : item);
    renderRepositories();
    renderGitStatus();
    pruneGitDiffTabs();
    const active = state.diffTabs.find((tab) => tab.key === state.selectedDiffKey);
    if (active) await openGitDiff(active.filePath, active.staged);
    if (successMessage) showToast(successMessage);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function createTask() {
  const button = elements['create-task-button'];
  button.disabled = true;
  button.firstChild.textContent = 'Preparing bundle… ';
  try {
    let chatgptProject = null;
    const projectSelection = elements['chatgpt-project-select'].value;
    if (projectSelection === '__new__') {
      const projectName = elements['new-project-name'].value.trim();
      if (!projectName) throw new Error('Enter a name for the new ChatGPT project.');
      button.firstChild.textContent = 'Creating ChatGPT project… ';
      chatgptProject = await window.patchwork.createChatGPTProject(projectName);
      state.chatgptProjects = [chatgptProject, ...state.chatgptProjects.filter((item) => item.id !== chatgptProject.id)];
      renderChatGPTProjects();
      elements['chatgpt-project-select'].value = chatgptProject.id;
      elements['new-project-fields'].classList.add('hidden');
      elements['new-project-name'].disabled = true;
    } else if (projectSelection) {
      chatgptProject = state.chatgptProjects.find((project) => project.id === projectSelection) || null;
      if (!chatgptProject) throw new Error('Refresh ChatGPT projects and choose the destination again.');
    }
    button.firstChild.textContent = 'Preparing bundle… ';
    const task = await window.patchwork.createTask({
      repositories: state.repositories,
      taskText: elements['task-text'].value,
      model: elements['task-model-select'].value,
      reasoningMode: elements['task-reasoning-select'].value,
      autoApply: true,
      treeId: elements['task-tree-select'].value || null,
      treeName: elements['tree-name'].value,
      attachments: state.attachments,
      chatgptProject,
    });
    state.attachments = [];
    renderAttachments();
    upsertTask(task);
    await refreshTrees();
    showTask(task);
    addActivity('Fresh embedded chat prepared');
    showToast('Task package prepared. Submitting through the embedded browser…');
    setTimeout(() => runTaskAction(window.patchwork.submitTask), 700);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.firstChild.textContent = 'Prepare and submit with ChatGPT ';
  }
}

async function runTaskAction(action, successMessage) {
  if (!state.activeTask) return;
  try {
    const result = await action(state.activeTask.taskId);
    if (result && result.taskId) showTask(result);
    if (successMessage) showToast(successMessage);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function runBrowserAction(action, successMessage) {
  try {
    await action();
    if (successMessage) showToast(successMessage);
  } catch (error) {
    showToast(error.message, true);
  }
}

elements['new-task-button'].addEventListener('click', showComposer);
elements['chatgpt-session-button'].addEventListener('click', showSession);
elements['source-control-button'].addEventListener('click', showSourceControl);
elements['trees-button'].addEventListener('click', showTrees);
elements['task-history-button'].addEventListener('click', showTaskHistory);
elements['task-history-search'].addEventListener('input', renderTaskHistory);
elements['task-history-state'].addEventListener('change', renderTaskHistory);
elements['trees-new-task'].addEventListener('click', () => {
  elements['task-tree-select'].value = '';
  elements['tree-name'].value = '';
  showComposer();
});
elements['task-tree-select'].addEventListener('change', renderTaskTreeOptions);
elements['chatgpt-project-select'].addEventListener('change', renderChatGPTProjects);
elements['refresh-projects-button'].addEventListener('click', () => refreshChatGPTProjects(true));
elements['add-repository-button'].addEventListener('click', chooseRepositories);
elements['add-attachment-button'].addEventListener('click', chooseAttachments);
elements['create-task-button'].addEventListener('click', createTask);
elements['submit-task-button'].addEventListener('click', () => runTaskAction(window.patchwork.submitTask, 'Task submitted.'));
elements['copy-prompt-button'].addEventListener('click', () => runTaskAction(window.patchwork.copyPrompt, 'Instructions copied.'));
elements['reveal-package-button'].addEventListener('click', () => runTaskAction(window.patchwork.revealPackage));
elements['import-result-button'].addEventListener('click', () => runTaskAction(window.patchwork.importResult));
elements['apply-button'].addEventListener('click', () => runTaskAction(window.patchwork.applyTask, 'Changes applied.'));
elements['resolve-conflict-button'].addEventListener('click', async () => {
  if (!state.activeTask) return;
  const button = elements['resolve-conflict-button'];
  button.disabled = true;
  try {
    const task = await window.patchwork.resolveTaskConflict(state.activeTask.taskId);
    if (!task) return;
    upsertTask(task);
    await refreshTrees();
    showTask(task);
    showToast('Conflict-resolution task submitted to ChatGPT.');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});
elements['rollback-button'].addEventListener('click', () => runTaskAction(window.patchwork.rollbackTask, 'Changes rolled back.'));
elements['new-chat-button'].addEventListener('click', () => runBrowserAction(window.patchwork.newChat, 'New ChatGPT chat opened.'));
elements['browser-reload-button'].addEventListener('click', () => runBrowserAction(window.patchwork.reloadBrowser));
elements['browser-back-button'].addEventListener('click', () => runBrowserAction(window.patchwork.browserBack));
elements['browser-forward-button'].addEventListener('click', () => runBrowserAction(window.patchwork.browserForward));
elements['session-new-chat-button'].addEventListener('click', () => runBrowserAction(window.patchwork.newChat, 'New ChatGPT chat opened.'));
elements['session-reload-button'].addEventListener('click', () => runBrowserAction(window.patchwork.reloadBrowser));
elements['session-back-button'].addEventListener('click', () => runBrowserAction(window.patchwork.browserBack));
elements['session-forward-button'].addEventListener('click', () => runBrowserAction(window.patchwork.browserForward));
elements['source-repository-select'].addEventListener('change', (event) => loadGitStatus(event.target.value));
elements['source-refresh'].addEventListener('click', () => loadGitStatus(state.selectedGitPath));
elements['source-add-repository'].addEventListener('click', async () => {
  const added = await chooseRepositories();
  renderSourceRepositories();
  if (added[0]) await loadGitStatus(added[0].path);
});
elements['source-remove-repository'].addEventListener('click', async () => {
  if (!state.selectedGitPath) return;
  try {
    state.workspaceRepositories = await window.patchwork.removeWorkspaceRepository(state.selectedGitPath);
    state.repositories = state.repositories.filter((item) => item.path !== state.selectedGitPath);
    state.selectedGitPath = null;
    state.gitStatus = null;
    resetGitDiffTabs();
    renderRepositories();
    renderSourceRepositories();
    await loadGitStatus(elements['source-repository-select'].value);
  } catch (error) {
    showToast(error.message, true);
  }
});
elements['stage-all-button'].addEventListener('click', () => performGitMutation(
  () => window.patchwork.gitStageAll(state.selectedGitPath),
  'All changes staged.',
));
elements['unstage-all-button'].addEventListener('click', () => performGitMutation(
  () => window.patchwork.gitUnstageAll(state.selectedGitPath),
  'All changes unstaged.',
));
elements['source-commit-button'].addEventListener('click', async () => {
  const message = elements['source-commit-message'].value;
  await performGitMutation(
    () => window.patchwork.gitCommit(state.selectedGitPath, message),
    'Commit created.',
  );
  if (state.gitStatus?.stagedCount === 0) elements['source-commit-message'].value = '';
});

window.addEventListener('resize', syncBrowserBounds);
window.addEventListener('scroll', syncBrowserBounds, true);
new ResizeObserver(syncBrowserBounds).observe(elements['chatgpt-surface']);
new ResizeObserver(syncBrowserBounds).observe(elements['session-chatgpt-surface']);
setInterval(updateTaskElapsedTimes, 1_000);

window.patchwork.onTaskEvent((event) => {
  if (event.task) upsertTask(event.task);
  if (event.task) {
    renderTaskList();
    if (!elements['history-view'].classList.contains('hidden')) renderTaskHistory();
  }
  if (event.task && (!state.activeTask || state.activeTask.taskId === event.task.taskId)) showTask(event.task);
  if (event.message) addActivity(event.message);
  if (event.type === 'task-failed') showToast(event.message || 'Task failed.', true);
  if (event.type === 'task-applied') {
    showToast('ChatGPT changes were validated and committed to the coding tree.');
    refreshTrees().catch(() => {});
  }
  if (event.type === 'task-applied' && state.selectedGitPath) loadGitStatus(state.selectedGitPath);
  if (event.type === 'result-ready') showToast('The ChatGPT result is ready to review.');
  if (event.type === 'browser-loading') {
    elements['browser-status'].textContent = event.loading ? 'Loading…' : 'Embedded session';
    elements['browser-status-dot'].classList.toggle('loading', event.loading);
    elements['session-browser-status'].textContent = event.loading ? 'Loading…' : 'Persistent embedded session';
    elements['session-status-dot'].classList.toggle('loading', event.loading);
  }
  if (event.type === 'browser-title' && event.title) {
    elements['browser-title'].textContent = event.title;
    elements['session-browser-title'].textContent = event.title;
  }
  if (event.type === 'browser-login-required') showToast(event.message, true);
  if (event.type === 'tree-created' || event.type === 'tree-removed' || event.type === 'tree-merged') {
    refreshTrees().catch(() => {});
  }
  if (event.type === 'tree-merged') showToast('Coding tree merged as one commit and removed.');
  if (event.type === 'tree-merged' && event.result?.repositoryPath) {
    state.selectedGitPath = event.result.repositoryPath;
    if (!elements['source-view'].classList.contains('hidden')) loadGitStatus(state.selectedGitPath);
  }
  if (event.type === 'merge-submitted') showToast('ChatGPT is preparing the final squash commit message.');
  if (event.type === 'merge-failed') {
    showToast(event.message || 'The coding tree could not be merged.', true);
    refreshTrees().catch(() => {});
  }
});

async function initialize() {
  try {
    const [tasks, repositories, trees] = await Promise.all([
      window.patchwork.listTasks(),
      window.patchwork.listWorkspaceRepositories(),
      window.patchwork.listTrees(),
    ]);
    state.tasks = tasks;
    state.trees = trees;
    state.workspaceRepositories = repositories;
    state.repositories = repositories.filter((repository) => !repository.unavailable).slice(0, 1);
    renderTaskList();
    renderRepositories();
    renderTrees();
    renderSourceRepositories();
    showSession();
  } catch (error) {
    showToast(error.message, true);
  }
}

initialize();

function upsertTask(task) {
  const index = state.tasks.findIndex((item) => item.taskId === task.taskId);
  if (index >= 0) state.tasks[index] = task;
  else state.tasks.unshift(task);
  state.tasks.sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
}
