# Cantrip Codex

Cantrip carries the exact upstream Codex CLI source used by its worker under
`cantrip_codex/upstream/`. The source is a mechanically imported projection of
the official OpenAI Codex repository: the Rust workspace plus the repository
license, notice, and readme. It is not a submodule or a nested Git checkout.

The pinned upstream ref, resolved commit, and CLI version live in
`upstream.json`. `upstream.files.json` records every imported file and content
hash. Cantrip-specific compatibility patches live in `patches/`. The tracked
upstream snapshot remains pristine and hash-verified; build preparation applies
every reviewed patch in filename order to an ignored source copy.

## Build

The repository's normal development preparation and worker packaging invoke:

```sh
pnpm codex:build
```

For native development and opt-in acceptance fixtures, use the same verified
build workflow with Cargo's development profile:

```sh
node scripts/cantrip-codex/build.mjs --dev
CANTRIP_CODEX_TEST_BINARY="$PWD/cantrip_codex/.build/$(node -p 'process.platform + "-" + process.arch')/dev/bundle/codex" \
  pnpm --dir cantrip_worker exec vitest run test/native-durable-goal.test.ts
```

Development builds use a separate `dev/` source and bundle directory and record
`profile: "dev"` in their manifest. They retain the same source, patch, artifact
and generated-protocol verification. The default build and packaging paths use
the release profile.

This verifies the snapshot and patch series, then runs Cargo with the upstream
lockfile and pinned Rust toolchain. Output is cached below
`cantrip_codex/.build/` and is never
committed. Worker packages copy the resulting native CLI, code-mode host,
standalone executor, responses proxy, platform sandbox helpers, and a hash-checked runtime manifest
into `bin/`. The bundle also carries the upstream Apache-2.0 `LICENSE` and
`NOTICE`. The native release verifier checks every listed artifact's bytes;
the Worker requires the manifest and declared artifacts before starting Codex.

Upstream release tags update their workspace manifests from development
version `0.0.0` without updating those same local-package version fields in
`Cargo.lock`. The build script copies the verified source into its ignored
build directory and normalizes only those workspace-local versions from Cargo
metadata before invoking `cargo build --locked`. Registry and Git dependency
versions, checksums, and revisions remain exactly as pinned upstream, and the
tracked source snapshot is never modified. The runtime manifest fingerprints
the ordered patch set so changing a patch invalidates cached binaries.

Codex 0.166.0 continues to use Rusty V8's heap sandbox for the code-mode host.
Those artifacts are published on a separate official OpenAI Codex release
rather than the upstream Rusty V8 release. The build resolves the pinned `v8`
crate version and native Rust host target, downloads the same archive and
generated binding used by Codex's release workflow, verifies both against
OpenAI's two-entry SHA-256 manifest, and supplies them to Cargo. This preserves
the upstream V8 sandbox without compiling V8 from source on every Cantrip
target.

After building, `pnpm codex:verify:runtime` runs the actual CLI in an isolated
home, checks its exact version and every artifact hash, and verifies that its
generated experimental protocol includes the Cantrip settings, pause, canonical
history, and portable history/context extensions. Native release jobs also run
this check against the worker's packaged `bin/` directory on macOS and Windows.

The 0.166.0 upgrade rebases all 43 existing patches and adds `0045` for native
interface adaptations and regenerated stable/experimental protocol exports.
It preserves Cantrip's managed history, settings, queue, permission transitions,
pause, account configuration, stateless labeling, and TUI admission paths.
Portable import binds destination metadata to its current configured provider
while retaining the original immutable history segments and source provenance.
Patch `0081` holds the existing native tree execution coordinator during
portable export. Active child/auxiliary execution and final hooks, pending
native security settings, and attached durable suspension holds prevent export
even when the root has cleared its active turn. The actual flush, turn-boundary
check and snapshot run under that guard. A provider ticket's release is not
native tree settlement. This patch was source-reviewed without native patch
application, compilation or execution; runtime/platform behavior is unverified.
Patch `0082` gives provider transfers a revisioned root producer hold. Existing
children can finish with their own tickets; actual export seals subsequent tree
admission while holding the quiescence guard. Cancellation releases that exact
hold and seal on the same gate, including its inference-only mode. It never
rearms an explicit Stop/Pause. The worker-private RPC is consumed by the existing
handoff coordinator and managed execution runner. Source review, direct source
formatting and `git diff --check` were used; native patch application, builds,
tests and runtime execution were not performed.
Patch `0083` couples the Goal runtime's existing mutation permit to the native
root's export seal. Export refuses a live Goal mutation rather than waiting on
its async permit while holding tree admission; sealed roots reject later Goal
mutations until the owning transfer releases its hold. An optional exact Goal
epoch is compared against the actual portable snapshot before publication.
The worker persists that expectation in its export plan for retry/recovery.
This is a native checkpoint boundary; the Task provider-transfer server and UI
integration remains separate. Only source review, formatting of new fragments,
and `git diff --check` were performed. The native patch was not assembled,
applied, compiled or executed.
Patch `0084` lets an owned transfer wait for actual native tree lease release
and Goal mutation settlement before sealing its snapshot. It registers wakeups
before inspecting state, then repeats the real locked readiness check. It never
treats an acknowledgement, timeout or notification as settlement. Cancellation
and native invalidation wake the waiter; an exact transfer identity prevents a
late export from sealing a subsequent transfer. Goal permit waits release tree
admission first. The worker's export observer can be cancelled promptly while
native I/O remains fenced, and this settlement wait has no inference deadline.
Ordinary RPC and inference deadlines remain unchanged. These changes received
source review and direct fragment formatting only; native application, builds
and runtime behavior remain unverified.
Patch `0085` adds the private, connection-owned Task pause intent RPC. The actual
inference-only root compares the canonical control revision and changes its
pause watch under one gate lock. An older request cannot apply after a newer
Pause or Resume. Intent acceptance is separate from a model/tool boundary or
live checkpoint resumption; superseding controls wake the older observer.
Worker queue notices acknowledge acceptance without retaining one command per
long-running tool. No ticket is released by an intent acknowledgement. The
worker and native runtime need a paired update. This patch is source-authored
only; it has not been applied, built or executed.
The new item payload wrapper retains lifecycle timestamps, and history replay
keeps upstream's bounded, cancellable projection pipeline. Cold resume keeps
acknowledged owned settings and upstream's current permission constraints.
The imported upstream snapshot remains unpatched; adaptations belong to the
build copy. Recipe 6 also packages the upstream standalone `codex-exec-server`
and exercises its actual version alongside the CLI during runtime verification.

