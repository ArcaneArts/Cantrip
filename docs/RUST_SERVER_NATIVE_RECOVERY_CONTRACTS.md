# Current suspension and Task outcome contracts

The server replacement remains incomplete. This milestone compares the three
remaining unmapped internal route identities through the actual HTTP router:
`suspension-execution`, `task-goal-cycle-dispatch` and `task-goal-outcome`.
The worker remains Node. Development validation runs locally.

The harness uses the unchanged worker connection protocol with controlled
checkpoint and outcome facts, actual enrolled credentials and real endpoint
cryptography. Each comparison runs GUI suspension, terminal suspension, explicit
and autonomous Goal outcomes, and historical Task-round outcomes. Native PGlite,
private PostgreSQL and external PostgreSQL each run anonymous, password and
account authentication. SQL access is test-only setup, fault injection and
canonical-state observation; public behavior uses the production routes.

Suspension comparisons retain the original native turn, source, placement,
checkpoint revision and encrypted payload. A replacement worker process admits
and dispatches an observer for the same native turn. Duplicate admission returns
the original receipt; changed payload, placement, control and process authority
are rejected. The subsequent actual server restart preserves the reference's
origin-specific behavior: GUI admission retains the logical root but dispatch
is fenced by the offline activation; terminal startup leaves the lane suspended
and rejects replacement admission. Admission alone does not establish execution.

Goal comparisons first commit and replay an ordinary explicit Goal response,
including legacy delivery with omitted `inputKind`. They verify the opaque
response digest on the original user message. Autonomous scope dispatch binds
the current worker process, native runtime, original Task cycle, ordering epoch,
provider and assigned publisher. A captured encrypted answer commits after
worker replacement and replays after a real server restart. Changed sources
retire without writes; foreign publishers cannot replace the accepted answer.
An actual PostgreSQL trigger failure after message insertion rolls back the
answer and terminal receipt together on every store.

Historical-round comparisons deliver an older completed round while the current
Task is a newer draft, the original lane is released and the old provider route
and dispatch cycle are unavailable. Only the original protected answer and a
history-only terminal receipt are added. The entire newer Task and original lane
remain unchanged. Real SQL failure, replacement worker, server restart, replay,
changed output and deleted/replaced canonical inputs preserve these boundaries.
The stored request, precomputed failure, Task, round and message ciphertexts are
opened by endpoint code using their original row identity and classification.

The comparisons found and repaired three Rust differences:

- Suspension rejection bodies omitted the reference's public error text.
  Stale worker generations retain the separate code-only response.
- Autonomous Goal delivery awaited an extra Rust-only worker observation after
  committing its answer and terminal. An observation failure then returned HTTP
  500 despite the durable commit. The route now returns its committed receipt
  without that additional awaited operation; its unused helper is removed.
- Autonomous Goal publisher conflicts incorrectly returned the ordinary input's
  HTTP 409 response. The reference returns its sanitized global HTTP 500 for
  that branch. Ordinary Goal and round conflicts retain HTTP 409.

Reconnection may trigger optional background `chat.goal.get` reads before or
after the startup offline transition. Raw commands are retained. Each command's
Task ciphertext, cycle, placement, provider, model and observation authority are
independently checked. Comparison uses the stable read contracts after validating
each actual lifecycle state; asynchronous read count and running/offline timing
are not execution authority. The controlled worker declines those reads, so they
do not add a qualified worker-command identity.

The [acceptance record](security/rust-server-native-recovery-acceptance.json)
binds exact report pointers and actual successful request traces for the three
routes and three durable tables: 888 paired HTTP observations, 504 endpoint
decryption proofs and 2,784 actual traced requests. All 584 HTTP identities are now
mapped, including partial scopes. The ledger maps 121/135 tables, 156/323 worker
commands and 36/47 Live resources; all 370 repository identities were previously
accounted for. Mapping is not full replacement acceptance.

This comparison does not execute native Core/TUI runtimes, active-round
scheduling or actual model inference. Full product/fault/coordination, remaining
command/table/Live scopes and final supported shipping artifacts remain open.
No GitHub Actions or production Winterhold deployment was used.

All 86 Rust library tests, strict all-target Clippy and Rustfmt pass. The standard
`pnpm check` fails in the same two worker capacity/backoff tests: 744 pass, two
fail and two unhandled errors are reported. Both failures reproduce on clean
Primary at this milestone's exact base with byte-identical worker/test sources.
The full formatter reports twelve pre-existing files, independently compared
with Primary. Changed-source formatting passes. The aggregate check is not green.

Run `node --import tsx
scripts/server-rust/native-recovery-http-compatibility.mjs` with `--database`
and `--report`. Optional `--profile`, `--case` and `--keep-fixture` select a scoped
run and retain its original database. Frozen HTTP and repository executables are
supported through the existing fixture environment variables. Evidence is
retained in `rust-server-native-recovery-delivery-20261110-v1`.

