# Native server distributions

The Rust distribution contains the server executable, SQL migrations embedded
in that executable, matching PGlite runtime assets, private PostgreSQL assets,
and collected shared libraries. The worker continues to use its existing Node
runtime. Node and Cargo are build tools; the server's packaged launchers and
health checks execute native programs.

The [Linux ABI qualification](RUST_SERVER_LINUX_ABI.md) records the reproduced
Debian 12 ARM64 linker failure and the pinned source build for matching native
PGlite engine/runtime assets on both container architectures.

## Build and configuration

Build on the target OS, or in a matching local container:

```sh
pnpm package:server --target darwin-arm64
```

The canonical output is `artifacts/cantrip-server-darwin-arm64`. macOS builds
use Homebrew's PostgreSQL 18 assets unless explicitly configured. Windows
builds cache the pinned portable PostgreSQL archive without installing a
service. Linux builds use `pg_config`, or `CANTRIP_POSTGRES_BIN_DIR`; install
PostgreSQL 18 build assets for exports from private PostgreSQL 18 databases.
The lower-level `package:server:rust` command remains available for explicit
`--binary`, `--output`, and PostgreSQL asset options.

Native GNU Linux builds compile the pinned PGlite engine against the build
host's libc, matching the container build. Install Git, a C/C++ toolchain,
Clang, Bison, Flex, zlib development headers, pkg-config and patchelf. The
engine's libraries and matching runtime are cached under the shared Cargo
target directory; no compilation or download occurs at server startup.

The build helper uses one Git-common-directory cache by default, disables
incremental compilation, and bounds builds to two jobs. Reuse one
`CARGO_TARGET_DIR` when overriding it across development worktrees. Separate directories
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
  -f deploy/docker/server.Dockerfile --load -t cantrip-rust:qa .
node scripts/server-rust/container-server-acceptance.mjs \
  --image cantrip-rust:qa --report .qa/native-container.json
```

The `distribution` target exports the standalone tree used by the native
service entry points. Exercise that exported tree on Ubuntu independently of
the Debian runtime image:

```sh
docker buildx build --platform linux/amd64 \
  --build-arg CANTRIP_VERSION_PATCH="$(git rev-list --count HEAD)" \
  -f deploy/docker/server.Dockerfile --target distribution \
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

On Windows the same driver executes the actual `.cmd` launchers and native
`.exe` tools. Shutdown closes the supervision stdin pipe, matching the desktop
ownership contract; Node's Windows `SIGTERM` would terminate the process rather
than exercise graceful native shutdown. `--data-root` selects an owned test
directory, including paths containing spaces and Unicode. Use a fresh directory
for each run. The test driver may use Node; server and database children receive
a runtime PATH without Node.

Windows server builds include a per-process UTF-8 manifest. Matching PGlite
helpers receive that manifest before embedding, including during cross builds.
The Windows packager also updates its copied native executables, including
private PostgreSQL tools, before calculating artifact hashes. It preserves
existing PE resources and manifest settings. These are build operations and do
not change the machine's code page or require PowerShell at server startup.
The server links zlib statically on Windows for the native PGlite archive.

The resource-preservation test runs against a copy of an actual executable:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File scripts/server-rust/windows-utf8-manifest.test.ps1 `
  -Executable C:\CantripQA\cantrip-server.exe
```

## Evidence and remaining integration

The following table records the original packaging milestone. The
[current package qualification](RUST_SERVER_CURRENT_PACKAGED_ACCEPTANCE.md)
adds current macOS and actual Windows artifact results and desktop supervision.

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
overlay (`deploy/compose.rust.yml`). Desktop integration, automatic profile
conversion and native Winterhold installation now have separate scoped
qualification. The full replacement still requires current integrated artifacts,
broader historical upgrades and product post-write rollback, remaining platform,
product, coordination and performance qualification, default cutover and
production Node-server removal. No production deployment or hosted development
validation was performed.
