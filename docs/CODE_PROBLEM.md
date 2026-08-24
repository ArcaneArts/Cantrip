# Cantrip Code Explorer Connection Problem

Status: current-source root causes remediated and accepted with fresh local-only
desktop, direct-route, and forced-relay evidence on 2026-08-23. The historical
sections remain below to preserve how the incident was narrowed; this addendum
is the authoritative final state.

Investigation baseline: `origin/main` at `169aee45` (`fix(explorer): reuse
shared Code editor process (#913)`).

## Warm continuity hardening follow-up (started 2026-08-24)

The root incident documented below remains remediated. A separate longevity
audit against `origin/main` at `39faacf66` found that a mounted editor can still
lose its warm route after quiet periods because the Code attachment, direct
capability, relay credential, worker command connection, bridge socket, native
forward, and iframe are governed by independent lifetimes. This follow-up must
preserve the security and exact-identity guarantees established by the original
remediation; it does not reopen the fixed server-identity, workspace-binding,
TCP backpressure, initial-readiness, or editor-chrome defects.

The confirmed current gaps are:

1. Code activity renews the protected Code binding, but the direct capability
   retains its original expiry and the server never sends the worker's existing
   `direct.capability.renew` command.
2. The 15-second worker command reconnect grace preserves pending commands, but
   disconnect subscribers immediately revoke Code attachments, relay routes,
   direct capabilities, and worker Code endpoints.
3. Relay credentials live for two minutes and are refreshed only after a
   10-second renderer poll observes a degraded native route. A direct expiry can
   therefore meet an already-expired relay credential and native reconnect
   backoff.
4. Bridge and transport health largely means "socket is OPEN." There is no
   acknowledgement deadline for idle liveness, so the first operation can spend
   five seconds discovering a stale bridge. Some post-mount control requests
   also lack their own deadline.
5. A sidebar file click clears the desktop prewarm slot and mounts a separate
   inline owner. The prewarmed workbench is therefore not eligible to satisfy
   the first sidebar open.
6. Browser relay open/readiness has no bounded reconnect loop, and one congested
   native logical stream can currently fail the shared route session.
7. Retained profile crash recovery has one-shot/circuit-open retry holes, while
   editor file navigation performs persistence writes that do not affect the
   persisted editor-only state.

Cycle 1 is intentionally behavior-neutral. It adds correlated, secret-safe
timing evidence before any lease or reconnect policy changes: direct-capability
prepare/telemetry events expose only bounded lease duration/remaining time;
native reconnect failures receive a finite reason code and retry phase; and
browser relay is classified explicitly rather than being mislabeled as direct.
Focused tests exercise those fields and the production reconnect seam without
logging capability IDs, credentials, protected URLs, authorization headers, or
payloads.

Cycle 2 makes the in-memory protected Code attachment the authoritative lifetime
root. Its opaque generation is created with the logical server, owner/account,
raw authentication session, protected-content key revision, worker, and the
creating Explorer/worktree identity. Explorer mutation, explicit release,
security-identity change, idle expiry, or the 12-hour absolute cap invalidates
that generation; clients cannot supply or extend any of those identity fields.
Code-origin relay attachment creation, direct preparation, activation, and
heartbeat now fail closed unless they acquire that exact live root.

The desktop's existing 10-second transport report renews the root on every
healthy forward, including zero-byte idle reports. A local-direct report also
renews the existing worker capability inside a stable 90-150-second jittered
window. The server and worker enforce monotonic expiry acknowledgements and the
root's absolute cap. A transient worker/transport renewal failure preserves the
currently valid grant for a bounded retry; a rejection, malformed acknowledgement,
expired root, or changed generation revokes it. Healthy relay and degraded
forwards use a route-independent authenticated attachment heartbeat, so relay
traffic no longer depends on direct telemetry to keep the Code session alive.

Relay fallback credentials remain ready while direct is healthy. The app
refreshes a local-direct fallback 30-40 seconds before its two-minute secret
expiry and refreshes degraded routes immediately, but does not disrupt a
healthy active relay merely to rotate its connection credential. The database
serializes rotations on the tunnel row and returns a strictly increasing public
secret-expiry generation. Native forwarding retains only the latest
zeroizing credential, discards stale out-of-order responses, interrupts a
stalled degraded connect when a newer credential arrives, and can replace its
standby fallback without restarting a healthy direct session.

Relay data-plane activity is now bound to the exact authenticated root that
minted the database attachment. A Code WebSocket without that local binding is
rejected instead of falling through the generic unmanaged-tunnel allowance,
and every accepted frame slides only that root. Client transport maintenance is
deadline-bounded and isolated per tunnel, so a stalled refresh or route switch
cannot suppress later heartbeats for other tunnels. A late
`forward-unavailable` refresh no longer deletes the stable shared attachment
identity; its unpublished credential expires naturally. Late forced-relay
commands are fenced by the direct capability they observed and cannot mutate a
replacement forward.

One confirmed hosted-deployment gap remains intentionally unsolved in this
cycle. Code roots and direct grants are process-local, while PostgreSQL
attachments and HTTP routing are shared across replicas. The new local relay
binding converts the previous cross-replica fail-open path into a safe rejection,
but attachment creation, relay connect, direct activation, and renewal can
still fail when consecutive requests land on different replicas. Sticky
routing is therefore still an availability dependency for Code despite the
general hosted contract. Correct removal requires a durable, fenced Code-root
authority claim plus bounded owner-instance coordination for root activity and
direct-grant operations; it must be implemented and exercised with two server
instances before final continuity acceptance.

Deterministic protocol, worker, server, app, and native tests cover renewal,
hard caps, revoke-over-renew races, cross-ordered relay refreshes, stalled
connect interruption, zero-byte heartbeats, monotonic credential generations,
fail-closed orphaned Code tunnels, exact relay-root binding, stalled maintenance
isolation, and replacement-safe cleanup. The real 2/5/10/16-minute local
acceptance run remains a Cycle 10 requirement; this cycle does not claim that
evidence or change worker reconnect, bridge-liveness, or retained-workbench
policy.

