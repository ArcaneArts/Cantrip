# Cantrip stability pass

Started 2026-10-13 from `692f05dcd`. Each milestone uses an isolated
`codex/` branch and worktree, a squash auto-merge PR, observed merge, and cleanup.
Tests run independently of metadata audits. A skipped check is never a pass.

| Milestone                                 | Status      | Branch / PR                                                                                 | Evidence                                                                                            |
| ----------------------------------------- | ----------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1. Lease renewal and reconnect scheduling | Merged      | `codex/stability-lease-recovery` / [#2092](https://github.com/ArcaneArts/Cantrip/pull/2092) | Three regressions fixed; 135 app + 25 worker tests pass; Windows/macOS/Linux CI passed.             |
| 2. Shared editor lifecycle and readiness  | Merged      | [#2093](https://github.com/ArcaneArts/Cantrip/pull/2093)                                    | Late readiness, retained frames, startup stages, and cancellation.                                  |
| 3. Browser recovery harness               | Merged      | [#2107](https://github.com/ArcaneArts/Cantrip/pull/2107)                                    | Actual bundled editor, isolated services, automated failure injection and usable-editor assertions. |
| 4. Measured editor loading                | In progress | —                                                                                           | Comparable cold/warm/recovery measurements; implement only demonstrated improvements.               |
| 5. Worker command dispatch                | Not started | —                                                                                           | Typed feature handlers with explicit ownership and dependencies.                                    |
| 6. App API modularization                 | Not started | —                                                                                           | Domain clients with compatible public exports and shared security infrastructure.                   |
| 7. Codex runtime decomposition            | Not started | —                                                                                           | Separate transport, turn lifecycle, subagents, normalization, and interactions incrementally.       |

## Milestone 1

The existing terminal, remote-surface, and shared WorkerLink clients closed
healthy channels after one transient renewal failure. All three failures were
reproduced with fake-clock regression tests before integrating the fix.

A shared renewal controller now retains the original authorization deadline,
retries transient failures, bounds each request, aborts on owner retirement,
ignores late responses, and closes on explicit rejection or expiry. Renewed
leases cannot extend the original absolute expiry. Shared sessions retain
healthy sibling streams while renewal is retried.

LOCAL capability activity retries are separately bounded because the legacy
telemetry acknowledgement does not return a new lease. The worker broker
continues to enforce its installed capability deadline; the client invents no
new authorization. Browser/native retries and worker reconnect backoff use
bounded jitter. The original worker disconnect-grace deadline remains intact.

Automated verification covers transient failure/success, repeated failures,
hung requests, hard expiry, HTTP authority denials, cancellation and late
responses, client identity retirement, shared sibling channels, LOCAL renewal,
and reconnect jitter. A dedicated Windows/macOS/Linux CI workflow runs the
behavioral recovery suites directly.

Validation:

- Focused app recovery: 135 passed across seven files.
- Worker reconnect/authentication and project-share transport: 25 passed.
- App and worker typechecks passed.
- Full app suite: 2,995 passed, three skipped, one existing settings-search failure.
  The same settings test fails against unmodified main (22 passed, one failed).
  Tracked in [#2091](https://github.com/ArcaneArts/Cantrip/issues/2091) for milestone 3 baseline repair.
- Workflow-removal audit and diff/format checks passed.
- `pnpm check` stops at the existing decomposition budget described below.

Browser acceptance is scheduled for milestone 3; no browser result is claimed
for this milestone.

## Baseline and blocked work

`pnpm check` is attempted for each milestone. The starting baseline stops at
`cantrip_server/src/app/runtime/task-routes.ts`: 2,000 lines against the 1,999-line
decomposition budget. This does not suppress focused behavioral tests.

Milestone 3 records specific blocked browser scenarios below. Other milestones
continue independently; skipped checks are never counted as passes.

## Milestone 2

Delivered from merged milestone 1 (`6bf1c7b7d`) through PR #2093. Existing serialized attachment retirement and generation fencing remain shared.

The CodeView component regressions reproduced late-ready rejection and a hidden
frame consuming its readiness timeout (two failed, one passed before the fix).
The shared watcher now keeps a timed-out mount recoverable, validates exact
frame identity, bounds replay queries, and cancels all listeners/timers on
retirement. Code/Explorer share retry-delay calculation and continue using the
existing serialized attachment lifecycle. The pinned editor patch reports
bootstrap/restoring/restored stages and replays version-one readiness on a
parent query.

Current validation: 107 editor/ownership tests and all 18 Code build-script
tests pass; app typecheck and all 11 patch checks pass. Full app: 3,005 passed,
three skipped, and the same baseline settings-search failure (#2091).

The default native build failed on the host's unaccepted Xcode license. The
Command Line Tools build (`DEVELOPER_DIR=/Library/Developer/CommandLineTools
pnpm code:build`) succeeded. A metadata-formatting fingerprint change was caught
by verification and rebuilt from the final inputs. The final darwin-arm64 build
is `b909e773184ac84af0c9b527ff7c78980f938feb7f90d93bb9572eecfd62885b`; `pnpm code:verify`
passes against the current source and manifest. Patched behavior and component
CI passed on Windows, macOS, and Linux. Browser acceptance remains milestone 3.

## Milestone 3

The fixture starts the production server factory and worker, builds an immutable
app, and serves the actual bundled Code editor. State, Git files, browser
storage, origins, ports, recovery files, and control credentials belong to the
run. A private fault proxy preserves WebSocket subprotocol negotiation and
heartbeat payloads. Real 45-second session leases make authority tests practical
without changing global clocks or production defaults.

`pnpm qa:editor-recovery` drives real onboarding, project/file controls, Monaco
input, and saves verified on the worker filesystem. It records errors,
accessibility snapshots, screenshots, process/socket events, and per-case
recovery time. Independent failures remain failures; later cases attempt a
bounded owned-worker reset. `--case` accepts comma-separated names to reproduce
faults in a fresh fixture when cumulative recovery prevents further setup.

Observed actual-browser results (single-run timings, not benchmark claims):

| Scenario                                   | Result              | Evidence / follow-up                                                                                                                                                                                                               |
| ------------------------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cold editor                                | Passed repeatedly   | Actual typing/save/disk assertion; typical 15–21 seconds including onboarding.                                                                                                                                                     |
| Retained warm reopen                       | Passed              | Same frame URL; 69–82 ms in recorded runs.                                                                                                                                                                                         |
| Delayed readiness                          | Passed in isolation | Actual verified readiness delayed 18 seconds; subsequent typing/save succeeded. Cumulative setup can still fail after earlier faults.                                                                                              |
| Service-worker restart                     | Passed              | Actual CDP target closed, stylesheet refetched with equal status/bytes, dirty file saved.                                                                                                                                          |
| Worker restart                             | Passed              | New worker PID, fresh authorization, actual save reached disk.                                                                                                                                                                     |
| Transient renewal                          | Passed              | Actual 503 followed by 200 on the same renewal path; retained dirty buffer/frame saved.                                                                                                                                            |
| Hard expiry                                | Passed              | Real deadline elapsed, old carrier closed, real server rejected renewal with 404, attempted save left disk unchanged.                                                                                                              |
| Explicit revocation                        | Passed in isolation | Real server returned 404; attempted save left disk unchanged.                                                                                                                                                                      |
| Carrier interruption                       | Failed              | First save can succeed, but subsequent input is blocked by an assertion cover: [#2100](https://github.com/ArcaneArts/Cantrip/issues/2100).                                                                                         |
| Server restart                             | Failed              | Protected path/editor fails to recover within 90 seconds: [#2101](https://github.com/ArcaneArts/Cantrip/issues/2101).                                                                                                              |
| Lost Pong                                  | Failed              | Two actual worker-directed Pong drops, restored delivery, surviving worker, no usable dirty-buffer recovery within 90 seconds; additional evidence on #2101.                                                                       |
| Forced relay generation replacement        | Failed              | Authorized API returns a higher generation; repeated reconnects and actual save failure: [#2103](https://github.com/ArcaneArts/Cantrip/issues/2103).                                                                               |
| Preview/pin cycles                         | Failed              | Strong per-cycle typing/save exposes #2100; rendered text alone was insufficient.                                                                                                                                                  |
| Congested logical stream + healthy sibling | Blocked             | Five bounded injection variants reached outer credit frames but no separate outer channel for the logical asset request. No backpressure pass claimed: [#2104](https://github.com/ArcaneArts/Cantrip/issues/2104).                 |
| Worktree cycles                            | Blocked             | Actual folder-project action menu has no worktree control. Git initialization does not grant repository-project capabilities. Needs an isolated local repository seed: [#2105](https://github.com/ArcaneArts/Cantrip/issues/2105). |

The browser tool also navigated the actual editor and opened fixture files. Its
native EditContext input helper failed three input approaches; the automated
Chromium runner performed the typing and disk assertions. No human execution or
physical device is required.

The harness uncovered an unhandled peer-ready rejection when offer/signaling
failed before its await. Two deterministic regressions reproduced the errors;
observing the promise at construction preserves later rejection and fixes
[#2097](https://github.com/ArcaneArts/Cantrip/issues/2097). Four peer tests pass
without unhandled rejections.

Validation and baseline repairs:

- Full app suite: 3,006 passed, three skipped, no failures before the added peer
  cases. The stale settings-search fixture (#2091) now covers the supported
  permanent project-workspace entry.
- Encrypted workload read-route extraction preserves owner scope, response,
  registration order, and dispatch. Fourteen focused Task tests and server types
  pass. The original decomposition-budget blocker and route inventory are fixed.
- Network behavioral groups execute independently of metadata audits and after
  another group fails. Protocol 20, app 238, worker 97, server 89 passed / two
  failed, native five passed; all groups ran. Five acceptance-runner tests pass.
- Layout fixtures [#2094](https://github.com/ArcaneArts/Cantrip/issues/2094) and
  cross-worker CLI routing [#2095](https://github.com/ArcaneArts/Cantrip/issues/2095)
  reproduce on unchanged main (29 passed / three failed in the focused baseline).
- Packaged-Codex tests now supply the required inference protocol field. Patched
  readiness tests execute actual restored-workbench behavior rather than matching
  an obsolete helper name. All 81 Code extension tests pass, as do current
  script contracts and patch verification. The rebuilt actual editor fingerprint
  is `ba05010e28f214852ff3f4359d20f66a32927ff3f55a759b34d8a5e03e380eae`.
- `DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm check` passes source
  audits, native checks, types, script/extension tests, and shared-package suites,
  then fails the full server suite: 1,409 passed, 74 failed, 70 skipped. Unchanged main reports 1,417 passed / 75 failed / 70 skipped. Every failure
  name reported on this branch also appears on main; main has one additional
  coordinator failure. The baseline is tracked in [#2106](https://github.com/ArcaneArts/Cantrip/issues/2106). Independent browser and focused tests continue.

Fresh onboarding can race worker key refresh (#2096); settings hydration can
replace explicit IDE selection (#2102). The harness retries only after the real
operation fails and records retry counts. Cleanup found conditional worker
shutdown hangs (#2099) and server Code retirement rejection (#2098). Owned
processes receive bounded termination; graceful shutdown is not falsely claimed.

Blocked portions are carried forward with automated follow-ups. They do not
prevent measured loading investigation or later independent refactors.

Sanitized observed browser results are committed in [qa/editor-recovery-results.json](qa/editor-recovery-results.json). Detailed owned logs and screenshots are preserved locally outside the disposable worktree before archival.

## Milestone 4

Based on merged harness PR [#2107](https://github.com/ArcaneArts/Cantrip/pull/2107).
Its harness, editor-lifecycle, and lease-recovery CI all passed on Windows,
macOS, and Linux. Owned services stopped; 516 local evidence files were
preserved before removing disposable runtimes and archiving the M3 worktree.

The HTTP parser redundantly copied an already-owned dechunked buffer. The local
change retains that exactly sized buffer, while fixed-length bodies still copy
their view out of transport storage. Binary/fragmented response regressions
verify bytes, length, header filtering, and ownership after input storage reuse.

Measurements and streaming/cache decisions are recorded in
[EDITOR_LOADING_MEASUREMENTS.md](EDITOR_LOADING_MEASUREMENTS.md). Full-response
buffering, byte limits, cancellation, authentication, and service-worker lineage
remain in force. No cross-session asset cache is introduced.

M4 validation: all 24 final browser scenarios passed across eight fresh fixtures
(including warmups). Parser ownership tests: 56 passed; service-worker lineage,
bounds, and cancellation tests: 47 passed. Worker bridge/supervisor: 91 passed;
app and worker types pass. The retained-restart fixture now fails its restart
process explicitly instead of relying on a 500 ms healthy spawn deadline and a
600 ms sleep.

The standard check attempt hit two protocol timeouts during a 903-second test
stall. Both affected protocol files passed on retry (73 tests). The complete
CUA test command subsequently passed its protocol, worker, integration, and app
groups (136 protocol, 25 fixture contracts, 732 worker, 244 integration, and
313 app tests; three explicit skips). The
standard check is not reported green; the wider server baseline remains #2106.
Focused behavior and browser results were collected independently.

The two additional GC-controlled browser fixtures passed all six behavior
scenarios. Retained renderer heap was approximately 174.14 versus 174.08 MiB;
this single-pair diagnostic did not reproduce the higher unconstrained heap
snapshots and does not establish a whole-page memory gain. Both snapshots and
actual GC completion are captured for future comparisons.
