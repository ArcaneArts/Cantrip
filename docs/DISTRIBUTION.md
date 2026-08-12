# Distribution and server connections

Production container, Compose, reverse-proxy, PostgreSQL migration,
backup/restore, TURN, and rolling-upgrade operations are documented in
[Hosted deployment and recovery](HOSTED_DEPLOYMENT.md).

Cantrip produces three independent artifacts: Server, Worker, and Desktop. The
Server and Worker are Node.js deployment trees. Desktop is a native Tauri
bundle containing the frontend plus those same service trees and the Node.js
runtime used to build it.

## Build matrix

Run packaging on the target operating system because the Worker contains
native PTY, screen capture, and image modules.

| Command                 | Output                                                            | Host requirement                       |
| ----------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| `pnpm package:server`   | `artifacts/cantrip-server-<os>-<arch>`                            | No external runtime                    |
| `pnpm package:worker`   | `artifacts/cantrip-worker-<os>-<arch>`                            | Native build host, Git at runtime      |
| `pnpm package:services` | Both service trees                                                | Same as above                          |
| `pnpm package:app`      | Tauri bundles under `cantrip_app/src-tauri/target/release/bundle` | Tauri build prerequisites              |
| `pnpm bundle`           | All three native artifacts under `artifacts/bundles/<os>-<arch>`  | Current native build host              |
| `pnpm release`          | Fast-forwards `release` to synchronized `main`                    | Clean `main` checkout with push access |

`pnpm bundle` performs the complete native build for the current host. It builds
the protocol once, packages Server and Worker concurrently, then builds the
Desktop client from those exact service trees. Final archives and native
installers are collected under `artifacts/bundles/<os>-<arch>/`; it does not
create a GitHub release.

The release workflow is intentionally limited to macOS ARM64 (`macos-14`) and
Windows x64 (`windows-2025`). Its Server and Worker jobs run in parallel. The
Client job downloads those native service archives, embeds them alongside the
runner's Node.js runtime, builds the Tauri client, and publishes the resulting
client bundle. A final job creates a GitHub release tagged
`release-<full-commit-sha>` and uploads every service/client artifact.

From a clean, synchronized `main` checkout, start that workflow with:

```shell
pnpm release
```

The command first runs `git pull --ff-only origin main`, requires local `main`
to equal `origin/main`, verifies that `origin/release` can fast-forward, and
then pushes `main` to `release`. It refuses dirty trees, non-`main` branches,
unpushed main commits, and divergent release history. It does not build or
publish anything locally; the `release` branch push is the workflow trigger.

All lower-level packaging commands accept the native target explicitly, for example
`pnpm package:worker --target darwin-arm64` or
`pnpm package:app --target darwin-arm64`. Cross-compilation is rejected because
both the Worker and Cantrip Code contain native modules. `macos-*` and
`windows-*` are accepted aliases for the runtime target names `darwin-*` and
`win32-*`.

The Server and Worker archives each include the platform-matched Node runtime
used to build their native dependencies. Their startup scripts invoke only that
packaged executable, so a separate host Node installation is not required.
Desktop removes those duplicate per-service runtimes while staging and uses its
single shared bundled Node executable instead.

Worker packages contain `resources/cantrip-code/`, including the compiled
browser-native editor, its bundled Node runtime, legal notices, and a
content-hashed compatibility manifest. The manifest also pins the bundled
`cantrip-workbench` extension version, and worker startup verifies that exact
extension package before launching the editor. Packaging invokes `pnpm code:build`
when the exact target/input fingerprint is not cached. It never downloads or
updates the editor after the artifact is assembled. Desktop embeds the same
worker tree, so the standalone Worker and local-only desktop use an identical
editor compatibility unit.

Local editor builds bootstrap and checksum the Node release recorded in
`cantrip_code/upstream/.nvmrc`; it is a build-only toolchain independent from
the Node process running Cantrip. Builds still require the platform's native VS
Code prerequisites, npm, Git, and network access for the pinned dependency
graph and Node toolchain. Generated source, dependencies, toolchains, caches,
and distributions remain ignored.

Cantrip Code artifacts are cached in the repository's shared
`.cantrip-code/cache` directory across Git worktrees. Set
`CANTRIP_CODE_CACHE_DIR` when a build host should use another cache volume.

## Standalone server

Copy the packaged `.env.example` to `.env`. The startup scripts use Node's
`--env-file-if-exists` support. Important variables are:

- `CANTRIP_SERVER_HOST` and `CANTRIP_SERVER_PORT`: listening address.
- `CANTRIP_CODE_SURFACE_HOST` and `CANTRIP_CODE_SURFACE_PORT`: the isolated
  editor-surface listener. It must not share the application API origin.
