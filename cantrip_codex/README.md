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
