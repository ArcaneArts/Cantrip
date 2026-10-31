# Rust server replacement

The Git/worktree/Run milestone broad `pnpm check` exited 1 with 1,633 server
tests passing, two failing and 57 skipped. Both failures were freshly reproduced
on clean Primary `b04530e3c`: the pooled-provider assertion in
`local-foundation.test.ts:7218` and the missing `getModelRuntimeByRoute` mock in
`terminal-managed-session.test.ts`. This does not make the broad check green.
Reports: `.qa/rust-server/git-milestone-check-v1-exit.json` and
`git-milestone-baseline-server-v1.log`. PR #2332's conversation-view changes were
integrated by regenerating the combined contracts rather than replacing either
feature set.

Status: **implementation in progress; not a deployable replacement**.

The queue runtime milestone's fresh `pnpm check` exited 1 with 1,662 server
tests passing, one failing and 57 skipped. The provider-pooling assertion at
`local-foundation.test.ts:7218` also fails in a fresh focused run on clean
Primary `038a7226f`. All 40 Rust library tests and strict all-target Clippy pass.
Reports use `.qa/rust-server/native-runtime-*`; the Primary reproduction is
`native-runtime-root-baseline-v1.log`. The broad check is not green.

The native command milestone's current-main `pnpm check` exited 1: 1,645 server
tests passed, 18 failed and 57 were skipped. One failure is the pooled-provider
assertion at `local-foundation.test.ts:7218`; the other 17 are unchanged 5-second
test timeouts. A fresh run of the eight failing files on clean Primary
`a1b125544` reproduced 15 failures, including the provider assertion; the other
three timeout cases passed there. The full app suite passed 4,112 tests with one
timeout, and the full worker suite passed 2,558 with four timeouts. Those exact
five cases subsequently passed on both the milestone branch and clean Primary
with one test worker and their original timeouts. The app production build,
current native/worker wire comparisons, Rust formatting and strict all-target
Clippy passed. Root Prettier checking still fails on 12 unchanged files; the
same 12 failures were reproduced on clean Primary. These results do not make
the broad checks green. Logs and exit records use the
`.qa/rust-server/native-kernel-*` prefix and are preserved with milestone evidence.

## Native command kernel and protected internal APIs

The additive native kernel implements command admission, immutable receipts,
preparation/dispatch, observed turns, logical continuations and completion
records, execution lanes/leases, encrypted prompts and managed queue authority.
Visible/protected interaction storage, accepted worker replies, expiry,
permission state/evidence and transaction-bound Agent/Task message and plan
writes retain the Node repository's transaction and idempotency behavior.

Native HTTP now handles admission, bind-preparation, dispatch, protected events,
permission transitions, pending requests, continuations and settings evidence.
Settings refresh/update/observation, account defaults and native model inventory
also execute natively. Real HTTP/Live comparisons cover native PGlite, private
PostgreSQL and external PostgreSQL in anonymous, password and account modes,
using the unchanged worker transport and production endpoint encryption helpers.
Stored command requests and native settings evidence decrypt using their
original associated data and retain the keyed worker digest. PostgreSQL fault
injection additionally verifies event rollback, actual row-lock waits and
historical Task chat/project notification ordering.

The coordination HTTP comparisons also reject missing, mismatched,
insufficient-scope, revoked and expired worker credentials for each new route.
In account mode, a second account enrolls a real worker and cannot access the
first account's command or Chat state. Rejected calls publish no Live events.

The next runtime layer includes a native receipt notification/wait primitive.
It retains notices received during a database read, polls durable receipts every
750 milliseconds when a notice is lost, preserves original UTF-16 Chat keys,
and removes subscriptions on completion or cancellation. Fifteen controlled
read/timer scenarios compare the unchanged Node waiter directly with Rust,
including concurrent abort/read outcomes and multiple listeners. The public
native method reads the actual managed queue repository. Receipt and queue HTTP
routes still require their real GUI dispatch and recovery consumers.

Native GUI queue preparation, mutation and lookup now use those same durable
repositories. Twenty GUI scenarios on each database compare original JSON
digests, explicit optimistic revisions, immutable replay and rejected receipts,
retained input after deletion, administrative input fences and tenant/placement
rejection with the unchanged Source helper. Their surrounding managed queue
corpus also retains restart checks and 20 same/mixed-runtime PostgreSQL races.
These helpers do not complete GUI turn dispatch or its HTTP consumers.

Native queue delivery now uses the durable notification repository and admitted
worker command bus. Its recovery group runs independently of notification
sweeps; each group has eight workers, retries retain their durable cursor, and
stop prevents late acknowledgment or defer. Twenty-four controlled scenarios
execute the unchanged Node service, including coalesced callers, errors at each
boundary, independently running recovery, early rejection with other workers
still active, and interval/stop behavior. Real repository/worker-wire comparisons
on all three storage modes also verify successful acknowledgment, no duplicate
delivery and a five-second defer after an actual worker rejection. Product
registration still requires the real GUI dispatcher; no production no-op
dispatch is supplied.

PR #2384's Windows native command job failed its first fresh GUI admission on
the original 1 MiB fixture thread with stack overflow (`3221225725`). The
`native_stack_diagnostic` workflow input runs that same repository suite under
MinGW GDB and retains native thread stacks/registers. It changes neither the
requested stack nor the suite's assertions and is separate from platform
acceptance. The optional `CANTRIP_FIXTURE_GDB` launcher affects only disposable
Rust repository fixtures; ordinary launches retain their existing command line.
The first debugger capture places the failure on the Rust caller during branch
lease acquisition while the PGlite engine thread is idle. The follow-up capture
measured 214,064 bytes retained by the native fixture dispatcher and 242,720 by
its outer dispatcher. The native selector now returns an individual boxed future
for each operation before it is polled. The original 1 MiB PGlite workload passes
locally with all 1,523 original cases plus 20 GUI cases. Windows run
`41226706489` now passes that same 1 MiB workload, including 1,337 snapshots and
10 reopen checks. The earlier full platform run separately failed an execution
target repository fixture with stack overflow. Run `41228493161` captured
373,760 bytes retained by the repository operation dispatcher and 235,232 by
its outer dispatcher while resolving a project target. Both selectors now
construct the selected future before polling it. All 431 original target cases
pass locally, with no cases removed or assertions changed. Windows run
`41229647423` now passes the same 1 MiB admission workload (1,550 cases, 1,345
snapshots and 10 reopens) and all 431 target cases under GDB. Full Windows
platform acceptance remains pending beyond those two suites.

Restart recovery deliberately suspends existing execution lanes. The HTTP
fixtures therefore admit and dispatch through real routes after server startup;
they do not disable recovery or weaken event fencing. Current managed command
admission preserves Node's Agent-project eligibility. Task and standalone
managed admissions retain `managed-session-ineligible`; their complete product
execution paths remain separate work in the replacement goal.

The dedicated `native-commands` workflow job runs protocol/policy comparisons,
the repository suites with a 1 MiB fixture stack, and settings/model/event/
coordination HTTP suites across all three databases on Linux, macOS and Windows.
Registration of that job is not platform acceptance. Receipt HTTP with actual
queue notifications and dispatch/recovery, GUI orchestration, canonical history
ingestion, complete Task/Goal execution, Redis coordination, supported-platform
packaging, data-preserving upgrades/rollback and Winterhold rehearsal remain
required. Normal development, desktop and standalone entrypoints still use Node.

## Controlled conversion caller connection ownership

Linux conversion run `41160107203` reset the first status request after the
fixture restarted its server on the same port. An optional diagnostic workflow
repeats the original scenarios on isolated external PostgreSQL databases and
stops at the first failed iteration. It retains actual TCP connection and send
times without collecting credentials, query parameters or request bodies.

Diagnostic run `41165810079` failed at iteration four. Socket 53 connected at
`1793418880326`, while process 9018 was shutting down. That process exited at
`1793418880366`. The socket remained unused until the first status GET to the
restarted process 9033 at `1793418880741`, then reset one millisecond later.
The connection belonged to the previous server process: aborting the controlled
global-fetch caller had opened an unused replacement connection.

The controlled admission caller now uses the existing single-socket streaming
HTTP helper. Its abort closes that socket without opening a replacement. The
original database locks, admitted-write, shutdown, restart, recovery, revision
and worker-command assertions remain in place. The repeat harness additionally
checks actual TCP connection times for post-restart status reads. Resets and
incomplete HTTP responses still fail without retrying. All eight focused
streaming-client and trace tests pass, including the new actual abort/connection
ownership test. Two corrected local repeats pass all three auth modes for both
implementations on Node 24.22.1, including the actual post-restart connection
checks. Linux diagnostic run `41167479583` at code head `9412d6565` passes all
20 repetitions. Its verified artifact contains 120 completed restart scenarios
(three auth modes and both implementations per repetition), with each actual
post-restart GET using a connection established after the prior process exited.
The artifact ZIP SHA256 is
`579fb182432dc55adbafb30a38ebbf089b4c7dce046f393927fb9c312e625086`.
This is focused Linux lifetime evidence; diagnostic dispatch does not replace
the full platform matrix or packaged acceptance.

## Platform recovery observations and PostgreSQL 16 transfer

PR #2361 platform run `41129609392` exposed two observation races. The macOS
external-PostgreSQL discovery check read an imported candidate with parent
revision 11 and returned before asserting the required revision 12. Both
production implementations read the job and candidates through separate queries,
so a completion can commit between those reads. The recovery poll now waits for
all expected fields together and retains each raw snapshot. Exact final revisions
and ordered recovery events still have their original assertions.

The Windows external-PostgreSQL terminal report shows the startup reconciliation
command arriving after service creation and enabling, producing an extra terminal
invalidation during the later restart check. The fixture now observes the actual
empty startup reconciliation before creating the service. It keeps exact event
counts, order, scope and payload checks, and retains raw Live traces and failed
fixture roots for diagnosis.

PR #2362 Linux migration run `41138651367` reached the native storage contracts,
then PostgreSQL 16 rejected pg_dump 18's generated `transaction_timeout` setting.
An isolated PostgreSQL 16.15 container reproduced that error. The bounded exporter
now adapts only the generated leading prelude: it attempts the real setting in a
DO block and tolerates only an absent setting. Permission errors and other SQL
failures still propagate. Function bodies and exported multiline values are never
searched or rewritten. PostgreSQL's [cross-version dump notes](https://www.postgresql.org/docs/18/app-pgdump.html#APP-PGDUMP-NOTES)
explain why older destinations can require SQL adaptation.

Local current and genuine 233-migration transfers pass into PostgreSQL 16.15,
native PGlite 17.5 and private PostgreSQL 17.9 with identical 115-table snapshots
and four sequence states. The fixture includes a multiline row containing the
same setting text to verify that data remains unchanged. The optional test-only
`--postgres-url` creates isolated random databases on a supplied PostgreSQL test
server and removes only those databases afterward. These backend results do not
prove the Rust executable's Linux or Windows acceptance.

The local discovery lifecycle suite passes on all three stores and all three auth
modes; terminal HTTP/Live passes on all three stores and both auth modes. A retained
PostgreSQL recovery trace actually includes `(revision 11, imported)` followed by
`(revision 12, imported)`. Current and historical transfer interruption checks also
pass on all stores. The original Windows migration job passes with SQL-written
SIGKILL witnesses and successful retries; the follow-up head still needs CI results.

The broad repository check ran and failed with 21 source-server test failures,
1,628 passing and 71 skipped under concurrent validation. Sequential reruns of all
16 failing files on both clean baseline and this branch each pass 49 tests and
reproduce only the existing provider-routing assertion in
`local-foundation.test.ts:7218`. No deadlines or assertions were changed, and this
does not make the broad check green. The local startup stalls were separately
sampled in tsx disk-cache eviction before application entry; the reruns disable
that shared cache without deleting it.

## Removed plaintext GitHub catalog

The root Node request policy disables every `/api/github/` route, including the
five catalog handlers still present in TypeScript source. Rust now preserves
that HTTP 410 contract after authentication and CSRF and before payload parsing,
request limits or worker dispatch. This does not reactivate plaintext repository
access or implement the separate protected GitHub provisioning domain.

The real-socket `github-catalog-http-compatibility.mjs` suite compares status,
body, cookies and security/CORS headers for local, password and account modes.
It includes unknown paths, unsupported methods, duplicate query parameters,
malformed JSON, unsupported payload types, rejected origins and preflight.
Local macOS comparisons pass in all three storage modes: 34 local-mode, 38
password-mode and 38 account-mode observations per implementation per backend.
Strict all-target Clippy and Rust formatting pass. Evidence is retained in
`github-catalog-http-{pglite,postgres,bundled}-v1.json`.

Supported-platform CI runs this suite on all three database modes; configuring
those jobs is not evidence that Windows/Linux have passed.

## Execution-target catalog stack usage (verification in progress)

Windows CI run `41065255700` overflowed the 1 MiB repository probe during the
execution-target suite. The catalog joined eleven inline database-read futures;
its future measured 62,088 bytes on local macOS. Boxing those component futures
reduces the same measured catalog future to 600 bytes while retaining concurrent
reads, mapper errors and result semantics. The unchanged local baseline passed
at 1 MiB, so that measurement is not a Windows reproduction or readiness claim.

The target repository harness now retains the last submitted operation for each
runtime, preserves the original failure when shutdown also fails, and saves the
report and disposable database root on failure. Previously a cleanup exception
prevented the Windows failure report from being written. The 1 MiB probe remains
unchanged; supported-platform verification is still required.

All 431 repository cases pass locally on each of native PGlite, private
PostgreSQL and external PostgreSQL at 1 MiB (`target-stack-repository-*-v1.json`).
Strict all-target Clippy and Rust formatting pass. An injected SIGKILL during a
real catalog request verifies that the original process error, last operation,
shutdown error, 31 prior cases and database root remain available in the saved
report (`target-stack-report-fault-v1.json` and
`target-stack-report-fault-verified.json`). That intentional failure verifies
report retention; it is not counted as a passing compatibility run.

## Ordered worktree observation comparison

Linux run `41068582355` exposed an unordered test boundary: inventory mutation
writes the canonical `path` routing handle and the scheduled observation reply
replaces it with the field-scoped `worktreePath` handle. The next HTTP command
could race that persisted replacement, producing different reconcile source
handles despite equivalent source-selection queries. The test now reads the
actual worktree catalog until the observation path is stored between mutations.
It retains the exact command/body/Live comparisons and asserts the observed
path; it does not substitute a delay or remove the differing field. External
PostgreSQL, private PostgreSQL and native PGlite pass all nine local
storage/authentication combinations with unchanged 116/120/127 recorded
observations per runtime. Reports: `observation-order-http-*-v1.json`. Platform
verification remains pending for this adjustment.

## Product acceptance observation boundaries

The acceptance driver now waits for the real Run child's exit witness and its
actual `ESRCH` result before asserting retirement. Linux platform traces show a
PTY shell-group PID distinct from the Node child PID. A bounded Linux reproduction
using the unchanged production process-tree controller confirmed five cases where
the shell exited before a child flushed its witness 150 ms later. This timing
reproduction does not replace whole-worker Linux acceptance. The existing child
identity, worktree-directory ordering, secret hash and durable-runtime assertions
remain intact.

The browser-discovery fixture now serves its HTTP listener in a separately
supervised process. In the macOS failure, both services hosted by the browser/Vite
driver disappeared from the fleet reply while independently served ports remained.
An actual worker-probe reproduction stalls the driver for 1.1 seconds: the inline
listener misses the unchanged 750 ms probe deadline, while the isolated listener
responds. Only candidate addresses are supplied in this bounded timing experiment;
the full product flow still uses the production OS listener inventory. Both client
APIs must still find the exact listener, title, worker and placement, and the
fixture retains the real request/response events.

Local Run product checks pass 25 steps per Node/Rust runtime on PGlite, private
PostgreSQL and external PostgreSQL. The full encrypted resource flow passes 35
steps per runtime on each store, including actual fleet discovery, terminals,
WorkerLink/direct routing, tunnels, protected shares, file documents and workspaces.
It retains exact tunnel-byte assertions. These host-wide OS discovery flows must run serially when
sharing a machine: one validation run's HTTP/TLS probes otherwise reach another
run's raw TCP peer. No traffic is filtered out to make that assertion pass.

Current-head supported-platform and packaged acceptance remain required. A separate
Windows conversion job in run `41141260086` timed out during native PGlite opening;
its logs and artifact are retained rather than counted as a pass. The serialized
standard `pnpm check` for this milestone finishes with 1,662 source-server tests
passing, 57 skipped and only the previously reproduced provider-routing assertion
at `local-foundation.test.ts:7218` failing. No assertions or deadlines were changed;
the broad check remains non-green.

## Actual Run product acceptance

The browser/worker probe now uses the existing app API to store an opaque Run
secret, discover capabilities/paths, create and update definitions, reject stale
writes, read/list/validate definitions, and launch a real child. The child writes
only a SHA-256 digest to prove it received the decrypted secret. Stale definition
deletion preserves the live process; current-revision deletion stops it, removes
the definition, and retires durable runtime state. A second child verifies
worktree retirement while preserving the Primary file.

This exposed a client grant gap: start/restart did not authorize `run-content`
before dispatch. They now install the existing endpoint encryption grant, as
output reads already do. Stop remains callable without obtaining a grant.
Focused app tests pass 37 assertions and app typecheck passes.

Local macOS runs pass 25 steps per Node/Rust runtime on all three stores
(`run-product-pglite-v5.json`, `run-product-postgres-v1.json`, and
`run-product-bundled-postgres-v3.json`). A prior PGlite run completed all Node product
assertions but timed out stopping the worker; the next full run passed. A private
PostgreSQL attempt timed out stopping the Node-connected worker before the Run
flows; both the diagnostic rerun and the next uninstrumented run passed. These
failed reports are retained; they are not passing evidence. Linux CI run
`41066792147` also failed the Node pane-lifetimes shutdown deadline after logging
fixture shutdown completion. Its job log and artifacts are retained for further
investigation; platform verification remains incomplete.
Linux/macOS CI now includes the POSIX child-retirement probe. Windows needs an
equivalent process-termination probe; none of this proves packaged acceptance.

## Run definition administration

Native project routes now cover list/get, capabilities, detection, path discovery,
validation, Flutter devices, writes and deletion. Worker files remain owned by the
worker; Primary resolution and response correlation match Node. Writes/deletes
share the existing project queue with runtime and worktree operations. Deletion
reads the actual definition and checks its revision before runtime retirement;
a still-active stop result prevents the worker delete command.

The controlled-worker HTTP suite exercises creation/update, stale writes/deletes,
missing/foreign ownership, malformed and misrouted replies, query parsing,
server-owned secret summaries, active-runtime retirement, ordered command/Live
streams and persisted audit rows. Exact protocol comparisons cover 106 definition
request/response vectors. Evidence: `.qa/rust-server/run-definitions-contract-tests-v2-exit.json`
and `run-definitions-http-{postgres,bundled-postgres}-v1.json` plus
`run-definitions-http-pglite-v3.json`. All nine local storage/authentication
combinations pass with 116/120/127 HTTP observations per runtime. This is not full-worker filesystem or packaged-platform
acceptance. Additional interruption/concurrent-definition tests remain pending.

## Run secret administration

Native GET/PUT project secret routes preserve validation-before-lookup, tenant
ownership, opaque envelope persistence, JavaScript-compatible digest receipts,
revision increments, replay of the original revision/timestamp, and 201/200/502
behavior. Successful writes and replays preserve both ordered invalidations
(route publication and response-completion publication) and the owned audit row.
All nine local database/authentication HTTP combinations pass, with audit rows
read back after server shutdown. Concurrent identical repository writes produce
one revision and one receipt on all three stores under the 1 MiB fixture stack.
Evidence: `run-admin-secret-http-*-final.json` and
`run-admin-repository-*-v5.json` in `.qa/rust-server/`.
Supported-platform/package verification remains incomplete. Native Run definition
administration is described above. The default server is still Node.

## Protected Git operations and worker observations (in progress)

Native Run lifecycle admission now includes owner-scoped receipt replay, Primary
definition reads, encrypted secret lookup across platform overrides, serialized
start/restart/stop dispatch, durable worker failure reconciliation and ordered
terminal/Run invalidations. The expanded HTTP/worker-decoder comparison passes
all nine database/authentication combinations with stored opaque secrets. Tests
exercise terminal reuse, generation changes, replay without dispatch, receipt
conflicts, inactive/active no-op outcomes, current-state receipt reads and missing
worker runtime persistence. Exact definition/secret-summary schema comparisons
pass 46 cases, alongside the existing worktree/runtime contract tests. Strict
all-target Clippy passes. Evidence: `.qa/rust-server/git-run-lifecycle-http-*-v4.json`,
`git-run-definition-contract-tests-v2-exit.json`, and `git-run-lifecycle-clippy-v3-exit.json`.
Full definition/secret administration, additional failure boundaries and real
process/platform acceptance are not established by this controlled-worker suite.

The real browser/full-worker probe exposed a reference retirement race: a worker
notification committed the stopped state before the stop reply, causing deletion
to reject an unchanged observation. PR #2331 merged the regression-backed fix as
`9aad78a702aa6aa4e99dee4ce93e203c861f51d7`; native retirement now follows the same
rule. Matching applied/unchanged observations are accepted only when the runtime
is inactive; stale generation/operation observations remain rejected.
The final differential matrix passes all nine storage/authentication combinations
with 74/76/80 HTTP observations per runtime. An unchanged `stopping` reply is
explicitly rejected before any worktree removal dispatch. Reports:
`.qa/rust-server/git-run-retirement-http-*-v2.json`; strict all-target Clippy:
`git-retirement-observation-clippy-v1-exit.json`.

Retirement across the 256-row page boundary now passes all nine storage/auth
combinations with 260 persisted runtimes and terminals per implementation.
The HTTP status response retains its 256-row cap; deletion leaves zero runtime
and terminal rows for the target worktree, without extra stop commands for idle
instances. Evidence: `.qa/rust-server/git-retirement-batch-*-v1.json`, also
preserved with logs and hashes under `~/.codex/qa-evidence/run-retirement-batch-260`.
This verifies batching, not concurrent admission or packaged platform behavior.

A held worker start reply now exposes committed admission through real HTTP
status reads while duplicate client requests overlap. The completed requests
produce one worker start, preserve the receipt ID and replay flag, and can then
stop the same generation. All nine storage/authentication combinations pass
(`.qa/rust-server/git-run-concurrent-*-v3.json`). Concurrent groups compare the
entire ordered Live stream once rather than attributing overlapping event slices
to individual responses. Seed timestamps are explicit to keep initial ordering
inputs identical. Earlier fixture failures remain preserved, including a replay
racing a stop: the receipt correctly carries the current runtime snapshot, which
can differ with request admission order. This is not yet deterministic coverage
of a queued stop/delete or HTTP disconnect during admission.

Admitted Run start also survives a real HTTP socket disconnect while its worker
reply is held. After the socket close event, retrying the original operation
returns the persisted receipt and running state with exactly one start dispatch;
a subsequent stop retains the generation. All nine storage/auth combinations
pass, including ordered Live events (80/82/86 HTTP observations per runtime).
Evidence: `.qa/rust-server/git-run-disconnect-pglite-v2.json` and
`git-run-disconnect-{postgres,bundled-postgres}-v1.json`; reports and logs are
preserved under `~/.codex/qa-evidence/run-disconnect-http`. The platform workflow
now runs the Git/worktree/Run contracts and HTTP suite on all three stores; those
new CI steps have not run yet. Queued deletion and additional worker/server
interruption boundaries remain outstanding.

Actual browser/full-worker acceptance now passes 17 steps per Node/Rust runtime
on PGlite, private PostgreSQL and external PostgreSQL locally on macOS. A real
long-lived child writes an exit marker proving its directory still exists when
termination arrives; after deletion, its PID is gone, the secondary checkout is
removed and its durable runtime is absent. The Primary user file remains intact.
Reports: `.qa/rust-server/git-actual-run-retirement-pglite-v5.json` and
`git-actual-run-retirement-{postgres,bundled-postgres}-v1.json`. Earlier failed
reports and the stopped-state database inspection remain retained.

PR #2331 validation passes 79 focused server tests, 92 worker tests plus the
source worktree test, 56 app tests, 961 protocol tests, app build and server
typecheck. The broad check failed in two unchanged CUA JavaScript execution-budget
tests (137 others passed); all 23 JavaScript tests passed separately. This does
not make the broad check green. Evidence is preserved with hashes under
`~/.codex/qa-evidence/run-retirement-observation-merged-9aad78a70`. Server CI run `41058467522` passed on macOS, Windows and Linux. Additional lifecycle failure boundaries, definition/secret
administration, packaged acceptance and full supported-platform evidence remain
required.

Run status and encrypted-output HTTP reads now execute natively. Differential
HTTP/worker-socket tests pass across all nine database/authentication combinations
(PGlite, private PostgreSQL and external PostgreSQL; anonymous, password and
accounts). Each runtime executes 61/63/67 HTTP observations respectively. The
added cases verify owned status, foreign-owner isolation, missing/offline output,
unchanged opaque envelopes, default output tail and rejection of all eleven
mismatched response identity fields. Strict all-target Clippy passes. These are
controlled-worker tests; full client acceptance extends beyond the real-process
retirement flow verified above. Evidence: `.qa/rust-server/git-run-reads-http-*-v2.json` and
`git-run-reads-clippy-v1-exit.json`.

The native project repository-operation route now uses per-project FIFO admission,
retains admitted work after client disconnect, and drains result finalization
before shutdown. It preserves protected request/response envelopes, model routing,
Git-agent usage recording and the two existing worktree invalidation points.
The worker remains unchanged.

Worker observation configuration includes owner-scoped source selection, active
operation context, debouncing and conditional path reconciliation. Real-socket
comparisons pass with PGlite, private PostgreSQL and external PostgreSQL across
anonymous, password and account modes. Those scenarios verify opaque routing
handle persistence, refreshed configuration, filesystem Live invalidation and
worker reconnects. Repository observation-context comparisons pass 165 cases
on each backend.

