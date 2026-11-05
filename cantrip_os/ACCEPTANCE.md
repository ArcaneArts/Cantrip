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

## Phase 2, cycle 1: optional package foundation

Verified on 2026-11-03 using disposable native ARM64 Docker instances; the
owner's existing desktop was kept running separately.

- Built `cantrip-os-workspaces_0.1.0_all.deb` and installed it through apt in
  the Docker edition. Two independent package builds produced byte-identical
  artifacts (SHA-256 `2be6cb707d1647693eaa43ea6ba0f5f130353b258a40bbe82a0b5ddbd2db1fe1`).
- The real service started, answered its root-only Unix socket, stopped,
  restarted, disabled, and enabled through the packaged CLI.
- `tests/package-lifecycle.sh` passed: running and disabled reinstall/upgrade
  paths, remove, purge, reinstall, retained data/preference, and unsupported
  state versions. A corrupt/unknown state document was preserved, and the
  running service could still be stopped.
- X11 display `:0` and the personal desktop's HTTP viewer remained available
  throughout removal and disable. A separately built package-omitted image
  also started the personal display/viewer successfully.
- Replaced the package-enabled container with a fresh image: its disabled
  preference and persistent data marker remained in the named workspace volume,
  and the independent personal desktop started.
- Node lifecycle tests (three), Python/Node/shell syntax, scoped formatting,
  and diff whitespace checks passed. `pnpm check` encountered the previously
  recorded server-boundary digest failure; no server source changed.

ISO inclusion/omission is wired into the build recipes, but a new ISO and
installed-system service behavior await the final phase-2 acceptance cycle.
This first package version provides lifecycle/state only; independent workspace
accounts/desktops and the workspace viewer are the following cycles.

## Phase 2, cycle 2: persistent workspace sessions

Verified on 2026-11-03 with package version 0.2.0 in native ARM64 Docker:

- Created `alpha`, `beta`, and `shell` through the packaged CLI. Creation made
  persistent accounts/homes without starting a display. `shell` stayed stopped
  through service restarts and image replacement.
- Opened two real IceWM desktops with distinct UID/GID, displays, session buses,
  runtime directories, and Chromium processes/profiles. Both accounts executed
  `sudo -n` successfully. The personal desktop remained on `:0`.
- `tests/workspace-sessions.py` passed with Chromium in both sessions: stopping
  alpha left beta's window manager and generation unchanged; alpha's processes
  were gone; restart recreated the selected session; service restart retained
  files and advanced both desktop generations.
- The test killed the actual manager with SIGKILL. Per-workspace supervisors
  cleaned up their descendants, including Chromium; starting a new manager
  resumed the previously active desktops without duplicate window managers.
- The test occupied alpha's assigned display with another X server. Opening
  alpha failed, the other X server survived, beta remained usable, and alpha
  opened successfully once the conflict was removed. No fallback display was
  selected.
- Rebuilt/replaced the container and verified exact UID/GID restoration, home
  ownership, saved document contents, valid retained Chromium Preferences,
  running assigned displays, and the shell-only workspace's stopped state.
- The session test ran with a 4 GiB container limit; comparative memory/CPU
  measurements remain part of the final acceptance cycle.
- Python/Node/shell syntax, three Node lifecycle tests, scoped formatting, and
  diff whitespace checks passed. Full `pnpm check` still encounters the same
  previously recorded unrelated server-boundary digest audit failure.

Browser workspace selection, input/clipboard verification through two browser
tabs, installed-VM verification, refreshed ISO, and comparative resource results
remain for cycle 3. This cycle does not claim those acceptance items.

## Phase 2, cycle 3: browser workspaces and acceptance

Verified on 2026-11-03 with `cantrip-os-workspaces` 0.3.0. Package source and
assets live under `cantrip_os/packages/workspaces/`; they are independently
installable/removable. Two final package builds produced identical bytes:
SHA-256 `f6201b8e1a4bb47ea66c3c6db56eb65e6bc176b28e6eeff4ce49b7fdeca5f23e`.

### Docker and browser behavior

- Used a disposable native ARM64 Docker instance, with the owner's existing
  personal instance kept separate. The personal desktop, native VNC, and optional
  workspace selector were published only on host loopback.
- Created `browser-a` and `browser-b` in the real selector and opened both
  desktop links. Typed different terminal commands, saved distinct same-path
  documents (`BROWSER_A` / `BROWSER_B`), launched Chromium, and navigated to
  distinct example.com/example.org URLs. Actual Chromium History databases
  retained their separate URLs after session/container replacement.
- Clipboard round trips returned `CLIPBOARD_A` in A and `CLIPBOARD_B` in B;
  returning to A still returned A's clipboard. Clicking/typing targeted the
  selected desktop. In Codex's in-app browser, dragged and resized a terminal
  and scrolled real terminal output. Remaining GUI testing used that browser
  after the owner's request; no further native host-browser interaction.
- Real service restart and watched image replacement reconnected each direct
  viewer to its selected workspace. Documents, account identities and profile
  files persisted; windows are fresh processes after restart. Created/stopped
  workspaces stayed stopped.
- `tests/viewer-gateway.mjs` passed against actual Docker and installed-VM
  gateways: RFB handshakes, wrong-workspace token rejection, fresh generation
  sockets/tokens, rejected retired/stopped/unknown targets, and rejected
  cross-site Origin/Host/fetch-site mutations. No fallback desktop was selected.
- Occupied a real assigned display with a separate X server. The selector
  reported the failed Start, kept retry controls usable, and started the
  intended desktop once that test server released the display.
- Final package/session lifecycle tests passed, including independent stop,
  service restart, manager SIGKILL cleanup/recovery, remove/purge/reinstall,
  retained files/preferences, and continued personal desktop availability.
- Ran root `pnpm os` with private instance/port environment settings: initial
  build, source-watch rebuilds, actual connection URLs, build/container logs,
  and Ctrl+C graceful shutdown all worked. Container stopped with exit 143
  (SIGTERM), not OOM; named personal/workspace volumes remained.

### Installed VM

- Installed the same architecture-independent .deb through apt on an existing
  AMD64 CantripOS disk, using a private qcow2 overlay over the earlier foundation
  installation. QEMU used 2 emulated CPUs and 4096 MiB; the original disk was
  not modified. systemd supervised the packaged service.
- Opened two real workspace desktops through the browser gateway. Launched
  Chromium on the VM kernel without Docker's sandbox override. Stopping one
  desktop left the other running.
- From vm-a, passwordless sudo installed Debian's `hello`; vm-b ran the shared
  executable successfully. Root changes are intentionally shared.
- Disabled/removed the package: LightDM and the ordinary personal desktop
  remained usable, including launching a terminal through the real desktop.
  Reinstallation retained the disabled preference and saved `VM_A` document;
  enabling/opening recovered both desktops.
- Rebooted the installed VM: both previously active workspace desktops resumed
  with new generations, the saved document survived, and LightDM was active.
- The installed default bind was verified as loopback. For this private NAT VM
  test only, `viewer_bind` was changed to `0.0.0.0`, reached through QEMU's
  host-loopback forwarding. This is not the shipped default or remote access
  configuration.
- Older foundation images can lack the OLED Xresources file. The optional
  package now reports an xrdb error and continues launching the desktop; it
  does not require or overwrite a newer OS theme.

### Measured resource use

A fresh native ARM64 Docker container had a 4 GiB memory limit and no extra
swap allowance. It included the ordinary idle personal IceWM desktop and the
enabled package. No viewers were attached. The shell-only stage ran two actual
idle bash loops; those exited before graphical stages. Chromium displayed
`about:blank`. Each stage settled 10 seconds, then recorded five Docker stats
samples plus raw cgroup memory readings.

| Stage                             | Docker working set, median MiB | Raw cgroup memory, median MiB | CPU median | CPU maximum |
| --------------------------------- | -----------------------------: | ----------------------------: | ---------: | ----------: |
| Idle OS                           |                          71.33 |                         72.02 |      0.48% |       0.64% |
| Two shell-only workspaces         |                          72.46 |                         73.20 |      0.45% |       0.59% |
| One workspace desktop + Chromium  |                          285.8 |                        290.60 |      1.61% |       4.28% |
| Two workspace desktops + Chromium |                          494.4 |                        503.27 |      2.17% |      12.24% |

Two-desktop working set ranged 494.4–496.3 MiB. Container `OOMKilled` was false;
all stages completed. This is a short idle-browser measurement, not a capacity
promise or a heavy website/build benchmark. Docker accounting excludes the
outer host/VM kernel and browser viewer. Raw memory includes cache that Docker
subtracts from its working-set presentation. The raw samples and actual image
ID are in `cantrip_os/artifacts/phase2/resources.json`. Reproduce with:

```sh
CANTRIP_OS_TEST_IMAGE=cantrip-os:dev node cantrip_os/tests/resource-profile.mjs
```

### Refreshed bootable media

Built the current AMD64 live/install ISO, including the OLED IceWM/GTK/X11
appearance and workspace package 0.3.0. The build's package inventory records
that version. SHA-256:
`ddbf6798c62ca99ade06d5aa1d7c38063fdb8193c83fe61191cb4f6dfd7fe693`.

- Booted the final ISO in QEMU TCG, 2 CPUs/4096 MiB, BIOS, with a fresh disposable
  16 GiB qcow2 disk. Automatic login reached the black IceWM desktop. Opened a
  terminal through its menu and ran `cantrip-workspaces-viewer`; Chromium
  rendered the actual packaged selector on loopback. Screenshot:
  `cantrip_os/artifacts/phase2/refreshed-iso-selector.jpg`.
- Created a stopped `iso-check` workspace and saved a document; added a root
  system customization marker. The live gateway actually listened on
  `127.0.0.1:6081`.
- Ran `sudo cantrip-install --erase /dev/vda` against that disposable disk.
  It exited 0, installed BIOS and EFI boot files, and reported completion.
- Shut down, removed the ISO, and booted the disk. Root was `/dev/vda3` (ext4),
  LightDM and the package service were active, automatic personal login worked,
  and both customization/document markers remained. The stopped workspace
  stayed stopped until an explicit Open, which started its assigned desktop.
- Debian kernel `6.12.115+deb13.1-amd64` emitted a `virtio_gpu` warning during
  emulated live/installed-system shutdowns. Poweroff completed and installed disk boot
  succeeded. This warning is recorded rather than treated as a clean kernel
  shutdown result. The refreshed image's UEFI boot and physical hardware were
  not retested; earlier foundation BIOS/UEFI results above refer to that older
  image.

Outputs remain under `cantrip_os/artifacts/`: the ISO, `.iso.sha256`, package
inventory, `packages/cantrip-os-workspaces_0.3.0_all.deb`, and `phase2/` runtime
screenshots/resource samples/logs. Build/test entry points remain:

```sh
node cantrip_os/scripts/package.mjs
pnpm os
node cantrip_os/scripts/iso.mjs
node cantrip_os/scripts/vm.mjs --headless
# In the live VM, only against its disposable disk:
sudo cantrip-install --erase /dev/vda
# After shutting down the live VM:
node cantrip_os/scripts/vm.mjs --installed --headless
```

The repository VM helper uses `.state/cantrip-os-test.qcow2`; acceptance instead
used a new `/tmp/cantrip-phase2-refreshed.qcow2` to preserve the earlier test disk.
The VM helper's headless VNC endpoint is host loopback port 5901. Desktop
screenshots and interactions were performed through Codex's in-app browser.

### Validation scope

Three Node lifecycle tests, final Python/Node/shell syntax checks, scoped
formatting, and whitespace checks passed. `pnpm check` encounters the existing
server-boundary `agentOperations` digest audit mismatch, previously reproduced
on unchanged Primary main; no server source changed in this phase.

Cloud provisioning, physical hardware, arbitrary session capacity, production
authenticated remote access, checkout mounts, worker execution placement, and
agent CUA integration are unverified/deferred. The browser interactions above
test the real remote desktops; they do not establish Cantrip's future Linux
computer-use backend.

## Phase 3, cycle 1: executor package and attachment

Verified on 2026-11-03 in native ARM64 Docker and the disposable installed
AMD64 VM. This checkpoint supplies the optional package and protected worker
carrier; full project placement and agent/client integration remain in progress.

- Added htop, nano, and Python 3 to the shared base manifest, including the
  `python` alias. Both package-included and package-omitted Docker builds ran
  `htop 3.4.1`, `nano 8.4`, and Python `3.13.5` through both command names.
  Installed the same tools in the test VM and opened htop through Codex's
  in-app browser. Screenshot: `artifacts/phase3/installed-vm-htop.jpg`.
- Built the pinned, reviewed Codex 0.166.0 standalone executor for Linux ARM64
  and AMD64 from commit `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`, all 44
  reviewed patches, and canonical source preparation. Runtime exports contain
  the executor, bwrap, manifest, and licenses (about 69/78 MB); Debian packages
  are about 16/18 MB. Both normal architecture builders subsequently reused
  the verified native bundles. No full worker or model credentials are installed
  in the guest.
- Independently rebuilt the current ARM64 package from the runtime export:
  its bytes matched the normal builder's output, SHA-256
  `fb60c80c5e5b331cd4ae2c9bb940780a68383474ffe3b2ac67a7dd6ef43ab262`.
  Comparison: `artifacts/phase3/package-reproducibility.json`.
- The worker transport's real integration test passed against both editions:
  independent native file writes/reads, actual UID/home/sudo and absent DISPLAY,
  authenticated connections, rejected unauthenticated WebSocket, explicit
  native-session resume after carrier disconnect, once-only mutation marker,
  terminated child PID gone, stale/wrong-owner rejection, and another workspace
  remaining operational. The final Docker and VM runs took about 9/21 seconds.
- Installed Debian's `hello` with sudo through one workspace's native executor;
  the other workspace ran the shared executable. Stopped a real desktop while
  its independently managed native shell job continued and returned output.
  Closing an executor also removed a child launched with `setsid`, while the
  other executor remained usable.
- `tests/executor-lifecycle.sh` passed in Docker and the installed VM: disable,
  remove, purge, reinstall, running upgrade, retained identity/attachment/data
  and disabled preference, and unsupported identity version preservation.
  Personal desktop and another workspace's same window-manager process stayed
  usable. Installed-system enable/disable now updates systemd boot enablement;
  startup waits for the actual control endpoint and reports failed startup.
- Built the current Docker recipe with the executor included and replaced the
  disposable container. It booted the current image, retained its instance and
  attachment, restored exact UID values and files, and started the personal
  desktop. Explicit reset passed for two-volume, three-volume, and
  already-absent-volume disposable fixtures.
- Rebooted the installed VM once. The executor auto-started with the same
  instance, attachment, UID and home, a new manager generation, retained files,
  once-only marker, and native home state. A stale pre-reboot descriptor was
  specifically rejected for generation mismatch. Native reads then recovered
  both workspaces' distinct bytes. The personal document and ordinary IceWM
  console returned on `/dev/vda3`. Boot IDs, descriptors and file checks are in
  `artifacts/phase3/installed-vm-reboot.json`. Opened a terminal and checked the
  running executor through the rebooted desktop in Codex's browser; screenshot:
  `artifacts/phase3/installed-vm-executor.jpg`.
- Built the recipe omitting both optional packages. The personal viewer and
  display started; in Codex's in-app browser, opened a terminal through the menu
  and ran `id`. Both packages were absent. Screenshot:
  `artifacts/phase3/optional-packages-omitted.jpg`. The owner's original desktop
  was kept separate from all disposable instances.
- Focused TypeScript compilation, three OS lifecycle tests, seven native
  manifest tests, source-verification tests, Python/Node/shell syntax, scoped
  formatting and whitespace checks passed. Whole-worker typecheck failures in
  unchanged CUA/MCP fixtures were reproduced on clean Primary. Full repository
  checks still encounter the previously recorded unrelated `agentOperations`
  boundary digest audit.

The test VM's forwarded SSH endpoint dropped near-simultaneous new handshakes,
reproduced with plain `ssh ... cat` outside the executor. The test establishes
carriers in sequence before exercising both active sessions; the worker does
not retry failed connections or replay mutations. This is a development SSH
carrier, not general Cantrip SSH/cloud provisioning support.

Server-authorized project bindings, both source modes, real agent placement,
editor/terminal/Run routing, and refreshed execution-enabled ISO media remain
required by the full phase-3 goal. The VM above used the existing installed
edition plus the current package; a new ISO is part of the distribution cycle.

## Phase 3 source identity checkpoint

This internal checkpoint adds canonical placement persistence; it does not claim
that Docker mounts, checkout provisioning, agent routing, or client selection are
available yet. The executor package remains optional and unchanged.

- The actual Drizzle migration path passes alongside the worktree and placement
  API suites: 65 tests. Direct/link replica jobs and executor suites add 8 tests.
- Source tests preserve legacy inserts, IDs, path repairs and delete cascades;
  reject cross-owner/worker/profile bindings and guest paths in local fields;
  preserve distinct Linux source IDs; reject stale attachment/runtime receipts;
  invalidate moved linked roots; and retain captured paths without host fallback.
- The Rust server applies the same migration through native PGlite and a real
  PostgreSQL child process, then reopens both databases successfully. Its 2,571
  source validation cases agree with the actual TypeScript protocol, and the
  generated contract manifest agrees with current source.
- Worker worktree/runtime/path suites pass 95 tests; GitHub/direct/link placement
  adds 31. Client worktree/history/settings/popout suites pass 56 tests and
  placement/encryption adds 12. The client production build passes.
- A real ARM64 guest filesystem write with literal `#`, `%`, `?`, `%2F`, spaces
  and Japanese characters was independently read by Linux Python. The URI codec
  does not apply the worker host's filesystem path conventions.

The full protocol run has the same four source-test failures as clean Primary
(duplicated in compiled test output): two CUA default expectations, context tool
ordering, and seven previously unreviewed public exports. The new twelve exports
are explicitly accounted for without accepting that unrelated baseline drift.
Server typechecking retains the two existing Task-operation errors reproduced
on Primary. `pnpm check` stops at the existing agent-operation boundary digest
mismatch. A broad legacy Rust wire sweep was interrupted; only the focused
source cases, manifest and database checks above are claimed as complete.

## Phase 3 materialization backend checkpoint

