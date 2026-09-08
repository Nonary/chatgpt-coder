const fs = require('node:fs/promises');
const path = require('node:path');

const LIBRARY_FILE_NAME = 'library.json';
const LIBRARY_SCHEMA_VERSION = 1;
const MAX_LIBRARY_FILE_BYTES = 1024 * 1024;
const RESOURCE_TYPES = new Set(['prompts', 'skills']);

function normalizeId(value) {
  return String(value || '').trim();
}

function emptyLibrary() {
  return {
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    prompts: {},
    skills: {},
  };
}

function normalizeLibrary(value) {
  const library = emptyLibrary();
  for (const type of RESOURCE_TYPES) {
    const source = value?.[type];
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [id, entry] of Object.entries(source)) {
      const normalizedId = normalizeId(id);
      if (!normalizedId) continue;
      if (typeof entry === 'boolean') library[type][normalizedId] = { enabled: entry };
      else if (entry && typeof entry === 'object' && typeof entry.enabled === 'boolean') {
        library[type][normalizedId] = { enabled: entry.enabled };
      }
    }
  }
  return library;
}

class LibraryService {
  constructor(dataRoot) {
    this.dataRoot = dataRoot;
    this.filePath = path.join(dataRoot, LIBRARY_FILE_NAME);
    this.library = emptyLibrary();
    this.initializePromise = null;
    this.writePromise = Promise.resolve();
  }

  async initialize() {
    if (!this.initializePromise) {
      this.initializePromise = this.load().catch((error) => {
        this.initializePromise = null;
        throw error;
      });
    }
    return this.initializePromise;
  }

  async load() {
    await fs.mkdir(this.dataRoot, { recursive: true });
    let raw;
    try {
      const stat = await fs.stat(this.filePath);
      if (stat.size > MAX_LIBRARY_FILE_BYTES) {
        throw new Error('Patchwork library preferences are too large to load safely.');
      }
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return this.library;
      throw error;
    }
    try {
      this.library = normalizeLibrary(JSON.parse(raw));
    } catch {
      this.library = emptyLibrary();
    }
    return this.library;
  }

  async write() {
    this.writePromise = this.writePromise.catch(() => {}).then(async () => {
      await fs.mkdir(this.dataRoot, { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      const document = `${JSON.stringify(this.library, null, 2)}\n`;
      try {
        await fs.writeFile(temporaryPath, document, 'utf8');
        await fs.rename(temporaryPath, this.filePath);
      } finally {
        await fs.rm(temporaryPath, { force: true }).catch(() => {});
      }
    });
    return this.writePromise;
  }

  async decorate(type, items) {
    await this.initialize();
    if (!RESOURCE_TYPES.has(type)) throw new Error(`Unknown library resource type: ${type}`);
    return (items || []).map((item) => ({
      ...item,
      enabled: this.library[type][normalizeId(item.id)]?.enabled !== false,
    }));
  }

  async setEnabled(type, id, enabled) {
    await this.initialize();
    if (!RESOURCE_TYPES.has(type)) throw new Error(`Unknown library resource type: ${type}`);
    const normalizedId = normalizeId(id);
    if (!normalizedId) throw new Error('A library item needs an id.');
    if (enabled === false) this.library[type][normalizedId] = { enabled: false };
    else delete this.library[type][normalizedId];
    await this.write();
    return enabled !== false;
  }

  async remove(type, id) {
    await this.initialize();
    if (!RESOURCE_TYPES.has(type)) throw new Error(`Unknown library resource type: ${type}`);
    delete this.library[type][normalizeId(id)];
    await this.write();
  }
}

module.exports = {
  LIBRARY_FILE_NAME,
  LIBRARY_SCHEMA_VERSION,
  LibraryService,
  normalizeLibrary,
};
