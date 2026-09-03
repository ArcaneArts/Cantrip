# ADR 0007: Unified tunnel control plane and attachable data plane

- Status: Accepted
- Date: 2026-08-11

> Amendment: the unified tunnel identities, endpoint encryption, lifecycle,
> and adapters remain accepted. ADRs 0009 and 0010 place the tunnel framing
> inside WorkerLink: LOCAL, LAN, and WAN may bypass the byte relay after server
> authorization, while RELAY is server-routed. Worker-to-worker forwarding
> remains unexposed and would remain server-routed if implemented. Historical
> server-always-routes language below is superseded.

## Context

Cantrip already relays several network-shaped resources through the server.
Cantrip Code proxies HTTP and WebSocket traffic, project sharing proxies WebDAV,
and a desktop browser may eventually expose a worker-local development server on
the user's own loopback interface. Each feature currently owns its lifecycle and
transport. Continuing with feature-specific tunnels would duplicate ownership,
status, authentication, metrics, and settings behavior. It would also make a
future worker-to-worker relay require another parallel subsystem.

Project association is not an execution placement. A project can have replicas
on several workers, so selecting a project cannot imply either tunnel endpoint.
The server must authorize both endpoints explicitly under the authenticated
owner and remain the only router between apps and workers.

## Decision

Cantrip has one server-owned tunnel control plane. A **tunnel** is a durable
logical route with an explicit source endpoint, explicit destination endpoint,
protocol hint, desired state, observed status, management policy, optional
organizational project association, and aggregate counters. A tunnel may have
zero or more short-lived **attachments**. An attachment represents one concrete
consumer, such as a Tauri desktop loopback listener or a remote client using
the generic encrypted server relay.

The initial endpoint vocabulary is deliberately narrow:

- `desktop-loopback` sources are listeners created by a trusted desktop app;
- `worker-tcp` destinations are loopback TCP ports on an explicitly named
  worker;
- `worker-adapter` destinations are feature-owned worker endpoints; and
- `worker-listener` is reserved as a source contract for a later
  worker-to-worker relay, but is not exposed by user creation APIs in this phase.

User-created tunnels are `user-managed`. Their editable configuration is a
desktop loopback source and an explicit worker TCP destination. Managed tunnels
are registered idempotently by their owning browser, Code, project-share, or
system resource. They expose server-computed capabilities instead
of UI guesses: a managed tunnel may be inspected and opened through its owner,
but generic edit and delete operations are rejected. Removing the owning
resource removes its managed tunnel.

`project_id` is optional metadata used to group tunnels in project settings.
Creating a tunnel from project settings may preselect that project, but changing
or clearing the field never changes routing. Endpoint worker IDs are validated
separately and always remain authoritative. Deleting a project clears this
organizational association rather than deleting an otherwise valid tunnel.

HTTP remains authoritative for tunnel snapshots and mutations. The application
live WebSocket publishes a `tunnel` invalidation only after a committed control
plane change. Tunnel bytes never travel through that JSON channel. A dedicated,
bounded binary data plane will carry stream open/data/half-close/close messages,
with per-stream flow control, attachment credentials, connection limits, idle
timeouts, and aggregate metrics.

The version 1 binary envelope has a distinct magic value and a bounded JSON
header followed by an optional binary payload. Every frame repeats the logical
tunnel, attachment, source endpoint, destination endpoint, connection, and
monotonic per-sender sequence identities. Control frames cover open, destination
connect, accepted/rejected, credit, half-close, close, and error. Only data
frames carry payload bytes, capped at 64 KiB. Each direction begins with an
explicit byte-credit window; exceeding credit, sequence, connection, bandwidth,
idle, lifetime, or transport-buffer limits closes the affected stream instead
of accumulating unbounded memory. The broker does not inspect or log payload
content.

Endpoint adapters implement the same send/subscribe/disconnect interface. The
initial worker destination adapter connects only to protocol-validated worker
loopback TCP targets. The broker is placement-agnostic: desktop, server-adapter,
and worker placements are metadata on endpoints rather than branches in stream
routing.

All remote routing follows the established server relay trust boundary:

```text
desktop app or worker A -> authenticated server relay -> worker B
```

Workers do not discover or dial one another, and clients never receive worker
origins or worker credentials. A later worker-A-to-worker-B implementation will
activate the reserved worker-listener endpoint, authorize both workers against
the tunnel owner, and reuse the same control records, attachments, stream
protocol, and server relay. This ADR does not enable that feature.

A same-machine Tauri client may use the separately authorized local-direct
attachment defined by [ADR 0008](0008-server-authorized-local-direct-data-plane.md).
That path preserves server authorization and capability revocation; it does not
expose a general worker address or enable worker-to-worker dialing.

## Consequences

- Code and project-share transports are now managed tunnel registrations backed
  by the generic stream broker, identities, framing, credit flow control,
  cleanup, and counters without changing their public URLs. Their bounded
  HTTP/WebSocket and WebDAV adapters remain protocol-specific edges rather than
  parallel brokers.
- Browser-created tunnels and user-created tunnels share one lifecycle and
  appear in the same global and project settings inventories.
- Desktop-local listeners are attachments, not server ports. Web/mobile clients
  can inspect tunnel state but cannot bind a local port.
- A destination worker becoming unavailable changes observed status without
  erasing desired state; reconnect may reconcile the tunnel.
- Attachment secrets are stored only as hashes, are scoped to one tunnel and
  client, expire, and can be revoked independently.
- Tunnel counters and errors become inspectable without making the data plane a
  durable byte store.
- Managed Code and project-share traffic uses protected generic attachments;
  the relay records only bounded routing, connection, and byte counters.
- Aggregate health and Prometheus diagnostics include directional bytes,
  connection lifecycle counts, rejections, and bounded termination reasons;
  they never use tenant, destination, payload, or credential labels.
- Supporting a new protocol requires a bounded adapter or raw-TCP compatibility
  decision; the protocol hint alone never grants arbitrary server network
  access.

## Rejected alternatives

- **One tunnel implementation per feature:** duplicates security and lifecycle
  logic and cannot provide coherent settings or future cross-worker routing.
- **Infer workers from the selected project:** breaks as soon as a project has
  more than one replica and confuses organization with placement.
- **Unscoped desktop-to-worker or worker-to-worker sockets:** exposing service
  ports or choosing routes from network topology bypasses server authorization
  and fails behind common NAT/firewall layouts. ADR 0008 permits only a
  server-bound, verified loopback capability with relay fallback.
- **Send tunnel bytes through the application live WebSocket:** couples
  high-volume binary backpressure to state invalidation and risks starving the
  control plane.
