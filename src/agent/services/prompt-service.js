const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_PROMPTS = 100;
const MAX_PROMPT_FILE_BYTES = 4 * 1024 * 1024;
const GIT_SUMMARY_PROMPT_NAME = 'git summary';
const PROMPT_FILE_EXTENSION = '.md';
const LEGACY_PROMPTS_FILE_NAME = 'prompts.json';
const MIGRATED_PROMPTS_FILE_NAME = 'prompts.json.migrated';

const DEFAULT_GIT_SUMMARY_PROMPT = `# Git Changes Review + Conventional Commit Prompt

Review all **uncommitted Git changes** in the current repository and produce a single accurate, detailed Conventional Commit message.

Inspect both staged and unstaged changes, including relevant surrounding code when necessary. Do not summarize the diff line-by-line. Determine the actual behavioral intent of the changes by understanding how the modified files, functions, components, types, tests, configuration, and call sites interact.

Pay particular attention to:

* What behavior changed and why
* How modified code interacts across files or layers
* Whether changes introduce, remove, fix, or refactor functionality
* Important implementation details that explain the resulting behavior
* Tests, migrations, configuration, dependencies, or API changes that materially affect the commit
* Breaking changes, if any

Then output **only the Conventional Commit message** in this format:

Do not append a verification report or test-status section. Mention tests only when they materially affect the change.

\`\`\`text
<type>(<optional-scope>): <concise summary>

<concise but detailed body explaining the meaningful changes and how they work together>

<optional BREAKING CHANGE footer>
\`\`\`

Use the most appropriate Conventional Commit type, such as \`feat\`, \`fix\`, \`refactor\`, \`perf\`, \`test\`, \`docs\`, \`build\`, \`ci\`, or \`chore\`.

Keep the subject concise and specific. Keep the body dense with useful information, focusing on intent and behavior rather than filenames or mechanical implementation details. Avoid vague statements, redundant bullets, speculation, and details that do not help someone understand the commit from Git history alone.

If the changes contain multiple related modifications, synthesize them into one cohesive commit description based on their shared purpose. If the diff appears to contain genuinely unrelated work, mention that clearly instead of inventing a misleading unifying description.`;

function resolveGitSummaryPrompt(value) {
  const prompt = String(value || '').replaceAll('\r\n', '\n').trim();
  return prompt || DEFAULT_GIT_SUMMARY_PROMPT;
}

function normalizePrompt(value) {
  const name = String(value?.name || '').trim().slice(0, 60);
  const description = String(value?.description || '').trim().slice(0, 140);
  const content = String(value?.content || '')
    .replaceAll('\r\n', '\n')
    .trim();
  if (!name || !content) return null;
  const createdAt = String(value?.createdAt || new Date().toISOString());
  return {
    id: String(value?.id || '').trim() || `prompt-${crypto.randomUUID()}`,
    name,
    description,
    content,
    createdAt,
    updatedAt: String(value?.updatedAt || createdAt),
    fileName: String(value?.fileName || '').trim(),
  };
}

function promptIdForFile(fileName) {
  return `prompt-${crypto.createHash('sha256').update(fileName).digest('hex').slice(0, 24)}`;
}