The account-mode comparison exposed a reference-server defect: connection-time
observation lacked an explicit owner. PR 2320 fixed that propagation and merged
as `f0b951146277b260e2af7f0f8a5a8d76f97bcf4d`; server-behavior CI passed on Linux,
macOS and Windows. The separate Rust replacement platform jobs remain pending.

Native CodeGraph status observations reserve revisions before asynchronous
ownership reads, suppress duplicate publication and retain at most 4,096 recent
bindings. State tests and HTTP comparisons across all three storage modes and
authentication modes pass, including missing-worktree and wrong-worker rejection.

Native inventory reconciliation preserves existing worktree identity, validates
the Primary path and repository fingerprint, and applies missing/prunable state
in a transaction. Repository comparisons pass 178 cases on each storage backend,
including an insertion conflict proving that earlier source and Primary updates
roll back. Worker inventory notifications now resolve owned routing paths,
publish worktree invalidation and refresh observation configuration. Real-socket
comparisons pass all nine storage/authentication combinations, including durable
Git field updates and rejected mismatched routing paths. Strict all-target Clippy
passes.

Creation rollback, lifecycle updates, observed state writes and removal-blocker
reads now have native repository implementations. The expanded 212-case target
repository suite passes on all three storage modes. It covers ready-context
admission, owner/path/origin checks, repeated rollback, missing/prunable precedence,
active and released execution lanes, run-configuration terminal exclusion and
foreign-key protection during rollback. The full worktree coordinator, HTTP
integration and managed Git recovery remain unfinished; this milestone is not
replacement acceptance.

The worktree coordinator now has a native implementation for serialized creation,
inventory reconciliation, pull-request checkout reuse and creation rollback.
Recovery
failure validation matches 42 actual protocol cases, including inconsistent
outcome/code/target combinations and UTF-16 string limits. Eight comparisons also
match the Node error constructor, including truncation inside an emoji.
The expanded 231-case repository/coordinator suite passes on all three database
modes. Controlled worker replies exercise successful creation, missing source,
ambiguous worker failure, malformed replies, conservative rollback, changed
catalog bindings, PR checkout reuse/rejection and new user-owned checkout creation.
These use real repositories with controlled command delegates; actual worker
filesystem mutations, HTTP lifecycle integration and recovery remain required.

Catalog, create, reconcile, lock, unlock and prune now have native HTTP handlers
connected to the shared coordinator. Capability checks precede request-schema
validation, and successful mutations preserve both coordinator and post-response
worktree invalidations. Socket comparisons pass all nine database/authentication
combinations, including exact Live-event ordering, command envelopes, durable
routing handles and operation timestamps. Strict Clippy passes.

Run configuration runtime reads, bounded lists, worker identities, inactive-row
deletion and fenced observations now have native repository implementations.
The target repository suite passes 337 cases on each of PGlite, external
PostgreSQL and bundled PostgreSQL. It covers all 64 state-transition pairs,
ownership and generation checks, persisted failure details, unchanged observation
replay, transaction rollback after a constraint violation, list ordering and
256-item bounds. Strict all-target Clippy passes.

Operation admission and terminal binding are now implemented. The expanded
421-case repository suite passes on all three database modes, including all
24 operation/state combinations, receipt replay and identity conflicts, generation
updates, terminal reuse and exactly-once pane attachment. A forced receipt-write
failure rolls back runtime creation, terminal creation, membership and layout
revision; retrying the same operation succeeds. Concurrent admission checks are
described below. Strict Clippy passes; these repository results alone do not
establish complete runtime or worktree DELETE parity.

Worktree DELETE and the runtime retirement loop now have native implementations
under focused HTTP comparison. Retirement stops active instances, validates the
worker result, reconciles the fenced observation, updates terminal status and
removes terminal/runtime records before dispatching worktree removal. The new
runtime-result contract matches 68 protocol cases, and strict Clippy passes.
Anonymous PGlite HTTP comparison passes 44 observations, including offline active
instances, missing/active/stale/future-generation stop replies, final retirement,
retained stop receipts and exact Live-event ordering. All nine storage/authentication
combinations pass this retirement suite. Actual worker process retirement
acceptance remains required; filesystem acceptance is described below. Missing worktrees remain observation targets in the reference
repository; deletion does not remove those catalog identities.

Native runtime notifications now use authenticated connection ownership and retain
admitted work through shutdown. Reconnect reconciliation compares durable identities,
marks missing processes lost and publishes run then terminal invalidations. The
focused anonymous PGlite socket suite passes with wrong-project/stale-generation
rejection, a failed runtime notification, missing-process reconnect and retirement
of active/failed/lost instances. Strict Clippy passes; the expanded nine-combination
notification/reconciliation matrix exposed missing account owner context in the
Node reference reconnect handler. PR #2327 fixes that handler; its two-owner
real-WebSocket regression fails before the fix and all 13 focused tests pass after
it. All nine database/authentication combinations now pass against that merged
reference (44 anonymous, 46 password and 48 account HTTP observations per
backend, including notification and reconnect Live events). Concurrent database
admission now verifies 12 duplicate starts produce one runtime, terminal, pane
membership and receipt; 12 distinct stops produce one accepted stop; and 12
identical exit observations apply once. These checks pass for both implementations
on all three storage modes, with strict Clippy passing. Additional reconciliation
failure cases and actual process acceptance remain open.

Actual browser/full-worker worktree acceptance now passes on all three database
modes for both implementations (`actual-folder-client.mjs --worktrees`). The
existing client encrypts metadata and the unchanged worker creates a real local
Git checkout, locks/unlocks it, retains its identity across server/worker restart,
reconciles, removes and prunes it while preserving the primary checkout. The
fixture seeds only the disposable local Git project's catalog classification to
exercise GitHub-backed capabilities without external GitHub access. Client
status convergence respects its existing one-second cache. Active runtime process
retirement, additional mutation failure/disconnect recovery and supported-platform
packaging remain unverified by this flow.

Dirty-removal acceptance exposed a reference-server lifecycle rollback bug:
recovery reused a ready-only execution lookup and left rejected removals stuck
at `removing`. PR #2330 fixes the Node setter with owner/project/active-source
checks inside the update; Rust now uses the same atomic authorization. The
421-case repository suite passes on all three stores, including recovery and
foreign-owner/removed-source rejection. The expanded 15-step real-browser/full-worker flow passes for both servers on
all three stores: dirty removal returns the protected error, retains the file,
restores `ready`, and permits deletion after cleanup. The reference fix passes 61 focused server, 93 worker and 56 app
tests, app build and server typecheck. Its full repository check finished with
1,633 server tests passing, 57 skipped and two failures: the pooled provider
account expectation in local-foundation and the missing getModelRuntimeByRoute
mock in terminal-managed-session. Both were independently reproduced on the
pre-fix baseline; the broad check is not green. The final log and hashes are
preserved in `~/.codex/qa-evidence/worktree-removal-recovery-merged-903542623`.

## Workspace read stack usage follow-up

Follow-up platform run `41037815947` has completed with failures in the later
actual-browser integration suite: macOS failed the Node fleet-discovery listener
assertion; Linux and Windows failed Rust browser-surface readiness with a
connection error. These failures require diagnosis and resolution before platform
acceptance. Raw failed-step logs and platform artifacts are retained in local QA
evidence; a passing workspace-specific check does not establish a passing matrix.
The Linux worker logs show `surface.attach` rejecting a browser URL outside
HTTP/HTTPS after opening its Chromium target. Open draft PR 2132 addresses the
overlapping initial blank-page navigation race and still reports unresolved
Windows validation. Its worker changes have not been adopted into this lane.

PR 2318's Windows run `41035166842` still aborts at the first owned workspace
seed on its 1 MiB test thread, after missing-project and foreign-owner checks
pass. The earlier fixture-dispatch extraction is not sufficient Windows
remediation. Artifact `12967972359` has SHA256
`682dfad190623bf073d574bce32c38b57c006014cab5fb38a9eb7da030de526f`.

The legacy layout reader now allocates each of its ten joined database futures
on the heap. It retains concurrent reads, their original executor and the
caller's transaction boundaries. In the observed ARM debug executable this
reduces the reader's polling frame from 171,808 to 33,744 bytes. That is a frame
measurement, not a claim about total process memory or Windows acceptance.
Both ARM and x86 macOS can run the original workspace suite at 1 MiB; platform
revalidation remains necessary to establish whether this fixes Windows.

After this change, workspace repository compatibility passes all three storage
modes at 1 MiB (66 cases and 11 snapshots per mode), as does legacy pane
repository compatibility. The x86 macOS workspace run, PGlite workspace HTTP
comparisons, PostgreSQL pane concurrency/read-boundary/shutdown checks, strict
all-target Clippy and Rust formatting also pass. The broad repository check
is still running; these focused results do not establish full replacement
or Windows readiness.

## Explorer, Code tabs and project views

All 18 project-surface routes now execute natively, preserving their distinct
validation, placement, ownership, encrypted state, capability errors and ordered
Live invalidations. The implementation reuses native pane placement and workspace
cleanup, retains Explorer pin idempotency, and fences Code checkout updates using
the prior worker and worktree binding. Explorer operations use the unchanged worker
command transport and preserve the separate 4 MiB request limit.

Local comparisons pass on PGlite, bundled PostgreSQL and external PostgreSQL:
133 repository operations and 68 durable snapshots per store, plus all nine
storage/authentication HTTP combinations (88/94/98 observations per runtime).
Populated main/detached workspace layouts cover all view definitions and legacy
Explorer `project.file` aliases. Another owner's layout remains unchanged.
An actual SQL trigger failure at the final resource DELETE rolls back workspace,
legacy-pane, layout-revision and remote-surface cleanup on every store.

Project-view deletion revokes two active WorkerLink grants before sending
`surface.close`; foreign deletion cannot revoke them, and deleted grants cannot
renew or be reissued. These cases pass inside the existing terminal/relay suite
on all three stores for local and account authentication. Repeated deletion does
not send another close command. Controlled workers use the unchanged decoder and
transport; this is not full remote-desktop UI acceptance.

Existing browser APIs and the full production worker pass Explorer reads/writes,
stale-save and stale-binding denial, Code/Explorer metadata, pin retries and
restart retention. A real local Git checkout is discovered through folder setup;
encrypted History/Graph creation, rename, deletion and restart retention pass on
all stores (14 steps per runtime). The source correctly rejects worktree switching
for these managed-folder projects even when Git is available. Actual GitHub-backed
Issues/PR/Actions flows and wider worktree lifecycle acceptance remain required.

The 16 schema roots pass 8,396 exact cases; the full wire regression passes
260,456 cases. PostgreSQL lock tests establish pin/CAS races and admitted work
surviving caller abort and graceful shutdown. The focused Source suite passes
37 tests, and the app build passes. Strict all-target Clippy and changed-file formatting pass. Route-template dispatch
also preserves validation for resource IDs that resemble action names. Current-head
supported-platform results and merged delivery are still pending. The native
all-target run passed before the subsequent fixture stack correction; that run
does not verify the final fixture source. Normal builds
continue to select the Node server; this milestone does not perform the cutover.

The preceding pane milestone's run `41026486096` has now reported Windows and
macOS failures. Windows exits during native workspace seeding with a confirmed
main-thread stack overflow. Its artifact `12963648256` has SHA256
`b66115ee2ab2a10d83a2f6be1f168041ed95c23a4d33817e3bc1572d7df837d9`.
macOS caught a lock-observation race: a blocker was visible while the separately
sampled wait type was null. The observer now waits for both actual signals before
releasing the transaction, retaining the bounded deadline and assertions; the
external PostgreSQL workspace repository suite passes locally after this fix.
A local 1 MiB-stack reproduction isolated excessive debug stack use in the
shared repository fixture dispatcher: its poll frame alone reserved about
660 KiB. Extracting unrelated operations into a separately boxed dispatcher
passes all 66 workspace cases and 11 snapshots on each of native PGlite,
private PostgreSQL and external PostgreSQL at 1 MiB,
with production repository code unchanged. The CI workspace repository matrix
now uses the same explicit stack size. Windows platform revalidation remains
required; a local pass does not establish that the Windows failure is fixed.

The current focused worker check reports 92 passes and one filesystem-notification
failure. An isolated repeat fails later in that same test. Clean Primary passes
the full focused group once, then times out on the isolated test; all 842 compared
worker/protocol/crypto/CLI source and test files are identical. These results
establish baseline instability, not its cause or a green worker check.
The broad current milestone check passes 1,623 Source server tests (57 skipped),
955 protocol tests and 3,899 app tests (three skipped), but fails four worker
tests: filesystem notifications, browser-profile adoption, abrupt-process outbox
replay and large-image encoding. An unchanged isolated rerun of the last three
files passes all 53 tests. The broad check remains failed.

## Legacy panes, surface launchers and normal workspace bootstrap

All 20 legacy pane, tab-group alias, surface-launcher and built-in worktree
routes now execute natively. They preserve opaque titles, ordering, center-tree
splits, dock preferences, member identity, revision conflicts, built-in resource
resolution and lazy Overview cleanup. Standalone reads retain independent query
connections; workspace seeding uses its caller-owned transaction. Mutations retain
admitted work through caller disconnect and graceful shutdown.

Local Node/Rust comparisons pass on native PGlite, private PostgreSQL and external
PostgreSQL: 107 repository operations and ten durable snapshots per store, plus
13,823 exact schema/error cases and 38 Source-generated SQL shapes. HTTP tests
cover all three authentication modes on every store, with 59/62/64 observations
per runtime. Pane mutations publish the ordered project and project-tab-layout
notifications; launcher and built-in worktree changes preserve their absence.
The reference fixture observes completion of the actual final response hook
before checking Live delivery: a response body or unrelated pong alone does not
prove completion of the earlier asynchronous audit hook.

Actual PostgreSQL locks establish three revision races, both standalone and
caller-transaction read boundaries, and cleanup committed before a later failed
claim. A caller-aborted insert remains admitted through observed server shutdown,
then commits and survives restart. Injected SQL failures verify rollback without
replacing the real repository operations.

The existing browser client now exercises normal workspace bootstrap rather than
supplying a custom seed: workspace GET 404, legacy panes GET 200, then seed POST 200. The unchanged full worker and encrypted dirty-editor handoff/restart flow
pass on all three stores, with 20 steps per runtime. These results do not establish
native desktop window hosting or complete React UI acceptance.

Workspace repository and HTTP regressions also pass on all three stores after
the shared-reader refactor. The full native all-target run passes 131 tests across
70 result groups, with no failures or ignored tests. Strict all-target Clippy,
Rust formatting, changed-file
formatting, the app build, 106 focused Source tests, 955 protocol tests and the
full app suite (3,899 passed, three skipped) pass locally. The broad repository
check is not green: a computer-use process test timed out, then passed unchanged
in isolation. A separate broad Source run encountered migration/test timeouts; all seven
affected files subsequently pass unchanged with one test worker (14 tests).
the worker run retains its filesystem-change notification failure. The same
focused worker failure reproduces on clean Primary, with identical relevant
source/test hashes and 91 other tests passing in each checkout. Those failures
are retained and must be investigated without weakening their assertions.

A second full `pnpm check` passes all 1,623 Source server tests (57 skipped),
3,899 app tests (three skipped), and the earlier computer-use process test. It
ends with four worker failures: filesystem notifications, batch replay after
process exit, browser keyboard input and browser-profile adoption (2,528 passed,
133 skipped). The focused outbox/browser rerun passes the three timeout cases but
fails a different initial-screenshot browser case (24 passed, one failed).
All 842 compared worker, protocol, crypto and CLI source/test files match Primary;
these observations do not establish the remaining browser failure's cause.
The separate root format check reports 12 unchanged files; all 12 also fail the
same formatter in clean Primary. Changed-file formatting passes. Broad repository
and platform acceptance remain incomplete.

The preceding workspace milestone's Windows CI artifact also records a browser
surface failure in the Node reference, before Rust's private-PostgreSQL run:
`surface.attach` rejects a protected URL as non-HTTP(S). Its PGlite flow completed
35 steps for each runtime. The artifact SHA256 is
`b2218c4c3b9d2d58f03a9784c8032c5a5ef0682fb5ec3d610e0a9f997cba3150`.
The macOS run fails Rust's external-PostgreSQL catalog sync-state assertion.
Neither partial result establishes full supported-platform acceptance.

The pane suites are configured in the Linux/macOS/Windows workflow. Current-head
platform results, broader regressions and merged delivery remain required. Normal
app and standalone launchers still use Node; this milestone does not switch the
default server or complete replacement.

```sh
node --import tsx scripts/server-rust/layout-query-manifest.mjs --check
node scripts/server-rust/cargo.mjs test --test pane_contracts -- --nocapture
node --import tsx scripts/server-rust/layout-repository-compatibility.mjs --database pglite --report .qa/rust-server/layout-repository-pglite.json
node --import tsx scripts/server-rust/pane-http-compatibility.mjs --database pglite --report .qa/rust-server/pane-http-pglite.json
node --import tsx scripts/server-rust/pane-http-lifetimes.mjs --report .qa/rust-server/pane-http-lifetimes.json
```

Repeat repository and HTTP comparisons with `--database bundled-postgres` and
`--database postgres`.

## Device workspace ownership and editor handoff

The four workspace-layout routes now execute natively: read, seed, commands and
legacy immutable-file import. All 24 command variants preserve attachment
generations, revisions, exact command receipts, canonical encrypted resource
labels, preview ownership, pane topology and detach/return handshakes. Receipt
replay checks the current renderer attachment first, returns the current layout
with the original applied revision, and does not repeat native window effects.
Legacy import receipts survive closed views and missing source documents.

Seeding reads the server's real legacy panes, resources, built-in state and dock
preferences. It preserves their invariant errors and lazily retires Overview
inside its nested transaction. A failing cleanup rolls back its revision and
members. Concurrent seeds converge on the first committed main-window identity.
Code/Explorer conversion locks the source editor and current document, worker,
source and checkout authority through layout/receipt commit. The existing
terminal/browser deletion helper now shares this command model instead of
maintaining another close-tab reducer.

The real legacy reads exposed native PGlite's unnamed-statement interference
between concurrent queries inside one transaction. A regression executes ten
distinct statements concurrently; it returns the last statement's identity for
the first query before the fix. PGlite transaction operations now serialize each
complete parse/describe/bind/execute exchange. The database contract passes with
PGlite process restart and real PostgreSQL. PostgreSQL pooling remains independent.

Local evidence includes 21,432 exact validation/error comparisons, 687 shared
model cases, 147 actual deletion-helper outcomes and 34 Source-generated query
statements. Real repository comparisons pass on all three stores, including
negative-zero receipt identity, eleven-document SQL bindings, legacy cleanup,
authority rejection, injected receipt rollback and retained restart state.
External PostgreSQL additionally observes six authority-change races and locks
on all six authority rows through receipt insertion. A Node/Rust/Node roundtrip
also retains workspace writes and receipts across runtime cutover and return.
Full-server data conversion and post-write rollback remain unfinished. Real concurrent HTTP tests
cover identical and competing commands, generation fencing, seed convergence,
and a caller-aborted receipt insertion that commits before shutdown completes.

The HTTP suite passes anonymous, password and account modes on all three stores,
with 45/48/50 observations per runtime. It checks exact bodies, headers, cookies,
CSRF, errors, scope, body limits and restart. Per-request Live barriers preserve
the current Source mapping: workspace-layout mutations publish no broad project
invalidations. The existing browser API/queue, renderer lifetime and unchanged
full worker also run on all three stores. An actual encrypted BroadcastChannel
transfers an unsaved editor model, undo history, selection and scroll state before
the server commits ownership. The endpoint draft and detached ownership survive
server restart; workspace HTTP contains no private path or document text.

The full native `--all-targets` run reports 130 passes across 69 result groups,
with no failures or ignored tests. Strict Clippy, the application build, 106
focused Source server tests and 138 focused application tests pass. The broad
`pnpm check` passes 1,623 server and 3,899 app tests, then fails the unchanged
worker filesystem-notification debounce test (2,531 worker tests pass). The
focused worker run also fails watcher checks; the clean Primary passes that file
alone. All 815 compared worker/test/protocol/CLI source files are byte-identical.
The cause remains unresolved; the broad repository check is not green.
The separate formatting check reports 12 unchanged files; all 12 also fail the
same formatting check in clean Primary. Changed files pass their scoped check.

```sh
node --import tsx scripts/server-rust/workspace-query-manifest.mjs --check
node scripts/server-rust/cargo.mjs test --test workspace_contracts --test workspace_models -- --nocapture
node --import tsx scripts/server-rust/workspace-repository-compatibility.mjs --database postgres --report .qa/rust-server/workspace-repository-external.json
node --import tsx scripts/server-rust/workspace-http-compatibility.mjs --database pglite --report .qa/rust-server/workspace-http-pglite.json
node --import tsx scripts/server-rust/workspace-http-lifetimes.mjs --report .qa/rust-server/workspace-http-lifetimes.json
pnpm --filter @cantrip/worker build
node --import tsx scripts/server-rust/actual-folder-client.mjs --database pglite --terminals --file-documents --workspaces --report .qa/rust-server/workspace-client-pglite.json
```

Repeat the repository, HTTP and browser commands with `--database pglite`,
`--database bundled-postgres` and `--database postgres`. CI includes these
comparisons on Linux, macOS and Windows; configured CI is not passing evidence.
Native desktop window hosting, full editor/UI recovery, shared coordination and
packaged acceptance remain required. These device-layout APIs do not complete
project-workspace CRUD or the remaining resource domains. The production Node
entrypoints remain in place; migration/rollback, packaging, Winterhold rehearsal,
performance and the remaining resource/execution domains remain in scope.

## Oversized document upload response observation

PR 2313's Windows run passes the complete PGlite document HTTP comparisons and
both anonymous private-PostgreSQL runtimes. Its account-mode Node reference then
fails with `ECONNRESET` while the test uploads a body above the 4 MiB route limit,
before recording a response or starting the corresponding Rust account run.
The uploaded seven-file ZIP and raw job log are retained; the ZIP's SHA256 is
`dc3fa4753565bc89f29c5f88e102515e740f38d9314ec67e4707cb4389ec3b63`.

The reset also reproduces locally against Node when the client advertises the
entire oversized length before uploading. The oversized-body fixture now sends
the same JSON payload with actual chunked framing, yields to socket responses,
and stops uploading when response headers arrive. Separate headers-only requests
advertise the oversized length without sending body bytes. A completed reply
still has its exact status, JSON, headers, request identity and cookies checked.
A reset without a response or a truncated body fails; there is no retry or
inferred 413. Other fixture operations keep their existing fetch transport.
Five real socket tests cover early replies and cookies, a complete chunked
upload, headers without body bytes, absent replies and incomplete replies.

PR 2314's Windows socket test then records four passes and an actual reset from
its immediate-close early-response peer. The early-reply test now responds after
receiving the first real chunk and explicitly keeps that connection open until
the client consumes the reply. It still requires the exact 413, JSON, both
cookies, chunked framing and a nonempty partial upload. The separate reset and
truncated-response cases still require failure. The client and production server
are unchanged by this test-peer correction; Windows results must be observed.

The actual headers-only comparison exposes a native parsing defect independently
of that reference-client reset: Node immediately returns 413 for JSON, text and
its registered binary parser, and 415 for unsupported or missing content types.
Rust waits for body bytes and fails the caller deadline. Rust now checks an
actually supplied oversized Content-Length before buffering, preserving that
parser-dependent error priority. The existing byte-bound read still limits
chunked uploads. The original failing reports are retained. Current-head Windows
and complete supported-platform acceptance remain required.

The repaired document comparisons pass locally on all three stores with 39
anonymous and 41 account observations and six worker commands per runtime,
retaining exact per-request Live and durable-state comparisons. The general
HTTP/WebSocket JSON comparisons also pass on all three stores. All five actual
socket tests, 19 native library tests, strict all-target Clippy and Rustfmt pass.
The earlier full-suite worker notification failure remains unresolved; this
focused parser repair does not establish a green repository check or packaging
readiness and adds no routes to the coverage count.

## Immutable file documents

The four document catalog, creation, lookup and protected operation routes now
execute in Rust. The repository uses the actual TypeScript statements and
parameter order. Creation locks the current project, source, checkout and worker
authority through insertion. Exact retries preserve the original binding and
timestamp; reusing an identity with different ciphertext, checkout, worker or
project returns the same conflict. Historical documents remain in their owner's
catalog when their checkout becomes unavailable. Operations rejoin current
ownership and availability before dispatching the opaque request to the worker.

The operation route retains its explicit 4 MiB body limit, worker failure
mapping and strict protected-response validation. File paths and contents stay
encrypted. Admitted operations and creation own their lifetimes through caller
disconnect and shutdown. Successful creation, including an exact retry, publishes
the reference's project-scoped document invalidation after HTTP response
completion. Failed requests and file operations do not mutate the catalog.

Local real-repository comparisons pass 42 operations and four state snapshots on
each storage mode, including immutable conflicts, tenant isolation, source and
worker changes, insertion rollback, process restart and removed checkouts.
External PostgreSQL additionally passes five actual lock races. Four hold the
authority query while its records become unavailable; the fifth blocks the
actual INSERT in a database trigger and proves source removal must wait for its
transaction to commit. The committed document then remains recoverable while its
operation context becomes unavailable. Query drift and 2,089 validation and
rendered-error cases match the real protocol.

A separate real-HTTP shutdown test blocks the actual document INSERT after its
authority selection, aborts the caller and starts server shutdown. Both servers
retain that same blocked query until the lock is released, commit the identical
opaque binding, finish shutdown and serve the retained document after restart.
No old snapshot or discarded write is used to make that test pass.

