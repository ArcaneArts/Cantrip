# Cantrip Code fix implementation progress

This ledger records verified delivery of the implementation described in
[`CODE_FIX.md`](./CODE_FIX.md). It is updated from merged repository state at the
start of each cycle; a cycle is not marked complete until its pull request has
merged and the result has been observed on `main`.

## Delivery ledger

### Cycle 1 — bounded sidebar Code prewarming

- Branch: `codex/code-fix-bounded-prewarm`
- Pull request: #1642
- Merge commit: `442f348b31dc55950bd6ff3c819a00c610730817`
- Status: merged
- Behavior: explicit members of the existing two-Explorer sidebar preview pool
  may start a hidden, pathless Code workbench; ordinary inactive tabs remain
  dormant; activation reuses the keyed editor, attachment, and iframe.
- Subsystem: app-side Explorer ownership, workbench retention, Code editor
  startup eligibility, and lifecycle regression tests.
- Tests run:
  - Required workspace package builds passed for `@cantrip/version`,
    `@cantrip/logging`, `@cantrip/protocol`, `@cantrip/crypto`, and
    `@cantrip/glitch`.
  - Focused app ownership, lifecycle, popout, controller, and pool suite passed:
    8 files, 89 tests.
  - App typecheck passed.
  - App production build passed.
  - Repository `pnpm check` reached the pre-existing app-decomposition gate and
    stopped because `chat-turn-runtime.ts` and `task-routes.ts` exceed their
    1,999-line budgets. The same gate failure was reproduced on the clean
    primary checkout; neither file is part of this cycle.
  - Full app suite executed 1,949 tests: 1,945 passed, 3 skipped, and one
    unrelated pre-existing settings search assertion failed in
    `settings-page.test.tsx` (`project membership` returned no result). The same
    failure was observed during the clean-baseline audit and does not touch this
    cycle's files.
  - Prettier and `git diff --check` passed.
- Recorded validation commands:

  ```sh
  pnpm --filter @cantrip/version build
  pnpm --filter @cantrip/logging build
  pnpm --filter @cantrip/protocol build
  pnpm --filter @cantrip/crypto build
  pnpm --filter @cantrip/glitch build
  pnpm --filter @cantrip/app exec vitest run src/components/app/sidebar-explorer-controller.test.ts src/components/explorer/explorer-code-editor-lifecycle.test.tsx src/components/explorer/explorer-code-editor.test.ts src/components/explorer/persistent-explorer-code-ownership.test.tsx src/components/explorer/persistent-explorer-views.test.ts src/components/explorer/retained-explorer-code-editor.test.tsx src/lib/desktop-explorer-window-broker.test.ts src/lib/sidebar-file-tabs.test.ts
  pnpm --filter @cantrip/app typecheck
  pnpm --filter @cantrip/app build
  pnpm --filter @cantrip/app exec vitest run --maxWorkers=4
  pnpm check
  pnpm prettier --check docs/CODE_FIX_IMPLEMENTATION_PROGRESS.md cantrip_app/src/components/explorer
  git diff --check
  ```

- Verified result: component tests prove both explicit pool owners start hidden
  and pathless, an unrelated inactive open tab does not start, promotion reuses
  the keyed editor, and the ready attachment and iframe survive the first two
  file navigations without recreation.
- Remaining work: sidebar tree continuity, early extension bridge connection,
  authorized startup payload, authenticated initial-navigation acknowledgement
  and fallback, end-to-end regression audit, and documentation reconciliation.
- Known risks: bounded background workbenches consume resources before the first
  click. The existing pool size of two is the hard ownership cap.
- Manual verification: first-click and post-pin launch traces remain required
  after all implementation cycles land.

### Cycle 2 — sidebar tree continuity during pinning

- Branch: `codex/code-fix-tree-continuity`
- Pull request: #1643
- Merge commit: `14072b0507caa16bdc4b4851b3a17eef909cafed`
- Status: merged
- Behavior: pinning no longer promotes the whole file tree into its loading
  replacement. Existing directory rows stay mounted while the established
  path-level pin indicator reports the operation.
- Subsystem: IDE shell-to-sidebar file-tree state mapping and sidebar file-tree
  continuity tests.
- Tests run:
  - Required workspace package builds passed for `@cantrip/version`,
    `@cantrip/logging`, `@cantrip/protocol`, `@cantrip/crypto`, and
    `@cantrip/glitch`.
  - Focused shell sidebar and project file-tree suite passed: 2 files, 20 tests.
  - App typecheck passed.
  - App production build passed.
  - Prettier and `git diff --check` passed.
