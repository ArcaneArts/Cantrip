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

Status: implemented on `codex/code-editor-cross-platform-entry`.

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

## Measurements

| Path                 |                                                   Before | Current evidence                  |
| -------------------- | -------------------------------------------------------: | --------------------------------- |
| Warm LOCAL file open | 11,609 ms pathological launch; successful command 269 ms | Runtime trace pending after merge |
| Cold editor          | 9,229 ms to workbench ready in captured failure recovery | Runtime trace pending             |

## Platform verification

| Platform         | Status                                                                      |
| ---------------- | --------------------------------------------------------------------------- |
| Tauri inline     | Direct navigation and transport recovery coverage pass; runtime pending     |
| Tauri popout     | Focused broker coverage passes; runtime pending                             |
| Browser          | Immediate sidebar entry and browser fallback coverage pass; runtime pending |
| Capacitor/mobile | Uses the same non-Tauri sidebar and transport entry; runtime pending        |

## Server deployment

No server or protocol changes are present in Passes 1-5. Deployment
requirement: none so far.

## Remaining work

- Capture real warm/cold traces and verify Tauri, browser, and
  Capacitor/mobile runtime behavior.

## Next pass

Pass 6 will run the acceptance matrix against real Tauri, browser, and mobile
runtimes, capture cold and warm timings, and fix only failures proven by those
traces.
