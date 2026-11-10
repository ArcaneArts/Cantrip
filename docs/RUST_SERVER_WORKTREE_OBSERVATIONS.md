# Current worktree observation qualification

Rust remains the default server. This milestone repairs a missing active worker
notification consumer and refreshes project execution repository evidence.
Full replacement acceptance remains open. The baseline is
`f11ca266a9a33f351d629229f27cffbcdd2ba9ac`.

## Reproduced difference and implementation

The current worker sends `worktree.status.observed` over its authenticated
command WebSocket. Node resolves the worker's stored source/worktree paths,
records the status and metadata, and publishes their changes. Rust previously
ignored that notification. The retained baseline comparison demonstrates one
successful Node snapshot and its two Live events against an unchanged null
Rust snapshot.

The native consumer now resolves the same owned path context, checks the result
path, and invokes the durable status writer. Notification project/worktree IDs
remain hints: publications use the actual stored context. The writer preserves
branch, HEAD, detached/lock state, missing/prunable precedence, the status JSON,
and the shared scan/observation/update clock. It retains the reference's
ordering-sensitive `JSON.stringify` comparison of the real JSONB projection;
the replay case verifies its actual repeated write/publication behavior.

SQL failure retains the prior row and publishes no success event. Successful
commit precedes status publication. An oversized status that is valid on the
worker protocol but exceeds the Live payload limit remains persisted, logs a
bounded diagnostic without the file content, and still publishes the metadata
invalidation. Disabled Live publishing skips publication validation after the
write, matching the reference lifetime behavior. No HTTP route, external
protocol or migration is added.

## Executed comparisons

| Scope                                  | PGlite | Private PostgreSQL | External PostgreSQL | Total |
| -------------------------------------- | -----: | -----------------: | ------------------: | ----: |
| Project/target/runtime observations    |    431 |                431 |                 431 | 1,293 |
| Worker notifications, three auth modes |     39 |                 39 |                  39 |   117 |
| Status actions, three auth modes       |     30 |                 30 |                  30 |    90 |
| Exact scoped Live events               |     54 |                 54 |                  54 |   162 |

The status matrix covers none/password/accounts authentication on all three
stores. It compares exact notification results, stored state, event scope,
entity, action, null revisions and payloads, plus actual observation-configuration
requests and controlled acknowledgements. Each cell includes a failed SQL UPDATE
with unchanged fields/clocks, recovery, a post-commit publication rejection,
and real server stop/start with exact retained state. All eighteen restarts and
thirty-six server exits complete cleanly.

The project/target suite retains owner and worker isolation, removed sources,
GitHub provision selection, bounded observation targets, fenced path updates,
inventory rollback, lifecycle/removal checks, runtime generation/contention,
secret revisions and actual reopen assertions. Its totals include controlled
collaborators and helper vectors; these are not independent full-product flows.
Those existing functions are unchanged by the new status writer.

A separate external-PostgreSQL comparison runs the final optimized macOS arm64
executable, uses a direct SQL client for the disposable test database, and
asserts the SQL test HTTP route is absent. Its real worker WebSocket, Live,
failure and restart checks qualify the packaged consumer. The worker runtime
command replies remain controlled; this is not a full worker/UI or new
Windows/Linux qualification.

## Coverage and remaining work

[The machine-readable summary](security/rust-server-worktree-observations-acceptance.json)
binds seven additional current project facade identities to positive repository
operations and the status facade to the real worker callback. It records report
hashes and case indices. The added source/worktree table entries describe these
specific reads, path/inventory writes and status operations; other consumers
retain their separate acceptance.

The ledger now maps 313 of 370 repository identities, operation scopes on
110 of 135 tables, 523 of 584 routes, 116 of 323 worker commands and 27 of 47
Live resources. These counts include an explicit partial active-Git-operation
projection and table entry. They do not represent full completion percentages.

Historical durable Git-operation reconciliation remains open. Its worker
notification consumer is still active in Node despite the retired plaintext
Git HTTP routes. Native currently has the configuration projection used to
observe active operations; full durable get/update and reconciliation require
implementation and actual comparison. The audit therefore keeps that method
and table partial rather than treating HTTP 410 as retirement evidence.

There remain 57 unmapped repository identities, 25 tables, 61 routes, 207 worker
commands and 20 Live resources, plus historical partial entries and the complete
original-goal audit. Unmapped entries are evidence gaps and may already have
implementations. Final supported-artifact and deployment acceptance remains
separate. The Node worker and shared-crate extraction are outside this milestone.

Local checks pass 85 Rust library tests, strict all-target Clippy and 278 script
tests with one Windows-conditional skip. Existing whole-repository worker/app
baseline failures remain documented in [Node retirement](RUST_SERVER_NODE_RETIREMENT.md).
Raw failed attempts, the exact baseline and current helpers, all owned database
roots, source and the final package are retained in
`rust-server-worktree-observations-delivery-20261110-v1` and independently verified
before owned cleanup. Development validation stays local; no hosted Actions or
production Winterhold deployment is performed.
