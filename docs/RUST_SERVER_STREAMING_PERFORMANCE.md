# Production worker-log streaming

The production-entry benchmark exposed a Rust worker-log throughput regression:
the initial three balanced 64 MiB trials measured a median 48.10 MiB/s for Rust
and 212.01 MiB/s for Node. Both peers delivered every record correctly. This
milestone removes redundant JSON encoding and UTF-16 allocation while preserving
the existing protocol and validation.

## Implementation

Valid UTF-8 strings reuse their cached representation for serialization and take
the UTF-8 parser path. ASCII-to-UTF-16 conversion allocates the exact number of
code units. Strings containing lone surrogates retain the existing WTF-8/UTF-16
path, including their escaped JSON representation.

Validated arrays reuse their values when the previous JSON round trip would
preserve them. Nonfinite numbers, negative zero and objects requiring JavaScript
integer-property ordering retain that round trip. The scan uses an explicit
stack. The worker-log handler also reuses the bridge-validated notification
values; outgoing message validation still runs. Frame limits, leases, cleanup,
accounting and slow-consumer behavior are unchanged.

## Repeated performance results

The final comparison used an Apple M4 Max running macOS arm64, fresh local
PGlite profiles and 256 MiB per invocation. Each series completed five warmups
and 20 measured runs. All 75 invocations passed; no builds or other compatibility
drivers ran during measurement. The existing Keychain-blocked QA app and
unrelated local services remained unchanged.

| Metric, across 20 measured runs         | Original Rust 1.1.2778 | Optimized Rust 1.1.2779 | Node 1.1.2778 |
| --------------------------------------- | ---------------------: | ----------------------: | ------------: |
| Median payload throughput               |            48.26 MiB/s |            208.42 MiB/s |  207.11 MiB/s |
| Median 256 MiB stream duration          |            5,304.64 ms |             1,228.28 ms |   1,236.08 ms |
| p95 stream duration                     |            5,514.47 ms |             1,238.56 ms |   1,261.14 ms |
| Median process-tree RSS after streaming |             126.62 MiB |              125.24 MiB |  1,364.05 MiB |

The optimized Rust stream is 4.32 times faster than the original Rust artifact.
Its 0.64% sampled throughput difference from Node is within measurement noise;
this establishes approximately equal throughput for this workload, not a
general Rust advantage. RSS includes shared mappings and is not proportional or
physical memory accounting.

Every run delivered 268,435,456 payload bytes and 270,975,888 wire bytes, with
payload SHA256 `8531f9720e3f5ce15fde831a4c677c501b3ef320d4f156c1248299cd9955392d`.
The peep-hole-optimize A/B driver also confirmed stable equivalent stdout and
a 55.30% reduction in complete-command median duration, from 7,379.97 ms to
3,298.73 ms. That timing includes setup, startup, enrollment and shutdown; it
is separate from stream duration. The Node reference was captured through
perf-regression-guard using the same warmup and measurement counts. Earlier
three-per-peer alternating 64 MiB trials also reproduce the throughput parity.
Raw per-run reports, original failures, CPU samples and the derived summary are
retained under `.qa/rust-streaming` for archival before lane cleanup.

## Compatibility and package acceptance

The final parser passes 899,891 exact Node/Rust comparisons across 802 roots.
The outgoing worker-command suite passes its 323 examples, 86 boundaries,
262,471 mutations, 102 custom checks and union/enum alternatives. All 85 library
tests and strict all-target Clippy pass. The Node JSON oracle passes 69,696
round trips, including 48 additional large ASCII, Unicode, control-character
and lone-surrogate vectors. New regression cases retain number normalization
and observable object order.

Node 24.22.1's text line reader splits at U+2028 and U+2029. Those characters can
appear literally inside valid JSON strings. The complete comparison originally
stopped on such a response; replaying its exact bytes produced valid JSON that
matched the expected result. The comparison now splits JSONL only at LF, with
regression tests for one-byte UTF-8 chunks, Unicode separators, controls, CRLF
and unterminated final output. Rust's wire output was not changed to accommodate
the harness. The original failed run and exact replay are retained.

Both compiled Node and the optimized native package pass the following sequence
on PGlite, bundled PostgreSQL and external PostgreSQL:

1. Enroll an actual production `WorkerConnection` through HTTP and WebSockets.
2. Transfer 64 MiB of controlled worker-log messages with an eight-frame window;
   check every record and cursor, payload SHA256 and received byte count.
