const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const AdmZip = require('adm-zip');

// Patchwork never rewrites line endings, so the suite pins Git's line-ending
// configuration for every repository it creates, clones, or patches. Without
// this, a host with core.autocrlf=true fails content assertions.
const gitConfigPath = path.join(os.tmpdir(), 'patchwork-test-gitconfig');
require('node:fs').writeFileSync(gitConfigPath, '[core]\n\tautocrlf = false\n\teol = lf\n');
process.env.GIT_CONFIG_GLOBAL = gitConfigPath;
process.env.GIT_CONFIG_SYSTEM = gitConfigPath;

const { fingerprintRepository, runGit } = require('../src/agent/services/git');
const { GitService, buildCompareRows, parsePorcelainStatus } = require('../src/agent/services/git-service');
const { IacService } = require('../src/agent/services/iac-service');
const { ResultService, parsePlainTextResult } = require('../src/agent/services/result-service');
const { SkillService } = require('../src/agent/services/skill-service');
const {
  DEFAULT_GIT_SUMMARY_PROMPT,
  resolveGitSummaryPrompt,
  resolveTreeTaskRepositories,
  TaskService,
} = require('../src/agent/services/task-service');
const {
  WorktreeService,
  mergeResultFilename,
  parseMergeResult,
  parseWorktreeList,
  validateCommitMessage,
} = require('../src/agent/services/worktree-service');

async function createRepository(root) {
  const repositoryPath = path.join(root, 'sample-repository');
  await fs.mkdir(repositoryPath, { recursive: true });
  await runGit(repositoryPath, ['init', '-b', 'main']);
  await runGit(repositoryPath, ['config', 'user.email', 'patchwork@example.invalid']);
  await runGit(repositoryPath, ['config', 'user.name', 'Patchwork Test']);
  // Keep line endings deterministic regardless of the host's core.autocrlf setting.
  await runGit(repositoryPath, ['config', 'core.autocrlf', 'false']);
  await runGit(repositoryPath, ['config', 'core.eol', 'lf']);
  await fs.writeFile(path.join(repositoryPath, 'hello.txt'), 'hello\n');
  await runGit(repositoryPath, ['add', 'hello.txt']);
  await runGit(repositoryPath, ['commit', '-m', 'Initial commit']);
  return repositoryPath;
}

async function ingestDownloadedText(results, tasks, task, text) {
  const incomingDir = path.join(tasks.taskDirectory(task.taskId), 'incoming');
  await fs.mkdir(incomingDir, { recursive: true });
  const downloadedPath = path.join(incomingDir, task.resultFilename);
  await fs.writeFile(downloadedPath, text);
  return results.ingestTextFile(task.taskId, downloadedPath);
}

test('Git Summary prompts use the saved prompt when present and the built-in prompt otherwise', () => {
  assert.equal(resolveGitSummaryPrompt('  Review these changes.  '), 'Review these changes.');
  assert.equal(resolveGitSummaryPrompt('\r\n'), DEFAULT_GIT_SUMMARY_PROMPT);
  assert.match(DEFAULT_GIT_SUMMARY_PROMPT, /Review all \*\*uncommitted Git changes\*\*/);
  assert.ok(DEFAULT_GIT_SUMMARY_PROMPT.includes('<type>(<optional-scope>): <concise summary>'));
});

function plainTextResult(task, patch, commitMessage = 'fix(task): apply generated changes') {
  return `PATCHWORK_RESULT_V1\n${JSON.stringify({
    schemaVersion: 2,
    transport: 'plain-text-base64',
    taskId: task.taskId,
    status: 'completed',
    summary: 'Implemented the requested change.',
    commitMessage,
    repositories: [{
      id: task.repositories[0].id,
      baseCommit: task.repositories[0].baseCommit,
      patchEncoding: 'base64',
      patch: Buffer.from(patch).toString('base64'),
    }],
  })}\nPATCHWORK_RESULT_END`;
}

test('Git Summary tasks package staged and unstaged changes into a visible read-only task', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-git-summary-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const resolvedRepositoryPath = await fs.realpath(repositoryPath);
  await fs.writeFile(path.join(repositoryPath, 'hello.txt'), 'staged change\n');
  await runGit(repositoryPath, ['add', 'hello.txt']);
  await fs.writeFile(path.join(repositoryPath, 'unstaged.txt'), 'unstaged change\n');

  const tasks = new TaskService(path.join(root, 'data'));
  await tasks.initialize();
  const repository = (await tasks.inspectRepositories([repositoryPath]))[0];
  const task = await tasks.createTask({
    taskText: 'Review uncommitted changes.',
    repositories: [repository],
    autoApply: false,
    summaryOnly: true,
  });

  assert.equal(task.summaryOnly, true);
  assert.equal(task.repositories.length, 1);
  assert.equal(task.repositories[0].path, resolvedRepositoryPath);
  assert.equal(task.repositories[0].readOnly, true);
  assert.equal(task.repositories[0].workingChanges, true);
  assert.match(task.resultFilename, /^chatgpt-ide-result-[0-9a-f-]{36}\.txt$/i);
  assert.match(task.handoffPrompt, /PATCHWORK_RESULT_V1/);
  assert.match(task.handoffPrompt, /Return an empty patch for every repository/i);
  assert.equal((await tasks.listTasks()).length, 1);

  const zip = new AdmZip(task.packagePath);
  const manifest = JSON.parse(zip.getEntry('manifest.json').getData().toString('utf8'));
  assert.equal(manifest.repositories[0].workingChanges, true);
  assert.equal(manifest.repositories[0].snapshot, true);
  assert.equal(manifest.repositories[0].readOnly, true);
  const agentInstructions = zip.getEntry('AGENTS.md').getData().toString('utf8');
  assert.match(agentInstructions, /read-only Git summary task/i);
  assert.match(agentInstructions, /PATCHWORK_RESULT_V1/);
  assert.match(agentInstructions, /Every repository patch in the result must be empty/i);
  assert.ok(zip.getEntry(`repositories/${repository.id}.bundle`));

  const result = await ingestDownloadedText(
    new ResultService(tasks),
    tasks,
    task,
    plainTextResult(task, '', 'fix(source-control): generate AI commit summaries'),
  );
  assert.equal(result.state, 'ready');
  assert.equal(result.result.commitMessage, 'fix(source-control): generate AI commit summaries');
});

test('outbound task packages are ZIP archives containing real Git bundles', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-package-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const tasks = new TaskService(path.join(root, 'data'));
  await tasks.initialize();

  const repository = (await tasks.inspectRepositories([repositoryPath]))[0];
  const task = await tasks.createTask({
    taskText: 'Change the greeting.',
    repositories: [repository],
    autoApply: false,
  });

  assert.match(task.packagePath, /\.zip$/);
  assert.equal(task.transport, 'zip-git-bundle');
  assert.equal(task.resultTransport, 'downloaded-text-file');
  const zip = new AdmZip(task.packagePath);
  const entries = new Map(zip.getEntries().map((entry) => [entry.entryName, entry]));
  assert.ok(entries.has('AGENTS.md'));
  assert.ok(entries.has('TASK.md'));
  assert.ok(entries.has('manifest.json'));
  assert.ok(entries.has(`repositories/${repository.id}.bundle`));
  const manifest = JSON.parse(entries.get('manifest.json').getData().toString('utf8'));
  assert.equal(manifest.taskId, task.taskId);
  assert.equal(manifest.repositories[0].baseCommit, repository.baseCommit);
  assert.equal(JSON.stringify(manifest).includes(repositoryPath), false);
  const agentInstructions = entries.get('AGENTS.md').getData().toString('utf8');
  assert.match(agentInstructions, /PATCHWORK_RESULT_V1/);
  assert.match(agentInstructions, new RegExp(`chatgpt-ide-result-${task.taskId}\\.txt`));
  assert.match(agentInstructions, /do not print or paste the result envelope/i);
  const packagedBundle = entries.get(`repositories/${repository.id}.bundle`).getData();
  const sourceBundle = await fs.readFile(path.join(tasks.taskDirectory(task.taskId), 'repositories', `${repository.id}.bundle`));
  assert.deepEqual(packagedBundle, sourceBundle);
  const extractedBundle = path.join(root, 'uploaded-repository.bundle');
  await fs.writeFile(extractedBundle, packagedBundle);
  await runGit(repositoryPath, ['bundle', 'verify', extractedBundle]);
});

test('answer-only tasks package repositories as read-only context without a result-file protocol', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-answer-only-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const tasks = new TaskService(path.join(root, 'data'));
  await tasks.initialize();

  const task = await tasks.createTask({
    taskText: 'Explain why this parser uses two passes.',
    repositories: [{ path: repositoryPath }],
    answerOnly: true,
  });

  assert.equal(task.answerOnly, true);
  assert.equal(task.repositories[0].readOnly, true);
  assert.equal(task.resultFilename, null);
  assert.equal(task.resultTransport, null);
  assert.match(task.handoffPrompt, /answer the request in detail directly in the chat/i);
  assert.doesNotMatch(task.handoffPrompt, /required downloadable text file/i);

  const archive = new AdmZip(task.packagePath);
  const manifest = JSON.parse(archive.getEntry('manifest.json').getData().toString('utf8'));
  const agentInstructions = archive.getEntry('AGENTS.md').getData().toString('utf8');
  assert.equal(manifest.answerOnly, true);
  assert.equal(manifest.repositories[0].readOnly, true);
  assert.match(agentInstructions, /normal chat response is the complete result/i);
  assert.match(agentInstructions, /do not edit files/i);
  assert.doesNotMatch(agentInstructions, /Produce the plain-text result/);
});

