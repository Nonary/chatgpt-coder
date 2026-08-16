const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fingerprintRepository, inspectRepository, runGit, slugify } = require('./git');

const MERGE_RESULT_START = 'PATCHWORK_MERGE_V1';
const MERGE_RESULT_END = 'PATCHWORK_MERGE_END';
const CHATGPT_PROJECT_ID_PATTERN = /^g-p-[A-Za-z0-9_-]+$/;

function mergeResultFilename(treeId) {
  return `chatgpt-ide-merge-result-${treeId}.txt`;
}

const CONVENTIONAL_COMMIT = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)\r\n]+\))?!?: .+/;

function validateCommitMessage(value) {
  const message = String(value || '').trim();
  if (!message) throw new Error('ChatGPT did not provide a commit message.');
  if (message.length > 10_000) throw new Error('The commit message is too long.');
  if (!CONVENTIONAL_COMMIT.test(message.split('\n')[0])) {
    throw new Error('ChatGPT must return a Conventional Commit message, such as "feat(editor): add split diff view".');
  }
  return message;
}

function normalizeChatGPTProject(project) {
  if (project == null) return null;
  const id = String(project.id || '').trim();
  if (!CHATGPT_PROJECT_ID_PATTERN.test(id)) {
    throw new Error('ChatGPT returned an invalid project identifier.');
  }
  const shortUrl = String(project.shortUrl || id).trim();
  if (!CHATGPT_PROJECT_ID_PATTERN.test(shortUrl) || (shortUrl !== id && !shortUrl.startsWith(`${id}-`))) {
    throw new Error('ChatGPT returned an invalid project URL.');
  }
  return {
    id,
    shortUrl,
    name: String(project.name || '').trim() || 'ChatGPT project',
  };
}

function parseMergeResult(value, treeId) {
  const text = String(value || '');
  const start = text.indexOf(MERGE_RESULT_START);
  const end = text.indexOf(MERGE_RESULT_END, start + MERGE_RESULT_START.length);
  if (start < 0 || end < 0) throw new Error('ChatGPT did not return a complete worktree merge envelope.');
  let jsonText = text.slice(start + MERGE_RESULT_START.length, end).trim();
  jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let result;
  try {
    result = JSON.parse(jsonText);
  } catch {
    throw new Error('The worktree merge envelope contains invalid JSON.');
  }
  if (result.schemaVersion !== 1 || result.treeId !== treeId) {
    throw new Error('This merge response belongs to a different worktree.');
  }
  return {
    commitMessage: validateCommitMessage(result.commitMessage),
    summary: String(result.summary || '').trim(),
  };
}

