# Rust server replacement

Status: **implementation in progress; not a deployable replacement**.

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
restart to acquire the key. Full terminal CRUD, actual encrypted PTY service
flows, shared coordination, supported-platform acceptance and packaging remain
required by the replacement goal.

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
