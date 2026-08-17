const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const {
  createBundle,
  createSnapshotBundle,
  createWorkingSnapshotBundle,
  inspectRepository,
  runGit,
} = require('./git');
const { IacService } = require('./iac-service');
const { SkillService } = require('./skill-service');

const SCHEMA_VERSION = 1;
const TASK_MODELS = new Set(['default', 'sol', 'luna']);
const REASONING_MODES = new Set(['default', 'instant', 'low', 'medium', 'high', 'extra-high']);

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

function normalizeTaskModel(value) {
  const model = String(value || 'default').trim().toLowerCase();
  if (!TASK_MODELS.has(model)) throw new Error(`Unsupported ChatGPT model: ${value}`);
  return model;
}

function normalizeReasoningMode(value) {
  const mode = String(value || 'default').trim().toLowerCase();
  if (!REASONING_MODES.has(mode)) throw new Error(`Unsupported ChatGPT reasoning mode: ${value}`);
  return mode;
}

function buildAgentInstructions(taskId, skills = [], options = {}) {
  const resultFilename = `chatgpt-ide-result-${taskId}.txt`;
  const summaryOnly = Boolean(options.summaryOnly);
  const includeIac = Boolean(options.includeIac);
  const skillInstructions = skills.length
    ? `## Optional task skills

This task includes ${skills.length} selected local skill${skills.length === 1 ? '' : 's'} under the \`skills/\` directory. The selected skills are listed in \`manifest.json\`. Read a skill's \`SKILL.md\` and follow it only when that skill is clearly relevant to the task. Do not load or invoke unrelated skills, and do not edit the bundled skill files.

`
    : `## Optional task skills

Task packages may include selected local skills under the \`skills/\` directory. When skills are present, use or invoke them only when they are clearly relevant to the task. Do not load unrelated skills just because they are available, and do not edit bundled skill files.

`;
  return `# Patchwork task protocol

You are working on a task supplied by the user through Patchwork IDE.
The uploaded ZIP is a self-contained task package containing Git bundles. Extract the package, inspect the repositories, and return the exact downloadable text result described below.${summaryOnly ? ' This request is read-only; inspect the captured changes without modifying repository files.' : ' Do not merely describe a solution: make the requested changes.'}

## Set up the repositories

1. Extract the uploaded ZIP into a writable directory.
2. Read \`AGENTS.md\`, \`manifest.json\`, and \`TASK.md\` completely. If \`manifest.json.attachments\` is non-empty, also read each listed file under \`attachments/\`; those files are user-provided task context. If \`manifest.json.skills\` is non-empty, the selected skills are bundled under \`skills/\`; use them only when relevant to the task.
3. For each entry in \`manifest.json.repositories\`, clone its \`bundleFile\` from the extracted \`repositories\` directory into \`workspace/<id>\`. Some repositories are read-only context: you may inspect them, but never edit them.
4. In each clone, check out \`baseCommit\` and create a working branch named \`patchwork/${taskId}\`.
5. Verify that \`git rev-parse HEAD\` exactly equals the supplied \`baseCommit\` before editing.
6. The bundle contains the repository history reachable from the supplied task tip. Inspect relevant history before changing code.${includeIac ? `
7. If \`manifest.json.iac_repos\` is present, treat every entry with a \`bundleFile\` as read-only infrastructure context. Clone each IaC bundle from \`iac/<...>\` into \`workspace/iac/<id>\`, check out its supplied \`baseCommit\`, and verify \`git rev-parse HEAD\`. Do not edit IaC repositories and never include IaC paths in returned result patches; entries without a bundle were skipped during packaging.` : ''}

## Inspect supplied working changes

