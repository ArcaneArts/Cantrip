# Synthetic desktop builds

Status: proposed implementation plan. This document does not change runtime
behavior.

## Objective

Allow a packaged Cantrip desktop user to select a commit from Cantrip's
`main` branch, build a native copy for the computer they are currently using,
and install that copy through a guided, observable workflow.

The finished experience must:

- put a **Build Update** action above Version history in General settings;
- open a commit selector with the latest `main` commit selected by default;
- prevent the build from starting until required host tools are present;
- offer to install supported missing prerequisites and visibly report that
  work;
- warn that a full native build can take a long time and consume substantial
  disk and network resources;
- move an accepted build into a dedicated progress window with a step timeline,
  read-only console, and bottom progress bar;
- require confirmation before closing that window and cancelling an active
  build;
- install and relaunch the completed build through the existing active-work
  safety checks; and
- identify a locally built version with a `-x` prerelease suffix, for example
  `1.1.123-x`, plus the selected commit SHA.

Synthetic builds are desktop-only. A macOS client builds `darwin-arm64` and a
Windows client builds `win32-x64`. Cross-compilation, Linux, mobile, browser,
remote-worker builds, arbitrary repositories, arbitrary branches, and dirty
local source trees are outside the first release.

## Product decisions

1. The target is always an immutable full commit SHA that was observed on the
   official `ArcaneArts/Cantrip` `main` branch. Branch names are never passed to
   the build after selection.
2. The latest returned commit is selected when the selector opens. The user
   must explicitly choose **Continue** and later **Build and install**.
3. Only one synthetic build job may run at a time. Reopening Build Update while
   a job is active focuses its progress window.
4. The build runs on the same computer and architecture as the installed app.
   It does not use GitHub Actions or upload artifacts.
5. Official releases continue to use the existing Tauri updater, official
   Minisign key, and Apple release signing/notarization. Synthetic artifacts
   use a separate local-only install path described below.
6. Successful synthetic artifacts are retained and shown as local entries in
   Version history until the user deletes them or cache retention removes them.
   Reinstalling a valid cached artifact does not rebuild it.
7. A synthetic install never advances `release`, creates a Git tag or GitHub
   release, changes a project checkout, or writes to the user's repository.

## Signing and trust boundary

This feature must not weaken the official updater to make local builds fit.
The official updater private key and Apple Developer ID credentials cannot be
distributed to clients. Consequently, a locally generated bundle cannot be
accepted as an official update and cannot claim to be notarized.

Synthetic installation is a distinct native operation with these constraints:

- source is fetched only from the hard-coded official Cantrip repository;
- the selected SHA must remain reachable from `origin/main` after the mirror is
  refreshed;
- the build checkout must be detached at that SHA and clean before and after
  packaging;
- the coordinator hashes the completed bundle and writes an immutable local
  artifact manifest before installation;
- the installer accepts only an artifact path inside Cantrip's synthetic cache
  whose manifest belongs to the currently active build job;
- the official Tauri updater signature-verification path remains unchanged and
  continues rejecting unsigned remote artifacts; and
- the UI clearly labels the result **Synthetic build** and never describes it
  as signed, notarized, stable, or official.

On macOS, the synthetic application must be ad-hoc signed after all embedded
binaries are assembled. It will not be Developer ID signed or notarized. The
implementation milestone must include a compatibility spike proving that an
ad-hoc replacement can relaunch, retain the `art.cantrip` data directory, and
access existing credentials without destructive Keychain migration. If that
cannot be proven, macOS synthetic builds must install alongside the official
app under a separate bundle identifier rather than silently weakening macOS
security.

On Windows, the locally produced NSIS bundle is not Authenticode-signed and has
no official updater signature. Because the executable is generated locally it
should not carry browser quarantine metadata, but Windows may still display a
UAC or reputation prompt. Cantrip must explain the prompt and must not attempt
to suppress it.

Building a historical Cantrip commit executes code from that commit. The final
warning must state this explicitly even though selection is restricted to the
official `main` history.

## User experience

### Entry point

