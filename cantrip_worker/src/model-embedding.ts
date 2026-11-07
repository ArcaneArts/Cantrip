import { createHash } from "node:crypto";
import {
  embeddingInputSchema,
  embeddingResultSchema,
  normalizeResponsesBaseUrl,
  operationProviderFamily,
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

type Route = Omit<ModelOperationRoute, "provider"> & {
  provider: RuntimeProvider;
};
type Code =
  | "configuration-required"
  | "invalid-request"
  | "unsupported-input"
  | "provider-error"
  | "invalid-response"
  | "embedding-space-mismatch"
  | "cancelled";
export class ModelOperationError extends Error {
  constructor(
    readonly code: Code,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}
const MAX_BYTES = MODEL_OPERATION_CONTENT_BYTES_LIMIT;
const MAX_VECTOR_BYTES = MAX_BYTES - 32768;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
function vector(raw: unknown): {
  values: number[];
  sourceEncoding: "float" | "base64";
} {
  let values: unknown = raw;
  let sourceEncoding: "float" | "base64" = "float";
  if (typeof raw === "string") {
    // The OpenAI-compatible base64 representation is little-endian float32.
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        raw,
      )
    )
      invalidResponse();
    const bytes = Buffer.from(raw, "base64");
    if (!bytes.length || bytes.length % 4 || bytes.length > 65536 * 4)
      invalidResponse();
    try {
      values = Array.from({ length: bytes.length / 4 }, (_, index) =>
        bytes.readFloatLE(index * 4),
      );
    } finally {
      bytes.fill(0);
    }
    sourceEncoding = "base64";
  }
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length > 65536 ||
    !values.every((v) => typeof v === "number" && Number.isFinite(v))
  )
    invalidResponse();
  return { values: values as number[], sourceEncoding };
}
function normalized(
  values: number[],
  normalization: string | undefined,
): number[] {
  if (!normalization || normalization === "none") return values;
  if (normalization !== "l2")
    throw new ModelOperationError(
      "invalid-request",
      "Normalization must be none or l2, or left at the provider default.",
    );
  const scale = Math.max(...values.map(Math.abs));
  if (!scale)
    throw new ModelOperationError(
      "invalid-response",
      "A zero embedding vector cannot be normalized.",
    );
  const norm = Math.sqrt(
    values.reduce((sum, value) => sum + (value / scale) ** 2, 0),
  );
  return values.map((value) => value / scale / norm);
}
function payload(
  route: Route,
  options: ModelOperationOptions,
  items: EmbeddingInput["items"],
) {
  const adapter =
    route.adapter ??
    (route.provider.kind === "ollama" ? "ollama-embed" : "openai-embeddings");
  if (
    !["ollama-embed", "openai-embeddings"].includes(adapter) ||
    ["chatgpt", "grok"].includes(route.provider.kind)
  )
    throw new ModelOperationError(
      "configuration-required",
      "This connection does not expose the configured embedding API.",
    );
  const parameters = options.parameters ?? {};
  const reserved = new Set([
    "model",
    "input",
    "messages",
    "questions",
    "state",
    "provider",
    "dimensions",
    "input_type",
    "encoding_format",
    "truncate",
    "stream",
    "api_key",
    "apikey",
    "api-key",
    "access_token",
    "base_url",
    "baseurl",
    "headers",
    "authorization",
  ]);
  if (Object.keys(parameters).some((key) => reserved.has(key.toLowerCase())))
    throw new ModelOperationError(
      "invalid-request",
      "Additional parameters cannot replace embedding inputs, routing, credentials, or typed options.",
    );
  if (
    items.some((item) =>
      item.content.some(
        (part) => part.type === "audio" || part.type === "video",
      ),
    )
  )
    throw new ModelOperationError(
      "unsupported-input",
      "This embedding adapter requires a native audio/video media format.",
    );
  const textOnly = items.every((item) =>
    item.content.every((part) => part.type === "text"),
  );
  const input = textOnly
    ? items.map((item) =>
        item.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join(""),
      )
    : items.map((item) => ({
        content: item.content.map((part) =>
          part.type === "text"
            ? { type: "text", text: part.text }
            : part.type === "image"
              ? { type: "image_url", image_url: { url: part.url } }
              : part.type === "audio"
                ? { type: "audio_url", audio_url: { url: part.url } }
                : { type: "video_url", video_url: { url: part.url } },
        ),
      }));
  if (adapter === "ollama-embed") {
    if (!textOnly)
      throw new ModelOperationError(
        "unsupported-input",
        "Ollama's embed API accepts text inputs.",
      );
    if (
      options.inputType ||
      options.encodingFormat === "base64" ||
      options.providerRouting ||
      options.mediaFormat
    )
      throw new ModelOperationError(
        "invalid-request",
        "The selected Ollama embed API does not accept these operation options.",
      );
    const base = normalizeResponsesBaseUrl(route.provider.baseUrl).replace(
      /\/v1$/,
      "",
    );
    return {
      url: `${base}/api/embed`,
      body: {
        ...parameters,
        model: route.modelName,
        input,
        truncate: false,
        ...(options.dimensions ? { dimensions: options.dimensions } : {}),
      },
      adapter,
    };
  }
  if (options.mediaFormat && options.mediaFormat !== "content-parts")
    throw new ModelOperationError(
      "unsupported-input",
      "Select a content-parts embedding endpoint for this media encoding.",
    );
  const openRouter = operationProviderFamily(route.provider) === "openrouter";
  if (openRouter && options.providerRouting?.allow_fallbacks === true)
    throw new ModelOperationError(
      "invalid-request",
      "Gateway embedding fallback requires established embedding-space compatibility.",
    );
  const providerRouting = openRouter
    ? { ...options.providerRouting, allow_fallbacks: false }
    : options.providerRouting;
  return {
    url: `${normalizeResponsesBaseUrl(route.provider.baseUrl)}/embeddings`,
    body: {
      ...parameters,
      model: route.modelName,
      input,
      encoding_format: options.encodingFormat ?? "float",
      ...(options.dimensions ? { dimensions: options.dimensions } : {}),
      ...(options.inputType ? { input_type: options.inputType } : {}),
      ...(providerRouting ? { provider: providerRouting } : {}),
    },
    adapter,
  };
}
async function requestBatch(
  route: Route,
  options: ModelOperationOptions,
  items: EmbeddingInput["items"],
  signal: AbortSignal,
  fetcher: typeof fetch,
) {
  const request = payload(route, options, items);
  const body = JSON.stringify(request.body);
  if (Buffer.byteLength(body) > MAX_BYTES)
    throw new ModelOperationError(
      "invalid-request",
      "The embedding batch exceeds the 4 MiB request limit.",
    );
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
  try {
    if (!response.ok)
      throw new ModelOperationError(
        "provider-error",
        `The embedding provider returned HTTP ${response.status}.`,
        response.status,
      );
    if (!reader) invalidResponse();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
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
    let raw: Record<string, unknown>;
    const combined = Buffer.concat(chunks);
    try {
      raw = object(JSON.parse(combined.toString("utf8")));
    } catch {
      invalidResponse();
    } finally {
      combined.fill(0);
      for (const chunk of chunks) chunk.fill(0);
    }
    let ordered: unknown[];
    if (request.adapter === "ollama-embed") {
      if (
        !Array.isArray(raw.embeddings) ||
        raw.embeddings.length !== items.length
      )
        invalidResponse();
      ordered = raw.embeddings;
    } else {
      if (!Array.isArray(raw.data) || raw.data.length !== items.length)
        invalidResponse();
      const indexed = new Map<number, unknown>();
      for (const entry of raw.data) {
        const value = object(entry);
        if (
          !Number.isInteger(value.index) ||
          (value.index as number) < 0 ||
          (value.index as number) >= items.length ||
          indexed.has(value.index as number)
        )
          invalidResponse();
        indexed.set(value.index as number, value.embedding);
      }
      ordered = items.map((_, index) => indexed.get(index));
    }
    const vectors = ordered.map(vector).map((value) => ({
      ...value,
      values: normalized(value.values, options.normalization),
    }));
    const dimensions = vectors[0]!.values.length;
    if (
      vectors.some((value) => value.values.length !== dimensions) ||
      (options.dimensions && dimensions !== options.dimensions)
    )
      invalidResponse();
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
    return {
      vectors,
      dimensions,
      actualModel:
        typeof raw.model === "string" && raw.model ? raw.model : null,
      inputTokens: count(
        usage.prompt_tokens ?? usage.input_tokens ?? raw.prompt_eval_count,
      ),
      totalTokens: count(usage.total_tokens ?? raw.prompt_eval_count),
    };
  } catch (error) {
    if (signal.aborted) aborted(signal);
    if (error instanceof ModelOperationError) throw error;
    invalidResponse();
  } finally {
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

/** Standalone embedding execution with one independently admitted batch at a time.
 * This entry point does not inherit a native turn's reservation. */
export async function embed(input: {
  request: EmbeddingInput;
  route: Route;
  admission: WorkerInferenceAdmission;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<EmbeddingResult> {
  const request = embeddingInputSchema.parse(input.request);
  const { route, admission } = input;
  const options = {
    ...route.options,
    ...request.options,
    parameters: { ...route.options.parameters, ...request.options?.parameters },
  };
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
    32,
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
      normalization: options.normalization ?? "provider-default",
      inputType: options.inputType ?? null,
      configuredSpace: options.embeddingSpace ?? null,
    };
    const fingerprint = digest({
      identity,
      endpoint: normalizeResponsesBaseUrl(route.provider.baseUrl),
      family: operationProviderFamily(route.provider),
      adapter: route.adapter,
      parameters: options.parameters,
      providerRouting: options.providerRouting,
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
      representation: "dense" as const,
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
