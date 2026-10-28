# Native server replacement in progress

This crate is the native replacement for `cantrip_server`. It is **not yet a
complete server or a production deployment artifact**. The authoritative coverage
ledger is [`docs/security/rust-server-coverage.json`](../docs/security/rust-server-coverage.json).
Normal desktop and standalone entrypoints still use the Node server until the
remaining domain, execution, transport, migration and delivery milestones pass.

The current implementation includes configuration, the existing SQL migrations,
authentication/sessions, account security and opaque encryption registries, plus
worker pairing, credentials, heartbeat storage and foundational control sockets.
Storage supports native PGlite, private managed PostgreSQL and external
PostgreSQL. The worker remains Node.

Managed-folder provisioning now owns durable setup jobs, worker dispatch,
retry/recovery and shutdown drains. The worker-scoped encrypted repository route
supports private path registration and resolution through the existing client
and worker. The folder suites use both controlled transport outcomes and actual
Chromium APIs with the full built Node worker. See
[`docs/RUST_SERVER_REPLACEMENT.md`](../docs/RUST_SERVER_REPLACEMENT.md) for their
scope and commands. Project/worktree execution, worker encryption refresh,
shared coordination, platform packaging and complete replacement remain in scope.

From the repository root:

```sh
pnpm server:rust:build
pnpm server:rust:check
pnpm server:rust:test
pnpm server:rust:compatibility
pnpm server:rust:auth:compatibility
```

The build prints the native executable path. Run it with `--help` for current
options. `--database pglite`, `--database bundled-postgres`, and
`--database postgres` choose storage explicitly. External PostgreSQL uses
`DATABASE_URL`; private PostgreSQL uses `CANTRIP_POSTGRES_BIN_DIR` during this
development milestone. Existing physical JavaScript PGlite directories are
**not** interchangeable with this crate's native PGlite format; legacy conversion
is still unfinished. Use disposable data for development.

Private PostgreSQL on Unix runs under a native owner mode of this executable.
The owner's parent pipe closes after normal shutdown or abrupt server death;
the owner stops and reaps its PostgreSQL child. New Unix clusters are initialized
in staging before promotion. Windows keeps its kill-on-close process job.
`scripts/server-rust/postgres-lifecycle.mjs` exercises actual process death,
retained account/worker state and external database isolation. Current local
macOS results require fresh platform and packaging acceptance.

## Settings and provider port in progress

Native settings now include preference and destination updates, model CRUD,
ordered routes and reasoning resolution, provider/account/catalog persistence,
usage analytics, Z.ai built-in hydration, Ollama, ChatGPT and Grok discovery, and
quota capture. The shared account flow preserves per-account caching and legacy credential homes,
hidden-model discovery and independently committed quota writes before catalog
reconciliation. Quota events are immutable and deduplicated; account and worker
weekly projections advance independently by observation time. Credit timestamp
writes use the existing driver's millisecond-clipped ISO text semantics.
The native OpenRouter public catalog uses a Rust HTTP client and shared cache.
It preserves stale reads, in-flight deduplication, conditional ETag refreshes,
global metadata persistence, background reconciliation and last-good fallback.
Public requests carry no provider credentials and create no logical models.
Owned fetch and persistence tasks expose a drain for server shutdown integration.
The HTTP client's JSON diagnostics retain V8 positions and UTF16 context. A
focused hyper patch preserves non-UTF8 HTTP reason bytes; its provenance and
license live under `third-party/hyper/`.

Settings/model HTTP routes, the main settings read, and provider CRUD have
actual Node/Rust socket comparisons. Provider connection testing and remaining
settings domains still require their native consumers.
Grok lazily shares one optional public
vision lookup across each account batch. Its diagnostic interface carries the
source rate-limit key, context and options; production logger redaction,
formatting, buffer and archive wiring remain unfinished.