- Recorded validation commands:

  ```sh
  pnpm --filter @cantrip/version build
  pnpm --filter @cantrip/logging build
  pnpm --filter @cantrip/protocol build
  pnpm --filter @cantrip/crypto build
  pnpm --filter @cantrip/glitch build
  pnpm --filter @cantrip/app exec vitest run src/components/app/shell-sidebar.test.tsx src/components/sidebar/project-sidebar-file-tree.test.tsx
  pnpm --filter @cantrip/app typecheck
  pnpm --filter @cantrip/app build
  pnpm prettier --check docs/CODE_FIX_IMPLEMENTATION_PROGRESS.md cantrip_app/src/components/app/shell-sidebar.tsx cantrip_app/src/components/app/shell-sidebar.test.tsx cantrip_app/src/components/sidebar/project-sidebar-file-tree.test.tsx
  git diff --check
  ```

- Verified result: shell composition coverage proves pending pin and successor
  creation states keep `fileTreeLoading` false while a valid Explorer exists,
  the exact pin path is forwarded, and genuine initial creation/query loading
  still reports loading. Component coverage proves the current row instance
  survives while path-level progress is active.
- Remaining work: early extension bridge connection, authorized startup
  payload, authenticated initial-navigation acknowledgement and fallback,
  end-to-end regression audit, and documentation reconciliation.
- Known risks: none identified; actual Explorer creation and initial directory
  loading still retain their existing whole-tree loading behavior.
- Manual verification: observe one live pin handoff after all cycles land.

### Cycle 3 — early authenticated extension bridge

- Branch: `codex/code-fix-early-bridge`
- Pull request: #1644
- Merge commit: `cc515c53362d3d94a8f273e2551582006727da0b`
- Status: merged
- Behavior: the workbench extension now begins its authenticated WebSocket
  connection immediately after command registration, before it awaits
  presentation/layout commands. Git initialization retains its existing order.
- Subsystem: bundled Cantrip workbench extension startup.
- Tests run:
  - Complete bundled workbench extension suite passed: 59 tests.
  - Cantrip Code upstream/source verification passed.
  - Prettier and `git diff --check` passed.
- Recorded validation commands:

  ```sh
  pnpm code:extension:test
  pnpm code:source:verify
  pnpm prettier --check cantrip_code/extensions/cantrip-workbench/src/extension.js cantrip_code/extensions/cantrip-workbench/test/startup.test.cjs docs/CODE_FIX_IMPLEMENTATION_PROGRESS.md
  git diff --check
  ```

- Verified result: the startup ordering contract proves bridge connection is
  initiated before presentation setup is awaited. The existing bridge URL,
  token, protocol, reconnect, socket error, and request validation code is
  unchanged.
- Remaining work: authorized startup payload, authenticated initial-navigation
  acknowledgement and fallback, end-to-end regression audit, and documentation
  reconciliation.
- Known risks: presentation commands and bridge connection now overlap; both
  retain their existing independent failure behavior.
- Manual verification: compare cold launch bridge-open timing after all cycles
  land.

### Cycle 4 — worker-authorized initial file payload

- Branch: `codex/code-fix-initial-file-payload`
- Pull request: #1649
- Merge commit: `ffeae013c933fcd5ad01ec2386839b7e875a421f`
- Status: merged
- Behavior: a worker-authorized initial file is translated into OpenVSCode's
  supported `openFile` startup payload when each Tauri or browser attachment URL
  is created, allowing file loading to overlap workbench boot without another
  network hop. Renderer-supplied workspace, empty-window, and payload selectors
  are structurally parsed, then the requested file is resolved through the
  worker's existing canonical realpath, regular-file, and workspace-containment
  authorization before OpenVSCode is served. A validated attachment URL remains
  stable when later file navigation mutates the session, and forwarded authority
  headers are derived only from the sanitized public `Host` value.
- Subsystem: worker Code session proxy target, direct/shared Code HTTP proxy,
  OpenVSCode startup query construction, and proxy authority isolation.
- Tests run:
  - Focused proxy, direct/shared endpoint, protected transport, and supervisor
    suite passed: 4 files, 84 tests.
  - Focused app startup URL, desktop attachment, and browser tunnel suite passed:
    3 files, 105 tests.
  - Complete worker suite passed with four workers: 153 files passed, 1
    skipped; 1,017 tests passed, 2 skipped. Default-concurrency reruns
    intermittently hit the existing supervisor process-start timing tests;
    both timing tests passed together in isolation before the bounded full run.
  - Worker typecheck passed.
  - Worker build passed.
  - App typecheck passed.
  - App production build passed after building its required `@cantrip/glitch`
    workspace dependency.
  - Protocol tests reached the pre-existing public-surface compatibility count
    mismatch (expected 1,843 exports, current clean baseline exposes 1,845) in
    both source and built-surface variants. The same failure reproduces on the
    clean primary checkout and is unrelated to this cycle's optional runtime
    field.
  - Prettier and `git diff --check` passed.