Verified on 2026-11-03 with executor package 0.2.0, native ARM64 Docker Desktop
on macOS, and the installed Debian AMD64 test VM. This is an internal worker
backend checkpoint. Authorized product dispatch, client target selection, native
agent placement, editor/terminal/Run integration, and refreshed ISO acceptance
remain subsequent work; the complete Phase 3 workflow is not available yet.

- Linked real host Git worktrees at stable guest roots. Host and guest edits
  changed the same files. The external `.git` pointer, host UID, executable bit,
  and symlink survived. Guest-native Git could not access the unmounted external
  metadata; host Git remained valid. Ignored files stayed visible.
- Explicit `node_modules` and `.venv` volumes began empty and accepted Linux
  writes without changing the host-platform dependency files. Host `fs.watch`
  observed a guest write, and guest inotify observed a host write. Literal
  filenames containing spaces, `#`, `%`, `?`, `%2F`, and Japanese text worked.
- Provisioned exact-revision Git bundle clones, Linux worktrees, actual Git
  commits, and non-Git folders in Docker and the VM. Read-only inspection of
  existing repositories/folders preserved their identity. Commands used the
  workspace UID, had passwordless sudo, and ran without `DISPLAY`. A 360 KB
  Unicode output fixture drained completely. Repeating a reserved source
  operation dispatched no further Git commands.
- Cancelled a real sudo-owned Python process, its child in a separate session,
  and that child's sleep process. All three were gone in Docker and the VM;
  a separate native job remained running. Ordinary child commands had effective
  capabilities zero. Package-owned `CAP_KILL` and reviewed patch `0046` provide
  this lifecycle behavior without changing ordinary command identity.
- Rebuilt the current Docker image with 0.2.0 and exercised the normal
  `os.mjs rebuild` path. Four linked mounts and their explicit dependency volumes
  remained attached. A separate retention check compared ten persistent source
  directories, Git heads, UIDs, dependency bytes, ports, and the 4 GiB limit
  through image replacement. The instance identity remained stable and stale
  executor descriptors were rejected. Mount-only replacement also retained an
  installed `hello` package; deliberate image rebuilds apply source defaults.
- Disable/remove/purge/reinstall/upgrade and unsupported-state tests passed in
  both editions while retaining identity/data and an independent desktop.
  Reopened a checkout and committed worktree created with 0.1.0 after the VM's
  0.2.0 upgrade/removal/reinstallation; their original heads, branch, UID, and
  repository fingerprint remained intact.
- Used Codex's in-app browser to open the linked README in the selected desktop
  and observe its guest-written contents. Screenshot:
  `artifacts/phase3-sources/linked-worktree-desktop.jpg`.

Both final package helpers passed with the versioned build contexts and reused
the native compiler layers. The rebuilt archives matched the tested archives:

| Package                               | SHA-256                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| `cantrip-os-executor_0.2.0_arm64.deb` | `286fcc6480dc56b766e6777ab68175221602246d8e9fa7fe4aa7162c4273045a` |
| `cantrip-os-executor_0.2.0_amd64.deb` | `cb6c495e22a05824337926089507d4ecac79599ac83362aa618727a52dc5154b` |

Focused checks passed: seven host HTTP/lifecycle/mount tests, 98 worker
process/path/worktree/runtime regressions, 65 server migration/worktree/placement
checks, 56 app project/worktree checks, production-deployed workspace module
imports, and a standalone Rust regression using the exact Linux cleanup module.
Real source/cancellation and native executor suites passed separately in each OS
edition. Both native builds verified 9,191 pinned source files and 45 patches.
Python, shell, Node syntax and scoped formatting checks passed.

`pnpm check` still stops at the previously recorded agent-operations boundary
digest mismatch. Worker typechecking still reports the same five CUA/MCP errors
from the preceding checkpoint; no new errors came from these changes. Broader
CI is not claimed green. Native Linux-host bind permissions were documented,
but the linked-host acceptance above was performed on macOS Docker Desktop.

Reproduce with [the source backend guide](SOURCES.md). Detailed receipts and
screenshots are generated under the ignored `artifacts/phase3-sources/` directory.

## Phase 3: authorized source dispatch checkpoint

Both Server implementations now expose owned attachment, profile creation,
source admission/provisioning, operation observation, and read-only verification.
The Server persists the original generations and encrypted request before a
provisioning mutation. Repeated admission observes the recorded operation.
Guest UID/home observations and successful provisioning receipts come only from
the owning worker. Worker commands keep private native session/process provenance
on the worker and use the existing repository-content encryption for clone URLs.

Actual Docker and installed-VM tests passed through the administrative HTTP
handlers, production worker routing/encryption code, and native executor. Each
cloned an exact Git revision, read a literal Unicode/special-character filename,
ran Python with the selected workspace UID/cwd, and read the resulting artifact
bytes. A deliberately lost response recovered the saved result; reposting its
admission did not provision again. Tests used synthetic encryption component keys,
not a product account-key installation flow. Receipts are under
`artifacts/phase3-dispatch/`.

The native Server's production HTTP router/worker bridge test passed with a
simulated worker and isolated PostgreSQL. Native PGlite and PostgreSQL repository
tests passed. Source protocol parity matched 6,125 cases. All 285 outgoing worker
command fixtures and 83 boundary cases matched. A broader sweep matched 209,900
mutation cases, then failed its existing callback-coverage requirement because
`worker-command-task-model` was not exercised (98/99 checks). That sweep is not
claimed green. Fixture-ledger updates also cover previously omitted chat
provenance and shifted encryption-component enum samples.

Focused regressions passed: 71 Server and 25 worker tests. Additional checks
cover private durable operation records, real AES-GCM placement binding, stale
runtime compare-and-swap, disconnected observation without replay, UID/home
consistency, and retained Git common-directory identity. Runtime observations
cannot overwrite a newer observed generation. Repository/large-file budgets,
Rust formatting, and diff whitespace checks passed.

Required `pnpm check` still stops at the same agent-operations digest mismatch.
Typechecking reports the previously recorded five worker CUA/MCP errors and two
Server Task errors. Public protocol compatibility retains its seven unreviewed
pre-existing exports; the new OS exports/commands are explicitly reviewed.

This remains an internal source-control checkpoint. Real agent execution,
terminal/editor/Explorer/Run integration, the attachment picker, and refreshed
bootable media remain outstanding. See [the dispatch guide](DISPATCH.md).

## Phase 3: native environment adapter checkpoint

The real pinned app-server now runs against a captured guest environment through
its native environment provider. Docker and installed-VM turn fixtures passed
shell/read/search, native patch/write, and Python artifact creation, verifying the
workspace UID, guest cwd, actual file bytes, and an absent provider API key in the
guest. Authenticated model requests originate on the worker. The model endpoint
in these tests is deterministic Responses scaffolding, not a live provider.

Native workspace permissions passed in Docker. Read-only execution read the seed
and refused patch/write without changing it. Cancellation passed in both Docker
and the installed VM: the root sudo job, detached child, and leaf were gone before
executor shutdown, while an independent native process remained alive. An actual
VM failure exposed native interruption retaining resumable command sessions; the
worker now explicitly terminates command IDs observed in that interrupted turn.

The environment test also covers actual Git provisioning, guest file snapshots
with a literal Unicode/special-character filename, rejection of stale runtime
identity, immutable runtime-home placement, and an unavailable local environment.
The host native binary is version 0.166.0 at the repository's upstream pin; its
build predates the last Linux-only cleanup patch. Both guest executor packages
are the current 0.2.0 builds from the preceding checkpoint.

The 82 existing app-server tests passed alongside the focused native tests.
`pnpm check` still stops at the recorded agent-operations boundary digest mismatch;
worker typechecking still reports only the same five CUA/MCP baseline errors.
This is a runtime component checkpoint. Server chat selection, product terminals,
editor/Explorer/Run routing, attachments/artifact delivery, live-provider acceptance,
and refreshed bootable media remain outstanding. See [the runtime guide](NATIVE_RUNTIME.md).

## Phase 3: captured chat placement checkpoint

New encrypted agent-chat creation accepts a verified OS binding. Both Server
implementations capture its generations before native preparation, preserve the
worktree/lane identities, and derive the explicit guest execution descriptor.
Managed preparation and turn dispatch select private OS native runtime homes.
The worker retains immutable placement provenance across its restart; ordinary
host runtime homes remain separate. Server and worker whole-turn retry paths do
not replay OS turns after uncertain results.

TypeScript database tests cover Linux-owned and linked chat contexts, unchanged
host source paths, existing lane identity, foreign ownership rejection, immutable
captures, runtime generation invalidation, and normal project deletion. Native
Server chat creation/context/lane tests pass in native PGlite and PostgreSQL.
Native wire parity covers the new execution descriptors and OS chat constraints.
Worker tests cover persisted placement resolution and rejection of another
owner or a changed placement. The real Docker native tool loop remains passing.

This is canonical chat/runtime wiring, not complete product acceptance. These
checks do not claim a deployed full worker connection, live-provider turn,
client target picker, or terminal/editor/Run/attachment workflow. New OS bindings
are available for agent chats; existing chat retargeting and automatic re-admission
after OS replacement are not implemented. Package and ISO sources are unchanged
in this checkpoint. The final phase still needs the full workflow and fresh media.

Compatibility verification passed against the actual preceding worker schema:
it rejects the `cantrip-os` execution profile. New protocol/native parity covers
the profile/placement pair and rejects missing or conflicting descriptors. The
actual native `config/read` response confirms that computer-use and host-browser
features are disabled for the OS runtime, while the Docker tool loop still passes.
Focused regression checks passed 54 Server tests (one optional native test skipped)
and 133 worker tests. Full checking still stops at the same agentOperations digest;
public export compatibility retains the same seven unrelated exports (2,184 actual
versus 2,177 reviewed), and typechecking reports only the prior five worker and two
Server errors.

## Phase 3: client attachment and source selection checkpoint

Verified 2026-11-04 in Codex's in-app browser against a disposable TypeScript
Server/PGlite, real worker WebSocket connection, and new ARM64 Docker container
`cantrip-os-product-test` with executor 0.2.0. No personal browser was used.

- Created an encrypted non-Git project through the actual client, attached the
  actual Docker instance, and created `work` (UID 20000) and `work-two` (UID 20001).
- Provisioned a Linux-owned empty folder in `work`, then opened its new pinned
  agent chat through **New Linux agent**. This checkpoint used no configured
  model, so chat creation is not an executed provider turn.
- Linked the exact original Primary folder into `work-two` with an explicit
  `node_modules` overlay. Docker recreated once, preserving its identity and
  earlier workspace/source. The real flow exposed an overlay receipt regression:
  repository metadata protection was turning admitted relative directory names
  into routing tokens. The worker now validates/preserves this configuration in
  OS receipts while continuing to obscure repository metadata.
- Restarted the real worker with the fix and used **Observe outcome** on the
  existing saved admission. The linked source became ready; the Docker container
  ID stayed unchanged, proving no second mount/recreation. Verified the retained
  Linux folder in the new generation and opened a `work-two` bound agent chat.
- Both source cards show the workspace identity and Linux dependency directories.
  Captured screenshot and redacted source summaries are in ignored
  `artifacts/phase3-client/`.

The production app build passed. Focused client encryption/API/settings tests:
49 passed in five files. Worker routing/placement tests: three passed. The app
TypeScript build passed; worker type checking reports the same five existing
CUA/MCP errors. Required `pnpm check` reached the same pre-existing boundary-audit
agentOperations digest mismatch (`691b613…` expected, `c01cedeb…` candidate).

The Linux-owned chat's existing file sidebar reported an unavailable worktree;
its product filesystem routing remains the next block. Linked source sidebar
currently observes the original worker files. Plain Linux terminals, setup/Run,
attachments, artifact downloads, and a real product-dispatched model turn are
not claimed by this checkpoint. Fresh ISO distribution acceptance also remains.

## Product file checkpoint (2026-11-04)

Executor 0.3.0 was built for ARM64 and AMD64, then installed in disposable
Docker and the installed AMD64 VM. This is package-level validation; fresh image
and ISO distribution acceptance is still pending.

| Package                               | SHA-256                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| `cantrip-os-executor_0.3.0_arm64.deb` | `8e7ed1f398406f8913ded6777ef68b10f153d12e768b6087d47ddc30d77fcd66` |
| `cantrip-os-executor_0.3.0_amd64.deb` | `3956baba47d5ba2d40a5da57b7e6fe80dba58053b7d8b9205cc710a907822649` |

Actual product testing used only Codex's in-app browser and the disposable
Server/Worker stack. The linked Files sidebar created `product-linux.py`, the
owned editor saved `print("CantripOS 日本")`, and the same bytes were read and
executed as UID 20001 inside Docker. The Linux-owned Files sidebar showed its
separate source; after upgrading the package, an old editor save correctly
failed on the changed runtime. Refresh/verify and a newly captured Linux agent
opened a new document view, which saved `print("Linux editor 日本")`; execution
as UID 20000 printed that exact output. Screenshots and logs are under ignored
`cantrip_os/artifacts/phase3-files/`.

The real native product-file test passed in both Docker and the installed VM:
160 KB Unicode text across native pages, binary write begin/chunk/commit,
completed-save recovery after helper restart, wrong-server rejection, stale
generation rejection, and a Worker admission with no guest completion returning
unknown without creating the requested file. This exposed and fixed a digest
mismatch caused by JSON property order.

Focused Server tests: 51 passed. Host filesystem regression tests: 53 passed.
Client tests: 87 passed, covering distinct host/OS sidebar and document identities, retained
editor callbacks, recovery, and editor modes. Production app build passed.
Native Rust source/contract tests passed on native PGlite and PostgreSQL.
Actual Node/Rust comparisons on native PGlite passed 42 file-document cases and
133 project-surface cases (4 and 68 retained-state snapshots). The file comparison
fixture now moves both source and worker together, preserving the source/worker
constraint introduced in Phase 3. Older Worker schemas rejected both OS-root
commands; current schemas accepted them.
The required `pnpm check` still stops on the existing unreviewed
`agentOperations` digest (expected `691b6132…`, candidate `c01cedeb…`). Worker and
Server type checks retain their existing five CUA/MCP and two Task errors.
These results do not establish terminal/Run, full provider-agent product turns,
attachment/artifact, live notification, or fresh ISO acceptance.

## Product terminal checkpoint (2026-11-04)

Captured interactive terminal integration is implemented in the optional executor
0.4.0 cycle. This remains a Phase 3 checkpoint: setup/Run, delegated Cantrip
project tools, attachments/artifact delivery, notifications, and current ISO
acceptance are not established by these results.

Both final package archives were built from the reviewed patch and current
source:

| Package                               | SHA-256                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| `cantrip-os-executor_0.4.0_arm64.deb` | `349d561d5c493334990ac7a19131e54dc500f01c0187f6ae0ea3445ee360c1ac` |
| `cantrip-os-executor_0.4.0_amd64.deb` | `8b1e8c9d6bce21f8c9094eadb58c6af1fe6fad371ed32b5816c074fa8f88e580` |

Actual operations exercised in this cycle:

- An ARM64 Docker and installed AMD64 VM ran the same native terminal carrier
  suite: workspace UID/cwd, real `stty` resize to 37×119, nano save with exact
  Unicode bytes, and interrupting a live Python process using the terminal's
  interrupt byte. The final-archive VM run completed in 33.5 seconds after installation.
- Killed the worker-side carrier, resumed its original native session/process,
  and verified one mutation execution. An unknown native handle reported an
  unknown outcome without starting a replacement shell. Explicit termination
  removed sudo Python and its detached root child; an independent native job
  continued. A fresh launcher instance closed an orphan through its saved
  native handle. A changed directory or stale generation could not retarget
  an existing terminal.
- In Codex's in-app browser, selected a Linux-owned agent and created a Linux
  terminal through the normal menu. It reported UID 20000 and the correct
  checkout, executed the editor's Python file, and wrote Unicode content. A
  second, linked workspace terminal reported UID 20001; guest edits were read
  from the host mount and host edits were read from Linux. Files from the
  independent Linux-owned source did not appear in the linked source.
- Forced a real product carrier interruption. The UI displayed **Command
  outcome unknown** and **Reconnect to Linux**; the Server recorded `offline`.
  After explicit reconnect, the same shell read an execution-count file with
  one line. Screenshots and local receipts are under
  `artifacts/phase3-terminals/`.
- The native Server captured terminal/console placements on both PGlite and
  PostgreSQL. Stale execution was rejected; owner-authorized removal of a stale
  terminal remained possible. Actual Node/native terminal repository comparisons
  matched 87 cases and 91 durable snapshots on PGlite. An older Worker rejected
  the OS terminal descriptor instead of selecting a host path.
- A real local Qwen model, through the full client/Server/Worker/native runtime,
  read/searched this Linux-owned folder and wrote `os-agent-proof.py`. Its first
  turn was explicitly interrupted after the shell write. A second turn executed
  the verified existing script, saved and checked `os-agent-proof.json`, and
  completed. Independent reading verified UID 20000, the intended checkout,
  exact Unicode message, and UID 20000 ownership of both files. This provider
  emitted invalid function calls for the freeform patch tool; the real write
  used shell instead. The earlier deterministic native-tool fixture remains the
  separate evidence for valid patch dispatch.

The real-model startup exposed two integration gaps fixed in this cycle:
required worker-local stdio MCP servers cannot start in the pinned remote
native environment, and Linux-agent creation needed the ordinary chat-content
worker grant before native preparation. OS sessions now omit managed Host MCP
injection and reject enabled user stdio configurations explicitly; configured
network MCP servers remain supported. Delegated project-tool access is still
subsequent work. The managed native console displayed the real agent's result.
The app initially showed only the completed activity; reopening the test page
displayed the complete final response, including the verified JSON. The product
editor opened the actual agent-created JSON through the Linux Files sidebar. A
fresh product terminal read that JSON and executed the agent-created script
under the same UID and checkout, then exited normally.
Both views are captured under `artifacts/phase3-terminals/`. Immediate live
final-response rendering is not established by this reload-based observation.

CI review also exposed a failed-turn race introduced during the native OS
adapter work: a workspace read could overwrite a newer turn's file-change
state. The existing regression failed before the fix and passed after restoring
the generation check before assignment. All 205 runtime/lifetime regression
cases in four files passed. Native console creation now also refuses a missing
OS chat capture; the actual PGlite and PostgreSQL tests both passed.