The native runtime hydrator coalesces provider loads, retries false or failed
results, honors explicit invalidation and retains work after a caller stops
awaiting it. Successful providers hydrate once per process. Each call binds its
owner before starting shared work; a retry from another owner binds that caller's
context without changing the owner of work already in flight.

The production server now constructs a catalog composition service backed by the
native Z.ai, OpenRouter, ChatGPT, Grok and Ollama implementations. It preserves
automatic worker selection, connected-default preference and the offline-default
fallback needed by service cache handling. An absent runner retains the provider's
specific error. Successful public loads mark the shared hydrator. Admitted catalog
work survives a dropped caller; shutdown drains hydration, catalog operations,
public fetches and background persistence before closing the database. Actual
source-function comparisons exercise dispatch with real owner/preferences/worker
repositories and controlled catalog services; service internals have their own
repository, worker and public HTTP suites. Worker reconnect hooks and the remaining settings domains are unfinished. Operational event and rate-limit
call sites preserve the source context; the shared production diagnostic logger
still requires its formatting, redaction, summaries, buffer and archive work.

Native catalog GET and POST refresh routes now use this composition layer and
the actual response contract. They preserve built-in discovery, worker cache and
force behavior, account-provider availability errors, fallback after upstream
failure, and retained restart. Repeated worker query values keep their database
text conversion and distinct bridge Map identity: reading a fresh cache can
succeed while a forced refresh treats that array key as offline. Actual SQL
sync-state failures retain the source query context after the real failed write.
Real socket cancellation tests prove that catalog persistence continues without
a replacement worker request from the completion observer. The observer can race
the final sync-state write, so comparisons establish a deterministic current
state only after the independent persistence assertion. Worker reconnect hooks and remaining settings domains are incomplete.

Native legacy provider-credential migration captures only protected envelopes,
checks optimistic revisions and subject identity, and purges worker copies only
when explicitly enabled and acknowledged with the matching committed revision.
Candidate failures return counters without exposing worker OAuth error text.
Sign-out commits the credential clear before catalog and connected-worker cleanup;
partial cleanup produces the source summary and operational diagnostic calls.
Both services retain admitted work when a caller stops awaiting it and expose
shutdown drains. Credential expiry writes use the source driver's clipped ISO
text input, including real PostgreSQL rejection and rollback at year zero.
The server now owns these services for provider-account CRUD and global sign-out,
and drains admitted operations before closing the worker command bus and database.
The remaining runtime hooks and production diagnostics
still require integration. Legacy OAuth capture does not implement PGlite data conversion.

Native account authentication resolves owned account targets, retains default
selection and explicit disabled-account behavior, and prepares global sign-out
by selecting an owned, connected runner. Legacy migration can require the
original worker to reconnect; an existing portable credential permits best-effort
legacy logout. Captured credentials remain committed when later cleanup fails.
Preparation retains its work after caller cancellation and exposes a shutdown
drain. Global account-status projection preserves quota timestamps, credential
state errors and protocol defaults. Reauthentication marking retains the opaque
credential and uses its optimistic revision. Six browser HTTP routes now expose
protected account listing/create/update/order/delete and global sign-out. Account
deletion and sign-out run the actual preparation and lifecycle services; a caller
disconnect does not cancel admitted cleanup or its post-commit Live publication.
Sign-out invalidates settings before publishing safe provider-auth status, scoped
to the requesting owner. Unvalidated legacy body selectors retain JavaScript
truthiness separately from database text conversion and the actual PostgreSQL
driver's boolean parameter inference. Truthy empty arrays cannot select the default
account. Worker reconnect consumers remain unfinished.

