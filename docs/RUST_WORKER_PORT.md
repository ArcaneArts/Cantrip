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
validation and managed folders. Ten real native command handlers are installed:
`worker.version`, `worker.credential.rotate`, `worker.restart`,
`diagnostics.logs.read`, `worker.encryption.refresh`,
`workspace.repositories.discover`, `workspace.repository-import.validate`,
`repository.operation` (root attachment and metadata operations only),
`project.folder.materialize`, and `project.folder.delete`.
The host Explorer filesystem engine also implements navigation, search, Git
commit lookup and text/entry editing. Its encrypted command adapter is pending,
so it adds no installed handlers or advertised capabilities yet.
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
attachment/metadata adapter, and two folder handlers above are implemented. Other indexed commands
remain pending; the source index itself grants no implementation credit.

Regenerate deliberately with `node scripts/worker-rust/inventory.mjs`. It uses
existing Babel development dependencies. Review source changes and update this
ledger rather than treating regeneration as proof of parity. The index is never
loaded by a production service.

| Area                               | Reference implementations and behavior                                                                                                    | Rust implementation                                                                                                             | Validation / remaining work                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration and profile identity | `config.ts`, `credential-store.ts`, `codex/bundled-runtime.ts`                                                                            | `config`, `credentials`, `installation` modules                                                                                 | Local Node differential checks, private file/rotation tests. Resolution only; Codex manifest verification/probing still pending                                                                                                                                                                                  |
| Logging and process lifetime       | `logger.ts`, `log-stream.ts`, `runtime-loop.ts`, `process-guard.ts`, `index.ts` startup/stop                                              | Native logging adapter and owned runtime cycles                                                                                 | Archive/options/privacy buffer, subscriptions, retained restart cursors, signal/stdin shutdown and actor teardown tested. Remote log-stream leases, full command log context and native child/execution retirement remain pending                                                                                |
| Enrollment/control transport       | `enrollment.ts`, `heartbeat.ts`, `transport.ts`, routing/observation adapters                                                             | Native enrollment/replacement, heartbeat, readiness/reconnect and credential lifecycle                                          | Actual Rust-server round trip, rotation/reconnect, restart/revocation and HTTP oracles pass. Execution lifetime/admission fencing, reconnect-grace resource callbacks, notifications/events/task acknowledgments, data-plane adapters, congestion fidelity and deployment TLS/proxy configuration remain pending |
| Endpoint encryption                | `packages/crypto`, `worker-encryption.ts`, `*-encryption.ts`, protected secrets                                                           | `cantrip-crypto::content`, `encryption::{Identity,Service}`, `protected_secrets`, `protected_content`                           | Native primitives/grants, content formats, provider/MCP helpers, endpoint/surface adapters and surface replay guard; remaining protected domains and serving resource lifetimes are pending                                                                                                                      |
| Files/workspaces                   | `commands/{workspace,project,explorer}.ts`, managed folders, roots, scratch/files, file documents, attachments/imports                    | `workspace`, managed folders/routing and nine host Explorer engine operations; encrypted Explorer/file-document adapter pending | Managed-folder/root flows tested with actual Rust server/worker. Explorer engine compared with actual Node functions; protected command/state integration, watches, paged readers, media and transfers remain pending.                                                                                           |
| Git/projects/GitHub                | `commands/{git,worktree,github}.ts`, `git.ts`, `worktrees.ts`, replicas, repository operations, exports and shares                        | Encrypted metadata registration/resolution; Git/GitHub execution pending                                                        | Owned repositories; command-specific differential tests, operation identity/recovery and actual Git/GitHub protocol boundaries                                                                                                                                                                                   |
| History/durable delivery           | `native-history-*`, `managed-native-history*`, inference journals, operation stores, suspension and outcome stores                        | Pending                                                                                                                         | Replay/crash/reopen, stable UTF-16 keys/digests, outbox acknowledgments and history reducer/projection fixtures; no cursor resets or uncertain effect replay                                                                                                                                                     |
| Inference/providers/models         | `commands/model-operations.ts`, admission/preparation/task input, model modules, Ollama, Grok, provider credentials/auth                  | Pending                                                                                                                         | Actual provider protocol fixtures, streaming/media/usage, refresh, cancellation, failure and paid-work bounds                                                                                                                                                                                                    |
| Native Codex execution             | `codex/*`, native command/settings/queue clients and delivery, handoff/suspension/continuation                                            | Pending                                                                                                                         | Manifest verification/probe, native app-server processes, queue ownership, acceptance/commit and restart recovery                                                                                                                                                                                                |
| Tasks/goals/automation/settings    | task/goal controls and durable publishers, automation scheduler/conditions, customization/skills/permissions                              | Pending                                                                                                                         | Pause/resume, outcome retry/ack, scheduling, protected configuration and source-specific task/runtime tests                                                                                                                                                                                                      |
| Terminals/run supervision          | terminal manager/canonical/private state, run-configuration providers and supervisors                                                     | Pending                                                                                                                         | PTY resize/replay/serialization, encrypted streams, owned process trees, output/redaction and run reconciliation                                                                                                                                                                                                 |
| WorkerLink/direct/tunnels          | gateways/peer/WebRTC/direct broker, tunnel protection/routing/adapters                                                                    | Native framing/tunnel crypto; serving adapters pending                                                                          | Existing frame fixtures plus actual ICE/TURN/WebRTC interoperability, bounded backpressure, stale grant/session and disconnect behavior                                                                                                                                                                          |
| Browsers/surfaces/computer use     | browser/desktop adapters, remote surfaces, computer-use services, web service and managed Playwright/SearXNG                              | Native stream protection; execution/resources pending                                                                           | Native replacements for Node driver/helpers; selectors/snapshots/input/capture/network restrictions; permission/approval revocation; no dropped features                                                                                                                                                         |
| MCP/CLI/CodeGraph                  | `mcp/*`, CLI broker, computer-use MCP, codegraph/runtime/supervisor                                                                       | Pending                                                                                                                         | Native stdio/HTTP helpers, generated/persisted launch commands, binding/generation scopes, CLI and managed-runtime fixtures                                                                                                                                                                                      |
| Cantrip OS                         | `cantrip_os/host`, `os-executor/*`, native MCP/run execution                                                                              | Pending                                                                                                                         | Port Node host orchestration, Docker/guest/lifecycle/files/PTY/tunnels/packages/backups/system/checkpoints; retain independent non-Node guest helpers                                                                                                                                                            |
| Upgrade and packaging              | profile converter/database-transfer, server profile preparation, desktop services/worker, distribution/runtime scripts, worker Dockerfile | Pending                                                                                                                         | Node-free legacy conversion/export/restore, desktop/standalone artifacts, existing-profile reopen and actual child-process/runtime audit                                                                                                                                                                         |

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
publish compatibly. Remaining state includes routing registries,
repository-operation stores, inference keeper journals, native history
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

## Local development and validation

```sh
pnpm worker:rust:build
pnpm worker:rust:check
pnpm worker:rust:test
node scripts/worker-rust/cargo.mjs build --example config-fixture --example crypto-fixture --example grant-fixture --example content-fixture
node scripts/worker-rust/cargo.mjs build --example workspace-fixture
node scripts/worker-rust/cargo.mjs build --example explorer-fixture
node --import tsx scripts/worker-rust/config-compatibility.mjs --binary /absolute/path/to/config-fixture
node --import tsx scripts/worker-rust/crypto-compatibility.mjs --binary /absolute/path/to/crypto-fixture
node --import tsx scripts/worker-rust/grant-compatibility.mjs --binary /absolute/path/to/grant-fixture
node --import tsx scripts/worker-rust/content-compatibility.mjs --binary /absolute/path/to/content-fixture
node --import tsx scripts/worker-rust/stream-compatibility.mjs --binary /absolute/path/to/content-fixture
node --import tsx scripts/worker-rust/workspace-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/repository-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/folder-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/explorer-compatibility.mjs --binary /absolute/path/to/explorer-fixture
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
