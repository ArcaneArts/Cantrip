# ADR 0008: Server-authorized local direct data plane

- Status: Accepted
- Date: 2026-08-12

> Amendment: this proof and authorization design is now the WorkerLink LOCAL
> carrier. Supported Terminal and native tunnel paths use the shared WorkerLink
> manager and bounded native bridge. Browser and Remote Desktop use LOCAL where
> eligible, renderer-owned LAN/WAN peer carriers, or RELAY. Historical
> feature-integration details below are superseded by ADRs 0009 and 0010.

## Context

The Cantrip Server must remain authoritative when an app and worker happen to
run on the same machine. Sending PTY, editor, WebDAV, and development-service
bytes through a remote server in that case adds avoidable latency and bandwidth
without adding authorization. Conversely, choosing a route from hostnames,
private addresses, or client claims would let an app bypass the server's owner,
session, worker, and resource checks.

## Decision

The server remains the sole control plane and may authorize a local direct data
path for one concrete attachment. The worker advertises an ephemeral
loopback-only broker and Ed25519 identity over its authenticated outbound
control channel. The server installs a random, one-use capability on that
worker and returns a binding scoped to the authenticated account session,
worker, resource, attachment, channel set, and bounded lease.

Tauri attempts only the advertised `127.0.0.1` broker. It challenges the broker
and verifies the signed identity before sending data. A successful proof means
the selected worker process is reachable on the app's machine; it does not
expand the capability. Failed, unavailable, unsupported, expired, or invalid
direct setup falls back to the existing authenticated server relay without
changing the durable resource.

Relay fallback credentials remain short-lived even for long-lived local
listeners. After a direct disconnect, a degraded Tauri forwarder obtains a
fresh attachment credential from the authoritative server and reconnects the
same loopback listener through the relay.

The generic native forwarder carries raw tunnels, PTYs, project WebDAV shares,
and Cantrip Code HTTP/WebSocket traffic. Destinations and adapter credentials
are installed worker-side and are not disclosed by the direct ticket. Browser
and Remote Desktop use their existing WebRTC path instead: signaling and
authorization remain server-routed, while ICE may choose a direct or TURN path.

Revocation follows the authoritative lifecycle. Releasing the attachment,
ending the account session, deleting or stopping the resource, losing the
worker control channel, lease expiry, or server/worker shutdown removes the
capability and closes active direct sessions. Direct mode is an optimization,
never a prerequisite for correctness.

## Client support

| Client        | Generic local direct broker             | Remote Surface WebRTC                 | Fallback     |
| ------------- | --------------------------------------- | ------------------------------------- | ------------ |
| Tauri desktop | Yes, when worker is on the same machine | Yes                                   | Server relay |
| Web browser   | No native loopback forwarder            | Yes, subject to browser/ICE policy    | Server relay |
| Capacitor     | Not currently                           | Yes, subject to WebRTC support/policy | Server relay |

The browser and mobile rows are deliberate product boundaries, not failed
locality probes. They continue to work through the server without configuration.

## Observability and privacy

The desktop diagnostics surface reports active local-direct versus relayed
native forwarders and cumulative connection/byte totals. Tauri periodically
submits monotonic counters for active direct capabilities; the server converts
them into idempotent deltas. Prometheus exports
`cantrip_data_plane_bytes_total` and
`cantrip_data_plane_connections_total` with only bounded `transport`,
`resource_kind`, direction, and event labels. Tenant, project, attachment,
destination, credential, and payload data never become metric labels.

## Consequences

- Same-machine bulk traffic avoids the server after explicit authorization.
- Hosted, browser, mobile, remote-worker, and failed-probe behavior stays on the
  tested relay path.
- The app cannot infer trust from network topology and never receives a
  reusable worker enrollment credential.
- The server can compare direct and relayed traffic without inspecting payloads
  or creating tenant-cardinality metrics.

## Rejected alternatives

- **Always relay:** simple but needlessly slow and expensive on the same host.
- **Trust localhost, LAN IPs, or machine names:** those values prove neither
  identity nor authorization.
- **Expose worker service ports or credentials:** broadens access beyond the
  requested attachment and makes lifecycle revocation unreliable.
- **Remove relay after direct succeeds:** turns a performance optimization into
  an availability dependency.