function parseWorktreeList(output) {
  const worktrees = [];
  let current = null;
  for (const token of String(output || '').split('\0')) {
    if (!token) {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }
    const separator = token.indexOf(' ');
    const key = separator < 0 ? token : token.slice(0, separator);
    const value = separator < 0 ? true : token.slice(separator + 1);
    if (key === 'worktree') {
      if (current) worktrees.push(current);
      current = { path: value };
    } else if (current) {
      current[key] = value;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

function branchName(value) {
  return String(value || '').replace(/^refs\/heads\//, '') || '(detached HEAD)';
}

function discoveredTreeId(worktreePath) {
  return `git-${crypto.createHash('sha256').update(worktreePath).digest('hex').slice(0, 12)}`;
}

class WorktreeService {
  constructor(dataRoot, onEvent = () => {}, repositoryProvider = async () => []) {
    this.dataRoot = dataRoot;
    this.worktreesRoot = path.join(dataRoot, 'worktrees');
    this.mergesRoot = path.join(dataRoot, 'merge-workspaces');
    this.recordsFile = path.join(dataRoot, 'worktrees.json');
    this.onEvent = onEvent;
    this.repositoryProvider = repositoryProvider;
  }

  async initialize() {
    await Promise.all([
      fs.mkdir(this.worktreesRoot, { recursive: true }),
      fs.mkdir(this.mergesRoot, { recursive: true }),
    ]);
    try {
      await fs.access(this.recordsFile);
    } catch {
      await fs.writeFile(this.recordsFile, '{"worktrees":[]}\n');
    }
  }

  async readRecords() {
    await this.initialize();
    const value = JSON.parse(await fs.readFile(this.recordsFile, 'utf8'));
    return Array.isArray(value.worktrees) ? value.worktrees : [];
  }

  async writeRecords(records) {
    await fs.writeFile(this.recordsFile, `${JSON.stringify({ worktrees: records }, null, 2)}\n`);
  }

  async get(treeId) {
    const tree = (await this.syncDiscoveredWorktrees()).find((item) => item.id === treeId);
    if (!tree) throw new Error('The selected coding tree no longer exists.');
    return tree;
  }

  async findForTask(task) {
    const trees = await this.syncDiscoveredWorktrees();
    const taskId = String(task?.taskId || '').trim();
    if (taskId) {
      const attached = trees.find((tree) => Array.isArray(tree.taskIds) && tree.taskIds.includes(taskId));
      if (attached) return this.inspect(attached);
    }

    const repositoryPaths = (Array.isArray(task?.repositories) ? task.repositories : [])
      .filter((repository) => repository?.path && !repository.readOnly)
      .map((repository) => repository.path);
    if (repositoryPaths.length === 0) return null;

    const resolvedPaths = new Set(await Promise.all(repositoryPaths.map((repositoryPath) =>
      fs.realpath(repositoryPath).catch(() => path.resolve(repositoryPath)))));
    for (const tree of trees) {
      const treePath = await fs.realpath(tree.path).catch(() => path.resolve(tree.path));
      if (resolvedPaths.has(treePath)) return this.inspect(tree);
    }
    return null;
  }

  async syncDiscoveredWorktrees() {
    const records = await this.readRecords();
    let repositories;
    try {
      repositories = await this.repositoryProvider();
    } catch {
      return records;
    }
    if (!Array.isArray(repositories) || repositories.length === 0) return records;

    const byPath = new Map();
    for (const record of records) {
      const resolvedPath = await fs.realpath(record.path).catch(() => path.resolve(record.path));
      byPath.set(resolvedPath, record);
    }
    let changed = false;
    const scannedRepositories = new Set();
    for (const suppliedRepository of repositories) {
      if (!suppliedRepository?.path || suppliedRepository.unavailable) continue;
      let worktrees;
      try {
        const { stdout } = await runGit(suppliedRepository.path, ['worktree', 'list', '--porcelain', '-z']);
        worktrees = parseWorktreeList(stdout);
      } catch {
        continue;
      }
      if (worktrees.length < 2) continue;
      const primaryPath = await fs.realpath(worktrees[0].path).catch(() => path.resolve(worktrees[0].path));
      if (scannedRepositories.has(primaryPath)) continue;
      scannedRepositories.add(primaryPath);
      const source = await inspectRepository(primaryPath).catch(() => suppliedRepository);
      const sourceBranch = branchName(worktrees[0].branch || source.branch);

      for (const discovered of worktrees.slice(1)) {
        const discoveredPath = await fs.realpath(discovered.path).catch(() => path.resolve(discovered.path));
        const existing = byPath.get(discoveredPath);
        if (existing && existing.managed !== false) continue;
        const branch = branchName(discovered.branch);
        const { stdout: mergeBaseOutput } = await runGit(discoveredPath, [
          'merge-base', worktrees[0].HEAD, discovered.HEAD,
        ]).catch(() => ({ stdout: discovered.HEAD || '' }));
        const stat = await fs.stat(discoveredPath).catch(() => null);
        const next = {
          ...existing,
          id: existing?.id || discoveredTreeId(discoveredPath),
          name: existing?.name || (branch === '(detached HEAD)' ? path.basename(discoveredPath) : branch),
          repositoryId: source.id,
          repositoryName: source.name || path.basename(primaryPath),
          repositoryPath: primaryPath,
          path: discoveredPath,
          branch,
          sourceBranch,
          baseCommit: mergeBaseOutput.trim() || discovered.HEAD,
          createdAt: existing?.createdAt || stat?.birthtime?.toISOString() || new Date().toISOString(),
          updatedAt: existing?.updatedAt || new Date().toISOString(),
          taskIds: existing?.taskIds || [],
          chatgptProject: existing?.chatgptProject || null,
          mergeState: existing?.mergeState || null,
          mergeConversationUrl: existing?.mergeConversationUrl || null,
          managed: false,
          discovered: true,
        };
        const index = records.findIndex((item) => item.id === next.id);
        if (index >= 0) records[index] = next;
        else records.push(next);
        byPath.set(discoveredPath, next);
        changed = true;
      }
    }
    if (changed) await this.writeRecords(records);
    return records;
  }

  async create(repositoryPath, requestedName) {
    const repository = await inspectRepository(repositoryPath);
    if (!repository.hasHead) throw new Error('Create the repository’s first commit before starting a coding tree.');
    if (!repository.isClean) throw new Error('Commit or stash local changes before starting a coding tree.');
    if (repository.branch === '(detached HEAD)') throw new Error('Check out a branch before starting a coding tree.');

    const id = crypto.randomUUID();
    const name = String(requestedName || '').trim() || `Task ${id.slice(0, 8)}`;
    if (name.length > 80) throw new Error('Coding tree names must be 80 characters or fewer.');
    const normalizedName = name.toLocaleLowerCase();
    const records = await this.readRecords();
    for (const record of records) {
      const recordedRepositoryPath = await fs.realpath(record.repositoryPath)
        .catch(() => path.resolve(record.repositoryPath));
      if (recordedRepositoryPath !== repository.path
        || String(record.name || '').trim().toLocaleLowerCase() !== normalizedName) continue;
      const existing = await this.inspect(record);
      if (!existing.available) {
        throw new Error(`The existing coding tree “${record.name}” is unavailable: ${existing.error}`);
      }
      if (!existing.clean) {
        throw new Error(`The existing coding tree “${record.name}” has uncommitted changes. Commit them before adding a follow-up task.`);
      }
      return existing;
    }
    const branch = `patchwork/${slugify(name).slice(0, 42)}-${id.slice(0, 8)}`;
    const treePath = path.join(this.worktreesRoot, id);
    await runGit(repository.path, ['worktree', 'add', '-b', branch, treePath, repository.baseCommit]);

    const createdAt = new Date().toISOString();
    const tree = {
      id,
      name,
      repositoryId: repository.id,
      repositoryName: repository.name,
      repositoryPath: repository.path,
      path: treePath,
      branch,
      sourceBranch: repository.branch,
      baseCommit: repository.baseCommit,
      createdAt,
      updatedAt: createdAt,
      taskIds: [],
      chatgptProject: null,
      mergeState: null,
      mergeConversationUrl: null,
      managed: true,
      discovered: false,
    };
    records.push(tree);
    await this.writeRecords(records);
    await this.onEvent({ type: 'tree-created', tree, message: `Created coding tree ${name}.` });
    return this.inspect(tree);
  }

  async inspect(tree) {
    try {
      const repository = await inspectRepository(tree.path);
      const { stdout: countOutput } = await runGit(tree.path, ['rev-list', '--count', `${tree.baseCommit}..HEAD`]);
      const { stdout: lastOutput } = await runGit(tree.path, ['log', '-1', '--pretty=format:%h%x1f%s']);
      const [lastCommit, lastSubject] = lastOutput.split('\x1f');
      return {
        ...tree,
        available: true,
        clean: repository.isClean,
        headCommit: repository.baseCommit,
        commitCount: Number.parseInt(countOutput.trim(), 10) || 0,
        lastCommit: lastCommit || null,
        lastSubject: lastSubject || null,
      };
    } catch (error) {
      return { ...tree, available: false, error: error.message, clean: false, commitCount: 0 };
    }
  }

  async list() {
    return Promise.all((await this.syncDiscoveredWorktrees()).map((tree) => this.inspect(tree)));
  }

  async attachTask(treeId, taskId, chatgptProject = undefined) {
    const records = await this.readRecords();
    const index = records.findIndex((item) => item.id === treeId);
    if (index < 0) throw new Error('The selected coding tree no longer exists.');
    records[index] = {
      ...records[index],
      taskIds: [...new Set([...(records[index].taskIds || []), taskId])],
      updatedAt: new Date().toISOString(),
    };
    if (chatgptProject !== undefined) {
      records[index].chatgptProject = normalizeChatGPTProject(chatgptProject);
    }
    await this.writeRecords(records);
    return this.inspect(records[index]);
  }

  async setChatGPTProject(treeId, project) {
    const records = await this.readRecords();
    const index = records.findIndex((item) => item.id === treeId);
    if (index < 0) throw new Error('The selected coding tree no longer exists.');
    records[index] = {
      ...records[index],
      chatgptProject: normalizeChatGPTProject(project),
      updatedAt: new Date().toISOString(),
    };
    await this.writeRecords(records);
    return this.inspect(records[index]);
  }

  async buildMergeRequest(treeId) {
    const tree = await this.get(treeId);
    const inspected = await this.inspect(tree);
    if (!inspected.available) throw new Error(inspected.error);
    if (!inspected.clean) throw new Error('Commit or discard the coding tree’s local changes before merging it.');
    if (inspected.commitCount === 0) throw new Error('This coding tree has no commits to merge.');
    const [{ stdout: log }, { stdout: stat }] = await Promise.all([
      runGit(tree.path, [
        'log', '--reverse', '--format=commit %H%nsubject: %s%nbody:%n%b%n---', `${tree.baseCommit}..HEAD`,
      ]),
      runGit(tree.path, ['diff', '--stat', tree.baseCommit, 'HEAD', '--', '.']),
    ]);
    const resultFilename = mergeResultFilename(tree.id);
    const prompt = `You are finalizing a Patchwork coding tree. Read the commit history and diff summary below, summarize the combined change, and write one improved Conventional Commit message for the squashed result. The first line must use the Conventional Commits form type(scope): description.\n\nCreate and attach a UTF-8 plain-text file named ${resultFilename}. Its complete contents must be the marked JSON envelope below, with the start and end markers on their own lines. Do not paste the PATCHWORK_MERGE_V1 envelope into the chat. Patchwork will read the text file and apply the squash merge automatically.\n\nPATCHWORK_MERGE_V1\n{"schemaVersion":1,"treeId":"${tree.id}","summary":"concise combined summary","commitMessage":"type(scope): concise description\\n\\nOptional explanatory body"}\nPATCHWORK_MERGE_END\n\nTree: ${tree.name}\nRepository: ${tree.repositoryName}\n\nCommit history:\n${log.trim()}\n\nDiff summary:\n${stat.trim()}`;
    return {
      treeId: tree.id,
      treeName: tree.name,
      resultFilename,
      prompt,
      chatgptProject: tree.chatgptProject || null,
    };
  }

  async markMergeSubmitted(treeId, conversationUrl = null) {
    const records = await this.readRecords();
    const index = records.findIndex((item) => item.id === treeId);
    if (index < 0) throw new Error('The selected coding tree no longer exists.');
    records[index] = {
      ...records[index],
      mergeState: 'submitted',
      mergeError: null,
      mergeConversationUrl: conversationUrl || records[index].mergeConversationUrl || null,
      updatedAt: new Date().toISOString(),
    };
    await this.writeRecords(records);
    return records[index];
  }

  async markMergeFailed(treeId, error) {
    const records = await this.readRecords();
    const index = records.findIndex((item) => item.id === treeId);
    if (index < 0) throw new Error('The selected coding tree no longer exists.');
    records[index] = {
      ...records[index],
      mergeState: 'failed',
      mergeError: String(error?.message || error || 'The coding tree could not be merged.'),
      updatedAt: new Date().toISOString(),
    };
    await this.writeRecords(records);
    return this.inspect(records[index]);
  }

  async clearMergeFailure(treeId, resolvedSourceFingerprint = null) {
    const records = await this.readRecords();
    const index = records.findIndex((item) => item.id === treeId);
    if (index < 0) return null;
    records[index] = {
      ...records[index],
      mergeState: null,
      mergeError: null,
      resolvedSourceFingerprint,
      updatedAt: new Date().toISOString(),
    };
    await this.writeRecords(records);
    return this.inspect(records[index]);
  }

  async mergeFromText(treeId, text) {
    const { commitMessage, summary } = parseMergeResult(text, treeId);
    const tree = await this.get(treeId);
    const source = await inspectRepository(tree.repositoryPath);
    const working = await inspectRepository(tree.path);
    if (!source.hasHead) throw new Error('The original repository needs an initial commit before merging a coding tree.');
    if (source.branch !== tree.sourceBranch) {
      throw new Error(`Check out ${tree.sourceBranch} in the original repository before merging this coding tree.`);
    }
    if (!working.isClean) throw new Error('The coding tree has uncommitted changes.');
    const { stdout: countOutput } = await runGit(tree.path, ['rev-list', '--count', `${tree.baseCommit}..HEAD`]);
    if ((Number.parseInt(countOutput.trim(), 10) || 0) === 0) throw new Error('This coding tree has no commits to merge.');

    const integrationId = crypto.randomUUID();
    const integrationPath = path.join(this.mergesRoot, integrationId);
    const restoreCheckPath = path.join(this.mergesRoot, `${integrationId}-restore-check`);
    let commit = null;
    let stashCommit = null;
    let sourceChangesRestored = source.isClean;
    const sourceFingerprint = source.isClean ? null : await fingerprintRepository(source.path);
    const absorbResolvedSourceChanges = Boolean(
      sourceFingerprint && tree.resolvedSourceFingerprint === sourceFingerprint,
    );
    try {
      if (!source.isClean) {
        await runGit(source.path, [
          'stash', 'push', '--include-untracked', '--message', `Patchwork merge ${tree.id}`,
        ]);
        const { stdout: stashOutput } = await runGit(source.path, ['rev-parse', '--verify', 'refs/stash']);
        stashCommit = stashOutput.trim();
      }

      await runGit(source.path, ['worktree', 'add', '--detach', integrationPath, source.baseCommit]);
      try {
        await runGit(integrationPath, ['merge', '--squash', '--no-commit', tree.branch]);
      } catch (mergeError) {
        const resolved = await this.resolveInsertionOnlyConflicts(integrationPath, tree, integrationId);
        if (!resolved) throw mergeError;
      }
      await runGit(integrationPath, ['commit', '-m', commitMessage]);
      const { stdout } = await runGit(integrationPath, ['rev-parse', 'HEAD']);
      commit = stdout.trim();

      if (stashCommit && !absorbResolvedSourceChanges) {
        await runGit(source.path, ['worktree', 'add', '--detach', restoreCheckPath, commit]);
        try {
          await runGit(restoreCheckPath, ['stash', 'apply', '--index', stashCommit]);
        } catch {
          throw new Error('The coding tree conflicts with local changes in the original repository. The original repository was left unchanged; continue the tree with a conflict-resolution task and try merging again.');
        } finally {
          await runGit(source.path, ['worktree', 'remove', '--force', restoreCheckPath]).catch(() => {});
          await fs.rm(restoreCheckPath, { recursive: true, force: true });
        }
      }

      const sourceBeforeFastForward = await inspectRepository(tree.repositoryPath);
      if (!sourceBeforeFastForward.isClean || sourceBeforeFastForward.baseCommit !== source.baseCommit) {
        throw new Error('The original repository changed while the coding tree was being merged. Try again.');
      }
      await runGit(source.path, ['merge', '--ff-only', commit]);
      if (stashCommit) {
        if (!absorbResolvedSourceChanges) {
          await runGit(source.path, ['stash', 'apply', '--index', stashCommit]);
        }
        sourceChangesRestored = true;
        await runGit(source.path, ['stash', 'drop', 'stash@{0}']).catch(() => {});
      }
    } finally {
      await runGit(source.path, ['worktree', 'remove', '--force', integrationPath]).catch(() => {});
      await fs.rm(integrationPath, { recursive: true, force: true });
      await runGit(source.path, ['worktree', 'remove', '--force', restoreCheckPath]).catch(() => {});
      await fs.rm(restoreCheckPath, { recursive: true, force: true });
      if (stashCommit && !sourceChangesRestored) {
        const currentSource = await inspectRepository(source.path).catch(() => null);
        if (currentSource?.isClean && currentSource.baseCommit === source.baseCommit) {
          await runGit(source.path, ['stash', 'apply', '--index', stashCommit]);
          sourceChangesRestored = true;
          await runGit(source.path, ['stash', 'drop', 'stash@{0}']).catch(() => {});
        }
      }
    }

    await this.remove(treeId, true);
    const result = { treeId, treeName: tree.name, commit, commitMessage, summary, repositoryPath: source.path };
    await this.onEvent({ type: 'tree-merged', result, message: `Merged ${tree.name} as ${commit.slice(0, 9)}.` });
    return result;
  }

  async resolveInsertionOnlyConflicts(integrationPath, tree, integrationId) {
    const { stdout: conflictedOutput } = await runGit(integrationPath, [
      'diff', '--name-only', '--diff-filter=U', '-z', '--', '.',
    ]).catch(() => ({ stdout: '' }));
    const conflictedFiles = conflictedOutput.split('\0').filter(Boolean);
    if (conflictedFiles.length === 0) return false;

    const patchFiles = [];
    try {
      for (const file of conflictedFiles) {
        const { stdout: numstat } = await runGit(integrationPath, [
          'diff', '--numstat', tree.baseCommit, tree.branch, '--', file,
        ]);
        const lines = numstat.trim().split('\n').filter(Boolean);
        if (lines.length !== 1) return false;
        const [added, deleted] = lines[0].split('\t');
        if (!/^\d+$/.test(added) || deleted !== '0') return false;

        await runGit(integrationPath, ['checkout', '--ours', '--', file]);
        const patchName = `${integrationId}-${crypto.createHash('sha256').update(file).digest('hex').slice(0, 12)}.patch`;
        const patchPath = path.join(this.mergesRoot, patchName);
        patchFiles.push(patchPath);
        await runGit(integrationPath, [
          'diff', '--binary', '--unified=0', `--output=${patchPath}`,
          tree.baseCommit, tree.branch, '--', file,
        ]);
        await runGit(integrationPath, ['apply', '--check', '--binary', '--unidiff-zero', patchPath]);
        await runGit(integrationPath, ['apply', '--binary', '--unidiff-zero', patchPath]);
        await runGit(integrationPath, ['add', '--', file]);
      }
      const { stdout: remaining } = await runGit(integrationPath, [
        'diff', '--name-only', '--diff-filter=U', '-z', '--', '.',
      ]);
      return remaining.length === 0;
    } catch {
      return false;
    } finally {
      await Promise.all(patchFiles.map((patchFile) => fs.rm(patchFile, { force: true })));
    }
  }

  async remove(treeId, force = false) {
    const records = await this.readRecords();
    const tree = records.find((item) => item.id === treeId);
    if (!tree) throw new Error('The selected coding tree no longer exists.');
    const inspected = await this.inspect(tree);
    if (!force && inspected.available && (!inspected.clean || inspected.commitCount > 0)) {
      throw new Error('This coding tree contains work. Use the confirmed discard action to remove it.');
    }
    await runGit(tree.repositoryPath, ['worktree', 'remove', ...(force ? ['--force'] : []), tree.path]).catch(async (error) => {
      if (inspected.available) throw error;
    });
    await fs.rm(tree.path, { recursive: true, force: true });
    await runGit(tree.repositoryPath, ['branch', '-D', tree.branch]).catch(() => {});
    await this.writeRecords(records.filter((item) => item.id !== treeId));
    await this.onEvent({ type: 'tree-removed', treeId, message: `Removed coding tree ${tree.name}.` });
    return this.list();
  }
}

module.exports = {
  WorktreeService,
  mergeResultFilename,
  parseMergeResult,
  parseWorktreeList,
  validateCommitMessage,
};
