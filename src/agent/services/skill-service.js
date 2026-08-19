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
        });
      }
    }
    return skills.sort((left, right) => (
      `${left.scope}|${left.provider}|${left.name}|${left.location}`.localeCompare(
        `${right.scope}|${right.provider}|${right.name}|${right.location}`,
      )
    ));
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
  PROJECT_SKILL_ROOTS,
  USER_SKILL_ROOTS,
};
