const { formatBytes, formatDateTime, h, replace, svg } = require('../dom');
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
const {
  compactModelLabel,
  compactReasoningLabel,
  configurationLabel,
  openAttachmentMenu: openSharedAttachmentMenu,
  openCommandPicker: openSharedCommandPicker,
  openModeMenu: openSharedModeMenu,
  promptDescription,
} = require('../composer-common');

function followUpConfigurationLabel(followUp) {
  return configurationLabel(followUp);
}

function canFollowUp(task) {
  if (!task || task.summaryOnly || task.mergeResolution || task.state === 'conflicted' || task.state === 'failed') return false;
  if (task.state === 'submitted') return false;
  if (task.applyInProgress) return false;
  if (!task.conversationId && !task.conversationUrl) return false;
  return true;
}

function activeTurn(task) {
  if (!task?.activeTurnId || !Array.isArray(task.turns)) return null;
  return task.turns.find((turn) => turn.id === task.activeTurnId) || null;
}

function canSendFollowUp(task, followUp) {
  return canFollowUp(task)
    && !activeTurn(task)
    && Boolean(String(followUp?.taskText || '').trim());
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
      refreshTaskFollowUp();
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
    const controller = openSharedCommandPicker({
      anchor: taskText,
      buildCommands,
      selectedIds: () => new Set([...ctx.store.state.followUp.skillIds, ...ctx.store.state.followUp.promptIds]),
      selectCommand: (command, picker) => {
        const token = findSlashCommand(taskText.value, taskText.selectionStart);
        if (!token) { picker.close(); return false; }
        const removal = removeSlashCommandToken(taskText.value, token);
        const patch = command.type === 'skill'
          ? { skillIds: appendSkillId(ctx.store.state.followUp.skillIds, command.id), taskText: removal.text }
          : { promptIds: appendPromptId(ctx.store.state.followUp.promptIds, command.id), taskText: removal.text };
        ctx.store.setFollowUp(patch, 'silent'); picker.close(); refreshTaskFollowUp(); restoreFocus(ctx, removal.cursor); return true;
      },
      emptyText: (token) => token.query ? `No commands match /${token.query}.` : 'No commands are available for this task.',
      onClose: () => { if (commandPickerController === controller) commandPickerController = null; },
    });
    commandPickerController = controller;
    return controller;
  }

  function openModelMenu() {
    let controller;
    controller = openSharedModelMenu({
      anchor: modelButton,
      getConfiguration: () => ctx.store.state.followUp,
      setConfiguration: (patch) => ctx.store.setFollowUp(patch, 'silent'),
      onRefresh: refreshTaskFollowUp,
      onClose: () => { if (modelController === controller) modelController = null; },
    });
    modelController = controller;
    return controller;
  }

  function openModeMenu() {
    let controller;
    controller = openSharedModeMenu({
      anchor: modeButton,
      getMode: () => ctx.store.state.followUp.mode,
      setMode: (mode) => ctx.store.setFollowUp({ mode }, 'silent'),
      onRefresh: refreshTaskFollowUp,
      onClose: () => { if (modeController === controller) modeController = null; },
    });
    modeController = controller;
    return controller;
  }

  function openPlusMenu() {
    let controller;
    controller = openSharedAttachmentMenu({
      anchor: plusButton, input: attachmentInput, title: 'Add to follow-up',
      onClose: () => { if (plusController === controller) plusController = null; },
    });
    plusController = controller;
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