For every manifest repository with \`workingChanges: true\`, the supplied \`baseCommit\` captures staged, unstaged, untracked, or unmerged files that already existed in the selected repository. These changes are task input, not work you should discard.

- Read its \`workingStatus\`, then run \`git status --short\` and inspect the files and conflict markers carefully.
- When \`sourceHead\` is present, inspect the captured working changes with \`git diff --binary <sourceHead> <baseCommit> -- .\`.
- To view those captured files as unstaged changes, you may run \`git reset --mixed <sourceHead>\`, inspect \`git status\` and \`git diff\`, then run \`git reset --hard <baseCommit>\` before implementing the task.
- If \`CONFLICTS.md\` exists, read it completely and inspect every original patch under \`conflicts/\`. Resolve the current unmerged or unstaged state while preserving the intended changes from both sides.

You may create commits as checkpoints. Do not rewrite the supplied base history and do not add generated dependencies, build output, credentials, or unrelated files.

${skillInstructions}## Sandbox constraints

The ChatGPT sandbox cannot successfully install dependencies or run this project's verification toolchain. Do not attempt any of the following:

- installing, updating, or downloading dependencies;
- accessing package registries or other external network resources;
- running builds, tests, linters, type checks, development servers, code generators, or packaging commands;
- changing dependency manifests or lockfiles merely to make the sandbox environment work.

These commands are prohibited even if a repository-specific instruction suggests running them. There is no value in trying and retrying commands that cannot work in this sandbox. You may inspect files, search source text, and use read-only Git commands such as \`git status\`, \`git diff\`, and \`git log\`.

## Solve and inspect the task

${summaryOnly
    ? 'This is a read-only Git summary task. Inspect the bundled repository and its captured uncommitted changes, including the supplied `workingStatus` and `sourceHead`, then produce the Conventional Commit message requested by `TASK.md`. Do not modify files or create commits. Every repository patch in the result must be empty.'
    : 'Follow repository-specific `AGENTS.md` files except where they conflict with the sandbox constraints above. Implement the task in `TASK.md`, inspect the final diff carefully, and keep changes focused. In the result summary, state that builds and tests were not run because the task protocol prohibits them in the ChatGPT sandbox; do not present this as an implementation failure.'}

## Produce the plain-text result

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
  "commitMessage": "A Conventional Commit message for coding-tree tasks, for example feat(editor): add split diff view; null is allowed when no coding tree is used",
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

When a coding tree is used, the commit message first line must follow Conventional Commits: \`type(optional-scope): concise description\`. For tasks without a coding tree, the commit message may be null. Include every repository from the input manifest, even when its patch is empty (encode the empty byte sequence as an empty string). Do not abbreviate, omit, or truncate patch data. Attach \`chatgpt-ide-result-${taskId}.txt\` to your final response as a downloadable file. Briefly summarize the work in the chat. Do not print or paste the result envelope or patch contents in the chat itself. Never print the result envelope or patch contents in the chat itself.

${summaryOnly ? 'For this read-only Git summary task, set `commitMessage` to the single Conventional Commit message requested by `TASK.md`, set every repository `patch` value to an empty string, and do not include code changes in the result.' : ''}
`;
}

function buildHandoffPrompt(taskId, taskText, attachments = [], skills = [], options = {}) {
  const summaryOnly = Boolean(options.summaryOnly);
  const includeIac = Boolean(options.includeIac);
  const attachmentNote = attachments.length
    ? `\n\nThe task ZIP contains these user-provided context files under \`attachments/\`: ${attachments.map((item) => item.name).join(', ')}. Read them as needed before making changes.`
    : '';
  const skillNote = skills.length
    ? `\n\nThe task ZIP also includes ${skills.length} selected local skill${skills.length === 1 ? '' : 's'} under \`skills/\`. Use or invoke a selected skill only when it is relevant to the task, and do not load unrelated skills.`
    : '\n\nThe task ZIP may include selected local skills under \`skills/\`. Use or invoke them only when they are relevant to the task.';
  const iacNote = includeIac
    ? '\n\nThe task package may also contain read-only infrastructure-as-code Git bundles under `iac/`. Use those repositories for deployment and platform context, but do not edit them or include them in result patches.'
    : '';
  if (summaryOnly) {
    return `I attached a Patchwork IDE ZIP task package containing Git bundles for a read-only Source Control summary. Extract it, read AGENTS.md, manifest.json, and TASK.md completely, then inspect the captured uncommitted changes without modifying files or creating commits. Create and attach the required downloadable text file named chatgpt-ide-result-${taskId}.txt using the PATCHWORK_RESULT_V1 payload described in AGENTS.md. Return an empty patch for every repository and put the generated Conventional Commit message in commitMessage. Do not paste PATCHWORK_RESULT_V1 or any result envelope into the chat.${attachmentNote}${skillNote}${iacNote}\n\nGit Summary instructions:\n${taskText}`;
  }
  return `I attached a Patchwork IDE ZIP task package containing Git bundles. Extract it, read AGENTS.md, manifest.json, and TASK.md completely, then solve the task against the bundled repositories. Create and attach the required downloadable text file named chatgpt-ide-result-${taskId}.txt. Do not paste PATCHWORK_RESULT_V1 or any result envelope into the chat.${attachmentNote}${skillNote}${iacNote}\n\nTask summary:\n${taskText}\n\nDo not install dependencies or run builds, tests, linters, type checks, development servers, code generators, or packaging commands; the ChatGPT sandbox cannot run them. Make changes only in writable repositories and return an empty patch for each read-only repository. Never print or paste the result envelope or patch contents in the conversation.`;
}

