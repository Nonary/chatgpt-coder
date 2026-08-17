# ChatGPT - Coder

Patchwork is a local-first Electron companion for completing coding tasks with ChatGPT. It uses an original React renderer with a ChatGPT-inspired light/dark application shell: a unified Home task composer, native Chat and task views, and dedicated Source control, Coding trees, and Task history workspaces. The renderer is a native app surface rather than a recreation of the ChatGPT website. Patchwork packages Git repositories as full-history Git bundles inside ZIP task packages, exchanges marked text results with ChatGPT, validates every patch against its task base, and applies changes locally.

Patchwork does not use the OpenAI developer API or copy ChatGPT authentication cookies into Node. Authenticated ChatGPT pages run in hidden Electron transport windows that use a persistent browser partition. The native renderer receives conversation, project, task, and result state through the main-process bridge. When sign-in, feature inspection, or manual recovery is needed, Patchwork opens a separate app-owned ChatGPT window using that same authenticated partition; the renderer and its workspace layout remain in control of the main app window. Outbound tasks are ZIP files containing Git bundles and instructions. Tasks can target current repository working changes directly or use a coding tree. Results return as downloadable UTF-8 text files; binary-safe Git patches are base64-encoded inside that text.

## App shell and workspaces

Patchwork opens to **Home**, where a centered task composer accepts the coding request and exposes repository, model, reasoning, target, project, attachment, skill, and prompt choices. The left rail provides **New task**, **New chat**, recent tasks, and navigation to **Chats**, **Source control**, **Coding trees**, and **Task history**. The rail can collapse, and the selected system/light/dark theme is retained locally.

The app shell is inspired by the information density and interaction patterns of the official ChatGPT desktop app, but its layout, components, styling, and icons are implemented independently for Patchwork. ChatGPT's web UI is not rendered inside the native workspace. Long-running authenticated operations continue in hidden transport windows and surface progress, errors, and recovery actions in the native renderer.

## Chat

Select **Chats** in the sidebar to use ChatGPT without leaving the Patchwork workspace. The native Chat view lists pinned and recent unarchived conversations, opens the active conversation branch, renders text and Markdown responses, sends new messages, and refreshes while ChatGPT is responding. **New chat** starts a normal new ChatGPT conversation. The app-owned ChatGPT window is available when sign-in or a ChatGPT feature is not represented in the native view.

Message submission is delegated to a hidden ChatGPT transport page in the persistent authenticated partition. Conversation list, detail, and stream-status data are read through ChatGPT's same-origin web endpoints, while the React renderer presents the conversation directly. A separate hidden transport page handles native Chat sends so ordinary Chat use does not replace an active coding-task transport. If the authenticated transport is unavailable, Patchwork leaves the workspace intact and reports a sign-in or retry action.

## Source control

Repositories added to Patchwork are kept in a local workspace and are available from **Source control** in the sidebar. The source-control workspace provides:

- staged, unstaged, and untracked file groups;
- textual previews for tracked changes and safe content previews for untracked files;
- stage/unstage actions for individual files or all changes;
- AI-generated Conventional Commit messages from all uncommitted changes;
- commit creation using the repository's configured Git identity; and
- recent commit history with commit IDs and authors.

Select **AI summary** to package the repository's staged, unstaged, and untracked changes through the same Git-bundle ZIP workflow used for coding tasks. Patchwork uses the saved prompt named **Git Summary** when one exists in the local Prompt library. Otherwise it uses the built-in Git Changes Review + Conventional Commit prompt. The generated message is placed into the commit editor without changing or staging files.

Patchwork deliberately does not expose discard, hard reset, or forced checkout actions in this initial Git workflow. Those operations can erase local work and require a separate, explicit confirmation design.

## Coding trees

Coding trees are optional task targets. A tree runs in a real Git worktree on its own `patchwork/…` branch. The original checkout must have a commit, be on a branch, and be clean before a tree is created. The **Coding trees** workspace lets you:

- create a named tree from a repository;
- discover existing linked worktrees directly from repositories in the workspace;
- attach follow-up tasks to an existing tree while opening a fresh ChatGPT chat each time;
- inspect the tree in Source Control, reveal its directory, and see its task and commit counts;
- discard a tree through an explicit confirmation; or
- choose the ChatGPT project used by **Merge tree**, with the selected destination retained as the tree's default; then ask ChatGPT to summarize all tree commits and produce an improved Conventional Commit message.

Coding-tree task results are never applied to the original checkout. After validation, Patchwork applies the patch to the selected tree, stages it, and commits it using the Conventional Commit message included in ChatGPT's plain-text result. Tasks that target current working changes apply directly to the selected repository without creating a new commit. A tree merge is first tested and committed in a temporary integration worktree. The original branch is fast-forwarded only if it stayed clean and unchanged; Patchwork then removes the task worktree and its branch.

## Task history

Patchwork keeps task records in its local data directory after a task finishes and after its coding tree is merged. **Task history** in the sidebar shows the complete saved history with search and status filters, including task descriptions, result summaries, commit messages, and the coding-tree or repository context. The sidebar's **Recent tasks** list stays intentionally short and links to the full history when older tasks exist.

## Task skills

The Home composer keeps skills out of the main form. **Skills** opens a compact dialog that scans common local skill folders used by Claude Code, Codex, GitHub Copilot, and the provider-agnostic Agent Skills layout. A skill is offered when its directory contains `SKILL.md`, with project and personal skills shown separately. Selected skill directories are copied into the task package under `skills/` and described in `manifest.json`, so the uploaded task stays self-contained.

The generated task instructions tell ChatGPT that skills may be present and to read or invoke a selected skill only when it is relevant to the task. Unrelated skills remain available in the package but should not be loaded just because they were selected.

