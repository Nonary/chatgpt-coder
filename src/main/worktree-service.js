const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  fingerprintRepository,
  inspectRepository,
  inspectRepositoryGraph,
  runGit,
  slugify,
} = require('./git');

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

function treeRepositories(tree) {
  if (Array.isArray(tree?.repositories) && tree.repositories.length > 0) {
    if (tree.repositories.length === 1 && tree.path && tree.repositoryPath) {
      return [{
        ...tree.repositories[0],
        repositoryPath: tree.repositoryPath,
        path: tree.path,
        branch: tree.branch || tree.repositories[0].branch,
        sourceBranch: tree.sourceBranch || tree.repositories[0].sourceBranch,
        baseCommit: tree.baseCommit || tree.repositories[0].baseCommit,
      }];
    }
    return tree.repositories;
  }
  if (!tree?.repositoryPath || !tree?.path) return [];
  return [{
    id: tree.repositoryId,
    repositoryId: tree.repositoryId,
    repositoryName: tree.repositoryName,
    repositoryPath: tree.repositoryPath,
    path: tree.path,
    branch: tree.branch,
    sourceBranch: tree.sourceBranch,
    sourceDetached: false,
    sourceCheckoutCommit: tree.baseCommit,
    baseCommit: tree.baseCommit,
    parentRepositoryId: null,
    submodulePath: null,
    depth: 0,
  }];
}

