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

Status: in progress on `codex/code-editor-direct-navigation-pass1`.

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

Merged PR: pending.

## Measurements

| Path                 |                                                   Before | Current evidence                  |
| -------------------- | -------------------------------------------------------: | --------------------------------- |
| Warm LOCAL file open | 11,609 ms pathological launch; successful command 269 ms | Runtime trace pending after merge |
| Cold editor          | 9,229 ms to workbench ready in captured failure recovery | Runtime trace pending             |

## Platform verification

| Platform         | Status                                                              |
| ---------------- | ------------------------------------------------------------------- |
| Tauri inline     | Focused lifecycle coverage passes; runtime pending                  |
| Tauri popout     | Focused broker coverage passes; runtime pending                     |
| Browser          | Shares the inline navigation API; runtime pending                   |
| Capacitor/mobile | Shares the non-Tauri navigation API; service-worker runtime pending |

## Server deployment

No server or protocol changes are present in Pass 1. Deployment requirement:
none so far.

## Remaining work

- Merge Pass 1 and capture a real warm LOCAL trace.
- Move genuine transport-terminal recovery fully beneath editor navigation.
- Delete remaining automatic attachment replacement and navigation-era telemetry.
- Make inactive retained editors dormant.
- Verify Tauri, browser, and Capacitor/mobile runtime behavior.

## Next pass

Pass 2 will separate genuine transport-terminal recovery from editor recovery,
keeping the editor session and iframe mounted while the transport reconnects.
