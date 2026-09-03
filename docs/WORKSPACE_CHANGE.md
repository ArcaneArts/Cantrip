# Workspace storage and repository import

Status: implemented. This document describes the current storage, discovery,
and import contract. The implementation sequence is retained as delivery
history rather than future work.

## Purpose

Cantrip workspaces organize projects, policy inheritance, and sidebar
visibility, and every workspace has an explicit storage profile. The system and
legacy workspaces retain the established worker-level roots. A managed
workspace derives Cantrip-owned roots on each worker, while an attached
workspace binds an existing user-owned directory on one home worker.

Attached workspace roots can be scanned for Git repositories and selected
checkouts can be registered as projects without cloning or moving them.
Cantrip preserves the invariant that each project belongs permanently to
exactly one workspace.

## Terminology

- **System workspace**: the built-in workspace initially named `Default`.
- **Default destination**: the workspace selected automatically when a new
  project is created without an explicit workspace. This is separate from the
  identity of the system workspace.
- **Managed workspace**: a user-created workspace whose filesystem roots are
  created and owned by Cantrip beneath each worker's data directory.
- **Attached workspace**: a user-created workspace backed by an existing,
  user-owned directory on one worker.
- **Legacy workspace**: a custom workspace created before workspace storage
  profiles existed. It retains the old virtual grouping behavior.
- **Home worker**: the worker that owns an attached workspace's root directory.

## Final product decisions

1. A managed workspace is one logical, account-owned workspace that can be used
   on multiple workers. Each worker has a separate local root for it.
2. An attached workspace has an immutable home worker and immutable root path.
3. Home-worker affinity is preferred, not absolute. Imported projects prefer
   the home worker, but a project may run on another worker when a valid source
   or replica exists there.
4. Repository discovery scans the attached root and descendants through depth
   three by default.
5. Discovery offers only Git repositories. Ordinary non-Git directories are
   not offered as import candidates.
6. A GitHub checkout that the worker's current `gh` credentials cannot access
   is imported as a local Git-capable project. It can be upgraded to a GitHub
   project later.
7. Attached workspaces cannot be the default destination. The system workspace,
   managed workspaces, and backwards-compatible legacy workspaces are eligible.
8. The system workspace is the initial default destination. A user may
   explicitly select another eligible Cantrip-managed workspace as the default.
9. A remote attached path may be entered as an absolute path. When the Tauri
   client and selected worker are on the same machine, the UI also offers the
   native folder picker.
10. Existing workspaces and project directories are never moved implicitly.
    Existing custom workspaces become legacy workspaces.

## Storage model

### System workspace

The built-in system workspace keeps the current placement behavior. Its
projects may continue to use the existing worker-managed roots:

```text
<worker-data>/repositories/<owner>/<repository>
<worker-data>/folders/<project-id>
```

The system workspace does not expose a configurable filesystem root. Changing
which eligible workspace is the default destination does not change the system
workspace's storage class.

### Managed workspace

A managed workspace is server-owned and worker-portable. Workers derive its
root from the workspace ID:

```text
<worker-data>/workspaces/<workspace-id>/
├── repositories/<owner>/<repository>
└── folders/<project-id>
```

The root is created lazily when a project in the workspace first needs storage
on that worker. The same workspace ID may therefore have independent roots on
several workers. Cantrip does not imply that files in those roots are shared;
Git and the existing replica system remain responsible for repository
synchronization.

Workspace names are not used in filesystem paths. Renaming a workspace cannot
move or rename its directories.

### Attached workspace

An attached workspace identifies one existing directory on one home worker.
The worker canonicalizes the directory and registers it in the existing routing
registry. The server stores only the worker ID and protected routing handles,
not the plaintext absolute path.

The attached root remains user-owned:

- Cantrip must never delete, rename, relocate, or recursively clean it.
- Deleting the Cantrip workspace is allowed only when it contains no projects.
- Deleting an empty attached workspace removes only Cantrip's binding and scan
  records.
- Changing the home worker or root path is not supported. The user must create
  a different workspace instead.

## Persistent model

Every workspace has a one-to-one storage profile, keeping worker filesystem
state separate from the existing workspace naming and policy record.

```text
project_workspace_storage_profiles
  workspace_id                 primary key, foreign key
  kind                         system | legacy | managed | attached
  worker_id                    nullable; required for attached
  protected_root_path_handle   nullable; required for attached
  protected_display_handle     nullable; required for attached
  revision                     optimistic concurrency revision
  created_at
  updated_at
```

Database constraints must enforce that only attached profiles contain worker
and root bindings. The built-in workspace receives `system`; existing custom
workspaces receive `legacy`; all newly created custom workspaces must explicitly
choose `managed` or `attached`.

Discovery should use durable server-owned jobs so it survives navigation,
disconnects, and server restarts:

```text
workspace_repository_discovery_jobs
  id, owner_id, workspace_id, worker_id
  state, attempt, lease, error, timestamps

workspace_repository_candidates
  id, job_id, workspace_id, worker_id
  protected_path_handle, repository_fingerprint
  classification, import_state, diagnostic_code
  protected repository metadata, timestamps
```

