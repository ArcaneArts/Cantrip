# Integrated native artifact qualification

The candidate is `1.1.2778`, built from
`acca4261be4b4dc46fdeccbf9fe257cb42d03ed3`. Development validation ran locally.
Node remains the default server and the worker remains Node. These results
advance the replacement acceptance; they do not establish complete replacement.

## Executed candidate matrix

| Artifact or operation                                            | Executed scope                                                                                                                                                                                                                                          | Result     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| macOS arm64 native distribution                                  | All three stores, local and hosted; migrations, SQL exports, retained identity/settings, restart, SIGTERM, embedded runtime fallback; 1,762 file hashes; Node absent from runtime PATH; Homebrew reads and artifact writes denied                       | Passed     |
| Current desktop profile conversion                               | Eight production-launcher cases, including real historical PGlite conversion, preserved original files, restart without the converter, post-write reverse conversion observed by the actual old Node distribution, migration failures and owner SIGKILL | Passed     |
| Linux x64 Debian container                                       | All three stores, local and hosted; native migration/export entry points, retained writes and identity, restart and clean SIGTERM; UID 10001, read-only root and a 256 MiB `noexec` temporary mount; Node/npm/Cargo absent                              | Passed     |
| Exported Linux x64 distribution on Ubuntu 24.04                  | Same complete container-driver workload on the exported standalone distribution, with root-owned executable assets                                                                                                                                      | Passed     |
| Current Linux x64 distribution under systemd and HTTPS           | All three stores; actual production installer and units, secure sessions, CSRF, CORS, App Live, upgrade, intentional migration/startup failures, configuration recovery, post-write rollback, return to Rust and child reaping                          | Passed     |
| Current normal macOS desktop app with historical client identity | Actual old-profile conversion and worker request succeeded; existing-client encryption preparation did not complete while macOS Keychain was waiting and the console was locked                                                                         | Incomplete |

The eight-case conversion report retains 1,773 original profile files with
byte-equal backups. The actual old Node server reads the `system` preference
written by Rust and then accepts a subsequent `dark` write. This proves the
tested write survives reverse conversion; broader product-state rollback remains
required. A missing converter, an actual migration error, a missing completed
profile and converter-owner interruption retain their respective original-data
assertions. No failing assertion was weakened.

The current desktop app was built through the normal frontend and Tauri build,
using the isolated `art.cantrip.rust-qa-recovery` identifier and ad-hoc signing.
Its existing installation catalog matches the historical catalog exactly.
The Keychain lookup stack and actual console-lock flag were captured. The
catalog, device identity and Keychain were not reset or replaced with a test
vault. No complete encryption-ready UI pass is claimed.

## Standalone and Winterhold evidence

The Debian image ID is:

```text
sha256:3eb180f20278d8de6767f0bc85446814e5471edd7a850d7f6dfa059543dfbe4d
```

The exported native archive is 142,512,471 bytes, SHA256:

```text
716bd9467215df52fabca383105362a7a1b7bb75208cce6fe68a105bddc71e71
```

The native executable SHA256 is:

```text
51e162334c00c7e62ab6907d2f881883dba8ce4538cf34f25f3210c2c83c4a3e
```

The service rehearsal completed 18 installer calls: 12 successful installs and
six intentional candidate failures that restored the prior service and
configuration. External PostgreSQL exercised Node → Rust → Node → Rust, retaining
sessions, identity and accepted writes. Local database modes exercised native
release rollback; their systemd rollback is not an engine conversion. Private
PostgreSQL shutdown reaped all 17 observed service processes.

All six native external-database connections were observed using TLS. An actual
write through the running service's mount namespace failed with a read-only
filesystem error outside its writable profile. The mapped native executable was
hashed through `/proc/<pid>/map_files/` and matched the exported artifact.
`/proc/<pid>/exe` points to Rosetta in this environment, so its interpreter hash
is not used as the server binary hash.

Linux x64 execution used the local Docker Linux engine on an ARM64 Mac. The
systemd host was Ubuntu 24.04 ARM64 with x64 libraries and Rosetta binfmt. These
are actual Linux ABI, namespace and service executions; they do not establish
bare-metal x64 performance. The Node rollback baseline is the retained
`1.1.2739` distribution. Production Winterhold was not contacted or deployed.

Reports are `native-package-acceptance-v1.json`,
`profile-upgrade-acceptance-v1.json`, `linux-container-acceptance-v1.json`,
`ubuntu-container-acceptance-v1.json`, `winterhold-systemd-v1/report.json`,
`winterhold-systemd-v1/extra-runtime-observations-v2.json` and
`actual-app-update-v1.json`. Owned fixture data, earlier failures and exact
artifacts are retained for archival before cleanup.

