# Persisted accounting and browser contracts

Current comparisons pass on PGlite, private PostgreSQL and external PostgreSQL
for the six previously unmapped durable tables. The new bindings cover executed
accounting and browser consumers with complete stored rows and reopen checks.
Production Rust behavior is unchanged. All 135 table identities now have scoped
behavioral evidence; complete domain and replacement acceptance remain open.

## Executed evidence

Fresh frozen server and repository executables are built from
`2ac9a08d45a54e9a799bdfd65bb259ef9238b625`. Tests run locally on macOS arm64
with isolated databases. HTTP comparisons use the production Rust executable
and the reference HTTP server; repository comparisons invoke the actual
accounting implementations through disposable IPC adapters.

| Observation                                               | Count |
| --------------------------------------------------------- | ----: |
| Paired accounting repository scenarios                    |   165 |
| Paired complete accounting SQL stages                     |   195 |
| Paired HTTP case observations                             |   504 |
| Complete browser SQL stages across both peers             |    36 |
| Exact raw-state process/store reopen comparisons          |    42 |
| Received browser configuration commands across both peers |    36 |
| Compared browser-related Live events across both peers    |   612 |
| Traced HTTP requests, including setup and polling         | 1,115 |

The accounting suite runs 55 scenarios and 65 complete-state comparisons per
database. Public usage HTTP contributes 33 cases per store, and authenticated
account isolation contributes 14. Browser HTTP passes nine cells: three stores
with anonymous, password and account authentication, respectively 38, 41 and
42 cases per peer. Traffic cases retain their existing exact per-runtime byte
and operation assertions and bounded clock checks rather than comparing wall
clock samples literally between independent runs.

## Accounting persistence

The existing suite now optionally records every column in current storage,
storage snapshots, bandwidth receipts, bandwidth buckets and reconciliation
leases after each actual repository operation. Each stage compares the entire
canonical result across peers. Fixed fixture timestamps remain exact; generated
wall clocks are validated against the actual run before normalization. Original
raw values remain in the report. Large decimal counters retain their existing
explicit string representation, including values above JavaScript's safe
integer range.

Existing assertions cover precise and idempotent bandwidth flushes, missing
owners, UTF-16 owner ordering, lease contention and release, storage
reconciliation, history projection and retention, and real trigger-induced
failure or lease loss. Rejected operations preserve the preceding raw state.
Both repository processes close and reopen their stores; the final complete
raw results must equal the preceding results before any normalization.

The separate public HTTP suites preserve exact shutdown accounting, retained
flush receipts, materialized usage projections, unauthorized access rejection,
owner-specific histories and account sessions across server restart. These
public assertions accompany the direct repository evidence; fixture-seeded
materialized projections retain their explicit scope.

New table bindings are `account_bandwidth_flushes`,
`account_storage_reconciliation_leases`, `account_storage_usage_current` and
`account_storage_usage_snapshots`. Their native implementations are in
`cantrip_server_rs/src/usage/repository.rs` with history maintenance in
`cantrip_server_rs/src/usage/maintenance.rs`.

## Browser and remote-surface persistence

The existing browser suite adds password authentication and CSRF rejection
alongside its original anonymous/account cases. All original public response,
worker-command, ordered-event and tenant-isolation assertions remain.

With `--canonical-state`, it additionally captures every browser, remote-surface
and tunnel column after an actual offline browser-state update and again after
deletion/cleanup. The seeded project/resource fixtures are explicit. Each
observation runs after HTTP server shutdown, closes its repository observer,
opens another process and requires exact raw equality. Server restart then
serves the retained browser catalog through public HTTP. Existing live worker
configuration/failure, committed-state retention, tunnel attachment/update,
deletion and foreign-owner checks continue to execute. External PostgreSQL also
retains the actual sibling-cleanup SQL failure and successful sibling assertions.

The controlled worker receives two actual `surface.configure` commands per
peer/cell, including the existing failure path. Their complete compared DTOs
bind that previously unmapped command identity. Controlled responses do not
execute browser rendering or decrypt private browser content. The full-row
bindings cover `browsers` and the browser lifecycle's `remote_surfaces` writes;
other remote-surface consumers retain their separate qualification.

External PostgreSQL remains running while the observer processes reconnect.
These reopen checks qualify retained data through process/connection turnover;
database crash recovery retains its separate evidence requirements.

## Reproduction and retained evidence

Build the reference server and workspace packages, supply native executable
overrides and the existing database runtime fixture environment, and run:

```sh
node --import tsx scripts/server-rust/usage-repository-compatibility.mjs \
  --database pglite --canonical-state --report /absolute/path/accounting.json

node --import tsx scripts/server-rust/browser-http-compatibility.mjs \
  --database pglite --canonical-state --keep-fixture \
  --report /absolute/path/browser.json

node --import tsx scripts/server-rust/usage-http-compatibility.mjs \
  --database pglite --report /absolute/path/usage-http.json

node --import tsx scripts/server-rust/usage-account-compatibility.mjs \
  --database pglite --report /absolute/path/usage-accounts.json
```

Repeat with `bundled-postgres` and `postgres`. Browser runs all authentication
profiles by default and accepts `--profile` for focused work. Explicit frozen
binary overrides avoid rebuilding executables underneath a running comparison.
The [acceptance record](security/rust-server-persisted-resource-acceptance.json)
retains exact report pointers and source/report/trace/executable hashes.
Runtime assets, complete raw reports and scoped fixture roots are retained in
the external `rust-server-persisted-resources-delivery-20261110-v1` archive.

## Remaining replacement work

The ledger now maps 135/135 durable tables, including partial scopes. Its totals
also account for 254/323 worker commands and 40/47 Live resource types. All
584 HTTP identities remain mapped and all 370 repository identities remain
accounted for. Mapping a table through these consumers does not qualify all its
writers, and these totals do not establish complete replacement.

The required local `pnpm check` retains 744 passing worker tests and two
capacity/backoff failures plus two unhandled errors. Both failures reproduce
on clean Primary at the same base with byte-identical worker/test sources.
Full formatting reports twelve unchanged Primary files. Neither aggregate
check is claimed to pass. Changed-file checks and the independent integrity
review are recorded separately. All seventeen current generated contract
graphs/maps match.

Remaining commands and Live consumers, historical partial scopes, broader
interruption/coordination behavior and final supported-platform, product and
shipping artifacts remain required by the original goal. The worker remains
Node. Development validation is local; no GitHub Actions or production
Winterhold deployment is performed.
