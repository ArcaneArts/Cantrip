# Worker log reads and leased streams

The Rust server now implements owned worker log history and the leased log
WebSocket using the existing worker commands and notification transport. Local
qualification includes all three stores, authentication modes, the full worker,
existing browser APIs, and all four Node/Rust Redis peer pairings. Node remains
the default server and the complete replacement is unfinished.

## Preserved behavior

`GET` and automatic `HEAD /api/workers/:workerId/logs` retain query coercion,
strict unknown-field handling, cursor bounds, level selection and defaults:
`afterCursor=0`, `limit=200`, `minimumLevel=trace`. Ownership precedes dispatch;
foreign and missing workers both return 404, and owned offline workers return 503. Worker requests retain the real five-second deadline, failure mapping,
response validation, record normalization and `Cache-Control: no-store`.

Fastify ignores GET/HEAD bodies. Actual malformed JSON, unsupported media,
prototype-shaped JSON and a 300,000-byte GET body therefore still reach the read
handler. The native handler preserves that behavior. Malformed CORS preflight
returns the existing 400 text response. Plain HTTP GET to the stream path returns
an empty 404. Source's automatic HEAD invokes its WebSocket handler as HTTP and
produces a redacted 500; its status, headers and HEAD response length are also
preserved.

`/api/workers/:workerId/logs/stream` retains Origin, authentication, session,
ownership and worker-connectivity checks. Unauthenticated account/password
clients receive HTTP 401 before an upgrade or worker dispatch. It selects only the stream's cursor
and minimum-level query fields. Each stream receives a UUID subscription, a
120-second worker lease, renewal every 60 seconds and a WebSocket heartbeat every
25 seconds. Initial batches can precede the start acknowledgment; `ready` retains
the requested cursor. Other subscription IDs cannot inject records.

Cleanup removes subscriptions and timers and stops an acknowledged worker lease.
This includes late acknowledgments after caller close, worker disconnect,
session revocation, invalid frames, renewal failure and actual slow consumers.
Application-frame UTF-8 bytes and operation counts are metered as owned
`worker-log-stream` egress. Worker logging and execution remain in Node.

## Reproduced lifecycle repair

An actual PostgreSQL exclusive lock on `workers` held the production ownership
query while an upgraded client closed its TCP connection. Source originally
installed its close listener after that query and still issued a stream-start
command for the departed caller. The retained failing run records one start
where zero was expected. Source now installs cleanup before awaiting ownership
and checks the socket again afterward. Both implementations pass the same real
relation-lock regression without admitting a lease.

A separate test pauses the TCP reader and sends one large initial notification
before acknowledging start on the same worker connection. Both servers deliver
that batch, refuse `ready` with 1013, stop the lease once, and issue no renewal
after another full minute. Source now returns when `ready` cannot be sent,
preventing a new renewal timer from being installed after cleanup.

## Executed local qualification

| Scenario                                      | Scope                                           | Result                                                                                                                        |
| --------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| HTTP and controlled worker transport          | Three stores × none/password/accounts           | Nine matching pairs, 513 paired HTTP observations, 264 paired stream/command cases, 18 clean server exits                     |
| Real command and lease timers                 | All three stores                                | Five-second read/start deadlines, 25-second pings, successful minute renewal, worker renewal failure and strict reply failure |
| Blocked reader and accounting                 | Real TCP backpressure                           | 1013, one lease stop, exact received frame bytes and operations persisted to owned egress usage                               |
| Initial batch before start ACK under pressure | PGlite, Source/native                           | One batch, no ready frame, one stop and no renewal after 61 seconds                                                           |
| Ownership-query caller loss                   | Actual external PostgreSQL lock, Source/native  | Zero lease admissions after caller close; red/green Source reproduction retained                                              |
| Existing browser and full current worker      | Six single-server cells and four Redis pairings | 130 product steps, 28 clean server exits and 30 clean worker exits                                                            |
| Generated wire contracts                      | Five worker-log roots plus existing graphs      | Source oracle/growth test passes; all 13 generated manifests match Source                                                     |

The browser runs use the existing `getWorkerServiceLogs`, WebSocket URL builder
and message parser. They read bounded newest/older history, select severity,
receive actual full-worker startup/replay records, observe worker-offline and
1013 on real worker stop, and repeat after retained server restart. Shared runs
place browser and worker on opposite peers for Node/Node, Node/Rust, Rust/Node
and Rust/Rust. Release runs retain the actual spawned executable and its hash.

All 68 Rust library tests, the seven focused Source tests, strict all-target
Clippy, source/boundary/workflow audits and focused formatting/syntax checks pass
locally. The root `pnpm check` still stops at unchanged Node line limits:
`build-app.ts` 1,532/1,500 and `chat-turn-runtime.ts` 2,336/1,999. Later aggregate
checks did not run. Earlier fixture failures and preliminary debug-executable
product runs remain separate from final qualification.

## Repeating the checks

Build the workspace packages and Source server first. The controlled harness
uses `CANTRIP_RUST_SERVER_BINARY` for the actual `http-sql-fixture` executable:

```sh
node --import tsx scripts/server-rust/worker-log-http-compatibility.mjs \
  --database pglite --report /absolute/path/worker-logs.json
```

Select `bundled-postgres` or `postgres` for the other stores. Optional
`--profile none --timers`, `--stress --accounting`, `--startup-pressure
--accounting`, and external-PostgreSQL `--query-lifetime` execute the corresponding
real fault scenarios. The accounting observer allows the actual default
60-second meter flush; it does not change production intervals.

The full browser/worker harness uses **`CANTRIP_TEST_SERVER_BINARY`** for a
production native executable, plus supplied `CANTRIP_TEST_CLI_BIN` and
`CANTRIP_TEST_WORKER_PACKAGE`. Run `actual-folder-client.mjs --worker-logs
--keep-fixture` with each database; `--server-pair all --database postgres`
selects the four shared pairings. Supply the actual private PostgreSQL fixture
through `CANTRIP_RUST_DATABASE_FIXTURE_BINARY` and Redis through
`CANTRIP_TEST_REDIS_BIN`. Reuse one `CARGO_TARGET_DIR` with incremental builds
disabled rather than creating per-worktree targets. These are local development
checks; no GitHub Actions validation is dispatched.

## Artifact and remaining acceptance

The qualified macOS arm64 production executable reports version `1.1.2756`:

- SHA-256: `658eb13dd75f0cacfcd9d275241ec37228f551af6cb23f30355872ce85936f36`
- Size: 92,152,704 bytes.

The current production inventory completes all 584 requests per peer, with both
servers exiting zero and 21 active Rust fallback routes. The inspection command
still exits one for those genuine gaps. Its absent-resource/non-upgrade requests
do not prove successful behavior for other domains.

Current supported-platform and packaged artifact acceptance, broader coordination
faults, remaining background-service reconciliation, performance comparisons,
final upgrade/post-write rollback acceptance, desktop/Winterhold rehearsal,
default Rust selection and production Node-server removal remain required.
This milestone does not establish whole-server replacement readiness.
