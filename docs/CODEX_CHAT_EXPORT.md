# Exporting Cantrip projects to Codex

Cantrip can export selected Agent chats into the user's local Codex desktop
history. The export is append-only: it points each new native Codex thread at
an existing Cantrip project worktree and imports a sanitized canonical
transcript through Codex's native external-session importer. It does not copy
the project folder, merge databases, or modify an existing Codex thread.

## User flow

Open **Project Settings → General → Export project** and choose **Export to
Codex**.

1. Choose a ready Cantrip worktree. That exact folder becomes the Codex thread
   working directory and runtime workspace root.
2. Review the target inspection and the preserved/flattened preview.
3. Select up to 20 finished Agent chats.
4. Export. Cantrip imports, reads back, and verifies a fresh native Codex thread
   for each selected chat. Verification requires both visible turns and an
   entry in Codex's normal thread-discovery list.
5. When the export ran on the current desktop worker, **Open** uses Codex's
   native thread deep link. For a remote worker, open Codex on the named worker.

Tasks and actively running or approval-blocked chats are intentionally disabled
in the first version. Per-chat outcomes allow one incompatible transcript to
fail without hiding successful exports.

## Preservation boundary

The export preserves:

- the selected existing project folder as the Codex working directory;
- chat titles; and
- supported user and assistant messages as native turns in their original
  order.

Cantrip activity that Codex cannot represent natively becomes bounded text
annotations. Attachment references become filename/type annotations; files are
not copied in the first version. Developer messages retain their content and
ordering as explicit `[Cantrip developer message]` annotations because Codex's
external-session format exposes only user and assistant roles. Cantrip workers,
replicas, routing, provider accounts, credentials, permission profiles, tasks,
schedules, queues, goals, approvals, managed MCP tools, internal instructions,
database identifiers, and transient server state are omitted.

The exporter never copies or merges Cantrip's isolated Codex database into the
external Codex home. It never copies authentication files or provider tokens.

## Privacy and ownership

The app asks the server to export selected chat IDs. The server authorizes the
project and worktree, but encrypted chat titles and message bodies stay opaque
while passing through it. The selected worker receives bounded deterministic
chunks, verifies their digest, opens the title and transcript with its existing
worker grants, and stages a mode-`0600` session file below a unique temporary
`.cursor/projects/.cantrip-exports` directory so the separate Codex App Server
process can use its supported native importer. The staging directory is removed
after success or failure; it is never sent to Cantrip Server or another worker.

The worker's durable export state contains only export identity, digest,
destination fingerprint, thread ID, status, and counts for retry safety. The
opened transcript exists only in the restrictive import staging file described
above and is deleted in the export attempt's cleanup path. Interrupted attempts
are replaced safely, and reusing the same operation and transcript returns the
verified prior result.

## Extensible target boundary

The shared protocol models an explicit export target. Server target definitions
own labels, limits, supported chat experiences, and preservation mappings.
Worker target adapters own local destination discovery and native writes. The
current registry contains only `codex-local`; future exporters can add a target
without coupling their runtime behavior to the project settings screen or the
canonical transcript relay.

The server exposes:

- `POST /api/projects/:projectId/exports/preview`
- `POST /api/projects/:projectId/exports`

The worker implements:

- `project.export.target.inspect`
- `project.export.chat.begin`
- `project.export.chat.chunk`
- `project.export.chat.complete`

## Compatibility

The first target is available on macOS and Windows workers that advertise the
external Codex history capability and can find an external Codex home. It uses
the bundled, pinned Codex App Server binary against that home and requires
`externalAgentConfig/detect`, `externalAgentConfig/import`, `thread/list`,
`thread/read`, and `thread/delete` for interrupted-attempt cleanup. The exporter
waits for `externalAgentConfig/import/completed`, takes the native thread ID from
the successful session result, verifies non-empty preview metadata and the exact
turn count with `thread/read`, then verifies that ID through state-only
`thread/list`. A preview performs non-mutating list and import-capability checks
before selection can be submitted.

See [Codex runtime compatibility](CODEX_RUNTIME_COMPATIBILITY.md) and the
inverse [Codex chat import contract](CODEX_CHAT_IMPORT.md).