- `CANTRIP_CODE_SURFACE_ORIGIN`: the public HTTP(S) origin browsers use for
  short-lived Code attachments. Hosted reverse proxies should route this
  separate origin to the Code surface listener without exposing worker ports.
- `CANTRIP_DATA_DIR`: PGlite data and durable server state.
- `DATABASE_URL`: PostgreSQL connection replacing PGlite; required in hosted
  mode.
- `CANTRIP_PUBLIC_ORIGIN`: canonical HTTPS application API origin; required in
  hosted mode.
- `CANTRIP_APP_ORIGINS`: comma-separated browser/Tauri origins allowed by CORS.
- `CANTRIP_TRUSTED_PROXIES`: bounded IP/CIDR or named private-range list whose
  peers may supply validated `X-Forwarded-*` headers. Hosted mode requires it.
- `CANTRIP_DEPLOYMENT_MODE` and `CANTRIP_BOOTSTRAP_MODE`: values announced by
  `/api/bootstrap`.
- `CANTRIP_AUTH_MODE`: `none` for loopback, `password` for one protected owner,
  or `accounts` for account sessions.
- `CANTRIP_PASSWORD_HASH`: required Argon2id encoded hash for `password` mode.
- `CANTRIP_ADMIN_BOOTSTRAP_TOKEN`: optional 32+ character secret required to
  create the first account when public registration is disabled.
- `CANTRIP_PUBLIC_REGISTRATION`, `CANTRIP_SESSION_TTL_SECONDS`, and
  `CANTRIP_AUTH_RATE_LIMIT`: account/session policy.
- `CANTRIP_COOKIE_SECURE` and `CANTRIP_COOKIE_SAME_SITE`: hosted cookie policy;
  hosted mode defaults to `Secure` plus `SameSite=None` so approved web,
  Tauri, and Capacitor origins can share the server-owned session. Same-origin
  deployments may explicitly choose `lax` or `strict`.
- `CANTRIP_API_BODY_LIMIT_BYTES`, `CANTRIP_UPLOAD_LIMIT_BYTES`, and
  `CANTRIP_WEBSOCKET_MAX_PAYLOAD_BYTES`: independent public transport ceilings.
- `CANTRIP_API_RATE_LIMIT_PER_MINUTE`,
  `CANTRIP_PAIRING_RATE_LIMIT_PER_MINUTE`,
  `CANTRIP_UPLOAD_RATE_LIMIT_PER_MINUTE`, and
  `CANTRIP_WEBSOCKET_HANDSHAKE_RATE_PER_MINUTE`: independent in-process request
  buckets. A shared limiter is added by the multi-instance deployment layer.
- `CANTRIP_ACCOUNT_UPLOAD_CONCURRENCY`,
  `CANTRIP_ACCOUNT_WEBSOCKET_LIMIT`,
  `CANTRIP_ACCOUNT_REMOTE_SURFACE_LIMIT`,
  `CANTRIP_WORKER_REMOTE_SURFACE_LIMIT`,
  `CANTRIP_ACCOUNT_COMMAND_CONCURRENCY`, and
  `CANTRIP_WORKER_COMMAND_CONCURRENCY`: active relay ceilings. Account and
  worker command rate variables provide a second backpressure boundary without
  adding a short timeout to long-running agent work.
- `CANTRIP_ACCOUNT_UPLOAD_BYTES_PER_MINUTE`,
  `CANTRIP_WORKER_UPLOAD_BYTES_PER_MINUTE`,
  `CANTRIP_ACCOUNT_RELAY_BYTES_PER_MINUTE`, and
  `CANTRIP_WORKER_RELAY_BYTES_PER_MINUTE`: process-local byte budgets for
  attachments and worker relay traffic. Use a single server replica until the
  shared coordination layer is enabled.
- `CANTRIP_METRICS_TOKEN`: optional 32+ character operator bearer token for
  aggregate Prometheus metrics. Owner/admin sessions can also read metrics.
- `REDIS_URL`: optional shared coordination endpoint. When present, server
  replicas exchange worker presence, commands, binary relay frames,
  notifications, disconnects, and live invalidations through Redis.
- `CANTRIP_SERVER_INSTANCE_ID`, `CANTRIP_COORDINATION_PRESENCE_TTL_MS`, and
  `CANTRIP_COORDINATION_MAX_INSTANCES`: instance identity, lease duration, and
  hard replica ceiling. Global traffic limits are divided by the ceiling and
  readiness rejects excess replicas.

