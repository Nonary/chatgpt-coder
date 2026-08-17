const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const AdmZip = require('adm-zip');
const {
  CHATGPT_URL,
  ChatGPTView,
  buildConversationStatusScript,
  buildTaskConfigurationScript,
  buildLimitNoticeDismissalScript,
  buildPackageAttachmentStatusScript,
  buildMergeResultDetectionScript,
  buildTaskResultDetectionScript,
  conversationStreamStatusUrl,
  conversationIdFromRouteUrl,
  conversationIdFromStreamStatusUrl,
  isChatGPTConversationUrl,
  isDismissibleLimitNotice,
  isRetryableChatStatus,
  chatMessageText,
  normalizeChatConversation,
  normalizeChatConversationId,
  normalizeConversationStreamStatus,
  recoverUnconfirmedSubmissions,
  rewriteConversationRequestBody,
  taskRequestConfiguration,
  mergeTreeId,
  resultTaskId,
} = require('../src/main/chatgpt-view');
const { fingerprintRepository, runGit } = require('../src/main/git');
const { GitService, buildCompareRows, parsePorcelainStatus } = require('../src/main/git-service');
const { ResultService, parsePlainTextResult } = require('../src/main/result-service');
const { SkillService } = require('../src/main/skill-service');
const { DEFAULT_GIT_SUMMARY_PROMPT, resolveGitSummaryPrompt, TaskService } = require('../src/main/task-service');
const {
  WorktreeService,
  mergeResultFilename,
  parseMergeResult,
  parseWorktreeList,
  validateCommitMessage,
} = require('../src/main/worktree-service');

