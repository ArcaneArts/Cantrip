# Native workspace ownership acceptance

## Representative mobile and desktop interaction

After the dependency and CLI builds below, run:

```sh
node scripts/qa/workspace-mobile-desktop.mjs
```

If using a custom Cargo target directory, set `CANTRIP_CLI_BIN` to the executable
reported by `pnpm cli:build`. The harness uses separate browser installations,
a 390×844 mobile viewport, and a disposable repository/server/worker. It clicks
the real controls and checks authoritative workspace layouts. Results and
screenshots are saved under `.qa/editor-*`; retain these with any observations.

For optional physical-mobile confirmation, open a full Explorer panel in a
disposable project, click two files (returning to Explorer between opens), then
reopen the first. Expect two independent file tabs, the Explorer directory still
available, no duplicate on reopen, and no placement changes on another device.
Return screenshots and the fixture log if behavior differs. Representative
Chromium results are not physical-device evidence.

### Chat file-entry acceptance in the representative mobile harness

`node scripts/qa/workspace-mobile-desktop.mjs` also creates an idle project chat
with fixture-only synthetic assistant history. It clicks relative and absolute
Markdown file links in the real transcript, edits both resulting files without
saving, returns to the chat, and opens both through the related-file tree.
Expect distinct non-preview file tabs, Edit mode, the same tab IDs and unsaved
contents on reopen, and no changes to the other device's authoritative layout.

Only the history reader for that synthetic chat is replaced in the disposable
build. Production transcript rendering, link callbacks, file-reference metadata,
checkout resolution, workspace commands, encryption, and worker reads are used.
This does not validate model output, encrypted history ingestion, removed
historical checkouts, or native cross-window focus. The fixture does not ship in
the production app. Return `workspace-mobile-desktop.log` and the generated
mobile/desktop screenshots from `.qa/editor-*`; do not share recovery secrets.

## Native fixture

Use a disposable macOS application, server, worker and repository:

```sh
pnpm install --frozen-lockfile
pnpm --filter @cantrip/version --filter @cantrip/logging --filter @cantrip/protocol --filter @cantrip/crypto --filter @cantrip/glitch -r build
pnpm cli:build
node scripts/qa/workspace-native.mjs
```

The launcher compiles the current native app and `cantrip-cua` helper source,
passes Cargo's reported helper executable directly to the isolated worker,
creates a unique application
bundle under `.qa/editor-*`, and uses isolated desktop and worker data paths.
It does not launch the production app or connect to its account. An optional
`CARGO_TARGET_DIR` can reuse build artifacts; it is not an alternate source tree.
Stop the launcher with Ctrl-C after testing. It signals only its native process
group and shuts down its owned fixture services. Do not delete fixture artifacts
until observations and logs have been collected.

The helper build is an actual build operation, not an availability precheck.
Build failures stop launch with Cargo's diagnostics. No helper is installed into
the production worker or copied into the source tree. macOS capture/input
permissions remain required; the launcher does not grant them.

Complete ordinary onboarding in **Cantrip Workspace QA**, save the disposable
recovery file in the fixture directory, and open the fixture repository. Test
with real window close controls, not browser tabs or mocked native APIs:

1. Open two terminals. Print a distinctive marker and a shell variable in one.
   Move only that tab to a new window. Its sibling stays in main; no disabled
   duplicate or empty source slot remains. Verify shell state and output in the
   destination, then close the native window and verify the same state in main.
2. Put two views in one pane and move the whole pane. Verify order, selection,
   and state. Close one tab, then the window: only the surviving view returns.
3. Open a browser at the loopback URL printed by the `native.browser.fixture`
   event. Type a draft, increment the counter, and record the document-instance
   UUID. Detach, interact again, and return it. The UUID, draft and counter must
   survive: this page uses no persisted storage that could disguise a reload.
   Also test its scroll markers. The page can be started independently with
   `node scripts/qa/workspace-browser-fixture.mjs`.