function humanizePromptFileName(fileName) {
  const base = path.basename(fileName, PROMPT_FILE_EXTENSION);
  const words = base.replace(/[-_]+/g, ' ').trim();
  if (!words) return 'Saved prompt';
  return words.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function titleFromPromptContent(content) {
  const match = String(content || '').match(/^\s*#\s+(.+?)\s*$/m);
  return match?.[1]?.trim() || '';
}

function descriptionFromPromptContent(content) {
  const lines = String(content || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'));
  return lines[0]?.slice(0, 140) || '';
}

function encodeMetadataLine(key, value) {
  return `${key}: ${JSON.stringify(String(value || ''))}`;
}

function promptDocument(prompt) {
  return [
    '---',
    encodeMetadataLine('id', prompt.id),
    encodeMetadataLine('name', prompt.name),
    encodeMetadataLine('description', prompt.description),
    encodeMetadataLine('createdAt', prompt.createdAt),
    encodeMetadataLine('updatedAt', prompt.updatedAt),
    '---',
    '',
    prompt.content.trim(),
    '',
  ].join('\n');
}

function parseFrontMatter(document) {
  const text = String(document || '').replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(text);
  if (!match) return { metadata: {}, content: text };
  const metadata = {};
  const lines = match[1].split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const separator = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
    if (!separator) return { metadata: {}, content: text };
    const [, key, rawValue] = separator;
    try {
      metadata[key] = JSON.parse(rawValue);
    } catch {
      metadata[key] = rawValue.replace(/^['"]|['"]$/g, '').trim();
    }
  }
  if (!Object.keys(metadata).some((key) => ['id', 'name', 'description', 'createdAt', 'updatedAt'].includes(key))) {
    return { metadata: {}, content: text };
  }
  return { metadata, content: match[2] };
}

function parsePromptDocument(document, fileName, stat = {}) {
  const { metadata, content } = parseFrontMatter(document);
  const normalizedContent = String(content || '').replaceAll('\r\n', '\n').trim();
  if (!normalizedContent) return null;
  const name = String(metadata.name || '').trim()
    || titleFromPromptContent(normalizedContent)
    || humanizePromptFileName(fileName);
  const description = String(metadata.description || '').trim()
    || descriptionFromPromptContent(normalizedContent);
  const fallbackTime = stat.mtime?.toISOString?.() || new Date().toISOString();
  const prompt = normalizePrompt({
    id: String(metadata.id || '').trim() || promptIdForFile(fileName),
    name,
    description,
    content: normalizedContent,
    createdAt: String(metadata.createdAt || fallbackTime),
    updatedAt: String(metadata.updatedAt || fallbackTime),
    fileName,
  });
  return prompt;
}

function promptSlug(value) {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 90);
  return slug || 'prompt';
}

function promptFileNameFor(name, id, usedNames = new Set()) {
  const base = `${promptSlug(name)}${PROMPT_FILE_EXTENSION}`;
  if (!usedNames.has(base.toLowerCase())) return base;
  const suffix = promptSlug(id).slice(-12) || 'saved';
  let candidate = `${promptSlug(name)}-${suffix}${PROMPT_FILE_EXTENSION}`;
  let index = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${promptSlug(name)}-${suffix}-${index}${PROMPT_FILE_EXTENSION}`;
    index += 1;
  }
  return candidate;
}

function isPromptFileName(value) {
  const fileName = String(value || '');
  return Boolean(
    fileName
      && path.basename(fileName) === fileName
      && fileName.toLowerCase().endsWith(PROMPT_FILE_EXTENSION)
      && fileName !== PROMPT_FILE_EXTENSION
      && !fileName.includes('\0'),
  );
}

// The prompt library used to live in the renderer's localStorage. On chatgpt.com
// that storage belongs to someone else, so the library moved to the agent. Prompt
// bodies are now ordinary Markdown files so they can be edited and packaged without
// being forced through a small JSON/text-field limit.
class PromptService {
  constructor(dataRoot) {
    this.promptsDirectory = path.join(dataRoot, 'prompts');
    this.legacyFilePath = path.join(dataRoot, LEGACY_PROMPTS_FILE_NAME);
    this.migrationPromise = null;
  }

  async initialize() {
    if (!this.migrationPromise) {
      this.migrationPromise = this.initializeLibrary().catch((error) => {
        this.migrationPromise = null;
        throw error;
      });
    }
    return this.migrationPromise;
  }

  async initializeLibrary() {
    await fs.mkdir(this.promptsDirectory, { recursive: true });
    await this.migrateLegacyPrompts();
  }

  async readPromptFiles() {
    const entries = await fs.readdir(this.promptsDirectory, { withFileTypes: true }).catch(() => []);
    const prompts = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(PROMPT_FILE_EXTENSION)) continue;
      const filePath = path.join(this.promptsDirectory, entry.name);
      try {
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_PROMPT_FILE_BYTES) continue;
        const content = await fs.readFile(filePath, 'utf8');
        const prompt = parsePromptDocument(content, entry.name, stat);
        if (prompt) prompts.push(prompt);
      } catch {
        // One malformed prompt should not make the whole library unavailable.
      }
    }
    return prompts;
  }

  async migrateLegacyPrompts() {
    let raw;
    try {
      raw = await fs.readFile(this.legacyFilePath, 'utf8');
    } catch {
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;

    const existing = await this.readPromptFiles();
    const existingIds = new Set(existing.map((prompt) => prompt.id));
    const usedNames = new Set(existing.map((prompt) => prompt.fileName.toLowerCase()));
    const migrated = [];

    for (const value of parsed) {
      const prompt = normalizePrompt(value);
      if (!prompt || existingIds.has(prompt.id)) continue;
      const fileName = promptFileNameFor(prompt.name, prompt.id, usedNames);
      usedNames.add(fileName.toLowerCase());
      await this.writePromptFile({ ...prompt, fileName });
      existingIds.add(prompt.id);
      migrated.push(fileName);
    }

    let migratedPath = path.join(path.dirname(this.legacyFilePath), MIGRATED_PROMPTS_FILE_NAME);
    try {
      await fs.access(migratedPath);
      const parsedPath = path.parse(migratedPath);
      let index = 2;
      while (true) {
        const candidate = path.join(parsedPath.dir, `${parsedPath.base}.${index}`);
        try {
          await fs.access(candidate);
          index += 1;
        } catch {
          migratedPath = candidate;
          break;
        }
      }
    } catch {
      // The default migrated path is available.
    }

    await fs.rename(this.legacyFilePath, migratedPath);
    return migrated;
  }

  async list() {
    await this.initialize();
    const prompts = await this.readPromptFiles();
    const seen = new Set();
    return prompts
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
      .filter((prompt) => {
        if (!prompt || seen.has(prompt.id)) return false;
        seen.add(prompt.id);
        return true;
      })
      .slice(0, MAX_PROMPTS);
  }

  async writePromptFile(prompt) {
    if (!isPromptFileName(prompt.fileName)) throw new Error('Saved prompt file name is invalid.');
    const document = promptDocument(prompt);
    if (Buffer.byteLength(document, 'utf8') > MAX_PROMPT_FILE_BYTES) {
      throw new Error(`Saved prompts are limited to ${MAX_PROMPT_FILE_BYTES} bytes per Markdown file.`);
    }
    await fs.mkdir(this.promptsDirectory, { recursive: true });
    const filePath = path.join(this.promptsDirectory, prompt.fileName);
    const temporaryPath = path.join(
      this.promptsDirectory,
      `.${prompt.fileName}.${crypto.randomUUID()}.tmp`,
    );
    try {
      await fs.writeFile(temporaryPath, document, 'utf8');
      await fs.rename(temporaryPath, filePath);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
    return prompt;
  }

  async save(input) {
    await this.initialize();
    const prompts = await this.list();
    const existing = input?.id ? prompts.find((prompt) => prompt.id === input.id) : null;
    const prompt = normalizePrompt({
      ...input,
      id: existing?.id || input?.id,
      createdAt: existing?.createdAt,
      updatedAt: new Date().toISOString(),
      fileName: existing?.fileName,
    });
    if (!prompt) throw new Error('A saved prompt needs a name and instruction text.');
    if (Buffer.byteLength(prompt.content, 'utf8') > MAX_PROMPT_FILE_BYTES) {
      throw new Error(`Saved prompts are limited to ${MAX_PROMPT_FILE_BYTES} bytes per Markdown file.`);
    }
    const duplicate = prompts.find((item) => item.id !== prompt.id
      && item.name.trim().toLowerCase() === prompt.name.trim().toLowerCase());
    if (duplicate) throw new Error(`A saved prompt named “${prompt.name}” already exists.`);
    if (prompts.length >= MAX_PROMPTS && !existing) {
      throw new Error(`The prompt library is limited to ${MAX_PROMPTS} prompts.`);
    }

    const usedNames = new Set(prompts
      .filter((item) => item.id !== prompt.id)
      .map((item) => item.fileName.toLowerCase()));
    const fileName = existing?.fileName || promptFileNameFor(prompt.name, prompt.id, usedNames);
    await this.writePromptFile({ ...prompt, fileName });
    return { ...prompt, fileName };
  }

  async remove(promptId) {
    const prompts = await this.list();
    const prompt = prompts.find((item) => item.id === String(promptId));
    if (!prompt) throw new Error('That saved prompt no longer exists.');
    await fs.unlink(path.join(this.promptsDirectory, prompt.fileName));
    return prompts.filter((item) => item.id !== prompt.id);
  }

  async gitSummaryPrompt() {
    const prompts = await this.list();
    const match = prompts.find((prompt) => prompt.name.trim().toLowerCase() === GIT_SUMMARY_PROMPT_NAME);
    return match?.content?.trim() || null;
  }

  async resolveSelected(promptIds) {
    if (!Array.isArray(promptIds) || promptIds.length === 0) return [];
    const prompts = new Map((await this.list()).map((prompt) => [prompt.id, prompt]));
    return promptIds.map((id) => prompts.get(String(id))).filter(Boolean);
  }

  async getFile(promptId) {
    const prompt = (await this.list()).find((item) => item.id === String(promptId));
    if (!prompt) throw new Error('That saved prompt no longer exists.');
    const filePath = path.join(this.promptsDirectory, prompt.fileName);
    const stat = await fs.stat(filePath);
    return { path: filePath, name: prompt.fileName, size: stat.size };
  }
}

module.exports = {
  DEFAULT_GIT_SUMMARY_PROMPT,
  GIT_SUMMARY_PROMPT_NAME,
  MAX_PROMPTS,
  MAX_PROMPT_FILE_BYTES,
  PROMPT_FILE_EXTENSION,
  PromptService,
  encodeMetadataLine,
  normalizePrompt,
  parsePromptDocument,
  promptDocument,
  promptFileNameFor,
  resolveGitSummaryPrompt,
};