Actual Node/Rust HTTP comparisons pass 34 anonymous and 36 account observations
per runtime on all three stores. They compare complete worker commands, per-route
Live invalidations and retained rows, including real database failure, malformed
requests, both sides of the operation body limit, worker errors, invalid replies,
caller disconnect and worker disconnect. PostgreSQL publication can complete
after a Live ping, so the fixture waits for the actual expected committed event
before asserting its exact scope and count.

On all three stores, the unchanged browser API and full worker write 44,454 real
file bytes, reject stale saves, wrong locations and repeated operations, resolve
fresh-nonce retries through the existing client, and recover document access
after server and worker restart. The combined existing
terminal/browser/tunnel/share flow passes 32 steps per runtime with this document
flow included on all three stores. Run the combined storage flows sequentially
on one host to keep OS discovery away from another flow's strict TCP peer.

The full native regression passes 127 tests across 57 result groups, with no
failures or ignored tests. Strict all-target Clippy, Rustfmt, all 18 changed
formatter files, the 20 source file-document tests and the application production
build pass. The repository check passes 1,623 server and 3,899 app tests, then
fails the same worker filesystem-notification case: 2,531 worker tests pass and
one fails. Both the feature and clean Primary checkouts pass all ten tests in
that file when run separately. All 932 compared worker/shared/dependency files
are byte-identical. The broad check remains red; this intermittent failure is
unresolved. Current-head supported-platform and packaged acceptance remain
required. Complete workspace/editor behavior, shared
coordination, packaging, existing-data conversion, full post-write rollback and
the rest of the server replacement remain separate required work.

## Direct preparation acknowledgment and release comparison

The terminal HTTP fixture now holds the actual worker preparation acknowledgment
after its HTTP caller disconnects. Both servers acknowledge an early release
with 204 while telemetry returns 404 and no worker revoke is sent. After the
worker acknowledgment, the fixture attempts the real authenticated telemetry
operation until it observes the published, inactive capability's exact 409
response. The final release must then send exactly one worker revoke. Final
telemetry and its duplicate both return 204, matching the reference's deduplicated
accounting. The original complete command, HTTP, state and Live comparisons remain.

Receiving the worker request alone did not prove that the server had processed
its acknowledgment and published the grant. The earlier fixture could release
too soon and snapshot commands before the final revoke existed. This repair
changes the compatibility fixture; no production timing or grant behavior changes.
Publication attempts are retained separately because their count depends on
scheduling; every response must match either the exact unpublished 404 or final
inactive 409 contract.

The full terminal comparisons pass locally on all three storage modes. Each
Node/Rust runtime passes 191 anonymous and 202 account HTTP observations with
PGlite, 189 and 202 with private PostgreSQL, and 205 and 218 with external
PostgreSQL. All twelve runtime/profile combinations match the acknowledgment
boundary. CI runs these existing three comparisons after shared dependency
setup, before full browser integration, so a later browser failure cannot hide
this independent evidence. The full browser and worker checks remain enabled.
These local results do not establish supported-platform, packaged desktop or
complete replacement acceptance.

## Protected project and standalone-chat shares

The Rust server now implements the three project/standalone-chat share creation
and deletion routes and their protected WebDAV broker. Project and worktree
selection use the reference repository's exported SQL and bindings. Ownership,
worker placement, scratch capability, tunnel identity and protected revision
checks retain their ordering. Existing attachments stop before the protected
revision check, including a stale replacement request. Worker open and close
use the actual 30-second and best-effort 5-second deadlines. Failure responses
retain safe codes, stages and the actual dispatched worker request identity;
private worker errors, filesystem paths and credentials stay out of responses.

Actual Node/Rust HTTP comparisons pass 55 anonymous and 62 account observations
per runtime on each database mode, including real database-trigger rollback,
held concurrent operations, worker errors, exact Live scope/order and a real
caller disconnect. The generated share contracts match 1,490 validation and
rendered-error cases. A separate PostgreSQL test blocks the actual tunnel INSERT
after the worker's successful reply, aborts its caller, starts shutdown, witnesses
the same database waiter and verifies identical committed protected rows after
releasing the lock.

The existing client and full unchanged worker pass the share flow on all three
stores. HTTP Digest authenticates actual WebDAV PUT, GET and PROPFIND operations
with 40,026-byte file contents over encrypted WorkerLink and legacy carriers;
incorrect credentials fail. The worker's real filesystem contains the written
bytes. The server catalog and captured control requests contain no private root,
public share path or credentials. Startup deliberately removes transient share
records, matching the reference: the client creates a new share identity and
reads the retained file. An existing standalone-chat scratch fixture is
provisioned with the production scratch manager while its worker is stopped,
then opened and served by the full worker. This does not claim native chat
creation or scratch provisioning routes are complete.

The real-worker test reproduced a reference revocation defect: a share was absent
from the catalog after deletion, but its old WorkerLink grant still returned the
original 40,026 bytes with HTTP 200. Both implementations now revoke the scoped
WorkerLink authority before refresh/deletion and managed-resource removal.
Regression assertions require the old channel to close; the original failing
reproduction and source are retained.

An additional restart keeps the actual worker process alive while the server
restarts on its retained address. Both implementations retire the old share
channel, reconnect that same worker PID, create a fresh share identity and read
the retained 40,031-byte file. The test attempts the existing client operation
through reconnect, retrying only its explicit offline outcomes; other failures
propagate immediately. This flow passes on all three stores.

The final native regression passes 125 tests across 67 result groups, with no
failures or ignored tests. Strict all-target Clippy, query drift, source
typechecking and five broker tests pass. The exact CI product flow passes 28
steps per Node/Rust runtime on all three stores, including the original direct
terminal, browser and tunnel assertions. Run these product flows sequentially on
one host: another test worker's OS-wide discovery can probe the strict TCP peer.
The original exact-byte failure is retained; its assertions remain intact.

The repository check passes 1,623 server and 3,899 app tests, then fails the worker
filesystem-notification test. Both the feature checkout and clean main reproduce
the same `observed.txt` notification failure, each with nine passing tests in
that file. All 849 compared worker/shared source, test and dependency files are
byte-identical. This is a retained baseline failure; the repository check remains
red. Supported-platform and packaged acceptance remain separate work.
The whole-tree formatter also reports 12 unchanged tracked files; clean main
reports those same files, plus its ignored build outputs. The changed files pass
their focused formatting check. Neither baseline result is reported as green.
The latest merged CI run, 40969628794, failed on all three platforms: Ubuntu's
private-PostgreSQL terminal command comparison missed a final revoke observation;
macOS's Node reference fleet discovery missed the fixture listener; Windows's
Node product flow passed 25 steps before the Rust browser-surface flow failed.
Raw job logs are retained. The discovery fixture now retains both actual replies
before asserting their identity. No platform failure is waived.
The three uploaded ZIP archives were SHA256-verified before reading their actual
reports. Ubuntu's full-worker reports pass 25 steps per runtime on all three
stores, proving the per-executable sandbox policy through real browser operation.
Windows's worker diagnostic reports a rejected protected browser URL during
`surface.attach`; the existing draft PR 2132 concerns startup blank-page behavior
and remains separate from this server milestone.

## Browser service discovery in progress

Native project-fleet and existing-browser discovery now use the unchanged worker
command transport. Project ownership, folder affinity and ready local-Git replicas
filter the eligible workers before ICU locale sorting and the 64-worker bound.
Requests run concurrently with the source's 20-second deadline. Worker identities
are validated before authenticated identities replace their claims; fleet entries
retain explicit placement nulls. Per-worker parsing retains the 128-service bound,
and ordered fleet aggregation enforces the 1,024-service budget. Offline, timeout,
worker-error and partial/truncation behavior retain the source's exact contracts,
including UTF-16 name and error truncation and whitespace-only errors.

Actual Node/native HTTP comparisons pass 60 anonymous and 61 account observations
per runtime on each of PGlite, private PostgreSQL and external PostgreSQL. Each
compares 37 exact worker-selection observations, admits all ten controlled worker
requests before any completes, exercises the actual 20-second deadline and
disconnects an in-flight worker. Browser/surface rows remain byte-equivalent after
the read-only operations and restart. The combined browser protocol suite matches
9,113 validation and rendered-error cases from the actual schemas.

The existing client/full-worker flow passes 25 steps against each server on all
three stores. Both discovery APIs find a real HTTP listener through the full
worker's OS enumeration and HTTP probes, with two actual requests witnessed by
the listener. Discovery finishes before the later tunnel test opens its strict
TCP payload peer: the original ordering correctly detected the scanner's HTTP
and TLS probes as additional peer traffic. Exact tunnel payload assertions remain.
The final native regression passes 122 tests across 66 result groups, with no
failures or ignored tests. Strict Clippy, formatting, boundary and large-file
checks pass. The final diagnostic-flow reruns pass all 25 steps on all three stores.

PR 2308 is merged as `ba3a3f99320822e34c55023bb0c6d0ba258aa182`. Its Linux and
macOS jobs each pass all six browser repository/HTTP steps, then fail the Node
reference full-worker flow. The retained Linux Chromium stderr identifies an
actual namespace-sandbox abort. The next CI run installs Chromium's documented
per-executable AppArmor policy for that runner's downloaded binary; production
worker launch arguments and the Chromium sandbox remain unchanged. This policy
passes the real browser flows on all three stores in run 40969628794. That run's
later terminal comparison still fails. The older macOS failure is specifically
the legacy CTTN reply poll; its WorkerLink tunnel already passed. The legacy poll
now checks complete length before the original full-byte assertion, and the TCP
peer retains bounded connection/data/half-close/reply-write timestamps. This does
not establish the cause or resolution of the macOS failure. Both artifacts and
their SHA256 digests are retained; Windows and subsequent platform results remain
separate acceptance work. No platform failure is waived.

## Browser product management in progress

The current browser-management lane implements the five native list, create,
update, delete and managed-tunnel routes. Creation uses the existing execution
placement rules and one transaction for the opaque browser row, remote surface
and project pane. Browser and terminal resources now share the same native pane
placement and removal implementation, retaining their different profile defaults.
State updates retain the expected-revision predicate, committed state during
worker failures, explicit offline/error status and the source's Live event order.
Deletion removes workspace views and panes transactionally, revokes browser
WorkerLink grants, stops managed tunnel attachments and owns the asynchronous
worker close through shutdown. No private URL or title is decrypted by the server.

Actual Node/native repository comparisons pass 40 operations and 22 complete
state snapshots on each database mode. External PostgreSQL additionally passes
five write-lock scenarios: revision advancement, a worker change after the
context read, row deletion with and without a revision predicate, and concurrent
deletion that still commits source-style workspace/surface cleanup. These tests
observe the blocked query, blocking backend and ungranted locks before releasing
the competing transaction. Real trigger failures and integer overflow retain
their actual SQLSTATE and transaction rollback behavior.

The HTTP comparisons pass 37 anonymous-mode and 41 account-mode observations per
runtime on all three stores. They assert complete responses, exact Live event
order and scope, CSRF, tenant isolation, online/offline worker configuration,
revision conflicts, managed-tunnel attachment reset and deletion cleanup. Native
protocol validation and rendered errors match 7,641 cases from the actual schemas.
The shared-pane extraction also passes the existing terminal repository suite.

The full existing-client/full-worker flow passes 24 steps against each server on
all three stores. Browser setup uses the unchanged client API instead of seeding rows:
the client creates encrypted state, reopens/decrypts it after server restart,
receives authenticated JPEG and encrypted location messages, changes the saved
URL through the real worker, and deletes the browser with an installed grant.
That grant is revoked; retained requests contain none of the authenticated private
browser URLs. The final-source full native regression passes 122 tests with no failures
or ignored tests across 66 result groups. Strict all-target Clippy also passes.
This is not platform, package or full replacement acceptance.
Browser service discovery, remaining owning domain consumers and
the original migration/packaging/cutover requirements remain in scope.

A real external PostgreSQL trigger rejects one of 1,024 sibling attachment stops.
Node completes the other 1,023 and retains the earlier managed-tunnel write. The
initial native run is still progressing at its 15-second observation deadline;
that counter is not evidence of discarded work. Native recomputation repeatedly
decoded complete attachment rows as wire JSON. It now selects the source's four
required values directly, using SQL presence for the nullable last-seen field.
Both runtimes complete all siblings with the same 500 response and committed
state. Current local observations are about 3.6 seconds for Rust and 4.1 seconds
for Node; this establishes this workload only. Child work is admitted before the
aggregate is awaited and remains owned through shutdown. The failure, progress
timeline, source snapshots and passing comparisons are retained.

PR 2307 is merged as `17f3b20c5b0193991c13e23ab234f7ba252b45af` and clean
Primary contains it. Its five other workflows pass, but the Rust workflow
40951884864 fails on all three platforms: Linux fails the Node browser startup
flow; macOS fails the Node encrypted tunnel reply; Windows passes both PGlite
flows then fails the bundled PostgreSQL Rust tunnel reply. The two tunnel
artifacts retain data, half-close and close frames after an earlier empty-buffer
poll failed. A local empty-versus-40-KiB buffer assertion takes about 2.5 seconds
and generates 360,873 diagnostic characters; the reply poll now checks complete
length before retaining its original full-byte equality assertion. This does not
prove that assertion cost caused the CI failures. A test-only preload records
the actual unmodified Chromium launch and bounded startup stderr so the next
Linux run retains the underlying failure. No platform failure is waived.

## Managed tunnel persistence and reference identity in progress

Native managed-tunnel registration, lookup and removal now preserve the source's
ownership/placement checks, feature identity, protected revisions, counter and
creation-time retention, cascades and post-commit reads. Private display fields
and endpoint addresses are omitted from persisted routing metadata. Missing
protected content for a private endpoint retains its repository error; an
unprotected public-adapter insert still reaches the actual database constraint.
No SQL schema or external protocol changes are introduced.

The combined repository comparison passes 311 operations and 146 complete tunnel/attachment/lease state
snapshots on each of PGlite, private PostgreSQL and external PostgreSQL. Five new
external PostgreSQL scenarios observe the actual blocked writes before changing
the competing state: revision advancement, deletion, a management change,
management-sensitive removal and duplicate creation. Source/native responses and
committed state match, including the source's separate read/write boundaries and
real SQLSTATE failures. Random generated IDs are validated, aliased and sorted
only in unordered raw-state snapshots; public catalog order remains asserted.
Creation-time, position and identity retention are asserted separately in each
runtime so timestamp normalization cannot hide a changed relationship.

An additional case exposes a native reference-cardinality defect: two distinct
UTF-16 worker IDs could collapse to one replacement-character ID before SQL
binding. Source rejects that registration while the original native code creates
it. Native reference checks now retain original JS string identities through
deduplication and placement comparisons, then bind their lossy UTF-8 text.
Distinct and identical lone-surrogate cases pass on all three stores. The final-source full native run passes 120 tests across 65 result groups, with
zero failures or ignored tests. Strict final-source Clippy passes; the rebuilt
final-source client/full-worker flow passes all 22 steps on all three stores. Owning browser/project-share
routes and their runtime cleanup still need native integration; these repository
results do not advance accepted route or platform/package coverage.

Three complete worker runs with actual callback/lifecycle instrumentation retain
the existing filesystem notification failure. Real native FSWatcher/FSEvent
handles are created without reported watcher errors, but the affected stream
delivers no callbacks; one trace already sees the new file in Git status without
a matching filesystem notification. This narrows the failure boundary without
proving why native delivery is silent. No production watcher, timeout or test
parallelism changes were made. Clean-Primary baseline evidence and the earlier
startup controls remain retained.

## Browser publication and raw handshake compatibility in progress

The independently reproduced worker browser-state loss now has a bounded Node
integration fix. Refreshes retain pending broadcasts and attachment recipients,
serialize history/encryption work and take a new snapshot after an in-flight
refresh. A renderer error can yield to an already queued replacement. Four
deterministic regressions exercise the public adapter over an actual CDP
WebSocket with real worker encryption, including concurrent broadcasts,
concurrent attachments and renderer failure/recovery. The original publisher
fails both concurrency regressions. No worker rewrite or wire change is involved.
The focused browser/crypto/CDP/Grok set passes 29 tests. The complete
client/server/worker rerun passes all 22 steps on each of the three stores;
final acceptance is retained separately from the initial coalescing build.
This fixes the proven loss mechanism; the precise cause of the earlier
intermittent full-flow failure remains unproven.

A new raw TCP handshake comparison retains actual response bytes and headers
for valid upgrades, malformed keys/versions/protocols and automatic HEAD routes.
Its first run finds native differences: HEAD incorrectly upgrades, a request's
close token leaks into the successful response, and Hyper supplies a Date header
that the raw source handler omits. Native code preserves the source HEAD error
contract and uses explicit response extensions in the existing Hyper fork to
retain authored connection headers, disable HTTP reuse and suppress automatic
dates only for raw responses. Ordinary HTTP close/date behavior is a control.
All 24 cases pass in both auth profiles against both runtimes on all three stores;
all response headers are compared, with only validated dates/request IDs
normalized. Current native HTTP tests pass 13 cases; strict Clippy, Rust formatting
and the server-boundary audit pass. Configured CI is not platform acceptance.

The isolated whole-repository rerun passes the server's 1,622 tests and app's
3,899 tests but fails five worker tests. Full worker-only default runs in this
lane and clean Primary each fail the same filesystem-added-notification assertion,
with the other tests passing; a four-worker run still fails that assertion.
No parallelism or timeout configuration was changed. The Grok test now waits for
all its original final-status assertions within its original two-second timeout,
since credentials can be readable before profile enrichment/login cleanup finish.
The other broad-run timeouts remain unwaived. Whole-repository formatting also
reports 12 unchanged files; the identical formatting failures reproduce in clean
Primary and their source hashes match. Formatting of this milestone's changed
files passes; those baseline warnings remain recorded separately.

A controlled watcher-startup investigation disproves the competing-initialization
hypothesis: the existing sweep guard retains one initialization and status awaits
it. An uninstrumented held-startup run still misses the added notification;
a subsequent instrumented run records the actual added event and passes.
Neither establishes the exact broad-failure cause. No production watcher change
was made; retain both observations and trace the missing event next.

## Encrypted legacy TCP and shutdown ownership in progress

The combined browser/full-worker flow now includes a legacy CTTN socket step.
The existing browser attachment API creates credentials and opens the encrypted
tunnel configuration; production tunnel cryptography protects 40,000+ request
bytes. The full Node worker decrypts them, forwards to a real loopback
TCP listener and returns an authenticated encrypted reply. Actual payload hashes,
half-close and attachment revocation pass against Node and Rust on all three
stores, bringing this flow to 22 steps per runtime/store. The WebSocket source
endpoint is controlled test plumbing; production Tauri forwarding and packaged
desktop acceptance remain required.

Actual runtime fault comparisons cover the production initialization timeout and
permanent worker credential revocation in local/account modes on all three
stores. Revocation closes an open stream with its endpoint-disconnected broker
frame before the socket closes, and persists the matching offline incarnation.
External PostgreSQL also holds authorization beyond ten seconds: a first message
captured before the timeout still activates after release, while a message sent
after timeout cannot replace the rejected initialization promise. Tests observe
the actual blocked queries and ungranted locks.

Two further local/account PostgreSQL comparisons close the socket and server
while either authorization or activation is blocked. The process remains alive
with the admitted database operation, then exits cleanly after lock release.
Persisted attachment state and relay byte/operation totals match. The activation
case exposed a source shutdown race: Node ended its database before the late
activation's offline write. The authorization case exposed usage recording after
the meter had closed. Production source now owns complete socket initialization,
activation, retirement and expiry promises, and drains them before ending the
usage meter/database. Two focused source tests retain the late-write drain proof.
The native writer also now sends an empty close payload for local code 1005;
encoding that reserved code had produced an abnormal client close. Both original
failures and passing comparisons are retained.

The new full native regression passes 120 tests with none failed or ignored;
strict Clippy, source typechecking and 53 focused source tests pass. The preceding
attachment HTTP/socket/heartbeat/bandwidth matrix passes again on all three
stores. CI configures the new encrypted step and fault/shutdown suites; observed
supported-platform and packaged results remain required.

One extended PGlite run failed an existing browser reload assertion before the
legacy tunnel step. The worker logged a completed reload but the client retained
the prior title. The unchanged assertion subsequently passed with added control
state and actual navigation-request diagnostics. Its cause remains unresolved;
the failure is retained and must not be treated as unrelated baseline evidence.
Failed full-worker fixture directories are now retained for investigation.
An isolated reproduction now executes the actual worker publisher with controlled
CDP timing and real worker encryption: a concurrent broadcast refresh is dropped
while an earlier history read is pending, and an explicit later call publishes
the newer title. The temporary test module only resolves imports and exposes the
private class; it does not replace the publisher algorithm. This confirms a
worker publication defect independently of either server, while its causal link
to the full-flow failure remains unproven. The bounded fix and regressions are
recorded above; the original reproduction retains the unchanged source snapshot.

The whole-repository `pnpm check` passes the server's 1,622 tests, then fails four
worker tests (CodeGraph synchronization, filesystem debounce, linked-worktree
metadata and the Sharp image boundary). Focused runs of the three affected files
pass all 49 tests in both this lane and clean Primary; 919 worker/dependency source
files are byte-identical. These broad-run failures remain unexplained, rather
than established unrelated-baseline exclusions. Their original outputs and both
focused results are retained.

## Native attachment runtime and legacy sockets in progress

The unmerged WorkerLink milestone now installs the native tunnel runtime in the
server, lease sweeper and shutdown lifecycle. It owns physical subscriptions,
activation reservations, heartbeat/expiry timers and late database cleanup.
Reservations enter the per-attachment queue before task scheduling; replacement,
disconnect and expiry retain their separate incarnation fences and source order.
The broker's factory still uses its default activity policy and the production
relay quota callback.

All six attachment lifecycle/direct/socket routes now run natively. They preserve
credential rotation, existence-only lease checks, preparation fencing, direct
activation/finalization, attachment-specific WorkerLink revocation and Live
invalidation ordering. The legacy socket retains secret/header/subprotocol
authentication, public-route policy, owner capacity registration, first-message
capture and timeout before authorization completes, opaque frames and FIFO close
writes.

Actual Node/native HTTP and socket comparisons pass locally on all three stores.
Each runtime has 50 local-mode and 55 account-mode HTTP observations, with one
additional external PostgreSQL race setup observation, plus 17/15 socket cases.
The production 25-second/10-second heartbeat timers accept the matching 16-byte
token and retire a wrong token. Rotation revokes the matching WorkerLink grant
while a sibling grant still renews. Open streams receive their broker close frame
before the socket close. Persisted relay bytes and operation counts match exactly
after normal shutdown; actual opaque data and half-close frames are compared.

External PostgreSQL additionally proves three runtime races using observed
blocking PIDs and ungranted SQL locks: replacement queues behind activation with
strictly increasing generations; disconnect retains the late activation's fenced
offline write; expiry during a blocked activation UPDATE waits for that exact
generation before stopping it. The expiry fixture uses the production Date's
millisecond precision. An earlier SQL-now fixture accidentally retained
microseconds and did not match the source's exact expiry fence; its failure is
retained. The expanded protocol oracle matches 9,067 actual validation/error
cases. It exposed and corrected a native starts-with issue/message mismatch.

The full native regression passes 120 tests with no failures or ignored tests;
strict server Clippy also passes. The existing 21-step browser/full-worker
regression passes again against both servers on all three stores. That flow
exercises the preceding WorkerLink/direct transports and remains separate from
actual encrypted legacy TCP and Tauri/packaged acceptance.

These preceding tests use production worker transport with controlled opaque
responses. The encrypted TCP and fault section above extends their acceptance.
Full transport operational hooks, managed registration, remaining runtime
consumers, Redis, Tauri/packaged and supported-platform acceptance remain required.
The work does not advance the accepted route ledger.

## Legacy tunnel stream core in progress

The same unmerged WorkerLink milestone now includes a native CTTN codec and
stream broker. This protocol is separate from the WorkerLink carrier. The codec
retains validated headers and opaque payload bytes, including the source's
validation/error priority, UTF-8 replacement/BOM behavior, header limits and
maximum-depth JSON within a valid header. Actual source comparisons pass 160
byte/error cases. The expanded tunnel wire oracle matches 8,485 validation and
rendered error cases, including the preceding catalog schemas.

The broker preserves connection identity, sequence/direction checks, plaintext
flow credit for authenticated ciphertext, half-close, congestion, owner/worker
quotas, bandwidth windows, idle/lifetime expiry and statistics. Its reentrant
serialization permits source-style synchronous activity/send callbacks to revoke
the current route. Actual source execution matches 56 scenarios and 286 complete
transition/byte/callback/statistics snapshots, including nested termination and
stale close handles.

The native worker bridge now has a separate typed tunnel binary path, ordered
listeners and production WebSocket dispatch. Source comparisons cover buffer
thresholds and in-flight reservations, listener mutation/deduplication, protocol
isolation, stale peers, callback failure and replacement from inside a listener.
Binary admission, decode and callback delivery share the reentrant lifecycle
guard with connection replacement. Tunnel and WorkerLink decode failures now
use the source's shared bounded warning policy without recording frame contents.
An already locked dependency provides reentrant synchronization; actual offline
resolution adds no package versions.

The complete native regression passes 120 tests with none failed or ignored,
and strict server Clippy passes locally. These preceding core comparisons alone
do not establish legacy attachment/socket product acceptance. The native runtime
and production route integration are covered by the section above; full product,
failure and packaging acceptance remain required. The source production broker
factory configures relay quota consumption; its activity callback uses the
broker default. Production wiring must retain that activity policy and the
relay quota callback.

The existing 21-step real-browser/full-worker regression also passes again
against Node and Rust on native PGlite, private PostgreSQL and external
PostgreSQL after these bridge changes. This exercises the previously implemented
WorkerLink/direct paths and does not substitute for the remaining legacy socket
and actual Tauri/package acceptance.

## Tunnel catalog and management in progress

