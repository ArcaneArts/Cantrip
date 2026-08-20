import {
  ollamaModelInventorySchema,
  type OllamaModelInventoryItem,
  type ProviderModelCatalogResult,
} from "@cantrip/protocol";

import type {
  ModelProviderCatalogRuntime,
  ProviderModelCatalogWrite,
  ServerRepository,
} from "../db/repository.js";
import type { WorkerCommandBus } from "../workers/bridge.js";

const FRESHNESS_WINDOW_MS = 5 * 60_000;
const DISCOVERY_TIMEOUT_MS = 2 * 60_000;

export function ollamaWorkerScope(workerId: string): string {
  return `worker:${workerId}`;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

function contextWindow(model: OllamaModelInventoryItem): number | null {
  const architecture =
    typeof model.modelInfo["general.architecture"] === "string"
      ? model.modelInfo["general.architecture"]
      : null;
  if (architecture) {
    const exact = positiveInteger(
      model.modelInfo[`${architecture}.context_length`],
    );
    if (exact) return exact;
  }
  for (const [key, value] of Object.entries(model.modelInfo)) {
    if (/^[^.]+\.context_length$/u.test(key)) {
      const parsed = positiveInteger(value);
      if (parsed) return parsed;
    }
  }
  return null;
}

export function normalizeOllamaModel(
  model: OllamaModelInventoryItem,
): ProviderModelCatalogWrite {
  const capabilities = new Set(
    model.capabilities.map((capability) => capability.toLowerCase()),
  );
  const completion = capabilities.has("completion");
  const vision = capabilities.has("vision");
  return {
    nativeModelId: model.name,
    canonicalModelId: null,
    displayName: model.name,
    description: null,
    contextWindow: contextWindow(model),
    maxOutputTokens: null,
    inputModalities: vision ? ["text", "image"] : ["text"],
    outputModalities: ["text"],
    supportsTools: capabilities.has("tools"),
    supportsParallelTools: capabilities.has("tools") ? null : false,
    supportsStructuredOutput: completion ? true : null,
    supportsVision: vision,
    supportsReasoning: capabilities.has("thinking"),
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    reasoningMandatory: null,
    family: model.family,
    parameterSize: model.parameterSize,
    quantization: model.quantization,
    digest: model.digest,
    metadataSource: "ollama",
    matchConfidenceBasisPoints: null,
    rawMetadata: {
      capabilities: model.capabilities,
      families: model.families,
      modelInfo: model.modelInfo,
      modifiedAt: model.modifiedAt,
      sizeBytes: model.sizeBytes,
    },
  };
}

function isOllamaProvider(provider: ModelProviderCatalogRuntime): boolean {
  return provider.kind === "ollama";
}

export class OllamaCatalogService {
  readonly #bridge: WorkerCommandBus;
  readonly #repository: ServerRepository;

  constructor(repository: ServerRepository, bridge: WorkerCommandBus) {
    this.#repository = repository;
    this.#bridge = bridge;
  }

  async getProviderCatalog(
    ownerId: string,
    providerId: string,
    workerId: string,
    force = false,
  ): Promise<ProviderModelCatalogResult | null> {
    const [provider, worker] = await Promise.all([
      this.#repository.getModelProviderCatalogRuntime(ownerId, providerId),
      this.#repository.getWorker(ownerId, workerId),
    ]);
    if (!provider) return null;
    if (!worker) throw new Error("Worker not found.");
    if (!isOllamaProvider(provider)) {
      throw new Error("Provider is not an Ollama provider.");
    }
    const scopeKey = ollamaWorkerScope(workerId);
    const existing = await this.#repository.getProviderModelCatalog(
      ownerId,
      providerId,
    );
    const sync = existing?.syncStates.find(
      (state) => state.scopeKey === scopeKey,
    );
    if (
      !force &&
      sync?.status === "current" &&
      sync.lastSuccessAt &&
      Date.now() - new Date(sync.lastSuccessAt).getTime() < FRESHNESS_WINDOW_MS
    ) {
      return existing;
    }
    if (!this.#bridge.isConnected(workerId)) {
      await this.#repository.setProviderCatalogSyncState(providerId, {
        scopeKey,
        workerId,
        status: "stale",
        error: "Worker is offline.",
      });
      if (existing && existing.models.length > 0) {
        return this.#repository.getProviderModelCatalog(
          ownerId,
          providerId,
          true,
        );
      }
      throw new Error("Worker is offline.");
    }

    await this.#repository.setProviderCatalogSyncState(providerId, {
      scopeKey,
      workerId,
      status: "refreshing",
      error: null,
      refreshStartedAt: new Date(),
    });
    try {
      const inventory = ollamaModelInventorySchema.parse(
        await this.#bridge.request(
          workerId,
          {
            type: "model.ollama.catalog",
            provider: {
              ...provider,
              kind: "ollama",
              name: "Ollama",
              accountId: null,
              credentialHomeKey: null,
            },
          },
          { ownerId, timeoutMs: DISCOVERY_TIMEOUT_MS },
        ),
      );
      const models = inventory.models.map(normalizeOllamaModel);
      await this.#repository.reconcileProviderModelCatalog(
        ownerId,
        providerId,
        {
          models,
          availabilityScope: scopeKey,
          availabilityWorkerId: workerId,
          availableNativeModelIds: new Set(
            models.map((model) => model.nativeModelId),
          ),
          autoCreateLogicalModels: true,
        },
      );
      await this.#repository.setProviderCatalogSyncState(providerId, {
        scopeKey,
        workerId,
        status: "current",
        error: null,
        lastSuccessAt: new Date(),
      });
      return this.#repository.getProviderModelCatalog(ownerId, providerId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#repository.setProviderCatalogSyncState(providerId, {
        scopeKey,
        workerId,
        status: existing?.models.length ? "stale" : "failed",
        error: message,
      });
      if (existing && existing.models.length > 0) {
        return this.#repository.getProviderModelCatalog(
          ownerId,
          providerId,
          true,
        );
      }
      throw error;
    }
  }
}
