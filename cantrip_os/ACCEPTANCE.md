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