## Prompt library

The Home composer includes a local **Prompt library** dialog. Saved prompts have a name, short description, and reusable instruction text. Multiple prompts can be selected for a task, removed from the selection as chips, and managed from the prompt library dialog. The instruction text is appended to the task only when selected, and the saved library stays local to the Patchwork installation. A saved prompt named **Git Summary** is also used by Source control's AI summary action.

## Current workflow

1. Patchwork opens to the native Home workspace. Add a repository, describe a task, and optionally choose a coding-tree target, model, reasoning mode, ChatGPT project, attachments, skills, or saved prompts. The selected task configuration stays sticky where supported and is restored after application restarts.
2. Choose **New task**, then use the current working changes, create a coding tree from one clean, committed Git repository, or attach the task to an existing tree. Every task uses a fresh ChatGPT conversation destination.
3. Patchwork creates a ZIP containing `AGENTS.md`, `TASK.md`, `manifest.json`, selected skill directories under `skills/`, user-provided files under `attachments/`, and the selected repository or coding-tree Git bundles under `repositories/`. Already-compressed bundles are stored directly in the ZIP; they are not redundantly compressed a second time.
4. Patchwork prepares the selected ChatGPT destination through a hidden authenticated transport window, injects the instructions, attaches the ZIP package plus any user-selected reference files, waits for the attachments to finish processing, and clicks ChatGPT's Send control. The React workspace remains a native Patchwork surface throughout.
5. If authentication or manual intervention is required, open the separate app-owned ChatGPT window, sign in or complete the action there, then return to Patchwork. **Copy prompt**, **Show package**, and **Import result** remain available if automation cannot complete.
6. ChatGPT follows the Patchwork protocol and attaches `chatgpt-ide-result-<task-id>.txt`, containing a marked `PATCHWORK_RESULT_V1` JSON envelope with base64-encoded `git diff --binary` patches. The envelope is not printed in the chat.
7. Patchwork's application-level monitor activates that exact download, reads the text file locally, verifies the task ID, repository set, base commits, size limits, and base64 integrity, then applies the patch to the task target. Coding-tree tasks also verify the Conventional Commit message and commit the patch. If the target's `HEAD` advanced, Patchwork first tries a clean contextual apply and then Git's three-way merge.
8. When **Merge tree** is chosen, Patchwork opens another fresh ChatGPT chat through the authenticated transport with the tree's commit history and diff summary. It reads the returned merge envelope, creates one squash commit on the original branch through a temporary integration worktree, and removes the coding tree.

If Git reports conflicts, Patchwork leaves the conflict markers and unmerged files in the target, reports the affected files, and offers **Retry apply**. It also offers **Resolve with ChatGPT** when the task has a writable target, which opens a new ChatGPT task containing the current dirty target, `CONFLICTS.md`, the original result patch, and the original task attachments.

If page automation is temporarily unavailable because ChatGPT's markup changed, the authenticated transport remains isolated and Patchwork does not corrupt the native workspace. Use the separate app-owned ChatGPT window for sign-in or manual recovery, or use **Copy prompt**, **Show package**, and **Import result** to complete the workflow manually.

## Development

Requirements:

- Node.js 22 or newer
- pnpm or npm
- Git available on `PATH`

Install dependencies:

```sh
pnpm install
```

Build the React renderer:

```sh
pnpm build:renderer
```

Type-check the renderer and Vite configuration:

```sh
pnpm typecheck
```

Start Patchwork (the renderer is built automatically first):

```sh
pnpm start
```

Verify the project and create a distributable directory build:

```sh
pnpm check
pnpm test
pnpm dist
```

## Safety boundaries

- Coding trees can only be created from clean repositories with an existing `HEAD`, which keeps concurrent workstreams anchored to an unambiguous commit. Current-working-change tasks can package dirty repositories without creating a tree.
- Each follow-up task is pinned to the coding tree's current `HEAD`.
- Each result must name the original task and exact base commit.
- Plain-text envelopes have strict markers, schemas, size limits, repository IDs, and base64-integrity checks. Legacy ZIP paths are treated as untrusted input and are never extracted wholesale.
- All patches are checked before the first repository is modified.
- A multi-repository failure triggers a best-effort reversal of patches already applied.
- Applied task changes are committed only on Patchwork worktree branches. Patchwork never pushes or rewrites published history.
- Squash merging runs in a temporary worktree first and updates the original branch only by fast-forwarding the verified integration commit.
- ChatGPT authentication remains in Electron's persistent browser partition and is never copied into Node or exposed to the React renderer as raw cookies.

## Browser automation boundary

The automation adapter intentionally targets a small set of semantic ChatGPT controls: the prompt composer, attachment input, Send button, generated-file links, and blocking limit notices. Result monitoring runs in Patchwork rather than in a page timer and survives ChatGPT's in-page navigation. The same background monitor dismisses ChatGPT's known conversation-history request-limit dialog through its semantic test ID and “Got it” action, with a narrow text-and-role fallback for other limit dialogs. It never closes unrelated prompts.

Patchwork activates only the text result whose filename contains the exact task ID. Project listing and creation use the same authenticated web endpoints as ChatGPT's project UI; coding-task submission and result handling continue through hidden authenticated transport windows and Chromium's normal file-input and download controls. Native Chat uses a separate hidden ChatGPT surface for Send, which prevents ordinary chat navigation from replacing an active coding-task transport, and its same-origin status requests are excluded from task conversation tracking. Clicking a task reopens its saved ChatGPT conversation through the transport, and submitted tasks show live progress in the native sidebar and task view. Because page markup can change, selector failures stop safely and leave the transport state intact; the separate app-owned ChatGPT window, prompt copy, package reveal, and result import remain available for manual recovery.
