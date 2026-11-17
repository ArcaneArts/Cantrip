# Rust worker replacement

The goal is a complete native replacement of the Node worker, including first-party
helpers, desktop/standalone packaging and the supported legacy profile-upgrade
path. Production still selects the existing Node worker while the native
implementation is built. No native worker cutover has occurred.

Baseline: `a9de3df512c63f272ff6db1d33a46328cd2a253b` (shared foundations delivered
in PRs #3156–#3163). Each subsystem below starts from that source commit; record
its new reference commit and merged PR when its implementation advances. Before
each cycle, inspect relevant changes on current `origin/main`; source hashes aid
locating changes but are not behavioral proof or a runtime gate.

## Architecture and shared ownership

`cantrip_worker_rs` now builds the native `cantrip-worker` executable. It includes
configuration/profile identity, worker logging/archive lifetimes, enrollment and
heartbeat HTTP, a reconnecting WebSocket control connection and authenticated
encryption-grant lifecycle, encrypted root attachment and workspace discovery/import
validation, managed folders, encrypted host Explorer/file-document operations,
host terminal-service supervision, encrypted Git working-tree queries/basic actions,
Git history/inspection, repository graphs/progressive metrics, reviewed branch/remote/tag/submodule/LFS management, partial-patch editing, stash selection/recovery, reviewed commit mutations/conflict
resolution and managed-operation creation/recovery.
Fourteen real native outer command handlers are installed:
`worker.version`, `worker.credential.rotate`, `worker.restart`,
`diagnostics.logs.read`, `worker.encryption.refresh`,
`workspace.repositories.discover`, `workspace.repository-import.validate`,
`repository.operation` (root attachment, metadata, host Git status/file diffs and
eleven basic Git actions, nine history/inspection queries, stash creation/diffs/mutations
and reviewed previews/starts plus current/control/amend recovery and four conflict
inspection/resolution operations, plus reviewed cherry-pick/revert/amend/fixup and
partial stage/unstage/discard, plus branch inventory/eight reviewed branch actions
and remote inventory/five reviewed remote actions, plus tag inventory/detail and
four reviewed tag actions, plus recursive submodule inventory and four reviewed
submodule actions, plus LFS status and nine reviewed LFS actions, plus graph snapshots,
metrics/blame and commit overlays),
`project.folder.materialize`, `project.folder.delete`, `explorer.operation`
(nine host operations), `file-document.operation` (text read/write),
`terminal.services.reconcile` and `terminal.service.restart` (host services).
Explorer implements navigation, search, Git commit lookup and text/entry editing.
Paged reads, transfers, watches, media/tail and delegated OS execution are pending.
Other commands fail explicitly;
unimplemented capabilities are reported unavailable. Production packaging still
selects Node. Nothing invokes the Node worker as a native fallback.

The root Cargo workspace now includes the native worker; the default remains the
Rust server. The worker has no dependency on the server application or database
stack. Direct worker Cargo builds run no server build script, generate no server
version/migration assets, and discover/link no PGlite runtime. The worker embeds
its own version at build time using the authoritative development version resolver;
no Node process is required by the compiled executable.

Reuse the foundations documented in [RUST_SHARED_CRATES.md](RUST_SHARED_CRATES.md):

- `cantrip-config`, `cantrip-wire` and `cantrip-host` already supply parsing,
  UTF-16-compatible JSON, lexical paths and exclusive private-file creation.
- Protocol validation and framing belong in `cantrip-protocol`/`cantrip-framing`.
- Queues, correlation, deadlines and owned lifetimes use `cantrip-transport`;
  worker connection/reconnect remains worker policy.
- Worker logging adapts `cantrip-logging`; automation calculations can reuse
  `cantrip-scheduling`.
- Keep `cantrip-interaction`, `cantrip-cua`, `cantrip-cli` and vendored native
  Codex separately owned. Integrate their existing capabilities instead of
  duplicating their implementations.

`cantrip-crypto` now supplies worker-side endpoint primitives; additional cohesive
history libraries may be appropriate as those subsystems are implemented. No
placeholder libraries are needed.

The server retains accounts, durable application state, routing, scheduling
and execution authority. Worker code owns repositories/files, PTYs, browser and
native execution, local journals and endpoint secrets. Protocol/frame helpers
do not grant authority or introduce a new app-to-worker path.

## Coverage ledger

[The source index](rust-worker/source-index.jsonl) records the reference commit,
per-file hashes/imports, every literal `switch (command.type)` case location,
direct calls and imported handlers, startup constructions/event names and
publication call sites. It currently identifies 323 distinct command names across
546 primary/delegated switch sites. These counts earn no implementation credit.
Follow constructors, nested handlers, callbacks and dynamic routing manually.
The five control handlers, two discovery/import handlers and encrypted
attachment/metadata adapter, two folder handlers and the limited Explorer/file-document
handlers and two host terminal-service handlers above are implemented. Other
indexed commands remain pending; the source
index itself grants no implementation credit.

Regenerate deliberately with `node scripts/worker-rust/inventory.mjs`. It uses
existing Babel development dependencies. Review source changes and update this
ledger rather than treating regeneration as proof of parity. The index is never
loaded by a production service.

| Area                               | Reference implementations and behavior                                                                                                    | Rust implementation                                                                                                                      | Validation / remaining work                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration and profile identity | `config.ts`, `credential-store.ts`, `codex/bundled-runtime.ts`                                                                            | `config`, `credentials`, `installation` modules                                                                                          | Local Node differential checks, private file/rotation tests. Resolution only; Codex manifest verification/probing still pending                                                                                                                                                                                  |
| Logging and process lifetime       | `logger.ts`, `log-stream.ts`, `runtime-loop.ts`, `process-guard.ts`, `index.ts` startup/stop                                              | Native logging adapter and owned runtime cycles                                                                                          | Archive/options/privacy buffer, subscriptions, retained restart cursors, signal/stdin shutdown and actor teardown tested. Remote log-stream leases, full command log context and native child/execution retirement remain pending                                                                                |
| Enrollment/control transport       | `enrollment.ts`, `heartbeat.ts`, `transport.ts`, routing/observation adapters                                                             | Native enrollment/replacement, heartbeat, readiness/reconnect and credential lifecycle                                                   | Actual Rust-server round trip, rotation/reconnect, restart/revocation and HTTP oracles pass. Execution lifetime/admission fencing, reconnect-grace resource callbacks, notifications/events/task acknowledgments, data-plane adapters, congestion fidelity and deployment TLS/proxy configuration remain pending |
| Endpoint encryption                | `packages/crypto`, `worker-encryption.ts`, `*-encryption.ts`, protected secrets                                                           | Native endpoint/surface/repository formats, all private surface records and scoped grant helpers                                         | Private-state interop covers 12 resource contexts and six content kinds. Remaining protected domains and serving resource lifetimes are pending. Initial surface-grant refresh now completes real host terminal-service reconciliation; delegated OS services remain pending.                                    |
| Files/workspaces                   | `commands/{workspace,project,explorer}.ts`, managed folders, roots, scratch/files, file documents, attachments/imports                    | Workspace/folders/routing, nine protected host Explorer operations and bound file-document text read/write                               | Actual Rust worker/server persists encrypted resources, resolves opaque roots, saves files, rejects replay/mismatched document paths and reopens after restart. Paged readers, media/tail, transfers, activity/watches and delegated OS execution remain pending.                                                |
| Git/projects/GitHub                | Git/worktree/GitHub handlers, git.ts, git-graph.ts, worktrees.ts, replicas, repository operations, exports/shares                         | Native queries, graphs/metrics/blame/overlays, reviewed branch/remote/tag/submodule/LFS/commit/stash/conflict/patch actions and recovery | Actual Node comparisons and encrypted production Rust worker/server tests cover delivered operations. Observations, worktree mutations/recovery, legacy direct-command dispatch/protection, GitHub, exports/sharing and delegated OS Git remain pending                                                          |
| History/durable delivery           | `native-history-*`, `managed-native-history*`, inference journals, operation stores, suspension and outcome stores                        | Pending                                                                                                                                  | Replay/crash/reopen, stable UTF-16 keys/digests, outbox acknowledgments and history reducer/projection fixtures; no cursor resets or uncertain effect replay                                                                                                                                                     |
| Inference/providers/models         | `commands/model-operations.ts`, admission/preparation/task input, model modules, Ollama, Grok, provider credentials/auth                  | Pending                                                                                                                                  | Actual provider protocol fixtures, streaming/media/usage, refresh, cancellation, failure and paid-work bounds                                                                                                                                                                                                    |
| Native Codex execution             | `codex/*`, native command/settings/queue clients and delivery, handoff/suspension/continuation                                            | Pending                                                                                                                                  | Manifest verification/probe, native app-server processes, queue ownership, acceptance/commit and restart recovery                                                                                                                                                                                                |
| Tasks/goals/automation/settings    | task/goal controls and durable publishers, automation scheduler/conditions, customization/skills/permissions                              | Pending                                                                                                                                  | Pause/resume, outcome retry/ack, scheduling, protected configuration and source-specific task/runtime tests                                                                                                                                                                                                      |
| Terminals/run supervision          | Terminal manager/canonical/private state, run-configuration providers and supervisors                                                     | Native host service reconciliation/restart and owned PTY supervision                                                                     | Actual encrypted server/worker service enable, idempotence, restart, recovery and disable pass. Interactive commands, canonical terminal/replay, attachment/input/resize, CLI broker environments, run providers and delegated OS services remain pending.                                                       |
| WorkerLink/direct/tunnels          | gateways/peer/WebRTC/direct broker, tunnel protection/routing/adapters                                                                    | Native framing/tunnel crypto; serving adapters pending                                                                                   | Existing frame fixtures plus actual ICE/TURN/WebRTC interoperability, bounded backpressure, stale grant/session and disconnect behavior                                                                                                                                                                          |
| Browsers/surfaces/computer use     | browser/desktop adapters, remote surfaces, computer-use services, web service and managed Playwright/SearXNG                              | Native stream protection; execution/resources pending                                                                                    | Native replacements for Node driver/helpers; selectors/snapshots/input/capture/network restrictions; permission/approval revocation; no dropped features                                                                                                                                                         |
| MCP/CLI/CodeGraph                  | `mcp/*`, CLI broker, computer-use MCP, codegraph/runtime/supervisor                                                                       | Pending                                                                                                                                  | Native stdio/HTTP helpers, generated/persisted launch commands, binding/generation scopes, CLI and managed-runtime fixtures                                                                                                                                                                                      |
| Cantrip OS                         | `cantrip_os/host`, `os-executor/*`, native MCP/run execution                                                                              | Pending                                                                                                                                  | Port Node host orchestration, Docker/guest/lifecycle/files/PTY/tunnels/packages/backups/system/checkpoints; retain independent non-Node guest helpers                                                                                                                                                            |
| Upgrade and packaging              | profile converter/database-transfer, server profile preparation, desktop services/worker, distribution/runtime scripts, worker Dockerfile | Pending                                                                                                                                  | Node-free legacy conversion/export/restore, desktop/standalone artifacts, existing-profile reopen and actual child-process/runtime audit                                                                                                                                                                         |

The source index includes existing tests with their source hashes. Each port must
choose relevant behavioral tests, not merely make dispatch registration compile.
Later deliveries should record exact native paths and executed tests for their
commands and background services before retiring the associated Node module.

## Persistent state and lifecycle inventory

The first modules retain `worker-identity.json` and `worker-credential.json`
version 1, their existing property order/pretty JSON/newline, immutable identity,
server-URL binding, explicit credential precedence and owner-only file modes.
Malformed identity files are never silently replaced. A stored credential
suppresses a pending enrollment code, as in the existing worker. No secrets are
included in a derived Rust `Debug` implementation.

The endpoint key record and authenticated grant/binding lifecycle now reopen and
publish compatibly. The routing registry and scoped repository-operation journal reader/writer are
native. Current-operation refresh, inspection, control and interactive amend recover
existing operations. Reviewed merge/rebase/interactive-rebase/bisect previews and
starts now publish new records, as do cherry-pick/revert and conflict-producing
stash mutations. Operation creation from worktree mutations remains pending.
Other state includes inference keeper
journals, native history
sources/archives/outboxes/cursors, native settings and goal deliveries,
suspension/handoff journals, chat scratch/relocation and attachment stores,
terminal/private canonical state, managed runtime installations and Cantrip OS
operation/checkpoint/recovery journals. Inspect each owning constructor and its
read/write/recovery call paths when porting; filenames alone are not a schema.
No migration or cleanup of real profiles is authorized for test convenience.

Startup currently initializes logs, reads configuration, verifies/probes Codex,
prepares managed runtimes, constructs routing/history/execution/MCP/PTY/native
services, enrolls/publishes heartbeat and connects command transport. It starts
automation and periodic heartbeat only after the initial publication. Shutdown
stops producers, closes services, retires native inference authority and drains
logs before a fresh runtime can claim the same durable identity. Port ordering
from the current `index.ts`, not from this abbreviated description.

## Node runtime removal inventory

| Current required component                                                | Replacement obligation                                                                                                                                                      |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node worker with workspace dependencies                                   | Native worker executable; retire Node production launch/default/dependencies after parity                                                                                   |
| Managed Cantrip/CUA MCP `.js` entry points                                | Native subcommands/helpers preserving stdio and authenticated HTTP tools and persisted command compatibility                                                                |
| `node-pty`, headless xterm/serialization                                  | Native PTY and compatible canonical terminal model/replay                                                                                                                   |
| `werift`, `ws` and Node transport adapters                                | Native WebRTC/WebSocket/ICE/TURN and existing framing/authority                                                                                                             |
| Node screenshots/image/computer-use modules                               | Existing native CUA/interaction where applicable, plus native missing adapters                                                                                              |
| Managed Playwright Node driver, browser HTML/readability helpers          | Native implementation of existing browser actions/snapshots/content semantics; Chromium remains a legitimate browser executable                                             |
| Node MCP SDK and first-party broker/helper code                           | Native MCP implementation; user-configured external MCP remains supported                                                                                                   |
| `@cantrip/os-host` Node orchestration                                     | Port worker-required host behavior; independent Python/guest/native tools retain their existing boundaries                                                                  |
| Desktop profile converter using JS PGlite                                 | Verified native conversion of actual supported legacy formats, preserving export/restore and protected active-profile recovery; do not assume physical format compatibility |
| `bundleNodeRuntime`, worker Docker launch, desktop `node_service_command` | Native artifact assembly, supervision, updater and launch integration; remove bundled Node after all first-party requirements are covered                                   |

Development Node tooling, client TypeScript, schema exporters/oracles and user
projects/tools may remain. The native CUA QuickJS interface and JavaScript
executed inside browsers are product scripting features, not a Node worker
fallback. Audit managed-runtime manifests and actual spawned process trees before
claiming runtime independence; do not relabel mandatory first-party code as a
user-supplied dependency.

## Delivery plan and progress

Each coherent cycle starts from current origin/main and gets its own isolated
worktree, branch, local checks, PR, observed squash auto-merge, Primary sync when
clean and owned worktree/artifact cleanup. Do not stack dependent unmerged work.

1. Configuration/identity foundation and baseline ledger — merged [#3164](https://github.com/ArcaneArts/Cantrip/pull/3164).
2. Worker logging/lifecycle, native executable and initial control transport — merged [#3165](https://github.com/ArcaneArts/Cantrip/pull/3165); transport/execution adapters continue with their owning domains.
3. Endpoint cryptography and protected persistence — primitives/key records merged in [#3166](https://github.com/ArcaneArts/Cantrip/pull/3166); authenticated grants in the current subcycle; protected domain/stream adapters follow.
4. Files/workspace/project and repository foundations.
5. Git/GitHub, sharing, attachments and related commands.
6. Durable journals/history/projection and recovery.
7. Providers/native runtime execution, queues/settings/tasks/goals.
8. PTYs/terminals/run configurations/process supervision.
9. WorkerLink/direct/tunnels/WebRTC.
10. Browsers/surfaces/computer use/web runtimes.
11. MCP/CLI/CodeGraph and remaining integrations.
12. Cantrip OS host/executor behavior.
13. Node-free profile conversion and upgrade integration.
14. Native packaging/default cutover, runtime retirement and final acceptance.

Split substantial areas into reviewable subcycles as implementation requires.
No command or background subsystem is complete merely because a dependency was
shared. The native executable now serves its implemented control commands;
execution/history/crypto and other command domains, full logging/transport
adapters, packaging/cutover and Node retirement remain unfinished.

The foundation cycle used branch `agent/manual/rust-worker-foundation` and merged
in [#3164](https://github.com/ArcaneArts/Cantrip/pull/3164), commit `cce03f466`. Local
validation on macOS ARM64 with Rust 1.93 and Node 24.22.2 passed: 61 differential
comparisons, fresh Rust identity reopening in Node, byte-identical credentials in
both directions, two native credential/rotation/corruption tests, worker checks
and workspace all-target Clippy with warnings denied. All 326 external lockfile
package identities/checksums remain unchanged. Root Cargo still defaults to the
server. The first oracle run needed the fixture cwd normalized to the physical
directory returned by Node's `process.cwd()`; production path resolution was not
changed to accommodate it. Windows/Linux runtime behavior was not executed.

Both server Docker source-copy lists now include the worker workspace member.
Cargo metadata resolves all ten members from an isolated copy of those workspace
inputs; no Docker build or image was created. This preserves server source-build
inputs as the root workspace grows. Actual Node worker/client/server/shared
library implementations and production launch selection are unchanged.

The control-runtime cycle merged in [#3165](https://github.com/ArcaneArts/Cantrip/pull/3165), commit `89b984bd0`, using branch `agent/manual/rust-worker-control-runtime`
and reference commit `cce03f466` (the Node source behavior remains unchanged from
the original baseline). The linked native worker and Rust server pass real
enrollment/heartbeat/version, delivered credential rotation and reconnect,
same-process restart with retained credentials, revocation without command-socket
retry, and stdin/SIGTERM shutdown with drained archives. The worker runs with an empty
`PATH`; this proves the implemented control path needs no Node executable, not
that unfinished product domains have been ported.

Fourteen HTTP differential cases against actual Node worker functions cover
request bodies/authentication, replacement, credential bytes, rejection/malformed
results, bounded response consumption and effect preferences. Seven new native
control/logging tests plus the two existing credential tests pass, as do the
shared archive runtime tests and generated-protocol manifest comparison. The
worker/server are actually linked; workspace all-target Clippy runs locally.

Worker logs retain their buffer/emitter across runtime restart and reopen only
the archive lifetime. A small shared `capture_record` API returns the exact
minimized record/cursor for subscriptions without double capture. The only
contract change exposes the existing `cuaEffectPreferencesSchema` as an additional
generated root; all existing root indices and schema nodes are unchanged.
No TypeScript protocol or worker behavior is changed.

Deferred control integration is deliberate unfinished work: the binary does not
execute inference, files/Git/PTY/browser or data-plane commands. Heartbeat
capabilities use unavailable defaults until their native implementations arrive.
Full authority retirement, execution cancellation/grace, notification policy and
congested transport behavior must be completed with those subsystems before
cutover. Windows code has a UTF-8 process manifest and native hostname API, but
Windows/Linux execution has not been claimed or newly qualified.

The endpoint-crypto subcycle merged in [#3166](https://github.com/ArcaneArts/Cantrip/pull/3166),
commit `b06777dc1`, using branch `agent/manual/rust-worker-endpoint-crypto`
and reference commit `89b984bd0`. New `cantrip-crypto` supplies native AES payloads,
canonical AAD/envelope strings, P-256 HPKE/worker wrappers and HKDF/HMAC derivation.
It uses maintained libraries and the existing generated protocol validation.
Eight additional roots and six appended nodes expose current TypeScript schemas;
all existing nodes and root indices remain unchanged.

Worker startup opens and retains the existing endpoint key identity until its
runtime ends. Version-1 records reopen without an eager rewrite; authenticated
binding publication writes version 2. Exact/development loopback port policies,
UUID identity, keypair integrity, persisted revision high-water values, owner-only
Unix permissions and recoverable publication errors are preserved. Bindings on
disk are not current authorization, and no component keys are advertised from
that identity-only stage. That subcycle left grant refresh/concurrency/revocation
and every protected domain/stream adapter for subsequent work.

Local checks for this subcycle pass 57 differential comparisons, seven new native
crypto/identity tests plus the nine existing worker tests, workspace all-target
Clippy with warnings denied, and the generated-protocol manifest comparison.
The comparisons include bidirectional TypeScript AES/HPKE and
worker-grant comparisons, canonical UTF-16 AAD/KDF/HMAC bytes, cross-opening Node
and Rust key records, corrupt/foreign-record preservation, small retained
TypeScript ciphertext vectors, and transactional binding-write/reopen tests.
The real worker/server control smoke also verifies exact key retention across
same-process restart with an empty worker PATH. Runtime evidence remains macOS
ARM64; Windows/Linux runtime execution is not claimed. No default switch occurs.

The crypto addition requires new RustCrypto/HPKE dependencies. Existing package
identities are retained except `ctutils` 0.4.5 → 0.4.8, required by the new
`crypto-bigint` dependency. No unrelated dependency upgrades are intended.

The authenticated-grants subcycle merged in
[#3167](https://github.com/ArcaneArts/Cantrip/pull/3167), commit `68fd1ff91`, using
branch `agent/manual/rust-worker-encryption-grants` and reference commit `b06777dc1`.
The native service validates authenticated bootstrap identities and grant metadata,
opens real HPKE component keys, retains older granted revisions, and persists
revision high-water values before publishing replacement keys. A changed logical
server/account binding resets revisions only after the complete new authorization
validates and persists. Invalid grants leave the retained disk binding intact.

Identical in-flight refreshes coalesce. An explicit grant request retries when a
coalesced heartbeat predates that grant; that continuation remains owned even if
the caller abandons its future. Newer refresh generations fence older successes
and failures. Network/5xx failures retain prior material; 4xx or malformed/invalid
authorization clears it. Lock/revocation clears component buffers, and runtime
close cancels and joins HTTP work and command continuations before restart.
Status/error text preserves the reference UTF-16 truncation and wire error codes.

Heartbeat publication now refreshes and advertises actual encryption status.
`worker.encryption.refresh` runs asynchronously so unrelated control commands and
shutdown remain serviceable. Per-domain content/stream protection, replay state,
and resource retirement/reconciliation callbacks remain unfinished with their
owning subsystems; grant availability does not complete those capabilities.

Focused local evidence: 129 compared observations in two authorization/concurrency
traces against the actual Node service, comparing status/errors, returned key bytes, HTTP
registration/authentication, retained bindings and revision files. Three native
grant tests cover restart rollback, replacement-binding failure and actual network
work surviving an abandoned caller then joining on close. The real Rust worker
and server initialize an anonymous encryption profile, register/approve the worker,
open client-produced grants, rotate revisions and revoke authorization over the
production HTTP/control handlers. The worker runs with an empty PATH and retains
its exact identity through restart. macOS ARM64 execution is the available local
runtime evidence; no Windows/Linux runtime claim or production cutover occurs.
All 19 native worker/crypto tests pass, including three new grant tests. Workspace
all-target Clippy with warnings denied and the generated-protocol manifest test
pass locally. The real grant/control flow passes both stdin and SIGTERM shutdown.
No external lockfile package identity changed; one additional generated root
exposes the existing status schema without changing any old node or root index.

The protected-content subcycle merged in
[#3168](https://github.com/ArcaneArts/Cantrip/pull/3168), commit `583235583`, using
branch `agent/manual/rust-worker-protected-content` and reference commit `68fd1ff91`.
The crypto content module implements the existing secret, endpoint, private
display-label and attachment metadata/chunk formats. It binds the actual AAD,
revisions, classifications and chunk metadata, validates authenticated plaintext,
and preserves the distinct encoded byte limits and normalized decryption errors.
`DecryptionError` retains the existing public message while supporting native
typed error handling.

The worker provider/MCP secret helpers now use authenticated component grants,
including subject/name blind indexes, public expiry metadata, configuration
defaults, enabled filtering and reserved managed-name guards. A key/owner/server
snapshot is captured under one state lock so a concurrent refresh cannot combine
different bindings. Helpers preserve the reference's latest-key selection policy;
this does not implement provider execution or MCP server processes.

Twelve generated roots expose existing TypeScript plaintext/opaque schemas. All
814 previous roots and 12,463 previous nodes are unchanged; 61 nodes are appended.
MCP key/value count and UTF-16 size refinements are now implemented. Record
parsing publishes normalized keys, applies last-value collision behavior and
preserves `__proto__` assignment behavior, matching the actual protocol parser.
No TypeScript source, production command selection or Cargo dependency changes.

These are content implementations rather than complete domain services. Chunk
arrival/replay enforcement, stream epochs, transfer/resource lifetimes, other
protected domains and their actual command integrations remain pending. The five
native control handlers and production Node-worker default remain unchanged.

Local macOS ARM64 validation passes 96 comparisons with the actual TypeScript
crypto and worker helpers. They cover bidirectional content, UTF-16/BOM handling,
authenticated metadata and plaintext failures, provider subjects/expiry, MCP
limits/defaults/discovery guards and latest-key rotation behavior. All 25 native
worker/crypto tests pass, including six new content/secret tests. A focused
protocol regression checks normalized key collisions before collection limits;
the current generated-protocol manifest comparison also passes. Workspace
all-target Clippy with warnings denied, linked worker/server builds and the real
grant/control flow with stdin shutdown pass locally. Worker dependency inspection
contains no server/database stack; Cargo.lock is unchanged. No Windows/Linux
runtime qualification or hosted Actions run is claimed.

The stream-protection subcycle merged in
[#3169](https://github.com/ArcaneArts/Cantrip/pull/3169), commit `73939c8c5`, using
branch `agent/manual/rust-worker-stream-protection` and reference commit `583235583`.
Native crypto now implements surface JSON streams, binary remote-surface payloads
and tunnel data AEAD. The remote-surface payload codec lives in shared framing,
borrows decoded slices, retains the version/big-endian revision/nonce/ciphertext
layout, and checks the actual protocol revision and four-MiB carrier limits.
Tunnel protection binds the full route, connection, direction and sequence;
metadata and authentication failures preserve the current Node helper's errors.
The existing empty-seal/tag-only-open rejection asymmetry remains unchanged.

Worker endpoint bytes/JSON and surface/remote-surface adapters use atomic granted
key/binding snapshots. Endpoint opening can use an explicitly granted historical
revision; surface opening deliberately requires the latest grant. UTF-8, BOM,
JSON and decrypted-schema errors retain the reference's error boundaries.
The surface replay guard reserves before opening, rejects superseded acceptance
and completed operations, bounds active/completed entries and supports release.
Owners must still scope that guard and retire resources with authorization;
these helpers do not implement serving transports or resource managers.

Eight roots expose existing schemas, including terminal plaintext content. All
826 previous roots and 12,524 previous nodes are unchanged; 42 nodes are appended.
Cargo.lock only adds shared-framing edges to the worker/crypto packages; external
packages and checksums are unchanged. The TypeScript implementations, five native
control handlers and production Node-worker default remain unchanged.

Local macOS ARM64 validation passes 101 comparisons against the actual crypto,
worker endpoint/surface/tunnel helpers and replay class. The prior 96 content
comparisons also pass against the extended fixture. Thirty worker/crypto tests
and two focused framing tests pass, including seven new boundary/replay tests.
Workspace all-target Clippy with warnings denied, the current generated-protocol
manifest comparison and linked worker/example builds pass. Worker dependency
inspection remains free of server/database infrastructure. No production runtime
selection changes or Windows/Linux execution claims accompany these helpers; no
hosted Actions, device, VM or container campaign was used.

Next implementation work moves into filesystem/workspace/project commands using
the native endpoint/surface adapters. Other domain-specific protected formats,
history/execution, serving streams, resource revocation, packaging and Node
retirement remain unfinished.

The workspace-discovery subcycle merged in
[#3170](https://github.com/ArcaneArts/Cantrip/pull/3170), commit `b831dcf3b`, using
branch `agent/manual/rust-worker-workspace-discovery` and reference commit `73939c8c5`.
It installs real discovery/import-validation handlers and enables only
`managedFolders.discoverWorkspaceRepositories`. Commands execute in owned tasks;
progress/events and final responses use the existing control connection. A caller
losing its response does not cancel accepted work; runtime stop cancels bounded
Git/gh work and joins the command tasks before restart.

The workspace module preserves breadth-first traversal, repository boundaries,
symlink rejection, bare/linked-worktree diagnostics, common-directory fingerprint
collapse, locale ordering, optional legacy limits and current unbounded defaults.
GitHub classification uses actual gh API processes with existing identity checks
and diagnostics. Native path handling retains Windows UTF-16 and case/namespace
rules; actual Windows/Linux runtime execution has not been claimed.

The routing registry retains the existing private v1 file, stable field-scoped
handles, metadata recursion, refs/heads aliases, strict cached load failures and
private result/error boundaries. Snapshots serialize token allocation/publication
under the registry lock and use private writes plus atomic rename; canceled
callers cannot detach or reorder a snapshot writer. It reuses cantrip-host,
cantrip-config, cantrip-wire and cantrip-protocol. The worker uses the existing
pure ICU library/data for Node-compatible collation, not server startup or SQL.
One root exposes the existing GitHub repository schema; all 834 previous roots
and 12,566 nodes are unchanged. Cargo.lock only adds existing direct library
edges; external package identities/checksums are unchanged.

Local evidence: 48 actual Node/Rust comparisons using owned Git repositories,
controlled gh processes, locale/path/boundary cases, routing privacy and actual
Node reopening of Rust-written UTF-16 records. Sixteen existing Node
workspace/routing tests and all 34 native worker/crypto tests pass, including four
new workspace tests. Workspace all-target Clippy with warnings denied and the
current generated-protocol manifest comparison also pass. The production Rust
worker/server reopens an already-attached stopped-profile fixture, discovers its
real checkout, validates and commits import while preserving dirty content, and
restarts/shuts down cleanly. The worker PATH contains Git and no Node executable.
The stopped-profile setup helper installs no fake command handlers or endpoints;
its input pipe stays open during PGlite startup, matching existing fixture stdio
ownership. New encrypted root attachment was deliberately not represented as
implemented or advertised.

Root attachment/repository operation encryption follows in the next subcycle
below. Managed folders and file/explorer execution remain required. Other command domains, native provider
execution/history, resource lifetimes, packaging/default cutover and Node runtime
retirement remain required. Production packaging continues selecting Node.

The root-attachment subcycle merged in
[#3171](https://github.com/ArcaneArts/Cantrip/pull/3171), commit `cfb0e1336`, using
branch `agent/manual/rust-worker-root-attachment` and reference commit `b831dcf3b`. `repository_operations` installs the production
`repository.operation` adapter for `workspace.root.attach`,
`repository.metadata.register` and `repository.metadata.resolve`. Other repository
operations return an explicit protected unsupported result; Git/GitHub execution
has not been implemented by this milestone.

Repository content uses native AEAD/field derivation, the existing context/AAD and
16-MiB bound, atomic grant/binding snapshots, latest-key policy and explicitly
opted-in historical opening for durable admissions. The runtime's replay guard
reserves before opening, consumes failed requests, scopes by server/project/
worktree/operation and bounds retained records at 10,000. It survives reconnects
and ends with its owning runtime. Access and routing-purpose rejection stay
outside the protected outcome; agent and argument/root failures remain encrypted,
including typed root errors. Only opaque handles are additionally returned for
server workspace persistence.

Attachment trims and canonicalizes accessible directory aliases, verifies actual
directory access, preserves the checkout and persists compatible private routing
records. Only attachment/discovery capabilities are enabled. The protocol crate
now owns shared metadata field names and all 94 access classifications; metadata
record refinements match the actual TypeScript schema. Seven generated roots and
35 nodes are appended; all 835 prior roots and 12,566 nodes are unchanged.
Cargo.lock and production Node launch selection are unchanged.

Local validation passes 54 repository comparisons, including bidirectional crypto,
UTF-16 AAD, authenticated plaintext/argument errors, all access classifications,
real root paths/aliases, metadata reopen, replay and historical/latest grant
policy. The 48 prior workspace comparisons still pass. Six native workspace tests
and five native content tests pass, including three new tests; the two existing
Node attachment tests pass. Workspace all-target Clippy with warnings denied and
the current generated-protocol manifest comparison pass.

The production Rust server/worker flow now initializes an actual encryption
profile, approves and grants the native principal, accepts a client-encrypted fresh
root, returns encrypted invalid-root failure, and persists only opaque handles.
After both services restart, discovery, durable import, dirty-file preservation
and worker restart/shutdown pass. The worker PATH contains Git and no Node
executable. The stopped-profile seed helper is removed because the production
attachment flow now creates its own fixture. Windows/Linux execution has not been
claimed; no hosted Actions, device/VM/image campaign or full-suite run occurred.

Initial oracle failures exposed fixture concerns, not production failures: dynamic
refresh timestamps now compare as valid clocks separately from status fields,
and Node's uppercase TextDecoder code is excluded exactly as WorkerConnection's
wire-error filter specifies. The development driver uses a distinct schema-
validation operation so the existing import-validation driver remains reachable.
Earlier failure logs are retained locally.

Managed folders follow in the next subcycle below; explorer/file execution remains
required, followed
by the remaining Git, history/execution, terminal, browser/transport, MCP/OS,
upgrade, packaging/default cutover and Node retirement work. The full goal remains
unfinished and production continues using the Node worker.

The managed-folder subcycle uses branch `agent/manual/rust-worker-managed-folders`
and reference commit `cfb0e1336`. `filesystem::folders::Manager` supplies the real
materialize/resolve/delete behavior and installs the two public folder handlers.
Creation/removal, existing attachment and workspace-scoped placement capabilities
are enabled. UUID-only destinations, owner-only new directories, idempotent reuse,
canonical boundaries, typed attachment failures and user-owned external paths
retain their existing policies. No implicit Git initialization or ownership of an
attached directory is introduced.

Common path and child helpers moved from `workspace` to `filesystem`, with existing
workspace Scope/ProcessError exports retained. Shared project-source normalization
covers file URLs, native Windows drive/UNC/namespaces and UTF-16. Workspace storage
keeps system/legacy/attached replicas at the worker level and walks managed
workspace boundaries individually. Absolute placement no longer reads an unneeded
process cwd, so deleting that cwd cannot prevent a valid absolute operation.

Native checkout inspection preserves GitHub's existing remote parser, actual
String coercion/schema parsing and identity comparison, linked-worktree common
fingerprints, and null metadata on unavailable Git/GitHub. Workspace discovery
reuses the fingerprint helper while retaining its stricter candidate policy.
Git calls keep the ten-second/one-MiB bounds; gh API calls keep the absent timeout
and 32-MiB output bound. Runtime stop still cancels and joins those children.
The pre-existing IDNA and percent-encoding packages become direct worker edges;
all external lockfile identities/checksums are unchanged. No schema, migration,
server implementation or production launch selector changes.

Local evidence: 73 comparisons with actual Node folder/path/Git implementations,
including portable Windows path normalization, actual controlled gh processes,
linked Git worktrees, private routing/error codes and external-file preservation.
The existing 48 workspace comparisons pass after the common-helper move. Thirty-one
existing Node folder/path tests and nine focused native filesystem/workspace tests
pass, including three new tests. Workspace all-target Clippy with warnings denied
and linked worker/server/fixture builds pass on macOS ARM64.

The production Rust server/worker flow creates a folder in a managed workspace,
removes only its derived directory and leaves sibling data intact. An existing
path first fails with its actual typed error; after correction, manual durable-job
retry succeeds without creating a substitute managed folder. External file deletion
is rejected, and removing that project preserves its content. The earlier real
root attachment, restart, discovery/import and dirty-checkout checks still pass.
The worker PATH contains Git and no Node executable. Initial smoke setup reused a
workspace-name blind index; assigning a distinct disposable fixture index resolves
that uniqueness failure. The initial build's String-coercion error conversion was
also corrected. Failure logs remain retained locally.

Native run-configuration/process services are still unimplemented; their eventual
port must integrate Node's pre-deletion stopProject/stopForPath behavior before
cutover. This milestone adds no fake runtime supervisor. Explorer/files, Git
mutations, execution/history, PTYs, browsers/transports, MCP/OS, native upgrades,
packaging and Node retirement remain required. Windows/Linux native filesystem
execution was not performed. No hosted Actions, full-suite/device/VM/image campaign,
signing or deployment ran. Production continues selecting the Node worker.

## Explorer filesystem engine subcycle

Branch `agent/manual/rust-worker-explorer` uses reference commit `64efd8314`.
`filesystem::explorer` ports nine host operations from `explorer.ts` and
`commands/explorer-request.ts`: directory listing, file search, directory commits,
text read/write, file/directory creation, rename and deletion. The implementation
is shared by the future Explorer, file-document and Cantrip OS adapters rather
than copied into each command handler.

Navigation and text editing follow intentional external symlinks. Entry mutations
require a canonical parent inside the project, and deleting a link removes the
link rather than its target. Listing retains stable locale sorting, link priority
before the 1,000-entry limit, raw relative-path output and broken-link metadata.
Creation keeps exclusive private files/directories, trimmed name validation and
collision behavior. Editable text retains UTF-8 BOMs, rejects binary/invalid text,
uses content-hash versions and checks the existing content before truncation.
Accepted writes must be joined through write/sync; caller disconnect is not
authority to abandon a partially published file.

Search preserves Git's ignored-file policy, bounded fallback traversal, ranking
and host collation. Locale casing retains the current Node 24 behavior, including
its different flat/sliced string paths, using a pinned ICU casemap implementation.
The reference is [Node 24's V8 casing implementation](https://github.com/nodejs/node/blob/v24.22.2/deps/v8/src/builtins/builtins-intl-gen.cc#L104).
Query normalization must be exercised again through the encrypted adapter when
that adapter is implemented; engine-only comparisons do not establish the full
decrypted-request validation path.

Git tracked paths/history stream incrementally without a full-history buffer or
an arbitrary history-output cap. History lookup stops once visible tracked entries
have commits. Child handles remain owned, stderr is bounded and both early
completion and runtime stop drain/reap the child. Non-Git directories retain
the existing unavailable result. The original bounded Git/gh API is unchanged.

Eight protocol roots were appended from the authoritative TypeScript definitions.
All 842 existing roots and 12,601 existing nodes remain unchanged; the manifest
now has 850 roots and 12,650 nodes. The sole new refinement validates entry names.
The lock adds `icu_casemap` and its data at 2.1.1, plus the required existing
`icu_collections` serde edge; previous package identities/checksums remain intact.

Local evidence on macOS ARM64: 64 comparisons against the actual Node engine in
each of en-US and tr-TR, including owned Git histories, symlinks, version conflicts,
BOM/unpaired-text encoding, directory limits, ignored files and fallback search.
The native fixture PATH contains only Git. Two focused native tests cover locale
casing/UTF-16 and streamed-child early completion/runtime stop. Nine existing
filesystem/workspace tests and 14 existing Node Explorer tests pass. Workspace
all-target Clippy with warnings denied and linked Rust worker/server/fixture
builds pass. Initial fixture timestamp setup and the observed Turkish casing
difference were corrected; initial failure logs remain retained locally.

This is an engine delivery, not completed `explorer.operation` or
`file-document.operation` support. Protected private-state formats, encrypted
request/response dispatch and resource binding are the next integration work.
Paged binary/text preview, media/tail, streamed imports/binary writes, activity
and watches, and delegated OS execution also remain required. No default,
capability, server schema, migration or production packaging changes. Windows/Linux
runtime execution, full-suite/device/VM/image QA, hosted Actions, signing and
deployment were not performed. The full worker replacement goal remains active.

## Encrypted Explorer and surface-state subcycle

Branch `agent/manual/rust-worker-explorer-encryption` uses reference commit
`fcbb50ce9`. `cantrip-crypto::content` now implements the existing surface private
records for all six content kinds and 12 resource contexts. Context validation,
resource/table/field bindings, persistent versus ephemeral operation IDs,
inner/outer classification, encoded byte limits and authenticated error behavior
match the current TypeScript source. Key/plaintext buffers reuse the existing
zeroizing crypto primitives; no dependencies or algorithms were added.

`protected_content` supplies the real worker private-state helpers, including
unsupported/missing/corrupt/stale/revoked/wrong-recipient states and latest-only
grant selection. `Service::component_view` reads status, owner and key under one
lock while retaining the source's error precedence. Other component consumers
keep their existing APIs and revision policies.

`ExplorerOperations` is installed in the production runtime for
`explorer.operation` and `file-document.operation`. It resolves private routing
before dispatch, reserves sequences before opening requests and seals private
success/error outcomes before completing replay admission. A shared runtime guard
is injectable for future terminal/chat-file consumers and retains the existing
global stream-capacity policy. Jobs use the runtime's owned command/join lifetime.
Caller disconnect does not abandon accepted filesystem mutations.

File documents independently authenticate their persisted location and compare
project, worktree, worker, operation kind and exact path before filesystem access.
Host navigation/editing use the prior engine. Unsupported paged/transfer/media/OS
operations remain explicit unfinished work. The new decoder also retains source
input alongside validated content so query trimming preserves the current Node
locale-casing behavior through the actual encrypted validation path; unvalidated
input never chooses a filesystem target.

Six roots were appended from the authoritative protocol. All existing 850 roots
and 12,650 nodes remain unchanged; the manifest now has 856 roots and 13,009 nodes.
New refinements cover private terminal directories, file paths, browser URLs and
binary range/page/receipt integrity. Binary readers/writers are not implemented
merely because those shared outcome contracts now validate. An observed issue-key
ordering difference in a new validation error was corrected to retain the source's
serialized Zod error message.

Local macOS ARM64 evidence: 72 private-state comparisons cover bidirectional crypto,
all resources, classification/context/key/recipient failures, BOM/malformed plaintext,
the encoded byte limit and worker-helper grant states. Thirty-one comparisons
against the actual encrypted Node handlers pass in each of en-US and tr-TR,
including normalization, replay reservation, private errors and document binding.
The existing 101 stream/helper comparisons, five native grant/replay tests and six
Node private-state tests pass. Workspace all-target Clippy with warnings denied,
explicit linked server/worker binary and content-fixture builds, format and diff
checks pass. The initial example-only build did not rebuild the worker executable;
the production flow was rerun with explicitly rebuilt binaries.

The production Rust server/worker fixture creates encrypted Explorer/file-document
records over real HTTP, resolves persisted opaque checkout paths and performs real
file reads/writes and search. It rejects stale saves, traversal, wrong document
paths and completed operation replay. After worker restart, persisted records,
routing, keys and saved files reopen. The worker PATH contains only Git; no Node
service/helper executes in this flow. Existing managed-folder/root/import checks
continue passing with their disposable dirty checkout preserved.

At this subcycle's delivery, the first `surface-private-state` grant refresh
loaded the key but its terminal-service follow-up was unimplemented. The host
terminal-service subcycle below resolves that gap with real reconciliation and
PTYs. The current smoke fixture requires successful grant refresh; the previous
allowance for that known HTTP 502 is removed. Full terminal and delegated OS
service support still remain required.

Paged binary/text previews, imports/binary saves, media/tail and activity/watch
services remain required, followed by the other Git, execution/history, terminal,
browser/transport, MCP/OS, upgrade and packaging work. Production still selects
Node. No hosted Actions, full-suite/device/VM/image campaign, signing or deployment
ran, and Windows/Linux runtime behavior was not exercised. The full goal remains
unfinished.

## Host terminal-service supervision subcycle

This cycle uses branch `agent/manual/rust-worker-terminal-services` and reference
commit `9cbc7afef` (#3174). The Node worker source and production launch selection
remain unchanged. Two real production handlers are added: `terminal.services.reconcile`
and `terminal.service.restart`.

`terminal_services` opens authenticated terminal private state with the current
scoped grant and existing terminal plaintext schema, resolves the opaque root,
and validates all configurations before changing services. Host directories use
lexical containment, preserving the source's intentional symlink behavior.
Delegated OS configurations and blank commands retain the existing rejection.
The generated protocol exposes one existing terminal plaintext schema root;
all previous root indices and schema nodes are unchanged.

The manager supervises actual native PTYs through the existing `codex-utils-pty`
library. It preserves the default 80x24 terminal, shell command arguments,
TERM/COLORTERM/terminal identity, last-duplicate configuration ordering,
idempotent reconciliation and five-second retry policy. Config changes and
explicit restart stop the previous owned process before launching its replacement.
Failed starts retry; disabling cancels pending retries. Rapid disable/re-enable
retains restart intent even if watch updates coalesce. A command acknowledges
the initial actual spawn attempt rather than claiming process readiness.

Services survive control-socket reconnects within a runtime, while worker restart
and shutdown close and join their actors. Unix teardown first requests hangup;
an owned process ignoring it is forcibly retired after one second. Native process
cleanup explicitly joins reaping and I/O helpers after output receivers are
drained/dropped. It never authorizes termination using a persisted PID.

A real missing-directory test found portable-pty's HOME substitution. The new
strict spawn entry point uses actual chdir/exec failure on Unix, including Linux
when the optional setup helper cannot launch. The worker registers the existing
Linux setup helper before initialization. Windows ConPTY preserves explicit cwd
so CreateProcessW reports the actual failure instead of substituting USERPROFILE.
Existing Unix Codex launch APIs retain their previous fallback policy. The worker
adds the existing Codex crate plus its required dependencies without upgrading
existing locked package versions or importing the whole Codex workspace.
Isolated Windows compilation exposed an implicit `winapi/std` feature previously
supplied by the full Codex workspace; the PTY crate now declares that dependency
feature itself.

Output has bounded UTF-16 storage with incremental UTF-8 decoding. It is internal
process output, not a canonical snapshot or new plaintext endpoint. Terminal
attachments, input, resize, xterm-equivalent state/serialization, exact terminal
exit/signal wire metadata, native CLI-broker environment integration, run providers
and delegated OS lifecycle remain unfinished.

Local macOS ARM64 evidence includes three real-PTY lifecycle tests (reconcile,
restart/config replacement, hangup, disable/re-enable, natural exit/retry,
missing-cwd recovery and forced cleanup), a split-UTF-8 unit test, 76 comparisons
against actual Node private-state/path helpers and three existing Node private-state
tests. Actual linked Rust worker/server smoke now requires HTTP 200 on initial
surface grant refresh and exercises an encrypted nonempty service: enable,
corrupt-state rejection without replacing the accepted configuration, idempotent
restore, restart, worker-restart recovery and disable. The worker PATH contains
Git and no Node executable. Disposable repositories/profiles are cleaned up.
Workspace all-target Clippy with warnings denied and direct PTY-library compile
checks for Linux ARM64 GNU and Windows x64 MSVC pass. These cross checks establish
compilation only; no Windows/Linux runtime qualification is claimed.

Other file/Git, history/execution, terminal, browser/transport, MCP/OS, upgrade and
packaging work remains. No production cutover, hosted Actions, full-suite/device/
VM/image campaign, signing or deployment is part of this cycle. Windows/Linux
runtime behavior is not claimed by macOS tests. The full goal remains unfinished.

## Git working-tree queries subcycle

This cycle uses branch `agent/manual/rust-worker-git-working-tree` and reference
commit `12eb6ac9a` (#3175). The existing encrypted `repository.operation` handler
now executes `git.status` and `git.diff` natively. The count of outer handlers
remains fourteen; these are two additional real operation variants, not a claim
that the entire repository-operation domain is complete. Node worker source and
production worker selection remain unchanged.

The `git` module uses actual owned Git subprocesses for current branch/HEAD,
upstream counts, NUL-delimited porcelain and local/remote branch inventory. It
retains optional-lock-free status reads, conflict flags, rename/copy pairs,
symbolic-ref filtering and stable host-locale branch ordering using the existing
ICU dependency. Diff queries preserve literal pathspecs, staged/unstaged and
untracked behavior, context, rename paths, binary detection, image sides/limits,
symlink handling and canonical image containment. Patch truncation counts UTF-16
units, including an unpaired terminal surrogate; errors containing unpaired
UTF-16 are retained in encrypted outcomes.

An additive byte-capture API in the existing filesystem `Scope` retains bounded
stdout/stderr, nonzero exit status and partial output on overflow. Runtime stop
kills and reaps the actual owned Git child, including its Unix process group.
Windows currently terminates the direct child; native job/tree integration remains
required with the worker's broader process-ownership port. Existing workspace/Explorer
callers keep their original subprocess API and error policy. Standard base64
reuses the already locked library; no package versions or checksums change.

Production dispatch decrypts the existing request, checks access/routing/agent
metadata, reads and validates the existing scoped operation record, rejects an
unexpected peer worktree, and builds the trusted command using the routed cwd.
Caller-provided cwd/type fields cannot redirect execution. The record reader
matches the Node SHA-256 key over server/owner/worker/project/worktree identities,
validates the current schema and worker/project/worktree scope, returns null only
for ENOENT, and preserves malformed records. It performs no journal writes or
active-operation recovery. Existing active records do not block read-only queries,
matching the source dispatcher.

Three existing protocol schemas are exposed through the authoritative exporter:
Git status, file diff and managed-operation record. All previous root indices and
schema nodes are preserved; new nodes are appended where required. There is no
new transport format or server policy implementation in the worker.

Local macOS ARM64 evidence: 31 actual Node/native comparisons in each of en-US
and tr-TR cover unborn/detached/dirty/conflicted repositories, ahead/behind,
renames, literal tab/newline/Unicode filenames, image/binary/symlink behavior,
2,000,000-unit patch and 16 MiB process-output limits, and missing/active/wrong-scope/
malformed journals. Three native child-lifetime tests pass, including cancellation
with actual process reaping. Two focused existing Git tests and six existing
journal/dispatch tests pass. Workspace all-target Clippy with warnings denied,
worker/server linking, formatting and protocol/source comparisons pass.

The production Rust worker/server smoke exercises encrypted queries against the
imported owned checkout, verifies the caller cannot replace its routed cwd,
rejects inconsistent public access metadata, and preserves the exact malformed
journal through worker restart. Node is absent from the worker PATH. Existing
attachment/import/folder/Explorer/service scenarios still pass. A fixture-scoping
error in the first smoke attempt was corrected before the passing run; it was not
a production implementation failure.

Git history/graphs, mutations, managed-operation execution, observations, GitHub,
sharing and OS delegation remain required, together with the remaining execution,
terminal, browser/transport, MCP/OS, upgrade and packaging work. Windows/Linux
runtime qualification is not established by these macOS checks. No hosted Actions,
full-suite/device/VM/image campaign, signing, deployment or default cutover ran.
The full replacement goal remains active.

## Basic Git actions subcycle

This cycle uses branch `agent/manual/rust-worker-git-actions` and reference commit
`04e82764f` (#3176). The encrypted `repository.operation` adapter now executes all
eleven existing `git.action` variants: stage/unstage/discard, their All variants,
commit, checkout, branch creation, pull and push. The outer-handler count remains
fourteen. The public Git wire format, Node source and production worker default
are unchanged.

The native action module reuses Git status, scoped subprocess capture and shared
protocol validation. It preserves unborn-index unstaging, staged changes during
working-tree discard, literal discard selectors, missing/conflicted-change errors,
commit-all behavior and actual Git ref validation. Pull retains fetch-all/prune
followed by fast-forward-only pull. Push honors an existing upstream; otherwise
it selects origin or the first remote and establishes tracking, with the same
missing-remote/detached-HEAD failures. Checkout retains the existing local/remote
tracking-branch selection. Action output combines stdout and stderr, with the
source helper's stderr/stdout/message error priority. No shell evaluates action
arguments or commit messages.

Before mutation, the encrypted adapter reads the existing scoped journal and
rejects queued/running/conflicted/awaiting-user-action records using the Node
dispatcher's exact guard. Terminal completed/failed/aborted records allow basic
actions. This is the existing ownership rule, not a new physical-repository
preflight. Basic actions write no operation journal, matching the Node dispatcher;
managed-operation writers, inspection, continuation and recovery remain pending.

The actual production encrypted path exposed a stack overflow after direct
helper comparisons passed. The shared byte collector's two I/O buffers inflated
nested async state. Boxing that collector reduced the locally measured unoptimized
Git dispatch future from 88,304 to 1,744 bytes (action: 88,256 to 1,696; status:
87,856 to 1,296). The production runtime stack configuration is unchanged, and the
failing encrypted scenario passes on its normal threads. The temporary diagnostic
example is removed. The smoke finalizer now attempts every owned cleanup step
even when one fails and preserves the original error; the failed run's exact leftover
profile was identified by unique request IDs and removed after verifying no files
were open. No unrelated temporary profile was removed.

One additional existing result schema root is exported: `gitActionResultSchema`.
The generated manifest has 861 roots and 13,046 nodes, with two appended nodes;
all previous indices/nodes and all Cargo dependency versions/checksums remain
unchanged. No runtime fallback or new first-party process dependency is added.

Local macOS ARM64 evidence: 43 actual Node/native mutation comparisons cover all
eleven variants and independently compare resulting repository state. Separate
matching owned repositories use fixed commit timestamps; comparisons normalize
only their corresponding owned directory prefixes in Git's output. Local bare
remotes exercise initial/tracked pushes, origin/first-remote selection, remote
checkout, successful pull, divergent pull/push rejection and retained fetch state.
Hooks, commit failures, literal discard and conflicted work are exercised against
real Git. No hosted repository receives a test push. Three focused existing Git
tests and six journal/dispatch tests pass.

The linked production Rust server/worker test exercises encrypted stage, unstage,
commit, literal discard and branch changes while preserving the original dirty
sentinel. It rejects an active Node-produced journal, accepts its completed form,
retains malformed data, then observes a new native runtime and verifies the legacy
active record survives byte-for-byte and still prevents mutation. Restart readiness
requires both an actual startup event and a working command socket. Node is absent
from the worker PATH. Workspace all-target Clippy with warnings denied, formatting
and generated-source checks pass.

History/graphs, advanced mutations/stashes, managed-operation execution, direct
legacy Git command result protection/dispatch, observations, GitHub and OS
delegation remain required. Windows direct-child termination still needs native
job/tree integration. Other execution/history/terminal/browser/transport/MCP/OS,
upgrade and packaging work remains. No Windows/Linux runtime qualification,
hosted Actions, full-suite/device/VM/image campaign, signing, deployment or default
cutover is claimed. The full goal remains active.

## Git history and inspection subcycle

This cycle uses branch `agent/manual/rust-worker-git-history` and reference commit
`563ef4e18` (#3177). The encrypted `repository.operation` adapter now executes
`git.history`, `git.file.history`, `git.file.blame`, `git.commit.search`,
`git.commit.get`, `git.commit.signature.get`, `git.refs.list`, `git.compare` and
`git.revision.diff`. The outer-handler count remains fourteen. Production still
selects Node; direct legacy Git dispatch/protection remains pending.

The native history module preserves traversal and combined filters, pagination,
verified extra detached revisions, decoration ordering/classification, rename-following
file history and bounded blame ranges. Commit inspection preserves selected merge
parents, child lookup, lazy signatures, message/file limits, rename and binary stats,
peeled commit refs and direct/merge-base comparisons. Revision diffs reuse existing
object/image-side capture and the 2,000,000 UTF-16-unit patch, 2 MiB image and 16 MiB
subprocess limits. Git runs through the existing owned, boxed native collector.

Lazy signature verification uses actual Git, retaining format/status/error mapping
and the configuration-keyed 256-entry, ten-minute cache with shared in-flight work
and failed-entry removal. Pending cache entries hold weak references so a process-wide
cache cannot retain a subprocess future after its command tasks disappear. Completed
results are retained strongly. A focused resource-lifetime test covers the difference.
No cryptographic algorithm or JavaScript verifier is reimplemented.

The encrypted adapter retains trusted cwd substitution, access agreement, scoped
legacy-journal reads, peer-worktree checks, error protection and replay admission.
Read-only history remains available during an active managed operation; malformed
journals still fail without replacement. No journal writer, new wire format,
production fallback, database dependency or native library is introduced.

Ten existing protocol roots are now exported through the authoritative generator.
The manifest has 871 roots and 13,199 nodes: 153 nodes are appended, and every
previous node/root index is preserved. Cargo.lock is unchanged.

Local macOS ARM64 evidence: 74 real Node/native comparisons cover all nine query
variants, successful results and expected errors, unborn/detached repositories,
merges, root/selected-parent commits, filters and pagination, renamed/deleted files,
Unicode/newline filenames, binary/image sides, annotated/non-commit refs, unrelated
revisions, and real SSH signatures with cache/configuration and missing-tool cases.
Nine relevant existing Node Git tests pass. The linked production Rust worker/server
smoke compares all nine encrypted results with Node, checks active/malformed journal
behavior and rejects incorrect access metadata; existing workspace/file/service and
restart scenarios also pass with Node absent from the worker PATH. Workspace all-target
Clippy with warnings denied, worker/server linking, formatting and generated-contract
checks pass; exact results are recorded with the PR receipt.

Git graphs, advanced mutations/stashes, managed-operation execution/recovery,
observations, GitHub, worktree management and legacy direct-command protection remain
required. Execution/durable history, interactive terminals, browser/transports,
MCP/OS, Node-free upgrades and packaging/default cutover remain ongoing. Windows
process-tree ownership and Windows/Linux runtime qualification are not established
by these macOS checks. No hosted Actions, full-suite/device/VM/image campaign,
signing, deployment or production cutover is claimed. The full goal remains active.

## Managed Git recovery subcycle

This cycle uses branch `agent/manual/rust-worker-git-managed` and reference commit
`fed33ff30` (#3178). Encrypted `repository.operation` now supports
`git.operation.current`, `git.operation.control`, `git.operation.amend` and
`git.stash.list`. Internal `git.operation.inspect` uses the same native inspector;
legacy direct command dispatch remains pending. The outer-handler count stays
fourteen, and the production worker default remains Node.

The native inspector reads Git's merge/rebase/cherry-pick/revert/bisect markers,
sequencer/rebase todo files, conflicts, paused actions and bounded progress.
Continue/skip/abort and bisect good/bad/reset preserve their existing guards,
outputs and terminal-state hints. Stash recovery restores existing dirty checkpoints,
staged/untracked work and branch ownership, drops source stashes when required,
and removes the recovery ref. The bounded stash summaries are also available as
a read operation. Reviewed operation creation and conflict editing are not claimed.

Scoped journal writes retain the exact existing hash-derived filename, schema/key
ordering, newline, identity/timestamps, terminal completion time and 0700/0600
creation modes. Publication writes a private unique temporary file then renames
it; blocking private-file writes run outside the async worker threads. Malformed
or wrong-scope records fail without replacement. Current refresh inspects only
active records, and terminal reads leave the file bytes unchanged. Control/amend
require the stored operation ID and inject stored context over caller arguments.

The worker has native sequence/message editor entry points before configuration
or service startup. They read the existing todo/reword-message data and support
queued rewords and amend/continue without running the legacy `.cjs` scripts.
Git receives scoped editor environment overrides through the existing owned,
boxed capture mechanism. No new runtime dependency or server/database coupling
is introduced. New operation previews/starts will reuse these foundations.

Four existing protocol roots are exported by the authoritative generator. The
manifest has 875 roots and 13,231 nodes, with 32 appended nodes and all previous
nodes/root indices preserved. Cargo.lock remains unchanged.

Local macOS ARM64 validation covers 56 actual Node/native comparisons across all
six managed-operation types and stash summaries: real conflicts, continue/skip/
abort/error controls, bisect progress, source-generated dirty stash restoration,
interactive edit/queued reword, malformed UTF-16 recovery keys, and byte-identical
journal publication/reopening. Four focused existing Node Git tests, six journal/
dispatch tests, and 31 existing native Git compatibility cases are relevant checks.
The production Rust server/worker smoke exercises native journal refresh/restart,
wrong-ID rejection, trusted-context substitution, abort/terminal reads, and native
amend/queued reword with Node absent from worker PATH. A variable-shadowing error
in the first smoke driver was corrected; its failure log is retained. Existing
workspace, Explorer, terminal-service and Git scenarios remain in that smoke.
Exact executed results, compilation, Clippy, formatting and contract/source audits
are recorded with the delivery receipt.

Managed previews/starts, conflict editing, advanced commit/branch/remote/tag/stash
mutations, Git graphs, observations, worktree management, GitHub and direct legacy
command dispatch/protection remain required. Execution/durable history, interactive
terminals, browser/transports, MCP/OS, Node-free upgrades and packaging/default
cutover are still ongoing. Windows child-tree ownership and Windows/Linux runtime
qualification remain outstanding. No hosted Actions, full-suite/device/VM campaign,
signing, deployment or production cutover is claimed. The full goal remains active.

## Reviewed managed Git creation subcycle

This cycle uses branch `agent/manual/rust-worker-git-start` and reference commit
`e40e5d4c6` (#3179). Encrypted `repository.operation` now supports the existing
`git.operation.preview` and `git.operation.start` commands for merge, rebase,
interactive rebase and bisect. The outer-handler count remains fourteen and the
production worker default remains Node.

Previews rehearse real Git operations in owned disposable detached worktrees,
including conflicts and interactive edit steps, and return the same files, patch,
progress plan and warnings as Node. Review tokens preserve JSON property order,
UTF-16 values, SHA-256 construction, workspace fingerprints, selected revisions,
resolved todo items and checkpoint-ref derivation. Starts recompute the preview,
reject stale tokens, preserve active-operation guards, create the recovery ref,
run the accepted operation and publish a new scoped journal identity. Creation
reuses the native inspection/control/atomic-journal path from the previous cycle.

Interactive planning preserves all six todo actions, exact-once coverage and
retained-step rules, queued messages, published-ref warnings and locale sorting.
Native editor preparation writes only the existing todo/message data and uses the
compiled worker's editor entries; it creates no `.cjs` helpers. Preview cleanup
uses a separate owned scope so a stopped request still aborts/removes its temporary
worktree registration before deleting the directory. The existing `tempfile`
dependency is promoted from development to runtime for owned temporary directories;
no external dependency version or lockfile entry changes.

The authoritative exporter adds the existing `gitManagedOperationPreviewSchema`
root and 18 nodes. The manifest has 876 roots and 13,249 nodes; every prior node
and root index is preserved, and Cargo.lock is unchanged. Public TypeScript
contracts and the Node worker implementation are unchanged.

Local macOS ARM64 evidence: 46 real Node/native comparisons cover all four action
types, exact tokens and resulting checkout/ref state, clean/conflicting and
fast-forward operations, stale/dirty/invalid reviews, all interactive actions,
todo errors, published-ref ordering, UTF-16 source refs, bisect bounds/controls,
actual hook rejection at start and native recovery metadata. A separate stopped-
preview check waits for a real owned child after worktree creation, cancels its
scope, and verifies both the directory and Git registration are removed. Six
focused existing Node Git tests, six journal/dispatch tests and 31 existing native
Git compatibility cases pass.

The linked production Rust server/worker smoke verifies encrypted previews/starts,
no journal replacement on rejected starts, new operation identities, active-record
exclusion, restart/abort, a Node-produced token accepted by the native interactive
start, native edit/queued-reword completion and bisect reset. Node is absent from
the worker PATH; previous workspace/file/service/recovery scenarios still pass.
Worker/server/example linking, workspace all-target Clippy with warnings denied,
formatting and generated-contract/source checks are recorded with delivery.

Conflict editing, advanced commit/branch/remote/tag/stash mutations, Git graphs,
observations, worktree management, GitHub and direct legacy dispatch/protection
remain required. Execution/durable history, interactive terminals, browser/data
planes, MCP/OS, Node-free upgrades and packaging/default cutover are still ongoing.
Windows child-tree ownership and Windows/Linux runtime qualification remain
outstanding. No hosted Actions, full-suite/device/VM/image campaign, signing,
deployment or production cutover is claimed. The full goal remains active.

## Git conflict inspection and resolution subcycle

This cycle uses branch `agent/manual/rust-worker-git-conflicts` and reference
commit `132e2f96f` (#3180). Encrypted `repository.operation` now supports
`git.conflicts.list`, `git.conflicts.get`, `git.conflicts.preview` and
`git.conflicts.apply`. The fourteen outer handlers and production Node worker
default are unchanged.

Native Git supplies the actual unmerged index modes, object identities and
stages. Lists retain locale sorting and the existing 1,000-file cap; stage and
worktree previews retain the 2,000,000-byte text limit, binary/gitlink flags and
missing-side semantics. All six existing strategies are implemented: ours,
theirs, both, result, manual and delete. Review tokens preserve the exact Node
JSON/UTF-16/SHA-256 construction, binding both stage identities and current
worktree content. Apply recomputes the token, preserves text-write containment
and symlink checks, runs the original Git checkout/add/rm operations and verifies
that the path left the unmerged index.

After successful encrypted apply, an active scoped operation journal is refreshed
using its existing context and identity. A rejected token leaves it unchanged.
Resolve, restart and continue reuse the native recovery implementation. No Node
fallback or additional runtime dependency was introduced.

Four existing roots are appended through the authoritative exporter:
`gitConflictListSchema`, `gitConflictDetailSchema`,
`gitConflictResolutionPreviewSchema` and `gitConflictResolutionResultSchema`.
The manifest has 880 roots and 13,284 nodes, adding 35 nodes while preserving every
prior node and root index. Cargo.lock and public TypeScript contracts are unchanged.

Local macOS ARM64 evidence: 74 real Node/native comparisons cover all six
strategies, exact tokens, index/worktree changes, missing sides, executable modes,
binary/oversized content, malformed UTF-8 and lone UTF-16 surrogates, stale
worktree/stage reviews, symlink and parent-containment refusal, and actual gitlink
stages. Three focused existing Node conflict/managed-operation tests and six
journal/dispatch tests pass. The linked production Rust server/worker smoke
resolves a native-created merge conflict using a Node-produced review token,
verifies unchanged journal identity and refreshed paths, restarts and continues
to a committed resolution. Earlier workspace/file/Git/service scenarios still
pass. Node remains absent from the worker PATH.

The first smoke attempt exposed a fixture omission: its Git-only PATH also hid
the native `true` utility used by both implementations as a noninteractive Git
editor. A small real-Git reproduction confirmed the failure and successful retry
with that utility present. The fixture now exposes Git and `true`; production
behavior was not changed. Both attempt logs are retained. Worker/server/example
linking, workspace all-target Clippy with warnings denied, formatting/diff and
contract/source checks also pass.

Advanced commit/branch/remote/tag/stash mutations, Git graphs, observations,
worktrees, GitHub, delegated OS Git and direct legacy dispatch/protection remain
required. Execution/durable history, interactive terminals, browser/data planes,
MCP/OS, Node-free upgrades, packaging and default cutover remain unfinished.
Windows child-tree ownership and Windows/Linux runtime checks remain pending.
No hosted Actions, full-suite/device/VM/image campaign, signing, deployment or
production cutover is claimed. The full goal remains active.

## Reviewed Git commit mutations subcycle

This cycle uses branch `agent/manual/rust-worker-git-commits` and reference
commit `55a07cdee` (#3181). Encrypted `repository.operation` now supports
`git.commit.action.preview` and `git.commit.action.apply` for cherry-pick,
revert, amend (including message replacement) and fixup. The fourteen outer
handlers and production Node worker default are unchanged.

Cherry-pick resolves explicit selections or inclusive ancestry ranges, preserves
ordering/deduplication and the 1,000-commit cap, and rejects unsupported merge
commits. Revert preserves merge-mainline validation and warnings. Previews run
actual no-commit Git rehearsals in owned temporary worktrees; amend/fixup inspect
the staged patch and retain their existing dirty/staged guards. Tokens preserve
the exact Node action/head/revisions/workspace/patch JSON and SHA-256 construction,
including UTF-16 patch truncation. Apply recomputes the preview, rejects stale
reviews, creates the existing amend recovery ref and runs the original Git
commands. Hooks and signing configuration retain their existing behavior.

Cherry-pick/revert results preserve resumable conflicts and current-step tracking.
The encrypted dispatcher converts their summaries to scoped durable records using
the outer operation identity, while amend/fixup preserve the existing record.
The native journal, conflict resolution and control paths support restart and
continue. Accepted work remains owned through shutdown; canceled previews use a
fresh cleanup scope to abort/remove their real temporary Git registrations.

Two existing roots are appended through the authoritative exporter:
`gitCommitActionPreviewSchema` and `gitCommitActionResultSchema`. The manifest
has 882 roots and 13,310 nodes, adding 26 nodes while preserving all prior nodes
and root indices. Cargo.lock, dependencies and public TypeScript contracts are
unchanged. The worker still has no server/database dependency or Node fallback.

Local macOS ARM64 evidence: 43 actual Node/native comparisons cover all four
types, explicit/deduplicated/range selections, exact tokens and resulting
refs/index/HEAD/status, invalid ancestry and revisions, merge/mainline rules,
cherry-pick/revert conflicts, partial sequence progress, dirty/staged guards,
stale staged reviews, UTF-16 message replacement, the 2,000,000-unit patch cap,
amend checkpoints and actual hook rejection. A separate cancellation check
observes a real preview child and verifies removal of its temporary directory
and Git worktree registration. Four focused existing Node Git tests and six
journal/dispatch tests pass.

The linked production Rust server/worker smoke compares all four encrypted
previews with Node, accepts their tokens, verifies stale-review and active-record
rejections, checks amend/fixup journal preservation and new cherry-pick/revert
identities, and restarts through conflict resolution, continue and completed-record
reopen. Earlier workspace/file/Git/service scenarios still pass. Node is absent
from the worker PATH. Worker/server/example linking, workspace all-target Clippy
with warnings denied, formatting/diff and source/contract checks pass. The initial
compile identified two temporary-borrow lifetime errors; both were corrected
before behavioral validation, and the original log is retained.

Branch/remote/tag/stash mutations, Git graphs, observations, worktrees, GitHub,
delegated OS Git and direct legacy dispatch/protection remain required.
Execution/durable history, interactive terminals, browser/data planes, MCP/OS,
Node-free upgrades, packaging and default cutover remain unfinished. Windows
child-tree ownership and Windows/Linux runtime checks remain pending. No hosted
Actions, full-suite/device/VM/image campaign, signing, deployment or production
cutover is claimed. The full goal remains active.

## Native Git stash selections and recovery subcycle

This cycle uses branch `agent/manual/rust-worker-git-stashes` and reference
commit `9abaaceea` (#3182). Encrypted `repository.operation` now supports
`git.stash.create`, `git.stash.diff`, `git.stash.action.preview` and
`git.stash.action.apply`, alongside the existing list operation. The fourteen
outer handlers and production Node worker default are unchanged.

Creation preserves the existing staged/unstaged/untracked selection behavior.
Independent unstaged shelving uses an owned temporary Git index, binary patch
input, commit-tree parents and the original checkout/clean operations, retaining
staged content and rejecting overlapping staged/unstaged changes. Stash file
diffs reuse native bounded patches and object-side metadata, including the third
parent for untracked files. The existing 200-stash/2,000-file summary bounds are
unchanged.

All five reviewed actions are native: apply, pop, drop, clear and branch. Tokens
preserve the exact Node action, selected ref/hash identities and workspace digest.
Stale reviews and moved stash positions fail compatibly. Apply/pop/branch create
the existing clean/dirty checkpoint refs, preserve local staged and untracked
content, restore failed operations and drop source stashes by hash at the original
completion boundary. Conflict-producing actions publish a new scoped journal
using the outer operation identity and reuse native conflict/control/recovery.
Successful actions without an operation preserve the existing journal.

The owned process collector now accepts stdin while draining both output pipes.
Patch input retains its combined output cap and error priority; other callers
retain their original stream bounds. All Git collector futures remain boxed.
Stop handling kills/reaps only owned children, including a child blocked on input.
The existing stash restore implementation is reused without changing its policy.
No dependency, Cargo.lock or production Node-default change is introduced.

Three existing protocol roots are appended through the authoritative exporter:
`gitStashFileDiffSchema`, `gitStashActionPreviewSchema` and
`gitStashMutationResultSchema`. The manifest has 885 roots and 13,345 nodes,
adding 35 nodes while preserving all prior nodes and root indices. Public
TypeScript contracts and the Node worker implementation are unchanged.

Local macOS ARM64 evidence: 84 actual Node/native comparisons cover six valid
creation scope combinations, all five actions, text/binary/untracked file diffs,
exact review tokens, UTF-16 branch labels, stale workspace/ref reviews,
independent-shelf overlap failures, clean and dirty checkpoints, conflict abort/
continue, and actual HEAD/index/ref/diff state. Four focused existing Node stash
tests and six journal/dispatch tests pass. Four native process tests cover duplex
input/output, combined overflow, ordinary capture/streaming and actual owned-child
stop/reap with and without blocked stdin.

The production Rust server/worker smoke verifies encrypted independent shelving,
retained staged content, file diffs, Node-produced tokens, restart/reopen,
stale/active-record rejection, new conflict journal identities, abort restoring
staged/untracked work, then pop/resolve/restart/continue and source-stash removal.
Earlier workspace/file/Git/service scenarios still pass with Node absent from the
worker PATH. Worker/server/example linking, workspace all-target Clippy with
warnings denied, formatting/diff and source/contract checks pass. Initial Clippy
reported three collapsible-if findings; they were corrected and its original log
is retained.

Branch/remote/tag mutations, partial patches, Git graphs, observations, worktrees,
GitHub, delegated OS Git and direct legacy dispatch/protection remain required.
Execution/durable history, interactive terminals, browser/data planes, MCP/OS,
Node-free upgrades, packaging and default cutover remain unfinished. Windows
child-tree ownership and Windows/Linux runtime checks remain pending. No hosted
Actions, full-suite/device/VM/image campaign, signing, deployment or production
cutover is claimed. The full goal remains active.

## Native Git partial-patch editing subcycle

This cycle uses branch `agent/manual/rust-worker-git-patches` and reference
commit `17c209594` (#3183). Encrypted `repository.operation` now supports
`git.patch.preview` and `git.patch.apply` for stage, unstage and discard. The
fourteen outer handlers and production Node worker default are unchanged.

The native selector preserves whole-hunk and individual-line selection, ordering,
deduplication, validation errors, reverse operations, no-newline markers and
new/deleted-file header/range normalization. Binary, rename/mode and truncated
patch restrictions remain compatible. Previews reuse the actual native file diff
and `git apply --check`; apply recomputes the selection, verifies the original
operation/path/patch SHA-256 token, and uses the owned stdin collector. Unrelated
file edits do not create an extra token gate. Protected apply retains the active-
journal guard; preview remains readable and neither path replaces the journal.

The exporter appends the existing `gitPartialPatchPreviewSchema` root and seven
nodes. The manifest has 886 roots and 13,352 nodes, preserving every previous node
and root index. The existing action-result schema is reused. Dependencies,
Cargo.lock, public TypeScript contracts and production defaults are unchanged.

Local macOS ARM64 evidence: 78 actual Node/native comparisons cover all three
operations, whole/partial/addition/deletion selections, multiple/out-of-order
hunks, duplicate and invalid indexes, stale/valid reviews, new/deleted files,
missing final newlines, Unicode/newline/literal filenames, metadata restrictions,
the UTF-16 patch cap, and actual index/worktree bytes. Four focused existing Node
patch tests and six journal/dispatch tests pass. The first comparison run reached
the oversized case but its observer's default 1 MiB Git-output buffer failed;
raising that development observer to the runtime's existing 16 MiB bound made the
run pass without changing production behavior. Both logs are retained.

The production Rust server/worker smoke compares encrypted previews/tokens with
Node, rejects a stale token without mutation, restarts and applies Node-produced
tokens, verifies stage/unstage/discard bytes and journal preservation, and exercises
the persisted active-record guard. Earlier scenarios pass with Node absent from
the worker PATH. Worker/server/example linking, workspace all-target Clippy with
warnings denied, formatting/diff and source/contract checks pass.

Branch/remote/tag mutations, Git graphs, observations, worktrees, GitHub, delegated
OS Git and direct legacy dispatch/protection remain required. Execution/history,
interactive terminals, browser/data planes, MCP/OS, Node-free upgrades, packaging
and default cutover remain unfinished. Windows child-tree ownership and Windows/
Linux runtime checks remain pending. No hosted Actions, full-suite/device/VM/image
campaign, signing, deployment or production cutover is claimed. The goal remains
active.

## Native reviewed Git branches subcycle

This cycle uses branch `agent/manual/rust-worker-git-branches` and reference
commit `28ac19914` (#3184). Encrypted `repository.operation` now supports
`git.branch.list`, `git.branch.action.preview` and `git.branch.action.apply`.
All eight actions are native: create, switch, publish, rename, local/remote delete,
set/unset upstream and fetch/prune. The fourteen outer handlers and production
Node worker default are unchanged. Remote configuration editing remains separate.

Inventory preserves local/remote refs, tracking counts and gone upstreams,
merged status, worktree labels/current ownership, last-commit metadata, default
remote selection, detached/unborn states, generated timestamps, locale sorting
and the 20,000-branch cap. Ownership uses actual Git registrations and canonical
paths with the existing lexical fallback. Default remote-name ordering retains
JavaScript UTF-16 order. Review tokens preserve the exact Node action/head/ref/
upstream/worktree/workspace JSON and SHA-256 construction; timestamps do not enter
the token. Summaries/errors preserve UTF-16 strings.

Existing validation, warnings and worktree ownership restrictions remain intact.
Apply recomputes the review and executes the original Git arguments. Dirty
switches and non-fast-forward pushes are decided by real Git. Branch operations
preserve the managed journal; protected apply retains its active-record guard.
No Node fallback, new dependency, Cargo.lock change or production cutover occurs.

Three existing protocol roots are appended: `gitBranchListSchema`,
`gitBranchActionPreviewSchema` and `gitBranchMutationResultSchema`. The manifest
has 889 roots and 13,403 nodes, adding 51 nodes while preserving every previous
node and root index. Public TypeScript contracts are unchanged.

Local macOS ARM64 evidence: 92 actual Node/native comparisons cover all eight
actions, exact tokens, new-commit publication and remote deletion, non-fast-forward
refusal, fetch/prune/tracking, stale workspace/refs, dirty switches, merged/forced
deletion, current/foreign/prunable worktree owners, canonical aliases, Unicode
sorting/strings, detached/unborn behavior and actual checkout/config/ref/bare-
remote state. Three focused existing Node branch tests and six journal/dispatch
tests pass. Earlier compile/fixture attempts are retained; the final comparison
uses the rebuilt binary and the actual Node missing-HEAD behavior for unborn
previews.

The production Rust server/worker smoke compares encrypted inventories/previews
with Node, accepts Node-produced tokens after restart, exercises all eight actions
against an owned local bare remote, reopens remote tracking after restart and
verifies journal preservation and the persisted active-record guard. Earlier
scenarios pass with Node absent from the worker PATH. Worker/server/example
linking, workspace all-target Clippy with warnings denied, formatting/diff and
source/contract checks pass. No hosted or external-network validation ran.

Remote configuration/tag mutations, Git graphs, observations, worktrees, GitHub,
delegated OS Git and direct legacy dispatch/protection remain required, along with
execution/history, interactive terminals, browser/data planes, MCP/OS, Node-free
upgrades, packaging and default cutover. Windows child-tree ownership and Windows/
Linux runtime checks remain pending. No full-suite/device/VM/image campaign,
signing or deployment is claimed. The full goal remains active.

## Native reviewed Git remote configuration subcycle

This cycle uses branch `agent/manual/rust-worker-git-remotes` and reference
commit `d64435540` (#3185). Encrypted `repository.operation` now supports
`git.remote.list`, `git.remote.action.preview` and `git.remote.action.apply`.
All five actions are native: add, edit, remove, set/clear fetch/push defaults and
fetch/prune. The fourteen outer handlers and production Node default remain.

Inventory preserves JavaScript UTF-16 name ordering, fetch/push URL lookup and
fallbacks, branch/config/origin default selection, timestamps and credential
redaction flags. Display and failure redaction retain the existing URL/query and
UTF-16 regex policy, including duplicate query keys and Unicode case folding.
The native URL adapter also preserves Node's final opaque-path-space escaping.
Remote displays redact URL user information and query keys matching that policy.

Review tokens preserve the exact Node JSON/SHA-256 construction over action,
displayed remotes, workspace fingerprint and the raw remote-configuration digest.
Changing hidden credentials invalidates the old review even when the displayed
URLs are identical. Apply recomputes the review and uses the original Git
arguments. URL replacement warnings, default unsets and fetch/prune outputs
remain compatible. Remote operations preserve the managed journal; encrypted
apply retains its active-record guard while inventory/preview remain readable.

Fetch keeps the existing 30-second deadline and bounded output. The owned native
collector retains output on timeout, terminates its owned Unix process group and
waits for the child. Existing cancellation/overflow paths remain covered. Windows
currently terminates its direct owned child; full job/tree ownership remains
unfinished worker work, not a claim established by the macOS tests.

Three existing protocol roots are appended: `gitRemoteListSchema`,
`gitRemoteActionPreviewSchema` and `gitRemoteMutationResultSchema`. The manifest
has 892 roots and 13,423 nodes, adding 20 nodes while preserving every previous
node and root index. No TypeScript contract, dependency or lockfile changes occur.

Local macOS ARM64 evidence: 75 actual Node/native comparisons pass across all
five actions, exact tokens, UTF-16 inputs, URL canonicalization/redaction, default
selection, stale workspace/configuration, hidden-credential changes and real
local fetch/prune/failure state. One focused existing Node remote test and six
journal/dispatch tests pass. Five native process tests pass, including timeout
with retained output and owned-child reaping with open or closed output pipes.
The initial comparison failure is retained; the rebuilt fixture passes with the
Node-compatible opaque-path correction.

The production Rust worker/server smoke passes encrypted inventory/previews,
Node-produced tokens across restart, all five remote actions, default reopening,
hidden-credential token invalidation, journal preservation and the active-record
guard. Earlier scenarios pass with Node absent from the worker PATH. Actual
worker/server/example linking, workspace all-target Clippy with warnings denied,
formatting/diff and source/contract checks pass. No hosted checks, external remote
connections, full-suite/device/VM/image campaign, signing or deployment ran.

Tag mutations, Git graphs, observations, worktrees, GitHub, delegated OS Git and
direct legacy dispatch/protection remain required, together with execution/history,
interactive terminals, browser/data planes, MCP/OS, Node-free upgrades, packaging,
default cutover and Node retirement. The full goal remains active.

## Native reviewed Git tags subcycle

This cycle uses branch `agent/manual/rust-worker-git-tags` and reference commit
`b025a6bdc` (#3186). Encrypted `repository.operation` now supports `git.tag.list`,
`git.tag.get`, `git.tag.action.preview` and `git.tag.action.apply`. All four actions
are native: lightweight/annotated creation, push, local delete and remote delete.
The fourteen outer handlers and production Node default remain unchanged.

Inventory preserves ref-format fallback for older Git, peeled object metadata,
commit/tree/blob/tag targets, timestamp/name locale ordering, the 10,000-tag cap,
remote availability/errors and UTF-16-sorted published remote names. Detail retains
the raw message format and one-million-UTF-16-unit truncation. Preview summaries,
warnings, target/ref validation and exact Node action/tag/remote-check/workspace
JSON/SHA-256 tokens are preserved. Published status remains name-based; real Git
decides whether a push would replace a conflicting remote object.

Annotated signatures are verified against immutable tag object IDs, independently
of signed target commits. Lightweight tags remain unsigned. At most four tag
verifiers run concurrently and results retain inventory order. Trust-file changes
are rechecked without reusing the commit-signature cache. Verifier classification
preserves anchored GPG status records, SSH invalid/unknown-principal results,
missing key/config/tool distinctions and full-output classification before display
truncation. Existing commit signature classification is reused without changing
its cache policy. On stop, the inventory drains accepted verification futures so
each owned process group is terminated and reaped before returning the error.

Remote advertisement, verification and remote mutations reuse the existing
30-second bounded Git runner and error-redaction policy, now shared with remote
configuration. Tag mutations preserve the managed-operation journal and encrypted
apply retains the active-record guard. List/detail/preview remain readable during
an active operation. No Node fallback, dependency or lockfile changes occur.

Four existing protocol roots are appended: `gitTagListSchema`, `gitTagDetailSchema`,
`gitTagActionPreviewSchema` and `gitTagMutationResultSchema`. The manifest has
896 roots and 13,458 nodes, adding 35 nodes while preserving all previous nodes
and root indices. Public TypeScript contracts remain unchanged.

Local macOS ARM64 evidence: 68 actual Node/native comparisons pass across all
four actions, exact tokens, commit/tree/blob/nested targets, Unicode names/messages,
publication/conflicting pushes, unavailable remotes, stale reviews and unborn
behavior. Actual SSH fixtures cover signed/tampered/unsigned tags, signed
lightweight targets, option-like refs, missing configuration/tool, changed trust
and existing commit signatures. Message limits preserve UTF-16 slicing. Ten native
worker unit tests and 27 focused existing Node Git/signature/journal tests pass.
A cancellation fixture starts four actual Git verifier children, stops inventory
and confirms their owned groups terminate. Earlier
compile and fixture failures are retained; the final run uses the rebuilt binary
and actual source schema/target constraints.

The production Rust worker/server smoke passes encrypted inventory/detail,
Node-produced review tokens after restart, all four tag actions, configured native
signing, trust changes and persisted journal guards. Earlier scenarios, including
remote configuration, still pass with Node absent from the worker PATH. Linked
worker/server/example builds, workspace all-target Clippy with warnings denied,
formatting/diff and source/contract checks pass. No GitHub Actions, external remote
connections, full-suite/device/VM/image campaign, release signing or deployment ran.

Submodules/LFS, Git graphs, observations, worktrees/recovery, GitHub, delegated OS
Git and direct legacy dispatch/protection remain required, along with execution/
history/providers, interactive terminals, browser/data planes, MCP/OS, Node-free
upgrades, packaging, default cutover and Node retirement. Windows job/tree ownership
and actual Windows/Linux runtime checks remain pending. The full goal stays active.

## Native reviewed Git submodules subcycle

This cycle uses branch `agent/manual/rust-worker-git-submodules` and reference
commit `843af4cb5` (#3187). Encrypted `repository.operation` now supports
`git.submodule.list`, `git.submodule.action.preview` and
`git.submodule.action.apply`: initialize, update, sync and deinitialize, including
recursive selection and remote updates. The fourteen outer handlers and Node
production default remain unchanged.

Inventory retains `.gitmodules` regular-file checks, lexical slash/path filtering,
configuration parsing, URL redaction, locale ordering, the 10,000-record bound,
index/current hashes and clean/uninitialized/changed/conflicted/missing states.
Nested actions use the nearest containing submodule as command cwd and its
relative child path. Reviews preserve exact Node action/inventory/workspace
JSON/SHA-256 tokens, target selection, warnings and dirty/force behavior. Mutations
reuse the 30-second bounded runner, preserve the managed journal and retain the
persisted active-record guard; inventory/preview remain readable. Concurrent
metadata queries drain before propagating stop/errors. No dependency, lockfile,
public TypeScript contract or production launch selection changes occur.

Three existing schema roots are appended: `gitSubmoduleListSchema`,
`gitSubmoduleActionPreviewSchema` and `gitSubmoduleMutationResultSchema`.
All previous roots/nodes remain unchanged; the graph now has 899 roots and
13,484 nodes, adding 26 nodes.

Local macOS ARM64 evidence: 47 actual Node/native comparisons pass across all four
actions, nested parent routing, exact/stale tokens, dirty/forced deinitialization,
local remote updates, URL redaction, missing configurations, lexical escapes,
symlinked `.gitmodules` and real unmerged gitlink index stages. One existing Node
submodule test and six journal/dispatch tests pass. The production Rust worker/
server smoke passes encrypted nested actions, Node-produced tokens after restart,
dirty/force handling, persisted state and journal guards. Its owned repository
and held sentinel are restored. The restricted worker PATH adds Git's native
basename/sed/uname dependencies and continues excluding Node. Linked builds,
workspace all-target Clippy with warnings denied, formatting/diff and source/
contract checks pass. No full suite, hosted checks, external remotes, device/VM/
image campaign, release signing or deployment ran.

LFS, Git graphs/observations/worktrees/recovery/GitHub, delegated OS Git, direct
legacy protection, execution/history/providers, interactive terminals/data planes,
browser/MCP/OS, Windows job ownership, Node-free upgrades and packaging/default
cutover remain required. The full goal stays active.

## Native reviewed Git LFS subcycle

This cycle uses branch `agent/manual/rust-worker-git-lfs` and reference commit
`838fd654f` (#3188). Encrypted `repository.operation` now supports `git.lfs.status`,
`git.lfs.action.preview` and `git.lfs.action.apply`: install, track, untrack, fetch,
pull, prune, refresh locks, lock and unlock/force unlock. The fourteen outer
handlers and production Node default remain unchanged.

The implementation uses the existing optional native Git LFS executable, matching
the Node worker. Missing-tool status, cached/refreshed locks, diagnostics, pattern/
file/pending/lock parsing, raw-entry bounds and missing-object counts are retained.
Shared wire primitives supply JSON/UTF-16, ECMAScript property order, safe-integer
handling and date parsing/ISO output. Submodule lexical filtering is reused.
Reviews preserve the exact stable-status/action/workspace JSON and SHA-256 digest,
summary text, warnings and destructive flags. LFS CLI calls use the existing
30-second owned-process collector; parallel status collectors drain before stop/
error propagation. Mutations preserve the managed journal and active-record guard.

Three existing roots are appended: `gitLfsStatusSchema`,
`gitLfsActionPreviewSchema` and `gitLfsMutationResultSchema`. All old nodes/root
indices remain unchanged; the graph has 902 roots and 13,527 nodes, adding 43
nodes. No public TypeScript contract, dependency or lockfile change occurs.

Local macOS ARM64 evidence: 45 actual Node/native comparisons pass across all
nine actions, exact/stale tokens, pending/pointer/missing-object state, actual
object downloads, cached/refreshed/foreign-owner locks, force unlock, unavailable
loopback endpoint and missing executable. Two native parser tests cover JavaScript
key order/numbers, malformed data, lock shapes/dates and unpaired UTF-16. One
existing Node LFS test and six journal/dispatch tests pass. The production Rust
worker/server smoke passes all nine encrypted actions, Node-produced tokens after
restart, real downloads/locks and journal guards with Node excluded from worker
PATH. The native Git LFS tool is explicitly available in that restricted PATH.

Fixtures use real Git LFS against a disposable loopback API, restore the owned
checkout/sentinel and remove profiles/objects afterward. Initial compile, preview
wording and fixture assumptions were corrected and earlier logs retained. Linked
builds, workspace all-target Clippy with warnings denied, formatting/diff and
source/contract checks pass. No hosted/full-suite/device/VM/image campaign,
external remote, release signing or deployment ran.

Git graphs/observations/worktrees/recovery/GitHub, delegated OS/direct legacy
protection, execution/history/providers, interactive terminals/data planes,
browser/MCP/OS, Windows job ownership, Node-free upgrades and packaging/default
cutover remain required. The full goal stays active.

## Native Git graph analysis subcycle

This cycle uses branch agent/manual/rust-worker-git-graph and reference commit
6625b7ba8 (#3189). Encrypted repository.operation now supports
git.graph.snapshot, git.graph.metrics and git.graph.commit-overlay.
The fourteen outer handlers and production Node default remain unchanged.

Graph snapshots retain revision/root resolution, committed trees, file/directory/
symlink/submodule kinds, language/extension mapping, visible directory sizes,
node limits and analysis states. Metrics retain text/binary classification,
line/history aggregation, incremental ancestor reuse, authorship/age and blame
coverage. Blame uses three owned collectors and the existing 80-file/75,000-line
bounds. All accepted collectors drain before stop/error propagation.

Separate snapshot, metric and latest-result caches retain the source keys,
16-entry eviction policy, pending deduplication, failure eviction and frozen
analysis timestamps. Pending cache entries are weak: accepted commands own
running subprocess work. Existing Git process helpers now accept the analyzer's
128 MiB bound while other callers retain their 16 MiB bound. Scoped commit
overlays reuse native commit detail, including renamed/deleted/binary files.
Source root rejection and inherited dictionary-key validation errors are retained.

Three existing contract roots are appended: gitGraphSnapshotSchema,
gitGraphMetricsSchema and gitGraphCommitOverlaySchema. All previous nodes
and root indices are unchanged; the graph has 905 roots and 13,612 nodes,
adding 85 nodes. No public TypeScript contract, dependency or lockfile changes.

Local macOS ARM64 evidence: 41 actual Node/native comparisons pass for all three
commands, unborn and detached repositories, scoped/truncated trees, Unicode/
tab/newline paths, symlinks/gitlinks, dirty-state independence, cache reuse and
invalidation, incremental history, author/age metrics, real blame limits,
scoped rename/delete overlays and source error behavior. Age comparisons allow
only measured execution-time differences. Two native cache lifetime/deduplication/
retry/bound tests, four existing Node graph tests and six journal/dispatch tests
pass. Encrypted production Rust worker/server graph queries pass across restart
and during an active journal, preserving journal bytes and owned checkout state.
Node is excluded from the worker PATH.

Linked worker/server/example builds, workspace all-target Clippy with warnings
denied, formatting/diff and source/contract checks pass. Initial compile/API,
test-command and source-error expectation failures were corrected; earlier logs
are retained. No hosted/full-suite/device/VM/image campaign, external remote,
release signing or deployment ran. Owned profiles/repositories are removed after
validation; small evidence remains under rust-worker-port-20261116/27-*.

Observation services, worktrees/recovery/GitHub, delegated OS/direct legacy
protection, execution/history/providers, interactive terminals/data planes,
browser/MCP/OS, Windows job ownership, Node-free upgrades and packaging/default
cutover remain required. The full goal stays active.

## Local development and validation

```sh
pnpm worker:rust:build
pnpm worker:rust:check
pnpm worker:rust:test
node scripts/worker-rust/cargo.mjs build --example config-fixture --example crypto-fixture --example grant-fixture --example content-fixture
node scripts/worker-rust/cargo.mjs build --example workspace-fixture
node scripts/worker-rust/cargo.mjs build --example explorer-fixture
node scripts/server-rust/cargo.mjs build -p cantrip-server -p cantrip-worker --bin cantrip-server --bin cantrip-worker --example content-fixture
node --import tsx scripts/worker-rust/config-compatibility.mjs --binary /absolute/path/to/config-fixture
node --import tsx scripts/worker-rust/crypto-compatibility.mjs --binary /absolute/path/to/crypto-fixture
node --import tsx scripts/worker-rust/grant-compatibility.mjs --binary /absolute/path/to/grant-fixture
node --import tsx scripts/worker-rust/content-compatibility.mjs --binary /absolute/path/to/content-fixture
node --import tsx scripts/worker-rust/stream-compatibility.mjs --binary /absolute/path/to/content-fixture
node --import tsx scripts/worker-rust/workspace-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/repository-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/git-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/git-actions-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/git-history-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/git-managed-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/git-plans-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/git-conflicts-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/git-commits-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/git-stashes-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/git-patches-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/git-branches-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/git-remotes-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/git-tags-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/git-submodules-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/git-lfs-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/git-graph-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/folder-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/explorer-compatibility.mjs --binary /absolute/path/to/explorer-fixture
node --import tsx scripts/worker-rust/private-state-compatibility.mjs --binary /absolute/path/to/content-fixture
node --import tsx scripts/worker-rust/explorer-command-compatibility.mjs --binary /absolute/path/to/content-fixture
node --import tsx scripts/worker-rust/workspace-smoke.mjs --worker /absolute/path/to/cantrip-worker --server /absolute/path/to/cantrip-server
node scripts/worker-rust/control-smoke.mjs --worker /absolute/path/to/cantrip-worker --server /absolute/path/to/cantrip-server
```

The wrapper uses the existing shared Cargo target, incremental disabled, two
jobs and no dev/test debug data; it performs no server database discovery.
The oracle emits synthetic credentials and must only receive disposable test
profiles. It calls the actual Node configuration/credential/discovery modules;
all created profiles are removed. It also reopens fresh Rust identities in Node
and checks byte-identical credential publication in both directions.

Per-cycle checks cover relevant crates, server consumers if a shared dependency
changes, focused behavior and meaningful boundary/recovery fixtures. Final
acceptance requires actual production Rust worker/server workflows, supported
upgrade and packaged desktop/standalone launch without installed/bundled Node.
A controlled fake command handler does not satisfy final worker acceptance.

All development validation runs locally. No full-suite repetition, physical
phone QA, VM campaign, broad benchmark, signing or deployment is needed. GitHub
Actions stays reserved for releases/deployments. Report Windows/Linux runtime
limitations honestly and resolve known implementation failures; do not treat
unimplemented platform behavior as merely unexecuted release qualification.

Retain small reports; remove owned disposable profiles/packages/downloads and
worktrees. Reuse bounded caches without per-worktree target directories or large
copies of runtime/profile data.
