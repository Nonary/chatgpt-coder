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
};

const elements = Object.fromEntries(
  [
    'new-task-button', 'chatgpt-session-button', 'task-list', 'page-title',
    'composer-view', 'task-view', 'session-view', 'source-view',
    'trees-view', 'trees-button', 'tree-count', 'trees-list', 'trees-new-task',
    'add-repository-button', 'repository-list', 'task-text', 'auto-apply',
    'task-tree-select', 'new-tree-fields', 'tree-name',
    'create-task-button', 'task-status-title', 'task-status-copy', 'status-badge',
    'submit-task-button', 'copy-prompt-button', 'reveal-package-button',
    'import-result-button', 'result-card', 'result-summary', 'patch-list',
    'apply-button', 'resolve-conflicts-button', 'rollback-button', 'activity-list', 'toast', 'connection-pill',
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

function renderTaskTreeOptions() {
  const select = elements['task-tree-select'];
  const previous = select.value;
  select.innerHTML = '<option value="">Create a new coding tree</option>' + state.trees
    .filter((tree) => tree.available && tree.mergeState !== 'submitted')
    .map((tree) => `<option value="${escapeHtml(tree.id)}">${escapeHtml(tree.name)} · ${escapeHtml(tree.repositoryName)}</option>`)
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
      <div><strong>${escapeHtml(tree.name)}</strong><small>${escapeHtml(tree.branch)}</small></div>
      <span class="tree-state ${tree.clean && tree.mergeState !== 'failed' ? '' : 'dirty'}">${tree.available ? (tree.mergeState === 'submitted' ? 'Merging' : tree.mergeState === 'failed' ? 'Merge failed' : tree.clean ? 'Clean' : 'Changes') : 'Missing'}</span>
    </div>
    <div class="tree-stats">
      <div class="tree-stat"><strong>${escapeHtml(tree.commitCount || 0)}</strong><small>Tree commits</small></div>
      <div class="tree-stat"><strong>${escapeHtml((tree.taskIds || []).length)}</strong><small>Tasks</small></div>
    </div>
    <div class="tree-last">${tree.lastSubject ? `${escapeHtml(tree.lastCommit)} · ${escapeHtml(tree.lastSubject)}` : 'No task commits yet.'}</div>
    <div class="tree-actions">
      <button class="primary tree-continue" data-tree-id="${escapeHtml(tree.id)}" ${!tree.available || tree.mergeState === 'submitted' ? 'disabled' : ''}>Continue task</button>
      <button class="secondary tree-source" data-tree-id="${escapeHtml(tree.id)}" ${!tree.available ? 'disabled' : ''}>Source control</button>
      <button class="secondary tree-merge" data-tree-id="${escapeHtml(tree.id)}" ${!tree.available || !tree.clean || !tree.commitCount || tree.mergeState === 'submitted' ? 'disabled' : ''}>Merge tree</button>
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
  elements['task-list'].querySelectorAll('.task-elapsed[data-started-at]').forEach((element) => {
    element.textContent = formatElapsed(element.dataset.startedAt);
  });
}

function renderTaskList() {
  elements['task-list'].innerHTML = state.tasks.length
    ? state.tasks.map((task) => `
      <button class="task-nav-item ${state.activeTask?.taskId === task.taskId ? 'active' : ''}" data-task-id="${escapeHtml(task.taskId)}">
        <span class="task-name-row">
          <strong>${escapeHtml(taskLabel(task))}</strong>
          ${task.state === 'submitted' && task.submittedAt ? `<time class="task-elapsed" data-started-at="${escapeHtml(task.submittedAt)}">${escapeHtml(formatElapsed(task.submittedAt))}</time>` : ''}
        </span>
        <span>${escapeHtml(task.state)} · ${escapeHtml(formatTime(task.createdAt))}</span>
      </button>`).join('')
    : '<p class="muted small">No tasks yet.</p>';
  elements['task-list'].querySelectorAll('.task-nav-item').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        const task = await window.patchwork.getTask(button.dataset.taskId);
        showTask(task);
        const opened = await window.patchwork.openTaskChat(task.taskId);
        if (!opened.opened && opened.message) showToast(opened.message, task.state !== 'prepared');
      } catch (error) {
        showToast(error.message, true);
      }
    });
  });
}

