# Native Linux runtime adapter

This checkpoint connects the pinned native app-server to a captured CantripOS
source through its existing environment provider. The app-server and provider
credentials stay on the owning worker; native shell, filesystem, search, and patch
tools use the guest executor. Both Server implementations now capture placement
when creating a new agent chat, and the worker selects this adapter for that
captured chat. The [client attachment/selection workflow](PRODUCT_WORKFLOW.md)
connects these placements to terminals, editor/Explorer, setup/Run, attachments
and returned file links. Final [acceptance](ACCEPTANCE.md#phase-3-acceptance-and-distribution-2026-11-04)
records real-model evidence separately from native fixtures.

`OsNativeEnvironment` captures the source/instance/workspace identities and
attachment, runtime, and binding generations. Each placement needs its own private
native runtime home. Its `environments.toml` disables the local environment and
starts the authenticated Docker/strict-SSH carrier with the expected guest
capability. Existing homes cannot be repurposed for another placement. A stale
runtime is rejected by actual executor observation, and guest cwd values use Linux
path semantics.

`CodexAppServer` passes this environment explicitly when starting/resuming threads
and starting turns. Permission profiles remain native permission profiles. OS
turns do not use the worker's automatic whole-turn retry loop, and do not obtain
host computer-use authority. Native host-browser/computer-use features are also
disabled in these processes. Linux-owned Git snapshots use the guest; linked Git
inspection remains on its original worker. A failed final observation is reported
as unknown and does not select a host directory.

Native turn interruption can retain resumable exec sessions. For an OS turn,
Cantrip explicitly terminates the native process IDs whose command items were
observed in that turn. This preserves independent executor sessions and commands
from other turns. The packaged executor's process-tree cleanup handles sudo and
children that start another process group. Transport failure during cancellation
is an error; it is not a confirmed stop.

## Server-owned chat placement

After [provisioning and verifying a source binding](DISPATCH.md), the existing
`POST /api/projects/:projectId/chats` encrypted creation request accepts
`cantripOsBindingId`. It selects that exact binding's worktree; do not also supply
`worktreeId` or `target`. The ordinary protected chat title and other creation
fields still apply. `worktreeMode: "pinned"` is appropriate for this checkpoint.
This option currently belongs to new agent chats, rather than Task creation.

The Server saves binding, attachment, and runtime generations in the same
transaction as the chat, native runtime session, and initial execution lane.
It derives guest UID/home/path and transport from canonical source records.
The worker supplies its connection's verified logical Server identity. No client
chooses a guest UID or inserts a Linux path into `project_sources.absolute_path`.

Chat context and lane admission resolve this captured placement, preserving the
existing worktree and logical branch leases. Managed session preparation and
turn dispatch carry the explicit OS execution descriptor. OS turns also require
the `cantrip-os` wire execution profile, which older workers reject. Strict
managed-session descriptors likewise reject unsupported OS preparation rather
than allowing an old worker to discard a new placement field. The worker's private
`os-agent-placements` journal retains the capture after worker restart. Commands
that omit a repeated descriptor still resolve the same saved placement; a
conflicting descriptor is rejected. Runtime homes are separate from ordinary
host homes, and remain stable across provider API-key rotation.

An existing chat is not retargeted through this creation path. A changed OS
runtime invalidates its captured placement. Refresh and verify the retained source
before creating another OS-bound chat; automatic re-admission of existing chats
across OS replacement is not provided by this checkpoint. Both Server and worker
whole-turn failover paths refuse to replay an OS turn after an uncertain result.

Plain Linux terminals, editor/Explorer, setup/Run routing, attachment
materialization and returned file links now use this captured placement. See the
[product workflow](PRODUCT_WORKFLOW.md) and final acceptance for the complete flow.

## Reproduce the component tests

Use a disposable attached instance with `cantrip-os-executor` installed. The test
owner/worker UUIDs are the fixture identities in the test source, so these tests
must not target an instance attached to somebody else. Each run creates a unique
workspace and closes its executor afterward, retaining its files for inspection.

```sh
CANTRIP_OS_TEST_CONTAINER=cantrip-os-sources-test \
CANTRIP_CODEX_TEST_BINARY=/absolute/path/to/pinned/codex \
  pnpm --dir cantrip_worker exec vitest run \
  test/os-native-environment.integration.test.ts \
  test/os-native-turn.integration.test.ts --maxWorkers=1
```

Set `CANTRIP_OS_TEST_TRANSPORT` to a private strict-SSH transport JSON file instead
of the Docker variable for an installed VM. The turn fixture also accepts:

- `CANTRIP_OS_TEST_PERMISSION_PROFILE=:workspace` for native workspace permissions.
- `CANTRIP_OS_TEST_PERMISSION_PROFILE=:read-only` to prove reading succeeds and
  patch/write attempts leave the seeded files unchanged.
- `CANTRIP_OS_TEST_CANCEL=1` to interrupt a sudo Python parent, detached Python
  child, and sleep descendant, verify all three disappear before closing the
  executor, and verify an independent native process remains running.

The model endpoint is deterministic Responses test scaffolding. The actual pinned
runtime performs the model loop, tool selection, shell/read/search, native patch,
file creation, attachment materialization, Worker-owned HTTP MCP and Python
artifact execution. These fixtures do not claim a live provider conversation or
product-selected chat; those have separate recorded acceptance. Proofs are written to each test's private temporary directory;
retained copies belong under ignored `artifacts/phase3-native-runtime/`.

## Recovering Linux Run generations

The Worker's private Run journal now retains the original encrypted secret
references alongside the exact launch fingerprint. Reconciliation after Worker
restart can reopen that recorded native session and observe its process without
repeating preparation, process start or stdin. The native executor remains an
execution service, not a second Worker. A missing journal or mismatched admission
cannot enter the new-launch path; a journal disappearing during recovery also
fails without launch. Earlier records without secret snapshots are recoverable
only when their original no-secret fingerprint can be verified.

A new Worker reconstructs its output buffer from retained native output and
reapplies the original secret redaction. Confirmed completed processes are not
reported as running during replay. If the native output/session is gone, a prior
conclusive completion is retained and incomplete output recovery is reported.
Stopping a Run remains an explicit lifecycle operation; reconnect itself no
longer kills the admitted process. This checkpoint does not yet expose an
authoritative native output-retention boundary, which requires a separate native
protocol change. Sequence gaps alone are insufficient evidence of lost output
because native lifecycle events share that sequence space.
