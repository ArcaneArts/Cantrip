# Model operations

Models have independent language, embedding, and native decision profiles, backed
by the existing provider and catalog identities. Models → General has nullable
embedding and decision defaults; discovery never selects either automatically.
Provider tabs expose each operation separately. Subscription account connections
do not acquire API-key operation access by sharing a provider's model names.

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

Items support ordered text and media parts. This execution milestone implements
dense text vectors through OpenAI-compatible `/embeddings` and Ollama `/api/embed`,
plus the documented joint text/image content-parts format on compatible endpoints
such as OpenRouter. Float and OpenAI-compatible base64 vectors are normalized to
finite number arrays, preserving their source encoding. Indices are validated and
reordered to match the caller's items. Missing, duplicate, malformed, or
inconsistent vectors fail the operation.

Ollama receives `truncate: false`. No adapter silently truncates content, drops
media, or transcribes audio. Audio/video parts, additional native media envelopes,
sparse/multi-vector output, and native decision execution require subsequent
provider integrations; their presence in capability metadata is not a claim that
this initial embedding transport implements them.

Dimensions and `input_type` are forwarded where selected. `normalization: "l2"`
explicitly normalizes returned vectors; `none` leaves them unchanged. An omitted
normalization records `provider-default`. Provider-specific parameters cannot
replace typed inputs, model selection, routing, or credentials. Gateway routing is
preserved, while OpenRouter embedding fallbacks are disabled until vector-space
compatibility can be established.

## Identity and routing

The returned space identity includes configured model/route/provider IDs, requested
and reported model names, dimensions, input mode, normalization, revision
provenance, and a fingerprint of the effective configuration and endpoint. A
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

The exported worker `embed()` is a standalone execution entry point. Integration
with an already-admitted native turn still needs explicit dependent HTTP ownership:
native process death alone cannot establish settlement of a separate HTTP request.
Do not nest an independent acquisition while holding the same provider's ticket.

## Provider contracts and validation

The initial adapter contracts are grounded in the official
[OpenAI embeddings guide](https://developers.openai.com/api/docs/guides/embeddings),
[Ollama embed reference](https://docs.ollama.com/api/embed), and
[OpenRouter embeddings reference](https://openrouter.ai/docs/api_reference/embeddings).
Additional provider media and decision contracts remain part of the active
implementation goal.

Source/diff review, formatting, mechanical protocol export, Rust contract
generation, and `git diff --check` do not prove runtime behavior. No local tests,
benchmarks, live inference probes, builds/typechecks, or computer-use testing were
performed under the user's restriction.
