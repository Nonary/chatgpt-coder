const {
  formatBytes, h, replace, svg,
} = require('../dom');
const {
  appendPromptId,
  appendSkillId,
  closeComposerPopover,
  findSlashCommand,
  promptCommandName,
  removePromptId,
  removeSlashCommandToken,
  removeSkillId,
  skillCommandName,
} = require('../composer-controls');
const { TASK_MODE_LABELS } = require('../labels');
const { openComposerSettings } = require('../dialogs/composer-settings');
const {
  MODE_OPTIONS: SHARED_MODE_OPTIONS,
  compactModelLabel,
  compactReasoningLabel,
  configurationLabel,
  openAttachmentMenu: openSharedAttachmentMenu,
  openCommandPicker: openSharedCommandPicker,
  openModelMenu: openSharedModelMenu,
  openModeMenu: openSharedModeMenu,
  promptDescription,
} = require('../composer-common');

const NEW_TREE_VALUE = '__new__';
const NEW_PROJECT_VALUE = '__new__';
const SKILL_CACHE_TTL_MILLISECONDS = 60_000;

const MODE_OPTIONS = SHARED_MODE_OPTIONS;

const skillCatalogCache = new Map();

function composerConfigurationLabel(composer) {
  return configurationLabel(composer);
}

function composerTargetSummary(state) {
  const { composer } = state;
  let target = '';

  if (composer.treeSelection === NEW_TREE_VALUE) {
    target = composer.treeName.trim() ? `New tree · ${composer.treeName.trim()}` : 'New coding tree';
  } else if (composer.treeSelection) {
    const tree = state.trees.find((item) => item.id === composer.treeSelection);
    target = tree?.name || 'Coding tree';
  } else if (composer.repositories.length === 1) {
    const repository = composer.repositories[0];
    target = `${repository.name || repository.path}${repository.branch ? ` · ${repository.branch}` : ''}`;
  } else if (composer.repositories.length > 1) {
    const first = composer.repositories[0];
    target = `${first.name || first.path} + ${composer.repositories.length - 1} more`;
  } else {
    target = 'No repository selected';
  }

  if (!composer.treeSelection && composer.repositories.length > 0) {
    const summary = composer.submodules?.summary;
    const manualEditable = composer.repositories.filter(
      (repository) => repository.access !== 'context' && repository.readOnly !== true,
    ).length;
    const manualContext = composer.repositories.length - manualEditable;
    const workspaceTotal = Number.isInteger(summary?.workspaceTotal)
      ? summary.workspaceTotal
      : composer.repositories.length;
    const editable = Number.isInteger(summary?.editable) ? summary.editable : manualEditable;
    const context = Number.isInteger(summary?.context) ? summary.context : manualContext;
    if (workspaceTotal !== composer.repositories.length || context > 0) {
      target += composer.mode === 'ask'
        ? ` · ${workspaceTotal} repos · Ask read-only`
        : ` · ${workspaceTotal} repos · ${editable} editable · ${context} context`;
    }
  }

  if (composer.projectSelection === NEW_PROJECT_VALUE) {
    target += ` · New project${composer.newProjectName.trim() ? ` · ${composer.newProjectName.trim()}` : ''}`;
  } else if (composer.projectSelection) {
    const project = state.projects.find((item) => item.id === composer.projectSelection);
    if (project?.name) target += ` · ${project.name}`;
  }

  return target;
}

function restoreComposerFocus(ctx, cursor) {
  requestAnimationFrame(() => {
    const input = ctx.shell.view('tasks')?.querySelector('.composer-textarea');
    if (!input) return;
    input.focus();
    const position = Math.min(Number(cursor) || 0, input.value.length);
    input.setSelectionRange(position, position);
  });
}

function skillRepositoryKey(repositoryPaths) {
  return JSON.stringify(repositoryPaths);
}

function refreshSkillCatalog(ctx, repositoryPaths) {
  const repositoryKey = skillRepositoryKey(repositoryPaths);
  const now = Date.now();
  let entry = skillCatalogCache.get(repositoryKey);
  const expired = entry?.status === 'ready'
    && now - entry.loadedAt >= SKILL_CACHE_TTL_MILLISECONDS;
  if (entry && !expired) return entry;

  entry = { status: 'loading', skills: [], promise: null, loadedAt: 0 };
  entry.promise = ctx.api.skills(repositoryPaths).then((result) => {
    entry.status = 'ready';
    entry.skills = result.skills || [];
    entry.loadedAt = Date.now();

    const currentRepositoryKey = skillRepositoryKey(
      ctx.store.state.composer.repositories.map((repository) => repository.path),
    );
    if (currentRepositoryKey === repositoryKey) {
      ctx.store.set({ skills: entry.skills }, 'silent');
      const availableIds = new Set(entry.skills.map((skill) => skill.id));
      const selectedIds = ctx.store.state.composer.skillIds;
      const reconciledIds = selectedIds.filter((id) => availableIds.has(id));
      if (reconciledIds.length !== selectedIds.length) {
        ctx.store.setComposer({ skillIds: reconciledIds }, 'silent');
      }
    }
    return entry.skills;
  }).catch((error) => {
    skillCatalogCache.delete(repositoryKey);
    throw error;
  });
  skillCatalogCache.set(repositoryKey, entry);
  return entry;
}

