# Worker and provider state contracts

The current Rust server matches the reference in the scoped worker-management
and provider-state comparisons on PGlite, private PostgreSQL and external
PostgreSQL. This milestone adds executable acceptance coverage and evidence
bindings; it changes no production Rust code. The complete replacement remains
unfinished.

## Executed comparisons

The unchanged worker-management suite passes twelve local cells: all three
stores, each with development, password, account and standalone profiles.
Development and standalone use anonymous authentication with different
bootstrap behavior. The new provider-state suite passes nine cells: all three
stores with anonymous, password and account authentication.

Together they retain:

| Observation                                                       | Count |
| ----------------------------------------------------------------- | ----: |
| Paired HTTP observations                                          |   864 |
| Worker-management SQL case observations across both peers         | 1,038 |
| Complete catalog SQL stages across both peers                     |   126 |
| Catalog and provider-test commands received by controlled workers |   288 |
| Accepted worker-inference Live events across both peers           |    36 |
| Traced HTTP requests, including setup and polling                 | 6,126 |

These are local macOS arm64 comparisons against fresh executables built from
`0f2a36e36c9e5107e313a771866c2b2ad63e1ee8`. Each peer uses isolated storage.
External PostgreSQL is a separate local PostgreSQL service, not a production
connection. The SQL-enabled executable uses the production HTTP router with
test SQL access for state observation and fault injection.

## Worker identity and credentials

The existing suite issues real enrollment codes and credentials and checks
their stored hashes against the issued secrets. Full canonical worker,
credential and enrollment-code rows are retained before and after operations.
It covers rename and runtime/display-name behavior, UTF-16 and NUL boundaries,
foreign or missing workers, restart acknowledgments and failures, the actual
ten-second restart deadline, SQL failure during unlink, concurrent unlink,
revocation, rejected old credentials, re-enrollment and restart quotas. Store
reopen retains tombstones, credentials and unrelated project/source state.

The new ledger bindings cover `workers`, `worker_credentials` and
`worker_enrollment_codes`. Successful restart acknowledgments are controlled
worker effects; they do not qualify every desktop supervisor or real worker
process restart path.

## Provider catalogs and durable suppression

The controlled worker receives actual `model.chatgpt.catalog`,
`model.grok.catalog`, `model.ollama.catalog` and `model.provider.test` commands
through the unchanged worker connection. Public HTTP responses and complete
canonical catalog state are compared between implementations. Provider-account
credentials are well-formed fixture envelopes; no real provider sign-in or
model inference is performed.

Four initial model metadata snapshots are retained exactly on identical
refresh. Changing one model creates one additional snapshot. A real PostgreSQL
trigger failure during snapshot insertion rolls back model, snapshot,
suppression, profile and route writes; the separate sync status becomes stale
as in the reference. Worker-reported discovery failure also serves the original
stale catalog and recovers on the next successful command.

Deleting a discovered nondefault model through public HTTP creates a durable
suppression. Refresh, actual worker-connection replacement, server restart and
direct store reopen preserve that suppression and do not recreate the logical
model. Snapshot identities and hashes remain unchanged. Account authentication
also exercises foreign-owner rejection.

Generated identities are not compared by stripping arbitrary UUIDs. Before
normalization, each stored discovered profile and route is verified against its
actual provider-model row, provider identity and native model name. The provider
test command's model and route identities are independently checked against that
same persisted row. Raw commands, SQL stages and identity proofs are retained.
Reopened storage must equal the final raw state before normalization.

The new table bindings cover `provider_model_catalog_snapshots` and
`provider_model_suppressions`; they do not qualify every consumer of those
tables.

## Inference notifications

The existing inference-status assertions run over real HTTP, worker and App Live
connections after server restart. They check private/no-store status responses,
four identity fences, malformed status rejection, accepted revisions 1000 and
1005, duplicate suppression and stale/foreign identity rejection. Exactly two
worker-inference events per peer are accepted. Successful `inference.configure`
acknowledgment is outside this comparison and remains unmapped here.

## Evidence and reproduction

The [acceptance record](security/rust-server-worker-provider-acceptance.json)
binds each new command, table and Live identity to exact report pointers, raw
state hashes and the frozen executable receipt. Final reports, request traces,
runtime assets and the failed fixture versions are retained under
`rust-server-worker-provider-delivery-20261110-v1` in the external QA archive.

Build the reference server and workspace packages, then supply the native HTTP
and repository fixtures and database runtime assets through the existing
fixture environment variables. Run:

```sh
node --import tsx scripts/server-rust/provider-state-http-compatibility.mjs \
  --database pglite --report /absolute/path/provider-state.json --keep-fixture

node --import tsx scripts/server-rust/worker-management-http-compatibility.mjs \
  --database pglite --report /absolute/path/worker-management.json --keep-fixture
```

Repeat with `bundled-postgres` and `postgres`. The provider suite runs all three
authentication profiles by default; worker management runs all four profiles.

An initial observation query incorrectly referenced `provider_models.owner_id`;
the actual SQL error is retained, and the query now joins provider ownership.
Two subsequent comparison failures involved namespaced runtime UUIDs from
isolated databases. Their raw results are retained; the final comparison adds
the explicit identity proofs described above and preserves all public fields.

## Local checks and remaining acceptance

The required `pnpm check` reaches the worker suite with 744 passing tests and
two capacity/backoff failures plus two unhandled errors. Both failing cases
reproduce on clean Primary at the same base commit with byte-identical worker
and test sources. Full formatting reports twelve unchanged Primary files.
Neither aggregate check is claimed to pass. Changed-file formatting and the
final boundary checks are recorded separately in the delivery evidence.

The coverage ledger now accounts for 248/323 worker-command identities,
126/135 durable tables and 37/47 Live resource types. All 584 HTTP identities
remain mapped, including partial scopes, and all 370 repository identities
remain accounted for. These totals measure scoped evidence, not whole-server
completion.

Actual provider/OAuth/native execution, successful inference configuration,
remaining identity and historical partial scopes, broader interruption and
coordination behavior, and final supported-platform shipping artifacts remain
required by the original replacement goal. No GitHub Actions, worker rewrite
or production Winterhold deployment is part of this milestone.
