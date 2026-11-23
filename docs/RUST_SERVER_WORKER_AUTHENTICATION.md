# Native worker authentication and claim lifetime

The Rust worker WebSocket route now sends authentication decisions through the
shared server logger. It preserves request/worker identity, repetition keys,
console fields, persisted minimization and redaction. The production comparison
first reproduced twelve matching WebSocket outcomes with eight reference
authentication records and zero native authentication records.

The port covers missing worker identity, invalid connection generation, invalid
credentials, in-memory credential revocation, owner mismatch, successful
authentication and relay-claim errors. Missing-generation protocol rejection,
capacity rejection and authentication timeout do not acquire invented
authentication records. Repeated missing-identity, generation and credential
warnings retain the reference thirty-second suppression policy.

Successful authentication retains the actual process generation in the console.
The existing persisted-record minimizer omits that field on both implementations.
The comparison validates actual request UUIDs and correlates exposed upgrade
headers; the reference does not expose its request ID on successful upgrades.

## Actual Redis timeout discrepancy

A private Redis `CLIENT PAUSE 20000 WRITE` reproduced a second discrepancy.
Node closed the worker after its ten-second authentication deadline with
1013 `Worker authentication timed out`. Rust instead reported
`Worker relay coordination is unavailable`: its Redis command connection had
inherited the Redis crate's five-hundred-millisecond response timeout.

The native command manager now explicitly disables that response timeout,
matching the production Node command client. This changes this manager's
configuration, not the vendored library's global defaults. The same existing
ten-second authentication deadline remains active during relay attachment.

An abandoned socket retains the original owned attachment and handshake permit
until its real result settles. A late successful claim is discarded; an actual
late error is captured once. Physical socket closure remains independently
owned by the existing closing-handshake transport. Generation registration still
begins under the credential revocation lock without holding that lock during IO.

The real Redis fault cases establish:

- Denying `SET` produces the same 1013 coordination error and persisted claim
  failure record on both servers, followed by readiness recovery.
- Pausing writes reaches the actual ten-second authentication deadline. After
  resumption, the queued claim really executes and its worker key disappears
  before the configured sixty-second TTL. No ready frame or completed
  authentication record is emitted for the abandoned connection.
- Denying the queued `SET` after timeout produces the original claim failure
  while the client still withholds its close ACK. Diagnostic capture therefore
  does not depend on physical socket closure. Restoring permissions permits
  readiness recovery and clean shutdown.

The original failures remain retained. An initial denied-`EVAL` experiment did
not exercise claim admission because production uses `SET`; that invalid fault
was replaced with the actual command, not treated as passing coverage.

## Local qualification

The final debug candidate passes all nine combinations of PGlite, private bundled
PostgreSQL and external PostgreSQL with none/password/accounts authentication.
The actual production entrypoints run in 28 processes: 26 normal zero exits and
two expected startup-failure exits of one. Eighteen authentication peers perform
192 WebSocket attempts and retain 120 decision records, forming sixty paired
record comparisons. Whole-server record totals are not asserted equal.

The optimized executable repeats that 28-process matrix with Rust started first.
Fourteen additional optimized/reference process runs pass the three Redis claim
fault pairs, all three stores' rejected-authentication close handshakes and a
real PostgreSQL credential-row-lock shutdown. All fourteen exit zero. The held
credential update commits exactly once per server after release. The paused
claim closes after 10,008 milliseconds on Node and 10,003 on Rust; the late-error
case observes its close frame after 10,004/10,003 milliseconds and captures the
error before the deliberately withheld ACK.

Actual paired bootstrap responses report version 1.1.2771. The optimized macOS
ARM64 executable is 94,168,848 bytes with SHA-256
`f8bb747fb2420d418d97e766a4d5f799201f0d1f81b645c3937100e378f2f94a`.

The controlled worker answers the real initial inference configuration and
version/catalog requests. It does not establish full worker resource or native
execution acceptance. External PostgreSQL additionally exercises real owner
mutation and the actual credential-revocation API with a disposable trigger that
retains the durable timestamp, exposing the in-memory revocation guard.

All four reference/native coordinator pairings pass 56 recorded steps. All four
coordinated bridge pairings pass 172 recorded steps. These execute production
classes against real private Redis with controlled sockets; they do not prove
active-job failover or the complete product/deployment matrix.

All 80 Rust library tests, sixteen focused bridge/budget/ingress integration
tests, strict all-target Clippy, formatting, sixteen generated
schema/provider comparisons, server boundaries and retired-workflow checks pass
locally. The standard `pnpm check` stops at unchanged Node decomposition budgets
(1,539/1,500 and 2,336/1,999); the separate repository check reports
2,284/2,000. Actual read-only Primary checks reproduce the failures, and all three
source files and both check scripts have matching hashes. Subsequent aggregate
steps are not claimed as passing.

One early fixture assumed a request-ID upgrade header absent on Node. Another
closed its worker with metadata still pending and raced Node's real
fifteen-second reconnect grace against a fifteen-second process-kill timer.
The retained corrected fixture observes the actual configuration response and
another FIFO RPC, and permits forty-five seconds for authentication-suite
process cleanup. Wire, record and exit assertions remain enforced.

```sh
node --import tsx scripts/server-rust/log-runtime-server-compatibility.mjs \
  --worker-authentication-records --report /absolute/path/authentication.json
node --import tsx scripts/server-rust/log-runtime-server-compatibility.mjs \
  --worker-authentication-coordination \
  --scenario postgres-authentication-coordination --report /absolute/path/claim-error.json
node --import tsx scripts/server-rust/log-runtime-server-compatibility.mjs \
  --worker-authentication-pause \
  --scenario postgres-authentication-coordination --report /absolute/path/claim-timeout.json
node --import tsx scripts/server-rust/log-runtime-server-compatibility.mjs \
  --worker-authentication-pause-denied \
  --scenario postgres-authentication-coordination --report /absolute/path/claim-late-error.json
```

Set `CANTRIP_RUST_SERVER_BINARY` to the exact candidate. Supply the existing
private PostgreSQL, Redis and native PGlite fixture environments. The reference
runs the actual TypeScript production entrypoint, not a replacement service.

Node remains the default server and the worker remains Node. Other production
diagnostic/background consumers, current supported artifacts/platforms, full
product/fault/coordination, historical upgrades and post-write rollback,
performance, final Rust cutover and production Node-server removal remain
required. No GitHub Actions validation or production deployment is performed.
