const { h, replace } = require('../dom');

const MAX_PROMPT_CONTENT_LENGTH = 12_000;

function openPromptManager({ shell, api, onChange }) {
  const list = h('div', { class: 'stack' });
  const count = h('span', { class: 'field-help' }, '');
  const editor = h('form', { class: 'card', hidden: true });
  const nameInput = h('input', { type: 'text', class: 'field-control', maxlength: 60, placeholder: 'For example: UI accessibility review' });
  const descriptionInput = h('input', { type: 'text', class: 'field-control', maxlength: 140, placeholder: 'A quick review of keyboard access and labels' });
  const contentInput = h('textarea', { class: 'field-control', rows: 8, maxlength: MAX_PROMPT_CONTENT_LENGTH, placeholder: 'Review the interface for keyboard navigation, focus states, accessible names, and clear error handling.' });
  const editorTitle = h('strong', {}, 'Create a saved prompt');
  const editorStatus = h('span', { class: 'field-help' }, 'Saved instructions are added whenever you select this prompt.');
  let editingId = null;
  let prompts = [];

  const closeEditor = () => {
    editor.hidden = true;
    editingId = null;
  };

  const startEditor = (prompt = null) => {
    editingId = prompt?.id || null;
    editorTitle.textContent = prompt ? `Edit ${prompt.name}` : 'Create a saved prompt';
    nameInput.value = prompt?.name || '';
    descriptionInput.value = prompt?.description || '';
    contentInput.value = prompt?.content || '';
    editor.hidden = false;
    nameInput.focus();
  };

  const render = () => {
    count.textContent = `${prompts.length} saved prompt${prompts.length === 1 ? '' : 's'}`;
    if (prompts.length === 0) {
      replace(list, h('div', { class: 'empty-state' }, 'No saved prompts yet. Create one to reuse instructions across tasks.'));
      return;
    }
    replace(list, ...prompts.map((prompt) => h(
      'div',
      { class: 'list-item' },
      h(
        'span',
        { class: 'grow' },
        h('span', { class: 'title' }, prompt.name),
        h('span', { class: 'subtitle', style: { whiteSpace: 'normal' } }, prompt.description || prompt.content.slice(0, 90)),
      ),
      h('button', { class: 'icon-button', title: 'Edit', onclick: () => startEditor(prompt) }, '✎'),
      h('button', {
        class: 'icon-button',
        title: 'Delete',
        onclick: async () => {
          const confirmed = await shell.confirm({
            title: 'Delete saved prompt?',
            message: `Delete the saved prompt “${prompt.name}”?`,
            confirmLabel: 'Delete prompt',
            danger: true,
          });
          if (!confirmed) return;
          try {
            const result = await api.deletePrompt(prompt.id);
            prompts = result.prompts;
            if (editingId === prompt.id) closeEditor();
            render();
            onChange(prompts);
            shell.showToast(`${prompt.name} deleted.`);
          } catch (error) {
            shell.showToast(error.message, true);
          }
        },
      }, '×'),
    )));
  };

  editor.append(
    h(
      'div',
      { class: 'row' },
      h('div', {}, h('p', { class: 'eyebrow' }, 'Prompt'), editorTitle),
      h('div', { class: 'spacer' }),
      h('button', { class: 'icon-button', type: 'button', onclick: closeEditor }, '×'),
    ),
    h('label', { class: 'field' }, h('span', {}, 'Name'), nameInput),
    h('label', { class: 'field' }, h('span', {}, 'Short description'), descriptionInput),
    h('label', { class: 'field' }, h('span', {}, 'Instructions'), contentInput),
    h('div', { class: 'row' }, editorStatus, h('div', { class: 'spacer' }), h('button', { class: 'primary', type: 'submit' }, 'Save prompt')),
  );

  editor.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const result = await api.savePrompt({
        id: editingId,
        name: nameInput.value,
        description: descriptionInput.value,
        content: contentInput.value,
      });
      prompts = result.prompts;
      closeEditor();
      render();
      onChange(prompts);
      shell.showToast(`${result.prompt.name} saved.`);
    } catch (error) {
      editorStatus.textContent = error.message;
    }
  });

  const handle = shell.modal({
    title: 'Manage saved prompts',
    width: '640px',
    body: [
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'primary', type: 'button', onclick: () => startEditor() }, '＋ New prompt'),
        h('div', { class: 'spacer' }),
        count,
      ),
      editor,
      list,
    ],
  });

  api.prompts().then((result) => {
    prompts = result.prompts;
    render();
  }).catch((error) => replace(list, h('div', { class: 'banner error' }, error.message)));

  return handle;
}

module.exports = { MAX_PROMPT_CONTENT_LENGTH, openPromptManager };
