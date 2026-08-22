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
const {
  conversationIdFromRouteUrl,
  isChatGPTConversationUrl,
  normalizeConversationTitle,
} = require('../../shared/chatgpt');

const SCHEMA_VERSION = 1;
const TASK_MODELS = new Set(['default', 'sol', 'luna']);
const REASONING_MODES = new Set(['default', 'instant', 'low', 'medium', 'high', 'extra-high']);
const FOLLOW_UP_MODES = new Set(['ask', 'agent']);
const FOLLOW_UP_ACTIVE_STATES = new Set(['created', 'submitted', 'awaiting-result']);

const DETAILED_COMMIT_MESSAGE_REQUIREMENTS = `Review the final cumulative changes and produce one accurate, detailed Conventional Commit message for the result.

Inspect the complete result diff, including relevant surrounding code when necessary. Do not summarize the diff line-by-line. Determine the actual behavioral intent by understanding how the modified files, functions, components, types, tests, configuration, dependencies, and call sites interact.

The commit message should explain:

* What behavior changed and why
* How important modified code interacts across files or layers
* Whether the change introduces, removes, fixes, refactors, or optimizes functionality
* Important implementation details that explain the resulting behavior
* Tests, migrations, configuration, dependencies, or API changes that materially affect the result
* Breaking changes, if any

Use this format:

\`\`\`text
<type>(<optional-scope>): <concise summary>

<concise but detailed body explaining the meaningful changes and how they work together>

<optional BREAKING CHANGE footer>
\`\`\`

Use the most appropriate Conventional Commit type, such as \`feat\`, \`fix\`, \`refactor\`, \`perf\`, \`test\`, \`docs\`, \`build\`, \`ci\`, or \`chore\`.

Keep the subject concise and specific. Keep the body dense with useful information, focusing on intent and behavior rather than filenames or mechanical implementation details. Avoid vague statements, redundant bullets, speculation, and details that do not help someone understand the result from Git history alone.

If the changes contain multiple related modifications, synthesize them into one cohesive commit description based on their shared purpose. If the diff contains genuinely unrelated work, mention that clearly instead of inventing a misleading unifying description.`;

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

function normalizeFollowUpMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (!FOLLOW_UP_MODES.has(mode)) throw new Error(`Unsupported follow-up mode: ${value}`);
  return mode;
}

function followUpTurn(task) {
  const turns = Array.isArray(task?.turns) ? task.turns : [];
  if (!task?.activeTurnId) return null;
  return turns.find((turn) => turn.id === task.activeTurnId) || null;
}

function buildFollowUpPrompt(task, prompt, mode, skillIds = []) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('Describe the follow-up before sending it.');
  const selectedSkills = new Set((Array.isArray(skillIds) ? skillIds : []).map((id) => String(id)));
  const skills = (Array.isArray(task.skills) ? task.skills : [])
    .filter((skill) => selectedSkills.has(String(skill.id)))
    .map((skill) => skill.name || skill.id)
    .filter(Boolean);
  const skillNote = skills.length
    ? `\n\nFor this turn, use these task-bound skills from the existing package when relevant: ${skills.map((name) => `\`/${name}\``).join(', ')}. Read each selected skill's \`SKILL.md\` before relying on it.`
    : '';
  if (mode === 'ask') return `${text}${skillNote}`;
  const filename = task.resultFilename || `chatgpt-ide-result-${task.taskId}.txt`;
  return `${text}\n\n## Patchwork Agent follow-up protocol\n\nContinue the existing Patchwork task in Agent mode. Work in the repositories already attached to this conversation; do not create a new Patchwork task or conversation. Return the complete current task state in a Patchwork result file named \`${filename}\` using the existing \`PATCHWORK_RESULT_V1\` plain-text/base64 format. The result must use task ID \`${task.taskId}\` and include every task repository with an empty patch when it has no changes. This is a cumulative follow-up result, so preserve all changes that belong to this task. The existing task package already contains the authoritative context for the task. If that original package was created for Ask mode, this Agent follow-up supersedes that read-only instruction for this turn only. Do not create a second task identity. Recalculate the \`commitMessage\` from the complete cumulative changes and keep it as a detailed Conventional Commit message; this field is the authoritative commit message Patchwork will preserve and use when the result is applied.${skillNote}`;
}

