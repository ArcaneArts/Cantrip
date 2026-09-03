# Project repository placement

Status: implemented. This guide describes the shipped operator and user
contract. The detailed design and delivery history are in
[PROJECT_REPO_UPDATE.md](PROJECT_REPO_UPDATE.md).

Cantrip can materialize the Primary checkout for a GitHub-backed project in
worker-managed storage, expose that managed checkout through one external
filesystem link, or use an exact path visible to the selected worker. The app
submits placement intent; only the worker parses paths or changes files.

## Placement modes

| Mode                                              | Requested path                  | Canonical execution root                                 | Ownership |
| ------------------------------------------------- | ------------------------------- | -------------------------------------------------------- | --------- |
| **Managed by Cantrip**                            | None                            | The selected workspace's derived managed repository root | Cantrip   |
| **Managed clone with link**                       | Exact final link path           | The managed checkout, never the link spelling            | Cantrip   |
| **Use this worker path** with a missing target    | Exact final checkout path       | The created checkout after canonicalization              | Cantrip   |
| **Use this worker path** with a matching checkout | Exact existing Primary checkout | The existing checkout after canonicalization             | User      |

For a managed workspace, the derived target is
`<worker-data>/workspaces/<workspace-UUID>/repositories/<owner>/<repository>`.
The built-in system workspace and legacy workspaces retain
`<worker-data>/repositories/<owner>/<repository>`. An attached workspace's home
root is never an implicit clone destination; additional managed replicas retain
the established worker-level root unless the user chooses an exact direct
path.

The existing **Add** action remains the one-click managed import. Choose **Add
with location...** to select another mode. The path label names the selected
worker because a path never refers to the browser, phone, or desktop client
unless that device is also the selected worker.

Direct placement creates missing parent directories and clones when the final
entry is absent. If the entry exists, Cantrip attaches it only when it is the
matching non-bare Primary Git checkout. Attachment does not fetch, reset,
clean, change remotes, or write an ownership marker. A mismatched repository,
secondary worktree, file, or conflicting link is left untouched.

Managed-link placement creates one POSIX directory symlink or Windows directory
junction at the exact requested path. All Agents, Tasks, terminals, Explorer,
Code, Git, CodeGraph, project shares, and Run configurations continue using the
managed checkout's canonical path. Removing the link does not make the project
unavailable; Project Settings can repair a missing link when the original path
is free.

Workers advertise `workspaceScopedRoots` before the server assigns a managed
workspace repository or folder to them. Older workers remain usable for the
system/legacy workspace but cannot receive workspace-scoped materialization.

## Privacy and authority

Raw paths are registered with the selected worker before the project or
replica mutation reaches the server. The worker returns an opaque `ctrr_...`
routing handle. Durable jobs and source records contain only those handles,
placement classifications, IDs, and bounded lifecycle state.

```text
app -> worker-protected path handle -> authenticated server mutation
    -> authenticated worker command -> worker filesystem and Git checks
    -> protected canonical/requested/link handles -> durable server state
```

The server authorizes the account, project, worker, replica, and active job
attempt but cannot dereference the handle. Server-visible progress and errors
describe the stage and stable reason code without echoing a raw path. The app
resolves path handles through the owning worker only when it needs to present
Project Settings.

The worker keeps an owner-only placement registry outside repositories. A
direct checkout created by Cantrip also carries an untracked marker in its Git
common directory. Both records, the project and worker IDs, repository
fingerprint, origin, and canonical Git identity must agree before Cantrip treats
an external checkout as Cantrip-owned. A matching origin alone never proves
ownership.

## Removal and retention

External placement defaults to **Keep local files**.

| Placement                  | Keep local files                                         | Delete local files                                                  |
| -------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| Managed                    | Leave the checkout                                       | Existing guarded managed deletion                                   |
| Managed link               | Leave both checkout and link                             | Delete the verified checkout and only an exact matching link        |
| Direct, created by Cantrip | Leave the checkout and release Cantrip's ownership claim | Require matching ownership proof and all existing Git safety checks |
| Direct, attached           | Detach and leave the checkout                            | Not available                                                       |

Deletion still blocks on dirty or ignored files, unpublished `HEAD`, additional
worktrees, active surfaces or leases, and conflicting jobs. A missing managed
link does not block checkout deletion. A replaced or retargeted link is never
removed and produces a warning. Parent directories created for placement are
never recursively cleaned up.

Keeping a Cantrip-created external checkout makes it user-managed. Cantrip
will not silently reclaim or later delete it. Removing an attached checkout
from Cantrip never changes its files.

## Capability and rolling-version behavior

Workers advertise custom placement independently:

- `directPlacement`
- `managedLinkPlacement`
- `attachExisting`
- `recursiveParentCreation`

