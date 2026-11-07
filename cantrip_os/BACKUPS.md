# Private workspace backup format

The Phase 5 guest package captures and restores data; the existing external
Worker owns transport, encryption and storage. `cantrip-os-recovery` remains an
optional package without a Worker, network listener or model credentials.

Worker private archive helpers, durable jobs and real Docker/SSH roundtrips are implemented.
Both Server implementations now own durable admissions and a paginated private
catalogue. Cantrip's project settings expose capture, history, restore,
rollback and explicit recovery. Restored-source registration and instance/package
controls build on those admissions. The browser/full Worker Docker checkpoint
uses production Server grants; real external SSH acceptance remains required.
See [the guest command guide](packages/recovery/README.md) for local administration.

Capture stops the registered workspace services and remaining account processes.
Save application work first. Close Chromium when its latest history/settings
must be committed: filesystem backups do not save application memory, and a
new navigation can still be buffered when the browser is terminated. A live
SQLite lock does not mean capture cannot run; the recovery command coordinates
writers before copying their files. See the [guest guide](packages/recovery/README.md)
for the interruption policy and the acceptance record for actual tested scope.

## Format and keys

Version 1 is a newline-delimited JSON file. Its first record contains the fixed
format identifier, backup UUID, format version, key revision and encrypted
metadata. Subsequent records contain encrypted archive chunks and a mandatory
authenticated end record. The metadata contains the guest manifest and archive
byte length/SHA-256; paths, profiles and archive bytes are not stored in plaintext
in the encrypted file. Chunk size is at most 1 MiB, private metadata at most
16 MiB, and the end record at most 4 KiB. Input line buffering is bounded too.

Encryption reuses the account's `repository-content` component grant and existing
HKDF/AES-256-GCM primitives, with a distinct
`protocol:cantrip-os-private-backup` table/domain and per-kind field keys.
Authenticated data binds the owner, hashed Server identity, backup UUID, format
version, key revision, frame kind and sequence. Different accounts, Servers,
backups, revisions or frame positions cannot exchange authenticated frames.
Every frame gets a fresh random nonce through the existing encryption helper.

The end record authenticates the actual chunk count, total bytes and SHA-256.
Decryption requires exact ordering, authenticated metadata, an end record, and no
trailing records. Missing, reordered, duplicated or corrupted frames cannot
publish a usable plaintext archive. SHA-256/length must also match the guest's
captured receipt before the Worker publishes an encrypted backup.

The Worker requests the specific revision from `WorkerEncryptionService` when
opening older backups. A historical active grant works even after a newer
revision becomes current. Missing/revoked grants fail; an unrelated current key
is not substituted. Temporary component/field keys and owned plaintext chunk
buffers are cleared after use.

## Storage and transfer boundaries

`sealPrivateBackup` and `openPrivateBackup` operate in a dedicated Worker-private
directory (0700), with files opened exclusively as 0600. They sync completed
files and publish with an atomic hard link that cannot overwrite an existing
destination. Failed transfers/authentication remove their private partial files
and leave existing destinations intact. A failure after publication leaves the
completed file observable rather than deleting an uncertain successful result.

Opening a backup publishes a verified private plaintext transfer archive only
after the complete file authenticates. Its caller must delete that temporary
archive after staged transfer/restore. Normal thrown failures clean partials;
hard process loss can leave root/user-private staging for operation recovery.
Durable Worker jobs retain private checkpoints and clean local transfer staging
after a confirmed completed or failed restore. An uncertain receive retains its
staging for inspection. Active workspace data is ordinary plaintext;
these encrypted files are private backups, distinct from reusable OS templates.

`recovery-carrier.ts` uses the existing strict authenticated SSH or owning Docker
transport. Binary export/receive goes directly through the optional root command,
outside native process-output retention. The Worker drains archive streams with
backpressure and accepts a transfer only after the actual exporter exits
successfully. Capture/restore control requests have no speculative availability
gate, generic short control timeout or automatic mutation retry. Lost carriers
remain uncertain admissions to inspect by their original ID.

Guest 0.2.0 checks persistent instance/attachment identity, the admitted runtime
for mutations, and the exact workspace account under its actual maintenance
lock. Full product admission must resolve these canonical generations and
authorize explicit recovery after maintenance restarts guest services. Source
bindings and old runtime handles are not silently retargeted.

## Durable Worker jobs

