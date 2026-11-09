# Production WorkerLink byte transport

The acceptance driver starts either the compiled Node production entry or the
optimized native Rust distribution. It uses the unchanged production
`WorkerConnection` and `WorkerLinkGateway`, real HTTP-issued sessions and grants,
and controlled opaque resource adapters. It does not install SQL fixture routes
or manufacture broader grant permissions.

The native artifact is macOS arm64 `1.1.2779`, executable SHA256
`bc5cb46a18b2315fb6f4845f3c983a9f1ae6f7d8b7b21544b536eb76d360dcba`.
The retained compiled Node reference is `1.1.2778`. The worker gateway and
protocol dependencies are built from the current worktree. This milestone adds
qualification tools; production Rust and Node implementations are unchanged.
Node remains the default server and the worker remains Node.

## Executed behavior

The driver exercises the same sequence on PGlite, bundled PostgreSQL and external
PostgreSQL. Node's bundled-PostgreSQL reference uses an isolated private database;
the native package manages its own private process. External connections also
use isolated fixture databases. All six final production peer/store runs pass,
including the quota case and complete endpoint shutdown.

- Transfer 64 MiB from an observation endpoint through the `events` lane. Check
  every payload, identity, sequence and the exact original endpoint frame bytes.
- Create a tunnel and attachment through public HTTP, obtain a real `stream`
  grant and echo 64 MiB from client to worker and back. Verify complete upload
  credit return and matching hashes at both endpoints. The stored tunnel record
  is a schema-valid opaque fixture; the controlled adapter does not decrypt it.
- Revoke that grant. Require a `revoked` channel close and rejected further
  emission while an independently granted sibling continues carrying data.
  Releasing the session requires code 1008 and `WorkerLink session ended`.
- Pause TCP reading and offer 32 MiB across four separately granted observation
  channels. Each channel stays within its negotiated 8 MiB credit. Observe the
  actual relay congestion/stall close, verify received frame bytes, retain RSS
  observations and require channel retirement, continued server health and
  complete authority cleanup after explicit session release.
- Shut down and recreate the worker endpoint, gateway and transport using the
  same enrolled credential and a new process/connection generation. Require
  code 1013 with `Worker is offline`, HTTP 503 while offline, HTTP 404 for the
  old session and successful bidirectional transfer through a new grant.
- SIGKILL the actual server with an active, paused stream. Restart the same
  profile on the same port. Require retained server identity, preference and
  protected tunnel record; old socket code 1006; old session HTTP 404; a new
  server generation; rejection of the old grant in the new session; and a new
  authorized stream.
- Attempt a 300 MiB stream under the unchanged default 256 MiB worker relay
  budget. Require code 1013 with `WorkerLink relay bandwidth quota reached`,
  the exact admitted frame count derived from actual prior usage, increased
  rejection counters and retirement of the rejected channel.

The worker restart recreates its production transport/gateway objects inside the
driver; it is not a full worker process crash. The server crash is an actual
process kill. During a short server interruption, the unchanged worker can retain
already-installed bounded leases. The test preserves this reference behavior
while requiring old capabilities to be rejected by the replacement server.
Final endpoint shutdown requires zero channels, grants, sessions and invalid
attempts. It does not claim immediate lease erasure on a short reconnect.

The initial larger throughput warmup correctly failed against Node's default
bandwidth quota. Worker commands share the relay budget, so a 256 MiB payload
alone exceeds the available allowance. That original failure is retained. The
quota now has its own explicit rejection test; throughput measurements use
64 MiB without raising or disabling either peer's limits.

The standalone quota comparison admits exactly 4,095 payload frames on each
peer, with identical 2,425-byte prior usage, 268,372,415 accepted relay bytes and
64 rejected frames. The complete acceptance sequence starts this check after
the server crash/recovery workload; actual prior usage then permits exactly
4,079 frames on every peer/store pair. Counts account for worker-command traffic
through the public health collectors. No failing result was discarded or
reclassified as a successful throughput run.

## Repeated throughput measurements

An Apple M4 Max on macOS arm64 completed five warmups and 20 measured runs for
each peer and workload: 100 invocations, all passing. Every invocation uses a
fresh PGlite profile, the same 64 MiB payload and a 64-frame window. No builds or
other compatibility drivers ran during measurement; the existing Keychain-blocked
desktop app and unrelated services remained unchanged.

