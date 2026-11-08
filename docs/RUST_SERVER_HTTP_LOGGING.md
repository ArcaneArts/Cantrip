# Native HTTP and console logging

The production Rust server now formats service and HTTP records using the
existing presentation and records actual ordinary HTTP completions in the
diagnostic buffer and archive. Node remains the default server and the worker
remains Node. Full replacement acceptance is incomplete.

## Behavior

The outer observer assigns the identity also used by response headers, errors
and audits, retains the method and sanitized URL path, then observes actual
response-body completion. Headers or an initial chunk do not complete a stream.
HEAD and empty responses need no body bytes. Successful raw WebSocket upgrades
remain outside ordinary HTTP completion logging, matching Fastify's plugin.

An abandoned unfinished response produces no completion record. A producer
error after an initial chunk produces the existing generic warning instead.
Its sanitized console diagnostic can contain the error message; the minimized
archive retains the request identity and omits the private error message.
Existing successful-mutation publication callbacks retain their behavior; a
separate outcome callback distinguishes errors for request logging.

Console output retains prefixes, severity labels, context flattening, status
text, duration rounding and ANSI colors. UTF-16 survives until console UTF-8
encoding. Clock presentation uses the process timezone. `NO_COLOR`,
`FORCE_COLOR` and terminal detection select colors. Debug/trace filtering stays
independent of buffer/archive capture. Fixtures without explicit logging
initialization retain their previous quiet behavior.

## Reproduced parser discrepancy

The expanded production comparison found Node returning 400 for malformed JSON
sent with an unsupported method at a registered path, while Rust returned 404
without parsing. Native fallback handling now runs the registered parser first
for the reference's body-bearing methods. QUERY retains required content-type
and body errors. Invalid media-type syntax retains 415. A valid unregistered
media type still reaches 404, matching Fastify's fallback behavior. Earlier
authentication, origin and retired-route rejections retain precedence.

## Local qualification

The actual Node formatter/Pino oracle compares 480 service records, 1,006 HTTP
status/color cases, 13 duration cases and 11 URL cases per timezone. It covers
invalid dates, ordinary daylight-saving transitions, Unicode/lone surrogates,
nested contexts, numeric keys and coercion errors. This is not exhaustive
JavaScript calendar or arbitrary producer-input qualification.

Sixteen actual production-entrypoint peer runs cover all three stores,
request identities, status/method/path, archive admission, console output,
query redaction, startup failure, actual archive obstruction/recovery and clean
signals. The PostgreSQL pair additionally checks HEAD, CORS, fallback parsing,
QUERY and an actual App Live upgrade/normal close. Parsed error bodies are
compared, not only statuses.

The controlled-stream fixture uses the production observer/runtime and actual
HTTP sockets. Each peer retains nine completions and one generic producer-error
warning across finite, held, abandoned, HEAD, empty, 404 and 500 responses.
Original extra native completion and fallback-parser failures remain retained.

The optimized executable (93,874,608 bytes, SHA-256
`7b729e08e5fe35f55f487fe8c14137472a1e7d7d1cad07c596b1dbbf1822af45`)
also passes all sixteen production peer runs. A real FIFO-blocked archive write
additionally retains the profile lease until final shutdown logging drains.
This is a macOS arm64 candidate, not a final supported-platform release.
All 78 Rust library tests, formatter/record oracles, strict all-target Clippy,
37 Source logging tests, server build/typecheck and sixteen contract graphs/maps
pass locally; boundary and workflow-removal audits pass as well.

```sh
TZ=UTC node scripts/server-rust/cargo.mjs test --test log_format
TZ=America/Chicago node scripts/server-rust/cargo.mjs test --test log_format
TZ=Asia/Kathmandu node scripts/server-rust/cargo.mjs test --test log_format

CANTRIP_RUST_SERVER_BINARY=/absolute/path/to/cantrip-server \
  node --import tsx scripts/server-rust/log-runtime-server-compatibility.mjs \
  --http-records --report /absolute/path/to/production.json

node --import tsx scripts/server-rust/log-http-compatibility.mjs \
  --binary /absolute/path/to/log-http-fixture \
  --report /absolute/path/to/streams.json
```

Build workspace packages and the fixture first. Supply native PGlite assets
and PostgreSQL fixture/helper variables as for other server comparisons.
Development validation runs locally. The aggregate `pnpm check` stops at
unchanged Node line budgets 1,539/1,500 and 2,336/1,999. The separate repository
check stops at 2,284/2,000; exact baseline file/tool bytes are compared and
retained. Downstream aggregate checks were not run.

Additional HTTP/Pino, database, bridge and other operational consumers remain
to reconcile. This does not prove identical whole-server record counts, every
HTTP/socket failure boundary, supported-platform/package behavior or performance.
Current integrated product, migration/rollback, default Rust cutover and
production Node-server removal remain required.
