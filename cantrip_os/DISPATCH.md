# Server-owned executor dispatch

This is the Phase 3 source-admission checkpoint. Both Server implementations
provide the same administrative HTTP routes and worker commands. The [client workflows](PRODUCT_WORKFLOW.md) now connect attachment, terminals,
editor/Explorer and Run to these routes. The [native runtime and chat placement](NATIVE_RUNTIME.md)
build on the same authority. Final [acceptance](ACCEPTANCE.md#phase-3-acceptance-and-distribution-2026-11-04)
records product and distribution results.

The existing worker owns the Docker/SSH carrier, encryption keys, source mounting,
and native executor sessions. The Server owns the OS attachment, workspace/source
identities, captured generations, and immutable provisioning admission. The guest
contains neither the worker orchestrator nor provider credentials.

## Administrative sequence

All requests use the normal authenticated Cantrip Server connection. IDs and
transport references are scoped to its authenticated owner.

1. `POST /api/cantrip-os/inspect` with `workerId` and `transport` observes the actual
   optional package through that worker. A Docker transport is
   `{"kind":"docker","container":"cantrip-os"}`. An SSH transport uses the strict
   pinned worker-side identity/known-host file references described in the
   [executor guide](packages/executor/README.md).
2. `POST /api/cantrip-os/attach` with `workerId`, observed `guestInstanceId`, `name`,
   `transport`, and `expectedAttachmentGeneration: null` admits a new attachment.
   Reattachment requires its current generation. A guest attached to a different
   owner/worker must be explicitly detached on that guest; this operation never
   takes it over automatically.
3. `POST /api/cantrip-os/:instanceId/refresh` observes the current executor
   generation and persistent profiles. `GET /api/cantrip-os` lists attachments;
   `GET /api/cantrip-os/:instanceId/workspaces` lists recorded profiles. Create one
   with `POST` to the latter using `guestWorkspaceId` and a fresh UUID
   `operationId`. The guest supplies UID/GID/home; the client cannot choose them.
   Both Servers persist the original create command before dispatch. Repeating
   the same request observes its original Worker journal; it never sends create
   again or changes its captured attachment, runtime or transport.
4. Admit a binding with `POST /api/projects/:projectId/cantrip-os/bindings`:
   - Linked: `mode: "linked"`, `workspaceId`, the exact existing `worktreeId`, and
     explicit `dependencyOverlays`, such as `[{"path":"node_modules"}]`.
   - Linux-owned: `mode: "linux-owned"`, `workspaceId`, and `sourceKind` (`git` or
     `folder`, preserving the project's Git capability). The response includes
     new independent source and Primary worktree IDs. It is not yet ready.
   - Existing/restored: `mode: "linux-existing"`, `operationId`, `workspaceId`,
     `sourceKind` and `relativePath` beneath that Linux account's home. Server
     reserves fresh identities and returns a `linux-owned` binding. Repeating
     this creation ID with the same canonical selection returns that reservation;
     changed intent is rejected. This step does not inspect or modify guest files.
5. Seal `cantripOsProvisionRequestContentSchema` with the existing
   `repository-content` component and repository-operation encryption. Its AAD
   binds Server/project/worktree/operation IDs and request direction. Its plaintext
   binds instance/workspace/binding/binding-generation IDs and the intent:
   - Linked: selected worker path/routing reference and the admitted overlays.
   - Linux-owned Git: repository URL plus exact 40/64-digit revision.
   - Linux-owned folder: `source: {"kind":"folder"}`.
   - Existing/restored: `mode: "linux-owned"` and
     `source: {"kind":"existing","sourceKind":"git"}` (or `"folder"`). Worker
     verifies the current canonical directory and repository root without clone,
     checkout or file movement. A historical restore receipt is not verification
     of the current files.
6. `POST .../bindings/:bindingId/provision` with `operationId`,
   `bindingGeneration`, and `protectedRequest`. The Server durably records the
   original scope and ciphertext before dispatch. Repository URLs remain opaque
   to it. The worker decrypts and verifies the bound placement before mutation.

The guest path is an explicit Linux address, separate from worker-local source
paths. Linked Git stays owned by the original worker. See [source behavior and
dependency overlays](SOURCES.md) before using guest-native Git in a linked mount.

## Lost delivery and runtime changes

An operation's saved completion and a binding's current availability are separate.
`GET .../bindings` lists canonical binding state; execution also requires a
connected instance and matching attachment/runtime generations.

`POST .../bindings/:bindingId/recover` observes the worker's durable operation
record without replay. Reposting the identical provision admission also performs
observation only. A different operation or ciphertext for that binding is refused.
If dispatch was lost before the worker recorded it, the outcome remains unknown;
there is no automatic second clone or Docker replacement.

The worker retains native session/process provenance privately. Public receipts
contain no native capabilities, session IDs, process argv, or clone credentials.
Worker restart turns an unfinished in-memory operation into an unknown outcome.

Docker source mounting can recreate the whole container. Its receipt reports the
new executor generation and interrupted workspace desktops. The Server observes
the actual new generation before accepting the receipt. Other bindings with old
generations remain unavailable. After restart/replacement, explicitly refresh the
instance and `POST .../bindings/:bindingId/verify` to inspect retained bytes and
revalidate a binding. Verification never repeats Git provisioning or mounting.

Saved operation outcomes remain observable when the guest is unavailable. They
do not make the source available or authorize a host fallback. The desktop remains
independent of the executor's administrative shell sessions.

## Verification

Disposable Docker and installed-VM tests exercise the actual HTTP route handlers,
worker routing/encryption code, exact-revision clone, workspace UID/cwd, literal
filenames, artifact bytes, and lost-response recovery without replay. Fixture keys
are synthetic component keys; this checkpoint does not claim a real agent turn or
the product's account-key installation workflow.

```sh
CANTRIP_OS_TEST_CONTAINER=cantrip-os-sources-test \
  pnpm --dir cantrip_server exec vitest run \
  test/cantrip-os-management.integration.test.ts --maxWorkers=1
CANTRIP_OS_TEST_TRANSPORT=/private/path/to/strict-ssh-transport.json \
  pnpm --dir cantrip_server exec vitest run \
  test/cantrip-os-management.integration.test.ts --maxWorkers=1
```

Native Server HTTP tests exercise the production router and worker bridge against
an isolated PostgreSQL database. Repository tests exercise both native PGlite and
PostgreSQL. These HTTP/database fixtures use simulated worker receipts, separate
from the actual guest tests above. Receipts are retained in the ignored
`artifacts/phase3-dispatch/` directory.

## Explicit instance recovery observation

`POST /api/cantrip-os/:instanceId/recovery` accepts the selected
`attachmentGeneration` and nullable `runtimeGeneration`. Both are compared with
Server-owned records before observation; a stale selection is rejected. The
Worker performs the existing read-only inspect command. The response contains
`instance`, recorded `workspaces` and a `recovery` result:

- `same-runtime`: the intended instance/attachment and previous runtime match.
- `runtime-changed`: the same instance is running a different executor generation.
- `first-observation`: no previous runtime was recorded for comparison.
- `unavailable`: observation failed; it does not prove a guest reboot or diagnose
  whether the Worker, transport or optional service caused the failure.
- `identity-changed`: the transport returned a different instance or attachment.

Unknown/replaced targets retain their recorded identities and last runtime;
`status: unknown` prevents execution. Only a verified matching identity can update
workspace records or supply a new current runtime. Existing compare-and-set
observation guards prevent an older generation from overwriting a newer one.
Recovery does not attach another machine, restart a desktop, resume a command,
repeat provisioning or change any captured chat/view placement. Changed runtimes
require source verification and newly admitted targets through the existing
workflow.

`recovery.workerContinuity` is an independent observation: `same-worker`,
`worker-restarted`, `first-observation`, or `unavailable`. It compares the
authenticated Worker's actual process generation on both sides of the inspect
request with the last explicit recovery observation stored for this attachment.
It does not infer restart from timestamps, a failed request, or a guest runtime
change. Initial/legacy attachments have no Worker baseline until their first
verified check. A changed connection during inspection leaves continuity
unavailable while the actual inspect still runs.

Previous and observed Worker process generations are returned with the recovery
result. Ordinary Refresh does not consume this explicit recovery baseline.
Worker and guest runtime changes can therefore be reported separately, including
a new Worker with an unchanged guest runtime. Both historical generations fence
the recovery update, so a late response cannot overwrite a newer Worker
observation. This metadata does not grant execution authority or retarget chats.

## Durable workspace creation

Workspace creation retains the first Server admission's owner, logical Server,
Worker, instance and guest identity, attachment/runtime generations, transport,
workspace name and operation ID. Reusing an ID with different intent is rejected.
Both Servers store this admission before sending a Worker command.

`GET /api/cantrip-os/:instanceId/workspace-operations` lists owned history with
`limit` (default 20, maximum 100) and an optional operation-ID `cursor`.
`GET /api/cantrip-os/:instanceId/workspace-operations/:operationId` reads one
summary. These summaries omit the private transport.
`POST .../workspace-operations/:operationId/observe` observes the original Worker
journal. Repeating the original create request also takes this observation path;
it never sends create a second time. Terminal receipts remain available while
the Worker or guest is offline.

A missing Worker record or uncertain delivery remains unknown. The existence of
an account with the same name does not prove that an admitted operation created
it. Observation does not create an account or reconstruct a missing receipt.
Worker inspection checks every original dispatch-scope field, while continuing
to support core inspection of source operations with additional source fields.

The Server validates the operation ID and workspace receipt. It records the
historical outcome even if the attachment changed, but atomically registers the
workspace only against the original current Worker/guest/attachment/runtime.
Observation revisions prevent a late reply from overwriting a newer observation.
The existing settings form still retains its creation ID only while mounted;
persistent client recovery/history controls are a separate product checkpoint.