Cycle 3 separates a recoverable command-channel interruption from terminal
worker offline state. A current worker process supplies one random connection
generation for its whole lifetime; the server binds that generation to the
authenticated credential and owner. During the existing 15-second grace, the
server retains the worker's Code roots, relay routes, direct grants, and tunnel
endpoints, while the worker retains its authorized tunnel destinations, direct
capabilities, and Code endpoints. Pending commands keep their existing bounded
outcome. A reconnect cancels deferred cleanup only when all three continuity
fields match. Grace expiry, credential or owner mismatch, process-generation
change, authentication rejection, explicit revocation, and shutdown perform
terminal cleanup. Older workers remain connectable, but because they cannot
prove a stable process generation they do not receive this continuity guarantee.

Both sides fence messages, frames, timers, shared presence publications, and
asynchronous relay claims by the socket or claim generation that created them.
Generation-aware workers now negotiate the additive
`cantrip-worker-auth-ready-v1` WebSocket subprotocol and wait for its ordered
`pending`/`ready` handshake: raw WebSocket open does not cancel grace, start
keepalive, flush queued command outcomes, or enable data-plane sends. The worker
offers the legacy protocol first, so an older server keeps its original
raw-open behavior and can still flush durable outcomes during a rolling
upgrade; the current server explicitly selects authenticated-ready only on the
worker command route. The server sends `pending` before async authentication,
queues `ready` before the accepted bridge/relay claim becomes command-visible,
and relies on WebSocket ordering to prevent commands from overtaking readiness.
The ready deadline is anchored to the original loss, so repeated pending
sockets cannot extend retention. A matching `ready` without a preceding
same-socket `pending` is a protocol error.

Legacy workers remain compatible through the bounded input buffer and receive
no new handshake envelopes. One socket may retain at most 1,024 events or
8 MiB; the process retains at most 64 MiB across at most 32 concurrent pending
handshakes, and authentication/claim wait closes its socket after 10 seconds.
Dead or overflowing sockets cannot activate, reset grace, or leave a false
relay claim. Focused tests cover a short interruption, grace expiry, repeated
flaps, stale sockets, identity mismatch, explicit termination, failed retry
attempts, shared-claim replacement, dead refresh/claim races, authenticated
readiness, pre-authentication ordering, and aggregate budget release. This
cycle does not add a Pong deadline or make process-local Code-root authority
multi-replica; those remain later-cycle work.

## Final remediation and acceptance addendum (2026-08-23)

The incident was a stack of independent defects. Fixing only OpenVSCode process
reuse could not make the feature reliable because the client, server, native
forwarder, and worker disagreed or failed at later boundaries:

1. Protected Code content used two different server identities. The client
   bound encrypted endpoint data to the server UUID while the worker attempted
   to open it with a URL-derived identity. Direct and relay therefore rejected
   the same valid record. The worker bootstrap now carries and persists the
   authoritative logical server UUID separately from its transport URL.
2. Explorer authorization readiness survived Explorer/server/account changes.
   The client could consequently issue protected operations with stale surface
   grants. Readiness is now scoped to the complete authorization identity and
   is invalidated when that identity changes.
3. The worker's tunnel adapter did not apply real TCP backpressure. A fast
   OpenVSCode response could exceed the one-MiB pending queue while WebSocket
   capacity was awaited, making the adapter close its own stream and truncate
   the 15,449,528-byte `workbench.js` response at 65,128 bytes. Destination
   reads are now paused synchronously before asynchronous capacity waits,
   resumed only after queued data and credit permit, and half-close is deferred
   until queued frames are emitted. A bounded guard remains for genuine
   congestion and reports a safe local-close diagnostic.
4. A cold Code profile was not consistently prewarmed. The first implementation
   scheduled prewarm only from the periodic heartbeat. When a worker started
   before the client authorized its encryption principal, the startup refresh
   was not ready and the later server-driven `worker.encryption.refresh` did not
   schedule Code. The first Explorer warmup or file open could therefore launch
   OpenVSCode itself. Startup, server-driven refresh, and heartbeat now share one
   refresh-and-prewarm path. Every ready refresh schedules the same bounded,
   owner-scoped default profile; the supervisor deduplicates concurrent calls,
   retains one warm process for the worker lifetime, restarts it with bounded
   backoff after a crash, and terminates an in-flight launch during shutdown.
5. Editor presentation hid most VS Code chrome but left the title/command area,
   layout controls, minimap, and notification toasts visible. Editor mode now
   suppresses those surfaces, navigation controls, extension recommendations,
   the debug toolbar, activity bar, sidebar, panel, tabs, and status bar while
   preserving the editor workbench itself.
6. Desktop cleanup released the protected Code attachment before the native
   forward had completely stopped. Cleanup now stops the forward first, then
   releases the attachment, preventing late loopback work from racing revoked
   credentials.

### What “prewarmed at worker startup” can safely mean

The worker can start the shared OpenVSCode **profile process** without creating
a repository workspace or file session, but only after it has a verified owner
and logical-server binding. Deriving the owner-scoped profile before that point
would cross account boundaries. If the binding is already ready during worker
startup, prewarm begins there. If the worker starts first, prewarm begins on the
authorization refresh sent by the client/server, not on the next heartbeat and
not on a file click.

A fresh local delayed-authorization run on port 4330 proved the corrected
ordering. Worker `cycle8-cu3-local` started with no usable encryption binding.
Creating a minimal project caused the authoritative refresh to complete at
`00:39:17.872Z`; `code.profile.prewarm-started` followed at
`00:39:17.873Z`, and the process started at `00:39:17.875Z` with zero sessions.
Explorer's own hidden workspace warmup reached `code.open` at
`00:39:17.940Z`, while that profile launch was already in flight. The profile
became ready after 227 ms as instance
`3c0df936-2039-4ff5-9f83-bfc2690ef53d`, and the Explorer session reused that
same instance. No file was clicked and no demand-created profile process was
started.

There are intentionally two warmup layers:

- Worker profile prewarm starts OpenVSCode and retains the shared process.
- Client Explorer prewarm creates the authoritative workspace/session, native
  forward, iframe, workbench, and bridge after authenticated Explorer metadata
  exists.

