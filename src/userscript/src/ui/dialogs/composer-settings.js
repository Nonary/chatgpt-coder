const { h, option, replace } = require('../dom');

function repositoryAccess(repository) {
  return repository?.access === 'context' || repository?.readOnly === true ? 'context' : 'edit';
}

function normalizePath(value) {
  const path = String(value || '').replaceAll('\\', '/').replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(path) ? path.toLowerCase() : path;
}

function openComposerSettings({ ctx, newTreeValue, newProjectValue }) {
  const body = h('div', { class: 'composer-settings' });
  const submoduleCatalogs = new Map();
  let submoduleLoading = false;
  let submoduleLoadVersion = 0;

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
  const treeWarning = h('p', { class: 'workspace-warning', hidden: true },
    'Coding trees currently support one editable repository. Use the current checkouts for this multi-repository task, or mark the other repositories as Context.');

  const repositoryList = h('div', { class: 'list composer-settings-list workspace-repository-list' });
  const repositoryStatus = h('span', { class: 'field-help' }, '');
  const submoduleModes = h('div', { class: 'workspace-mode-group' });
  const submoduleStatus = h('span', { class: 'field-help' }, 'Checking Git submodules…');
  const submoduleList = h('div', { class: 'list workspace-submodule-list', hidden: true });
  const submoduleBulkRow = h('div', { class: 'row workspace-submodule-bulk', hidden: true });
  const bulkAccessSelect = h(
    'select',
    { class: 'field-control workspace-access-select', title: 'Set access for included submodules' },
    option('context', 'Context'),
    option('edit', 'Edit'),
  );

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

  const allSubmodules = () => [...submoduleCatalogs.values()]
    .flatMap((catalog) => (catalog.submodules || []).map((submodule) => ({
      ...submodule,
      rootRepository: catalog.repository,
    })));

  const submoduleSelection = (key) => (
    ctx.store.state.composer.submodules?.selections?.[key] || {}
  );

  const updateSubmoduleSelection = (key, patch) => {
    const current = ctx.store.state.composer.submodules || { mode: 'none', selections: {} };
    ctx.store.setComposer({
      submodules: {
        ...current,
        selections: {
          ...(current.selections || {}),
          [key]: {
            ...(current.selections?.[key] || {}),
            ...patch,
          },
        },
      },
    }, 'silent');
    sync();
  };

  const includedSubmodules = () => {
    const config = ctx.store.state.composer.submodules || { mode: 'none', selections: {} };
    if (config.mode === 'none') return [];
    return allSubmodules().filter((submodule) => {
      if (!submodule.available) return false;
      if (config.mode === 'all') return true;
      return submoduleSelection(submodule.selectionKey).included === true;
    });
  };

  const workspaceCounts = () => {
    const repositories = new Map();
    for (const repository of ctx.store.state.composer.repositories) {
      repositories.set(normalizePath(repository.path), repositoryAccess(repository));
    }
    for (const submodule of includedSubmodules()) {
      const key = normalizePath(submodule.repositoryPath);
      const access = submoduleSelection(submodule.selectionKey).access === 'edit' ? 'edit' : 'context';
      if (repositories.get(key) !== 'edit') repositories.set(key, access);
    }
    return {
      total: repositories.size,
      edit: [...repositories.values()].filter((access) => access === 'edit').length,
      context: [...repositories.values()].filter((access) => access === 'context').length,
    };
  };

  const updateSubmoduleSummary = () => {
    const current = ctx.store.state.composer.submodules || { mode: 'none', selections: {} };
    const counts = workspaceCounts();
    const available = allSubmodules().filter((submodule) => submodule.available).length;
    const unavailable = allSubmodules().length - available;
    const included = includedSubmodules().length;
    const summary = {
      available,
      unavailable,
      included,
      workspaceTotal: counts.total,
      editable: counts.edit,
      context: counts.context,
    };
    const previous = current.summary || {};
    if (JSON.stringify(previous) !== JSON.stringify(summary)) {
      ctx.store.setComposer({ submodules: { ...current, summary } }, 'silent');
    }
  };

  const sync = () => {
    const { state } = ctx.store;
    const { composer } = state;
    const askMode = composer.mode === 'ask';

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
      ...composer.repositories.map((repository) => {
        const accessSelect = h(
          'select',
          {
            class: 'field-control workspace-access-select',
            disabled: askMode,
            title: askMode ? 'Ask tasks are read-only. Agent access is preserved.' : `Access for ${repository.name}`,
            onchange: () => {
              ctx.store.setComposer({
                repositories: ctx.store.state.composer.repositories.map((item) => (
                  item.path === repository.path ? { ...item, access: accessSelect.value } : item
                )),
              }, 'silent');
              sync();
            },
          },
          option('edit', 'Edit', repositoryAccess(repository) === 'edit'),
          option('context', 'Context', repositoryAccess(repository) === 'context'),
        );
        accessSelect.value = repositoryAccess(repository);
        return h(
          'div',
          { class: 'list-item workspace-repository-row' },
          h(
            'span',
            { class: 'grow' },
            h('span', { class: 'title' }, repository.name),
            h('span', { class: 'subtitle' }, `${repository.branch || 'no branch'} · ${repository.path}`),
          ),
          accessSelect,
          h('button', {
            class: 'icon-button',
            title: `Remove ${repository.name}`,
            type: 'button',
            onclick: () => ctx.actions.removeRepositoryFromScope(repository.path, {
              onDone: () => {
                submoduleCatalogs.delete(repository.path);
                sync();
              },
            }),
          }, '×'),
        );
      }),
      composer.repositories.length === 0
        ? h('div', { class: 'empty-state' }, 'Add at least one Git repository.')
        : null,
    );

    const config = composer.submodules || { mode: 'none', selections: {} };
    replace(
      submoduleModes,
      ...[
        ['none', 'None'],
        ['all', 'All'],
        ['select', 'Select'],
      ].map(([value, label]) => h('button', {
        type: 'button',
        class: `workspace-mode-button${config.mode === value ? ' active' : ''}`,
        'aria-pressed': String(config.mode === value),
        onclick: () => {
          ctx.store.setComposer({ submodules: { ...config, mode: value } }, 'silent');
          sync();
        },
      }, label)),
    );

    const discovered = allSubmodules();
    const discoveryErrors = [...submoduleCatalogs.values()].filter((catalog) => catalog.error);
    const available = discovered.filter((submodule) => submodule.available);
    const included = includedSubmodules();
    const editableSubmodules = included.filter(
      (submodule) => submoduleSelection(submodule.selectionKey).access === 'edit',
    );
    const unavailableCount = discovered.length - available.length;
    submoduleStatus.textContent = submoduleLoading
      ? 'Checking Git submodules…'
      : discoveryErrors.length > 0
        ? `Could not inspect submodules for ${discoveryErrors.map((catalog) => catalog.repository?.name || 'a repository').join(', ')}.`
        : discovered.length === 0
          ? 'No submodules were found in the selected repositories.'
          : `${included.length} of ${available.length} available included`
            + `${editableSubmodules.length ? ` · ${editableSubmodules.length} editable` : ''}`
            + `${unavailableCount ? ` · ${unavailableCount} not initialized` : ''}.`;

    submoduleList.hidden = config.mode !== 'select';
    replace(
      submoduleList,
      ...discovered.map((submodule) => {
        const selection = submoduleSelection(submodule.selectionKey);
        const checked = selection.included === true;
        const checkbox = h('input', {
          type: 'checkbox',
          checked,
          disabled: !submodule.available,
          onchange: () => updateSubmoduleSelection(submodule.selectionKey, { included: checkbox.checked }),
        });
        const access = selection.access === 'edit' ? 'edit' : 'context';
        const accessSelect = h(
          'select',
          {
            class: 'field-control workspace-access-select',
            disabled: askMode || !submodule.available || !checked,
            onchange: () => updateSubmoduleSelection(submodule.selectionKey, { access: accessSelect.value }),
          },
          option('context', 'Context', access === 'context'),
          option('edit', 'Edit', access === 'edit'),
        );
        accessSelect.value = access;
        return h(
          'div',
          {
            class: `list-item workspace-submodule-row${submodule.available ? '' : ' unavailable'}`,
            style: { paddingLeft: `${8 + (submodule.depth || 0) * 18}px` },
          },
          checkbox,
          h(
            'span',
            { class: 'grow' },
            h('span', { class: 'title' }, submodule.path),
            h(
              'span',
              { class: 'subtitle' },
              submodule.available
                ? `${submodule.rootRepository?.name || 'Repository'} · ${String(submodule.recordedCommit || '').slice(0, 12) || 'no recorded commit'}`
                : `${submodule.rootRepository?.name || 'Repository'} · Not initialized`,
            ),
          ),
          submodule.available ? accessSelect : h('span', { class: 'workspace-unavailable' }, 'Unavailable'),
        );
      }),
      config.mode === 'select' && discovered.length === 0 && !submoduleLoading
        ? h('div', { class: 'empty-state' }, 'No submodules are available to select.')
        : null,
    );

    submoduleBulkRow.hidden = config.mode === 'none' || available.length === 0;
    bulkAccessSelect.disabled = askMode;
    if (included.length > 0 && editableSubmodules.length === included.length) bulkAccessSelect.value = 'edit';
    else bulkAccessSelect.value = 'context';

    const counts = workspaceCounts();
    repositoryStatus.textContent = composer.repositories.length === 0
      ? 'The task must target at least one Git repository unless you create a coding tree.'
      : askMode
        ? `${counts.total} repositor${counts.total === 1 ? 'y' : 'ies'} in workspace · Ask tasks are read-only. Agent access: ${counts.edit} editable · ${counts.context} context.`
        : `${counts.total} repositor${counts.total === 1 ? 'y' : 'ies'} in workspace · ${counts.edit} editable · ${counts.context} context.`;
    treeWarning.hidden = !composer.treeSelection || counts.edit === 1;

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
    updateSubmoduleSummary();
  };

  const loadSubmodules = async () => {
    const version = ++submoduleLoadVersion;
    const repositories = [...ctx.store.state.composer.repositories];
    submoduleLoading = true;
    sync();
    const catalogs = await Promise.all(repositories.map(async (repository) => {
      try {
        return [repository.path, await ctx.api.submodules(repository.path)];
      } catch (error) {
        return [repository.path, {
          repository,
          submodules: [],
          error: error.message,
        }];
      }
    }));
    if (version !== submoduleLoadVersion) return;
    for (const [repositoryPath, catalog] of catalogs) submoduleCatalogs.set(repositoryPath, catalog);
    const currentPaths = new Set(ctx.store.state.composer.repositories.map((repository) => repository.path));
    for (const repositoryPath of [...submoduleCatalogs.keys()]) {
      if (!currentPaths.has(repositoryPath)) submoduleCatalogs.delete(repositoryPath);
    }
    submoduleLoading = false;
    sync();
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
    onclick: () => ctx.actions.manageRepositoryScope({
      onDone: () => {
        sync();
        loadSubmodules().catch(() => {});
      },
    }),
  }, 'Manage repositories');

  bulkAccessSelect.addEventListener('change', () => {
    const current = ctx.store.state.composer.submodules || { mode: 'none', selections: {} };
    const selections = { ...(current.selections || {}) };
    for (const submodule of allSubmodules().filter((item) => item.available)) {
      selections[submodule.selectionKey] = {
        ...(selections[submodule.selectionKey] || {}),
        access: bulkAccessSelect.value,
      };
    }
    ctx.store.setComposer({ submodules: { ...current, selections } }, 'silent');
    sync();
  });

  replace(
    submoduleBulkRow,
    h('span', { class: 'field-help' }, 'All included as'),
    bulkAccessSelect,
  );

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
        h('span', { class: 'field-help' }, 'Repository scope is shared with Source Control. Choose Edit or Context for this task; coding tree selection applies only to this task.'),
      ),
      h('label', { class: 'field' }, h('span', {}, 'Coding tree'), treeSelect),
      treeNameRow,
      treeWarning,
      h('div', { class: 'row' },
        h('span', { class: 'eyebrow' }, 'Repositories'),
        h('div', { class: 'spacer' }),
        addRepository,
      ),
      repositoryList,
      repositoryStatus,
      ctx.store.state.composer.mode === 'ask'
        ? h('p', { class: 'field-help workspace-readonly-note' }, 'Ask tasks are read-only. Edit/Context choices are preserved for Agent mode.')
        : null,
      h('hr', { class: 'divider' }),
      h('div', { class: 'row workspace-submodule-heading' },
        h('div', {}, h('span', { class: 'eyebrow' }, 'Submodules')),
        h('div', { class: 'spacer' }),
        submoduleModes,
      ),
      submoduleStatus,
      submoduleBulkRow,
      submoduleList,
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
    width: 'min(760px, calc(100vw - 48px))',
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
  loadSubmodules().catch(() => {});
  return handle;
}

module.exports = { openComposerSettings, repositoryAccess };
