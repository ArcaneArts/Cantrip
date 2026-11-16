# Native Cantrip worker

This package is the incremental Rust worker replacement. See
[the implementation ledger](../docs/RUST_WORKER_PORT.md) for complete scope,
coverage, compatibility and delivery milestones. Production packaging continues
selecting the Node worker until the complete implementation is ready.

The native `cantrip-worker` executable currently supports configuration,
version-1 identity/credential persistence, logging/archive lifecycle, enrollment,
heartbeat, WebSocket readiness/reconnect, version queries, credential rotation,
in-process restart and log reads. Remaining domains fail explicitly and advertise
unavailable capabilities. This is not yet the complete production replacement.

The implementation reuses `cantrip-config`, `cantrip-wire`, `cantrip-host`,
`cantrip-logging` and `cantrip-protocol`, without a server or database dependency.
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

The configuration and HTTP examples are development-only differential drivers
that emit synthetic secrets. Never run them against real profiles.
