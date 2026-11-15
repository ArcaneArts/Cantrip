# HTTP inventory reconciliation

## Current standalone comparison

The macOS ARM64 1.1.3059 standalone archive and the rebuilt Node development
reference matched HTTP status and Content-Type on all 584 inventory routes in
each storage configuration.

| Rust storage mode   | Compared route pairs | Exact response bodies |
| ------------------- | -------------------: | --------------------: |
| PGlite              |                  584 |                   570 |
| Bundled PostgreSQL  |                  584 |                   570 |
| External PostgreSQL |                  584 |                   570 |
| Total               |                1,752 |                 1,710 |

Each mode also passed four exact route error comparisons within the inventory
and four additional worker-capability query cases per peer. All six server
processes exited cleanly and no request returned an unexpected generic Rust
route fallback. The PostgreSQL runs use independently initialized storage. In
the bundled comparison, Rust manages its own PostgreSQL child and the Node
reference connects to a distinct fixture-owned cluster.

The report records 14 runtime-dependent bodies per mode, including generated
IDs, timestamps, counters and versions. The audit checks status and Content-Type
for those routes and retains their bodies for review. This matrix exercises
local startup, absent resource identifiers and empty mutation bodies.
Successful domain operations, authenticated WebSocket upgrades and other
platforms have separate acceptance evidence.
[Current matrix and artifact checksums](security/rust-server-3059-http-database-matrix.json)

The same archive passed 1,083 paired authentication cases across eight
profiles in each storage mode. The external PostgreSQL comparison also passed
17 steps alternating the Node and Rust servers on one database. Those steps
exercise retained accounts, passwords, regular and mobile sessions, and session
revocation after server changes. The reference reported 1.1.3059 in the
authentication runs.

The original inventory audit identified missing Rust HTTP behavior in addition to
historical coverage-ledger omissions. Four lifecycle/preference endpoints now
pass [project-administration qualification](RUST_SERVER_PROJECT_ADMINISTRATION.md),
four more pass [Chat-control qualification](RUST_SERVER_CHAT_CONTROLS.md),
two pass [operational qualification](RUST_SERVER_OPERATIONAL_STATUS.md), and two
pass [worker-log qualification](RUST_SERVER_WORKER_LOGS.md), and five pass
[project-insight qualification](RUST_SERVER_PROJECT_INSIGHTS.md), and twelve pass
[remote-surface qualification](RUST_SERVER_REMOTE_SURFACES.md), and four pass
[computer-use qualification](RUST_SERVER_COMPUTER_USE.md).

The macOS ARM64 1.1.3032 probe returned matching status codes for all 584
declared method/path pairs and found zero generic Rust fallbacks. Both peers
exited cleanly. This run used local PGlite, missing resource IDs and empty
mutation bodies.
[macOS route discovery and performance report](security/rust-server-3032-macos-performance-routes.json)

## Initial discovery

Baseline `898af08e4d87b41dc443288e66b038082b6f6b56` declares 584 routes, 323
worker commands and 135 tables. An isolated local macOS arm64 PGlite run sent
all 584 declared method/path pairs to each current production router. Resource
parameters were absent UUIDs and mutation bodies were empty JSON objects. All
1,168 requests completed and both servers exited zero.

Rust returned its generic route-not-found response on 105 requests where Node
returned another contract. Seventy-two are already-retired repository routes;
33 are active endpoints. Matching invalid-input or absent-resource responses
does not establish successful behavior. This probe also does not compare every
response field, authenticate WebSocket upgrades or qualify other platforms.

The repeatable command uses the built Node reference and native executable:

```sh
CANTRIP_RUST_SERVER_BINARY=/absolute/path/to/cantrip-server \
PGLITE_RUNTIME_DIR=/absolute/path/to/materialized-native-runtime \
  node scripts/server-rust/http-route-inventory.mjs --database pglite \
  --report /absolute/path/to/report.json
```

Build the Node comparison distribution with
`pnpm --filter @cantrip/server-reference reference:build`. The two PostgreSQL
runs use `--database bundled-postgres` or `--database postgres` and set
`CANTRIP_TEST_POSTGRES_BIN_DIR` to the directory containing `initdb`, `postgres`
and `pg_ctl`. The audit retains isolated
profiles, complete process logs, all responses, executable/inventory hashes and
actual exit statuses. Unexpected fallback responses, status and Content-Type
drift, stable-body mismatches and transport or cleanup failures cause a nonzero
exit. Run it locally for development validation.

## Retired repository contract

