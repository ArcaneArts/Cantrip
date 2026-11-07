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

This matrix uses external PostgreSQL for shared-server coordination. Remaining
server-replacement acceptance includes in-flight single-server/worker recovery
across all three storage modes, further Agent/Goal interruption boundaries,
Redis network and TLS failures, final platform/artifact and performance
qualification, default Rust cutover, and production Node server removal.
The full server replacement goal remains active.
