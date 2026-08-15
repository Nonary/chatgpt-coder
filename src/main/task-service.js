const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { createBundle, createSnapshotBundle, inspectRepository } = require('./git');

const SCHEMA_VERSION = 1;

function buildAgentInstructions(taskId) {
  return `# Patchwork task protocol

You are working on a software task supplied by the user through Patchwork IDE.
The uploaded ZIP is a self-contained transport package. Do not merely describe a solution: inspect the repositories, make the requested changes, and return the exact result artifact described below.

## Set up the repositories

1. Extract this ZIP into a writable directory.
2. Read \`manifest.json\` and \`TASK.md\` completely.
3. For each entry in \`manifest.json.repositories\`, clone \`bundleFile\` into \`workspace/<id>\`.
4. In each clone, check out \`baseCommit\` and create a working branch named \`patchwork/${taskId}\`.
5. Verify that \`git rev-parse HEAD\` exactly equals the supplied \`baseCommit\` before editing.

You may create commits as checkpoints. Do not rewrite the supplied base history and do not add generated dependencies, build output, credentials, or unrelated files.

## Solve and verify the task

Follow any repository-specific \`AGENTS.md\` files found after cloning. Implement the task in \`TASK.md\`, run relevant checks when possible, and inspect the final diff. Keep changes focused on the requested task.

## Produce the result

Create a directory named \`result\` containing:

- \`result.json\`
- one binary-safe patch per repository under \`patches/<id>.patch\`

Generate each patch from the supplied base commit so checkpoint commits are included:

\`git diff --binary <baseCommit> -- . > ../../result/patches/<id>.patch\`

Use this exact JSON shape in \`result/result.json\`:

\`\`\`json
{
  "schemaVersion": 1,
  "taskId": "${taskId}",
  "status": "completed",
  "summary": "A concise summary of the implementation and verification performed.",
  "repositories": [
    {
      "id": "the repository id from manifest.json",
      "baseCommit": "the exact base commit from manifest.json",
      "patchFile": "patches/the-repository-id.patch"
    }
  ]
}
\`\`\`

Include every repository from the input manifest, even when its patch is empty. Finally, ZIP the contents of \`result\` as:

\`chatgpt-ide-result-${taskId}.zip\`

Your final response must briefly summarize the work and provide that ZIP as a downloadable file. Do not paste large patches into the conversation.
`;
}

function buildHandoffPrompt(taskId, taskText) {
  return `I attached a Patchwork IDE task package. Extract it, read AGENTS.md and TASK.md completely, then solve the task against the bundled Git repositories. Return the required downloadable file named chatgpt-ide-result-${taskId}.zip.\n\nTask summary:\n${taskText}`;
}

class TaskService {
  constructor(dataRoot) {
    this.dataRoot = dataRoot;
    this.tasksRoot = path.join(dataRoot, 'tasks');
  }

  async initialize() {
    await fs.mkdir(this.tasksRoot, { recursive: true });
  }

  taskDirectory(taskId) {
    return path.join(this.tasksRoot, taskId);
  }

  async inspectRepositories(selectedPaths) {
    const repositories = await Promise.all(selectedPaths.map(inspectRepository));
    const unique = new Map(repositories.map((repository) => [repository.path, repository]));
    return [...unique.values()];
  }

