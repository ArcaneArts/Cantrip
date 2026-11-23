import {
  isWorkerEndpointProviderKind,
  type endpointProviderKinds,
} from "./provider-definitions.js";
import type {
  ModelOperation,
  ModelOperationCapabilities,
} from "./model-operations.js";

type Provider = { kind: string; baseUrl: string };
type WorkerCatalogProvider = Provider & {
  kind: "ollama" | (typeof endpointProviderKinds)[number] | "openai-compatible";
};

/** Documentation fills metadata gaps; it never grants model access or gates a request. */
export const providerOperationRegistryVersion = 1;
export const providerOperationDocumentation = {
  openai: [
    "https://developers.openai.com/api/docs/guides/embeddings",
    "https://developers.openai.com/api/docs/guides/decisions",
  ],
  ollama: [
    "https://docs.ollama.com/api/embed",
    "https://docs.ollama.com/capabilities/decision",
  ],
  openrouter: [
    "https://openrouter.ai/docs/api_reference/embeddings",
    "https://openrouter.ai/docs/guides/community/multimodal-decisions",
  ],
  "lm-studio": [
    "https://lmstudio.ai/docs/developer/openai-compat",
    "https://lmstudio.ai/docs/developer/rest/list",
  ],
  "llama-cpp": [
    "https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md",
  ],
  vllm: [
    "https://docs.vllm.ai/en/latest/models/pooling_models/",
    "https://docs.vllm.ai/en/latest/models/structured_decisions_models/",
  ],
  litellm: [
    "https://docs.litellm.ai/docs/embedding/supported_embedding",
    "https://docs.litellm.ai/docs/decisions/",
  ],
  "mlx-lm": ["https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/server.py"],
  unsloth: ["https://unsloth.ai/docs/basics/api"],
  xai: ["https://docs.x.ai/developers/models"],
  zai: ["https://docs.z.ai/llms.txt"],
} as const;

export function operationProviderFamily(provider: Provider): string {
  if (provider.kind !== "openai-compatible") return provider.kind;
  try {
    const url = new URL(provider.baseUrl);
    const host = url.hostname.toLowerCase();
    if (host === "api.openai.com") return "openai";
    if (host === "openrouter.ai" || host.endsWith(".openrouter.ai"))
      return "openrouter";
    if (host === "api.x.ai") return "xai";
    if (
      url.protocol === "https:" &&
      host === "api.z.ai" &&
      url.pathname.replace(/\/+$/, "") === "/api/v1"
    )
      return "zai";
  } catch {
    /* Invalid persisted URLs are handled by the real operation. */
  }
  return "compatible";
}

export function usesWorkerModelCatalog<T extends Provider>(
  provider: T,
): provider is T & WorkerCatalogProvider {
  if (provider.kind !== "openai-compatible")
    return isWorkerEndpointProviderKind(provider.kind);
  const family = operationProviderFamily(provider);
  return family !== "openrouter" && family !== "zai";
}

/** Backend-level API support is separate from any particular model or account. */
export function providerOperationSupport(
  provider: Provider,
): Record<ModelOperation, "supported" | "unsupported" | "unknown"> {
  const family = operationProviderFamily(provider);
  if (family === "chatgpt" || family === "grok")
    return {
      language: "supported",
      embedding: "unsupported",
      decision: "unsupported",
    };
  if (
    [
      "openai",
      "ollama",
      "openrouter",
      "lm-studio",
      "llama-cpp",
      "vllm",
      "litellm",
      "unsloth",
    ].includes(family)
  )
    return {
      language: "supported",
      embedding: "supported",
      decision: "supported",
    };
  if (["mlx-lm", "xai", "zai"].includes(family))
    return {
      language: "supported",
      embedding: "unknown",
      decision: "unknown",
    };
  // A compatible chat API is not evidence of other APIs.
  return { language: "unknown", embedding: "unknown", decision: "unknown" };
}

const source = "registry:v1:openai";
const embeddingModels: Record<
  string,
  { dimensions: number; configurable: boolean }
> = {
  "text-embedding-3-small": { dimensions: 1536, configurable: true },
  "text-embedding-3-large": { dimensions: 3072, configurable: true },
  "text-embedding-ada-002": { dimensions: 1536, configurable: false },
};

export function registeredModelOperations(
  provider: Provider,
  modelId: string,
): ModelOperationCapabilities {
  if (operationProviderFamily(provider) !== "openai") return {};
  const embedding = Object.hasOwn(embeddingModels, modelId)
    ? embeddingModels[modelId]
    : undefined;
  if (embedding)
    return {
      language: { status: "unsupported", source },
      embedding: {
        status: "supported",
        source,
        adapter: "openai-embeddings",
        inputModalities: ["text"],
        dimensions: embedding.dimensions,
        configurableDimensions: embedding.configurable,
        vectorRepresentation: "dense",
        maxInputTokens: 8192,
      },
      decision: { status: "unsupported", source },
    };
  if (modelId === "gpt-6-luna")
    return {
      language: {
        status: "supported",
        source,
        inputModalities: ["text", "image"],
      },
      embedding: { status: "unsupported", source },
      decision: {
        status: "supported",
        source,
        adapter: "openai-decisions",
        inputModalities: ["text", "image", "json"],
        questionTypes: ["predicate", "choice", "score"],
        maxQuestions: 400,
      },
    };
  // /models gives IDs, not an operation contract. New IDs remain configurable.
  return {
    language: { status: "unknown", source },
    embedding: { status: "unknown", source },
    decision: { status: "unknown", source },
  };
}
