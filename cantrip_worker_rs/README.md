# Native Cantrip worker

This package is the incremental Rust worker replacement. See
[the implementation ledger](../docs/RUST_WORKER_PORT.md) for complete scope,
coverage, compatibility and delivery milestones. Production packaging continues
selecting the Node worker until the complete implementation is ready.

The native `cantrip-worker` executable currently supports configuration,
version-1 identity/credential persistence, logging/archive lifecycle, enrollment,
heartbeat, WebSocket readiness/reconnect, version queries, credential rotation,
in-process restart, log reads and authenticated encryption-grant refresh. It opens
and retains compatible endpoint
encryption identities using native P-256/HPKE and private version-2 records. Remaining domains fail explicitly and advertise
unavailable capabilities. This is not yet the complete production replacement.

The implementation reuses `cantrip-config`, `cantrip-wire`, `cantrip-host`,
`cantrip-logging`, `cantrip-protocol` and `cantrip-crypto`, without a server or
database dependency.
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
attachment formats. Remaining domain/stream adapters, replay state and resource
revocation hooks are still pending. A stored identity alone never authorizes a
component key, and stateless chunk crypto alone does not authorize a transfer.

The configuration, HTTP, crypto, grant and content examples are development-only differential drivers
that emit synthetic secrets. Never run them against real profiles.