The production app build and its 80 focused client tests passed. Focused Worker
terminal/MCP tests passed 27 cases; Host terminal regressions passed 24. The
final Server relay/placement/console run passed 10 cases. The required
`pnpm check` still stops at the same boundary-audit `agentOperations` digest
mismatch described above; Worker and Server type checking retain the same five
CUA/MCP and two Task errors. These checks are not a green repository-wide run.

The native PTY resize unit passed against the final reviewed patch, including a
real terminal-size change and rejection of an unknown process handle. The final
ARM64 archive passed the complete terminal suite and the product-file regression
suite in Docker. The exact final AMD64 archive was checksum-verified, installed
in the VM, and passed the complete terminal suite. The installed VM also
reported htop 3.4.1, nano 8.4, and Python 3.13.5 through the `python` command.
Fresh Docker image and ISO distribution acceptance remains subsequent work.

## Product Git worktree checkpoint (2026-11-04)

The current Server and Worker expose Linux-owned Git worktree admission through
Settings. These tests used installed executor 0.4.0 process/filesystem APIs;
this cycle does not introduce a new guest runtime or claim full Phase 3 completion.

- Real Node HTTP handlers, canonical PGlite rows, protected Worker commands, and
  the native executor created a checkout at an exact Git revision and a second
  worktree with a Unicode branch. Both targets retained one source identity.
  The Docker run passed; the installed VM run passed in 33.7 seconds. A response
  deliberately lost after worktree creation was recovered without another Git
  mutation. Secondary edits left Primary unchanged; Python reported the actual
  workspace UID and worktree cwd.
- A mismatched canonical Git common-directory identity was rejected after
  actual native Git observation and before a worktree directory or mutation was
  created. Git still listed only the two expected worktrees afterward. This
  check passed in both Docker and the installed VM.
- Actual PGlite and PostgreSQL repositories admitted concurrent identical
  requests as one binding/worktree. Ownership and stale-generation checks
  rejected new admissions; an existing admission remained observable. Updating
  secondary worktree observations retained Primary's branch and source identity.
- In Codex's in-app browser, attached a disposable existing local Git repository,
  provisioned its Linux checkout from a Git bundle, and created
  `acceptance/linux-worktree` using the new settings form. Opened its Linux
  agent, edited `main.py` in the product editor, and ran it in a product terminal.
  Independent reading verified UID 20000, the intended worktree directory and
  branch, the saved comment, and an unchanged, clean Primary file. No model turn
  was submitted for this worktree test. Its agent and terminal headers now show
  the Linux location instead of the original host source path.

The production app build passed. The form test verifies that uncertain delivery
retains captured inputs and reuses the prepared operation. Screenshots and
receipts are under ignored `artifacts/phase3-worktrees/`. Run, delegated project
tools and broader Git UI, attachments/artifacts, notifications, and current
Docker/ISO distribution acceptance remain later blocks.

## Linux Run definition checkpoint (2026-11-04)

Executor 0.5.0 packages a finite Run definition helper. The Worker remains the
orchestrator; the helper has no listener, scheduler, conversation state, account
key, or provider credential. It reads/writes the ordinary revisioned definition
repository and performs discovery and validation using Linux files and tools.

- The exact ARM64 package passed the actual Node HTTP/Worker/native executor
  workflow in Docker. Selecting a secondary Linux worktree resolved definition
  files to its source's Primary. Linux validation found Bash, and native reads
  verified the saved definition existed in Primary and not the secondary tree.
- A response deliberately lost after saving was recovered after recreating the
  Worker operation handler. The same admission returned its original `created`
  receipt; changed input with that operation UUID was rejected. Stale runtime
  selection was rejected before Worker dispatch. Deletion is intentionally not
  part of this checkpoint, pending active-Run retirement integration.
- The checksum-verified final AMD64 package passed the same actual workflow in
  the installed VM (56.0 seconds). Package installation and both runtime tests
  used executor 0.5.0, not a helper copied outside its package.
- Native protocol parity, the native HTTP route, and PGlite/PostgreSQL source
  selection passed five tests. The HTTP test uses a Worker response fixture;
  actual guest execution is established by the separate Docker/VM workflow.
- Seven Worker process/admission cases and six client API cases passed. These
  cover observing a process without another start, uncertain stdin without
  replay, persisted observed completion, and retained client operation identity.
  App type checking passed. Required `pnpm check` retains the existing boundary
  audit digest mismatch; Server/Worker retain the same two Task and five CUA/MCP
  type errors. Public-surface compatibility retains its existing seven-export
  mismatch after accounting for the five reviewed additions; its other four
  cases pass, including the new Worker discriminator.

Final package SHA-256 values:

```text
arm64 206f681d3ef3945a2ed1033931838acc7e83b34ba58d1a00388b631f2ba345f2
amd64 d97651c1e8a9104248df42369538dac5662c01d737c810c19577cb7a0e1ca27b
```

Receipts and logs are under ignored `artifacts/phase3-run-definitions/`.
The header source picker, delegated Run lifecycle, project tools/Git,
attachments/artifacts, notifications, and fresh Docker/ISO acceptance remain
subsequent blocks. This checkpoint is not full Phase 3 completion.

## Native Run generation checkpoint (2026-11-04)

Executor 0.6.0 and the Worker generation driver passed actual Docker and
installed-VM component tests. This checkpoint does not yet connect the product
Run header or Server runtime records to this driver.

- A Linux-owned Git checkout and a real secondary worktree used definitions
  and the live Codex environment from Primary, environment files from the
  secondary tree, and plain-variable/secret precedence. The configured setup
  and before-launch commands wrote files in the selected worktree. Python
  verified that target's bytes, UID, cwd, reserved path, real 120×40 PTY, zero
  effective capabilities, and available passwordless sudo. A Host-only variable
  did not enter the process.
- A real native read response was deliberately lost while its connection was
  closed. The driver resumed the recorded native session/process, delivered
  output, and started the runtime process only once. The execution-count file
  contained one line. Reopening the completed admission in another driver
  returned its saved completion without another execution.
- A purpose-specific encrypted Run secret was opened on the Worker and used
  in Linux. Its printed value was redacted from callback output; neither its
  plaintext nor the resolved command appeared in the Worker admission journal.
- Cancellation initially exposed a detached root child that had already been
  orphaned through `sudo`/`setsid`. Adding a small unprivileged subreaper parent
  per managed command retained its ownership. The final test interrupted the
  ordinary parent, confirmed that the adopted child kept the command owned,
  then force-stopped it. The root child exited; an independent native job
  remained running. This does not create a barrier around unrestricted root.

The final Docker test passed in 8.9 seconds. The checksum-verified AMD64 package
passed the same installed-VM test in 66.8 seconds. A changed definition revision
failed before runtime launch, and a mismatched workspace was rejected. The shared helper and integration test passed standalone strict type checks. The required repository check retains the same
`agentOperations` audit mismatch; Worker type checking retains the same five
CUA/MCP baseline errors.

Tested package SHA-256 values:

```text
arm64 f15296a7cec79a7629ae6fd68d846bbca01ffa30a71c853121bb40e1d71a87f3
amd64 c1a47dbc5e96a54b8ced25f30cc0f31fbd83eead49844391961b3dc6451a3801
```

Proofs and logs are under ignored `artifacts/phase3-run-execution/`. Server
runtime captures, the Run header/source picker, delegated project tools/Git,
attachments/artifacts, notifications, and current distribution acceptance remain
subsequent work.

## Worker Run lifecycle checkpoint (2026-11-04)

The common Worker `RunConfigurationRuntimeSupervisor` now uses the native
Linux driver for six explicit `cantrip-os.run-runtime.*` commands. It retains
captured definition/target placements without resolving guest paths on the
Host. Host and Linux reconciliation operate on their own runtime families.

Actual Docker and installed-VM tests exercised the common supervisor in addition
to the earlier driver acceptance:

- A secondary Linux worktree ran its Primary definition, setup environment,
  before-launch commands, and purpose-specific secret. Its output was redacted.
  Repeating the completed start returned the same generation without another
  execution. Host authorization was never called.
- Host status/output/start commands could not access or retarget a Linux
  runtime. Changed workspace roots were rejected. An empty Host reconciliation
  left the Linux process running.
- Restart advanced the managed generation and stopped its old detached root
  child. Stop interrupted the next generation, escalated as necessary, and
  confirmed the root child had exited. Independent native work remained alive.
- A disposable Node Worker process started another real Linux generation and
  was killed with `SIGKILL`. A fresh supervisor read its durable journal,
  resumed the recorded native session, and stopped the known process tree.
  Reconciliation reported the absent in-memory runtime without recreating it;
  the child PID file remained unchanged.
- A short-lived before-launch step exposed a PTY resize/exit race. The driver
  now reads that process's actual completion after a resize error. It does not
  repeat the command or infer success from the resize failure.

The first complete lifecycle pass took 16.2 seconds in Docker and 122 seconds
in the installed VM, using the unchanged checksum-verified 0.6.0 packages above.
Focused common lifecycle/Host regression tests passed (29 tests). Standalone
strict integration-test type checking passed. Worker type checking retains its
five CUA/MCP baseline errors; the protocol public-surface test retains its seven
unreviewed baseline exports. The required repository check retains the same
`agentOperations` audit mismatch.

Native Server OS contracts passed (two tests), as did the complete 292-command
fixture comparison and command-boundary comparison. The full mutation comparison
matched all 234,912 cases, then failed its existing coverage receipt: the stale
`worker-command-task-model` registration names a schema that is unreachable from
both the current command graph and the preceding 285-command graph. The receipt
executed 98 of 99 registrations. That unrelated Task registration was preserved;
this is not a claim that the entire Native contract suite is green.

This checkpoint supplies the Worker lifecycle, not the Server Run API or header
source picker. Canonical captured runtime records and product routing remain
the next block. Evidence is under ignored `artifacts/phase3-run-lifecycle/`.

## Server Run placement checkpoint (2026-11-04)

Migration `0248` adds a separate execution identity and immutable Linux placement
capture to Run runtimes. Existing records default to Host execution. The owning
Server validates new Linux admissions against canonical Primary/target bindings
inside the admission transaction. Linux-owned worktrees use this path without
requiring a Worker-local source row.

- Node/PGlite tests verified distinct runtime and terminal IDs for Host and Linux
  Runs using the same linked worktree/configuration. Default Host lookups and
  reconciliation identities excluded Linux records; explicit scoped queries
  returned the intended record. A Linux stop targeted its own generation while
  the Host runtime stayed active.
- Replaying an admission retained its identity; changed captured roots were
  rejected. A replaced OS generation invalidated old admissions, retained old
  captures, and created a fresh runtime/terminal after the binding became ready.
  A Linux-owned source admitted a Run without a Host source row and rejected a
  Host admission for that worktree.
- Native Server tests exercised secondary Linux worktree admissions, scoped
  lookups, replay, stop, ownership checks, and capture immutability in both PGlite
  and real PostgreSQL. Direct SQL attempts to change a stored capture or
  execution identity failed. Native epoch keys matched the actual Node helper.

Focused Node runtime/chat/source migration checks passed (13 tests). Native
PGlite/PostgreSQL repository checks passed (two tests). Server type checking
retained its two existing Task errors. The required repository check retained
the same `agentOperations` audit mismatch. This cycle changes Server metadata;
executor packages remain 0.6.0, as tested in the preceding lifecycle checkpoint.

Public Run API dispatch, reconciliation/retirement routing, the header source
picker, and complete distribution acceptance remain pending. No product action
is represented as complete by these database tests. Logs are retained under
ignored `artifacts/phase3-run-placement/`.

## Public Linux Run API checkpoint (2026-11-04)

Both Server implementations route the existing Run lifecycle, status, protected
output, and reconnect operations through explicit Linux source selections and
immutable runtime captures. Client input contains binding epochs or a runtime ID;
it cannot supply guest paths, accounts, or executor transports. The guest executor
packages remain the checksum-verified 0.6.0 builds from the preceding checkpoints.

- Actual Node Server/Fastify → Worker controller/common supervisor → native guest
  operations passed in ARM64 Docker (11.05 seconds for the full source/Run test)
  and the installed AMD64 VM (100.12 seconds). Ordinary Run used the source's
  Primary even when selected through a secondary binding; explicit worktree Run
  used its independent Linux directory. Actual Python output identified each
  working directory and the workspace UID. The test decrypted the real protected
  output and stopped both processes through captured runtime IDs.
- Dropping the real Worker Start reply retained a Lost runtime. A different Start
  operation was rejected before another process launch. Explicit Stop confirmed
  termination and returned Idle. Stale binding generations were rejected without
  dispatch, and ordinary Host status did not expose Linux runtime records.
- A further Docker pass exercised actual reconnect dispatch with two distinct
  captures and the same shared definition Primary (11.54 seconds).
- Native HTTP authorization/routing parity passed against its explicit fixture
  Worker, including source selection, protected output envelopes, reconnect,
  stale generations, unknown delivery, and Stop. This fixture does not claim
  another real guest or cryptographic execution test. Native PGlite/PostgreSQL
  repository checks and source contracts also passed (four tests).
- Focused protocol/common Worker lifecycle checks passed (39 tests). Existing
  Server Run API, metadata, and connection-order checks passed (22 tests). Server
  type checking retained its two existing Task errors. `pnpm check` retained the
  same reviewed `agentOperations` digest mismatch; no audit exemption was added.
  Worker type checking retained its five CUA/MCP errors, and public export checks
  retained seven unreviewed exports after allowing the new selection schema.
  Native Clippy reported the unchanged `cantrip_os/control.rs` argument-count
  and `http/agent_tasks.rs` nested-condition findings. Standalone fixture type
  checking reported two dependent nullability errors in unchanged history and
  telemetry code, with no errors in the integration fixture.

The Worker can now confirm an explicit Stop after memory loss from its recorded
native journal. An unconfirmed cleanup stays unknown and can be retried with a
new Stop operation; it is never converted into a successful idle state by a
missing in-memory session. Host already-stopping behavior is preserved.

Logs and actual guest receipts are retained under ignored
`artifacts/phase3-run-product/`. The header source picker, safe definition
retirement/deletion, broader delegated project/Git/artifact tools, and fresh
Docker/ISO acceptance remain outstanding. This is not Phase 3 completion.

## Linux Run source picker checkpoint (2026-11-04)

The project header selects Host or a Linux checkout source/workspace and its
captured epochs. The ordinary Run button uses that source's Primary; an explicit
worktree action selects a bound target in the same source and workspace. Discovery,
validation, definition editing, and file/directory/device pickers use the selected
Linux definition source. Guest executor packages remain 0.6.0.

Actual product acceptance used Codex's in-app browser, a disposable Node Server
on port 4319, the existing test Worker, and the ARM64 Docker desktop. The desktop
was upgraded from executor 0.4.0 to the already verified 0.6.0 package, refreshed,
and its Primary/secondary bindings verified through Settings. The retained client
profile was reused at its original browser origin; the host user's browser and
development Server were untouched.

- Created and saved `Linux UI acceptance` through the Linux editor. Provider
  validation reported Linux. The Run definition lived in the Linux Primary.
- Header Run executed Primary despite a secondary terminal being selected.
  Browser-decrypted Python output reported UID 20000 and its exact Primary cwd.
- **Run in Worktree** executed the alternate path under the same UID. Switching
  the header to Host preserved that Run's Linux output and target; explicit Stop
  reported Stopped. A captured Primary tab also started and stopped its original
  Linux target while the header stayed Host.
- **Edit** from a captured Linux Run under a Host header opened the exact Linux
  definition and selected its source. The source/configuration selection survived
  a browser reload.
- Both Runs wrote distinct `run-ui-proof.json` files. Direct guest reads verified
  their bytes and UID 20000 ownership. Focusing each Run listed its intended files;
  opening the identical filename produced separate editor documents containing
  the respective Primary/secondary cwd. No Guest path was placed into a logical
  target's Worker path field.
- Restarted the actual Docker instance, refreshed its observation, and verified
  both bindings. The old header selection remained unavailable until explicitly
  choosing the current epoch; the saved definition returned on that selection.
  Captured old Run tabs kept Start disabled and retained their original targets.
- The new metadata APIs passed actual Docker Server/Worker/executor tests and
  native HTTP parity. Client tests cover unavailable source parsing, captured
  runtime identity, blocked Host actions while resolving a Run, and stable write
  admission IDs after a lost reply and adapter recreation. Pending write storage
  contains only a request hash and UUID, not definition contents.

Migration `0249` backfills Linux Run terminal file placement from immutable Run
target captures in one atomic statement, restoring the capture trigger before it
commits. New admissions write this capture directly. Native PGlite/PostgreSQL
checks exercised an actual pre-upgrade-shaped row, applied the real backfill,
and confirmed that later retargeting still fails. Existing Host terminals remain
Host-owned. Node Run persistence checks passed after the same change.

Validation: 79 focused app tests and 22 focused Server tests passed. Native
HTTP parity, both PostgreSQL/PGlite persistence suites, and two source-contract
tests passed. App type checking and the production build passed. Server type checking
retained the two existing Task errors. The public surface check retained its
seven previously unreviewed exports after adding the new source schema to the
allowlist. The required `pnpm check` reached the unchanged reviewed
`agentOperations` digest mismatch (`691b6132…` versus `c01cedeb…`); it is not
reported as passing.

Screenshots, raw guest file evidence, and validation logs are retained under
ignored `artifacts/phase3-run-source-picker/`. Older agent/editor/interactive-shell
resources retained their previous-runtime captures after the package upgrade;
this test did not silently retarget them. Their stale-resource recovery/history
presentation remains part of the acceptance follow-up.

Linux Run definition deletion remains disabled until its source-scoped runtime
retirement is integrated. Broader delegated Cantrip/Git/artifact tools, GUI launch
context, and refreshed distribution acceptance remain outstanding. This is not
complete Phase 3 acceptance.

## Captured Linux recovery checkpoint (2026-11-04)

Stored message and managed queue reads, plus chat live subscriptions, now use
account-owned routing rather than a current executable Linux context. A stale
Linux Plan read returns its canonical stored state. Execution and filesystem
operations retain their original generation checks. Both Server implementations
use this distinction for messages, queue, and live scope authorization.

