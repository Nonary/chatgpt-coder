const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const USER_SKILL_ROOTS = [
  { provider: 'Claude Code', segments: ['.claude', 'skills'], label: '~/.claude/skills' },
  { provider: 'Codex', segments: ['.codex', 'skills'], label: '~/.codex/skills' },
  { provider: 'GitHub Copilot', segments: ['.copilot', 'skills'], label: '~/.copilot/skills' },
  { provider: 'Agent Skills', segments: ['.agents', 'skills'], label: '~/.agents/skills' },
];

const PROJECT_SKILL_ROOTS = [
  { provider: 'Claude Code', segments: ['.claude', 'skills'], label: '.claude/skills' },
  { provider: 'Codex', segments: ['.codex', 'skills'], label: '.codex/skills' },
  { provider: 'GitHub Copilot', segments: ['.copilot', 'skills'], label: '.copilot/skills' },
  { provider: 'GitHub Copilot', segments: ['.github', 'skills'], label: '.github/skills' },
  { provider: 'Agent Skills', segments: ['.agents', 'skills'], label: '.agents/skills' },
];

const MAX_METADATA_BYTES = 48 * 1024;

function normalizeSkillText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseFrontmatter(content) {
  const match = String(content || '').match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match) return {};
  const fields = {};
  for (const line of match[1].split('\n')) {
    const field = line.match(/^([A-Za-z][\w-]*):\s*(.*?)\s*$/);
    if (!field) continue;
    const key = field[1].toLowerCase();
    let value = field[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return fields;
}

function parseSkillDocument(content) {
  const text = String(content || '').replaceAll('\r\n', '\n');
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  return {
    frontmatter: match ? parseFrontmatter(text) : {},
    content: (match ? text.slice(match[0].length) : text).trim(),
  };
}

function skillDocument({ name, description, content }) {
  return [
    '---',
    `name: ${JSON.stringify(String(name || '').trim())}`,
    `description: ${JSON.stringify(String(description || '').trim())}`,
    '---',
    '',
    String(content || '').replaceAll('\r\n', '\n').trim(),
    '',
  ].join('\n');
}

function skillSlug(value) {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80);
  return slug || 'skill';
}

