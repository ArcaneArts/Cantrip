# CantripOS foundation

Debian 13 (trixie), IceWM, Chromium, PCManFM, Mousepad, xterm, htop, nano,
and Python 3 (`python3` and `python`). These applications are included in both
Docker and bootable/installed editions through the shared desktop manifest. This is a
standalone OS with optional, removable Cantrip integration packages.

Workspace management is an optional Debian package. Its source, build commands,
and service lifecycle are described in [the package guide](packages/workspaces/README.md).
Build either edition with `CANTRIP_OS_WORKSPACES=0` for the ordinary OS alone;
the default is `1`. Persistent workspace accounts/desktops are available through
the package CLI and the local browser workspace selector.

Phase 3 adds an optional [native execution package](packages/executor/README.md).
The source identity foundation adds server-owned OS attachments, workspace
observations, Linux-owned source records and linked execution bindings. It keeps
guest paths separate from worker-local paths and rejects stale generations.
The [source backend](SOURCES.md) now materializes linked Docker worktrees and
Linux-owned checkouts/worktrees, including explicit Linux dependency overlays.
The [authorized dispatch APIs](DISPATCH.md) and [native runtime adapter](NATIVE_RUNTIME.md)
are available as internal checkpoints, including captured placement for new agent
chats. The [client attachment/selection workflow](PRODUCT_WORKFLOW.md) is available
in Project Settings → CantripOS. Captured Linux agents, files/editor/Explorer,
terminals, the combined Run list, attachments and returned artifact links now use
these bindings. `cantrip-desktop` launches GUI apps on the assigned workspace.
The public Docker/ISO scripts include the optional executor by default. Set
`CANTRIP_OS_EXECUTOR=0` to omit execution and its dependent remote support, or
`CANTRIP_OS_WORKSPACES=0` to build the ordinary OS without integration packages.
Explicit package selections override those defaults. Host-only MCP
Run/worktree/task-creation adapters remain unavailable in Linux sessions; use the
source-aware product workflows. Final distribution acceptance is recorded below.

Phase 4 adds the optional [native desktop package](packages/remote/README.md),
including its protected CUA carrier. Docker/ISO builds include it with the
executor edition by default; `CANTRIP_OS_REMOTE=0` omits it independently.
Version 0.5.0 routes normal agent CUA and previews to the captured Linux desktop,
including scoped clipboard access, physical pointer movement and live resize.
Project Settings → CantripOS → Open desktop now views that workspace inside
Cantrip over WorkerLink, with exclusive **Take control** and **Return to agent**
actions. Stream-candidate comparison and managed service access remain in progress. Native, package and product evidence are
recorded in acceptance.

Phase 3 execution and distribution acceptance is recorded. See [acceptance results](ACCEPTANCE.md)
for the actual tested builds and platform limits. Iterate in Docker first; build
the ISO when you want the same source configuration as bootable media.

From the repository root, with Node 22.13+ (or Node 24) and a running Docker engine:

```sh
pnpm os
```

This builds the current source, starts the Docker desktop, prints connection
information, streams container logs, and watches source changes. Open
<http://127.0.0.1:6080/>. IceWM logs in as `cantrip` automatically with the
Cantrip OLED theme; `sudo` requires no password. Ctrl+C cancels any active build
and stops the desktop, keeping its persistent home. Run `pnpm os` again to return.
Only one foreground launcher may own an instance at a time. Separate instances
need different names **and** different browser/VNC ports.