function buildAgentInstructions(taskId, skills = [], options = {}) {
  const resultFilename = `chatgpt-ide-result-${taskId}.txt`;
  const summaryOnly = Boolean(options.summaryOnly);
  const answerOnly = Boolean(options.answerOnly);
  const includeIac = Boolean(options.includeIac);
  const resultSummaryExample = summaryOnly
    ? 'A concise summary of the change.'
    : 'A concise summary of the implementation and verification performed.';
  const skillInstructions = skills.length
    ? `## Optional task skills

This task includes ${skills.length} selected local skill${skills.length === 1 ? '' : 's'} under the \`skills/\` directory. The selected skills are listed in \`manifest.json\`. Read a skill's \`SKILL.md\` and follow it only when that skill is clearly relevant to the task. Do not load or invoke unrelated skills, and do not edit the bundled skill files.

`
    : `## Optional task skills

Task packages may include selected local skills under the \`skills/\` directory. When skills are present, use or invoke them only when they are clearly relevant to the task. Do not load unrelated skills just because they are available, and do not edit bundled skill files.

`;
  if (answerOnly) {
    return `# Patchwork answer-only task protocol

You are answering a question supplied by the user through Patchwork IDE. The uploaded ZIP is a self-contained context package containing Git bundles. This is a read-only task: inspect the supplied context, but do not modify repository files, create commits, or generate a Patchwork result file.

## Inspect the supplied context

1. Extract the uploaded ZIP into a writable directory.
2. Read \`AGENTS.md\`, \`manifest.json\`, and \`TASK.md\` completely. If \`manifest.json.attachments\` is non-empty, also read each listed file under \`attachments/\`. If \`manifest.json.skills\` is non-empty, the selected skills are bundled under \`skills/\`; use them only when relevant.
3. For each entry in \`manifest.json.repositories\`, clone its \`bundleFile\` from the extracted \`repositories\` directory into \`workspace/<id>\`, check out \`baseCommit\`, and verify that \`git rev-parse HEAD\` exactly equals that commit.
4. Inspect relevant source, history, and captured working changes. When \`workingChanges\` is true, read \`workingStatus\` and inspect \`git diff --binary <sourceHead> <baseCommit> -- .\` when \`sourceHead\` is present.${includeIac ? `
5. Treat every bundled entry in \`manifest.json.iac_repos\` as read-only infrastructure context. Clone it from \`iac/<...>\`, check out its supplied \`baseCommit\`, and inspect it only when relevant.` : ''}

${skillInstructions}## Sandbox constraints

Do not install or update dependencies, access package registries, or run builds, tests, linters, type checks, development servers, code generators, or packaging commands. You may search and inspect files and use read-only Git commands.

## Answer the task

Answer the question or request in \`TASK.md\` directly in the chat. Give a detailed, evidence-based explanation and connect conclusions to the relevant source, history, or supplied context. Clearly distinguish confirmed behavior from inference and call out important uncertainty.

Do not edit files, create commits, generate patches, create \`chatgpt-ide-result-${taskId}.txt\`, or emit a \`PATCHWORK_RESULT_V1\` envelope. Your normal chat response is the complete result of this task.
`;
  }
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
    ? 'This is a read-only Git summary task. Inspect the bundled repository and its captured uncommitted changes, including the supplied `workingStatus` and `sourceHead`, then produce the detailed Conventional Commit message requested by `TASK.md`. Do not modify files or create commits. Every repository patch in the result must be empty.'
    : 'Follow repository-specific `AGENTS.md` files except where they conflict with the sandbox constraints above. Implement the task in `TASK.md`, inspect the final cumulative diff carefully, and keep changes focused. In the result summary, state that builds and tests were not run because the task protocol prohibits them in the ChatGPT sandbox; do not present this as an implementation failure.'}

## Commit message metadata

${DETAILED_COMMIT_MESSAGE_REQUIREMENTS}

