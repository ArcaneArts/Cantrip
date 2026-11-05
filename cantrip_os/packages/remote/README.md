# Optional native desktop package

`cantrip-os-remote` 0.6.0 supplies the Linux X11 `cantrip-cua` helper and a
workspace-bound protected stdio carrier. It depends on the existing workspace
and executor packages. Removing it leaves those packages, ordinary desktops,
and workspace files available. No Worker, conversation database, scheduler,
or model-provider credentials are installed in the guest.

The Worker routes normal agent CUA and human previews to their captured Linux
placement. The MCP client, turn authorization and provider credentials stay on
the Worker. Project Settings → CantripOS → Open desktop supplies integrated
viewing through the existing encrypted Remote Desktop/WorkerLink path, sharing
the same guest helper with agents. Viewing remains available after an agent
retires, and closing a viewer does not stop the desktop. **Take control** obtains
an exclusive guest CUA lease; **Return to agent** releases human input before
fresh agent calls can continue. Managed SSH/SFTP/VNC/TCP access requires the
following Phase 4 cycles. The
independent local workspace viewer continues to work.

From the repository root:

```sh
node cantrip_os/scripts/remote-package.mjs
CANTRIP_OS_ARCH=amd64 node cantrip_os/scripts/remote-package.mjs
pnpm os
CANTRIP_OS_REMOTE=0 pnpm os
```

Packages are written to `cantrip_os/artifacts/packages/` with architecture-specific
names. Both Docker and ISO recipes include remote support by default when the
executor edition is selected. `CANTRIP_OS_REMOTE=0` omits it. Selecting
`CANTRIP_OS_EXECUTOR=0` also defaults remote support off, while
`CANTRIP_OS_WORKSPACES=0` defaults all integration packages off. Explicit
selections win; apt reports incompatible dependencies. Building from source uses
a pinned Rust compiler, locked dependencies and BuildKit caches. Each package
contains source/binary hashes and dependency licenses.

Inside an attached, disposable CantripOS:

```sh
sudo cantrip-remote enable
sudo cantrip-remote status
sudo cantrip-remote open work
sudo cantrip-remote show work
sudo cantrip-remote close work
sudo cantrip-remote disable
sudo apt remove cantrip-os-remote
```

`open` deliberately opens the selected workspace desktop. `show` only observes
it. Both return the canonical instance, owner/Worker attachment, executor-manager
generation, workspace account/display, desktop generation and remote-service
generation. The Worker supplies `open --expect-placement '<captured placement>'`
so an outdated placement cannot start a desktop. `connect WORKSPACE --expect
'<exact descriptor JSON>' --connection-id UUID` validates the complete descriptor
before forwarding binary CUA frames. It does not start a replacement desktop or
discover another display. The Worker's scoped `close` includes that descriptor
and connection ID, so delayed cleanup cannot close a newer connection.
Administrative `close WORKSPACE` deliberately retires that workspace's CUA
connection; neither form stops its desktop or independent shell processes.

New Linux agents inherit the account's computer-use policy. Once enabled, discover
`cantrip_cua/js` and follow its Linux instructions: inventory the assigned display,
attach its exact ID/generation, then use screenshots and input. Launch applications
with `cantrip-desktop` through the ordinary Linux shell. Full-display access to
this explicit guest target does not require the Host Cantrip-window grant. A
missing package or stale placement reports an error without selecting Host.

Version 0.3.0 adds assigned-desktop UTF-8 clipboard access, physical pointer
motion and live RandR resize through the same authorized CUA session:

```js
await cua.movePointer({ x: 321, y: 234 });
await cua.writeClipboard("日本語 café 🦀");
const text = await cua.readClipboard();
await cua.pasteText("A paragraph with many different Unicode characters");
await cua.resizeDesktop(1280, 720);
await cua.snapshot();
```