function uniqueAttachmentName(filename, usedNames) {
  const parsed = path.parse(filename);
  let candidate = filename;
  let suffix = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${parsed.name} (${suffix})${parsed.ext}`;
    suffix += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function addStoredLocalFile(zip, localPath, archiveDirectory) {
  zip.addLocalFile(localPath, archiveDirectory);
  const entryName = `${archiveDirectory}/${path.basename(localPath)}`.replaceAll('\\', '/');
  const entry = zip.getEntry(entryName);
  if (entry) entry.header.method = 0;
}

async function resolveTreeTaskRepositories(tree, selectedRepositories = []) {
  const treePath = await fs.realpath(tree.path);
  const sourcePath = await fs.realpath(tree.repositoryPath);
  const repositories = [{ path: treePath }];
  const seen = new Set([treePath, sourcePath]);
  for (const repository of selectedRepositories) {
    if (!repository?.path) continue;
    const repositoryPath = await fs.realpath(repository.path);
    if (seen.has(repositoryPath)) continue;
    seen.add(repositoryPath);
    repositories.push({ path: repositoryPath, readOnly: true });
  }
  return repositories;
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

The bundled repository base captures the selected repository exactly as it exists now, including unstaged files and conflict markers. Inspect \`git status\`, \`git diff\`, every conflict marker, and the original result patch before editing. Resolve the conflict as part of the requested task; do not merely describe a resolution.
`;
}

