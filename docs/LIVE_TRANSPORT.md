# Live transport

Cantrip deliberately separates authoritative application state from ephemeral
client-to-worker data:

- HTTP owns snapshots, mutations, durable results, and recovery.
- App Live is the authenticated owner-scoped JSON control and synchronization
  channel at `/api/live`.
- WorkerLink is the shared ephemeral client-to-worker data fabric.
- The authenticated outbound worker WebSocket remains the server-to-worker
  command and event channel.

The architecture decisions are recorded in
[ADR 0005](adr/0005-application-live-control-websocket.md),
[ADR 0009](adr/0009-worker-link-session-and-grant-authority.md), and
[ADR 0010](adr/0010-tauri-native-worker-link-carrier.md).

## Transport ownership

| Boundary                                                                  | Transport                                                 |
| ------------------------------------------------------------------------- | --------------------------------------------------------- |
| Bootstrap, snapshots, CRUD, chat input, approvals, files, and Git actions | HTTP                                                      |
| Committed invalidations and bounded client-control requests               | App Live                                                  |
| Terminal                                                                  | WorkerLink interactive reliable stream                    |
| Browser and Remote Desktop                                                | WorkerLink interactive/realtime streams                   |
| Code, generic TCP tunnel, and project-share bytes                         | `tunnel-data-plane-v1` inside WorkerLink reliable streams |
| Worker commands and events                                                | Authenticated outbound worker WebSocket                   |

Durable or final state travels through HTTP and App Live. Low-latency
provisional observations travel through WorkerLink. App Live never proxies REST
requests or carries bulk feature bytes.

## App Live contract

The client initializes protocol version `1` with a bounded client identity,
supported client-control capabilities, and an optional same-epoch resume cursor.
It then manages current-user, project, and chat subscriptions. The protocol
retains `workflow-run` as a compatibility schema value, but the server rejects
that scope and no current publisher or client subscriber exists. The server returns its process epoch,
connection ID, current cursor, heartbeat interval, and replay decision.

Each committed event contains one authorized scope, a typed resource and
action, an optional opaque entity ID and revision, a commit timestamp, and an
optional bounded payload. The protocol resource union in
`packages/protocol/src/live.ts` is authoritative and intentionally broader than
any illustrative list in this guide.

The server replays retained events after a same-epoch cursor and finishes with
`caught-up`. Cross-server relay-coordinator publications are inserted into each
receiving server's owner-local hub and replay ring. The server sends
`resync-required` when a restart, cursor gap, queue
overflow, or scope discontinuity prevents safe replay. The app then refetches
the authoritative HTTP snapshots before acknowledging its recovered cursor and
scopes. Unknown messages, fields, oversize payloads, and unauthorized scopes are
rejected.

### Ephemeral client controls

Managed Cantrip operations may request a bounded notice, project focus,
authorized surface focus, or display of an exact pending interaction. Each
request is typed, correlated, expires within ten seconds, and can be
acknowledged as `applied`, `declined`, `unsupported`, or `expired`. The server
may instead resolve the request as `unavailable` when no matching client remains
connected. It is sent only to a same-owner connection that advertised the
capability and subscribed to the required scope.

Client controls do not enter the replay ring or mutate durable state. Reconnect
does not repeat them, and showing an interaction never answers it.

## WorkerLink contract

A WorkerLink session is bound to the exact server identity and generation,
owner, account session, client instance, worker, and worker generation.
Exact-resource grants authorize resources, operations, lanes, channel count,
and lease. Candidate addresses are
rendezvous data, never authority; the authenticated carrier handshake and exact
grant remain authoritative.

The fixed route order is:

1. `LOCAL`: a server-authorized loopback carrier for a colocated native app and
   worker.
2. `LAN`: an authenticated WebRTC peer carrier over a local network.
3. `WAN`: an authenticated WebRTC peer carrier using discovered public
   candidates.
4. `RELAY`: the server relay.

Reliable streams remain pinned to their current carrier until reconnect. Event
subscriptions may retire and promote when a better route becomes available. On
network change or app resume, WorkerLink keeps RELAY and a healthy LOCAL carrier
and retires LAN/WAN. If LOCAL remains ready, direct probing stops there;
otherwise probing resumes at the first supported direct route (LAN for
browser/mobile, or LOCAL then LAN/WAN where supported).

The old feature-specific terminal, Remote Surface, and tunnel endpoints remain
deprecated compatibility surfaces; supported clients use WorkerLink.

## Native tunnel bridge

Native desktop tunnels keep a stable `127.0.0.1` listener. Rust forwards
through a bounded, generation-scoped WebView bridge into the renderer-owned
WorkerLink manager. The renderer selects LOCAL, LAN, WAN, or RELAY without
changing the local port, URL, credentials, or hard attachment lease.

Tunnel traffic retains its inner `tunnel-data-plane-v1` identity framing,
credit/backpressure behavior, and endpoint AES-256-GCM protection across every
outer WorkerLink carrier. WebRTC is renderer-owned; native code does not host a
separate peer carrier.

## Rollout and recovery

A resource may remove fixed polling only after its server publisher and app
subscriber exist, reconnect convergence is proven, and an authoritative HTTP
fallback remains. Active resources use App Live while healthy and bounded HTTP
polling during startup, disconnect, or resynchronization.

The server always commits durable state before publishing an invalidation.
Complete payloads may be applied directly when the protocol provides them;
coalesced invalidations refetch snapshots when it does not. App Live cursor
gaps, WorkerLink reconnects, worker-generation changes, and server restarts all
fail toward a fresh authorized snapshot or grant rather than treating either
socket as durable storage.

## Observability

Health and metrics expose bounded aggregate App Live delivery, replay, resync,
heartbeat, violation, and queue-pressure counters. WorkerLink diagnostics cover
session/grant decisions, selected route and lane, peer negotiation, reconnects,
relay avoidance, bytes, rejections, and termination reasons. Native forwarders
report their effective route and monotonic counters through the authenticated
bridge.

Metrics must not label or log owners, projects, destinations, credentials,
prompts, terminal contents, or source data. The measured App Live behavior and
fallback inventory are recorded in
[LIVE_TRANSPORT_AUDIT.md](LIVE_TRANSPORT_AUDIT.md).
