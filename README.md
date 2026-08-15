# Patchwork IDE

Patchwork is a local-first Electron companion for completing coding tasks through the normal ChatGPT website. It packages clean Git repositories into portable bundles, embeds a persistent ChatGPT browser session directly inside the IDE, automates task submission through the visible page, captures the named result download, validates every patch against its original commit, and applies the changes locally.

Patchwork does not call OpenAI APIs, inspect ChatGPT network traffic, or read browser authentication cookies. The ChatGPT page remains visible and the user signs in normally. Automation is limited to DOM interaction and Chromium's file-input controls.

## Source control

Repositories added to Patchwork are kept in a local workspace and are available from **Source control** in the sidebar. The source-control workspace provides:

- staged, unstaged, and untracked file groups;
- textual previews for tracked changes and safe content previews for untracked files;
- stage/unstage actions for individual files or all changes;
- commit creation using the repository's configured Git identity; and
- recent commit history with commit IDs and authors.

Patchwork deliberately does not expose discard, hard reset, or forced checkout actions in this initial Git workflow. Those operations can erase local work and require a separate, explicit confirmation design.

## Current workflow

1. Patchwork opens directly to the embedded ChatGPT session. Sign in there before creating a task; the persistent session is reused afterward.
2. Choose **New task**, then add one or more Git repositories. Clean repositories retain their existing history; dirty or brand-new repositories receive an isolated snapshot commit without changing the source working tree.
3. Describe the software task and choose whether validated results should be applied automatically.
4. Patchwork creates a ZIP containing `AGENTS.md`, `TASK.md`, `manifest.json`, and one Git bundle per repository.
5. Patchwork opens a fresh chat inside the same embedded browser, injects the instructions, attaches the ZIP, and clicks ChatGPT's Send button.
6. ChatGPT follows the embedded protocol and returns `chatgpt-ide-result-<task-id>.zip`.
7. A DOM watcher clicks the matching result link. Patchwork captures the browser download, verifies the task ID, repository set, base commits, archive paths, and `git apply --check`, then applies or presents the patch.

If page automation is temporarily unavailable because ChatGPT's markup changed, the embedded browser remains fully usable. **Copy prompt**, **Show package**, and **Import result** provide manual fallbacks without weakening the Git validation protocol.

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

- Clean repositories are pinned to their current `HEAD`. Dirty and unborn repositories are fingerprinted and bundled through an isolated snapshot commit.
- Snapshot-based results are applied only if the original working files and source `HEAD` are unchanged since packaging.
- Each result must name the original task and exact base commit.
- ZIP paths are treated as untrusted input and are never extracted wholesale.
- All patches are checked before the first repository is modified.
- A multi-repository failure triggers a best-effort reversal of patches already applied.
- Applied changes remain uncommitted for review. Patchwork never pushes or rewrites repository history.

## Browser automation boundary

The automation adapter intentionally targets a small set of semantic browser controls: the prompt composer, attachment input, Send button, and the expected result link. It never depends on ChatGPT's private network protocol. Because page markup can change, selector failures stop safely and leave the embedded page available for manual interaction.
