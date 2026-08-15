const state = {
  repositories: [],
  workspaceRepositories: [],
  tasks: [],
  activeTask: null,
  activity: [],
  gitStatus: null,
  selectedGitPath: null,
  selectedDiffKey: null,
};

const elements = Object.fromEntries(
  [
    'new-task-button', 'chatgpt-session-button', 'task-list', 'page-title',
    'composer-view', 'task-view', 'session-view', 'source-view',
    'add-repository-button', 'repository-list', 'task-text', 'auto-apply',
    'create-task-button', 'task-status-title', 'task-status-copy', 'status-badge',
    'submit-task-button', 'copy-prompt-button', 'reveal-package-button',
    'import-result-button', 'result-card', 'result-summary', 'patch-list',
    'apply-button', 'rollback-button', 'activity-list', 'toast', 'connection-pill',
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
    'diff-title', 'diff-subtitle', 'diff-kind', 'diff-content',
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

function addActivity(message, timestamp = new Date()) {
  state.activity.unshift({ message, timestamp });
  state.activity = state.activity.slice(0, 20);
  elements['activity-list'].innerHTML = state.activity
    .map((item) => `<div class="activity-item"><strong>${escapeHtml(item.message)}</strong><time>${escapeHtml(formatTime(item.timestamp))}</time></div>`)
    .join('');
}

function renderRepositories() {
  const container = elements['repository-list'];
  if (state.repositories.length === 0) {
    container.className = 'repository-list empty-state';
    container.innerHTML = '<div class="empty-icon">⌘</div><strong>No repositories selected</strong><span>Add one or more Git repositories to begin.</span>';
    return;
  }
  container.className = 'repository-list';
  container.innerHTML = state.repositories.map((repository) => `
    <div class="repository-row">
      <div class="repo-icon">${escapeHtml(repository.name[0]?.toUpperCase() || 'G')}</div>
      <div class="repo-info"><strong>${escapeHtml(repository.name)}</strong><span>${escapeHtml(repository.path)}</span></div>
      <div class="repo-meta">${escapeHtml(repository.branch)} · ${repository.hasHead ? escapeHtml(shortCommit(repository.baseCommit)) : 'No commits'}</div>
      <div class="repo-state ${repository.isClean ? '' : 'dirty'}">${repository.isClean ? 'Clean' : 'Snapshot needed'}</div>
      <button class="remove-repo" data-repository-id="${escapeHtml(repository.id)}" aria-label="Remove ${escapeHtml(repository.name)}">×</button>
    </div>`).join('');
  container.querySelectorAll('.remove-repo').forEach((button) => {
    button.addEventListener('click', () => {
      state.repositories = state.repositories.filter((item) => item.id !== button.dataset.repositoryId);
      renderRepositories();
    });
  });
}

function taskLabel(task) {
  const firstLine = String(task.taskText || 'Untitled task').split('\n')[0];
  return firstLine.length > 34 ? `${firstLine.slice(0, 34)}…` : firstLine;
}

function renderTaskList() {
  elements['task-list'].innerHTML = state.tasks.length
    ? state.tasks.map((task) => `
      <button class="task-nav-item ${state.activeTask?.taskId === task.taskId ? 'active' : ''}" data-task-id="${escapeHtml(task.taskId)}">
        <strong>${escapeHtml(taskLabel(task))}</strong>
        <span>${escapeHtml(task.state)} · ${escapeHtml(formatTime(task.createdAt))}</span>
      </button>`).join('')
    : '<p class="muted small">No tasks yet.</p>';
  elements['task-list'].querySelectorAll('.task-nav-item').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        showTask(await window.patchwork.getTask(button.dataset.taskId));
      } catch (error) {
        showToast(error.message, true);
      }
    });
  });
}

const statusText = {
  prepared: ['Package prepared', 'Attach the package in ChatGPT and send the copied instructions.'],
  submitted: ['Task submitted', 'ChatGPT is working in the embedded browser. Patchwork is watching for the result.'],
  ready: ['Patch validated', 'The downloaded result matches the task and is safe to apply.'],
  applied: ['Changes applied', 'The validated patch is now present in your local repositories.'],
  'rolled-back': ['Changes rolled back', 'The patch was removed from your local repositories.'],
  failed: ['Task needs attention', 'Patchwork stopped before making unsafe or conflicting changes.'],
};

function renderResult(task) {
  const hasResult = Boolean(task.result);
  elements['result-card'].classList.toggle('hidden', !hasResult);
  if (!hasResult) return;
  elements['result-summary'].textContent = task.result.summary || 'ChatGPT returned a validated result.';
  elements['patch-list'].innerHTML = task.result.patches.map((patch) => `
    <div class="patch-item">
      <strong>${escapeHtml(patch.name || patch.id)}</strong>
      <pre>${escapeHtml(patch.stat || 'No changes')}</pre>
    </div>`).join('');
  elements['apply-button'].classList.toggle('hidden', task.state !== 'ready');
  elements['rollback-button'].classList.toggle('hidden', task.state !== 'applied');
}

