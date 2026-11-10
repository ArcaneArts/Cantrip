# Current replacement acceptance

The server replacement remains incomplete. Rust is the default server, and the
production Node workspace and entrypoints have been retired. The worker remains
Node. The old server is an explicit development compatibility reference. See
[default cutover](RUST_SERVER_DEFAULT_CUTOVER.md) and
[production Node retirement](RUST_SERVER_NODE_RETIREMENT.md) for their qualification.
Historical ledger entries describe their original milestones; their remaining-work
text is not a current implementation inventory. The
[current macOS encrypted desktop qualification](RUST_SERVER_DESKTOP_ENCRYPTED_ACCEPTANCE.md)
passes all three original-profile upgrades and restarts with retained client keys.
The [native desktop workspace qualification](RUST_SERVER_DESKTOP_WORKSPACE_ACCEPTANCE.md)
also exercises actual macOS popouts, dirty documents, server restart, WebView
reload, application SIGKILL/restart, native close/return and explicit worker-file
saves across all three stores. Its debug app and isolated development vault have
a distinct scope from the release-app encryption qualification.
Final supported-platform shipping and requirement-by-requirement reconciliation
remain open.

The [current worktree observation qualification](RUST_SERVER_WORKTREE_OBSERVATIONS.md)
repairs the omitted native worker-status consumer and compares its durable state,
Live events, failures and restart behavior across all nine local storage/authentication
cells. Historical durable Git-operation reconciliation remains an explicit active
gap despite the retired plaintext Git HTTP routes.

The [current Chat/model identity qualification](RUST_SERVER_CHAT_IDENTITY_CONTRACTS.md)
adds 3,368 paired observations across all three stores and repairs empty model
route selection, offline Plan status handling and missing/null resume identity.
It also binds 26 additional current repository identities and both Plan routes
to successful operations. These scoped results advance the remaining contract
audit; they do not close full supported-artifact or original-goal acceptance.

The [Linux ABI qualification](RUST_SERVER_LINUX_ABI.md) fixes the actual Debian 12
ARM64 native PGlite link failure. Fresh `1.1.2783` ARM64 and x64 images, exported
Ubuntu distributions and systemd/Caddy rehearsals pass their three-store matrix.
This preserves the original Linux baseline; complete desktop acceptance and the
Rust-default/production-Node removal remain separate.

The [current native package qualification](RUST_SERVER_CURRENT_PACKAGED_ACCEPTANCE.md)
adds actual Windows x64 artifact execution on an ARM64 Windows kernel. All three
stores, emoji/space package and profile paths, exports, restart and the embedded
runtime fallback pass after static zlib and per-process UTF-8 repairs. Current
macOS server-package and full-worker desktop-supervisor comparisons also pass
on all three stores. Complete app/platform, update, historical-profile,
performance and final cutover requirements remain separate.

The [current wire reconciliation](RUST_SERVER_CURRENT_WIRE_COMPATIBILITY.md)
closes the missing schema/command fixtures and stale public-surface expectations.
Broad native comparisons, complete outgoing command mutations and protocol
package tests pass locally. Five strengthened fixture families have separate
current native comparisons; their cases overlap the broad run. This establishes
the recorded parser coverage, while full product and shipping acceptance remain
separate.

The [Task Goal worker-loss comparison](RUST_SERVER_TASK_GOAL_WORKER_RECOVERY.md)
now qualifies active implementation recovery with the final optimized executable
on all three stores and all four shared pairings. It preserves one opaque native
answer, the original Task/Goal authority and exact completed restart state. The
six existing production Task and Agent/Task suites also pass. Changed-response
replay, legacy publishers, historical delivery, autonomous cycles and actual SQL
rollback have separate all-store repository qualification. Broader worker/native
loss, platform/artifact, performance and final cutover requirements remain.

The [Task worker-process recovery](RUST_SERVER_TASK_WORKER_RECOVERY.md)
qualification adds explicit terminal observation and guarded failure settlement
for expired direct/planning rounds. Current debug and optimized peers pass
direct-Task worker loss on all three stores and all four shared pairings,
including repeated Recovery, the real legacy retry adoption timer, explicit
Retry and exact history restart. Optimized peers also pass planning-round worker
loss on that complete matrix. Resumption/Goal, broader worker-loss and final
replacement acceptance remain separate.

The [current product and shared Agent recovery](RUST_SERVER_SHARED_AGENT_RECOVERY.md)
qualification refreshes the actual production matrix to the current 92-patch
native runtime and rebuilt worker. All six local storage/product cases and both
active Agent/Goal crash roles across all four shared peer pairings pass. It also
repairs premature logical GUI completion after remote relay-owner loss in both
servers. Remaining platform/artifact, worker-loss, long-outage, performance and
cutover acceptance is separate; broader repository checks retain their failures.

