# Project Network Shares

Project network shares let a desktop Cantrip client reveal a worker-owned
project in Finder or Explorer without assuming the checkout exists on the
client machine. The server authorizes the project and tunnel and carries bytes
only when WorkerLink selects RELAY. It cannot open the project path, WebDAV
credentials, or file bytes.

## Architecture

```mermaid
flowchart LR
    CLIENT["Unlocked Tauri client"]
    SERVER["Cantrip Server<br/>opaque control plane and RELAY"]
    FORWARD["Native localhost forwarder<br/>and bounded WebView bridge"]
    LINK["Renderer WorkerLink manager<br/>LOCAL / LAN / WAN / RELAY"]
    WORKER["Assigned Cantrip Worker"]
    DAV["Authenticated loopback WebDAV"]
    TREE["Project checkout"]
    NATIVE["Finder / Explorer"]

    CLIENT -->|"protected tunnel record"| SERVER
    SERVER -->|"control and relayed WorkerLink frames"| WORKER
    WORKER --> DAV --> TREE
    NATIVE <-->|"WebDAV on 127.0.0.1"| FORWARD
    FORWARD <-->|"generation-scoped bridge"| LINK
    LINK <-->|"LOCAL / LAN / WAN endpoint-AEAD frames"| WORKER
    LINK <-->|"RELAY ciphertext"| SERVER
```

The unlocked client creates the tunnel ID, a random 256-bit capability path,
Digest username and password, realm, and data-plane key. It seals those values
together with the worker-local project root inside a revision-bound
`tunnel-content` record. The server retains only the authenticated owner,
project, assigned worker, public adapter/resource IDs, lifecycle metadata,
counters, and ciphertext.

The worker opens the record with its scoped `tunnel-content` grant, validates
the server/worker/tunnel/revision bindings, canonicalizes the protected root,
and starts an authenticated WebDAV listener on a random `127.0.0.1` port. The
listener address and credentials never return through the server. A protected
tunnel connection opens that listener locally on the worker and carries raw
WebDAV TCP bytes; the old server HTTP translation endpoint and plaintext worker
adapter no longer exist.

The desktop mounts only the local forwarder's `127.0.0.1` URL. A bounded native
bridge feeds the renderer-owned WorkerLink manager, which selects `LOCAL`,
`LAN`, `WAN`, then `RELAY`. Every carrier preserves the same inner tunnel
identity and AES-256-GCM frames, so route mobility does not change the mount
URL, remount through a cloud endpoint, change credentials or the hard lease, or
downgrade encryption.

## Standalone Chat scratch shares

Standalone Chat can reveal its worker-owned scratch root through the same
protected WebDAV and WorkerLink path. The share is bound to the exact standalone
chat, scratch-root identity, active worker, tunnel, and attachment. Project chats
cannot use this endpoint, and a scratch share cannot target a project worktree.
The selected worker must advertise standalone Chat network-share support.

The native reveal flow may prefer a verified same-host scratch directory. When
that is unavailable or not requested, it creates an expiring network share,
starts the stable desktop tunnel, and opens the requested relative path in
Finder or Explorer. Chat archive or deletion revokes the share when reachable;
otherwise its bounded lease expires naturally.

## Native client boundary

The reveal action is available only in the desktop Tauri shell. The React
client passes the localhost URL and transient Digest credentials to the native
mount command without placing credentials in a URL, log line, or
shell-expanded command string.

Windows supplies credentials in memory through `WNetAddConnection2W`, creates
a temporary deviceless UNC connection, and opens it in Explorer. macOS passes
credentials to `mount_webdav` through a private inherited descriptor and mounts
into a Cantrip-owned directory before opening Finder. Native mounts are reused
while their tunnel URL is unchanged and are released when replaced, when the
bounded mount lease expires, or when the desktop runtime shuts down.

Explorer folder context menus reuse the whole-project mount and open the
selected relative directory. Holding Shift selects the verified same-host
physical directory instead; this intentionally does nothing for a remote
worker.

## Security and lifecycle invariants

- Network shares introduce no new user-managed secret. Account/password modes
  keep their existing login custody, while anonymous mode keeps its existing
  recovery artifact. Share credentials and data-plane keys are generated and
  are not user-retained.
- Project roots, capability paths, usernames, passwords, realms, and
  data-plane keys exist only in client/worker-opened protected content.
- Worker WebDAV and desktop mount endpoints bind to `127.0.0.1`, never a LAN or
  public interface.
- The server cannot terminate WebDAV, return a cloud share URL, or request the
  legacy unprotected project-share adapter; the protocol and worker reject that
  downgrade path.
- Every application-data frame, on every WorkerLink carrier, is authenticated against the
  tunnel, attachment, endpoints, connection, direction, sequence, nonce,
  format, and key revision.
- Workers canonicalize the project root, bound simultaneous shares, reuse only
  identical protected configurations, and close listeners on revocation or
  shutdown.
- WebDAV remains writable, while worker-side filters reject operating-system
  metadata artifacts such as `.DS_Store`, AppleDouble sidecars, `Thumbs.db`,
  and `desktop.ini`.
- Server revocation closes generic desktop attachments, removes the managed
  tunnel record, and tells the worker to close its listener.

## Implementation status

Protected project and standalone Chat share configuration, worker-local WebDAV
lifecycle, encrypted WorkerLink transport, carrier mobility, desktop-only
macOS/Windows mounting, expiration, revocation, and local-folder preference are
implemented. The remaining release responsibility is platform QA against
supported Finder and Explorer versions.
