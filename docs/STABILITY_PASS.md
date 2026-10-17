# Cantrip stability pass

Started 2026-10-13 from `692f05dcd`. Each milestone uses an isolated
`codex/` branch and worktree, a squash auto-merge PR, observed merge, and cleanup.
Tests run independently of metadata audits. A skipped check is never a pass.

| Milestone                                 | Status    | Branch / PR                                                                                                                                                                                                                                                                                      | Evidence                                                                                                   |
| ----------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 1. Lease renewal and reconnect scheduling | Merged    | `codex/stability-lease-recovery` / [#2092](https://github.com/ArcaneArts/Cantrip/pull/2092)                                                                                                                                                                                                      | Three regressions fixed; 135 app + 25 worker tests pass; Windows/macOS/Linux CI passed.                    |
| 2. Shared editor lifecycle and readiness  | Merged    | [#2093](https://github.com/ArcaneArts/Cantrip/pull/2093)                                                                                                                                                                                                                                         | Late readiness, retained frames, startup stages, and cancellation.                                         |
| 3. Browser recovery harness               | Merged    | [#2107](https://github.com/ArcaneArts/Cantrip/pull/2107)                                                                                                                                                                                                                                         | Actual bundled editor, isolated services, automated failure injection and usable-editor assertions.        |
| 4. Measured editor loading                | Merged    | [#2108](https://github.com/ArcaneArts/Cantrip/pull/2108)                                                                                                                                                                                                                                         | Comparable cold/warm/recovery measurements; implement only demonstrated improvements.                      |
| 5. Worker command dispatch                | Merged    | [#2109](https://github.com/ArcaneArts/Cantrip/pull/2109)                                                                                                                                                                                                                                         | Typed feature handlers with explicit ownership and dependencies.                                           |
| 6. App API modularization                 | Merged    | [#2110](https://github.com/ArcaneArts/Cantrip/pull/2110)                                                                                                                                                                                                                                         | Domain clients with compatible public exports and shared security infrastructure; all three OSs passed CI. |
| 7. Codex runtime decomposition            | Delivered | [#2114](https://github.com/ArcaneArts/Cantrip/pull/2114), [#2115](https://github.com/ArcaneArts/Cantrip/pull/2115), [#2117](https://github.com/ArcaneArts/Cantrip/pull/2117), [#2119](https://github.com/ArcaneArts/Cantrip/pull/2119); [#2120](https://github.com/ArcaneArts/Cantrip/pull/2120) | Events, transport, execution ownership and interaction/auth recovery extracted in sequential slices.       |

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

M7B merged through [#2117](https://github.com/ArcaneArts/Cantrip/pull/2117)
as `6cd618537`; Primary synchronized and its owned worktree was archived.
Runtime and command-handler CI passed on Windows, macOS and Linux. Native
CUA/PostgreSQL CI passed on Linux/macOS and the PostgreSQL job. Windows hit the
same `model-configuration-api` database-startup hook timeout on both attempts;
this also occurred in M5. The Windows provider fixture assertions and subsequent
native checks remain unverified on this commit. The bounded skip and automated
follow-up are recorded in [#2118](https://github.com/ArcaneArts/Cantrip/issues/2118).
No check was disabled or bypassed.

## Milestone 7C: execution and descendant ownership

Based on merged #2117 (`6cd618537`). `CodexExecutionOwnership` now owns the seven
maps connecting active turns, roots, known/orphan descendants and early native
child starts. Its 32 moved methods cover turn binding/release, cancellation,
notification targeting, ancestry association, bounded history reconciliation
and descendant completion. The runtime orchestrator retains configuration,
authentication, transport and final result preparation.

Four narrow callbacks supply RPC dispatch, method availability, current
canonical-history policy and interaction retirement. The history policy is
read after the awaited native snapshot, as before. Read-only map views retain
original object identity for streaming and admission checks. Tracking and map
mutations belong to the owner. Exit still revokes root/child authority before
RPC rejection and interaction cleanup; active rejection/telemetry cleanup
happens afterward. Close retains its distinct cleanup order.

The root facade retains its two public ownership methods and six private
delegates used by orchestration and existing regression barriers. Delegates
return the original promises directly. All 107 public exports remain intact.
Supporting AST comparison finds all 32 moved method bodies unchanged after the
four explicit dependency substitutions, all 144 other method bodies unchanged
after delegation substitutions, and all 65 other top-level declarations
unchanged. The extracted runtime module graph has no cycle. The entry point
shrinks from 9,539 to 8,547 lines; no performance improvement is claimed.

Validation:

- The same 94 lifetime, subagent, admitted-execution and process/goal-streaming
  tests pass before and after extraction. Existing barriers cover stale root
  completion, native continuation, early child starts, nested ancestry, Stop,
  replacement and sibling authority.
- Final full worker suite: 2,627 passed, 133 existing skips across 299 files.
  The first run caught two GUI permission tests using a removed private query
  seam; its thin delegate was restored, and that fixture now runs in runtime CI.
  An unchanged outbox cross-process case also hit its 15-second timeout once.
  All 24 tests in those two files passed in isolation, and the final full run
  passed without changing the outbox implementation or timeout.
- Pinned native runtime: 96 passed across eight files, with local synthetic
  providers and disposable homes; computer-input cases were not enabled.
- Actual bundled-editor browser: cold usability, retained reopening and
  transient renewal passed with typing/save/worker-file assertions. One bounded
  onboarding and mode retry each was recorded (#2096/#2102). Runner exit zero,
  zero remaining sockets and no fixture processes. Existing shutdown defects
  #2098/#2099 required bounded worker termination; server retirement exited one.
  Detailed browser evidence was preserved before moving stopped disposable
  state outside the worktree.
- Worker source types, diff and formatting checks pass. The standard check with
  Command Line Tools passed native checks, scripts, source types, focused
  integration and shared packages, then reached the same full-server baseline:
  1,409 passed, 74 failed, 70 skipped. All 81 failure/suite names match M7B
  (#2106); no new failure name appeared. The standard check is not green.

Interaction/authentication boundaries remain a separate M7 slice.

M7C merged through [#2119](https://github.com/ArcaneArts/Cantrip/pull/2119)
as `b5e5c0a19`. Runtime CI passed 272 tests on each of Windows, macOS and Linux;
native CUA and PostgreSQL CI also passed on every platform. Primary synchronized
and the owned worktree was archived after preserving 30 local evidence files.
The recurring Windows database fixture from #2118 passed on this commit; the
previous failures remain recorded rather than erased by the successful run.

## Milestone 7D: interactions and authentication recovery

Delivered through [#2120](https://github.com/ArcaneArts/Cantrip/pull/2120) from
`codex/stability-codex-interactions`.

Based on merged #2119 (`b5e5c0a19`). A dedicated interaction owner holds pending
native replies, admitted reply waiters, plan questions, publication retries and
expiry. Five explicit callbacks provide current execution lookup, notification
ownership, transport send, GUI dispatch and runtime session identity. Native
resolution notifications and exit cleanup use the same ledger as GUI and
console responses. Consume-before-send, exact numeric/string request IDs,
admission generation, object identity and callback order remain unchanged.

Portable ChatGPT session state and the shared in-flight refresh/login attempt
now belong to an authentication recovery owner. Initial login and transport
replacement remain in the orchestrator, which installs/retires the same session
object at the same boundaries. Expiry still permits one forced refresh and one
request retry; unrelated failures retain their original identity. Current token
access and diagnostic redaction use narrow callbacks. No additional retry,
session reset or asynchronous wrapper was introduced.

Interaction wire parsing/response conversion now lives in a separate protocol
module, with all six original public names re-exported by the facade. Provider
log context shares its existing origin-only representation from provider-config.
All 107 facade exports remain intact. Supporting AST comparison preserves 15
moved methods, 137 remaining methods after explicit delegation substitutions,
61 other top-level declarations, supported-request dispatch, native-resolution
handling and exit cleanup. No scoped runtime cycle was introduced. The entry
point shrinks from 8,547 to 7,788 lines; no performance gain is claimed.

Three new characterization cases exercise concurrent expired requests sharing
one lease/login, refreshed-token redaction, exactly one retry, unrelated error
identity and recovery after a failed lease request. All four tests in the
provider portability fixture pass against the original implementation, including
the final fixture updated to the actual typed provider/turn contract. Existing
interaction tests cover native/GUI reply races, typed IDs, operation cancellation,
publication retries and delayed notifications. Runtime CI also includes the
external-auth helper and publication retry suites independently of source types.

Validation:

- 180 focused tests across eight files pass after extraction. Worker source and
  strict provider-fixture typechecks pass. Formatting and diff checks pass.
- Final full worker suite: 2,630 passed, 133 existing skips across 299 files.
- Pinned native runtime: 96 passed across eight files, using local synthetic
  providers and disposable homes; computer-input cases were not enabled.
- Actual bundled-editor browser: cold usability, retained reopening and
  transient renewal passed with typing/save/worker-file assertions. One bounded
  onboarding and mode retry each was recorded (#2096/#2102). Runner exit zero,
  zero remaining sockets and no matching fixture processes. Bounded worker
  termination and server retirement exit one reproduce #2098/#2099; caught Vite
  EPIPE messages accompanied socket shutdown. Evidence was preserved before
  moving stopped disposable state outside the worktree.
- The standard check with Command Line Tools passed native checks, scripts,
  source types, focused integration and shared packages, then reached the same
  full-server baseline: 1,409 passed, 74 failed, 70 skipped. All 81 failure/suite
  names match M7C (#2106), with no new failure name. The standard check is not
  green; independent worker/native/browser checks completed successfully.

## Acceptance scope and remaining follow-ups

The seven workstreams have implementation and executable acceptance evidence.
Passing focused checks do not erase the failed or blocked browser cases or the
full-server baseline. No release or deployment is part of this pass.

| Requirement                  | Evidence and disposition                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lease and reconnect recovery | M1 fake-clock/client/worker regressions cover transient success, original expiry, explicit denial, cancellation/replacement, concurrent consumers, jitter and sibling isolation. M3/M4 and later browser runs verify real renewal, expiry/revocation and dirty-buffer behavior.                                                                                                       |
| Shared editor readiness      | M2 component regressions cover early/late/hidden/stale readiness, cancellation, switching and retained frames; the actual patched editor is built and verified. M3 exercises delayed readiness and service-worker/worker restarts. Actual repository worktree cycling remains #2105.                                                                                                  |
| Real browser fault coverage  | M3's results matrix records each requested scenario, logs, durations, real input/save/disk assertions and cleanup. Carrier/preview, server/Pong and route replacement failures remain #2100/#2101/#2103. Logical congestion and repository worktree fixtures remain #2104/#2105. The browser tool's input limitation is recorded separately from successful automated Chromium input. |
| Measured loading             | M4 commits repeatable parser and actual-browser measurements, variability and GC-controlled diagnostics. One redundant chunked-body copy is removed. No overall startup or page-heap gain is claimed; streaming and shared caching are explicitly deferred for the documented correctness/measurement reasons.                                                                        |
| Worker commands and app API  | M5 preserves 206 command bodies through typed dependencies and adds 19 characterization/integration tests. M6 preserves 450 exports and shared request/error/encryption/identity/cache owners across 33 domains. Types, domain/integration/browser tests and three-platform CI are recorded above.                                                                                    |
| Runtime responsibilities     | M7A/B/C/D cover event normalization/streaming, RPC/process transport, turn cancellation, subagent ownership/reconciliation and interactions/auth recovery in sequential slices. Characterization runs precede extraction; full worker, real native and browser runs validate the final implementation.                                                                                |

Follow-ups require automated local or CI reproduction and acceptance:

- Browser setup and settings races: [#2096](https://github.com/ArcaneArts/Cantrip/issues/2096), [#2102](https://github.com/ArcaneArts/Cantrip/issues/2102).
- Graceful service retirement: [#2098](https://github.com/ArcaneArts/Cantrip/issues/2098), [#2099](https://github.com/ArcaneArts/Cantrip/issues/2099).
- Editor recovery defects: [#2100](https://github.com/ArcaneArts/Cantrip/issues/2100), [#2101](https://github.com/ArcaneArts/Cantrip/issues/2101), [#2103](https://github.com/ArcaneArts/Cantrip/issues/2103).
- Missing isolated acceptance fixtures: [#2104](https://github.com/ArcaneArts/Cantrip/issues/2104), [#2105](https://github.com/ArcaneArts/Cantrip/issues/2105).
- Existing server failures: [#2094](https://github.com/ArcaneArts/Cantrip/issues/2094), [#2095](https://github.com/ArcaneArts/Cantrip/issues/2095), [#2106](https://github.com/ArcaneArts/Cantrip/issues/2106).
- Intermittent local/native/Windows fixtures: [#2111](https://github.com/ArcaneArts/Cantrip/issues/2111), [#2112](https://github.com/ArcaneArts/Cantrip/issues/2112), [#2113](https://github.com/ArcaneArts/Cantrip/issues/2113), [#2116](https://github.com/ArcaneArts/Cantrip/issues/2116), [#2118](https://github.com/ArcaneArts/Cantrip/issues/2118).

Settings-search baseline #2091 and early peer-ready rejection #2097 were fixed
in M3 and are closed. Passing later runs of intermittent failures do not close
their follow-ups or rewrite earlier failures as passes.

Detailed local logs, screenshots, stopped disposable runtimes and the reusable
Cargo build cache are intentionally retained under
`~/.codex/stability-pass/20261013/`. Disposable runtime archives have private
permissions; their generated account credentials and databases are not committed.
The verified Code/native bundles in Primary are retained for repeatable QA.
Milestone worktrees are archived after observed merge and evidence preservation;
unrelated worktrees and user-owned services remain untouched.

## Issue fix pass: October 17, 2026

The initial open queue is #2094, #2095, #2118, #2116, #2113, #2111, #2098,
#2099, #2096, #2102, #2112, #2100, #2103, #2101, #2104, #2105 and #2106, in
that intended order. Each issue receives an independent worktree and PR.
Blocked work remains open with reproduction evidence and a next step; a later
passing retry alone does not resolve an intermittent defect. The earlier
stability report remains a record of the observations made at that time.

### #2094: current layout fixtures

PR: [#2121](https://github.com/ArcaneArts/Cantrip/pull/2121).
Merged as `caa00b5be`; issue closed automatically. Primary synchronized and
the owned worktree was archived after preserving the evidence.

On base `9f3f7fad7`, the two affected server files reproduce both obsolete
layout assertions plus the separate #2095 CLI routing failure (29 passed,
three failed). Overview is a project page and rejects tab creation; the wire
layout uses `panes`, not the retired `groups` property.

The singleton fixture now asserts Overview's rejection without a layout
mutation, then opens and focuses every supported built-in tab. Tasks provides
the cross-project identity and launcher-pin persistence assertions. The test
also checks that Overview has no tab launcher and pin changes leave the layout
revision unchanged. The encrypted Task fixture parses the canonical wire schema,
asserts Task creation leaves the entire layout unchanged, and checks membership
using the supported surface ID. Its remaining encrypted draft, execution and
retry assertions are retained. No production contract changed.

Validation on `codex/issue-2094-layout-fixtures`:

- Both affected tests pass independently (two passed, 30 filtered out).
- Both complete files: 31 passed, one failed; the remaining failure is #2095.
- Server source typecheck and formatting checks pass.
- The standard `pnpm check` passes its audits, native checks, source types and
  focused/shared suites, then fails in the full server baseline: 1,409 passed,
  74 failed, 70 skipped. Both #2094 failure names are gone. Relative to M7D,
  unchanged fixtures additionally miss a DirectAttachmentCoordinator renewal
  callback and exceed the deferred native-permission test's five-second budget.
  These observations remain part of #2106; the broad check is not green.
- Independent runs of those two unchanged files pass all 37 tests on the
  branch; untouched main passes 36 and reproduces the renewal-callback failure.
  The native-permission timeout does not repeat in either focused run and
  remains an unresolved intermittent observation, not a claimed fix.

Local reproduction and validation logs are retained under
`~/.codex/issue-fix-pass/20261017/`. Other initial issues remain pending.

### #2095: exact CLI Run source routing

PR: [#2122](https://github.com/ArcaneArts/Cantrip/pull/2122).
Merged as `eeca0beab`; issue closed automatically. Primary synchronized and
the owned worktree was archived after preserving the evidence.

The named regression still fails on merged main `caa00b5be`: its setup prefers
the Beta project replica but expects Run definitions from Alpha. The current
source selection orders available registered Primary replicas by project
preference, then user default. CLI definitions intentionally use that shared
source regardless of the invoking worker's cwd; explicit runtime targets remain
separate, as documented in `RUN_CONFIGURATIONS.md`.

The fixture now checks both CLI callers against both project preferences. Each
operation must dispatch exactly one command to the expected worker and path,
and return the matching source worktree. A new rejection case supplies a real
worktree from another project and verifies 404, no worker dispatch and no durable
Run instance. Existing exact cross-worker Explorer, Terminal, Browser and
worktree operations remain asserted. No production routing changed.

Validation on `codex/issue-2095-cli-routing`:

- All 51 tests pass across placement, Run definitions, Run runtimes and CLI
  execution.
- Complete `pnpm network:acceptance` passes: 450 TypeScript and five focused
  native tests, plus topology/feature metadata checks. Its server group passes
  all 91 tests.
- The standard `pnpm check` passes audits, native checks, source types and
  focused/shared suites, then reaches 1,412 passed, 71 failed and 70 skipped in
  the full server baseline. No new failure name appears relative to #2094's
  check. The CLI routing failure is gone; the two unrelated intermittent cases
  did not repeat, which does not resolve them. The remaining baseline stays
  tracked in #2106, and the full check is not green.
- Formatting and diff checks pass. Logs and the failure-name comparison are
  retained with this issue's evidence.

### #2118: Windows model-configuration initialization budget

Implementation: [#2123](https://github.com/ArcaneArts/Cantrip/pull/2123), on
`codex/issue-2118-db-fixture-budget`. The PR records platform validation and
merge status.

The fixture, database connection implementation, migrations and lockfile on
base `eeca0beab` match the files in the failing Windows
[run 38604558879](https://github.com/ArcaneArts/Cantrip/actions/runs/38604558879).
That run records successful PGlite connections taking 11,069–13,421 ms and the
model-configuration `beforeAll` exhausting its implicit 10,000 ms limit. The
unmodified fixture passes locally on macOS; that does not invalidate the
measured Windows failure.

The initialization hook now has an explicit 30,000 ms budget. Individual test
deadlines, production startup behavior, configuration/authority assertions and
cleanup remain unchanged. The Windows native CI job additionally starts this
fixture in three fresh Vitest processes. Any failed run fails the job immediately;
these are repeated acceptance runs, not retries that discard failures. The
existing native three-platform and PostgreSQL jobs remain required evidence
before this issue is closed.

Three fresh local runs pass both assertions each time, with measured database
startup of 2,085, 2,089 and 2,215 ms. Formatting and diff checks pass. Broader
repository and platform outcomes are recorded in the linked PR and preserved
with the issue evidence under `~/.codex/issue-fix-pass/20261017/`.

Final #2118 outcome: PR #2123 merged as `23399dbe9` and the issue closed
automatically. [CI run 39065838183](https://github.com/ArcaneArts/Cantrip/actions/runs/39065838183)
passed on its first attempt at head `2a6e09e8c`: all three native platforms and
PostgreSQL passed. The three Windows repetitions passed both tests each, with
PGlite startup of 3,929, 3,721 and 3,632 ms. The standard check retained exactly
#2095's full-server baseline (1,412 passed, 71 failed, 70 skipped; the same 78
failed test/suite labels). Primary was synchronized and the owned worktree
archived after saving the evidence.

### #2116: deterministic terminal replay and cleanup ownership

Implementation: [#2124](https://github.com/ArcaneArts/Cantrip/pull/2124), on
`codex/issue-2116-terminal-fixtures`. Platform acceptance and merge status are
recorded in the linked PR.

The original Windows failure emitted only the PowerShell banner before the
marker deadline, then failed directory removal with `EBUSY`. The fixture,
production terminal manager and lockfile remain unchanged between that failing
commit and base `23399dbe9`. The original complete file passes locally on macOS
(10 tests), which does not disprove the observed Windows race.

The replay fixture now launches a controlled command through the actual PTY.
The command produces the first marker itself, waits for input, then produces
the delta. Input contains neither marker, so terminal echo cannot satisfy the
assertions. Canonical snapshot, replay-before-ready ordering, singleton
attachment and exactly-once delivery to both subscribers remain checked.

Every fixture manager registers both opened terminals and configured services.
Shared cleanup closes all managers and waits for actual PTY exit before removing
any directory, retaining bounded filesystem retries. A deliberately thrown
failure before replay assertions proves an attached terminal and a background
service both exit before either directory is removed, both attachment promises
finish, and the original failure is preserved. Production startup and input
handling are unchanged.

The changed file passes all 11 tests locally in its first run and three fresh
repetitions. An additional strict fixture
compilation reports the same pre-existing diagnostics as the original file;
normal source typechecking and runtime acceptance remain independent. The
Windows command workflow runs the complete terminal file in three additional
fresh processes and stops on any failure. Repeated Windows execution and the
existing three-platform command matrix must pass before closing this issue.
Broader check results, repetition logs and CI evidence are retained under
`~/.codex/issue-fix-pass/20261017/` and recorded in the linked PR.

The first Windows acceptance run exposed a duplicate-close path introduced by
shared teardown: the original test requested a PTY close immediately before
`afterEach` requested it again, before its exit callback. Node-pty reported
`AttachConsole failed` and Vitest lost the worker process. Redundant end-of-test
closes are removed; existing `finally` paths use the same awaited cleanup.
Assertions that explicitly exercise service closure retain their observed-exit
wait. The failed run remains evidence, and the corrected head requires a fresh
platform run before merge.

Final #2116 outcome: PR #2124 merged as `6b96708e6`; the issue closed
automatically. The corrected head `f3cbaa9e9` passed both the
[command](https://github.com/ArcaneArts/Cantrip/actions/runs/39067903070) and
[Codex runtime](https://github.com/ArcaneArts/Cantrip/actions/runs/39067903094)
matrices on all three platforms. Windows passed all 154 enabled command tests
and three fresh terminal runs (three passed, eight existing platform skips in
each). The final local fixture and three repetitions passed all 11 tests each.
The full server check retained the same 78 failed test/suite labels as #2118:
1,412 passed, 71 failed and 70 skipped. Node-pty's console enumeration helper
still logs `AttachConsole failed` after console retirement; actual PTY exit,
directory removal and runner completion pass. Primary was synchronized and the
owned worktree archived after preserving all evidence.

### #2113: failed-startup process identity before PID publication

Implementation: [#2125](https://github.com/ArcaneArts/Cantrip/pull/2125), on
`codex/issue-2113-startup-process`. The PR records validation and merge status.

The unchanged supervisor suite passes all 76 tests on main. A fixture-only
initialization barrier before PID publication deterministically reproduces the
reported failure: the real startup operation fails after its 500 ms readiness
deadline, but the old test waits two seconds for a PID file that cannot appear.
The assertion therefore never verifies retirement or retry.

The fixture now observes the actual guarded launch handle while calling through
to the real process launcher. Both unhealthy HTTP and deliberately delayed
initialization must report the original authenticated-readiness failure, emit
an actual exit before rejection, leave the failed session unavailable and allow
a healthy retry only after that exit. A real process liveness check verifies
the failed PID is gone; on POSIX, its complete process group must also be gone.
The delayed case proves PID publication did not happen. The healthy retry must
use a different process and produce the exact spawn/exit/spawn order.

No production launch, authorization or readiness deadline changes. Both focused
cases pass locally. The complete supervisor and worker suites and standard
repository check are run independently; the existing command workflow also
executes both cases on Linux, macOS and Windows. Final counts and evidence are
recorded in the issue PR and under `~/.codex/issue-fix-pass/20261017/`.

Windows acceptance passed both new cases, but the full supervisor run exposed
two other startup fixtures whose successful launches exhausted a 500 ms
override: rollback recovery and repeated retained prewarm. Their existing
behavior assertions remain unchanged, and they now use the shared fixture's
normal 3,000 ms startup budget. The failure-retirement regression retains its
intentional 500 ms deadline; no production timeout changes. The failed Windows
run is retained and a fresh full matrix validates the correction.

A follow-up local full-suite run also observed a 500 ms timeout in cached-profile
recovery, while successful launches elsewhere in that same run took 509–1,520
ms. This third behavior fixture now uses the same normal 3,000 ms startup
budget. The intentional deadline regression and other fixture budgets remain
unchanged. Full local and platform suites are repeated for the corrected head.

Final #2113 outcome: PR #2125 merged as `cb2c91faa`; the issue closed
automatically. All nine jobs passed on final head `1d354081b` in the
[command](https://github.com/ArcaneArts/Cantrip/actions/runs/39069219934),
[editor recovery](https://github.com/ArcaneArts/Cantrip/actions/runs/39069219907)
and [runtime](https://github.com/ArcaneArts/Cantrip/actions/runs/39069219968)
workflows. Windows passed all 92 supervisor/bridge tests and 83 app contract
tests, including both startup regression cases and all three healthy-recovery
fixtures. The local complete supervisor suite passed 77 tests; the complete
worker suite passed 2,632 with 133 existing skips. The standard check retained
the same 78 failed server test/suite labels: 1,412 passed, 71 failed and 70
skipped. Primary was synchronized and the owned worktree archived after
preserving evidence.

### #2111: exclusive capture persistence before evidence acknowledgement

Implementation: [#2126](https://github.com/ArcaneArts/Cantrip/pull/2126), on
`codex/issue-2111-evidence-persistence`. The PR records final validation and
merge status.

A controlled filesystem/client interleaving reproduces the reported `ENOENT`
at the original `persist` read. Capture put its event in the retry queue before
its first immutable write completed. An already running pump could write the
same event, publish it, receive acknowledgement and remove it while capture
resumed from `EEXIST` and tried to read it. The reproducer uses actual immutable
file creation, acknowledgement and removal; no timing fallback makes it pass.

Capture now enters the retry queue only after persistence fails. The queue
retains the exact original event and ciphertext. Active capture remains tracked
by the existing write set, which shutdown awaits. Strict duplicate comparisons,
encryption ownership checks, acknowledgement and durable permission recovery
remain intact.

The regression proves one immutable write, one publication and actual removal
without an error. Additional cases cover a failed write's byte-identical retry,
genuinely missing/malformed/changed committed records and owner/server changes
during encryption. Missing or corrupt committed evidence still rejects and
never publishes. All 23 delivery and permission-recovery tests pass locally;
strict compilation of the changed fixture also passes. The existing runtime
workflow now runs both suites on Linux, macOS and Windows and triggers on the
affected production files. Full worker and standard repository checks run
independently; their results and platform/merge evidence are recorded in this
issue's PR and under `~/.codex/issue-fix-pass/20261017/`.

Windows acceptance exposed a separate blocker in the same persistence helper:
recursive `mkdir` returned a namespaced `\\?\` path, while the ancestor loop
walked the ordinary caller path. It reached `C:\` without matching the
namespaced boundary and repeated forever. A real Windows filesystem diagnostic
captured both paths and the repeated root. The new evidence suites timed out;
the older runtime suite independently passed all 281 enabled Windows tests.

After performing the actual `mkdir`, Windows now returns before the directory
flush loop, matching the existing Windows no-op in `flushHistoryDirectory`.
POSIX directory durability and file-content flushing remain unchanged. Direct
filesystem tests cover ordinary and Windows namespaced nested paths, existing
contents and an occupied-file creation error. The temporary diagnostic is
removed; all evidence suites run as a separate bounded CI step. This correction
requires a fresh complete platform run before merge.

The command matrix also reproduced #2116's original marker timeout with its
unchanged PowerShell replay fixture. That issue was reopened with the failed
run and placed back in the queue. A diagnostic retry passed; this does not
establish a fix for #2116. Its follow-up remains a separate cycle.
