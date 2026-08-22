const { h, option, replace } = require('../dom');

function openComposerSettings({ ctx, newTreeValue, newProjectValue }) {
  const body = h('div', { class: 'composer-settings' });

  const treeSelect = h('select', { class: 'field-control' });
  const treeNameInput = h('input', {
    type: 'text',
    class: 'field-control',
    maxlength: 80,
    placeholder: 'For example: Modern source control',
  });
  const treeNameRow = h(
    'label',
    { class: 'field' },
    h('span', {}, 'Tree name'),
    treeNameInput,
  );

  const repositoryList = h('div', { class: 'list composer-settings-list' });
  const projectSelect = h('select', { class: 'field-control' });
  const newProjectName = h('input', {
    type: 'text',
    class: 'field-control',
    maxlength: 100,
    placeholder: 'For example: Coding tasks',
  });
  const newProjectRow = h(
    'label',
    { class: 'field' },
    h('span', {}, 'New project name'),
    newProjectName,
  );
  const iacCount = () => (ctx.store.state.iac.selectors || []).length;
  const iacCheckbox = h('input', { type: 'checkbox' });
  const repositoryStatus = h('span', { class: 'field-help' }, '');

  const sync = () => {
    const { state } = ctx.store;
    const { composer } = state;

    replace(
      treeSelect,
      option('', 'No coding tree · use current working changes', composer.treeSelection === ''),
      option(newTreeValue, 'Create a new coding tree', composer.treeSelection === newTreeValue),
      ...state.trees
        .filter((tree) => tree.available && tree.mergeState !== 'submitted')
        .map((tree) => option(
          tree.id,
          `${tree.name} · ${tree.repositoryName}`,
          composer.treeSelection === tree.id,
        )),
    );
    treeSelect.value = composer.treeSelection;
    treeNameInput.value = composer.treeName;
    treeNameRow.hidden = composer.treeSelection !== newTreeValue;

    replace(
      repositoryList,
      ...composer.repositories.map((repository) => h(
        'div',
        { class: 'list-item' },
        h(
          'span',
          { class: 'grow' },
          h('span', { class: 'title' }, repository.name),
          h('span', { class: 'subtitle' }, `${repository.branch || 'no branch'} · ${repository.path}`),
        ),
        h('button', {
          class: 'icon-button',
          title: `Remove ${repository.name} from current work`,
          type: 'button',
          onclick: () => ctx.actions.removeRepositoryFromScope(repository.path, { onDone: sync }),
        }, '×'),
      )),
      composer.repositories.length === 0
        ? h('div', { class: 'empty-state' }, 'Add at least one Git repository.')
        : null,
    );
    repositoryStatus.textContent = composer.repositories.length === 0
      ? 'The task must target at least one Git repository unless you create a coding tree.'
      : `${composer.repositories.length} repositor${composer.repositories.length === 1 ? 'y' : 'ies'} selected.`;

    replace(
      projectSelect,
      option('', 'New chat (no project)', composer.projectSelection === ''),
      option(newProjectValue, 'Create a new project', composer.projectSelection === newProjectValue),
      ...state.projects.map((project) => option(
        project.id,
        project.name,
        composer.projectSelection === project.id,
      )),
    );
    projectSelect.value = composer.projectSelection;
    newProjectName.value = composer.newProjectName;
    newProjectRow.hidden = composer.projectSelection !== newProjectValue;

    const count = iacCount();
    iacCheckbox.checked = composer.includeIac && count > 0;
    iacCheckbox.disabled = !state.iac.exists || count === 0;
  };

  treeSelect.addEventListener('change', () => {
    ctx.store.setComposer({ treeSelection: treeSelect.value });
    ctx.persist('task-tree', treeSelect.value);
    sync();
  });
  treeNameInput.addEventListener('input', () => ctx.store.setComposer({ treeName: treeNameInput.value }, 'silent'));

  const addRepository = h('button', {
    class: 'secondary',
    type: 'button',
    onclick: () => ctx.actions.manageRepositoryScope({ onDone: sync }),
  }, 'Manage repositories');

  projectSelect.addEventListener('change', () => {
    ctx.store.setComposer({ projectSelection: projectSelect.value });
    ctx.persist('task-project', projectSelect.value);
    sync();
  });
  newProjectName.addEventListener('input', () => ctx.store.setComposer({ newProjectName: newProjectName.value }, 'silent'));

  const refreshProjects = h('button', {
    class: 'secondary',
    type: 'button',
    onclick: async () => {
      refreshProjects.disabled = true;
      try {
        await ctx.actions.refreshProjects(true);
        sync();
      } finally {
        refreshProjects.disabled = false;
      }
    },
  }, 'Refresh');

  iacCheckbox.addEventListener('change', () => {
    ctx.store.setComposer({ includeIac: iacCheckbox.checked }, 'silent');
    ctx.persist('task-iac', String(iacCheckbox.checked));
  });

  replace(
    body,
    h('section', { class: 'composer-settings-section' },
      h('div', { class: 'composer-settings-heading' },
        h('div', {}, h('p', { class: 'eyebrow' }, 'Target'), h('strong', {}, 'Coding workspace')),
        h('span', { class: 'field-help' }, 'Repository scope is shared with Source Control. Coding tree selection still applies only to this task.'),
      ),
      h('label', { class: 'field' }, h('span', {}, 'Coding tree'), treeSelect),
      treeNameRow,
      h('div', { class: 'row' },
        h('span', { class: 'eyebrow' }, 'Repositories'),
        h('div', { class: 'spacer' }),
        addRepository,
      ),
      repositoryList,
      repositoryStatus,
    ),
    h('section', { class: 'composer-settings-section' },
      h('div', { class: 'composer-settings-heading' },
        h('div', {}, h('p', { class: 'eyebrow' }, 'Destination'), h('strong', {}, 'ChatGPT project')),
        h('span', { class: 'field-help' }, 'Choose where the conversation should run. A new project is created when the task is sent.'),
      ),
      h('div', { class: 'row composer-settings-inline' },
        h('label', { class: 'field composer-settings-grow' }, h('span', {}, 'Project'), projectSelect),
        h('div', { class: 'composer-settings-action' }, refreshProjects),
      ),
      newProjectRow,
      h('p', { class: 'field-help' }, 'Results are validated against the task base before anything is applied.'),
    ),
    h('section', { class: 'composer-settings-section' },
      h('div', { class: 'composer-settings-heading' },
        h('div', {}, h('p', { class: 'eyebrow' }, 'Context'), h('strong', {}, 'Infrastructure repositories')),
        h('span', { class: 'field-help' }, 'Keep the existing read-only IaC context behavior used by task packaging.'),
      ),
      h('label', { class: 'row', style: { gap: '8px' } },
        iacCheckbox,
        h('span', { class: 'field-help' }, iacCount()
          ? `Include ${iacCount()} configured infrastructure repositor${iacCount() === 1 ? 'y' : 'ies'} as read-only context`
          : 'No IaC repositories are configured in settings.json'),
      ),
    ),
  );

  const handle = ctx.shell.modal({
    title: 'Composer configuration',
    width: 'min(680px, calc(100vw - 48px))',
    body,
    footer: [
      h('span', { class: 'field-help' }, 'Prompt, skills, attachments, and Ask/Agent remain in the composer.'),
      h('div', { class: 'spacer' }),
      h('button', { class: 'primary', type: 'button', onclick: () => handle.close() }, 'Done'),
    ],
  });

  const originalClose = handle.close;
  let closed = false;
  handle.close = () => {
    if (closed) return;
    closed = true;
    originalClose();
    ctx.renderActiveView();
  };
  handle.backdrop.addEventListener('click', (event) => {
    if (event.target === handle.backdrop) requestAnimationFrame(() => ctx.renderActiveView());
  });

  sync();
  return handle;
}

module.exports = { openComposerSettings };
