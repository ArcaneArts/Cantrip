# Native execution across server rollback

The macOS ARM64 matrix passed again with the standalone Rust `1.1.3032`
executable, compiled Node reference and full packaged worker running native
Codex. Across the four cases below, eight implementation switches retained the
same worker process, held model streams, completed Task state and decrypted
history. The same-database PostgreSQL case also retained the database URL and
profile directory.
[macOS 1.1.3032 rollback report](security/rust-server-3032-macos-profile-rollback.json)

The original local run used Rust `1.1.2779`, Node `1.1.2782` and patched
Codex `0.166.0`.

## Executed cases

| Case                            | Implementations and storage                                         | Operation                                                                                        |
| ------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Embedded profile                | Native PGlite → JavaScript PGlite → native PGlite                   | Offline complete-profile conversion into private copies                                          |
| Private PostgreSQL profile      | Bundled PostgreSQL → JavaScript PGlite → bundled PostgreSQL         | Offline complete-profile conversion; native process management stays real                        |
| External PostgreSQL profile     | External PostgreSQL → JavaScript PGlite → external PostgreSQL       | Explicit logical migration; destination PostgreSQL databases are newly created isolated fixtures |
| External PostgreSQL code change | Rust → Node → Rust on the same PostgreSQL URL and profile directory | No restore or backend change; exports serve as retained backups                                  |

The four cases complete 80 product steps, 48 controlled model POSTs, 28 clean
worker stops and 28 server generations. Eight server generations are
intentionally SIGKILLed; all other server generations exit cleanly. Every
generation reports the original durable server identity through real bootstrap.

Each case first completes four real Tasks, including planning/Goal, retry and
admission recovery. Their six planning rounds and decrypted histories are
retained. The existing Task suite also performs ordinary server restarts; these
remain part of the test rather than being mistaken for extra implementation
changes.

The existing Agent/Goal driver then holds the actual native model response while
the controller kills the server and switches implementation. The same full
worker process, stored credential and original native response remain alive.
After reconnect, the real browser SDK restores Live scopes and reads/decrypts
the history. The held response is released and execution completes. Goal
identity/objective/budget remain stable and its accounting cannot regress.
The original inference is not repeated. The subsequent existing cold-worker,
canonical-turn identity and history assertions also remain active.

Completed Task DTOs and decrypted messages are read through the browser before
and after both switches. All four Tasks remain byte-for-byte equivalent as
structured results, including their completed state and history.

Only the public model HTTP response is controlled. Server entry points,
browser SDKs, encryption, worker command handling and native execution are
real. No SQL fixture route, substitute worker bridge or permanent JavaScript
database helper is installed in a serving native process.

## Database and file preservation

At each stopped-server boundary, the actual database is snapshotted without
migrations. All 136 public/Drizzle tables and three sequences are compared
through logical export/import, with the exact additional native import receipt
and its timestamp verified separately. Source exports leave every row and
sequence unchanged. Row comparisons use sorted `to_jsonb(t)::text` strings, so
large SQL numbers never round-trip through JavaScript numbers for equality.

The files listed by the complete-profile manifest are checked against actual
bytes and hashes. For same-directory code changes, every original JSONL log
byte remains as an exact prefix while the running replacement appends startup
records. Other original files keep their full checksums. Before startup, logs
are also checked in full. Operational logging is not disabled to obtain a pass.

Actual canonical history items, turns, stream/commit receipts, native commands,
Task rounds and encrypted messages are present in these profiles. This extends
the populated historical fixture's deliberately empty history checkpoint with
real worker/native history and continuing execution.

A separate scan inspected 9,635 row occurrences across the sixteen offline
source/target snapshots for ten known private Agent/Goal and Task payload texts;
none appeared in stored string values. This is scoped evidence for these
payloads, alongside the existing encryption/privacy coverage, not an exhaustive
privacy proof.

Production profiles have no artificial migration-probe table. The snapshot
helper now queries its probe only when that table exists. The previous populated
historical PGlite round-trip also passes with its probe present, retaining its
137-table/four-sequence numeric, binary, null and literal checks.

## Run locally

Build the production Node reference and browser workspace packages:

```sh
pnpm server:reference:build
pnpm --filter @cantrip/crypto... build
pnpm --filter @cantrip/nbt --filter @cantrip/glitch build
```

Provide the built full worker and native runtime through
`CANTRIP_TEST_WORKER_PACKAGE`, `CANTRIP_TEST_CLI_BIN` and `CANTRIP_CODEX_BIN`.
The PostgreSQL fixture can use an existing `database-fixture` executable through
`CANTRIP_RUST_DATABASE_FIXTURE_BINARY`. Build the disposable
`database-transfer-fixture` example for the snapshot argument.

```sh
node scripts/server-rust/profile-runtime-acceptance.mjs \
  --native-assets /absolute/path/to/native-distribution \
  --profile-converter /absolute/path/to/packaged-profile-converter \
  --profile-snapshot-probe /absolute/path/to/database-transfer-fixture \
  --report-directory /absolute/path/to/new-evidence-parent
```

The default command runs all four cases. Repeat `--database` to select storage
modes; selecting `postgres` also includes its same-database code-change case.
The command retains per-case logs, complete reports, private fixture profiles
and post-execution checksums for the supplied artifacts. The profiles contain
synthetic private data and are local QA evidence.

Earlier failures remain recorded: unbuilt NBT/Glitch exports prevented the first
browser bootstrap; the first summary checker incorrectly assumed exactly three
server starts despite the Task suite's ordinary restarts; and the first
same-directory file check incorrectly required a running logger to stop
appending. The corrected checks preserve every server identity/exit invariant
and every original log byte.

## Remaining acceptance

This is local macOS qualification. The same-database case uses loopback HTTP;
the separate Winterhold rehearsal covers HTTPS/TLS and service operation.
It does not establish every supported-platform artifact, full desktop
installation/update or prolonged distributed fault scenario. The existing
desktop QA app is still alive with macOS Keychain access waiting while the
console is locked; its identity and vault have not been replaced.

Focused local checks pass. `pnpm check` still stops at the existing Node file
budgets: `build-app.ts` 1,539/1,500 and `chat-turn-runtime.ts` 2,329/1,999.
Those aggregate results describe the original milestone. The server now
defaults to Rust, and the worker runs on Node.
