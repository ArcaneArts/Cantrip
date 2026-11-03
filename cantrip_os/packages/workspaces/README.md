# Optional workspace package

`cantrip-os-workspaces` is an additive Debian package. Cycle 1 provides its
service, local administrative CLI, versioned state, and package lifecycle.
Persistent accounts, independent desktop sessions, and workspace selection
follow in the next cycles. The existing personal desktop works independently.

Build a portable, architecture-independent package from the repository root:

```sh
node cantrip_os/scripts/package.mjs
```

Output: `cantrip_os/artifacts/packages/cantrip-os-workspaces_0.1.0_all.deb`.
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
sudo apt install ./cantrip-os-workspaces_0.1.0_all.deb
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
cycle 3; this foundation does not claim independent desktops yet.
