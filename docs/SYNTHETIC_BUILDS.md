# Synthetic desktop builds

Status: implemented on `main`. Packaged macOS and Windows installation
acceptance remains release qualification.

Synthetic builds let a packaged Cantrip desktop user select a commit from the
official repository's `main` history, build a native copy on the current
computer, cache the result, and install it. They do not use GitHub Actions,
advance `release`, create tags or releases, modify a project checkout, or
upload the artifact.

## Availability and trust boundary

The capability is enabled without a feature flag in packaged release builds on
Apple Silicon macOS (`darwin-arm64`) and 64-bit Windows (`win32-x64`). It is
disabled in debug builds, browser/mobile builds, Linux, Intel macOS, and other
architectures. Cross-compilation and arbitrary repositories or branches are not
supported.

This current availability is broader than the remaining release evidence:
packaged installation and recovery still require qualification on clean macOS
and Windows machines.

Official updater signing remains separate and unchanged. Synthetic builds:

- use a full commit SHA observed on the official `main` history;
- derive a version ending in `-x`, such as `1.1.123-x`;
- disable Tauri updater artifacts;
- retain the normal `art.cantrip` application identifier;
- use Tauri ad-hoc signing (`signingIdentity: "-"`) on macOS; and
- produce an unsigned NSIS installer on Windows.

They are local synthetic artifacts, not official signed, notarized, or stable
releases.

## Settings flow

General settings places **Build Update** beside Version history. If a build is
active, the action becomes **View Build** and focuses its progress window.

### Commit selection and preparation

The selector loads paginated commits from `main`, selects the latest buildable
commit by default, and shows subject, short SHA, author, and date. The list is a
normal scroll container rather than a virtualized list. Search filters the
pages already loaded in the client; the native list command accepts only a
page cursor.

Before continuing, the native coordinator:

1. refreshes the local bare mirror;
2. resolves and validates the full SHA;
3. verifies that the commit is reachable from refreshed `origin/main`;
4. reads the version family and commit count; and
5. scans host prerequisites and prepares the private toolchain.

A mirror-refresh failure aborts the operation. The implementation does not fall
back to a labeled stale mirror, even when that mirror already contains the SHA.

Pinned Node 24.19.0 and rustup downloads are SHA-256 verified. The selected
commit's package-manager version is installed through the private Node runtime,
and Rust uses private Cargo/rustup homes. Host Git and native compiler/build
requirements are probed but not installed. These tools and caches stay under
the app-data `synthetic-builds` directory and do not modify the user's shell or
global toolchains.

### Confirmation

The confirmation shows:

- synthetic version;
- full commit SHA;
- commit subject;
- whether a verified cached artifact will be installed instead of rebuilt;
- a tens-of-minutes warning for a cold build;
- disk and network usage prose; and
- an unsigned/unnotarized warning.

The actions are **Back** and either **Build and install** or **Install cached
build**. The current dialog does not show target architecture, commit date, a
numeric disk estimate, or a separate warning that the selected commit's build
scripts execute locally.

## Build coordinator and progress window

One native `SyntheticBuildCoordinator` owns the active job, mirror, toolchain,
detached worktree, child process, persisted log/state, artifact, and install
handoff. The current job states are:

```text
queued | running | ready-to-install | failed | cancelled
```

Step states are `pending`, `running`, `complete`, `failed`, and `cancelled`.
There is no skipped step or separate gating, installing, restarting, or
completed job state.

The dedicated progress window omits project, settings, composer, and browser
navigation. It shows:

- a non-virtualized step timeline;
- a selectable, non-virtualized console retaining the latest 10,000 entries;
- version, 12-character SHA, platform, elapsed time, and percent complete;
- **Install build** when the artifact is ready; and
- **Retry build** plus **Open log** after failure.

Retry starts a complete new job for the same SHA. It does not resume at the
failed step.

Closing the progress window while work is active opens the native **Cancel
build?** confirmation. On Unix, cancellation signals the process group with
TERM and escalates to KILL. On Windows it runs
`taskkill.exe /PID <pid> /T /F`; Windows Job Objects are not used. The detached
worktree is hard-reset and removed afterward.

An app restart converts a persisted `queued` or `running` job to `failed` with
the `synthetic_build_interrupted` code. It does not adopt or terminate an
orphaned build process.

## Build pipeline

The coordinator overlays the running application's current
`scripts/version.mjs`, `scripts/tauri-build.mjs`, and
`scripts/synthetic-build.mjs` into the detached target worktree and records a
SHA-256 digest of that overlay. The version and Tauri scripts consume the
`CANTRIP_SYNTHETIC_*` environment contract. After the job, the coordinator
hard-resets and removes the detached worktree.

The pipeline runs these weighted steps sequentially:

| Weight | Step                      |
| -----: | ------------------------- |
|      3 | Resolve target            |
|      5 | Prepare source            |
|      4 | Verify prerequisites      |
|      8 | Install dependencies      |
|     18 | Build Codex runtime       |
|      6 | Build Cantrip CLI         |
|     18 | Build Cantrip Code        |
|     14 | Build Cantrip services    |
|     18 | Package Cantrip desktop   |
|      4 | Verify synthetic artifact |
|      2 | Stage synthetic artifact  |

