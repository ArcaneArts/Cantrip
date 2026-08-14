# Hosted deployment and recovery

For the release-candidate validation matrix, see
[HOSTED_RELAY_ACCEPTANCE.md](HOSTED_RELAY_ACCEPTANCE.md).

Cantrip's hosted server is the authenticated rendezvous point for applications
and worker-initiated outbound connections. PostgreSQL owns durable account,
conversation, configuration, and routing state. Workers own repositories,
terminals, Codex runtimes, Code profiles, browser processes, and desktop state.
The server never becomes a shared filesystem.

This guide describes the supported container boundary and equivalent native
service operation. It assumes two public HTTPS names:

- `api.cantrip.example` for the API and control/data WebSockets;
- `code.cantrip.example` for the isolated Cantrip Code surface.

The application origin is separate and must appear exactly in
`CANTRIP_APP_ORIGINS`. Do not place the API and Code surface on the same origin.

## Production Droplet release

The committed `deploy/production/` lane deploys Cantrip's control plane to the
current DigitalOcean Droplet as a native, self-contained Linux x64 Server behind
host Caddy. It does not install Docker, Node.js, pnpm, Git, or Infisical on the
Droplet. The release workstation needs:

- a clean `main` checkout equal to `origin/main`;
- Docker Engine with Buildx and Linux AMD64 build support;
- authenticated Infisical CLI access to the project in `.infisical.json`;
- OpenSSH, SCP, and tar; and
- both production DNS names resolving to the `sshHost` in
  `deploy/production/deploy.json`.

The Infisical environment named by that file must define the administrator,
allowed app origins, API and Code origins, database URL, encryption keyring and
active key ID, metrics token, and SSH private deployment key. The deployer reads
them locally and sends only an explicit server-variable allowlist to the host.
The SSH key is never included in the service environment. Secret values are not
printed by the deployment script.

Run a full release from synchronized `main`:

```bash
pnpm release
```

This fast-forwards the `release` branch, cross-builds the Server bundle, writes
the root-only environment, uploads the immutable release, runs the matching
forward migration, switches the active symlink, and restarts Caddy and Cantrip.
It waits for both public HTTPS health endpoints before succeeding. If branch
promotion already succeeded but deployment failed, retry only the host phase:

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
services at boot. Application listeners remain bound to loopback on ports 4310
and 4311. The DigitalOcean cloud firewall remains the outer network boundary.
If the newly restarted Server fails local readiness, the installer restores the
previous application symlink and process. Database migrations are forward-only,
so a database backup is still required before releases that alter schema.

## Container quick start

Requirements:

- Docker Engine 27 or newer with Compose v2;
- public DNS for the API and Code names;
- ports 80 and 443 reaching the proxy host;
- a separately hosted Cantrip web app or a native Cantrip client;
- enough build capacity for the pinned Codex and Cantrip Code toolchains.

Create the operator environment without committing it:

```bash
cp deploy/hosted.env.example deploy/hosted.env
openssl rand -base64 32
```

Use the value as the encryption keyring entry, set `CANTRIP_ADMIN_EMAIL` to the
administrator who will create the first account, and set a random URL-safe
PostgreSQL password in both `POSTGRES_PASSWORD` and `DATABASE_URL`. Then
validate and start the control plane:

```bash
export CANTRIP_VERSION_PATCH="$(git rev-list --count HEAD)"
docker compose --env-file deploy/hosted.env \
  -f deploy/compose.hosted.yml config --quiet
docker compose --env-file deploy/hosted.env \
  -f deploy/compose.hosted.yml --profile proxy up -d --build
```

The server's published 4310/4311 ports bind only to host loopback for
diagnostics. The fixed internal proxy address is the only trusted forwarding
peer. The Caddy profile obtains certificates and serves the two public names.
Use the supplied Nginx example when TLS is managed elsewhere.

The license whitelist is enabled by default. The configured administrator can
open **Admin** from the server selector to add or remove licensed signup email
addresses and see the account count. Disable
`CANTRIP_LICENSE_WHITELIST_ENABLED` only when the operator intentionally wants
open account registration.

