# Current Alert and layout compatibility

Rust remains the default server. This milestone fixes repeated Alert Inbox query
parameters and qualifies successful Goal/AI Alert HTTP, Live notifications and
legacy layout repository operations against the current development reference.
The complete server replacement remains open.

The baseline is `f09d444c8b35d72fa33f7dd09f3177881f2ab011`. Unflagged
`pnpm package:server` produced the macOS arm64 native candidate `1.1.2789`.
Its 93,622,544-byte executable has SHA-256
`e8cb667505b1c5b4833cd702862bd0f56afc62682fbb0d7e9a51a1a10e79677f`.
The manifest identifies Rust and `serverRequiresNode: false`.

## Executed matrix

| Comparison                        | PGlite | Private PostgreSQL | External PostgreSQL | Total |
| --------------------------------- | -----: | -----------------: | ------------------: | ----: |
| Populated Alert/Goal HTTP pairs   |    133 |                133 |                 133 |   399 |
| Paired Alert Live invalidations   |     18 |                 18 |                  18 |    54 |
| Layout repository cases           |    107 |                107 |                 107 |   321 |
| Paired layout SQL state snapshots |     10 |                 10 |                  10 |    30 |

Each Alert storage mode runs anonymous, password and account authentication. Real
HTTP enrolls a worker and issues its credential. Development-only SQL adapters
seed resource rows; production handlers and repositories process subsequent
requests. The scenarios compare populated pages, ordering, cursor binding, Goal
snapshots, revision fences, AI Alert replay/resolve, credential revocation and
actual App Live notifications. Account tests also assert another owner's HTTP
denials, empty counts and absence of Alert publications.

The nine cells restart both servers and compare exact raw Alert SQL state within
each peer before and after restart. All 36 server generations exit zero without
a signal. This tests 18 actual restarts, not process restart simulations.

Opaque envelopes are controlled fixture values. Tests preserve their exact bytes,
scope and defaults, including the omitted Goal `reasoningEffort` becoming null.
These scenarios do not execute a full worker, UI or client decryption. Actual
owner-bound public Alert hashes are independently verified before relating
identities between isolated account databases; raw IDs remain in the reports.

The layout matrix uses actual reference/native repository adapters and real
stores. Original ownership, revision, topology and SQL-trigger rollback
assertions remain intact. It exercises pane titles and ordering, legacy ordering,
members, dock presentation, split/resize/move, launcher pins, surface open/close
and built-in surface worktree bindings. Seeding a project does not qualify its
separate creation API.

## Production fix and additional artifact checks

The original Rust `HashMap` query extractor discarded repeated names. A real
request with `limit=1&limit=2` reached missing-project lookup and returned 404;
the reference correctly returned a validation error with status 400. Rust now
uses the existing compatible query parser, preserving arrays for validation.
Regression tests include duplicate limits, duplicate cursors and encoded names.

The optimized production executable separately passes the existing Alert Inbox
HTTP/header/error suite in all three authentication modes, with the new duplicate
query assertions. A separate external-PostgreSQL run exercises production Goal
and scoped agent Alert operations through both packaged servers without SQL test
routes.

Three additional paired production cases use a real connected worker socket.
A valid retired-generation report returns the same `retired-worker` result;
mismatched thread IDs fail schema validation before generation admission in both
implementations. The suspected handler-order discrepancy required no code change.

Local verification also passes 85 native library tests, strict all-target Clippy,
and 278 script tests with one Windows-conditional skip. Historical unrelated
worker/app/format failures remain documented in
[Node retirement qualification](RUST_SERVER_NODE_RETIREMENT.md); this milestone
does not claim a green whole-repository check.

## Evidence and remaining acceptance

[The machine-readable summary](security/rust-server-alert-layout-acceptance.json)
records report hashes, counts and successful case indices for 14 current
file-plus-method repository identities. The ledger adds those identities, four
Alert routes, the scoped `project-alert` Live producer and operations on seven
tables. It now maps 241 of 370 repository identities, 102 of 135 tables, 521 of
584 routes and 25 of 47 Live resources. Worker command mappings remain unchanged.

There are still 129 unmapped repository identities, 33 tables, 63 routes,
210 worker commands and 22 Live resources requiring evidence reconciliation.
These counts describe unmapped evidence, not confirmed absent implementations.
Table coverage qualifies only the operations exercised here.

Raw reports, original failure attempts, retained fixtures, native helpers, current
and baseline artifacts, and source are archived locally under
`rust-server-alert-layout-delivery-20261109-v1`. Earlier failures include fixture
identity/default assumptions, incomplete staged PostgreSQL libraries and a
package/test output collision; passing reruns retain the original assertions.
The complete PostgreSQL distribution is staged for successful runs, including
root shared libraries and the manifest-selected bin directory.

This matrix qualifies current macOS arm64 domains and the named production
artifact checks. It does not replace the final supported-platform artifact,
full requirement or complete replacement audit. Development validation runs
locally; this milestone performs no hosted Actions run or Winterhold deployment.