test('tasks can package multiple repositories into one ZIP', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-multi-repository-task-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const firstRepositoryPath = await createRepository(root);
  const secondRepositoryPath = path.join(root, 'second-repository');
  await fs.mkdir(secondRepositoryPath, { recursive: true });
  await runGit(secondRepositoryPath, ['init', '-b', 'main']);
  await runGit(secondRepositoryPath, ['config', 'user.email', 'patchwork@example.invalid']);
  await runGit(secondRepositoryPath, ['config', 'user.name', 'Patchwork Test']);
  await fs.writeFile(path.join(secondRepositoryPath, 'other.txt'), 'other repository\n');
  await runGit(secondRepositoryPath, ['add', 'other.txt']);
  await runGit(secondRepositoryPath, ['commit', '-m', 'Initial commit']);
  await fs.writeFile(path.join(secondRepositoryPath, 'other.txt'), 'updated other repository\n');
  await fs.writeFile(path.join(secondRepositoryPath, 'untracked.txt'), 'untracked context\n');

  const tasks = new TaskService(path.join(root, 'data'));
  await tasks.initialize();
  const repositories = await tasks.inspectRepositories([firstRepositoryPath, secondRepositoryPath]);
  assert.equal(repositories.length, 2);

  const task = await tasks.createTask({
    taskText: 'Coordinate the change across both repositories.',
    repositories,
  });

  assert.equal(task.repositories.length, 2);
  const archive = new AdmZip(task.packagePath);
  const manifest = JSON.parse(archive.getEntry('manifest.json').getData().toString('utf8'));
  assert.deepEqual(
    manifest.repositories.map((repository) => repository.bundleFile),
    repositories.map((repository) => `repositories/${repository.id}.bundle`),
  );
  for (const repository of repositories) {
    const entry = archive.getEntry(`repositories/${repository.id}.bundle`);
    assert.ok(entry);
    const stored = await fs.readFile(path.join(tasks.taskDirectory(task.taskId), 'repositories', `${repository.id}.bundle`));
    assert.deepEqual(entry.getData(), stored);
  }

  for (const repository of manifest.repositories) {
    const clonePath = path.join(root, `clone-${repository.id}`);
    await runGit(root, [
      'clone', '--no-checkout',
      path.join(tasks.taskDirectory(task.taskId), repository.bundleFile),
      clonePath,
    ]);
    await runGit(clonePath, ['checkout', '-b', `patchwork/${task.taskId}`, repository.baseCommit]);
    const { stdout: clonedHead } = await runGit(clonePath, ['rev-parse', 'HEAD']);
    assert.equal(clonedHead.trim(), repository.baseCommit);
  }
  assert.equal(await fs.readFile(path.join(root, `clone-${repositories[1].id}`, 'other.txt'), 'utf8'), 'updated other repository\n');
  assert.equal(await fs.readFile(path.join(root, `clone-${repositories[1].id}`, 'untracked.txt'), 'utf8'), 'untracked context\n');
});

test('tasks can include configured IaC repositories as read-only bundle context', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-iac-context-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const iacRepositoryPath = await createRepository(path.join(root, 'iac-root'));
  const settingsPath = path.join(root, 'settings.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ iac_urls: [iacRepositoryPath] }, null, 2)}\n`);

  const tasks = new TaskService(
    path.join(root, 'data'),
    undefined,
    new IacService({ settingsPath }),
  );
  await tasks.initialize();
  const repository = (await tasks.inspectRepositories([repositoryPath]))[0];
  const task = await tasks.createTask({
    taskText: 'Use the infrastructure repository as read-only deployment context.',
    repositories: [repository],
    includeIac: true,
  });

  assert.equal(task.includeIac, true);
  assert.equal(task.includes_iac_repos, true);
  assert.equal(task.iac_repos.length, 1);
  assert.equal(task.repositories.length, 1);
  assert.equal(task.iac_repos[0].readOnly, true);
  assert.equal(task.iac_repos[0].status, 'bundled');
  assert.equal(task.iac_repos[0].source, 'local_path');
  assert.equal(task.iac_repos[0].source_path, iacRepositoryPath);
  assert.match(task.iac_repos[0].bundle, /^iac\/sample-repository(?:-2)?\.bundle$/);

  const archive = new AdmZip(task.packagePath);
  const manifest = JSON.parse(archive.getEntry('manifest.json').getData().toString('utf8'));
  assert.equal(manifest.iac_settings_path, settingsPath);
  assert.equal(manifest.iac_repos[0].bundle, task.iac_repos[0].bundle);
  assert.ok(archive.getEntry(task.iac_repos[0].bundle));

  const clonePath = path.join(root, 'iac-clone');
  await runGit(root, ['clone', '--no-checkout', path.join(tasks.taskDirectory(task.taskId), task.iac_repos[0].bundle), clonePath]);
  await runGit(clonePath, ['checkout', '-b', `patchwork/${task.taskId}`, task.iac_repos[0].baseCommit]);
  const { stdout: clonedHead } = await runGit(clonePath, ['rev-parse', 'HEAD']);
  assert.equal(clonedHead.trim(), task.iac_repos[0].baseCommit);
  assert.equal(await fs.readFile(path.join(clonePath, 'hello.txt'), 'utf8'), 'hello\n');
});

test('IaC bundles preserve local working changes without making the IaC repository patchable', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-iac-dirty-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const iacRepositoryPath = await createRepository(path.join(root, 'iac-root'));
  await fs.writeFile(path.join(iacRepositoryPath, 'hello.txt'), 'iac working change\n');
  await fs.writeFile(path.join(iacRepositoryPath, 'untracked.tf'), 'resource "demo" {}\n');
  const settingsPath = path.join(root, 'settings.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ iac_urls: [iacRepositoryPath] }, null, 2)}\n`);

  const tasks = new TaskService(
    path.join(root, 'data'),
    undefined,
    new IacService({ settingsPath }),
  );
  await tasks.initialize();
  const repository = (await tasks.inspectRepositories([repositoryPath]))[0];
  const task = await tasks.createTask({
    taskText: 'Reference the current infrastructure working tree.',
    repositories: [repository],
    includeIac: true,
  });

  const iac = task.iac_repos[0];
  assert.equal(iac.workingChanges, true);
  assert.equal(iac.snapshot, true);
  assert.match(iac.workingStatus, /hello\.txt|untracked\.tf/);

  const clonePath = path.join(root, 'iac-dirty-clone');
  await runGit(root, ['clone', '--no-checkout', path.join(tasks.taskDirectory(task.taskId), iac.bundle), clonePath]);
  await runGit(clonePath, ['checkout', '-b', `patchwork/${task.taskId}`, iac.baseCommit]);
  assert.equal(await fs.readFile(path.join(clonePath, 'hello.txt'), 'utf8'), 'iac working change\n');
  assert.equal(await fs.readFile(path.join(clonePath, 'untracked.tf'), 'utf8'), 'resource "demo" {}\n');
});

test('IaC configuration stays opt-in and malformed settings are rejected', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-iac-settings-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const settingsPath = path.join(root, 'settings.json');
  const service = new IacService({ settingsPath });

  assert.deepEqual(await service.getConfig(), {
    settingsPath,
    exists: false,
    valid: true,
    selectors: [],
    error: null,
  });

  await fs.writeFile(settingsPath, JSON.stringify({ gitops_urls: ['~/ignored'] }));
  const ignored = await service.getConfig();
  assert.deepEqual(ignored.selectors, []);

  await fs.writeFile(settingsPath, JSON.stringify({ iac_urls: ['path-a'] }));
  const configured = await service.getConfig();
  assert.deepEqual(configured.selectors, ['path-a']);

  await fs.writeFile(settingsPath, JSON.stringify({ iac_urls: 'not-a-list' }));
  await assert.rejects(service.resolveRepositories(path.join(root, 'clones')), /settings\.iac_urls must be a list of strings/);
});

test('task attachments are copied into task storage and included in the submitted ZIP', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-attachments-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const attachmentPath = path.join(root, 'requirements.txt');
  await fs.writeFile(attachmentPath, 'reference context\n');
  const tasks = new TaskService(path.join(root, 'data'));
  await tasks.initialize();

  const repository = (await tasks.inspectRepositories([repositoryPath]))[0];
  const task = await tasks.createTask({
    taskText: 'Use the attached requirements while changing the greeting.',
    repositories: [repository],
    attachments: [{ name: 'requirements.txt', path: attachmentPath }],
  });

  assert.equal(task.attachments.length, 1);
  assert.equal(task.attachments[0].name, 'requirements.txt');
  assert.notEqual(task.attachments[0].path, attachmentPath);
  assert.equal(await fs.readFile(task.attachments[0].path, 'utf8'), 'reference context\n');
  const zip = new AdmZip(task.packagePath);
  const attachmentEntry = zip.getEntry('attachments/requirements.txt');
  assert.ok(attachmentEntry);
  assert.equal(attachmentEntry.getData().toString('utf8'), 'reference context\n');
  const manifest = JSON.parse(zip.getEntry('manifest.json').getData().toString('utf8'));
  assert.deepEqual(manifest.attachments, [{
    name: 'requirements.txt',
    size: Buffer.byteLength('reference context\n'),
    file: 'attachments/requirements.txt',
  }]);
  assert.match(task.handoffPrompt, /requirements\.txt/);
  assert.match(task.handoffPrompt, /task ZIP contains/i);
});

