const { h, option } = require('../dom');
const { treeStateLabel } = require('../labels');

function renderTrees(ctx) {
  const { state } = ctx.store;

  const projectSelect = h(
    'select',
    { class: 'field-control' },
    option('', 'New chat (no project)'),
    ...state.projects.map((project) => option(project.id, project.name)),
  );

  const header = h(
    'div',
    { class: 'card' },
    h('h3', {}, 'Coding trees'),
    h('p', { class: 'field-help' }, 'A tree runs in a real Git worktree on its own patchwork/… branch. Results are committed there, never in the original checkout.'),
    h(
      'div',
      { class: 'row' },
      h('label', { class: 'field', style: { flex: '1' } }, h('span', {}, 'Merge destination'), projectSelect),
      h('button', {
        class: 'icon-button',
        style: { alignSelf: 'flex-end' },
        title: 'Refresh projects',
        onclick: () => ctx.actions.refreshProjects(true),
      }, '↻'),
    ),
    h('button', { class: 'primary wide', onclick: () => ctx.actions.startTreeTask() }, '＋ New coding tree'),
  );

  if (state.trees.length === 0) {
    return [header, h('div', { class: 'empty-state' }, 'No coding trees yet. Create one from the task composer.')];
  }

  const list = state.trees.map((tree) => {
    const project = tree.chatgptProject?.name ? ` · ${tree.chatgptProject.name}` : '';
    return h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'row' },
        h(
          'div',
          { class: 'grow', style: { minWidth: '0', flex: '1' } },
          h('strong', {}, tree.name),
          h('span', { class: 'field-help' }, `${tree.repositoryName} · ${tree.branch || 'no branch'}${project}`),
        ),
        h('span', { class: `status-badge ${tree.mergeState === 'failed' ? 'conflicted' : tree.mergeState === 'submitted' ? 'submitted' : 'prepared'}` }, treeStateLabel(tree)),
      ),
      tree.mergeError ? h('div', { class: 'banner error' }, tree.mergeError) : null,
      h('p', { class: 'field-help' }, `${tree.taskIds?.length || 0} task${(tree.taskIds?.length || 0) === 1 ? '' : 's'} · ${tree.path}`),
      h(
        'div',
        { class: 'row wrap' },
        h('button', {
          class: 'secondary',
          disabled: !tree.available || tree.mergeState === 'submitted',
          onclick: () => ctx.actions.startTreeTask(tree.id),
        }, 'Continue in tree'),
        h('button', {
          class: 'secondary',
          onclick: () => ctx.actions.inspectTreeInSource(tree),
        }, 'Source control'),
        h('button', {
          class: 'secondary',
          onclick: () => ctx.actions.revealTree(tree.id),
        }, 'Reveal'),
        tree.mergeState === 'failed'
          ? h('button', { class: 'primary', onclick: () => ctx.actions.resolveTreeMerge(tree.id) }, 'Resolve in a new chat')
          : h('button', {
            class: 'primary',
            disabled: !tree.available || !tree.clean || (tree.commitCount || 0) === 0 || tree.mergeState === 'submitted',
            onclick: () => ctx.actions.mergeTree(tree.id, projectSelect.value),
          }, 'Merge tree'),
        h('button', { class: 'danger', onclick: () => ctx.actions.removeTree(tree.id) }, 'Discard'),
      ),
    );
  });

  return [header, ...list];
}

module.exports = { renderTrees };
