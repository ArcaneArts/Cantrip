import {
  MODEL_CATALOG_MODEL_LIMIT,
  MODEL_CATALOG_BYTES_LIMIT,
  endpointModelInventoryItemSchema,
  endpointOperationMetadata,
  normalizeResponsesBaseUrl,
  registeredModelOperations,
  type EndpointModelInventory,
  type EndpointModelInventoryItem,
} from "@cantrip/protocol";
import { fetchModelCatalogJson as catalogJson } from "./model-catalog-json.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const positive = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
const boolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

/** Unknown metadata stays unknown; it never prevents attempting inference. */
export function normalizeEndpointModel(
  raw: unknown,
  providerKind?: string,
  baseUrl = "",
): EndpointModelInventoryItem | null {
  const model = object(raw);
  const id = text(model.id) ?? text(model.key);
  if (!id) return null;
  const operations = endpointOperationMetadata(model);
  const registered = registeredModelOperations(
    { kind: providerKind ?? "", baseUrl },
    id,
  );
  // Advertised operation fields take precedence over maintained documentation.
  for (const operation of ["language", "embedding", "decision"] as const) {
    const advertised = operations.operationCapabilities[operation];
    const fallback = registered[operation];
    if (!advertised && fallback)
      operations.operationCapabilities[operation] = fallback;
  }
  if (!operations.outputModalities.length) {
    for (const [operation, modality] of [
      ["language", "text"],
      ["embedding", "embeddings"],
      ["decision", "decisions"],
    ] as const) {
      if (registered[operation]?.status === "supported")
        operations.outputModalities.push(modality);
    }
  }
  if (!operations.inputModalities.length) {
    operations.inputModalities = [
      ...new Set(
        Object.values(registered)
          .filter((capability) => capability.status === "supported")
          .flatMap((capability) => capability.inputModalities ?? []),
      ),
    ];
  }
  if (operations.operationCapabilities.decision?.status === "supported") {
    const adapter =
      providerKind === "lm-studio" || providerKind === "litellm"
        ? "openai-decisions"
        : providerKind === "llama-cpp" || providerKind === "vllm"
          ? "system-one"
          : null;
    if (adapter) operations.operationCapabilities.decision.adapter = adapter;
  }
  if (
    operations.operationCapabilities.embedding?.status === "supported" &&
    text(model.digest)
  )
    operations.operationCapabilities.embedding.modelRevision = text(
      model.digest,
    );
  if (
    providerKind === "vllm" &&
    operations.operationCapabilities.embedding?.status === "supported"
  )
    operations.operationCapabilities.embedding.adapter = "vllm-embeddings";
  const capabilities = object(model.capabilities);
  const metadata = object(model.meta);
  const instances = Array.isArray(model.loaded_instances)
    ? model.loaded_instances
    : null;
  const loadedConfig = object(object(instances?.[0]).config);
  const vision =
    boolean(capabilities.vision) ??
    boolean(model.supports_vision) ??
    boolean(model.has_vision_adapter);
  const reasoning = object(capabilities.reasoning);
  const efforts = Array.isArray(reasoning.allowed_options)
    ? reasoning.allowed_options.filter(
        (effort): effort is string =>
          typeof effort === "string" && effort.length > 0,
      )
    : [];
  return {
    nativeModelId: id,
    operationCapabilities: operations.operationCapabilities,
    displayName: text(model.display_name) ?? text(model.name) ?? id,
    description: text(model.description),
    contextWindow:
      positive(loadedConfig.context_length) ??
      positive(model.max_context_length) ??
      positive(model.context_length) ??
      positive(model.max_model_len) ??
      positive(metadata.n_ctx_train),
    maxOutputTokens: positive(model.max_output_tokens),
    inputModalities: operations.inputModalities.length
      ? operations.inputModalities
      : vision
        ? ["text", "image"]
        : ["text"],
    outputModalities: operations.outputModalities,
    supportsTools:
      boolean(capabilities.trained_for_tool_use) ??
      boolean(model.supports_tool_calling),
    supportsParallelTools: boolean(model.supports_parallel_tool_calls),
    supportsStructuredOutput: boolean(model.supports_structured_output),
    supportsVision: vision,
    supportsReasoning: Object.keys(reasoning).length
      ? true
      : boolean(model.supports_reasoning),
    supportedReasoningEfforts: efforts.map((effort) => ({
      effort,
      description: null,
    })),
    defaultReasoningEffort: text(reasoning.default),
    reasoningMandatory: null,
    family: text(model.architecture) ?? text(model.family),
    parameterSize: text(model.params_string),
    quantization:
      text(object(model.quantization).name) ?? text(model.quantization),
    digest: null,
    metadataSource: "compatible-api",
    loaded: boolean(model.loaded) ?? (instances ? instances.length > 0 : null),
  };
}

