# Codex event normalization

Cantrip keeps Codex App Server as the agent loop and translates its runtime
notifications into a stable, validated transcript protocol. The browser never
receives raw App Server messages.

## Supported normalized records

For the tested Codex range in `docs/CODEX_RUNTIME_COMPATIBILITY.md`, Cantrip
normalizes:

- commentary and final agent messages, including their message phase;
- plan items and `turn/plan/updated` snapshots;
- supported reasoning summaries;
- command execution and file changes;
- MCP and dynamic tool calls;
- collaboration tool calls and native subagent activity;
- web search and image-view activity;
- review-mode entry and exit;
- context compaction;
- runtime/configuration warnings and turn errors;
- thread token usage, context-window percentage, and account rate-limit
  windows; and
- command, tool, and turn duration where the runtime reports it.

Every Codex-derived record can carry a correlation tuple with the original
method name, worker diagnostic id, and available thread, turn, and item ids.
The diagnostic id refers to the worker's bounded in-memory raw diagnostic
buffer. Raw payloads are not persisted in chat messages or sent to the app.

## Reasoning and secret boundary

Cantrip persists only the supported `reasoning.summary` strings. It deliberately
ignores the runtime item's private `content` field and
`item/reasoning/textDelta` notifications. Tool arguments, tool results, and raw
MCP content are also omitted from normalized progress because they can contain
credentials or other unbounded data. This includes native collaboration-agent
prompts. Web activity strips credentials, query parameters, and fragments from
page URLs. The stable record retains the tool name, status, duration, safe
error text, and correlation identifiers.

Normalized event-card free text and lists are bounded before transport.
Agent-message text remains the durable answer itself. Existing command output
uses its separate tail-truncation policy.

## Durability and recovery

The server stores normalized events as typed chat-message content with stable
idempotency keys. Repeated lifecycle notifications update the same record, and
repeated `thread/read` synchronization does not duplicate records. Commentary
and final messages remain separate transcript entries.

After a server restart, stored normalized records render without a worker. For
Codex console turns, `thread/read` reconstructs every supported item that the
runtime retains, plus turn status and duration. Token-usage and account
rate-limit notifications are persisted when observed live, but Codex 0.146.x
does not return those notification snapshots from `thread/read`; Cantrip does
not fabricate them during later console synchronization.

Unknown App Server notifications remain explicit bounded worker diagnostics as
described in `docs/CODEX_RUNTIME_COMPATIBILITY.md`.