The official 0.163.0 and 0.166.0 release commits have diverged ancestry. This
upgrade advances the vendored source projection to exact tag `rust-v0.166.0`
at `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856` and rebases the patch series; it
does not force or rewrite a separate fork branch.

Upstream 0.163.0 retired numeric fork-history selection and the patched-zsh
executor. Their obsolete compatibility tests are removed; supported full-history
forks and standard shell execution follow the new upstream interfaces.

## Lightweight automatic titles

Patch `0043` adds the experimental `cantrip/inference` RPC for a bounded,
single model request using the existing native provider and authentication.
It does not start a thread, create a rollout, load project instructions, or
initialize MCP tools. The request contains only labeling instructions and the
initial request text. Both standard response messages and plaintext agent
messages are supported. A failed request leaves the actual agent turn alone.

General settings provide a labeling model (the default model unless overridden)
and independent automatic-title switches for tasks and chats/agents, both on by
default. The lowest known supported reasoning effort is selected; otherwise the
model's default is preserved. Task titles are capped at six words; project agent
and standalone Cantrip Chat titles at three. Explicit titles and manual renames
are never overwritten. Random agent naming soft-disables chat/agent titling
without clearing its saved setting; it does not disable task titles.

Only the worker opens the encrypted initial message or task brief. It encrypts
the generated label for the existing private-title pipeline; the server never
receives the plaintext title. Runtime diagnostic responses omit private labeling
content, including responses arriving after a timeout. Empty task creation is
named on its first submitted brief, not on partial autosaves while typing;
existing chats are not bulk-renamed.

The actual native request can be tested without account credentials or charges:

```sh
CANTRIP_CODEX_TEST_BINARY="$PWD/cantrip_codex/.build/darwin-arm64/bundle/codex" \
  pnpm --dir cantrip_worker exec vitest run test/native-label-inference.test.ts
```

The fixture uses an isolated home and local fake provider. It checks request
contents, native authentication plumbing, absent tools/project context, no new
durable threads, and validation/provider failures. It does not establish live
ChatGPT account latency or full GUI behavior. The native release verifier also
requires this RPC in the executable's generated experimental protocol.
Upstream production schema export uses embedded precomputed archives. Patch
`0043` defines the RPC; `0045` regenerates both 0.166.0 archives with all Cantrip
extensions, including the experimental inference method.
Native protocol tests check that the method and types are exported only with
the experimental API and that the archive matches freshly generated schemas.

## Managed empty-thread attachment

The reviewed empty-thread resume patch lets a second remote client attach to a
live durable thread before its first user message. By-ID resume persists the
existing live recorder and pending metadata before following the normal resume
path. This also covers concurrent joins and retry after a metadata write fails
with the recorder already visible. Metadata reconstructed during cold resume
remains deferred until a new append, as in native behavior. It does not rename
the thread, change its configuration, or submit a model turn. Live paginated
metadata writes are required and report actual SQLite failures; failed updates
remain available for retry. Missing IDs, ephemeral threads and unrelated
persistence errors retain their error behavior.

The worker has opt-in regressions against the built native executable:

```sh
CANTRIP_CODEX_TEST_BINARY="$PWD/cantrip_codex/.build/darwin-arm64/bundle/codex" \
  pnpm --dir cantrip_worker exec vitest run \
  test/native-thread-observation.test.ts test/native-empty-thread-attach.test.ts
```

Run these opt-in tests with Node 24 or later (the metadata failure fixture uses
`node:sqlite`). Use the corresponding bundle path on other platforms. The
fixtures use isolated homes, a local rejecting provider and a harmless MCP catalog. They never use an
account or submit model/computer input. The remote fixture uses independent
WebSocket clients on the same actual app-server; it does not claim to validate
Cantrip's complete GUI/TUI mirroring or command authorization.

## Managed TUI attachment

Reviewed patch `0011` gives the worker an explicit attachment contract:
`CANTRIP_CODEX_ATTACH_THREAD_ID` opts the TUI's initial remote resume into native
`PreserveExistingThread` only when the selected thread has that exact ID.
Embedded sessions, unrelated remote threads, ordinary CLI launches and later
explicit settings changes retain their existing behavior. Native reconnect
already uses the preserving resume path. The same exact managed selector skips
the startup model-migration prompt, which otherwise blocks resume and can enqueue
account-default writes; ordinary CLI launches retain that prompt.

