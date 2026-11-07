import { createHash } from "node:crypto";
import {
  embeddingInputSchema,
  embeddingResultSchema,
  MODEL_OPERATION_CONTENT_BYTES_LIMIT,
  type EmbeddingInput,
  type EmbeddingResult,
  type EmbeddingSpaceIdentity,
  type ModelOperationRoute,
  type ModelOperationOptions,
} from "@cantrip/protocol";
import {
  claimInferenceCommandSource,
  inferenceCommandSignal,
  trackInferenceCommandOperation,
} from "./inference-command.js";
import type { WorkerInferenceAdmission } from "./inference-admission.js";
import type { RuntimeProvider } from "./protected-secrets.js";
import { ModelOperationError } from "./model-operation-error.js";
import {
  embeddingPayload as payload,
  embeddingBatchLimit,
  embeddingAdapter,
  embeddingUsesChat,
  embeddingDimensions,
  parseEmbeddingBatch,
  embeddingResponseRoot,
  object,
} from "./model-embedding-formats.js";
import {
  observeModelOperationRequest,
  reportedModelOperationUsage,
  type ModelOperationUsageCollector,
} from "./model-operation-usage.js";
export { ModelOperationError } from "./model-operation-error.js";

type Route = Omit<ModelOperationRoute, "provider"> & {
  provider: RuntimeProvider;
};
const MAX_BYTES = MODEL_OPERATION_CONTENT_BYTES_LIMIT;
const MAX_VECTOR_BYTES = MAX_BYTES - 32768;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
function aborted(signal: AbortSignal): never {
  const timedOut =
    signal.reason instanceof Error && signal.reason.name === "TimeoutError";
  throw new ModelOperationError(
    timedOut ? "provider-error" : "cancelled",
    timedOut
      ? "The embedding provider request timed out."
      : "The embedding operation was cancelled.",
  );
}
function addUsage(previous: number | null, next: number | null): number | null {
  if (previous === null || next === null) return null;
  const total = previous + next;
  if (!Number.isSafeInteger(total)) invalidResponse();
  return total;
}
function invalidResponse(): never {
  throw new ModelOperationError(
    "invalid-response",
    "The provider returned malformed embedding data.",
  );
}
async function requestBatch(
  route: Route,
  options: ModelOperationOptions,
  items: EmbeddingInput["items"],
  signal: AbortSignal,
  fetcher: typeof fetch,
  usageCollector?: ModelOperationUsageCollector,
) {
  const request = payload(route, options, items);
  const body = JSON.stringify(request.body);
  if (Buffer.byteLength(body) > MAX_BYTES)
    throw new ModelOperationError(
      "invalid-request",
      "The embedding batch exceeds the 4 MiB request limit.",
    );
  return observeModelOperationRequest(
    usageCollector,
    signal,
    async (report) => {
      let response: Response;
      try {
        response = await fetcher(request.url, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...(route.provider.apiKey
              ? { authorization: `Bearer ${route.provider.apiKey}` }
              : {}),
          },
          body,
        });
      } catch {
        if (signal.aborted) aborted(signal);
        throw new ModelOperationError(
          "provider-error",
          "The embedding provider request failed.",
        );
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      try {
        if (!response.ok)
          throw new ModelOperationError(
            "provider-error",
            `The embedding provider returned HTTP ${response.status}.`,
            response.status,
          );
        if (!reader) invalidResponse();
        let bytes = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > MAX_BYTES)
            throw new ModelOperationError(
              "invalid-response",
              "The embedding response exceeded 4 MiB.",
            );
          chunks.push(part.value);
        }
        signal.throwIfAborted();
        let parsed: unknown;
        const combined = Buffer.concat(chunks);
        try {
          parsed = JSON.parse(combined.toString("utf8"));
        } catch {
          invalidResponse();
        } finally {
          combined.fill(0);
          for (const chunk of chunks) chunk.fill(0);
        }
        const raw = embeddingResponseRoot(parsed, request.adapter);
        report(reportedModelOperationUsage(raw, "embedding"));
        const vectors = parseEmbeddingBatch(
          parsed,
          request.adapter,
          options,
          items.length,
        );
        const dimensions = embeddingDimensions(vectors[0]!);
        const usage = object(raw.usage);
        const count = (value: unknown): number | null => {
          if (value === undefined || value === null) return null;
          if (
            typeof value !== "number" ||
            !Number.isSafeInteger(value) ||
            value < 0
          )
            invalidResponse();
          return value;
        };
        const {
          input: _input,
          inputs: _inputs,
          messages: _messages,
          images: _images,
          texts: _texts,
          data: plugin,
          ...configuration
        } = request.body;
        const { input: _pluginInput, ...pluginOptions } = object(plugin);
        const inputFormat = ["vllm-embeddings", "vllm-pooling"].includes(
          request.adapter,
        )
          ? Array.isArray(request.body.messages)
            ? ("chat" as const)
            : ("text" as const)
          : undefined;
        return {
          vectors,
          dimensions,
          inputFormat,
          configuration: {
            ...configuration,
            ...(plugin ? { data: pluginOptions } : {}),
            endpoint: request.url,
            adapter: request.adapter,
            ...(inputFormat
              ? {
                  inputFormat,
                  messageRole: Array.isArray(request.body.messages)
                    ? object(request.body.messages[0]).role
                    : null,
                }
              : {}),
          },
          actualModel:
            typeof raw.model === "string" && raw.model ? raw.model : null,
          inputTokens: count(
            usage.prompt_tokens ??
              usage.input_tokens ??
              raw.prompt_eval_count ??
              object(object(raw.meta).billed_units).input_tokens,
          ),
          totalTokens: count(usage.total_tokens ?? raw.prompt_eval_count),
        };
      } catch (error) {
        if (signal.aborted) aborted(signal);
        if (error instanceof ModelOperationError) throw error;
        invalidResponse();
      } finally {
        for (const chunk of chunks) chunk.fill(0);
        if (reader) {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
    },
  );
}

