# Native desktop workspace recovery

The current macOS app source passes native detached-window and dirty-editor
acceptance against the packaged Rust server on PGlite, bundled PostgreSQL and
external PostgreSQL. Each storage case uses a disposable account, repository,
full current Node worker and unique native application identifier. The worker
remains Node.

This is a product-flow qualification using actual debug Tauri/WKWebView windows.
The immutable fixture frontend adds a loopback acceptance controller and existing
QA resource helpers. It does not replace the editor, workspace controller,
encryption, transfer channel, native window APIs, server or worker operations.
Only visible editors satisfy assertions; retained inactive DOM nodes cannot
stand in for a rendered view. The controller is never included in ordinary
production builds.

## Actual scenarios

Every storage case executes these eight checkpoints:

1. Create the disposable encryption account through the existing browser client,
   reconnect the full worker, execute its version command, and attach a real
   local Git repository. Import that account into the native app through its
   ordinary recovery-file input.
2. Open and edit two distinct file tabs without saving. Select the first while
   the second retains its inactive draft. Both worker files remain unchanged.
3. Choose **Pop Out** in the actual file-tab menu. A real native window receives
   the first draft, selection, scroll and tab identity. The second draft stays
   in main. Authoritative server layouts have one owner for each tab and no
   pending transfer.
4. Restart the Rust process. Verify a new PID, the same server identity, both
   native windows, both drafts and the same authoritative tab identities.
5. Reload the detached WebView. Require a different JavaScript-context identity
   before checking the recovered draft and actual undo/redo behavior.
6. Send SIGKILL to the fixture's exact native app PID. Its one-shot supervisor
   restarts the same bundle. Both JavaScript contexts change; the native popout,
   tab identities and both unsaved drafts recover. Server and worker processes
   continue running during this application crash.
7. Close the popout through its own native window API. Normal close handling
   returns its draft to main without duplicating or recreating either file tab.
8. Click **Save file**. The exact first draft reaches the actual worker file;
   the other worker file retains its original bytes.

The final matrix has 24 passing checkpoints, three intentional app SIGKILLs,
three Rust process restarts and 15 native-window screenshots. Every final native
launcher, server and worker exits cleanly. Fixture process-tree reports retain
zero survivors. The initial worker restart occurs during fixture setup, before
normal account/command readiness; that early SIGTERM is recorded separately and
is not counted as a graceful worker shutdown.

## Reproduce locally

Prepare the usual workspace dependencies, shared packages and CLI. Build the
native server with `pnpm package:server`, then run on macOS:

```sh
node scripts/server-rust/native-desktop-workspace-acceptance.mjs \
  --server-artifact /absolute/path/to/artifacts/cantrip-server-darwin-arm64 \
  --cli /absolute/path/to/cantrip \
  --database all \
  --report /absolute/path/to/native-desktop-report.json
```

`--database pglite`, `bundled-postgres` or `postgres` selects one case.
`--data-root` selects a new owned evidence directory. An existing
`CARGO_TARGET_DIR` reuses compiled app dependencies; the harness defaults to two
Cargo jobs, no incremental compilation and no development debug information.
It performs actual frontend, Swift helper and native app builds. Build or capture
failures remain failures. macOS screen-capture permission is required for the
owned-window screenshots.

The harness records `QA_EVT` checkpoints, authoritative layout snapshots, actual
process exits, native app logs, screenshot hashes and worker-file assertions.
Its report identifies each private fixture and application identifier. Preserve
those directories, the matching QA client catalogs and recovery material locally
before cleanup; they contain disposable account secrets. The loopback controller
is authenticated and accepts only its fixture origin.

## Source, artifact and limits

The local qualification uses source baseline
`8afe9c5674efc46cce66fee59c8df5f499111360` plus these acceptance helpers. Its Rust
server is the existing packaged `1.1.2786` executable with SHA-256
`c3c69893735427df0eef1ea9379fafe3540a59f363aef3529c54b833ca84a864`.
The current frontend and worker report `1.1.2787`; production-source continuity
and the earlier packaged worker/native asset qualifications retain their
separate evidence. The worker's existing CLI asset is used for real operations.

The debug app uses an isolated development key vault and QA installation
catalog. Normal release-app OS-key-store continuity and all three original
profile upgrades are established separately by the
[encrypted desktop acceptance](RUST_SERVER_DESKTOP_ENCRYPTED_ACCEPTANCE.md).
These complementary runs do not establish a Windows/Linux GUI test, every
transfer-failure phase, power-loss durability or performance capacity. Whole
server requirement/domain and supported-artifact reconciliation remains open.

All validation runs locally. No release, notarization, hosted development
Actions run or Winterhold production deployment is performed.