Capture, restore and rollback have immutable operation IDs, canonical placement
and encrypted private intent. Their records are atomically published and synced
before guest effects. Checkpoints and transport/account details stay in the
Worker-private journal; public results contain state, phase, timestamps and an
encrypted receipt. Requests, responses and file metadata occupy separate
authenticated frame positions and cannot substitute for one another.
Actual failure diagnostics are encrypted too, because they can contain private
paths. If the account key is unavailable, the redacted recorded outcome remains
observable without exposing those diagnostics.

A repeated admission returns the original result; changing its intent or scope
fails. Observation opens only the saved admission, including its original scope;
it does not create a missing job or reauthorize another runtime. Actual guest
receipts establish completion. If an encrypted archive was already published,
the Worker authenticates the entire file and its captured placement before
recovering completion, even while the source OS is unavailable.

Read-only observation can finish encryption from a completed capture or record
an already completed activation, without recapturing, uploading, exchanging
homes, releasing guest maintenance or deleting guest spool files. Missing
cleanup is reported as a warning. Explicit recovery may release a dead guest
operation's maintenance, and explicit continuation may finish pre-receive
verification or activate a known received archive while its admitted runtime
remains valid. An uncertain receive is never uploaded again automatically.
Explicit Server continuation can authorize a newly observed runtime for the
same attachment, instance, account and Worker. It persists that grant separately
and leaves the original scope and intent unchanged. The Worker allows only the
runtime to differ, and the guest checks it under its actual lock.

Restore requires a fully authenticated backup and saves its exact archive digest
before upload. Its guest receipt must match that digest and the admitted target
account. Replacement retains the original home, and rollback uses a separate
admission and actual directory identities. Guest spool cleanup preserves the
restore outcome and rollback evidence, including older retained receipts.

## Server admissions and catalogue

Client admissions contain operation/workspace IDs, expected attachment/runtime
generations, opaque private intent, and an owned backup/restore reference where
relevant. The Server resolves transport, UID/GID/home and source roots in its
admission transaction. The last verified Linux Git common path supplies explicit
metadata roots; linked Host bindings remain references. Existing home/Git
discovery and recorded external-reference rules still apply.

| Method | Endpoint                                                  | Behavior                                           |
| ------ | --------------------------------------------------------- | -------------------------------------------------- |
| POST   | `/api/cantrip-os/:instanceId/backup-operations`           | Admit capture, restore or rollback once            |
| GET    | `/api/cantrip-os/backups`                                 | Paginated capture catalogue                        |
| GET    | `/api/cantrip-os/backup-operations`                       | Paginated history including restores and rollbacks |
| GET    | `/api/cantrip-os/backup-operations/:operationId`          | Read the saved owned operation                     |
| POST   | `/api/cantrip-os/backup-operations/:operationId/recovery` | Explicit observe, recover or continue              |

Lists accept `limit` (1–100, default 30) and an owned operation-ID `cursor`.
Labels, private intent, results and diagnostics remain opaque. Public summaries
omit command/transport/account details. Capture completion is historical
evidence, not a claim that an archive still exists: `archiveAvailability` is
`not-checked` or `worker-offline`, independently of its saved outcome. Actual
restore authenticates the stored file before guest activation.

Admissions survive Server restart. An identical request observes its original
Worker admission even after runtime changes; changed intent under the same ID
is rejected. Restore references the capture's saved scope, rather than the
source instance's latest runtime. Results are identity-checked; out-of-order
observations cannot downgrade completed evidence. A lost response is unknown
and does not authorize another mutation.

Continue additionally requires the selected attachment and current runtime.
The Server checks owned identities and records the runtime grant atomically
before dispatch. Reattachment, another instance or changed account cannot be
substituted. A stale health flag alone does not prevent the actual pinned
operation: the Worker/guest verify its exact runtime and identities. Restoring
files does not recreate source bindings or retarget old chats.

## Workspace reset admissions

The recovery-operation API also admits `action: "reset"`. This is a filesystem
reset with a retained original, not an encrypted archive capture; the backup
catalogue continues to contain capture rows only. Migration 0279 extends the
existing action constraint and preserves existing admissions and references.

The public admission pins the selected workspace, attachment and runtime, using
the same immutable operation UUID and protected-request envelope as backups.
Only the encrypted private intent contains `paths`: a nonempty list of canonical
home-relative paths, or `["."]` for the complete home. Duplicate, overlapping,
absolute and traversal selections are rejected before Worker admission. Shared
packages, `/etc`, account identity and machine identity are outside this reset.

The Worker decrypts and verifies the intent, records the complete original
command privately, and dispatches `cantrip-recovery reset` once with expected
instance, runtime and numeric account identity. Reset receipts must match the
original workspace ID, UID/GID, home and exact path list, and confirm that
maintenance was released. Paths, retained-directory locations, interruption
information and actual diagnostics stay in the encrypted response.

