# Server-owned executor dispatch

This is the Phase 3 source-admission checkpoint. Both Server implementations
provide the same administrative HTTP routes and worker commands. The interactive
attachment picker, real agent runtime, terminal/editor routing, and Run integration
are subsequent checkpoints; these APIs alone do not complete Phase 3.

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
4. Admit a binding with `POST /api/projects/:projectId/cantrip-os/bindings`:
   - Linked: `mode: "linked"`, `workspaceId`, the exact existing `worktreeId`, and
     explicit `dependencyOverlays`, such as `[{"path":"node_modules"}]`.
   - Linux-owned: `mode: "linux-owned"`, `workspaceId`, and `sourceKind` (`git` or
     `folder`, preserving the project's Git capability). The response includes
     new independent source and Primary worktree IDs. It is not yet ready.
5. Seal `cantripOsProvisionRequestContentSchema` with the existing
   `repository-content` component and repository-operation encryption. Its AAD
   binds Server/project/worktree/operation IDs and request direction. Its plaintext
   binds instance/workspace/binding/binding-generation IDs and the intent:
   - Linked: selected worker path/routing reference and the admitted overlays.
   - Linux-owned Git: repository URL plus exact 40/64-digit revision.
   - Linux-owned folder: `source: {"kind":"folder"}`.
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