function fallbackSkillDescription(content) {
  const lines = String(content || '')
    .replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, '')
    .split('\n')
    .map((line) => normalizeSkillText(line.replace(/^#+\s*/, '')))
    .filter(Boolean);
  return lines[0] || '';
}

function skillId(sourcePath) {
  return `skill-${crypto.createHash('sha256').update(sourcePath).digest('hex').slice(0, 16)}`;
}

async function readSkillMetadata(skillPath, fallbackName) {
  const skillFile = path.join(skillPath, 'SKILL.md');
  let content = '';
  try {
    const handle = await fs.open(skillFile, 'r');
    try {
      const buffer = Buffer.alloc(MAX_METADATA_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      content = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return {
      name: fallbackName,
      description: '',
    };
  }
  const frontmatter = parseFrontmatter(content);
  return {
    name: normalizeSkillText(frontmatter.name) || fallbackName,
    description: normalizeSkillText(frontmatter.description) || fallbackSkillDescription(content),
  };
}

async function readSkillContent(skillPath, fallbackName) {
  const skillFile = path.join(skillPath, 'SKILL.md');
  const content = await fs.readFile(skillFile, 'utf8');
  const parsed = parseSkillDocument(content);
  return {
    name: normalizeSkillText(parsed.frontmatter.name) || fallbackName,
    description: normalizeSkillText(parsed.frontmatter.description) || fallbackSkillDescription(content),
    content: parsed.content,
  };
}

async function existingDirectory(directory) {
  try {
    const stat = await fs.stat(directory);
    return stat.isDirectory() ? directory : null;
  } catch {
    return null;
  }
}

async function realDirectory(directory) {
  try {
    return await fs.realpath(directory);
  } catch {
    return null;
  }
}

class SkillService {
  constructor({ homeDirectory = os.homedir() } = {}) {
    this.homeDirectory = path.resolve(homeDirectory);
  }

  async buildRoots(repositoryPaths = []) {
    const roots = [];
    const userRoot = await existingDirectory(this.homeDirectory);
    if (userRoot) {
      for (const definition of USER_SKILL_ROOTS) {
        roots.push({
          scope: 'user',
          provider: definition.provider,
          label: definition.label,
          repositoryName: null,
          path: path.join(userRoot, ...definition.segments),
        });
      }
    }

    const uniqueRepositories = new Set();
    for (const inputPath of Array.isArray(repositoryPaths) ? repositoryPaths : []) {
      const repositoryPath = await realDirectory(inputPath);
      if (!repositoryPath || uniqueRepositories.has(repositoryPath)) continue;
      uniqueRepositories.add(repositoryPath);
      const repositoryName = path.basename(repositoryPath) || 'Project';
      for (const definition of PROJECT_SKILL_ROOTS) {
        roots.push({
          scope: 'project',
          provider: definition.provider,
          label: definition.label,
          repositoryName,
          path: path.join(repositoryPath, ...definition.segments),
        });
      }
    }
    return roots;
  }

  async discover(repositoryPaths = []) {
    const roots = await this.buildRoots(repositoryPaths);
    const skills = [];
    const seenPaths = new Set();
    for (const root of roots) {
      const rootDirectory = await realDirectory(root.path);
      if (!rootDirectory || seenPaths.has(rootDirectory)) continue;
      let entries = [];
      try {
        entries = await fs.readdir(rootDirectory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const sourcePath = await realDirectory(path.join(rootDirectory, entry.name));
        if (!sourcePath || seenPaths.has(sourcePath)) continue;
        const skillFile = path.join(sourcePath, 'SKILL.md');
        try {
          const stat = await fs.stat(skillFile);
          if (!stat.isFile()) continue;
        } catch {
          continue;
        }
        const metadata = await readSkillMetadata(sourcePath, entry.name);
        seenPaths.add(sourcePath);
        skills.push({
          id: skillId(sourcePath),
          name: metadata.name,
          description: metadata.description,
          provider: root.provider,
          scope: root.scope,
          location: root.scope === 'user' ? `User · ${root.label}` : `${root.repositoryName} · ${root.label}`,
          repositoryName: root.repositoryName,
          rootLabel: root.label,
          sourcePath,
          skillFile,
          rootPath: rootDirectory,
          writable: !entry.isSymbolicLink(),
        });
      }
    }
    return skills.sort((left, right) => (
      `${left.scope}|${left.provider}|${left.name}|${left.location}`.localeCompare(
        `${right.scope}|${right.provider}|${right.name}|${right.location}`,
      )
    ));
  }

  async skillRoots(repositoryPaths = []) {
    const roots = await this.buildRoots(repositoryPaths);
    return roots;
  }

  rootDefinition(scope, provider, repositoryPath = null) {
    const normalizedScope = String(scope || '').trim().toLowerCase();
    const definitions = normalizedScope === 'project' ? PROJECT_SKILL_ROOTS : USER_SKILL_ROOTS;
    const definition = definitions.find((item) => item.provider === provider);
    if (!definition) throw new Error(`Unknown skill provider: ${provider}`);
    return {
      scope: normalizedScope === 'project' ? 'project' : 'user',
      provider: definition.provider,
      label: definition.label,
      repositoryName: null,
      path: normalizedScope === 'project'
        ? null
        : path.join(this.homeDirectory, ...definition.segments),
      segments: definition.segments,
      repositoryPath,
    };
  }

  async create({ name, description, content, provider, scope = 'user', repositoryPath = null }) {
    const normalizedName = normalizeSkillText(name);
    const normalizedDescription = normalizeSkillText(description);
    const normalizedContent = String(content || '').replaceAll('\r\n', '\n').trim();
    if (!normalizedName || !normalizedContent) {
      throw new Error('A skill needs a name and instruction text.');
    }
    const normalizedScope = String(scope || 'user').trim().toLowerCase() === 'project' ? 'project' : 'user';
    if (normalizedScope === 'project' && !repositoryPath) {
      throw new Error('Choose a project repository before creating a project skill.');
    }
    let root;
    if (normalizedScope === 'project') {
      const repositoryRoot = await realDirectory(repositoryPath);
      if (!repositoryRoot) throw new Error('The selected project repository no longer exists.');
      root = this.rootDefinition(normalizedScope, provider, repositoryRoot);
      root.path = path.join(repositoryRoot, ...root.segments);
      root.repositoryName = path.basename(repositoryRoot) || 'Project';
    } else {
      root = this.rootDefinition(normalizedScope, provider);
    }

    const directory = path.join(root.path, skillSlug(normalizedName));
    if (await existingDirectory(directory)) {
      throw new Error(`A skill directory named “${path.basename(directory)}” already exists.`);
    }
    await fs.mkdir(root.path, { recursive: true });
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'SKILL.md'), skillDocument({
      name: normalizedName,
      description: normalizedDescription,
      content: normalizedContent,
    }), 'utf8');

    const repositoryPaths = normalizedScope === 'project' ? [root.repositoryPath] : [];
    const discovered = await this.discover(repositoryPaths);
    const created = discovered.find((skill) => path.resolve(skill.sourcePath) === path.resolve(directory));
    if (!created) throw new Error('The skill was created but could not be rediscovered.');
    return this.getDetails(created);
  }

  async get(skillId, repositoryPaths = []) {
    const skills = await this.discover(repositoryPaths);
    const skill = skills.find((item) => item.id === String(skillId));
    if (!skill) throw new Error('That skill no longer exists.');
    return this.getDetails(skill);
  }

  async getDetails(skill) {
    const metadata = await readSkillContent(skill.sourcePath, skill.name);
    return { ...skill, ...metadata };
  }

  async update(skillId, input, repositoryPaths = []) {
    const skill = await this.get(skillId, repositoryPaths);
    if (!skill.writable) throw new Error('Linked skills cannot be edited from Patchwork.');
    const name = normalizeSkillText(input?.name || skill.name);
    const description = normalizeSkillText(input?.description ?? skill.description ?? '');
    const content = String(input?.content ?? skill.content ?? '').replaceAll('\r\n', '\n').trim();
    if (!name || !content) throw new Error('A skill needs a name and instruction text.');
    await fs.writeFile(skill.skillFile, skillDocument({ name, description, content }), 'utf8');
    return this.get(skill.id, repositoryPaths);
  }

  async remove(skillId, repositoryPaths = []) {
    const skill = await this.get(skillId, repositoryPaths);
    if (!skill.writable) throw new Error('Linked skills cannot be deleted from Patchwork.');
    if (!skill.rootPath || path.resolve(skill.rootPath) === path.resolve(skill.sourcePath)) {
      throw new Error('Refusing to delete a skill outside a configured skill root.');
    }
    const sourcePath = path.resolve(skill.sourcePath);
    const rootPath = path.resolve(skill.rootPath);
    if (!sourcePath.startsWith(`${rootPath}${path.sep}`)) {
      throw new Error('Refusing to delete a skill outside a configured skill root.');
    }
    await fs.rm(sourcePath, { recursive: true, force: true });
    return this.discover(repositoryPaths);
  }

  async resolveSelectedSkillIds(skillIds, repositoryPaths = []) {
    const requested = [...new Set((Array.isArray(skillIds) ? skillIds : []).map((value) => String(value).trim()).filter(Boolean))];
    if (requested.length === 0) return [];
    const skills = await this.discover(repositoryPaths);
    const byId = new Map(skills.map((skill) => [skill.id, skill]));
    return requested.map((id) => {
      const skill = byId.get(id);
      if (!skill) throw new Error('One or more selected skills are no longer available. Reopen the task skills drawer and refresh the list.');
      return skill;
    });
  }
}

module.exports = {
  SkillService,
  parseSkillDocument,
  skillDocument,
  skillSlug,
  PROJECT_SKILL_ROOTS,
  USER_SKILL_ROOTS,
};
