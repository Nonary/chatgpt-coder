const {
  formatBytes, h, replace, svg,
} = require('../dom');
const {
  appendPromptId,
  appendSkillId,
  closeComposerPopover,
  createComposerPopover,
  filterComposerCommands,
  findSlashCommand,
  promptCommandName,
  removePromptId,
  removeSlashCommandToken,
  removeSkillId,
  skillCommandName,
} = require('../composer-controls');
const { MODEL_LABELS, REASONING_LABELS, TASK_MODE_LABELS } = require('../labels');
const { openComposerSettings } = require('../dialogs/composer-settings');

const NEW_TREE_VALUE = '__new__';
const NEW_PROJECT_VALUE = '__new__';
const SKILL_CACHE_TTL_MILLISECONDS = 60_000;

const MODE_OPTIONS = [
  {
    value: 'ask',
    label: TASK_MODE_LABELS.ask,
    description: 'Answer questions and explore the codebase without making changes.',
  },
  {
    value: 'agent',
    label: TASK_MODE_LABELS.agent,
    description: 'Implement the requested changes and return the task result.',
  },
];

const skillCatalogCache = new Map();

function moveActiveIndex(current, delta, length) {
  if (length <= 0) return 0;
  return (current + delta + length) % length;
}

function compactModelLabel(model) {
  return MODEL_LABELS[model] || MODEL_LABELS.default;
}

function compactReasoningLabel(reasoningMode) {
  return reasoningMode === 'default'
    ? 'Auto'
    : REASONING_LABELS[reasoningMode] || 'Auto';
}

function composerConfigurationLabel(composer) {
  return `${compactModelLabel(composer.model)} · ${compactReasoningLabel(composer.reasoningMode)}`;
}

