# Durable Agent Interactions

Cantrip stores user-facing Codex requests as server-owned agent interaction
records. This domain covers command and file approvals, permission grants,
structured `requestUserInput` questions, and MCP elicitation. The records are
not chat messages and the browser never responds directly to Codex App Server.

## State and provenance

Every request has a globally idempotent `requestKey`, a typed payload, and the
project, worker, thread, turn, item, execution-lane, chat, workflow-run, and
workflow-node provenance available at the time it was created. Chat and
workflow fields are nullable so the same domain can serve current chat turns
and future first-class workflow nodes without inventing hidden chats.

The durable states are:

- `pending`: Codex is blocked and the associated chat is
  `waiting-for-approval`;
- `resolved`: a validated user response was accepted exactly once;
- `expired`: the request passed its deadline before a response was accepted;
- `interrupted`: the turn or server process ended before resolution.

Resolution writes require an idempotency key. Repeating the same response with
the same key returns the existing record; changing the key or response after a
terminal state returns a conflict. Reusing a request key with different
provenance or payload is also a conflict.

When the last pending interaction for a chat reaches a terminal state, the
server restores the chat to `running` so the worker bridge can finish the turn.
On server startup, unresolved interactions become `interrupted` and active or
waiting chats become `failed`. This is intentionally fail closed: an approval
is never inferred after a disconnect or restart.

Answers to questions marked `isSecret` are accepted only from the live response
body and stored as `[redacted]`. Request and response envelopes are capped at 1
MB. Later worker-bridge integration must continue to avoid logging raw response
payloads.

## HTTP API

- `GET /api/agent-requests` lists requests and accepts `chatId`, `status`, and
  `limit` filters.
- `GET /api/agent-requests/:requestId` returns one owned request.
- `POST /api/agent-requests/:requestId/respond` validates and durably resolves
  a request.

This first approval milestone pass establishes the persistence and API domain.
The following isolated passes connect App Server server-initiated requests to
these records and render their waiting controls in the app.
