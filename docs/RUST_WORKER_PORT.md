# Rust worker replacement

## Current runtime

Cantrip's packaged desktop application, standalone distributions, hosted Compose,
and development launchers select the native Rust server and worker. The desktop
supervisor owns both processes. The server retains authorization, durable state,
routing, and scheduling. The worker owns endpoint secrets, repositories, files,
terminals, browsers, execution, and local journals.

The worker shares the protocol, transport, configuration, logging, scheduling,
host, and wire crates with the server. Worker-side cryptography, history, browser,
and PTY code live in focused Rust crates. The worker's Cargo dependency tree is
independent of the server application and its database infrastructure. The package
includes the pinned native Codex runtime, Cantrip CLI and CUA helper, and provides
Cantrip and CUA MCP through native worker subcommands.

- Develop both services with `pnpm dev` or `pnpm devtop`. Build and check the
  worker with `pnpm worker:rust:build` and `pnpm worker:rust:check`.
- Build a standalone artifact with `pnpm package:worker --target <target>`.
  Keep the package layout and the existing worker data directory. See the
  [standalone worker guide](../deploy/worker.README.md) for launch and enrollment.
- Assemble desktop with `pnpm package:app`. The supervisor prepares existing
  profiles with the native server and compatibility PostgreSQL tools. See the
  [server guide](../deploy/server.README.md#existing-desktop-profiles) for
  supported database modes, stopped-profile upgrades, and rollback.
- Hosted Compose builds the worker with `deploy/docker/worker.Dockerfile`.
  It retains the worker profile, enrollment configuration, and persistent volume.
  Winterhold's systemd deployment uses the standalone native server layout.

Node remains in source builds, client and protocol tooling, and the compatibility
references under `tests/reference-node-worker` and `tests/reference-node-server`.
Users can still select external runtimes, project tools, and MCP servers that use
Node. The browser's in-page JavaScript and the native CUA scripting interface
remain product capabilities. The runtime still uses OS libraries and tools such as
Git and SSH where applicable, and Cantrip OS keeps its separate guest helpers.

The [packaging cutover](#278-ship-the-rust-worker-in-cantrip-packages), the
[Node worker archive](#286-archive-the-node-worker-as-a-compatibility-reference),
and the [desktop and upgrade checks](#288-verify-the-native-desktop-runtime-and-legacy-profile-round-trip)
record the transition. See also the
[local Linux ARM64 image check](#295-verify-the-node-free-linux-arm64-worker-image).

## Implementation record

The baseline inventory and numbered milestones record the state at their
respective points in the port. Later milestones supersede earlier progress and
platform statements.

The port started with the Node worker selected in production. Its scope covers
first-party helpers, desktop and standalone packaging, and the supported legacy
profile-upgrade path.

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
resolution, managed-operation creation/recovery, native physical worktree management and
control-channel worktree observations, reviewed cross-worktree dirty changes and
checkpointed reflog/lost-commit recovery, worker-scoped GitHub catalog operations,
and repository-scoped issue detail/mutations, issue/PR search, PR inspection, creation, reviews, lifecycle, checkout preparation and agent context,
GitHub inbox, Actions and releases, plus native replica provisioning and
managed-link repair, synchronization and guarded removal over the existing
placement/ownership records. Eighty-two outer command types have native handlers:
`worker.version`, `worker.credential.rotate`, `worker.restart`,
`diagnostics.logs.read`, `worker.encryption.refresh`, `chat.sync` (cold host observation),
`chat.thread.ensure` (managed host attachment), `chat.turn` and `chat.interrupt`
(host text turns, including protected input, managed GUI receipts and
canonical History for admitted project turns, plus protected Task rounds),
`chat.message.protect`,
`chat.messages.protect`, `chat.messages.reprotect`, `chat.turn.protect`,
`task.message.protect` and `task.operation.prepare` (encrypted Task input),
`chat.goal.create` (activation from an encrypted Task finalization),
`chat.native-logical.cancel`, `chat.native-logical.complete` and
`chat.native-control` (interrupt for active managed host text turns),
`model.chatgpt.catalog`,
`model.grok.catalog` and `provider.quota.read` (Grok),
`provider.auth.legacy.capture`, `provider.auth.legacy.purge`, `provider.auth.account.clear`,
`codex.auth.status`, `codex.auth.login.start` and `codex.auth.logout` (ChatGPT and Grok),
`workspace.repositories.discover`, `workspace.repository-import.validate`,
`repository.operation` (root attachment, metadata, host Git status/file diffs and
eleven basic Git actions, nine history/inspection queries, stash creation/diffs/mutations
and reviewed previews/starts plus current/control/amend recovery and four conflict
inspection/resolution operations, plus reviewed cherry-pick/revert/amend/fixup and
partial stage/unstage/discard, plus branch inventory/eight reviewed branch actions
and remote inventory/five reviewed remote actions, plus tag inventory/detail and
four reviewed tag actions, plus recursive submodule inventory and four reviewed
submodule actions, plus LFS status and nine reviewed LFS actions, plus graph snapshots,
metrics/blame and commit overlays, two cross-worktree change-transfer operations,
and recovery candidate/preview/apply operations),
`project.folder.materialize`, `project.folder.delete`, `explorer.operation`
(nine host operations), `file-document.operation` (text read/write),
`terminal.services.reconcile` and `terminal.service.restart` (host services), plus
`worktree.list`, `worktree.reconcile`, `worktree.create`, `worktree.remove`,
`worktree.lock`, `worktree.unlock`, `worktree.prune`, `worktree.status` and
`worktree.observation.configure`, `github.auth.status`, `github.repositories.cached`,
`github.repositories.list`, `github.repository-owners.list` and
`github.repositories.create`, `github.issues.list`, `github.pull-requests.list`,
`github.issue.get`, `github.issue.create`, `github.issue.comment` and
`github.issue.close`, `github.pull-request.get` (all/overview/files/commits/checks),
`github.pull-request.create`, `github.pull-request.comment`,
`github.pull-request.review.submit`, `github.pull-request.review.comment`,
`github.pull-request.review.reply`, `github.pull-request.review.mutate`,
`github.pull-request.lifecycle.preview`, `github.pull-request.lifecycle.apply`,
`github.pull-request.checkout.prepare`, `github.pull-request.agent-context`,
`github.inbox.list`, `github.actions.overview`, `github.actions.run.get`,
`github.actions.run.logs`, `github.actions.workflow.dispatch`,
`github.actions.run.action`, `github.actions.run.checkout.prepare`,
`github.releases.list`, `github.release.get`, `github.release.create`,
`project.replica.provision`, `project.replica.link.repair`,
`project.replica.synchronize` and `project.replica.remove`.
Encrypted repository operations also serve worktree status.
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
The native handlers and suboperations listed above are implemented with the
subsystem evidence below. Other indexed commands remain pending; the source
index itself grants no implementation credit.

Regenerate deliberately with `node scripts/worker-rust/inventory.mjs`. It uses
existing Babel development dependencies. Review source changes and update this
ledger rather than treating regeneration as proof of parity. The index is never
loaded by a production service.

| Area                               | Reference implementations and behavior                                                                                                    | Rust implementation                                                                                                                                                                                                                                                                                                                                                                                     | Validation / remaining work                                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration and profile identity | `config.ts`, `credential-store.ts`, `codex/bundled-runtime.ts`                                                                            | `config`, `credentials`, `installation` modules                                                                                                                                                                                                                                                                                                                                                         | Local Node differential checks, private file/rotation tests. Bundled manifest verification and native version/capability discovery now run during actual startup; focused Node/native and real bundled Codex checks pass                                                                                                                                                                                                  |
| Logging and process lifetime       | `logger.ts`, `log-stream.ts`, `runtime-loop.ts`, `process-guard.ts`, `index.ts` startup/stop                                              | Native logging adapter and owned runtime cycles                                                                                                                                                                                                                                                                                                                                                         | Archive/options/privacy buffer, subscriptions, retained restart cursors, signal/stdin shutdown and actor teardown tested. Remote log-stream leases, full command log context and native child/execution retirement remain pending                                                                                                |
| Enrollment/control transport       | `enrollment.ts`, `heartbeat.ts`, `transport.ts`, routing/observation adapters                                                             | Native enrollment/replacement, heartbeat, readiness/reconnect and credential lifecycle                                                                                                                                                                                                                                                                                                                  | Actual Rust-server round trip, rotation/reconnect, restart/revocation and HTTP oracles pass. Execution lifetime/admission fencing, reconnect-grace resource callbacks, notifications/events/task acknowledgments, data-plane adapters, congestion fidelity and deployment TLS/proxy configuration remain pending                 |
| Endpoint encryption                | `packages/crypto`, `worker-encryption.ts`, `*-encryption.ts`, protected secrets                                                           | Native endpoint/surface/repository formats, all private surface records and scoped grant helpers                                                                                                                                                                                                                                                                                                        | Private-state interop covers 12 resource contexts and six content kinds. Remaining protected domains and serving resource lifetimes are pending. Initial surface-grant refresh now completes real host terminal-service reconciliation; delegated OS services remain pending.                                                    |
| Files/workspaces                   | `commands/{workspace,project,explorer}.ts`, managed folders, roots, scratch/files, file documents, attachments/imports                    | Workspace/folders/routing, nine protected host Explorer operations and bound file-document text read/write                                                                                                                                                                                                                                                                                              | Actual Rust worker/server persists encrypted resources, resolves opaque roots, saves files, rejects replay/mismatched document paths and reopens after restart. Paged readers, media/tail, transfers, activity/watches and delegated OS execution remain pending.                                                                |
| Git/projects/GitHub                | Git/worktree/GitHub handlers, git.ts, git-graph.ts, worktrees.ts, replicas, repository operations, exports/shares                         | Native queries, graphs/metrics/blame/overlays, reviewed Git actions/recovery, physical worktree management, observations, dirty-change transfer, checkpointed recovery and GitHub catalog, issue detail/mutations, issue/PR search, inspection, creation, reviews, lifecycle, checkout preparation, agent context, inbox, Actions/releases and replica provisioning/synchronization/removal/link repair | Independent actual Node comparisons cover delivered operations. Runtime evidence is corrected in the physical-worktree subcycle below; control observation delivery is validated below. CodeGraph/WorkerLink observation integration, direct legacy Git dispatch/protection, exports/sharing and delegated OS Git remain pending |
| History/durable delivery           | `native-history-*`, `managed-native-history*`, inference journals, operation stores, suspension and outcome stores                        | `cantrip-history` implements encrypted source journals, cursor recovery, complete pure reduction, complete outbox/baseline/mutation/receipt storage and projection/checkpoint/rebase transactions; worker encryption adapter, authenticated HTTP client, canonical content preparation, coherent archive recovery, native item rendering and canonical projector/bootstrap/rebase orchestration                                                                                                                                                                                                                       | Journal/outbox/projection, native protected preparation and coherent HTTP archive recovery pass focused checks; verified retained-context/child-scope and durable media/attachment adapters are native; live output identity, observation/capture and managed source/projection retry/recovery are native; verified child discovery and the top-level coordinator are native, including production worker startup recovery; live Codex/provider capture integration remains pending                                                                                                                                                    |
| Inference/providers/models         | `commands/model-operations.ts`, admission/preparation/task input, model modules, Ollama, Grok, provider credentials/auth                  | Native provider-error policy plus worker-wide provider pools, canonical lifetimes, direct HTTP/preparation admission, durable recovery, portable provider credential access, ChatGPT and Grok catalogs and device sign-in, Grok quota reads and subscription proxy, legacy credential migration and scoped account clearing | Keeper-backed recovery, sealed credential migration, both device authentication lifecycles and Grok discovery against the Node oracle pass locally. Bundled Codex uses the native Grok proxy with a local provider peer. Additional catalog/quota commands and server-dispatched execution adapters remain pending |
| Native Codex execution             | `codex/*`, native command/settings/queue clients and delivery, handoff/suspension/continuation                                            | Native discovery, managed sessions/RPC, keeper/journal, worker-wide admission manager, Codex admission adapter, private RPC routing and worker-scoped runtime owner and cold host thread observation; command-source execution adapters still pending | Real keeper grants, no-start withdrawal, cold FIFO recovery and prior registered app-server retirement; integrated execution, queue/settings and task/goal orchestration remain pending |
| Tasks/goals/automation/settings    | task/goal controls and durable publishers, automation scheduler/conditions, customization/skills/permissions                              | Pending                                                                                                                                                                                                                                                                                                                                                                                                 | Pause/resume, outcome retry/ack, scheduling, protected configuration and source-specific task/runtime tests                                                                                                                                                                                                                      |
| Terminals/run supervision          | Terminal manager/canonical/private state, run-configuration providers and supervisors                                                     | Native host service reconciliation/restart and owned PTY supervision                                                                                                                                                                                                                                                                                                                                    | Actual encrypted server/worker service enable, idempotence, restart, recovery and disable pass. Interactive commands, canonical terminal/replay, attachment/input/resize, CLI broker environments, run providers and delegated OS services remain pending.                                                                       |
| WorkerLink/direct/tunnels | Gateways, peer/WebRTC, direct broker, tunnel protection and routing | Native installed authority, live observations, encrypted Host terminals and TCP, WebDAV shares, direct tickets, and LAN and WAN peer carriage | Continue managed console and guest/surface adapters. Local peer fixtures cover authenticated negotiation, encrypted TCP, credit, renewal, and revocation. |
| Browsers/surfaces/computer use | Browser discovery, browser/desktop adapters, remote surfaces, computer use, and managed web runtimes | Native browser discovery, Chromium and CDP, encrypted surfaces with recovery, and signed managed Chromium installation | Public browser transport and Chromium recovery fixtures pass locally. The native installer verifies signed releases and probes Chromium. Legacy browser WebRTC, desktop capture, computer use, managed web sessions and search remain open. |
| MCP/CLI/CodeGraph                  | `mcp/*`, CLI broker, computer-use MCP, codegraph/runtime/supervisor                                                                       | Pending                                                                                                                                                                                                                                                                                                                                                                                                 | Native stdio/HTTP helpers, generated/persisted launch commands, binding/generation scopes, CLI and managed-runtime fixtures                                                                                                                                                                                                      |
| Cantrip OS | `cantrip_os/host`, `os-executor/*`, native MCP/run execution | Native guest inspection, attachment, workspace listing and creation, operation inspection, Linux-owned source provisioning and verification, linked Host mounts, guest Run definitions and process supervision, and guest Explorer navigation, text documents, paged reads, and streamed binary saves | Continue guest file imports, chat files, lifecycle, PTYs, tunnels, packages, backups, system operations and checkpoints. |
| Upgrade and packaging              | profile converter/database-transfer, server profile preparation, desktop services/worker, distribution/runtime scripts, worker Dockerfile | Pending                                                                                                                                                                                                                                                                                                                                                                                                 | Node-free legacy conversion/export/restore, desktop/standalone artifacts, existing-profile reopen and actual child-process/runtime audit                                                                                                                                                                                         |

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

## Native physical worktree foundation subcycle

This cycle uses branch agent/manual/rust-worker-worktrees and reference commit
baef7f8db (#3190). The native manager implements physical inventory/reconciliation,
status, all three create modes, removal, lock/unlock and prune. Eight public
handlers use existing routing/result/error protection; encrypted
repository.operation also serves worktree.status with trusted source/target paths.
The production worker default remains Node.

Inventory retains canonical source/common-directory identity, Primary ordering,
missing/prunable/locked records and managed-root classification. Create preserves
NFKD slugs, UTF-8 identity hashes, private directory creation, idempotent retry,
branch validation and canonical bucket containment. Mutations share a common-dir
queue; accepted tasks own their queue lifetimes. Removal preserves Primary,
external-authorization, lock, missing and dirty guards before its optional
service-retirement callback. The callback executes and can reject removal.
Run-configuration retirement and CodeGraph detach wiring remain required when
those native services are introduced. Observation configuration/watchers and
WorkerLink observation delivery remain pending.

All existing generated contracts are reused byte-for-byte. The worker adds a
direct dependency on already-locked icu_normalizer 2.1.1 for UTF-16 NFKD; all 369
external package identities/checksums remain unchanged and no new external
package is added.

Independent local macOS ARM64 evidence: 58 actual Node/native comparisons pass
across all eight commands, real repository fingerprints, managed identities,
Unicode/lone-surrogate names, colliding creates, removal-hook admission/failure,
external/prune authority, missing worktrees, common-dir replacement, symlink
bucket escapes and the source two-dot-name classification. Two native parser/
normalization tests, six existing Node worktree tests and six journal/dispatch
tests pass. Direct worker and linked worker/server/example builds and workspace
all-target Clippy with warnings denied pass.

Evidence correction: the earlier workspace-smoke reports marked the commit,
stash, partial-patch, branch, remote, tag, submodule, LFS and graph helper checks
as passed even though those calls appeared after a returned restart callback and
were unreachable. Their independent differential results remain valid. This
cycle moves those helpers into the executed callback and records completed
runtime checks in the report. Preview oracles now use actual Node command/schema
normalization. Owned local submodule fixtures explicitly allow file transport;
lock fixtures compare cached behavior and verify fresh remote ownership.
Earlier broad smoke flags alone do not prove those later runtime cases.

The corrected production Rust worker/server run passes all nine runtime helper
checks and records their completion. Actual worktree APIs pass all create modes,
lock/unlock, worker restart, guarded/forced removal, reconciliation/prune and
encrypted status, including active-journal preservation and private metadata.
The owned stopped PGlite profile is seeded through the existing native repository
fixture with the supported GitHub catalog classification, then production server
and worker binaries resume. No GitHub connection occurs and local-Git capability
restrictions remain intact. Node is excluded from worker PATH. Formatting/diff
and source/contract audits pass. Earlier failures remain as small local evidence;
owned profiles/repositories are removed. No GitHub Actions, full repository suite,
device/VM/image campaign, signing or deployment ran.

The full worker goal remains active: observations, cross-worktree/reflog/GitHub,
execution/history/providers, interactive terminals/data planes, browser/MCP/OS,
Windows job ownership, Node-free upgrades and packaging/default cutover remain.

## Native worktree observation subcycle

This cycle uses branch agent/manual/rust-worker-worktree-observations and
reference commit 6d4715d7d (#3191). The production default remains Node. Native
worktree.observation.configure now canonicalizes supported project path
representations, reconciles opaque bindings, and configures worker-owned Git
observation. CodeGraph configuration remains explicitly degraded/unimplemented;
Git configuration can still be accepted, as when the source coordinator fails.
This is not evidence of native CodeGraph indexing or supervision.

The observer installs native recursive checkout and Git-metadata watchers using
notify 8.2.0, already used by the independently owned Codex workspace. It retains
500 ms debouncing, 2-second HEAD reconciliation, 30-second source/status sweeps,
bounded concurrent scans, unchanged-snapshot suppression and retry after rejected
operation publication. Access-only native events do not turn Git reads into new
filesystem edits. Failed watchers are recreated by reconciliation. Shutdown
retires watchers, cancels owned Git reads and joins observation jobs; late
configuration cannot reopen resources. Target identity fences stale publication
across configuration changes.

File activity preserves raw-path deduplication, UTF-16 path limits, 2,000-change
and 256 KiB UTF-8 JSON budgets, atomic-save classification, deleted descendants,
directory-event suppression and NUL-delimited commit-derived changes. Managed
operation notifications retain compact state, conflict truncation, exact raw
fingerprints, timestamp format and conflict/abort transitions. Full notifications
remain available at the emitter boundary for the later encrypted WorkerLink
adapter; that serving adapter is still pending.

The native control adapter strips filesystem change details and protects other
repository metadata before publication. Source/worktree paths use the same path
token namespace as accepted configuration bindings, including nested inventory
source paths and status worktree paths. This is required by the current server's
owned-path lookup; sending the manager's raw paths would fail that lookup and
expose private metadata. Registry contention and disconnected/congested control
queues reject publication, so producers retain retry eligibility. New tokens are
persisted before accepted notification delivery. The raw manager's behavior is
compared independently with the current Node implementation.

Local macOS ARM64 validation passes 49 actual Node/native comparisons, including
recursive file activity, metadata-only HEAD changes, real conflicted/aborted
rebase observations, publication rejection/retry, canonical path reconciliation,
identical configuration, target removal and configuration after close. Three
native queue/privacy/registry tests and nine focused existing Node observation
and file-activity tests pass. Workspace all-target Clippy with warnings denied
compiles the worker, server and shared consumers. All existing locked package
identities/checksums remain unchanged; 20 transitive watcher/platform packages
are added. Generated protocol contracts are unchanged.

The focused production Rust worker/server run uses the existing disposable
workspace fixture with --observations-only, skipping unrelated Git, Explorer,
folder and terminal runtime cases. It verifies committed Git-status live events,
filesystem invalidations, metadata HEAD updates, opaque private paths and
observation after worker restart with the persisted endpoint identity retained.
Node is absent from worker PATH. A real metadata-only Git update establishes
observer configuration before the single-file watcher check. The fixture's pipe
decoder retains UTF-8 characters across chunks; the explicit-ID profile checks
its actual endpoint identity rather than expecting a generated-ID file.

No GitHub Actions, full repository suite, physical devices, VM/image campaign,
signing, publishing or deployment are used. Temporary profiles/repositories are
removed. Windows/Linux watcher code is supplied by notify, but only macOS runtime
behavior is exercised here; this is not a cross-platform runtime acceptance claim.

Remaining work includes CodeGraph and encrypted WorkerLink observation adapters,
cross-worktree/reflog/GitHub functionality, execution/history/providers,
interactive terminals and other data planes, browser/MCP/OS, Windows job ownership,
Node-free upgrades, packaging/default cutover and retirement of production Node.

## Native cross-worktree changes and Git recovery subcycle

This cycle uses branch agent/manual/rust-worker-worktree-changes and reference
commit 55bb711a5 (#3192). Five additional encrypted repository operations are
implemented: git.worktree.changes.preview/apply and git.recovery.list/preview/apply.
They reuse existing Git status, diffs, history, comparison, branch ownership,
private operation journals and stash/checkpoint recovery. The production worker
default remains Node; direct legacy plaintext Git dispatch remains pending.

Change-transfer reviews verify distinct canonical checkouts in one Git common
directory, idle Git markers, a dirty source and a clean target. Their exact
fingerprint includes both HEADs/statuses, raw source-index bytes, sorted untracked
and changed-content hashes, and the complete binary diff. UTF-16 sorting and
patch truncation match the source. A detached preview worktree probes conflicts;
owned children, registrations and temporary files retire even when shutdown
interrupts the add command after registration. Content hashing has bounded
concurrency and preserves source result ordering.

Apply preserves staged/unstaged, binary, deleted and untracked content through a
recovery stash. Success retires that stash/checkpoint; conflicting moves retain
them with the existing resumable stash context. Non-conflict failure restores
the original target and attempts source restoration, retaining recovery state if
restoration fails. The encrypted dispatcher verifies the private source identity
against the server-routed peer, overwrites any private sourceCwd, rejects peers
on unrelated operations and persists conflict journals under the target scope.
Existing active-operation admission and restart/control behavior apply.

Recovery lists paginated reflog movements and unreachable commits with the
existing explanations, actor/date fields and cursor behavior. Reviewed branch
creation/restoration and soft/mixed/hard reset retain exact confirmation strings,
workspace tokens, checked-out branch guards, checkpoint identity/collision checks
and compare-and-swap ref updates. No user repository is used for validation.

Five existing TypeScript result schemas are appended to the generated Rust
contract roots, with explicit forwarding of their lazy status references. The
905 previous root bindings and all 13,612 previous nodes remain byte-for-byte
unchanged; the new manifest has 910 roots and 13,673 nodes. Cargo.lock and package
dependencies are unchanged. Generated schema counts are structural evidence,
not behavioral coverage.

Local macOS ARM64 evidence: 110 actual Node/native comparisons pass across eight
scenario groups, including staged/unstaged/binary/deleted/untracked transfer,
source/target/common-directory guards, stale content and staged-only snapshots,
conflict recovery/abort, untracked collision rollback, detached targets, truncated
Unicode patches and paginated checkpointed recovery. Preview tokens are compared
exactly against Node on each actual checkout. Distinct checkout index bytes can
legitimately produce distinct tokens; derived stash identities are normalized
between lanes only after checking their real messages, parents and checkpoints.
A controlled native Git boundary additionally stops a real add child after Git
has registered its preview and verifies complete owned cleanup. Four existing
Node transfer/recovery tests and two peer-authority tests pass.

The focused production Rust worker/server fixture runs with --recovery-only,
skipping unrelated Git/Explorer/folder/terminal/observation cases. It verifies
exact encrypted previews, mismatched-peer rejection, trusted path replacement,
stale-token rejection, staged/untracked transfer, checkpointed recovery, conflict
journal persistence, actual worker restart/current-operation reopening and abort,
and active-operation rejection. Node is excluded from worker PATH. The fixture
restores its owned dirty sentinel and removes its target checkout.

Direct worker and linked worker/server/native repository-fixture builds,
workspace all-target Clippy with warnings denied, contract/source audit and
format/diff checks pass. The detached-target differential case exposed and fixed
an empty-string versus null preview branch mismatch. The schema exporter needed
two explicit lazy-status forwards. No hosted Actions, full repository suite,
physical devices, VM/container image campaign, signing or deployment is used.
Only macOS runtime validation is claimed; temporary repositories/profiles are
removed and the shared bounded Cargo cache is reused.

GitHub integration and remaining project/export/share behavior, CodeGraph and
WorkerLink data planes, history/execution/providers/tasks, interactive terminals,
browser/MCP/OS, Windows job ownership, Node-free upgrades and packaging/default
cutover remain part of the active worker goal.

## Native GitHub authentication and repository catalog subcycle

Reference: `56b6b0bdad88d5a6e040ca2e8943eac65998ba6f`. Delivery branch:
`agent/manual/rust-worker-github-catalog`.

`cantrip_worker_rs/src/github/{mod,catalog,process}.rs` implements the existing
five worker-scoped GitHub operations: authentication, cached repositories,
repository refresh, owner inventory and repository creation. The runtime and
protected `repository.operation` dispatcher share one profile-owned client.
These commands require neither a checkout nor a GitHub origin. Protected
requests still enforce access/agent/routing metadata, replay admission, scoped
operation-journal validity and rejection of unrelated peer worktrees.

The native client invokes the existing external `gh` executable directly,
without a Node helper, shell, extra authentication preflight or automatic retry
of repository creation. It preserves arguments, pagination/slurping, output
budgets (1/8/32 MiB), authentication source selection, parsing/coercion, locale
ordering, schema normalization and public failures. Creation retrieves the
resulting repository metadata only after successful creation. A shared UTF-16
wire-error type retains existing Git error imports and prevents malformed
Unicode in GitHub failures from being replaced before serialization. Native
argument conversion retains Windows UTF-16 and Unix replacement behavior.

The existing `github/repositories.json` format reopens without migration. Exact
login matching is case sensitive; malformed/missing caches return an empty list.
Successful refreshes publish through a private, uniquely owned temporary file and
atomic rename. Cache publication failure does not fail the successful query;
failed GitHub refreshes preserve the prior cache. No user authentication or
production GitHub repository is touched by the validation fixtures.

Five existing TypeScript schema roots were appended to the generated corpus.
All previous 910 roots and 13,673 nodes remain identical; the new corpus has 915
roots and 13,691 nodes. A fresh local protocol build and source-drift audit agree
with the generated graphs. Cargo.lock is unchanged.

Local validation passed 54 actual Node/native comparisons, 11 encrypted commands
through the production Rust worker/server, two existing Node catalog tests,
workspace/all-target Clippy with warnings denied, formatting and diff checks.
Direct worker and linked worker/server builds pass. The differential driver uses
the actual Node command handler and native client, comparing exact subprocess
arguments, returned values, failures, authentication environments, UTF-16 data,
output budgets, cache permissions/publication failures and reopening after a
native process restart. The workspace fixture escapes Unicode line separators
in its JSON-lines output so Node's line reader cannot split a valid JSON string.
The production Rust worker/server fixture sends encrypted catalog requests using
the `github-catalog` scope, checks metadata/creation arguments and ciphertext
boundaries, and confirms offline cache preservation after actual worker restart.
Both fixtures run native children with no Node executable in their PATH and an
owned, network-free `gh` process fixture.

This completes the catalog/authentication portion, not all GitHub integration.
Issues, pull requests, replica checkout/provisioning/synchronization, conversion,
exports/sharing and delegated OS behavior remain pending. Runtime validation in
this cycle is local macOS ARM64; Windows/Linux runtime acceptance is not claimed.
The production worker default remains Node. No GitHub Actions, deployment,
physical-device, VM or image campaign is part of this cycle.

## Native GitHub issues and pull-request search subcycle

Reference: `f6fb2000908a850429eeddd87710ece91d6ec7ef`. Delivery branch:
`agent/manual/rust-worker-github-issues`.

`github/{api,issues,search}.rs` adds six existing commands: issue and PR lists,
issue detail, issue creation, commenting and closing. The runtime's native
GitHub client serves direct commands and encrypted repository operations.
Catalog commands remain worker scoped. Repository-scoped commands use the
trusted routing repository or the checkout's current GitHub origin, overwrite
ciphertext repository/path arguments, and reject missing origins and unrelated
peers. Journal validation remains in place without adding an idle-Git-state
restriction to issue operations.

The REST path preserves repository validation, JavaScript coercion, labels,
assignees, dates, comments and schema normalization. Detail reads execute
concurrently and return the first observed failure promptly. A profile-owned
read task retains the sibling independently of its response receiver; shutdown
signals the runtime scope and drains these tasks after command admission ends.
Comment/close mutations stop after any failed or malformed response rather than
continuing with later side effects or retrying uncertain mutations. Creation
preserves title trimming, default body and empty returned comment history.
Subprocess arguments and public errors retain UTF-16 and platform conversion.

The GraphQL document is copied exactly from the current worker, with argument
bytes compared against the real Node implementation. Search preserves escaped
terms, saved views, PR-only filters, dates, opaque cursors and server-side
ordering. PR mergeability filtering scans at most ten pages, adjusts each page's
requested size by matched items and reports no misleading total. Ordinary lists
retain the provider total and one-page behavior. Review/check-state projections
and malformed/missing cursor failures retain existing contracts.

Four existing TypeScript roots were appended: issue list/detail/create and PR
summary. All previous 915 roots and 13,691 nodes remain identical. The new corpus
has 919 roots and 13,709 nodes; Cargo.lock is unchanged.

Local evidence passed 45 actual handler comparisons plus 11 fixed-clock query
cases, all 54 existing catalog comparisons, 13 encrypted production worker/server
commands and three existing Node GitHub tests. Direct and linked builds,
workspace/all-target Clippy with warnings denied, formatting, diff checks and the
fresh protocol/source audit pass. The new differential driver compares actual
Node handlers and native processes, including exact gh arguments,
Unicode/malformed values, concurrent-read failures, mutations that must stop,
filters, cursors and bounded scans. A separate fixed-clock query oracle covers
saved views and invalid issue/PR filter combinations. The catalog comparisons
are rerun because shared JSON/coercion/pagination helpers moved into `api.rs`.
The production Rust worker/server fixture exercises encrypted project operations,
checks origin authority against spoofed ciphertext arguments, preserves private
issue contents, verifies failure boundaries and rechecks origin after restart.
A held-read fixture proves that an error replies before its sibling completes;
actual worker restart retires a held sibling through owned process cleanup.
All gh calls use an owned, network-free executable with Node absent from native
child PATH; no live GitHub mutation or user authentication is used.

GitHub inbox, PR creation/detail/reviews/lifecycle/checkout, Actions/releases,
replica provisioning/synchronization and export/sharing remain pending. The
production worker remains Node. Runtime evidence is local macOS ARM64; no
Windows/Linux runtime, device/VM campaign, deployment or hosted Actions is claimed.

## Native pull-request inspection subcycle

Reference: `98e3e8b6c402f64ebe6a3002a4351125b3ef8771`. Delivery branch:
`agent/manual/rust-worker-pull-request-inspection`.

`github/pulls/{mod,parse,review}.rs` implements the complete read path of
`github.pull-request.get`: overview, files, commits, checks and combined detail.
The worker consumes the existing trusted repository/checkout routing and endpoint
protection. Its worktree verification runs the same actual Git command with the
Source output budget, through the existing owned Git process implementation.
No checkout-existence heuristic or new startup gate is added.

The reader preserves REST coercion, nullable/default fields, review/check-state
projections, latest actionable reviewer state, duplicate reviewer removal,
review threads/replies, pending review, auto-merge and merge-queue metadata,
file viewed state, warning ordering and partial-section recovery. Limits retain
Source UTF-16 slicing, including surrogate pairs split at patch/summary limits.
GraphQL documents are copied exactly from Source and their arguments are compared
byte for byte. Optional endpoint failures retain available data; malformed data
continues through the same parser/schema failure boundaries.

The profile-owned concurrent-read mechanism now accepts independent read futures.
A fatal file request can return while optional viewed-state retrieval remains
owned, matching Source's Promise.all behavior without abandoning its child.
Worker restart signals and drains that sibling before starting the replacement
runtime. Existing issue detail reads reuse this mechanism unchanged.

Five TypeScript result roots were appended. All previous 919 roots and 13,709
nodes remain identical; the corpus now has 924 roots and 13,870 nodes. A fresh
protocol build and source audit agree. Cargo.lock is unchanged.

Local evidence passed 37 actual Node/native command comparisons across all five
sections, 22 review-context/thread-group comparisons, the existing 45 issue
handler plus 11 query comparisons, and two existing Node PR inspection tests.
Exact gh and Git arguments, partial endpoint failures, optional-read ownership,
Unicode/truncation and malformed responses are covered. The production Rust
worker/server fixture passes ten encrypted project operations covering all five
sections, trusted routing against spoofed repository/checkout arguments, private
review data, partial results and actual restart with a held optional read.
Direct and linked builds, workspace/all-target Clippy with warnings denied,
formatting and diff checks are part of this delivery.

All validation uses owned Git checkouts and a network-free gh executable, with
Node absent from native child PATH. Runtime evidence is local macOS ARM64. No
user GitHub authentication, remote mutation, hosted Actions, deployment,
physical-device or VM campaign is used. The production worker remains Node.
PR creation, review mutations/lifecycle/checkout, agent context, inbox,
Actions/releases, replicas/provisioning and other worker subsystems remain pending.

## Native pull-request creation and review-actions subcycle

Reference: `e95ed316206aa80dba5565c1079b74ca2e5c0c48`. Delivery branch:
`agent/manual/rust-worker-pull-request-actions`.

`github/pulls/{create,actions,helpers}.rs` implements PR creation and all eight
review actions: comment, submit-review, inline-comment, reply, discard-review,
set-thread-resolved, set-file-viewed and update-details. The existing four direct
comment/review command aliases also dispatch natively. Protected repository
operations reuse trusted checkout/repository binding and existing write authority.

Creation runs the actual parallel Git branch checks, reads the local branch tip
and requires its exact lowercase SHA-1 to match GitHub before publishing. It
preserves slash-separated URI encoding, linked-issue order/deduplication, body
trimming, draft form type, deduplicated labels/reviewers and independent ordered
warnings after creation. Malformed create results fail before follow-up mutations;
warning schema limits apply after both optional mutations, as in Source.

Reviews preserve pending-review creation/submission/deletion, optional GraphQL
variables, exact mutation documents, thread membership checks, file viewed state,
and complete detail refresh. Detail updates retain ordered title/body, label and
reviewer changes, stopping at the first failed mutation without retrying earlier
effects. URI encoding rejects unpaired surrogates where Source does. The existing
lossless owned gh process adapter now also handles creation's Git commands. A
malformed-result comparison exposed `Number(undefined)` being serialized to null
before validation; issue/PR parsing now retains NaN for the correct schema error.

The create-result contract root is appended from the authoritative TypeScript
schema. All previous 924 roots and 13,870 nodes remain unchanged; the security
corpus now contains 925 roots and 13,873 nodes. Cargo.lock is unchanged.

Local evidence passes 50 actual Node/native comparisons across six outer command
kinds and all eight actions, checking exact Git/gh arguments, mutation order,
publication guards, Unicode, malformed responses, partial creation failures,
refresh-after-effect errors and each detail-update failure boundary. Relevant
existing comparisons also pass: 37 PR sections plus 22 review helpers, 45 issue
handlers plus 11 query cases, and 54 catalog cases. Two existing Node creation
and review tests pass. Worker all-target checks/Clippy with warnings denied,
linked server/example builds, formatting and diff checks pass.

The production Rust worker/server fixture passes 14 encrypted project operations:
creation rejection/success/optional warning, all eight review actions, foreign
thread rejection, restart/read without replaying completed remote effects and a
legacy comment alias. It verifies trusted bindings against spoofed repository and
checkout arguments and observes refreshed mutation state. Its gh process boundary
is network-free; native child PATH contains no Node executable. No real GitHub
mutation or authentication is used.

Validation is local macOS ARM64. No Windows/Linux execution, hosted Actions,
physical-device/VM campaign, deployment or full-suite rerun is claimed. Production
still selects the Node worker. PR lifecycle/checkout/agent context, inbox,
Actions/releases, replicas/provisioning and other worker domains remain pending.

## Native pull-request lifecycle, checkout and agent-context subcycle

Reference: `ff1b67f18467a43640976827b66ebbe0b971f427`. Delivery branch:
`agent/manual/rust-worker-pull-request-lifecycle`.

`github/pulls/{lifecycle,checkout,context}.rs` implements lifecycle preview/apply,
checkout preparation and agent context. Existing trusted protected repository
routing supplies the checkout, repository and read/write authority. All ten
lifecycle actions are native: close, reopen, mark-ready, convert-draft,
update-branch, merge, enable/disable auto-merge and enqueue/dequeue merge queue.

Preview eligibility, warning order and typed confirmation match Source. The
SHA-256 token hashes the exact Source JSON field ordering, normalized action,
head/base commits, mergeability, checks/review decision and auto-merge/queue state.
Apply refreshes the preview before effects and rejects stale tokens or incorrect
confirmation. GitHub mutations retain exact CLI/REST/GraphQL arguments and expected
head guards, then refresh full detail. Failed or uncertain effects are not retried.

Checkout inspects every actual remote, prefers matching origin, fetches the PR
head and verifies FETCH_HEAD against the reviewed GitHub commit. It preserves the
selected branch, HEAD and dirty files. Branch/name identity retains NFKD,
JavaScript lowercasing, slug rules and UTF-16 name limits.

Agent context selects active review threads or the first 20 failed checks. Failed
log reads deduplicate run identities, fetch at most five runs concurrently, retain
the last 100,000 UTF-16 units and bound unavailable reasons at 2,000 units.
The owned gh boundary now exposes both stdout/stderr and the existing capture
deadline mechanism for these 30-second, 4-MiB reads. Reading evidence never starts
or dispatches GitHub Actions work.

Two result roots are appended from TypeScript. Every previous 925 roots and
13,873 nodes remains unchanged; the security corpus now has 927 roots and 13,907
nodes. The existing checkout-result root is reused. Cargo.lock is unchanged and
the fresh generated-contract audit passes.

Local evidence passes 53 actual Node/native comparisons across the four commands
and all ten lifecycle actions, including exact preview tokens/arguments, invalid
eligibility, stale/confirmation guards, failed merge responses, Unicode warnings,
real local Git fetches and bounded failed-log evidence. The existing 50 creation/
review comparisons and three relevant Node tests also pass. Linked worker/server
and repository-example builds, worker all-target Clippy with warnings denied,
formatting and diff checks pass.

The production Rust worker/server fixture passes 13 encrypted project operations:
stale and confirmation rejection, refreshed close/reopen/merge, restart without
replaying completed effects, both agent-context intents, exact local fetch and
changed-head rejection. It checks trusted repository/checkout binding against
spoofed ciphertext arguments and preserves the real checkout's dirty sentinel.
All GitHub responses/logs and Git fetch sources are owned and network-free. Native
child PATH contains no Node executable. No actual GitHub mutation or hosted job
is performed.

Runtime validation is local macOS ARM64; Windows/Linux execution, physical-device
or VM campaigns, deployment and hosted Actions are not claimed. Production still
selects Node. GitHub inbox, Actions/releases, replicas/provisioning, exports/sharing
and the other worker domains in the coverage ledger remain pending.

## Native GitHub inbox, Actions and releases subcycle

Reference: `f4bcb481eeb1dc2096eed02c1b2f931783a60b3a`. Delivery branch:
`agent/manual/rust-worker-github-operations`.

The native GitHub client now serves all eight inbox views, Actions overview/run
detail/logs, workflow dispatch, run cancel/rerun/rerun-failed, exact workflow-run
checkout preparation, and release list/get/create. These ten outer commands use
the existing protected repository dispatcher and trusted repository/checkout.
Production still selects Node; replica/provisioning and other worker domains
remain pending.

`github/inbox` preserves authentication, notification access and mention-search
fallback, exact search/activity documents, cursor/total behavior, notification
ordering/deduplication, stale cutoff, rich PR state and view filtering. Activity
hydrates at most 50 unique relevant notification targets. Unknown/malformed values
follow Source's projection and validation boundaries.

`github/actions` preserves parallel workflow/run retrieval and owned early-error
siblings, optional runner access, bounded job/step/artifact projections and partial
endpoint warnings. Logs retain captured stdout/stderr even on command failure,
Source ANSI stripping, the final million UTF-16 units, availability/truncation and
live timestamps. Workflow/run mutations use the existing 8-MiB void API behavior;
non-JSON success output is accepted. Dispatch inputs use the existing native
locale collator. Checkout resolves the exact run commit and tries Source's SHA,
PR-head and branch ref fallbacks without switching the selected worktree.

`github/releases` preserves list truncation, metadata coercion and existing-tag
commit targeting with HEAD fallback for new tags. Native common projection/Git
helpers reuse shared wire values, protocol validators and owned process capture.
No new dependency or JavaScript runtime helper is introduced.

Sixteen result/helper schema roots are appended from TypeScript. Every previous
927 roots and 13,907 nodes remains identical; the security corpus now has 943
roots and 14,052 nodes. The fresh contract audit passes and Cargo.lock is unchanged.

Local evidence passes 67 actual Node/native comparisons across all ten commands,
with exact Git/gh arguments, mutation ordering, all inbox views/fallbacks, runner
restrictions, malformed data, partial run results, ANSI/captured/truncated logs,
locale input order, tag/HEAD targets and actual owned Git fetch fallbacks.
Timestamp formats/current-time windows are checked independently of structural
comparison. Four relevant existing Node tests pass. Linked worker/server/example
builds, worker all-target Clippy with warnings denied, formatting and diff checks
pass.

The production Rust worker/server fixture passes 17 encrypted project operations
covering all ten commands, trusted bindings, notification fallback, runner access,
partial detail, protected logs, void mutations, releases and checkout. A failed
overview replies with its sibling still held; actual restart retires that owned
read. The mutation trace is retained across restart to verify completed effects
are not replayed. Native child PATH contains no Node executable.

All GitHub/log responses and Git sources are owned, local and network-free. Testing
Actions functionality does not start hosted jobs. Runtime evidence is local macOS
ARM64; no Windows/Linux execution, hosted Actions, live GitHub mutation, deployment,
physical-device or VM campaign is claimed. The shared Cargo cache remains 28 GiB;
owned disposable repositories/profiles are removed after retaining small reports.

## Native replica placement and ownership subcycle

Reference: `e3792cd25a7558c96ebd673653978c2e2b3e8c00`. Delivery branch:
`agent/manual/rust-worker-replica-placement`.

The native `replicas::placement` manager implements the existing placement
mechanism: managed/direct/managed-link preparation, canonical parents, exact path
validation, staging claims/cleanup, private ownership markers, registry records,
ownership classification/verification, link creation/repair/removal, release and
forgetting. It reuses wire values, configuration paths and host private files.
This is the foundation for provisioning/synchronization/removal; those production
command adapters are not delivered by this cycle, and the outer-handler count
remains 55. Production still selects Node.

Registry parsing preserves the existing version, field order, optional values and
failure behavior. Writes serialize without poisoning the queue after rejection.
Foreign staging, replaced links and retained user storage remain untouched. Release
persists the released record before attempting marker cleanup, including when a
damaged marker makes cleanup fail. Marker/registry publication retains exclusive
private temporary files and atomic rename.

Windows path normalization preserves Node's lexical drive/UNC/namespace, trailing
separator, reserved-device and UTF-16 behavior. Windows directory links use the
Windows-only pinned `junction` 2.1.0 dependency with default features disabled.
Broken junction recognition uses its target reader; cleanup removes the directory
entry itself instead of clearing only reparse metadata. All 389 previous external
Cargo package identities/checksums remain unchanged; only this package is added.

Local evidence passes 69 actual Node/native comparisons over an owned filesystem,
comparing results, exact persisted bytes/key order, modes and link targets. They
cover all manager methods, placement modes, ownership conflicts, malformed and
symlinked registries, private markers, staging ownership, retained releases,
missing/broken/replaced links, a failed marker cleanup after durable release,
concurrent writes and queue recovery after rejection. Native fixture PATH is
empty. A focused native unit test covers 32 actual Node 24 Windows-normalization
vectors, including unpaired UTF-16; all 14 existing Node workspace-link tests pass.
Worker all-target compilation/Clippy, the native fixture build, formatting and diff
checks pass. No shared crate behavior, protocol schema or server consumer changes.

Filesystem runtime evidence is macOS ARM64. Windows path arithmetic is exercised
locally, but Windows junction/process runtime and Linux runtime were not executed.
No hosted Actions, live remote operation, full repository suite, deployment or
device/VM campaign was used. Owned fixture directories are removed; the existing
bounded Cargo cache is reused.

## Native replica provisioning and managed-link repair subcycle

Reference: `bd6f8ca38d63993a1dd6bcbb0cac281b846761e0`. Delivery branch:
`agent/manual/rust-worker-replica-provisioning`.

Two production command adapters now serve `project.replica.provision` and
`project.replica.link.repair`. The runtime resolves input routing handles, protects
result metadata and errors through the existing registry, correlates progress
with the request/job/attempt, and joins accepted work during shutdown/restart.
The outer-handler count is 57. Provisioning capabilities are advertised for exact
revisions, direct attachment, parent creation, workspace storage and managed links
when the existing actual link probe succeeds. Synchronization/removal remain
unavailable; production still selects Node.

Provisioning preserves local-only attachment, dirty-checkout rules, Primary-only
validation, GitHub origin checks, managed reuse/fetch, unborn/empty repositories,
immutable revision checkout, staging ownership/cleanup, private direct-checkout
markers, final fingerprints, placement records, links and bounded worktree-policy
reads. Per-destination queues also cover normalized repair targets and release
after rejected operations. Repair validates worker-managed storage (including
workspace UUID/location and canonical boundaries), current origin/fingerprint,
persisted ownership and the existing link before recreating only a matching claim.

The owned native clone collector preserves progress parsing, the ten-second
heartbeat, five-minute inactivity limit, two-hour duration limit, five-second
termination grace, combined 32-MiB output limit, UTF-16 tails and failure projection.
On Unix, runtime stop signals the owned process group and joins its child.
Windows uses the existing child-stop handling; complete job/tree ownership remains
a broader worker-port requirement. Native code reuses
wire values, protocol validation, host files/process primitives, workspace paths,
remote parsing/fingerprints and the existing execFile-compatible process adapter.
No dependency or Cargo.lock change is introduced.

Local evidence passes 46 actual Node/native command/state comparisons and 32
clone-helper comparisons. They compare exact gh/Git arguments/order, results,
stable progress stages/bounds, branches/refs/status, private registry/marker bytes,
filesystem modes, cleanup/preservation, all placement modes, exact revisions,
queued/rejected work, managed-link repair and workspace containment. Stream chunk
boundaries can change progress repetition; individual events remain valid and
monotonic. Three focused native tests exercise real child processes with shortened
watchdog intervals, explicit stop with open/closed pipes and the actual 32-MiB cap.
All 23 selected existing Node placement/provisioning/progress/policy tests pass.

The production Rust server/worker fixture completes four durable import jobs across
all three placement modes, real native clone/fetch, protected routing metadata,
Node-compatible persisted-path reopening, successful/idempotent repair and replaced
link preservation. It observes materializing progress in the durable job, retires
a held clone on actual restart, preserves the server's reconnect retry, explicitly
retries the resulting blocked job, and verifies completed clones/identities are
not replayed. Worker child PATH contains only the owned native tool fixtures.

The generated contract corpus adds only the existing `worktreePolicySchema` root:
944 roots, with all previous 943 roots and all 14,052 nodes unchanged. Linked
worker/server/fixture builds, worker host all-target Clippy with warnings denied,
formatting and diff checks pass. Runtime validation is macOS ARM64 with an owned
PGlite server profile; Windows/Linux runtime and other database modes were not
exercised in this cycle. No hosted Actions, live GitHub operation, full repository
suite, deployment or device/VM campaign was used. The shared Cargo target remains
28 GiB; owned repositories/profiles are removed and only small reports are kept.

The full worker replacement goal remains active. Replica synchronization/removal,
remaining project/file services, execution/history/providers, interactive resources,
data planes, native integrations, Node-free upgrade, packaging and cutover remain.

## Native replica synchronization and removal subcycle

Reference: `936b6b3099d281abb17920da835edfcbb7958eaa`. Delivery branch:
`agent/manual/rust-worker-replica-lifecycle`.

The production dispatcher now also serves `project.replica.synchronize` and
`project.replica.remove`, with existing routing metadata protection, correlated
progress and normalized per-source queues. The handler count is 59, and native
synchronization/removal capabilities are advertised. Production still uses the
Node worker while the remaining worker domains are implemented.

Synchronization preserves canonical placement/fingerprint checks, Primary-only
custom checkout validation, fetch-before-inspection ordering, clean-tree and
origin-reachability requirements, verify-only behavior, attached-branch-only fast
forward, ahead/diverged refusal and final HEAD/status verification. Git ancestry
uses the actual child exit status: exit 1 is false; other failures retain the
existing execFile-compatible error. The shared worker process adapter keeps its
previous public output/error rendering while exposing captured status internally.

Removal preserves the original storage restrictions, missing-target replay,
local-only/user-owned deletion refusal, retained ownership releases, ignored and
untracked file checks, additional-worktree refusal, published-HEAD verification,
last-moment ownership revalidation, physical deletion and matching/broken/replaced
link cleanup. Retention releases markers/records without reclaiming the checkout.
Source's worker-level deletion restriction also remains in force for workspace
storage. An optional asynchronous removal lifecycle wraps the actual guarded
operation so CodeGraph can retire/resume observations when that subsystem is
ported; native CodeGraph integration itself remains pending.

Path comparisons and missing-target results preserve JS path spelling, trailing
separators and UTF-16 independently of native OS argument conversion. Clone
inactivity now uses signed wall-clock elapsed time like Source Date.now(); duration
and grace timers remain monotonic. No schema, dependency or Cargo.lock change.

Local validation passes 56 actual Node/native lifecycle comparisons over owned Git
repositories and matching private state, exact CLI order, progress, UTF-16 path
spelling and lifecycle callback ordering. All 46 existing provision/repair command
comparisons and 32 clone-helper comparisons pass. Four focused native tests cover
wall-clock changes and owned clone lifetime/output bounds; three relevant existing
Node lifecycle/removal tests pass. Worker/example builds, host all-target Clippy
with warnings denied, formatting and diff checks pass. The production server
fixture retains its last-replica admission rule: it uses explicitly seeded offline
sibling-source metadata in an owned stopped PGlite profile before exercising real
worker synchronization/removal commands. No sibling command handler is simulated.
It passes six lifecycle jobs (verify, fast-forward, retention, managed/link removal
and reattachment), the four provision jobs, idempotent-request replay without a
second merge, and server rejection of user-owned deletion. Rust server source and
protocol artifacts remain unchanged; the previously built production server is
reused with the newly built worker. The shared Cargo cache remains 28 GiB; owned
profiles/repositories are removed and only small results are retained.

Windows/Linux runtime, other database modes and complete Windows process job/tree
ownership remain outside this cycle's runtime evidence. No hosted Actions, live
GitHub mutation, full repository suite, deployment or device/VM campaign is used.
The full worker replacement goal remains active, including remaining project/file
services, execution/history/providers, interactive resources, data planes,
integrations, native upgrade, packaging/default cutover and Node retirement.

## Local development and validation

```sh
pnpm worker:rust:build
pnpm worker:rust:check
pnpm worker:rust:test
node --import tsx scripts/worker-rust/replica-provision-compatibility.mjs --lifecycle --binary /absolute/path/to/replica-provision-fixture
node --import tsx scripts/worker-rust/workspace-smoke.mjs --replica-lifecycle-only --worker /absolute/path/to/cantrip-worker --server /absolute/path/to/cantrip-server
node scripts/worker-rust/cargo.mjs build --example replica-provision-fixture
node --import tsx scripts/worker-rust/replica-provision-compatibility.mjs --binary /absolute/path/to/replica-provision-fixture
node --import tsx scripts/worker-rust/workspace-smoke.mjs --replica-provision-only --worker /absolute/path/to/cantrip-worker --server /absolute/path/to/cantrip-server
node scripts/worker-rust/cargo.mjs build --example replica-placement-fixture
node --import tsx scripts/worker-rust/replica-placement-compatibility.mjs --binary /absolute/path/to/replica-placement-fixture
node scripts/worker-rust/cargo.mjs build --example config-fixture --example crypto-fixture --example grant-fixture --example content-fixture
node scripts/worker-rust/cargo.mjs build --example workspace-fixture --example observations-fixture
node scripts/worker-rust/cargo.mjs build --example explorer-fixture
node scripts/server-rust/cargo.mjs build -p cantrip-server -p cantrip-worker --bin cantrip-server --bin cantrip-worker --example content-fixture
node --import tsx scripts/worker-rust/github-operations-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/workspace-smoke.mjs --github-operations-only --worker /absolute/path/to/cantrip-worker --server /absolute/path/to/cantrip-server
node --import tsx scripts/worker-rust/pull-request-lifecycle-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/workspace-smoke.mjs --pull-request-lifecycle-only --worker /absolute/path/to/cantrip-worker --server /absolute/path/to/cantrip-server
node --import tsx scripts/worker-rust/pull-request-actions-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/workspace-smoke.mjs --pull-request-actions-only --worker /absolute/path/to/cantrip-worker --server /absolute/path/to/cantrip-server
node --import tsx scripts/worker-rust/pull-request-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/workspace-smoke.mjs --pull-request-only --worker /absolute/path/to/cantrip-worker --server /absolute/path/to/cantrip-server
node --import tsx scripts/worker-rust/github-issues-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/workspace-smoke.mjs --github-issues-only --worker /absolute/path/to/cantrip-worker --server /absolute/path/to/cantrip-server
node --import tsx scripts/worker-rust/github-catalog-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/workspace-smoke.mjs --github-catalog-only --worker /absolute/path/to/cantrip-worker --server /absolute/path/to/cantrip-server
node --import tsx scripts/worker-rust/config-compatibility.mjs --binary /absolute/path/to/config-fixture
node --import tsx scripts/worker-rust/crypto-compatibility.mjs --binary /absolute/path/to/crypto-fixture
node --import tsx scripts/worker-rust/grant-compatibility.mjs --binary /absolute/path/to/grant-fixture
node --import tsx scripts/worker-rust/content-compatibility.mjs --binary /absolute/path/to/content-fixture
node --import tsx scripts/worker-rust/stream-compatibility.mjs --binary /absolute/path/to/content-fixture
node --import tsx scripts/worker-rust/workspace-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/observation-compatibility.mjs --binary /absolute/path/to/observations-fixture
node --import tsx scripts/worker-rust/worktree-recovery-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/workspace-smoke.mjs --recovery-only --worker /absolute/path/to/cantrip-worker --server /absolute/path/to/cantrip-server
node --import tsx scripts/worker-rust/workspace-smoke.mjs --observations-only --worker /absolute/path/to/cantrip-worker --server /absolute/path/to/cantrip-server
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
node --import tsx scripts/worker-rust/worktree-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/folder-compatibility.mjs --binary /absolute/path/to/workspace-fixture
node --import tsx scripts/worker-rust/explorer-compatibility.mjs --binary /absolute/path/to/explorer-fixture
node --import tsx scripts/worker-rust/private-state-compatibility.mjs --binary /absolute/path/to/content-fixture
node --import tsx scripts/worker-rust/explorer-command-compatibility.mjs --binary /absolute/path/to/content-fixture
# The worktree API fixture also uses the sibling native project repository example.
node scripts/server-rust/cargo.mjs build --example project-repository-fixture
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

## Cycle 40: native encrypted source evidence

Reference: current `7fea738970b9a8fbda8fb13e68b7653ad34a9eb9` / PR #3202.
The actual `native-history-source-journal.ts`, `native-history-content.ts`,
`codex/native-history.ts`, `native-history-outbox-files.ts` and cursor tracker
are this cycle's compatibility sources. No relevant source churn intervened.

`cantrip-history` contains a real encrypted source journal, native snapshot/frame
validation, private immutable publication and item-specific cursor recovery. It
uses the shared wire/protocol/crypto/host implementations and has no server,
HTTP, database or provider dependency. The worker's `history::EncryptionService`
adapts actual authorized chat-content grants and atomic account/server snapshots.

The v1 manifest, scope-hashed directory, 16-digit record filenames, journal and
record UUIDs, source identities, ordered SHA-256 chain and exact JSON bytes remain
compatible. Source hashes deliberately preserve parsed property order; they are
not sorted canonical archive digests. Historical key revisions reopen using the
six distinct existing history encryption domains. Payloads remain encrypted on
disk. Source evidence has no consume, prune or server-ACK operation.

Each canonical directory has a process-local FIFO queue across independently
opened handles. Enqueue snapshots caller data synchronously; accepted IO survives
response abandonment, completes publication before the successor, and does not
poison successors on errors. Recovery discovers only existing journals, loads one
journal per yield, filters owner/server/worker scopes, skips known journals, honors
cancellation and isolates damaged siblings without inventing replacement IDs.
The async execution owner must drain accepted work before runtime shutdown.

Nine additional roots / 184 nodes are generated from the actual exported worker
schemas into `native-history-source.json`; the existing 944 security roots and
14,052 nodes remain unchanged. Two native refinements retain the exact u64 and
live-item snapshot-boundary rules. Existing TypeScript changes only expose those
schemas and name the existing page-limit validator. No external Cargo package
identity/checksum changed.

Validation on macOS ARM64: 97 real Node/native comparisons cover parsed values and
Zod issues, six encryption domains in both directions, UTF-16 and Unicode line
separators, BOM behavior, historical keys, cross-language creation/reopening,
bounded pages, durable identity and actual native-process restart, duplicate and
conflicting frames, FIFO separate handles, response abandonment, owner changes,
missing/corrupt/replaced records, real disk obstruction/repair and recovery
isolation. Fourteen relevant existing Node tests and two focused native
publication/queue tests passed. Worker/example builds, host all-target Clippy with
warnings denied, affected Rust server compilation, formatting and diff checks
also passed. The fixture child has a system-only PATH.

This is source persistence, not completed execution/history delivery. Runtime
observation/capture and its retry owner, reducers, projections/checkpoints,
prepared-batch outboxes, attachment materialization, server publication and
acknowledgments remain pending. It adds no outer command or capability and does
not change production selection. Windows/Linux runtime behavior was not exercised;
Windows keeps file-only fsync, as in the current worker. No hosted CI, device QA,
container build or deployment was used.

## Cycle 41: native history state reduction

Reference: current `56ef01ab052330618ff4dcd12a429524df36f0a6` / PR #3203.
This cycle ports the complete current `native-history-reducer.ts` and
`native-history-state.ts` contracts into `cantrip-history::reducer`, reusing the
source journal, wire values and generated protocol validation. No relevant
worker/server source churn intervened.

The implementation preserves canonical/legacy item separation, all turn/item
revisions and ordinals, historical prefix insertion without deleting live-only
entries, raw unknown evidence, source replay suppression, native u64 cursor
ordering, predecessor gaps and cross-runtime uncertainty. It retains live
assistant text, command output, sparse reasoning summaries and file patches
through late snapshots; item completion remains independent of turn completion.
Terminal notification evidence outranks provisional snapshot interruption,
measured times remain distinct from missing values, and conflicting completions
or immutable settings/model attribution remain explicit. State parsing and return
use the actual v1 worker schema. Object-key order remains byte-compatible;
JavaScript deep equality preserves signed zero and real string-coercion errors.

The worker-local graph now has 11 roots / 243 nodes, including the exact state
schema and an alias to the existing shared initial-turn-settings schema. The
prior nine roots / 184 nodes remain identical, including indices; the separate
944-root / 14,052-node security graph also reproduces unchanged. The exporter can
register a local recursive JSON leaf through the existing validator, avoiding a
second JSON/schema engine. The TypeScript service only exposes its existing
state-body schema for that development export. No Cargo dependency changed.

Local evidence on macOS ARM64:

- The original 21 Node reducer tests plus seven focused boundary tests execute
  both implementations: 70 full-state/error comparisons, exact JSON bytes and a
  fresh native process for every transition. The original suite's existing
  expectations also run on the native result. The comparison owner asserts that
  the native path actually ran; failures cannot silently become reference-only
  tests.
- The real encrypted source-journal fixture passes 100 comparisons, including
  incremental native reduction and serialized state reuse after actual process
  restart. It advances no committed projection cursor and sends no model input.
- Four focused native tests cover immutable publication/FIFO and signed-zero
  state behavior. Worker/example builds, all-target worker/history Clippy with
  warnings denied, affected Rust server compilation, formatting and diff checks
  pass. Native children use a system-only PATH. No hosted CI, paid providers,
  containers, devices or deployment were used; Windows/Linux runtime was not
  exercised.

The production worker remains Node and the real native outer handler count
remains 59. This is a complete pure reducer, not completed history delivery.
Observation/capture/retry orchestration, canonical item resolution and rendering,
projection/checkpoint/rebase transactions, prepared-batch outboxes, attachments
and publication/ACK recovery remain pending, followed by provider/runtime
execution and the rest of the full worker replacement.

## Cycle 42: native durable history outbox

Reference: current `04c23a20864c7be8c243413e53532f701dd8291c` / PR #3204.
This cycle ports the complete `native-history-outbox.ts`, baseline, record,
mutation and rejection-verification behavior. No relevant source churn intervened.

`cantrip-history::outbox` implements all current storage operations: open/recover,
append, pending, authenticated-body opening, committed receipt lookup, canonical
ACK persistence, permanent-rejection replacement and supersession lookup. The
scope-hashed v1 stream identity, original encrypted bytes, record identities and
hash chains remain compatible. Older batch files remain a fixed immutable prefix;
new appends and complete pending-tail replacements share one exclusive mutation
slot. A collision is an actual publication failure: retry uses the same captured
request, sees the winner and never drops a newly appended dependent tail.

Recovered baselines preserve original stream/commit identities and canonical
payload digests, including older archives with explicit missing source. Existing
committed files prevent creating a replacement identity. Recovery runs only for
a genuinely absent local stream, requires caller-supplied complete authenticated
archive data, rechecks identity after its actual callback and never fabricates
batch ciphertext. ACKs correlate stream/sequence/record/digest and remain
contiguous; lost responses keep the exact batch pending. When supplied, the expected local
body must match byte-for-byte; recovered receipt bodies use the existing
canonical content digest. Rejected and superseded bytes
remain encrypted in the ledger.

The canonical-directory queue now owns async recovery as well as blocking IO.
Abandoning a response does not release its queue slot or cancel accepted work;
an error cannot poison the next operation. The worker owner must drain accepted
work before runtime shutdown, as before. The outbox has no execution or network
authority and no implicit pruning operation.

Local validation on macOS ARM64:

- 97 actual Node/native outbox comparisons cover native writes reopened by Node,
  Node mutations read by Rust, historical keys, frozen retries, contiguous and
  conflicting ACKs, authenticated rejection matching, replacement/supersession,
  actual native-process restart, baseline recovery, legacy files, storage
  obstruction/corruption/repair, scoped identities and callback failure/retry.
- A controlled actual native/Node cross-process race pauses a synthetic granted
  key lookup after the native ledger view is captured. Node wins the next
  immutable slot; Rust reports the collision and its same-request retry retains
  the actual concurrent tail. This is a development fixture only; production
  code has no test gate or deterministic entropy mode.
- All 21 existing Node outbox tests pass. Five focused native tests pass, including
  async FIFO/error settlement after response abandonment. The prior 100 source
  journal/crypto/reducer comparisons also pass after the queue change.
- Worker/example builds, all-target worker/history Clippy with warnings denied,
  affected Rust server compilation, formatting and diff checks pass. The previous
  11 history roots / 243 nodes and separate 944 security roots / 14,052 nodes
  reproduce unchanged; seven exported actual outbox schemas add 57 nodes for an
  18-root / 300-node history graph. No Cargo dependency changed.

No GitHub Actions, paid provider runs, containers, device QA or deployment were
used. Native fixture children have a system-only PATH. Windows/Linux runtime was
not exercised; existing Windows file-only flushing behavior remains. Owned
profiles, helper barriers and worktree artifacts are removed after delivery.

This completes the outbox ledger, not the history pipeline. The production
worker remains Node and native outer handlers remain 59. Projection/checkpoint/
rebase transactions, authenticated history clients and delivery pumps, canonical
identity/rendering/protection, attachments, capture/recovery orchestration and
native execution remain pending. They must use these real storage APIs before
packaging/default cutover can complete the full goal.


## Cycle 43: native durable projection and rebase transactions

Reference: current `2c5365e78ffe68a175b4bc487dcb1059ea207b1d` / PR #3205.
This cycle ports the complete transaction behavior of
`native-history-projection.ts` and `native-history-projection-rebase.ts`, using
real `cantrip-history` source journals and outboxes. Relevant source and contract
changes on current origin/main were inspected; no churn intervened.

`projection::Projection` freezes encrypted state and prepared batches before
outbox append or delivery. It advances a source cursor only after all frozen
batches have correlated canonical receipts, including empty reductions. Retries
and reopened handles retain original batch IDs, bytes and source ranges. A
canonical ACK followed by a local commit failure is repaired from the durable
outbox receipt without resending or reducing again.

Only a distinct verified permanent-rejection error selects rebase. An encrypted
frozen plan precedes outbox replacement; accepted prefixes remain independently
verifiable, replacements get fresh identities, and repeated plans retain the
original source page and the last frozen pending state. A restart resumes a
saved plan without recomputing it. Ordinary 409/transport failures propagate.
Manifest/source/outbox scope and UUID identity, stage and rebase hash chains,
range continuity, supersession and canonical commit receipts are checked against
actual files. Missing identity or inconsistent state never creates a new epoch.

The owning FIFO serializes projection operations across local handles and keeps
accepted work running after response abandonment. Explicit runtime cancellation
retains its actual reason and can stop after a remote commit before local ACK;
a fresh owner retries the same pending record. The callback owner supplies pure
canonical projection/rebase and authenticated delivery with in-flight cancellation.
No callback here has authority to dispatch native input.

Local validation on macOS ARM64:

- 74 actual Node/native comparisons cover encrypted transactions in both
  directions, immutable lost-reply retries, multi-batch partial commits,
  commit-path failure/repair, saved rebase-plan recovery after actual outbox
  publication obstruction, repeated permanent rejections with accepted prefixes,
  native-process restart, explicit cancellation, response abandonment, scoped
  identity replacement and damaged/missing transaction records.
- The receiver is a durable controlled callback, not production HTTP. Both
  implementations use their real journals, crypto, outboxes and projection code.
  Node resumes native frozen plans with project/rebase callbacks that fail if
  called, proving those plans are not recomputed.
- Six selected existing Node integration tests pass, covering real canonical ACK
  recovery, complete outbox loss, repeated rebases, partial commits, local commit
  repair and serialization across separate handles. Other tests in that file were
  intentionally not run.
- The prior 100 source and 97 outbox comparisons pass, including the actual
  cross-process mutation collision. The 28 original reducer tests pass through
  the native differential adapter; five native history unit tests pass.
- Worker and fixture builds, all-target history/worker Clippy with warnings
  denied, affected Rust server compilation, formatting and diff checks pass.
- Seven exact exported projection/rebase schemas extend the history graph from
  18 roots to 25 roots / 422 nodes. Correct local workspace protocol imports
  deduplicate schema identities and reindex node/name metadata. Fully expanded
  contracts for all previous 18 roots remain semantically identical, ignoring
  names and node numbering. The separate security graph reproduces byte-for-byte
  as 944 roots / 14,052 nodes. No Cargo dependency changed.

No GitHub Actions, provider charges, containers, physical devices or deployment
were used. Native fixture children run with a system-only PATH. Windows/Linux
runtime behavior was not exercised. Owned test profiles and worktree dependency
links are removed after delivery.

The production worker remains Node; native outer command handlers remain 59.
This completes local projection transactions, not the full history pipeline.
Authenticated HTTP clients/recovery, canonical ID resolution/rendering/protection,
attachments, retry/capture/archive orchestration and native runtime execution
remain pending, followed by the other worker domains and packaging/Node retirement.


## Cycle 44: authenticated native history HTTP client

Reference: current `72514035dfd12119b3e3ff2c92473a6822085dd6` / PR #3206.
This cycle ports `native-history-client.ts`, its metadata recovery policy and
batch-archive validation. The current Node implementation and relevant server
contracts were inspected; no intervening source churn was present.

`cantrip_worker::history::client::Client` implements all seven public operations:
open binding, resolve items, ingest, deliver, archive items, archive turns and
archive batches. It uses actual native HTTP with the current credential on every
attempt, preserves the parsed request body, rejects redirects and validates exact
response schemas. Canonical receipts must match stream, sequence, record and
digest. Only a verified, request-matched permanent rejection constructs the
history transaction engine's typed rejection; an ordinary 409 remains an HTTP
error. Arbitrary response bodies never enter HTTP diagnostics.

Only idempotent open/resolve metadata retries HTTP 408/429/5xx and fetch failures,
using the current 30-second deadline and 250ms exponential backoff capped at 2s.
Ingestion/archive requests do not retry implicitly. Caller cancellation and the
metadata transport lifetime stop actual in-flight waits. Cancellation during
backoff retains Node's distinct AbortError wrapper and original cause. Already
aborted inputs retain input order; later cancellation races retain the first
actual parent/deadline. Public requests reuse `cantrip-transport::lifecycle::owned`
so abandoning a result cannot cancel accepted publication. Runtime shutdown must
still finish or explicitly cancel owned work.

Archive readers correlate binding, chat, worker, snapshots, page bounds and next
cursors. Item keys, contiguous per-stream batch sequences and protected batch
payload digests are checked. Turn pagination uses PostgreSQL C/UTF-8 byte order,
including its difference from UTF-16 ordering. Legacy explicit missing batch
source remains null. Coherent multi-resource archive collection/decryption and
production capture/retry orchestration remain separate work.

Local validation on macOS ARM64:

- 56 actual loopback HTTP comparisons against the unchanged Node client cover
  all operations, exact requests, metadata retries/token rotation, network loss,
  unrelated binding/mapping/receipt/rejection data, malformed/private response
  bodies, gzip/BOM, redirects including an invalid Location, archive ordering and
  integrity, cancellation and accepted request survival after response abandonment.
- A focused actual Rust-server/PGlite run uses native projection, source journal,
  outbox and HTTP delivery. A local proxy drops the first successful canonical
  ingest response after the upstream commit. The local checkpoint stays at zero;
  both the native process and actual Rust server restart; the saved transaction
  retries identical bytes and obtains the identical receipt. Exactly one canonical
  batch exists and the local checkpoint advances once. All three native archive
  readers match the Node reference and an invalid credential is rejected.
- That smoke uses reference canonical content preparation and a controlled
  enrollment/control worker. It does not prove production provider/capture
  execution or final Node-free packaged operation. Expected unsupported-command
  diagnostics from that controlled worker are not production capability evidence.
- The 74 projection regression comparisons, five original Node metadata-recovery
  tests, three native cancellation/deadline/cause tests and five native history
  unit tests pass. Worker/client/history fixture builds, actual Rust server and
  repository fixture builds, all-target worker/history Clippy with warnings denied,
  formatting and diff checks pass.
- Two exact protocol result-wrapper exports extend the history graph to 27 roots /
  443 nodes. All previous 25 roots and 422 nodes are unchanged, and the separate
  944-root / 14,052-node security graph reproduces byte-for-byte. The sole Cargo
  graph addition is the existing internal transport crate as a direct worker
  dependency; every package identity/version/source/checksum remains unchanged.

No hosted Actions, paid providers, containers, physical devices or deployment
were used. Native fixture children use a system-only PATH; disposable PGlite and
history profiles are removed. Windows/Linux runtime behavior was not exercised.
The production worker remains Node and native outer handlers remain 59.

Next history work includes native canonical identity/rendering/protection and
attachments, coherent archive recovery, capture/retry pumps and actual runtime
integration. These are followed by the remaining execution/provider, terminal,
transport/browser/OS/helper and packaging/default-cutover/Node-retirement work.


## Cycle 45: native protected history content and coherent recovery

Reference: current `a1cd719592a9d17834fcb75cec357e5d261e3e64` / PR #3207.
This cycle ports full item-evidence and turn-metadata codecs, canonical prepared
items/messages, archive opening and coherent recovery from their current Node
implementations. Current origin/main and relevant contracts were inspected; no
intervening source churn was present.

`cantrip-crypto::content::Communication` implements the six existing protected
communication formats: messages, queued prompts, composer drafts, plans and
interaction requests/responses. It preserves the exact table/field/row domains,
plaintext schemas/refinements, public classification matching and encoded limits.
It uses the existing maintained payload/KDF implementation and system entropy.
No new runtime or Cargo dependency is introduced.

`cantrip-history::canonical` seals/opens complete reduced item evidence and turn
metadata, prepares full native turn observations and canonical prepared items,
and protects/opens messages. Original GUI message ciphertext remains exact while
transformed native evidence is protected separately. Item/turn AAD retains owner,
server, source binding, historical identity and revision. Turn analytics and public
chronology are authenticated, with legacy omission retaining the old AAD. Timestamp
multiplication overflow is rejected before JSON serialization can normalize it.

The existing server's pure usage reconciliation is shared in `cantrip-protocol`;
server and worker supply their existing locale comparator. Server ingestion SQL,
accounting and authorization stay in their original adapter. Worker extraction
keeps immutable model attribution, filters copied ancestor usage, deduplicates
response IDs and retains conflicts/overflow rather than inventing totals.

`cantrip-history::archive` opens item, turn and accepted-batch candidates with
original evidence bindings and explicit missing source. Older evidence remains
separate from canonical revision/currentness; no winner is inferred across workers.
The HTTP client reuses the same authenticated batch-content validation.
`cantrip_worker::history::recovery` collects all paginated resources under one
committed snapshot before decrypting. A real snapshot-changed 409 discards the
partial collection and retries; other errors propagate. Cancellation stays live,
reporting errors are ignored and recovery grants no input/checkpoint authority.

Local validation on macOS ARM64:

- 102 actual Node/native comparisons cover all six communication formats in both
  directions, private item/turn/message interoperability, context/revision/tamper
  failures, historical keys, encoded limits/refinements, retained GUI ciphertext,
  complete native source and chronology, turn analytics AAD, timestamp overflow,
  existing usage-reconciliation cases and archive missing-source/cancellation.
- Six actual loopback HTTP recovery scenarios compare complete values and exact
  request sequences: multi-page success, changed-head retry, permanent rejection,
  unrelated binding, decryption failure and in-flight cancellation. A discarded
  partial page intentionally has invalid ciphertext; successful retry proves no
  premature decryption. Reporting deliberately fails without stopping recovery.
- The actual Rust-server/PGlite smoke now performs native item/message/turn
  preparation and coherent plaintext recovery in addition to native source,
  projection, outbox and HTTP delivery. A real canonical ACK is lost, both native
  and server processes restart, exact frozen bytes retry and exactly one canonical
  batch remains. All three archive readers and complete recovery match Node; only
  endpoints see the private marker. Rendered input and the enrollment/control
  worker remain fixtures, not production capture/provider acceptance.
- The 56 HTTP-client and 74 projection regression comparisons pass. Twenty
  selected original Node turn-content, preparation and usage tests pass, as do
  five native history and three metadata lifetime unit tests. Native crypto has
  no separate library unit cases; its codecs are exercised by the interoperability
  fixtures. Worker/examples and affected server/repository example builds,
  all-target worker/history/crypto/protocol Clippy, formatting and diff checks pass.
- Seventeen existing protocol contract files remain unchanged; the security
  graph reproduces byte-for-byte. A separate graph adds 26 actual plaintext roots /
  640 nodes, with no root-name overlap. It is generated from authoritative protocol
  and worker schemas; no validation is replaced by an approximate JSON shape.

No hosted Actions, provider charges, containers, physical devices or deployment
were used. Native fixture children use a system-only PATH. Disposable profiles
are removed; the shared build cache remains approximately 28.5 GiB. Windows/Linux
runtime was not exercised. The production worker remains Node and installed
native outer command handlers remain 59.

Next work is native rendering/canonical projector and identity orchestration,
attachment materialization, capture/retry pumps and runtime execution integration.
The remaining provider, terminal, transport/browser, OS/helper, upgrade and
packaging/default-cutover/Node-retirement requirements remain part of the goal.


## Cycle 46: native retained-item rendering and activity normalizers

Reference: current `2d8d1d53ce5e158fea8ab41592c30f858d897527` / PR #3208.

`cantrip_worker::history::render::item` now implements the full retained-item
renderer and pinned display-item rules. It preserves canonical/legacy identity,
exact assistant text and phase, independent item lifecycle, child-agent scope,
conflicts and unresolved notices. Authorized input/output parts are supplied by
index; rendering reads no files, reserves no canonical IDs and dispatches no
native input. Opaque agent communication and unsupported media remain explicit
without exposing their private payload in display content. Full source evidence
is returned independently of presentation.

`cantrip_worker::native_items` implements the existing thread-item activity
normalizer for command/file/plan/reasoning, MCP/dynamic/collaboration tools,
subagents, web search, image view, review and compaction. The public normalizer
retains independent timestamps, command telemetry/status overrides and file-change
previews. It is reusable by later live execution adapters; this does not yet
integrate native event subscriptions or complete turn/session normalization.

Command tails retain the original VT/control stripping and UTF-8 bound while
transcript previews use their distinct UTF-16 limit. History then restores exact
full command output and plan text. Raw trajectory capture uses its own existing
redaction policy, image omission, depth bound, binary-document digests and
independent request/response byte limits. Parsed JSON RPC documents and explicit
binary bodies use separate native inputs; there is no JavaScript object runtime.
Explicit undefined fields constructed by the Node capture helper retain their
`"undefined"` text. Truncation preserves TextDecoder BOM behavior; an untruncated
string retains its original UTF-16, including lone surrogates.

The independently generated `native-history-render.json` supplies five actual
shared presentation roots / 408 nodes. Existing graph files are unchanged.
`cantrip-wire::coercion::entries` exposes the existing object-entry ordering
without changing its implementation. No Cargo dependencies, shared TypeScript
contracts, Node worker implementation, server routes or database modes changed.

Local validation on macOS ARM64:

- 219 actual Node/native comparisons cover every supported retained item and
  lifecycle, authorized child/input materialization, conflicting/unknown evidence,
  tool errors, redaction, command tails, file previews, Unicode and encoded bounds.
  Rendered messages pass the real content codec in both directions. Comparisons
  of optional undefined helper fields use their actual JSON serialization boundary.
- 42 unchanged original renderer, file-preview, CUA raw-capture and selected
  app-server tests pass through a native differential adapter: 91 real native
  calls, each in a fresh process. The 77 unrelated app-server tests are filtered,
  not reported as passing.
- All 102 protected-content/preparation/archive comparisons pass again.
- The real Rust-server/PGlite history check now renders natively before content
  preparation, encryption, outbox/projection and HTTP ingest. A proxy drops an
  actual successful ACK; server and native processes restart; frozen bytes and
  receipts match on retry and exactly one canonical batch remains. All three
  archive readers and coherent plaintext recovery match Node. Unauthorized
  credentials fail and the private marker is absent from server/proxy diagnostics.
  Source observations and enrollment/control are fixtures; production capture,
  canonical projector orchestration and provider execution are not exercised.
- Worker/source/client-fixture and actual server/repository-fixture builds pass,
  as do worker all-target Clippy with warnings denied, four existing wire unit
  tests, Rust formatting and diff checks. No hosted development Actions, paid
  provider, device/VM/container campaign, signing or deployment was performed.

Production still selects Node and installed native outer handlers remain 59.
Canonical projector/ID orchestration, attachment materialization and capture/retry
runtime integration are next, followed by the other execution/provider, terminal,
transport/browser, OS/helper, upgrade and packaging/Node-retirement requirements.
Windows/Linux runtime validation was not performed. The full replacement goal
remains active.


## Cycle 47: native canonical projector, archive bootstrap and source replay

Reference: current `37e49f84ee65c0281be1f6cf4df0c21598d57363` / PR #3209.

`cantrip_worker::history::projector` now implements the actual reduced-source to
canonical-publication step. It reuses native reduction/rendering, content
preparation, usage attribution and the authenticated history HTTP client. The
existing durable `Projection` still owns encrypted stages, immutable retry bytes,
canonical receipts, rebase plans and source checkpoints.

The projector selects verified context before reservation, resolves a page of
identities before authorized attachment I/O, retains preserved GUI ciphertext
exactly and chooses expected revisions from the saved observation basis. Saved
fingerprints skip unchanged plain items; restored source fingerprints preserve
unchanged canonical UI and terminal publications. Revisions live in returned
state rather than mutable process counters. Item-count/four-MiB batching retains
indivisible large evidence. Repeated snapshot record IDs remain local evidence
without resealing semantically unchanged turn metadata.

Adapters supply preparation, optional first-stage bootstrap, verified context,
authorized materialization and admitted provenance; each receives independent
owned values. The real `Client` implements the narrow identity-resolver interface.
Project calls retain accepted async work after response abandonment, while the
owning runtime's explicit signal supplies cancellation. These APIs grant no
execution permission and never dispatch native input.

`projector::bootstrap::restore` reconstructs source and publication floors from a
complete authenticated recovery snapshot. All accepted item revisions contribute
to their identity's floor; only this binding's turn counters contribute to local
turn floors. Counters do not select a foreign body. Legacy/v2 turn sources,
missing/stale item source, exact terminal observations, conflicting components,
metadata consensus/context union, evidence identity and UTF-8 chronology retain
the existing rules. It reuses the existing signed-zero-aware JSON equality from
`cantrip-history::reducer`, now publicly exposed without algorithm changes.

`projector::rebase::recover` reads the coherent archive through the authenticated
client, restores floors and replays every retained source record through the
rejected page's fixed endpoint. Missing ranges or a changed endpoint fail. Pure
replay precedes one preparation pass. A separate replay entry point accepts an
already authenticated snapshot for the same orchestration.

The independent `native-history-projector.json` graph exports four actual
projector/object/turn-content/status roots / 79 nodes. Existing generated graphs
and Cargo dependencies are unchanged. The Node bootstrap module adds only a
development export of its existing v2 content schema. Production still selects
Node and installed native outer handlers remain 59.

Local evidence on macOS ARM64:

- 104 actual Node/native comparisons cover full revision/fingerprint state,
  authenticated plaintext batches and callback order; preserved GUI bytes,
  materialization ordering, restored/stale publications, saved revision bases,
  batching, repeated evidence, callback object-spread semantics, cancellation/
  failures and bootstrap consensus.
  Fixed-endpoint replay reads actual interoperable encrypted journals. Snapshot
  inputs include the real capture identity/barrier fields.
- One unchanged existing history integration test consumes native-restored
  state: two exact Node/native state/JSON-order comparisons. The other 27 tests
  in that file are filtered rather than reported as passing.
- All 74 durable transaction comparisons and five native history library tests
  pass, including repeated rebases, accepted prefixes, process restart, queue
  ownership, exclusive publication and signed-zero equality.
- The actual Rust-server/PGlite check now feeds retained snapshots into the
  native reducer/projector instead of supplying prepared batches. It validates
  the resulting full checkpoint against Node, loses an actual successful ACK,
  restarts server/native processes and retries frozen bytes with one canonical
  batch. Archive recovery and native bootstrap match Node.
- A second worker enrolls through HTTP. Owned placement/session fixture rows are
  seeded through the native repository helper while the server is stopped; its
  history binding is then opened through the real authenticated endpoint. After
  its native projector commits canonical revision 2, the first worker gets an
  actual matched `item-revision-conflict`. Native HTTP recovery, bootstrap,
  retained-source replay and durable replacement commit revision 3 from basis 2.
  Exactly one rebase/rejection occurs, three accepted batches remain and no local
  outbox is pending. Complete recovery again matches Node and the private marker
  is absent from proxy/server diagnostics.
- Worker/source/client and actual server/repository-fixture builds, worker
  all-target Clippy with warnings denied, Rust/script formatting, diff and
  file-size checks pass. No hosted development Actions, paid providers,
  physical devices, VM/container campaign, signing or deployment are involved.

The integration's source observations, context/materialization/provenance
callbacks, keys and enrollment/control worker remain controlled fixtures. It is
not production capture/provider acceptance. Verified turn-context/attachment
adapters, live output identity, capture subscriptions and managed recovery pumps
remain, followed by the other execution/provider, terminal, transport/browser,
OS/helper, upgrade and packaging/default-cutover/Node-retirement work.
Windows/Linux runtime validation was not performed. The full goal remains active.

## Cycle 48: verified retained context and durable attachment adapters

Reference: current `9f839f5fdd5feeb13f0b3fcaab9da58a9db4c6e7` / PR #3210.

The worker now supplies `history::adapters::Verified` for the real canonical
projector. It checks the exact source binding and account/server identity before
creating adapters. The independent context index captures a finite journal head,
reads bounded pages beyond the current projection page and retains conflicting
evidence. Failed refreshes can retry without moving a receipt-backed cursor.
Missing context is a typed projection deferral, never an input/admission gate.
Historical cwd/mode/root attribution comes from retained evidence. Child scope
uses immutable binding ancestry and all retained parent evidence; newer labels
cannot erase a conflicting parent.

`attachments::Store` implements the existing chunked upload, complete, read,
abort, remove and path behavior, including expected-size/hash verification,
operation identity, EOF rules, empty streams and filename normalization. Logging
accepts the worker log adapter. Its production `content::ServiceKeys` selects
the actual attachment-content grant, independently of chat-content. Metadata
opening requires the current attachment key revision, as the Node helper does.

`history::attachments::Store` flushes ordinary file bytes before publishing an
immutable opaque descriptor. Stable identity excludes worker/binding relocation
fields. A separate immutable published descriptor supersedes a local candidate
without replacing that candidate; authenticated committed ciphertext is reused
exactly on later opens. Missing or damaged bytes are restored and malformed
retained metadata remains a failure.

The input materializer preserves media positions and text references, imports
only defined native media fields, and never fetches remote URLs or follows
assistant/tool saved-path hints. Local user media uses its retained cwd and
opened-file type/actual-byte limits. Unix nonblocking open prevents FIFO hangs.
Retained copies survive original source edits; a lost retained copy cannot adopt
changed original bytes. Inline base64 is strict, MIME retains UTF-16 semantics,
and temporary byte buffers are zeroized. Archive attachment lookup is lazy and
shared across an item's parts.

The shared history FIFO is now public without changing its algorithm. Media
manifest operations use caller-selected lexical keys; context indexing uses a
separate queue to avoid waiting on its own journal read. Two actual schema roots
/ 23 nodes are exported independently in `native-history-adapters.json`.
The Node context module adds only an export alias of its existing array schema.
No Cargo dependencies or existing generated graphs change.

Local evidence on macOS ARM64:

- 107 focused compatibility comparisons use actual Node algorithms and native
  recovery assertions: real files, metadata cross-opening,
  immutable descriptor adoption/relocation, malformed manifests, empty and
  multichunk streams, concurrent handles, byte restoration, local source edits,
  inline/tool/generated media, UTF-16 MIME, regular-file/FIFO and byte limits,
  finite paged contexts, failed refreshes, integrity boundaries and child scope.
  Native fixture processes run with a PATH containing no Node executable.
- The complete verified-media projector matches Node's revision/fingerprint
  state and authenticated canonical message content over an actual encrypted
  source journal. Both implementations reopen the same retained descriptors.
- All 16 existing focused attachment/context/media reference tests, two native
  context cancellation/deferral unit tests, five shared history library tests
  and 104 existing projector comparisons pass.
- The actual Rust-server/PGlite history integration now uses the real verified
  context adapters for projection and rejection recovery. Lost ACK, process
  restart, exact frozen retry and one actual revision-conflict rebase still pass:
  three accepted batches, final item revision 3 and no pending local outbox.
- Worker/source/client and actual server/repository-fixture builds, worker
  all-target Clippy with warnings denied, formatting and diff checks pass.

Source observations, encryption keys and the enrollment/control worker remain
controlled fixtures. The second integration writer uses the earlier controlled
projector callbacks explicitly; its actual server revision supplies the rejection
for the first writer's verified native recovery. This is not production capture
or provider acceptance. Windows/Linux runtime validation was not performed.
No hosted development Actions, devices, paid providers, VM/container campaign,
signing or deployment were used.

Production still selects Node and native outer command handlers remain 59.
Next work is live output identity, capture/subscription and managed retry/recovery
orchestration, followed by execution/providers, terminals, transports/browsers,
OS/helpers, upgrades, packaging/default cutover and Node retirement. The full
goal remains active.

## Cycle 49: live identity, original mode and independent source capture

Reference: current `f98e3b085c807cfa5c439bf696951ee02be51de1` / PR #3211.

`history::live` now ports the actual output-identity, original-mode,
transport-observation and source-capture implementations. These APIs neither
admit native input nor grant execution/CUA authority. Production worker selection
and the 59 installed native outer command handlers remain unchanged.

The observation hub owns transport generations and sequence barriers. It captures
thread-scoped unknown/late notifications before normalization, validates cursors
with the existing native cursor contract, isolates consumer values and reports
consumer failures without raw parameters. Replacement retires old subscriptions;
read snapshots retain both the start barrier and completion sequence. Atomic snapshot
boundaries prevent native threads from crossing replacement/close notification
intervals. Reentrant replacement cannot deliver an old frame to a new subscriber.

`capture::Capture` subscribes synchronously and runs independent read, ordered
append and coalesced projector-wake jobs. It retries actual failures with bounded
backoff and repairs per-item predecessor gaps using the existing cursor tracker.
A stale successful snapshot does not prove recovery. An explicit snapshot waits
for a read begun for its own request and for its durable source header. Uncertain
successful writes retry the exact captured frame. Storage never serializes native
input or snapshot observation behind its retries.

Graceful close detaches observation and drains accepted records and wakeups.
Forced stop rejects drains and reports unsaved memory accurately. In-flight append
and wake callbacks finish before `when_stopped` resolves; a detached native read
cannot enqueue more data and does not retain that teardown boundary. Timer jobs
claim their busy state atomically, including on the multithreaded worker runtime.

Bound output resolvers cache immutable successful identity mappings per sealer
lifetime and retry failed lookups. They validate unique related mappings and
preserve root/child output association. The managed resolver requires dispatched
scope, shares binding opens and selects canonical identity only from real item
correlation. Original mode comes from retained turn context, never current GUI
settings. Missing context can wait for actual history changes; closed/replaced
observations reject that wait. This delays publication rather than native input.
Successful mode reads share a per-thread/turn cache; failures remain retryable.
Shared failures retain causes and important native wire/cancellation/HTTP types;
`ServerRequestError` adds `Clone` without changing HTTP behavior.

Local evidence on macOS ARM64:

- 81 focused compatibility comparisons use actual Node implementations and native
  recovery assertions over real encrypted journals. They cover snapshot barriers,
  transport retirement, failure isolation, disk obstruction/recovery, uncertain
  acknowledgements, held reads/storage/wakeups, fresh snapshot requests,
  graceful/forced teardown, stale gap reads, mapping caches and original-mode waits.
- All 26 existing observation/capture/output-identity reference tests and three
  native unit tests pass. The native tests exercise two-thread writer ownership,
  reentrant replacement and scheduling bounds.
- All 56 actual loopback HTTP client comparisons still pass, including metadata
  retry, cancellation, compression and response abandonment.
- The real Rust-server/PGlite integration now obtains its initial source record
  through the native observation/capture jobs, then runs native verified context,
  reduction/projector, encryption, outbox and canonical HTTP publication. Lost
  ACK, restart/frozen retry and actual revision-conflict recovery still produce
  three accepted batches, final item revision 3 and no pending local outbox.
- The native managed live-output resolver opens/resolves through the real server.
  Concurrent outputs share exactly one open and one resolve, match the actual
  Node resolver's ID/idempotency/mode, and preserve a real HTTP 401 classification.
- Worker/live/source/client builds, all-target worker Clippy with warnings denied,
  formatting, diff and native-file-size checks pass. There are no new Cargo
  dependencies, generated contracts, server routes or persistence formats.

Native fixture children run without Node on PATH. Snapshot RPC, later mutation
observations, keys and the enrollment/control worker remain controlled fixtures.
The integrated server executable and repository helper are the previously built,
unchanged Rust-server consumers; this cycle changes worker code and fixtures.
No production provider/Codex execution or Windows/Linux runtime acceptance is
claimed. No hosted development Actions, devices, paid providers, VM/container
campaign, signing or deployment were used.

The integration driver now also requires `--live <history-live-fixture>`. Build it
with `node scripts/worker-rust/cargo.mjs build -p cantrip-worker --example history-live-fixture`.
The focused compatibility driver is `scripts/worker-rust/history-live-compatibility.mjs`.

Next is managed capture/binding retirement and durable projection/recovery pumps,
followed by the remaining runtime/execution/provider, terminal, transport/browser,
OS/helper, upgrade and packaging/default-cutover/Node-retirement work. The full
goal remains active; production still uses the Node worker.

## Cycle 50: managed source ownership and durable recovery pumps

Reference: `6ae142f8197cf8428cc33ae10fe9fa3229eabbbf` / PR #3212.

`history::managed::sources` now owns captures per worker/chat/thread and native
transport generation. Views of the same runtime reuse their capture. Binding opens
and encrypted journal creation run independently of native input; an admitted
provenance update applies to binding retries. Each binding attempt has its own
deadline. Expiring that request does not retire the observation or retry model
input. Transport replacement drains the original capture's exact frames, even
after storage fails, while replacement observations use their own generation.

Ownership is installed before timers activate on the multithreaded runtime.
Retirement installs its shared completion before synchronously closing the
subscription, so recursive retirement is safe. Final stop aborts metadata I/O,
joins accepted persistence callbacks and reports actual remaining source frames.
Repeated stops join the earlier cohort. Entries and callbacks avoid a manager/
capture ownership cycle; callers must still explicitly stop their owned services.

`history::managed::projection::Pump` accepts journal wakeups and independently
scans encrypted sources at startup. It owns per-binding drains, bounded retry,
flush/close and final cancellation. The production canonical factory connects the
actual authorized HTTP client, verified context/attachment adapters, authenticated
archive recovery, outbox, projector, projection checkpoints and conflict rebase.
One initialization archive snapshot serves outbox recovery and bootstrap and is
released after the first attempt, including empty or already-staged drains.

A damaged journal is reported independently and retried; known healthy journals
are skipped on later scans. Typed HTTP 404 `chat-not-found`/`binding-not-found`
destinations are parked while encrypted sources are retained. Other failures
remain retryable. Stop rejects unconfirmed flushes and waits for running scans
and drains before encryption can be released. Native transport retirement does
not retire durable projection.

Local evidence on macOS ARM64:

- 27 focused actual Node/native managed-source comparisons cover shared views,
  provenance retry, encrypted records, real disk obstruction/repair across two
  transport generations, per-attempt timeout, held binding cancellation and
  persistence-callback shutdown. Separate owned profiles are removed on exit.
- All 17 existing managed-source/projection reference tests pass. Six focused
  native history tests pass, including a new two-thread bind test proving one
  read/open and repeated-stop joining of an accepted callback.
- The existing 81 live-history comparisons and 56 actual loopback client
  comparisons remain regression checks for the touched capture/deadline APIs.
- Real Rust-server/PGlite integration runs native managed capture through the
  production canonical pump. Its first ingest commits but loses its ACK. A new
  native process scans the retained encrypted source without binding any runtime
  and retries the exact frozen bytes. The new item remains revision 1; the
  existing three-batch conflict/rebase scenario plus this delivery leave four
  canonical batches. A damaged sibling is retried without duplicating healthy
  delivery. Actual HTTP request counts show one shared items/turns/batches
  initialization read.
- Controlled typed HTTP 404 responses through the loopback proxy verify both
  parking classifications without deleting source files. This is not evidence
  of actual server-side destination deletion. After native stop, the actual Node
  projection reopens the same profile sequentially and publishes no duplicate.
- Worker/live/client/source builds, worker all-target Clippy with warnings denied,
  formatting, diff and new native-file-size checks pass. No Cargo dependency,
  generated contract, server route or persisted format changes.

The Node development driver controls snapshot RPC, keys and enrollment/control;
native fixture children run with Node absent from PATH. This validates actual
managed history services and their server boundary, not production provider/Codex
execution. The unchanged server and repository helper use their existing native
builds. No Windows/Linux runtime execution, hosted development Actions, physical
devices, paid providers, VM/container campaign, signing or deployment ran.

The focused driver is `scripts/worker-rust/history-managed-compatibility.mjs`
with `--binary <history-live-fixture>`. The existing history-client smoke invokes
the managed pump scenarios through `history-managed-smoke.mjs`; its binary
arguments are unchanged from cycle 49.

Next are child-thread discovery and the top-level managed history facade/runtime
integration, then the remaining runtime/execution/provider, terminal,
transport/browser, OS/helper, upgrade and packaging/default-cutover/Node-retirement
work. Production still selects Node, installed native outer handlers remain 59,
and the full replacement goal remains active.

## Cycle 51: verified descendants, shared history coordinator and worker recovery

Reference: `91d188fb0bb062acdb84639cdcf8b53ca7aff018` / PR #3213.

`history::managed::descendants` now discovers candidate child threads from
retained snapshots and notifications. It reads actual native headers rootward,
rejects missing/cyclic/overlong ancestry, then opens authorized bindings
parent-first. Item names and supplied agent scopes cannot establish lineage.
Verification results share a cache per root, generation and provenance; failed
attempts are evicted. Every later reference still binds/reconciles the verified
child, including when its own notifications are not broadcast to this connection.

Discovery scans real encrypted source journals independently, consumes records
only after successful verification, skips only candidates with disproven
ancestry and retries actual read/network failures. Native reads are abandoned
on stop; metadata requests are aborted and active scans joined. Timer callbacks
claim running ownership before calling runtime/client/bind callbacks, including
on the multithreaded runtime.

`history::managed::coordinator::History` connects the existing capture sources,
canonical recovery pumps, verified adapters and descendant discovery under the
reference profile directories `native-history-sources` and
`native-history-canonical`. It retains managed roots, resolves child output
scope, flushes observed discovery epochs before canonical delivery and shares
one final stop completion. Callback ownership uses weak routing references to
avoid retaining the entire service through its own descendants.

The production native worker now constructs this coordinator after enrollment.
It recovers retained journals independently of native execution and stops history
before closing its encryption service. The adapter reads the current rotated
credential and keeps chat-content and attachment-content grants separate. Live
Codex/provider execution must still attach its runtime observations through the
coordinator; this cycle does not claim that execution implementation.

Local evidence on macOS ARM64:

- 38 actual Node/native descendant comparisons cover shared pending/successful
  verification, historical provenance, parent-first binding, unrelated roots,
  cycles/depth, failed reads/opens, unrelated server replies, replacement and
  shutdown. Real encrypted journal corruption/repair proves scan retry and
  unrelated-candidate isolation without manufacturing consumed records.
- All five existing descendant reference tests and seven native history unit
  tests pass. The new native unit races two wakes of one real journal and proves
  one scan/read plus prompt retirement of a held native header read.
- The existing 81 live-history and 27 managed-source compatibility comparisons
  pass after the fixture extension for per-thread snapshots/bindings.
- Real Rust-server/PGlite integration exercises the whole coordinator with
  root and child sources, verified server ancestry, shared output scope, a
  started child becoming completed through parent-only activity, and repeated
  stop. Its child item advances from revision 1 to 2. The actual Node coordinator
  subsequently reopens the stopped native profile without duplicate batches.
- An actual `cantrip-worker` process then starts on that retained profile with a
  persisted credential. Real server principal approval and HPKE-wrapped grants
  supply the fixture's synthetic chat/attachment keys. Without any live native
  session, worker startup scans and publishes a previously unprojected source
  record, advancing the root item to revision 2. Stdin shutdown completes with
  history stopped before key-service closure. Worker and native fixture children
  have no Node on PATH.
- Worker/live-fixture builds, all-target worker Clippy with warnings denied,
  formatting, diff and new-native-file-size checks pass. There are no new Cargo
  dependencies, generated contracts, server routes or storage formats. Unchanged
  server/repository and client/source fixture binaries reuse their existing
  builds; affected native examples also compile in the all-target check.

The child fixture follows a genuine started-to-completed lifecycle. An earlier
fixture attempted to rewrite an already-completed snapshot item; the existing
reducer correctly retained its committed content as conflicting evidence. No
reducer or flush-semantic change was needed. The production worker smoke uses
the supported persisted credential path rather than a legacy development token.

Snapshot RPC and the initial enrollment/control worker remain controlled;
production worker recovery/authentication/grants and canonical publication are
real. No production provider/Codex acceptance or Windows/Linux runtime execution
is claimed. No hosted development Actions, physical devices, paid providers,
VM/container campaign, signing or deployment ran. Owned profiles are removed
and builds use the existing bounded shared Cargo cache.

The focused driver is `scripts/worker-rust/history-children-compatibility.mjs`
with `--binary <history-live-fixture>`. The history-client integration smoke now
also requires `--worker <cantrip-worker>` in addition to its previous binary
arguments; it invokes the coordinator and production startup scenarios.

Next is native Codex/runtime/provider execution integration, including accepted
command/queue ownership, settings, task/goal delivery and recovery, then the
remaining terminal, transport/browser, OS/helper, upgrade, packaging/default
cutover and Node retirement work. Production packaging still selects the Node
worker, native outer handlers remain 59, and the full goal remains active.


## 52. Native Codex discovery and stdio RPC

Reference: `02fb4179b826976b552147202bbac3ee383146aa` (#3214).
The worker now verifies its configured bundled manifest and probes the actual
native Codex executable before enrollment, preserving the Node startup order and
bundled version-mismatch failure. `codex::discovery` implements version parsing,
initialize validation, experimental-to-stable fallback, bounded feature paging,
method availability, tested-range assessment and native-subagent discovery.
Reports use the existing heartbeat contract without adding a schema graph.
Discovery failures retain the existing missing/incompatible classification and
probe-home filesystem failures remain real startup failures.

`codex::rpc_client` supplies the stdio probe/auth/import client: owned native
process handles, ordered writes, atomic request IDs, independent notification
waiters, FIFO buffering capped at 100, observation deadlines and explicit joined
shutdown. Abandoning a response does not cancel its accepted operation. Final
stderr diagnostics retain their bounded UTF-16 tail, ANSI stripping and secret
redaction. The existing `codex-utils-pty` pipe backend now exposes its actual
reaped exit status through an additive accessor; existing numeric exit APIs are
unchanged. This distinguishes an ordinary exit(130) from an unexpected signal
without guessing process state or ownership from a PID.

Focused local validation on macOS ARM64:

- 122 actual Node/native comparisons cover pure assessment/redaction, manifest
  validation on owned files, notification ordering/predicates/FIFO eviction,
  malformed frames, errors, timeouts, abandoned responses, concurrent requests
  on a two-thread native runtime, joined close, and actual peer exit/signal
  diagnostics. Version checks include stderr fallback, warnings, failed exits,
  expiration and the existing zero-timeout behavior. Real probe-home filesystem
  failures match Node.
- The existing built Codex 0.166.0 bundle passes real manifest/artifact checks and
  produces exactly the same compatible runtime report in Node and Rust. No
  inference, account authentication or paid provider calls are performed.
- All 27 existing discovery, bundled-runtime and stdio RPC reference tests pass.
- The actual production Rust worker starts with the existing native Codex binary
  and no Node on PATH, completes discovery, connects to the Rust server/PGlite,
  obtains real HPKE-wrapped grants, recovers retained history and shuts down.
  The existing focused history integration also retains lost-ACK retry, archive
  recovery, child reconciliation and sequential Node profile-reopen coverage.
- Worker/fixture builds, all-target worker Clippy with warnings denied,
  formatting and diff checks pass. Cargo dependencies, generated contracts,
  server routes and persistent formats are unchanged.

Fixture corrections included accepting a null notification predicate and
checking the existing console field format rather than expecting JSON on stdout.
Neither correction changes production behavior. Builds reuse the bounded shared
Cargo cache; owned fixture profiles and staging are removed after delivery.

This implements discovery and the stdio client, not the managed WebSocket
execution/session adapter or its settlement/admission semantics. Execution
capability advertisement remains unavailable until the actual adapter exists.
Next are managed runtime/execution integration with history, queues/settings,
providers and task/goal recovery, followed by remaining terminals, transports,
browsers, OS/helpers, Node-free upgrades and packaging/default cutover.
Production packaging still selects Node; native outer handlers remain 59.
Windows/Linux runtime execution, hosted development Actions, physical devices,
VM/container campaigns, signing and deployment were not performed. The complete
worker replacement goal remains active.


## 53. Managed Codex process transport and execution RPC

Reference: `e94cf70507a5dab72f74ed1c9c83a33b831f8296` (#3215).
`codex::process_transport` now owns native managed app-server launch, stdout/stderr
endpoint discovery, the existing sanitized startup diagnostic ring and actual
reaped-process evidence. `codex::session` connects the WebSocket, preserves the
100 MiB frame/message limits, supplies the existing initialization capabilities
and 120-second deadline, forwards server requests/notifications and retires its
socket and child with joined cleanup. Session observations carry an immutable
generation; transport loss makes the current generation unavailable.

`codex::rpc_requests` implements pending observations independently from native
settlement. A timeout rejects its waiter but retains settlement observers and
private-inference IDs until a matching reply. Transport loss rejects observations
without claiming settlement. Only a synchronous send rejection calls `not_sent`.
Observer failure cannot prevent the original reply from resolving. Reentrant
callbacks run outside registry locks; registration and deadline admission share
the lock so a timer cannot run before its request exists. Missing response values
remain distinct from explicit JSON null through `Response = Option<Value>`.
Typed native failures retain the original error/data and request method for the
owner, while their displayed message uses the native provider-error policy.

Private late inference responses enter diagnostics only as status markers.
Native resource-protection and inference-admission controls bypass the general
diagnostic pipeline and go directly to the owning adapter, preserving the Node
runtime's ordering. Endpoint diagnostics retain known error classifications
without echoing arbitrary backend bodies. Provider errors preserve secret
redaction, Z.ai status/reset hints and ChatGPT expired-token detection.
UTF-16 diagnostic messages and unknown RPC payload fields are retained.

A closed socket, failed wait channel or attempted signal never proves process
exit. The monitor publishes a separate confirmation bit obtained from the actual
SDK exit status. Only confirmed status produces `ProcessExited`; explicit close
reports failure if reaping could not be confirmed. The existing SDK accessor is
reused without another vendor/dependency change.

Focused local validation on macOS ARM64:

- 164 comparisons use the actual Node parser/provider functions and request
  class, then actual Node/native clients against owned native WebSocket peers.
  They cover deadlines, late/private replies, send rejection, failing settlement
  callbacks, abandoned responses, missing/null results, Unicode, malformed
  frames, server requests, notifications, private controls and repeated close.
- A peer closes its socket while holding its native process alive until the
  fixture explicitly releases it. Both implementations reject observations
  without settlement, invalidate the generation and report process exit only
  after the real child exits. This uses explicit fixture synchronization rather
  than a timing assumption. Startup failure and endpoint deadline cleanup also
  exercise actual owned children.
- The existing native Codex 0.166.0 bundle opens real managed WebSocket sessions,
  initializes and lists empty local thread histories through both clients.
  Each process has a separate owned profile; its reported `codexHome` is checked
  against that profile's actual realpath before comparing the injected path
  difference. Both native children are reaped. No inference or paid provider
  calls occur.
- All 25 selected existing provider-error and RPC parser/endpoint/startup tests
  pass; 78 unrelated tests in the same file are intentionally not selected.
- Three native units cover concurrent reentrant replies, private late settlement
  and a canceled native wait channel never becoming confirmed exit evidence.
- Worker/fixture builds, all-target worker Clippy with warnings denied,
  formatting and diff checks pass. No Cargo dependencies, protocol contracts,
  server routes or persistent formats change.

Fixture corrections created the real runtime's required home directories and
compared its reported home against each separate profile instead of expecting
identical injected paths. The console-only oracle still uses Node; native
fixture, peer and bundled Codex processes have Node absent from PATH.

These are real native worker-library implementations with real managed Codex
acceptance, not completed inference/admission orchestration. Production startup
still uses the discovery integration from #3215; the runtime owner must next
connect managed sessions to protected execution preparation, admission/tickets,
queues/settings, history observations, providers and task/goal recovery. No new
execution capability is advertised. Production packaging still selects Node and
native outer command handlers remain 59. Remaining terminals, data planes,
browsers, OS/helpers, upgrades and packaging/default cutover are still required.
No full Cantrip-server integration suite, Windows/Linux runtime campaign, hosted
development Actions, physical devices, signing or deployment ran for this cycle.
The complete worker replacement goal remains active.

## 54. Native lifetime-keeper client and inference journal

Reference: `ccfff01601eb49b6856ed5214111db99a5a1fae1` (#3216).
`inference::ownership::Owner` now implements the worker client for the existing
bundled Codex Rust keeper. Scope hashes, generation registration, prepare/retire
operations, lazy shared claims, failed-initial-claim retry and sticky ownership
loss retain the existing protocol. Helpers clear inherited native-runtime
registration. The keeper's real OS locks remain the authority; retirement waits
for its positive acknowledgement and actual control-helper exit.

The lifetime helper deliberately uses a direct stdin-pipe child rather than the
model process parent-death/job policy. Parent EOF must allow the keeper to fence
native runtimes before it exits. Explicit close drains stdin and joins actual
child/stdio completion. Correlated requests retain missing versus null results,
streaming UTF-8, bounded input, acknowledgement deadlines, late-reply exclusion
and write-error settlement. Diagnostics cannot own retirement. A deadline kills
only an owned no-inference helper and waits for its real exit; it never claims
the native model lease has been released.

`inference::journal::Journal` implements canonical recovery/queue identities,
snapshot initialization/retry, all existing mutations, acknowledged transitions,
same-provider order retention, chunked alias adoption, forget and recovery-cache
maintenance. Mutation batches retain the 32-operation/60,000-byte budgets.
Accepted work survives dropped response futures; flush joins accepted mutations
and outer release/adoption cache updates. Reentrant queue submission cannot
overtake an older drained batch. Three actual Node Zod schemas are exported as a
separate 69-node worker-prefixed contract graph; existing graphs are unchanged.

Focused local validation on macOS ARM64:

- 146 comparisons use actual Node identities, schemas and journal/ownership
  implementations against the real bundled Rust keeper and native client.
  They cover initialization, unused-grant requeue, consumed/sealed rejection,
  transitions, recovery, and six rejected acknowledgement variants after the
  real keeper has already committed the mutation.
- One bounded 410-alias metadata case crosses the real adoption frame budget.
  Both stopped profiles reopen through the opposite implementation with exact
  durable metadata retained; all disposable profiles are removed.
- Real registered Codex app-server processes initialize without inference.
  Owner EOF fences them, and explicit retirement waits for real native lease
  reconciliation; both processes are actually reaped.
- Native protocol peers exercise split Unicode, missing results, delayed EOF,
  invalid IPC, failed acknowledgement and startup failure. Native-only short
  deadlines prove failed-claim retry after actual helper exit and exclusion of
  a late journal reply without dropping the live keeper. Lost ownership is
  published before failed journal waiters resume; that generation cannot reclaim.
- All five existing ownership, prestart-journal and task-journal epoch tests pass
  against the actual bundled keeper. Three native units cover reentrant FIFO
  batching with abandoned waiters, shared snapshot failure/retry and joined
  recovery-cache updates after abandoned release observations.
- Worker/fixture builds, worker/protocol all-target Clippy with warnings denied,
  the affected Rust-server compile, formatting and diff checks pass. Contract
  regeneration is byte-stable. No Cargo dependency or persistent format changes.

An actual stack sample exposed claim startup polling recursively under its state
mutex; claim now starts as an owned executor task outside that synchronous
prefix. Test inputs were corrected to include the required task dispatch and
explicit native wire objects/nulls. Native fixture/helper/runtime processes run
with Node absent from PATH; Node remains the development oracle only.

This is the native ownership/journal backend, not the worker-wide FIFO/capacity
manager or complete Codex admission/runtime integration. Those must now connect
the keeper and journal to managed sessions, execution preparation, queues,
settings, history capture and task/goal recovery. Production packaging still
selects Node and installed native outer handlers remain 59. Providers, remaining
terminal/data-plane/browser/OS/helper behavior, upgrades, packaging/default cutover
and Node retirement remain required. No broad suite, hosted development Actions,
physical devices, Windows/Linux runtime campaign, signing or deployment ran.
The complete worker replacement goal remains active.


## 55. Worker-wide native inference admission

Reference: `fe639673b8f574810c6e9d68283961af7b261ff1` (#3217).
`inference::admission::Manager` implements the current worker-wide admission
service around the existing native keeper/journal. It owns shared provider pools,
revisioned configuration/catalog membership, opaque operation lifetimes and exact
redelivery, durable enqueue/grant barriers, cancellation versus physical
settlement, parked permission, FIFO suspension/resume and private withdrawal.
Three authoritative provider/native-binding schemas add an independent 12-node
contract graph; existing graphs and persistent formats are unchanged.

Direct HTTP execution shares these same pools. A canonical source rejoins its
original result instead of starting its callback twice. Native preparation can
borrow its actual same-provider reservation, yield fairly for independent or
batched work and reacquire FIFO permission before returning. Its structured
producer hold joins all accepted child callbacks, including response/body
teardown after a caller abandons its observation or the native process retires.
A binding cannot overlap preparation, and cancellation retains running capacity.

Recovery installs previous-generation barriers before grants, reconciles up to
four metadata records concurrently, groups physical aliases by canonical logical
input and retains same-provider order through adoption. Goal preparation failure
changes eligibility only; it does not own or release actual execution. Existing
retry/backoff, canonical Task/Goal tuple checks, no-start receipts and uncertain
withdrawal observations retain their original authority boundaries.

State transitions reserve capacity under one mutex. Ordered IO prefixes and
callbacks run outside it, preventing concurrent tasks from reordering durable
submissions or reentrant callbacks from deadlocking the registry. Canonical
lifetimes retain exact released tickets without permanently retaining every old
operation; accepted metadata tasks have explicit retention through completion.
Private Task Goal binding validation and withdrawal share one critical section.
The existing worker cancellation signal now composes parents with initial input
order and subsequent cancellation chronology. Shared errors retain typed refusal
and UTF-16 messages.

Focused local validation on macOS ARM64:

- 117 comparisons use the actual production Node admission class and the native
  manager, including real keeper writes. Provider revisions/defaults/removal,
  shared FIFO, exact/foreign/changed lifetimes, cancellation, suspension/resume,
  parked stale grants and private Task Goal no-start receipts are covered.
- The real keeper commits grant and retirement operations before a development
  adapter holds their acknowledgements. No permission is issued from a held grant,
  stale replies cannot revive parked requests and capacity remains occupied until
  retirement is acknowledged. No model/provider call occurs.
- Stopped owned profiles reopen under a new worker generation. Reconciled old
  message aliases block newer work; their actual replacement adopts the old FIFO
  ordinal and receives permission first. Disposable profiles are removed.
- Random runtime generations and injected profile paths are independently
  validated before comparison. Live snapshot revisions must be independently
  monotonic; observer scheduling/coalescing does not require equal live revision
  values. Full pool/operation state and timing remain compared.
- Five native units cover cancellation/replacement capacity, canonical redelivery,
  direct callback deduplication and real controlled teardown, abandoned structured
  preparation during retirement, and typed/UTF-16 shared errors. Five metadata
  cancellation units pass, including two new composition cases.
- All 14 selected existing pause, Task binding, endpoint-isolation and shutdown
  tests pass. Worker/fixture builds, worker/protocol all-target Clippy with warnings
  denied, affected server compilation, byte-stable schema regeneration, formatting
  and diff checks pass.

The fixture was corrected to release an artificially held batch acknowledgement
before awaiting a pause receipt in that batch. Compatible mutation coalescing can
combine different entries into one response. A provider replacement unit now
establishes the actual creation stamp instead of assuming an unknown legacy pool
can be resurrected. These corrections preserve production policy.

The production worker still needs its Codex admission adapter and runtime owner,
canonical command phase/source adapters, actual server reconciliation ports and
execution/queue/settings/task/goal wiring. The native manager is exercised through
its real library APIs; this does not claim production model execution or a default
cutover. Native outer handlers remain 59 and packaging still selects Node.
Remaining providers, terminals, data planes, browsers, OS/helpers, Node-free
upgrades and packaging/default cutover remain required. No broad suite, hosted
development Actions, physical devices, Windows/Linux runtime campaign, signing or
deployment ran. The complete worker replacement goal remains active.

## 56. Codex inference admission adapter

Reference: `2a8a7aaade0af14ab511663f850a01ca56eefbdc` (#3218).
`codex::admission::Adapter` connects Codex operation lifetimes and private
native scopes to the worker-wide admission manager. It retains exact redelivery,
reuses a unique dispatched root reservation, and separately admits child and
independent model work. A replaced pause permission cannot authorize input.
The adapter preserves canonical scope, gate attempt, and Task Goal identity
when binding, suspending, withdrawing, or retiring a request.

UI completion can reconcile a dispatched turn before any private scope is
bound. Once bound, the physical scope stays owned until a private finish,
an exact never-allowed begin rejection, or completed process fencing. Losing
transport observation does not release dispatched work. RPC preparation holds
its reservation through an observation timeout and accepts settlement from the
existing request correlator, or confirmed process retirement. Pre-acquisition
preparation does not occupy the response provider's slot.

Task Goal capture rereads the current owner after the keeper read. The native
adapter rejects a mismatched captured gate and forwards the exact withdrawal
error so the command owner can await the durable transfer acknowledgement.
Weak source and lifetime references preserve memoized redelivery without an
ownership cycle. Dropping an observer does not close a canonical source.

The private RPC router must still supply actual Core claim and resolve replies,
confirmed cancellation/finish events, and task dispatch ports. Subsequent
cycles must bind the adapter to the native runtime, server reconciliation,
execution, queues/settings, history capture, and Task/Goal producers. This
cycle adds no outer handler and production packaging continues to select Node.

Local macOS ARM64 validation passed 11 focused admission tests and two RPC
correlator tests, plus 17 existing Node pause, shutdown and RPC tests. The
native tests exercise root reuse, an independent waiting scope, stale gate
rejection, parked permission replacement, late RPC settlement, and actual
preparation teardown. The bundled Codex keeper produced the durable private
Task Goal no-start receipt in an owned temporary profile. No inference provider
was called. Worker all-target Clippy with warnings denied, formatting and diff
checks passed. The private gate confirmation/dispatch callbacks use controlled
inputs. No Windows/Linux runtime or hosted development Actions ran.

## 57. Native Codex private inference transport

Reference: `d25cca5565bdf70e00ed14d9d399ef5fc7110ece` (#3219).
`codex::private_inference::Router` connects the adapter to the owned app-server
WebSocket session. It consumes private inference notifications before the
ordinary observer and uses Core's actual claim and resolve requests. Its
pending table correlates runner, attempt, thread, turn and scope. Duplicate
notifications join the existing request. A Task's first input can park the
private Goal begin, then claim and deny that exact begin while it owns the
native producer hold. Pause can inspect an actual waiting gate and claims the
still-pending Core boundary before suspending an unbound root.

The event consumer stays available while claims, admission and denial receipts
are pending. An accepted negative resolve retires the exact begin. A failed
denial or denied resume does not retire an admitted scope. A late Core cancel
can still retire its original begin after the pending observer was removed,
provided its runner and attempt match. Dropped socket observations cancel only
unforwarded work. Native process retirement waits for the owned Session's
confirmed child exit and the admission keeper's fencing.

The router consumes real Session messages. The managed runtime owner still
needs to create the session and router from the worker's command path, supply
the managed overlay and Task/Goal ports, and integrate queue, settings,
provider execution and live history. This cycle registers no outer commands.
Production still launches the Node worker.

Local macOS ARM64 validation used an owned child process and WebSocket peer
to check claim/resolve parameters, first-input parking, stale and late
cancellation, acknowledged and failed denial, denied resume, private finish,
and distinct transport loss and confirmed exit. The session oracle passed
166 Node/Rust comparisons, including a missing-scope claim against the
installed bundled Codex. Eleven native admission tests passed, including
the real keeper Task Goal case, along with the targeted Node transport
fencing test, worker all-target Clippy, formatting and diff checks. No model
calls, Windows/Linux runtime tests or hosted development Actions ran.

## 58. Worker-owned managed Codex lifecycle

Reference: `3890aa2badebf72a3ae2b7476d5cb6b1a67786e2` (#3220).
The native worker now constructs and drains a lazy managed Codex registry.
Launches resolve the verified server/account binding before joining or creating
an app-server profile. Profiles in a binding share the provider admission
manager and native keeper. The owner prepares a private account home, obtains
the native runtime lease environment, launches the app-server, installs the
private inference observer and initializes its session. It accepts resolved
provider launch settings and account-login inputs from the command owner.

Concurrent opens of the same profile join one startup. A replacement waits
for the outgoing child and scope to retire. Socket loss rejects RPC observers
and signals pending private work while confirmed child exit and keeper fencing
retire admission. Worker restart/shutdown closes the registry to new launches,
joins accepted startup and child teardown, and then retires the shared keeper.

Local macOS ARM64 validation exercised the full owner against a native
WebSocket peer and the installed bundled Codex. The peer went through the
actual managed event pump and produced private claim and resolve RPCs. The
bundled child returned real thread metadata. Tests also established shared
provider capacity across profiles, concurrent startup reuse, replacement
fencing, shutdown during accepted startup, and native keeper cleanup. The
166 Node/Rust session comparisons, worker all-target Clippy, formatting and
diff checks passed. An actual Rust worker and PGlite Rust server passed the
existing enrollment, rotation, restart and stdin shutdown smoke. No model
inference, hosted development Actions or Windows/Linux runtime tests ran.

Command launch profiles, managed thread and Task/Goal ports, live
provider/account refresh and history integrations still need to call this
registry. This cycle adds no outer command or advertised execution capability.
Production continues to launch Node.

## 59. Account-backed ChatGPT catalog command

Reference: `73477166a72583fda095c03e06eaed321f88374a` (#3221).
The native command dispatcher now serves `model.chatgpt.catalog` through the
managed Codex registry. It opens the existing hashed account home, paginates
the native model list with the same cursor/size rules, and retains Codex
quota buckets and the canonical weekly projection. An unavailable quota
still permits model discovery. The selected catalog home cannot be reused
under a different provider account.

The worker reads the authenticated provider credential endpoint, opens its
protected envelope under the exact account binding and caches the short
in-memory lease. Portable startup passes the real login parameters to native
Codex. A migration/unavailable response selects the existing local account
home. The shared refresh path checks the returned provider identity, seals
rotated credentials, and uses expected-revision upload and conflict recovery.
The native session can answer the existing refresh request, and refreshed
access tokens enter the same diagnostic redactor before returning to Core.
The lease validator is generated from the existing TypeScript contract.

The active native dispatcher has 60 outer handlers. Account sign-in/sign-out
and runtime clearing, other catalogs, and full native model execution remain
separate work. Production packaging continues to select Node.

Local macOS ARM64 validation drove the production Rust worker dispatcher
over its authenticated control socket with a loopback server and Codex peer,
and used the installed bundled Codex for discovery and real keeper ownership.
It verified concurrent portable login and credential reuse, actual account
request/reply shapes, native refresh refusal when no refresh token is
available, the legacy fallback home, wrong-account rejection, pagination
and Node quota/contract parity. Two native OAuth-response tests and seven
existing Node tests passed, as did 166 session comparisons, worker/protocol
all-target Clippy, affected server compilation, schema regeneration,
formatting and diff checks. No external OAuth exchanges, model calls or
hosted development Actions ran.

## 60. Legacy provider credential migration and account clearing

Reference: `7f8f979d85d3e1d3055c03c29196ec49fef8c5c8` (#3222).
The native control connection accepts legacy credential capture, proof-bound
purge, and account clearing for ChatGPT and Grok. Capture reads the existing
hashed account home, validates the original file format, and returns only the
protected credential, blinded subject and expiry metadata. ChatGPT reports
portable authentication using the installed Codex compatibility report. Purge
revalidates the subject before unlinking and echoes the durable revision.

Purge and clear join the selected home's pending starts and child exits before
mutating its credential file. The account's cached access is evicted and
accepted lease requests settle while new reads are fenced. A different account
using the selected home causes the operation to fail without changing the file.
An unresolved startup teardown also keeps the credential file intact.
Provider status, sign-in, logout and model execution remain separate work.
Production packaging continues to select Node.

The macOS ARM64 control-socket smoke used the native worker and real bundled
keeper with loopback HTTP and Codex peers. Node decrypted both captured
credentials and matched its own readers, expiry and blinded subjects. The
fixture checked symlink refusal, missing credentials, rejected mismatched
purge, repeated purge, and a fresh durable read after clearing a live account
while another account retained its runtime. A controlled startup test confirmed
that retirement joins an accepted launch, prevents a replacement from starting
until the credential operation finishes, and refuses mutation when cleanup
could not establish process exit. Two Rust refresh tests,
three existing Node credential tests, all-target worker Clippy, formatting
and diff checks passed. No upstream provider requests, hosted development
Actions, Windows or Linux runtime tests ran.

## 61. ChatGPT account status, device sign-in and logout

Reference: `d826695a9324654d4584ad9ecefaa86b4e3210ed` (#3223).
The Rust worker dispatches the three existing `codex.auth.*` commands for
ChatGPT. It opens Codex's stdio authentication service with the existing
hashed account home and file credential store. It reads account details
without token refresh, preserves the 30-second weekly usage cache, handles
login completions arriving before the start response, and cancels a pending
login before direct logout. Legacy capture and server-authorized account
clearing still use the existing credential format. Purge and clear wait for
the home-local authentication child to exit before changing that file.

The worker emits the existing provider auth observation envelope with a
sequence, bounded expiration, safe sign-in state and reconnect replay.
Authentication child stderr and upstream OAuth error text stay out of the
worker's report. Device authorization values travel only in the existing
login-start command response.

The local macOS ARM64 dispatcher fixture read signed-out status from bundled
Codex and exercised event-driven success and early expiry with a stdio peer.
It verified Node weekly usage/schema parity, pending-login cancellation,
clearing during authorization, redaction and replay over a real reconnect.
The 122 Node/Rust stdio and discovery comparisons, six existing Node
observation and legacy credential tests, worker Clippy, formatting and diff
checks passed locally. Upstream authorization, Windows and Linux runtime
validation are outside this cycle's evidence. Grok
sign-in, status and logout still require their native provider implementation.
Production packaging continues to select Node.

## 62. Grok device sign-in and local credentials

Reference: `7b15694750ce3bc4677f5a2fe486a5af2ece4fa9` (#3224).
The Rust worker handles status, device sign-in and logout for Grok through
the same command and observation protocol as ChatGPT. The native OAuth
client uses the existing scopes, client identity, polling interval and
slowdown handling. It opens and atomically replaces the existing
`grok-auth.json` schema, refreshes local credentials, and uses authenticated
profile and billing status reads with the existing weekly projection and
short cache. Observations contain only the defined safe status fields.
Logout, purge and account clearing retire the selected home's OAuth poll
before file mutation. The shared status observer serves both providers and
joins its tasks on worker shutdown.

Local macOS ARM64 validation used a loopback OAuth and billing peer to
check polling, durable owner-only permissions, reopening and rotating a
legacy credential, implicit zero usage, and logout during a held token
exchange. The bundled-Codex dispatcher smoke also exercised Grok's signed-out
status and local logout. Fifteen existing Node tests, two native refresh tests,
worker Clippy, formatting and diff checks passed. The fixtures used local
peers. Upstream authorization and Windows/Linux runtime validation remain
unverified. Production still selects Node. Native Grok catalog and
subscription inference proxy remain separate work.

## 63. Grok model discovery and quota reads

Reference: `384a9dc5c3bf081be8043e2a5f9eeab89de6b3ea` (#3225).
The Rust dispatcher serves `model.grok.catalog` and the Grok branch of
`provider.quota.read`. Discovery opens scoped portable leases, verifies the
account identity, and retries a provider 401 with refreshed credentials.
Catalog requests fall back to the existing local account home on HTTP 404 or
the existing credential-unavailable and migration codes. Model metadata uses the
Node alias order, first visible default, modality and reasoning rules, and
the existing protocol schema.

Billing emits the existing weekly quota envelope with account-scoped
30-second retention. An explicit portable quota read refreshes the snapshot
and can reuse the last successful result if billing is unavailable. As in
Node, an unavailable portable quota with no prior snapshot returns an empty
result. The catalog can still return models when quota is unavailable.

Local macOS ARM64 tests exercised the actual authorized credential route
with a sealed Grok account, a local subscription peer and a model/weekly
fixture produced by the current Node client. They checked credential request
coalescing, identity refusal, shared and forced quota, outage retention and
a local 401 refresh during fallback. The control-channel smoke exercised both
Grok command dispatch paths with a signed-out account. Fifteen existing Node
tests, worker Clippy, formatting and diff checks passed locally. Production
still selects Node. The Grok subscription inference proxy and full execution
remain open.

## 64. Grok subscription inference proxy

Reference: `3a87830af566fca788a3b826851148306786b134` (#3226).
The managed Codex registry resolves Grok account profiles to an
account-scoped, worker-owned HTTP listener on IPv4 loopback. Credentials
and authoritative headers come from the selected portable lease or the
existing migration fallback. Managed runtimes receive the local capability
URL. The worker tracks the credential home independently of the runtime
home, so account logout, clearing and worker shutdown can retire the right
child and proxy.

The proxy preserves the 64 MiB request limit, confines requests to the
configured provider's `/v1/` paths, and streams replies under backpressure.
It preserves account refresh, one-based turn identity, the targeted removal
of rejected reasoning items, and the stateless recovery path. Error inspection
reads at most the first MiB of a 400 response for the known rejection messages.
Forwarded replies retain their original body.

The local macOS ARM64 fixture verified header authority, focused rejection
recovery, streamed chunks, and interruption during proxy shutdown. Bundled
Codex completed real ephemeral turns through the Rust proxy with both a
sealed portable credential and the local migration fallback, then verified
logout. The worker control-channel smoke, 15 existing Node tests, three
native Grok tests, Clippy, formatting and diff checks passed. Server-dispatched
execution, durable capture, guest placement, and production launch
integration remain open. Production still selects Node.

## 65. Cold native thread observation

Reference: `d1288a44113cc4131e4ccfecde3f3bb80709db4d` (#3227).
The Rust worker handles the server's `chat.sync` command for cold host
conversations. It resolves protected repository routing, opens the selected
provider, and reads the thread from the existing IDE/account home, standalone
home, or committed handoff namespace. Namespace selection validates the
immutable operation chain against the command's conversation, owner, server,
worker, and provider. A persisted OS placement requires its own native
transport.

The managed Codex runtime issues `thread/read` with turns and history metadata.
It retries without the metadata parameter only when the native RPC explicitly
rejects that parameter. It verifies the returned thread ID and sends the native
lifecycle status using the existing response schema. Cold reads leave the
thread unloaded, and replies omit transcript items without an external-console
baseline.

Local macOS ARM64 validation compared the actual Rust worker's replies with
Node's home selection, thread status, and endpoint error rules. The bundled
Codex read a persisted thread through the Rust worker after the originating
process exited. The fixtures also checked the metadata retry, mismatched
thread and namespace identities, and an OS placement that could not fall back
to the host. External-console attachment, server-dispatched turn execution,
live history publication and OS-hosted observation remain open. Production
still selects Node.

## 66. Capture live Codex history through the managed transport

Reference: `d5ec55aefd95c3f8d113b0667eb963cc785d5b43` (#3228).
Managed runtimes now expose a stable history source for their WebSocket
generation. The socket captures notifications before processing later RPC
replies, so a `thread/read` snapshot can reconcile the earlier frames. The
source retains valid native cursors and excludes replies, native server
requests, and private inference controls. Closing the transport retires its
subscriptions, and the history capture drains accepted records independently
of the native child.

Local macOS ARM64 validation used the bundled Codex and a loopback Grok
provider. Two persisted turns streamed real assistant output through the
native runtime. The Rust worker obtained authorized history bindings from
the fixture server, captured output and terminal notifications, and read back
the encrypted journals after logout closed the transport. A socket-level test
also checks ordering against the RPC reply while the ordinary event consumer
is idle. Connecting the history source to production managed chat preparation
and validating canonical publication through the Rust server remain open.
Production still selects Node.

## 67. Recover managed thread preparation across runtime replacement

Reference: `36e0b873628936fc6d24d59d4d3aae12bde62b3c` (#3229).
The Rust managed-session coordinator serializes requests by authenticated chat
scope and reads the existing `managed-chat-sessions` journal. It writes the
native thread ID before later configuration or server acknowledgment, and
retains that ID in memory if the journal write fails. It upgrades matching
version-one associations and separates account migrations from same-account
model routing changes. Explicit server bindings remain authoritative. A
replacement can redirect a predecessor only after canonical commitment.

Native preparation starts or resumes the exact thread, applies the managed
overlay and checks the native acknowledgment. Preserving attachment inherits
native security and subagent settings. The worker retries the specific
active-writer rejection during detached process recovery and fences replies
with the transport generation and native thread close version.

Local macOS ARM64 validation forced an interruption after thread identification,
replaced the app-server process, resumed the same persisted thread and later
attached by its canonical ID. Bundled Codex then streamed a real turn through
a loopback provider and retained it in encrypted history. The scoped setup was
exercised with both local and portable Grok credentials. Production
`chat.thread.ensure` still needs the managed MCP, settings, and execution-owner
configuration that supplies this preparation path, plus canonical History
publication through the server. Production still selects Node.

## 68. Native first-party Cantrip MCP stdio host

Reference: `ae75e37a8e88c886243f0635a275fbbcedc6e293` (#3230).
`cantrip-worker mcp --connection <path>` implements the Cantrip MCP child for
IDE and standalone chat. It opens the same private connection document, verifies
the live binding over loopback, and delegates calls to the authenticated
broker. The broker continues to decide whether the associated execution lane
can perform each operation. Stdio requests keep their JSON-RPC identity and
cancellation closes the corresponding broker exchange. Broker replies are
bounded at the existing 512 KiB limit.

The child embeds the tool catalog, exact help and validation graphs generated
from the pinned Node MCP registrations. To refresh them after changing the
reference schemas, run
`node --import tsx scripts/worker-rust/mcp-stdio-contract.mjs` from the repository
root with the development protocol packages built. The MCP child loads the
tool validation graphs on demand.

On macOS ARM64, bundled Codex launched the native child and enumerated a
required tool with no Node on its path. Both profiles matched the Node
stdio catalogs, help and validation behavior. The local fixture exercised
idle and active bindings, authenticated context, concurrent calls,
cancellation, oversized responses and invalid connection documents.
The native broker, managed configuration selection, CUA and Streamable HTTP
hosts remain open. Production still selects Node.

## 69. Native Cantrip MCP binding lifecycle

Reference commit `df41181140529ee47ac29ea91a589e0a2917fe32` (#3231).

The Rust worker can prepare and revoke a private loopback attachment. The
MCP child can authenticate while idle. The worker admits calls once an
execution lane matches the attachment's owner, chat, placement and permission
profile. An activation identifies a specific admission, so releasing an
earlier activation leaves its successor active even when both use the same
lane ID. The connection file uses the existing format and is removed on
revocation, expiry or shutdown.

The initial broker operations are `context.get` and `tool.help`. The broker
checks the declared operation scope before sending context requests with the
current worker credential. The server validates the request against its
current execution context. The broker serves tool help from the catalog used
by the native child. It negotiates the binding protocol and supplies an opaque
routing handle when a version-one context request requires it.

Local macOS ARM64 validation exercised the native MCP child through the
native broker against the Rust server's authenticated context endpoint with
PGlite. It checked idle and active calls, placement and owner mismatches, scope
restrictions, stale-binding replies, replacement, revocation and cleanup. The
Node-broker differential also exercised the native child's wire behavior. The
legacy version-one upstream exchange still needs native interoperability
coverage. Production managed-thread preparation, additional broker operations,
Streamable HTTP, CUA and CLI attachment remain open. Production still
selects Node.

## 70. Prepare managed host threads over the worker command channel

Reference commit `26b5ba2a50456db167c7a0ae146f2ea20a4ecb63` (#3232).

The Rust handler for `chat.thread.ensure` uses the authenticated owner,
server, worker and chat to load the managed session journal. It starts or
resumes the native thread in the existing host provider home, isolated
standalone home, or selected managed namespace. A recovered conversation
retains its native permission profile and collaboration mode. A new or
partially configured session waits for the native settings application
before the worker records preparation as complete.

Preparation opens enabled external MCP configurations with the worker's
component keys and reserves the first-party MCP names. It installs the local
native Cantrip MCP command with a private, idle binding. The managed overlay
keeps the native execution gate in place. A requested recovery observation
returns the exact thread, transport generation, turn ID and status from
native history, with transcript content excluded.

The macOS ARM64 smoke exercises the running Rust worker through its command
socket and bundled Codex. The local server peer supplies the authenticated
command exchange. Project and standalone threads keep their identities across
worker replacement, and each worker owns and removes its own attachment
files. The project test checks that MCP calls remain idle and that existing
native settings survive reattachment.

The legacy command without a managed session, OS-hosted and held-suspension
preparation, complete managed tool registration, and execution-owner
admission remain open. Production still selects Node.

## 71. Execute and stop a server-dispatched host text turn

Reference commit `abfd9c66bda087f1849288fe299b0b148b94f269` (#3233).

The Rust worker dispatches the visible host text form of `chat.turn` through
its managed native runtime. It reuses the recovered native thread, validates
the Core permission profile, acquires the existing inference grant and
activates the MCP attachment for the exact server-supplied execution lane.
The worker retains the grant and attachment through native settlement.
The command response includes the native IDs, final response text and observed
token usage. Streaming messages retain their native item identities and
provisional phase until completion.

The host `chat.interrupt` handler cancels undispatched preparation or sends
Stop to the exact native turn in the matching chat and thread. It leaves the
active owner available until the native boundary settles. A second turn
cannot dispatch concurrently in the same chat.

On macOS ARM64, the running worker consumed a control-channel request from
a local server peer and produced streamed text through bundled Codex and a
loopback Responses provider. The smoke observed the active MCP lane, checked
idle access before and after execution, read the completed turn back through
managed preparation, rejected a conflicting permission profile, and stopped
an active native turn while retaining its exact thread scope.

Protected inputs and results, native command receipts, approvals, Task and
Goal execution, complete turn telemetry, and canonical History and outcome
delivery remain open. This cycle exercises the production worker dispatcher
with a disposable server peer. Production still selects Node.

## 72. Execute protected host chat turns

Reference commit `178bfc1b346ef475e56c8f411aabf235b50c2070` (#3234).

The worker opens protected host text turns for the authenticated owner and
logical server, using shared Cantrip history and crypto crates with the
worker's current component grants. It authenticates the submitted message,
continuation history, and existing plan before dispatch. A new native thread
receives the authenticated continuation once. A recovered thread receives
the current prompt.

The worker seals provisional and settled messages with the existing message
identities, seals plan changes while preserving a pending question, and
returns the final reply in the existing encrypted relay result. The four
chat protection commands produce the existing message and queued-turn
envelopes through the same worker key authority.

On macOS ARM64, a running Rust worker accepted authenticated commands from
a disposable local peer and used bundled Codex with a loopback Responses
provider. The Node reference code opened the Rust ciphertext and matched
streamed identities. The test also exercised all four protection commands,
verified that invalid envelopes failed before provider dispatch, and checked
the socket and worker diagnostics for fixture plaintext.

Protected attachment delivery at native turn dispatch, command receipts,
approvals, Task and Goal execution, canonical History and durable outcome
delivery remain open. Production still selects Node.

## 73. Bind managed GUI receipt ownership to native host execution

Reference commit `583abbc84036ea1797a3735f475c60c3a3db9855` (#3235).

A protected host text turn can use Core's accepted GUI command. The worker
matches its encrypted input digest and binds the Core operation, placement,
route, and worker generation to the actual native thread before forwarding
`turn/start`. The inference journal carries the existing command and message
identities. The worker uses the shared crypto crate to seal the native RPC
receipt and compute its keyed digest in the existing format.

The worker retries idempotent receipt transactions with the same payload.
Dispatch remains single-attempt. Exact terminal observations are reported
separately from the RPC result. An authenticated logical completion or
pre-dispatch cancellation releases the matching operation once native work
has settled. The legacy host interrupt command honors an activation
generation when supplied.

The macOS ARM64 smoke exercises the real native worker and bundled Codex with
a disposable authenticated Core peer. It checks preparation before dispatch,
a lost dispatch reply, a lost RPC-receipt acknowledgment, exact logical
cancellation and completion, and completed and interrupted native terminal
evidence. The Node codec opens the receipt and reproduces its keyed digest.
The Rust server compiles with the generated reply contracts.

Managed `chat.native-control` (including the GUI Stop path), native approvals,
deferred settings, queued input, continuation recovery, protected attachments,
canonical History and durable logical outcome publication remain open.
Production still selects Node.

## 74. Stop active managed host text turns

Reference commit `88c76952904652c52668ef2d6373b96339a5a173` (#3236).

The Rust worker handles the managed host Stop command sent by the desktop's
server route. It identifies the active thread, activation, runtime, model route
and provider account. After Core records the native turn identity, the worker
encrypts the exact interrupt request and obtains a separate control receipt.
It records dispatch before forwarding Stop. It rechecks the selected turn at
the native send boundary and reports the control result separately from the
root turn's terminal evidence.

On macOS ARM64, the running Rust worker and bundled Codex exercised the
command channel with an authenticated Core peer and loopback model provider.
The smoke rejects stale selectors, holds the root receipt while Stop arrives,
drops the control dispatch response, and verifies that a later confirmed Stop
interrupts the selected turn. The Node codec opens the control request and
result and reproduces their keyed digests. The smoke also verifies identical
control settlement on acknowledgment loss. All 61 focused Node managed
command session tests and strict worker Clippy pass locally.

Managed pause, steering, interaction replies, deferred and queued inputs,
suspension recovery, canonical History and durable outcomes remain open.
Production still selects Node.

## 75. Connect managed project turns to canonical History

Reference commit `139dfb6dc105d8934ab3929391d9717e81963319` (#3237).

The running worker attaches the existing managed History coordinator after
Core binds and dispatches an admitted project turn and before sending the
native input. The capture uses the exact command, generation, and native
thread as its provenance. Its background jobs journal native frames with
the bound worker identity, reconcile retained snapshots, and deliver
encrypted batches through the existing receipt-backed projection.

Live protected text uses the same server-reserved identities as the
projection. Its mode comes from the original retained turn context. Live
publication keeps output in order while native observation and Stop can
proceed. Standalone and unreceipted host text retain their existing paths.

The macOS ARM64 smoke runs bundled Codex and the Rust worker with a
disposable authenticated Core peer and loopback model provider. It checks
that projected and live output share an identity, observed input preserves
the original protected message, and the exact batch retries after a lost
commit acknowledgment. It also holds an identity lookup across native Stop
and reopens the encrypted journal with the Node reference reader after the
worker shuts down.

Autonomous execution and suspended-turn recovery still need their capture
hooks. Managed queue, interaction, broader activity publication and durable
logical outcomes remain open. Production still selects Node.

## 76. Deliver host turn outcomes and recover pending Task files

Reference commit `45e7878e116ba5fa0f48e0783d37bd9f557ea3ec` (#3238).

The Rust worker sends the existing `chat.turn.outcome` notification after
the matching host chat response. It carries the original lane, message,
placement, and logical command identity. Both frames use the command
connection's reconnect buffer. Protected results remain in their existing
encrypted relay form.

After the command connection authenticates, the worker scans the existing
`task-goal-outcomes` directory for its logical server, owner, and worker.
It reopens version-one files, including legacy Goal records that predate
the input-kind field. It submits each outcome through Core's existing
commit endpoint. Matching commit and positive retirement receipts permit
removal. Transport failures and unrelated acknowledgments retain the
original file and delivery identity for retry.

The local macOS ARM64 smoke completes a bundled-Codex turn while the socket
is disconnected and receives the response followed by the notification after
reconnect. A disposable authenticated peer exercises original Node outbox
files, authoritative retirement, wrong delivery and Goal source identities,
and exact resend after Rust worker restart. The smoke uses a fresh thread for
the reconnect case. Continuing on the same thread immediately after Stop
requires separate validation.

Native Task execution still needs its producer and commit barriers. Full
integration against the production Rust server and production cutover
remain open. Production still selects Node.

## 77. Prepare protected Task inputs and failure records

Reference commit `554ca76920c377a42348669c58beb3be6b703332` (#3239).

The running Rust worker accepts the existing `task.message.protect` command
and converts a protected Chat message into the Task encryption domain under
the bound account. Message identity, mode, attachment classification, and
idempotency key survive conversion. The Task, planning round, and message
codecs use the shared encryption primitives and endpoint plaintext schemas
generated from `packages/protocol`.

`task.operation.prepare` opens the saved Task snapshot and prepares all four
operation kinds. It returns the verifiable relay fingerprint, encrypted
running Task and round, encrypted user message, and matching encrypted
failure records with the original row version. This command prepares input
for the server's existing transaction and does not start a native turn.

The macOS ARM64 smoke opens native results using the Node reference codec.
It compares all four decoded operations, verifies the keyed relay
fingerprint, checks the fallback Task and round, and rejects inconsistent
public metadata and a ciphertext moved to another Task. The worker and
server compiled locally.

Native Task dispatch, execution, and outcome production still need wiring.
Production still selects Node.

## 78. Execute direct protected Task rounds

Reference commit `ea18e86a7856866788647444ad1e219f66bec0b7` (#3240).

The Rust worker opens and authenticates the existing encrypted direct Task
operation before claiming its exact input. It uses Core's claim and dispatch
phases, then binds the actual native thread, turn, and scope through the same
admission journal used for other native inference. Provider execution waits
for the matching binding acknowledgment.

Live assistant messages remain encrypted under the Task grant and retain
their stream identity. The completed relay preserves the original operation
and fingerprint, and reuses the final encrypted message when it matches the
terminal result. A claimed result is written in the existing immutable
round outcome format. The worker only removes the file after the server
returns a matching commitment or retirement.

The local macOS ARM64 smoke uses the bundled Codex binary, a disposable Core
peer and a loopback provider. It runs a Node-created round, rejects a changed
fingerprint and a duplicate claim, opens the encrypted result in Node, and
replays the same pending delivery after restarting the Rust worker.

This milestone covers direct host text rounds. Structured planning and
finalization, Task attachments, policy bodies, native pause and resumption,
and Goal continuations remain open. Production still selects Node.

## 79. Execute structured Task planning and finalization

Reference commit `618dc33718d9ac0468bdff8cc435859b5468aded` (#3241).

The Rust worker now runs initial planning, plan revision, and finalization
through the same claim, native admission, and durable outcome path as direct
Task rounds. Codex receives the existing model output schemas and prompt
material. Planning uses a read-only sandbox with approvals disabled.
Structured rounds publish the encrypted result after validating the output.

The result contains the reviewed plan and questions or the finalized plan
and Goal handoff. Finalization seals the objective to its native thread and
includes the existing encrypted start message and retryable startup failure
record. Blank plan and Goal prompt fields retain the Node reference's
fallback behavior.

A local macOS ARM64 smoke uses bundled Codex, an authenticated fixture peer,
and a loopback model provider. It compares all three prompts, output schemas,
and decrypted results with the Node reference. The native runtime rejects
a write to an owned fixture folder even when the turn requests the YOLO
profile. Revision and finalization reuse the planning thread. The Node
reference opens the finalized objective, start message, and failure record.

Goal activation after finalization, autonomous continuation, Task
attachments, effective policy bodies, and pause and resumption remain open.
Production still selects Node.


## 80. Activate the native Goal from finalized Task state

Reference commit `ef2f8f1fdcb56c268076a980fd2017971719b88f` (#3242).

The Rust worker handles the encrypted Task form of `chat.goal.create`.
It authenticates the finalizer's objective and start message, restores the
selected implementation permissions on the destination Codex thread, and
places the complete plan in the existing private, immutable attachment
layout. The native Goal objective references that file. The worker returns
the encrypted Goal snapshot and any requested control message. A startup
failure returns encrypted retryable Task state with its plan retained.

The worker reserves the first-input identity before reattaching an existing
thread, and parks automatic Goal inference for that exact native runner
while the canonical input is pending. An activation retry reads existing
native state and reuses a matching active Goal.

The local macOS ARM64 smoke finalizes a Task with bundled Codex and activates
the resulting Goal on the same thread. It opens the encrypted snapshot and
start message in Node, verifies plan bytes and private permissions, preserves
timestamps on retry, and rejects a mismatched source thread without making
another provider request. Core and the provider are disposable local peers.

The canonical first Goal turn, autonomous continuation, Goal observation and
controls, Task attachment and policy input, and pause and resumption remain
open. Production still selects Node.

## 81. Dispatch and commit the first Task Goal turn

The Rust worker opens the encrypted first Goal message under the bound
account and claims the existing Task input receipt. It takes Codex's native
root producer hold, retires a parked request for the same input, and waits
for the root to become idle before sending the explicit turn. The actual
thread, turn, and scope are bound to the receipt before the provider is
called. Live messages and the final relay are encrypted under the Task
grant.

The terminal result is persisted in the existing Goal outcome format. The
command waits for a matching canonical commitment or retirement. A receipt
for a different input leaves the original delivery pending for replay.

The macOS ARM64 smoke uses bundled Codex, an authenticated fixture peer,
and a loopback provider. It holds provider admission until the native
binding is acknowledged, opens the Goal response in Node, and verifies
that a mismatched acknowledgment keeps the command pending while the
worker retries the unchanged outbox record.

Autonomous Goal execution remains parked pending cycle authority, outcome
production, and settlement. Goal controls and observation, Task attachments
and policy input, pause and resumption, and full Rust-server integration
remain open. First-turn failures use the generic protected error until the
native Task retry categories are shared with the worker. Production still
selects Node.

## 82. Execute authorized autonomous Task Goal continuations

Reference commit `22552e0e61fdf7ed9239fabe81914661397732fc` (#3244).

After Codex accepts the explicit first Goal turn, the Rust worker can admit
autonomous continuations on the same native root. It binds the actual
private inference scope through the keeper, checks the current native Goal
epoch, and presents the keeper's source to the existing Core dispatch
endpoint. Core's acknowledgment must identify the original parent and the
exact native turn and scope. Only then can the native gate allow inference.

The worker observes that physical turn, reactivates its managed MCP
attachment for the turn, encrypts its result under the Task grant, and
writes the existing Goal-cycle outcome record. Each subsequent cycle
waits for its predecessor's canonical commitment or retirement. The
worker uses the same outbox scanner and replay format as the Node worker.

Local macOS ARM64 validation uses bundled Codex, an authenticated fixture
peer, and a loopback provider. Two consecutive autonomous turns run on
the original native thread. The fixture withholds dispatch acknowledgment,
returns a mismatched outbox receipt, checks the unchanged retry record,
and opens both published results with the Node codec. Shutdown during an
outstanding commit request preserves the record and lets the worker exit.
The next worker process retries the same result and removes it after Core
acknowledges it.

Reattaching autonomous Goal authority after a worker restart, Goal state
projection and controls, pause and restore, Task attachment and policy input,
and full Rust-server integration remain open. Production still selects Node.

## 83. Read native Goal state and project the encrypted Task

Reference commit `8f5a3c2bfb81fcb725b11889194c65c71f1bdc2d` (#3245).

The Rust worker implements `chat.goal.get` and returns the existing visible,
Chat-encrypted, and Task-encrypted responses. A prepared conversation uses
its current native runtime. A saved conversation uses a metadata transport
for the selected home. The read does not load or resume the thread.

The Task response can include the observed native execution status. Running
execution clears stale failure input to Task projection, and native Goal
completion takes precedence over stale failure or pause state. The worker
preserves the encrypted Task bytes when the projection has no changes.

The macOS ARM64 smoke exercises an absent Goal, a running Goal with a changed
provider display name, and saved active and completed Goals after worker
restart. It compares the decrypted Task and objective to the Node reference,
checks that metadata reads make no model calls, and also verifies Goal outcome
replay. Core and the provider are disposable local peers.

Goal mutations beyond Task activation, exact native pause proof, live Goal
resumption, OS-hosted Goal observation, and full Rust-server integration
remain open. Production still selects Node.

## 84. Apply native Goal edits, status changes, and clear

Reference commit `a3c42288f47600c935c3cb481f72aec429580a29` (#3246).

The Rust worker handles `chat.goal.update` and `chat.goal.clear`. A protected
edit opens the existing Chat envelope and updates the native objective while
retaining the Goal's status and budget. Pause and clear can act on saved
metadata without loading the conversation. Task resume restores the selected
permissions and reserves the canonical resume input before changing the Goal
to active. Task replies carry the encrypted Goal, projected Task state, and
resume message when requested.

Managed conversation mutations use Core admission and dispatch before sending
the native request. The worker settles the receipt with the encrypted reply,
a native rejection, or uncertainty when it loses the native response. The
request targets the retained native runtime and uses the current GUI activation
when one exists.

The macOS ARM64 smoke uses the real Rust worker and Codex processes with local
Core and provider fixtures. It covers pause after restart, wrong-envelope
rejection, an objective-only edit, canonical Task resume, managed admission
denial, encrypted clear settlement, and repeated clear. The existing Goal
execution and durable outcome checks run through the resumed Task.

Ordinary Chat Goal creation and autonomous execution, exact native Task pause
proof, restoration of a previously executing Goal, OS-hosted Goal controls,
and end-to-end Rust-server integration remain open. Production still selects
Node.

## 85. Create and replace ordinary Chat Goals

Reference commit `6a580e1b345066dae22806c2559ad21117528871` (#3247).

`chat.goal.create` handles the existing string-objective command. It can open
an ordinary host thread or use the conversation's managed preparation. The
worker preserves the objective and optional token budget in the native Goal
and returns the existing Chat response. Creation on the host path leaves
model input to Core's later turn dispatch. A managed request uses the operation
ID supplied by Core in the encrypted RPC frame and durable receipt. Replacing
a completed Goal clears it through a separate receipt before setting the new
objective. The worker respects Core's replay response before dispatch.

The macOS ARM64 smoke exercises a fresh host thread, reads the saved Goal
after restart, and replaces a completed managed Goal on the original native
thread. It checks both protected request and result digests through the Node
reference and confirms that a replayed receipt causes no native dispatch.
The test uses local Core and provider fixtures.

Canonical queue handoff and ordinary autonomous Goal turns, Project Goal
observation delivery, standalone scratch-workspace integration, live Goal
restoration, and OS-hosted Goal creation remain open. Production still
selects Node.

## 86. Publish native Project Goal observations

Reference commit `5509fd6bdd748acaffa57c1feb742da393ab3069` (#3248).

The Rust worker observes Goal updates and removal from the selected native
transport. It seals objective text with the Chat content grant and writes
each transition to the existing per-thread Project Goal outbox. It replays
the existing encrypted facts in order, waits for the server's disposition,
and retains an unbound source or an observation whose response was lost.
Known Task threads use their separate encrypted Task path. Managed
preparation and Goal changes select the source, while a read alone does not
register an unattached thread. Project delivery does not load a native thread or initiate model work. A managed producer
request without an owner receives the exact native denial so it cannot hold
later Goal controls.

The macOS ARM64 smoke covers active, paused, and cleared native facts, the
same pending bytes after restart, and recovery of a legacy record produced by
the Node writer. It opens the protected objective through the TypeScript
reference. The worker and Codex are real local processes, with disposable
Core and provider fixtures.

Ordinary Goal autonomous admission and queue handoff, live Goal recovery,
and OS-hosted Goal support remain open. Production still selects Node.

## 87. Run autonomous managed Project Goal turns

Reference commit `106112c71160cf97bb87e0ce935b52f82885a818` (#3249).

A prepared project conversation registers the exact native Goal runner.
Before releasing a producer request, the Rust worker checks its native
settings against the selected workspace and permission profile, reads the
canonical queue, and obtains Core admission and dispatch for that attempt.
A matching first-cycle queue claim is carried into admission. Local provider
capacity, MCP authority, and the actual native thread and turn stay bound to
the admitted operation. A later cycle waits for the preceding settlement.

The worker publishes protected Chat events with canonical History identities
and seals the terminal result in the existing native-command receipt format.
The native producer response is recorded separately from terminal evidence.
A request that never reached the native producer can close as rejected. An
explicit native decline must match the outstanding runner, attempt, turn, and
operation generation.

The macOS ARM64 smoke runs two actual Codex Goal turns, holds Core dispatch
and the first terminal acknowledgment, and checks the matching queue handoff,
protected events, exact receipt retry, and durable History source. Core and
the provider are disposable local peers.

Queued Goal mutation dispatch, cold recovery of live or unsettled Goals,
provider transfer, and broader OS-hosted/interaction parity remain open.
Production still selects Node.

## 88. Execute queued managed Project Goal mutations

Reference commit `2f979ad0435cff196f8fbbcbc234fa22e0d7e1cd` (#3250).

The Rust worker handles Goal setters and clears through Core's existing
`chat.queue.execute` command. It opens the protected pending message and
authenticates any retained native input against its server, chat, and prompt.
It applies current text and attachment selections and writes rich or oversized
objectives in the chosen runtime's private home. `/goal pause`, `/goal resume`,
and `/goal clear` map to the native controls. Queued objective setters keep
Codex's implicit status and use the queue claim as the operation identity.

Core receives the claim and prompt revision before native dispatch. An
autonomy-enabling setter settles with the exact protected native response and
its Goal epoch. The first autonomous turn can then hand the same claim back
to Core. A setter that may have applied without returning an epoch settles
as uncertain.

The local macOS ARM64 smoke opens Node-produced ciphertext for an edited
queued objective, verifies the retained media and spilled objective, rejects a
mismatched prompt ID, and exercises the setter, two real native turns, exact
terminal receipt retry, and queued clear. It uses local Core and provider peers
with the real Rust worker and bundled Codex.

Queue preparation and wake notifications, general queued commands and model
inputs, and cold Goal recovery remain open. Production still selects Node.

## 89. Prepare edits to retained native queue inputs

Reference commit `5ce2aab1a0975e753d57f6cc863b75810064b767` (#3251).

The Rust worker accepts Core's `chat.queue.prepare` command for encrypted
queue edits. It opens the pending native vector against the selected server,
chat, and prompt, reconciles changed text and attachments, and preserves
unedited GUI and retained terminal input. Edits can change Goal, plan, and
shell classification. Any mode change updates both protected display and
pending message envelopes while preserving the queue and message identities.
Queue preparation and Goal execution share the native vector decoder and the
generated contract for the existing encrypted format.

The local macOS ARM64 command-socket fixture compares the opened Rust result
with the Node codec for edited text and media, native spans, attachment
selection, slash mappings, and legacy prompts. It hands the normalized
encrypted Goal to the real Rust worker and bundled Codex for two autonomous
turns and queued clear. Core and the provider are local fixture peers.

Queue wake notifications, scheduling and execution of general queued inputs,
and cold Goal recovery remain open. Production still selects Node.

## 90. Run Core-claimed queued model turns

Reference commit `4c2d11906f72556dee9a1209031bfa5da5de25d3` (#3252).

Core's existing `chat.turn` path accepts a queued item with its admitted native
receipt. The worker opens the retained vector using its exact chat and prompt
identity, strips a native `/plan` prefix while preserving rich items and
rebasing UTF-8 text spans, and keeps the native client message identity. Worker
attachments already carried by the vector are excluded from local projection.
Legacy queued prompts use their protected message and local attachment paths.
The existing dispatch and History paths produce the native turn acknowledgment
and canonical output. A native `pendingSettings` response that explicitly
reports no input consumption records a deferred settlement against the same
claim.

The macOS ARM64 smoke exercised the real Rust worker and bundled Codex with a
retained plan vector and image, a legacy queued text turn with a protected file
reference, queue identity checks, exact receipt retry, and durable History.
Core and the model provider were local fixture peers. Rust unit tests checked
byte-span rebasing and the exact native no-consumption discriminator.

Queue wakeups, native queue management and cutover, non-Goal queued settings
and shell actions, and cold Goal recovery remain open. Production still
selects Node.

## 91. Wake native Project Goals from Core queue notifications

Reference commit `7fe0a71d217f5c5939ae5756d3174824bed550d8` (#3253).

The Rust worker accepts `chat.queue.changed` for ordinary host queue delivery.
It wakes the bound inference recovery manager and reads Core's latest queue
for the current native Goal owner. It observes Pause and runnable FIFO items
and preserves the first cycle of a settled queued Goal setter. Before using
the snapshot it verifies the same thread, runtime, and runner generation.
The worker awaits the native wake response when a wake is due and returns a
failure when the queue read or wake fails, so Core retains the revision.

The macOS ARM64 smoke denied a real native attempt while the queue was paused,
received a queue notification after unpausing, and ran two native Goal turns.
It checked the original first-turn claim against a later runnable item and
retried the same revision after a failed Core read. The fixture used the real
worker and bundled Codex with local Core and provider peers. A Rust unit test
covered FIFO eligibility, a stale rejected revision, and the first-cycle
claim conditions.

Task pause notifications, native queue management and cutover, non-Goal
queued actions, and saved Goal recovery remain open. Production still
selects Node.

## 92. Apply queued Plan Mode with durable settings evidence

Reference commit `ca0d4c49168d6f9e1410c9e6b2ca7f526ca1090d` (#3254).

The Rust worker handles a queued `/plan` action without model input on its
bound managed thread. It gets the Plan Mode settings from the native runtime
and uses the queue claim as the operation identity. Core admits and dispatches
the mutation before the worker sends the native request. The protected receipt
carries the actual native acknowledgment used by the canonical queue.

The worker tracks settings application separately from the acknowledgment. It
matches native notifications to the thread, runtime, operation, and submission.
The shared crypto crate seals evidence with the existing event-bound format.
The worker retains exact encrypted evidence until Core acknowledges it and
replays pending evidence and interrupted registrations from the existing
worker data directory.

The local macOS ARM64 smoke exercised the real worker and bundled Codex with
local Core and provider peers. It held Core dispatch, opened the Rust evidence
with the Node codec, checked that no model turn started, and replayed the exact
applied evidence after restart. It also recovered a Node-written registration
as uncertain and verified that an existing receipt prevents redispatch. The
worker build, Clippy, affected server compilation, and focused worker contract
tests ran locally.

Queued shell execution, Task pause notifications, native queue and gateway
cutover, saved permission recovery, and cold Goal recovery remain open.
Production still selects Node.

## 93. Execute Core-claimed queued shell commands

Reference commit `55b99273cc56884db899581424dfe21186567a1c` (#3255).

The Rust worker authenticates the retained shell input against its chat and
prompt and removes only the native UI's leading `!`. It preserves quoting
and multiline input. Shell execution requires the same full-access profile
as Node. Core rechecks the profile at dispatch and grants the operation its
own lane. The worker checks the grant's thread, placement, route, and
workspace before forwarding anything to Codex.

The worker returns the native RPC acknowledgment as soon as its protected
receipt is recorded. It keeps observing the exact native turn, binds that
turn for managed Stop, and reports completion with a separate protected
terminal receipt. History capture records the shell output under the
admitted operation. Replayed queue claims do not forward the command again.

The macOS ARM64 smoke ran bundled Codex with a real shell and local Core and
provider peers. It compared the protected request with the Node queue
materializer, held Core dispatch, checked early acknowledgment and exact
Stop correlation, dropped terminal receipt responses to verify exact
retry, and reopened saved History with Node. The worker build, Clippy, and
focused Node contract tests passed locally.

The native queue and gateway cutover, live terminal-style command telemetry,
cold recovery of unsettled shell executions, Task pause notifications, and
saved permission and Goal recovery remain open. Production still selects Node.

## 94. Apply Task pause notifications to the current native owner

Reference commit `61e6d26329ae13e23d731709d614303e4c06d56c` (#3256).

The Rust worker applies the Task pause intent carried by Core's
`chat.queue.changed` command. It retains the newest intent for the worker's
authenticated chat, ignores stale deliveries, and rejects conflicting
decisions at the same revision. For an attached Task it matches the
placement, native thread, and runner before applying the revision and checks
the native acknowledgment before acknowledging Core. A Task prepared later
inherits the admission hold.

Pause parks eligible pending inference. Fresh private inference waits for
Resume without acquiring capacity. Resume releases the worker hold after
the current native gate acknowledges it. Fresh autonomous Goal admissions
also adopt the new FIFO order epoch for the same canonical cycle.

The macOS ARM64 smoke held a real Codex Goal request during Pause and
released it after Resume. It tested duplicate and stale notifications, a
conflicting revision, and a mismatched worker. Two subsequent autonomous
Goal turns used the updated queue order and completed against local Core
and provider peers. A Rust test covered the admission hold, revision
ordering, and cancellation.

Direct Task boundary controls and durable suspension checkpoint capture
and restore remain open, along with native queue and gateway cutover.
Production still selects Node.

## 95. Protect native checkpoint resources on the owning Codex connection

Reference commit `c30c814261f6d1bbc81b62c423d9cb113a4e4cc1` (#3257).

The Rust worker answers Codex's private native resource requests on the
connection that owns the runner. Managed thread preparation registers the
runner and thread version before reattaching a known thread. The worker
chooses the Chat or Task component from the actual gate. It seals with the
current grant and opens with the envelope's exact key revision. Replaced
runners and worker bindings cannot receive the result. Invalid resources
from the current runner receive the native denial response.

The shared crypto crate implements the existing Chat and Task envelope
formats and binds them to the authenticated server, owner, worker principal,
thread, turn, and checkpoint. The resource domain stays distinct from the
worker's suspension source record. Private request values and resolution
payloads stay out of ordinary History and RPC diagnostics.

A local Rust test exchanged seal and open requests over the owned native
WebSocket and checked denial, runner fencing, and diagnostic redaction.
Node and Rust opened each other's resource envelopes and rejected mismatched
context and suspension-source ciphertext in the protected content fixture.

Direct Task boundary controls, committing the worker suspension source record,
and live and cold restoration remain open. Production still selects Node.

## 96. Preserve worker suspension records and attach held Chats

Reference commit `6d88983a48f1af17806fae79d5c1102aac2e01e0` (#3258).

The Rust worker reads and writes the existing immutable suspension source
records. It preserves the legacy Chat record, the Chat record with worker
bookkeeping, and the Task record with its original round or Goal publisher.
The storage locator, filesystem layout, component grant and derived key
match Node. Repeated writes authenticate the published record and retain
the original evidence and home. The storage contracts are generated from
the Node schemas using `scripts/worker-rust/suspension-storage-contracts.mjs`.

For an existing held Chat, preserving thread preparation opens the
Core-selected locator under the current worker grant and supplies its
authenticated home and exact descriptor to Codex. It reuses the selected
live runtime for the same conversation and home when available. The runtime
version and fingerprint remain diagnostic. Metadata attachment retains
the native hold and does not grant execution.

On macOS ARM64, Node and Rust opened each other's records in all three
formats, including direct Task and autonomous Goal continuations. The
fixtures checked immutable retry, changed source and home, grant removal,
and invalid continuation identities. Bundled Codex attached through the
Node-written locator after worker restart. The smoke checked a missing
locator, a mismatched descriptor, and Codex's hold when the native
checkpoint bytes were absent. Seventeen existing Node tests passed.

Durable Pause and Resume still need to capture and restore the actual
native turn and the worker's saved bookkeeping through production
controls. Full Task boundary handling and the production cutover remain open.

## 97. Capture a durable Chat checkpoint and resume its live owner

Reference commit `08c6ce56eb8354f712611d95f645f3fa7d73dcd0` (#3259).

Managed GUI Chat Pause obtains and dispatches a separate Core receipt for
the exact active turn. It holds new inference for the chat, requests the
native suspension boundary, and snapshots the worker observer after the
earlier native notifications. It saves the continuation under the current
worker grant and checks the checkpoint with Codex before settling the
receipt. A lost dispatch acknowledgment leaves native work untouched and
reports uncertain settlement. An unanswered or failed checkpoint operation
retains the hold for recovery.

For an attached owner, `chat.suspension.resume` binds the exact Core
control ID and confirms the held checkpoint with Codex before resuming
the existing turn. The observer, native turn identity, and logical
result publication stay with the original execution.

The macOS ARM64 smoke used bundled Codex with local Core and provider peers.
Node opened the Rust-written continuation and recovered pre-Pause text.
The smoke exercised a lost dispatch acknowledgment, repeated receipt
settlement, stale Resume authority, and completion on the original turn.
The Rust worker build, strict Clippy, 126 compatibility comparisons, and
32 Node reference tests passed locally.

Cold restoration through the dedicated Resume command, durable Stop, and
Task boundary capture and resumption remain open. The saved continuation
contains the progress tracked by the current Rust Chat observer. The
remaining observer parity and production cutover are still in scope.

## 98. Restore suspended Chat execution after worker restart

Reference commit `a46398a3fe3b91a6635728ea8ab00e21f85359cc` (#3260).

The Rust worker opens the authenticated continuation, attaches to the
recorded Codex home under its execution hold, and registers a fresh
observer with Core. Observer admission retains the original native
operation and logical root. The separate Resume receipt authorizes the
exact saved checkpoint. Duplicate requests join the same local Resume.
If Core commits admission before losing its response, the worker retries
the same protected admission.

The restored observer starts with the saved text, usage and pending
messages. It publishes protected output against the original History
provenance and reports completion only after observing the original
native turn end. The Resume response can precede terminal publication
while the worker continues owning the operation.

The macOS ARM64 smoke stopped the Rust worker and Codex while the turn
was held, restarted both, and finished the same turn. The local Core and
provider peers verified stale control rejection, duplicate delivery, a
lost admission response, the original input appearing once in the
provider request, and protected output and terminal receipt replay.
A focused Rust test verified saved text remains available when the
restored turn completes without new output.

Durable Stop, Task checkpoint capture and restoration, and the remaining
observer parity are still open. Production cutover and the final
Rust server and worker acceptance remain in scope.

## 99. Stop suspended Chat execution in the Rust worker

Reference commit `958958b2ca7d60404736c989a21c60c03e5168e8` (#3261).

The worker handles the existing live interrupt and the named
`chat.suspension.stop` command. A named Stop matches the saved Chat,
placement and native turn, and passes the exact Core control ID. After
restart, the worker opens the authenticated worker record, attaches to
the recorded Codex home under the hold, and admits a protected observer
with the original input provenance. It issues `turn/interrupt` against
that turn and settles from native terminal history. No provider capacity
or resumed model execution is needed to stop a cold turn. Concurrent
copies of the same named Stop share a result.

Durable control admissions carry the worker generation. Resume also
carries the explicit request to resume autonomy required by Core.

Local macOS ARM64 tests used the real Rust worker and bundled Codex with
Core and provider peers. They verified live and cold Stop, stale and
duplicate controls, protected receipt replay, and terminal history for
the original turn. A cold Stop preserved an unreadable native checkpoint
while committing the interruption and making no further provider request.
Live and cold Resume, protected Chat receipts and queued-shell Stop
passed in the same run.

Task checkpoint capture and restoration, remaining worker parity, and
production cutover remain open.

## 100. Capture checkpoints for explicit Task inputs

Reference commit `2c2baad7c0c5fc5891b48875309b992fa1d6acf8` (#3262).

The Rust worker now handles the Task form of `chat.pause.set` on the
private Codex gate. Nonwaiting commands acknowledge the admission latch.
Boundary commands match the selected thread, revision and explicit Task
input. The response identifies the same worker and inference-admission
generation that Core recorded at native binding. Live Resume applies
the newer revision to the current gate.

A durable Pause waits for the selected native turn's checkpoint and saves
its worker continuation in the existing Task-content protected format.
It keeps the original opaque round request or first Goal publication,
its output mode and the protected message identities already observed.
Retries of the same pause revision confirm and return the same native
checkpoint and storage ID.

The macOS ARM64 smoke ran the real Rust worker and bundled Codex with
local Core and provider peers. It stopped a direct Task at a tool
boundary, checked that the provider request count held, and opened the
saved source with Node's suspension store. It checked the bound actor,
repeated Pause, a protected message identity, and continuation of the
same native turn through live Resume. Chat Pause and Resume, Task Goal
pause notices and execution, structured Task results, and 22 focused
Node reference tests passed.

Autonomous Goal checkpoint capture, post-restart Task restoration,
durable Task Stop, and production cutover remain open.

## 101. Capture checkpoints for autonomous Task Goal cycles

Reference commit `9edd54d60a5469c165048dcb96a9738fdb489223` (#3263).

Each admitted autonomous Goal turn keeps a checkpoint observer on its
current private Codex runner until native observation ends. A Task
Pause with a Goal source matches Core's source key, operation, Goal
epoch, inference scope, placement and exact native turn. It shares the
existing encrypted checkpoint path with explicit Task inputs and
returns the same evidence for a retry of the current revision.

The checkpoint uses the admitted Goal cycle source, canonical parent
prompt, publication identity and protected messages observed for the
active turn. The Pause and live Resume responses retain the actor
recorded in the Goal's admission. Starting a subsequent cycle still
waits for Core's acknowledgement of the predecessor's outcome.

On macOS ARM64, the real Rust worker and bundled Codex paused the
autonomous Goal at a tool boundary with local Core and provider peers.
The fixture verified mismatched source rejection, identical repeated
Pause evidence, no provider continuation during the hold, and a
Node-readable checkpoint with the expected prompt, publication and
message identity. Live Resume continued the same turn and committed
its original publication. The same run exercised direct Task Pause
and Resume, structured Task results and autonomous outcome replay.
Twenty-two focused Node reference tests passed.

Task restoration after restart, durable Task Stop and production
cutover remain open.

## 102. Restore a suspended Task after worker restart

Reference commit `906b079601905ac3352e7e864147f7dfc0bae45f` (#3264).

The worker opens the protected continuation against the original Task
input or autonomous Goal source, placement, model route and native turn.
It verifies the protected request or prompt and publication, restores
the message identities, and attaches to the saved Codex home under the
execution hold. A fresh Core receipt claims and dispatches that physical
execution. Once Core acknowledges the native inference binding, the
worker emits the existing Task Resume event for the original turn. Only
the native suspension Resume is sent to Codex. The original prompt and
tool actions stay in the native history.

Restored Goal execution retains its canonical parent and publication.
A subsequent autonomous turn waits for the restored outcome to commit.
A resumed Task can be checkpointed against its original source and
current physical actor. Shutdown with an unobserved terminal state
preserves a checkpointed Task for recovery and leaves its outcome open.

The macOS ARM64 smoke used the real Rust worker and bundled Codex with
local Core and provider peers. It restarted both processes for a direct
Task and an autonomous Goal, waited for Core's fresh native binding, and
continued the same turns. It exercised a rejected checkpoint, a direct
Task continuation sealed with Node's reference store, and recapture
with the original source, preserved message ID and fresh actor. It also
covered protected results and the next autonomous turn's outcome commit
barrier. The same run
covered Chat recovery, Task pause notifications and structured Task
execution. Twenty-two focused Node reference tests passed.

Durable Task Stop and production cutover remain open.

## 103. Stop live and saved Task turns in the Rust worker

Reference commit `e58044f6fd4c455ef7da83ba000d8a135b21104f` (#3265).

A named Task Stop closes new admission at Core's current revision,
targets the original native turn, and returns the stopping control's
actor and committed native outcome. Live Stop uses the attached private
runner even when launch settings are unavailable. Cold Stop uses the
authenticated Task source and saved home. When the worker's local
record or its Task-content grant is unavailable, it tries the authorized
provider home with the exact native checkpoint. Codex must still prove
the selected turn's terminal state.

The raw Task interrupt uses the current private runner and revision,
cancels eligible waiting work, and settles active execution through
Codex. A missing model route does not prevent interrupting the attached
Task. Named retries read the existing terminal history.

Local macOS ARM64 smoke ran the Rust worker and bundled Codex with
Core and provider peers. It exercised live named Stop, raw interruption
without a model route, a cold direct Task with a missing worker record
and damaged native checkpoint, and a cold autonomous Goal matched to
its saved source. It also covered stale or unrelated input, duplicate
requests, and replay of the stopped turn after a further restart.
The cold fixture preserved the damaged native bytes. The provider
request count stayed unchanged during named Stop. Restart Resume for
Chat, direct Tasks and autonomous Goals and 19 focused Node reference
tests also passed.

Broader worker parity, service packaging and production cutover remain
open.

## 104. Preserve standalone Chat scratch folders in the Rust worker

Reference commit `3e818c8c619c1e34adb34d8f275f6087384603f3` (#3266).

The Rust worker now provisions, resolves, archives, restores, reconciles,
and deletes standalone Chat scratch folders. It reopens the Node worker's
version 1 registry and directory layout, keeps path metadata behind the
existing routing handles, and persists the root binding before directory
creation so interrupted provisioning can retry. Reconciliation reports
missing, due, and orphaned roots to Core. Permanent removal requires the
registered root and chat identities.

Local macOS ARM64 validation used the linked Rust worker with an empty
PATH and the linked Rust server with PGlite. A public standalone Chat
creation and permanent deletion both reached successful Core job
settlement. The worker recovered stale archive state after reconnect and
retained a nested file across archive and restore. Focused Rust tests
covered reopening the Node registry format, resolution, replay, and
rejection of unregistered directories and symlink targets.

Standalone Chat file operations and full model execution through the
production Rust pair remain open, along with production cutover.

## 105. Run the default standalone Chat turn through both Rust services

Reference commit `945d37f6b869e79fcd114ac61953794c66454178` (#3267).

A claimed first-message title now runs through Codex's stateless inference
RPC. The same provider shares the response's inference grant. A separate
labeling provider finishes its own preparation first. The worker opens the
protected user message and seals the normalized title with its authorized
display-label key. Failure returns a null title outcome so Core can close
the claim and continue the reply.

Local macOS ARM64 validation used the public API, the linked Rust server
with PGlite, the linked Rust worker with an empty PATH, bundled Codex,
and loopback providers sending Responses SSE. The client recovered the
encrypted title and stored messages for both provider selections. An
unusable label preserved the initial title and the completed reply. An
identical submission replayed the stored user message without a second
provider request.

The separate background `label.generate` command used by Task naming,
other worker domains, and the production cutover remain open.

## 106. Generate protected Task titles in the Rust worker

Reference commit `198efeb85e9c8d902c7501160c24e0feb8ea2252` (#3268).

The production worker handles the background `label.generate` command.
It uses Core's resource authorization before opening the protected
input, immediately before the native request, and before returning a
successful result. The authenticated Task brief uses the same decoder
as Task preparation. Empty briefs return the existing empty-input
result without starting inference. The existing stateless Codex path
normalizes the title and seals it with the worker's display-label key.
If the resource disappears during inference, the native response still
settles the reservation and the authorization check rejects publication.

Local macOS ARM64 validation used both Rust services, PGlite, bundled
Codex, and the loopback model fixture with an empty worker PATH. The
public APIs admitted an empty draft, queued and named a paused Task
after the brief was filled, and deleted another draft with naming in
flight. The paused Task stayed queued. Core rejected publication for the
deleted draft. The standalone Chat naming and replay cases still passed.

General inference resource-revocation delivery, provider catalog and
configuration commands, and production cutover remain open.

## 107. Apply Core provider limits and publish the Rust inference queue

Reference commit `6f46f2634777a450fb1ba682d316e3435fd568f8` (#3269).

The production Rust worker handles `inference.configure` and
`inference.status`. Core's revisioned configuration, legacy updates,
and Codex launches share the same manager for the authenticated server
and owner. Core can fetch the authoritative snapshot and receives live
queue changes from that manager. Configuration delivery also republishes
the current snapshot on reconnect.

Local macOS ARM64 validation used both Rust services, PGlite, bundled
Codex, an empty worker PATH, and a controlled Responses endpoint. The
limit of one arrived before either Chat turn. The HTTP snapshot and
public Live stream showed the second turn waiting at position one.
Raising the limit to two let the second request reach the provider
while the first was still held. Both replies persisted and both
slots were released. The existing Chat and Task naming cases passed in
the same run.

Provider model discovery, general resource-revocation delivery, and
production cutover remain open.

## 108. Discover compatible endpoint models in the Rust worker

Reference commit `17e480be2c9acc0bc5155177e8ccbf246f2c6f16` (#3270).

The Rust worker handles `model.endpoint.catalog`. It authenticates with
the worker's protected provider credential, follows same-origin provider
continuations, and normalizes model capabilities before returning them
through Core's paged catalog contract. Catalog snapshots share concurrent
loads, keep each transfer's cursor separate, and are bounded by size,
concurrent discovery, and expiry. Legacy callers receive the complete
legacy inventory when it fits the existing limits.

LM Studio and LiteLLM can enrich the standard catalog. Unavailable or
invalid enrichment leaves the standard catalog intact and tells Core to
retain prior observations. LiteLLM contributes normalized capabilities
only for aliases advertised by the standard endpoint.

Local macOS ARM64 validation used both Rust services, PGlite, an empty
worker PATH, and authenticated loopback endpoints. Core received 206
models over multiple worker pages, retained prior models after a
malformed overlay, and served its cached catalog when an endpoint
returned a redirect. LiteLLM discovery preserved capability metadata
and excluded private deployment fields.

Ollama discovery, provider operation adapters, inference
resource-revocation delivery, and production cutover remain open.

## 109. Discover Ollama models in the Rust worker

Reference commit `4869413481f597f938e971fd0a46c56006e5405b` (#3271).

The worker handles `model.ollama.catalog` using the same protected
credential, request bounds, and transfer-scoped snapshots as compatible
endpoint discovery. It reads the native tags and show endpoints beneath
the configured URL prefix and limits each discovery to four concurrent
show requests. It retains the tags order and normalizes model details,
capabilities, dates, and byte counts. The legacy response schema remains
available within its existing limits.

Local macOS ARM64 validation used both Rust services, PGlite, bundled
Codex, and an empty worker PATH. The settings API received 203 Ollama
models over multiple pages and exposed context, vision, thinking, and
tools capabilities with the expected normalized metadata. A failing
show request preserved the previous catalog and marked it stale.
The compatible endpoint discovery and standalone turn cases passed
in the same run.

Provider operation adapters, inference resource-revocation delivery,
and production cutover remain open.

## 110. Revoke native inference when Core removes a resource

Reference commit `8dbc793aac41716c4a902f02f92b22b935e34506` (#3272).

The Rust worker handles `inference.revoke` in its verified owner and
server scope. It matches a deleted chat or a deleted project and its
captured chat IDs. It seals active preparation, revokes matching managed
inference and MCP authority, removes cached Task pause and Goal producer
state, and wakes admission recovery. Requests from a revoked native
thread cannot use its previous managed binding.

Queued work can be cancelled locally. An already dispatched execution
retains its reservation until the native finish boundary or confirmed
process exit. The adapter sends the exact thread and turn interrupt
through the owning session and retries within that generation when
the native request fails. A repeated Core delivery does not create
another retry owner.

Local macOS ARM64 validation used the Rust server and worker, PGlite,
bundled Codex, and an empty worker PATH. Deleting a Task through Core
interrupted a held provider stream and removed the Task. The admission
test exercised project matching, duplicate revocation, unrelated work,
and the private finish boundary. Existing Chat history, private labels,
catalog discovery, and MCP attachment coverage passed.

Task-input route revocation, provider operation adapters, and production
cutover remain open. Computer-use and OS-hosted execution need their
respective revocation integrations as those worker services are ported.

## 111. Drain an exact Task input during a provider transfer

Reference commit `f5234859d8522e9f76b982c28c93116c4b16155c` (#3273).

The Rust worker handles `inference.task-revoke` against the existing
Task turn owner. It matches the authenticated namespace and full
canonical input receipt, including the dispatch fence. The former
attempt cancels preparation and releases or interrupts only its own
admission. Its owner remains registered through physical settlement.
The settled notification wakes Core's durable route delivery, and the
worker joins its actual native ownership keeper before confirming that
a missing live owner is settled. The revoked input does not publish a
Task outcome over the replacement.

Local macOS ARM64 validation used both Rust services, PGlite, bundled
Codex, and an empty worker PATH. A held Chat exhausted the source
provider's capacity. Core transferred a queued Task to a second
provider, which received the same input while the Chat retained its
source reservation. The revoked attempt made no provider request.
Deletion revocation and the preceding standalone, catalog, capacity,
and title cases passed in the same run.

Provider operation adapters and production cutover remain open.

## 112. Run protected embedding operations in the Rust worker

Reference commit `7413f8610332ca9ad9588bf349c9fce79af91ee4` (#3274).

The Rust worker handles `model.embedding` and `model.operation.cancel`.
It opens the request and seals the result with the existing endpoint
grant and model-operation context. All seven existing embedding
adapters preserve provider-native request forms, vector shapes, token
observations and the canonical embedding-space fingerprint. Each batch
rejoins the same provider admission queue used by other worker inference.
The worker shares active duplicate delivery and retains replay metadata
after the encrypted result is released.

Local macOS ARM64 validation used both Rust services, PGlite, bundled
Codex, an empty worker PATH, and an authenticated loopback provider.
Through the public API the smoke test exercised encrypted multi-batch
results, reversed provider indices, fingerprint pinning, reported and
unknown usage, replay, cancellation of an active provider response,
a sanitized HTTP 429, and redirect rejection. Focused native tests
exercised all seven adapter payloads and response shapes. The Node reference
verified the same two-batch result ordering, usage and pinned space.

Decision adapters and production cutover remain open.

## 113. Run protected decisions in the Rust worker

Reference commit `dbb130bb8902da6ca800aaeb9f875d7b8dd83652` (#3275).

The Rust worker handles `model.decision` through the same sealed
operation dispatch, provider admission, cancellation, replay and
usage reporting as embeddings. OpenAI Decisions, System One and
OpenRouter Decisions preserve their native question and media forms.
The worker returns predicate, choice and score answers in question
order, preserving distributions, refusals, partial errors and native
answer metadata. TypeSafe assets use fresh references for shared and
question-specific images.

Local macOS ARM64 validation used both Rust services, PGlite, bundled
Codex, an empty worker PATH and an authenticated loopback provider.
The public API smoke test covered all three adapters, encrypted
results, duplicate-question validation, malformed provider answers,
replay, cancellation and usage export. A local run of the Node
reference matched the three adapters' request formats and normalized
answers in the representative cases.

Worker runtime parity and production cutover remain open.

## 114. Open host shell terminals through the encrypted relay

Reference commit `a3bb26a8919b09268045ea4b0a24b96345d8877a` (#3276).

The Rust worker opens host shell terminals from their existing encrypted
directory record and opaque worktree route. The public relay supports
protected output and input, PTY resize, detach and reattach, exit and close.
The worker keeps the same shell across view detach and discards queued
terminal frames when their control socket disconnects. Terminal output
remains bounded. Relay attachments receive replay before the ready marker.
The shell actor owns and reaps the process and publishes its exit.

Replay retains the complete output sequence while it fits at the original
size. A native VT grid supplies a bounded redraw after resize or truncation.
The worker also exposes an encrypted bounded text snapshot of host shell output.
Service reconciliation coordinates ownership before replacing a host shell
with a service.

Local macOS ARM64 validation used both Rust services, PGlite and an owned
workspace with a worker PATH containing no Node executable. The terminal-only
smoke exercises encrypted I/O, resize, replay and same-process reattachment,
natural exit, deletion, and existing service restart and recovery. The Node
terminal manager matched the representative shell lifecycle.

Full xterm reflow, saved alternate-buffer restoration after resize or
truncation, and exact PTY signal metadata remain open. Service view
attachment, managed Codex consoles, direct and WorkerLink adapters, delegated
OS terminals, run configurations and production cutover remain open.

## 115. Attach encrypted terminal views to host services

Reference commit `161c32429b6fa783f5f16c97732e61cd2abf7831` (#3277).

The Rust worker attaches the existing encrypted terminal relay to the
supervised service PTY for the authenticated owner, server and source folder.
Shells and services share protected presentation and replay. Active views
keep their output sequence across child-process replacement, and new views
replay the current attempt. The worker forwards protected input to the
current child, applies PTY resize, and keeps the selected dimensions across
retries. Service snapshots include the bounded output tail and restart
status. Disable settles attached views and retires the owned process.

In local macOS ARM64 validation, the public API and relay ran through both
Rust services, using PGlite and an owned workspace with no Node executable
on the worker PATH. The fixture exercised protected input and output, an
explicit restart, a natural exit and automatic restart, attachment and
resize during the retry delay, worker restart recovery and disable. The
native service lifecycle tests and a representative Node terminal manager
comparison exercised the same process boundaries.

Managed Codex consoles, direct and WorkerLink transport, delegated OS
terminals, full xterm replay and signal parity, and production cutover
remain open.

## 116. Store and discover project Run configuration definitions

Reference commit `9491b80dee962bed54cab939309bf0e497409f5b` (#3278).

The native worker resolves the registered Primary source and supports
`project.run-configuration-definitions.get`, `.write`, `.delete`, and `.paths`.
It reads the existing `.cantrip/run-configurations` documents and hashes their
actual bytes for revisions. Writes use the existing normalized document
format, exclusive creation, atomic replacement, and revision and name
conflict outcomes. Path suggestions retain purpose filtering, ranking,
generated-directory exclusions, and scan bounds. The worker inspects Codex
environment metadata without running setup scripts.

The definition observer tracks external edits on the registered source. It
uses native filesystem events and a bounded scan fallback. Notifications
carry the route and changed definition identity and revision. The observer
keeps compact change metadata, with no retained definition bodies.

The local macOS ARM64 smoke enrolled the Rust worker into the Rust server
with PGlite, imported a checkout, and compared public responses and exact
file bytes with the Node definition service. It covered path searches,
creation and retries, conflicts, environment status, an existing unsupported
provider, a symlink rejection, reads across a worker restart, and deletion.
The worker's PATH contained no Node executable. Unsafe definition paths
retain the `file-invalid` diagnostic, with native error wording. The
focused Rust test checks that external file changes produce the existing
notification shape without document contents.

Provider discovery and validation, the full definitions list, Flutter
device inspection, run execution and encrypted output, Cantrip OS run
integration, direct and WorkerLink delivery, and the production cutover
remain open.

## 117. Launch and supervise Host shell Run configurations

Reference commit `72a79a20389fc1f373228c5a9ed8bf37941ded56` (#3279).

The worker handles the Host Run start, restart, stop, status, output, and
reconcile commands for the shell provider. Core retains the durable
admission and generation. The worker verifies the exact Primary definition
revision and authorized worktree, applies platform overrides, inspects and
captures the admitted Codex setup, loads bounded dotenv files, opens
project-bound secrets, and executes before-launch steps and the command in
owned PTYs. Restart joins the old process before launching its replacement.
Project and worktree removal use the same worker-owned retirement path.

The output tail is bounded in UTF-16, redacts secret matches across native
read boundaries, and uses the existing `run-content` response envelope.
Unix stop uses the owned process group, applies the configured grace
period, and reports the signal from the reaped PTY child.

The public API smoke ran on macOS ARM64 using the Rust server with PGlite
and the Rust worker with no Node executable on PATH. It exercised real
setup and before-launch commands, layer precedence, secret redaction,
encrypted output, idempotent lifecycle delivery, stop and restart with
reaping, and lost-state reconciliation after worker restart. A natural
exit and its output matched the Node supervisor. Focused native tests
covered output redaction and worktree inventory behavior. The existing
encrypted shell and service terminal relay smoke passed with the shared PTY
changes.

The other Run providers and their discovery and validation, CLI connection
environment, Cantrip OS execution, direct and WorkerLink delivery, and
production cutover remain open. Windows currently uses the available
ConPTY job retirement path. Its graceful-stop parity and Windows and Linux
runtime validation remain open.

## 118. Discover, validate, and run typed Node project configurations

Reference commit `daddc69291cb0294d08c0e59253d3d7647524274` (#3280).

The Rust worker discovers package scripts and entrypoints from bounded local
`package.json` files. It preserves discovery ordering, package-manager
selection, dependency-directory exclusions, and symlink restrictions.
Definition capabilities, validation, and inventory are wired for the shell
and Node providers. Inventory validation still requires a native validator
for every ready definition in a project.

The Host supervisor launches package scripts, direct entrypoints, custom
commands, provider tasks, and shell before-launch steps. It applies the
effective platform arguments and existing protected environment and output
paths. The Rust worker starts without Node. User-selected Node, Bun, and
package managers are external project tools invoked only for the matching
Run definition.

In local macOS ARM64 validation, the public API ran the Rust server with
PGlite and the Rust worker with Node absent from its startup PATH. Node
reference comparisons covered capabilities for the two supported providers,
package discovery, tool and target diagnostics, and the validated
inventory. The worker ran real npm scripts and a direct Node entrypoint
using an explicit project environment, then returned their encrypted output.
The fixture also covered a custom command and the owned spawn failure when
the requested Node executable was unavailable.

Java, Dart, Flutter and Rust Run providers, mixed-provider inventory
validation, Cantrip OS execution, and production cutover remain open.
Windows and Linux launch paths and the Bun, pnpm, and Yarn executions were
outside this local runtime check.

## 119. Discover, validate, and run Cargo project configurations

Reference commit `740012d8582160c0b3a00df736312cea3d86b581` (#3281).

The Rust worker discovers declared and conventional Cargo binaries and
examples from bounded manifests. It preserves target and package ordering,
required feature suggestions, and ignored-directory and symlink rules.
The definition API reports Cargo, Rustup toolchain, compiler, Clippy,
target-library, and project diagnostics. Shell, Node, and Cargo definitions
can appear together in the validated inventory.

The existing Host supervisor executes Cargo with the admitted working
directory, package and target selection, features, profile, toolchain,
lock and offline flags, platform overrides, and program arguments. It also
supports Cargo build, check, and clippy before-launch tasks. Definition
inspection reads local files. Launch attempts the actual Cargo command
with the Run environment and captures its exit and protected output.

Local macOS ARM64 validation compared discovery, diagnostics, and mixed
inventory with the Node worker. Both Rust services ran with PGlite and
Node absent from the worker's PATH. An isolated project toolchain executed
a real offline Cargo check, a binary, and an example. A missing target
produced Cargo's own error and nonzero exit through the encrypted output
path. The Rustup fixture exercised component and target diagnostics
without invoking any tool. The previous Shell and Node Run smoke and
definition file checks passed.

Java, Dart, Flutter, Cantrip OS Run execution, and production cutover
remain open. Real Cargo execution was verified on macOS, with Linux and
Windows runtime validation pending.

## 120. Discover, validate, and run Dart project configurations

Reference commit `f9cca57830aa73f8bf2fd0e4d15053a2dbdc2e1a` (#3282).

The Dart provider discovers bounded pubspec and source files without starting
an SDK. It finds top-level Dart main functions, assigns sources to their
nearest package, and omits Flutter packages, test entrypoints, generated
directories, and symlinks. Definition diagnostics cover package and
entrypoint selection, SDK paths, and command before-launch steps. Dart
definitions can appear with Shell, Node, and Cargo definitions in the
validated inventory.

The native Host supervisor runs Dart from the project launch environment or
an explicit SDK. It preserves platform overrides, VM and program arguments,
shell command overrides, and protected output. A missing SDK executable
reports the actual spawn failure.

The local macOS ARM64 smoke compared discovery, diagnostics, and mixed
inventory with the Node definition service. Both Rust services ran with
PGlite and the worker's startup PATH excluded Node. With
`CANTRIP_TEST_DART_SDK` set, Dart 3.11 executed via a selected SDK and via
the Run PATH. The fixture verified before-launch ordering, VM assertions,
Unicode and spaced arguments, encrypted output, a custom shell command,
and the missing SDK spawn failure. The existing Node Dart provider tests
and focused Rust Run tests also passed.

Java, Flutter, Cantrip OS Run execution, and the production cutover remain
open. Dart execution was exercised on macOS ARM64.

## 121. Discover and run Flutter configurations and inspect devices

Reference commit `9af2e810f2d2e0d8b3f3b3b67e6de10cee010d52` (#3283).

The Dart and Flutter providers share one bounded package and Dart source
scan. Flutter discovery recognizes conventional and variant entrypoints
and carries the pubspec default flavor into each suggestion. Flutter
validation reports package, SDK, entrypoint, define-file, and before-launch
diagnostics in mixed-provider inventories.

Host execution preserves platform overrides, SDK and device selection,
mode and flavor, Dart defines, pub behavior, and application arguments
through the owned PTY. Flutter clean, localization generation, and pub
get run as ordered provider steps. Device selection goes directly to
`flutter run` so Flutter reports launch failures for the selected device.

The authorized device endpoint invokes `flutter devices --machine` in the
registered project. It preserves the device record shape and ordering,
caps the combined output and runtime, and retires the owned process on
limit or cancellation. Discovery, validation, and inventory inspect files
without launching the SDK.

The local macOS ARM64 smoke compared discovery, validation, inventory, and
device output with the Node worker. It ran both Rust services with PGlite
and Node absent from the worker startup PATH. An SDK fixture exercised
device inspection, oversized output cleanup, launch arguments, command
overrides, before-launch order, and encrypted output. With
`CANTRIP_TEST_FLUTTER_SDK` set, the installed Flutter SDK generated real
localization files through the Rust supervisor. Flutter application launch
used the SDK fixture, with no physical devices or simulators involved.

Java, Cantrip OS Run execution, and production cutover remain open.
Flutter runtime validation in this cycle covers macOS ARM64.

## 122. Discover and run Java projects with Gradle and Maven

Reference commit `86920cf58c66b1dfde8cefe1169d304fc49aa6df` (#3284).

The native worker statically discovers Gradle build roots and project
paths, Maven reactors and modules, Java main classes, and application
tasks and goals. Discovery preserves wrapper selection, name ordering,
and confidence. Validation reports the existing JDK, wrapper, build
root, module, main class, goal, and before-launch diagnostics. All six
Host providers can appear together in the validated definition inventory.

The Host supervisor dispatches Gradle tasks and main classes, Maven
goals and main classes, custom commands, and ordered before-launch
steps. Java-specific environment additions preserve the explicit JDK
and VM option precedence. The generated Gradle init script is private
to the Run and is removed after the supervisor retires the process.
The supervisor launches the build tool directly for the authorized
target so the tool reports errors from its actual execution.

On macOS ARM64, the public API smoke compared Java discovery,
validation, and mixed inventory with the Node worker while both Rust
services used PGlite. The worker startup PATH excluded Node. Fixtures
verified wrapper dispatch, Maven module and goal arguments, Java
environment overrides, and Gradle launcher cleanup. With
`CANTRIP_TEST_GRADLE` and `CANTRIP_TEST_JDK_HOME` set, an offline
Gradle 8.14.3 build ran a Java 21 main class and returned its program
arguments and VM property through encrypted output. The actual Maven
runtime and non-macOS platform launches were outside this cycle.

Cantrip OS Run execution, CLI connection environment, direct and
WorkerLink delivery, and production cutover remain open.

## 123. Connect the native CLI to Host Runs and terminals

Reference commit `12a2334f07dcfbb4a3d8bc2ae1ef6c920bb73b0c` (#3285).

The worker owns an authenticated IPv4 loopback broker and atomically
publishes the version-one `cli-connection.json` with a per-lifetime
session token. Host Runs, shell terminals, and terminal services inherit
the connection path and the installed CLI directory through their
existing process environments. A Host Run supplies its admitted
Terminal identity, so Core can resolve a protected checkout without
access to the local path. The broker forwards registered commands to
Core using the current worker credential and preserves context selection
and structured failures.

The worker opens `run logs` output locally and encrypts `run secret set`
for the authorized project before forwarding it. The CLI and the Run
supervisor share the existing Run content bindings. Core checks an
expected project identifier on native secret writes before committing
them, so a context change between resolution and storage cannot bind an
envelope to the wrong project. The broker accepts both the reference
Node context target and the Rust server's status context structure.

On macOS ARM64, the shipped CLI ran inside a Rust-managed Host Run and
an interactive Terminal against the Rust server with PGlite. Local
checks covered handshake parity with Node, session rotation and removal,
mode-0600 publication, Terminal lane selection, decrypted log reads,
encrypted secret storage and consumption, and rejection of a mismatched
project before storage. The existing Host terminal service and
Run-provider smoke checks and the eight Node broker tests passed. The
worker startup PATH excluded Node.

Protected CLI policy, Explorer, terminal read/input, and browser
navigation adapters remain open. Cwd-only inference for protected
checkouts, managed Codex bindings and CLI launch environment, Cantrip OS
Run execution, and production cutover remain open.

## 124. Open protected CLI policy summaries and bodies

Reference commit `4adc43398b5f5b24630b111890ce1ea2fba55396` (#3286).

The native loopback broker supports `cantrip policy list` and
`cantrip policy read`. Core resolves the effective policy set for the
authorized project and returns encrypted records in its existing order.
The worker opens each summary with its recorded key revision and
preserves mandatory and assignment sources. For a read, the worker
looks up the requested key locally and sends only the selected policy
ID to Core. It checks the returned policy identity and opens the body
against that row. Plaintext policy content is returned through the
authenticated loopback connection.

The new endpoint contract block is generated from `packages/protocol`.
On macOS ARM64, the shipped CLI ran inside a Rust-managed Host Run
against the Rust server with PGlite. CLI list and read results matched
the Node decryptor for the same encrypted records. The fixture checked
mandatory and project assignments, an unassigned policy, and a body
encrypted for a different policy ID. Core's responses carried ciphertext.
The Node policy and broker tests also passed locally.

Managed Agent policy context and protected CLI Explorer, terminal
read/input, and browser navigation remain open. Production still
selects the Node worker.

## 125. Relay protected Explorer and terminal CLI operations

Reference commit `a024e60aea7b0f1fc6a232d057787ded690f4959` (#3287).

The native CLI broker supports `explorer list`, `explorer read`,
`explorer write`, `terminal read`, and `terminal send`. Core resolves the
authorized surface for the current context. The broker binds each encrypted
request and response to that surface, operation, direction, and sequence.
Explorer writes read the current version from the selected surface and
include it in the encrypted replacement so the worker can reject a
concurrent change. Terminal input uses the existing encrypted input path
and returns the relay mutation receipt.

On macOS ARM64, the shipped CLI listed, read, and replaced a file from a
Rust-managed Host Run and read a running terminal snapshot and sent input
that produced a new PTY marker. Both services ran in Rust with PGlite,
and Node was absent from the worker startup PATH. Explorer listing and
read results matched the Node broker for string cursors, pagination, and
UTF-16 truncation. The fixture also checked that the Core relay carried
ciphertext and that a successful write changed the file version.

Browser navigation, managed Codex CLI bindings, direct and WorkerLink
delivery, and production cutover remain open.

## 126. Bind managed Codex CLI calls to their admitted chat lane

Reference commit `f2938cba87ded672fcf860fd3317e2409da5d4ce` (#3288).

The Rust worker supplies the CLI directory and the private broker document
to the managed Codex app-server. When the existing managed execution path
activates the admitted lane, the worker records that lane and chat for the
native thread within the current owner and server binding. A CLI request
captures the claim once and includes it on every Core call for the command.
The last binding stays available for Core to reject after settlement and
is replaced by the next admitted lane for that thread.

On macOS ARM64, the actual bundled Codex shell invoked the shipped CLI
through both Rust services with PGlite and Node absent from the worker's
startup PATH. A disposable standalone Chat used the existing permission
profile that permits loopback access. The CLI received Core's existing
standalone capability error during the turn. A repeat using the same
native thread after settlement received Core's stale-lane conflict, and
an unknown thread produced a missing-context error. A separate real
Codex project-turn fixture captured the exact upstream lane before and
after replacement. The existing Host Run CLI smoke and eight Node broker
tests passed locally.

Protected browser navigation, protected cwd-only inference, Cantrip OS
execution, and production cutover remain open.

## 127. Install and renew WorkerLink authority in the Rust worker

Reference commit `c8b351a109fe150afbb7203a5f7b6d9aa963f974` (#3289).

The native worker resolves its authenticated owner, logical server, and
process identity over the existing command socket. It installs, renews,
and revokes Core-issued WorkerLink sessions and grants and accepts
successive route generations under the installed route policy. Grants are
bounded by the exact session identity and lease. Replacement, expiration,
and explicit revocation retain a bounded record of retired grant
generations. Installed authority stays in memory for the worker's
15-second reconnect grace. Authentication rejection, grace expiry,
security identity changes, and shutdown retire the affected authority.

On macOS ARM64, the public WorkerLink API drove the Rust server and Rust
worker with PGlite and an empty worker PATH. The worker handled all eight
coordinator commands. The fixture checked session and observation grant
identity, independent renewals, the preferred-route generation change,
revocation, and creation of a replacement session. Worker unit tests
covered expired grants, stale generation replay, and reconnect-grace
expiry.

WorkerLink frame delivery, resource adapters, LOCAL capability serving,
and LAN/WAN peer transport remain open.

## 128. Serve WorkerLink observation subscriptions over the relay

Reference commit `6010c73bb77515b039ff476305aaa824cb4f96a6` (#3290).

The Rust worker reads and writes WorkerLink binary frames on the
authenticated control socket using the shared framing crate. It opens
observation channels against the installed session, route and grant,
checks bearer proof and replay nonces, and keeps control, data sequence
and byte credit ordered. Expired, replaced and revoked authority closes
its channels. Pending observations are bounded and drain when the
client supplies credit or the socket can accept more bytes.

The worker projects existing provisional chat, worktree, filesystem and
runtime notifications into the protocol's observation envelope. The
generated contract enforces topic and provisional event restrictions.
Relayed filesystem observations carry the protected routing handles and
directory invalidation. Detailed filenames belong on the encrypted
filesystem delivery path.

On macOS ARM64, the production Rust worker and Rust server with PGlite
relayed real Host Run status changes. The client decoded the frames with
the TypeScript contract and verified acceptance, held output under
insufficient credit, continuity after credit, the exact Run identity,
and revocation. The Node observation adapter tests passed locally.

Encrypted detailed filesystem delivery, terminal and tunnel channels,
remote surfaces, LOCAL capability serving, and peer transport remain open.

## 129. Serve encrypted Host terminals over WorkerLink

Reference commit `e1315da4158ffb33bac7931aa20e99cda6073020` (#3291).

The relay accepts authorized interactive terminal channels for the same
Host shell and supervised service PTYs used by the control connection.
Each channel attaches to the existing terminal and sends encrypted
replay before ready. Replay exposes the existing native snapshot in the
protocol's legacy-raw hydration format with its actual dimensions.
Output chunks fit the binary frame limit without splitting surrogate
pairs.

The worker validates encrypted input against the current terminal,
owner, operation and input sequence before sending it to the PTY. It
returns WorkerLink credit after processing input or resize. Run
configuration terminals remain read-only. Revoking an attachment drops
the terminal view and its input sequence state while the PTY can serve
other views. Natural exits drain their remaining output and deliver
the exit code before closing the channel.

Local macOS ARM64 validation exercised both Rust services with PGlite.
The client used the existing TypeScript terminal schemas and crypto.
The fixture checked replay from the same shell PID, PTY resize,
protected input and output, grant revocation, and natural exit. It
also attached to a restarted terminal service and read that service's
protected output, and exercised the existing control relay and CLI.
WorkerLink observation delivery and the Node terminal adapter checks
were validated locally.

Managed Codex console launch over the terminal channel, terminal
adapters for Cantrip OS, and direct and peer transport remain open.

## 130. Serve encrypted Host TCP tunnels over WorkerLink

Reference commit `7e57eafd5bae4407a9005b21bca2364436ad2b94` (#3292).

The Rust worker accepts a reliable stream under an installed tunnel
attachment and checks the exact tunnel, attachment, and endpoint IDs in
each nested CTTN frame. It opens the protected destination record with
the established tunnel scope, operation ID, revision, and component key.
The decoded Host endpoint can use the protocol's IPv4 and IPv6 loopback
addresses. The `localhost` variant tries IPv6 and then IPv4 loopback.
The worker logs scoped connection and rejection diagnostics without
destination addresses, keys, or payloads.

Multiple logical TCP streams share the attachment with independent
sequence and plaintext credit. The outer channel bounds ciphertext
queued for relay credit. Source credit is returned as the local
TCP socket accepts data. Half-close preserves delivery in the other
direction. Closing or revoking the attachment cancels its owned streams.

On macOS ARM64, the public tunnel and WorkerLink APIs exercised both
Rust services with PGlite and an empty worker startup PATH. The local
TCP fixture and existing TypeScript framing and crypto checked a
protected record with the wrong binding, two concurrent connections,
encrypted data in both directions, inner and outer credit, directional
half-close, per-stream sequence rejection, and socket closure on grant
revocation. The focused Node tunnel adapter tests passed locally.

Guest tunnels, project and Chat share destinations, the legacy tunnel
WebSocket, direct brokers, and peer carriage remain open.

## 131. Serve encrypted Host TCP tunnels over the legacy WebSocket

Reference commit `16da5785d534fc921daacacbcf627d3f65b54f8f` (#3293).

Core's existing secret-authenticated tunnel WebSocket provides the
client attachment. The Rust worker receives CTTN frames on the ready,
authenticated worker command socket and uses the same protected record
opening, bounded TCP stream implementation, and connection limit as
WorkerLink. Legacy output uses command-socket capacity. WorkerLink keeps
its attachment credit and carrier-specific grant checks.

Each carrier tracks logical streams by tunnel, attachment and connection
IDs. A remote close retires the logical stream in frame order so an
immediate open with the same connection ID can proceed. An older stream
cannot enqueue new output after retirement. Account or server identity
changes and terminal command-socket loss release the legacy streams.

On macOS ARM64, both Rust services with PGlite served encrypted loopback
traffic over each public attachment API. The TypeScript client verified
flow credit, half-close, stream ID reuse, and revocation over the legacy
WebSocket. One WorkerLink TCP stream stayed active during legacy
revocation, including when the carriers used the same connection ID.

Guest and share destinations, direct brokers, and peer carriage remain
open.

## 132. Serve protected project and standalone Chat WebDAV shares

Reference commit `28977a6793dd19d3d682ab276caef7ce1ef02598` (#3294).

The native `project.share.open` command authenticates the stored tunnel
record before choosing a filesystem. Project shares use the encrypted
checkout path. Chat shares match Core's Chat and root IDs against the
registered scratch directory, then require that prepared mount when a
carrier opens a stream. The worker reports its Chat share capability
and returns the established source-unavailable code for missing roots.

Each share owns its Digest-protected loopback listener, locks and
properties. DAV operations use an open directory handle so file
operations cannot follow paths outside the authorized root. WorkerLink
and legacy carriers use the same encrypted TCP stream implementation.
Closing a share stops its listener and accepted HTTP connections.

On macOS ARM64, the real Rust server and worker with PGlite served a
project over WorkerLink and a standalone Chat over the legacy tunnel
WebSocket. The TypeScript fixture verified Digest challenges, wrong
credentials, Finder's lock and metadata behavior, file changes, DAV
properties and directory operations, contained paths, correct Chat
binding, and share revocation. Host TCP relay regressions and the
focused Node share tests passed locally.

Direct brokers, guest destinations and peer carriage remain open.
System-level network-drive mounting was not exercised by this fixture.

## 133. Serve native direct probes and protected TCP tunnel tickets

Reference commit `9f2f6a002c7211ce6f5329bf39aa62d3fa5c9276` (#3295).

The worker advertises a loopback `/direct/v1` WebSocket with the
existing broker identity and Ed25519 challenge signature. The worker
consumes a ticket only after verifying the secret, exact binding, and
prepared and active expiry. Core's revoke and renew commands retire or
extend the matching socket. Terminal control-connection loss and account
or server identity changes retire direct capabilities.

The direct carrier checks the installed tunnel and endpoint identities
and maps each source open to the server-issued protected target. It
uses the existing Rust TCP stream implementation with a bounded
WebSocket output queue. A destination close leaves the source sequence
available for the desktop client's closing acknowledgement.

On macOS ARM64, the public probe and tunnel APIs issued tickets through
the Rust server and worker with PGlite. The TypeScript fixture verified
signatures, wrong-secret and spent-ticket rejection, concurrent streams,
protected request and response bytes, half-close, and revocation
closing an active TCP stream. It also exercised the legacy and
WorkerLink relay paths and read an existing project WebDAV file over
the public direct attachment API. A focused native test verified that
renewal extends live authority without reviving a retired capability.

Direct terminal and WorkerLink LOCAL capabilities and peer carriage
remain open.

## 134. Serve WorkerLink LOCAL over the authenticated direct broker

Reference commit `5e4a0fc283765c9e764f24296ebf111f5a0019eb` (#3296).

The native broker accepts Core-issued WorkerLink tickets and carries
CWLK frames for the exact bound session on the LOCAL route. Channel
opens use the same installed session, route generation, grant,
nonce, and credit validation as the relay. A channel and its queued
output belong to the socket that opened it. Closing a direct connection
releases that socket's resources and leaves the WorkerLink session and
its other connections available. Congestion on one carrier leaves the
others writable. Raw direct tunnels and WorkerLink LOCAL use the same
bounded WebSocket output queue.

On macOS ARM64, the Rust server and worker with PGlite carried encrypted
Host TCP in both directions, Host terminal replay and encrypted input
and output, and credit-gated live Run observations over WorkerLink
LOCAL. The TCP fixture checked rejection of traffic from another
session and another valid ticket for the same session, grant reuse
after socket disconnect, and socket closure on route replacement.

Peer carriage, legacy direct terminal capabilities, guest destinations,
browser and surface transports, and production cutover remain open.

## 135. Serve legacy direct Host terminals in the Rust worker

Reference commit `ddb48984dd915cabf079e3f9c92046f14d72d6e9` (#3297).

Core's existing terminal direct endpoint starts or attaches the Host shell
and issues a broker ticket. The worker signs the broker challenge and binds
the ticket to the exact terminal and CTTN route. It carries the existing
`/terminal?operationId=…` WebSocket through a bounded in-memory pipe.
The terminal still protects I/O inside its own messages. The inner WebSocket
uses the same PTY, replay, resize,
and authenticated input code as WorkerLink and enforces one successful
upgrade per ticket. Revocation drops its view and leaves the owning shell
available for reattachment.

On macOS ARM64, the Rust server with PGlite, the Rust worker, and the desktop
broker verifier exercised the existing public ticket API. The terminal fixture
covered first open, reattachment to the same shell, replay before readiness,
encrypted input and output, resize, rejection of a competing socket and replayed
or misbound input, and active revocation. The tunnel and WebDAV fixtures
covered existing protected CTTN routes through the shared stream loop.

Managed Codex console launch, Cantrip OS terminals, peer carriage, and
production cutover remain open.

## 136. Serve WorkerLink LAN peers in the Rust worker

Reference commit `4b4316e295c6f31a40649698850424fc0848d8ae` (#3298).

The worker answers LAN offers through Core's existing peer commands and
signaling mailbox using WebRTC.rs 0.21.1. It uses the negotiated SDP media ID
for trickled ICE candidates and reports connected after the control
challenge and all five QoS lanes are ready. LAN uses UDP and the
configured interface and VPN allowlists. The socket adapter also filters
addresses before ICE can create peer-reflexive candidates.

CWLK traffic uses the established grant, sequence, and resource adapters.
Each SCTP lane has its own send queue, byte and rate limits, and credit
wakeups. Route replacement and lease expiry retire the matching peer
connection and its channels.

On macOS ARM64, the Rust worker and Rust server with PGlite negotiated
with headless Chromium and WebKit through the public WorkerLink API.
The fixture verified all lane labels, the control challenge, encrypted
Host TCP in both directions, lease renewal, and grant and route
revocation. The initial Werift larger-response timeout is addressed in
the following cycle.

WAN peer transport and production cutover remain open.

## 137. Fit protected WorkerLink tunnel frames to the negotiated peer limit

Reference commit `8ddf530b5a62a90c63e4bad1f9bb34de672fe88e` (#3299).

The Rust worker reads the negotiated SCTP message size before the peer
control handshake. Each lane also has its configured byte and rate
ceilings. The tunnel producer reserves room for the CWLK envelope and
uses the encoded CTTN header and authentication tag to size the
plaintext. It charges stream credit for the emitted bytes. A frame that
cannot fit retires its channel without stalling the rest of the peer.

On macOS ARM64, Chromium and WebKit with an advertised 65,536-byte
receive limit and a Werift peer with its default limit transferred the
larger encrypted TCP response through both Rust services with PGlite.
All exercised the existing half-close, grant revocation, and route
replacement. The local WorkerLink, direct and legacy TCP, terminal,
and WebDAV regressions passed.


## 138. Serve WAN WorkerLink peers in the Rust worker

Reference commit `17f7a9b1e768ab5ba68300c5e0cf35061ea6707e` (#3300).

The native broker accepts the existing Core WAN peer round and uses its
exact route and generation for channel admission and output. WAN gathers
public host and STUN server-reflexive candidates and eligible VPN host
candidates. It preserves the Node worker's first valid STUN endpoint and
UDP treatment of `stuns:`. Ordinary private interfaces can supply the
socket for a STUN mapping without advertising a WAN host candidate.

The worker carries a pinned WebRTC.rs library with a small local candidate
hook. It applies the route policy before candidates enter ICE, checks the
nominated pair before the control handshake, and isolates configured STUN
traffic and mDNS from ordinary peer sockets. LAN continues applying its VPN
allowlist. Core authorization, leases, grant revocation, and the relay
route use the existing protocol.

The local macOS ARM64 WAN fixture exercised both Rust services with PGlite.
A loopback STUN fixture returned a controlled mapping for a private
interface. Headless Chromium exchanged encrypted Host TCP through the
WAN round and verified credit, half-close, lease renewal, grant revocation,
and route replacement. The LAN, LOCAL, relay, and legacy and direct TCP
fixtures and the focused WorkerLink unit tests passed. The WAN fixture
used local interfaces. Off-host NAT and named VPN runtime interoperability
remain unverified.


## 139. Discover local browser services from the Rust worker

Reference commit `bc1f72d1bd4a2e2d8ddca5c4da2d980a1966a7be` (#3301).

The native worker handles `browser.services.discover` on the authenticated
command connection. It reads operating system listener inventory with the
existing macOS, Linux, and Windows command conventions, deduplicates addresses,
and enriches process labels on Unix. It probes up to 128 listeners, with
bounded concurrency and a deadline for each HTTP or HTTPS attempt. Requests
use the local listener address, carry no credentials, and follow no redirects
or proxies. Self-signed certificates are accepted for local discovery.

The result uses the shared browser service schema. The worker derives the
same display labels and extracts titles from bounded, streamed UTF-8 decoded
with the existing UTF-16 length limits. It publishes neither process arguments
nor response bodies.

On macOS ARM64, the public per-browser discovery endpoint in the Rust server
returned matching results from the Node reference and the Rust worker with
PGlite. A fixture-limited system listener scan exercised a redirect,
self-signed HTTPS, non-HTTP rejection, a title split across chunks, and a
Node-free worker PATH. Focused tests covered Linux and Windows listener
formats. Linux and Windows runtime checks were outside this cycle.
Project-wide discovery continues to depend on a worker's browser surface
capability, which the native worker can advertise when that service lands.


## 140. Launch and control Chromium without the Node driver

Reference commit `812304f5c52c241dbbc951ca07d9c5482a5a7c6c` (#3302).

The `cantrip-browser` crate launches Chromium in an explicit profile and
connects directly to the browser's loopback DevTools endpoint. The driver
correlates requests and filters flattened target events. It limits the
message size, pending requests, queued writes and buffered events. Close
asks the browser to exit and reaps it. If the child stays alive, the owner
uses bounded termination and reports the outcome. Cancellation and failed
startup use the same process ownership, with a process group on Unix and
the existing Windows Job Object adapter.

The native `chromium-probe` entry point creates a temporary profile, runs
two isolated contexts, and resolves navigation events for the actual page
loader. It verifies an accessibility heading and button and checks that
page storage stays within its context. It also checks that Chromium can
evaluate script and that the worker can close the targets and process.

On macOS ARM64, Chrome for Testing and Chromium's headless shell 153
both passed the page and isolation checks with Node absent from PATH.
The headless shell exited through DevTools and matched the Node
Playwright reference. Chrome for Testing acknowledged the protocol close
in the direct comparison and stayed alive. The native probe reported
forced termination after reaping it. Both probe profiles were removed.
A process that exited before publishing DevTools returned the startup
failure and released the temporary profile.
Focused unit tests covered launch output and request/event correlation.
The crate passed compile checks for Linux x64 and Windows x64.
Production browser surfaces and managed runtime installation still need
integration with the new driver.


## 141. Serve native browser surfaces over the legacy Core WebSocket

Reference commit `27c0a0f3ba60cd3be82a5c9e3b5aa18b1b5e95e4` (#3303).

The worker opens the protected browser location from the existing attach
command and acquires a Chromium page in the existing profile directory.
The surface owns its input queue and tracks attachment IDs, stream counters
and the authenticated Core socket generation. It uses the shared encrypted
CTRS frame format for browser state, JPEG frames, input, cursor and clipboard
traffic. Stale attachments and expired grants cannot continue using the
stream. The surface also handles configure, suspend, resume and close.

On macOS ARM64, the Rust server with PGlite and the Rust worker with Chromium
headless shell exercised the existing public legacy surface socket. The
fixture verified encrypted URL state and JPEG output, tampered input and
navigation replay rejection, two attachments sharing one page, pointer,
keyboard and clipboard input, suspend/resume, and browser deletion. The
worker's PATH excluded Node.

The worker advertised browser surfaces as unavailable until the app's
WorkerLink adapter landed in the following cycle.


## 142. Serve browser attachments over WorkerLink

Reference commit `23a2482dd058d8ed0209f4a5fdb4b919e15d8bed` (#3304).

The worker binds the Core-issued browser grant to its existing Chromium
attachment and opens one channel on each of the interactive and realtime
lanes. Protected control and clipboard messages stay ordered. Realtime
keeps an in-progress frame and the newest successor. Both streams use the
existing WorkerLink chunks, respect live credit, and fit the negotiated
peer message size. Inbound chunks assemble into a control frame with the
same surface and attachment IDs. Queued input is tied to its lane instance.
Revoking a grant releases its channels and attachment. The worker advertises
browser support when it discovers Chromium.

The native worker and the Rust server with PGlite passed the public browser
fixture over Core relay, local direct, LAN WebRTC and the legacy WebSocket
on macOS ARM64. The fixture covered a JPEG larger than both the initial
credit and the negotiated peer message size, encrypted navigation and
control input, protection and replay rejection, independent attachments,
suspend/resume, grant renewal and revocation, and deletion. WorkerLink
control tests and the Host TCP transport fixtures passed locally. The
worker's PATH excluded Node.

Browser WAN interoperability was outside this cycle. The following cycle
adds browser and renderer recovery.


## 143. Recover Chromium surfaces and preserve their attachments

Reference commit `6ca4033e16e7a0f0b3afb131aa2d9bb359cca936` (#3305).

The browser runtime retires the failed page and restarts with bounded
backoff. It reopens the most recent committed browser location in the same
Chromium profile. Attachments retain their leases, encrypted stream counters
and navigation replay history. During recovery the worker can accept viewport
and location updates and close an attachment. CDP target lifecycle events
cancel pending page requests promptly, including requests that are waiting
on a crashed renderer. Profile generation ownership lets multiple surfaces
share a restarted process. A single renderer restart leaves sibling pages
in that process.

The local macOS ARM64 fixture used the Rust server with PGlite, the Rust
worker with Node absent from PATH, and Chromium's headless shell. Through
both WorkerLink Core relay and the legacy WebSocket, it ended the shared
Chromium process and made the next launch fail. Both surfaces then restored
their locations. The fixture crashed one renderer and verified that its
sibling still used the same Chromium process. It also checked retained site
storage, monotone stream counters, continued protected input and deletion.
The focused browser crate tests verified that a target loss interrupts
only the subscribed page and settles an in-flight page request.

Legacy browser WebRTC, desktop capture, computer use and managed web
sessions remain open. This cycle exercised Chromium and renderer loss
within a running worker.


## 144. Install and probe signed managed Chromium releases in Rust

Reference commit `9d9497d43de02ccb550b7a720e5475047c778ca2` (#3306).

The Rust worker checks the existing managed browser release channel at startup
and every six hours. It verifies the Ed25519 signature before downloading,
streams and verifies the declared size and digest, and extracts regular files
and directories into private staging with the signed byte budget. It launches
Chromium directly to check accessibility in an isolated context. Successful
installs use the existing `playwright/current.json` pointer and retain the
previous digest. The browser status and maintenance actions use the existing
Core API and heartbeat contracts.

The local macOS ARM64 signed HTTPS fixture used the existing ZIP layout and a
small executable fixture that launches actual headless Chromium. Install,
reuse, reinstall, update, cache and profile actions passed. An invalid
signature, bad digest, invalid manifest and failed Chromium launch each left
the active pointer intact. A separate production Rust server and worker check
verified the existing Core action endpoint and heartbeat without Node on the
worker PATH. The fixture trust key is confined to Rust test code.

The installer accepts existing release assets, including their legacy files.
Replacing the legacy release contents, binding managed web sessions and page
rendering to the installed Chromium, and porting SearXNG remain open. The
new installer was exercised on macOS ARM64.


## 145. Read static web pages through the native MCP broker

Reference commit `23b500bf6d756cfd1d38aa7ed3cd19cc1b5c5d89` (#3307).

The native worker admits `web_read` on the existing project and standalone
MCP bindings. It fetches direct URLs without system HTTP proxies. It validates
every DNS answer, pins one approved address per hop, rechecks robots rules
on redirects and refuses HTTPS downgrades. Compressed bodies, decoded bodies,
HTML extraction and concurrent work have explicit bounds. It extracts readable
HTML and plain text and issues single-use cursors scoped to the owner and
chat. Heartbeats advertise static reading through the existing schema.

On macOS ARM64, the local HTTP fixture exercised redirect and robots policy,
compressed input, charset decoding, canonical URLs and UTF-16 cursor
ownership. A direct comparison with the Node reference matched the article
result and the split surrogate pair across two pages. The native stdio child
and broker against the Rust server PGlite fixture rejected calls without an
active binding and rejected a private URL after activation. The stdio child
ran with Node absent from its PATH. The checked-in web schemas were reused.
The full MCP schema exporter still reports an unregistered refinement in
`target_list` on the baseline.

Chromium rendering, web research sessions, search and search-result
references still need native implementations.


## 146. Read rendered web pages with managed Chromium

Reference commit `4672167bf374ebd379b28687021a4070381de5a6` (#3308).

The production worker connects the installed managed Chromium release to the
existing `web_read` operation. Explicit rendering and the fallback for sparse
static pages use a fresh private Chromium profile and context. The worker
extracts the DOM after the navigation's DOMContentLoaded event and returns
the existing rendered result and UTF-16 cursor format.

Chromium pauses document and subresource requests over DevTools. The worker
services GET and HEAD through the same public DNS validation, address
pinning and redirect rules used by static reading. Document requests are
checked against robots rules. The browser's fallback proxy refuses network
connections, downloads are denied, and resource size, concurrency and
snapshot size are bounded. The worker holds the runtime version until the
browser closes, then releases the temporary profile. Cancelling a read
interrupts outstanding browser requests and closes the owned browser.

The local macOS ARM64 signed-runtime fixture used Chromium headless shell
153 to check explicit and automatic rendering, script execution, public
redirects, cookie continuity, robots denial, rejection of POST and loopback
requests, and cleanup after cancellation. The fixture matched the Node
reference result for the same rendered markup. Linux and Windows browser
runtime validation, interactive research sessions and managed search
remain open.


## 147. Run managed search and open search results in the Rust worker

Reference commit `07e79fff99a8f9f2093e4c67fec21eeca01a18d8` (#3309).

The Rust worker installs the existing signed SearXNG release and launches its
bundled Python with isolated settings and a loopback listener. It verifies
the archive, checks the installed inventory and runs the offline engine probe
before promotion. The worker owns the child process, restarts it after request
timeouts or unexpected exit, and retains the prior verified release for
rollback. Search status and maintenance use the existing Core APIs.

The native MCP broker enables `web_search` for admitted standalone and project
bindings. It preserves the SearXNG query parameters, filtering, result limit,
engine diagnostics and response schema. Search result IDs expire and stay
scoped to the owner and chat. `web_read` resolves them through the existing
static and rendered read paths.

On macOS ARM64, the published SearXNG archive passed signature verification,
extraction, the offline query and launch with its bundled interpreter. The
extractor accepts the published POSIX template names containing colons while
preserving Windows path restrictions. An owned local process fixture matched
the Node query and result, read the selected document, refused a cross-chat
reference and recovered after the search child exited. The signed Chromium
fixture still passed against the shared installer. A production Rust server
and worker exercised the search heartbeat and maintenance action. Windows and
Linux runtime validation and interactive research sessions remain open.


## 148. Run private interactive web sessions in Rust

Reference commit `26f40fa8d0c43a58007dba5ee8fa8781b0f9fe23` (#3310).

The native MCP broker opens, navigates, snapshots, clicks, types into and
closes private Chromium sessions for admitted project chats. A private
session keeps its page and storage across calls. Its ID is scoped to the
owner and chat. The worker exposes Chromium accessibility roles, names and
interactive elements through the existing snapshot schema. Opaque element
references identify particular nodes in the snapshot document. Navigation
and mutations invalidate those references.

The worker routes browser traffic through the existing public-address and
robots policy. Interactive sessions can submit bounded HTTP request bodies.
Queued commands verify their admitted lane, and revocation interrupts active
commands and retires the affected session. Sessions also close after 15
minutes idle. An open session retains its managed runtime digest and private
profile until Chromium exits, including across runtime updates.

The local macOS ARM64 signed-runtime test used headless Chromium to check
dialog dismissal, snapshots, a clicked button, form POST, same-session
storage, storage isolation, stale references, cross-chat and read-only
denial, explicit close and revocation cleanup. The focused Node reference
tests passed. Exact visible Browser targets, pointer gestures and streaming
web connections remain open. The accessibility text uses Chromium's tree
and the existing result schema.


## 149. Control an open Cantrip Browser through native MCP

Reference commit `febf33249497d45bb381ca6cc33fbc14998b7618` (#3311).

An admitted project chat can open an MCP session on an exact Browser target.
The broker asks Core to resolve the target with the active worker binding.
The worker then borrows the matching open surface's Chromium page generation
and checks the owner, project and server. Surface replacement invalidates
the borrow. Closing the MCP session releases its references and presentation
cursor while the Browser remains open.

The session supports navigation, viewport text and element snapshots, clicking,
typing, and move, click and drag gestures. Node-free cursor rasterization uses
the existing shared interaction crate. Browser attachments receive normalized
cursor positions and sprite updates through the encrypted control stream.
Turn revocation stops the gesture and releases an attempted press on the
original page when that page is still owned. User input continues through the
surface's regular input queue.

Local macOS ARM64 tests exercised Core resolution with an authenticated
fixture, and real headless Chromium for the visible-session action and
presentation fixture. They verified stale references, cross-owner denial,
cursor sprite data and a single mouse release after drag cancellation.
A separate production Rust worker and Rust server smoke passed the existing
encrypted Browser workflow over WorkerLink Core relay. The focused Node
reference tests also passed. Streaming network connections in private web
sessions remain open.


## 150. Stream events and WebSockets in private web sessions

Reference commit `e551b23a896c89791a0edb190b175315fbf629c3` (#3312).

Private interactive Chromium sessions use a worker-owned loopback HTTP proxy.
The proxy validates the destination and every resolved address, pins the
connection to an approved address and bounds response bytes, tunnel bytes and
concurrency. Chromium receives plain HTTP bodies incrementally, including
EventSource responses. Chromium establishes its own TLS through standard-port
CONNECT tunnels. WebSocket connections use those same destination and lifetime
limits. Closing the session tears down its proxy and owned sockets.

DevTools still checks the robots policy on document navigations and redirects.
The separate rendered-read path retains its GET/HEAD-only interception and
stream restrictions.

On macOS ARM64, actual headless Chromium received two controlled EventSource
messages, with the server waiting for acknowledgment of the first before
sending the second. The browser exchanged a WebSocket message and closed the
socket when the session ended. The same fixture passed form submission, storage
isolation, robots denial, rendered reads, and session cleanup. The native
socket test verified CONNECT destination rejection, bidirectional forwarding
and cleanup of both endpoints. The focused Node reference tests passed.


## 151. Discover Host desktop targets through the native capture helper

Reference commit `c8bf46b25dcba8e5db228c01f655e13a43d713d6` (#3313).

The production Rust worker handles `surface.desktop.targets` on the
authenticated Core command socket. It checks the worker identity, verified
server binding, component grant, and operation replay before requesting
inventory. The worker launches the existing `cantrip-cua` executable lazily
and reads the bounded private protocol over its owned pipes. It checks each
page's identities and cursor, preserves display ordering and window geometry,
and returns the existing limits and counts.

Worker and client share the existing surface private-state encryption
format. Names, titles, target IDs and geometry are inside the protected
envelope. Only counts and truncation accompany the operation in the clear.
Connection replacement discards the helper for that connection and fences its
replies. Worker shutdown closes and reaps the owned helper. The managed
desktop capability still depends on completing the session and input paths.

On macOS ARM64, the built Rust worker with an empty PATH received the command
over an authenticated fixture socket and invoked the installed native helper
with its explicit deterministic backend. The TypeScript client crypto
opened the result and rejected a different operation ID. The fixture checked
the monitor and window shapes, limit, wrong server and worker, missing grant,
replay across reconnect, and helper cleanup at reconnect and shutdown. The
focused Node reference tests exercised the existing desktop adapter and
capture leases using owned targets. Native screen permissions and live
capture were outside this cycle.


## 152. Stream protected Host desktop captures

Reference commit `bfc461b6e05f9b8371059fc089aa0f61df707dc2` (#3314).

Host desktop attachments use the existing authenticated surface command and
WebSocket routes. The worker opens the protected target and revision, asks
the existing native helper for the exact target ID and generation, and owns
the returned lease. Frame responses must match the lease, target identity,
generation and declared PNG dimensions. The worker converts bounded PNGs to
JPEG, adjusts output for viewport and transport pressure, and sends encrypted
frames and desktop state with per-attachment channel sequences.

Suspend, retarget, and close retire the old work and capture lease. Detaching
the final viewer releases capture. The worker fences stale helper handles
and closes the shared helper on connection replacement. A failed exact selection reports a capture error.
The worker still reports managed desktop unavailable while viewer input,
WorkerLink desktop transport, guest desktops, and other compatibility paths
are incomplete.

On macOS ARM64, the production Rust worker used the actual helper with its
deterministic backend over a fixture Core socket. The TypeScript client
decrypted and decoded window and display JPEGs, and verified suspend,
resume, target changes, stale revisions, missing exact targets, detach,
close, and helper cleanup. The Browser WorkerLink relay smoke also passed
with the Rust server and headless Chromium. The focused Node desktop and
capture tests passed for the exercised cases. Actual desktop pixels and
system capture permissions remain unverified.


## 153. Carry Host desktop captures through WorkerLink

Reference commit `25ffc7dbb54fb7565d58f9c32bb126b3a2632bf2` (#3315).

The native worker binds `remote-desktop` grants to the exact desktop surface
and attachment. Desktop state and controls use WorkerLink's interactive lane.
Protected JPEGs use the realtime lane, with bounded assembly and carrier
credit. Lease renewal and revocation are shared with Browser attachments.
A revoked desktop attachment stops contributing to capture and cannot fall
back to the legacy socket. Other active viewers retain their own grants.

Authenticated desktop stream feedback uses the existing protocol option and
adjusts the image quality and width. Closed local direct channels discard
in-flight credit in sequence for their own carrier and routing identity. This
lets the writer deliver channel closure even if credit returns after
revocation. Retired channels retain no delivery or input authority.

Local macOS ARM64 checks used the Rust server with PGlite, the Rust worker,
and the actual native helper with its deterministic targets. Core relay,
local direct, and LAN WebRTC carried encrypted desktop frames. The fixture
exercised credit-limited assembly, invalid and valid feedback, separate
viewers, grant renewal and revocation, and retargeting through Core. Local
direct also returned deferred credit after revocation and verified that the
socket remained responsive. The Browser relay and legacy desktop fixtures
passed. Viewer input, real desktop capture permissions, and WAN desktop
runtime validation remain open.


## 154. Route Host window input through native participants

Reference commit `82a86d24fc63c8b4ae6dd8aa0badcd12aa93e89a` (#3316).

The Rust worker opens an independent input participant against the same native
window ID, helper generation, and target generation used for capture. The
existing protected control messages carry viewer epochs and increasing input
sequences. Host monitor attachments publish view-only state. The worker scales
frame coordinates to the window's logical bounds, translates physical keys
and fractional scroll, and splits pasted text at UTF-8 character boundaries.
Each viewer has a bounded ordered queue that coalesces only adjacent hover
updates with matching modifiers. Cursor state and sprites use the existing
encrypted desktop messages. Input state precedes cursor assets when opening
or closing a participant.

Input cancellation, suspend, detach, retarget, and revoked routes retire the
input epoch and discard queued work. In-flight requests can be canceled over
the native helper's ordered pipe. Replacement input on the same attachment
waits for held input to be released, while other viewers keep their own
participants. Native actions with uncertain outcomes are never replayed.

Local macOS ARM64 tests exercised the legacy authenticated Core socket and
the real Rust server and worker over Core relay, local direct, and LAN WebRTC.
The helper used deterministic windows with an inert input backend. The
fixture verified exact generation, pixel mapping, keyboard and Unicode
paste dispatch, wrong-epoch and duplicate-sequence rejection, release before
reopening input, and independent viewers through grant revocation. Focused
Rust and Node reference tests also passed. Host clipboard copy, desktop
target UI parity, guest input, WAN desktop runtime validation, and actual
platform permissions remain open.



## 155. Upgrade a stopped legacy PGlite profile without Node

Reference commit `2b8a38eff616b0df4ffcced74b338a3e2852c8bd` (#3317).

The server's existing offline preparation command accepts a PostgreSQL 18
compatibility runtime after an actual native PGlite open failure. The pinned
compatibility build reads legacy by-reference 8-byte values and four-byte
constants in persisted PostgreSQL expressions. It opens a private source copy,
uses a temporary authenticated PostgreSQL process, and exports the database
with native pg_dump. The existing logical restore and directory activation
retain the original profile as a backup.

The macOS ARM64 acceptance fixture creates a stopped profile with the legacy
PGlite engine and the real migration journal. The upgrade runs with an empty
executable search path. It matches all 137 table snapshots, sequence states,
stored expressions, and the retained profile bytes. The fixture also checks
an actual wrong-engine failure that preserves the original and a repeat
upgrade that skips conversion after successful activation.

Desktop runtime assembly and Windows validation remain open. The existing
Node-based rollback path stays available while native rollback is pending.


## 156. Export and restore legacy PGlite profiles without Node

Reference commit `f3816c7fd8813925b70b0cd163196454000993d4` (#3318).

The offline CLI now accepts `--export-legacy-profile` and
`--restore-legacy-profile` with the existing compatibility PostgreSQL tools.
Export converts a private copy of the stopped source and publishes the
existing logical bundle format. The scratch database stays outside the
bundle, even when the destination is inside the source profile.

Rollback verifies the archive and creates a private legacy-format database.
It restores its SQL in one transaction, verifies the physical datum format
and stored constant representation, and clears the temporary database
credential. PostgreSQL stops before the prepared profile is published. The
existing explicit activation command retains the current Rust profile.

On macOS ARM64, the real production CLI exported a stopped legacy database,
upgraded it, exported new Rust writes, and activated a native rollback.
The pinned JavaScript PGlite engine reopened all 137 tables and their sequence
state, read the new Rust writes, and persisted a new write across restart.
The test checked archive integrity, wrong-engine failure, and both retained
active profiles. All transfer subprocesses ran with an empty executable
search path. Desktop packaging and other platform runtime checks remain open.

## 157. Package the native legacy profile reader for desktop

Reference commit `910f5165586fd2e6a83890084d74367199c91bf1` (#3319).

Desktop assembly on matching macOS and Linux build hosts stages the PostgreSQL
compatibility tools under `runtime/server/legacy-postgres`. The desktop
supervisor passes their binary directory to the Rust server's offline
preparation process. The existing serving PostgreSQL directory remains
separate. Windows and cross-target desktop assembly still ship the existing
profile converter. The worker keeps its current runtime selection.

Local macOS ARM64 assembly from server and worker artifacts produced the
native compatibility layout and omitted the JavaScript converter. The
compatibility executable targets macOS 11 on ARM64. The production supervisor
probe started the staged server tree with no bundled Node and upgraded an
existing legacy PGlite profile. It served the upgraded database, preserved
the original profile bytes and retained the server identity across restart.
The offline CLI round trip also passed on 137 tables and 1,807 original paths.

A local Debian ARM64 container built the Linux tools, resolved the bundled
libpq, initialized a fresh compatibility cluster, and evaluated a stored
expression in the compatibility backend. Full Linux desktop and Windows
native compatibility runtime checks remain open.

## 158. Package the native legacy profile reader for Windows x64

Reference commit `8335e36d72b53941c41c29384e272da042c5a5c5` (#3320).

The Windows x64 server package builds the compatibility tools in the existing
MSYS2 release build. It records their location for desktop assembly and applies
the same UTF-8 executable manifests as the serving tools. The compatibility
engine preserves the legacy `C` collation and `C.UTF-8` character types. Its
gzip export preserves newline bytes inside data, and its linked zlib and
winpthreads require no redistributable DLLs. The single-user PostgreSQL process
runs in the existing Windows job with a restricted token. Rollback clears the
Windows-specific PostgreSQL configuration before publishing the legacy profile.

Local MinGW cross-builds produced the Windows x64 tools, Rust server, and
desktop supervisor probe. The Windows executables ran through Wine on macOS.
The CLI exported a migrated JavaScript PGlite profile, and JavaScript PGlite
reopened the restored profile with exact Unicode and mixed newline data. The
desktop probe used the server artifact layout with no Node executable, retained
the source database control file and opaque profile file, and reopened the
same server identity after restart. A native Windows installer run remains
open. Older artifacts without the bundled tools retain their converter.

## 159. Attach Cantrip OS guests and manage guest workspaces in Rust

Reference commit `1f2c128289b9bfedac30f3c037e3bcfd47f5916c` (#3322).

The Rust worker uses the existing Docker and SSH guest programs to inspect
and attach Cantrip OS, list and create workspaces, and observe saved workspace
operations. Local Docker observation checks the container ID and start time
around the guest reads. Workspace commands check the guest instance, runtime
generation and worker attachment before using the guest helper.

Workspace creation publishes the private version-one journal before
dispatch. Duplicate admissions reuse the saved operation, including when the
worker restarts with an unsettled receipt. Public results continue using the
existing protocol schema and private carrier diagnostics stay on the worker.

Local macOS ARM64 validation ran the Rust server with PGlite and the Rust
worker against an existing Cantrip OS Docker image. It used the actual guest
executables, verified Docker identity, attached the guest, created a workspace
and rejected a stale generation. It then dropped a second creation response
after the guest applied it. The restarted worker returned the recorded
uncertainty without replaying the mutation. The fixture compared the journal
path and admission fingerprint with the Node controller's JSON and SHA-256
encoding. SSH and Windows runtime validation, source provisioning, and the
remaining Cantrip OS services are still open.

## 160. Provision and verify Linux-owned Cantrip OS sources in Rust

Reference commit `af3f8b423e4e376a88b55f10dc44951e083bb1df` (#3323).

The worker opens the protected source intent using the existing repository
component grant and validates it against the admitted binding. A private
Docker or SSH carrier connects to the selected guest executor generation.
Managed folders and Git checkouts publish atomically from an operation
reservation. Existing sources are observed in place. Linux Git worktrees
check the primary common-directory fingerprint before creating the worktree.

The version-one journal records the native binding, session, and each
finite process ID before dispatch. Process reads have bounded output and
an observed exit. Uncertain delivery retains the recovery record and the
worker does not start another process for the same admission. Guest
receipts and Git fingerprints retain the existing JSON formats.

The local Docker smoke used both production Rust services, TypeScript
repository-content encryption, and the actual guest programs. It covered a
managed folder, collision with an existing directory, exact detached Git
checkout, linked Linux Git worktree, registration of an existing Git source
with spaces and Unicode in its path, read-only verification, and recovery
through the server after restarting the worker. It compared admission digests
and Git fingerprints with JavaScript encoding and checked protected branch
routing and persistence. The worker executable ran with only the Docker
carrier on its search path. Linked Host mounts and guest execution remain
open. SSH and Windows carrier execution were not run for this cycle.

## 161. Install and verify linked Host sources in Rust

Reference commit `ae9925e80bdc356bfc29755e94f30d3cfd07b595` (#3324).

The Rust worker resolves the canonical Host worktree from the protected
binding intent. It uses the existing local Docker Engine socket and
process-owned instance lock. It snapshots the root filesystem changes,
retains the existing workspace and executor volumes and Docker settings,
and mounts each selected dependency path into its own named Linux volume.
The replacement uses the configured container name and requires the
original container to persist after stopping.

The worker records Docker phase and identity in the compatible
`.json.docker` journal and records mount verification in the corresponding
`.binding` sidecar. It pins the new executor's instance, attachment and
workspace identity, tests live file bytes in both directions, and checks
that guest dependency writes stay off the Host checkout before cleaning
up the previous container. An uncertain start leaves both identities and
its requested phase recorded for recovery. Provisioning replay reads the
existing operation.

A local macOS ARM64 Docker fixture ran both production Rust services and
used a real Host project created through the server. It verified opaque
path resolution in the encrypted intent, original root and named-volume
state, shared Host bytes, isolated dependencies, read-only verification
and receipt recovery after worker restart. The worker's search path
contained its Docker carrier only. A focused journal test covered a lost
start receipt. Windows named-pipe and native Linux Docker execution were
not exercised in this cycle.

## 162. Edit Run definitions on the admitted Linux Primary

Reference commit `6d04822df0b7c66752c6cd9b6d2a948958c4e970` (#3325).

The Rust worker captures the admitted Linux workspace and passes one
definition request through a finite guest protocol process. The executor
0.13.0 package includes the native helper, which runs as the workspace
account and shares the Host worker's inventory, configuration file,
discovery, validation, and provider inspection code. The executor package
upgrade is required for guest Run definitions from the Rust worker.

The worker records the guest session and process ID before dispatch. It
can resume the retained session and read an unsettled process outcome
without repeating the operation or resending its input. The reply is
validated against the existing contract and checked against the admitted
project and operation identity.

Local macOS ARM64 testing assembled a development Debian package with the
new Linux ARM64 helper and the existing 0.12.0 executor bundle. It upgraded
a disposable Docker guest and preserved the installed guest identity.
The production Rust server and worker exercised list, write, get,
validation, revision-checked deletion, and reopening an unsettled journal
after worker restart. Node served as a read and validation oracle. The
saved native process and guest file ownership verified execution as the
workspace account. The full release image build, Linux AMD64, Flutter device
inspection, and launch of a configured guest Run were outside this validation.

## 163. Prepare configured guest Runs with the native helper

Reference commit `1bb79a04beae095ce7d26320134e00e3b3f15dae` (#3326).

Cantrip OS executor 0.14.0 adds the native planning command to its finite
workspace helper. The Node worker uses the capability advertised on its
captured guest executor binding to select the native planner. Older
guest packages keep their existing preparation path during the transition.
The plan contract comes from the shared protocol for both implementations.

The helper checks the admitted Primary definition revision and exact
worktree paths. It reuses the Rust providers and applies setup from the
Primary and dotenv files from the target worktree before the configured
variables, resolved secrets and provider additions. The guest executor
retains process ownership. The planner returns the launch commands and
environment to the worker through the existing finite process exchange.

Local ARM64 tests built the native helper and assembled a development
Debian package with the existing executor bundle. The shell plan matched
the Node oracle across separate Primary and target worktrees, including
setup, a dotted dotenv key, precedence, and stale definition rejection.
The existing supervisor then ran that configuration through the native
planner with the legacy planner file moved aside in the disposable guest.
The Run executed its before-launch step and redacted protected output.
The focused Rust Run tests passed. Package release builds, AMD64, SSH,
and other live providers were outside this validation. The guest Run
lifecycle supervisor remains to be ported to Rust.

## 164. Supervise configured guest Runs in the Rust worker

Reference commit 151fe4d3fc4c50b0f587303512c96c9bb3f9d44c (#3327).

The production Rust worker handles Linux Run start, restart, stop, status,
protected output and reconciliation. It uses the executor 0.14.0 native
planner and runs setup, before-launch steps and the application through
the bound workspace's retained executor session. Host and guest Runs share
the lifecycle and protected output interfaces. Guest paths stay within the
guest, and only explicit linked paths participate in Host deletion cleanup.

The worker writes the compatible version-one admission, executor generation,
session and process IDs before dispatch. It can observe an existing Run
after reconnect or worker restart. Recovery reads the admitted process
without replaying preparation, launch or stdin. Stop waits for confirmation
on that process. Restart retires the previous generation before admitting
its replacement. The worker preserves uncertainty when the saved executor
can no longer confirm the outcome.

Local macOS ARM64 testing ran the production Rust server and worker against
a disposable Docker guest upgraded with a locally assembled executor package.
The fixture used separate Primary and target worktrees, removed the JavaScript
planner from its guest path, and checked setup, dotenv loading, encrypted and
redacted output, and Node-compatible journal fingerprints. It killed the
worker and verified recovery of the same process and journal with one
before-launch execution. It then verified replacement after restart and
graceful Stop with a replayed request. The existing Host Run smoke, including
Node differential behavior, and four focused Rust unit tests also passed.
The guest runtime was exercised on Docker ARM64. SSH, AMD64 and Windows guest
carriers were outside this validation. Desktop and standalone worker cutover
remain open.

## 165. Serve guest Explorer and text documents from the Rust worker

Reference commit ab48f0a58cf11bd1175f5e8eee8017dbf46d628f (#3328).

The Rust worker resolves the captured Linux Explorer or document placement
and runs a finite helper from executor 0.15.0 as the admitted workspace
account. The helper reuses the Host filesystem engine for listing, search,
directory commits, text reads and writes, creation, rename and deletion.
Linked worktree commit history continues to use the linked Host checkout.
Purpose-specific surface encryption stays on the worker.

The worker and helper use the existing placement and operation digests,
worker admission records and guest receipt paths. A saved mutation may
return its known receipt after reconnect. If the helper cannot establish
completion, the result remains unknown. Before admitting a replacement
helper, the worker resolves any pending helper using its captured executor
generation, session and process identifier.

The local macOS ARM64 fixture ran the production Rust server and worker
against an upgraded disposable ARM64 Docker guest. It opened protected
Explorer and file-document resources, wrote Unicode across carrier chunks,
and verified checkout containment and a document's exact path restriction.
The legacy and native helpers read each other's saved mutation receipts.
The restarted worker returned the original receipt after the fixture changed
the file independently, then reported an unknown outcome for an incomplete
receipt without changing that file. The guest Run lifecycle smoke and the
Explorer unit test also passed. SSH, Windows, and release image builds were
outside this validation. Paged reads, binary writes, imports and chat file
integration remain open.

## 166. Read binary pages, text previews, logs and media in Rust

Reference commit 963dcfb66a6bf47faf35cd19640dc6cf0220e3ec (#3329).

Host and guest Explorer and file-document operations share the native read
implementation. Each page opens its own file handle and bounds the read.
Binary snapshots retain the existing signed metadata fields and version
tokens. Text previews retain their line and byte limits, preserve the BOM,
and keep complete UTF-8 characters together. Log cursors preserve the
file identity and anchor used for append and rotation detection. Stat dates
use the rounding applied by the Node file metadata API.
[Node stat date conversion](https://github.com/nodejs/node/blob/v24.22.2/lib/internal/fs/utils.js#L406-L443)

Executor 0.16.0 carries these operations into the guest. Media pages reuse
the protected operation until the final chunk. Binary pages, text previews,
and log polls use independent protected requests as before.

The macOS Explorer fixture passed 78 comparisons against Node, including
exact versions, stale-version errors, split UTF-8, log rotation, media types
and timestamps. The Windows x64 GNU worker cross-check passed. Local
Docker ARM64 testing used the production Rust server and worker with the
locally assembled executor package. It exercised the protected reads,
compared binary versions and log cursors with the Node guest helper on
the same file, and checked media sequence completion. Windows runtime,
SSH and release image builds were outside this cycle. Binary writes,
imports and chat file integration remain open.

## 167. Stage and atomically publish binary file saves in Rust

Reference commit bc245f4bc7c2ad7f1f6cb2ba2aec3866d30a06a1 (#3330).

Host and Cantrip OS Explorer and file documents use the native writer for
begin, chunk, commit, status and abort. The writer keeps the original upload
identity, AES-GCM stage framing, receipt envelope and key derivation. A
restart can resume the last acknowledged offset or observe a prepared
publication. Page retries must match the authenticated original.

The writer verifies the staged bytes before publishing beside the target.
It rechecks the captured file version and preserves permissions. Creating
a new destination uses exclusive publication. Upload and destination locks
coordinate worker tasks and separate guest helper processes in each workspace.
Status verifies the actual target when an interrupted publication consumed
its temporary file. A conflicting destination retains the draft.

Local macOS ARM64 testing used the production Rust server and worker for
multi-page saves, retries, checksum failures, worker restart, early abort,
permission preservation, and Save As races. A legacy writer published a file
and lost its committed receipt. The Rust worker reopened the prepared record
and verified the target. The ARM64 Docker guest used the locally assembled
executor 0.17.0 package and resumed the same protected upload after a worker
crash. The legacy and native guest helpers each completed an upload staged
by the other. All 12 shared crypto tests and the Windows x64 GNU cross-check
passed. Windows runtime, SSH and release image builds were outside this
validation. File imports and chat file integration remain open.

## 168. Import dropped files through the native Host Explorer

Reference commit 6385ac8377a9ab70cedd14902ee577d524970c1e (#3331).

The Host worker accepts protected import chunks and cancellation through the
existing Explorer surface. A transfer reserves one of 16 slots and stages
bytes in an anonymous temporary file. The worker binds subsequent chunks to
the original destination and exact offset. Cancellation, invalid input,
five minutes of inactivity, or worker exit close the open stage.

At EOF the worker checks that the captured folder still exists at the
authorized location. It prepares a private file on the destination filesystem
and exclusively links the complete bytes through a directory handle.
Competing files and dangling links keep their original entries.

The production Rust server and worker passed the local macOS ARM64 Explorer
smoke against the existing Node import implementation. The fixture checks
multiple chunks, exact bytes and compatible receipts, no visible partial file,
empty files, collisions, cancellation, changed offsets, the active transfer
limit, a replaced directory, and worker restart. Windows x64 GNU worker
compilation passed, and the existing Host binary-save smoke passed. Windows
runtime and other destination filesystems were outside this validation.
Exclusive publication currently requires filesystem hard-link support.
Cantrip OS imports still need the native helper to retain its import state
across executor requests.

## 169. Retain native Explorer imports in Cantrip OS

Reference commit 3284e8d80c34b6da930aeb68988491e36b35ffc4 (#3332).

Executor 0.18.0 runs the shared Rust import stage under the admitted Linux
workspace account. The worker reuses the generation-bound executor session
while that placement has active imports. Other file commands for the same
placement continue through the same serialized helper. Placements without
imports keep the single-operation invocation.

The final chunk and cancellation reclaim the helper when its other transfers
have ended. Idle stages expire after five minutes. Orderly worker shutdown
terminates the retained native process. After a crash the next operation
retires the helper in its saved session and can observe the original
version-one receipt.
Reopening a receipt cannot reconstruct an abandoned stage or replay a write.
The publication still requires filesystem hard-link support.

Local macOS ARM64 validation used the production Rust server and worker with
executor 0.18.0 assembled for a disposable ARM64 Docker guest. The protected
file smoke verified both chunks and exact bytes, cancellation, an interleaved
directory read, admission conflict isolation, graceful shutdown and crash
recovery. The legacy helper observed the native completion receipt. Host
Explorer imports and guest Run supervision passed their local regressions.
The Windows x64 GNU worker compiled. Windows runtime, SSH and release image
builds were outside this validation. Guest chat files and attachment
materialization remain open.

## 170. Resolve protected chat file references in Host and Cantrip OS

Reference commit 23214927daef64ea1db067971084e063bb4fbad8 (#3333).

The native worker dispatches the existing protected Chat file-reference
operation through the shared surface replay guard and the authoritative
protocol schemas. Executor 0.19.0 resolves Linux chat references as the
workspace account in the selected placement. The Host path uses the same
resolver on the local checkout.

The resolver preserves reference order, line and column suffix handling,
file URLs, and canonical checkout aliases. It returns an unresolved kind
for missing files and paths beyond the checkout, including links that lead
outside. Lookup only examines the supplied entries.

The protected Host and ARM64 Docker guest routes matched the Node resolver
for line suffixes, file URLs, missing references, and links outside the
checkout. The local fixtures also compared the exact lexical result for
a lone UTF-16 surrogate. The guest ran the production Rust server and
worker with executor 0.19.0 installed and the legacy helper moved aside
for the native query. Guest Explorer, file documents and imports passed
their local regressions. The Windows x64 GNU worker compiled. SSH and
Windows runtime were outside this validation.

Guest Codex turn preparation and attachment materialization remain open.

## 171. Prepare and reopen a managed Chat thread in Cantrip OS

Reference commit f1ab36e398ea87e51c55b543ccadbb0bf8c7bc84 (#3334).

The Rust worker handles guest placement in `chat.thread.ensure` through
the existing authenticated worker command connection. It captures the
attached executor and workspace identity, preserves the saved placement
record, and selects the same Codex home and remote environment ID as the
Node worker. The home contains a single remote executor configuration.
Codex must acknowledge the admitted guest environment when starting or
resuming the thread. The worker accepts configured network MCP servers
for guest preparation.

Local macOS ARM64 validation used the production worker, bundled Codex,
and a disposable ARM64 Docker guest with a fixture Core command peer.
It compared the saved placement and exact executor configuration with
the Node implementation, reopened the same thread after worker restart,
and rejected a changed binding. The Host project and standalone thread
and MCP cases passed in the same fixture. The Windows x64 GNU worker
compiled. SSH and Windows guest execution were outside this validation.

Guest turn dispatch, the guest console, attachment materialization,
first-party guest MCP, and cold guest observation remain open.

## 172. Dispatch protected Chat turns in the captured Cantrip OS workspace

Reference commit 091c7142ec8ffe1f91e10d386c55bf3895ef6a53 (#3335).

The existing `chat.turn` handler prepares and runs text input on the
admitted guest Codex thread. It sends the selected environment and exact
Linux working directory to Codex. Guest threads disable native subagents,
as in the Node worker. The worker uses the existing inference admission,
GUI receipts, encrypted streaming and canonical History paths. A saved
guest placement cannot fall through to a Host turn.

The local macOS ARM64 fixture ran the production worker and bundled Codex
with a Core command peer and a loopback provider. The provider requested
a shell command and received the guest checkout path, Linux workspace UID,
and bytes from a guest-only file. The test verified the protected reply,
canonical message identities and History commit replay, and found the
completed turn after restarting the worker. The Host streaming, Stop, GUI
receipt and History smoke tests passed. The Windows x64 GNU worker compiled.
SSH and Windows guest execution were outside this validation.

Guest attachment and skill materialization, first-party MCP, console,
suspended turns, computer use and cold guest observation remain open.

## 173. Materialize Chat attachments in the admitted Cantrip OS guest

Reference commit 891419119253888cf0e54dcacde55c51c7794560 (#3336).

The Rust worker authenticates attachment metadata and verifies uploaded
bytes before transferring them through the selected guest executor. It
shares the existing guest file operation service with Explorer. Executor
0.20.0 publishes read-only files in the workspace account's private
attachment directory. It preserves the Node operation identity, path and
receipt format. An existing receipt verifies the stored file before reuse.
The model receives Linux paths for file access and inline bytes for images
when the selected model supports them.

Local validation used the macOS ARM64 worker and bundled Codex with a
disposable ARM64 Docker guest and the rebuilt Linux helper. An admitted
protected turn read the guest attachments, including a 6.4 MB file whose
encoded input exceeds the old helper frame limit. The provider received
an inline image and guest file references. Node seeded a receipt
that the native helper reopened. Node then reopened the native receipts.
The Host rich and legacy queued-turn fixture passed. The Windows x64 GNU
worker compiled. Full release package builds, SSH and Windows guest
execution were outside this validation.

Guest console startup, first-party MCP and suspended-turn recovery remain
open, along with the remaining worker replacement and cutover work.

## 174. Run native guest terminals and prepare encrypted console state

Reference commit b9bf3d1567956f8700ec0d7e84695a192ced0702 (#3337).

The authenticated terminal command service opens Cantrip OS shells in
the captured Linux workspace. The executor owns the PTY. Rust sends
input and resize requests over the existing carrier and sends protected
output through the same terminal presentation used by Host shells.

The worker retains the Node index, descriptor and process admission
formats. It records the session and process before starting the PTY.
After a restart it observes the retained process and replays available
output. Close can retire the saved session without opening a new shell.

The worker implements the existing `terminal.prepare-state` command for
linked consoles. The protected title and empty state use the same metadata
and private-state grants as the Node worker. The Codex TUI gateway and
managed console process launch remain open.

Local macOS ARM64 testing used the production Rust server and worker
with an ARM64 Docker guest. It checked protected input and output,
workspace cwd, actual PTY sizing, reattachment, worker crash recovery,
and cold close of the same saved process. The Node crypto reader opened
the prepared console title and state in a separate worker command
fixture. The Windows x64 GNU worker compiled. SSH, Windows runtime,
and the managed Codex TUI were outside this validation.

The Host shell, WorkerLink and terminal service relay fixture passed on
a serial rerun after a transient input error during the concurrent run.

## 175. Serve first-party Cantrip MCP for admitted Cantrip OS Chats

Reference commit a940226756c462cb48ade3118f44bcf8cbab9f57 (#3338).

Guest preparation advertises the supported first-party Cantrip tools through
the worker's authenticated Streamable HTTP endpoint. The existing app-server
client and credential stay on the owning worker. The same broker authorizes
Host stdio and guest HTTP operations against the active Chat execution lane.
Tool discovery and help remain available while idle. The broker retires lane
authority at turn completion and rejects revoked credentials. Enabled
worker-local user stdio configurations give the same error as the Node worker.
Disabled entries remain ignored and user network configurations retain their
existing transport.

The macOS ARM64 smoke used the production Rust worker, bundled Codex, a
network-isolated ARM64 Docker guest and a fixture Core command peer. It
compared tool schemas and help with the Node implementation and exercised an
actual context call during a protected guest turn. It checked wrong
credentials, idle calls before and after execution, protected history and
restart. A separate Rust-server PGlite fixture matched active HTTP and stdio
results and confirmed denial after lane release and credential revocation.
The Host MCP differential smoke passed 31 comparisons and the Windows x64
GNU worker compiled. SSH and Windows runtime were outside this validation.

The guest catalog exposes the Rust broker's implemented tools. Guest CUA MCP,
managed Codex TUI launch, and suspended guest turns remain open.

## 176. Open a managed Codex console on its prepared native thread

Reference commit 23d86fa76df635c83a58496c8d17b2f11f0340cf (#3339).

The worker starts bundled Codex on its existing protected PTY service.
A Cantrip OS console uses the worker's private runtime home. Its dedicated
native WebSocket attaches to the prepared Linux thread with a preserving
resume. The gateway binds a random loopback capability to the selected
runtime generation, scopes thread reads and listings to that thread, and
uses Core receipts for attach, detach and admitted skill discovery. Skill
discovery receives the captured workspace directory. The terminal can be
closed through the existing command, and its exit notification carries the
managed preparation generation.

The local macOS ARM64 fixture used bundled Codex, the Rust worker, a fixture
Core command peer, and an ARM64 Docker guest with networking disabled.
After a worker restart, the actual TUI displayed its original protected
guest transcript through the terminal stream. The fixture decrypted the
Core receipts, verified the original thread and guest directory, and
confirmed that opening the console did not create another provider call.
The Host shell relay, WorkerLink terminal and terminal service regression
ran locally with the Rust server. The Windows x64 GNU worker compiled.
Windows runtime and SSH were outside this validation.

The terminal view handles attachment and discovery. Direct prompt
admission, canonical queue operations, settings, approval replies and
managed runtime handoff remain open. Those operations require their
canonical command owners before console parity can be declared.

## 177. Submit protected prompts from the managed Codex console

Reference commit 5bca3dbae99d0c7780db0a96ae96359df698b8f1 (#3340).

The worker sends console prompt admission through Core for the prepared
thread and placement. The admission contains the encrypted native input,
queue display and pending user message with the existing stable identities.
The worker requests inference on the admitted lane, uses the prepared
app-server connection, and acknowledges native acceptance through Core.
After dispatch the worker owns the turn beyond the terminal view's lifetime
and publishes protected output and canonical History on that thread.

The local macOS ARM64 fixture used the production worker, bundled Codex,
a fixture Core peer and a network-isolated ARM64 Docker guest. It typed a
prompt over the protected PTY, compared the decrypted input and retained
identities with the Node codec, and closed the console after acceptance.
The guest command still completed, its protected History committed, and
the same native turn was recovered after a worker restart. Host
preparation, streaming, MCP and Stop passed in the same fixture. The
fixture also exercised a read-only console on a primary checkout with a
stored workspace-write selection. The Windows x64 GNU worker compiled.
The existing Rust-server and Node-reference HTTP fixture matched encrypted
terminal input recovery on PGlite for all three authentication modes.

Local and inline console media still need durable attachment
materialization. Canonical console queue operations, settings, approval
replies and managed runtime handoff remain open.

## 178. Retain media submitted from the managed Codex console

Reference commit d541dcb54c75813054dcca9a5bd0bedd067f3f40 (#3341).

The worker snapshots local image and audio inputs and imports supplied
data URLs through the ordinary worker attachment store before Core
admission. Native inputs reference the captured bytes, and pending
Chat messages carry the matching encrypted attachment summaries. The
retained input includes the existing attachment index map and keyed
identities. External media URLs stay in the native input.

The local macOS ARM64 fixture pasted an image into bundled Codex over a
protected PTY. The Node reference decoded the prompt and matched the
attachment identity, metadata and stored bytes. The provider fixture
received the image during a Linux guest turn, and the original protected
turn and its attachment survived closing the console and restarting the
worker. The same fixture passed Host streaming and Stop. The history
adapter fixture passed 107 comparisons and the crypto envelope tests
passed. The Windows x64 GNU worker compiled. Live audio and Windows
runtime were outside this validation.

Canonical console queue operations, settings, approval replies and
runtime handoff remain open.

## 179. Use Core's canonical queue from the managed Codex console

Reference commit f1fda95e8308638bb676e3481d5daade304cd62c (#3342).

The Rust gateway negotiates the managed queue with bundled Codex. List,
add, update, delete, reorder and start use the worker-authenticated Core
queue endpoints. The worker encrypts mutations and reconciles the same
operation ID before sending a write. It preserves accepted item identities
and attachment mappings. Queue start waits for the protected execution
receipt and checks the claim and native turn together. Core queue revision
notifications reach open views on the bound thread.

The macOS ARM64 fixture opened the bundled console and observed its
queue read. A second scoped connection exercised all six methods against
a fixture Core peer. It verified receipt lookup after a lost response,
pagination and stale cursor rejection, protected edits with retained
media, and external revision delivery. The Node codec matched the sealed
input and stable identities. Actual Host queued execution, guest Chat,
and console image submission passed in the same fixture. The existing
Rust-server and Node-reference PGlite queue HTTP comparison passed for
local authentication mode. The Windows x64 GNU worker compiled.

Import of legacy runtime-local queue items, managed console settings,
approval replies and runtime handoff remain open.

## 180. Preserve legacy native queue items in managed consoles

Reference commit 9031b0c98d076f20a207b97e9b8beb77ca439757 (#3343).

The console reconciles the prepared app-server's local queue with Core.
The worker stages each encrypted source with its existing prompt identity
and keyed digest. Core holds the prompt from dispatch while the selected
native runner compares and deletes the exact source. The worker
acknowledges the durable deletion receipt through Core before the prompt
becomes eligible. It checks outstanding imports even when the local queue
is empty. Views for the same Chat serialize imports and refresh on native
queue changes.

The local macOS ARM64 fixture seeded the persisted queue in the disposable
guest Chat's Codex home before reopening it. The Node codec matched the
imported prompt and verified the protected source and digest. The fixture
dropped the first Core acknowledgment after checking the real native
deletion receipt. The next interaction recovered one canonical prompt with
its original client message identity. A source for another thread remained
in native storage. The queue controls and protected console image
submission passed in the same run. The Rust-server PGlite queue fixture
matched the Node reference for local authentication. The Windows x64 GNU
worker compiled.

Headless queue import observation, console settings, approval replies and
runtime handoff remain open.

## 181. Reconcile native queues without an open console

Reference commit 3bc6e385a101791e0f9868be1602f4e58e7bb7a2 (#3344).

The selected managed thread observes native queue changes through the
worker's own app-server connection. Reopening a bound thread after a worker
restart reconciles its persisted queue even when the native runtime emits
no initial change. Imports and console operations share the same
per-Chat serialization and revision state. Closing a console leaves the
worker's observer attached. Replacing the owner, revoking its Chat, or
closing the native thread retires its authority. Repeated queue changes
during an import are coalesced, and a native deletion notification can
retry a lost Core acknowledgment without continuously replaying a
failed acknowledgment.

A local macOS ARM64 smoke ran the production worker and bundled Codex with
a disposable Linux guest and a controlled Core peer. After restart it
dropped the first import acknowledgment, verified the durable exact-deletion
receipt, and waited for the native change observer to recover one canonical
prompt before opening any console. The Node codec verified the original
input and message identity, and the unrelated thread's source remained
intact. The console later listed the recovered prompt and passed the queue
controls and protected image fixture. The Windows x64 GNU worker passed a
cross-compilation check.

Managed console settings, the permission-settlement queue resume path,
approval replies, and runtime handoff remain open.

## 182. Apply settings from the managed Codex console

Reference commit 2e7fd7386b90a12f6fd3b93b6d1f567d2ac7e99f (#3345).

The console submits ordinary thread settings through Core's native command
admission, dispatch and receipt endpoints. The worker sends the admitted
payload on its own app-server connection. A supplied native operation ID
remains distinct from the Core receipt ID. If the console omits the native
operation ID, the worker supplies the Core receipt's operation ID. The
worker preserves explicit null effort and service tier selections, and
checks that any working-directory override resolves to the prepared
placement. Security changes require the managed permission transition.

The existing settings outbox records the native response and independently
observed application. Both the console and Core-originated settings paths
reuse that settlement, which retains the evidence beyond the lifetime of
a console socket.

The macOS ARM64 smoke used the production worker, bundled Codex, an
isolated Linux guest and a Core fixture. The Node codec decoded and
verified the admitted request, reply and application evidence. Native
reads confirmed explicit standard service tier, clearing the tier
override, and setting and clearing reasoning effort. The console
rejected a different thread, another workspace and an unadmitted
permission change. The existing queued Plan Mode smoke passed with
restart replay and recovery of an older Node outbox record. The Windows
x64 GNU worker passed a cross-compilation check.

Live-turn settings, the managed settings snapshot publisher and account
defaults, permission transitions and their queue resumption, approval
replies, and runtime handoff remain open.

## 183. Publish protected native thread settings

Reference commit 601a080d49aab327b80566f977201b50ef9d45c1 (#3346).

Core can read the selected native thread's settings through
`chat.settings.read`. The worker checks the selected chat, placement,
provider account, thread, and runtime before and after the actual
app-server read. The read can reconcile a lagging projected model route
while preserving the native source. It never starts or resumes a thread.

The selected thread owns publication independent of a console. The worker
refreshes the Core binding on attachment and reconnect, seals versioned
native notifications, and posts them through the existing observation
endpoint. It coalesces newer observations, retries lost deliveries, and
refreshes if Core replaces the binding. The existing operation evidence
outbox still records historical outcomes. Snapshot encryption preserves
the Node codec's UTF-16 canonical ordering and its separate fingerprints
for settings content and model attribution. An exact configured model
can be attributed using its admitted route. Discovery of alternative
models and aliases remains open.

A local standalone test ran the production Rust server with PGlite and
the production Rust worker with an empty PATH. Bundled Codex provided
the live settings read. The public settings endpoint returned the
background binding, and an explicit refresh kept the same binding and
content fingerprint. The Node codec decoded the opaque snapshot.

The macOS ARM64 guest smoke matched the Node codec for settings reads
and subsequent observations from bundled Codex. It rejected a different
worker and placement, allowed the selected source to reconcile a lagging
route, and recovered after the fixture dropped a publication response.
The worker passed its Windows x64 GNU cross-check and the server passed
its native PGlite build check.

Permission transitions and recovery, live-turn settings, client settings
updates, account defaults, approval replies, and runtime handoff remain
open.

## 184. Apply encrypted client settings updates

Reference commit 48c45cc7f6ed2f9ea90c6fc407137971dd3b841b (#3347).

Core sends the existing `chat.settings.update` command to the worker that
owns the binding. The worker authenticates the encrypted patch against the
chat, binding and operation, checks the selected native thread's epoch, and
submits only the explicit fields to Codex. The exact binding and operation
travel through Core's admission and dispatch. The console and client share
the native settings dispatcher and evidence outbox. A correlated
application event can confirm an applied receipt. A native acknowledgment
alone reports a queued update.

The production Rust server and worker passed the local standalone PGlite
fixture with bundled Codex. The Node codec encrypted the client patches
and opened the resulting snapshots. The fixture verified sparse writes,
clearing effort and the service-tier override, mode preservation, and
stable operation identity. An incorrect cryptographic binding and an
unauthorized workspace produced no settings revision. Repeating an
already-applied operation produced no second revision.
The guest console settings and queued Plan Mode recovery smoke passed on
rerun after a timeout in the later image test. The native server check
and Windows x64 GNU worker cross-check passed.

Managed permission transitions and recovery, live-turn settings,
account defaults, alternate model attribution, approval replies, and
runtime handoff remain open.

## 185. Read and write protected native account defaults

Reference commit 1f19d70702b846873ff956efd55bb13044f05ca0 (#3348).

The Rust worker now handles `chat.account-defaults` on the current
managed binding. It reads the stored and effective defaults through
Codex's configuration API and limits the protected result to model,
reasoning effort, service tier, personality, and native version evidence.
Writes authenticate the client operation and binding, use Core's durable
account-defaults admission, and pass the expected version to Codex.
Explicit null clears a stored default. The target is the managed user
configuration selected at process launch.

The receipt records a native write acknowledgment even if a subsequent
read cannot verify it. Replays of an operation with a receipt cannot
dispatch another write. The thread settings revision is independent of
the account defaults revision.

The local macOS ARM64 standalone smoke used the production Rust server
with PGlite, the production Rust worker with an empty PATH, and bundled
Codex. The TypeScript codec encrypted requests and opened protected
responses. The test confirmed versioned writes, clears, wrong-binding
rejection, stale-version rejection, replay prevention and preservation
of active thread settings. The Windows x64 GNU worker cross-check passed.

Managed console account configuration writes, permission transitions
and recovery, live-turn settings, alternate model attribution, approval
replies and runtime handoff remain open.

## 186. Apply and recover managed client permission transitions

Reference commit 6458466edc9480a9cafe382f4227ad85bae6bc25 (#3349).

The Rust worker handles Core's bound `chat.permissions.update` command
using the selected thread, runtime, native epoch and existing durable
settings admission. Codex applies the server-resolved profile at a
quiescent boundary. A permission claim requires the correlated native
application and matching resolved security fields. The executor, settings
publisher and console share the prepared permission selection that Core
confirms after publication.

Permission registrations use the existing scoped settings evidence files.
On a fresh binding the publisher reads the exact native operation journal
and current settings. It preserves historical application separately
from evidence for the new binding. A missing acknowledgment leaves the
operation available for journal reconciliation. Recovery sends evidence
without submitting the permission change again.

The macOS ARM64 standalone smoke ran the production Rust server with
PGlite, the production worker with an empty PATH, and bundled Codex. It
changed the profile to read-only, rejected a stale policy revision and
reconfirmed the same operation and policy revision after a worker
restart and native runtime replacement. The guest settings and queue
smoke passed with the existing Linux image. The Windows x64 GNU worker
cross-check passed.

Console-originated permission edits and automatic resumption of input
deferred by a permission transition remain open. Live-turn settings,
alternate model attribution, approval replies and runtime handoff also
remain open.

## 187. Resolve managed console permission choices through Core

Reference commit 099791658739dd774929f9c73818c0ed9021a321 (#3350).

The managed console resolves named permission selections through Core
using its exact thread, placement, route and runtime. If Core needs a
binding, the worker refreshes the actual thread settings and retries
the resolution. The terminal admission retains both the Core operation
identity and the native request identity.

The worker forwards the server-resolved effective profile at the native
quiescent boundary. Codex rejects attempts to combine that permission
change with ordinary settings, and the console receives the native
error. Custom sandbox overrides and mismatched approval policies are
rejected before admission. Application and recovery use the existing
versioned permission journal.

The local guest console smoke used bundled Codex and verified the binding
refresh, Core's stricter effective selection, native application and
mixed-setting rejection against the protected receipts and evidence.
The standalone Rust server and worker settings smoke passed with native
PGlite. The Windows x64 GNU worker cross-check passed.

Durable retention and automatic resumption of prompts deferred by a
permission change remain open.

## 188. Recover permission-deferred native input after worker restart

Reference commit ecc3233f8381dffca603fbd7d96997eaf3dac088 (#3351).

An exact native `turn/start` rejection with `pendingSettings` and
`inputConsumed: false` now produces the same durable settlement record
as the Node worker. The worker preserves the admitted encrypted GUI input
and its portable native input when Core has no queue claim. Existing claims
retain their current prompt and placement. Core validates the settlement and
releases the physical execution and queue claim together. The original
command response leaves logical completion to Core.

The worker retries the saved receipt on reconnect or restart. It stores the
correlated acknowledgment before removing the pending file. Core resumes the
canonical queue after a committed eligible receipt or when authoritative
permission evidence settles the transition. Existing queue ownership, Pause,
Stop, and unresolved permission checks still control admission.

The local macOS ARM64 standalone smoke used the production Rust server with
PGlite, the production Rust worker with an empty PATH, and bundled Codex. The
fixture supplied one exact native no-consumption response and dropped receipt
delivery before Core received it. The worker reopened the Node-serialized
pending record after restart, saved a matching acknowledgment, and the same
queued input reached the local provider and chat history once. The settings
smoke covered ordinary settings, account defaults and permission recovery.

## 189. Route protected replies for managed GUI turns

Reference commit 19df79b0a95d7e6110097acb8133c76452020a01 (#3352).

The worker owns native interaction requests on the exact managed root
thread. It registers command and file approvals, permission requests,
user input, and MCP elicitation with Core before publishing the request.
Protected requests and responses use the existing interaction component
key and request-key context. The original tracked turn, native runtime,
route, account, and activation constrain a reply.

A separate Core receipt claims the native request before the worker
responds on its owning connection. The connection consumes a request
once and fences a reply that lost to native resolution. Cancel, expiry,
and turn teardown retire pending requests and preserve safe native
responses. The active turn waits for any submitted reply to finish its
settlement before releasing local interaction ownership.

The local macOS ARM64 smoke used the production Rust worker, Rust Core
with PGlite, and bundled Codex. A controlled native approval tested the
TypeScript crypto in both directions, a reply bound to a different request,
and replay rejection. Exactly one native decline reached the connection,
and the turn completed. The deferred-input restart and settings smokes
also passed. The Windows x64 GNU worker check passed.

Console-owned and restored turns, subagent interactions, and pending
Plan Mode question projection require further integration.

## 190. Route linked-console replies for managed turns

Reference commit dffd5cc3d2884556d1414448b90126e7552776f8 (#3353).

Client and console turns share one native request owner. The console gateway
publishes a request only after Core registers it and the worker publishes the
protected request event. An attached console receives pending requests for its
selected thread and their resolution notifications. The gateway preserves the
managed reply acknowledgment and accepts the legacy raw reply envelope.

The active turn claims a separate Core receipt before sending a reply on its
owning app-server connection. The receipt binds the console session and native
request and protects the response. A detached or unrelated console cannot
claim a pending request. GUI and console replies share the same single-use
native request, and the turn drains accepted replies before settlement.

The local macOS ARM64 smoke used the production Rust server with PGlite, the
production Rust worker, and bundled Codex. A controlled command approval
was visible to the attached console alone. The gateway rejected a guessed
request ID, a malformed reply, and a replay. Exactly one decline reached the
native connection, the TypeScript codec opened the resolution persisted by
Core, and the turn completed. The GUI approval and deferred-receipt restart
smokes passed. The Windows x64 GNU worker compile check passed.

Restored turns, subagent interactions, and pending Plan Mode question
projection remain open.

## 191. Route protected replies after restoring a held Chat turn

Reference commit ae6e04bdc306cd45567b3153bf24b9b79e8defb0 (#3354).

Cold Resume reserves the native interaction channel before releasing a
held Chat turn. It uses the same request owner as a new turn with the
replacement runtime, Core receipt, and activation. Prompts carry the
original thread and turn identities. Replies are admitted on the current
activation before delivery to its app-server connection. When the turn
ends, the owner drains accepted replies and releases the channel before
the final turn receipt.

Local macOS ARM64 validation ran the production Rust server with PGlite,
the production Rust worker, and bundled Codex. The test paused at a real
native boundary, restarted the worker and Codex, and injected one command
approval after native Resume. It confirmed that the original turn was
resumed, rejected a mismatched encrypted reply and a replay, delivered
one decline on the current native connection, and opened the encrypted
resolution and resumed assistant message stored by Core. The GUI and
linked-console approval regressions, cold Resume and cold Stop transport
fixtures, and Windows x64 GNU worker compile check passed.

Subagent interactions and pending Plan Mode question projection remain open.

## 192. Publish and clear protected Plan Mode questions

Reference commit b7f48d1c38ce1fcc4e1db3862c133ceaa3a1571c (#3355).

Native user input with a turn and item identity now updates the encrypted
Chat plan after the ordinary interaction request is registered. The plan
uses the same request key, thread, and turn. Its answer, expiry, native
resolution, or cleanup clears the matching question. Existing explanation
and steps stay in the worker's encrypted plan state. The app-facing event
format and Core plan storage are reused.

The macOS ARM64 smoke used the production Rust server with PGlite, the
production Rust worker, bundled Codex, and a loopback provider. A default
project turn saved a checklist through Codex. The next turn used Plan Mode
and waited for a real native user-input request. The existing TypeScript
codec opened the API's encrypted question, the worker authenticated the
reply and delivered the answer to Codex, and the question cleared with
the checklist intact. GUI, linked-console, and restored approval smokes passed. The
Windows x64 GNU worker compile check passed.

Explicit Plan Mode reads and writes (`chat.plan.get` and `chat.plan.set`)
and subagent interactions remain open.

## 193. Read and change Plan Mode through the Rust worker

Reference commit b6292e25c9aa5d54b8f9fbd651daf200b5999078 (#3356).

Plan Mode reads the actual settings of the selected native thread. An
unloaded thread returns the caller's stored fallback. Writes use the
existing collaboration presets and wait for the matching native settings
application. Core supplies the managed session and MCP configuration when
available. That path preserves the thread's other native settings and can
recover the selected placement before applying the mode. Older command
payloads use the same native settings operations with their existing
account, provider, and thread identifiers.

Local macOS ARM64 testing used the production Rust server with PGlite,
the production worker, and bundled Codex. Project API writes switched modes
on the same thread, native settings reads confirmed both values, and an
active turn rejected a change. The existing encrypted Plan Mode question
flow passed. A fresh standalone Chat accepted default mode and rejected
the unsupported Plan Mode setting. The direct command fixture exercised
unloaded reads and the original Plan Mode payload across worker restart.
The older TypeScript schema accepted the extended command by retaining
its existing fields. The Windows x64 GNU worker compile check passed.

## 194. Route protected subagent approvals through the active root turn

Reference commit b72e5865ef7ba0a0f9e69f95f1cd14df48c53c5f (#3357).

The Rust worker associates a native child with the active Host Project Chat
using app-server ancestry and the child's exact root turn ID. Native
collaboration items establish ancestry when Codex omits a child thread-start
notification. Requests keep the child thread, turn, and item in their
protected provenance. Core admits the reply against the root activation and
the registered child request. The original app-server connection consumes the
reply once. The linked console uses the child thread ID when forwarding
resolution. A completed or unloaded child retires its pending requests.

Local macOS ARM64 testing used the production Rust server with PGlite, the
Rust worker with an empty PATH, bundled Codex, and a loopback model provider.
Codex discovered and spawned a real child, which asked for command approval
while its root turn was active. The TypeScript codec opened the child request,
the server rejected a reply encrypted for another request, and the child
received one decline. The API rejected a replay and the stored resolution
decrypted to the same decline. Root GUI, linked-console and cold-resume
approval smokes and the Plan Mode question smoke passed. The Windows x64
GNU worker compile check passed.

Alternate subagent model routing and attribution, and managed runtime handoff,
remain open.

## 195. Route configured subagent models on the existing native runtime

Reference commit a0a53062b73574da7db35d38078b913754057a84 (#3358).

The Rust worker sends its probed Codex compatibility report at enrollment and
in heartbeats. Core can select a custom Host Project Chat subagent route using
the existing protocol. Before native preparation the worker opens both
provider envelopes and requires the same provider, kind, account and
credential home. The selected child model and effort travel through the
existing managed thread configuration.

For endpoint providers, the app-server starts with a static catalog from the
explicit model selections and the available provider-scoped inventory.
Configured selections remain usable if inventory is unavailable. A reused
process installs newly selected models through its serialized, revisioned
catalog update. It retains other models already used by that process and
checks the native acknowledgment. Native discovery owns the ChatGPT catalog.
Changing the child model keeps the root thread and provider process.

Local macOS ARM64 validation used the production Rust server with PGlite,
the production Rust worker, bundled Codex and a loopback Responses provider.
The real child requested the custom model with high reasoning effort after
its root runtime was prepared. The parent retained its model, thread, and
native runtime generation. Core rejected the incompatible provider route.
The child approval and replay checks passed. Default subagent, Plan Mode,
linked-console approval and cold-resume approval smokes also passed. The
Windows x64 GNU worker compile check passed.

Live native picker inventory refresh, per-turn model attribution and managed
runtime handoff remain open.

## 196. Preserve the model selected at each canonical native turn

Reference commit 2559a105f21d1cc97db8e72ed9686686269af3ea (#3359).

The worker binds the configured root and child routes to the prepared
native thread. It records the route context when Codex starts each turn.
A native child inherits the context of its exact causal root turn, and
the history binder verifies the child's ancestry before publication.
Model selection uses Codex's immutable initial settings and the provider
scope. An exact configured route takes precedence over other candidates
with the same native name. An unexpected model uses only that provider's
inventory.

The socket adds observed attribution before the history notification is
captured. A history read can carry the same evidence to a child whose
subscription started after the turn. If Codex supplies the initial
settings in retained history, the worker joins them to the captured
route context. Canonical projection uses the existing protected turn
envelope and response usage contract. Existing committed attribution
survives worker restarts through the history journal and Core.

The macOS ARM64 fixture ran the production Rust server with PGlite, the
Rust worker, bundled Codex, and a loopback Responses provider. The
TypeScript codec opened separate canonical records for the root and its
real subagent. The child kept its own route and high reasoning effort.
The usage export showed measured tokens under the correct route for
each turn. Both records remained readable after restarting the worker
and the usage export still contained one row per turn. The Plan Mode
question and cold-resume approval regression fixtures passed.

Live attribution for output outside canonical history, native picker
inventory refresh, and managed runtime handoff remain open.

## 197. Transfer a settled managed Chat between native providers

Reference commit 0793ad520e4d4d989e54b7481848af9faa9f7e60 (#3360).

The Rust worker now handles the existing runtime handoff command for a
settled managed Chat. It holds the original native producer, records the
actual last turn, and exports portable history through bundled Codex. It
reuses the version-one plan, export receipt and namespace selection formats.
The destination loads the same thread in its private home, resets its model
context, and returns an encrypted snapshot of the confirmed native settings.
The worker adopts that home after Core commits its binding. A retried
committed operation reopens the same destination and recovers its runtime
generation. Cancellation releases the source with its native hold revision
and retires the staged destination.

Local macOS ARM64 smoke tests used the production Rust Core with PGlite,
the production Rust worker, bundled Codex and two loopback providers. A
provider switch preserved the native thread and encrypted conversation
history across a worker restart. The target provider received its selected
model and a cleared model context. Another run dropped the commit response
after Core persisted it and completed the same operation after restart.
A third cancelled a prepared transfer and executed another turn on the
original native runtime. The Plan Mode settings and protected question
regression passed on the same worker build.

Handoffs of live queued prompts and recovered Goals and Tasks still need
worker withdrawal and acknowledgement. An open managed console still
needs to retarget to the newly selected runtime.

## 198. Transfer an unused queued Chat prompt between providers

Reference commit 356dda0cb331bc11084086e642c1ae1c00dcdc24 (#3361).

An accepted GUI prompt exposes its exact worker inference reservation to
the handoff coordinator. The coordinator seals the unused reservation through
the native keeper and writes the version-one withdrawal journal. The original
command waits until Core acknowledges the withdrawal and returns the same
prompt to its queue. Recovery reads the existing handoff and keeper evidence.
A reservation that already crossed the dispatch boundary stays with its
original execution. The worker retires confirmed withdrawal metadata after
the handoff settles.

Local macOS ARM64 tests ran the production Rust Core with PGlite, the Rust
worker and bundled Codex. The Standalone Chat transferred its exact prompt
while an unrelated Chat held the source provider's only slot. The target
executed the prompt once and retained its protected message ID. A second run
dropped the withdrawal response after Core persisted it and completed the
transfer after a worker restart. Cancellation at that same boundary resumed
the original prompt once on the source provider. The existing deferred
permission receipt restart test also passed.

Withdrawal of queued autonomous Goals and Tasks, recovery of retired Goal
sources, and retargeting an attached managed console remain open.

## 199. Transfer and resume a recovered managed Goal

Reference commit c88765c076c3a2d8d2a7b9e8ac292f6c276306c8 (#3362).

A provider handoff holds the exact native producer of a retired Goal
before returning a withdrawal receipt to Core. The worker records the
immutable Goal source, Core binding, runtime, runner, and worker process
in the version-one withdrawal journal. When Core rebinds after a worker
restart, the worker renews the native hold and records the new producer
before acknowledging the withdrawal. The portable export carries the
existing thread and Goal epoch to the destination.

The Rust worker handles Core's recovered-Goal notification through the
existing native producer and keeper admission. It uses the canonical
Goal source and provider-order epoch. It can acknowledge actual queued
admission while the provider is at capacity. A new worker uses the
keeper's ownership proof and Core's fence to reconcile an admission
left by the old worker.

Local macOS ARM64 validation used the Rust server with PGlite, the Rust
worker with an empty executable PATH, bundled Codex, and two loopback
providers. The smoke retired a genuinely queued Project Goal by restarting
the worker, dropped the source withdrawal before Core received it, and
restarted again. The new producer acknowledged the same source with a new
binding. The destination acknowledged admission while its slot was busy
and completed the original Goal on the same thread after the slot opened.
The queued Chat prompt cancellation regression also passed.

Live queued Goal and Task withdrawal, recovery of a first-cycle claim,
and retargeting an attached managed console remain open.

## 200. Transfer a live queued Project Goal between providers

Reference commit 76e7450525115cdfb2ad166e6432b96e9c633d0b (#3363).

A live autonomous attempt exposes its exact inference reservation to the
managed handoff coordinator. The keeper seals the unused reservation and
returns its durable no-start record. The worker confirms the hold on the
matching native root before journaling and sending the withdrawal to Core.
The attempt waits for Core's acknowledgement before returning control to
its Codex runner. Core persists the receipt using the same typed JSON
binding as recovered Goal retirement.

The local macOS ARM64 smoke used the Rust server with PGlite, the Rust
worker with an empty executable PATH, bundled Codex and loopback providers.
An unrelated Chat held each provider's only slot. The original Goal never
reached the source provider. Core acknowledged the exact withdrawal, and
the destination reserved the same thread and Goal epoch at the next
provider-order epoch. Releasing the destination slot let the Goal complete
through the native tool.
The recovered Goal restart and queued protected prompt cancellation
regressions passed on the same builds.

Queued Task Goals, recovery of a first-cycle claim, and retargeting an
attached managed console remain open.

## 201. Capture the exact Task Goal source for a provider handoff

Reference commit d4ca91be5d7e8c9d268dc89e41145c8e62990864 (#3364).

The Rust worker handles Core's existing `task.goal.source` command for a
waiting first Goal input and a queued private native Goal cycle. It captures
the keeper record and reads protected settings and Goal state on the selected
thread. A private cycle also requires Codex's acknowledgement of the exact
thread, turn, runner and gate attempt. The worker then checks that the keeper
still owns the same reservation. It reports the keeper generation separately
from the native settings generation. First-input captures carry the actual
queue revision and provider-order epoch.

The local macOS ARM64 fixture used the production Rust worker, bundled
Codex, a loopback provider, and controlled Core acknowledgements. It held
actual capacity across both Task source reads, opened each protected settings
snapshot with the TypeScript codec, and rejected a replaced route. Releasing
capacity let the original input and private cycles finish. The recovered
Project Goal handoff regression passed against the production Rust server
with PGlite on the same worker build.

Task Goal withdrawal and destination recovery still need to consume this
capture through the runtime handoff.

## 202. Withdraw queued Task Goal reservations during a provider handoff

Reference commit 9612b0f94dc1036ca209d3140090118a700e7023 (#3365).

Task handoff now uses the captured source to seal an unused first input or
private Goal cycle through its actual keeper. A live worker holds the
matching native Task root before sending the no-start proof to Core.
The first input and a withdrawn private gate wait for the canonical
acknowledgement. A deferred first input sends no Task failure outcome.
After confirmation the handoff releases the canonical command or waits
for Codex's negative acknowledgement of the private gate. Keeper records
remain available for Task FIFO recovery after the handoff journal settles.

The worker understands Core's Task handoff configuration and stages an
inference-only native root with the original Task placement and thread.
A transferred first input keeps its native producer parked until Core
redelivers the canonical input.

When a private cycle is withdrawn, the worker sends released keeper evidence
to Core's existing inference reconciliation endpoint. The admission manager
can then restore the approved queue position or retire it under Core authority.
Cancellation releases the confirmed source and wakes the original active
Goal on its retained epoch. The Goal ownership challenge still requires an
actual keeper read before the worker confirms Core's fence.

The local macOS ARM64 Task cycle fixture used the Rust worker, bundled Codex,
a capacity-constrained loopback provider, and controlled Core receipts. It
dropped the withdrawal response after confirming the no-start proof, then
cancelled the transfer. The worker recovered the acknowledgement, denied
the old native attempt, and resumed a fresh attempt at the retained
provider-order epoch without replaying the Goal setter.
The first-input fixture dropped the same acknowledgement while its
reservation was still waiting. The original command returned the existing
deferral code, with no provider request or Task outcome from that input.
The live and recovered Project Goal handoff tests and queued Chat
cancellation also passed against the production Rust server with PGlite.

Standalone Task destination cycle recovery and full Task provider cutover
validation remain open.

## 203. Resume an existing Task Goal on its selected provider

Reference commit de66f8ecf22a98a199f42fbdbc6d117dc35b18e5 (#3366).

The destination handoff installs a Task Goal publisher for the transferred
native thread under Core's selected route and provider-order epoch. It wakes
the same active Goal after the handoff finishes. An existing first input
still uses its canonical redelivery.

The Rust worker handles `task.goal.recover`. It confirms keeper ownership
and reopens or reuses the exact Task thread. It returns an actual durable
enqueue receipt while the private native attempt waits for capacity. An
ineligible response carries the observed Goal and settings epochs. A
reopened Task Goal obtains the original parent receipt and encrypted prompt
from Core at dispatch and publishes through the existing Task outcome and
checkpoint paths.

The local macOS ARM64 Task fixture ran the production worker and bundled
Codex against two loopback providers with controlled Core receipts. It read
the live keeper receipt while both providers were occupied, shut down the
worker, and reconciled the exact destination record on restart. The cold
receipt named the replacement admitted by Core on the original thread and
Goal epoch. Both cycles used the selected model, kept their result commit
barriers, and replayed the final encrypted outcome after another restart.
The previous-model compaction request excluded the original prompt.
The live Project Goal handoff regression passed against the production Rust
server with PGlite.

This fixture restarted after the first destination keeper record existed
and used controlled Core responses.

## 204. Preserve the destination Task Goal across a lost finish response

Reference commit e3a58e3812bfac045f5583b9964c21cba40888f6 (#3367).

After Core commits its destination binding, the worker wakes the retained
Goal and waits for its actual destination keeper enqueue before asking Core
to finish. The native scope stays unbound and inference stays closed until
Core acknowledges completion. The existing durable Task first-input
redelivery still owns transfers of that input.

The local macOS ARM64 fixture withheld Core's finish response, freed
destination capacity, and stopped the worker with SIGKILL after the keeper
granted the unbound reservation. No provider request was made. The fresh
worker recovered the exact recorded operation, obtained the canonical
replacement receipt, and ran the retained Goal on the destination.
The fixture verified encrypted outcome delivery and replay after restart.
The previous worker reached the same finish endpoint without a destination
reservation. The Project Goal handoff regression passed against the
production Rust server with PGlite. The Task fixture used controlled Core
responses.

## 205. Run the browser Task transfer against the production Rust services

Reference commit 5179e137f5bf068895b0740df12aa371d9a5817a (#3368).

Core and the worker share the Task retry classifier in
`cantrip-protocol`. The worker preserves the bounded failure category
from the native terminal error when redacting a Task response. Provider
error text stays private. The worker encrypts summaries for explicit Task
turns using the native turn identity, so terminal delivery updates the same
summary the client received at turn start.

The local macOS ARM64 browser fixture launched the production Rust server
in PGlite mode, the production Rust worker and bundled Codex. Loopback
providers supplied model responses. The browser transferred an unused
autonomous Goal cycle and received the destination result while the source
provider was still occupied. It reopened the same completed Goal and
encrypted transcript across restarts without repeating inference. The
fixture also verified manual retry after quota failure, completed
encrypted turn summaries, and retention of a paused admission across
server and worker restart. The native lost-finish regression from cycle
204 passed on the same worker build.

The existing browser fixture selects the native worker through
`CANTRIP_TEST_WORKER_BINARY`. Use it with
`CANTRIP_TEST_SERVER_BINARY` and `CANTRIP_CODEX_BIN`, then run
`node --import tsx scripts/server-rust/actual-folder-client.mjs --runtime rust --task-goal-autonomous-provider-transfer`.

## 206. Assemble and launch a standalone Rust worker package

Reference commit eba3e726e7f91bbe38eeb40cf52b51a480cd7025 (#3369).

On the target platform, run `pnpm package:worker --worker-runtime rust`.
The build stages `artifacts/cantrip-worker-rust-<platform>-<arch>` with the
native worker, Codex bundle, Cantrip CLI, CUA helper, example environment
and service launchers. Copy `.env.example` to `.env` and start the service
with `start.sh` or `start.cmd`. Build tooling uses Node. The staged service
starts directly in Rust and bundles no Node runtime or worker modules.

To reassemble local builds with `--prebuilt-worker-dir <directory>`, supply
`cantrip-worker`, `cantrip` and `cantrip-cua` (with `.exe` on Windows) and
a complete `codex/` bundle with its manifest. Assembly validates the copied
Codex artifacts and runs the packaged executables before publishing the tree.

The macOS ARM64 package was assembled from prebuilt local binaries and
relocated to a path with spaces and Unicode. The local standalone turn smoke
can start this package with `--worker <package>/start.sh --bundled` and a
production Rust `--server` binary. The worker runs with an empty `PATH`,
finds its bundled Codex, and completes a protected managed turn that exercises
the packaged CLI. The same launcher passed control integration against Rust
Core in PGlite mode, including enrollment, credential rotation, reconnect,
restart and SIGTERM shutdown. The packaged native MCP host passed the stdio
comparison against the Node reference. The launcher read the packaged `.env`
from another working directory and preserved supervisor variable precedence.
The standalone artifact is opt-in. Desktop, Docker and release worker selection
remain on the current production path.

## 207. Supervise native workers from the desktop package

Reference commit 8b9ffd67801255847eca7879c2746913911ba9f8 (#3370).

Select the native worker with `pnpm package:desktop-runtime --worker-runtime rust`
or `pnpm package:app --worker-runtime rust`. The `--from-artifacts` path stages
the standalone Rust worker binaries and resources without carrying over an
installation's `.env` or data. Both the embedded worker and packaged linked
workers use the same `desktop-worker.json` launcher configuration. The
supervisor owns the worker's stdin pipe and closes it to request shutdown.
Existing packages can still launch their Node worker without a worker manifest.

The desktop bundle can omit Node when the server's existing-profile converter
is native. Packaging continues to include the profile converter and its Node
runtime when the server artifact still uses the JavaScript upgrade path.

On macOS ARM64, a headless probe using the production desktop launch and
supervision code started both Rust services from the staged runtime in PGlite
and bundled PostgreSQL modes. The worker answered version requests and
retained its identity across desktop restarts. Normal shutdown returned zero
from both services. Killing the supervisor released both child processes and
the same profile reopened. The staged tree contained neither a Node executable
nor worker Node modules. The legacy database fixture also upgraded a stopped
PGlite profile and reopened it through the staged server launcher. The published
package defaults remain on the current worker runtime.

## 208. Keep the worker PTY fork separate from pinned Codex sources

Reference commit a81c057984ad6f1fdd3c8c0ce6918251b34a2dc7 (#3371).

The worker and native browser use `cantrip-pty` for PTYs, pipe transports,
and process ownership. The crate carries the existing worker adaptations to
Codex 0.166.0's PTY library. Its license and attribution ship with the native
worker bundle.

The Codex application source now matches its pinned manifest again. Building
Codex from a clean checkout can use the existing integrity check and patch
pipeline. The worker's terminal and child-process behavior continues to use its
own adaptations.

The server container build's Cargo workspace includes the shared interaction
crate. The workspace resolves with the revised PTY crate and requires no
Codex application source in the server build context.

On macOS ARM64, the PTY test suite and worker build passed. The packaged
worker retained its control connection, credentials and clean shutdown against
Rust Core. The revised server build context resolved Cargo dependencies.

## 209. Reopen a Node worker's enrollment in Rust

Reference commit 402266b314a7790b498bc4200f71d8be118c4e9e (#3372).

The local profile-upgrade fixture starts both production workers sequentially
against the same Rust Core. The Node worker enrolls, registers its endpoint
key and accepts two revisions of a scoped grant. After it stops, the Rust
worker starts from that data directory with no enrollment code or worker ID
supplied by the fixture. It answers a Core command and reopens the existing
grant. The fixture checks the exact persisted worker and principal identities,
credential, endpoint keypair and accepted grant revisions.

On macOS ARM64 the upgrade fixture passed in PGlite mode. Build the legacy
worker with `pnpm --filter @cantrip/worker... build`, then run
`node --import tsx scripts/worker-rust/profile-upgrade-smoke.mjs` with `--server`
and `--worker` pointing to the Rust executables. Use `--cli` and `--codex` to
select local helper binaries when they are outside the worker's normal layout.

## 210. Control retained Cantrip OS guest power from the Rust worker

Reference commit 71419fabe82784feef23ab30f18b226d1063f088 (#3373).

Power status and start, stop, and restart use the local Docker Engine socket.
The worker journals the accepted operation and the matching Docker identity
before dispatch. It sends each mutation to the immutable container ID. An
observation reads the recorded admission and the current container state.
Restart completion requires a changed start time. The worker preserves the
version-one operation and carrier journals used by the Node implementation.

The macOS ARM64 smoke started real Rust Core in PGlite mode and a native worker
against an existing Docker guest. It stopped and started the same container
and retained a workspace file. The fixture discarded the Engine's restart
acknowledgment after the mutation, then restarted the worker. Observation
settled the original admission without a second Docker POST. The Node host
reader reopened the Rust carrier journal. The fixture also checked the
JavaScript admission fingerprint.

Run `node scripts/worker-rust/cantrip-os-workspaces-smoke.mjs --power` with
`--server` and `--worker` pointing to the Rust executables and the existing
Cantrip OS guest image available locally.

## 211. Start and stop workspace desktops through the Rust worker

Reference commit f269064555770e4aa3f055ca41201ee2c91125c0 (#3374).

The worker observes, starts, restarts, and stops the desktop through the
captured guest workspace executor. It verifies the account and desktop
generation and retains the existing operation journal and guest admission
digest. Observation can read the exact guest receipt when the worker's
journal is missing or when its last write predates a receipt.

The macOS ARM64 fixture used production Rust Core with PGlite, the native
worker, and a disposable Docker guest with the current Cantrip OS workspace
package installed. It checked the guest's real desktop generations after
start, restart, and stop, verified that repeated submissions preserved those
generations, and recovered both an unsettled worker journal and a guest-only
receipt after restarting the worker.

Run `node scripts/worker-rust/cantrip-os-workspaces-smoke.mjs --desktop` with
`--server` and `--worker` pointing to the Rust executables. For a base image
with an older workspace package, pass the current package with
`--workspaces-package`.

## 212. Manage Cantrip OS packages through the Rust worker

Reference commit 5ddb4a9753d40cd8285dbdaf2fa831f717bdca50 (#3375).

The worker probes the pinned Docker container or verified SSH guest with
the existing Python rescue helper. It publishes a private, content-addressed
copy of each verified public package. The worker streams the retained file
to the guest and preserves the original admission across observation,
explicit continuation, and abandonment. Upgrade and repair use the guest's
existing installer claim. Terminal outcomes retain their original encrypted
receipt in the worker journal.

The macOS ARM64 fixture ran production Rust Core in PGlite mode and the
native worker against a disposable Docker guest. It installed the current
workspace package, repaired it after removing the guest helper and disabling
the executor, and checked the actual dpkg configure count. It left a second
admission staged, restarted the worker, and continued that same admission.
Abandonment ran no installer. The TypeScript client opened the protected
outcomes and the fixture checked the persisted admission and receipt digests.
The Docker carrier was exercised locally. SSH execution remains unverified.

Run `node scripts/worker-rust/cantrip-os-workspaces-smoke.mjs` with
`--server`, `--worker`, and `--package-artifact` pointing to the native
executables and the current Cantrip OS workspace Debian package. Build
`@cantrip/crypto` for the fixture's client-side grant and receipt checks.

## 213. Capture and reopen encrypted Cantrip OS workspace backups

Reference commit f5e03562769adc756a1a5620ace5c2d57edfc2 (#3376).

The Rust worker authenticates the private capture request, uses the existing
guest recovery helper, and streams the verified archive into the original
version-one encrypted file format. Publication requires the exporter exit
status and the expected byte count and digest. Observation authenticates
the complete on-disk archive, including its end frame, and recovers the
saved operation without another guest capture. The shared crypto crate
implements the existing backup frame and message authentication.

The macOS ARM64 fixture ran production Rust Core in PGlite mode and the
native worker against a disposable Docker guest with the current recovery,
workspace, and executor packages. It killed the worker after archive
publication, opened the multi-frame archive with the Node reader, and
confirmed that the restarted worker rejected a missing end frame. The
Rust worker then reopened the archive produced by the Node writer. The
client decrypted the outcome and only one guest capture was dispatched.
SSH execution and the remaining restore, rollback, and reset paths are open.

Run `node scripts/worker-rust/cantrip-os-workspaces-smoke.mjs --backup-capture`
with the native executables and the current guest packages. On an older
test base image provide `--executor-package`, `--workspaces-package`, and
`--recovery-package`. The interoperability fixture uses the existing
Node development dependencies and the built `@cantrip/crypto` package.

## 214. Restore, roll back, and reset guest workspaces in Rust

Reference commit ed2ae07dc38ca6e2b9f5aa0ea34f367e0edbc341 (#3377).

Restore authenticates the complete captured archive and its original
placement before publishing private transfer staging. The worker journals
the accepted digest before sending the archive. An uncertain transfer can
be observed through the guest journal. An explicit continuation can
activate the already received archive against the authorized placement.
Rollback and selected-path reset preserve the guest journal and retained
homes. Private paths, receipts, and errors use the existing encrypted
operation format.

The macOS ARM64 fixture ran Rust Core with PGlite and a native worker against
a disposable Docker guest. It checked that a truncated archive created no
transfer, dropped a successful upload's acknowledgment, and restarted the
worker. Observation and recovery left the original home in place. Explicit
continuation activated the archive once, retained the original inode, and
removed worker transfer staging. The same fixture verified rollback, reset
after a lost acknowledgment, and rollback of the reset. Capture and archive
interoperability were exercised on the same build. SSH execution remains
unverified at runtime.

Run the local workspace fixture with `--backup-restore`, the native
executables, and the guest packages listed in the capture fixture.

## 215. Discover owned Cantrip OS system images in Rust

Reference commit 71c654eedab9b2c810b7a1e2d92defbdd9a3650d (#3378).

The native worker discovers a running or stopped foundation container through
its exact local Docker Engine identity. It reads the bounded guest identity
archive without invoking the guest executor, follows symlinks inside the
container, and preserves the target generation for the same physical system.
An unreadable identity can retain a previously verified target. A readable
identity for a different owner, Worker, or guest cannot. Public inventory
omits images marked as private snapshots, replacements, or linked sources.
An existing completed replacement journal can authorize discovery of its
exact resulting container during explicit recovery.

The macOS ARM64 fixture ran production Rust Core with PGlite and a native
worker against a disposable Docker guest. It verified target generation
continuity across a symlink, an unreadable identity, and a stopped container.
It rejected a readable foreign owner and listed a public foundation image
while excluding a private checkpoint image. Run the local workspace fixture
with `--system-status`, the native executables, and built `@cantrip/crypto`.

System checkpoint capture, replacement, and rollback remain open.

## 216. Capture encrypted Cantrip OS system checkpoints in Rust

Reference commit 3e741930a297aa0b0caf3286908bc6bba2de463d (#3379).

The native worker journals the original system operation and its capture,
keeps the physical container pinned, and claims each Docker mutation before
sending it. Observation can recover an image by its complete admission label
set. Explicit continuation performs the remaining unclaimed steps, including
resuming the original guest when requested.

The worker streams the retained image into the version-one private system
archive through the local Docker Engine socket. It authenticates each frame,
the manifest digest, and the complete export before publishing. It can verify
a previously published archive with no new Docker export. Protected outcomes
use the existing client envelope and preserve the original capture provenance.

The macOS ARM64 fixture used production Rust Core with PGlite, a native
worker, and a small Docker guest with an independently mounted volume.
It dropped the commit acknowledgment, restarted the worker, and observed
the original image without a second commit. Explicit continuation resumed
the guest and verified an archive previously published by the TypeScript
writer. A second capture interrupted Docker export and verified that no
archive was published. Observation left it untouched. Continuation
reopened the same image, and the TypeScript reader authenticated the Rust
archive and decrypted the client outcome. The checkpoint receipt marked
the mounted volume excluded and the private images stayed out of the base list.

Run the workspace fixture with `--system-capture`, the native executables,
built JavaScript reference packages, and a local `alpine:3.23` image.
`--system-capture-image` selects another already available small Linux image
with the fixture commands.

System replacement and rollback remain open.

## 217. Replace and roll back retained Cantrip OS systems in Rust

Reference commit 82c03bb2a33d85bd9bb9d5cbedd1d93ba2567577 (#3380).

The native worker authenticates same-instance checkpoints through the original
encrypted archive before publishing private plaintext staging. A missing
checkpoint image is loaded through its authorized archive on a stable file
descriptor. Recovery can observe the exact imported image and the exact
candidate after an uncertain receipt.

The replacement retains the original container and its effective mounts,
applies new image defaults alongside explicit container configuration, and
pins each Docker transition with a durable claim. Rollback selects the
original replacement journal and restores the retained physical identity
after fencing the replacement. Core receives the original protected result
and root receipt for explicit recovery.

The macOS ARM64 fixture used the production Rust Core in PGlite mode and
the native worker against local Docker. It removed the captured image,
lost the real image-load reply, killed the worker, and observed the
original import without a second upload. Continuation restored the
checkpoint's root and kept the live volume and read-only host bind.
The fixture recovered the restored attachment and rolled back to the
original root and its current mounted data. It also replaced from a public
base with a lost create reply, verified the exact unattached candidate and
the new image default, and rolled back. Automatic enrollment of that
unattached base was outside the small guest fixture.

Run the local workspace fixture with `--system-replacement` and the
dependencies described for system capture. Earlier runs encountered an
intermittent graceful worker shutdown error before the replacement began.
The successful run used deliberate crashes for recovery and completed its
final orderly shutdown.

## 218. Join the worker command connection before closing preparations

Reference commit 6d91c9e4ab65ccd30b13965a77f593153163ad21 (#3381).

The command connection's reconnect callback retains the turn service, which
owns a reference to managed preparations. Worker shutdown now waits for the
connection task to release the callback before closing the preparation
service and its broker. This removes the race behind the intermittent
`Managed preparations are still active` shutdown failure.

The locally built macOS ARM64 worker passed the production Core control
fixture with an empty runtime PATH for stdin closure and SIGTERM. Both runs
verified same-process restart, credential rotation, and log archive drain.
The local Cantrip OS workspace fixture also passed across an orderly worker
restart and final shutdown.

## 219. Stream live worker diagnostics from Rust

Reference commit fa546c436007b02e4854b25f18764e080a8d2964 (#3382).

The native worker handles the existing start, renew, and stop commands
for leased diagnostics streams. It replays records from the shared log
buffer, sends ordered filtered batches, and advances the cursor across
filtered records. The worker bounds the pending batch by bytes and record
count, reports a truncated stream if records fall out, and retries delivery
while disconnected or backpressured. Leases belong to the current worker
runtime.

The local macOS ARM64 production Core and native worker fixture passed
with an empty worker PATH. Core's real WebSocket replayed a buffered log
record, delivered a new command record, and advanced a warning-only
stream past a filtered debug record. Closing both sockets sent two stop
commands. The same fixture also verified in-process worker restart and
clean shutdown. Run the control fixture with `--log-stream`.

## 220. Supervise installed CodeGraph indexes in the Rust worker

Reference commit 1eb40df5515ac49a0073fd6b846ed2bc753da84a (#3383).

The worker opens the existing managed CodeGraph distribution and runs its
actual CLI version and telemetry commands. An authorized Git worktree or
folder gets one index actor and filesystem watcher. The worker bounds
concurrent CLI operations, debounces file events, and periodically checks
indexes after watcher failures. It keeps the derived index in
`.codegraph-cantrip` and registers the Git exclude once per Git common
directory. The existing status, sync, and rebuild commands use the same
actors. Core receives heartbeat capabilities and project status observations.

Replica removal stops and joins the index actor before retiring the derived
index. The normal checkout deletion and ownership checks still decide the
result. A refused deletion resumes indexing when the checkout still exists.

The macOS ARM64 workspace fixture ran production Rust Core in PGlite mode,
the Rust worker, and CodeGraph 1.6.0. After reconnect, Core configured the
real worktree index. Its live socket delivered a file-change sync and
successful sync and rebuild jobs. Run `scripts/worker-rust/workspace-smoke.mjs`
with `--codegraph-distribution <unpacked-vendor-distribution>` and the linked
server and worker executables. The fixture excludes system Node from the
worker PATH. CodeGraph 1.6.0 uses the runtime supplied in its own distribution.

Adding `--replica-lifecycle-only` exercised real index retirement, a deletion
refused for an ignored user file, index recovery, and deletion after retrying
the same job. The ignored file survived the refusal with its contents intact.

The native installation and update path is covered in cycle 222.

## 221. Package an opt-in Rust worker image for hosted Compose

Hosted Compose forwards `CANTRIP_WORKER_RUNTIME=rust` to the worker build.
The final image launches the Rust worker directly under `tini`, includes
the bundled Codex and Cantrip native helpers, and keeps the worker's
existing data volume and enrollment variables. The build uses Node-based
packaging tooling. The Rust runtime image uses Debian with native runtime
libraries. The Compose default is still `node`.

The local Linux ARM64 image built from reference commit
`402266b314a7790b498bc4200f71d8be118c4e9e` (#3372) plus this container
change passed against production Rust Core in PGlite mode. The worker
enrolled and reopened on its persisted volume, reported its version, and
exited cleanly on SIGTERM. The fixture inspected the running executable,
non-root UID, read-only container filesystem, absence of Node and worker
JavaScript modules, and launch of the bundled binaries. Compose rendered
both worker selectors and the 15 deployment tests passed. Linux x64 image
execution and an image built from the latest worker remain to be exercised
at cutover.

## 222. Install and update CodeGraph from the Rust worker

Reference commit `f5e162432e447943d7ac1bd6d9f06be20edfbdf6` (#3385).

On startup the worker reopens the installed distribution from the existing
v1 pointer. It checks for a stable release in the background and accepts
`codegraph.update.check` through the existing command channel. The updater
uses the legacy update lock and ETag cache. It streams the two assets within
their published sizes and verifies their GitHub digests and the release
`SHA256SUMS` entry before extracting the archive into private staging.

The updater verifies the CLI version, disables telemetry, and initializes
the candidate MCP server before and after moving it into its version
directory. It then atomically updates the existing pointer. A failed update
keeps the verified installation active and reports degraded update
health. Running index operations keep their version until they finish.
The worker refreshes the authorized project indexes after activation.
The third-party distribution supplies its own runtime.

The local release fixture verified first install, ETag reuse, upgrades,
an in-use older version, restart from the v1 pointer, and rejected
asset digests, checksums, and MCP initialization. Rejected candidates
left the published pointer intact and released staging and the update
lock. The shared archive path validation test also passed.

On macOS ARM64, the production Rust worker downloaded and installed
CodeGraph 1.6.3 in a fresh disposable profile. Production Rust Core in
PGlite mode returned the existing update-check acknowledgment and reported
the installed version and telemetry state on heartbeat. The same run
passed native control reconnect, credential rotation, worker restart, and
shutdown. Use `scripts/worker-rust/control-smoke.mjs --codegraph-install`
with the linked server and worker executables to repeat the upstream test.
[CodeGraph 1.6.3 release](https://github.com/colbymchenry/codegraph/releases/tag/v1.6.3)

Managed MCP injection into agent sessions is covered in cycle 223.

## 223. Attach CodeGraph to managed Host Project Chats

Reference commit `e2e1ea96ea87cccc79cfe5e95cf844deeef7e405` (#3386).

Managed native preparation resolves CodeGraph against the admitted project,
worktree identity, and canonical working directory. It requests catch-up
against the authorized index and waits up to one second for that work.
Standalone chats, guest sessions, and structured tasks omit this managed
server. Native preparation continues filtering reserved names from the
user-configured MCP servers.

Codex launches `cantrip-worker codegraph-mcp <worker-data-dir> <project-root>`
with the managed index and telemetry settings. The launcher opens the current
version pointer on each launch and forwards MCP stdio directly to the
installed distribution. The launcher and index supervisor share a
per-project file lock for initial database creation and replica retirement.
This prevents a cold agent attachment from racing the first index writer.

The macOS ARM64 fixture used production Rust Core in PGlite mode, the Rust
worker, bundled Codex 0.166.0, and the installed upstream CodeGraph 1.6.3.
The loopback model discovered `codegraph_explore` through Codex, called it,
and received the indexed source from the managed Project Chat. A separate
Standalone Chat received no CodeGraph tool. Run
`scripts/worker-rust/standalone-turn-smoke.mjs --codegraph` with linked
server and worker executables and the Codex binary to repeat the test.

The existing replica lifecycle fixture also passed with an installed
CodeGraph 1.6.0 distribution and release downloads disabled. It verified
index retirement, preservation of an ignored user file, index recovery, and
successful deletion when the blocked job was retried.

## 224. Convert a local project folder to a GitHub repository

Reference commit `d79474aaff0a54556f2da64a8dba8b585aa802cf` (#3387).

The native worker handles the existing conversion preflight and execution
commands for managed folders and eligible external Git sources. It resolves the
worker-held routing handles, checks the GitHub repository identity, computes the
existing confirmation token and preserves the protected result shape. It links
existing history only when the local origin, branch and commit match. For an
empty remote it pushes the named branch and requires explicit approval before
creating an initial commit.

The worker records the confirmed operation before Git initialization and pins
the prepared commit before push. It recognizes the legacy marker and can
reconcile a retry against the live remote ref if the first push completed.
The server still owns conversion admission, retry and durable project updates.

On macOS ARM64, the local PGlite fixture used production Rust Core and the
production worker with an owned bare Git remote and a controlled GitHub CLI
fixture. It checked the legacy confirmation token, opaque metadata, the
approved initial commit and a real push. It then lost the push reply and
restarted the worker. The server requeued the job, the worker reconciled the
same remote commit, and the project gained Git capabilities without another
push or changes to a local edit. Run
`scripts/worker-rust/workspace-smoke.mjs --folder-conversion-only` with the
linked server and worker executables to repeat the fixture. The native
replica lifecycle smoke also passed.

## 225. Generate protected Git drafts through the Rust worker

Reference commit `9ffba6f8e9525914af753546ff8c2b57c060eb18` (#3388).

The native repository operation supports the existing working-change summary,
commit message, pull request description, range review, conflict explanation
and failed-check summary. It collects bounded evidence from the admitted
checkout or GitHub pull request and passes it as untrusted text to a read-only
Codex turn. The worker uses the existing inference admission, project
authorization, provider fallback and structured output contracts. The draft
stays encrypted in the worker response. Core receives the selected route,
turn identity and measured usage for its existing token accounting.

The local macOS ARM64 fixture used production Rust Core with PGlite, the
Rust worker, bundled Codex 0.166.0, and a loopback Responses provider. It
verified the protected result against staged evidence, rejected invalid input
before inference, fell back after invalid structured output, confirmed the
selected turn in Core's usage export, and preserved the checkout's original
HEAD and status. Run
`scripts/worker-rust/workspace-smoke.mjs --git-draft-only` with linked Core and
worker executables and the bundled Codex binary to repeat it. The existing
Node prompt and failure-evidence tests also passed.

## 226. Export project chats to the local Codex app in Rust

Reference commit `3f6a86411e87f7919f2687724b510971b4836b16` (#3389).

The worker now inspects the local Codex destination and handles the existing
begin, chunk and complete commands. It resolves the selected worktree's
protected path and validates upload order, byte count and transcript digest.
It opens chat messages and the display label with worker-held keys. The worker
imports the staged transcript with bundled Codex, preserves the chat title
and verifies the visible turns and thread discovery before recording success.
The v1 export receipt reopens across worker restarts and rejects operation IDs
reused with different transcripts or destinations.

The local macOS ARM64 fixture used production Rust Core in PGlite mode, the
Rust worker and bundled Codex 0.166.0 with an owned external home. It verified
an encrypted upload spanning multiple chunks, the saved native transcript,
unchanged Core messages, cleanup of temporary files, retry after restart and
rejection of a changed transcript under the same operation ID. It enables the
shared `externalCodexHistory` flag through the fixture worker's heartbeat.
The production flag covers both export and external-history import and can
be advertised once the native import path is available. Run
`scripts/worker-rust/workspace-smoke.mjs --project-export-only` with linked
Core and worker executables and the bundled Codex binary.

## 227. Import local Codex transcripts and attachments through the Rust worker

Reference commit `ec222c3129bac1c56e125ff7cded85fb5dad2061` (#3390).

The native worker discovers configured and default external Codex homes and
matches eligible transcripts to authorized project worktrees, replicas, or a
unique Git origin. The read command checks the match again and projects the
transcript into the existing history format. The worker advertises the shared
`externalCodexHistory` capability for macOS and Windows, enabling both import
and native project export.

The source stages eligible local media in the existing private layout and
uses the existing attachment IDs and encrypted relay format. The destination
uses the native attachment store for upload, integrity checks, subsequent
downloads and cleanup. Unsupported media remains visible as a placeholder.
Core retains ownership of the import job and commits the protected messages
and attachment references.

The macOS ARM64 fixture used production Rust Core with PGlite, the Rust
worker and bundled Codex 0.166.0. It exported a project chat, discovered it
through the public API, and imported its transcript and local PNG. It opened
the protected canonical messages and verified the original PNG bytes in the
destination store and through an encrypted download after worker restart.
The fixture also checked source staging cleanup and export receipt reuse.
Repeat it with `scripts/worker-rust/workspace-smoke.mjs --project-export-only`.
The 21 focused Node reference tests for history, attachments and export
passed. Windows runtime validation and destination hydration for native
continuation remain open.

## 228. Restore canonical chats into managed Codex sessions

Reference commit `586e4093a9f726b00937cc2ce1d16696b51b502e` (#3391).

The Rust worker accepts ordered relocation chunks in the existing private
layout, verifies the declared byte count and transcript digest, and opens
protected Chat or Task content inside the worker. Project export shares the
same transcript decoder and response-item projection. Hydration uses the
selected native provider, worktree configuration, permissions and skills, then
injects bounded batches and applies the requested collaboration mode. The
receipt records the allocated thread before injection and the verified thread
after completion. Retries can reopen legacy receipts and detect changed
transcripts. The worker reads the actual Codex thread before reusing a receipt
so it can rebuild a target that was discarded after a failed placement. New
receipts also bind the chat to the worker's current owner and server. The
worker advertises chat relocation, while Core owns placement and releases the
source thread after commit.

On macOS ARM64, the production Rust Core in PGlite mode, Rust worker and bundled
Codex 0.166.0 imported a protected transcript and continued the managed thread
after worker restart. The same chat then moved to another worktree on the same
worker. Core committed the placement and the worker acknowledged the old
thread's release. A loopback Responses provider received the original history
and the previous continuation, and Core committed the new protected answer.
Repeat with `scripts/worker-rust/workspace-smoke.mjs --project-export-only`.
The Rust journal test reopened the legacy format and rejected changed digest
and binding values. Seven focused Node reference tests passed. Cross-worker
relocation and Windows runtime execution were outside the local fixture.

## 229. Edit and resend the latest native chat turn

Reference commit `582d99c6fa0f5b07cf98253efd63a55575c7bfbb` (#3392).

The Rust worker handles Core's `chat.turn.rollback` command. It identifies the
exact native user item by its Cantrip message ID and reverts the history
before that turn. For a managed session it binds the accepted replacement
turn's preparation and admits revert as a separate native mutation. Core
remains responsible for replacing the protected canonical rows and dispatching
the new turn.

The bundled Codex releases the terminated session's checkpoint lock before
reporting shutdown complete. Revert can reopen the same thread and read its
actual suspension state while the app-server request still holds a reference
to the old session. The terminated session cannot reacquire the lock. The
worker selects a fresh managed runner for the reverted attachment, because
native shutdown closes the previous inference gate. The next preparation
binds the new gate to the same chat, placement and thread.

The macOS ARM64 fixture used production Rust Core in PGlite mode, the Rust
worker, patched bundled Codex 0.166.0 and a loopback Responses provider. The
public API rejected an older message, then edited and resent the latest turn
after worker restart. The provider received the retained conversation and
replacement prompt. The protected history omitted the superseded prompt and
answer. Replaying the edit returned the existing message. A subsequent turn
retained the replacement and its answer on the same native runtime. The
focused native durable suspension and Node rollback reference tests also
passed. Repeat the worker fixture with
`scripts/worker-rust/workspace-smoke.mjs --project-export-only`. Guest and
Windows execution were outside this local fixture.

## 230. Compact native Chat context from the public API

Reference commit `2d37a9adae5c98e73ebbc1294bac2ae9efc7d2a5` (#3393).

The Rust worker accepts `chat.compact` and forwards the existing
`thread/compact/start` RPC on the selected native thread. Managed compaction
shares the queued shell lifecycle for Core admission, provider capacity,
an early start acknowledgement, the observed native turn and terminal
settlement. It validates the current thread and workspace before dispatch.
An interrupted native turn closes the old inference gate. The worker
prepares a fresh runner for the next execution on that attachment.

The local macOS ARM64 fixture used Rust Core in PGlite mode, the Rust worker
and bundled Codex 0.166.0 with a loopback Responses provider. It held inference
open while the public endpoint acknowledged the start and rejected a concurrent
compaction. The next Chat turn received the saved summary after worker restart.
A second compaction was stopped, and a fresh compaction ran on the same runtime.
The native queued-shell regression and six focused Node reference tests passed.
Repeat the public API fixture with
`scripts/worker-rust/workspace-smoke.mjs --project-export-only`.
MCP-initiated compaction scheduled by an active agent remains a separate entry
point to port. Guest and Windows execution were outside this local fixture.

## 231. Schedule compaction from the active Chat MCP tool

Reference commit `916a5c282341539a450e3c51e8b3e4cf1d4f96ae` (#3394).

The native broker exposes `context_compact` for a writable Project Chat when
Core advertises the operation. Core authorizes each call against its active
execution lane and placement. The worker binds the request to the exact
native turn and coalesces repeat calls. When the turn finishes successfully,
Core's logical completion command releases the follow-up through the
same native compaction admission path as the public API. Context telemetry in
`context_get` comes from that thread and turn's actual Codex notifications.

On macOS ARM64, Rust Core in PGlite mode, the Rust worker and bundled Codex
0.166.0 exercised the actual MCP tool with a loopback Responses provider.
The agent read observed token usage and requested compaction twice in the
same turn. No compaction started while the final response was held. After
the turn committed, a single compaction ran and the next turn received its
summary. Repeat with `scripts/worker-rust/workspace-smoke.mjs --project-export-only`.
The focused protocol and Node reference tests passed. Guest and Windows
execution were outside the fixture.

## 232. Apply encrypted policies to native Chat turns

Reference commit `0113d2ccf6718461324cbe7b06a5fd091cb3b3c6` (#3395).

The Rust worker opens the encrypted policies that Core selected for the turn.
Project Chats send the effective summaries to Codex. Standalone Chats send
the full bodies for the enabled Chat audience. The worker uses the existing
row-bound decryption and enforces the 32 KiB UTF-8 budget before inference.
The policy text stays inside the worker and its native model requests.

The managed Project Chat MCP tools `policy_list` and `policy_read` use
the same decryption and schema validation as the CLI. Core resolves the live
project's effective list. The worker resolves a requested key against that
list, sends the opaque policy ID for the detail request, and verifies the
returned row and key before opening the body.

The macOS ARM64 fixture used Rust Core in PGlite mode, the Rust worker and
bundled Codex 0.166.0 against a loopback Responses provider. It verified that
a Project Chat received only its assigned policy summary, read its body
through the native MCP tool and rejected an unassigned policy. A Standalone
Chat received its audience's full policy body. The Host CLI regression
matched Node decryption and rejected a body encrypted for a different row.
Three focused Node policy tests passed. Repeat the Chat fixture with
`scripts/worker-rust/standalone-turn-smoke.mjs --policies`. Guest and Windows
execution were outside the fixture.

## 233. Apply explicitly mentioned skills on the Host

Reference commit `f19678c54d9279ed40700406830e762abe267d43` (#3396).

The Rust worker resolves skill mentions on the same Codex runtime and admitted
workspace that will execute the turn. It finds mentions inside protected Project
Chat input and direct Task briefs, and accepts Core's skill names for visible
Project input. Discovery uses the existing workspace and global skill roots.
Enabled, available skills become native input items in mention order. Protected
queue submissions with retained native input use their saved items. Relocation
shares the UTF-16 mention parser.

The macOS ARM64 fixture used Rust Core in PGlite mode, the Rust worker and
bundled Codex 0.166.0. A protected Project Chat sent the selected global skill
body once to a loopback Responses provider, skipped an unavailable skill, and
committed the protected reply. Five focused Node reference tests passed.
Repeat with `scripts/worker-rust/standalone-turn-smoke.mjs --host-skills`.
Standalone audience-based skills, guest skills and customization commands
remain open. The fixture covered protected Project Chat input on macOS.

## 234. Apply Standalone Chat skill audiences

Reference commit `f5c2e274972839129c4e6776142ec381677ef0b0` (#3397).

The Rust worker resolves Core's existing skill audience keys against the
provider account, worker user and configured Codex skill directories. It
builds private directory links for the accepted skills and registers them with
the admitted Standalone Chat runtime. Codex suppresses its automatic scan of
the worker user's own `.agents/skills` directory for this profile. Project
runtimes keep their existing discovery behavior. A selection is shared by
concurrent turns with the same admitted skills. Audience changes replace the
runtime roots after turns using the previous selection finish.

On macOS ARM64, the fixture used production Rust Core in PGlite mode, the
Rust worker and rebuilt Codex 0.166.0. It set audiences through the public
API and verified the skills in the loopback Responses requests after selecting,
replacing and clearing the allowed user skills. Every turn committed its
protected reply. The packaged Codex verification and the focused Node audience
reference passed. Repeat with
`scripts/worker-rust/standalone-turn-smoke.mjs --standalone-skills`.
Guest skill selection and settings commands remain separate work. The
runtime isolation was exercised with the patched macOS bundle.

## 235. Read encrypted skill settings and the Project Chat skill list

Reference commit `6940ee1e6a7edf951ca334165f913ff570f580dc` (#3398).

The Rust worker implements `skills.list`, `skills.settings.list` and
`skills.settings.read`. It preserves the existing skill IDs, audience keys,
display names, file sizes and location ordering. It merges Codex's enabled
state by canonical path when the provider has a native model route. Global
inventory also works before a provider has any model routes. Standalone Chat
audience selection shares the same discovery and key derivation.

The worker opens and seals customization payloads using the existing endpoint
encryption, binding each payload to its operation, worker, server and scope.
Inventory metadata, file contents and browsing errors travel in encrypted
responses. File reads only open regular files from the selected skill directory.

The macOS ARM64 fixture used production Rust Core in PGlite mode, the Rust
worker and bundled Codex 0.166.0. It listed global and Project skills,
compared Codex enablement, read a nested UTF-8 document, and rejected a
linked external file, binary content and ciphertext bound to another
operation. The worker shut down cleanly. Host and Standalone Chat skill
regressions and nine focused Node reference tests passed. Repeat the
settings fixture with `scripts/worker-rust/standalone-turn-smoke.mjs --skill-settings`.
Settings write, delete and configuration commands remain open.

## 236. Edit, recover and configure protected skills

Reference commit `210f2372997ca38608c0ba2225ac94bd9f4728f6` (#3399).

The Rust worker implements settings file writes, recoverable deletion and
enablement. Project Chat skill configuration uses the same native inventory
and Codex write call. Mutating requests reserve their existing customization
operation identity before opening ciphertext. The worker orders edits,
deletions and native configuration writes across its shared skill roots and
lets browsing read a complete state between mutations.

File updates preserve the selected file's permissions and publish a complete
replacement after validating `SKILL.md` where applicable. Deleting an editable
skill moves it to the worker's existing date-based `skill-recovery` layout.
Across volumes, the worker publishes the complete recovery copy before removing
the live directory name. Relative symlinks remain relative in the copied tree.
Linked skills and administrator-managed files retain their read-only editing
behavior.

On macOS ARM64, production Rust Core in PGlite mode, the Rust worker and
bundled Codex 0.166.0 passed the public API fixture. It exercised write and
read-back, rejected replay and invalid frontmatter, preserved file permissions,
disabled a skill across a worker restart, re-enabled it from Project Chat, and
reopened its recovery files after deletion. Repeat with
`scripts/worker-rust/standalone-turn-smoke.mjs --skill-settings`. The Rust unit
tests exercised the copy fallback with disposable directories on one volume.
Nine focused Node reference tests passed.

## 237. Inspect and update protected Project Chat customizations

Reference commit `647d59ac079069ec2e6944fcc8a03d6239fba254` (#3400).

The Rust worker reads the native skill and hook inventories and the paginated
MCP server inventory through the existing encrypted customization endpoint.
The worker redacts commands for untrusted hooks. Resource reads use the
owning Codex thread, preserve text and blob entries, and enforce the existing
size limit. MCP reload and skill-root changes use the customization replay
guard. Extra skill roots resolve inside the selected checkout and preserve the
worker's existing global root.

On macOS ARM64, the local fixture ran production Rust Core in PGlite mode,
the Rust worker and bundled Codex 0.166.0. Two Project Chats with the same MCP
server name returned their own resource content before and after reload.
The fixture exercised skill and hook discovery, rejected an extra root linked
outside the checkout, used a skill from a registered root in a native turn,
then cleared it while retaining the global skill. The skill settings
regression and 13 focused Node reference tests passed. Repeat the inventory
fixture with `scripts/worker-rust/standalone-turn-smoke.mjs --customization-inventory`.
MCP OAuth and external configuration import still require Rust handlers.

## 238. Authorize MCP servers from Project Chat

Reference commit `730d9100a6285596c7f4e7b34069731ce6d31403` (#3401).

The Rust worker starts an MCP sign-in against the selected Codex account
configuration and reports status through the existing encrypted endpoint.
Each Chat tracks its own attempt in the running app-server generation.
Native login IDs match completions to their attempts, including a completion
that arrives before the start reply. Older app servers without an ID finish
one attempt for a given server at a time. The start URL and provider errors
stay out of RPC diagnostics.

On macOS ARM64, production Rust Core in PGlite mode, the Rust worker and
bundled Codex 0.166.0 passed the public API fixture. The loopback provider
processed one approval and one denial for two chats with the same MCP server
name. Each chat returned its own status. The provider received the actual
token exchange, and MCP authenticated with the saved credential after reload.
The fixture also verified an encrypted failure for an unknown server. The
focused Rust correlation tests, protected skill-settings smoke and 13 Node
reference tests passed. Repeat the integration fixture with
`scripts/worker-rust/standalone-turn-smoke.mjs --customization-inventory`.
External configuration import remains open.

## 239. Preview and apply external project configuration imports

Reference commit `e06af56b9f0e529e814d98cbb932f9ff90a32b3f` (#3402).

The Rust worker implements preview, apply, and status through Project Chat's
existing encrypted API. Codex detects candidates for the selected checkout.
The worker preserves the Node candidate IDs and repeats detection before
submitting the requested items. Home-scoped candidates and plugin imports
follow the existing restrictions. The shared content contract rejects
duplicate selected IDs.

The worker binds the native import identifier to the protected Chat scope.
It retains progress and completion in the running Codex generation, including
completion received before the request task sees the receipt. Public results
carry counts and bounded failure classifications. Native paths, source
contents, and raw failure details stay out of RPC diagnostics.

On macOS ARM64, production Rust Core in PGlite mode, the Rust worker and
bundled Codex 0.166.0 imported a disposable project's `CLAUDE.md` into
`AGENTS.md`. The public API rejected a stale candidate and a candidate
from another checkout. The other project's status request returned unknown,
and neither the neighboring project nor the managed Codex home was changed.
The same fixture rechecked skill, hook, and MCP behavior. Repeat with
`scripts/worker-rust/standalone-turn-smoke.mjs --customization-inventory`.
Four focused Rust customization tests and 13 Node reference tests passed.

## 240. Run Project Automation schedules through both Rust services

Reference commit `97db2c95d821f03a11c1d8458ba1a33b109ce6bb` (#3403).

The Rust worker polls the existing authenticated schedule endpoint every ten
seconds and when the command connection becomes ready. Each dispatch sends
the Core-provided occurrence and revision using the current worker credential.
Core claims the occurrence, advances the schedule and admits the encrypted turn
under its existing idempotency key. Worker shutdown stops polling and reaps
its local condition subprocesses.

The worker opens the existing workflow-content name, prompt and condition with
their original record and field bindings. It runs script conditions in the
resolved checkout and uses the native GitHub client to query open-issue counts.
Allowed conditions use the standard protected Chat and queued-prompt envelopes.
Protected script content and subprocess output stay out of worker diagnostics.

On macOS ARM64, production Rust Core in PGlite mode, the Rust worker and
bundled Codex 0.166.0 exercised the real scheduler. A script queued its
protected prompt behind an active turn. Codex received the scheduled prompt
after that turn finished. An unconditional occurrence then started directly
in the idle chat. A worker restart retained the completed occurrence and
next scheduled time after the new scheduler polled Core. The fixture exercised
a nonzero script exit, a missing GitHub repository, an envelope from a different automation,
and disabled and future schedules. The copied envelope was rejected before
script execution. Six Node reference tests and the native customization
regression passed. Repeat with
`scripts/worker-rust/standalone-turn-smoke.mjs --project-automations`.
The GitHub-backed success path and Windows script execution need focused
runtime coverage. Ordinary Chat pause exposed a separate gap in the
`chat.pause.set` branch, which currently requires Task scope.

## 241. Pause and resume ordinary native Chats

Reference commit `201f92a93037aa74a4ea75f44e0a08b4057cf4f7` (#3404).

The Rust worker applies the Chat pause to the selected native admission
adapter and uses the existing durable checkpoint controls when a managed
turn is active. Replacement thread preparations inherit the local hold.
Core remains responsible for the durable pause, including after the worker
restarts. Private Task controls keep their existing scoped route.

On Resume, the prepared worker reconciles retained native queue input before
reading Core's queue. It starts the first eligible prompt using the existing
versioned queue-start operation ID and validates the protected start receipt.
A revision conflict leaves Core free to dispatch from its latest queue state.
When there is no eligible prompt, the worker can resume an active Goal through
the existing managed Goal mutation.

On macOS ARM64, production Rust Core in PGlite mode, the Rust worker and
bundled Codex 0.166.0 exercised the public Pause and Resume controls. A
scheduled occurrence queued its encrypted prompt while paused and retained
the same prompt through a worker restart. The loopback provider saw the
prompt after Resume, and Core completed the queue item. A separate fixture
paused an active turn at a checkpoint, restarted the worker and resumed the
same turn, which accepted one protected approval reply. Repeat with
`scripts/worker-rust/standalone-turn-smoke.mjs --project-automations` and
`--restored-interactions`. These fixtures did not exercise Windows or the
empty-queue active Goal branch.

The managed Codex CLI smoke and 40 focused Node reference cases passed.
The separate Node queue execution fixture, enabled with the bundled Codex,
timed out waiting for its first provider input. The GUI case reproduced
the same timeout on the reference commit.

## 242. Steer active native Chats from the public queue

Reference commit `3863b8114bce4381a110272d77f93d2c1fbe6df4` (#3405).

The worker handles the protected steer variant of `chat.native-control` and
the older `chat.steer` command. It selects the live turn and opens the user
message and any retained native input using the existing queue and attachment
formats. Managed steering records its own encrypted receipt with the exact
Core claim, activation, and native turn. The worker checks the selected turn
again when forwarding the RPC. Only a result identifying that turn is applied.

On macOS ARM64, production Rust Core with PGlite, the Rust worker, and
bundled Codex 0.166.0 processed two protected steers into one Project Chat
turn. The first used the ordinary queued message and the second carried a
retained native input. The real runtime forwarded both to the loopback
provider. Core consumed both queue items and history kept one copy of each
original protected message. The fixture also rejected requests missing the
queue revision. Repeat with
`scripts/worker-rust/standalone-turn-smoke.mjs --queued-steer`.

The restored-interaction regression and 65 focused Node reference cases
passed. The older unbound worker command was compile-checked. Terminal-originated
steering through the managed gateway and Windows runtime coverage remain open.

## 243. Steer active native Chats from the managed console

Reference commit `4fe05af70861f9631b1d81862110e45a99efa07e` (#3406).

The console gateway accepts `turn/steer` from a view attached to its exact
thread. The worker checks the active turn, activation, placement and runtime
before requesting a terminal-origin receipt from Core. It shares the
app's steering dispatch and settlement, forwards the existing native input
format, and returns the native reply to the console. An already forwarded
request retains its settlement work if the console connection closes.

On macOS ARM64, production Rust Core with PGlite, the Rust worker and
bundled Codex 0.166.0 started and steered a turn through the managed
console gateway. Requests for a stale turn, another thread, and an
approval policy override were rejected before reaching the model. The
valid request returned the original turn ID. The loopback provider
received the steering prompt and public history showed exactly one
encrypted entry for each of the initial input, steer and answer. Repeat
with `scripts/worker-rust/standalone-turn-smoke.mjs --console-steer`.

The public queued-steering and console approval regressions and 61 Node
reference cases passed. The gateway fixture used WebSocket RPC on a
real attached console session. Windows runtime was outside this check.

## 244. Apply account effects to the native desktop helper

Reference commit `db495f38dcc8d3965dfb1f134b95aaae973bfea7` (#3407).

The Rust worker accepts the account effect preferences in authenticated
heartbeat responses and handles `computer-use.effects.sync` on the command
connection. Both paths retain the newest revision. The existing desktop
helper applies that revision over its private pipe, including after helper
replacement. Settings queries keep an idle helper stopped. A native
rendering rejection leaves the current helper available for capture and
input and reports the failure through the existing status schema.

On macOS ARM64, the production Rust worker received the heartbeat and
command updates through an authenticated fixture and ran the real native
helper with its deterministic backend. The fixture checked idle status,
stale revisions, a running native status, unsupported effect recovery,
continued desktop capture and input, reapplication after reconnect, and
helper shutdown. Repeat with
`scripts/worker-rust/desktop-inventory-smoke.mjs`. The five Node effect
controller cases and the persisted settings revision test passed. Live
window rendering and the agent and preview computer-use paths still need
coverage and implementation as applicable.

## 245. Open protected Host computer-use previews from Rust

Reference commit `992a322b1d6c9b5369f05bc6804129c41699feed` (#3408).

The worker allocates one preview lease per chat using Core's owner, worker,
placement, generation, and permission state. A repeated open with the same
authority returns the same lease. Stop, authority changes, chat interruption
and command connection replacement revoke the lease and release its native
session. The helper uses the existing private pipe and ordered event frames.

The authorized Host path exposes capability discovery, target inventory,
session attach, detach and close, logical cursor controls, control inspection,
and PNG snapshots. The worker validates encrypted actions against the shared
protocol shapes. Results and bounded image chunks use the existing
client-control-content format and bind to the specific preview lease.

On macOS ARM64, the public API fixture used production Rust Core with
PGlite, the Rust worker, and the native helper's deterministic backend.
It listed targets, attached, authenticated and decrypted a PNG, detached,
reattached, closed, and reopened. It rejected a foreign session, denied
carrying ciphertext across leases, and invalidated a lease after a chat
permission change. Stop also revoked a preview that still held a session.
Repeat with `scripts/worker-rust/standalone-turn-smoke.mjs --cua-preview`
and the built native helper. The desktop inventory regression and 53
focused Node reference cases passed.

Host target access requires the existing exact `:yolo` selection in this
cycle. Durable approval publication and response, activity publication,
native input, guest previews and agent computer use remain open. The
fixture used deterministic targets and pixels.

## 246. Resolve protected Host preview approvals from Rust

Reference commit `f1fe5317f04c3f6118d484c5de3540db76a9a338` (#3409).

Host previews under ordinary permission profiles now publish encrypted
permission requests through Core's durable interaction API. The worker binds
each request and its grant to the live preview lease, permission class, and
target generation. A turn answer permits one retry. A session answer applies
for the life of the lease. Duplicate pending requests reuse the same protected
content and request key. Matching accepted replies are idempotent. Stop,
authority changes, and command disconnect retire the lease's grants and
pending requests. Unanswered requests expire after five minutes.

On macOS ARM64, production Rust Core with PGlite, the Rust worker, and the
native helper's deterministic backend exercised the public preview and
interaction routes. The TypeScript client codec decrypted the permission
request. Core rejected answers protected for the wrong request key and
answers with a different permission class or target generation. The fixture
approved one retry, verified a session grant across repeated calls, denied a
snapshot, and then approved and decrypted a PNG on the next request. Stop
persisted an interrupted request and the replacement lease required a new
grant. Repeat with `scripts/worker-rust/standalone-turn-smoke.mjs --cua-preview`.
The 154 focused Node reference tests passed. The fixture did not wait for
the five-minute expiration or exercise real desktop pixels. Computer-use
activity publication, native input, guest previews, and agent computer use
remain open.

## 247. Record protected Host preview activity from Rust

Reference commit `cfd541177e3f019e9297642f07b31e251d537a8f` (#3410).

The worker publishes one terminal Trajectory activity per authorized Host
preview command. It uses the existing Chat or Task message protection and
preserves the user-preview actor, operation correlation, timing, outcome,
and applicable session, target, cursor, and image metadata. It clears the
capture bytes before publishing activity. Stop revokes the lease first and
reports an audit delivery failure separately. Repeated Stop on the closed
lease creates no additional record.

On macOS ARM64, the public preview fixture used production Rust Core in
PGlite mode and the Rust worker with the native helper's deterministic
backend. The TypeScript client codec opened durable Chat history for a
snapshot, a foreign-session rejection, an approval-required response,
detach, close, and Stop. It opened separate Task history for capability
discovery and Stop and verified the Task binding. The native desktop
inventory regression and 148 focused reference and protocol tests passed.
Repeat with `scripts/worker-rust/standalone-turn-smoke.mjs --cua-preview`.
The fixture covered deterministic targets and pixels. Native input, guest
previews, and agent computer use remain open.

## 248. Route protected Host preview input through the native helper

Reference commit `c80fa560d2e1c5f0a41f37dcd212a47b37b767ed` (#3411).

Host previews now route control presses, clicks, input commands, clipboard
operations, and desktop resize over the existing private helper pipe. The
worker uses the target-bound native-input grant. The shared contract validates
UTF-8 limits, keyboard normalization and balanced timelines before sending a
command. The worker checks the input receipt against the requested delivery
method and position before returning it and records the receipt in protected
activity. Backend capability reporting and unsupported results come from the
helper.

Planned input may run beyond the ordinary native request deadline. Stop
cancels the owned request, drains the native cancellation response, and fences
late session data. An ambiguous mutation result is never automatically
replayed. Long operations still serialize the shared desktop helper request
queue, so overlapping capture and native input need further work.

Local macOS ARM64 checks exercised separate native-input approval, rejection
after a target generation change, all six native operation routes, and the
protected unsupported-input activity against the real helper in deterministic
fake mode. Two Rust tests covered receipt checks and timeline normalization.
The native desktop inventory smoke and 60 Node reference cases passed.
Repeat the integrated check with
`scripts/worker-rust/standalone-turn-smoke.mjs --cua-preview`.
The fixture did not dispatch input to a live desktop or exercise guest
clipboard and resize. Guest previews and agent computer use remain open.

## 249. Route Rust previews to their assigned Cantrip OS desktop

Reference commit `7c59cf72238cf5b9966c16abf60eacdf713cb676` (#3412).

The worker checks preview authority against the Chat's captured OS execution
record and opens the existing root-owned guest carrier. It verifies the
guest instance, attachment, workspace account, desktop generation, and
remote manager identity. Concurrent Chat leases for the same workspace share
one carrier and own separate native sessions. Stop releases its session,
the final owner closes the exact carrier, and command socket replacement
revokes earlier leases. Guest and Host operations have separate execution
queues.

A local macOS ARM64 worker exercised a real Linux guest over Docker using
the existing `cantrip-os-local-qa:2938-rekeyed` image. The fixture used an
authenticated command socket and supplied captured placement records. It
rejected a stale generation and a Host command for a captured guest Chat,
opened two sessions on the guest carrier, decrypted a PNG, confirmed a
coordinate click, read back clipboard text, and resized the display to
800×600. Closing one lease preserved the other, closing both retired the
carrier, and a reconnect cleaned up another live guest lease.

Repeat with `scripts/worker-rust/desktop-inventory-smoke.mjs --guest-image`
and an existing image with the current remote carrier. The Host preview
smoke against production Rust Core and 12 Node reference tests also passed.
SSH guest execution and the guest public API from Chat creation through
placement capture still need integrated coverage. Agent computer use
remains open.

## 250. Add the native computer-use MCP stdio helper

Reference commit `ed182bc364bdb69fe5fccc58c6108cd3a655607a` (#3413).

`cantrip-worker cua-mcp --connection <path>` uses the existing authenticated
loopback broker document. The executable advertises the established `js` and
`js_reset` tools from the reference catalog and forwards exact Codex turn
metadata to `/v1/computer-use`. It preserves cancellation, the CUA script and
image limits, and the untimed broker operation. A canceled tool call releases
its broker request while the same attachment remains usable.

On macOS ARM64, the native subprocess ran with an empty PATH. The existing
Node broker delivered a 600,000-byte image block, and the fixture verified
metadata validation, reset, and cancellation through real stdio. The Node
reference suite passed 14 cases, and the ordinary native MCP smoke passed
31 comparisons. Re-run the CUA cases by setting
`CANTRIP_TEST_RUST_CUA_MCP_BIN` to the native worker executable and running
`test/cua-mcp-transport.test.ts` from the worker package.

This milestone covers the helper and its broker compatibility. Managed
Codex configuration, Rust broker execution, and authenticated CUA MCP HTTP
remain open.

## 251. Authenticate computer-use MCP calls in the Rust broker

Reference commit `3108b05e779e92cc4ace80d5c81b8a1f24b91964` (#3414).

The Rust loopback broker serves the existing stdio relay and the Linux
streamable HTTP computer-use MCP endpoint. A prepared binding advertises
computer use only when enabled. An active lane registers its native runtime,
which must recognize the requested thread and turn. Each admitted request
fetches current Core authority with the worker credential and verifies the
worker, account, Chat, placement, lane, generation and permission profile.
Lost authority revokes the registration. Disconnect cancels the request, and
retiring the lane cancels both in-flight calls and retained observations.

The local macOS ARM64 broker fixture uses a test Core endpoint and registered
test runtime. It exercises both transports, foreign-turn and invalid-credential
rejection, a 600,000-byte image, cancellation, and authority changes. Ordinary
MCP attachment expiry and placement tests and 14 Node reference cases passed.
Run the Rust tests with `scripts/worker-rust/cargo.mjs test --lib mcp::bindings::`.
The native evaluator and managed Codex registration remain open.

## 252. Run worker evaluations through the native computer-use helper

Reference commit `712e1d68c2c6768f792810a42c2542bbdb4f72ef` (#3415).

The worker runs QuickJS in a dedicated helper for the authorized turn. It
uses the existing private helper framing to correlate evaluation responses
and ordered host calls. Host callbacks remain in the worker, where the
turn owner supplies authorization and dispatch. The helper may complete
with an error while a callback is waiting. Cancellation retires an
interrupted pipe, and the worker never replays an interrupted action.
Successful evaluations can reuse the same JavaScript state. Reset and turn
retirement clear that state and close the owned helper.

The focused evaluator test runs the real `cantrip-cua` process on macOS ARM64
with its deterministic backend and a fixture host callback. It exercises
ordered callbacks, state and reset, policy error codes, request cancellation,
the native script deadline and idle process retirement. Set
`CANTRIP_TEST_RUST_CUA_BIN` to the helper and run
`scripts/worker-rust/cargo.mjs test --lib worker_evaluator -- --ignored`.
The production worker build, deterministic desktop-inventory smoke and 58
Node reference lifecycle and transport cases passed locally.
The registered production broker still needs the authorized desktop/guest
host-action implementation, retained observation handling and managed
Codex turn registration.

## 253. Dispatch authorized JavaScript actions to the Host desktop

Reference commit `64a53ed3b71dd752f9849f52492642e066d22cab` (#3416).

An observed native turn can bind its evaluator to the Host desktop in the
captured Core authority. The worker translates script actions into the
existing native desktop requests and asks the execution owner to authorize
each action and attached target. It rechecks the turn and command socket
after the callback and keeps native dispatch on the preview service's owned
helper. Attachments carry the actual native thread and turn. Reset,
cancellation, and turn retirement release the exact attachment.

The Host path supports target paging, attachment and cursor state, snapshots,
controls, clipboard, resize and native input through the existing helper
operations and platform capabilities. Inventory pages, input receipts, and
snapshot dimensions and digests are checked before the worker accepts the
result. Screenshots stay in a bounded worker buffer while the evaluator
receives metadata and image indices.

On macOS ARM64 the Rust test used real evaluator and desktop helper processes
with the deterministic backend and a fixture policy callback. It exercised
attachment denial, target paging, snapshot metadata and bytes, per-action
policy calls, approval cancellation, reset and turn retirement. The 68 Node
reference cases used the same helper. Repeat the Rust test by setting
`CANTRIP_TEST_RUST_CUA_BIN` and running
`scripts/worker-rust/cargo.mjs test --lib host_actions_use -- --ignored`.
The desktop inventory smoke and the public preview smoke using Rust Core in
PGlite mode passed with the new worker and the deterministic helper.
Managed Codex registration, durable approval and activity routing,
retained observations and the agent guest carrier remain open.

## 254. Route agent computer use to the assigned Cantrip OS desktop

Reference commit `4681470972512b620f3e2e46609255be9ad1e4e0` (#3417).

The evaluator binds the observed turn to the worker's captured Host or guest
placement. Each host action rechecks the captured record and worker authority
around its policy callback. An assigned guest uses the same root-owned carrier
as previews. Separate turns and previews retain independent native sessions
while sharing their assigned workspace's carrier.

The carrier owns accepted requests through their response or cancellation.
Dropping the caller releases its response without dropping a partially read
frame. The final owner, connection change, and worker shutdown retire the
exact carrier. If the helper exits, a subsequent authorized open can acquire
a fresh carrier without replaying the interrupted operation.

The local Rust guest test uses a disposable network-isolated Linux container
from an existing image on macOS ARM64. It checks stale-placement rejection,
distinct native sessions on one carrier, guest clipboard and PNG capture,
reset isolation and shutdown cleanup. The Host regression and 12 Node
reference cases also passed. Set `CANTRIP_TEST_CUA_GUEST_IMAGE` and
`CANTRIP_TEST_RUST_CUA_BIN` and run the `desktop_inventory::preview::agent::tests`
library tests with `--ignored --test-threads=1`.
The production worker build passed the desktop inventory and guest preview
smoke tests, including carrier retirement after socket replacement.
Managed Codex registration, durable approvals and activity, retained
observations, and finalization remain open.

## 255. Resume agent computer-use actions after protected approval

Reference commit `9e01c5dda9b98f4733230a172c12c429a34ccf13` (#3418).

The desktop turn can publish the existing encrypted permission request on
its owning command stream and suspend the current host action. The Worker
validates the answer against the active Core authority, command socket,
native turn and exact requested class and target. A successful reply resumes
that action and can grant the same permission for the rest of the native
turn. An encrypted reply cannot authorize a different target or permission
class. Duplicate delivery of the same answer is accepted while that turn
owns the request.

Expired or cancelled waits emit a terminal event after the original request
on the same stream. Chat and policy revocation discard affected turn grants
and abort any pending work. The agent and preview paths use the same
permission classes and interaction encryption, with the preview's existing
retry semantics preserved.

The Rust fixture exercises the encrypted request and worker response route
with a fixture command publisher. It verifies exact lane and target checks,
grant reuse, duplicate delivery, cancellation, and refusal of late answers.
The 58 Node approval and publication reference cases passed locally. Run
`scripts/worker-rust/cargo.mjs test --lib protected_agent_approval`.
The worker build, native Host test and public preview roundtrip against
Rust Core in PGlite mode also passed on macOS ARM64.
Managed Codex registration still needs to supply the command publisher and
refresh Core authority around the approval wait. Activity and turn
finalization remain open.

## 256. Run managed Chat computer use through the Rust worker

Reference commit `c18cc8d4fd424401db37e898775f0a8b237d2f15` (#3419).

For ordinary managed Chat turns with captured computer-use authority, the
worker installs the reserved `cantrip_cua` MCP server. Host uses the native
stdio helper with a private connection document. Cantrip OS uses the
authenticated HTTP broker. The observed root thread and turn own the
evaluator and desktop session. The worker refreshes Core authority before
and after approval waits, and sends protected permission events on the
owning command socket. Turn completion or observation loss retires the
session. The model gets PNG bytes and separate native capture and model
rendition metadata. Oversized captures are resized within the existing
model byte and pixel limits.

On macOS ARM64, `scripts/worker-rust/standalone-turn-smoke.mjs --cua-agent`
ran bundled Codex, the production Rust worker and Rust Core in PGlite mode
with the deterministic Host desktop helper and a local vision-capable provider.
The fixture checked Codex MCP confirmation, three Core-committed protected
permissions, a screenshot delivered to the model with its matching SHA-256,
`js_reset`, and the encrypted assistant result. The Host preview smoke,
managed thread preparation and restart smoke, 12 Node MCP reference tests,
and the Rust oversized capture test also passed locally.

Managed guest execution still needs an integrated turn fixture. Protected
agent activity and retained observations, turn finalization and recovery,
and the remaining execution sources still need coverage and implementation.

## 257. Record protected agent computer-use activity in Rust

Reference commit `89fc4e140ed65babef42b66b757ee815f394c80d` (#3420).

Ordinary managed Chat turns publish a protected computer-use activity for
each validated host action and for JavaScript evaluation and reset. The
records carry the observed root thread and turn, the tool item and operation
identities, the target, and any native input receipt or capture metadata.
Scripts, clipboard contents, native inventory, and image bytes stay outside
the activity payload. The worker preserves the distinction between a
declined action, a failed operation, and a cancelled action with uncertain
delivery. The activity travels on the owning command socket. Turn settlement
waits for admitted calls to publish their terminal records.

The local macOS ARM64 managed computer-use smoke verified the encrypted
Chat history from production Rust Core. A single bundled Codex turn produced
inventory, attachment, capture, declined clipboard authorization, JavaScript
completion, and reset records in order. The fixture checked actor and
request identities, the capture checksum, and the encrypted payload boundary.
The native Host helper regression exercised cancellation during approval.
The protected approval test, Host preview smoke, and 22 Node agent reference
cases also passed.

Retained agent observations for the preview, recovery, managed guest turn
validation, and support in the remaining execution sources are open.

## 258. Serve retained agent screenshots through the protected preview

Reference commit `8bcc7041b9b9374b2fe149685d8c56055d1d63c3` (#3421).

The Rust worker serves `agent.sources.list` and `agent.observation.get`
over the existing preview lease and encrypted chunk transport. It retains
the latest model PNG for an observed turn with the original native session
and image metadata. Reads use the captured PNG and the current worker,
Chat, placement and permission generation. The worker bounds retained
sources and concurrent readers at four each. Starting another call, including
reset, invalidates the prior source and any reads still encrypting it.
Turn completion, helper retirement, and authority or connection loss also
clear retained sources.

Local managed Host coverage uses bundled Codex, a deterministic desktop
helper, and Rust Core in PGlite mode on macOS ARM64. The preview retrieves
the most recent of two captures with the exact bytes delivered to the
model. A second Chat cannot list or read the source. Reset and turn
completion invalidate the source. The native helper test also checks an
invalidated read and a late result against the reader limit and call token.
The ordinary Host preview smoke and 18 Node observation reference tests
also passed locally. The Rust contract comparison matched the TypeScript
fixtures for valid and invalid observation metadata.
Managed guest turn validation, recovery, and the remaining execution
sources are open.

## 259. Run managed console computer use through the Rust worker

Reference commit `e3a1a022811a575cb55d380712871d68f5541818` (#3422).

When Core admits a console turn with computer-use authority, the worker
binds the existing managed MCP attachment to that native thread and turn.
Approvals and encrypted trajectory activity use the console command's
durable event route. The worker drains those events before settlement and
cancels the computer-use session if Core rejects event delivery. Closing a
console connection after dispatch leaves the accepted execution with its
existing owner.

The macOS ARM64 `standalone-turn-smoke.mjs --cua-console` fixture uses the
managed console gateway, bundled Codex, production Rust Core in PGlite mode,
and the deterministic Host helper. It closes the console client after
turn acceptance, then verifies protected allow and decline decisions,
encrypted activity and assistant history, matching model and preview PNGs,
and observation expiry on reset and completion. The ordinary managed Chat
computer-use and console steering smokes also passed locally.

Managed Cantrip OS computer-use validation, recovered turns, autonomous
turns, child agents, and Task execution remain open.

## 260. Restore computer use on a saved Chat turn

Reference commit `fa522efb73cbb0d80cf316cc3a73752484e9d4ab` (#3423).

The replacement worker accepts Core's fresh computer-use grant after it
verifies the saved checkpoint and execution owner. It binds the reserved MCP
tool to the confirmed native thread and turn on the Resume command's socket.
The resumed turn starts with a fresh computer-use session and publishes
protected approvals and activity through its durable receipt. Completion
retires the session and its retained observations, then drains publication
before settling the execution.

The local macOS ARM64 `standalone-turn-smoke.mjs --cua-recovered` fixture
paused a managed Host Chat, restarted the production Rust worker and resumed
through Rust Core in PGlite mode with bundled Codex. The fixture verified that
protected permissions and activity kept the original native thread and turn,
the prompt appeared once, the preview returned the model's screenshot, and
reset and completion expired retained observations. The saved command
approval and managed console computer-use smokes also passed locally.
Managed guest turn validation, autonomous and Task execution, and child-agent
computer use remain open.

## 261. Run computer use on autonomous Project Goal turns

Reference commit `824e444c9c20c22809ae0a900fb174493eb33390` (#3424).

The worker binds Core's computer-use grant and native interaction handler to
the autonomous attempt before releasing its producer. The observed native turn
owns the MCP session. Approval requests and encrypted activity go through the
existing durable command receipt. The worker revokes the session and clears
retained previews when the turn ends, then drains publication before final
settlement.

When a console rejoins a live managed thread, the bundled Codex app-server
finishes sending its resume response and replay before waking the Goal in a
separate task. The native event loop can deliver the admitted turn's events
while a wake is waiting for authority. A Goal wake that has queued behind
the Goal state lock checks the native turn slot before requesting its own
admission. A running turn can finish its Goal accounting without waiting on
a second producer.

The macOS ARM64 `standalone-turn-smoke.mjs --cua-autonomous` fixture held
Goal admission until the real managed terminal rejoined. The patched Codex
executable, production Rust worker, and Rust Core in PGlite mode completed
the original native turn. The fixture verified protected allow and decline
decisions, encrypted activity and assistant history, matching model and
preview PNGs, observation expiry on reset and completion, and the completed
Goal state. The queued Goal provider handoff and managed console computer-use
smokes passed using the same executable. The local test executable used the
pinned Rust compiler and the installed LLVM 23 LTO library for linking.

## 262. Run computer use on a managed child turn

Reference commit `0b7b72f49289ac7aededd3771f939e513228f88d` (#3425).

The worker checks the observed native thread ancestry and exact active child
and root turns before admitting child computer-use calls. Each actor owns
its evaluator, desktop session, call slot, and retained observation. The
root command still owns Core authority, protected activity publication,
and final settlement. Activity and preview bindings carry the child turn's
identity and canonical agent scope. Child completion cancels its own session
and expires its observation while the parent can continue running.

On macOS ARM64, `standalone-turn-smoke.mjs --cua-child` used the production
Rust worker, bundled Codex, Rust Core in PGlite mode, and the deterministic
Host desktop helper. The fixture verified protected child approvals,
encrypted History attribution, matching model and preview PNGs, and preview
expiry while the parent remained active. Managed child command approval,
root Chat and autonomous Goal computer-use smokes also passed locally. A
worker unit test checks exact observed ancestry, duplicate start events,
and cancellation at child completion.

## 263. Run computer use during direct Task execution

Reference commit `c6e9a154a4f83b91d72ecacba1e0bce6b3fe6deb` (#3426).

Direct Task turns bind Core's computer-use authority to the existing physical
Task input and native turn. The Task command carries protected Codex tool
confirmation and desktop permissions. The worker seals activity with the
Task content key and records the Task, worker and native actor identities.
Retained observations use the existing preview lease and expire on reset or
turn completion. Structured Task planning and finalization continue using
the read-only native configuration when computer use is enabled.

The `standalone-turn-smoke.mjs --cua-task` fixture uses production Rust Core
in PGlite mode, the production Rust worker, bundled Codex and the deterministic
Host desktop helper on macOS ARM64. It checks protected tool confirmation,
allow and decline decisions, matching model and preview PNGs, encrypted
Task History, and observation expiry. The direct Task reached completion,
and its read-only planning counterpart reached review without advertising
computer-use tools. Managed Chat, child agent, and preview smokes also passed.

Task Goal activation, autonomous cycles and recovered Task computer use still
need integration and validation.

## 264. Activate a Task Goal with computer use enabled

Reference commit `bdd9988fec87ed3ff6d17fadfcf21030648e39b2` (#3427).

Task Goal activation prepares the retained implementation thread with Core's
computer-use setting. The existing first-input reservation holds the native
producer until the canonical Task command runs. That command uses its own
execution-lane authority to enable the prepared MCP attachment. Planning and
finalization remain read-only.

On macOS ARM64, `standalone-turn-smoke.mjs --cua-task-goal` ran the public
Task plan and implementation endpoints against production Rust Core in
PGlite mode, the production Rust worker, bundled Codex, and the deterministic
Host desktop helper. Planning and finalization exposed no computer-use tools.
The first implementation turn obtained protected approvals, captured and
read back matching PNGs, published encrypted Task History, retired the
preview, and completed the Goal. The direct Task smoke also passed locally.

Saved Task reattachment still needs computer-use integration.

## 265. Restore computer use on a saved Task turn

Reference commit `ed7e91205ccf08a936dd0a74fe99fe778e067732` (#3428).

The worker attaches computer use to the saved native thread and turn after
checking the held checkpoint and the fresh Task input receipt. The resumed
command owns the MCP attachment, protected native tool confirmation, and
desktop permission events. Activity is sealed with the Task content key.
Cancellation and transport retirement revoke the resumed session and the
worker drains admitted calls before settling the Task result.

The macOS ARM64 `standalone-turn-smoke.mjs --cua-task-recovered` and
`--cua-task-goal-recovered` fixtures paused a direct Task and a Task Goal,
restarted the production Rust worker, and resumed through production Rust
Core in PGlite mode. Bundled Codex and the deterministic Host helper preserved
the original native thread and turn, confirmed the protected approvals,
returned matching model and preview PNGs, and expired both observations.
The encrypted Task History retained a single input and the recovered result.
The saved Chat computer-use smoke also passed locally.

## 266. Run managed computer use on the assigned Cantrip OS desktop

Reference commit `e26b4fc68ea702c4259335f2cba28687298b5b63` (#3429).

Core now passes the captured Cantrip OS placement as the managed terminal
location. This lets the prepared Codex thread and its linked console agree
on the same Linux workspace. Host consoles continue using their source
directory.

On macOS ARM64, `standalone-turn-smoke.mjs --cua-guest` with
`--guest-image cantrip-os-local-qa:2938-rekeyed` ran the production Rust
server in PGlite mode, the production Rust worker, bundled Codex and an
isolated Linux guest from an existing image. The fixture used public routes
for guest attachment, workspace creation, source provisioning and Chat
preparation. The turn obtained protected approvals, captured the assigned
desktop, and returned the same PNG through the model and protected preview.
Reset expired the retained source and the worker required fresh scoped
approvals for the new target generation. The fixture verified encrypted
History and retirement of the guest desktop connection.
The Host managed Project Goal and standalone Chat smokes also passed.

## 267. Serve standalone Chat files from the Rust worker

Reference commit `941be90c9381ca90c276d669372fa86d8c9d6be5` (#3430).

The worker resolves the routing handle against the registered Chat and scratch
root, then processes the existing encrypted surface stream. The native file
commands list directories, resolve references, read UTF-8 and media chunks,
save by file version, and delete entries with recursive confirmation. Directory
handles keep scratch operations inside the registered root and prevent following
symbolic links. The heartbeat advertises all six file intents.

File and ZIP downloads use private snapshots with the existing size, count,
time, and sequential-read limits. Each snapshot belongs to its scratch root
and is released on EOF, cancellation, or worker exit. Preparing or reading a
download reclaims snapshots past their five-minute lifetime. The Rust parser
uses the generated TypeScript request contract and its download path refinement.

The local macOS ARM64 standalone Chat Files fixture uses Rust Core in PGlite
mode and the production Rust worker through the public encrypted API. It covers
text versions, media chunks, path and capability checks, recursive deletion,
immutable file downloads, ZIP contents, and download scoping.

## 268. Discover permission profiles on the selected Rust worker runtime

Reference commit `d051493ec3512e63a14f89a6c5be60519cf2188a` (#3431).

The Rust worker resolves the checkout routing handle and opens the scoped
native runtime for the selected model and provider. It asks Codex for all
permission profile pages at that checkout, preserves Codex's eligibility
decisions, and normalizes absent descriptions to empty strings. A native
method-unavailable response selects the legacy capability result. Other
native errors reach Core's existing error handling.

The macOS ARM64 `standalone-turn-smoke.mjs --permission-profiles` fixture ran
against Rust Core in PGlite mode, the Rust worker, and bundled Codex. Both
Project and standalone Chats received 101 configured profiles across multiple
pages. Only the trusted Project checkout exposed its local profile. The
fixture also verified the built-in entries, Core's YOLO alias, and the absence
of inference requests. The existing permission-transition tests and wire
comparisons for the two permission response contracts passed locally.

## 269. Discover MCP imports on the Rust worker

Reference commit `0787ce8e2f50e321e33b2af9b7ecf2b54e041791` (#3432).

The worker reads user and checkout Codex TOML and Claude JSON, including
the selected checkout's entry in the Claude user file. It preserves source
order, expands supported Claude environment references and excludes reserved
managed names. Configuration validation errors use generic diagnostics to keep
configuration keys private. The worker seals the candidates with the scoped
MCP key and existing blind index format before returning them to Core.

Local HTTP discovery reuses the existing host listener inventory, restricts
the handshake to loopback, and requests cleanup for the sessions it opens.
It accepts JSON and SSE with the existing timeout, response and concurrency
limits.

The macOS ARM64 `standalone-turn-smoke.mjs --mcp-discovery` fixture ran the
production Rust worker and Rust Core in PGlite mode. It used an isolated
listener list with real loopback endpoints to verify global and project
discovery, encrypted round-trips, session cleanup, redirect rejection and
saving a discovered project configuration.

## 270. Run Settings provider connection tests with the Rust worker

Reference commit `0523efd8fb4ac3f9dfd46eba6b4e46c824cb7af5` (#3433).

The worker opens the saved credential and selects the same provider runtime
and model route used by conversation turns. It admits a real Codex turn on
an ephemeral thread with a disposable workspace, a read-only sandbox, and no
shell or attached MCP servers. A nonempty reply is required. The worker waits
for native settlement before releasing the workspace. Provider failures use
the endpoint-safe diagnostic so Core can classify them without provider
credentials or raw response bodies.

The macOS ARM64 `standalone-turn-smoke.mjs --provider-connection-test` run
used Rust Core in PGlite mode, the Rust worker, bundled Codex, and a loopback
Responses fixture. It verified encrypted credential use, streamed success,
repeated HTTP 401 replies, an empty reply failure, recovery, and cleanup.
The existing worker and public response contracts matched 354 Node and Rust
comparisons.

## 271. Read ChatGPT quota and redeem banked resets in the Rust worker

Reference commit `266c432c311e05b9b20e8ebe4322dc4bcb77c343` (#3434).

The ChatGPT account runtime serves `provider.quota.read` and
`provider.rate-limit-reset.consume`. Both reuse its scoped account home,
credential handling, and validated quota projection. Reset redemption reads
the live balance to apply the existing paid-credit rule, then sends the
idempotency key and optional reset credit ID to Codex. A native expired-token
reply can trigger a refresh and one retry with the same request. Once Codex
returns a valid outcome, the follow-up quota read is best effort.

The production Rust worker passed the macOS ARM64 ChatGPT catalog smoke with a
loopback Codex RPC peer, an encrypted portable credential, and the bundled
native runtime owner. The fixture checked the exact native requests, quota
projection before and after redemption, the 100-credit boundary, an outcome
with a failed follow-up quota read, and the reauthentication-required reply
when refresh credentials are absent. The fixture made zero live provider
calls. Fourteen focused Node tests and 2,901 Node/Rust quota and reset contract
comparisons passed.

## 272. Prepare the assigned Cantrip OS desktop through the Rust worker

Reference commit `2cf8799eb801647adc52c7c29a01898607b15602` (#3435).

The worker admits `surface.desktop.os-prepare` on its authenticated command
connection and checks the server, owner, project, and worker against the
captured execution. It opens the assigned guest display and returns its
generation after observing a monitor through the native helper. Preparation
shares the workspace carrier with active previews. When no other owner is
using it, preparation releases that exact carrier before replying.

On macOS ARM64, the public managed desktop create route ran through Rust Core
in PGlite mode, the production Rust worker, and a real Linux X11 guest from
the existing local image. The saved row matched the observed desktop
generation and all placement generations. The fixture rejected a stale
runtime selection and a disabled guest service. The native inventory and
preview smoke also verified that preparation preserved two existing preview
sessions and rejected a different server identity. Four desktop placement
tests and seven Node/Rust generation verdict comparisons passed.

Guest viewer attachment, streaming, and input still need a Rust implementation.
The integrated fixture used the Docker transport.

## 273. Stream the assigned Cantrip OS desktop through the Rust worker

Reference commit `86e4ecd14121dd87ec9faea19b83913ffe449f8f` (#3436).

Remote Desktop attachments verify the saved project, worker, OS source, and
generation against Core's captured execution. The saved monitor target is
opened through the native guest carrier. The viewer shares the carrier with
other authorized participants and owns its native capture binding. It reuses
the Rust desktop session's JPEG encoder, encrypted frames, and attachment
transport. Guest reconnects require the saved desktop generation. Closing
the last capture releases the carrier when no other participant owns it.

The public smoke used production Rust Core in PGlite mode, the production
Rust worker, and an existing Linux X11 Docker image on macOS ARM64. Two
relay viewers decrypted JPEG frames, detaching one kept the other active,
and detaching the last retired the carrier. Stopping the guest display
rejected the old view without starting a new desktop. Explicitly creating
a replacement captured a fresh generation and streamed successfully.
Repeat with `standalone-turn-smoke.mjs --os-desktop-view --guest-image`.

Guest viewer control, keyboard, pointer, and clipboard input remain open.

## 274. Take and return Cantrip OS desktop control from the Rust viewer

Reference commit `9922818de7611935d2562942afd1997cb75a8fcc` (#3437).

One authorized attachment owns human control across the guest workspace's
viewers. Taking control interrupts in-flight computer use and closes its
native sessions before opening the viewer's input participant. The takeover
request can cancel running input while an ordinary frame is waiting for the
guest pipe. Returning control, suspending, and dropping a route release
the native binding before agent admission resumes. Input cancellation closes
held controls and rotates the input epoch while preserving the human lease.
Keyboard, pointer, and clipboard commands use the existing encrypted viewer
protocol and ordered native input receipts.

The local desktop inventory smoke ran the production Rust worker and a real
Linux X11 guest over Docker. The fixture observed an actual held agent button,
took control, and verified the button was released. The interrupted timeline
reported uncertain delivery. Guest computer use was rejected during human
control, the previous native session was retired, and reopening worked after
return. The public viewer smoke exercised two independent surface attachments,
exclusive takeover, clipboard copy, live key and button holds, epoch renewal,
stale return and input rejection, and cleanup on return and disconnect.
The existing managed guest computer-use smoke also passed with Rust Core
in PGlite mode, bundled Codex, and a local model fixture. Fifty-one focused
Node tests and seven Node/Rust desktop control verdict comparisons passed.

## 275. Observe saved Cantrip OS Chat threads in the Rust worker

Reference commit `ed54c123690c7720b00047e53447364f94400747` (#3438).

Chat sync prefers the live owner of the exact native thread. After a restart,
it verifies the saved Linux placement and opens the same scoped Codex home used
by thread preparation. The worker reads the existing thread status without
resuming the thread or publishing history.

On macOS ARM64, the public sync smoke ran against Rust Core in PGlite mode,
the production Rust worker, bundled Codex, and an isolated Linux Docker guest.
It observed the same thread running and idle, restarted the worker, and
verified the retained message identities and decrypted text with one model
call across the entire run. A direct worker fixture checked cold sync before
thread preparation, rejected a mismatched checkout path, and observed no MCP
binding or model call. Host and standalone Chat discovery and observation
also passed locally.

## 276. Recover an applied Chat Goal's first turn in the Rust worker

Reference commit `9429f6c30446ac640e7473cc751adb53d21283c5` (#3439).

The worker confirms ownership of the native inference journal and matches
the saved setter, claim revision, Goal epoch, and prepared native thread.
It observes the native producer's actual enqueue and returns the accepted
operation identity. For a prior worker's unstarted admission, it asks Core
to fence that exact admission before the existing Goal recovery path
continues. If there is no child admission, a current native Goal read can
prove the saved claim is no longer eligible.

The macOS ARM64 `standalone-turn-smoke.mjs --goal-claim-recovery` fixture
queued encrypted Goals through Rust Core in PGlite mode, using a production
Rust worker and bundled Codex. It restarted once before Core accepted the
first child and once after acceptance with the reply lost. Each scenario
finished on its original thread and epoch, ran the setter once, consumed its
queued claim, and retained one copy of the original input. The second
scenario verified the fence for the replaced worker generation. The
existing `--goal-handoff-recovery` fixture also passed with the same binaries.

## 277. Run and control Chat Goals in Cantrip OS

Reference commit `a0ca82654931362043dccdd1d0778da5ee81b0e5` (#3440).

Prepared Cantrip OS Project Chats use the native Goal producer and the
canonical command receipt. The producer checks Core's current execution
placement against the captured Linux scope and uses its prepared Codex
environment. A cold Goal read reopens the same guest home. Create, pause,
edit, resume, clear, and queued Goal recovery use the existing managed
thread and admission paths.

The macOS ARM64 public smoke used production Rust Core in PGlite mode,
the Rust worker, bundled Codex, an isolated Linux guest from an existing
Docker image, and a local model fixture. It ran a native shell command in
the Linux checkout, verified the encrypted Objective after worker restart,
then paused, edited, resumed, completed, and cleared the Goal. The direct
worker smoke read a cold guest Goal before preparation and rejected a
mismatched binding generation. The guest claim recovery smoke lost an
accepted admission reply, fenced the replaced process, and finished on
the original thread with one copy of the queued input. Host claim recovery
and guest Chat sync also passed.

The current Task creation API in both Core implementations reserves
explicit Cantrip OS placement for Agent Chats.

## 278. Ship the Rust worker in Cantrip packages

Reference commit `872d343ecc100fc6154f0580d0e88f48baeb2bd2` (#3441).

Standalone archives, desktop runtime assembly, and hosted Compose use the
canonical Rust worker package. The standalone archive carries the native
worker, Codex, CLI, CUA, and notices under the existing archive name. Desktop
launches the native executable directly and stages private PostgreSQL tools for
legacy PGlite upgrades. Hosted Compose retains the same enrollment environment
and persistent worker volume.

On macOS ARM64, the canonical packager assembled local native service builds
with a freshly verified pinned Codex bundle. The archive extracted into a path
with spaces and Unicode and contained no Node runtime or Node worker modules.
Both MCP entry points launched, and the bundled native CUA helper passed its
fake-capture smoke. With an empty worker PATH, the complete package ran a
managed Codex turn with the bundled CLI against packaged Rust Core. The
worker control fixture passed enrollment, credential rotation and revocation,
restart, and clean SIGTERM shutdown.

The desktop runtime assembled from packaged services without Node. The
production launcher kept the server and worker identities stable across
restarts, persisted settings, and reaped both native services on orderly
shutdown and supervisor loss for PGlite and bundled PostgreSQL.

The packaged desktop launcher also upgraded and reopened a real legacy PGlite
fixture. The native profile round trip compared 137 database tables, preserved
1,807 original files, and restored a write made after upgrade back into the
legacy format. Thirty-four focused packaging and deployment tests, nine
desktop launcher tests run serially, and the desktop compile check passed.
Hosted Compose rendered the expected native build and persistent volume.
The updated Linux worker image and Windows package were not run in this cycle.

## 279. Retire the desktop Node profile converter fallback

Reference commit `99ca24205297aa11798dd7ea2a9131574331286c` (#3442).

Desktop always invokes the native server for profile preparation. The
package records a private PostgreSQL compatibility path, and the launcher
uses the conventional path when older metadata omits it. The server
attempts to open the actual profile before it needs the compatibility
binaries. Desktop no longer reads a JavaScript converter path or passes a
Node executable to the server.

Local macOS ARM64 assembly produced a runtime without Node. The real
launcher and worker passed restart, retained settings and identity, and
shutdown and supervisor-loss checks with PGlite, private PostgreSQL, and
a disposable external PostgreSQL service. The packaged launcher upgraded
and reopened a legacy profile. The round trip compared 137 tables,
preserved 1,807 original files, and restored a later write to the legacy
format. Nine launcher tests and fifteen packaging tests passed.
Tauri compiled with asset copying disabled for the compile check because
the shared debug staging directory retained read-only PostgreSQL files.

The standalone server's explicit developer/reference converter flags and
the development worker launch still need retirement. The older signed
updater harness rebuilds its baseline with the current launcher and still
expects an older Node worker. That harness and Windows were not run here.

## 280. Run the Rust worker in the development stack

Reference commit `dcd1e1255acb34cd8e171fb5cb4c61a70d4ddaaf` (#3443).

Browser, PostgreSQL, and named desktop development all use the same Rust
worker launcher. Relative profile and log paths, development identity, and
helper selection retain their existing conventions. The watcher attempts
the actual Cargo build before stopping the running worker. It closes the
worker's owning pipe and awaits its exit before launching the replacement.
Direct `start` loads the worker's `.env`, and development watch retains its
environment-only configuration. The old worker has a `reference:start` entry.
The root build, typecheck, and test commands include the native worker.

Both native services built locally on macOS ARM64. The real
`pnpm worker:dev` command connected to Rust Core, retained its existing
worker ID and relative profile paths, reported an intentional compile
failure while the original worker still answered commands, rebuilt once
the source was restored, and shut down its replacement through stdin.
The direct workspace start read its worker ID and connection options
from an owned `.env` fixture. The native worker package assembled from
the local build and launched with an empty PATH. Twenty-six development
tests and fifteen release configuration and MCP packaging tests passed.
Windows and the desktop renderer were outside this cycle's runtime checks.

## 281. Remove the server's Node profile conversion commands

Reference commit `4cf07adbc6c1628ea23197712e58b39ac9856985` (#3444).

The Rust server prepares, exports, restores, and activates legacy profiles
through the native PostgreSQL compatibility runtime. The CLI reports an
unavailable compatibility runtime after a real native PGlite open failure.
Development can use a configured `CANTRIP_LEGACY_POSTGRES_BIN_DIR` or
build the tools in a temporary directory after that failure. The build
honors the owning stdin pipe and releases its staging on completion.

On macOS ARM64, the native round trip passed against an actual legacy
PGlite database with an empty executable search path. It verified missing
and incompatible tool failures, byte preservation of the original 1,807
files, 137 tables, and rollback that retained a later native write. The
real development launcher built its own compatibility tools, upgraded a
stopped profile, served its HTTP bootstrap, and released temporary
assets. A controlled subprocess test verified build cancellation and
staging cleanup. Both Rust profile tests passed, and the staged server's
migration launcher used only the native CLI with the system search path.

The historical desktop fixture now uses the native conversion commands.
The local historical Node archive exited at startup due to a missing
generated protocol module, so the full historical HTTP fixture was not
run. Windows runtime verification remains separate.

## 282. Restore the shared Rust build module in Linux server packaging

Reference commit `59d5f5a1a2287a095387f7c814a590901dabf9b8` (#3445).

Both server Dockerfiles copy the shared Cargo launcher into the build and
packaging stages. Each stage imports the server build module, including
packaging with a prebuilt executable. The deployment tests check both
stages in each Dockerfile.

The canonical Linux ARM64 distribution built and exported with local
BuildKit. The exported artifact ran PGlite and bundled PostgreSQL migrations
as the service user without Node, then reached HTTP readiness with PGlite
and shut down successfully. The sixteen deployment tests passed. The
Linux x64 export was outside this cycle's build validation.

The runtime audit found that the Cantrip OS executor package still carries
JavaScript file and Run helpers and a Node dependency. The Rust worker
calls the native guest binaries. Retiring the old helpers requires
updating the executor package and its comparison fixtures.

## 283. Retire the JavaScript helpers from the Cantrip OS executor package

Reference commit `10ccfda39b4c8a668a2117991b7299bbdcf13ad1` (#3446).

Executor 0.21.0 installs the Rust file and Run helpers and keeps the C
process owner and Python service bridge. An upgrade removes the old
JavaScript helpers and their package dependencies. The differential cases
can still compare with those helpers on historical executor packages.

The Linux ARM64 BuildKit export contained both newly built Rust helpers,
the process owner and the Codex executor. Debian package inspection found
no Node dependency or JavaScript helper. The local packaging test reused
the Codex 0.166.0 executor from guest package 0.12.0, built before the latest
Codex patches. A disposable guest upgraded from 0.12.0 to 0.21.0, then ran
with the Node package purged. The production Rust server and worker passed
workspace provisioning, protected file operations, Run definition and
execution, and restart recovery. Ten focused Cantrip OS tests also passed.

The disposable guest kept the static noVNC viewer assets during the purge.
Debian's full noVNC package pulls Node into the OCI guest and the workspace
package. That distribution dependency remains open. Linux AMD64 and the
latest Codex executor build were outside this cycle's validation.

## 284. Ship the Cantrip OS desktop viewers without Node

Reference commit `4f95f946564ef73c025cbd502b61f6d5e25fb240` (#3447).

The OCI image and workspace package 0.5.0 use noVNC browser assets
extracted from Debian's package at build time. The assets retain their
Debian version and copyright. Python websockify serves each viewer and
forwards its VNC connection. The workspace package owns a private copy
of its browser modules and keeps the existing viewer URLs. The OCI
personal viewer has its own asset path and can run without Workspaces.

A fresh Linux ARM64 OCI image installed Workspaces 0.5.0, Executor 0.21.0,
Remote 0.11.0 and Recovery 0.5.0. Its Debian package database and executable
search path confirmed Node and the full noVNC package were absent. The
personal viewer served the browser assets and received a live RFB banner.
The workspace gateway served the same module paths, opened the selected
desktop and checked restart and stopped-target behavior. Separately,
upgrading a disposable guest from Workspaces 0.3.0 preserved an existing
workspace and moved the viewer's module links to the bundled files.
Thirteen focused Cantrip OS tests passed.

BuildKit checked the AMD64 ISO recipe. The ISO was not built or booted.
The OCI test reused the earlier Codex 0.166.0 executor from package 0.12.0.

## 285. Launch linked desktop workers in Rust during development

Reference commit `c1c07cc82189409e58f6a1665c9ad1f73e0a89c0` (#3448).

The desktop's linked worker launch uses the native executable in both
development and packaged builds. `devtop` passes the worker path reported
by Cargo and the development CLI path to Tauri. Linking retains its profile
paths and explicit enrollment or retained credential. Both launch paths use
an owning stdin pipe and skip `.env` to protect linked-worker settings.

Nineteen desktop worker tests and nineteen development launcher tests passed
on macOS ARM64. The linked launch regression checks the executable,
working directory, and arguments in both configurations. The production
worker control smoke against the Rust server passed enrollment, credential
rotation and revocation, reconnect, retained state, and stdin shutdown
with the worker's PATH empty. The desktop tests used an asset-free Tauri
test configuration. They did not launch a desktop window or run on Windows.

## 286. Archive the Node worker as a compatibility reference

Reference commit `43075daf3928b8f407ba375f637cded9dd6d075f` (#3449).

The TypeScript worker, its tests and Node dependencies, and the historical
JavaScript guest helpers live under `tests/reference-node-worker`. The
reference package exposes explicit build, test, typecheck, and start
commands. The dependency-free `cantrip_worker` package keeps the Rust
development launcher and its working directory. Production Docker build
contexts exclude the archived worker. The native Cantrip OS process-owner
source remains with the executor.

A frozen offline install, the reference build and typecheck, the app
typecheck, and a desktop test compile passed on macOS ARM64. The selected
reference, app, and launcher tests passed. The Rust and archived Node
worker configuration fixture passed 61 comparisons and reopened persisted
identities and credentials in both directions. The original workspace
launcher invoked the native binary's version command from `cantrip_worker`.
The three historical guest helpers built independently, and the Linux
ARM64 executor's C compile stage and the existing boundary checks passed.

The current release packagers already use Rust. The historical Node
artifact verification helpers and final release audit remain open.

## 287. Verify only native worker release artifacts

Reference commit `053d0fb5e680aa4f20fb4fbc836a8dd37257d194` (#3450).

The release MCP verifier launches `mcp` and `cua-mcp` from the packaged
Rust executable with an empty PATH. The CUA verifier runs the signed or
unsigned native helper from its final layout with the fake backend. There
are no Node, Sharp, or JavaScript MCP fallback paths in those verifiers.
The standalone Node packager and runtime dependency checks are retired.
The Sharp layout smoke lives with the other Node reference fixtures.
Codex's code-mode host retains its existing macOS JIT entitlements.

Local macOS ARM64 packaging used prebuilt debug worker, CLI, and CUA
executables with the verified pinned Codex bundle. The standalone launch
reported its version with an empty PATH. The actual artifact contained no
Node executable, Node dependency tree, or retired MCP entry. Both native
verifiers passed. The bundled worker completed a managed Codex turn and
called its bundled CLI against the Rust server with an empty worker PATH.
Thirty-four focused verification and reference tests passed. Windows
paths were covered by fixtures. No Windows artifact or certificate signing
was run during this cycle.

## 288. Verify the native desktop runtime and legacy profile round trip

Reference commit `4a3b256e4071cf4db56add2b61f59036dbf255bd` (#3451).

The current desktop acceptance scripts expect the native worker child.
The signed updater fixture still recognizes Node when it is testing a
historical baseline. The updated installation must launch Rust in both
scenarios. The headless supervisor fixture starts the actual packaged
services with an empty PATH and checks the entire runtime tree for old
Node components. The legacy profile fixture reuses the prepared desktop
server configuration when it is supplied in the test artifact.

On macOS ARM64, the current packagers assembled desktop resources using
prebuilt debug services and the pinned Codex bundle. A fresh build of the
headless desktop supervisor ran those resources with PGlite, bundled
PostgreSQL and a disposable external PostgreSQL cluster. Settings and
identities survived restart. Both native processes exited on orderly
shutdown and after supervisor loss. The package contained no old Node
components.

The compiled Node server reference created a real PGlite profile.
The eight-case round trip preserved the original 1,774 files, read a
new Rust settings write through the Node reference after rollback, and
observed the subsequent Node write after re-upgrade. It also verified
actual migration failure and interrupted-export recovery. Twelve release
workflow tests passed. The WebView and signed installer update paths were
checked for script syntax in this cycle.

## 289. Return project statistics from the native worker

Reference commit `030693cbb81be82baf379c33597a22e745d910e2` (#3452).

The project statistics route sends `project.repository-stats` or
`project.folder-stats` to the worker that owns the selected source. Both
commands now resolve the existing routing handles and return the current
statistics schema. Git counts all reachable commits and reads the tracked
index paths. Folder scans keep the reference's directory, entry, file, byte,
and time bounds. They skip Git metadata and do not follow symbolic links
outside the selected folder. The runtime owns both Git children and joins
the scan on shutdown.

The production Rust worker and Rust Core in PGlite mode returned exact file,
byte, and line counts for a managed project with an opaque source path on
macOS ARM64. Three focused worker tests exercised a real Git checkout,
text and binary folder entries, and symbolic-link handling. The managed
folder integration fixture now checks the public statistics response.

The route audit also identified project and terminal script discovery,
retained project-file deletion, Host desktop probing, and Cantrip OS
tunnel preparation as remaining dispatch work.

## 290. Discover encrypted project and terminal script commands in Rust

Reference commit `43dd2e4ed250dd901ebb34baca13a903a3ebac0d` (#3453).

The worker resolves the selected project worktree and opens the existing
encrypted terminal state to discover scripts in its selected directory.
It reads bounded local package, Dart, Just, Cargo, Gradle, and Make
manifests. It preserves the existing runner selection, order, and
descriptions. Manifest reads stay within the selected directory, and
discovery only reads files. The generated protocol validates the command
list before the worker seals the existing operation-bound response.

On macOS ARM64, the production Rust worker and Rust Core in PGlite mode
returned 22 project commands across all six manifest types and one command
from a terminal's protected relative directory. Both decrypted lists
matched the archived Node scanner, and opening the responses with a
different operation ID failed. Two focused Rust tests covered manifest
discovery, the Windows Gradle wrapper, and internal and external links.
Regenerating the Rust contract preserved the previous project insights
schema nodes.

## 291. Remove retained managed project repositories

Reference commit `e48f35d615842378d6befa24558d1cb835c70eae` (#3454).

The native worker handles the retained `project.files.delete` command
from the project removal route. It resolves the saved routing handle,
opens the checkout beneath the worker's repositories directory without
following linked path components, and retires matching Run processes
before removing files through the opened directory. An already-absent
checkout reports `deleted: false`.

On macOS ARM64, the production Rust worker and Rust Core in PGlite mode
removed a retained project and its managed checkout, accepted an already
missing checkout, preserved a user-owned source and a sibling checkout,
and rejected an escaped path through a linked parent. The response kept
the rejected project record. Two focused worker tests covered removal
ordering, retry, and linked path rejection.

## 292. Connect Host desktop creation to the native capture helper

Reference commit `cc71d037805628ed18bde9aa8099e75fec025a9c` (#3455).

The worker advertises its macOS Host desktop capability and handles the
existing `surface.desktop.probe` command. The desktop actor asks the
owned native helper for its actual backend capability, fences the reply
to the connected server epoch, and reports initialization errors through
the existing response. Attaching the desktop still owns the first image
request and platform permission result.

On macOS ARM64, the existing WorkerLink relay fixture now creates the
Host desktop through the public Core route. It verifies the response
to a missing helper, retries with the native fake capture backend, and
checks that initialization never requests display inventory or an image.
The same fixture receives encrypted frames from the native worker,
checks desktop input and viewport updates, and closes the attached
viewers. The actual ScreenCaptureKit helper also returned its native
capabilities with an empty PATH.

The archived Node desktop automation dependency supplied Host capture
and input on Windows and on supported Linux desktops. The native
helper currently supplies macOS Host capture and an explicitly assigned
Cantrip OS Linux desktop backend. The Windows and Linux Host backends
remain part of the replacement scope.

## 293. Forward captured Cantrip OS guest TCP services

Reference commit `f8e6410f8e995568740b9d8b886ebbc3011367a2` (#3456).

The worker handles `surface.tunnel.os-prepare` for guest TCP forwards
with an installed WorkerLink grant. It decrypts the captured record,
verifies the workspace placement against the guest service broker, and
checks the pinned service identity before opening a stream. The worker
owns the carrier and closes the connection when the attachment is revoked.

On macOS ARM64, the native worker and Core in PGlite mode used the public
tunnel and WorkerLink endpoints to connect to an owned loopback service
in a Cantrip OS Docker guest. The `--guest-tunnel` smoke rejected a changed
protected record, exchanged encrypted traffic across a TCP half-close,
and observed an open guest socket close on attachment revocation. The
existing Host tunnel smoke also passed for relay, direct, and legacy
connections.

Guest SSH and VNC forwarding and reverse listeners remain in scope.

## 294. Forward captured Cantrip OS guest SSH and SFTP sessions

Reference commit `1d210ced64087effa9516beb9137d4c066cdc0aa` (#3457).

The native worker prepares SSH forwards through the installed WorkerLink
grant and includes the observed workspace user, host alias and host key in
the existing grant response. The descriptor digest includes the SSH host
key in the original field order, preserving recorded service identity pins.
Each stream reads the client public key from the exact protected record
and gives it to the guest broker for the lifetime of that connection.

On macOS ARM64, Core in PGlite mode and the native worker passed the
Cantrip OS smoke with `--guest-ssh --guest-tunnel` against a disposable
Docker guest. OpenSSH pinned the real host key, rejected a different
client key and opened the expected workspace account and home. SFTP
round-tripped a file, and attachment revocation retired the live guest
SSH command. The TCP regression passed in the same run.

Guest VNC forwarding and reverse listeners remain in scope.

## 295. Verify the Node-free Linux ARM64 worker image

The canonical hosted worker Dockerfile built locally for Linux ARM64 from
`030693cbb81be82baf379c33597a22e745d910e2` (#3452), version `1.1.3439`.
In a read-only container running as UID 10001, the packaged Rust worker
enrolled with a local Linux ARM64 Core fixture (`1.1.3059`, PGlite), served
its version, and reopened its persistent volume without an enrollment code.
Both stops returned zero after SIGTERM. The launcher ran the native worker,
all four packaged executables resolved their native libraries, and the image
had no Node executable, Node package, or bundled `node_modules`.

## 296. Forward captured Cantrip OS guest VNC

Reference commit `be0d09b32fd474bfba6e388d8523de23039707e9` (#3459).

The native WorkerLink grant prepares VNC against the selected workspace's
running desktop and its captured display and remote-service generations.
The VNC stream acquires the same exclusive human-control lease used by
native desktop viewers. It cancels agent input and closes old agent bindings
before opening the guest service. The Worker returns control after the guest
confirms closure. If confirmation is unavailable, it retains the control lease
until the matching close succeeds or a fresh guest observation proves the
old desktop or remote manager was replaced.

On macOS ARM64, the PGlite Core and native worker passed the Cantrip OS smoke
with `--guest-vnc --guest-tunnel --guest-ssh` in a disposable Docker guest.
The real RFB 3.8 session read pixels from the guest, blocked a second viewer,
and injected a key and pointer button. Independent X11 observations verified
both holds and their release after attachment revocation. A fresh VNC stream
then opened on the same workspace. TCP and SSH passed in the same run.
A focused Rust test also covered agent cancellation, exclusive ownership,
and retained control until a new guest generation is observed.

## 297. Forward Cantrip OS guest reverse listeners

Reference commit `e7959135e2e9ada6ebe184307f309e0555e29654` (#3460).

Core's captured reverse-tunnel grant prepares a guest loopback listener
and receives the actual bind result. The worker verifies the same guest
service at WorkerLink activation before accepting and dialing the Host.
The client control channel accepts the existing raw heartbeat. The guest
carrier multiplexes TCP using its existing frame format and byte credits.
Only the loopback target from the protected tunnel record is dialed.
Channel retirement closes Host sockets and the captured guest listener.

On macOS ARM64, the native Core in PGlite mode and worker passed
`--guest-reverse --guest-tunnel --guest-ssh --guest-vnc` with a disposable
Docker guest. The reverse fixture confirmed no Host accept before activation,
two concurrent bidirectional exchanges over 1 MiB each, and a complete
guest request after the Host sent EOF first. Invalid control data and Core
revocation closed actual guest and Host sockets and released the guest port.
The Host relay, direct, and legacy TCP smoke passed separately.

## 298. Capture and control Linux Host X11 windows natively

Reference commit `bf746a8193860b464f9cf5e29b32ae04c7ffb70a` (#3461).

The Linux worker advertises the native Host desktop backend and probes the
helper when a desktop is created. The helper uses the local X11 session,
enumerates displays and application windows, and uses X11 Composite for
window pixels. X11 input is directed to the selected window using the shared
participant ownership and release code. Full-display remote views are view-only.
The explicitly assigned Cantrip OS X11 backend continues to own guest input.

On Linux ARM64, the real helper distinguished pixels in overlapping windows,
delivered input and releases to the selected window without changing focus or
pointer location, and rejected a retired capture after its X11 ID was reused.
The headless check and the existing two-display guest X11 check passed. A native
Linux ARM64 worker (`1.1.3461`) advertised and created a Host desktop and
delivered an encrypted window frame through the existing Core `1.1.3059`
fixture in PGlite mode with Node absent from the worker PATH.

Native Wayland and Windows Host capture and input remain in scope.

## 299. Capture Windows Host desktops and direct input to selected windows

Reference commit `e2b457c54647196f042897073e5cbb62ab9da779` (#3462).

The Windows worker uses the native capture helper in interactive sessions.
The helper enumerates displays and application windows with legacy numeric
public IDs. Window capture renders the selected window's client area without
sampling the surrounding screen. Window destruction and process identity
retire stale targets. Viewer pointer, key, and Unicode text are directed to
the selected window through the shared participant ownership and release
path. Display sharing is view-only. Applications that ignore posted Windows
messages may require foreground input.

The helper's Windows packaging build links the C runtime statically.
The first cross-built runtime probe failed in the Windows 11 guest with
`0xc0000135`. The helper built through the packaging entry point has no
dynamic Visual C++ runtime imports. Windows x64 worker and Windows ARM64
helper checks passed, as did the macOS and headless Linux helper handshakes.

The statically linked helper passed the real framed capture and input fixture
in a local Windows 11 x64 VM with an empty helper PATH. It captured the
selected pixels under an overlapping window, delivered pointer, key and
Unicode text events only to the selected window, released held input on
close, and rejected capture after that window was destroyed. Foreground
focus and the OS pointer stayed in place.

The shipped Linux x64 `node-screenshots` addon contains XCap 0.4.1 and
its GNOME Shell, Screenshot portal, and wlroots monitor capture paths.
Native Wayland monitor capture, legacy Host display input and clipboard
behavior, and foreground-dependent Windows applications remain in scope.
[Archived addon manifest](https://github.com/nashaofu/node-screenshots/blob/v0.2.8/Cargo.toml),
[XCap Wayland capture source](https://docs.rs/crate/xcap/0.4.1/source/src/linux/wayland_capture.rs).

## 300. Capture compositor outputs on Linux Wayland

Reference commit `4a67af7606959af5b212212f1c1c39ce7c570307` (#3463).

The native helper inventories Wayland outputs and captures the selected
output through the standard image-copy capture protocol or wlroots
screencopy. Native capture uses bounded, anonymous shared-memory buffers.
A removed output retires its capture, and a layout change during a frame
prevents publication of the old geometry. Full-display sharing is view-only.

When the session also has XWayland, its windows keep the existing X11
window capture and directed input. A unique geometry match between RandR
and a Wayland output preserves the legacy numeric public display ID.

Local Linux ARM64 fixtures passed on Sway 1.10.1 and Sway 1.12, covering
both capture protocols. They verified exact pixels from two independent
outputs and rejected a frame after its output was removed. The extended
check verified a rotated, scaled output, a real XWayland window frame and
scoped pointer input, and matching numeric RandR IDs. The existing X11
window fixture and the headless helper check also passed.

Wayland sessions that rely on desktop portals for monitor capture still
need their native fallback. Host clipboard and full-display input remain
in scope.

## 301. Capture Wayland outputs through desktop screenshot services

Reference commit `f121c01d48d05207afe7e327f1691e5065c64e1f` (#3464).

When the Wayland compositor does not expose either direct capture protocol,
the helper retains output identities and uses the session screenshot
services supported by the retired worker. It requests the output rectangle
from GNOME Shell when the caller is permitted. The XDG Screenshot fallback
lets the desktop handle permission and correlates the reply by D-Bus sender
and request path. It crops the returned image to the selected output in
the observed desktop layout. Unmatched image dimensions and layout changes
are rejected. The helper removes its GNOME scratch file and releases fresh
portal screenshots once it has opened them.

The worker allows time for portal consent and cancels the native frame when
the viewer drops the request. The helper closes a pending portal request.
The viewer can reconnect or change the target after a decline or consent
timeout.

On Linux ARM64, a headless Weston session and private D-Bus fixture verified
the GNOME area request, portal fallback, an immediate response, rejection
of unrelated replies, screenshot cleanup, denial, and explicit cancellation.
The scaled negative-origin crop unit test excluded every neighboring pixel
and rejected an incompatible layout. The headless helper regression and
worker compile check passed. The D-Bus fixture exercised the application
protocol without running the GNOME or KDE consent UI.

Host clipboard and full-display input remain in scope.

## 302. Copy selected text from shared Host windows

Reference commit `983b7d2fb3abc92717749572920200d130b4d8cd` (#3465).

The Rust worker sends an explicit copy through the bound input participant
and returns the existing encrypted clipboard message to that viewer. The
helper ties the operation to the selected window generation, handle, and
input sequence. A copy with no new text leaves the viewer's clipboard in
place. Paste continues to deliver text to the selected window.

On macOS the helper reads the selected text exported by the window's
focused accessibility element. It skips secure text fields. On Windows
it requests native copy from the selected control and accepts a new
Unicode clipboard value owned by that window. On X11, including XWayland
windows, it sends Ctrl+C to the selected window and receives a fresh
selection owned by that X11 client. It supports the X11 incremental
selection protocol for larger text.

On Linux ARM64, the framed helper on Xvfb copied whitespace and Unicode
from a hidden selection-owner window of the selected client. The fixture
rejected another client's selection, a stale selection, a mismatched
attachment, and a replay. Keyboard focus stayed with the other window.
The existing X11 capture and input regression and headless checks passed.
The macOS ARM64 worker compile and helper handshake passed. The Windows
x64 helper cross-check passed.

Live runtime checks for macOS and Windows clipboard copy remain open.
Apps with custom copy handlers that do not export selected accessibility
text on macOS or respond to native copy messages on Windows still need
coverage. Host full-display input and clipboard behavior remain in scope.

## 303. Restore full-display viewer input on Linux X11

Reference commit `64e4aaa9f72fb0a0cd56537b23527c0b0f20698c` (#3466).

The Linux X11 helper advertises full-display input to the worker through
its existing capabilities handshake. A viewer with a live encrypted route
can open a participant on the selected display. The helper grants one
physical-input participant at a time across Host displays. Other viewers
can keep watching and become eligible for input after the owner closes.

XTEST moves the pointer in the selected monitor's coordinates. Keyboard
input follows focus on that monitor. Copy returns a fresh X11 clipboard
selection from the focused client. A layout change retires old monitor
generations, and closing a binding releases held physical input.

The Linux ARM64 Xvfb process check used two RandR monitors and verified
pointer placement, rejection of keyboard focus on the other monitor,
exclusive control, Unicode copy with a held modifier, and physical key
and button releases on close and layout change. The existing scoped window
input, clipboard, assigned guest input, and participant unit tests passed.
The macOS ARM64 worker built successfully. macOS ARM64 and Windows x64
helper compile checks passed.

A local Core in PGlite mode and the macOS ARM64 worker exercised the
public WorkerLink relay with that Linux ARM64 helper. Both viewers received
encrypted display frames. The first moved the actual X11 pointer. The
waiting viewer received a new input epoch after the first detached and
then moved the pointer on the same display.

The Windows and Wayland full-display input paths remain in scope.

## 304. Restore Windows full-display viewer input

Reference commit `3d7f2e632ea0f373a0ee060a99b5465745431734` (#3467).

The Win32 helper advertises full-display input and uses the same exclusive
viewer ownership as the Linux X11 helper. It uses Windows system input for
pointer movement, buttons, scrolling, keyboard shortcuts, and Unicode
text. Pointer coordinates are mapped from the selected monitor into the
virtual desktop. New keyboard input follows focus on the selected monitor.
The helper releases its recorded holds when a viewer closes. Windows
continues to enforce its normal input privileges.

An explicit copy sends Ctrl+C to the foreground app on the selected
monitor. It accepts fresh Unicode text owned by that app. The existing
worker clipboard message targets the requesting viewer.

The Windows x64 helper and focused process fixture linked with the static
C runtime. The Windows ARM64 compile check passed. The x64 runtime check
is pending because the disposable Windows QA guest failed sign-in before
the fixture could start. The fixture checks physical pointer placement,
exclusive ownership, copy, input release, and Unicode text after handoff.

Foreground-dependent input for shared Windows windows and full-display
input on Wayland remain in scope.

## 305. Control a Wayland display through the Remote Desktop portal

Reference commit `8605b9766ed7d685466b1eee9b45ad2935020d6c` (#3468).

The Linux helper can open a Remote Desktop portal session for an
authenticated full-display viewer. Approval runs in the background so the
viewer can receive frames while the host decides. The helper verifies the
granted devices and matches the returned monitor stream to the selected
Wayland output. The worker waits on the same input binding while approval
is pending. One viewer owns the portal session at a time.

Pointer motion uses the selected stream's logical coordinates. The portal
delivers buttons, scrolling, and keyboard input through the compositor.
When clipboard sharing is granted, copy waits for a new selection from that
session and returns bounded UTF-8 text. Disconnect releases held controls
and closes the session. Cancelling an approval closes its request and
session before the next viewer can open one.

A local Linux ARM64 fixture ran the framed helper against a real headless
Weston output and a private D-Bus portal. It covered screenshot frames
during delayed approval, exclusive control, exact stream coordinates,
scrolling, Unicode keysyms and clipboard data, stale clipboard rejection,
input release, denial, a mismatched monitor, and cancellation. The eight
participant tests and the screenshot crop test passed. The macOS ARM64
worker and Windows x64 helper compile checks passed.

Actual GNOME and KDE consent and input still need local runtime coverage.
Wayland sessions that rely on the legacy system input tools remain in scope.
[Remote Desktop portal interface](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html).

## 306. Control a Wayland display through the host input tools

Reference commit `15aa104d961e8d8191b8a5efb387ff62463f74ac` (#3469).

When the Remote Desktop portal lacks keyboard and pointer support, the
helper can open the matching compositor output through its virtual pointer
protocol. The same exclusive viewer attachment owns button and key holds.
The helper connects to the host's configured `ydotoold` socket when a
viewer attaches and dispatches keyboard events to that device. The optional
Wayland data control protocol observes fresh clipboard text after a copy.
Unicode text uses `wl-copy` and sends the paste shortcut after checking the
published text. The selected monitor and active attachment still determine
pointer coordinates and ownership. Keyboard input follows the seat's focus.

A Linux ARM64 headless Sway fixture verified a framed monitor capture, an
actual XWayland button press and release at the selected output coordinates,
exclusive ownership and handoff, and fresh, stale, and Unicode clipboard
cases. A local socket verified the keyboard protocol and held key release.
The Weston portal fixture, eight participant tests, and macOS ARM64 worker
compile check passed. Live `ydotoold` kernel delivery and actual GNOME and KDE
consent remain unverified. This fallback requires a compositor that can bind
a virtual pointer to an output.

## 307. Send foreground input to shared Windows windows

Reference commit `432af48ecc0eb42b18798008585d1ba7ec47ee37` (#3470).

The retired worker activated the selected Windows window before dispatching
clicks, keyboard shortcuts, text, scrolling, and copy. The native viewer
now uses Win32 activation and dispatch for those operations. Each action
verifies the selected window generation and foreground target. Pointer
input also checks the actual point and active mouse capture. A visible
overlapping window can block a click. Plain hover uses directed window
messages, and agent input retains its independent window-directed path.

Window and display viewers share a single physical input owner. Waiting
viewers can keep receiving frames. Detach and failed dispatch release the
owner's recorded holds without bringing a window to the foreground. Copy
sends Ctrl+C through the same owner and accepts fresh clipboard text from
the selected window or its hidden same-process clipboard owner.

The statically linked x64 helper and process fixtures built. The helper
and fixtures also passed the Windows ARM64 compile check, and the x64
worker compiled. Eight participant tests and the framed helper smoke
passed on macOS ARM64. The Windows fixtures check scoped capture,
directed agent clicks, activation, Unicode input, blocked pointer input
under a topmost window, and clipboard copy after display-to-window handoff.
Those fixture assertions still need an interactive Windows run.
[Archived Windows activation implementation](https://raw.githubusercontent.com/zavora-ai/computer-use-mcp/v7.0.0/native/src/windows.rs).

## 308. Read macOS window selections exposed as text ranges

Reference commit `eed73bb558e1bd84b0897bb5c4146ee373c1f03b` (#3471).

The selected window's focused control can supply text directly, report an
Accessibility text range, or export an opaque text-marker range. The
helper asks the same control to return text for that selection. It fences
the result to the original window and focus and excludes secure controls.
Copy leaves the system pasteboard and foreground application in place.
Custom copy handlers that supply no readable Accessibility selection
remain a compatibility gap.

The macOS ARM64 helper build, two native Core Foundation selection tests,
eight participant tests, and framed smoke passed. The opt-in fixture
discovered and attached to its AppKit window without a focus or pasteboard
change. Reading the selection remains unverified. On the local macOS
27.0.1 system, the fixture and an independent native probe received
application-level Accessibility references for the requested window and
focused element. The same probe saw application-level references for
all reported windows of the frontmost app.
[Apple text-specific parameterized attributes](https://developer.apple.com/documentation/appkit/text-specific-parameterized-attributes)
[WebKit selection marker implementation](https://github.com/WebKit/webkit/blob/main/Source/WebCore/accessibility/mac/WebAccessibilityObjectWrapperMac.mm).

## 309. Restore task Git change summaries

Reference commit `b958e1fcf466b8820556b3a3689d87feca684955` (#3472).

The task metrics panel's encrypted `git.change-summary` operation now
reaches the native Git handler through the protected repository route.
It counts first-parent commit diffs within the requested time window
and includes staged, unstaged, and untracked files in the selected
worktree. NUL records preserve rename pairs and unusual filenames.
The untracked scan reads regular files within the worktree and counts
symlink text. It reports a partial result when a limit is reached.
The result validator is generated from the existing public schema.

A macOS ARM64 production Rust worker and local Rust Core matched the
archived worker in three encrypted endpoint comparisons. The checks
covered the date cutoff, first-parent merge, rename, dirty checkout,
binary and symlink entries, a sparse oversized file, and preservation
of checkout status. The native fixture also counted staged and untracked
lines in an unborn checkout through a nested Unicode path.

The live Git force-push preview and apply operations still require
their Rust handlers.

## 310. Restore reviewed Git force push

Reference commit `e018ab4f03f5bb9f6b1f56dff732946992fb0d6a` (#3473).

The app's encrypted preview and apply commands now reach the native worker.
The preview resolves the configured upstream, fetches that branch into a
remote-tracking ref, and reports outgoing and replaced commits with the
archived worker's counts, limits, warnings, and token format. Git resolves
the remote and branch names independently when their prefixes overlap.

Apply recomputes the preview, checks the token, and submits the reviewed
local commit with an explicit lease for the expected remote commit.
Automatic tag following is disabled for this operation.
[Git push lease semantics](https://git-scm.com/docs/git-push).

The macOS ARM64 worker passed the encrypted repository smoke against local
Rust Core. The fixture matched the archived preview, preserved the chosen
upstream with overlapping remote names, and rejected a moved local or remote
branch. A local fixture hook advanced the remote during the push and
the remote rejected the update. A fresh apply sent the reviewed local
object even when HEAD moved during the push. Other remote refs and tags
were unchanged. All 524 protocol tests passed locally.

## 311. Refresh the Remote Desktop target picker

Reference commit `f35e3249c1e8093de6fa174f2b4fef9a2e2a6260` (#3474).

The Rust worker accepts the existing encrypted viewer refresh request
and scans the Host inventory through the shared capture helper. Its
reply includes the requested target and the active capture identity.
Each scan is bounded and its reply stays with the attachment and
transport that requested it. An assigned Linux desktop reports only
its captured monitor. The worker seals the inventory using the same
private-state format as the fleet inventory and binds it to the
desktop surface.

The macOS ARM64 worker and the native helper's deterministic backend
passed the viewer smoke. It checked window and monitor refresh,
an unavailable requested window, and encrypted inventory scope.
The same smoke reused a disposable local Cantrip OS guest and
verified the assigned monitor inventory and the guest viewer's
existing control handoff.

The archived viewer can also return application icons and launch an
application when explicitly restoring a missing target. Those
capabilities still need native integration.

## 312. Restore a missing Remote Desktop window

Reference commit `1beeec5c3f9ae7af7d8056f9596dd5d3a81b9a2d` (#3475).

When the requested Host window is absent, the worker looks for the
saved application and prefers its saved window identity and title.
If the application has no listed windows, the worker checks the
viewer attachment again before invoking the platform launcher. It
waits for a window belonging to the application and opens that exact
capture. The saved target and the new capture identity remain separate.
The same surface reuses its resolved window on resume. A failed launch
leaves the view unavailable and a fresh refresh can request another
attempt. Launch status and updated inventory travel in the existing
encrypted viewer messages.

The macOS ARM64 smoke used a controlled launcher and the native
helper's deterministic backend to verify failure, successful launch,
the newly observed window, and resume without a second launch. A
separate background-only application bundle exercised the system launcher.
The assigned Cantrip OS guest viewer smoke and the Windows x64 worker
compile check also passed. Host application launch was exercised
locally on macOS. Application icons remain open.

## 313. Restore icons in the Remote Desktop target picker

Reference commit `837f6069fb4c77c11c4ce7cae1d448932b6acb9e` (#3476).

Host inventory again advertises the archived icon key format. The worker
resolves an icon batch against the current Host inventory and returns
bounded PNGs through the requesting attachment's encrypted control
stream. It retains the existing positive and negative cache paths.
macOS reads application bundle icons, Windows extracts the associated
icon of the matching process, and Linux resolves desktop-entry icons
including PNG, SVG, and XPM. Linux SVG rendering disables image references
outside the vector document. Assigned Cantrip OS viewers have no Host
application inventory.

The local macOS ARM64 viewer smoke verified native ICNS conversion,
cache reuse, duplicate keys, a queued batch, and rejection of a cached
key outside the inventory. An isolated Cantrip OS guest verified Host
icon isolation. The production Linux resolver decoded SVG and XPM in a
disposable local ARM64 container. The Windows x64 worker compile check
and all 524 protocol tests passed. Full Linux worker and Windows icon
runtime checks were outside this fixture.

## 314. Publish Remote Desktop inventory when the viewer connects

Reference commit `d61a2e663b3619a626439037ab8eac1fe572e8c9` (#3477).

The worker reuses the native inventory from opening a capture to publish
the requested and active targets. It queues the first frame before encoding
the inventory, then resends the current view when an attachment connects
or binds its transport. Target changes and capture failures publish
the current requested and active state. Explicit viewer refresh still
enumerates the current Host inventory. Guest publication uses only
the captured monitor.

The macOS ARM64 desktop inventory smoke verified automatic initial
delivery, viewport resynchronization, failure, a window-to-monitor
switch, and explicit refresh. It also exercised launch and icon
regressions and the assigned Linux viewer. A separate local Rust Core
and Rust worker smoke verified that two WorkerLink viewers in a
disposable Cantrip OS guest each received their own encrypted monitor
inventory before either viewer sent a viewport or refresh request.

## 315. Notify Core when a native Project Chat changes outside a turn

Reference commit `bf2bfacd5a4f9730fefc2dcbaaab454ac72682fd` (#3478).

The archived worker batched out-of-band native turn, goal, queue, and
settings events into `chat.thread.changed`. Core still consumes this
notification to invalidate the matching Chat resources and reconcile
native status. The Rust worker now observes the selected Project Chat
when its console starts or a runtime handoff adopts the destination.
It batches distinct changes for 75 ms, keeps a monotonic revision,
and sends only the thread ID and change categories. The selected thread
owns the subscription, with transport and account checks before sending.
Active Cantrip turns continue to publish through their existing receipts.

The local macOS ARM64 worker build passed. With production Rust Core
and bundled Codex, the prior worker timed out waiting for the live
`chat-plan` invalidation after a console settings change. The updated
worker delivered the invalidation, and the same fixture completed a
console-steered turn with the expected durable messages. The separate
native provider handoff smoke retained the conversation across worker
restart. The live invalidation case exercises settings on macOS.

## 316. Restore both terminal screens when reattaching after a resize

Reference commit `f4bcfe651cbb1dca5359ab82861837a7b59fd93c` (#3479).

The terminal worker redraws the inactive normal screen and its saved
cursor before switching into the alternate screen in a replay. It places
bounded normal scrollback above the viewport before clearing and redrawing
it. If both viewports exceed the snapshot budget, the active viewport takes
priority. A complete original-size stream still uses raw replay. The
snapshot uses the existing terminal hydration format and frame limits.

Two focused Rust tests passed, including a truncated alternate-screen
replay with a normal cursor and scrollback. The local macOS ARM64 smoke
used the production Rust worker and Core, a real shell PTY and xterm. The
previous binary reproduced the missing normal screen after a WorkerLink
reattach during alternate-screen use. The updated worker passed the same
case at the new size. Actual PTY output exited the alternate screen and
continued at the original cursor position. The same run also exercised the
Host relay and terminal service restart and recovery. Full xterm reflow
and exact signal exit metadata remain open.

## 317. Report Host terminal exit signals

Reference commit `0f978e2a288c23ccbe4172f04e3bc3e6207853b7` (#3480).

Host shell, managed console and service PTYs use their owned child's reaped
status to report Unix signals. Signal termination uses exit code zero and
the actual signal number, as in the archived terminal worker. An explicit
numeric exit, including 143, stays numeric with a null signal. Service
shutdown and restart logs carry the same status. Numeric-only backends
continue using the process code they report.

The pinned Node PTY on macOS ARM64 reported code 0 and signal 15 for
SIGTERM and code 143 and signal 0 for an ordinary `exit 143`. The prior
Rust worker sent code 1 and null signal for SIGTERM. The updated worker
matched the archived wire format through both the encrypted Host relay
and WorkerLink. The same local production Rust Core and worker smoke
verified the service restart after SIGTERM and service recovery after a
worker restart. The worker PATH contained no Node executable. Runtime
validation in this cycle used macOS ARM64.

[Archived Node PTY Unix exit handling](https://github.com/microsoft/node-pty/blob/v1.2.0-beta.15/src/unix/pty.cc#L224-L231)

## 318. Reflow completed terminal lines after resizing

Reference commit `2cf0bc8c24e5beeb3f2988ca51bc7dce6b070839` (#3481).

The worker uses a patched copy of its pinned `vt100` 0.16.2 parser from
`eb66ffaf7d771c13303ef73b29f6f2a56fdacecf` under the upstream MIT license.
The parser rewraps completed normal-screen lines and retained history at
the new width. It preserves cell styles, explicit line breaks, and wide
characters at wrap boundaries. Like the archived xterm.js configuration,
it leaves the active cursor line for the application to redraw and
resizes the alternate screen without reflow. The worker keeps the
existing encrypted hydration format and history limits.

Two focused parser tests passed for width changes in scrollback, height
recovery, and wrapping at a one-row viewport. The local macOS ARM64
production Rust Core and worker smoke compared an actual shell PTY with
xterm.js through encrypted WorkerLink. It verified a narrower then wider
reattach with exact visible text, wrap flags, cursor, color, a wide glyph,
and combining marks. The previous worker failed the same viewport
comparison. Alternate-screen replay, exit signals, Host relay, and service
restart and recovery also passed in that run. The hydration encoder still
writes explicit line breaks between serialized scrollback rows. Broader
xterm escape-sequence and scrollback hydration parity remains open.

[Pinned Rust terminal parser](https://github.com/doy/vt100-rust/tree/eb66ffaf7d771c13303ef73b29f6f2a56fdacecf)
[xterm.js 6.0 resize behavior](https://github.com/xtermjs/xterm.js/blob/6.0.0/src/common/buffer/Buffer.ts)

## 319. Preserve terminal soft wraps across the scrollback boundary

Reference commit `c9ed5a68599b176bb783b19bf24b4f2d4d06c45f` (#3482).

Native replay renders the normal screen and retained history as one ANSI
stream. It emits real line breaks only for hard breaks and restores the
cursor after drawing the viewport. When a wide glyph can trigger a soft
wrap naturally, it supplies the glyph at the right margin. For an edited
wrap it writes and erases temporary cells. Replay restores the normal
screen's saved pen before entering an active alternate screen, and owns
its existing byte budget by dropping older history before the viewport.
The same stream replaces stale scrollback instead of appending duplicates.
Both the encrypted terminal format and the full original-size raw path
are retained.

Four local parser tests passed for scrollback/viewport wraps, bounded
history, resizing, and height recovery. The macOS ARM64 Host terminal
smoke used the production Rust worker and Core and an actual shell PTY.
The previous worker delivered hard breaks for a soft-wrapped line
spanning scrollback and the viewport. The updated worker matched xterm.js
on both resizes for the text, wrap flags, colors, and cursor. The same
run passed the alternate-screen, signal, relay, and service recovery
cases. Broader xterm escape-mode coverage remains open.

[xterm.js 6.0 snapshot serializer](https://github.com/xtermjs/xterm.js/blob/6.0.0/addons/addon-serialize/src/SerializeAddon.ts)

## 320. Restore terminal editing and input modes on reattach

Reference commit 35c0bb1d87f1fb0bb6afb93107291c242ae8a296 (#3483).

For a reconstructed snapshot, the native worker resets the viewer's drawing
and mouse modes before replay, then restores the active viewport's insert,
origin, autowrap, reverse-wrap, focus reporting, keypad, and scroll-margin
state. The parser applies insertion, right-edge writes, and reverse backspace
while processing PTY output. The existing encrypted hydration format and
complete original-size stream are retained.

Seven local parser tests passed. A macOS ARM64 smoke ran the production Rust
server and worker with an actual shell PTY. On the previous worker an encrypted
WorkerLink reattach lost keypad, reverse-wrap, and focus modes and retained
stale mouse tracking. The updated snapshot matched xterm.js for input modes,
cursor and viewport. Subsequent live output matched under the restored insert
mode and origin-relative scroll margins. The same smoke passed reflow,
alternate-screen replay, Host relay, exit signals, and terminal service
recovery. The worker PATH contained no Node executable.

Canonical xterm hydration metadata and other escape sequences remain open.

[xterm.js 6.0 editing and input behavior](https://github.com/xtermjs/xterm.js/blob/6.0.0/src/common/InputHandler.ts)

## 321. Send canonical terminal hydration over WorkerLink and direct

Reference commit 59734b7c3896907695c93c8ed0a34b79782a2ae5 (#3484).

The worker now sends the canonical snapshot and its metadata over WorkerLink
and the direct terminal socket. The first encrypted output frame carries the
metadata. The snapshot records the active buffer, cursor, modes, and the actual
number of history rows retained in the bounded replay. The output boundary
advances when the PTY writes and is reset with a new service process generation.
The app resets its terminal before applying the snapshot and receives ready
after every chunk. Synchronized output is recorded in metadata and the
snapshot can display immediately. The command relay keeps its existing
envelope. An oversized viewport can still fall back to bounded raw output.

The local macOS ARM64 fixture ran actual Rust Core and worker with a real PTY,
the native direct broker, and Cantrip CLI. The previous worker sent raw metadata
in the same fixture. The updated worker sent canonical metadata before the
first resize and matched xterm.js after narrowing and widening. The fixture
used the app's hydration controller with multiple encrypted chunks and
compared the cursor, scrollback and modes. It also verified
alternate-screen replay, an advanced service process generation with fresh
output after restart, and the existing relay, direct, and CLI terminal paths.
Eight parser tests and two worker replay tests passed. The worker PATH
contained no Node executable.

Automatic redraw when an oversized viewport also has a truncated raw buffer
and additional escape-sequence parity remain open.

[xterm.js 6.0 snapshot serializer](https://github.com/xtermjs/xterm.js/blob/6.0.0/addons/addon-serialize/src/SerializeAddon.ts)

## 322. Request a terminal redraw when bounded raw replay is truncated

Reference commit fb818408b0284b33eecb7854010ec500713668bf (#3485).

When canonical hydration falls back to truncated raw output, the owned PTY
temporarily changes columns and restores the current size after 25 ms. The
process generation shares one recovery result across viewers. The PTY actor
serializes the pulse with normal resizes and finishes it even if the requesting
viewer disconnects. The attachment takes its output boundary after recovery
and sends the existing requested or failed recovery status before ready.
The worker reports when the process is gone or either resize fails.

WorkerLink terminal output now waits for room in its existing bounded queue
while the viewer returns credit. It keeps the attachment's output order,
including readiness and exit, without expanding the per-channel limits.

A real macOS ARM64 shell emitted a dense viewport that forced canonical
hydration to fall back to the two-million-character raw window. The previous
worker closed the encrypted channel with credit-exceeded. The updated worker
delivered all chunks, and the shell observed 399 then 400 columns. A second
attachment received the cached recovery result without another pulse.
The local smoke also passed the Host relay, direct broker, CLI, and service
recovery paths with Node absent from the worker PATH. Five focused Rust tests
passed, including both resize failure cases. Guest and Windows redraw
runtime behavior were outside this fixture.

Additional escape-sequence parity remains open.

## 323. Preserve terminal character-set glyphs across reconnect

Reference commit 32e0567850133b7474647b2b45d601a59e4acca4 (#3486).

The native terminal parser tracks G0 through G3, applies the DEC graphics
and national character mappings before storing terminal cells, and updates
the effective mapping on locking shifts and cursor restore. A reconstructed
snapshot starts with the default maps so it draws the translated cells as
written. It then restores the live mapping and the other designated slots
for subsequent output. The existing terminal message format is retained.

A real macOS ARM64 shell sent DEC line drawing through G0 and G1 and a
national replacement through G2. The prior worker replayed letters and
punctuation where the reference terminal displayed box glyphs and a pound
sign. The updated encrypted WorkerLink snapshot matched xterm.js, including
the next unshifted text and a later switch to G2. Eleven local parser tests
passed, including split input, cursor restore, and reset. The shell fixture
also exercised the existing terminal paths.

The archived xterm serializer replayed an OSC 8 link label with underline
and omitted its destination. Native replay still needs parity for that
underline. Saving and restoring the full hidden terminal cursor state
across a reconstructed attachment remains open.

[xterm.js 6.0 character mappings](https://github.com/xtermjs/xterm.js/blob/6.0.0/src/common/data/Charsets.ts)

## 324. Preserve text styling in native terminal replay

Reference commit 640f9c7a31dda172bc822e4e7e4e31b350960764 (#3487).

The native terminal records blink, concealment, strikeout, overline, and
separate bold and dim flags. Snapshot output restores each style and uses
the shared intensity reset before reapplying a flag that remains enabled.
Canonical replay renders OSC 8 labels as underlined text, matching the
archived serializer. The worker preserves the existing 32-byte cell and
its text capacity by packing the foreground and background color kinds.

Fourteen parser tests passed locally. In an encrypted WorkerLink test
with a real macOS ARM64 shell, the previous worker lost the added flags
and replayed the wrong intensity on adjacent cells. The updated worker
matched xterm.js for the test's content and per-cell styles, including
styled characters emitted after reattach. The same test run exercised
Host relay, direct, CLI, oversized replay, and service restart. The
worker PATH contained no Node executable.

Canonical underline matches the archived serializer's on/off behavior.
Full saved-cursor state remains open.

[xterm.js 6.0 style serialization](https://github.com/xtermjs/xterm.js/blob/6.0.0/addons/addon-serialize/src/SerializeAddon.ts)

## 325. Preserve the terminal's saved cursor across reconnect

Reference commit 6069fba17a84dae9080a0a6fae5aa3998ef0ce25 (#3488).

The terminal tracks separate saved positions, drawing attributes, and
character selections for the normal and alternate screens. It accepts
ANSI cursor save and restore, DEC cursor save and restore, and the
alternate-buffer mode aliases used by xterm.js. Saved rows follow
scrollback displacement, and restore uses the current terminal margins.
The attachment encodes each saved cursor after drawing its viewport,
then restores the live cursor. A saved row above the reconstructed
viewport is restored to its top visible row.

Seventeen parser tests and five worker terminal tests passed locally.
In the encrypted macOS ARM64 PTY
fixture, the previous worker lost the alternate screen entered with
mode 1047. The updated worker matched xterm.js for both cursor saves
after reconnect, including color, underline, and a saved DEC drawing
character. The same run covered alternate-screen resize, Host relay,
the direct broker, CLI, oversized replay, and terminal service recovery.
The worker PATH contained no Node executable.

[xterm.js 6.0 cursor save and restore](https://github.com/xtermjs/xterm.js/blob/6.0.0/src/common/InputHandler.ts#L2756)

## 326. Keep browser surfaces open when a saved site fails to load

Reference commit `924984f070d480ee29af56c6d12088a5dd8c398f` (#3489).

The archived browser adapter keeps the viewer attached when Chromium
reports a navigation error in a completed `Page.navigate` response. The
Rust worker now keeps the same session and streams Chromium's error page.
CDP command failures still propagate through the existing error handling.
[Chromium navigation response](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-navigate)

With the previous worker, an encrypted Browser record whose saved URL closed
the connection yielded HTTP 502 when attaching through WorkerLink. On macOS
ARM64, the updated worker and the Rust server with PGlite passed the same
headless Chromium test through WorkerLink relay and the legacy WebSocket.
Both received the encrypted location and a JPEG frame, then used protected
navigation to open a working page on the same attachment. The relay run also
passed the existing Chromium process and renderer recovery cases. The worker
ran with an empty PATH. Rust compilation, formatting, script syntax, and
`git diff --check` passed locally.

## 327. Stop a stalled Browser navigation from the viewer

Reference commit `da663b1e2d19318ecc55e3f060b59ea03b586a75` (#3490).

The Rust worker queues protected viewer navigation in Chromium command
order and handles its reply separately. The viewer receives loading state
while Chromium waits for the site. Stop reaches Chromium in that interval,
and the surface retains its last committed location. A deferred viewport or
capture restart is applied after the reply or Stop. Closing or replacing the
page drops its pending reply and releases the CDP request slot.
[Chromium stop-loading command](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-stopLoading)

The previous worker reached the fixture's stalled HTTP endpoint and timed
out waiting for the encrypted loading update. The macOS ARM64 regression
checks loading, a viewport change, Stop closing the pending HTTP connection,
the original page state, and subsequent protected navigation on the same
attachment. It uses the Rust server with PGlite, headless Chromium, and an
empty worker PATH. WorkerLink relay and the legacy WebSocket passed locally.
The relay run also passed whole-process and renderer recovery. The two
`cantrip-browser` unit tests, worker build, and formatting checks passed.

## 328. Restore the first live Browser viewer's viewport on resume

Reference commit `2edc8d22b0436d29ecfd124b10f92a4f3f7b4688` (#3491).

The Browser session preserves attachment order and uses the oldest live
viewer’s latest viewport on resume, matching the archived adapter’s ordered
attachment map. Detaching a viewer preserves the remaining order.

The previous worker intermittently failed to restore the first viewer's
704-pixel viewport after a second viewer set it to 768 pixels. The local
macOS ARM64 regression confirmed both widths through the actual Chromium
page. The updated worker restored 704 pixels on both WorkerLink relay and
the legacy WebSocket against Rust Core with PGlite and an empty worker PATH.
The relay run also passed Chromium process and renderer recovery. Worker
compilation, Rust and JavaScript formatting, and `git diff --check` passed.

## 329. Keep Cantrip OS viewer control after an empty clipboard read

Reference commit `513edca0cab10831f11cc923aae8f7e856963e02` (#3492).

After the assigned guest acknowledges the copy keystrokes, an `input-failed`
clipboard reply leaves the viewer’s existing input epoch and human
control lease usable. An explicit null text reply still maps to an empty
string as in the archived worker. Transport, authority, and input dispatch
errors take the existing retirement path.

The local regression set the selection owner to none in a disposable Linux
ARM64 guest. The previous macOS ARM64 worker failed to deliver the next
pointer move. The updated worker delivered that move under the same epoch,
then sent a subsequent Unicode clipboard reply. The public WorkerLink
smoke also passed exclusive control, held-key and button cancellation,
handoff, and guest desktop recovery. It used Rust Core with PGlite and the
existing guest image with `cantrip-os-remote` 0.11.0. Worker compilation,
Rust and JavaScript formatting, script syntax, and `git diff --check` passed.
[X11 selection ownership](https://www.x.org/releases/X11R7.6/doc/libX11/specs/libX11/libX11.html)
