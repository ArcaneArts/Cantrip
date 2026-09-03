# Managed Local Inference

Status: Planned

This document proposes a Cantrip-managed local inference subsystem. It is a
future implementation plan, not a description of currently available product
behavior.

The intended user experience is:

1. Choose a worker.
2. Search a large model registry or paste a supported Hugging Face URL.
3. Let Cantrip recommend a compatible artifact, quantization, backend, and
   context size for that worker.
4. Download and validate the model without installing a separate model
   manager.
5. Select the installed model in Cantrip like any other model profile.
6. Let the worker load, unload, and run it as needed.

The first two inference engines will be:

- `llama.cpp` as the portable default on Windows, macOS, and Linux.
- MLX-LM as the preferred Apple Silicon path when a compatible MLX artifact is
  available.

Cantrip will build the orchestration, storage, compatibility, and routing
layers. It will not build custom tensor kernels or model implementations.

## Goals

- Provide a white-glove model discovery, download, installation, and execution
  experience.
- Bind each physical model installation to a specific worker.
- Allow one logical model to have different artifacts on different workers,
  such as MLX 4-bit on a Mac and GGUF Q4_K_M on a Windows workstation.
- Select an appropriate engine automatically while retaining an explicit
  backend override.
- Report worker hardware and engine capabilities accurately enough to make
  useful artifact and context recommendations.
- Treat memory estimates as guidance while allowing the real engine load to be
  authoritative.
- Present installed local models through the existing model catalog and model
  profile routing system.
- Preserve the current Cantrip boundary in which the server owns durable state
  and routing while workers own files, processes, and inference side effects.
- Run without Ollama, LM Studio, a user-managed Python installation, or another
  external model daemon.
- Recover cleanly from worker restarts, interrupted downloads, engine crashes,
  and failed model loads.

## Non-goals for the first release

- Training, fine-tuning, or LoRA authoring.
- Automatically converting arbitrary full-precision Transformers repositories
  into every supported runtime format.
- Automatically quantizing large models after download.
- Supporting every artifact format accepted by every inference engine.
- Treating a model that merely loads as automatically suitable for Cantrip
  agent workloads.
- Exposing an inference server to the LAN or public network.
- Multiple simultaneously resident model families on one worker.
- Vision, embeddings, reranking, speech, and image generation. The initial
  qualification target is text generation with reliable tool use.

## Architectural decision

Cantrip will expose one managed model provider backed by worker-local inference
installations. A worker-local Responses gateway will hide engine differences
from Codex.

```text
Cantrip app
    |
    v
Cantrip server
  - registry search
  - durable desired state
  - model/profile routing
  - installation progress
    |
    | authenticated worker commands and observations
    v
Cantrip worker
  - artifact store
  - hardware inventory and fit planner
  - inference supervisor
  - Responses gateway
       |                         |
       v                         v
  llama.cpp router/server    MLX-LM sidecar
       \_________________________/
                    |
                    v
                  Codex
```

The data plane remains local to the worker. The server coordinates desired
state and routing but does not proxy generated tokens, store model weights, or
run inference.

## Relationship to the existing model system

Cantrip already has useful seams for this feature:

- Provider kinds and model-profile contracts live in
  [`packages/protocol/src/providers.ts`](../../packages/protocol/src/providers.ts).
- Durable providers, provider models, worker-scoped availability, profiles, and
  routes live in
  [`cantrip_server/src/db/schema.ts`](../../cantrip_server/src/db/schema.ts).
- Model profiles are resolved into runtime providers in
  [`cantrip_server/src/db/repository/model-runtime.ts`](../../cantrip_server/src/db/repository/model-runtime.ts).
- Ollama discovery already records worker-scoped model availability in
  [`cantrip_server/src/models/ollama-catalog.ts`](../../cantrip_server/src/models/ollama-catalog.ts).
- Route selection already checks whether an Ollama model is present on the
  target worker in
  [`cantrip_server/src/models/model-route-availability.ts`](../../cantrip_server/src/models/model-route-availability.ts).
- Codex provider arguments and environment are assembled in
  [`cantrip_worker/src/codex/provider-config.ts`](../../cantrip_worker/src/codex/provider-config.ts).
- Worker heartbeats already carry structured feature capabilities through
  [`packages/protocol/src/workers.ts`](../../packages/protocol/src/workers.ts).
