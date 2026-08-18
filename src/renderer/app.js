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
  skillCatalog: [],
  selectedSkillIds: [],
  promptLibrary: [],
  selectedPromptIds: [],
  promptLibrarySearch: '',
  editingPromptId: null,
  chatgptProjects: [],
  projectSelection: undefined,
  conflictResolutionTaskId: null,
  gitSummaryBusy: false,
  diffTabContextKey: null,
  chatTaskId: null,
  chatSnapshot: null,
  chatLoading: false,
  chatSending: false,
  chatError: null,
};

const TASK_MODEL_STORAGE_KEY = 'patchwork.task-model';
const TASK_REASONING_STORAGE_KEY = 'patchwork.task-reasoning';
const TASK_TREE_STORAGE_KEY = 'patchwork.task-tree';
const TASK_PROJECT_STORAGE_KEY = 'patchwork.task-project';
const PROMPT_LIBRARY_STORAGE_KEY = 'patchwork.prompt-library';
const TASK_NEW_TREE_VALUE = '__new__';
const MAX_PROMPTS = 100;
const MAX_PROMPT_CONTENT_LENGTH = 12_000;
const PROJECT_REFRESH_TIMEOUT_MILLISECONDS = 30_000;

const elements = Object.fromEntries(
  [
    'new-task-button', 'chatgpt-session-button', 'task-list', 'page-title',
    'composer-view', 'task-view', 'session-view', 'source-view',
    'trees-view', 'trees-button', 'tree-count', 'trees-list', 'trees-new-task',
    'history-view', 'task-history-button', 'task-history-count', 'task-history-list',
    'task-history-search', 'task-history-state',
    'add-repository-button', 'repository-list', 'task-text', 'auto-apply',
    'add-attachment-button', 'attachment-list', 'configure-skills-button', 'skill-selection-label', 'skill-selection-summary',
    'skills-modal', 'skills-close-button', 'skills-refresh-button', 'skills-search', 'skills-list', 'skills-selection-status', 'skills-done-button',
    'prompt-library-trigger', 'prompt-library-trigger-label', 'prompt-selection-summary', 'prompt-library-menu',
    'prompt-library-manage-button', 'prompt-library-new-button', 'prompt-library-search', 'prompt-library-list', 'prompt-library-menu-status',
    'prompt-library-modal', 'prompt-library-close-button', 'prompt-manager-new-button', 'prompt-manager-count', 'prompt-editor',
    'prompt-editor-mode', 'prompt-editor-title', 'prompt-editor-cancel-button', 'prompt-editor-name', 'prompt-editor-description',
    'prompt-editor-content', 'prompt-editor-status', 'prompt-editor-save-button', 'prompt-manager-list',
    'conflict-resolution-modal', 'conflict-resolution-task-label', 'conflict-resolution-model-select', 'conflict-resolution-reasoning-select', 'conflict-resolution-instructions',
    'conflict-resolution-cancel-button', 'conflict-resolution-cancel-action', 'conflict-resolution-submit-button',
    'task-tree-select', 'new-tree-fields', 'tree-name',
    'task-target-card', 'task-target-select', 'task-target-new-fields', 'task-target-tree-name', 'task-target-create-button', 'task-target-status',
    'task-model-select', 'task-reasoning-select',
    'chatgpt-project-select', 'new-project-fields', 'new-project-name',
    'refresh-projects-button', 'project-list-status',
    'trees-project-select', 'trees-refresh-projects-button',
    'create-task-button', 'task-status-title', 'task-status-copy', 'status-badge',
    'submit-task-button', 'copy-prompt-button', 'reveal-package-button',
    'import-result-button', 'delete-task-button', 'result-card', 'result-summary', 'patch-list',
    'use-git-summary-button', 'apply-button', 'retry-apply-button', 'resolve-conflict-button', 'rollback-button', 'activity-list', 'toast', 'connection-pill',
    'task-chat-status', 'task-chat-thinking', 'task-chat-messages', 'task-chat-form',
    'task-chat-input', 'task-chat-refresh-button', 'task-chat-stop-button', 'task-chat-send-button',
    'session-chatgpt-surface', 'session-back-button', 'session-forward-button',
    'session-reload-button', 'session-new-chat-button', 'session-browser-title',
    'session-browser-status', 'session-status-dot',
    'source-control-button', 'source-count', 'source-repository-select',
    'source-add-repository', 'source-refresh', 'source-remove-repository',
    'source-branch', 'source-commit-message', 'source-commit-button', 'source-ai-summary-button', 'source-git-summary-prompt-button', 'source-git-summary-status',
    'staged-count', 'unstaged-count', 'staged-files', 'unstaged-files',
    'stage-all-button', 'unstage-all-button', 'commit-history',
    'diff-tabs', 'diff-title', 'diff-subtitle', 'diff-kind', 'diff-compare',
    'diff-before-label', 'diff-after-label', 'diff-rows', 'diff-before-rows', 'diff-after-rows',
    'diff-tab-context-menu',
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

function restoreTaskSelectSelection(select, storageKey) {
  try {
    const savedValue = localStorage.getItem(storageKey);
    if (savedValue !== null && [...select.options].some((option) => option.value === savedValue)) {
      select.value = savedValue;
    } else if (savedValue !== null) {
      localStorage.removeItem(storageKey);
    }
  } catch {
    // Local storage may be unavailable in restricted renderer contexts.
  }
}

function persistTaskSelectSelection(select, storageKey) {
  try {
    localStorage.setItem(storageKey, select.value);
  } catch {
    // Local storage may be unavailable in restricted renderer contexts.
  }
}

function restoreTaskModelSelection() {
  restoreTaskSelectSelection(elements['task-model-select'], TASK_MODEL_STORAGE_KEY);
}

function persistTaskModelSelection(event) {
  persistTaskSelectSelection(event.target, TASK_MODEL_STORAGE_KEY);
}

function restoreTaskReasoningSelection() {
  restoreTaskSelectSelection(elements['task-reasoning-select'], TASK_REASONING_STORAGE_KEY);
}

function persistTaskReasoningSelection(event) {
  persistTaskSelectSelection(event.target, TASK_REASONING_STORAGE_KEY);
}

function createPromptId() {
  return `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizePromptEntry(value) {
  const name = String(value?.name || '').trim().slice(0, 60);
  const description = String(value?.description || '').trim().slice(0, 140);
  const content = String(value?.content || '').replaceAll('\r\n', '\n').trim().slice(0, MAX_PROMPT_CONTENT_LENGTH);
  if (!name || !content) return null;
  return {
    id: String(value?.id || '').trim() || createPromptId(),
    name,
    description,
    content,
    createdAt: String(value?.createdAt || new Date().toISOString()),
    updatedAt: String(value?.updatedAt || value?.createdAt || new Date().toISOString()),
  };
}

function loadPromptLibrary() {
  try {
    const raw = localStorage.getItem(PROMPT_LIBRARY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const seenIds = new Set();
    state.promptLibrary = (Array.isArray(parsed) ? parsed : [])
      .map(normalizePromptEntry)
      .filter((prompt) => {
        if (!prompt || seenIds.has(prompt.id)) return false;
        seenIds.add(prompt.id);
        return true;
      })
      .slice(0, MAX_PROMPTS);
  } catch {
    state.promptLibrary = [];
  }
  state.selectedPromptIds = [];
  renderPromptLibrarySelection();
  renderPromptLibraryMenu();
}

function savePromptLibrary() {
  try {
    localStorage.setItem(PROMPT_LIBRARY_STORAGE_KEY, JSON.stringify(state.promptLibrary));
    return true;
  } catch {
    showToast('Prompt library could not be saved.', true);
    return false;
  }
}

function selectedPromptEntries() {
  const promptsById = new Map(state.promptLibrary.map((prompt) => [prompt.id, prompt]));
  return state.selectedPromptIds.map((id) => promptsById.get(id)).filter(Boolean);
}

function gitSummaryPrompt() {
  return state.promptLibrary.find((prompt) => prompt.name.trim().toLowerCase() === 'git summary')?.content?.trim() || null;
}

function renderGitSummaryPromptStatus() {
  const hasCustomPrompt = Boolean(gitSummaryPrompt());
  elements['source-git-summary-status'].textContent = hasCustomPrompt
    ? 'Using your saved “Git Summary” prompt.'
    : 'Using the built-in Git Summary prompt. Create a saved prompt named “Git Summary” to customize it.';
}

function openGitSummaryPromptEditor() {
  const prompt = state.promptLibrary.find((item) => item.name.trim().toLowerCase() === 'git summary') || null;
  openPromptManager();
  startPromptEditor(prompt?.id || null);
  if (!prompt) {
    elements['prompt-editor-name'].value = 'Git Summary';
    elements['prompt-editor-description'].value = 'Used when generating an AI Conventional Commit message from Source Control.';
    elements['prompt-editor-status'].textContent = 'Save a custom Git Summary prompt to replace the built-in instructions for Source Control.';
  }
}

function renderPromptLibrarySelection() {
  const selected = selectedPromptEntries();
  elements['prompt-library-trigger-label'].textContent = selected.length
    ? `${selected.length} saved prompt${selected.length === 1 ? '' : 's'} selected`
    : 'Add saved prompts';
  elements['prompt-library-trigger'].classList.toggle('selected', selected.length > 0);
  elements['prompt-library-trigger'].setAttribute('aria-expanded', !elements['prompt-library-menu'].classList.contains('hidden'));
  elements['prompt-library-menu-status'].textContent = selected.length
    ? `${selected.length} prompt${selected.length === 1 ? '' : 's'} will be added to this task.`
    : 'No prompts selected.';

  const summary = elements['prompt-selection-summary'];
  summary.classList.toggle('hidden', selected.length === 0);
  summary.innerHTML = selected.map((prompt) => `
    <span class="prompt-selection-chip">
      <span title="${escapeHtml(prompt.description || prompt.name)}">${escapeHtml(prompt.name)}</span>
      <button class="prompt-selection-remove" type="button" data-prompt-id="${escapeHtml(prompt.id)}" aria-label="Remove ${escapeHtml(prompt.name)}">×</button>
    </span>
  `).join('');
  summary.querySelectorAll('.prompt-selection-remove').forEach((button) => button.addEventListener('click', () => {
    state.selectedPromptIds = state.selectedPromptIds.filter((id) => id !== button.dataset.promptId);
    renderPromptLibrarySelection();
    renderPromptLibraryMenu();
  }));
}

function renderPromptLibraryMenu() {
  const container = elements['prompt-library-list'];
  const query = state.promptLibrarySearch.trim().toLowerCase();
  const prompts = state.promptLibrary.filter((prompt) => {
    if (!query) return true;
    return `${prompt.name} ${prompt.description} ${prompt.content}`.toLowerCase().includes(query);
  });

  if (state.promptLibrary.length === 0) {
    container.innerHTML = `
      <div class="prompt-library-empty">
        <span class="prompt-library-empty-icon" aria-hidden="true">✦</span>
        <strong>No saved prompts yet</strong>
        <span>Create a reusable instruction once, then add it to future tasks in one click.</span>
        <button id="prompt-library-empty-new-button" class="secondary" type="button">＋ Create prompt</button>
      </div>
    `;
    container.querySelector('#prompt-library-empty-new-button')?.addEventListener('click', () => {
      closePromptLibraryMenu();
      openPromptManager();
      startPromptEditor();
    });
    renderPromptLibrarySelection();
    return;
  }

  if (prompts.length === 0) {
    container.innerHTML = '<div class="prompt-library-empty compact"><strong>No prompts match that search.</strong><span>Try a different name or description.</span></div>';
  } else {
    const selectedIds = new Set(state.selectedPromptIds);
    container.innerHTML = prompts.map((prompt) => {
      const selected = selectedIds.has(prompt.id);
      return `
        <button class="prompt-library-option${selected ? ' selected' : ''}" type="button" data-prompt-id="${escapeHtml(prompt.id)}" aria-pressed="${selected}">
          <span class="prompt-option-check" aria-hidden="true">${selected ? '✓' : ''}</span>
          <span class="prompt-option-copy">
            <strong>${escapeHtml(prompt.name)}</strong>
            <small>${escapeHtml(prompt.description || 'No description')}</small>
          </span>
          <span class="prompt-option-chevron" aria-hidden="true">＋</span>
        </button>
      `;
    }).join('');
    container.querySelectorAll('.prompt-library-option').forEach((button) => button.addEventListener('click', () => {
      const promptId = button.dataset.promptId;
      state.selectedPromptIds = state.selectedPromptIds.includes(promptId)
        ? state.selectedPromptIds.filter((id) => id !== promptId)
        : [...state.selectedPromptIds, promptId];
      renderPromptLibrarySelection();
      renderPromptLibraryMenu();
    }));
  }

  renderPromptLibrarySelection();
}

function closePromptLibraryMenu() {
  elements['prompt-library-menu'].classList.add('hidden');
  elements['prompt-library-trigger'].setAttribute('aria-expanded', 'false');
}

function togglePromptLibraryMenu() {
  const menu = elements['prompt-library-menu'];
  const opening = menu.classList.contains('hidden');
  if (opening) {
    renderPromptLibraryMenu();
    menu.classList.remove('hidden');
    elements['prompt-library-trigger'].setAttribute('aria-expanded', 'true');
    return;
  }
  closePromptLibraryMenu();
}

function renderPromptManager() {
  const list = elements['prompt-manager-list'];
  const count = state.promptLibrary.length;
  elements['prompt-manager-count'].textContent = `${count} saved prompt${count === 1 ? '' : 's'}`;
  if (count === 0) {
    list.innerHTML = `
      <div class="prompt-manager-empty">
        <strong>Your prompt library is ready for its first reusable instruction.</strong>
        <span>Give it a name, add a short description, and write the exact instructions you want Patchwork to append to future tasks.</span>
        <button class="primary prompt-manager-empty-new" type="button">＋ New prompt</button>
      </div>
    `;
    list.querySelector('.prompt-manager-empty-new')?.addEventListener('click', () => startPromptEditor());
    return;
  }

  list.innerHTML = state.promptLibrary.map((prompt) => `
    <article class="prompt-manager-item">
      <div class="prompt-manager-item-heading">
        <div>
          <strong>${escapeHtml(prompt.name)}</strong>
          <small>${escapeHtml(prompt.description || 'No description')}</small>
        </div>
        ${state.selectedPromptIds.includes(prompt.id) ? '<span class="prompt-manager-selected">Selected</span>' : ''}
      </div>
      <p>${escapeHtml(prompt.content.replace(/\s+/g, ' ').trim())}</p>
      <div class="prompt-manager-actions">
        <button class="secondary prompt-edit-button" type="button" data-prompt-id="${escapeHtml(prompt.id)}">Edit</button>
        <button class="danger prompt-delete-button" type="button" data-prompt-id="${escapeHtml(prompt.id)}">Delete</button>
      </div>
    </article>
  `).join('');
  list.querySelectorAll('.prompt-edit-button').forEach((button) => button.addEventListener('click', () => startPromptEditor(button.dataset.promptId)));
  list.querySelectorAll('.prompt-delete-button').forEach((button) => button.addEventListener('click', () => deletePrompt(button.dataset.promptId)));
}

function openPromptManager() {
  closePromptLibraryMenu();
  elements['prompt-library-modal'].classList.remove('hidden');
  renderPromptManager();
}

function closePromptManager() {
  elements['prompt-library-modal'].classList.add('hidden');
  cancelPromptEditor();
}

function startPromptEditor(promptId = null) {
  const prompt = promptId ? state.promptLibrary.find((item) => item.id === promptId) : null;
  state.editingPromptId = prompt?.id || null;
  elements['prompt-editor-mode'].textContent = prompt ? 'EDIT PROMPT' : 'NEW PROMPT';
  elements['prompt-editor-title'].textContent = prompt ? 'Edit saved prompt' : 'Create a saved prompt';
  elements['prompt-editor-name'].value = prompt?.name || '';
  elements['prompt-editor-description'].value = prompt?.description || '';
  elements['prompt-editor-content'].value = prompt?.content || '';
  elements['prompt-editor-status'].textContent = 'This text will be appended to the task only when the prompt is selected.';
  elements['prompt-editor-status'].classList.remove('error');
  elements['prompt-editor'].classList.remove('hidden');
  requestAnimationFrame(() => elements['prompt-editor-name'].focus());
}

function cancelPromptEditor() {
  state.editingPromptId = null;
  elements['prompt-editor'].classList.add('hidden');
  elements['prompt-editor-name'].value = '';
  elements['prompt-editor-description'].value = '';
  elements['prompt-editor-content'].value = '';
  elements['prompt-editor-status'].classList.remove('error');
}

function savePromptFromEditor(event) {
  event.preventDefault();
  const name = elements['prompt-editor-name'].value.trim();
  const description = elements['prompt-editor-description'].value.trim();
  const content = elements['prompt-editor-content'].value.replaceAll('\r\n', '\n').trim();
  if (!name) {
    elements['prompt-editor-status'].textContent = 'Add a name so the prompt is easy to recognize in the dropdown.';
    elements['prompt-editor-status'].classList.add('error');
    elements['prompt-editor-name'].focus();
    return;
  }
  if (!content) {
    elements['prompt-editor-status'].textContent = 'Add the instructions that should be appended when this prompt is selected.';
    elements['prompt-editor-status'].classList.add('error');
    elements['prompt-editor-content'].focus();
    return;
  }
  const duplicate = state.promptLibrary.find((prompt) => (
    prompt.id !== state.editingPromptId && prompt.name.toLowerCase() === name.toLowerCase()
  ));
  if (duplicate) {
    elements['prompt-editor-status'].textContent = 'A saved prompt with this name already exists.';
    elements['prompt-editor-status'].classList.add('error');
    elements['prompt-editor-name'].focus();
    return;
  }

  const now = new Date().toISOString();
  const previous = state.promptLibrary;
  const nextPrompt = normalizePromptEntry({
    id: state.editingPromptId || createPromptId(),
    name,
    description,
    content,
    createdAt: state.promptLibrary.find((prompt) => prompt.id === state.editingPromptId)?.createdAt || now,
    updatedAt: now,
  });
  state.promptLibrary = state.editingPromptId
    ? state.promptLibrary.map((prompt) => prompt.id === state.editingPromptId ? nextPrompt : prompt)
    : [nextPrompt, ...state.promptLibrary];
  if (state.promptLibrary.length > MAX_PROMPTS) state.promptLibrary = state.promptLibrary.slice(0, MAX_PROMPTS);
  if (!savePromptLibrary()) {
    state.promptLibrary = previous;
    return;
  }

  state.editingPromptId = null;
  elements['prompt-editor'].classList.add('hidden');
  elements['prompt-editor-status'].classList.remove('error');
  renderPromptManager();
  renderPromptLibraryMenu();
  renderGitSummaryPromptStatus();
  showToast(`${name} ${previous.some((prompt) => prompt.id === nextPrompt.id) ? 'updated' : 'saved'}.`);
}

function deletePrompt(promptId) {
  const prompt = state.promptLibrary.find((item) => item.id === promptId);
  if (!prompt) return;
  if (!window.confirm(`Delete the saved prompt “${prompt.name}”?`)) return;
  const previous = state.promptLibrary;
  const previousSelectedIds = state.selectedPromptIds;
  state.promptLibrary = state.promptLibrary.filter((item) => item.id !== promptId);
  state.selectedPromptIds = state.selectedPromptIds.filter((id) => id !== promptId);
  if (!savePromptLibrary()) {
    state.promptLibrary = previous;
    state.selectedPromptIds = previousSelectedIds;
    return;
  }
  if (state.editingPromptId === promptId) cancelPromptEditor();
  renderPromptManager();
  renderPromptLibrarySelection();
  renderPromptLibraryMenu();
  renderGitSummaryPromptStatus();
  showToast(`${prompt.name} deleted.`);
}

function buildTaskTextWithPrompts(baseTaskText) {
  const selected = selectedPromptEntries();
  if (selected.length === 0) return baseTaskText;
  const additions = selected.map((prompt) => `### ${prompt.name}\n${prompt.content.trim()}`).filter(Boolean).join('\n\n');
  return `${baseTaskText}\n\nAdditional instructions from the prompt library:\n\n${additions}`;
}

function persistTaskTreeSelectionValue(value) {
  try {
    localStorage.setItem(TASK_TREE_STORAGE_KEY, value);
  } catch {
    // Local storage may be unavailable in restricted renderer contexts.
  }
}

function restoreTaskTreeSelection() {
  const select = elements['task-tree-select'];
  try {
    const savedTree = localStorage.getItem(TASK_TREE_STORAGE_KEY);
    if (savedTree !== null && [...select.options].some((option) => option.value === savedTree)) {
      select.value = savedTree;
    } else if (savedTree && savedTree !== TASK_NEW_TREE_VALUE) {
      localStorage.removeItem(TASK_TREE_STORAGE_KEY);
    }
  } catch {
    // Local storage may be unavailable in restricted renderer contexts.
  }
  renderTaskTreeOptions();
}

function persistTaskTreeSelection(event) {
  persistTaskTreeSelectionValue(event.target.value);
}

function restoreTaskProjectSelection() {
  if (state.projectSelection !== undefined) return;
  try {
    state.projectSelection = localStorage.getItem(TASK_PROJECT_STORAGE_KEY) || '';
  } catch {
    state.projectSelection = '';
  }
}

function persistTaskProjectSelectionValue(value) {
  const next = value === '__new__' ? '' : String(value || '');
  state.projectSelection = next;
  try {
    localStorage.setItem(TASK_PROJECT_STORAGE_KEY, next);
  } catch {
    // Local storage may be unavailable in restricted renderer contexts.
  }
}

function persistTaskProjectSelection(event) {
  persistTaskProjectSelectionValue(event.target.value);
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
      resetTaskSkills();
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

function resetTaskSkills() {
  state.skillCatalog = [];
  state.selectedSkillIds = [];
  elements['skills-search'].value = '';
  renderSkillSelection();
}

function taskSkillRepositoryPaths() {
  const selectedTarget = elements['task-tree-select'].value;
  if (selectedTarget && selectedTarget !== TASK_NEW_TREE_VALUE) {
    const tree = state.trees.find((item) => item.id === selectedTarget);
    if (tree?.path) return [tree.path];
  }
  return state.repositories.map((repository) => repository.path).filter(Boolean);
}

function selectedSkills() {
  const selected = new Set(state.selectedSkillIds);
  return state.skillCatalog.filter((skill) => selected.has(skill.id));
}

function renderSkillSelection() {
  const skills = selectedSkills();
  elements['skill-selection-label'].textContent = skills.length
    ? `${skills.length} skill${skills.length === 1 ? '' : 's'} selected`
    : 'Choose skills';
  if (skills.length === 0) {
    elements['skill-selection-summary'].classList.add('hidden');
    elements['skill-selection-summary'].innerHTML = '';
  } else {
    const visibleSkills = skills.slice(0, 3);
    const moreCount = skills.length - visibleSkills.length;
    elements['skill-selection-summary'].classList.remove('hidden');
    elements['skill-selection-summary'].innerHTML = visibleSkills
      .map((skill) => `<span class="skill-selection-chip">${escapeHtml(skill.name)}</span>`)
      .join('') + (moreCount > 0 ? `<span class="skill-selection-chip more">+${moreCount} more</span>` : '');
  }
  elements['skills-selection-status'].textContent = skills.length
    ? `${skills.length} selected · ${state.skillCatalog.length} found`
    : state.skillCatalog.length
      ? `${state.skillCatalog.length} skill${state.skillCatalog.length === 1 ? '' : 's'} found`
      : 'No skills selected.';
}

function renderSkillDrawerList() {
  const search = elements['skills-search'].value.trim().toLowerCase();
  const visibleSkills = state.skillCatalog.filter((skill) => [
    skill.name,
    skill.description,
    skill.provider,
    skill.scope,
    skill.location,
  ].filter(Boolean).join(' ').toLowerCase().includes(search));
  if (visibleSkills.length === 0) {
    elements['skills-list'].innerHTML = state.skillCatalog.length
      ? '<div class="skill-list-empty"><strong>No matching skills</strong><span>Try a different search term.</span></div>'
      : '<div class="skill-list-empty"><strong>No skills found</strong><span>No skills are currently available for this task.</span></div>';
    renderSkillSelection();
    return;
  }
  let lastScope = null;
  const markup = [];
  for (const skill of visibleSkills) {
    if (skill.scope !== lastScope) {
      const label = skill.scope === 'project' ? 'Project skills' : 'User skills';
      markup.push(`<div class="skill-group-label">${escapeHtml(label)}</div>`);
      lastScope = skill.scope;
    }
    const checked = state.selectedSkillIds.includes(skill.id);
    markup.push(`<label class="skill-option">
      <input type="checkbox" data-skill-id="${escapeHtml(skill.id)}" ${checked ? 'checked' : ''} />
      <span class="skill-check" aria-hidden="true"></span>
      <span class="skill-option-copy">
        <span class="skill-option-heading"><strong>${escapeHtml(skill.name)}</strong><small>${escapeHtml(skill.provider)}</small></span>
        ${skill.description ? `<span class="skill-option-description">${escapeHtml(skill.description)}</span>` : ''}
        <span class="skill-option-location">${escapeHtml(skill.location)}</span>
      </span>
    </label>`);
  }
  elements['skills-list'].innerHTML = markup.join('');
  elements['skills-list'].querySelectorAll('[data-skill-id]').forEach((input) => input.addEventListener('change', () => {
    const id = input.dataset.skillId;
    if (input.checked) {
      if (!state.selectedSkillIds.includes(id)) state.selectedSkillIds.push(id);
    } else {
      state.selectedSkillIds = state.selectedSkillIds.filter((item) => item !== id);
    }
    renderSkillSelection();
  }));
  renderSkillSelection();
}

async function refreshSkillCatalog(showErrors = true) {
  elements['skills-refresh-button'].disabled = true;
  const previous = [...state.selectedSkillIds];
  elements['skills-list'].innerHTML = '<div class="skill-list-empty"><strong>Scanning for skills…</strong><span>Checking available skills.</span></div>';
  try {
    state.skillCatalog = await window.patchwork.listSkills(taskSkillRepositoryPaths());
    const available = new Set(state.skillCatalog.map((skill) => skill.id));
    state.selectedSkillIds = previous.filter((id) => available.has(id));
    renderSkillDrawerList();
  } catch (error) {
    elements['skills-list'].innerHTML = `<div class="skill-list-empty"><strong>Could not load skills</strong><span>${escapeHtml(error.message)}</span></div>`;
    if (showErrors) showToast(error.message, true);
  } finally {
    elements['skills-refresh-button'].disabled = false;
  }
}

async function openSkillDrawer() {
  elements['skills-modal'].classList.remove('hidden');
  renderSkillSelection();
  await refreshSkillCatalog(true);
  requestAnimationFrame(() => elements['skills-search'].focus());
}

function closeSkillDrawer() {
  elements['skills-modal'].classList.add('hidden');
}

function openConflictResolutionModal(task) {
  if (!task?.taskId) return;
  state.conflictResolutionTaskId = task.taskId;
  elements['conflict-resolution-task-label'].textContent = taskLabel(task);
  elements['conflict-resolution-model-select'].value = ['default', 'sol', 'luna'].includes(task.model)
    ? task.model
    : 'default';
  elements['conflict-resolution-reasoning-select'].value = ['default', 'instant', 'low', 'medium', 'high', 'extra-high'].includes(task.reasoningMode)
    ? task.reasoningMode
    : 'default';
  elements['conflict-resolution-instructions'].value = '';
  window.patchwork.setBrowserVisible(false);
  elements['conflict-resolution-modal'].classList.remove('hidden');
  requestAnimationFrame(() => elements['conflict-resolution-instructions'].focus());
}

function closeConflictResolutionModal() {
  state.conflictResolutionTaskId = null;
  elements['conflict-resolution-modal'].classList.add('hidden');
  elements['conflict-resolution-instructions'].value = '';
  elements['conflict-resolution-submit-button'].disabled = false;
  if (!elements['task-view'].classList.contains('hidden')) {
    window.patchwork.setBrowserVisible(false);
  }
}

async function submitConflictResolution() {
  const taskId = state.conflictResolutionTaskId;
  if (!taskId) return;
  const button = elements['conflict-resolution-submit-button'];
  button.disabled = true;
  try {
    const task = await window.patchwork.resolveTaskConflict(taskId, {
      model: elements['conflict-resolution-model-select'].value,
      reasoningMode: elements['conflict-resolution-reasoning-select'].value,
      additionalInstructions: elements['conflict-resolution-instructions'].value.trim(),
    });
    if (!task) return;
    upsertTask(task);
    closeConflictResolutionModal();
    await refreshTrees();
    showTask(task);
    showToast('Conflict-resolution task submitted to ChatGPT.');
  } catch (error) {
    // A ChatGPT error is actionable only when the embedded browser is visible.
    // Close the dialog first so the user can inspect and recover from it.
    closeConflictResolutionModal();
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderChatGPTProjects() {
  const select = elements['chatgpt-project-select'];
  const previous = select.value;
  select.innerHTML = '<option value="">New chat (no project)</option>'
    + state.chatgptProjects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join('')
    + '<option value="__new__">Create a new ChatGPT project…</option>';
  const desired = previous === '__new__' ? previous : (state.projectSelection ?? previous ?? '');
  if ([...select.options].some((option) => option.value === desired)) select.value = desired;
  const creating = select.value === '__new__';
  elements['new-project-fields'].classList.toggle('hidden', !creating);
  elements['new-project-name'].disabled = !creating;
}

function renderTreesProjectSelection() {
  const select = elements['trees-project-select'];
  if (!select) return;
  const previous = select.value;
  select.innerHTML = '<option value="">No ChatGPT project</option>'
    + state.chatgptProjects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join('');
  const desired = state.projectSelection ?? previous ?? '';
  if ([...select.options].some((option) => option.value === desired)) select.value = desired;
  else select.value = '';
}

async function refreshChatGPTProjects(showErrors = false) {
  elements['refresh-projects-button'].disabled = true;
  elements['trees-refresh-projects-button'].disabled = true;
  elements['project-list-status'].classList.remove('error');
  elements['project-list-status'].textContent = 'Loading ChatGPT projects through the existing browser session…';
  try {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(
        'Project loading timed out before the main process returned a result.',
      )), PROJECT_REFRESH_TIMEOUT_MILLISECONDS);
    });
    try {
      state.chatgptProjects = await Promise.race([
        window.patchwork.listChatGPTProjects(),
        timeout,
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
    restoreTaskProjectSelection();
    renderChatGPTProjects();
    renderTreesProjectSelection();
    elements['project-list-status'].textContent = state.chatgptProjects.length
      ? `${state.chatgptProjects.length} ChatGPT project${state.chatgptProjects.length === 1 ? '' : 's'} available · no page refresh used.`
      : 'No ChatGPT projects found. No page refresh was used; you can create one below.';
  } catch (error) {
    state.chatgptProjects = [];
    renderChatGPTProjects();
    renderTreesProjectSelection();
    elements['project-list-status'].classList.add('error');
    elements['project-list-status'].textContent = error.message;
    if (showErrors) showToast(error.message, true);
  } finally {
    elements['refresh-projects-button'].disabled = false;
    elements['trees-refresh-projects-button'].disabled = false;
  }
}

function renderTaskTreeOptions() {
  const select = elements['task-tree-select'];
  const previous = select.value;
  select.innerHTML = '<option value="">Use current working changes</option><option value="__new__">Create a new coding tree</option>' + state.trees
    .filter((tree) => tree.available && tree.mergeState !== 'submitted')
    .map((tree) => `<option value="${escapeHtml(tree.id)}">${escapeHtml(tree.name)} · ${escapeHtml(tree.repositoryName)}${tree.managed === false ? ' · Git worktree' : ''}</option>`)
    .join('');
  if ([...select.options].some((option) => option.value === previous)) {
    select.value = previous;
  } else {
    select.value = '';
  }
  const creating = select.value === TASK_NEW_TREE_VALUE;
  const existing = Boolean(select.value) && !creating;
  elements['new-tree-fields'].classList.toggle('hidden', !creating);
  elements['tree-name'].disabled = !creating;
  if (existing) persistTaskTreeSelectionValue(select.value);
  renderRepositories();
}

function canChangeTaskTarget(task) {
  return Boolean(task)
    && !task.summaryOnly
    && ['prepared', 'submitted', 'ready', 'failed', 'conflicted'].includes(task.state)
    && (task.repositories || []).filter((repository) => !repository.readOnly).length === 1;
}

function renderTaskTargetOptions(task) {
  const card = elements['task-target-card'];
  if (!card) return;
  if (!canChangeTaskTarget(task)) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');

  const select = elements['task-target-select'];
  const sourcePath = task.sourceRepositoryPath || task.repositories?.find((repository) => !repository.readOnly)?.path || '';
  const availableTrees = state.trees
    .filter((tree) => tree.available && tree.mergeState !== 'submitted')
    .filter((tree) => !sourcePath || tree.repositoryPath === sourcePath);
  const currentTree = task.treeId ? state.trees.find((tree) => tree.id === task.treeId) : null;
  const currentValue = currentTree?.available ? task.treeId : '';
  const missingTreeOption = task.treeId && !currentTree?.available
    ? `<option value="" disabled>Missing worktree: ${escapeHtml(task.treeName || task.treeId)}</option>`
    : '';
  select.innerHTML = '<option value="">Use original repository</option>'
    + missingTreeOption
    + '<option value="__new__">Create a new coding tree</option>'
    + availableTrees.map((tree) => `<option value="${escapeHtml(tree.id)}">${escapeHtml(tree.name)} · ${escapeHtml(tree.repositoryName)}${tree.managed === false ? ' · Git worktree' : ''}</option>`).join('');
  select.value = [...select.options].some((option) => option.value === currentValue) ? currentValue : '';
  const creating = select.value === TASK_NEW_TREE_VALUE;
  elements['task-target-new-fields'].classList.toggle('hidden', !creating);
  elements['task-target-tree-name'].disabled = !creating;

  if (task.treeId && !currentTree?.available) {
    elements['task-target-status'].textContent = 'The previous worktree is unavailable. Choose a new one or use the original repository.';
  } else if (task.treeName) {
    elements['task-target-status'].textContent = `Changes will apply in ${task.treeName}. You can change this target until the task is applied.`;
  } else {
    elements['task-target-status'].textContent = 'Changes will apply to the original repository. You can change this target until the task is applied.';
  }
}

async function changeActiveTaskTarget(treeId) {
  const task = state.activeTask;
  if (!task || !canChangeTaskTarget(task)) return;
  const select = elements['task-target-select'];
  select.disabled = true;
  try {
    const updated = await window.patchwork.setTaskTarget(task.taskId, { treeId: treeId || null });
    upsertTask(updated);
    await refreshTrees();
    showTask(updated);
    showToast(updated.treeId ? `Task target changed to ${updated.treeName}.` : 'Task target changed to the original repository.');
  } catch (error) {
    renderTaskTargetOptions(task);
    showToast(error.message, true);
  } finally {
    select.disabled = false;
  }
}

async function createActiveTaskTargetTree() {
  const task = state.activeTask;
  if (!task || !canChangeTaskTarget(task)) return;
  const name = elements['task-target-tree-name'].value.trim();
  if (!name) {
    showToast('Enter a name for the new coding tree.', true);
    return;
  }
  const button = elements['task-target-create-button'];
  button.disabled = true;
  try {
    const updated = await window.patchwork.setTaskTarget(task.taskId, { createTree: true, treeName: name });
    upsertTask(updated);
    elements['task-target-tree-name'].value = '';
    await refreshTrees();
    showTask(updated);
    showToast(`Task target changed to ${updated.treeName}.`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderTrees() {
  elements['tree-count'].textContent = String(state.trees.length);
  elements['tree-count'].classList.toggle('hidden', state.trees.length === 0);
  const container = elements['trees-list'];
  if (state.trees.length === 0) {
    container.className = 'trees-list empty-state';
    container.innerHTML = '<div class="empty-icon">⑃</div><strong>No coding trees yet</strong><span>Start a task to create an isolated workstream.</span>';
    renderTaskTreeOptions();
    renderTaskTargetOptions(state.activeTask);
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
    <div class="tree-project"><span>Project</span><strong>${escapeHtml(tree.chatgptProject?.name || 'No ChatGPT project')}</strong></div>
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
    persistTaskTreeSelectionValue(button.dataset.treeId);
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
      const projectId = elements['trees-project-select'].value;
      const chatgptProject = projectId
        ? state.chatgptProjects.find((project) => project.id === projectId) || null
        : null;
      await window.patchwork.mergeTree(button.dataset.treeId, chatgptProject);
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
  renderTaskTargetOptions(state.activeTask);
}

async function refreshTrees() {
  state.trees = await window.patchwork.listTrees();
  renderTrees();
}

function taskLabel(task) {
  if (task.summaryOnly) {
    const repositoryName = task.repositories?.[0]?.name;
    return repositoryName ? `Git Summary · ${repositoryName}` : 'Git Summary';
  }
  return String(task.conversationTitle || task.taskText || 'Untitled task').split('\n')[0].trim() || 'Untitled task';
}

function syncTaskTitleOverflow(root = document) {
  root.querySelectorAll('.task-title-viewport').forEach((viewport) => {
    const title = viewport.querySelector('.task-title-scroll');
    if (!title) return;
    title.classList.remove('is-overflowing');
    title.style.removeProperty('--task-title-shift');
    const overflow = Math.max(0, title.scrollWidth - viewport.clientWidth);
    if (overflow > 2) {
      title.style.setProperty('--task-title-shift', `${-overflow}px`);
      title.classList.add('is-overflowing');
    }
  });
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
    const endedAt = element.dataset.endedAt ? new Date(element.dataset.endedAt).getTime() : Date.now();
    element.textContent = formatElapsed(element.dataset.startedAt, endedAt);
  });
}

function taskStateLabel(task) {
  if (task.summaryOnly) {
    if (task.state === 'completed') return 'Summary applied';
    if (task.state === 'ready') return 'Summary ready';
    if (task.state === 'submitted' && task.chatStatus === 'completed') return 'ChatGPT finished';
    if (task.state === 'submitted' && task.chatStatus === 'failed') return 'ChatGPT stopped';
    if (task.state === 'submitted') return 'Generating summary';
    if (task.state === 'prepared') return 'Preparing summary';
  }
  if (task.state === 'submitted' && task.chatStatus === 'completed') return 'ChatGPT finished';
  if (task.state === 'submitted' && task.chatStatus === 'failed') return 'ChatGPT stopped';
  const labels = {
    prepared: 'Prepared',
    submitted: 'Running',
    ready: 'Waiting to apply',
    completed: 'Completed',
    applied: 'Applied',
    'rolled-back': 'Rolled back',
    conflicted: 'Needs conflict resolution',
    resolved: 'Resolved',
    failed: 'Needs attention',
  };
  return labels[task.state] || task.state;
}

function taskElapsedMarkup(task) {
  if (task.state !== 'submitted' || !task.submittedAt) return '';
  const endedAt = task.chatFinishedAt || '';
  return `<time class="task-elapsed" data-started-at="${escapeHtml(task.submittedAt)}"${endedAt ? ` data-ended-at="${escapeHtml(endedAt)}"` : ''}>${escapeHtml(formatElapsed(task.submittedAt, endedAt ? new Date(endedAt).getTime() : Date.now()))}</time>`;
}

function renderTaskList() {
  const recentTasks = state.tasks.slice(0, 5);
  elements['task-history-count'].textContent = String(state.tasks.length);
  elements['task-history-count'].classList.toggle('hidden', state.tasks.length === 0);
  elements['task-list'].innerHTML = recentTasks.length
    ? recentTasks.map((task) => `
      <button class="task-nav-item ${state.activeTask?.taskId === task.taskId ? 'active' : ''}" data-task-id="${escapeHtml(task.taskId)}">
        <span class="task-name-row">
          <span class="task-title-viewport"><strong class="task-title-scroll">${escapeHtml(taskLabel(task))}</strong></span>
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
  requestAnimationFrame(() => syncTaskTitleOverflow(elements['task-list']));
}

function taskHistorySearchText(task) {
  return [
    task.taskText,
    task.conversationTitle,
    task.treeName,
    task.model,
    task.reasoningMode,
    ...(task.skills || []).flatMap((skill) => [skill.name, skill.provider, skill.location, skill.description]),
    task.state,
    task.chatStatus,
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
    const context = task.treeName || repositoryNames.join(', ') || 'Current working changes';
    const configuration = taskConfigurationLabel(task);
    const detail = task.result?.summary || task.error || 'No result summary recorded.';
    const commitMessage = task.result?.commitMessage?.split('\n')[0] || '';
    return `<article class="task-history-card">
      <div class="task-history-heading">
        <div>
          <div class="task-title-viewport"><strong class="task-title-scroll">${escapeHtml(taskLabel(task))}</strong></div>
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
        <button class="danger history-delete-task" data-task-id="${escapeHtml(task.taskId)}">Delete</button>
      </div>
    </article>`;
  }).join('');

  requestAnimationFrame(() => syncTaskTitleOverflow(elements['task-history-list']));

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
  elements['task-history-list'].querySelectorAll('.history-delete-task').forEach((button) => {
    button.addEventListener('click', () => deleteTask(button.dataset.taskId));
  });
}

async function deleteTask(taskId) {
  try {
    const deleted = await window.patchwork.deleteTask(taskId);
    if (!deleted) return;
    state.tasks = state.tasks.filter((task) => task.taskId !== taskId);
    if (state.activeTask?.taskId === taskId) {
      state.activeTask = null;
      showTaskHistory();
    } else {
      renderTaskList();
      renderTaskHistory();
    }
    showToast('Task removed from history.');
  } catch (error) {
    showToast(error.message, true);
  }
}

const statusText = {
  prepared: ['Package prepared', 'Attach the package in ChatGPT and send the copied instructions.'],
  submitted: ['Task is running', 'ChatGPT is working in the hidden persistent browser. Patchwork mirrors the conversation here and checks background tasks periodically.'],
  ready: ['Waiting to apply', 'The plain-text result is validated and waiting for you to apply it.'],
  conflicted: ['Conflict needs resolution', 'Clean up the task target and retry the apply, or send a resolution task to ChatGPT to preserve both versions.'],
  resolved: ['Conflict resolved', 'The original task conflict was resolved by a follow-up task.'],
  applied: ['Changes applied', 'The validated patch has been applied to the task target.'],
  'rolled-back': ['Changes reverted', 'The changes from this task were reverted.'],
  failed: ['Task needs attention', 'Patchwork stopped before making unsafe or conflicting changes.'],
};

function taskStatusText(task) {
  if (task.summaryOnly) {
    if (task.state === 'completed') {
      return ['Git Summary applied', 'The generated Conventional Commit message was moved to the Source Control commit editor.'];
    }
    if (task.state === 'ready') {
      return ['Git Summary ready', 'Review the message below, then use it in Source Control to complete this task.'];
    }
    if (task.state === 'submitted' && task.chatStatus === 'completed') {
      return ['ChatGPT finished', 'ChatGPT finished generating the summary. Patchwork is locating and downloading the result file.'];
    }
    if (task.state === 'submitted' && task.chatStatus === 'failed') {
      return ['Git Summary stopped', 'ChatGPT reported a generation failure for this summary.'];
    }
    if (task.state === 'submitted') {
      return ['Generating Git Summary', 'Luna is reviewing the packaged working changes. Patchwork is monitoring the conversation and result file.'];
    }
    if (task.state === 'prepared') {
      return ['Preparing Git Summary', 'Patchwork is packaging the current working changes and preparing the ChatGPT request.'];
    }
  }
  if (task.state === 'submitted' && task.chatStatus === 'completed') {
    return ['ChatGPT finished', 'ChatGPT finished generating this task. Patchwork is checking for the result file.'];
  }
  if (task.state === 'submitted' && task.chatStatus === 'failed') {
    return ['ChatGPT stopped', 'ChatGPT reported a generation failure for this task.'];
  }
  return statusText[task.state] || statusText.prepared;
}

function taskConfigurationLabel(task) {
  const models = {
    default: 'ChatGPT default',
    sol: 'GPT-5.6 Sol',
    luna: 'GPT-5.6 Luna',
  };
  const reasoning = {
    default: 'default reasoning',
    instant: 'Instant',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    'extra-high': 'Extra High',
  };
  const skillCount = Array.isArray(task.skills) ? task.skills.length : 0;
  const skills = skillCount ? ` · ${skillCount} skill${skillCount === 1 ? '' : 's'}` : '';
  return `${models[task.model || 'default'] || task.model} · ${reasoning[task.reasoningMode || 'default'] || task.reasoningMode}${skills}`;
}

function renderResult(task) {
  const hasResult = Boolean(task.result);
  elements['result-card'].classList.toggle('hidden', !hasResult);
  elements['use-git-summary-button'].classList.toggle('hidden', !task.summaryOnly || task.state !== 'ready');
  elements['apply-button'].classList.toggle('hidden', task.summaryOnly || task.state !== 'ready');
  elements['retry-apply-button'].classList.toggle('hidden', task.state !== 'conflicted');
  elements['resolve-conflict-button'].classList.toggle('hidden', task.state !== 'conflicted');
  elements['rollback-button'].classList.toggle('hidden', task.state !== 'applied');
  if (!hasResult) return;
  elements['result-summary'].textContent = task.result.summary || 'ChatGPT returned a validated result.';
  elements['patch-list'].innerHTML = task.result.patches.map((patch) => `
    <div class="patch-item">
      <strong>${escapeHtml(patch.name || patch.id)}</strong>
      <pre>${escapeHtml(patch.stat || 'No changes')}</pre>
    </div>`).join('') + (task.result.commitMessage ? `<div class="patch-item"><strong>Commit</strong><pre>${escapeHtml(task.result.commitMessage)}${task.result.commits?.[0]?.commit ? `\n${escapeHtml(shortCommit(task.result.commits[0].commit))}` : ''}</pre></div>` : '');
}

function taskHasChat(task) {
  return Boolean(task?.conversationId || task?.conversationUrl);
}

function renderTaskChat(task = state.activeTask) {
  if (!task) return;
  const hasChat = taskHasChat(task);
  const snapshot = state.chatTaskId === task.taskId ? state.chatSnapshot : null;
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const runStatus = snapshot?.run?.status || task.chatStatus || 'unknown';
  const streaming = runStatus === 'streaming';

  elements['task-chat-refresh-button'].disabled = !hasChat || state.chatLoading || state.chatSending;
  elements['task-chat-input'].disabled = !hasChat || state.chatSending || streaming;
  elements['task-chat-send-button'].disabled = !hasChat || state.chatSending || streaming;
  elements['task-chat-stop-button'].classList.toggle('hidden', !hasChat || !streaming);
  elements['task-chat-stop-button'].disabled = state.chatSending;

  if (!hasChat) {
    elements['task-chat-status'].textContent = 'Submit this task to start a ChatGPT conversation.';
  } else if (state.chatLoading) {
    elements['task-chat-status'].textContent = 'Reading the hidden ChatGPT session…';
  } else if (state.chatSending) {
    elements['task-chat-status'].textContent = 'Sending through the hidden ChatGPT session…';
  } else if (state.chatError) {
    elements['task-chat-status'].textContent = state.chatError;
  } else if (streaming) {
    elements['task-chat-status'].textContent = 'ChatGPT is responding. Patchwork refreshes background tasks about every 15 seconds.';
  } else if (runStatus === 'failed') {
    elements['task-chat-status'].textContent = 'ChatGPT reported an error for this conversation.';
  } else if (runStatus === 'stopped') {
    elements['task-chat-status'].textContent = 'Generation was stopped. You can send another message.';
  } else {
    elements['task-chat-status'].textContent = 'Conversation mirrored from the same persistent ChatGPT browser session.';
  }

  const thinking = String(snapshot?.thinkingSummary || '').trim();
  elements['task-chat-thinking'].classList.toggle('hidden', !thinking);
  elements['task-chat-thinking'].textContent = thinking ? `Reasoning summary: ${thinking}` : '';

  if (messages.length === 0) {
    elements['task-chat-messages'].innerHTML = `<div class="task-chat-empty">
      <strong>${hasChat ? (state.chatLoading ? 'Loading conversation…' : 'No messages found') : 'No conversation yet'}</strong>
      <span>${hasChat ? 'Refresh to read the current browser transcript.' : 'After submission, Patchwork reads the hidden browser and renders the conversation here.'}</span>
    </div>`;
    return;
  }

  elements['task-chat-messages'].innerHTML = messages.map((message) => {
    const role = ['user', 'assistant', 'system'].includes(message.role) ? message.role : 'assistant';
    const label = role === 'user' ? 'You' : role === 'system' ? 'System' : 'ChatGPT';
    return `<article class="task-chat-message ${role}" data-message-id="${escapeHtml(message.id || '')}">
      <div class="task-chat-message-label">${label}</div>
      <pre>${escapeHtml(message.text || '')}</pre>
    </article>`;
  }).join('');
  requestAnimationFrame(() => {
    elements['task-chat-messages'].scrollTop = elements['task-chat-messages'].scrollHeight;
  });
}

async function refreshTaskChat(taskId = state.activeTask?.taskId) {
  if (!taskId || state.chatLoading) return;
  const task = state.tasks.find((item) => item.taskId === taskId) || state.activeTask;
  if (!task || !taskHasChat(task)) {
    if (state.activeTask?.taskId === taskId) {
      state.chatTaskId = taskId;
      state.chatSnapshot = null;
      renderTaskChat(task);
    }
    return;
  }
  state.chatLoading = true;
  state.chatError = null;
  if (state.activeTask?.taskId === taskId) renderTaskChat(task);
  try {
    const result = await window.patchwork.getTaskChat(taskId);
    if (result?.task) upsertTask(result.task);
    if (state.activeTask?.taskId !== taskId) return;
    state.activeTask = result.task || state.activeTask;
    state.chatTaskId = taskId;
    state.chatSnapshot = result.snapshot || null;
    state.chatError = null;
    renderTaskChat(state.activeTask);
  } catch (error) {
    if (state.activeTask?.taskId === taskId) state.chatError = error.message;
  } finally {
    state.chatLoading = false;
    if (state.activeTask?.taskId === taskId) renderTaskChat(state.activeTask);
  }
}

async function sendTaskChatMessage(event) {
  event.preventDefault();
  const task = state.activeTask;
  const text = elements['task-chat-input'].value.trim();
  if (!task || !taskHasChat(task) || !text || state.chatSending) return;
  state.chatSending = true;
  state.chatError = null;
  renderTaskChat(task);
  try {
    const result = await window.patchwork.sendTaskChatMessage(task.taskId, text);
    elements['task-chat-input'].value = '';
    if (result?.task) upsertTask(result.task);
    if (state.activeTask?.taskId === task.taskId) {
      state.activeTask = result.task || state.activeTask;
      state.chatTaskId = task.taskId;
      state.chatSnapshot = result.snapshot || null;
      state.chatError = null;
    }
  } catch (error) {
    state.chatError = error.message;
    showToast(error.message, true);
  } finally {
    state.chatSending = false;
    if (state.activeTask?.taskId === task.taskId) renderTaskChat(state.activeTask);
  }
}

async function stopTaskChat() {
  const task = state.activeTask;
  if (!task || !taskHasChat(task) || state.chatSending) return;
  state.chatSending = true;
  state.chatError = null;
  renderTaskChat(task);
  try {
    const result = await window.patchwork.stopTaskChat(task.taskId);
    if (result?.task) upsertTask(result.task);
    if (state.activeTask?.taskId === task.taskId) {
      state.activeTask = result.task || state.activeTask;
      state.chatTaskId = task.taskId;
      state.chatSnapshot = result.snapshot || null;
      state.chatError = null;
    }
  } catch (error) {
    state.chatError = error.message;
    showToast(error.message, true);
  } finally {
    state.chatSending = false;
    if (state.activeTask?.taskId === task.taskId) renderTaskChat(state.activeTask);
  }
}

function showTask(task) {
  closeConflictResolutionModal();
  const changedTask = state.chatTaskId !== task.taskId;
  state.activeTask = task;
  if (changedTask) {
    state.chatTaskId = task.taskId;
    state.chatSnapshot = null;
    state.chatError = null;
  }
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
  const [title, copy] = taskStatusText(task);
  elements['task-status-title'].textContent = title;
  elements['task-status-copy'].textContent = task.error || copy;
  elements['status-badge'].textContent = taskStateLabel(task);
  elements['status-badge'].className = `status-badge ${task.state}`;
  elements['submit-task-button'].classList.toggle('hidden', Boolean(task.summaryOnly));
  elements['copy-prompt-button'].classList.toggle('hidden', Boolean(task.summaryOnly));
  elements['import-result-button'].classList.toggle('hidden', Boolean(task.summaryOnly));
  addActivity(`Task ${task.state}`, task.updatedAt || task.createdAt);
  addActivity(`${task.repositories.length} repository snapshot${task.repositories.length === 1 ? '' : 's'} prepared`, task.createdAt);
  addActivity(`Model: ${taskConfigurationLabel(task)}`, task.createdAt);
  if (task.attachments?.length) {
    addActivity(`${task.attachments.length} task attachment${task.attachments.length === 1 ? '' : 's'} prepared`, task.createdAt);
  }
  if (task.skills?.length) {
    addActivity(`${task.skills.length} selected skill${task.skills.length === 1 ? '' : 's'} included`, task.createdAt);
  }
  if (task.chatgptProject?.name) {
    addActivity(`ChatGPT project: ${task.chatgptProject.name}`, task.createdAt);
  }
  renderResult(task);
  renderTaskTargetOptions(task);
  renderTaskList();
  window.patchwork.setBrowserVisible(false);
  renderTaskChat(task);
  if (taskHasChat(task) && !state.chatSnapshot) refreshTaskChat(task.taskId).catch(() => {});
}

function showComposer() {
  closeConflictResolutionModal();
  closeSkillDrawer();
  closePromptManager();
  closePromptLibraryMenu();
  resetTaskSkills();
  state.selectedPromptIds = [];
  state.promptLibrarySearch = '';
  elements['prompt-library-search'].value = '';
  renderPromptLibrarySelection();
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
  restoreTaskModelSelection();
  restoreTaskReasoningSelection();
  restoreTaskProjectSelection();
  restoreTaskTreeSelection();
  renderTaskTargetOptions(null);
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
  restoreTaskProjectSelection();
  renderTreesProjectSelection();
  refreshTrees().catch((error) => showToast(error.message, true));
  refreshChatGPTProjects().catch(() => {});
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
  if (elements['session-view'].classList.contains('hidden')) return;
  const bounds = elements['session-chatgpt-surface'].getBoundingClientRect();
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
    if (repositories[0]) {
      state.repositories = [repositories[0]];
      resetTaskSkills();
    }
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

function closeDiffTabContextMenu() {
  state.diffTabContextKey = null;
  elements['diff-tab-context-menu'].classList.add('hidden');
}

function openDiffTabContextMenu(key, x, y) {
  const index = state.diffTabs.findIndex((tab) => tab.key === key);
  if (index === -1) return;
  const menu = elements['diff-tab-context-menu'];
  state.diffTabContextKey = key;
  menu.classList.remove('hidden');
  menu.style.left = '0px';
  menu.style.top = '0px';
  const closeRight = menu.querySelector('[data-action="close-right"]');
  const closeOthers = menu.querySelector('[data-action="close-others"]');
  const closeAll = menu.querySelector('[data-action="close-all"]');
  closeRight.disabled = index >= state.diffTabs.length - 1;
  closeOthers.disabled = state.diffTabs.length < 2;
  closeAll.disabled = state.diffTabs.length === 0;
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
}

function renderDiffTabs() {
  closeDiffTabContextMenu();
  const container = elements['diff-tabs'];
  if (state.diffTabs.length === 0) {
    container.innerHTML = '<span class="diff-tabs-empty">Open a changed file to compare it.</span>';
    return;
  }
  container.innerHTML = state.diffTabs.map((tab) => {
    const fileName = tab.filePath.split('/').pop();
    const active = tab.key === state.selectedDiffKey;
    return `<div class="diff-tab ${active ? 'active' : ''}" data-key="${escapeHtml(tab.key)}">
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
  container.querySelectorAll('.diff-tab').forEach((tab) => {
    tab.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openDiffTabContextMenu(tab.dataset.key, event.clientX, event.clientY);
    });
  });
}

function renderDiffRows(rows, side) {
  if (!rows || rows.length === 0) {
    return '<div class="diff-empty-state">No textual changes to compare.</div>';
  }
  const before = side === 'before';
  return rows.map((row) => {
    const type = before ? row.beforeType : row.afterType;
    const number = before ? row.beforeNumber : row.afterNumber;
    const text = before ? row.beforeText : row.afterText;
    return `<div class="diff-line ${escapeHtml(type)}">
      <span class="diff-line-number">${number ?? ''}</span>
      <code>${text ? escapeHtml(text) : '&nbsp;'}</code>
    </div>`;
  }).join('');
}

function renderDiffMessage(message, error = false) {
  const className = error ? 'diff-empty-state error' : 'diff-empty-state';
  const markup = `<div class="${className}">${escapeHtml(message)}</div>`;
  elements['diff-before-rows'].innerHTML = markup;
  elements['diff-after-rows'].innerHTML = markup;
}

function resetDiffScrollPosition() {
  elements['diff-before-rows'].scrollTop = 0;
  elements['diff-after-rows'].scrollTop = 0;
  elements['diff-before-rows'].scrollLeft = 0;
  elements['diff-after-rows'].scrollLeft = 0;
}

function renderActiveDiff() {
  const tab = state.diffTabs.find((item) => item.key === state.selectedDiffKey);
  resetDiffScrollPosition();
  if (!tab) {
    elements['diff-title'].textContent = 'Select a changed file';
    elements['diff-subtitle'].textContent = 'Its before and after comparison will appear here.';
    elements['diff-kind'].classList.add('hidden');
    elements['diff-before-label'].textContent = 'Before';
    elements['diff-after-label'].textContent = 'After';
    renderDiffMessage('No file selected.');
    return;
  }

  elements['diff-title'].textContent = tab.filePath;
  elements['diff-kind'].textContent = tab.staged ? 'Staged' : 'Working tree';
  elements['diff-kind'].classList.remove('hidden');
  if (tab.loading) {
    elements['diff-subtitle'].textContent = 'Loading comparison…';
    elements['diff-before-label'].textContent = tab.staged ? 'HEAD' : 'Index';
    elements['diff-after-label'].textContent = tab.staged ? 'Index' : 'Working Tree';
    renderDiffMessage('Loading before and after…');
    return;
  }
  if (tab.error) {
    elements['diff-subtitle'].textContent = 'Unable to load comparison';
    renderDiffMessage(tab.error, true);
    return;
  }

  const diff = tab.diff;
  elements['diff-before-label'].textContent = diff.beforeLabel || 'Before';
  elements['diff-after-label'].textContent = diff.afterLabel || 'After';
  if (diff.binary) {
    elements['diff-subtitle'].textContent = 'Binary file';
    renderDiffMessage('Binary file comparison is unavailable.');
    return;
  }
  elements['diff-subtitle'].textContent = diff.truncated
    ? 'Comparison truncated to keep the preview responsive'
    : (tab.staged ? 'HEAD compared with the staged file' : 'Index compared with the working file');
  elements['diff-before-rows'].innerHTML = renderDiffRows(diff.rows, 'before');
  elements['diff-after-rows'].innerHTML = renderDiffRows(diff.rows, 'after');
}

function closeGitDiffs(keys, fallbackKey = null) {
  const closingKeys = new Set(keys);
  const wasSelected = closingKeys.has(state.selectedDiffKey);
  const selectedIndex = state.diffTabs.findIndex((tab) => tab.key === state.selectedDiffKey);
  state.diffTabs = state.diffTabs.filter((tab) => !closingKeys.has(tab.key));
  if (wasSelected) {
    const fallbackIndex = fallbackKey ? state.diffTabs.findIndex((tab) => tab.key === fallbackKey) : -1;
    const next = fallbackIndex >= 0
      ? state.diffTabs[fallbackIndex]
      : state.diffTabs[Math.min(selectedIndex, state.diffTabs.length - 1)] || state.diffTabs[selectedIndex - 1] || null;
    state.selectedDiffKey = next?.key || null;
  } else if (state.selectedDiffKey && !state.diffTabs.some((tab) => tab.key === state.selectedDiffKey)) {
    state.selectedDiffKey = state.diffTabs.at(-1)?.key || null;
  }
  renderDiffTabs();
  renderActiveDiff();
  renderGitStatus();
}

function closeGitDiff(key) {
  if (!state.diffTabs.some((tab) => tab.key === key)) return;
  closeGitDiffs([key]);
}

function closeGitDiffsToRight(key) {
  const index = state.diffTabs.findIndex((tab) => tab.key === key);
  if (index === -1 || index >= state.diffTabs.length - 1) return;
  closeGitDiffs(state.diffTabs.slice(index + 1).map((tab) => tab.key), key);
}

function closeOtherGitDiffs(key) {
  if (!state.diffTabs.some((tab) => tab.key === key)) return;
  closeGitDiffs(state.diffTabs.filter((tab) => tab.key !== key).map((tab) => tab.key), key);
}

function closeAllGitDiffs() {
  if (state.diffTabs.length === 0) return;
  closeGitDiffs(state.diffTabs.map((tab) => tab.key));
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
    <button class="git-file-action" data-path="${escapeHtml(change.path)}" data-staged="${staged}" title="${staged ? 'Unstage' : 'Stage'}" ${state.gitSummaryBusy ? 'disabled' : ''}>${staged ? '−' : '+'}</button>
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
    elements['source-repository-select'].disabled = state.gitSummaryBusy;
    elements['source-refresh'].disabled = state.gitSummaryBusy;
    elements['source-add-repository'].disabled = state.gitSummaryBusy;
    elements['source-remove-repository'].disabled = state.gitSummaryBusy;
    elements['source-ai-summary-button'].disabled = true;
    elements['source-commit-button'].disabled = true;
    elements['source-git-summary-prompt-button'].disabled = state.gitSummaryBusy;
    elements['stage-all-button'].disabled = true;
    elements['unstage-all-button'].disabled = true;
    renderGitSummaryPromptStatus();
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
  elements['source-ai-summary-button'].disabled = total === 0 || state.gitSummaryBusy;
  elements['source-commit-button'].disabled = staged.length === 0 || state.gitSummaryBusy;
  elements['source-repository-select'].disabled = state.gitSummaryBusy;
  elements['source-refresh'].disabled = state.gitSummaryBusy;
  elements['source-add-repository'].disabled = state.gitSummaryBusy;
  elements['source-remove-repository'].disabled = state.gitSummaryBusy;
  elements['source-git-summary-prompt-button'].disabled = state.gitSummaryBusy;
  elements['stage-all-button'].disabled = unstaged.length === 0 || state.gitSummaryBusy;
  elements['unstage-all-button'].disabled = staged.length === 0 || state.gitSummaryBusy;
  elements['commit-history'].innerHTML = status.history.map((commit) => `
    <div class="commit-item"><strong>${escapeHtml(commit.subject)}</strong><small>${escapeHtml(commit.shortCommit)} · ${escapeHtml(commit.author)}</small></div>
  `).join('');
  renderGitSummaryPromptStatus();
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

async function generateGitSummary() {
  if (!state.selectedGitPath || state.gitSummaryBusy) return;
  state.gitSummaryBusy = true;
  renderGitStatus();
  const button = elements['source-ai-summary-button'];
  const repositoryPath = state.selectedGitPath;
  const originalLabel = button.textContent;
  button.textContent = 'Generating…';
  try {
    const result = await window.patchwork.gitSummary(repositoryPath, gitSummaryPrompt());
    const task = await window.patchwork.openTask(result.taskId);
    upsertTask(task);
    showTask(task);
    showToast(result.usedCustomPrompt
      ? 'Git Summary is ready in the task view using your saved prompt.'
      : 'Git Summary is ready in the task view using the built-in prompt.');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.gitSummaryBusy = false;
    button.textContent = originalLabel;
    renderGitStatus();
  }
}

async function useActiveGitSummary() {
  const task = state.activeTask;
  if (!task?.summaryOnly || task.state !== 'ready' || !task.result?.commitMessage) return;
  const button = elements['use-git-summary-button'];
  button.disabled = true;
  try {
    const completed = await window.patchwork.useGitSummary(task.taskId);
    upsertTask(completed);
    const repositoryPath = completed.sourceRepositoryPath || completed.repositories?.[0]?.path;
    if (!repositoryPath) throw new Error('The Git Summary task no longer has a Source Control repository.');
    state.selectedGitPath = repositoryPath;
    elements['source-commit-message'].value = completed.result.commitMessage;
    await showSourceControl();
    renderTaskList();
    showToast('Git Summary applied to the Source Control commit editor.');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function createTask() {
  const button = elements['create-task-button'];
  button.disabled = true;
  button.firstChild.textContent = 'Preparing bundle… ';
  try {
    const baseTaskText = elements['task-text'].value.trim();
    if (!baseTaskText) throw new Error('Describe the software task before creating a task package.');
    const taskText = buildTaskTextWithPrompts(baseTaskText);
    let chatgptProject = null;
    const projectSelection = elements['chatgpt-project-select'].value;
    if (projectSelection === '__new__') {
      const projectName = elements['new-project-name'].value.trim();
      if (!projectName) throw new Error('Enter a name for the new ChatGPT project.');
      button.firstChild.textContent = 'Creating ChatGPT project… ';
      chatgptProject = await window.patchwork.createChatGPTProject(projectName);
      state.chatgptProjects = [chatgptProject, ...state.chatgptProjects.filter((item) => item.id !== chatgptProject.id)];
      persistTaskProjectSelectionValue(chatgptProject.id);
      renderChatGPTProjects();
      elements['chatgpt-project-select'].value = chatgptProject.id;
      persistTaskProjectSelectionValue(chatgptProject.id);
      elements['new-project-fields'].classList.add('hidden');
      elements['new-project-name'].disabled = true;
    } else if (projectSelection) {
      chatgptProject = state.chatgptProjects.find((project) => project.id === projectSelection) || null;
      if (!chatgptProject) throw new Error('Refresh ChatGPT projects and choose the destination again.');
      persistTaskProjectSelectionValue(chatgptProject.id);
    }
    button.firstChild.textContent = 'Preparing bundle… ';
    const task = await window.patchwork.createTask({
      repositories: state.repositories,
      taskText,
      model: elements['task-model-select'].value,
      reasoningMode: elements['task-reasoning-select'].value,
      skillIds: [...state.selectedSkillIds],
      autoApply: true,
      treeId: elements['task-tree-select'].value && elements['task-tree-select'].value !== TASK_NEW_TREE_VALUE
        ? elements['task-tree-select'].value
        : null,
      createTree: elements['task-tree-select'].value === TASK_NEW_TREE_VALUE,
      treeName: elements['tree-name'].value,
      attachments: state.attachments,
      chatgptProject,
    });
    state.attachments = [];
    resetTaskSkills();
    renderAttachments();
    persistTaskTreeSelectionValue(task.treeId || '');
    elements['task-tree-select'].value = task.treeId || '';
    upsertTask(task);
    await refreshTrees();
    showTask(task);
    addActivity('Fresh embedded chat prepared');
    showToast('Task package prepared. Submitting through the hidden ChatGPT session…');
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
  elements['task-tree-select'].value = TASK_NEW_TREE_VALUE;
  persistTaskTreeSelectionValue(TASK_NEW_TREE_VALUE);
  elements['tree-name'].value = '';
  showComposer();
});
elements['task-tree-select'].addEventListener('change', (event) => {
  persistTaskTreeSelection(event);
  resetTaskSkills();
  renderTaskTreeOptions();
});
elements['task-target-select'].addEventListener('change', (event) => {
  const selected = event.target.value;
  if (selected === TASK_NEW_TREE_VALUE) {
    elements['task-target-new-fields'].classList.remove('hidden');
    elements['task-target-tree-name'].disabled = false;
    elements['task-target-tree-name'].focus();
    return;
  }
  changeActiveTaskTarget(selected);
});
elements['task-target-create-button'].addEventListener('click', createActiveTaskTargetTree);
elements['task-model-select'].addEventListener('change', persistTaskModelSelection);
elements['task-reasoning-select'].addEventListener('change', persistTaskReasoningSelection);
elements['prompt-library-trigger'].addEventListener('click', togglePromptLibraryMenu);
elements['prompt-library-manage-button'].addEventListener('click', () => openPromptManager());
elements['prompt-library-new-button'].addEventListener('click', () => {
  closePromptLibraryMenu();
  openPromptManager();
  startPromptEditor();
});
elements['prompt-library-search'].addEventListener('input', (event) => {
  state.promptLibrarySearch = event.target.value;
  renderPromptLibraryMenu();
});
elements['prompt-library-modal'].addEventListener('click', (event) => {
  if (event.target === elements['prompt-library-modal']) closePromptManager();
});
elements['prompt-library-close-button'].addEventListener('click', closePromptManager);
elements['prompt-manager-new-button'].addEventListener('click', () => startPromptEditor());
elements['prompt-editor-cancel-button'].addEventListener('click', cancelPromptEditor);
elements['prompt-editor'].addEventListener('submit', savePromptFromEditor);
elements['chatgpt-project-select'].addEventListener('change', (event) => {
  persistTaskProjectSelection(event);
  renderChatGPTProjects();
  renderTreesProjectSelection();
});
elements['refresh-projects-button'].addEventListener('click', () => refreshChatGPTProjects(true));
elements['trees-project-select'].addEventListener('change', (event) => {
  persistTaskProjectSelection(event);
  renderTreesProjectSelection();
  renderChatGPTProjects();
});
elements['trees-refresh-projects-button'].addEventListener('click', () => refreshChatGPTProjects(true));
elements['add-repository-button'].addEventListener('click', chooseRepositories);
elements['add-attachment-button'].addEventListener('click', chooseAttachments);
elements['configure-skills-button'].addEventListener('click', openSkillDrawer);
elements['skills-close-button'].addEventListener('click', closeSkillDrawer);
elements['skills-done-button'].addEventListener('click', closeSkillDrawer);
elements['skills-refresh-button'].addEventListener('click', () => refreshSkillCatalog(true));
elements['skills-search'].addEventListener('input', renderSkillDrawerList);
elements['skills-modal'].addEventListener('click', (event) => {
  if (event.target === elements['skills-modal']) closeSkillDrawer();
});
elements['diff-tab-context-menu'].querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => {
    const key = state.diffTabContextKey;
    closeDiffTabContextMenu();
    if (!key) return;
    if (button.dataset.action === 'close') closeGitDiff(key);
    if (button.dataset.action === 'close-right') closeGitDiffsToRight(key);
    if (button.dataset.action === 'close-others') closeOtherGitDiffs(key);
    if (button.dataset.action === 'close-all') closeAllGitDiffs();
  });
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements['skills-modal'].classList.contains('hidden')) closeSkillDrawer();
  if (event.key === 'Escape' && !elements['prompt-library-modal'].classList.contains('hidden')) closePromptManager();
  if (event.key === 'Escape' && !elements['prompt-library-menu'].classList.contains('hidden')) closePromptLibraryMenu();
  if (event.key === 'Escape' && !elements['conflict-resolution-modal'].classList.contains('hidden')) closeConflictResolutionModal();
  if (event.key === 'Escape' && !elements['diff-tab-context-menu'].classList.contains('hidden')) closeDiffTabContextMenu();
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.prompt-library-picker')) closePromptLibraryMenu();
  if (!event.target.closest('.diff-tab-context-menu') && !event.target.closest('.diff-tab')) closeDiffTabContextMenu();
});
elements['create-task-button'].addEventListener('click', createTask);
elements['submit-task-button'].addEventListener('click', () => runTaskAction(window.patchwork.submitTask, 'Task submitted.'));
elements['copy-prompt-button'].addEventListener('click', () => runTaskAction(window.patchwork.copyPrompt, 'Instructions copied.'));
elements['reveal-package-button'].addEventListener('click', () => runTaskAction(window.patchwork.revealPackage));
elements['import-result-button'].addEventListener('click', () => runTaskAction(window.patchwork.importResult));
elements['delete-task-button'].addEventListener('click', () => {
  if (state.activeTask) deleteTask(state.activeTask.taskId);
});
elements['use-git-summary-button'].addEventListener('click', useActiveGitSummary);
elements['apply-button'].addEventListener('click', () => runTaskAction(window.patchwork.applyTask, 'Changes applied.'));
elements['retry-apply-button'].addEventListener('click', async () => {
  if (!state.activeTask) return;
  const button = elements['retry-apply-button'];
  button.disabled = true;
  try {
    const task = await window.patchwork.retryApplyTask(state.activeTask.taskId);
    if (!task) return;
    upsertTask(task);
    await refreshTrees();
    showTask(task);
    showToast(task.state === 'applied' ? 'Changes applied.' : 'Retried the result download and apply.');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});
elements['resolve-conflict-button'].addEventListener('click', () => openConflictResolutionModal(state.activeTask));
elements['conflict-resolution-cancel-button'].addEventListener('click', closeConflictResolutionModal);
elements['conflict-resolution-cancel-action'].addEventListener('click', closeConflictResolutionModal);
elements['conflict-resolution-submit-button'].addEventListener('click', submitConflictResolution);
elements['conflict-resolution-modal'].addEventListener('click', (event) => {
  if (event.target === elements['conflict-resolution-modal']) closeConflictResolutionModal();
});
elements['rollback-button'].addEventListener('click', () => runTaskAction(window.patchwork.rollbackTask, 'Changes rolled back.'));
elements['session-new-chat-button'].addEventListener('click', () => runBrowserAction(window.patchwork.newChat, 'New ChatGPT chat opened.'));
elements['session-reload-button'].addEventListener('click', () => runBrowserAction(window.patchwork.reloadBrowser));
elements['session-back-button'].addEventListener('click', () => runBrowserAction(window.patchwork.browserBack));
elements['session-forward-button'].addEventListener('click', () => runBrowserAction(window.patchwork.browserForward));
elements['task-chat-form'].addEventListener('submit', sendTaskChatMessage);
elements['task-chat-refresh-button'].addEventListener('click', () => refreshTaskChat());
elements['task-chat-stop-button'].addEventListener('click', stopTaskChat);
elements['task-chat-input'].addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    elements['task-chat-form'].requestSubmit();
  }
});
let diffScrollSyncing = false;
function syncDiffVerticalScroll(source, target) {
  if (diffScrollSyncing || target.scrollTop === source.scrollTop) return;
  diffScrollSyncing = true;
  target.scrollTop = source.scrollTop;
  requestAnimationFrame(() => { diffScrollSyncing = false; });
}

elements['diff-before-rows'].addEventListener('scroll', () => syncDiffVerticalScroll(elements['diff-before-rows'], elements['diff-after-rows']), { passive: true });
elements['diff-after-rows'].addEventListener('scroll', () => syncDiffVerticalScroll(elements['diff-after-rows'], elements['diff-before-rows']), { passive: true });

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
elements['source-ai-summary-button'].addEventListener('click', generateGitSummary);
elements['source-git-summary-prompt-button'].addEventListener('click', openGitSummaryPromptEditor);
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
new ResizeObserver(syncBrowserBounds).observe(elements['session-chatgpt-surface']);
setInterval(updateTaskElapsedTimes, 1_000);

window.patchwork.onTaskEvent((event) => {
  if (event.task) upsertTask(event.task);
  if (event.task) {
    renderTaskList();
    if (!elements['history-view'].classList.contains('hidden')) renderTaskHistory();
  }
  if (event.task && state.activeTask?.taskId === event.task.taskId) showTask(event.task);
  if (event.type === 'task-chat-snapshot' && state.activeTask?.taskId === event.taskId) {
    state.chatTaskId = event.taskId;
    state.chatSnapshot = event.snapshot || null;
    state.chatError = null;
    renderTaskChat(state.activeTask);
  }
  if (event.message && state.activeTask && (!event.taskId || event.taskId === state.activeTask.taskId)) addActivity(event.message);
  if (event.type === 'task-deleted') {
    state.tasks = state.tasks.filter((task) => task.taskId !== event.taskId);
    if (state.activeTask?.taskId === event.taskId) {
      state.activeTask = null;
      showTaskHistory();
    } else {
      renderTaskList();
      if (!elements['history-view'].classList.contains('hidden')) renderTaskHistory();
    }
    return;
  }
  if (event.type === 'task-failed') showToast(event.message || 'Task failed.', true);
  if (event.type === 'task-resolved') {
    if (event.resolutionTask?.taskId === state.activeTask?.taskId) showTask(event.task);
    showToast('The original task conflict has been resolved.');
  }
  if (event.type === 'task-applied') {
    showToast(event.task?.treeId
      ? 'ChatGPT changes were validated and committed to the coding tree.'
      : 'ChatGPT changes were validated and applied to the current repository.');
    refreshTrees().catch(() => {});
  }
  if (event.type === 'task-applied' && state.selectedGitPath) loadGitStatus(state.selectedGitPath);
  if (event.type === 'result-ready') {
    showToast(event.task?.summaryOnly ? 'The Git Summary result is ready.' : 'The ChatGPT result is ready to review.');
  }
  if (event.type === 'browser-loading') {
    elements['session-browser-status'].textContent = event.loading ? 'Loading…' : 'Persistent embedded session';
    elements['session-status-dot'].classList.toggle('loading', event.loading);
  }
  if (event.type === 'browser-title' && event.title) {
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
    restoreTaskModelSelection();
    restoreTaskReasoningSelection();
    restoreTaskProjectSelection();
    loadPromptLibrary();
    renderTaskList();
    renderRepositories();
    renderTrees();
    restoreTaskTreeSelection();
    renderSourceRepositories();
    renderSkillSelection();
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
