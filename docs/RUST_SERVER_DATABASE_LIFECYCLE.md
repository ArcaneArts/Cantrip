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

## Role-wide refusal and recovery

The subsequent `--database-health-outage` comparison uses actual production
entrypoints and external PostgreSQL under none, password and accounts
authentication. The private database role loses connection admission; its
existing backend PIDs are terminated and observed gone. Six readiness calls run
concurrently. After an actual backend FATAL 53300, admission stays revoked for
another 500 ms. Every response completed during refusal must be 503/unavailable,
and no health SELECT may complete successfully during that phase. Then role
access is restored without waiting for all HTTP callers to settle. Callers must
settle within their deadline; a successful response requires an actual successful
query witness after restoration. A fresh readiness request must return 200.

Each peer first accepts a settings write. After recovery it must retain that
write, server identity, user and session expiry, with the original cookie and
CSRF token still usable. Another accepted write proves resumed operation. The
authenticated cases log in or register through public HTTP; they do not seed
sessions through SQL or log in again after recovery. Anonymous mode explicitly
retains its null user and CSRF state.

All 32 production peers pass locally on macOS arm64 using the version-aligned
optimized executable (93,968,608 bytes, SHA-256
`803772b1d87a825c121c50a5838afa371891e5d769680e51f5886002dca62a84`).
Both implementations report version 1.1.2767. The six external-PostgreSQL outage
peers return all 36 refusal probes as 503, recover to 200, retain accepted state
and sessions, accept post-recovery writes and exit zero. The complete run also
retains the all-three-store production baseline, twelve held slow-probe cases,
36 post-execution TCP-loss failures, parser/console/archive comparisons and key
validation. Its 22 normal peers exit zero; ten deliberate invalid-startup peers
exit one without forced termination.

The deterministic pre-outage health records still compare exactly after the
existing timestamp/cursor/duration normalization. An actual HTTP completion
marker identifies that boundary. All subsequent outage diagnostics are retained
separately; their rate-summary counts are not asserted identical across different
driver reconnection schedules. Original sequential-probe timeouts, direct/proxy
driver observations, the nullable anonymous-session oracle error and an earlier
artifact-version mismatch remain retained. The version mismatch was resolved
by rebuilding, rather than discarding version fields. No native pool policy or
production server behavior changes in this qualification.

```sh
CANTRIP_RUST_SERVER_BINARY=/absolute/path/to/current/cantrip-server \
  node --import tsx scripts/server-rust/log-runtime-server-compatibility.mjs \
  --http-records --database-records --database-health-outage \
  --report /absolute/path/to/database-outage.json
```

## Remaining acceptance

This bounded role-admission fault does not prove long outages, actual postmaster
crashes/restarts, native PGlite failure recovery, transaction or dispatch
interruption, every reconnect schedule, or shared-instance product recovery.

Current product/fault/shared-instance, supported-platform/artifact, historical
upgrade/rollback and performance acceptance remain required. Additional
account-usage, bridge, HTTP/Pino and other operational consumers remain to
reconcile. Rust default cutover and production Node-server removal are unfinished.
