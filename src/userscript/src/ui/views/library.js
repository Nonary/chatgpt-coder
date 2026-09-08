const { h, replace } = require('../dom');

const USER_PROVIDERS = [
  'Claude Code',
  'Codex',
  'GitHub Copilot',
  'Agent Skills',
];

const PROJECT_PROVIDERS = [
  'Claude Code',
  'Codex',
  'GitHub Copilot',
  'Agent Skills',
];

const TABS = [
  { id: 'prompts', label: 'Prompts' },
  { id: 'skills', label: 'Skills' },
];

function repositoryPaths(ctx) {
  return ctx.store.state.repositoryScopePaths.filter(Boolean);
}

function emptyDraft(type, ctx) {
  if (type === 'prompts') {
    return {
      type,
      id: null,
      name: '',
      description: '',
      content: '',
      enabled: true,
      loading: false,
      error: '',
    };
  }
  return {
    type,
    id: null,
    name: '',
    description: '',
    content: '',
    enabled: true,
    scope: 'user',
    provider: USER_PROVIDERS.includes('Codex') ? 'Codex' : USER_PROVIDERS[0],
    repositoryPath: repositoryPaths(ctx)[0] || '',
    loading: false,
    error: '',
    writable: true,
  };
}

function itemEnabled(item) {
  return item?.enabled !== false;
}

function itemSummary(item) {
  return item.description || (item.content || '').replace(/\s+/g, ' ').trim().slice(0, 140) || 'No description.';
}