Candidate records must contain protected routing metadata only. Stable private
display values and GitHub repository identity must continue to use Cantrip's
existing encryption and blind-index conventions.

## Workspace creation flow

The New Workspace dialog asks for a name and one of two storage choices:

### Managed by Cantrip

The server creates the logical workspace and managed storage profile. No worker
must be online because roots are materialized lazily.

### Use an existing folder

The dialog requires:

- an enrolled worker;
- an absolute folder path on that worker; and
- a workspace name.

If the selected worker is local to the Tauri client, a native folder picker can
fill the path. Remote workers use path entry in the initial implementation.

Creation invokes the real worker attachment operation. The worker resolves the
protected input path, canonicalizes it, verifies that it is an accessible
directory, and returns protected canonical/display handles. The server creates
the workspace only after that operation succeeds. There is no separate
speculative availability gate whose result can prevent a valid attachment.

After creation, Cantrip starts repository discovery and presents the results for
confirmation.

## Repository discovery

Filesystem discovery belongs entirely to the worker. The app communicates with
it through the server and worker command protocol.

The default scan has the following behavior:

- Inspect the root itself and directories up to three edges below it.
- Do not follow directory symlinks outside the canonical root.
- Stop descending once a repository root is found, preventing submodules and
  nested repositories from being imported accidentally.
- Recognize normal `.git` directories and Git worktree marker files.
- Resolve every candidate with `git rev-parse --show-toplevel` and collapse
  paths that resolve to the same checkout root.
- Exclude bare repositories and non-primary linked worktrees from automatic
  import because they cannot satisfy the current project-source contract.
- Skip expensive contents such as `.git` internals once their containing
  repository has been identified.
- Apply bounded directory, candidate, output, and execution-time limits. A
  truncated scan is successful but reports that more results may exist.
- Emit progress and completion events. The client must not poll continuously.

Users receive a manual **Rescan** action. Worker reconnect makes an interrupted
scan retryable, but merely viewing a workspace does not start periodic scans.

## Git and GitHub classification

For every valid checkout, the worker performs the actual Git operations:

1. Resolve the top-level checkout and Git common directory.
2. Compute the existing repository fingerprint from the common directory.
3. Read `remote.origin.url` when present.
4. Recognize supported GitHub.com SSH and HTTPS origin forms.
5. For a recognized GitHub origin, call `gh api repos/<owner>/<repository>`
   using credentials available to that worker.

The GitHub call is classification data, not a prerequisite for local import.
Its results are:

- **GitHub accessible**: the origin and API repository agree.
- **GitHub unavailable**: the origin is GitHub, but `gh` is unavailable,
  unauthenticated, unauthorized, or cannot reach the API.
- **Local Git**: the checkout is valid Git but does not have a supported
  GitHub.com origin.

GitHub Enterprise and other hosting-provider integrations are outside the first
implementation and remain local Git projects unless separately supported.

## Import review and execution

The review screen lists valid repositories, their relative paths, origin type,
GitHub availability, and any duplicate/conflict status. Import remains an
explicit user action. Already registered paths or GitHub repositories are shown
as skipped, including the workspace that already owns the project. They are
never moved to the new workspace.

### GitHub-accessible checkout

Create a normal GitHub-origin project in the attached workspace and use the
existing direct replica placement with the discovered path. An existing valid
Primary checkout is recorded as user-owned and `attached`; it is not cloned.

### GitHub-unavailable or non-GitHub checkout

Create an external folder-origin project pointing at the existing checkout.
Repository inspection marks it Git-capable and GitHub-incapable. The existing
GitHub conversion workflow can upgrade it later if credentials and origin
access become available.

Import revalidates the checkout at execution time. Discovery results are not
treated as authority. If GitHub access disappears, the candidate may be safely
downgraded to local Git import and the result must say so. If the path no longer
contains the same repository, only that candidate fails.

Batch import is idempotent and permits partial success. A failure in one
repository does not roll back projects imported successfully from other
repositories. Retrying imports only unresolved candidates.

Every imported project is assigned to the attached workspace during the same
server transaction that creates its project definition.

## Worker affinity and replicas

The attached storage root itself exists only on its home worker. Imported
projects initially use that worker as their preferred worker, and Cantrip should
prefer their attached source for agents, terminals, explorers, Code, and other
surfaces.

This is not an absolute execution restriction:

- A GitHub project may create or use a replica on another capable worker.
- A local Git project may use another worker when a compatible source has been
  explicitly attached there.
- A project may select another preferred execution worker once an eligible
  source or replica exists there.
- Cantrip must not pretend that the attached workspace root exists on the other
  worker or silently clone a local-only project there.

When the home worker is offline, the workspace remains visible and identifies
the unavailable home worker. Projects with eligible replicas elsewhere may
still operate there; projects that only have the attached source remain
unavailable until the worker reconnects.

## Default destination rules

The default destination is constrained by storage class:

