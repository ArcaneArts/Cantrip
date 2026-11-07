# Model operations

Models have independent language, embedding, and native decision profiles, backed
by the existing provider and catalog identities. Models → General has nullable
embedding and decision defaults; discovery never selects either automatically.
Provider tabs expose each operation separately. Subscription account connections
do not acquire API-key operation access by sharing a provider's model names.

Each provider section searches its complete configured model set, including IDs
and route aliases. Results use the picker's existing fuzzy ranking, with at most
50 rows mounted per section. Default model pickers mount at most 100 model options
per page. Page controls keep every result reachable; searching includes models on
other pages and resets to the first result page. Counts describe the full filtered
set. Paging and search never select a model or change a saved default. The saved
selection remains visible on the picker trigger even when its row is on another
page.

Title generation, chat imports, and root/subagent configuration select language
profiles only. A saved configuration whose profile is no longer a language model
shows a configuration-needed state; opening its picker does not select a
replacement or request its reasoning options.

An edited legacy language profile is retained when discovery identifies its
routes as non-language. Both servers report a presentation conflict only when
every observed scope for a route explicitly excludes language and supports
embeddings or decisions. An unknown scope, an unavailable language-capable scope,
or an unclassified route prevents that conclusion. A language profile whose
enabled routes all have that conflict stays in settings with a recovery note,
but is omitted from new chat, agent, task, title, and import language selections.
Edit its routes or add a profile in the matching operation section; saved IDs,
defaults, and historical references are not silently rewritten or cleared.
This is presentation metadata, not an inference gate: an explicitly configured
request still reaches the actual endpoint regardless of catalog observations.

Deleting a profile clears defaults through its database foreign keys. Deleting a
provider also clears defaults whose profiles lose their last enabled route,
including embedding and decision defaults. Profiles remain available for manual
configuration recovery, and defaults with another enabled route remain selected.
The provider deletion and affected default updates are one transaction in both
servers. Temporary unavailability and stale discovery do not clear defaults.
Removing a selected custom subagent configuration also clears its paired override
toggle so an empty custom selection cannot remain active.

## Catalog snapshots

Compatible endpoints and Ollama transfer complete worker-local catalog snapshots
in pages of at most 200 models and 2 MiB. Both servers verify the snapshot ID,
transfer ID, observation, total, offsets and unique model IDs before reconciling the complete
list. Failed, expired or incomplete transfers keep the previous catalog stale;
they do not publish a first page or mark its unseen models unavailable.

Discovery accepts up to 50,000 models and 32 MiB of normalized metadata, with
16 MiB per native HTTP response. Worker discovery is deduplicated per actual
namespace and connection and limited to four simultaneous loads. Up to eight
snapshots share a 32 MiB cache, expire after two idle minutes, and are bound to the
server, owner, worker, provider and credential configuration. Transfers remain
pinned until every active reader's final page or idle expiry; new snapshots wait for cache space
rather than evicting another in-progress transfer. Whole discovery and
transfer requests retain their two-minute deadlines. Ollama no longer slices its
installed models at 1,000; metadata requests retain their concurrency limit.

Compatible catalogs may advertise continuation URLs on the same origin. Cantrip
follows those URLs with cycle/page bounds, retaining custom base paths, and does
not guess cursor parameters. An advertised incomplete response without a usable
continuation fails explicitly. Older workers may return their complete legacy
inventory; older servers receive a complete bounded legacy inventory or an error,
never an unmarked first page.

LM Studio's native [`/api/v1/models` catalog](https://lmstudio.ai/docs/developer/rest/list)
adds installed model categories and loading metadata to its compatible catalog.
If that native request fails or its overlay is malformed, the worker returns the
usable standard catalog with `metadataIncomplete: true`. The marker is fixed for
every page of its snapshot. Both servers apply successful observations, preserve
missing models and unknown metadata from the prior catalog, and report the scope
as stale instead of asserting that native-only models disappeared. An invalid
overlay is discarded atomically, including entries processed before the error.
Discovery does not require the native interface to permit a configured inference
request.