test('task model and reasoning selections are persisted with the task', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-model-selection-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const tasks = new TaskService(path.join(root, 'data'));
  await tasks.initialize();

  const repository = (await tasks.inspectRepositories([repositoryPath]))[0];
  const task = await tasks.createTask({
    taskText: 'Use Luna with deeper reasoning.',
    repositories: [repository],
    model: 'luna',
    reasoningMode: 'extra-high',
  });

  assert.equal(task.model, 'luna');
  assert.equal(task.reasoningMode, 'extra-high');
  const stored = await tasks.getTask(task.taskId);
  assert.equal(stored.model, 'luna');
  assert.equal(stored.reasoningMode, 'extra-high');

  const lowTask = await tasks.createTask({
    taskText: 'Use Luna with low reasoning.',
    repositories: [repository],
    model: 'luna',
    reasoningMode: 'low',
  });
  assert.equal(lowTask.reasoningMode, 'low');
  const storedLowTask = await tasks.getTask(lowTask.taskId);
  assert.equal(storedLowTask.reasoningMode, 'low');
});

test('submitted tasks can change their apply target without rebuilding the task package', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-task-target-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const dataRoot = path.join(root, 'data');
  const trees = new WorktreeService(dataRoot);
  const tasks = new TaskService(dataRoot);
  await Promise.all([trees.initialize(), tasks.initialize()]);

  const firstTree = await trees.create(repositoryPath, 'First target');
  const secondTree = await trees.create(repositoryPath, 'Second target');
  const task = await tasks.createTask({
    taskText: 'Change the greeting.',
    repositories: [{ path: firstTree.path }],
    tree: firstTree,
    autoApply: false,
  });
  await tasks.updateTask(task.taskId, { state: 'submitted' });

  const changed = await tasks.setTarget(task.taskId, {
    repositoryPath: secondTree.path,
    tree: secondTree,
  });
  assert.equal(changed.state, 'submitted');
  assert.equal(changed.treeId, secondTree.id);
  assert.equal(changed.treeName, secondTree.name);
  assert.equal(changed.repositories[0].path, secondTree.path);
  assert.equal(changed.repositories[0].baseCommit, task.repositories[0].baseCommit);
  assert.equal(changed.packagePath, task.packagePath);
  assert.equal(changed.sourceRepositoryPath, await fs.realpath(repositoryPath));

  const restored = await tasks.setTarget(task.taskId, {
    repositoryPath,
    tree: null,
  });
  assert.equal(restored.treeId, null);
  assert.equal(restored.treeName, null);
  assert.equal(restored.repositories[0].path, await fs.realpath(repositoryPath));
});

test('selected local skills are discovered, copied into the task package, and described in the prompt', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-skills-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const homeDirectory = path.join(root, 'home');
  const userSkillPath = path.join(homeDirectory, '.codex', 'skills', 'review-changes');
  const projectSkillPath = path.join(repositoryPath, '.github', 'skills', 'ui-review');
  await fs.mkdir(userSkillPath, { recursive: true });
  await fs.mkdir(projectSkillPath, { recursive: true });
  await fs.writeFile(path.join(userSkillPath, 'SKILL.md'), [
    '---',
    'name: review-changes',
    'description: Review changed code for correctness and maintainability.',
    '---',
    '',
    '# Review changes',
    '',
    'Use this skill when the task asks for a focused code review.',
    '',
  ].join('\n'));
  await fs.writeFile(path.join(projectSkillPath, 'SKILL.md'), [
    '---',
    'name: ui-review',
    'description: Review user interface changes for consistency and accessibility.',
    '---',
    '',
    '# UI review',
    '',
    'Inspect the affected interface and related state before making changes.',
    '',
  ].join('\n'));
  await fs.writeFile(path.join(projectSkillPath, 'checklist.md'), 'Check keyboard focus and labels.\n');

  const skillService = new SkillService({ homeDirectory });
  const tasks = new TaskService(path.join(root, 'data'), skillService);
  await tasks.initialize();
  const repository = (await tasks.inspectRepositories([repositoryPath]))[0];
  const discovered = await skillService.discover([repositoryPath]);

  assert.ok(discovered.some((skill) => skill.name === 'review-changes' && skill.provider === 'Codex' && skill.scope === 'user'));
  assert.ok(discovered.some((skill) => skill.name === 'ui-review' && skill.provider === 'GitHub Copilot' && skill.scope === 'project'));
  const selectedIds = discovered
    .filter((skill) => skill.name === 'review-changes' || skill.name === 'ui-review')
    .map((skill) => skill.id);

  const task = await tasks.createTask({
    taskText: 'Improve the UI and review the resulting changes.',
    repositories: [repository],
    skillIds: selectedIds,
    skillRepositoryPaths: [repositoryPath],
  });

  assert.equal(task.skills.length, 2);
  assert.ok(task.skills.every((skill) => skill.path.startsWith(path.join(path.dirname(task.packagePath), 'skills'))));
  assert.match(task.handoffPrompt, /selected local skills/i);
  assert.match(task.handoffPrompt, /only when it is relevant/i);

  const archive = new AdmZip(task.packagePath);
  const entries = new Map(archive.getEntries().map((entry) => [entry.entryName, entry]));
  const manifest = JSON.parse(entries.get('manifest.json').getData().toString('utf8'));
  assert.equal(manifest.skills.length, 2);
  assert.equal(manifest.skills.every((skill) => !skill.path), true);
  assert.match(entries.get('AGENTS.md').getData().toString('utf8'), /Do not load or invoke unrelated skills/i);

  const uiSkill = task.skills.find((skill) => skill.name === 'ui-review');
  assert.ok(entries.has(`${uiSkill.directory}/SKILL.md`));
  assert.ok(entries.has(`${uiSkill.directory}/checklist.md`));
  assert.equal(entries.get(`${uiSkill.directory}/checklist.md`).getData().toString('utf8'), 'Check keyboard focus and labels.\n');
});

test('dirty repositories keep their full history and capture unstaged files as a task tip', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-working-snapshot-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  await fs.writeFile(path.join(repositoryPath, 'hello.txt'), 'locally changed\n');
  await fs.writeFile(path.join(repositoryPath, 'untracked.txt'), 'local context\n');
  const tasks = new TaskService(path.join(root, 'data'));
  await tasks.initialize();

  const task = await tasks.createTask({
    taskText: 'Continue from the supplied local changes.',
    repositories: [{ path: repositoryPath }],
    autoApply: false,
  });
  const taskRepository = task.repositories[0];
  assert.equal(taskRepository.isSnapshot, true);
  assert.equal(taskRepository.workingChanges, true);
  assert.notEqual(taskRepository.baseCommit, taskRepository.sourceHead);
  assert.equal((await runGit(repositoryPath, ['rev-parse', `${taskRepository.baseCommit}^`])).stdout.trim(), taskRepository.sourceHead);

  const zip = new AdmZip(task.packagePath);
  const bundleEntry = zip.getEntry(`repositories/${taskRepository.id}.bundle`);
  assert.equal(bundleEntry.header.method, 0);
  const manifest = JSON.parse(zip.getEntry('manifest.json').getData().toString('utf8'));
  assert.equal(manifest.repositories[0].workingChanges, true);
  assert.match(manifest.repositories[0].workingStatus, /hello\.txt/);
  assert.match(zip.getEntry('AGENTS.md').getData().toString('utf8'), /view those captured files as unstaged changes/i);

  const bundlePath = path.join(tasks.taskDirectory(task.taskId), 'repositories', `${taskRepository.id}.bundle`);
  const clonePath = path.join(root, 'history-clone');
  await runGit(root, ['clone', bundlePath, clonePath]);
  await runGit(clonePath, ['checkout', '--detach', taskRepository.baseCommit]);
  assert.equal((await runGit(clonePath, ['rev-list', '--count', taskRepository.baseCommit])).stdout.trim(), '2');
  assert.equal(await fs.readFile(path.join(clonePath, 'hello.txt'), 'utf8'), 'locally changed\n');
  assert.equal(await fs.readFile(path.join(clonePath, 'untracked.txt'), 'utf8'), 'local context\n');
  const { stdout: suppliedDiff } = await runGit(clonePath, [
    'diff', taskRepository.sourceHead, taskRepository.baseCommit, '--', '.',
  ]);
  assert.match(suppliedDiff, /locally changed/);
  assert.match(suppliedDiff, /untracked\.txt/);
});

test('results apply and commit after the coding tree HEAD advances', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-advanced-head-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const dataRoot = path.join(root, 'data');
  const trees = new WorktreeService(dataRoot);
  const tasks = new TaskService(dataRoot);
  await Promise.all([trees.initialize(), tasks.initialize()]);
  const tree = await trees.create(repositoryPath, 'Advanced head');
  const task = await tasks.createTask({
    taskText: 'Update the greeting.', repositories: [{ path: tree.path }], tree, autoApply: true,
  });

  const bundlePath = path.join(tasks.taskDirectory(task.taskId), 'repositories', `${task.repositories[0].id}.bundle`);
  const clonePath = path.join(root, 'chatgpt-advanced');
  await runGit(root, ['clone', bundlePath, clonePath]);
  await runGit(clonePath, ['checkout', '--detach', task.repositories[0].baseCommit]);
  await fs.writeFile(path.join(clonePath, 'hello.txt'), 'hello from ChatGPT\n');
  const { stdout: patchBody } = await runGit(clonePath, [
    'diff', '--binary', task.repositories[0].baseCommit, '--', '.',
  ]);

  await fs.writeFile(path.join(tree.path, 'advanced.txt'), 'newer tree commit\n');
  await runGit(tree.path, ['add', 'advanced.txt']);
  await runGit(tree.path, ['commit', '-m', 'chore: advance coding tree']);

  const result = await ingestDownloadedText(new ResultService(tasks), tasks, task, plainTextResult(task, patchBody, 'fix(greeting): apply after advanced head'));
  assert.equal(result.state, 'applied');
  assert.equal(await fs.readFile(path.join(tree.path, 'advanced.txt'), 'utf8'), 'newer tree commit\n');
  assert.equal(await fs.readFile(path.join(tree.path, 'hello.txt'), 'utf8'), 'hello from ChatGPT\n');
  assert.equal((await runGit(tree.path, ['log', '-1', '--pretty=%s'])).stdout.trim(), 'fix(greeting): apply after advanced head');
});

