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
heartbeat HTTP, and a reconnecting WebSocket control connection. Four real native
handlers are installed: `worker.version`, `worker.credential.rotate`,
`worker.restart`, and `diagnostics.logs.read`. Other commands fail explicitly;
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
The four native control handlers above are implemented. Other indexed commands
remain pending; the source index itself grants no implementation credit.

Regenerate deliberately with `node scripts/worker-rust/inventory.mjs`. It uses
existing Babel development dependencies. Review source changes and update this
ledger rather than treating regeneration as proof of parity. The index is never
loaded by a production service.

| Area                               | Reference implementations and behavior                                                                                                    | Rust implementation                                                                    | Validation / remaining work                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration and profile identity | `config.ts`, `credential-store.ts`, `codex/bundled-runtime.ts`                                                                            | `config`, `credentials`, `installation` modules                                        | Local Node differential checks, private file/rotation tests. Resolution only; Codex manifest verification/probing still pending                                                                                                                                                                                  |
| Logging and process lifetime       | `logger.ts`, `log-stream.ts`, `runtime-loop.ts`, `process-guard.ts`, `index.ts` startup/stop                                              | Native logging adapter and owned runtime cycles                                        | Archive/options/privacy buffer, subscriptions, retained restart cursors, signal/stdin shutdown and actor teardown tested. Remote log-stream leases, full command log context and native child/execution retirement remain pending                                                                                |
| Enrollment/control transport       | `enrollment.ts`, `heartbeat.ts`, `transport.ts`, routing/observation adapters                                                             | Native enrollment/replacement, heartbeat, readiness/reconnect and credential lifecycle | Actual Rust-server round trip, rotation/reconnect, restart/revocation and HTTP oracles pass. Execution lifetime/admission fencing, reconnect-grace resource callbacks, notifications/events/task acknowledgments, data-plane adapters, congestion fidelity and deployment TLS/proxy configuration remain pending |
| Endpoint encryption                | `packages/crypto`, `worker-encryption.ts`, `*-encryption.ts`, protected secrets                                                           | `cantrip-crypto`, `encryption::Identity`                                               | Native AES/HPKE/HKDF/HMAC and compatible key records; authenticated grant refresh, domain wrappers and encrypted stream/replay adapters remain pending                                                                                                                                                           |
| Files/workspaces                   | `commands/{workspace,project,explorer}.ts`, managed folders, roots, scratch/files, file documents, attachments/imports                    | Pending                                                                                | Temporary roots; symlink/containment, binary/text, partial writes, watches and relocation fixtures; use docs/WORKTREES.md focused matrix                                                                                                                                                                         |
| Git/projects/GitHub                | `commands/{git,worktree,github}.ts`, `git.ts`, `worktrees.ts`, replicas, repository operations, exports and shares                        | Pending                                                                                | Owned repositories; command-specific differential tests, operation identity/recovery and actual Git/GitHub protocol boundaries                                                                                                                                                                                   |
| History/durable delivery           | `native-history-*`, `managed-native-history*`, inference journals, operation stores, suspension and outcome stores                        | Pending                                                                                | Replay/crash/reopen, stable UTF-16 keys/digests, outbox acknowledgments and history reducer/projection fixtures; no cursor resets or uncertain effect replay                                                                                                                                                     |
| Inference/providers/models         | `commands/model-operations.ts`, admission/preparation/task input, model modules, Ollama, Grok, provider credentials/auth                  | Pending                                                                                | Actual provider protocol fixtures, streaming/media/usage, refresh, cancellation, failure and paid-work bounds                                                                                                                                                                                                    |
| Native Codex execution             | `codex/*`, native command/settings/queue clients and delivery, handoff/suspension/continuation                                            | Pending                                                                                | Manifest verification/probe, native app-server processes, queue ownership, acceptance/commit and restart recovery                                                                                                                                                                                                |
| Tasks/goals/automation/settings    | task/goal controls and durable publishers, automation scheduler/conditions, customization/skills/permissions                              | Pending                                                                                | Pause/resume, outcome retry/ack, scheduling, protected configuration and source-specific task/runtime tests                                                                                                                                                                                                      |
| Terminals/run supervision          | terminal manager/canonical/private state, run-configuration providers and supervisors                                                     | Pending                                                                                | PTY resize/replay/serialization, encrypted streams, owned process trees, output/redaction and run reconciliation                                                                                                                                                                                                 |
| WorkerLink/direct/tunnels          | gateways/peer/WebRTC/direct broker, tunnel protection/routing/adapters                                                                    | Pending                                                                                | Existing frame fixtures plus actual ICE/TURN/WebRTC interoperability, bounded backpressure, stale grant/session and disconnect behavior                                                                                                                                                                          |
| Browsers/surfaces/computer use     | browser/desktop adapters, remote surfaces, computer-use services, web service and managed Playwright/SearXNG                              | Pending                                                                                | Native replacements for Node driver/helpers; selectors/snapshots/input/capture/network restrictions; permission/approval revocation; no dropped features                                                                                                                                                         |
| MCP/CLI/CodeGraph                  | `mcp/*`, CLI broker, computer-use MCP, codegraph/runtime/supervisor                                                                       | Pending                                                                                | Native stdio/HTTP helpers, generated/persisted launch commands, binding/generation scopes, CLI and managed-runtime fixtures                                                                                                                                                                                      |
| Cantrip OS                         | `cantrip_os/host`, `os-executor/*`, native MCP/run execution                                                                              | Pending                                                                                | Port Node host orchestration, Docker/guest/lifecycle/files/PTY/tunnels/packages/backups/system/checkpoints; retain independent non-Node guest helpers                                                                                                                                                            |
| Upgrade and packaging              | profile converter/database-transfer, server profile preparation, desktop services/worker, distribution/runtime scripts, worker Dockerfile | Pending                                                                                | Node-free legacy conversion/export/restore, desktop/standalone artifacts, existing-profile reopen and actual child-process/runtime audit                                                                                                                                                                         |

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

The endpoint key record now reopens and publishes compatibly; authenticated
grant/binding lifecycle remains pending. Remaining state includes routing registries,
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
3. Endpoint cryptography and protected persistence — native primitives and key records in the current subcycle; authenticated grants and domain/stream adapters follow.
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

The endpoint-crypto subcycle uses branch `agent/manual/rust-worker-endpoint-crypto`
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
this identity-only stage. Grant refresh/concurrency/revocation and every protected
domain/stream adapter remain required before cutover.

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

## Local development and validation

```sh
pnpm worker:rust:build
pnpm worker:rust:check
pnpm worker:rust:test
node scripts/worker-rust/cargo.mjs build --example config-fixture --example crypto-fixture
node --import tsx scripts/worker-rust/config-compatibility.mjs --binary /absolute/path/to/config-fixture
node --import tsx scripts/worker-rust/crypto-compatibility.mjs --binary /absolute/path/to/crypto-fixture
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