function createLibraryView(ctx) {
  const root = ctx.shell.view('library');
  let tab = 'prompts';
  let filter = 'all';
  let searchTerm = '';
  let prompts = [];
  let skills = [];
  let draft = null;
  let requestGeneration = 0;
  let busy = false;
  let error = '';

  const stateItems = () => (tab === 'prompts' ? prompts : skills);

  const saveStore = () => {
    ctx.store.set({ prompts, skills }, 'silent');
  };

  const render = () => {
    const items = stateItems();
    const query = searchTerm.trim().toLowerCase();
    const filtered = items.filter((item) => {
      if (filter === 'enabled' && !itemEnabled(item)) return false;
      if (filter === 'disabled' && itemEnabled(item)) return false;
      if (!query) return true;
      return `${item.name} ${item.description} ${item.provider} ${item.location}`.toLowerCase().includes(query);
    });

    const tabButtons = h('div', { class: 'library-tabs', role: 'tablist', 'aria-label': 'Library type' },
      ...TABS.map((entry) => h(
        'button',
        {
          class: `library-tab ${entry.id === tab ? 'active' : ''}`,
          type: 'button',
          role: 'tab',
          'aria-selected': entry.id === tab ? 'true' : 'false',
          onclick: () => {
            tab = entry.id;
            filter = 'all';
            searchTerm = '';
            draft = null;
            error = '';
            render();
          },
        },
        entry.label,
      )),
    );

    const search = h('input', {
      type: 'search',
      class: 'field-control library-search',
      placeholder: `Search ${tab}`,
      value: searchTerm,
      oninput: (event) => {
        searchTerm = event.target.value;
        render();
        requestAnimationFrame(() => root.querySelector('.library-search')?.focus());
      },
    });

    const filterSelect = h('select', {
      class: 'library-filter',
      value: filter,
      onchange: (event) => {
        filter = event.target.value;
        render();
      },
    },
    h('option', { value: 'all', selected: filter === 'all' }, 'All'),
    h('option', { value: 'enabled', selected: filter === 'enabled' }, 'Enabled'),
    h('option', { value: 'disabled', selected: filter === 'disabled' }, 'Disabled'));

    const toolbar = h('div', { class: 'library-toolbar row wrap' },
      search,
      filterSelect,
      h('div', { class: 'spacer' }),
      h('button', { class: 'secondary', type: 'button', disabled: busy, onclick: () => refresh() }, 'Refresh'),
      h('button', { class: 'primary', type: 'button', disabled: busy, onclick: () => startNew(tab) }, `＋ New ${tab === 'prompts' ? 'prompt' : 'skill'}`),
    );

    const summary = h('div', { class: 'row' },
      h('span', { class: 'field-help' }, `${items.length} ${tab === 'prompts' ? 'prompt' : 'skill'}${items.length === 1 ? '' : 's'}`),
      h('div', { class: 'spacer' }),
      h('span', { class: 'field-help' }, `${items.filter(itemEnabled).length} shown in /`),
    );

    const list = h('div', { class: 'library-list' });
    if (filtered.length === 0) {
      list.append(h('div', { class: 'empty-state' }, items.length === 0
        ? `No ${tab} are available yet. Create one to add reusable ${tab === 'prompts' ? 'instructions' : 'capabilities'}.`
        : 'Nothing matches the current search and filter.'));
    } else {
      for (const item of filtered) list.append(renderItem(item));
    }

    const body = h('div', {}, tabButtons, toolbar, summary, list, draft ? renderEditor() : null);
    if (error) body.append(h('div', { class: 'banner error' }, error));
    replace(root, body);
  };

  const renderItem = (item) => {
    const enabled = itemEnabled(item);
    const toggle = h('input', {
      type: 'checkbox',
      checked: enabled,
      'aria-label': `${enabled ? 'Disable' : 'Enable'} ${item.name}`,
      onchange: () => toggleEnabled(item, !enabled),
    });
    const actionRow = h('div', { class: 'row' },
      h('button', { class: 'secondary library-action', type: 'button', disabled: busy, onclick: () => editItem(item) }, 'Edit'),
      h('button', { class: 'danger library-action', type: 'button', disabled: busy || (tab === 'skills' && item.writable === false), onclick: () => deleteItem(item) }, 'Delete'),
    );
    const metadata = tab === 'prompts'
      ? itemSummary(item)
      : `${itemSummary(item)} · ${item.location || item.provider || 'Local skill'}${item.writable === false ? ' · Linked' : ''}`;
    return h(
      'div',
      { class: `library-item ${enabled ? '' : 'disabled'}` },
      h('label', { class: 'library-enable' }, toggle, h('span', {}, enabled ? 'On' : 'Off')),
      h('div', { class: 'library-item-copy grow' },
        h('div', { class: 'title' }, item.name),
        h('div', { class: 'subtitle', style: { whiteSpace: 'normal' } }, metadata),
      ),
      actionRow,
    );
  };

  const repositories = () => repositoryPaths(ctx);

  function syncDraftRepositories() {
    if (!draft || draft.type !== 'skills') return;
    const current = repositories();
    if (draft.repositoryPath && current.includes(draft.repositoryPath)) return;
    draft.repositoryPath = current[0] || '';
  }

  function renderEditor() {
    syncDraftRepositories();
    if (draft.loading) return h('div', { class: 'card' }, h('p', { class: 'field-help' }, 'Loading skill…'));
    const typeLabel = draft.type === 'prompts' ? 'prompt' : 'skill';
    const title = draft.id ? `Edit ${typeLabel}` : `Create ${typeLabel}`;
    const nameInput = h('input', {
      type: 'text', class: 'field-control', maxlength: draft.type === 'prompts' ? 60 : 100,
      value: draft.name, placeholder: draft.type === 'prompts' ? 'For example: Architecture review' : 'For example: Code review',
      oninput: (event) => { draft.name = event.target.value; },
    });
    const descriptionInput = h('input', {
      type: 'text', class: 'field-control', maxlength: 140,
      value: draft.description, placeholder: 'A concise description shown in the slash menu',
      oninput: (event) => { draft.description = event.target.value; },
    });
    const contentInput = h('textarea', {
      class: 'field-control', rows: 12,
      value: draft.content,
      placeholder: draft.type === 'prompts'
        ? 'Write the reusable prompt instructions.'
        : 'Write the SKILL.md instructions that an agent should follow when this skill is relevant.',
      oninput: (event) => { draft.content = event.target.value; },
    });
    const enabledInput = h('input', {
      type: 'checkbox', checked: itemEnabled(draft),
      onchange: (event) => { draft.enabled = event.target.checked; },
    });

    const fields = [
      h('label', { class: 'field' }, h('span', {}, 'Name'), nameInput),
      h('label', { class: 'field' }, h('span', {}, 'Description'), descriptionInput),
    ];

    if (draft.type === 'skills' && !draft.id) {
      const scope = h('select', {
        class: 'field-control', value: draft.scope,
        onchange: (event) => {
          draft.scope = event.target.value;
          const providerOptions = draft.scope === 'project' ? PROJECT_PROVIDERS : USER_PROVIDERS;
          if (!providerOptions.includes(draft.provider)) draft.provider = providerOptions[0];
          render();
        },
      },
      h('option', { value: 'user', selected: draft.scope === 'user' }, 'Personal'),
      h('option', { value: 'project', selected: draft.scope === 'project', disabled: repositories().length === 0 }, 'Project'));
      const providers = draft.scope === 'project' ? PROJECT_PROVIDERS : USER_PROVIDERS;
      const provider = h('select', {
        class: 'field-control', value: draft.provider,
        onchange: (event) => { draft.provider = event.target.value; },
      }, ...providers.map((value) => h('option', { value, selected: value === draft.provider }, value)));
      fields.push(
        h('label', { class: 'field' }, h('span', {}, 'Scope'), scope),
        h('label', { class: 'field' }, h('span', {}, 'Skill provider'), provider),
      );
      if (draft.scope === 'project') {
        const repository = h('select', {
          class: 'field-control', value: draft.repositoryPath,
          onchange: (event) => { draft.repositoryPath = event.target.value; },
        }, ...repositories().map((path) => {
          const repo = ctx.store.state.repositories.find((item) => item.path === path);
          return h('option', { value: path, selected: path === draft.repositoryPath }, repo?.name || path);
        }));
        fields.push(h('label', { class: 'field' }, h('span', {}, 'Project repository'), repository));
      }
    } else if (draft.type === 'skills') {
      fields.push(h('div', { class: 'row wrap' },
        h('span', { class: 'status-badge' }, `${draft.scope === 'project' ? 'Project' : 'Personal'} · ${draft.provider}`),
        draft.writable === false ? h('span', { class: 'field-help' }, 'Linked skills are read-only in this editor.') : null,
      ));
    }

    const form = h('form', { class: 'card library-editor' },
      h('div', { class: 'row' },
        h('div', {}, h('p', { class: 'eyebrow' }, 'Library item'), h('strong', {}, title)),
        h('div', { class: 'spacer' }),
        h('button', { class: 'icon-button', type: 'button', onclick: () => { draft = null; render(); } }, '×'),
      ),
      ...fields,
      h('label', { class: 'field' }, h('span', {}, 'Instructions'), contentInput),
      h('label', { class: 'library-check' }, enabledInput, h('span', {}, 'Show in the / slash menu')),
      draft.error ? h('div', { class: 'banner error' }, draft.error) : null,
      h('div', { class: 'row' },
        h('span', { class: 'field-help' }, draft.type === 'prompts'
          ? 'Prompt text is stored as Markdown in the agent-managed prompt library.'
          : 'Skill text is stored as SKILL.md in the selected skill root.'),
        h('div', { class: 'spacer' }),
        draft.id ? h('button', { class: 'danger', type: 'button', disabled: busy || draft.writable === false, onclick: () => deleteItem(draft) }, 'Delete') : null,
        h('button', { class: 'secondary', type: 'button', disabled: busy, onclick: () => { draft = null; render(); } }, 'Cancel'),
        h('button', { class: 'primary', type: 'submit', disabled: busy || draft.writable === false }, draft.id ? 'Save changes' : `Create ${typeLabel}`),
      ),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      saveDraft();
    });
    return form;
  }

  async function refresh() {
    const generation = ++requestGeneration;
    busy = true;
    error = '';
    render();
    try {
      const paths = repositories();
      const [promptResult, skillResult] = await Promise.all([ctx.api.prompts(), ctx.api.skills(paths)]);
      if (generation !== requestGeneration) return;
      prompts = promptResult.prompts || [];
      skills = skillResult.skills || [];
      saveStore();
    } catch (requestError) {
      if (generation === requestGeneration) error = requestError.message;
    } finally {
      if (generation === requestGeneration) {
        busy = false;
        render();
      }
    }
  }

  function startNew(type) {
    tab = type;
    draft = emptyDraft(type, ctx);
    error = '';
    render();
    requestAnimationFrame(() => root.querySelector('.library-editor input')?.focus());
  }

  async function editItem(item) {
    error = '';
    if (item.type === 'prompts' || tab === 'prompts') {
      draft = {
        type: 'prompts', id: item.id, name: item.name, description: item.description || '',
        content: item.content || '', enabled: itemEnabled(item), loading: false, error: '', writable: true,
      };
      render();
      requestAnimationFrame(() => root.querySelector('.library-editor input')?.focus());
      return;
    }
    draft = { ...emptyDraft('skills', ctx), id: item.id, loading: true, error: '', writable: item.writable !== false };
    render();
    try {
      const detail = await ctx.api.skill(item.id, repositories());
      draft = {
        type: 'skills',
        id: detail.skill.id,
        name: detail.skill.name,
        description: detail.skill.description || '',
        content: detail.skill.content || '',
        enabled: itemEnabled(detail.skill),
        scope: detail.skill.scope || 'user',
        provider: detail.skill.provider || 'Codex',
        repositoryPath: repositories()[0] || '',
        loading: false,
        error: '',
        writable: detail.skill.writable !== false,
      };
      render();
      requestAnimationFrame(() => root.querySelector('.library-editor input')?.focus());
    } catch (requestError) {
      draft = null;
      error = requestError.message;
      render();
    }
  }

  async function toggleEnabled(item, enabled) {
    busy = true;
    error = '';
    render();
    try {
      const paths = repositories();
      const result = tab === 'prompts'
        ? await ctx.api.setPromptEnabled(item.id, enabled)
        : await ctx.api.setSkillEnabled(item.id, enabled, paths);
      if (tab === 'prompts') prompts = result.prompts || [];
      else skills = result.skills || [];
      saveStore();
      if (draft?.id === item.id) draft.enabled = enabled;
      ctx.store.set({ prompts, skills }, 'silent');
    } catch (requestError) {
      error = requestError.message;
    } finally {
      busy = false;
      render();
    }
  }

  async function saveDraft() {
    if (!draft) return;
    busy = true;
    draft.error = '';
    error = '';
    render();
    try {
      if (draft.type === 'prompts') {
        const result = await ctx.api.savePrompt({
          id: draft.id,
          name: draft.name,
          description: draft.description,
          content: draft.content,
        });
        prompts = result.prompts || [];
        const saved = prompts.find((item) => item.id === result.prompt?.id);
        const enabled = itemEnabled(draft);
        if (saved && itemEnabled(saved) !== enabled) {
          const visibility = await ctx.api.setPromptEnabled(saved.id, enabled);
          prompts = visibility.prompts || prompts;
        }
      } else {
        const paths = repositories();
        const payload = {
          name: draft.name,
          description: draft.description,
          content: draft.content,
          provider: draft.provider,
          scope: draft.scope,
          repositoryPath: draft.scope === 'project' ? draft.repositoryPath : null,
          repositories: paths,
        };
        let result;
        if (draft.id) result = await ctx.api.updateSkill(draft.id, { ...payload, repositories: paths });
        else result = await ctx.api.saveSkill(payload);
        skills = result.skills || skills;
        const saved = result.skill || skills.find((item) => item.name === draft.name);
        const enabled = itemEnabled(draft);
        if (saved && itemEnabled(saved) !== enabled) {
          const visibility = await ctx.api.setSkillEnabled(saved.id, enabled, paths);
          skills = visibility.skills || skills;
        }
      }
      saveStore();
      draft = null;
      busy = false;
      render();
      ctx.shell.showToast(`${tab === 'prompts' ? 'Prompt' : 'Skill'} saved.`);
    } catch (requestError) {
      if (draft) draft.error = requestError.message;
      busy = false;
      render();
    }
  }

  async function deleteItem(item) {
    if (!item?.id) return;
    const label = item.name || 'this item';
    const message = tab === 'skills' && item.scope === 'project'
      ? `Delete “${label}” from the project skill directory? This removes its SKILL.md and other files from the repository.`
      : `Delete “${label}”? This cannot be undone.`;
    const confirmed = await ctx.shell.confirm({
      title: `Delete ${tab === 'prompts' ? 'prompt' : 'skill'}?`,
      message,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    busy = true;
    error = '';
    render();
    try {
      const paths = repositories();
      const result = tab === 'prompts'
        ? await ctx.api.deletePrompt(item.id)
        : await ctx.api.deleteSkill(item.id, paths);
      if (tab === 'prompts') prompts = result.prompts || [];
      else skills = result.skills || [];
      saveStore();
      if (draft?.id === item.id) draft = null;
      busy = false;
      render();
      ctx.shell.showToast(`${tab === 'prompts' ? 'Prompt' : 'Skill'} deleted.`);
    } catch (requestError) {
      error = requestError.message;
      busy = false;
      render();
    }
  }

  function showTab(nextTab) {
    tab = TABS.some((entry) => entry.id === nextTab) ? nextTab : 'prompts';
    filter = 'all';
    searchTerm = '';
    render();
  }

  render();
  return {
    render,
    refresh,
    showTab,
  };
}

module.exports = { createLibraryView, itemEnabled };