The first three steps are performed by the coordinator; the remaining steps
are driven by `scripts/synthetic-build.mjs`. Its final `pnpm bundle` call
re-enters the complete bundle path and therefore rebuilds or repackages Codex,
CLI, Code, and services before the desktop bundle. The preceding named steps do
not guarantee each component is built only once.

The synthetic version is derived from the selected commit:

```text
<version.json major>.<version.json minor>.<git commit count>-x
```

The full SHA, build ID, build time, and overlay digest are also embedded in the
generated build identity.

## Artifact verification and cache

The coordinator writes `artifact.json` beside a staged `bundle/`. Listing and
installation accept an artifact only when verification confirms:

- containment under the synthetic artifact cache;
- schema/component compatibility and the current platform;
- an `-x` version, non-empty build ID, and full commit SHA;
- safe manifest-listed relative paths; and
- matching size/SHA-256 for each listed file and matching target for each
  listed link.

Verification covers only entries listed in the manifest. It does not reject an
extra unlisted bundle file, treat the manifest as immutable, or bind the
artifact to the active job's build ID or overlay digest. Any verified cached
artifact may be reinstalled by its derived artifact ID.

Successful artifacts remain cached until explicitly deleted. The artifact
recorded as the active synthetic installation cannot be deleted. Invalid
artifacts are silently omitted from cached-build listings; they are not
quarantined or rebuilt automatically.

The persistent layout is:

```text
synthetic-builds/
  mirror/cantrip.git/
  worktrees/<sha>/
  toolchains/
    node-v24.19.0-<platform>/
    pnpm-<version>/
    cargo-home/
    rustup-home/
    downloads/
  stores/
    npm/
    pnpm/
    cargo-target/
    cantrip-code/
  jobs/current.json
  jobs/<id>/job.json
  jobs/<id>/build.log
  artifacts/<platform>/<sha>/<overlay-digest>/artifact.json
  artifacts/<platform>/<sha>/<overlay-digest>/bundle/
  installs/pending.json
  installs/active.json
  rollback/<install-id>/app/      # Windows only
```

**Clean unused build cache** deletes only `worktrees/` and
`stores/cargo-target/`, and is unavailable while a build is active. Settings
also reports the verified artifact total and offers **Open cache**. There is no
quota, pinning, LRU eviction, seven-day log retention, startup cleanup, or
persistent Codex store.

## Installation behavior

Installation first enforces the desktop-update active-work confirmation, writes
`installs/pending.json`, shuts down Cantrip-owned runtimes, and hands off to a
platform helper.

### macOS

The helper waits for the current process to exit and launches the ad-hoc
`.app` directly from the artifact cache. After ten seconds, it copies pending
identity to active when that cached application process is alive; otherwise it
reopens the current application. It does not replace the installed app or stage
a rollback copy.

### Windows

The helper copies the current installation directory to
`rollback/<install-id>/app`, runs the cached NSIS installer, and launches the
installed executable. If that process is not alive after ten seconds, the
helper launches the executable from the rollback copy. It does not atomically
restore the old installation in place.

There is no explicit first-launch acknowledgement command. Startup
reconciliation promotes a pending identity when its `version` equals the
running package version; it does not compare the install ID. If an active
synthetic identity's version differs from the running package version, the
active marker is removed.

## Native command and event surface

The implemented Tauri commands are:

- `synthetic_build_capability`
- `scan_synthetic_build_prerequisites({ sha })`
- `list_synthetic_build_commits({ cursor })`
- `resolve_synthetic_build_target({ sha })`
- `start_synthetic_build({ sha })`
- `synthetic_build_status()`
- `synthetic_build_logs({ afterSequence, limit })`
- `cancel_synthetic_build({ jobId })`
- `list_cached_synthetic_builds()`
- `install_cached_synthetic_build({ artifactId, request })`, where `request`
  contains `activeWork` and `confirmActiveWork`
- `delete_cached_synthetic_build({ artifactId })`
- `synthetic_build_identity()`
- `open_synthetic_build_log({ jobId })`
- `open_synthetic_build_cache()`
- `clean_unused_synthetic_build_cache()`

The events are `cantrip-synthetic-build-state`,
`cantrip-synthetic-build-log-batch`, `cantrip-synthetic-build-install`, and
`cantrip-synthetic-build-close-requested`. There are no separate step or
prerequisite events.

## Remaining release qualification

Before treating this as a supported release path, qualification should cover:

- packaged cold and warm builds on minimum macOS and Windows hosts;
- macOS ad-hoc launch, data-directory/credential continuity, and return to an
  official update;
- Windows unsigned-installer prompts, successful relaunch, and rollback-copy
  fallback;
- app/process interruption and cancellation behavior;
- disk exhaustion, corrupted manifests/listed files, and cache cleanup; and
- the current limitations documented above, especially unlisted artifact
  files, version-only identity promotion, lack of cache retention policy, and
  duplicated packaging work.

Source anchors are
[`synthetic_build.rs`](../cantrip_app/src-tauri/src/synthetic_build.rs),
[`job.rs`](../cantrip_app/src-tauri/src/synthetic_build/job.rs),
[`artifact.rs`](../cantrip_app/src-tauri/src/synthetic_build/artifact.rs),
[`synthetic-build-settings.tsx`](../cantrip_app/src/components/settings/synthetic-build-settings.tsx),
and [`scripts/synthetic-build.mjs`](../scripts/synthetic-build.mjs).
