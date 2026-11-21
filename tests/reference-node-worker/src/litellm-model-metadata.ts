import type {
  EndpointModelInventoryItem,
  ModelOperationCapabilities,
} from "@cantrip/protocol";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const positive = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;

/** Modes and endpoint lists advertise operations, not proof that other APIs are
 * unavailable. LiteLLM documents them as informational and supports fallbacks. */
export function liteLlmOperationCapabilities(
  raw: unknown,
  observedAt: string,
): ModelOperationCapabilities {
  const model = object(raw);
  const info = object(model.model_info);
  const mode = info.mode ?? model.mode;
  const declared = info.supported_endpoints ?? model.supported_endpoints;
  const endpoints = Array.isArray(declared)
    ? declared
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.toLowerCase().replace(/\/+$/, ""))
    : [];
  const language =
    mode === "chat" ||
    mode === "completion" ||
    endpoints.some((endpoint) =>
      /\/(?:chat\/completions|completions|responses|messages)$/.test(endpoint),
    );
  const embedding =
    mode === "embedding" ||
    endpoints.some((endpoint) => /\/embeddings$/.test(endpoint));
  const decision =
    mode === "evaluation" ||
    mode === "decisions" ||
    endpoints.some((endpoint) => /\/(?:decisions|systemone)$/.test(endpoint));
  if (
    !language &&
    !embedding &&
    !decision &&
    typeof mode !== "string" &&
    !Array.isArray(declared)
  )
    return {};
  const common = { source: "litellm-catalog", observedAt };
  const maxInputTokens = positive(
    info.max_input_tokens ?? model.max_input_tokens,
  );
  return {
    language: { ...common, status: language ? "supported" : "unknown" },
    embedding: {
      ...common,
      status: embedding ? "supported" : "unknown",
      ...(embedding
        ? { adapter: "openai-embeddings" as const, maxInputTokens }
        : {}),
    },
    decision: {
      ...common,
      status: decision ? "supported" : "unknown",
      ...(decision
        ? {
            adapter: "openai-decisions" as const,
            questionTypes: ["predicate", "choice", "score"],
            // These flags apply to native decision deployments, not chat vision.
            inputModalities: [
              "text",
              "json",
              ...(info.supports_audio_input === true ? ["audio"] : []),
              ...(info.supports_video_input === true ? ["video"] : []),
            ],
          }
        : {}),
    },
  };
}

/** Overlay public aliases only. Never copy deployment credentials, internal IDs,
 * upstream model names, or arbitrary model_info fields into the catalog. */
export function liteLlmModelOverlay(
  raw: unknown,
  visible: ReadonlyMap<string, EndpointModelInventoryItem>,
  observedAt: string,
): EndpointModelInventoryItem[] {
  const response = object(raw);
  if (
    !Array.isArray(response.data) ||
    response.has_more === true ||
    response.next_cursor ||
    response.next
  )
    throw new Error(
      "Native gateway metadata did not contain a complete model list.",
    );
  const groups = new Map<string, ModelOperationCapabilities[]>();
  for (const entry of response.data) {
    const deployment = object(entry);
    const alias = deployment.model_name;
    if (typeof alias !== "string" || !alias.trim())
      throw new Error(
        "Native gateway metadata contains a deployment without a public model name.",
      );
    if (!visible.has(alias)) continue;
    const group = groups.get(alias) ?? [];
    group.push(liteLlmOperationCapabilities(deployment, observedAt));
    groups.set(alias, group);
  }
  return [...groups].map(([alias, deployments]) => {
    const standard = visible.get(alias)!;
    const capabilities = { ...standard.operationCapabilities };
    for (const operation of ["language", "embedding", "decision"] as const) {
      const supported = deployments.flatMap((value) =>
        value[operation]?.status === "supported" ? [value[operation]!] : [],
      );
      if (!supported.length) {
        const observed = deployments.find((value) => value[operation]);
        // A declared image/rerank/other mode must not become a legacy language
        // profile merely because none of this platform's operations is known.
        if (!capabilities[operation] && observed)
          capabilities[operation] = observed[operation];
        continue;
      }
      const first = supported[0]!;
      const modalities = supported.every(
        (value) => value.inputModalities?.length,
      )
        ? [...new Set(supported.flatMap((value) => value.inputModalities!))]
        : null;
      capabilities[operation] = {
        ...capabilities[operation],
        ...first,
        inputModalities:
          modalities ?? capabilities[operation]?.inputModalities ?? null,
      };
      if (operation === "embedding")
        capabilities.embedding!.maxInputTokens = supported.every(
          (value) => value.maxInputTokens,
        )
          ? supported.reduce(
              (limit, value) => Math.min(limit, value.maxInputTokens!),
              Infinity,
            )
          : (standard.operationCapabilities?.embedding?.maxInputTokens ?? null);
    }
    return {
      ...standard,
      operationCapabilities: capabilities,
      inputModalities: [
        ...new Set([
          ...standard.inputModalities,
          ...Object.values(capabilities).flatMap((value) =>
            value.status === "supported" ? (value.inputModalities ?? []) : [],
          ),
        ]),
      ],
      outputModalities: [
        ...new Set([
          ...standard.outputModalities,
          ...(
            [
              ["language", "text"],
              ["embedding", "embeddings"],
              ["decision", "decisions"],
            ] as const
          ).flatMap(([operation, modality]) =>
            capabilities[operation]?.status === "supported" ? [modality] : [],
          ),
        ]),
      ],
    };
  });
}
