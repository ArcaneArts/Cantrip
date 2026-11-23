# Rust operational health and metrics

The native server implements the existing authenticated `GET /api/health` and
authorized `GET /metrics`, including automatic HEAD. This qualification uses
Source `d16227b1fa7acaa4425ee738df2477ae59474699` on local macOS arm64.
Node remains the default server and the complete replacement is unfinished.

## Runtime behavior

Health executes the actual database probe and owned worker query, then returns
the existing protocol schema. Worker heartbeat grace, live presence and global
command counts retain their separate Source meanings. The response includes
actual HTTP, coordination, quota, tunnel, WorkerLink and account-usage collectors.
Schema parsing strips internal database observations, pending usage sequences
and maintenance results as Source does.

Usage is captured before the owned worker query; other live collectors are
sampled after that query, matching Source. A real PostgreSQL relation-lock test
closes App Live while health is blocked on its worker SELECT. Source returns
zero connections after release. The initial native implementation returned the
earlier count of one; the corrected ordering passes the retained regression.

Prometheus uses those same runtime services and the existing transport metrics.
It retains the complete Source HELP/TYPE ordering, labels, escaping, optional
series and integer-byte representations. Physical/logical drift remains exact
beyond JavaScript's safe-integer range. The scheduler recorder and current zero
defaults match Source; Source's production scheduler does not call its scan
recorder, so the port does not invent scan observations.

Authorization permits an authenticated Owner/Admin or the exact configured
Bearer token. Rejection retains 401 and the existing WWW-Authenticate challenge.
An authorized metrics token does not authenticate other API routes. Header
octets retain Node's Latin-1 interpretation, including non-ASCII configured
tokens; an actual protected HTTP comparison caught and corrected an initial
native ASCII-only header conversion.

The outer HTTP observer records rejected requests as well as successful ones.
It retains Source's response-completion behavior: raw WebSocket upgrades and
abandoned responses do not fabricate ordinary response completions. All six
legacy feature transports retain their counters, deprecation headers and
rate-limited operational events. A raw 101 does not acquire ordinary reply
deprecation headers. Observing the still-unported remote-surface connection
route does not implement its HTTP handler.

Readiness records one measured latency and reuses that exact value in its
response and probe metric. Database failure and shared-coordination failure
remain distinguishable. A Redis outage with a healthy database returns 503
without incrementing the database-failure counter. Liveness remains independent
of database availability.

## Executed local qualification

| Suite                          | Executed scope                                                                   | Result                                                  |
| ------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Controlled HTTP/worker/Live    | Three stores × none/password/accounts                                            | 543 paired behavior observations; 54 clean server exits |
| Actual SQL/connection failures | Same nine pairs                                                                  | 72 paired observations; 36 clean server exits           |
| Hosted configuration           | Production Node/native entries, external PostgreSQL, trusted loopback forwarding | 23 paired observations; two clean server exits          |
| Browser/full worker            | Node/Rust × three stores                                                         | 66 product steps; 12 clean server and 18 worker exits   |
| Shared browser/full worker     | Node/Node, Node/Rust, Rust/Node, Rust/Rust on private PostgreSQL/Redis           | 48 product steps; 16 clean server and 12 worker exits   |

The controlled matrix includes 18 actual caller-socket destructions before a
held protected native-defaults acknowledgment. Each admitted worker operation
still succeeds once, while the abandoned HTTP response contributes no completed
POST observation. Eighteen real legacy 101 handshakes then close with the
existing missing-terminal contract. Every legacy request increments only its
endpoint's counter; 108 operational log records form 54 matching pairs.

Failure tests rename the real workers table, restore it, close the actual
database connection and restart the retained profile. They verify public error
redaction, successful-ping preservation after a later query failure, failed
GET/HEAD readiness, exact stored latency, liveness and the original authenticated
session/server identity after restart. The explicitly opted-in Node fault
control owns its actual close promise, so subsequent application shutdown awaits
that operation instead of invoking PGlite UNLISTEN twice. Production database
queries, probes and Node implementation are unchanged.

