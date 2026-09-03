# Durable Agent Interactions

Cantrip stores user-facing Codex requests as server-owned agent interaction
records. This domain covers command and file approvals, permission grants,
structured `requestUserInput` questions, and MCP elicitation. The records are
not chat messages and the browser never responds directly to Codex App Server.

## State and provenance

Every request has a globally idempotent `requestKey`, a typed payload, and the
project, worker, thread, turn, item, execution-lane, and chat provenance
available at the time it was created. Requests are chat-backed, and the response
route rejects any request that is not associated with an active chat.

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
MB. The server sends the live response directly to the owning worker before it
persists the redacted durable form, and neither boundary logs response payloads.

## App Server bridge

Codex threads start and resume with the `on-request` approval policy. The worker
normalizes command execution, file change, filesystem/network permission,
`requestUserInput`, and MCP elicitation server requests into versioned worker
events. The server adds the trusted project, chat, lane, and worker attribution
before recording the request; the worker never chooses those ownership fields.

Responses travel back through a dedicated worker command and are translated to
the exact App Server JSON-RPC response shape. `serverRequest/resolved` clears a
request that Codex ended before Cantrip answered it. Every live request has a
deadline capped at 30 minutes; shorter `autoResolutionMs` deadlines are honored.
At the deadline, the worker cancels or denies the native request and reports the
durable request as expired. Runtime shutdown and transport loss interrupt
pending requests rather than approving them.

The existing Plan Mode question surface is a compatibility view over the same
durable `userInput` record. Answering through that endpoint resolves the shared
record, so Plan Mode does not create a parallel approval channel.

## HTTP API

- `GET /api/agent-requests` lists requests and accepts `chatId`, `status`, and
  `limit` filters.
- `GET /api/agent-requests/:requestId` returns one owned request.
- `POST /api/agent-requests/:requestId/respond` validates and durably resolves
  a request.

## Waiting controls

The chat composer receives pending-request changes through the application live
channel while it is healthy. A disconnected app falls back to the same bounded
three-second active-chat and ten-second idle-chat snapshots used for the rest
of the transcript. It renders request-specific controls for command and network
decisions, file changes, scoped permission grants, structured user input, and
MCP forms or URL confirmations. Only decisions advertised by Codex are shown.
Permission denial is represented by an empty turn-scoped grant, matching the
worker's fail-closed response.

Plan Mode questions reuse their existing plan panel and are omitted from the
generic request list when both views refer to the same `requestKey`. Secret
answers remain component-local during submission, never enter the query cache,
and return from the server only as `[redacted]`.

## Permission profiles

Cantrip exposes Codex's beta permission profiles through:

- `GET /api/chats/:chatId/permission-profiles`, which returns advertised
  profiles plus the chat's selected and effective IDs; and
- `PATCH /api/chats/:chatId/permission-profile`, which accepts only an
  advertised, allowed profile while the chat is not executing.

The selected profile is durable chat state and defaults to `:workspace`.
Cantrip computes the effective profile on the server. A project using
`required-for-writes` always forces `:read-only` on Primary, even when the chat
selected a broader profile. The UI displays that override and gives
`:danger-full-access` an explicit warning treatment.

Permission profiles require both experimental API negotiation and the
`permissionProfile/list` method. Supported runtimes receive `permissions` on
thread start or resume, and Cantrip omits legacy `sandbox` and turn-level
`sandboxPolicy` fields because the two systems do not compose. A profile change
forces the worker to resume the thread with the new ID. When capability
negotiation fails, the selector is disabled with a reason and the established
legacy sandbox/worktree policy remains active.
