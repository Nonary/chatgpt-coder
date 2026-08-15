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
    if (!staged) {
      const status = await this.status(repository.path);
      const change = status.changes.find((item) => item.path === safePath);
      if (change?.untracked) {
        const absolutePath = path.join(repository.path, safePath);
        const buffer = await fs.readFile(absolutePath);
        if (buffer.includes(0)) {
          return { path: safePath, staged: false, binary: true, content: 'Binary file — preview unavailable.' };
        }
        const text = buffer.toString('utf8');
        return {
          path: safePath,
          staged: false,
          binary: false,
          content: `Untracked file: ${safePath}\n\n${text.slice(0, 500_000)}`,
          truncated: text.length > 500_000,
        };
      }
    }
    const args = ['diff', '--no-ext-diff'];
    if (staged) args.push('--cached');
    args.push('--', safePath);
    const { stdout } = await runGit(repository.path, args);
    return {
      path: safePath,
      staged: Boolean(staged),
      binary: /Binary files .* differ/.test(stdout),
      content: stdout || 'No textual diff is available for this file.',
      truncated: stdout.length > 500_000,
    };
  }

  validatePaths(files) {
    if (!Array.isArray(files) || files.length === 0) throw new Error('Choose at least one changed file.');
    return files.map((file) => {
      if (typeof file !== 'string' || !file || file.includes('\0')) throw new Error('Invalid Git path.');
      return file;
    });
  }
}

module.exports = { GitService, parsePorcelainStatus };