test('conflict resolution reapplies a result blocked by dirty changes before packaging', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-conflict-reapply-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const dataRoot = path.join(root, 'data');
  const tasks = new TaskService(dataRoot);
  await tasks.initialize();

  const repository = (await tasks.inspectRepositories([repositoryPath]))[0];
  const task = await tasks.createTask({
    taskText: 'Change the greeting.',
    repositories: [repository],
    autoApply: true,
  });

  const bundlePath = path.join(tasks.taskDirectory(task.taskId), 'repositories', `${repository.id}.bundle`);
  const clonePath = path.join(root, 'chatgpt-conflict-reapply');
  await runGit(root, ['clone', bundlePath, clonePath]);
  await runGit(clonePath, ['checkout', '--detach', task.repositories[0].baseCommit]);
  await fs.writeFile(path.join(clonePath, 'hello.txt'), 'ChatGPT version\n');
  const { stdout: patchBody } = await runGit(clonePath, [
    'diff', '--binary', task.repositories[0].baseCommit, '--', '.',
  ]);

  await fs.writeFile(path.join(repositoryPath, 'hello.txt'), 'local version\n');
  const conflicted = await ingestDownloadedText(new ResultService(tasks), tasks, task, plainTextResult(task, patchBody));
  assert.equal(conflicted.state, 'conflicted');
  assert.equal(conflicted.result.conflicts[0].applyAttempted, false);
  assert.equal((await runGit(repositoryPath, ['diff', '--cached', '--name-only'])).stdout.trim(), '');

  const results = new ResultService(tasks);
  await results.prepareConflictResolution(task.taskId);
  assert.equal((await runGit(repositoryPath, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim(), 'hello.txt');
  const unmergedIndex = (await runGit(repositoryPath, ['ls-files', '-u', '--', 'hello.txt'])).stdout;
  assert.match(unmergedIndex, /\b1\thello\.txt/);
  assert.match(unmergedIndex, /\b2\thello\.txt/);
  assert.match(unmergedIndex, /\b3\thello\.txt/);
  assert.equal((await runGit(repositoryPath, ['status', '--porcelain'])).stdout.trim(), 'UU hello.txt');
  assert.match(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), /<<<<<<<|>>>>>>>/);

  // Retrying the resolution action must reuse existing conflict entries
  // instead of blocking before the task package can be created.
  const reusedConflict = await results.prepareConflictResolution(task.taskId);
  assert.equal(reusedConflict.isClean, false);
  assert.equal((await runGit(repositoryPath, ['status', '--porcelain'])).stdout.trim(), 'UU hello.txt');

  const resolutionTask = await tasks.createTask({
    taskText: 'Resolve the supplied merge conflict.',
    repositories: [{ path: repositoryPath }],
    autoApply: false,
    resolvesTaskId: task.taskId,
    conflictContext: {
      originalTaskId: task.taskId,
      error: conflicted.result.conflicts[0].error,
      files: conflicted.result.conflicts[0].files,
      patches: conflicted.result.patches,
    },
  });
  const resolutionClone = path.join(root, 'chatgpt-resolution-reapply');
  const resolutionBundle = path.join(
    tasks.taskDirectory(resolutionTask.taskId), 'repositories', `${resolutionTask.repositories[0].id}.bundle`,
  );
  await runGit(root, ['clone', resolutionBundle, resolutionClone]);
  await runGit(resolutionClone, ['checkout', '--detach', resolutionTask.repositories[0].baseCommit]);
  assert.match(await fs.readFile(path.join(resolutionClone, 'hello.txt'), 'utf8'), /<<<<<<<|>>>>>>>/);
});

test('conflicting results remain in the tree and can be resubmitted with unstaged context', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-conflict-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const dataRoot = path.join(root, 'data');
  const trees = new WorktreeService(dataRoot);
  const tasks = new TaskService(dataRoot);
  await Promise.all([trees.initialize(), tasks.initialize()]);
  const tree = await trees.create(repositoryPath, 'Conflict flow');
  const task = await tasks.createTask({
    taskText: 'Change the greeting one way.', repositories: [{ path: tree.path }], tree, autoApply: true,
  });

  const bundlePath = path.join(tasks.taskDirectory(task.taskId), 'repositories', `${task.repositories[0].id}.bundle`);
  const clonePath = path.join(root, 'chatgpt-conflict');
  await runGit(root, ['clone', bundlePath, clonePath]);
  await runGit(clonePath, ['checkout', '--detach', task.repositories[0].baseCommit]);
  await fs.writeFile(path.join(clonePath, 'hello.txt'), 'ChatGPT version\n');
  const { stdout: patchBody } = await runGit(clonePath, [
    'diff', '--binary', task.repositories[0].baseCommit, '--', '.',
  ]);

  await fs.writeFile(path.join(tree.path, 'hello.txt'), 'newer coding tree version\n');
  await runGit(tree.path, ['add', 'hello.txt']);
  await runGit(tree.path, ['commit', '-m', 'chore: change the same greeting']);
  const conflicted = await ingestDownloadedText(new ResultService(tasks), tasks, task, plainTextResult(task, patchBody, 'fix(greeting): change greeting'));
  assert.equal(conflicted.state, 'conflicted');
  assert.match(conflicted.error, /retry the saved result/i);
  assert.deepEqual(conflicted.result.conflicts[0].files, ['hello.txt']);
  assert.match(await fs.readFile(path.join(tree.path, 'hello.txt'), 'utf8'), /<<<<<<<|>>>>>>>/);

  const resolutionTask = await tasks.createTask({
    taskText: 'Resolve the supplied merge conflict.',
    repositories: [{ path: tree.path }],
    tree,
    autoApply: true,
    resolvesTaskId: task.taskId,
    conflictContext: {
      originalTaskId: task.taskId,
      error: conflicted.result.conflicts[0].error,
      files: conflicted.result.conflicts[0].files,
      patches: conflicted.result.patches,
    },
  });
  assert.equal(resolutionTask.repositories[0].workingChanges, true);
  assert.equal(resolutionTask.resolvesTaskId, task.taskId);
  const resolutionZip = new AdmZip(resolutionTask.packagePath);
  assert.ok(resolutionZip.getEntry('CONFLICTS.md'));
  assert.ok(resolutionZip.getEntry(`conflicts/${task.repositories[0].id}.patch`));

  const resolutionBundle = path.join(
    tasks.taskDirectory(resolutionTask.taskId), 'repositories', `${resolutionTask.repositories[0].id}.bundle`,
  );
  const resolutionClone = path.join(root, 'chatgpt-resolution');
  await runGit(root, ['clone', resolutionBundle, resolutionClone]);
  await runGit(resolutionClone, ['checkout', '--detach', resolutionTask.repositories[0].baseCommit]);
  assert.match(await fs.readFile(path.join(resolutionClone, 'hello.txt'), 'utf8'), /<<<<<<<|>>>>>>>/);
  await fs.writeFile(path.join(resolutionClone, 'hello.txt'), 'resolved greeting\n');
  const { stdout: resolutionPatch } = await runGit(resolutionClone, [
    'diff', '--binary', resolutionTask.repositories[0].baseCommit, '--', '.',
  ]);
  const resolved = await ingestDownloadedText(new ResultService(tasks), tasks, resolutionTask, plainTextResult(resolutionTask, resolutionPatch, 'fix(greeting): resolve concurrent changes'));
  assert.equal(resolved.state, 'applied');
  assert.equal(await fs.readFile(path.join(tree.path, 'hello.txt'), 'utf8'), 'resolved greeting\n');
  assert.equal((await runGit(tree.path, ['status', '--porcelain'])).stdout, '');

  const resolvedOriginal = await tasks.getTask(task.taskId);
  assert.equal(resolvedOriginal.state, 'resolved');
  assert.equal(resolvedOriginal.error, null);
  assert.equal(resolvedOriginal.resolutionTaskId, resolutionTask.taskId);
  assert.ok(Number.isFinite(Date.parse(resolvedOriginal.resolvedAt)));
});