Managed terminal launches require the coordinator's bound thread ID. They keep
the provider's local authentication bootstrap but omit model, effort, permission
and `-C` overrides. The PTY still starts in its workspace. Omitting `-C` avoids
turning attachment into a remote project-trust configuration flow; native resume
supplies the thread's existing cwd and settings. The worker clears inherited
attachment markers before launching unrelated Codex consoles.

The opt-in actual TUI regression can be run against the packaged executable:

```sh
CANTRIP_CODEX_TEST_BINARY="$PWD/cantrip_codex/.build/darwin-arm64/bundle/codex" \
  pnpm --dir cantrip_worker exec vitest run test/native-managed-tui-attach.test.ts
```

It starts the real TUI in isolated PTYs through `TerminalManager`, records its
WebSocket requests with a transparent proxy, and checks live, reopened and cold
attachment. The app-server supplies every response. A local rejecting provider
and harmless MCP fixture detect unintended inference or tool calls. The test
checks the resume payload, native settings and identity, MCP availability, empty
history and unchanged account configuration. Its cold comparison uses an
independent native minimal restore as the baseline; it does not establish that
native storage persists a complete managed profile across unload or restart.
It also does not exercise turn commands or claim complete GUI/TUI mirroring.
An additional native catalog fixture offers a model upgrade and verifies that
ordinary CLI startup still presents it while managed attachment proceeds without
the prompt or configuration writes.

Reviewed patch `0031` preserves WebSocket URL paths in the CLI's `--remote`
parser. Managed gateways use an unguessable path on a loopback listener; replacing
it with a root URL loses the capability. Scheme/host/explicit-port validation and
the existing rejection of query strings and fragments remain unchanged. Explicit
default ports also accept the URL parser's already-bracketed IPv6 host. The
worker's gateway still authenticates the path and mediates native mutations.
The direct-gateway replacement fixture in `native-managed-command-session.test.ts`
uses the actual TUI without a root-URL proxy, so it exercises this parser contract.

## Managed thread configuration

Reviewed patch `0032` adds `thread/managedContext/reset` for an admitted
invalid-compaction retry on the existing native thread. It requires an explicit
nullable `expectedLastTurnId`, compares that boundary against actual durable
history under the native turn lock, and rejects active or stale requests. The
worker admits the continuation before resetting context and then submits its
protected-history recovery prompt through the normal turn path. History,
settings, queue, thread identity and the attached TUI remain in place.

The reset preserves the native authorization transcript and appends and flushes
a history-neutral context checkpoint before changing live model context.
Persistence errors retain live context and fail the operation. Ordinary
compaction records retain their existing wire format; the new `context_reset`
marker defaults to false and avoids fabricating a historical turn for recovery. The next real turn reconstructs model input; the reset itself
does not call the provider or synthesize user input. This does not migrate a
conversation across provider/account runtimes.

Reviewed patch `0012` adds `thread/managedConfig/update` for complete replacement
of a loaded thread's managed MCP servers, developer instructions and child-agent
defaults. It preserves the current root model, permissions, service tier and
collaboration mode. All managed fields are required; an empty server map or a
nullable field explicitly removes that configuration. Validation happens before
publishing the replacement, and the response acknowledges application rather
than claiming MCP initialization or tool success.

Managed `thread/start` and `thread/resume` accept an optional strict `managedConfig` object
with the same five replacement fields, excluding `threadId`. It applies the
replacement before creating a new or cold-resumed session, so excluded
account/project MCP servers cannot initialize first. A loaded shared resume
preserves the live engine; the update RPC then applies changes. Ordinary calls
omit this object and retain their native configuration behavior. The worker also invokes the update operation during
managed preparation. Native startup validates required servers on their actual
connections; catalog discovery does not gate preparation or user input. Idle
eligibility still carries no active-turn authority. Replaced broker connections use new
binding-specific paths; old hosts cannot silently replay calls on a new binding.

The native remote fixture in `native-empty-thread-attach.test.ts` exercises this
operation with two subscribed clients and a separate sibling thread. It tests
catalog replacement/removal and harmless synthetic credential-generation calls,
invalid requests, unchanged root settings, peer continuity and sibling isolation.
The implementation and fixture require a rebuilt bundle containing the patch;
their final packaged-runtime acceptance is recorded in `docs/CODEX_AUDIT.md`.

Reviewed patch `0042` makes the managed runner's thread binding provisional
during fallible native session initialization. Failed or cancelled startup
releases its reservation so the same connection and runner can retry with a new
thread ID. Successful startup commits ownership; failed resumes, overlapping
reservations, explicit bindings, and closed inherited runners cannot release or
reopen that ownership. Required MCP startup errors still propagate normally.
The empty-thread native fixture exercises real MCP startup failure and recovery,
then verifies that another thread or connection cannot steal the recovered runner.

## Cold root settings recovery

Reviewed patch `0013` records a thread-owned settings snapshot on empty-thread
creation without a prompt or model turn. Cold app-server resume restores the
latest snapshot owned by that root thread, including collaboration mode, explicit
service-tier clearing and canonical permission roots. Caller overrides remain
independent, and current managed permission requirements still apply. Foreign,
fork-inherited and ownerless snapshots cannot configure a different root. Legacy
histories retain fallback recovery for fields they actually recorded.

