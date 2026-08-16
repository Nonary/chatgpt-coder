const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createBundle, createSnapshotBundle, inspectRepository } = require('./git');

const SCHEMA_VERSION = 1;

function buildAgentInstructions(taskId) {
  return `# Patchwork task protocol

You are working on a software task supplied by the user through Patchwork IDE.
The uploaded TXT file is a self-contained plain-text transport envelope. Do not merely describe a solution: reconstruct the repositories, make the requested changes, and return the exact plain-text result described below. Do not create a downloadable result file.

## Set up the repositories

1. Read the uploaded JSON envelope. It has \`format: "patchwork-task-plain-text-v1"\` and a \`files\` array.
2. For every file entry, base64-decode \`content\` to its relative \`path\` in a writable directory. This reconstructs \`manifest.json\`, \`TASK.md\`, \`AGENTS.md\`, and each Git bundle without using a binary attachment.
3. Read \`manifest.json\` and \`TASK.md\` completely.
4. For each entry in \`manifest.json.repositories\`, clone \`bundleFile\` into \`workspace/<id>\`.
5. In each clone, check out \`baseCommit\` and create a working branch named \`patchwork/${taskId}\`.
6. Verify that \`git rev-parse HEAD\` exactly equals the supplied \`baseCommit\` before editing.

You may create commits as checkpoints. Do not rewrite the supplied base history and do not add generated dependencies, build output, credentials, or unrelated files.

## Solve and verify the task

Follow any repository-specific \`AGENTS.md\` files found after cloning. Implement the task in \`TASK.md\`, run relevant checks when possible, and inspect the final diff. Keep changes focused on the requested task.

## Produce the plain-text result

Generate one binary-safe patch per repository from the supplied base commit so checkpoint commits are included:

\`git diff --binary <baseCommit> -- . > ../../result/patches/<id>.patch\`

Base64-encode each patch file. In your final response, output the start marker on its own line, then one JSON object with this exact shape, then the end marker on its own line:

\`PATCHWORK_RESULT_V1\`

\`\`\`json
{
  "schemaVersion": 2,
  "transport": "plain-text-base64",
  "taskId": "${taskId}",
  "status": "completed",
  "summary": "A concise summary of the implementation and verification performed.",
  "commitMessage": "A Conventional Commit message, for example feat(editor): add split diff view",
  "repositories": [
    {
      "id": "the repository id from manifest.json",
      "baseCommit": "the exact base commit from manifest.json",
      "patchEncoding": "base64",
      "patch": "the complete base64-encoded git diff --binary output"
    }
  ]
}
\`\`\`

\`PATCHWORK_RESULT_END\`

The commit message first line must follow Conventional Commits: \`type(optional-scope): concise description\`. Include every repository from the input manifest, even when its patch is empty (encode the empty byte sequence as an empty string). The markers and JSON must be visible response text, not a download, attachment, link, or image. Do not abbreviate, omit, or truncate patch data. You may put the complete envelope in a single code block, but put no commentary inside the markers.
`;
}

function buildHandoffPrompt(taskId, taskText) {
  return `I attached a Patchwork IDE plain-text task envelope. Reconstruct it, read AGENTS.md and TASK.md completely, then solve the task against the bundled Git repositories. Return the required PATCHWORK_RESULT_V1 plain-text envelope directly in your final response; do not create a downloadable file.\n\nTask summary:\n${taskText}`;
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

    const transportFiles = ['manifest.json', 'TASK.md', 'AGENTS.md', ...publicRepositories.map((item) => item.bundleFile)];
    const files = await Promise.all(transportFiles.map(async (relativePath) => ({
      path: relativePath,
      encoding: 'base64',
      content: (await fs.readFile(path.join(taskDir, relativePath))).toString('base64'),
    })));
    const packagePath = path.join(taskDir, `chatgpt-ide-task-${taskId}.txt`);
    await fs.writeFile(packagePath, `${JSON.stringify({
      format: 'patchwork-task-plain-text-v1',
      taskId,
      files,
    }, null, 2)}\n`, 'utf8');

    const record = {
      ...manifest,
      taskText,
      autoApply: input.autoApply !== false,
      transport: 'plain-text-base64',
      treeId: input.tree?.id || null,
      treeName: input.tree?.name || null,
      sourceRepositoryPath: input.tree?.repositoryPath || null,
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
