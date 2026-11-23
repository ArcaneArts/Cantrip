# Current foundation compatibility reconciliation

Rust remains the default server. This reconciliation updates the development
comparisons for current provider behavior and replaces historical missing ledger
entries with explicitly scoped evidence. The complete replacement remains open.

The source baseline is `d45fdd2488e84a305f761e472cd2fd4ba6849e4b`. Unflagged
`pnpm package:server` produced the macOS arm64 native candidate `1.1.2788`.
Its 93,801,616-byte executable has SHA-256
`0e20785cd0246cbd9cbafa5ced8f3294a9d442e984238cc78a7ba5721d3fa018`.
The manifest identifies Rust and `serverRequiresNode: false`.

## Executed matrix

| Comparison                              | PGlite | Private PostgreSQL | External PostgreSQL | Total |
| --------------------------------------- | -----: | -----------------: | ------------------: | ----: |
| Authentication, eight profiles          |    361 |                361 |                 361 | 1,083 |
| Account security, four profiles         |    387 |                387 |                 387 | 1,161 |
| Policy repositories                     |     62 |                 62 |                  62 |   186 |
| Settings repositories and collaborators |    788 |                788 |                 788 | 2,364 |
| Total paired observations               |  1,598 |              1,598 |               1,598 | 4,794 |

Authentication and security launch the packaged production executable through
real HTTP. They retain cookies, identity, mobile sessions, opaque envelopes,
actual client crypto, authorization, revocation and audit assertions. External
PostgreSQL additionally passes same-database Node/Rust/Node session and encryption
continuity. Those shared-database checks do not apply to the physically separate
PGlite/private stores; upgrade and rollback evidence remains separately scoped.

Policy and settings comparisons use disposable native adapters of the production
repositories and real migrations. They compare actual SQL state, transactions,
ownership, revisions, failures and retained state. Worker/provider responses are
controlled in these repository comparisons. They are not full-worker product or
cross-platform package acceptance. All six repository runs exit zero without
cleanup failures.

Current project-alert foundation tests also pass: 19 reference tests and four
native tests on actual private PostgreSQL. They qualify projection, interaction
and workflow behavior, not a populated successful HTTP inbox scenario. The current
script suite passes 278 tests with one platform-conditional skip; the reference
build and reference typecheck also pass locally.

## Preserved and extended assertions

- Provider metadata rename retains its attached thread; changing the connection
  detaches it. Both behaviors have exact state assertions.
- Seeded legacy catalog IDs are checked exactly. New identities retain UUID,
  stability and non-aliasing assertions.
- Unsupported-provider rejection uses an account provider. OpenAI-compatible
  worker discovery has a separate offline catalog case and the complete existing
  worker-selection matrix.
- Catalog transfer IDs are validated and related before comparison. Remaining
  command deadlines must fit the actual operation's elapsed time. Raw commands
  and elapsed measurements remain in the reports.
- Public OpenRouter requests require `output_modalities=all`, exclude credentials
  and discard the supplied query/fragment. Equal normalized endpoints share the
  cache; a different path on the same origin has an independent request/catalog.
- Runtime composition uses a real Fastify instance and closes it, including the
  registered shutdown hooks, instead of an obsolete route-registration stub.

The retained reference had a separate PostgreSQL defect: model deletion placed
a raw JavaScript `Date` into a Drizzle SQL template without a timestamp encoder.
The postgres.js driver rejected it before executing the query. The original
reproduction preserves both the exception and unchanged SQL state; Rust already
performed the operation successfully. The reference now binds an ISO timestamp.
No production Rust behavior changed to match that reference failure.

The corrected comparison requires foreign deletion to return false without
changing either owner's state. Successful deletion must remove both routes,
clear the selected model and its paired custom override, and retain the other
owner's selection. A separate external-PostgreSQL reproduction checks another
owner with a nonempty custom selection before and after the reference repair.

## Coverage and retained evidence

[The machine-readable summary](security/rust-server-foundation-acceptance.json)
identifies the twelve reports by SHA-256 and supplies actual case indices for
68 additional repository identities. Existing 159 overrides now use the current
reference file plus method name. This distinguishes `tab-layouts.get` from
`project-automations.get`; a matching method name alone is insufficient.

The ledger now maps 227 of 370 repository identities and operations on 95 of 135
tables. The added provider-route membership row remains partial: this matrix
compares no-route and foreign lookups, and its positive attached-route case still
needs reconciliation. Table evidence does not qualify every domain consumer.
There are still 143 unmapped repository identities, 40 tables without mapped
operation evidence, 67 routes, 210 worker commands and 23 Live resources requiring
ledger reconciliation. These are evidence gaps, not a count of confirmed missing
Rust implementations.

Raw reports, failure attempts, fixtures, current artifacts and source are retained
under the local evidence directory
`rust-server-foundation-reconciliation-delivery-20261109-v1`. Failed attempts
include a version mismatch, stale fixtures, a corrected fixture-label typo and
the original reference timestamp failure. They are not counted as passing.

The previously reproduced worker/app assertions and formatting failures remain
visible in [Node retirement qualification](RUST_SERVER_NODE_RETIREMENT.md). This
milestone does not claim a passing whole-repository check. Final requirement,
domain and supported shipping acceptance remain required. Development validation
runs locally; no hosted Actions run or Winterhold deployment is performed.