The native auth-status GET/HEAD route projects stored account state, selects the
first enabled or explicitly requested account, and can capture an opaque legacy
credential from an owned connected worker. Missing/malformed/failed captures
retain the source status and fixed outward error messages; upstream OAuth details
remain absent. A successful authenticated status starts an owned catalog refresh
without delaying the response. Repeated provider keys retain database text
conversion, while repeated account keys keep strict identity comparison and
repeated worker keys cannot become connected string keys. Real socket tests
verify capture after caller disconnect and protected credential retention across
restart. Device login now creates bounded observations and dispatches the existing worker
command. Safe worker notifications complete sign-in through opaque credential
capture, account/binding persistence, settings invalidation and Live publication.
Generation-checked peer ownership and observation identity are retained before
the first database await. A terminal notification can finish before the login
reply, and an already admitted notification can finish after a later login
removes its map entry. Internal expiry clamping does not change the published
expiry. Observation replacement and the synchronous advancement/publication
steps share one state lock, preserving the source event loop's atomic sections
across Tokio threads. Auth revisions remain ordered through actual Live enqueue.
Paired socket scenarios also exercise simultaneous logins for one account and
parallel publications for independent accounts. Account and worker-binding failures roll back durable writes and retain
the pending observation, with the reference SQL context attached only after the
actual failed query.

Raw device-body worker selectors retain primitive or reference Map identity
separately from database text conversion. Unpaired UTF16 strings cannot route to
a peer whose database ID contains the UTF8 replacement character; the outward
error also retains the original units. The production command bus receives the
original identifier for actual typed owner lookup and preserves account/worker
byte, rate and concurrency accounting before bridge rejection.

The auth HTTP suite exercises actual Live, worker and client sockets, caller
disconnect, observation replacement, safe capture failures, SQL rollback and a
held credential purge during shutdown. The opt-in Node reference fixture drains
its actual notification and repository promises before closing the database.
Uninstrumented Node PGlite shutdown hangs and the insufficient callback-only
drain remain retained failures; this fixture plumbing does not establish the
original server's shutdown readiness. Rust uses its production drains without
instrumentation. Supported-platform and packaged product acceptance remain
unfinished.

The native worker credential GET/PUT routes authenticate the worker's owner,
require its provider-credential grant, and retain opaque envelopes, identity
checks, optimistic revisions and state-specific read errors. Upload parsing
and the actual SQL write preserve the existing failure and rollback boundaries.
Repeated query keys retain the reference drivers' text conversion. The socket
comparison covers account authentication and local development, foreign browser
sessions and workers, revision/identity failures, nanosecond expiry clipping,
restart persistence and worker-credential revocation on all three stores.

The shared command bus enforces owner-scoped concurrency, rate and byte quotas
around the existing native bridge. Admitted requests retain their claims after
their HTTP caller stops awaiting them. Normal, explicitly disabled and custom
deadlines are distinct. Surface/upload accounting primitives are implemented;
their future transport consumers and production logging still need integration.
The Node reference byte counter also charges deeply nested wire JSON after V8
serialization exhausts its stack, closing a zero-byte relay quota bypass. The
same actual-socket regression exercises both servers with a deeply nested
response larger than the configured relay budget.

Run the current domain suites against disposable stores:

```sh
node scripts/server-rust/settings-repository-compatibility.mjs --database pglite --report .qa/rust-server/settings-repository.json
node scripts/server-rust/settings-http-compatibility.mjs --database pglite --report .qa/rust-server/settings-http.json
node scripts/server-rust/provider-credential-http-compatibility.mjs --database pglite --report .qa/rust-server/provider-credential-http.json
node scripts/server-rust/provider-account-http-compatibility.mjs --database pglite --report .qa/rust-server/provider-account-http.json
node scripts/server-rust/provider-catalog-http-compatibility.mjs --database pglite --report .qa/rust-server/provider-catalog-http.json
node scripts/server-rust/provider-auth-http-compatibility.mjs --database pglite --report .qa/rust-server/provider-auth-http.json
node scripts/server-rust/worker-command-http-compatibility.mjs --database pglite --report .qa/rust-server/command-http.json
node --import tsx scripts/server-rust/openrouter-http-compatibility.mjs --timeouts --report .qa/rust-server/openrouter-public-http.json
```