async function createRepository(root) {
  const repositoryPath = path.join(root, 'sample-repository');
  await fs.mkdir(repositoryPath, { recursive: true });
  await runGit(repositoryPath, ['init', '-b', 'main']);
  await runGit(repositoryPath, ['config', 'user.email', 'patchwork@example.invalid']);
  await runGit(repositoryPath, ['config', 'user.name', 'Patchwork Test']);
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

test('native Chat normalizes the active ChatGPT conversation branch safely', () => {
  const conversationId = '6a80f4cf-1650-83ea-8609-adb411b3e4bc';
  const conversation = normalizeChatConversation({
    id: conversationId,
    title: '  Native   chat  ',
    gizmo_id: 'g-p-project_123',
    create_time: '2026-08-16T20:00:00Z',
    update_time: '2026-08-16T20:01:00Z',
    current_node: 'assistant-1',
    mapping: {
      root: { id: 'root', parent: null, message: { id: 'system', author: { role: 'system' }, content: { parts: ['hidden'] } } },
      'user-1': {
        id: 'user-1',
        parent: 'root',
        message: {
          id: 'user-message',
          author: { role: 'user' },
          content: { parts: ['Hello'] },
          create_time: 1,
          status: 'finished_successfully',
          end_turn: true,
        },
      },
      'analysis-1': {
        id: 'analysis-1',
        parent: 'user-1',
        message: {
          id: 'analysis-message',
          author: { role: 'assistant' },
          channel: 'analysis',
          content: { content_type: 'text', parts: ['Internal reasoning'] },
          create_time: 1.5,
        },
      },
      'reasoning-1': {
        id: 'reasoning-1',
        parent: 'analysis-1',
        message: {
          id: 'reasoning-message',
          author: { role: 'assistant' },
          content: { content_type: 'reasoning_recap', parts: ['Checked the visible context'] },
          create_time: 1.75,
        },
      },
      'assistant-1': {
        id: 'assistant-1',
        parent: 'reasoning-1',
        message: {
          id: 'assistant-message',
          author: { role: 'assistant' },
          content: { parts: ['Hi', { text: 'from ChatGPT' }] },
          create_time: 2,
          status: 'finished_successfully',
          end_turn: true,
        },
      },
      orphan: {
        id: 'orphan',
        parent: 'user-1',
        message: {
          id: 'orphan-message',
          author: { role: 'assistant' },
          content: { parts: ['Old branch'] },
          create_time: 3,
        },
      },
    },
  });

  assert.equal(normalizeChatConversationId(conversationId), conversationId);
  assert.equal(normalizeChatConversationId('../bad'), null);
  assert.equal(conversation.title, 'Native chat');
  assert.equal(conversation.status, 'completed');
  assert.equal(conversation.url, `https://chatgpt.com/g/g-p-project_123/c/${conversationId}`);
  assert.deepEqual(conversation.messages.map((message) => [message.role, message.kind, message.text]), [
    ['user', 'message', 'Hello'],
    ['assistant', 'reasoning', 'Checked the visible context'],
    ['assistant', 'message', 'Hi\nfrom ChatGPT'],
  ]);
  assert.equal(chatMessageText({ content: { parts: [{ content: 'Text object' }] } }), 'Text object');
  assert.equal(chatMessageText({ content: { content_type: 'reasoning_recap', parts: ['Visible recap'] } }), 'Visible recap');
  assert.equal(normalizeChatConversation({ ...conversation, mapping: {} }, 'IS_STREAMING').status, 'streaming');
});

test('native Chat is wired through the authenticated ChatGPT browser partition', async () => {
  const mainSource = await fs.readFile(path.join(__dirname, '../src/main/app.js'), 'utf8');
  const chatViewSource = await fs.readFile(path.join(__dirname, '../src/main/chatgpt-view.js'), 'utf8');
  const preload = await fs.readFile(path.join(__dirname, '../src/preload.js'), 'utf8');
  const renderer = await fs.readFile(path.join(__dirname, '../src/renderer/app.tsx'), 'utf8');

  assert.match(mainSource, /ipcMain\.handle\('chat:list'/);
  assert.match(mainSource, /ipcMain\.handle\('chat:get'/);
  assert.match(mainSource, /ipcMain\.handle\('chat:send'/);
  assert.match(mainSource, /ipcMain\.handle\('chat:open-in-session'/);
  assert.match(preload, /listChatConversations:[\s\S]*getChatConversation:[\s\S]*sendChatMessage:[\s\S]*stopChatResponse:[\s\S]*openChatInSession:/);
  assert.match(renderer, /function ChatWorkspace\(/);
  assert.match(renderer, /className="chat-workspace"/);
  assert.match(renderer, /className="chat-list"/);
  assert.match(renderer, /className="chat-composer"/);
  assert.match(renderer, /placeholder="Message ChatGPT"/);
  assert.match(renderer, /sendChatMessage'.*conversationId: previous\?\.id/);
  assert.match(renderer, /attachments: chatAttachments/);
  assert.match(renderer, /reasoningMode,/);
  assert.match(renderer, /<option value="sol">GPT-5\.6 Sol/);
  assert.match(renderer, /<option value="luna">GPT-5\.6 Luna/);
  assert.match(renderer, /className="model-thinking-picker"/);
  assert.match(renderer, /aria-label="Model and thinking settings"/);
  assert.match(renderer, /model-thinking-menu-label">Thinking/);
  assert.match(renderer, /\['default', 'Model default'\], \['instant', 'Instant'\], \['low', 'Low'\], \['medium', 'Medium'\], \['high', 'High'\], \['extra-high', 'Extra High'\]/);
  assert.doesNotMatch(renderer, /<span>Engine<\/span>|<span>Focus<\/span>/);
  assert.match(renderer, /bridge\.onTaskEvent/);
  assert.match(renderer, /window\.setInterval\(poll, 1800\)/);
  assert.match(renderer, /Reasoning summary/);
  assert.match(mainSource, /ipcMain\.handle\('chat:stop'/);
  assert.match(chatViewSource, /async stopChatResponse\(\)/);

  assert.match(mainSource, /ipcMain\.handle\('session:open'/);
  assert.match(mainSource, /ipcMain\.handle\('session:status'/);
  assert.match(preload, /openSession:[\s\S]*getSessionStatus:/);
  assert.match(chatViewSource, /this\.chatView = new BrowserWindow\(transportWindowOptions/);
  assert.match(chatViewSource, /this\.view = new BrowserWindow\(transportWindowOptions/);
  assert.doesNotMatch(chatViewSource, /contentView\.addChildView/);
  assert.match(chatViewSource, /this\.chatSessionWindow = new BrowserWindow/);
  assert.match(chatViewSource, /function transportWindowOptions\(backgroundThrottling = false\)/);
  assert.match(chatViewSource, /partition: PARTITION/);
  assert.match(chatViewSource, /\/backend-api\/conversations/);
  assert.match(chatViewSource, /\/backend-api\/pins/);
  assert.match(chatViewSource, /\/backend-api\/conversation\//);
  assert.match(chatViewSource, /\/stream_status/);
  assert.match(chatViewSource, /getRenderedChatConversation[\s\S]*data-message-author-role/);
  assert.match(chatViewSource, /isRetryableChatStatus\(result\?\.status\)[\s\S]*getRenderedChatConversation\(id\)/);
  assert.match(chatViewSource, /waitForChatComposer[\s\S]*injectChatPrompt[\s\S]*clickChatSend[\s\S]*waitForChatPromptAcceptance/);
  assert.match(chatViewSource, /CHAT_API_RETRY_ATTEMPTS = 4/);
  assert.match(chatViewSource, /beginChatRequestEnforcement[\s\S]*Fetch.enable[\s\S]*requestStage: 'Response'/);
  assert.match(chatViewSource, /status === 429/);
  assert.match(chatViewSource, /retryAfterMilliseconds/);
  assert.match(chatViewSource, /details\?\.webContentsId !== this\.view\.webContents\.id/);
});

test('every renderer element reference is registered and present in the markup', async () => {
  const renderer = await fs.readFile(path.join(__dirname, '../src/renderer/app.tsx'), 'utf8');
  const styles = await fs.readFile(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');

  // React owns element references through JSX rather than an ID registry and
  // innerHTML/template markup. Check that each primary workspace has a real
  // component and matching style surface.
  assert.doesNotMatch(renderer, /const elements = Object\.fromEntries/);
  assert.doesNotMatch(renderer, /innerHTML/);
  assert.match(renderer, /createRoot\(document\.getElementById\('root'\)!\)\.render/);
  for (const component of [
    'Home', 'ChatWorkspace', 'TaskDetail', 'SourceControl', 'Trees', 'History',
    'PromptDialog', 'SkillsDialog', 'ConflictDialog',
  ]) {
    assert.match(renderer, new RegExp(`function ${component}\\(`));
  }
  for (const className of [
    'composer-card', 'chat-workspace', 'task-grid', 'source-grid',
    'tree-grid', 'history-list', 'modal',
  ]) {
    assert.match(renderer, new RegExp(`className[^\\n]*${className}`));
    assert.match(styles, new RegExp(`\\.${className}(?:[,\\s{])`));
  }
});

test('successful Chat replies do not surface background history refresh failures', async () => {
  const renderer = await fs.readFile(path.join(__dirname, '../src/renderer/app.tsx'), 'utf8');
  const sendFlow = renderer.slice(
    renderer.indexOf('const sendChat = async'),
    renderer.indexOf('const openChat = async'),
  );
  assert.match(renderer, /refreshConversationList = useCallback\(async \(showError = true\)/);
  assert.match(renderer, /if \(showError\) notify\(message, true\)/);
  assert.match(renderer, /refreshConversationList\(false\)/);
  assert.doesNotMatch(sendFlow, /refreshConversationList\(/);
  assert.doesNotMatch(sendFlow, /getChatConversation/);
  assert.match(sendFlow, /status: 'streaming'/);
});

test('Chat reloads persistent conversation metadata quietly at startup', async () => {
  const renderer = await fs.readFile(path.join(__dirname, '../src/renderer/app.tsx'), 'utf8');
  assert.match(renderer, /call<Conversation\[]>\('listChatConversations'\)/);
  assert.match(renderer, /call<Chat>\('getChatConversation', id\)/);
  assert.match(renderer, /refreshConversationList\(false\)/);
  assert.match(renderer, /const \[conversations, setConversations\] = useState<Conversation\[]>\(readCachedConversations\)/);
  assert.match(renderer, /persistConversations\(items \|\| \[\]\)/);
});

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
  assert.equal(task.repositories[0].workingChanges, true);
  assert.match(task.resultFilename, /^chatgpt-ide-result-[0-9a-f-]{36}\.txt$/i);
  assert.match(task.handoffPrompt, /PATCHWORK_RESULT_V1/);
  assert.match(task.handoffPrompt, /Return an empty patch for every repository/i);
  assert.equal((await tasks.listTasks()).length, 1);

  const zip = new AdmZip(task.packagePath);
  const manifest = JSON.parse(zip.getEntry('manifest.json').getData().toString('utf8'));
  assert.equal(manifest.repositories[0].workingChanges, true);
  assert.equal(manifest.repositories[0].snapshot, true);
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

test('Source Control summaries run as persistent Luna Medium tasks with an explicit handoff', async () => {
  const appSource = await fs.readFile(path.join(__dirname, '../src/main/app.js'), 'utf8');
  const renderer = await fs.readFile(path.join(__dirname, '../src/renderer/app.tsx'), 'utf8');
  const preload = await fs.readFile(path.join(__dirname, '../src/preload.js'), 'utf8');
  const summaryHandler = appSource.slice(
    appSource.indexOf("ipcMain.handle('git:summary'"),
    appSource.indexOf("ipcMain.handle('trees:list'"),
  );

  assert.match(summaryHandler, /model: 'luna',[\s\S]*reasoningMode: 'medium'/);
  assert.match(summaryHandler, /type: 'task-prepared'/);
  assert.match(summaryHandler, /state: 'completed'/);
  assert.match(summaryHandler, /type: 'git-summary-ready',[\s\S]*task: publicTask\(completed\)/);
  assert.match(summaryHandler, /ipcMain\.handle\('task:use-git-summary'/);
  assert.doesNotMatch(summaryHandler, /deleteTask\(task\.taskId\)/);
  assert.match(renderer, /function SourceControl\(/);
  assert.match(renderer, /AI summary/);
  assert.match(renderer, /call<AnyRecord>\('gitSummary', selected, null\)/);
  assert.match(renderer, /onCommitMessageChange\(result\.commitMessage \|\| ''\)/);
  assert.match(renderer, /name === 'useGitSummary'[\s\S]*setSourceCommitMessage\(text\(result\.result\?\.commitMessage\)\)[\s\S]*setRoute\('source'\)/);
  assert.match(renderer, /<SourceControl repositories=\{repositories\} selectedRepositoryPath=\{sourceRepositoryPath\} commitMessage=\{sourceCommitMessage\}/);
  assert.doesNotMatch(renderer, /Generating Git Summary/);
  assert.match(renderer, /Commit staged changes/);
  assert.match(preload, /useGitSummary: \(taskId\) => ipcRenderer\.invoke\('task:use-git-summary', taskId\)/);
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

test('result downloads accept only task text filenames including duplicate suffixes', () => {
  const taskId = '9f1fae65-e106-4c76-acbe-8ea3928810e7';
  assert.equal(resultTaskId(`chatgpt-ide-result-${taskId}.txt`), taskId);
  assert.equal(resultTaskId(`chatgpt-ide-result-${taskId} (2).txt`), taskId);
  assert.equal(resultTaskId(`chatgpt-ide-result-${taskId}.zip`), null);
  assert.equal(resultTaskId('unrelated.txt'), null);
});

test('result downloads match ChatGPT filenames including duplicate suffixes', () => {
  const taskId = '9f1fae65-e106-4c76-acbe-8ea3928810e7';
  assert.equal(resultTaskId(`chatgpt-ide-result-${taskId}.txt`), taskId);
  assert.equal(resultTaskId(`chatgpt-ide-result-${taskId} (2).txt`), taskId);
  assert.equal(resultTaskId(`chatgpt-ide-result-${taskId}.zip`), null);
  assert.equal(resultTaskId('unrelated.txt'), null);
});

test('opening a task loads its saved ChatGPT conversation', async () => {
  const loaded = [];
  const events = [];
  const task = {
    taskId: '9f1fae65-e106-4c76-acbe-8ea3928810e7',
    state: 'submitted',
    conversationUrl: 'https://chatgpt.com/c/6a80f4cf-1650-83ea-8609-adb411b3e4bc',
  };
  const view = Object.create(ChatGPTView.prototype);
  view.view = { webContents: { getURL: () => CHATGPT_URL, loadURL: async (url) => loaded.push(url) } };
  view.activeTask = null;
  view.activeMerge = { id: 'merge-in-progress' };
  view.knownTasks = new Map();
  view.taskService = { updateTask: async () => task };
  view.onEvent = async (event) => events.push(event);
  view.installResultWatcher = () => {};

  const result = await view.openTaskConversation(task);
  assert.equal(result.opened, true);
  assert.deepEqual(loaded, [task.conversationUrl]);
  assert.equal(view.activeTask, task);
  assert.equal(view.activeMerge, null);
  assert.equal(events[0].type, 'task-chat-opened');
  await assert.rejects(
    view.openTaskConversation({ ...task, conversationUrl: 'https://example.com/not-chatgpt' }),
    /invalid saved ChatGPT conversation URL/,
  );
});

test('opening an already-live task preserves the streaming conversation page', async () => {
  const conversationId = '6a80f4cf-1650-83ea-8609-adb411b3e4bc';
  const loaded = [];
  const task = {
    taskId: '9f1fae65-e106-4c76-acbe-8ea3928810e7',
    state: 'submitted',
    conversationId,
    conversationUrl: `https://chatgpt.com/c/${conversationId}`,
  };
  const view = Object.create(ChatGPTView.prototype);
  view.view = {
    webContents: {
      getURL: () => `https://chatgpt.com/g/g-p-example/c/${conversationId}?model=gpt-5-6`,
      loadURL: async (url) => loaded.push(url),
    },
  };
  view.activeTask = task;
  view.activeMerge = null;
  view.knownTasks = new Map([[task.taskId, task]]);
  view.onEvent = async () => {};
  view.installResultWatcher = () => {};

  const result = await view.openTaskConversation(task);
  assert.equal(result.opened, true);
  assert.deepEqual(loaded, []);
});

test('ChatGPT thinking dialogs are not treated as request-limit notices', () => {
  let clicked = false;
  const closeButton = {
    textContent: '',
    disabled: false,
    getAttribute: (name) => (name === 'aria-label' ? 'Close' : null),
    click: () => { clicked = true; },
  };
  const thinkingModal = {
    textContent: 'Thinking details Usage limit reached for deep research Close',
    querySelectorAll: () => [closeButton],
  };
  const document = {
    querySelector: () => null,
    querySelectorAll: (selector) => (selector.includes('[role="dialog"]') ? [thinkingModal] : []),
  };

  const result = vm.runInNewContext(buildLimitNoticeDismissalScript(), { document });
  assert.equal(result.dismissed, false);
  assert.equal(clicked, false);
});

test('ChatGPT request-limit dialogs are recognized and dismissed without broad clicking', () => {
  assert.equal(isDismissibleLimitNotice('Too many requests'), true);
  assert.equal(isDismissibleLimitNotice('Messages limit reached'), true);
  assert.equal(isDismissibleLimitNotice('You’ve reached your daily usage limit.'), true);
  assert.equal(isDismissibleLimitNotice('This patch exceeds its configured size limit.'), false);

  let clicked = false;
  const button = {
    textContent: 'Got it',
    disabled: false,
    getAttribute: () => null,
    click: () => { clicked = true; },
  };
  const modal = {
    textContent: 'Too many requests Please wait a few minutes before trying again. Got it',
    querySelectorAll: () => [button],
  };
  const document = {
    querySelector: (selector) => (
      selector === '[data-testid="modal-conversation-history-rate-limit"]' ? modal : null
    ),
    querySelectorAll: () => [],
  };
  const result = vm.runInNewContext(buildLimitNoticeDismissalScript(), { document });
  assert.equal(result.dismissed, true);
  assert.equal(result.action, 'Got it');
  assert.equal(clicked, true);
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
// Coding-tree regression coverage retained across the UX merge.

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

test('resolved task status is presented separately from applied work', async () => {
  const renderer = await fs.readFile(path.join(__dirname, '../src/renderer/app.tsx'), 'utf8');
  assert.match(renderer, /const statusLabel = \(task: AnyRecord\)/);
  assert.match(renderer, /applied: 'Applied'/);
  assert.match(renderer, /completed: 'Completed'/);
  assert.match(renderer, /status-badge \$\{task\.state\}/);
  // Unknown persisted states, including `resolved`, remain distinct from
  // `applied`/`completed` through the fallback label and state class.
  assert.match(renderer, /text\(task\.state, 'Prepared'\)/);
  assert.doesNotMatch(renderer, /resolved:\s*'Applied'/);
});

test('conflicted results expose a separate retry action and ChatGPT resolution action', async () => {
  const service = await fs.readFile(path.join(__dirname, '../src/main/result-service.js'), 'utf8');
  const renderer = await fs.readFile(path.join(__dirname, '../src/renderer/app.tsx'), 'utf8');
  assert.match(service, /\['ready', 'failed', 'conflicted'\]\.includes\(task\.state\)/);
  assert.match(renderer, /task\.state === 'ready' && !task\.summaryOnly/);
  assert.match(renderer, /task\.state === 'conflicted'.*onAction\('retryApplyTask'\)/);
  assert.match(renderer, /<Button onClick=\{onConflict\}>Resolve with ChatGPT<\/Button>/);
});

test('conflict retry refreshes the ChatGPT result before applying and before creating a resolution task', async () => {
  const appSource = await fs.readFile(path.join(__dirname, '../src/main/app.js'), 'utf8');
  const viewSource = await fs.readFile(path.join(__dirname, '../src/main/chatgpt-view.js'), 'utf8');
  const preload = await fs.readFile(path.join(__dirname, '../src/preload.js'), 'utf8');
  assert.match(appSource, /ipcMain\.handle\('task:retry-apply'/);
  assert.match(appSource, /retryTaskApplication\(task\)[\s\S]*refreshTaskResult\(current\)[\s\S]*resultService\.apply/);
  assert.match(appSource, /task = await retryTaskApplication\(task\)[\s\S]*await resultService\.prepareConflictResolution/);
  assert.match(viewSource, /async refreshTaskResult\(task\)/);
  assert.match(viewSource, /resultWaiters/);
  assert.match(viewSource, /checkForResult\(\{ force: true \}\)/);
  assert.match(preload, /retryApplyTask: \(taskId\) => ipcRenderer\.invoke\('task:retry-apply', taskId\)/);
});

test('conflict resolution is an accessible native modal independent of ChatGPT transport', async () => {
  const renderer = await fs.readFile(path.join(__dirname, '../src/renderer/app.tsx'), 'utf8');
  assert.match(renderer, /function ConflictDialog\(/);
  assert.match(renderer, /role="dialog" aria-modal="true"/);
  assert.match(renderer, /event\.key === 'Escape'/);
  assert.match(renderer, /resolveTaskConflict'.*additionalInstructions/);
  assert.doesNotMatch(renderer, /setBrowserBounds|setBrowserVisible|WebContentsView/);
});

test('separate ChatGPT session window can be closed without disrupting hidden transports', async () => {
  const renderer = await fs.readFile(path.join(__dirname, '../src/renderer/app.tsx'), 'utf8');
  const mainSource = await fs.readFile(path.join(__dirname, '../src/main/chatgpt-view.js'), 'utf8');
  const preload = await fs.readFile(path.join(__dirname, '../src/preload.js'), 'utf8');
  assert.match(renderer, /onAction\('openChatInSession'\)/);
  assert.doesNotMatch(renderer, /embeddedBrowser|setBrowserBounds|setBrowserVisible|WebContentsView/);
  assert.match(mainSource, /this\.view = new BrowserWindow\(transportWindowOptions/);
  assert.match(mainSource, /this\.chatView = new BrowserWindow\(transportWindowOptions/);
  assert.match(mainSource, /async closeChatInSession\(\)/);
  assert.match(mainSource, /this\.chatSessionWindow\.close\(\)/);
  assert.match(preload, /openSession:/);
  assert.match(preload, /closeSession:/);
  assert.match(preload, /getSessionStatus:/);
});

test('conflict resolution preserves the original configuration by default and submits a reasoning override', async () => {
  const renderer = await fs.readFile(path.join(__dirname, '../src/renderer/app.tsx'), 'utf8');
  const appSource = await fs.readFile(path.join(__dirname, '../src/main/app.js'), 'utf8');
  assert.match(renderer, /function ConflictDialog\(/);
  assert.match(renderer, /Additional instructions/);
  assert.match(renderer, /call\('resolveTaskConflict', activeTask\.taskId/);
  assert.match(renderer, /model: activeTask\.model \|\| 'default'/);
  assert.match(renderer, /reasoningMode: activeTask\.reasoningMode \|\| 'default'/);
  assert.doesNotMatch(renderer, /conflict-resolution-reasoning-select/);
  assert.match(appSource, /Object\.prototype\.hasOwnProperty\.call\(resolutionOptions, 'reasoningMode'\)/);
  assert.match(appSource, /resolve-conflict[\s\S]*reasoningMode: Object\.prototype\.hasOwnProperty\.call\(resolutionOptions, 'reasoningMode'\)/);
});

test('conflict resolution reapplies the original patch before creating the resolution task', async () => {
  const service = await fs.readFile(path.join(__dirname, '../src/main/result-service.js'), 'utf8');
  const appSource = await fs.readFile(path.join(__dirname, '../src/main/app.js'), 'utf8');
  assert.match(service, /async prepareConflictResolution\(taskId\)/);
  assert.match(service, /applyPatch\(repository\.path, patch\.localPath, \{ threeWay: true, index: true \}\)/);
  assert.match(service, /applyAttempted: Boolean\(applyAttempted\)/);
  assert.match(appSource, /await resultService\.prepareConflictResolution\(task\.taskId\)/);
  assert.match(appSource, /prepareConflictResolution\(task\.taskId\)[\s\S]*task = await taskService\.getTask\(task\.taskId\)/);
  assert.match(appSource, /gitService\.status\(conflictRepository\?\.path\)[\s\S]*change\.indexStatus === 'U' \|\| change\.worktreeStatus === 'U'/);
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

test('task target and conflict fallback wiring is exposed through the task UI', async () => {
  const appSource = await fs.readFile(path.join(__dirname, '../src/main/app.js'), 'utf8');
  const renderer = await fs.readFile(path.join(__dirname, '../src/renderer/app.tsx'), 'utf8');
  const preload = await fs.readFile(path.join(__dirname, '../src/preload.js'), 'utf8');
  assert.match(appSource, /ipcMain\.handle\('task:set-target'/);
  assert.match(appSource, /tree = await worktreeService\.inspect\(candidate\)/);
  assert.match(appSource, /task\.sourceRepositoryPath/);
  assert.match(renderer, /function Home\(/);
  assert.match(renderer, /<label>Target<select/);
  assert.match(renderer, /setCreateTree\(e\.target\.value === '__new__'\)/);
  assert.match(renderer, /treeId: treeId \|\| null/);
  assert.match(renderer, /createTree/);
  assert.match(renderer, /treeName/);
  assert.match(preload, /setTaskTarget: \(taskId, input\)/);
});

test('coding trees expose a direct create flow through the main workspace', async () => {
  const appSource = await fs.readFile(path.join(__dirname, '../src/main/app.js'), 'utf8');
  const renderer = await fs.readFile(path.join(__dirname, '../src/renderer/app.tsx'), 'utf8');
  const preload = await fs.readFile(path.join(__dirname, '../src/preload.js'), 'utf8');
  assert.match(appSource, /ipcMain\.handle\('trees:create'/);
  assert.match(appSource, /gitService\.listRepositories\(\)/);
  assert.match(appSource, /worktreeService\.create\(repository\.path, input\.treeName\)/);
  assert.match(preload, /createTree: \(input\) => ipcRenderer\.invoke\('trees:create', input\)/);
  assert.match(renderer, /function TreeCreateDialog\(/);
  assert.match(renderer, /New coding tree/);
  assert.match(renderer, /call<Tree>\('createTree'/);
  assert.match(renderer, /event\.type === 'tree-created' \|\| event\.type === 'tree-removed' \|\| event\.type === 'tree-merged'/);
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

test('conflict resolution backend does not require a coding tree', async () => {
  const appSource = await fs.readFile(path.join(__dirname, '../src/main/app.js'), 'utf8');
  assert.doesNotMatch(appSource, /conflicted task is not associated with a coding tree/);
  assert.match(appSource, /await worktreeService\.findForTask\(task\)/);
  assert.match(appSource, /if \(tree\) await worktreeService\.attachTask/);
  assert.match(appSource, /This conflicted task has no writable repository to resolve/);
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

test('ChatGPT task submission only accepts real conversation URLs', () => {
  assert.equal(isChatGPTConversationUrl('https://chatgpt.com/c/abc123'), true);
  assert.equal(isChatGPTConversationUrl('https://chatgpt.com/c/abc123/'), true);
  assert.equal(isChatGPTConversationUrl('https://chatgpt.com/'), false);
  assert.equal(isChatGPTConversationUrl('https://chatgpt.com/c/'), false);
  assert.equal(isChatGPTConversationUrl('https://example.com/c/abc123'), false);
});

test('task composer exposes extra-high reasoning and keeps the settings grid shrinkable', async () => {
  const renderer = await fs.readFile(path.join(__dirname, '../src/renderer/app.tsx'), 'utf8');
  const styles = await fs.readFile(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');
  const taskSettings = renderer.slice(renderer.indexOf('Task settings'), renderer.indexOf('Task settings') + 1600);
  assert.match(taskSettings, /<option value="extra-high">Extra High<\/option>/);
  assert.match(styles, /\.field-grid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.field-grid > label \{ min-width: 0; \}/);
});

test('task composer persists all sticky task selections in local storage', async () => {
  const renderer = await fs.readFile(path.join(__dirname, '../src/renderer/app.tsx'), 'utf8');
  assert.match(renderer, /patchwork\.task-model/);
  assert.match(renderer, /patchwork\.task-reasoning/);
  assert.match(renderer, /patchwork\.task-tree/);
  assert.match(renderer, /patchwork\.task-project/);
  assert.match(renderer, /localStorage\.getItem\('patchwork\.task-model'\)/);
  assert.match(renderer, /localStorage\.setItem\('patchwork\.task-reasoning', reasoning\)/);
  assert.match(renderer, /localStorage\.setItem\('patchwork\.task-project', projectId\)/);
  assert.match(renderer, /localStorage\.setItem\('patchwork\.task-tree', treeId\)/);
});

test('app restarts use one stable settings directory and reject duplicate instances', async () => {
  const appSource = await fs.readFile(path.join(__dirname, '../src/main/app.js'), 'utf8');
  assert.match(appSource, /path\.join\(app\.getPath\('appData'\), 'chatgpt-coding-ide'\)/);
  assert.match(appSource, /app\.setPath\('userData', stableUserDataPath\)/);
  assert.match(appSource, /app\.requestSingleInstanceLock\(\)/);
  assert.match(appSource, /app\.on\('second-instance'/);
  assert.match(appSource, /if \(!hasSingleInstanceLock\) \{\s*app\.quit\(\)/);
});

test('task configuration installs an owned Luna picker outside React and suppresses native controls', () => {
  const script = buildTaskConfigurationScript('luna', 'extra-high', 'task-123');
  assert.match(script, /GPT-5\.6 Luna/);
  assert.match(script, /gpt-5-6-t-mini/);
  assert.match(script, /thinkingEffort: "max"/);
  assert.match(script, /patchwork-model-selector/);
  assert.match(script, /patchwork-task-model-selector/);
  assert.match(script, /patchwork-task-model-selector-slot/);
  assert.match(script, /document\.body\.append\(picker\)/);
  assert.match(script, /nativePicker\.remove\(\)/);
  assert.match(script, /patchwork-native-model-selector-suppression/);
  assert.match(script, /user_last_used_model_config\?model_slug=/);
  assert.match(script, /method: 'PATCH'/);
  assert.match(script, /model-switcher-dropdown/);
  assert.match(script, /Model selector/);
  assert.match(script, /--vt-thread-model-switcher/);
  assert.match(script, /anchor\.closest\('button, \[role="button"\], \[aria-haspopup="menu"\]'\)/);
  assert.doesNotMatch(script, /button\[style\*="--vt-thread-model-switcher"\]/);
  assert.match(script, /MutationObserver/);
  assert.match(script, /attributeFilter: \['aria-label', 'data-testid', 'role', 'style'\]/);
  assert.match(script, /candidate\.querySelectorAll\(':scope > span'\)/);
  assert.match(script, /nativePicker\.replaceWith\(slot\)/);
  assert.match(script, /flex:0 0/);
  assert.match(script, /compactModelLabel/);
  assert.match(script, /characterData: true/);
  assert.doesNotMatch(script, /bounds\.top < 96/);
  assert.match(script, /attachShadow/);
  assert.match(script, /aria-expanded/);
  assert.match(script, /data-reasoning-mode/);
  assert.match(script, /model-picker-anchor-not-found/);
  assert.match(script, /__patchworkOwnedModelSelection/);
  assert.match(script, /task-123/);
  assert.match(script, /Extra High/);
  assert.doesNotMatch(script, /GPT-5\.6 Terra/);
});

test('task configuration supports Luna Low reasoning from the HAR', () => {
  const script = buildTaskConfigurationScript('luna', 'low', 'task-123');
  assert.match(script, /GPT-5\.6 Luna/);
  assert.match(script, /Low/);
  assert.match(script, /thinkingEffort: \"min\"/);
  assert.match(script, /reasoning:low/);
});

test('ChatGPT request configuration uses HAR-confirmed Sol and Luna slugs', () => {
  assert.deepEqual(taskRequestConfiguration('default', 'default'), {
    model: 'default',
    reasoningMode: 'default',
    modelSlug: 'gpt-5-6',
    thinkingEffort: null,
  });
  assert.equal(taskRequestConfiguration('sol', 'instant').modelSlug, 'gpt-5-6-instant');
  assert.deepEqual(taskRequestConfiguration('luna', 'low'), {
    model: 'luna',
    reasoningMode: 'low',
    modelSlug: 'gpt-5-6-t-mini',
    thinkingEffort: 'min',
  });
  assert.deepEqual(taskRequestConfiguration('sol', 'high'), {
    model: 'sol',
    reasoningMode: 'high',
    modelSlug: 'gpt-5-6-thinking',
    thinkingEffort: 'extended',
  });
  assert.deepEqual(taskRequestConfiguration('luna', 'extra-high'), {
    model: 'luna',
    reasoningMode: 'extra-high',
    modelSlug: 'gpt-5-6-t-mini',
    thinkingEffort: 'max',
  });
  assert.throws(() => taskRequestConfiguration('terra', 'medium'), /unsupported chatgpt model/i);
});

test('conversation payload rewriting enforces the selected model and thinking effort', () => {
  const rewritten = rewriteConversationRequestBody(JSON.stringify({
    action: 'next',
    model: 'gpt-5-6',
    messages: [],
  }), taskRequestConfiguration('luna', 'high'));
  const payload = JSON.parse(rewritten.text);
  assert.equal(payload.model, 'gpt-5-6-t-mini');
  assert.equal(payload.thinking_effort, 'extended');
  assert.equal(rewritten.model, 'gpt-5-6-t-mini');
  assert.equal(rewritten.thinkingEffort, 'extended');

  const low = rewriteConversationRequestBody(JSON.stringify({
    action: 'next',
    model: 'gpt-5-6',
    messages: [],
  }), taskRequestConfiguration('luna', 'low'));
  const lowPayload = JSON.parse(low.text);
  assert.equal(lowPayload.model, 'gpt-5-6-t-mini');
  assert.equal(lowPayload.thinking_effort, 'min');
});

test('task request enforcement observes and rewrites ChatGPT’s actual conversation request', async () => {
  const commands = [];
  let attached = false;
  const debuggerApi = new EventEmitter();
  debuggerApi.isAttached = () => attached;
  debuggerApi.attach = () => { attached = true; };
  debuggerApi.detach = () => { attached = false; };
  debuggerApi.sendCommand = async (command, params) => {
    commands.push({ command, params });
    return {};
  };
  const view = {
    view: {
      webContents: {
        debugger: debuggerApi,
        executeJavaScript: async () => ({ model: 'luna', reasoningMode: 'high' }),
      },
    },
  };
  const enforcement = await ChatGPTView.prototype.beginTaskRequestEnforcement.call(view, {
    model: 'sol',
    reasoningMode: 'instant',
  });
  debuggerApi.emit('message', {}, 'Fetch.requestPaused', {
    requestId: 'request-1',
    request: {
      method: 'POST',
      url: 'https://chatgpt.com/backend-api/f/conversation',
      postData: JSON.stringify({ action: 'next', model: 'gpt-5-6' }),
    },
  });
  const verified = await enforcement.wait(500);
  await enforcement.dispose();
  const continued = commands.find((item) => item.command === 'Fetch.continueRequest');
  const payload = JSON.parse(Buffer.from(continued.params.postData, 'base64').toString('utf8'));
  assert.deepEqual(verified, {
    ok: true,
    model: 'gpt-5-6-t-mini',
    thinkingEffort: 'extended',
    selectedModel: 'luna',
    selectedReasoningMode: 'high',
    selectionSource: 'patchwork-selector',
  });
  assert.equal(payload.model, 'gpt-5-6-t-mini');
  assert.equal(payload.thinking_effort, 'extended');
  assert.equal(commands[0].command, 'Fetch.enable');
  assert.equal(commands.at(-1).command, 'Fetch.disable');
  assert.equal(attached, false);
});

test('native Chat retries transient conversation API responses before surfacing an error', async () => {
  let calls = 0;
  const view = {
    chatView: {
      webContents: {
        executeJavaScript: async () => {
          calls += 1;
          return calls === 1
            ? { ok: false, status: 429, retryAfterMilliseconds: 0 }
            : { ok: true, items: [] };
        },
      },
    },
  };
  const result = await ChatGPTView.prototype.executeChatApiWithRetry.call(view, 'ignored');
  assert.deepEqual(result, { ok: true, items: [] });
  assert.equal(calls, 2);
  assert.equal(isRetryableChatStatus(429), true);
  assert.equal(isRetryableChatStatus(503), true);
  assert.equal(isRetryableChatStatus(400), false);
});

test('native Chat request enforcement rewrites the selected model and observes rate-limit responses', async () => {
  const commands = [];
  let attached = false;
  const debuggerApi = new EventEmitter();
  debuggerApi.isAttached = () => attached;
  debuggerApi.attach = () => { attached = true; };
  debuggerApi.detach = () => { attached = false; };
  debuggerApi.sendCommand = async (command, params) => {
    commands.push({ command, params });
    return {};
  };
  const view = {
    chatView: {
      webContents: {
        debugger: debuggerApi,
      },
    },
  };
  const enforcement = await ChatGPTView.prototype.beginChatRequestEnforcement.call(view, 'luna');
  debuggerApi.emit('message', {}, 'Fetch.requestPaused', {
    requestId: 'chat-request-1',
    request: {
      method: 'POST',
      url: 'https://chatgpt.com/backend-api/f/conversation',
      postData: JSON.stringify({ action: 'next', model: 'gpt-5-6' }),
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  debuggerApi.emit('message', {}, 'Fetch.requestPaused', {
    requestId: 'chat-request-1',
    responseStatusCode: 429,
    responseHeaders: [{ name: 'Retry-After', value: '0' }],
    request: {
      method: 'POST',
      url: 'https://chatgpt.com/backend-api/f/conversation',
    },
  });
  const result = await enforcement.wait(500);
  await enforcement.dispose();
  const continued = commands.find((item) => item.command === 'Fetch.continueRequest');
  const payload = JSON.parse(Buffer.from(continued.params.postData, 'base64').toString('utf8'));
  assert.equal(result.rateLimited, true);
  assert.equal(result.httpStatus, 429);
  assert.equal(payload.model, 'gpt-5-6-t-mini');
  assert.equal(commands.some((item) => item.command === 'Fetch.continueResponse'), true);
  assert.equal(commands[0].command, 'Fetch.enable');
  assert.equal(commands.at(-1).command, 'Fetch.disable');
  assert.equal(attached, false);
});

test('ChatGPT stream status helpers follow the status endpoint captured in the HAR', () => {
  const conversationId = '6a80f4cf-1650-83ea-8609-adb411b3e4bc';
  assert.equal(
    conversationStreamStatusUrl(conversationId),
    `https://chatgpt.com/backend-api/conversation/${conversationId}/stream_status`,
  );
  assert.equal(conversationStreamStatusUrl('not-a-conversation-id'), null);
  assert.equal(
    conversationIdFromStreamStatusUrl(`https://chatgpt.com/backend-api/conversation/${conversationId}/stream_status`),
    conversationId,
  );
  assert.equal(
    conversationIdFromRouteUrl(`https://chatgpt.com/c/${conversationId}`),
    conversationId,
  );
  assert.equal(
    conversationIdFromRouteUrl(`https://chatgpt.com/g/g-p-example/c/${conversationId}`),
    conversationId,
  );
  assert.equal(conversationIdFromRouteUrl('https://chatgpt.com/c/WEB:1443a631-8e0c-4683-bd40-8071fd8ab3c6'), null);
  assert.equal(conversationIdFromRouteUrl('https://chatgpt.com/c/not-a-uuid'), null);
  assert.equal(conversationIdFromStreamStatusUrl('https://example.com/backend-api/conversation/nope/stream_status'), null);
  assert.equal(normalizeConversationStreamStatus('IS_STREAMING'), 'streaming');
  assert.equal(normalizeConversationStreamStatus('COMPLETE'), 'completed');
  assert.equal(normalizeConversationStreamStatus('NOT_STREAMING'), 'completed');
  assert.equal(normalizeConversationStreamStatus('FAILURE'), 'failed');
  assert.match(buildConversationStatusScript(conversationId), /backend-api\/conversation.*stream_status/);
  assert.match(buildConversationStatusScript(conversationId), /cache: 'no-store'/);
});

test('rendered ChatGPT conversations do not infer an active reply from a trailing user message', async () => {
  const conversationId = '6a80f4cf-1650-83ea-8609-adb411b3e4bc';
  const view = {
    chatView: {
      webContents: {
        isDestroyed: () => false,
        getURL: () => `https://chatgpt.com/c/${conversationId}`,
        executeJavaScript: async () => ({
          rows: [{ id: 'user-turn', role: 'user', text: 'Follow up', kind: 'message' }],
          generating: false,
          title: 'Follow up',
        }),
      },
    },
    view: null,
    chatConversationCache: new Map(),
  };

  const conversation = await ChatGPTView.prototype.getRenderedChatConversation.call(view, conversationId);
  assert.equal(conversation.status, 'completed');
});

test('ChatGPT stream status uses the persistent browser session for background polling', async () => {
  const conversationId = '6a80f4cf-1650-83ea-8609-adb411b3e4bc';
  let request = null;
  const view = {
    view: {
      webContents: {
        isDestroyed: () => false,
        session: {
          fetch: async (url, options) => {
            request = { url, options };
            return {
              ok: true,
              status: 200,
              text: async () => '{"status":"IS_STREAMING"}',
            };
          },
        },
        executeJavaScript: async () => {
          throw new Error('page fallback should not be needed');
        },
      },
    },
  };

  const result = await ChatGPTView.prototype.fetchConversationStatus.call(view, conversationId);
  assert.deepEqual(result, { ok: true, httpStatus: 200, status: 'IS_STREAMING' });
  assert.equal(request.url, `https://chatgpt.com/backend-api/conversation/${conversationId}/stream_status`);
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.credentials, 'include');
  assert.equal(request.options.cache, 'no-store');
});

test('background ChatGPT status polling checks every submitted task instead of only the active one', async () => {
  const activeTask = {
    taskId: '9f1fae65-e106-4c76-acbe-8ea3928810e7',
    state: 'submitted',
    chatStatus: 'streaming',
  };
  const backgroundTask = {
    taskId: '1f56d3a2-e53d-4e24-8a1b-a7b6941b75de',
    state: 'submitted',
    chatStatus: 'streaming',
  };
  const calls = [];
  const view = {
    activeTask,
    knownTasks: new Map([
      [activeTask.taskId, activeTask],
      [backgroundTask.taskId, backgroundTask],
    ]),
    conversationStatusPollBusy: false,
    checkConversationStatus: async (task) => {
      calls.push(task.taskId);
      return task.taskId;
    },
  };

  const result = await ChatGPTView.prototype.pollConversationStatuses.call(view);
  assert.deepEqual(calls, [activeTask.taskId, backgroundTask.taskId]);
  assert.deepEqual(result, [activeTask.taskId, backgroundTask.taskId]);
  assert.equal(view.conversationStatusPollBusy, false);
});

test('a non-active submitted task persists ChatGPT completion without replacing the active task', async () => {
  const activeTask = {
    taskId: '9f1fae65-e106-4c76-acbe-8ea3928810e7',
    state: 'submitted',
    conversationId: '6a80f4cf-1650-83ea-8609-adb411b3e4bc',
    chatStatus: 'streaming',
  };
  const backgroundTask = {
    taskId: '1f56d3a2-e53d-4e24-8a1b-a7b6941b75de',
    state: 'submitted',
    conversationId: '7b91f4cf-1650-83ea-8609-adb411b3e4bc',
    chatStatus: 'streaming',
    chatStatusRaw: 'IS_STREAMING',
    chatFinishedAt: null,
  };
  const events = [];
  let currentBackgroundTask = backgroundTask;
  const view = {
    activeTask,
    knownTasks: new Map([
      [activeTask.taskId, activeTask],
      [backgroundTask.taskId, backgroundTask],
    ]),
    conversationStatusBusy: new Set(),
    discoverConversationId: async (task) => task.conversationId,
    fetchConversationStatus: async () => ({ ok: true, httpStatus: 200, status: 'COMPLETE' }),
    taskService: {
      updateTask: async (_taskId, update) => {
        currentBackgroundTask = { ...currentBackgroundTask, ...update };
        return currentBackgroundTask;
      },
    },
    onEvent: async (event) => events.push(event),
    view: { webContents: { isDestroyed: () => false } },
  };

  await ChatGPTView.prototype.checkConversationStatus.call(view, backgroundTask);
  assert.equal(view.activeTask, activeTask);
  assert.equal(view.knownTasks.get(backgroundTask.taskId).chatStatus, 'completed');
  assert.equal(events.at(-1).taskId, backgroundTask.taskId);
  assert.equal(events.at(-1).chatStatus, 'completed');
});

test('completed ChatGPT stream status stops the task timer and persists the chat completion state', async () => {
  const task = {
    taskId: '9f1fae65-e106-4c76-acbe-8ea3928810e7',
    state: 'submitted',
    conversationId: '6a80f4cf-1650-83ea-8609-adb411b3e4bc',
    submittedAt: '2026-08-15T23:23:00.000Z',
    chatStatus: 'streaming',
    chatStatusRaw: 'IS_STREAMING',
    chatFinishedAt: null,
  };
  const events = [];
  let current = task;
  const view = {
    activeTask: task,
    knownTasks: new Map([[task.taskId, task]]),
    conversationStatusBusy: false,
    taskService: {
      updateTask: async (_taskId, update) => {
        current = { ...current, ...update };
        return current;
      },
    },
    onEvent: async (event) => events.push(event),
    view: {
      webContents: {
        isDestroyed: () => false,
        getURL: () => `https://chatgpt.com/c/${task.conversationId}`,
        executeJavaScript: async () => ({ ok: true, status: 'COMPLETE' }),
      },
    },
  };

  const result = await ChatGPTView.prototype.checkConversationStatus.call(view);
  assert.equal(result.status, 'COMPLETE');
  assert.equal(current.chatStatus, 'completed');
  assert.equal(current.chatStatusRaw, 'COMPLETE');
  assert.ok(Number.isFinite(Date.parse(current.chatFinishedAt)));
  assert.ok(Date.parse(current.chatFinishedAt) >= Date.parse(task.submittedAt));
  assert.equal(view.activeTask.chatStatus, 'completed');
  assert.equal(events.at(-1).type, 'task-chat-status');
  assert.equal(events.at(-1).chatStatus, 'completed');
});

test('background task status events refresh task lists without forcing the task screen open', async () => {
  const renderer = await fs.readFile(path.join(__dirname, '../src/renderer/app.tsx'), 'utf8');
  const eventFlow = renderer.slice(renderer.indexOf('const unsubscribe = bridge.onTaskEvent'), renderer.indexOf('const updateTask'));
  assert.match(eventFlow, /setTasks\(\(items\) =>/);
  assert.match(eventFlow, /setActiveTask\(\(current\) => current\?\.taskId === event\.task\.taskId \? event\.task : current\)/);
  assert.doesNotMatch(eventFlow, /setRoute\(/);
});

test('unconfirmed submitted tasks are restored to prepared state', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-submit-recovery-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryPath = await createRepository(root);
  const tasks = new TaskService(path.join(root, 'data'));
  await tasks.initialize();
  const repository = (await tasks.inspectRepositories([repositoryPath]))[0];
  const task = await tasks.createTask({
    taskText: 'Change the greeting.', repositories: [repository], autoApply: true,
  });
  const broken = await tasks.updateTask(task.taskId, {
    state: 'submitted',
    submittedAt: new Date().toISOString(),
  });

  const [recovered] = await recoverUnconfirmedSubmissions(tasks, [broken]);
  assert.equal(recovered.state, 'prepared');
  assert.equal(recovered.submittedAt, null);
  assert.equal(recovered.conversationUrl, null);
  assert.equal(recovered.conversationId, null);
  assert.equal(recovered.chatStatus, null);
  assert.equal(recovered.chatStatusRaw, null);
  assert.equal(recovered.chatFinishedAt, null);
  assert.equal((await tasks.getTask(task.taskId)).state, 'prepared');
});

test('task submit does not report success until a ChatGPT conversation exists', async () => {
  const task = { taskId: '9f1fae65-e106-4c76-acbe-8ea3928810e7', handoffPrompt: 'Task', packagePath: '/task.txt' };
  const events = [];
  let updateCount = 0;
  const view = {
    activeMerge: null,
    activeTask: null,
    knownTasks: new Map(),
    taskService: {
      updateTask: async () => {
        updateCount += 1;
        return task;
      },
    },
    onEvent: async (event) => events.push(event),
    waitForComposer: async () => true,
    configureTaskModel: async () => {},
    beginTaskRequestEnforcement: async () => ({
      wait: async () => ({ model: 'gpt-5-6', thinkingEffort: null }),
      dispose: async () => {},
    }),
    injectPrompt: async () => {},
    uploadPackage: async () => {},
    clickSend: async () => true,
    waitForConversationUrl: async () => null,
    installResultWatcher: () => {},
  };

  await assert.rejects(
    ChatGPTView.prototype.submit.call(view, task),
    /could not confirm a ChatGPT conversation/i,
  );
  assert.equal(updateCount, 0);
  assert.equal(events.at(-1).type, 'task-submit-unconfirmed');
});

test('task submit persists the confirmed ChatGPT conversation with submitted state', async () => {
  const task = { taskId: '9f1fae65-e106-4c76-acbe-8ea3928810e7', handoffPrompt: 'Task', packagePath: '/task.txt' };
  const conversationUrl = 'https://chatgpt.com/c/confirmed-conversation';
  let update;
  const view = {
    activeMerge: null,
    activeTask: null,
    knownTasks: new Map(),
    taskService: {
      updateTask: async (_taskId, next) => {
        update = next;
        return { ...task, ...next };
      },
    },
    onEvent: async () => {},
    waitForComposer: async () => true,
    configureTaskModel: async () => {},
    beginTaskRequestEnforcement: async () => ({
      wait: async () => ({ model: 'gpt-5-6', thinkingEffort: null }),
      dispose: async () => {},
    }),
    injectPrompt: async () => {},
    uploadPackage: async () => {},
    clickSend: async () => true,
    waitForConversationUrl: async () => conversationUrl,
    installResultWatcher: () => {},
  };

  const submitted = await ChatGPTView.prototype.submit.call(view, task);
  assert.equal(update.state, 'submitted');
  assert.equal(update.conversationUrl, conversationUrl);
  assert.match(update.submittedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(submitted.conversationUrl, conversationUrl);
});

test('duplicate task submissions share the in-flight ChatGPT request', async () => {
  const task = { taskId: '9f1fae65-e106-4c76-acbe-8ea3928810e7', handoffPrompt: 'Task', packagePath: '/task.txt' };
  let releaseComposer;
  let composerStarted;
  const composerReady = new Promise((resolve) => { composerStarted = resolve; });
  let sendCount = 0;
  const view = {
    activeMerge: null,
    activeTask: null,
    knownTasks: new Map(),
    taskService: {
      updateTask: async (_taskId, next) => ({ ...task, ...next }),
    },
    onEvent: async () => {},
    waitForComposer: async () => {
      composerStarted();
      return new Promise((resolve) => { releaseComposer = resolve; });
    },
    configureTaskModel: async () => {},
    beginTaskRequestEnforcement: async () => ({
      wait: async () => ({ model: 'gpt-5-6', thinkingEffort: null }),
      dispose: async () => {},
    }),
    injectPrompt: async () => {},
    uploadPackage: async () => {},
    clickSend: async () => { sendCount += 1; return true; },
    waitForConversationUrl: async () => 'https://chatgpt.com/c/confirmed-conversation',
    installResultWatcher: () => {},
  };

  const first = ChatGPTView.prototype.submit.call(view, task);
  const second = ChatGPTView.prototype.submit.call(view, task);
  await composerReady;
  releaseComposer(true);

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(sendCount, 1);
  assert.equal(firstResult.conversationUrl, secondResult.conversationUrl);
});

test('task submit selects the requested model and reasoning before injecting the prompt', async () => {
  const task = {
    taskId: '9f1fae65-e106-4c76-acbe-8ea3928810e7',
    handoffPrompt: 'Task',
    packagePath: '/task.txt',
    model: 'luna',
    reasoningMode: 'high',
  };
  const steps = [];
  const view = {
    activeMerge: null,
    activeTask: null,
    knownTasks: new Map(),
    configureTaskModel: async () => steps.push('configure'),
    taskService: {
      updateTask: async (_taskId, next) => ({ ...task, ...next }),
    },
    onEvent: async () => {},
    waitForComposer: async () => true,
    beginTaskRequestEnforcement: async () => {
      steps.push('enforce');
      return {
        wait: async () => {
          steps.push('verify');
          return { model: 'gpt-5-6-t-mini', thinkingEffort: 'extended' };
        },
        dispose: async () => {},
      };
    },
    injectPrompt: async () => steps.push('prompt'),
    uploadPackage: async () => steps.push('package'),
    clickSend: async () => {
      steps.push('send');
      return true;
    },
    waitForConversationUrl: async () => 'https://chatgpt.com/c/confirmed-conversation',
    installResultWatcher: () => {},
  };

  await ChatGPTView.prototype.submit.call(view, task);
  assert.deepEqual(steps, ['configure', 'enforce', 'prompt', 'package', 'send', 'verify']);
});

test('task upload selects the composer file input and dispatches its change event', async () => {
  const commands = [];
  const scripts = [];
  let attachmentWaitedFor = null;
  const debuggerApi = {
    isAttached: () => true,
    sendCommand: async (command, params) => {
      commands.push({ command, params });
      return {};
    },
  };
  const view = {
    view: {
      webContents: {
        debugger: debuggerApi,
        executeJavaScript: async (script) => {
          scripts.push(script);
          return true;
        },
      },
    },
    findFileInputNodeId: async () => 42,
    packageAttachmentStatus: async () => ({ attached: false, busy: false }),
    waitForPackageAttachment: async (filename) => {
      attachmentWaitedFor = filename;
    },
  };

  await ChatGPTView.prototype.uploadPackage.call(view, '/tasks/chatgpt-ide-task-example.txt');
  assert.deepEqual(commands.at(-1), {
    command: 'DOM.setFileInputFiles',
    params: { files: ['/tasks/chatgpt-ide-task-example.txt'], nodeId: 42 },
  });
  assert.match(scripts[0], /dispatchEvent\(new Event\('change'/);
  assert.equal(attachmentWaitedFor, 'chatgpt-ide-task-example.txt');
});

test('task upload reuses an attachment that is already in the composer', async () => {
  let debuggerAccessed = false;
  const view = {
    view: {
      webContents: {
        get debugger() {
          debuggerAccessed = true;
          return {};
        },
      },
    },
    packageAttachmentStatus: async () => ({ attached: true, busy: false }),
  };

  assert.equal(await ChatGPTView.prototype.uploadPackage.call(view, '/tasks/already-attached.txt'), true);
  assert.equal(debuggerAccessed, false);
});

test('task attachment confirmation finds uploaded packages in a hidden view and inside shadow roots', () => {
  const filename = 'chatgpt-ide-task-shadow-root.zip';
  const card = {
    textContent: filename,
    getAttribute: () => null,
    querySelector: () => null,
  };
  const attachment = {
    textContent: filename,
    getAttribute: () => null,
    // Source Control keeps its ChatGPT transport window hidden while summary
    // automation continues in the page DOM.
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    closest: () => card,
    parentElement: card,
  };
  const shadowRoot = {
    querySelectorAll: (selector) => {
      if (selector === '[role="dialog"], [role="alert"], [aria-live]') return [];
      if (selector === '[data-testid*="file"], [data-testid*="attach"], [aria-label], [title], span, div') {
        return [attachment];
      }
      if (selector === '*') return [];
      return [];
    },
  };
  const host = { shadowRoot };
  const document = {
    querySelectorAll: (selector) => {
      if (selector === '*') return [host];
      return [];
    },
  };

  const result = vm.runInNewContext(buildPackageAttachmentStatusScript(filename), {
    document,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  });

  assert.equal(result.attached, true);
  assert.equal(result.busy, false);
});

test('task attachment confirmation waits for ChatGPT to render an attachment card after input selection', () => {
  const filename = 'chatgpt-ide-task-hidden-input.zip';
  const fileInput = { files: [{ name: filename }] };
  const document = {
    querySelectorAll: (selector) => {
      if (selector === 'input[type="file"]') return [fileInput];
      return [];
    },
  };

  const result = vm.runInNewContext(buildPackageAttachmentStatusScript(filename), {
    document,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  });

  assert.equal(result.attached, false);
  assert.equal(result.busy, false);
});

test('task attachments upload after the package and before ChatGPT is sent', async () => {
  const uploads = [];
  const view = {
    uploadPackage: async (filePath) => uploads.push(filePath),
  };

  await ChatGPTView.prototype.uploadAttachments.call(view, [
    { path: '/tasks/context.png' },
    '/tasks/specification.pdf',
  ]);

  assert.deepEqual(uploads, ['/tasks/context.png', '/tasks/specification.pdf']);
});


test('Source Control summary result detection uses the standard task result filename', () => {
  const taskId = '9f1fae65-e106-4c76-acbe-8ea3928810e7';
  const resultFilename = `chatgpt-ide-result-${taskId}.txt`;
  let clicked = false;
  const link = {
    getAttribute: (name) => (name === 'download' ? resultFilename : null),
    textContent: resultFilename,
    scrollIntoView: () => {},
    click: () => { clicked = true; },
  };
  const document = {
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector === 'a[href], a[download], button, [role="link"], [role="button"]') return [link];
      if (selector === '*') return [];
      return [];
    },
  };
  const result = vm.runInNewContext(buildTaskResultDetectionScript({ taskId, resultFilename }), { document });
  assert.equal(result.kind, 'download');
  assert.equal(clicked, true);
  assert.equal(resultTaskId(resultFilename), taskId);
});

test('task result detection accepts only the requested text attachment after generation stops', () => {
  const taskId = '9f1fae65-e106-4c76-acbe-8ea3928810e7';
  const resultFilename = `chatgpt-ide-result-${taskId}.txt`;
  let clicked = false;
  const link = {
    getAttribute: (name) => (name === 'download' ? resultFilename : null),
    textContent: resultFilename,
    scrollIntoView: () => {},
    click: () => { clicked = true; },
  };
  const stopButton = {
    disabled: false,
    getAttribute: (name) => (name === 'aria-disabled' ? 'false' : null),
  };
  const buildDocument = (generating) => ({
    querySelector: (selector) => (selector === '[data-testid="stop-button"]' && generating ? stopButton : null),
    querySelectorAll: (selector) => {
      if (selector === 'a[href], a[download], button, [role="link"], [role="button"]') return [link];
      if (selector === '*') return [];
      return [];
    },
  });
  const script = buildTaskResultDetectionScript(taskId);

  const generating = vm.runInNewContext(script, { document: buildDocument(true) });
  assert.equal(generating.kind, 'generating');
  assert.equal(clicked, false);

  const completed = vm.runInNewContext(script, { document: buildDocument(false) });
  assert.equal(completed.kind, 'download');
  assert.equal(clicked, true);

  const visibleEnvelopeOnly = vm.runInNewContext(script, {
    document: {
      querySelector: () => null,
      querySelectorAll: (selector) => (
        selector === '[data-message-author-role="assistant"]'
          ? [{ textContent: `PATCHWORK_RESULT_V1\n{"taskId":"${taskId}"}\nPATCHWORK_RESULT_END` }]
          : []
      ),
    },
  });
  assert.equal(visibleEnvelopeOnly.kind, 'none');
});

test('task result detection clicks ChatGPT’s download control instead of opening its file preview', () => {
  const taskId = '9f1fae65-e106-4c76-acbe-8ea3928810e7';
  const resultFilename = `chatgpt-ide-result-${taskId}.txt`;
  let previewOpened = false;
  let downloaded = false;
  const download = {
    disabled: false,
    getAttribute: () => null,
    scrollIntoView: () => {},
    click: () => { downloaded = true; },
  };
  const row = {
    parentElement: null,
    querySelectorAll: () => [download],
  };
  const preview = {
    parentElement: row,
    getAttribute: (name) => (name === 'aria-label' ? resultFilename : null),
    textContent: resultFilename,
    scrollIntoView: () => {},
    click: () => { previewOpened = true; },
  };
  const document = {
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector === 'a[href], a[download], button, [role="link"], [role="button"]') return [preview, download];
      if (selector === '*') return [];
      return [];
    },
  };

  const result = vm.runInNewContext(buildTaskResultDetectionScript(taskId), { document });
  assert.equal(result.kind, 'download');
  assert.equal(downloaded, true);
  assert.equal(previewOpened, false);
});

test('task result detection returns ChatGPT’s direct file URL before falling back to a synthetic click', () => {
  const taskId = '9f1fae65-e106-4c76-acbe-8ea3928810e7';
  const resultFilename = `chatgpt-ide-result-${taskId}.txt`;
  let clicked = false;
  const link = {
    getAttribute: (name) => ({ download: resultFilename, href: '/backend-api/files/result/download' })[name] || null,
    textContent: resultFilename,
    scrollIntoView: () => {},
    click: () => { clicked = true; },
  };
  const document = {
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector === 'a[href], a[download], button, [role="link"], [role="button"]') return [link];
      if (selector === '*') return [];
      return [];
    },
  };

  const result = vm.runInNewContext(buildTaskResultDetectionScript(taskId), {
    document,
    URL,
    window: { location: { href: `https://chatgpt.com/c/${taskId}` } },
  });
  assert.equal(result.kind, 'download');
  assert.equal(result.downloadUrl, 'https://chatgpt.com/backend-api/files/result/download');
  assert.equal(clicked, false);
});

test('task result retrieval starts the matched ChatGPT file URL through the authenticated session', async () => {
  const taskId = '9f1fae65-e106-4c76-acbe-8ea3928810e7';
  const task = {
    taskId,
    state: 'submitted',
    chatStatus: 'completed',
    resultFilename: `chatgpt-ide-result-${taskId}.txt`,
  };
  let downloadedUrl = null;
  const events = [];
  const view = {
    activeMerge: null,
    activeTask: task,
    monitorBusy: false,
    processingTasks: new Set(),
    resultAttempts: new Map(),
    pendingDownload: null,
    view: {
      webContents: {
        isDestroyed: () => false,
        executeJavaScript: async () => ({
          kind: 'download',
          downloadUrl: 'https://chatgpt.com/backend-api/files/result/download',
        }),
        downloadURL: (url) => { downloadedUrl = url; },
      },
    },
    onEvent: async (event) => events.push(event),
  };

  const started = await ChatGPTView.prototype.checkForResult.call(view);
  assert.equal(started, true);
  assert.equal(downloadedUrl, 'https://chatgpt.com/backend-api/files/result/download');
  assert.equal(events.at(-1).type, 'result-link-activated');
});

test('merge result detection accepts the requested text file after generation stops', () => {
  const treeId = '4b2d7b31-06ad-4ec3-99b9-7e54bc8dd3e8';
  let clicked = false;
  const link = {
    getAttribute: (name) => (name === 'download' ? mergeResultFilename(treeId) : null),
    textContent: mergeResultFilename(treeId),
    scrollIntoView: () => {},
    click: () => { clicked = true; },
  };
  const stopButton = {
    disabled: false,
    getAttribute: (name) => (name === 'aria-disabled' ? 'false' : null),
  };
  const buildDocument = (generating) => ({
    querySelector: (selector) => (selector === '[data-testid="stop-button"]' && generating ? stopButton : null),
    querySelectorAll: (selector) => {
      if (selector === '[data-message-author-role="assistant"]') return [];
      if (selector === 'a[href], a[download], button, [role="link"], [role="button"]') return [link];
      if (selector === '*') return [];
      return [];
    },
  });
  const script = buildMergeResultDetectionScript(treeId);

  const generating = vm.runInNewContext(script, { document: buildDocument(true) });
  assert.equal(generating.kind, 'generating');
  assert.equal(clicked, false);

  const completed = vm.runInNewContext(script, { document: buildDocument(false) });
  assert.equal(completed.kind, 'download');
  assert.equal(clicked, true);
  assert.equal(mergeTreeId(`${mergeResultFilename(treeId).replace('.txt', '')} (2).txt`), treeId);
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