## Packaged autonomous Task completion

The browser and packaged worker reproduced a Task that remained
`implementing` on Rust `1.1.2858` with both PGlite and external PostgreSQL.
The initial implementation turn returned a private answer and left the Goal
active. A separate turn started by native Codex called `update_goal` and
completed the Goal. Both worker HTTP calls for autonomous dispatch and outcome
returned 200. The retained PGlite rows show that the initial turn had already
projected its outcome while the later turn's terminal receipt committed
without advancing the Task. The Node reference completed the same browser
flow on both stores.

After the autonomous outcome commits, the Rust server now observes the Goal
on the bound worker in a background operation. The read uses the existing
Task and native session observation fence. It checks the current dispatch
cycle, thread, placement, worker and model binding before requesting state.
The outcome response uses the already-committed receipt. The controlled-worker
comparison declines the new observation and verifies that the captured result
and its replay still succeed with the original stored answer and receipt.

The browser regression leaves the first turn active and requires the native
continuation to complete the Task before the browser reads the Goal. It
checks that both answers appear exactly once and that the decrypted history
survives restart. The retry scenario waits for its native turn summary to
finish before taking the pre-restart transcript snapshot. Its exact
post-restart comparison still includes every message and activity.

The optimized macOS ARM64 package `1.1.2860` passed seven autonomous Task
product runs across all three stores and two Rust peers with shared PostgreSQL
and Redis. The worker traces record seven successful autonomous dispatches.
The retained PGlite store has one successful Task dispatch and both terminal
receipts on the same native thread, with a distinct turn ID for each receipt.

The packaged Agent queue and control comparison passed six product runs with
111 successful receipt requests. The packaged receipt suite passed 258 paired
HTTP observations across the nine store and authentication combinations.
The recovery suite with test SQL access passed 888 paired HTTP observations
across 36 scenario cells and verified 18 passive Goal reads after commit.
All 87 Rust library tests and strict library Clippy passed locally.

The [acceptance record](security/rust-server-current-native-admission.json)
binds the exact package, worker and reports. Two patched PGlite comparisons
recorded three intermittent HTTP 500 responses during the later Task retry
and restart steps. The retained PGlite rerun returned 200 for every outcome,
and all browser scenarios completed. The direct Task ordering defect is
resolved below. Autonomous Goal recovery and final shipping artifacts
retain separate acceptance scope.

With the browser dependencies built and the packaged server, worker and
native CLI supplied through the existing fixture variables, run:

```sh
node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --tasks --task-goal-autonomous --production-server --database pglite \
  --report /absolute/path/autonomous-task-pglite.json

node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --tasks --task-goal-autonomous --database postgres --server-pair rust/rust \
  --report /absolute/path/shared-autonomous-task.json
```

## Direct Task receipt arriving before the final stream event

The PGlite HTTP 500s came from successful direct Task rounds. The worker
sent the durable HTTP outcome while a provisional encrypted assistant
message already occupied the same row. The final envelope had a different
nonce and ciphertext. The message identity, role, mode, reasoning effort,
attachments and key revision matched. A later WebSocket completion could
finish the Task, and the worker could then replay the original outbox entry.

The round transaction now accepts the final envelope for the bound native
root message. It preserves the original message identity, position and
attribution. The existing Task dispatch fence, native thread and turn
binding, and stored message metadata must match. The final envelope, Task
state and terminal receipt commit together. The stream writer serializes
with that transaction and retains the finished row when an earlier update
arrives afterward.

The browser and packaged worker regression holds the final WebSocket event
after the browser reads a provisional answer. It delivers the same final
envelope through the real HTTP outcome route, replays the receipt exactly,
submits the provisional envelope as a conflicting receipt, and then
replays the earlier WebSocket event. It verifies the finished answer and
its retained history through restart. The forced ordering returned HTTP
500 on both the prior packaged Rust server and the Node reference.

The optimized macOS ARM64 package `1.1.2862` passes the forced ordering on
PGlite, bundled PostgreSQL, external PostgreSQL and a pair of Rust servers
with shared PostgreSQL and Redis. These four complete product runs verify
64 steps, including exact post-restart history, and record 36 successful
outcome responses and four expected HTTP 409 conflicts. The controlled
HTTP comparison passed 150 paired round observations across the nine
store and authentication combinations and 28 paired PGlite Goal
observations with account authentication. All 87 Rust library tests and
strict library Clippy passed.

The [acceptance record](security/rust-server-streamed-task-receipt-acceptance.json)
retains the prior failures, actual package hashes, successful runs and
separate Goal findings. One PGlite Goal input receipt returned HTTP 500
before succeeding on replay. One ordinary bundled PostgreSQL run left
the Goal Task implementing. In the first shared run, the direct Task
ordering assertions passed and the completed Goal's Chat remained
running. The retained database has an active recovered Goal lane and
the original successful terminal receipts. The shared rerun completed
all assertions. Goal recovery and final shipping qualification remain open.