- The built-in system workspace is the initial default.
- Managed workspaces may be selected as the default.
- Legacy workspaces remain eligible for backwards compatibility.
- Attached workspaces can never be selected as the default.

The server enforces these rules; hiding an action in the UI is insufficient.
The **Make default** action appears only for eligible workspaces. If corrupted
or obsolete state identifies an attached workspace as default, migration or
startup reconciliation restores the built-in system workspace without changing
project membership.

## Migration and backwards compatibility

Migration must not move files or rewrite existing project-source paths.

1. Assign the built-in workspace a `system` storage profile.
2. Assign every existing custom workspace a `legacy` profile.
3. Preserve all workspace names, positions, policies, project memberships, and
   eligible default selection.
4. Preserve every existing project source, worktree, placement record, and
   filesystem location.
5. Prohibit creation of new legacy workspaces.

Legacy workspaces continue behaving as virtual groupings. Converting one to a
managed or attached workspace is a separate future feature and must require an
explicit migration flow; it must never happen as a side effect of this change.

## Lifecycle and security requirements

- Workspace storage kind, attached worker, and attached root are immutable.
- Project-to-workspace ownership remains immutable.
- An active worker/path pair cannot be registered as multiple project sources.
- An account cannot import the same GitHub repository as multiple projects.
- The worker must re-check canonical containment at discovery and import time.
- Routing handles are scoped to the worker and resolved only by that worker.
- GitHub tokens, Git credential material, and plaintext attached paths never
  enter server persistence or ordinary application API payloads.
- Removing a project must respect the existing ownership result: user-owned
  attached checkouts remain on disk.
- Removing an empty managed workspace may remove only empty, Cantrip-owned
  workspace directories. Failure to remove an empty directory must not delete
  user content or invalidate the server record.
- Unlinking a home worker makes attached storage unavailable; it does not
  silently rebind the workspace.

## Protocol outline

The shared protocol defines versioned schemas for:

- workspace storage profile summaries;
- managed and attached workspace creation requests;
- attached-root results;
- repository discovery jobs, progress events, and candidates;
- repository import selections and per-candidate outcomes; and
- explicit error codes for invalid roots, unsupported checkout types,
  duplicates, worker unavailability, scan truncation, and stale candidates.

The worker commands are:

```text
workspace.root.attach
workspace.repositories.discover
```

Repository import reuses the existing folder materialization and direct replica
provisioning paths rather than introducing a second Git attachment
implementation.

## Delivery history

Each stage was independently mergeable and retained compatibility with the
previous stage.

1. **Storage contracts and migration**
   Add storage profiles, protocol summaries, server invariants, default
   eligibility, and legacy backfill without changing placement behavior.
2. **Managed roots**
   Pass workspace storage context through project and replica jobs, derive
   worker-local managed roots, and preserve system/legacy paths.
3. **Attached roots**
   Add protected root registration, immutable worker binding, creation UI, and
   offline presentation.
4. **Repository discovery**
   Add depth-three bounded scanning, classification, durable jobs, live events,
   and manual rescan.
5. **Review and batch import**
   Add candidate review, direct GitHub attachment, local Git fallback,
   duplicate handling, idempotency, and partial outcomes.
6. **Affinity and lifecycle integration**
   Apply preferred home-worker routing across surfaces while retaining
   explicitly available cross-worker replicas, then finish deletion, unlink,
   reconnect, and recovery behavior.

## Acceptance criteria

- The system workspace preserves all existing project paths and behavior.
- Existing custom workspaces and projects survive migration without filesystem
  changes.
- A managed workspace can create separate roots on two workers under the same
  logical workspace ID.
- An attached workspace stores no plaintext root path on the server.
- Attached worker and root fields cannot be changed after creation.
- Attached workspaces cannot become the default destination; managed
  workspaces can.
- A local Tauri client can choose an attached root with the native folder
  picker; a remote worker accepts an absolute path.
- Discovery finds repository roots through depth three, does not escape through
  symlinks, and offers no non-Git directories.
- A GitHub-accessible checkout becomes a normal GitHub project without running
  a clone.
- A checkout without usable GitHub authorization becomes a local Git-capable
  project and remains eligible for later conversion.
- Duplicate paths and repositories are reported without moving existing
  projects.
- Batch import can partially succeed and safely retry failed candidates.
- The attached checkout remains untouched when its project or empty workspace
  binding is removed.
- Home-worker loss is presented as unavailability; eligible replicas on other
  workers remain usable.
- Discovery and reconnect behavior are event-driven and introduce no periodic
  client polling.

## Initial non-goals

- Moving a project between workspaces.
- Automatically moving legacy project directories into new workspace roots.
- Changing an attached workspace's worker or root path.
- Synchronizing managed workspace files outside the existing Git/replica model.
- Importing arbitrary non-Git directories from an attached workspace scan.
- Automatically importing submodules, bare repositories, or non-primary linked
  worktrees.
- GitHub Enterprise or non-GitHub hosting-provider integration.
- A remote graphical filesystem browser in the first implementation.
