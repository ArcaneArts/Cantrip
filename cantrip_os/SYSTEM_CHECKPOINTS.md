# Private system-image checkpoints

This host administration checkpoint preserves a Docker container's writable
system layer: installed software, its package database, `/etc`, and other root
customization outside mounted data. It is the foundation for Phase 5 shared-system
replacement and private Worker transfer. Server admissions, encrypted publication,
replacement/rollback controls and the client workflow remain subsequent work.

The external Worker remains the orchestrator. Nothing installs a Worker or model
credentials in the guest. No guest executor or recovery helper is required for
these Docker management operations. SSH attachment to an installed OS does not
invent Docker, hypervisor or powered-off-machine authority.

## Scope and consistency

Capture explicitly interrupts the whole container. It observes the exact
foundation container ID, stops it, confirms its stopped state, commits a labeled
private image, verifies that image, and optionally resumes the same original.
Existing instance locks and an additional exact-container-ID lock serialize
cooperating management paths, including different references to the same ID.
External Docker administration must not race the checkpoint.

The consistency claim is a stopped-container filesystem, not a saved live process,
application transaction guarantee, portable login or automatic merge of arbitrary
root changes into a new base image. Services that do not shut down cleanly may
need their normal crash recovery. New runtime authority and source verification
remain necessary after a container restart.

[Docker commits](https://docs.docker.com/reference/cli/docker/container/commit/)
omit mounted data; [container export](https://docs.docker.com/reference/cli/docker/container/export/)
also omits it. The manifest therefore records every observed user volume/bind
mount as `included: false`, with its actual destination, reference and read-only
state. It also identifies Docker-regenerated hosts/hostname/resolver files.
Retained homes, workspace archives, dependency volumes and external Host sources
must be handled explicitly. This image is not a full instance-data backup.

Images and exports may contain machine identity, SSH host keys, environment values
and arbitrary root secrets. Their manifest is marked `containsPrivateIdentity`
and `identityPolicy: same-instance-only`. They are private recovery data, not
public templates. This carrier does not provision clones or authorize two guests
with copied enrollment. Clone identity rotation/fencing remains Phase 5 work.

## Durable operations and uncertain delivery

The caller supplies one immutable request, a full physical Docker ID and a
private journal path. A synced exclusive reservation precedes mutation. Each
stop/commit/resume claim is saved before its Engine request. Changing any request
field under the same journal is refused, without overwriting retained state.

Repeating capture only observes. Observation never stops, commits, uploads or
starts anything. A lost commit reply can be recovered from one actual image with
matching operation/request/container/instance labels, verified through image
inspection. Missing, foreign or ambiguous image proof stays unknown. A commit
claim is never sent again, including under explicit continuation.

Explicit continuation may perform only future steps without prior mutation
claims. For example, after recovering a committed image it can issue the original
remaining resume request. A lost resume reply can be reconciled from the exact
original's actual running state; no second start is sent. Unknown effects remain
unknown rather than being inferred from the existence of a filename or package.
The original carrier error is retained separately from later recovery state.

Completed capture history stays committed if the current Engine becomes
unavailable. Current original-container observation is returned separately.
Export checks and reads the actual recorded image; it does not capture the
current filesystem again. Tar packaging can differ between exports of the same
image ID, so each archive has its own byte digest. Retain a completed encrypted
archive and receipt rather than regenerating it after uncertain publication.
A missing image returns its actual Engine error. No container, volume or image
is deleted by this carrier.

## Administrative CLI

Use the owning host's real Docker Unix socket or named pipe through its normal
Docker context/`DOCKER_HOST`. The socket is never mounted into CantripOS. The
integration tests use a private Unix socket bridged over pinned, authenticated
SSH to a disposable Linux Docker host; this is test infrastructure, not a new
public Docker endpoint or a generic SSH power capability.

Create a private request file from the actual observed target:

```json
{
  "operationId": "<new UUID>",
  "container": "<original Docker name or reference>",
  "expectedContainerId": "<full observed 64-character Docker ID>",
  "instanceId": "<original CantripOS instance UUID>",
  "scopeKey": "<64-character lowercase SHA-256 of the owning admission>",
  "resumeOriginal": true
}
```

The scope key is immutable management metadata, not an enrollment credential.
Actual administrative authority comes from the owning Docker connection. Product
callers must additionally enforce their canonical owner/Worker/attachment scope.

From the repository root:

```sh
node cantrip_os/scripts/manage-system.mjs capture request.json private-journal.json
node cantrip_os/scripts/manage-system.mjs observe request.json private-journal.json
node cantrip_os/scripts/manage-system.mjs continue request.json private-journal.json
node cantrip_os/scripts/manage-system.mjs export request.json private-journal.json private-system.tar
```

`resumeOriginal: true` resumes only if the original was initially running. False
leaves it stopped after capture. The CLI never substitutes a replacement container.
If recovery shows a captured image but unfinished resume, inspect the original
operation before choosing continuation. A still-uncertain mutation is not retried.

Administrative export is an explicit plaintext image tar with mode 0600; the CLI
reports its actual bytes and SHA-256. It stages, syncs and links the file without
overwriting an existing destination. A reported stream/file error removes its own
partial file; killing the exporter can leave a private `.partial` file, without
replacing the destination. The transfer receipt proves bytes and their digest;
restore must authenticate the archive and verify the loaded image before activation.
The `openSystemCheckpointImage` host API instead returns a stream
for the Worker's private encryption/transfer pipeline without persisting plaintext.
The streamed GET has its own lifetime and does not enlarge bounded JSON receipts.

## Validation and remaining delivery

The Node tests exercise stop-before-capture, retained configuration, honest mount
references, physical-ID serialization, immutable admission, lost stop/commit/start
replies, missing/foreign/ambiguous image proof, terminal history during Engine
outage and read-only export. Actual Unix HTTP tests stream beyond 4 MiB and retain
real HTTP refusals and truncated-stream failures.

Opt into actual Docker acceptance on a disposable Linux Engine with a locally
available Debian image:

```sh
docker pull debian:trixie-slim
CANTRIP_OS_SYSTEM_INTEGRATION=1 \
CANTRIP_OS_SYSTEM_EVIDENCE=/absolute/private/evidence \
  node --test cantrip_os/tests/system-checkpoint.integration.test.mjs
```

The test creates only uniquely named disposable containers/volumes/images. It
installs a real Debian package and root marker with non-default ownership, then
kills the host coordinator after a real commit or start while its reply is held.
It recovers without replay, exports the private image, removes that test image to
force an actual reload, and checks restored bytes, package state, ownership and
the explicit exclusion of mounted data. Each run retains its own evidence path.
This is a host-carrier test, not a full Worker/client/model or cloud acceptance
claim. See [the acceptance record](ACCEPTANCE.md#phase-5-private-system-checkpoint-carrier-2026-11-06).

Installed Debian package upgrades already preserve configuration and workspace
state through [external package repair](PACKAGE_RECOVERY.md). Generic root-disk
replacement is not provided by an SSH login; physical/VM disk recovery needs its
actual management path. Shared-system replacement, protected Worker/Server
admissions, client controls, clone identities and final current distributions
remain required for the full Phase 5 goal.