| Metric, across 20 measured runs    |         Node |         Rust |
| ---------------------------------- | -----------: | -----------: |
| Download median payload throughput | 227.82 MiB/s | 227.89 MiB/s |
| Download median stream duration    |    280.92 ms |    280.84 ms |
| Download p95 stream duration       |    286.24 ms |    290.33 ms |
| Echo median payload throughput     | 124.78 MiB/s | 123.53 MiB/s |
| Echo median stream duration        |    512.90 ms |    518.08 ms |
| Echo p95 stream duration           |    533.13 ms |    525.62 ms |
| Download median server-tree RSS    | 1,396.99 MiB |   125.69 MiB |
| Echo median server-tree RSS        | 1,403.23 MiB |   127.46 MiB |

The sampled Rust differences are +0.03% for download and -1.00% for echo. These
are within measurement noise; the result is approximately equal throughput for
this workload. Echo throughput counts the 64 MiB application payload once; that
payload traverses the server in both directions. RSS sums owned process-tree
resident mappings, including shared mappings; it is not physical or proportional
memory accounting.

Every run retains payload SHA256
`76466877cfb853ec22ade91618e06ca6c462aa18f6e5db49bf810fa9f5a97892`.
Downloads receive 67,456,941 encoded bytes in 1,024 frames. Echo receives
67,799,981 encoded bytes in 2,048 data/credit frames and returns all 67,108,864
upload credit bytes. Each received frame also matches the exact bytes emitted
by its endpoint, including its independently generated identity.

The perf-regression-guard command captures have stable equivalent stdout and
pass the 5% complete-command regression threshold. Download command medians are
4,024.50 ms for Node and 2,359.76 ms for Rust; echo command medians are 4,306.28 ms
and 2,546.80 ms. These include setup, startup, enrollment and teardown, and are
separate from stream measurements. Raw reports and their SHA256 values are
retained in `final-performance-summary-v2.json`, alongside original failures and
the all-store acceptance receipts, for archival before cleanup.

## Reproduce

Build the worker/protocol dependencies and the Node reference, and provide an
optimized native distribution. Run from the repository root:

```sh
node --import tsx scripts/server-rust/production-worker-link-acceptance.mjs \
  --runtime rust --database pglite --scenario acceptance \
  --artifact /absolute/path/to/native-server \
  --node-directory /absolute/path/to/cantrip_server \
  --root .qa/worker-link --payload-mib 64 --window-frames 64
```

Repeat with `--runtime node` and each PostgreSQL mode. Provide
`CANTRIP_RUST_DATABASE_FIXTURE_BINARY` and `CANTRIP_TEST_POSTGRES_BIN_DIR` for
the isolated PostgreSQL helper. `--scenario download` and `--scenario echo`
run only the respective throughput workload. Each invocation creates a fresh
profile and retains its report, process logs, failures and gateway shutdown state.

The producer waits for actual delivery, protocol credit or carrier-capacity
notifications. It does not insert a fixed delay into the nominal throughput path.
The 64-frame window holds at most 4 MiB of unconsumed payload. Packet creation,
hashing and endpoint work remain part of the measured workload. Client and worker
endpoints share the driver process, and driver CPU totals can include V8 helper
threads. These measurements describe this complete path, not the server's
maximum forwarding capacity.

## Scope and remaining replacement work

These checks cover macOS arm64 and the `events`/`stream` lanes with controlled
opaque endpoint bytes. They do not establish product endpoint encryption,
other QoS/platform/multi-instance performance, actual full-worker process
failures or complete product acceptance. Existing component/product evidence
retains its separate scope. All development validation is local; no GitHub
Actions run or Winterhold production deployment is used.

The root `pnpm check` still stops at the existing Node decomposition budgets:
`build-app.ts` 1,539/1,500 and `chat-turn-runtime.ts` 2,329/1,999. Later aggregate
checks are not claimed as passing. Full supported-artifact/product/background/
coordination acceptance, existing-client encryption and updates, broader
historical upgrade and product-state rollback, remaining performance, Rust
default selection and production Node-server removal remain required.
