# Native Task recovery across server interruption

Local qualification on 2026-11-07 found and fixed an execution-safety defect in
both production server implementations. If a Task executor survived while its
remote worker's relay owner restarted, the old RPC rejected with worker
unavailable. Failure settlement treated that lost transport as an execution
failure, despite the canonical input already having reached native inference.
Automatic retry then submitted additional native work.

## Reproduction and correction

The initial Node reference happened to kill the dispatch executor as well as
the worker's relay owner. Its successful recovery did not establish the behavior
of a surviving remote executor. Read-only SQL snapshots exposed this difference.
An equivalent Node run then reproduced the Rust failure: both failed the active
Task and made 90 additional model requests after the relay owner was killed.

Both servers now consult canonical pending input under the existing
owner, dispatch, round, placement, and execution-lane locks before settling a
transport failure. A prepared input with uncertain execution remains pending for
its worker's authenticated terminal receipt. The check preserves existing input
identity, execution state, lease, and fencing token. It also protects the
claimed-operation failure path when startup ends after input preparation.

Authenticated no-forward evidence retains its existing deferral/failure
handling. Missing input, stale leases, different owners, changed placement,
deferred input, and terminal input cannot acquire authority through this path.
Worker execution errors retain their existing settlement behavior. The remote
bridge still rejects old requests after owner replacement; it never resubmits
an uncertain command to the replacement relay.

## Actual product acceptance

`scripts/server-rust/actual-folder-client.mjs --database postgres
--server-pair all --native-inflight-recovery` runs the existing browser SDK,
complete packaged Node worker, and native Codex against production Node/Node,
Node/Rust, Rust/Node, and Rust/Rust server pairs. Each pair shares private
PostgreSQL and Redis. The browser and worker attach to opposite peers.

Each pair passed all three scenarios:

1. Kill and restart the browser-facing peer during a real held model stream.
2. Kill and restart the worker-owning peer during a real held model stream.
3. Withhold a real committed HTTP 202 admission response until native execution
   starts, kill the browser-facing peer, and abort delivery of that response.
   The SDK observes an actual network failure. Replay the original request body
   and operation UUID before and after completion; both replays return HTTP 202.

The matrix completed 48 recorded product steps, including 12 intentional
SIGKILL boundaries, 16 normal server exits, and 12 normal worker exits. Every
interrupted Task retained the original full-worker process, credential, native
model stream, and worker continuity identity. Each completed with one model
POST, one canonical round, one dispatch cycle, one dispatch attempt, and one
decrypted answer. Earlier completed Task DTOs and complete message histories
were compared exactly after later interruptions. Private prompt/answer markers
were absent from browser-to-server requests and server diagnostics, including
diagnostics of killed generations.

Focused Node and Rust runs also require the surviving front peer to own the
actual dispatch lease. Other scheduler placements complete normally and remain
in the evidence; they do not count as the requested fault. The harness does not
seed leases, replace schedulers, or substitute worker command handlers.

## Lease expiry

Both Node/Node and Rust/Rust passed a longer focused run with:

```sh
--native-inflight-recovery --inflight-peer worker \
  --inflight-executor client --inflight-expire-lease
```

The real model stream remains held after relay-owner replacement until SQL
reports expiry of the original two-minute dispatch lease. The actual fencing
token advances from 1 to 2 while the Task retains its original operation and
attempt count. Releasing the original model response then completes the Task
once through its exact saved worker receipt. No replacement inference occurs.

## Active Task during a Redis process outage

The current Rust and Node production peers pass this scenario in all four
pairings on local macOS ARM64 with external PostgreSQL and Redis 8.10.3.
The browser-facing server owns the actual PostgreSQL dispatch lease. The full
Node worker and its native Codex process run through the other server. Both
schedulers run normally. An independent Task assigned to the other scheduler
finishes as a warmup and does not count as an outage case.

The test holds an actual native model response open, saves Redis's RDB, then
kills Redis. Both servers stay up and report HTTP 503 for coordination while
PostgreSQL stays ready. During the 45-second outage, the original PostgreSQL
dispatch lease advances by about 40 seconds with the same owner and fencing
token. The model response is released while Redis is still down. The Task
finishes with one model POST, one canonical round, one dispatch attempt and one
decrypted answer. Read-only SQL snapshots verify completion before Redis
restarts.

