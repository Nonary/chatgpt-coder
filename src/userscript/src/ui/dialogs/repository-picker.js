const { h, replace } = require('../dom');

// Replaces Electron's native directory dialog: the browser cannot hand back a
// filesystem path, so the agent walks the disk and the page renders it.
function openRepositoryPicker({ shell, api, onChoose }) {
  const selected = new Set();
  const pathLine = h('div', { class: 'picker-path' }, 'Loading…');
  const listing = h('div', { class: 'list picker-list' });
  const rootsRow = h('div', { class: 'row wrap' });
  const status = h('span', { class: 'field-help' }, '');
  const manualInput = h('input', { type: 'text', class: 'field-control', placeholder: 'Type a repository path' });
  let current = null;
  let handle;

  const chooseButton = h('button', {
    class: 'primary',
    disabled: true,
    onclick: async () => {
      const paths = [...selected];
      handle.close();
      await onChoose(paths);
    },
  }, 'Add selected');

  const syncChoose = () => {
    chooseButton.disabled = selected.size === 0;
    chooseButton.textContent = selected.size > 1 ? `Add ${selected.size} repositories` : 'Add repository';
    status.textContent = selected.size === 0
      ? 'Select one or more Git repositories.'
      : [...selected].map((item) => item.split(/[\\/]/).pop()).join(', ');
  };

  const toggle = (path, button) => {
    if (selected.has(path)) selected.delete(path);
    else selected.add(path);
    button.classList.toggle('active', selected.has(path));
    syncChoose();
  };

  const render = (listingResult) => {
    current = listingResult;
    replace(pathLine, listingResult.path);
    replace(
      listing,
      listingResult.parent
        ? h('button', {
          class: 'list-item',
          onclick: () => load(listingResult.parent),
        }, h('span', { class: 'grow' }, h('span', { class: 'title' }, '.. parent directory')))
        : null,
      listingResult.repository
        ? h('button', {
          class: `list-item ${selected.has(listingResult.path) ? 'active' : ''}`,
          onclick: (event) => toggle(listingResult.path, event.currentTarget),
        }, h(
          'span',
          { class: 'grow' },
          h('span', { class: 'title' }, `Use this directory · ${listingResult.path.split(/[\\/]/).pop()}`),
          h('span', { class: 'subtitle' }, 'Git repository'),
        ))
        : null,
      ...listingResult.directories.map((entry) => h(
        'div',
        { class: 'row', style: { gap: '6px' } },
        h('button', {
          class: `list-item ${selected.has(entry.path) ? 'active' : ''}`,
          style: { flex: '1' },
          onclick: (event) => (entry.repository ? toggle(entry.path, event.currentTarget) : load(entry.path)),
        }, h(
          'span',
          { class: 'grow' },
          h('span', { class: 'title' }, entry.name),
          h('span', { class: 'subtitle' }, entry.repository ? 'Git repository' : 'Directory'),
        )),
        entry.repository
          ? h('button', { class: 'icon-button', title: 'Open directory', onclick: () => load(entry.path) }, '→')
          : null,
      )),
      listingResult.directories.length === 0 && !listingResult.repository
        ? h('div', { class: 'empty-state' }, 'No subdirectories here.')
        : null,
    );
    replace(
      rootsRow,
      ...listingResult.roots.map((root) => h('button', {
        class: 'secondary',
        style: { padding: '5px 10px', fontSize: '11px' },
        onclick: () => load(root.path),
      }, root.label)),
      h('button', {
        class: 'secondary',
        style: { padding: '5px 10px', fontSize: '11px' },
        onclick: () => discover(listingResult.path),
      }, 'Scan for repositories'),
    );
  };

  const load = async (path) => {
    try {
      render(await api.fsBrowse(path));
    } catch (error) {
      shell.showToast(error.message, true);
    }
  };

  const discover = async (path) => {
    status.textContent = 'Scanning…';
    try {
      const { repositories } = await api.fsDiscover(path);
      if (repositories.length === 0) {
        status.textContent = 'No Git repositories found below this directory.';
        return;
      }
      replace(
        listing,
        ...repositories.map((entry) => h('button', {
          class: `list-item ${selected.has(entry.path) ? 'active' : ''}`,
          onclick: (event) => toggle(entry.path, event.currentTarget),
        }, h(
          'span',
          { class: 'grow' },
          h('span', { class: 'title' }, entry.name),
          h('span', { class: 'subtitle' }, entry.path),
        ))),
      );
      status.textContent = `${repositories.length} repositor${repositories.length === 1 ? 'y' : 'ies'} found.`;
    } catch (error) {
      shell.showToast(error.message, true);
    }
  };

  handle = shell.modal({
    title: 'Add Git repositories',
    width: '640px',
    body: [
      rootsRow,
      pathLine,
      listing,
      h(
        'div',
        { class: 'row' },
        manualInput,
        h('button', {
          class: 'secondary',
          onclick: () => {
            const value = manualInput.value.trim();
            if (value) load(value);
          },
        }, 'Go'),
      ),
    ],
    footer: [status, h('div', { class: 'spacer' }), chooseButton],
  });

  manualInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const value = manualInput.value.trim();
    if (value) load(value);
  });

  load().catch(() => {});
  syncChoose();
  return handle;
}

module.exports = { openRepositoryPicker };