The same unmerged WorkerLink milestone now implements all six tunnel catalog
and user-management HTTP routes, with native list/get/create/update/delete
repositories. Ownership, owner-specific positions, project placement restrictions,
active attachment guards, protected revisions, opaque content and ordered
attachment summaries match the source. Project-scoped listing performs the
complete project listing before its existence check. Mutations retain the
source's separate writes and fresh post-write reads; they do not introduce a
new transaction or optimistic revision predicate.

Actual source/native repository comparisons pass 272 operations and 123 full
tunnel/attachment/direct-lease state snapshots per store. The matrix includes
the user/managed capability states, omitted/null fields, listener and destination
worker ownership, local Git source readiness, numeric rounding, expanded/invalid
dates, real integer overflow and write-trigger failures. Renamed unused columns
cause actual PostgreSQL errors. A missing attachment projection after update
proves that both implementations retain the committed protected revision despite
the later read failing. Database failures retain raw driver diagnostics and
compare the actual SQLSTATE and persisted state.

External PostgreSQL additionally passes five catalog races under observed real
row-lock waits: attachment insertion after the edit/delete guard, a competing
protected revision after the initial read, and management changes before the
final update/delete predicate. These supplement the four preceding attachment
transaction races. The resulting response, fresh attachments, cascade cleanup
and persisted state match the source.

Actual HTTP comparisons pass on all three stores with 77 local-mode and 83
account-mode observations per runtime. They compare response bodies/headers,
CSRF, tenant isolation, typed management conflicts, generic database errors,
restart persistence and exact response-completion Live invalidations. An invalid
owned project projection still fails before a missing project's 404. The native
wire interpreter now implements the installed protocol's strict-object
intersection behavior; 7,192 actual tunnel validation and rendered error cases
match. The HTTP and expanded repository suites are configured in CI; these local
macOS results do not establish supported-platform or packaged acceptance.

The complete native regression passes 117 tests with none failed or ignored;
strict server Clippy also passes. The existing 21-step real-browser/full-worker
flow passes again against both servers on all three databases after this change,
including encrypted terminal, remote-surface and tunnel traffic. Its direct
carrier still uses controlled forwarding; production Tauri IPC and packaged
desktop acceptance remain separate requirements.

Attachment management, managed tunnel registration/removal, direct activation,
legacy relay sockets, complete runtime consumers, Redis and desktop forwarding
remain required. This work is unmerged and does not advance the accepted route
ledger or establish a deployable replacement.

## Direct terminal data acceptance in progress

Server-issued terminal capabilities now have actual data-path acceptance through
the real worker broker. The desktop identity verifier is shared through
`direct_probe_connection.rs`; its implementation is byte-identical to the prior
verifier after removing the Tauri attribute. The desktop command remains a thin
facade with the same request and result. A development Rust executable imports
that production component using the desktop's WebSocket dependency version. A
controlled TCP forwarder uses the existing tunnel codec, route/sequence checks
and credit messages to carry the browser's inner terminal WebSocket.

The existing client crypto protects input, a real PTY executes the private
command, and the browser authenticates ordered encrypted output. Wrong terminal
operations are rejected before execution. Actual broker checks reject secret
reuse, completed revocation and mismatched identity; completed server revocation
also interrupts an active native broker connection. Broker/tunnel bytes are
checked for absence of the private command, token and path. These checks pass
against both servers on native PGlite, private PostgreSQL and external PostgreSQL,
bringing the combined real-browser/full-worker flow to 21 steps per runtime/store.

The actual Tauri library and desktop probe compile after extraction; strict
server Clippy passes including the shared verifier example. An additional strict
desktop Clippy run reports four existing warnings in `tunnel_forward.rs`.
The same four failures reproduce on clean Primary, and that file is
byte-identical in both checkouts. The extraction's successful desktop compilation
and actual native broker traffic are separate evidence from that baseline lint
failure. No assertions or lint rules were relaxed.

The Rust-server CI matrix now configures this direct-terminal flow on all three
databases and watches changes to the shared desktop verifier. These are local
macOS execution results and configured CI, with supported-platform observation
still required. The forwarder is controlled test plumbing; actual Tauri IPC,
the production native TCP forwarder, packaged artifacts, fallback across network
topologies and complete replacement acceptance remain required. This work remains
part of the same unmerged WorkerLink milestone.

## Legacy terminal WebSocket relay in progress

The unmerged WorkerLink milestone now implements `/api/terminals/:id/connect`.
It preserves upgrade-time origin rejection, account/session registration, UTF-16
operation limits, owner/read-only/offline checks, managed consoles, encrypted
input/output frames, terminal status changes and close codes. Input commands wait
for the preceding acknowledgment and recover after a rejected command; resize
commands remain independent. Early frames are metered but ignored until the
execution context is available. Socket close and late readiness retain their
separate detach behavior. Child operations enter lifecycle accounting before
they are spawned, so disconnect cleanup and its writes drain during shutdown.

Local/account comparisons pass on all three storage modes. They
compare actual socket frames, complete worker commands and persisted bandwidth
bytes/operation counts, including malformed and binary messages, encrypted output,
held input acknowledgments, independent resize, startup/exit failures, readiness
after disconnect, managed consoles and session revocation. Matching attachment
detach acknowledgments separate scenarios. The legacy logout close reason is
`Session was revoked`, matching the source. A creation response's exact two
project invalidations are observed before opening its direct stream; a Live ping
alone could overtake the asynchronous response hook. External PostgreSQL's
expanded matrix additionally exercises a genuinely blocked context read and a
pong barrier before releasing its table lock. The observation uses the actual
ungranted relation lock and blocking PID; PostgreSQL's activity view truncates
the source query before its joins, so SQL text alone cannot identify that wait.

The real-browser/full-worker flow passes 19 steps per runtime on all three
storage modes. Its new legacy socket step encrypts input with the existing client
module, executes a private command in a real PTY, authenticates ordered encrypted
output, closes the socket and deletes the terminal. This includes the preceding
18-step WorkerLink/browser/tunnel flow. The native terminal wire oracle matches
10,857 actual validation/error cases, and strict Clippy passes. The preceding
full native regression for this relay change passed 116 tests with none ignored.

Current work remains unmerged. Real direct-terminal broker/data transport,
remaining resource consumers, shared authority and supported-platform/package
acceptance are still required, along with the rest of the replacement goal.

## Legacy terminal direct bootstrap in progress

The unmerged WorkerLink milestone now implements `POST /api/terminals/:id/direct`
using the native direct-attachment coordinator. It preserves request validation,
preparation leases, owner/worker checks, managed-console startup, opaque state,
terminal readiness, bootstrap detach, status publication and twelve-hour leases.
The returned route and installed capability share the same attachment and exact
endpoint bindings, including UTF-16 client identifiers. Readiness wins over a
subsequent streaming-command result, matching the source route. Revocation during
preparation compensates the capability, closes the started terminal and releases
the lease before resource deletion proceeds. Admitted work survives caller abort.

Actual local/account HTTP comparisons pass on native PGlite, private PostgreSQL
and external PostgreSQL. They compare complete commands, opaque payloads, schema
errors and ordered committed/response Live invalidations. A second preparation
is held at the real worker acknowledgment; deletion's existing-capability
revocation proves its mutation fence is held before that acknowledgment is
released. Both rejected preparation and deletion complete with the reference
cleanup. The timeout scenario waits the real fifteen seconds. The fixture sends
an authenticated heartbeat so the controlled worker retains normal presence.
Native direct validation matches 1,584 actual protocol/error cases, including the
new request and ticket schemas. Strict Clippy passes locally.

The existing real-browser/full-worker flow also passes again on all three
storage modes after these changes, with 18 steps per runtime/store covering
encrypted PTYs, Chromium surfaces and tunnel traffic. This regression flow uses
WorkerLink; it does not establish real direct-terminal data transport.

This is controlled-worker HTTP acceptance. Real direct-terminal broker/data
traffic, legacy relay sockets, supported-platform/package acceptance and merged
delivery remain required; the route ledger is unchanged.

## Terminal deletion and workspace ownership cleanup in progress

The unmerged WorkerLink milestone now includes native terminal deletion under
the direct resource mutation fence. WorkerLink resource grants are revoked first,
including pending installations. The transaction locks the owning project and
its ordered workspace rows, removes every matching view, preserves detached
windows and conversion/transfer metadata, clears runtime bindings and detaches
the legacy pane placement before deleting the terminal. Focus/history, pane
anchors and labels, compact member positions and center-tree collapse match the
source. Active Run configuration instances still prevent deletion. A rejected
worker close does not undo the committed deletion, and admitted deletion survives
caller disconnect while waiting for a revocation acknowledgment.

Actual three-store repository comparisons pass 87 cases and 91 complete state
snapshots per store. They include multiple device/window views, untouched foreign
layouts, running interactive terminals, all four active Run states, revision
overflow, invalid ownership, project scope mismatch, missing topology and exact
transaction rollback. The source's pending-transfer behavior is retained. Native
ownership/tab/recursive-center validation matched 7,131 actual protocol cases and
their error messages. The device-workspace milestone above extends this to the
complete command model and shares that reducer with deletion.

The actual TypeScript cleanup helpers now generate 18 embedded SQL shapes and
their projected column positions. Native reads execute those exact selections;
failed writes retain the exact source SQL and parameters. Eleven real trigger
failures and four missing-column failures compare diagnostics and complete
transaction rollback. SQL write timestamps are checked against the actual run
before normalization, while raw diagnostics remain in the reports. A JSONB
`null` legacy root follows the source missing-root error, and an emptied center
tree is stored as SQL `NULL`, matching the source's physical representation.

Four external PostgreSQL races observe the deletion genuinely blocked before
releasing its writer. They verify that workspace cleanup reads the updated,
locked layout; deletion returns its pre-lock execution context; the Run guard
retains the source's pre-lock admission snapshot; and a concurrent deletion still
cleans up ownership. Complete response and persisted-state outcomes match.

Expanded local/account HTTP comparisons pass on all three stores. An actual
PostgreSQL foreign-key rejection proves deletion cleanup rolls back and preserves
the exact source DELETE diagnostic. The multi-grant test exposed Tokio task
spawning reordering commands from an ordered revocation batch. The command bus
now reserves FIFO dispatch order in the caller and performs transport work in an
owned task, releasing the reservation before awaiting acknowledgment. Independent
owner lookups remain independent. Inline transport would reenter the bridge from
an offline callback while its lifecycle lock is held; a retained thread sample
proves that hang, and the corrected queue passes the actual offline/replacement,
admission, budgets and bridge tests.

The full-worker comparisons also reproduced Node shutdown hanging beyond 105
seconds with one zero-byte TCP connection and no active HTTP work. The application
now tracks actual admitted HTTP requests and closes idle/unadmitted connections
at preClose; active requests drain and upgraded transports retain their existing
owners. Four real-socket tests cover speculative connections, partial headers,
an admitted held response and upgrade ownership. The original timeout reports
and partial-header reproduction are retained. Successful reruns do not by
themselves establish complete shutdown/platform acceptance.

Terminal direct/legacy streams and other resource lifecycle consumers remain
required, along with the rest of the replacement goal. This local work remains
unmerged and does not advance the accepted route ledger or establish platform,
packaging or migration readiness.

## Terminal worktree lifecycle in progress

The unmerged WorkerLink milestone now implements terminal worktree movement.
It preserves request parsing, owner/project capability checks and their order,
read-only/linked/running restrictions, ready and nonremoved target selection,
worker placement, opaque state and response-completion Live invalidations.
The direct-attachment resource mutation fence owns the full operation, while
WorkerLink grants are revoked before resource checks, including a rejected move.
The production service boundary now exposes resource-scoped grant revocation.

Actual repository comparisons pass 50 cases and 30 complete terminal/layout
snapshots on each of native PGlite, private PostgreSQL and external PostgreSQL.
The expanded HTTP matrices pass local and account profiles on all three stores.
They verify invalid requests retaining authority, foreign-owner isolation,
rejection after revocation, an installation losing authority before its worker
acknowledgment and exact ordered Live changes. External PostgreSQL additionally
holds the worker revocation acknowledgment, aborts the HTTP caller and observes
the subsequent placement write. An actual CHECK rejection preserves the source
SQL error response and original placement. Diagnostics are captured from the
actual source repository; only the validated wall-clock write timestamp is
normalized for comparison.

Further deletion failure/locking acceptance, terminal direct/legacy attachment
routes and the remaining resource lifecycle consumers are still required.
This progress remains unmerged and does not advance the
accepted route ledger or establish packaged/platform readiness.

## Tunnel grants and durable attachment leases in progress

The unmerged WorkerLink milestone now includes native tunnel grant issuance,
opaque attachment authorization, credential rotation, activation markers,
generation-fenced disconnect/stop, bounded direct leases, finalization, expiry
and single-instance startup recovery. Owning-tunnel row locks serialize writers.
Preparation leases survive admitted HTTP work and are released on every return;
late placement/client/deletion changes revoke the installed grant, and a changed
credential generation cannot activate it. A real activation-write failure rolls
back the database transaction and compensates the worker grant. Successful grants
publish the reference project/current-user tunnel invalidation.

Actual-source repository comparisons pass 80 cases and 17 full snapshots on each
database mode. External PostgreSQL also observes four genuinely blocked writers,
changes a credential or activation generation before releasing the lock, and
compares complete outcomes. The comparison deliberately retains the reference's
pre-lock renewal snapshot and exact millisecond Date stop fence, including the
case where legacy microsecond expiry values cannot match it.

The comparisons exposed a production Node PostgreSQL bug: four raw SQL lease
expressions supplied Date objects to an adapter that disables the date serializer.
The real-clock reference rotation failed before the fixture's deterministic clock
was installed. Those expressions now bind ISO strings, preserving the timestamp
calculation on PGlite and enabling the same rotation/lease behavior on PostgreSQL.
The reproduction is retained; the actual repository matrices exercise the fix.

The native minute sweep owns and drains admitted database writes, and direct
coordinator renewal/finalization callbacks now persist tunnel leases. The actual
60-second timer comparison on external PostgreSQL observes both lease expiry and
hard attachment expiry, their ordered Live changes, and the committed rows.
HTTP comparisons cover local/accounts, exact grants and command order, caller
disconnects, post-install mutations and real SQL activation failure on all stores.

The existing browser `openTunnelWorkerLink` and unchanged full worker carry an
authenticated encrypted 40 KB request to a real loopback TCP target, preserve
half-close and return an authenticated encrypted reply on all three stores. The
source endpoint uses the production tunnel AES implementation; this is not the
Tauri native forwarder or desktop IPC. The fixture seeds an existing encrypted
tunnel and attachment after the production client authorizes the worker's
`tunnel-content` key. The combined browser/terminal/surface/tunnel flow completes
18 steps per server/store locally.

Tunnel catalog/CRUD, attachment management/direct/legacy sockets, the complete
runtime/brokers, resource mutation revocation consumers and desktop forwarding
remain required. Redis/shared recovery, supported-platform/package acceptance
and coherent merged delivery also remain unfinished. No route-ledger acceptance
or production cutover is claimed by this progress.

## Remote-surface grants and operational logging in progress

The same unmerged WorkerLink milestone now includes native Browser and Remote
Desktop grants. Requests preserve validation/authorization order, opaque state,
desktop stream preferences, attachment acknowledgment, two-lane grant installation,
post-install state/placement checks, compensating revocation and finally cleanup.
Status writes publish the reference's three ordered current-user invalidations;
successful HTTP responses publish the additional resource/layout invalidations.
Terminal grants now also publish their reference response-completion invalidations.
An actual database failure in the catch's status write still runs attachment
cleanup. Disconnecting the HTTP caller does not abandon admitted work.

Canonical remote contexts now require both the project and worker owner, matching
the source join even for inconsistent cross-owner database rows. Browser backfill
uses the source's project/default-worker and ready-worktree selection, preserves
existing surfaces and skips missing sources. The native single-instance startup
runs that local-owner backfill and resets transient surface statuses while
preserving errors and last-connected timestamps. Shared startup recovery still
requires the future coordinator's observed instance count.

Local macOS comparisons pass 52 repository cases and 19 full state snapshots on
each of native PGlite, private PostgreSQL and external PostgreSQL. The expanded
terminal/surface HTTP matrices pass both local and account profiles on all three
stores, including complete command order and committed status/response Live
events. External PostgreSQL additionally exercises state changes and deletion
during grant installation, primitive stored-label failure and an actual rejected
error-status write. The real browser test now uses the existing
`RemoteSurfaceWorkerLinkClient`, production encryption and a full unchanged worker
rendering Chromium: authenticated private state/JPEG output, encrypted reload and
grant release pass on all three database modes (17 combined product steps per
runtime/store). It seeds an existing
encrypted browser row; browser CRUD and Remote Desktop capture acceptance remain
separate required work. A retained Chromium CDP attachment failure is recovered
by the production client's normal retry; this is not proof that the underlying
worker startup race is fixed.

Shared log emission now implements source-compatible text/context redaction,
UTF-16 truncation and keys, sampled events, bounded repeated-event suppression and
window summaries. Actual TypeScript comparisons cover 65,937 sanitizer/error
vectors and 2,136 policy actions across eight scenarios. Direct-attachment
comparisons pass 334 cases/15 scenarios with the production log policy; routing
and worker-link revocation diagnostics also match the source calls. Runtime log
buffer/archive APIs, formatting and complete production metrics remain unfinished.
All of this work remains unmerged and does not advance the accepted route ledger.
The preceding local full native regression passed 116 tests with none ignored;
strict server Clippy also passes. These are macOS results, not platform or
packaged-artifact acceptance.

## Managed consoles and terminal WorkerLink grants in progress

The unmerged WorkerLink milestone now includes native terminal grant issuance.
It validates the request before authority/resource lookup, preserves read-only
and placement failures, waits for the actual terminal readiness event, detaches
the bootstrap attachment, installs the grant and rechecks placement. Startup,
worker-result, detach and installation failures preserve the reference cleanup
and terminal status behavior. Caller disconnect does not cancel admitted work.
Real PostgreSQL mutation during grant installation proves that moved/deleted
resources receive a compensating grant revocation and a conflict response.

Linked consoles use native model/account eligibility, usage reserves, credit
balances, cooldowns, catalog hydration/reload, reasoning and exact root/subagent
pairing. Effective permissions, managed session context and opaque MCP selection
feed the real `chat.thread.ensure` command. Existing threads avoid binding writes;
new threads select the model and update the canonical runtime in the reference's
two separate transactions before `terminal.open` is sent. A failed second
transaction retains the committed model selection. Thread identifiers retain
UTF-16 on the wire and use Node-compatible UTF-8 replacement at database storage.

The same complete project/standalone chat execution-context projection now serves
Live authorization and execution targets. Actual-source comparisons pass 583
repository/service/helper cases and 31 state snapshots per store on native
PGlite, private PostgreSQL and external PostgreSQL. Three additional real
PostgreSQL lock scenarios observe the blocked backend and introduce a handoff or
route replacement before releasing the lock; both implementations reject the
writer without committing its model update. Chat summaries match 8,013 actual
protocol/error cases, and the expanded WorkerLink/result roots match 9,289 cases.
These dependencies do not constitute a completed chat/execution domain.

The controlled-worker terminal HTTP/Live matrix passes in local and account modes
on all three stores, including exact terminal command order and persisted console
bindings. It exercises invalid/open-before-ready and ready-before-result outcomes,
the actual 15-second startup timer, detach retry cleanup, rejected installation
and caller abort. External PostgreSQL additionally covers actual placement changes
and deletion during installation. The existing browser terminal transport and
encryption modules also run against each server and the full unchanged worker:
encrypted input executes in a real PTY, produces filesystem proof and returns
authenticated encrypted output over relay. This completes 16 combined product
steps per runtime on each store. Linked Codex startup still has controlled worker
results; a full real Codex-console product run remains required.

The first two new terminal abort runs finished their Node scenarios but timed out
during Node shutdown with one remaining socket. The abort fixture now owns a
single-use HTTP caller socket; complete Node/Rust runs pass on all three stores
without changing server shutdown behavior. A separate new combined native-probe
browser run still timed out during Node shutdown before Rust. These retained
failures do not establish that the earlier intermittent shutdown issue is fixed.

## WorkerLink authority, native HTTP and binary relay in progress

Native WorkerLink authority now models session identities, acknowledged session
and grant installation, lease renewal/expiry, scoped revocation fences, peer
rounds and ordered signaling mailboxes. Identity keys retain UTF-16 code units.
Capabilities return only after the worker acknowledgment; worker installations
receive SHA-256 token hashes. The controlled-worker comparison executes the
actual TypeScript coordinator and the native coordinator: 567 cases pass locally,
including installation/revocation and renewal/shutdown races, capacity limits,
failed acknowledgments, mailbox cursors and signaling byte/count bounds.

Native binary frame and remote-surface chunk codecs preserve validated bytes,
header/payload bounds, UTF-8 replacement, chunk ordering and incomplete-frame
replacement policy. All 127 actual-protocol binary/assembly/byte-bound cases and
9,289 validation/error-message comparisons pass locally.

The worker bridge now sends and receives these frames over its native binary
socket, preserves ordered subscriptions and permanent-offline callbacks, and
accounts for queued/in-flight WebSocket frame bytes through actual writer
completion or cancellation. The native relay implements per-direction channel
sequences, replay rejection, closing-channel tombstones, remote-surface permits,
payload quotas, feature traffic recording, bounded lane queues, fair draining and
stall retirement. It matches 148 actual-reference snapshots in 33 scenarios.

The server runtime binds authority to its actual command bus, configuration,
shared relay quotas and usage meter. Native HTTP handlers cover session
opening/renewal, peer creation/signals/mailboxes/release and grant renewal/release;
the authenticated binary relay socket checks Origin, client/session ownership,
duplicate query values and stale generations before HTTP upgrade, and checks
authority again afterward. Logout owns the database revocation and capability
cleanup across caller cancellation, preserving Live/capability/socket ordering.
Shutdown closes the relay and coordinator before the worker bridge and drains
owned callbacks before database closure.

Actual Node/Rust HTTP/socket comparisons pass locally on all three storage
modes with the unchanged production WorkerConnection and controlled command
acknowledgments. They include byte-exact bidirectional frames, persisted ingress
and egress feature bytes, early peer signals, replay/error close codes and aborted
HTTP installation/logout. Raw command traces are retained; only independent
account-session revocation batches are compared without ordering, matching the
reference's explicit Promise.all and asynchronous owner lookups. A full native
regression run passes 114 tests with none ignored, including authentication,
sessions, worker bridge, WorkerLink and the existing resource domains. Strict
all-target server Clippy passes. The final thread storage conversion was added
while that full run was in flight and is covered by the fresh three-store
managed-console comparisons above and the final all-target Clippy run.

Native direct-attachment authority now implements preparation leases, resource
generation/kind fences, queued resource mutation, scoped revocation, per-capability
renewal serialization, exact expiry/renewal decisions, activation, monotonic
telemetry and bounded retired-tunnel accounting. It preserves transient transport
failure versus fail-closed renewal behavior and drains lifecycle persistence.
Actual-reference comparisons pass 270 cases across 14 scenarios, including late
acknowledgments, caller-owned mutation failures, UTF-16 identity fences and delayed
renewal during revocation. Another 841 protocol/error cases and 139 operational
transport metric snapshots match the actual TypeScript implementation. Real native
timer tests verify that expiry revocation survives through acknowledgment and
shutdown waits for pending persistence; background expiry RPCs have a separate
runtime drain before database closure.

The production native runtime now composes this authority with its actual worker
command bus and permanent-offline subscriptions. Logout revokes direct authority
before WorkerLink authority; shutdown closes both before the bridge. Session
route changes, release, direct preparation/activation and telemetry now use their
native consumers. Generic direct probe, release and telemetry/renewal routes also
execute in Rust, including the reference telemetry validator's thrown-error path.
The operational transport collector retains direct/WorkerLink counters and exports
the corresponding Prometheus series; the full operational endpoint remains a
separate unported consumer.

The expanded actual HTTP/socket matrix passes locally on native PGlite, private
PostgreSQL and external PostgreSQL: 83 local-mode and 99 account-mode HTTP
observations per runtime/store, plus 15 and 19 socket observations. It verifies
direct ticket binding, activation/telemetry, route replacement, scoped release,
worker failures and cleanup after aborted direct preparation. Observation grants
now preserve body validation, owner/account-session isolation, actual worker
installation, token hashing, renewal and release. A held installation surviving
caller disconnect cannot resurrect a released session: both servers send the
session revoke and a compensating grant revoke after the late acknowledgment.
These HTTP tests use the production worker transport with controlled command
outcomes; separate product flows below use the full unchanged worker.

The existing browser WorkerObservationClient and WorkerLinkManager now exercise
real observation grants and events channels through both servers and the full
worker. Real PTY process exit generates the observation; the client validates its
continuity and process generation, receives binary data and returns credit, then
releases the grant and session. All three storage modes pass the complete flow.
The native desktop probe is also executed from its production Rust source against
the full worker's actual broker. It verifies the server-advertised signed identity
and rejects secret reuse, completed server revocation and a mismatched broker
identity. The combined folder/PTY/observation/native-probe flow passes 17 product
steps per runtime on each store locally. This proves the native probe component,
not packaged desktop supervision, WebView IPC or the LOCAL WorkerLink data carrier.

Two actual LAN/WebRTC attempts failed in the Node reference before Rust was
reached. One timed out a worker signaling request after five seconds; another
acknowledged the offer, mDNS candidate and completion but remained on relay.
The test requires LAN and rejects relay fallback. These failures remain retained
and unresolved. An earlier external PostgreSQL Node product run also timed out
during HTTP shutdown; request/repository/notification diagnostics were added to
the disposable oracle, and a subsequent complete run passed. That intermittent
shutdown failure is not considered resolved by the later pass.

The native probe example builds and both Rust projects pass formatting. Strict
desktop Clippy still fails four existing lints in `tunnel_forward.rs`; the same
four errors were reproduced on clean `main`, with byte-identical source and Cargo
files. This does not affect the separate passing server Clippy result and remains
part of desktop acceptance work.