The generated commit message is part of the machine-readable result contract, not just the chat response. Put the complete message, including its detailed body and optional footer, in the JSON \`commitMessage\` field. Do not put the detailed commit message only in \`summary\`, do not shorten it to a subject line, and do not wrap the payload value in Markdown fences. The \`commitMessage\` value must be valid as a Conventional Commit and must reflect the final cumulative result, including all follow-up changes. \`summary\` remains a separate concise human-readable implementation summary.

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
  "summary": "${resultSummaryExample}",
  "commitMessage": "feat(editor): improve result metadata\\n\\nExplain the meaningful behavioral changes, how the affected pieces work together, and any material test, configuration, dependency, API, or breaking-change details.",
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

The complete \`commitMessage\` field is required for every non-answer task, including tasks without a coding tree. Its first line must follow Conventional Commits: \`type(optional-scope): concise description\`, and the full value must be the detailed message generated from the final cumulative diff. Patchwork may apply the result to a coding tree chosen after this task finishes, so this field is also the source for the commit and Source Control AI Summary/Suggestion. Include every repository from the input manifest, even when its patch is empty (encode the empty byte sequence as an empty string). Do not abbreviate, omit, or truncate patch data. Attach \`chatgpt-ide-result-${taskId}.txt\` to your final response as a downloadable file. Briefly summarize the work in the chat. Do not print or paste the result envelope or patch contents in the chat itself. Never print the result envelope or patch contents in the chat itself.

${summaryOnly ? 'For this read-only Git summary task, set `commitMessage` to the single Conventional Commit message requested by `TASK.md`, set every repository `patch` value to an empty string, and do not include code changes in the result.' : ''}
`;
}

