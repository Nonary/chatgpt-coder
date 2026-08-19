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

function renderSource(ctx) {
  const { state } = ctx.store;
  const status = state.sourceStatus;

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
    return [header, h('div', { class: 'empty-state' }, 'Choose a repository to see its working changes.')];
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
        onclick: () => ctx.actions.generateGitSummary(),
      }, '✦ AI summary'),
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

module.exports = { renderDiffOverlay, renderSource };
