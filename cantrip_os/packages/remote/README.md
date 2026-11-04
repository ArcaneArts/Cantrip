# Optional native desktop package

`cantrip-os-remote` 0.1.0 supplies the Linux X11 `cantrip-cua` helper and a
workspace-bound protected stdio carrier. It depends on the existing workspace
and executor packages. Removing it leaves those packages, ordinary desktops,
and workspace files available. No Worker, conversation database, scheduler,
or model-provider credentials are installed in the guest.

This is the Phase 4 package/carrier foundation. Real-agent admission, integrated
Remote Desktop/takeover, clipboard APIs and managed SSH/SFTP/VNC/TCP access still
require the following Phase 4 cycles. The independent local workspace viewer
continues to work.

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
generation. `connect WORKSPACE --expect '<exact descriptor JSON>'` validates that
complete descriptor before forwarding binary CUA frames. It does not start a
replacement desktop or discover another display. `close` retires that workspace's
CUA connection; it does not stop its desktop or independent shell processes.

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
transport file using the existing SSH transport fields. These tests explicitly
authorize their disposable display; they do not claim real-agent product
permission admission. See the acceptance record for executed results.
