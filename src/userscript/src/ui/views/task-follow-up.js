const { formatBytes, formatDateTime, h, replace, svg } = require('../dom');
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
const { MODEL_LABELS, REASONING_LABELS, TASK_MODE_LABELS, latestTaskTurn } = require('../labels');
const { MODE_OPTIONS } = require('./composer');

function promptDescription(prompt) {
  const description = String(prompt?.description || prompt?.content || '').replace(/\s+/g, ' ').trim();
  return description ? description.slice(0, 180) : 'Saved instructions.';
}

function compactModelLabel(model) {
  return MODEL_LABELS[model] || MODEL_LABELS.default;
}

function compactReasoningLabel(reasoningMode) {
  return reasoningMode === 'default' ? 'Auto' : REASONING_LABELS[reasoningMode] || 'Auto';
}

function followUpConfigurationLabel(followUp) {
  return `${compactModelLabel(followUp.model)} · ${compactReasoningLabel(followUp.reasoningMode)}`;
}

function canFollowUp(task) {
  if (!task || task.summaryOnly || task.mergeResolution || task.state === 'conflicted' || task.state === 'failed') return false;
  if (task.state === 'submitted') return false;
  if (task.applyInProgress) return false;
  if (!task.conversationId && !task.conversationUrl) return false;
  return true;
}

function activeTurn(task) {
  return task?.activeTurnId ? latestTaskTurn(task) : null;
}

function canSendFollowUp(task, followUp) {
  return canFollowUp(task)
    && !activeTurn(task)
    && Boolean(String(followUp?.taskText || '').trim());
}

function moveActiveIndex(current, delta, length) {
  if (length <= 0) return 0;
  return (current + delta + length) % length;
}

function renderTurnState(turn) {
  if (turn.state === 'created') return 'Queued';
  if (turn.state === 'submitted') return 'Running';
  if (turn.state === 'awaiting-result') return 'Waiting for result';
  if (turn.state === 'completed') return 'Complete';
  if (turn.state === 'failed') return 'Failed';
  return turn.state || 'Unknown';
}

function renderTaskTurnList(task) {
  const turns = Array.isArray(task.turns) ? task.turns : [];
  if (turns.length === 0) return null;
  return h(
    'div',
    { class: 'task-turns' },
    h('div', { class: 'task-turns-heading' }, 'Task turns'),
    ...turns.map((turn, index) => h(
      'div',
      { class: `task-turn ${turn.state === 'failed' ? 'failed' : turn.state === 'completed' ? 'complete' : ''}` },
      h('div', { class: 'task-turn-marker', 'aria-hidden': 'true' }, index + 1),
      h(
        'div',
        { class: 'task-turn-copy' },
        h('div', { class: 'task-turn-title' }, `${TASK_MODE_LABELS[turn.mode] || turn.mode} · ${renderTurnState(turn)}`),
        h('div', { class: 'task-turn-meta' }, `${compactModelLabel(turn.model)} · ${compactReasoningLabel(turn.reasoningMode)} · ${formatDateTime(turn.createdAt)}`),
        turn.error ? h('div', { class: 'task-turn-error' }, turn.error) : null,
      ),
    )),
  );
}

function restoreFocus(ctx, cursor) {
  requestAnimationFrame(() => {
    const input = ctx.shell.view('tasks')?.querySelector('.task-follow-up-card .composer-textarea');
    if (!input) return;
    input.focus();
    const position = Math.min(Number(cursor) || 0, input.value.length);
    input.setSelectionRange(position, position);
  });
}

function renderCommandGroup(label, commands, activeIndex, onSelect, onHover, selectedIds) {
  if (!commands.length) return [];
  return [
    h('div', { class: 'composer-command-group-label' }, label),
    ...commands.map((command) => h(
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
    )),
  ];
}

