# Current execution and model repository contracts

Rust remains the default server. This milestone qualifies current tunnel,
execution-lane, chat-runtime and settings repositories on all three stores, closes
the positive provider-route membership gap, and binds 37 additional current
repository identities to successful operations. Full replacement remains open.

The source baseline is `4086a41799804618b6a8ade4d066d13aa434dd9b`.
Production Rust and reference TypeScript source are unchanged. Development
adapters are built against this checkout; the previous verified native package
`1.1.2789` supplies staged database assets. This is not a new shipping artifact
or supported-platform qualification.

## Executed matrix

| Paired observations                    | PGlite | Private PostgreSQL | External PostgreSQL | Total |
| -------------------------------------- | -----: | -----------------: | ------------------: | ----: |
| Tunnel catalog, attachments and leases |    311 |                311 |                 311 |   933 |
| Execution lanes and transitions        |    256 |                256 |                 270 |   782 |
| Chat runtime and routing collaborators |    591 |                591 |                 591 | 1,773 |
| Settings and provider collaborators    |    792 |                792 |                 792 | 2,376 |
| Total                                  |  1,950 |              1,950 |               1,964 | 5,864 |

The runs also compare 1,163 paired SQL state snapshots: 438 tunnel, 602 lane
and 123 chat-runtime snapshots. All twelve selected runs exit zero without
cleanup failures. Existing transaction, ownership, revision, credential,
generation, rollback, concurrency and reopen assertions remain in place.
The external-PostgreSQL lane matrix includes additional actual lock races.
Routing and settings observations include helper vectors and controlled worker,
provider and hydration collaborators; the total does not represent that many
independent full-product flows.

Ordinary lane operations now pass through the current reference repository facade
instead of calling its child repository directly. Nested transaction cases keep
their real transaction-bound adapter. This exercises argument forwarding as well
as underlying persistence behavior.

Provider membership now explicitly returns true for both an enabled attached
route and a disabled attached route. Another model owner and a missing provider
return false. These cases close the previously documented positive-lookup gap.

Void mutations have separate SQL-state proof. Relay restart clears the active
attachment's credentials while preserving its active direct lease. Execution
interruption suspends lanes, detaches runtimes and interrupts pending approvals,
with the original Task/Goal and lease assertions retained. Runtime writes link
the active lane and chat to the same actual runtime row. Agent-time analytics
assert exact overlapping intervals: 25,000 agent milliseconds, 20,000 wall
milliseconds and average concurrency 1.25.

## Current endpoint observation policy

The first chat-runtime attempt fails in all three stores because an old test
expects a missing Ollama availability listing to reject routing. Both current
implementations instead return the configured route. The current reference
explicitly treats worker-endpoint listings as observations and allows the
authorized worker to attempt the actual endpoint.

The replacement assertions check exact route, catalog and provider identity with
missing, unavailable, stale, other-worker and available observations. Existing
cooldown checks and OpenRouter global-account-scope rejection assertions remain.
This corrects an obsolete test expectation; no production admission gate or
server behavior is changed. Original failed reports remain in the archive and
are not counted as passing acceptance.

## Coverage and retained evidence

[The machine-readable summary](security/rust-server-repository-contracts-acceptance.json)
records twelve report hashes and successful case indices for each current
file-plus-method identity. It adds 20 tunnel methods, 14 lane methods, two chat
runtime mutations and the agent-time analytics facade. It also records explicit
state proof for void methods and the four provider membership cases per store.

The ledger now maps 278 of 370 repository identities and operation scopes on
106 of 135 tables. The four additional table scopes cover the tunnel catalog,
attachments, direct leases and analytics reads of token usage. Analytics evidence
does not qualify usage ingestion or accounting writes. Other table consumers
remain separately scoped.

There remain 92 unmapped repository identities, 29 tables, 63 routes, 210 worker
commands and 22 Live resources requiring evidence reconciliation. These are
unmapped evidence entries, not confirmed missing implementations. Historical
partial entries and every explicit original-goal requirement still need their
own final audit.

Local verification also passes the current reference build, 278 script tests
with one Windows-conditional skip, targeted Prettier and `git diff --check`.
Previously reproduced whole-repository worker/app/format failures remain
documented in [Node retirement qualification](RUST_SERVER_NODE_RETIREMENT.md).

Raw reports, failed attempts, retained store roots, exact native helpers, staged
runtime assets and source are archived locally under
`rust-server-repository-contracts-delivery-20261109-v1` and independently verified
before owned cleanup. This milestone is current macOS arm64 repository/routing
qualification. It adds no full worker, UI, actual provider, endpoint decryption
or additional platform claim. Development checks run locally; no hosted Actions
or production Winterhold deployment is performed.