The hosted suite retains HTTPS/public-host/Origin/forwarding policy before
metrics authorization, role changes, token-only public access, HEAD, CORS and
direct loopback probe exemptions. It exercises trusted forwarding headers,
rather than claiming a TLS-termination or Winterhold deployment rehearsal.

Full-product tests invoke the existing browser `getSystemHealth` SDK and
authenticated metrics with the full built worker and App Live, before and after
retained server restart. Existing encrypted folder creation, attachment,
failure/retry and worker reconnect assertions remain enabled. Shared tests stop
and restart the real Redis process, verify both peers' readiness/metrics and
retain the original worker process through the outage. Source refreshes its
cached instance count through readiness; the tests exercise that real refresh
before comparing the two-instance operational snapshot.

The worker uses current compiled JavaScript and workspace packages with the
unchanged, checksum-verified native Codex 0.166 runtime. No command handler is
substituted in the full-product suite. The worker remains Node.

Fresh Rust library tests pass 67/67, strict all-target Clippy and Rustfmt pass,
the actual Source metrics oracle passes, and all twelve independent contract
graphs match. The new operational graph also survives unrelated base growth.
Local server-boundary and release/deployment-only workflow checks pass.

The standard `pnpm check` exits one at unchanged Node decomposition limits:
`build-app.ts` 1,532/1,500 and `chat-turn-runtime.ts` 2,336/1,999. Downstream
aggregate checks did not run; the repository-wide check is not green.
Earlier fixture/measurement failures remain retained separately.

## Production artifact and remaining scope

The optimized native executable reports version `1.1.2755` through actual
bootstrap requests. Its SHA-256 is
`25b3eb0ca828d42d65de6808e342860221827c33894933842987921c7b31779e`.
The production inventory probe completes all 584 declared requests per peer
with both exits zero and 23 active native fallbacks. Its inspection status
remains one because the complete replacement is unfinished.

Repeatable local suites:

```sh
node --import tsx scripts/server-rust/operational-status-http-compatibility.mjs --database pglite --report /absolute/path/http.json
node --import tsx scripts/server-rust/operational-status-fault-compatibility.mjs --database pglite --report /absolute/path/faults.json
node --import tsx scripts/server-rust/operational-status-hosted-compatibility.mjs --report /absolute/path/hosted.json
node --import tsx scripts/server-rust/actual-folder-client.mjs --operational-status --keep-fixture --database pglite --report /absolute/path/product.json
node --import tsx scripts/server-rust/actual-folder-client.mjs --operational-status --keep-fixture --database postgres --server-pair all --report /absolute/path/shared.json
```

The first two suites use the native `http-sql-fixture` executable through
`CANTRIP_RUST_SERVER_BINARY`. Hosted checks use the production executable through
that variable; product checks use `CANTRIP_TEST_SERVER_BINARY`. Existing
`CANTRIP_TEST_WORKER_PACKAGE`, `CANTRIP_TEST_CLI_BIN`,
`CANTRIP_RUST_DATABASE_FIXTURE_BINARY`, `CANTRIP_TEST_POSTGRES_BIN_DIR`,
`CANTRIP_TEST_REDIS_BIN` and `PGLITE_RUNTIME_DIR` inputs select supplied local
artifacts. Use one shared Cargo target with incremental compilation and debug
symbols disabled when building additional test helpers.

Subsequent [worker-log qualification](RUST_SERVER_WORKER_LOGS.md) completes native
worker HTTP reads and leased streaming; the current inventory retains 21 active
route gaps. Remaining server log buffer/archive and background-service coverage
still need reconciliation. Current supported-platform
and packaged artifacts, longer mixed-server execution/recovery, existing-data
upgrade/post-write rollback, performance comparisons, default Rust cutover and
production Node removal remain required. No GitHub Actions validation or
production Winterhold deployment is performed by this milestone.
