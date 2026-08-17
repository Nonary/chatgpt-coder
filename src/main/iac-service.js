const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { inspectRepository, runGit } = require('./git');

function expandEnvironmentVariables(value) {
  return String(value).replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, simple) => {
    const name = braced || simple;
    return Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : '';
  });
}

function expandConfigPath(value, baseDir) {
  let expanded = expandEnvironmentVariables(value.trim());
  if (expanded === '~') expanded = os.homedir();
  else if (expanded.startsWith(`~${path.sep}`) || expanded.startsWith('~/')) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(baseDir, expanded));
}

function looksLikeRemoteGitUrl(value) {
  const stripped = value.trim();
  if (stripped.startsWith('file://')) return false;
  if (/^(?:https?|ssh):\/\//i.test(stripped)) return true;
  return /^[^@\s]+@[^:\s]+:.+/.test(stripped);
}

function gitFileUrlToPath(value) {
  const parsed = new URL(value);
  let filePath = decodeURIComponent(parsed.pathname);
  if (process.platform === 'win32' && /^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1);
  return path.resolve(filePath);
}

function normalizeRemoteUrl(value) {
  const normalized = value.trim().replaceAll('\\', '/').replace(/\/+$/, '');
  return normalized.replace(/\.git$/i, '').toLowerCase();
}

function safeRepositoryName(value) {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return normalized || 'iac-repo';
}

function gitUrlRepositoryName(value) {
  const stripped = value.trim().replace(/\/+$/, '');
  const pathPart = /^[^@\s]+@[^:\s]+:.+/.test(stripped)
    ? stripped.split(':', 2)[1]
    : (new URL(stripped).pathname || stripped);
  const name = pathPart.replaceAll('\\', '/').replace(/\/+$/, '').split('/').pop() || 'iac-repo';
  return safeRepositoryName(name.replace(/\.git$/i, ''));
}

async function existingChildPath(parent, childName) {
  const base = path.join(parent, childName);
  try {
    await fs.access(base);
  } catch (error) {
    if (error.code === 'ENOENT') return base;
    throw error;
  }
  let counter = 2;
  while (true) {
    const candidate = path.join(parent, `${childName}-${counter}`);
    try {
      await fs.access(candidate);
      counter += 1;
    } catch (error) {
      if (error.code === 'ENOENT') return candidate;
      throw error;
    }
  }
}

function requireStringList(settings, key, settingsPath) {
  const value = settings[key] ?? [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`settings.${key} must be a list of strings in ${settingsPath}`);
  }
  return value;
}

async function readJsonSettings(settingsPath) {
  let stat;
  try {
    stat = await fs.stat(settingsPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, settings: null, selectors: [] };
    throw error;
  }
  if (!stat.isFile()) throw new Error(`IaC settings path is not a file: ${settingsPath}`);
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`IaC settings file is not valid JSON: ${settingsPath}\n${error.message}`);
    }
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`IaC settings file must contain a JSON object: ${settingsPath}`);
  }
  return {
    exists: true,
    settings: parsed,
    selectors: requireStringList(parsed, 'iac_urls', settingsPath),
  };
}

class IacService {
  constructor(options = {}) {
    const settingsPath = options.settingsPath
      || process.env.PATCHWORK_IAC_SETTINGS
      || path.join(process.cwd(), 'settings.json');
    this.settingsPath = path.resolve(settingsPath);
  }

  async getConfig() {
    try {
      const config = await readJsonSettings(this.settingsPath);
      return {
        settingsPath: this.settingsPath,
        exists: config.exists,
        valid: true,
        selectors: config.selectors,
        error: null,
      };
    } catch (error) {
      return {
        settingsPath: this.settingsPath,
        exists: true,
        valid: false,
        selectors: [],
        error: error.message,
      };
    }
  }

  async cloneRemoteRepository(selector, cloneRoot) {
    await fs.mkdir(cloneRoot, { recursive: true });
    const destination = await existingChildPath(cloneRoot, gitUrlRepositoryName(selector));
    await runGit(cloneRoot, ['clone', selector, destination]);
    return path.resolve(destination);
  }

  async resolveRepositories(cloneRoot) {
    const config = await readJsonSettings(this.settingsPath);
    if (!config.exists) {
      return {
        settingsPath: this.settingsPath,
        exists: false,
        selectors: [],
        repositories: [],
      };
    }

    const repositories = [];
    const seen = new Set();
    for (const rawSelector of config.selectors) {
      const selector = rawSelector.trim();
      if (!selector) {
        repositories.push({
          selector: rawSelector,
          source: 'settings',
          status: 'skipped_empty_iac_url',
        });
        continue;
      }

      let sourcePath;
      let source;
      if (looksLikeRemoteGitUrl(selector)) {
        const seenKey = `remote:${normalizeRemoteUrl(selector)}`;
        if (seen.has(seenKey)) continue;
        seen.add(seenKey);
        sourcePath = await this.cloneRemoteRepository(selector, cloneRoot);
        source = 'remote_clone';
      } else {
        sourcePath = selector.startsWith('file://')
          ? gitFileUrlToPath(selector)
          : expandConfigPath(selector, path.dirname(this.settingsPath));
        const seenKey = `path:${sourcePath}`;
        if (seen.has(seenKey)) continue;
        seen.add(seenKey);
        source = 'local_path';
      }

      let repository;
      try {
        repository = await inspectRepository(sourcePath);
      } catch (error) {
        const notRepository = /not a git repository|cannot change to|does not exist|no such file|rev-parse|command failed/i.test(error.message);
        if (!notRepository) throw error;
        repositories.push({
          selector,
          source_path: sourcePath,
          source,
          status: 'skipped_missing_or_not_git_repo',
        });
        continue;
      }

      repositories.push({
        selector,
        source_path: repository.path,
        source,
        status: 'ready',
      });
    }

    return {
      settingsPath: this.settingsPath,
      exists: true,
      selectors: config.selectors,
      repositories,
    };
  }
}

module.exports = {
  IacService,
  expandConfigPath,
  gitFileUrlToPath,
  gitUrlRepositoryName,
  looksLikeRemoteGitUrl,
};