function renderComposer(ctx) {
  closeComposerPopover();

  const { state } = ctx.store;
  const { composer } = state;

  let commandPickerController = null;
  let modelController = null;
  let modeController = null;
  let plusController = null;

  const attachmentInput = h('input', {
    type: 'file',
    multiple: true,
    style: { display: 'none' },
    onchange: () => {
      const files = [...attachmentInput.files];
      attachmentInput.value = '';
      ctx.actions.addAttachments(files);
    },
  });

  const taskText = h('textarea', {
    class: 'composer-textarea',
    rows: 6,
    placeholder: 'Ask a question, describe a task, or type / for commands…',
    value: composer.taskText,
    spellcheck: 'true',
    oninput: (event) => {
      event.stopPropagation();
      ctx.store.setComposer({ taskText: taskText.value }, 'silent');
      const token = findSlashCommand(taskText.value, taskText.selectionStart);
      if (!token) {
        commandPickerController?.close();
        return;
      }
      if (commandPickerController?.isOpen()) commandPickerController.refresh();
      else commandPickerController = openCommandPicker();
    },
    onkeydown: (event) => {
      event.stopPropagation();
      if (event.isComposing) return;

      if (commandPickerController?.isOpen()) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          event.stopPropagation();
          commandPickerController.move(1);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          event.stopPropagation();
          commandPickerController.move(-1);
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          const selected = commandPickerController.selectActive();
          if (selected) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        }
        if (event.key === 'Tab') {
          const selected = commandPickerController.selectActive();
          if (selected) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          commandPickerController.close();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          commandPickerController.close();
          return;
        }
      }

      if (event.key === 'Escape') {
        if (closeComposerPopover()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        ctx.actions.createTask({ submit: true });
      }
    },
  });

  const composerChipRow = h('div', { class: 'composer-chip-row', hidden: true });
  const modelLabel = h('span', { class: 'composer-model-label' }, composerConfigurationLabel(composer));
  const modeLabel = h('span', {}, TASK_MODE_LABELS[composer.mode] || TASK_MODE_LABELS.ask);

  const modelButton = h(
    'button',
    {
      class: 'composer-model-pill',
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      title: 'Choose model and reasoning',
      'aria-label': `Model and reasoning: ${composerConfigurationLabel(composer)}`,
      onclick: () => {
        if (modelController?.isOpen()) modelController.close();
        else openModelMenu();
      },
    },
    modelLabel,
    svg('m6 9 6 6 6-6', { size: 13, strokeWidth: 1.7 }),
  );

  const modeButton = h(
    'button',
    {
      class: 'composer-mode-pill',
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      title: 'Choose Ask or Agent mode',
      'aria-label': `Composer mode: ${TASK_MODE_LABELS[composer.mode] || TASK_MODE_LABELS.ask}`,
      onclick: () => {
        if (modeController?.isOpen()) modeController.close();
        else openModeMenu();
      },
    },
    modeLabel,
    svg('m6 9 6 6 6-6', { size: 13, strokeWidth: 1.7 }),
  );

  const plusButton = h(
    'button',
    {
      class: 'composer-plus-button',
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      title: 'Add to prompt',
      'aria-label': 'Add to prompt',
      onclick: () => {
        if (plusController?.isOpen()) plusController.close();
        else openPlusMenu();
      },
    },
    '+',
  );

  const sendButton = h(
    'button',
    {
      class: 'primary composer-send-button',
      type: 'button',
      title: 'Send task',
      onclick: () => ctx.actions.createTask({ submit: true }),
    },
    'Send',
    svg('M5 12h14M13 6l6 6-6 6', { size: 16, strokeWidth: 1.8 }),
  );

  const composerSurface = h(
    'div',
    { class: 'composer-surface' },
    composerChipRow,
    taskText,
    h(
      'div',
      { class: 'composer-footer' },
      plusButton,
      attachmentInput,
      modelButton,
      h('div', { class: 'spacer' }),
      modeButton,
      sendButton,
    ),
  );

  const settingsButton = h(
    'button',
    {
      class: 'composer-settings-button',
      type: 'button',
      title: 'Configure target and destination',
      'aria-label': 'Configure target and destination',
      onclick: () => openComposerSettings({
        ctx,
        newTreeValue: NEW_TREE_VALUE,
        newProjectValue: NEW_PROJECT_VALUE,
      }),
    },
    svg('M12 8.3a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4Zm0-5.3v2m0 11v2m8.1-9.6-1.7 1m-12.8 7.4-1.7 1m0-9.4 1.7 1m12.8 7.4 1.7 1M6.7 5.7l1 1.7m8.6 8.9 1 1.7m0-12.3-1 1.7M7.7 16.3l-1 1.7', { size: 16, strokeWidth: 1.7 }),
  );

  const targetSummary = h(
    'span',
    { class: 'composer-target-value', title: composerTargetSummary(state) },
    composerTargetSummary(state),
  );

  function renderComposerChips() {
    const currentState = ctx.store.state;
    const currentComposer = currentState.composer;
    const selectedSkillChips = currentComposer.skillIds.map((skillId) => {
      const skill = currentState.skills.find((item) => item.id === skillId);
      const command = skillCommandName(skill || { id: skillId });
      return h(
        'span',
        { class: 'composer-chip composer-chip-skill', title: skill?.description || skill?.name || skillId },
        h('span', { class: 'composer-chip-label' }, `/${command}`),
        h('button', {
          type: 'button',
          class: 'composer-chip-remove',
          title: `Remove /${command}`,
          'aria-label': `Remove /${command}`,
          onclick: () => {
            ctx.store.setComposer({ skillIds: removeSkillId(ctx.store.state.composer.skillIds, skillId) }, 'silent');
            refreshComposer();
          },
        }, '×'),
      );
    });

    const selectedPromptChips = currentComposer.promptIds.map((promptId) => {
      const prompt = currentState.prompts.find((item) => item.id === promptId);
      const command = promptCommandName(prompt || { id: promptId });
      return h(
        'span',
        { class: 'composer-chip composer-chip-prompt', title: promptDescription(prompt || { id: promptId }) },
        h('span', { class: 'composer-chip-label' }, `/${command}`),
        h('button', {
          type: 'button',
          class: 'composer-chip-remove',
          title: `Remove /${command}`,
          'aria-label': `Remove /${command}`,
          onclick: () => {
            ctx.store.setComposer({ promptIds: removePromptId(ctx.store.state.composer.promptIds, promptId) }, 'silent');
            refreshComposer();
          },
        }, '×'),
      );
    });

    const attachmentChips = currentComposer.attachments.map((attachment) => h(
      'span',
      { class: 'composer-chip composer-chip-attachment', title: attachment.name },
      h('span', { class: 'composer-chip-label' }, `${attachment.name} · ${formatBytes(attachment.size)}`),
      h('button', {
        type: 'button',
        class: 'composer-chip-remove',
        title: `Remove ${attachment.name}`,
        'aria-label': `Remove ${attachment.name}`,
        onclick: () => {
          ctx.store.setComposer({
            attachments: ctx.store.state.composer.attachments.filter((item) => item.path !== attachment.path),
          }, 'silent');
          refreshComposer();
        },
      }, '×'),
    ));

    const children = [...selectedSkillChips, ...selectedPromptChips, ...attachmentChips];
    replace(composerChipRow, ...children);
    composerChipRow.hidden = children.length === 0;
  }

  function refreshComposer() {
    const currentState = ctx.store.state;
    const currentComposer = currentState.composer;
    renderComposerChips();
    if (taskText.value !== currentComposer.taskText) taskText.value = currentComposer.taskText || '';
    const configuration = composerConfigurationLabel(currentComposer);
    modelLabel.textContent = configuration;
    modelButton.setAttribute('aria-label', `Model and reasoning: ${configuration}`);
    modeLabel.textContent = TASK_MODE_LABELS[currentComposer.mode] || TASK_MODE_LABELS.ask;
    modeButton.setAttribute('aria-label', `Composer mode: ${TASK_MODE_LABELS[currentComposer.mode] || TASK_MODE_LABELS.ask}`);
    const target = composerTargetSummary(currentState);
    targetSummary.textContent = target;
    targetSummary.title = target;
    modelController?.reposition();
    modeController?.reposition();
    commandPickerController?.reposition();
    plusController?.reposition();
  }

  function buildCommands(skills) {
    const next = [];
    for (const skill of skills) {
      next.push({
        type: 'skill',
        id: skill.id,
        name: skillCommandName(skill),
        search: skill.name || skill.id,
        description: skill.description || 'No description.',
      });
    }
    for (const prompt of ctx.store.state.prompts) {
      next.push({
        type: 'prompt',
        id: prompt.id,
        name: promptCommandName(prompt),
        search: prompt.name || prompt.id,
        description: promptDescription(prompt),
      });
    }
    return next;
  }

  function openCommandPicker() {
    const repositoryPaths = ctx.store.state.composer.repositories.map((repository) => repository.path);
    const cacheEntry = refreshSkillCatalog(ctx, repositoryPaths);
    let skills = cacheEntry.skills;
    const footer = h('div', { class: 'composer-popover-footer' },
      h('button', { class: 'composer-popover-browse', type: 'button', onclick: () => { if (skills.length) ctx.store.set({ skills }, 'silent'); commandPickerController?.close(); ctx.actions.openSkillDrawer(); } }, 'Browse all skills'),
      h('button', { class: 'composer-popover-browse', type: 'button', onclick: () => { commandPickerController?.close(); ctx.actions.openPromptManager(); } }, 'Manage saved prompts'));
    const controller = openSharedCommandPicker({
      anchor: taskText,
      buildCommands: () => buildCommands(skills),
      selectedIds: () => new Set([...ctx.store.state.composer.skillIds, ...ctx.store.state.composer.promptIds]),
      selectCommand: (command, picker) => {
        const token = findSlashCommand(taskText.value, taskText.selectionStart);
        if (!token) { picker.close(); return false; }
        const removal = removeSlashCommandToken(taskText.value, token);
        const patch = command.type === 'skill'
          ? { skillIds: appendSkillId(ctx.store.state.composer.skillIds, command.id), taskText: removal.text }
          : { promptIds: appendPromptId(ctx.store.state.composer.promptIds, command.id), taskText: removal.text };
        ctx.store.setComposer(patch, 'silent'); picker.close(); refreshComposer(); restoreComposerFocus(ctx, removal.cursor); return true;
      },
      emptyText: (token) => token.query ? `No commands match /${token.query}.` : 'No commands are available for this context.',
      footer,
      onClose: () => { if (commandPickerController === controller) commandPickerController = null; },
    });
    commandPickerController = controller;
    if (cacheEntry.status === 'loading') cacheEntry.promise.then((loaded) => { skills = loaded; controller?.refresh(); }).catch((error) => { if (controller?.isOpen()) replace(controller.popover, h('div', { class: 'composer-empty error' }, error.message)); });
    return controller;
  }

  function openModelMenu() {
    let controller;
    controller = openSharedModelMenu({
      anchor: modelButton,
      getConfiguration: () => ctx.store.state.composer,
      setConfiguration: (patch) => {
        const next = { ...ctx.store.state.composer, ...patch };
        ctx.store.setComposer(patch, 'silent');
        if ('model' in patch) ctx.persist('task-model', next.model);
        ctx.persist('task-reasoning', next.reasoningMode);
      },
      onRefresh: refreshComposer,
      onClose: () => { if (modelController === controller) modelController = null; },
    });
    modelController = controller;
    return controller;
  }

  function openModeMenu() {
    let controller;
    controller = openSharedModeMenu({
      anchor: modeButton,
      getMode: () => ctx.store.state.composer.mode,
      setMode: (mode) => ctx.store.setComposer({ mode }, 'silent'),
      onRefresh: refreshComposer,
      onClose: () => { if (modeController === controller) modeController = null; },
    });
    modeController = controller;
    return controller;
  }

  function openPlusMenu() {
    let controller;
    controller = openSharedAttachmentMenu({
      anchor: plusButton, input: attachmentInput, title: 'Add to prompt',
      onClose: () => { if (plusController === controller) plusController = null; },
    });
    plusController = controller;
    return controller;
  }

  const root = h(
    'div',
    { class: 'composer-root' },
    h(
      'div',
      { class: 'composer-target-bar' },
      h(
        'div',
        { class: 'composer-target-copy' },
        h('span', { class: 'composer-target-label' }, 'Target:'),
        targetSummary,
      ),
      settingsButton,
    ),
    composerSurface,
  );
  root.updateComposer = refreshComposer;
  refreshComposer();
  return [root];
}

module.exports = {
  MODE_OPTIONS,
  NEW_PROJECT_VALUE,
  NEW_TREE_VALUE,
  composerTargetSummary,
  renderComposer,
};
