# Optional workspace package

`cantrip-os-workspaces` is an additive Debian package. Version 0.3.0 provides
its service, local administrative CLI, versioned state, persistent accounts,
independent desktop sessions, and a local browser workspace selector. The existing personal desktop works independently.

Build a portable, architecture-independent package from the repository root:

```sh
node cantrip_os/scripts/package.mjs
```

Output: `cantrip_os/artifacts/packages/cantrip-os-workspaces_0.3.0_all.deb`.
The package uses Python, Debian's noVNC/websockify, and Debian service helpers. Its build
runs in the pinned Debian image, fixes file timestamps/ownership, and uses a
fixed default `SOURCE_DATE_EPOCH`. Rebuilding identical sources with the same
build tools produces identical package bytes. OS apt dependencies still follow
the Debian repositories.

Docker and ISO recipes install this same package through apt. Set
`CANTRIP_OS_WORKSPACES=0` when running `pnpm os`, `os.mjs build/rebuild`, or
`iso.mjs` to omit it; the default is `1`. No personal desktop functionality is
owned by the package. The Docker source watcher includes `packages/`.

On a running OS, using the built package at its actual location:

```sh
sudo apt install ./cantrip-os-workspaces_0.3.0_all.deb
sudo cantrip-workspaces enable
sudo cantrip-workspaces status
sudo cantrip-workspaces service restart
sudo cantrip-workspaces disable
sudo apt remove cantrip-os-workspaces
```

Install an updated `.deb` with `sudo apt install ./path/to/new.deb`. A running
service is stopped for upgrade and restarted; a disabled preference remains
disabled. Reinstalling after removal recovers the retained state. Docker manual
installation requires `enable` (or `service start` if already enabled); normal
container startup starts it automatically. Installed systems use the packaged
systemd unit, also manageable with `systemctl`. CLI disable persists across
reboots/image replacement and stops the service; CLI enable starts it again.

The service uses a root-only Unix control socket. Container startup owns only
a small optional start/stop hook; the Python daemon and package CLI own lifecycle
logic. It holds a live file lock and responds over its socket. Control does not
trust a stale PID file. Start/stop operations serialize across CLI processes.
A stop waits for actual service lock release. Startup/stop errors are reported;
the independent personal desktop continues. Docker service logs go to container
stdout; installed-system daemon logs go to the system journal.

| Path                                           | Purpose                                                |
| ---------------------------------------------- | ------------------------------------------------------ |
| `/etc/cantrip-os/workspaces.json`              | Package configuration, preserved as a Debian conffile  |
| `/var/lib/cantrip-os-workspaces/settings.json` | Versioned enable/disable state                         |
| `/var/lib/cantrip-os-workspaces/`              | Persistent data, reserved for workspace homes/metadata |
| `/run/cantrip-os-workspaces/`                  | Ephemeral socket and service/control locks             |
| `/usr/lib/cantrip-os-workspaces/`              | Package-owned implementation                           |

Package removal and purge retain persistent data. Explicit Docker instance
`os.mjs reset` deletes both its personal home and workspace data volumes; an
ordinary stop/restart/rebuild does not. The workspace volume is named
`<CANTRIP_OS_NAME>-workspaces`. Personal home keeps its existing volume/path.
Unknown state versions fail without changing the stored document.

For a package lifecycle integration test, use a **disposable** running Docker
instance, copy the package to `/tmp/workspaces.deb`, and run
`cantrip_os/tests/package-lifecycle.sh` inside it as root. It installs/removes
and purges the package, verifies data preservation and service state, exercises
unsupported-version handling, and checks that the personal X11/browser desktop
continues throughout. Docker and installed-VM workspace acceptance is recorded in
`cantrip_os/ACCEPTANCE.md`.

## Workspace desktops

```sh
sudo cantrip-workspaces create work
sudo cantrip-workspaces create explore
sudo cantrip-workspaces list
sudo cantrip-workspaces open work
sudo cantrip-workspaces show work
sudo cantrip-workspaces stop work
sudo cantrip-workspaces restart explore
```

Commands return JSON with the workspace ID, account, UID/GID, home, assigned
display, internal loopback VNC port, generation, status, and latest error.
`create` provisions an account/home without starting a desktop. `open` starts
one or returns its already-running session. IDs use up to 24 lowercase letters,
digits, or hyphens and start with a letter. Accounts are named `ctw-<id>`.

