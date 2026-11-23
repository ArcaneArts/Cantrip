# Task Goal recovery after worker loss

The Rust replacement remains incomplete and Node remains the default server.
This milestone fixes duplicate encrypted answers when an active implementation
Goal recovers after its worker process dies. The worker remains Node.

## Canonical response ownership

The actual native runtime already publishes its completed assistant item. The
Goal command result previously encrypted the same text again under the assigned
fallback publisher. Real Node and Rust product runs both completed the Goal but
persisted two assistant messages for one answer.

The optional `task-message-encrypted.reusePublishedResponse` command field opts
into reusing the existing opaque response. Both servers advertise it only for a
prepared canonical Goal input. The worker reuses the exact published ciphertext
only when its privately held completed root message matches the result's native
thread, turn and text. Child, partial and unrelated messages cannot supply that
result. Other Task message paths retain their assigned response behavior.

An older worker strips the optional field and returns its existing assigned
response. A new worker connected to an older server receives no opt-in and
retains that behavior. Qualification includes parsing with the actual archived
older worker protocol, plus worker tests proving the flagless fallback and exact
ciphertext reuse without obtaining another component key.

The server accepts either the exact assigned publisher or the root-message
namespace of the input's bound physical thread and turn. The canonical receipt,
worker, owner, placement, lane and dispatch checks remain in the transaction.
Rust compares publisher prefixes by UTF-16 units, including unpaired surrogates.
The server never decrypts Task content or compares plaintext answers.

The accepted opaque message digest is pinned on the existing terminal receipt.
Later delivery cannot change its ID, key or encrypted content. A legacy terminal
without that digest cannot switch to a native publisher. Autonomous Goal cycles
retain their existing whole-notification digest. The same rules cover late
historical delivery; that path cannot settle the current Task or execution lane.

Immediate command completion validates a reused publisher through the same
canonical input transaction before finishing the chat. This prevents a durable
notification from succeeding while the immediate result incorrectly marks the
chat failed. Streaming and result delivery can arrive in either order; the
existing transactional message idempotency handles both.

## Local qualification

Evidence is retained under `.qa/rust-task-goal-worker-recovery` in the isolated
`codex/rust-task-goal-worker-recovery` lane. Earlier failures retain their reports
and fixtures.

The initial debug production candidate and current full worker pass the active
Goal worker-loss scenario for both servers on PGlite, bundled PostgreSQL and
external PostgreSQL. All four shared PostgreSQL/Redis server pairings also pass.
Each of those ten cases uses five actual model requests, kills the worker during
a held native stream, retains its credential, recovers the original operation
through the existing control, completes through the actual native Goal tool,
publishes one answer and preserves exact completed Task, Goal and history state
over restart. No production SQL fixture routes are installed in these runs.

Goal reads can reject a stale observation during reconnect. The harness records
actual 409 responses and retries only those reads within its existing deadline.
It does not retry execution. Its restart snapshot follows actual Goal reads,
which synchronize the protected Task projection, and retains exact comparisons.

The focused repository matrix passes 204 paired observations and six restart
snapshots per store, across all three stores. It covers active and historical
inputs, assigned and native publishers, legacy terminals, changed ciphertext,
IDs and keys, child/stale namespaces, owner/worker/lane/fence rejection and
autonomous Goal cycles. Actual SQL exceptions at terminal writes roll back the
appended answer and terminal metadata together; the same response succeeds after
the failing trigger is removed.

Current-schema comparison passes all sixteen embedded graphs/provider maps.
Focused TypeScript tests and the Task-input native wire oracle pass. The broader
protocol tests reproduce stale export/discriminator expectations on clean
Primary. The broad wire oracle also lacks fixtures for newer model-operation
roots, and the outgoing command corpus omits newer discriminators; direct clean
Primary oracle calls reproduce both failures. These suites are not green.

The standard `pnpm check` stops at existing Node decomposition budgets. The
changed turn runtime is smaller than the baseline; downstream aggregate checks
remain unrun. Development validation is local, with GitHub Actions reserved for
releases and deployments.

The final optimized executable passes the same ten worker-loss cases, with
fifty model requests total, and the six existing Task and Agent/Task product
suites across all three stores. Its SHA-256 is:

```text
fc672af50d6e0d9681a274654711d534a3e0b4fee1720fa33ac8f5f8527c5105
```

The broader Goal repository suite passes 367 paired observations and ten restart
snapshots per store, including the focused corpus above. Strict all-target
Clippy passes. Broader comparison also corrects Rust's partial captured Chat
row and null-versus-omitted private observation field. The stale-read case now
requires the current explicit conflict and verifies the newer Task is preserved.

This evidence does not complete supported-platform,
packaged-update, historical-profile, performance or full replacement acceptance.
No Winterhold production deployment is performed.