General settings keeps the existing update control and Version history. The
Version history heading gains a right-aligned **Build Update** button. It is
visible only when the native synthetic-build capability reports a supported
packaged desktop environment.

If a job is running, the button reads **View Build** and focuses the existing
progress window. If a completed artifact for the selected commit is already
cached, the later confirmation says **Install cached build** and skips build
steps.

### Commit selector

Build Update opens a normal settings dialog, not the progress window. The
dialog contains:

- a search field for commit subject or SHA;
- a paginated, virtualized flat list of commits from `main`;
- short SHA, subject, author, authored date, and synthetic version when the
  local mirror has resolved its commit count;
- a selected-row indicator;
- **Cancel** and **Continue** footer actions; and
- the latest commit selected and scrolled into view by default.

The API returns full SHAs, while the UI displays a 7-12 character abbreviation.
Selection state always stores the full SHA. Pagination must not replace or
silently move the selected target when newer commits arrive.

The initial list can come from GitHub's commits API for fast display. In
parallel, Cantrip refreshes its local bare mirror. Before Continue becomes
available, the coordinator must resolve the selected SHA in that mirror,
verify it is reachable from the refreshed `origin/main`, read `version.json`
from the commit, and calculate `git rev-list --count <sha>`.

### Prerequisite gate

Continue runs a non-mutating prerequisite scan. If everything is ready, Cantrip
moves directly to the final warning. Otherwise it opens a prerequisite dialog
with one row per requirement:

- requirement and detected/current version;
- required version or capability;
- status: Ready, Missing, Installing, Needs attention, Restart required, or
  Failed;
- whether installation is per-user or requires an operating-system prompt;
- an **Install prerequisites** action; and
- a **Check again** action.

Cantrip may initiate every supported prerequisite installer, but it must not
bypass UAC, macOS installer UI, license acceptance, or reboot requirements.
Privileged installers run only after this explicit action. Output from
prerequisite installation is shown inside this dialog and is also written to
the job log. The gate rescans after installation and remains blocked until all
requirements pass.

The first implementation should prefer Cantrip-managed, per-user toolchains in
the synthetic cache over global mutation:

| Requirement     | macOS                                                  | Windows                                                         | Installation policy                                     |
| --------------- | ------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------- |
| Git             | Xcode Command Line Tools Git or a verified managed Git | Verified PortableGit                                            | Initiate OS prompt on macOS; managed install on Windows |
| Node            | Pinned Node 24 archive                                 | Pinned Node 24 archive                                          | Managed, checksum-verified                              |
| pnpm            | Repository `packageManager`, currently 11.15.1         | Same                                                            | Managed through the pinned Node toolchain               |
| Rust            | Repository-supported toolchain, currently 1.95.0       | `1.95.0-x86_64-pc-windows-msvc`                                 | Managed rustup home                                     |
| Native C/C++    | Xcode Command Line Tools                               | VS 2022 C++ Build Tools, Windows SDK, Spectre x64/x86 libraries | OS installer; may require admin/reboot                  |
| Build utilities | Commit-specific verified requirements                  | CMake and NASM plus commit-specific requirements                | Managed archives where possible                         |

Pinned download URLs, publishers, versions, and SHA-256 values belong in a
versioned toolchain manifest shipped with Cantrip. Never execute an unpinned
`curl | sh`, trust the first executable found on `PATH`, or install a floating
latest toolchain.

The selected commit may require a toolchain older or newer than the running
client understands. A compatibility probe must inspect the checkout before
building. Unsupported commits remain visible but explain why they cannot be
built by this Cantrip version.

### Final warning

After prerequisites pass, show a final confirmation containing:

- selected synthetic version, full SHA, subject, and date;
- target platform and architecture;
- whether the result will be built or restored from cache;
- estimated disk requirement based on current cache and a conservative cold
  build allowance;
- notice that the operation can take tens of minutes on a cold cache;
- notice that source and package build scripts from the selected commit will
  execute locally;
- notice that the result is not an official signed/notarized release; and
- **Back** and **Build and install** actions.

Accepting this warning creates the durable job record, closes the dialog, and
opens the progress window.

### Build progress window