const statusText = {
  prepared: ['Package prepared', 'Attach the package in ChatGPT and send the copied instructions.'],
  submitted: ['Task submitted', 'ChatGPT is working in the embedded browser. Patchwork is watching for the downloadable text result.'],
  ready: ['Patch validated', 'The downloaded text result matches the task and is safe to commit.'],
  applied: ['Changes committed', 'The validated patch is committed in this task’s coding tree.'],
  conflicted: ['Merge conflicts need resolution', 'The coding tree and ChatGPT result both contain changes that need to be reconciled.'],
  'rolled-back': ['Changes reverted', 'A revert commit was created in this task’s coding tree.'],
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
    </div>`).join('') + (task.result.commitMessage ? `<div class="patch-item"><strong>Commit</strong><pre>${escapeHtml(task.result.commitMessage)}${task.result.commits?.[0]?.commit ? `\n${escapeHtml(shortCommit(task.result.commits[0].commit))}` : ''}</pre></div>` : '')
    + (task.result.conflicts?.length ? task.result.conflicts.map((conflict) => `<div class="patch-item"><strong>Merge conflict</strong><pre>${escapeHtml((conflict.files || []).length ? conflict.files.join('\n') : conflict.error || 'The patch did not apply cleanly.')}</pre></div>`).join('') : '');
  elements['apply-button'].classList.toggle('hidden', task.state !== 'ready');
  elements['resolve-conflicts-button'].classList.toggle('hidden', task.state !== 'conflicted' || !task.treeId);
  elements['rollback-button'].classList.toggle('hidden', task.state !== 'applied');
}

function showTask(task) {
  state.activeTask = task;
  state.activity = [];
  elements['composer-view'].classList.add('hidden');
  elements['session-view'].classList.add('hidden');
  elements['source-view'].classList.add('hidden');
  elements['trees-view'].classList.add('hidden');
  elements['task-view'].classList.remove('hidden');
  elements['chatgpt-session-button'].classList.remove('active');
  elements['source-control-button'].classList.remove('active');
  elements['trees-button'].classList.remove('active');
  elements['page-title'].textContent = taskLabel(task);
  const [title, copy] = statusText[task.state] || statusText.prepared;
  elements['task-status-title'].textContent = title;
  elements['task-status-copy'].textContent = task.error || copy;
  elements['status-badge'].textContent = task.state;
  elements['status-badge'].className = `status-badge ${task.state}`;
  addActivity(`Task ${task.state}`, task.updatedAt || task.createdAt);
  addActivity(`${task.repositories.length} repository snapshot${task.repositories.length === 1 ? '' : 's'} prepared`, task.createdAt);
  if (task.packageBytes) {
    const packageMegabytes = task.packageBytes / (1024 * 1024);
    addActivity(`Task package ${packageMegabytes >= 1 ? `${packageMegabytes.toFixed(1)} MB` : `${Math.ceil(task.packageBytes / 1024)} KB`}`, task.createdAt);
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
  elements['composer-view'].classList.remove('hidden');
  elements['page-title'].textContent = 'Prepare a coding task';
  elements['chatgpt-session-button'].classList.remove('active');
  elements['source-control-button'].classList.remove('active');
  elements['trees-button'].classList.remove('active');
  window.patchwork.setBrowserVisible(false);
  renderTaskTreeOptions();
  renderTaskList();
}

function showSession() {
  elements['composer-view'].classList.add('hidden');
  elements['task-view'].classList.add('hidden');
  elements['source-view'].classList.add('hidden');
  elements['trees-view'].classList.add('hidden');
  elements['session-view'].classList.remove('hidden');
  elements['page-title'].textContent = 'ChatGPT session';
  elements['chatgpt-session-button'].classList.add('active');
  elements['source-control-button'].classList.remove('active');
  elements['trees-button'].classList.remove('active');
  window.patchwork.setBrowserVisible(true);
  requestAnimationFrame(() => requestAnimationFrame(syncBrowserBounds));
  renderTaskList();
}

async function showSourceControl() {
  elements['composer-view'].classList.add('hidden');
  elements['task-view'].classList.add('hidden');
  elements['session-view'].classList.add('hidden');
  elements['trees-view'].classList.add('hidden');
  elements['source-view'].classList.remove('hidden');
  elements['page-title'].textContent = 'Source control';
  elements['chatgpt-session-button'].classList.remove('active');
  elements['source-control-button'].classList.add('active');
  elements['trees-button'].classList.remove('active');
  window.patchwork.setBrowserVisible(false);
  renderSourceRepositories();
  await loadGitStatus(elements['source-repository-select'].value || state.selectedGitPath);
}

function showTrees() {
  elements['composer-view'].classList.add('hidden');
  elements['task-view'].classList.add('hidden');
  elements['session-view'].classList.add('hidden');
  elements['source-view'].classList.add('hidden');
  elements['trees-view'].classList.remove('hidden');
  elements['page-title'].textContent = 'Coding trees';
  elements['chatgpt-session-button'].classList.remove('active');
  elements['source-control-button'].classList.remove('active');
  elements['trees-button'].classList.add('active');
  window.patchwork.setBrowserVisible(false);
  refreshTrees().catch((error) => showToast(error.message, true));
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
      autoApply: true,
      treeId: elements['task-tree-select'].value || null,
      treeName: elements['tree-name'].value,
    });
    state.tasks.unshift(task);
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
elements['trees-new-task'].addEventListener('click', () => {
  elements['task-tree-select'].value = '';
  elements['tree-name'].value = '';
  showComposer();
});
elements['task-tree-select'].addEventListener('change', renderTaskTreeOptions);
elements['add-repository-button'].addEventListener('click', chooseRepositories);
elements['create-task-button'].addEventListener('click', createTask);
elements['submit-task-button'].addEventListener('click', () => runTaskAction(window.patchwork.submitTask, 'Task submitted.'));
elements['copy-prompt-button'].addEventListener('click', () => runTaskAction(window.patchwork.copyPrompt, 'Instructions copied.'));
elements['reveal-package-button'].addEventListener('click', () => runTaskAction(window.patchwork.revealPackage));
elements['import-result-button'].addEventListener('click', () => runTaskAction(window.patchwork.importResult));
elements['apply-button'].addEventListener('click', () => runTaskAction(window.patchwork.applyTask, 'Changes applied.'));
elements['resolve-conflicts-button'].addEventListener('click', async () => {
  if (!state.activeTask) return;
  try {
    const task = await window.patchwork.resubmitConflicts(state.activeTask.taskId);
    const index = state.tasks.findIndex((item) => item.taskId === task.taskId);
    if (index >= 0) state.tasks[index] = task;
    else state.tasks.unshift(task);
    await refreshTrees();
    showTask(task);
    showToast('Conflict context packaged. Submitting it in a fresh ChatGPT chat…');
    setTimeout(() => runTaskAction(window.patchwork.submitTask), 700);
  } catch (error) {
    showToast(error.message, true);
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
  if (event.task) {
    const index = state.tasks.findIndex((task) => task.taskId === event.task.taskId);
    if (index >= 0) state.tasks[index] = event.task;
    else state.tasks.unshift(event.task);
  }
  if (event.task && (!state.activeTask || state.activeTask.taskId === event.task.taskId)) showTask(event.task);
  if (event.message) addActivity(event.message);
  if (event.type === 'task-failed') showToast(event.message || 'Task failed.', true);
  if (event.type === 'task-conflicted') {
    showToast('Merge conflicts need a follow-up resolution task.', true);
    refreshTrees().catch(() => {});
  }
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