A failed captured Linux terminal attachment retains its target and unknown
outcome, stops automatic reconnect attempts, and offers explicit reconnect even
before its first output. Ordinary Host reconnect behavior is preserved.

Validation: 34 app tests passed, including failed Linux attachment before/after
ready and the missing-worktree error regression. Eight Server persistence/live/
queue tests passed, plus a focused stored-history route test. Native HTTP tested
actual stale Linux captures with successful message/queue reads and owned live
subscriptions; PostgreSQL/PGlite generation tests passed. The actual workspace
query manifest was regenerated and its check passed. The Native observation
interface now groups its observation fields without suppressing Clippy. App
types passed; Server types retain the same two Task errors. Required pnpm check
still fails on the recorded agentOperations audit digest mismatch.

The next UI revision merges Host and Linux Run configurations into one list,
with per-configuration placement and destination choice during creation; the
previous header source switch is being removed at the user's request.

## Combined Run list revision (2026-11-04)

The header source switch has been removed. Host and CantripOS definitions share
one configuration list; Linux entries show their destination. Creating a config
chooses a destination only when multiple destinations exist. Host-only projects
go straight to configuration creation. Selection and editing belong to individual
configuration identities, including their captured Linux epochs. A missing Linux
entry stays unavailable rather than selecting Host.

Local validation: 57 focused app tests passed, including equal configuration UUIDs
on Host/Linux, scoped launch dispatch, unavailable selection retention, Host-only
controls, per-new-config destination choice, and existing Run interactions. App
type checking and production build passed. Required pnpm check reached the same
recorded agentOperations audit mismatch. No protocol or executor package changed.

Actual Codex in-app-browser acceptance created and saved a Host configuration,
showed Host and CantripOS entries together, executed the Host entry to exit 0,
and started the Linux entry on its exact Primary before explicitly stopping it.
The creation dialog showed destination choices within the new-configuration flow.
Screenshots and local validation logs are retained under ignored
artifacts/phase3-unified-run-list/. This revision supersedes the earlier global
source picker workflow. Full Phase 3 acceptance remains in progress.

## Source-scoped Run deletion checkpoint (2026-11-04)

Executor 0.7.0 supports revisioned Linux Run definition deletion. Both Server
implementations read the actual definition before retirement, serialize project
changes, and stop captured Host/Linux instances only in that definition's source.
A separate Linux checkout with an equal configuration UUID remains untouched.
Lost Linux runs require confirmed process-tree cleanup before metadata or the
shared definition can be removed. The combined Run list enables Linux deletion;
confirmed deletion selects a remaining entry without launching it. Unavailable
captured epochs still retain their identity.

Actual Server/Worker/package tests passed in ARM64 Docker (14.54 seconds) and the
installed AMD64 VM (143.99 seconds). Each started Primary and worktree processes,
rejected a revision mismatch without stopping them, lost the first real cleanup
reply, retained the definition, then explicitly retried the same delete intent
and confirmed both process trees and the definition were removed. The VM also
exposed a natural-exit/Stop identity race; the Worker now confirms recorded Linux
cleanup under the current Stop identity, with a focused regression test.

Codex's in-app browser created and ran a disposable Linux definition, deleted it,
and verified the actual guest file and process were gone while the existing
Host and Linux definitions remained. A second deletion verified selection cleanup.
The stale terminal displayed its retained Linux target and unknown outcome;
explicit reconnect returned to that state without a Host fallback.

Local validation: 36 focused app tests, 32 Worker tests, 11 protocol tests,
20 Server tests plus the expanded 12-test shared-source API suite, Native HTTP
and PostgreSQL/PGlite tests (3), and Native contracts (2) passed. The generated
Worker command alternatives validate all 525 registered alternatives. Direct
Vite production bundling passed. Standard app build/type checking is blocked by
13 existing provider-fixture errors introduced by the separate provider-limits
change; Server types retain two Task errors and Worker types retain six existing
CUA/MCP/provider-log errors. Required pnpm check still fails on the recorded
agentOperations digest mismatch. No checks were bypassed or changed.

Packages and evidence are retained under ignored artifacts/packages/ and
artifacts/phase3-run-retirement/. This supersedes the earlier disabled-deletion
checkpoint. Broader delegated project/artifact tools, GUI launch context, and
refreshed distribution acceptance remain outstanding; Phase 3 is still active.

## Worker-owned Linux MCP checkpoint (2026-11-04)

Linux native sessions now receive Cantrip MCP over an authenticated worker-local
HTTP endpoint. This reuses the existing broker's per-chat credential, active lane,
permission checks, operation limits, revocation, and expiry. The native app-server
connects from the worker; no broker credential, executable, or provider key is
installed in the guest. Tool discovery reflects the binding's allowed operations.
CodeGraph and Host computer use remain excluded. Host-only Run/worktree handlers
and Task creation are not advertised until their explicit source adapters exist.

Actual pinned native turns passed against ARM64 Docker (2.62 seconds of test time)
and the installed AMD64 VM (16.41 seconds). A deterministic provider exercised real
native shell/read/search, patch/write, and artifact creation in the selected Linux
source, followed by one Cantrip context tool through the new worker HTTP endpoint.
The test checked exact chat/worktree identity and actual guest artifact UID/cwd.
This validates the native tool loop with a fixture provider, not a new real-model
acceptance claim. No executor package change was needed.

Thirty-one focused broker/session/HTTP, managed configuration, tool catalog, and
Linux MCP tests passed. The HTTP test
uses a real MCP SDK client and checks wrong credentials, inactive/active lanes,
deactivation and expiry without replaying an operation. Worker type checking
retains the six recorded CUA/MCP/provider-log baseline errors with no new errors.
The broader existing stdio broker test retains its Task-create idempotence
annotation mismatch (the Task handler annotation is unchanged by this revision).
Required pnpm check retains the recorded agentOperations audit mismatch.

Evidence is retained under ignored artifacts/phase3-agent-tools/. Source-aware
Run/worktree/delegation adapters, attachment and artifact delivery, GUI context,
and final distribution acceptance remain in progress.

## Linux attachment and artifact routing checkpoint (2026-11-04)

Executor 0.8.0 adds content-addressed attachment copies outside the selected
checkout and source-scoped chat file references. Normal turns, steering and
queued native input present Linux paths to the agent. Native image/audio input
continues through the worker's established path. Both Server implementations
forward explicit Linux file roots, and source changes cannot fall back to a Host
file read. The helper shares filename rules with the worker without importing
worker logging, orchestration, or credentials.

Actual packaged product-files and native-turn fixtures passed in ARM64 Docker.
The native fixture read an uploaded Unicode input from its Linux path, executed
real read/search, patch/write and Python artifact operations, and called the
worker context MCP once. On the installed AMD64 VM, the native turn passed in the
parallel run; the larger filesystem test hit its initial 180-second budget. Its
standalone rerun with a 360-second budget passed in 100.42 seconds. The package
code was unchanged between those VM runs. Tests verified actual copied bytes,
separate chat destinations, retained copies across worker-helper recreation, and
rejection of a modified copy without overwriting it. File references report only
files within the captured source, including Unicode and binary files.

Local checks: seven attachment/native runtime tests, seven Server route tests,
37 app file-reference/opening tests, Native HTTP source routing, and two Native
contracts passed. Worker types retain six recorded baseline errors with no new
errors. All 527 Worker command alternatives validated before rebasing. After
rebasing onto current Main, the focused Docker tests passed again (nine tests,
including the native attachment/MCP turn), and seven Node route tests passed.
The broader alternative registry now also encounters Main's newly introduced
initial-label fields, which lack baseline fixtures; the new Linux root fixtures
remain valid. Native contracts/HTTP tests passed before rebase. The rebased
Native build is blocked by Main's `automatic_title.rs:370` passing `&Value` to a
function now requiring `Option<&Value>`. This change does not modify that code.
Required pnpm check retains the recorded agentOperations audit digest mismatch.

Packages: artifacts/packages/cantrip-os-executor_0.8.0_<arch>.deb. SHA-256:

- ARM64: 600d05192a7795c543d49f07fc750eb5658c0abf378d163d5222319c71eaf951
- AMD64: 4675542d754179687cc8238e0b77b59ab80cc5f931cf8654d968ed4407eeb6d7

A real product-dispatched local Qwen turn uploaded the 46-byte Unicode fixture,
read and searched its guest copy, and called the worker context MCP once. The
provider emitted incompatible payloads for the native freeform patch tool; after
an explicitly confirmed Stop, a new turn used the native shell's intercepted
`apply_patch` heredoc to create the six-line Python program in Linux. It executed
that program against the uploaded guest path and independently verified the
251-byte result, workspace UID 20000, exact Primary checkout and input checksum.
The worker connection was interrupted during this turn. The final response was
recovered from native history after reconnect without rerunning the edits. The
returned Markdown file link and Explorer both opened the same Linux document in
Cantrip's editor. Neither the script nor artifact appeared in the Host fixture.
The artifact SHA-256 is
fccdf8b0a423fb8900b983ea44a6fcb5d3968529c49d73d925a76513dd12d401.

This establishes real-model attachment-to-artifact delivery; it does not claim
the Ollama freeform tool mismatch is fixed. The fixture-provider native tool loop
separately covers direct patch calls on compatible payloads. An earlier queued
correction received a truthful Start failure after the Stop fence and was not
replayed. Temporary app diagnostics were removed before the final browser test.

Fixture logs, native receipts, verified artifact bytes and browser screenshots
are kept under ignored artifacts/phase3-chat-artifacts/. GUI context and refreshed
media remain in progress. Host-only Run/worktree/task-creation MCP adapters remain
explicitly unavailable in Linux sessions; the corresponding supported product
workflows retain their captured placements.

## Assigned workspace GUI checkpoint (2026-11-04)

Executor 0.9.0 adds `cantrip-desktop command [args ...]`. It resolves the current
workspace UID through the authoritative workspace registry, keeps that UID and
cwd, selects its assigned X display/home/runtime directory, discards inherited
auth/Wayland/session context, and executes the app with a private D-Bus session.
It does not start or substitute a desktop. Ordinary commands still receive no
DISPLAY. Root administration explicitly selects a workspace account before
launching a GUI app. All files live in the optional executor package.

Actual ARM64 Docker acceptance passed in 6.62 seconds (9.59 seconds including
runner setup). Two fresh accounts used displays 152 and 153 and different Unicode
working directories despite deliberately poisoned personal-console environment
values. Native process execution created xterm windows and verified the actual
child UID/cwd/environment. Each display's X tree contained only its own test
window. Stopping one desktop left its independent native shell alive; attempting
a later GUI launch failed against that assigned display without another target
being selected. The second desktop remained usable. The first test attempt read
the proof file before the xterm child wrote it; the test now polls the actual file.

Codex's in-app browser opened the existing real agent's workspace. A native GUI
launch displayed the agent-produced JSON artifact from the exact Linux checkout
as UID 20000. Native cancellation removed that xterm window while leaving the
desktop alive. Screenshots and the captured native process identity are retained.

Both ARM64 and AMD64 0.9.0 packages were built using the explicit
`CANTRIP_OS_EXECUTOR_RUNTIME_CONTEXT` option, reusing the complete tested native
bundles from the corresponding 0.8.0 packages while rebuilding the shared helpers
and Debian package. The GUI change does not change native executor source. Full
native-source builds were attempted but queued behind another build's shared
compiler cache; only our two queued jobs were canceled. The normal Docker target
still selects the compiler stage by default, verified through Docker's target
outline. These results do not claim a fresh native compilation for 0.9.0.

The installed AMD64 VM accepted the package upgrade. Its initial GUI run wrote
proof with UID 20040, the correct Unicode cwd, display :140, no inherited
Xauthority/Wayland values and a private D-Bus address. The window-tree check did
not see the xterm within its initial 30-second wait. With a 120-second window
wait and no guest code changes, the full two-workspace rerun passed in 61.52
seconds (65.67 seconds including runner setup), including the same no-crossover,
correct child environment, independent shell and stopped-display assertions.

Seven OS lifecycle/carrier tests passed. Worker types retain the six recorded
baseline errors with no new errors. Required pnpm check now stops earlier at
Main's chat-turn-runtime.ts line budget (2029 lines against 1999); this cycle does
not modify that file. Scoped formatting, Python syntax and diff checks passed.
Package SHA-256:

- ARM64: ebc31166b2e11f061dbb6babc739888407611820da862a2fcda97b9d5c8e8183
- AMD64: 626c4bd356307acc12e5a6719f90e9181550983b73fae78013f8ca19860db367

Packages and explicit native contexts are retained under ignored artifacts/packages/
and .build/gui-runtime/. Logs, receipts and browser images are retained under
ignored artifacts/phase3-workspace-gui/. Fresh distribution and package lifecycle
acceptance remain in progress.

## Phase 3 acceptance and distribution (2026-11-04)

Phase 3 execution/source ownership is implemented. Earlier checkpoints above
record what was available at each merge; their pending-work statements are
historical. The [product guide](PRODUCT_WORKFLOW.md) describes the current
attachment, source selection and execution workflow. Linux computer use and
integrated remote desktop remain outside this phase.

The public Docker and ISO scripts now include executor 0.9.0 and workspace
package 0.3.0 by default. `CANTRIP_OS_EXECUTOR=0` omits the executor;
`CANTRIP_OS_WORKSPACES=0` defaults to omitting both integration packages. An
explicit executor choice wins and apt enforces package dependencies. The
ordinary Debian/IceWM desktop works without either integration package.

### Complete workflow evidence

- A real local-provider Cantrip agent used its captured Linux Primary checkout,
  read/searched an uploaded UTF-8 attachment, invoked Worker-owned HTTP MCP,
  wrote and executed Python, and returned a 251-byte JSON artifact. Its UID was
  20000 and its cwd was the intended guest checkout. Host copies were absent.
  Explorer and a returned Markdown file link opened the same Linux file in the
  editor. A separately captured terminal observed the source bytes. Ollama's
  malformed custom-tool payload required a new explicitly stopped/restarted
  turn and shell `apply_patch` interception; this is not a claim that that
  provider's custom-tool protocol was repaired.
- Separate native-runtime fixtures exercise the real pinned app-server's
  read/search, native patch/write, attachment transfer, HTTP MCP and Python
  artifact execution. Actual fresh Docker tests passed (2 tests, 30.75 seconds);
  the freshly installed VM passed the same two tests (75.00 seconds). These
  deterministic model fixtures are distinct from the real-model product test.
- Earlier actual Docker/installed-VM checkpoints cover Linux-owned exact-revision
  provisioning, Git worktrees, linked edits in both directions with unchanged
  Host Git metadata, explicit Linux dependency overlays, executable bits,
  symlinks, Unicode paths, relevant native file watching and two separate targets.
  Product Run acceptance covers independent Primary and explicit-worktree
  targets, setup/environment, output, stop/restart and source-scoped deletion.
  The combined Run list has per-configuration destinations and no global picker.
- Actual transport interruption recovered saved history/outcomes without replaying
  a mutation. Stale bindings/documents/chats are rejected, preserving drafts and
  history. Worker-loss Run cleanup is reported truthfully rather than guessed.
- Fresh installed-VM cancellation passed (17.82 seconds including runner setup):
  a sudo parent, detached root child and descendant were stopped while an
  independent native session remained alive. Earlier Docker cancellation and
  two-desktop GUI checks passed. Closing a desktop leaves independent commands
  alive; `cantrip-desktop` uses only its assigned display and fails there if it
  is stopped, without selecting the personal console.

### Fresh Docker, package lifecycle and bootable media

A fresh native ARM64 image, `cantrip-os-acceptance-test:dev`, ran with 4 GiB and
only its three named data volumes. Its image ID is
`sha256:e3247343dcaba4ac61dc8f5ced03b1b3d076d7c5fb7159090209a9ec94ef4a12`.
The foreground `pnpm os` printed browser/VNC/root-shell information, streamed
logs, and stopped the container on SIGINT while retaining volumes. The ordinary
OS build with `CANTRIP_OS_WORKSPACES=0` booted with both packages absent and a
working IceWM desktop, Python and nano. Browser checks used only Codex's in-app
browser.

Fresh 0.9.0 package lifecycle tests passed in Docker and the installed test VM:
disable, remove, reinstall, purge and reinstall retained workspace data and
instance identity. The personal desktop and an independent workspace desktop
kept running. Deliberately unsupported saved-state version 99 produced an actual
startup failure without overwriting that state; restoring it recovered service.
This intentional failure is part of the passing test, not a clean-start claim.

The refreshed AMD64 ISO was actually built and booted under QEMU TCG (2 CPUs,
4 GiB). Automatic login, sudo, DHCP/HTTPS, IceWM, xterm and Chromium rendered.
`cantrip-install --erase /dev/vda` installed to a new disposable 16 GiB virtual
disk; both BIOS and EFI bootloader installation completed. The VM then booted
from `/dev/vda3` (ext4) with no ISO attached, using kernel
`6.12.115+deb13.1-amd64`. This run exercised BIOS disk boot; it does not claim a
fresh EFI firmware boot or physical/cloud hardware test.

The installed system retained instance ID, workspace UID/GID/home/display,
workspace document bytes and the native executor's `cap_kill=ep`. Its runtime
generation changed and the old live-ISO handle was actually rejected. The new
installed system then passed the native operations and root-tree cancellation
checks above. Test SSH access was installed only in disposable acceptance VMs;
this does not add a public SSH service to the distributed OS. Live shutdown
emitted a nonfatal Debian virtio-GPU queue warning before clean QEMU exit. The
installed test VM also logged an unavailable AF_VSOCK CID from its test SSH
generator; ordinary TCP SSH and the execution tests succeeded.

### Artifacts, validation and limits

The ignored local distribution artifacts are:

- `artifacts/cantrip-os-amd64.iso`, its `.sha256` and `.packages` inventory.
  ISO SHA-256: `eda20dbb59e6f6e4784cc01e59bb9820798719cea877686a495f8d5dc77cb0a8`.
- `artifacts/packages/cantrip-os-executor_0.9.0_arm64.deb`:
  `dda5bc85c619dce15c3a9397e5806822b00084e35d32dcb50ff0492e628d9511`.
- `artifacts/packages/cantrip-os-executor_0.9.0_amd64.deb`:
  `7db6195637b801daeea0272a7146ff243e11b5dc51e8e5252c382fae4cb1f906`.
