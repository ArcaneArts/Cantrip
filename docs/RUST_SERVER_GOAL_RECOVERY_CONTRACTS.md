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
Transfer cancellation, interruption recovery and shipping platform runs remain
open.
[Queued Task Goal transfer acceptance record](security/rust-server-task-goal-provider-transfer-acceptance.json)