The second layer cannot run inside the worker because WebKit belongs to the
desktop client and no repository workspace may be invented before an
authoritative Explorer target exists. A completely cold local WebKit cache took
about 6.3 seconds end-to-end in the acceptance run (about 3.34 seconds to load
the frame); that work now begins automatically when Explorer becomes available,
before a file click. Switching files remains a warm control request in the same
iframe and process.

### Local-only acceptance evidence

All accepted Code traffic used fresh loopback servers and local workers; the
out-of-date Winterhold server was not used. A retained desktop profile did try
and fail to start an unrelated Winterhold worker in one QA app launch, but it
was never selected and carried none of the tested Explorer or Code traffic.

- A fresh desktop Explorer expanded the cloned Gloss repository and opened the
  exact requested `GlossPaperCommand.java`. The editor displayed that file's
  source, not a welcome page or neighboring path.
- Switching to `GlossPaperCommandRegistrar.java` reused the same iframe URL,
  port, nonce, Code session, and OpenVSCode process.
- The initial local-direct attachment moved 30,670,984 bytes toward the client
  over nine accepted connections without truncating the workbench bundle.
- The active attachment was then forced from connected local-direct transport
  to managed relay. The existing rendered editor stayed usable, and selecting
  `PaperBlockLockListener.java` completed a new worker `file-opened` control
  request over that relay without remounting the workbench.
- Visual and accessibility inspection confirmed editor-only presentation:
  source editor and its ordinary editor actions remained, while VS Code's
  activity bar, sidebar, panel, command center/title bar, tabs, status bar,
  minimap, layout controls, and recommendation toast were absent.
- Native end-to-end coverage sent a deterministic 16 MiB + 137 byte patterned
  HTTP response through both direct transport and a connected-but-broken direct
  route that fell back to managed relay, asserting exact byte length and order.

The resulting normal first-click contract is therefore: if Explorer has had an
opportunity to prewarm, clicking a file only reveals the already-mounted
editor and sends an exact-path open request. If a user clicks before the client
can finish a genuinely cold WebKit mount, the UI may still wait for that one
client-side mount, but it no longer launches the worker Code profile on demand,
truncates large assets, silently loops on a deterministic rejection, or exposes
the full VS Code shell.

## Current-source reproduction addendum (2026-08-23)

A fresh local-only reproduction on current source closes the initiating boundary
that the original logs left ambiguous. The correlated trace is
`44d6ba16-bd09-434d-8183-b7fbdb3bb080` (Code session
`edc13760-b666-4423-989f-ac3bdb2af231`, tunnel
`307f9d17-94fe-4bed-b5a9-c61d8ffdeb59`, attachment
`f7d63b2c-72c0-4813-99d7-b482726b65dc`). It proves this order:

1. The worker prepares the workspace and starts Cantrip Code/OpenVSCode
   successfully.
2. The desktop listener accepts local HTTP connections, authenticates the
   direct capability, and sends protected Open frames to the worker.
3. The worker rejects the first protected target with
   `protected-record-open-failed`; native/client telemetry reports
   `protected-record-unavailable`.
4. The health supervisor switches to relay automatically. Relay reaches the
   same worker and rejects the same protected record, proving that transport
   selection is not the initiating failure.
5. Explorer directory operations in the same local run fail at worker protected
   request opening and return HTTP 502, before filesystem access. The worker's
   live grant snapshot contains `repository-content` and `tunnel-content`, but
   not the `surface-private-state` grant required for Explorer operations.

The deterministic Code root cause is an authenticated-data identity mismatch.
The client encrypts endpoint/tunnel content with the server's persistent UUID
from `ClientSessionContext.serverId`. `WorkerEncryptionService`, however, uses
the canonical server URL (with the loopback port optionally removed) as
`serverIdentity()`. The server binding participates in AEAD associated data, so
even a valid, freshly issued worker component-key grant cannot authenticate the
client payload. Direct and relay necessarily fail in the same way because both
carry the same protected record.

Explorer's failure is separate. Its worker command already carries the server
UUID explicitly, but `ExplorerView` retained `streamEncryptionReady` when the
Explorer changed on the same worker. After the local server/grant state changed,
the stale ready flag allowed operations to run without reauthorizing the two
surface grants. That produces the same visible “files do not load” symptom at a
different protected-content boundary.

Source chronology supports applying this conclusion to the supplied incident:
worker URL-origin identity landed before endpoint-content encryption began using
the client server UUID, and the reported build includes both changes. The old
logs alone did not expose the rejection, so their exact first failure remains a
historical inference; the combined chronology and current correlated
reproduction identify the same deterministic defect.

The reproduction also exposed three independent follow-up defects:

- Health retries did not stop on a deterministic native destination rejection,
  producing 508 rejected connections in roughly eight seconds before cleanup.
- A previously ready iframe could navigate to an error document while retaining
  stale workbench readiness. Inline Code, inline Explorer, and the Explorer
  popout must clear readiness and remount with a fresh nonce on a second load.
- Explorer stream encryption readiness was keyed only to worker identity, so a
  new Explorer or server/account session on the same worker could reuse stale
  authorization state.

The required encryption fix is to return the authoritative logical server UUID
in worker bootstrap, keep it distinct from the transport URL identity, persist
and validate the two identities separately, and use the UUID for all protected
content associated data. Completion still requires a fresh local desktop click
that mounts the exact requested file in the editor-only workbench, with Explorer
surface grants revalidated for the current server/account session.

## Large-response cold-start addendum (2026-08-23)

After the server-identity corrections reached the local build, Explorer loaded
and a clicked `build.gradle` reached its authorized Code session. The first
embedded workbench mount still failed with:

```text
Cantrip Code workbench did not become ready: The embedded editor timed out
after its endpoint loaded.
```