## Current macOS ARM64 production-entry performance

The Node production reference built at `2e60d2042203f64c8105d5c52d12ae1db92d2d83`
and the optimized `1.1.2845` Rust package ran the same small PGlite workload.
On an M4 Max with macOS 27.0.1, all five warmups and 20 measured runs per
runtime passed. The test reopened each profile across runs, checked retained
settings and identity, and observed clean SIGTERM exits.

| Measurement                             |   Node median | Rust median |      Node p95 |    Rust p95 |
| --------------------------------------- | ------------: | ----------: | ------------: | ----------: |
| Complete workload                       |   3,770.03 ms | 1,514.66 ms |   3,980.23 ms | 1,561.38 ms |
| Warm readiness                          |   1,291.93 ms |    73.36 ms |   1,363.83 ms |    77.62 ms |
| Idle process-tree RSS                   | 1,349,096 KiB | 102,048 KiB | 1,361,520 KiB | 102,176 KiB |
| Median durable settings request per run |      4.034 ms |    1.255 ms |      4.734 ms |    1.336 ms |
| Paused-client catch-up                  |      0.736 ms |    0.615 ms |      0.803 ms |    0.650 ms |

The complete-workload guard passed with stable stdout and a 59.82% lower
median. RSS sums resident pages across the process tree, including shared
mappings. The sample covers a small local PGlite profile. Bulk relay tests
have their own [production comparison](RUST_SERVER_WORKER_LINK_PRODUCTION.md).
The
[macOS acceptance record](security/rust-server-darwin-arm64-acceptance.json)
contains the artifact and report checksums.

## Earlier production-entry performance sample

The benchmark launches the current compiled Node production entry point and the
optimized native distribution, without test-only HTTP routes. Both use isolated
local PGlite profiles, the same configuration and workload, and retained profiles
across process restarts. The Node database is JavaScript-hosted PGlite; the Rust
database uses native PGlite. This compares the resulting server deployments.

On an Apple M4 Max, 16 logical CPUs and 128 GiB RAM, each implementation completed
five warmups and 20 measured runs. All 50 runs passed, including graceful shutdown,
retained identity and previous writes. No builds ran during measurement. The
existing Keychain-blocked QA app and unrelated local services remained unchanged.
The perf-regression-guard capture reported stable stdout and a 55.14% reduction in
median complete-workload duration, from 3,361.60 ms to 1,508.04 ms; p95 was
3,402.70 ms versus 1,520.56 ms.

| Metric, median across measured runs                             |           Node |             Rust |
| --------------------------------------------------------------- | -------------: | ---------------: |
| Existing-profile startup to actual readiness                    |    1,101.46 ms |         73.67 ms |
| Idle process-tree resident memory                               |   1,297.59 MiB |        99.46 MiB |
| Bootstrap read latency                                          |       0.348 ms |         0.261 ms |
| Settings read latency                                           |       3.322 ms |         1.062 ms |
| Empty project-list read latency                                 |       0.650 ms |         0.300 ms |
| Read throughput, eight clients                                  | 853 requests/s | 3,330 requests/s |
| App Live ping latency                                           |       0.095 ms |         0.081 ms |
| Durable settings write latency                                  |       3.451 ms |         1.237 ms |
| Enrollment-code creation through committed-worker Live delivery |       3.502 ms |         1.725 ms |
| Paused-client catch-up after 20 enrollment events               |       0.612 ms |         0.533 ms |
| Graceful shutdown                                               |       32.58 ms |          5.40 ms |

Each run includes 180 measured sequential reads, 240 reads across eight clients,
100 measured App Live pings, 20 settings writes and 40 temporary worker
enrollments. Twenty enrollments occur with the WebSocket consumer paused. The
driver verifies every corresponding event after resuming, unlinks the temporary
workers and checks the worker catalog is empty. Settings writes are timed as
HTTP operations; the Source server does not publish a settings invalidation for
these mutations, so the benchmark does not invent one.

Each per-run JSON retains request median/p95, startup, RSS samples, throughput,
catch-up and shutdown measurements. The summary also retains run-level p95s;
its aggregates of request p95s are explicitly not pooled percentiles. RSS sums
the owned process tree and includes shared mappings; it is not physical or
proportional memory accounting. Profiles retain audit/history effects of the
same repeated workload. The collections are small, and the paused-client traffic
does not saturate a bulk relay. Other storage modes, large profiles, sustained
stream throughput/backpressure and fault-recovery performance remain required.