test('a conflict-resolution result falls back to the original repository when its worktree is deleted', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-resolution-target-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const dataRoot = path.join(root, 'data');
  const trees = new WorktreeService(dataRoot);
  const tasks = new TaskService(dataRoot);
  await Promise.all([trees.initialize(), tasks.initialize()]);

  const tree = await trees.create(repositoryPath, 'Resolution target');
  const originalTask = await tasks.createTask({
    taskText: 'Change the greeting.',
    repositories: [{ path: tree.path }],
    tree,
    autoApply: false,
  });
  await tasks.updateTask(originalTask.taskId, {
    state: 'conflicted',
    error: 'The result could not be applied cleanly.',
    result: { conflicts: [{ repositoryId: originalTask.repositories[0].id, files: ['hello.txt'] }] },
  });
  const resolutionTask = await tasks.createTask({
    taskText: 'Resolve the greeting conflict.',
    repositories: [{ path: tree.path }],
    tree,
    autoApply: false,
    resolvesTaskId: originalTask.taskId,
  });

  await fs.writeFile(path.join(tree.path, 'hello.txt'), 'resolved by ChatGPT\n');
  const { stdout: patchBody } = await runGit(tree.path, [
    'diff', '--binary', resolutionTask.repositories[0].baseCommit, '--', '.',
  ]);
  await runGit(tree.path, ['restore', 'hello.txt']);
  const resultDir = path.join(tasks.taskDirectory(resolutionTask.taskId), 'result');
  await fs.mkdir(resultDir, { recursive: true });
  const patchPath = path.join(resultDir, `${resolutionTask.repositories[0].id}.patch`);
  await fs.writeFile(patchPath, patchBody);
  await tasks.updateTask(resolutionTask.taskId, {
    state: 'ready',
    result: {
      summary: 'Resolved the greeting conflict.',
      commitMessage: 'fix(greeting): resolve concurrent changes',
      transport: 'downloaded-text-file',
      patches: [{
        id: resolutionTask.repositories[0].id,
        baseCommit: resolutionTask.repositories[0].baseCommit,
        patchEncoding: 'base64',
        localPath: patchPath,
      }],
    },
  });

  await trees.remove(tree.id, true);
  const resolved = await new ResultService(tasks).apply(resolutionTask.taskId);
  assert.equal(resolved.state, 'applied');
  assert.equal(resolved.treeId, null);
  assert.equal(resolved.repositories[0].path, await fs.realpath(repositoryPath));
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'resolved by ChatGPT\n');
  assert.equal((await tasks.getTask(originalTask.taskId)).state, 'resolved');
});

test('a conflicted result can be retried after the target is cleaned up', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-conflict-retry-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const dataRoot = path.join(root, 'data');
  const tasks = new TaskService(dataRoot);
  await tasks.initialize();
  const repository = (await tasks.inspectRepositories([repositoryPath]))[0];
  const task = await tasks.createTask({
    taskText: 'Change the greeting.', repositories: [repository], autoApply: true,
  });

  const bundlePath = path.join(tasks.taskDirectory(task.taskId), 'repositories', `${repository.id}.bundle`);
  const clonePath = path.join(root, 'chatgpt-retry');
  await runGit(root, ['clone', bundlePath, clonePath]);
  await runGit(clonePath, ['checkout', '--detach', repository.baseCommit]);
  await fs.writeFile(path.join(clonePath, 'hello.txt'), 'ChatGPT version\n');
  const { stdout: patchBody } = await runGit(clonePath, [
    'diff', '--binary', repository.baseCommit, '--', '.',
  ]);

  await fs.writeFile(path.join(repositoryPath, 'hello.txt'), 'temporary conflicting change\n');
  const results = new ResultService(tasks);
  let current = await ingestDownloadedText(results, tasks, task, plainTextResult(task, patchBody));
  assert.equal(current.state, 'conflicted');
  assert.match(current.error, /retry the saved result/i);
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'temporary conflicting change\n');

  await runGit(repositoryPath, ['restore', 'hello.txt']);
  current = await results.apply(task.taskId);
  assert.equal(current.state, 'applied');
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'ChatGPT version\n');
});

test('an unborn repository is snapshotted without changing the source and accepts its result', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-unborn-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = path.join(root, 'brand-new-repository');
  await fs.mkdir(repositoryPath, { recursive: true });
  await runGit(repositoryPath, ['init', '-b', 'main']);
  await runGit(repositoryPath, ['config', 'user.email', 'patchwork@example.invalid']);
  await runGit(repositoryPath, ['config', 'user.name', 'Patchwork Test']);
  await fs.writeFile(path.join(repositoryPath, '.gitignore'), 'ignored.txt\n');
  await fs.writeFile(path.join(repositoryPath, 'hello.txt'), 'uncommitted hello\n');
  await fs.writeFile(path.join(repositoryPath, 'ignored.txt'), 'do not package\n');

  const tasks = new TaskService(path.join(root, 'data'));
  await tasks.initialize();
  const inspected = (await tasks.inspectRepositories([repositoryPath]))[0];
  assert.equal(inspected.hasHead, false);
  assert.equal(inspected.isClean, false);
  const { stdout: statusBefore } = await runGit(repositoryPath, ['status', '--porcelain=v1', '--untracked-files=all']);

  const task = await tasks.createTask({
    taskText: 'Update the uncommitted greeting.',
    repositories: [inspected],
    autoApply: false,
  });
  const taskRepository = task.repositories[0];
  assert.equal(taskRepository.isSnapshot, true);
  assert.equal(taskRepository.sourceHead, null);
  assert.match(taskRepository.baseCommit, /^[0-9a-f]{40}$/);
  const { stdout: statusAfter } = await runGit(repositoryPath, ['status', '--porcelain=v1', '--untracked-files=all']);
  assert.equal(statusAfter, statusBefore);
  await assert.rejects(runGit(repositoryPath, ['rev-parse', '--verify', 'HEAD']), /single revision/);

  const clonePath = path.join(root, 'chatgpt-workspace');
  const bundlePath = path.join(tasks.taskDirectory(task.taskId), 'repositories', `${taskRepository.id}.bundle`);
  await runGit(root, ['clone', bundlePath, clonePath]);
  assert.equal(await fs.readFile(path.join(clonePath, 'hello.txt'), 'utf8'), 'uncommitted hello\n');
  await assert.rejects(fs.stat(path.join(clonePath, 'ignored.txt')), { code: 'ENOENT' });
  await fs.writeFile(path.join(clonePath, 'hello.txt'), 'updated by ChatGPT\n');
  const { stdout: patchBody } = await runGit(clonePath, [
    'diff', '--binary', taskRepository.baseCommit, '--', '.',
  ]);

  const resultText = `PATCHWORK_RESULT_V1\n${JSON.stringify({
    schemaVersion: 2,
    transport: 'plain-text-base64',
    taskId: task.taskId,
    status: 'completed',
    summary: 'Updated the uncommitted greeting.',
    repositories: [{
      id: taskRepository.id,
      baseCommit: taskRepository.baseCommit,
      patchEncoding: 'base64',
      patch: Buffer.from(patchBody).toString('base64'),
    }],
  })}\nPATCHWORK_RESULT_END`;

  const results = new ResultService(tasks);
  let current = await ingestDownloadedText(results, tasks, task, resultText);
  assert.equal(current.state, 'ready');
  current = await results.apply(task.taskId);
  assert.equal(current.state, 'applied');
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'updated by ChatGPT\n');
  current = await results.rollback(task.taskId);
  assert.equal(current.state, 'rolled-back');
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'uncommitted hello\n');
});

test('a matching ChatGPT result validates, applies, and rolls back', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-result-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const tasks = new TaskService(path.join(root, 'data'));
  await tasks.initialize();
  const repository = (await tasks.inspectRepositories([repositoryPath]))[0];
  const task = await tasks.createTask({
    taskText: 'Change the greeting.', repositories: [repository], autoApply: false,
  });

  await fs.writeFile(path.join(repositoryPath, 'hello.txt'), 'hello from ChatGPT\n');
  const { stdout: patchBody } = await runGit(repositoryPath, ['diff', '--binary', task.repositories[0].baseCommit, '--', '.']);
  await runGit(repositoryPath, ['restore', 'hello.txt']);

  const resultText = `PATCHWORK_RESULT_V1\n${JSON.stringify({
    schemaVersion: 2,
    transport: 'plain-text-base64',
    taskId: task.taskId,
    status: 'completed',
    summary: 'Updated the greeting.',
    repositories: [{
      id: repository.id,
      baseCommit: repository.baseCommit,
      patchEncoding: 'base64',
      patch: Buffer.from(patchBody).toString('base64'),
    }],
  })}\nPATCHWORK_RESULT_END`;

  const results = new ResultService(tasks);
  let current = await ingestDownloadedText(results, tasks, task, resultText);
  assert.equal(current.state, 'ready');
  assert.match(current.result.patches[0].stat, /hello\.txt/);
  current = await results.apply(task.taskId);
  assert.equal(current.state, 'applied');
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'hello from ChatGPT\n');
  current = await results.rollback(task.taskId);
  assert.equal(current.state, 'rolled-back');
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'hello\n');
});

test('a downloaded text result file validates and applies automatically', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-text-result-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const tasks = new TaskService(path.join(root, 'data'));
  await tasks.initialize();
  const repository = (await tasks.inspectRepositories([repositoryPath]))[0];
  const task = await tasks.createTask({
    taskText: 'Change the greeting.', repositories: [repository], autoApply: true,
  });

  await fs.writeFile(path.join(repositoryPath, 'hello.txt'), 'plain text result\n');
  const { stdout: patchBody } = await runGit(repositoryPath, ['diff', '--binary', task.repositories[0].baseCommit, '--', '.']);
  await runGit(repositoryPath, ['restore', 'hello.txt']);
  const responseText = `Implementation complete.\nPATCHWORK_RESULT_V1\n${JSON.stringify({
    schemaVersion: 2,
    transport: 'plain-text-base64',
    taskId: task.taskId,
    status: 'completed',
    summary: 'Changed the greeting through the downloaded result file.',
    repositories: [{
      id: repository.id,
      baseCommit: repository.baseCommit,
      patchEncoding: 'base64',
      patch: Buffer.from(patchBody).toString('base64'),
    }],
  })}\nPATCHWORK_RESULT_END`;
  assert.equal(parsePlainTextResult(responseText).taskId, task.taskId);

  const results = new ResultService(tasks);
  const downloadedPath = path.join(root, task.resultFilename);
  await fs.writeFile(downloadedPath, responseText);
  const current = await results.ingestTextFile(task.taskId, downloadedPath);
  assert.equal(current.state, 'applied');
  assert.equal(current.result.transport, 'plain-text-base64');
  assert.equal(current.result.downloadedPath, downloadedPath);
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'plain text result\n');
});

