# ADR 0002: Worker-owned Remote Surfaces

- Status: Accepted
- Date: 2026-08-08

## Context

Cantrip needs interactive Browser and remote-desktop tabs in Tauri, ordinary
web clients, and future Capacitor clients. An iframe cannot display arbitrary
sites because sites may prohibit framing and because a proxy cannot safely or
faithfully rewrite the modern web. A child Tauri webview displays arbitrary
sites, but it is an operating-system-native sibling surface. React menus,
dialogs, and drag previews cannot be composed reliably above it with portable
CSS. Platform-specific native-view reordering would also make behavior differ
between WKWebView, WebView2, and WebKitGTK.

The selected worker is already the authority for project files, terminals,
Codex, credentials, and worker-local network addresses. A browser running on
the app device would therefore see the wrong network and could not be shared
with an agent or another Cantrip client. Remote desktop has the same routing,
input, lifecycle, and reconnect requirements as a remote browser.

## Decision

Cantrip models Browser and VNC as versioned **Remote Surfaces** owned by a
worker. The app remains a presentation and input surface and connects only to
the Cantrip server.

### Control plane

The server stores the durable Remote Surface record, including its owner via
project ownership, assigned worker, kind, safe configuration, lifecycle
status, preferred transport, and last connection/error metadata. Attachments
are ephemeral client observations of that durable session.

Lifecycle operations are create, attach, detach, suspend, resume, resize,
reconnect, and close. The server authorizes the user, project, surface, and
worker association before issuing a versioned worker command. Worker
capabilities announce supported surface kinds, transports, and limits.

### Data plane

The mandatory baseline is a binary WebSocket relay:

```text
app WebSocket <-> Cantrip server <-> authenticated outbound worker WebSocket
```

Binary frames have a validated versioned header, surface and attachment IDs,
monotonic sequence, typed channel, and bounded payload. Each relay validates
the authorized binding, rejects cross-surface frames, ignores stale sequences,
drops disposable visual frames under pressure, and closes congested reliable
channels rather than growing memory without bounds.

WebRTC is the preferred low-latency data plane when TURN is configured.
Signaling always travels through the server. Configured deployments use
short-lived TURN credentials and relay-only ICE when direct app-to-worker
traffic is prohibited. Failure to negotiate WebRTC returns to the authenticated
WebSocket data plane without changing the durable session.

The server holds the long-lived TURN REST shared secret and derives expiring
HMAC credentials per authorized attachment. Only the short-lived username and
credential reach the app and worker. Visual frames use an unordered,
loss-tolerant data channel; reliable control and input use an ordered channel.
Both carry the same versioned Remote Surface binary envelope as WebSocket, so
sequence validation and failover are transport-independent.

### Browser adapter

The worker launches or discovers Chromium and controls it through CDP. Browser
profiles and credentials stay in the worker data directory. CDP screen frames
are rendered by the app inside its ordinary React layout, while navigation,
input, viewport, cursor, clipboard, loading, URL, title, console, DOM, and
network operations cross the authorized Remote Surface protocol. Chromium's
raw remote-debugging endpoint is never exposed to an app or the server.
The original server-side iframe rewriting proxy and Tauri child-webview
commands are removed once this adapter is active, so there is only one Browser
renderer and no hidden platform-specific fallback.

### VNC adapter

The worker connects to a configured RFB/VNC endpoint reachable from that
worker and relays the session through the same attachment and transport
infrastructure. Cantrip does not silently enable an operating system's remote
desktop service. VNC credentials are worker secrets and ordinary APIs return
only safe connection metadata; the durable surface configuration contains only
an opaque secret reference.

The app uses noVNC as a regular React renderer. A channel adapter carries raw
RFB bytes inside the same versioned Remote Surface envelopes used by the other
data channels, over relay-only WebRTC when available and authenticated
WebSocket otherwise. Each app attachment receives a separate worker-to-VNC
connection, so independent main and popout renderers do not compete for one RFB
client state machine.

The initial worker gateway speaks RFB 3.8 and terminates either the None or
classic VNC Password security type before presenting a credential-free RFB
session to noVNC. It does not support TLS/VenCrypt yet. Classic RFB is not an
encrypted worker-to-endpoint transport, so configured endpoints must be
reachable over loopback, a trusted private network, VPN, or tunnel.

## Trust boundaries

- Apps authenticate only to the server and contain no worker origin or worker
  enrollment credential.
- Workers initiate their authenticated server connection.
- The server authorizes every attachment and routes frames but never persists
  browser profile files, cookies, or plaintext VNC credentials. A newly entered
  VNC password transits server memory once on its way to the selected worker
  and must not be logged.
- A raw CDP endpoint is equivalent to control of the browser profile and must
  remain worker-local.
- Frame, clipboard, and input channels have explicit size, rate, and logging
  policies. Keystrokes, clipboard bodies, images, and RFB bytes are not logged.
- Disconnecting a client detaches its attachment. Closing a surface explicitly
  terminates the worker session. A worker disconnect leaves the durable record
  recoverable and visibly offline.

## Consequences

- Tauri remains a thin portable shell; browser rendering does not require a
  private macOS API or transparent native-view layering.
- The same Browser and VNC components can run in Vite, Tauri, Capacitor, and
  popout windows.
- Local browser streaming still traverses the loopback server. Backpressure
  and efficient encoding therefore matter even in local mode.
- Browser and VNC share transport and lifecycle code but retain distinct
  worker adapters and channel semantics.
- WebRTC requires operational STUN/TURN configuration. WebSocket remains a
  tested compatibility and recovery path rather than a development-only stub.
- Automatic cross-platform desktop capture/provisioning is a separate adapter;
  the first VNC implementation connects to an explicitly configured RFB
  endpoint and does not claim to secure an otherwise exposed classic VNC
  service.