The selected service tier is recovered independently from feature and model
eligibility for an actual request. Omission preserves the recorded selection;
explicit null clears it. An exact root-thread ownership marker carries this
selection through startup filtering without changing request-time tier rules or
leaking the selection into a child, fork or unrelated thread.

Per-thread managed MCP credentials are rehydrated from the current worker; they
are not persisted in the settings snapshot or written to account defaults.
The production-worker fixture combines the real coordinator, worker runtime,
native discovery, MCP hosts and two remote views, including a complete runtime
restart. Run it against the rebuilt bundle:

```sh
CANTRIP_CODEX_TEST_BINARY="$PWD/cantrip_codex/.build/darwin-arm64/bundle/codex" \
  pnpm --dir cantrip_worker exec vitest run test/native-managed-worker-session.test.ts
```

This fixture uses isolated synthetic credentials and a rejecting provider;
it sends no model turn or desktop input. Final validation evidence and remaining
integration work are tracked in `docs/CODEX_AUDIT.md`.

## Manual upstream update

Codex never updates itself inside a released worker. To advance it:

1. Select an official upstream release tag and resolve its peeled commit.
2. Update `ref`, `commit`, and `version` in `upstream.json`.
3. Run `pnpm codex:sync` to replace the tracked projection and regenerate its
   file manifest.
4. Run `pnpm codex:verify` and `pnpm codex:build`.
5. Update Cantrip's tested App Server range and generated protocol fixtures if
   the minor version changed.
6. Run the worker compatibility tests and package each supported target.
7. Review and merge the source update with the matching worker changes.

`codex:sync` refuses a ref that does not resolve to the exact committed SHA or
whose Cargo workspace version differs from `upstream.json`. Updating the JSON
is intentionally manual so no script silently selects a newer release.

The imported source remains licensed by its upstream authors under Apache-2.0;
the exact upstream `LICENSE` and `NOTICE` files are retained in the snapshot.

## Managed history retention

Patch `0017` adds optional `managedConfig.canonicalHistory`. Omission preserves
an existing managed selection; explicit false disables retention for future
turns. Retained turns record exact item IDs and lifecycle evidence alongside
the ordinary compatibility events. Late events keep their original turn's
selection. Sequence gaps and missing terminal evidence are reported as partial
or unavailable, not silently reconstructed as complete.
Coverage describes the committed prefix: a failed final append without a later
checkpoint cannot be detected from sequence gaps alone. Durable acknowledged
ingestion must also capture live events and must not permanently baseline a turn
merely because its terminal checkpoint was read once.

`thread/read` accepts optional `includeHistoryMetadata`. The additive `history`
response distinguishes presentation source, retention coverage, item lifecycle,
nullable timing, scoped token usage, warnings and errors. Current loaded-turn
state is separate from persisted history and does not grant execution authority.
Legacy content and metadata share one record observation. Paginated reads use
the existing projection in a SQLite read transaction and bound evidence by its
checkpoints and fork lineage. Migration preserves retained native IDs without
also publishing compatibility aliases.

The worker reader keeps raw native content local for subsequent encryption and
durable ingestion; this foundation does not replace the existing sync path.
Run its actual-runtime fixture against the rebuilt bundle with:

```sh
CANTRIP_CODEX_TEST_BINARY="$PWD/cantrip_codex/.build/darwin-arm64/bundle/codex" \
  pnpm --dir cantrip_worker exec vitest run test/native-history-foundation.test.ts
```

The fixture uses an isolated home, a synthetic local provider, image-only input,
reasoning, repeated commentary and a harmless command. It compares live, ordinary
read, metadata-only read and cold-restart history for both storage modes, with
retention enabled and disabled. An actual child finishes after its parent to
check inherited retention, late activity, scoped usage and restart recovery.
Validation status is recorded in
`docs/CODEX_AUDIT.md`; a fixture's presence alone is not evidence that it passed.

## Agent communication history

Reviewed patch `0020` emits a distinct `interAgentCommunication` item when an
agent consumes an inter-agent request or message. Its model-context record and
display item share the same native ID. Ordinary legacy and paginated history,
canonical retention, live item notifications and the bundled CLI retain this
item without treating it as a root-user prompt, final assistant answer or extra
tool invocation.

The public item includes author/recipient paths, other recipients, whether the
message triggers a turn, nullable display text and an optional opaque encrypted
payload. A payload marked encrypted is never rendered as plaintext. Cantrip
keeps the source encrypted through its history pipeline and shows an unavailable
notice when display text cannot be recovered. This does not decrypt native
provider payloads or reinterpret unspecified encryption metadata.

This emission applies when a communication is consumed by the patched runtime.
Recovering communication display items from older raw-only histories and showing
mailbox messages before consumption require separate reconciliation work.
Validation status and the remaining acceptance matrix are in
`docs/CODEX_AUDIT.md`.

## Correlated settings snapshots

Reviewed patch `0021` adds optional `operationId` to `thread/settings/update`.
With that field, the response contains the supplied operation ID and the actual
native `submissionId`. This acknowledges queuing, not successful application.
The subsequent `thread/settings/updated` notification carries those same IDs
and the immutable settings snapshot produced by that commit. A correlated no-op
also emits a result, including an empty override or a repeated selection.
Uncorrelated callers retain their existing response and deduplication behavior.

