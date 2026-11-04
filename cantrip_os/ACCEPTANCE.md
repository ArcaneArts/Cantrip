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
