# Native Cantrip worker

This package is the incremental Rust worker replacement. See
[the implementation ledger](../docs/RUST_WORKER_PORT.md) for complete scope,
coverage, compatibility and delivery milestones. Production packaging continues
selecting the Node worker until the complete implementation is ready.

The native `cantrip-worker` executable currently supports configuration,
version-1 identity/credential persistence, logging/archive lifecycle, enrollment,
heartbeat, WebSocket readiness/reconnect, version queries, credential rotation,
in-process restart, log reads, authenticated encryption-grant refresh and workspace
repository discovery/import validation, encrypted workspace-root attachment and
managed-folder creation/attachment/deletion. It opens
and retains compatible endpoint
encryption identities using native P-256/HPKE and private version-2 records. The
ledger also records delivered host Explorer/file-document, Git/GitHub, worktree,
terminal-service and replica operations. Unimplemented domains fail explicitly and
advertise unavailable capabilities. This is not yet the complete production replacement.

The implementation reuses `cantrip-config`, `cantrip-wire`, `cantrip-host`,
`cantrip-logging`, `cantrip-protocol`, `cantrip-framing`, `cantrip-crypto`,
`cantrip-history` and `cantrip-transport`, without a server or database dependency.
The worker also uses the same pure vendored ICU library as the server for Node
locale ordering, without linking the server application or database.
Other shared foundations will be integrated with their owning domains. Credentials
omit `Debug`. Initialization loads the optional environment file synchronously
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

## Native history transport

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

The smoke runs the actual native client/projection/outbox against Rust-server
history routes and loses a real canonical ACK before restarting both processes.
Canonical content preparation and the enrollment/control worker remain reference
fixtures. Production capture, canonical rendering/protection, coherent archive
recovery and execution integration remain pending; the production worker still
selects Node.
