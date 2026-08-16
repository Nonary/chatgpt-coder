const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');
const {
  createBundle,
  createSnapshotBundle,
  createWorkingSnapshotBundle,
  inspectRepository,
} = require('./git');

const SCHEMA_VERSION = 1;

function buildAgentInstructions(taskId) {
  return `# Patchwork task protocol

You are working on a software task supplied by the user through Patchwork IDE.
The uploaded ZIP is a self-contained task package containing Git bundles. Do not merely describe a solution: extract the package, inspect the repositories, make the requested changes, and return the exact downloadable text result described below.

## Set up the repositories

1. Extract the uploaded ZIP into a writable directory.
2. Read \`AGENTS.md\`, \`manifest.json\`, and \`TASK.md\` completely.
3. For each entry in \`manifest.json.repositories\`, clone its \`bundleFile\` from the extracted \`repositories\` directory into \`workspace/<id>\`.
4. In each clone, check out \`baseCommit\` and create a working branch named \`patchwork/${taskId}\`.
5. Verify that \`git rev-parse HEAD\` exactly equals the supplied \`baseCommit\` before editing.
6. The bundle contains the repository history reachable from the supplied task tip. Inspect relevant history before changing code.

## Inspect supplied working changes

For every manifest repository with \`workingChanges: true\`, the supplied \`baseCommit\` captures staged, unstaged, untracked, or unmerged files that already existed in the coding tree. These changes are task input, not work you should discard.

- Read its \`workingStatus\`, then run \`git status --short\` and inspect the files and conflict markers carefully.
- When \`sourceHead\` is present, inspect the captured working changes with \`git diff --binary <sourceHead> <baseCommit> -- .\`.
- To view those captured files as unstaged changes, you may run \`git reset --mixed <sourceHead>\`, inspect \`git status\` and \`git diff\`, then run \`git reset --hard <baseCommit>\` before implementing the task.
- If \`CONFLICTS.md\` exists, read it completely and inspect every original patch under \`conflicts/\`. Resolve the current unmerged or unstaged state while preserving the intended changes from both sides.

You may create commits as checkpoints. Do not rewrite the supplied base history and do not add generated dependencies, build output, credentials, or unrelated files.

## Solve and verify the task

Follow any repository-specific \`AGENTS.md\` files found after cloning. Implement the task in \`TASK.md\`, run relevant checks when possible, and inspect the final diff. Keep changes focused on the requested task.

## Produce the downloadable text result

Generate one binary-safe patch per repository from the supplied base commit so checkpoint commits are included:

\`git diff --binary <baseCommit> -- . > ../../result/patches/<id>.patch\`

Base64-encode each patch file. Create a UTF-8 text file named \`chatgpt-ide-result-${taskId}.txt\`. Its contents must be the start marker on its own line, then one JSON object with this exact shape, then the end marker on its own line:

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

The commit message first line must follow Conventional Commits: \`type(optional-scope): concise description\`. Include every repository from the input manifest, even when its patch is empty (encode the empty byte sequence as an empty string). Do not abbreviate, omit, or truncate patch data. Attach \`chatgpt-ide-result-${taskId}.txt\` to your final response as a downloadable file. Briefly summarize the work in the chat, but do not print or paste the result envelope into the chat itself.
`;
}

function buildHandoffPrompt(taskId, taskText) {
  return `I attached a Patchwork IDE ZIP task package containing Git bundles. Extract it, read AGENTS.md, manifest.json, and TASK.md completely, then solve the task against the bundled repositories. Create and attach the required downloadable text file named chatgpt-ide-result-${taskId}.txt. Do not paste its PATCHWORK_RESULT_V1 envelope into the chat.\n\nTask summary:\n${taskText}`;
}

function addStoredLocalFile(zip, localPath, archiveDirectory) {
  zip.addLocalFile(localPath, archiveDirectory);
  const entryName = `${archiveDirectory}/${path.basename(localPath)}`.replaceAll('\\', '/');
  const entry = zip.getEntry(entryName);
  if (entry) entry.header.method = 0;
}

