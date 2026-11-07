# Native Cantrip server distribution

Run `./start.sh` on macOS/Linux or `start.cmd` on Windows. Run `./migrate.sh`
or `migrate.cmd` to apply migrations without starting the HTTP service. Both
entry points forward extra arguments to the native executable. The artifact
contains the server, embedded migrations, PGlite runtime assets, private PostgreSQL
assets, and shared libraries. PGlite's helpers run from the immutable distribution,
so a `noexec` temporary filesystem is supported. The executable also retains its
embedded runtime for unbundled use. Server startup does not invoke Node or a package
manager. The existing worker continues to run separately using Node.

Copy `.env.example` to `.env` and set `CANTRIP_DATA_DIR` to persistent storage.
Dotenv values use the existing Node 24 syntax without shell evaluation or
variable expansion. Existing process environment variables take precedence.
`PGLITE_RUNTIME_DIR` can explicitly override the bundled PGlite assets.
Paths in the file are relative to the distribution root. Explicit command-line
configuration takes precedence over environment configuration.

The server retains an installation's saved database selection. For a new
installation, storage can be selected independently of local/hosted deployment:

- PGlite: `CANTRIP_DATABASE_MODE=pglite` (the existing local default).
- Private PostgreSQL: `CANTRIP_DATABASE_MODE=bundled-postgres`. Launchers supply
  the bundled binary directory unless `CANTRIP_POSTGRES_BIN_DIR` is configured.
- External PostgreSQL: set `DATABASE_URL=postgresql://...`. This preserves
  existing automatic selection; `CANTRIP_DATABASE_MODE=postgres` is also accepted.

Use the existing authentication, origin, TLS proxy, encryption-keyring, Redis,
and quota settings from `.env.example` for a hosted installation. `/healthz`
and `/readyz` retain their HTTP contracts. SIGTERM/SIGINT initiate graceful
shutdown. Keep the profile directory outside the immutable release tree when
running under systemd or switching releases.

With the service stopped, `./migrate.sh --export-sql /private/backup.sql` exports
the selected database using the bundled native tools. The Linux package uses
PostgreSQL 18 tools, which also support the PostgreSQL 17 PGlite engine. An
external server newer than those tools needs a matching `--pg-dump-path` for
this offline export operation.

`native-server.json` records the target, version, PostgreSQL layout, and SHA-256
hashes of distribution files before the manifest is written. It describes the
artifact contents; platform qualification requires running the artifact on the
target platform. A successful build on another platform does not establish it.

Build locally using `node scripts/package-server-rust.mjs --target <target>`;
`pg_config` discovers the installed PostgreSQL assets, or specify
`--postgres-bin`, `--postgres-share`, and `--postgres-lib`. `--binary` packages
an already built executable, and `--output` selects a new artifact directory.
Build tooling may use Node and Cargo; neither is required at runtime. Preserve
the artifact's directory layout when copying it to another machine.

The Linux container source is `deploy/docker/server-rust.Dockerfile`; its
`distribution` target exports the same tree for native systemd deployment.
`deploy/compose.rust.yml` overlays the hosted Compose configuration for local
qualification. The canonical packaged desktop and hosted deployment defaults
remain on the existing server until the full replacement acceptance and data
migration/rollback work is complete. This artifact milestone does not by itself
establish production cutover readiness.
