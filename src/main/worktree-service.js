const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { inspectRepository, runGit, slugify } = require('./git');

const MERGE_RESULT_START = 'PATCHWORK_MERGE_V1';
const MERGE_RESULT_END = 'PATCHWORK_MERGE_END';
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

class WorktreeService {
  constructor(dataRoot, onEvent = () => {}) {
    this.dataRoot = dataRoot;
    this.worktreesRoot = path.join(dataRoot, 'worktrees');
    this.mergesRoot = path.join(dataRoot, 'merge-workspaces');
    this.recordsFile = path.join(dataRoot, 'worktrees.json');
    this.onEvent = onEvent;
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
    const tree = (await this.readRecords()).find((item) => item.id === treeId);
    if (!tree) throw new Error('The selected coding tree no longer exists.');
    return tree;
  }

  async create(repositoryPath, requestedName) {
    const repository = await inspectRepository(repositoryPath);
    if (!repository.hasHead) throw new Error('Create the repository’s first commit before starting a coding tree.');
    if (!repository.isClean) throw new Error('Commit or stash local changes before starting a coding tree.');
    if (repository.branch === '(detached HEAD)') throw new Error('Check out a branch before starting a coding tree.');

    const id = crypto.randomUUID();
    const name = String(requestedName || '').trim() || `Task ${id.slice(0, 8)}`;
    if (name.length > 80) throw new Error('Coding tree names must be 80 characters or fewer.');
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
      mergeState: null,
      mergeConversationUrl: null,
    };
    const records = await this.readRecords();
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
    return Promise.all((await this.readRecords()).map((tree) => this.inspect(tree)));
  }

  async attachTask(treeId, taskId) {
    const records = await this.readRecords();
    const index = records.findIndex((item) => item.id === treeId);
    if (index < 0) throw new Error('The selected coding tree no longer exists.');
    records[index] = {
      ...records[index],
      taskIds: [...new Set([...(records[index].taskIds || []), taskId])],
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
    const prompt = `You are finalizing a Patchwork coding tree. Read the commit history and diff summary below, summarize the combined change, and write one improved Conventional Commit message for the squashed result. The first line must use the Conventional Commits form type(scope): description. Return only the marked JSON envelope.\n\nPATCHWORK_MERGE_V1\n{"schemaVersion":1,"treeId":"${tree.id}","summary":"concise combined summary","commitMessage":"type(scope): concise description\\n\\nOptional explanatory body"}\nPATCHWORK_MERGE_END\n\nTree: ${tree.name}\nRepository: ${tree.repositoryName}\n\nCommit history:\n${log.trim()}\n\nDiff summary:\n${stat.trim()}`;
    return { treeId: tree.id, treeName: tree.name, prompt };
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

  async mergeFromText(treeId, text) {
    const { commitMessage, summary } = parseMergeResult(text, treeId);
    const tree = await this.get(treeId);
    const source = await inspectRepository(tree.repositoryPath);
    const working = await inspectRepository(tree.path);
    if (!source.hasHead || !source.isClean) throw new Error('The original repository must be clean before merging a coding tree.');
    if (source.branch !== tree.sourceBranch) {
      throw new Error(`Check out ${tree.sourceBranch} in the original repository before merging this coding tree.`);
    }
    if (!working.isClean) throw new Error('The coding tree has uncommitted changes.');
    const { stdout: countOutput } = await runGit(tree.path, ['rev-list', '--count', `${tree.baseCommit}..HEAD`]);
    if ((Number.parseInt(countOutput.trim(), 10) || 0) === 0) throw new Error('This coding tree has no commits to merge.');

    const integrationId = crypto.randomUUID();
    const integrationPath = path.join(this.mergesRoot, integrationId);
    let commit = null;
    try {
      await runGit(source.path, ['worktree', 'add', '--detach', integrationPath, source.baseCommit]);
      await runGit(integrationPath, ['merge', '--squash', '--no-commit', tree.branch]);
      await runGit(integrationPath, ['commit', '-m', commitMessage]);
      const { stdout } = await runGit(integrationPath, ['rev-parse', 'HEAD']);
      commit = stdout.trim();

      const sourceBeforeFastForward = await inspectRepository(tree.repositoryPath);
      if (!sourceBeforeFastForward.isClean || sourceBeforeFastForward.baseCommit !== source.baseCommit) {
        throw new Error('The original repository changed while the coding tree was being merged. Try again.');
      }
      await runGit(source.path, ['merge', '--ff-only', commit]);
    } finally {
      await runGit(source.path, ['worktree', 'remove', '--force', integrationPath]).catch(() => {});
      await fs.rm(integrationPath, { recursive: true, force: true });
    }

    await this.remove(treeId, true);
    const result = { treeId, treeName: tree.name, commit, commitMessage, summary, repositoryPath: source.path };
    await this.onEvent({ type: 'tree-merged', result, message: `Merged ${tree.name} as ${commit.slice(0, 9)}.` });
    return result;
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

module.exports = { WorktreeService, parseMergeResult, validateCommitMessage };