Operation IDs are correlation metadata, not idempotency keys or permission
grants. The managed command owner must still admit mutations before dispatch,
retain uncertain outcomes and avoid replaying input after a lost acknowledgment.
Native asynchronous errors retain their existing submission-ID error path.
The successful event stores its operation ID in native history; older events
without it remain readable. Notifications convert the event's own snapshot
instead of reading a newer live configuration after another change.

The opt-in `native-settings-correlation.test.ts` fixture exercises real native
queue acknowledgments and applied snapshots in both history formats, including
malformed-value rejection, custom effort values, repeated/no-op changes and
service-tier set, omission and clearing. It also invokes the packaged CLI's
schema export to check the implemented settings and managed API surface.
The requested tri-state must remain
separate: Core intentionally reports an explicit `null` clear as the `"default"`
tier marker. Full Cantrip desired/pending/effective settings synchronization
remains a separate integration requirement; the native
fields alone do not implement that product state. Current validation evidence is
recorded in `docs/CODEX_AUDIT.md`.

## Versioned settings reads

Reviewed patch `0023` adds experimental `thread/settings/read` for an already
loaded thread. It reads the thread's selected settings without resuming the
thread, changing configuration, submitting model input, or starting MCP. An
unloaded or invalid thread returns the native lookup error. A read is not a
barrier for queued settings operations: an acknowledged update may still be
pending when the snapshot is taken. Use its correlated applied notification to
establish that the update took effect.

Live settings carry `settingsVersion: { epoch, revision }`. Core captures both
settings and version under the same state lock, including immutable applied
snapshots. A changed selection increments the decimal u64 revision; a no-op
retains it. The epoch changes when Core is replaced. Revisions are comparable
only within an epoch, and a current read supplies a replacement baseline. Older
historical snapshots can omit the version; persisted old epochs do not become
current merely because their result is delivered late.

Cantrip retains newer observed state if an older read arrives afterward. Equal
versions with conflicting content are reported without replacing the known
selection. Operation evidence still records older applied requests even when a
newer selection is confirmed. Thread/transport retirement clears the observation
scope; neither these versions nor local observation counters are server settings
revisions or execution grants. These are thread selections for subsequent work,
not proof that an already-running turn changed its pinned model/settings.

Canonical desired/pending/effective settings publication remains an integration
requirement. Validation and remaining work are recorded in `docs/CODEX_AUDIT.md`.

## Worker inference admission

Reviewed patch `0048` uses the existing connection-owned managed execution channel
for private inference admission, suspension, resumption, and terminal receipts. It
does not create another prompt queue or grant capacity in Core. The worker owns
provider limits and FIFO order; Core supplies actual sampling and wait boundaries.

Root turns can reuse their worker reservation, while child turns, speculative
compaction, manual compaction, and Guardian classification account for independent
execution. Parent dependency/approval waits yield only after parent sampling stops;
resumption reacquires before further inference. A Guardian reservation follows its
transport through cancellation/draining, including when its observer disappears.

The source patch was formatted and applied to an owned copy of its pre-patch source.
No native build, tests, benchmarks, or computer-use validation were run under the
current goal's restriction. Normal future packaging fingerprints the ordered patch
set; this change does not manufacture a prebuilt binary or update upstream hashes.

Patch `0052` extends the existing worker lifetime keeper's admission journal with
atomic recovery adoption and acknowledgement. Only the current scope owner may
reconcile previous-generation records, using captured revision and canonical
chat/message identity. Proven unstarted attempts can transfer their oldest
same-provider ordinal to one replacement; changing providers retains the new
destination ordinal. The durable replacement and removal of old metadata share
one snapshot write. Redelivery after an unobserved acknowledgement returns the
same replacement. Potentially executed input cannot use this adoption path.
This is metadata ownership, not another native prompt queue. No new runtime
binary was built or executed under the active goal's validation restriction.

Patch `0053` records receipt of the worker's native grant in the regular/restored/
manual-compaction turn's extension store. Cancellation before that receipt is
retired from goal accounting instead of entering empty-response retry evaluation.
Existing empty-response history, token accounting, and native goal elapsed time
keep their meaning. This marker observes admission; the worker remains the only
capacity owner. Separate execution/queue-time integration still requires the
canonical timing handoff, including the outer wait before a first `turn/start`.

This source patch was reviewed and formatted only. No native build, tests,
benchmarks, helper execution or computer-use validation ran. It adds no public
RPC or generated protocol shape and does not modify upstream snapshot hashes or
manufacture a prebuilt runtime.

Patch `0054` distinguishes independent helper admission from a root turn's
`begin`, including Guardian and speculative background compaction. These requests
cannot bind a dispatched root before
its `turn/started` observation or borrow its reservation. Exact operation identity
still governs their suspension, cancellation and settlement. The corresponding
worker accepts `begin-independent`; older workers deny that unsupported private
phase. Memory extraction and response transport ownership remain audit work.
Only source review, formatting and diff checks were performed; no native binary
was built or executed.

Patch `0055` retains inference ownership through actual HTTP dispatch/body tasks
and WebSocket response cleanup. Managed model clients serialize their requests
through transport teardown. Ending or suspending a turn cannot release its
ticket while a retained response task can still run; native `finish` follows
that cleanup. Cancellation retires failed WebSocket pumps by aborting and joining
them. The worker distinguishes this private settlement from earlier UI turn
completion and treats private entry as positive native-start evidence.
SDK outcomes await the corresponding confirmed ticket release before retry or
provider transition; this does not block native control-frame delivery.

