const { h, replace } = require('./dom');
const { MODEL_LABELS, REASONING_LABELS } = require('./labels');
const { taskModelSupportsReasoning } = require('../../../shared/chatgpt');
const { createComposerPopover } = require('./composer-controls');
const { filterComposerCommands, findSlashCommand } = require('./composer-controls');

const MODE_OPTIONS = [
  { value: 'ask', label: 'Ask', description: 'Answer questions and explore the codebase without making changes.' },
  { value: 'agent', label: 'Agent', description: 'Implement the requested changes and return the task result.' },
];

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

function configurationLabel(configuration) {
  return `${compactModelLabel(configuration.model)} · ${compactReasoningLabel(configuration.reasoningMode)}`;
}

function moveActiveIndex(current, delta, length) {
  if (length <= 0) return 0;
  return (current + delta + length) % length;
}

function renderCommandGroup(label, commands, activeIndex, onSelect, onHover, selectedIds) {
  if (!commands.length) return [];
  return [
    h('div', { class: 'composer-command-group-label' }, label),
    ...commands.map((command) => h(
      'button',
      {
        class: `composer-command-item${command.index === activeIndex ? ' active' : ''}`,
        type: 'button', role: 'menuitem', 'aria-selected': String(selectedIds.has(command.id)),
        onclick: () => onSelect(command), onmouseenter: () => onHover(command.index),
      },
      h('span', { class: 'composer-command-check', 'aria-hidden': 'true' }, selectedIds.has(command.id) ? '✓' : ''),
      h('span', { class: 'composer-command-copy' },
        h('span', { class: 'composer-command-name' }, `/${command.name}`),
        h('span', { class: 'composer-command-description' }, command.description)),
    )),
  ];
}

function openCommandPicker({ anchor, buildCommands, selectedIds, selectCommand, emptyText, footer = null, onClose }) {
  if (!findSlashCommand(anchor.value, anchor.selectionStart)) return null;
  let activeIndex = 0;
  let controller;
  controller = createComposerPopover({
    anchor, placement: 'above', width: 'min(380px, calc(100vw - 16px))',
    onClose: () => onClose?.(controller),
  });
  const header = h('div', { class: 'composer-popover-header' }, h('span', { class: 'composer-popover-title' }, 'Commands'), h('span', { class: 'composer-popover-hint' }, '↑ ↓ Enter · Tab'));
  const list = h('div', { class: 'composer-command-list' });
  replace(controller.popover, header, list, footer);
  const matches = () => {
    const token = findSlashCommand(anchor.value, anchor.selectionStart);
    return token ? filterComposerCommands(buildCommands(), token.query) : [];
  };
  const render = () => {
    if (!controller.isOpen()) return;
    const token = findSlashCommand(anchor.value, anchor.selectionStart);
    if (!token) { controller.close(); return; }
    const commands = matches().map((command, index) => ({ ...command, index }));
    activeIndex = Math.min(activeIndex, Math.max(0, commands.length - 1));
    const setActive = (index) => { activeIndex = index; list.querySelectorAll('.composer-command-item').forEach((item, itemIndex) => item.classList.toggle('active', itemIndex === activeIndex)); };
    const children = [
      ...renderCommandGroup('Skills', commands.filter((command) => command.type === 'skill'), activeIndex, (command) => selectCommand(command, controller), setActive, selectedIds()),
      ...renderCommandGroup('Prompts', commands.filter((command) => command.type === 'prompt'), activeIndex, (command) => selectCommand(command, controller), setActive, selectedIds()),
    ];
    if (!children.length) children.push(h('div', { class: 'composer-empty' }, emptyText(token)));
    replace(list, ...children);
    controller.reposition();
  };
  controller.refresh = render;
  controller.move = (delta) => {
    const available = matches();
    if (!available.length) return;
    activeIndex = moveActiveIndex(activeIndex, delta, available.length);
    render();
    list.querySelectorAll('.composer-command-item')[activeIndex]?.scrollIntoView({ block: 'nearest' });
  };
  controller.selectActive = () => {
    const available = matches();
    return available.length ? selectCommand(available[activeIndex], controller) : false;
  };
  controller.popover.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); controller.move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); controller.move(-1); }
    else if (event.key === 'Enter' || event.key === 'Tab' || event.key === ' ') { event.preventDefault(); controller.selectActive(); }
  });
  render();
  return controller;
}