The optional worker image is Linux-only and intended for headless repositories,
Codex, terminals, and Code. It cannot expose the Docker host's desktop or normal
GUI browser sessions. Generate a one-time worker link code in Settings, place it
in `CANTRIP_WORKER_ENROLLMENT_CODE`, and run:

```bash
export CANTRIP_VERSION_PATCH="$(git rev-list --count HEAD)"
docker compose --env-file deploy/hosted.env \
  -f deploy/compose.hosted.yml --profile worker up -d --build worker
```

Remove the link code and recreate the worker after enrollment. The `worker-data`
volume retains its unique credential, identity, repositories, Code profile, and
extensions. Never clone this volume to create a second worker.

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

Cantrip migrations are forward-only. Take a verified PostgreSQL backup and keep
the active secret-encryption keyring before applying an upgrade. Run exactly one
migration job against the target release:

```bash
docker compose --env-file deploy/hosted.env \
  -f deploy/compose.hosted.yml run --rm --no-deps server \
  /opt/cantrip/migrate.sh
```

Normal server startup also applies pending migrations, which is convenient for
one-instance installations. Multi-instance operators should use the explicit
job, then replace server replicas gradually. Do not run an older server against
a schema after its documented compatibility window. Rollback means restoring
the pre-upgrade database and matching keyring, not running down migrations.

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

Also back up, through the operator's secret manager:

- every key still present in `CANTRIP_SECRET_ENCRYPTION_KEYS`;
- the Compose configuration and exact Cantrip release identifier;
- Caddy data when preserving the current ACME account is important.

Do not put secrets in the database backup directory. Losing the keyring makes
encrypted provider and MCP credentials unrecoverable even when PostgreSQL is
intact. Redis is coordination/cache state and is not authoritative backup data.

Test restoration on an isolated database regularly:

```bash
cat backups/cantrip-YYYYMMDDTHHMMSSZ.dump | \
  docker compose --env-file deploy/hosted.env \
    -f deploy/compose.hosted.yml exec -T postgres \
    sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      --clean --if-exists --no-owner'
```

Stop Cantrip server replicas before an in-place restore. Restore into an empty or
isolated PostgreSQL instance, supply the matching historical keyring, run the
target release's migration command, and verify account sign-in, worker presence,
project history, and a secret-backed provider before changing production DNS.

Worker volumes require their own filesystem backup policy if repository clones,
dirty worktrees, Code profiles, or local artifacts must survive loss. Git remotes
are the supported cross-worker source boundary; a server backup cannot recreate
unpushed worker-local state.

## Reverse proxy and transport requirements

Only HTTPS/WSS is supported for hosted traffic. The proxy must preserve `Host`,
set `X-Forwarded-Proto: https`, append a syntactically valid
`X-Forwarded-For`, pass WebSocket upgrades, and disable response buffering for
long-lived streams. Configure `CANTRIP_TRUSTED_PROXIES` as the smallest possible
address or subnet containing only the proxy. Direct clients must not be able to
reach the Node ports.

The Code origin is intentionally isolated. Do not rewrite it below the API path
or relax frame ancestors beyond exact application origins. The server refuses
wildcard credentialed origins and ambiguous forwarding headers.

Remote desktop and browser streams prefer direct WebRTC, including host-only
negotiation when no ICE service is configured. `CANTRIP_STUN_URLS` may help
peers discover public candidates. Configure TURN fallback with
`CANTRIP_TURN_URLS` and `CANTRIP_TURN_SHARED_SECRET`; use TLS (`turns:`) outside
trusted networks and monitor TURN egress. Deployments that prohibit direct peer
traffic may set `CANTRIP_WEBRTC_ICE_TRANSPORT_POLICY=relay`. WebSocket relay
remains the compatibility fallback and also consumes server bandwidth.

## Persistence, permissions, and operations

The images run as UID/GID `10001` and use read-only root filesystems. Named
volumes are initialized with correct ownership. For bind mounts, create the
directories first and assign them to `10001:10001`. Never mount the Docker
socket into a worker.

