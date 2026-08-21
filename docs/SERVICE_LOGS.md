# Service Logs

Cantrip exposes a bounded, read-only service console in **Settings → Logs**.
It is intended for diagnosing the Cantrip client, its local embedded runtime,
and linked worker processes without granting filesystem or terminal access.

## Operational record contract

Server, worker, and deliberate client events use one structured logging path.
Each event is normalized and sanitized once, then the same safe record is sent
to the component console, bounded service buffer, and daily JSONL archive where
that component has one. Settings → Logs reads those records through the
authorized transports below. Console output may be formatted for humans, but
it represents the same timestamp, level, message, and context as the service
record; there is no separate raw console event.

Operational context uses a small shared vocabulary when the fields apply:
`event`, `subsystem`, `operation`, `status`, `reasonCode`, `durationMs`,
`requestId`, `workerId`, `projectId`, `chatId`, `turnId`, `workflowId`,
`runId`, `surfaceId`, `attempt`, and `counts`. Errors are reduced to safe
`name`, `message`, and optional `code` metadata. Stack traces, causes, and
arbitrary thrown-object fields are excluded from remotely readable records.

Levels have consistent meanings:

- `fatal` is an unrecoverable process-level shutdown;
- `error` is a permanent operation failure or broken user functionality;
- `warn` is a recoverable failure, retry, degradation, or fallback;
- `info` is a meaningful, uncommon lifecycle transition;
- `debug` is routine routing, cache, and state-transition detail; and
- `trace` is sampled high-volume transport diagnostics only.

Callers explicitly rate-limit repetitive failures. The first event is emitted,
identical events inside the configured window are suppressed, and periodic
summary records expose a repeat count. High-volume diagnostics use deterministic
sampling. Heartbeats, frames, pointer input, terminal resize/input/output,
streamed model deltas, polling ticks, and other hot-loop data are not logged.

## Following one operation across components

Operational records answer four questions without exposing the work itself:
what started, where it was routed, how long it took, and why it failed or
recovered. Search stable IDs instead of prompt text or terminal commands.

For a chat turn, start with `chatId` and `turnId` from the client submission
record. The server adds `requestId`, `workerId`, route, queue, and placement
transitions. The worker retains the chat/turn IDs while it logs Codex process
readiness, thread create/resume, dispatch, provider failover, compaction,
interruption, and completion. A normal trace resembles:

```text
client  chat.turn.submitted
server  chat.turn.queued → chat.turn.placement.selected → worker.command.dispatched
worker  worker.command.started → codex.runtime.ready → codex.turn.started
worker  codex.turn.completed → worker.command.completed
server  worker.command.completed → chat.turn.completed
client  chat.turn.synchronized
```

Names may evolve, so filters should prefer correlation IDs. Missing completion
plus a worker reconnect identifies a transport/runtime problem; an explicit
`status: failed` and `reasonCode` identifies an application failure. Raw
provider messages are deliberately absent. Apply the same method to workflows
(`workflowId`, `runId`), surfaces (`surfaceId`, `workerId`), and project
operations (`projectId`, `workerId`).

## Coverage by subsystem

| Area                      | Representative lifecycle metadata                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Server runtime            | startup class, database/Redis readiness, migrations, shutdown, ownership and lease transitions                                |
| Worker channel            | authentication outcome, connect/replacement/disconnect, reconnect grace, command type and duration                            |
| Chat and Codex            | queue/placement, model route, thread create/resume, attempts, pause/resume/steer/interrupt, compaction and failover           |
| Providers                 | catalog/cache health, model counts, account availability, quota exhaustion, credential refresh outcome and fallback           |
| Workflows and automations | claim/fence, schedule sync, execution transition, retry, skip/block, completion and recovery                                  |
| Terminal                  | create/attach/detach/reconnect/replace/exit; never input, output, resize data, or commands                                    |
| Browser                   | Chromium/CDP/target/navigation/crash/restart and transport state; never page data or cookies                                  |
| Remote Desktop            | discovery counts, target ID, capture/WebRTC lifecycle, drop summaries and rejected-input reason; never frames or input values |
| Explorer and Git          | operation kind, safe revision/branch metadata, duration, result/file/conflict counts; never contents or diffs                 |
| Code and CLI              | process/profile/session/bridge readiness, transport, command family and result; never raw arguments or protocol               |
| Client                    | boot/hydration, session/server switch, API route/status, live reconnect, rollback and surface readiness/fallback              |
| Tauri                     | embedded child startup/exit, updater phase, tray/autostart/window/pop-out and Pro Mode lifecycle                              |

