# Account resource usage accounting

Cantrip durably measures per-account logical server storage, server-known
worker attachment storage, and application payload bandwidth. The current
measurements are visible under **Settings → Usage** and through authenticated
APIs. They are infrastructure for future limits, not billing-grade usage, and
no storage or bandwidth entitlement is enforced by this system.

Usage metadata is ordinary server control-plane data. It is not protected
content and does not need Cantrip envelope encryption. Usage rows contain only
owner identifiers, bounded categories, directions, timestamps, byte/count
totals, and accounting metadata. They never contain messages, URLs, filenames,
commands, payload bodies, headers, credentials, or file contents.

## Storage definitions

### Logical server storage

An account's server storage is the sum of `pg_column_size(row)` for active rows
currently retained on that account's behalf. The accounting basis identifier
is `postgres-logical-row-bytes-v1`. A full reconciliation writes a fast current
projection and point-in-time history, so account API reads do not rescan the
domain tables.

This is a stable logical PostgreSQL row measurement, not physical allocation:

- row values retained by Cantrip count, including archived records;
- protected ciphertext stored in a retained row counts like any other row
  value, but the usage record contains only its measured size;
- deleted domain rows stop contributing to the current projection after the
  next reconciliation, while previously written history remains;
- account deletion cascades through that account's current and historical
  usage records; and
- all large counters are PostgreSQL `bigint` values and cross the protocol as
  decimal strings.

It deliberately does not assign shared heap pages, indexes, TOAST layout,
free space, write-ahead logs, temporary data, database bloat, or filesystem
allocation to individual accounts. `pg_database_size(current_database())` is
exported when the database supports it, but only as a global operational
metric. It must not be presented as an account total.

The exhaustive source of truth is
[`STORAGE_ACCOUNTING_MANIFEST`](../cantrip_server/src/account-usage/storage-manifest.ts).
A test compares that manifest with every exported Drizzle table, so adding a
table without an explicit classification fails the server suite. Included
server rows are grouped as follows:

| Category        | Included domains                                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account`       | User/session state, mobile grants, worker enrollment and identity, worker credentials, and account encryption principals/grants                          |
| `configuration` | Settings, providers and provider accounts, models and routes, policies and assignments, MCP definitions, Code settings, and current catalog state        |
| `projects`      | Projects, workspaces, tabs/groups, sources, worktrees, setup/replica/Git jobs, Run runtimes, terminals, explorers, browsers, surfaces, and tunnels       |
| `conversations` | Chats, tasks and planning rounds, messages, drafts/plans, runtime lanes, interactions, queued prompts, attachment metadata, imports, and relocation data |
| `workflows`     | Definitions, revisions, graph nodes/edges, runs, run nodes/items/attempts/events/gates, triggers/deliveries, automations, and worktree/branch leases     |
| `analytics`     | Audit events, token usage, provider quota/catalog history, and model behavior observations                                                               |

Global `system_state` and the server-wide license whitelist are intentionally
excluded because they are platform-owned. The current projections, snapshots,
reconciliation leases, bandwidth buckets, and flush ledger are also excluded
so accounting cannot recursively increase measured account usage. Rows with no
resolvable owner are not attributed.

### Worker-managed attachment storage

Worker file storage is reported separately from server row storage. The server
can authoritatively derive only these metadata-backed estimates:

- **Attachment sources:** `size_bytes` once for each ready attachment.
- **Ready replicas:** `size_bytes` once for every ready attachment-replica row;
  the count is the number of ready copies represented by that metadata.

Pending or failed sources and replicas do not count. These values are labeled
`server-known-estimate`: they do not scan worker disks and do not claim to know
filesystem block allocation, compression, stale unregistered files,
repositories, Git worktrees, arbitrary project files, browser profiles, or
other worker state. Attachment metadata rows themselves still count in logical
server storage under `conversations`; attachment byte estimates never get
folded into that total.

### Reconciliation behavior

The server runs a full storage reconciliation on startup and periodically
thereafter. A database-backed lease allows only one server instance to perform
the sweep at a time. The projection is atomically replaced only while the
lease remains held. The sweep is the correctness backstop; domain writes do not
contend on a hot per-account usage counter.

Each successful sweep records an hourly UTC point-in-time snapshot. Repeated
sweeps in the same hour replace that point with the latest measurement rather
than adding storage states together. The API marks storage unavailable before
the first baseline and stale when the last reconciliation is more than two
hours old.

The same PostgreSQL-compatible queries and migrations run against production
PostgreSQL and the embedded PGlite server. Some optional operational functions,
notably physical database size, may be unavailable in PGlite; that does not
disable per-account reconciliation.

## Bandwidth definitions

Bandwidth is the encoded application payload observed crossing a real Cantrip
server network boundary. `ingress` means bytes received by the server;
`egress` means bytes sent by the server. TLS, TCP, proxy, HTTP-header, WebSocket
framing, and operating-system overhead are outside reliable account
attribution and are excluded.

The bounded channels are:

| Channel                    | Counted boundary                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `http`                     | Authenticated request bodies and serialized or streamed responses                  |
| `client-live-websocket`    | Client application-live JSON messages                                              |
| `worker-control-websocket` | Authenticated worker command and response/event messages                           |
| `worker-log-stream`        | Worker log-stream application messages                                             |
| `terminal-relay`           | Terminal application messages relayed through the server                           |
| `remote-surface-relay`     | Browser/desktop control and media frames using the server WebSocket relay          |
| `tunnel-relay`             | Generic unified tunnel data-plane frames                                           |
| `attachment-transfer`      | Attachment upload and download bodies                                              |
| `code-relay`               | Unified tunnel frames for managed Cantrip Code                                     |
| `project-share-relay`      | Unified tunnel frames for project network shares                                   |
| `other`                    | A bounded fallback for attributable server application payload added in the future |

A relayed client → server → worker frame has two legitimate physical server
boundaries: client ingress and worker egress. A return frame likewise has
worker ingress and client egress. Each boundary is recorded once. This makes
the account total represent server-carried bytes without pretending that the
two legs are one network transfer.

Direct LOCAL, LAN, and WAN WorkerLink traffic bypasses the server and therefore
does not enter per-account server bandwidth. Existing aggregate direct-plane
metrics remain separate. WebSocket ping/pong transport overhead and payloads
rejected before an account can be authenticated are also not attributed.
Authenticated request/response payloads are counted even when the eventual
application response is an error. Attachment accounting uses bytes that
actually pass through the stream, not the attachment's declared plaintext
size.

Existing short-window abuse controls remain independent and active. The
durable meter does not weaken `CANTRIP_ACCOUNT_RELAY_BYTES_PER_MINUTE`, upload,
request-rate, concurrency, WebSocket, worker, or surface limits.

### Durable meter behavior

One shared in-memory meter accepts owner, direction, channel, bytes, and an
optional operation count. It validates nonnegative safe inputs, aggregates by
owner/hour/channel/direction, and flushes batches after a one-minute default
interval or byte threshold. Recording never performs database I/O.

Every process uses a unique meter ID and monotonic sequence. A durable flush
ledger makes an ambiguous retry idempotent, while additive bucket upserts let
multiple server instances contribute safely to the same UTC hour. Failed
flushes remain pending and retry without crashing request processing. The
buffer has a configurable dimension bound; rejected measurements are exposed
through dropped-byte/count metrics. Graceful shutdown attempts the pending
batch twice, covering an ambiguous first result.

## Persistence, rollup, and retention

The normalized tables are:

| Table                                   | Purpose                                                         |
| --------------------------------------- | --------------------------------------------------------------- |
| `account_storage_usage_current`         | Fast current storage projection by owner/class/category         |
| `account_storage_usage_snapshots`       | Hourly and daily point-in-time storage history                  |
| `account_storage_reconciliation_leases` | Multi-instance reconciliation and maintenance fencing           |
| `account_bandwidth_usage_buckets`       | Additive hourly/daily bytes and operations by channel/direction |
| `account_bandwidth_flushes`             | Short-lived idempotent batch ledger                             |

Hourly history is retained for 30 days by default. Older complete UTC days are
rolled into daily rows, which are retained for 400 days. Storage daily rollup
keeps the most recently measured state in each day; bandwidth daily rollup sums
the day's deltas. Late bandwidth adds to an existing daily row, while a late
storage point replaces it only when it is newer. The flush ledger is retained
for 7 days. Rollup, retention, and lease acquisition are idempotent and safe
across server instances.

## Configuration

All values are server environment variables. Defaults are suitable for local
development and a modest hosted deployment.

| Variable                                        |   Default | Valid range       | Meaning                                  |
| ----------------------------------------------- | --------: | ----------------- | ---------------------------------------- |
| `CANTRIP_STORAGE_RECONCILIATION_INTERVAL_MS`    | `3600000` | 1 minute–24 hours | Full storage sweep interval              |
| `CANTRIP_BANDWIDTH_USAGE_FLUSH_INTERVAL_MS`     |   `60000` | 250 ms–60 seconds | Maximum normal in-memory flush interval  |
| `CANTRIP_BANDWIDTH_USAGE_FLUSH_THRESHOLD_BYTES` | `1048576` | 1 KiB–1 GiB       | Buffered-byte threshold for early flush  |
| `CANTRIP_BANDWIDTH_USAGE_MAX_BUFFERED_ENTRIES`  |    `4096` | 64–65,536 entries | Bound on owner/bucket/channel dimensions |
| `CANTRIP_ACCOUNT_USAGE_MAINTENANCE_INTERVAL_MS` | `3600000` | 1 minute–24 hours | Rollup and retention interval            |
| `CANTRIP_ACCOUNT_USAGE_HOURLY_RETENTION_DAYS`   |      `30` | 1–30 days         | Detailed hourly history                  |
| `CANTRIP_ACCOUNT_USAGE_DAILY_RETENTION_DAYS`    |     `400` | 31–3,650 days     | Rolled daily history                     |
| `CANTRIP_ACCOUNT_USAGE_FLUSH_RETENTION_DAYS`    |       `7` | 1–90 days         | Flush idempotence ledger                 |

Daily retention must be longer than hourly retention. Lower flush intervals
and thresholds increase database work. A buffer that reaches its entry limit
drops only new dimensions, reports degradation, and keeps serving traffic.

## Authenticated APIs

All three endpoints are owner-scoped, return `Cache-Control: private, no-store`, and
derive the owner exclusively from the authenticated session. No caller can
select an owner ID.

### `GET /api/account/resource-usage`

The response contains the current reconciled projection and the current UTC
day's bandwidth. Representative shape:

```json
{
  "measurement": {
    "basisVersion": "postgres-logical-row-bytes-v1",
    "measuredAt": "2026-08-23T12:00:00.000Z",
    "reconciledAt": "2026-08-23T12:00:01.000Z",
    "status": "current"
  },
  "storage": {
    "server": {
      "accuracy": "logical-reconciled",
      "logicalBytes": "123456",
      "rowCount": "900",
      "categories": [
        {
          "category": "conversations",
          "logicalBytes": "100000",
          "rowCount": "700"
        }
      ]
    },
    "workerManaged": {
      "accuracy": "server-known-estimate",
      "attachmentSources": { "logicalBytes": "4096", "objectCount": "2" },
      "readyReplicas": { "logicalBytes": "8192", "objectCount": "4" },
      "logicalBytes": "12288"
    }
  },
  "bandwidth": {
    "accuracy": "metered",
    "measuredAt": "2026-08-23T12:00:05.000Z",
    "periodStart": "2026-08-23T00:00:00.000Z",
    "periodEnd": "2026-08-24T00:00:00.000Z",
    "ingressBytes": "2048",
    "egressBytes": "8192",
    "operationCount": "12",
    "breakdown": []
  },
  "limits": null,
  "enforcement": "disabled"
}
```

`current`, `stale`, and `unavailable` describe reconciliation freshness.
Accuracy is one of `logical-reconciled`, `server-known-estimate`, `metered`,
`stale`, or `unavailable`. Every byte/count field is a decimal string; clients
must use bigint-capable parsing rather than JavaScript `number`.

### `GET /api/account/resource-usage/history`

Required query fields are:

- `metric=storage|bandwidth`;
- `resolution=hour|day`; and
- ISO-8601 UTC `from` and `to`, with `from < to`.

`from` is inclusive and `to` is exclusive. Hourly queries are bounded to 31
days; daily queries are bounded to two years. Each returned series contains at
most 744 points. Storage series are partitioned by storage class/category and
contain logical bytes plus row counts. Bandwidth series are partitioned by
channel/direction and contain bytes plus operation counts. Timestamps are
stable UTC bucket starts.

Both response families intentionally include `limits: null` and
`enforcement: "disabled"` so later limits can be introduced without changing
the resource shape.

### `GET /api/account/live-traffic`

This endpoint returns an owner-scoped, volatile view of application traffic
observed by the current server process. It is sampled in one-second buckets over
a five-minute window and is intended for the active-server switcher's
live-traffic panel, not durable accounting or billing history.

The response identifies the current server `instanceId`, a process-instance
`epoch`, and an incremental `cursor`. A request may provide `epoch` and `after`
together to retrieve only newer buckets; they are an all-or-none pair, and a
malformed cursor returns `400`. An epoch mismatch or a syntactically valid
cursor whose timestamp is expired or future, or whose revision is ahead of the
server's current owner revision, sets `reset: true` and returns the current
window so the client replaces its chart history.

Each sample reports upload/download application bytes, authenticated non-WebSocket
HTTP request count, and `client-live`/`worker-control` WebSocket message counts.
Terminal, tunnel, and Remote Surface relay traffic can contribute bytes without
incrementing that WebSocket message count. The endpoint excludes its own
observation requests entirely. It also excludes transport overhead and direct
LOCAL, LAN, or WAN WorkerLink traffic because those bytes never cross the server
process. The response is `Cache-Control: private, no-store` and is never
persisted or rolled up.

## Client refresh behavior

Successful reconciliation and meaningful bandwidth flushes publish a
coalesced, current-user `account-resource-usage` invalidation over the existing
application-live WebSocket. The app invalidates both the current and history
React Query keys. While the live channel is healthy there is no fixed usage
poll. A disconnected client uses a conservative one-minute fallback and
authoritative HTTP snapshots; reconnect/resync follows the normal live-channel
recovery barrier.

The server-switcher live-traffic panel polls its volatile endpoint once per
second only while the panel is visible. That request excludes itself from both
live bytes and request counts. Durable resource-usage reads remain metered but
suppress another usage invalidation, preventing an observation feedback loop.

## Operations and troubleshooting

`GET /api/health` includes aggregate meter, reconciliation, maintenance, and
global storage totals. Authenticated `GET /metrics` exports no owner labels.
Important Prometheus series include:

- `cantrip_account_usage_storage_reconciliations_total`;
- `cantrip_account_usage_storage_reconciliation_duration_seconds`;
- `cantrip_account_usage_storage_reconciliation_seconds_since_success`;
- `cantrip_account_usage_storage_reconciliation_accounts` and `_categories`;
- `cantrip_account_usage_bandwidth_buffered_bytes` and `_buffered_entries`;
- `cantrip_account_usage_bandwidth_flushes_total` and
  `_flush_duration_seconds`;
- `cantrip_account_usage_bandwidth_dropped_bytes_total` and
  `_dropped_measurements_total`;
- `cantrip_account_usage_history_maintenance_total`,
  `_duration_seconds`, and `_seconds_since_success`;
- `cantrip_account_usage_logical_bytes{storage_class=...}`;
- `cantrip_database_physical_size_available` and, when available,
  `cantrip_database_physical_bytes`; and
- `cantrip_account_usage_physical_logical_drift_bytes`.

The physical/logical drift value is a diagnostic comparison, not an invariant
that should converge to zero: physical size includes shared/global tables,
indexes, TOAST, free space, and accounting rows that logical account totals
exclude.

When usage appears wrong:

1. Check the last reconciliation/flush/maintenance timestamps and failure
   counters in `/api/health` or `/metrics`.
2. If storage is unavailable or stale, inspect structured
   `account-usage.storage-reconciliation.*` events and database readiness.
3. If bandwidth stops advancing, inspect buffered entries, flush failures, and
   dropped measurements. Repeated failures retain the pending idempotent batch.
4. If one replica continually reports lease contention, confirm every process
   uses the shared database and a unique `CANTRIP_SERVER_INSTANCE_ID`; another
   healthy replica may legitimately own the lease.
5. Compare global logical bytes with physical database size only as a trend.
   Investigate abrupt changes, not a permanent nonzero difference.
6. For attachment discrepancies, verify source/replica metadata is `ready` and
   remember that unregistered worker files are intentionally unknown.

## Future limit integration

No request is rejected and no storage is reserved from these measurements.
Future storage enforcement should combine the reconciled current projection
with explicit, transactionally expiring reservations for accepted writes; a
periodic sweep remains the drift-correction backstop. Future bandwidth
enforcement can consume the durable UTC buckets plus the current process's
unflushed aggregate, with a shared low-latency coordination strategy for
multi-instance hard limits.

Any future policy must define grace, race, retry, deletion, and account-tier
semantics before changing `limits` or `enforcement`. The present measurements
must not be marketed as billing-grade until production reconciliation and
drift validation establish that standard.
