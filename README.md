# ChatGPT - Coder

Patchwork is a local-first Electron companion for completing coding tasks through the normal ChatGPT website. It packages Git repositories as full-history Git bundles inside a ZIP task package, keeps one persistent ChatGPT browser session inside the IDE, automates task submission through that session, mirrors task conversations into a native chat UI, downloads ChatGPT's marked text result, validates every patch against its task base, and applies the changes locally.

Patchwork does not use the OpenAI developer API or read browser authentication cookies. The user signs in through the ChatGPT session page once, then project discovery, task submission, task chat, result downloads, and background status checks all reuse that same persistent WebContents. Task pages hide the browser and render a transcript scraped from the authenticated ChatGPT page instead. Outbound tasks are ZIP files containing Git bundles and instructions. Tasks can target current repository working changes directly or use a coding tree. Results return as downloadable UTF-8 text files; binary-safe Git patches are base64-encoded inside that text.

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

The task composer keeps skills out of the main form. **Choose skills** opens a compact drawer that scans common local skill folders used by Claude Code, Codex, GitHub Copilot, and the provider-agnostic Agent Skills layout. A skill is offered when its directory contains `SKILL.md`, with project and personal skills shown separately. Selected skill directories are copied into the task package under `skills/` and described in `manifest.json`, so the uploaded task stays self-contained.

The generated task instructions tell ChatGPT that skills may be present and to read or invoke a selected skill only when it is relevant to the task. Unrelated skills remain available in the package but should not be loaded just because they were selected.

## Prompt library

The task composer includes a local **Prompt library** dropdown directly below model selection. Saved prompts have a name, short description, and reusable instruction text. Multiple prompts can be selected for a task, removed from the selection as chips, and managed from the prompt library drawer. The instruction text is appended to the task only when selected, and the saved library stays local to the Patchwork installation. A saved prompt named **Git Summary** is also used by Source control's AI summary action.

## Current workflow

1. Patchwork opens directly to the embedded ChatGPT session. Sign in there before creating a task; the persistent session is reused afterward.
2. Choose **New task**, then use the current working changes, create a coding tree from one clean, committed Git repository, or attach the task to an existing tree. The task target, model, reasoning mode, and ChatGPT project selection stay sticky between task selections and are restored after application restarts.
3. Describe the software task, optionally select saved prompt instructions, local reference files, or skills, and choose where ChatGPT should launch it. A task can use a normal new chat, an existing ChatGPT project, or a newly created project. Patchwork copies attachments into the task record and embeds them in the task package under `attachments/`.
4. Patchwork creates a ZIP containing `AGENTS.md`, `TASK.md`, `manifest.json`, selected skill directories under `skills/`, user-provided files under `attachments/`, and the selected repository or coding tree Git bundles under `repositories/`. Already-compressed bundles are stored directly in the ZIP; they are not redundantly compressed a second time.
5. Patchwork opens the selected ChatGPT destination in the same persistent browser, injects the instructions, attaches the ZIP package plus any user-selected reference files, waits for the attachments to finish processing, and clicks ChatGPT's Send button. The browser stays hidden on task pages while Patchwork mirrors the conversation into its native chat UI.
6. ChatGPT follows the embedded protocol and attaches `chatgpt-ide-result-<task-id>.txt`, containing a marked `PATCHWORK_RESULT_V1` JSON envelope with base64-encoded `git diff --binary` patches. The envelope is not printed in the chat.
7. Patchwork's application-level monitor activates that exact download, reads the text file locally, verifies the task ID, repository set, base commits, size limits, and base64 integrity, then applies the patch to the task target. Coding-tree tasks also verify the Conventional Commit message and commit the patch. If the target's `HEAD` advanced, Patchwork first tries a clean contextual apply and then Git's three-way merge.
8. When **Merge tree** is chosen, Patchwork opens another fresh ChatGPT chat with the tree's commit history and diff summary. It reads the returned merge envelope, creates one squash commit on the original branch through a temporary integration worktree, and removes the coding tree.

If Git reports conflicts, Patchwork leaves the conflict markers and unmerged files in the target, reports the affected files, and offers **Retry apply**. It also offers **Resolve with ChatGPT** when the task has a writable target, which opens a new ChatGPT task containing the current dirty target, `CONFLICTS.md`, the original result patch, and the original task attachments.

If page automation is temporarily unavailable because ChatGPT's markup changed, the **ChatGPT session** page exposes the same persistent browser for recovery. **Copy prompt**, **Show package**, and **Import result** remain available.

## Development

Requirements:

- Node.js 22 or newer
- pnpm or npm
- Git available on `PATH`

Install and run:

```sh
pnpm install
pnpm start
```

Verify the project:

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

## Browser automation boundary

The automation adapter intentionally targets a small set of semantic browser controls: the prompt composer, attachment input, Send button, generated-file links, project controls, and blocking limit notices. Task, project, and chat switches use ChatGPT's in-app router and block document navigations so the authenticated WebContents stays alive. Result monitoring runs in Patchwork rather than in a page timer. About every 15 seconds, the application serially revisits submitted conversations in the same hidden persistent browser, refreshes their run status, mirrors the selected task's transcript into the native chat UI, and looks for the exact task result filename. The same monitor dismisses ChatGPT's known conversation-history request-limit dialog through its semantic test ID and “Got it” action, with a narrow text-and-role fallback for other limit dialogs. It never closes unrelated prompts. Clicking a task hides the browser before navigating to its saved conversation, so browser navigation remains an implementation detail rather than the task UI. Because page markup can change, selector failures stop safely and leave the persistent ChatGPT session available for manual recovery.
