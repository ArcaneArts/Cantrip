# Endpoint model providers

Provider kinds identify the backend software. A provider ID identifies one
configured instance of that backend. The shared definitions in
`packages/protocol/src/provider-definitions.ts` own setup defaults, display
labels, and instance multiplicity. Settings and server account classification
consume those definitions.

All endpoint kinds, including Ollama and generic OpenAI-compatible, are repeatable. Each instance
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

New instances receive an unused default name, which you can edit. Saving selects
the new provider tab; the selected tab is retained per server and signed-in user
across reloads. Logical model IDs and ordered routes remain server-owned.

Editing an endpoint or its encrypted key advances that instance's connection
revision. Old catalog capabilities and reachability become stale, and late
refreshes from the old connection cannot overwrite the new connection's catalog
or status. Provider/model IDs, user visibility, default model selection, and
routes survive. Client catalog caches and connection-test results follow the
same revision. Names and concurrency edits do not invalidate connection metadata.
Future executions use the new connection; existing running turns retain their
established runtime. Deleting or editing one instance does not change its peers.

Concurrency uses the existing provider pool on each authorized worker, shared
across that worker's projects, models, helper requests, and runtime generations.
Unrelated provider IDs have independent pools. A cancelled running request keeps
its slot until execution has settled. The established limit is per worker;
several workers accessing one LAN inference service do not constitute a global
server-wide admission pool. Configure that service's own shared capacity as
needed. See [provider concurrency](PROVIDER_INFERENCE_CONCURRENCY.md).

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
The same executable fixtures exercise HTTP authentication failure, failure after
partial streaming output, operation-timeout cancellation, and user Stop, while
checking that backend error bodies and keys do not escape into diagnostics.
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

### Real backend smoke tests

On Apple Silicon, with bundled Codex **0.166.0**, the following externally running
services completed a worker-owned shell tool call that read a random fixture
file, returned its exact contents, and then completed auxiliary label inference:

| Backend   | Version            | Model and configuration                                                                                                                               | Result                                                        |
| --------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Ollama    | `0.40.8`           | `gemma4:12b`, 11.9B Q4_K_M, worker loopback `:11434`                                                                                                  | Agent tool/result/continuation and auxiliary inference passed |
| llama.cpp | `9430 (d48a56eff)` | Same Gemma4 12B Q4_K_M GGUF; `--ctx-size 8192 --parallel 1 --jinja --reasoning-budget 0 --cache-ram 0 --no-webui`, model alias `cantrip-gemma4-smoke` | Agent tool/result/continuation and auxiliary inference passed |

The llama.cpp runs also exposed practical model latency limits: unrestricted
reasoning with a 32768 context exceeded the smoke operation's 120-second bound.
With context 8192 and reasoning budget 128, the agent passed but auxiliary
inference exceeded its existing 25-second deadline. The zero-reasoning-budget
configuration above passed both. These are measured model/configuration outcomes,
not a promise that every compatible model fits Cantrip's inference deadlines.

LM Studio/llmster, vLLM, Unsloth, LiteLLM, and MLX-LM have **not** been tested
against real servers in this environment. MLX-LM's Python runtime was absent;
the other services had no configured test endpoint. Their protocol wiring is
covered by deterministic fixtures and the actual Codex runtime. GPU/platform,
model template, and deployment-specific qualification remains necessary.

To repeat the opt-in smoke test with an already-running engine and existing
weights (the test installs and downloads nothing):

```sh
CANTRIP_CODEX_TEST_BINARY=/absolute/path/to/bundled/codex \
CANTRIP_SMOKE_PROVIDER_KIND=ollama \
CANTRIP_SMOKE_PROVIDER_URL=http://127.0.0.1:11434 \
CANTRIP_SMOKE_MODEL=gemma4:12b \
pnpm --filter @cantrip/worker exec vitest run test/real-endpoint-smoke.test.ts
```

Use any supported endpoint kind and its model alias. This harness uses an
isolated temporary Codex home and an unauthenticated endpoint; authenticated
connections are covered separately by local fixtures. Discovery is attempted
but its failure never prevents the actual manually configured inference test.