- `artifacts/phase3-distribution/`: build/test logs, live/installed identity
  proofs and browser images. Prior real-model and GUI evidence is retained under
  `phase3-chat-artifacts/` and `phase3-workspace-gui/`. Earlier 0.9.0 packages are
  archived with that GUI checkpoint rather than confused with the refreshed ones.

These packages rebuild shared helpers and packaging using explicit tested ARM64
and AMD64 native bundles from 0.8.0. Native source did not change for the GUI or
distribution cycles; this is not a claim of fresh native compilation for 0.9.0.
The ordinary build still compiles the pinned source by default. Seven OS carrier/
lifecycle tests passed; scoped formatting and diff checks passed. Required local
`pnpm check` was attempted and stops on Main's unrelated
`chat-turn-runtime.ts` decomposition budget (2029 lines, maximum 1999). Earlier
checkpoints record focused protocol, both Server implementations, Worker, app and
native checks, including their unrelated baseline failures. No hosted checks are
claimed.

Current limits: automatic re-admission of old chats after OS restart is not
provided; verify the source and create a new Linux agent. Explorer requires an
explicit refresh for external edits. Linked Git mutation stays with the original
Worker; broad Linux-owned Git graph/history UI adapters and Host-only MCP
Run/worktree/task-creation tools are not all adapted. Use the source-aware product
workflows. Private repository credentials must already work inside Linux.
Linux computer use, integrated desktop transport, general SSH/SFTP/TCP product
access, cloud provisioning, backups and automatic mirroring remain later phases.
The tested platform matrix is native ARM64 Docker and emulated AMD64 live/
installed VMs, not arbitrary hardware.

## Phase 4: native Linux backend checkpoint (2026-11-04)

The existing `cantrip-cua` helper now has an explicit Linux X11 backend. It uses
one local display connection, the supplied desktop generation and a fresh helper
generation. Capture and native input never discover another display or reconnect
to a replacement. Input uses the shared participant ownership/sequence/cleanup
machinery, with an additional display-level fence while another participant owns
physical holds. Long gestures execute outside the service request loop.

An actual ARM64 Docker test on two workspace desktops passed in 2.98 seconds.
A real xterm received the exact UTF-8 string `Cantrip Linux 日本語 café 🌙`,
including uppercase, accents and emoji bytes. Its selected font rendered some
characters as missing glyphs; that is not a claim of complete font coverage.
Native root capture returned actual pixels. Another real X client received drag,
wheel and repeated button events. Stale display identities and repeated input
sequences were rejected. Cancellation of a 60-second hold released the actual X
button state; capture on the other desktop remained independent.

Repeated acceptance caught a keymap race: restoring/reusing one temporary keycode
between characters lost or changed text while clients refreshed XKB state. The
backend now uses existing layout mappings and keeps allocated Unicode mappings
stable for the connection. Empty slots are restored on teardown unless an
external layout change replaced them. Exhausting the finite free slots is a
reported capacity failure, not a clipboard fallback.

The same test passed in the installed AMD64 VM in 67.94 seconds, using explicit
displays 104/105 and workspace UID 20004 for the first target. Its inherited
DISPLAY was deliberately :0; the test still operated only the explicit
workspace displays. The VM had 2 emulated CPUs and 4 GiB RAM. The test fixture
uses an actual PTY-child readiness marker and an unmanaged X window for exact
coordinate assertions, avoiding assumptions about window-manager placement.

Both ARM64 and AMD64 Linux builds compiled. Linux Clippy with all targets and
warnings denied passed. Seven existing integration suites passed (83 tests).
The full library run passed 85 tests and retained one existing fake-backend
shared-pointer permission assertion failure in `input::targeted_tests`; this
cycle does not change that test or its authorization path. Required local
`pnpm check` stops on existing decomposition budgets in `build-app.ts`
(1503/1500) and `chat-turn-runtime.ts` (2101/1999 after rebase). Formatting/diff checks passed.

This checkpoint is a native backend, not completion of Phase 4. Optional package
lifecycle, clipboard APIs, captured real-agent integration, integrated streaming/
takeover, SSH/SFTP/VNC/TCP access, and refreshed distribution acceptance remain
required. The personal OS and default Host helper selection are unchanged.

## Phase 4: optional native desktop package (2026-11-04)

`cantrip-os-remote` 0.1.0 packages the Linux helper, root-only control service,
protected stdio carrier, lifecycle hooks and installed-system unit. The helper
runs as the selected workspace account. The existing Worker retains its CUA
service and credentials; this package does not install a Worker or agent loop.
Its default retained state is inside the existing workspace data volume.

Actual lifecycle tests passed in native ARM64 Docker and the installed AMD64
VM (2 emulated CPUs, 4 GiB). Tests exercised:

- Real PNG capture; actual held-button release after clean EOF, carrier SIGKILL
  and remote-manager SIGKILL; continued independence of the second display.
- Helper UID, home, assigned display and restricted inherited environment.
- Desktop stop closing an idle CUA carrier while an independently launched
  shell process stayed alive; reopening advanced the desktop generation.
- Rejection of incorrect owner, Worker, instance, workspace, executor-manager,
  desktop and remote-service identities without opening a replacement.
- Actual executor-service retirement closing the carrier and releasing held input
  while the other workspace desktop remained available.
- Disable/remove/reinstall, running upgrade, purge/reinstall, retained workspace
  document and enable preference, root-only control and preserved executor-state
  permissions. Unsupported preferences were preserved; a running service could
  still be stopped after that preference became unsupported.

The installed running-upgrade test waits for the actual control endpoint;
systemd process startup alone does not imply that socket is ready.

The idle-carrier test first failed: stopping X left a helper waiting for another
request. Lifecycle observation now pins the actual executor/workspace service
peers using pidfds and reads the authoritative workspace generation/desired state.
It retires the old carrier without depending on the availability of either
administrative request queue. The passing tests include that correction.

The normal Worker `CantripCuaService` passed an actual packaged integration test
through Docker and strict host-verified SSH to the installed VM. It checked real
capture and protocol-valid click/key/text dispatch receipts. Disposable fixture
scopes explicitly authorized their display; this is not yet canonical real-agent
admission. Native application text bytes were tested in the earlier checkpoint.

A freshly built ARM64 image, `cantrip-os-phase4-package-image:dev`, includes all
three optional packages and passed the lifecycle harness plus the Worker test.
It ran with a 4 GiB limit and only the existing personal/workspace/executor named
volumes. Image identity:
`sha256:f5c7cebc78cc1933b00ecdba1ec7e3762eeb691ad4a736aa32a7cc3f793673da`.
The new ordinary-OS image with `CANTRIP_OS_WORKSPACES=0` booted with all three
integration packages absent, an actual X desktop/browser endpoint, Python and nano.
An initial test port was already allocated; the disposable image test used its
own ports 16140/16141/15912 instead of changing the existing listener.

Built package SHA-256 values:

| Package architecture | Bytes   | SHA-256                                                            |
| -------------------- | ------- | ------------------------------------------------------------------ |
| ARM64                | 1313100 | `0bf180ce93f96e54c97a6f5f252db78c28536045b2e7ba8c957981e1819fd98e` |
| AMD64                | 1506516 | `7220d622e044a7fc6fdb4f63f08657326402baaab097e47e46cf9d64a47b8b09` |

Five focused Worker suites passed (75 tests, 24 platform skips); seven OS/host
Node tests passed. Linux Clippy with all targets and warnings denied, Rust format,
Worker TypeScript, Python/shell syntax, scoped formatting and diff checks passed. Required local
`pnpm check` remains stopped by unchanged decomposition budgets in `build-app.ts`
(1503/1500) and `chat-turn-runtime.ts` (2103/1999 after rebase).

Docker/ISO inclusion and source watching are wired. A refreshed ISO containing
this package has not yet been built or installed. Phase 4 remains in progress:
real-agent routing, clipboard APIs, integrated streaming/takeover, managed
SSH/SFTP/VNC/TCP and final distribution acceptance are still required.

## Phase 4: captured agent CUA routing checkpoint (2026-11-04)

Remote package 0.2.0 adds expected-placement validation before opening a desktop
and connection-scoped cleanup. The Worker now routes normal agent CUA and
encrypted previews to the Server-authorized, immutably captured Linux placement.
HTTP MCP and provider credentials stay on the Worker. Guest full-display access
does not require the Host Cantrip-window grant. Saved agent observations remain
readable without starting a desktop/helper.

Both ARM64 Docker and the installed AMD64 VM passed the expanded package lifecycle
harness. Delayed cleanup from an old connection could not stop a new connection
or release its held X button. An incorrect expected runtime could not start a
stopped desktop. Previous capture, process/service death, two-display separation,
disable/remove/purge/reinstall and data-retention checks also passed.

Both architectures passed two actual packaged Worker integration cases. The
second uses the real `cantrip_cua/js` SDK, HTTP MCP client/broker, coordinator,
fresh-authority callback and captured-placement registry. It inventories and
attaches the expected X11 desktop, clicks, sends Escape, captures a valid PNG and
checks session state. The Host helper launch count remained zero; no
`allowCantripApp` grant was supplied. The root connection was gone after the last
lease released. ARM64 took 1.28 seconds for both cases; the emulated AMD64 VM took
6.67 seconds. These are deterministic admitted-turn fixtures, distinct from a
real-provider product conversation.

The TypeScript/PGlite captured-chat tests passed, including inheritance of enabled
CUA policy and identity-only authority projection. Native Rust Server projection,
17,122 contract cases and repository tests passed. Repository behavior was tested
against actual PGlite and an owned ephemeral PostgreSQL 17 process. Worker
TypeScript and focused routing/authorization/preview/MCP tests passed. Native
Linux formatting, strict all-target Clippy and all 86 library tests passed.

The full Worker suite passed 2,686 tests with 153 skips and one timeout in the
existing encrypted-history batch test. That case passed alone at its unchanged
timeout; the original parallel-run failure is retained. All 1,090 protocol tests
passed, including captured authority dispatch and identity-mismatch rejection.
The reviewed desktop-placement exports are included in the compatibility list.
Server and Worker TypeScript checks passed.

The fresh ARM64 image `cantrip-os-phase4-product:dev` includes remote 0.2.0 and
the existing workspace/executor packages, with a 4 GiB limit and only the three
existing named data volumes. Its image identity is
`sha256:481c21e10ce39db62099f1e10b3e198f26ee3e5503b4e2522ad3150203f0b223`.

| Package architecture | Bytes   | SHA-256                                                            |
| -------------------- | ------- | ------------------------------------------------------------------ |
| ARM64                | 1314124 | `3185f443eb4b378348bccfebdd295a932757af066deb4500c629fc8edb53c2ed` |
| AMD64                | 1507004 | `c13e86d3e97204eb2b40dfc0ac8532387e91ab8ccdafb677883d6fc5494eb471` |

Required `pnpm check` still stops at the existing server decomposition budgets:
`build-app.ts` 1503/1500 and `chat-turn-runtime.ts` 2122/1999. A refreshed ISO,
clipboard APIs, integrated streaming/takeover and managed SSH/SFTP/VNC/TCP remain
required for Phase 4 completion.

Actual product acceptance exposed two additional Phase 3 exclusions: ordinary
chat dispatch omitted Linux CUA authority, and native turn resolution returned
no execution for every Linux environment. Both exclusions are removed. Worker
command validation now checks the complete captured desktop identity and
execution scope in TypeScript and Rust. A Linux native-lifetime regression
checks root/child resolution, wrong identities and cancellation; its four-suite
run passed all 58 tests.

A real Local Qwen product turn then called `cantrip_cua/js`, attached the assigned
X11 display and returned an actual 1440×900 PNG. The first call used invalid
top-level `return`; the model corrected its script and succeeded. The session
reported the captured chat, Worker, native thread and turn. Host Cantrip-window
access remained disabled. Browser navigation and a native GUI file task are
being exercised separately; this capture is not full Phase 4 acceptance.

## Phase 4: clipboard, pointer and geometry checkpoint (2026-11-05)

Remote package 0.3.0 adds plain UTF-8 clipboard reads/writes, explicit physical
pointer movement and live RandR resizing to the first-party native CUA contract.
The JavaScript SDK exposes `readClipboard`, `writeClipboard`, `pasteText`,
`movePointer` and `resizeDesktop`. Existing logical `moveCursor` behavior is
unchanged. Operations retain the captured workspace/session authority; the macOS
backend rejects these Linux desktop operations without changing Host state.

Both ARM64 Docker and the installed AMD64 VM passed the actual package lifecycle
harness. New checks round-tripped more than 70,000 characters including 512
distinct CJK characters, observed independent clipboards on two displays, queried
the physical X pointer, and captured a resized 1280×720 desktop without changing
its identity or generation. Stale clipboard and resize requests were rejected.
The previous EOF, held-button cleanup, carrier/manager death, desktop retirement,
service retirement, upgrade, disable/remove/purge/reinstall and retained-data
checks also passed on both architectures.

Each architecture passed both actual Worker integration cases, including the
real packaged JavaScript SDK, HTTP MCP broker, coordinator, native lifetime and
captured-placement routing. The SDK case exercised the new operations on the
assigned desktop. The Host helper never launched. ARM64 took 32.81 seconds for
the test bodies; the emulated AMD64 run took 38.18 seconds. These loaded-host
acceptance timings are not streaming performance measurements.

Native macOS tests passed all 224 cases across the library and integration
suites. Linux passed formatting, 87 library tests and strict all-target Clippy.
The focused Worker run passed 192 tests with 35 platform skips; its additional
native-backed JavaScript run passed all 51 tests. All 1,094 protocol tests passed.
Worker and App TypeScript checks passed, and both Rust Server CantripOS contract
tests passed. The first SDK run exposed an omitted cursor action enum value;
the corrected contract and complete session parse regression passed afterward.

The initial Server TypeScript run reported a possibly-undefined `identity` at
`native-logical-inputs.ts:378`, in a file unchanged by this cycle. After rebasing
onto newer Main, both Worker and Server TypeScript checks passed. The initial
required `pnpm check` stopped at decomposition budgets: `build-app.ts` 1503/1500
and `chat-turn-runtime.ts` 2122/1999. These original failures remain recorded.
The final rebased check again stopped at the budgets, now 1504/1500 and
2175/1999 respectively, in files unchanged by this cycle.

| Package architecture | Bytes   | SHA-256                                                            |
| -------------------- | ------- | ------------------------------------------------------------------ |
| ARM64                | 1343092 | `71940d4f9d7cfd5a3aee3537697348d77c841d6d0b27430cf91e7ebb2947dc01` |
| AMD64                | 1546036 | `c9611b1721131bec030b1530713af234523026af1be4bfaca1f5c1e54122e0cd` |

Clipboard support is text-only, bounded to 1 MiB, and scoped to the native helper
and desktop lifetime. The existing JavaScript result limit remains 32 KiB.
Resizing selects an actually supported RandR mode; unsupported modes report the
real failure. Unconfirmed mutations have an unknown outcome and are not replayed.

This checkpoint does not complete Phase 4. Integrated streaming, exclusive human
takeover, managed SSH/SFTP/VNC/TCP, final real-agent GUI file acceptance and
refreshed bootable media remain to be delivered and verified.

## Phase 4: integrated viewing checkpoint (2026-11-05)

Project Settings → CantripOS → Open desktop creates an encrypted Remote Desktop
view for an explicitly selected Linux source. The Server persists the source's
worktree/binding, binding/attachment/runtime generations and observed desktop
generation, validates current
authority before and after opening, and supplies private execution transport
only in the Worker command. A migration admits this configuration and prevents
retargeting the saved capture. Retired views remain inspectable/removable.

The Worker shares the native guest connection with agent CUA and reuses native
capture plus the existing adaptive JPEG and WorkerLink transport. No Host helper,
Host application launch, or legacy Host input/capture fallback is used for this
path. The current viewer is read-only; human takeover and its input controls
remain a following Phase 4 cycle.

The actual packaged SDK case passed on ARM64 Docker and the installed AMD64 VM.
It opened a real JPEG stream, attached two viewers, dispatched normal agent
input/clipboard/resize, rejected an unowned viewer paste, detached the last viewer
without interrupting the agent's next screenshot, then reopened viewing and
retired the agent while frames continued. The final AMD64 retry took 13.35 seconds
for the test body, with its first JPEG after 3821.4 ms (3328 bytes). An earlier
loaded AMD64 run timed out at 120 seconds before first-frame completion; that
failure is retained. The successful retry used the unchanged timeout. The ARM64
expanded case passed in 19.93 seconds during concurrent local inference. These
are acceptance timings rather than controlled comparative stream benchmarks.

The actual Cantrip UI opened the assigned 1440×900 desktop over WorkerLink relay
and reconnected to the same destination. Idle viewing reported about 30 FPS;
concurrent local vision inference produced substantial contention and lower
reported frame rates. A point-in-time Docker measurement was 395.9 MiB of a
4 GiB limit and 29.90% CPU. This includes the personal and assigned desktops in
the test guest; it is not a capacity recommendation. Comparative streaming,
active multi-desktop resource testing and refreshed media remain outstanding.

A real local Qwen turn used normal `cantrip_cua/js` in that product workspace,
launched Mousepad through the assigned Linux shell, pasted three lines through
the desktop clipboard and saved `phase4-gui.txt` through the GTK Save As dialog.
It then read the saved file. An independent read confirmed exactly 73 UTF-8 bytes:

```text
CantripOS GUI acceptance
Clipboard café 日本語
Saved through Mousepad
```

There are two newline bytes and no trailing newline. No shell/file write created
the document. The minimal editor font displayed missing CJK glyphs, while the
saved Japanese bytes were correct. Product screenshots are retained with the
ignored local acceptance artifacts. This is distinct from the earlier real-agent
Chromium navigation and native/package fixtures.

Local validation passed 23 focused Worker tests, the two new protocol placement
tests, and seven Server tests covering real PGlite source capture/retirement,
Remote Desktop routes and authority retirement during grant issuance. Rust
CantripOS contract tests passed; the new desktop resolver also passed against
native PGlite and an owned ephemeral PostgreSQL instance. The first PostgreSQL
test invocation lacked its required binary-directory environment variable;
the configured retry passed. Worker, Server and App TypeScript checks passed.

