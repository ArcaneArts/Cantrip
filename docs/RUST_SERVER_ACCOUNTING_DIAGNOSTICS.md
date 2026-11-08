# Native account-usage diagnostics

The accounting services now use the shared native server logger instead of bare
stderr JSON. Their records reach the existing minimized buffer, filesystem
archive and console formatter. Node remains the default server; the worker
remains Node and full replacement acceptance is incomplete.

## Behavior

Storage reconciliation emits its start, successful completion, unavailable lease
and failure records. History maintenance emits completion, unavailable lease and
failure after refreshing operational totals. Their operation names, levels,
statuses, durations, counts and decimal string fields follow the reference.

The bandwidth meter captures successful and idempotent flushes, failed writes,
observer rejection, buffer capacity and publication callback failure. Observer,
capacity and write failures use the reference's shared process-level rate-limit
keys and default policy. Callback failure remains a warning after the durable
flush succeeds. Error details pass through the existing sanitizer and persisted
minimization; private database error text is excluded from stored records.

The change preserves accounting state ownership and existing clocks, timers,
in-flight sharing, receipts, retries and shutdown drain. Background completion
statistics still update before callbacks or totals: a follow-up error can retain
a committed result and count both a completion and failure. Flush logging keeps
the original owner count while publication uses the filtered notifying owners.
Production constructors select the shared logger; clock/logger injection serves
the executable reference comparison.

## Executed comparisons

The preceding production archive was independently verified before its original
fixtures were removed. Its retained report reproduces accounting lifecycle
records from Node on all three storage modes and zero persisted accounting
records from Rust. Relevant accounting sources are byte-identical between that
artifact's base and this milestone's base. The earlier Node bundled-store run
closed before history maintenance completed; that observation is retained.

The new library comparison executes the actual Node accounting classes and
shared logger across 88 steps. It compares full sanitized records, minimized
records, operation/callback/log order, counters, retained results and complete
flush batches. Cases include lease contention, repository and follow-up failure,
retry, idempotent replay, notification filtering, large decimal values, capacity
drops, observer/publication failure, rate summaries, window rollover and closure.
All eighteen focused native accounting tests pass, including the existing
asynchronous cadence, pending-delta, receipt and shutdown tests. Controlled
repository replies isolate these producer semantics; they do not substitute for
production database testing.

The local debug production comparison passes forty Node/Rust process runs.
Nine storage/authentication pairs cover native PGlite, managed private PostgreSQL
and external PostgreSQL with none/password/accounts authentication. An actual
console record establishes completed startup history maintenance before normal
requests. All eighteen normal accounting peers retain the expected four-record
startup/final-flush sequence, compared after timestamp/cursor/duration
normalization. Both Node PostgreSQL reference modes use separate disposable
PostgreSQL databases; the native bundled mode starts its managed postmaster.
The suite also retains database refusal/recovery, actual probe acknowledgements,
HTTP parser/console/archive behavior and retained-key cases. It does not assert
that every whole-server record count already matches.

A separate debug production run passes four real external-PostgreSQL processes.
Actual triggers reject bandwidth flush and storage/history lease writes; the
transparent proxy witnesses backend P0001 errors. After trigger removal, the
real minute timers recover both jobs. The three minimized failure records match
exactly between Node and Rust after timestamp/cursor/duration normalization,
including error classification. Original server identity survives restart.

The restarted processes use their normal sixty-second flush interval. SIGTERM
starts final flush while a private administrative transaction holds an exclusive
lock on the receipt table. Actual backend queries and blocking PIDs establish
that shutdown is waiting on that transaction. After release, each server commits
one additional receipt, captures flush/shutdown completion and exits zero. This
does not substitute an artificial timer or successful SQL response. The original
harness double-SIGTERM failure is retained; the corrected helper owns one signal
and waits for every independent peer to clean up before closing PostgreSQL.

The optimized macOS arm64 candidate repeats both complete runs successfully:
forty production peers and four fault/restart/shutdown processes, with version
1.1.2768 on both implementations. The executable is 93,881,168 bytes, SHA-256
`950862836b2ff00835464067650ae5d58838ea68e726b1ac236367041de06c17`.
All 78 library tests, strict all-target Clippy, server build/typecheck, sixteen
contract graphs/maps and boundary/workflow audits also pass locally. This is a
current accounting candidate, not the final supported-platform release.

```sh
CANTRIP_RUST_SERVER_BINARY=/absolute/path/to/cantrip-server \
  node --import tsx scripts/server-rust/log-runtime-server-compatibility.mjs \
  --accounting-records --http-records --database-records \
  --database-health-outage --report /absolute/path/to/accounting-production.json

CANTRIP_RUST_SERVER_BINARY=/absolute/path/to/cantrip-server \
  node --import tsx scripts/server-rust/accounting-fault-compatibility.mjs \
  --report /absolute/path/to/accounting-faults.json
```

Build the current reference workspace packages first and supply the native
PGlite assets and PostgreSQL fixture/helper variables used by other production
comparisons. Development validation stays local. The aggregate repository check
stops at unchanged Node budgets 1,539/1,500 and 2,336/1,999; the separate
repository budget is 2,284/2,000. Seven actual source/check inputs match baseline
bytes. Downstream aggregate checks are unrun.

## Remaining acceptance

These comparisons do not establish every accounting/product interruption,
multi-instance lease/recovery boundary or supported-platform artifact. Other
production diagnostic consumers remain to reconcile. Full product/fault/shared
coordination, current desktop/container/Winterhold artifacts, historical upgrades
and post-write rollback, performance, Rust default cutover and production
Node-server removal remain required.