export async function discoverEndpointModels(
  provider: { kind: string; baseUrl: string; apiKey: string | null },
  fetcher: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<EndpointModelInventory> {
  const base = normalizeResponsesBaseUrl(provider.baseUrl);
  const models = new Map<string, EndpointModelInventoryItem>();
  let bytes = 0;
  const save = (raw: EndpointModelInventoryItem) => {
    const model = endpointModelInventoryItemSchema.parse(raw);
    const previous = models.get(model.nativeModelId);
    const nextBytes =
      bytes +
      Buffer.byteLength(JSON.stringify(model)) +
      1 -
      (previous ? Buffer.byteLength(JSON.stringify(previous)) + 1 : 0);
    if (
      nextBytes > MODEL_CATALOG_BYTES_LIMIT ||
      (!previous && models.size >= MODEL_CATALOG_MODEL_LIMIT)
    )
      throw new Error("Model catalog exceeded its snapshot limit.");
    bytes = nextBytes;
    models.set(model.nativeModelId, model);
  };
  const first = new URL(`${base}/models`);
  let next: URL | null = first;
  const visited = new Set<string>();
  while (next) {
    if (visited.has(next.href) || visited.size >= 256)
      throw new Error(
        "Model catalog pagination repeated or exceeded its page limit.",
      );
    visited.add(next.href);
    const catalog = object(
      await catalogJson(next, provider.apiKey, fetcher, 20_000, signal),
    );
    if (!Array.isArray(catalog.data))
      throw new Error("Model catalog did not contain a model list.");
    for (const raw of catalog.data) {
      const model = normalizeEndpointModel(
        raw,
        provider.kind,
        provider.baseUrl,
      );
      if (model) save(model);
    }
    const continuation = text(object(catalog.links).next) ?? text(catalog.next);
    if (!continuation) {
      if (catalog.has_more === true || catalog.next_cursor)
        throw new Error(
          "Model catalog is incomplete without a continuation URL.",
        );
      next = null;
    } else {
      const url: URL = new URL(continuation, next);
      // Follow the provider's URL, including its base path, without moving the
      // configured credential to another origin or guessing cursor parameters.
      if (url.origin !== first.origin || url.username || url.password)
        throw new Error("Model catalog continuation changed its endpoint.");
      url.hash = "";
      next = url;
    }
  }
  if (provider.kind === "lm-studio") {
    // Native metadata is optional. Older LM Studio servers still support /v1/models.
    const nativeBase = base.endsWith("/api/v1")
      ? base
      : `${base.replace(/\/v1$/, "")}/api/v1`;
    try {
      const rich = object(
        await catalogJson(
          `${nativeBase}/models`,
          provider.apiKey,
          fetcher,
          2_000,
          signal,
        ),
      );
      if (Array.isArray(rich.models))
        for (const raw of rich.models) {
          const model = normalizeEndpointModel(
            raw,
            provider.kind,
            provider.baseUrl,
          );
          if (!model) continue;
          const standard = models.get(model.nativeModelId);
          if (!standard) {
            save(model);
            continue;
          }
          // Native discovery can be partial. Missing fields must not erase
          // capabilities or context supplied by the standard catalog.
          save({
            ...standard,
            ...Object.fromEntries(
              Object.entries(model).filter(
                ([, value]) =>
                  value !== null && (!Array.isArray(value) || value.length > 0),
              ),
            ),
            displayName:
              model.displayName === model.nativeModelId
                ? standard.displayName
                : model.displayName,
            operationCapabilities: {
              ...standard.operationCapabilities,
              ...model.operationCapabilities,
            },
            inputModalities:
              model.supportsVision === null
                ? [
                    ...new Set([
                      ...standard.inputModalities,
                      ...model.inputModalities,
                    ]),
                  ]
                : model.inputModalities,
          });
        }
    } catch {
      signal?.throwIfAborted();
      // Rich metadata availability cannot invalidate a working standard catalog.
    }
  }
  // The dispatcher validates the full worker-local snapshot and pages it.
  return {
    models: [...models.values()],
    observedAt: new Date().toISOString(),
  };
}
