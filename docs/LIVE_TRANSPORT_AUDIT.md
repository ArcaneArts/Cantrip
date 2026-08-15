# Application live transport audit

- Date: 2026-08-09
- Scope: local single-server deployment
- Result: healthy app-control traffic is event-driven; HTTP remains the
  authoritative snapshot and mutation transport

This audit records the request baseline, browser trace, deterministic recovery
tests, timer inventory, and operating limits for the application live control
WebSocket described by [ADR 0005](adr/0005-application-live-control-websocket.md).

## Measurement method

The baseline is the supplied server request log for one selected idle project.
The migrated result was measured in the real app with a disposable local
server, one project, and one worker. Initial HTTP snapshots were allowed to
settle before the unchanged observation window began. Server request logs were
used as the request trace; `/api/health` supplied the live-channel counters.
The disposable fixture and processes were removed after the trace.

The browser pass also found one remaining one-second tab-layout refresh. Tab
layouts were added to the typed project resources and that timer now becomes a
ten-second recovery fallback only while the app-control socket is unavailable.

## Before and after

The baseline contained 27 incoming HTTP requests in 4,038 ms, or
6.686 requests per second.

| Baseline request family | Requests |
| ----------------------- | -------: |
| Project views           |        5 |
| Browsers                |        5 |
| Chats                   |        4 |
| Terminals               |        4 |
| Explorers               |        4 |
| Worktrees               |        2 |
| Code tabs               |        2 |
| Primary worktree status |        1 |

After the initial snapshots settled, a five-second unchanged browser window
produced zero project-resource HTTP requests: 0 requests per second and a 100%
reduction from the measured baseline. A separate 31-second unchanged window
also produced no server request lines. Across an 84-second health sample, the
server answered three app-control heartbeats at the default 30-second interval
without generating HTTP requests.

As a mutation sample, creating a Terminal completed its POST in 9.825 ms and
the tab was visible in the app within 766 ms. That upper bound includes a fixed
500 ms observation delay in the trace harness. Mutations can cause a bounded
snapshot refresh for the initiating client and subscribed peers; they do not
restart a fixed polling loop.

## Deterministic transport evidence

| Scenario                | Expected and observed result                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same-epoch resume       | Three events retained; two matching the restored scope replayed in order, followed by `caught-up`.                                                             |
| Expired replay cursor   | A two-event ring after three publications required one resync; acknowledgment caught up at the authoritative cursor with zero replayed events.                 |
| Duplicate invalidations | Two worker events produced one microtask flush, two unique query invalidations, and two coalesced duplicate query keys.                                        |
| Complete payload        | Persisted chat messages and worktree Git status applied directly without a follow-up GET.                                                                      |
| Slow consumer           | With a 512-byte limit and 500 buffered bytes, the connection closed with retryable code 1013; queue pressure and slow-consumer counters each incremented once. |
| Subscription isolation  | Two simultaneous clients subscribed to different projects received exactly their own event.                                                                    |
| Malformed input         | Invalid JSON, versions, binary frames, and oversized payloads fail closed and increment protocol-violation metrics.                                            |
| Missing heartbeat       | A connection silent for three heartbeat periods is closed and counted as a timeout.                                                                            |

These behaviors are covered in the protocol, server live-hub/API, and app live
client/query-bridge test suites.

## Polling and timer inventory

The following timers remain intentionally:

- Project resources do not refetch while live. Disconnected recovery snapshots
  run every 10–15 seconds; worktree status runs every 15 seconds only when its
  worker is online.
- Chats do not refetch while live. Disconnected active chats recover every
  three seconds and idle chats every ten seconds.
- Active workflow lists and details do not refetch while live. Disconnected
  recovery uses two-second and 1.5-second intervals, respectively.
- Pending customization imports and MCP OAuth operations apply live payloads;
  their one-second status check is only a disconnected recovery path.
- The settings UI checks global ChatGPT and Grok provider-account status every
  ten seconds while that UI is mounted. The encrypted credential, lifecycle,
  quota, and catalog state are server-owned; the timer is a bounded recovery
  path for provider/OAuth state that is not yet an application-live resource.
  An active device-login runner checks more frequently until that operation
  completes.
- The singleton app-control client sends a heartbeat at the negotiated
  interval, currently 30 seconds, and reconnects with bounded exponential
  backoff and jitter.
- Remote Desktop sends two-second stream-feedback samples on its dedicated data
  plane. This is media flow control, not application-state polling.
- Worker worktree observation uses a 500 ms filesystem debounce plus a bounded
  30-second reconciliation sweep. It publishes only changed snapshots.
- Server-owned schedulers, expiry checks, and bounded pending-operation
  observers continue independently of browser requests. UI notice timers only
  control presentation.

## Operations

`GET /api/health` includes a `live` object with the server epoch, current
cursor, retained replay-event count, current/accepted/disconnected connection
counts, publications and deliveries, resume/replay/resync counts, heartbeat
pongs and timeouts, protocol violations, queue pressure, and slow-consumer
closures. The server logs the same snapshot during orderly shutdown.

For a client that appears stale:

1. Confirm `live.connectionCount` is nonzero and the browser selected the same
   server profile as its HTTP client.
2. Check origin and current-user authorization failures, protocol violations,
   heartbeat timeouts, and slow-consumer closures in server logs.
3. A rising `resyncRequiredCount` after a deploy or server restart is expected;
   verify the app performs recovery HTTP snapshots and reconnects.
4. Repeated queue pressure indicates a slow or suspended client. Let it
   reconnect and resnapshot instead of increasing the queue without a measured
   reason.
5. If live transport is unavailable, confirm the documented recovery polling
   is active before diagnosing stale durable state.

## Remaining limits

- Replay and publication are in memory in one server process. A server epoch
  change deliberately forces an authoritative resnapshot.
- Multi-instance service will require shared pub/sub plus replay, or mandatory
  cross-instance resynchronization.
- The shipped authentication boundary remains local single-user; hosted use
  still requires authenticated identities, TLS/WSS, and the documented origin
  and ownership hardening.
- Worker filesystem observation is bounded to 128 watched targets; the
  reconciliation sweep is the safety net for dropped or unsupported events.
- Recovery polling is retained by design. It is disabled while healthy rather
  than deleted, so the WebSocket never becomes the sole durable copy of state.
