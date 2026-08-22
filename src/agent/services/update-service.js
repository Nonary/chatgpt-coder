const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const { runGit } = require('./git');

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

function parseRevisionCounts(value) {
  const [ahead = '0', behind = '0'] = String(value || '').trim().split(/\s+/);
  return {
    ahead: Number.parseInt(ahead, 10) || 0,
    behind: Number.parseInt(behind, 10) || 0,
  };
}

function packageManagerInvocation(manager, args, options = {}) {
  const platform = options.platform || process.platform;
  const script = options.script || null;
  const managerArgs = manager === 'npm'
    ? (args[0] === 'install'
      ? args.filter((argument) => argument !== '--frozen-lockfile')
      : ['run', ...args])
    : args;
  return {
    manager,
    executable: script ? process.execPath : (platform === 'win32' ? `${manager}.cmd` : manager),
    args: script ? [script, ...managerArgs] : managerArgs,
    shell: !script && platform === 'win32',
  };
}

async function runPackageManager(projectRoot, args, options = {}) {
  const environment = options.env || process.env;
  const run = options.execFile || execFileAsync;
  const managerScript = environment.npm_execpath || '';
  let invocation;
  if (/pnpm/i.test(managerScript)) {
    invocation = packageManagerInvocation('pnpm', args, { script: managerScript });
  } else if (/(?:^|[/\\])npm-cli\.js$/i.test(managerScript)) {
    invocation = packageManagerInvocation('npm', args, { script: managerScript });
  } else {
    invocation = packageManagerInvocation('pnpm', args, options);
  }

  const execute = async (command) => run(command.executable, command.args, {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: command.shell,
    windowsHide: true,
  });

  try {
    return await execute(invocation);
  } catch (error) {
    if (!managerScript && invocation.manager === 'pnpm' && error.code === 'ENOENT') {
      invocation = packageManagerInvocation('npm', args, options);
      try {
        return await execute(invocation);
      } catch (fallbackError) {
        error = fallbackError;
      }
    }
    const detail = String(error.stderr || error.stdout || error.message || error).trim();
    throw new Error(`${invocation.manager} ${invocation.args.join(' ')} failed${detail ? `\n${detail}` : ''}`);
  }
}

class UpdateService {
  constructor(options = {}) {
    this.projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
    this.runGit = options.runGit || runGit;
    this.runPackageManager = options.runPackageManager || runPackageManager;
    this.runningRevision = null;
    this.updating = false;
    this.lastError = null;
    this.statusChecks = new Map();
  }

  async initialize() {
    try {
      const { stdout } = await this.runGit(this.projectRoot, ['rev-parse', '--verify', 'HEAD']);
      this.runningRevision = stdout.trim();
    } catch {
      this.runningRevision = null;
    }
    return this;
  }

  async status(options = {}) {
    const fetch = options.fetch !== false;
    const key = fetch ? 'fetch' : 'local';
    const existing = this.statusChecks.get(key);
    if (existing) return existing;
    const check = this.inspectStatus({ fetch }).finally(() => {
      if (this.statusChecks.get(key) === check) this.statusChecks.delete(key);
    });
    this.statusChecks.set(key, check);
    return check;
  }

