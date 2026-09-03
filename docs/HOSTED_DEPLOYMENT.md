# Hosted deployment and recovery

For the release-candidate validation matrix, see
[HOSTED_RELAY_ACCEPTANCE.md](HOSTED_RELAY_ACCEPTANCE.md).

Cantrip's hosted server is the authenticated rendezvous point for applications
and worker-initiated outbound connections. PostgreSQL owns durable account,
conversation, configuration, and routing state. Workers own managed project
folders, repositories, terminals, Codex runtimes, Code profiles, browser
processes, and desktop state. The server never becomes a shared filesystem.

This guide describes the supported container boundary and equivalent native
service operation. A deployment exposes one public HTTPS origin, such as
`api.cantrip.example`, for HTTP, AppLive, worker control, and WorkerLink relay
traffic. Cantrip Code is a server-authorized WorkerLink resource, not a second
public listener or `code.` origin. Each separately hosted application origin
must appear exactly in `CANTRIP_APP_ORIGINS`.

## Production Droplet release

The committed `deploy/production/` lane deploys Cantrip's control plane to the
current DigitalOcean Droplet as a native, self-contained Linux x64 Server behind
host Caddy. It does not install Docker, Node.js, pnpm, Git, or Infisical on the
Droplet. The release workstation needs:

- a clean `main` checkout equal to `origin/main`;
- Docker Engine with Buildx and Linux AMD64 build support;
- an authenticated `doctl` CLI session authorized to update the Cantrip App
  Platform app;
- authenticated Infisical CLI access to the project in `.infisical.json`;
- OpenSSH, SCP, and tar; and
- the production API DNS name resolving to the `sshHost` in
  `deploy/production/deploy.json`.

The Infisical environment named by that file must define the administrator,
allowed application origins, API domain and public origin, database URL, the
currently required hosted server keyring and active key ID, metrics token, and
SSH private deployment key. The server keyring is a compatibility startup
input at this revision; provider and MCP payloads use account endpoint
encryption and cannot be decrypted with it. The deployer reads the values
locally and sends only an explicit server-variable allowlist to the host. The
SSH key is never included in the service environment. Secret values are not
printed by the deployment script.

Run a full release from synchronized `main`:

```bash
pnpm release
```

This fast-forwards the `release` branch, validates the DigitalOcean App
Platform specification and triggers deployment of its `app` and `site`
components, cross-builds the Server bundle, writes the root-only environment,
uploads the immutable release, runs the matching forward migration, switches
the active symlink, and restarts Caddy and Cantrip. App Platform activation is
not awaited by this command; the host phase waits for the single public API
`/readyz` endpoint before succeeding. If branch promotion already succeeded
but the Droplet deployment failed, retry only the host phase:

```bash
pnpm deploy:server
```

The host layout is:

- `/opt/cantrip/releases/<commit>`: immutable Server packages;
- `/opt/cantrip/current`: active-release symlink;
- `/var/lib/cantrip`: Cantrip-owned durable local state;
- `/etc/cantrip/production.env`: root-owned mode `0600` service environment;
- `cantrip-server.service`: long-running systemd service; and
- `cantrip-migrate@<commit>.service`: one-shot migration unit.

The installer bootstraps Ubuntu's Caddy package and the `cantrip` system user,
opens HTTP/HTTPS in UFW, validates the Caddy configuration, and enables both
services at boot. The application listener remains bound to loopback on port 4310. The DigitalOcean cloud firewall remains the outer network boundary.
If the newly restarted Server fails local readiness, the installer restores the
previous application symlink and process. Database migrations are forward-only,
so a database backup is still required before releases that alter schema.

## Container quick start

Requirements:

- Docker Engine 27 or newer with Compose v2;
- public DNS for the API name;
- ports 80 and 443 reaching the proxy host;
- a separately hosted Cantrip web app or a native Cantrip client;
- enough build capacity for the pinned Codex and Cantrip Code toolchains.

Create the operator environment without committing it:

```bash
cp deploy/hosted.env.example deploy/hosted.env
openssl rand -base64 32
```

Use the generated value for the currently required hosted server keyring, set
`CANTRIP_ADMIN_EMAIL` to the administrator who will create the first account,
and set a random URL-safe PostgreSQL password in both `POSTGRES_PASSWORD` and
`DATABASE_URL`. This server key is not the account component key used to
protect provider or MCP content. Then validate and start the control plane:

```bash
export CANTRIP_VERSION_PATCH="$(git rev-list --count HEAD)"
docker compose --env-file deploy/hosted.env \
  -f deploy/compose.hosted.yml config --quiet
docker compose --env-file deploy/hosted.env \
  -f deploy/compose.hosted.yml --profile proxy up -d --build
```

The server's published port 4310 binds only to host loopback for diagnostics.
The fixed internal proxy address is the only trusted forwarding peer. The
Caddy profile obtains a certificate and serves the public API name. Use the
supplied Nginx example when TLS is managed elsewhere.

The license whitelist is enabled by default. The configured administrator can
open **Admin** from the server selector to add or remove licensed signup email
addresses and see the account count. Disable
`CANTRIP_LICENSE_WHITELIST_ENABLED` only when the operator intentionally wants
open account registration.

The optional worker image is Linux-only and intended for headless managed
folders, repositories, Codex, terminals, and Code. It cannot expose the Docker
host's desktop or normal GUI browser sessions. Generate a one-time worker link
code in Settings, place it in `CANTRIP_WORKER_ENROLLMENT_CODE`, and run:

```bash
export CANTRIP_VERSION_PATCH="$(git rev-list --count HEAD)"
docker compose --env-file deploy/hosted.env \
  -f deploy/compose.hosted.yml --profile worker up -d --build worker
```

Remove the link code and recreate the worker after enrollment. The `worker-data`
volume retains its unique credential, identity, repositories, Code profile, and
extensions. It also retains worker-managed project folders beneath `folders/`.
Never clone this volume to create a second worker.

## Native server and worker packages

`pnpm bundle` creates platform-native server, worker, and desktop archives. The
server and worker archives contain their own Node runtime. Copy `.env.example`
to `.env` and use `start.sh` or `start.cmd`; no system Node installation is
required. The server archive also includes `migrate.sh` and `migrate.cmd` for an
explicit migration-only run.

For a native worker, keep `CANTRIP_WORKER_DATA_DIR` on a persistent local disk.
Upgrade by stopping the service, replacing the read-only application directory,
and restarting with the same data directory. Re-enroll only after deliberate
credential revocation or loss; an ordinary upgrade keeps the worker identity.

## Migrations and rolling upgrades

Cantrip migrations are forward-only. Take a verified PostgreSQL backup before
applying an upgrade. The database contains opaque endpoint-encrypted provider
API keys, provider-account labels and OAuth bundles, and complete MCP
configurations. Their usable keys belong to unlocked applications and
authorized workers; the operator server keyring cannot decrypt or rewrap these
records. Preserve the database encryption registry with the rest of PostgreSQL,
and preserve worker data directories when unattended worker key custody must
survive recovery. Run exactly one migration job against the target release:

```bash
docker compose --env-file deploy/hosted.env \
  -f deploy/compose.hosted.yml run --rm --no-deps server \
  /opt/cantrip/migrate.sh
```

Normal server startup also applies pending migrations, which is convenient for
one-instance installations. Multi-instance operators should use the explicit
job, then replace server replicas gradually. Do not run an older server against
a schema after its documented compatibility window. Rollback means restoring
the pre-upgrade database and matching release, not running down migrations.

Workers may be upgraded independently after the server. Drain or finish active
Codex, terminal, Code, browser, and desktop work first. A reconnect reports the
new worker/runtime versions and preserves server-owned history.

## PostgreSQL backup and restore

Create a compressed logical backup without placing credentials on the command
line:

```bash
mkdir -p backups
docker compose --env-file deploy/hosted.env \
  -f deploy/compose.hosted.yml exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > "backups/cantrip-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Also back up:

- the Compose configuration and exact Cantrip release identifier;
- worker data directories whose persisted identity or local project state must
  survive loss; and
- Caddy data when preserving the current ACME account is important.

Do not put secrets in the database backup directory. Provider and MCP recovery
depends on account endpoint-encryption custody, not
`CANTRIP_SECRET_ENCRYPTION_KEYS`. Redis is coordination/cache state and is not
authoritative backup data.

Test restoration on an isolated database regularly:

```bash
cat backups/cantrip-YYYYMMDDTHHMMSSZ.dump | \
  docker compose --env-file deploy/hosted.env \
    -f deploy/compose.hosted.yml exec -T postgres \
    sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      --clean --if-exists --no-owner'
