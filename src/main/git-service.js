const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { inspectRepository, runGit } = require('./git');

const STATUS_LABELS = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  U: 'Unmerged',
  T: 'Type changed',
  '?': 'Untracked',
  '!': 'Ignored',
};

const MAX_DIFF_PREVIEW = 500_000;
const MAX_COMPARE_ROWS = 20_000;

function splitLines(value) {
  if (!value) return [];
  const lines = String(value).split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function parseDiffHunks(content) {
  const hunks = [];
  for (const line of String(content || '').split('\n')) {
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    hunks.push({
      beforeStart: Number(match[1]),
      beforeCount: match[2] === undefined ? 1 : Number(match[2]),
      afterStart: Number(match[3]),
      afterCount: match[4] === undefined ? 1 : Number(match[4]),
    });
  }
  return hunks;
}

function buildCompareRows(beforeText, afterText, diffContent) {
  const beforeLines = splitLines(beforeText);
  const afterLines = splitLines(afterText);
  const hunks = parseDiffHunks(diffContent);
  const rows = [];

  const pushRow = (beforeIndex, afterIndex, beforeType = 'unchanged', afterType = 'unchanged') => {
    if (rows.length >= MAX_COMPARE_ROWS) return false;
    const hasBefore = Number.isInteger(beforeIndex) && beforeIndex >= 0 && beforeIndex < beforeLines.length;
    const hasAfter = Number.isInteger(afterIndex) && afterIndex >= 0 && afterIndex < afterLines.length;
    rows.push({
      beforeNumber: hasBefore ? beforeIndex + 1 : null,
      beforeText: hasBefore ? beforeLines[beforeIndex] : '',
      beforeType: hasBefore ? beforeType : 'empty',
      afterNumber: hasAfter ? afterIndex + 1 : null,
      afterText: hasAfter ? afterLines[afterIndex] : '',
      afterType: hasAfter ? afterType : 'empty',
    });
    return true;
  };

  if (hunks.length === 0 && beforeText !== afterText) {
    const changedCount = Math.max(beforeLines.length, afterLines.length);
    for (let index = 0; index < changedCount && rows.length < MAX_COMPARE_ROWS; index += 1) {
      pushRow(index, index, 'removed', 'added');
    }
    return rows;
  }

  let beforeCursor = 0;
  let afterCursor = 0;
  for (const hunk of hunks) {
    const beforeTarget = hunk.beforeStart === 0 ? 0 : hunk.beforeStart - 1;
    const afterTarget = hunk.afterStart === 0 ? 0 : hunk.afterStart - 1;
    if (beforeTarget >= beforeLines.length && afterTarget >= afterLines.length) break;

    while (beforeCursor < beforeTarget || afterCursor < afterTarget) {
      if (rows.length >= MAX_COMPARE_ROWS) return rows;
      const beforeIndex = beforeCursor < beforeTarget ? beforeCursor : null;
      const afterIndex = afterCursor < afterTarget ? afterCursor : null;
      pushRow(beforeIndex, afterIndex);
      if (beforeIndex !== null) beforeCursor += 1;
      if (afterIndex !== null) afterCursor += 1;
    }

    const availableBefore = Math.max(0, Math.min(hunk.beforeCount, beforeLines.length - beforeTarget));
    const availableAfter = Math.max(0, Math.min(hunk.afterCount, afterLines.length - afterTarget));
    const changedCount = Math.max(availableBefore, availableAfter);
    for (let offset = 0; offset < changedCount; offset += 1) {
      if (!pushRow(
        offset < availableBefore ? beforeTarget + offset : null,
        offset < availableAfter ? afterTarget + offset : null,
        'removed',
        'added',
      )) return rows;
    }
    beforeCursor = Math.max(beforeCursor, beforeTarget + availableBefore);
    afterCursor = Math.max(afterCursor, afterTarget + availableAfter);
  }

  while (beforeCursor < beforeLines.length || afterCursor < afterLines.length) {
    if (!pushRow(
      beforeCursor < beforeLines.length ? beforeCursor : null,
      afterCursor < afterLines.length ? afterCursor : null,
    )) break;
    if (beforeCursor < beforeLines.length) beforeCursor += 1;
    if (afterCursor < afterLines.length) afterCursor += 1;
  }
  return rows;
}

function parsePorcelainStatus(output) {
  const tokens = output.split('\0');
  const changes = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const indexStatus = token[0];
    const worktreeStatus = token[1];
    const filePath = token.slice(3);
    let originalPath = null;
    if (indexStatus === 'R' || indexStatus === 'C') {
      originalPath = tokens[index + 1] || null;
      index += 1;
    }
    const untracked = indexStatus === '?' && worktreeStatus === '?';
    const staged = !untracked && indexStatus !== ' ' && indexStatus !== '!';
    const unstaged = untracked || (worktreeStatus !== ' ' && worktreeStatus !== '!');
    const primaryStatus = untracked
      ? '?'
      : worktreeStatus !== ' '
        ? worktreeStatus
        : indexStatus;
    changes.push({
      path: filePath,
      originalPath,
      indexStatus,
      worktreeStatus,
      staged,
      unstaged,
      untracked,
      label: STATUS_LABELS[primaryStatus] || primaryStatus,
    });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

function workspaceId(repositoryPath) {
  return crypto.createHash('sha256').update(repositoryPath).digest('hex').slice(0, 12);
}

class GitService {
  constructor(dataRoot) {
    this.workspaceFile = path.join(dataRoot, 'workspace.json');
  }

  async initialize() {
    await fs.mkdir(path.dirname(this.workspaceFile), { recursive: true });
    try {
      await fs.access(this.workspaceFile);
    } catch {
      await fs.writeFile(this.workspaceFile, '{"repositories":[]}\n');
    }
  }

  async readWorkspace() {
    await this.initialize();
    const value = JSON.parse(await fs.readFile(this.workspaceFile, 'utf8'));
    return Array.isArray(value.repositories) ? value.repositories : [];
  }

  async writeWorkspace(repositoryPaths) {
    await fs.writeFile(this.workspaceFile, `${JSON.stringify({ repositories: repositoryPaths }, null, 2)}\n`);
  }

  async addRepositories(selectedPaths) {
    const inspected = await Promise.all(selectedPaths.map(inspectRepository));
    const current = await this.readWorkspace();
    const merged = [...new Set([...current, ...inspected.map((repository) => repository.path)])];
    await this.writeWorkspace(merged);
    return inspected;
  }

  async removeRepository(repositoryPath) {
    const current = await this.readWorkspace();
    await this.writeWorkspace(current.filter((item) => item !== repositoryPath));
    return this.listRepositories();
  }

  async listRepositories() {
    const repositoryPaths = await this.readWorkspace();
    const repositories = [];
    for (const repositoryPath of repositoryPaths) {
      try {
        repositories.push(await inspectRepository(repositoryPath));
      } catch (error) {
        repositories.push({
          id: workspaceId(repositoryPath),
          name: path.basename(repositoryPath),
          path: repositoryPath,
          unavailable: true,
          error: error.message,
        });
      }
    }
    return repositories;
  }

  async history(repositoryPath, limit = 20) {
    const repository = await inspectRepository(repositoryPath);
    if (!repository.hasHead) return [];
    const { stdout } = await runGit(repository.path, [
      'log', '-n', String(Math.min(Math.max(limit, 1), 100)),
      '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e',
    ]);
    return stdout
      .split('\x1e')
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => {
        const [commit, shortCommit, author, authoredAt, subject] = record.split('\x1f');
        return { commit, shortCommit, author, authoredAt, subject };
      });
  }

  async status(repositoryPath) {
    const repository = await inspectRepository(repositoryPath);
    const { stdout } = await runGit(repository.path, [
      'status', '--porcelain=v1', '-z', '--untracked-files=all',
    ]);
    const changes = parsePorcelainStatus(stdout);
    return {
      repository,
      changes,
      stagedCount: changes.filter((change) => change.staged).length,
      unstagedCount: changes.filter((change) => change.unstaged).length,
      history: await this.history(repository.path, 15),
    };
  }

  async stage(repositoryPath, files) {
    const repository = await inspectRepository(repositoryPath);
    const paths = this.validatePaths(files);
    await runGit(repository.path, ['add', '-A', '--', ...paths]);
    return this.status(repository.path);
  }

  async stageAll(repositoryPath) {
    const repository = await inspectRepository(repositoryPath);
    await runGit(repository.path, ['add', '-A', '--', '.']);
    return this.status(repository.path);
  }

  async unstage(repositoryPath, files) {
    const repository = await inspectRepository(repositoryPath);
    const paths = this.validatePaths(files);
    if (repository.hasHead) {
      await runGit(repository.path, ['restore', '--staged', '--', ...paths]);
    } else {
      await runGit(repository.path, ['rm', '-r', '--cached', '--ignore-unmatch', '--', ...paths]);
    }
    return this.status(repository.path);
  }

  async unstageAll(repositoryPath) {
    const repository = await inspectRepository(repositoryPath);
    if (repository.hasHead) {
      await runGit(repository.path, ['reset', '--mixed', '--quiet', 'HEAD']);
    } else {
      await runGit(repository.path, ['rm', '-r', '--cached', '--ignore-unmatch', '--', '.']);
    }
    return this.status(repository.path);
  }

  async commit(repositoryPath, message) {
    const repository = await inspectRepository(repositoryPath);
    const commitMessage = String(message || '').trim();
    if (!commitMessage) throw new Error('Enter a commit message.');
    if (commitMessage.length > 10_000) throw new Error('The commit message is too long.');
    const { stdout: stagedFiles } = await runGit(repository.path, ['diff', '--cached', '--name-only']);
    if (!stagedFiles.trim()) throw new Error('Stage at least one change before committing.');
    await runGit(repository.path, ['commit', '-m', commitMessage]);
    return this.status(repository.path);
  }

  async diff(repositoryPath, filePath, staged = false) {
    const repository = await inspectRepository(repositoryPath);
    const [safePath] = this.validatePaths([filePath]);
    const { changes } = await this.status(repository.path);
    const change = changes.find((item) => item.path === safePath);
    if (!staged && change?.untracked) return this.untrackedDiff(repository, safePath);

    const oldPath = change?.originalPath && (
      staged ? ['R', 'C'].includes(change.indexStatus) : ['R', 'C'].includes(change.worktreeStatus)
    ) ? change.originalPath : safePath;

    const args = ['diff', '--no-ext-diff', '--no-color', '--unified=0'];
    if (staged) args.push('--cached');
    args.push('--', ...new Set([oldPath, safePath]));
    const { stdout } = await runGit(repository.path, args);
    const binary = /Binary files .* differ|GIT binary patch/.test(stdout);
    const labels = staged
      ? { beforeLabel: repository.hasHead ? 'HEAD' : 'Empty repository', afterLabel: 'Index' }
      : { beforeLabel: 'Index', afterLabel: 'Working Tree' };
    if (binary) {
      return {
        path: safePath,
        staged: Boolean(staged),
        binary: true,
        content: 'Binary file — preview unavailable.',
        rows: [],
        ...labels,
      };
    }

    const [beforeText, afterText] = staged
      ? await Promise.all([
        repository.hasHead ? this.readGitText(repository.path, `HEAD:${oldPath}`) : null,
        this.readGitText(repository.path, `:${safePath}`),
      ])
      : await Promise.all([
        this.readGitText(repository.path, `:${oldPath}`),
        this.readWorktreeText(repository.path, safePath),
      ]);
    const beforePreview = String(beforeText || '').slice(0, MAX_DIFF_PREVIEW);
    const afterPreview = String(afterText || '').slice(0, MAX_DIFF_PREVIEW);
    const rows = buildCompareRows(beforePreview, afterPreview, stdout);
    const truncated = stdout.length > MAX_DIFF_PREVIEW
      || String(beforeText || '').length > MAX_DIFF_PREVIEW
      || String(afterText || '').length > MAX_DIFF_PREVIEW
      || rows.length >= MAX_COMPARE_ROWS;
    return {
      path: safePath,
      staged: Boolean(staged),
      binary: false,
      content: (stdout || 'No textual diff is available for this file.').slice(0, MAX_DIFF_PREVIEW),
      rows,
      truncated,
      ...labels,
    };
  }

  async untrackedDiff(repository, safePath) {
    const absolutePath = path.join(repository.path, safePath);
    const buffer = await fs.readFile(absolutePath);
    if (buffer.includes(0)) {
      return {
        path: safePath,
        staged: false,
        binary: true,
        content: 'Binary file — preview unavailable.',
        rows: [],
        beforeLabel: 'Index',
        afterLabel: 'Working Tree',
      };
    }
    const text = buffer.toString('utf8');
    const preview = text.slice(0, MAX_DIFF_PREVIEW);
    return {
      path: safePath,
      staged: false,
      binary: false,
      content: `Untracked file: ${safePath}\n\n${preview}`,
      rows: buildCompareRows('', preview, ''),
      beforeLabel: 'Index',
      afterLabel: 'Working Tree',
      truncated: text.length > MAX_DIFF_PREVIEW,
    };
  }

  async readGitText(repositoryPath, objectName) {
    try {
      await runGit(repositoryPath, ['cat-file', '-e', objectName]);
    } catch {
      return null;
    }
    const { stdout } = await runGit(repositoryPath, ['show', objectName]);
    return stdout;
  }

  async readWorktreeText(repositoryPath, filePath) {
    const absolutePath = path.join(repositoryPath, filePath);
    try {
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) return fs.readlink(absolutePath);
      if (!stat.isFile()) return null;
      return fs.readFile(absolutePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  validatePaths(files) {
    if (!Array.isArray(files) || files.length === 0) throw new Error('Choose at least one changed file.');
    return files.map((file) => {
      if (typeof file !== 'string' || !file || file.includes('\0')) throw new Error('Invalid Git path.');
      return file;
    });
  }
}

module.exports = { GitService, buildCompareRows, parsePorcelainStatus };