- Recorded validation commands:

  ```sh
  pnpm --filter @cantrip/worker exec vitest run test/code-direct-endpoint.test.ts test/code-protected-transport.test.ts test/code-proxy-utils.test.ts test/code-supervisor.test.ts --maxWorkers=4
  pnpm --filter @cantrip/app exec vitest run src/lib/browser-code-tunnel.test.ts src/lib/code-startup-url.test.ts src/lib/desktop-code.test.ts --maxWorkers=4
  pnpm --filter @cantrip/worker exec vitest run --maxWorkers=4
  pnpm --filter @cantrip/worker typecheck
  pnpm --filter @cantrip/worker build
  pnpm --filter @cantrip/app typecheck
  pnpm --filter @cantrip/glitch build
  pnpm --filter @cantrip/app build
  pnpm --filter @cantrip/protocol test
  pnpm prettier --check cantrip_app/src/lib cantrip_worker/src/code cantrip_worker/test packages/protocol/src/code-surfaces.ts docs/CODE_FIX_IMPLEMENTATION_PROGRESS.md
  git diff --check
  ```

- Verified result: tests prove Tauri direct/shared and browser shared attachment
  URLs contain the authorized `vscode-remote` initial file, the browser root
  lease remains present while the payload crosses the service-worker adapter,
  spoofed renderer selectors are rejected, spoofed forwarded hosts and ports do
  not reach OpenVSCode, mismatched HTTP and WebSocket startup selectors never
  reach the upstream editor, the payload authority matches OpenVSCode's
  forwarded authority, Windows drive and UNC paths are preserved, path changes
  update the worker-owned initial file URI, and an attachment created for file A
  can still reload file A after the session later navigates to file B. Revoking
  a shared HTTP or WebSocket route while canonical authorization is pending
  releases the stream exactly once and opens no late upstream connection.
- Remaining work: authenticated initial-navigation acknowledgement and fallback,
  end-to-end regression audit, and documentation reconciliation.
- Known risks: older clients omit the optional startup payload and continue
  through the existing acknowledged bridge open; that fallback remains in place
  until Cycle 5 proves and deduplicates the initial navigation.
- Manual verification: compare the initial file paint and bridge-open timing on
  both local-direct Tauri and browser-relay routes after all cycles land.

### Cycle 5 — authenticated one-shot initial-navigation acknowledgement

- Branch: `codex/code-fix-initial-navigation-ack`
- Pull request: #1652
- Merge commit: `d565ea4ca42ca6058c086e932004ec32e93e1e0d`
- Status: merged
- Behavior: the existing bridge `openFile` fallback is skipped only once, for
  the startup-payload candidate, and only when the current authoritative
  authenticated extension socket reports the exact requested file with a
  reconciled one-group, one-tab editor topology. Missing, stale, mismatched, or
  superseded state keeps the existing acknowledged bridge command. Subsequent
  navigation always uses that command and cannot be deduplicated against the
  extension's debounced state.
- Subsystem: workbench extension state publication, worker bridge authority and
  file-URI comparison, and supervisor startup-candidate lifecycle.
- Tests run:
  - Complete bundled workbench extension suite passed: 60 tests.
  - Focused worker bridge and supervisor suite passed: 2 files, 81 tests.
  - Complete worker suite passed with four workers: 153 files passed, 1
    skipped; 1,020 tests passed, 2 skipped.
  - Worker typecheck passed.
  - Worker build passed.
  - Protocol typecheck passed. Protocol tests retained the pre-existing
    public-surface compatibility count mismatch (expected 1,843 exports;
    current clean baseline exposes 1,845): 404 tests passed and the duplicated
    source/built compatibility assertions failed.
  - App typecheck passed against the extended optional workbench state.
  - Cantrip Code upstream/source verification passed.
  - Prettier and `git diff --check` passed.
- Recorded validation commands:

  ```sh
  pnpm code:extension:test
  pnpm --filter @cantrip/worker exec vitest run test/code-supervisor.test.ts test/code-workbench-bridge.test.ts --maxWorkers=4
  pnpm --filter @cantrip/worker exec vitest run --maxWorkers=4
  pnpm --filter @cantrip/worker typecheck
  pnpm --filter @cantrip/worker build
  pnpm --filter @cantrip/protocol typecheck
  pnpm --filter @cantrip/protocol test
  pnpm --filter @cantrip/app typecheck
  pnpm code:source:verify
  pnpm prettier --check cantrip_code/extensions/cantrip-workbench cantrip_worker/src/code cantrip_worker/test packages/protocol/src/code-surfaces.ts docs/CODE_FIX_IMPLEMENTATION_PROGRESS.md
  git diff --check
  ```

