# Native Winterhold deployment

The production deployer can build and install the Rust distribution using the
existing SSH, systemd and Caddy path. It never needs a Node runtime on the host
to run the Rust server. The worker retains its own Node runtime.

## Select the server

The deployment source is the exact promoted `release` commit. Its normal host
phase builds the Rust server:

```sh
pnpm deploy:server
```

This is a production deployment command, not a local test command. Run it only
when a production deployment is authorized. It reads production credentials
and contacts the configured host. The promoted snapshot must contain the native
Dockerfile, packager, installer and matching server code.

`deploy/production/deploy.json` accepts `"serverRuntime": "rust"`; omitting the
field also selects Rust. The explicit `--server-runtime rust` spelling remains
accepted. The full replacement still requires source retirement and final
shipping acceptance; see [default cutover](RUST_SERVER_DEFAULT_CUTOVER.md).

The distribution retains the existing entry points, `start.sh` and
`migrate.sh`. The installer executes those entry points rather than requiring a
Node executable or using an artifact marker to infer runtime support. Rust
packages include native PGlite and private PostgreSQL assets. Winterhold's
production environment continues to select external PostgreSQL with
`DATABASE_URL`; standalone native services can select either local backend.

## Installation and failure recovery

The deployer stages the candidate environment with the archive in a root-only
temporary directory. It does not overwrite the active environment during upload.
The installer extracts a new immutable release and validates the actual Caddy
configuration before stopping the current service. It then:

1. Saves the current environment, systemd units and proxy configuration.
2. Stops the server, releasing local database ownership.
3. Installs the candidate configuration and runs the real migration unit.
4. Switches the active symlink and restarts Caddy and Cantrip.
5. Requires an actual local readiness response, retains a root-only environment
   snapshot in `/etc/cantrip/releases/<commit>/production.env`, and enables the
   services.

Migration, configuration-installation and startup/readiness failures restore the
previous configuration and symlink. An already-running previous service is
restarted and checked for readiness. First-install failures leave the server
stopped. This process never restores a database snapshot or discards accepted
writes. It is an offline single-host upgrade with a short service interruption;
it does not establish mixed rolling-deployment compatibility.

