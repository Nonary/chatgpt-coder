function query(parameters = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

class AgentError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'AgentError';
    this.status = status;
  }
}

class Api {
  constructor(transport) {
    this.transport = transport;
  }

  async call(method, path, body, options = {}) {
    const response = await this.transport.request({ method, path, body, ...options });
    if (options.responseType === 'arraybuffer') {
      if (response.status >= 400) throw new AgentError('The local agent could not return that file.', response.status);
      return response.buffer;
    }
    let payload = {};
    try {
      payload = response.text ? JSON.parse(response.text) : {};
    } catch {
      throw new AgentError('The local agent returned a malformed response.', response.status);
    }
    if (response.status >= 400) throw new AgentError(payload.error || 'The local agent rejected that request.', response.status);
    return payload;
  }

  get(path, options) { return this.call('GET', path, null, options); }

  post(path, body, options) { return this.call('POST', path, body ?? {}, options); }

  remove(path, options) { return this.call('DELETE', path, null, options); }

  /* system */
  health() { return this.get('/health', { timeout: 3_000 }); }

  config() { return this.get('/v1/config'); }

  updateStatus() { return this.get('/v1/update', { timeout: 60_000 }); }

  applyUpdate({ rebuild = false } = {}) {
    return this.post('/v1/update', { rebuild }, { timeout: 600_000 });
  }

  events(since) { return this.get(`/v1/events${query({ since })}`, { timeout: 40_000 }); }

  /* filesystem */
  fsRoots() { return this.get('/v1/fs/roots'); }

  selectDirectory() { return this.post('/v1/fs/select-directory', {}, { timeout: 600_000 }); }

  fsBrowse(path) { return this.get(`/v1/fs/browse${query({ path })}`); }

  fsDiscover(path, depth) { return this.get(`/v1/fs/discover${query({ path, depth })}`); }

  reveal(path) { return this.post('/v1/fs/reveal', { path }); }

  /* workspace */
  repositories() { return this.get('/v1/workspace/repositories'); }

  repositoryCatalog() { return this.get('/v1/workspace/repository-catalog'); }

  addRepositories(paths) { return this.post('/v1/workspace/repositories', { paths }); }

  removeRepository(path) { return this.post('/v1/workspace/repositories/remove', { path }); }

  gitStatus(path) { return this.get(`/v1/workspace/status${query({ path })}`); }

  gitHistory(path, limit) { return this.get(`/v1/workspace/history${query({ path, limit })}`); }

  gitDiff(path, file, staged) { return this.get(`/v1/workspace/diff${query({ path, file, staged })}`); }

  gitStage(path, files) { return this.post('/v1/workspace/stage', { path, files }); }

  gitStageAll(path) { return this.post('/v1/workspace/stage', { path, all: true }); }

  gitUnstage(path, files) { return this.post('/v1/workspace/unstage', { path, files }); }

  gitUnstageAll(path) { return this.post('/v1/workspace/unstage', { path, all: true }); }

  gitCommit(path, message) { return this.post('/v1/workspace/commit', { path, message }); }

  gitSummary(input) { return this.post('/v1/git-summary', input); }

  /* catalogs */
  skills(repositoryPaths = []) {
    return this.get(`/v1/skills${query({ repositories: repositoryPaths.join('\n') })}`);
  }

  iac() { return this.get('/v1/iac'); }

  prompts() { return this.get('/v1/prompts'); }

  savePrompt(prompt) { return this.post('/v1/prompts', prompt); }

  deletePrompt(promptId) { return this.remove(`/v1/prompts/${encodeURIComponent(promptId)}`); }

  /* tasks */
  tasks() { return this.get('/v1/tasks'); }

  task(taskId) { return this.get(`/v1/tasks/${encodeURIComponent(taskId)}`); }

  createTask(input) { return this.post('/v1/tasks', input, { timeout: 300_000 }); }

  deleteTask(taskId) { return this.remove(`/v1/tasks/${encodeURIComponent(taskId)}`); }

  taskPackage(taskId) {
    return this.call('GET', `/v1/tasks/${encodeURIComponent(taskId)}/package`, null, {
      responseType: 'arraybuffer',
      timeout: 300_000,
    });
  }

  taskAttachment(taskId, name) {
    return this.call('GET', `/v1/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(name)}`, null, {
      responseType: 'arraybuffer',
      timeout: 300_000,
    });
  }

  uploadAttachment(name, buffer) {
    return this.call('POST', `/v1/uploads${query({ name })}`, buffer, { timeout: 300_000 });
  }

  taskSubmitted(taskId, input) { return this.post(`/v1/tasks/${encodeURIComponent(taskId)}/submitted`, input); }

  taskChatStatus(taskId, input) { return this.post(`/v1/tasks/${encodeURIComponent(taskId)}/chat-status`, input); }

  taskFailed(taskId, message) { return this.post(`/v1/tasks/${encodeURIComponent(taskId)}/failed`, { message }); }

  taskResult(taskId, text) {
    return this.post(`/v1/tasks/${encodeURIComponent(taskId)}/result`, { text }, { timeout: 600_000 });
  }

  applyTask(taskId) { return this.post(`/v1/tasks/${encodeURIComponent(taskId)}/apply`, {}, { timeout: 300_000 }); }

  retryApply(taskId) { return this.post(`/v1/tasks/${encodeURIComponent(taskId)}/retry-apply`, {}, { timeout: 300_000 }); }

  rollbackTask(taskId) { return this.post(`/v1/tasks/${encodeURIComponent(taskId)}/rollback`, {}, { timeout: 300_000 }); }

  useGitSummary(taskId) { return this.post(`/v1/tasks/${encodeURIComponent(taskId)}/use-git-summary`); }

  setTaskTarget(taskId, input) { return this.post(`/v1/tasks/${encodeURIComponent(taskId)}/target`, input); }

  resolveConflict(taskId, input) {
    return this.post(`/v1/tasks/${encodeURIComponent(taskId)}/resolve-conflict`, input, { timeout: 600_000 });
  }

  /* coding trees */
  trees() { return this.get('/v1/trees'); }

  revealTree(treeId) { return this.post(`/v1/trees/${encodeURIComponent(treeId)}/reveal`); }

  removeTree(treeId) { return this.remove(`/v1/trees/${encodeURIComponent(treeId)}?force=true`); }

  setTreeProject(treeId, chatgptProject) {
    return this.post(`/v1/trees/${encodeURIComponent(treeId)}/project`, { chatgptProject });
  }

  treeMergeRequest(treeId, chatgptProject) {
    const body = chatgptProject === undefined ? {} : { chatgptProject };
    return this.post(`/v1/trees/${encodeURIComponent(treeId)}/merge-request`, body);
  }

  treeMergeSubmitted(treeId, conversationUrl) {
    return this.post(`/v1/trees/${encodeURIComponent(treeId)}/merge-submitted`, { conversationUrl });
  }

  treeMergeFailed(treeId, message) {
    return this.post(`/v1/trees/${encodeURIComponent(treeId)}/merge-failed`, { message });
  }

  treeMergeResult(treeId, text) {
    return this.post(`/v1/trees/${encodeURIComponent(treeId)}/merge-result`, { text }, { timeout: 600_000 });
  }

  resolveTreeMerge(treeId) { return this.post(`/v1/trees/${encodeURIComponent(treeId)}/resolve-merge`, {}, { timeout: 300_000 }); }
}

module.exports = { AgentError, Api };