- Cantrip already has a signed, checksummed, probed, rollback-capable runtime
  installer in
  [`cantrip_worker/src/managed-runtimes/runtime.ts`](../../cantrip_worker/src/managed-runtimes/runtime.ts).

The managed inference subsystem should extend these paths instead of creating
a second, unrelated model selector.

## Managed provider representation

Add a system-owned provider kind named `cantrip-managed`.

- Provision one managed provider per owner.
- Do not expose normal create, edit, credential, or delete controls for it.
- Do not persist a fabricated loopback endpoint.
- Make `baseUrl` nullable only for this discriminated provider kind. External
  providers continue to require a valid URL.
- Have the worker replace the null managed endpoint with the ephemeral local
  Responses gateway before launching Codex.
- Continue attributing token and agent-time telemetry to a provider and route,
  preserving the existing accounting model.

Each immutable runnable artifact is projected into the existing
`provider_models` catalog. Its stable native model ID should be an opaque
Cantrip identifier such as `managed:<artifact-id>`, not a mutable Hugging Face
branch or a local filesystem path.

Physical availability remains worker-scoped through
`provider_model_availability`. A managed provider model is available to a
worker only when the corresponding installation has reached a ready state on
that worker.

### Cross-platform profile example

A discovery-managed profile named `Qwen Coder` could contain these routes:

1. An MLX 4-bit artifact.
2. A GGUF Q4_K_M artifact.

Both artifacts share a canonical model ID. On an Apple Silicon worker with the
MLX artifact installed, the MLX route wins. On a Windows or Linux worker, that
route is unavailable and routing proceeds to the GGUF route. The same GGUF
artifact may also have installations on several workers without duplicating
the provider-model catalog entry.

## Persistence model

Two inference-specific tables should supplement the current provider catalog.

### `managed_model_artifacts`

This table represents immutable model content independent of any worker.

Proposed fields:

- `id`
- `owner_id`
- `provider_model_id`
- `backend`: `llama-cpp` or `mlx`
- `source_kind`: initially `hugging-face`
- `repository_id`
- immutable repository commit SHA
- artifact manifest containing required filenames, sizes, and hashes
- artifact format
- quantization format and bit width when known
- parameter count and model family when known
- native context limit when known
- tokenizer and chat-template metadata
- gated status
- license identifier and URL when known
- creation and update timestamps

The combination of source, repository, immutable revision, selected files, and
backend must identify one artifact deterministically.

### `managed_model_installations`

This table represents desired and observed state on one worker.

Proposed fields:

- `id`
- `artifact_id`
- `worker_id`
- desired state: `installed` or `removed`
- observed installation state
- downloaded and total bytes
- configured context policy
- last successfully validated context
- runtime version used for validation
- compatibility result
- last failure code, bounded message, and retryable flag
- monotonically increasing observation sequence
- last-observed and lifecycle timestamps

Enforce one installation per artifact and worker. Do not store a worker-local
absolute path in server state; the worker resolves storage from the opaque
installation ID.

An installation record also serves as the durable job record for the initial
version. Attempt history can be split into an append-only table later if the
operational need justifies it.

### Installation states

The initial state machine is:

```text
requested
  -> resolving
  -> downloading
  -> verifying
  -> installed
  -> validating
  -> ready
```

The model also supports terminal or side states:

- `cancelled`
- `failed`
- `removing`
- `removed`
- `orphaned`

Compatibility is recorded separately from byte installation. A model can be
installed successfully yet be `text-only`, `limited`, or `incompatible` with
Cantrip agent workloads.

## Worker capability reporting

Extend the worker heartbeat with an `inference` capability object.

It should report:

- Inference protocol version.
- Supported backend adapters.
- Installed engine runtime versions and runtime health.
- Operating system and architecture.
- Total system memory.
- Unified memory on Apple Silicon.
- Discrete VRAM when it can be reported reliably.
- Devices discovered by llama.cpp.
- Supported runtime acceleration flavors.
- Currently loaded artifacts.
- Active context sizes and parallel request slots.
- Observed active and peak memory where available.
- A bounded status or failure reason for each backend.

The initial hardware inventory is intentionally advisory. Device enumeration
and actual engine load results are stronger evidence than a platform-name
heuristic.

## Engine runtime distribution

Engine binaries and Python environments are Cantrip runtime artifacts. Model
weights are user-selected model artifacts. They have different trust,
distribution, and update lifecycles and must not share a manifest format
accidentally.

Generalize the existing managed runtime manifest with an artifact `flavor`, or
add an equivalent inference-runtime flavor discriminator while reusing its
installer behavior.

