import {
  isZaiCodingPlanBaseUrl,
  type ProviderModelCatalogResult,
} from "@cantrip/protocol";

import type {
  ModelProviderCatalogRuntime,
  ProviderModelCatalogWrite,
  ServerRepository,
} from "../db/repository.js";

export const ZAI_CODEX_CATALOG_VERSION = 1;
export const ZAI_CODEX_CATALOG_SCOPE = "zai:built-in";
export const ZAI_CODEX_CATALOG_SOURCE = "https://docs.z.ai/devpack/tool/codex";

export function isZaiCodingPlanProvider(
  provider: Pick<ModelProviderCatalogRuntime, "baseUrl" | "kind">,
): boolean {
  return (
    provider.kind === "openai-compatible" &&
    isZaiCodingPlanBaseUrl(provider.baseUrl)
  );
}

const catalogMetadata = (model: Record<string, unknown>) => ({
  ...model,
  catalogVersion: ZAI_CODEX_CATALOG_VERSION,
  source: ZAI_CODEX_CATALOG_SOURCE,
});

export const ZAI_CODEX_MODELS: readonly ProviderModelCatalogWrite[] = [
  {
    nativeModelId: "glm-5.3",
    canonicalModelId: "glm-5.3",
    displayName: "glm-5.3",
    description: "Z.ai's latest flagship model.",
    contextWindow: 1_048_576,
    maxOutputTokens: null,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsTools: true,
    supportsParallelTools: true,
    supportsStructuredOutput: null,
    supportsVision: false,
    supportsReasoning: true,
    supportedReasoningEfforts: [
      { effort: "low", description: "Low reasoning effort" },
      { effort: "high", description: "High reasoning effort" },
      { effort: "max", description: "Maximum reasoning effort" },
    ],
    defaultReasoningEffort: "max",
    reasoningMandatory: null,
    family: "glm-5",
    parameterSize: null,
    quantization: null,
    digest: null,
    metadataSource: "zai",
    matchConfidenceBasisPoints: 10_000,
    hidden: false,
    isDefault: true,
    rawMetadata: catalogMetadata({
      applyPatchToolType: "freeform",
      contextWindowPercent: 95,
      defaultReasoningLevel: "max",
      shellToolType: "shell_command",
      supportedReasoningLevels: ["low", "high", "max"],
    }),
  },
  {
    nativeModelId: "glm-5-turbo",
    canonicalModelId: "glm-5-turbo",
    displayName: "glm-5-turbo",
    description: "Agent-optimized model.",
    contextWindow: 204_800,
    maxOutputTokens: null,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsTools: true,
    supportsParallelTools: true,
    supportsStructuredOutput: null,
    supportsVision: false,
    supportsReasoning: true,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "max",
    reasoningMandatory: null,
    family: "glm-5",
    parameterSize: null,
    quantization: null,
    digest: null,
    metadataSource: "zai",
    matchConfidenceBasisPoints: 10_000,
    hidden: false,
    isDefault: false,
    rawMetadata: catalogMetadata({
      applyPatchToolType: "freeform",
      contextWindowPercent: 95,
      defaultReasoningLevel: "max",
      shellToolType: "shell_command",
      supportedReasoningLevels: [],
    }),
  },
];

export class ZaiCatalogService {
  readonly #repository: ServerRepository;

  constructor(repository: ServerRepository) {
    this.#repository = repository;
  }

  /**
   * Hydrate built-in catalogs for providers created before Z.ai discovery was
   * introduced. Reconciliation is deliberately provider-local: repository
   * catalog writes preserve provider/model/route identities and user-owned
   * ordering while adding only missing discovery-managed records.
   */
  async reconcileOwnerProviders(ownerId: string): Promise<string[]> {
    const settings = await this.#repository.getSettings(ownerId);
    const providerIds = settings.providers
      .filter(isZaiCodingPlanProvider)
      .map(({ id }) => id);
    for (const providerId of providerIds) {
      const existing = await this.#repository.getProviderModelCatalog(
        ownerId,
        providerId,
      );
      const current = existing?.syncStates.some(
        (state) =>
          state.scopeKey === ZAI_CODEX_CATALOG_SCOPE &&
          state.status === "current" &&
          state.etag === `built-in-v${ZAI_CODEX_CATALOG_VERSION}`,
      );
      const nativeModelIds = new Set(
        existing?.models.map(({ nativeModelId }) => nativeModelId),
      );
      if (
        current &&
        ZAI_CODEX_MODELS.every(({ nativeModelId }) =>
          nativeModelIds.has(nativeModelId),
        )
      ) {
        continue;
      }
      await this.getProviderCatalog(ownerId, providerId);
    }
    return providerIds;
  }

  async getProviderCatalog(
    ownerId: string,
    providerId: string,
  ): Promise<ProviderModelCatalogResult | null> {
    const provider = await this.#repository.getModelProviderCatalogRuntime(
      ownerId,
      providerId,
    );
    if (!provider) return null;
    if (!isZaiCodingPlanProvider(provider)) {
      throw new Error("Provider is not a Z.ai Coding Plan provider.");
    }

    const availableNativeModelIds = new Set(
      ZAI_CODEX_MODELS.map(({ nativeModelId }) => nativeModelId),
    );
    await this.#repository.setProviderCatalogSyncState(providerId, {
      scopeKey: ZAI_CODEX_CATALOG_SCOPE,
      status: "refreshing",
      error: null,
      refreshStartedAt: new Date(),
    });
    await this.#repository.reconcileProviderModelCatalog(ownerId, providerId, {
      models: [...ZAI_CODEX_MODELS],
      availabilityScope: ZAI_CODEX_CATALOG_SCOPE,
      availableNativeModelIds,
      autoCreateLogicalModels: true,
      autoCreateNativeModelIds: availableNativeModelIds,
      defaultNativeModelId: "glm-5.3",
    });
    await this.#repository.setProviderCatalogSyncState(providerId, {
      scopeKey: ZAI_CODEX_CATALOG_SCOPE,
      status: "current",
      error: null,
      etag: `built-in-v${ZAI_CODEX_CATALOG_VERSION}`,
      lastSuccessAt: new Date(),
    });
    return this.#repository.getProviderModelCatalog(ownerId, providerId);
  }
}