The subsequent [worker-log streaming qualification](RUST_SERVER_STREAMING_PERFORMANCE.md)
adds production bulk JSON measurements and all-store slow-consumer/crash/reconnect
comparisons. Its scope and remaining binary/product/platform work are recorded
separately.

The [production WorkerLink qualification](RUST_SERVER_WORKER_LINK_PRODUCTION.md)
adds real observation/tunnel grants, byte-exact binary traffic, quota and
slow-consumer boundaries, selective revocation and server/worker-endpoint
recovery. Its repeated `events`/`stream` measurements and limitations are
separate from this small-profile HTTP/Live sample.

Build the Node production entry and provide an optimized native package. Run
from the repository root, using a new owned evidence directory:

```sh
pnpm --filter @cantrip/server... build
for runtime in node rust; do
  for sample in $(seq 1 25); do
    node scripts/server-rust/production-runtime-benchmark.mjs \
      --runtime "$runtime" --root .qa/runtime-performance \
      --artifact /absolute/path/to/native-server
  done
done
node scripts/server-rust/runtime-performance-summary.mjs \
  --root .qa/runtime-performance --warmups 5 --iterations 20 \
  --report .qa/runtime-performance/summary.json
```

The benchmark uses ordinary production entry points and SIGTERM on Unix. It
records every invocation separately and preserves failed runs. The sample used
the perf-regression-guard skill's capture/compare commands with the same five
warmups, 20 measurements and a 5% complete-workload regression threshold.

## Populated-profile performance

The compiled Node reference from `c43a645d8` and optimized macOS ARM64 Rust
`1.1.2854` ran against the same synthetic profile on an Apple M4 Max. The
profile contains 64 projects, 256 chats, and 31,624 encrypted messages. The
busiest chat contains 1,024 messages and its full history is about 3.1 MB of
JSON. The original Node PGlite profile and logical restores preserve the
same identities and opaque content across all five configurations.

Each configuration passed one pilot, five warmups, and 20 measured runs.
The workload covers readiness, process-tree memory, sequential and
eight-client reads, settings writes, App Live pings and enrollment
publication, paused-client catch-up, retained state, and graceful shutdown.
Decoded project, chat catalog, message page, and full-history payloads
matched across all five configurations.

| Median measurement       | Node PGlite | Rust PGlite | Node external PostgreSQL | Rust external PostgreSQL | Rust bundled PostgreSQL |
| ------------------------ | ----------: | ----------: | -----------------------: | -----------------------: | ----------------------: |
| Complete workload        |    4,644 ms |    3,852 ms |                 3,327 ms |                 2,992 ms |                3,128 ms |
| Readiness                |    1,291 ms |      133 ms |                   957 ms |                    61 ms |                  175 ms |
| Idle process-tree RSS    |   1,308 MiB |     100 MiB |                  453 MiB |                   66 MiB |                 378 MiB |
| Project list             |     7.52 ms |    13.74 ms |                  4.31 ms |                 13.86 ms |                13.99 ms |
| 50-message page          |     4.04 ms |     6.51 ms |                  2.71 ms |                  6.70 ms |                 6.77 ms |
| 1,024-message history    |    34.90 ms |   106.02 ms |                 24.22 ms |                106.58 ms |               106.51 ms |
| Eight-client mixed reads |   331 req/s |   224 req/s |                681 req/s |                851 req/s |               831 req/s |

Rust `1.1.2854` reduced the complete-workload median by 17% on PGlite and
10% on external PostgreSQL. Project and message reads still regressed, and
PGlite mixed-read throughput fell 32%. The bundled PostgreSQL test measures
the Rust distribution independently. RSS includes server-owned processes
and shared mappings. The external PostgreSQL process was managed separately.

The retained report is `populated-profile-performance/verified-populated-performance-matrix-v3.json`
in the local `rust-server-final-native-2e60d2042-20261111-v1` evidence directory.
It records executable workload results, the logical restore manifest, and
checksums for the raw benchmark captures.

### Native read optimization

CPU samples showed repeated protocol-value cloning and encoding, generated
field-name allocation, and regex work on opaque ciphertext. The optimized
server moves parsed values into response objects, reuses generated field names,
avoids redundant JSON round trips, and checks the exact base64url alphabet
directly. The existing schema checks, trailing-bit refinement, JSON escaping,
and message-page limits still run.