Required installer properties:

- Select by component, platform, architecture, and acceleration flavor.
- Verify a Cantrip release signature and archive SHA-256.
- Enforce inventory and extraction limits.
- Extract to staging and promote atomically.
- Run a functional probe before selection.
- Retain a last-known-good runtime for rollback.
- Preserve licenses and a source manifest.
- Allow runtime upgrades independently from model downloads.

### llama.cpp runtime flavors

Initial planned flavors are:

- macOS arm64: Metal and Accelerate.
- macOS x64: CPU and Accelerate.
- Windows x64: portable CPU/Vulkan baseline.
- Windows x64: optional NVIDIA CUDA runtime.
- Linux x64 and arm64: portable CPU/Vulkan baseline where supported.
- Linux x64: optional NVIDIA CUDA and AMD ROCm runtimes.

Prefer a dynamically loaded backend build where it is dependable. Otherwise,
publish separate signed runtime flavors. Trying an optimized runtime and
falling back after a real load failure is preferable to refusing a runnable
configuration based only on a probe.

### MLX-LM runtime

The first MLX implementation should use the Python MLX-LM library in an
isolated, signed runtime bundle containing:

- A pinned CPython build.
- Pinned `mlx`, `mlx-metal`, and `mlx-lm` packages.
- Pinned tokenizer, Transformers, sentencepiece, protobuf, YAML, and Hugging
  Face Hub dependencies.
- A Cantrip-owned sidecar entry point.
- A dependency lock, license inventory, source manifest, and SBOM.
- Codesigned and notarized native libraries as required by macOS distribution.

The MLX backend is initially advertised only on `darwin-arm64`.

The stock `mlx_lm.server` is not the production boundary. Its own documentation
states that it provides only basic security checks, and it exposes a Chat
Completions-like API rather than the Responses contract Cantrip needs. The
Cantrip sidecar should import MLX-LM as a library and communicate with the Node
worker using a framed stdio protocol.

The native Swift package `mlx-swift-lm` remains a future alternative. It would
remove the Python runtime but requires Cantrip to own more model loading,
generation, prompt processing, tool parsing, and server behavior, and its
compatibility is tied to registered Swift model implementations. Reconsider it
if Python bundle size, startup, signing, or maintenance becomes unacceptable.

## Worker-local inference components

Create a dedicated `cantrip_worker/src/inference/` subsystem. Keep additions to
the central worker entry point limited to construction, command registration,
heartbeat reporting, and shutdown.

### `InferenceRuntimeManager`

Owns installation and health of the engine runtime bundles. It adapts the
existing managed-runtime installer rather than duplicating archive, signature,
probe, and rollback logic.

### `ModelRegistryResolver`

Parses a registry selection or pasted source URL, queries the supported source,
resolves a mutable revision to an immutable commit, and returns candidate
artifacts.

### `ModelArtifactStore`

Owns worker-local model bytes and manifests. It provides staging, resumption,
verification, atomic promotion, reference tracking, and deletion.

### `HardwareInventory`

Collects OS memory and engine-visible device information. Its result is useful
for display and initial recommendations but does not veto an actual load.

### `ModelFitPlanner`

Combines artifact metadata, quantization, desired context, KV-cache settings,
parallel slots, device information, and a configurable system reserve. It
returns ranked recommendations with an explicit confidence level.

### `InferenceSupervisor`

Owns loaded model state, runtime leases, startup, readiness, idle unloading,
crash recovery, bounded diagnostics, and shutdown. The initial implementation
allows one resident logical model per worker while permitting several requests
or subagents to share that model.

### `CantripResponsesGateway`

Provides the stable OpenAI Responses-compatible endpoint used by Codex. It
authenticates local calls, acquires the requested model from the supervisor,
and delegates to the chosen backend adapter.

### Backend adapter contract

The exact TypeScript types will be finalized during implementation, but the
conceptual contract is:

```typescript
interface InferenceBackendAdapter {
  readonly kind: "llama-cpp" | "mlx";

  probe(): Promise<BackendCapabilities>;
  inspect(artifact: InstalledArtifact): Promise<ModelInspection>;
  load(request: ModelLoadRequest): Promise<LoadedModel>;
  countInputTokens(request: ResponsesRequest): Promise<number>;
  stream(
    request: ResponsesRequest,
    signal: AbortSignal,
  ): AsyncIterable<ResponsesEvent>;
  unload(model: LoadedModel): Promise<void>;
  close(): Promise<void>;
}
```

