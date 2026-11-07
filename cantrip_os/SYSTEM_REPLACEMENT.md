# Retained system replacement and rollback

The host library can replace a Docker CantripOS instance's root image while
retaining the original container, or explicitly roll back to that original. It
also supports deliberate root reset to an exact normal base image. This is an
administration foundation with Server-owned admissions and history in both Server
implementations and [client review/history controls](PRODUCT_WORKFLOW.md#shared-system-checkpoints-and-recovery).
These functions do not enroll a clone or issue runtime handles.

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
recovery, not clone provisioning. Completed-target recovery through the Server
retires the earlier attachment authority and issues fresh handles explicitly.
Fresh-image and offline-install clone preparation separately rotate Linux and
enrollment identities and managed SSH host keys; a normal restart retains them.
The [local clone acceptance](ACCEPTANCE.md#phase-5-fresh-machine-identity-for-templates-and-copied-installs-2026-11-07)
records that distinction. These local results do not complete external SSH acceptance.

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

## Server-owned system admissions

Both Server implementations expose these authenticated, owner-scoped endpoints
under `/api/cantrip-os/:instanceId`:

| Method and path                                 | Behavior                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /system`                                   | Observe the exact current Docker target and normal base images.                |
| `POST /system-operations`                       | Admit capture, replacement or rollback with a saved UUID.                      |
| `GET /system-operations`                        | Paginated immutable request/outcome history (`limit`, `cursor`).               |
| `GET /system-operations/:operationId`           | Read saved history without contacting the Worker.                              |
| `POST /system-operations/:operationId/observe`  | Observe that original Worker job; no new admission or execution.               |
| `POST /system-operations/:operationId/continue` | Continue only that original admission.                                         |
| `POST /system-operations/:operationId/abandon`  | Close a prepared admission before execution is dispatched.                     |
| `POST /system-operations/:operationId/recover`  | Adopt the proven resulting physical identity after ready replacement/rollback. |

Save the complete create request before submission. Every create requires
`operationId`, `attachmentGeneration` and `targetGeneration` from the current
system observation. Capture uses `action: "capture"` and `resumeOriginal` (default
true). Replacement uses `action: "replace"`, `startTarget` (default true) and
`source: {kind: "checkpoint", operationId: "<ready capture UUID>"}` or
`source: {kind: "base", imageId: "sha256:<exact observed image>"}`. Rollback uses
`action: "rollback"`, `replacementOperationId` and `startTarget`. The Server
resolves checkpoint identity/encryption context from its original owned record;
a caller cannot substitute an archive path or declare private images as bases.
The normal Docker distribution declares its foundation-image label. Private
linked-source recreation snapshots, system checkpoints and replacement images
are excluded from reusable bases, including when an image list has stale labels.
The selected base's exact inspected labels are checked again before replacement.

Admission rotates attachment authority, clears runtime continuity and fences old
handles before maintenance. The command retains its original immutable scope;
summary `attachmentGeneration` is the current operation fence, while `context`
retains the original encryption scope. Control bodies contain the summary's
`attachmentGeneration` and `targetGeneration`. Current mount contents are retained;
a completed root checkpoint is not a workspace backup.

Dispatch has durable `preparing` and `executing` stages. Worker preparation saves
metadata and a protected receipt without contacting Docker. The Server commits
execution authority only after that receipt, then continues the original job.
Unknown preparation delivery can be prepared again or abandoned without guest
changes. Observation never advances either stage. A typed actual bridge refusal
before preparation was queued records `rejected` / `not-dispatched`. An abandoned
prepared job has the same terminal result; repeating its controls only returns
that result. Once execution is armed, missing receipts remain unknown and cannot
be converted into another execution or canceled as though nothing happened.

Ready replacement/rollback does not reconnect old work. Explicit system recovery
verifies the exact resulting full Docker ID, raw guest identity and owning Worker.
An unattached reset base is assigned only after that physical proof; a lost
enrollment reply is recovered through its raw identity instead of assigning it
again. A changed guest UUID is adopted on the same logical instance only through
this completed transition. SQL rejects ordinary owner/Worker/guest identity
rewrites. Recovery rotates attachment authority again and leaves runtime unknown;
use the existing **Check recovery** and source-verification steps for fresh work.
Old source bindings, chats and handles retain their captured generation.

Rollback retires continuation of its original replacement. Historical late
outcomes remain readable but cannot overwrite fresh runtime authority. New power,
package, desktop and workspace-creation admissions are blocked during an active
system admission. The ordinary desktop and optional guest packages remain separate from
these external Worker/Server management paths. This API foundation has no new
client controls yet and does not constitute real-remote product acceptance.

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

## Worker system commands

The registered Worker protocol now includes `cantrip-os.system.status`,
`cantrip-os.system.capture`, `cantrip-os.system.replace` and
`cantrip-os.system.rollback`. The Worker entrypoint routes these to a durable
system manager. These are internal command contracts, not public HTTP or client
controls. Server-owned admissions and fresh authority reconciliation remain
required before exposing them through Cantrip.

Discovery reads the actual Docker container archive without executing a guest
helper, including while stopped. It follows configured identity relocation and
guest-local symlinks without extracting archives on the host. Initial discovery
requires the owning guest identity. A previously verified exact physical target
can remain manageable after its own configuration/identity files break; a valid
foreign identity or a different physical container never inherits that proof.
Unavailable optional image inventory does not invalidate the proven target.
SSH-only targets report unsupported system-image management, not power authority.

Operation commands capture the complete original scope, target and selected
source. `execute` reserves once; repeats recover the original job. `observe`
performs no mutation. `continue` can dispatch only unrequested future steps.
A claimed effect with missing original proof stays unknown. Rollback references
the original replacement admission and retained physical root, even when the
current canonical name or replacement helper is unavailable.

Capture streams into the existing private system format. Replacement authenticates
the complete archive before private plaintext staging; a recovered staging file
must match its authenticated receipt. Operation outcomes use a separate encrypted
domain bound to the full admission and original physical identity. Terminal
ciphertext is retained unchanged across Manager restart, locked keys and later
Engine unavailability. Detailed paths, manifests and diagnostics stay protected.

Root completion does not restore runtime handles. A completed owned replacement
can authorize discovery of its exact resulting container and an older owned guest
identity; this does not itself adopt that identity or grant execution. Unattached,
foreign or unavailable guest state needs an explicit subsequent recovery decision.

## Actual acceptance

After the normal dependency/Worker builds shown below, run the real
Worker-command integration:

```sh
CANTRIP_OS_SYSTEM_WORKER_INTEGRATION=1 \
CANTRIP_OS_SYSTEM_WORKER_EVIDENCE=/absolute/private/evidence \
  node --test cantrip_os/tests/system-worker.integration.test.mjs
```

It invokes normally compiled Manager modules through the registered command
schema. This is not a full Worker/Server/client process acceptance test.

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