function promptDescription(prompt) {
  const description = String(prompt?.description || prompt?.content || '').replace(/\s+/g, ' ').trim();
  return description ? description.slice(0, 180) : 'Saved instructions.';
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

function renderCommandGroup(label, commands, activeIndex, onSelect, onHover, selectedIds) {
  if (!commands.length) return [];
  const children = [h('div', { class: 'composer-command-group-label' }, label)];
  children.push(...commands.map((command) => h(
    'button',
    {
      class: `composer-command-item${command.index === activeIndex ? ' active' : ''}`,
      type: 'button',
      role: 'menuitem',
      'aria-selected': String(selectedIds.has(command.id)),
      onclick: () => onSelect(command),
      onmouseenter: () => onHover(command.index),
    },
    h('span', { class: 'composer-command-check', 'aria-hidden': 'true' }, selectedIds.has(command.id) ? '✓' : ''),
    h(
      'span',
      { class: 'composer-command-copy' },
      h('span', { class: 'composer-command-name' }, `/${command.name}`),
      h('span', { class: 'composer-command-description' }, command.description),
    ),
  )));
  return children;
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
    const initialToken = findSlashCommand(taskText.value, taskText.selectionStart);
    if (!initialToken) return null;

    const repositoryPaths = ctx.store.state.composer.repositories.map((repository) => repository.path);
    const cacheEntry = refreshSkillCatalog(ctx, repositoryPaths);
    let skills = cacheEntry.skills;
    let activeIndex = 0;
    let controller;
    controller = createComposerPopover({
      anchor: taskText,
      placement: 'above',
      width: 'min(380px, calc(100vw - 16px))',
      onClose: () => {
        if (commandPickerController === controller) commandPickerController = null;
      },
    });
    commandPickerController = controller;

    const header = h(
      'div',
      { class: 'composer-popover-header' },
      h('span', { class: 'composer-popover-title' }, 'Commands'),
      h('span', { class: 'composer-popover-hint' }, '↑ ↓ Enter · Tab'),
    );
    const list = h('div', { class: 'composer-command-list' });
    const browse = h('button', {
      class: 'composer-popover-browse',
      type: 'button',
      onclick: () => {
        if (skills.length) ctx.store.set({ skills }, 'silent');
        controller.close();
        ctx.actions.openSkillDrawer();
      },
    }, 'Browse all skills');
    const manage = h('button', {
      class: 'composer-popover-browse',
      type: 'button',
      onclick: () => {
        controller.close();
        ctx.actions.openPromptManager();
      },
    }, 'Manage saved prompts');
    replace(controller.popover, header, list, h('div', { class: 'composer-popover-footer' }, browse, manage));

    function matchingCommands(token) {
      return filterComposerCommands(buildCommands(skills), token.query);
    }

    function selectCommand(command) {
      const token = findSlashCommand(taskText.value, taskText.selectionStart);
      if (!token) {
        controller.close();
        return false;
      }
      const removal = removeSlashCommandToken(taskText.value, token);
      if (command.type === 'skill') {
        ctx.store.setComposer({
          skillIds: appendSkillId(ctx.store.state.composer.skillIds, command.id),
          taskText: removal.text,
        }, 'silent');
      } else {
        ctx.store.setComposer({
          promptIds: appendPromptId(ctx.store.state.composer.promptIds, command.id),
          taskText: removal.text,
        }, 'silent');
      }
      controller.close();
      refreshComposer();
      restoreComposerFocus(ctx, removal.cursor);
      return true;
    }

    function renderCommandList() {
      if (!controller.isOpen()) return;
      const token = findSlashCommand(taskText.value, taskText.selectionStart);
      if (!token) {
        controller.close();
        return;
      }

      const matches = matchingCommands(token).map((command, index) => ({ ...command, index }));
      activeIndex = Math.min(activeIndex, Math.max(0, matches.length - 1));
      const selectedSkillIds = new Set(ctx.store.state.composer.skillIds);
      const selectedPromptIds = new Set(ctx.store.state.composer.promptIds);
      const selectedIds = new Set([...selectedSkillIds, ...selectedPromptIds]);
      const skillMatches = matches.filter((command) => command.type === 'skill');
      const promptMatches = matches.filter((command) => command.type === 'prompt');
      const children = [];

      if (cacheEntry.status === 'loading' && skillMatches.length === 0 && !token.query) {
        children.push(h('div', { class: 'composer-empty' }, 'Loading skills…'));
      }

      children.push(...renderCommandGroup(
        'Skills',
        skillMatches,
        activeIndex,
        selectCommand,
        (index) => {
          activeIndex = index;
          list.querySelectorAll('.composer-command-item').forEach((item, itemIndex) => item.classList.toggle('active', itemIndex === activeIndex));
        },
        selectedIds,
      ));
      children.push(...renderCommandGroup(
        'Prompts',
        promptMatches,
        activeIndex,
        selectCommand,
        (index) => {
          activeIndex = index;
          list.querySelectorAll('.composer-command-item').forEach((item, itemIndex) => item.classList.toggle('active', itemIndex === activeIndex));
        },
        selectedIds,
      ));

      if (children.length === 0) {
        children.push(h(
          'div',
          { class: 'composer-empty' },
          token.query ? `No commands match /${token.query}.` : 'No commands are available for this context.',
        ));
      }

      replace(list, ...children);
      controller.reposition();
    }

    controller.refresh = renderCommandList;
    controller.move = (delta) => {
      const token = findSlashCommand(taskText.value, taskText.selectionStart);
      if (!token) {
        controller.close();
        return;
      }
      const matches = matchingCommands(token);
      if (!matches.length) return;
      activeIndex = moveActiveIndex(activeIndex, delta, matches.length);
      renderCommandList();
      const activeButton = list.querySelectorAll('.composer-command-item')[activeIndex];
      activeButton?.scrollIntoView({ block: 'nearest' });
    };
    controller.selectActive = () => {
      const token = findSlashCommand(taskText.value, taskText.selectionStart);
      const matches = token ? matchingCommands(token) : [];
      return matches.length ? selectCommand(matches[activeIndex]) : false;
    };

    controller.popover.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        controller.move(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        controller.move(-1);
      } else if (event.key === 'Enter' || event.key === 'Tab' || event.key === ' ') {
        event.preventDefault();
        controller.selectActive();
      }
    });

    renderCommandList();
    if (cacheEntry.status === 'loading') {
      cacheEntry.promise.then((loadedSkills) => {
        skills = loadedSkills;
        renderCommandList();
      }).catch((error) => {
        if (!controller.isOpen()) return;
        replace(list, h('div', { class: 'composer-empty error' }, error.message));
        controller.reposition();
      });
    }

    return controller;
  }

  function openModelMenu() {
    const modelChoices = Object.entries(MODEL_LABELS).map(([value, label]) => ({
      kind: 'model', value, label,
    }));
    const reasoningChoices = Object.entries(REASONING_LABELS).map(([value, label]) => ({
      kind: 'reasoning', value, label,
    }));
    const choices = [...modelChoices, ...reasoningChoices];
    const groups = [
      { label: 'Model', choices: modelChoices },
      { label: 'Reasoning', choices: reasoningChoices },
    ];
    const currentComposer = ctx.store.state.composer;
    let activeIndex = Math.max(0, choices.findIndex((choice) => (
      choice.kind === 'model'
        ? currentComposer.model === choice.value
        : currentComposer.reasoningMode === choice.value
    )));
    let controller;
    controller = createComposerPopover({
      anchor: modelButton,
      align: 'end',
      placement: 'above',
      width: 'min(280px, calc(100vw - 16px))',
      onClose: () => {
        modelButton.setAttribute('aria-expanded', 'false');
        if (modelController === controller) modelController = null;
      },
    });
    modelController = controller;
    modelButton.setAttribute('aria-expanded', 'true');

    const list = h('div', { class: 'composer-command-list' });
    replace(controller.popover, list);

    const isChecked = (choice) => choice.kind === 'model'
      ? ctx.store.state.composer.model === choice.value
      : ctx.store.state.composer.reasoningMode === choice.value;

    const selectChoice = (choice) => {
      if (choice.kind === 'model') {
        ctx.store.setComposer({ model: choice.value }, 'silent');
        ctx.persist('task-model', choice.value);
      } else {
        ctx.store.setComposer({ reasoningMode: choice.value }, 'silent');
        ctx.persist('task-reasoning', choice.value);
      }
      controller.close();
      refreshComposer();
    };

    const renderChoices = () => {
      const children = [];
      for (const group of groups) {
        children.push(h('div', { class: 'composer-command-group-label' }, group.label));
        for (const choice of group.choices) {
          const index = choices.indexOf(choice);
          children.push(h(
            'button',
            {
              class: `composer-command-item composer-choice-item${index === activeIndex ? ' active' : ''}`,
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': String(isChecked(choice)),
              onclick: () => selectChoice(choice),
            },
            h('span', { class: 'composer-command-check', 'aria-hidden': 'true' }, isChecked(choice) ? '✓' : ''),
            h('span', { class: 'composer-command-copy' }, h('span', { class: 'composer-command-name' }, choice.label)),
          ));
        }
      }
      replace(list, ...children);
      controller.reposition();
    };

    const syncActiveChoice = () => {
      list.querySelectorAll('.composer-command-item').forEach((item, index) => {
        item.classList.toggle('active', index === activeIndex);
      });
    };

    controller.move = (delta) => {
      activeIndex = moveActiveIndex(activeIndex, delta, choices.length);
      syncActiveChoice();
      list.querySelectorAll('.composer-command-item')[activeIndex]?.scrollIntoView({ block: 'nearest' });
    };
    controller.selectActive = () => selectChoice(choices[activeIndex]);
    controller.popover.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        controller.move(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        controller.move(-1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        controller.selectActive();
      }
    });

    renderChoices();
    list.querySelectorAll('.composer-command-item').forEach((item, index) => {
      item.onmouseenter = () => {
        activeIndex = index;
        syncActiveChoice();
      };
    });
    syncActiveChoice();
    controller.focusFirst();
    return controller;
  }

  function openModeMenu() {
    const currentComposer = ctx.store.state.composer;
    const currentMode = MODE_OPTIONS.some((item) => item.value === currentComposer.mode) ? currentComposer.mode : 'ask';
    let activeIndex = Math.max(0, MODE_OPTIONS.findIndex((item) => item.value === currentMode));
    let controller;
    controller = createComposerPopover({
      anchor: modeButton,
      align: 'end',
      placement: 'above',
      width: 'min(320px, calc(100vw - 16px))',
      onClose: () => {
        modeButton.setAttribute('aria-expanded', 'false');
        if (modeController === controller) modeController = null;
      },
    });
    modeController = controller;
    modeButton.setAttribute('aria-expanded', 'true');

    const list = h('div', { class: 'composer-command-list' });
    replace(controller.popover, list);

    const renderModes = () => {
      replace(
        list,
        ...MODE_OPTIONS.map((mode, index) => h(
          'button',
          {
            class: `composer-command-item composer-mode-item${index === activeIndex ? ' active' : ''}`,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': String(ctx.store.state.composer.mode === mode.value),
            onclick: () => selectMode(mode.value),
          },
          h('span', { class: 'composer-command-check', 'aria-hidden': 'true' }, ctx.store.state.composer.mode === mode.value ? '✓' : ''),
          h(
            'span',
            { class: 'composer-command-copy' },
            h('span', { class: 'composer-command-name' }, mode.label),
            h('span', { class: 'composer-command-description' }, mode.description),
          ),
        )),
      );
      controller.reposition();
    };

    const selectMode = (value) => {
      ctx.store.setComposer({ mode: value }, 'silent');
      controller.close();
      refreshComposer();
    };

    const syncActiveMode = () => {
      list.querySelectorAll('.composer-command-item').forEach((item, index) => item.classList.toggle('active', index === activeIndex));
    };

    controller.move = (delta) => {
      activeIndex = moveActiveIndex(activeIndex, delta, MODE_OPTIONS.length);
      syncActiveMode();
      list.querySelectorAll('.composer-command-item')[activeIndex]?.scrollIntoView({ block: 'nearest' });
    };
    controller.selectActive = () => selectMode(MODE_OPTIONS[activeIndex].value);
    controller.popover.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        controller.move(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        controller.move(-1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        controller.selectActive();
      }
    });

    renderModes();
    list.querySelectorAll('.composer-command-item').forEach((item, index) => {
      item.onmouseenter = () => {
        activeIndex = index;
        syncActiveMode();
      };
    });
    syncActiveMode();
    controller.focusFirst();
    return controller;
  }

  function openPlusMenu() {
    let controller;
    controller = createComposerPopover({
      anchor: plusButton,
      align: 'start',
      placement: 'above',
      width: 'min(240px, calc(100vw - 16px))',
      onClose: () => {
        plusButton.setAttribute('aria-expanded', 'false');
        if (plusController === controller) plusController = null;
      },
    });
    plusController = controller;
    plusButton.setAttribute('aria-expanded', 'true');

    const title = h('div', { class: 'composer-popover-header' }, h('span', { class: 'composer-popover-title' }, 'Add to prompt'));
    const upload = h('button', {
      class: 'composer-command-item',
      type: 'button',
      role: 'menuitem',
      onclick: () => {
        controller.close();
        attachmentInput.click();
      },
    },
    h('span', { class: 'composer-command-check', 'aria-hidden': 'true' }, ''),
    h('span', { class: 'composer-command-copy' }, h('span', { class: 'composer-command-name' }, 'Upload files')),
    );
    replace(controller.popover, title, h('div', { class: 'composer-command-list' }, upload));
    controller.focusFirst();
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