The Responses request and event types should describe the subset actually used
by the pinned Codex runtime, with captured contract fixtures guarding future
Codex upgrades.

## llama.cpp adapter design

Use a pinned `llama-server` in router mode behind the worker adapter.

Cantrip remains authoritative for registry discovery and downloads. The router
is responsible only for model process management and inference:

- Point model presets at immutable local GGUF artifacts.
- Generate and replace the preset file atomically.
- Initially configure `--models-max 1`.
- Load and unload through the router's documented model endpoints.
- Use stable Cantrip artifact IDs as aliases.
- Bind only to `127.0.0.1` on a random port.
- Generate a random API key at each supervisor start.
- Disable the Web UI.
- Disable the built-in agent, tools, MCP proxy, and MCP server configuration.
- Leave local media loading disabled.
- Enable Jinja chat templates where the model supports them.
- Use `--fit` and a Cantrip-selected `--fit-target` reserve.
- Set `--fit-ctx` to the lowest context Cantrip is willing to expose.
- Enable only the metrics or diagnostic endpoints needed by the adapter.
- Read health, properties, slot state, and actual context after load.
- Bound and redact child process diagnostics.

llama.cpp supports the Responses endpoint and input-token counting, so the
gateway can validate and mostly proxy that traffic. The gateway still owns
authentication, model aliases, cancellation behavior, response normalization,
telemetry, and compatibility isolation from engine upgrades.

The first llama.cpp artifact format is GGUF only. Support:

- Single-file GGUF.
- Complete sharded GGUF sets.
- An optional matching `mmproj` artifact in storage, even though vision remains
  out of scope until separately qualified.

Do not pass arbitrary Hugging Face identifiers to llama.cpp and allow it to
become the source of truth for downloads. Cantrip needs immutable revisions,
uniform progress, credential leasing, reconciliation, and shared policy across
both backends.

## MLX adapter design

Run one Cantrip-owned MLX sidecar for the currently loaded model. Communicate
over framed stdin/stdout so the sidecar has no listening network socket.

The sidecar protocol should support:

- `hello` and protocol negotiation
- `load`
- `inspect`
- `count_tokens`
- `generate`
- `cancel`
- `unload`
- `health`
- `shutdown`

The worker owns request IDs, deadlines, cancellation, and process restarts. The
sidecar owns model objects, tokenizers, prompt/KV caches, streaming generation,
and MLX memory measurements.

The initial MLX artifact format is an already compatible model repository with
safe tensor weights and the required configuration/tokenizer files. Prefer
prequantized 4-bit or 8-bit variants. Do not assume that every Transformers
repository is directly runnable and do not execute repository-provided Python
through `trust_remote_code`.

The MLX adapter must translate the Cantrip Responses subset into messages,
instructions, tools, tool outputs, and generation parameters. It must apply the
model's supported chat template and parse tool calls back into Responses
events. Tool syntax differs across model families, so parser support and model
qualification must be versioned with the runtime.

Capture at least:

- Prompt tokens and prompt throughput.
- Generated tokens and generation throughput.
- Time to first token.
- Active and peak MLX memory.
- Cache configuration.
- Finish and cancellation reason.
- The actual context accepted by the loaded model.

## Responses gateway contract

Codex should see one provider named `cantrip_runtime` and a Responses API root,
regardless of the underlying backend.

The gateway initially implements:

- `POST /v1/responses`
- `POST /v1/responses/input_tokens`
- `GET /v1/models` if required by the pinned Codex runtime or diagnostics
- `GET /health`

It must support the actual Codex request subset, including:

- Streaming Server-Sent Events.
- Instructions and text input.
- Function tool definitions.
- Function calls and function-call output items.
- Parallel tool calls when the model is qualified for them.
- Structured JSON/schema requests when the model is qualified for them.
- Usage accounting.
- Client disconnect and explicit cancellation.
- Bounded request bodies and field counts.
- Normalized typed errors.

The gateway must not add server-side filesystem, shell, browser, or MCP tools.
Cantrip and Codex retain ownership of tool execution and approval policy.

## Registry and source resolution

The registry endpoint should query Hugging Face live and cache pages briefly.
Cantrip should not ingest the entire Hub into its database.

Search requests may use:

- Text search.
- Author or organization.
- Model family.
- Parameter range.
- GGUF or MLX-compatible tags and metadata.
- Gated status.
- Sort by relevance, popularity, recency, or size.