The progress surface is a dedicated Tauri window and app route. It has no
project navigation, settings navigation, composer, browser controls, or build
controls. Native operating-system window chrome remains so normal close,
minimize, focus, accessibility, and keyboard behavior continue to work.

The content fills the window:

- a narrow left timeline lists every build step and its Pending, Running,
  Complete, Skipped, Failed, or Cancelled state;
- the main area is a read-only, selectable, virtualized console that follows
  new output by default and lets the user pause follow by scrolling;
- a compact header shows `1.1.<count>-x`, short SHA, elapsed time, and cache
  status;
- the bottom edge contains one control-less aggregate progress bar and current
  step label; and
- failure replaces the bottom status with the error summary and actions to
  copy/open the complete log, retry from the first invalid step, or close.

Progress is event-driven. It advances when concrete substeps complete, not from
an elapsed-time animation. Steps may report determinate byte/item progress when
available. Indeterminate work keeps the aggregate bar at the start of that
step and animates only the active segment.

Closing the progress window while a job is active must be intercepted natively:

1. `CloseRequested` is prevented for the synthetic-build window label.
2. The window displays **Cancel build?** with **Keep building** and **Cancel
   build**.
3. Keep building dismisses the prompt.
4. Cancel build asks the native coordinator to terminate the complete process
   tree, waits for termination and cache metadata cleanup, marks the job
   Cancelled, then closes the window.

JavaScript `beforeunload` is not sufficient. The existing Tauri `RunEvent`
window handling in `cantrip_app/src-tauri/src/lib.rs` is the enforcement point.
Quitting Cantrip while a build is active uses the same confirmation and cannot
orphan compiler processes.

### Completion and installation

When verification succeeds, the timeline enters **Ready to install**. Cantrip
rechecks active chats, queued prompts, terminal services, and background jobs
using the existing desktop-update active-work contract. If work is active, the
progress window shows the existing explicit stop-work confirmation before
installation.

Installation then uses the same user-visible phases as a normal update:
preparing, installing, and restarting. The underlying local installer is
separate from the official updater because of the signing boundary above.

The installer must:

1. verify the artifact manifest, SHA-256, target platform, architecture,
   version, build ID, and cache-root containment;
2. stage the new application on the same filesystem as the destination;
3. preserve a rollback copy of the currently installed application;
4. stop Cantrip-owned server, worker, Code, terminal, and build processes;
5. atomically replace the application where the platform permits;
6. launch the synthetic application with the pending install ID; and
7. delete the rollback only after the new application reports a successful
   first launch.

If the new application fails to acknowledge startup within a bounded timeout,
the helper restores the prior application and relaunches it. Installer logs and
the failed synthetic artifact remain available for diagnosis.

## Synthetic version and identity

The version is derived from the selected commit, not the currently running
app:

```text
<version.json major>.<version.json minor>.<git commit count>-x
```

For example, commit count 123 under version family 1.1 becomes `1.1.123-x`.
The `-x` value is a SemVer prerelease qualifier. macOS `CFBundleVersion`
remains the numeric commit count; platform metadata that requires numeric-only
values must not receive `-x`.

`scripts/version.mjs`, `scripts/tauri-build.mjs`, and generated
`@cantrip/version` metadata need an explicit synthetic-build input rather than
string concatenation in several callers. Generated metadata should include:

```ts
type CantripBuildIdentity = {
  version: string; // 1.1.123-x
  commitCount: number; // 123
  commitSha: string; // full SHA
  synthetic: true;
  builtAt: string;
  buildId: string;
  overlayDigest: string;
};
```

The synthetic coordinator may need a small, versioned build overlay so commits
that predate this feature can consume the synthetic version input. Such an
overlay must be limited to build/version plumbing, have a recorded digest, and
leave the detached Git worktree clean. The UI must report **selected commit +
synthetic build overlay**, not claim byte-for-byte reproduction of the original
commit. Commits whose layout cannot accept the overlay fail the compatibility
gate instead of receiving broad source patches.

The installer writes a pending identity record outside the application bundle.
On first launch, native code compares the running package version and install
ID, promotes the record to active, and exposes it to the UI. General settings
shows:

```text
Installed version 1.1.123-x · Synthetic build · abc1234
```

The identity record also supports About/log diagnostics. An official update
clears the active synthetic marker after successful launch. Official version
comparison remains safe: `1.1.123` sorts after `1.1.123-x`, allowing the stable
release for the same commit count to replace a hot build.

## Native architecture

### Coordinator

Add a `SyntheticBuildCoordinator` managed by Tauri, separate from
`DesktopUpdateCoordinator`. It owns:

- the one-active-job lock;
- durable job and step state;
- prerequisite scans and installers;
- the Git mirror and detached worktree lifecycle;
- child-process groups and cancellation;
- bounded console buffering and log persistence;
- artifact manifests and cache accounting;
- progress-window creation/focus/close policy; and
- handoff to the local synthetic installer.

The coordinator, not the React window, owns the process. Navigating settings,
closing the main window to the tray, or reloading the progress webview must not
lose the job. A full app exit must cancel it cleanly.

On Unix, commands run in their own process group and cancellation signals the
group before escalating after a timeout. On Windows, every process belongs to a
Job Object configured to terminate descendants. Commands are spawned without a
shell, with explicit argument arrays and an allowlisted environment.

### Proposed commands

```ts
type SyntheticBuildCapability = {
  available: boolean;
  platform: "darwin-arm64" | "win32-x64" | null;
  reason: string | null;
};

type SyntheticCommit = {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authoredAt: string;
  commitCount: number | null;
  syntheticVersion: string | null;
  buildable: boolean | null;
  reason: string | null;
};

type SyntheticBuildJob = {
  id: string;
  target: SyntheticCommit;
  platform: "darwin-arm64" | "win32-x64";
  state:
    | "gating"
    | "queued"
    | "running"
    | "ready-to-install"
    | "installing"
    | "restarting"
    | "completed"
    | "failed"
    | "cancelled";
  stepId: string | null;
  progress: number;
  startedAt: string;
  updatedAt: string;
  error: { code: string; message: string; retryable: boolean } | null;
};
```

Tauri commands:

- `synthetic_build_capability`
- `list_synthetic_build_commits({ cursor, query })`
- `resolve_synthetic_build_target({ sha })`
- `scan_synthetic_build_prerequisites({ sha })`
- `install_synthetic_build_prerequisites({ sha, ids })`
- `start_synthetic_build({ sha })`
- `synthetic_build_status()`
- `cancel_synthetic_build({ jobId })`
- `retry_synthetic_build({ jobId })`
- `list_cached_synthetic_builds()`
- `install_cached_synthetic_build({ artifactId })`
- `delete_cached_synthetic_build({ artifactId })`
- `open_synthetic_build_log({ jobId })`
- `acknowledge_synthetic_install({ installId })`

Events:

- `cantrip-synthetic-build-state`
- `cantrip-synthetic-build-step`
- `cantrip-synthetic-build-log-batch`
- `cantrip-synthetic-build-prerequisite`
- `cantrip-synthetic-build-install`
- `cantrip-synthetic-build-close-requested`

Log events must be batched and sequence-numbered. The progress window requests
a snapshot plus `afterSequence` replay before subscribing, preventing gaps
during creation or reload.

## Build pipeline

Refactor the existing packaging libraries instead of duplicating the release
workflow in Rust. Add a machine-readable `scripts/synthetic-build.mjs` entry
point that calls the same package/build helpers and emits structured progress
records while preserving ordinary stdout/stderr as console output.

Recommended initial steps and aggregate weights:

| Weight | Step                 | Required outcome                                                    |
| -----: | -------------------- | ------------------------------------------------------------------- |
|      3 | Resolve target       | SHA is on refreshed `origin/main`; version and overlay are fixed    |
|      5 | Prepare source       | Bare mirror refreshed; detached clean worktree materialized         |
|      4 | Verify prerequisites | Toolchain manifest and host capabilities pass                       |
|      8 | Install dependencies | Frozen pnpm lockfile installed using managed Node/pnpm store        |
|     18 | Build Codex runtime  | Pinned Codex source verified and native runtime cached/built        |
|      6 | Build Cantrip CLI    | Release CLI produced for the host target                            |
|     18 | Build Cantrip Code   | Fingerprinted editor distribution verified or built                 |
|     14 | Build services       | Protocol, crypto, logging, server, and worker packaged              |
|     18 | Build desktop        | Frontend, embedded runtime, Rust app, and host bundle produced      |
|      4 | Verify artifact      | Target, identity, bundle contents, hashes, and launch metadata pass |
|      2 | Stage install        | Artifact manifest committed and rollback/install helper prepared    |