3. Pause the consumer and send large batches. Require close code 1013, the exact
   `Worker log stream consumer is too slow` reason and exactly one lease stop.
4. Commit a preference, SIGKILL the server, restart its profile on the same port,
   retain identity and the preference, reconnect the worker, then complete a
   diagnostics command and another stream.

The Node bundled-PostgreSQL reference uses an isolated private PostgreSQL fixture;
the Rust package supervises its own bundled process. External PostgreSQL also
uses an isolated fixture. Recovery observations include the unchanged reconnect
and fencing delays; they do not change those deadlines to improve a metric.

The final macOS arm64 native distribution passes all three stores in local and
hosted modes: migration and export launchers, retained writes and identity,
restart, SIGTERM and embedded runtime fallback. All 1,762 packaged file hashes
match. Node is absent from the server runtime PATH; Homebrew reads and writes
to the artifact are denied.

The existing worker-log HTTP/stream comparison additionally passes all three
authentication modes on PGlite: 57 paired HTTP observations per mode and
28/30/30 paired stream/command cases. Its first native debug-fixture invocation
failed because the default extracted development runtime lacked `postgres.bki`.
That failure is retained. The successful comparison explicitly selects the
packaged PGlite assets; the package's separate embedded-fallback test also passes.

## Packaged `1.1.2869` comparison

The packaged macOS ARM64 Rust server and compiled Node reference each ran
one 64 MiB worker-log stream, slow-consumer test and SIGKILL recovery per
store. Every run delivered the same payload hash. All six slow consumers
received close code 1013 with the expected reason and exactly one lease stop.
The worker reconnected after restart, and the server retained its identity and
accepted setting.

| Database            | Node MiB/s | Rust MiB/s | Node recovery | Rust recovery |
| ------------------- | ---------: | ---------: | ------------: | ------------: |
| PGlite              |     220.94 |     230.51 |       29.12 s |       27.71 s |
| Bundled PostgreSQL  |     228.67 |     235.98 |       28.83 s |       27.56 s |
| External PostgreSQL |     230.87 |     241.81 |       27.64 s |       28.37 s |

Recovery includes the worker's reconnect backoff. Each pair is a single
observation. The repeated PGlite throughput series above has its own earlier
artifact versions.
[Production package acceptance](security/rust-server-2869-production-packages.json)

## Packaged `1.1.2881` comparison

The macOS ARM64 package and same-source Node reference each streamed
64 MiB on PGlite, bundled PostgreSQL and external PostgreSQL. Every run
matched the payload hash, closed its stalled consumer with code 1013,
stopped that lease exactly once, and recovered the same server identity
and accepted write after SIGKILL. The reconnected worker completed a
new command and stream.

| Database            | Node MiB/s | Rust MiB/s | Node recovery | Rust recovery |
| ------------------- | ---------: | ---------: | ------------: | ------------: |
| PGlite              |     198.96 |     206.31 |       29.19 s |       27.55 s |
| Bundled PostgreSQL  |     204.62 |     203.58 |       26.05 s |       26.65 s |
| External PostgreSQL |     202.32 |     204.86 |       25.81 s |       27.75 s |

Each pair is one observation. Recovery time includes the worker's
reconnect backoff.
[Current runtime and stream measurements](security/rust-server-2881-performance-acceptance.json)

## macOS ARM64 `1.1.3032` comparison

Three fresh PGlite profiles per runtime gave median readiness of 3.67 s for
Node and 1.36 s for Rust. Median idle process-tree RSS was 1,306 MiB and 94 MiB,
respectively. The median of the three per-run p95 settings-read measurements
was 4.68 ms for Node and 1.86 ms for Rust.

| Database            | Node MiB/s | Rust MiB/s | Node recovery | Rust recovery |
| ------------------- | ---------: | ---------: | ------------: | ------------: |
| PGlite              |     179.33 |     201.50 |       29.59 s |       24.95 s |
| Bundled PostgreSQL  |     191.88 |     197.20 |       27.30 s |       26.38 s |
| External PostgreSQL |     198.57 |     190.41 |       28.56 s |       24.62 s |

Each stream cell is one 64 MiB observation. The Node bundled PostgreSQL
control uses a separate private PostgreSQL process. All six runs matched the
payload hash, closed the slow consumer with code 1013, and recovered the same
server identity and accepted setting after SIGKILL. The existing worker
connection then completed a new request and stream. Recovery times include
worker reconnect backoff. External PostgreSQL throughput was 4.1% lower in
this Rust run. Repeated measurements would be needed to establish a regression.
[macOS benchmark evidence](security/rust-server-3032-macos-performance-routes.json)

