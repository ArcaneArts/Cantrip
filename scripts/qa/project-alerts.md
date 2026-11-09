# Alerts qualification

Run from a disposable PR worktree with Node 24 and the workspace dependencies
installed. The fixture creates its own local server, worker, Git repositories,
account keys, recovery file, and unique browser origin under `.qa/editor-*`.
It does not use the user's projects, model credentials, or Codex home.

```sh
pnpm install --frozen-lockfile
pnpm --filter @cantrip/version --filter @cantrip/logging --filter @cantrip/protocol --filter @cantrip/crypto --filter @cantrip/glitch --filter @cantrip/nbt -r build
pnpm cli:build
CANTRIP_QA_EVIDENCE=/tmp/cantrip-alerts-evidence node scripts/qa/project-alerts-browser.mjs chromium
CANTRIP_QA_EVIDENCE=/tmp/cantrip-alerts-evidence node scripts/qa/project-alerts-browser.mjs webkit
```

An existing CLI build can be selected with `CANTRIP_CLI_BIN=/absolute/path/to/cantrip`.
Install the corresponding Playwright browsers if they are not already present.
Each run shuts down only its own server/worker processes. The evidence directory
contains per-engine result JSON and screenshots. Standard output contains
`QA_EVT` records. Return that output, the result JSON, screenshots, and any visual
observations when reporting a failure. Disposable recovery files are not needed.

## What the browser run demonstrates

- A Chat that has never been opened creates an encrypted permission request.
  Its count appears in the switcher while a different project is selected.
- The tile opens the owned Inbox; expanding a row reveals the actual request
  and valid decisions without executing anything.
- A rejected response stays actionable. Deny, user-input answers, source
  navigation, duplicate delivery, live reconnect and reload settle correctly.
- Independent requests stay independent. Agent attribution, protected Goal
  context, Task answer autosave, and review readiness use real client views.
- Archive, explicit stop and deletion retire their source projections.
- Two authorized windows send encrypted responses to the same request.
- Empty Inbox/discovery behavior, compact overflow, browser errors, and
  accidental plaintext in normal requests/server logs are checked.

The app, HTTP authentication/CSRF, source repositories, database migrations,
commit notifications, live client, encryption and workspace commands are real.
The fixture-only server route seeds protected authoritative source records;
there is no new production QA endpoint. Native interaction RPC acceptance is
isolated with a request-key-idempotent adapter so the harness never needs an
actual model turn. Task implementation state is source-seeded in this browser
fixture. Accepted dispatch, source versions, native RPC contracts and real
compare-and-set races are covered separately below. This browser run must not be
reported as executing an LLM or exercising native OS windows.

## Native window checklist (macOS)

```sh
pnpm cli:build
node scripts/qa/workspace-native.mjs --alerts
```

This uses the existing isolated Tauri launcher and a unique app identifier/data
folder. Keep its terminal output for the fixture path and `QA_EVT` records.

1. Complete the disposable account's recovery-file setup. Click **QA create
   background Alert**; wait for the button to say the Alert is ready.
2. Switch to IDE, select **Alerts-Background-QA**, and click **1 Alert**. Expand
   the permission row. Expect its private reason, Allow once and Deny. Merely
   opening the row must not resolve it.
3. Right-click the **Alert Inbox** tab and choose **Pop Out**. Expect one Inbox
   in the new window and no second owner in the original window.
4. Click **Open chat** from the detached Inbox. Expect the original Chat to be
   focused/opened once with its exact pending request revealed.
5. Approve or deny there or in the Inbox. Expect the row/count/tile to disappear
   everywhere while the open Inbox shows **No active alerts**.
6. Close the detached window. Expect its Inbox tab back in the original tab bar,
   with no extra split pane. Close/reopen it through the normal tab controls.
7. Resize both windows and test dark/light themes. Capture screenshots and note
   any clipping, focus, or animation problems. Quit this disposable app when done.

Browser hosts omit desktop-only popout actions, preserving Inbox ownership. Native source/destination lifecycle coverage also runs in
`workspace-panel-popout.integration.test.ts` (Alerts alone and in mixed groups,
return, rejection and dirty editor preservation).

## Source/runtime compatibility

Use the repository's normal Rust/PostgreSQL prerequisites. Each script owns its
disposable databases. `CANTRIP_TEST_SERVER_EXECUTABLE` can select an existing
native server build; `CANTRIP_TEST_POSTGRES_BIN_DIR` can select PostgreSQL tools.

```sh
node scripts/server-rust/project-alert-foundation-compatibility.mjs
node --import tsx scripts/server-rust/project-alert-http-compatibility.mjs
node scripts/server-rust/project-alert-source-http.mjs
node --import tsx scripts/server-rust/native-command-admission-compatibility.mjs --domain interactions --database postgres --report /tmp/cantrip-alert-interactions.json
pnpm --filter @cantrip/server-reference exec vitest run test/project-alerts.test.ts test/project-alert-interactions.test.ts test/project-alert-workflows.test.ts
node scripts/server-rust/cargo.mjs test --test project_alerts --test project_alert_interactions --test project_alert_workflows
pnpm --filter @cantrip/worker exec vitest run test/mcp-alert-operations.test.ts test/project-goal-delivery.test.ts
pnpm --filter @cantrip/app exec vitest run src/components/alerts src/lib/project-alert-counts.test.tsx src/lib/alert-navigation.test.ts src/lib/alert-worker-encryption.test.tsx src/components/app/workspace-panel-popout.integration.test.ts
```

These cover owner/project/worker isolation, bounded pagination, terminal
replays, independent requests, authoritative Task dispatch/Goal transitions,
protected agent-tool scope, process generations, restarts, migration backfill,
and actual PostgreSQL contention between Node/Rust callers. Never substitute a
browser-only result for these source/runtime checks.