The correlated WebKit and worker traces close that later failure boundary. The
frame received the OpenVSCode HTML, the 910,568-byte workbench stylesheet, and
the 822,802-byte localization bundle. Its 15,449,528-byte `workbench.js`
response returned HTTP 200 but closed after only 65,128 bytes. WebKit reported
`READ_CLOSE`, `HPE_INVALID_EOF_STATE`, and `NSURLErrorDomain -1005`. Because the
workbench module never executed, there was correctly no editor WebSocket, bridge
connection, or nonce-bound `cantrip-code.workbench-ready` message. The existing
readiness patch itself was present and a separate framed Chromium check proved
that it emits the expected nonce-bound message after a complete workbench load.

The initiating defect is worker tunnel backpressure in
[`tunnel-tcp-adapter.ts`](../cantrip_worker/src/tunnel-tcp-adapter.ts). A fast
loopback destination continues producing data while asynchronous WebSocket
capacity is pending. The adapter accumulates those chunks and self-closes the
stream as `congested` once its one-MiB queue limit is crossed. The close used to
remove the stream before the ordinary socket-close diagnostic, so the worker
log looked clean while the browser received a truncated HTTP body. Destination
`end` could also emit a half-close before queued data finished flushing.

A manual Retry happened to avoid that timing window and proved the downstream
path. Trace `4edebc5c-cb85-46da-a640-dc455427a77e` (session
`fad38cfc-50ab-40c1-9b03-d0004df1043f`, tunnel
`6cc720de-607e-4b15-934a-2e12b2897016`, generic attachment
`90402744-3c43-4986-8c58-02324d43e8a1`) opened the editor WebSocket, connected
the workbench bridge, applied editor presentation, and displayed the selected
`build.gradle`. It reused process instance
`cb70bbef-984c-40d9-8c43-0fa26d125ac1`; switching files is therefore already a
warm navigation operation rather than a process launch.

That successful screenshot also proves that editor-only presentation is still
incomplete: the VS Code title/command-center and layout controls, minimap, and
an extension recommendation toast remained visible. Those are independent UI
acceptance defects, not causes of the truncated first load.

The required transport correction is real TCP backpressure: pause destination
reads before queueing while a flush or capacity wait is active, resume only
after the queue drains and byte credit permits, defer destination half-close
until the final queued data frame is emitted, keep a bounded safety guard for
true failures, and log self-initiated closure reasons without protected data.
Regression coverage must move a patterned response larger than the actual
workbench module through both native direct and managed-relay paths and assert
its exact length and ordering.

Prewarming should then remove the remaining normal first-click wait rather than
mask this corruption. Worker startup can safely warm one owner-scoped default
OpenVSCode profile after verified server/encryption bootstrap; it must not
invent worktree sessions or fan out across repositories before an authoritative
target exists. The existing Explorer hidden-frame prewarm can then complete the
workspace-specific workbench and bridge handshake before a file is clicked.

## Original supplied-log conclusion (historical baseline)

The remainder of this report preserves the earlier source audit and the limits
of what the two originally supplied logs proved. The current-source addenda
above supersede its unresolved-root conclusion with correlated local evidence.

The existing report is directionally correct about the primary failure boundary,
but the incident is not just an OpenVSCode connection problem and the evidence
does not yet identify one exact initiating defect.

The worker launches an OpenVSCode Server child, observes its TCP listener, and
later reuses the same cached process identity. That proves process-object reuse,
not HTTP/protocol liveness or correct workspace service. The server creates the
Code session and one managed protected tunnel; the desktop then creates a
generic attachment to that tunnel. The worker prepares and authenticates the
direct capability WebSocket. The first loopback HTTP connection, however, never
reaches a **successful** worker Code endpoint. The desktop health request
therefore ends in WebKit's `TypeError: Load failed`, after which the application
tears down the temporary tunnel and Code session.

The unresolved initiating boundary is only this wide:

```text
WebView fetch to 127.0.0.1
  -> Tauri loopback TCP accept and Open frame
  -> worker protected-record decrypt/validation
  -> Code endpoint preparation and TCP accept
```

The supplied logs cannot distinguish these three remaining cases:

1. The WebView request never reaches the Tauri loopback listener.
2. Tauri accepts it, but its `Open` is not queued, written, delivered, or handed
   to `DirectBroker.#handleDirectFrame()`.
3. The worker receives the `Open`, but rejects the protected target before
   `CodeDirectEndpointManager.prepareProtected()` succeeds.

No narrower root-cause claim is supported yet. In particular, the server's zero
connection counters do not settle the question: any native nonzero counters
were not incorporated before revocation, and the 10-second reporting cadence
makes that expected for these short-lived attempts.

There are, however, several additional confirmed defects around this failure and
one important readiness distinction:

- `routeState=local-direct` proves only the deliberately narrow native route
  handshake; it is not evidence that an application connection crossed it.
- Relay fallback is not triggered when the direct WebSocket stays connected but
  every data connection is rejected or unusable.
- Protected destination errors are swallowed at the most important diagnostic
  boundary.
- Native connection counters and events are not captured before the five-to-six
  second cleanup.
- UI readiness signals do not consistently prove that the Code workbench
  rendered successfully.
- Browser Code transport has weaker readiness and failure-state handling than
  the native transport.
- Tests mock each side of the exact integration seam that is failing.

These confirmed defects and diagnostic semantics explain why five prior
attempts could change process, session, or UI behavior without exposing the
actual first-connection failure.

## Environment and topology in the supplied run

The startup log contains two different workers on the same machine:

| Worker                                         | Server                            | Role in this incident                                                         |
| ---------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------- |
| `local-MaxBook-Pro.local`                      | `http://127.0.0.1:4310/`          | Owns the Explorer, Code session, tunnel, and failed direct capability         |
| `desktop-24c1a84b-c8a5-4795-88f7-e176769137b4` | `https://winterhold.cantrip.art/` | Separately embedded desktop worker; not selected for this Explorer attachment |

This split environment makes the combined `devtop` log easy to misread. The
failing attachment is consistently routed to `local-MaxBook-Pro.local`; there
is no evidence in the supplied attempts that the tunnel was sent to the other
worker. The duplicate worker startup and unrelated provider activity are noise,
not evidence of the Code failure.

Relevant runtime facts from the startup log:

- Cantrip `1.1.971`
- Cantrip Code/OpenVSCode Server `1.109.5`
- Cantrip Code build `531efd29c6a7`
- Codex `0.148.0`
- Code workbench bridge listening
- direct capability broker listening
- local worker reports `runtime.codeAvailable=true`

## How the Explorer editor is supposed to mount

There are three related but distinct paths. They should not be diagnosed as if
they were one component.

### Desktop prewarmed popout

The main Explorer window owns the protected attachment and native forward. The
hidden child window initially receives only launch context over a
`BroadcastChannel`.

```text
Explorer view
  -> prewarmDesktopExplorerFile()
  -> create hidden Tauri WebviewWindow
  -> main-window DesktopExplorerWindowBroker
     -> create protected Explorer Code attachment
        -> server code.probe
        -> worker code.open
        -> server stores managed protected tunnel
     -> startDesktopTunnel()
        -> fetch protected data-plane key
        -> create generic desktop attachment with a relay fallback credential
        -> prepare direct capability
        -> bind native 127.0.0.1 listener
        -> authenticate native-to-worker direct WebSocket
        -> activate direct attachment
     -> poll 127.0.0.1:<port>/code/_cantrip/health
     -> send editor.ready to child only after health succeeds
  -> child mounts iframe with the loopback Code URL
  -> child iframe onLoad sends editor.frame-loaded
  -> broker sets editor presentation
  -> broker sends the file-open control request
  -> child reveals the configured editor
```

The important ordering is in
[desktop-explorer-window-broker.ts](../cantrip_app/src/lib/desktop-explorer-window-broker.ts):
`preferProtectedCodeAttachment()` must finish before `editor.ready` is sent,
and the iframe cannot mount until the child receives that message. The current
failure therefore occurs before the popout's Code iframe exists.

The log event `surface.explorer.editor-window.handoff status=ready` only means
the child received its launch context. It does **not** mean the attachment,
tunnel, iframe, workbench, bridge, or file-open operation is ready. The event is
emitted in
[desktop-explorer-file-window.tsx](../cantrip_app/src/components/explorer/desktop-explorer-file-window.tsx)
before an editor attachment has arrived.

### Inline Explorer editor

The in-app `ExplorerCodeEditor` creates its own protected attachment, starts the
same preferred transport, then sends presentation and file-open HTTP requests.
It marks the editor `ready` after those control requests succeed. This is a
separate React lifecycle from the prewarmed popout and has different iframe
readiness behavior.

### Browser transport

Outside Tauri, `preferProtectedCodeAttachment()` uses a service worker and a
browser-side tunnel client instead of a native loopback listener. The server and
worker protected routing are shared, but the browser interception, readiness,
and WebSocket shims are separate. The supplied incident is the Tauri desktop
path, not proof that the browser path is healthy or broken in the same way.

## What the two supplied attempts prove

Two captured attempts reproduce the failure two out of two times. That is
deterministic within the supplied run, although it is fewer than three
independent captures and should not be described as a statistically established
rate.

### Automatic prewarm

The startup log shows:

1. The local worker completes `code.probe`.
2. The Code session starts and process instance
   `aff34096-a620-4193-83aa-5396dd8797a8` becomes ready.
3. `code.session.running` completes in about 411 ms.
4. Protected Code attachment/tunnel
   `4238a929-b785-4bed-b442-1b8804236a31` is created.
5. Generic desktop tunnel attachment
   `6a408c76-2ee9-4fc6-8386-6a3a0fdec0e3` is created.
6. Direct capability `b5220038-1a33-4c63-bd33-1d5cb5faeaeb` is prepared and
   its WebSocket connects.
7. No successful protected Code endpoint or TCP destination event occurs.
8. Readiness cleanup stops the forward, the worker observes close code `1006`,
   the attachments are revoked, and the client records `prewarm-failed`.

### Manual file click

The file-open log repeats the same path with fresh attachment identities:

1. The worker reuses the same process instance
   `aff34096-a620-4193-83aa-5396dd8797a8`.
2. The new Code session reaches `code.session.running` in about 3 ms.
3. Protected Code attachment/tunnel
   `49ae5014-a069-4a41-9c91-05ebc3301562` is created.
4. Generic desktop tunnel attachment
   `dc01fd42-13cf-4ca0-acab-6bcd0e76051e` is created.
5. Direct capability `a945fd0d-03e9-42be-a6b4-4e06407f1890` is prepared and
   connects.
6. Again, no successful protected Code endpoint or TCP destination event
   occurs.
7. Readiness cleanup stops the forward and temporary Code session, and the UI
   reports `Load failed`.

The shared-process change is reusing the intended process identity. It has not
proved that the cached OpenVSCode process is responsive or serving the new
workspace: supervisor reuse performs no HTTP/protocol liveness re-probe.
Repeated process spawning is not the boundary exposed by the current logs,
because even the worker-local `_cantrip/health` response is never reached.

## Exact first missing success boundary

After the direct capability authenticates, the expected first request path is:

1. `waitForDirectCodeAttachmentReady()` fetches
   `http://127.0.0.1:<port>/code/_cantrip/health` in
   [desktop-code.ts](../cantrip_app/src/lib/desktop-code.ts).
2. Tauri accepts the loopback connection and queues an `Open` frame in
   [tunnel_forward.rs](../cantrip_app/src-tauri/src/tunnel_forward.rs).
3. The worker direct broker validates the frame and replaces `Open` with a
   server-authorized protected `Connect` in
   [direct-broker.ts](../cantrip_worker/src/direct-broker.ts).
4. `TunnelDestinationRouter` decrypts and validates the protected record, then
   calls `CodeDirectEndpointManager.prepareProtected()` in
   [tunnel-destination-router.ts](../cantrip_worker/src/tunnel-destination-router.ts).
5. The worker TCP adapter connects to the prepared endpoint and emits
   `tunnel.destination.opening` in
   [tunnel-tcp-adapter.ts](../cantrip_worker/src/tunnel-tcp-adapter.ts).
6. The health request reaches the worker-local Code endpoint.