Repeat with `--database bundled-postgres` and `--database postgres`. The worker
fixtures use real HTTP/WebSocket entrypoints with controlled replies; they do
not claim full worker runtime acceptance. Repository service tests invoke the
actual Node services against isolated databases and compare retained state,
cache/offline behavior, refresh failures and retries. Equal SQL sort keys are
avoided in the fixtures; ordered response assertions remain strict. An actual
Node/PostgreSQL maintenance probe also confirms that equal display names can
reverse order without any logical model-field changes. The native query keeps
the same display-name-only ordering as the source.

The native Z.ai catalog embeds generated data from the reference service.
`node --import tsx scripts/server-rust/zai-catalog-data.mjs --check` verifies it;
omit `--check` to regenerate during the migration. Runtime discovery does not
load JavaScript. Native ICU data and its provenance/licenses live under
`third-party/`; distribution artifacts must retain their notices. Current local
settings results do not establish packaged or supported-platform acceptance.

## Worker compatibility evidence

Build the existing shared packages before executing the development harnesses:

```sh
pnpm --filter @cantrip/version --filter @cantrip/logging --filter @cantrip/protocol --filter @cantrip/crypto --filter @cantrip/glitch -r build
node node_modules/playwright-core/cli.js install --with-deps chromium
node --import tsx scripts/server-rust/worker-compatibility.mjs --report .qa/rust-server/worker-pglite-http.json
node --import tsx scripts/server-rust/worker-client-compatibility.mjs --report .qa/rust-server/worker-client-pglite.json
node --import tsx scripts/server-rust/worker-ingress-compatibility.mjs --report .qa/rust-server/worker-ingress-pglite.json
```

Repeat these harnesses with `--database bundled-postgres` and `--database postgres`.
Set `CANTRIP_TEST_POSTGRES_BIN_DIR` to the PostgreSQL binaries used by these
disposable tests. Every external database is created privately by the fixture;
the harness does not use a production `DATABASE_URL` inherited from the shell.

The HTTP/socket suite runs the same cases against the real Node and Rust
servers: pairing, ownership, replacement, credential rotation/revocation,
heartbeat and encryption bootstrap, upgrade validation, v1/v2/legacy readiness,
invalid UTF-8/masking/size rejection, reconnect and command deadline behavior.
The external PostgreSQL development profile additionally holds the actual
credential row lock to exercise 32 authentication slots, 1,024 buffered messages,
8 MiB per socket, a 64 MiB process budget, timeout and last-used writes after
client closure. Fault cases restart the fixture against its retained database
between cases so unfinished owner lookups from one case cannot consume the next
case's handshake slots.

Reference-server shutdown drains worker authentication handlers, including those
whose sockets have already closed, before closing the database pool. Ending the
postgres-js pool while authentication transactions are queued can leave reopened
connections alive after `end()` resolves. Shutdown regression tests cover both
credential and owner lookup completion, including a failed owner lookup. Harness
failures retain fixture identity, completed fault cases and primary errors when
cleanup also fails; the shutdown and authentication deadlines remain unchanged.

The browser suite uses real Chromium with the unchanged app API modules and the
unchanged worker enrollment, heartbeat, `WorkerConnection` and credential store.
Its controlled handler implements credential rotation and rejects other domain
commands explicitly. This proves an authenticated browser-to-worker control
operation and automatic credential reconnect, **not** whole app UI or full worker
runtime acceptance. Reports retain the reference server's background resource
commands separately; Rust does not yet implement those resource domains.

Native bridge tests use paused time for event callback ordering, cleared
deadlines, reconnect continuity, stale sockets, identity changes, grace expiry,
shutdown and one-time completion. They supplement the real transport suite.

