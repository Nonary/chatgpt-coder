const {
  formatDateTime, h, option, replace, shortCommit,
} = require('../dom');

function statusClass(change) {
  if (change.untracked) return 'untracked';
  if (change.indexStatus === 'U' || change.worktreeStatus === 'U') return 'conflicted';
  if (change.label === 'Deleted') return 'deleted';
  if (change.label === 'Added') return 'added';
  return 'modified';
}

function taskRepositoryPath(task) {
  return task?.sourceRepositoryPath || task?.repositories?.[0]?.path || '';
}

function latestGitSummaryTask(tasks, repositoryPath) {
  if (!repositoryPath) return null;
  return (Array.isArray(tasks) ? tasks : [])
    .filter((task) => task?.summaryOnly && taskRepositoryPath(task) === repositoryPath)
    .sort((left, right) => {
      const leftTime = Date.parse(left.createdAt || '') || 0;
      const rightTime = Date.parse(right.createdAt || '') || 0;
      return rightTime - leftTime;
    })[0] || null;
}

function gitSummaryPhase(task) {
  if (!task) return null;
  if (task.state === 'failed' || (task.state === 'submitted' && task.chatStatus === 'failed')) return 'failed';
  if (task.state === 'completed') return 'completed';
  if (task.state === 'ready') return 'ready';
  if (task.state === 'submitted' && task.chatStatus === 'completed') return 'finalizing';
  if (task.state === 'submitted') return 'running';
  if (task.state === 'prepared') return 'preparing';
  return task.state || 'preparing';
}

function gitSummaryIsStale(task, status) {
  if (!task || !status) return false;
  const originPath = taskRepositoryPath(task);
  const repository = (task.repositories || []).find((entry) => entry.path === originPath)
    || task.repositories?.[0];
  if (!repository) return false;
  if (Object.prototype.hasOwnProperty.call(repository, 'sourceHead')
    && repository.sourceHead !== status.repository?.baseCommit) return true;
  return Boolean(repository.snapshotFingerprint
    && status.changeFingerprint
    && repository.snapshotFingerprint !== status.changeFingerprint);
}

function fileRow(ctx, change, staged) {
  return h(
    'div',
    { class: 'row', style: { gap: '0' } },
    h('button', {
      class: 'git-file',
      style: { flex: '1' },
      onclick: () => ctx.actions.openDiff(change.path, staged),
    }, h('span', { class: 'path' }, change.path), h('span', { class: `badge ${statusClass(change)}` }, change.label?.[0] || '?')),
    h('button', {
      class: 'icon-button',
      title: staged ? 'Unstage' : 'Stage',
      onclick: () => (staged
        ? ctx.actions.gitUnstage([change.path])
        : ctx.actions.gitStage([change.path])),
    }, staged ? '−' : '＋'),
  );
}

function group(ctx, title, changes, staged, allAction) {
  return h(
    'div',
    { class: 'git-group' },
    h(
      'div',
      { class: 'git-group-header' },
      h('span', {}, title),
      h('span', { class: 'count' }, String(changes.length)),
      h('button', {
        class: 'icon-button',
        title: staged ? 'Unstage all' : 'Stage all',
        disabled: changes.length === 0,
        onclick: allAction,
      }, staged ? '−' : '＋'),
    ),
    ...changes.map((change) => fileRow(ctx, change, staged)),
    changes.length === 0 ? h('div', { class: 'empty-state', style: { border: '0' } }, 'Nothing here.') : null,
  );
}

