# cantrip-history

Native worker-local history persistence and replay from the current Node source
journal, reducer, outbox and projection/rebase implementations. This is independent
of provider execution and the server application or database.

- `source::Journal`: v1 manifests, scope-hashed directories, immutable encrypted
  records, exact ordered hashes, durable identities, same-frame deduplication,
  chained integrity checks and bounded authenticated reads.
- `source::Recovery`: one existing journal per `next()` call, scope filtering,
  known-journal suppression, cancellation and isolated damaged siblings. Missing
  identities and records remain errors; discovery does not create replacements.
- `content`: the six existing source, prepared-batch, projection/rebase and
  outbox-baseline/mutation field-key and associated-data domains. Historical key
  revisions, fatal UTF-8 decoding, BOM and UTF-16 behavior match the current worker.
  Production randomness and maintained cryptography come from `cantrip-crypto`.
- `native`: actual generated worker-local source/snapshot schemas and native
  thread/snapshot-barrier rules. `packages/protocol` remains the shared contract
  authority; the additional graph is generated from the real worker-local schemas
  using the existing exporter. No JavaScript is used at runtime.
- `cursor::Tracker`: validated observation frames, per-item u64 predecessor gaps,
  complete-item recovery, overlapping reads and epoch replacement. This owns no
  execution permission or committed projection cursor.
- `reducer::reduce`: complete pure source reduction into the existing v1 state.
  Preserve item/turn identities, relative chronology, revisions, measured times,
  canonical/legacy separation, native u64 ordering, late reads, uncertain deltas,
  conflicting completions and immutable settings/model attribution. Unknown or
  malformed future evidence remains retained. JavaScript deep equality includes
  signed zero, and actual coercion errors propagate without mutating prior state.
- `outbox::Outbox`: complete v1 opaque batch ledger, recovered server-receipt
  baselines, legacy batch/ACK files and encrypted append/replace mutation logs.
  Freeze body/identity/ciphertext before delivery; keep retries byte-identical,
  correlate only canonical receipts and never skip uncommitted records. Permanent
  rejections replace the complete pending tail with fresh identities while old
  encrypted records remain immutable. Baseline digests reuse the shared sorted
  wire digest, separate from ordered local record hashes.
- `files`: private files, flush-before-hard-link publication without overwriting
  committed paths, directory flushing and process-local serialization.
- `projection::Projection`: complete v1 stage/checkpoint/commit and rebase
  transactions over the real source journal and outbox. Freeze state, batch IDs
  and ciphertext before delivery; advance a source cursor only after every
  canonical receipt. Reopen pending transactions without projecting again.
  Durable encrypted rebase plans retain accepted prefixes and the exact original
  source range across repeated permanent rejections and interrupted replacement.

`Encryption` supplies live account/server identity and an atomic copied grant.
The worker adapter uses its real authorized encryption service. Keys, derived
material and plaintext byte/string buffers are zeroized; callers must still keep
decrypted JSON values out of logs and avoid unnecessary plaintext copies.

Journal methods enqueue synchronously on a canonical-directory FIFO shared by
independently opened handles. Accepted work runs on owned blocking jobs and
survives abandonment of its result future. Errors release successors only after
the operation finishes. Call owners must drain their accepted operations before
shutting down Tokio; a worker/runtime process crash is recovered from committed
files. The queue is process-local, matching the existing worker. Never run two
workers concurrently against one mutable profile. Cross-process hard-link
collisions remain actual errors and require retrying the original frame.

Source records are evidence before projection or server acknowledgment. This API
has no consume, prune or server-commit operation. The directory index stores
headers only and refreshes new records; authenticated payloads are opened only
for the requested page. The default source read is `read(0, 128)`, maximum 512.
Use `head()` as a finite read boundary; it does not advance a projector checkpoint.
Do not substitute canonical sorted digests for source-record hashes.

Windows keeps the existing file-only fsync behavior. Unix uses private 0700/0600
creation modes and flushes publication directory entries. This does not introduce
a Windows ACL policy. Actual Windows/Linux runtime validation was not performed
for this cycle.