The viewer reconnects after container replacement. Its black toolbar shows the
Cantrip bolt and a Clipboard button, with status text only while connecting.
Browser fullscreen hides the toolbar using the browser's fullscreen display mode
(and Firefox's native fullscreen flag). Use your browser's fullscreen command,
such as F11 or macOS's fullscreen menu. F11 is reserved for the host browser.
Browser/embedded-webview support varies; an embedded panel may have no native
fullscreen mode. Refresh the page after changes to the viewer HTML/JavaScript;
desktop theme changes appear on automatic reconnect.

Connections printed by the launcher:

- Browser: `http://127.0.0.1:6080/`
- Native VNC: host `127.0.0.1`, port `5900`, no password (TigerVNC syntax: `127.0.0.1::5900`).
- Workspace selector: `http://127.0.0.1:6081/` (optional package)
- Root shell: `docker exec -it cantrip-os bash`
- SSH: no server is enabled in this foundation image.

All published ports bind **only to host loopback**. VNC listens on the container
network so Docker can forward it; this is the same trusted local desktop as the
browser viewer. SSH/Cantrip remote connection management remains future work.

For detached use without a watcher or Ctrl+C ownership:

```sh
node cantrip_os/scripts/os.mjs build
node cantrip_os/scripts/os.mjs up
```

```sh
node cantrip_os/scripts/os.mjs restart  # Same container; retains system changes
node cantrip_os/scripts/os.mjs rebuild  # Build succeeds first, then replace it
node cantrip_os/scripts/os.mjs logs
node cantrip_os/scripts/os.mjs stop
node cantrip_os/scripts/os.mjs reset    # Explicitly DELETE personal home AND workspace data
```

`CANTRIP_OS_NAME` (default `cantrip-os`) selects container/image/volume names;
`CANTRIP_OS_PORT` (default `6080`) selects the browser port;
`CANTRIP_OS_VNC_PORT` (default `5900`) selects native VNC;
`CANTRIP_OS_WORKSPACE_PORT` (default `6081`) selects the workspace selector.
`CANTRIP_OS_MEMORY=4g` sets a 4 GiB container limit without extra swap. Ports are assigned when
creating the container; an ordinary foundation rebuild uses the chosen values.
Instances with linked source mounts retain their ports/resource settings when
rebuilding so their declared container configuration remains intact.
The default named volumes are `cantrip-os-home` and `cantrip-os-workspaces`. Rebuild retains personal home and package workspace data,
including Documents, Downloads, and Chromium profiles. Reset deletes it.
Each container keeps a stable instance hostname. Startup clears only Chromium's
old process-lock files before any browser runs, so a retained profile can open
after container replacement; browser data is preserved.

For the original watcher that deliberately leaves the desktop running on Ctrl+C
(instead of the foreground `pnpm os` lifecycle), run:

```sh
node cantrip_os/scripts/dev.mjs
```

It builds once, then polls the content of manifests, overlays, image recipes,
scripts, viewer assets, optional packages, the native CUA/interaction sources,
and `.dockerignore`. Changes are debounced and builds
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

Paths below are relative to `cantrip_os/`. Keep `pnpm os` running while
editing; after replacement, the existing viewer reconnects at the same URL.

| Change                                      | Source                                                                                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared applications/packages                | `manifests/desktop.packages`                                                                                                                              |
| ISO-only packages, kernel, hardware support | `manifests/iso.packages` and `images/iso/build.sh`                                                                                                        |
| Background color or wallpaper               | `overlays/etc/X11/icewm/prefoverride`; use `DesktopBackgroundColor` or `DesktopBackgroundImage`                                                           |
| IceWM behavior/workspaces/clock             | `overlays/etc/X11/icewm/preferences`                                                                                                                      |
| Application menu                            | `overlays/etc/X11/icewm/menu`                                                                                                                             |
| Taskbar application launchers               | `overlays/etc/X11/icewm/toolbar`                                                                                                                          |
| Theme selection                             | `overlays/etc/X11/icewm/theme`; defaults to `cantrip-oled/default.theme`                                                                                  |
| Theme colors, fonts, window controls        | `overlays/usr/share/icewm/themes/cantrip-oled/` (`default.theme` and text XPM palettes)                                                                   |
| GTK application widgets                     | `overlays/usr/share/themes/CantripOLED/` and `overlays/etc/gtk-3.0/settings.ini`                                                                          |
| Mousepad editor palette                     | `overlays/usr/share/gtksourceview-4/styles/cantrip-oled.xml`; default selection in `overlays/usr/share/glib-2.0/schemas/90-cantrip-oled.gschema.override` |
| Terminal/X11 colors                         | `overlays/etc/X11/Xresources/50-cantrip-oled`; personal `~/.Xresources` wins                                                                              |
| Startup applications                        | Create executable `overlays/etc/X11/icewm/startup`, starting with `#!/bin/sh`; launch long-lived applications with `&`                                    |
| New files/scripts/wallpaper assets          | Put them at their intended system paths beneath `overlays/`                                                                                               |
| Default user, sudo, locale                  | `scripts/configure-system.sh`                                                                                                                             |
| Docker session services                     | `images/oci/start.sh`                                                                                                                                     |
| ISO automatic login                         | `images/iso/overlays/etc/lightdm/lightdm.conf.d/50-cantrip.conf`                                                                                          |
| Browser viewer                              | `viewer/index.html`, `viewer/viewer.mjs`, `viewer/bolt.svg`                                                                                               |

The OLED theme is adapted from the supplied Icewm_Nord_style_small theme, with
its author and GPL license retained alongside the editable sources. DejaVu Sans
replaces the optional NovaMono text font; icons do not depend on that font.
The original wallpaper, oversized optional application icons, alternate assets,
and Debian's other bundled IceWM themes are omitted. The matching GTK theme also covers application interiors, including PCManFM and
Mousepad. Mousepad gets a monochrome source-editor scheme; xterm gets black X11
resources. Chromium launches with dark browser UI (websites still control their
own content). Application icons and terminal ANSI colors retain semantic colors. Both Docker and newly built ISOs get the same theme and default selection.

The `prefoverride` file sets the background to `#000000` after the bundled theme.
Personal files under `~/.icewm` deliberately override system defaults. Inspect
them when a source change does not appear; preserve or remove the specific
personal override as intended. Do not delete the entire home to update defaults.

For a wallpaper, put the image under a system path in `overlays/`, then reference
its guest path from `DesktopBackgroundImage`. For a startup script, preserve its
executable bit in Git (`chmod +x` before committing). An interactive experiment
such as `sudo apt install tree` becomes reproducible by adding `tree` to the
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

## Window movement, resizing, and snapping

IceWM handles this directly; no compositor or extra service runs.

- Drag any edge/corner to resize, including maximized windows. The visible
  outline is one pixel, with a four-pixel grab area and larger corner targets.
- **Alt + right-drag** anywhere in a window resizes it; **Alt + left-drag** moves
  it. Alt is Option on a Mac.
- **Ctrl + Alt + Left/Right/Up/Down** fills that half of the desktop.
- **Ctrl + Alt + Home** restores a maximized window. **Alt + F8**, then arrow
  keys and Enter, resizes without a mouse; Escape cancels.
- Moving windows magnetically snap to nearby screen/window edges. This is
  alignment snapping; use the shortcuts for half-screen tiling.
- Right-click a title bar and choose **Tile** for half- or quarter-screen layouts,
  or **Size**, **Move**, and **Maximize** for individual adjustments. These menus
  also work when the host intercepts keyboard shortcuts.
- Workspace switching uses **Ctrl + Alt + Page Up/Page Down** so it does not
  conflict with the half-screen shortcuts.

Click the remote desktop before using shortcuts. If the host/browser intercepts
one, use the title-bar menu. The desktop menu's **Window controls** entry displays
these instructions inside the OS. Configure behavior in `preferences` and frame
appearance in `themes/cantrip-oled/`.

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

## Quick OLED iteration check

1. Run `pnpm os` and open the printed browser URL. Refresh an already-open viewer
   once to load its new toolbar. Confirm the black desktop, monochrome window
   controls, Cantrip bolt, and working Clipboard dialog.
2. Edit `overlays/usr/share/icewm/themes/cantrip-oled/default.theme` (for example,
   a title font size) or an XPM palette. Watch build/startup logs in the terminal;
   the desktop is replaced and the browser reconnects. Revert the experiment
   when finished. Home files survive; unbaked system changes do not.
3. Enter/exit your browser's fullscreen mode. The toolbar disappears/reappears
   and the remote desktop resizes. An ordinary maximized window keeps the bar.
4. Press Ctrl+C in the `pnpm os` terminal. The desktop disconnects, the container
   stops, and the command exits. Running it again restores the retained home.

If pnpm reports that Node is too old, select an installed supported Node version
(e.g. `nvm use 24`) and rerun. No application/server/worker build is needed.

Server-owned attachment and protected source provisioning are described in the
[dispatch guide](DISPATCH.md); the [product guide](PRODUCT_WORKFLOW.md) covers
agent selection and the connected file, terminal, Run and artifact workflows.