Remaining remote/tunnel resource grants and resource mutation revocation consumers,
full linked Codex/resource execution, desktop LOCAL carrier and IPC,
congestion faults, shared/Redis authority and supported-platform/package acceptance
remain unfinished. Tunnel lifecycle persistence observers are implemented and
tested; the production tunnel repository/runtime consumer remains unported. The
native operational logger now has the shared reference noise-control policy;
buffer/archive APIs and complete metrics remain required.
These checks do not establish complete WorkerLink product acceptance or advance
the route coverage ledger yet. The current WorkerLink work remains unmerged.

```sh
node --import tsx scripts/server-rust/worker-link-coordinator-compatibility.mjs --report .qa/rust-server/worker-link-coordinator.json
node --import tsx scripts/server-rust/direct-attachment-compatibility.mjs --report .qa/rust-server/direct-attachment-coordinator.json
node --import tsx scripts/server-rust/worker-link-http-compatibility.mjs --database pglite --report .qa/rust-server/worker-link-http-pglite.json
node --import tsx scripts/server-rust/worker-link-http-compatibility.mjs --database bundled-postgres --report .qa/rust-server/worker-link-http-bundled.json
node --import tsx scripts/server-rust/worker-link-http-compatibility.mjs --database postgres --report .qa/rust-server/worker-link-http-external.json
node --import tsx scripts/server-rust/actual-folder-client.mjs --terminals --worker-links --native-probe --database pglite --report .qa/rust-server/actual-worker-link-pglite.json
```

## Terminal management and encrypted PTY services