Local verification:

```sh
node --import tsx scripts/worker-rust/history-source-contracts.mjs
node scripts/worker-rust/cargo.mjs test -p cantrip-history --lib
node scripts/worker-rust/cargo.mjs build --example history-source-fixture
node --import tsx scripts/worker-rust/history-source-compatibility.mjs \
  --binary /absolute/shared-target/aarch64-apple-darwin/debug/examples/history-source-fixture
```

Runtime observation/capture, retry pumps, canonical identity/rendering/protection,
attachment processing and end-to-end delivery remain worker port work. The
authenticated HTTP client is implemented in the worker's `history::client`,
outside this storage crate. Coherent archive decryption/recovery and production
orchestration still need implementation. These library APIs alone advertise no
new worker capability.

The reducer accepts an optional previous state and the verified journal page;
it does not advance a source cursor or authorize execution. It parses previous
and returned state through the actual exported worker schema. States remain
private plaintext in worker memory until the owning projection encrypts them.
The journal fixture exercises encrypted-page reduction and serialized state
across an actual native-process restart. Production capture and execution must
still integrate the reducer and projection/ACK transactions.

Reuse the existing Node reducer suite as a differential oracle:

```sh
CANTRIP_NATIVE_HISTORY_FIXTURE=/absolute/shared-target/aarch64-apple-darwin/debug/examples/history-source-fixture \
  node_modules/.bin/vitest run --config scripts/worker-rust/history-reducer.config.mjs
```

Every reduction in that focused configuration executes the original Node
implementation and a fresh native process, then compares full state, revisions,
errors and exact JSON bytes. Normal worker test execution still runs the Node
suite directly. Development/reference tooling may use Node; the history crate
and native fixture do not require it.

The outbox accepts an optional async recovery callback only when the local stream
and committed record files are absent. Its caller must supply a complete
**authenticated** server archive and matched permanent rejection proof; local
storage cannot establish network authority. Existing missing/corrupt identities
stay errors. The canonical-directory FIFO also owns asynchronous recovery across
response abandonment, and errors release the next operation only after settlement.

Additional local outbox verification:

```sh
node scripts/worker-rust/cargo.mjs build --example history-source-fixture
node --import tsx scripts/worker-rust/history-outbox-compatibility.mjs \
  --binary /absolute/shared-target/aarch64-apple-darwin/debug/examples/history-source-fixture
```

The native fixture's optional key-lookup barrier is development-only coordination
for an actual Node/native cross-process mutation race. It affects only synthetic
fixture keys, uses ordinary system nonce generation, and is absent from the
production encryption service and history crate. All profiles are disposable.

`Projection::open` receives an authorized encryption service, matching journal
and outbox handles, a pure `project` callback, an optional pure `rebase` callback,
an authenticated `deliver` callback and an optional explicit cancellation check.
The callback owner supplies canonical IDs, protected prepared batches, HTTP
authentication and in-flight cancellation. Local storage does not establish
network authority. `BatchRejected::verified` validates a matched rejection before
constructing the distinct error that selects rebase; ordinary HTTP/transport
errors propagate. Projection and rebase callbacks must avoid dispatching native input.

Projection methods use the same owned FIFO as other history APIs. Dropping the
returned drain future does not stop an accepted transaction. Explicit runtime
cancellation is checked before delivery, after a remote receipt before local ACK,
and before committing state. A later owner reconciles the same frozen bytes.
Missing manifests, replaced source/outbox identities, orphan plans, inconsistent
hash chains and missing canonical receipts fail rather than reset the cursor.

Additional local projection verification:

```sh
node --import tsx scripts/worker-rust/history-projection-compatibility.mjs \
  --binary /absolute/shared-target/aarch64-apple-darwin/debug/examples/history-source-fixture
```

This runs the actual Node/native projection implementations over real encrypted
journals and outboxes with a controlled durable receiver. It covers lost replies,
partial commits, repeated rebases, actual process restart, filesystem obstruction,
explicit cancellation and abandoned responses. The receiver is fixture data;
this is not evidence for the pending production HTTP integration.
