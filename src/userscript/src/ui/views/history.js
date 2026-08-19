const {
  formatDateTime, h, option,
} = require('../dom');
const { taskLabel, taskStateLabel } = require('../labels');

const STATE_FILTERS = [
  ['all', 'All states'],
  ['prepared', 'Prepared'],
  ['submitted', 'Running'],
  ['ready', 'Waiting to apply'],
  ['applied', 'Applied'],
  ['completed', 'Completed'],
  ['conflicted', 'Conflicted'],
  ['resolved', 'Resolved'],
  ['rolled-back', 'Rolled back'],
  ['failed', 'Needs attention'],
];

function searchText(task) {
  return [
    task.taskText,
    task.conversationTitle,
    task.result?.summary,
    task.result?.commitMessage,
    task.treeName,
    ...(task.repositories || []).map((repository) => repository.name),
  ].filter(Boolean).join(' ').toLowerCase();
}

function renderHistory(ctx) {
  const { state } = ctx.store;
  const search = h('input', {
    type: 'search',
    class: 'field-control',
    placeholder: 'Search tasks',
    value: state.historySearch,
    oninput: () => {
      ctx.store.set({ historySearch: search.value }, 'silent');
      ctx.renderActiveView();
    },
  });
  const stateSelect = h(
    'select',
    {
      class: 'field-control',
      onchange: () => {
        ctx.store.set({ historyState: stateSelect.value }, 'silent');
        ctx.renderActiveView();
      },
    },
    ...STATE_FILTERS.map(([value, label]) => option(value, label, value === state.historyState)),
  );

  const term = state.historySearch.trim().toLowerCase();
  const tasks = state.tasks.filter((task) => {
    if (state.historyState !== 'all' && task.state !== state.historyState) return false;
    return !term || searchText(task).includes(term);
  });

  const list = tasks.map((task) => h(
    'div',
    { class: 'list-item' },
    h(
      'span',
      { class: 'grow' },
      h('span', { class: 'title' }, taskLabel(task)),
      h('span', { class: 'subtitle' }, `${taskStateLabel(task)} · ${formatDateTime(task.createdAt)}${task.treeName ? ` · ${task.treeName}` : ''}`),
    ),
    h('button', { class: 'icon-button', title: 'Open task', onclick: () => ctx.actions.showTask(task.taskId) }, '→'),
    h('button', { class: 'icon-button', title: 'Show package', onclick: () => ctx.actions.revealPackage(task.taskId) }, '⇱'),
    h('button', { class: 'icon-button', title: 'Delete task', onclick: () => ctx.actions.deleteTask(task.taskId) }, '×'),
  ));

  return [
    h('div', { class: 'row' }, search, stateSelect),
    h('p', { class: 'field-help' }, `${tasks.length} of ${state.tasks.length} task${state.tasks.length === 1 ? '' : 's'}`),
    ...(list.length ? list : [h('div', { class: 'empty-state' }, 'No tasks match this filter.')]),
  ];
}

module.exports = { renderHistory, searchText };