test('coding trees commit task results, accept follow-ups, and squash merge', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-tree-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const dataRoot = path.join(root, 'data');
  const trees = new WorktreeService(dataRoot);
  const tasks = new TaskService(dataRoot);
  await Promise.all([trees.initialize(), tasks.initialize()]);

  const tree = await trees.create(repositoryPath, 'Modern source control');
  assert.equal(tree.clean, true);
  assert.match(tree.branch, /^patchwork\/modern-source-control-/);
  const chatgptProject = {
    id: 'g-p-modern-source-control',
    shortUrl: 'g-p-modern-source-control',
    name: 'Modern source control project',
  };
  const task = await tasks.createTask({
    taskText: 'Change the greeting in the coding tree.',
    repositories: [{ path: tree.path }],
    tree,
    autoApply: true,
    chatgptProject,
  });
  await trees.attachTask(tree.id, task.taskId, chatgptProject);
  assert.deepEqual((await trees.get(tree.id)).chatgptProject, chatgptProject);

  await fs.writeFile(path.join(tree.path, 'hello.txt'), 'changed in coding tree\n');
  const { stdout: patchBody } = await runGit(tree.path, ['diff', '--binary', task.repositories[0].baseCommit, '--', '.']);
  await runGit(tree.path, ['restore', 'hello.txt']);
  const responseText = `PATCHWORK_RESULT_V1\n${JSON.stringify({
    schemaVersion: 2,
    transport: 'plain-text-base64',
    taskId: task.taskId,
    status: 'completed',
    summary: 'Changed the coding-tree greeting.',
    commitMessage: 'feat(greeting): update coding tree message',
    repositories: [{
      id: task.repositories[0].id,
      baseCommit: task.repositories[0].baseCommit,
      patchEncoding: 'base64',
      patch: Buffer.from(patchBody).toString('base64'),
    }],
  })}\nPATCHWORK_RESULT_END`;
  const result = await ingestDownloadedText(new ResultService(tasks), tasks, task, responseText);
  assert.equal(result.state, 'applied');
  assert.match(result.result.commits[0].commit, /^[0-9a-f]{40}$/);
  assert.equal((await runGit(tree.path, ['log', '-1', '--pretty=%s'])).stdout.trim(), 'feat(greeting): update coding tree message');
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'hello\n');

  const followUp = await tasks.createTask({
    taskText: 'Follow up on the same tree.', repositories: [{ path: tree.path }], tree, autoApply: true,
  });
  assert.equal(followUp.repositories[0].baseCommit, result.result.commits[0].commit);

  const request = await trees.buildMergeRequest(tree.id);
  assert.equal(request.resultFilename, mergeResultFilename(tree.id));
  assert.deepEqual(request.chatgptProject, chatgptProject);
  assert.match(request.prompt, /feat\(greeting\): update coding tree message/);
  assert.match(request.prompt, /UTF-8 plain-text file/);
  assert.match(request.prompt, new RegExp(mergeResultFilename(tree.id)));
  assert.match(request.prompt, /Do not paste the PATCHWORK_MERGE_V1 envelope into the chat/);
  assert.match(request.prompt, /apply the squash merge automatically/);
  await trees.markMergeSubmitted(tree.id, 'https://chatgpt.com/c/example');
  let mergeState = await trees.markMergeFailed(tree.id, new Error('Conflicting change'));
  assert.equal(mergeState.mergeState, 'failed');
  assert.equal(mergeState.mergeError, 'Conflicting change');
  mergeState = await trees.clearMergeFailure(tree.id);
  assert.equal(mergeState.mergeState, null);
  assert.equal(mergeState.mergeError, null);
  const mergeText = `PATCHWORK_MERGE_V1\n${JSON.stringify({
    schemaVersion: 1,
    treeId: tree.id,
    summary: 'Updated the greeting.',
    commitMessage: 'feat(greeting): modernize greeting behavior',
  })}\nPATCHWORK_MERGE_END`;
  assert.equal(parseMergeResult(mergeText, tree.id).commitMessage, 'feat(greeting): modernize greeting behavior');
  await fs.writeFile(path.join(repositoryPath, 'local-staged.txt'), 'keep staged\n');
  await runGit(repositoryPath, ['add', 'local-staged.txt']);
  await fs.writeFile(path.join(repositoryPath, 'local-untracked.txt'), 'keep untracked\n');
  const merged = await trees.mergeFromText(tree.id, mergeText);
  assert.match(merged.commit, /^[0-9a-f]{40}$/);
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'changed in coding tree\n');
  assert.equal((await runGit(repositoryPath, ['log', '-1', '--pretty=%s'])).stdout.trim(), 'feat(greeting): modernize greeting behavior');
  assert.equal(await fs.readFile(path.join(repositoryPath, 'local-staged.txt'), 'utf8'), 'keep staged\n');
  assert.equal(await fs.readFile(path.join(repositoryPath, 'local-untracked.txt'), 'utf8'), 'keep untracked\n');
  const { stdout: restoredStatus } = await runGit(repositoryPath, ['status', '--porcelain=v1']);
  assert.match(restoredStatus, /^A  local-staged\.txt$/m);
  assert.match(restoredStatus, /^\?\? local-untracked\.txt$/m);
  assert.equal((await trees.list()).length, 0);
});

test('coding tree merge leaves conflicting source changes untouched', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-tree-conflict-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const trees = new WorktreeService(path.join(root, 'data'));
  const tree = await trees.create(repositoryPath, 'Conflicting source changes');
  await fs.writeFile(path.join(tree.path, 'hello.txt'), 'tree version\n');
  await runGit(tree.path, ['add', 'hello.txt']);
  await runGit(tree.path, ['commit', '-m', 'feat: update hello in tree']);
  await fs.writeFile(path.join(repositoryPath, 'hello.txt'), 'local version\n');
  const { stdout: headBefore } = await runGit(repositoryPath, ['rev-parse', 'HEAD']);
  const mergeText = `PATCHWORK_MERGE_V1\n${JSON.stringify({
    schemaVersion: 1,
    treeId: tree.id,
    summary: 'Update hello.',
    commitMessage: 'feat: update hello',
  })}\nPATCHWORK_MERGE_END`;

  await assert.rejects(
    trees.mergeFromText(tree.id, mergeText),
    /conflicts with local changes.*left unchanged/i,
  );
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'local version\n');
  assert.equal((await runGit(repositoryPath, ['rev-parse', 'HEAD'])).stdout, headBefore);
  assert.match((await runGit(repositoryPath, ['status', '--porcelain=v1'])).stdout, /^ M hello\.txt$/m);
  assert.equal((await runGit(repositoryPath, ['stash', 'list'])).stdout, '');
  assert.equal((await trees.list()).length, 1);

  await fs.writeFile(path.join(tree.path, 'hello.txt'), 'combined version\n');
  await runGit(tree.path, ['add', 'hello.txt']);
  await runGit(tree.path, ['commit', '-m', 'fix: reconcile local hello change']);
  await trees.clearMergeFailure(tree.id, await fingerprintRepository(repositoryPath));
  const merged = await trees.mergeFromText(tree.id, mergeText);
  assert.match(merged.commit, /^[0-9a-f]{40}$/);
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'combined version\n');
  assert.equal((await runGit(repositoryPath, ['status', '--porcelain=v1'])).stdout, '');
  assert.equal((await runGit(repositoryPath, ['stash', 'list'])).stdout, '');
});

test('coding tree merge combines tree-only insertions with nearby source edits', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-insertion-merge-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  await fs.writeFile(path.join(repositoryPath, 'workflow.test.js'), [
    "test('limit notice', () => {});",
    '',
    "test('downloaded result validates', () => {});",
    '',
  ].join('\n'));
  await runGit(repositoryPath, ['add', 'workflow.test.js']);
  await runGit(repositoryPath, ['commit', '-m', 'test: add workflow coverage']);

  const trees = new WorktreeService(path.join(root, 'data'));
  const tree = await trees.create(repositoryPath, 'Compatible neighboring edits');
  await fs.writeFile(path.join(tree.path, 'workflow.test.js'), [
    "test('limit notice', () => {});",
    '',
    "test('thinking dialog', () => {});",
    '',
    "test('downloaded result validates', () => {});",
    '',
  ].join('\n'));
  await runGit(tree.path, ['add', 'workflow.test.js']);
  await runGit(tree.path, ['commit', '-m', 'test: cover thinking dialog']);

  await fs.writeFile(path.join(repositoryPath, 'workflow.test.js'), [
    "test('limit notice', () => {});",
    '',
    "test('downloaded result file validates', () => {});",
    '',
  ].join('\n'));
  await runGit(repositoryPath, ['add', 'workflow.test.js']);
  await runGit(repositoryPath, ['commit', '-m', 'fix: clarify downloaded result coverage']);

  const merged = await trees.mergeFromText(tree.id, `PATCHWORK_MERGE_V1\n${JSON.stringify({
    schemaVersion: 1,
    treeId: tree.id,
    summary: 'Combine compatible workflow tests.',
    commitMessage: 'test: combine workflow coverage',
  })}\nPATCHWORK_MERGE_END`);
  assert.match(merged.commit, /^[0-9a-f]{40}$/);
  const combined = await fs.readFile(path.join(repositoryPath, 'workflow.test.js'), 'utf8');
  assert.match(combined, /thinking dialog/);
  assert.match(combined, /downloaded result file validates/);
});

