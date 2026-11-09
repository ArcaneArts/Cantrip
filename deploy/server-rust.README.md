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

Build locally using `pnpm package:server --target <target>`. The canonical
artifact is `artifacts/cantrip-server-<target>`. The lower-level
`node scripts/package-server-rust.mjs --target <target>` supports explicit
outputs and existing binaries. PostgreSQL assets come from Homebrew PostgreSQL
18 on macOS, a cached portable archive on Windows, or `pg_config` on Linux; specify
`--postgres-bin`, `--postgres-share`, and `--postgres-lib`. `--binary` packages
an already built executable, and `--output` selects a new artifact directory.
Build tooling may use Node and Cargo; neither is required at runtime. Preserve
the artifact's directory layout when copying it to another machine.

The Linux container source is `deploy/docker/server.Dockerfile`; its
`distribution` target exports the same tree for native systemd deployment.
The canonical hosted Compose and deployment commands use this native server.
`deploy/docker/server-rust.Dockerfile` and `deploy/compose.rust.yml` remain
compatible explicit aliases. Release readiness additionally requires the
documented platform, client, migration and rollback qualification.

## Existing desktop profiles

`pnpm package:app` packages the native server by default. The existing
`--server-runtime rust` spelling is also accepted.
`--from-artifacts` reuses the canonical native server and unchanged worker artifacts;
it still builds and packages the small `@cantrip/profile-converter` tool. The
worker's shared Node runtime supplies that bounded tool. The native server does
not load it for serving or background work.

Before starting the native desktop server, the supervisor runs `--migrate-only
--upgrade-profile` with the same data directory and environment. It recovers an
interrupted directory activation before reading the installation's backend.
Existing external/private PostgreSQL selections proceed to their real normal
startup. A new installation initializes through normal startup too.

For an unmarked PGlite installation, preparation holds an exclusive profile
lease, materializes a private physical copy, and actually opens/migrates that
copy with the native engine. Only an engine-open failure permits the bounded
legacy logical converter. Configuration, SQL, or migration failures do not
select a fresh database or start the legacy converter. Successful validation
activates the prepared profile and retains the original directory. Its private
activation receipt names the retained backup. Normal native setup records
ownership after the real database setup succeeds, avoiding a repeated copy on
subsequent launches. Distribution PostgreSQL paths are not pinned into saved
configuration; an explicitly configured custom binary path is retained.

Standalone operators can run the same stopped-profile operation using
`./migrate.sh --upgrade-profile --legacy-node /path/to/node
--legacy-profile-converter /path/to/profile-converter/dist/index.mjs`.
The legacy tool is needed only when the native PGlite open actually fails.
The bundled converter uses the existing JavaScript PGlite 0.5.4 export runtime;
a conversion failure retains the original and reports failure.

For an explicit backend change, export a stopped full profile with
`./migrate.sh --export-profile /private/latest-profile`, restore it to a new
profile directory using `--restore-profile`, the selected `--database`, and
its connection options, then activate that prepared directory with
`--activate-profile`. Do not treat a backend environment change as a logical
transfer of the old database.

Rollback after accepted Rust writes must export the latest active profile.
For a return to the legacy PGlite server, use the packaged converter's
`--restore <latest-profile-bundle> <new-node-profile> <native-server-executable>`
mode, activate that prepared Node profile while services are stopped, and then
start the old package. Activating an old retained snapshot would discard later
writes and is not the rollback procedure. Keep original and reverse-conversion
evidence until the rollback window is closed.