`movePointer` posts actual motion on Linux; `moveCursor` remains logical
presentation. Clipboard and resize use the existing native interaction grant,
not an inventory/capture-only grant. Text is limited to 1 MiB UTF-8; final
JavaScript output retains its existing 32 KiB limit, so compare or slice large
clipboard values before returning them. `pasteText` replaces the guest clipboard
and sends Control+V to the focused application; it leaves that clipboard content
in place. Clipboard selections belong to the desktop/helper lifetime and can
disappear when their owning helper closes. Reading an unavailable selection
reports an error. Binary/HTML clipboard formats are not provided.

Resize uses a mode supported by the selected X server, such as 1280×720 or
1920×1080 on the workspace TigerVNC server. It updates geometry without changing
the desktop identity or restarting applications. Unsupported modes report the
actual operation failure; no other display is substituted. The package adds
Debian's small `xclip` utility and uses `xrandr` from `x11-xserver-utils`. Utilities
receive the explicitly selected display; clipboard text travels only over pipes.
Host backends reject these Linux operations without touching the Host clipboard
or pointer.

The Worker uses `remoteControl` and `remoteCommand` from its OS connection module.
Local Docker uses non-TTY root `docker exec -i`; installed systems use strict
host-verified SSH with passwordless sudo and agent forwarding disabled. Private
SSH keys remain on the Worker. This protected administrative carrier is distinct
from the managed SSH/SFTP product feature still being implemented.

The root-only control socket lives under `/run/cantrip-os-remote`. Each connection
has a root lifetime guardian; the native helper runs with the assigned workspace
UID/GID, home and explicit display, with a restricted inherited environment.
Readiness uses a separate inherited pipe after the helper actually connects to X,
leaving native request numbering untouched. The carrier is bounded, opaque and
does not record or replay input. There is one native connection per desktop;
multiple participants are multiplexed by the owning Worker service.

Carrier EOF, manager death, desktop retirement, owning package-service death or
attachment change closes the old connection. Cleanup releases held native input.
Actual service peer pidfds and workspace-generation state supply lifecycle
observation without polling a potentially busy administrative request queue.
A fixed X connection never reconnects to a replacement desktop.

Docker invokes package-owned start/stop hooks. Installed systems use the packaged
systemd unit. Configuration is `/etc/cantrip-os/remote.json`; enable preferences
and diagnostics default to
`/var/lib/cantrip-os-workspaces/integrations/remote`, inside the existing workspace
volume. No additional Docker data volume is needed. Disable, remove and purge
retain this data and preference. Instance reset deletes the workspace volume,
including remote state. Unknown saved-state versions fail without overwriting it.

Run the opt-in destructive lifecycle test only in an explicitly disposable,
attached guest with `cua-a` and `cua-b` workspaces and a copied package:

```sh
sudo python3 remote-package.py --package /tmp/remote.deb
```

The source is `cantrip_os/tests/remote-package.py`. It checks actual capture,
held-input cleanup, desktop retirement, stale generations and package lifecycle.
The actual Worker-service test uses:

```sh
CANTRIP_OS_CUA_TEST_CONTAINER=disposable-container \
  pnpm --dir cantrip_worker exec vitest run test/os-cua.integration.test.ts
```

For an installed guest set `CANTRIP_OS_CUA_TEST_TRANSPORT` to a Worker-local JSON
transport file using the existing SSH transport fields. The second case exercises
the real packaged SDK through HTTP MCP, turn authorization and placement routing,
and asserts that the Host helper never launches. Its admitted turn is a fixture;
real-provider product acceptance is recorded separately in the acceptance guide.

Version 0.4.0 pins saved viewers to the observed desktop generation. Opening a new
view starts or observes its actual assigned desktop before the Server saves its
identity. Reconnecting a saved view cannot start or follow a replacement desktop.
A retired view can be closed; use **Open desktop** to explicitly create a new view.
Incomplete captures remain readable for cleanup but cannot acquire a viewer.