Routine successes may be `debug`; state changes and uncommon lifecycle events
are `info`; recoveries/fallbacks are `warn`; terminal failures are `error`.
Severity-filtered records still advance the source cursor and are not replayed.

## Available sources

| Source                      | Where it appears                                                         | Transport                                                                 |
| --------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| **Client · This device**    | Every client                                                             | An in-memory buffer; desktop and mobile also retain a local daily archive |
| **Server · Local internal** | Tauri only, while connected to that installation's embedded local server | A fixed-source Tauri command reads the local daily server archive         |
| **Worker · _name_**         | Every worker linked to the active account                                | Cursor polling through the authenticated server-to-worker command channel |

The local server source is deliberately strict. It appears only when all of
the following are true:

- the client is running under Tauri;
- the selected server profile is `kind: local`;
- the selected server origin matches the Tauri runtime's own server origin;
- `/api/bootstrap` identifies a local Tauri deployment.

There is no server-self-log HTTP endpoint. A browser or phone connected to a
hosted server cannot read that server's process logs. It can read an online
linked worker's logs because the request is owner-authorized by the server and
routed over the worker's existing outbound command channel. The app never
connects directly to a worker.

When a worker is managed by the current Tauri installation, its local daily
archive is used as a fallback. This preserves startup failures that occurred before
the worker command channel came online. An unreachable remote worker cannot
supply new lines or post-crash history; the viewer retains lines already
received and reports the source as offline.

## Viewer controls

The Logs page provides:

- source selection, using a rail on wider screens and a dropdown on compact
  layouts;
- text search and minimum-severity filtering;
- follow-tail and display pause/resume controls;
- clear, copy, and text export actions for the currently visible result; and
- connection, fallback, truncation, retry, and offline status.

Pausing freezes only the displayed boundary. Polling and bounded buffering
continue, so resuming reveals records that arrived while paused. Clearing
removes the matching records from this viewer session and does not modify the
underlying service file or worker buffer.

The console uses fixed-height row virtualization. The UI retains at most
10,000 records and approximately 5 MiB per source. Log contents are not saved
to browser storage or Postgres.

## Daily archive behavior

Cantrip uses the following daily archive contract for persistent service logs.
Browser clients remain memory-only.

### Package boundary

Daily archive behavior belongs in the existing `@cantrip/logging` package.
Cantrip will not introduce a generic `cantrip_core` package for this work. The
repository already uses focused shared packages, and logging policy should
remain independently testable without becoming a dependency for unrelated
features.

The package will expose environment-specific entrypoints:

```text
@cantrip/logging/core       Environment-neutral logger and noise controls
@cantrip/logging/records    Record types, sanitization, and minimization
@cantrip/logging/archive    Pure-TypeScript daily archive coordinator
@cantrip/logging/node       Node filesystem and gzip adapter
```

`@cantrip/logging/archive` must not depend on Node, React, Tauri, or Capacitor.
It will coordinate an injected clock and storage adapter and expose lifecycle
operations equivalent to `initialize`, `append`, `maintain`, `flush`, and
`close`. Platform adapters own filesystem access, compression, atomic rename,
and deletion.

The coordinator serializes writes and maintenance through one queue. Storage
failures report through a separate, rate-limited diagnostic sink so that a
failed log write cannot recursively log itself or terminate the component.

### Archive contract

Every client, server, and worker instance receives its own archive directory
and independent 100 MiB archive budget. The directories and budgets remain
separate when all three processes run on one machine in Tauri internal mode.
Multiple workers likewise receive distinct directories and independent
budgets.

Daily boundaries use UTC, matching the ISO timestamps already stored in log
records. Canonical files are sanitized structured JSONL:

```text
client-2026-08-21.part-0001.jsonl
client-2026-08-18.part-0001.jsonl.gz

server-2026-08-21.part-0001.jsonl
server-2026-08-18.part-0001.jsonl.gz

worker-2026-08-21.part-0001.jsonl
worker-2026-08-18.part-0001.jsonl.gz
```

Normal traffic produces one or more 10 MiB parts per source per UTC day. Parts
ensure quota enforcement never needs to rewrite an open file and a very noisy
day cannot monopolize the archive:

```text
client-2026-08-21.part-0001.jsonl
client-2026-08-21.part-0002.jsonl
```

