const {
  formatBytes, h, option, replace,
} = require('../dom');
const { MODEL_LABELS, REASONING_LABELS } = require('../labels');

const NEW_TREE_VALUE = '__new__';
const NEW_PROJECT_VALUE = '__new__';

function renderComposer(ctx) {
  const { state } = ctx.store;
  const { composer } = state;

  const treeSelect = h(
    'select',
    {
      class: 'field-control',
      onchange: () => {
        ctx.store.setComposer({ treeSelection: treeSelect.value });
        ctx.persist('task-tree', treeSelect.value);
        ctx.renderActiveView();
      },
    },
    option('', 'No coding tree — use current working changes', composer.treeSelection === ''),
    option(NEW_TREE_VALUE, 'Create a new coding tree', composer.treeSelection === NEW_TREE_VALUE),
    ...state.trees
      .filter((tree) => tree.available && tree.mergeState !== 'submitted')
      .map((tree) => option(tree.id, `${tree.name} · ${tree.repositoryName}`, composer.treeSelection === tree.id)),
  );

  const treeNameInput = h('input', {
    type: 'text',
    class: 'field-control',
    maxlength: 80,
    placeholder: 'For example: Modern source control',
    value: composer.treeName,
    oninput: () => ctx.store.setComposer({ treeName: treeNameInput.value }, 'silent'),
  });

  const repositoryList = h('div', { class: 'list' });
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
        title: 'Remove',
        onclick: () => ctx.actions.removeComposerRepository(repository.path),
      }, '×'),
    )),
    composer.repositories.length === 0
      ? h('div', { class: 'empty-state' }, 'Add at least one Git repository.')
      : null,
  );

  const modelSelect = h(
    'select',
    {
      class: 'field-control',
      onchange: () => {
        ctx.store.setComposer({ model: modelSelect.value }, 'silent');
        ctx.persist('task-model', modelSelect.value);
      },
    },
    ...Object.entries(MODEL_LABELS).map(([value, label]) => option(value, label, value === composer.model)),
  );

  const reasoningSelect = h(
    'select',
    {
      class: 'field-control',
      onchange: () => {
        ctx.store.setComposer({ reasoningMode: reasoningSelect.value }, 'silent');
        ctx.persist('task-reasoning', reasoningSelect.value);
      },
    },
    ...Object.entries(REASONING_LABELS).map(([value, label]) => option(
      value,
      value === 'default' ? 'Default reasoning' : label,
      value === composer.reasoningMode,
    )),
  );

  const promptChips = h('div', { class: 'row wrap' });
  const selectedPrompts = state.prompts.filter((prompt) => composer.promptIds.includes(prompt.id));
  replace(
    promptChips,
    ...selectedPrompts.map((prompt) => h(
      'span',
      { class: 'chip' },
      prompt.name,
      h('button', {
        title: 'Remove',
        onclick: () => {
          ctx.store.setComposer({ promptIds: composer.promptIds.filter((id) => id !== prompt.id) });
          ctx.renderActiveView();
        },
      }, '×'),
    )),
  );

  const promptSelect = h(
    'select',
    {
      class: 'field-control',
      onchange: () => {
        const value = promptSelect.value;
        promptSelect.value = '';
        if (!value || composer.promptIds.includes(value)) return;
        ctx.store.setComposer({ promptIds: [...composer.promptIds, value] });
        ctx.renderActiveView();
      },
    },
    option('', 'Add saved prompts', true),
    ...state.prompts
      .filter((prompt) => !composer.promptIds.includes(prompt.id))
      .map((prompt) => option(prompt.id, prompt.name)),
  );

  const taskText = h('textarea', {
    class: 'field-control',
    rows: 7,
    placeholder: 'Describe the software task. Reference files, behaviors, and constraints.',
    value: composer.taskText,
    oninput: () => ctx.store.setComposer({ taskText: taskText.value }, 'silent'),
  });

  const skillSummary = composer.skillIds.length
    ? `${composer.skillIds.length} skill${composer.skillIds.length === 1 ? '' : 's'} selected`
    : 'No skills selected';

  const iacCount = (state.iac.selectors || []).length;
  const iacCheckbox = h('input', {
    type: 'checkbox',
    checked: composer.includeIac && iacCount > 0,
    disabled: !state.iac.exists || iacCount === 0,
    onchange: () => {
      ctx.store.setComposer({ includeIac: iacCheckbox.checked }, 'silent');
      ctx.persist('task-iac', String(iacCheckbox.checked));
    },
  });

  const answerOnlyCheckbox = h('input', {
    type: 'checkbox',
    checked: composer.answerOnly,
    onchange: () => {
      ctx.store.setComposer({ answerOnly: answerOnlyCheckbox.checked }, 'silent');
    },
  });

  const attachmentInput = h('input', {
    type: 'file',
    multiple: true,
    style: { display: 'none' },
    onchange: () => ctx.actions.addAttachments([...attachmentInput.files]),
  });

  const attachmentList = h('div', { class: 'row wrap' });
  replace(
    attachmentList,
    ...composer.attachments.map((attachment) => h(
      'span',
      { class: 'chip' },
      `${attachment.name} · ${formatBytes(attachment.size)}`,
      h('button', {
        title: 'Remove',
        onclick: () => {
          ctx.store.setComposer({
            attachments: composer.attachments.filter((item) => item.path !== attachment.path),
          });
          ctx.renderActiveView();
        },
      }, '×'),
    )),
    composer.attachments.length === 0 ? h('span', { class: 'field-help' }, 'No attachments.') : null,
  );

  const projectSelect = h(
    'select',
    {
      class: 'field-control',
      onchange: () => {
        ctx.store.setComposer({ projectSelection: projectSelect.value });
        ctx.persist('task-project', projectSelect.value);
        ctx.renderActiveView();
      },
    },
    option('', 'New chat (no project)', composer.projectSelection === ''),
    option(NEW_PROJECT_VALUE, 'Create a new project', composer.projectSelection === NEW_PROJECT_VALUE),
    ...state.projects.map((project) => option(project.id, project.name, composer.projectSelection === project.id)),
  );

  const newProjectName = h('input', {
    type: 'text',
    class: 'field-control',
    maxlength: 100,
    placeholder: 'For example: Coding tasks',
    value: composer.newProjectName,
    oninput: () => ctx.store.setComposer({ newProjectName: newProjectName.value }, 'silent'),
  });

  const createButton = h('button', {
    class: 'primary wide',
    onclick: () => ctx.actions.createTask({ submit: true }),
  }, 'Package and send');

  return [
    h(
      'div',
      { class: 'card' },
      h('h3', {}, 'Target'),
      h('label', { class: 'field' }, h('span', {}, 'Coding tree'), treeSelect),
      composer.treeSelection === NEW_TREE_VALUE
        ? h('label', { class: 'field' }, h('span', {}, 'Tree name'), treeNameInput)
        : null,
      h(
        'div',
        { class: 'row' },
        h('p', { class: 'eyebrow' }, 'Repositories'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'secondary', onclick: () => ctx.actions.chooseRepositories() }, 'Add repository'),
      ),
      repositoryList,
    ),
    h(
      'div',
      { class: 'card' },
      h('h3', {}, 'Task'),
      h(
        'div',
        { class: 'row' },
        h('label', { class: 'field', style: { flex: '1' } }, h('span', {}, 'Model'), modelSelect),
        h('label', { class: 'field', style: { flex: '1' } }, h('span', {}, 'Reasoning'), reasoningSelect),
      ),
      h(
        'div',
        { class: 'row' },
        h('label', { class: 'field', style: { flex: '1' } }, h('span', {}, 'Prompt library'), promptSelect),
        h('button', {
          class: 'secondary',
          style: { alignSelf: 'flex-end' },
          onclick: () => ctx.actions.openPromptManager(),
        }, 'Manage'),
      ),
      selectedPrompts.length ? promptChips : null,
      h('label', { class: 'field' }, h('span', {}, 'Instructions'), taskText),
      h(
        'label',
        { class: 'row', style: { gap: '8px' } },
        answerOnlyCheckbox,
        h('span', { class: 'field-help' }, 'Answer only — respond in the chat without generating a result file or making changes'),
      ),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'secondary', onclick: () => ctx.actions.openSkillDrawer() }, 'Choose skills'),
        h('span', { class: 'field-help' }, skillSummary),
      ),
      h(
        'label',
        { class: 'row', style: { gap: '8px' } },
        iacCheckbox,
        h('span', { class: 'field-help' }, iacCount
          ? `Include ${iacCount} configured infrastructure repositor${iacCount === 1 ? 'y' : 'ies'} as read-only context`
          : 'No IaC repositories are configured in settings.json'),
      ),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'secondary', onclick: () => attachmentInput.click() }, 'Upload attachment'),
        attachmentInput,
        h('div', { class: 'spacer' }),
      ),
      attachmentList,
    ),
    h(
      'div',
      { class: 'card' },
      h('h3', {}, 'Destination'),
      h(
        'div',
        { class: 'row' },
        h('label', { class: 'field', style: { flex: '1' } }, h('span', {}, 'Where it runs'), projectSelect),
        h('button', {
          class: 'secondary',
          style: { alignSelf: 'flex-end' },
          onclick: () => ctx.actions.refreshProjects(true),
        }, 'Refresh'),
      ),
      composer.projectSelection === NEW_PROJECT_VALUE
        ? h('label', { class: 'field' }, h('span', {}, 'New project name'), newProjectName)
        : null,
      h('p', { class: 'field-help' }, 'Results are validated against the task base before anything is applied.'),
    ),
    createButton,
  ];
}

module.exports = { NEW_PROJECT_VALUE, NEW_TREE_VALUE, renderComposer };
