# Rust server default cutover

The normal server entrypoints select Rust. The unchanged worker continues to
use Node, as does frontend/build tooling and the bounded legacy PGlite profile
converter. This cutover does not complete production Node-source retirement or
the full replacement goal's remaining shipping acceptance.

## Normal entrypoints

- `pnpm package:server` builds a native release into
  `artifacts/cantrip-server-<target>`. `package:services` uses the same native
  server alongside the existing worker.
- `pnpm package:desktop-runtime`, `package:app`, and `bundle` package Rust.
  `--from-artifacts` consumes the canonical server artifact name and the
  unchanged worker artifact. `--server-runtime rust` remains accepted.
- The desktop supervisor starts the native executable. A missing package
  configuration still attempts the native executable and reports the actual
  spawn failure. It does not select an old server implementation.
- `pnpm dev`, `dev:postgres`, `dev:server`, and `devtop` launch `server:dev`.
  JavaScript controls compilation and file watching; native children handle
  requests and background work. Relative development data paths retain their
  previous locations despite the new root working directory.
- `deploy/docker/server.Dockerfile`, hosted Compose, and the production
  deployment build command use the native server. The explicit Rust Dockerfile
  and Compose overlay remain compatible aliases.

Development startup builds the bounded converter and prepares an existing
profile with the native offline operation before serving. A successful
conversion retains the original profile. Watch rebuilds stop the native child,
compile serially, and restart against the same profile. Signals close the
native supervision pipe and wait for orderly shutdown. The frontend health
waiter continues making actual health requests while conversion runs; an
explicit `CANTRIP_DEV_STARTUP_TIMEOUT_MS` still supplies a finite deadline.

## Build assets and storage

The helper defaults to one Cargo target directory under Git's shared common
directory, including across worktrees. Incremental compilation and development
debug information are disabled; builds default to two jobs. Explicit Cargo
environment settings retain precedence.

macOS packaging uses Homebrew PostgreSQL 18. Windows packaging downloads the
pinned portable PostgreSQL 18.6 archive into a build cache, without installing
a database service. It extracts the server's binaries, libraries, shared data,
and notices; unused pgAdmin paths exceed PowerShell 5's path limit and are not
needed. The release build and Windows bootstrap provide the GNU Rust target
and MinGW compiler. The desktop/worker MSVC toolchain remains unchanged.

Native GNU Linux builds compile the pinned PGlite source against the build
host's libc, avoiding the published ARM64 archive's newer-glibc requirement.
The matching library/runtime and notices are cached under the Cargo target
directory. An explicit `PGLITE_LIB_DIR` retains precedence, including in the
container build. Packaged startup performs no compilation or download.

## Local qualification

The working-tree candidate is `1.1.2784`. Reports are retained under
`.qa/rust-default-cutover`; prior failed attempts remain separate.

| Actual operation                                                                       | Result                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unflagged `pnpm package:server` on macOS arm64                                         | Native artifact built; 1,762 hashes verified; all three stores, local/hosted, migrations, exports, settings/restart and SIGTERM pass with Node absent from runtime PATH, Homebrew reads denied and artifact writes denied                 |
| Unflagged `package:desktop-runtime --from-artifacts` and current production supervisor | All three stores pass with the complete existing Node worker, retained identities/settings, actual worker command, supervisor loss/recovery and child reaping                                                                             |
| Unflagged development controller on an existing Node profile                           | Logical conversion, original identity/session, accepted settings and restart pass                                                                                                                                                         |
| Development watch mode                                                                 | Actual source event rebuilds and restarts to a different native PID, retaining the server identity and orderly exit                                                                                                                       |
| Native Linux-host builder without an explicit PGlite library                           | Source engine and optimized server build; nonroot native HTTP writes/restart and SIGTERM pass using the exact executable's materialized runtime                                                                                           |
| Canonical ARM64 Dockerfile                                                             | All three stores, local/hosted, migrations, SQL export, retained writes/restart and SIGTERM pass as UID 10001, with read-only root, 256 MiB noexec temporary mount and Node absent; 2,546 hashes and actual running ELF verified per case |
| Focused deployment, packaging, release-workflow, devtop and synthetic-build tests      | 41 pass                                                                                                                                                                                                                                   |
| Current production desktop command tests                                               | Five pass, including missing configuration attempting the native executable                                                                                                                                                               |

The first development attempt used invalid `CANTRIP_SERVER_PORT=0`; the existing
configuration contract rejects it. A corrected attempt found an incomplete
machine-global temporary PGlite cache created before this milestone. Fresh
extraction from the current executable contains the required files. The passing
test isolates its temporary directory, preserving that unrelated retained cache
and the actual configuration contract.

The current Windows x64 GNU executable was cross-built locally, then packaged
and executed on Windows 11 ARM64 with x64 emulation in an owned VM clone. The
default PostgreSQL asset helper passes cold extraction and cached reuse.
The packaged candidate passes all three stores, local/hosted reopening,
migrations, exports, settings/restart, actual batch launchers, supervision-pipe
shutdown, 2,278 file hashes, spaces/emoji paths and native embedded fallback.
Node is absent from the server's runtime PATH. This is actual Windows-kernel
execution, not bare-metal x64 performance or complete Windows desktop UI
acceptance. The user's original VM remains stopped and unchanged.

The production deployer's actual build-argument function also exports the native
ARM64 distribution with `serverRuntime` omitted. Its manifest contains 2,546
files. This local export does not contact Winterhold or deploy to production.

The standard local `pnpm check` still stops at unchanged Node source line
budgets: `build-app.ts` 1,539/1,500 and `chat-turn-runtime.ts` 2,329/1,999. No
later aggregate checks are claimed from that stopped command. Development
validation runs locally; release workflow edits do not add ordinary push or
pull-request validation, and no hosted diagnostic run was dispatched.

## Remaining full replacement work

Remove the production Node server and resolve its remaining source/build/test
dependencies without dropping the SQL migration chain or the permitted bounded
converter. Reconcile historical coverage entries against their later evidence.
Complete final supported shipping artifacts and existing-client encrypted
desktop/update acceptance; the retained macOS QA app's last observation was
waiting on Keychain access. Preserve the separate current-wire, data-preserving
rollback, execution recovery, performance and Linux deployment evidence. No
production Winterhold deployment is performed by this milestone.
