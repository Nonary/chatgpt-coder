const { h, replace } = require('../dom');

function groupLabel(scope) {
  return scope === 'project' ? 'Project skills' : 'Personal skills';
}

function openSkillDrawer({
  shell, api, repositoryPaths, selectedIds, onDone,
}) {
  const selected = new Set(selectedIds);
  const list = h('div', { class: 'stack' });
  const status = h('span', { class: 'field-help' }, 'Loading skills…');
  const search = h('input', { type: 'search', class: 'field-control', placeholder: 'Search skills' });
  let skills = [];

  const syncStatus = () => {
    status.textContent = selected.size === 0
      ? 'No skills selected.'
      : `${selected.size} skill${selected.size === 1 ? '' : 's'} selected.`;
  };

  const render = () => {
    const term = search.value.trim().toLowerCase();
    const matching = skills.filter((skill) => !term
      || `${skill.name} ${skill.description} ${skill.provider} ${skill.location}`.toLowerCase().includes(term));
    if (matching.length === 0) {
      replace(list, h('div', { class: 'empty-state' }, skills.length === 0
        ? 'No local skills were discovered. Any directory containing SKILL.md qualifies.'
        : 'No skills match that search.'));
      return;
    }
    const groups = new Map();
    for (const skill of matching) {
      const key = groupLabel(skill.scope);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(skill);
    }
    replace(list, ...[...groups.entries()].map(([label, entries]) => h(
      'div',
      { class: 'stack' },
      h('p', { class: 'eyebrow' }, label),
      ...entries.map((skill) => {
        const checkbox = h('input', {
          type: 'checkbox',
          checked: selected.has(skill.id),
          onchange: () => {
            if (checkbox.checked) selected.add(skill.id);
            else selected.delete(skill.id);
            syncStatus();
          },
        });
        return h(
          'label',
          { class: 'list-item', style: { alignItems: 'flex-start' } },
          checkbox,
          h(
            'span',
            { class: 'grow' },
            h('span', { class: 'title' }, skill.name),
            h('span', { class: 'subtitle', style: { whiteSpace: 'normal' } }, skill.description || 'No description.'),
            h('span', { class: 'subtitle' }, `${skill.provider} · ${skill.location}`),
          ),
        );
      }),
    )));
  };

  const load = async () => {
    try {
      const result = await api.skills(repositoryPaths);
      skills = result.skills || [];
      render();
      syncStatus();
    } catch (error) {
      replace(list, h('div', { class: 'banner error' }, error.message));
    }
  };

  search.addEventListener('input', render);

  const handle = shell.modal({
    title: 'Choose skills',
    width: '620px',
    body: [
      h('p', { class: 'field-help' }, 'Selected skill directories are copied into the task package under skills/, and are loaded only when relevant.'),
      h(
        'div',
        { class: 'row' },
        search,
        h('button', { class: 'secondary', onclick: () => load() }, 'Refresh'),
      ),
      list,
    ],
    footer: [
      status,
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'primary',
        onclick: () => {
          handle.close();
          onDone([...selected]);
        },
      }, 'Done'),
    ],
  });

  load();
  return handle;
}

module.exports = { openSkillDrawer };