Hosted mode never permits anonymous authentication, including when
`CANTRIP_ALLOW_INSECURE_REMOTE=true`. It also refuses missing encryption keys,
PGlite, implicit or wildcard client origins, insecure public/Code origins, and
an absent or invalid trusted-proxy list. Password and account modes use
revocable server-side sessions, tenant authorization, and per-worker
enrollment. Account/worker quotas, audit visibility, operational probes,
Prometheus metrics, and production deployment assets are implemented. Public
horizontal hosting uses the Redis coordination layer. Scheduled workflow and
project automation occurrences use durable database claims with instance-bound
lease tokens and monotonically increasing fencing tokens. Expired claims can be
recovered by another replica without allowing the stale holder to finalize the
occurrence. `CANTRIP_SCHEDULER_LEASE_TTL_MS` controls the recovery interval.
The encryption keyring protects provider API keys plus MCP environment and
static-header values. MCP configuration responses contain fixed masks rather
than plaintext; preserve old keyring entries until startup has rewrapped every
stored envelope with the selected active key.
The Code surface exposes only a health endpoint and capability-scoped bearer
attachments; it does not expose application APIs or accept Cantrip cookies.

## Standalone worker

The worker makes an outbound connection to `CANTRIP_SERVER_URL`. Generate a
short-lived link code from Settings → Workers as a signed-in user, copy the
generated POSIX or PowerShell pairing command, and set the code once as
`CANTRIP_WORKER_ENROLLMENT_CODE`, and configure a display name plus durable
`CANTRIP_WORKER_DATA_DIR`. The worker creates a stable local identity, exchanges
the single-use code, and stores its unique credential in
`worker-credential.json` with owner-only filesystem permissions. Remove the
link code from the environment after the first successful start. Immutable
deployments may inject `CANTRIP_WORKER_CREDENTIAL` with its bound
`CANTRIP_WORKER_ID` from a secret manager instead.

The artifact contains the exact Codex CLI compiled from `cantrip_codex/` for
its operating system and architecture. GitHub CLI, repository files,
credentials, terminals, browsers, and worktrees remain on the worker machine.
The legacy shared worker token is accepted only by anonymous loopback
`pnpm-dev` and embedded Tauri bootstraps.

Remote workers are managed from the same settings page. Renaming is stored as
a server-side display alias, credential rotation updates an online packaged
worker before reconnecting, and an offline rotation shows the replacement only
once for manual installation. Unlinking revokes all active credentials while
retaining server-owned project and conversation metadata. Pairing the same
worker identity again restores those associations. Internal desktop/dev
workers are labeled and cannot be renamed or unlinked.

`CANTRIP_CODE_IDLE_TIMEOUT_MS` controls how long an unattached Code session
keeps its editor process warm (30 minutes by default). Active tunnel streams,
agent/editor coordination, and explicit Code operations refresh activity. A
restarted worker restores compatible session identities from its data directory
without launching them until the server authorizes a new attachment. A packaged
worker also guards every editor process group, so an abruptly terminated worker
cannot leave editor, extension-host, watcher, or terminal processes behind.

## Packaged desktop lifecycle

Release builds reserve a free loopback port, start the bundled Server, wait for
it to accept connections, then start the bundled Worker. Both inherit the
user's environment so worker-local Git, Ollama, and browser discovery continue
to work. Codex comes from the bundled Worker rather than the user's `PATH`.
Logs and data are written below Tauri's application data directory. Both child
processes are terminated when the desktop app exits.
`CANTRIP_DESKTOP_DATA_DIR` can override that root for portable installations or
packaging smoke tests.

`pnpm devtop` deliberately does not start a second embedded stack. The Rust
shell points its Local profile at the externally orchestrated development
server so TypeScript watchers and Vite hot reload remain fast.

Both `pnpm dev` and `pnpm devtop` ensure the fingerprinted Cantrip Code build is
available. A matching cache is reused immediately; after cloning or whenever
the pinned editor, patchset, product configuration, extension source, or native
target changes, development startup builds the new distribution automatically.
`pnpm code:ready` remains available as a strict verification-only command.

## Switching servers

Click the account area beside the Settings gear to list server profiles. The
built-in Local profile cannot be removed. **Add server** accepts a name and an
HTTP(S) origin, can test its bootstrap response, and saves it before switching.
Switching reloads the frontend so queries, terminal sockets, Browser/Remote
Desktop streams, and subsequent mutations all use the same server.

Profiles are stored locally by the client because the active server must be
known before server-owned settings can load. They currently store only names
and origins. Per-server account credentials and multi-account behavior are a
separate follow-up milestone.
