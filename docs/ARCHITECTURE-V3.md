# Patchwork v3 architecture

v3 inverts v1/v2. Instead of an Electron IDE that drives ChatGPT from the outside
through selector automation, v3 **is** ChatGPT: the entire product UI is injected
into the real chatgpt.com page as a userscript, and a small local HTTP service
("the agent") does only the things a browser is not allowed to do — Git, the
filesystem, and packaging.

```
                     the user's own browser
  ┌────────────────────────────────────────────────────────────┐
  │  https://chatgpt.com  (real session, real cookies)          │
  │                                                             │
  │   ChatGPT's own React app        Patchwork userscript       │
  │   ├─ composer / send             ├─ UI (shadow DOM dock)    │
  │   ├─ /backend-api/*      ◀───────┤ ChatGPT driver           │
  │   └─ file uploads                └─ agent client            │
  │                                           │                 │
  └───────────────────────────────────────────┼─────────────────┘
                                              │ localhost transport
                                              ▼
                            ┌───────────────────────────────────┐
                            │ patchwork-agent (Node, 127.0.0.1) │
                            │  git · bundles · zip · patches    │
                            │  worktrees · skills · IaC         │
                            └───────────────────────────────────┘
```

## Why this shape

v2's fragility all came from being *outside* the page: CDP `Fetch` interception to
set the model, `DOM.setFileInputFiles` to attach the ZIP, DOM scraping to find the
result link, and an Electron download hook to read it. Inside the page every one of
those becomes a first-class operation:

| v2 (outside)                                | v3 (inside)                                         |
| ------------------------------------------- | --------------------------------------------------- |
| CDP `Fetch.requestPaused` body rewrite      | `window.fetch` wrapper                              |
| `DOM.setFileInputFiles` (needs a disk path) | `DataTransfer` + a real `File` built from bytes     |
| DOM hunting for the generated-file anchor   | `GET /backend-api/conversation/:id` → file pointers |
| Electron `will-download` interception       | `GET /backend-api/files/:id/download` → fetch text  |
| Shadow-DOM selector walk for the composer   | same page, same JS realm, React state reachable     |
| Custom model-picker web component           | request-level model/effort control, no UI surgery   |

## Components

### 1. `patchwork-agent` (`src/agent/`)

A Node HTTP server bound to `127.0.0.1`. It owns everything that touches disk and
is a direct lift of v2's main-process services — the logic is unchanged, only the
transport in front of it is:

- `services/git.js`, `git-service.js` — inspect, bundle, snapshot, stage, commit, diff
- `services/task-service.js` — ZIP task packaging (`AGENTS.md`, `TASK.md`,
  `manifest.json`, bundles, skills, attachments, IaC, conflicts)
- `services/result-service.js` — `PATCHWORK_RESULT_V1` envelope validation and apply
- `services/worktree-service.js` — coding trees and squash merges
- `services/skill-service.js`, `iac-service.js` — skill discovery, IaC settings
- `services/prompt-service.js` — the prompt library (moved off browser localStorage)
- `services/fs-service.js` — directory browsing, reveal-in-file-manager, repo discovery

Electron-only concerns are replaced: native `dialog.showOpenDialog` becomes an
in-page directory browser backed by `fs-service`, and `dialog.showMessageBox`
confirmations become in-page modals.

### 2. The userscript (`src/userscript/`)

A single bundled `patchwork.user.js`. It mounts a resizable dock into a shadow root
so Patchwork's CSS and ChatGPT's CSS can never collide, and drives ChatGPT through
its own endpoints.

Constructible stylesheets (`new CSSStyleSheet()` + `adoptedStyleSheets`) are used
instead of `<style>` tags. chatgpt.com's `style-src` does allow `'unsafe-inline'`
today, so this is defense in depth rather than a necessity: CSSOM rules are not
subject to `style-src`, so the dock keeps its styling even if that ever tightens.
All iconography is inline SVG; no external asset is ever loaded.

### 3. Transport (browser → agent)

What is possible here is decided entirely by chatgpt.com's response headers, which
were read from a real session capture rather than assumed:

```
content-security-policy:
  default-src      'self'
  connect-src      'self' https://chatgpt.com … (no loopback entry)
  script-src       'nonce-…' 'self' 'wasm-unsafe-eval' … (no 'unsafe-eval')
  script-src-elem  'nonce-…' 'self' blob: …
  style-src        'self' 'unsafe-inline' …
cross-origin-opener-policy: same-origin-allow-popups
```

Three consequences drive the design:

- **`connect-src` has no loopback entry**, so `fetch`/WebSocket from the page to
  `http://127.0.0.1` is blocked. (Mixed content is *not* the problem — `127.0.0.1`
  is a potentially trustworthy origin.)