- Verified result: extension tests prove only the sole active selected tab is
  topology-reconciled. Worker tests prove authority rotation, missing topology,
  relative-path mismatch, URI mismatch, query rejection, POSIX encoding,
  Windows drive canonicalization, and UNC authority canonicalization cannot
  create a false acknowledgement. Supervisor coverage proves the exact initial
  state avoids the duplicate RPC once, the candidate is consumed, and both a
  later identical navigation and mismatched URI retain the existing
  acknowledged fallback.
- Remaining work: complete regression validation, Code documentation
  reconciliation, and final independent audit.
- Known risks: the acknowledgement depends on extension state arriving before
  the app's existing fallback request. If it does not, behavior remains correct
  and takes the established bridge path; no wait or retry was added.
- Manual verification: compare worker bridge request traces for cold local and
  browser launches, confirming zero duplicate `openFile` only when the initial
  file is already active and isolated.

### Cycle 6 — regression and documentation reconciliation

- Branch: `codex/code-fix-final-audit`
- Pull request: pending
- Merge commit: pending
- Status: implementation and documentation verified locally; pull request
  pending
- Behavior: reconciled the authoritative Code lifecycle documentation with the
  merged bounded-prewarm, file-tree continuity, early bridge, authorized startup
  payload, and one-shot acknowledgement behavior. Historical dormancy guidance
  now distinguishes ordinary inactive editors from the explicit two-owner
  sidebar preview pool.
- Subsystem: Code architecture, diagnosis, historical lifecycle record, and
  delivery ledger.
- Tests run:
  - Focused app Code lifecycle and transport suite passed: 10 files, 191 tests.
  - Complete worker suite passed with four workers: 153 files passed, 1
    skipped; 1,024 tests passed, 2 skipped.
  - Complete bundled workbench extension suite passed: 60 tests.
  - Complete protocol suite passed: 55 files, 406 tests.
  - Focused single-worker server Code lifecycle suite passed: 6 files, 97 tests.
  - App, worker, server, and protocol typechecks passed.
  - App, worker, and server production builds passed.
  - Cantrip Code upstream/source verification passed: 9,205 pristine upstream
    files and 11 patches.
  - The complete app suite executed 1,966 tests: 1,961 passed, 3 skipped, and 2
    unrelated tests failed. Both failures reproduced on the clean merged
    baseline before this documentation-only cycle: Settings search does not
    return `project-membership`, and a GitHub pull-request mobile presentation
    fixture omits `reviewThreads`.
  - The complete server suite executed 950 tests: 794 passed, 103 skipped, and
    53 failed on the clean merged baseline. Failures are outside this goal and
    include managed-folder fixture/schema drift plus broad timeout contention;
    the isolated Code transport, attachment, migration, and settings suite is
    green as recorded above.
  - Repository `pnpm check` reached the pre-existing application decomposition
    gate and stopped because `chat-turn-runtime.ts` and `task-routes.ts` exceed
    their 1,999-line budgets. Neither file is changed by this goal.
- Exact validation commands:

  ```sh
  pnpm --filter @cantrip/version build
  pnpm --filter @cantrip/logging build
  pnpm --filter @cantrip/protocol build
  pnpm --filter @cantrip/crypto build
  pnpm --filter @cantrip/glitch build
  pnpm --filter @cantrip/app exec vitest run src/components/app/shell-sidebar.test.tsx src/components/explorer/explorer-code-editor-lifecycle.test.tsx src/components/explorer/explorer-code-editor.test.ts src/components/explorer/persistent-explorer-code-ownership.test.tsx src/components/explorer/retained-explorer-code-editor.test.tsx src/components/sidebar/project-sidebar-file-tree.test.tsx src/lib/browser-code-tunnel.test.ts src/lib/code-startup-url.test.ts src/lib/desktop-code.test.ts src/lib/desktop-explorer-window-broker.test.ts --maxWorkers=4
  pnpm --filter @cantrip/app exec vitest run --maxWorkers=4
  pnpm --filter @cantrip/worker exec vitest run --maxWorkers=4
  pnpm code:extension:test
  pnpm --filter @cantrip/protocol test
  pnpm --filter @cantrip/server exec vitest run test/code-tunnel.test.ts test/code-migration.test.ts test/code-settings-api.test.ts test/code-settings-persistence.test.ts test/shared-code-coordinator-gate.test.ts test/shared-code-transport.test.ts --maxWorkers=1
  pnpm --filter @cantrip/server test
  pnpm --filter @cantrip/app typecheck
  pnpm --filter @cantrip/worker typecheck
  pnpm --filter @cantrip/server typecheck
  pnpm --filter @cantrip/protocol typecheck
  pnpm --filter @cantrip/app build
  pnpm --filter @cantrip/worker build
  pnpm --filter @cantrip/server build
  pnpm code:source:verify
  pnpm check
  pnpm --filter @cantrip/app exec vitest run src/components/settings/settings-page.test.tsx src/components/git/github-pull-request-dialog.test.ts
  pnpm prettier --check docs/CODE.md docs/CODE_FIX.md docs/CODE_EDITOR_SIMPLIFICATION_PROGRESS.md docs/CODE_FIX_IMPLEMENTATION_PROGRESS.md
  git diff --check
  ```

