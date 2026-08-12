# Application live transport

Cantrip uses one small JSON WebSocket to notify an app about committed server
state. HTTP remains the source of truth. The live channel does not proxy REST
requests and does not carry terminal, Remote Surface, Cantrip Code, or worker
data.

The architecture decision is recorded in
[ADR 0005](adr/0005-application-live-control-websocket.md).

## Ownership

| Boundary                                                          | Transport                                    |
| ----------------------------------------------------------------- | -------------------------------------------- |
| Bootstrap and state snapshots                                     | HTTP                                         |
| CRUD, chat input, approvals, run controls, files, and Git actions | HTTP                                         |
| Committed state notifications and cache synchronization           | Application live WebSocket                   |
| Terminal PTY streams                                              | Dedicated terminal WebSocket                 |
| Browser and Remote Desktop frames/input                           | Dedicated Remote Surface WebSocket or WebRTC |
| Tunnel control snapshots and mutations                            | HTTP                                         |
| Tunnel state invalidation                                         | Application live WebSocket                   |
| Raw TCP, project-share, and Cantrip Code bytes                    | Unified binary tunnel data plane             |
| Worker commands and events                                        | Authenticated outbound worker WebSocket      |

## Version 1 contract

The client begins with `initialize`, protocol version `1`, a bounded client
identity, and an optional `{ serverEpoch, cursor }` resume point. It then adds
or removes unique current-user, project, chat, and workflow-run subscriptions.
The server responds with its process epoch, connection ID, current cursor,
heartbeat interval, and replay decision.

Every event contains exactly one authorized scope, typed resource and action,
optional entity ID and revision, committed timestamp, and optional bounded JSON
payload. Resource types cover settings, workers, projects, worktrees, project
tabs and tab layouts, chat state, interactions, workflows, customization, and
tunnels. Tunnel stream bytes and flow control remain on bounded binary data
planes. Raw TCP, project-share, and Cantrip Code traffic use the unified tunnel
stream protocol; feature adapters retain only their bounded protocol-specific
translation.

The server may replay retained events after a same-epoch cursor and ends replay
with `caught-up`. It emits `resync-required` when the server restarted, the
cursor fell outside the bounded ring, the connection overflowed, or scope
continuity cannot be proven. The app then refetches authoritative HTTP
snapshots and acknowledges the resulting cursor and scopes.

Unknown fields and message types are rejected. Subscription and event payloads
are bounded. WebSocket ordering is reliable within one connection; the cursor
exists for reconnect/replay and recovery decisions rather than treating a
socket as durable storage.

## Rollout rule

Polling remains in place until both the server publisher and singleton app
client exist for a resource. Each resource migration must cover every mutation
source, retain a disconnected/resync snapshot path, and prove that state
converges after reconnect before its fixed polling interval is removed.

Project lists, workers, worktree metadata, tabs, terminals, explorers,
browsers, Code tabs, project views, and Remote Desktop metadata now use live
invalidations while the connection is healthy. During connection startup,
reconnect, or resynchronization, the app retains a bounded 10–15 second HTTP
fallback. Project tab layouts follow the same rule instead of refreshing every
second. Worktree Git status is also live: the worker publishes debounced
filesystem observations and a bounded reconciliation sweep, the server stores
the latest status snapshot, and the app applies complete Git-status payloads
directly. The former three-second, per-worktree client polling loop is disabled
while live; a connected worker uses a 15-second HTTP fallback only when the app
control socket is unavailable.

Active chats also use the live channel while it is healthy. Persisted messages
and normalized activity (including commentary, final answers, usage, and turn
summaries) carry their complete typed message payload so an already-loaded
transcript can update without another GET. Queue, goal, plan, interaction,
execution-status, and chat-list changes use coalesced scoped invalidations. The
server always commits these records before publishing.

The 750 ms chat and Codex-sync loops are disabled while live. Codex transcript
reconciliation is instead triggered at chat-scope recovery, a worker presence
transition, and a completed turn; cursor gaps and server restarts use the same
authoritative scope-recovery barrier. When live is unavailable, active chats
fall back to a 3 second snapshot interval and idle chats to 10 seconds. This
fallback preserves convergence without making the WebSocket a second durable
transcript.

Active workflow runs publish run, node, gate, usage, recovery, and worktree
lease changes after their repository operation completes. Worker progress
notifications reuse the persisted workflow-event sequence as the live event
revision, allowing duplicate and stale deliveries to be ignored. The app
coalesces workflow invalidations into a 100 ms window and refreshes the run
detail snapshot, rather than issuing one GET for every progress item. A live
cursor gap, workflow sequence gap, scope change, or server restart converges
through the authoritative run-detail snapshot. The durable workflow-event API
remains available for sequence diagnostics and replay inspection.

The 1.5–2 second active workflow polling remains only as a disconnected live
fallback. Workflow definition and revision writes invalidate the owner-visible
catalog, while trigger creation, edits, deliveries, delivery failures, and
schedule advancement invalidate project-scoped trigger queries. Known
repository exports invalidate an open repository snapshot; external filesystem
changes remain part of the worker-owned observation strategy.

Customization inventory changes also publish on the chat scope. MCP OAuth and
external-import operations return their initial HTTP result, then the server
observes only that bounded pending worker operation and publishes typed status
payloads. A healthy app socket applies those payloads directly, so the previous
one-second status GETs are disabled. A disconnected app retains the one-second
status GET as a recovery fallback, and reconnect recovery refetches the
authoritative status before observation resumes.

## Observability and verification

`GET /api/health` exposes the live hub's epoch, cursor, connection, delivery,
replay, resync, heartbeat, protocol-violation, and queue-pressure counters. The
server records the final counter snapshot during orderly shutdown. The app
query bridge also counts received events, directly applied payloads, coalesced
query keys, invalidation flushes, and invalidated queries for deterministic
tests and diagnostics.

The measured request reduction, real-browser trace, timer inventory, recovery
matrix, troubleshooting steps, and remaining deployment limits are recorded in
the [application live transport audit](LIVE_TRANSPORT_AUDIT.md).
