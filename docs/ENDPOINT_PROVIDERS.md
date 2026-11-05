# Endpoint model providers

Provider kinds identify the backend software. A provider ID identifies one
configured instance of that backend. The shared definitions in
`packages/protocol/src/provider-definitions.ts` own setup defaults, display
labels, and instance multiplicity. Settings and server account classification
consume those definitions.

Ollama and generic OpenAI-compatible endpoints are repeatable. Each instance
keeps its own name, URL, encrypted credential, concurrency limit, catalog, and
model route references. Three Ollama servers can expose the same native model
ID without sharing provider identity. ChatGPT and Grok retain one provider
container per owner, each supporting multiple signed-in accounts.

URLs are API roots as reached from the selected worker. Loopback addresses
refer to that worker, while LAN addresses may reach another machine. Reverse
proxy prefixes and IPv6 authorities are preserved when removing pasted
`/responses`, `/chat/completions`, or `/chat` endpoint suffixes.

## External endpoint setup

Settings → Models → **+** offers the following additional repeatable providers.
Each is stored as its own provider kind, rather than a generic provider preset.

| Provider            | Default API root           | Inference                         |
| ------------------- | -------------------------- | --------------------------------- |
| LM Studio / llmster | `http://127.0.0.1:1234/v1` | Responses                         |
| llama.cpp           | `http://127.0.0.1:8080/v1` | Responses                         |
| vLLM                | `http://127.0.0.1:8000/v1` | Responses                         |
| Unsloth             | `http://127.0.0.1:8888/v1` | Responses                         |
| LiteLLM             | `http://127.0.0.1:4000/v1` | Responses                         |
| MLX-LM              | `http://127.0.0.1:8080/v1` | Worker adapter → Chat Completions |

All addresses are editable. Use the address reachable from the selected worker,
including a reverse-proxy path prefix when necessary. The API key is optional
for unauthenticated servers. Save the provider, refresh its catalog, or create
a model with the server's exact model ID. A saved provider's connection test
runs a small real inference request through the selected worker and bundled
Codex; creating a provider itself does not require a reachable endpoint.

Discovery uses `/models` under the configured API root. LM Studio's optional
native `/api/v1/models` metadata adds loaded/installed state, actual context,
quantization, and advertised tool support. Failure of that optional metadata
request leaves the standard catalog usable. Missing capabilities remain
unknown. Catalog observations are worker- and instance-scoped; a stale or
missing endpoint listing does not prevent an actual inference attempt.

The native Responses integrations require a backend version implementing the
API used by the pinned Codex runtime. A Chat Completions-only server is not
made Responses-compatible by selecting a different provider label. Keep the
generic OpenAI-compatible provider for existing custom/cloud setups; existing
rows are not reclassified automatically.

- [LM Studio / llmster API](https://lmstudio.ai/docs/developer/openai-compat):
  enable the API server and, for remote workers, its network listener and
  authentication as appropriate. The desktop app and headless daemon use the
  same provider type.
- [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md):
  use a recent `llama-server` with Responses support and the model's appropriate
  chat template. Cantrip executes tools on its worker; do not enable a separate
  server-owned agent/tool loop or MCP tool configuration.
- [vLLM online serving](https://docs.vllm.ai/en/latest/serving/online_serving/):
  use a Responses-capable version. Tool-call parsing and chat templates must
  match the served model; protocol support alone does not qualify every model
  for agent work.
- [Unsloth API](https://unsloth.ai/docs/basics/api): use a Responses-capable
  version and start inference with `--disable-tools`. Cantrip/Codex retains
  command execution, browsing, approvals, and history on the project worker.
- [LiteLLM Responses](https://docs.litellm.ai/docs/response_api): configure an
  externally managed gateway deployment. Use its exposed model alias. Native
  Responses passthrough and gateway translation depend on the deployment's
  backend and configuration.

Managed downloads, engine installation, and training remain separate goals.

## Direct MLX-LM connections

[MLX-LM's official server](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/server.py)
exposes `/v1/chat/completions` and `/v1/models`. Run it externally with the desired
model, for example `mlx_lm.server --model <model-path-or-ID> --port 8080`.
Use `--host` to choose the network listener for LAN workers, and set a sufficient
`--max-tokens` for agent responses. Select **MLX-LM** in Cantrip and enter that
server's API root. An optional key can authenticate an external reverse proxy;
the upstream server itself does not require a fabricated key.

Cantrip starts a private, authenticated loopback adapter on the execution
worker for each Codex runtime. Its address and token are ephemeral; the backend
address and decrypted key remain private to the worker. A remote MLX server
does not need a project checkout or another installed gateway. Closing the
runtime or cancelling its request aborts upstream inference.

The adapter translates full message history, JSON function tools and results,
fragmented tool arguments, streaming text, reasoning, completion/failure events,
and supplied token usage. Codex retains execution and approvals. Freeform/custom
and server-owned tools are disabled for these routes; unsupported input items,
including opaque encrypted history from another provider, fail explicitly.
There is no protocol fallback or request replay inside the adapter.

Reasoning output accepts MLX's `reasoning` and `reasoning_content` fields. An
explicit effort is forwarded through MLX's `chat_template_kwargs.reasoning_effort`
and thinking toggle; the served model's chat template controls its meaning.
Discovery does not invent supported effort levels or token-budget guarantees.
Structured output uses a schema instruction and validates the final JSON
against that schema before reporting completion. It does not claim native
constrained generation; an invalid response is an inference failure.

The adapter is stateless: Codex sends full history, and unsupported saved-response
references are rejected. Request and retained output bodies are bounded at
64 MiB, with a 4 MiB SSE-event bound. MLX model/tool templates must support the
chosen model's function calling; a successful model list is not proof of that.

## Validation evidence

The endpoint fixture exercises all six additional provider kinds through the
actual bundled Codex **0.166.0**, including fragmented output streaming,
reverse-proxy paths, API-key authentication, and a keyless llama.cpp instance.
It also exercises fragmented JSON tool arguments, worker-owned shell execution,
tool-call IDs and results, and the following model continuation for each kind.
Each kind also completes stateless auxiliary label inference with no tools.
The MLX fixture verifies reasoning survives the next request, despite
discovery being unavailable. Adapter fixtures cover cancellation, instance and
credential isolation, HTTP/stream failures, truncation, structured output,
usage, and fragmented UTF-8 SSE framing.
Its HTTP server is synthetic: this proves Cantrip's production runtime wiring,
not a particular backend/model combination or backend performance.

Additional local fixtures exercise worker discovery, optional LM Studio
metadata, credential/body redaction, repeatable settings choices, three
Ollama instances, two instances of every new backend, provider-owned model
IDs, tenant isolation, and stale catalog recovery. Real backend/model smoke
results and remaining environment-specific limitations must be reported
separately; synthetic fixtures are not evidence that an installed backend
was exercised.