The next part opens before a write would take the active part above 10 MiB. A
single bounded record may cause a small temporary overshoot, after which
maintenance restores the archive budget. Parts sort by UTC day and part number
for compression, reading, export, and oldest-first deletion.

Only files matching the managed naming contract are eligible for compression
or deletion. Temporary export bundles are stored outside the archive and do
not count against its 100 MiB budget.

### Launch and UTC rollover lifecycle

At component launch, the archive performs these operations in order:

1. Create the component's log directory if it does not exist.
2. Open the newest non-full part for the current UTC day, or create part 1.
3. Recover or remove stale temporary compression artifacts.
4. Compress inactive parts created more than 48 hours ago.
5. Recalculate the combined size of compressed and uncompressed managed files.
6. Delete complete files oldest-first while the archive exceeds 100 MiB.
7. Schedule the next UTC day boundary.

At a UTC day change, the writer flushes and closes the previous part, opens or
resumes the current day's part, runs the same compression and quota pass, and
schedules the next boundary. Every append also performs a cheap UTC-day check
so sleep, clock changes, delayed timers, or process suspension cannot leave a
writer attached to yesterday's file.

The coordinator tracks archive bytes during normal writes. Crossing 100 MiB
triggers quota maintenance immediately instead of allowing an oversized
archive to remain until the next launch or day boundary. The active part is
never deleted while open; it is first finalized and replaced when it must
become eligible for oldest-first deletion.

Mobile applications cannot execute while suspended. They run the same check
when returning to the foreground and before their next persisted write.

### Compression and deletion safety

Inactive parts become compression candidates only after their creation time is
more than 48 hours old. Filesystem creation time is preferred; platforms that
cannot provide it use conservative UTC filename metadata so a file is never
compressed early.

Compression uses gzip level 9 and an atomic replacement sequence:

1. Stream the JSONL source into a sibling `.jsonl.gz.tmp` file.
2. Finish and close the gzip stream.
3. Atomically rename the temporary file to `.jsonl.gz`.
4. Remove the source JSONL only after the rename succeeds.

A failed or interrupted compression leaves the original JSONL readable. A
later maintenance pass may retry it. Stale temporary files are never counted
as completed archives and may be removed only after confirming the source or
completed gzip remains available.

After all eligible compression finishes, quota enforcement sums every managed
`.jsonl` and `.jsonl.gz` file in the component archive. It deletes whole files
in logical creation order until the sum is at most 100 MiB. Compressed and
uncompressed files count equally by their actual on-disk size.

### Platform placement and behavior

| Runtime               | Archive location and adapter                                                                |
| --------------------- | ------------------------------------------------------------------------------------------- |
| Standalone server     | `<CANTRIP_DATA_DIR>/logs`, using the Node adapter                                           |
| Standalone worker     | `<CANTRIP_WORKER_DATA_DIR>/logs`, using the Node adapter                                    |
| Tauri client          | `<app-data>/logs/client`, using trusted Rust filesystem operations                          |
| Tauri internal server | `<app-data>/logs/server`, with its own 100 MiB component budget                             |
| Tauri worker          | `<app-data>/logs/workers/<worker-id>`, with an independent 100 MiB budget for each worker   |
| iOS/Android client    | App-private, non-cloud-backed client log storage through a Capacitor adapter                |
| Browser client        | No persistent archive; the existing bounded in-memory client buffer remains the only source |

The Node adapter streams gzip through Node's filesystem and zlib APIs rather
than loading a complete part into memory. Server and worker persistence becomes
the default even when `CANTRIP_SERVICE_LOG_FILE` is not configured. Existing
deployment overrides remain compatible or migrate to an explicit log-directory
override.

Tauri retains a small Rust implementation because the native shell owns local
filesystem access and can emit startup records before React runs. The Rust
implementation follows the same policy contract and shared test vectors as the
TypeScript archive coordinator. The webview does not receive arbitrary local
filesystem access.

Mobile uses a Capacitor filesystem adapter and a browser-safe streaming gzip
implementation that accepts compression level 9. Foreground/resume events run
overdue rollover and maintenance. Browser builds must not bundle or invoke any
Node or native filesystem adapter.

### Canonical records and legacy migration

The retained archive contains the same minimized, sanitized operational
records used by the service buffers. User prompts, model transcripts, terminal
contents, provider payloads, raw subprocess output, and credentials remain
outside the archive. Compression and export do not weaken the redaction
boundary.

