const {
  formatDateTime, formatElapsed, h, option, replace, shortCommit,
} = require('../dom');
const {
  taskConfigurationLabel, taskLabel, taskStateLabel, taskStatusText,
} = require('../labels');

const NEW_TREE_VALUE = '__new__';

function canChangeTaskTarget(task) {
  return Boolean(task)
    && !task.summaryOnly
    && !task.answerOnly
    && ['prepared', 'submitted', 'ready', 'failed', 'conflicted'].includes(task.state)
    && (task.repositories || []).filter((repository) => !repository.readOnly).length === 1;
}

function applyActionLabel(task) {
  if (task.treeId) return `Apply to coding tree: ${task.treeName || 'selected tree'}`;
  return 'Apply to original repository';
}

function renderTargetCard(ctx, task) {
  if (!canChangeTaskTarget(task)) return null;
  const { trees } = ctx.store.state;
  const sourcePath = task.sourceRepositoryPath
    || task.repositories?.find((repository) => !repository.readOnly)?.path
    || '';
  const availableTrees = trees
    .filter((tree) => tree.available && tree.mergeState !== 'submitted')
    .filter((tree) => !sourcePath || tree.repositoryPath === sourcePath);
  const currentTree = task.treeId ? trees.find((tree) => tree.id === task.treeId) : null;
  const currentValue = currentTree?.available ? task.treeId : '';

  const treeNameInput = h('input', {
    type: 'text', class: 'field-control', maxlength: 80, placeholder: 'For example: Fix task target',
  });
  const createRow = h(
    'div',
    { class: 'row', hidden: true },
    treeNameInput,
    h('button', {
      class: 'secondary',
      onclick: () => ctx.actions.setTaskTarget(task.taskId, {
        createTree: true,
        treeName: treeNameInput.value.trim(),
      }),
    }, 'Create coding tree'),
  );

  const select = h(
    'select',
    {
      class: 'field-control',
      onchange: () => {
        if (select.value === NEW_TREE_VALUE) {
          createRow.hidden = false;
          return;
        }
        createRow.hidden = true;
        ctx.actions.setTaskTarget(task.taskId, { treeId: select.value || null });
      },
    },
    option('', 'Use original repository', currentValue === ''),
    task.treeId && !currentTree?.available
      ? h('option', { value: '', disabled: true }, `Missing worktree: ${task.treeName || task.treeId}`)
      : null,
    option(NEW_TREE_VALUE, 'Create a new coding tree'),
    ...availableTrees.map((tree) => option(
      tree.id,
      `${tree.name} · ${tree.repositoryName}${tree.managed === false ? ' · Git worktree' : ''}`,
      currentValue === tree.id,
    )),
  );

  let status;
  if (task.treeId && !currentTree?.available) {
    status = 'The previous worktree is unavailable. Choose a new one or use the original repository.';
  } else if (task.treeName) {
    status = `Changes will apply in ${task.treeName}. You can change this target until the task is applied.`;
  } else {
    status = 'Changes will apply to the original repository. You can change this target until the task is applied.';
  }

  return h(
    'div',
    { class: 'card' },
    h('h3', {}, 'Apply target'),
    select,
    createRow,
    h('p', { class: 'field-help' }, status),
  );
}