Regular/foreground/speculative compaction clients use the binding, with an API
for independently admitted model-client helpers. Memory extraction admission and
stateless labeling's explicit drain path remain separate goal work. Source-only
review and formatting were performed; no native binary was built or executed.

Patch `0056` adds independent worker admission to parallel memory extraction and
binds each helper to model-client transport ownership. The existing bounded local
preparation queue renews every canonical job claim while waiting, including work
not yet inside that local bound. Claim loss cancels only the matching operation;
transient database errors cannot release inference capacity. Cancellation is
reported as skipped work without consuming extraction retry budget. Abandoned
claims use their existing lease-expiry recovery.

Memory consolidation starts through the existing internal-child API with its
actual parent, retaining the shared inference channel without rebinding that
parent's root gate. Its ordinary native turn owns separate capacity, and existing
consolidation heartbeats cover capacity waits. Only source review, direct Rust
formatting, mechanical patch generation and diff checks were performed. No native
binary, test, build, benchmark or computer-use validation ran.

Patch `0057` retains stateless labeling transport ownership through success,
failure and its existing 25-second native execution deadline. Core cancels and
awaits real response cleanup before the catalog RPC replies; a timeout alone
cannot release the worker's outer ticket. This scope requests no nested grant,
so a same-provider title and first response continue sharing one serial ticket
at limit one. Existing worker/server observation budgets and timeout error
classification remain. Source review, Rust formatting, mechanical patch
generation and diff checks ran; no runtime, tests or builds were executed.

Patch `0058` identifies each native inference lifetime with a fresh private scope
UUID, independently of reusable logical thread/turn IDs. All admission, suspension,
resumption, cancellation and terminal notifications carry it; positive resolver
acknowledgements must echo that exact scope. Older mismatched peers deny admission
rather than silently use an unscoped ticket. The worker can bind a root reservation
to only one scope, and late old receipts cannot settle its replacement. No public
schema is changed. Source review, formatting, patch generation and diff checks
ran; tests, builds and native execution remain unrun.

Patch `0059` adds an inference-only mode to the existing connection-owned native
channel for Task-created threads. Task rounds and dispatch records retain input
ownership; their native Goal cycles, children, compaction and dependency waits
use the same worker inference boundary as IDE agents. Configuring or resuming a
Task Goal installs the channel before activating the Goal. This mode does not
request managed GUI input receipts or create another scheduler. External Task
Goal activation and cold resume defer their initial automatic kickoff to the Task
owner's explicit input; subsequent completed-turn idle events still continue the
Goal. Interrupted Task turns cancel their inference scope without permanently
invalidating the channel needed by a later explicit resume.

A connection cannot reuse a gate generation with a different admission kind or
downgrade an existing managed input guard to inference-only mode. Live channel
installation binds the exact native thread, and replacement checks the actual
inference owner even when it does not manage input. Existing full managed runners
keep their behavior. Task permission selection and existing child defaults are
preserved by the worker's separate preparation intent.

The optional native configuration field is reflected in the checked-in
TypeScript/JSON and precomputed exports. Lifecycle integration found that the
original binary patch used snapshot bases from an older patch series, preventing
the normal build from applying it. Both compressed snapshots were regenerated
with the actual Rust schema generator against the preceding reviewed patches,
and the binary patch now names those actual bases. All earlier exported paths
remain present; the only schema change is the optional `inferenceOnly` field.
The checked-in JSON fixtures were aligned with the generator's newline format.
Both generator modes and all four schema fixture/export comparisons passed.

Patch `0060` retains explicit Task input receipt metadata in the lifetime
keeper's admission journal. The canonical encrypted round remains on the server;
the journal contains only its opaque attempt, placement, lane activation, route
and dispatch-fence identities. A current worker can adopt an older Task ticket's
FIFO order after the server positively confirms that its input authority was
revoked before forwarding. This also covers a reservation used only for naming.
The private adoption reference carries that confirmation and still checks the
captured journal generation/revision and the same canonical Task/chat/message.

Potentially dispatched Task input without exact native no-start evidence is not
replayed. The existing never-granted/never-started rules for other operation kinds
remain unchanged. This changes only the private CLI journal, not native public
RPC or precomputed schema exports. Only source review, direct formatting,
mechanical patch generation and diff checks were performed; no native execution,
tests or builds were run.

Patch `0061` retains the original continuation through resumption preparation,
including an actual directory-sync failure after atomic replacement. Its
`0.166.0/cantrip-suspension-v3` contract keeps the confirmed capture identity
stable while physical store revisions advance. A prepared record grants no
execution authority; explicit Resume still requires fresh admission.

Turn-bound controls and readiness acknowledgements share a control generation.
A newer Pause fences an older Resume before checkpoint I/O, failed preparation
releases only its own reservation, and Stop confirms native terminal history.
Cold restoration also works through the legacy Resume control without another
TurnStarted event. Observer running status follows successful admission.
The normal macOS ARM64 release build of all 62 patches and the eight native
pause fixtures passed, including both history formats and actual scoped
admission handshakes. The existing live-pause unit fixture now supplies the
turn context and boundary snapshot required by native checkpoint capture.
Product pause adoption, Goal/resource continuation and complete worker restart
acceptance remain separate required work. See
[durable turn suspension](../docs/DURABLE_TURN_SUSPENSION.md).