The public-export compatibility test reports 2221 exports against a 2220
expectation on both this branch and an independently extracted unchanged Main
snapshot. The new desktop export is explicitly reviewed without changing the
legacy fingerprint. Required `pnpm check` stops at unchanged Server budgets
(`build-app.ts` 1504/1500; `chat-turn-runtime.ts` 2182/1999). The separate repository
budget check reports unchanged `native-commands.ts` 2049/2000. These failures are
recorded rather than counted as passes. Full Phase 4 remains in progress.

The final pinning pass uses remote package 0.4.0. New-view preparation observes the
actual native monitor before persisting its desktop generation. Saved viewers
pass that generation to the guest open operation; stopped or replaced desktops
are rejected without starting a replacement. Both architecture lifecycle suites
exercise this behavior. An older incomplete capture remains readable/removable
but cannot reconnect. The product agent’s returned Markdown link was clicked in
Cantrip and opened the Linux editor with the exact three saved lines.

Final focused checks passed 24 Worker, eight Server and three placement protocol
tests. Both Rust CantripOS contract tests passed. Worker and Server TypeScript
checks passed after the pinning change. An initial package install exposed an
accidentally raised workspace-package dependency; it was restored to the actual
0.3.0 workspace minimum and both remote packages were rebuilt. An initial new
source-replacement test had an incorrect no-revoke expectation; the corrected
assertion verifies the actual revoked grant.

Both final 0.4.0 destructive package suites passed on ARM64 Docker and the
installed AMD64 VM, including pinned opens while stopped and after replacement,
held-input cleanup and remove/purge/reinstall with retained desktops and files.
Both final actual Worker SDK cases passed on each architecture. The final SDK
run took 3.38 seconds in ARM64 and 11.46 seconds in emulated AMD64 for the test
bodies; first JPEG times were 315.4 ms and 1788.8 ms respectively. These remain
acceptance timings, not controlled streaming comparisons.

| Package architecture | Bytes   | SHA-256                                                            |
| -------------------- | ------- | ------------------------------------------------------------------ |
| ARM64 0.4.0          | 1343220 | `fec5a61a1864739759be579bcfbc1e4e81930f7b5e50bf1e8b79981fa2e693a8` |
| AMD64 0.4.0          | 1546116 | `2804cfcb7a4fbd4b4eed0842408b9f133258eb7baa85f0502d9e3583a5646c95` |

The final product exercise reconnected the captured viewer, stopped its desktop,
and observed rejected reconnects while the actual workspace remained stopped.
Explicit **Open desktop** then created a new view with a different observed
desktop generation. The old row retained its original generation. Capture-error
status remains native, reports zero FPS and identifies Linux desktop
unavailability rather than implying a Host compatibility capture.

After rebasing onto Main `dd0ba7161`, the focused Worker (24), Server (8), App
(10), Rust source contracts (2), and both native PostgreSQL/PGlite repository
cases passed. Worker and App TypeScript checks passed. Server TypeScript now
reports three errors in unchanged Task Goal callback/routing code; the exact
same errors were reproduced by checking the clean Main checkout. The final
required `pnpm check` stops at unchanged Main budgets: `build-app.ts` 1513/1500
and `chat-turn-runtime.ts` 2199/1999. The full protocol run initially had 1096
passing tests and four failures across source/built compatibility tests. The
new preparation command needed its explicit additive review before the legacy
counts; that assertion now passes while the pre-existing root-export count
failure remains (2221 versus 2220). No legacy fingerprint was changed.

The owned QA database had already applied the earlier unmerged migration under
number 254. After Main used 254 for Task Goal input, this cycle moved to 255.
The isolated QA database was backed up, then both actual SQL changes and their
matching migration hashes were applied transactionally; no source identity was
invented for the older incomplete view. Fresh repository migration tests passed.

After rebuilding the protocol package with that explicit command review, the
complete protocol run passed 1098 tests. Its only two failures are the source
and built copies of the already-reproduced root-export baseline assertion.

## Phase 4: human takeover checkpoint (2026-11-05)

Optional remote package 0.5.0 permits trusted input participants only on the
explicitly assigned guest X11 monitor. The existing Host/window restriction
remains in place for other backends. Integrated views expose **Take control**
and **Return to agent** through their existing Server-authorized, captured
WorkerLink attachment. One transient human lease is shared across the guest
service's views; it does not change durable placement or move an agent.

Takeover fences guest agent CUA immediately, interrupts active JavaScript without
revoking the admitted turn, cancels queued/native agent input and waits for
native cleanup before opening human input. Return releases human holds first.
A second viewer cannot steal the lease or return it, and stale lease IDs and
input epochs cannot dispatch. Disconnect or explicit surface suspension ends the
human lease and releases input. Only fresh authorized agent calls can proceed;
canceled/uncertain actions are never replayed. Shell processes remain independent.
An invalid native close acknowledgement retires the helper instead of handing
input to a human with uncertain cleanup.

The actual ARM64 Docker and installed AMD64 Worker SDK cases independently
queried X11 physical button state. They observed a long-running agent timeline
holding the left button, took over through the viewer adapter, and observed the
button release. A normal agent MCP request was rejected during human control.
The human copy path returned the expected Unicode clipboard contents. A second
viewer was denied; actual human pointer input reached the intended coordinates
and held the button. A stale return nonce did not release the lease; the correct
return released the physical hold. Old-epoch input did not post. A fresh normal
SDK call attached and captured on the same admitted turn after return. Suspension
and viewer disconnect also released actual human holds, and resumption minted
a new input epoch. The final test bodies took 2.94 seconds in ARM64 and 19.83
seconds in emulated AMD64. These are acceptance timings, not stream benchmarks.

Both architectures passed the destructive package lifecycle harness, including
clipboard/resize/isolation, carrier and manager death, desktop/runtime retirement,
upgrade, disable/remove/purge/reinstall, and retained files/desktops. The optional
package split remains independent of the ordinary OS desktop and delegated shell.

| Package architecture | Bytes   | SHA-256                                                            |
| -------------------- | ------- | ------------------------------------------------------------------ |
| ARM64 0.5.0          | 1343052 | `1ae67f896710f081775b3281f67401e05e0fab19d92cbed4d20ba695ae80130f` |
| AMD64 0.5.0          | 1548280 | `ac5ea5aa2983fbcd5babca659c2f31dd801486bd609b41e271896fff20d24781` |

The actual Cantrip product was tested only in Codex's isolated browser. Takeover
changed the toolbar to **Return to agent** and enabled clipboard controls. Human
pointer input opened IceWM's menu and launched xterm; individual keyboard events
ran `whoami`, which reported the assigned `ctw-phase4` account. Clipboard paste
then ran a harmless terminal command that printed `Cantrip human takeover OK`.
Return restored viewing mode and disabled human clipboard controls. The Linux
file previously created by the real agent remained open in the Cantrip editor.
Screenshots are retained with the ignored local `phase4-human` artifacts.

The first browser toolbar paste exposed a real focus race: blurring the canvas
canceled its input epoch before the asynchronous clipboard read completed. The
clipboard buttons now retain canvas focus on mouse down; the repeated browser
test visibly pasted and executed the complete command. The browser automation's
bulk typing shortcut delivered only its first physical key to the canvas;
individual key events and the clipboard path were tested separately.

Native macOS tests passed all 224 cases. Linux passed formatting, 87 library tests,
its remaining native integration suites, and strict all-target Clippy; the native
X11 environment-dependent test was skipped in that build stage, while actual X11
was exercised by both installed guest SDK/lifecycle suites above. Native-backed
Worker service/JavaScript tests passed all 82 cases, including interruption of the
actual JS engine, fresh calls on the same turn after return, and rejection of an
unconfirmed close acknowledgement. The focused Worker run passed 110 tests with
35 platform/environment skips; App tests passed 21 cases, and four focused
protocol placement/control cases passed.

Worker types and the App's actual `pnpm --filter @cantrip/app typecheck` passed.
An earlier App `tsc --noEmit` invocation targeted an empty root reference project
and did not check application sources; it is superseded by the actual `tsc -b`
result, not counted as App validation. Initial QA loading also required building
the App's Glitch workspace dependency before Vite could resolve it.

After rebasing onto Main `2d68134ec`, Server types report seven errors in
unchanged Task Goal callback/ChatLiveRouting code. The first three were already
reproduced on clean Main in the previous checkpoint; the newer Main outcome
paths add four instances of the same routing type mismatch. Required `pnpm check`
still stops at unchanged budgets: `build-app.ts` 1513/1500 and
`chat-turn-runtime.ts` 2199/1999. These failures are recorded as failures.

This checkpoint completes the human-control milestone, not the complete Phase 4
goal. Managed SSH/SFTP/VNC/TCP, explicit guest-to-Host forwarding, comparative
stream measurements, active multi-desktop resource acceptance and refreshed
Docker/ISO live/install/disk-boot validation remain outstanding.

## Phase 4: protected guest services checkpoint (2026-11-05)

Remote 0.6.0 adds independent root-carried SSH/SFTP, captured-workspace VNC,
and guest-loopback TCP. This milestone supplies the guest transport; it does
not yet expose managed service routes through Cantrip's tunnel UI.

Both ARM64 Docker and the installed AMD64 QEMU guest passed the actual
`tests/remote-services.py` script. Real OpenSSH clients logged in with the
admitted public key, observed the exact workspace UID/home and used unrestricted
sudo. Real SFTP upload/download retained Unicode bytes. Wrong keys and the
other existing workspace account were denied. SSH/TCP worked while the desktop
was stopped and did not start it. A transfer of more than 1 MiB of random binary
data received its complete reply after request half-close. A refused guest port
failed the actual connection. Mismatched placement fields and old runtime or
remote descriptors were rejected without selecting another target.

Actual VNC 3.8 negotiation reached the selected desktop. Stopping that desktop
closed VNC; SSH remained usable. Killing a carrier closed an idle TCP connection
without waiting for its server. Exact service retirement, remote-manager death,
executor restart and disable cleaned up real detached SSH descendants, observed
with pidfds. The SSH host public key and workspace files survived disable/enable.
The full existing remote-package destructive harness also passed on both
architectures, including CUA hold cleanup, upgrade, disable/remove/purge/reinstall,
retained desktop/files/preferences, and unknown-state preservation.

The first installed-system manager-death run found a real failure: ordinary
`common-session` PAM policy moved SSH processes into a separate logind scope,
allowing a detached process to survive. The package now retains Debian account
policy and uses its own `pam_unix` session configuration. The final installed
run passed that same process-death assertion. No existing system SSH service or
configuration is replaced. The private Debian OpenSSH binaries require a
Cantrip package/image rebuild for security updates; their version, hashes and
copyright are included.

| Package            | Bytes   | SHA-256                                                            |
| ------------------ | ------- | ------------------------------------------------------------------ |
| ARM64 remote 0.6.0 | 1838644 | `d62d39108bdedc4f2c8ebf2723572ea4a76c34bd0d5bdbfd6d93b2782f5530aa` |
| AMD64 remote 0.6.0 | 2087476 | `e4bb180f15d7ab8292e4088b013390472bc496c63e6d18ddb6cc88dc1140c6d8` |

Both package builds, Python compilation, shell syntax, scoped formatting,
`pnpm os:test` (7 tests) and `git diff --check` passed. Required `pnpm check`
still failed at unchanged Server budgets, 1513/1500 and 2199/1999. Named build,
service, lifecycle and failure logs plus both packages are retained in ignored
local `phase4-access` artifacts.

Managed product SSH/SFTP/VNC/TCP routes, explicit guest-to-Host forwarding,
comparative stream/resource measurements and refreshed Docker/ISO acceptance
remain necessary before Phase 4 is complete.

## Phase 4: managed Linux TCP product checkpoint (2026-11-05)

Remote 0.7.0 and the existing tunnel product now carry services in an explicitly
captured Linux workspace. The same list includes Host routes and Linux routes
with a CantripOS badge. A per-route destination captures binding/worktree and
binding, attachment and runtime generations. The Server resolves execution
through canonical OS ownership and pins a hash of the actual guest descriptor.
The protected record retains the private port; browser frames cannot supply
administrative transports or replace the captured destination.

The Worker connects through the package's protected root carrier and waits for
an actual readiness receipt before accepting a stream. Its signed grant retains
a guest-only marker even during retirement. Existing encrypted tunnel frames,
credit limits and half-close are reused, without a temporary Host TCP proxy.
Package restart changes the pinned descriptor; explicit Stop/Start is required
rather than silently following another remote-service generation.

The actual App API/WorkerLink/Worker/package path passed in a disposable private
PostgreSQL product profile. A Host HTTP server and a Linux HTTP server listened
on the same port (51458). The Host route returned a distinct shadow response;
the Linux route returned its own proof file and never the Host response. Saved
records were opened with the profile's existing endpoint keys on Host; no key or
model credential was copied to Linux. The test uses the production WorkerLink
client and real relay carrier. Codex's in-app browser created both definitions
and verified the combined list. It truthfully disables local port listeners in
the browser; this is not a claim that Native desktop listener UI was exercised.
The opt-in test source is `cantrip_app/src/lib/os-tunnel.product.integration.test.ts`.

Both ARM64 Docker and the installed emulated AMD64 guest passed two real
Worker/package integration cases. They transferred more than 1 MiB, received
the complete binary reply after request EOF, and exercised encrypted endpoint
records and frames. An authentic encrypted Host destination substituted on a
signed Linux channel was rejected without calling the Host connector, including
after guest preparation retirement while that channel still existed. Revoking
an unopened preparation and a wrong service-identity pin were also rejected.
These acceptance durations are not stream benchmarks.

Both Native PGlite and PostgreSQL repository tests passed with the new Linux
route assertions: source capture, canonical execution, wrong-owner/stale-source
rejection, legacy secret-path rejection, service-identity compare-and-set and
credential rotation retaining that pin. The first Native PGlite attempt failed
because its default extracted-runtime cache was invalid; a dedicated fresh
runtime directory passed the same real test. Native protocol comparison passed
four cases across the tunnel and OS contract suites, including the fourteen
new wire vectors. An initial test used an unexported native schema root; it was
corrected to the actual Worker request envelope, without changing production
validation to accommodate the test.

Focused local regressions passed: Protocol 8 tests, Worker tunnel suites 45,
Server control plane/source capture/project share 25, App tunnel/UI suites 16,
and OS scripts 7. Actual App `tsc -b` and Worker typechecks passed. Native Server
build and repository/contract checks passed. Strict all-target Native Clippy
failed on unchanged Goal synchronization/input lints; Server TypeScript failed
on unchanged Task Goal `project_worktrees` references (also present in Primary).
Required `pnpm check` stopped at unchanged decomposition budgets (1514/1500 and
2199/1999). These failures are recorded, not counted as passing checks.

| Package            | Bytes   | SHA-256                                                            |
| ------------------ | ------- | ------------------------------------------------------------------ |
| ARM64 remote 0.7.0 | 1838536 | `724e9c0b25df274ecba9b343c5a351dcccefdd1acbcbb356a6a63a06db9e9968` |
| AMD64 remote 0.7.0 | 2088268 | `3676b9a4f4f8bdd73f81017d7d93eb4e60e608e6e558e3f049cd10c9f58b1feb` |

Both packages built and were installed on their real guest fixtures; the private
product guest was upgraded to 0.7.0 with workspace/desktop data retained. The
full destructive package lifecycle suite passed in the preceding 0.6.0 milestone;
this cycle's 0.7.0 delta is the optional readiness receipt, tested through the
actual binary streams. Refreshed image/ISO lifecycle acceptance remains pending.
Named logs, both packages and the product screenshot are retained in ignored
local artifacts. Full Phase 4 remains active: managed SSH/SFTP/VNC, explicit
Guest-to-Host forwarding, comparative stream/resource measurements and final
Docker/ISO live/install/diskboot acceptance remain required.

Rebase follow-up: Main had taken migration 256 for Task Goal message receipts.
This milestone now uses 257; both fresh Native repository databases and the
actual product test passed again on the rebased source. The disposable product
database was backed up before reconciling its earlier development migration.
The protocol export baseline now explicitly reviews Main's four added inference
and Goal outcome exports while retaining the old fingerprint. App typechecking
passed again. Worker typechecking, which passed before rebase, now reports one
unchanged Main error at `transport.ts:963` (missing logging `subsystem`); the
new OS forwarding code reports no type errors. Native compilation also reports
Main's unused Goal `lease` warning. Rebased strict Clippy failed on that warning
and the same two Goal lints; rebased `pnpm check` reports 1515/1500 and 2199/1999.
These upstream diagnostics remain visible.

## Phase 4: managed SSH/SFTP product checkpoint (2026-11-05)

The managed service path now supports SSH/SFTP for an explicitly captured Linux
workspace, using the existing remote 0.7.0 package. The saved public key stays in
the protected endpoint record. Server preparation returns the observed account
and SSH host public key; the descriptor identity remains pinned to the attachment.
The Worker validates the decrypted source and opens independent protected SSH
streams with that key. Desktop stop/start remains independent.

The Native desktop client installs a temporary, independently created public
`known_hosts` file for its exact forward/attachment/native generation. An active
pin cannot change its account, alias or key. Retirement drops the retained file
handle and removes the pin. SSH/SFTP connection details use the file with strict
host verification and a stable instance alias, with properly quoted commands
for macOS/Linux and PowerShell. No private client key enters CantripOS, and no
global client or guest SSH configuration is replaced.

A real saved-route product smoke passed against the disposable PostgreSQL
profile: actual API admission, WorkerLink grant/relay, Worker, guest package and
real OpenSSH clients. Login observed the Linux account/home, unrestricted sudo
returned UID 0, and SFTP round-tripped Unicode bytes and deleted only its temporary
remote proof file. Codex's in-app browser displayed the combined TCP/SSH list and
the saved SSH form with its captured workspace/public key. Browser local-listener
actions remained disabled. The headless test's local socket exercises production
API/SDK/Worker routing; it is not a claim that the Native desktop UI start button
was clicked end to end.

The actual Worker/package SSH test passed on ARM64 Docker and installed emulated
AMD64: correct account UID/home and sudo, SFTP Unicode upload/download, wrong
client key, root-account login and wrong host-pin rejection, active idle SSH
retirement and rejected reopening after revoke. Its first run exposed a missing
close handler in the test's local socket bridge; adding the bridge's stream-close
propagation made the same real client-retirement assertion pass. Existing TCP
binary/encrypted tests passed on both architectures after extracting shared
protected-admission test setup.