4. Open two Code tabs and a different file in each. Edit both without saving,
   leaving one inactive. Current Code tabs use the native file editor, not an
   embedded VS Code runtime. Move the pane and return it; verify both drafts
   and selection. Confirm disk contents remain unchanged until an explicit save.
5. Open an idle chat with a draft. Detach and return it. Verify its resource and
   draft remain intact; closing its view must not archive the conversation.
6. Where desktop-capture permission is available, open Remote Desktop, change
   viewport/target selection, detach, and return. Verify one live renderer and
   fresh destination input authority. Record missing permission as unverified,
   not as a passing test.
7. Keep multiple popouts open, rearrange the original panes, and return each.
   Verify deterministic placement and no resurrection of previously closed tabs.

For every scenario record `QA_EVT` pass/fail events, the exact actions and
observations, screenshots of both windows, and correlated fixture logs. Startup
alone is not acceptance. Keep recovery files and control credentials local.
Crash, reload, interrupted-transfer and application-quit scenarios remain
separate acceptance requirements; this checklist does not imply they passed.

## Abrupt application termination and recovery

Launch with `CANTRIP_QA_RESTART_AFTER_CRASH=true` to restart the fixture app once
after an actual `SIGKILL`. The existing `CANTRIP_QA_RESTART_ON_EXIT=true` instead
restarts after a successful normal exit; both may be set, but the runner still
restarts at most once. Build failures, nonzero application exits, SIGINT and
SIGTERM are not crash-restart triggers. The native process PID is printed as
`native.workspace.process`; the restart event includes the previous exit result.

1. Create two unsaved file views and detach one. Add distinctive new text in
   both windows; make the main-window draft inactive by selecting another tab.
2. Record the detached pane/tab identities and verify both worker files are
   unchanged. Use only synthetic fixture contents.
3. Resolve the printed PID to the executable inside this fixture's unique
   application bundle. Send SIGKILL to that exact app PID only. Do not kill the
   launcher, server, worker, production app, or shared WebKit processes.
4. Observe the one-shot restart. Main must preserve its active view and recover
   the inactive draft; the detached pane must reopen with its existing identity
   and draft. Opening that file from main must focus the existing window.
5. Open a second popout. Close its sole clean tab, then close the surviving dirty
   popout's native window. Only the surviving tab returns; neither its draft nor
   main's draft may disappear, and the explicitly closed tab must not return.
6. Stop the launcher and inspect owned-process cleanup and unchanged disk files.

This checks whole-application termination with services still running. It does
not establish isolated WebView crash handling, power-loss durability, or a crash
at every transfer phase; test and report those separately.

## Isolated WebKit renderer death (macOS debug fixture)

Launch the native fixture with `CANTRIP_QA_RENDERER_CRASH=true`. Only a debug
build whose configured identifier exactly matches its unique QA bundle exposes
**QA Crash Focused Renderer** in the application menu. The action obtains the
focused WKWebView's exact process ID through a diagnostic API and sends SIGKILL
to that process. It never searches by process name, and fails explicitly if the
diagnostic API is unavailable. The action is excluded from release builds.

Create two unsaved files, detach one, focus its window, and invoke the action.
Expect `renderer.crash-injection` followed by the production
`desktop.renderer.terminated` event with `reload-requested`. Verify the same
native window and tab identities return with their protected drafts, and main
has no duplicate. Repeat with an inactive dirty tab and during destination
startup failure. WebKit may share a renderer process across views, so inspect
every affected window. Verify ordinary return-to-main still works and no disk
file changes without Save. A logged reload request alone is not acceptance.

The production hook responds to actual WebKit process termination, not heartbeat
timeouts. It reloads the existing view; ordinary attachment-generation and
transfer reconciliation then recover state. It invalidates a pending quit
acknowledgement from the dead renderer and does not reload after shutdown has
committed. This callback is macOS-only; it does not establish Windows/Linux
renderer-crash coverage.
