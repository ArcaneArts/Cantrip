# Chat execution, approvals and resource revocation

Standalone Agent queues now return the revisioned snapshot already supported by
the app. Previously their reads returned an array while mutations required a
revision; the app interpreted that array as having no revision, preventing
canonical reorder. Both the production Rust route and development reference
receive the repair. The worker remains Node, and full server replacement remains
incomplete.

## Reproduced mismatch

The retained original reference run returns the standalone array and rejects
revisionless reorder with `409 queue-revision-required`. After repairing the
reference read, its complete public Chat flow passes 94 HTTP observations,
cryptography, actual worker SDK calls and durable reopen. The old frozen Rust
executable completes 54 observations before failing the standalone numeric
revision assertion. Fresh fixed executables pass the full matrix below.

No protocol schema change is required. The existing app parser accepts a queue
snapshot and retains its revision, items, imports and claims. Its thirteen
managed-queue tests pass. The HTTP comparisons exercise standalone frozen add,
revision rejection, reorder, opaque edit/delete, active steering and completion.

## Executed evidence

Tests run locally on macOS arm64 from
`c65da5e2ea2f6bcd89d99111e3c511545a67aa18` with the queue-read repair. Public
Chat and Task suites use frozen production executables. Approval tests use the
production router with disposable SQL fixture endpoints. Each passes PGlite,
private PostgreSQL and external PostgreSQL with anonymous, password and accounts
authentication.

| Observation                                            | Count |
| ------------------------------------------------------ | ----: |
| Paired storage/authentication cells                    |    27 |
| Paired HTTP case observations                          | 2,208 |
| Received command witnesses bound to eight new mappings |   702 |
| Interaction ciphertext proof assertions across peers   | 1,098 |
| Normalized interaction Live events across peers        |   450 |
| Task ciphertext proof assertions across peers          |    90 |
| Public Chat ciphertext proof assertions across peers   | 2,287 |
| Actual worker native SDK receipts across peers         |   144 |
| Actual worker native SDK HTTP requests across peers    |   432 |
| Raw active claim/worker receipt bindings               |    36 |
| Raw consumed project claim rows after reopen           |    90 |
| Controlled pause commands across peers                 |   180 |
| Traced requests, including setup and polling           | 6,583 |

Cryptographic counts include repeated proof assertions and polling reads, not
distinct keys or messages. Mapped command counts include acknowledged and
deliberately rejected worker requests; their HTTP and durable outcomes retain
the separate assertions. Incidental unsupported maintenance commands are not
new coverage mappings.

## Current control contracts

Approvals retain visible/protected responses, exact endpoint decryption,
ownership, native activation/runtime generations, worker failure, SQL failure
after acknowledgement, retry, caller disappearance and restart. Two held native
replies exhaust the control lane, and a third receives 429. The computer-use
reply uses the independent ordinary lane and must complete with the original
protected response while both native replies remain held. The former fixture
incorrectly expected that ordinary request to share the exhausted control lane.

Public Chat controls retain encrypted turns, canonical queue mutation receipts,
project and standalone steering, latest-message retry/rollback, actual native
admission/dispatch/settlement SDKs and post-close SQL reads. Initial managed
submissions now enter the canonical queue. Their held roots remain visible
while a steered item is consumed, and disappear after settlement. Five project
claims replace the old fixture's two claims, which omitted initial submissions.

The two newly observed active-root operation IDs incorporate random claim IDs.
The fixture independently recomputes their SHA-256 identities from owner, Chat,
message key and original claim ID, then checks the actual received worker
receipt and generation before comparing semantic identities. Original claims
and receipts remain retained; an arbitrary hash is not normalized away.

Current managed pause controls preserve durable intent when an older opposite
worker acknowledgement arrives. Task control errors use their current
confirmation contract. Ten real pause command attempts per peer include
controlled rejection, project partial failure, stale revisions and caller loss.
Offline Task control reports failed worker confirmation; a failed Resume restores
the durable Pause. Exact reopen assertions preserve that intent and the original
encrypted Task content. These fixture updates do not change production pause
semantics.

Task deletion now uses durable resource revocation. The comparison asserts no
legacy interruption based on cached Chat status, and verifies three original
Chat targets for both inference and preview revocation. Controlled inference
acknowledgements contain the actual owner and worker identity, allowing pending
delivery to advance; preview acknowledgement is `closed: true`. Existing
Task creation, ciphertext, rollback, deletion and reopen assertions remain.

## Reproduction and remaining work

After building the reference workspace, supply frozen production/SQL/repository
binaries and database asset overrides, then run:

```sh
node --import tsx scripts/server-rust/agent-interaction-http-compatibility.mjs \
  --database pglite --keep-fixture --report /absolute/path/approvals.json
node --import tsx scripts/server-rust/public-chat-execution-http.mjs \
  --database pglite --keep-fixture --report /absolute/path/execution.json
node --import tsx scripts/server-rust/task-surfaces-http.mjs \
  --database pglite --keep-fixture --report /absolute/path/tasks.json
```

Repeat with `bundled-postgres` and `postgres`; all three authentication profiles
run by default. The [acceptance record](security/rust-server-command-control-acceptance.json)
binds complete received commands, reports, traces, sources and four frozen
executables. Original failed fixtures and unpatched executables are retained in
the external `rust-server-command-controls-delivery-20261110-v1` archive.

Rust formatting, strict all-target Clippy, all 86 library tests, thirteen app
queue tests and seventeen generated graph/map comparisons pass. Required
`pnpm check` retains 744 worker passes, two capacity/backoff failures and two
unhandled errors. Both failures reproduce on clean Primary at the same base
with identical worker/test bytes. Full formatting reports twelve unchanged
Primary files. Neither aggregate check is claimed to pass; changed-file checks
pass separately.

The ledger maps 277/323 worker commands, including partial scopes. Existing
584 HTTP, 370 repository, 135 table and 47 Live mappings retain their separate
qualification. The controlled worker uses real transport, cryptography and
native SDKs, without executing leaf Codex/model inference or native GUI capture.
Remaining commands, historical partials, broader recovery/coordination and final
current supported-platform product/artifact/shipping acceptance remain required.
Validation runs locally; no GitHub Actions development run or production
Winterhold deployment occurs.
