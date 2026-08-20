const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const MAX_ENTRIES = 500;
const MAX_DISCOVERY_DEPTH = 4;
const MAX_DISCOVERY_RESULTS = 200;
const SKIPPED_DIRECTORIES = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  '.venv', 'venv', '__pycache__', '.cache', '.next', '.nuxt', 'vendor',
]);

function expandHome(value, homeDirectory) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (raw === '~') return homeDirectory;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(homeDirectory, raw.slice(2));
  return raw;
}

class FsService {
  constructor({
    homeDirectory = os.homedir(), platform = process.platform, execute = execFileAsync,
  } = {}) {
    this.homeDirectory = homeDirectory;
    this.platform = platform;
    this.execute = execute;
  }

  async selectDirectory() {
    let command;
    let args;
    let options = {};
    if (this.platform === 'win32') {
      command = 'powershell.exe';
      args = [
        '-NoLogo', '-NoProfile', '-STA', '-NonInteractive', '-Command',
        [
          'Add-Type -AssemblyName System.Windows.Forms',
          '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
          '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
          "$dialog.Description = 'Select a Git repository folder'",
          '$dialog.SelectedPath = $env:PATCHWORK_PICKER_INITIAL_DIRECTORY',
          'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
          '  [Console]::Out.Write($dialog.SelectedPath)',
          '}',
        ].join('; '),
      ];
      options = {
        windowsHide: true,
        env: { ...process.env, PATCHWORK_PICKER_INITIAL_DIRECTORY: this.homeDirectory },
      };
    } else if (this.platform === 'darwin') {
      command = 'osascript';
      args = ['-e', 'POSIX path of (choose folder with prompt "Select a Git repository folder")'];
    } else {
      command = 'zenity';
      args = ['--file-selection', '--directory', '--title=Select a Git repository folder'];
    }

    let stdout;
    try {
      ({ stdout } = await this.execute(command, args, options));
    } catch (error) {
      const canceled = (this.platform === 'darwin' && error.code === 1)
        || (this.platform !== 'win32' && this.platform !== 'darwin' && error.code === 1);
      if (canceled) return null;
      throw new Error(`The operating system folder picker could not be opened: ${error.message}`);
    }
    const selectedPath = String(stdout || '').trim();
    if (!selectedPath) return null;
    const resolved = await fs.realpath(path.resolve(selectedPath));
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
    return resolved;
  }

  async roots() {
    const roots = [{ label: 'Home', path: this.homeDirectory }];
    if (this.platform === 'win32') {
      for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        const drive = `${letter}:\\`;
        try {
          await fs.access(drive);
          roots.push({ label: `${letter}:`, path: drive });
        } catch {
          // The drive letter is not mounted.
        }
      }
    } else {
      roots.push({ label: 'Filesystem', path: '/' });
    }
    return roots;
  }

  async isRepository(directory) {
    try {
      const stat = await fs.stat(path.join(directory, '.git'));
      return stat.isDirectory() || stat.isFile();
    } catch {
      return false;
    }
  }

  async browse(targetPath) {
    const requested = expandHome(targetPath, this.homeDirectory) || this.homeDirectory;
    const resolved = await fs.realpath(path.resolve(requested));
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);

    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const directories = [];
    for (const entry of entries) {
      if (directories.length >= MAX_ENTRIES) break;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('.') && entry.name !== '.config') continue;
      const childPath = path.join(resolved, entry.name);
      if (entry.isSymbolicLink()) {
        const childStat = await fs.stat(childPath).catch(() => null);
        if (!childStat?.isDirectory()) continue;
      }
      directories.push({
        name: entry.name,
        path: childPath,
        repository: await this.isRepository(childPath),
      });
    }
    directories.sort((left, right) => left.name.localeCompare(right.name));

    const parent = path.dirname(resolved);
    return {
      path: resolved,
      parent: parent === resolved ? null : parent,
      repository: await this.isRepository(resolved),
      truncated: directories.length >= MAX_ENTRIES,
      directories,
      roots: await this.roots(),
    };
  }

  async discoverRepositories(targetPath, maxDepth = MAX_DISCOVERY_DEPTH) {
    const root = await fs.realpath(path.resolve(expandHome(targetPath, this.homeDirectory)));
    const found = [];
    const visit = async (directory, depth) => {
      if (found.length >= MAX_DISCOVERY_RESULTS || depth > maxDepth) return;
      if (await this.isRepository(directory)) {
        found.push({ name: path.basename(directory), path: directory });
        return;
      }
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
        await visit(path.join(directory, entry.name), depth + 1);
      }
    };
    await visit(root, 0);
    return found;
  }

  // Replaces Electron's shell.showItemInFolder.
  async reveal(targetPath) {
    const resolved = path.resolve(expandHome(targetPath, this.homeDirectory));
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat) throw new Error(`Path not found: ${resolved}`);
    const directory = stat.isDirectory() ? resolved : path.dirname(resolved);
    if (this.platform === 'win32') {
      // explorer.exe exits with a non-zero status even on success.
      await execFileAsync('explorer.exe', [stat.isDirectory() ? directory : `/select,${resolved}`])
        .catch(() => {});
      return true;
    }
    if (this.platform === 'darwin') {
      await execFileAsync('open', stat.isDirectory() ? [directory] : ['-R', resolved]);
      return true;
    }
    await execFileAsync('xdg-open', [directory]);
    return true;
  }
}

module.exports = { FsService, expandHome, SKIPPED_DIRECTORIES };
