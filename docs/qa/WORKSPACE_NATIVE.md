# Native workspace ownership acceptance

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
