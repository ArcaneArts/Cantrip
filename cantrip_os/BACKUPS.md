# Private workspace backup format

The Phase 5 guest package captures and restores data; the existing external
Worker owns transport, encryption and storage. `cantrip-os-recovery` remains an
optional package without a Worker, network listener or model credentials.

Worker private archive helpers, durable jobs and real Docker/SSH roundtrips are implemented.
Durable Server backup admissions, a product catalogue and Cantrip backup/restore
controls are still pending. These helpers are not a completed user workflow.
See [the guest command guide](packages/recovery/README.md) for local administration.

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
Changed mutation authority fails; it requires the product recovery path rather
than substituting a fresh runtime into the old admission.

Restore requires a fully authenticated backup and saves its exact archive digest
before upload. Its guest receipt must match that digest and the admitted target
account. Replacement retains the original home, and rollback uses a separate
admission and actual directory identities. Guest spool cleanup preserves the
restore outcome and rollback evidence, including older retained receipts.

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

Still required: Server-authorized backup admissions/catalogue and UI, full
product/agent/remote acceptance, instance
lifecycle and upgrade/customization preservation, and final recorded Docker/ISO
distribution artifacts. A local VM reached over SSH is not cloud acceptance.
