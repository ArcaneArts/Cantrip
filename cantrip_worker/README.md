# Native Cantrip worker

This crate builds the `cantrip-worker` executable used by Cantrip development,
desktop, standalone, and hosted packaging. See the
[implementation ledger](../docs/RUST_WORKER_PORT.md) for coverage, compatibility
fixtures, and the validation recorded for each milestone.

- Build with `pnpm worker:rust:build`.
- Use `pnpm worker:dev` to watch for changes or `pnpm worker:start` to run once.
- Run focused checks with `pnpm worker:rust:check` and `pnpm worker:rust:test`.
- Package with `pnpm package:worker --target <target>`. See the
  [standalone distribution guide](../deploy/worker.README.md) for launch
  commands, environment variables, and enrollment.

The worker runs with the existing profile paths and credentials. Optional flags
include `--env-file-if-exists=<path>`, `--shutdown-on-stdin-close`, `--version`,
and `--help`. Use a disposable profile and explicit enrollment for integration
checks. Keep one worker process per mutable profile.

The Cargo wrapper shares the bounded Rust cache. Build-time tooling can use Node
to resolve the Cantrip version. The packaged executable and bundled first-party
helpers run natively. The worker crate uses shared protocol, transport, endpoint
crypto, history, and host code independently of the Rust server and database.

## Early implementation and compatibility fixtures