  async createTask(input) {
    const taskText = String(input.taskText || '').trim();
    if (!taskText) throw new Error('Describe the software task before creating a package.');
    if (!Array.isArray(input.repositories) || input.repositories.length === 0) {
      throw new Error('Add at least one Git repository.');
    }

    const repositories = await this.inspectRepositories(input.repositories.map((item) => item.path));
    const taskId = crypto.randomUUID();
    const taskDir = this.taskDirectory(taskId);
    const bundlesDir = path.join(taskDir, 'repositories');
    await fs.mkdir(bundlesDir, { recursive: true });

    const publicRepositories = [];
    const taskRepositories = [];
    for (const repository of repositories) {
      const bundleFile = `repositories/${repository.id}.bundle`;
      const bundlePath = path.join(taskDir, bundleFile);
      let taskRepository;
      if (repository.hasHead && repository.isClean) {
        await createBundle(repository, bundlePath);
        taskRepository = {
          ...repository,
          sourceHead: repository.baseCommit,
          isSnapshot: false,
          snapshotFingerprint: null,
        };
      } else {
        const snapshotPath = path.join(taskDir, '.snapshot', repository.id);
        try {
          const snapshot = await createSnapshotBundle(repository, snapshotPath, bundlePath);
          taskRepository = {
            ...repository,
            sourceHead: repository.baseCommit,
            baseCommit: snapshot.baseCommit,
            isSnapshot: true,
            snapshotFingerprint: snapshot.snapshotFingerprint,
          };
        } finally {
          await fs.rm(snapshotPath, { recursive: true, force: true });
        }
      }
      taskRepositories.push(taskRepository);
      publicRepositories.push({
        id: repository.id,
        name: repository.name,
        branch: repository.branch,
        baseCommit: taskRepository.baseCommit,
        snapshot: taskRepository.isSnapshot,
        bundleFile,
      });
    }

    const createdAt = new Date().toISOString();
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      taskId,
      createdAt,
      repositories: publicRepositories,
    };
    const taskMarkdown = `# Software task\n\n${taskText}\n`;
    const agentInstructions = buildAgentInstructions(taskId);

    await Promise.all([
      fs.writeFile(path.join(taskDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`),
      fs.writeFile(path.join(taskDir, 'TASK.md'), taskMarkdown),
      fs.writeFile(path.join(taskDir, 'AGENTS.md'), agentInstructions),
    ]);

    const packagePath = path.join(taskDir, `chatgpt-ide-task-${taskId}.zip`);
    const zip = new AdmZip();
    zip.addLocalFile(path.join(taskDir, 'manifest.json'));
    zip.addLocalFile(path.join(taskDir, 'TASK.md'));
    zip.addLocalFile(path.join(taskDir, 'AGENTS.md'));
    for (const repository of publicRepositories) {
      zip.addLocalFile(path.join(taskDir, repository.bundleFile), 'repositories');
    }
    await new Promise((resolve, reject) => {
      zip.writeZip(packagePath, (error) => (error ? reject(error) : resolve()));
    });

    const record = {
      ...manifest,
      taskText,
      autoApply: input.autoApply !== false,
      packagePath,
      handoffPrompt: buildHandoffPrompt(taskId, taskText),
      repositories: taskRepositories,
      state: 'prepared',
      result: null,
    };
    await this.saveTask(record);
    return record;
  }

  async saveTask(task) {
    const taskDir = this.taskDirectory(task.taskId);
    await fs.mkdir(taskDir, { recursive: true });
    await fs.writeFile(path.join(taskDir, 'task.json'), `${JSON.stringify(task, null, 2)}\n`);
  }

  async getTask(taskId) {
    const raw = await fs.readFile(path.join(this.taskDirectory(taskId), 'task.json'), 'utf8');
    return JSON.parse(raw);
  }

  async updateTask(taskId, update) {
    const task = await this.getTask(taskId);
    const next = { ...task, ...update, updatedAt: new Date().toISOString() };
    await this.saveTask(next);
    return next;
  }

  async listTasks() {
    await this.initialize();
    const entries = await fs.readdir(this.tasksRoot, { withFileTypes: true });
    const tasks = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        tasks.push(await this.getTask(entry.name));
      } catch {
        // Ignore incomplete task directories left by an interrupted packaging operation.
      }
    }
    return tasks.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
}

module.exports = {
  SCHEMA_VERSION,
  TaskService,
  buildAgentInstructions,
  buildHandoffPrompt,
};
