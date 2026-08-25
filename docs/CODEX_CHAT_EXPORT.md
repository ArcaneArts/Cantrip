# Exporting Cantrip projects to Codex

Cantrip can export selected Agent chats into the user's local Codex desktop
history. The export is append-only: it points each new native Codex thread at
an existing Cantrip project worktree and injects a sanitized canonical
transcript. It does not copy the project folder, merge databases, or modify an
existing Codex thread.

## User flow

Open **Project Settings → General → Export project** and choose **Export to
Codex**.

1. Choose a ready Cantrip worktree. That exact folder becomes the Codex thread
   working directory and runtime workspace root.
2. Review the target inspection and the preserved/flattened preview.
3. Select up to 20 finished Agent chats.
4. Export. Cantrip creates, names, reads back, and verifies a fresh native Codex
   thread for each selected chat.
5. When the export ran on the current desktop worker, **Open** uses Codex's
   native thread deep link. For a remote worker, open Codex on the named worker.

Tasks and actively running or approval-blocked chats are intentionally disabled
in the first version. Per-chat outcomes allow one incompatible transcript to
fail without hiding successful exports.

## Preservation boundary

The export preserves:

- the selected existing project folder as the Codex working directory;
- chat titles; and
- supported user, assistant, and developer messages in their original order.

Cantrip activity that Codex cannot represent natively becomes bounded text
annotations. Attachment references become filename/type annotations; files are
not copied in the first version. Cantrip workers, replicas, routing, provider
accounts, credentials, permission profiles, tasks, schedules, queues, goals,
approvals, managed MCP tools, internal instructions, database identifiers, and
transient server state are omitted.

The exporter never copies or merges Cantrip's isolated Codex database into the
external Codex home. It never copies authentication files or provider tokens.

## Privacy and ownership

The app asks the server to export selected chat IDs. The server authorizes the
project and worktree, but encrypted chat titles and message bodies stay opaque
while passing through it. The selected worker receives bounded deterministic
chunks, verifies their digest, opens the title and transcript with its existing
worker grants, and sends plaintext only to a separate Codex App Server process
using the external Codex home on that same machine.

The worker persists only export identity, digest, destination fingerprint,
thread ID, status, and counts for retry safety. It does not persist the opened
transcript. Interrupted attempts are replaced safely, and reusing the same
operation and transcript returns the verified prior result.

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
`thread/list`, `thread/start`, `thread/inject_items`, `thread/name/set`,
`thread/read`, `thread/unsubscribe`, and `thread/delete` for cleanup. A preview
performs a non-mutating compatibility check before selection can be submitted.

See [Codex runtime compatibility](CODEX_RUNTIME_COMPATIBILITY.md) and the
inverse [Codex chat import contract](CODEX_CHAT_IMPORT.md).