The [credential lifecycle comparison](RUST_SERVER_WORKER_CREDENTIAL_LIFECYCLE.md)
captures enrollment creation/completion/rejection and credential rotation/revocation.
Its debug and optimized production matrices pass all nine storage/authentication pairs,
including actual account/identity replacement, rejected replacement rollback,
delivery outcomes and redaction. Separate logger cases preserve console-only
undefined properties without introducing them into archived JSON. Complete
current artifact/platform and replacement acceptance remain required.

## Current implementation and evidence

| Area                          | Current evidence                                                                                                                                                                                                           | Remaining acceptance                                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Declared HTTP routes          | The computer-use milestone's production probe completes 584 requests per peer with zero generic fallback differences.                                                                                                      | Successful behavior, events and recovery across complete domains; invalid-input routing alone is insufficient.                              |
| Generated contracts           | The refreshed source audit compares all 15 embedded schema graphs plus the endpoint-provider map with rebuilt TypeScript. All 16 match.                                                                                    | Custom semantics and full runtime/product/platform qualification.                                                                           |
| Desktop packaging             | PR #2749 integrates the production supervisor and explicit Rust runtime packaging.                                                                                                                                         | Current integrated artifacts, supported platforms, update behavior and final default selection.                                             |
| Existing desktop profiles     | PR #2752 packages and automatically invokes bounded conversion. Its archived eight-case acceptance and actual app upgrade, post-write Node rollback and native re-upgrade pass locally.                                    | Broader historical profiles, current artifacts, other platforms and full product rollback.                                                  |
| Winterhold                    | PR #2753 implements native distribution installation, migrations, systemd and Caddy. Its archived local three-store rehearsal exercises 18 installer calls and external PostgreSQL Node/Rust post-write rollback over TLS. | Current artifacts and remaining platform/product/coordination/performance qualification. No production deployment is authorized or claimed. |
| Worker mutation notifications | Enrollment-code creation, credential rotation and credential revocation now publish the existing worker invalidation after successful response completion.                                                                 | Supported-platform/package and full product acceptance.                                                                                     |

Desktop and Winterhold are implemented with scoped qualification; their previous
ledger status of `unported` was stale. The profile reports were read from the
retained archive and checked against their original member hashes during this
reconciliation. They retain their historical source/artifact scope. The Winterhold
result uses an ARM64 systemd fixture executing an x64 artifact through binfmt;
it does not establish bare-metal x64 or Windows readiness.

## Reproduced worker notification gap

The existing Node response hook publishes a `worker` invalidation for successful
mutations under `/api/workers/`. Rust's legacy enrollment/credential handler
omitted this effect, even though later worker-management handlers implement it.
A real HTTP/App Live comparison reproduced a successful native enrollment-code
creation with zero events against the reference's one event. The original
failure is retained.

The repair uses the existing response-completion adapter. Enrollment-code
creation retains a null entity identity; credential rotation/revocation retain
the worker identity. Reads, rejected mutations and internal worker requests do
not acquire a new broad invalidation. Real presence events remain separate.

All nine macOS arm64 storage/authentication pairs pass: PGlite, bundled PostgreSQL
and external PostgreSQL, each with none/password/accounts authentication. They
retain 99 paired HTTP observations, 81 paired publication observations, 27 paired
successful invalidation events and 18 clean server exits. No worker command
implementation is substituted; rotation exercises an offline enrolled worker.
The fixture observes actual audit completion before checking events: PostgreSQL
can finish Node's audit hook after the response body arrives. Earlier oracle
timing failures and the original missing-notification result remain retained.

Strict all-target Clippy and all 76 Rust library tests pass locally. This is
not full replacement acceptance. Development validation remains local; GitHub
Actions is reserved for releases and deployments.

```sh
node --import tsx scripts/server-rust/worker-enrollment-live-compatibility.mjs \
  --database pglite --report /absolute/path/to/enrollment-live.json

node scripts/server-rust/source-drift-audit.mjs \
  --baseline 8bc4c5d8100124136b4d77df387b69164f5e40da \
  --report /absolute/path/to/source-audit.json
```

Build the current workspace packages and Node reference first. Supply the native
HTTP fixture, private PostgreSQL helper/binaries and native PGlite runtime through
the same environment variables used by other server comparisons. Repeat the
notification suite for both PostgreSQL modes and all authentication profiles.

## Open background-service comparisons

The current composition has native implementations for the seven durable job
families: replicas, folder setup, workspace repository discovery, standalone
roots, GitHub conversion, Chat relocation and Chat import. Their startup recovery,
queued work and periodic sweeps are composed in `auth/service.rs`. Existing
milestones retain their separate behavior and interruption qualifications.
This source mapping does not prove every background-service invariant.

