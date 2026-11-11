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
The [current signed macOS desktop qualification](RUST_SERVER_DESKTOP_SIGNED_UPDATE.md#current-installed-app-and-signed-update)
updates the installed app to `1.1.2845` on all three stores, retains the
authenticated client, server, worker and written setting, and verifies the
installed bundles against the signed archive.
The [current installed Windows x64 qualification](RUST_SERVER_WINDOWS_CURRENT_ACCEPTANCE.md#windows-x64-installed-112845)
updated the installed app to `1.1.2845` through its signed updater and verified
14,090 files. The retained profile and all three database modes passed
reopening, real worker replies and tray shutdown. The Windows standalone
distribution passed on all three stores as well.
The [native desktop workspace qualification](RUST_SERVER_DESKTOP_WORKSPACE_ACCEPTANCE.md)
also exercises actual macOS popouts, dirty documents, server restart, WebView
reload, application SIGKILL/restart, native close/return and explicit worker-file
saves across all three stores. Its debug app and isolated development vault have
a distinct scope from the release-app encryption qualification.
Final supported-platform shipping and requirement-by-requirement reconciliation
remain open.

The packaged macOS ARM64 `1.1.2845` server and signed desktop worker passed
the current Task and Agent product matrix against the Node reference. All
six suites cover real native execution across PGlite, bundled PostgreSQL
and external PostgreSQL. The reports record 150 product steps, 42 clean
server exits, 54 clean worker exits and 144 model requests. Protected model
operations also pass 72 paired cases across the same stores, including
cancellation, exact usage, worker loss and retained restart.
[Current product evidence](security/rust-server-current-native-product.json)

The local source and server boundary audits verify all 17 generated contract
graphs and maps, the current route inventory, real Rust authentication after
restart and current HTTP authority boundaries.

The [Linux Redis TLS comparison](RUST_SERVER_REDIS.md#packaged-linux-redis-tls)
qualifies authenticated TLS, certificate trust, Redis process restart, worker
routing, App Live replay and cross-peer sign-out through the optimized
`1.1.2855` Linux ARM64 and x64 images and the compiled Node reference. Both
images also pass the standalone suite on all three stores.

The [packaged active Task recovery](RUST_SERVER_INFLIGHT_RECOVERY.md#packaged-112845-dependency-recovery)
qualifies `1.1.2845` with the signed desktop worker on external PostgreSQL.
All four Node and Rust pairings complete one original Task during Redis
process loss and recover worker routing afterward. Two Rust servers preserve
and deliver the original worker outcome through PostgreSQL process loss.

The [embedded PGlite cache recovery](RUST_SERVER_DATABASE_LIFECYCLE.md#embedded-pglite-cache-recovery)
repairs actual startup failure from incomplete automatically extracted assets.
Concurrent fresh and retained profile starts pass with the original identity
and accepted write preserved. Configured assets still surface actual failures.

The [host inventory and CantripOS guest comparison](RUST_SERVER_REMOTE_SURFACES.md#current-host-inventory-and-cantripos-guest-surfaces)
fixes the single-worker desktop inventory request. It qualifies encrypted
host inventory, a real guest desktop before and after restart, stale
placement rejection and an encrypted guest TCP tunnel. All 323 worker
command identities now have scoped ledger evidence.

The [current computer-use lifecycle comparison](RUST_SERVER_COMPUTER_USE.md#current-browser-and-full-worker-lifecycle)
qualifies effects sync, operations and preview open/Stop through the browser
and full worker on all three stores and all four PostgreSQL and Redis
pairings. It verifies encrypted approval denial, fresh leases after feature
re-enable and a decoded PNG through the explicit fake capture backend. The
scoped command ledger accounts for 319 of 323 identities.

The [current browser surface lifecycle comparison](RUST_SERVER_REMOTE_SURFACES.md#current-browser-suspend-and-resume)
qualifies suspend and resume through the full worker and actual Chromium on all
three stores and all four PostgreSQL and Redis pairings. An offline resume
persists the existing error. Server restart clears that transient status and
retains exact encrypted state. A successful resume restores authenticated frames
on the original attachment. Scoped worker command coverage accounts for 315 of
323 identities.

The [native Agent approval cancellation comparison](RUST_SERVER_AGENT_APPROVAL_CANCELLATION.md)
passes the full-worker cancellation and normal approval control on all three
stores. Both peers interrupt the next prompt in the canceled Agent before it
reaches the model. Restarting the worker recovers the same Agent, and both
approval outcomes and the recovered reply survive server restart. Scoped worker
command coverage accounts for 313 of 323 identities.

The [first-turn Chat and Agent title comparison](RUST_SERVER_INLINE_CHAT_LABEL_ACCEPTANCE.md)
qualifies private title grants, first-turn inference and byte-for-byte title
retention after restart on all three stores. An unusable label preserves the
existing title and the response completes. A newly provisioned standalone
Chat executes through its opaque scratch routing handle. The direct scratch
resolve handler stays in the worker contract. Scoped worker command coverage
accounts for 312 of 323 identities.

The [automatic Task title comparison](RUST_SERVER_TASK_LABEL_ACCEPTANCE.md)
fixes browser authorization for the worker's private label key. With that key,
the current Rust server and Node reference complete standalone label generation
through the full worker and native Codex on all three stores. The browser opens
the same encrypted title after restart, and an unavailable title key still
allows Task planning admission. Scoped worker command coverage accounts for
311 of 323 identities.

The [provider sign-out comparison](RUST_SERVER_PROVIDER_AUTH_WORKER_ACCEPTANCE.md)
passes the existing browser SDK and full worker for legacy ChatGPT and Grok
accounts on all three stores. The selected credential file is removed while a
neighboring account's file remains byte-for-byte intact. The current status route
uses stored account state and legacy capture, and the original direct status
command remains worker-only. Scoped worker command coverage accounts for 310 of
323 identities.

The [active Task PostgreSQL comparison](RUST_SERVER_INFLIGHT_RECOVERY.md#active-task-during-a-postgresql-process-outage)
passes two 45-second outages with two current Rust production servers and
the full worker. The original outcome stays in the worker's durable outbox
until the same database cluster reopens and accepts it. The existing browser
then sees one completed result, and a new remote worker request succeeds.
Node-reference failures under this fault remain recorded.

The [active Task Redis comparison](RUST_SERVER_INFLIGHT_RECOVERY.md#active-task-during-a-redis-process-outage)
passes all four Node/Rust pairings on shared PostgreSQL. Across a real
45-second Redis outage, the remote Task retains and extends its original
PostgreSQL lease and completes once before Redis restarts. The unchanged worker
reclaims coordination with a fresh connection ID and receives a new remote
request. A separate mixed-pair control passes an actual worker-owner server
crash with the surviving Rust server holding the Task lease.

The [WorkerLink lease recovery comparison](RUST_SERVER_WORKER_LINK_LEASE_RECOVERY.md)
passes real LAN peer and native LOCAL broker renewals through the full worker
on all three stores. It verifies the reconnect grace response, old authority
retirement after worker or server replacement, and fresh lease renewal after
both process kills. Scoped worker command coverage accounts for 308 of 323
identities.

The [terminal and replica qualification](RUST_SERVER_TERMINAL_REPLICA_ACCEPTANCE.md)
passes real CLI scrollback and legacy replica deletion through the existing full
worker on all three Rust storage modes. Current import and worktree-list controls
also account for two retained legacy worker handlers. Scoped worker command
coverage accounts for 306 of 323 identities.

The [current Windows qualification](RUST_SERVER_WINDOWS_CURRENT_ACCEPTANCE.md)
passes `1.1.2845` standalone across all three stores on the Windows x64
guest and verifies 2,281 package files and three SQL export checksums. The installed `1.1.2839` to
`1.1.2841` signed update retains the PGlite profile, server identity and
accepted write and exercises the full worker before and after installation.
The installed app converts an archived Node profile and preserves all
1,660 original files. The installed bundled and external PostgreSQL profiles
also verify their selected database process, an accepted settings write and
the real worker reply. The separate Windows ARM64 guest qualifies Node
`22.23.4` worker restart and owner loss across all three stores, plus
post-write rollback and native re-upgrade of the published Node profile.

The [current Linux ARM64 qualification](RUST_SERVER_WINTERHOLD.md#current-linux-arm64-qualification)
passes all three stores in the `1.1.2845` container and local systemd
rehearsal. All 18 installer cases pass, and ten direct process hashes confirm
the current and previous native releases through post-write rollback.

The [current macOS ARM64 signed-update rehearsal](RUST_SERVER_DESKTOP_SIGNED_UPDATE.md)
passes `1.1.2786` to `1.1.2831` on all three stores with the same Developer
ID. The real updater rejects a changed archive, installs the valid release,
and retains the encrypted WebView session, worker connection, server identity
and accepted write. The two private stores and the external PostgreSQL
connection are verified before and after installation.

The [current Winterhold and Linux x64 qualification](RUST_SERVER_WINTERHOLD.md#current-linux-x64-qualification)
uses the exact `1.1.2845` distribution and container across all three stores.
The container passes 2,546 package hashes per store. All 18 installer cases
pass with verified Caddy TLS, post-write rollback to a distinct older Rust or
Node release, and ten running executable hashes. The local x64 runs use Rosetta
on an ARM64 Linux host. Final desktop and multi-instance acceptance remain open.

The [CantripOS source backup comparison](RUST_SERVER_OS_SOURCE_BACKUP.md)
repairs public backup placement errors and qualifies physical restore and
rollback in an actual guest across all three stores. Both peers recover the
original encrypted worker receipts after lost replies. The guest retains the
source, the original destination home and the write made after restore.
Scoped worker command coverage accounts for 302 of 323 identities.

The [CantripOS Run lifecycle comparison](RUST_SERVER_OS_RUN_LIFECYCLE.md)
uses the existing browser SDK, production servers, full worker and real Linux
guest across all three stores. It verifies encrypted output and the same
process across server and worker loss, then advances the generation on
restart and terminates the replacement on Stop. Scoped worker command coverage
accounts for 300 of 323 identities, including four worker handlers without
current server producers. The worker's large retained-output truncation test
remains open.

The [encrypted Chat steer comparison](RUST_SERVER_LEGACY_CHAT_STEER.md)
exercises an active Chat without a native activation across all nine storage and
authentication combinations. It verifies the actual worker codecs and steer RPC
inputs, rejection, and exact encrypted message and queue state through 18 paused
server restarts. Scoped worker command coverage is 290 of 323. The native turn
and RPC result are controlled, and unpaused reconnect and settlement remain open.

The [encrypted Chat import comparison](RUST_SERVER_ENCRYPTED_CHAT_IMPORT.md)
runs the worker's message, metadata, and relay encryption across all nine
storage and authentication combinations. The tests compare 330 scenarios and
621 HTTP observations, retain ciphertext through 18 server restarts, and reject
all 18 altered relay chunks with partial upload cleanup. The scoped worker
command ledger covers 289 of 323 identities.

The [managed automation resume qualification](RUST_SERVER_AUTOMATION_RESUME_CONTRACTS.md)
restores current-user Live invalidations after successful public Chat execution
mutations. All nine storage and authentication combinations match 108 product
HTTP observations, 27 paired worker SDK requests and 117 Live events, with 18
retained server restarts. Scoped worker command coverage is 288 of 323. Native
resume and Goal mutation results are controlled.

The [current Task execution qualification](RUST_SERVER_TASK_EXECUTION_CONTRACTS.md)
compares scheduled direct and initial planning operations and protected
follow-ups across all nine storage and authentication combinations. The
existing worker codecs and SDK produce 156 paired product HTTP observations,
108 native input acknowledgements, 180 matching Task message events and 36
exact reopens. Two partial mappings bring worker command coverage to 286 of 323. The suite controls model replies and leaves final product and shipping
acceptance open.

The [current Goal recovery qualification](RUST_SERVER_GOAL_RECOVERY_CONTRACTS.md)
connects retained Task and worktree recovery to authenticated worker
connections and heartbeats. All nine storage and authentication combinations
pass, with 165 paired HTTP observations and 54 exact reopens. The new Task
source, Task cycle recovery, Agent source recovery and Agent first-cycle claim
recovery mappings bring scoped worker command coverage to 284 of 323.
Controlled native observations, the remaining 39 command identities and full
shipping acceptance remain open.

The [current native interruption/queue qualification](RUST_SERVER_NATIVE_CONTROL_CONTRACTS.md)
repairs public SQL-error diagnostics after actual failed opaque queue updates.
All nine storage/authentication cells pass, including both Chat contexts, actual
worker codec cryptography, transaction rollback, caller loss, worker replacement,
real notification deadlines and complete retained reopen. Its 531 paired HTTP
observations bind three new command identities, bringing scoped coverage to
280/323. Controlled native replies, remaining 43 identities, historical partials
and full final supported-artifact/product acceptance remain separate.

The [current Chat/control qualification](RUST_SERVER_COMMAND_CONTROL_CONTRACTS.md)
repairs standalone queue reads that omitted the revision required by mutations.
All three nine-cell approval, public Chat and Task matrices pass with 2,208 paired
HTTP cases, 702 command witnesses, actual endpoint cryptography/native SDKs and
exact durable reopen checks. Eight new command mappings bring scoped coverage
to 277/323. Controlled native/model replies, historical partials and full final
supported-artifact/product acceptance remain separate.

The [current filesystem/progress Live qualification](RUST_SERVER_LIVE_OBSERVATION_CONTRACTS.md)
passes eighteen production HTTP storage/authentication cells, retaining 1,821
paired cases and 90 original filesystem/progress frames. Separate core Hub
comparisons qualify owner fanout, unsubscribe and replay for `server` with
controlled IO. All 47 Live identities now have scoped mappings; the `server`
mapping is partial transport evidence, without a verified dedicated HTTP
publisher. Worker commands remain 269/323. No production Rust change was needed;
remaining command identities, historical partials and full final product/artifact
acceptance remain open.

The [current Chat Goal/queue qualification](RUST_SERVER_CHAT_GOAL_QUEUE_CONTRACTS.md)
repairs missing native response-completion Goal invalidations. Its three nine-cell
matrices retain 2,403 paired HTTP cases, 18 caller-disappearance phases, actual
worker transport/cryptography and 468 complete Goal/queue Live events. The new
bindings account for eight commands and two Live types, bringing scoped totals
to 269/323 and 44/47. Controlled worker replies do not qualify leaf Git/native
model execution or complete current supported-artifact shipping acceptance.

The [current provider authentication/quota/inference qualification](RUST_SERVER_PROVIDER_LIVE_CONTRACTS.md)
passes all four nine-cell storage/authentication matrices. It repairs public
SQL-error projection drift, retains account/device/quota effects and validates
coalesced inference delivery with held and rejected-owner acknowledgements,
retry and exact raw provider reopen. Its 2,115 paired HTTP observations bind
seven further commands and two Live resources. Totals are 261/323 commands and
42/47 Live types, including partial scopes. Controlled worker replies do not
establish real OAuth/native inference or final supported-artifact acceptance.

The [current persisted-resource qualification](RUST_SERVER_PERSISTED_RESOURCE_CONTRACTS.md)
adds complete accounting and browser/surface rows, exact raw reopen and public
usage/tenant comparisons across all three stores. Browser HTTP also passes all
three authentication profiles. The 165 repository scenarios, 195 paired SQL
stages and 504 paired HTTP case observations bind the final six table identities
and browser configuration command. All 135 tables now have scoped behavioral
evidence; worker-command and Live totals are 254/323 and 40/47. Partial consumers,
remaining categories and complete final shipping acceptance remain open.

The [current provisioning-state qualification](RUST_SERVER_PROVISIONING_STATE_CONTRACTS.md)
passes both nine-cell folder and replica matrices against the production Rust
HTTP server. It adds complete raw project/job reopen comparisons and 108
independently verified admission fingerprints while retaining existing command,
ordered Live, failure and restart assertions. Its 1,119 paired HTTP observations
bind five commands, three tables and three Live resources. Ledger totals are
253/323 commands, 129/135 tables and 40/47 Live types, including partial scopes.
Controlled worker facts do not establish leaf Git/filesystem execution or
complete supported-platform shipping acceptance.

The [current worker/provider state qualification](RUST_SERVER_WORKER_PROVIDER_CONTRACTS.md)
passes the existing twelve-cell worker-management matrix and a new nine-cell
provider-state matrix. Actual catalog commands, SQL rollback, durable model
suppression, worker/server replacement and inference Live identity fences have
864 paired HTTP observations across all three stores. The ledger now accounts
for 248/323 worker commands, 126/135 tables and 37/47 Live resources, including
partial scopes. Controlled catalog replies do not qualify actual provider
execution or successful inference configuration; final shipping and complete
replacement acceptance remain open.

The [current Git/GitHub command qualification](RUST_SERVER_REPOSITORY_COMMAND_BOUNDARIES.md)
reconciles 88 protected repository inner types across both current HTTP scopes,
all stores and authentication modes. It separately qualifies the active Task
dashboard PR-list producer and proves 76 legacy plaintext HTTP identities return
410 without dispatch. The ledger accounts for 244/323 worker-command identities,
including 87 worker-owned protected operations. Full leaf Git/GitHub execution,
remaining category scopes and original-goal shipping acceptance remain open.

The [current suspension and Task outcome qualification](RUST_SERVER_NATIVE_RECOVERY_CONTRACTS.md)
compares the three previously unmapped internal HTTP identities across all three
stores and authentication modes. It repairs suspension error text, an autonomous
Goal post-commit failure and Goal-cycle conflict status. Actual SQL rollback,
worker replacement, server restart, original encrypted answers and historical
round preservation have current paired evidence. The ledger now maps all 584
HTTP identities, including partial scopes, and 121/135 tables. Remaining
command/table/Live scopes, historical partials and final supported-artifact
acceptance remain open; controlled checkpoint facts do not execute native Core.

The [current OS and execution qualification](RUST_SERVER_OS_EXECUTION_CONTRACTS.md)
repairs attachment acknowledgement, Run response routing and public placement
errors. Current nine-cell HTTP comparisons cover source/backup recovery after
server restart, protected repository operations, worktree commands, durable Run
and secret receipts, and four further Live resources. The ledger now maps
581/584 routes; three internal suspension/Task Goal routes remain unmapped.
Controlled worker replies do not qualify actual guest archive execution, and
remaining category gaps and final supported-artifact acceptance remain open.

The [current resource-state qualification](RUST_SERVER_RESOURCE_STATE_CONTRACTS.md)
reconciles the remaining 24 repository identities and refreshes the historical
partial Chat execution-context mapping. It preserves owned-null model defaults,
qualifies Task/queue/status/ordering and terminal/remote-surface behavior, and
records three unused private-helper dispositions. All 370 repository identities
are now accounted for, including five obsolete helpers; other category gaps and
complete supported-artifact/original-goal acceptance remain open.

The [current project/Run state qualification](RUST_SERVER_PROJECT_STATE_CONTRACTS.md)
adds thirteen active repository identities and two explicit obsolete-helper
dispositions. It repairs strict captured-root validation, status/output/lifecycle
error propagation and actual SQL diagnostics, with all-store repository and
nine-cell HTTP comparisons. Optimized package relocation and public checks pass.
The ledger now maps 346/370 repository identities; full replacement acceptance
remains open.

The [current identity-state qualification](RUST_SERVER_IDENTITY_STATE_CONTRACTS.md)
binds twelve further repository identities, repairs stale model-operation usage
attribution, and exercises actual session/mobile-grant callers and desktop-update
counts across all nine storage/authentication cells. Optimized authentication and
relocated-package checks pass all three stores. The ledger now maps 331/370
repository identities; remaining category gaps and final supported-artifact
acceptance remain open.

The [current worktree observation qualification](RUST_SERVER_WORKTREE_OBSERVATIONS.md)
repairs the omitted native worker-status consumer and compares its durable state,
Live events, failures and restart behavior across all nine local storage/authentication
cells. The subsequent [durable Git-operation qualification](RUST_SERVER_GIT_OBSERVATIONS.md)
implements the remaining consumer and all seven repository methods, including
real SQL failures, shared FIFO ordering, held-inspection shutdown, retained
restart and worker reconnect. Complete original-goal acceptance remains open.

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
| Generated contracts           | The refreshed source audit compares all 16 embedded schema graphs plus the endpoint-provider map with rebuilt TypeScript. All 17 match.                                                                                    | Custom semantics and full runtime/product/platform qualification.                                                                           |
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

Continue those comparisons for the remaining product faults, performance and
supported artifacts. Final acceptance requires executable coverage of those
behaviors alongside the source inventory and schema comparisons.

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