LiteLLM's standard catalog `mode` and optional `/v1/model/info` metadata identify
embedding and decision routes, including `evaluation`/`decisions` modes and
advertised native endpoints. The worker overlays only public aliases already
listed by that credential's standard catalog and combines observations for
multiple deployments without replacing their gateway alias. Raw deployment
credentials, internal IDs, and upstream connection details never cross the worker
control channel. A failed or malformed overlay rolls back atomically and uses
the same incomplete-metadata retention behavior as LM Studio. Informational
metadata does not establish that an unlisted operation is unsupported, and it
never gates explicitly configured inference. See the [LiteLLM model listing
contract](https://github.com/BerriAI/litellm/blob/main/litellm/types/proxy/model_listing.py),
[gateway model metadata](https://docs.litellm.ai/docs/proxy/model_management), and
[native decision modes](https://docs.litellm.ai/docs/decisions/).

Operation classification is reconciled with prior observations from the same
worker/account scope, not another worker's catalog. Unreported operations retain
their last observation; explicitly reported supported, unsupported, or unknown
statuses replace it. This also prevents a temporary loss of type metadata from
creating a language profile for a previously identified embedding/decision model.
Changing a provider's base URL or protected key clears its operation observations
alongside the existing native metadata invalidation. Retention does not carry old
capabilities into a different connection; configured profiles and defaults remain.
Fresh compatible observations carry their observation time. These timestamps are
retained in capabilities but excluded from metadata hashes, so identical metadata
does not create a new durable snapshot on every refresh.

OpenRouter's public catalog already explicitly requests `output_modalities=all`,
which its [Models documentation](https://openrouter.ai/docs/guides/overview/models)
defines to include embedding and decision models as well as language models.
This public catalog remains separate from authenticated worker endpoint discovery.

Unsloth Studio's [`/v1/models` catalog](https://github.com/unslothai/unsloth/blob/main/studio/backend/routes/inference.py)
also needs `output_modalities=all` to include decision models. Its advertised
architecture modalities flow into operation-specific profiles. Entries with an
unclassified native `task` retain unknown operation support instead of becoming
language profiles through the legacy fallback; Studio lists image, video and
speech models alongside chat models. A `loaded: false` observation is retained
as loading metadata, not permanent lack of API support. Embedding models absent
from this catalog remain manually configurable by their actual served ID.

## Provider coverage

This matrix describes the implemented adapters and documented serving APIs as
reviewed on November 7, 2026. It does not grant access to a model or promise that
every installation exposes every endpoint. Positive operation metadata is scoped
to the connection and worker/account observation. An explicitly configured
request reaches its selected endpoint even when discovery is stale or unknown.

| Connection          | Language                            | Embedding                                                                                                     | Native decisions                                                                 | Discovery and limits                                                                                                                                                                                                                            |
| ------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI API key      | Existing language routes            | `/v1/embeddings`, text, dense float/base64                                                                    | `/v1/decisions`, predicate/choice/score, text/JSON/images                        | API catalog plus a versioned documented model registry; catalog membership does not establish account access.                                                                                                                                   |
| ChatGPT account     | Existing subscription routes        | Not exposed by this connection                                                                                | Not exposed by this connection                                                   | Subscription authentication does not supply API-key operation access.                                                                                                                                                                           |
| Ollama              | Existing language routes            | `/api/embed`, text, dense vectors, truncation disabled                                                        | `/v1/systemone`, model-specific native images/audio                              | `/api/tags` and bounded `/api/show` metadata; native capabilities retained without borrowing chat vision for embeddings.                                                                                                                        |
| OpenRouter          | Existing gateway routes             | Compatible embeddings, including advertised joint image/text inputs                                           | Isolated alpha decision adapter with native media/question envelopes             | Explicit all-operation catalog; gateway routing restrictions retained; embedding fallback disabled.                                                                                                                                             |
| LM Studio / llmster | Existing language routes            | Compatible embeddings for served models                                                                       | OpenAI Decisions and explicitly configured System One; native image envelope     | Native model categories augment the standard catalog; unloaded models remain configurable.                                                                                                                                                      |
| llama.cpp           | Existing language routes            | Compatible or native embeddings, pooled or token vectors and supported media                                  | System One, including model-specific inline image/audio files                    | Advertised modalities retained; native pooling, model limits and fixed-question constraints remain significant.                                                                                                                                 |
| vLLM                | Existing language routes            | Embedding, explicit embedding pooling, and BGE-M3 plugin adapters; supported media and vector representations | Native System One structured decisions and typed media arrays                    | Its standard model cards do not advertise serving tasks. Unknown entries stay unverified; configure the served operation/adapter explicitly when needed. Classification, reranking and generated JSON do not establish native decision support. |
| LiteLLM             | Existing gateway routes             | Compatible embeddings or an explicitly selected native compatible format                                      | Gateway Decisions/System One, native media and explicit TypeSafe image extension | Public aliases retained; optional `model/info` overlay uses only authorized catalog aliases; upstream credentials never leave the worker.                                                                                                       |
| Unsloth Studio      | Existing language routes            | `/v1/embeddings`, text, dense float/base64, truncation disabled                                               | `/v1/systemone`, native image/audio arrays                                       | Documented API must be enabled/configured in Studio; serving backend and model decide availability. Training/export alone does not establish these APIs.                                                                                        |
| MLX-LM              | Existing chat/completion routes     | No standard endpoint verified                                                                                 | No standard endpoint verified                                                    | The standard server dispatches completion routes. Compatible extensions can be configured explicitly; they are not advertised as standard MLX-LM features.                                                                                      |
| xAI API key         | Existing language routes            | No public raw-vector inference endpoint verified                                                              | No native typed decision endpoint verified                                       | Current public API reference is the authority. Collections/search and JSON output are separate capabilities. Compatible extensions remain explicit configuration.                                                                               |
| Grok account        | Existing account routes             | Not exposed by this connection                                                                                | Not exposed by this connection                                                   | Account passthrough remains separate from xAI API-key access.                                                                                                                                                                                   |
| Z.ai Coding Plan    | Existing language routes            | No plan endpoint verified                                                                                     | No native typed decision endpoint verified                                       | Coding Plan and standard API access remain separate. Thinking and structured chat output are language capabilities.                                                                                                                             |
| Custom compatible   | Existing configured language routes | Explicit model, embedding adapter and options                                                                 | Explicit model, decision adapter and options                                     | Custom base paths and protected credentials retained; compatibility with one API never implies every OpenAI endpoint.                                                                                                                           |

The remaining-provider audit uses the current [MLX-LM route dispatcher](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/server.py),
[Unsloth API reference](https://unsloth.ai/docs/basics/api),
[Unsloth System One implementation](https://github.com/unslothai/unsloth/blob/main/studio/backend/routes/systemone.py),
[vLLM model-card protocol](https://github.com/vllm-project/vllm/blob/main/vllm/entrypoints/serve/engine/protocol.py),
[xAI API reference](https://docs.x.ai/developers/rest-api-reference/inference),
[Z.ai documentation index](https://docs.z.ai/llms.txt) and
[Coding Plan scope](https://docs.z.ai/devpack/overview).
Missing documented APIs remain unverified; Cantrip does not manufacture inference
servers, use chat as a hidden substitute, or call a gateway's upstream directly.

## Embedding entry point

The application exports `embed()` from `cantrip_app/src/lib/api.ts`. It accepts a
worker, optional model and route overrides, ordered items with caller IDs, typed
operation options, an optional previous embedding-space identity, and an
`AbortSignal`. An omitted model uses the saved embedding default. With no default,
the server returns `configuration-required`.

```ts
import { embed } from "@/lib/api";

const first = await embed({
  workerId,
  items: [
    { id: "document-1", content: [{ type: "text", text: "Example text" }] },
  ],
});

// Pin later work to the configuration used to produce the existing vectors.
const next = await embed({
  workerId,
  expectedSpace: first.space,
  items: [{ id: "document-2", content: [{ type: "text", text: "More text" }] }],
});
```

Items support ordered text and media parts. Dense text vectors use compatible
`/embeddings` and Ollama `/api/embed`, with joint text/image content parts on
compatible endpoints such as OpenRouter. Native formats also preserve sparse,
multi-vector and combined dense/sparse output. Float and supported base64 vectors
become finite number arrays, preserving their source encoding. Indices are
validated and reordered to match caller items. Missing, duplicate, malformed or
inconsistent vectors fail the operation.

Ollama receives `truncate: false` and Cohere-compatible requests use
`truncate: "NONE"`. No adapter truncates content, drops media, transcribes audio or
creates video frames. Provider-side model loading, templates, pooling configuration
and accepted media remain the configured endpoint's responsibility.

Unsloth's compatible embedding request also sends `truncate: false`, because its
configured embedding-model path otherwise clips oversized text by default.
The returned actual model identity is included in Cantrip's embedding-space
fingerprint, so a changed Unsloth backend identity cannot be combined with prior
batches or silently query an existing space. Media is not passed to Studio's
documented text-only embedding interface.

### Native embedding formats

Select an operation API in the profile's advanced route configuration:

| Adapter                    | Input and output                                                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI-compatible          | Text or joint text/image input parts; dense float/base64 output. A configured llama.cpp connection also uses its documented audio/video parts.                                                            |
| Ollama embed               | Native text arrays and dense vectors.                                                                                                                                                                     |
| llama.cpp native           | `/embeddings`, preserving nested vectors for every item, including unpooled token vectors. Ordered text/image/audio/video parts use llama.cpp's native content-part shapes.                               |
| vLLM embeddings            | `/v1/embeddings`; plain text batches or a single chat-style item per request, including the served model's image/audio/video inputs.                                                                      |
| vLLM embedding pooling     | `/pooling` with an explicit `embed` or `token_embed` task; dense or nested token vectors, never classification scores relabeled as embeddings.                                                            |
| vLLM BGE-M3 plugin         | An already configured BGE-M3 sparse IO processor; dense, sparse or combined dense/sparse results retain actual token IDs and optional token text. Cantrip does not install or modify the serving runtime. |
| Cohere-compatible Embed v2 | `/v2/embed`; text batches or mixed text/image inputs, dimensions/input modes, float/base64 output and truncation disabled.                                                                                |

For a LiteLLM image route using its raw base64 input format, select the compatible
adapter and `base64-images` media encoding. Each item must contain exactly one
inline image. Mixed parts fail explicitly rather than losing text or images. The
request stays on the configured gateway and retains its model alias and key.

vLLM chat-style inputs use one user item per request so multiple independent items
cannot accidentally become one conversation embedding. Each item rejoins FIFO.
Configure `messageRole` for templates using roles such as `query` and `document`;
`inputType` supplies the role when no explicit message role is selected. No prompt
prefix, system instruction or template is invented by Cantrip. Additional native
template and pooling parameters can be configured in the bounded parameter field.
The selected chat input format stays consistent across a mixed job's batches and
is recorded in the returned identity. A later text-only call pinned to that chat
space uses the same chat input format instead of silently switching templates.

`items[].representation` discriminates the result shape:

- `dense`: `values` is one vector.
- `multi-vector`: `values` is an ordered matrix; rows are retained without averaging
  or flattening. Provider `late_chunking` information is retained under
  `metadata.lateChunking` when returned.
- `sparse`: `indices`, `values` and optional `tokens` preserve sparse coordinates.
  The space dimensions are null when the endpoint does not report its vocabulary
  dimension; the largest returned token ID is not substituted for it.
- `hybrid`: `values` holds the dense vector and `sparse` holds the lexical component.
  Space dimensions refer to the dense component, not the sparse vocabulary.

`vectorRepresentation` optionally requires a particular output representation.
For the BGE-M3 plugin it selects the native dense, sparse or combined task. For
other adapters it validates the returned representation without inventing a
conversion. Explicit L2 normalization applies to each dense row and sparse
component independently. Shape-less base64 matrices are not flattened into dense
vectors; use float encoding for nested pooling/chunk output.
Base64 decoding accepts the documented little-endian float32 encoding. Other
native numeric formats must use float JSON output so their bytes are not decoded
with an incorrect dtype or byte order.
For native vLLM base64, explicitly select dense representation. Native pooling
defaults to `token_embed`, or `embed` when dense representation is selected;
the explicit pooling task setting overrides that default.

Dimensions and `input_type` are forwarded where selected. `normalization: "l2"`
explicitly normalizes returned vectors; `none` leaves them unchanged. An omitted
normalization records `provider-default`. Provider-specific parameters cannot
replace typed inputs, model selection, routing, or credentials. Gateway routing is
preserved, while OpenRouter embedding fallbacks are disabled until vector-space
compatibility can be established.

## Identity and routing

The returned space identity includes configured model/route/provider IDs, requested
and reported model names, dimensions, input mode, normalization, revision
provenance, and a fingerprint of the effective native request configuration and
resolved adapter/endpoint. Inference content is excluded from that fingerprint. A
missing reported model remains null. A configured revision or previously observed
catalog digest is recorded with its source; it does not prove which weights the
current HTTP request used. `revisionVerified` remains false for these adapters.
Mutable aliases can change without an API reporting a new revision.

Existing indexes must retain this identity and their input preparation policy.
The client pins `expectedSpace.modelId` and `routeId` instead of consulting a later
default. The worker rejects a changed fingerprint and never returns mixed spaces
across batches. Equal dimensions and user-supplied space labels do not authorize
fallback. Current embedding execution uses the configured first enabled route, or
an explicitly pinned route, and does not automatically try another route.

Input mode is part of this strict identity. Applications using asymmetric
query/document modes must establish the model's paired-mode compatibility rather
than treating different modes as interchangeable because dimensions match.
Representation, pooling task, template parameters and message role also affect
the identity. Older fingerprints that omitted the effective native envelope may
fail this stricter comparison; callers must explicitly establish compatibility
rather than relabel existing vectors automatically.

## Transport and ownership

`POST /api/model-operations/embedding` carries an authenticated routing scope and
encrypted request. The app authorizes the selected worker's model-operation and
provider-credential keys. The server checks worker ownership and resolves the
configured operation route; it does not decrypt inputs or vectors and does not
require a current catalog or successful health probe. Both server implementations
relay the same worker command and protected response schema.

Each bounded batch enters the existing worker provider FIFO through
`WorkerInferenceAdmission.runDirect()`, joins cancellation with its actual HTTP
request, drains or cancels its response body, then settles and rejoins the queue
for the next batch. Request timeouts start after admission, so queue time does not
consume them. Input JSON, individual HTTP payloads, and protected output JSON are
bounded to 4 MiB. Batches contain at most 32 items and are reduced for known vector
dimensions and request size. Commands including encrypted content, route metadata,
and protected credentials must fit 7 MiB, leaving overhead within the default
8 MiB worker WebSocket frame. Larger jobs must be submitted in smaller groups.
Partial vectors are not returned as a successful complete result.

`POST /api/model-operations/embedding/cancel` requests cancellation. An
acknowledgment means the cancellation was received, not that the remote provider
stopped computing. Capacity remains charged until the local callback and body
cleanup settle. The application forwards `AbortSignal` cancellation and disables
automatic request replay. In-flight duplicate operation IDs join their original
result; completed IDs are metadata-only tombstones for that worker incarnation
and are not executed again. The replay ledger is bounded to 10,000 operation IDs;
once full it refuses new operations instead of evicting replay protection. A new
worker incarnation starts a fresh ledger and does not automatically replay work.

### Worker calls inside a native preparation

The worker exports `embed()` and `decide()` for authenticated canonical command
callers. They normally acquire independent tickets. An already-admitted native
owner can instead use `CodexInferenceExecution.prepareModelOperations()` while its
input is still blocked and it has no native execution binding:

```ts
import { embed } from "./model-embedding.js";

const vectors = await execution.prepareModelOperations(async (preparation) => {
  return await embed({
    admission,
    route: resolvedEmbeddingRoute,
    request: {
      items: [
        { id: "document-1", content: [{ type: "text", text: "Example" }] },
      ],
    },
    preparation,
  });
});
// Only after preparation returns may this owner dispatch its native input.
```

The context is an opaque worker-issued capability tied to this admission service
and actual lease; wire IDs and UI status cannot grant borrowing authority. Native
dispatch, native binding, and unused-reservation withdrawal cannot overlap the
preparation. This API is not a way to borrow a ticket from a concurrently running
native model call or an unrelated chat. The existing native-RPC `prepare()` API
does not establish HTTP ownership and must not wrap independent HTTP work.

A sequential same-provider decision can use the held reservation without another
acquisition. Concurrent calls acquire their own tickets. Once a concurrent child
exists, the borrowed HTTP callback finishes its actual teardown before the parent
yields; at a limit of one, that yield lets the waiting child run. Cross-provider
work yields an idle parent before queuing at the destination, avoiding a parent
reservation held across a child wait. Each embedding batch yields, including a
borrowed first batch; later batches rejoin FIFO independently. After all children
finish, a live parent rejoins FIFO before native dispatch may continue.

Await every `embed()`/`decide()` call within the structured callback, including all
embedding batches. An escaped context rejects new work after that callback closes.
Closure also joins already-admitted callbacks even if a caller catches a failure
or returns early. A failed preparation cancels outstanding children; its caller
may recover only after any live parent has reacquired permission. Parent source
closure, cancellation, native-process retirement, and worker shutdown propagate
cancellation and wait for real HTTP/body teardown. Native process death alone
never releases capacity still used by its HTTP children. Callbacks must honor the
provided signal and join their own resource cleanup; aborting a connection does
not prove the remote provider stopped computing.

## Direct-operation usage

Both servers opt into count-only worker receipts through the optional transport
envelope. The strict inference command and protected client response are unchanged:
an older worker can still execute the command, and an older server does not receive
the extended private response. The servers remove the receipt before forwarding
the encrypted result to the app.

The worker observes each actual HTTP request after payload validation and retains
valid numeric usage before validating vectors or decision answers. Completed
batches still contribute known usage when a later batch, response validation, or
embedding-space check fails. Receipts include request outcomes, HTTP duration,
worker version, and coverage for each reported token counter. They contain no
inputs, outputs, media, vectors, credentials, or provider error text.

An observed token subtotal prefers each request's reported total, otherwise its
known input/output counts. It is accumulated per request, preserving reports from
different partial batches without double-counting them. Missing counters remain
null in the receipt; overflow is explicit. Legacy numeric rollups include only
known counts, with reporting coverage shown in provider telemetry and retained in
exports. A subtotal is not an assertion of complete billing. The provider-reported
total is only populated when every observed request reports it.

Usage is persisted asynchronously in the existing token ledger under an identity
bound to the owner, server, worker, and operation UUID, with the dispatched
model/route/provider identities retained separately from nullable foreign keys.
It creates no synthetic chat, turn, behavior observation, or agent-time interval.
A valid terminal receipt is immutable; late bootstrap or disconnect reports cannot
replace it. No inference is replayed to recover usage.

Telemetry persistence never gates inference or its protected response. A legacy
worker, transport loss, shutdown, or persistence failure can leave an unknown or
missing observation. There is no durable worker receipt outbox in this path, so it
does not guarantee recovery after a lost response or process crash. Unknown usage
must not be interpreted as free inference or zero provider consumption. When the
worker's inference start is unknown, telemetry ranges use the server observation
time; the actual start remains null and contributes no invented daily token data.

## Provider contracts and validation

The initial adapter contracts are grounded in the official
[OpenAI embeddings guide](https://developers.openai.com/api/docs/guides/embeddings),
[Ollama embed reference](https://docs.ollama.com/api/embed), and
[OpenRouter embeddings reference](https://openrouter.ai/docs/api_reference/embeddings),
[llama.cpp server reference](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md),
[vLLM embedding/pooling reference](https://docs.vllm.ai/en/latest/models/pooling_models/embed/),
[vLLM token embedding reference](https://docs.vllm.ai/en/latest/models/pooling_models/token_embed/),
[vLLM BGE-M3 plugin contract](https://docs.vllm.ai/en/latest/models/pooling_models/specific_models/#dense-and-sparse-output-through-an-io-processor-plugin),
and [LiteLLM image embeddings](https://docs.litellm.ai/docs/embedding/supported_embedding#image-embeddings).

## Native decisions

The application also exports `decide()`. It uses the independent decision default
unless a caller supplies a decision profile/route. No default returns
`configuration-required`; no ordinary chat model is substituted.

```ts
import { decide } from "@/lib/api";

const result = await decide({
  workerId,
  state: { ticket: "The checkout fails after payment." },
  questions: [
    { id: "urgent", type: "predicate", instructions: "Is revenue blocked?" },
    {
      id: "team",
      type: "choice",
      instructions: "Which team should own this?",
      choices: [
        { id: "payments", description: "Payment processing problems" },
        { id: "frontend", description: "Rendering or navigation problems" },
      ],
    },
  ],
});
```

Questions have stable IDs and predicate, choice, or ordered score types. Choice
IDs are sent as native choice values; score level IDs become OpenAI level labels,
while System One's ordered descriptions retain their original position. Scores
remain probability-weighted averages of zero-based level indices. No conversion
to percentages or a universal confidence scale occurs. Optional predicate
true/false criteria become explicit instructions in the OpenAI envelope and native
criteria in System One/OpenRouter.

The shared contract permits 1–255 choices or score levels. These are transport
bounds across native formats, not a promise that each model accepts that many;
the selected endpoint enforces its own smaller limits. Descriptions may be
omitted or null. System One choices preserve null criteria, while a score level
without a description uses its supplied ID as the native label. OpenAI options
retain their ID/label and omit an absent description.

`instructions` may be omitted for native models with a fixed question. Cantrip
does not invent a prompt or send an empty instructions field. For example, a
fixed OCR-consistency model can receive OCR text in `state`, its original and
rendered images in shared `media`, and a predicate containing only `id` and
`type`. This supports the [llama.cpp question constraints](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#post-v1systemone-typesafe-compatible-system-one-api)
without guessing constraints from model names.

Each question may also provide `instructionImages`, an ordered list of image
parts, alongside its text instructions. The OpenAI adapter emits native
instruction content parts; see [question-specific images](https://developers.openai.com/api/docs/guides/decisions#include-images-in-question-instructions).
OpenRouter uses its native question image parts, which its
[multimodal contract](https://openrouter.ai/docs/guides/community/multimodal-decisions)
currently permits on Jev routes. Other endpoints decide their actual support.
On a System One gateway using the explicit TypeSafe image extension, these images
become assets referenced by that question's instructions, separate from shared
state images. The ordinary System One envelope rejects question-specific images
instead of moving them into shared state or serializing them as text. All images
remain subject to the same total protected-content size limit.

Results restore request order, validate answer/question identity, selected choices,
probability ranges/distributions and rubric score ranges, and retain the native
answer alongside normalized fields. Explicit per-question errors produce a
`partial` result; refusals retain their own type. Malformed or missing answers fail
the operation. Missing confidence, usage and actual-model/provider fields remain
null. Returned confidence retains the selected adapter's semantics.

Adapters are isolated for OpenAI `/decisions`, native `/systemone`, and OpenRouter
`/api/alpha/decisions`. They use their documented question arrays or maps, rather
than treating all compatible endpoints as the same API. OpenRouter's alpha
envelope is isolated from the other adapters. Explicitly configured endpoints may
attempt execution without a successful capability refresh.

`state` accepts bounded JSON or a string, with an optional ordered `media` list:

| Adapter / connection           | Media envelope                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| OpenAI Decisions               | Text/JSON input parts followed by images; HTTP(S) or inline image data URLs                |
| System One / Ollama            | Shared state plus raw-base64 `images`; image acceptance remains model-specific             |
| System One / llama.cpp         | Ordered `files` with inline image/audio data URLs; no video conversion                     |
| System One / LM Studio         | Inline data URLs in the compatible `images` field                                          |
| System One / vLLM              | Separate `images`, `audio`, and `videos` URL/data-URL arrays                               |
| System One / Unsloth Studio    | Separate inline PNG/JPEG `images` and `audio` data-URL arrays; no video                    |
| LiteLLM Decisions / System One | Native image envelope plus separate inline `audio` and `videos` arrays                     |
| OpenRouter Decisions           | Shared state followed by native top-level image/audio/video parts; inline base64 data URLs |

System One's media format defaults to the selected backend's native contract.
Explicit `mediaFormat` overrides support custom deployments: `base64-images` for
raw base64, `data-url-files` for ordered inline files, and `media-urls` for typed
media arrays. Within each native media array, caller order is retained. llama.cpp
and LM Studio do not gain video support through the file encoding. vLLM receives
media URLs without the worker downloading them; the served model decides which
modalities it accepts. See the [llama.cpp API](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#post-v1systemone-typesafe-compatible-system-one-api),
[LM Studio System One](https://lmstudio.ai/docs/developer/jev-compat/systemone),
and [vLLM decision contract](https://docs.vllm.ai/en/latest/models/structured_decisions_models/).

LiteLLM's default OpenAI Decisions adapter supports its documented inline audio
and video fields. For a custom compatible gateway, `mediaFormat: "media-urls"`
explicitly selects that extension; the ordinary OpenAI API contract remains
text/JSON/images. The optional `typesafeImages` setting adds only the fixed
`TypeSafe-Danger-Zone-Images: true` header. On the System One gateway path it also
creates PNG/JPEG assets with opaque references included in state, rather than
mistaking TypeSafe assets for a raw-base64 image list. It does not allow arbitrary
headers or change authorization. On the OpenAI gateway path images remain native
`input_image` parts. The [LiteLLM contract](https://docs.litellm.ai/docs/decisions/)
documents these formats and deployment restrictions. Configure gateway routes to
reject unsupported media: a gateway configured with `drop_params` may discard it
upstream, which Cantrip cannot prove from a successful response. Cantrip itself
does not remove those media parts or add a text fallback.

No remote media is downloaded by the worker. No transcription, transcoding, video
frame extraction or captioning is performed. Model-specific media/question limits
remain the actual endpoint's responsibility; catalog uncertainty is not an
execution gate. Inline media and normalized results must fit the same 4 MiB content
and 7 MiB command limits as embeddings. Larger media transport is not implemented
by this milestone.

Decision calls use `POST /api/model-operations/decision` and its `/cancel` endpoint,
with operation-specific authenticated encryption context. Both servers and the
worker share route resolution, cancellation and bounded replay handling with
embeddings. Every standalone native HTTP request acquires the existing provider
FIFO ticket and holds it until HTTP/body teardown settles. Timeout begins after
admission. Worker callers may use the explicit blocked-native preparation context
described above for sequential reuse and structured child ownership.

Contracts: [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions),
[Ollama System One](https://docs.ollama.com/api/systemone), and
[OpenRouter native Decisions](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)
and its [multimodal envelope](https://openrouter.ai/docs/guides/community/multimodal-decisions).

Source/diff review, formatting, mechanical protocol export, Rust contract
generation, and `git diff --check` do not prove runtime behavior. No local tests,
benchmarks, live inference probes, builds/typechecks, or computer-use testing were
performed under the user's restriction.
