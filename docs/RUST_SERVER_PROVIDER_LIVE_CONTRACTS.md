# Provider authentication, quota and inference delivery

Current Node/Rust comparisons pass on PGlite, private PostgreSQL and external
PostgreSQL, each with anonymous, password and account authentication. The batch
repairs public SQL-error projection drift and qualifies seven worker-command
identities plus the provider-auth and settings Live producers. The server
replacement remains incomplete.

## Executed evidence

Tests run locally on macOS arm64 from base
`69f604a91565a9a4abd9e495a339e68482737abe` with the Rust diagnostic repair.
Account, device-auth and quota suites run the frozen production server executable.
The inference suite uses the production router with disposable SQL fixture
endpoints for runtime preservation and complete-row observations. Reference
shutdown in the device-auth suite retains its existing opt-in notification and
repository drain instrumentation; native shutdown uses production behavior.

| Observation                                                    | Count |
| -------------------------------------------------------------- | ----: |
| Paired database/authentication cells across four suites        |    36 |
| Paired HTTP case observations                                  | 2,115 |
| Received account capture/purge/clear commands                  |   180 |
| Received device-login start commands                           |   672 |
| Received quota/read-reset commands                             |   504 |
| Received inference configuration commands                      |   126 |
| Provider-auth Live events across both peers                    | 1,026 |
| Settings Live invalidations across both peers                  |   270 |
| Rejected owner acknowledgements followed by recovered delivery |    18 |
| Exact complete provider-row reopen comparisons                 |    18 |
| Traced HTTP requests, including setup and polling              | 4,987 |

The four suites each pass nine storage/authentication cells. Account cases are
82/79/80 per peer for accounts/anonymous/password; device-auth cases are 94/92/92,
quota cases are 53/52/52, and inference cases are 10/9/10. Counts above include
both peers where explicitly stated; paired HTTP counts count one side of each
comparison. Actual raw commands, publications, failures and stored rows remain
in the reports.

## Compatibility repair

Actual NUL worker selectors produced different public database-error text.
Rust's error projection omitted the reference schema's `project_goal_generation`
worker column. The provider diagnostic projection also lacked
`connection_revision` and `inference_catalog_created_revision`. The serialized
projections now match the actual reference. Database operations are still
attempted; the change does not introduce a startup or query preflight.

Original all-store failures, pre-repair binaries and source are retained.
Separate reference-fixture failures exposed a stale exact provider-query
whitelist, missing password-mode foreign users and an obsolete password CSRF
expectation. Their repairs retain foreign-owner rejection and require 403 for
authenticated CSRF-free device-login mutations.

## Account, device and quota effects

Existing assertions remain for protected account labels, credential revisions,
capture/purge, committed credential clearing before worker cleanup, rejected
account/binding writes, foreign ownership, caller disconnect and retained
shutdown/restart outcomes. Complete compared account command DTOs retain their
raw arrival order; comparison only sorts independent account/type operations.

Device cases retain successful, invalid, failed, held, concurrent and
disconnected requests, original status timestamps/expiry, notification identity
and sequence checks, strict monotonic Live revisions, rollback and shutdown.
Raw command recording now precedes the device scenario handler so actual
`codex.auth.login.start` requests are retained with their original observation
IDs. Device publications are compared in order except the existing explicit
pairing of concurrent requests for distinct accounts.

Quota cases retain actual read/reset command DTOs, account ownership, CSRF,
idempotency, durable state, SQL failures, caller disconnect and shutdown checks.
Settings invalidations retain current-user scope; foreign account subscribers
must not receive another owner's events.

## Inference scheduling and acknowledgement

The current reference explicitly coalesces configuration delivery and returns
after scheduling it. The old shared fixture incorrectly required delivery to
finish before the HTTP response. Its original failures remain retained.
The revised comparison waits for actual delivery while preserving the existing
limit/revision and exact active-runtime preservation assertions.

The worker fixture now applies catalog revisions through the unchanged
`WorkerInferenceAdmission.configureCatalog`, matching the production worker,
and projects the actual connection generation in its acknowledgement. Tests
check acknowledged owner/server/worker identity, connection generation, catalog
revision and pool limits/revisions.

A separate held-reply test proves that saving limit 4/revision 4 completes while
the worker acknowledgement is still blocked. The released reply deliberately
names a different owner. Both servers reject it, retry, and deliver the saved
configuration to the actual admission class. The complete provider row is then
read, the worker and server close, and a fresh repository observer must read the exact
same raw row before any clock normalization.

These are controlled worker facts and runtime RPCs. They do not perform real
provider OAuth, native model inference, or worker credential-file operations.

## Reproduction and remaining work

Build the reference and workspace packages, supply the existing native frozen
binary and database-runtime overrides, and run each suite:

```sh
node --import tsx scripts/server-rust/provider-account-http-compatibility.mjs \
  --database pglite --keep-fixture --report /absolute/path/accounts.json
node --import tsx scripts/server-rust/provider-auth-http-compatibility.mjs \
  --database pglite --keep-fixture --report /absolute/path/auth.json
node --import tsx scripts/server-rust/provider-quota-http-compatibility.mjs \
  --database pglite --keep-fixture --report /absolute/path/quota.json
node --import tsx scripts/server-rust/provider-inference-http-compatibility.mjs \
  --database pglite --keep-fixture --report /absolute/path/inference.json
```

Repeat with `bundled-postgres` and `postgres`. Each suite runs all three
authentication profiles by default and accepts `--profile` for focused checks.
The [acceptance record](security/rust-server-provider-live-acceptance.json)
binds exact report pointers, received command indexes, raw reopen proofs and
source/report/trace/executable hashes. Complete evidence is retained in the
external `rust-server-provider-live-delivery-20261110-v1` archive.

Rust formatting, strict all-target Clippy and all 86 Rust library tests pass.
All seventeen generated schema graphs/maps match. The required `pnpm check`
retains 744 passing worker tests, two capacity/backoff failures and two unhandled
errors. Both failures reproduce on clean Primary at the same base with
byte-identical worker/test files. Full formatting reports twelve unchanged
Primary files; neither aggregate check is claimed to pass.

The ledger now accounts for 261/323 worker commands and 42/47 Live resources,
including partial scopes. All 584 HTTP identities, 370 repository identities
and 135 durable table identities retain their existing scoped mappings.
Remaining Live identities are chat-goal, chat-queue, explorer-filesystem,
inference-progress and server. Remaining commands, other consumers and
historical partial scopes, broader interruption/coordination, and final current
supported-platform/product/shipping acceptance remain required. The worker
remains Node. No GitHub Actions development run or production Winterhold
deployment is performed.
