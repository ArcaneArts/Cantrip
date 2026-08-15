# Importing ChatGPT Codex chats

Cantrip's native macOS and Windows app can import compatible local ChatGPT
Codex conversations into a Cantrip project. An import is a **resumable fork**:
the source conversation remains unchanged, while Cantrip stores its own
canonical transcript and creates a new Cantrip-managed Codex thread for future
messages.

## User flow

Open **Project Settings → General**. When a project replica is present on a
macOS or Windows worker with a compatible local Codex history store, the
**ChatGPT Codex** card reports the matching chat count. **Import chats** opens a
metadata-only browser with search, archive filtering, multi-select, source
worker and working-directory details, and durable already-imported status.

Before starting an import, choose or confirm:

- the destination project worktree or automatic server placement;
- the Cantrip model, optional route, and optional provider account for future
  messages;
- the permission profile and Default or Plan conversation mode; and
- explicit consent to copy the selected transcripts and safe attachments to
  the Cantrip server.

The import activity list follows durable progress through Cantrip's application
live transport. A disconnected live channel uses a bounded HTTP recovery poll.
Completed imports open as ordinary Cantrip chat tabs. If transcript storage
succeeds but runtime hydration does not, **Open transcript** still exposes the
canonical history and **Retry** resumes only the safe remaining stage.

The card is intentionally absent from browser, Capacitor, and Linux desktop
clients. Discovery belongs to a worker that can access the user's local Codex
data; the app never opens local Codex files or talks directly to a worker.

## What is preserved

Cantrip uses Codex App Server `thread/list` for metadata discovery and
`thread/read` with `includeTurns` only after selection. The shared transcript
normalizer preserves supported user and assistant messages, command and file
activity, tool notices, errors, turn summaries, timestamps, ordering, source
model/provider metadata, working-directory and worktree attribution, and plan
information when the source exposes it. Unknown Codex items become bounded
warning activity instead of crashing or silently changing the transcript.

Available local image and audio attachments are copied through Cantrip's
bounded attachment transport. Missing, changed, unsupported, oversized, or
unsafe-path attachments become visible warnings/placeholders and do not discard
the rest of the conversation.

The following cannot be preserved exactly:

- the original source thread ID as the active Cantrip runtime;
- transient source process state, approvals, pending prompts, or in-progress
  turns;
- authentication, tokens, caches, or other files from the external Codex home;
- unsupported internal, ephemeral, subagent, or child threads;
- attachments that no longer exist or fail confinement and integrity checks;
  and
- source-only item shapes that the pinned Cantrip Codex boundary cannot safely
  represent.

## Ownership and multi-worker behavior

The app calls the server. The server authorizes the owner and project, fans
metadata requests only to project workers with the external-history
capability, owns the durable import job, resolves destination placement, and
publishes progress. Each worker reads only the external history on its own
machine. Results retain source-worker identity, so matching histories on two
machines never collapse into one source.

The source and destination may be different workers. The source worker reads
and stages selected history; the server routes bounded attachment chunks and
canonical state; the destination worker creates and verifies the managed Codex
thread in its isolated Cantrip `CODEX_HOME`. Destination selection uses the
normal project replica/worktree placement resolver rather than assuming the
source machine is also the execution machine.

Source identity is unique per owner, source kind, source worker, safe source
home fingerprint, and external thread ID. Discovery annotates a chat that was
already imported, including when the destination was another project, and the
UI prevents a duplicate request. The database uniqueness boundary remains the
final race-safe guard.

## Privacy and source safety

Initial discovery reads metadata only. Full turns and attachments are requested
only for chats the user selected after acknowledging the copy. Cantrip does not
copy or expose `auth.json`, access tokens, source credentials, caches, the
external SQLite database, or rollout files. It does not mutate, repair, resume,
or start turns in the external store.

The worker launches a separate source App Server against the candidate external
Codex home and limits it to the read operations required for discovery/import.
It prefers state-database-only listing, rejects active, ephemeral, child, and
ambiguous chats, revalidates project matching during the selected read, and
fails closed when the pinned reader cannot safely interpret the source. Logs
contain job, project, worker, stage, state, and error-code identifiers, never
message bodies, source thread IDs, source-home paths, or credentials.

## Compatibility and retry behavior

The source reader and destination runtime must fall within Cantrip's pinned
[Codex compatibility policy](CODEX_RUNTIME_COMPATIBILITY.md). Missing stores,
unsupported platforms, incompatible responses, offline workers, timeouts, and
partial fleet results appear as bounded source or worker messages. One failed
worker does not suppress healthy results from another.

Worker disconnects produce a durable retryable state. Reconnection requeues
eligible jobs, while an explicit Retry action uses a state revision to reject
stale clicks. Server restart recovery distinguishes pre-canonical reads from
post-canonical hydration, so a saved transcript is not reread merely because
the runtime stage was interrupted. Non-retryable source changes, project
mismatches, or compatibility failures remain visible with their canonical chat
when one was already created.

## Protocol and persistence

The shared protocol defines:

- `external.chat-history.discover`, `.read`, attachment read, and attachment
  release worker commands;
- metadata, compatibility, transcript, attachment, import selection, progress,
  error, state, and already-imported reference schemas; and
- project discovery plus durable import list/detail/retry HTTP responses.

The server exposes:

- `GET /api/projects/:projectId/external-chat-history`
- `POST /api/projects/:projectId/chat-imports`
- `GET /api/projects/:projectId/chat-imports`
- `GET /api/chat-imports/:jobId`
- `POST /api/chat-imports/:jobId/retry`

Migrations `0083_complex_terrax.sql`, `0084_conscious_toad_men.sql`, and
`0085_confused_night_nurse.sql` add owner-scoped `chat_import_jobs` state with
unique idempotency and source identities, lease and attempt fencing,
progress/error fields, canonical chat linkage, selected runtime routing, source
metadata, and attachment counts. Canonical messages, attachments, runtime
sessions, execution lanes, and tab membership continue to use their existing
server-owned tables.

Hydration shares the relocation transcript upload/injection path. It starts a
new managed thread, uploads deterministic canonical history in bounded chunks,
injects supported items in bounded batches, reads the resulting thread back,
and only then attaches its new ID to the normal chat runtime session. The
external source thread ID is never adopted as that session ID.

## Operational diagnostics

Creation, completion, blocked, and failed transitions emit structured server
logs containing only safe identifiers and counts. The authoritative job record
and application live event remain the source of truth for UI state. For a
stalled import, check source and destination worker presence, the reported
compatibility/capability error, the selected model route/account, and the job's
current retryability before retrying.