These notes record early port milestones. The
[current runtime](../docs/RUST_WORKER_PORT.md#current-runtime) and later
milestones in the ledger describe production integration and compatibility.

The initial native `cantrip-worker` executable implemented configuration,
version-1 identity/credential persistence, logging/archive lifecycle, enrollment,
heartbeat, WebSocket readiness/reconnect, version queries, credential rotation,
in-process restart, log reads, authenticated encryption-grant refresh and workspace
repository discovery/import validation, encrypted workspace-root attachment and
managed-folder creation/attachment/deletion. It retained compatible endpoint
encryption identities using native P-256/HPKE and private version-2 records.
Later milestones delivered Host Explorer and file-document operations, Git and
GitHub, worktrees, terminal services, and project replicas.

The implementation reuses `cantrip-config`, `cantrip-wire`, `cantrip-host`,
`cantrip-logging`, `cantrip-protocol`, `cantrip-framing`, `cantrip-crypto`,
`cantrip-history` and `cantrip-transport`, without a server or database dependency.
The worker also uses the same pure vendored ICU library as the server for Node
locale ordering, without linking the server application or database.
Credentials omit `Debug`. Initialization loads the optional environment file synchronously
before starting Tokio/archive threads. Shutdown joins owned producers and closes
the archive before another runtime starts with the same durable identity.

Run `pnpm worker:rust:build`, `pnpm worker:rust:check` and `pnpm worker:rust:test`
locally. The Cargo wrapper shares the bounded server/library cache without PGlite
discovery. Build-time version embedding uses the existing Node development
resolver; the compiled executable does not run Node.

Launch the built binary using the existing worker environment variables. Optional
flags are `--env-file-if-exists=<path>`, `--shutdown-on-stdin-close`, `--version`
and `--help`. Before testing, use a disposable profile and explicit enrollment;
do not run Node and Rust workers against the same mutable profile.

Authenticated bootstrap validates principal/server/owner bindings, opens scoped
grants, persists revision high-water values, and fences stale refresh results.
Heartbeat publication and `worker.encryption.refresh` use this service; transient
failures retain keys, while invalid authorization/revocation clears them. Refresh
work and coalesced retries survive an abandoned caller and are joined at shutdown.
`protected_secrets` implements provider API/credential and MCP configuration
protection, public expiry metadata, subject/name blind indexes and reserved-name
guards. It uses an atomic snapshot of the authorized component key and its
owner/server binding. The helpers preserve the Node worker's latest-key selection
policy; they do not implement provider execution or MCP processes.

`cantrip-crypto::content` supplies protected secret, endpoint, display-label and
attachment formats plus surface/remote-surface streams and tunnel data AEAD.
`protected_content` adapts endpoint bytes/JSON and surface streams to real grants.
Endpoint opening selects an explicitly granted historical revision; surface
opening requires the latest grant. Decrypted UTF-8, BOM/JSON and content-schema
errors preserve the reference's distinct authentication boundary.

The surface replay guard consumes a sequence at reservation, validates acceptance,
retains bounded completed operations and supports explicit release. Resource
services must own/reset it with their authorization lifetime. Remaining domain
adapters, serving transports and revocation hooks are still pending. A stored
identity or stateless chunk crypto alone does not authorize a transfer.

`workspace` serves the real `workspace.repositories.discover` and
`workspace.repository-import.validate` commands. It traverses attached roots,
classifies actual Git checkouts/origins and rechecks repository fingerprints.
Progress events use the existing correlation envelope. Git/gh subprocesses have
bounded output/timeouts and are stopped/joined with their runtime.

`routing` reopens version-1 `repository-routing.json`, resolves opaque handles and
publishes field-scoped tokens through private atomic snapshots. The workspace
adapter protects paths/results/errors before they leave the worker. Managed-folder
creation/removal, existing attachment and workspace-scoped placement are also
enabled. `repository_operations`
serves encrypted root attachment and repository metadata registration/resolution,
with replay reservation, current-key selection and protected outcomes. Git/GitHub
operations and other domains remain pending.
Fresh and existing attached profiles can discover and import through the
production Rust server.

The configuration, HTTP, crypto, grant, content and workspace examples are development-only differential drivers
that emit synthetic secrets. Never run them against real profiles.

`filesystem` owns the reusable OS path/child helpers, project-source normalization,
workspace storage placement, checkout inspection and managed-folder service.
`folders::Manager` creates, resolves and deletes Cantrip-owned UUID directories;
it attaches existing directories without taking ownership. The public command adapter
uses the existing private routing registry and typed attachment errors. System,
legacy and attached storage retain worker-level placement; managed workspaces get
isolated roots with verified directory boundaries. Existing file URLs and native
Windows drive/UNC/namespace representations are normalized without filesystem
probing; actual attachment uses canonical directory metadata.

Git checkout inspection preserves linked-worktree common-directory fingerprints
and actual gh lookup behavior. Git calls retain ten-second/one-MiB limits; gh API
calls retain the existing absent timeout and 32-MiB output limit. Both belong to
an owned stop/join scope. The original workspace Scope/ProcessError exports remain
compatible. Future native run-configuration/process services must integrate their
pre-deletion stop hooks before production cutover; those runtimes do not exist in
the current native implementation. Basic host Explorer and file-document text
operations are implemented; paged readers, transfers, watches, media and other
filesystem services remain pending. See the ledger for current coverage.

### Native history transport

`history::client::Client` implements binding open, canonical item resolution,
prepared-batch ingest/delivery, and item/turn/batch archive readers using the
existing authenticated HTTP endpoints. Callbacks supply the current credential
on every attempt and the metadata publication lifetime. It never dispatches
native input or grants execution authority.

Only open/resolve metadata retries transient HTTP/network failures, with the
original parsed body, a 30-second deadline and the existing 250ms-to-2s backoff.
Batch ingestion and archive reads do not retry implicitly. Strict response
contracts, correlated canonical receipts, matched permanent rejection proofs,
archive scope/snapshot/cursor/content integrity and UTF-8 turn ordering remain
compatible. Redirects are rejected; private response bodies are not echoed.

Public calls start owned requests using `cantrip-transport`; abandoning a response
does not stop accepted work. Explicit caller/metadata signals cancel the actual
network wait. Metadata backoff cancellation retains Node's AbortError wrapper
and cause. The runtime owner must finish/cancel accepted work before shutdown.

Focused local verification:

```sh
node scripts/worker-rust/cargo.mjs build --example history-client-fixture --example history-source-fixture
node --import tsx scripts/worker-rust/history-client-compatibility.mjs --binary /absolute/shared-target/aarch64-apple-darwin/debug/examples/history-client-fixture
node --import tsx scripts/worker-rust/history-client-smoke.mjs --client /absolute/path/to/history-client-fixture --history /absolute/path/to/history-source-fixture --server /absolute/path/to/cantrip-server --repository /absolute/path/to/project-repository-fixture
```

The smoke runs the native client, projection, and outbox against Rust server
history routes and loses a real canonical ACK before restarting both processes.
Rendered input and enrollment in this smoke use fixtures. The ledger records
later production rendering, attachment, capture, retry, and execution integration.

`history::preparation` supplies worker locale policy to the shared pure usage
kernel and native turn preparation. `history::recovery::read` collects pinned item,
turn and batch pages with the real HTTP client. An actual snapshot-changed 409
discards partial pages and retries; permanent errors propagate. Decryption starts
only after every resource is coherent. Caller cancellation remains live through
fetches, offloaded decryption and the existing 100ms conflict delay. Reporting
callback errors cannot stop recovery. Recovery never advances a projector cursor.

### Native inference ownership and journal

`inference::ownership::Owner` talks to the existing bundled Codex Rust lifetime
keeper. It claims one server/owner/worker scope, prepares native runtime
registrations, carries correlated journal requests and retires runtimes only
after the actual keeper acknowledges their OS leases. Closing the owner sends
stdin EOF and waits for its child and pipes to close. The keeper deliberately
does not use the model process's parent-death/job policy: it must finish fencing
native leases after its parent exits. Failed initial claims can retry after the
failed helper actually closes; an already claimed generation cannot reclaim
ownership after losing its keeper.

`inference::journal::Journal` supplies validated snapshots, stable recovery/key
identities, bounded mutation batches, transition acknowledgements, recovery
adoption/forget and shutdown flushing. Accepted mutations survive an abandoned
result future. Adoption preserves provider-relative queue order and chunks
physical aliases within the existing frame budget. `AdoptOptions::assert_current`
is the canonical operation owner's cancellation check, called before each chunk.

These are native library implementations. The worker-wide admission/capacity
manager and Codex runtime orchestration still need to integrate them with managed
sessions, execution, queues/settings and task/goal recovery before native
inference becomes a supported production capability.

Focused local commands:

```sh
node scripts/worker-rust/cargo.mjs test -p cantrip-worker --lib inference::journal::tests
node scripts/worker-rust/cargo.mjs build --example inference-journal-fixture
node --import tsx scripts/worker-rust/inference-journal-contracts.mjs
node --import tsx scripts/worker-rust/inference-journal-compatibility.mjs --binary /absolute/path/to/inference-journal-fixture --codex /absolute/path/to/bundled/codex
```

The compatibility driver uses owned disposable profiles and the real native
keeper, including real registered Codex app-server retirement without inference.
Node runs only the development reference; native children have Node absent from
PATH. Do not point fixtures at an active user profile.

### Worker-wide admission

`inference::admission::Manager` now owns provider-wide FIFO pools across native
runtimes and direct HTTP execution. It preserves provider configuration/catalog
revisions, opaque canonical lifetimes, exact redelivery, durable enqueue/grant
barriers, cancellation versus settlement, parked permission, suspension/resume,
private no-start withdrawal and previous-generation recovery/adoption.

`Source::claimed` requires an actual one-time canonical claim from its caller;
an operation ID alone supplies no authority. Direct redelivery joins the original
execution result. `with_preparation` mints an opaque context only from the actual
unused native grant, borrows same-provider capacity where allowed and joins all
accepted child callbacks before native dispatch can continue. Cancellation and
runtime retirement retain capacity through real callback/body teardown.

The manager uses the existing native keeper/journal and shared protocol/wire/
transport mechanisms. State transitions reserve capacity synchronously; ordered
IO prefixes and callbacks run outside the state mutex. Snapshot subscribers and
diagnostics cannot own admission. The worker cancellation primitive now composes
signals while retaining initial input order and subsequent cancellation chronology.

The fixture covers the worker-wide admission manager. Later milestones in the
ledger record its Codex adapter, runtime ownership, server reconciliation, and
production model, queue, and Task wiring.

```sh
node scripts/worker-rust/cargo.mjs test -p cantrip-worker --lib inference::admission::tests
node scripts/worker-rust/cargo.mjs test -p cantrip-worker --lib metadata::tests
node scripts/worker-rust/cargo.mjs build --example admission-fixture
node --import tsx scripts/worker-rust/admission-contracts.mjs
node --import tsx scripts/worker-rust/admission-compatibility.mjs --binary /absolute/path/to/admission-fixture --codex /absolute/path/to/bundled/codex
```
