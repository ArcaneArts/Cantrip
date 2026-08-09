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
| Cantrip Code proxy                                                | Dedicated HTTP/WebSocket tunnel              |
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
tabs, chat state, interactions, workflows, and customization.

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
fallback. The per-worktree external Git-status observer remains a separate
temporary polling path until its worker-owned reconciliation migration.

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
fallback. Workflow definitions, automation triggers, repository inventory, and
customization refresh state are migrated in the following focused rollout
lane.