The optimized macOS ARM64 `1.1.2857` package and the previous `1.1.2854`
package ran the same workload on separate restores of the populated profile.
All 156 invocations completed, including six pilots, 30 warmups, and 120
measurements. Project lists, chat catalogs, message pages, and full histories
matched byte for byte between the two Rust builds and matched the decoded
Node payloads. A sequential wire-contract oracle ran in the background.

| Median measurement       | PGlite before → after | External PostgreSQL before → after | Bundled PostgreSQL before → after |
| ------------------------ | --------------------: | ---------------------------------: | --------------------------------: |
| Complete workload        |   3,954 ms → 2,663 ms |                3,059 ms → 2,119 ms |               3,184 ms → 2,209 ms |
| Project list             |    14.35 ms → 6.38 ms |                 14.43 ms → 6.34 ms |                14.67 ms → 6.30 ms |
| 50-message page          |     6.90 ms → 3.21 ms |                  7.04 ms → 3.29 ms |                 7.11 ms → 3.16 ms |
| 1,024-message history    |  108.70 ms → 41.96 ms |               108.99 ms → 42.71 ms |              110.00 ms → 41.26 ms |
| Eight-client mixed reads |       215 → 439 req/s |                  828 → 1,557 req/s |                 818 → 1,539 req/s |

The complete-workload median dropped 31–33% across the three paired Rust
runs. Compared with the earlier Node run on the same hardware and profile,
PGlite project reads, message pages, and mixed-read throughput improved.
Full history still takes 42 ms versus 35 ms on PGlite and 43 ms versus 24 ms
on external PostgreSQL. External PostgreSQL project and paged reads also
remain slower than the earlier Node measurements. These are open performance
items for this candidate. The typed history comparison below measures the
follow-up. Both comparisons cover macOS ARM64 standalone packages.

The retained A/B report is
`populated-profile-performance/verified-populated-performance-ab-measured-v2.json`.
It records median and p95 results, executable and source-patch hashes, and the
raw response digests.

The wire and library checks pass 87 library tests, 899,891 generated protocol
cases, 69,696 JSON round trips, 27,583 contextual Chat cases, and 34,862 worker
envelope comparisons. The exact optimized distribution passes the standalone
checks on all three stores, including 1,762 file hashes, local and hosted
restart, SQL export, and shutdown with a Node-free server PATH.

The encrypted Chat, project, and JSON HTTP/WebSocket comparisons pass on all
three stores. The initial Chat comparison stopped on an outdated duplicate
write expectation in the Node reference run. The updated comparison requires
an exact retry to return the same stored message and a retry with different
protected content under the same key to fail. External PostgreSQL also tests
the conflict between concurrent writers under actual row locks.

### Typed history reads and wire string reuse

The next candidate reads the message columns used by the existing mappers.
PostgreSQL still supplies its JSON timestamp spelling. The mappers still
check the stored message shape, and the generated schemas still check the
encrypted summaries, page boundaries, and response envelope. The query
keeps the same owner joins and sequence ordering.

On the populated external PostgreSQL fixture, the 1,024-row query took
7.19 ms when converting the entire row to JSONB, 4.99 ms with
`row_to_json`, and 2.63 ms with separate columns. These are medians of
20 `EXPLAIN ANALYZE` executions with text serialization after five warmups.
The packaged HTTP comparisons use the production binary protocol.

Valid UTF-8 strings share one backing value. UTF-16 is built when a caller
needs the code units, and ciphertext alphabet checks reuse their result on
the same immutable string. Hashing and equality use the immutable contents.
The wire parser also reuses sibling paths, and JSON output iterates the
ordered key-value entries directly.

| Median measurement       | PGlite before → after | External PostgreSQL before → after | Bundled PostgreSQL before → after |
| ------------------------ | --------------------: | ---------------------------------: | --------------------------------: |
| Complete workload        |   2,597 ms → 2,415 ms |                2,076 ms → 1,936 ms |               2,212 ms → 2,084 ms |
| Project list             |     6.13 ms → 5.37 ms |                  6.08 ms → 5.27 ms |                 6.17 ms → 5.45 ms |
| 50-message page          |     2.97 ms → 2.29 ms |                  3.12 ms → 2.37 ms |                 3.10 ms → 2.41 ms |
| 1,024-message history    |   40.66 ms → 27.28 ms |                41.55 ms → 26.52 ms |               40.63 ms → 26.58 ms |
| Eight-client mixed reads |       467 → 545 req/s |                1,539 → 1,950 req/s |               1,547 → 1,886 req/s |

