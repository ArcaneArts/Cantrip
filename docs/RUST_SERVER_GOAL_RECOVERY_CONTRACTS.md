# Rust server Goal recovery

The Node server reconciles retained Task sessions and pending worktree
transitions when an authenticated worker connects or posts a heartbeat while
connected. Rust had the same recovery service but neither production entry
point invoked it. A paired HTTP and WorkerConnection run exposed the omission
as an absent passive `chat.goal.get` after worker replacement. Periodic Task
scheduling can also issue that read. The regression uses expired dispatches
without pending inputs and no active dispatches during the presence checks so
the scheduler cannot supply the expected observation.

Both Rust entry points now start the existing recovery operation with the
authenticated owner and worker. The operation reconciles retained Task sessions
before pending worktree transitions, shares the existing recovery guards, and
drains with the execution service during shutdown. The socket can receive
worker replies and the heartbeat can return while reconciliation proceeds.

The compatibility suite uses actual HTTP, App Live, WorkerConnection and
isolated databases. It holds the native observation after reconnect, then
returns a bound failed execution and verifies the Task observation revision,
unchanged dispatch lease and absence of a new lane or message. An authenticated
heartbeat observes a separate running session, takes a new fence on its
existing dispatch and adopts the original thread in one execution lane.

Task source capture verifies current source digest, worker generation and
controls. A real SQL exception while binding a second encrypted snapshot leaves
the original binding intact. A successful retry retains the same binding ID
with the new snapshot. The durable queue rejects an old-generation recovery
receipt, retries the original source and acknowledges the new revision once
the replacement worker schedules it. The original dispatch, source identity
and encrypted Task content survive.

Agent recovery rejects an old-generation observation and retires the exact
source after a valid current-bound negative observation. A deferred first-cycle
receipt retains the applied Goal setter and its claimed prompt. A current
negative observation then consumes the claim and prompt without replaying the
setter or inserting another message.

The worker transport and endpoint encryption execute through the existing SDKs.
The suite controls the native observations and does not run a native Core Goal
cycle. Task first-input handoff and final product, platform, migration,
post-write rollback, and performance acceptance remain separate.

All nine local storage and authentication combinations pass. The matrix retains
165 paired HTTP observations, 1,538 traced requests, 360 worker command
observations, 198 Live events and 54 exact state reopens. A separate verifier
checks the raw command and generation bindings, retained rows and trace, and
opens 162 distinct payloads using Node's crypto primitives. The original Rust
binary fails the isolated reconnect case before comparing version metadata.

Four partial command mappings bring the current ledger to 284 of 323. The
passive recovery reads also extend the existing `chat.goal.get` evidence.
The [acceptance record](security/rust-server-goal-recovery-acceptance.json)
identifies the reports, source hashes and tested artifacts.

Rust formatting, strict all-target Clippy, and all 86 Rust library tests pass.
The local `pnpm check` reaches the worker tests and reproduces two existing
model-capacity and backoff failures, with 744 worker tests passing. Both
failing cases were reproduced on clean main at `c65da5e2`. Their test and
implementation files have the same hashes in this candidate.

```sh
node --import tsx scripts/server-rust/native-goal-recovery-http-compatibility.mjs \
  --database pglite --report /absolute/path/to/goal-recovery.json
```

Build the current protocol, crypto, logging, version and Node reference packages
first. Supply the native fixture executables, PostgreSQL test binaries and
PGlite runtime assets as for the other server HTTP suites. Use
`--database bundled-postgres` or `--database postgres` for the other backends,
and `--profile none|password|accounts` to run one authentication profile.

## Current Goal publication and source capture

The `1.1.2869` repository fixtures passed 1,101 paired cases and 15
exact reopens across PGlite, bundled PostgreSQL, and external PostgreSQL.
The comparisons explicitly check the output seal on an active native-root
response and the pending queue wake on an autonomous terminal receipt.
Replay, authority rejection, SQL rollback, and restart preserve the full
raw state within each runtime.

The same build passed 165 paired HTTP observations and 54 state reopens
across all nine database and authentication combinations. The Task source
capture exercises actual worker transport, encrypted binding, and database
rollback with controlled native replies.
[Current Goal acceptance record](security/rust-server-2869-goal-publication-acceptance.json)

## Queued first Task Goal input during a provider transfer