function renderTaskFollowUpComposer(ctx, task, existing = null) {
  if (!canFollowUp(task)) return null;
  if (existing?.updateTaskFollowUp) {
    existing.updateTaskFollowUp(task);
    return existing;
  }
  closeComposerPopover();
  const { state } = ctx.store;
  const followUp = state.followUp;
  let taskRef = task;
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
      ctx.actions.addFollowUpAttachments(files);
    },
  });

  const taskText = h('textarea', {
    class: 'composer-textarea',
    rows: 5,
    disabled: Boolean(activeTurn(taskRef)) || Boolean(taskRef.applyInProgress),
    placeholder: 'Continue this task, ask a question, or type / for commands…',
    value: followUp.taskText,
    spellcheck: 'true',
    oninput: (event) => {
      event.stopPropagation();
      ctx.store.setFollowUp({ taskText: taskText.value }, 'silent');
      const token = findSlashCommand(taskText.value, taskText.selectionStart);
      if (!token || Boolean(activeTurn(taskRef)) || Boolean(taskRef.applyInProgress)) {
        commandPickerController?.close();
        return;
      }
      if (commandPickerController?.isOpen()) commandPickerController.refresh();
      else commandPickerController = openCommandPicker();
    },
    onkeydown: (event) => {
      event.stopPropagation();
      if (Boolean(activeTurn(taskRef)) || Boolean(taskRef.applyInProgress) || event.isComposing) return;
      if (commandPickerController?.isOpen()) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          commandPickerController.move(1);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          commandPickerController.move(-1);
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          const selected = commandPickerController.selectActive();
          if (selected) {
            event.preventDefault();
            return;
          }
        }
        if (event.key === 'Tab') {
          const selected = commandPickerController.selectActive();
          if (selected) {
            event.preventDefault();
            return;
          }
          commandPickerController.close();
        }
        if (event.key === 'Escape') {
          commandPickerController.close();
          return;
        }
      }
      if (event.key === 'Escape' && closeComposerPopover()) return;
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (canSendFollowUp(taskRef, ctx.store.state.followUp)) ctx.actions.sendFollowUp(taskRef.taskId);
      }
    },
  });

  const composerChipRow = h('div', { class: 'composer-chip-row', hidden: true });

  const modelLabel = h('span', { class: 'composer-model-label' }, followUpConfigurationLabel(followUp));
  const modeLabel = h('span', {}, TASK_MODE_LABELS[followUp.mode] || TASK_MODE_LABELS.ask);

  const modelButton = h('button', {
    class: 'composer-model-pill',
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    disabled: Boolean(activeTurn(taskRef)) || Boolean(taskRef.applyInProgress),
    title: 'Choose model and reasoning for the next follow-up',
    'aria-label': `Follow-up model and reasoning: ${followUpConfigurationLabel(followUp)}`,
    onclick: () => {
      if (modelController?.isOpen()) modelController.close();
      else modelController = openModelMenu();
    },
  }, modelLabel, svg('m6 9 6 6 6-6', { size: 13, strokeWidth: 1.7 }));

  const modeButton = h('button', {
    class: 'composer-mode-pill',
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    disabled: Boolean(activeTurn(taskRef)) || Boolean(taskRef.applyInProgress),
    title: 'Choose Ask or Agent mode for the next follow-up',
    'aria-label': `Follow-up mode: ${TASK_MODE_LABELS[followUp.mode] || TASK_MODE_LABELS.ask}`,
    onclick: () => {
      if (modeController?.isOpen()) modeController.close();
      else modeController = openModeMenu();
    },
  }, modeLabel, svg('m6 9 6 6 6-6', { size: 13, strokeWidth: 1.7 }));

  const plusButton = h('button', {
    class: 'composer-plus-button',
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    disabled: Boolean(activeTurn(taskRef)) || Boolean(taskRef.applyInProgress),
    title: 'Add to follow-up',
    'aria-label': 'Add to follow-up',
    onclick: () => {
      if (plusController?.isOpen()) plusController.close();
      else plusController = openPlusMenu();
    },
  }, '+');

  const sendButton = h('button', {
    class: 'primary composer-send-button',
    type: 'button',
    disabled: !canSendFollowUp(taskRef, followUp),
    title: Boolean(activeTurn(taskRef)) || Boolean(taskRef.applyInProgress) ? 'A follow-up is already running' : 'Send follow-up',
    onclick: () => ctx.actions.sendFollowUp(taskRef.taskId),
  }, h('span', { class: 'composer-send-label' }, 'Send'), svg('M5 12h14M13 6l6 6-6 6', { size: 16, strokeWidth: 1.8 }));
  const statusNote = h('div', { class: 'task-follow-up-note', hidden: true });
  const headingDescription = h('p', { class: 'field-help', style: { margin: '3px 0 0' } });

  const composerSurface = h(
    'div',
    { class: 'composer-surface' },
    composerChipRow,
    taskText,
    h('div', { class: 'composer-footer' }, plusButton, attachmentInput, modelButton, h('div', { class: 'spacer' }), modeButton, sendButton),
  );

  function renderFollowUpChips() {
    const currentState = ctx.store.state;
    const currentFollowUp = currentState.followUp;
    const selectedSkillChips = currentFollowUp.skillIds.map((skillId) => {
      const skill = taskRef.skills?.find((item) => String(item.id) === String(skillId));
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
            ctx.store.setFollowUp({ skillIds: removeSkillId(ctx.store.state.followUp.skillIds, skillId) }, 'silent');
            refreshTaskFollowUp();
          },
        }, '×'),
      );
    });

    const selectedPromptChips = currentFollowUp.promptIds.map((promptId) => {
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
            ctx.store.setFollowUp({ promptIds: removePromptId(ctx.store.state.followUp.promptIds, promptId) }, 'silent');
            refreshTaskFollowUp();
          },
        }, '×'),
      );
    });

    const attachmentChips = currentFollowUp.attachments.map((file, index) => h(
      'span',
      { class: 'composer-chip composer-chip-attachment', title: file.name },
      h('span', { class: 'composer-chip-label' }, `${file.name} · ${formatBytes(file.size)}`),
      h('button', {
        type: 'button',
        class: 'composer-chip-remove',
        title: `Remove ${file.name}`,
        'aria-label': `Remove ${file.name}`,
        onclick: () => {
          ctx.store.setFollowUp({ attachments: ctx.store.state.followUp.attachments.filter((_, itemIndex) => itemIndex !== index) }, 'silent');
          refreshTaskFollowUp();
        },
      }, '×'),
    ));

    const children = [...selectedSkillChips, ...selectedPromptChips, ...attachmentChips];
    replace(composerChipRow, ...children);
    composerChipRow.hidden = children.length === 0;
  }

  function refreshTaskFollowUp(nextTask = taskRef) {
    taskRef = nextTask || taskRef;
    const currentFollowUp = ctx.store.state.followUp;
    const currentTurn = activeTurn(taskRef);
    const busy = Boolean(currentTurn) || Boolean(taskRef.applyInProgress);

    renderFollowUpChips();
    if (taskText.value !== currentFollowUp.taskText) taskText.value = currentFollowUp.taskText || '';
    taskText.disabled = busy;
    taskText.placeholder = busy
      ? 'Finish the current follow-up before sending another message…'
      : 'Continue this task, ask a question, or type / for commands…';

    const configuration = followUpConfigurationLabel(currentFollowUp);
    modelLabel.textContent = configuration;
    modelButton.disabled = busy;
    modelButton.setAttribute('aria-label', `Follow-up model and reasoning: ${configuration}`);
    modeLabel.textContent = TASK_MODE_LABELS[currentFollowUp.mode] || TASK_MODE_LABELS.ask;
    modeButton.disabled = busy;
    modeButton.setAttribute('aria-label', `Follow-up mode: ${TASK_MODE_LABELS[currentFollowUp.mode] || TASK_MODE_LABELS.ask}`);
    plusButton.disabled = busy;
    sendButton.disabled = !canSendFollowUp(taskRef, currentFollowUp);
    sendButton.title = busy ? 'A follow-up is already running' : 'Send follow-up';
    sendButton.querySelector('.composer-send-label').textContent = currentTurn ? 'Running' : 'Send';

    if (busy) {
      commandPickerController?.close();
      modelController?.close();
      modeController?.close();
      plusController?.close();
    } else {
      commandPickerController?.reposition();
      modelController?.reposition();
      modeController?.reposition();
      plusController?.reposition();
    }

    if (currentTurn) {
      headingDescription.textContent = 'The same task and ChatGPT conversation are still running.';
      statusNote.hidden = false;
      statusNote.textContent = currentTurn.mode === 'agent'
        ? 'Agent is generating or waiting for its result file. You can send the next turn when it completes.'
        : 'Ask is generating in this same conversation.';
    } else {
      headingDescription.textContent = 'Send another Ask or Agent turn without creating a new task.';
      statusNote.hidden = true;
      statusNote.textContent = '';
    }
  }

  function buildCommands() {
    const next = [];
    for (const skill of taskRef.skills || []) {
      next.push({ type: 'skill', id: skill.id, name: skillCommandName(skill), search: skill.name || skill.id, description: skill.description || 'Task skill.' });
    }
    for (const prompt of ctx.store.state.prompts || []) {
      next.push({ type: 'prompt', id: prompt.id, name: promptCommandName(prompt), search: prompt.name || prompt.id, description: promptDescription(prompt) });
    }
    return next;
  }

  function openCommandPicker() {
    const initialToken = findSlashCommand(taskText.value, taskText.selectionStart);
    if (!initialToken || Boolean(activeTurn(taskRef)) || Boolean(taskRef.applyInProgress)) return null;
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
    const header = h('div', { class: 'composer-popover-header' }, h('span', { class: 'composer-popover-title' }, 'Commands'), h('span', { class: 'composer-popover-hint' }, '↑ ↓ Enter · Tab'));
    const list = h('div', { class: 'composer-command-list' });
    replace(controller.popover, header, list);

    function matchingCommands(token) {
      return filterComposerCommands(buildCommands(), token.query);
    }

    function selectCommand(command) {
      const token = findSlashCommand(taskText.value, taskText.selectionStart);
      if (!token) {
        controller.close();
        return false;
      }
      const removal = removeSlashCommandToken(taskText.value, token);
      const next = command.type === 'skill'
        ? { skillIds: appendSkillId(ctx.store.state.followUp.skillIds, command.id), taskText: removal.text }
        : { promptIds: appendPromptId(ctx.store.state.followUp.promptIds, command.id), taskText: removal.text };
      ctx.store.setFollowUp(next, 'silent');
      controller.close();
      refreshTaskFollowUp();
      restoreFocus(ctx, removal.cursor);
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
      const selectedIds = new Set([...ctx.store.state.followUp.skillIds, ...ctx.store.state.followUp.promptIds]);
      const setActiveCommand = (index) => {
        activeIndex = index;
        list.querySelectorAll('.composer-command-item').forEach((item, itemIndex) => {
          item.classList.toggle('active', itemIndex === activeIndex);
        });
      };
      const children = [
        ...renderCommandGroup('Skills', matches.filter((command) => command.type === 'skill'), activeIndex, selectCommand, setActiveCommand, selectedIds),
        ...renderCommandGroup('Prompts', matches.filter((command) => command.type === 'prompt'), activeIndex, selectCommand, setActiveCommand, selectedIds),
      ];
      if (children.length === 0) children.push(h('div', { class: 'composer-empty' }, token.query ? `No commands match /${token.query}.` : 'No commands are available for this task.'));
      replace(list, ...children);
      controller.reposition();
    }

    controller.refresh = renderCommandList;
    controller.move = (delta) => {
      const token = findSlashCommand(taskText.value, taskText.selectionStart);
      const matches = token ? matchingCommands(token) : [];
      if (!matches.length) return;
      activeIndex = moveActiveIndex(activeIndex, delta, matches.length);
      renderCommandList();
      list.querySelectorAll('.composer-command-item')[activeIndex]?.scrollIntoView({ block: 'nearest' });
    };
    controller.selectActive = () => {
      const token = findSlashCommand(taskText.value, taskText.selectionStart);
      const matches = token ? matchingCommands(token) : [];
      return matches.length ? selectCommand(matches[activeIndex]) : false;
    };
    controller.popover.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); controller.move(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); controller.move(-1); }
      else if (event.key === 'Enter' || event.key === 'Tab' || event.key === ' ') { event.preventDefault(); controller.selectActive(); }
    });
    renderCommandList();
    return controller;
  }

  function openModelMenu() {
    const modelChoices = Object.entries(MODEL_LABELS).map(([value, label]) => ({ kind: 'model', value, label }));
    const reasoningChoices = Object.entries(REASONING_LABELS).map(([value, label]) => ({ kind: 'reasoning', value, label }));
    const choices = [...modelChoices, ...reasoningChoices];
    const currentFollowUp = ctx.store.state.followUp;
    let activeIndex = Math.max(0, choices.findIndex((choice) => choice.kind === 'model'
      ? currentFollowUp.model === choice.value
      : currentFollowUp.reasoningMode === choice.value));
    let controller;
    controller = createComposerPopover({
      anchor: modelButton,
      align: 'end',
      placement: 'above',
      width: 'min(280px, calc(100vw - 16px))',
      onClose: () => { modelButton.setAttribute('aria-expanded', 'false'); if (modelController === controller) modelController = null; },
    });
    modelController = controller;
    modelButton.setAttribute('aria-expanded', 'true');
    const list = h('div', { class: 'composer-command-list' });
    replace(controller.popover, list);
    const isChecked = (choice) => choice.kind === 'model'
      ? ctx.store.state.followUp.model === choice.value
      : ctx.store.state.followUp.reasoningMode === choice.value;
    const selectChoice = (choice) => {
      ctx.store.setFollowUp(choice.kind === 'model' ? { model: choice.value } : { reasoningMode: choice.value }, 'silent');
      controller.close();
      refreshTaskFollowUp();
    };
    const renderChoices = () => {
      replace(list,
        h('div', { class: 'composer-command-group-label' }, 'Model'),
        ...modelChoices.map((choice) => h('button', { class: 'composer-command-item', type: 'button', role: 'menuitemradio', 'aria-checked': String(isChecked(choice)), onclick: () => selectChoice(choice) },
          h('span', { class: 'composer-command-check' }, isChecked(choice) ? '✓' : ''), h('span', { class: 'composer-command-copy' }, h('span', { class: 'composer-command-name' }, choice.label)))),
        h('div', { class: 'composer-command-group-label' }, 'Reasoning'),
        ...reasoningChoices.map((choice) => h('button', { class: 'composer-command-item', type: 'button', role: 'menuitemradio', 'aria-checked': String(isChecked(choice)), onclick: () => selectChoice(choice) },
          h('span', { class: 'composer-command-check' }, isChecked(choice) ? '✓' : ''), h('span', { class: 'composer-command-copy' }, h('span', { class: 'composer-command-name' }, choice.label)))));
      controller.reposition();
    };
    const syncActiveChoice = () => {
      list.querySelectorAll('.composer-command-item').forEach((item, index) => {
        item.classList.toggle('active', index === activeIndex);
      });
    };
    renderChoices();
    list.querySelectorAll('.composer-command-item').forEach((item, index) => {
      item.onmouseenter = () => {
        activeIndex = index;
        syncActiveChoice();
      };
    });
    controller.move = (delta) => {
      activeIndex = moveActiveIndex(activeIndex, delta, choices.length);
      syncActiveChoice();
      list.querySelectorAll('.composer-command-item')[activeIndex]?.scrollIntoView({ block: 'nearest' });
    };
    controller.selectActive = () => selectChoice(choices[activeIndex]);
    return controller;
  }

  function openModeMenu() {
    const currentFollowUp = ctx.store.state.followUp;
    let activeIndex = Math.max(0, MODE_OPTIONS.findIndex((mode) => mode.value === currentFollowUp.mode));
    let controller;
    controller = createComposerPopover({
      anchor: modeButton,
      align: 'end',
      placement: 'above',
      width: 'min(320px, calc(100vw - 16px))',
      onClose: () => { modeButton.setAttribute('aria-expanded', 'false'); if (modeController === controller) modeController = null; },
    });
    modeController = controller;
    modeButton.setAttribute('aria-expanded', 'true');
    const list = h('div', { class: 'composer-command-list' });
    replace(controller.popover, list);
    const selectMode = (mode) => {
      ctx.store.setFollowUp({ mode }, 'silent');
      controller.close();
      refreshTaskFollowUp();
    };
    replace(list, ...MODE_OPTIONS.map((mode) => h('button', { class: 'composer-command-item', type: 'button', role: 'menuitemradio', 'aria-checked': String(currentFollowUp.mode === mode.value), onclick: () => selectMode(mode.value) },
        h('span', { class: 'composer-command-check' }, currentFollowUp.mode === mode.value ? '✓' : ''),
        h('span', { class: 'composer-command-copy' }, h('span', { class: 'composer-command-name' }, mode.label), h('span', { class: 'composer-command-description' }, mode.description)))));
    controller.reposition();
    const syncActiveMode = () => {
      list.querySelectorAll('.composer-command-item').forEach((item, index) => item.classList.toggle('active', index === activeIndex));
    };
    list.querySelectorAll('.composer-command-item').forEach((item, index) => {
      item.onmouseenter = () => {
        activeIndex = index;
        syncActiveMode();
      };
    });
    controller.move = (delta) => {
      activeIndex = moveActiveIndex(activeIndex, delta, MODE_OPTIONS.length);
      syncActiveMode();
      list.querySelectorAll('.composer-command-item')[activeIndex]?.scrollIntoView({ block: 'nearest' });
    };
    controller.selectActive = () => selectMode(MODE_OPTIONS[activeIndex].value);
    syncActiveMode();
    return controller;
  }

  function openPlusMenu() {
    let controller;
    controller = createComposerPopover({
      anchor: plusButton,
      align: 'start',
      placement: 'above',
      width: 'min(240px, calc(100vw - 16px))',
      onClose: () => { plusButton.setAttribute('aria-expanded', 'false'); if (plusController === controller) plusController = null; },
    });
    plusController = controller;
    plusButton.setAttribute('aria-expanded', 'true');
    replace(controller.popover,
      h('div', { class: 'composer-popover-header' }, h('span', { class: 'composer-popover-title' }, 'Add to follow-up')),
      h('div', { class: 'composer-command-list' }, h('button', { class: 'composer-command-item', type: 'button', onclick: () => { controller.close(); attachmentInput.click(); } },
        h('span', { class: 'composer-command-check' }, ''), h('span', { class: 'composer-command-copy' }, h('span', { class: 'composer-command-name' }, 'Upload files')))),
    );
    controller.focusFirst();
    return controller;
  }

  const heading = h('div', { class: 'task-follow-up-heading' },
    h('div', {},
      h('h3', { style: { margin: '0' } }, 'Continue this task'),
      headingDescription,
    ),
  );

  const card = h(
    'div',
    { class: 'card task-follow-up-card' },
    heading,
    composerSurface,
    statusNote,
  );
  card.updateTaskFollowUp = refreshTaskFollowUp;
  refreshTaskFollowUp(taskRef);
  return card;
}

module.exports = {
  canFollowUp,
  canSendFollowUp,
  renderTaskFollowUpComposer,
  renderTaskTurnList,
};