  async inspectStatus({ fetch = true } = {}) {
    let revision;
    try {
      const { stdout } = await this.runGit(this.projectRoot, ['rev-parse', '--verify', 'HEAD']);
      revision = stdout.trim();
    } catch {
      return {
        supported: false,
        updating: this.updating,
        updateAvailable: false,
        canUpdate: false,
        reason: 'Patchwork is not running from a Git checkout.',
      };
    }

    const [{ stdout: branchOutput }, { stdout: dirtyOutput }] = await Promise.all([
      this.runGit(this.projectRoot, ['symbolic-ref', '--short', '-q', 'HEAD'])
        .catch(() => ({ stdout: '' })),
      this.runGit(this.projectRoot, ['status', '--porcelain=v1', '--untracked-files=all']),
    ]);
    const branch = branchOutput.trim();
    if (!branch) {
      return {
        supported: false,
        updating: this.updating,
        revision,
        runningRevision: this.runningRevision,
        updateAvailable: false,
        canUpdate: false,
        reason: 'Automatic updates require a checked-out branch, not a detached HEAD.',
      };
    }

    let upstream;
    try {
      const { stdout } = await this.runGit(this.projectRoot, [
        'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}',
      ]);
      upstream = stdout.trim();
    } catch {
      return {
        supported: false,
        updating: this.updating,
        revision,
        runningRevision: this.runningRevision,
        branch,
        updateAvailable: false,
        canUpdate: false,
        reason: `Branch ${branch} does not have an upstream branch.`,
      };
    }

    const { stdout: remoteOutput } = await this.runGit(
      this.projectRoot,
      ['config', '--get', `branch.${branch}.remote`],
    ).catch(() => ({ stdout: '' }));
    const remote = remoteOutput.trim() || null;
    if (fetch && remote && remote !== '.') {
      await this.runGit(this.projectRoot, ['fetch', '--quiet', remote]);
    }
    const [{ stdout: countsOutput }, { stdout: latestOutput }] = await Promise.all([
      this.runGit(this.projectRoot, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]),
      this.runGit(this.projectRoot, ['rev-parse', '--verify', upstream]),
    ]);
    const { ahead, behind } = parseRevisionCounts(countsOutput);
    const dirty = Boolean(dirtyOutput.trim());
    const restartPending = Boolean(this.runningRevision && revision !== this.runningRevision);
    const diverged = ahead > 0 && behind > 0;
    const updateAvailable = behind > 0 || restartPending;
    const fastForwardBlocked = behind > 0 && (dirty || diverged || ahead > 0);
    let reason = null;
    if (dirty && behind > 0) reason = 'The Patchwork checkout has local changes. Commit or stash them before pulling an update.';
    else if (diverged) reason = `${branch} and ${upstream} have diverged, so Patchwork cannot fast-forward safely.`;
    else if (this.updating && updateAvailable) reason = 'Another Patchwork tab is already updating.';

    return {
      supported: true,
      updating: this.updating,
      revision,
      runningRevision: this.runningRevision,
      latestRevision: latestOutput.trim(),
      branch,
      upstream,
      remote,
      ahead,
      behind,
      dirty,
      diverged,
      restartPending,
      updateAvailable,
      canUpdate: updateAvailable && !fastForwardBlocked && !this.updating,
      canRebuild: behind === 0 && !this.updating,
      reason,
      lastError: this.lastError,
    };
  }

  async applyUpdate({ rebuild = false } = {}) {
    if (this.updating) throw new Error('Patchwork is already updating.');
    this.updating = true;
    this.lastError = null;
    try {
      const before = await this.status({ fetch: true });
      if (!before.supported) throw new Error(before.reason);
      if (!before.updateAvailable && !rebuild) throw new Error('Patchwork is already up to date.');
      if (before.behind > 0 && (before.dirty || before.diverged || before.ahead > 0)) {
        throw new Error(before.reason || 'Patchwork cannot update this checkout safely.');
      }

      if (before.behind > 0) {
        await this.runGit(this.projectRoot, ['merge', '--ff-only', before.upstream]);
      }
      const { stdout: revisionOutput } = await this.runGit(
        this.projectRoot,
        ['rev-parse', '--verify', 'HEAD'],
      );
      const revision = revisionOutput.trim();
      let dependenciesChanged = true;
      if (this.runningRevision) {
        const { stdout } = await this.runGit(this.projectRoot, [
          'diff', '--name-only', this.runningRevision, revision, '--', 'package.json', 'pnpm-lock.yaml',
        ]);
        dependenciesChanged = Boolean(stdout.trim());
      }
      if (dependenciesChanged) {
        await this.runPackageManager(this.projectRoot, ['install', '--frozen-lockfile']);
      }
      await this.runPackageManager(this.projectRoot, ['build']);
      return {
        revision,
        previousRevision: this.runningRevision,
        upstream: before.upstream,
        dependenciesChanged,
        rebuilt: true,
        restarting: true,
      };
    } catch (error) {
      this.lastError = String(error?.message || error);
      throw error;
    } finally {
      this.updating = false;
    }
  }
}

module.exports = {
  PROJECT_ROOT,
  UpdateService,
  packageManagerInvocation,
  parseRevisionCounts,
  runPackageManager,
};
