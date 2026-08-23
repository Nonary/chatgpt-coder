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
    merged.push(repository);
  }
  return merged;
}

module.exports = { mergeRepositoryCatalog, repositoryPathKey };