function showTask(task) {
  state.activeTask = task;
  state.activity = [];
  elements['composer-view'].classList.add('hidden');
  elements['session-view'].classList.add('hidden');
  elements['source-view'].classList.add('hidden');
  elements['task-view'].classList.remove('hidden');
  elements['chatgpt-session-button'].classList.remove('active');
  elements['source-control-button'].classList.remove('active');
  elements['page-title'].textContent = taskLabel(task);
  const [title, copy] = statusText[task.state] || statusText.prepared;
  elements['task-status-title'].textContent = title;
  elements['task-status-copy'].textContent = task.error || copy;
  elements['status-badge'].textContent = task.state;
  elements['status-badge'].className = `status-badge ${task.state}`;
  addActivity(`Task ${task.state}`, task.updatedAt || task.createdAt);
  addActivity(`${task.repositories.length} repository snapshot${task.repositories.length === 1 ? '' : 's'} prepared`, task.createdAt);
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
  elements['composer-view'].classList.remove('hidden');
  elements['page-title'].textContent = 'Prepare a coding task';
  elements['chatgpt-session-button'].classList.remove('active');
  elements['source-control-button'].classList.remove('active');
  window.patchwork.setBrowserVisible(false);
  renderTaskList();
}

function showSession() {
  elements['composer-view'].classList.add('hidden');
  elements['task-view'].classList.add('hidden');
  elements['source-view'].classList.add('hidden');
  elements['session-view'].classList.remove('hidden');
  elements['page-title'].textContent = 'ChatGPT session';
  elements['chatgpt-session-button'].classList.add('active');
  elements['source-control-button'].classList.remove('active');
  window.patchwork.setBrowserVisible(true);
  requestAnimationFrame(() => requestAnimationFrame(syncBrowserBounds));
  renderTaskList();
}

async function showSourceControl() {
  elements['composer-view'].classList.add('hidden');
  elements['task-view'].classList.add('hidden');
  elements['session-view'].classList.add('hidden');
  elements['source-view'].classList.remove('hidden');
  elements['page-title'].textContent = 'Source control';
  elements['chatgpt-session-button'].classList.remove('active');
  elements['source-control-button'].classList.add('active');
  window.patchwork.setBrowserVisible(false);
  renderSourceRepositories();
  await loadGitStatus(elements['source-repository-select'].value || state.selectedGitPath);
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
    const existing = new Map(state.repositories.map((repository) => [repository.path, repository]));
    repositories.forEach((repository) => existing.set(repository.path, repository));
    state.repositories = [...existing.values()];
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

function gitFileMarkup(change, staged) {
  const parts = change.path.split('/');
  const fileName = parts.pop();
  const directory = parts.join('/') || 'repository root';
  const status = staged ? change.indexStatus : (change.untracked ? '?' : change.worktreeStatus);
  const key = `${staged ? 'staged' : 'working'}:${change.path}`;
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
    renderGitStatus();
    return;
  }
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
  } catch (error) {
    state.gitStatus = null;
    renderGitStatus();
    showToast(error.message, true);
  }
}

async function openGitDiff(filePath, staged) {
  if (!state.selectedGitPath) return;
  state.selectedDiffKey = `${staged ? 'staged' : 'working'}:${filePath}`;
  elements['diff-title'].textContent = filePath;
  elements['diff-subtitle'].textContent = 'Loading diff…';
  elements['diff-kind'].textContent = staged ? 'Staged' : 'Working tree';
  elements['diff-kind'].classList.remove('hidden');
  elements['diff-content'].textContent = '';
  renderGitStatus();
  try {
    const diff = await window.patchwork.gitDiff(state.selectedGitPath, filePath, staged);
    elements['diff-subtitle'].textContent = diff.binary
      ? 'Binary file'
      : diff.truncated ? 'Preview truncated to 500 KB' : (staged ? 'Changes ready to commit' : 'Unstaged changes');
    elements['diff-content'].textContent = diff.content;
  } catch (error) {
    elements['diff-subtitle'].textContent = 'Unable to load diff';
    elements['diff-content'].textContent = error.message;
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
    const task = await window.patchwork.createTask({
      repositories: state.repositories,
      taskText: elements['task-text'].value,
      autoApply: elements['auto-apply'].checked,
    });
    state.tasks.unshift(task);
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
elements['add-repository-button'].addEventListener('click', chooseRepositories);
elements['create-task-button'].addEventListener('click', createTask);
elements['submit-task-button'].addEventListener('click', () => runTaskAction(window.patchwork.submitTask, 'Task submitted.'));
elements['copy-prompt-button'].addEventListener('click', () => runTaskAction(window.patchwork.copyPrompt, 'Instructions copied.'));
elements['reveal-package-button'].addEventListener('click', () => runTaskAction(window.patchwork.revealPackage));
elements['import-result-button'].addEventListener('click', () => runTaskAction(window.patchwork.importResult));
elements['apply-button'].addEventListener('click', () => runTaskAction(window.patchwork.applyTask, 'Changes applied.'));
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

window.patchwork.onTaskEvent((event) => {
  if (event.task && (!state.activeTask || state.activeTask.taskId === event.task.taskId)) showTask(event.task);
  if (event.message) addActivity(event.message);
  if (event.type === 'task-failed') showToast(event.message || 'Task failed.', true);
  if (event.type === 'task-applied') showToast('ChatGPT changes were validated and applied.');
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
});

async function initialize() {
  try {
    const [tasks, repositories] = await Promise.all([
      window.patchwork.listTasks(),
      window.patchwork.listWorkspaceRepositories(),
    ]);
    state.tasks = tasks;
    state.workspaceRepositories = repositories;
    state.repositories = repositories.filter((repository) => !repository.unavailable);
    renderTaskList();
    renderRepositories();
    renderSourceRepositories();
    showSession();
  } catch (error) {
    showToast(error.message, true);
  }
}

initialize();
