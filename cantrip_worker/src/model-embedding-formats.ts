import {
  normalizeResponsesBaseUrl,
  operationProviderFamily,
  type EmbeddingInput,
  type EmbeddingItem,
  type ModelOperationOptions,
  type ModelOperationRoute,
} from "@cantrip/protocol";
import type { RuntimeProvider } from "./protected-secrets.js";
import { ModelOperationError } from "./model-operation-error.js";

type Route = Omit<ModelOperationRoute, "provider"> & {
  provider: RuntimeProvider;
};
type Items = EmbeddingInput["items"];
type WithoutIdentity<T> = T extends unknown ? Omit<T, "id" | "index"> : never;
export type EmbeddingVector = WithoutIdentity<EmbeddingItem>;
export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function invalid(
  message = "The provider returned malformed embedding data.",
): never {
  throw new ModelOperationError("invalid-response", message);
}
function unsupported(message: string): never {
  throw new ModelOperationError("unsupported-input", message);
}
export function embeddingAdapter(route: Route) {
  return (
    route.adapter ??
    (route.provider.kind === "ollama"
      ? "ollama-embed"
      : route.provider.kind === "vllm"
        ? "vllm-embeddings"
        : "openai-embeddings")
  );
}
export function embeddingUsesChat(
  route: Route,
  options: ModelOperationOptions,
  items: Items,
) {
  return (
    ["vllm-embeddings", "vllm-pooling"].includes(embeddingAdapter(route)) &&
    (Boolean(options.messageRole || options.inputType || options.mediaFormat) ||
      items.some((item) => item.content.some((part) => part.type !== "text")))
  );
}
/** A native chat embedding represents one conversation; unrelated items must not
 * become messages in a single conversation and receive one combined vector. */
