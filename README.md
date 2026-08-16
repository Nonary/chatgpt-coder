# Patchwork IDE

Patchwork is a local-first Electron companion for completing coding tasks through the normal ChatGPT website. It packages Git repositories as full-history Git bundles inside a ZIP task package, embeds a persistent ChatGPT browser session directly inside the IDE, automates task submission through the visible page, downloads ChatGPT's marked text result, validates every patch against its task base, and applies the changes locally.

Patchwork does not call OpenAI APIs, inspect ChatGPT network traffic, or read browser authentication cookies. The ChatGPT page remains visible and the user signs in normally. Automation is limited to DOM interaction and Chromium's file-input and download controls. Outbound tasks are ZIP files containing Git bundles and instructions. Results return as downloadable UTF-8 text files; binary-safe Git patches are base64-encoded inside that text.

## Source control

Repositories added to Patchwork are kept in a local workspace and are available from **Source control** in the sidebar. The source-control workspace provides:

- staged, unstaged, and untracked file groups;
- textual previews for tracked changes and safe content previews for untracked files;
- stage/unstage actions for individual files or all changes;
- commit creation using the repository's configured Git identity; and
- recent commit history with commit IDs and authors.

Patchwork deliberately does not expose discard, hard reset, or forced checkout actions in this initial Git workflow. Those operations can erase local work and require a separate, explicit confirmation design.

## Coding trees

Every new coding stream runs in a real Git worktree on its own `patchwork/…` branch. The original checkout must have a commit, be on a branch, and be clean before a tree is created. The **Coding trees** workspace lets you:

- create a named tree from a repository;
- attach follow-up tasks to an existing tree while opening a fresh ChatGPT chat each time;
- inspect the tree in Source Control, reveal its directory, and see its task and commit counts;
- discard a tree through an explicit confirmation; or
- ask ChatGPT to summarize all tree commits and produce an improved Conventional Commit message, then squash the tree into the original branch as one commit.

Task results are never applied to the original checkout. After validation, Patchwork applies the patch to the selected tree, stages it, and commits it using the Conventional Commit message included in ChatGPT's downloaded text result. A merge is first tested and committed in a temporary integration worktree. The original branch is fast-forwarded only if it stayed clean and unchanged; Patchwork then removes the task worktree and its branch.

Follow-up tasks may start from a dirty coding tree. Patchwork creates a synthetic task-tip commit on top of the tree's real `HEAD`, preserving the reachable repository history while capturing staged, unstaged, untracked, and conflict-marker files. The bundled instructions make ChatGPT inspect that supplied working state before editing, while the returned patch remains relative to the synthetic tip and therefore contains only ChatGPT's additional work.

## Current workflow

1. Patchwork opens directly to the embedded ChatGPT session. Sign in there before creating a task; the persistent session is reused afterward.
2. Choose **New task**, then create a coding tree from one clean, committed Git repository or attach the task to an existing tree.
3. Describe the software task. Every task opens a fresh chat, including follow-ups on the same tree.
4. Patchwork creates a ZIP containing `AGENTS.md`, `TASK.md`, `manifest.json`, and the coding tree's full-history Git bundle under `repositories/`. Already-compressed bundles are stored directly in the ZIP; they are not redundantly compressed a second time.
5. Patchwork opens a fresh chat inside the same embedded browser, injects the instructions, attaches the ZIP package, and clicks ChatGPT's Send button.
6. ChatGPT follows the embedded protocol and attaches `chatgpt-ide-result-<task-id>.txt`, containing a marked `PATCHWORK_RESULT_V1` JSON envelope with base64-encoded `git diff --binary` patches. The envelope is not printed in the chat.
7. Patchwork's application-level monitor activates that exact download, reads the text file locally, verifies the task ID, repository set, base commits, size limits, base64 integrity, and Conventional Commit message, then applies and commits the patch inside the coding tree. If the tree's `HEAD` advanced, Patchwork first tries a clean contextual apply and then Git's three-way merge.
8. When **Merge tree** is chosen, Patchwork opens another fresh ChatGPT chat with the tree's commit history and diff summary. It reads the returned merge envelope, creates one squash commit on the original branch through a temporary integration worktree, and removes the coding tree.

If Git reports conflicts, Patchwork leaves the conflict markers and unmerged files in the coding tree, reports the affected files, and offers **Resubmit to resolve conflicts**. That action opens a new ChatGPT task containing the current dirty tree, `CONFLICTS.md`, and the original result patch.

If page automation is temporarily unavailable because ChatGPT's markup changed, the embedded browser remains fully usable. **Copy prompt**, **Show package**, and **Import result** remain available; the importer supports legacy ZIP or raw-patch results for compatibility.

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

- Coding trees can only be created from clean repositories with an existing `HEAD`, which keeps concurrent workstreams anchored to an unambiguous commit.
- Each clean follow-up is pinned to the coding tree's current `HEAD`; a dirty follow-up uses a synthetic child commit that captures its exact working state without moving the local branch.
- Each result must name the original task and exact base commit.
- Outbound ZIP packages contain only the task manifest, instructions, and verified Git bundles. Inbound plain-text envelopes have strict markers, schemas, size limits, repository IDs, and base64-integrity checks. Legacy result ZIP paths are treated as untrusted input and are never extracted wholesale.
- Patches against an unchanged tree are checked before modification. Results arriving after a newer commit are merged with Git's three-way machinery and surfaced as a conflict instead of being rejected merely because `HEAD` moved.
- Applied task changes are committed only on Patchwork worktree branches. Patchwork never pushes or rewrites published history.
- Squash merging runs in a temporary worktree first and updates the original branch only by fast-forwarding the verified integration commit.

Because the bundle intentionally contains reachable history, repositories that committed large build artifacts or installer archives will produce large uploads. Patchwork shows the task-package size in the activity panel and avoids redundant ZIP compression, but repository history cleanup or Git LFS is required to make those historical objects smaller.

## Browser automation boundary

The automation adapter intentionally targets a small set of semantic browser controls: the prompt composer, attachment input, Send button, generated-file links, and blocking limit notices. Result monitoring runs in Patchwork rather than in a page timer and survives ChatGPT's in-page navigation. The same background monitor dismisses ChatGPT's known conversation-history request-limit dialog through its semantic test ID and “Got it” action, with a narrow text-and-role fallback for other limit dialogs. It never closes unrelated prompts. Patchwork activates only the text result whose filename contains the exact task ID and never depends on ChatGPT's private network protocol. Clicking a task reopens its saved ChatGPT conversation, and submitted tasks show live elapsed time in the sidebar. Because page markup can change, selector failures stop safely and leave the embedded page available for manual interaction.