test('a resolved tree can immediately prepare the resumed final merge', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-resumed-merge-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const trees = new WorktreeService(path.join(root, 'data'));
  const tree = await trees.create(repositoryPath, 'Resume final merge');
  await fs.writeFile(path.join(tree.path, 'hello.txt'), 'resolved tree\n');
  await runGit(tree.path, ['add', 'hello.txt']);
  await runGit(tree.path, ['commit', '-m', 'fix: resolve final merge']);
  await trees.markMergeFailed(tree.id, new Error('Initial merge conflict'));
  await trees.clearMergeFailure(tree.id);

  const request = await trees.buildMergeRequest(tree.id);
  assert.equal(request.treeId, tree.id);
  assert.match(request.prompt, /fix: resolve final merge/);
  assert.equal((await trees.list()).length, 1);
});

test('existing Git worktrees are discovered from workspace repositories', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-discovered-tree-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const existingPath = path.join(root, 'existing-worktree');
  await runGit(repositoryPath, ['worktree', 'add', '-b', 'feature/existing-tree', existingPath]);
  await fs.writeFile(path.join(existingPath, 'existing.txt'), 'existing worktree\n');
  await runGit(existingPath, ['add', 'existing.txt']);
  await runGit(existingPath, ['commit', '-m', 'feat: add existing worktree change']);

  const trees = new WorktreeService(
    path.join(root, 'data'),
    () => {},
    async () => [{ path: repositoryPath }],
  );
  await trees.initialize();
  let [tree] = await trees.list();
  assert.equal(tree.path, await fs.realpath(existingPath));
  assert.equal(tree.repositoryPath, await fs.realpath(repositoryPath));
  assert.equal(tree.branch, 'feature/existing-tree');
  assert.equal(tree.sourceBranch, 'main');
  assert.equal(tree.managed, false);
  assert.equal(tree.discovered, true);
  assert.equal(tree.available, true);
  assert.equal(tree.clean, true);
  assert.equal(tree.commitCount, 1);

  tree = await trees.attachTask(tree.id, 'existing-tree-task');
  assert.deepEqual(tree.taskIds, ['existing-tree-task']);

  const reloaded = await new WorktreeService(
    path.join(root, 'data'),
    () => {},
    async () => [{ path: repositoryPath }],
  ).list();
  assert.equal(reloaded.length, 1);
  assert.deepEqual(reloaded[0].taskIds, ['existing-tree-task']);

  const mergeRequest = await trees.buildMergeRequest(tree.id);
  assert.equal(mergeRequest.treeId, tree.id);
  await trees.remove(tree.id, true);
  await assert.rejects(fs.stat(existingPath), { code: 'ENOENT' });
  assert.equal((await trees.list()).length, 0);
});

test('creating a task tree with the same repository and name reuses the existing tree', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-reused-tree-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const trees = new WorktreeService(path.join(root, 'data'));

  const first = await trees.create(repositoryPath, 'Polish');
  const reused = await trees.create(repositoryPath, '  polish  ');

  assert.equal(reused.id, first.id);
  assert.equal(reused.path, first.path);
  assert.equal((await trees.readRecords()).length, 1);
  const { stdout } = await runGit(repositoryPath, ['worktree', 'list', '--porcelain']);
  assert.equal((stdout.match(/^worktree /gm) || []).length, 2);
});

test('Git porcelain worktree records parse paths and branches', () => {
  const parsed = parseWorktreeList([
    'worktree /repo', 'HEAD a'.padEnd(45, 'a'), 'branch refs/heads/main', '',
    'worktree /repo-feature', 'HEAD b'.padEnd(45, 'b'), 'branch refs/heads/feature/test', '',
  ].join('\0'));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].path, '/repo');
  assert.equal(parsed[1].branch, 'refs/heads/feature/test');
});

test('commit messages used for coding trees must be conventional', () => {
  assert.equal(validateCommitMessage('fix(parser): preserve blank lines'), 'fix(parser): preserve blank lines');
  assert.throws(() => validateCommitMessage('Updated the parser'), /Conventional Commit/);
});

test('source control stages, diffs, commits, and records history', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-git-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  await fs.writeFile(path.join(repositoryPath, 'hello.txt'), 'changed greeting\n');
  await fs.writeFile(path.join(repositoryPath, 'new-file.txt'), 'brand new\n');

  const git = new GitService(path.join(root, 'data'));
  await git.initialize();
  await git.addRepositories([repositoryPath]);
  let status = await git.status(repositoryPath);
  assert.equal(status.unstagedCount, 2);
  assert.equal(status.stagedCount, 0);
  let diff = await git.diff(repositoryPath, 'hello.txt', false);
  assert.match(diff.content, /changed greeting/);
  assert.equal(diff.beforeLabel, 'Index');
  assert.equal(diff.afterLabel, 'Working Tree');
  assert.equal(diff.rows.find((row) => row.beforeType === 'removed').beforeText, 'hello');
  assert.equal(diff.rows.find((row) => row.afterType === 'added').afterText, 'changed greeting');
  diff = await git.diff(repositoryPath, 'new-file.txt', false);
  assert.match(diff.content, /Untracked file/);
  assert.equal(diff.rows[0].beforeNumber, null);
  assert.equal(diff.rows[0].afterType, 'added');

  status = await git.stage(repositoryPath, ['hello.txt']);
  assert.equal(status.stagedCount, 1);
  diff = await git.diff(repositoryPath, 'hello.txt', true);
  assert.match(diff.content, /changed greeting/);
  assert.equal(diff.beforeLabel, 'HEAD');
  assert.equal(diff.afterLabel, 'Index');
  status = await git.unstage(repositoryPath, ['hello.txt']);
  assert.equal(status.stagedCount, 0);
  status = await git.stageAll(repositoryPath);
  assert.equal(status.stagedCount, 2);
  status = await git.commit(repositoryPath, 'Update the greeting');
  assert.equal(status.changes.length, 0);
  assert.equal(status.history[0].subject, 'Update the greeting');
  assert.equal((await git.listRepositories())[0].path, await fs.realpath(repositoryPath));

  await runGit(repositoryPath, ['mv', 'hello.txt', 'greeting.txt']);
  diff = await git.diff(repositoryPath, 'greeting.txt', true);
  assert.equal(diff.rows[0].beforeText, 'changed greeting');
  assert.equal(diff.rows[0].afterText, 'changed greeting');
  assert.equal(diff.rows[0].beforeType, 'unchanged');
  assert.equal(diff.rows[0].afterType, 'unchanged');
});

test('source control can unstage and create the first commit', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-git-unborn-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = path.join(root, 'unborn');
  await fs.mkdir(repositoryPath);
  await runGit(repositoryPath, ['init', '-b', 'main']);
  await runGit(repositoryPath, ['config', 'user.email', 'patchwork@example.invalid']);
  await runGit(repositoryPath, ['config', 'user.name', 'Patchwork Test']);
  await fs.writeFile(path.join(repositoryPath, 'first.txt'), 'first\n');

  const git = new GitService(path.join(root, 'data'));
  await git.initialize();
  let status = await git.stageAll(repositoryPath);
  assert.equal(status.stagedCount, 1);
  status = await git.unstageAll(repositoryPath);
  assert.equal(status.stagedCount, 0);
  status = await git.stageAll(repositoryPath);
  status = await git.commit(repositoryPath, 'Initial commit');
  assert.equal(status.repository.hasHead, true);
  assert.equal(status.history[0].subject, 'Initial commit');
});

test('porcelain parser represents files with staged and unstaged changes in both groups', () => {
  const [change] = parsePorcelainStatus('MM src/app.js\0');
  assert.equal(change.staged, true);
  assert.equal(change.unstaged, true);
  assert.equal(change.path, 'src/app.js');
});

test('source control compare rows align replacements for red and green split views', () => {
  const rows = buildCompareRows(
    'first\nbefore\nlast\n',
    'first\nafter\nlast\n',
    '@@ -2 +2 @@\n-before\n+after\n',
  );
  assert.deepEqual(rows.map((row) => [row.beforeText, row.beforeType, row.afterText, row.afterType]), [
    ['first', 'unchanged', 'first', 'unchanged'],
    ['before', 'removed', 'after', 'added'],
    ['last', 'unchanged', 'last', 'unchanged'],
  ]);
});

test('task packages contain instructions and Git bundles in one ZIP', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-package-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const tasks = new TaskService(path.join(root, 'data'));
  await tasks.initialize();

  const repository = (await tasks.inspectRepositories([repositoryPath]))[0];
  const task = await tasks.createTask({
    taskText: 'Change the greeting.',
    repositories: [repository],
    autoApply: false,
  });

  assert.match(task.packagePath, /\.zip$/);
  assert.equal(task.transport, 'zip-git-bundle');
  const archive = new AdmZip(task.packagePath);
  const entries = new Map(archive.getEntries().map((entry) => [entry.entryName, entry]));
  assert.ok(entries.has('AGENTS.md'));
  assert.ok(entries.has('TASK.md'));
  assert.ok(entries.has('manifest.json'));
  assert.ok(entries.has(`repositories/${repository.id}.bundle`));
  const manifest = JSON.parse(entries.get('manifest.json').getData().toString('utf8'));
  assert.equal(manifest.taskId, task.taskId);
  assert.equal(manifest.repositories[0].baseCommit, repository.baseCommit);
  assert.equal(JSON.stringify(manifest).includes(repositoryPath), false);
  const agentInstructions = entries.get('AGENTS.md').getData().toString('utf8');
  assert.match(agentInstructions, /PATCHWORK_RESULT_V1/);
  assert.match(agentInstructions, new RegExp(`chatgpt-ide-result-${task.taskId}\\.txt`));
  assert.match(agentInstructions, /Never print the result envelope or patch contents/i);
  assert.match(agentInstructions, /Do not attempt any of the following/i);
  assert.match(agentInstructions, /running builds, tests, linters, type checks/i);
  assert.match(agentInstructions, /accessing package registries or other external network resources/i);
  assert.match(task.handoffPrompt, /Do not install dependencies or run builds, tests/i);
  assert.match(task.handoffPrompt, /Do not paste PATCHWORK_RESULT_V1/i);
  assert.equal(task.resultFilename, `chatgpt-ide-result-${task.taskId}.txt`);
});

