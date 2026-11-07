import {
  endpointModelInventorySchema,
  endpointOperationMetadata,
  normalizeResponsesBaseUrl,
  registeredModelOperations,
  type EndpointModelInventory,
  type EndpointModelInventoryItem,
} from "@cantrip/protocol";

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

async function catalogJson(
  url: string,
  apiKey: string | null,
  fetcher: typeof fetch,
  timeout: number,
) {
  const response = await fetcher(url, {
    headers: {
      accept: "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    signal: AbortSignal.timeout(timeout),
    // A redirect must not move a private endpoint credential to another server.
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`Model catalog request returned HTTP ${response.status}.`);
  // Bound catalog memory and control-channel payloads independently of server headers.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Model catalog response was empty.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4 * 1024 * 1024)
        throw new Error("Model catalog response exceeded 4 MiB.");
      chunks.push(value);
    }
    try {
      return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      throw new Error("Model catalog response was not valid JSON.");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function discoverEndpointModels(
  provider: { kind: string; baseUrl: string; apiKey: string | null },
  fetcher: typeof fetch = globalThis.fetch,
): Promise<EndpointModelInventory> {
  const base = normalizeResponsesBaseUrl(provider.baseUrl);
  const catalog = await catalogJson(
    `${base}/models`,
    provider.apiKey,
    fetcher,
    20_000,
  );
  if (!Array.isArray(catalog.data))
    throw new Error("Model catalog did not contain a model list.");
  const models = new Map<string, EndpointModelInventoryItem>();
  for (const raw of catalog.data) {
    const model = normalizeEndpointModel(raw, provider.kind, provider.baseUrl);
    if (model) models.set(model.nativeModelId, model);
  }
  if (provider.kind === "lm-studio") {
    // Native metadata is optional. Older LM Studio servers still support /v1/models.
    const nativeBase = base.endsWith("/api/v1")
      ? base
      : `${base.replace(/\/v1$/, "")}/api/v1`;
    try {
      const rich = await catalogJson(
        `${nativeBase}/models`,
        provider.apiKey,
        fetcher,
        2_000,
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
            models.set(model.nativeModelId, model);
            continue;
          }
          // Native discovery can be partial. Missing fields must not erase
          // capabilities or context supplied by the standard catalog.
          models.set(model.nativeModelId, {
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
      // Rich metadata availability cannot invalidate a working standard catalog.
    }
  }
  return endpointModelInventorySchema.parse({
    // An oversized inventory fails explicitly and preserves the saved catalog;
    // silently publishing its first page would mark missing models unavailable.
    models: [...models.values()],
    observedAt: new Date().toISOString(),
  });
}
