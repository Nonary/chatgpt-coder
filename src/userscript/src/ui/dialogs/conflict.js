const { h, option } = require('../dom');
const { MODEL_LABELS, REASONING_LABELS, taskLabel } = require('../labels');
const { taskModelSupportsReasoning } = require('../../../../shared/chatgpt');

function openConflictResolution({ shell, task, onSubmit }) {
  const modelSelect = h(
    'select',
    { class: 'field-control' },
    ...Object.entries(MODEL_LABELS).map(([value, label]) => option(value, label, value === (task.model || 'default'))),
  );
  const reasoningSelect = h(
    'select',
    { class: 'field-control' },
    ...Object.entries(REASONING_LABELS)
      .filter(([value]) => taskModelSupportsReasoning(task.model || 'default', value))
      .map(([value, label]) => option(
        value,
        value === 'default' ? 'Default reasoning' : label,
        value === (task.reasoningMode || 'default'),
      )),
  );
  const instructions = h('textarea', {
    class: 'field-control',
    rows: 7,
    maxlength: 12_000,
    placeholder: 'Add any context, constraints, or specific files to consider while resolving the conflict.',
  });
  const status = h('span', { class: 'field-help' }, '');

  const submitButton = h('button', {
    class: 'primary',
    onclick: async () => {
      submitButton.disabled = true;
      status.textContent = 'Reapplying the saved result and packaging the resolution task…';
      try {
        await onSubmit({
          model: modelSelect.value,
          reasoningMode: reasoningSelect.value,
          additionalInstructions: instructions.value,
        });
        handle.close();
      } catch (error) {
        status.textContent = error.message;
        submitButton.disabled = false;
      }
    },
  }, 'Resolve conflict');

  const conflict = task.result?.conflicts?.[0];
  const handle = shell.modal({
    title: 'Resolve this result in a new chat',
    width: '620px',
    body: [
      h('div', { class: 'banner' }, task.error || 'The result could not be applied cleanly.'),
      h(
        'div',
        { class: 'card' },
        h('p', { class: 'eyebrow' }, 'Current task'),
        h('strong', {}, taskLabel(task)),
        conflict?.files?.length
          ? h('p', { class: 'field-help' }, `${conflict.files.length} conflicted file${conflict.files.length === 1 ? '' : 's'}: ${conflict.files.slice(0, 6).join(', ')}`)
          : null,
      ),
      h(
        'div',
        { class: 'row' },
        h('label', { class: 'field', style: { flex: '1' } }, h('span', {}, 'Model'), modelSelect),
        h('label', { class: 'field', style: { flex: '1' } }, h('span', {}, 'Reasoning'), reasoningSelect),
      ),
      h('label', { class: 'field' }, h('span', {}, 'Additional instructions'), instructions),
      h('p', { class: 'field-help' }, 'The follow-up carries the current dirty target, CONFLICTS.md, the original result patch, and the original attachments.'),
    ],
    footer: [
      status,
      h('div', { class: 'spacer' }),
      h('button', { class: 'secondary', onclick: () => handle.close() }, 'Cancel'),
      submitButton,
    ],
  });
  return handle;
}

module.exports = { openConflictResolution };
