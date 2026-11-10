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