function sameStrings(left, right) {
  const a = [...new Set(left || [])].sort();
  const b = [...new Set(right || [])].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function resolveBranchCommit(repositoryPath, branch) {
  const { stdout } = await runGit(repositoryPath, ['rev-parse', '--verify', `refs/heads/${branch}`]);
  return stdout.trim();
}

async function dropStashCommit(repositoryPath, stashCommit) {
  if (!stashCommit) return;
  const { stdout } = await runGit(repositoryPath, ['stash', 'list', '--format=%gd%x00%H']);
  const entry = stdout.split(/\r?\n/).map((line) => line.split('\0')).find(([, commit]) => commit === stashCommit);
  if (entry?.[0]) await runGit(repositoryPath, ['stash', 'drop', entry[0]]);
}

async function branchExists(repositoryPath, branch) {
  if (!branch || branch === '(detached HEAD)') return false;
  return runGit(repositoryPath, ['rev-parse', '--verify', `refs/heads/${branch}`])
    .then(() => true)
    .catch(() => false);
}

function chooseBranch(candidates, preferred = []) {
  const unique = [...new Set(candidates.filter(Boolean))];
  for (const branch of preferred) {
    if (unique.includes(branch)) return branch;
  }
  return unique.sort((left, right) => left.localeCompare(right))[0] || null;
}

async function resolveSourceBranch(repository, configuredBranch, parentSourceBranch) {
  if (repository.branch !== '(detached HEAD)') return repository.branch;

  let configured = String(configuredBranch || '').trim();
  if (configured === '.') configured = parentSourceBranch || '';
  configured = configured.replace(/^refs\/heads\//, '');
  if (configured && await branchExists(repository.path, configured)) return configured;

  const { stdout: pointsAtOutput } = await runGit(repository.path, [
    'for-each-ref', '--format=%(refname:short)', '--points-at=HEAD', 'refs/heads',
  ]);
  const pointsAt = pointsAtOutput.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const direct = chooseBranch(pointsAt, [configured, parentSourceBranch, 'main', 'master']);
  if (direct) return direct;

  const { stdout: containsOutput } = await runGit(repository.path, [
    'for-each-ref', '--format=%(refname:short)', '--contains=HEAD', 'refs/heads',
  ]);
  const contains = containsOutput.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const containing = chooseBranch(contains, [configured, parentSourceBranch, 'main', 'master']);
  if (containing) return containing;

  throw new Error(`Submodule ${repository.name} is detached and Patchwork could not determine a local branch to merge back into.`);
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
    if (taskId && task?.treeId) {
      const attached = trees.find((tree) => tree.id === task.treeId
        && Array.isArray(tree.taskIds) && tree.taskIds.includes(taskId));
      if (attached) {
        const inspected = await this.inspect(attached);
        if (inspected.available) return inspected;
      }
    }

    const repositoryPaths = (Array.isArray(task?.repositories) ? task.repositories : [])
      .filter((repository) => repository?.path && !repository.readOnly)
      .map((repository) => repository.path);
    if (repositoryPaths.length === 0) return null;

    const resolvedPaths = new Set(await Promise.all(repositoryPaths.map((repositoryPath) =>
      fs.realpath(repositoryPath).catch(() => path.resolve(repositoryPath)))));
    for (const tree of trees) {
      const treePaths = new Set(await Promise.all(treeRepositories(tree).map((repository) =>
        fs.realpath(repository.path).catch(() => path.resolve(repository.path)))));
      if (![...resolvedPaths].every((repositoryPath) => treePaths.has(repositoryPath))) continue;
      const inspected = await this.inspect(tree);
      if (inspected.available) return inspected;
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
      for (const member of treeRepositories(record)) {
        const resolvedPath = await fs.realpath(member.path).catch(() => path.resolve(member.path));
        byPath.set(resolvedPath, record);
      }
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
        const repositoryId = source.id;
        const member = {
          id: repositoryId,
          repositoryId,
          repositoryName: source.name || path.basename(primaryPath),
          repositoryPath: primaryPath,
          path: discoveredPath,
          branch,
          sourceBranch,
          sourceDetached: false,
          sourceCheckoutCommit: worktrees[0].HEAD,
          baseCommit: mergeBaseOutput.trim() || discovered.HEAD,
          parentRepositoryId: null,
          submodulePath: null,
          depth: 0,
        };
        const next = {
          ...existing,
          id: existing?.id || discoveredTreeId(discoveredPath),
          name: existing?.name || (branch === '(detached HEAD)' ? path.basename(discoveredPath) : branch),
          repositoryId,
          repositoryName: member.repositoryName,
          repositoryPath: primaryPath,
          path: discoveredPath,
          branch,
          sourceBranch,
          baseCommit: member.baseCommit,
          repositories: [member],
          rootRepositoryPaths: [primaryPath],
          createdAt: existing?.createdAt || stat?.birthtime?.toISOString() || new Date().toISOString(),
          updatedAt: existing?.updatedAt || new Date().toISOString(),
          taskIds: existing?.taskIds || [],
          chatgptProject: existing?.chatgptProject || null,
          mergeState: existing?.mergeState || null,
          mergeConversationUrl: existing?.mergeConversationUrl || null,
          resolvedSourceFingerprints: existing?.resolvedSourceFingerprints || {},
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

  async create(repositoryPaths, requestedName) {
    const selectedPaths = Array.isArray(repositoryPaths) ? repositoryPaths : [repositoryPaths];
    if (selectedPaths.length === 0 || selectedPaths.some((item) => !item)) {
      throw new Error('Choose at least one repository before starting a coding tree.');
    }
    const graph = await inspectRepositoryGraph(selectedPaths);
    const rootRepositories = graph.filter((repository) => !repository.parentPath);
    for (const repository of graph) {
      if (!repository.hasHead) throw new Error(`Create ${repository.name}’s first commit before starting a coding tree.`);
      if (!repository.isClean) throw new Error(`Commit or stash local changes in ${repository.name} before starting a coding tree.`);
      if (!repository.parentPath && repository.branch === '(detached HEAD)') {
        throw new Error(`Check out a branch in ${repository.name} before starting a coding tree.`);
      }
    }

    const id = crypto.randomUUID();
    const name = String(requestedName || '').trim() || `Task ${id.slice(0, 8)}`;
    if (name.length > 80) throw new Error('Coding tree names must be 80 characters or fewer.');
    const normalizedName = name.toLocaleLowerCase();
    const rootRepositoryPaths = rootRepositories.map((repository) => repository.path).sort();
    const records = await this.readRecords();
    for (const record of records) {
      const recordedRoots = record.rootRepositoryPaths || [record.repositoryPath].filter(Boolean);
      if (!sameStrings(recordedRoots, rootRepositoryPaths)
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
    const treeRoot = path.join(this.worktreesRoot, id);
    if (rootRepositories.length > 1) await fs.mkdir(treeRoot, { recursive: true });
    const membersBySourcePath = new Map();
    const created = [];
    try {
      let rootIndex = 0;
      for (const repository of graph) {
        const parent = repository.parentPath ? membersBySourcePath.get(repository.parentPath) : null;
        const sourceBranch = await resolveSourceBranch(
          repository,
          repository.configuredBranch,
          parent ? parent.sourceBranch : null,
        );
        let treePath;
        if (parent) {
          treePath = path.join(parent.path, repository.submodulePath);
          await fs.rm(treePath, { recursive: true, force: true });
          await fs.mkdir(path.dirname(treePath), { recursive: true });
        } else if (rootRepositories.length === 1) {
          treePath = treeRoot;
        } else {
          rootIndex += 1;
          treePath = path.join(
            treeRoot,
            `${String(rootIndex).padStart(2, '0')}-${slugify(repository.name).slice(0, 30)}-${repository.id.slice(-8)}`,
          );
        }
        await runGit(repository.path, ['worktree', 'add', '-b', branch, treePath, repository.baseCommit]);
        const resolvedTreePath = await fs.realpath(treePath);
        const member = {
          id: repository.id,
          repositoryId: repository.id,
          repositoryName: repository.name,
          repositoryPath: repository.path,
          path: resolvedTreePath,
          branch,
          sourceBranch,
          sourceDetached: repository.branch === '(detached HEAD)',
          sourceCheckoutCommit: repository.baseCommit,
          baseCommit: repository.baseCommit,
          parentRepositoryId: parent?.repositoryId || null,
          submodulePath: repository.submodulePath || null,
          depth: repository.depth || 0,
        };
        membersBySourcePath.set(repository.path, member);
        created.push(member);
      }
    } catch (error) {
      for (const member of [...created].sort((left, right) => right.depth - left.depth)) {
        await runGit(member.repositoryPath, ['worktree', 'remove', '--force', member.path]).catch(() => {});
        await runGit(member.repositoryPath, ['branch', '-D', branch]).catch(() => {});
      }
      await fs.rm(treeRoot, { recursive: true, force: true });
      throw error;
    }

    const members = [...created].sort((left, right) => left.depth - right.depth || left.repositoryPath.localeCompare(right.repositoryPath));
    const primary = members.find((member) => !member.parentRepositoryId) || members[0];
    const createdAt = new Date().toISOString();
    const tree = {
      id,
      name,
      repositoryId: primary.repositoryId,
      repositoryName: rootRepositories.length > 1 ? `${primary.repositoryName} + ${rootRepositories.length - 1}` : primary.repositoryName,
      repositoryPath: primary.repositoryPath,
      path: primary.path,
      branch,
      sourceBranch: primary.sourceBranch,
      baseCommit: primary.baseCommit,
      repositories: members,
      rootRepositoryPaths,
      createdAt,
      updatedAt: createdAt,
      taskIds: [],
      chatgptProject: null,
      mergeState: null,
      mergeConversationUrl: null,
      resolvedSourceFingerprint: null,
      resolvedSourceFingerprints: {},
      managed: true,
      discovered: false,
    };
    records.push(tree);
    await this.writeRecords(records);
    await this.onEvent({ type: 'tree-created', tree, message: `Created coding tree ${name} across ${members.length} ${members.length === 1 ? 'repository' : 'repositories'}.` });
    return this.inspect(tree);
  }

  async inspect(tree) {
    try {
      const members = [];
      for (const member of treeRepositories(tree)) {
        const repository = await inspectRepository(member.path);
        const { stdout: countOutput } = await runGit(member.path, ['rev-list', '--count', `${member.baseCommit}..HEAD`]);
        const commitCount = Number.parseInt(countOutput.trim(), 10) || 0;
        let lastCommit = null;
        let lastSubject = null;
        let lastTimestamp = 0;
        if (commitCount > 0) {
          const { stdout: lastOutput } = await runGit(member.path, ['log', '-1', '--pretty=format:%ct%x1f%h%x1f%s']);
          const [timestamp, commit, subject] = lastOutput.split('\x1f');
          lastTimestamp = Number.parseInt(timestamp, 10) || 0;
          lastCommit = commit || null;
          lastSubject = subject || null;
        }
        members.push({
          ...member,
          available: true,
          clean: repository.isClean,
          headCommit: repository.baseCommit,
          commitCount,
          lastCommit,
          lastSubject,
          lastTimestamp,
        });
      }
      const primary = members.find((member) => !member.parentRepositoryId) || members[0];
      const latest = [...members].sort((left, right) => right.lastTimestamp - left.lastTimestamp)[0] || primary;
      return {
        ...tree,
        repositories: members,
        repositoryId: primary?.repositoryId || tree.repositoryId,
        repositoryName: tree.repositoryName || primary?.repositoryName,
        repositoryPath: primary?.repositoryPath || tree.repositoryPath,
        path: primary?.path || tree.path,
        branch: primary?.branch || tree.branch,
        sourceBranch: primary?.sourceBranch || tree.sourceBranch,
        baseCommit: primary?.baseCommit || tree.baseCommit,
        available: true,
        clean: members.every((member) => member.clean),
        headCommit: primary?.headCommit || null,
        commitCount: members.reduce((total, member) => total + member.commitCount, 0),
        repositoryCount: members.length,
        lastCommit: latest?.lastCommit || null,
        lastSubject: latest?.lastSubject || null,
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

  async detachTask(treeId, taskId) {
    const records = await this.readRecords();
    const index = records.findIndex((item) => item.id === treeId);
    if (index < 0) return null;
    const nextTaskIds = (records[index].taskIds || []).filter((id) => id !== taskId);
    if (nextTaskIds.length === records[index].taskIds?.length) return this.inspect(records[index]);
    records[index] = {
      ...records[index],
      taskIds: nextTaskIds,
      updatedAt: new Date().toISOString(),
    };
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

    const sections = [];
    for (const member of inspected.repositories) {
      if (!member.commitCount) continue;
      const [{ stdout: log }, { stdout: stat }] = await Promise.all([
        runGit(member.path, [
          'log', '--reverse', '--format=commit %H%nsubject: %s%nbody:%n%b%n---', `${member.baseCommit}..HEAD`,
        ]),
        runGit(member.path, ['diff', '--stat', member.baseCommit, 'HEAD', '--', '.']),
      ]);
      sections.push(`Repository: ${member.repositoryName}\nDestination branch: ${member.sourceBranch}\n${member.submodulePath ? `Submodule path: ${member.submodulePath}\n` : ''}\nCommit history:\n${log.trim()}\n\nDiff summary:\n${stat.trim()}`);
    }
    const resultFilename = mergeResultFilename(tree.id);
    const prompt = `You are finalizing a Patchwork coding tree spanning ${inspected.repositories.length} ${inspected.repositories.length === 1 ? 'repository' : 'repositories'}, including recursive submodules when present. Read the commit histories and diff summaries below, summarize the combined change, and write one improved Conventional Commit message for the squashed result. Patchwork will use that message while merging every changed repository back into its original branch and updating parent submodule pointers. The first line must use the Conventional Commits form type(scope): description.\n\nCreate and attach a UTF-8 plain-text file named ${resultFilename}. Its complete contents must be the marked JSON envelope below, with the start and end markers on their own lines. Do not paste the PATCHWORK_MERGE_V1 envelope into the chat. Patchwork will read the text file and apply the squash merge automatically.\n\nPATCHWORK_MERGE_V1\n{"schemaVersion":1,"treeId":"${tree.id}","summary":"concise combined summary","commitMessage":"type(scope): concise description\\n\\nOptional explanatory body"}\nPATCHWORK_MERGE_END\n\nTree: ${tree.name}\n\n${sections.join('\n\n---\n\n')}`;
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

  async clearMergeFailure(treeId, resolvedSourceFingerprints = null) {
    const records = await this.readRecords();
    const index = records.findIndex((item) => item.id === treeId);
    if (index < 0) return null;
    const primaryId = treeRepositories(records[index])[0]?.repositoryId;
    const normalizedFingerprints = typeof resolvedSourceFingerprints === 'string'
      ? (resolvedSourceFingerprints && primaryId ? { [primaryId]: resolvedSourceFingerprints } : {})
      : (resolvedSourceFingerprints && typeof resolvedSourceFingerprints === 'object' ? resolvedSourceFingerprints : {});
    records[index] = {
      ...records[index],
      mergeState: null,
      mergeError: null,
      resolvedSourceFingerprint: primaryId ? normalizedFingerprints[primaryId] || null : null,
      resolvedSourceFingerprints: normalizedFingerprints,
      updatedAt: new Date().toISOString(),
    };
    await this.writeRecords(records);
    return this.inspect(records[index]);
  }

  async mergeFromText(treeId, text) {
    const { commitMessage, summary } = parseMergeResult(text, treeId);
    const tree = await this.get(treeId);
    const inspected = await this.inspect(tree);
    if (!inspected.available) throw new Error(inspected.error);
    if (!inspected.clean) throw new Error('The coding tree has uncommitted changes.');

    const members = inspected.repositories.map((member) => ({ ...member }));
    const needed = new Set(members.filter((member) => member.commitCount > 0).map((member) => member.repositoryId));
    for (const member of [...members].sort((left, right) => right.depth - left.depth)) {
      if (needed.has(member.repositoryId) && member.parentRepositoryId) needed.add(member.parentRepositoryId);
    }
    if (needed.size === 0) throw new Error('This coding tree has no commits to merge.');

    const resolvedFingerprints = {
      ...(tree.resolvedSourceFingerprints || {}),
    };
    if (tree.resolvedSourceFingerprint && inspected.repositoryId && !resolvedFingerprints[inspected.repositoryId]) {
      resolvedFingerprints[inspected.repositoryId] = tree.resolvedSourceFingerprint;
    }

    const states = [];
    for (const member of members.filter((item) => needed.has(item.repositoryId))) {
      const source = await inspectRepository(member.repositoryPath);
      const working = await inspectRepository(member.path);
      if (!source.hasHead) throw new Error(`${member.repositoryName} needs an initial commit before merging this coding tree.`);
      if (working.branch !== member.branch) {
        throw new Error(`Check out ${member.branch} in the ${member.repositoryName} coding tree before merging it.`);
      }
      if (member.sourceDetached) {
        if (source.branch !== '(detached HEAD)' && source.branch !== member.sourceBranch) {
          throw new Error(`Check out ${member.sourceBranch} or the original detached submodule commit in ${member.repositoryName} before merging this coding tree.`);
        }
        if (source.branch === '(detached HEAD)' && source.baseCommit !== member.sourceCheckoutCommit) {
          throw new Error(`Restore the original detached submodule commit in ${member.repositoryName}, or check out ${member.sourceBranch}, before merging this coding tree.`);
        }
        const { stdout: worktreeOutput } = await runGit(member.repositoryPath, ['worktree', 'list', '--porcelain', '-z']);
        const conflictingCheckout = parseWorktreeList(worktreeOutput).find((item) => (
          branchName(item.branch) === member.sourceBranch
          && path.resolve(item.path) !== path.resolve(member.repositoryPath)
        ));
        if (conflictingCheckout) {
          throw new Error(`${member.repositoryName} branch ${member.sourceBranch} is checked out in another worktree. Close or use that checkout before merging the coding tree.`);
        }
      } else if (source.branch !== member.sourceBranch) {
        throw new Error(`Check out ${member.sourceBranch} in ${member.repositoryName} before merging this coding tree.`);
      }
      const sourceBranchCommit = await resolveBranchCommit(member.repositoryPath, member.sourceBranch);
      const sourceFingerprint = source.isClean ? null : await fingerprintRepository(source.path);
      states.push({
        member,
        source,
        sourceBranchCommit,
        sourceCheckoutCommit: source.baseCommit,
        sourceFingerprint,
        absorbResolvedSourceChanges: Boolean(
          sourceFingerprint && resolvedFingerprints[member.repositoryId] === sourceFingerprint,
        ),
        stashCommit: null,
        stashApplied: false,
        stashRestored: source.isClean,
        integrationPath: null,
        restoreCheckPath: null,
        integrationCommit: null,
        advanced: false,
      });
    }

    const integrationId = crypto.randomUUID();
    const integrationRoot = path.join(this.mergesRoot, integrationId);
    const integrationCommits = new Map();
    let sourceUpdatesStarted = false;
    let mergeCompleted = false;
    await fs.mkdir(integrationRoot, { recursive: true });
    try {
      for (const state of [...states].sort((left, right) => right.member.depth - left.member.depth)) {
        const current = await inspectRepository(state.member.repositoryPath);
        if (current.isClean) {
          state.stashRestored = true;
          continue;
        }
        await runGit(state.member.repositoryPath, [
          'stash', 'push', '--include-untracked', '--message', `Patchwork merge ${tree.id}`,
        ]);
        const { stdout: stashOutput } = await runGit(state.member.repositoryPath, ['rev-parse', '--verify', 'refs/stash']);
        state.stashCommit = stashOutput.trim();
        state.stashRestored = false;
      }

      for (const state of [...states].sort((left, right) => right.member.depth - left.member.depth)) {
        const member = state.member;
        state.integrationPath = path.join(integrationRoot, `merge-${member.repositoryId}`);
        await runGit(member.repositoryPath, ['worktree', 'add', '--detach', state.integrationPath, state.sourceBranchCommit]);
        if (member.commitCount > 0) {
          try {
            await runGit(state.integrationPath, ['merge', '--squash', '--no-commit', member.branch]);
          } catch (mergeError) {
            const resolved = await this.resolveInsertionOnlyConflicts(state.integrationPath, member, integrationId);
            if (!resolved) throw mergeError;
          }
        }

        const children = members.filter((child) => child.parentRepositoryId === member.repositoryId);
        for (const child of children) {
          const childCommit = integrationCommits.get(child.repositoryId);
          if (!childCommit) continue;
          await runGit(state.integrationPath, [
            'update-index', '--add', '--cacheinfo', '160000', childCommit, child.submodulePath,
          ]);
        }

        const { stdout: stagedOutput } = await runGit(state.integrationPath, ['diff', '--cached', '--name-only', '-z']);
        if (stagedOutput.length > 0) {
          await runGit(state.integrationPath, ['commit', '-m', commitMessage]);
          const { stdout } = await runGit(state.integrationPath, ['rev-parse', 'HEAD']);
          state.integrationCommit = stdout.trim();
        } else {
          state.integrationCommit = state.sourceBranchCommit;
        }
        integrationCommits.set(member.repositoryId, state.integrationCommit);
      }

      for (const state of states) {
        if (!state.stashCommit || state.absorbResolvedSourceChanges) continue;
        state.restoreCheckPath = path.join(integrationRoot, `restore-${state.member.repositoryId}`);
        await runGit(state.member.repositoryPath, ['worktree', 'add', '--detach', state.restoreCheckPath, state.integrationCommit]);
        try {
          await runGit(state.restoreCheckPath, ['stash', 'apply', '--index', state.stashCommit]);
        } catch {
          throw new Error(`The coding tree conflicts with local changes in ${state.member.repositoryName}. The original repositories were left unchanged; continue the tree with a conflict-resolution task and try merging again.`);
        } finally {
          await runGit(state.member.repositoryPath, ['worktree', 'remove', '--force', state.restoreCheckPath]).catch(() => {});
          await fs.rm(state.restoreCheckPath, { recursive: true, force: true });
          state.restoreCheckPath = null;
        }
      }

      for (const state of states) {
        const current = await inspectRepository(state.member.repositoryPath);
        const branchCommit = await resolveBranchCommit(state.member.repositoryPath, state.member.sourceBranch);
        const checkoutChanged = state.member.sourceDetached && current.baseCommit !== state.sourceCheckoutCommit;
        if (!current.isClean || branchCommit !== state.sourceBranchCommit || checkoutChanged) {
          throw new Error(`${state.member.repositoryName} changed while the coding tree was being merged. Try again.`);
        }
        if (!state.member.sourceDetached && current.branch !== state.member.sourceBranch) {
          throw new Error(`Check out ${state.member.sourceBranch} in ${state.member.repositoryName} before merging this coding tree.`);
        }
      }

      sourceUpdatesStarted = true;
      for (const state of [...states].sort((left, right) => left.member.depth - right.member.depth)) {
        if (state.integrationCommit === state.sourceBranchCommit) continue;
        const current = await inspectRepository(state.member.repositoryPath);
        if (current.branch === state.member.sourceBranch) {
          await runGit(state.member.repositoryPath, ['merge', '--ff-only', state.integrationCommit]);
        } else {
          await runGit(state.member.repositoryPath, [
            'update-ref', `refs/heads/${state.member.sourceBranch}`, state.integrationCommit, state.sourceBranchCommit,
          ]);
          await runGit(state.member.repositoryPath, ['reset', '--hard', state.integrationCommit]);
        }
        state.advanced = true;
      }

      for (const state of [...states].sort((left, right) => right.member.depth - left.member.depth)) {
        if (!state.stashCommit) continue;
        if (!state.absorbResolvedSourceChanges) {
          await runGit(state.member.repositoryPath, ['stash', 'apply', '--index', state.stashCommit]);
          state.stashApplied = true;
          state.stashRestored = true;
        }
      }
      mergeCompleted = true;
      for (const state of states) {
        if (!state.stashCommit) continue;
        await dropStashCommit(state.member.repositoryPath, state.stashCommit).catch(() => {});
        if (state.absorbResolvedSourceChanges) state.stashRestored = true;
      }
    } catch (error) {
      if (sourceUpdatesStarted && !mergeCompleted) {
        for (const state of [...states].sort((left, right) => right.member.depth - left.member.depth)) {
          if (!state.advanced) continue;
          try {
            const current = await inspectRepository(state.member.repositoryPath);
            if (current.branch === state.member.sourceBranch) {
              await runGit(state.member.repositoryPath, ['reset', '--hard', state.sourceBranchCommit]);
            } else {
              await runGit(state.member.repositoryPath, [
                'update-ref', `refs/heads/${state.member.sourceBranch}`, state.sourceBranchCommit, state.integrationCommit,
              ]);
              await runGit(state.member.repositoryPath, ['reset', '--hard', state.sourceCheckoutCommit]);
            }
            state.advanced = false;
          } catch {
            // Keep the original merge error; the branch remains recoverable from the saved coding tree.
          }
        }
        for (const state of states) {
          if (!state.stashApplied) continue;
          state.stashApplied = false;
          state.stashRestored = false;
        }
      }
      throw error;
    } finally {
      for (const state of states) {
        if (state.integrationPath) {
          await runGit(state.member.repositoryPath, ['worktree', 'remove', '--force', state.integrationPath]).catch(() => {});
          await fs.rm(state.integrationPath, { recursive: true, force: true });
        }
        if (state.restoreCheckPath) {
          await runGit(state.member.repositoryPath, ['worktree', 'remove', '--force', state.restoreCheckPath]).catch(() => {});
          await fs.rm(state.restoreCheckPath, { recursive: true, force: true });
        }
      }
      await fs.rm(integrationRoot, { recursive: true, force: true });
      if (!mergeCompleted) {
        for (const state of [...states].sort((left, right) => right.member.depth - left.member.depth)) {
          if (!state.stashCommit || state.stashRestored) continue;
          const current = await inspectRepository(state.member.repositoryPath).catch(() => null);
          const branchCommit = await resolveBranchCommit(state.member.repositoryPath, state.member.sourceBranch).catch(() => null);
          if (current?.isClean && branchCommit === state.sourceBranchCommit) {
            try {
              await runGit(state.member.repositoryPath, ['stash', 'apply', '--index', state.stashCommit]);
              await dropStashCommit(state.member.repositoryPath, state.stashCommit);
              state.stashRestored = true;
            } catch {
              // Preserve the saved stash when restoring local changes still conflicts.
            }
          }
        }
      }
    }

    await this.remove(treeId, true);
    const primaryState = states.find((state) => state.member.repositoryId === inspected.repositoryId) || states[0];
    const result = {
      treeId,
      treeName: tree.name,
      commit: primaryState?.integrationCommit || null,
      commits: states.map((state) => ({
        repositoryId: state.member.repositoryId,
        repositoryName: state.member.repositoryName,
        repositoryPath: state.member.repositoryPath,
        branch: state.member.sourceBranch,
        commit: state.integrationCommit,
      })),
      commitMessage,
      summary,
      repositoryPath: inspected.repositoryPath,
    };
    await this.onEvent({ type: 'tree-merged', result, message: `Merged ${tree.name} across ${states.length} ${states.length === 1 ? 'repository' : 'repositories'}.` });
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
        const patchName = `${integrationId}-${crypto.createHash('sha256').update(`${tree.repositoryId}:${file}`).digest('hex').slice(0, 12)}.patch`;
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
    const members = treeRepositories(tree).sort((left, right) => right.depth - left.depth);
    for (const member of members) {
      await runGit(member.repositoryPath, ['worktree', 'remove', ...(force ? ['--force'] : []), member.path]).catch(async (error) => {
        if (inspected.available) throw error;
      });
      await fs.rm(member.path, { recursive: true, force: true });
    }
    for (const member of members) {
      await runGit(member.repositoryPath, ['branch', '-D', member.branch]).catch(() => {});
    }
    if (tree.managed !== false) await fs.rm(path.join(this.worktreesRoot, tree.id), { recursive: true, force: true });
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