No attempt emits `code.direct.prepared`, `tunnel.destination.opening`, or
`tunnel.destination.connected`. That proves there is no **successful** protected
route preparation. It does not prove whether the native listener accepted a
connection, because both the native accept and a protected-target rejection are
currently invisible in these logs.

The absence of `direct.frame.rejected` makes a malformed direct data-plane frame
or capability-binding escape less likely: `DirectBroker.#handleDirectFrame()`
logs that condition and closes the direct capability with code `1003`. Neither
occurs here. A protected-target rejection happens later and is silently reduced
to an ordinary `rejected` frame without a worker log.

### Direct and relay routes do not use the same server data path

The server participates in authorization and ticket issuance for both routes,
but the selected direct route then bypasses the server's `TunnelRuntimeManager`,
`TunnelStreamBroker`, and worker-command binary-frame relay:

```text
selected direct route
Tauri native forward -> worker DirectBroker -> worker destination router

relay route
Tauri native forward -> server TunnelRuntimeManager/TunnelStreamBroker
  -> worker command channel -> worker destination router
```

The direct ticket already contains the server-authorized protected target. The
worker direct broker inserts that target when it transforms native `Open` into
worker `Connect`. Therefore missing `tunnel.attachment.active` or server broker
frame metrics are normal for these direct attempts. There is no evidence of a
server worker-bridge multiplexing collision in the supplied run.

## Diagnostic correction: direct route state is narrower than data readiness

`start_tunnel_forward` reports `routeState: "local-direct"` after the direct
broker WebSocket handshake and signature verification. It does not require one
local TCP connection, one accepted data-plane `Open`, one protected-target
validation, or one byte from the Code endpoint.

[desktop-tunnel.ts](../cantrip_app/src/lib/desktop-tunnel.ts) returns that native
summary and then activates the attachment. The separate Code health loop is the
first end-to-end validation.

This creates two distinct readiness layers:

```text
native forward ready = listener bound + route WebSocket authenticated
Code attachment ready = an HTTP request crossed the complete route successfully
```

The current system correctly withholds the Code attachment until the second
layer passes, so this semantic split is not the cause of the failed protected
connection. It is still an essential diagnostic correction: a
`routeState=local-direct` or `direct.capability.connected` event must not be cited
as proof that the data plane, protected target, endpoint, or workbench is ready.

## Confirmed problem 1: connected-but-broken direct routes do not fall back

The native forward has a relay credential available, but it falls back during
direct connection setup only if `connect_verified()` fails. After the direct
WebSocket is established, relay selection is reconsidered only when the entire
direct session disconnects. See the selection and session loop in
[tunnel_forward.rs](../cantrip_app/src-tauri/src/tunnel_forward.rs).

A rejected, closed, or unusable individual local TCP connection merely ends
that connection. It does not mark the direct route degraded. If the direct
WebSocket remains connected, every one of the health retries can fail through
the same route without invoking relay fallback.

That is exactly the failure class compatible with these logs: the control
WebSocket stays connected until the readiness loop destroys the whole forward.
The available relay is never tested as a recovery route.

## Confirmed problem 2: the worker hides the decisive error

`TunnelDestinationRouter.#handleProtectedConnect()` performs all of the
following inside one `try` block:

- protected target/record binding validation;
- protected record decryption;
- server, worker, tunnel, and destination validation;
- Code session lookup and protected endpoint preparation;
- handoff to the TCP adapter.

Its `catch` block in
[tunnel-destination-router.ts](../cantrip_worker/src/tunnel-destination-router.ts)
discards the exception and emits only `target-rejected`. Data-plane decrypt and
seal failures are also caught without the underlying reason.

Consequently, all of these materially different failures look alike:

- wrong or stale worker encryption identity;
- protected record authentication/context mismatch;
- tunnel/worker/session mismatch;
- missing Code session;
- Code endpoint preparation failure;
- unexpected protected target kind.

The source has the exact answer if this branch is failing, but the logs erase it.

## Confirmed problem 3: native and server telemetry miss the attempt

The Tauri forward increments counters when its listener accepts a connection,
but it has no structured event for:

- listener bound;
- local TCP accepted;
- `Open` queued or sent;
- remote `accepted` or `rejected` received;
- connection close reason;
- forward stop reason.

The client reports the counters only every 10 seconds in
[direct-transport-telemetry.ts](../cantrip_app/src/lib/direct-transport-telemetry.ts).
The observed forwards are removed in approximately six seconds. The server then
logs its untouched default counters during revocation:

```text
bytesFromLocal=0 bytesToLocal=0 connectionsOpened=0 connectionsClosed=0
```

Those zeros are not evidence that the WebView never reached the native listener.
They are stale coordinator defaults unless a telemetry report arrived first.

## Confirmed problem 4: readiness retry is not a bounded timeout

`waitForDirectCodeAttachmentReady()` makes 100 fetch attempts with a 50 ms delay
between failures. This creates the observed five-to-six second signature only
while each fetch rejects quickly. Individual fetches have no `AbortSignal` or
deadline, so one accepted but hung connection can make startup wait indefinitely.

The function also retains only the last error and does not log:

- the sanitized local origin and port;
- attempt count or elapsed time;
- whether the result was an HTTP response or a WebKit network exception;
- the native route state and counters at failure;
- whether relay fallback was available.

The prewarm caller does supply `error.message` to `clientLogger`, but supplies it
as a string. The persisted logging minimizer retains structured error metadata
only for object-shaped `context.error`, so the durable log keeps
`reasonCode=prewarm-failed` and drops the useful `Load failed` detail. The Tauri
client also installs a failed-fetch relay, yet neither supplied episode contains
one of those events. That is an additional observability anomaly, not evidence
for a particular network branch.

On failure, `preferProtectedCodeAttachment()` immediately calls
`stopDesktopTunnel()`. Native `stop()` signals and then aborts the forwarding
task without waiting for a WebSocket close handshake. Therefore the worker's
close code `1006` is a teardown consequence in these attempts, not the initiating
connection failure.