A browser test runs the packaged worker and Codex Core against an isolated
Rust server on macOS ARM64. A second Agent holds the source provider's only
inference slot while the first Task Goal input waits. The test matches that
input to the keeper's durable queue entry, captures it through the browser,
and starts a transfer to a second provider. The destination receives the
original input while the source slot is still occupied. The test verifies the
worker's export digest, imported native history and Goal epoch, then reopens
the same Goal and transcript after restarting the server and worker.

The original Rust server failed during withdrawal because PostgreSQL inferred
the pause timestamp as text. After the parameter was typed, the existing
eligibility constraint rejected the scheduler's `provider-transfer-pending`
status. Migration 0288 permits that status and retains the other allowed
values. A populated PGlite upgrade preserved the existing rows apart from
the local user's routine `updated_at` refresh.

PostgreSQL also reported deadlocks between Task outcome handling and native
command writes. The Task owner lock now serializes Task writers while allowing
foreign-key checks. Goal outcome retirement takes the owner and cycle locks
before the project and chat locks, matching the input outcome transaction.

The local historical profile test applies migrations 0287 and 0288 to a
populated copy of the Node `1.1.2733` profile. It compares all 137 tables
and four sequences and verifies encrypted writes across the Rust upgrade,
Node rollback, and return to Rust on all three databases. The original
profile stays read-only throughout the test.

The rebuilt local server passed 16 product steps on each database with the
packaged `1.1.2869` worker and Codex Core `0.166.0`. The worker's durable
receipts record the destination Goal cycle outcome on every store. The frozen
Node reference also transferred the original input on PGlite. Its Task
remained in `implementing`, and the trace showed no later Goal cycle dispatch.

[Queued Task Goal transfer acceptance record](security/rust-server-task-goal-provider-transfer-acceptance.json)

## Cancelling a prepared transfer and recovering a committed transfer

The cancellation case holds the worker's actual preparation acknowledgement.
The browser cancels the durable reservation while the worker has a staged
destination. The worker restores the source route and thread. The destination
stays unpublished and receives zero inference requests. Once the competing
Agent releases the source provider's slot, that provider receives the
original Goal input.

The interruption case holds the acknowledgement after the server commits the
transfer. The browser receives HTTP 409 when it tries to cancel. The test
kills the actual worker at that boundary. Its replacement reconnects with
the retained worker profile, reopens the imported thread, and completes the
same transfer with a fresh runtime generation. The destination receives the
original Goal input and the server retires the lost runtime generation.

Both PostgreSQL modes reproduced a race in the previous Rust server. The
failure of the superseded continue command changed the stored revision while
the worker resolved the cancellation's source configuration. The server now
records an unavailable-worker diagnostic only when the dispatch still owns
the state it was issued against. The cancellation and recovery paths retain
their ordinary wire contracts.

On committed recovery, Core can queue an autonomous turn while resuming
the destination thread. Restoring the Goal can advance its epoch before the
original input is delivered. The worker guards that input before resume and
claims the exact pending turn under the native root hold. Core acknowledges
the denial and settles the unused turn before the worker sends the original
input. The browser verifies that each encrypted turn appears once and the
completed Goal survives another restart.

One direct Goal read on bundled PostgreSQL returned HTTP 409 after both
turns committed. The acceptance fixture uses the existing browser query's
bounded retry for this read and still requires the completed Goal and exact
transcript before and after restart. The original 409 is retained in the
acceptance evidence.

Run the browser fixture with `--task-goal-provider-transfer-fault
cancel-prepared` or `--task-goal-provider-transfer-fault worker-after-commit`.
Use `--database pglite`, `--database bundled-postgres`, or `--database postgres`
with the same packaged worker and Core inputs as the normal transfer case.
[Transfer cancellation and recovery acceptance record](security/rust-server-task-goal-transfer-recovery-acceptance.json)

## Transferring a queued autonomous Task Goal turn

The browser lets the original explicit Goal input finish while a second
Agent takes the source provider's only slot. It captures the autonomous
native turn waiting behind that Agent and matches its scope, attempt and
operation to the worker's durable admission record. The transfer withdraws
that exact attempt. The destination opens the same conversation and admits
a new native Goal turn while the source provider is still occupied.