function renderGitSummaryCard(ctx, task) {
  const phase = gitSummaryPhase(task);
  const message = task.result?.commitMessage || '';
  const stale = ['ready', 'completed'].includes(phase) && gitSummaryIsStale(task, ctx.store.state.sourceStatus);
  const repository = (task.repositories || []).find((entry) => entry.path === taskRepositoryPath(task))
    || task.repositories?.[0];
  const statusLabels = {
    preparing: 'Preparing',
    running: 'Generating',
    finalizing: 'Finishing',
    ready: 'Ready',
    completed: 'Used',
    failed: 'Generation stopped',
  };
  const statusClasses = {
    preparing: 'prepared',
    running: 'submitted',
    finalizing: 'submitted',
    ready: 'ready',
    completed: 'completed',
    failed: 'failed',
  };

  const actions = h(
    'div',
    { class: 'row wrap' },
    phase === 'failed'
      ? h('button', { class: 'primary', onclick: () => ctx.actions.generateGitSummary() }, 'Regenerate')
      : null,
    message && ['ready', 'completed'].includes(phase)
      ? h('button', {
        class: 'primary',
        onclick: () => ctx.actions.useGitSummary(task.taskId),
      }, stale ? 'Use anyway' : 'Use suggestion')
      : null,
    phase !== 'failed' && ['ready', 'completed'].includes(phase)
      ? h('button', { class: 'secondary', onclick: () => ctx.actions.generateGitSummary() }, 'Regenerate')
      : null,
  );

  if (['preparing', 'running', 'finalizing'].includes(phase)) {
    return h(
      'div',
      { class: 'card git-summary-card' },
      h(
        'div',
        { class: 'row' },
        h('span', { class: `status-badge ${statusClasses[phase]}` }, `✦ ${statusLabels[phase]}`),
        h('div', { class: 'spacer' }),
        h('button', { class: 'secondary', onclick: () => ctx.actions.showTask(task.taskId) }, 'View task'),
      ),
      h('h3', { style: { marginBottom: '4px' } }, 'Generating commit message'),
      h('p', { class: 'field-help', style: { margin: '0' } }, 'Reviewing the current Git changes. You can keep working in Source Control while this runs.'),
    );
  }

  if (phase === 'failed') {
    return h(
      'div',
      { class: 'card git-summary-card' },
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'status-badge failed' }, '✦ Generation stopped'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'secondary', onclick: () => ctx.actions.showTask(task.taskId) }, 'View task'),
      ),
      h('h3', { style: { marginBottom: '4px' } }, 'Commit message not generated'),
      h('p', { class: 'field-help', style: { margin: '0' } }, 'The Git Summary task stopped before a commit message was available. Your Source Control draft was left unchanged.'),
      actions,
    );
  }

  return h(
    'div',
    { class: `card git-summary-card ${stale ? 'stale' : ''}` },
    h(
      'div',
      { class: 'row' },
      h('span', { class: `status-badge ${statusClasses[phase] || 'ready'}` }, `✦ ${statusLabels[phase] || 'Ready'}`),
      h('div', { class: 'spacer' }),
      h('button', { class: 'secondary', onclick: () => ctx.actions.showTask(task.taskId) }, 'View task'),
    ),
    h('h3', { style: { marginBottom: '4px' } }, 'AI suggestion'),
    repository
      ? h('p', { class: 'field-help', style: { margin: '0' } }, `Based on ${repository.name || 'this repository'} changes captured at ${formatDateTime(task.createdAt)}${repository.branch ? ` · ${repository.branch}` : ''}.`)
      : null,
    message
      ? h('pre', { class: 'git-summary-preview' }, message)
      : h('p', { class: 'field-help', style: { margin: '8px 0 0' } }, 'The task is complete, but no commit message is available yet. Open the task for details.'),
    stale
      ? h('div', { class: 'git-summary-warning' }, 'Your working changes changed after this task started. This suggestion may be stale. Regenerate to analyze the latest changes.')
      : null,
    actions,
  );
}

