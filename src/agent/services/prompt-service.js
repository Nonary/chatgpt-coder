const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_PROMPTS = 100;
const MAX_PROMPT_CONTENT_LENGTH = 12_000;
const GIT_SUMMARY_PROMPT_NAME = 'git summary';

function normalizePrompt(value) {
  const name = String(value?.name || '').trim().slice(0, 60);
  const description = String(value?.description || '').trim().slice(0, 140);
  const content = String(value?.content || '')
    .replaceAll('\r\n', '\n')
    .trim()
    .slice(0, MAX_PROMPT_CONTENT_LENGTH);
  if (!name || !content) return null;
  const createdAt = String(value?.createdAt || new Date().toISOString());
  return {
    id: String(value?.id || '').trim() || `prompt-${crypto.randomUUID()}`,
    name,
    description,
    content,
    createdAt,
    updatedAt: String(value?.updatedAt || createdAt),
  };
}

// The prompt library used to live in the renderer's localStorage. On chatgpt.com
// that storage belongs to someone else, so the library moved to the agent.
class PromptService {
  constructor(dataRoot) {
    this.filePath = path.join(dataRoot, 'prompts.json');
  }

  async list() {
    let parsed = [];
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch {
      return [];
    }
    const seen = new Set();
    return (Array.isArray(parsed) ? parsed : [])
      .map(normalizePrompt)
      .filter((prompt) => {
        if (!prompt || seen.has(prompt.id)) return false;
        seen.add(prompt.id);
        return true;
      })
      .slice(0, MAX_PROMPTS);
  }

  async write(prompts) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(prompts, null, 2)}\n`);
    return prompts;
  }

  async save(input) {
    const prompts = await this.list();
    const existing = input?.id ? prompts.find((prompt) => prompt.id === input.id) : null;
    const prompt = normalizePrompt({
      ...input,
      id: existing?.id || input?.id,
      createdAt: existing?.createdAt,
      updatedAt: new Date().toISOString(),
    });
    if (!prompt) throw new Error('A saved prompt needs a name and instruction text.');
    const duplicate = prompts.find((item) => item.id !== prompt.id
      && item.name.trim().toLowerCase() === prompt.name.trim().toLowerCase());
    if (duplicate) throw new Error(`A saved prompt named “${prompt.name}” already exists.`);
    const next = existing
      ? prompts.map((item) => (item.id === prompt.id ? prompt : item))
      : [...prompts, prompt];
    if (next.length > MAX_PROMPTS) throw new Error(`The prompt library is limited to ${MAX_PROMPTS} prompts.`);
    await this.write(next);
    return prompt;
  }

  async remove(promptId) {
    const prompts = await this.list();
    const next = prompts.filter((prompt) => prompt.id !== promptId);
    if (next.length === prompts.length) throw new Error('That saved prompt no longer exists.');
    await this.write(next);
    return next;
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
}

function appendPromptInstructions(taskText, prompts = []) {
  if (!prompts.length) return taskText;
  const additions = prompts
    .map((prompt) => `### ${prompt.name}\n${prompt.content.trim()}`)
    .filter(Boolean)
    .join('\n\n');
  return `${taskText}\n\nAdditional instructions from the prompt library:\n\n${additions}`;
}

module.exports = {
  GIT_SUMMARY_PROMPT_NAME,
  MAX_PROMPTS,
  MAX_PROMPT_CONTENT_LENGTH,
  PromptService,
  appendPromptInstructions,
  normalizePrompt,
};