function buildHandoffPrompt(taskId, taskText, attachments = [], skills = [], options = {}) {
  const summaryOnly = Boolean(options.summaryOnly);
  const answerOnly = Boolean(options.answerOnly);
  const includeIac = Boolean(options.includeIac);
  const attachmentNote = attachments.length
    ? `\n\nThe task ZIP contains these user-provided context files under \`attachments/\`: ${attachments.map((item) => item.name).join(', ')}. Read them as needed ${answerOnly ? 'when answering' : 'before making changes'}.`
    : '';
  const skillNote = skills.length
    ? `\n\nThe task ZIP also includes ${skills.length} selected local skill${skills.length === 1 ? '' : 's'} under \`skills/\`. Use or invoke a selected skill only when it is relevant to the task, and do not load unrelated skills.`
    : '\n\nThe task ZIP may include selected local skills under \`skills/\`. Use or invoke them only when they are relevant to the task.';
  const iacNote = includeIac
    ? `\n\nThe task package may also contain read-only infrastructure-as-code Git bundles under \`iac/\`. Use those repositories for deployment and platform context, but do not edit them${answerOnly ? '.' : ' or include them in result patches.'}`
    : '';
  if (answerOnly) {
    return `I attached a Patchwork IDE ZIP task package containing read-only Git context. Extract it, read AGENTS.md, manifest.json, and TASK.md completely, inspect the bundled context, and answer the request in detail directly in the chat. Do not modify files, create commits, generate patches, or create a Patchwork result file.${attachmentNote}${skillNote}${iacNote}\n\nQuestion or request:\n${taskText}`;
  }
  if (summaryOnly) {
    return `I attached a Patchwork IDE ZIP task package containing Git bundles for a read-only Source Control summary. Extract it, read AGENTS.md, manifest.json, and TASK.md completely, then inspect the captured uncommitted changes without modifying files or creating commits. Create and attach the required downloadable text file named chatgpt-ide-result-${taskId}.txt using the PATCHWORK_RESULT_V1 payload described in AGENTS.md. Return an empty patch for every repository and put the complete generated Conventional Commit message, including its detailed body, in commitMessage. Do not paste PATCHWORK_RESULT_V1 or any result envelope into the chat.${attachmentNote}${skillNote}${iacNote}\n\nGit Summary instructions:\n${taskText}`;
  }
  return `I attached a Patchwork IDE ZIP task package containing Git bundles. Extract it, read AGENTS.md, manifest.json, and TASK.md completely, then solve the task against the bundled repositories. Create and attach the required downloadable text file named chatgpt-ide-result-${taskId}.txt. Do not paste PATCHWORK_RESULT_V1 or any result envelope into the chat.${attachmentNote}${skillNote}${iacNote}\n\nTask summary:\n${taskText}\n\nFor the final PATCHWORK_RESULT_V1 payload, generate the complete detailed Conventional Commit message from the final cumulative diff and put that exact message in commitMessage. This field is required even when no coding tree was selected because Patchwork may use the result later for the commit or Source Control AI Summary/Suggestion.\n\nDo not install dependencies or run builds, tests, linters, type checks, development servers, code generators, or packaging commands; the ChatGPT sandbox cannot run them. Make changes only in writable repositories and return an empty patch for each read-only repository. Never print or paste the result envelope or patch contents in the conversation.`;
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
    this.followUpCreationLocks = new Set();
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
    const answerOnly = Boolean(input.answerOnly);

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
      const readOnly = summaryOnly || answerOnly || Boolean(requestedRepositories.get(repository.path)?.readOnly);
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
      iac_settings_path: iacPackage.includesIacRepositories ? iacPackage.settingsPath : null,
      includes_iac_repos: iacPackage.includesIacRepositories,
      iac_repos: iacPackage.repositories,
      attachments: packageAttachments,
      skills: packageSkills,
      answerOnly,
    };
    const taskMarkdown = `# Software task\n\n${taskText}\n`;
    const agentInstructions = buildAgentInstructions(taskId, packageSkills, {
      summaryOnly,
      answerOnly,
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
      answerOnly,
      transport: 'zip-git-bundle',
      resultTransport: answerOnly ? null : 'downloaded-text-file',
      treeId: input.tree?.id || null,
      treeName: input.tree?.name || null,
      mergeResolution: Boolean(input.mergeResolution),
      resolvesTaskId: input.resolvesTaskId ? String(input.resolvesTaskId) : null,
      conversationId: null,
      conversationTitle: null,
      chatStatus: null,
      chatStatusRaw: null,
      chatFinishedAt: null,
      resultFilename: answerOnly ? null : `chatgpt-ide-result-${taskId}.txt`,
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
        answerOnly,
        includeIac: Boolean(input.includeIac),
      }),
      repositories: taskRepositories,
      state: 'prepared',
      result: null,
      turns: [],
      activeTurnId: null,
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

  async updateConversationTitle(taskId, title) {
    const task = await this.getTask(taskId);
    const conversationTitle = normalizeConversationTitle(title).slice(0, 240);
    if (!conversationTitle || conversationTitle === task.conversationTitle) return task;
    return this.updateTask(taskId, { conversationTitle });
  }

  async createFollowUp(taskId, input = {}) {
    if (this.followUpCreationLocks.has(taskId)) {
      throw new Error('Another follow-up turn is already being created for this task.');
    }
    this.followUpCreationLocks.add(taskId);
    try {
      const task = await this.getTask(taskId);
      if (task.summaryOnly) throw new Error('Git Summary tasks do not accept follow-up conversation turns.');
      if (task.mergeResolution) throw new Error('Conflict-resolution tasks must use the existing resolution workflow.');
      if (task.state === 'conflicted') throw new Error('Resolve the task conflict before starting a normal follow-up.');
      if (task.state === 'failed') throw new Error('This task is in a failed state and cannot accept another follow-up.');
      if (task.state === 'submitted') throw new Error('The task is still generating its current response. Wait for it to finish before starting a follow-up.');
      if (task.applyInProgress) throw new Error('The task result is being applied. Wait for the apply operation to finish.');
      if (followUpTurn(task)) throw new Error('Another follow-up turn is already active for this task.');
      if (!isChatGPTConversationUrl(task.conversationUrl)) {
        throw new Error('This task has no valid ChatGPT conversation for follow-up.');
      }
      const routeConversationId = conversationIdFromRouteUrl(task.conversationUrl);
      if (task.conversationId && routeConversationId && task.conversationId !== routeConversationId) {
        throw new Error('The saved ChatGPT conversation ID does not match the task conversation URL.');
      }
      const conversationId = task.conversationId || routeConversationId;
      if (!conversationId) throw new Error('This task has no usable ChatGPT conversation ID for follow-up.');

      const mode = normalizeFollowUpMode(input.mode);
      const prompt = String(input.prompt || '').trim();
      if (!prompt) throw new Error('Describe the follow-up before sending it.');
      const resolvedPrompt = String(input.resolvedPrompt || prompt).trim();
      const model = normalizeTaskModel(input.model ?? task.model);
      const reasoningMode = normalizeReasoningMode(input.reasoningMode ?? task.reasoningMode);
      const promptIds = Array.isArray(input.promptIds) ? input.promptIds.map((id) => String(id)).filter(Boolean) : [];
      const taskSkillIds = new Set((Array.isArray(task.skills) ? task.skills : []).map((skill) => String(skill.id)));
      const skillIds = Array.isArray(input.skillIds) ? input.skillIds.map((id) => String(id)).filter(Boolean) : [];
      if (skillIds.some((id) => !taskSkillIds.has(id))) {
        throw new Error('A follow-up can only reuse skills that were already included in the task package.');
      }
      const attachments = (Array.isArray(input.attachments) ? input.attachments : [])
        .map((attachment) => ({
          name: String(attachment?.name || '').trim().slice(0, 180),
          size: Number.isFinite(Number(attachment?.size)) ? Number(attachment.size) : null,
        }))
        .filter((attachment) => attachment.name);
      const createdAt = new Date().toISOString();
      const turn = {
        id: crypto.randomUUID(),
        mode,
        prompt,
        resolvedPrompt,
        model,
        reasoningMode,
        promptIds,
        skillIds,
        attachments,
        state: 'created',
        createdAt,
        submittedAt: null,
        completedAt: null,
        failedAt: null,
        error: null,
        resultSourceFile: null,
        conversationId,
        conversationUrl: task.conversationUrl,
        resumeState: task.state,
        resumeChatStatus: task.chatStatus || null,
      };

      let repositories = task.repositories;
      let resultFilename = task.resultFilename;
      let resultTransport = task.resultTransport;
      if (mode === 'agent' && task.answerOnly) {
        repositories = (Array.isArray(task.repositories) ? task.repositories : []).map((repository) => ({
          ...repository,
          readOnly: false,
        }));
        resultFilename = resultFilename || `chatgpt-ide-result-${task.taskId}.txt`;
        resultTransport = 'downloaded-text-file';
      }

      return this.updateTask(taskId, {
        repositories,
        resultFilename,
        resultTransport,
        conversationId,
        turns: [...(Array.isArray(task.turns) ? task.turns : []), turn],
        activeTurnId: turn.id,
        chatStatus: 'streaming',
        chatStatusRaw: 'IS_STREAMING',
        chatFinishedAt: null,
        error: null,
      });
    } finally {
      this.followUpCreationLocks.delete(taskId);
    }
  }

  async markFollowUpSubmitted(taskId, turnId, input = {}) {
    const task = await this.getTask(taskId);
    const turn = followUpTurn(task);
    if (!turn || turn.id !== turnId) throw new Error('The follow-up turn is no longer active.');
    if (!['created', 'submitted'].includes(turn.state)) throw new Error('The follow-up turn is no longer waiting to be submitted.');
    const submittedAt = turn.submittedAt || new Date().toISOString();
    const turns = (task.turns || []).map((item) => (item.id === turnId
      ? {
        ...item,
        state: 'submitted',
        submittedAt,
        conversationId: input.conversationId || item.conversationId || task.conversationId || null,
        model: input.model || item.model,
        reasoningMode: input.reasoningMode || item.reasoningMode,
        error: null,
      }
      : item));
    return this.updateTask(taskId, {
      turns,
      conversationId: input.conversationId || task.conversationId || turn.conversationId || null,
      chatStatus: 'streaming',
      chatStatusRaw: 'IS_STREAMING',
      chatFinishedAt: null,
      error: null,
    });
  }

  async updateFollowUpChatStatus(taskId, status, conversationId = null, message = null) {
    const task = await this.getTask(taskId);
    const turn = followUpTurn(task);
    if (!turn) {
      return this.updateTask(taskId, {
        conversationId: conversationId || task.conversationId || null,
        chatStatus: status,
        chatStatusRaw: status === 'streaming' ? 'IS_STREAMING' : status === 'failed' ? 'FAILURE' : 'COMPLETED',
        chatFinishedAt: status === 'streaming' ? null : task.chatFinishedAt || new Date().toISOString(),
      });
    }
    const now = new Date().toISOString();
    const turns = (task.turns || []).map((item) => {
      if (item.id !== turn.id) return item;
      if (status === 'streaming') return { ...item, state: 'submitted', error: null };
      if (status === 'failed') return {
        ...item,
        state: 'failed',
        failedAt: now,
        completedAt: null,
        error: message || 'ChatGPT stopped before completing the follow-up.',
      };
      if (turn.mode === 'agent') return {
        ...item,
        state: 'awaiting-result',
        completedAt: null,
        error: null,
      };
      return {
        ...item,
        state: 'completed',
        completedAt: now,
        error: null,
      };
    });
    const completed = status === 'completed' && turn.mode === 'ask';
    const failed = status === 'failed';
    const nextState = completed && !task.result && ['prepared', 'submitted'].includes(task.state)
      ? 'completed'
      : task.state;
    return this.updateTask(taskId, {
      state: failed ? task.state : nextState,
      conversationId: conversationId || task.conversationId || turn.conversationId || null,
      chatStatus: status,
      chatStatusRaw: status === 'streaming' ? 'IS_STREAMING' : status === 'failed' ? 'FAILURE' : 'COMPLETED',
      chatFinishedAt: status === 'streaming' ? null : now,
      turns,
      activeTurnId: completed || failed ? null : turn.id,
      error: failed ? (message || 'ChatGPT stopped before completing the follow-up.') : null,
    });
  }

  async failFollowUp(taskId, turnId, message) {
    const task = await this.getTask(taskId);
    const turn = followUpTurn(task);
    if (!turn || turn.id !== turnId) throw new Error('The follow-up turn is no longer active.');
    return this.updateFollowUpChatStatus(taskId, 'failed', null, message);
  }

  async completeFollowUpResult(taskId, turnId, resultSourceFile, taskState = null) {
    const task = await this.getTask(taskId);
    const turn = followUpTurn(task);
    if (!turn || turn.id !== turnId) return task;
    const now = new Date().toISOString();
    const turns = (task.turns || []).map((item) => (item.id === turnId
      ? {
        ...item,
        state: ['failed', 'conflicted'].includes(taskState || task.state) ? 'failed' : 'completed',
        completedAt: ['failed', 'conflicted'].includes(taskState || task.state) ? null : now,
        failedAt: ['failed', 'conflicted'].includes(taskState || task.state) ? now : null,
        error: ['failed', 'conflicted'].includes(taskState || task.state)
          ? (task.error || 'The follow-up result could not be applied.')
          : null,
        resultSourceFile: resultSourceFile || item.resultSourceFile || null,
      }
      : item));
    return this.updateTask(taskId, {
      turns,
      activeTurnId: null,
      chatStatus: ['failed', 'conflicted'].includes(taskState || task.state) ? 'failed' : 'completed',
      chatStatusRaw: ['failed', 'conflicted'].includes(taskState || task.state) ? 'FAILURE' : 'COMPLETED',
      chatFinishedAt: task.chatFinishedAt || now,
      error: ['failed', 'conflicted'].includes(taskState || task.state) ? task.error : null,
    });
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
  FOLLOW_UP_ACTIVE_STATES,
  SCHEMA_VERSION,
  TaskService,
  buildAgentInstructions,
  buildHandoffPrompt,
  resolveTreeTaskRepositories,
  buildFollowUpPrompt,
  followUpTurn,
  normalizeFollowUpMode,
};
