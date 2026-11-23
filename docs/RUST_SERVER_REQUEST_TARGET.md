# HTTP request targets and route log levels

The native server now preserves Fastify's request-target decoding, parameter
limits, early error responses and registered-route log levels. This is a local
compatibility milestone. Node remains the default server, the worker remains
Node, and full replacement acceptance remains incomplete.

## Behavior

An outer native service validates and normalizes the target before the real
Axum router selects a handler. It preserves reserved escapes, decodes parameter
values once, counts the 100-character parameter limit in UTF16 units, and keeps
the original target for fallback responses and completion logs. Query strings
do not enter path validation. Absolute-form requests retain the reference's
origin-form routing and error-path behavior.

Malformed escapes or UTF8 return the existing `FST_ERR_BAD_URL` JSON response;
oversized named parameters return `FST_ERR_MAX_PARAM_LENGTH` with status 414.
These framework errors precede authentication, CORS, request IDs and ordinary
request metrics/logging. HEAD preserves the error's content length and sends no
body. The separate malformed-target fallback for methods without a registered
router retains its basic 404 and security headers while bypassing request hooks
and payload parsing. Ordinary unsupported methods retain their existing parser
and authentication behavior, without Axum's additional `Allow` header.

The opt-in patch to matchit 0.8.4 accepts empty terminal named parameters, so
`/api/agent-requests/` reaches the real interaction handler and returns its
domain error. Static matches retain priority. Upstream license files and hashes
of all copied files are retained in `third-party/matchit`; normal upstream
behavior remains the default when its additional feature is disabled.

`contracts/http-logging.json` captures 785 actual Fastify registrations: 584
declared routes, 200 implicit HEAD routes and the CORS wildcard. A native trie
preserves static/parameter/wildcard priority and their inherited log levels.
It applies request parsing and diagnostic policy; it does not replace handlers
or prevent an unknown native route from being dispatched. Info-level request
completion follows the route's Pino child threshold even for error responses;
failed response streams retain warning-level filtering. No HTTP debug routes
are added to the production server.

## Local evidence

The original production comparison reproduces four response discrepancies and
sixteen completion-capture discrepancies. Expanded raw HTTP probes additionally
expose encoded static paths, method-fallback headers and the malformed-target
fallback. Original failures and their exact harness versions remain retained.

The production debug candidate passes 61 raw HTTP requests per implementation,
including malformed paths, reserved escapes, Unicode parameter boundaries,
encoded static paths, absolute-form targets, HEAD, QUERY, OPTIONS, rejected
payloads and an untrusted forwarding/origin header on an early URL error.
Status, JSON/text bodies, application headers, request-ID presence and completion
record counts match. HTTP request-counter changes also match. Readiness/health
timestamps and durations are validated before normalization; metrics compare
descriptor/series identities and finite sample values. This is not a complete
comparison of changing metric values.

The actual production Fastify registration oracle supplies 20,391 routing probes,
including 2,428 early target errors. Native policy, error paths and per-method
matchit selection/decoded parameters match. This reference-router corpus is
separate from actual production HTTP qualification.

The controlled stream comparison uses the actual Source HTTP/logger factory and
native production logging middleware. Both implementations retain identical 34
completion records and five minimized warnings, with 46 finite/status responses
plus held, abandoned and failed streams. All seven log levels exercise GET/HEAD
200/404/500 responses and errors after the first stream chunk. Private query and
stream-error markers remain absent from the archive. All 79 Rust library tests
pass locally.
The vendored router's 44 upstream matching, insertion and removal tests also
pass with the Cantrip feature disabled and upstream test helpers enabled.

The production archive regression also passes forty actual process runs. Nine
storage/authentication pairs exercise PGlite, private PostgreSQL and external
PostgreSQL, each with none/password/accounts authentication. Their 1,062 target
observations match response bodies, application headers, early-error request-ID
behavior and completion capture. These paired target probes exclude the changing
metrics payload; the separate 61-request comparison covers its descriptors and
HTTP counters. The regression retains normal archive, parser, WebSocket and
retained-key checks: thirty processes exit zero and ten deliberate startup/key
failures exit one. Strict all-target Clippy passes locally.

The optimized macOS arm64 candidate repeats the 61-request comparison and the
complete forty-process production regression successfully. Both actual HTTP
`/version` responses report 1.1.2769. The executable is 94,096,528 bytes, SHA-256
`d996ade434170f8d15d082e39302ef5cba56d947f27ff3ea093e17038cfe4cc5`.
This is a local candidate, not the final supported release artifact.

The standard `pnpm check` stops on unchanged Node source line budgets:
`build-app.ts` is 1,539/1,500 and `chat-turn-runtime.ts` is 2,336/1,999. The
separate repository decomposition check also reports the unchanged
`native-commands.ts` budget of 2,284/2,000. Byte hashes of those files and their
check scripts match this milestone's base. Downstream aggregate check stages
remain unrun; focused workflow-removal and server-boundary audits pass.

Run through the existing shared Cargo target with incremental compilation
disabled:

```sh
node scripts/server-rust/cargo.mjs test --lib
node scripts/server-rust/cargo.mjs clippy --all-targets -- -D warnings
node --import tsx scripts/server-rust/http-log-policy-oracle.mjs --report /absolute/path/routes.json
CANTRIP_RUST_SERVER_BINARY=/absolute/path/cantrip-server \
  node --import tsx scripts/server-rust/http-log-policy-production.mjs \
  --report /absolute/path/production-http.json
node --import tsx scripts/server-rust/log-http-compatibility.mjs \
  --binary /absolute/path/log-http-fixture --report /absolute/path/streams.json
CANTRIP_RUST_SERVER_BINARY=/absolute/path/cantrip-server \
  node --import tsx scripts/server-rust/log-runtime-server-compatibility.mjs \
  --http-records --http-targets --database-records \
  --report /absolute/path/production-matrix.json
```

Supported-platform/current-package, integrated product/fault, migration/rollback,
performance, default-cutover and production Node-server removal acceptance
remain required. Development validation stays local; GitHub Actions is reserved
for releases and deployments.
