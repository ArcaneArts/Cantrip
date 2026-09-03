# Project repository placement and attachment

Status: implemented. This document is the implementation contract and delivery
record for customizable GitHub repository placement on a Cantrip worker. It
covers Cantrip-managed clones, managed clones with an external filesystem link,
direct clones at an explicit worker path, and attachment of an existing
matching checkout. The concise user and operator guide is
[PROJECT_REPOSITORY_PLACEMENT.md](PROJECT_REPOSITORY_PLACEMENT.md).

The feature must preserve Cantrip's authority boundary: the app expresses
intent, the server authorizes and persists durable state, and only the selected
worker interprets paths or mutates the filesystem. Raw worker paths must not be
stored in server plaintext or treated as paths on the client device.

## Delivery record

The implementation landed through the six sequential Manual Change Protocol
cycles defined below; every cycle used a fresh worktree and an independently
squash-merged pull request:

1. [PR #816](https://github.com/ArcaneArts/Cantrip/pull/816) — domain,
   protocol, capability defaults, protected fields, and migration;
2. [PR #818](https://github.com/ArcaneArts/Cantrip/pull/818) — direct path,
   recursive parents, staging ownership, cloning, attachment, and canonical
   results;
3. [PR #822](https://github.com/ArcaneArts/Cantrip/pull/822) — POSIX/Windows
   link probing, replay/repair, retention, and placement-aware removal;
4. [PR #825](https://github.com/ArcaneArts/Cantrip/pull/825) — capability-gated
   server orchestration, durable facts, repair API, and user-deletion guard;
5. [PR #827](https://github.com/ArcaneArts/Cantrip/pull/827) — shared desktop,
   browser, and mobile import UX plus Project Settings; and
6. final acceptance, privacy/destructive-action audit, compatibility cleanup,
   and rollout documentation.

The implementation preserves the planned authority model. One adaptation is
that Windows managed-link availability is established by a real startup
junction probe rather than inferred from platform name. Windows volumes and
container mounts therefore remain deployment-specific smoke gates even after
the shared automated suites pass.

## Objective

Let a user choose the exact final worker path used when adding a GitHub
repository to Cantrip.

The user may choose one of three placement modes:

1. keep the existing Cantrip-managed clone behavior;
2. keep the canonical clone in Cantrip-managed storage and create a filesystem
   link at the requested path; or
3. use the requested path as the canonical checkout, cloning there when it is
   absent or attaching it when it is already a matching Git checkout.

Missing parent directories are created by the worker. Cantrip always uses the
canonical real path internally. A retained external link is a convenience for
the user and external tools, not a second execution root.

## Product decisions

- The path field is the exact final checkout or link path, not a parent to
  which Cantrip appends the repository name.
- Paths belong to the selected worker. They never refer to the browser,
  desktop shell, or mobile client filesystem merely because that client
  submitted the request.
- Missing parent directories are created before materialization. Existing
  parent permissions are not changed.
- A missing direct-placement target is cloned. An existing matching Git
  checkout is attached without recloning it.
- An existing checkout is user-owned. Cantrip does not claim that it created
  the checkout and does not delete its files in the first release.
- A direct checkout that Cantrip clones is Cantrip-owned external storage. It
  may be deleted only with explicit authority and durable ownership proof.
- A managed-link project keeps the managed clone as its canonical source. The
  link is never used as a Codex `cwd`, Explorer root, terminal root, Git root,
  CodeGraph path, or worktree identity.
- Removing a project while keeping local files leaves both the checkout and
  any Cantrip-created link in place. They become user-managed.
- Secondary Git worktrees remain under the worker-managed worktree root. This
  feature changes Primary source placement only.
- Default repository imports remain one-click and behaviorally unchanged.
- Custom placement is negotiated per worker and per replica. Equal logical
  project IDs do not imply equal paths on different workers.

## Terminology

- **Placement request** — the user's requested mode and optional exact worker
  path before filesystem inspection.
- **Canonical source path** — the real, absolute Primary checkout path used by
  all Cantrip runtime operations after symlink resolution.
- **Requested path** — the exact worker path entered by the user. For a direct
  placement it identifies the checkout; for a managed link it identifies the
  link.
- **Managed source** — a Cantrip-owned clone. Managed workspaces derive
  `workspaces/<workspace-UUID>/repositories/<owner>/<repository>` beneath the
  worker data directory; the system/legacy workspace path remains
  `repositories/<owner>/<repository>`.
- **Managed link** — a POSIX directory symlink or Windows directory junction
  from the requested path to a managed source.
- **Direct-created source** — an external checkout that Cantrip cloned into a
  requested path and can prove it owns.
- **Attached source** — an existing Git checkout accepted at a requested path.
  Its files remain user-owned.
- **Placement record** — durable worker-local ownership and link metadata used
  to fence retries, repair, and destructive removal.
- **Routing handle** — an opaque `ctrr_...` value representing private
  repository metadata on one worker. The server may persist and route the
  handle but cannot dereference its path.

## Scope

### Supported

- exact absolute POSIX, Windows drive, and supported UNC paths visible to the
  worker process;
- recursive creation of missing parent directories;
- direct cloning into a missing final directory;
- attaching an existing non-bare checkout with the expected GitHub origin;
- managed clones with a directory symlink or junction at an exact path;
- normal Primary execution through Agents, Tasks, Terminals, Explorers, Code,
  Git, History, CodeGraph, run configurations, workflows, and project shares;
- per-worker placement when adding another project replica;
- idempotent retry after server restart, worker restart, clone completion, link
  creation, or a lost completion response;
- explicit unlink-versus-delete behavior based on resolved ownership; and
- repair of a missing managed link without recloning its managed source.

### Not supported in the first release

- interpreting the requested path on the client machine;
- an unrestricted client-side filesystem picker for a remote worker;
- bare Git repositories;
- attaching a subdirectory within a checkout;
- choosing custom locations for secondary Git worktrees;
- moving an already registered Primary source to a new location;
- multiple managed links for one source;
- automatically deleting an attached user-owned checkout;
- automatically adopting a checkout owned by a different Cantrip project;
- accessing host paths that are not mounted into a containerized worker; or
- promising full functionality on a filesystem that cannot provide the
  required rename, link, locking, or canonicalization semantics.

## Baseline behavior

The current GitHub project creation flow is:

1. `RepositoryImporter` or the command bar submits a `GithubProjectCreate`.
2. The app protects repository identity through the selected worker.
3. `POST /api/projects/from-github` creates a logical project and a durable
   project-replica provision job.
4. `ProjectReplicaJobExecutor` dispatches `project.replica.provision`.
5. `GithubClient.provisionReplica` derives the target as
   `<dataDirectory>/repositories/<owner>/<repository>`.
6. A new clone is materialized in a sibling staging directory and atomically
   renamed into place. An existing managed clone is validated, fetched, and
   reused only when safe.
7. The worker returns path, display path, Git common-directory fingerprint,
   revision, branch, and worktree policy. Protected-result routing replaces
   private path values with worker-local handles before the server persists
   them.
8. Replica removal accepts filesystem deletion only beneath the worker-managed
   repository root.

The clone itself is not the difficult part of this feature. Placement affects
path privacy, job idempotency, collision behavior, deletion authority, worker
capability negotiation, multi-worker replicas, and every consumer that assumes
the Primary source is worker-managed.

## Placement model

### Request contract

Add one strict, discriminated request type shared by project creation and
later replica provisioning:

```ts
type ProjectReplicaPlacementRequest =
  | { mode: "managed" }
  | { mode: "managed-link"; path: string }
  | { mode: "direct"; path: string };
```

The public app-facing `path` is raw text supplied by the user. Before the
project mutation reaches the server, the app registers that value as protected
repository metadata on the selected worker. The encrypted/server-facing form
contains the same mode but replaces `path` with a routing handle.

Use a specific metadata field such as `placementPath`; do not overload generic
`path` and rely on incidental recursive protection. Add it to
`REPOSITORY_METADATA_FIELDS`, the routing-registry validation, private-label
fixtures, and encryption tests.

### Resolved placement

The worker must report facts separately from the request:

```ts
type ProjectReplicaPlacementResult = {
  mode: "managed" | "managed-link" | "direct";
  materialization: "cloned" | "reused" | "attached";
  ownership: "cantrip" | "user";
  canonicalPath: string;
  requestedPath: string | null;
  linkPath: string | null;
};
```

The transport may retain the existing top-level `path` and `displayPath`
fields for compatibility, but the placement facts must be explicit and
persisted. Recommended mapping:

| Mode                      | Canonical path                         | Display path     | Ownership | Materialization  |
| ------------------------- | -------------------------------------- | ---------------- | --------- | ---------------- |
| `managed`                 | managed clone                          | owner/repository | Cantrip   | cloned or reused |
| `managed-link`            | managed clone                          | requested link   | Cantrip   | cloned or reused |
| `direct`, missing target  | requested clone after canonicalization | requested path   | Cantrip   | cloned           |
| `direct`, matching target | existing canonical checkout            | requested path   | user      | attached         |

`project_sources.absolute_path` and Primary
`project_worktrees.absolute_path` continue to represent the canonical source
path through protected routing handles. Store requested/link path handles in
separate columns instead of pretending an alias is the execution root.

## Privacy and authority flow

The complete path flow must be:

```text
App
  -> protected repository.metadata.register on selected worker
  -> opaque placement-path handle
  -> authenticated server project/replica mutation
  -> durable job containing only mode + handle
  -> authenticated worker command
  -> worker resolves handle and validates filesystem state
  -> worker protects canonical/requested/link paths in result
  -> server persists only protected routing values
```

Requirements:

- Raw paths must not enter server logs, progress messages, audit details,
  database plaintext, URLs, live events, or error bodies.
- Worker progress may describe stages such as “Validating custom placement” or
  “Attaching existing checkout” without echoing the path.
- The worker command must include `projectId`, so ownership records and retries
  bind the physical path to the authorized logical project.
- The placement mode must participate in server job idempotency fingerprints.
- Changing either mode or protected path under one idempotency key is a
  conflict, not a replay.
- Only the worker dereferences the registered value. The server continues to
  resolve project, worker, replica, and authorization relationships before
  dispatch.

## Worker capabilities

Extend `projectReplicaCapabilitiesSchema` additively with defaults that keep an
older worker unsupported:

```ts
{
  provision: boolean;
  synchronize: boolean;
  remove: boolean;
  exactRevision: boolean;
  directPlacement: boolean;
  managedLinkPlacement: boolean;
  attachExisting: boolean;
  recursiveParentCreation: boolean;
}
```

The server rejects a requested mode before job creation when the selected
worker does not advertise it. The app disables unsupported choices and says
which worker lacks the capability. The default `managed` mode requires none of
the new flags.

Do not expose custom placement merely from the top-level deployment
`replicaProvisioning` flag. Capability is worker-specific, platform-sensitive,
and may differ between replicas of the same project.

## Durable server state

### Project replica jobs

Add migration-backed fields to `project_replica_jobs`:

- requested placement mode;
- protected placement-path handle, nullable for `managed`;
- resolved materialization, populated on success; and
- resolved ownership, populated on success.

Update:

- create/retry schemas;
- job summaries and wire schemas;
- `provisionFingerprint`;
- project-create idempotency keys;
- claim and recovery behavior;
- executor capability checks;
- worker command construction;
- completion attempt fencing; and
- migration/backfill tests.

Existing jobs backfill to `managed` with no placement path.

### Project sources

Add explicit placement metadata to `project_sources`:

- `placement_mode`: `managed`, `managed-link`, or `direct`;
- `ownership_kind`: `cantrip` or `user`;
- `requested_path`: protected routing handle or null; and
- `link_path`: protected routing handle or null.

Existing Git sources backfill to `managed` and `cantrip`. Existing managed
folder sources are unaffected because their source kind and removal lifecycle
remain separate.

The source and Primary worktree continue storing the canonical protected path.
Completion conflicts if the worker already has an active source for the same
project whose canonical path, repository fingerprint, placement mode, or
ownership does not match the result.

### Removal context

Replica removal commands must carry the persisted placement facts after the
server proves ownership and active-source identity. A client must not be able
to submit or override canonical path, placement mode, ownership, or link path
on removal.

## Worker placement manager

Extract target selection and ownership handling from the managed-root-specific
branches in `GithubClient` into a focused placement manager used by provision,
synchronize, removal, and link repair.

The safest insertion point is immediately after the worker resolves protected
command metadata and before `provisionReplica` selects or queues a filesystem
target. Keep GitHub authentication and clone-progress parsing in
`GithubClient`; keep path validation, parent creation, ownership records, and
link operations in the placement manager.

Suggested responsibilities:

```ts
interface ProjectReplicaPlacementManager {
  prepare(input: PlacementPrepareInput): Promise<PreparedPlacement>;
  recordCreated(input: PlacementCreatedInput): Promise<void>;
  verify(input: PlacementVerifyInput): Promise<VerifiedPlacement>;
  repairLink(input: PlacementRepairInput): Promise<LinkRepairResult>;
  release(input: PlacementReleaseInput): Promise<PlacementReleaseResult>;
}
```

All operations serialize by canonical target identity. Managed mode may keep
the existing owner/repository queue key. Custom modes use the canonical parent
plus final entry while absent, then the Git common-directory fingerprint after
materialization.

## Path normalization and parent creation

### Input rules

- Trim surrounding input whitespace but preserve internal spaces and Unicode.
- Require a platform-absolute path on the selected worker.
- Reject NULs, empty final components, filesystem roots, drive roots, and
  paths whose final entry is `.` or `..`.
- Apply worker-platform path parsing. The app and server must not attempt to
  decide whether a Windows, POSIX, or UNC path is valid.
- Enforce the existing 8,192-character transport bound plus platform-specific
  path constraints.

### Recursive creation

Because missing parents are intentionally supported, the worker must:

1. walk upward until it finds the nearest existing ancestor;
2. canonicalize that ancestor and verify it is a directory;
3. create missing components one at a time rather than relying on one broad,
   unchecked recursive mutation;
4. `lstat` each component after creation and reject a file or unexpected link;
5. re-canonicalize the final parent before cloning or linking; and
6. perform final-entry creation atomically.

Create new parent directories with owner-only permissions (`0700`) where the
platform supports them. Do not chmod existing directories. Do not recursively
delete newly created parents when a later step fails: another process may have
placed files there. Leave empty parents in place and return a bounded warning.

Parent symlinks may exist in a user-supplied path. Resolve the nearest existing
ancestor to its canonical directory and perform all safety comparisons against
that canonical location. The lexical requested path remains display metadata;
the canonical result is authoritative for execution.

### Collision rules

- Missing final entry: clone or create the managed link as requested.
- Existing directory in direct mode: inspect it as an attachment candidate.
- Existing exact managed link from the same project to the same source: treat
  it as an idempotent replay.
- Existing link in direct mode: resolve it only for attachment inspection and
  classify a successful attachment as user-owned.
- Existing file, socket, device, or unsupported entry: block without mutation.
- Existing directory with a different or invalid repository: block without
  fetch, checkout, cleanup, or adoption.
- Existing link pointing elsewhere in managed-link mode: block without
  replacing or unlinking it.

## Direct clone behavior

For a missing direct target:

1. validate and create parents;
2. choose a sibling staging directory named with the provision job ID;
3. remove only a staging entry proven to belong to the same active job;
4. clone into staging and fetch/resolve the expected revision using the current
   provisioning rules;
5. verify origin, Primary worktree, branch or unborn HEAD, Git common
   directory, and repository fingerprint;
6. write a Cantrip ownership marker inside the staging Git common directory;
7. atomically rename staging to the final target;
8. canonicalize the final source and reverify the marker and Git identity;
9. commit the worker-local placement record; and
10. return `materialization: "cloned"` and `ownership: "cantrip"`.

Use sibling staging so the rename does not cross filesystems. If the filesystem
cannot provide the required rename semantics, block the job rather than copy a
partially visible checkout into place.

### Ownership proof

Direct deletion and retry recovery require more than an origin URL. A user may
already own another clone of the same repository.

Write a bounded, versioned marker before the staging rename, for example under
the Git common directory:

```json
{
  "version": 1,
  "projectId": "...",
  "workerId": "...",
  "repositoryFingerprint": "...",
  "createdBy": "cantrip"
}
```

The marker is untracked Git metadata and must be owner-readable/writable only.
Also persist an atomic worker-local placement record keyed by project ID and
repository fingerprint. The marker closes the crash window after rename but
before registry persistence; the registry supports inventory, link repair, and
revocation without scanning arbitrary checkouts.

A retry may recover an existing direct target as Cantrip-owned only when the
marker, project ID, worker ID, origin, canonical Git common directory, and
fingerprint all agree. Origin agreement alone is never ownership proof.

## Existing checkout attachment

When a direct target already exists, attach instead of cloning only after all
of these checks succeed:

- the target resolves to a directory;
- `git rev-parse --show-toplevel` resolves to that exact canonical directory;
- the repository is not bare;
- `origin` identifies the selected GitHub repository after normalized HTTPS,
  SSH, optional `.git`, slash, and case handling;
- Git reports the selected checkout as its Primary worktree;
- the Git common directory is readable and produces a stable repository
  fingerprint;
- no Cantrip placement record binds the canonical checkout to another active
  project; and
- an expected immutable revision, when provisioning an additional replica,
  matches `HEAD` exactly.

Attachment is observational. Do not fetch, checkout, reset, clean, change
remotes, write the Cantrip-created ownership marker, or otherwise normalize the
user's checkout during attachment.

For an initial project import with no expected revision, a dirty attached
checkout may be accepted and its status is immediately observed. For an
additional cross-worker replica that requests an exact revision, require a
clean checkout at that revision so the replica contract remains deterministic.

Additional Git worktrees may already belong to the repository and will be
discovered by the normal reconciliation flow. The selected path itself must be
Git's Primary worktree; attaching a secondary checkout as the project source is
rejected in the first release.

Return `materialization: "attached"` and `ownership: "user"`. Persist a
worker-local association record, but never a marker claiming Cantrip created
the repository.

## Managed-link behavior

Managed-link provisioning keeps the existing managed target derivation and
clone/reuse logic. After the managed source is verified:

1. validate and create missing link parents;
2. reject any conflicting final entry;
3. create a directory symlink on POSIX;
4. create the safest supported directory junction/link on Windows;
5. read the link back and prove it resolves to the canonical managed source;
6. persist the protected link path and placement record; and
7. return the managed source as the canonical path and requested link as
   display metadata.

If the worker crashes after cloning but before link creation, retry reuses the
verified managed source and creates the missing link. If it crashes after link
creation, retry accepts only an exact link to the expected source.

The project remains operational if the user later removes the link. Project
settings show the link as missing and offer **Repair link**. Repair repeats all
collision and target checks and never overwrites an entry.

On Windows, advertise `managedLinkPlacement` only when the worker can create
and verify its chosen directory-link mechanism. Do not assume Developer Mode,
administrator privilege, NTFS, local drive semantics, or UNC support.

## Synchronization and normal runtime behavior

After successful provisioning, every normal Cantrip operation uses the
canonical source/worktree path already stored through protected routing:

- Codex `cwd` and workspace roots;
- terminal and supervised service working directories;
- Explorer containment and filesystem watching;
- Git operations and status observation;
- run configuration discovery and execution;
- Code and CodeGraph project identity;
- workflow repository and project-share roots; and
- Git common-directory and worktree reconciliation.

No downstream component should branch on the requested link spelling. Only
placement display, repair, and removal surfaces consume requested/link paths.

An external Primary reports `managed: false` in Git worktree inventory, which
is acceptable. Secondary agent-managed worktrees still resolve beneath
`<dataDirectory>/worktrees/<repositoryFingerprint>/...` and validate against
the source Git common directory.

## Removal semantics

Placement and ownership determine allowed filesystem behavior:

| Placement       | Ownership | Keep local files                                  | Delete local files                                              |
| --------------- | --------- | ------------------------------------------------- | --------------------------------------------------------------- |
| managed         | Cantrip   | leave checkout                                    | existing safe managed deletion                                  |
| managed-link    | Cantrip   | leave checkout and link                           | delete verified checkout and remove only an exact matching link |
| direct-created  | Cantrip   | leave checkout and remove Cantrip ownership claim | delete only after ownership and Git safety checks               |
| direct-attached | user      | detach from Cantrip; leave checkout               | unsupported in first release                                    |

The app must default to **Keep local files** for every external placement and
must disable filesystem deletion for an attached source.

Direct-created deletion requires:

- explicit user selection and the existing destructive confirmation;
- matching project/worker ownership marker and placement record;
- matching canonical path, Git common directory, repository fingerprint, and
  origin;
- no active chats, terminals, views, execution lanes, workflow leases, or
  replica jobs;
- a clean worktree, including ignored-file safety under the existing policy;
- no unpublished HEAD; and
- no additional Git worktrees.

Keeping a direct-created checkout removes or tombstones only Cantrip's
ownership metadata after the server has durably detached the source. It does
not delete the checkout or created parent directories.

For a managed link:

- keeping files leaves both clone and link untouched, as explicitly decided;
- deleting files removes the managed clone under the existing safety rules;
- remove the external link only if `lstat` identifies the expected link type
  and `readlink`/resolution proves it still targets that clone;
- a missing link is already removed and does not block checkout deletion; and
- a replaced or retargeted path is never touched. Return a warning without
  treating the unrelated entry as Cantrip-owned.

## User experience

### Import entry points

Create one shared repository-import options dialog used by:

- the main `RepositoryImporter`;
- the application command bar;
- the mobile project selector; and
- the create-GitHub-repository completion path.

Keep the current row/button **Add** action as the managed one-click default.
Offer **Add with location...** from an adjacent menu or explicit secondary
action.

### Dialog

The dialog contains:

- selected worker name and platform;
- single workspace destination;
- placement choices:
  - **Managed by Cantrip**;
  - **Managed clone with link**; and
  - **Use this worker path**;
- one exact path field for link/direct modes;
- copy stating that missing parent directories will be created;
- direct-mode copy stating that a missing path is cloned and a matching
  existing checkout is attached;
- a canonical-path explanation; and
- capability, platform, container-mount, and link-support warnings.

The label must say **Path on <worker name>**. Do not show a native client
filesystem picker unless the application can prove the selected worker is the
embedded worker on the same host. A worker-side path browser is a separate,
security-sensitive future feature.

### Progress and completion

Extend durable progress stages with bounded, path-free states:

- validating placement;
- creating parent directories;
- inspecting existing checkout;
- attaching checkout;
- cloning to custom placement;
- creating link;
- verifying canonical identity; and
- recording ownership.

After success, Project Settings shows:

- placement mode;
- selected worker;
- canonical source path after protected worker resolution;
- requested display/link path;
- cloned, reused, or attached materialization;
- Cantrip-owned or user-owned deletion behavior; and
- repair status for managed links.

### Removal copy

- Managed link + keep files: “The checkout and link will remain on the
  worker.”
- Direct-created + keep files: “The checkout will remain and become
  user-managed.”
- Attached: “This checkout existed before Cantrip and will not be deleted.”
- Link collision/retarget warning: “The original link path no longer points to
  this checkout and was left untouched.”

## Error model

Extend project-replica job errors with stable, actionable codes rather than
parsing Git or filesystem messages:

- `placement-unsupported`;
- `path-invalid`;
- `path-permission-denied`;
- `parent-creation-failed`;
- `target-type-mismatch`;
- `target-repository-mismatch`;
- `target-not-primary-worktree`;
- `target-owned-by-another-project`;
- `target-revision-mismatch`;
- `link-unsupported`;
- `link-target-mismatch`;
- `ownership-proof-missing`; and
- existing clone, Git, remote, dirty, divergence, and long-path errors where
  their meanings still apply.

Worker errors sent through protected repository operations must remain
redacted. User-facing details may state the failed condition but must not echo
the raw path through server-owned error storage.

## Idempotency and crash recovery

The provision state machine must handle these boundaries:

| Last durable physical step                 | Retry behavior                                             |
| ------------------------------------------ | ---------------------------------------------------------- |
| no filesystem mutation                     | validate and start normally                                |
| some parents created                       | reuse verified parents; never delete broadly               |
| staging clone exists                       | reuse only same-job staging or safely replace that staging |
| direct rename completed                    | recover only through matching ownership marker             |
| managed clone completed, link absent       | reuse clone and create link                                |
| exact link created                         | verify and continue                                        |
| worker result sent, server completion lost | repeat identical verified result                           |
| server completion committed                | idempotent job replay returns completed state              |

The server's existing job ID, attempt number, command ID, lease, and completion
fences remain authoritative. Placement records do not allow a stale attempt to
commit server state.

Cancellation is safe before parent/materialization work begins. Once clone,
rename, attach registration, or link creation starts, keep the existing
`cancellationUnsafeAt` behavior and finish or recover the bounded operation.

## Platform and deployment behavior

### POSIX

- Use directory symlinks for managed-link mode.
- Honor the process umask while requesting owner-only permissions for created
  parents, staging metadata, markers, and worker registries.
- Canonicalize common macOS aliases such as `/var` through normal `realpath`
  behavior without changing the requested display path.

### Windows

- Accept drive-absolute paths and supported UNC paths only after worker-side
  validation.
- Use a directory junction/link strategy that does not assume elevated
  privilege. Probe and advertise capability rather than promising it.
- Apply existing long-path detection and guidance before clone.
- Normalize comparisons for case-insensitive filesystem behavior without
  lowercasing the stored display path.
- Test drive roots, reserved names, junction replacement, cross-volume
  staging, and network-drive behavior.

### Containers and services

- The requested path must exist within the worker process mount namespace.
- Creating missing directories cannot create an unmounted host path.
- Surface a specific mount/permission explanation rather than suggesting a
  client path.
- The worker service account, not the interactive app user, determines access.
- External sources and links are outside the worker-data backup contract and
  need separate operator backup policy.

### Network and unusual filesystems

Block or degrade safely when the filesystem cannot provide required atomic
rename, link, permission, locking, or canonicalization behavior. Do not fall
back from direct placement to a silent recursive copy, and do not silently
fall back from managed-link to direct clone.

## Security requirements

- Never overwrite an existing filesystem entry to satisfy placement.
- Never use an unresolved environment variable, glob, client-relative path, or
  process CWD as a destructive target.
- Validate final entry type with `lstat` and canonical identity with
  `realpath`/Git after every materializing mutation.
- Bind worker placement records to owner, server, project, worker, repository
  fingerprint, canonical path, and placement mode.
- Make worker placement storage owner-only, regular, non-symlink files written
  through atomic replace.
- Do not follow a managed-link destination when deciding whether the link entry
  itself may be removed.
- Do not delete created parent directories as cleanup.
- Do not delete an attached checkout in the first release.
- Do not treat a matching origin URL as proof Cantrip owns a direct clone.
- Preserve the current clean-state, published-history, extra-worktree, active
  surface, lease, and job blockers before deleting any Cantrip-owned checkout.
- Audit mode, worker, project, outcome, and ownership classification without
  recording raw paths.

## Observability

Record structured worker-local events for:

- placement validation outcome;
- parent creation count;
- clone versus attach decision;
- link create/verify/repair outcome;
- ownership-marker recovery;
- canonical identity mismatch;
- removal policy decision; and
- filesystem capability failures.

Server-visible logs and live progress include project/job/worker identifiers,
placement mode, stage, duration, and stable reason code only. Path values stay
worker-private.

Metrics should distinguish:

- managed, managed-link, direct-created, and direct-attached provisions;
- clone, reuse, attach, and repair duration;
- collision and permission failures;
- retry recovery point;
- link capability by platform; and
- removal retained, deleted, or refused by ownership.

## Testing strategy

### Protocol and encryption

- strict placement unions accept only mode-appropriate fields;
- encrypted project creation accepts routing handles and rejects raw path
  shapes at the server boundary;
- `placementPath`, canonical path, requested path, and link path remain
  protected through round trips;
- worker capability defaults keep old workers unsupported; and
- worker commands require project ID, job fencing, and mode/path consistency.

### Server persistence and orchestration

- migrations backfill existing sources and jobs to managed/Cantrip-owned;
- project creation and additional replica creation persist placement handles;
- mode/path changes alter payload fingerprints and conflict under reused
  idempotency keys;
- executor rejects missing capabilities before dispatch;
- job recovery resends the same placement;
- stale attempts cannot commit placement facts;
- completion persists canonical and alias paths separately; and
- removal derives all placement facts from server-owned source records.

### Worker unit and integration tests

Cover at minimum:

- managed behavior remains unchanged;
- missing direct target clones through sibling staging;
- missing nested parents are created and retained after later failure;
- matching existing repository attaches without invoking clone/fetch/reset;
- mismatched origin, nested checkout, bare repository, secondary worktree, and
  wrong expected revision are rejected;
- dirty initial attachment is observed without mutation;
- exact-revision replica attachment requires clean matching HEAD;
- a direct-created marker recovers rename-before-result retries;
- a matching origin without ownership proof is not treated as Cantrip-owned;
- an exact existing managed link is idempotent;
- file/directory/wrong-link collisions are untouched;
- missing link repair succeeds without recloning;
- retargeted links are never removed;
- attached source deletion is refused;
- direct-created deletion requires matching ownership, clean status, published
  history, and no extra worktrees;
- keeping files retains managed links and releases Cantrip ownership; and
- symlink, junction, Unicode, spaces, case collisions, long paths, UNC paths,
  permissions, and unavailable mounts follow platform policy.

Use injected filesystem/path runtimes for deterministic Windows and failure
tests, plus real Git repositories for common-directory, worktree, origin,
dirty-state, and ownership-marker coverage.

### Application tests

- quick Add still requests managed mode;
- Add with location exposes only worker-supported modes;
- path labels name the selected worker;
- direct mode explains clone-or-attach and recursive parent creation;
- all import entry points share one placement component;
- progress distinguishes attach, clone, and link stages;
- project settings render placement, ownership, and repair state; and
- removal copy and controls match the ownership matrix.

### Security regression matrix

- traversal-like lexical inputs and roots;
- parent symlink replacement during creation;
- final-entry creation races;
- link swaps between verify and removal;
- routing handle replay against another project or worker;
- forged placement mode/path combinations;
- stale provision completion;
- ownership marker tampering;
- server restart and worker restart at each recovery boundary; and
- raw-path absence from server database snapshots, logs, job errors, and live
  payloads.

## Validation commands

Each implementation cycle runs its focused tests plus the repository minimum:

```bash
git diff --check
pnpm check:large-files
```

Contract and persistence cycles:

```bash
pnpm --filter @cantrip/protocol test
pnpm --filter @cantrip/protocol typecheck
pnpm --filter @cantrip/server test
pnpm --filter @cantrip/server typecheck
```

Worker placement cycles:

```bash
pnpm --filter @cantrip/worker test
pnpm --filter @cantrip/worker typecheck
```

Application cycles:

```bash
pnpm --filter @cantrip/app test
pnpm --filter @cantrip/app typecheck
pnpm --filter @cantrip/app build
```

Final acceptance runs `pnpm check` and the focused worktree validation matrix in
[WORKTREES.md](WORKTREES.md#development-validation). Platform-specific link
behavior requires Windows coverage rather than inference from POSIX tests.

## Delivery plan

Follow the Manual Change Protocol with sequential, independently mergeable
worktrees and squash-auto-merged pull requests. Do not use an omnibus branch.

### Cycle 1 — Domain, protocol, capabilities, and migration

- add placement request/result/ownership schemas;
- add protected placement metadata fields;
- add capability negotiation with false defaults;
- migrate replica jobs and project sources;
- backfill existing Git sources to managed/Cantrip-owned; and
- add protocol, migration, private-metadata, and compatibility tests.

The feature remains unavailable in the app after this cycle.

### Cycle 2 — Worker path and ownership foundation

- add the placement manager and owner-only atomic registry;
- implement absolute-path validation and recursive parent creation;
- implement direct sibling staging, ownership marker, final verification, and
  retry recovery;
- implement existing checkout inspection and user-owned attachment;
- keep all current managed provisioning behavior unchanged; and
- add Git/filesystem/security integration coverage.

The worker may advertise direct/attach capability only after all destructive
paths are fenced, even though the app still does not request it.

### Cycle 3 — Managed links and placement-aware removal

- implement POSIX link and Windows junction capability probing;
- create, verify, replay, and repair managed links;
- refactor replica removal around placement and ownership;
- retain links and checkouts when keeping files;
- refuse attached-source deletion;
- clean only exact matching links during managed deletion; and
- add crash, collision, repair, and removal tests.

### Cycle 4 — Server job orchestration

- accept protected placement on project and replica creation;
- persist it in durable jobs and fingerprints;
- gate by worker capability;
- dispatch project-bound placement commands;
- commit resolved placement facts with attempt fencing;
- include placement in removal context and replica summaries; and
- add API, executor, retry, multi-worker, and database tests.

### Cycle 5 — Shared desktop/mobile/browser UX

- build the shared import options dialog;
- retain quick managed Add behavior;
- update main importer, command bar, mobile selector, and new-repository flow;
- add placement, ownership, repair, and removal state to Project Settings;
- keep raw paths inside protected worker metadata operations; and
- add rendering, mutation, capability, and encryption tests.

### Cycle 6 — Acceptance, documentation, and rollout

- run cross-platform and container-mounted-path acceptance;
- audit raw-path privacy and destructive actions;
- exercise restart/retry boundaries;
- update [README.md](../README.md), [PLAN.md](PLAN.md),
  [MULTI_WORKER_ARCHITECTURE.md](MULTI_WORKER_ARCHITECTURE.md),
  [WORKTREES.md](WORKTREES.md), [FOLDERS.md](FOLDERS.md), hosted deployment,
  and security documentation;
- document external backup responsibility and link limitations; and
- enable the UI only for workers advertising the completed capabilities.

## Acceptance criteria

- A default GitHub import behaves exactly as it does before this feature.
- A user can enter one exact final path on the selected worker.
- The worker creates missing parent directories without deleting them on later
  failure.
- Managed-link mode creates a verified external link while all Cantrip runtime
  operations use the canonical managed clone.
- Direct mode clones when the target is absent and attaches without mutation
  when a matching checkout exists.
- Attached checkouts are visibly user-owned and cannot be deleted by Cantrip.
- Direct-created checkouts can be safely recovered after a lost completion and
  deleted only with matching ownership proof and existing Git safety checks.
- Keeping local files retains the checkout and any managed link.
- Existing entries are never overwritten, retargeted, adopted across projects,
  or broadly cleaned up.
- Raw paths remain worker-private and only protected handles cross durable
  server boundaries.
- Old workers and unsupported platforms retain managed imports and reject only
  unsupported placement modes.
- Additional replicas choose placement independently on their selected worker.
- Containers clearly reject paths outside their mount namespace.
- Full protocol, server, worker, app, security, recovery, and platform matrices
  pass before the capability is exposed by default.

## Primary implementation touchpoints

- `cantrip_app/src/App.tsx` — main repository importer and durable progress.
- `cantrip_app/src/components/app/app-command-bar.tsx` — duplicate import entry
  point to replace with the shared dialog.
- `cantrip_app/src/components/projects/project-replica-settings.tsx` —
  per-worker placement, ownership, repair, and removal UX.
- `cantrip_app/src/lib/project-encryption.ts` — raw-path registration and
  encrypted GitHub project creation.
- `cantrip_app/src/lib/api.ts` — protected metadata operations and project/
  replica mutations.
- `packages/protocol/src/index.ts` — public/encrypted schemas, worker commands,
  results, summaries, errors, and capabilities.
- `packages/protocol/src/repository-operation.ts` — protected placement metadata
  allowlist.
- `cantrip_server/src/app.ts` — project and replica API authorization.
- `cantrip_server/src/db/schema.ts` and migrations — durable job/source
  placement fields.
- `cantrip_server/src/db/project-replica-jobs.ts` — idempotency, claim,
  completion, removal context, and attempt fencing.
- `cantrip_server/src/project-replicas/executor.ts` — capability checks and
  placement-aware dispatch.
- `cantrip_worker/src/routing-registry.ts` — worker-private path handles.
- `cantrip_worker/src/github.ts` — provisioning, Git identity, synchronization,
  and removal integration.
- `cantrip_worker/src/worktrees.ts` — canonical Primary and common-directory
  reconciliation.
- `cantrip_worker/src/heartbeat.ts` — placement capability advertisement.
- `cantrip_worker/test/github.test.ts`,
  `cantrip_server/test/project-replica-jobs.test.ts`,
  `cantrip_server/test/project-replica-executor.test.ts`,
  `cantrip_app/src/lib/project-encryption.test.ts`, and protocol tests — core
  regression suites to extend.

## Final invariants

1. The worker is the only path authority.
2. Canonical paths, not aliases, define execution and Git identity.
3. A requested path never implies ownership.
4. Origin equality never implies deletion authority.
5. Existing matching checkouts attach without mutation and remain user-owned.
6. Cantrip-created external checkouts carry recoverable ownership proof.
7. Links are conveniences and are removed only when their exact identity is
   proven.
8. Keeping local files keeps links as well as checkouts.
9. Missing parents may be created but are never broadly deleted as rollback.
10. Default managed placement remains the compatibility and safety baseline.
