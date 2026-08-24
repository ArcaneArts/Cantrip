# Application live transport

Cantrip uses one small JSON WebSocket to notify an app about committed server
state and to deliver a bounded family of ephemeral client-control requests.
HTTP remains the source of truth. The live channel does not proxy REST requests
or carry terminal, Remote Surface, Cantrip Code, or general worker data.

The architecture decision is recorded in
[ADR 0005](adr/0005-application-live-control-websocket.md).

## Ownership

| Boundary                                                              | Transport                                    |
| --------------------------------------------------------------------- | -------------------------------------------- |
| Bootstrap and state snapshots                                         | HTTP                                         |
| CRUD, chat input, approvals, run controls, files, and Git actions     | HTTP                                         |
| Committed state notifications and cache synchronization               | Application live WebSocket                   |
| Ephemeral notice/focus/show-interaction requests and acknowledgements | Application live WebSocket                   |
| Terminal PTY streams                                                  | Dedicated terminal WebSocket                 |
| Browser and Remote Desktop frames/input                               | Dedicated Remote Surface WebSocket or WebRTC |
| Tunnel control snapshots and mutations                                | HTTP                                         |
| Tunnel state invalidation                                             | Application live WebSocket                   |
| Raw TCP, project-share, and Cantrip Code bytes                        | Unified binary tunnel data plane             |
| Worker commands and events                                            | Authenticated outbound worker WebSocket      |

## Server-authorized local direct broker

Desktop clients may bypass the server data relay only after the server has
authorized a specific attachment. Each worker binds an ephemeral broker to a
random `127.0.0.1` port and reports its Ed25519 public-key fingerprint in the
authenticated heartbeat. The advertised port is rendezvous metadata, not
proof that the desktop app and worker are on the same machine.

For a locality probe, the server resolves the owner and worker, mints a
short-lived one-use capability, and installs its complete binding on the worker
over the authenticated command channel before returning it to the app. The
binding includes the account session, worker, resource, attachment, allowed
channels, capability expiry, and lease expiry. Tauri connects only to loopback,
consumes the capability once, challenges the broker, and verifies the signed
identity against the server advertisement. A failed probe is ordinary relay
fallback; no hostname or IP comparison grants trust.

Prepared grants and active direct sessions are revoked on expiry, explicit
release, account-session revocation, worker command-channel loss, or process
shutdown. The browser-facing layer receives no reusable worker credential.
The transient one-use attachment secret is handed immediately to native Tauri
code, cleared after invocation, and never written to browser storage or logs.
PTY, project-share, Code, and generic tunnel transports reuse this authorization
and locality-proof foundation. Tauri owns the loopback forwarder; browser and
Capacitor clients retain the server route. Remote Surfaces do not use this
broker: their server-signaled WebRTC transport can negotiate directly from any
supported client and falls back to the authenticated WebSocket relay.

## Version 1 contract

The client begins with `initialize`, protocol version `1`, a bounded client
identity, an exact list of supported client-control capabilities, and an
optional `{ serverEpoch, cursor }` resume point. Omitted capabilities default
to none. It then adds or removes unique current-user, project, chat, and
workflow-run subscriptions. The server responds with its process epoch,
connection ID, current cursor, heartbeat interval, and replay decision.

Every event contains exactly one authorized scope, typed resource and action,
optional entity ID and revision, committed timestamp, and optional bounded JSON
payload. Resource types cover settings, workers, projects, worktrees, project
tabs and tab layouts, chat state, interactions, workflows, customization, and
tunnels. Current-user account-resource-usage invalidations cover successful
storage reconciliation and meaningful durable bandwidth flushes; the client
invalidates current and history snapshots and uses a one-minute fallback only
while live is unavailable. Usage-observer traffic suppresses recursive
invalidation. Tunnel stream bytes and flow control remain on bounded binary data
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

## Ephemeral client controls

The managed Cantrip MCP can request four app behaviors through the worker →
server → client route: a bounded notice, project focus, authorized surface
focus, or display of an exact pending interaction. Each request is separately
typed, correlated, and expires no more than ten seconds after issue. The app
acknowledges `applied`, `declined`, `unsupported`, or `expired`; the server may
return `unavailable` when no matching client is connected or the selected
client disconnects.

The server derives the owner and bound project from the revalidated MCP binding.
It selects only initialized connections for that owner whose declared
capabilities contain the request kind and whose active scopes include the
project. `show-interaction` prefers a connection also subscribed to the bound
chat. The app independently checks its advertised capability, request expiry,
and local handler before applying anything. Focus requests do not create,
delete, or mutate durable surfaces, and showing an interaction never answers it.

Client-control frames do not receive a live cursor, enter the replay ring, or
become durable events. Reconnect therefore never repeats a stale notice or
focus action. The app keeps a bounded correlation cache and returns the prior
acknowledgement for duplicates, preventing duplicate application within one
client lifetime. Pending server requests settle unavailable on disconnect and
expired on deadline. This path is deliberately separate from committed-state
notifications and HTTP snapshots.

Capability negotiation was added to the strict version 1 initialize object.
Older clients that omit the field safely advertise no controls. Cantrip ships
the app and server as one compatibility unit; a rollout must not deploy a new
capability-sending app against a server revision whose strict version 1 parser
predates that field. A future independently deployable client protocol change
requires a version bump or an explicit server feature-negotiation mechanism.

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

External Codex chat imports publish project-scoped `chat-import-job`
invalidations after every durable transition. The app refreshes the job list,
already-imported discovery metadata, chat list, and tab layout from that event;
the previous two-second job refresh runs only while the live channel is not
healthy. HTTP job snapshots remain authoritative after reconnect or resync.

## Observability and verification

`GET /api/health` exposes the live hub's epoch, cursor, connection, delivery,
replay, resync, heartbeat, protocol-violation, and queue-pressure counters. The
server records the final counter snapshot during orderly shutdown. The app
query bridge also counts received events, directly applied payloads, coalesced
query keys, invalidation flushes, and invalidated queries for deterministic
tests and diagnostics.

Tunnel route, stream, traffic, rejection, and termination counters are exposed
beside these live diagnostics, but tunnel bytes never enter the application
live channel. Native direct forwarders report monotonic counters through a
bounded authenticated HTTP endpoint; the server exports direct-versus-relayed
aggregate series without tenant-specific labels. Operational details are in
[the tunnels guide](TUNNELS.md).

The measured request reduction, real-browser trace, timer inventory, recovery
matrix, troubleshooting steps, and remaining deployment limits are recorded in
the [application live transport audit](LIVE_TRANSPORT_AUDIT.md).
