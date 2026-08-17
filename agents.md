# Repository guidance

## ChatGPT desktop-app parity

For every code change, compare the affected user-facing behavior with the official ChatGPT desktop app installed on this machine. Treat that app as the behavioral reference for interaction flow, terminology, state transitions, loading and error states, keyboard behavior, and visual hierarchy.

Use the installed app's locally available packaged Electron/React implementation as the primary parity reference. Before implementing, trace the relevant renderer components, state flow, styling structure, and Electron boundary in the installed app bundle. After implementing, re-check Patchwork through its React/Electron code paths and automated tests.

Do not use the in-app Browser, Chrome, browser automation, Computer Use, macOS accessibility automation, scripted pointer or keyboard input, screenshots, screen recordings, or image capture for parity research. Do not launch, focus, navigate, or manipulate the official app merely to inspect a flow. If the packaged implementation does not expose enough information, document the uncertainty and make the smallest native Patchwork adaptation instead of switching to visual automation.

The installed implementation is a behavioral and architectural reference, not a source to copy. Do not transplant proprietary code, bundled assets, credentials, or private data. Do not bypass protections or attempt to decrypt unavailable resources. Keep Patchwork's implementation original and maintain its native React/Electron workspace rather than embedding or recreating the ChatGPT web UI.

When exact parity is not possible, preserve the official app's user intent and choose the smallest clear, native Patchwork adaptation. Document a meaningful intentional difference in the change summary or relevant test when it affects users.

## Authentication and browser behavior

Browser-based ChatGPT authentication remains a supported, first-class workflow. Use Electron's persistent browser partition and app-owned browser surfaces for sign-in, session recovery, and authenticated transport behavior.

Never copy, export, expose, or pass ChatGPT cookies, tokens, or other credentials to Node, the React renderer, task packages, logs, or external processes. Keep the native workspace in control while allowing the authenticated browser flow to complete when it is required.

Changes to authentication, browser automation, transport windows, downloads, or recovery actions must be checked against the corresponding locally available Electron/React implementation in the official ChatGPT app and must retain a safe manual fallback when automation cannot proceed.

## Change expectations

- Keep changes focused and consistent with the existing Electron main-process/renderer boundary.
- Update or add tests for changed behavior, especially for task transport, authentication boundaries, and recovery paths.
- Do not weaken the existing safety boundaries around credentials, task packages, Git patches, or destructive repository actions.