Observation reconciles the existing operation, including after Worker restart.
Explicit recovery can release interrupted maintenance and reconcile the actual
home exchange. Neither recovery nor continuation repeats a reset, even if the
saved checkpoint never received a guest reply. Missing Worker journals remain
unknown; an account name does not prove a reset happened.

Undo uses the existing `rollback` action; its historical `restoreOperationId`
field can reference a reset or restore. Admission requires the original instance,
workspace, guest identity and attachment. A new runtime on that same attachment
can be selected deliberately. The guest verifies the actual retained directories
before exchanging them, retaining the replaced home and subsequent writes.

Reset currently interrupts all managed Cantrip workspace services through the
shared maintenance mechanism. Other workspace files remain unchanged. Old live
processes, windows and runtime handles are not restored; after maintenance,
explicitly check recovery and verify affected sources against the fresh runtime.
Cantrip now exposes reset review/confirmation, encrypted saved-request recovery,
owned history and undo. Actual Docker product acceptance covers full Worker death
and browser reload after a committed reset, with the same receipt and one reset
dispatch. See [the product workflow](PRODUCT_WORKFLOW.md#reset-workspace-state).

## Evidence and remaining work

Unit tests cover identity/key/position authentication, historical grants,
private permissions, fragmentation, mandatory EOF, corruption, missing/reordered/
duplicated/trailing frames, existing destinations, receipt mismatch and actual
input-stream failure. Real package roundtrips capture data through Docker and
strict SSH, seal it on the Worker side, verify it, receive/restore it into a new
account and read the resulting ignored/Unicode/binary files through the native
filesystem executor. The fixture uses ephemeral key material through the same
grant interface; it is not acceptance of actual Server grant delivery or product
controls. See [acceptance](ACCEPTANCE.md) for exact results.

The client checkpoint additionally exercises actual Server grant delivery through
the full Worker and Cantrip's browser controls, including a full Worker SIGKILL
and historical capture observation. It is separate from the earlier ephemeral-key
fixtures. See [the product workflow](PRODUCT_WORKFLOW.md#private-workspace-backups).

Restored-source adoption and lifecycle/upgrade controls now have separate product
acceptance records. Cross-instance restoration is covered by the following full
Server/Worker API test. Current model/CUA and real external SSH acceptance,
installed-system product coverage and final recorded Docker/ISO distributions
remain required. A local VM reached over SSH is not cloud acceptance.

## Cross-instance product test

`cantrip_worker/test/os-cross-instance.product.integration.test.ts` uses the
actual running Node Server, full external Worker, real account grants and guest
packages. It creates two disposable Docker instances, captures through the
product API, verifies encrypted-file permissions, corrupts that test archive,
checks the existing destination home, restores the original archive bytes and
restores into another new account. Both machines retain their distinct identities
and SSH host keys. Source registration creates fresh binding/source/worktree IDs;
the original binding remains on the original instance. An old native binding is
rejected on the destination even with a running executor under the same workspace
name. Repeating the immutable admission returns the original encrypted result.

Run only against a disposable local profile with an initialized anonymous
encryption profile and its saved recovery artifact. Approve the Worker's actual
principal and grant `repository-content`, `private-surface-metadata` and
`surface-private-state` through the normal registry, then refresh its grants.
The Server must allow the test client's origin `http://127.0.0.1:5179`.

```sh
CANTRIP_OS_PRODUCT_TEST_ORIGIN=http://127.0.0.1:4322 \
CANTRIP_OS_PRODUCT_TEST_RECOVERY=/absolute/private/recovery.json \
CANTRIP_OS_PRODUCT_TEST_WORKER=disposable-worker-id \
CANTRIP_OS_PRODUCT_TEST_WORKER_DATA=/absolute/private/worker \
CANTRIP_OS_CROSS_INSTANCE_TEST_IMAGE=your-current-normal-image \
  pnpm --filter @cantrip/worker exec vitest run \
    test/os-cross-instance.product.integration.test.ts --maxWorkers=1
```

The test requires direct access to that disposable Worker's private archive
directory for corruption injection. It removes its containers and anonymous
volumes in `finally`. The caller owns the Server/Worker profile, private recovery
file, archives, image and build caches and must remove those after testing. Set
`CANTRIP_OS_PRODUCT_TEST_EVIDENCE` to retain bounded JSON assertions; it does not
export key material or profile contents. The closed browser-profile fixture
tests file/SQLite preservation, not portable browser authentication or current
interactive browser/model acceptance.