class TaskService {
  constructor(dataRoot, skillService = new SkillService(), iacService = new IacService()) {
    this.dataRoot = dataRoot;
    this.tasksRoot = path.join(dataRoot, 'tasks');
    this.skillService = skillService;
    this.iacService = iacService;
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

  async packageIacRepositories(taskDir, includeIac) {
    if (!includeIac) {
      return {
        includesIacRepositories: false,
        settingsPath: this.iacService.settingsPath,
        repositories: [],
      };
    }

    const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-iac-'));
    try {
      const resolved = await this.iacService.resolveRepositories(path.join(scratchRoot, 'clones'));
      if (!resolved.exists) {
        return {
          includesIacRepositories: false,
          settingsPath: resolved.settingsPath,
          repositories: [],
        };
      }

      const bundleDirectory = path.join(taskDir, 'iac');
      await fs.mkdir(bundleDirectory, { recursive: true });
      const usedBundleNames = new Set();
      const publicRepositories = [];

      for (const entry of resolved.repositories) {
        if (entry.status !== 'ready') {
          publicRepositories.push({
            name: null,
            selector: entry.selector,
            source_path: entry.source_path || null,
            sourcePath: entry.source_path || null,
            source: entry.source || 'settings',
            bundle: null,
            bundleFile: null,
            head: null,
            baseCommit: null,
            sourceHead: null,
            branch: null,
            snapshot: false,
            workingChanges: false,
            workingStatus: '',
            readOnly: true,
            status: entry.status,
          });
          continue;
        }

        const repository = await inspectRepository(entry.source_path);
        const baseName = repository.name
          .normalize('NFKD')
          .replace(/[^a-zA-Z0-9._-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .toLowerCase() || 'iac-repo';
        let bundleName = `${baseName}.bundle`;
        let suffix = 2;
        while (usedBundleNames.has(bundleName)) {
          bundleName = `${baseName}-${suffix}.bundle`;
          suffix += 1;
        }
        usedBundleNames.add(bundleName);

        const bundleFile = `iac/${bundleName}`;
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
          const snapshotPath = path.join(scratchRoot, 'snapshots', repository.id);
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
          const snapshotPath = path.join(scratchRoot, 'snapshots', repository.id);
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

        const origin = await runGit(repository.path, ['remote', 'get-url', 'origin'])
          .then(({ stdout }) => stdout.trim() || null)
          .catch(() => null);
        publicRepositories.push({
          id: repository.id,
          name: repository.name,
          selector: entry.selector,
          source_path: entry.source === 'local_path' ? entry.source_path : null,
          sourcePath: entry.source === 'local_path' ? entry.source_path : null,
          source: entry.source,
          origin,
          branch: taskRepository.branch,
          head: taskRepository.baseCommit,
          baseCommit: taskRepository.baseCommit,
          sourceHead: taskRepository.sourceHead,
          snapshot: taskRepository.isSnapshot,
          workingChanges: taskRepository.workingChanges,
          workingStatus: taskRepository.workingStatus,
          bundle: bundleFile,
          bundleFile,
          readOnly: true,
          status: 'bundled',
        });
      }

      return {
        includesIacRepositories: true,
        settingsPath: resolved.settingsPath,
        repositories: publicRepositories,
      };
    } finally {
      await fs.rm(scratchRoot, { recursive: true, force: true });
    }
  }

  async createTask(input) {
    const taskText = String(input.taskText || '').trim();
    if (!taskText) throw new Error('Describe the software task before creating a package.');
    if (!Array.isArray(input.repositories) || input.repositories.length === 0) {
      throw new Error('Add at least one Git repository.');
    }
    const model = normalizeTaskModel(input.model);
    const reasoningMode = normalizeReasoningMode(input.reasoningMode);
    const summaryOnly = Boolean(input.summaryOnly);

    const repositories = await this.inspectRepositories(input.repositories.map((item) => item.path));
    const skillRepositoryPaths = Array.isArray(input.skillRepositoryPaths) && input.skillRepositoryPaths.length
      ? input.skillRepositoryPaths
      : input.repositories.map((item) => item.path);
    const selectedSkills = await this.skillService.resolveSelectedSkillIds(input.skillIds, skillRepositoryPaths);
    const requestedRepositories = new Map(await Promise.all(input.repositories.map(async (item) => [
      await fs.realpath(item.path),
      item,
    ])));
    const taskId = crypto.randomUUID();
    const taskDir = this.taskDirectory(taskId);
    const bundlesDir = path.join(taskDir, 'repositories');
    await fs.mkdir(bundlesDir, { recursive: true });

    const attachments = [];
    const requestedAttachments = Array.isArray(input.attachments) ? input.attachments : [];
    if (requestedAttachments.length > 0) {
      const attachmentsDir = path.join(taskDir, 'attachments');
      const usedNames = new Set();
      await fs.mkdir(attachmentsDir, { recursive: true });
      for (const item of requestedAttachments) {
        const sourcePath = typeof item === 'string' ? item : item?.path;
        if (!sourcePath) throw new Error('Choose a valid attachment file.');
        const resolvedPath = await fs.realpath(sourcePath);
        const stat = await fs.stat(resolvedPath);
        if (!stat.isFile()) throw new Error(`Task attachment is not a file: ${sourcePath}`);
        const name = uniqueAttachmentName(path.basename(resolvedPath), usedNames);
        const attachmentPath = path.join(attachmentsDir, name);
        await fs.copyFile(resolvedPath, attachmentPath);
        attachments.push({ name, path: attachmentPath, size: stat.size });
      }
    }

    const taskSkills = [];
    if (selectedSkills.length > 0) {
      const skillsRoot = path.join(taskDir, 'skills');
      await fs.mkdir(skillsRoot, { recursive: true });
      for (const skill of selectedSkills) {
        const storagePath = path.join(skillsRoot, skill.id);
        await fs.cp(skill.sourcePath, storagePath, { recursive: true, force: true });
        taskSkills.push({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          provider: skill.provider,
          scope: skill.scope,
          location: skill.location,
          directory: `skills/${skill.id}`,
          skillFile: `skills/${skill.id}/SKILL.md`,
          path: storagePath,
        });
      }
    }

    const conflictPatchFiles = [];
    if (input.conflictContext) {
      const conflictsDir = path.join(taskDir, 'conflicts');
      await fs.mkdir(conflictsDir, { recursive: true });
      for (const patch of input.conflictContext.patches || []) {
        if (!patch.localPath) continue;
        const filename = `${patch.id}.patch`;
        const relativeFile = `conflicts/${filename}`;
        await fs.copyFile(patch.localPath, path.join(conflictsDir, filename));
        conflictPatchFiles.push({ id: patch.id, file: relativeFile });
      }
      await fs.writeFile(
        path.join(taskDir, 'CONFLICTS.md'),
        conflictMarkdown(input.conflictContext, conflictPatchFiles),
      );
    }

    const publicRepositories = [];
    const taskRepositories = [];
    for (const repository of repositories) {
      const readOnly = summaryOnly || Boolean(requestedRepositories.get(repository.path)?.readOnly);
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
      taskRepository.readOnly = readOnly;
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
        readOnly,
      });
    }

    const iacPackage = await this.packageIacRepositories(taskDir, Boolean(input.includeIac));

    const createdAt = new Date().toISOString();
    const packageAttachments = attachments.map(({ name, size }) => ({
      name,
      size,
      file: `attachments/${name}`,
    }));
    const packageSkills = taskSkills.map(({ path: _path, ...skill }) => skill);
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      taskId,
      createdAt,
      repositories: publicRepositories,
      includesIacRepositories: iacPackage.includesIacRepositories,
      iacSettingsPath: iacPackage.includesIacRepositories ? iacPackage.settingsPath : null,
      includes_iac_repos: iacPackage.includesIacRepositories,
      iac_repos: iacPackage.repositories,
      attachments: packageAttachments,
      skills: packageSkills,
    };
    const taskMarkdown = `# Software task\n\n${taskText}\n`;
    const agentInstructions = buildAgentInstructions(taskId, packageSkills, {
      summaryOnly,
      includeIac: Boolean(input.includeIac),
    });

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
    if (input.conflictContext) zip.addLocalFile(path.join(taskDir, 'CONFLICTS.md'));
    for (const repository of publicRepositories) {
      addStoredLocalFile(zip, path.join(taskDir, repository.bundleFile), 'repositories');
    }
    for (const repository of iacPackage.repositories) {
      if (repository.bundleFile) addStoredLocalFile(zip, path.join(taskDir, repository.bundleFile), 'iac');
    }
    for (const attachment of attachments) zip.addLocalFile(attachment.path, 'attachments');
    for (const skill of taskSkills) zip.addLocalFolder(skill.path, skill.directory);
    for (const patch of conflictPatchFiles) zip.addLocalFile(path.join(taskDir, patch.file), 'conflicts');
    await fs.writeFile(packagePath, await zip.toBufferPromise());
    const packageStat = await fs.stat(packagePath);

    const record = {
      ...manifest,
      taskText,
      model,
      reasoningMode,
      skills: taskSkills,
      includeIac: Boolean(input.includeIac),
      autoApply: input.autoApply !== false,
      summaryOnly,
      transport: 'zip-git-bundle',
      resultTransport: 'downloaded-text-file',
      treeId: input.tree?.id || null,
      treeName: input.tree?.name || null,
      mergeResolution: Boolean(input.mergeResolution),
      resolvesTaskId: input.resolvesTaskId ? String(input.resolvesTaskId) : null,
      conversationId: null,
      conversationTitle: null,
      chatStatus: null,
      chatStatusRaw: null,
      chatFinishedAt: null,
      resultFilename: `chatgpt-ide-result-${taskId}.txt`,
      sourceRepositoryPath: input.tree?.repositoryPath
        || (taskRepositories.length === 1 ? taskRepositories[0].path : null),
      chatgptProject: input.chatgptProject?.id ? {
        id: String(input.chatgptProject.id),
        shortUrl: input.chatgptProject.shortUrl ? String(input.chatgptProject.shortUrl) : null,
        name: String(input.chatgptProject.name || '').trim() || 'ChatGPT project',
      } : null,
      packagePath,
      attachments,
      handoffPrompt: buildHandoffPrompt(taskId, taskText, attachments, packageSkills, {
        summaryOnly,
        includeIac: Boolean(input.includeIac),
      }),
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

  async setTarget(taskId, target = {}) {
    const task = await this.getTask(taskId);
    if (['applied', 'rolled-back', 'resolved'].includes(task.state)) {
      throw new Error('This task can no longer change its apply target.');
    }
    const writableRepositories = (Array.isArray(task.repositories) ? task.repositories : [])
      .filter((repository) => !repository.readOnly);
    if (writableRepositories.length !== 1) {
      throw new Error('Worktree selection is only available for tasks with one writable repository.');
    }
    const repositoryPath = String(target.repositoryPath || '').trim();
    if (!repositoryPath) throw new Error('Choose a valid task target.');
    const repository = await inspectRepository(repositoryPath);
    const targetTree = target.tree || null;
    const writableId = writableRepositories[0].id;
    const repositories = task.repositories.map((entry) => (entry.id === writableId
      ? {
        ...entry,
        name: repository.name,
        path: repository.path,
        branch: repository.branch,
        readOnly: false,
      }
      : entry));
    return this.updateTask(taskId, {
      treeId: targetTree?.id || null,
      treeName: targetTree?.name || null,
      sourceRepositoryPath: task.sourceRepositoryPath || targetTree?.repositoryPath || repository.path,
      repositories,
    });
  }

  async deleteTask(taskId) {
    const task = await this.getTask(taskId);
    await fs.rm(this.taskDirectory(task.taskId), { recursive: true, force: true });
    return task;
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
  DEFAULT_GIT_SUMMARY_PROMPT,
  resolveGitSummaryPrompt,
  resolveTreeTaskRepositories,
};