The Native App compiled in an isolated target directory. Its 37 tunnel tests
passed, including independent host-pin files, removal on handle drop, rejection
of SSH options/line injection and the existing real native loopback/route tests.
App regressions passed 20 cases, including exact native generation passed with
SSH metadata and local-forward retirement when the host pin cannot be installed.
Protocol tests passed 9 cases; Native tunnel contract comparison passed both
tests with 19 OS wire vectors and 9,067 existing catalog cases. The original real
product Host-vs-Linux same-port smoke also passed through the shared QA setup.

Native distribution/package rebuilds are not part of this milestone because
guest support is unchanged from 0.7.0. The full Phase 4 goal remains active:
managed VNC with coordinated input ownership, explicit Guest-to-Host forwarding,
comparative stream/resource measurements and final fresh Docker/ISO
live/install/diskboot acceptance remain required.

The final Native cleanup pass also gives failed WorkerLink starts an atomic
stop keyed by tunnel, attachment and Native forward generation. A delayed
failure with an equal reused attachment ID cannot remove a newer listener.
The Native replacement test now covers stale generation, stale attachment and
exact capture removal; App tests require the captured generation on cleanup.
SSH commands explicitly omit global known-host sources for this connection.

App `tsc -b` passed. Worker typechecking still reports Main's missing logging
`subsystem` at `transport.ts:963`; Server types still report its three Task Goal
worktree-property errors. Strict Native App Clippy failed on five existing
diagnostics (NBT export boolean, three tunnel function argument counts and the
existing connection event enum size). Required `pnpm check` stops at unchanged
Server budgets, 1515/1500 and 2199/1999. These are recorded failures, not passes.

After rebasing onto Main's provider-catalog and Goal input changes, both real
product TCP/HTTP and SSH/SFTP smoke tests passed again, as did App typechecking
and Native tunnel contract comparison. Main's added provider-catalog export is
explicitly reviewed in the protocol compatibility list while the legacy export
fingerprint is retained. No new guest package or migration is introduced here.

## Phase 4: managed VNC and shared control checkpoint (2026-11-05)

Managed tunnels now include **VNC desktop** for an explicitly captured Linux
workspace. It shares the Host/CantripOS list with TCP and SSH/SFTP. The saved
private destination contains the canonical source capture, not a caller-chosen
host/port/display. Admission observes the actual running desktop and pins the
full service descriptor, including desktop and remote-manager generations.
Existing encrypted WorkerLink framing, native loopback listeners and bounded
TCP streams carry RFB bytes. No new public guest listener is installed; the
guest remote package remains 0.7.0.

VNC acquires the same exclusive human-control lease as the integrated viewer.
Agent input is canceled and physically released before VNC admission. A second
VNC client or viewer cannot take over concurrently; another workspace continues
independently. Closing the client or retiring its attachment confirms actual
root-service cleanup before returning control. Failed cleanup retains the old
lease. A fresh placement-verified replacement descriptor can fence the old
helper and retire that lease; unavailable/unchanged observations cannot.
Background cleanup failures are logged without crashing the Worker.

Actual Worker/package acceptance passed on ARM64 Docker and the installed
AMD64 VM over verified SSH: two cases on each architecture. These used native
CUA and a real RFB 3.8 client, received a full raw framebuffer, canceled a held
agent drag, rejected competing controllers and kept the other workspace usable.
Actual X11 keymap/pointer queries observed VNC-held Shift and left button, then
both released before agent control resumed. A real remote-manager restart
fenced the old controller, rejected the retired attachment and allowed a fresh
native agent target. Separate physical probes killed the root manager with a
pidfd and verified both held inputs released on both architectures. The first
probe incorrectly waited for a carrier whose stdin was still open; corrected
probes checked physical state before closing that half-open carrier. The first
replacement-test fixture also parsed a non-JSON lifecycle command as JSON;
using the actual lifecycle exit result made the unchanged assertions pass.

The actual Cantrip Server API, saved encrypted VNC route, WorkerLink relay,
Worker and guest package passed the product framebuffer test. Codex's in-app
browser showed **Human controlling** during the external client's connection
and returned to **Take control** after disconnect. The saved route editor
showed its exact CantripOS workspace and VNC service. Browser local-listener
buttons remain disabled; this does not claim a Native UI Start click. The final
three product regression cases passed together: VNC, real SSH/SFTP and the
same-port Host-shadow versus Linux HTTP service proof.

Focused validation passed: 39 Worker control/routing/TCP tests, 32 App tunnel
and native-forward adapter tests, 18 protocol tests, and actual App `tsc -b`.
New control cases retain ownership after unconfirmed cleanup, recover only on
verified replacement and prevent late cleanup from returning another owner.
The existing Worker typecheck failure remains `transport.ts:967`'s missing
logging subsystem. `pnpm check` still stops at the unchanged Server line budgets
(1515/1500 and 2199/1999); those checks are recorded as failures. This milestone
does not claim refreshed ISO/distribution or comparative stream acceptance.
Explicit Guest-to-Host forwarding and the remaining Phase 4 acceptance continue.

After rebasing onto the current main, the production App build, App typecheck,
39 focused Worker tests, both real guest cases on each architecture and all
three product smoke cases passed again. Protocol contract regeneration matched
main (624 roots, 10483 nodes); no public Native contract changes were needed.
The initial post-rebase launch used stale protocol build output; rebuilding the
workspace dependencies restored the Server and Worker, and the product cases
above passed against that rebuilt stack.

## Phase 4: Guest-to-Host listener foundation (2026-11-05)

Remote 0.8.0 adds a protected `listen` service for an explicitly captured
workspace, plus the Worker's `OsReverseForward` bridge to one selected Host
loopback service. The guest binds only its own loopback port; it receives no
Host destination, Worker, provider credentials or conversation state. This is
the carrier foundation, not the saved Guest-to-Host route/UI milestone.

One carrier multiplexes up to 16 clients with separate 64 KiB credit windows,
strict bounded frames and a 2 MiB queued-carrier limit. Per-client FIN frames
preserve TCP half-close and replies; outer carrier EOF retires the listener.
It remains independent of desktop start/stop and uses the existing root lifetime
guardian, placement observation and exact connection-UUID retirement.

Five real Worker/package cases passed on ARM64 Docker and the installed AMD64
VM over verified SSH. Two simultaneous guest clients each sent more than 1 MiB
of binary data and received the exact reversed bytes plus SHA-256 from the Host
service after request half-close. This worked with the desktop stopped. An
occupied listener port and a wrong owner were rejected while the original
listener remained usable. Revocation, actual manager restart, pidfd/SIGKILL
manager death and package disable each closed actual idle Guest and Host sockets.
Nine focused protocol tests passed for malformed/oversized frames, forbidden
Host fields/destinations, replayed connection IDs and overflowing credit.

The tests exposed and fixed two lifecycle failures. Closed connections initially
prevented rapid port reuse; `SO_REUSEADDR` permits reuse without allowing two
active listeners to bind the same address. The outer generic half-close pump
also left Docker's exec process waiting for stdin after its output was closed,
so the Host bridge did not learn the listener had died. Listener carriers now
exit on either EOF; ordinary SSH/TCP carriers retain their existing half-close
semantics. One emulated-VM run reported an external SSH banner exchange broken
pipe. Expected rejected-admission fixtures now await actual cleanup before the
next connection; the final full five-case suites passed on both architectures.
No production transport retry or mutation replay was added.

A separate actual packaging bug was confirmed: installed source reported
version 0.8.0 while a fresh Python import executed version 0.6.0. Reproducible
mtimes and equal source size kept old timestamp bytecode valid. Upgrade and
removal now clear only the package's generated bytecode, and its CLI suppresses
new bytecode writes. The destructive package suite deliberately compiled a fake
same-size/same-mtime version, proved that Python imported it, then verified that
running package upgrade returned the real installed version and removed the
cache. This passed on both architectures, along with ordinary desktop/files,
preferences, unknown retained state, native clipboard/resize/pointer/held-input
cleanup and disable/remove/purge/reinstall checks. The full pre-existing
SSH/SFTP/VNC/TCP service suite also passed on both architectures.

Worker typechecking reports only the existing `transport.ts:967` logging
subsystem error. `pnpm check` stops at the existing Server budgets (1516/1500 and
2216/1999); those are failures, not passes. Saved reverse routes, comparative
stream/resource measurements and refreshed distribution acceptance remain
necessary before Phase 4 is complete.

Built package artifacts:

- `cantrip-os-remote_0.8.0_arm64.deb`: 1,840,216 bytes; SHA-256 `db350f7ec474d4229ef61b9c25f61ec1e152fd737ad577ce888ade34ef670336`.

- `cantrip-os-remote_0.8.0_amd64.deb`: 2,089,808 bytes; SHA-256 `dfe1a248db79214d0c7c19185b0ac1b685b2d09f3a88c0ea6d7e99e99afb0924`.

After rebasing onto current main, the five real forwarding cases passed again
on both architectures, all nine focused protocol tests passed, and all seven
OS launcher tests passed. Scoped TypeScript/JavaScript formatting, Python
compilation, shell syntax and `git diff --check` passed. The same baseline
Worker typing error remains; no shared Native/public protocol changed.

## Phase 4: saved Guest-to-Host product routes (2026-11-05)

The tunnel inventory now saves an encrypted `worker-os-listener` source with a
canonical source capture and an explicit same-Worker Host destination. Incoming
Host/Linux service routes and outgoing Linux listeners share one inventory and
per-route editor. Reverse listeners start in both browser and Native clients;
there is no viewing-device listener or full guest Worker. A singleton Linux
workspace appears as a label and is selected without an unnecessary dropdown.

The Server admits the explicit attachment kind and expected saved revision,
resolves current ownership/placement and pins the real service descriptor. The
Worker binds a real guest listener before acknowledging preparation and dials
the Host only after the matching signed `stream:guest-listen` grant activates.
The control channel accepts only a one-byte heartbeat. Retired runtime, package,
carrier or controller closes the listener and all multiplexed Host clients.
Unique per-start attachment identities prevent late cancellation cleanup from
revoking a replacement started in another tab. Saved edits/deletes now lock the
owning route and recheck attachment/management/revision fences atomically.

Actual protected admission tests passed on ARM Docker and the installed AMD64
VM: wrong direction rejected, signed admission succeeded, a duplicate channel
was refused, real Linux TCP reached the explicit Host service, unexpected data
frames failed and closing the channel retired the physical guest port. Existing
carrier binary/half-close and package retirement acceptance is recorded above.

The private PostgreSQL QA stack ran all four actual product tests: Linux TCP vs
Host substitution, SSH/SFTP, VNC, and the new saved reverse route. The reverse
case saved real encrypted content, obtained an actual Server grant through the
browser controller, traversed WorkerLink relay and reached the Host service at
51458 from guest port 51566. The matching guest port returned the distinct Linux
proof. It remained usable after the real heartbeat and Stop made the actual
guest port refuse connections. Codex's own browser also created, started and
stopped a separate saved route at 51567; an actual guest request returned the
Host proof while active, and the real port was closed after browser Stop.
Evidence screenshot is retained under local ignored `artifacts/phase4-reverse/`.

Native canonical repository tests passed on PostgreSQL and native PGlite using
a temporary diagnostic correction for two unchanged compilation errors in
`tasks/round_outcomes.rs:100` and `tasks/round_input_history.rs:75` (wire JSON is
passed to SQL without a `ToSql` wrapper). The temporary changes were restored
and are not part of this milestone. A clean native server build remains blocked
by those upstream errors; these diagnostic database results are not a claim
that the unmodified full native server build passes. The fresh native Codex
runtime build completed and the QA Worker uses that bundle.

Full Phase 4 remains active for comparative streaming/resource measurements and
refreshed Docker/live ISO/installed-system acceptance. No distribution acceptance
is inferred from these tunnel tests.

Focused verification passed: 44 App tests, 46 Server tests, 28 Worker tests and
19 protocol tests. The App typecheck and production build passed. The paired
Node/native tunnel repository comparison passed 311 cases and 146 snapshots on
each database engine; PostgreSQL additionally exercised five actually blocked
edit/delete races. Both implementations rejected the competing mutation and
preserved admitted attachments, leases, revision and management ownership.
Legacy non-OS Worker listener records and secret-based Host attachment access
retain their historical behavior. Native comparison used the diagnostic
compilation correction described above; its two unrelated files were restored.

The standard root check was attempted and failed at unchanged application line
budgets (`build-app.ts` 1516/1500 and `chat-turn-runtime.ts` 2216/1999). Repository
decomposition reports unchanged `native-commands.ts` at 2049/2000; the touched
tunnel repository is below its limit after extracting its summary projection.
Worker and Server typechecks still reported their existing logging/task-history
errors. These failures were not counted as passing checks.

After rebasing onto `98a1cd074`, all 44 App tests and 19 protocol tests passed
again, and the regenerated contract contains 626 roots / 10529 nodes. The final
App build attempt is blocked by unchanged Worker `inference-command.ts:36/37`
(`session.chatId` narrowing); Worker typecheck also reports the upstream
inference-source/void annotations and the existing logging context error.
Repository decomposition now reports upstream `native-commands.ts` at 2075/2000.
The earlier App production-build success predates these main-branch changes.
Actual product service tests passed after migration 263 and the intervening main
migration were applied to the backed-up private QA database. The paired database
comparison was repeated after renumbering: 311 cases / 146 snapshots on each
engine and all five PostgreSQL mutation races passed again.

## Phase 4: native executor build preparation repair (2026-11-05)

A fresh default OCI build failed before compiling its executor because patch
`0069-goal-inference-wait-clock.patch` used context-free/minimal-context hunks
that the normal ordered `git apply` path rejected. The actual source preparation
uses those same normal apply options; this was a reproducible build failure.

The patch was regenerated with ordinary three-line context against the reviewed
series through 0068. Applying the refreshed patch with the standard options
produces byte-identical contents for all nine resulting Rust files, including
the new queue-clock module. No runtime behavior or source verification policy
was changed. Ordered verification of Codex 0.166.0, 9191 source files and 70
patches passed. The initial failure and source-hash comparison are retained in
local Phase 4 build evidence.

The default ARM64 OCI build then completed, including a full native executor
compile (25m49s) without a cached-runtime override. Image
`cantrip-os-phase4-stream:dev` booted in a disposable container with an actual
4294967296-byte memory limit and no OOM kill. The personal X11 desktop was
available, and packages reported workspace 0.3.0, executor 0.9.0 and remote 0.8.0.
The image contains htop, nano, Python 3, Chromium and IceWM. Codex's own browser
opened its passwordless desktop, launched xterm from the menu and ran htop with
normal remote key events. The screenshot is retained locally under
`artifacts/phase4-executor-build/fresh-desktop.png`; htop's host-kernel memory
view is not the container memory-limit measurement.

The real native executor integration test passed in 9.83s against that fresh
image: files/processes, resumable sessions without command replay, independent
workspace lifetimes, owned detached-child cleanup and stale/wrong-owner rejection.
The complete destructive remote-package acceptance also passed on the fresh
image, including physical capture/input/clipboard, generation and guardian
retirement, disable/removal, upgrade/purge/reinstall, retained workspace/desktop
state and unknown-state preservation. The standard root check was attempted and
still stops at unchanged application line budgets (1516/1500 and 2216/1999).
This checkpoint repairs build preparation and refreshes Docker evidence; stream
comparison and fresh ISO/installed-system acceptance remain in progress.

## Phase 4: stream choice and active 4 GiB measurements (2026-11-05)

The reproducible [stream/resource harnesses](STREAMING.md) ran against the fresh
ARM64 OCI image from the executor-build checkpoint above, on an Apple M4 Max
(16 logical CPUs). The OS had an actual 4294967296-byte cgroup limit, no swap
allowance beyond that limit, and 1 GiB shared memory. A separate AMD64 ISO build
was compiling on the host during these observations. These are local workload
measurements, not isolated-host performance promises.

The matched stream fixture kept the personal console and two workspace desktops.
Both candidates viewed the same 1440×900 application, with 10-second static and
motion windows. JPEG used the real production `OsDesktopSession`/native capture/
Worker encoder at 15 fps, adaptive quality. VNC actually negotiated compressed
ZRLE, with a 15 fps incremental-request ceiling. ZRLE is lossless changed-region
encoding; JPEG is lossy full-frame encoding, so fidelity is not identical.

| Candidate / scene    | Encoded arrivals/s | Encoded Mb/s | Guest CPU, % one core | Host probe/encode CPU, % one core | Guest working set MiB |
| -------------------- | -----------------: | -----------: | --------------------: | --------------------------------: | --------------------: |
| Native JPEG / static |               15.1 |        14.87 |                  24.3 |                              28.6 |                 253.6 |
| Native JPEG / motion |               15.2 |        15.08 |                  25.3 |                              27.9 |                 254.2 |
| VNC ZRLE / static    |      0 (unchanged) |            0 |                   3.2 |                              <0.1 |                 283.2 |
| VNC ZRLE / motion    |               13.2 |         0.41 |                   9.9 |                               1.2 |                 284.7 |

First encoded-frame arrival from adapter open was 202 ms JPEG / 373 ms VNC;
reconnect was 154 / 454 ms. The shared native CUA lease and X11 desktops were
already prepared before adapter timing; these are not cold attach/admission
latencies. Five actual Escape operations per candidate produced median
input-to-application-XSync acknowledgments of 11.8 / 3.8 ms. These are not
input-to-displayed-frame latency or browser-decoder FPS. Both paths set the actual
ASCII X11 clipboard, and the sibling desktop's clipboard stayed unchanged.
Motion produced actual encoded updates; receive buffers were bounded and frames
were not retained. Separate native acceptance already covers Unicode clipboard.

The official Selkies 2.2.1 ARM64 Debian package's release checksum matched and
installation succeeded. Actual startup, repeated with Python fault reporting,
exited 132 (illegal instruction) in bundled cryptography imports before capture
or its WebSocket listener started. No Selkies streaming numbers are claimed;
this result is specific to that package/environment. It is not installed in the
production image.

