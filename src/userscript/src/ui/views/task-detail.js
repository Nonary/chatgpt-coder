const {
  formatDateTime, formatElapsed, h, option, replace, shortCommit,
} = require('../dom');
const {
  taskConfigurationLabel, taskLabel, taskStateLabel, taskStatusText,
} = require('../labels');
const { renderTaskFollowUpComposer, renderTaskTurnList } = require('./task-follow-up');

const NEW_TREE_VALUE = '__new__';
const MISSING_TREE_VALUE = '__missing__';

function canChangeTaskTarget(task) {
  return Boolean(task)
    && !task.summaryOnly
    && taskHasAgentTurn(task)
    && ['prepared', 'submitted', 'ready', 'failed', 'conflicted'].includes(task.state)
    && (task.repositories || []).filter((repository) => !repository.readOnly).length === 1;
}

function taskHasAgentTurn(task) {
  if (!task?.answerOnly) return true;
  return (task.turns || []).some((turn) => turn.mode === 'agent');
}

function changedWritableRepositoryCount(task) {
  const repositories = new Map((task.repositories || []).map((repository) => [repository.id, repository]));
  return (task.result?.patches || []).filter((patch) => {
    const repository = repositories.get(patch.id);
    return repository && !repository.readOnly && patch.stat !== 'No changes';
  }).length;
}

function applyActionLabel(task) {
  if (task.treeId) return `Apply to coding tree: ${task.treeName || 'selected tree'}`;
  const count = changedWritableRepositoryCount(task);
  return count > 1 ? `Apply to ${count} repositories` : 'Apply to original repository';
}

function rollbackActionLabel(task) {
  const count = changedWritableRepositoryCount(task);
  return count > 1 ? `Roll back ${count} repositories` : 'Roll back';
}

function patchMetrics(patch) {
  const rows = String(patch?.numstat || '').split(/\r?\n/).filter(Boolean);
  let additions = 0;
  let deletions = 0;
  for (const row of rows) {
    const [added, deleted] = row.split(/\s+/, 2);
    if (/^\d+$/.test(added)) additions += Number(added);
    if (/^\d+$/.test(deleted)) deletions += Number(deleted);
  }
  if (rows.length === 0) return patch?.stat === 'No changes' ? 'No changes' : '';
  return `${rows.length} file${rows.length === 1 ? '' : 's'} · +${additions} -${deletions}`;
}

function taskTargetValue(task, trees) {
  if (!task?.treeId) return '';
  return trees.some((tree) => tree.id === task.treeId && tree.available)
    ? task.treeId
    : MISSING_TREE_VALUE;
}

