# Rust read-method compatibility

Rust's automatic `HEAD` routes use the existing `GET` handlers. Eight handlers
previously classified requests by exact `GET` equality and sent `HEAD` into body
validation, creation or observation branches. Actual HTTP comparison demonstrated
wrong statuses and unwanted revision/state updates in stored workspace, power and
desktop operations.

The native handlers now retain the read path for `HEAD`. The worktree catalog
also preserves Source's project-guard exception: a managed-folder catalog allows
`GET`, while `HEAD` retains the existing worktrees-capability 409 response. No
external route or protocol changes are introduced.

CantripOS additionally preserves reviewed public placement errors for missing
attachments, operations and history cursors. An explicit error type carries these
static messages through the existing context chain. Internal SQL, worker and
validation failures retain the generic operation error. A redaction test confirms
that an untyped diagnostic with the same text cannot become a public error.

The comparison exercises all 22 affected read routes with automatic `HEAD`,
owned/foreign/missing records, admitted operations, valid and invalid pagination,
and offline status reads. Each observation retains the response status, body,
content length and security/CORS headers, plus before/after snapshots of all 21
CantripOS and selected project/worker tables discovered in the actual schema.
Ordinary catalog, history and operation reads must leave that state unchanged.
Package and system status routes retain Source's observation-epoch writes; their
complete state transitions are compared between implementations.

The same comparison found two pre-existing Source pagination bugs. Workspace
history bound a JavaScript Date without a column encoder and failed on PostgreSQL.
Package history converted its cursor to an ISO Date string and skipped operations
within the same millisecond. Both Source queries now compare against the persisted,
owner-scoped cursor tuple, matching the native repository's existing approach.
Explicit page assertions retain records separated by microseconds in reverse ID
order. Fixed fixture timestamps preserve all six fractional digits in SQL reports.

## Local evidence

The integrated baseline is `bcc378613`. Original failing reports retain their
older baseline and frozen binary. `.qa/rust-read-methods` contains source and
artifact hashes, complete comparisons, original failures and retained fixture
databases. No guest/container executor is substituted into production code.

All twelve local cells pass: PGlite, external PostgreSQL and private bundled
PostgreSQL with development, password, accounts and standalone-bootstrap profiles.
They contain 3,384 paired read-method HTTP observations and 3,384 complete selected
SQL comparisons. The frozen native fixture SHA256 is
`a5b848c79cb25cc93a36e019349bec02bf67854580ecc82db948d6d3e53b027d`.

Qualification independently rechecks every expected scenario, response and SQL
snapshot in each retained complete cell. Earlier matrix reports retain their
standalone fixture startup failure; successful standalone runs supply those three
cells. The canceled PGlite comparison and its process sample remain retained;
that process attempted to format a large account-ID row-order diff. Corrected
PGlite profiles pass separately. Table rows are canonicalized after identity
normalization, while public result order and nested JSON arrays remain exact.
No canceled, incomplete or failed cell is counted as passing.

Existing Node CantripOS tests pass all seven selected tests. The worktree guide's
focused app tests and the production client build pass. Its Source server tests
retain one standalone-Chat admission failure (59 pass), and worker tests retain
two model-capacity expectation failures (92 pass). Those same failures were
reproduced on unchanged Source in the preceding milestone; this lane also retains
Source byte identity and current local results. `pnpm check` still stops at the
unchanged server line budgets, 1532/1500 and 2336/1999. These checks are not green.

An earlier native repository test encountered an incomplete shared PGlite runtime
cache. Its failure is retained; the final retry uses an isolated runtime directory.
All eight existing native CantripOS/repository mutation, recovery and restart
tests pass, including actual PostgreSQL and native PGlite. The public-error
redaction test, strict all-target Clippy and formatting also pass.

## Reproduction

Build workspace dependencies with Node 24, retain one Cargo cache and disable
incremental compilation:

```sh
pnpm --filter '@cantrip/server^...' --filter '@cantrip/worker^...' run build
node --import tsx scripts/server-rust/read-method-http-compatibility.mjs --database pglite --report /tmp/read-methods-pglite.json
CANTRIP_TEST_POSTGRES_BIN_DIR=/path/to/postgres/bin node --import tsx scripts/server-rust/read-method-http-compatibility.mjs --database postgres --report /tmp/read-methods-postgres.json
CANTRIP_TEST_POSTGRES_BIN_DIR=/path/to/postgres/bin node --import tsx scripts/server-rust/read-method-http-compatibility.mjs --database bundled-postgres --report /tmp/read-methods-bundled.json
```

`CANTRIP_RUST_SERVER_BINARY` can select a frozen HTTP SQL fixture. For a historical
binary, `--observe-differences` records differences and state changes without
claiming passing qualification. Each runtime has its own PGlite runtime directory.
All development validation is local; GitHub Actions is reserved for releases and
deployments.

Full guest/worker execution, supported-platform artifacts, data upgrades,
post-write rollback, Redis/mixed operation, desktop packaging and representative
Winterhold deployment remain required for the replacement goal. Node remains the
default server and the worker remains Node.
