# Retained system replacement and rollback

The host library can replace a Docker CantripOS instance's root image while
retaining the original container, or explicitly roll back to that original. It
also supports deliberate root reset to an exact normal base image. This is an
administration foundation: Server-owned admissions, private Worker command
routing, client review/history and fresh execution authority remain dependent
Phase 5 work. These functions do not enroll a clone or issue runtime handles.

The external Worker remains the orchestrator. These operations need actual Docker
management access, not a live guest executor/recovery helper. Nothing installs a
Worker or model credentials in the guest. An SSH login alone does not provide
power-on or generic physical/VM disk replacement.

## Retained and replaced state

The selected image replaces the root filesystem. There is no automatic merge of
arbitrary root changes into a different base. The previous writable layer stays
in its exact original container, stopped under a retained name. Rollback likewise
retains the replaced container and its later root writes. The library never
deletes either container, image or volume.

Current bind/named/anonymous volume references, linked source metadata and runtime
configuration are retained. Image defaults are changed using the same policy as
source recreation: explicit current container overrides remain. Actual anonymous
volume names are retained, and volume copy-up is disabled so an empty retained
volume is not populated from restored root defaults. Actual candidate mount
identities must match the current mount layout before activation. Mount mismatch
does not prevent fencing the same proven candidate during rollback.

Mounted data is retained at its current contents, not restored from the root
image. Use [workspace backups](BACKUPS.md) separately. Changes to shared files
made while the replacement is active remain visible after rollback. A root
checkpoint may contain older account/package configuration than retained data;
application/source verification is still necessary after maintenance.

A checkpoint image must match its original operation/request/container labels and
the same logical instance. Known private system images cannot be declared normal
base templates. Private images contain identity material; this is same-instance
recovery, not clone provisioning. Product admission fencing and fresh clone
identities/SSH keys remain separate required work.

## Transition and failure behavior

The caller supplies an immutable operation and exact original Docker ID, together
with its canonical name. A private, synced journal is reserved before effects.
Image availability is verified first. If necessary, an already authenticated
private staging tar is read and hashed through an open descriptor before a
one-shot streamed image load. Its bytes are checked again during upload. The
loaded image's exact identity and ownership labels must match before root changes.
The upload does not buffer tar bytes or enlarge bounded JSON receipt limits.

The original's restart policy is disabled and verified, then the original is
stopped. A candidate is created with automatic restart disabled, verified, and
assigned the canonical name after retaining the original under its new name.
Only then can the candidate start. Its desired original restart policy is
restored after the requested start step; the retained original keeps `no`.
`startTarget: false` omits an explicit start, while retaining the desired policy
for future Docker behavior. Current running state is reported separately.

Rollback is a new immutable operation referencing the original replacement
request hash and original physical ID. It fences/stops the proven candidate,
retains it under another name, returns the original to its canonical name and
optionally starts it, restoring its recorded restart policy. It also works after
a definite startup failure or before a candidate has been activated. A still
uncertain candidate start cannot be bypassed by starting the original: positive
start/completion proof is required first.

Every mutation is claimed durably before dispatch. Repeated execution only
observes. Observation never loads, stops, creates, renames, starts or updates a
policy. Lost creation replies can recover only one matching candidate under its
reserved name; copied labels or ambiguous candidates do not authorize another
generation. Explicit continuation sends only future steps without prior claims.
A refused or uncertain mutation is not retried under the same operation.

Completed history is retained independently of current availability. New
observations can report a stopped/missing container or an unavailable Engine
without rewriting that history. Actual failures leave retained state available
for an explicit recovery decision. No helper-health or unrelated package gate
prevents the management operation from being attempted.

These locks coordinate Cantrip management paths. An unrestricted root/Docker
administrator can still start retained containers manually; product controls must
retire old admission authority rather than treating those containers as clones.
Do not race external Docker administration with a transition.

## Administrative use

The [checkpoint pipeline](SYSTEM_CHECKPOINTS.md) authenticates private archives
before producing a private plaintext staging tar. The raw administrative API
accepts that verified tar's path, exact byte count and SHA-256; a checksum supplied
by itself is not private-backup authentication. `archive: null` uses an already
available, verified image and does not invent a download/pull capability.

Example replacement request, stored privately:

```json
{
  "action": "replace",
  "operationId": "<new operation UUID>",
  "container": "<canonical current Docker name>",
  "expectedContainerId": "<full original Docker ID>",
  "instanceId": "<logical instance UUID>",
  "scopeKey": "<owning admission SHA-256>",
  "startTarget": true,
  "source": {
    "kind": "checkpoint",
    "imageId": "sha256:<captured image digest>",
    "operationId": "<original capture UUID>",
    "requestSha256": "<original capture request SHA-256>",
    "containerId": "<original capture container ID>"
  },
  "archive": {
    "path": "/private/worker/staging/authenticated-system.tar",
    "bytes": 82348032,
    "sha256": "<authenticated archive SHA-256>"
  }
}
```

For a deliberate base reset, use `source: { "kind": "base", "imageId":
"sha256:<exact normal base image digest>" }`. Review this as a root reset; retaining
home volumes does not retain current root customization in the active image.

```sh
node cantrip_os/scripts/manage-replacement.mjs execute request.json private-journal.json
node cantrip_os/scripts/manage-replacement.mjs observe request.json private-journal.json
node cantrip_os/scripts/manage-replacement.mjs continue request.json private-journal.json
```

Rollback request fields are `action: "rollback"`, a new `operationId`, the same
`container`/`instanceId`, its own `scopeKey`, `startTarget`,
`replacementOperationId`, `replacementRequestSha256` and `expectedOriginalId`.
The last ID pins the retained original, not the currently active replacement:

```sh
node cantrip_os/scripts/manage-replacement.mjs execute rollback.json private-rollback.json private-journal.json
```

Library exports are `replaceSystem`, `observeSystemReplacement` and
`continueSystemReplacement`. Requests, errors and journals can contain private
host paths. Product callers must enforce canonical owner/Worker/attachment scope
and protect these details; this raw administration API is not a public route.

## Actual acceptance

Build normal Worker dependencies/modules, then opt into disposable Engine tests:

```sh
pnpm --filter '@cantrip/worker^...' build
pnpm --filter @cantrip/worker build
CANTRIP_OS_REPLACEMENT_INTEGRATION=1 \
CANTRIP_OS_REPLACEMENT_EVIDENCE=/absolute/private/evidence \
  node --test cantrip_os/tests/system-replacement.integration.test.mjs
```

The tests create/authenticate a real private checkpoint, load it, replace a newer
root and roll back. They kill coordinators after real creation/rollback-start
with replies held and exercise a real missing-executable startup failure.
They verify packages, Unicode/binary root files, ownership, mounted data, later
root writes, one-shot transitions and retained-container restart fencing.
The normal packed host library is tested separately from full Worker/client
routing. See [the acceptance record](ACCEPTANCE.md) for exact artifacts and limits.