/** Standalone embedding execution with one independently admitted batch at a time.
 * This entry point does not inherit a native turn's reservation. */
export async function embed(input: {
  request: EmbeddingInput;
  route: Route;
  admission: WorkerInferenceAdmission;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  usageCollector?: ModelOperationUsageCollector;
}): Promise<EmbeddingResult> {
  const request = embeddingInputSchema.parse(input.request);
  const { route, admission } = input;
  const options = {
    ...route.options,
    ...request.options,
    parameters: { ...route.options.parameters, ...request.options?.parameters },
  };
  // Keep one native input pipeline across a multimodal job and later pinned
  // text-only requests. A batch's contents must not silently switch templates.
  if (
    request.expectedSpace?.inputFormat === "chat" &&
    ["vllm-embeddings", "vllm-pooling"].includes(embeddingAdapter(route))
  )
    options.mediaFormat ??= "content-parts";
  if (embeddingUsesChat(route, options, request.items))
    options.mediaFormat ??= "content-parts";
  if (options.normalization && !["none", "l2"].includes(options.normalization))
    throw new ModelOperationError(
      "invalid-request",
      "Normalization must be none or l2, or left at the provider default.",
    );
  admission.configure({
    providerId: route.provider.id,
    maxConcurrentInference: route.provider.maxConcurrentInference,
    inferenceConfigRevision: route.provider.inferenceConfigRevision,
    inferenceCatalogCreatedRevision:
      route.provider.inferenceCatalogCreatedRevision,
  });
  const signal = AbortSignal.any(
    [input.signal, inferenceCommandSignal()].filter(
      (value): value is AbortSignal => Boolean(value),
    ),
  );
  const batchSize = Math.min(
    embeddingBatchLimit(route, options, request.items),
    options.maxBatchSize ?? 32,
    route.capabilities.embedding?.maxBatchSize ?? 32,
    Math.max(
      1,
      Math.floor(
        MAX_VECTOR_BYTES /
          ((options.dimensions ??
            route.capabilities.embedding?.dimensions ??
            4096) *
            24),
      ),
    ),
  );
  const items: EmbeddingResult["items"] = [];
  let space: EmbeddingSpaceIdentity | null = null;
  let inputTokens: number | null = 0,
    totalTokens: number | null = 0,
    batches = 0,
    resultBytes = 0;
  for (let offset = 0; offset < request.items.length;) {
    signal.throwIfAborted();
    let batch = request.items.slice(offset, offset + batchSize);
    while (
      batch.length > 1 &&
      Buffer.byteLength(JSON.stringify(payload(route, options, batch).body)) >
        MAX_BYTES
    )
      batch = batch.slice(0, Math.ceil(batch.length / 2));
    let result: Awaited<ReturnType<typeof requestBatch>>;
    const execute = (permissionSignal: AbortSignal) =>
      requestBatch(
        route,
        options,
        batch,
        AbortSignal.any([
          permissionSignal,
          AbortSignal.timeout(options.timeoutMs ?? 120000),
        ]),
        input.fetcher ?? globalThis.fetch,
        input.usageCollector,
      );
    const source = claimInferenceCommandSource(signal);
    if (!source)
      throw new ModelOperationError(
        "configuration-required",
        "Embedding inference requires an authenticated canonical worker command.",
      );
    trackInferenceCommandOperation(source.source.operationId);
    try {
      result = await admission.runDirect(
        {
          source: source.source,
          providerId: route.provider.id,
          providerCreationRevision:
            route.provider.inferenceCatalogCreatedRevision,
          signal,
        },
        execute,
      );
    } finally {
      source.close();
    }
    batches++;
    const modelRevision = options.modelRevision ?? route.observedRevision;
    const identity = {
      version: 1 as const,
      modelId: route.modelId,
      routeId: route.routeId,
      providerId: route.provider.id,
      requestedModel: route.modelName,
      actualModel: result.actualModel,
      modelRevision,
      revisionVerified: false,
      revisionSource: options.modelRevision
        ? ("configured" as const)
        : route.observedRevision
          ? ("provider-catalog" as const)
          : ("unknown" as const),
      dimensions: result.dimensions,
      ...(result.inputFormat ? { inputFormat: result.inputFormat } : {}),
      ...(result.vectors[0]!.representation === "dense"
        ? {}
        : { representation: result.vectors[0]!.representation }),
      normalization: options.normalization ?? "provider-default",
      inputType: options.inputType ?? null,
      configuredSpace: options.embeddingSpace ?? null,
    };
    const fingerprint = digest({
      identity,
      configuration: result.configuration,
      vectorRepresentation: options.vectorRepresentation,
      messageRole: options.messageRole,
      mediaFormat: options.mediaFormat ?? "content-parts",
    });
    const currentSpace = { ...identity, fingerprint };
    if (
      (space && space.fingerprint !== fingerprint) ||
      (request.expectedSpace &&
        request.expectedSpace.fingerprint !== fingerprint)
    )
      throw new ModelOperationError(
        "embedding-space-mismatch",
        "The endpoint returned a different embedding space. Vectors were not combined or returned.",
      );
    space = currentSpace;
    const additions = result.vectors.map((value, index) => ({
      id: batch[index]!.id,
      index: offset + index,
      ...value,
    }));
    resultBytes += Buffer.byteLength(JSON.stringify(additions));
    if (resultBytes > MAX_VECTOR_BYTES)
      throw new ModelOperationError(
        "invalid-request",
        "The embedding result exceeds 4 MiB. Submit smaller jobs.",
      );
    items.push(...additions);
    inputTokens = addUsage(inputTokens, result.inputTokens);
    totalTokens = addUsage(totalTokens, result.totalTokens);
    offset += batch.length;
  }
  const result = embeddingResultSchema.parse({
    space,
    items,
    usage: { inputTokens, totalTokens },
    batches,
  });
  if (
    Buffer.byteLength(JSON.stringify({ status: "succeeded", value: result })) >
    MAX_BYTES
  )
    throw new ModelOperationError(
      "invalid-request",
      "The embedding result exceeds 4 MiB. Submit smaller jobs.",
    );
  return result;
}