Each result should be enriched with worker-relative information:

- Candidate llama.cpp artifacts.
- Candidate MLX artifacts.
- Quantization and file size.
- Native context when known.
- Estimated model memory and context overhead.
- `likely fit`, `tight fit`, or `unlikely fit` guidance.
- Whether it is already installed on the selected worker.
- Whether it has passed Cantrip agent compatibility qualification.
- Gated and license information.

A pasted Hugging Face repository or file URL goes through the same resolver as
a registry selection. The MVP accepts recognized `huggingface.co` repository,
`blob`, and `resolve` URL shapes only. It does not accept a generic URL and then
discover late that it targets an internal address.

Generic HTTPS downloads can be added later with DNS/IP SSRF defenses, redirect
revalidation, content and size limits, and an explicit checksum policy.

### Immutable resolution

Before creating an artifact:

1. Resolve a branch or tag to the repository's immutable commit SHA.
2. Fetch repository and file metadata for that exact revision.
3. Select the complete required file set.
4. Record declared sizes and LFS hashes where available.
5. Store the resolved manifest durably.
6. Give the worker only that resolved manifest and a short-lived credential
   lease.

Never use a moving `main` revision as the permanent artifact identity.

### Hugging Face credentials and gating

Hugging Face credentials are source credentials, not inference-provider API
keys.

- Store them as protected server-side secrets.
- Lease them only to the selected worker and only for source operations.
- Never persist them in a model manifest, URL, process argument, or log.
- Surface upstream gated-access requirements and license terms.
- Do not attempt to bypass account-specific access approval.
- Allow public models to resolve and download without a credential.

## Artifact store

The worker owns a private model store conceptually organized as:

```text
model-store/
  blobs/
  artifacts/
  installations/
  downloads/
  staging/
```

Properties:

- Downloads use resumable partial files where the source supports range
  requests.
- A partial file is never considered installed.
- Every required file is hashed after download.
- Promotion from staging to the immutable artifact location is atomic.
- The installation manifest contains source identity, immutable revision,
  hashes, sizes, inspected metadata, and schema version.
- GGUF blobs may be deduplicated by SHA-256.
- An MLX repository snapshot may reference content-addressed blobs while
  presenting the directory structure expected by its tokenizer and loader.
- Windows behavior must not depend on developer-mode symbolic links.
- Local garbage collection considers durable desired state and active runtime
  leases.
- Removing local bytes retains the catalog artifact, profile routes, and
  reinstall metadata unless the user separately removes those records.

The worker reports unrecognized local installation manifests as orphaned. It
does not silently delete them during reconciliation.

## Quantization selection

Quantization and context must be planned together. The fit planner considers:

- Weight bytes and quantization overhead.
- Model architecture.
- KV-cache size at the requested context.
- KV-cache data type or quantization.
- Compute and scratch buffers.
- Parallel request slots.
- GPU offload or CPU/GPU split.
- Other loaded runtimes.
- A user-visible Cantrip system-memory or VRAM reserve.

For llama.cpp, show available GGUF variants and normally recommend the
highest-quality candidate likely to fit. Q4_K_M is a reasonable balanced
starting preference when available, but it is not a universal rule.

For MLX, prefer existing compatible prequantized variants. A 4-bit artifact is
the likely default for constrained Apple Silicon machines; 8-bit or
higher-precision artifacts can be recommended when memory and desired context
allow.

The UI must display the chosen artifact and quantization before download.
Cantrip must not silently replace it with a lower-quality variant.

## Context sizing and memory authority

Expose three different values rather than one ambiguous context number:

- **Native maximum**: declared by model metadata.
- **Recommended maximum**: Cantrip's estimate for the selected worker and
  runtime policy.
- **Active context**: what the engine actually loaded.

Fit assessment results should contain a confidence level and contributing
factors. They are advisory and must not prevent an attempted load.

The load policy is:

1. Attempt the selected or recommended context with an explicit reserve.
2. Accept the engine's successful fitted configuration as authoritative.
3. If the engine reports a confirmed allocation or out-of-memory failure,
   retry a smaller context when automatic context is enabled.
4. Do not reinterpret unrelated startup, format, tokenizer, or filesystem
   failures as memory failures.
5. Surface the active context and any fallback prominently.
6. If no useful context loads, recommend another installed or downloadable
   quantization.

Apple Silicon uses unified memory, so it should not be described as separate
VRAM. The recommendation should retain enough unified memory for macOS,
Cantrip, Codex, and user applications.

