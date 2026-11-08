# Native server log buffer and archive

The Rust production executable now captures shared operational records in a
bounded minimized buffer and an owned daily filesystem archive. Node remains
the default server; the worker remains Node. Full replacement acceptance remains
incomplete.

## Reproduced production gap

The original real-entrypoint comparison observed healthy HTTP responses and
zero exits from both servers. Node persisted 23 records, including catalog debug
records hidden from its info console. Rust persisted no archive. The regular
Node HTTP fixture calls the app builder directly and does not initialize the
production archive, so it cannot establish this behavior.

The regression harness starts `cantrip_server/src/index.ts` and the native
executable directly. Reference and native data, databases and processes are
isolated. Original failures and subsequent passing reports are retained.

## Capture and lifetime

Shared emission first sanitizes the console record. Capture then minimizes the
persisted record: retain public operational fields and error classes/codes;
replace human messages with the event identity; omit arbitrary bodies, paths,
error messages and stacks. The buffer defaults to 5 MiB, 10,000 entries and
16 KiB per record, retaining the existing fitting, cursor and pagination
semantics. Capture happens before console trace/debug filtering.

Production recovers any pending profile activation before creating the log
directory, initializes the archive before configuration validation, emits the
startup lifecycle and finalizes after service/database shutdown. Startup failure
also drains its fatal record before returning. The serving profile lease remains
owned until the archive thread has drained and joined, so a directory activation
cannot race final log writes. Duplicated launcher output
handles survive embedded PostgreSQL stdio changes. Archive I/O runs on one owned
thread with serialized append, maintenance and close. Close drains accepted
records and joins the thread. The idle UTC boundary timer performs maintenance
without requiring another incoming record.

Catalog diagnostics and account lifecycle diagnostics now use shared capture.
Catalog repeated warnings preserve their actual key, window and summary policy.
Configuration failures retain their Source error class without persisting the
validation body.

## Filesystem behavior

The default directory is the server data directory's `logs` child.
`CANTRIP_SERVICE_LOG_DIR` takes directory precedence over
`CANTRIP_SERVICE_LOG_FILE`; a configured file still selects its legacy basename.
Blank settings use the default. JavaScript whitespace and lexical path resolution
are preserved.

Files use `server-YYYY-MM-DD.part-NNNN.jsonl`. Defaults remain 10 MiB parts,
100 MiB total managed bytes and compression after 48 hours. Active files remain
protected from compression and quota deletion, including a sole active file
larger than the configured quota. Gzip is readable by the existing Node tools.
Actual compressed sizes govern quota; different encoders need not produce
identical gzip bytes.

Initialization recovers recognized interrupted gzip temporaries and migrates
configured legacy names and their `.1` through `.3` parts. Orphan temporaries,
unrelated files remain untouched; directory scans exclude symlink entries. Directories use mode
0700 and newly written files 0600 on Unix. Archive errors produce a direct,
throttled warning, leave the operation queue usable and allow the server to
continue serving. Later operations retry the actual filesystem work.

## Local qualification

- 800 persisted-minimization vectors and 1,280 actual Source buffer operations
  match, including Unicode/lone surrogates, fitting, tiny bounds, cursor reads,
  invalid level values and clear behavior.
- The real-filesystem oracle passes 172 steps across 12 scenarios: rotation,
  active-file quota protection, compression and duplicate completion, temporary
  recovery, legacy migration, restart, directory/append/compression failures and
  recovery, permissions, UTF-16 byte accounting and leap-year scheduling.
- Sixteen production Node/Rust peer runs pass across PGlite, bundled PostgreSQL
  and external PostgreSQL. They exercise a catalog burst followed by immediate
  shutdown, log-directory/file precedence, legacy-file migration, blank settings,
  info/error console thresholds, SIGINT/SIGTERM, configuration failure and actual
  archive obstruction followed by recovery in the same serving process. The
  bundled reference uses a fixture-owned PostgreSQL process; native owns its
  private process directly.
- Native actor tests observe an idle timer compress its previous active file
  after a clock-injected UTC boundary and verify that close retains all 128
  records from four concurrent producers. The timer itself and filesystem work
  are real.

A separate actual-rename suite kills profile activation after each of its four
publication stages. The optimized server recovers through ordinary startup,
archives its lifecycle, preserves the old profile sentinel and retains an
accepted settings write and server identity on restart. This is a fresh external
PostgreSQL/profile-directory test, not a historical legacy conversion claim.
The original failing previous-retained startup is retained.

A real FIFO blocks archive writes while an actual profile activation waits on
its OS lock. Before the lifetime fix, activation completed with the archive still
blocked and the final shutdown record was lost. After the fix, all three local
runs exclude activation until the write is released, retain the shutdown record
and exit zero. FIFO bytes and metadata are retained as fault evidence.

The final optimized macOS arm64 executable has 93,701,168 bytes and SHA-256
`85c6a5d4471914639618cf16c656e00c232a108406eb5b2520c5b85ba86116a8`.
It passes the sixteen production peer runs, four profile interruption/restart
cases and three blocked-write lease cases. Strict all-target Clippy, 78 native
library tests, the record oracle, 37 logging package tests, server build/typecheck,
all sixteen generated graphs/maps and boundary/workflow-removal audits pass.
The repository-wide `pnpm check` stops at unchanged Node decomposition budgets
1,539/1,500 and 2,336/1,999. The separate repository decomposition check also
stops at unchanged `native-commands.ts` 2,284/2,000. Exact baseline file/tool
byte comparisons are retained; downstream aggregate checks were not run.

Calendar and compression-age tests inject a clock; they do not wait 48 hours.
Gzip payloads, filenames and permissions are compared through actual filesystems.
Production lifecycle comparisons normalize timestamps, durations and global
cursor positions. They assert the lifecycle contracts rather than equal total
record counts.

Additional HTTP/Pino, database, bridge and other operational consumers, console
presentation, supported-platform artifacts, packaged acceptance and performance
remain required. This milestone does not establish complete production logging
parity or full server replacement.
