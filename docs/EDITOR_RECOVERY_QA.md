# Native editor recovery QA

`pnpm qa:editor-recovery` and `pnpm qa:native-editor:integration` run the same
native file-editor integration suite. The harness starts the real server and
worker with disposable state, builds an immutable client for the run, and drives
Chromium and WebKit in desktop and phone viewports. Viewport coverage does not
claim a physical phone or installed native application run.

Prepare the shared packages, CLI and browsers, then run:

```sh
pnpm install --frozen-lockfile
pnpm --filter @cantrip/version --filter @cantrip/logging --filter @cantrip/protocol --filter @cantrip/crypto --filter @cantrip/glitch -r build
pnpm cli:build
pnpm exec playwright-core install chromium webkit
pnpm qa:editor-recovery
```

Run a single browser/viewport directly when investigating a failure:

```sh
node scripts/qa/native-editor-integration.mjs
node scripts/qa/native-editor-integration.mjs --phone
node scripts/qa/native-editor-integration.mjs --webkit
node scripts/qa/native-editor-integration.mjs --webkit --phone
```

The suite checks actual encrypted saves reaching the worker, unknown files,
BOM/line-ending preservation, View/Edit continuity, file windows, server and
worker restarts, alternate checkouts, standalone Chat files, conflicts, native
Code-tab creation/editing/read-only viewing, and account revocation. A retained
local draft alone does not prove a successful save. Failed behavior produces a
nonzero exit code.

`pnpm qa:editor-fixture` leaves an owned fixture running for interactive testing
through ordinary onboarding and project/file controls. Stop it with SIGINT or
SIGTERM. Fixture controls can restart owned services and interrupt transports;
only fixture-owned processes and connections are cleaned up.

Results, screenshots and correlated logs remain under ignored `.qa/editor-*`
directories. Disposable account recovery files and fixture control credentials
stay local. The native editor has no separate server, distribution build,
workspace profile or extension settings to prepare.

Additional component, document, bundle and close-window checks are documented in
[the editor guide](CODE_EDITOR.md). `pnpm network:acceptance:check` audits
metadata; it does not claim runtime or browser coverage.
