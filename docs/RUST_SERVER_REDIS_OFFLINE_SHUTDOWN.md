# Shutdown while Redis remains unavailable

The production server shutdown path previously waited for Redis to reconnect
while releasing a connected worker's claim. Native shutdown stopped at
`worker-bridge-close`. Node also waited while quitting its unavailable Redis
connections. Real local Node/Node and Rust/Rust runs each exceeded the unchanged
30-second shutdown deadline and required SIGKILL after Redis had remained down
for more than three presence TTLs. The application peer in the native run
exited cleanly; its worker-owning peer hung.

Shutdown now begins a coordination drain before closing services. The native
command queue wakes queued reconnect waiters during this phase. A healthy
connection continues servicing cleanup; an unavailable connection settles queued
directory work so service cleanup can finish before the coordinator closes.
Node destroys unavailable command/subscriber connections only during shutdown,
including when an actual connection error arrives after draining starts.
Healthy cleanup retains normal Redis claim-release operations. Existing
generation/authority fencing and TTLs remain unchanged.

Outside shutdown, the original offline queue, ordering, caller-drop lifetime
and reconnect behavior remain in use. No speculative startup probe, additional
operation timeout or protocol change is introduced.

## Local reproduction

Use the build/dependency and artifact setup from
[shared product acceptance](RUST_SERVER_SHARED_PRODUCT.md), selecting the
current built server executable. Then run:

```sh
node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --database postgres --server-pair all --redis-offline-shutdown \
  --keep-fixture --report .qa/shared/redis-offline-shutdown.json
```

The browser uses the existing encrypted application SDK. The complete packaged
worker attaches to the opposite production server peer. The driver observes its
real Redis claim, saves and kills the private Redis process, then samples both
servers' actual readiness over more than three configured presence TTLs.
SQL must stay ready while coordination reports unavailable.

Both servers then receive their normal shutdown request while Redis stays down.
The original full worker must remain alive, both server processes must exit
zero within 30 seconds, and the fixture must not restore Redis to make cleanup
succeed. Reports retain process generations, output, readiness samples and
shutdown duration. Failed profiles are preserved for inspection.

The separate Redis coordinator suite retains its original 11-second outage
assertion: an uncached directory request remains pending during normal
operation and completes after actual Redis recovery. Healthy orderly rolling
replacement is also qualified separately to check that shutdown draining does
not prevent normal claim release and worker reconnection.

## Observed local results

On November 7, 2026, the optimized native server and rebuilt production Node
entry passed all four pairings on macOS ARM64 with private PostgreSQL, Redis
8.10.3, Node 24.22.1 and the unchanged packaged worker/native Codex 0.166.0:

| Application/worker-owner peer | Actual Redis outage | Shutdown of both peers |
| ----------------------------- | ------------------: | ---------------------: |
| Node/Node                     |      15.319 seconds |             1,347.6 ms |
| Node/Rust                     |      15.311 seconds |               950.9 ms |
| Rust/Node                     |      15.312 seconds |             1,201.6 ms |
| Rust/Rust                     |      15.307 seconds |                 5.4 ms |

These are individual fault-test observations. All 16 server and 12 worker exits
were zero. The original worker PID remained alive throughout each outage and
server shutdown, with Redis still unavailable. The outage suite recorded ten
scenario steps per pairing, including existing encrypted folder/restart checks.

A separate healthy run combined encrypted resources/files, workspace and dirty
editor state, PTY/WorkerLink, native Agent/Goal/history and orderly replacement.
All four pairings passed 35 recorded steps each, 32 clean server exits, 32 clean
worker exits and eight peer replacements. It retained exact completed native
history and real encrypted file operations with the same worker PID during
replacement.

The original coordinator suite passed all 56 groups, including uncached reads
remaining pending during an 11-second ordinary outage and completing after
Redis returned. Sixteen existing Node coordination tests, strict all-target
Clippy and formatting passed. The root `pnpm check` still stops at unchanged
Node file budgets (`build-app.ts`: 1,532/1,500; `chat-turn-runtime.ts`:
2,336/1,999); later aggregate stages remain unrun. Validation was entirely local.

The qualifying reports are `all-fixed-v1.json`, `healthy-rolling-v1.json` and
`coordinator-regression-v1.json`. Original `rust-baseline-v1.json` and
`node-baseline-v1.json` retain the actual deadline failures and shutdown logs.
The optimized native binary SHA-256 is
`b74b9de9cbd10cbca7bc2ae78e98b0d5a61401b22e72b10833cdfe122b2fa34e`.

## Scope

This covers shutdown with an unavailable Redis process and the unchanged full
worker. It does not establish TCP blackhole behavior, long-outage recovery and
claim re-election, in-flight native execution failover, all lease/acknowledgment
boundaries, Redis TLS or other supported platforms. Those remain part of the
full replacement goal. The worker remains Node.