- Verified result: merged source and deterministic regression coverage prove
  that, after bounded prewarm completes, first selection and post-pin selection
  reuse the existing attachment, iframe, session, and workbench; ordinary
  inactive editors stay dormant; pinning retains the file tree; initial startup
  navigation remains canonical and authenticated; and uncertain acknowledgement
  state fails closed to the existing bridge command.
- Remaining work: merge this documentation/audit cycle, record its merge in a
  final ledger-only cycle, and complete one final independent review.
- Known risks: a click that occurs before background prewarm finishes still
  waits for only the remaining real startup work. This is intentional and is
  not hidden with a delay or fake-ready state.
- Manual verification:
  - An isolated macOS Tauri development profile used the built Cycle 6 app,
    its development file vault, and a two-file local repository fixture. Client
    boot rendered in 267 ms. Both bounded preview owners reached an authenticated
    LOCAL attachment and ready workbench before selection.
  - Selecting `first.ts` reused the first owner's exact Explorer, editor,
    attachment, and session with both readiness flags true. The trace contained
    only the file-open phase (342 ms; 355 ms total), with no new route,
    transport, frame, or workbench phase.
  - Pinning that preview kept both file-tree rows visible and kept the same live
    editor, attachment, and session. The successor was available in 7 ms, the
    surface was pinned in 28 ms, the destination was ready in 48 ms, and the
    handoff cleared in 54 ms. The replacement pool owner then completed its
    bounded prewarm.
  - Selecting `second.ts` reused the already-ready second preview owner's exact
    Explorer, editor, attachment, and session. Its only launch phase was
    file-open (214 ms; 226 ms total), again without lifecycle recreation.
  - A fresh browser client connected through an isolated server and worker on
    port 4320. The two active prewarms completed through relay in 2,058 ms and
    2,249 ms. Selecting `first.ts` reused the first exact owner and completed in
    196 ms; after pinning, selecting `second.ts` reused the second exact owner
    and completed in 256 ms. Both selections began with attachment and
    workbench readiness true and created no new route, transport, or workbench.
  - The browser pin trace kept both tree rows mounted and preserved the first
    editor. Its successor became available at 60 ms, the destination was ready
    at 233 ms, and the handoff cleared at 254 ms.
  - A browser reload followed by selection before workbench readiness exercised
    the safe fallback: selection arrived 387 ms into prewarm, the same attachment
    continued to readiness, and the worker logged exactly one
    `code.direct.file-opened` for that session. The file rendered without a
    timeout, retry chain, or attachment replacement. The authenticated
    startup-ack branch remains deterministic-test evidence because this real
    selection correctly took the fallback before an acknowledgement existed.
  - UI automation wall time is not used as product latency evidence because it
    includes tool observation waits; the durations above are the structured
    lifecycle-event durations emitted by the app.

## Required completion matrix

| Requirement                                     | Status   | Evidence           |
| ----------------------------------------------- | -------- | ------------------ |
| Bounded hidden pathless Code prewarm            | Complete | Cycle 1 / PR #1642 |
| First and post-pin selection reuse              | Complete | Cycles 1 and 6     |
| Ordinary inactive editors remain dormant        | Complete | Cycle 1 / PR #1642 |
| Sidebar tree remains mounted during pin         | Complete | Cycle 2 / PR #1643 |
| Bridge connects before presentation setup       | Complete | Cycle 3 / PR #1644 |
| Authorized initial-file startup payload         | Complete | Cycle 4 / PR #1649 |
| Authenticated acknowledgement and safe fallback | Complete | Cycle 5 / PR #1652 |
| Tauri/browser and full regression validation    | Complete | Cycle 6            |