The optimized macOS ARM64 `1.1.2858` package and the prior `1.1.2857`
package each completed one pilot, five warmups, and 20 measurements per
store. All 156 Rust invocations passed. The compared Rust response bytes
matched for the project list, chat catalog, message page, and full history.
The complete-workload median dropped 5.8–7.0% across the three stores.

The same session ran 52 additional invocations of the compiled Node reference
on matching PGlite and external PostgreSQL profiles. The decoded payloads
matched the Rust responses.

| Median measurement       | Node PGlite | Rust PGlite | Node external PostgreSQL | Rust external PostgreSQL |
| ------------------------ | ----------: | ----------: | -----------------------: | -----------------------: |
| Complete workload        |    4,685 ms |    2,415 ms |                 3,313 ms |                 1,936 ms |
| Readiness                |    1,314 ms |      134 ms |                   950 ms |                    62 ms |
| Idle process-tree RSS    |   1,310 MiB |     100 MiB |                  453 MiB |                   65 MiB |
| Project list             |     7.55 ms |     5.37 ms |                  4.30 ms |                  5.27 ms |
| 50-message page          |     4.10 ms |     2.29 ms |                  2.71 ms |                  2.37 ms |
| 1,024-message history    |    35.21 ms |    27.28 ms |                 23.82 ms |                 26.52 ms |
| Eight-client mixed reads |   328 req/s |   545 req/s |                684 req/s |              1,950 req/s |

The external PostgreSQL median is 2.7 ms higher for the 3.1 MB full-history
response and 1.0 ms higher for the project list. The p95 across full-history
run medians fell from 31.96 ms to 27.48 ms. The lower paged latency, higher
mixed-read throughput, and 42% shorter complete workload justify those
remaining median differences for this local workload. Final shipping
performance and recovery checks retain their separate scope.

The retained report is
`populated-profile-performance/wire-string-performance/verified-populated-performance-measured-v3.json`.
It records all 208 production-entry runs, the executable hashes, the
response digests, and per-store measurements.

The repository, encrypted Chat HTTP, and project-export comparisons pass
on all three stores. The MCP comparison initially found stale captured SQL
in the Node failure assertion. Regenerating the SQL from the current
reference fixed the diagnostic mismatch. The updated comparison passes 756
MCP calls, including 108 checks of exact diagnostics from induced query
failures. The block-boundary ciphertext test checks invalid alphabet bytes,
noncanonical trailing bits, and stable map lookup after the caches fill.
The exact `1.1.2858` standalone distribution passes the 1,762-file verification,
all three backend restart and export cases, and Node-free shutdown.

## Earlier local repository checks

The current Node production build, scoped formatting, server-boundary inventory,
workflow-removal contract and `git diff --check` passed. The tracked performance
summary exactly reproduces every metric from the captured runs.

`pnpm check` stops at the existing Node decomposition budgets:
`build-app.ts` 1,539/1,500 and `chat-turn-runtime.ts` 2,329/1,999. The same check
fails on clean Primary at the candidate base. Later aggregate checks were not
executed or claimed as passing. This milestone changes qualification tooling,
documentation and the coverage ledger; it does not change production Rust code.

## Remaining replacement work

The [profile runtime recovery qualification](RUST_SERVER_PROFILE_RUNTIME_RECOVERY.md)
extends that evidence with real full-worker/native Task state and continuing
Agent/Goal execution across rollback/re-upgrade on all three stores, plus an
external PostgreSQL code-only change with the same URL and profile directory.

The subsequent [historical product-state rollback qualification](RUST_SERVER_HISTORICAL_PRODUCT_ROLLBACK.md)
adds populated old-Node/native/old-Node/native round trips on all three backends,
with exact database comparisons and retained encrypted product writes. Its
synthetic fixture and execution-replay limits remain explicit.

The [default cutover](RUST_SERVER_DEFAULT_CUTOVER.md) and
[production Node retirement](RUST_SERVER_NODE_RETIREMENT.md) are merged.
Final replacement acceptance still needs the supported shipping artifacts,
reconciled product and background-service evidence, and representative
performance, interruption, and rollback checks for the final candidate.
The worker rewrite and shared-crate extraction remain later work.

See [native packaging](RUST_SERVER_NATIVE_PACKAGING.md),
[Winterhold deployment](RUST_SERVER_WINTERHOLD.md) and the
[acceptance reconciliation](RUST_SERVER_ACCEPTANCE_RECONCILIATION.md).