The endpoint's `_cantrip/health` handler is also narrower than its name implies.
It returns `200` from `CodeDirectEndpointManager` without consulting
`CodeSupervisor.proxyTarget()` or sending an upstream request to OpenVSCode. A
future successful health response will prove the protected endpoint route, not
that the OpenVSCode workbench is responsive.

## Confirmed problem 5: UI mount readiness is inconsistent and misleading

The existing report overstates some UI evidence.

- The prewarm `handoff ... status=ready` event is only launch-context receipt.
- The inline `ExplorerCodeEditor` iframe has no `onLoad` or `onError` handler.
  Its cover is removed when presentation and file-open control requests succeed,
  even if the iframe itself has not rendered a usable workbench.
- The popout iframe treats any `load` event as a successful workbench frame,
  including an HTTP error document. It has no error-document or workbench-ready
  handshake before resolving `frameLoadedPromise`.
- `DesktopExplorerWindowBrokerOptions.requireDirectBridge` is passed by prewarm
  but never read. It currently enforces nothing.
- Disposing the broker does not reject `frameLoadedPromise`; losing a child
  window after attachment setup but before iframe load can leave `broker.ready`
  pending.

These defects are downstream of the current health failure because the popout
iframe is not mounted yet. They remain real reliability problems that will
matter once the transport proceeds farther.

## Confirmed problem 6: browser readiness can remain falsely healthy

The browser branch returns after `BrowserCodeSession.open()` without the native
health request used by Tauri. Its health predicate in
[browser-code-tunnel.ts](../cantrip_app/src/lib/browser-code-tunnel.ts) checks
only whether the session remains in a module-level `Map`.

`BrowserTunnelClient.#fail()` rejects readiness and fails current connections,
but it does not remove the owning session from that map. A failed WebSocket can
therefore remain `healthy` according to `browserCodeAttachmentHealthy()`.

The service-worker proxy also waits up to 60 seconds for a response in
[cantrip-code-service-worker.js](../cantrip_app/public/cantrip-code-service-worker.js),
with no persisted event proving controller state, interception, request receipt,
or tunnel response. This does not cause the supplied Tauri failure, but it means
browser success cannot be assumed from the shared higher-level code.

## Confirmed problem 7: integration tests stop at the failure seam

Existing tests cover important components independently:

- desktop tunnel setup with mocked Tauri invocation and API calls;
- Code readiness with mocked `fetch()`;
- protected record encryption/decryption vectors;
- direct capability validation;
- worker Code endpoint reuse and control calls;
- native protected frame encoding and relay behavior.

They do not exercise one complete Code request across:

```text
WebView or real loopback TCP client
  -> native forward
  -> direct broker
  -> protected destination router
  -> Code direct endpoint
  -> HTTP health response
```

The broker tests mock `preferProtectedCodeAttachment()`, the desktop Code tests
mock `fetch()`, and no browser Code tunnel test covers failure-state cleanup.
Every local unit can therefore pass while this integration remains unusable.

One legacy integration test is already stale:
[cantrip_worker/test/code-direct-endpoint.test.ts](../cantrip_worker/test/code-direct-endpoint.test.ts)
calls `endpoints.prepare(...)`, but `CodeDirectEndpointManager` exposes only
`prepareProtected(...)`. It is included by the worker Vitest configuration, but
worker tests are excluded from the TypeScript production build. This is direct
evidence that current validation is not reliably exercising this boundary.

## Confirmed problem 8: attachment and capability lifecycles can diverge

These source-level hazards are independent of the current six-second initiating
failure, but they can create future stale or orphaned Code routes:

- Protected connect is launched as detached asynchronous work. It has no
  cancellation generation. If the direct socket closes while protected-record
  decryption or endpoint preparation is pending, the close may be processed
  before the protection or TCP stream exists. A late result can then create a
  destination whose direct capability has already disappeared. Its response
  misses `DirectBroker.routeTunnelFrame()` and falls back to the worker's server
  command channel, but the selected direct path registered no matching server
  relay route; the late destination can therefore become orphaned.
- When the worker direct socket closes, the worker removes its active session,
  but that closure is not synchronized back to the server's general direct
  attachment coordinator. Until explicit cleanup or lease expiry, the server
  can retain a grant that still matches activation metadata.
- The Code tunnel's `idleTtlMs` is not idle activity tracking. `expiresAt` is set
  once at creation and is never touched, so an active editor can be pruned after
  the fixed default 15 minutes.
- Code tunnel removal and direct capability revocation are separately managed,
  and the normal Code DELETE route attempts to revoke using the managed Code
  attachment/tunnel ID. The direct grant is keyed by the different generic
  desktop attachment ID, so that revoke cannot match it. A prune path can also
  delete the managed Code tunnel without a direct coordinator revoke.
- Normal broker disposal starts native-tunnel stop and Code attachment release
  concurrently with `Promise.allSettled()`. If Code deletion cascades the
  generic attachment row first, the concurrent tunnel DELETE can return `404`
  before reaching its correctly keyed coordinator revoke. Because worker socket
  closure is not synchronized back to that coordinator, the server grant can
  survive until its lease expires rather than only for a small ordering window.

These hazards deserve their own lifecycle tests. They should not be used to
claim that the observed health connection failed because of a cleanup race: in
the supplied attempts cleanup begins only after readiness has already failed.

## Confirmed problem 9: the proxy does not enforce workspace binding

This is the highest-severity independent defect found in the audit.

The server-authorized protected record binds the attachment to a Code session,
and the session has a worker-generated workspace URI. However,
`codeEditorTargetUrl()` in
[proxy-utils.ts](../cantrip_worker/src/code/proxy-utils.ts) copies the incoming
query string and injects the bound workspace only when the client did **not**
already supply `workspace` or `folder`.

Both the HTTP and WebSocket Code proxies use that target URL and inject the
shared profile's OpenVSCode connection token. A client that can use its valid
protected attachment can therefore request, for example:

```text
/code/?folder=/another/path
/code/?workspace=/another/workspace.code-workspace
```

