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
responses proxy, platform sandbox helpers, and a hash-checked runtime manifest
into `bin/`. The bundle also carries the upstream Apache-2.0 `LICENSE` and
`NOTICE`, and the Worker verifies every listed executable and notice before it
starts Codex.

Upstream release tags update their workspace manifests from development
version `0.0.0` without updating those same local-package version fields in
`Cargo.lock`. The build script copies the verified source into its ignored
build directory and normalizes only those workspace-local versions from Cargo
metadata before invoking `cargo build --locked`. Registry and Git dependency
versions, checksums, and revisions remain exactly as pinned upstream, and the
tracked source snapshot is never modified. The runtime manifest fingerprints
the ordered patch set so changing a patch invalidates cached binaries.

Codex 0.153.4 continues to use Rusty V8's heap sandbox for the code-mode host.
Those artifacts are published on a separate official OpenAI Codex release
rather than the upstream Rusty V8 release. The build resolves the pinned `v8`
crate version and native Rust host target, downloads the same archive and
generated binding used by Codex's release workflow, verifies both against
OpenAI's two-entry SHA-256 manifest, and supplies them to Cargo. This preserves
the upstream V8 sandbox without compiling V8 from source on every Cantrip
target.

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

## Managed thread configuration

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
managed preparation and checks the actual MCP catalog after application. Idle eligibility
still carries no active-turn authority. Replaced broker connections use new
binding-specific paths; old hosts cannot silently replay calls on a new binding.

The native remote fixture in `native-empty-thread-attach.test.ts` exercises this
operation with two subscribed clients and a separate sibling thread. It tests
catalog replacement/removal and harmless synthetic credential-generation calls,
invalid requests, unchanged root settings, peer continuity and sibling isolation.
The implementation and fixture require a rebuilt bundle containing the patch;
their final packaged-runtime acceptance is recorded in `docs/CODEX_AUDIT.md`.

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