The [approval-expiry qualification](RUST_SERVER_INTERACTION_EXPIRY.md) reproduces
and repairs the first discrepancy, including the existing Node account-owner
and shutdown-restoration defects. All nine local storage/authentication pairs
and a real held-SQL shutdown pair pass. Current artifact/platform acceptance
remains separate.

The [worker catalog/quota comparison](RUST_SERVER_WORKER_CATALOG_REFRESH.md)
reproduces missing native reconnect refresh, implements that refresh and the
fifteen-minute producer, and passes all nine local storage/authentication pairs.
Separate peers also pass the real fifteen-minute interval and a held quota
INSERT during shutdown. The current optimized executable also passes the actual
fifteen-minute interval and held-INSERT shutdown with fixture SQL routes absent
on both peers. A broader catalog comparison additionally repairs the custom endpoint
label in native errors and worker commands.

The [credential reconnect qualification](RUST_SERVER_CREDENTIAL_RECONNECT.md)
reproduces and repairs the next discrepancy: Rust's existing migration
coordinator had no production worker-connection caller. All nine local
storage/authentication pairs now match capture/purge, identity and revision
guards, nonportable credentials, failures, repeated reconnects and public
counter logs. The current optimized artifact also passes actual deadlines,
query failure/recovery, held credential UPDATE shutdown and retained
restart/purge. This does not establish real provider login or actual worker
credential-file encryption/deletion.

The [server log archive qualification](RUST_SERVER_LOG_ARCHIVE.md) adds the
bounded minimized-record buffer and daily native filesystem archive, wires the
production startup/shutdown lifetime and routes catalog/account lifecycle
diagnostics through shared capture. Sixteen production Node/Rust peer runs
cover all three stores, configuration, signals, failure and actual archive
recovery. The [HTTP and console qualification](RUST_SERVER_HTTP_LOGGING.md)
adds actual response-completion capture, console presentation and stream-error
behavior, and repairs fallback parser ordering exposed by the comparison.
The [request-target and route-level comparison](RUST_SERVER_REQUEST_TARGET.md)
also repairs URL decoding, early 400/414 responses, empty terminal parameters,
method-fallback headers and Pino child-level filtering. Its actual raw HTTP and
controlled-stream comparisons retain their distinct qualification scope.
The [database lifecycle qualification](RUST_SERVER_DATABASE_LIFECYCLE.md) adds
connection/migration/probe diagnostics and repairs connection/subscription retry
boundaries and retained-key initialization. A subsequent production comparison
passes actual role-wide PostgreSQL refusal/recovery under all three authentication
modes, retaining original sessions and accepted writes. Its bounded admission
fault does not establish long outages or other database/product interruptions.
Additional operational consumers remain unreconciled;
scoped passes do not prove identical whole-server logging or complete
background-service invariants.

The [accounting diagnostics comparison](RUST_SERVER_ACCOUNTING_DIAGNOSTICS.md)
reproduces missing native persisted records and routes reconciliation, history
maintenance and bandwidth-meter producers through shared capture and noise
control. Its current local qualification includes actual reference classes,
all nine storage/authentication production pairs and real PostgreSQL timer
failure/recovery and held-final-flush shutdown. Other production consumers and
the original full replacement acceptance remain required.

Continue those comparisons before final product/fault/performance and supported
artifact acceptance. Rust default selection and production Node-server removal
remain required. Schema equality, source pairing and zero route fallbacks do not
substitute for those requirements.

The [worker bridge comparison](RUST_SERVER_WORKER_BRIDGE.md) qualifies native
diagnostics, packet sequence/callback repairs and connected shutdown handshakes.
All nine storage/authentication pairs pass on debug and optimized candidates;
separate actual wire tests cover held/early/missing ACKs, late responses and
blocked credential storage. Rejected authentication also retains its close ACK.
The optimized candidate also passes eighteen dedicated wire/authentication
server runs. Supported-artifact and complete replacement acceptance remain
separate.

The [worker authentication comparison](RUST_SERVER_WORKER_AUTHENTICATION.md)
ports rejected/successful authentication and claim-failure capture with the
existing repetition and redaction policy. Actual Redis paused writes reproduce
and repair a five-hundred-millisecond command timeout and the missing attachment
authentication deadline. Late claims remain owned after timeout, with actual
successful-claim discard and failed-claim capture before a held close ACK. The
debug and optimized matrices pass all nine storage/authentication pairs, with
fourteen additional optimized/reference Redis and closing-handshake process
runs. Current supported artifacts and full replacement acceptance remain separate.