## Backend selection

Selection occurs after route availability and before Codex launch.

Default policy:

- Apple Silicon: prefer a qualified installed MLX artifact for the canonical
  model, then a qualified GGUF artifact through llama.cpp Metal.
- Intel macOS: llama.cpp.
- Windows: llama.cpp.
- Linux: llama.cpp.

Do not assume that MLX is always faster than llama.cpp Metal. Store lightweight
per-worker validation and benchmark observations and allow the user to override
backend priority in the model profile.

An artifact is backend-specific. Cantrip does not treat a GGUF file as an MLX
artifact or vice versa. Installing another backend representation creates or
selects another artifact linked by canonical model identity.

## Runtime lifecycle and concurrency

The supervisor uses leases rather than letting individual chat processes own
engine processes directly.

```text
unloaded -> loading -> ready -> busy
    ^          |         |       |
    |          v         v       v
    +------- failed    idle ----+
                   \-> unloading -> unloaded
```

Initial policy:

- One resident logical model per worker.
- Several requests or subagents may share it within backend limits.
- Switching models drains active requests or waits for their leases before
  unloading.
- An idle timeout releases model memory without deleting downloaded bytes.
- A new request reloads an idle model.
- Unexpected exit triggers bounded exponential restart.
- Repeated failure marks the runtime degraded instead of looping forever.
- A newly installed engine runtime that fails its probe can roll back to the
  last known good runtime.
- Worker shutdown cancels generation, terminates sidecars, and then performs a
  forced process-tree cleanup after a deadline.

Multi-model residency can be added after observed memory reporting and
scheduling are trustworthy. It should not be an MVP requirement.

## Server and worker protocol

Add a dedicated inference protocol module instead of continuing to grow the
Ollama-specific command shape.

Representative server-to-worker commands:

- `inference.inventory.read`
- `inference.install.start`
- `inference.install.cancel`
- `inference.install.remove`
- `inference.install.inspect`
- `inference.runtime.validate`
- `inference.runtime.unload`
- `inference.runtime.status`

Representative worker observations:

- `inference.install.observed`
- `inference.runtime.observed`
- `inference.inventory.observed`

Long downloads must not hold a worker RPC request open. An install command is
accepted quickly, and progress arrives as authenticated, monotonically
sequenced observations. The server persists the latest accepted sequence and
broadcasts committed invalidations over the existing live channel.

Commands are idempotent by installation ID and desired generation. A reconnect
causes the server to resend desired state and the worker to report actual
state.

## Server HTTP API

An initial route set could be:

- `GET /api/inference/registry/search`
- `GET /api/inference/registry/models/:repository`
- `GET /api/inference/artifacts/:artifactId`
- `POST /api/inference/installations`
- `GET /api/inference/installations`
- `GET /api/inference/installations/:installationId`
- `POST /api/inference/installations/:installationId/cancel`
- `POST /api/inference/installations/:installationId/retry`
- `DELETE /api/inference/installations/:installationId/files`
- `POST /api/inference/installations/:installationId/validate`
- `POST /api/inference/workers/:workerId/unload`

Mutation routes change durable desired state first. Worker side effects follow
through the command protocol. API responses should distinguish accepted work
from completed work.

## Reconciliation

At worker startup and reconnect:

1. The worker reports inference runtimes, hardware, local installation
   manifests, and loaded models.
2. The server compares actual state with durable desired state.
3. Desired but incomplete installations are resumed or restarted.
4. Installed artifacts missing from disk become unavailable and receive a
   repairable failure state.
5. Valid local installations missing from server state are reported as
   orphaned for explicit adoption or removal.
6. Provider-model availability is reconciled from ready installation state.
7. Loaded models without valid leases are unloaded after a grace period.

Reconciliation must tolerate duplicate and out-of-order observations through
installation generations and monotonic sequence numbers.

## Cantrip agent compatibility

Installation success and agent compatibility are separate.

After installation, run a backend-specific qualification suite through the
same Responses gateway that Codex will use:

- Engine health and model load.
- Input-token counting.
- Non-streaming text response.
- Streaming text response.
- Stop handling.
- Client cancellation.
- One function-tool call.
- Function-call result continuation.
- Parallel function calls when advertised.
- Structured JSON or schema output when advertised.
- Context-boundary behavior.
- A basic multi-agent-compatible prompt when applicable.

Store the result by artifact, backend runtime version, gateway protocol
version, and chat-template configuration.