Incoming worker text frames now pass through the full generated envelope
contract. Native refinements preserve recursive JSON, encrypted metadata,
UTF-16/UTF-8 limits, timestamp and validation-error behavior. The dedicated
oracle compares 22,700 complete envelopes against the current TypeScript
protocol, including every reachable union alternative. Runtime parsing does
not call JavaScript. The date parser adapts V8 code under the license in
`third-party/V8-LICENSE`; distribution artifacts must retain that notice.

The ingress harness uses each actual router and bridge, unchanged worker
enrollment/heartbeat/transport, and loopback-only test observers. It checks
ordered asynchronous events, response deadline clearing, callback failures,
missing versus null results, opaque JSON/UTF-16 results, notification listener
ordering/removal/reconnect, and continued service after malformed or deeply
nested frames. The shared TypeScript decoder now contains validator exceptions
within the rejected message. These are control-transport tests with a controlled
handler; domain persistence and a full worker runtime remain required.

Outgoing requests now pass through the complete generated command envelope
before admission. Native code applies the 99 additional custom checks, bounded
JSON transformation, Git lazy references, tuples, prefaults and lowercase
normalization. Invalid connected requests retain structured schema issues and
create no outgoing frame, pending request, deadline or request counter. An
offline worker is rejected before command validation, matching the Node bridge.

`tests/worker_command_contracts.rs` streams comparisons against the actual
protocol for all 278 command types, every reachable union option and enum value,
custom-check enclosing fixtures, malformed mutations and large byte/JSON
boundaries. The separate casing oracle exercises every Unicode code point and
unpaired UTF-16 unit. Coverage receipts report actual comparisons and executed
custom callbacks; command schema coverage does not implement command domains.
The HTTP/WS observer also compares rejected admission and normalized Git/GitHub
commands through the unchanged worker connection on all three storage modes.
These controlled handlers echo commands; they do not perform filesystem or
GitHub operations. Current outgoing changes require fresh platform acceptance.

Domain event persistence, binary relays, shared coordination and
resource/execution recovery remain unported. App Live is integrated below,
with incomplete domain publishers and multi-instance support.

`.github/workflows/rust-server.yml` executes native and compatibility suites on
Linux, macOS and Windows. A configured workflow is not passing evidence; record
observed results for the actual milestone head before claiming acceptance.

## Application Live core in progress

The native hub currently implements scoped subscriptions, bounded in-memory
replay, owner cursors, resynchronization, heartbeat/session checks, queue limits
and client-control targeting/acknowledgments. Its actual Node/Rust differential
adapter compares complete emitted messages, closure state, statistics,
publications, control results and effective usage callbacks:

```sh
node --import tsx scripts/server-rust/live-hub-oracle.mjs --report .qa/rust-server/live-hub-oracle.json
```

The current 44 scenarios contain 688 steps, including replay eviction, 128
subscriptions and pending controls, request-history eviction, wrong-peer and late
acknowledgments, revocation, send failures, heartbeat boundaries and JSON edge
cases. Only generated UUID identities are aliased, with their format and
relationships checked. Both adapters cross the same JSON output boundary; the
native runtime starts with a paused, millisecond-aligned clock so timer rounding
does not manufacture protocol differences.

This core is registered as `/api/live`, with session/account registries,
repository scope authorization and real-network/client tests described below.
The core adapter alone does not establish whole-product behavior. Remaining
resource publishers, coordination and full app/worker acceptance are still
required.

## Authenticated quota and reset-credit HTTP

Native GET rate-limit-resets and POST consume routes use the account service and
limited worker command bus. They retain owned-account and ChatGPT/runner checks,
strict request/response contracts, two-minute command deadlines, legacy signed-in
bindings and explicit disabled-account selection. Quota credits and individual
window transactions remain independently committed. A failed GET preserves
earlier commits and exposes the reference query context only after the actual
SQL operation fails. Consume preserves the successful worker result when its
optional snapshot cannot be saved. Reauthentication marks the current opaque
credential through its revision check without clearing it or incrementing its
revision. Admitted operations survive client disconnect and publish only owned
settings invalidations.

