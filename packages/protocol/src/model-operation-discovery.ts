import type {
  ModelOperation,
  ModelOperationCapabilities,
} from "./model-operations.js";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((v): v is string => typeof v === "string")
            .map((v) => v.trim().toLowerCase())
            .filter(Boolean),
        ),
      ]
    : [];

/** Uses advertised operation metadata, never the model name or reasoning flag. */
export function endpointOperationMetadata(raw: unknown): {
  operationCapabilities: ModelOperationCapabilities;
  inputModalities: string[];
  outputModalities: string[];
} {
  const model = object(raw);
  const architecture = object(model.architecture);
  const capabilities = object(model.capabilities);
  const inputs = strings(
    architecture.input_modalities ?? model.input_modalities,
  );
  const outputs = strings(
    architecture.output_modalities ?? model.output_modalities,
  );
  const type = typeof model.type === "string" ? model.type.toLowerCase() : "";
  const declared =
    outputs.length > 0 ||
    ["llm", "vlm", "embedding", "embeddings", "decision"].includes(type);
  if (!outputs.length) {
    if (["llm", "vlm"].includes(type)) outputs.push("text");
    if (["embedding", "embeddings"].includes(type)) outputs.push("embeddings");
    if (type === "decision") outputs.push("decisions");
  }
  // These are the documented input types of native LM Studio model categories.
  if (
    !inputs.length &&
    ["llm", "vlm", "embedding", "embeddings", "decision"].includes(type)
  ) {
    inputs.push("text");
    if (
      type === "vlm" ||
      (!["embedding", "embeddings"].includes(type) &&
        (capabilities.vision === true || model.supports_vision === true))
    )
      inputs.push("image");
  }
  const operationCapabilities: ModelOperationCapabilities = {};
  if (declared) {
    for (const [operation, modality, adapter] of [
      ["language", "text", null],
      ["embedding", "embeddings", "openai-embeddings"],
      ["decision", "decisions", null],
    ] as const) {
      operationCapabilities[operation] = {
        status: outputs.includes(modality) ? "supported" : "unsupported",
        source: "compatible-api",
        inputModalities: inputs.length ? inputs : null,
        ...(adapter ? { adapter } : {}),
      };
    }
  }
  return {
    operationCapabilities,
    inputModalities: inputs,
    outputModalities: outputs,
  };
}

/** Legacy unclassified catalogs retain their existing language profile behavior. */
export function discoveredModelOperations(
  capabilities: ModelOperationCapabilities | undefined,
): ModelOperation[] {
  if (!capabilities || !Object.keys(capabilities).length) return ["language"];
  return (["language", "embedding", "decision"] as const).filter(
    (operation) => capabilities[operation]?.status === "supported",
  );
}