```

Stop Cantrip server replicas before an in-place restore. Restore into an empty
or isolated PostgreSQL instance, run the target release's migration command,
and verify account sign-in, encryption unlock, worker presence, project
history, and a secret-backed provider before changing production DNS.

Worker volumes require their own filesystem backup policy if repository clones,
dirty worktrees, Code profiles, or local artifacts must survive loss. For a
worker-managed folder project, the workspace-derived directory under the
worker's managed folder root is the authoritative source and has no Git remote
fallback. Back up the entire managed folder root whenever those projects
matter. Older workers may still have UUID-derived directories beneath
`<worker-data>/folders/`. A server backup records project identity and history
but cannot recreate folder contents.

Stop or quiesce the worker before taking a filesystem snapshot so Agents,
project automations, terminals, Code, and shares cannot write through it. Keep the worker
backup paired with the PostgreSQL backup and release identifier from the same
recovery point. Restore it only as that worker's data directory, preserving its
credential, identity, and exact managed directory names; do not mount one
restored volume into two workers. After restoration, verify the worker reconnects with
the expected identity and exercise Explorer plus a file read/write in one
managed folder before resuming unattended work.

Git remotes remain the supported cross-worker source boundary for
GitHub-backed projects, but they cannot recreate unpushed worker-local state.
An explicitly converted folder keeps its existing physical directory, so
continue backing that path up until the project is deliberately deleted or its
source is otherwise retired.

Custom repository placement introduces an additional backup boundary. A
direct checkout and the external side of a managed link may live outside the
worker data volume and are not captured by a snapshot of that volume. Back up
those mounted paths separately when dirty files or unpushed commits matter, and
pair them with the worker snapshot that contains Cantrip's placement registry
and ownership records. Restoring PostgreSQL alone restores only lifecycle state
and opaque path handles; it cannot recreate repository files. See
[the project repository placement guide](PROJECT_REPOSITORY_PLACEMENT.md#backup-and-recovery).

## Reverse proxy and transport requirements

Only HTTPS/WSS is supported for hosted server traffic. The proxy must preserve
`Host`, set `X-Forwarded-Proto: https`, append a syntactically valid
`X-Forwarded-For`, pass WebSocket upgrades, and disable response buffering for
long-lived streams. Configure `CANTRIP_TRUSTED_PROXIES` as the smallest
possible address or subnet containing only the proxy. Direct clients must not
be able to reach port 4310.

Do not configure a second Code hostname, origin, upstream, or listener. Browser
Code uses an application-origin virtual path backed by the Cantrip service
worker, while its HTTP and WebSocket payloads travel through the authorized
WorkerLink. Native Code and project-share clients use local loopback forwards.

WorkerLink selects `LOCAL`, `LAN`, `WAN`, then `RELAY` for supported ephemeral
client-to-worker traffic. LAN and WAN use authenticated WebRTC peer carriers;
RELAY uses the server WebSocket relay and consumes hosted bandwidth. The server
accepts `CANTRIP_WORKER_LINK_*` route and STUN overrides, but the bundled
Compose and production lanes currently use the built-in WorkerLink defaults;
custom overrides require explicit passthrough in the selected deployment asset.
The older feature-specific ICE/TURN settings apply only to deprecated
compatibility surfaces.

## Persistence, permissions, and operations

The images run as UID/GID `10001` and use read-only root filesystems. Named
volumes are initialized with correct ownership. For bind mounts, create the
directories first and assign them to `10001:10001`. Never mount the Docker
socket into a worker.

An exact repository path is resolved inside the worker container or service
namespace. Mount its intended parent before requesting direct or managed-link
placement; typing an unmounted host path cannot escape the container. Missing
directories can be created only inside an accessible mount, and existing
parent permissions are never changed. Prefer a narrow dedicated repository
mount over a host home or filesystem root. The service account—not the client
user—must be able to traverse, create, canonicalize, lock, and rename on that
filesystem. Managed-link additionally depends on the worker's successful
symlink/junction capability probe.

Monitor container restarts, PostgreSQL capacity/latency, Redis availability,
server health/readiness, worker presence, command failures, active WebSockets,
WorkerLink route/relay behavior, project-automation schedule synchronization and
dispatch logs, and compatibility TURN usage when enabled. Health and readiness
semantics are documented by the server version; a live process does not imply
that PostgreSQL, shared coordination, or a required worker is ready.

Use the three operator endpoints according to their distinct contracts:

- `GET /healthz` is a dependency-free process liveness probe;
- `GET /readyz` probes PostgreSQL/PGlite and returns 503 when the database is
  unavailable; and
- `GET /metrics` returns Prometheus text after either an owner/admin session or
  `Authorization: Bearer $CANTRIP_METRICS_TOKEN` authentication.

Set `CANTRIP_METRICS_TOKEN` to an independently generated value of at least 32
characters and store it in the monitoring system's secret store. The Compose
healthcheck uses `/readyz`. The proxy may expose probes to an internal load
balancer, but `/metrics` must never be public. Exported series cover HTTP volume
and latency, database probes, worker/command activity, live and tunnel
connections, relay bytes, and quota rejections. Project-automation schedule
synchronization and dispatch are reported through bounded structured server and
worker logs. Metrics contain no account, project, prompt, source, or credential
labels.
Account-usage series add storage reconciliation age/duration/failures,
bandwidth buffer/flush/drop health, history maintenance, global logical totals,
and optional physical database size. Physical-minus-logical drift is a trend
signal rather than an equality target because the two measurements have
different definitions. See the
[account resource usage contract](ACCOUNT_USAGE.md#operations-and-troubleshooting).
Tunnel diagnostics also include directional byte counters, opened/closed and
rejected connection totals, and bounded termination reasons such as congestion,
idle expiry, bandwidth limits, or endpoint disconnects. See
[the tunnel operations guide](TUNNELS.md#status-and-observability) for the exact
series.

The following per-minute byte and active-session controls supplement the
existing request, WebSocket, upload-concurrency, and worker-command limits:

| Variable                                  |   Default | Scope                                           |
| ----------------------------------------- | --------: | ----------------------------------------------- |
| `CANTRIP_ACCOUNT_UPLOAD_BYTES_PER_MINUTE` | 268435456 | Attachment bytes per account                    |
| `CANTRIP_WORKER_UPLOAD_BYTES_PER_MINUTE`  | 134217728 | Attachment bytes per worker                     |
| `CANTRIP_ACCOUNT_RELAY_BYTES_PER_MINUTE`  | 536870912 | Relayed data per account                        |
| `CANTRIP_WORKER_RELAY_BYTES_PER_MINUTE`   | 268435456 | Relayed data per worker                         |
| `CANTRIP_ACCOUNT_REMOTE_SURFACE_LIMIT`    |        16 | Concurrent browser/desktop surfaces per account |
| `CANTRIP_WORKER_REMOTE_SURFACE_LIMIT`     |         8 | Concurrent browser/desktop surfaces per worker  |

Durable account usage accounting is informational and does not add account
limits. Its server-process tuning and retention variables are:

| Variable                                        | Default | Purpose                               |
| ----------------------------------------------- | ------: | ------------------------------------- |
| `CANTRIP_STORAGE_RECONCILIATION_INTERVAL_MS`    | 3600000 | Full logical storage sweep            |
| `CANTRIP_BANDWIDTH_USAGE_FLUSH_INTERVAL_MS`     |   60000 | Normal bandwidth batch interval       |
| `CANTRIP_BANDWIDTH_USAGE_FLUSH_THRESHOLD_BYTES` | 1048576 | Early bandwidth flush threshold       |
| `CANTRIP_BANDWIDTH_USAGE_MAX_BUFFERED_ENTRIES`  |    4096 | In-memory dimensional cardinality cap |
| `CANTRIP_ACCOUNT_USAGE_MAINTENANCE_INTERVAL_MS` | 3600000 | Rollup/retention interval             |
| `CANTRIP_ACCOUNT_USAGE_HOURLY_RETENTION_DAYS`   |      30 | Hourly history retention              |
| `CANTRIP_ACCOUNT_USAGE_DAILY_RETENTION_DAYS`    |     400 | Daily history retention               |
| `CANTRIP_ACCOUNT_USAGE_FLUSH_RETENTION_DAYS`    |       7 | Idempotent flush-ledger retention     |

The bundled Compose and production lanes currently use the built-in defaults
for these eight usage variables. A custom/native service can set them directly;
the bundled lanes require explicit passthrough entries before an override in an
environment or secret store reaches the server process.

The exact definitions, bounds, API response semantics, and troubleshooting
steps are in [the usage accounting guide](ACCOUNT_USAGE.md).

Quota rejection is explicit (HTTP 429, WebSocket close code 1013, or a worker
command error) and does not silently queue work. Limits are configured globally
and conservatively divided by `CANTRIP_COORDINATION_MAX_INSTANCES`. Set that
value to the deployment's hard replica ceiling before scaling; every limit must
be at least that ceiling. `/readyz` fails if Redis observes more live instances
than configured. This static partition avoids a Redis round trip for every
terminal or media frame, but unused replicas leave part of the quota idle.

## Multi-instance server operation

Set `REDIS_URL` for every replica and give each one a unique
`CANTRIP_SERVER_INSTANCE_ID`, or omit the ID and let Cantrip generate a new UUID
at process start. Use a shared PostgreSQL database and Redis deployment, and
the same public origin, approved application origins, and proxy configuration.
Every replica must satisfy the current hosted startup configuration, but the
server keyring is not shared provider/MCP decryption material. Configure
load-balancer stickiness for WebSockets to reduce cross-instance media traffic,
but do not depend on it: Redis routes worker commands, responses,
notifications, binary frames, disconnects, and application live invalidations
to the correct process.

Worker ownership and server instance records use TTL leases. A reconnect on a
new process fences and closes the previous socket. A crashed process loses its
claims after `CANTRIP_COORDINATION_PRESENCE_TTL_MS`; until then commands fail
visibly rather than being sent to an unverified replacement. Monitor
`cantrip_coordination_instances`, message rejection, worker presence, and
readiness. Redis loss makes coordinated replicas not ready; existing local
connections may finish local work, but operators should stop routing new
traffic until coordination recovers.

Redis pub/sub carries bounded ephemeral routing envelopes. It is not a job
queue, event history, or backup target. PostgreSQL remains authoritative, and
application reconnects resynchronize snapshots when their server epoch changes.

Startup recovery is cluster-aware. The first coordinated server instance (or a
local single instance) resets process-transient surface, tunnel, chat-execution,
and Task-operation state left by a full deployment stop. A server joining an
already-live cluster preserves peer-owned transient state. Durable
project/folder/repository-discovery and chat import/relocation/root background
jobs recover through their own fenced executors. Legacy workflow tables remain
in the schema and can still affect storage accounting and conservative
active-work checks, but current source has no workflow repository or executor,
attempt heartbeat, worktree-lease recovery, queued-run dispatch, worker workflow
command/event variants, or live workflow publication. During a rolling server
upgrade, start new replicas before retiring old ones; do not introduce a newly
started older server into the upgraded cluster because older startup code cannot
honor the peer-preservation rule.

Project automations do not use Redis pub/sub as a job queue. The owning worker
polls its schedule metadata and requests each due dispatch; the server claims
the occurrence in PostgreSQL with an instance-bound lease and fencing token. Set
`CANTRIP_SCHEDULER_LEASE_TTL_MS` longer than normal condition evaluation and
dispatch latency (the default is 120 seconds). After expiry, another server can
recover the claim with a higher fence, and the former holder cannot finalize it.
Monitor `automation.schedule-sync.*` and `automation.dispatch.*` structured log
events.

Project replica jobs and chat relocations follow the same PostgreSQL-authority
principle without binding ownership to a particular server instance. Executors
renew short durable leases while commands run. Coordinated replicas leave fresh
claims alone at startup and sweep expired claims every 30 seconds, while command
and attempt fencing rejects late progress or completion from the crashed holder.
Long replica operations and final Codex hydration have 30-minute request
deadlines. Repeated recovery or timeout failures remain visible on the durable
job rather than triggering an implicit project, chat, or dirty-worktree move.

Security audit events are durable PostgreSQL records and are included in normal
database backups. Account users can review their own audit stream and current
active sessions; server owners/admins can review the global stream. Establish a
retention and export policy appropriate for the deployment before opening public
registration. Preserve request IDs and audit rows during incident response, but
do not enrich the ledger with request bodies, prompts, terminal output, source
content, email addresses, or credentials.

When a worker is offline, server-owned conversations and configuration remain
available while worker-backed tabs become unavailable/read-only. Do not move a
dirty worktree, running process, or active agent to another worker implicitly.

## Troubleshooting

- **Server refuses to start:** run Compose `config --quiet`, then inspect the
  first configuration error. Hosted mode intentionally rejects PGlite,
  anonymous auth, an HTTP or missing public API origin, missing or wildcard
  application origins, an absent trusted-proxy list, the currently required
  startup keyring, and replica ceilings smaller than configured limits.
- **Readiness is 503 while health is 200:** inspect the JSON dependency details
  from `/readyz`. Verify PostgreSQL connectivity and migrations first. With
  multiple replicas, verify Redis connectivity, unique instance leases, and
  that live instances do not exceed `CANTRIP_COORDINATION_MAX_INSTANCES`.
- **Login succeeds but the browser acts signed out:** confirm the public origin,
  approved app origin, forwarded HTTPS scheme, cookie `Secure`/`SameSite`
  policy, and proxy preservation of `Host`. Do not loosen CORS to `*`.
- **Worker enrollment or reconnect fails:** confirm the one-time code has not
  expired or been consumed, the worker points at the API origin, and its data
  directory is writable. After enrollment, remove the code and preserve the
  generated credential file. A rotated or revoked credential is expected to
  fail immediately.
- **Worker is online but a tab is unavailable:** verify the resource's execution
  placement and project replica belong to that worker. Repository identity,
  canonical root, dirty state, and exact revision are safety checks; do not
  bypass them by editing database IDs.
- **Commands work only through one server replica:** verify every replica uses
  the same Redis, PostgreSQL, public/application origins, proxy rules, and
  replica ceiling. Check worker presence and coordination rejection metrics;
  sticky routing is an optimization, not a correctness requirement.
- **Code or binary surfaces disconnect:** verify the web app's Code service
  worker and virtual adapter registration, the WorkerLink WebSocket upgrade,
  current attachment/session bindings, and relay-byte/concurrency quotas.
  There is no separate public Code origin or port to probe.
- **Project automation is delayed or recovered:** inspect
  `automation.schedule-sync.*` and `automation.dispatch.*` logs and the
  automation's `nextRunAt`. Verify that the owning worker is online and still
  owns the target chat's active worktree.
  `CANTRIP_SCHEDULER_LEASE_TTL_MS` bounds an in-progress dispatch claim; an
  expired claim may be recovered with a higher fence, and the stale holder
  cannot finalize it.
- **Replica or relocation work is replayed:** inspect the durable job attempt,
  command ID, error, target worker health, and server logs. A coordinated peer
  waits for lease expiry before replay; repeated 30-minute timeouts usually
  indicate a stuck worker operation or an undersized deployment boundary.

Keep request IDs and bounded server/worker logs when escalating a failure. Do
not attach cookies, worker credentials, provider keys, prompts, terminal
content, or source files.

## Incident recovery checklist

1. Block new public traffic and preserve logs and audit events without copying
   secrets, prompts, source, or terminal contents into the incident system.
2. Revoke affected sessions and worker credentials from a trusted account.
3. Globally sign out affected ChatGPT/Grok accounts, revoke upstream OAuth
   sessions when required, and rotate affected static provider API keys. Revoke
   any compromised worker or component-key grant.
4. Restore PostgreSQL and the matching release when durable state is damaged;
   verify that account encryption unlocks and authorized workers can reopen
   their scoped grants.
5. Re-enroll workers only when their credential or persisted encryption
   identity is lost.
6. Validate cross-account isolation, worker routing, opaque provider credential
   fetch/reseal, browser Code adapter isolation, and WorkerLink relay fallback
   before reopening traffic. Use the
   cross-platform provider procedure in
   [`PROVIDER_AUTHENTICATION.md`](PROVIDER_AUTHENTICATION.md) after restoring
   provider-account envelopes.
