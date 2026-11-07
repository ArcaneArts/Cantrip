# Native server distributions

The Rust distribution contains the server executable, SQL migrations embedded
in that executable, matching PGlite runtime assets, private PostgreSQL assets,
and collected shared libraries. The worker continues to use its existing Node
runtime. Node and Cargo are build tools; the server's packaged launchers and
health checks execute native programs.

## Build and configuration

Build on the target OS, or in a matching local container:

```sh
CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=2 \
  pnpm package:server:rust --target darwin-arm64 \
  --postgres-bin /path/to/postgresql18/bin --output artifacts/native-server
```

Reuse one `CARGO_TARGET_DIR` across development worktrees. Separate directories
per worktree and incremental compiler state previously accumulated excessive
storage. `--binary` packages an existing native server executable; the packager
executes its `--materialize-pglite-runtime` operation so assets match that exact
binary. `pg_config` discovers PostgreSQL share/library paths, or callers can
provide `--postgres-share` and `--postgres-lib` explicitly.

Run `start.sh`/`start.cmd`; use `migrate.sh`/`migrate.cmd` for offline migrations,
SQL exports and the existing profile operations. The launchers change to the
distribution directory, load optional `.env` data with Node 24 syntax, and
forward additional arguments. Values are never evaluated as shell code.

Process environment values precede `.env` values; explicit CLI settings precede
both. Saved database configuration retains its existing selection rules.
Bundled PostgreSQL paths supply a fallback after saved configuration is applied.
`PGLITE_RUNTIME_DIR`, including a value from `.env`, precedes bundled PGlite
assets. These defaults do not inspect database metadata or cache markers before
attempting the configured operation.

PGlite helpers are materialized during packaging and run from the immutable
distribution. They are not executed from `/tmp`, allowing the hosted container's
`noexec` temporary mount to remain enabled. The executable retains its embedded
runtime for unbundled use. Materializing that runtime creates a new directory
without initializing a database.

The Linux distribution uses the host's glibc ABI and certificate store, and
bundles other discovered shared libraries. PostgreSQL 18 tools support native
exports of the PGlite PostgreSQL 17 engine and PostgreSQL 18 databases. Newer
external database versions may need an explicit matching `--pg-dump-path` for
offline exports; normal connection configuration is unchanged.

## Local container and standalone qualification

Build and test the Linux image locally:

```sh
docker buildx build --platform linux/amd64 \
  --build-arg CANTRIP_VERSION_PATCH="$(git rev-list --count HEAD)" \
  -f deploy/docker/server-rust.Dockerfile --load -t cantrip-rust:qa .
node scripts/server-rust/container-server-acceptance.mjs \
  --image cantrip-rust:qa --report .qa/native-container.json
```

The `distribution` target exports the standalone tree used by the native
service entry points. Exercise that exported tree on Ubuntu independently of
the Debian runtime image:

```sh
docker buildx build --platform linux/amd64 \
  --build-arg CANTRIP_VERSION_PATCH="$(git rev-list --count HEAD)" \
  -f deploy/docker/server-rust.Dockerfile --target distribution \
  --output type=local,dest=artifacts/native-linux-x64 .
docker buildx build --platform linux/amd64 \
  -f scripts/server-rust/standalone-ubuntu.Dockerfile \
  --load -t cantrip-rust-standalone:qa artifacts/native-linux-x64
node scripts/server-rust/container-server-acceptance.mjs \
  --image cantrip-rust-standalone:qa --report .qa/native-ubuntu.json
```

The container driver uses an isolated PostgreSQL 18 fixture and exercises all
three storage modes. Each mode runs as UID 10001 with a read-only root and a
256 MiB `noexec` `/tmp`. Assertions cover actual HTTP settings writes, retained
identity and data after restart, native SQL export, migration entry points,
SIGTERM exit status, hosted reopening behind trusted forwarding headers, and
return to the original local data. Node, npm and Cargo are absent from the
runtime PATH. Reports record the immutable image ID and owned evidence volumes;
preserve those volumes before cleaning up that test run.

For a dedicated relocated macOS artifact, run:

```sh
node scripts/server-rust/packaged-server-acceptance.mjs \
  --artifact artifacts/native-server --isolate-homebrew \
  --report .qa/native-macos.json
```

The driver temporarily supplies fixture `.env` values and restores any original
file. It denies Homebrew reads and artifact writes, checks actual SIGTERM
shutdown without closing stdin, verifies every manifested file, and covers
explicit runtime overrides plus the embedded-runtime fallback. Use a dedicated
QA distribution when running this driver.

## Evidence and remaining integration

Local candidate results:

| Candidate                                           | Storage/deployment coverage                                            | Result |
| --------------------------------------------------- | ---------------------------------------------------------------------- | ------ |
| macOS arm64 optimized distribution, PostgreSQL 18.6 | Three storage modes, local and hosted                                  | Passed |
| Linux amd64 optimized Debian image, PostgreSQL 18.6 | Three storage modes, local and hosted, noexec temporary mount          | Passed |
| Exported Linux amd64 distribution on Ubuntu 24.04   | Three storage modes, local and hosted, root-owned executable resources | Passed |

Linux amd64 execution used the local Docker Linux engine on an arm64 host.
These results establish execution behavior in those environments; they do not
provide bare-metal Winterhold performance measurements or a systemd rollout.
The macOS optimized distribution also passed with Homebrew reads and artifact
writes denied. Windows and other normalized targets require their own artifact
execution results.

The focused configuration/profile suites passed nine Rust tests, including
977 actual Node/Rust configuration comparisons, 1,308 actual Node dotenv
file-loader comparisons, and five stored-database cases. Strict all-target
Clippy passed. The standard `pnpm check` stopped at unchanged Node baseline
line budgets: `build-app.ts` 1,532/1,500 and `chat-turn-runtime.ts` 2,336/1,999.
Later checks in that command were not run or claimed as passing.

The existing desktop and canonical hosted defaults still use the Node server.
This milestone supplies native distributions and an opt-in hosted Compose
overlay (`deploy/compose.rust.yml`). The full replacement still requires desktop
integration, existing-installation migration and post-write rollback acceptance,
the remaining platform/product/coordination/performance qualification, default
cutover, and production Node-server removal. No production deployment or hosted
development validation was performed.