All new fields default to `false` when an older heartbeat omits them. The app
enables direct placement only when direct, attachment, and recursive-parent
support are all advertised. It enables managed-link only when the worker's
startup probe verifies link creation and recursive-parent support. Managed
import remains available during a rolling upgrade. The server repeats these
checks before creating a job, and the executor checks them again before
dispatch, so a stale client cannot expand worker authority.

Placement is selected per replica. Two workers serving one logical project may
use different modes and absolute paths. Secondary Git worktrees remain beneath
Cantrip's managed worktree root regardless of Primary placement.

## Platform and service notes

### POSIX

Managed links are directory symlinks. Parent directories and worker placement
records request owner-only permissions. Canonicalization may change a spelling
such as macOS `/var` to `/private/var`; Cantrip retains the requested spelling
for display while using the real path internally.

### Windows

The worker validates drive-absolute and supported UNC paths using Windows path
rules. Managed-link support is advertised only after a real directory-junction
create/read/remove probe succeeds for that worker data volume. Developer Mode,
administrator privilege, local NTFS semantics, long-path support, and network
drive behavior are not assumed. A worker that fails the probe continues to
support managed and, when otherwise capable, direct placement.

### Containers and services

A custom path is inside the worker process's filesystem namespace. An
unmounted host path cannot be reached by entering its host spelling in the app;
mount the intended parent into the worker container first. The worker service
account must be able to traverse the existing ancestor and create or inspect
the requested entry. Cantrip creates missing directories inside the namespace,
but cannot create a missing bind mount or change existing parent permissions.

For the hosted images, bind-mounted directories must be writable by UID/GID
`10001` unless the image is deliberately run with another identity. Prefer a
dedicated mount for external checkouts rather than exposing a broad home or
host root.

Filesystems that cannot provide reliable canonicalization, Git locking,
same-filesystem staging rename, or link semantics fail closed. Cantrip never
falls back to a recursive copy or silently changes placement mode.

## Backup and recovery

PostgreSQL contains project lifecycle state and opaque routing handles; it does
not contain repository files. The worker data backup covers managed clones,
the placement registry, ownership records, and managed secondary worktrees.
It does **not** automatically cover a direct checkout or the external side of a
managed link.

Operators are responsible for separately backing up external paths, including
dirty files and unpushed commits. Restore the worker data and external storage
as one recovery point when Cantrip ownership or link repair must survive a
worker loss. Restoring only PostgreSQL cannot recreate any checkout. Restoring
only an external direct clone preserves its files but may intentionally leave
Cantrip unable to prove deletion authority; reattach it as user-owned instead
of manufacturing ownership records.

Provisioning and removal jobs are durable and attempt-fenced. Retries reuse only
same-job staging, recover a completed direct rename only through matching
ownership proof, verify an existing managed link before accepting it, and
repeat a completed result without allowing a stale attempt to commit.

## Release acceptance

The focused automated acceptance covers:

- protected path registration and handle-only project mutations;
- capability defaults and complete-mode gating;
- direct sibling staging, safe recursive parents, clone recovery, and
  attachment without mutation;
- managed-link create, replay, repair, retention, retarget protection, and
  removal;
- server restart recovery and stale completion fencing;
- placement-aware source persistence, synchronization, and removal; and
- shared import and Project Settings behavior.

Release validation should run:

```shell
pnpm --filter @cantrip/protocol test
pnpm --filter @cantrip/worker test -- github.test.ts
pnpm --filter @cantrip/server test -- project-replica-jobs.test.ts project-replica-executor.test.ts
pnpm --filter @cantrip/app test -- repository-import-options-dialog.test.ts project-replica-settings.test.tsx project-encryption.test.ts
pnpm --filter @cantrip/worker typecheck
pnpm --filter @cantrip/server typecheck
pnpm --filter @cantrip/app typecheck
pnpm --filter @cantrip/app build
pnpm check:large-files
git diff --check
```

Also smoke-test each supported deployment boundary rather than inferring it
from another host:

1. On POSIX, direct-clone to a path outside worker data, attach an existing
   dirty matching Primary without mutation, and create/repair/retain a link.
2. On Windows, confirm the worker advertises managed-link only after the
   junction probe, then repeat create/repair/retarget/removal checks on the
   intended local or network volume.
3. In a container, mount one external parent and confirm direct/link placement
   succeeds there; confirm an unmounted or read-only path fails without creating
   server-visible raw-path diagnostics.
4. Restart the worker after clone rename and after link creation, restart the
   server with an active job, and confirm identical retry completion while a
   stale attempt is rejected.

Windows junctions and container mounts remain deployment-specific acceptance
gates because their behavior depends on the actual service identity, volume,
filesystem, and host policy.
