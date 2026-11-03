# CantripOS foundation

Debian 13 (trixie), IceWM, Chromium, PCManFM, Mousepad, and xterm. This is a
standalone OS testing environment; Cantrip integration comes later.

The first personal-testing checkpoint is ready. See [acceptance results](ACCEPTANCE.md)
for the actual tested builds and platform limits. Iterate in Docker first; build
the ISO when you want the same source configuration as bootable media.

From the repository root, with Node 22+ and a running Docker engine:

```sh
node cantrip_os/scripts/os.mjs build
node cantrip_os/scripts/os.mjs up
```

Open <http://127.0.0.1:6080>. IceWM logs in as `cantrip` automatically. Use the
bottom-left menu to open applications. `sudo` requires no password. The noVNC
viewer retries after disconnect and supports resize, fullscreen, and a text
clipboard dialog. Only the browser service is published, on host loopback.

```sh
node cantrip_os/scripts/os.mjs restart  # Same container; retains system changes
node cantrip_os/scripts/os.mjs rebuild  # Build succeeds first, then replace it
node cantrip_os/scripts/os.mjs logs
node cantrip_os/scripts/os.mjs stop
node cantrip_os/scripts/os.mjs reset    # Explicitly DELETE this desktop's home
```

`CANTRIP_OS_NAME` (default `cantrip-os`) selects container/image/volume names;
`CANTRIP_OS_PORT` (default `6080`) selects the localhost port when creating it.
The default named volume is `cantrip-os-home`. Rebuild retains this home,
including Documents, Downloads, and Chromium profiles. Reset deletes it.
Each container keeps a stable instance hostname. Startup clears only Chromium's
old process-lock files before any browser runs, so a retained profile can open
after container replacement; browser data is preserved.

For automatic source changes → image build → desktop replacement → browser
reconnect, run:

```sh
node cantrip_os/scripts/dev.mjs
```

It builds once, then polls the content of manifests, overlays, image recipes,
scripts, viewer assets, and `.dockerignore`. Changes are debounced and builds
are serialized; edits arriving during a build queue another build. Manual
lifecycle commands share the instance lock even across Git worktrees. Actual
build failures leave the running container untouched; fix the source and the
next edit retries. Generated artifacts, logs, caches, Git internals, and user
data are excluded. Ctrl+C stops watching and leaves the desktop running.

Change packages in `manifests/desktop.packages`; change menu, toolbar, background
color, and desktop defaults under `overlays/etc/X11/icewm/`. Executables belong under
`overlays/usr/local/bin/`. Source-managed defaults remain in `/etc/X11/icewm` and
are refreshed with the image. Personal `~/.icewm` overrides take precedence;
remove the relevant personal override to see a changed system default. We do
not copy defaults into persistent home files on every startup.

## Customizing the desktop

Paths below are relative to `cantrip_os/`. Keep `scripts/dev.mjs` running while
editing; after replacement, the existing viewer reconnects at the same URL.

| Change                                      | Source                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Shared applications/packages                | `manifests/desktop.packages`                                                                                                         |
| ISO-only packages, kernel, hardware support | `manifests/iso.packages` and `images/iso/build.sh`                                                                                   |
| Background color or wallpaper               | `overlays/etc/X11/icewm/prefoverride`; use `DesktopBackgroundColor` or `DesktopBackgroundImage`                                      |
| IceWM behavior/workspaces/clock             | `overlays/etc/X11/icewm/preferences`                                                                                                 |
| Application menu                            | `overlays/etc/X11/icewm/menu`                                                                                                        |
| Taskbar application launchers               | `overlays/etc/X11/icewm/toolbar`                                                                                                     |
| Theme selection                             | Create `overlays/etc/X11/icewm/theme`, e.g. `Theme="icedesert/default.theme"`; installed themes are under `/usr/share/icewm/themes/` |
| Startup applications                        | Create executable `overlays/etc/X11/icewm/startup`, starting with `#!/bin/sh`; launch long-lived applications with `&`               |
| New files/scripts/wallpaper assets          | Put them at their intended system paths beneath `overlays/`                                                                          |
| Default user, sudo, locale                  | `scripts/configure-system.sh`                                                                                                        |
| Docker session services                     | `images/oci/start.sh`                                                                                                                |
| ISO automatic login                         | `images/iso/overlays/etc/lightdm/lightdm.conf.d/50-cantrip.conf`                                                                     |
| Browser viewer                              | `viewer/index.html`                                                                                                                  |

