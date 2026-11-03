# CantripOS foundation acceptance

Verified on 2026-11-03. This checkpoint is for the owner's personal OS testing
and customization before Cantrip integrations.

## Builds and environment

- Debian 13/trixie, IceWM 3.7.4, Chromium 156.0.8078.79, Linux
  6.12.115+deb13.1-amd64 in the bootable edition.
- Native ARM64 Docker build/run on macOS with Docker Engine 27.4.0.
- AMD64 ISO built through `node cantrip_os/scripts/iso.mjs` using Docker's AMD64
  emulation, shared manifests/overlays, and Debian live-build.
- QEMU 11.1.3 with 4 GiB RAM and a disposable 16 GiB qcow2 disk. Installed-disk
  boot tested under both BIOS and EDK2 UEFI, with the ISO removed.
- Exported ISO: approximately 1.3 GiB, with package inventory and a SHA-256 file.
  The verified artifact's SHA-256 is
  `1615a9e8a00c5ae004371ba99ac677f7c055f91357352e63813e6e599afb8e44`.

## Actual runtime results

| Requirement                 | Evidence/result                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker desktop              | Built and started the native image; browser displayed the real IceWM desktop at `http://127.0.0.1:6080`                                                                               |
| Automatic entry             | Docker, live ISO, and installed OS entered the default user's IceWM session without credentials or project selection                                                                  |
| Applications                | Chromium, PCManFM, and xterm launched; a command entered through noVNC returned root identity; Mousepad is installed in the shared package set                                        |
| Root and package management | `sudo -n id` returned UID 0; installed and ran Debian's `hello` package interactively; restart retained it                                                                            |
| Keyboard/pointer/clipboard  | Operated the desktop menu, typed a terminal command, and pasted text from the browser clipboard dialog into xterm                                                                     |
| Resizing/software rendering | The virtual display resized with the browser; Docker and plain virtual VGA worked without GPU passthrough                                                                             |
| Browser profile replacement | Navigated Chromium to `example.com`, replaced the container while it ran, then verified the real History entry remained and Chromium reopened without the old-host profile-lock error |
| Browser reconnect           | The same open viewer reconnected after multiple container replacements without credentials, endpoint changes, or refresh                                                              |
| Watched source change       | Changed the source-managed desktop background; the watcher rebuilt/replaced the container and the changed background appeared                                                         |
| Build failure               | A deliberately nonexistent package caused a real apt build failure; the previous container ID remained running with its saved document                                                |
| Recovery                    | Restoring the package manifest triggered a successful replacement and retained the saved document                                                                                     |
| Changes during build        | Edited an overlay during a deliberately slowed build; a queued second build applied the newer source                                                                                  |
| Exclusions                  | A generated `.state` log did not trigger a rebuild                                                                                                                                    |
| Lifecycle serialization     | Concurrent lock clients serialized; a subsequent invocation recovered an abandoned lock after its actual owner exited                                                                 |
| Source defaults and home    | Defaults stayed in the image, the changed background applied, and `/home/cantrip/Documents/persistence-check.txt` survived replacement                                                |
| ISO boot                    | The exact final export automatically selected the live system after the timeout and logged into IceWM without menu input                                                              |
| ISO runtime                 | Live Chromium rendered, network HTTPS access succeeded, and passwordless sudo worked                                                                                                  |
| Installation                | The installer shipped in the final ISO erased only the selected VM disk, copied the live system, installed both GRUB targets, and unmounted its target                                |
| Installed BIOS boot         | The documented VM command booted the disk without the ISO; root was `/dev/vda3`, automatic GUI login worked, and `installed-from-final-iso` remained in Documents                     |
| Installed UEFI boot         | EDK2 booted the same disk; `/sys/firmware/efi` existed, root was `/dev/vda3`, IceWM ran, and the saved file and passwordless root remained available                                  |
| Lifecycle commands          | A disposable second instance passed restart, stop/start, and explicit reset; reset removed its container/home volume while the primary desktop document remained intact               |
| Artifact integrity          | `shasum -a 256 -c cantrip-os-amd64.iso.sha256` passed                                                                                                                                 |

The installer uses a private mount namespace because testing found that
systemd-udevd and systemd-logind could otherwise retain propagated target mounts.
`grub2-common` is explicit in the ISO package list because platform modules alone
do not supply `grub-install`. Both fixes were included in the final built ISO
and its successful installation/reboot test.

## Delivery and limits

- [Foundation PR #2468](https://github.com/ArcaneArts/Cantrip/pull/2468).
- [Development loop PR #2469](https://github.com/ArcaneArts/Cantrip/pull/2469).
- [Bootable media PR #2470](https://github.com/ArcaneArts/Cantrip/pull/2470).

Node/shell syntax, scoped Prettier checks, and `git diff --check` passed for the
implementation. Full Cantrip application tests were not run: the foundation is
a standalone subproject and does not integrate the app/server/worker runtimes.

Physical hardware, Secure Boot, cloud provisioning, native AMD64 Docker runtime,
and ARM64 bootable media remain unverified. The distribution release and Docker
base digest are pinned; apt package versions follow the trixie repositories, so
future builds are not claimed to be byte-identical. The installer is whole-disk,
not a dual-boot or custom-partition installer. Docker system-layer changes need
source promotion or explicit export to survive recreation; home data persists
separately. Live ISO changes are temporary until installed or otherwise saved.

Single-user passwordless testing is intentional. Additional workspace sessions,
Cantrip execution/CUA integration, provider credentials, and orchestration are
later work. This checkpoint ends before those integrations.

## OLED desktop and foreground launcher follow-up

Also verified on 2026-11-03 on the native ARM64 Docker edition:

- Built and ran the source-managed Cantrip OLED theme. Only this IceWM theme
  remains installed; DejaVu Sans replaces the optional downloaded text font.
- Visually checked black PCManFM and Mousepad interiors, the Mousepad editing
  surface, and xterm, alongside the black desktop and complete window outlines.
  GTK3 loaded the theme and GtkSourceView palette; GTK2 fallback is configured
  but was not exercised with a GTK2 application.
- Used the title-bar **Tile → Left Half** menu on PCManFM and the **Size** menu
  with arrow keys. IceWM loaded the new resize/tiling preferences. Modifier
  shortcuts and pointer dragging still need ordinary human-input confirmation;
  automated input did not reliably forward modifiers/dragging through noVNC.
- Checked the black viewer, bolt, and removal of the connected label/fullscreen
  button. Entering and exiting native Brave fullscreen hid/restored the toolbar.
- Ran `pnpm os`, watched source changes rebuild/replace the desktop, and observed
  build and container logs in the same console. The open viewer reconnected.
- Interrupted a real Docker build with Ctrl+C: the build command ended, the
  container stopped, and the launcher exited. Restarting retained the saved
  `Documents/persistence-check.txt` file from the foundation test.
- Verified the native VNC socket handshake on host loopback port 5900. A second
  foreground launcher failed without stopping the existing owner's desktop.
- The three focused lifecycle tests pass: foreground ownership, cancellation
  while waiting for the lifecycle lock, and child-process shutdown on abort.

Node/shell syntax, scoped formatting, and diff whitespace checks passed.
`pnpm check` stops at the existing server-boundary `agentOperations` digest
mismatch; the same failure was reproduced on unchanged Primary `main`.

The shared overlays also feed future ISO builds. The ISO identified above was
**not rebuilt** for this follow-up and still contains the original appearance.