function renderTargetCard(ctx, task) {
  if (!canChangeTaskTarget(task)) {
    const writableCount = (task.repositories || []).filter((repository) => !repository.readOnly).length;
    if (!task.summaryOnly && taskHasAgentTurn(task) && writableCount > 1
      && ['prepared', 'submitted', 'ready', 'failed', 'conflicted'].includes(task.state)) {
      return h(
        'div',
        { class: 'card' },
        h('h3', {}, 'Apply target'),
        h('p', { class: 'muted', style: { margin: '0' } },
          `This task uses the current checkouts for ${writableCount} editable repositories.`),
        h('p', { class: 'field-help' },
          'Coding trees currently support one editable repository. Mark the other repositories as Context before creating a tree.'),
      );
    }
    return null;
  }
  const { trees } = ctx.store.state;
  const sourcePath = task.sourceRepositoryPath
    || task.repositories?.find((repository) => !repository.readOnly)?.path
    || '';
  const availableTrees = trees
    .filter((tree) => tree.available && tree.mergeState !== 'submitted')
    .filter((tree) => !sourcePath || tree.repositoryPath === sourcePath);
  const currentTree = task.treeId ? trees.find((tree) => tree.id === task.treeId) : null;
  const currentValue = taskTargetValue(task, trees);

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
      ? h('option', { value: MISSING_TREE_VALUE, disabled: true, selected: true }, `Missing worktree: ${task.treeName || task.treeId}`)
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

function renderSummaryResultCard(ctx, task) {
  if (!task.result?.commitMessage) return null;
  const repository = (task.repositories || []).find((entry) => entry.path === task.sourceRepositoryPath)
    || task.repositories?.[0];
  const canUse = ['ready', 'completed'].includes(task.state);
  return h(
    'div',
    { class: 'card' },
    h('h3', {}, 'Generated commit message'),
    h('p', { class: 'muted', style: { margin: '0' } }, task.result.summary || 'A validated Conventional Commit message was generated from this Git change set.'),
    repository
      ? h('p', { class: 'field-help' }, `Repository: ${repository.name || repository.path}${repository.branch ? ` · ${repository.branch}` : ''}`)
      : null,
    h('p', { class: 'field-help' }, `Changes captured at ${formatDateTime(task.createdAt)}.`),
    h('pre', { class: 'git-summary-preview' }, task.result.commitMessage),
    h(
      'div',
      { class: 'row wrap' },
      canUse
        ? h('button', { class: 'primary', onclick: () => ctx.actions.useGitSummary(task.taskId) }, 'Use in Source Control')
        : null,
    ),
  );
}

function renderResultCard(ctx, task) {
  if (!task.result) return null;
  if (task.summaryOnly) return renderSummaryResultCard(ctx, task);

  const patches = h('div', { class: 'patch-list' });
  replace(
    patches,
    ...(task.result.patches || []).map((patch) => {
      const repository = (task.repositories || []).find((item) => item.id === patch.id);
      const conflict = (task.result.conflicts || []).find((item) => item.repositoryId === patch.id);
      return h(
        'div',
        { class: 'patch' },
        h(
          'div',
          { class: 'row patch-heading' },
          h('strong', {}, patch.name || patch.id),
          h('div', { class: 'spacer' }),
          conflict
            ? h('span', { class: 'status-badge conflicted' }, 'Conflict')
            : repository?.readOnly
              ? h('span', { class: 'status-badge' }, 'Context')
              : h(
                'span',
                { class: 'patch-metrics' },
                `${task.state === 'applied' && patch.stat !== 'No changes' ? 'Applied · ' : ''}${patchMetrics(patch)}`,
              ),
        ),
        h('pre', {}, patch.stat || 'No changes'),
      );
    }),
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

  const writableRepositories = (task.repositories || []).filter((repository) => !repository.readOnly && repository.path);
  const actions = h(
    'div',
    { class: 'row wrap' },
    !task.summaryOnly && taskHasAgentTurn(task) && task.state === 'ready'
      ? h('button', { class: 'primary', onclick: () => ctx.actions.applyTask(task.taskId) }, applyActionLabel(task))
      : null,
    writableRepositories.length > 0
      ? h('button', { class: 'secondary', onclick: () => ctx.actions.openTaskInSource(task.taskId) },
        writableRepositories.length > 1 ? 'Open repositories in Source Control' : 'Open in Source Control')
      : null,
    task.state === 'conflicted'
      ? h('button', { class: 'primary', onclick: () => ctx.actions.retryApply(task.taskId) }, 'Retry apply')
      : null,
    task.state === 'conflicted'
      ? h('button', { class: 'secondary', onclick: () => ctx.actions.resolveConflict(task.taskId) }, 'Resolve in a new chat')
      : null,
    task.state === 'applied'
      ? h('button', { class: 'danger', onclick: () => ctx.actions.rollbackTask(task.taskId) }, rollbackActionLabel(task))
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

function renderTaskDetail(ctx, task, { followUpComposer = null } = {}) {
  const [title, copy] = taskStatusText(task);
  const currentTurn = task.activeTurnId && Array.isArray(task.turns)
    ? task.turns.find((turn) => turn.id === task.activeTurnId)
    : null;
  const startedAt = currentTurn?.submittedAt || currentTurn?.createdAt || task.submittedAt;
  const elapsed = startedAt && (currentTurn || task.state === 'submitted')
    ? h('time', {
      class: 'elapsed',
      dataset: { startedAt, endedAt: task.chatFinishedAt || currentTurn?.completedAt || '' },
    }, formatElapsed(startedAt, task.chatFinishedAt || currentTurn?.completedAt
      ? new Date(task.chatFinishedAt || currentTurn?.completedAt).getTime()
      : Date.now()))
    : null;

  const primaryActions = h(
    'div',
    { class: 'row wrap' },
    !task.summaryOnly && ['prepared', 'failed'].includes(task.state)
      ? h('button', { class: 'primary', onclick: () => ctx.actions.submitTask(task.taskId) }, 'Send')
      : null,
    ['prepared', 'submitted', 'failed'].includes(task.state)
      ? h('button', { class: 'secondary', onclick: () => ctx.actions.refreshTask(task.taskId) }, 'Refresh status')
      : null,
    task.state === 'failed' && task.conversationUrl && taskHasAgentTurn(task)
      ? h('button', { class: 'primary', onclick: () => ctx.actions.retryResult(task.taskId) }, 'Retry result')
      : null,
    task.conversationUrl
      ? h('button', { class: 'secondary', onclick: () => ctx.actions.openConversation(task.taskId) }, 'Open conversation')
      : null,
    !task.summaryOnly
      ? h('button', { class: 'secondary', onclick: () => ctx.actions.copyPrompt(task.taskId) }, 'Copy prompt')
      : null,
    h('button', { class: 'secondary', onclick: () => ctx.actions.revealPackage(task.taskId) }, 'Show package'),
    !task.summaryOnly && taskHasAgentTurn(task)
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
      h('span', { class: `status-badge ${currentTurn ? 'submitted' : task.state}` }, taskStateLabel(task)),
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
    h(
      'div',
      { class: 'card' },
      h('h3', {}, 'Activity'),
      renderTaskTurnList(task),
      activity,
    ),
    renderTaskFollowUpComposer(ctx, task, followUpComposer),
  ].filter(Boolean);
}

module.exports = {
  applyActionLabel,
  canChangeTaskTarget,
  changedWritableRepositoryCount,
  patchMetrics,
  renderTaskDetail,
  rollbackActionLabel,
  taskHasAgentTurn,
  taskTargetValue,
};