Version 0.5.0 adds remote input participants for the explicitly assigned Linux
monitor. Host displays remain view-only under this participant contract. The
Worker pauses guest agent CUA, cancels queued/current scripts and native input,
and waits for cleanup before admitting the human participant. A second viewer
cannot take or return another viewer's lease. Shell processes remain independent.

Human input uses a fresh attachment epoch and increasing event sequence. Return,
viewer disconnect, or explicit surface suspension releases held input before
ending the lease. Reconnecting requires a fresh takeover. Canceled or uncertain
input is never replayed; after return the agent must make a fresh authorized call
and attach again. Its live turn authorization is retained. Unconfirmed cleanup
retires the helper instead of handing off input. The lease is transient Worker
runtime state authorized by the Server's existing captured-surface WorkerLink
grant, rather than a new durable placement or a guest-side scheduler.

## Protected service carrier (0.6.0)

The package also carries SSH/SFTP, VNC and guest-loopback TCP streams over the
same root-only administrative transport. This is the guest foundation; the
Cantrip-managed tunnel UI and authorization adapter are a subsequent cycle.
No public SSH listener or replacement system SSH configuration is installed.

```sh
sudo cantrip-remote service-info work --service '{"kind":"ssh"}'
sudo cantrip-remote service-info work --service '{"kind":"tcp","port":3000}'
sudo cantrip-remote service-info work --service '{"kind":"vnc"}'
```

`service-info` returns a captured descriptor, including the owner/Worker,
instance, executor generation, workspace account and remote-service generation.
Use `--expect-placement` with the captured eight-field placement when admitting
the service. It observes identity rather than guessing whether a port is ready.
The actual connection reports connection refusal or an unavailable desktop.
SSH and TCP do not start or depend on the desktop. VNC requires a running
workspace desktop and captures its generation; it uses that desktop's private
Unix socket, never the personal console or a replacement desktop.

`service-connect WORKSPACE --expect '<descriptor>' --connection-id UUID`
forwards opaque bytes on stdin/stdout. SSH additionally requires `--public-key
'ssh-ed25519 BASE64'`: one public key without options or comments. The client
private key stays outside this package. The descriptor's `ssh_host_key` must be
pinned by the client. SSH logs in as the descriptor's exact workspace user, with
normal unrestricted sudo. SFTP uses OpenSSH's internal subsystem. Passwords,
other accounts, agent forwarding and SSH's own forwarding are disabled for this
connection; explicit Cantrip service routes remain independently scoped.

The private OpenSSH binaries are copied from Debian's `openssh-server` package
at build time, with its version, hashes and copyright retained under
`/usr/lib/cantrip-os-remote/openssh`. Its system service is not installed. Rebuild
and upgrade the Cantrip package/image to receive updates to these bundled
binaries. PAM retains Debian account policy and a package-owned `pam_unix`
session, keeping processes in the remote service lifetime instead of moving
them into independent logind scopes. Existing system SSH configuration is left
to its ordinary package.

Each service has its own root guardian and connection UUID, independent of
CUA and other service streams. Forwarding uses bounded buffers and supports
TCP half-close, including a reply after stdin EOF. Actual package peer pidfds,
the root carrier process lifetime, and canonical workspace/attachment state
retire obsolete connections. Service stop/disable/removal also closes streams
and reaps SSH descendants. `service-close WORKSPACE --expect '<descriptor>'
--connection-id UUID` retires only that exact connection. The persistent
root-owned SSH host key and workspace files survive disable/remove/reinstall.

For destructive acceptance in a disposable attached guest:

```sh
sudo python3 remote-services.py --workspace cua-a --other-workspace cua-b
```

The test uses real SSH/SFTP clients, a binary TCP server, VNC 3.8 negotiation,
actual process pidfds and service retirement. It does not substitute direct
guest ports for the protected carrier.

## Managed TCP readiness (0.7.0)

`service-connect --notify-ready` writes one fixed
`CANTRIP_OS_SERVICE_READY <connection UUID>` line to stderr after the actual guest
connection succeeds. Binary stdin/stdout is unchanged. Cantrip's Worker waits
for this receipt before accepting a managed TCP stream; a refused port reports
the real connection failure. Ordinary administrative callers may omit the flag.