The worker then authenticates that client-selected target to the shared
OpenVSCode profile. The proxy path is attachment-scoped, but the workspace query
is not forced to the attachment's bound workspace. Shared profile reuse makes
this more important because one profile/token serves multiple session
workspaces.

This security/isolation flaw does not explain the current pre-health failure;
the observed request never reaches the endpoint. It must nevertheless be
treated as an actual Cantrip Code interaction problem before relying on the
shared editor as a workspace isolation boundary.

## Confirmed problem 10: shared profile/session operations contain races

The worker audit found several high-confidence concurrency and cleanup defects
that are not covered by the current shared-process tests:

- Profile reuse returns immediately on cached `child`, `port`, and `ready`
  fields. `ready` was set by a bare TCP connect and is cleared only on child
  exit; no HTTP, protocol, or workspace liveness re-probe runs on reuse.
- Idle profile eviction checks that the profile has no sessions and then awaits
  termination. A concurrent open can add a session after the check, observe the
  still-populated cached fields while `stopping=true`, and report a session
  running against a child already receiving `SIGTERM`.
- Opens are serialized per session ID, but `stop()` is not part of that queue.
  A stop can remove/unregister a session while an open is awaiting profile or
  workspace work; the open can later add orphan profile membership or return a
  running session without its bridge registration.
- Initial session insertion, bridge registration, profile membership, and the
  first workspace write happen before the open path's cleanup `try` block. A
  failure in that setup region can leave a partial `starting` session and bridge
  registration behind.
- Two concurrent `prepareProtected()` calls can both miss the endpoint map,
  create separate loopback servers, and let the last map write win, leaking the
  earlier untracked server.
- Session stop does not remove its generated session/workspace files. With
  OpenVSCode's five-minute reconnection grace period and a long-lived shared
  process, repeated failed attachments can accumulate workspace artifacts and
  reconnecting extension-host state.
- Upstream HTTP proxy errors become an unlogged `502`, and downstream close
  releases bookkeeping without explicitly destroying the upstream request.

None of these races is established as the initiating cause of the two supplied
attempts. They do show that identical process IDs and three-millisecond open
times are insufficient evidence of a healthy, correctly bound editor session.

## Evidence corrections from the previous report

The following points should replace or qualify claims in the supplied previous
diagnostic report:

1. **The exact millisecond timestamps are not present in the two raw logs.** The
   logs contain coarse `10:38` timestamps and durations. The earlier report's
   precise `15:38:xx.xxx` values may come from a separate persisted JSON log,
   but that provenance is not included in the supplied raw artifacts.
2. **The Explorer `opened -> closed -> opened` burst is React StrictMode effect
   replay.** The main application is wrapped in `StrictMode`; this sequence does
   not show a real user close/reopen or explain capability revocation.
3. **The health loop is a retry budget, not a hard five-second timeout.** A hung
   fetch has no per-attempt deadline.
4. **Zero direct telemetry is inconclusive.** The report interval is longer than
   the failed attachment lifetime.
5. **A missing `frame-loaded` event is expected for this failure.** The prewarm
   iframe cannot mount until transport health succeeds. The inline editor does
   not emit an iframe load event at all.
6. **Only an `OPTIONS` access line for `direct-activate` does not prove that the
   POST is missing.** The route suppresses normal successful access logging; the
   later flow and cleanup are consistent with activation having completed.
7. **No iframe race or file-open failure has been demonstrated.** Those stages
   are downstream and never execute in the failing prewarm path.
8. **The logs do not validate the requested file path.** `code.open` validates
   the worktree directory; the requested file is first checked by a later
   file-open control call, which these attempts never reach. The path is not the
   cause of this pre-health failure, but its validity is still unobserved.

## What is working and should not be retargeted first

The supplied evidence rules out these as the current first blocker:

- Cantrip Code build discovery;
- initial OpenVSCode child launch and TCP-listener detection;
- repeated process spawning (the cached process identity is reused);
- project/worktree resolution;
- initial `code.probe` and `code.open` command delivery;
- protected Code attachment creation at the server;
- generic desktop tunnel attachment creation;
- direct capability preparation and authentication;
- React StrictMode lifecycle replay;
- presentation and file-open control logic as the initiating failure;
- workbench bridge connection as the initiating failure.

`bridgeConnected=false` is expected at this point because the workbench has not
loaded. Reworking the bridge or shared process again will not identify why the
first protected HTTP connection fails. Separately, the shared process still
needs the liveness, isolation, and concurrency corrections described above.

## What remains unproven

The current evidence does **not** establish any of the following:

- that WebKit blocked the loopback request before TCP;
- that Tauri accepted a loopback connection;
- that an `Open` frame reached the worker;
- that protected record decryption failed;
- that worker encryption refresh races changed the record identity;
- that the Code session was missing during protected endpoint preparation;
- that data-plane AES-GCM failed (no source data is read until the destination
  accepts the initial connection);
- that relay transport would succeed if selected;
- that the desktop and local worker split caused a target mismatch;
- that CORS or the successful direct-activation POST is the blocker.

The remaining candidates are intentionally left as candidates. Treating one as
fact before collecting the missing events risks another fix to a downstream or
unrelated layer.

## Minimum evidence required before selecting a fix

The next diagnostic run needs one correlation ID spanning the health attempt and
the following facts, in order:

1. client health attempt started/ended, with elapsed time and normalized error;
2. native loopback connection accepted, with forward/tunnel/connection IDs;
3. native `Open` queued and written to the selected route;
4. direct broker received and routed the `Open`;
5. protected target opened or rejected, with a safe reason code for decrypt,
   binding, session, endpoint, or target-kind failure;
6. native connection received `accepted`, `rejected`, or another close reason;
7. route state and counters captured synchronously before teardown;
8. one forced-relay attempt against the same protected attachment.

That single trace will distinguish:

```text
WebKit/local-network policy
vs native listener/forwarding
vs protected record validation
vs Code endpoint preparation
vs direct-only routing
```

Until that trace exists, the correct diagnosis is: **the first protected Code
connection never becomes usable; the exact initiating branch is hidden by
the native delivery gap, silent protected-target rejection, missing fallback,
and missing diagnostics.**
