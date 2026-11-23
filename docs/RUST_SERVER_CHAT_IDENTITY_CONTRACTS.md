# Current Chat and model identity contracts

Rust remains the default server. This milestone repairs three observed
compatibility differences and qualifies current queued prompts, model identity,
Chat execution and Plan HTTP behavior. Full replacement acceptance remains open.
The source baseline is `d9f45c49bf4ca42aefb3abf318d75f76e052b448`.

## Reproduced production differences

- An empty optional model-operation route selector means no selector in the
  reference. Rust previously searched for the empty route ID and returned null.
  Both embedding and decision operations now preserve the reference behavior.
- An offline project worker makes Plan PATCH return HTTP 503 with
  `Project worker is offline.` Rust previously returned HTTP 409 with its internal
  command-bus error. Plan GET now also skips native refresh while the worker is
  offline, preserving stored opaque history. The connection check uses the
  coordinated command bus so remote worker connections remain supported.
- Resume identity normalizes a missing runtime provider account to null while
  preserving a missing context account. Rust previously considered two missing
  account fields equal. Explicit missing/null cases now match the reference.

The three failing baseline reports and their exact native helpers are retained.
The repairs do not change the protocol or add a database migration.

## Executed matrix

| Paired observations                       | PGlite | Private PostgreSQL | External PostgreSQL | Total |
| ----------------------------------------- | -----: | -----------------: | ------------------: | ----: |
| Model identity and inference catalog      |     39 |                 39 |                  39 |   117 |
| Queued prompts through the actual facade  |     84 |                 84 |                  86 |   254 |
| GUI execution and runtime collaborators   |    702 |                702 |                 714 | 2,118 |
| Configuration/Plan HTTP, three auth modes |    293 |                293 |                 293 |   879 |
| Total                                     |  1,118 |              1,118 |               1,132 | 3,368 |

All twelve reports pass with zero-exit driver receipts. They retain 765 paired
SQL snapshots, real migrations, actual database reopen, ownership, revisions,
native fences, recovery, attribution, encrypted payload and clock assertions.
The external PostgreSQL suites include additional lock races. GUI totals include
helper vectors and controlled runtime collaborators; they do not represent that
many independent full-product flows.

The HTTP matrix covers none/password/accounts authentication on all three stores.
Plan cases exercise successful mode writes, exact opaque reads, validation,
ownership, authentication/CSRF, native refresh/write failure, invalid native
thread replies, retained history and actual worker disconnect. Each cell verifies
four matching `chat-plan` Live invalidations with exact Chat scope and null
payload. The actual worker WebSocket requests are recorded; runtime replies are
controlled at the worker boundary.

The unflagged optimized macOS arm64 package is rebuilt after all three Rust
repairs. A separate comparison launches that executable and the built reference
distribution against isolated external PostgreSQL databases, without SQL test
HTTP routes. Three real HTTP requests verify offline opaque Plan reads, exact
503 write behavior and unchanged SQL history. Both processes exit cleanly.
This production probe qualifies the offline Plan regression; it is not a new
whole-product or supported-platform acceptance run.

## Current fixture reconciliation

Some old fixture assumptions had drifted from both implementations. Standalone
Chats now select their model route before protected native admission, and queued
standalone execution retains a real managed claim at the controlled turn
boundary. The fixture now prepares that actual context and verifies claim/input
identity, ordering and absence of premature success events. Task legacy queue
behavior retains its separate assertions.

Both servers return the stored encrypted message and republish its event on
append replay. The comparison now asserts that exact result, unchanged SQL state
and identical publication rather than expecting a rejection. Independently
generated protection IDs make exact payload digests differ across isolated
peers: each digest is first recomputed from its actual schema-validated payload
and asserted, then related for comparison. Raw payloads, IDs and hashes remain in
the reports. Generated label-operation UUIDs retain their format, stable identity
and non-aliasing checks. Original failed attempts are archived, not counted as
passing acceptance.

## Coverage and limitations

[The machine-readable summary](security/rust-server-chat-identity-acceptance.json)
records report hashes and positive case indices for 26 additional current
file-plus-method repository identities. These include eleven queued-prompt
methods, five model/catalog queries, four Plan methods, routing, attachment,
worktree and model-configuration operations, and two telemetry writers. Void
telemetry writes have subsequent nonempty SQL-row proof; Plan writes retain exact
readback and publication proof.

The ledger now maps 304 of 370 repository identities, scoped operations on
107 of 135 tables, 523 of 584 routes, 115 of 323 worker commands and 25 of
47 Live resources. The added table scope covers inference catalog membership and
configuration revisions plus actual write/reopen behavior; it does not establish
a new concurrent MVCC-race result. The two Plan commands qualify this server
producer through actual WebSocket dispatch and controlled replies.

The remaining 66 repository identities, 28 tables, 61 routes, 208 worker commands
and 22 Live resources require evidence reconciliation. Unmapped entries are not
confirmed missing implementations. Partial historical entries and the original
goal requirements still need their final audit and artifact alignment.

Local validation passes 85 Rust library tests, strict all-target Clippy, 278
script tests with one Windows-conditional skip, reference build, targeted
formatting and diff checks. Previously reproduced whole-repository worker/app
failures remain documented in [Node retirement](RUST_SERVER_NODE_RETIREMENT.md).
The current milestone adds no full worker, UI, decryption or Linux/Windows claim.
The worker remains Node; crate extraction and its replacement are separate work.

Raw passing and failed reports, owned database roots, three baseline helpers,
current helpers, source and the final native package are retained in the local
`rust-server-chat-identity-delivery-20261109-v1` archive. Owned cleanup follows
independent verification. Development validation runs locally; no hosted Actions
or production Winterhold deployment is performed.