The native router now registers the 77 routes derived from the existing Node
request policy and explicit Git-agent tombstone. Five GitHub catalog routes
already had the correct prefix rejection; the other 72 previously fell through
to 404. No plaintext repository handler is restored.

General retired requests retain authentication, CSRF and transport checks, then
return the existing 410 before body parsing and API rate limiting. The separate
Git-agent draft endpoint retains normal parsing and its hosted request budget
before its distinct 410 response. General GitHub prefix rejection also applies
to unknown paths and unsupported methods, as it does in Node.

Unsupported methods on known project paths retain ordinary route-not-found
behavior. Their rate keys and audit events use the actual unmatched path,
without a project resource ID inferred from Axum's method-router path. The
initial paired regression caught that audit difference despite matching 404
responses; the native middleware now preserves Node's attribution.

The HTTP comparison checks every retired route, automatic HEAD, malformed and
oversized bodies, unsupported media types, unsupported methods, unknown paths,
authentication/CSRF/origin precedence and actual persisted audit attribution.
A hosted account profile additionally exercises more than 120 malformed
requests to the same retired route, exact per-route Git-agent budget exhaustion,
independent route budgets and Retry-After against the actual first request's
sliding-window bounds. Local deployment disables general API limits; the
initial fixture's contrary assumption is retained as a test-plumbing failure.

`removed-repository-contract.mjs --write` regenerates the embedded route list;
without `--write` it compares the list with current Source. Run both commands
with `node --import tsx`. `removed-repository-http-compatibility.mjs` accepts
`--database pglite|bundled-postgres|postgres`, an optional `--profile` and
`--report`. The PostgreSQL run also includes `hosted-accounts`; use the existing
`CANTRIP_TEST_POSTGRES_BIN_DIR` and `CANTRIP_RUST_DATABASE_FIXTURE_BINARY` inputs
to use a supplied private PostgreSQL distribution and fixture executable.

## Qualified local result

All three final database matrix processes exited zero. Ten profile pairs retain
2,518 matching observations (5,036 Node/Rust responses), selected security/cache/
CORS headers, HEAD lengths and persisted audit attribution. All 20 production
server processes exited zero. The hosted profile additionally retains identical
Git-agent budget sequences; each peer reaches 429 after 116 further 410 replies,
with Retry-After bounded by its actual first request.

| Configuration                                     | Profile pairs | Compared responses |
| ------------------------------------------------- | ------------: | -----------------: |
| Local PGlite, none/password/accounts              |             3 |              1,436 |
| Local bundled PostgreSQL, none/password/accounts  |             3 |              1,436 |
| Local external PostgreSQL, none/password/accounts |             3 |              1,436 |
| Hosted external PostgreSQL, accounts              |             1 |                728 |
| Total                                             |            10 |              5,036 |

Qualified native executable SHA-256:
`78e8e3649f59b86fe65b567ebcdb4c3673ad132bb3447b69cc0f308f9a7f8957`.
That milestone's repeat production inventory run completed all 1,168 requests
with both process exits zero and 33 active fallbacks. The subsequent native
project-administration implementation resolves four, Chat controls resolve
four more, operational health/metrics resolve two, worker logs resolve two,
project/terminal insights resolve five, remote desktops/surfaces resolve twelve,
and computer use resolves four.
The current probe completes the same 1,168 requests with clean exits and zero
generic fallback differences. The inspection command exits zero. Its exact
production executable SHA-256 is
`ef856f33477671eb4adabe05690383a2bbe601a34bd61b8879095a4f19b44d80`.
Earlier discovery and fixture failures are retained separately. This result
does not establish complete response parity or successful product behavior.

Fresh workspace/Node builds, contract comparisons, source/boundary/workflow
audits, strict all-target Clippy, all 76 Rust library tests and formatting/syntax
checks pass locally.
The standard `pnpm check` still stops at unchanged Node source limits:
`build-app.ts` 1,532/1,500 and `chat-turn-runtime.ts` 2,336/1,999. Downstream
aggregate checks did not run. This result does not establish platform/package,
complete-domain, performance or replacement acceptance.

## Remaining acceptance

The probe no longer identifies active generic fallback gaps. Every family still
requires complete behavior, including authorization, persistence, worker commands,
notifications and recovery. A registered path or an invalid-input response alone
does not satisfy those requirements. The last four computer-use rows now record
their implementation and scoped qualification rather than an unported status.

Other category rows and background-service limitations still require
reconciliation. Final platform, migration and rollback, and performance
acceptance are tracked in the coverage ledger. Default Rust selection and
the production Node-server retirement have separate qualification.
[Production Node server retirement](RUST_SERVER_NODE_RETIREMENT.md)
