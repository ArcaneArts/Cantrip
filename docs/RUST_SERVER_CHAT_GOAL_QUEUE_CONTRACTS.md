# Chat Goal and canonical queue contracts

Current comparisons pass all three stores and authentication modes for Goal
controls, canonical native queues and Chat controls. Rust now publishes the
missing Goal invalidations after successful mutating HTTP responses. Complete
server replacement and final shipping acceptance remain open.

## Observed failure and repair

The strengthened PGlite anonymous comparison observed 79 identical HTTP cases
and matching worker command DTOs on each peer, but 15 reference Goal events
against one native event. The reference's mutation hook publishes `chat-goal`
after successful POST/PATCH/DELETE responses, including successful no-op clears.
Rust's Goal routes omitted that hook, leaving clients without expected refreshes.

The repair uses the existing response-completion adapter and Chat mutation
publisher. It preserves authenticated ownership, chat/project routing and the
existing runtime publications. GET/HEAD/OPTIONS and rejected responses do not
acquire these invalidations. The original failing reports, source and frozen
executables remain retained. Final Goal matrices have 15 matching invalidations
per peer/cell, including the existing successful, rejected, offline and
threadless control paths.

## Executed evidence

Tests run locally on macOS arm64 from
`d3178be5d8715dbb5ddc22a8c288c363ffd33d64` with the Goal publication repair.
Goal and queue suites run the frozen production executable. Chat controls use
the production router with disposable SQL fixture endpoints. Each suite passes
PGlite, private PostgreSQL and external PostgreSQL with anonymous, password and
account authentication.

| Observation                                                 | Count |
| ----------------------------------------------------------- | ----: |
| Paired database/authentication cells                        |    27 |
| Paired HTTP case observations                               | 2,403 |
| Paired Chat control cases included above                    |   756 |
| Additional paired caller-disappearance phases               |    18 |
| Received Goal get/update/clear/create commands across peers |   738 |
| Received protected Task continuation turns across peers     |    18 |
| Received Chat control case commands across peers            |   432 |
| Goal Live invalidations across peers                        |   270 |
| Queue Live invalidations across peers                       |   198 |
| Executed Task/Goal ciphertext proof assertions across peers |   450 |
| Executed queue cryptographic proof assertions across peers  |   720 |
| Actual worker queue SDK operations across peers             |    90 |
| Traced HTTP requests, including setup and polling           | 9,499 |

Paired HTTP counts include the exact compared Goal/queue observations and Chat
control cases; they do not count every setup/polling request or treat the
additional disappearance phases as single HTTP calls. Cryptographic counts
include repeated assertions, not distinct keys or messages.

## Preserved behavior

Goal comparisons retain Task dashboard state, concurrent PR admission, encrypted
Goal metadata, owned/foreign requests, threadless/offline handling, runtime
admission, held continuation and durable reopen assertions. Complete received
Goal commands and original turn DTOs are retained alongside normalized
comparisons and full raw Goal event frames.

The old fixture expected a plaintext continuation prompt. The current reference
and native implementation already send `protectedTaskPrompt`. The fixture now
requires exact equality with the protocol-parsed worker-admitted ciphertext,
decrypts the actual command through production Task cryptography, verifies the
original content and requires the plaintext prompt to be absent. Existing
result-mode and idempotency assertions remain. This repairs the test oracle;
it does not introduce a server plaintext path or remove the content assertion.

The canonical queue fixture likewise omitted the current `goalRecovery: null`
field. The complete expected empty snapshot now includes it. Real worker SDK,
opaque queue/import content, session fences, ownership, idempotent mutations,
claim/import conflicts and existing receipt assertions remain. The queue
comparison additionally records and compares complete `chat-queue` invalidations
without the per-connection cursor; original frames retain that cursor.

Chat controls retain complete per-case response, command, before/after durable
state and Live assertions, production message encryption, release/dirty-worktree
handling, compaction, policy, authorization, SQL failure, caller disappearance,
restart and clean process-exit checks. Their raw case command stream binds
worktree status, message protection and compaction. Controlled worker filesystem
and native/model replies do not execute leaf Git or actual model compaction.

## Reproduction and remaining work

Build the workspace/reference packages, supply the native frozen executable and
database runtime overrides, and run:

```sh
node --import tsx scripts/server-rust/task-dashboard-goals-http.mjs \
  --database pglite --keep-fixture --report /absolute/path/goals.json
node --import tsx scripts/server-rust/native-queue-http-compatibility.mjs \
  --database pglite --keep-fixture --report /absolute/path/queue.json
node --import tsx scripts/server-rust/chat-control-http-compatibility.mjs \
  --database pglite --boundaries --report /absolute/path/controls.json
```

Repeat with `bundled-postgres` and `postgres`. All three authentication profiles
run by default. Chat controls require the SQL fixture executable override;
Goal and queue tests use the production server. The
[acceptance record](security/rust-server-chat-goal-queue-acceptance.json) binds
actual received commands and Live frames to each storage/authentication pair,
with exact source/report/trace/executable hashes. Complete retained evidence is
in the external `rust-server-chat-goal-queue-delivery-20261110-v1` archive.

Rust formatting, strict all-target Clippy and all 86 library tests pass. All
seventeen generated schema graphs/maps match. The required `pnpm check` retains
744 passing worker tests, two capacity/backoff failures and two unhandled
errors. Both failures reproduce on clean Primary at the same base with
byte-identical worker/test files. Full formatting reports twelve unchanged
Primary files. Neither aggregate check is claimed to pass.

The ledger now maps 269/323 worker commands and 44/47 Live resources, including
partial scopes. Its existing 584 HTTP, 370 repository and 135 table mappings
retain their separate scope. Remaining Live types are explorer-filesystem,
inference-progress and server. Remaining commands, other consumers, historical
partial scopes, broader interruption/coordination and final current supported
platform/product/shipping acceptance remain required. The worker remains Node.
No GitHub Actions development run or production Winterhold deployment occurs.