Each workspace has its own X server, D-Bus session, runtime directory, Chromium
profile, focus, pointer, clipboard, and home. Members of the package-owned
`cantrip-workspaces` group have unrestricted passwordless sudo. This organizes
one owner's projects; root can intentionally access other workspaces and shared
system packages. Docker's kernel/capability boundary remains the outer boundary.

Homes and the versioned `workspaces.json` registry live in the persistent data
directory. Recorded UID/GID values are restored after container replacement;
existing file trees are not recursively chowned. Conflicting account identities
produce a visible error. Account/group entries remain on package removal, along
with their data, so reinstall can recover them. The optional sudoers conffile is
removed with the package and restored on reinstall.

A normal service restart or image replacement resumes desktops that were
previously active. Created/stopped desktops remain stopped. Restarted desktops
receive a new generation and new processes; open windows are not restored as
live process state. Browser profile files and documents remain on disk.
Disable stops managed sessions while retaining this resume intent.

Each session has a root supervisor that reaps its descendants and cleans them
up on stop or manager death, including applications that detach from their
original parent. Live per-workspace locks serialize replacement. X server
readiness comes from the server's own display notification before any desktop
application is launched. Display/port conflicts fail instead of selecting a
different desktop. See `logs/<id>.log` inside the persistent data directory.

VNC compatibility ports listen inside the OS on loopback and are not published
from Docker. The browser gateway uses a distinct Unix socket and random token
for every desktop generation. Stopped/retired tokens and mismatched workspace
IDs are rejected; a socket from an old generation cannot connect to a replacement.
The ordinary personal viewer remains at its existing printed URL.

`tests/workspace-sessions.py` runs in a disposable instance. It exercises two
desktops with Chromium, independent buses, root access, saved files, individual
stop/restart, whole-service restart, manager SIGKILL recovery, and a real
conflicting X display. It also verifies a shell-only workspace stays stopped.

## Browser access

`pnpm os` prints both the ordinary personal desktop at `http://127.0.0.1:6080/`
and the optional workspace selector at `http://127.0.0.1:6081/`. Create a workspace,
start its desktop, then choose **View desktop** to open its own tab. Direct links
use `/desktop.html?id=<workspace-id>`. A stopped desktop stays stopped until an
explicit Start/Open action; the viewer never substitutes another workspace.
After restart it fetches the selected workspace's current generation and
reconnects. Browser fullscreen hides the toolbar. Clipboard stays per desktop.

The installed edition also supplies a **CantripOS Workspaces** application
launcher (`cantrip-workspaces-viewer`). It opens the local selector in Chromium.
The service binds `127.0.0.1:6081` by default. Docker listens on its container
network so Docker can publish it **only on host loopback**. This is a local,
single-owner administration surface; remote/public access is not configured.
Host/Origin checks and JSON-only mutations reject cross-site requests. GUI
operations support create/start/stop/restart/view; package enable/disable remains
an explicit root CLI operation.

Viewer code and assets are package-owned under `root/usr/share/cantrip-os-workspaces/www/`.
The gateway reuses Debian's noVNC/websockify packages; it does not implement a new
WebSocket protocol. `viewer_bind` and `viewer_port` are configurable in the Debian
conffile. The CLI remains usable if the optional gateway cannot bind its port;
service status reports the gateway as starting/running/failed and logs its error.

`CANTRIP_OS_WORKSPACE_PORT` selects the Docker host port (default 6081).
`CANTRIP_OS_MEMORY=4g pnpm os` creates a desktop limited to 4 GiB with no additional
swap allowance. These settings apply on container creation/rebuild. Package
source edits participate in the same watched build/reconnect loop as OS themes.
The watcher reports build and container logs; session-specific application logs
remain under the persistent `logs/` directory.

Integration checks from the repo root:

```sh
CANTRIP_OS_TEST_URL=http://127.0.0.1:6081 node cantrip_os/tests/viewer-gateway.mjs
CANTRIP_OS_TEST_IMAGE=cantrip-os:dev node cantrip_os/tests/resource-profile.mjs
```

The first uses a disposable workspace named `gateway-test`, tests real RFB
handshakes, target/generation rejection and local-origin controls, and stops
that workspace afterward. The second creates/removes its own disposable
container and anonymous data volumes, records five samples per stage under a
4 GiB limit, and writes `cantrip_os/artifacts/phase2/resources.json`. Neither
command is a fake-backend substitute for the recorded browser/VM acceptance.
