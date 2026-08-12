# Tunnels

Cantrip tunnels let a local desktop application reach a TCP service owned by a
worker without exposing the worker to inbound network connections. The server
owns authorization and routing; workers and desktop clients keep their
listeners on loopback.

## Using a saved tunnel

Open **Global Settings → Tunnels** to see every tunnel owned by the current
account. **Project Settings → Tunnels** first shows tunnels associated with the
open project, then a separate **All Tunnels** inventory. A project association
is only a label for organization: it never selects a worker or changes routing.

To create a tunnel:

1. Choose a name, an explicit worker, a worker-local port, and a protocol hint.
2. Optionally associate a project. Global Settings defaults this to
   **Unspecified**; Project Settings defaults it to the current project.
3. Save the definition, then choose **Start** in the Tauri desktop app.
4. Use the displayed `127.0.0.1` endpoint. HTTP and HTTPS tunnels also offer
   **Open** and **Copy URL** actions.

Automatic port selection asks the operating system for an unused loopback port.
A preferred port reports a collision instead of silently changing the endpoint.
Stopping a desktop attachment releases its listener but keeps a user-created
tunnel definition available for restart. Deleting the definition is a separate
action.

Web and mobile builds can inspect and manage tunnel definitions, but cannot bind
a port on the user's device. HTTPS is transported as unchanged TCP bytes; the
target service's certificate must still be trusted for the local hostname used
by the client.

## Managed tunnels

The same inventory includes feature-owned tunnels:

| Origin          | Purpose                                            | Lifecycle owner       |
| --------------- | -------------------------------------------------- | --------------------- |
| Browser         | Open a worker-local site in the system browser     | Browser tab/service   |
| Project share   | Carry Finder/Explorer WebDAV access                | Project share         |
| Cantrip Code    | Carry the isolated Code HTTP and WebSocket surface | Code tab/session      |
| Future features | Reuse the control plane and adapter interfaces     | Owning feature record |

Managed tunnels show only actions allowed by the server. They cannot be
retargeted or deleted independently of their owner. **Open owner** returns to
the owning surface when it still exists. An eligible Browser tunnel can be
copied into a user-managed definition with **Save as custom tunnel**.

In a Browser tab, **Open locally** creates or reuses a managed desktop tunnel,
preserves the page path and query, and opens its loopback URL in the system
browser. The tunnel carries ordinary HTTP streaming and WebSocket/HMR traffic.
Use ordinary **Open externally** only for addresses that are already reachable
from the desktop without worker-local forwarding.

## Architecture

```mermaid
flowchart LR
    LOCAL["Desktop loopback listener"]
    HTTP["Server HTTP adapters<br/>Code / WebDAV"]
    CONTROL["Server tunnel control plane<br/>ownership, definitions, leases"]
    BROKER["Bounded stream broker<br/>identity, credit, limits, counters"]
    WORKER["Authenticated outbound worker channel"]
    TCP["Worker loopback TCP service"]
    ADAPTER["Worker adapter<br/>Code / WebDAV"]

    LOCAL --> BROKER
    HTTP --> BROKER
    CONTROL --- BROKER
    BROKER <--> WORKER
    WORKER --> TCP
    WORKER --> ADAPTER
```

HTTP is authoritative for definitions, mutations, attachment authorization,
and recovery snapshots. The application live WebSocket carries only committed
`tunnel` invalidations. Stream bytes use the dedicated versioned binary data
plane on authenticated desktop/server/worker transports.

A logical tunnel is durable configuration and may have zero or more runtime
attachments. Every route names its source and destination endpoints explicitly;
the optional project ID never supplies placement. Each stream repeats its
tunnel, attachment, endpoint, connection, and sequence identities. Credit-based
flow control, bounded payloads and transport queues, per-tunnel/global
connection limits, bandwidth limits, idle expiry, maximum lifetime, and
disconnect/revocation cleanup fail closed instead of buffering indefinitely.

The Code and WebDAV HTTP formats remain bounded endpoint adapters. They no
longer own private framing or connection brokers. Shared managed-relay telemetry
batches their counters and flushes pending bytes and connection changes before
an attachment is removed.

Attachment secrets are short-lived, owner-scoped, stored only as hashes by the
server, and held in memory by the desktop. They are not placed in opened URLs,
process arguments, metrics labels, or payload logs. User destinations are
restricted to validated worker-loopback TCP targets.

## Status and observability

Tunnel rows distinguish desired state from observed `starting`, `active`,
`offline`, `degraded`, `stopping`, `stopped`, or `failed` state. An offline
worker or detached desktop does not erase a saved definition; a later start can
authorize a fresh short-lived attachment. Stale and revoked attachment secrets
are rejected.

`GET /api/health` includes aggregate route, connection, byte, open, close,
rejection, and broker-termination counters. Authenticated `GET /metrics`
exports:

- `cantrip_tunnel_connections` and `cantrip_tunnel_routes`;
- `cantrip_tunnel_connections_opened_total`,
  `cantrip_tunnel_connections_closed_total`, and
  `cantrip_tunnel_connections_rejected_total`;
- `cantrip_tunnel_bytes_total`, including directional series; and
- `cantrip_tunnel_terminations_total{reason=...}` for bounded broker failures
  and lifecycle termination.

Metrics contain no user, project, destination, credential, cookie, or payload
labels. See [the hosted deployment guide](HOSTED_DEPLOYMENT.md) for protecting
the endpoint and configuring relay quotas.

## Future worker-to-worker extension

Worker A → server → Worker B forwarding is intentionally not exposed yet. The
control-plane endpoint vocabulary reserves a `worker-listener` source, and the
broker already routes between arbitrary endpoint implementations rather than
assuming a desktop source or same-worker placement. Shipping the feature later
requires a worker-listener adapter plus authorization and UI policy for both
explicit workers. It does not require replacing tunnel records, logical IDs,
attachments, the stream envelope, broker lifecycle, settings inventory, or the
server-routed trust boundary.

Cantrip will not silently synchronize repositories, processes, or dirty files as
part of a tunnel. Those belong to the separate multi-worker project model.

## Troubleshooting

- **Start is unavailable:** local attachment requires Tauri, an online selected
  worker, and the server-provided `canAttach` capability.
- **Preferred port is busy:** select automatic allocation or stop the local
  process already bound to that loopback port.
- **Tunnel is offline:** reconnect the explicit destination worker, then start
  or refresh the attachment. Do not change the project association to route it.
- **Local HTTPS warning:** trust or replace the target service certificate; the
  tunnel does not terminate TLS.
- **Managed actions are locked:** open or stop the owning Browser, Code, or
  project-share feature instead of mutating its route independently.

The architectural decision and rejected alternatives are recorded in
[ADR 0007](adr/0007-unified-tunnel-framework.md).
