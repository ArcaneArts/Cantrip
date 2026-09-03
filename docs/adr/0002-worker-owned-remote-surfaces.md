# ADR 0002: Worker-owned Remote Surfaces

- Status: Accepted
- Date: 2026-08-08

> Amendment: Worker ownership and lifecycle remain accepted. Supported Browser
> and Remote Desktop clients now use shared WorkerLink interactive/realtime
> lanes over LOCAL where eligible, authenticated LAN/WAN WebRTC peer carriers,
> or server RELAY. The
> feature-specific transport below is retained as decision history and a
> deprecated compatibility description; see ADR 0009 and `docs/NETWORK.md`.

## Context

Cantrip needs interactive Browser and remote-desktop tabs in Tauri, ordinary
web clients, and Capacitor clients. An iframe cannot display arbitrary
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

Cantrip models Browser and managed desktop sessions as versioned **Remote Surfaces** owned by a
worker. The app remains a presentation and input surface; its control and
signaling connect to the Cantrip server, while an authorized WebRTC attachment
may carry data directly.

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

WebRTC is the preferred low-latency data plane. Signaling always travels through
the server. Host candidates permit direct same-machine and reachable-network
attachments without an ICE service; optional STUN discovers public candidates,
and configured TURN supplies short-lived relay credentials. Deployments may
enforce relay-only ICE when direct app-to-worker traffic is prohibited. Failure
to negotiate WebRTC returns to the authenticated WebSocket data plane without
changing the durable session.

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

### Managed desktop adapter

Creating a Remote Desktop supplies no host, port, password, or worker address.
The server resolves an optional explicit worker `ExecutionTarget` through the
canonical placement policy and asks that worker to probe native display capture
before it persists the tab.
The durable configuration contains the desktop kind and a safe capture-target
identity; the worker remains the authority for display discovery, capture,
application launch, and input. Target identity stores monitor ID/name or
window ID/application/title, never an executable command supplied by the app.

Fleet inventory is control-plane metadata, not a combined stream. The server
fans bounded target-inventory commands out to eligible workers and reports
per-worker failures. Selecting a fleet target creates or reconfigures one
worker-owned Remote Surface, preserving independent attachment and reconnect
state for every stream.

An attached client receives a bounded inventory of monitors and capturable
windows through the existing control channel. Selecting one persists the tab
configuration on the server, which forwards live reconfiguration to the
worker. Native IDs are preferred but treated as ephemeral: monitor name and
application/window title restore a saved target after reconnect. If a saved
application is absent, the worker uses its platform launcher and polls for the
matching window while publishing a launch state. Missing or failed targets
fall back to the primary or first monitor while retaining the requested target
for the next refresh or reconnect.

The worker uses a cross-platform native desktop-control library to capture
compressed frames and perform pointer, keyboard, and explicit clipboard
actions. These messages use the same versioned Remote Surface envelopes as the
Browser adapter. There is no desktop listener and no directly reachable worker
port. Main, popout, browser, Tauri, and Capacitor clients therefore use
one canvas renderer and the same app-to-server-to-worker path.

Desktop capture and input are separate backends. A native XCap-based capture
source and Sharp JPEG encoder run as a bounded pipeline, targeting 30 FPS by
default and up to 60 FPS when requested. A compatibility screenshot source is
retained for unsupported hosts. The server injects the account's frame-rate and
quality preferences into each authorized attachment. The worker adapts JPEG
quality and encoded width from payload size, transport pressure, and bounded
client render feedback. The app retains only the newest undecoded frame, so a
slow decoder drops visual history instead of increasing control latency.
Pointer input remains target-relative in the app protocol; the worker adds the
selected monitor or window origin immediately before invoking native input.
For a window target, the worker retains its native window identity and uses the
in-process, cross-platform automation backend to activate, restore, and raise
that window before actionable pointer, keyboard, or clipboard input. The input
call also carries the same native window ID with strict focus enforcement.
Activation failure rejects the input and surfaces an error instead of allowing
a global event to land on whichever window currently overlaps the captured
target. Portable background-window event injection is intentionally not used
because operating systems and applications handle it inconsistently.

The operating system remains the final authority. macOS requires Screen
Recording and Accessibility grants for the worker process; Windows uses native
desktop APIs; Linux requires a supported graphical session. A failed capture
probe rejects creation rather than persisting a known-broken tab.

## Trust boundaries

- Apps authenticate only to the server and contain no worker origin or worker
  enrollment credential.
- Workers initiate their authenticated server connection.
- The server authorizes every attachment and routes frames but never persists
  browser profile files, cookies, desktop frames, or clipboard bodies.
- A raw CDP endpoint is equivalent to control of the browser profile and must
  remain worker-local.
- Frame, clipboard, and input channels have explicit size, rate, and logging
  policies. Keystrokes, clipboard bodies, and images are not logged.
- Disconnecting a client detaches its attachment. Closing a surface explicitly
  terminates the worker session. A worker disconnect leaves the durable record
  recoverable and visibly offline.

## Consequences

- Tauri remains a thin portable shell; browser rendering does not require a
  private macOS API or transparent native-view layering.
- The same Browser and managed desktop components can run in Vite, Tauri, Capacitor, and
  popout windows.
- Local browser streaming uses direct WebRTC when host candidates negotiate and
  otherwise retains the authenticated server WebSocket fallback.
- Browser and managed desktop share transport and lifecycle code but retain distinct
  worker adapters and channel semantics.
- STUN/TURN improve WebRTC reachability but are not required for host-only
  negotiation. WebSocket remains a tested compatibility and recovery path
  rather than a development-only stub.
- Remote Desktop capture is tied to the worker's active graphical session;
  separate multi-seat displays and operating-system login screens require
  future platform-specific work.
