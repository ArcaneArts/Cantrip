# Durable Git-operation observations

Rust remains the default server. This milestone implements the active
`git.operation.observed` worker consumer and all seven durable Git-operation
repository methods. Full replacement acceptance remains open. The base is
`67892ac7ed5e173f9592c1c9b339a87d85f0b092`.

The retained real-WebSocket baseline shows Node inspecting a running operation,
completing durable state and publishing six Live events while the previous
native helper leaves it running. Plaintext Git HTTP routes retain HTTP 410;
their retirement does not retire this worker consumer.

## Behavior

The consumer resolves the owned project/worktree, validates its worker and
stored paths, then reads the durable operation. Active operations use the
existing `git.operation.inspect` command and generated worker-state schema.
Immutable context mismatches reject the update. Completed, failed and aborted
records retain their terminal fence and conflict-only replay.

Per-operation pending observations follow the reference fingerprint, timestamp
and bounded registry rules. Reconciliation shares the project FIFO gate used by
HTTP worktree and protected repository mutations. Its lifetime belongs to the
observation service, which drains after the worker bridge closes. An actual
held-inspection test caught an initial shutdown deadlock when background work
was counted in the earlier HTTP drain. The repaired candidate exits without
releasing the held reply, retains exact state after restart, and completes
through a reconnected worker.

Updates preserve pending commits, steps, conflicts, paused actions, completion
and error handling, and JavaScript UTF-16 output truncation. Git state commits
before the status write. A failed status write retains that Git update; a
terminal retry publishes conflicts without inspecting or repeating the write.

Exact operation/conflict publications share a monotonic revision clock. Bounded
payload failure logs a diagnostic and invalidates while retaining accepted
data. Status and metadata events preserve their ordering. Disabled publishing
skips publication validation. No public route, protocol change or migration is
introduced.

## Executed local evidence

| Scope                                    | PGlite | Private PostgreSQL | External PostgreSQL | Total |
| ---------------------------------------- | -----: | -----------------: | ------------------: | ----: |
| Durable Git repository cases             |     50 |                 50 |                  50 |   150 |
| Existing project/target repository cases |    431 |                431 |                 431 | 1,293 |
| Git actions, three authentication modes  |     72 |                 72 |                  72 |   216 |
| Exact scoped Git/worktree Live events    |    213 |                213 |                 213 |   639 |

The nine notification cells cover none/password/accounts authentication on all
stores, duplicate/stale observations, valid foreign-worker routing, path and
lifecycle fences, interactive conflicts, oversized publication, invalid worker
replies, immutable context rejection, real SQL failures, pending coalescing,
held-inspection shutdown, exact retained restart and worker reconnection. All
eighteen restarts and thirty-six server exits finish cleanly.

The final optimized macOS arm64 artifact separately passes all three auth modes
with external PostgreSQL: 72 paired actions, 213 paired Live events, six restarts
and twelve clean exits. Direct SQL clients inspect disposable databases; the SQL
test HTTP route is absent. Worker runtime replies are controlled in both
matrices. These runs exercise actual transport and production callbacks; they
are not full worker/UI or new Windows/Linux qualification.

The relocated `1.1.2793` package passes all three stores, retained writes,
restart, migration/export launchers and shutdown with Node absent from the
server PATH, Homebrew reads denied and artifact writes denied. All 1,762
manifest files are verified. The executable is 93,423,376 bytes, SHA-256
`f646bbd3358f97418291cb707194668a69b0a0ba337ce5c667715fd9c06dc368`.

Local checks pass 86 Rust library tests, strict all-target Clippy, 278 script
tests with one Windows-conditional skip, current native authority checks,
sixteen schema graphs plus the endpoint-provider map, source budgets and
formatting. Broader worker/app baseline failures retain their scope in
[Node retirement](RUST_SERVER_NODE_RETIREMENT.md).

## Coverage and remaining acceptance

[The evidence summary](security/rust-server-git-observations-acceptance.json)
binds all seven facade identities to positive operations on all three stores
and records report/artifact hashes. Active observation configuration now uses
the complete repository mapper.

The ledger maps 319/370 repository identities, operation scopes on 110/135
tables, 523/584 routes, 117/323 worker commands and 29/47 Live resources. These
are evidence mappings, not completion percentages. There remain 51 unmapped
repository identities, 25 tables, 61 routes, 206 commands and 18 Live resources,
plus historical partial entries and the full original-goal audit. Final
supported shipping artifacts remain separate.

Failed attempts, final helpers, owned databases, source and package are retained
in `rust-server-git-observations-delivery-20261110-v1` and must be independently
verified before owned cleanup. Validation stays local; no hosted Actions or
production Winterhold deployment is performed. Worker rewriting and shared
crate extraction remain outside this server milestone.
