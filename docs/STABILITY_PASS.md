# Cantrip stability pass

Started 2026-10-13 from `692f05dcd`. Each milestone uses an isolated
`codex/` branch and worktree, a squash auto-merge PR, observed merge, and cleanup.
Tests run independently of metadata audits. A skipped check is never a pass.

| Milestone                                 | Status      | Branch / PR                                                                                 | Evidence                                                                                                   |
| ----------------------------------------- | ----------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1. Lease renewal and reconnect scheduling | Merged      | `codex/stability-lease-recovery` / [#2092](https://github.com/ArcaneArts/Cantrip/pull/2092) | Three regressions fixed; 135 app + 25 worker tests pass; Windows/macOS/Linux CI passed.                    |
| 2. Shared editor lifecycle and readiness  | Merged      | [#2093](https://github.com/ArcaneArts/Cantrip/pull/2093)                                    | Late readiness, retained frames, startup stages, and cancellation.                                         |
| 3. Browser recovery harness               | Merged      | [#2107](https://github.com/ArcaneArts/Cantrip/pull/2107)                                    | Actual bundled editor, isolated services, automated failure injection and usable-editor assertions.        |
| 4. Measured editor loading                | Merged      | [#2108](https://github.com/ArcaneArts/Cantrip/pull/2108)                                    | Comparable cold/warm/recovery measurements; implement only demonstrated improvements.                      |
| 5. Worker command dispatch                | Merged      | [#2109](https://github.com/ArcaneArts/Cantrip/pull/2109)                                    | Typed feature handlers with explicit ownership and dependencies.                                           |
| 6. App API modularization                 | Merged      | [#2110](https://github.com/ArcaneArts/Cantrip/pull/2110)                                    | Domain clients with compatible public exports and shared security infrastructure; all three OSs passed CI. |
| 7. Codex runtime decomposition            | In progress | [#2114](https://github.com/ArcaneArts/Cantrip/pull/2114)                                    | 7A event/state boundaries; transport, turn/subagent ownership and interactions follow in separate PRs.     |

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

The newly enabled Windows worker suite exposed two existing fixture assumptions:
it attempted to execute a POSIX-shebang `.cjs` file directly, and one active-file
acknowledgement test supplied a drive-less file URI. The fixture now uses a
packaged-style `.cmd` launcher on Windows while retaining its mutable JavaScript
source; the acknowledgement fixture constructs native file URIs. Production
launching, URI validation, and authority checks are unchanged.

## Milestone 5

Merged in [#2109](https://github.com/ArcaneArts/Cantrip/pull/2109), based on M4
(`c9f2e466a`). Primary synchronized to `411a20100`; owned services stopped,
41 evidence files preserved, disposable runtime moved into a private archive,
and the owned worktree archived.

Extracted 206 commands into 14 typed feature handlers under
`cantrip_worker/src/commands`. The entry point retains explicit routing,
startup/shutdown ownership, provider decryption, native chat/terminal
orchestration, and protected repository authorization. Mutable authorization
and supervisor state use getters to preserve reads after awaits. The entry
point shrank from 8,904 to 7,338 lines. Supporting AST inspection confirmed
unchanged case bodies except those getters.

Final feature CI passed all 18 files on Linux/macOS (161 tests, one existing
skip) and Windows (153 tests, nine existing skips), including 19 new command
characterization/integration tests. Coverage includes incarnation stop claims,
endpoint-close failures, authorization changes across awaits, route acceptance
and revocation ordering, actual renewal authority, real Git discovery/worktrees,
encrypted attachment round trips and clearing decrypted bytes after failed
writes. Source types, strict new-test types, formatting and diff checks passed.

Windows coverage repaired fixture launchers, PATH/drive/line-ending assumptions,
PowerShell selection and bounded EBUSY cleanup. The long PR lifecycle scenario
received a Windows-only 60-second budget and completed in 17.4 seconds. Native
CUA and PostgreSQL authority CI passed on all platforms. One Windows database
startup hook exceeded 10 seconds; its failed job passed on one bounded retry.
Production launching, authorization checks and timeouts are unchanged.

The real bundled-editor browser passed cold usability, retained reopening and
transient renewal, including typing, saving and worker-file verification.
Onboarding/mode races needed one bounded retry each (#2096/#2102). Cleanup
reported zero sockets; shutdown limitations remain #2098/#2099. The full
standard check reached the existing server baseline: 1,409 passed, 74 failed,
70 skipped. Every failure name also appeared on unchanged main (#2106). CUA
protocol/crypto/worker/integration/app groups passed (136 / 25 / 732 / 244 / 313;
three skips). The full standard check is not green.

## Milestone 6

Based on merged M5 (`411a20100`). Split the 8,771-line app API into 33 domain
modules and a 513-line compatibility export facade. All 450 public exports
remain available from the original import path. Domain imports have no cycles;
basic worker/project reads are separated from management/decryption paths.
Shared caches retain one owner and the original server/user/key namespaces.
Requests, errors, encryption and session identity continue using the existing
shared infrastructure. Bound request behavior now belongs to `api-client`.

Supporting AST inspection verified all 501 original declarations retain their
bodies. The boundary and network audits now inspect the actual domain modules
and shared request implementation, including nested domains, rather than only
the facade. The generated route inventory remains current.

Validation:

- App source types passed; the original API baseline and post-extraction runs
  each passed 57 tests across eight files.
- Full app suite: 3,010 passed, three existing skips. Three new domain-state
  tests passed separately, covering cross-client metadata coalescing,
  component authorization failure isolation, fresh resolution after server or
  owner replacement, compatible error classes and failed-target eviction.
- The final CI selection passed 76 tests across 14 files. Five source/path
  tests verify audits see nested implementations/shared requests and do not
  silently accept missing source files.
- Real bundled-editor browser: cold usability, retained reopening and transient
  renewal all passed, with typing/save/worker-file assertions. One bounded
  onboarding and mode retry each was needed (#2096/#2102). The process exited
  zero and cleanup reported zero sockets. Vite logged caught EPIPE messages
  while fixture sockets closed; shutdown behavior remains #2098/#2099.
- Boundary/network audits pass. The complete standard check retry reached the full server baseline: 1,409
  passed, 74 failed, 70 skipped. Every failure name also appears on unchanged
  main (#2106). The full standard check is not green.

A dedicated Windows/macOS/Linux workflow runs app types, source-boundary audits
and the API/domain/encryption suites independently. Browser results above are
local darwin-arm64 against verified bundled Code `ba05010e28f2`.

The first API CI run passed all 76 behavioral tests on all three platforms.
Windows exposed an existing inventory formatter that emitted backslashes for
repository source filenames, making the canonical route inventory appear
stale. Repository inventory paths now normalize to forward slashes; audit
assertions and canonical inventory contents remain intact.

Seven additional dependency scans emitted the same OS-specific source names.
They now share a canonical source-path formatter with repository inventory and
API/server source corpora. A regression checks Windows repository names and the
existing policy-template exception against canonical paths. All content and
owner classification checks remain enabled.

M6 merged as `8210ab05f`. API domains (run 38589380948), worker commands
(38589380915), and native CUA/PostgreSQL (38589381072) all passed their final
Windows/macOS/Linux jobs. Primary synchronized; the owned worktree was archived
after preserving 43 evidence files and moving the stopped disposable runtime to
private storage outside the checkout.

## Milestone 7A: Event and state boundaries

Based on merged M6 (`8210ab05f`). This is the first independently mergeable
runtime slice; milestone 7 remains in progress.

Eight focused modules now own event DTOs, runtime state/options, existing
resource limits, shared event values, bounded command output, event/history
normalization, streaming/coalescing, and workspace snapshots. The original
`app-server` path retains all 107 public export names. Supporting AST comparison
finds all 261 original declarations unchanged, including the complete runtime
class. Active state objects, callbacks, timers, resource limits and notification
ownership retain their original identities and order.

Two live fake-runtime RPC characterizations exercise burst text/command output
through authoritative completion and shutdown with pending coalescing timers.
Completion waits for an observed provisional message before the fixture releases
the native turn boundary. Shutdown preserves the existing immediate commentary
flush and prevents subsequent timer emissions. Fixture options now satisfy the
actual typed runtime contract.

Validation:

- Original full worker baseline: 2,615 passed, 133 existing skips.
- Both new characterizations passed before extraction (seven goal tests total),
  including the final typed, observation-gated fixture against original source.
- Worker source and strict goal-test typechecks pass. All original declaration
  bodies and facade export names match.
- Focused runtime selection: 259 passed, 19 existing native-bundle opt-in skips
  across 16 files. With the existing pinned `codex-cli 0.160.1` executable,
  all 96 tests across eight opt-in files passed: actual queue/GUI/TUI execution,
  Stop and fresh successor authority, preparation, replacement and inherited
  settings, MCP sessions, history and thread observation. These tests used local
  synthetic model providers and disposable native homes; computer-input cases
  were not enabled.
- First full post-extraction run: 2,615 passed, 133 skipped, two failures outside
  the extracted code (Chromium configuration recovery timeout and a missing
  permission journal event). A separate rerun passed all 21 tests in those two
  files and the goal fixture. The final full rerun passed 2,616, skipped 133 and
  failed one Code supervisor child-PID fixture wait. Its separate rerun passed
  all 76 tests. These full runs are not passes. Reproduction, uncertainty and
  automated acceptance are recorded in [#2111](https://github.com/ArcaneArts/Cantrip/issues/2111),
  [#2112](https://github.com/ArcaneArts/Cantrip/issues/2112) and
  [#2113](https://github.com/ArcaneArts/Cantrip/issues/2113); no causal link to this
  unchanged-body refactor is established.
- Actual bundled-editor browser: cold usability, retained reopening and transient
  renewal passed, including typing/save/worker-file assertions. One onboarding
  and mode retry each was needed (#2096/#2102). Runner exit zero, zero remaining
  sockets. Existing shutdown defects #2098/#2099 remain: the worker needed the
  fixture's bounded kill fallback and the server exited one during retirement.
- Standard `pnpm check`: the default Xcode linker rejected the unaccepted host
  license. The Command Line Tools retry ran through the full server suite:
  1,409 passed, 74 failed, 70 skipped. All 81 failure/suite names match the
  previous M6 baseline (#2106); no new failure name appeared. The full standard
  check is not green. Diff and formatting checks pass.

A dedicated Windows/macOS/Linux workflow runs native RPC, turn streaming,
subagent ownership, cancellation, preparation, interactions and history suites
independently of the typecheck. The CUA workflow now follows the extracted
Codex module tree as well as the original entry point.

M7A merged through #2114 as `fbea68284`; Primary synchronized and the owned
worktree was archived after preserving 41 evidence files. Runtime CI passed on
Linux/macOS. Windows passed 258 tests and failed one pre-existing fixture's Unix
connection-path expectation: the actual argument was the correctly resolved
Windows absolute path. A fresh isolated follow-up uses one native temporary
connection filename for input and both exact expectations. Credential rotation,
reload ordering and binding-generation assertions remain unchanged. Command
handler and native CUA/PostgreSQL CI passed on all three OSs. The path fixture
follow-up merged through [#2115](https://github.com/ArcaneArts/Cantrip/pull/2115)
as `7f9151fe1`; its runtime matrix passed on every OS. Windows command CI hit an
unchanged PowerShell replay marker timeout and cleanup failure, then passed on
one failed-job retry. The reproducible entry point, uncertainty and automated
acceptance remain tracked in [#2116](https://github.com/ArcaneArts/Cantrip/issues/2116).
Primary synchronized and both owned worktrees were archived.

RPC/process transport, turn lifecycle/cancellation, subagent reconciliation, and
cleanly separable interaction/authentication ownership are the remaining M7
slices. No new product behavior or performance improvement is claimed by 7A.

## Milestone 7B: RPC and process transport

Based on merged #2115 (`7f9151fe1`). A dedicated request owner now holds pending
RPC calls, monotonically allocated IDs, private-inference response classification,
timeouts and rejection on exit. Narrow typed callbacks obtain current runtime
identity, diagnostic secrets and provider flags. The orchestrator retains method
compatibility checks, authentication, native generation/catalog state and the
existing child/socket fences.

Protocol parsing/native RPC errors and process endpoint/WebSocket I/O now live
in separate modules. Startup still installs the child before awaits, accepts an
endpoint on either output stream, publishes it before WebSocket connection, and
installs the socket/native generation before initialization. Helpers return the
original startup promises directly. Listener order, timeouts, bounded diagnostics
and the distinct socket-close/process-exit cleanup paths remain intact.

All 107 facade export names are preserved. Supporting AST comparison finds all
72 other top-level declarations and 171 of 176 class methods unchanged; the five
changed methods delegate RPC/process work or report its pending count. The
extracted module graph has no runtime cycle. The entry point shrinks from
9,791 to 9,539 lines; no performance gain is claimed.

Eight correlation characterizations cover concurrent reverse-order/string IDs,
native error identity/details, private response redaction (including a late
response after timeout), unmatched/duplicate responses, deadline handling,
pending-call cancellation and monotonic IDs across close, and compatibility
rejection before allocation. Two process cases exercise exit before listening
and an endpoint announced on stderr. All 17 tests in the two affected fixtures
pass against both original and extracted implementations; strict test types
pass. Runtime CI includes the new correlation fixture independently of types.

Validation:

- Full worker suite: 2,627 passed, 133 existing skips across 299 files.
- Pinned native runtime: 96 passed across eight files, using disposable homes
  and local synthetic providers; computer-input cases were not enabled.
- Actual bundled-editor browser: cold usability, retained reopening and
  transient renewal passed with typing/save/worker-file assertions. One bounded
  onboarding and mode retry each was needed (#2096/#2102). Runner exit zero,
  zero sockets and no remaining fixture processes. Existing shutdown limits
  #2098/#2099 remain; the worker used the bounded kill fallback and the server
  exited one while retiring the fixture.
- Worker source and strict test types pass; diff and formatting checks pass.
  The standard check with Command Line Tools reached the same server baseline:
  1,409 passed, 74 failed, 70 skipped. All 81 failure/suite names match M7A/M6
  (#2106); no new failure name appeared. The full standard check is not green.

Turn lifecycle/cancellation, subagent ownership/reconciliation and clean
interaction/authentication boundaries remain for later M7 slices.
