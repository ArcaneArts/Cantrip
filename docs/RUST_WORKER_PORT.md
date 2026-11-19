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
| WorkerLink/direct/tunnels          | gateways/peer/WebRTC/direct broker, tunnel protection/routing/adapters                                                                    | Native framing/tunnel crypto; serving adapters pending                                                                                                                                                                                                                                                                                                                                                  | Existing frame fixtures plus actual ICE/TURN/WebRTC interoperability, bounded backpressure, stale grant/session and disconnect behavior                                                                                                                                                                                          |
| Browsers/surfaces/computer use     | browser/desktop adapters, remote surfaces, computer-use services, web service and managed Playwright/SearXNG                              | Native stream protection; execution/resources pending                                                                                                                                                                                                                                                                                                                                                   | Native replacements for Node driver/helpers; selectors/snapshots/input/capture/network restrictions; permission/approval revocation; no dropped features                                                                                                                                                                         |
| MCP/CLI/CodeGraph                  | `mcp/*`, CLI broker, computer-use MCP, codegraph/runtime/supervisor                                                                       | Pending                                                                                                                                                                                                                                                                                                                                                                                                 | Native stdio/HTTP helpers, generated/persisted launch commands, binding/generation scopes, CLI and managed-runtime fixtures                                                                                                                                                                                                      |
| Cantrip OS                         | `cantrip_os/host`, `os-executor/*`, native MCP/run execution                                                                              | Pending                                                                                                                                                                                                                                                                                                                                                                                                 | Port Node host orchestration, Docker/guest/lifecycle/files/PTY/tunnels/packages/backups/system/checkpoints; retain independent non-Node guest helpers                                                                                                                                                                            |
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