**Initial integrated choice: retain native adaptive JPEG at 15 fps.** It fits
this measured CPU/memory workload and reuses the shipped identity, control,
clipboard, resize and client-decoder behavior. Its ~15 Mb/s cost is material:
VNC's changed rectangles were much more efficient here and remain available
through the managed compatibility route. This selection does not claim JPEG is
the best codec. Browser decode, WAN and representative video workloads are
needed before choosing a new integrated tile/video adapter.

A separate **fresh stock-image** resource fixture ran each active workspace with
its own Chromium animated local page and a real native executor hashing/writing
files every 50 ms. Files and GUI launches used the native executor; actual browser
page counters advanced throughout, and both executor jobs continued producing
output/files. The personal console remained available; no viewers or model
runtime ran inside the OS. Six samples covered each 10-second measurement window:

| Stage                           | Guest CPU, % one core | Max raw cgroup MiB | Max working set MiB | Max anonymous MiB |
| ------------------------------- | --------------------: | -----------------: | ------------------: | ----------------: |
| Idle OS                         |                   1.7 |               93.8 |                93.4 |              88.7 |
| One active desktop + executor   |                  20.9 |              338.0 |               333.3 |             292.6 |
| Two active desktops + executors |                  31.8 |              600.7 |               591.5 |             517.4 |

All samples retained the actual 4 GiB limit and zero OOM kills. This establishes
that workload, not arbitrary project/site/build capacity. External Worker/model
memory and Docker VM overhead are excluded. The initial resource-fixture browser
invocation failed because its executor PATH omitted `/usr/local/bin`; the final
fixture invokes the installed wrapper by absolute path and verifies actual
rendering before recording an active stage.

Final real stream and resource tests each passed (50.74 / 49.93 seconds). Strict
TypeScript checking of the new harness import graph passed, and all seven OS
script tests passed. Full Worker typechecking still reports the unchanged
inference source/command and logging diagnostics recorded in earlier checkpoints.
The standard root check was attempted and stops at unchanged application line
budgets (1516/1500 and 2216/1999). Full Phase 4 remains active for refreshed
live ISO/installation/disk-boot acceptance. Raw results and startup/failure logs
are retained locally under `artifacts/phase4-streaming/`.

After rebasing onto `f90caee31`, both real harness cases passed again (98.40s
combined), the strict harness import-graph typecheck and seven OS tests passed.
The current root check still fails on unchanged application budgets: 1516/1500
and 2221/1999. The earlier measured numbers above remain the retained sample;
the rebase run is an additional functional regression check.

## Phase 4: refreshed distribution acceptance (2026-11-05)

The ordinary ARM64 OS was built from the current distribution-cycle source with
`CANTRIP_OS_WORKSPACES=0` (executor and remote consequently omitted). Its actual
OCI payload manifest is
`8a25cdb308510061fc55a996d51303ac9e9ade5767cfc7377b34a1dd92b0fb94`;
attestation/index digests differ between equivalent exports. A fresh 4 GiB
container had none of the three integration CLI binaries, and did contain htop,
nano, Python 3, Chromium and IceWM. Its personal X11 display was available.
Codex's own browser opened its passwordless OLED desktop, opened the IceWM menu
and launched the ordinary terminal. The screenshot and package/limit proof are
retained under `artifacts/phase4-distribution/`.

The public root `pnpm os` foreground command was also run in that ordinary edition
with a separate test instance and ports. It printed browser/VNC/root-shell
information, reported that SSH was not enabled, streamed actual desktop logs and
watched for changes. The browser returned HTTP 200 and X11 responded. Ctrl+C
completed with exit 0, and Docker confirmed the container had stopped. Running
the same foreground command again retained a file written into the personal home;
a second Ctrl+C also stopped it cleanly. These checks establish the ordinary
edition's launcher and optional-package omission; final integration-enabled
media acceptance is recorded separately below when performed.

The integration-enabled ARM64 image was then rebuilt from source revision
`485014de8`, with the normal current Codex 0.166.0 / 70-patch preparation and a
25m02s native executor compile. No cached-runtime override was used. Its actual
OCI payload manifest is
`48760f5fdc61585223d10c534d33407248f801a2ff6067d4b8bb3fa398ef5845`
(config `fb5e38854453eb738614c9e8e289973e8bbc5528a874226b5dec435f890e7d21`).
A fresh 4 GiB container reported workspace 0.3.0, executor 0.9.0 and remote 0.8.0.
The real native executor test passed (12.13s body), and the four real native
CUA/VNC cases passed (7.41s combined bodies), including integrated viewing,
exclusive takeover/return, held-input cleanup, stale epochs and independent
viewer/agent lifetimes. The full protected SSH/SFTP/VNC/TCP suite and destructive
remote-package suite also passed, including removal/upgrade/purge/reinstall,
retained ordinary desktops/data, stale bytecode replacement and unknown-state
preservation.

The public `pnpm os` command ran again with all integration packages enabled and
an isolated test name/ports. Its unchanged native layers reused the build cache;
all three package control services reported ready, and Chromium launched from
the ordinary menu and rendered an HTTPS page in Codex's own browser. The image
contains htop, nano, `python`, `python3`, Chromium and IceWM. Ctrl+C exited 0 and
Docker confirmed the container stopped. The retained screenshot is
`artifacts/phase4-distribution/current-docker-chromium.png`.

The additional reverse-forwarding run initially exposed a missing `remoteCommand`
import in the existing test fixture. That also prevented its post-kill cleanup
from restarting the disposable remote manager. Restoring the import and restarting
the fixture made all six real carrier/signed-admission cases pass (5.67s combined
bodies), including >1 MiB binary half-close traffic, occupied/stale targets,
manager restart/death, disable, signed role validation and physical listener
retirement. The failed and corrected logs are both retained; this repair changes
test execution, not guest forwarding behavior.

Focused strict TypeScript checking then caught stale fixture types for route
priority and channel close arguments. The fixture now keeps only `local` enabled
while using the canonical four-route priority tuple, and closes with the explicit
`normal` reason. The strict import-graph check passed, followed by all ten actual
CUA/VNC/reverse-forwarding cases together (13.21s combined bodies). Guest runtime
and product routing code are unchanged by these fixture corrections.

The fresh AMD64 ISO from the same source booted into the live IceWM desktop in
QEMU/TCG with 4 GiB RAM. Chromium rendered an HTTPS page, and htop ran from the
ordinary terminal using Codex's own browser viewer. The native executor case and
ten CUA/VNC/forwarding/admission cases passed against the live system. The
installer then erased only the task-owned 20 GiB virtual disk and installed both
BIOS and UEFI bootloaders. Disk-only BIOS boot retained a Unicode personal file,
a workspace file and a shared `/etc` customization. The SSH carrier used for
Worker acceptance was installed only into this disposable VM; the distribution
still has no public system SSH listener.

Real installed-system lifecycle testing found a remote-manager defect that the
Docker daemon tests did not expose: `KillMode=mixed` let systemd kill the native
helper and its guardian immediately after the broker died, before held X11 input
could be released. Remote **0.9.0** retains mixed termination but sets
`SendSIGKILL=no`. Guardians can finish their existing cleanup; a populated old
cgroup prevents a replacement from starting. This does not weaken descriptor or
control-lease checks. The package guide documents the systemd behavior and tradeoff.

Both architecture packages and a fresh ARM64 image were rebuilt. The new image's
OCI payload manifest is
`632183e1e134f56ec585bae4325339b8a8f35460b94ab5c8d6fd24ed11c40656`
(config `ebdfc8031543af904d46e5c4c9784abb79472529395179dd9495a4ff52943849`).
All eleven native executor/CUA/VNC/reverse-forwarding/admission cases passed
(24.70s combined bodies), followed by the full protected-service and destructive
package suites. On the actual installed system, the production 0.9.0 `.deb`
replaced the prototype override, and both complete suites passed, including
systemd-managed broker death releasing actual held input, stale generation
rejection, upgrades, disable, remove, purge and reinstall. Personal/workspace
files, shared configuration and the instance identity survived; opening replacement
services made the old live-media executor and remote descriptors fail explicitly.

The protected-service fixture also now publishes its detached child's PID with
an atomic rename. Under CPU emulation the previous existence-only handoff could
observe an empty file before the PID write completed. This fixes the acceptance
fixture without changing service behavior. The initial failure logs are retained.

The production 0.9.0 package was also exercised after disk-only UEFI boot. The
root filesystem was `/dev/vda3` (ext4), the firmware interface was actually UEFI,
and all retained files and application checks passed. All eleven real native
cases passed again (139.04s bodies / 144.08s total). The installed desktop opened
its terminal and ran htop through Codex's own browser.

After rebasing this final cycle onto `4c1f1542f`, full Worker type checking and the
focused strict reverse-forwarding import graph passed. All eleven native cases
passed against the fresh 0.9.0 Docker image again (21.12s bodies / 24.12s total).
The root check still stops at unrelated Server budgets: `build-app.ts` 1516/1500
and `chat-turn-runtime.ts` 2230/1999. Earlier failures recorded above describe
those earlier revisions; they are not the final Worker typecheck result.

The final integration-enabled AMD64 ISO includes workspace 0.3.0, executor 0.9.0
and remote 0.9.0. Its SHA-256 is
`b795e85406e484b5577d9b44e8b23fc2769f9700a0053c34f3d0bdf0ace10672`
(1,468,071,936 bytes). This artifact uses native source `485014de8` with the
normal pinned Codex 0.166.0 / 70-patch build, plus this cycle's remote 0.9.0
package. It was built before the final documentation/test rebase; it is not
claimed to contain subsequent unrelated Main native changes.

That exact ISO then booted on a second fresh 20 GiB task-owned disk. The live
system reported overlay root, all three services, passwordless sudo and all six
application commands. Its personal desktop automatically logged in, and Chromium
launched from the menu and rendered an HTTPS page in Codex's browser. Fresh
workspace accounts and a separate instance identity were created. The installer
successfully copied the live system and customization, generated initramfs and
installed both BIOS and AMD64 EFI bootloaders. The ISO, package inventory,
checksum, `.deb` files, logs and screenshots are retained locally under
`artifacts/phase4-distribution/`; the older preliminary ISO is separately labeled.

The second installation booted from disk alone in BIOS mode with `/dev/vda3`
ext4 root. The Unicode personal file, workspace file and shared configuration
survived, and both old live-media handles were rejected after new services opened.
The packaged unit reported `KillMode=mixed`, `SendSIGKILL=no` and no drop-ins.
The complete destructive remote-package suite passed on this fresh installation,
including real held-input release after broker death, independent shell lifetime,
retired placement rejection and disable/remove/upgrade/purge/reinstall behavior.

The final disk then booted in UEFI mode without the ISO, with ext4 root, automatic
personal desktop entry, the same instance identity and retained customization.
Both old live-media descriptors were rejected again. The real native executor
case and two CUA cases passed (51.71s bodies / 53.48s total), including screenshots,
input, integrated viewing, human takeover/return and independent viewer/agent
lifetimes. No per-test service override was present in this fresh installation.

**Phase 4 is implemented and accepted for this tested matrix.** The optional
remote package remains removable independently of the ordinary desktop and
executor. Agent computer use, integrated source-bound viewing, exclusive human
control, managed SSH/SFTP/VNC/TCP and explicit Guest-to-Worker forwarding have
actual native, package and product evidence in the checkpoints above. Model
credentials and orchestration remain outside the OS. The measured initial stream
choice and active 4 GiB workload are recorded in `STREAMING.md`.

This is local macOS/ARM64 Docker and AMD64 QEMU/TCG VM acceptance, not physical
hardware, cloud provisioning, Wayland, WAN performance or Secure Boot validation.
The emulated virtio GPU emitted a kernel warning during a VM shutdown and still
powered off; a warning-free hardware/kernel matrix is not claimed. Selkies did
not start in its measured environment and has no claimed performance result.
Remote enrollment/state recovery and broader release/hardware qualification
remain subsequent phases. The broad root check is still limited by the unrelated
Server budgets above; focused checks and full Worker types passed.

## Phase 5: explicit recovery observation checkpoint (2026-11-05)

The first Phase 5 cycle adds `Check recovery` to the existing instance controls.
Both Server implementations expose the same owner-scoped recovery endpoint and
shared request/result contracts. The request pins the selected attachment and
previous runtime. The owning Worker observes the existing guest package without
starting a desktop, running a command or changing chat placement.

The Node Server's real PGlite-backed HTTP fixture covers same runtime,
unavailability followed by reconnection, a changed target identity, first
observation, a changed runtime, wrong owner and stale selections. Only inspect
commands were sent for recovery; the single admitted source mutation was not
replayed. Failed ordinary refresh now also preserves the previous generation as
historical metadata, while unknown status blocks source availability.

Native contract-oracle tests and the real native Server HTTP/PostgreSQL fixture
passed. Its fixture Worker exercised the same unavailable/identity/runtime
transitions and rejected stale request generations. These are actual Server/API
and database tests with controlled Worker receipts, not proof of a remote cloud
connection. App API/project-settings tests passed (13 cases), protocol tests
passed, and the three focused Node Server files passed (7 cases). App and Server
type checking passed after removing an invalid type-only import; the initial
Server typecheck failure is retained in local test logs.

Required `pnpm check` stops at the existing Server line budgets:
`build-app.ts` 1516/1500 and `chat-turn-runtime.ts` 2230/1999. No hosted ordinary
validation was run. Phase 5 remains in progress: process/output recovery,
workspace backups/restores, lifecycle/upgrade preservation, fresh distribution
artifacts and real remote product acceptance are still required.

Infrastructure discovery found no named SSH targets for Cantrip. The active
cloud project contains only another application's machines; they were not used
or modified. Remote acceptance needs an explicitly authorized disposable Linux
target and Worker-local SSH identity/known-host references. Local fixtures do not
establish cloud acceptance.

## Phase 5: recovering recorded Linux Runs (2026-11-05)

Linux Run reconciliation previously called recorded cleanup whenever a fresh
Worker supervisor lacked the runtime in memory. It now requests resume of the
exact recorded launch. This path requires a matching private admission and can
never enter new preparation/start/input delivery. Original encrypted secret
snapshots are retained for redaction after restart; no plaintext secret is added
to the journal. Missing/corrupt or different admissions cannot become a new Run.

A fresh 4 GiB ARM64 Docker fixture used the existing remote/executor 0.9.0 image.
The real Run and terminal integration cases passed (86.46s bodies / 94.24s total).
The Run fixture SIGKILLed its separate Worker process while a real Linux Run and
root child were active. A fresh supervisor reconciled the same native process,
confirmed it remained alive, and preserved its PID/file. Repeating reconciliation
did not replace it. Only an explicit Stop terminated the root child. The fixture
also recovered an already completed secret-bearing Run's native output, reapplied
real secret decryption/redaction and confirmed the command's side-effect file
still contained one execution. A different launch operation was rejected.

The terminal case exercised real nano editing, PTY resize, carrier death/resume
without repeated shell input and explicit root-descendant cleanup, preserving an
independent process. Existing terminal rehydration intentionally rebuilds a fresh
terminal model from retained native output; a persisted stdout cursor alone
would lose that model. No such cursor shortcut was introduced.

Worker type checking, strict checking of the changed fixture import graph and
13 focused unit cases passed. The initial nullable terminal-identity type error
was fixed before the real integration run. Required root `pnpm check` still stops
at unchanged Server budgets (1516/1500 and 2230/1999). No guest package or native
executable changed in this cycle, and the previously built image is not presented
as a new distribution artifact. Real remote product acceptance remains pending.

Output retention coverage remains a Phase 5 requirement: the native buffer is
bounded, and lifecycle events can produce legitimate sequence gaps. Explicit
executor retention metadata and gap reporting will be implemented separately;
these successful short-output tests do not establish complete history after
native eviction. Worker-incarnation classification, other admitted operations,
backup/restore, lifecycle/upgrade preservation and final distribution acceptance
also remain required before the full goal can be completed.

## Phase 5: Worker continuity observation (2026-11-05)

Explicit recovery now records the authenticated Worker's process generation
separately from the guest runtime. The Server compares actual bridge identities
before and after the read-only inspect request, and persists the last explicit
observation for that attachment. Ordinary Refresh does not consume that baseline.
A changing/unavailable bridge identity reports unavailable continuity without
blocking the inspect request. Recovery updates compare both prior generations;
this metadata does not replace captured execution authority.

The Node HTTP/PGlite cases exercise initial observation, guest transport failure
with the same Worker, an unavailable Worker connection, a new Worker on the same
guest runtime, an intervening Refresh, missing/changing continuity metadata,
persistence through a fresh repository and rejection of a stale Worker update.
The native HTTP/PostgreSQL case reconnects real bridge Peers first with the same
process generation and then a different one while retaining the fixture's guest
runtime. It verifies the separate recovery states and persisted generations.
These are product HTTP/authorization fixtures, not acceptance of a real remote
Worker process restart. That end-to-end case remains required.

The initial Node test had a duplicate local variable, then its historical schema
fixture needed the new migration only in the case invoking today's repository.
Both were fixed. Three Node suites passed (7 cases), followed by the final
management case after message changes. App API tests (7 cases), App/Server type
checking and formatting passed. Native contract oracles (2 cases) and the actual
HTTP case passed after fixing a forwarding-channel leak in the test's cleanup;
the earlier stalled run was terminated and its disposable database stopped.
Before the rebase, the required root check stopped at existing Server file
budgets (1516/1500 and 2230/1999). The separate repository decomposition check
also reported existing `native-commands.ts` at 2113/2000. No guest package, Docker
image or ISO changed in this cycle. Final rebased validation is recorded below.

After rebasing onto `e28b9383d`, the continuity migration is `0268` (the two
intervening merged changes own `0266` and `0267`). The final Node HTTP/database
suites passed again (7 cases / 48.56s), and App/Server type checking passed.
The native HTTP case passed on the pre-rebase feature source (14.23s), alongside
both real protocol oracles (94.88s). Native validation of the rebased tree is
blocked by three unchanged baseline syntax errors in managed Goal recovery:
`native_commands/goal_recovery/admission.rs:64` and `receipts.rs:37,39`.
Those files match `e28b9383d`; they were not changed by this CantripOS cycle.
This is not recorded as a native pass on the rebased source.

The rebased root check reports `build-app.ts` at 1519/1500 and
`chat-turn-runtime.ts` at 2230/1999; the repository check reports
`native-commands.ts` at 2143/2000. Those files are unchanged by this cycle.
Formatting and diff checks passed on the final source.
