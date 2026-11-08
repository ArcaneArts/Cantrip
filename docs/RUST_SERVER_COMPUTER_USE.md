# Native computer-use server routes

Rust implements operation dispatch, preview open/Stop and internal worker agent
authority. The worker remains Node and owns native execution and decryption.
Node remains the default server. Complete replacement and supported-platform,
package and full product acceptance remain unfinished.

## Behavior

Preview authority comes from current owner-scoped execution context, settings,
permission profile and placement. Worker-issued leases retain worker, Chat,
content-domain and generation checks. Stop remains available after archival or
placement changes, authenticates its owned worker and lease, and records at most
one opaque activity. A failed Stop activity write warns without undoing a
successful closure.

Operations require the existing preview lease and use the unchanged worker
command transport. Snapshot chunks retain exact operation identity, sequence,
operation restrictions and the 64-chunk bound. Input timelines retain their
disabled command deadline; preview, Stop and ordinary operations retain actual
30-second deadlines. Parser limits, unsupported methods, media errors and public
failure redaction match the reference router. Empty binary preview input uses
JavaScript's own Buffer keys rather than inherited enumerable methods.

Activity preserves encrypted Chat versus Task columns, assistant classification,
telemetry, attachment exclusion and once-only publication. Approval events retain
exact owner/worker/Chat/project provenance and terminal ordering. Bounded local
command/insert completion fences retain inserts after command timeout or caller
loss. Independent terminal notifications subscribe on the request-origin peer
as well as the peer owning the worker connection. They wait for the commands
captured at notification admission and for the corresponding in-flight insert;
later commands cannot extend that wait. No protected content is stored in fences.

Internal authority authenticates `worker:agent-tools` and checks the current
binding, expiry, context and execution lane without inferring a native turn.
Database text parameters use the reference driver's replacement behavior for
unpaired UTF16 surrogates; authorization retains the original claim. A paired
regression reproduced and corrected a native panic on such worker/Chat IDs and
a different Stop result. The original failing report remains retained.

## Executed local qualification

The final macOS arm64 comparison passes all nine storage/authentication pairs:
PGlite, bundled PostgreSQL and external PostgreSQL, each with none/password/accounts.
It retains 603 paired HTTP observations, 162 paired command/state cases and 18
clean server exits. These cover Chat, Task and standalone contexts, owned-worker
authentication, stale authority, SQL failures, opaque response validation,
approval publication/terminal notifications and destroyed HTTP callers. Worker
reply producers are controlled; the connection and SQL implementations are real.

A separate run holds preview/Stop/ordinary replies beyond their actual 30-second
deadlines and holds `input.perform` beyond 31 seconds before successful release.
External PostgreSQL tests block actual activity and approval INSERTs with an
advisory lock past the command deadline, observe pending SQL and no committed
row, then release the lock. Both servers retain the activity write; the approval
insert completes and the independent terminal notification interrupts its row.
These timing/SQL tests preceded the subsequent isolated UTF16 parameter fix.

The final optimized production pair additionally passes 89 HTTP observations and
19 command/state cases per peer with clean exits. It transmits a full 16 MiB
control payload, accepts exactly 64 snapshot chunks, rejects overflow and invalid
chunk operations, and verifies parser limits. SQL setup/observation uses a
separate connection to each fixture-owned PostgreSQL database, with the same
transaction boundaries as the SQL fixture; neither production server installs
SQL control routes. The initial observer mistakenly committed each statement,
violating a deferred standalone-root constraint; that failed report is retained.

The single maximum-control request took about 128 ms in Node and 295 ms in the
optimized Rust executable on this host. This is one observation, not a benchmark
or a performance acceptance result. Representative repeated latency, throughput,
memory and maximum-payload regression qualification remain required.

Existing browser encryption APIs and the complete unchanged worker pass six
single-server cells and all four Redis pairings: Node/Node, Node/Rust, Rust/Node
and Rust/Rust. The current ten cells retain 140 product steps, 28 clean server
exits and 30 clean worker stops. Before and after restart, the actual native
helper reports the `macos-screencapturekit` backend through sealed capabilities.
An actual protected permission request is decrypted in the browser and declined
through the existing encrypted approval response. Feature revocation rejects a
new preview while retained Stop remains available; re-enabling permits a fresh
lease. No native input is performed. Successful physical capture/input and
native-agent MCP execution are not established by this scenario.

The current production executable is 93,220,928 bytes, SHA-256
`ef856f33477671eb4adabe05690383a2bbe601a34bd61b8879095a4f19b44d80`.
Its production inventory completes 584 requests per peer with clean exits and
zero generic fallback differences. That narrow probe does not establish
successful operations or full replacement acceptance.

The independent nine-root/127-node graph passes 9,300 Source comparisons across
three base graph sizes. The authority oracle compares 1,600 actual Source cases.
All 76 Rust library tests and strict all-target Clippy pass locally. The standard
`pnpm check` stops at unchanged Node source line limits: `build-app.ts`
1,532/1,500 and `chat-turn-runtime.ts` 2,336/1,999; downstream aggregate stages
did not run. No hosted development Actions were used.

## Repeatable commands

Build current workspace packages, the Node reference and worker first. Supply
the existing PostgreSQL/database fixture runtimes and one shared Cargo target
with incremental compilation disabled.

```sh
node --import tsx scripts/server-rust/computer-use-http-compatibility.mjs \
  --database pglite --report /absolute/path/to/http.json

node --import tsx scripts/server-rust/computer-use-http-compatibility.mjs \
  --database pglite --profile none --timers --report /absolute/path/to/timers.json

node --import tsx scripts/server-rust/computer-use-http-compatibility.mjs \
  --database postgres --profile accounts --sql-timeout \
  --report /absolute/path/to/sql-timeout.json

node --import tsx scripts/server-rust/computer-use-http-compatibility.mjs \
  --database postgres --profile none --production --limits \
  --report /absolute/path/to/production-limits.json

node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --database postgres --server-pair all --computer-use --keep-fixture \
  --report /absolute/path/to/shared.json
```

Use `CANTRIP_RUST_SERVER_BINARY` for the HTTP SQL fixture, or the actual optimized
production server with `--production` and external PostgreSQL. The browser
scenario uses `CANTRIP_TEST_SERVER_BINARY`, `CANTRIP_TEST_WORKER_PACKAGE`,
`CANTRIP_TEST_CLI_BIN` and `CANTRIP_TEST_REDIS_BIN`. Repeat single-server product
runs on every store. Preserve exact binaries, reports, logs and isolated profiles
before cleanup. Final platform/package, migration/rollback, complete product,
performance and background-service reconciliation, Rust default selection and
production Node-server removal remain required.