The first Windows terminal product run failed in the reference Node flow before
Rust was exercised: the inline, quoted probe repeatedly exited without writing
its proof. The probe now runs a generated CJS program with its secret passed as
an argument, preserving proof that the worker decrypted the actual command.
Real PTY, PID replacement, previous-process termination, reconnect and disable
assertions remain intact. Windows acceptance requires the new workflow result;
the failed job is retained in
[run 40779444391](https://github.com/ArcaneArts/Cantrip/actions/runs/40779444391).

The Rust server implements terminal listing, creation, encrypted title updates,
service configuration and service restart. Creation preserves execution placement,
cross-resource tab positions, pane selection and membership, center topology and
layout revisions in one transaction. Center validation preserves duplicate-node,
set-membership, depth and node-count failures. Position overflow reaches an actual
PostgreSQL integer conversion instead of wrapping in Rust.

Managed-runtime terminals retain their read-only errors. Linked consoles cannot
become services. Service configuration persists before worker reconciliation;
a later reconciliation failure retains the configuration and records offline
status. Status and response-completion invalidations retain their separate
current-user/project scopes and ordering. Shared custom validation issues now
preserve the reference property order when rendered into error-message strings.

Local macOS actual-source comparisons pass 9,639 protocol and error-message cases,
35 repository cases and 29 complete state snapshots on each store. Failed
creation leaves exact terminal, pane, membership, topology, revision and timestamp
snapshots unchanged. Independent SQL ties retain raw order in the receipts while
comparisons enforce the declared position/creation-time ordering. Actual HTTP and
Live comparisons pass 79 observations per runtime/store across local and account
profiles, with nonempty ordered notifications and tenant isolation. A real
PostgreSQL pane-member INSERT remains owned after its caller disconnects and
shutdown begins; lock release atomically commits the terminal, membership and
layout revision, which remain after reopening.

The existing browser encryption and terminal API modules also run against each
server and the full unchanged worker. All 13 combined folder/terminal product
steps pass on all three stores. A terminal in the newly created managed folder
decrypts its title/state at the endpoints, runs a persistent real PTY process,
restarts, rejects an offline restart, resumes its persisted service on reconnect
and stops the process when disabled. Request-body checks retain opaque titles,
commands and paths. The test never changes persisted worker encryption bindings
to accommodate the fixture's later port-changing server restart.

All 100 native tests and strict all-target Clippy pass. The production native
PGlite HTTP matrix also passes with an observed 1 MiB main stack. The standard
`pnpm check` passes typechecking and the server/app/protocol suites, then fails
the existing worker filesystem-notification test. Focused current and clean
baseline runs both reproduce that failure with nine passing tests; all 2,072
compared Node server, worker, shared and dependency files are identical.

```sh
node --import tsx scripts/server-rust/terminal-repository-compatibility.mjs --report .qa/rust-server/terminal-repository-pglite.json
node --import tsx scripts/server-rust/terminal-http-compatibility.mjs --report .qa/rust-server/terminal-http-pglite.json
node --import tsx scripts/server-rust/actual-folder-client.mjs --terminals --report .qa/rust-server/actual-terminals-pglite.json
```

Repeat with `--database bundled-postgres` and `--database postgres`. Supported
platforms, packaging, movement/deletion and resource revocation, interactive
terminal output, WorkerLink/direct attachments and shared coordination remain
required by the complete replacement goal.

## Worker encryption refresh and terminal-service reconciliation

The Rust server implements worker encryption refresh with the existing request
and response contracts, 20-second command deadline, owner checks, error mapping
and successful post-response worker invalidation. Only a material fingerprint
change for surface-private-state triggers terminal-service reconciliation;
timestamps and grant ordering do not. Reconciliation reads enabled services from
their bound worker worktrees, sends the actual 30-second worker command, then
starts parallel running-status writes and current-user terminal invalidations.
No response schema is imposed on the reconciliation command.

Worker reconnect also runs reconciliation. The reference callback inherits its
HTTP application-owner context: local sockets publish terminal invalidations,
while credential-only account sockets commit status updates without an owner for
their best-effort publication. Authenticated refresh requests publish under the
requesting account. Raw Live receipts retain arrival order; independent terminal
writes can complete in either order, and successful refresh always publishes its
worker invalidation after those writes.

Local macOS comparisons pass 25,600 actual TypeScript helper cases, 22 repository
cases and three SQL state snapshots on each of the three stores, and 45 HTTP
observations per runtime/store across local and account profiles. The HTTP matrix
requires nonempty terminal events and rejects foreign-owner delivery. Actual
PostgreSQL locks prove that status writes survive caller disconnect and shutdown.
A rejected status write returns HTTP 502 before a held sibling completes; that
sibling remains owned through shutdown and commits after lock release.

The existing browser repository flow now approves and refreshes its encryption
grant through each server and the full unchanged worker. All nine folder product
steps pass on all three stores without manual grant preloading or a worker
restart to acquire the key. The following terminal milestone adds management
and actual encrypted PTY service flows. Movement/deletion, terminal transports,
shared coordination, supported-platform acceptance and packaging remain required
by the replacement goal.

```sh
node --import tsx scripts/server-rust/maintenance-repository-compatibility.mjs --report .qa/rust-server/maintenance-repository-pglite.json
node --import tsx scripts/server-rust/maintenance-http-compatibility.mjs --report .qa/rust-server/maintenance-http-pglite.json
```

Repeat with `--database bundled-postgres` and `--database postgres`. The latter
HTTP suite exercises the actual locks and shutdown faults.

All 98 native tests and strict all-target Clippy pass locally. Existing worker,
command-quota and folder HTTP regressions also pass. The production native
PGlite HTTP matrix passes with an observed 1 MiB main-stack limit.
The standard `pnpm check` passes typechecking and the server/app/protocol suites,
then fails two existing worker worktree tests. A focused current run passes all
ten tests; a clean retained baseline still reproduces the filesystem failure.
All 2,072 compared Node server, worker, shared and dependency files are identical
to that baseline; the earlier baseline receipts also retain both failing tests.
The repository-wide check is not reported as passing.

## Workspace catalog, repository discovery and imports

The native server now implements all eight workspace catalog, attached-root,
scan and import routes. Encrypted names, active key revisions, default promotion,
immutable worker/root bindings, revision conflicts, candidate classification,
checkout/GitHub conflicts and file-preserving workspace removal use native
repositories. Import completion creates the user-owned direct project, external
Primary and workspace membership in one transaction. Late constraint failures
roll back the whole completion; retrying the identical completion succeeds.

Discovery scans and imports share one executor slot, with scans taking priority.
The unchanged worker receives protected routing handles over its existing
command socket. Scan requests have no fixed command deadline; import validation
retains its 60-second deadline. Both retain the production two-minute lease,
30-second renewal/recovery and bounded retries for actual command quota errors.
Caller disconnect does not cancel an admitted mutation. Shutdown drains admitted
work while the database remains open, and startup/worker reconnect recovers
unfinished scans and imports with the existing attempt/revision fences.

Local macOS evidence covers all three stores: 241 repository observations and
73 SQL snapshots each, 6,590 exact source validation cases across 18 roots, and
all three authentication modes with 68/68/72 HTTP observations per runtime when
lifecycle cases are enabled. Real worker reconnect, missing capability, explicit
retry and shutdown recovery match the reference. Separate tests hold scans
through the real lease deadline and reject a stale attempt before actual expiry
and sweep recovery; production clocks and SQL lease timestamps are unchanged.

Admitted root attachment survives a real HTTP client abort on every store.
External PostgreSQL tests use actual blocking SQL and backend identities to
prove concurrent same-revision admission returns one 202 and one 409, and that
an admitted catalog insert survives client disconnect and shutdown. Raw
pg_stat_activity witnesses are retained separately from normalized comparisons.

The actual encrypted browser APIs and full built worker attach a disposable
root, discover/import a local Git checkout, and link its existing public GitHub
origin without pushing. Project/source/Primary identities, Git refs and dirty
bytes survive conversion and server restart. Removing the workspace while the
worker is offline removes catalog records and preserves every worker file.
This flow passes for PGlite, private PostgreSQL and external PostgreSQL without
seeding project catalog rows or substituting worker commands.

The generic source oracle now supplies baselines for all 324 registered native
roots, including 69 previously missing Run/worktree/provisioning roots. A real
empty-revision Run refinement mismatch was corrected to preserve JavaScript
truthiness; all 112 dedicated definition cases pass. The full generic suite now
passes 296,220 exact source comparisons and 69,648 ECMAScript JSON round trips
locally. Discovery CI is configured for Linux, macOS and Windows;
this milestone has not yet run there. Full managed execution/removal consumers,
shared coordination, packaging, migration and final default cutover remain open.
Normal app/server packaging still selects the Node server and Node worker.

## Managed-folder provisioning

Native folder creation now includes default workspace/storage bootstrap,
membership, queued setup jobs, transactional claims, revision and command fences,
lease renewal, recovery, retry and source/Primary-root completion. The server
dispatches up to four jobs through the existing worker protocol. Reconnecting a
worker resumes retryable blocked jobs. Shutdown stops new admissions and drains
owned callbacks and active jobs before closing storage. Post-response project
invalidations retain the existing creation and retry notifications.

The worker-scoped encrypted repository-operation route also runs natively.
Private path registration and resolution use the existing browser encryption and
full worker implementation; the server routes ciphertext and opaque handles.
Project/worktree agent operations still require their separate native consumers.

Repository comparisons inspect seven complete SQL tables and rejected-write
snapshots: 56 cases and 33 snapshots pass on all three stores, including missing
storage profiles, managed defaults and attached-default repair. Real
HTTP/worker-transport tests require nonempty ordered project Live
events and verify tenant isolation, the four-job admission windows and retained
restart. Independent jobs can reach the worker in different orders while their
asynchronous lookups run; raw arrival order is retained, with exact per-project
attempts and admission windows checked separately.

The local HTTP matrix passes 104 observations per runtime on PGlite/private
PostgreSQL and 106 on external PostgreSQL. A real membership INSERT stays locked
after its caller disconnects and shutdown begins; releasing the lock commits the
project, membership and queued job, which remain after restart. A held worker
command also observes the actual 30-second lease renewal without changing its
command, attempt or revision. Shutdown during dispatch retains a retryable job;
worker reconnect completes a new attempt. The native PGlite HTTP matrix also
passes with the production process limited to a 1 MiB main stack locally.

The actual-client harness runs the existing browser account, durable encryption,
project and repository APIs against each server and the full built Node worker.
It creates real worker directories, attaches an existing folder without changing
its file, repairs an actual missing path and retries, resumes an offline job on
reconnect, and reopens encrypted labels and completed jobs after server restart.
Names and paths are checked for absence from server request bodies. The browser
now authorizes and refreshes the repository grant through the normal existing
client flow without restarting the worker. These are focused product
flows, with full UI, project/worktree routes, shared coordination, supported
platforms and packaging still required.

All nine product steps pass locally against both servers on all three stores.
The full native suite passes 96 tests across 45 targets, including 156,132 actual
protocol cases and 203,929 outgoing-command mutations. The original full-worker
catalog flow passes again on all stores after sharing worker supervision.

```sh
node --import tsx scripts/server-rust/folder-repository-compatibility.mjs --report .qa/rust-server/folder-repository-pglite.json
node --import tsx scripts/server-rust/folder-http-compatibility.mjs --report .qa/rust-server/folder-http-pglite.json
node --import tsx scripts/server-rust/actual-folder-client.mjs --report .qa/rust-server/actual-folder-client-pglite.json
```

Repeat with `--database bundled-postgres` and `--database postgres`. The actual
client suite uses the same built worker, CLI and Chromium setup as the catalog
flow below. Configured CI is not passing platform evidence; the coverage ledger
records the accepted scope.

## GitHub conversion execution in progress

The native conversion repository, two-job executor and all four preflight,
start/status/retry routes are implemented. Protected repository and commit
handles remain opaque. Preflight binds the chosen source and worker rather than
trusting worker-supplied response identities. Admission, retry, lease renewal,
restart recovery, completion fences and the existing Live publications preserve
the source behavior. Completion updates the existing source, Primary worktree,
project origin and job in one transaction; user ownership and identities remain.

Local macOS repository comparisons pass 124 cases and 44 snapshots on all three
stores. They cover actual last-write constraint failure and rollback, stale
attempts, source ownership/path/Primary drift and repository collisions. HTTP
comparisons now pass all nine storage/auth combinations: 67 observations per
runtime in anonymous/password mode and 72 in account mode, with nine base worker
commands and eight base job Live invalidations each. Malformed worker preflight
results return matching 502 bodies.
Managed folders are created through real HTTP/worker materialization. For the
external Git branch, existing workspace-discovery ownership metadata is prepared
with the server stopped: legacy from-folder attachment currently records Cantrip
ownership in the reference and cannot stand in for a user-owned discovery import.
This fixture boundary is explicit; it is not proof of the actual external-source
discovery flow. The separate managed-folder product flow below uses the full client
and worker without catalog seeding.

The capacity and active-command shutdown extension also passes every combination.
It records five additional execution commands: three conversions admit two held
running jobs and one queued job, releasing one slot dispatches the third once,
and all complete on attempt one. Shutdown retains an interrupted conversion as
the same blocked worker-offline job at attempt one/revision three. Restart and
worker reconnect complete it once at attempt two/revision six, with one recovery
Live invalidation. Strict all-target Clippy/format checks,
large-file checks and four focused reference tests pass. Current reports are
`conversion-repository-pglite-v6.json`, `conversion-repository-{postgres,bundled}-v2.json`
and `conversion-all-auth-{pglite,postgres,bundled}-v1.json` under `.qa/rust-server/`.

Production lease tests now pass on all three stores without fake clocks or SQL
lease mutation. A held worker command remains attempt one/revision two beyond its
original two-minute lease, and is dispatched once. A stale ready result remains
running until the real sweep recovers it; attempt two succeeds at revision five.
Both jobs publish exactly their expected job Live revisions.

Actual external PostgreSQL lock tests pass anonymous, password and account modes.
Two same-project starts return 202/409; distinct projects claiming one repository
return 202/500 with the reference private error contract. Each race persists one
job. The joined `SKIP LOCKED` claim can skip the first job while the losing
admission retains its project lock in either runtime; a following admission is
the real dispatcher wake-up used by this test. The harness records this behavior
instead of asserting immediate dispatch. A disconnected caller retains the same
blocked INSERT. Shutdown waits for its commit, leaving queued attempt zero/
revision one; restart blocks offline at attempt one/revision three and reconnect
completes the same job at attempt two/revision six.

The existing encrypted browser APIs and full worker now complete a real GitHub
conversion on all three stores, with 12 product steps per runtime. A fresh managed
folder receives matching public GitHub history in its disposable worker directory.
Preflight selects `remoteAction=link`; execution preserves uncommitted file bytes,
remote refs and the project/source/Primary identities, publishes job revisions
`[1, 3]`, and retains the converted state through server and worker restart. There
are no SQL fixtures or command substitutions in this flow. It performs public
reads and linking, without repository creation or push. Actual external user-source
discovery and managed-folder push/initial-commit product flows remain required.

The macOS and Windows replica CI jobs also exposed a pending-observation shutdown
wait. An unanswered real observation command reproduces the Rust failure locally
at the original 15-second deadline. Shutdown now stops observation admission,
closes the worker bridge, then drains their owned persistence tasks before storage
closes. The same regression passes on all three stores without extending its
deadline or cancelling work. The platform matrix still must verify this fix.
The Linux contracts job separately failed because the real Run retirement probe
did not produce its termination marker under Node; its cause remains unresolved.

```sh
node --import tsx scripts/server-rust/conversion-http-compatibility.mjs --database pglite --profile none --leases --report .qa/rust-server/conversion-real-leases-pglite.json
node --import tsx scripts/server-rust/conversion-http-compatibility.mjs --database postgres --lifetimes --report .qa/rust-server/conversion-http-lifetimes.json
node --import tsx scripts/server-rust/conversion-http-compatibility.mjs --database pglite --profile none --lifecycle --observation-shutdown --report .qa/rust-server/conversion-observation-shutdown-pglite.json
node --import tsx scripts/server-rust/actual-folder-client.mjs --database pglite --github-conversion --report .qa/rust-server/actual-github-conversion-pglite.json
```

Repeat the lease, observation and product suites with `--database postgres` and
`--database bundled-postgres`. The independent conversion CI job configures the
three supported operating systems and all stores; configuration is not evidence
that those jobs passed. Further source/failure cases, supported-platform results,
packaging, migration/rollback and multi-instance acceptance remain required.

PR #2348 Windows CI stopped in a project-surface test probe when its blocker
count matched but `wait_event_type` was null. The surface and workspace probes
now poll for the complete count-plus-Lock witness before releasing their real
SQL lock, retaining every assertion and the ten-second deadline. Both complete
local concurrency/shutdown suites pass. This is not Windows acceptance; the
platform matrix must still run the updated probes.

## Project replica execution in progress

The native replica domain now includes durable admission, payload fingerprints,
revision and command fences, source/worktree completion, lease scheduling,
worker reconnect, and the catalog/job/retry/cancel/link-repair routes. Protected
GitHub import retains opaque repository handles and the existing separate
project-creation and job-admission transactions.

Local macOS comparisons pass all three stores for repository lifecycle
(52 cases/9 snapshots), admission (72/7), and completion (39/19). The HTTP
validation and offline-import suites each pass 18 observations per runtime and
authentication profile. Connected transport plus failure recovery passes 43 HTTP
observations, eight worker commands and 21 job Live events per runtime/profile.
It holds a command while checking durable progress, rejects stale progress,
provisions and synchronizes replicas, repairs a managed link, removes a second
replica, protects the final source, and recovers a worker-blocked job through a
failed retry and successful retry. Both anonymous and account profiles run.

The reconnect extension passes all three stores: 47 HTTP observations, nine
worker commands and 25 job Live events per runtime/profile, including exactly
one dispatch after an offline attempt resumes on reconnect. Real-time renewal
and stale-completion recovery also pass all three stores: 53 HTTP observations,
12 commands and 32 job Live events per runtime/profile. A held command stays on
attempt one beyond its original lease; a stale completion expires and recovers
exactly once on attempt two. Active-command shutdown/restart passes all three
stores in both auth profiles: the held first attempt survives as a retryable
worker-offline job, then reconnect completes attempt two with exact Live revisions.
A second-account extension passes all three stores with 61 account-profile HTTP
observations (50 in anonymous mode), including all ten replica/job routes denying
foreign access, unchanged owner state and no extra worker dispatch.
Repository removal comparisons also cover extra worktrees, chats, terminals,
Explorer and Code tabs, project views, and active/released execution lanes.
Converted-folder retention and deletion pass all three stores in both auth
profiles (56 anonymous/67 account HTTP observations, 12 commands). Completed
conversion records are seeded while the server is stopped; production routes
then detach without a worker command or run folder deletion through failure and
retry. Restarted database reads confirm source retirement, missing worktrees and
matching deletion timestamps, including an already absent folder. A real worker
heartbeat is sent on reconnect; command sockets alone do not refresh presence.
The capacity comparison also passes all three stores: five admitted jobs yield
four held running attempts and one queued attempt, releasing one slot dispatches
the fifth once, and all five finish on attempt one. It records 57 anonymous/68
account HTTP observations per runtime. Controlled handlers return distinct
worker paths; a copied-database reproduction retains the real source-path
ownership rejection from the initial fixture.
An actual encrypted browser/two-full-worker local Git flow now passes on all
three stores (12 product steps per runtime). It uses real direct checkout
attachment, exact admission replay, retained replica identity after server and
worker restart, refused user-checkout deletion, and detach with Git files intact.
No catalog, repository or worker handler is seeded for this flow. The existing
AppLiveClient receives the same per-job sequences from both servers, including
unchanged completion revisions published by exact admission replay. The comparison
function also passes against all six saved runtime reports.

The first PGlite run timed out during Node startup before product steps; an
isolated same-mode startup passed in 6.3 seconds, without proving the cause.
A second run completed the Node flow but killed a full worker 30 seconds after
SIGTERM in the Rust case, despite its shutdown-completed log at 853 ms. No worker
handle trace was available for that failure. A later traced run identified the
late-observation watcher defect fixed below; attribution of the earlier untraced
hang remains unproven. Test-only handle tracing and complete server shutdown-stage
retention support further investigation. The startup timeout remains unresolved.

The managed GitHub extension uses real public `octocat/Hello-World` reads and
clones through `gh`, the encrypted browser API, and both full workers. The latest
comparison passes 17 product steps per runtime on all three stores: import,
exact-revision second replica, synchronization, ignored-user-file rejection, and
retry/removal with the primary retained. Both dirty and ignored checks remain
unchanged. The initial PGlite failure is retained: its ignored CodeGraph cache
blocked removal despite clean Git status.

Worker replica deletion now invokes CodeGraph retirement only after existing
checkout path/ownership checks. Retirement fences reconfiguration, aborts and
drains the current CLI through actual process close, and executes managed
`uninit --force` before the existing Git checks. It also works before first
observation after restart. Cleanup failure does not replace the filesystem
operation's result; the actual dirty/ignored checks still run. A blocked removal
resumes observation. A successful removal forgets the retired path. No ignored
file allowlist or force-delete bypass was added.

The v4 PGlite/Rust run observes two real retirement events in the previously
failing cache case. Latest v5 also records real retirements on Node/PostgreSQL
and Rust/private PostgreSQL; all six runtime/store flows preserve the injected
ignored user file, then remove only the secondary checkout on attempt two.
Forty-six focused CodeGraph/Git safety tests and the worker build pass, including
real delayed-SIGTERM process drain, reconfiguration fencing, cleanup before first
observation, optional-tool failure, symlink preservation and denial before the
removal lifecycle. The 11 worktree tests also pass.

The extended run also captures two referenced filesystem watchers on a retiring
checkout and `.git` after the worker logged shutdown completion. WorktreeManager
accepted a late observation configuration after close. A child-process regression
first proves configuration completed and then reproduces both persistent watcher
handles; a permanent observation-close flag fixes that lifetime defect. All 11
worker worktree tests and the full worker build pass. Earlier trial regressions
that timed out before configuration completed are retained as invalid leak
proof; the measured failing/passing process regression is the evidence. Server
shutdown deadlines and the worker's 30-second shutdown assertion are unchanged.

Controlled HTTP admission and lifetime comparisons now pass on external
PostgreSQL for Node and Rust in anonymous and account modes. Five forced races
cover identical provision keys, competing keys for one worker, a reused key with
different worker payloads, and identical/distinct synchronization keys. Both
requests reach the actual blocked INSERT or source-row lock before release;
each case verifies exact conflict bodies, one durable job and exact later replay.
The PostgreSQL activity view truncates the reference's long SELECT projection,
so its actual blocker PID and lock wait establish the source-row boundary.
Synchronization's unsafe cancellation is refused; normal worker reconnect then
completes its second attempt. A disconnected admission still commits, and an
admission disconnected during shutdown retains one queued job at attempt zero,
revision one. Restart dispatches that same job once and replay returns its
canonical blocked result. Evidence: `replica-http-lifetimes-v5.json`. These
cross-session lock cases deliberately use external PostgreSQL; the other suites
continue to exercise all three storage modes.

Remaining placement/failure product flows and supported-platform acceptance
remain required before completing this domain.
Existing platform CI shutdown failures remain unresolved; local comparisons do not prove
packaged or Winterhold readiness. Fixed native shutdown-stage diagnostics now
record drain names, start/completion and elapsed time without changing ordering
or timeouts. Full-worker catalog reports retain these stages on success and
failure to locate stalled drains. The default server remains Node.

```sh
node --import tsx scripts/server-rust/replica-import-http-compatibility.mjs --connected --faults --reconnect --report .qa/rust-server/replica-connected-pglite.json
node --import tsx scripts/server-rust/replica-import-http-compatibility.mjs --connected --faults --reconnect --lease-recovery --report .qa/rust-server/replica-lease-pglite.json
node --import tsx scripts/server-rust/replica-http-lifetimes.mjs --report .qa/rust-server/replica-http-lifetimes.json
node --import tsx scripts/server-rust/actual-folder-client.mjs --replicas --report .qa/rust-server/actual-replica-product-pglite.json
```

Repeat with `--database postgres` and `--database bundled-postgres`. The lease
scenario uses the production two-minute expiry and 30-second timers without
clock substitution. The Live test client sends ordinary heartbeat pings throughout
the wait. These local results do not establish supported-platform acceptance.

## Project catalog and execution placement

The Rust server implements the four project catalog/placement routes: project
listing, placement selection, execution-target listing and explicit target
resolution. All seven surface kinds retain their existing ownership, context,
readiness and capability rules. Worker-bound folders and local Git projects
preserve their source restrictions. Protected labels and surface state stay
opaque. Stored resource projections preserve validation failures even when the
catalog does not display the invalid field.

Actual Node/Rust comparisons pass on native PGlite, private PostgreSQL and
external PostgreSQL: 165 placement cases and nine catalog cases, 86 target
repository cases plus one rejected SQL constraint, and 129 HTTP observations per
runtime across anonymous and account profiles. HTTP cases use the unchanged
Node WorkerConnection after real enrollment and credential rotation, covering
connected/offline presence, all target/surface types, owner isolation, errors,
HEAD and retained restart. Background worker commands use an explicitly
unsupported metadata-fixture handler; these cases do not execute filesystem,
chat or model operations.

Sixty-two additional comparisons execute the actual TypeScript descriptor
builder, checking serialized property order, Unicode, resource filters,
availability and the 2,000-target limit. In-memory identifiers preserve UTF-16;
SQL-bound identifiers preserve PostgreSQL's UTF-8 replacement behavior. Six new
protocol roots and four native refinements bring the actual protocol comparison
to 150,879 cases. Existing project mapping and Live authorization read suites
pass again on all three stores after the shared replica mapper extraction. A
local native PGlite process limited to a 1 MiB main stack completes schema
startup, 45 seed writes, catalog composition and all seven surface resolutions.

Supported-platform CI for this group is configured; acceptance is still pending.
Presence checks currently use the local worker bridge. Redis/multi-instance
coordination, project/resource mutations, execution, full client/UI flows and
packaged operation remain required by the replacement goal.

Mutation audits now begin after body completion rather than delaying the HTTP
response. An owned admission retains the audit through its deferred write, and
shutdown drains those admissions before closing the database. HEAD discards
complete their audit while preserving the GET body's size hint and Content-Length.
Response errors also complete audits; abandoned unfinished bodies do not. Explicit
in-handler authentication audits retain their existing timing.

A real PostgreSQL relation lock proves that Node and Rust both return the
original HTTP 400 while the audit INSERT waits, retain it during shutdown,
commit after release and reopen with one correlated row. A rejected audit INSERT
preserves the HTTP response and permits clean shutdown/reopen. The local security
matrix passes 387 comparisons per store across anonymous, password, account and
administrator profiles on native PGlite, private PostgreSQL and external
PostgreSQL, including exact HEAD Content-Length. Eight body-lifecycle tests and
all 96 native tests pass; strict all-target Clippy passes. Platform acceptance
remains required.

The security harness observes the actual Node onResponse hooks and audit
completions, then observes correlated Rust rows before the next scenario. Full
audit lists, IDs, ordering and cursors remain exact comparisons. Test-only
observation does not replace handlers, reorder responses or introduce a server
runtime JavaScript dependency.

The actual Linux worker flow exposed an embedded desktop backend signal handler
that called `process.exit(143)` before Cantrip could drain its services. The
worker now opts out of that backend's SIGINT/SIGTERM handlers through a narrow
dependency patch. The cross-process session lock and normal-exit lock cleanup
remain enabled; standalone library callers retain their original signal
behavior. Four subprocess cases exercise the real desktop client, both signals,
Cantrip's completed asynchronous close, and the standalone exit codes. The SIGTERM
case reproduces the original failure before the patch; all four cases pass
locally afterward.
On Windows the subprocess test invokes the actual registered Node listeners
over IPC, since process termination cannot deliver Unix signal handlers.
Supported-platform execution and full-worker acceptance remain required.

The existing browser account/provider API modules and AppLiveClient now run a
real Ollama catalog operation through each server and the full, unchanged built
worker entrypoint. Local macOS runs pass eight product steps per runtime on
native PGlite, private PostgreSQL and external PostgreSQL: account/session setup,
worker enrollment and command readiness, committed Live notification, provider
creation and discovery, retained catalog while stopped, persisted-credential
worker restart, stale-catalog behavior after an actual Ollama HTTP 503, and
recovery. Catalog capabilities, worker-scoped availability, sync state and model
identity are checked through the existing client. The test builds the native
Cantrip CLI required by worker startup; no worker command handler is replaced.
All twelve worker processes exit cleanly on macOS. The installed Codex runtime
is advertised as incompatible; this flow does not execute Codex or a model.
Windows process termination does not exercise Node's Unix shutdown handlers.
Supported-platform CI is configured but remains unaccepted. Full UI, execution,
packaging and deployment acceptance are still required.

```sh
pnpm --filter @cantrip/worker build
node --import tsx scripts/server-rust/actual-worker-client.mjs --report .qa/rust-server/actual-worker-client-pglite.json
node --import tsx scripts/server-rust/actual-worker-client.mjs --database bundled-postgres --report .qa/rust-server/actual-worker-client-bundled.json
node --import tsx scripts/server-rust/actual-worker-client.mjs --database postgres --report .qa/rust-server/actual-worker-client-external.json
```

Build shared workspace packages and install Chromium as for the existing
browser harness. The PostgreSQL modes use `CANTRIP_TEST_POSTGRES_BIN_DIR`.
Every worker uses a disposable data directory and its real startup, enrollment,
transport, command dispatcher and catalog implementation.

Global settings reads and provider create/update/delete now use native services.
Settings reads reconcile the bundled Z.ai catalog before returning their snapshot
and start account/Ollama discovery without delaying the response. Provider
mutations preserve opaque keys, initial-account validation, hydration ordering,
cache invalidation and the account sign-out sequence before deletion. Admitted
operations and background catalog work retain their existing shutdown drains.

Local Node/Rust socket comparisons pass 99 observations per storage mode across
account and local authentication. They include real account-insert rollback,
rejected provider updates, retained writes after a later runtime-detach failure,
model deletion restrictions, built-in discovery and restart. Generated discovery
IDs are checked for UUID format and model/route/default relationships before
normalization. SQL error context is attached only after the actual failed query.
External PostgreSQL additionally holds a real provider UPDATE behind a row lock,
disconnects its caller and requests shutdown. Both runtimes wait for release,
commit the update and reopen with its value retained (103 HTTP observations).
The local native suite passes 92 tests across 44 targets and strict all-target
Clippy passes. Supported-platform acceptance and remaining settings/provider
operations are still required.

The provider telemetry milestone implements the analytics, export and deletion
routes natively. Quota attribution, pending consumption, confidence, calendar
and locale breakdowns, period comparisons and all eight change metrics retain
the existing calculations. Reads preserve owner and query scopes, historical
accounts, prior-reading selection and per-account sampling. Exports contain
opaque dimensions and structured evidence; deleting four history tables is one
transaction and preserves current account projections.

Local comparisons pass 56 repository observations and 102 HTTP observations on
each of native PGlite, private PostgreSQL and external PostgreSQL. A further
external PostgreSQL scenario holds a real lock on an admitted DELETE, closes
the caller and shuts down the server. Both implementations wait for release,
commit all four deletes and reopen with the deletion retained (104 external
PostgreSQL HTTP observations in total). Valid structured telemetry at depths
100, 150 and 300 passes through JSONB reads, analytics and exports without
Serde's intermediate recursion limit. The fixtures give ordered rows distinct
timestamps because the source SQL defines no order within timestamp ties;
response comparisons remain exact. The native
statistics, quota and change helpers are compared directly with the current
TypeScript helpers; protocol responses use three additional generated roots.
The current local all-target Rust suite passes 92 tests across 44 targets, with
strict all-target Clippy and native formatting passing. Supported-platform
acceptance is still required.
Execution-domain telemetry writers, packaged operation and complete replacement
remain in scope.

PR 2293's Windows run passed the earlier rounding regression, then terminated
the settings repository fixture with a stack overflow. Local bounded-stack
replays reproduced nested future allocation failures. The adapter and shared
settings/provider refresh seams now keep those futures on the heap. All 768
existing settings comparisons pass with the native process limited to a 1 MiB
main stack, and a native regression performs real settings reads and rejected/
committed updates on a 1 MiB thread. No runtime stack allowance was increased.
PR 2294's Windows run completed all 768 settings comparisons on each of the
three stores at `fc5b06aac`, accepting that fixture's stack fix. It later failed
the telemetry private-PostgreSQL suite's generated-timestamp assertion in the
unmodified Node reference before starting Rust. The failed timestamp and request
bounds were not retained. The repository comparison now records the runtime,
actual timestamp, parsed milliseconds, request wall-clock bounds and monotonic
elapsed time before checking the same inclusive bounds. Both implementations and
their full state comparison now run before timing validation, so a reference
clock observation cannot prevent the actual Rust comparison from executing.
Later Windows receipts retain matching repository results from both runtimes,
while generated timestamps can exceed the parent process's after-reading by
one or two milliseconds. The repository fixtures now take independent wall-clock
and monotonic readings immediately around the actual operation inside each
producer process. The same strict inclusive predicate validates generatedAt
against those producer readings. Original parent readings and their predicate
remain in every timing report; production timestamp generation is unchanged.
Boundary controls accept exact endpoints and reject even one millisecond outside
the producer interval, including when parent bounds would accept that value.
Local comparisons pass all 56 repository observations and 27 generated-timestamp
checks per runtime on each of the three stores. Windows run 40711050999 passes
all three repository suites and the strict clock controls. Its later private
PostgreSQL HTTP suite fails the parent-clock assertion in the Node reference;
the failed timestamp and bounds were not saved, and Rust was not reached.

The HTTP comparison now retains raw generatedAt/range.to values, parent
wall/monotonic readings and their original predicates before timing assertions.
Opt-in Node request hooks and a development-only Rust example record independent
producer clocks correlated by the actual request ID. The example includes the
unchanged production main source and wraps its actual router; it preserves the
CLI, storage initialization and shutdown paths. Rust records the real router's
request/response-construction interval; Node records its onRequest/onResponse
interval. These JSON handlers generate timestamps within those intervals.
Both runtimes complete the HTTP/Live and retained-state comparisons before the
same strict inclusive predicate checks producer bounds. No production timestamp
generation or tolerance changes. The normal entrypoints emit no clock receipts;
12 real HTTP controls cover enabled/disabled observation and reject eight values
one millisecond outside actual producer intervals. Supported-platform acceptance
of the HTTP measurement change and complete replacement remain required.

The audit milestone's repository-wide check passes the Node server's 1,616 tests, the app's
3,899 tests and all type checks, but fails four worker cases: Grok login,
history-outbox replay, filesystem status observation and the PNG size boundary.
Focused runs of those four files on this revision and the retained clean baseline
each pass 67 cases and reproduce the filesystem observation failure; the other
three sweep failures do not reproduce in either focused run. Worker source and
dependencies are unchanged by this milestone. The 12 repository-wide formatting
failures are byte-identical to the baseline. Original failures and baseline
results are retained without changing assertions or limits.

The outgoing worker envelope now has native validation and normalization before
bridge admission. Its development oracle exercises the actual TypeScript
protocol for every command type and reachable union alternative; large boundary
cases and real HTTP/WS admission comparisons supplement malformed mutations.
Local admission comparisons pass on all three storage modes with unchanged
worker transport components and controlled handlers. PR 2287 merged, and its
Linux/macOS jobs and 70 uploaded JSON reports passed inspection. Windows reached
the configured 60-minute job limit during worker PGlite HTTP tests, with earlier
steps passing. That attempt does not establish full Windows acceptance. PR 2288
raised the allowance to 120 minutes and its complete descendant
[run 40492875845](https://github.com/ArcaneArts/Cantrip/actions/runs/40492875845)
passed Linux, macOS and Windows. All 141 uploaded JSON reports were inspected,
artifact SHA256 digests verified, and native coverage receipts retained. That
run accepts the command and usage scopes at its head; the earlier cancelled
Windows attempt remains part of the historical record.
This is wire-contract coverage; resource-domain and execution behavior remain
in scope below.

The full objective is a Node-free Rust server supporting desktop-packaged and
standalone operation, with PGlite, bundled private PostgreSQL, and external
PostgreSQL. The existing app, worker, CLI, browser and mobile contracts remain
the compatibility baseline. Winterhold readiness and desktop packaging are
required before completion. Production deployment is a separate action.

## Policies

The policy domain now executes in Rust: public packaged templates, encrypted
bootstrap, opaque CRUD, collection ordering, workspace/project assignments,
assignment counts, and IDE/standalone effective-policy resolution. Owner,
collection and row-version conflicts preserve their transaction boundaries.
Ordering compares original JavaScript UTF-16 identifiers; SQL binding converts
only at PostgreSQL's UTF-8 boundary. Policy content remains opaque, including
blind indexes and authenticated encryption metadata.

Successful HTTP mutations publish one owner-scoped policy invalidation after
the response body completes. Empty responses complete without a body frame;
partial or failed body streams do not publish a success event. Mutations that
return an error do not publish. Shared multi-instance coordination and resource
publishers in unported project/workspace/chat domains remain required.

Local macOS evidence includes 62 actual Node/Rust repository comparisons per
store on native PGlite, private PostgreSQL and external PostgreSQL. Nineteen
cases per store retain exact before/after snapshots proving transactional
rollback, including an injected assignment-insert fault. Cases also cover
owner isolation, limits, cascade deletion, source ordering and process reopen.
The real HTTP/Live suite passes 80 observations per runtime on each store,
including concurrent optimistic updates, CSRF, error bodies, original UTF-16
equality, invalidation counts and foreign-subscriber isolation. Existing client
crypto encrypts and decrypts both fields, rejects a wrong owner or row, and
verifies exact ciphertext after restart; component keys never reach the server.

Oversized versions exposed a real mismatch between early Rust integer
conversion and Node's PostgreSQL errors. Native operations now let the database
perform integer conversion, including next-version and position overflow.
The failure matrix preserves the existing query-error contexts for policy
count, position, order, assignment, initialization and post-delete increment
errors. It proves that a failed transaction restores deletion and that updates
and bootstrap claims committed before a response-projection failure stay
committed. Sixty-three method/path comparisons per runtime/store also preserve
Fastify's method-specific literal/parameter route selection. Sequential
Node/Rust/Node operations on one external database retain encrypted Rust writes,
assignments and version counters, and the unchanged Node repository continues
writing afterward. Full-server rollback and existing PGlite conversion remain
required. These checks do not establish supported-platform or packaged
acceptance.

Templates, their source hashes and limits are embedded from the actual public
Markdown collection, with a source-drift test. Thirteen additional schema roots
bring the current protocol manifest to 67 roots/5,409 nodes; the actual protocol
oracle passes 67,389 validation cases. Four body-completion tests and the final
full native regression suite pass locally, as do all-target Clippy and Rustfmt.
The complete repository check passes server, app, protocol and crypto tests but
exits on two unchanged worker failures: filesystem notification debouncing and
the image adapter's exact 2.5 MiB timeout. A focused rerun passes 37 tests,
including the image boundary, and reproduces only the filesystem case. Its
unchanged source hashes and earlier baseline failure evidence are retained;
assertions and timeouts were not relaxed. Supported-platform acceptance remains
required for this milestone.

Project/workspace rows in the policy harness are seeded fixtures. This does not
port their CRUD, the app settings UI, or chat/native execution consumers. Legacy
PGlite conversion, full post-write rollback, desktop packaging and Winterhold
delivery remain part of the original replacement goal. Node is still the
production entry point.

## Account resource usage (merged; accepted on three platforms)

The usage milestone implements native storage measurement from the actual
110-table ownership manifest, exact decimal bandwidth counters, idempotent
transactional flush receipts, fenced reconciliation, hourly/daily history,
rollup/retention and operational totals. It also adds bounded asynchronous
metering, live quarter-second traffic samples, response projections and the
three authenticated account usage HTTP routes. All operations execute in Rust;
JavaScript is used only by development exporters and comparison oracles.

HTTP request/response bodies, App Live frames and worker control text frames
feed the native meter. Stream completion, error and destruction count one
operation while retaining consumed bytes. Usage-observer traffic avoids another
refresh, and the live-traffic route excludes its own payloads and request count.
Storage reconciliation and history maintenance start after binding the listener;
shutdown waits for their in-flight work and drains bandwidth before closing the
database. Coalesced owner invalidations follow committed storage/bandwidth work.

Local evidence includes 42 actual Node/Rust repository comparisons on each of
the three stores, with precise counters, duplicate/overflow rollback, injected
rollup/lease faults and retained process reopen. Native state comparisons cover
209 meter scenarios, 127 live-traffic scenarios and 58 response projections.
Timer/close, background drain, coalescing capacity and stream cancellation/error
tests supplement those comparisons. Production-entrypoint HTTP suites pass 33
cases per runtime on every store, including exact post-shutdown persistence.
Production socket suites on all stores compare their observed frames with
durable counters and observe a real usage publication without a refresh loop.

The socket accounting proof is per runtime: Node still emits additional worker
commands and resource notifications whose domains remain unported. The suite
does not claim those absolute frame totals or full worker-domain behavior match.
Account-isolation/restart checks pass 14 cases per runtime on each store,
including distinct retained large counters and rejected owner injection. The
shared query parser also matches 72,298 actual Fastify cases and preserves
malformed escapes in validation errors. PR 2288 passed observed
Linux/macOS/Windows CI; all 141 reports and native
coverage receipts were inspected and archived. Whole-server metrics integration,
future binary/domain transport hooks and complete product acceptance remain
open. This milestone is not a complete server replacement or packaged/deployment
acceptance.

## Foundation

`cantrip_server_rs` currently contains native database execution, the existing
SQL migration chain and Drizzle journal, private PostgreSQL provisioning, and
the foundation HTTP routes, version/bootstrap responses, and account/session
authentication. Other domains remain unported. The existing Node service
remains the production entry point.

The compatibility harness launches the actual Node service and Rust executable
on ephemeral ports with isolated database roots. It compares JSON bodies,
status codes, content types, HEAD behavior, method handling, unknown routes and
trailing slash handling. Only timestamps and measured latency are normalized;
their types and ranges are validated. It also restarts Rust and requests actual
database readiness. Its report explicitly does not assert full replacement.

The database contracts execute all existing migrations, inspect every journal
hash and timestamp, rerun without replaying migrations, exercise JSONB and bound
parameters, constraints, commit, rollback, cancellation rollback and LISTEN /
NOTIFY, and verify retained data after reopening in a new process. PostgreSQL
tests start a real private cluster and also invoke the executable in external
connection mode. They never connect to a developer's ordinary database.

PostgreSQL request operations now lease up to five connections, matching the
reference pool, while PGlite retains its single serialized session. A separate
LISTEN connection restores established channels after an actual connection
failure. A cancelled or incomplete pooled operation keeps its pool slot during
a bounded CancelRequest attempt, then discards that session. Statements are
not automatically replayed. Shutdown closes admission, wakes queued borrowers,
stops the listener and drains operations, cancellation cleanup and drivers.

Worker authentication has a separate shutdown drain before pool closure. A
closed worker socket still completes credential usage and its owner lookup,
including work queued behind the five PostgreSQL connections. The external
worker fault suite holds the real credential row, closes 32 pending sockets,
requests server shutdown, and verifies that shutdown waits for lock release.
A trigger in the disposable database then proves all 32 usage writes committed.
The native server previously exited while that lock remained held and lost
those writes; the actual Node service waited and retained them.

`tests/postgres_pool.rs` exercises real relation locks, unrelated concurrent
reads, all five busy connections plus a listener, cancelled transactions,
backend termination, listener restoration and shutdown. The real HTTP/TLS
harness compares eleven SSL-on/off configurations against postgres-js and the
Node/Rust services, checks actual `pg_stat_ssl`, and keeps `/api/workers`
blocked while `/api/account/sessions` completes over a TLS server connection:

```sh
node scripts/server-rust/postgres-connections.mjs --report .qa/rust-server/postgres-connections.json
```

The Live lock fault checks the actual blocking backend and verifies that its
granted table lock survives transport ping and close, with no subscription
reply. It retains the authorizer backend's post-close state separately: Node
may keep it waiting, while Rust may already have cancelled and disposed it.
Requiring the abandoned query to remain blocked made the older assertion race
with successful cancellation; the actual lock and transport deadlines remain.

Supply `CANTRIP_TEST_POSTGRES_BIN_DIR` and an OpenSSL CLI for this disposable
fixture. The Windows workflow installs that test dependency explicitly. Local
macOS arm64 results passed; this milestone still requires observed platform CI.
The external URL adapter preserves omitted/disabled SSL, prefer fallback,
required encryption and strict certificate rejection for the tested settings.
An explicitly empty `sslmode=` retains Node's omitted-option behavior; the
adapter resolves and removes that key before invoking the typed driver parser.
Complete connection-option/environment parity, startup retry behavior,
interrupted-network recovery and deployment artifacts remain required. A
successful CancelRequest is not an acknowledgment of remote statement rollback
during a network partition; retained execution recovery still needs its domain
tests. This does not establish complete database or server replacement.

The TLS fixture's PostgreSQL launcher inherits a real append log and null
stdin, matching the native Windows owner instead of leaving a daemon attached
to captured launcher pipes. Cleanup attempts actual `pg_ctl stop` after every
start attempt, including a launcher observation failure. Logs indicating a
listening server do not substitute for the actual connection checks.

Windows private-cluster startup uses PostgreSQL's own `pg_ctl` restricted-token
launch path. A kill-on-close Windows Job Object owns the launcher and its
descendants, assigned during process creation so startup cannot outrun process
ownership. The Windows integration test abruptly kills the owner, observes the
actual postmaster exit, and reopens the cluster to verify committed data after
crash recovery. This test passed in the observed Windows run linked below;
future changes still require their own execution results.

On Unix a native owner mode of the same Rust executable holds PostgreSQL. The
main server keeps a private pipe open; main-process death closes that pipe and
the owner requests fast PostgreSQL shutdown and reaps its actual child. Normal
shutdown closes database sessions before releasing the pipe. External database
connections do not enter this ownership path.

The owner has its own Unix process group. A terminal's foreground-group Ctrl-C
therefore reaches the main server, which drains work before releasing the pipe,
instead of killing its owner and bypassing that shutdown order.

Unix initialization also runs under that owner. A new cluster is initialized
and synced in a private staging directory, then promoted to `data` after initdb
success. Parent death during initialization kills its owned initializer process
group and removes its staging files. An existing cluster is never reset or
deleted to recover from an opening or promotion failure.

The lifecycle harness uses the actual executable, HTTP account/worker writes,
process death, PostgreSQL status and retained login/credential checks. Its Unix
cases additionally interrupt real initdb and stop PostgreSQL with the parent's
pipe still open, checking that the owner exits independently of that reader:

```sh
node scripts/server-rust/postgres-lifecycle.mjs --report .qa/rust-server/postgres-lifecycle.json
```

Local macOS results passed. The revised lifecycle still requires observed Linux,
macOS and Windows CI, packaged assets and client/service supervision acceptance.
The earlier pool/TLS milestone passed all three platforms at `50339edbd` in
[run 40427101801](https://github.com/ArcaneArts/Cantrip/actions/runs/40427101801);
its 93 reports do not establish this later ownership change.

PGlite candidate: `pglite-rs` 0.2.7 statically embeds Electric's
`postgres-pglite` fork. It reports PostgreSQL 17.5. The current JavaScript
PGlite 0.5.4 reports PostgreSQL 18.3. **Physical directories are not compatible
by assumption. Existing-installation conversion is unfinished.** Native
PostgreSQL owns process-wide stdio and signal state; native tests use separate
processes, and the executable duplicates launcher pipes before initialization.
PL/pgSQL needs backend symbols exported from the final executable on macOS and
Linux. The native runtime and its license/artifact distribution still need
release review and packaging integration.

The Rust command reads the existing server environment configuration, including
auth/deployment/bootstrap modes, hosted startup protections, origins, proxies,
cookies, key rings, limits, WorkerLink policy, TURN and WebRTC settings. The
configuration itself is implemented; the session handlers are now implemented
and the remaining transport domains are unported. CLI host, port, data directory and database options
override their environment settings. Explicit CLI port zero supports ephemeral
process tests; environment ports retain the existing 1–65535 range.

Data paths resolve lexically before native PostgreSQL can change the process
working directory. The default remains `../.cantrip/dev` relative to the launch
directory. The canonical `server-db` root is preserved; an opening failure never
selects an empty replacement. Bundled mode still needs PostgreSQL executables
through `CANTRIP_POSTGRES_BIN_DIR` or the CLI option until packaging is integrated.

Storage selection uses `CANTRIP_DATABASE_MODE=pglite|bundled-postgres|postgres`.
When unset, a nonempty `DATABASE_URL` selects external PostgreSQL; otherwise
PGlite preserves the existing behavior. Explicit embedded/private modes also
work with hosted configuration while retaining its authentication, key-ring,
origin, proxy and cookie protections. Storage selection is independent from
deployment; this does not assert that the remaining hosted service is ported.

A differential configuration test executes the actual Node parser for 977
scenarios and compares every resulting field or validation error with Rust.
Inputs cover all bounded numeric settings, booleans, Unicode, key rings, nested
policy validation, host/origin/proxy handling, multi-instance quota division,
and error precedence. Executable tests exercise configuration rejection before
storage writes, CLI precedence, relative paths and real PGlite process reopen.
The Node oracle is development-only and is not called by the server executable.

Run from the repository root:

```sh
pnpm --filter @cantrip/version --filter @cantrip/logging --filter @cantrip/protocol -r build
node scripts/server-rust/build.mjs
CANTRIP_TEST_POSTGRES_BIN_DIR=/absolute/path/to/postgres/bin \
  node scripts/server-rust/cargo.mjs test -- --nocapture
node scripts/server-rust/compatibility.mjs --report .qa/rust-server/foundation-http.json
```

The GitHub workflow executes real tests on Linux, macOS and Windows; scheduled
or configured coverage is not evidence of a passing run. Windows currently
uses the native PGlite crate's GNU target, independently of the desktop Tauri
MSVC target. Cross-platform results must be observed before claiming support.
The build tooling points the compiler at Cargo's resolved, checksummed native
artifact package. This works around the upstream 0.2.7 build scripts checking
only for an uncompressed archive, overlooking their published `.a.zst`, and
falling back to a nonexistent Windows release download. The actual compiler
and runtime tests still execute; no declared capability substitutes for them.

Local evidence, 2026-10-25, macOS arm64: the database integration scenarios
passed with all 235 migrations and real PGlite process reopen, PostgreSQL 18
private-cluster restart, external-mode executable invocation, cancellation
rollback and notifications. Seven HTTP comparisons plus a Rust restart passed
against the Node service over actual sockets. Rust formatting and Clippy with
warnings denied passed. These are foundation results, not the complete server
or product-flow acceptance matrix.

## Legacy PGlite logical export and transactional restore

An actual round trip found that the upstream dump wrapper removed lines beginning
with `\\restrict` or `\\unrestrict` from multiline row values and SQL function
bodies. The converter now obtains SQL directly from the pinned package's generated
WASM factory, before that global cleanup. It removes only the matching generated
header and footer commands. The unmodified factory, license and provenance are
retained under `scripts/database-transfer/third-party`; the matching WASM remains
in the pinned dependency. Native serving never imports this bounded converter.

The regression fixture uses the same guard key inside actual text and a SQL
function, restores the real dump, and checks both values exactly. It also invokes
an actual invalid dump option, checks ordinary error redaction and explicitly
retained private diagnostics, and verifies the original session/search path still
works. The complete current and historical transfer fixtures now retain SQL NULL
versus JSON null, multiline guard text and the function result alongside the full
table and sequence snapshots. Their all-store interruption/retry suites pass
locally; supported-platform results remain required.

The expanded current/historical fixtures also pass against real PostgreSQL
16.15. Strict all-target Clippy and native database contracts pass. The broad
repository check exits 1 with 1,662 source-server tests passing, 57 skipped and
the previously reproduced provider-routing assertion failing at
`local-foundation.test.ts:7218`. This is not a green repository-wide check.

A bounded offline JavaScript tool now opens a private copy of the stopped legacy
PGlite database and exports ordinary PostgreSQL SQL with the pinned, matching
[PGlite/pg_dump packages](https://pglite.dev/docs/pglite-tools). It never opens the original database for execution and
creates the export exclusively with private file permissions. Native serving
and background work do not import or invoke this converter.

The Rust executable accepts trusted INSERT-format exports through `--restore-sql`
with `--migrate-only`. Restore DDL,
data and pending migrations execute in one transaction on the selected native
PGlite, private PostgreSQL or external PostgreSQL backend. The original Drizzle
journal and migration SQL hashes remain authoritative. Deferred checks are
resolved before upgrade DDL so valid circular chat/root relationships do not
leave PostgreSQL 17 trigger events pending during the conversation backfill.
An offline restore also preserves the existing local-user timestamps instead
of running the ordinary migrate-only local-user refresh.

For a stopped source and a separate destination, the SQL transfer components
can be exercised with:

```shell
node scripts/database-transfer/legacy-pglite.mjs /old/profile/server-db /backup/export.sql
/absolute/path/to/cantrip-server --database pglite --data-dir /new/profile \
  --migrate-only --restore-sql /backup/export.sql
```

Local macOS checks transfer actual PostgreSQL 18.3 WASM PGlite data into native
PostgreSQL 17.5 PGlite and both PostgreSQL deployment modes. All 115 table
snapshots and four sequence states match, including the real migration journal,
large integers, precise numerics, JSONB, bytea, arrays, generated columns,
Unicode and microsecond timestamps. Snapshot queries explicitly use UTC on
both sides to compare stored instants. Every one of the source profile's 1,665
original files retains its bytes and permissions.

A second fixture applies the actual first 233 migrations, seeds a valid
worker/chat/root cycle and then exports it. The native restore applies the
three pending migrations and matches a separate copy upgraded by the actual
Node migrator. Late import errors, a failure after earlier pending upgrades,
and replay into an existing destination leave destination state intact.
Actual invalid-value errors expose SQLSTATE without logging exported values.
A failed private PostgreSQL load closes its postmaster before returning, so an
immediate retry does not race parent-death shutdown. Two concurrent native
restores share the startup migration transaction lock: actual blocked-query
witnesses prove serialization, one succeeds and the other rejects the existing
destination while the retained snapshot stays identical.

Interruption tests kill the native command only after a SQL-written filesystem
witness proves execution. The historical case pauses inside the conversation
migration after earlier upgrades execute. Restart observes no partially
committed application state, and an identical retry succeeds on all stores.
An external PostgreSQL backend may retain the interrupted query until it
finishes and detects the lost connection; these checks include that eventual
rollback instead of inferring it from the client's exit alone.

These are SQL transfer components. The complete-profile components described
below add file/key transfer, persistent backend selection and representative
post-write reverse conversion. Packaged upgrade integration and full product
rollback remain unfinished. Normal builds continue to select the Node server
and Node worker.

## Native logical export and representative post-write rollback

The Rust executable now accepts `--migrate-only --export-sql <new file>` for
native PGlite, private PostgreSQL and external PostgreSQL. It opens the selected
database, obtains a real native pg_dump export, and exits before migrations,
local-user refresh or HTTP/background services start. Supply `--pg-dump-path`,
or use the configured PostgreSQL binary directory or PATH. Bundling those native
client/runtime assets remains packaging work.

```shell
/absolute/path/to/cantrip-server --database pglite --data-dir /native/profile \
  --migrate-only --export-sql /backup/native.sql \
  --pg-dump-path /absolute/path/to/pg_dump
```

Native PGlite exposes an exclusive wire-session guard through a small local
pglite-rs patch. It retains the existing session mutex without issuing BEGIN;
pg_dump establishes its own snapshot and transaction settings. Dropping the guard
queues rollback before another caller can proceed. A real SQL-written filesystem
witness verifies cancellation during execution. Upstream source, MIT license and
patch provenance are retained under `cantrip_server_rs/third-party/pglite-rs`.

PostgreSQL exports use a temporary loopback relay authenticated by a random
startup token. Rust opens the actual backend connection with its existing TLS
connector and forwards the PostgreSQL protocol. The client retains configured
login credentials, startup options, host choices and session-attribute selection.
The TLS matrix uses a held relation lock to identify the actual pg_dump backend
and checks `pg_stat_ssl` while that backend is blocked. Eleven SSL-on/off and
omitted/empty/disable/prefer/require/verification cases pass locally. Wider URL
option and supported-platform acceptance remain required. A real startup-role
case found that URL form encoding sent spaces as literal plus signs to the Rust
PostgreSQL driver. Retained query values now use percent-only encoding; role,
login identity and space/plus/Unicode application-name results match the actual
Node driver. Export uses the configured login identity while preserving startup role
and session-authorization options. The final eleven-case TLS regression also passes after this correction.

The SQL preparer removes only matching generated header/footer guard commands and
adapts only the generated transaction-timeout prelude for older destinations.
An actual native 17.9 dump with its guard key inside multiline TEXT and a SQL
function restores exactly, including CRLF guard variants, large numbers, bytea,
SQL NULL and JSON null. A private staging file is synced and published without
overwriting an existing path. Actual missing-executable and restricted-role SQL
failures leave no published file. Default error rendering stays redacted; an
explicit diagnostic consumer verifies that the original SQL failure is retained.

Current-schema and genuine 233-migration fixtures pass logical transfer into all
three Rust backends and back into JavaScript PGlite. Every one of 115 table
snapshots, four sequence states, the literal function result and NULL distinctions
matches. The expanded scenario signs into Rust with password authentication,
initializes protection records, creates a workspace and promotes it with a
revision fence. After native export and restore, the actual Node server accepts
the Rust-issued session and CSRF token, reports the same server ID, returns the
complete workspace and commits the next revision. This passes on all three
stores for both schema histories. A mixed-version follow-up also passes with
pg_dump 18.6, private PostgreSQL 18.6, external PostgreSQL 16.15 and native
PGlite 17.5. The 146-test native regression passes across 64 groups without
ignored tests before the final role/URI correction; the role and TLS suites
exercise the corrected connection path afterward.

An instrumented native client pauses only after the real pg_dump emits an INSERT
for the fixture table. Killing the server at that boundary publishes no partial
file; the observer and real dump client exit, private staging is identified and
removed, the original state reopens, and a normal export/reverse restore succeeds.
This is an actual export interruption scenario, alongside the existing SQL import
and pending-migration SIGKILL/retry checks.

The final strict all-target Clippy check passes. The broad `pnpm check` exits 1
with 1,661 source-server tests passing, 57 skipped and two failures: the existing
provider-routing assertion at `local-foundation.test.ts:7218`, and a five-second
account-resource-usage timeout. The latter passes unchanged in isolation on both
this branch and clean Primary, with actual test durations of 2.28 and 2.29 seconds.
No deadline or assertion was relaxed, and the broad check remains non-green.

These results establish a representative database rollback subset. The
complete-profile components below extend it to file/key transfer and persisted
backend selection. Packaged upgrades and full product rollback remain unfinished.
The normal desktop, development and standalone paths continue to use the Node
server and Node worker.

## Early upload rejection lifetime

The Windows file-document comparison in run `41141260086` failed with
`ECONNRESET` while uploading the request above the 4 MiB operation limit. The
native parser dropped its unread request body on overflow. Hyper can then close
with unread TCP bytes before the peer receives the complete error response.

The parser now bounds collection itself, sends the existing 413 response with
the Node parser's `Connection: close`, and discards remaining frames without
collecting them. An abandoned rejected upload is released after five seconds.
Neither response delivery nor advertised-length rejection waits for upload EOF.
The limit, error contract, authorization and worker dispatch behavior remain in
place. Unsupported oversized media types retain their existing 415 selection.

Native tests exercise an actual bounded-channel upload, an advertised-length
rejection without sending body bytes, cleanup with a paused clock, and a real
loopback HTTP connection that receives its complete response before finishing
the upload. The real Node/Rust file-document fixture retains its original cases
and adds an 8 MiB streamed request plus exact connection-close assertions.
The client still fails on TCP resets and incomplete responses without retrying.
Local comparisons pass 40 anonymous and 42 account observations per runtime
on each of native PGlite, private PostgreSQL and external PostgreSQL, with six
worker commands per profile. All 31 native library tests, the JSON/WS comparison,
the five upload-client tests and strict all-target Clippy pass. The three new
lifetime/loopback tests compile and fail against the original parser, then pass
with the fix. Supported-platform results remain required; local evidence alone
does not close the Windows failure.

Run `41157035912` also exposed a Windows compiler error in native SQL export:
the TCP connection future inferred its error type only from a Unix-only branch.
Its TCP result now explicitly uses `std::io::Error` on every platform. This fixes
the diagnosed inference path; actual Windows compilation and export acceptance
must be observed in the subsequent platform run.

## Native dump byte preservation on Windows

Run `41157865174` passed the native upload tests on Windows, then its migration
job caught a distinct native export defect: LF bytes became CRLF inside both
stored text and SQL function bodies during the reverse transfer. Artifact
`13025514562` was retained with its verified uploaded ZIP SHA256
`eca40b2852e6d92570e9705aa494c4959e14d64a7baa765656cc1672a49ca0ff`.
The exact table/function comparisons remain in place.

Native pg_dump now produces gzip-compressed plain SQL on stdout. PostgreSQL's
[Windows output setup](https://github.com/postgres/postgres/blob/REL_17_9/src/bin/pg_dump/pg_backup_archiver.c)
explicitly selects binary stdout for compressed plain output. Rust decodes the
gzip stream and publishes the existing plain SQL export. It does not rewrite
newlines in SQL or row values. The added Rust dependencies were already resolved
in the lockfile; no package versions change.

The dump-row interruption observer decodes the real child's gzip stream before
recognizing the actual fixture INSERT, then forwards gzip from Rust's binary
stdout. Its real-row witness, process cleanup and unpublished-destination
assertions remain. The shared transfer fixture additionally contains original
CRLF and bare CR beside LF and Unicode in its SQL function value. A dedicated
actual pg_dump test restores in a fresh process and compares exact mixed-newline
bytes in both the table value and function result. PGlite cannot reopen after
close in one process, so this test uses the same process boundary as the CLI.

Local current and historical-schema (233 of 236 migrations) all-store transfers,
password-authenticated Rust writes,
Node post-write rollback, real-row interruption/retry, eleven TLS cases and
restricted-role redaction pass with compressed transport. Current supported-platform outcomes must be observed separately. No complete profile,
packaged migration or full replacement acceptance follows from this fix.

## Logical profile transfer and durable backend selection

The native CLI can export a stopped installation's database and opaque files
as one directory bundle, then restore it into a new profile root. The bundle
contains logical SQL, a versioned manifest and copied files with SHA256/length
records. It retains unknown regular files, materializes file references and
preserves empty directories, executable bits and file modification times.
Physical `server-db` and `postgres` engine directories are excluded. Paths use
portable forward slashes; unsafe paths, duplicates, directory cycles and changed
SQL/assets fail without publishing the destination.

```shell
# Stop the source server before exporting its database and files.
node scripts/database-transfer/legacy-profile.mjs /old/profile /backup/profile-bundle /absolute/path/to/cantrip-server
/absolute/path/to/cantrip-server --data-dir /new/profile --database pglite \
  --migrate-only --restore-profile /backup/profile-bundle

# After Rust has accepted writes, export its current database and files.
/absolute/path/to/cantrip-server --data-dir /new/profile --migrate-only \
  --export-profile /backup/after-rust --pg-dump-path /absolute/path/to/pg_dump
node scripts/database-transfer/legacy-profile.mjs --restore /backup/after-rust /rollback/profile /absolute/path/to/cantrip-server
```

Use `--database bundled-postgres --postgres-bin-dir <directory>` or an explicit
`DATABASE_URL` to restore into the other backends. A bundle carries its source
mode as the default; external PostgreSQL credentials must be supplied separately.
Successful restore writes private `server-database.json` and profile-receipt
files. Normal Rust startup reads the stored backend, connection and binary path.
Explicit backend inputs retain precedence. `--migrate-only --remember-database`
records a selection only after the actual database setup succeeds; a failed
open leaves the previous selection intact. No metadata capability probe replaces
the real open. Stored external URLs contain credentials and require the same
protection as the installation's existing key/configuration files.

Restore copies verified files and creates local storage inside a private stage
in the destination's parent. Database restore and pending migrations commit
together with a manifest-specific import receipt. It closes sessions and owned
postmasters, restores the launch working directory, syncs the profile and
publishes the directory exclusively. Even an existing empty destination is
preserved. Unix staging directories are explicitly restricted to owner access
before any profile data is written, independent of the native engine's umask.
The JavaScript reverse converter is an offline bounded operation; native serving
and background work never invoke it.

Local macOS tests pass the complete Node-profile → each Rust backend → Node-profile
path. All 115 table snapshots, four sequence states, SQL functions, mixed newline
bytes, SQL NULL versus JSON null, large integers, precise numerics and opaque
file bytes match. The original session/CSRF, server UUID, encryption key and
encrypted workspace survive. Rust commits workspace revision 2; the actual Node
server reads that state and commits revision 3. Original source files and bundle
bytes remain unchanged. Restart tests verify all three remembered backend modes,
explicit external overrides and retention of the prior selection after a real
missing-executable setup failure.

Fault cases kill the importer only after an actual SQL filesystem witness. No
partial profile appears, the private postmaster exits after its owner dies, and
retry succeeds against the same destination/external database. A PostgreSQL
protocol proxy holds the actual COMMIT acknowledgement after a direct database
query confirms the durable import receipt. The killed importer publishes no
profile. A separate Rust server then accepts a real HTTP write; retrying the
original bundle preserves that newer write and publishes the profile. Late SQL
exceptions roll back the load, retain SQLSTATE/private diagnostics and expose no
fixture SQL values in ordinary native or legacy-converter diagnostics.

The local complete-profile suite passes in 94.73 seconds; eleven native profile
file/configuration tests and strict all-target Clippy also pass. Linux/macOS/
Windows migration jobs now include these profile checks, but this milestone's
new platform outcomes still require observation. Earlier Windows raw-SQL
current/historical/reverse-transfer reports from run `41160107203` were downloaded,
checked against uploaded ZIP SHA256
`4bff8c251e44489c948bacae50cea021bd482b38aa37cb7907a02f674b78ad96`
and inspected successfully; they do not validate the newer profile publisher.

The final complete-profile regression passes in 100.81 seconds after wrapping
converter setup/cleanup failures in the same private diagnostic boundary.
Stored-backend restart checks also cover an empty `DATABASE_URL` environment
template: it retains the saved external connection. All 977 actual Node/Rust
configuration cases match. The broad `pnpm check` exits 1 after 500.85 seconds
with 1,662 source-server tests passing, 57 skipped and the retained provider
selection assertion failing at `local-foundation.test.ts:7218`. Server, worker,
shared package and dependency sources are unchanged from the merged baseline;
the repository-wide check is not green.

This CLI component requires stopped sources, trusted logical bundles and new
destination directories. It does not yet activate an existing installation in
the desktop launcher. A crash after final publication may leave a completed
profile without the command's acknowledgement; a retry refuses the existing
directory and preserves it. Hard-killed imports can leave private temporary
directories that need owned-stage cleanup. Historical physical PGlite runtime
versions, packaged upgrade/rollback supervision, all product flows and full
supported-platform acceptance remain required. Normal development, standalone
and desktop builds still use the Node server and worker.

The complete Windows migration job in run `41163777652` passes at profile head
`40bdce5e58884d72928037b8c2c238d32fb009e1`. All six uploaded JSON reports were
inspected after checking ZIP SHA256
`748fac193d59fd521c6143c6b1cab5a846249dc9f35a100057f09c12d1c7f0fe`.
This includes exact 115-table/four-sequence profile transfer and reverse
comparison, original sessions/keys/files, actual Node revision 3, real process
interruption/private-postmaster cleanup and the held-COMMIT-acknowledgement case.
It validates the Windows profile publisher at that head, not packaged activation.

That run's Linux profile test failed during native PGlite export: the new
harness ignored `CANTRIP_TEST_PG_DUMP_PATH` and selected the configured PostgreSQL
16 server directory's client. It now passes the requested dump-client path to
the existing CLI option, independently of the database server directory. There
is no version probe or fallback. An actual source-built pg_dump 16.15 reproduces
the failure against native PGlite 17.5 while the requested client 18 is left
unused. Follow-up tests keep that incompatible default client present and use
the explicitly configured native client for the export. The corrected all-store
profile suite passes in 94.64 seconds with the same default client still present;
an actual wrapper witness records all three exports invoking pg_dump 18.6. All
table/sequence/function/file comparisons and interruption/rollback assertions
remain. Linux verification of this follow-up is still required.

## Remaining delivery sequence

1. Establish cross-platform foundation results and legacy PGlite logical
   export/import evidence; evaluate native runtime limitations against actual
   operations before selecting final packaged database artifacts.
2. Finish shared wire validation, version/build identity and runtime logging;
   configuration parity is implemented and requires cross-platform acceptance.
3. Port authentication, sessions, tenant authorization, encryption envelopes,
   worker enrollment and revocation.
4. Extend the actual browser-to-full-worker Ollama operation to the remaining
   resource/execution flows, ordered events, reconnect continuity and committed
   App Live notifications across supported artifacts and platforms.
5. Port durable account, provider, policy, project, workspace, source, worktree,
   file, tab, surface, chat, attachment, usage and administration domains.
6. Port native admission/receipts, history, managed queues, settings/permissions,
   handoffs, Tasks, retries, automations, leases and recovery.
7. Complete streaming, WorkerLink, tunnels, attachments, logs, Redis routing,
   multi-instance failure recovery and any claimed mixed-version rollout.
8. Prove existing-installation upgrades, interrupted conversion and post-write
   data-preserving rollback across the supported storage modes.
9. Integrate desktop supervision, native/container releases, Winterhold
   deployment tooling and the supported platform/storage product-flow matrix.
10. Switch defaults and remove the production Node server after acceptance.

Every current route, worker command and durable table in
`security/server-route-inventory.json` remains in scope. Add behavioral cases
as each domain is ported; passing foundation cases does not close other rows.
Also retain the encryption inventories, operational contracts and migration
history as requirements while the implementation changes language.

The machine-readable ledger is `security/rust-server-coverage.json`. Every
inventory row inherits its category's explicit default until overridden.
Applying a table's schema does not establish its domain behavior; local tests
and configured CI do not establish platform acceptance.

## Completion evidence

Completion requires merged milestones and an integrated commit, a complete
contract ledger, actual deployment/storage/platform results, migration and
post-write rollback evidence, native/container artifact paths and checksums,
desktop and representative Winterhold deployment results, and representative
performance/recovery measurements. No production runtime path may delegate to
Node, Bun, Deno or the old TypeScript server. Node may remain for the unchanged
worker, frontend builds, compatibility tests and bounded legacy conversion.

No complete replacement, production cutover, existing-data migration,
packaged release or Winterhold deployment is claimed by the foundation work.

## Account and session milestone

The current implementation adds the existing `/version`, `/api/bootstrap`, and
eight authentication endpoints: registration, login, session lookup,
reauthentication, mobile grant creation/exchange, logout and logout-all.
Authentication modes, origin/CORS/security headers, body parsing and limits,
account pins, session-cookie conflicts, CSRF, rate limits, configured
administrators, owner/member provisioning and security audit writes are ported.

Password hashing uses the existing Argon2id parameters and accepts retained Node
hashes; Node also verifies Rust-produced hashes. Session token and CSRF hashes,
secure/partitioned cookies, mobile code formats and single-use transactions
retain their existing contracts. Session revocations publish internal events;
the live, WorkerLink and attachment transports still need implementations that
consume those events before transport-wide revocation can be considered done.

The Rust build embeds metadata from the authoritative existing version resolver
at build time. Node is a build dependency, never a server runtime dependency.
Wire responses retain the protocol schema's existing validation and field
stripping, including its rejection of suffixed synthetic versions.

Native database error statements are suppressed at the engine boundary. Tests
execute an invalid SQL statement containing a private sentinel and inspect the
native process output and private PostgreSQL log for disclosure. Query errors
remain available to callers; this does not complete the remaining operational
logging APIs or their broader privacy acceptance.

The socket harness runs the actual Node and Rust servers against independent
fixtures. Profiles cover anonymous, password and account modes, secure dual
cookies, licensing, trusted proxies and rate limits. It compares full response
bodies and security/cookie/CORS headers, validates entropy and CSRF derivation,
and checks identities, sessions and expiration consistency across restarts.
The same scenarios can run with PGlite, private PostgreSQL or external
PostgreSQL. No scenario connects to an ordinary developer database.

An external-PostgreSQL transition scenario uses one disposable populated
database sequentially: Node creates an owner/session, Rust retains them and
creates accounts/mobile sessions, Node reads those writes and verifies Rust
password hashes, then Node observes Rust session revocation. This establishes
account/session compatibility after Rust writes, not full-server rollback.

Run the socket matrix with a PostgreSQL binary directory supplied for the two
PostgreSQL modes:

```sh
pnpm server:rust:auth:compatibility --report .qa/rust-server/auth-pglite-http.json
pnpm server:rust:auth:compatibility --database bundled-postgres --report .qa/rust-server/auth-bundled-http.json
pnpm server:rust:auth:compatibility --database postgres --report .qa/rust-server/auth-external-http.json
```

The test-only `database-fixture` example owns isolated PostgreSQL clusters for
the Node reference and external mode. It is not distributed with the server.
The native repository tests additionally cover concurrent mobile consumption,
legacy CSRF rotation, settings/workspace provisioning, configured-administrator
updates and PGlite/PostgreSQL retained state. Request-schema tests execute the
actual TypeScript protocol schemas rather than reproducing their expectations.

The session milestone merged as [PR 2277](https://github.com/ArcaneArts/Cantrip/pull/2277),
commit `d759084a30cba3e8641878bd51b69a7c936c4155`. Its
[observed workflow run](https://github.com/ArcaneArts/Cantrip/actions/runs/40254773601)
passed on Linux, macOS and Windows, including all three database socket suites,
retained-state tests, configuration contracts and database/process recovery.
This establishes that milestone's platform results, not full product readiness.

## Encryption registry and account security

The current slice adds the account encryption profile, initialization,
migration-status updates, password rewrapping, principals, approvals,
revocations, and grant APIs. It stores existing opaque envelopes and their
metadata in the original schema. Password-hash and wrapper changes commit
atomically under the existing profile revision check. Revoking a principal
cascades to its active grants; retained revoked grants still prevent duplicate
component/revision inserts. Worker-principal repository operations retain
credential/owner checks and atomic identity rotation, while the worker
enrollment/bootstrap HTTP integration remains unported.

Account session lists, owner/admin audit queries and license-whitelist APIs
are also present. Session connection indicators currently cover the current
session; additional connected sessions require the remaining live transport.
Mutation auditing for implemented routes now follows body/header completion,
including HEAD and response errors, with owned shutdown draining. Remaining
domain hooks, operational logging and packaged/platform acceptance are still
required.

`contracts/security.json` is generated from 36 actual protocol exports by
`scripts/server-rust/contracts.mjs`. The native validator preserves defaults,
stripping/strictness, issue paths/order/messages, coercion, unions and explicit
custom refinements. Unknown exporter operations fail the development export;
normal server startup never invokes the exporter or JavaScript. Differential
tests execute the actual protocol independently, compare the generated manifest
and run 27,252 mutation cases, including lone UTF-16 code units in keys and
values. The native JSON representation retains UTF-16 and JavaScript number and
property-order semantics. A further 69,647 JSON round trips compare every
UTF-16 code unit and deterministic floating-point edge cases with Node.
Global malformed/deep-JSON behavior and the remaining domains' schema semantics
still require acceptance; these counts do not close those contracts.

The security socket harness compares entire responses, security/cache/CORS
headers, cookies, errors, tenant boundaries, revision conflicts and retained
state. It uses the existing client crypto implementation to create real HPKE
and password wrappers, fetch and decrypt them, change passwords without
changing the master key, reject wrong-owner/tampered wrappers, and repeat after
restart. External PostgreSQL additionally runs Node initialization, Rust
password/wrapper writes, and Node reopening those writes with the original
client keys. This is encryption/account evidence, not full-server rollback or
legacy PGlite conversion.

```sh
node --import tsx scripts/server-rust/security-compatibility.mjs --report .qa/rust-server/security-pglite-http.json
node --import tsx scripts/server-rust/security-compatibility.mjs --database bundled-postgres --report .qa/rust-server/security-bundled-http.json
node --import tsx scripts/server-rust/security-compatibility.mjs --database postgres --report .qa/rust-server/security-external-http.json
```

Supply `CANTRIP_TEST_POSTGRES_BIN_DIR` for the PostgreSQL fixtures. These
databases and the client key material are disposable. Linux/macOS/Windows CI
executes the same tests; configured checks are not passing evidence.

Worker enrollment/control, live transports, account usage and other resource
and execution domains, usable legacy conversion/rollback, desktop packaging and
Winterhold delivery remain required work.

## Native JSON lifetime and authentication boundaries

An actual Node/Rust comparison found that a roughly 4 KiB request containing
2,048 nested arrays aborted the native process with a stack overflow over both
HTTP and App Live. Node accepted the HTTP enrollment request after stripping its
unknown field and returned the existing invalid-message error over Live, while
remaining healthy. The native parser previously reparsed each subtree through a
fresh Serde visitor, and tree clone/drop/serialization also recursed.

The native wire representation now validates syntax once with `RawValue`, then
constructs the tree iteratively. Clone, equality, serialization, destruction and
HTTP poison-key scanning also use explicit stacks. It retains UTF-16 strings,
JavaScript numbers, duplicate-key replacement and ECMAScript property ordering;
the existing transport byte limits and endpoint schemas still decide admission.
No new nesting rejection limit substitutes for parsing valid inputs.

Authentication requests now use the same exported native protocol contracts as
the other ported APIs. They retain raw UTF-16 through validation, including issue
keys/messages, and convert explicitly to UTF-8 at password hashing and database
text boundaries. This removes the recursive conversion of an entire unvalidated
request into `serde_json::Value` and the separate handwritten auth validator.

The socket suite compares 52 HTTP and 27 WebSocket cases per backend, including
20,000-level accepted unknown fields, deep wrong types, truncated JSON, poison
keys, escapes, overflowing numbers, duplicate keys and lone UTF-16 units. It
checks subsequent health and usable Live initialization/ping/close. A native
test uses a 256 KiB thread stack for 32,768 nested arrays and 12,000 alternating
object/array pairs, including clone, equality, stringify, Serde output and drop.
These tests and all three storage socket profiles passed locally on macOS arm64;
the changed implementation still requires its own supported-platform CI results.

```sh
pnpm server:rust:json:compatibility --report .qa/rust-server/json-pglite-http.json
pnpm server:rust:json:compatibility --database bundled-postgres --report .qa/rust-server/json-bundled-http.json
pnpm server:rust:json:compatibility --database postgres --report .qa/rust-server/json-external-http.json
```

Supply `CANTRIP_TEST_POSTGRES_BIN_DIR` for disposable PostgreSQL fixtures. Live
parser cases run before enrollment mutations: the latter still lack some
resource-domain publications, which a retained comparison exposed as divergent
Live cursors. Remaining schemas, coercion/refinement boundaries, authenticated
serialization, domain publishers and complete product acceptance remain required.

## JSON socket cursor observations

The JSON milestone PR 2282 passed the full native suite on Linux, macOS and
Windows, including small-stack tree lifetime tests. Its full Linux/macOS jobs
passed. Windows failed the new PGlite socket suite when a ready response had
Node cursor 1 and Rust cursor 0; later Windows suites did not run. The failure
is retained in run 40396215390. Follow-up PR 2283 subsequently passed all three
complete platform jobs in run 40405725752 on tested head
`2bbd667b17409c9b5a11ed2efdf8f1538722f4eb`, including the cursor controls and
all three JSON storage suites. All 90 uploaded reports were retained before
merge `0799dc6814e441e46ce00437c2b276896848c93c`. Those results cover the JSON
follow-up, not this newer PostgreSQL implementation or complete replacement.

A real subscribed Node client reproduced a separate `account-resource-usage`
publication advancing its cursor. Usage accounting and those native publications
remain unported. Publication timers differ between independently launched
processes, so comparing their absolute counters inside parser cases also makes
those cases depend on an unrelated domain and the speed of the host.

The JSON suite now installs a real observer with retained replay, preserves raw
ready/pong counters, and proves each counter against a contiguous publication
chain for that process. A counter cannot precede events observed before its
request. Only the exact usage invalidation shape is accounted separately;
unexpected resources, changed server epochs, missing ordinals and stale
counters fail. Raw counter/publication differences remain in the output and
coverage ledger. This is not acceptance of the unfinished usage domain.

The suite lowers the real usage flush threshold and waits for a real reference
publication before later ready messages, deliberately exercising the original
failure on every platform. A separate real-Node control suite verifies valid
accounting and rejects stale/future counters, a changed epoch and an actual
worker mutation publication. It runs with the same supported-platform workflow:

```sh
node --import tsx scripts/server-rust/live-cursor-contract.mjs --report .qa/rust-server/json-cursor-contract.json
```

The reference notification-order and authentication-shutdown fixtures give cold
WASM, full migrations and application initialization the same 60-second startup
budget as the real-server harness, and report their actual setup durations. The
connection/shutdown test bodies and behavioral polling deadlines stay unchanged.

## Standalone Chat catalogs and scratch jobs (in progress)

Rust now implements standalone creation and active/archived catalogs through
`POST /api/chats`, `GET /api/chats?context=standalone` and
`GET /api/chats/archived?context=standalone`. Creation keeps the opaque title,
locale-sorted compatible worker choice, online preferred worker, inherited model
and reasoning settings, archived positions, and the transaction containing the
Chat, scratch root, runtime session, suspended execution lane and provision job.

The scratch repository retains identity-sensitive admission, separate commits
for deletion enqueue and failure settlement, leases, fenced completions,
interrupted recovery, retryable reconnect, reconciliation targets, missing roots,
archive expiry and durable deletion tombstones. Its executor is connected to
startup, worker reconnects and shutdown draining; it dispatches at most four jobs,
renews leases every 30 seconds, uses the existing worker command bus and emits
owner-scoped Chat invalidations after durable transitions. Interruption, expiry and shutdown-fault
acceptance remains required.

Local Node/Rust comparisons pass 114 repository operations and 89 state snapshots
on native PGlite, private PostgreSQL and external PostgreSQL. Real trigger failures
check partial commits and rollback of all five creation records. Concurrent
claims retain unique job and command ownership, and reopening each backend retains
its exact state. A failing native prototype committed provision completion before
DTO validation; the retained failing report demonstrated that mismatch. Provision,
deletion and purge now validate inside their original transactions.

The HTTP/Live suite passes all nine local database/authentication combinations:
26 anonymous, 27 password and 28 account observations per implementation, with
four provision outcomes, an actual worker reconciliation and eight ordered Chat events per profile.
It retains complete creation/executor state and verifies invalid result,
worker-error and routing-handle rejection. Source ordinary duplicate creation
returns 500 because its regex sees Drizzle's top-level statement/parameter message,
rather than the PostgreSQL cause. Rust preserves that behavior and the 409 case
when those rendered parameters contain the matched words, without logging opaque
parameters. The separate PGlite message-predicate comparison also passes.
The protocol oracle passes 12,149 exact cases across nine Chat/scratch schemas.

Actual external-PostgreSQL lease probes pass both implementations in all three
auth modes: a held job renews after about 30 seconds, extends the stored lease
by another two minutes and retains its command, attempt, revision and start time.
The six-job capacity probe also passes all auth modes: four jobs run while two
remain queued, each released slot dispatches the next job, and all six complete
once with their original identities and ordered invalidations.

The broad `pnpm check` finishes with 1,662 source-server tests passing, 57 skipped
and the existing provider-selection assertion at `local-foundation.test.ts:7218`
failing. Server, worker, shared package and dependency sources are unchanged.
This does not make the broad check green.

This milestone does not finish Chat behavior. The lifecycle and metadata port
is described below; forks, messages, execution queues, history, Tasks and
Goal/automation continuity remain required. Actual client/full worker scratch
filesystem tests, lease expiry and interruption faults, supported platforms, Redis
coordination, packaged activation and default cutover are also unfinished.
Normal desktop, development and standalone builds still select the Node server.

## Chat lifecycle and metadata (pending platform acceptance)

The native Chat repository and HTTP routes now implement explicit project Agent
archive, legacy project deletion, standalone archive/restore/permanent deletion,
runtime selection, encrypted title updates, completion acknowledgments, composer
drafts, file references and opaque standalone file operations. Empty project
Chats are deleted by the legacy route; history-bearing Chats are archived, and
explicit Agent archival retains empty conversations. Standalone archival retains
the Chat and root for 90 days; permanent deletion creates the existing durable
scratch deletion tombstone before cascading Chat-owned rows.

The repository comparison executes the actual source and native implementations
on separate databases: 66 operations and 98 snapshots pass on native PGlite,
private PostgreSQL and external PostgreSQL. It checks running/approval conflicts,
tenant boundaries, task behavior, archived idempotency, all three layout profiles,
anchor/label updates, removal from multiple owned windows, cancellation of a
pending detach, opaque draft retention and exact backend reopen state. The IDE
profile restores Chat tabs into the right dock; hybrid and agent profiles use
the center. Other resource placement retains its existing behavior.

Transaction boundaries remain observable. Invalid archive/restore DTOs roll back
both Chat and scratch-root writes; invalid project restore DTOs also roll back
legacy placement/revision changes. By contrast, a title update whose response
fails validation retains its already committed write, matching the source.
Completion acknowledgments change only the unread flag, and composer drafts do
not change the Chat's general update timestamp. Seventeen Chat/scratch protocol
schemas match 13,777 source parsing, issue and rendered-error cases. The archive
result refinement also retains JavaScript's behavior when invalid dates produce
NaN rather than an additional ordering error.

`standalone-chat-http-compatibility.mjs --lifecycle` extends the catalog/executor
suite with actual project and standalone HTTP flows, unchanged worker transport,
stored-state comparisons and ordered Live observations. It checks archive and
restore after worker error or invalid output, archived access restrictions,
foreign users, stale file bindings, offline workers, encrypted drafts and
permanent deletion completion. A controlled delete command separates the durable
tombstone response from the worker's completion. A separate archive command is
held until its actual HTTP caller disconnects, then released; the archive
publication and later restore prove that admitted work survives the caller.

The source's successful-response invalidation hook is preserved in addition to
direct publications, including duplicate completion invalidations. Draft writes
do not publish metadata changes; successful write/remove operations publish two
Chat-scoped file invalidations. Each authentication profile retains 43 standalone
Chat events, 25 project lifecycle events and 16 lifecycle worker commands for
comparison. Running/approval HTTP probes establish state after startup through
the disposable external PostgreSQL connection, since source startup recovers
preexisting running rows. Repository probes cover both conflicts on all three
storage modes; no second process opens a live PGlite database.

All nine local storage/authentication combinations pass the expanded HTTP suite.
PGlite and private PostgreSQL compare 101 anonymous, 102 password and 113 account
observations per implementation; external PostgreSQL adds the four actual
post-startup running/approval conflict responses per profile. Project HTTP state
is read back after shutdown and compared alongside the earlier standalone state.
Strict all-target Clippy, generated-manifest equality, formatting, large-file and
server-boundary checks pass. The broad `pnpm check` finishes in 501 seconds with
the same existing provider-selection failure at `local-foundation.test.ts:7218`
(1,662 source-server tests pass, 57 skip, one fails). Source server, worker, shared
package and dependency files remain unchanged; the broad check is not green.

Actual existing-client/full-worker filesystem acceptance, managed-share failure
probes, additional lock/interruption boundaries, supported-platform artifacts,
Redis coordination and packaged activation remain required. Forks, messages,
execution, queues, history, Tasks and Goal/automation continuity are unfinished.
This milestone does not switch the normal Node server build or packaging paths.

## Protected Chat forks (pending platform acceptance)

The native server now serves `POST /api/chats/:chatId/fork` for project and
standalone Chats. It preserves encrypted title validation, Task relocation errors,
offline and missing-source responses, message-prefix selection, 201/202 response
differences, placement and post-response invalidations. Source messages stay
opaque to the server. The existing worker reprotects them for new message IDs in
batches of at most 100, with the existing `fork:<source-id>` idempotency keys.

Project forks read their source in a transaction, release it before worker
dispatch and compare a fresh read in the write transaction. The comparison
includes source Chat, destination worktree and selected messages. It retains
JavaScript millisecond Date equality. The current maintained Node 24.22 reference
compares invalid Dates as equal; the follow-up below corrects the earlier local
24.14 behavior. The original failing prototype rejected infinite timestamps
before invoking the callback; both paths now preserve the source's order.
Creation of the Chat, runtime session, suspended lane, optional legacy placement,
messages and behavior fork count shares the original transaction. Archived Chat
positions count toward ordering, nonprimary worktrees retain exclusive suspended
lanes and starting heads, and copied metadata retains its original attribution.

Standalone forks keep their different commit model. They call the existing
standalone creator after reprotection, then copy settings and messages separately.
Later failures delete the new Chat; its already committed provision job remains.
If cleanup itself fails, its SQL error wins and the earlier records remain,
matching the source. Both paths keep the parameterized bulk message insertion,
SQL NULL behavior and actual driver failures for oversized parameter lists.

The real repository comparison passes 48 operations and 82 snapshots per backend
on native PGlite, private PostgreSQL and external PostgreSQL. It checks ownership,
history prefixes, non-opaque refusal, source/destination changes during the worker
callback, Date precision, classifications, attribution, layout/lane state, forced
SQL failures, cleanup failures and exact reopen state. A 4,000-message copy
actually attempts the oversized bulk operation and checks rollback and continued
database usability. No capability probe substitutes for that operation. Twenty
Chat/scratch/fork schemas match 15,980 protocol, issue and rendered-error cases.

The HTTP suite passes all nine local backend/authentication combinations using
the unchanged worker transport and production `protectChatMessage` and
`reprotectChatMessages` functions with a test-owned endpoint key provider. The
key stays outside both servers. Each implementation/profile compares 25 anonymous,
26 password or 27 account HTTP observations, 14 reprotection commands, 516
decryption/binding proofs and eight ordered Chat events. It checks a 205-message
history, 100-message batching, prefix copies, ordinary duplicate inserts, worker
errors/invalid results, Task/owner/offline rejection, standalone provisioning and
an admitted fork whose HTTP caller disconnects. Every stored copied message is
decrypted under its new ID, retains its expected plaintext and rejects the old
ID binding. Raw encrypted commands/state are retained alongside compared metadata;
the server diagnostic output contains no test plaintext sentinel.

A separate actual-source HTTP oracle verifies command-budget failures: the Rust
route preserves `429`, the error body and `Retry-After`, including the source
route's earlier duplicate-message classification when both conditions apply.

The broad `pnpm check` again finishes with the existing source provider-selection
failure at `local-foundation.test.ts:7218` (1,662 pass, 57 skip, one fails;
483 seconds). Source server, worker, shared package and dependency files are
unchanged. The separate Linux workspace-disconnect suite also has an unresolved
`ECONNRESET` failure in run `41170859141`, job `124448318451`; its uploaded
artifact was downloaded and SHA-256 verified for a separate follow-up. These
results do not establish a green broad check or platform acceptance.

The same run's Windows contracts job `124448318427` also exits during the PGlite
execution-target repository suite: the Rust fixture exits with code `3221225725`
while resolving a project. Its artifact and log are retained for investigation;
this fork milestone does not claim a Windows pass.

Full client/full-worker key provisioning and filesystem integration, supported
platforms, further interruption boundaries, Redis coordination and packaging
remain required. General messages, native history ingestion, execution queues,
Tasks, Goal/automation continuity and default cutover remain unfinished. Normal
builds still use the Node server.

## Controlled workspace admission caller connections

The Linux diagnostic reproduces the earlier workspace restart reset on iteration
nine of run `41176923583`, job `124466282896`. Its SHA-256-verified artifact
`13032917940` retains all eight successful iterations and the partial failing
password/Rust iteration. Socket 25 connected to the old server 41 milliseconds
before that process closed. After a new process started on the same port, the
shared global fetch pool reused that socket for the unchanged worker's heartbeat
125 milliseconds later and received `ECONNRESET`.

The controlled test caller now uses the existing `streamingHttpRequest` helper
with its own socket. Production servers and worker heartbeat behavior are
unchanged. Actual caller aborts, SQL lock/PID witnesses, durable admissions,
revisions, worker commands and same-port restart assertions remain in place.
Partial lifecycle evidence and optional HTTP connection tracing are retained
even when a scenario fails. The repeat driver stops at the first failure and
does not retry failed requests or scenarios.

Two local PostgreSQL iterations pass all twelve authentication/runtime scenarios;
the anonymous PGlite and private PostgreSQL lifetime suites also pass. Corrected
Linux run `41178019278`, job `124469506406`, passes all twenty iterations and
120 authentication/runtime restart scenarios. Its SHA-256-verified artifact
`13033962863` also proves that all 240 post-restart heartbeat and catalog requests
use connections established after the old process closed. The tested source
head is `5713c2f66bd30ea91c2733819f005d413ca5220f`. The required broad `pnpm check`
completes in 430 seconds with the existing provider-selection failure at
`local-foundation.test.ts:7218` (1,662 pass, 57 skip, one fails). This work does
not establish a green broad check, Windows acceptance or packaged activation.

## Protected messages and persisted turn reads (pending platform acceptance)

The native server now handles message listing, turn-aware pagination, encrypted
Agent appends and persisted native-history turn reads. The archive endpoint is
read-only: it neither dispatches to a worker nor requires a live history binding,
and it emits no mutation invalidation. An owner can read an archived Chat's
persisted turns. Multiple owned bindings for the same turn remain separate
candidates in binding order; a larger revision does not hide another binding.

The repository port includes plain, Task and encrypted append/upsert operations,
idempotency lookup, route attribution, headers, latest protected user lookup and
turn trimming. Agent writes retain the project/Chat locks and atomic message,
touch and DTO boundary. Plain and Task writes preserve their separately committed
steps, including the inserted row surviving a later touch or DTO error. SQL NULL
and JSON null retain their distinct attribution behavior. Committed canonical
history mappings return the existing message and reject conflicting identities;
reservations at revision zero do not claim canonical ownership.

The Source Agent idempotency comparison uses raw stored JSON ordering, while the
Task path parses its stored envelope before comparing. Tests retain that
observable difference rather than changing the protocol during the port. Input
validation, missing/foreign/archived lookup precedence, page-query errors, Task
write refusal and typed canonical-history errors are compared against real Node
HTTP responses. Turn pages retain the source's backward user boundary and
500-header search limit.

Local macOS repository checks compare 46 query operations and nine snapshots,
then 62 write/archive operations and eight snapshots per backend. Both suites
run their Rust fixture with a 1 MiB thread stack. The expanded state snapshots
include archive bindings and turns, and the actual backend reopen also checks
the complete archive response. Twenty-eight Chat schemas match 20,341 actual
protocol/issue/rendered-error cases.

Local macOS repository and actual HTTP/Live comparisons pass on native PGlite,
private PostgreSQL and external PostgreSQL. The HTTP suite exercises anonymous,
password and account authentication, production worker endpoint encryption and
actual endpoint decryption with test-owned keys outside both servers. Returned,
published and reopened Agent messages retain their expected content and reject a
wrong message-ID binding; server diagnostics contain no plaintext sentinel.
Task envelope persistence is checked separately and does not establish Task
endpoint encryption or ingestion acceptance.

External PostgreSQL additionally holds real project/Chat locks and observes the
blocked backend PIDs before disconnecting callers, admitting competing writes
or archiving the Chat. Admitted writes commit after their callers disconnect;
competing duplicate appends retain the source's one-success/one-error result.
Late archival refuses the write. A real trigger failure after INSERT rolls back
both the Agent message and Chat touch without publishing a message event. Actual
Live ordering is compared after these races as well as ordinary responses.

The current broad `pnpm check` exits 1 after 454 seconds: 1,662 source-server
tests pass, 57 skip and the provider-selection assertion at
`local-foundation.test.ts:7218` fails. A fresh focused run on clean Primary
`584a14af9` reproduces that same failure. This is retained baseline evidence,
not a green broad check. The Source server/worker implementation and dependency
files are unchanged by this milestone. The separate full formatting check
also reports 12 unchanged baseline files; focused formatting of this milestone
is checked separately.

Run the suites from the repository root, replacing DATABASE with pglite,
bundled-postgres or postgres:

```sh
node scripts/server-rust/cargo.mjs test --test chat_contracts -- --nocapture
node --import tsx scripts/server-rust/chat-message-repository-compatibility.mjs --database DATABASE
node --import tsx scripts/server-rust/chat-message-write-repository-compatibility.mjs --database DATABASE
node --import tsx scripts/server-rust/chat-message-http-compatibility.mjs --database DATABASE
```

The dedicated CI job runs these checks on Linux, macOS and Windows. Configuration
of those jobs is not platform acceptance. Canonical history ingestion, native
command execution, streaming, queues, approvals, Tasks, Goal continuation,
complete client/full-worker integration, Redis coordination, packaged activation
and default cutover remain required. Ordinary builds still use the Node server.

## Fork snapshot Date equality on the maintained reference runtime

Linux run `41179568205`, contracts job `124474015015`, exposed a real Source/Rust
mismatch. For a Chat with `updated_at = infinity`, Source Node 24.22.1 completed
reprotection and created the fork; Rust returned a conflict. Artifact
`13035533686` was downloaded and its ZIP SHA-256 verified as
`26de0e7f6b9bb4cf4325e81b82849750c73d3476fa092d59cab6282571a800bb`.
The same unmodified repository case fails locally under the exact CI runtime.

The earlier local reference was Node 24.14.0. Its `isDeepStrictEqual` rejects two
invalid Date instances. The official Node 24.22.1 executable instead considers
them equal, as does its
[Date comparison implementation](https://github.com/nodejs/node/blob/v24.22.1/lib/internal/util/comparisons.js).
The downloaded Darwin ARM64 runtime matches its official SHA-256,
`654ba79de6155647e22321932b45f2a1ccb705976cc337c9b8e278beb085a628`.
This corrects the earlier claim about Node 24 as a whole: the reference version
matters, and older 24.14 behavior differs at this boundary.

Rust now uses a private invalid-Date marker for the fork reread snapshot. It is
distinct from SQL null and valid timestamps, stays out of responses and stored
messages, and requires no Node runtime. Finite timestamps still compare at
JavaScript millisecond precision. A new oracle executes the actual reference
utility against 407 row comparisons, including null, both PostgreSQL infinity
values, Date range boundaries, offset-equivalent instants, submillisecond
precision, property ordering and changed JSON metadata. All comparisons match
Node 24.22.1 locally. Running the same oracle on 24.14 records 27 differing
comparisons rather than disguising the reference-version difference.

The expanded repository suite explicitly requires successful complete forks
for unchanged positive/negative infinity and for a change between two invalid
Dates. Valid-to-invalid and invalid-to-valid changes still reject after exactly
one reprotection callback. Complete table/sequence snapshots prove that only the
controlled callback timestamp mutation survives those conflicts. Existing
source/destination/message changes, encryption classification checks, SQL
failures, cleanup behavior and reopen assertions remain in the suite.

The new snapshot oracle is part of the Linux/macOS/Windows contract jobs.
Local checks do not establish platform or packaged acceptance, and the full
server replacement remains unfinished.

## Complete SQL lock witnesses in controlled message races

Windows message run `41183089946`, job `124484345954`, passed all three
query/write repository pairs and both PGlite/private PostgreSQL HTTP matrices.
The external PostgreSQL Source/password late-archive probe reached its expected
blocking-PID count, then failed because a sampled wait-event field was null.
Artifact `13036340964` was downloaded and its ZIP SHA-256 verified as
`0a4c68041870a2e7bfaf1431d1c14461de1c0833f0825ed7d177f7b786d8d67e`.
The failure occurred while collecting the complete lock witness.

The test observer now continues until both the expected blocker count and every
`Lock` wait event are present in the returned sample. It retains matching-count
samples with incomplete wait fields for diagnosis. The deadline, held SQL locks,
actual blocking PIDs, both final assertions, single HTTP attempts, caller-abort,
commit, rollback, encryption and ordered Live checks remain in place. This change
is confined to the controlled test caller; production behavior is unchanged.
A fresh Windows job must establish acceptance.

The current broad `pnpm check` runs for 523 seconds and again reports the Source
provider-selection failure at `local-foundation.test.ts:7218`: 1,662 tests pass,
57 skip and one fails. A fresh Node 24.22.1 run on clean Primary `c749612c0`
reproduces that assertion. Full formatting reports 12 unchanged baseline files;
changed-file Prettier passes. The earlier intermediate formatting run also
caught the edited ledger before its final formatting; the ledger is now fixed.
These results do not establish a green broad check or a deployable replacement.

Linux's dedicated message job in that run passes all three storage modes and all
nine authentication/backend profiles. Artifact `13035975785` contains nine JSON
reports, all inspected after verifying ZIP SHA-256
`ac61057e3a2fe2a7bd10d02eb00a24fa9e283650313861e2a42503bb06df14ff`.
The corrected observer also passes the fresh local external PostgreSQL matrix,
including all five races per runtime/auth profile. This scoped evidence does not
establish a Windows pass or packaged readiness.
