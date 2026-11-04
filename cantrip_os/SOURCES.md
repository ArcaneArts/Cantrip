# Linux source backend

Phase 3 is in progress. These are worker-side materialization APIs and repeatable
acceptance fixtures. Canonical server identities were delivered in the preceding
milestone. Client target selection, authorized command dispatch, full product Git
routing, and native agent placement remain dependent work. Calling a helper by
itself does not grant project authority or retarget a chat.

## Linked Docker worktrees

`cantrip_worker/src/os-executor/linked.ts` accepts the owning worker's resolved,
explicitly selected worktree path and a canonical binding ID. Protected worker
path handles must be resolved by the existing routing registry first. The helper
never substitutes a browser-supplied path or mounts the host home, repository
parent, or Docker socket.

The root is mounted at `/workspace/<binding-id>`. Host and guest see the same
files, including ignored files. Host ownership, symlinks, executable bits, and
the existing `.git` file are retained. Linked Git mutations remain owned by the
original worker. Guest-native Git cannot access external worktree metadata that
is outside the explicitly mounted directory.

Native Linux Docker retains the host's numeric UID permissions. Source files
must permit the selected workspace account's access, or an explicitly elevated
command must perform the edit. The helper changes no existing host permissions.
Its disposable shared-mode nonce verifies the mount's actual bytes without using
a private host-only probe as a substitute for source-file access.

Dependency overlays are explicit relative directories, such as `node_modules`
or `.venv`. Each uses a Linux named volume with copy-up disabled. Only that
volume's root receives the workspace UID; the host checkout is never recursively
chowned. `cacheKey` represents the canonical source/worktree/workspace identity
so a binding revision can retain dependencies. Different workspaces must use
distinct cache identities. The overlay list identifies directories whose bytes
differ between host and guest.

Mount changes recreate the whole instance, interrupting desktops and executors.
The receipt records known running executors. Replacement retains named and
image-created data volumes, existing source mounts, ports, networks, and resource
configuration. Mount-only recreation snapshots the root filesystem first,
retaining software/configuration installed with sudo. Real host-to-guest and
guest-to-host bytes are verified before removing the stopped old container.

`pnpm os` and `os.mjs rebuild` preserve source mounts and Linux dependencies.
An intentional image rebuild applies the new image's system defaults: promote
root filesystem customizations into the repository to retain them through image
rebuilds. Persistent homes, sources, and dependencies remain. Linked instances
retain existing published ports and memory settings during image rebuilds;
the launcher prints the actual connection information.

## Linux-owned sources

`cantrip_worker/src/os-executor/checkouts.ts` provisions an exact admitted commit
under persistent `~/checkouts/<source-id>`. It stages the clone in a durable
operation directory, verifies the commit, and publishes with atomic no-replacement
rename. A Git bundle can supply a fixture or authenticated worker-owned export.
Other repository URLs use the guest's network and Git configuration. No automatic
source mirroring runs and no worker/model credentials are installed in Linux.

Managed worktrees live under `~/worktrees/<worktree-id>` and share the Linux Git
repository. Server must admit their branches/leases before calling the helper.
Clone, checkout, worktree creation, and Git mutations run as the workspace account
through the native executor. Passwordless sudo is available. Commands do not
start a desktop or receive `DISPLAY`.

`inspectLinuxSource` observes an explicitly selected existing repository or folder
without cloning or moving it. Folders retain null Git metadata, keeping attached
repositories/folders distinct from managed provisioning. Guest paths and file
URIs remain explicit Linux locations; host path conversion is never used.

## Outcomes and lifecycle

Finite commands record their native process IDs through the caller's durable
`prepared` callback before dispatch. Mutating source helpers require this
callback; read-only inspection can omit it. Output is bounded and drained through
the final native page, including buffered output after exit. Timeout, cancellation,
or overflow requests native termination. A lost receipt retains the process ID
and reports unknown delivery. There is no automatic host fallback or replay.

Cloning reserves a persistent operation directory before Git starts. Redispatch
of the same operation fails before another command. Its `intent.json`, staging
checkout, and eventual `result.json` remain available for reconciliation.
Worktree creation refuses to replace an existing path.

Docker replacement reserves a host-only journal before snapshot/create/stop/
rename/start. Requested/completed stages and candidate/previous container IDs
survive uncertain delivery. Inspect the journal and actual Docker state instead
of blindly replaying an unknown replacement. The stopped previous container is
retained until verification. Cleanup warnings remain in the binding receipt.

Executor 0.2.0 gives its native executable `CAP_KILL` and enables reviewed Linux
process-tree cleanup. Cancellation can signal sudo descendants and children in
another session/process group. Ordinary commands retain the workspace UID and
do not inherit the capability; independent native jobs remain independent. This
is lifecycle control inside one trusted owner's OS, not a tenant boundary.

## Run backend acceptance

Use disposable executor-enabled instances attached to the fixture owner/worker
from `os-sources.integration.test.ts`. Tests create unique workspace accounts and
retain data for persistence inspection. Linked acceptance recreates the whole
named instance and retains its host fixture because the live mount needs it.

```sh
node --test cantrip_os/tests/*.test.mjs
CANTRIP_OS_TEST_CONTAINER=cantrip-os-sources-test \
  pnpm --dir cantrip_worker exec vitest run \
  test/os-sources.integration.test.ts test/os-process-cancellation.integration.test.ts --maxWorkers=1
CANTRIP_OS_TEST_LINKED_CONTAINER=cantrip-os-sources-test \
  pnpm --dir cantrip_worker exec vitest run test/os-linked-source.integration.test.ts
```

For the installed VM, use the protected SSH transport JSON from the
[executor guide](packages/executor/README.md), then run source/cancellation tests
with `CANTRIP_OS_TEST_TRANSPORT=/path/to/transport.json`. Linked Docker acceptance
requires local Docker. The host Engine API is never exposed inside the guest.
