# Service Logs

Cantrip exposes a bounded, read-only service console in **Settings → Logs**.
It is intended for diagnosing the Cantrip client, its local embedded runtime,
and linked worker processes without granting filesystem or terminal access.

## Available sources

| Source | Where it appears | Transport |
| --- | --- | --- |
| **Client · This device** | Every client | An in-memory browser buffer; Tauri also reads its local rotated client log |
| **Server · Local internal** | Tauri only, while connected to that installation's embedded local server | A fixed-source Tauri command reads the local rotated server log |
| **Worker · _name_** | Every worker linked to the active account | Cursor polling through the authenticated server-to-worker command channel |

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
- URL credentials and sensitive query parameters.

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