Separate packaged Tauri `server.log`, `worker.log`, and linked-worker stdout
files are retired because bootstrap and unexpected-exit diagnostics have
equivalent bounded structured events. Sanitized structured JSONL is the
only canonical persistent service log, preventing duplicate data from evading
the component budget.

The first daily-archive maintenance pass adopts existing files matching the
old rotation scheme:

```text
*.service.jsonl
*.service.jsonl.1
*.service.jsonl.2
*.service.jsonl.3
```

Legacy files are assigned stable logical creation metadata, preserved as
recognized archive files, compressed when eligible, and included in the
100 MiB quota. Migration must not parse or move an arbitrary path supplied by
the client.

### Archive controls

The existing copy, clear, and **Export visible output** controls remain scoped
to the records currently loaded in the viewer. A separate archive-level action
is runtime-specific:

- **Desktop — Open Logs Folder:** a fixed Tauri command resolves and opens the
  parent Cantrip application logs directory in Finder, Explorer, or the
  platform file manager. The frontend cannot supply a path. In internal mode
  this directory contains separate client, server, and worker subdirectories
  with independent budgets.
- **Mobile — Export Device Logs:** the client creates one temporary
  `cantrip-client-logs-<timestamp>.zip` containing only that mobile client's
  retained `.jsonl` and `.jsonl.gz` files, copies the bundle to a shareable
  cache location, and opens the native share sheet. The next launch removes
  stale export bundles.
- **Browser:** no archive-level action is shown because no browser archive
  exists. Exporting currently visible in-memory records remains available.

Mobile export deliberately excludes server and worker archives. Future support
and diagnostic collection modes may add authorized multi-component gathering,
but that is outside this plan.

### Implementation surfaces

The environment-neutral coordinator and Node adapter live in
`@cantrip/logging`. Server and worker startup initialize their archives before
the first lifecycle event and flush them during orderly shutdown. Tauri uses a
matching Rust writer/reader for native startup coverage. Capacitor uses the
same coordinator with app-private filesystem storage and reruns maintenance
when the app returns to the foreground.

### Acceptance criteria

Automated tests must establish that:

- launching twice on the same UTC day resumes the newest non-full part;
- writes open a new part before the current part would exceed 10 MiB;
- a UTC day change cannot append new records to the previous day;
- files at or below 48 hours of age are never compressed;
- interrupted compression preserves a readable source;
- compressed and uncompressed files both count toward quota;
- deletion is oldest-first, restores the archive to at most 100 MiB, and never
  touches an unrelated file;
- concurrent writes, rollover, compression, and deletion remain serialized;
- server, worker, and client archives enforce independent quotas;
- browser runtimes never invoke persistent filesystem APIs;
- a resumed mobile client runs overdue maintenance;
- desktop opens only Cantrip's fixed logs directory;
- mobile export includes all and only the retained local client archive; and
- existing sanitization, minimization, and remote log authorization guarantees
  remain intact.

Focused verification covers the logging package, server, worker, app, Tauri,
Android, and iOS targets. A manual clock-driven smoke pass must also exercise a
same-day restart, a simulated UTC rollover, compression eligibility, quota
deletion, desktop folder opening, mobile background/resume, and mobile export.

## Retention and limits

Server and worker process buffers are bounded by both count and approximate
serialized size. Defaults are:

- 10,000 records;
- 5 MiB total;
- 16 KiB per record; and
- 500 records per read.

Persistent component archives retain at most 100 MiB of managed `.jsonl` and
`.jsonl.gz` files. Active UTC-day files are split into 10 MiB parts, inactive
parts older than 48 hours are compressed with gzip level 9, and quota cleanup
deletes complete files oldest-first. The local Tauri reader accepts a fixed
source enum, not a path. Linked-worker directories are resolved only from
workers registered to that installation.

Remote worker reads use monotonically increasing cursors. The viewer polls
while open, backs off to six seconds during failures, and resumes from the last
cursor for each transport. Records are deduplicated by transport and cursor so
switching between a remote stream and a local fallback does not replay the
entire buffer.

## Redaction boundary

Structured records are sanitized before entering remotely readable buffers or
daily diagnostic archives. Sanitization removes terminal control sequences and
redacts common secret-bearing fields and text patterns, including:

- Authorization and Cookie values;
- bearer/basic credentials;
- API, access, and refresh tokens;
- passwords, private keys, and provider credentials;
- pairing and enrollment codes; and
- URL credentials and sensitive query parameters. When a URL contains a
  signing parameter such as `signature`, `x-amz-signature`, or
  `x-goog-signature`, every query value is redacted because the complete URL is
  a credential.

Cantrip service logging is for lifecycle, routing, and diagnostic metadata. It
must not include user prompts, model transcripts, terminal contents, or raw
Codex subprocess output. Redaction is a final safety boundary, not permission
to add those payloads to service logs.

## Development behavior

`pnpm devtop` prepares these ignored files before starting the normal colored
development lanes:

```text
.cantrip/dev/logs/client/
.cantrip/dev/logs/server/
.cantrip/dev/logs/worker/
```

The server and worker tee structured records to those archives without
suppressing their development terminal output. The Tauri webview relay
continues to print `[client:<window>:<level>]` records in the `desktop` lane and
also writes the client archive. Startup resumes existing same-day parts rather
than deleting development history.

Plain browser `pnpm dev` keeps **Client · This device** and remote worker
sources, but it cannot read a local server file. This is intentional: browser
development does not receive a local-server-log security exception.

### Development files and parity

The `server`, `worker`, and `desktop` terminal lanes and their JSONL records are
fed by the same normalized event. Human console formatting may omit noisy
context fields or add color, but timestamp, component, level, message, and safe
context originate from one sanitized record. Incidental webview `console.*`
calls are captured as client diagnostics; deliberate application events use
the structured client logger so their context remains searchable.

To compare a lane with Settings → Logs, select its source and filter by an event
or correlation ID. Ordinary HTTP access logs belong to Fastify's server lane;
they are not duplicated into the client source.

## Verification matrix

| Guarantee                                                                       | Primary automated checks                                                         |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| One sanitized record fans to console and service sinks                          | logging core/formatter tests plus server and client logger tests                 |
| Secret, OAuth, cookie, signed-URL, nested-error, and control-sequence redaction | logging records, client relay, and Tauri `local_logs` tests                      |
| Repetition summaries and deterministic sampling                                 | logging core tests                                                               |
| Bounded records/buffers, filtered cursors, truncation, and daily archives       | logging archive/record and Tauri `local_logs` tests                              |
| Remote reads remain owner-authorized and server-routed                          | server worker-log API tests                                                      |
| Hosted clients cannot expose server logs                                        | log viewer model and local bridge tests                                          |
| Local worker fallback and viewer retention/deduplication                        | log viewer model tests                                                           |
| Surface, provider, workflow, and reconnect lifecycle                            | focused server, worker, app, and Tauri subsystem suites plus the inventory above |

For a release candidate, run the logging, protocol, server, worker, app, and
Tauri suites. Then perform one `pnpm devtop` smoke pass: complete or interrupt a
chat; open and close Terminal, Browser, Explorer, Git, Code, and Remote Desktop
where supported; refresh a provider catalog; and reconnect the worker. Confirm
useful lifecycle transitions appear in the colored lane and the matching Logs
source, repeated failures collapse, and no user payload appears in an export.

## Troubleshooting

- **Server source missing:** confirm the selected profile is the desktop
  installation's **Local** server and that the server bootstrap reports local
  Tauri mode.
- **Worker reconnecting:** confirm the worker is online on **Settings →
  Workers**. The viewer retries automatically and preserves the last cursor.
- **Local fallback shown:** the server-routed stream failed, but this desktop
  installation owns that worker and can still read its fixed local log.
- **Old records rotated:** the requested cursor fell behind the bounded source
  buffer. The viewer continues from the oldest record still available.
- **No records in `pnpm devtop`:** inspect the component directories below
  `.cantrip/dev/logs/` and confirm the root command supplied
  `CANTRIP_SERVICE_LOG_DIR` to the server and worker.
- **A turn appears stuck:** filter available sources by `chatId`, then
  `turnId`. The last component to emit a start without completion identifies
  the failing boundary. Check nearby worker disconnect, app-server exit, and
  provider fallback events.
- **Repeated failure noise:** rate-limited callers emit the first failure and
  periodic `reasonCode: repeated-event` summaries. Identical unsummarized
  records from a hot loop are a logging defect; report the event/subsystem, not
  the sensitive payload that triggered it.
- **Exporting for support:** pause if needed, filter to the relevant IDs and
  time range, then export. Records are sanitized before the viewer, but safe
  project/worker/chat IDs may still be operationally private.
