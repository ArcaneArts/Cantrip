# Optional workspace package

`cantrip-os-workspaces` is an additive Debian package. Version 0.2.0 provides
its service, local administrative CLI, versioned state, persistent accounts,
and independent desktop sessions. Browser workspace selection follows in the
next cycle. The existing personal desktop works independently.

Build a portable, architecture-independent package from the repository root:

```sh
node cantrip_os/scripts/package.mjs
```

Output: `cantrip_os/artifacts/packages/cantrip-os-workspaces_0.2.0_all.deb`.
The package uses Python's standard library and Debian service helpers. Its build
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
sudo apt install ./cantrip-os-workspaces_0.2.0_all.deb
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
continues throughout. Docker and installed-VM workspace acceptance follows in
cycle 3.

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

VNC currently listens only inside the OS on loopback. These internal ports are
not published from Docker. The next cycle adds browser routing/selection; the
ordinary personal viewer remains at the existing printed URL.

`tests/workspace-sessions.py` runs in a disposable instance. It exercises two
desktops with Chromium, independent buses, root access, saved files, individual
stop/restart, whole-service restart, manager SIGKILL recovery, and a real
conflicting X display. It also verifies a shell-only workspace stays stopped.