function renderResultCard(ctx, task) {
  if (!task.result) return null;
  const patches = h('div', { class: 'patch-list' });
  replace(
    patches,
    ...(task.result.patches || []).map((patch) => h(
      'div',
      { class: 'patch' },
      h('strong', {}, patch.name || patch.id),
      h('pre', {}, patch.stat || 'No changes'),
    )),
    task.result.commitMessage
      ? h(
        'div',
        { class: 'patch' },
        h('strong', {}, 'Commit'),
        h('pre', {}, task.result.commits?.[0]?.commit
          ? `${task.result.commitMessage}\n${shortCommit(task.result.commits[0].commit)}`
          : task.result.commitMessage),
      )
      : null,
  );

  const actions = h(
    'div',
    { class: 'row wrap' },
    task.summaryOnly && task.state === 'ready'
      ? h('button', { class: 'primary', onclick: () => ctx.actions.useGitSummary(task.taskId) }, 'Use in Source Control')
      : null,
    !task.summaryOnly && !task.answerOnly && task.state === 'ready'
      ? h('button', { class: 'primary', onclick: () => ctx.actions.applyTask(task.taskId) }, applyActionLabel(task))
      : null,
    task.state === 'conflicted'
      ? h('button', { class: 'primary', onclick: () => ctx.actions.retryApply(task.taskId) }, 'Retry apply')
      : null,
    task.state === 'conflicted'
      ? h('button', { class: 'secondary', onclick: () => ctx.actions.resolveConflict(task.taskId) }, 'Resolve in a new chat')
      : null,
    task.state === 'applied'
      ? h('button', { class: 'danger', onclick: () => ctx.actions.rollbackTask(task.taskId) }, 'Roll back')
      : null,
  );

  return h(
    'div',
    { class: 'card' },
    h('h3', {}, 'Result'),
    h('p', { class: 'muted', style: { margin: '0' } }, task.result.summary || 'The returned result passed validation.'),
    patches,
    actions,
  );
}

function renderTaskDetail(ctx, task) {
  const [title, copy] = taskStatusText(task);
  const elapsed = task.state === 'submitted' && task.submittedAt
    ? h('time', {
      class: 'elapsed',
      dataset: { startedAt: task.submittedAt, endedAt: task.chatFinishedAt || '' },
    }, formatElapsed(task.submittedAt, task.chatFinishedAt ? new Date(task.chatFinishedAt).getTime() : Date.now()))
    : null;

  const primaryActions = h(
    'div',
    { class: 'row wrap' },
    !task.summaryOnly && ['prepared', 'failed'].includes(task.state)
      ? h('button', { class: 'primary', onclick: () => ctx.actions.submitTask(task.taskId) }, 'Send')
      : null,
    task.conversationUrl
      ? h('button', { class: 'secondary', onclick: () => ctx.actions.openConversation(task.taskId) }, 'Open conversation')
      : null,
    !task.summaryOnly
      ? h('button', { class: 'secondary', onclick: () => ctx.actions.copyPrompt(task.taskId) }, 'Copy prompt')
      : null,
    h('button', { class: 'secondary', onclick: () => ctx.actions.revealPackage(task.taskId) }, 'Show package'),
    !task.summaryOnly && !task.answerOnly
      ? h('button', { class: 'secondary', onclick: () => ctx.actions.importResult(task.taskId) }, 'Import result')
      : null,
    h('button', { class: 'danger', onclick: () => ctx.actions.deleteTask(task.taskId) }, 'Delete task'),
  );

  const activity = h('div', { class: 'activity-list' });
  replace(activity, ...ctx.store.state.activity.slice(0, 25).map((entry) => h(
    'div',
    { class: 'activity-item' },
    h('time', {}, new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
    h('span', {}, entry.message),
  )));

  return [
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'secondary', onclick: () => ctx.actions.showComposer() }, '← New task'),
      h('div', { class: 'spacer' }),
      elapsed,
      h('span', { class: `status-badge ${task.state}` }, taskStateLabel(task)),
    ),
    h(
      'div',
      { class: 'card' },
      h('p', { class: 'eyebrow' }, taskConfigurationLabel(task)),
      h('h2', { style: { margin: '0', fontSize: '16px' } }, title),
      h('p', { class: 'muted', style: { margin: '0' } }, task.error || copy),
      h('p', { class: 'field-help' }, `${taskLabel(task)} · created ${formatDateTime(task.createdAt)}`),
      primaryActions,
    ),
    renderTargetCard(ctx, task),
    renderResultCard(ctx, task),
    h('div', { class: 'card' }, h('h3', {}, 'Activity'), activity),
  ];
}

module.exports = { applyActionLabel, canChangeTaskTarget, renderTaskDetail };
