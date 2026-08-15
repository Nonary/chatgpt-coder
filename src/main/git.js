const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

async function runGit(cwd, args, options = {}) {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
      ...options,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || error).trim();
    throw new Error(`Git command failed: git ${args.join(' ')}${detail ? `\n${detail}` : ''}`);
  }
}

function slugify(value) {
  const slug = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || 'repository';
}

async function inspectRepository(selectedPath) {
  const candidate = await fs.realpath(selectedPath);
  const { stdout: rootOutput } = await runGit(candidate, ['rev-parse', '--show-toplevel']);
  const root = await fs.realpath(rootOutput.trim());
  let headCommit = null;
  try {
    const { stdout } = await runGit(root, ['rev-parse', '--verify', 'HEAD']);
    headCommit = stdout.trim();
  } catch (error) {
    if (!/single revision|unknown revision|bad revision|Needed a single revision/i.test(error.message)) throw error;
  }
  const [{ stdout: branchOutput }, { stdout: statusOutput }] = await Promise.all([
    runGit(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => ({ stdout: '' })),
    runGit(root, ['status', '--porcelain=v1', '--untracked-files=all']),
  ]);

  const name = path.basename(root);
  const suffix = crypto.createHash('sha256').update(root).digest('hex').slice(0, 8);
  return {
    id: `${slugify(name)}-${suffix}`,
    name,
    path: root,
    branch: branchOutput.trim() || '(detached HEAD)',
    baseCommit: headCommit,
    hasHead: Boolean(headCommit),
    isClean: statusOutput.length === 0,
    statusSummary: statusOutput.trim(),
  };
}

async function listSnapshotPaths(repositoryPath) {
  const { stdout } = await runGit(repositoryPath, [
    'ls-files', '-z', '--cached', '--others', '--exclude-standard',
  ]);
  return [...new Set(stdout.split('\0').filter(Boolean))].sort();
}

function updateHashWithFile(hash, filePath) {
  return new Promise((resolve, reject) => {
    const stream = fsSync.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}

async function fingerprintRepository(repositoryPath) {
  const hash = crypto.createHash('sha256');
  const snapshotPaths = await listSnapshotPaths(repositoryPath);
  for (const relativePath of snapshotPaths) {
    const absolutePath = path.join(repositoryPath, relativePath);
    hash.update(`path\0${relativePath}\0`);
    let stat;
    try {
      stat = await fs.lstat(absolutePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        hash.update('deleted\0');
        continue;
      }
      throw error;
    }
    hash.update(`mode\0${stat.mode & 0o777}\0`);
    if (stat.isSymbolicLink()) {
      hash.update(`symlink\0${await fs.readlink(absolutePath)}\0`);
    } else if (stat.isFile()) {
      hash.update(`file\0${stat.size}\0`);
      await updateHashWithFile(hash, absolutePath);
      hash.update('\0');
    } else if (stat.isDirectory()) {
      // Gitlink/submodule contents are represented by the source HEAD, not copied as ordinary files.
      hash.update('directory\0');
    }
  }
  return hash.digest('hex');
}

async function copySnapshot(repositoryPath, snapshotPath, snapshotPaths) {
  for (const relativePath of snapshotPaths) {
    const sourcePath = path.join(repositoryPath, relativePath);
    const destinationPath = path.join(snapshotPath, relativePath);
    let stat;
    try {
      stat = await fs.lstat(sourcePath);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isDirectory()) continue;
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    if (stat.isSymbolicLink()) {
      await fs.symlink(await fs.readlink(sourcePath), destinationPath);
    } else {
      await fs.copyFile(sourcePath, destinationPath);
      await fs.chmod(destinationPath, stat.mode & 0o777);
    }
  }
}

async function createSnapshotBundle(repository, snapshotPath, outputPath) {
  const snapshotPaths = await listSnapshotPaths(repository.path);
  const fingerprintBefore = await fingerprintRepository(repository.path);
  await fs.mkdir(snapshotPath, { recursive: true });
  await runGit(snapshotPath, ['init', '-b', 'patchwork-base']);
  await runGit(snapshotPath, ['config', 'user.email', 'snapshot@patchwork.invalid']);
  await runGit(snapshotPath, ['config', 'user.name', 'Patchwork Snapshot']);
  await copySnapshot(repository.path, snapshotPath, snapshotPaths);
  const fingerprintAfter = await fingerprintRepository(repository.path);
  if (fingerprintBefore !== fingerprintAfter) {
    throw new Error(`${repository.name} changed while Patchwork was creating its snapshot. Try again.`);
  }
  await runGit(snapshotPath, ['add', '-A', '--', '.']);
  await runGit(snapshotPath, ['commit', '--allow-empty', '-m', 'Patchwork task snapshot']);
  const { stdout: commitOutput } = await runGit(snapshotPath, ['rev-parse', 'HEAD']);
  const snapshotRepository = { path: snapshotPath };
  await createBundle(snapshotRepository, outputPath);
  return {
    baseCommit: commitOutput.trim(),
    snapshotFingerprint: fingerprintAfter,
  };
}

async function createBundle(repository, outputPath) {
  await runGit(repository.path, ['bundle', 'create', outputPath, 'HEAD']);
  await runGit(repository.path, ['bundle', 'verify', outputPath]);
}

async function verifyHead(repository) {
  const current = await inspectRepository(repository.path);
  if (repository.isSnapshot) {
    if (current.baseCommit !== repository.sourceHead) {
      const expected = repository.sourceHead ? repository.sourceHead.slice(0, 12) : 'no commit';
      const actual = current.baseCommit ? current.baseCommit.slice(0, 12) : 'no commit';
      throw new Error(`${repository.name} moved from ${expected} to ${actual}. Create a new task package.`);
    }
    const currentFingerprint = await fingerprintRepository(repository.path);
    if (currentFingerprint !== repository.snapshotFingerprint) {
      throw new Error(`${repository.name} changed after the task snapshot was created. Create a new task package.`);
    }
    return current;
  }
  if (current.baseCommit !== repository.baseCommit) {
    throw new Error(
      `${repository.name} moved from ${repository.baseCommit.slice(0, 12)} to ${current.baseCommit.slice(0, 12)}. Create a new task package.`,
    );
  }
  if (!current.isClean) {
    throw new Error(`${repository.name} has local changes. Commit or stash them before applying this result.`);
  }
  return current;
}

async function checkPatch(repositoryPath, patchPath) {
  await runGit(repositoryPath, ['apply', '--check', '--binary', patchPath]);
  const [{ stdout: stat }, { stdout: numstat }] = await Promise.all([
    runGit(repositoryPath, ['apply', '--stat', '--binary', patchPath]),
    runGit(repositoryPath, ['apply', '--numstat', '--binary', patchPath]),
  ]);
  return { stat: stat.trim(), numstat: numstat.trim() };
}

async function applyPatch(repositoryPath, patchPath, reverse = false) {
  const args = ['apply', '--binary'];
  if (reverse) args.push('--reverse');
  args.push(patchPath);
  await runGit(repositoryPath, args);
}

module.exports = {
  applyPatch,
  checkPatch,
  createBundle,
  createSnapshotBundle,
  fingerprintRepository,
  inspectRepository,
  listSnapshotPaths,
  runGit,
  slugify,
  verifyHead,
};