function openModelMenu({ anchor, getConfiguration, setConfiguration, onRefresh, onClose }) {
  const current = getConfiguration();
  const modelChoices = Object.entries(MODEL_LABELS).map(([value, label]) => ({ kind: 'model', value, label }));
  const reasoningChoices = Object.entries(REASONING_LABELS)
    .filter(([value]) => taskModelSupportsReasoning(current.model, value))
    .map(([value, label]) => ({ kind: 'reasoning', value, label }));
  const choices = [...modelChoices, ...reasoningChoices];
  let activeIndex = Math.max(0, choices.findIndex((choice) => choice.kind === 'model'
    ? current.model === choice.value : current.reasoningMode === choice.value));
  let controller;
  controller = createComposerPopover({
    anchor, align: 'end', placement: 'above', width: 'min(280px, calc(100vw - 16px))',
    onClose: () => { anchor.setAttribute('aria-expanded', 'false'); onClose?.(controller); },
  });
  anchor.setAttribute('aria-expanded', 'true');
  const list = h('div', { class: 'composer-command-list' });
  replace(controller.popover, list);
  const isChecked = (choice) => {
    const configuration = getConfiguration();
    return choice.kind === 'model' ? configuration.model === choice.value : configuration.reasoningMode === choice.value;
  };
  const selectChoice = (choice) => {
    const configuration = getConfiguration();
    setConfiguration(choice.kind === 'model'
      ? { model: choice.value, reasoningMode: taskModelSupportsReasoning(choice.value, configuration.reasoningMode) ? configuration.reasoningMode : 'default' }
      : { reasoningMode: choice.value });
    controller.close();
    onRefresh();
  };
  const renderChoices = () => {
    const group = (label, items) => [h('div', { class: 'composer-command-group-label' }, label), ...items.map((choice) => {
      const index = choices.indexOf(choice);
      return h('button', { class: `composer-command-item composer-choice-item${index === activeIndex ? ' active' : ''}`, type: 'button', role: 'menuitemradio', 'aria-checked': String(isChecked(choice)), onclick: () => selectChoice(choice) }, h('span', { class: 'composer-command-check', 'aria-hidden': 'true' }, isChecked(choice) ? '✓' : ''), h('span', { class: 'composer-command-copy' }, h('span', { class: 'composer-command-name' }, choice.label)));
    })];
    replace(list, ...group('Model', modelChoices), ...group('Reasoning', reasoningChoices));
    controller.reposition();
  };
  const syncActive = () => list.querySelectorAll('.composer-command-item').forEach((item, index) => item.classList.toggle('active', index === activeIndex));
  controller.move = (delta) => { activeIndex = moveActiveIndex(activeIndex, delta, choices.length); syncActive(); list.querySelectorAll('.composer-command-item')[activeIndex]?.scrollIntoView({ block: 'nearest' }); };
  controller.selectActive = () => selectChoice(choices[activeIndex]);
  controller.popover.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); controller.move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); controller.move(-1); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); controller.selectActive(); }
  });
  renderChoices();
  list.querySelectorAll('.composer-command-item').forEach((item, index) => { item.onmouseenter = () => { activeIndex = index; syncActive(); }; });
  syncActive();
  controller.focusFirst();
  return controller;
}

function openModeMenu({ anchor, getMode, setMode, onRefresh, onClose }) {
  const currentMode = MODE_OPTIONS.some((item) => item.value === getMode()) ? getMode() : 'ask';
  let activeIndex = Math.max(0, MODE_OPTIONS.findIndex((item) => item.value === currentMode));
  let controller;
  controller = createComposerPopover({
    anchor, align: 'end', placement: 'above', width: 'min(320px, calc(100vw - 16px))',
    onClose: () => { anchor.setAttribute('aria-expanded', 'false'); onClose?.(controller); },
  });
  anchor.setAttribute('aria-expanded', 'true');
  const list = h('div', { class: 'composer-command-list' });
  replace(list, ...MODE_OPTIONS.map((mode, index) => h('button', {
    class: `composer-command-item composer-mode-item${index === activeIndex ? ' active' : ''}`,
    type: 'button', role: 'menuitemradio', 'aria-checked': String(getMode() === mode.value),
    onclick: () => { setMode(mode.value); controller.close(); onRefresh(); },
  }, h('span', { class: 'composer-command-check', 'aria-hidden': 'true' }, getMode() === mode.value ? '✓' : ''), h('span', { class: 'composer-command-copy' }, h('span', { class: 'composer-command-name' }, mode.label), h('span', { class: 'composer-command-description' }, mode.description)))));
  replace(controller.popover, list);
  const syncActive = () => list.querySelectorAll('.composer-command-item').forEach((item, index) => item.classList.toggle('active', index === activeIndex));
  controller.move = (delta) => { activeIndex = moveActiveIndex(activeIndex, delta, MODE_OPTIONS.length); syncActive(); list.querySelectorAll('.composer-command-item')[activeIndex]?.scrollIntoView({ block: 'nearest' }); };
  controller.selectActive = () => { setMode(MODE_OPTIONS[activeIndex].value); controller.close(); onRefresh(); };
  controller.popover.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); controller.move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); controller.move(-1); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); controller.selectActive(); }
  });
  list.querySelectorAll('.composer-command-item').forEach((item, index) => { item.onmouseenter = () => { activeIndex = index; syncActive(); }; });
  syncActive();
  controller.focusFirst();
  return controller;
}

function openAttachmentMenu({ anchor, input, title, onClose }) {
  let controller;
  controller = createComposerPopover({
    anchor, align: 'start', placement: 'above', width: 'min(240px, calc(100vw - 16px))',
    onClose: () => { anchor.setAttribute('aria-expanded', 'false'); onClose?.(controller); },
  });
  anchor.setAttribute('aria-expanded', 'true');
  replace(controller.popover,
    h('div', { class: 'composer-popover-header' }, h('span', { class: 'composer-popover-title' }, title)),
    h('div', { class: 'composer-command-list' }, h('button', { class: 'composer-command-item', type: 'button', role: 'menuitem', onclick: () => { controller.close(); input.click(); } }, h('span', { class: 'composer-command-check', 'aria-hidden': 'true' }, ''), h('span', { class: 'composer-command-copy' }, h('span', { class: 'composer-command-name' }, 'Upload files')))),
  );
  controller.focusFirst();
  return controller;
}

module.exports = { MODE_OPTIONS, compactModelLabel, compactReasoningLabel, configurationLabel, moveActiveIndex, openAttachmentMenu, openCommandPicker, openModeMenu, openModelMenu, promptDescription, renderCommandGroup };
