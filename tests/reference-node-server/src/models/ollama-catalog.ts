import {
  MODEL_CATALOG_BYTES_LIMIT,
  MODEL_CATALOG_PAGE_BYTES,
  modelCatalogPageSchema,
  ollamaModelInventorySchema,
  endpointModelInventorySchema,
  usesWorkerModelCatalog,
  providerDefinitions,
  type EndpointModelInventoryItem,
  type OllamaModelInventoryItem,
  type ProviderModelCatalogResult,
} from "@cantrip/protocol";
import { randomUUID } from "node:crypto";

import type {
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
    outputModalities: [
      ...(completion ? ["text"] : []),
      ...(capabilities.has("embedding") ? ["embeddings"] : []),
      ...(capabilities.has("decision") ? ["decisions"] : []),
    ],
    operationCapabilities:
      completion ||
      capabilities.has("embedding") ||
      capabilities.has("decision")
        ? {
            language: {
              status: completion ? "supported" : "unsupported",
              source: "ollama",
              inputModalities: vision ? ["text", "image"] : ["text"],
            },
            embedding: {
              modelRevision: model.digest,
              status: capabilities.has("embedding")
                ? "supported"
                : "unsupported",
              source: "ollama",
              adapter: "ollama-embed",
              inputModalities: ["text"],
            },
            decision: {
              status: capabilities.has("decision")
                ? "supported"
                : "unsupported",
              source: "ollama",
              adapter: "system-one",
              inputModalities: vision
                ? ["text", "image", "json"]
                : ["text", "json"],
              questionTypes: ["predicate", "choice", "score"],
            },
          }
        : {},
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

export function normalizeEndpointCatalogModel({
  loaded,
  ...model
}: EndpointModelInventoryItem): ProviderModelCatalogWrite {
  return {
    ...model,
    canonicalModelId: null,
    matchConfidenceBasisPoints: null,
    rawMetadata: { loaded },
  };
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
    if (!usesWorkerModelCatalog(provider)) {
      throw new Error("Provider does not use worker endpoint discovery.");
    }
    const connection = {
      ownerId,
      connectionRevision: provider.connectionRevision,
    };
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
      const accepted = await this.#repository.setProviderCatalogSyncState(
        providerId,
        {
          connection,
          scopeKey,
          workerId,
          status: "stale",
          errorCode: "worker-offline",
        },
      );
      if (!accepted)
        return this.#repository.getProviderModelCatalog(ownerId, providerId);
      if (existing && existing.models.length > 0) {
        return this.#repository.getProviderModelCatalog(
          ownerId,
          providerId,
          true,
        );
      }
      throw new Error("Worker is offline.");
    }

    const refreshing = await this.#repository.setProviderCatalogSyncState(
      providerId,
      {
        connection,
        scopeKey,
        workerId,
        status: "refreshing",
        errorCode: null,
        refreshStartedAt: new Date(),
      },
    );
    if (!refreshing)
      return this.#repository.getProviderModelCatalog(ownerId, providerId);
    try {
      const runtimeProvider = {
        ...provider,
        name: providerDefinitions[provider.kind].label,
        accountId: null,
        credentialHomeKey: null,
      };
      const command =
        provider.kind === "ollama"
          ? {
              type: "model.ollama.catalog" as const,
              provider: { ...runtimeProvider, kind: "ollama" as const },
            }
          : {
              type: "model.endpoint.catalog" as const,
              provider: { ...runtimeProvider, kind: provider.kind },
            };
      const models: ProviderModelCatalogWrite[] = [];
      const names = new Set<string>();
      const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
      const transferId = randomUUID();
      let snapshotId: string | undefined;
      let observedAt: string | undefined;
      let metadataIncomplete = false;
      let total: number | undefined;
      let offset = 0;
      let bytes = 0;
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw new Error("Model catalog transfer timed out.");
        const result = await this.#bridge.request(
          workerId,
          {
            ...command,
            catalogPage: { transferId, snapshotId, offset },
          },
          { ownerId, timeoutMs: remaining },
        );
        if (
          !result ||
          typeof result !== "object" ||
          !("snapshotId" in result)
        ) {
          if (snapshotId)
            throw new Error("Model catalog pagination disappeared.");
          // Older workers strip the optional request field and return a full
          // legacy inventory. Never treat that as a continuation of a page.
          if (provider.kind === "ollama") {
            models.push(
              ...ollamaModelInventorySchema
                .parse(result)
                .models.map(normalizeOllamaModel),
            );
          } else {
            const inventory = endpointModelInventorySchema.parse(result);
            models.push(...inventory.models.map(normalizeEndpointCatalogModel));
            metadataIncomplete = inventory.metadataIncomplete === true;
          }
          break;
        }
        const page = modelCatalogPageSchema.parse(result);
        if (
          page.kind !== (provider.kind === "ollama" ? "ollama" : "endpoint") ||
          page.transferId !== transferId ||
          page.offset !== offset ||
          (snapshotId !== undefined &&
            (snapshotId !== page.snapshotId ||
              observedAt !== page.observedAt ||
              total !== page.total ||
              metadataIncomplete !==
                (page.kind === "endpoint" && page.metadataIncomplete === true)))
        )
          throw new Error("Model catalog page belongs to another snapshot.");
        snapshotId = page.snapshotId;
        observedAt = page.observedAt;
        metadataIncomplete =
          page.kind === "endpoint" && page.metadataIncomplete === true;
        total = page.total;
        const pageBytes = Buffer.byteLength(JSON.stringify(page));
        if (pageBytes > MODEL_CATALOG_PAGE_BYTES)
          throw new Error("Model catalog page exceeded its byte limit.");
        bytes += pageBytes;
        if (bytes > MODEL_CATALOG_BYTES_LIMIT + 64 * 1024)
          throw new Error("Model catalog transfer exceeded its byte limit.");
        const batch =
          page.kind === "ollama"
            ? page.models.map(normalizeOllamaModel)
            : page.models.map(normalizeEndpointCatalogModel);
        for (const model of batch) {
          if (names.has(model.nativeModelId))
            throw new Error("Model catalog repeated a model.");
          names.add(model.nativeModelId);
          models.push(model);
        }
        offset += page.models.length;
        if (page.nextOffset === null) {
          if (offset !== total)
            throw new Error(
              "Model catalog ended before its complete snapshot.",
            );
          break;
        }
        if (
          !page.models.length ||
          page.nextOffset !== offset ||
          offset >= total
        )
          throw new Error("Model catalog pagination did not advance.");
      }
      const accepted = await this.#repository.reconcileProviderModelCatalog(
        ownerId,
        providerId,
        {
          connectionRevision: provider.connectionRevision,
          models,
          preserveMissingModels: metadataIncomplete,
          availabilityScope: scopeKey,
          availabilityWorkerId: workerId,
          availableNativeModelIds: new Set(
            models.map((model) => model.nativeModelId),
          ),
          autoCreateLogicalModels: true,
        },
      );
      if (!accepted)
        return this.#repository.getProviderModelCatalog(ownerId, providerId);
      await this.#repository.setProviderCatalogSyncState(providerId, {
        connection,
        scopeKey,
        workerId,
        status: metadataIncomplete ? "stale" : "current",
        errorCode: metadataIncomplete
          ? "endpoint-native-metadata-unavailable"
          : null,
        ...(metadataIncomplete ? {} : { lastSuccessAt: new Date() }),
      });
      return this.#repository.getProviderModelCatalog(
        ownerId,
        providerId,
        metadataIncomplete,
      );
    } catch (error) {
      const accepted = await this.#repository.setProviderCatalogSyncState(
        providerId,
        {
          connection,
          scopeKey,
          workerId,
          status: existing?.models.length ? "stale" : "failed",
          errorCode:
            provider.kind === "ollama"
              ? "ollama-catalog-refresh-failed"
              : "endpoint-catalog-refresh-failed",
        },
      );
      if (!accepted)
        return this.#repository.getProviderModelCatalog(ownerId, providerId);
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
