# cantrip-transport

Existing mechanisms extracted from Cantrip's Rust server for transport adapters
in either runtime. This crate depends on wire/framing libraries and Tokio, with
no server, database, Redis, routing, or process-startup dependency.

- `output`: byte reservations retained through queueing and actual writer flush.
  Dropping completed or abandoned writes releases reservations. `bounded` retains
  the existing `bufferedAmount > limit` rule: the frame crossing the limit is
  admitted, subsequent frames wait for reservations to drop.
- `peer`: outgoing text and the three existing frame carriers, ordered sends,
  first-close notification, and close deadline. `Continuity` contains supplied
  metadata; constructors do not authenticate it. The caller owns congestion
  decisions before encoding, including surface-frame dropping/closure policy.
- `frames`, `offline`, `notifications`: scoped subscriptions with insertion and
  live-mutation ordering, duplicate callback identity, and RAII unsubscribe.
  Notification prefixes run synchronously through their first pending await;
  pending listeners continue independently. Listener rejections retain the
  original per-listener behavior. Notification groups are opaque handles.
- `command_deadline`: separate preparation/execution budgets, queue/suspension
  pauses, monotonic phase sequences, and stale-update rejection.
- `correlation`: ordered event/response admission and single-shot completion.
  The winning completion runs synchronous adapter cleanup before resolving the
  result receiver and signaling the delivery actor to finish. The caller still
  owns request IDs, correlation-map lookup, event handlers, timers, and peer fences.
- `lifecycle::owned`: eagerly poll an operation's synchronous prefix, then retain
  its continuation even when the caller drops the returned result future.

The original event and output channels retain their existing queue policies.
Byte limits apply where the production adapter previously applied them; this
extraction does not impose a new global message bound. Dropping a result future
does not revoke a dispatched command. The caller performs the existing explicit
completion, deadline cancellation, or shutdown path.

The production server consumes these implementations through compatibility
aliases in `workers`. Its `WorkerTransport`, `WorkerBridge`, command bus, Redis
coordination, enrollment/authorization, continuity fencing, resource lookup,
request-map authority, domain telemetry, and routing remain server adapters.
A future worker still needs its connection/reconnect loop, command executor,
WebRTC integration, and worker-specific shutdown policy.

Tokio-based notification delivery and owned operations require an active runtime.
No crate API initializes one. Callers stop admission and finish outstanding
requests before clearing subscriptions and retiring peers, as the server does.