- **`script-src` has no `'unsafe-eval'`** (`'wasm-unsafe-eval'` does not cover JS),
  so `eval()`-ing a downloaded bundle is blocked — but **`script-src-elem` lists
  `blob:`**, so a Blob script element is allowed.
- **COOP is `same-origin-allow-popups`**, so a popup keeps its `window.opener`, and
  neither `window.open` navigation nor `postMessage` is a CSP-controlled channel.

Three transports, probed in order at boot:

1. **`GM_xmlhttpRequest`** (Tampermonkey/Violentmonkey). Runs in the userscript
   manager, so neither the page CSP nor CORS applies. Supports `arraybuffer`
   responses for the task ZIP. This is the supported path.
2. **Direct `fetch`.** Expected to fail on chatgpt.com today given the CSP above. It
   is still probed because the probe is free and would start working if that policy
   ever gains a loopback entry. The agent answers with
   `Access-Control-Allow-Origin: https://chatgpt.com`,
   `Access-Control-Allow-Private-Network: true` (Chrome's PNA preflight), and
   `Cross-Origin-Resource-Policy: cross-origin`. A `securitypolicyviolation`
   listener distinguishes "blocked by policy" from "agent not running" so the
   failure message is accurate.
3. **Popup bridge.** `window.open('http://127.0.0.1:<port>/bridge')`. The bridge page
   performs requests same-origin with the agent and relays results through
   `postMessage`, including `ArrayBuffer` transfers.

Bookmarklet install, for users without a userscript manager, follows the only path
the CSP leaves open: open the bridge popup → receive the bundle over `postMessage` →
inject it as a `blob:` script → use the already-open bridge as the transport.

### 4. Auth

The agent generates a token on first run into its data directory and only accepts
requests carrying it (`Authorization: Bearer …`), plus an `Origin` allowlist. The
token is baked into the `.user.js` the agent serves, so install is a single click
and no secret is ever typed.

## ChatGPT driving

Everything that can be an API call is an API call:

- **Session** — `GET /api/auth/session` → `accessToken`, account id; device id from
  `localStorage`/`oai-did` cookie. Cached, refreshed on 401.
- **Projects** — `GET /backend-api/gizmos/snorlax/sidebar` (paged), `POST
  /backend-api/projects`.
- **Attachments** — bytes come from the agent as an `ArrayBuffer`, become a real
  `File`, and are handed to ChatGPT's own upload path via `DataTransfer` on the
  composer's file input. No disk path, no CDP.
- **Model and reasoning effort** — a `window.fetch` wrapper rewrites `model` and
  `thinking_effort` on the outgoing `POST /backend-api/f/conversation` body and
  verifies the ZIP is actually attached before the request leaves, which is exactly
  what v2 needed the CDP debugger for.
- **Send** — deliberately still the real composer + Send control. The session capture
  shows `POST /backend-api/f/conversation` carrying
  `openai-sentinel-chat-requirements-token`, `openai-sentinel-proof-token`,
  `openai-sentinel-turnstile-token`, and `x-conduit-token`, produced by a
  `sentinel/chat-requirements` prepare/finalize handshake plus a proof-of-work
  answer. Reproducing that would be brittle and would make the session look
  synthetic. Driving the real control keeps the request indistinguishable from a
  human's while the fetch wrapper still gives exact control over its body.
- **Submission confirmation** — the send request answers with an event stream whose
  opening events carry `conversation_id`, so the wrapper reads it from a clone of
  that stream instead of waiting for the SPA route to change.
- **Progress** — `GET /backend-api/conversation/:id/stream_status`.
- **Result** — poll `GET /backend-api/conversation/:id` for an assistant message
  carrying `chatgpt-ide-result-<taskId>.txt`, then
  `GET /backend-api/files/:id/download` and post the text to the agent for
  validation and apply. If that record is unavailable, the rendered transcript is
  scanned for the same file id as a fallback — unlike v2 this never clicks the
  download control, because a browser download would land in the filesystem instead
  of in the page.

## Events

The agent keeps an append-only event log. The page long-polls
`GET /v1/events?since=<seq>`; long-polling rather than SSE because it behaves
identically across all three transports.

## State and reloads

All durable state lives in the agent, so a hard page reload (which restarts the
userscript) loses nothing. In-flight submissions are recovered on boot the same way
v2 recovered them on app start.

## Parity checklist

Task composer · repositories · coding trees · task targets · model and reasoning ·
prompt library · skills drawer · IaC context · attachments · ChatGPT project
selection · submit · live chat status and elapsed time · result validation and apply
· conflicts, retry, and resolve-with-ChatGPT · rollback · source control (status,
stage, diff, commit, AI summary) · task history with search and filters · tree merge.