These are progress weights, not concurrency requirements. The first milestone
should run major steps sequentially for deterministic cancellation and logs.
Later work may parallelize independent service builds while retaining a stable
timeline.

The build environment must set explicit cache roots and remove secrets and
unrelated user environment variables. At minimum, do not forward server
credentials, model-provider keys, GitHub tokens, signing credentials, shell
startup hooks, `NODE_OPTIONS`, `RUSTFLAGS`, or package-registry auth unless a
specific audited requirement is added.

## Cache layout and retention

Use the platform app-data directory, never a project folder:

```text
synthetic-builds/
  mirror/cantrip.git/
  worktrees/<full-sha>/
  toolchains/<tool>/<version>/<platform>/
  stores/pnpm/
  stores/cargo-home/
  stores/cargo-target/<rust-lock-toolchain-fingerprint>/
  stores/cantrip-code/
  stores/codex/<source-fingerprint>/
  jobs/<job-id>/job.json
  jobs/<job-id>/build.log
  artifacts/<platform>/<sha>/<overlay-digest>/
    artifact.json
    bundle/
  installs/pending.json
  installs/active.json
  rollback/<install-id>/
```

Reuse existing content-addressed Cantrip Code and Codex fingerprints where
possible. A cache hit is accepted only after the existing verification logic
passes. Never trust presence alone.

Default retention:

- keep all toolchain/download stores within a configurable shared quota;
- keep the most recent successful artifact, the currently installed artifact,
  and any artifact explicitly pinned by the user;
- keep failed/cancelled logs for seven days;
- remove detached worktrees after a successful artifact is committed;
- clean abandoned worktrees and partial artifacts at startup; and
- use LRU eviction for unpinned artifacts and compiler caches, never deleting
  the active install or rollback required by a pending install.

General settings should show cache size, **Open cache folder**, and **Clean
unused build cache** near Build Update after the core workflow is stable.

## Failure, retry, and recovery

- Prerequisite failure returns to the gate and preserves diagnostic output.
- Network or mirror failure keeps the previously verified mirror usable only
  for commits already known to be on `main`; it must clearly label the catalog
  stale and cannot claim a newly selected remote SHA is verified.
- Build failure records the failed step and leaves verified upstream caches.
  Retry starts at the earliest step whose inputs or outputs are invalid.
- Cancellation removes partial artifacts and the detached worktree but keeps
  safe shared downloads and compiler caches.
- A crashed app marks a previously Running job Interrupted on next launch,
  terminates any adopted/orphaned process if possible, and offers retry.
- Install failure restores the previous application. It never deletes the
  only runnable copy.
- A cached artifact whose manifest or hash fails is quarantined and rebuilt;
  it is never installed with a warning override.

## Implementation milestones

### Milestone 1: feasibility and contracts

- Prove unsigned/ad-hoc packaging and rollback installation on a clean macOS
  and Windows test machine.
- Verify data directory, credential access, local server/worker startup, and
  return to an official update.
- Add the synthetic build identity/version inputs and tests.
- Finalize the pinned prerequisite manifest and minimum buildable commit.
- Add protocol types for jobs, steps, logs, prerequisites, artifacts, and
  errors.

Do not expose Build Update outside development until both platform install
spikes pass.

### Milestone 2: source, prerequisites, and cache

- Implement capability, commit catalog, full-SHA resolution, main-reachability
  verification, bare mirror, worktrees, and commit-count versioning.
- Implement non-mutating prerequisite probes.
- Implement managed toolchain downloads with checksum verification and
  explicit OS installer handoffs.