Compatibility classifications:

- `unknown`: not tested with the current runtime combination.
- `agent-compatible`: required Cantrip flows passed.
- `limited`: usable with explicitly recorded missing capabilities.
- `text-only`: generation works but required tool behavior does not.
- `incompatible`: cannot safely or correctly run.

Runtime upgrades invalidate or age prior qualification results and trigger
lazy revalidation before the model is advertised as fully compatible.

## Security model

Models and their metadata are untrusted input to native and Python parsers.

Required controls:

- Bind the Responses gateway and llama.cpp only to loopback.
- Use a random, ephemeral bearer credential between Codex and the gateway and
  between the gateway and llama.cpp.
- Give the MLX sidecar framed stdio rather than a listening socket.
- Disable llama.cpp Web UI, built-in tools, agent mode, MCP proxy, MCP servers,
  arbitrary media paths, and local file URLs.
- Never enable Hugging Face `trust_remote_code`.
- Do not execute scripts contained in model repositories.
- Restrict MLX snapshots to required weights, configuration, tokenizer, and
  chat-template assets.
- Validate all model-store paths and archive members against traversal.
- Apply explicit download and disk-space bounds without treating estimates as
  proof that execution cannot work.
- Use short-lived Hugging Face token leases and redact credentials and signed
  URLs from logs.
- Revalidate every redirect target during downloads.
- Keep runtime processes away from project directories and user home data.
- Use private runtime homes, caches, and temporary directories.
- Bound request bodies, model metadata, diagnostics, and emitted error text.
- Preserve upstream license information and gated-access state.

## Observability

Structured events and metrics should include:

- Registry resolution duration and result count.
- Download bytes, throughput, resume count, and verification duration.
- Runtime installation and rollback results.
- Cold model-load time.
- Time to first token.
- Prompt and generation tokens per second.
- Requested, recommended, and active context.
- Backend, engine version, acceleration flavor, and model artifact ID.
- Active request and slot counts.
- Estimated and observed peak memory.
- Idle unloads, explicit unloads, crashes, restarts, and confirmed OOMs.
- Compatibility qualification outcomes.

Do not include prompts, generated content, credentials, signed download URLs,
or user-local absolute paths in routine operational telemetry.

## Validation strategy

### Unit and contract tests

- Hugging Face URL parsing and immutable revision resolution.
- Artifact candidate grouping and quantization detection.
- Split GGUF manifest completeness.
- MLX file allowlists.
- Hash verification and atomic promotion.
- Resumable-download state.
- Fit estimates and context fallback classification.
- Backend selection and explicit overrides.
- Installation state-machine transitions and observation ordering.
- Responses request/event normalization.
- Tool-call parsing fixtures for supported model families.
- Secret and local-path redaction.

### Worker integration tests

- Fake llama.cpp and MLX child processes.
- Readiness, health, shutdown, and process-tree cleanup.
- Gateway authentication and loopback binding.
- Streaming, disconnect, deadline, and cancellation behavior.
- Concurrent requests to the same loaded model.
- Model switch while requests are active.
- Worker restart during download and during inference.
- Runtime crash and bounded restart behavior.
- Engine runtime rollback.

### Real platform smoke tests

- Apple Silicon with llama.cpp Metal.
- Apple Silicon with MLX-LM.
- Intel macOS with llama.cpp CPU.
- Windows x64 with llama.cpp CPU/Vulkan.
- Windows x64 with llama.cpp CUDA when available.
- Linux x64 with llama.cpp CPU and CUDA where CI hardware allows.

Use small, redistributable, tool-capable models for automated smoke tests.
Large-model performance qualification belongs in an opt-in hardware lab.

### Fault tests

- Interrupted and resumed download.
- Incorrect hash.
- Missing shard.
- Gated model without access.
- Expired source credential.
- Disk full during download or promotion.
- Worker disconnect and reconnect.
- Engine process crash.
- Confirmed OOM followed by automatic-context retry.
- Unsupported tokenizer or chat template.
- Model generates malformed or truncated tool calls.
- Removal requested while a runtime lease is active.

## Delivery plan

Implement this feature as sequential, independently mergeable milestones.

### Milestone 1: contracts and persistence

- Add the `cantrip-managed` provider kind.
- Make provider runtime configuration discriminated for managed versus external
  providers.
- Add artifact and installation tables and repository operations.
- Add inference worker capabilities, commands, observations, and state schemas.
- Extend route availability for ready managed installations.
- Provision and protect the system-managed provider.

