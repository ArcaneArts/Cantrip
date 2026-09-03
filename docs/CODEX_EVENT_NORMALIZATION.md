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
- an assembled, provenance-labeled snapshot of the Cantrip instructions and
  turn policy supplied at turn start;
- thread token usage, context-window percentage, and account rate-limit
  windows; and
- command, tool, and turn duration where the runtime reports it.

Every Codex-derived record can carry a correlation tuple with the original
method name, worker diagnostic id, and available thread, turn, and item ids.
The diagnostic id refers to the worker's bounded in-memory raw diagnostic
buffer. For encrypted ordinary-chat and Task turns, applicable normalized
activities may also contain a versioned protected raw envelope. The worker
redacts known credentials, independently bounds request text to 64 KiB and
response text to 256 KiB, and records only size/digest/omission metadata for
binary content before the normal chat-message encryption step. The server sees
only opaque protected content plus non-semantic activity routing metadata.

## Reasoning and secret boundary

Cantrip persists only the supported `reasoning.summary` strings in normal
transcript presentation. It deliberately ignores
`item/reasoning/textDelta` notifications. Compact normalized progress continues
to omit tool arguments, full tool results, and collaboration prompts. When
protected trajectory capture is enabled, supported runtime item snapshots are
retained only in the bounded/redacted raw envelope inside encrypted message
content and remain hidden behind event selection and the Raw tab. Web activity
still strips credentials, query parameters, and fragments from its compact
display URL. The stable record retains the tool name, status, duration, safe
error text, and correlation identifiers.

Effective-instruction capture is labeled `assembled`, not `exact`, because the
Codex runtime does not expose every internal, customization, or `AGENTS.md`
instruction verbatim. The snapshot identifies the Cantrip developer
instructions, supplied turn context, selected skills, model/provider,
collaboration mode, permission profile, sandbox policy, reasoning effort, and
runtime version that Cantrip can observe. The UI states the limitation rather
than presenting the reconstruction as the verbatim model prompt.

Normalized event-card free text and lists are bounded before transport.
Agent-message text remains the durable answer itself. Existing command output
uses its separate tail-truncation policy.

Failed MCP calls are normalized independently of server name. The worker
prefers the runtime error, then inspects MCP `isError` text and structured
error envelopes, including nested JSON wrappers. It retains at most 4,000
characters of redacted error text plus a bounded code and explicit
retryability when the MCP result supplies them. Failed cards open with that
reason visible. Successful non-CodeGraph payloads remain omitted from compact
activity, while displayed CodeGraph result text stays bounded and redacted.

An item observed only at completion does not receive an invented start
timestamp. Trajectory labels that span as `derived` (or `instant` when no
span exists); only a runtime start notification or timestamp can make item
timing `exact`.

## Durability and recovery

The server stores normalized events as typed chat-message content with stable
idempotency keys. Repeated lifecycle notifications update the same record, and
repeated `thread/read` synchronization does not duplicate records. Commentary
and final messages remain separate transcript entries.

After a server restart, stored normalized records render without a worker. For
Codex console turns, `thread/read` reconstructs every supported item that the
runtime retains, plus turn status and duration. Token-usage and account
rate-limit notifications are persisted when observed live, but Codex 0.151.0
does not return those notification snapshots from `thread/read`; Cantrip does
not fabricate them during later console synchronization.

Unknown App Server notifications remain explicit bounded worker diagnostics as
described in `docs/CODEX_RUNTIME_COMPATIBILITY.md`.
