# Service Logs

Cantrip exposes a bounded, read-only service console in **Settings → Logs**.
It is intended for diagnosing the Cantrip client, its local embedded runtime,
and linked worker processes without granting filesystem or terminal access.

## Operational record contract

Server, worker, and deliberate client events use one structured logging path.
Each event is normalized and sanitized once, then the same safe record is sent
to the component console, bounded service buffer, and rotated JSONL file where
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

| Source                      | Where it appears                                                         | Transport                                                                  |
| --------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| **Client · This device**    | Every client                                                             | An in-memory browser buffer; Tauri also reads its local rotated client log |
| **Server · Local internal** | Tauri only, while connected to that installation's embedded local server | A fixed-source Tauri command reads the local rotated server log            |
| **Worker · _name_**         | Every worker linked to the active account                                | Cursor polling through the authenticated server-to-worker command channel  |

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

When a worker is managed by the current Tauri installation, its local rotated
log is used as a fallback. This preserves startup failures that occurred before
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

## Retention and limits

Server and worker process buffers are bounded by both count and approximate
serialized size. Defaults are:

- 10,000 records;
- 5 MiB total;
- 16 KiB per record; and
- 500 records per read.

Packaged Tauri diagnostics use a 5 MiB JSONL file plus three rotated files for
each local service source. The local Tauri reader accepts a fixed source enum,
not a path. Linked-worker paths are resolved only from workers registered to
that installation.

Remote worker reads use monotonically increasing cursors. The viewer polls
while open, backs off to six seconds during failures, and resumes from the last
cursor for each transport. Records are deduplicated by transport and cursor so
switching between a remote stream and a local fallback does not replay the
entire buffer.

## Redaction boundary

Structured records are sanitized before entering remotely readable buffers or
rotated diagnostic files. Sanitization removes terminal control sequences and
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
.cantrip/dev/logs/client.jsonl
.cantrip/dev/logs/server.jsonl
.cantrip/dev/logs/worker.jsonl
```

The server and worker tee structured records to those files without
suppressing their existing terminal output. The Tauri webview relay continues
to print `[client:<window>:<level>]` records in the `desktop` lane and also
writes the client JSONL file.

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
| Bounded records/buffers, filtered cursors, truncation, and JSONL rotation       | logging record/rotation and Tauri `local_logs` tests                             |
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
- **No records in `pnpm devtop`:** inspect `.cantrip/dev/logs/` and confirm the
  root command supplied `CANTRIP_SERVICE_LOG_FILE` to the server and worker.
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