The `prefoverride` file applies background settings after the bundled theme.
Personal files under `~/.icewm` deliberately override system defaults. Inspect
them when a source change does not appear; preserve or remove the specific
personal override as intended. Do not delete the entire home to update defaults.

For a wallpaper, put the image under a system path in `overlays/`, then reference
its guest path from `DesktopBackgroundImage`. For a startup script, preserve its
executable bit in Git (`chmod +x` before committing). An interactive experiment
such as `sudo apt install htop` becomes reproducible by adding `htop` to the
shared package manifest. System-file experiments belong in overlays or the
system configuration script.

Interactive `apt install` and system changes survive restart, but disappear
when the container is replaced. Promote experiments into manifests/overlays
to preserve them. Ordinary rebuild never deletes home data. Chromium runs as
the desktop user; its launcher disables Chromium's inner sandbox in Docker
because this edition uses Docker as its outer boundary.

The Docker image pins its Debian base digest; apt installs current packages
for the pinned trixie release. It runs the OS userspace on Docker's kernel.
Bootable-media build and testing instructions follow below.
See [the product plan](../docs/CANTRIP_OS.md).

## Bootable ISO

```sh
node cantrip_os/scripts/iso.mjs
node cantrip_os/scripts/vm.mjs  # Requires QEMU; boots ISO with a retained test disk
```

This builds AMD64 live media using Debian live-build inside an AMD64 Linux
builder. On an ARM host Docker emulation is used, so the build takes longer.
The builder uses `--privileged` for live-build's chroot mounts, a dedicated
`cantrip-os-iso-build` volume and an artifact output mount. Source inputs are
snapshotted into the builder image so edits during a build cannot change its
running scripts.
It never receives the host Docker socket or home directory. The desktop
container itself does not run privileged.

Outputs are `cantrip_os/artifacts/cantrip-os-amd64.iso`, its SHA-256 checksum,
and the installed package inventory. Boot it in an AMD64 VM with 4 GiB RAM,
a graphical display, and a disposable disk (at least 12 GiB recommended).
The live desktop logs in as `cantrip` automatically with passwordless sudo.

The live session is temporary. To preserve system customization, install it
onto the disposable disk. From its terminal:

```sh
lsblk
sudo cantrip-install --erase /dev/vda
```

**That command erases every partition/file on the named disk.** Select the
actual VM test disk from `lsblk`; its name may differ. The installer rejects
mounted target disks, copies the current live system including customization,
and installs BIOS and removable UEFI bootloaders. Shut down, remove the ISO,
and boot the disk. Automatic graphical login and passwordless sudo remain.
Use `node cantrip_os/scripts/vm.mjs --installed` to boot the retained QEMU disk
without the ISO. Its path is `cantrip_os/.state/cantrip-os-test.qcow2`.
Add `--headless` to use VNC at `127.0.0.1:5901` instead of a native window,
with serial and monitor sockets in `cantrip_os/.state/`. Only one test VM may
use this disk/port at a time.
This is a simple whole-disk installer; dual boot and custom partitioning are
outside this foundation. The Applications menu includes installation guidance.

The Docker watcher does not automatically build an ISO or upgrade an installed
VM. Run `iso.mjs` explicitly, then boot the new ISO to inspect it. Reinstalling
with `--erase` replaces the selected disk; keep personal data elsewhere first.

The build volume is a disposable ISO build/cache, separate from desktop home
data. When no ISO build is running, `docker volume rm cantrip-os-iso-build`
removes that cache. Rebuilding then downloads/recreates it. Generated artifacts
and the retained QEMU disk are ignored by Git; preserve any desired copies
before removing them manually.