export function embeddingBatchLimit(
  route: Route,
  options: ModelOperationOptions,
  items: Items,
) {
  return embeddingUsesChat(route, options, items) ? 1 : 32;
}
function inlineImage(url: string) {
  const match = /^data:image\/[^;,]+;base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url);
  if (!match)
    return unsupported(
      "This embedding format requires an inline base64 image. The worker does not download or convert media.",
    );
  return match[1]!;
}
function parts(items: Items, native: "llama" | "vllm" | "images") {
  return items.map((item) => ({
    content: item.content.map((part) => {
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type === "image")
        return { type: "image_url", image_url: { url: part.url } };
      if (native === "images")
        return unsupported(
          "The selected embedding envelope accepts text and images. Select a native audio/video adapter for these inputs.",
        );
      if (native === "llama")
        return part.type === "audio"
          ? { type: "input_audio", input_audio: { url: part.url } }
          : { type: "input_video", input_video: { url: part.url } };
      return part.type === "audio"
        ? { type: "audio_url", audio_url: { url: part.url } }
        : { type: "video_url", video_url: { url: part.url } };
    }),
  }));
}
function url(route: Route, adapter: string) {
  const base = normalizeResponsesBaseUrl(route.provider.baseUrl);
  if (adapter === "ollama-embed") {
    if (base.endsWith("/api/embed")) return base;
    const root = base.replace(/\/v1$/, "");
    return root.endsWith("/api") ? `${root}/embed` : `${root}/api/embed`;
  }
  if (adapter === "llama-embeddings")
    return base.endsWith("/embeddings")
      ? base
      : `${base.replace(/\/v1$/, "")}/embeddings`;
  if (adapter === "vllm-pooling" || adapter === "vllm-bge-m3")
    return base.endsWith("/pooling")
      ? base
      : `${base.replace(/\/v1$/, "")}/pooling`;
  if (adapter === "cohere-embed")
    return base.endsWith("/embed")
      ? base
      : `${base.replace(/\/v[12]$/, "")}/v2/embed`;
  return base.endsWith("/embeddings") ? base : `${base}/embeddings`;
}
export function embeddingPayload(
  route: Route,
  options: ModelOperationOptions,
  items: Items,
) {
  const adapter = embeddingAdapter(route);
  if (options.typesafeImages)
    throw new ModelOperationError(
      "invalid-request",
      "TypeSafe decision image options cannot be used for embeddings.",
    );
  if (
    ![
      "ollama-embed",
      "openai-embeddings",
      "llama-embeddings",
      "vllm-embeddings",
      "vllm-pooling",
      "vllm-bge-m3",
      "cohere-embed",
    ].includes(adapter) ||
    ["chatgpt", "grok"].includes(route.provider.kind)
  )
    throw new ModelOperationError(
      "configuration-required",
      "This connection does not expose the configured embedding API.",
    );
  const reserved = new Set([
    "model",
    "input",
    "inputs",
    "texts",
    "images",
    "messages",
    "questions",
    "state",
    "data",
    "task",
    "embed_task",
    "provider",
    "dimensions",
    "output_dimension",
    "input_type",
    "encoding_format",
    "embedding_types",
    "stream",
    "api_key",
    "apikey",
    "api-key",
    "access_token",
    "base_url",
    "api_base",
    "baseurl",
    "headers",
    "extra_headers",
    "authorization",
  ]);
  const parameters = options.parameters ?? {};
  if (
    options.encodingFormat === "base64" &&
    ((parameters.embed_dtype !== undefined &&
      parameters.embed_dtype !== "float32") ||
      (parameters.endianness !== undefined &&
        parameters.endianness !== "little"))
  )
    return unsupported(
      "Base64 embedding decoding requires little-endian float32. Select float encoding for another native numeric format.",
    );
  if (Object.keys(parameters).some((key) => reserved.has(key.toLowerCase())))
    throw new ModelOperationError(
      "invalid-request",
      "Additional parameters cannot replace embedding inputs, routing, credentials or typed options.",
    );
  if (
    parameters.truncate !== undefined &&
    parameters.truncate !== false &&
    parameters.truncate !== "NONE"
  )
    throw new ModelOperationError(
      "invalid-request",
      "Embedding content is not implicitly truncated. Configure preprocessing separately.",
    );
  if (options.poolingTask && adapter !== "vllm-pooling")
    throw new ModelOperationError(
      "invalid-request",
      "The pooling task option requires the vLLM embedding pooling adapter.",
    );
  if (
    options.messageRole &&
    !["vllm-embeddings", "vllm-pooling"].includes(adapter)
  )
    throw new ModelOperationError(
      "invalid-request",
      "The embedding message role requires a chat-style vLLM adapter.",
    );
  const textOnly = items.every((item) =>
    item.content.every((part) => part.type === "text"),
  );
  const texts = items.map((item) =>
    item.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(""),
  );
  const standard = {
    ...parameters,
    model: route.modelName,
    ...(options.dimensions ? { dimensions: options.dimensions } : {}),
  };
  let body: Record<string, unknown>;
  if (adapter === "ollama-embed") {
    if (!textOnly)
      return unsupported("Ollama's embed API accepts text inputs.");
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
    body = { ...standard, input: texts, truncate: false };
  } else if (adapter === "vllm-bge-m3") {
    if (!textOnly)
      return unsupported(
        "The configured BGE-M3 sparse plugin accepts text inputs.",
      );
    if (
      options.providerRouting ||
      options.inputType ||
      options.encodingFormat === "base64" ||
      options.mediaFormat
    )
      throw new ModelOperationError(
        "invalid-request",
        "The BGE-M3 plugin requires native text/float options.",
      );
    const representation = options.vectorRepresentation ?? "hybrid";
    if (representation === "multi-vector")
      return unsupported(
        "Use vLLM token_embed pooling for ColBERT multi-vector output.",
      );
    body = {
      model: route.modelName,
      task: "plugin",
      data: {
        ...parameters,
        input: texts,
        embed_task:
          representation === "hybrid" ? "dense&sparse" : representation,
        return_tokens: parameters.return_tokens ?? true,
        ...(options.dimensions ? { dimensions: options.dimensions } : {}),
      },
    };
  } else if (adapter === "cohere-embed") {
    if (
      options.providerRouting ||
      (options.mediaFormat && options.mediaFormat !== "content-parts")
    )
      throw new ModelOperationError(
        "invalid-request",
        "The Cohere-compatible adapter uses mixed input content parts.",
      );
    body = {
      ...parameters,
      model: route.modelName,
      ...(textOnly ? { texts } : { inputs: parts(items, "images") }),
      embedding_types: [options.encodingFormat ?? "float"],
      truncate: "NONE",
      ...(options.dimensions ? { output_dimension: options.dimensions } : {}),
      ...(options.inputType ? { input_type: options.inputType } : {}),
    };
  } else if (adapter === "vllm-embeddings" || adapter === "vllm-pooling") {
    if (
      options.providerRouting ||
      (options.mediaFormat &&
        !["content-parts", "media-urls"].includes(options.mediaFormat))
    )
      throw new ModelOperationError(
        "invalid-request",
        "The native vLLM embedding adapter uses chat media parts without gateway routing.",
      );
    if (adapter === "vllm-pooling" && options.encodingFormat === "base64")
      return unsupported(
        "Use float encoding for nested pooling tensors; a shape-less base64 tensor is ambiguous.",
      );
    if (
      adapter === "vllm-embeddings" &&
      options.encodingFormat === "base64" &&
      options.vectorRepresentation !== "dense"
    )
      return unsupported(
        "Select dense representation for native vLLM base64, or use float encoding to preserve an automatically detected tensor shape.",
      );
    const chat = embeddingUsesChat(route, options, items);
    if (chat && items.length !== 1)
      throw new ModelOperationError(
        "invalid-request",
        "A chat-style embedding request must contain exactly one item.",
      );
    body = {
      ...standard,
      ...(chat
        ? {
            messages: [
              {
                role: options.messageRole ?? options.inputType ?? "user",
                content: parts(items, "vllm")[0]!.content,
              },
            ],
          }
        : { input: texts }),
      encoding_format: options.encodingFormat ?? "float",
      ...(adapter === "vllm-pooling"
        ? {
            task:
              options.poolingTask ??
              (options.vectorRepresentation === "dense"
                ? "embed"
                : "token_embed"),
          }
        : {}),
    };
  } else {
    const unsloth = operationProviderFamily(route.provider) === "unsloth";
    if (unsloth && !textOnly)
      return unsupported("Unsloth's embedding API accepts text inputs.");
    const nativeLlama =
      adapter === "llama-embeddings" ||
      operationProviderFamily(route.provider) === "llama-cpp";
    if (adapter === "llama-embeddings" && options.encodingFormat === "base64")
      return unsupported(
        "Use float encoding for llama.cpp native nested embeddings.",
      );
    let input: unknown;
    if (options.mediaFormat === "base64-images") {
      input = items.map((item) => {
        if (item.content.length !== 1 || item.content[0]!.type !== "image")
          return unsupported(
            "The base64 image format requires one image per item; mixed parts are not discarded.",
          );
        return inlineImage(item.content[0]!.url);
      });
    } else {
      if (options.mediaFormat && options.mediaFormat !== "content-parts")
        return unsupported(
          "Select a supported content-parts or base64-images embedding format.",
        );
      input = textOnly ? texts : parts(items, nativeLlama ? "llama" : "images");
    }
    const openRouter = operationProviderFamily(route.provider) === "openrouter";
    if (openRouter && options.providerRouting?.allow_fallbacks === true)
      throw new ModelOperationError(
        "invalid-request",
        "Gateway fallback requires established embedding-space compatibility.",
      );
    const provider = openRouter
      ? { ...options.providerRouting, allow_fallbacks: false }
      : options.providerRouting;
    body = {
      ...standard,
      input,
      // Studio otherwise truncates over-limit text by default, including its
      // configured embedding model path. Preserve the caller's full input.
      ...(unsloth ? { truncate: false } : {}),
      encoding_format: options.encodingFormat ?? "float",
      ...(options.inputType ? { input_type: options.inputType } : {}),
      ...(provider ? { provider } : {}),
    };
  }
  return { url: url(route, adapter), body, adapter };
}
function dense(raw: unknown) {
  let values: unknown = raw;
  let sourceEncoding: "float" | "base64" = "float";
  if (typeof raw === "string") {
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        raw,
      )
    )
      invalid();
    const bytes = Buffer.from(raw, "base64");
    try {
      if (!bytes.length || bytes.length % 4 || bytes.length > 65536 * 4)
        invalid();
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
    !values.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    )
  )
    invalid();
  return { values: values as number[], sourceEncoding };
}
function normalize(values: number[], mode?: string): number[] {
  if (!mode || mode === "none") return values;
  if (mode !== "l2")
    throw new ModelOperationError(
      "invalid-request",
      "Normalization must be none or l2, or left at the provider default.",
    );
  let scale = 0;
  for (const value of values) scale = Math.max(scale, Math.abs(value));
  if (!scale) return invalid("A zero embedding vector cannot be normalized.");
  const norm = Math.sqrt(
    values.reduce((sum, value) => sum + (value / scale) ** 2, 0),
  );
  return values.map((value) => value / scale / norm);
}
function sparse(raw: unknown, mode?: string) {
  if (!Array.isArray(raw) || raw.length > 65536) invalid();
  const indices: number[] = [],
    values: number[] = [],
    tokens: (string | null)[] = [];
  const seen = new Set<number>();
  for (const entry of raw) {
    const value = object(entry);
    if (
      typeof value.token_id !== "number" ||
      !Number.isSafeInteger(value.token_id) ||
      value.token_id < 0 ||
      seen.has(value.token_id) ||
      typeof value.weight !== "number" ||
      !Number.isFinite(value.weight) ||
      (value.token !== null &&
        value.token !== undefined &&
        typeof value.token !== "string")
    )
      invalid();
    seen.add(value.token_id);
    indices.push(value.token_id);
    values.push(value.weight);
    tokens.push(typeof value.token === "string" ? value.token : null);
  }
  return { indices, values: normalize(values, mode), tokens };
}
function tensor(raw: unknown, options: ModelOperationOptions): EmbeddingVector {
  if (
    typeof raw === "string" &&
    options.vectorRepresentation === "multi-vector"
  )
    return invalid(
      "A base64 tensor without a verified shape cannot be treated as a dense vector. Select float encoding.",
    );
  if (Array.isArray(raw) && Array.isArray(raw[0])) {
    if (!raw.length || raw.length > 65536) invalid();
    if (!raw.every(Array.isArray)) invalid();
    const values = raw.map((value) =>
      normalize(dense(value).values, options.normalization),
    );
    if (values.some((value) => value.length !== values[0]!.length)) invalid();
    return { representation: "multi-vector", values, sourceEncoding: "float" };
  }
  const value = dense(raw);
  return {
    representation: "dense",
    ...value,
    values: normalize(value.values, options.normalization),
  };
}
function indexed(raw: unknown, count: number): Record<string, unknown>[] {
  if (!Array.isArray(raw) || raw.length !== count) invalid();
  const entries = new Map<number, Record<string, unknown>>();
  for (const entry of raw) {
    const value = object(entry);
    if (
      typeof value.index !== "number" ||
      !Number.isInteger(value.index) ||
      value.index < 0 ||
      value.index >= count ||
      entries.has(value.index)
    )
      invalid();
    entries.set(value.index, value);
  }
  return Array.from({ length: count }, (_, index) => entries.get(index)!);
}
export function embeddingDimensions(value: EmbeddingVector): number | null {
  if (value.representation === "sparse") return null;
  return value.representation === "multi-vector"
    ? value.values[0]!.length
    : value.values.length;
}
export function embeddingResponseRoot(raw: unknown, adapter: string) {
  const root = object(raw);
  // vLLM IO processors may return their typed result directly or as the
  // documented generic IOProcessorResponse.data payload.
  return adapter === "vllm-bge-m3" && Array.isArray(object(root.data).data)
    ? object(root.data)
    : root;
}
export function parseEmbeddingBatch(
  raw: unknown,
  adapter: string,
  options: ModelOperationOptions,
  count: number,
): EmbeddingVector[] {
  const root = embeddingResponseRoot(raw, adapter);
  let result: EmbeddingVector[];
  if (adapter === "ollama-embed" || adapter === "cohere-embed") {
    const list =
      adapter === "ollama-embed"
        ? root.embeddings
        : object(root.embeddings)[options.encodingFormat ?? "float"];
    if (!Array.isArray(list) || list.length !== count) invalid();
    result = list.map((value) => tensor(value, options));
  } else {
    const entries = indexed(
      adapter === "llama-embeddings" ? raw : root.data,
      count,
    );
    result = entries.map((entry) => {
      let vector: EmbeddingVector;
      if (adapter === "vllm-bge-m3") {
        const hasDense =
          entry.dense_embedding !== null && entry.dense_embedding !== undefined;
        const hasSparse =
          entry.sparse_embedding !== null &&
          entry.sparse_embedding !== undefined;
        if (!hasDense && !hasSparse) invalid();
        const sparseValue = hasSparse
          ? sparse(entry.sparse_embedding, options.normalization)
          : null;
        if (!hasDense)
          vector = {
            representation: "sparse",
            ...sparseValue!,
            sourceEncoding: "float",
          };
        else {
          const values = normalize(
            dense(entry.dense_embedding).values,
            options.normalization,
          );
          vector = sparseValue
            ? {
                representation: "hybrid",
                values,
                sparse: sparseValue,
                sourceEncoding: "float",
              }
            : { representation: "dense", values, sourceEncoding: "float" };
        }
      } else {
        const rawVector =
          adapter === "vllm-pooling" ? entry.data : entry.embedding;
        if (typeof rawVector === "string" && entry.late_chunking !== undefined)
          return invalid(
            "Select float encoding to preserve chunk-vector boundaries.",
          );
        vector = tensor(rawVector, options);
      }
      if (entry.late_chunking !== undefined)
        vector.metadata = {
          lateChunking: entry.late_chunking,
        } as EmbeddingVector["metadata"];
      return vector;
    });
  }
  if (
    options.vectorRepresentation &&
    result.some(
      (value) => value.representation !== options.vectorRepresentation,
    )
  )
    invalid(
      "The provider returned a different vector representation than requested.",
    );
  const dimension = embeddingDimensions(result[0]!);
  if (
    result.some(
      (value) =>
        value.representation !== result[0]!.representation ||
        embeddingDimensions(value) !== dimension,
    ) ||
    (dimension !== null &&
      options.dimensions !== undefined &&
      dimension !== options.dimensions)
  )
    invalid();
  return result;
}