Both units use `KillMode=mixed`: systemd signals the server first so it can
flush writes and stop its private database, with group cleanup if shutdown does
not finish. The original group-wide SIGTERM interrupted the private PostgreSQL
guardian during the actual rehearsal and made shutdown fail. See the
[systemd process termination documentation](https://www.freedesktop.org/software/systemd/man/248/systemd.kill.html).

Code rollback requires compatibility with the latest database schema. Stop the
service, restore the previous release's saved environment, switch the symlink to
that retained release, restart, and check readiness and authenticated operations.
Do not substitute a pre-upgrade database snapshot for post-write rollback.
Older deployments predating environment snapshots require the operator's
preserved original environment. PGlite engine changes additionally need the
tested logical conversion described in the
[profile activation guide](RUST_SERVER_PROFILE_ACTIVATION.md); physical database
directories are not interchangeable. The deployment installer does not silently
convert or reset a database.

## Local rehearsal

Use isolated Docker resources and built distributions. The systemd fixture is
privileged to exercise the actual service namespace restrictions; it mounts no
host files or Docker socket. Build the server through
`productionServerBuildArguments` with `serverRuntime: "rust"` and its exact Git
commit count, exporting the `distribution` target to a new directory. Then run:

```sh
docker buildx build --platform linux/arm64 \
  -f scripts/server-rust/systemd-ubuntu.Dockerfile \
  --load -t cantrip-systemd-qa:ubuntu24 .
node scripts/server-rust/winterhold-systemd-acceptance.mjs \
  --artifact /absolute/path/to/native-linux-x64 \
  --previous-native-image cantrip-server-rust:previous-qa \
  --node-image cantrip-node-baseline:qa \
  --systemd-image cantrip-systemd-qa:ubuntu24 \
  --report .qa/winterhold/report.json
```

Both baseline images must contain their standalone distributions at
`/opt/cantrip`. Use an older packaged Rust image for the two local stores and an
archived Node image for external PostgreSQL. Record the image IDs and build
versions with the current artifact so the rollback is reproducible.

The driver exercises the actual production installer and units on isolated
PGlite, private PostgreSQL and TLS-enabled external PostgreSQL databases. It
uses the production Caddy configuration with a fixture hostname and verifies
HTTPS and App Live against that hostname and the fixture CA. It checks secure
session cookies, CSRF, CORS, retained sessions and identity, failed native
migrations and startup, configuration restoration, post-write rollback,
restart, SIGTERM status and database-child reaping. External PostgreSQL runs
Node → Rust → Node → Rust against the latest database. Each local store rolls
back to the older native artifact and returns to the current build. The driver
hashes each running native executable to verify which release systemd loaded.

Reports identify the artifact and systemd-host architectures separately. Docker
Desktop's x64 systemd emulation failed to execute even basic services in the
initial fixture. An ARM64 systemd host can instead execute the unchanged x64
artifact using binfmt and an installed x64 ELF loader. That result is a local
mixed-architecture service rehearsal, not bare-metal x64 Winterhold validation.
Retain reports, journals, fixture profiles and artifact checksums before
removing only that run's named containers and network. No GitHub Actions or
production deployment is involved in this rehearsal.

Final shipping qualification also covers desktop installers and updates,
interrupted product flows, multi-instance coordination and performance.

## Current Linux x64 qualification

The production build from `4c42484d8b3575b5fd6ea8234e1b179885b8b0a4` exported
version `1.1.2816` as a Linux x64 distribution and a Debian container. Each
running container matched all 2,546 packaged file hashes and the separately
exported server executable. PGlite, bundled PostgreSQL and external PostgreSQL
passed migrations, SQL export, retained identity and settings, local and hosted
reopen, and graceful shutdown. The container ran without Node as a non-root
user with a read-only root and a 256 MiB noexec temporary mount.

The systemd rehearsal passed all 18 installer calls across the three stores.
The six deliberate migration and startup failures restored the working service
and configuration. Both local stores upgraded from `1.1.2783`, accepted a write
through `1.1.2816`, rolled back to `1.1.2783` and returned to `1.1.2816`.
External PostgreSQL exercised the same sequence with Node `1.1.2739` as the
rollback release. The original sessions, identities and latest writes survived.
Ten running executable hashes confirmed the selected native release at the
observed phases. HTTPS and App Live verified Caddy's certificate and fixture
hostname. All six observed external PostgreSQL connections used TLS, and an
actual write outside the profile failed in the service's mount namespace.

The [acceptance record](security/rust-server-winterhold-x64-acceptance.json)
records artifact hashes and local reports. Both runs used an ARM64 Linux host
executing the x64 artifact under Rosetta. This qualifies the observed service
and container behavior on that host. Bare-metal x64 performance and a production
Winterhold deployment remain outside this rehearsal. All 28 local deployment and
release tests passed.

## Earlier local results

The [integrated artifact qualification](RUST_SERVER_INTEGRATED_ARTIFACT_ACCEPTANCE.md)
refreshes this rehearsal with candidate `1.1.2778`: all three stores, all 18
installer cases, post-write rollback, TLS, namespace write restrictions and
independent hashing of the mapped native executable passed locally. The original
milestone below retains its own version and evidence scope.

The optimized `1.1.2739` x64 artifact passed the complete driver locally on
2026-11-07, with PostgreSQL 18.6 tools and native PGlite 17.5. The unchanged Node
baseline used the same application version. All three modes retained identity,
sessions and writes through upgrade, both intentional failures, post-write
rollback and return to Rust. All 18 installer calls behaved as expected: 12
successful installations and six rejected candidates with recovery.

Both local database modes exited cleanly and reaped their service cgroup;
private PostgreSQL included 17 processes. No private-owner or bandwidth-flush
shutdown errors remained. An actual write attempt inside the server's mount
namespace failed with a read-only-filesystem error outside the allowed profile.
All six observed external PostgreSQL connections used TLS. Node was absent from
the host PATH, and the running native executable matched the exported binary:

```text
9752afd5a94077c334ee03bb43a9001c7fe7f2a7810688ce7b268e0aee4e65c0
```

The focused deploy/release suite passed 28 tests. The standard `pnpm check`
stopped at unchanged Node decomposition budgets (`build-app.ts` 1532/1500 and
`chat-turn-runtime.ts` 2336/1999); subsequent aggregate stages were not run or
claimed as passing. The workflow-removal check passed. This result does not
qualify Windows, native x64 systemd, mixed rolling deployment or performance.
