# Code editor simplification progress

## Goal

Make an established Cantrip Code workbench open a file with one `open-file`
command. File navigation must not recreate sessions, attachments, transports, or
iframes, and presentation changes must not block opening a file.

## Baseline

The captured 2026-08-30 LOCAL launch took 11,609 ms:

- the cached attachment's file-open control request timed out after 3,002 ms;
- the logical session was replaced while its stale shared transport survived;
- the replacement spent 2,504 ms proving that transport was unresponsive;
- the fresh LOCAL transport passed health in 8 ms;
- two workbenches then initialized concurrently;
- presentation took 1,927 ms and the successful file-open command took 269 ms.

The worker opened the replacement Code session in 3 ms and the server prepared
its route in 35 ms. The delay was client recovery choreography, not repository,
worker, server, or LOCAL-route latency.

## Architecture

Before simplification, both the inline editor and desktop popout put presentation
setup, retries, route probing, and attachment/session replacement in the file
navigation path.

The intended ownership is:

- the transport owns authentication, route selection, and real disconnects;
- an editor surface owns one session, iframe, and workbench;
- a file change sends one `open-file` command to that established workbench;
- presentation is best-effort initialization for a new workbench generation.

## Passes

### Pass 1: direct warm navigation

Status: merged in [PR #1511](https://github.com/ArcaneArts/Cantrip/pull/1511).

Implemented locally:

- inline file changes call `openDirectCodeAttachmentFile` once;
- presentation runs independently once per authenticated frame;
- path changes retain the visible iframe instead of clearing surface readiness;
- a failed warm command reports an error without retrying, probing, or replacing;
- manual Retry repeats only the file command on the same attachment;
- desktop popouts likewise send one file command and do not recover or replace
  their route/session because of that command's failure;
- failed iframe/workbench establishment still releases its unusable cold session.

Focused verification:

- `explorer-code-editor.test.ts`
- `explorer-code-editor-lifecycle.test.tsx`
- `desktop-explorer-window-broker.test.ts`
- 53 tests passed locally.
- TypeScript project build passed.
- Vite production build passed.

### Pass 2: transport-owned reconnect

Status: merged in [PR #1513](https://github.com/ArcaneArts/Cantrip/pull/1513).

Implemented locally:

- a terminal shared transport retries transport acquisition against the same
  protected editor session;
- transport recovery no longer falls through to attachment/session replacement;
- the existing iframe remains mounted while recovery is pending;
- recovery waits while the worker is offline and resumes when it returns;
- explicit Retry restarts transport recovery without recreating the editor;
- a failed reconnect stops and reports the transport error instead of starting
  another editor lifecycle.

Focused verification:

- the Pass 1 editor and popout suites remain green;
- a terminal transport that fails once and then reconnects retains the original
  session and iframe;
- 54 tests passed locally.
- TypeScript project build passed.
- Vite production build passed.

### Pass 3: remove automatic editor replacement

Status: merged in [PR #1515](https://github.com/ArcaneArts/Cantrip/pull/1515).

Implemented locally:

- removed automatic attachment-replacement counters, pending flags, cooldowns,
  and replacement-budget error handling from the inline editor;
- a terminal legacy route now keeps its iframe mounted and waits for explicit
  Retry before starting a new editor lifecycle;
- terminal session-renewal failures report the expired session instead of
  silently replacing it;
- cold connection telemetry now says `connect-attachment` instead of describing
  every initial connection as a replacement;
- desktop popouts no longer replace their logical session when transport
  reacquisition fails;
- an explicit popout retry reacquires the transport on the same session and uses
  the recovered endpoint for subsequent file commands;
- removed three obsolete automatic-replacement test scenarios.

Focused verification:

- inline legacy terminal recovery requires explicit Retry;
- popout terminal recovery can fail once, retry, and retain one server session;
- the Pass 1-2 focused editor suites remain green.
- 51 tests passed locally.
- TypeScript project build passed.
- Vite production build passed after refreshing the generated protocol package.

### Pass 4: dormant retained editors

Status: merged in [PR #1517](https://github.com/ArcaneArts/Cantrip/pull/1517).

Implemented locally:

- removed the hidden Code-workbench prewarm input from Explorer view staging;
- an inactive Explorer that has never displayed Code creates no editor
  encryption lease, attachment, or iframe;
- once displayed, an inactive retained editor keeps its exact attachment,
  iframe, and latest path without sending file, theme, or recovery commands;
- transport recovery is deferred until the retained editor becomes active and
  then resumes the latest path once on the same session and iframe;
- workbench readiness messages may still be observed while hidden, but the
  readiness deadline and iframe retry are paused until activation;
- a hidden binding change or expired retention lease drops the old workbench
  instead of prewarming the replacement binding.

Focused verification:

- inactive cold surfaces create no attachment or iframe;
- hidden warm surfaces issue no file, theme, or transport-recovery commands;
- activation recovers the same shared session and opens only the latest path;
- a hidden workbench does not reload after its readiness deadline;
- retention, staged Explorer ownership, and editor lifecycle suites pass;
- 56 tests passed locally.
- TypeScript project build passed.
- Vite production build passed.

### Pass 5: shared cross-platform entry

Status: merged in [PR #1519](https://github.com/ArcaneArts/Cantrip/pull/1519).

Implemented locally:

- removed the circular sidebar prerequisite that required an invisible Code
  workbench to become ready before a visible file click could open it;
- sidebar preview clicks now create the visible editor directly, while pinning
  waits only for the replacement Explorer surface metadata already maintained
  by the sidebar pool;
- deleted the workbench-readiness state and callback chain from the sidebar,
  shell, persistent Explorer layer, retained editor, and editor surface;
- file rows no longer expose a separate `openEnabled` guard or a misleading
  `Preparing editor…` state after the protected file tree is authorized;
- retained one platform-neutral file-navigation command through
  `openDirectCodeAttachmentFile`;
- moved the browser-only legacy attachment compatibility decision into the
  Code transport adapter, leaving the React editor free of Tauri runtime
  checks and preserving the existing native transport path.

Focused verification:

- immediate sidebar preview and double-click pin behavior;
- successor provisioning without an editor-readiness dependency;
- shared editor lifecycle, retention, Tauri transport, and browser fallback;
- 138 tests passed locally.
- TypeScript project build passed.
- Vite production build passed.

### Pass 6: stable encryption readiness

Status: merged in [PR #1521](https://github.com/ArcaneArts/Cantrip/pull/1521).

Runtime investigation found one remaining cold-launch remount in the browser:
the Explorer encryption hook included the worker's current grant set in the
editor binding identity. Its own successful grant refresh therefore changed
that identity, briefly closed the readiness gate, unmounted the just-ready
workbench, and started a second editor lifecycle.

Implemented locally:

- split stable worker identity from transient worker authorization material;
- editor binding continuity now changes for a new worker incarnation,
  principal, account, server, or master-key revision, but not because the same
  worker refreshed its grant list or heartbeat;
- transient grant state still receives a fresh authorization decision and the
  editor remains unavailable while required grants are absent, stale, revoked,
  locked, or offline;
- a successful missing-grant to ready transition opens the existing binding
  without a false-ready remount in between;
- no retry, timeout, replacement, or compatibility state was added.

Browser runtime verification used an isolated local server, worker, cloned
repository, and browser origin. The worker grant set was changed in that
isolated environment to reproduce the material-fingerprint transition:

- cold click to completed file open: 2,702 ms;
- cold workbench-ready latency: 998 ms;
- one editor instance, attachment, session, iframe source, and frame nonce;
- no remount or replacement after workbench readiness;
- first warm Code-to-Code file open: 143 ms, including a 137 ms file command;
- second warm Code-to-Code file open: 105 ms, including a 99 ms file command;
- both warm opens retained the exact editor, attachment, session, and iframe;
- neither warm open acquired an attachment, ran health or presentation setup,
  or rebuilt the frame.

Focused verification:

- 13 encryption binding/readiness tests passed;
- TypeScript project build passed;
- Vite production build passed;
- the broader editor matrix has 190 passing assertions; five stale retained
  ownership assertions also fail unchanged on `main` because they still expect
  inactive and preview editors to prewarm, behavior removed in Pass 4.

### Pass 7: runtime acceptance and direct-route recovery

Status: merged in [PR #1524](https://github.com/ArcaneArts/Cantrip/pull/1524).

The Tauri runtime exposed two remaining defects that unit-only validation had
not reproduced:

- cold launch could put best-effort presentation into the worker's serialized
  control lane before the requested file, allowing presentation to consume the
  client's three-second file-open deadline;
- revoking the active LOCAL carrier called browser `WebSocket.close` with code
  `1011`. WebKit rejects application-sent reserved codes synchronously, so the
  exception interrupted connection cleanup before the existing WorkerLink
  reconnect scheduler could run.

Implemented locally:

- path-bearing cold launches wait for their first file-open completion before
  applying presentation; pathless workbenches can still apply presentation as
  soon as their workbench generation is ready;
- desktop tunnel sockets use application close codes `4000` and `4001` for
  local failure/rejection signals, which are legal in browser and WebKit
  clients;
- the WebSocket test double now enforces the browser close-code contract, so
  the former `1011` behavior fails deterministically in unit tests;
- added a focused WorkerLink invariant proving an active LOCAL carrier reopens
  LOCAL without replacing its authority session or route generation;
- replaced five obsolete eager-prewarm ownership scenarios with four current
  lifecycle invariants: cold inactive editors remain dormant, first activation
  creates once, an owned inactive editor stays mounted, and closing it releases
  it.

Tauri runtime verification used an isolated local server, worker, cloned
repository, application bundle identifier, and application data directory:

- a cold launch opened the requested file before presentation, eliminating the
  former client file-open timeout; session start through the completed file
  command took 5,069 ms, including native workbench startup, while the command
  itself completed 209 ms after the bridge connected;
- two warm LOCAL file commands completed 71 ms and 55 ms after their logical
  command streams reached the worker, below the 500 ms acceptance threshold;
- both warm opens retained one Code session, attachment, physical tunnel,
  iframe URL, and frame nonce;
- the active LOCAL capability was revoked through the real server API;
- the LOCAL carrier disconnected and a replacement LOCAL capability connected
  about 313 ms later;
- the same Code session, attachment, tunnel, iframe URL, and frame nonce
  survived the route fault;
- two file intents issued around the fault converged on one post-fault worker
  `code.direct.file-opened` event for the latest requested path;
- the recovered editor visibly displayed that final file without an iframe
  remount or manual Retry;
- WebKit emitted no `InvalidAccessError` after the close-code correction.

Verification after the final source changes:

- 79 focused editor, transport, and WorkerLink assertions passed;
- the complete app suite passed: 344 files and 1,786 assertions, with three
  existing skips;
- TypeScript project build passed;
- Vite production build passed;
- the repository-wide `pnpm check` stops at its unchanged application
  decomposition gate because `chat-turn-runtime.ts` and `task-routes.ts` exceed
  the existing 1,999-line budgets; the same gate fails on `main` with the same
  two files, neither of which this goal changes.

Android runtime verification used a clean API-36 emulator, the static
Capacitor APK built from the Pass 7 source, and a separate fresh server, worker,
encryption profile, and two-file repository fixture:

- the runtime reported Capacitor native with `tauri=false` and completed fresh
  server bootstrap and encryption initialization;
- tapping `alpha.txt` in the sidebar rendered its unique fixture content;
- tapping `beta.txt` in the Explorer surface rendered its unique content;
- a warm Explorer navigation back to `alpha.txt` completed its client launch
  phase in 424 ms;
- that warm open started with both the attachment and workbench ready, reused
  presentation in 1 ms, and emitted one worker `code.direct.file-opened` on the
  same attachment, session, incarnation, and tunnel;
- the editor instance, iframe URL, root lease, frame nonce, and workspace URL
  remained unchanged, with no `code.open` or `code.session.opening` during the
  warm navigation;
- an Explorer cold start completed in 3,182 ms;
- the first-ever sidebar cold start against the entirely fresh worker fixture
  took about 13 seconds and logged one early file-open failure before the bridge
  connected, then succeeded without user intervention; this was not a chain of
  consecutive recovery timeouts;
- Android WebView still reports non-blocking blob-worker authorization
  timeouts for the Code extension host after file content renders. This does
  not prevent opening or navigating text files and is not part of the removed
  file-navigation recovery path.

Ordinary file-open failures no longer trigger automatic attachment
replacement. The remaining explicit replacement paths are surface close/open
and confirmed worker session loss.

Across the editor lifecycle and its desktop WorkerLink bridge, the goal diff
from the pre-goal baseline removes more code than it adds: source is net
`-234` lines, tests are net `-321` lines, and the combined change is net `-555`
lines. This comparison excludes unrelated application code and documentation.

## Measurements

| Path                   |                                                   Before | Current evidence                                       |
| ---------------------- | -------------------------------------------------------: | ------------------------------------------------------ |
| Warm browser file open | 11,609 ms pathological launch; successful command 269 ms | 143 ms then 105 ms; one command and no lifecycle churn |
| Cold browser editor    | 9,229 ms to workbench ready in captured failure recovery | 998 ms workbench ready; 2,702 ms through file open     |
| Warm Tauri LOCAL open  |                       11,609 ms pathological LOCAL trace | 71 ms then 55 ms; same session, attachment, and frame  |
| Cold Tauri editor      |                                     No accepted baseline | 5,069 ms through file open; no recovery timeout chain  |
| LOCAL route recovery   |                                     No accepted baseline | Replacement LOCAL carrier connected in about 313 ms    |
| Warm Android open      |                                     No accepted baseline | 424 ms client launch; same session, attachment, frame  |
| Cold Android editor    |                                     No accepted baseline | 3,182 ms through file open                             |

## Platform verification

| Platform         | Status                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------- |
| Tauri inline     | Cold/warm navigation and genuine LOCAL carrier recovery verified in a real native app   |
| Tauri popout     | Focused broker and shared desktop-tunnel reconnect coverage pass                        |
| Browser          | Cold sidebar entry and repeated warm Code-to-Code navigation verified in a real browser |
| Capacitor/mobile | Sidebar, Explorer, cold, and warm file opening verified in a real API-36 Capacitor app  |

## Server deployment

No server or protocol changes are present in Passes 1-7. Deployment
requirement: none.

## Remaining work

No blocker remains for ordinary editor use. Android's post-render blob-worker
extension-host warning and the slow first-ever cold start on a pristine worker
are non-blocking platform follow-ups.

## Next pass

None. The editor simplification goal is complete; future platform work should
be tracked independently rather than reopening the removed navigation recovery
machinery.
