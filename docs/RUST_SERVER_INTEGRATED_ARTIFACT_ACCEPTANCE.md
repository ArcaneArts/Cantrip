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

## Production-entry performance sample

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

## Local repository checks

The current Node production build, scoped formatting, server-boundary inventory,
workflow-removal contract and `git diff --check` passed. The tracked performance
summary exactly reproduces every metric from the captured runs.

`pnpm check` stops at the existing Node decomposition budgets:
`build-app.ts` 1,539/1,500 and `chat-turn-runtime.ts` 2,329/1,999. The same check
fails on clean Primary at the candidate base. Later aggregate checks were not
executed or claimed as passing. This milestone changes qualification tooling,
documentation and the coverage ledger; it does not change production Rust code.

## Remaining replacement work

Complete the encryption-ready existing-client desktop/update matrix, broader
historical-profile and product-state rollback, outstanding product/background
and interruption/coordination coverage, supported platform acceptance and
representative performance. Then select Rust by default across production
build/launch/deploy paths and remove the production Node server. The worker
rewrite and shared-crate extraction remain later work.

See [native packaging](RUST_SERVER_NATIVE_PACKAGING.md),
[Winterhold deployment](RUST_SERVER_WINTERHOLD.md) and the
[acceptance reconciliation](RUST_SERVER_ACCEPTANCE_RECONCILIATION.md).
