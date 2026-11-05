# Optional native desktop package

`cantrip-os-remote` 0.4.0 supplies the Linux X11 `cantrip-cua` helper and a
workspace-bound protected stdio carrier. It depends on the existing workspace
and executor packages. Removing it leaves those packages, ordinary desktops,
and workspace files available. No Worker, conversation database, scheduler,
or model-provider credentials are installed in the guest.

The Worker routes normal agent CUA and human previews to their captured Linux
placement. The MCP client, turn authorization and provider credentials stay on
the Worker. Project Settings → CantripOS → Open desktop supplies integrated
viewing through the existing encrypted Remote Desktop/WorkerLink path, sharing
the same guest helper with agents. Viewing remains available after an agent
retires, and closing a viewer does not cancel the agent. Human takeover and
managed SSH/SFTP/VNC/TCP access require the following Phase 4 cycles. The
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