Monitor container restarts, PostgreSQL capacity/latency, Redis availability,
server health/readiness, worker presence, command failures, active WebSockets,
relay bandwidth, scheduler lag, and TURN usage. Health and readiness semantics
are documented by the server version; a live process does not imply that
PostgreSQL, shared coordination, or a required worker is ready.

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
connections, relay bytes and quota rejections, and scheduler throughput/lag.
They contain no account, project, prompt, source, or credential labels.
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
at process start. Use a shared PostgreSQL database, Redis deployment, encryption
keyring, public origins, and proxy configuration. Configure load-balancer
stickiness for WebSockets to reduce cross-instance media traffic, but do not
depend on it: Redis routes worker commands, responses, notifications, binary
frames, disconnects, and application live invalidations to the correct process.

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
local single instance) resets process-transient surface, tunnel, chat execution,
and workflow-attempt state left by a full deployment stop. A server joining an
already-live cluster does not run those global resets, because the records may
belong to a healthy peer. It still scans recoverable workflow worktree leases
and queues durable work through the normal fenced paths. This distinction makes
rolling replacement safe: adding a replica cannot mark active chats failed,
orphan live workflow attempts, invalidate tunnel credentials, or make peer-owned
remote surfaces idle.

Workflow attempts use their existing PostgreSQL heartbeat as a renewable
execution lease. The dispatching server refreshes it every 30 seconds, and every
server scans for attempts stale by at least two minutes every 30 seconds. The
stale cutoff uses PostgreSQL time, and the recovery update compares the exact
observed heartbeat, so application clock skew or a concurrent renewal cannot
let a stale scanner win; a late worker completion is rejected after a successful
recovery because the attempt is no longer active. Cantrip also sends a bounded
best-effort interrupt when the stale runtime is still reachable. Recovered run invalidations,
worktree recovery, and queued-run dispatch retain the owning account across all
server replicas. The server-to-worker request deadline is the bounded node
budget plus a short response grace, capped at 24 hours.

This workflow hardening adds no wire or schema migration. Older workers continue
to execute the same idempotent workflow command. During a rolling server upgrade,
start new replicas before retiring old ones; do not introduce a newly started
older server into the upgraded cluster because older startup code cannot honor
the peer-preservation rule.

Scheduled automation does not use Redis pub/sub as a job queue. Each occurrence
is claimed durably in PostgreSQL with an instance-bound lease and fencing token.
Set `CANTRIP_SCHEDULER_LEASE_TTL_MS` longer than normal condition evaluation and
dispatch latency (the default is 120 seconds). A crashed replica's claim becomes
recoverable after that interval; reducing it too aggressively can cause healthy
dispatchers to be fenced during temporary database or worker latency. Monitor
`cantrip_scheduler_lease_contentions_total`,
`cantrip_scheduler_lease_recoveries_total`, dispatch failures, and maximum lag.

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
  anonymous auth, HTTP public/Code origins, missing or wildcard app origins,
  an absent trusted-proxy list, missing encryption keys, and replica ceilings
  smaller than configured limits.
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
  the same Redis, PostgreSQL, origins, keyring, and replica ceiling. Check worker
  presence and coordination rejection metrics; sticky routing is an
  optimization, not a correctness requirement.
- **Code or binary surfaces disconnect:** confirm the isolated Code origin and
  WebSocket upgrades are proxied without buffering, capability URLs are not
  rewritten, and relay-byte/concurrency quotas are not rejecting the stream.
- **Scheduled work is delayed or recovered:** compare scheduler lag,
  contention, and recovery metrics with
  `CANTRIP_SCHEDULER_LEASE_TTL_MS`. A stale process cannot finalize after a
  higher fencing token has recovered the occurrence.
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
3. Rotate provider credentials and add a new envelope key. Keep old envelope
   keys until all rows rewrap and a verified backup completes.
4. Restore PostgreSQL plus the matching keyring when durable state is damaged.
5. Re-enroll workers only when their credential or identity store is lost.
6. Validate cross-account isolation, worker routing, Code isolation, and TURN
   fallback before reopening traffic.
