# ADR 0005: Application live control WebSocket

- Status: Accepted
- Date: 2026-08-09

> Amendment: App Live remains the durable-state invalidation and bounded
> client-control channel. Supported Terminal, Remote Surface, Code, and tunnel
> bytes now use WorkerLink instead of feature-specific WebSockets. Cross-server
> App Live publication is implemented through the relay coordinator and each
> receiving server's owner-local replay hub.

## Implementation status

Implemented on 2026-08-09 for project resources, worktree observations, active
chat state, and customization operations. The
[application live transport audit](../LIVE_TRANSPORT_AUDIT.md) records the
measured request reduction, browser trace, recovery evidence, remaining timers,
operational counters, and deployment limits.

Extended on 2026-08-21 with capability-negotiated, expiring notice, focus, and
show-interaction requests for the worker-owned managed Cantrip MCP. These
client controls are acknowledged but deliberately excluded from the event
cursor and replay ring.

## Context

Cantrip's app loads authoritative server state through HTTP, but currently
keeps many project, chat, and worktree views current with fixed
polling intervals. One selected idle project can issue several requests per
second, active chats add multiple 750 ms loops, and worktree status scales as
one request per checkout. The local loopback responses are usually fast, but
the request count creates avoidable database, logging, hosted-server, mobile,
and multi-client cost.

Cantrip already uses dedicated WebSockets for worker commands, terminals,
Cantrip Code, and Remote Surface data. Those transports have specialized
payload, authorization, and backpressure behavior. They are not a general app
state stream and must not be overloaded with unrelated control traffic.

Server-Sent Events could deliver one-way invalidations, but would create a
second live-transport lifecycle beside the existing WebSocket stack. Dynamic
scope subscriptions, connection negotiation, heartbeat, replay, and future
small bidirectional controls would require HTTP side channels or repeated SSE
reconnection.

## Decision

Cantrip will add one versioned JSON application control WebSocket per active
server profile. It is a notification and synchronization channel plus a narrow
ephemeral client-control relay, not a replacement RPC transport.

HTTP remains authoritative for bootstrap, initial and recovery snapshots,
mutations, idempotent controls, file/Git operations, and other bounded
request/response APIs. A live event is published only after its underlying
state commits. Clients may apply a complete validated payload directly or use
the event to coalesce an HTTP query invalidation.

The live protocol has current-user, project, and chat scopes.
Clients initialize once, subscribe and unsubscribe as UI scope changes, and
send bounded heartbeat and resynchronization acknowledgements. Server messages
identify the server-process epoch, connection, monotonically increasing event
cursor, resource, action, scope, optional entity revision, and bounded JSON
payload.

The single-process server retains a bounded in-memory event ring. A transient
reconnect within the same epoch may replay events after the client's cursor.
An epoch change, expired cursor, unsafe coalescing, or queue overflow requires
an authoritative resnapshot. Live notifications are therefore hints over
durable state and never the only copy of accepted data.

Reliable control messages use a bounded outbound queue. Redundant
invalidations may be coalesced by scope/resource/entity. A client that cannot
keep up receives `resync-required` or a retryable close instead of causing
unbounded memory growth.

During initialization, a client declares the exact notice, project-focus,
surface-focus, and show-interaction controls it supports. An authorized server
operation may send one correlated request to a same-owner client active in the
bound project or chat. The request expires within ten seconds and returns an
explicit acknowledgement or unavailable result. It is not durable, does not
receive a cursor, and is never replayed after reconnect. Durable mutations must
commit through their authoritative operation before an optional focus request.

Terminal, Remote Surface, Cantrip Code, and worker WebSockets remain separate.
Their binary or high-volume data must not delay app state, approvals, or
recovery notifications.

Every connection validates the configured app Origin and current Cantrip
identity. Every subscription validates ownership of its requested scope. The
current product is local single-user, but the protocol must not assume that a
future authenticated user can subscribe to another owner's project or chat.

## Consequences

- Healthy clients can stop fixed high-frequency REST polling and fetch only
  after a real change or resynchronization boundary.
- Reconnect correctness remains grounded in HTTP snapshots and durable server
  state instead of pretending an in-memory event ring is durable.
- The app and server gain a connection/replay state machine that needs bounded
  queues, security tests, observability, and deterministic client tests.
- Multi-instance servers will eventually require a shared publication/replay
  mechanism or mandatory cross-instance resynchronization. The initial PGlite
  and single-server deployment uses one in-process hub.
- SSE is not maintained as a parallel production transport.