The restarted Redis process reports three expired keys in each saved RDB.
The same worker process and enrollment return under a fresh Redis connection
ID. Both servers become ready, and the browser-facing server dispatches and
releases a fresh WorkerLink session through the other server. The initial test
incorrectly expected the Redis connection ID to survive a claim expiry. Both
implementations rotated it, and the final comparison requires a new connection
ID with the same worker continuity identity.

A separate Rust/Node run kills the Node server that owns the worker while
the Rust server owns the dispatch lease. It confirms the existing recovery
scenario still completes the Task once using the same worker.

```sh
node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --database postgres --server-pair all --native-inflight-recovery \
  --inflight-peer redis --keep-fixture --report /absolute/path/to/redis-outage.json
```

The [current acceptance record](security/rust-server-active-redis-outage.json)
identifies the executables, reports and retained fixture archive. This local
comparison covers a Redis process restart and expired claims. Redis network
partition, TLS behavior and the final shipping artifacts remain separate.

## Active Task during a PostgreSQL process outage

Two current Rust production servers share private external PostgreSQL and
Redis. The browser-facing server holds the Task's actual dispatch lease and
the other server owns the worker connection. The existing full Node worker
and Codex runtime run the Task.

The test waits for the original model response to stream, then stops the
owned PostgreSQL postmaster with `SIGQUIT`. Both Rust servers report HTTP
503 while Redis responds to PING. The worker finishes the original response,
writes its protected outcome to its durable outbox and attempts authenticated
delivery while PostgreSQL is still down. The test verifies the same bytes
and original dispatch fence before the database restarts. Two independent
Rust/Rust runs keep PostgreSQL down for 45 seconds.

The new PostgreSQL process uses the same cluster and port and logs automatic
recovery. Both server processes and the full worker keep their identities.
The Task finishes with one inference, one dispatch attempt, the original
fencing token and one decrypted answer. The matching outcome leaves the
worker outbox, and a new remote WorkerLink request succeeds.

The initial readiness assertion expected coordination to report ready when
PostgreSQL was unavailable. The existing readiness endpoint skips its
coordination check when the database check fails. The corrected test checks
both the HTTP response and the actual Redis connection independently.
The compiled Node reference exited with an unhandled PostgreSQL connection
error when it owned the Task dispatch in the initial Node/Node and Node/Rust
runs and again after the test correction. The Rust/Node run timed out and its
Node peer was killed during fixture shutdown. The reference failures are
retained, and this case qualifies Rust/Rust. The Redis process-loss scenario
also passed as a control.

```sh
node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --database postgres --server-pair rust/rust --native-inflight-recovery \
  --inflight-peer postgres --keep-fixture --report /absolute/path/to/postgres-outage.json
```

Use `CANTRIP_TEST_POSTGRES_BIN_DIR` to select the PostgreSQL binaries. The
[acceptance record](security/rust-server-active-postgres-outage.json) identifies
the current artifacts and reports.

## Local validation and artifacts

- Optimized macOS ARM64 Rust server build: passed in 4m09s.
- Strict Clippy over all targets: passed, `-D warnings`.
- Canonical Task input authority, automatic retry, and outcome recovery: 66
  tests passed, including prepared/dispatched transport uncertainty, stale
  authority rejection, positive no-forward evidence, and absent input.
- Formatting, workflow-removal verification, and `git diff --check`: passed.
- `pnpm check`: stopped at unchanged decomposition budgets in `build-app.ts`
  (1532/1500) and `chat-turn-runtime.ts` (2336/1999); later stages did not run.
- The existing Goal worker-interruption suite has four stale-mock failures
  (`queuedStandaloneTransfer` and `goals.terminal`). An exact `git archive` copy
  of baseline `b2a9177338cc57a2e86a3ae0edbc021836f8cc2f` reproduces all four;
  that suite is not reported as passing.

The tested Rust executable is 91,230,256 bytes, SHA-256
`f51d187832a99aae9f49f5b39a863b9a6455c555d5ea449238f5fabe4bbc3e65`.
The worker is the unchanged packaged Node worker with Codex 0.166.0. Optional
artifact environment overrides select these actual binaries; they do not
change the tested product graph. All validation was local. No GitHub Actions
or production Winterhold deployment was used.

## Scope still requiring qualification

These shared-server cases use external PostgreSQL. The current
[replacement reconciliation](RUST_SERVER_ACCEPTANCE_RECONCILIATION.md)
tracks other interruption boundaries, store and platform qualification,
performance, and final shipping artifacts.
