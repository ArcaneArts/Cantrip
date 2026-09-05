# Cantrip Computer Use

Status: First-tranche implementation in progress; experimental preview and native
capture, managed MCP and shared agent observations implemented. Protected
operation Trajectory is implemented and locally verified, awaiting its PR merge;
final product/release verification remains incomplete.

## First-tranche implementation progress

The active first tranche is observation and a customizable logical cursor:
Rust process, worker service, encrypted server routing, client preview,
macOS snapshots, managed MCP, permissions, and Trajectory. Native input,
Accessibility actions, clipboard/file mutations, human event taps, Windows,
Linux, and cross-worker control remain later-tranche work. The full plan below
describes the larger architecture; its operation list is not a requirement to
implement later-tranche operations now.

### Tranche cycle 1 — Contracts and feasibility

- Branch: `codex/cua-01-feasibility`, based on `6b7df74b1`.
- PR: [#1733](https://github.com/ArcaneArts/Cantrip/pull/1733).
  Initial implementation commit: `3d1842785`; merged 2026-09-04 as
  `1e2da3de9f4ee08afb7b56b5e84b937606e4bf2b` (observed via GitHub).
- Implemented behavior: progress ledger and opt-in native/JavaScript
  [feasibility probes](../../scripts/cantrip-cua/feasibility/README.md).
  Product behavior remains unavailable; no startup or packaging changes.
- Validation: repository build, managed MCP, permission, encryption, and
  Trajectory seams inspected. Native fixture captured an occluded red window
  (256 × 192) in 122–137 ms. Distinct signed debug/optimized builds both captured
  successfully with equal designated requirements. A separate timestamped,
  hardened-runtime Developer ID fixture passed strict signature verification.
  JavaScript: five tests, release probe, formatting, and Clippy passed; persistent
  globals, absent ambient I/O, deadline, heap bound, and reset exercised.
- Platform: macOS only for native investigation; portable JavaScript probe.
- Manual verification: fixture native pixels verified on macOS 27 arm64.
  Parent-app TCC attribution, installed helper permission reuse across
  worktrees, and packaged update capture remain unverified.
- Risks: stable signing requirement alone does not prove TCC permission
  continuity; this must be exercised with the installed helper. JS engine
  limits do not bound native host calls or image memory.
- Decisions: focused objc2 ScreenCaptureKit bindings; macOS 14+ CUA snapshot
  capability (no app-wide minimum change); rquickjs 0.12.2 evaluator without
  host I/O/module loader. Production implementation remains subsequent work.
- Remaining tranche work: all production Rust, build, worker, server, client,
  native capture, MCP, permission, Trajectory, and end-to-end cycles.
- Deferred: all native input and mutations, other operating systems, and
  remote-worker desktop control.

Subsequent cycles record the preceding PR's observed merge commit. A cycle's
own final merge cannot be truthfully written before GitHub merges it; its PR
is the authoritative merge record until the next ledger update.

### Tranche cycle 2 — Rust process, sessions, fake capture, and cursor

- Branch: `codex/cua-02-rust-foundation`, based on merged cycle 1 (`1e2da3de9`).
- PR: [#1734](https://github.com/ArcaneArts/Cantrip/pull/1734).
  Initial implementation commit: `67019f00a`; merged 2026-09-04 as
  `c6982b46d2d7170d363ceb58cc9fbcdbeb4577ee` (observed via GitHub).
- Implemented: standalone `cantrip_cua` library/executable and lockfile; bounded
  raw-binary protocol; independent cancellation reader; serialized session
  ownership; explicit fake monitor/window backend; PNG observations with digest;
  versioned configurable logical cursor and deterministic raster renderer.
  Default native capability remains unavailable; no startup/build-chain changes.
- Validation: all 47 protocol, cursor, service, runtime concurrency, and
  actual-executable tests pass in debug and release; release build, focused
  Clippy, formatting, and Windows GNU target cross-check pass. Executable test
  completes handshake, target attach, configuration/movement, decoded PNG
  hotspot verification, close, and shutdown. Runtime tests prove in-flight and
  queued cancellation, EOF, saturation, and lost-output handling with real
  reader/executor/writer threads and no scheduling sleeps.
- Review fixes: unknown fields rejected for all operations; target-bound
  requests carry ID **and** generation to prevent wrong-target commands after a
  switch; lost stdout cancels native work; shared-target attachment preserves
  observer cursor state; resized targets discard invalid trail points.
- Platform: tests executed on macOS arm64 with deterministic fake pixels.
  Windows cross-compilation is compile evidence only, not Windows runtime QA.
- Manual verification: native pixels remain cycle-1 prototype evidence, not
  production Rust capture. Installed helper/Tauri permission reuse unverified.
- Known limitations: embedded bitmap cursor labels do not implement full text
  shaping; native adapters must cooperatively honor cancellation/deadlines.
- Remaining: build/package/smoke integration, worker service, protected server
  routing, client preview, native Rust capture, managed JS/MCP, approval and
  Trajectory wiring, full end-to-end verification.
- Deferred: native input/mutations, human event taps, Windows/Linux native
  backends, remote-worker control, continuous video, and arbitrary cursor assets.

### Tranche cycle 3 — Build chain, stable helper installation, and packaged smoke

- Branch: `codex/cua-03-build-chain`, based on merged cycle 2 (`c6982b46d`).
- PR: [#1735](https://github.com/ArcaneArts/Cantrip/pull/1735).
  Initial implementation commit: `e3f320d2`; merged 2026-09-04 as
  `9e8ded7d6ab403be29208a3124391752d4467098` (observed via GitHub).
- Implemented: root CUA build/check/test/smoke commands; Cargo-reported executable
  selection; worker and inherited desktop bundling; final-layout protocol smoke;
  explicit macOS signing identifiers; named user-data development installation
  independent from build/worktree paths. Signing configuration is retained across
  rebuilds, installation is OS-lock serialized, and failed signing/smoke preserves
  the prior executable. No worker runtime activation or native capture yet.
- Validation: 50 Rust tests and 24 CUA script tests pass; focused Clippy/format,
  release build, Windows GNU cross-check, and diff/large-file checks pass.
  Actual copied worker/desktop-layout smoke covers both fake targets, four cursor
  styles, binary PNG metadata/digest, deterministic repeat captures, and shutdown.
  The actual development CLI is exercised (including a fixed circular-import
  startup deadlock). Broad script run: 142/144 pass; the App Platform build-command
  assertion and network Tranche Two missing-test-name assertion also fail on
  unchanged Primary `c6982b46d`. They remain recorded baseline regression work,
  not claimed passing or silently bypassed.
- Platform: local macOS arm64 fake execution; added macOS/Windows/Linux CI matrix,
  macOS and Linux jobs passed in run `33927526148`; Windows Rust tests passed,
  but one script test incorrectly asserted POSIX execute bits on Windows.
  Follow-up cycle 3b corrects that host-specific assertion. Native capture
  remains only cycle-1 prototype evidence.
- Manual verification: named `cua-cycle-three-qa` development helper installed
  in native user data with Apple Development signing; debug and release builds
  both passed actual smoke with equal designated requirements. Developer ID
  final-layout helper passed strict signature verification and fake smoke
  (60 ms release sample, not a native capture benchmark). The named QA helper
  remains installed for subsequent native validation. Actual TCC reuse across
  worktrees and capture permission behavior remain cycle-7/end-to-end work;
  neither is implied by signing or fake smoke. A full app/DMG build was not run
  in this cycle; final-layout helper verification is not outer-app notarization.
- Risks: standalone worker release artifacts are not yet certificate-signed by
  their release job; desktop nested signing does not prove that separate path.
  Moving/translocating the installed outer app can change its absolute path.
- Remaining first tranche: lazy worker service and binary resolution; protected
  shared protocol/server routing; preview/customization UI; native Rust capture;
  persistent JS/managed MCP; durable approvals, Trajectory, and end-to-end audit.
- Deferred: native input and mutations, human event taps, Windows/Linux native
  capture, arbitrary cursor assets, continuous video, and cross-worker control.
- Developer/build/inspection/reset instructions:
  [CUA runtime README](../../cantrip_cua/README.md#stable-development-helper).

### Tranche cycle 3b — Installer lifetime and Windows test follow-up

- Branch: `codex/cua-03b-install-lifecycle`, based on merged cycle 3 (`9e8ded7d6`).
- PR: [#1736](https://github.com/ArcaneArts/Cantrip/pull/1736).
  Initial implementation commit: `49e4a4b7`; merged 2026-09-04 as
  `cbfa5df6d4f9308947bd485dc8d980caed323829` (observed via GitHub).
- Implemented: preserve lock-holder lifecycle observation after acquisition;
  cancel smoke and refuse subsequent commit steps after actual lock loss.
  Correct POSIX-mode test assertions to use the actual host platform while
  retaining cross-platform executable-name and copied-byte checks.
- Validation: 50 Rust tests, 26 CUA script tests, actual-binary smoke, focused
  Clippy/formatting, and diff checks pass locally. Actual-child lock-loss
  regression preserves prior binary/configuration; cancellation disposes active
  smoke processes. Independent focused review found no additional defects.
  CI run `33927937100` passed all macOS, Windows, and Linux CUA jobs.
- Platforms/manual status: macOS fake runtime locally and actual fake runtime
  execution in macOS/Windows/Linux CI. No new native capture or TCC claims.
- Risks/remaining: cycle-3 standalone-worker signing, baseline script failures,
  and first-tranche worker/server/client/native/MCP/policy/Trajectory integration
  remain unchanged. Deferred later-tranche work remains unchanged.

### Tranche cycle 4 — Lazy worker service and private process transport

- Branch: `codex/cua-04-worker-service`, based on merged cycle 3b (`cbfa5df6d`).
- PR: [#1738](https://github.com/ArcaneArts/Cantrip/pull/1738).
  Initial implementation commit: `b972ff20`; merged 2026-09-04 as
  `16218ed0d94d7bab4f2e8b5a69556392460f8223` (observed via GitHub).
- Implemented: inert worker service construction; actual framed handshake on
  first authorized use; immutable execution/account ownership; per-session
  serialized operations; raw PNG validation; immediate local scope revocation;
  cancellation with explicit unknown-outcome reporting; exactly one explicit
  crash restart without mutation replay or old-session revival. Worker interrupt,
  relocation, terminal disconnect/reconnect, and shutdown own lifecycle cleanup.
  No public routing, MCP access, native permission request, or Remote Desktop
  change is introduced.
- Build/development: module-relative packaged helper selection; explicit binary
  override; stable named-profile projection for browser/direct worker and desktop
  development; preserved tsx watch and exact orphan-process cleanup behavior.
  `pnpm cua:test:worker` and portable CI execute the actual worker/Rust boundary.
- Validation: 122 focused worker tests pass, including 11 real-Rust integration
  tests; 50 Rust and 30 CUA script tests pass; 13 existing development/profile
  tests pass; worker typecheck/build and CUA Clippy/format pass. Full worker suite
  initially reported 1,136 passes, 13 skips, and one goal-streaming timing failure
  (empty final text); that unchanged test passes in isolation on Primary. The
  complete rerun passed 1,137 tests with 13 expected skips (including the 11
  separately executed Rust-artifact tests). Final-head portable CI run
  `33929428361` passed all three platforms before auto-merge.
- Review fixes verified: synchronous launch failure is terminal; cancellation
  while awaiting a shared handshake/queued operation settles promptly without
  cancelling other callers; disconnect cannot publish a just-completed protected
  target inventory; completed-but-cancelled mutations cannot revive a session.
  Transport admission counts pending cancellation correlations and reserves
  16 additional slots for lifecycle cleanup, so cancellation saturation cannot
  crowd out Stop/session-close requests.
- Platform/manual: actual fake helper/service on local macOS arm64; macOS,
  Windows, and Linux worker integration CI passed. No product/native/TCC verification
  claimed; helper still defaults to unavailable native capture.
- Risks/remaining: encrypted shared routing, worker capability publication,
  client preview, native capture, persistent JS/MCP, durable approvals, protected
  Trajectory, and full end-to-end/packaged verification remain required.
  Turn-specific JS teardown awaits real runtime-turn ownership in the MCP cycle.
  Prior standalone-worker signing and baseline script failures remain open.
- Deferred: native input/mutations, human event taps, other native operating
  systems, arbitrary cursor assets, continuous video, and cross-worker control.

### Tranche cycle 5 — Shared encrypted contract and isolated routing

- Branch: `codex/cua-05-protected-routing`, based on merged cycle 4 (`16218ed0d`).
- PR: [#1739](https://github.com/ArcaneArts/Cantrip/pull/1739).
  Initial implementation commit: `9c8b442fe`; merged at
  `2026-09-05T00:02:16Z` as `0d23ecbae`. Primary fast-forwarded; only the
  cycle-owned worktree and branch were removed.
- Implemented: one browser-safe shared CUA schema; strict worker command/event
  contracts; endpoint-only control/result encryption and sequential 256 KiB
  screenshot chunks (16 MiB total); raw-byte adapters using existing component
  grants; server relay factory and worker handler with mandatory authorization
  and trusted execution ownership. No native-session tables or new key custody.
- Activation status: factory and handler are deliberately not installed in the
  production request dispatcher yet. Worker capability publication remains
  required with activation, not inferred from an OS name or helper path.
- Verified behavior: test client codec -> Fastify route -> worker handler ->
  lazy service -> actual Rust fake helper opens a session, configures all four
  cursor styles, moves, captures/decrypts/verifies PNG bytes, and closes. The
  server sees neither target titles/IDs, cursor labels nor pixels; it only
  accumulates bounded ciphertext for one response and discards its collector.
- Lifecycle: execution lifetime is supplied by the trusted runtime owner and
  spans pending authorization as well as native work. Revocation cannot let a
  delayed approval start a new helper/session. Scoped Stop skips operation
  approval, but still authenticates the sealed action and session ownership.
- Validation: 238 focused CUA/adapter tests pass across protocol (47), crypto
  (20), worker (127), server (39, including 12 real-Rust routing tests), and
  client (5). Full protocol (500) and crypto (60) suites pass; 16 focused
  client encryption tests pass; Rust (50), CUA scripts (30), Clippy, formatting,
  worker/server/app typechecks, server-boundary audit and large-file/diff checks
  pass. Full worker rerun passes 1,143 tests with 13 expected skips. Its first
  loaded run hit unchanged CodeGraph output and Codex stdin EPIPE races; both
  files pass on Primary and branch in isolation, and the EPIPE also reproduces
  synthetically on Primary. These remain final-hardening follow-ups, not CUA
  regressions hidden by skipped tests. Full server reported 794 passes and
  20 failing assertions/8 failed suites. Clean Primary reproduces all 26 common
  failure headings with the same leading cause (mostly existing database
  fixtures, catalog/label expectations and finite-timeout count drift). Two
  branch-only full-run timeouts (project placement and task dispatch) do not
  recur in rebuilt-dependency focused runs: both Primary and branch produce
  identical 34 passes/2 existing failures. The full server suite is therefore
  not claimed green; these baseline gaps remain final regression work.
  First portable CI run `33931195514` passed the Rust round-trip tests on all
  three platforms but exposed a missing logging-package build prerequisite in
  the new server test command; the command now builds its workspace dependencies
  explicitly. Final portable CI `33931458355` passed on macOS, Windows and Linux
  before auto-merge was enabled. Native capture, live app entry
  points, real policy prompts and MCP are not claimed by this factory integration.
- Sequencing decision: existing durable interactions are Codex RPC-owned and
  currently require a real native thread; they are not a generic CUA approval
  owner. Enabling a route using authentication or YOLO alone would omit the
  requested effective-policy behavior. Cycle 5b will therefore implement the
  permission/trusted execution prerequisite from original tranche cycle 9
  **before** exposing the client preview. It must preserve genuine nullable
  idle thread/turn identity, avoid fabricated IDs, preserve ordinary chat
  approval/status behavior, and wire cancellation leases to real lifecycle
  events. This is a scoped sequencing change, not a second approval system.
- Transport limitation: current worker event delivery is best effort across
  disconnects. The authenticated final manifest rejects missing, duplicate,
  reordered, substituted or wrong-revision chunks; it does not replay failed
  mutations or claim resumable image delivery. No WorkerLink/Remote Desktop
  changes or global WebSocket limit increases are introduced. The HTTP request
  has a bounded deadline; HTTP disconnect does not yet cancel worker requests.
- Remaining first tranche: production policy/ownership activation and capability
  publication; client preview; native inventory/capture; persistent JS/MCP;
  protected Trajectory; real macOS/packaged end-to-end verification. Native
  inventory must respect the existing 64 KiB response-header budget. Previously
  noted standalone-worker signing and unrelated baseline script failures remain.
- Platform/manual: local macOS fake process and three-platform fake CI passed. No OS privacy
  prompt, screen access, profile or native key access occurs in this test suite.
- Deferred: native input/mutations, human event taps, other native operating
  systems, arbitrary cursor assets, continuous video and cross-worker control.

### Tranche cycle 5b — Durable computer-use permission owner

- Branch: `codex/cua-05b-durable-approvals`, based on merged cycle 5 (`0d23ecbae`).
- PR: [#1740](https://github.com/ArcaneArts/Cantrip/pull/1740).
  Initial implementation commit: `e9589426b`; merged 2026-09-05 as
  `5e18d1c104fe919927d3c743451af131bdaf590c` (observed via GitHub).
- Implemented: an explicit `computer-use` owner in existing durable agent
  interactions; a versioned migration adds owner metadata and allows genuine
  null native thread/turn identity for CUA permissions. No new session tables,
  encryption profiles, grant formats or key custody. Historical absent-owner
  Codex JSON and ciphertext remain unchanged; its real thread requirement and
  waiting/running restoration remain in force. CUA create, resolve, expiry and
  interruption never rewrite the chat's runtime status.
- Worker policy maps inventory, capture and logical cursor operations onto the
  existing selected/effective profile. Exact selected YOLO requires no extra
  approval, including Primary's effective read-only override for this
  non-filesystem/non-native-input tranche. Other selections use the existing
  protected permission interaction; capability discovery and scoped Stop do not
  prompt. There is no application blocklist or connectivity preflight.
- The inert approval manager seals requests and opens replies using existing
  `interaction-content` grants. It coalesces exact requests, binds grants to
  account/server/worker/chat/lane/profile/target-generation/execution lease,
  expires pending requests after five minutes, and bounds pending requests (32),
  grants (64) and exact-response receipts (128). Denial grants nothing; retries
  never replay native operations or replenish consumed one-use grants. Idle
  preview requests show **Grant once**, not a fabricated turn. Active native
  turns retain their actual identity and the existing turn button.
- Server response routing validates current account/chat/worker/lane and routes
  the encrypted reply to the originating worker without selecting a model or
  Codex RPC. Durable resolution follows worker acknowledgment. A bounded worker
  receipt handles an exact retry after a database-write failure; it never treats
  arbitrary modified response bytes as the same approval. Interrupted/stale
  approvals report bounded errors. Existing Codex response paths are preserved.
- Lifecycle verified in isolation: cancellation during seal/open, direct expiry
  checks after asynchronous work, chat/thread revocation, terminal disconnect,
  shutdown, stale target/profile/lease rejection, and Stop after revocation.
  Production construction and response dispatch are installed and inert; native
  operation routing is still deliberately unregistered. The next activation
  pass must own trusted leases, publish/terminalize durable requests, and abort
  them on actual turn completion, policy/lane change and preview Stop. This
  prerequisite does not claim that a live preview or MCP is already available.
- Validation: 346 focused tests pass (protocol 58, crypto 20, worker 186,
  server 68, client 14), including actual Rust fake routing, 9 real PGlite
  migration/lifecycle tests and historical Codex response/JSON compatibility.
  Migration rollback is exercised after each of its three statements; all 89
  existing tables remain. Full protocol: 516 passes; full worker: 1,202 passes,
  13 expected skips (the artifact-dependent CUA cases run in the focused suite).
  Rust: 50 passes; CUA build/smoke scripts: 30 passes. Worker/server/app
  typechecks, worker build, Clippy, Rust and
  touched-file formatting, large-file check and server-boundary audit pass.
  Portable CI run `33932973259` passed on macOS, Windows and Linux before
  squash auto-merge. The existing server
  local-foundation provider-fixture failure was reproduced unchanged on Primary
  before interaction assertions; full-suite baseline gaps recorded above remain
  final-hardening work, not a claim of a green whole-repository suite.
- Platform/manual: synthetic encrypted permissions and macOS fake-process tests
  only. No native capture, Screen Recording prompt, real profile/key access or
  live UI approval was performed. Portable fake CI exercised these same
  boundary tests on macOS, Windows and Linux; it is not native capture evidence.
- Remaining first tranche: trusted production activation/capability, preview,
  native inventory/capture, persistent JS/MCP, protected Trajectory, signing and
  end-to-end/manual performance verification. Earlier signing and baseline-test
  risks remain. Later native input, other native platforms, arbitrary cursor
  assets, continuous video and cross-worker control remain deferred.

### Tranche cycle 5c — Trusted preview lifetime and production routing

- Branch: `codex/cua-05c-preview-authority`, based on merged cycle 5b
  (`5e18d1c10`). PR: [#1741](https://github.com/ArcaneArts/Cantrip/pull/1741).
  Initial implementation commit: `81f2b8a42`; merged at
  `2026-09-05T01:11:07Z` as `3a5628d234933b1d10278b4ee7a044f45a93323e`.
  Primary fast-forwarded; only the cycle worktree/branch were removed.
- Implemented: production preview/open/Stop routes and encrypted operation
  dispatch through the same agent worker, one inert worker-owned preview lease
  per chat, and actual selected/effective permission policy. Native helper
  construction and preview opening do not launch a process or prompt. Existing
  durable protected interactions carry requests and replies; an approval never
  automatically replays an action. Selected YOLO adds no CUA confirmation.
- A preview is a real client actor with null task/thread/turn/lane fields, not
  an invented native execution. Its lifetime follows worker, chat, account,
  placement and permission authority. Ordinary agent turns, status, messages
  and reused execution-lane IDs do not restart it. Multiple observers receive
  the same active lease. Stop, chat interruption, terminal disconnect, shutdown
  and authority changes invalidate the lease, operations and approvals. Stop
  remains routable after chat archival or placement changes.
- Requests, result manifests and individual image chunks are authenticated to
  the random preview lease as well as the existing endpoint context. Reopening
  cannot reuse an old encrypted action or grant. Strict shared control schemas
  contain no public target titles, cursor labels or pixels. Existing historical
  protocol export/discriminator baselines remain unchanged outside explicit CUA
  additions.
- Migration 0199 adds only a chat authority generation, not a native-session
  table. Narrow transactional triggers advance it for permission, inherited
  default, placement and archive changes, including A-to-B-to-A transitions;
  no-op writes and ordinary turn activity leave it alone. Post-commit database
  notifications deliver best-effort scoped interruption across server instances.
  The generation remains the next-request fence if notification delivery fails;
  there is no claim of instantaneous cancellation across a network failure.
- Review fixes: real PostgreSQL reproduced a project-policy/turn-start lock
  inversion (`40P01`). The production lock now uses a materialized project-lock
  dependency before locking its chat, in one statement; the same harness runs
  the old failure and verifies the actual replacement SQL. Post-commit
  notification delivery/rollback/deduplication/unsubscribe are also tested on
  PostgreSQL and PGlite. Notifications carry only owner/scope IDs, use bounded
  coalesced delivery, and never hold an ordinary committed mutation open for
  an offline worker.
- A real two-instance coordinated-relay test reproduces Stop notification
  delivery before its approval event and during the approval insert. The
  request-origin server now subscribes before dispatch and orders standalone
  terminal notifications behind already-active scoped commands and inserts.
  The bounded completion registries hold no protected payloads, add no RPC or
  polling, and do not evict an insert merely because HTTP timed out. Ordered
  same-command terminal events do not wait on their own completion. Live
  updates retain the captured account owner.
- Integration tests exercise the actual preview and operation route factories,
  worker coordinator, permission manager, Rust fake subprocess and client AEAD:
  target inventory, window attachment, cursor configuration/movement, PNG
  digest/pixels, generation invalidation, ordinary-turn stability and Stop.
  The client UI, production macOS backend and MCP are not implemented by this
  pass. The default Rust backend still reports unavailable truthfully.
- Validation: 472 focused tests pass (protocol 68, crypto 24, worker 219,
  server 147, client 14), plus 2 real PostgreSQL tests run independently on an
  isolated local cluster. The ordinary runner skips those two without an
  explicit dedicated database URL; a dedicated PostgreSQL CI job runs them.
  Full protocol 536 passes, crypto 64 passes, full worker
  1,234 passes / 14 expected skips; the artifact-dependent preview test passes
  against the actual Rust binary separately. Rust 50 and script 30 tests pass;
  Clippy/format, worker/server builds, worker/crypto/app/server typechecks,
  server-boundary audit and repository decomposition check pass. Final-head CI
  run `33935269532` passed all three portable jobs and PostgreSQL 16 authority
  verification before squash auto-merge. Prior whole-server baseline gaps remain tracked
  final-hardening work, not a claim that all repository tests are green.
- Platform/manual: synthetic keys, encrypted fixtures and the fake backend
  only; no user key access, native Screen Recording prompt, live preview UI or
  real screenshot was exercised. Portable fake CI passed on all three platforms.
- Remaining first tranche: client preview/capability presentation, native
  inventory/capture, managed bounded JS/MCP using actual runtime identity,
  protected Trajectory, standalone release signing, full regression and native
  end-to-end/performance/manual verification. The later native-input/platform,
  custom-asset, continuous-video and cross-worker scope remains deferred.

### Tranche cycle 6 — Encrypted client preview and shared cursor

- Branch: `codex/cua-06-client-preview`, based on merged cycle 5c
  (`3a5628d23`). PR [#1742](https://github.com/ArcaneArts/Cantrip/pull/1742),
  implementation commit `c6824fec969d8a1c6c6edab3ec7da95bb2e8e0a7`.
  Squash auto-merged 2026-09-05 as
  `86322d280bf5a2d1f8f40c2e5ebfad4813ef77b0` (observed via GitHub).
  Final-head CI run `33937234829` passed all four macOS/Windows/Linux fake
  capture and PostgreSQL authority jobs before auto-merge. Primary was
  fast-forwarded; only this cycle's clean worktree/branch were removed.
- Implemented: reachable experimental preview above both project and standalone
  chat transcripts; actual worker capability request, monitor/window inventory,
  attach/detach, snapshots and customizable logical cursor. Click coordinates
  use the displayed image and target-local bounds, not desktop origin or device
  pixel ratio guesses. Keyboard direction controls never inject OS input.
  Applying appearance or moving the cursor requests fresh cursor-baked pixels.
- Client lifetime: pinned server/account incarnation, encrypted key revision and
  preview lease; validated AEAD scope/chunks/result binding; cleared temporary
  buffers and revoked object URLs. Close affects only this observer. Account
  switching cancels/clears it; encryption lock clears pixels but preserves Stop.
  Stop bypasses an in-flight operation and retains its exact lease on failure.
  Explicit reconnect obtains a new lease. Open/operations have a 35-second
  deadline; Stop has an independent 30-second deadline. No polling/replay added.
- Multiple observers reuse one serialized native session per preview lease;
  repeated panel reopen no longer allocates new sessions until capacity is hit.
  Scope validation remains in the worker service. Failed/cancelled native state
  is not silently replaced; explicit Stop/reconnect is the recovery path.
- Existing durable approvals are reached through **Review approval in chat**;
  reopening and retrying remain user actions. The generic API client gained an
  opt-in authenticated lifetime binding so delayed 401/CSRF responses from a
  previous account cannot sign out or replay work into the new account. Existing
  unbound API semantics remain unchanged.
- Validation: 610 focused tests pass (protocol 68, crypto 24, worker 224,
  server 149, client 145). The two explicit PostgreSQL authority tests skip
  without their isolated database URL and remain a dedicated CI job. New real
  app-client → Fastify → worker → Rust fake integration verifies cursor pixels,
  20 shared observers, encrypted non-YOLO approval and explicit retry. App,
  worker and server typechecks/builds pass. Full worker: 1,239 passes and 14
  expected skips; full app: 2,216 passes, 3 skips and the one reproduced settings
  baseline failure below. Server boundary audit and large-file check pass.
  Rust 50 tests, CUA script 30 tests, Clippy and touched-file formatting pass.
  PR/CI results are recorded when observed.
- Browser QA: actual product panel through encrypted fixture routing and real
  fake subprocess. Observed 640 × 360 monitor and 320 × 200 window images;
  arrow/crosshair/ring/dot, RGBA, size, label, trail, image click, Stop and explicit
  reconnect. At 390 × 844, dialog client/scroll width both 345; image
  279 × 174.375 preserves aspect ratio. Invalid size 97 disables Apply; 8 works.
  QA report: 7 pass checkpoints, 50 informational events, no failures. Synthetic
  keys/pixels only; no production profile/key, TCC prompt or native capture.
- Known baseline failures reproduced on unchanged Primary: account settings
  search expects removed `project-membership`; decomposition budgets are exceeded
  by `chat-turn-runtime.ts` (2124 vs 1999) and `task-routes.ts` (2149 vs 1999).
  These join earlier whole-suite gaps for the final hardening cycle; they are not
  bypassed or reported as green. Existing build chunk-size warnings remain.
- Platforms: responsive browser QA on local macOS; shared desktop/browser client
  code, portable fake tests. Packaged Tauri, iOS/Android and real macOS capture
  remain unverified. No direct Tauri invocation or RemoteDesktop change.
- Remaining first tranche: production macOS inventory/capture, bounded persistent
  JS/managed MCP with actual agent identity, preview/MCP session coordination,
  protected Trajectory, standalone release signing, full regression/performance
  and native installed/packaged verification. Native input, Accessibility,
  clipboard/files, other native platforms, custom cursor assets, continuous
  video and cross-worker control remain deferred.

### Tranche cycle 7 — macOS target inventory and native snapshots

- Branch: `codex/cua-07-native-capture`, based on merged cycle 6 (`86322d280`).
  [PR #1743](https://github.com/ArcaneArts/Cantrip/pull/1743), implementation
  commit `6f913c84357aeade38427a6ed5caba31fe1a6276`, ledger commit
  `c22ad19b9e207bc01a0ea0161373da3343d224f0`; squash-merged on
  2026-09-05 as `76d8baa7ce235c529088f26c49b49892b85be2d5`. All four CUA
  macOS/Windows/Linux/PostgreSQL jobs and twelve managed-web-runtime jobs passed.
  Primary fast-forwarded cleanly; the cycle worktree and branch were removed.
- Current work: ScreenCaptureKit backend, explicit bounded-inventory disclosure,
  portable fake/default-handshake tests, and fixture-owned native capture QA.
- Native QA exposed and fixed a real helper crash: `CGS_REQUIRE_INIT` asserted
  because CoreGraphics had not been initialized before constructing a window
  filter. Public `CGMainDisplayID()` now initializes it on the original main
  thread; its return value does not gate capture. A prior zero-frame validation
  patch alone did not fix the assertion. Empty/invalid native rectangles are
  still rejected before creating a filter, with a focused regression test.
- The same signed development helper now enumerates real targets and produces
  a decoded 1920 × 1080 monitor snapshot in the actual product panel through
  the encrypted client/server/worker fixture route. Custom crosshair, RGBA,
  size, label, trail and logical movement produced subsequent snapshots.
  No production account, encryption profile or server database was changed.
- The owned native fixture exposed a separate short-pipe-read issue: Foundation
  waited to fill the pipe read, preventing short control messages from being
  handled. Bounded POSIX reads fixed it; all 13 explicit fixture IPC checks pass.
  Cross-process window capture still returns ScreenCaptureKit `-3811` and the
  occlusion matrix is not verified. AppKit initialization, minimal capture
  settings and explicit asynchronous input retention did not resolve that error.
  The input-retention fix remains for correct native object ownership; unrelated
  configuration experiments were removed.
- A fixture-only diagnostic independently confirmed WindowServer reports the
  inactive fixture as 288 × 216 while AppKit reports 320 × 240. The decisive
  subsequent check was `CGSessionCopyCurrentDictionary`: `screenLocked=1`.
  ScreenCaptureKit itself returned zero displays, not a display rejected by our
  catalog. Fixture activation experiments were removed; the user was asked to
  unlock the desktop for further native QA. This is diagnostic evidence, not a
  new lock-state preflight in production. No lock-screen or permission bypass,
  automatic permission reset, identity switch or monitor fallback was added.
- Inventory now reads native metadata without constructing filters for every
  unrelated window. It checks cancellation between entries and reports a bounded
  nominal 1x inventory raster; selected capture alone creates a filter and
  refreshes actual output geometry and scale. This reduces unnecessary native
  work; it is not claimed as the cause of the locked-session capture failure.
- Failed native, transport, decryption/schema and image-creation snapshots clear
  old preview pixels without replay. An older cancelled request cannot clear a
  newer observation. Focused controller/component tests: 32 passed.
- ColorSync display UUID is optional additional incarnation evidence, not a
  prerequisite for capturing a valid native display. A registry regression
  verifies metadata stability and disappearance invalidation without a UUID.
- Local validation: 66 Rust tests; formatting and all-targets Clippy with denied
  warnings; 43 script tests (one explicit GUI test skipped); 641 focused
  protocol/crypto/worker/server/client tests (two PostgreSQL checks reserved for
  dedicated CI); app/worker/server typechecks and builds. Release helper install,
  strict Apple Development signature verification, equal designated requirement
  across rebuilds, and the installed executable's actual fake smoke passed.
  Equal signing requirements do not establish native permission continuity.
- Manual QA artifact ledger records five pass checkpoints, one native-window
  failure and one locked-desktop warning. Existing full-suite failures remain
  recorded under cycle 6/final hardening; no failing native QA is reported green.
- Native permission denial, target closure, Retina, complete occlusion coverage,
  release rebuild and permission continuity are not yet verified. The earlier
  three-monitor route checks decoded 1920 × 1080 PNGs and exercised negative
  origins; they did not independently verify desktop pixel content. All three
  observed native monitor scale factors were 1, not Retina evidence.
- Remaining first tranche: native capture verification, managed MCP/persistent
  JS, preview/MCP coordination, protected Trajectory, release signing and full
  regression/performance verification. Later-tranche deferrals are unchanged.

### Tranche cycle 8a — Runtime execution lifetimes and preview isolation

- Branch: `codex/cua-08a-execution-lifetimes`, based on merged cycle 7
  (`76d8baa7c`). [PR #1744](https://github.com/ArcaneArts/Cantrip/pull/1744),
  implementation commit `0aa1b1e1b8e1387a00b5109b55930f7ee8c90664`.
  Ledger/CI commits `0fa652c0b` and `eea02a1fc`; squash-merged on
  2026-09-05 as `42fa6e9b076718fffbff0d8a0e9a74f575ebdaac`.
  Primary fast-forwarded cleanly; the cycle worktree and branch were removed.
- Scope: runtime-derived root/child execution ownership and cancellation, plus
  preview-specific teardown that cannot revoke a different agent lifetime.
  Managed MCP activation and the bounded Rust JavaScript engine are subsequent
  independently mergeable parts of cycle 8, not implemented by this entry.
- Exact-scope service cancellation now treats null task/thread/turn IDs as
  values, not wildcards. Approval revocation can release one authority signal,
  including its pending requests, grants and completed-response records.
  Ordinary preview teardown releases only its native scope and signal;
  explicit Stop, trusted policy/placement changes and chat interruption retain
  their intentional chat-wide cancellation. A stale Stop cannot cancel a newer
  lease. Actual Rust fake-backend tests verify a same-chat agent session remains
  usable after ordinary preview cleanup.
- The runtime resolver is read-only: it derives root/child ancestry from native
  runtime ownership and does not invent account, server, task or execution-lane
  identity. Only native turn starts establish cancellation lifetimes; caller
  claims and telemetry cannot create authority. Terminal, interruption,
  replacement and process shutdown cancel captured signals.
- Event-ordering regressions are fixed alongside that ownership primitive:
  delayed old completions/start acknowledgements cannot cancel or rewind a newer
  root/child turn, genuine new child starts advance UI activity, and obsolete
  asynchronous workspace/reconciliation/goal reads cannot overwrite the new
  turn's state. Native thread closure/unloaded/error events end the current
  thread lifetime even without a turn-completed event; those native statuses
  carry no turn ID and are explicitly treated as thread-level authority.
- Pre-activation requirement: the upcoming MCP coordinator must register every
  active agent lifetime, including YOLO without an approval or preview record,
  and receive trusted Stop/policy revocations directly. Session cancellation
  alone must not allow that still-live execution to open another session.
- Local validation: 755 cross-boundary tests passed (76 protocol, 24 crypto,
  348 worker including 23 new runtime-lifetime tests, 149 server and 158 client);
  two PostgreSQL cases remain dedicated-CI checks. Seventeen additional runtime
  regression tests, 66 Rust tests, Rust formatting/strict Clippy, 43 script tests
  (one explicit GUI test skipped), worker typecheck/build and diff/format checks
  passed. The root CUA test command now includes runtime-lifetime and existing
  app-server/subagent regression suites; native-CUA CI path filters include
  their source and tests. Actual helper tests used the fake
  backend; no native capture or permission changes occurred in this cycle.
- Platform status: macOS/Linux portable CI and PostgreSQL CI passed. Windows
  compiled the helper and passed the new lifecycle/CUA tests, but six existing
  app-server test expectations failed because they hard-coded Unix absolute
  paths or separators. Those tests were newly included in the CUA matrix by
  this pass. GitHub accepted `--auto --squash` immediately because these checks
  are not required merge rules; the failure was observed after the merge request.
  Cycle 8a2 fixes the fixtures before further product integration. For subsequent
  passes, wait for all running CI results before requesting auto-merge; no
  repository protection setting was changed. Existing whole-suite baseline gaps and
  release/manual checks remain final-hardening work, not claimed green here.
  Unlocked native window/occlusion QA remains outstanding;
  the desktop was confirmed locked during cycle 7 and the user was asked to
  unlock it. No native permission or lock-setting changes are authorized here.
- Later-tranche input, Accessibility, clipboard/files, other native platforms,
  continuous video and cross-worker control remain deferred.

### Tranche cycle 8a2 — Portable runtime regression fixtures

- Branch: `codex/cua-08a2-portable-runtime-fixtures`, based on merged cycle 8a
  (`42fa6e9b0`). [PR #1745](https://github.com/ArcaneArts/Cantrip/pull/1745),
  implementation commit `afb9e7c50f7e8f94735f72848ea9fcfed0cf49d8`.
  Merged at 2026-09-05T03:43:41Z as
  `2767e948ab407b96df1d8643e8d18c689fd8dda8`.
- Correct six pre-existing runtime test expectations to use the host's native
  resolved root and path separators, matching the unchanged runtime's Node
  path semantics. Preserve exact sandbox roots, policy flags, file previews and
  all enabled tests. No production behavior or CI skip is changed.
- Local validation: 102 focused runtime tests and the full 755-test CUA
  boundary matrix passed; two PostgreSQL cases remain dedicated-CI checks.
  Worker typecheck, changed-file formatting and diff checks passed.
  Actual Windows/macOS/Linux and PostgreSQL CI all passed on the final PR head
  before squash auto-merge was requested. Primary was fast-forwarded and only
  this cycle's clean worktree/branch were removed. Managed MCP,
  JavaScript, native unlocked-window QA, Trajectory and final hardening remain
  first-tranche work; all later-tranche deferrals remain unchanged.

### Tranche cycle 8b — Bounded JavaScript and worker-authorized host calls

- Branch: `codex/cua-08b-bounded-javascript`, based on merged cycle 8a2
  (`2767e948a`). [PR #1746](https://github.com/ArcaneArts/Cantrip/pull/1746),
  implementation commit `09a4cab1b657cf748eef47792e15cadbded1762e`.
  Merged at `2026-09-05T04:21:45Z` as
  `fb0111e2ab5eb024061105dcbe02f99cd9397cdc`. Primary fast-forwarded;
  only the cycle-owned worktree and branch were removed.
- Scope: persistent, bounded Rust JavaScript contexts and a payload-free host
  rendezvous through the existing worker-owned process. No managed MCP tool is
  enabled in this pass. Native input, filesystem, network, clipboard and extra
  platform capture remain excluded.
- Worker contexts bind to the exact canonical server/account/worker/chat/task/
  thread/turn and actual runtime lifetime signal. The worker retains validated
  PNG bytes outside JavaScript, authorizes each supported host action, and
  tracks lifetime revocation independently from preview/native-session/approval
  existence. Reset disposes variables and attachment, not turn authority.
- Implemented the frozen observation/cursor API with top-level await and lexical
  persistence using pinned `rquickjs 0.12.2`. Four engines have bounded heap,
  stack, source, result, host-call, job, active-execution and wall-time budgets.
  Finalizers, shared-memory waits and ambient I/O are unavailable. Idle engines
  block on commands; native capture remains on its existing executor. No script
  or serializer may leave jobs/host calls for a later evaluation.
- Reset acknowledgments retain capacity until cleanup actually completes;
  transport reserves 20 cleanup slots alongside 16 ordinary correlations.
  Late attachments close their orphaned native session. Failed/canceled or
  over-budget snapshots are cleared from worker buffers. Per-call cancellation
  disposes state without accidentally revoking the whole still-live turn.
- Local validation: 815 CUA boundary tests passed (76 protocol, 24 crypto,
  408 worker, 149 server, 158 client); two PostgreSQL cases await dedicated CI.
  The worker count includes 36 JavaScript ownership/process/lifecycle cases and
  43 framing/transport cases. All 79 Rust tests passed, including ten real-child
  JavaScript tests; strict all-targets Clippy and Rust formatting passed.
  Script tests: 43 passed, one explicit native-GUI skip. Worker typecheck/build,
  release Rust build and exact-release-binary fake smoke (eight snapshots, all
  cursor styles), changed-file formatting and diff checks passed.
  Initial cross-platform CI stopped at a Rust 1.95 `collapsible_match` lint;
  PostgreSQL passed. Follow-up `b9058e55993cbef5c47453df1fa3271536510daa`
  uses the equivalent match guard. Local strict Clippy and all 79 Rust tests
  also pass on the exact CI toolchain, 1.95.0. Final-head CI run `33944184455`
  passed macOS, Windows, Linux and PostgreSQL before auto-merge was requested.
  Real native unlocked-window QA remains pending;
  this pass does not request Screen Recording or change helper identity. The
  subsequent managed-MCP pass must connect actual turn provenance, durable
  approval waits, cancellation and protected image redaction before activation.
- Remaining first-tranche work: managed
  MCP, protected Trajectory, native/window/release QA and final hardening.
  Later-tranche deferrals remain unchanged.

### Tranche cycle 8c1 — Current agent authority, approval waits, and image redaction

- Branch: `codex/cua-08c1-agent-authority`, based on merged cycle 8b
  (`fb0111e2a`). [PR #1747](https://github.com/ArcaneArts/Cantrip/pull/1747),
  implementation commit `ecea7a7690de4d0f7a0f7c8dc8e1d9be618589ab`.
  Squash-merged at `2026-09-05T04:50:16Z` as
  `08dd5919c8ca8cd31f25142f16aea45d7107bac7`. All four macOS, Windows, Linux
  and PostgreSQL jobs passed in CI run `33945484818` before auto-merge.
  Primary was synchronized and the clean cycle worktree was removed.
- Scope: prerequisites for managed MCP activation. The server exposes a
  worker-authenticated CUA authority route using the existing agent-tools
  credential scope. Every request reads current durable placement and selected/
  effective policy. It does not accept client policy claims, follow another lane,
  infer a native turn from server UI status, cache permission, or probe native
  readiness. The worker client snapshots its attachment before awaiting the
  response and composes caller cancellation with a bounded request deadline.
- Approval waits resume the original suspended action after its exact protected
  request is published and approved. Denial, expiry, publication failure,
  revocation and per-call cancellation settle it without replay. A raced approval
  cannot leak a grant from a failed publication. Stop does not consume a waiter.
  Existing preview approval/retry remains a separate, preserved path.
- Raw Trajectory capture omits nested MCP image and typed-binary payloads while
  leaving the actual model result unchanged. Ordinary text is not classified as
  image data merely because it resembles base64. No second pixel audit store.
- Activation: no agent-facing tool is enabled by this cycle. The next pass must
  connect the actual root/child runtime turn, all-lifetime Stop/revocation,
  dedicated durable event publication, MCP metadata/cancellation, model-sized
  image output and CUA-only approval-compatible deadlines before activation.
- Validation: 885 focused CUA boundary tests passed (76 protocol, 24 crypto,
  457 worker, 170 server, 158 client); two PostgreSQL cases await dedicated CI.
  The server cases include the real worker HTTP authority client. All 552
  protocol tests and 79 Rust tests passed; Rust 1.95 strict all-targets Clippy
  and formatting passed. Script tests: 43 passed, one explicit native-GUI skip.
  Worker/server typecheck and builds, changed-file formatting, large-file and
  diff checks passed. The reviewed server boundary inventory adds only the
  credential-protected authority route and its metadata classification; its
  regenerated audit passes. Review found and fixed publication/admission and
  final-response cancellation races with deterministic regressions.
- Platform/manual: portable fake execution passed on macOS, Windows and Linux;
  PostgreSQL authority CI passed. Local native execution in this pass uses the
  deterministic fake backend, not unlocked-window capture.
  No Screen Recording prompt, native GUI action, helper identity change or
  new native platform support is part of this pass. Existing unlocked-window,
  packaged signing/permission continuity and final regression work remain open.
- Remaining first-tranche work: managed MCP activation and end-to-end tests,
  protected operation Trajectory, native/window/release QA and final hardening.
  Native input, Accessibility, human event taps, clipboard/filesystem mutations,
  other native operating systems and cross-worker control remain deferred.

### Tranche cycle 8c2 — Managed MCP activation and model images

- Branch: `codex/cua-08c2-managed-mcp`, based on merged cycle 8c1
  (`08dd5919c`). This is the recovered interrupted worktree.
  [PR #1748](https://github.com/ArcaneArts/Cantrip/pull/1748), implementation
  commit `8087c9c2`, ledger commit `772d4cb1c`, and Windows fixture correction
  `5e03389c5`. Squash-merged at `2026-09-05T10:46:25Z` as
  `281a4a1732a0d005fc633bf6b04959c3d75d5beb`. Final CI run `33961418395`
  passed macOS, Windows, Linux and PostgreSQL before auto-merge was requested.
  Primary was synchronized; the clean cycle worktree and local branch were removed.
- Implemented: dedicated worker-managed `cantrip_cua` tools `js` and `js_reset`
  through the existing authenticated broker and sole `CantripCuaService` owner.
  Actual Codex thread/turn metadata selects an observed root/child lifetime;
  tool arguments cannot invent execution authority. Protected chat and direct
  Task contexts receive the managed host. Older dispatches without trusted CUA
  authority retain ordinary behavior without that host. Host startup does not
  launch Rust; the first actual operation performs the required handshake.
- Current authority: server dispatch carries the durable generation and selected/
  effective profile, including whether the selection inherits the default.
  Both project and standalone lane acquisition return that real generation.
  Every operation refreshes authority through the authenticated server route;
  host actions recheck it after approval. Stop/revocation fences a registration
  before its first call and after reset, including YOLO with no approval record.
  Child teardown uses actual runtime ancestry and preserves unrelated roots.
- Durable approvals use the existing protected computer-use interaction owner
  and the originating command stream. Terminal events follow request insertion,
  and the server validates chat/worker/project/lane provenance without rewriting
  the native thread or routing the reply to Codex CLI approvals. Failed terminal
  publication cannot permanently retain registration capacity.
- Images: actual MCP image blocks, strict PNG/digest/dimension validation, two
  images and 16 MiB aggregate native input. Valid PNGs up to 2.5 MiB are preserved;
  larger images resize once to at most 600,000 pixels, without crop/enlargement.
  Model output is bounded at 2.5 MiB/image, 5 MiB total and the actual 8 MiB MCP
  JSON-RPC line. Native metadata stays separate from model rendition dimensions.
  Four encoder jobs retain their capacity through cancellation until native work
  settles. Temporary byte buffers are cleared; raw Trajectory still omits pixels.
- Deadlines: CUA-only trusted 345-second JS wall budget permits the five-minute
  approval wait, within 360-second broker and 370-second Codex tool deadlines.
  The two-second active JS budget remains unchanged. Generic MCP retains its
  512 KiB/55-second limits; worker-internal JS defaults to 45 seconds.
- Local verification: 995 focused CUA boundary tests passed (96 protocol,
  24 crypto, 535 worker, 182 server, 158 client); two PostgreSQL tests remain
  dedicated-CI checks. Actual compiled Rust -> worker coordinator/service ->
  authenticated broker -> real MCP stdio returns decoded PNG images and proves
  persistence/reset, root/child isolation, encrypted approval/denial, stale
  authority and Stop. The real PGlite dispatch harness verifies selected/inherited
  policy and both project/standalone acquired generations. All 572 protocol,
  85 Rust, and 44 CUA script tests pass; one explicit GUI script test skips in
  the ordinary runner. Strict Rust 1.95 Clippy/format, worker/server builds and
  typechecks, release build and exact-release fake smoke (eight snapshots, four
  cursor styles), route-boundary audit and large-file check pass. Real Sharp tests
  cover aggregate input/output bounds and cancelled-job capacity; packaged
  verification resolves Sharp from the final worker dependency layout.
- CI correction: the initial Windows run exposed a test-only `file:///worker`
  URL without a drive letter. The fixture now builds its URL from the host's
  resolved path. Production transport behavior and assertions are unchanged;
  the final four-job run above passed with that correction.
- Broad worker run: 1,443 passed, 36 skipped, three goal-streaming failures.
  The same three failures reproduce on unchanged Primary `08dd5919c` and in
  the branch's isolated goal-streaming file; no whole-worker green claim.
  App decomposition still exceeds the recorded baseline budgets:
  `chat-turn-runtime.ts` is now 2,156 lines (Primary 2,124; budget 1,999), and
  unchanged `task-routes.ts` is 2,149. These remain final-hardening work.
- Native retry: the existing Apple Development-signed stable
  `cua-cycle-three-qa` helper completed handshake/inventory but its first owned
  fixture-window snapshot was reported as `native-operation-failed` by the QA
  wrapper. A subsequent fixture-only diagnostic decoded the correct foreground,
  partially/fully occluded, moved and resized fixture pixels; it exposed the
  wrapper's initial geometry mismatch and then an immediate post-close assertion.
  Native error callbacks did not report a capture error in that run. The current
  session reports on-console/login-complete with no screen-locked key. This is
  positive native pixel evidence, not a completed lifecycle/permission-continuity
  matrix. No privacy setting or signing identity was changed. Fixture/native
  lifecycle timing remains under investigation for the native acceptance pass.
- Remaining required tranche work: preview/MCP observation coordination,
  protected per-operation Trajectory, native occluded-window/product acceptance,
  release identity/permission checks, performance measurements and final
  regression/completion audit. Native input, Accessibility, clipboard/files,
  human event taps, other native platforms, continuous video and cross-worker
  control remain deferred. The full roadmap below remains unfinished.

### Tranche cycle 8d — Native fixture acceptance and coordinate precision

- Branch: `codex/cua-08d-native-acceptance`, based on merged cycle 8c2
  (`281a4a173`). [PR #1749](https://github.com/ArcaneArts/Cantrip/pull/1749),
  implementation commit `997af3731`, ledger commit `0d1f3e786`. Squash-merged
  at `2026-09-05T11:09:36Z` as `38da8c6e53e8039dd24c8bb972546ce6eae85d67`.
  CI run `33962408503` passed macOS, Windows, Linux and PostgreSQL before
  auto-merge. Primary was synchronized; the clean cycle worktree/branch removed.
- Native acceptance exposed a real protocol precision defect: the default JSON
  parser changed certain fractional logical coordinates by one IEEE-754 ULP.
  Enable `serde_json`'s maintained `float_roundtrip` feature. A regression sends
  independently constructed fractional values through the actual framed
  executable and checks exact bits in both cursor and snapshot responses. It
  failed before the change and passes afterward; strict smoke assertions remain.
- Fixture ownership diagnosis: an autoreleased `orderedWindows` array created
  before AppKit's event loop retained a closed target for the fixture process's
  lifetime. An initialization autorelease pool drains that temporary ownership.
  Native state also changes asynchronously after AppKit resize/close calls;
  the fixture's acknowledgment must reflect its own actual WindowServer state.
  This is test-fixture synchronization, not a production readiness gate.
- Verification: all 86 Rust tests, strict Rust 1.95 Clippy/format, and
  995 focused CUA boundary tests pass (96 protocol, 24 crypto, 535 worker,
  182 server, 158 client). Two PostgreSQL tests remain dedicated-CI checks.
  Local platform is macOS 27.0 build 26A5421a, arm64. Native fixture verification
  uses the installed Apple Development-signed `cua-cycle-three-qa` helper,
  synthetic accounts/keys, and fixture-owned window pixels only.
- Native fixture: all six scenarios pass on installed debug and release builds:
  foreground, partial/full occlusion, move, resize and recreation, plus strict
  old-target rejection after close. Decoded color patches verify the selected
  window rather than the blue occluder; all four logical cursor styles are
  exercised. Initial captures are 320 × 240; resized captures are 384 × 288.
  All 14 opt-in fixture tests pass. Ordinary CUA script tests: 45 pass and one
  explicit GUI skip. No screenshot file is saved.
- Added an opt-in native app-client -> Fastify -> worker coordinator/service ->
  installed Rust test. It passes once with each signed debug/release build,
  verifying foreground and fully occluded fixture pixels, exact geometry,
  the logical cursor's decoded pixel, protected metadata/image delivery and
  Stop releasing the session/preview/approval state. The ordinary runner skips
  it unless `CANTRIP_CUA_NATIVE_TEST_BINARY` is explicitly provided. This uses
  actual production route/client/service implementations with synthetic endpoint
  dependencies; it does not prove live-account UI or packaged Tauri acceptance.
- Development identity: replaced the installed debug helper with the distinct
  release binary at the same named-profile path. Strict codesign verification
  and installed fake smoke passed; both builds have identical designated
  requirements (`art.cantrip.cua.dev`, Apple Development certificate). Both then
  completed native fixture and protected-route capture without a permission
  response or privacy-setting change between installs. Prompt presentation was
  not independently observed; this is successful native capture across changed
  development builds, not proof of outer-app/release update permission reuse.
- Timing samples: debug fixture smoke 2,738 ms total, first snapshot 233 ms,
  subsequent snapshots 138–158 ms; release 2,682 ms total, first snapshot 229 ms,
  subsequent snapshots 146–151 ms. These single fixture runs include native
  capture/encoding/IPC and verification, not an isolated transport benchmark or
  performance improvement claim. Warm/cold/idle/startup measurements remain.
- Remaining required tranche work: preview/MCP observation coordination,
  protected per-operation
  Trajectory, standalone release signing and packaged update/permission checks,
  actual `pnpm devtop` acceptance, performance measurements, and final regression
  and completion audit. Later-tranche deferrals remain unchanged.

### Tranche cycle 8e — Observe completed agent images from the shared preview

- Branch: `codex/cua-08e-agent-preview`, based on merged cycle 8d (`38da8c6e5`).
- PR: [#1750](https://github.com/ArcaneArts/Cantrip/pull/1750).
  Implementation commit: `f53c20822e084ca797ab5b615fd5c480bdf44a39`.
  Squash auto-merged 2026-09-05 at 11:54:42 UTC as
  `c9e516f51497debab6bdf536d4c9a0fc8e00ca4b` (observed via GitHub).
  CI run `33964194801` passed macOS, Windows, Linux and PostgreSQL on final
  head `9e784dd963a93b82e962032c046105fc0db1e2d1`. Primary was fast-forwarded;
  this pass's clean worktree and squash-merged local branch were removed.
- Implemented: **Manual preview** / **Follow agent** in the existing shared
  responsive panel. Follow agent lists actual root/child execution sources and
  retrieves their latest completed observation through the same protected
  app/server/worker route. It displays worker, thread, turn, session, target and
  observation attribution. Manual target/cursor controls are unavailable in
  this read-only view; the rendered model image already contains its cursor.
- Worker ownership: the existing coordinator references only the latest
  immutable model-image string from each active execution, at most four total.
  The image is not recaptured, resized again or saved in a second store. Original
  native metadata remains separate from model rendition dimensions/digest.
  Source IDs are opaque per-completed-evaluation UUIDs, scoped to exact current
  owner/server/worker/chat/project/placement/generation/profile and real native
  thread/turn/session. Client source claims never authorize native operations.
- Lifecycle: next evaluation, reset, error, native helper loss, request cancellation, Stop,
  revocation, disconnect and actual turn/command completion retire sources.
  Publication epochs reject late encoder completions. Source retirement aborts
  a reader already encrypting its copied image, including between accepted
  encrypted chunks and the final manifest. Four global decoded-reader slots
  are reserved before base64 decoding and remain held until actual delivery
  cleanup, even after cancellation. Temporary bytes are cleared on settlement.
- Observation reads use current authenticated preview authority and existing
  policy projection. They read already-authorized agent results without an
  additional capture prompt or native operation. Original agent capture approvals
  remain mandatory where selected policy requires them. Ordinary observer close
  and mode changes preserve the agent; explicit Stop remains chat-wide and
  independent from a pending approval or image read.
- Verification: 1,057 focused CUA tests pass (103 protocol, 25 crypto,
  559 worker, 194 server, 176 app). Three explicit skips are the two PostgreSQL
  cases reserved for dedicated CI and the opt-in native fixture route. Ten
  new compiled Rust -> actual MCP broker/stdio -> encrypted Fastify route ->
  app-client tests verify exact image bytes/digest/revisions, decoded cursor
  pixels at negative desktop origins, two observers, root/child isolation,
  real reset/next-evaluation/completion/Stop and foreign-authority rejection.
  Deterministic blocked-publication races prove source invalidation and reader
  capacity through cleanup. Killing the test-owned Rust helper after an accepted
  encrypted chunk aborts copied-image delivery and clears its bytes without
  another list/read or implicit restart; the observer lease remains usable.
  Worker/server/app builds and app typecheck pass.
- Browser QA: the actual shared panel/controller with a synthetic endpoint and
  Rust fake-backend images passed root/child attribution, source retirement,
  mode switch, delayed-read cancellation, Stop, encryption change and observer
  reopen checks. The cursor appears once in the image. Six layout checks passed
  (1150 px and 358 px content widths, matching scroll widths). Structured logs
  contain 33 pass events and no failures/warnings, including nine byte-cleanup
  checks, two of them aborted late reads. This proves panel behavior, not a
  physical mobile device or live-account/native route. Reproducible harness and
  logs are retained outside the checkout at `/tmp/cua-08e-qa-evidence`.
- Repository-wide `pnpm check` ran and stopped at existing decomposition
  budgets: `chat-turn-runtime.ts` has 2156 lines and `task-routes.ts` 2149, each
  above 1999. Both files are unchanged and have the same counts at the base
  commit. Later steps of that chained command did not run; focused checks above
  are separate evidence. Full protocol suite: 606 tests pass.
- Platforms/manual: local macOS fake backend for these tests; native fixture
  acceptance remains the separately verified cycle 8d evidence. Portable CI
  passed as recorded above; no native capture or privacy/signing changes
  are part of this pass. Live `pnpm devtop`, packaged Tauri, mobile-device and
  native MCP/observer product acceptance remain final verification work.
- Remaining tranche work: protected per-operation Trajectory, standalone release
  signing, installed/packaged update and permission evidence, startup/idle/latency
  measurements, live product acceptance, and the final regression/completion
  audit. The full roadmap and later-tranche deferrals below remain unchanged.

### Tranche cycle 9 — Protected per-operation Trajectory

- Branch: `codex/cua-09-protected-trajectory`, based on merged cycle 8e
  (`c9e516f51`). Local implementation and focused verification are complete;
  PR and cross-platform CI are pending.
- Implemented: actual agent MCP and user preview operations use the existing
  encrypted chat/task message and Trajectory paths. Agent records retain the
  runtime's root/child scope; idle preview sessions have a distinct Preview
  operator actor with no invented agent thread or turn. Records include bounded
  operation, timing, outcome, cursor and image metadata, never another screenshot
  copy, native inventory or JavaScript source. The server relays and stores opaque
  content through existing ownership-aware message paths.
- Lifecycle: preview payloads/readers are released before history publication.
  Stop revokes native sessions and pending work before publishing history; an
  unavailable/archived history cannot reverse Stop. Failed runtime turns release
  CUA and settle queued protected activities before returning the original error.
- Review corrections: MCP detach retains the prior target identity; rejected
  runtime turns cannot skip the protected queue; reversed/shuffled persisted
  preview messages are sorted before deriving their latest status. Actual agent
  inference progress remains separate from preview sessions.
- Browser QA: the actual shared Trajectory components passed seven synthetic
  scenario groups: root/child attribution, two-session history/back navigation,
  metadata-only tabs, failure/cancellation search and filtering, 358-pixel layout,
  actor/session labels, and matching operation identity in Raw. Evidence and a
  hash manifest are retained outside the repository at
  `/tmp/cua-09-qa-evidence/20260905-071132-verify-protected-computer-use-tr`.
  The fixture used synthetic protected activity records, not a signed-in account
  or native capture. Repeated hot-reload layout events are not separate scenarios;
  temporary harness hot-reload console warnings prevent a clean-console claim.
  The owned server and temporary harness were removed after QA.
- Verification: `pnpm cua:test:worker` passes 1,188 tests against the compiled
  Rust executable: 130 protocol, 25 crypto, 566 worker, 214 server, 253 app.
  Three explicit skips remain: two PostgreSQL tests run in dedicated CI and one
  opt-in native preview test. This includes actual MCP/preview success, failure,
  approval denial, cancellation, protected chat/task decoding, and held-sealer
  runtime-rejection tests. Full protocol suite passes 660 tests; worker, server
  and app builds, app typecheck, formatting and diff checks pass. Local execution
  is macOS arm64 with explicit fake capture. `pnpm check` stops at unchanged server decomposition
  budgets: `chat-turn-runtime.ts` 2,156 and `task-routes.ts` 2,149 lines, each with
  a 1,999-line limit; both counts match this pass's base. Later commands in that
  chained check are not claimed to have run. Native product, packaged Tauri and
  physical mobile acceptance are not established by this pass's fixtures.
- Remaining tranche work also includes standalone release signing,
  installed/packaged update and permission evidence, startup/idle/latency
  measurements, live product acceptance and final regression/completion audit.

This document proposes a first-party computer-use subsystem named
`cantrip_cua`. It is a future implementation plan, not a description of
currently available product behavior.

The intended user experience is:

1. Start an agent on a macOS worker.
2. Give that agent a task that requires seeing or operating applications on
   the same worker.
3. Let the agent select a monitor, application, or individual window and
   inspect it even when that window is behind another window.
4. Let the agent use its own visible logical cursor, accessibility actions,
   pointer and keyboard input, clipboard operations, application controls,
   and structured Finder/file operations.
5. Continue using the computer while the agent works. The agent observes
   relevant human input events and adapts instead of automatically pausing.
6. Watch the session from Cantrip on desktop, web, iPhone, or Android, with
   trajectory history showing what the agent saw and did.

Computer use runs only on the worker hosting the agent. A client may prompt,
observe, approve, or stop that agent from another device, but the agent does
not control the client device. Worker-to-worker desktop control is a possible
future capability and is not part of the first release.

The first release targets macOS only. Windows and Linux are future backends.

## Goals

- Add a top-level first-party Rust package named `cantrip_cua`.
- Make the worker that runs an agent the sole machine on which that agent may
  execute computer-use operations.
- Capture a selected monitor or individual application window without
  requiring the window to be unobscured or foregrounded when macOS APIs allow
  direct window capture.
- Give the agent a distinct logical cursor that is visible in observations
  and monitoring UI without treating the human pointer as the agent's durable
  state.
- Let agents and humans collaborate without automatically pausing the agent on
  every human input event.
- Report human pointer, keyboard, focus, window, and scene-change events to the
  agent when they are relevant to its active target.
- Integrate authorization with Cantrip's existing effective permission
  profile and durable agent-interaction system. Selected YOLO mode must not
  add a separate computer-use confirmation.
- Expose a provider-neutral managed MCP interface, including a persistent
  JavaScript execution surface optimized for models that can efficiently
  compose computer actions.
- Record computer-use actions, including ordinary typed text, in the existing
  protected Trajectory path with appropriate secret-field redaction.
- Allow desktop, web, iPhone, and Android Cantrip clients to observe the
  worker-local session.
- Ship `cantrip-cua` with the worker distribution in the same general manner as
  the bundled Codex and Cantrip CLI runtimes.
- Keep normal worker startup fast by loading the computer-use runtime lazily.
- Produce real native errors when capture or input fails rather than blocking
  valid operations with cached or secondary preflight guesses.

## Non-goals for the first release

- Controlling the desktop, browser, iPhone, or Android device running a
  Cantrip client.
- Letting an agent running on one worker control a different worker.
- Reusing the current Remote Desktop adapter, session model, capture pipeline,
  or persisted Remote Desktop tab as the computer-use runtime.
- Windows, Linux, X11, Wayland, iOS UI automation, or Android UI automation.
- Headless display creation or virtual-machine orchestration.
- Bypassing macOS login-window, lock-screen, privacy, sandbox, or other
  operating-system security boundaries.
- A permanent application blocklist maintained separately from Cantrip's
  permission system.
- Per-click confirmations when the effective permission profile already
  authorizes the operation.
- A general-purpose JavaScript, shell, filesystem, or network sandbox exposed
  to the model.
- Retaining full screenshots or accessibility trees in a second audit
  database.

## Fixed product decisions

The following decisions are part of the initial contract.

### Worker-local execution

The agent and `cantrip-cua` execute on the same worker. The app and server do
not perform native input on the agent's behalf. The server continues to own
durable state and routing, while the worker owns native desktop observation
and side effects.

The initial implementation must reject a target that belongs to another
worker. Future worker-to-worker control requires an explicit protocol and
authorization design rather than silently widening this scope.

### macOS-first delivery

The first complete backend is macOS. It must be designed as a platform-neutral
core with an explicit backend trait, but incomplete Windows or Linux adapters
must not delay the first release or create misleading capability claims.

### First-party implementation

`cantrip_cua` is a purpose-built Cantrip package. It may use maintained crates
that expose narrow operating-system bindings, image codecs, serialization, or
an isolated JavaScript engine. It must not embed a broad computer-use product
whose unrelated tools, authorization rules, logging, or protocol become part
of Cantrip by accident.

The current `@zavora-ai/computer-use-mcp` dependency may be studied for
behavioral characterization and parity tests. It is not the target runtime.
The implementation should prefer direct macOS frameworks through focused Rust
bindings over forking the whole dependency.

### Existing permission system remains authoritative

Computer use does not invent another global permission-mode selector. The
chat's selected and effective Cantrip permission profile remains authoritative.
When the effective profile requires an approval, the request uses the existing
durable agent-interaction path. When selected YOLO mode resolves to Codex's
`never` approval policy, computer use proceeds without an extra Cantrip prompt.

The Rust process receives capability-scoped authorization from the worker. It
does not independently decide whether the user should be prompted.

### Collaborative input

Human activity does not automatically pause the agent. The system distinguishes
agent-generated events from human-generated events, publishes relevant human
activity into the computer-use session, and lets the agent respond to the new
scene.

The UI still provides explicit Stop and Disable Computer Use actions. A user
may stop a session immediately without waiting for the current model turn to
finish.

### Independent CUA observation path

Computer use is not implemented as an extension of
`ManagedDesktopRemoteSurfaceAdapter`. It has a dedicated target model, capture
session, input scheduler, observation stream, and client monitor.

The implementation may reuse low-level authenticated WorkerLink routing,
encrypted binary framing, common viewport helpers, or generic image components
where their semantics fit. It must not inherit Remote Desktop's foreground
window assumptions, human-input ownership, persisted surface lifecycle, or
capture fallback behavior.

## Architectural decision

`cantrip_cua` is a worker-owned Rust sidecar with a versioned private protocol.
The worker remains the authorization and orchestration boundary. A managed MCP
host gives Codex a provider-neutral computer-use interface, and a dedicated
CUA observation channel lets Cantrip clients monitor the same worker-local
session.

```text
Cantrip client on desktop, web, iPhone, or Android
  - prompts and approvals
  - live CUA monitor
  - user/agent cursor presentation
  - Stop / Disable Computer Use
                |
                | existing authenticated app/server/worker routing
                v
Cantrip worker running the agent
  - effective permission profile
  - durable approval bridge
  - task/turn ownership
  - CantripCuaService
  - trajectory publication
                |
                | private framed child-process protocol
                v
cantrip-cua Rust sidecar
  - native target inventory
  - window and monitor capture
  - logical agent cursor
  - human-input observation
  - accessibility snapshot/actions
  - pointer/keyboard/clipboard input
  - applications and Finder/file operations
  - bounded persistent JavaScript sessions
                |
                v
macOS frameworks
  - ScreenCaptureKit
  - Accessibility
  - CoreGraphics
  - AppKit / Foundation
```

There is no app-to-sidecar connection and no sidecar network listener. All
access is mediated by the worker hosting the agent.

## Relationship to existing Cantrip systems

Cantrip already has useful seams that should be extended selectively:

- Permission profiles live in
  [`packages/protocol/src/permission-profiles.ts`](../../packages/protocol/src/permission-profiles.ts).
- Durable command, file, permission, user-input, and MCP approval behavior is
  documented in
  [`docs/AGENT_INTERACTIONS.md`](../AGENT_INTERACTIONS.md).
- Worker-managed MCP configuration is assembled in
  [`cantrip_worker/src/mcp/managed.ts`](../../cantrip_worker/src/mcp/managed.ts).
- Protected raw tool capture is produced in
  [`cantrip_worker/src/codex/raw-capture.ts`](../../cantrip_worker/src/codex/raw-capture.ts).
- Trajectory's protected diagnostic contract is documented in
  [`docs/TRAJECTORY.md`](../TRAJECTORY.md).
- The current native input wrapper is in
  [`cantrip_worker/src/desktop/automation-client.ts`](../../cantrip_worker/src/desktop/automation-client.ts).
- The current Remote Desktop capture implementation is in
  [`cantrip_worker/src/desktop/desktop-frame-source.ts`](../../cantrip_worker/src/desktop/desktop-frame-source.ts).
- Worker packaging and the desktop's bundled worker runtime are assembled in
  [`scripts/package-distributions.mjs`](../../scripts/package-distributions.mjs).

Existing Remote Desktop behavior is a characterization source, not the CUA
architecture. CUA-specific protocol types should live in their own protocol
module rather than extending `remote-desktops.ts` with a second meaning for
the same records.

## Rust package layout

The repository currently keeps Rust packages independent rather than using a
root Cargo workspace. `cantrip_cua` should initially follow the same shape as
`cantrip_cli`.

```text
cantrip_cua/
  Cargo.toml
  Cargo.lock
  README.md
  src/
    lib.rs
    main.rs
    protocol.rs
    service.rs
    session.rs
    target.rs
    observation.rs
    capture.rs
    input.rs
    cursor.rs
    accessibility.rs
    applications.rs
    filesystem.rs
    permissions.rs
    javascript.rs
    platform/
      mod.rs
      macos.rs
  tests/
    fixtures/
    protocol.rs
    session.rs
```

Naming conventions:

- Repository directory: `cantrip_cua`
- Cargo package: `cantrip-cua`
- Library crate: `cantrip_cua`
- Executable: `cantrip-cua` on macOS and `cantrip-cua.exe` on a future Windows
  backend

The library owns native and session behavior. The executable owns process
transport, structured stderr logging, graceful shutdown, and crash containment.

## Worker service ownership

Add one `CantripCuaService` to the worker process. It is the single owner of:

- Lazy sidecar discovery and launch.
- Sidecar version and capability negotiation.
- Task, thread, turn, and worker authorization bindings.
- CUA session creation and teardown.
- Managed MCP calls.
- Client observation attachments.
- Existing permission-profile decisions and approval requests.
- Trajectory event publication.
- Sidecar crash recovery and session failure reporting.

The service starts the sidecar on the first authorized computer-use request.
It does not add native initialization to ordinary worker startup. Once started,
the sidecar remains available for the worker lifetime unless it crashes or is
explicitly disabled.

The worker may restart an unexpectedly terminated sidecar once and report the
actual failure. It must not retry indefinitely or hide a repeated crash behind
a permanent loading state.

## Private worker-to-sidecar protocol

Use a versioned, length-prefixed protocol over child-process stdin and stdout.
Do not expose a TCP listener, HTTP endpoint, Unix socket, or named pipe in the
initial implementation.

The protocol contains:

- A JSON or compact structured header validated on both sides.
- Optional binary payload bytes for screenshots and thumbnails.
- Request, response, event, and cancellation frames.
- Monotonic request and event sequence numbers.
- Explicit protocol version and capability negotiation.
- Bounded message, image, accessibility-tree, and text sizes.
- Session and target-generation identifiers on state-sensitive operations.
- Structured, redacted diagnostics on stderr only.

Do not base a decision to run an operation on a stale cached permission status
or a secondary health guess. Attempt the authorized native operation and
return its real result. Target generations are used only when the target is
known to have changed or disappeared.

Initial operations should include:

- `capabilities.get`
- `targets.list`
- `target.attach`
- `target.detach`
- `observation.snapshot`
- `observation.subscribe`
- `input.batch`
- `window.activate`
- `window.restore`
- `accessibility.snapshot`
- `accessibility.query`
- `accessibility.action`
- `application.list`
- `application.launch`
- `clipboard.read`
- `clipboard.write`
- `filesystem.open`
- `filesystem.reveal`
- `filesystem.copy`
- `filesystem.move`
- `filesystem.rename`
- `filesystem.trash`
- `javascript.evaluate`
- `javascript.reset`
- `session.close`

Action batching lets the model compose several low-latency inputs without a
separate MCP round trip for every mouse movement or keystroke. The sidecar
returns a fresh observation after a batch when requested.

## Target model and capture semantics

CUA targets are transient worker-local native objects, not durable Remote
Desktop records. A target can be:

- A monitor.
- A native window.
- An application, resolved to one or more windows.

Every target includes:

- Opaque native target ID.
- Target kind.
- Application and process identity when available.
- Window title when available.
- Logical bounds in the global desktop coordinate space.
- Pixel dimensions.
- Scale factor.
- Occlusion, minimized, hidden, and focused state when knowable.
- A target generation that changes when the native object is replaced.

Coordinates exposed to the model use target-local logical points. The Rust
backend owns conversion to native global points, pixels, scale factors, and
negative monitor origins.

### Individual-window capture

The macOS backend should use ScreenCaptureKit window capture so an attached
window remains visible to the agent when another window covers it. The
implementation must characterize and report the actual behavior for:

- Background and unfocused windows.
- Partially or fully occluded windows.
- Windows on another Space.
- Hidden applications.
- Minimized windows.
- Windows that move, resize, close, or are recreated.

Where macOS does not produce frames for a particular state, CUA reports that
state precisely. It must not silently replace a selected window with the full
monitor or focus the window merely to make capture appear successful.

The macOS login window and lock screen are protected operating-system surfaces.
CUA must not claim it can bypass those boundaries. This is distinct from
capturing a normal background or occluded application window.

### Monitor capture

Monitor mode supports every display reported by macOS, including mixed scale
factors, Retina displays, rotated displays, and negative global coordinates.
The primary display is a property, not an implicit default after the user or
agent selects another display.

## Agent cursor and human collaboration

macOS exposes one real system pointer. Cantrip therefore represents the agent
cursor as explicit CUA session state rather than pretending the operating
system provides two independent native pointers.

The agent cursor contains:

- Target-local logical coordinates.
- Cursor shape or action state when known.
- Last agent movement and action time.
- Visibility and color identity for observation rendering.
- The task and session that own it.

Snapshots returned to the model and frames shown in the CUA monitor render the
agent cursor as an overlay. Human pointer presentation remains distinct.

For an accessibility-addressable control, prefer a targeted Accessibility
action that does not require moving the human pointer or foregrounding the
window. Coordinate-based CoreGraphics input may still use the shared native
pointer and focus rules. The protocol and trajectory must identify which
method was used instead of implying that arbitrary coordinate clicks are
physically independent.

The macOS backend should mark generated CoreGraphics events with a private
source tag and observe native input with an event tap. This allows the session
to distinguish agent-generated events from human-generated events.

Relevant human events are published into the session, including:

- Pointer movement, click, drag, and scroll within the active target.
- Keyboard and modifier activity routed to the active target.
- Target focus, movement, resize, visibility, and content changes.
- Clipboard changes initiated through Cantrip when observable.

Human input increments the scene revision and becomes part of the agent's next
observation. It does not automatically pause or cancel the agent. If human and
agent actions overlap, the input scheduler preserves the real event ordering
and the resulting scene is authoritative.

Secure text fields require special handling. Human or agent text directed at a
field identified by Accessibility as password or secure input is represented
as a redacted input event with length metadata rather than plaintext.

## macOS native backend

The first backend should use focused Rust bindings to native macOS frameworks:

- ScreenCaptureKit for direct display and window frames.
- Accessibility APIs for window inventory, semantic snapshots, focus,
  control actions, and secure-field detection.
- CoreGraphics for coordinate pointer, scroll, and keyboard events where a
  semantic action is unavailable.
- AppKit and Foundation for application activation, clipboard, icons, paths,
  and Finder integration.
- ImageIO, Accelerate, Metal, or a focused image codec only where measurement
  shows that conversion or encoding needs it.

Native handles stay inside the Rust process. The worker sees validated opaque
IDs and bounded serializable results.

### Permissions and stable identity

Screen Recording and Accessibility permission belong to a stable shipped
runtime identity. `cantrip-cua` is bundled with the worker alongside the Codex
and Cantrip CLI runtimes, signed as part of the desktop distribution, and
resolved from a stable installed location.

Development must also use a deliberate stable helper identity and location.
Rebuilding a worktree must not produce a new permission identity or cause
repeated macOS prompts. The initial macOS spike must prove the development and
release signing behavior before broader implementation proceeds.

Permission status is diagnostic information. The actual capture or input call
remains authoritative. A denial returns a precise recovery state and opens the
normal macOS/Cantrip guidance; it must not cause an infinite retry or a generic
loading screen.

## Accessibility model

Accessibility is a first-class observation and action path rather than a
post-hoc optimization.

An accessibility snapshot should contain a bounded target-local tree with:

- Stable-within-generation element IDs.
- Role, subrole, label, value, description, and state.
- Target-local bounds.
- Focus, enabled, selected, expanded, editable, and secure flags.
- Supported semantic actions.
- Parent/child relationships.

The tool can query by element ID or bounded predicates and perform only actions
the snapshot advertised. Element IDs are invalidated when the target generation
changes or the native element is no longer present.

Accessibility actions are preferred for buttons, fields, menus, lists, tabs,
and other semantic controls. Screenshots and coordinate input remain available
for canvases, games, custom renderers, and other interfaces without adequate
accessibility metadata.

## Applications, Finder, and file operations

Routine filesystem work should use structured worker-owned operations rather
than pixel navigation through Finder:

- Open a file or directory.
- Reveal a path in Finder.
- Copy, move, rename, or trash an exact path.
- Launch or activate an application.
- Open a path with a selected or default application.

These operations remain constrained by the task's effective permission profile
and worker filesystem authority. They use the existing approval path when an
approval is required.

Finder remains available as a visual CUA target when manipulating Finder itself
is the requested task. Structured operations and visual operations share
trajectory attribution but are not disguised as one another.

## Managed MCP and model interface

Add a worker-managed MCP server named `cantrip_cua`. It is injected only when:

- The current worker reports a compatible CUA runtime.
- The current agent context supports computer use.
- The current task is bound to that worker.

The MCP host connects to `CantripCuaService` through the existing
capability-scoped worker broker. It never launches or connects to the Rust
sidecar directly.

The initial model-facing tools are:

- `js`
- `js_reset`
- `snapshot`, if measurements show that a small direct first-observation tool
  materially improves discovery or failure handling

The persistent `js` environment exposes a documented `cua` object. A typical
flow should be possible in one call:

```javascript
const state = await cua.getState();
const target = await cua.getWindow(state.windows[0].id);
await target.activate();
await target.click(420, 180);
await target.type("hello");
await target.key("ENTER");
await target.snapshot();
```

The same service exposes structured action primitives internally for provider
portability, deterministic tests, and future models that do not use a code
execution interface.

### JavaScript isolation

The persistent evaluator should run in the Rust sidecar using a maintained,
embeddable JavaScript engine selected during the initial spike. The exposed
environment contains only the `cua` API and safe language built-ins.

It must not expose:

- Native process or environment access.
- Arbitrary filesystem access.
- Network access.
- Dynamic native-library loading.
- Unbounded timers, workers, memory, output, or execution time.

Each evaluator is scoped to one authorized CUA session. It has bounded memory,
script size, execution duration, action count, screenshot count, and output.
`js_reset`, turn interruption, task stop, permission revocation, worker
disconnect, and session teardown all cancel pending work and dispose the
context.

## Permission and approval behavior

The effective permission profile selected through Cantrip is the source of
truth. Define CUA operation classes in the worker policy projection, such as:

- Observe screen or accessibility state.
- Use pointer and keyboard input.
- Read or write the clipboard.
- Launch or focus applications.
- Perform structured filesystem mutations.

The profile-to-operation mapping belongs in Cantrip's existing policy and
permission integration, not in platform-specific Rust code. Any required
approval becomes an ordinary durable agent interaction with task, thread,
turn, item, worker, target, and operation provenance.

Selected YOLO mode does not receive a second CUA prompt. Other profiles may
require an approval according to their effective policy. There is no separate
application denylist and no unconditional ban on Cantrip, terminals, password
managers, system settings, or security applications. The user-selected policy
and operating-system permissions remain authoritative.

The client always retains an out-of-band Stop/Disable control. This is a
lifecycle control, not an approval prompt.

## CUA observation and client monitoring

Create a dedicated CUA observation protocol rather than persisting a Remote
Desktop surface. The live channel carries:

- Current target metadata and generation.
- Encoded target frames.
- Agent cursor overlay state.
- Human pointer and input-event summaries.
- Capture, input, and permission status.
- Task, turn, and session attribution.
- Current agent action and outcome.

The server routes the stream to authorized clients but does not decode or
persist frame content. Desktop, browser, iPhone, and Android clients can attach
as observers. Client input to the worker's desktop remains a distinct future
decision; the first CUA monitor is primarily for observation, approval, and
Stop/Disable controls.

The monitor should be reachable from the active task and Trajectory. It should
show which worker, application/window or monitor, task, and agent own the
session. Multiple clients may observe the same session without creating
multiple capture sessions.

## Trajectory and audit behavior

CUA actions are ordinary protected agent activities and extend the existing
Trajectory model instead of creating a separate audit database.

Each activity records:

- Task, agent, thread, turn, and item correlation.
- Worker and CUA session identity.
- Target identity and generation.
- Action kind and execution method, such as Accessibility or CoreGraphics.
- Target-local coordinates and agent cursor state when applicable.
- Ordinary typed text.
- Key combinations and clipboard operation metadata.
- Timing, duration, status, and bounded native error information.
- Scene revision before and after the action.
- Whether intervening human input was observed.

Typed text is captured inside the existing encrypted protected-raw envelope,
not plaintext logs or server metadata. Known credentials continue through the
existing redaction path. Text sent to an Accessibility-secure field, text
explicitly marked sensitive by the calling tool, and values recognized as
credentials are stored as redacted metadata rather than plaintext.

Screenshots and full accessibility trees are not copied into a second audit
store. When a bounded screenshot is already part of the model-visible tool
result, existing encrypted message and attachment behavior remains
authoritative. Trajectory may retain a digest, dimensions, target generation,
and omission/truncation metadata.

Human collaboration events appear in the same turn trajectory so a reviewer
can understand why the scene changed between agent actions. Raw native event
streams are coalesced into meaningful bounded events rather than persisting
every mouse-move sample.

## Persistence

CUA sessions and native target IDs are transient worker state. They do not
require durable server database tables in the first release.

Durable information remains in existing systems:

- Selected and effective permission profile in chat state.
- Approvals in durable agent interactions.
- Actions and results in encrypted chat/trajectory content.
- Worker capability observations in the existing worker capability path.

If a future feature needs persistent CUA preferences, store only explicit user
preferences such as monitor or application selection. Never persist a native
window handle as a durable identity.

## Development and packaging

Add root scripts consistent with `cantrip_cli`:

- `cua:build`
- `cua:build:release`
- `cua:test`
- `cua:check`

Add a focused build helper under `scripts/cantrip-cua/` that:

- Builds the standalone Cargo manifest with `--locked`.
- Resolves debug and release artifacts without relying on a worktree-specific
  target path as durable runtime identity.
- Bundles `cantrip-cua` into the worker's `bin` directory.
- Makes the executable bit explicit on macOS.
- Verifies the packaged runtime by launching it and completing the real
  version/capability handshake.

The worker runtime resolver should check an explicit development override and
the known packaged binary location. It should invoke the selected binary and
let launch or handshake fail with the real error rather than rejecting it
based only on a version file or filesystem heuristic.

The desktop runtime already bundles the packaged worker. No separate
app-to-sidecar path or Tauri command should be introduced.

### macOS signing and updates

The release pipeline must sign `cantrip-cua` before signing the enclosing
runtime and application. Verification must assert the nested executable's
signature and launch the packaged handshake from the final application layout.

Update tests must prove that replacing Cantrip in place preserves the stable
CUA permission identity. Development tests must prove that branch changes and
worktree rebuilds do not create a new permission identity or helper path.

## Testing strategy

### Pure Rust tests

- Protocol framing, bounds, cancellation, and version negotiation.
- Session and target-generation state machines.
- Action batching and output ordering.
- Logical-to-native coordinate conversion.
- Agent cursor and scene revisions.
- Human-versus-agent event classification.
- JavaScript isolation, limits, persistence, reset, and cancellation.
- Secret-field and typed-text audit handling.
- Fake-backend capture, accessibility, input, and failure behavior.

### Worker tests

- Sidecar lazy start and one-time crash recovery.
- Task and worker ownership enforcement.
- Effective permission-profile projection.
- YOLO execution without a duplicate prompt.
- Durable approval routing for profiles that require it.
- MCP task/session binding and stale-call rejection.
- Observation fan-out to multiple clients.
- Protected trajectory capture and redaction.
- No computer-use initialization during an ordinary worker startup.

### macOS integration harness

Build a deterministic fixture application with standard controls, custom
drawn content, a secure field, multiple windows, and observable state. Exercise:

- Monitor and individual-window inventory.
- Direct capture of a fully occluded window.
- Window movement, resize, focus, hide, minimize, close, and recreation.
- Retina scaling and multiple displays with negative origins.
- Accessibility click, value set, selection, scroll, and focus.
- Coordinate click, drag, scroll, key combinations, and Unicode text.
- Distinct agent cursor rendering.
- Human input arriving between and during agent action batches.
- Permission denial and revocation.
- Sleep, lock, unlock, and session recovery as allowed by macOS.
- Packaged and development signing identities.

Tests must describe actual macOS restrictions instead of treating unsupported
secure surfaces as implementation regressions.

### End-to-end acceptance

1. Start an agent on a macOS worker.
2. Select an application window that is behind another window.
3. Capture and understand its current state without bringing it forward.
4. Use an Accessibility action without moving the human pointer.
5. Use coordinate input where the application has no semantic control.
6. Show the agent cursor distinctly in the observation and client monitor.
7. Let the user interact while the agent continues and confirm the agent sees
   the resulting user event and new scene.
8. Run under a profile that requires approval and resolve it through the
   existing interaction UI.
9. Run under selected YOLO mode without a second CUA-specific prompt.
10. Observe the session from a browser or mobile client.
11. Inspect the completed actions and typed text in protected Trajectory data.
12. Stop the session from the client and verify native input ends immediately.

## Performance requirements

Establish baselines before replacing the current native dependencies. Measure:

- Lazy sidecar cold start and handshake.
- Warm target inventory.
- Monitor and window snapshot latency.
- Action-to-observed-frame latency.
- Accessibility query and action latency.
- Image conversion, encoding, and IPC copy cost.
- Idle CPU and memory with and without observers.
- CUA monitor fan-out cost.

Do not set permanent thresholds before the macOS spike measures representative
hardware. After measurement, add release-regression budgets for cold start,
warm observation, input-to-frame latency, idle CPU, and memory.

The normal worker startup path must not eagerly launch the sidecar, request
Screen Recording permission, enumerate displays, or initialize a JavaScript
engine.

## Implementation cycles

Each cycle is an independently reviewable worktree PR and must auto-merge
before the next dependent cycle begins.

### Cycle 1 — Contracts and macOS feasibility

- Add the architecture record and protocol vocabulary.
- Characterize current dependency behavior and parity requirements.
- Prototype stable development/release helper identity.
- Prove ScreenCaptureKit capture of an occluded window.
- Prove agent/human event tagging and Accessibility actions.
- Select focused Rust bindings and the isolated JavaScript engine using
  measured prototypes.

### Cycle 2 — Rust package and fake backend

- Create `cantrip_cua` with locked dependencies.
- Implement protocol framing, capability negotiation, cancellation, session
  ownership, target generations, and fake backend.
- Add Rust build, test, check, and packaging helpers.

### Cycle 3 — Worker service and packaging

- Implement lazy `CantripCuaService` and the sidecar client.
- Bundle the executable with standalone and desktop workers.
- Add real packaged handshake verification and macOS signing coverage.
- Keep product behavior disabled behind capability negotiation.

### Cycle 4 — macOS inventory and capture

- Implement monitor, application, and window inventory.
- Implement direct monitor/window capture, scale conversion, binary image
  transport, and target lifecycle events.
- Add the macOS fixture harness for background and occluded windows.

### Cycle 5 — macOS input, cursor, and collaboration

- Implement the logical agent cursor.
- Implement Accessibility-first actions and CoreGraphics fallback input.
- Tag generated events and observe relevant human events.
- Implement clipboard behavior and scene revisions.

### Cycle 6 — Applications, Finder, and filesystem operations

- Implement application launch, activation, and inspection.
- Implement open, reveal, copy, move, rename, and trash operations.
- Route authorization through the effective permission profile.

### Cycle 7 — Managed MCP and JavaScript execution

- Add the `cantrip_cua` managed MCP.
- Implement bounded persistent `js` and `js_reset` sessions.
- Add provider-neutral structured action support beneath the MCP adapter.
- Return model-visible image observations and precise native failures.

### Cycle 8 — Permission and durable interaction integration

- Define CUA operation classes in the existing permission projection.
- Route required approvals through durable agent interactions.
- Verify selected YOLO mode adds no second prompt.
- Add client Stop/Disable behavior independent from approval state.

### Cycle 9 — CUA monitoring UI

- Add the dedicated observation channel.
- Add desktop, browser, iPhone, and Android monitoring views.
- Render agent and human cursors distinctly.
- Expose active target, worker, agent, action, and Stop/Disable controls.

### Cycle 10 — Trajectory integration

- Add CUA action and human collaboration event kinds.
- Record ordinary typed text in protected raw capture.
- Redact secure-field and credential values.
- Add CUA filters, previews, raw details, timing, and scene correlation.

### Cycle 11 — Legacy native dependency retirement

- Run parity coverage against the macOS release candidate.
- Remove `@zavora-ai/computer-use-mcp` from CUA paths.
- Remove `node-screenshots` only after confirming no remaining product owner.
- Remove duplicated compatibility adapters rather than retaining two native
  execution stacks indefinitely.

### Cycle 12 — Release hardening

- Run the full macOS integration and packaged-app matrix.
- Verify signing, update compatibility, stable permissions, crash recovery,
  and development rebuild behavior.
- Measure and enforce agreed performance budgets.
- Update user, security, developer, release, and troubleshooting documentation.

Windows planning begins only after the macOS completion criteria are met.

## Risks and mitigations

### macOS privacy identity churn

An unstable helper path or signing requirement could repeatedly invalidate
Screen Recording or Accessibility permission. Prove stable development and
release identity in Cycle 1 and treat it as a release compatibility contract.

### Separate cursor expectations

macOS has one real pointer. Maintain an independent logical agent cursor,
prefer Accessibility actions, and label coordinate injection accurately. Do
not promise physical pointer isolation the operating system cannot provide.

### Background-window differences

ScreenCaptureKit behavior varies across minimized, hidden, other-Space, and
protected windows. Characterize each state and report it precisely; never
substitute monitor capture without disclosure.

### Sensitive trajectory text

Typed text can contain credentials. Keep it in encrypted protected raw capture,
redact secure fields and known secret forms, bound its size, and keep it out of
logs, analytics, public metadata, and server-side search.

### Human and agent contention

Concurrent input can change the scene between observation and action. Preserve
real ordering, publish user events, increment scene revisions, and let the
agent re-observe. Do not add speculative preflight checks that prevent a valid
native action.

### Broad native surface area

Keep Rust dependencies narrow and platform modules explicit. Every new native
capability must have an owned protocol operation, permission class, failure
contract, and integration test.

## Completion criteria

The macOS computer-use goal is complete only when:

- `cantrip_cua` exists as a first-party Rust package and bundled worker
  executable.
- Computer use runs on the same worker as the agent and cannot target another
  worker.
- Normal worker startup does not launch or initialize CUA.
- A selected monitor or individual macOS window can be observed directly.
- A normal occluded/background window can be captured without foregrounding
  it when ScreenCaptureKit supports that state.
- Accessibility-first actions and coordinate fallback input both work.
- The agent has a distinct logical cursor visible to the model and monitoring
  clients.
- Human input does not automatically pause the agent and appears as bounded
  collaborative session events.
- Existing permission profiles and durable approvals authorize CUA operations.
- Selected YOLO mode does not receive a duplicate CUA confirmation.
- The managed MCP provides bounded persistent JavaScript execution and a
  provider-neutral structured action layer.
- Desktop, web, iPhone, and Android clients can monitor the worker-local
  session without becoming automation targets.
- Ordinary typed text is visible in encrypted Trajectory details, while secure
  and credential values are redacted.
- The packaged sidecar has a stable signed macOS identity across updates and a
  stable deliberate development identity across worktrees and rebuilds.
- Actual packaged binaries complete a version/capability handshake in CI.
- The existing Remote Desktop implementation continues to work independently.
- Legacy native CUA dependencies are removed after verified parity.
- Focused Rust, worker, protocol, app, packaging, signing, update, and macOS
  integration tests pass.
- User, developer, security, release, and troubleshooting documentation
  describe the implemented behavior and real macOS limitations.

The work must not stop at a protocol scaffold, screenshot-only prototype,
foreground-only automation path, or tool that cannot be monitored and audited
through Cantrip.