Patch `0062` records failure-before-output at the actual admitted model-stream
boundary, after response interceptors and before Core can consume output or run
tools. It ignores transport/model metadata, treats completion and every output
event conservatively as output, and keeps that evidence monotonic across all
sequential requests in the physical scope. Stream errors, early close and request
setup failure record failure. WebSocket prewarming is excluded.

The existing private `finish` notification carries the result only after owned
response transports settle. It is matched to the exact native scope and runtime,
not inferred from missing UI activity or a response timeout. This changes no
public native RPC or precomputed schema archive. The evidence describes this
local model scope; it does not promise exactly-once provider execution or
authorize replay of a restored checkpoint's original prompt. Only source review,
direct formatting, mechanical patch/contract generation and diff checks were
performed for this patch; no native execution, tests or builds were run.

Patch `0063` adds the optional explicit Task Goal input kind to the private
admission keeper journal. Adoption requires the same kind as well as the existing
canonical chat/message, worker and dispatch identities. Ordinary round receipts
omit the new field, preserving their serialized recovery identity. Goal inputs
reference the server's original protected message and existing dispatch cycle;
the journal stores no prompt content. This patch changes no public native RPC or
precomputed schema archive. Source review, direct formatting, mechanical patch
generation and diff checks were used; no native execution or tests were run.

Patch `0064` preserves a durable suspension during ordinary runtime shutdown and
App Server input EOF. It fences resumption readiness and detaches the held task
before normal cancellation can record a terminal turn. Task cancellation/joining
and security-lease release are shared with the upstream suspension handoff.
The continuation stays committed while process-local resources are released.
SessionEnd hooks are skipped for suspended teardown; ordinary completion and
Stop retain their existing hook and terminal behavior. This does not change the
checkpoint format or grant execution authority. The existing intercepted-stream
unit fixture supplies the unmanaged inference argument introduced by `0062` so
native test-target compilation can validate the current series.
The legacy `turn/interrupt` operation also stops a cold held turn through its
existing durable cancellation path. Loaded history preserves the held turn's
unfinished lifecycle while reporting the idle thread's actual status. This keeps
native TUI reattachment from falsely displaying an interruption.
The normal 65-patch macOS ARM64 release build and all 12 native suspension/shared
pause cases passed, including two physical TUI cold-resumption cases.
Product recovery, Goal/resource continuation and complete worker-tree acceptance
remain required work.

Patch `0065` gives the existing inference keeper journal a private `bindNative`
mutation. Core's private inference begin durably binds its exact thread, turn
and physical scope to the current ticket before the worker can allow model
execution. Root turns reuse their existing reservation, including a serial
same-provider title; independent native operations bind their own tickets.
The binding is immutable, idempotent, generation-owned, and preserves the FIFO
ordinal. It is correlation metadata, not evidence of completion or permission
to replay an input. A cancelled or retired grant cannot use a late write reply
to start. The optional journal field preserves older unbound records. No public
native RPC or precomputed schema archive changes. This patch requires its paired
worker and keeper update. Source review, direct formatting, mechanical patch and
protocol generation, and diff checks were performed; no native execution, patch
verification helper, tests or builds were run. Checkpoint/result reconciliation
and the remaining inference lifecycle audit are still required.

Patch `0066` adds versioned extension bookkeeping to the private v4 continuation.
The Goal extension preserves original-turn usage baselines, descendant usage,
failure/empty-turn streaks and fractional elapsed accounting. Durably paused and
offline time is excluded. Restore reconciles actual persisted Goal counters, and
cold Stop settles reconstructible usage before retiring the continuation. Short
native control guards fence stale callbacks without retaining execution grants.
The v3 suspended payload remains inspectable and stoppable but cannot be resumed
under v4. The verified 67-patch development build passed all 28 native cases,
including 16 Goal cases. Fifteen accounting tests, 27 Goal backend tests and the
SQLite continuation-hold test passed. Final native acceptance used the development
profile; optimized product and complete worker-tree acceptance remain pending.
Resource recovery and worker/server/client adoption remain required work.

Patch `0067` adds the private `thread/managedExecution/inferenceClaim` operation.
It confirms the exact live pending inference gate on its owning connection,
including child scopes, without granting provider capacity or consuming the gate.
The worker uses that authority to retire completed private-scope ticket records
through opaque operation lifetimes, while preserving exact redelivery for held
handles. Stale requests cannot originate another ticket after cache compaction.
The worker and native runtime require a paired update. This milestone used source
review, direct formatting, mechanical patch authoring and diff checks only; no
native helper, patch application verification, tests, builds or computer-use
validation was run. Legacy outer-turn/helper retention remains separate work.

Patch `0068` extends the private continuation contract to v5 for input accepted
while a native turn is durably held. The checkpoint commits exact history-item
digests before an explicit Goal instruction is appended to native history, and
commits pending injected input before publishing acceptance to the live queue or
acknowledging the Goal mutation. History remains the sole transcript. Unprepared,
duplicated or reordered execution history still invalidates resumption; a prepared
append that never reached history leaves the original recovery boundary usable.
Checkpoint amendments advance the physical storage revision while retaining the
confirmed capture identity returned to the caller.

Final capture and injected input acceptance share a native mutation boundary. Goal
accounting and steering are prepared under the existing Goal mutation permit,
and capture acquires its input boundary after extension capture to preserve lock
ordering. Fresh restoration installs the latest committed pending input, including
input accepted after attaching the held thread, without starting another turn.
Later user authorization is restored with its original acceptance order without
appending its history item again. Actual persistence failures reject acceptance;
they do not discard the last committed checkpoint or substitute a new turn.