- Implement cache manifests, locking, quota accounting, and cleanup.
- Add the commit selector, prerequisite gate, and final warning dialogs.

### Milestone 3: build coordinator and progress window

- Refactor packaging helpers behind `scripts/synthetic-build.mjs`.
- Implement process groups/Job Objects, structured step events, batched logs,
  cancellation, durable job snapshots, and interrupted-job recovery.
- Add the dedicated Tauri route/window, timeline, virtualized console, bottom
  progress bar, focus-existing behavior, and native close confirmation.

### Milestone 4: installation and identity

- Implement artifact verification, rollback staging, platform installers,
  active-work confirmation, restart handoff, first-launch acknowledgement, and
  rollback timeout.
- Display synthetic version/SHA in General settings, About, and diagnostics.
- Add cached synthetic artifacts to Version history with reinstall/delete
  actions.
- Verify that official updates clear synthetic identity and can replace a
  matching `-x` prerelease.

### Milestone 5: hardening and release

- Add disk-pressure, offline, cancellation-race, app-crash, installer-crash,
  reboot-required, stale-main, corrupted-cache, and rollback tests.
- Run cold and warm build benchmarks on minimum supported macOS and Windows
  hardware.
- Redact logs and audit environment forwarding.
- Gate the feature behind a capability/feature flag, then roll it out after the
  platform acceptance matrix passes.

## Test strategy

Unit tests:

- commit pagination, search, full-SHA selection, latest default, and selection
  stability during refresh;
- main reachability, commit count, version family, `-x` generation, and overlay
  digest;
- prerequisite detection, pinned installer verification, rescans, reboot
  states, and unsupported commits;
- job reducer/state transitions, weighted progress, log sequence replay, cache
  keys, eviction protection, cancellation idempotence, and retry boundaries;
- artifact path containment, hashes, target identity, first-launch
  acknowledgement, and rollback decisions; and
- official-versus-synthetic SemVer ordering.

Integration tests:

- fixture repository mirror and detached worktree with a moving `main`;
- spawned process trees that produce interleaved output and grandchildren,
  then cancel on Unix and Windows;
- cold and warm synthetic script runs against a small packaging fixture;
- progress-window creation/reload/close confirmation and gap-free log replay;
- active-work confirmation before install; and
- corrupt, incomplete, wrong-platform, and escaped-cache artifacts rejected
  before any install mutation.

Platform acceptance:

1. Start from a clean supported machine and install every prerequisite through
   Cantrip's gate.
2. Build the latest commit selected by default.
3. Confirm every timeline phase and live console output.
4. Cancel during dependency installation and native compilation; confirm no
   descendants remain.
5. Retry with a warm cache and verify meaningful reuse.
6. Install, relaunch as `1.1.<count>-x`, and show the exact commit SHA.
7. Build and install a different older `main` commit.
8. Reinstall the first retained artifact without rebuilding.
9. Install an official release and confirm synthetic identity is cleared.
10. Force launch failure and verify automatic rollback to the prior app.

## Acceptance criteria

- Build Update appears above Version history only on supported packaged desktop
  clients.
- The latest `main` commit is selected by default and no branch race can change
  the confirmed full SHA.
- A build cannot start until all prerequisites pass, and every supported
  missing prerequisite has an explicit guided installation path.
- The progress window remains responsive during a cold build, never drops log
  lines across reload, and cannot be closed without a cancellation decision.
- Cancellation terminates the complete process tree and never leaves a partial
  installable artifact.
- The build uses the selected commit, recorded synthetic overlay, current host
  platform, pinned toolchains, and frozen dependency graph.
- Official updater verification is unchanged; no official signing secret is
  present on the client.
- Installation is hash-verified, rollback-capable, and protected by the current
  active-work confirmation.
- Relaunch reports `major.minor.commitCount-x`, exact SHA, build time, and build
  ID as synthetic metadata.
- A second build reuses verified caches and retained artifacts can be installed
  later without recompilation.
- macOS and Windows platform acceptance, rollback, credential/data continuity,
  and return-to-official-update tests pass before the feature is enabled by
  default.
