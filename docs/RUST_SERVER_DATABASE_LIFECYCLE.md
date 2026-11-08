# Native database initialization and health diagnostics

The Rust serving entrypoint now owns the existing database initialization
lifetime and its operational records. Node remains the default server and the
worker remains Node. Full replacement acceptance is incomplete.

## Initialization

The connector emits `database.connection.started`, resolves the retained local
key configuration, opens the selected engine, runs the existing migration
journal and provisions the retained local identity and owner state. PostgreSQL
also establishes the real inference-revocation, computer-use-authority and
project-alert subscriptions before completion. Their shared listener remains
alive for application consumers; repeated PostgreSQL LISTEN registration is
idempotent. PGlite's synchronous callbacks still attach with their consumers.

The successful connector hands its identity to application composition. It does
not provision it a second time or start background services merely to determine
whether database setup succeeded. Only successful initialization emits
`database.migrations.completed`, `database.connection.completed` and the existing
server database-ready event. PostgreSQL migration completion retains the actual
attempt number. Current Node provider/account/MCP secret migration methods are
no-ops; SQL migration 0119 owns those transitions.

PostgreSQL serving initialization retains thirty attempts, a one-second delay
after actual failure, and the existing rate-limited warning/summary policy.
Each failed initialization closes its database/listener before retry. An owned
private postmaster is closed when initialization ultimately fails. Offline
export, restore and migration operations retain their separate existing path.

PGlite setup errors close the engine and propagate. The explicit replacement
goal forbids silently resetting user data, so Node's destructive desktop
migration-error fallback is not introduced into Rust.

When an explicit keyring is configured, the local key file is bypassed. Otherwise
the connector reads or exclusively creates `secret-encryption-key.json`, using
canonical 32-byte key material and the existing metadata shape. Valid retained
bytes are preserved and Unix permissions become 0600. Invalid JSON, metadata or
base64 propagates its error without replacing the file. This preserves the
legacy configuration/file contract; it does not grant plaintext access to
worker-owned encrypted content.

## Health probes

The explicit database probe used by `/readyz` and `/api/health` records the
existing warning after a successful probe takes at least 250 ms. Failures use the
existing error/repeated-event policy and return the original error to the
caller. Ordinary SQL operations are not wrapped in a new probe or readiness
gate. Persistent records retain minimized error classification and omit private
connection credentials.

## Executed local comparisons

The original production comparison reproduced three Node database lifecycle
records and zero native records on all three stores. A separate retained
pre-patch run exits after the first rejected native connection while Node
recovers. The intermediate candidate also failed after a rejected notification
connection, having prematurely declared the database ready and started
application services. The corrected connector includes that actual subscription
failure in its retry boundary.

The current debug executable passes thirty production-entrypoint peer runs
across native PGlite, bundled PostgreSQL and external PostgreSQL. The suite
retains HTTP/console/archive checks, malformed retained keys, byte/permission
preservation and explicit-key bypass. Actual PostgreSQL FATAL responses witness
six refused startup connections before recovery, with migration completion on
attempt seven. A separate pair witnesses all thirty refused attempts and clean
exit 1 after exhaustion. Notification-only rejection/recovery passes separately.

The optimized executable (93,968,608 bytes, SHA-256
`1229cf8b37e1e00c759734460f1d6b67c43df80a7038e7a9593a9366b9f01604`)
passes both production runs: thirty peers with connection exhaustion and
twenty-eight with notification rejection/recovery. It also passes a real
FIFO-blocked final archive write while profile activation waits for the lease.
This is a macOS arm64 candidate, not a final supported-platform release.

For health checks, the transparent wire proxy observes the real SELECT 1
execution and CommandComplete. It holds the actual acknowledgement for 350 ms
on both health routes, then releases the original result. Six further probes
lose their TCP connection after real execution, return 503, produce matching
minimized error/repeated diagnostics, and recover to 200. SQL results and error
responses are not synthesized.

```sh
CANTRIP_RUST_SERVER_BINARY=/absolute/path/to/cantrip-server \
  node --import tsx scripts/server-rust/log-runtime-server-compatibility.mjs \
  --http-records --database-records --database-health \
  --database-retries --database-exhaustion \
  --report /absolute/path/to/database-lifecycle.json

# Permit the main connection but reject the initial notification connection.
CANTRIP_RUST_SERVER_BINARY=/absolute/path/to/cantrip-server \
  node --import tsx scripts/server-rust/log-runtime-server-compatibility.mjs \
  --http-records --database-records --database-health \
  --database-listener-retries --report /absolute/path/to/listener-retry.json
```

Build the reference workspace packages first and supply the usual native PGlite
assets and PostgreSQL fixture/helper variables. Development validation is local.
All 78 Rust library tests, strict all-target Clippy, 37 Source logging tests,
server build/typecheck, sixteen contract graphs/maps and boundary/workflow-removal
audits pass. The aggregate check stops at unchanged Node budgets 1,539/1,500 and
2,336/1,999; the separate repository budget is 2,284/2,000. Actual baseline
file/tool byte comparisons are retained; downstream aggregate checks were not run.

## Remaining acceptance

The separate `--database-health-outage` comparison remains open. After all role
connections are terminated and further connections are refused, later Node
probes can remain pending beyond sixty seconds while access stays revoked;
Rust returns actual connection failures sooner. A raw postgres-js experiment
reproduces later pending requests with and without the proxy. Shorter initial
experiments also needed forced Node termination; the later EOF-preserving proxy
run exits zero after access is restored. Original failures, exact earlier helper
inputs and raw driver observations are retained. This is not a passing broad
outage comparison, and no native pool behavior is changed to imitate it here.

Current product/fault/shared-instance, supported-platform/artifact, historical
upgrade/rollback and performance acceptance remain required. Additional
account-usage, bridge, HTTP/Pino and other operational consumers remain to
reconcile. Rust default cutover and production Node-server removal are unfinished.