function renderSource(ctx) {
  const { state } = ctx.store;
  const status = state.sourceStatus;
  const summaryTask = latestGitSummaryTask(state.tasks, state.sourceRepositoryPath);
  const summaryPhase = gitSummaryPhase(summaryTask);
  const summaryBusy = ['preparing', 'running', 'finalizing'].includes(summaryPhase);

  const repositorySelect = h(
    'select',
    {
      class: 'field-control',
      onchange: () => ctx.actions.selectSourceRepository(repositorySelect.value),
    },
    option('', 'Choose a repository', !state.sourceRepositoryPath),
    ...state.repositories.map((repository) => option(
      repository.path,
      repository.unavailable ? `${repository.name} · unavailable` : repository.name,
      repository.path === state.sourceRepositoryPath,
    )),
  );

  const commitMessage = h('textarea', {
    class: 'field-control',
    rows: 3,
    placeholder: 'Commit message',
    value: state.sourceCommitMessage,
    oninput: () => ctx.store.set({ sourceCommitMessage: commitMessage.value }, 'silent'),
  });

  const header = h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'row' },
      repositorySelect,
      h('button', { class: 'icon-button', title: 'Add repository', onclick: () => ctx.actions.chooseRepositories({ forSource: true }) }, '＋'),
      h('button', { class: 'icon-button', title: 'Refresh', onclick: () => ctx.actions.refreshSource() }, '↻'),
      h('button', {
        class: 'icon-button',
        title: 'Remove from workspace',
        disabled: !state.sourceRepositoryPath,
        onclick: () => ctx.actions.removeSourceRepository(),
      }, '×'),
    ),
    h('p', { class: 'field-help' }, status
      ? `${status.repository.branch} · ${status.repository.baseCommit ? shortCommit(status.repository.baseCommit) : 'no commit'}`
      : 'No repository selected'),
  );

  if (!status) {
    return [
      header,
      summaryTask ? renderGitSummaryCard(ctx, summaryTask) : h('div', { class: 'empty-state' }, 'Choose a repository to see its working changes.'),
    ];
  }

  const staged = status.changes.filter((change) => change.staged);
  const unstaged = status.changes.filter((change) => change.unstaged);

  const commitCard = h(
    'div',
    { class: 'card' },
    h('h3', {}, 'Commit'),
    commitMessage,
    h(
      'div',
      { class: 'row' },
      h('button', {
        class: 'secondary',
        disabled: summaryBusy || status.changes.length === 0,
        onclick: () => ctx.actions.generateGitSummary(),
      }, summaryBusy ? '✦ Generating…' : '✦ Generate commit message'),
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'primary',
        disabled: staged.length === 0,
        onclick: () => ctx.actions.commit(commitMessage.value),
      }, 'Commit staged changes'),
    ),
    h('p', { class: 'field-help' }, state.prompts.some((prompt) => prompt.name.trim().toLowerCase() === 'git summary')
      ? 'Using your saved “Git Summary” prompt.'
      : 'Using the built-in Git Summary prompt. Save a prompt named “Git Summary” to customize it.'),
  );

  const history = h(
    'div',
    { class: 'card' },
    h('h3', {}, 'Recent commits'),
    h('div', { class: 'list' }, ...(status.history || []).map((commit) => h(
      'div',
      { class: 'list-item' },
      h(
        'span',
        { class: 'grow' },
        h('span', { class: 'title' }, commit.subject),
        h('span', { class: 'subtitle' }, `${commit.shortCommit} · ${commit.author} · ${formatDateTime(commit.authoredAt)}`),
      ),
    ))),
  );

  return [
    header,
    commitCard,
    summaryTask ? renderGitSummaryCard(ctx, summaryTask) : null,
    group(ctx, 'Staged changes', staged, true, () => ctx.actions.gitUnstageAll()),
    group(ctx, 'Changes', unstaged, false, () => ctx.actions.gitStageAll()),
    history,
  ];
}

function renderDiffOverlay(ctx, diff) {
  const rows = h('div', { class: `diff-compare ${diff.binary ? 'single' : ''}` });
  if (diff.binary || !diff.rows?.length) {
    replace(rows, h('div', { class: 'diff-side' }, h('div', { class: 'diff-row' }, h('span', { class: 'gutter' }, ''), h('span', {}, diff.content))));
  } else {
    const before = h('div', { class: 'diff-side' });
    const after = h('div', { class: 'diff-side' });
    for (const row of diff.rows) {
      before.append(h(
        'div',
        { class: `diff-row ${row.beforeType}` },
        h('span', { class: 'gutter' }, row.beforeNumber ?? ''),
        h('span', {}, row.beforeText),
      ));
      after.append(h(
        'div',
        { class: `diff-row ${row.afterType}` },
        h('span', { class: 'gutter' }, row.afterNumber ?? ''),
        h('span', {}, row.afterText),
      ));
    }
    replace(rows, before, after);
  }

  return h(
    'div',
    { class: 'diff-overlay' },
    h(
      'div',
      { class: 'diff-header' },
      h('div', {}, h('strong', {}, diff.path), h('span', { class: 'field-help' }, `${diff.beforeLabel} → ${diff.afterLabel}`)),
      h('div', { class: 'spacer', style: { flex: '1' } }),
      diff.truncated ? h('span', { class: 'field-help' }, 'Preview truncated') : null,
      h('button', { class: 'icon-button', title: 'Close diff', onclick: () => ctx.actions.closeDiff() }, '×'),
    ),
    h('div', { class: 'diff-body' }, rows),
  );
}

module.exports = {
  gitSummaryIsStale,
  gitSummaryPhase,
  latestGitSummaryTask,
  renderDiffOverlay,
  renderSource,
  taskRepositoryPath,
};