test('task deletion removes history and task files', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-task-delete-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'data');
  const tasks = new TaskService(dataRoot);
  await tasks.initialize();
  await tasks.saveTask({
    taskId: 'stuck-task',
    taskText: 'Stuck task',
    state: 'submitted',
    createdAt: '2026-08-16T12:00:00.000Z',
    repositories: [],
  });
  await fs.writeFile(path.join(tasks.taskDirectory('stuck-task'), 'chatgpt-ide-task-stuck-task.zip'), 'package');

  const deleted = await tasks.deleteTask('stuck-task');
  assert.equal(deleted.taskId, 'stuck-task');
  assert.deepEqual(await tasks.listTasks(), []);
  await assert.rejects(fs.access(tasks.taskDirectory('stuck-task')));
});

test('conflict resolution can recover a coding tree from the original task association', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-conflict-tree-recovery-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const trees = new WorktreeService(path.join(root, 'data'));
  const tree = await trees.create(repositoryPath, 'Recover conflict tree');
  const task = {
    taskId: 'conflicted-task',
    repositories: [{ path: tree.path, readOnly: false }],
  };
  await trees.attachTask(tree.id, task.taskId);

  const recovered = await trees.findForTask(task);
  assert.equal(recovered.id, tree.id);
  assert.equal(recovered.path, tree.path);
});

test('worktree lookup skips unavailable matching records so conflict resolution can fall back', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-missing-tree-lookup-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const trees = new WorktreeService(path.join(root, 'data'));
  const tree = await trees.create(repositoryPath, 'Missing tree lookup');
  await trees.attachTask(tree.id, 'conflicted-task');

  const records = await trees.readRecords();
  records[0].path = path.join(root, 'missing-tree');
  await trees.writeRecords(records);

  const recovered = await trees.findForTask({
    taskId: 'conflicted-task',
    treeId: tree.id,
    repositories: [{ path: records[0].path, readOnly: false }],
  });
  assert.equal(recovered, null);
});

test('conflict resolution preparation falls back to the original repository when its worktree is deleted', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-conflict-target-rebind-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const dataRoot = path.join(root, 'data');
  const trees = new WorktreeService(dataRoot);
  const tasks = new TaskService(dataRoot);
  await Promise.all([trees.initialize(), tasks.initialize()]);

  const tree = await trees.create(repositoryPath, 'Conflict target rebind');
  const task = await tasks.createTask({
    taskText: 'Resolve the greeting conflict.',
    repositories: [{ path: tree.path }],
    tree,
    autoApply: true,
  });
  const bundlePath = path.join(tasks.taskDirectory(task.taskId), 'repositories', `${task.repositories[0].id}.bundle`);
  const clonePath = path.join(root, 'chatgpt-rebind');
  await runGit(root, ['clone', bundlePath, clonePath]);
  await runGit(clonePath, ['checkout', '--detach', task.repositories[0].baseCommit]);
  await fs.writeFile(path.join(clonePath, 'hello.txt'), 'ChatGPT version\n');
  const { stdout: patchBody } = await runGit(clonePath, [
    'diff', '--binary', task.repositories[0].baseCommit, '--', '.',
  ]);
  const resultDir = path.join(tasks.taskDirectory(task.taskId), 'result');
  await fs.mkdir(resultDir, { recursive: true });
  const patchPath = path.join(resultDir, `${task.repositories[0].id}.patch`);
  await fs.writeFile(patchPath, patchBody);

  await fs.writeFile(path.join(repositoryPath, 'hello.txt'), 'local version\n');
  await tasks.updateTask(task.taskId, {
    state: 'conflicted',
    error: 'The result could not be applied cleanly.',
    result: {
      summary: 'The result conflicted with local changes.',
      commitMessage: 'fix(greeting): resolve concurrent changes',
      transport: 'downloaded-text-file',
      conflicts: [{
        repositoryId: task.repositories[0].id,
        repositoryName: task.repositories[0].name,
        files: [],
        error: 'The target changed before the result could be applied.',
        applyAttempted: false,
      }],
      patches: [{
        id: task.repositories[0].id,
        baseCommit: task.repositories[0].baseCommit,
        patchEncoding: 'base64',
        localPath: patchPath,
      }],
    },
  });

  await trees.remove(tree.id, true);
  const results = new ResultService(tasks);
  const prepared = await results.prepareConflictResolution(task.taskId);
  const rebound = await tasks.getTask(task.taskId);

  assert.equal(rebound.treeId, null);
  assert.equal(rebound.repositories[0].path, await fs.realpath(repositoryPath));
  assert.equal(prepared.isClean, false);
  assert.equal((await runGit(repositoryPath, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim(), 'hello.txt');
});

test('task history persists across service instances and lists newest tasks first', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-task-history-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'data');
  const tasks = new TaskService(dataRoot);
  await tasks.initialize();
  await tasks.saveTask({
    taskId: 'older-task',
    taskText: 'Older saved task',
    state: 'applied',
    createdAt: '2026-08-14T12:00:00.000Z',
    repositories: [],
  });
  await tasks.saveTask({
    taskId: 'newer-task',
    taskText: 'Newer saved task',
    state: 'failed',
    createdAt: '2026-08-15T12:00:00.000Z',
    repositories: [],
  });

  const reloadedTasks = await new TaskService(dataRoot).listTasks();
  assert.deepEqual(reloadedTasks.map((task) => task.taskId), ['newer-task', 'older-task']);
  assert.equal(reloadedTasks[0].state, 'failed');
  assert.equal(reloadedTasks[1].taskText, 'Older saved task');
});

test('conflict-resolution tasks bundle the original checkout as read-only context', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-read-only-context-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const writablePath = await createRepository(path.join(root, 'writable'));
  const contextPath = await createRepository(path.join(root, 'context'));
  await fs.writeFile(path.join(contextPath, 'local.txt'), 'local context\n');
  const tasks = new TaskService(path.join(root, 'data'));
  const task = await tasks.createTask({
    taskText: 'Resolve the failed merge.',
    repositories: [{ path: writablePath }, { path: contextPath, readOnly: true }],
    tree: { id: 'tree-with-conflict', name: 'Conflict tree', repositoryPath: contextPath },
    autoApply: true,
  });
  const contextRepository = task.repositories.find((repository) => repository.readOnly);
  assert.ok(contextRepository);
  assert.equal(contextRepository.readOnly, true);
  const archive = new AdmZip(task.packagePath);
  const files = new Map(archive.getEntries().map((entry) => [entry.entryName, entry]));
  const manifest = JSON.parse(files.get('manifest.json').getData().toString('utf8'));
  assert.equal(manifest.repositories.find((repository) => repository.id === contextRepository.id).readOnly, true);
  assert.match(files.get('AGENTS.md').getData().toString('utf8'), /never edit them/i);

  await fs.writeFile(path.join(contextPath, 'after-package.txt'), 'changed after packaging\n');
  const responseText = `PATCHWORK_RESULT_V1\n${JSON.stringify({
    schemaVersion: 2,
    transport: 'plain-text-base64',
    taskId: task.taskId,
    status: 'completed',
    summary: 'No resolution was required.',
    commitMessage: 'fix: reconcile merge context',
    repositories: task.repositories.map((repository) => ({
      id: repository.id,
      baseCommit: repository.baseCommit,
      patchEncoding: 'base64',
      patch: '',
    })),
  })}\nPATCHWORK_RESULT_END`;
  const applied = await ingestDownloadedText(new ResultService(tasks), tasks, task, responseText);
  assert.equal(applied.state, 'applied');
  assert.equal(await fs.readFile(path.join(contextPath, 'after-package.txt'), 'utf8'), 'changed after packaging\n');
});

test('a downloaded plain-text ChatGPT result validates and applies automatically', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-text-result-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const tasks = new TaskService(path.join(root, 'data'));
  await tasks.initialize();
  const repository = (await tasks.inspectRepositories([repositoryPath]))[0];
  const task = await tasks.createTask({
    taskText: 'Change the greeting.', repositories: [repository], autoApply: true,
  });

  await fs.writeFile(path.join(repositoryPath, 'hello.txt'), 'plain text result\n');
  const { stdout: patchBody } = await runGit(repositoryPath, ['diff', '--binary', task.repositories[0].baseCommit, '--', '.']);
  await runGit(repositoryPath, ['restore', 'hello.txt']);
  const responseText = `Implementation complete.\nPATCHWORK_RESULT_V1\n${JSON.stringify({
    schemaVersion: 2,
    transport: 'plain-text-base64',
    taskId: task.taskId,
    status: 'completed',
    summary: 'Changed the greeting through the downloaded result file.',
    repositories: [{
      id: repository.id,
      baseCommit: repository.baseCommit,
      patchEncoding: 'base64',
      patch: Buffer.from(patchBody).toString('base64'),
    }],
  })}\nPATCHWORK_RESULT_END`;
  assert.equal(parsePlainTextResult(responseText).taskId, task.taskId);

  const results = new ResultService(tasks);
  const current = await ingestDownloadedText(results, tasks, task, responseText);
  assert.equal(current.state, 'applied');
  assert.equal(current.result.transport, 'plain-text-base64');
  assert.equal(await fs.readFile(path.join(repositoryPath, 'hello.txt'), 'utf8'), 'plain text result\n');
});