Socket pre-close and final bridge shutdown are separate phases. Active HTTP
requests retain the normal worker disconnect grace before bridge/database owners
are finally drained. The quota suite compares a held command during actual
shutdown with an explicit HTTP `Connection: close` request. Its original Node
keep-alive experiment returned the expected failure after the grace but then
hung with an idle HTTP connection until the thirty-second fixture kill. That
failure is retained; the explicit connection-close comparison does not claim
that the original Node keep-alive shutdown path is healthy. Whole-product and
packaged shutdown acceptance remain required.

Windows PR 2292 CI found 279 OpenRouter normalization mismatches immediately below
a rounding half across 240,023 actual-source comparisons. Provider metadata and
quota integer projections now compare the fractional remainder before rounding,
preserving `Math.round` without first adding 0.5. The original job log and both
configuration reports are retained; the configuration reports themselves have
zero mismatches. Fresh supported-platform acceptance of the correction remains
required.

```sh
node scripts/server-rust/provider-quota-http-compatibility.mjs --database pglite --report .qa/rust-server/provider-quota-http.json
```

Repeat with private and external PostgreSQL as for the other socket suites.
Remaining settings/provider operations, production diagnostic
formatting and runtime consumers remain in the full replacement goal.

## Global settings and provider management

`GET /api/settings` reconciles the native bundled catalog, returns the current
settings snapshot and starts account/Ollama discovery in owned background work.
Provider create/update/delete use strict encrypted request contracts, retain
opaque keys, preserve hydration/cache ordering and run account preparation and
sign-out before deletion. Model references still prevent provider deletion.

Local real-socket comparisons pass 99 observations on each of native PGlite,
private PostgreSQL and external PostgreSQL. Real constraints/triggers verify
initial-account transaction rollback, failed updates and provider writes retained
when a later runtime detach fails. Response error context retains the source
query and parameters after actual failures. Built-in discovery checks generated
IDs and their relationships, and retained settings are compared after restart.
External PostgreSQL also verifies a real row-locked UPDATE survives caller
disconnect and shutdown, commits before exit and remains after reopen (103
observations). Current-head platform/package acceptance remains required.
Provider connection testing and worker reconnect/
periodic catalog hooks remain unported.

## Provider telemetry

Native routes now serve `GET /api/analytics/provider-telemetry`, provider export
and history deletion. Analytics preserve the original quota intervals,
stationary accumulation, reset windows, nullable token totals, confidence,
period comparisons, locale/calendar ordering, sampling and eight change metrics.
Raw query filters and the clamped `parseInt` days behavior retain the existing
HTTP contract. Response validation uses the authoritative protocol export.
Valid unknown structured telemetry remains in the stack-safe wire value through
JSONB parsing, projection and export. Actual comparisons cover depths 100, 150
and 300 without imposing Serde's intermediate recursion limit.

Exports include opaque dimensions and structured metrics. Four history tables
are deleted atomically, without changing current account projections or
publishing a settings invalidation. Owned operations survive caller disconnect
and drain before database closure. The external PostgreSQL HTTP suite holds an
actual admitted DELETE behind a lock, disconnects its caller, requests shutdown,
then verifies all four committed deletes and a retained process reopen.

```sh
node scripts/server-rust/telemetry-repository-compatibility.mjs --database pglite --report .qa/rust-server/telemetry-repository.json
node scripts/server-rust/telemetry-http-compatibility.mjs --database postgres --report .qa/rust-server/telemetry-http.json
```

Both suites support `pglite`, `bundled-postgres` and `postgres`; PostgreSQL
fixtures use `CANTRIP_TEST_POSTGRES_BIN_DIR`. These are disposable comparisons.
Current platform acceptance, execution-domain writers, migration/rollback,
packaged artifacts, product flows and default cutover remain required.
