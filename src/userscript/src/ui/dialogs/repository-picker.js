const { h, replace } = require('../dom');

const MAX_VISIBLE_REPOSITORIES = 100;

function repositoryPathKey(repositoryPath) {
  const value = String(repositoryPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(value) || value.startsWith('//') ? value.toLowerCase() : value;
}

function mergeRepositoryCatalog(...groups) {
  const merged = [];
  const seen = new Set();
  for (const repository of groups.flat()) {
    if (!repository?.path) continue;
    const key = repositoryPathKey(repository.path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push({
      ...repository,
      name: repository.name || String(repository.path).split(/[\\/]/).filter(Boolean).pop() || repository.path,
    });
  }
  return merged;
}

function repositorySearchScore(repository, query) {
  const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const name = String(repository.name || '').toLowerCase();
  const repositoryPath = String(repository.path || '').toLowerCase();
  if (!terms.every((term) => name.includes(term) || repositoryPath.includes(term))) return null;
  const phrase = terms.join(' ');
  if (name === phrase) return 0;
  if (name.startsWith(phrase)) return 1;
  if (name.includes(phrase)) return 2;
  return 3;
}

function searchRepositoryCatalog(repositories, query) {
  return repositories
    .map((repository, index) => ({
      repository,
      index,
      score: repositorySearchScore(repository, query),
    }))
    .filter((entry) => entry.score != null)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.repository);
}

// The local agent owns the native directory dialog because a userscript cannot
// read the absolute path selected by a browser-controlled folder input.
function openRepositoryPicker({
  shell,
  api,
  repositories = [],
  selectedPaths = [],
  allowEmpty = false,
  title = 'Add Git repositories',
  confirmLabel = 'Add selected',
  onChoose,
}) {
  const selected = new Set(selectedPaths);
  const workspacePaths = new Set(repositories.map((repository) => repositoryPathKey(repository.path)));
  const searchInput = h('input', {
    type: 'search',
    class: 'field-control picker-search',
    placeholder: 'Search repositories by name or path',
    autocomplete: 'off',
  });
  const resultMeta = h('span', { class: 'field-help picker-result-meta' }, 'Loading remembered repositories…');
  const listing = h('div', { class: 'list picker-list' });
  const notice = h('span', { class: 'field-help picker-notice' }, '');
  const selectionStatus = h('span', { class: 'field-help' }, 'Select one or more Git repositories.');
  const catalogToolbar = h('div', { class: 'picker-toolbar' });
  const discoveryPanel = h('div', { class: 'picker-discovery' });
  const browserToolbar = h('div', { class: 'picker-browser-toolbar', hidden: true });
  const pathLine = h('div', { class: 'picker-path', hidden: true }, '');
  const browserRoots = h('div', { class: 'picker-root-actions', hidden: true });
  const manualInput = h('input', {
    type: 'text', class: 'field-control', placeholder: 'Jump to a folder path',
  });
  const manualRow = h('div', { class: 'row picker-manual', hidden: true }, manualInput);
  let catalog = mergeRepositoryCatalog(repositories);
  let roots = [];
  let current = null;
  let mode = 'catalog';
  let handle;

  const chooseButton = h('button', {
    class: 'primary',
    disabled: !allowEmpty && selected.size === 0,
    onclick: async () => {
      const paths = [...selected];
      handle.close();
      await onChoose(paths);
    },
  }, confirmLabel);

  const syncChoose = () => {
    chooseButton.disabled = !allowEmpty && selected.size === 0;
    chooseButton.textContent = allowEmpty
      ? confirmLabel
      : (selected.size > 1 ? `Add ${selected.size} repositories` : 'Add repository');
    selectionStatus.textContent = selected.size === 0
      ? (allowEmpty ? 'No repositories selected.' : 'Select one or more Git repositories.')
      : `${selected.size} repositor${selected.size === 1 ? 'y' : 'ies'} selected`;
  };

  const toggle = (repositoryPath) => {
    if (selected.has(repositoryPath)) selected.delete(repositoryPath);
    else selected.add(repositoryPath);
    syncChoose();
    if (mode === 'catalog') renderCatalog();
    else if (current) renderBrowser(current);
  };

  const repositoryButton = (repository) => {
    const isSelected = selected.has(repository.path);
    const inWorkspace = workspacePaths.has(repositoryPathKey(repository.path));
    return h('button', {
      class: `list-item repository-result ${isSelected ? 'active' : ''}`,
      'aria-pressed': String(isSelected),
      onclick: () => toggle(repository.path),
    },
    h('span', { class: `picker-check ${isSelected ? 'active' : ''}`, 'aria-hidden': 'true' }, isSelected ? '✓' : ''),
    h(
      'span',
      { class: 'grow' },
      h('span', { class: 'title' }, repository.name),
      h('span', { class: 'subtitle' }, repository.path),
    ),
    inWorkspace ? h('span', { class: 'status-badge' }, 'Workspace') : null);
  };

  const updateDiscoveryPanel = () => {
    replace(
      discoveryPanel,
      h('div', { class: 'picker-section-label' }, 'Find more repositories'),
      h(
        'div',
        { class: 'picker-root-actions' },
        ...roots.map((root) => h('button', {
          class: 'secondary picker-root-action',
          onclick: () => discover(root.path, root.label),
        }, `Scan ${root.label}`)),
        h('button', {
          class: 'secondary picker-root-action',
          onclick: async () => {
            notice.textContent = 'Waiting for folder selection…';
            try {
              const { path: selectedPath } = await api.selectDirectory();
              if (selectedPath) await load(selectedPath);
              else notice.textContent = '';
            } catch (error) {
              shell.showToast(error.message, true);
              notice.textContent = '';
            }
          },
        }, 'Browse folder…'),
      ),
    );
  };

  const renderCatalog = () => {
    mode = 'catalog';
    const query = searchInput.value.trim();
    const matches = searchRepositoryCatalog(catalog, query);
    const visible = matches.slice(0, MAX_VISIBLE_REPOSITORIES);
    catalogToolbar.hidden = false;
    discoveryPanel.hidden = Boolean(query);
    browserToolbar.hidden = true;
    pathLine.hidden = true;
    browserRoots.hidden = true;
    manualRow.hidden = true;
    resultMeta.textContent = query
      ? `${matches.length} match${matches.length === 1 ? '' : 'es'} in ${catalog.length} remembered repositories`
      : `${catalog.length} remembered repositor${catalog.length === 1 ? 'y' : 'ies'}`;
    replace(
      listing,
      ...visible.map(repositoryButton),
      visible.length === 0
        ? h('div', { class: 'empty-state' }, query
          ? `No remembered repositories match “${query}”.`
          : 'No remembered repositories yet. Scan a location once and the results will stay searchable here.')
        : null,
      matches.length > visible.length
        ? h('div', { class: 'picker-overflow' }, `Showing the first ${visible.length} matches. Keep typing to narrow the list.`)
        : null,
    );
  };

  const renderBrowser = (listingResult) => {
    mode = 'browser';
    current = listingResult;
    catalogToolbar.hidden = true;
    discoveryPanel.hidden = true;
    browserToolbar.hidden = false;
    pathLine.hidden = false;
    browserRoots.hidden = false;
    manualRow.hidden = false;
    replace(pathLine, listingResult.path);
    replace(
      browserRoots,
      ...listingResult.roots.map((root) => h('button', {
        class: 'secondary picker-root-action', onclick: () => load(root.path),
      }, root.label)),
    );
    replace(
      listing,
      listingResult.parent
        ? h('button', { class: 'list-item', onclick: () => load(listingResult.parent) },
          h('span', { class: 'grow' }, h('span', { class: 'title' }, '.. parent directory')))
        : null,
      listingResult.repository
        ? repositoryButton({
          name: listingResult.path.split(/[\\/]/).filter(Boolean).pop() || listingResult.path,
          path: listingResult.path,
        })
        : null,
      ...listingResult.directories.map((entry) => h(
        'div',
        { class: 'row picker-directory-row' },
        entry.repository
          ? repositoryButton(entry)
          : h('button', { class: 'list-item', onclick: () => load(entry.path) },
            h('span', { class: 'grow' },
              h('span', { class: 'title' }, entry.name),
              h('span', { class: 'subtitle' }, 'Directory'))),
        entry.repository
          ? h('button', { class: 'icon-button', title: 'Open directory', onclick: () => load(entry.path) }, '→')
          : null,
      )),
      listingResult.directories.length === 0 && !listingResult.repository
        ? h('div', { class: 'empty-state' }, 'No subdirectories here.')
        : null,
    );
  };

  const load = async (repositoryPath) => {
    notice.textContent = 'Loading folder…';
    try {
      const listingResult = await api.fsBrowse(repositoryPath);
      const found = [
        ...(listingResult.repository ? [{
          name: listingResult.path.split(/[\\/]/).filter(Boolean).pop() || listingResult.path,
          path: listingResult.path,
        }] : []),
        ...listingResult.directories.filter((entry) => entry.repository),
      ];
      catalog = mergeRepositoryCatalog(found, catalog);
      renderBrowser(listingResult);
      notice.textContent = '';
    } catch (error) {
      shell.showToast(error.message, true);
      notice.textContent = '';
    }
  };

  const discover = async (repositoryPath, label = null) => {
    notice.textContent = `Scanning ${label || repositoryPath}…`;
    try {
      const { repositories: found } = await api.fsDiscover(repositoryPath);
      catalog = mergeRepositoryCatalog(found, catalog);
      searchInput.value = '';
      renderCatalog();
      notice.textContent = found.length === 0
        ? `No Git repositories found below ${label || repositoryPath}.`
        : `Found and remembered ${found.length} repositor${found.length === 1 ? 'y' : 'ies'} from ${label || repositoryPath}.`;
    } catch (error) {
      shell.showToast(error.message, true);
      notice.textContent = '';
    }
  };

  replace(catalogToolbar, resultMeta);
  replace(
    browserToolbar,
    h('button', { class: 'text-button picker-back', onclick: () => renderCatalog() }, '← Remembered repositories'),
    h('div', { class: 'spacer' }),
    h('button', {
      class: 'secondary picker-root-action',
      onclick: () => current && discover(current.path, 'this folder'),
    }, 'Scan this folder'),
  );
  manualRow.append(h('button', {
    class: 'secondary',
    onclick: () => {
      const value = manualInput.value.trim();
      if (value) load(value);
    },
  }, 'Go'));

  searchInput.addEventListener('input', renderCatalog);
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && searchInput.value) {
      event.preventDefault();
      searchInput.value = '';
      renderCatalog();
      return;
    }
    if (event.key === 'Enter') {
      const firstMatch = searchRepositoryCatalog(catalog, searchInput.value)[0];
      if (!firstMatch) return;
      event.preventDefault();
      toggle(firstMatch.path);
    }
  });
  manualInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const value = manualInput.value.trim();
    if (value) load(value);
  });

  handle = shell.modal({
    title,
    width: '700px',
    body: h(
      'div',
      { class: 'repository-picker' },
      searchInput,
      catalogToolbar,
      discoveryPanel,
      browserToolbar,
      pathLine,
      browserRoots,
      listing,
      manualRow,
      notice,
    ),
    footer: [selectionStatus, h('div', { class: 'spacer' }), chooseButton],
  });

  renderCatalog();
  updateDiscoveryPanel();
  Promise.all([api.repositoryCatalog(), api.fsRoots()]).then(([saved, availableRoots]) => {
    catalog = mergeRepositoryCatalog(repositories, saved.repositories || [], catalog);
    roots = availableRoots.roots || [];
    updateDiscoveryPanel();
    renderCatalog();
  }).catch((error) => {
    shell.showToast(error.message, true);
    resultMeta.textContent = `${catalog.length} remembered repositor${catalog.length === 1 ? 'y' : 'ies'}`;
  });
  searchInput.focus?.();
  syncChoose();
  return handle;
}

module.exports = {
  mergeRepositoryCatalog,
  openRepositoryPicker,
  searchRepositoryCatalog,
};