## Windows bundled PostgreSQL crash recovery

The Windows x64 1.1.2976 server passed the 64 MiB stream and then exited during
restart while PostgreSQL was still recovering. The 1.1.3033 candidate gives
`pg_ctl` up to two minutes and allows the SQL readiness check to wait when
PostgreSQL reports that startup is still in progress. The server continues to
check the actual process exit status and SQL connection.

The candidate recovered readiness 42.3 seconds after restart in the local
Windows x64 guest. It retained the server identity and the accepted setting.
The existing worker connection resumed, completed a new command and streamed
again. The initial stream matched the 64 MiB payload and closed the slow
consumer with code 1013. This run used a private copy of the installed server
assets with the cross-built executable.
[Windows bundled PostgreSQL recovery evidence](security/rust-server-3033-win32-x64-bundled-postgres-recovery.json)

## Windows x64 comparison

The Windows 11 x64 guest ran the Node 1.1.2938 reference and Rust 1.1.2976.
Staging the required Visual C++ runtime DLL in the private reference fixture
resolved the Argon2 load failure. The native loader returned error 126 before
staging and both the native load and Node import succeeded afterwards.

| Database            | Node MiB/s | Rust MiB/s | Node recovery |  Rust recovery |
| ------------------- | ---------: | ---------: | ------------: | -------------: |
| PGlite              |       5.40 |       5.47 |      129.72 s |        57.45 s |
| Bundled PostgreSQL  |       1.26 |       4.24 |       89.16 s | Restart failed |
| External PostgreSQL |       5.10 |       5.54 |      107.07 s |        45.26 s |

All six runs streamed the exact 64 MiB payload and closed the slow consumer
with code 1013. The Node reference passed all three cases. The Rust PGlite case
passed. The bundled PostgreSQL restart failed during WAL recovery. The external
PostgreSQL run recovered the accepted write and identity and exited Cantrip
cleanly, then timed out shutting down the separate database fixture.

The Rust 1.1.3033 follow-up passed the PGlite and bundled PostgreSQL cases
with 7.23 and 5.47 MiB/s respectively. Its external PostgreSQL run stopped
before Cantrip launched because the independent fixture used a 60-second
startup default. The benchmark now passes the configured startup timeout to
that fixture. These results cover single observations in emulation, and the
Node bundled PostgreSQL control uses an independent database process.
[Windows comparison and retained failures](security/rust-server-windows-stream-comparison.json)

## Reproduce

Build the current Node reference and worker/protocol dependencies, and package
an optimized Rust distribution. Then run from the repository root:

```sh
node --import tsx scripts/server-rust/production-stream-benchmark.mjs \
  --runtime rust --database pglite \
  --artifact /absolute/path/to/native-server \
  --node-directory /absolute/path/to/tests/reference-node-server \
  --root .qa/stream-comparison --payload-mib 64 --pressure --recovery
```

Repeat with `--runtime node` and the other two database modes. Supply the
database-fixture executable and PostgreSQL fixture binaries through
`CANTRIP_RUST_DATABASE_FIXTURE_BINARY` and `CANTRIP_TEST_POSTGRES_BIN_DIR`.
Every invocation gets a fresh profile under its runtime's `runs` directory;
failed runs retain their reports. The driver requires Node/tsx for test control,
while the native server runs its actual packaged executable.

For a slow native test host, use `--startup-timeout-ms` with the same
value for both runtimes. The deadline applies separately to launching the
external PostgreSQL fixture and to each Cantrip server start. The report
records the configured deadline, and the server startup measurement ends when
the real readiness request succeeds.

## Scope and remaining work

This workload measures bulk worker-log JSON through production server entry
points with controlled log generation. It does not qualify opaque WorkerLink
binary throughput, large product datasets, all other storage-mode performance,
all product failures, or the complete platform matrix. The measurements above
include macOS ARM64 and emulated Windows x64. They ran locally.

The historical aggregate check stopped at the former Node decomposition
budgets. Focused native and compatibility results have their recorded scope.
Rust is the default server. The old Node implementation serves as an explicit
development reference, and the worker still runs on Node. See
[current replacement acceptance](RUST_SERVER_ACCEPTANCE_RECONCILIATION.md)
for the remaining shipping qualification.
