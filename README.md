# Patchwork for ChatGPT (v3)

Patchwork turns **chatgpt.com itself** into a coding workspace. A userscript injects
the entire Patchwork interface into the real ChatGPT page, and a small local HTTP
service — the *agent* — does only what a browser cannot: Git, the filesystem, and
packaging.

There is no Electron app, no embedded browser, and no second window. You work in
your own ChatGPT session, signed in normally, in the browser you already use.

```
  chatgpt.com (your browser)                  patchwork-agent (Node, 127.0.0.1)
  ├─ ChatGPT's own React app                  ├─ Git bundles and ZIP packaging
  └─ Patchwork userscript          ⇄          ├─ patch validation and apply
     ├─ dock UI (shadow DOM)                  ├─ coding trees and squash merges
     ├─ ChatGPT driver (backend-api)          └─ skills, IaC, prompt library
     └─ agent client
```

Patchwork does not use the OpenAI developer API and does not read your cookies. It
runs inside the authenticated page and uses the same same-origin endpoints
ChatGPT's own client uses. Outbound tasks are ZIP files containing Git bundles.
Results come back as a downloadable UTF-8 text file; binary-safe Git patches are
base64-encoded inside it.

## Install

Requirements: Node.js 22+, pnpm or npm, and Git on `PATH`.

```sh
pnpm install
pnpm start          # builds the userscript and starts the agent
```

Then open <http://127.0.0.1:8787/install> and pick one:

- **Userscript (recommended).** Install [Tampermonkey](https://www.tampermonkey.net/)
  or Violentmonkey, click *Install patchwork.user.js*, and reload chatgpt.com. Your
  agent token is baked into the script, so nothing has to be typed.
- **Bookmarklet (fallback).** For browsers without a userscript manager. Drag it to
  the bookmarks bar and click it while on chatgpt.com. The first ChatGPT tab opens
  one small bridge window — keep that window open, because chatgpt.com's
  Content-Security-Policy forbids the page itself from reaching `127.0.0.1`.
  Launching the bookmarklet in another ChatGPT tab discovers that owner first and
  relays through its existing bridge without opening or focusing another window.
  Allow pop-ups for chatgpt.com so the first bridge can start.

`pnpm agent` starts the agent on its own; `pnpm build:userscript` rebuilds only the
bundle. Keep the agent running while you use Patchwork — every Git and filesystem
operation goes through it.

Patchwork checks its own Git upstream when the dock starts and every 30 minutes.
When the checked-out branch is behind, the dock offers **Update**. An automatic
update requires a clean, non-diverged checkout; it fast-forwards to the configured
upstream, refreshes dependencies when the lockfile changed, rebuilds the userscript,
and restarts the agent on the same port. The existing process stays available until
the rebuild succeeds, so a fetch or build failure is shown without taking Patchwork
offline. The header's update button checks on demand and also offers **Rebuild and
restart** when Git is already current.

The installed userscript is a small loader rather than a frozen copy of the dock.
Each ChatGPT page load retrieves the runtime compiled by the local agent, so future
Git updates and rebuilds appear after a normal page reload without reinstalling the
userscript.

Patchwork's dock opens on the right of the page and makes room for itself, so
ChatGPT reflows instead of being covered. `Alt+P` toggles it, and the header's layout
button switches to overlay if you prefer.

Nothing rendered into the page carries a product name or a logo. The panel is styled
from ChatGPT's own design tokens — its greys, hairline borders, translucent hover fills,
radii, and type scale — and follows whichever theme ChatGPT is currently showing, so it
reads as one of the page's own surfaces rather than as something bolted on.

Patchwork also replaces ChatGPT's model control in the composer with a **Sol · Auto**
picker, drawn to match ChatGPT's own menus in both themes, offering GPT-5.6 Sol/Luna and
Auto/Instant/Low/Medium/High/Extra High. That picker is part of the page, not the dock — it is there whether Patchwork is
open or closed, works for ordinary chats, and whatever it shows when you press Send is
what the request is sent with.

## Workflow

1. Open **Tasks** in the dock. Configure the **Workspace** by adding repositories
   as **Edit** or **Context**, then choose whether locally available Git submodules
   are included with **None**, **All**, or **Select**. Submodule selection is
   resolved again by the agent when the task is created, and missing/uninitialized
   submodules are never cloned or fetched implicitly. Choose whether the work lands
   in the current checkouts, a new coding tree, or an existing tree. The task target,
   model, reasoning mode, and ChatGPT project selection stay sticky between tasks.
2. Describe the task. Optionally add saved prompts, local skills, reference file
   attachments, or configured IaC context, and choose whether ChatGPT runs it in a
   plain new chat, an existing project, or a project Patchwork creates. Before
   sending, choose **Ask** to answer the request in the conversation without
   repository changes, or **Agent** to implement the task and return changes for
   Patchwork to apply.
3. The agent builds a ZIP containing `AGENTS.md`, `TASK.md`, `manifest.json`, one
   Git bundle per repository under `repositories/`, plus any `skills/`,
   `attachments/`, `iac/`, and `conflicts/` content. Already-compressed bundles are
   stored, not compressed again.
4. The userscript opens the chosen ChatGPT destination, fills the composer, attaches
   the ZIP as a real `File`, waits for the upload to finish, and clicks Send. A
   `fetch` wrapper rewrites the outgoing request so the exact model and reasoning
   effort you picked are used, and aborts the send if the ZIP is not actually
   attached.
5. For a normal implementation task, ChatGPT follows the embedded protocol and
   attaches `chatgpt-ide-result-<task-id>.txt` containing a marked
   `PATCHWORK_RESULT_V1` envelope. The envelope is never printed in the chat.
6. Patchwork reads that file out of the conversation record, downloads it, and hands
   it to the agent, which verifies the task ID, repository set, base commits, size
   limits, and base64 integrity before touching anything on disk. It then applies the
   patch to the task target — committing it for coding-tree tasks — falling back from
   a clean contextual apply to Git's three-way merge if `HEAD` advanced.
7. **Merge tree** opens a fresh chat with the tree's commit history and diff summary,
   reads the returned merge envelope, creates one squash commit on the original
   branch through a temporary integration worktree, and removes the tree.

If Git reports conflicts, Patchwork leaves the markers in place, reports the affected
files, and offers **Retry apply**. **Resolve with ChatGPT** opens a follow-up task
containing the dirty target, `CONFLICTS.md`, the original result patch, and the
original attachments.

## What lives where

- **Source control** — staged/unstaged/untracked groups, split diffs, stage and
  unstage, commit with the repository's Git identity, recent history, and **AI
  summary**, which packages the working changes as a read-only task and returns a
  Conventional Commit message. It uses your saved prompt named **Git Summary** when
  one exists, otherwise the built-in prompt.
- **Coding trees** — real Git worktrees on `patchwork/…` branches. Create, discover
  existing linked worktrees, attach follow-up tasks, inspect in Source control,
  reveal on disk, discard, or merge. Coding-tree results are never applied to the
  original checkout.
- **History** — every saved task with search and status filters.
- **Prompt library** — reusable named instructions, stored by the agent rather than in
  browser storage, appended to a task only when selected.
- **Skills** — a drawer that scans the local skill folders used by Claude Code, Codex,
  GitHub Copilot, and the provider-agnostic Agent Skills layout. Any directory with a
  `SKILL.md` qualifies. Selected directories are copied into the package under
  `skills/`, and ChatGPT is told to load them only when relevant.
- **Infrastructure context (IaC)** — opt-in read-only Terraform/Pulumi/Kubernetes/
  GitOps repositories, included as bundles under `iac/` and never accepted as a
  result patch target. Configure them in `settings.json` (see
  `settings.example.json`) in the agent's data directory, or point
  `PATCHWORK_IAC_SETTINGS` at a file:

  ```json
  { "iac_urls": ["~/sources/platform-infra", "https://github.com/your-org/terraform-prod.git"] }
  ```

  Local paths, `file://` URLs, HTTPS Git URLs, and SSH-style Git URLs all work.

Instead of a native file dialog — which a web page cannot open — repositories are
chosen through an in-page directory browser backed by the agent, including a "scan
for repositories" sweep. Workspace repositories retain their Edit/Context access in
the composer. Git submodules are discovered explicitly from `.gitmodules` and Git
metadata rather than by making ordinary repository discovery recursive. Selected
submodules are flattened into the same task repository list, deduplicated by their
canonical path, and packaged with relative relationship metadata so local absolute
paths are not exposed in `manifest.json`. Attachments use an ordinary file input,
and their bytes are staged by the agent before packaging.

## Configuration

| Setting | Default | Notes |
| --- | --- | --- |
| `--port`, `PATCHWORK_PORT` | `8787` | Preferred agent HTTP port; an occupied port falls back to a random available port |
| `--home`, `PATCHWORK_HOME` | `~/.patchwork` | Token, task storage, workspace, prompts |
| `--iac-settings`, `PATCHWORK_IAC_SETTINGS` | `<home>/settings.json` | IaC repository list |

The agent generates a token on first run and only accepts requests carrying it, from
an allowlisted origin. The token is embedded in the userscript it serves.

## Safety boundaries

- Coding trees can only be created from clean repositories with an existing `HEAD`.
  Current-working-change tasks can package dirty repositories without a tree. A
  coding tree currently supports exactly one editable workspace repository; Patchwork
  rejects multi-edit tree tasks instead of silently downgrading additional repositories
  to read-only context.
- Each follow-up task is pinned to its coding tree's current `HEAD`, and each result
  must name the original task and exact base commit.
- Plain-text envelopes have strict markers, schemas, size limits, repository IDs, and
  base64 integrity checks. Legacy ZIP result paths are never extracted wholesale.
- Every patch is checked before the first repository is modified, and a
  multi-repository failure triggers a best-effort reversal of what was already applied.
- IaC bundles are read-only context and are never a patch target.
- Applied changes are committed only on Patchwork worktree branches. Patchwork never
  pushes or rewrites published history.
- Squash merging runs in a temporary worktree first and updates the original branch
  only by fast-forwarding the verified integration commit.
- Discard, hard reset, and forced checkout are deliberately absent from the Git UI.

## Browser boundary

The userscript talks to ChatGPT through a deliberately small surface: the composer,
the attachment input, the Send control, `/backend-api` project, conversation,
stream-status and file endpoints, and ChatGPT's known request-limit dialog, which it
dismisses by test ID with a narrow text-and-role fallback. It never closes unrelated
prompts. Because page markup can change, selector failures stop safely and leave
ChatGPT fully usable.

Message sending stays on the real Send control on purpose. ChatGPT's own send request
carries a sentinel chat-requirements token, a proof-of-work token, a Turnstile token,
and a conduit token; reproducing that handshake would be brittle and would make the
session look synthetic. The `fetch` wrapper still gives exact control over the request
body, and reads the new conversation id out of the reply stream.

Reaching the agent is constrained by chatgpt.com's policy, not by preference: its
`connect-src` has no loopback entry, so the page cannot call `127.0.0.1` directly.
With a userscript manager, `GM_xmlhttpRequest` sidesteps that entirely. Without one,
the bookmarklet uses the one route the policy leaves open — a popup bridge plus a
`blob:` script element. ChatGPT tabs coordinate before opening it, so later tabs
reuse the first tab's bridge without foregrounding the window.
`docs/ARCHITECTURE-V3.md` shows the exact directives.

The dock renders inside a shadow root with a constructible stylesheet, so Patchwork's
CSS and ChatGPT's CSS cannot collide and the dock keeps its styling regardless of the
page's `style-src`. ChatGPT's token *values* are copied into that stylesheet rather than
referenced by name, because a renamed internal variable would silently resolve to
nothing. No external asset is ever loaded.

## Development

```sh
pnpm check    # syntax check every JavaScript file
pnpm test     # service, agent HTTP, and userscript suites
pnpm build    # rebuild src/userscript/dist/patchwork.user.js
```

`docs/ARCHITECTURE-V3.md` explains the design, the three browser→agent transports,
and how each piece of v2's Electron automation was replaced by an in-page equivalent.