```sh
node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --tasks --task-round-outcome-order --production-server --runtime rust \
  --database pglite --report /absolute/path/direct-task-receipt.json
```

## Goal receipt arriving before the final stream event

The controlled ordering in the real browser and packaged worker reproduced
a separate HTTP 500 on the explicit Goal input receipt. The prior Rust
package and the Node reference both received the matching final envelope
while the same bound assistant row held its provisional ciphertext.

A bound native root outcome now finalizes the exact assistant row in the
transaction that saves the receipt. The server uses the same identity,
classification, lane, worktree and key revision checks as the direct
Task repair. The new migration gives each message row a private
finalization flag. It defaults to false for existing rows. The server
also recognizes the completed direct-round receipts that predate this
migration. The public envelope, receipt and WebSocket schemas are
unchanged.

The optimized macOS ARM64 package `1.1.2863` passes the forced Goal input
order on all three stores and two shared Rust peers. It also passes the
direct Task order on external PostgreSQL. All five product runs preserve
the exact history after restart and record 45 successful outcome
responses and five expected HTTP 409 conflicts. The first shared run
passed the receipt assertions and was interrupted during restart by
a Vite reload while the local workspace dependencies were rebuilt.

The controlled autonomous Goal cycle fixture holds a real provisional
envelope in the database and delivers the authorized root receipt over
HTTP. It verifies commit, SQL failure rollback, restart, exact replay
and the existing rejection status for a changed receipt. The three
store runs passed 87 observations. The unmodified Node/Rust controlled
comparisons passed 249 paired Goal and 150 paired round observations.
All 87 Rust library tests and strict library Clippy passed.

The same-profile rehearsal uses the actual `1.1.2862` and `1.1.2863`
executables. On all three stores it upgrades after a settings write,
returns to `1.1.2862` after accepting another write, and re-upgrades
after another accepted write. Server identity and all three settings
values are retained. The SQL exports include the new field.

The [acceptance record](security/rust-server-streamed-goal-receipt-acceptance.json)
retains the exact packages, results and failed attempts. The recovered
lane and post-commit worker-owner interruption are qualified below.

```sh
node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --tasks --task-goal-outcome-order --production-server --runtime rust \
  --database pglite --report /absolute/path/goal-input-receipt.json

node --import tsx scripts/server-rust/native-recovery-http-compatibility.mjs \
  --streamed-goal-cycle-root --database pglite --profile accounts \
  --report /absolute/path/autonomous-goal-root-receipt.json
```

## Autonomous Goal projection after recovered lane or peer loss

The browser regression holds the second native turn at the model boundary.
The original Goal input has settled and its execution lane is suspended.
The real Task Recovery action observes the running native session and
reactivates the same lane. The prior Rust package accepted the autonomous
outcome and completed the Task while the recovered lane remained active.

The outcome transaction now advances the durable managed-queue revision
when it first records the terminal fact. Queue delivery requests a native
execution observation and keeps the revision pending if the worker is
unavailable or a runtime transition is still in progress. Projection
checks the original cycle and the current worker, thread, route,
worktree and lane activation. The protected Task state, matching lane
settlement and terminal projection timestamp commit together. Replays
reuse the receipt, and reconnect can enqueue an unprojected terminal
fact from an earlier package.

The worker-owner interruption case holds the native observation response
on the existing WebSocket after the HTTP receipt commits. It kills that
peer and keeps the original worker and browser peer running. The test
checks the original worker process and replacement connection, the
original receipt turn, the exact suspended lane, and both encrypted
answers through restart.

The optimized macOS ARM64 package `1.1.2864` passed six browser runs
across all three stores and two shared Rust servers. The runs passed
94 steps, with 49 successful outcome responses and one expected HTTP
409 for a changed receipt. The worker-owner loss case projected in
6.7 seconds from the original commit, with one delivery of that receipt.
The original worker PID and continuity identity were retained. The
replacement connection acknowledged the durable queue revision.

The controlled comparisons passed 249 paired Goal and 150 paired
direct-round observations. The controlled streamed autonomous root
case passed 87 Rust observations. All 87 Rust library tests and strict
library Clippy passed locally.

The [acceptance record](security/rust-server-autonomous-goal-lane-acceptance.json)
retains the prior package failures, exact macOS ARM64 package and local
results. The bundled PostgreSQL failure is a separate admission case.
The worker recorded the start of the native Goal turn, the model
received no Goal request and the server received no terminal receipt.
A traced rerun completed the flow. The original admission stall and
final platform and dependency interruption coverage remain open.

```sh
node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --tasks --task-goal-autonomous --task-goal-lane-owner-loss \
  --production-server --database postgres --server-pair rust/rust \
  --report /absolute/path/autonomous-goal-owner-loss.json
```