Cantrip's tunnel configuration now offers captured Linux workspaces alongside
Host destinations. The Server admits the source and pins a hash of the observed
service descriptor for that attachment. The Worker retains it through the
signed WorkerLink grant, decrypts and compares the saved destination, and opens
the exact guest stream. The existing encrypted tunnel data plane, bounded
credits and duplex half-close carry its bytes. No Host loopback proxy substitutes
for a guest connection. See the product workflow for setup and restart behavior.

Actual transport acceptance runs with either fixture mechanism from above:

```sh
CANTRIP_OS_CUA_TEST_CONTAINER=disposable-container \
  pnpm --dir cantrip_worker exec vitest run test/os-tunnels.integration.test.ts --maxWorkers=2
```

The opt-in app test `src/lib/os-tunnel.product.integration.test.ts` additionally
uses a disposable private Server/Worker profile, its existing recovery artifact,
and saved encrypted Host/Linux routes. It exercises actual API admission,
WorkerLink grants and relay traffic. Keep that artifact private; this test never
installs account keys or model credentials in the guest. Its two same-port
services return different proof text so Host substitution fails visibly.

## Managed SSH/SFTP product access

The same 0.7.0 guest package supports the subsequent SSH/SFTP tunnel adapter.
Choose an SSH service in Cantrip's per-route Linux destination form and supply
one public key. The Worker compares its encrypted source capture with canonical
Server admission, observes the actual SSH account/host key and pins that service
identity for the attachment. Every client connection receives its own private
inetd SSH process through `service-connect --public-key`; no new guest listener
or system SSH configuration is installed.

The desktop client retains a generation-bound temporary public host pin for its
local forward and supplies strict SSH/SFTP commands. Its private key remains in
the user's normal SSH client. Managed SSH is independent of desktop lifetime and
uses the workspace account's normal unrestricted sudo. Package lifecycle cleanup
remains the existing remote-service cleanup.

`test/os-ssh.integration.test.ts` exercises the real Worker preparation, protected
record, guest connection, OpenSSH authentication and SFTP on either guest fixture.
The opt-in App test `src/lib/os-ssh.product.integration.test.ts` additionally
creates the actual saved encrypted route and uses real Server API/WorkerLink relay
admission. Its disposable client keys and account recovery material stay on Host.


## Managed VNC product access

The unchanged 0.7.0 guest package also supports Cantrip's managed VNC adapter.
Choose **VNC desktop** for a captured Linux destination in Project Settings →
Tunnels. The Worker observes the actual running desktop, pins its generation in
the service identity and opens `service-connect` through the existing encrypted
WorkerLink route. A VNC client receives a Native-app loopback host/port without
publishing another guest listener.

The Worker shares its existing CUA service with the agent and integrated viewer.
VNC acquires an exclusive human-control owner before service admission; held
agent input is canceled/released, competing controllers are refused and other
workspaces continue. Retirement requires `service-close` confirmation before
returning the lease. If cleanup fails, only an actual placement-verified changed
manager/desktop descriptor can fence the old helper and release the stale lease.
Unavailable or unchanged observations leave the lease blocked. The package's
VNC socket closes release held keys/buttons, including abrupt manager death.

Opt-in real Worker/package acceptance:

```sh
CANTRIP_OS_CUA_TEST_CONTAINER=<disposable-container> \
  pnpm --filter @cantrip/worker exec vitest run test/os-vnc.integration.test.ts --maxWorkers=1
```

For an installed VM use `CANTRIP_OS_CUA_TEST_TRANSPORT` with the established
SSH transport JSON. The tests exercise real RFB 3.8 pixels, native agent/VNC
handoff, physical held-input cleanup, other-workspace independence and actual
remote-manager replacement. Use disposable fixtures: the replacement test
restarts their remote-access service.
