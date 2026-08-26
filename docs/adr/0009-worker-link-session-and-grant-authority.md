# ADR 0009: WorkerLink session and resource-grant authority

- Status: Accepted
- Date: 2026-08-26

## Context

[ADR 0008](0008-server-authorized-local-direct-data-plane.md) authorizes one
loopback-only attachment at a time. That design proves the important trust
boundary: the server authorizes an exact client, worker process, and resource,
while a worker address is only rendezvous metadata. It does not provide a
feature-neutral identity or authorization lifetime that Terminal, tunnels,
project shares, Code, Browser, Remote Desktop, and worker observations can
share across `LOCAL`, future `LAN` and `WAN`, and server `RELAY` routes.

Extending the direct-capability record independently for each route would make
the attachment type, rather than the client-worker relationship, the unit of
identity and revocation. It would also leave each feature responsible for
choosing between topology-specific transports.

## Decision

Cantrip introduces one transient `WorkerLinkSession` for the exact tuple:

```text
server identity and generation
+ owner and authenticated account session
+ client instance
+ worker ID and worker-process generation
```

The server is the only issuer of a WorkerLink session and its short-lived
resource grants. A grant names one exact resource and optional attachment,
limits channel count, QoS lanes, operations, lease, and absolute lifetime, and
has an independently revocable generation. The worker receives the grant
binding and a bearer-token hash before the client receives the corresponding
bearer grant. A channel open must present that grant and a unique open nonce.
The worker fails closed for missing, expired, revoked, replayed, cross-session,
cross-account, or wrong-generation authority.

WorkerLink sessions and grants are transient coordination state. They are not
an alternative store for projects, settings, conversations, tunnel records,
Code sessions, or any other durable resource. Those records remain in their
existing server-owned repositories. Account logout, resource release or
deletion, worker disconnect or process replacement, lease expiry, and orderly
server or worker shutdown revoke the corresponding transient authority.

The protocol names `local`, `lan`, `wan`, and `relay` now, with fixed priority
`LOCAL -> LAN -> WAN -> RELAY`. Tranche One enables only `local` and `relay`.
Naming the later routes is a compatibility seam, not permission to gather
candidates or negotiate peer connections in Tranche One.

Logical reliable channels use a common bounded envelope with route generation,
grant, channel, connection, QoS lane, sequence, open/accept/reject, data,
credit, half-close, close, and error operations. The existing generic tunnel
frame remains valid and may be encapsulated as a WorkerLink stream payload.
Endpoint encryption and protected tunnel records therefore remain unchanged.

ADR 0008's one-use loopback capability remains the `LOCAL` carrier proof during
the compatibility migration. The WorkerLink grant authorizes the logical
resource; the direct capability proves that the exact authorized worker process
is reachable over loopback. The server `RELAY` carrier uses the same logical
session and grant contract over its authenticated client and worker channels.
Feature code requests a resource stream and QoS lane but does not choose either
carrier.

WorkerLink coordination uses the existing worker bridge and replicated-server
coordination abstractions. This ADR does not select Redis, server-to-server
sockets, or another coordination backend and does not require connection
affinity as part of the feature protocol.

## Consequences

- Multiple feature channels can share one exact client-worker session without
  receiving general access to the worker.
- Authorization and topology selection move beneath feature components while
  durable resource ownership remains unchanged.
- Route replacement increments `routeGeneration`; old-generation frames are
  rejected instead of entering replacement channels.
- Per-lane queues and credit windows can isolate interactive traffic from
  stream and future bulk traffic.
- Tranche One can wrap the proven loopback broker and server relays before
  adding LAN/WAN reachability.
- A future peer carrier can use the same session, grants, frames, adapters, and
  feature-facing API without renaming routes or redesigning authorization.

## Rejected alternatives

- **One generalized reusable worker credential:** grants more authority than a
  feature needs and makes independent resource revocation unreliable.
- **One WorkerLink session per feature:** preserves the duplicated discovery,
  reconnect, route-selection, and lifetime systems this design removes.
- **Persist WorkerLink sessions as durable application state:** confuses a
  short-lived network lease with authoritative product records and complicates
  restart and replica fencing.
- **Replace the existing tunnel frame immediately:** creates avoidable risk to
  endpoint encryption, backpressure, half-close, and Code/WebDAV compatibility.
- **Enable LAN/WAN while introducing the abstraction:** makes it difficult to
  prove that behavior changes come from the abstraction rather than new network
  reachability.