### Milestone 2: runtime and artifact infrastructure

- Generalize managed runtime selection for acceleration flavors.
- Add signed llama.cpp runtime artifacts and functional probes.
- Implement Hugging Face registry resolution and protected credentials.
- Implement resumable artifact storage, verification, promotion, removal, and
  reconciliation.
- Expose installation progress through server APIs and live invalidations.

### Milestone 3: llama.cpp vertical slice

- Add the llama.cpp adapter and router supervisor.
- Generate local model presets.
- Add the worker-local Responses gateway.
- Route a managed provider runtime into Codex.
- Support one GGUF model installation and one resident model per worker.
- Add qualification and basic telemetry.
- Ship macOS arm64 and portable CPU smoke coverage first, then Windows and
  Linux runtime flavors.

### Milestone 4: MLX vertical slice

- Build and publish the pinned MLX-LM Python runtime for Apple Silicon.
- Implement the framed stdio sidecar.
- Add Responses-to-MLX request and event translation.
- Implement tool parsing, token counting, cancellation, and memory reporting.
- Add MLX artifact inspection and qualification.
- Add canonical profile routing between MLX and GGUF variants.

### Milestone 5: recommendation and hardening

- Add hardware inventory and artifact/context recommendations.
- Add automatic context fallback on confirmed allocation failures.
- Add optional CUDA/ROCm runtime flavors.
- Add crash recovery, runtime rollback, disk and credential failure handling,
  and security tests.
- Add registry search, artifact comparison, installation management, and
  backend override UI.
- Establish performance baselines before enabling multiple resident models.

## MVP acceptance criteria

The first product-ready milestone spanning llama.cpp and MLX is complete when:

- A user can select a worker, paste a supported Hugging Face URL, choose a
  recommended artifact, and reach a ready state without installing another
  application or runtime.
- Downloads resume after interruption and verify every required file before
  promotion.
- An installation is available only on the worker that actually contains it.
- One canonical model profile can route to MLX on Apple Silicon and GGUF on
  another worker.
- Codex communicates only with the Cantrip Responses gateway.
- Required Cantrip tool-call and continuation flows pass qualification.
- The active backend, quantization, context, runtime version, and compatibility
  status are visible.
- Memory recommendations do not hard-block a real load attempt.
- A confirmed OOM can reduce automatic context without hiding the resulting
  active context.
- Worker and engine restarts reconcile installed and loaded state.
- Engine endpoints are loopback-only, authenticated, and have all engine-owned
  tools disabled.
- Removing local model bytes cannot silently erase an active route or unrelated
  artifact.
- macOS arm64, Windows x64, and Linux x64 packages pass their applicable smoke
  tests.

## Open design questions

The following should be resolved by focused implementation spikes rather than
assumed in advance:

- Whether a single llama.cpp dynamic-backend bundle is dependable enough on
  each target platform or separate acceleration flavors are required.
- The exact reserve policy for Apple unified memory and discrete GPU VRAM.
- Which Responses fields the pinned Codex runtime actually emits for local
  providers and therefore belong in the first gateway contract.
- Which MLX tool parsers are sufficiently reliable to qualify initially.
- Whether the managed provider appears visibly in general provider settings or
  only in model management.
- Whether user-selected fixed context may fall back automatically or only the
  `auto` context policy may do so.
- When observed benchmarks are trustworthy enough to reorder MLX and
  llama.cpp Metal automatically.
- What retention window should apply to unreferenced artifact blobs and
  cancelled partial downloads.

## Upstream references

- [llama.cpp](https://github.com/ggml-org/llama.cpp)
- [llama.cpp server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [GGUF specification](https://github.com/ggml-org/ggml/blob/master/docs/gguf.md)
- [MLX-LM](https://github.com/ml-explore/mlx-lm)
- [MLX-LM server documentation](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/SERVER.md)
- [MLX Swift LM](https://github.com/ml-explore/mlx-swift-lm)
- [MLX peak-memory API](https://ml-explore.github.io/mlx/build/html/python/_autosummary/mlx.core.get_peak_memory.html)
- [Hugging Face Hub model API](https://huggingface.co/docs/huggingface_hub/en/package_reference/hf_api)
- [Hugging Face Hub download API](https://huggingface.co/docs/huggingface_hub/en/package_reference/file_download)
- [Hugging Face gated models](https://huggingface.co/docs/hub/models-gated)