The previous worker completed the native turn without publishing its result.
When the active worker needs a publisher, its dispatch request opts in to
receiving the exact encrypted prompt already stored for the original input.
The worker observes the admitted native turn and uses the existing durable
encrypted outcome publisher. Requests without this option retain the
original response fields.

The Rust terminal projection uses the continuation's provider from the
durable dispatch marker. The original input keeps its provider and identity.
Using that provider to check the destination turn had left a committed
result unprojected.

The local browser runs verify the original input and autonomous result each
appear once, the Goal completes, and the conversation and transfer reopen
after restart. Run the browser fixture with
`--task-goal-autonomous-provider-transfer` and each database mode.

[Autonomous Task Goal transfer acceptance record](security/rust-server-autonomous-task-goal-transfer-acceptance.json)

## Interrupting a transferred autonomous Task Goal

The browser can cancel while the worker's prepared acknowledgment is held.
The original route resumes from the requeued source, and the destination
makes zero model requests. After commit, the same cancellation returns HTTP 409. The fixture kills the worker before it can consume the commit response.
A fresh worker completes the same handoff and publishes the Goal outcome
under the destination route.

Worker loss can suspend the original execution lane before the terminal Goal
outcome is projected. The terminal observation now settles the chat when the
same owner, worker, worktree, and lane activation still match. The suspended
lane stays closed.

The pause case captures a transferred turn after Core executes a shell
command. It reopens the same checkpoint after a worker restart and resumes
that turn with the original tool result. The handoff resolves the worker's
repository routing token before capturing the continuation. When an older
checkpoint stores that token, the worker resolves it after opening the scoped
checkpoint and still checks the resulting path against the admitted execution.

Run the browser fixture with `--task-goal-transferred-pause` or combine
`--task-goal-autonomous-provider-transfer` with
`--task-goal-provider-transfer-fault cancel-prepared` or
`--task-goal-provider-transfer-fault worker-after-commit`. Use
`--database pglite`, `--database bundled-postgres`, or `--database postgres`.

The macOS ARM64 matrix passes all nine combinations with the local Rust
executable and full worker. A PGlite upgrade run resumes a checkpoint created
by the previous worker build using the same worker profile.
[Autonomous Task Goal interruption acceptance record](security/rust-server-autonomous-task-goal-interruption-acceptance.json)

## Shared dependency loss after transfer commit

The browser and worker connect to different Rust servers with shared PostgreSQL
and Redis. The test holds the worker's real commit response, checks that the
handoff is committed, and releases the response during the selected outage.
Both peers report unavailable readiness during the outage and recover with
their original processes.

In the PostgreSQL reproduction, the worker's finish request and subsequent
failure report both returned HTTP 500. Its existing connection stayed open.
The browser kept reading the same committed operation after the database
restarted, and the Goal remained pending.

The worker now retries the exact idempotent commit and completed-finish
requests after transient HTTP or transport failures. Retry honors cancellation
and uses a bounded backoff window. The PostgreSQL fixture sees the original
worker retry finish through recovery and complete the destination Goal once.
The Redis fixture runs past the original worker claim's TTL and verifies that
the new connection retains the same worker continuity identity.

Run the browser fixture with `--database postgres --server-pair rust/rust`
and `--task-goal-provider-transfer-fault postgres-after-commit` or
`--task-goal-provider-transfer-fault redis-after-commit`.
[Shared dependency acceptance record](security/rust-server-shared-task-goal-transfer-acceptance.json)

## Participating server loss after transfer commit

The fixture kills one Rust server with SIGKILL after PostgreSQL commits the
handoff and before the worker consumes the held HTTP response. The
replacement starts at the same origin with a new instance identity. The
browser and worker stay alive, as does the other Rust peer.

Loss of the browser-facing server leaves the worker's Redis connection claim
unchanged. Loss of the worker-facing server produces a new claim with the
same worker continuity identity. In both cases the worker consumes the held
response and finishes the original handoff. The withdrawn source stays
retired and the new provider admits one Goal cycle. The browser reopens the
same encrypted transcript without additional inference.

Run the browser fixture with `--database postgres --server-pair rust/rust`
and `--task-goal-provider-transfer-fault client-peer-after-commit` or
`--task-goal-provider-transfer-fault worker-peer-after-commit`.
[Participating server acceptance record](security/rust-server-task-goal-peer-loss-acceptance.json)