function conflictMarkdown(context, patchFiles) {
  const files = context.files?.length
    ? context.files.map((file) => `- \`${file}\``).join('\n')
    : '- Git could not identify a single unmerged path; inspect the original patch and current working tree.';
  const patches = patchFiles.map((item) => `- \`${item.file}\` for repository \`${item.id}\``).join('\n');
  return `# Conflict resolution context

Patchwork could not cleanly apply the result from task \`${context.originalTaskId}\` because the coding tree changed or Git reported merge conflicts.

## Current conflict files

${files}

## Original result patches

${patches || '- No non-empty original patch was available.'}

## Apply error

\`\`\`text
${String(context.error || 'The patch did not apply cleanly.').replaceAll('```', "'''")}
\`\`\`

The bundled repository base captures the coding tree exactly as it exists now, including unstaged files and conflict markers. Inspect \`git status\`, \`git diff\`, every conflict marker, and the original result patch before editing. Resolve the conflict as part of the requested task; do not merely describe a resolution.
`;
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
          workingChanges: false,
          workingStatus: '',
        };
      } else if (repository.hasHead) {
        const snapshotPath = path.join(taskDir, '.snapshot', repository.id);
        try {
          const snapshot = await createWorkingSnapshotBundle(repository, snapshotPath, bundlePath);
          taskRepository = {
            ...repository,
            sourceHead: repository.baseCommit,
            baseCommit: snapshot.baseCommit,
            isSnapshot: true,
            snapshotFingerprint: snapshot.snapshotFingerprint,
            workingChanges: true,
            workingStatus: repository.statusSummary,
          };
        } finally {
          await fs.rm(snapshotPath, { recursive: true, force: true });
        }
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
            workingChanges: true,
            workingStatus: repository.statusSummary,
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
        sourceHead: taskRepository.sourceHead,
        snapshot: taskRepository.isSnapshot,
        workingChanges: taskRepository.workingChanges,
        workingStatus: taskRepository.workingStatus,
        bundleFile,
      });
    }

    const conflictPatchFiles = [];
    if (input.conflictContext) {
      const conflictDir = path.join(taskDir, 'conflicts');
      await fs.mkdir(conflictDir, { recursive: true });
      for (const patch of input.conflictContext.patches || []) {
        if (!patch?.localPath || !/^[a-z0-9._-]+$/i.test(String(patch.id || ''))) continue;
        const file = `conflicts/${patch.id}.patch`;
        await fs.copyFile(patch.localPath, path.join(taskDir, file));
        conflictPatchFiles.push({ id: patch.id, file });
      }
    }

    const createdAt = new Date().toISOString();
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      taskId,
      createdAt,
      repositories: publicRepositories,
    };
    if (input.conflictContext) {
      manifest.conflictResolution = {
        originalTaskId: input.conflictContext.originalTaskId,
        files: input.conflictContext.files || [],
        patches: conflictPatchFiles,
      };
    }
    const taskMarkdown = `# Software task\n\n${taskText}\n`;
    const agentInstructions = buildAgentInstructions(taskId);

    await Promise.all([
      fs.writeFile(path.join(taskDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`),
      fs.writeFile(path.join(taskDir, 'TASK.md'), taskMarkdown),
      fs.writeFile(path.join(taskDir, 'AGENTS.md'), agentInstructions),
      ...(input.conflictContext ? [
        fs.writeFile(path.join(taskDir, 'CONFLICTS.md'), conflictMarkdown(input.conflictContext, conflictPatchFiles)),
      ] : []),
    ]);

    const packagePath = path.join(taskDir, `chatgpt-ide-task-${taskId}.zip`);
    const zip = new AdmZip();
    zip.addLocalFile(path.join(taskDir, 'manifest.json'));
    zip.addLocalFile(path.join(taskDir, 'TASK.md'));
    zip.addLocalFile(path.join(taskDir, 'AGENTS.md'));
    if (input.conflictContext) zip.addLocalFile(path.join(taskDir, 'CONFLICTS.md'));
    for (const repository of publicRepositories) {
      addStoredLocalFile(zip, path.join(taskDir, repository.bundleFile), 'repositories');
    }
    for (const patch of conflictPatchFiles) zip.addLocalFile(path.join(taskDir, patch.file), 'conflicts');
    await fs.writeFile(packagePath, await zip.toBufferPromise());
    const packageStat = await fs.stat(packagePath);

    const record = {
      ...manifest,
      taskText,
      autoApply: input.autoApply !== false,
      transport: 'zip-git-bundle',
      resultTransport: 'downloaded-text-file',
      treeId: input.tree?.id || null,
      treeName: input.tree?.name || null,
      sourceRepositoryPath: input.tree?.repositoryPath || null,
      packagePath,
      packageBytes: packageStat.size,
      handoffPrompt: buildHandoffPrompt(taskId, taskText),
      repositories: taskRepositories,
      state: 'prepared',
      result: null,
      conflictContext: input.conflictContext ? manifest.conflictResolution : null,
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
