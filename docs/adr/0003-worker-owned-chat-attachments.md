# ADR 0003: Worker-owned Chat Attachments

- Status: Accepted
- Date: 2026-08-08

## Context

Cantrip apps may run in a browser, Tauri, or a future Capacitor shell while the
selected worker owns the project filesystem and Codex runtime. Attachments must
therefore remain usable when an app cannot directly reach a worker, must never
be copied into a project checkout, and must remain visible in server-owned chat
history. Large pasted text should not consume the visible prompt or model
context as one enormous inline message.

The Codex app-server accepts text, remote image, and worker-local image inputs.
Other file types remain useful to the agent when they are staged on its worker
and identified by an absolute path in the prompt. Model image capabilities are
not uniformly available across ChatGPT accounts, OpenAI-compatible endpoints,
OpenRouter routes, and local Ollama models.

## Decision

The app uploads each attachment to the Cantrip server. The server authorizes
the chat and routes bounded chunks over the existing authenticated outbound
worker command channel. The worker stores completed files beneath its Cantrip
data directory:

```text
<worker data>/attachments/<chat id>/<attachment id>/<safe file name>
```

This directory is outside project sources and worktrees. No app receives a
worker origin or arbitrary worker path. Content preview and download requests
return through an authorized server endpoint, which reads bounded chunks from
the assigned worker.

The server persists attachment metadata and message associations in Postgres
or PGlite. Message and queued-prompt payloads carry stable attachment summaries
for rendering. The bytes remain worker-owned. An offline or replaced worker
therefore leaves conversation history visible while its attachment content is
temporarily unavailable.

Image attachments are sent to Codex as `localImage` inputs when the selected
model route is known to support images. In auto-detection mode, the worker uses
`model/list` input modalities where available. Unsupported or unknown routes
still receive an explicit worker-local path in the textual prompt, avoiding a
hard failure and allowing tools to inspect the file. Audio, text, archives,
documents, and other files use that path-based behavior.

Text-only clipboard payloads at least 10,000 characters long become generated
`text/plain` attachments. The composer inserts a short `Read attachment …`
reference, shows a clipped preview, and allows the full text to be opened in a
dialog. Ordinary clipboard text remains inline.

Initial safety limits are 20 attachments per prompt, 25 MiB per attachment,
and 256 KiB per worker transfer chunk. File names are sanitized, attachment and
chat identifiers are validated as path segments, uploads enforce declared
sizes and chunk order, and incomplete files retain a temporary name until an
atomic completion rename.

## Consequences

- Browser, desktop, and future mobile clients use the same attachment path.
- The server coordinates authorization and metadata without becoming durable
  blob storage.
- Attachments can participate in prompt queueing, editing, steering, and normal
  transcript rendering.
- Worker loss makes attachment bytes unavailable until a future worker-storage
  replication feature moves or restores them.
- Model-native multimodal support is best effort; path-based access remains the
  portable fallback for arbitrary files.