The v4 suspended format is retained for inspection and explicit Stop, but requires
its matching runtime for Resume. No runtime upgrades a held continuation silently.
This is a native input-boundary milestone. Background resource recovery and the
server-owned, restart-persistent product pause controls remain separate required
work before whole-worker durable pause is available.

The verified 69-patch development runtime passed 42 native cases, including 30
Goal cases covering accepted edits before and after pause, edits after fresh
attachment, repeated cold resumes, actual checkpoint-path failures and repaired
history evidence. Eight focused Core tests and 44 Goal accounting, backend and
steering tests passed. Core unit checks used the upstream helper's 8 MiB test
stack size after the initial notification test overflowed the default stack.
Optimized product and whole-worker process-tree acceptance remain pending.

## Goal budget time while waiting for inference

Patch `0069` observes the actual native `begin`/`resume` admission future with a
thread-owned monotonic queue clock. Goal progress subtracts those waits live, so
FIFO reacquisition after a confirmed suspension cannot spend the Goal's time
budget. Cancellation drops the same wait guard. Ordinary tools, active response
streams, child work and non-Goal total-elapsed metrics keep their existing meaning.
Independent background inference does not pause a concurrently executing parent.

The clock stores cumulative duration and active-wait state, without a completed
request history. Durable Goal checkpoints continue to save net elapsed work in
the existing format; restoration reattaches the actual thread's queue clock and
resets its baseline before resumption, preserving fractional work without counting
the offline interval or subtracting an old wait again.

The original `0069` delivery received source review and formatting without a
native build. PR #2593 repaired its normal patch application. The completed
terminal milestone below includes an actual runtime build and Goal regression
checks with that patch applied; whole-worker acceptance remains outstanding.

## Completed terminal resource continuation

Patch `0070` adds encrypted completed-terminal continuation data under native
contract `0.166.0/cantrip-suspension-v6`. Capture joins real output/history
producers and preserves unread output and byte-omission counts. A fresh process
restores the original terminal IDs as read-only completed records, without
launching a command or retaining launch authority. Active commands and open
output producers still refuse durable acknowledgement with live controls intact.

The connection-owned native resource bridge uses the actual worker's current
`chat-content` grant. Checkpoint data contains only a versioned AES-GCM envelope;
opening a held thread does not decrypt it. Explicit Resume revalidates the grant,
and Stop can discard the continuation without it. The normal runtime verifier
also checks the generated private bridge contracts. Resource and full product
acceptance are tracked separately in [the suspension contract](../docs/DURABLE_TURN_SUSPENSION.md).

The normal 71-patch macOS ARM64 development build passed all 62 native acceptance
cases, including 20 terminal-resource cases using the actual worker protection
handler and fresh encryption grants. Large output, repeated cold suspension,
concurrent Resume, grant repair, Stop during restoration and read-only input
errors preserve the original thread/turn identities and completed effects.
Full worker/server/client recovery and optimized product acceptance remain
outstanding.

## Withdrawing a response before alternate-provider naming finishes

Patch `0071` adds the keeper's atomic `sealUnstarted` mutation. An actual canonical
response source can be sealed before requesting any provider capacity, while its
private title operation uses another provider's ticket. The mutation records only
released, never-granted, never-started metadata and rejects an existing operation
that could have inferred. Exact same-generation redelivery preserves its proof.
It neither grants a ticket nor writes prompt content.

The worker seals the response lifetime before cancelling the private label and
waits for label settlement before publishing no-start evidence. Existing handoff
deferral acknowledgement and source cleanup still precede history transfer.
The native keeper and worker must be upgraded together. This patch received
source review and mechanical authoring only; it was not applied, built, tested or
executed. No native/helper or computer-use validation ran for this change.

## Finalized CodeMode resource continuation

Patch `0072` extends protected resource data with finalized JSON values and cell
identity bookkeeping under `0.166.0/cantrip-suspension-v7`. The gRPC
CodeMode host exports only after cells and completion producers are quiescent.
Explicit, freshly authorized Resume imports that data without evaluating cells
or replaying tools. Capture never reconnects a missing host to an empty session;
explicit import can recover a lost helper. Core selects this transport with
`features.code_mode_host_grpc=true`. The default framed-stdio transport still
returns an explicit unsupported error; completing its state transfer is the next
native dependency. Unsupported providers never report empty state.
See [the suspension contract](../docs/DURABLE_TURN_SUSPENSION.md) for resource
limits, live controls, compatibility and the outstanding product integration.

## Default framed CodeMode continuation

Patch `0073` implements finalized-state transfer for the default framed-stdio
provider, using negotiated `stored-state-v2` controls and actual completion and
forwarding-producer joins. A fresh live lease stays separate from the saved
public cell namespace, so late replies and retries preserve cell identities.
The gRPC path retains the same recovery behavior. Export never replaces a dead
host with empty state; only explicit import can recover it.

Native contract `0.166.0/cantrip-suspension-v8` uses CodeMode state format 2.
Native counters are decimal strings on the wire to avoid JavaScript JSON number
rounding. Earlier formats require their matching runtime and remain preserved
for inspection or Stop. Full worker/server/client recovery and optimized product
acceptance remain outstanding; see [the suspension contract](../docs/DURABLE_TURN_SUSPENSION.md).
