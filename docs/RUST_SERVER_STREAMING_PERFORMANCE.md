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

## Reproduce

Build the current Node reference and worker/protocol dependencies, and package
an optimized Rust distribution. Then run from the repository root:

```sh
node --import tsx scripts/server-rust/production-stream-benchmark.mjs \
  --runtime rust --database pglite \
  --artifact /absolute/path/to/native-server \
  --node-directory /absolute/path/to/cantrip_server \
  --root .qa/stream-comparison --payload-mib 64 --pressure --recovery
```

Repeat with `--runtime node` and the other two database modes. Supply the
database-fixture executable and PostgreSQL fixture binaries through
`CANTRIP_RUST_DATABASE_FIXTURE_BINARY` and `CANTRIP_TEST_POSTGRES_BIN_DIR`.
Every invocation gets a fresh profile under its runtime's `runs` directory;
failed runs retain their reports. The driver requires Node/tsx for test control,
while the native server runs its actual packaged executable.

## Scope and remaining work

This workload measures bulk worker-log JSON through production server entry
points with controlled log generation. It does not qualify opaque WorkerLink
binary throughput, large product datasets, all other storage-mode performance,
all product failures, or the complete platform matrix. Current execution is on
macOS arm64. No production Winterhold deployment or GitHub Actions run was used.

The root `pnpm check` still stops at the unchanged Node decomposition budgets:
`build-app.ts` 1,539/1,500 and `chat-turn-runtime.ts` 2,329/1,999. Later aggregate
checks are not claimed as passing. Focused native and compatibility results have
their separate recorded scope. Node remains the default server and the worker
remains Node. Full replacement, default cutover and production Node-server
removal remain required.
