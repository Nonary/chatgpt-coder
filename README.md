# Patchwork IDE

Patchwork is a local-first Electron companion for completing coding tasks through the normal ChatGPT website. It packages clean Git repositories into plain-text transport envelopes, embeds a persistent ChatGPT browser session directly inside the IDE, automates task submission through the visible page, reads marked patch data from ChatGPT's visible response, validates every patch against its original commit, and applies the changes locally.

Patchwork does not call OpenAI APIs, inspect ChatGPT network traffic, or read browser authentication cookies. The ChatGPT page remains visible and the user signs in normally. Automation is limited to DOM interaction and Chromium's file-input controls. Task bundles and returned patches cross the ChatGPT boundary only as plain text; binary-safe Git data is base64-encoded inside that text.

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

Task results are never applied to the original checkout. After validation, Patchwork applies the patch to the selected tree, stages it, and commits it using the Conventional Commit message included in ChatGPT's plain-text result. A merge is first tested and committed in a temporary integration worktree. The original branch is fast-forwarded only if it stayed clean and unchanged; Patchwork then removes the task worktree and its branch.

## Current workflow

1. Patchwork opens directly to the embedded ChatGPT session. Sign in there before creating a task; the persistent session is reused afterward.
2. Choose **New task**, then create a coding tree from one clean, committed Git repository or attach the task to an existing tree.
3. Describe the software task. Every task opens a fresh chat, including follow-ups on the same tree.
4. Patchwork creates a `.txt` JSON envelope containing base64 representations of `AGENTS.md`, `TASK.md`, `manifest.json`, and the coding tree's Git bundle.
5. Patchwork opens a fresh chat inside the same embedded browser, injects the instructions, attaches the plain-text envelope, and clicks ChatGPT's Send button.
6. ChatGPT follows the embedded protocol and prints a marked `PATCHWORK_RESULT_V1` JSON envelope containing base64-encoded `git diff --binary` patches in its visible response.
7. Patchwork's application-level monitor reads that visible text, decodes it locally, verifies the task ID, repository set, base commits, size limits, base64 integrity, Conventional Commit message, and `git apply --check`, then applies and commits the patch inside the coding tree.
8. When **Merge tree** is chosen, Patchwork opens another fresh ChatGPT chat with the tree's commit history and diff summary. It reads the returned merge envelope, creates one squash commit on the original branch through a temporary integration worktree, and removes the coding tree.

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
- Each follow-up task is pinned to the coding tree's current `HEAD`.
- Each result must name the original task and exact base commit.
- Plain-text envelopes have strict markers, schemas, size limits, repository IDs, and base64-integrity checks. Legacy ZIP paths are treated as untrusted input and are never extracted wholesale.
- All patches are checked before the first repository is modified.
- A multi-repository failure triggers a best-effort reversal of patches already applied.
- Applied task changes are committed only on Patchwork worktree branches. Patchwork never pushes or rewrites published history.
- Squash merging runs in a temporary worktree first and updates the original branch only by fast-forwarding the verified integration commit.

## Browser automation boundary

The automation adapter intentionally targets a small set of semantic browser controls: the prompt composer, attachment input, Send button, assistant-response containers, and blocking limit notices. Result monitoring runs in Patchwork rather than in a page timer and survives ChatGPT's in-page navigation. The same background monitor dismisses ChatGPT's known conversation-history request-limit dialog through its semantic test ID and “Got it” action, with a narrow text-and-role fallback for other limit dialogs. It never closes unrelated prompts. Patchwork reads only the marked result text rendered in the page and never depends on ChatGPT's private network protocol. Legacy downloadable-result detection remains as a compatibility fallback. Because page markup can change, selector failures stop safely and leave the embedded page available for manual interaction.
