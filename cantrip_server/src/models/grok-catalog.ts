import {
  grokModelInventorySchema,
  type GrokModelInventoryItem,
  type ProviderModelCatalogResult,
} from "@cantrip/protocol";

import type {
  ModelProviderCatalogRuntime,
  ProviderModelCatalogWrite,
  ServerRepository,
} from "../db/repository.js";
import type { WorkerCommandBus } from "../workers/bridge.js";
import { serverLogger } from "../logger.js";
import { accountProviderCatalogScope } from "./account-provider.js";
import {
  normalizeOpenRouterModel,
  OpenRouterCatalogCache,
} from "./openrouter-catalog.js";
import { persistProviderQuotaSnapshot } from "./provider-quota.js";

const FRESHNESS_WINDOW_MS = 15 * 60_000;
const DISCOVERY_TIMEOUT_MS = 2 * 60_000;
const OPENROUTER_PUBLIC_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_PUBLIC_CACHE_KEY = "public:https://openrouter.ai";

export function grokAccountScope(accountId: string): string {
  return accountProviderCatalogScope("grok", accountId);
}

export function normalizeGrokCatalogModel(
  model: GrokModelInventoryItem,
): ProviderModelCatalogWrite {
  const supportsVision = model.inputModalities.includes("image") ? true : null;
  return {
    nativeModelId: model.id,
    canonicalModelId: model.id,
    displayName: model.displayName,
    description: model.description,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    inputModalities: model.inputModalities,
    outputModalities: model.outputModalities,
    supportsTools: true,
    supportsParallelTools: true,
    supportsStructuredOutput: null,
    supportsVision,
    supportsReasoning: model.supportsReasoning,
    supportedReasoningEfforts: model.supportedReasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
    reasoningMandatory: null,
    family: "grok",
    parameterSize: null,
    quantization: null,
    digest: null,
    metadataSource: "grok",
    matchConfidenceBasisPoints: 10_000,
    hidden: model.hidden,
    isDefault: model.isDefault,
    rawMetadata: model.rawMetadata,
  };
}

function normalizedIdentity(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

export function enrichGrokCatalogVisionFromOpenRouter(
  models: ProviderModelCatalogWrite[],
  candidates: ProviderModelCatalogWrite[],
): ProviderModelCatalogWrite[] {
  return models.map((model) => {
    if (model.supportsVision !== null) return model;
    const nativeModelId = normalizedIdentity(model.nativeModelId);
    if (!nativeModelId) return model;
    const aliases = new Set([nativeModelId, `x-ai/${nativeModelId}`]);
    const matches = candidates.filter((candidate) =>
      [candidate.nativeModelId, candidate.canonicalModelId]
        .map(normalizedIdentity)
        .filter((identity): identity is string => identity !== null)
        .some((identity) => aliases.has(identity)),
    );
    if (matches.length !== 1 || matches[0]!.supportsVision !== true) {
      return model;
    }
    return {
      ...model,
      inputModalities: [
        ...new Set([...model.inputModalities, ...matches[0]!.inputModalities]),
      ],
      supportsVision: true,
    };
  });
}

function isGrokProvider(provider: ModelProviderCatalogRuntime): boolean {
  return provider.kind === "grok";
}

export class GrokCatalogService {
  readonly #bridge: WorkerCommandBus;
  readonly #openRouterCache: OpenRouterCatalogCache;
  readonly #repository: ServerRepository;

  constructor(
    repository: ServerRepository,
    bridge: WorkerCommandBus,
    options: ConstructorParameters<typeof OpenRouterCatalogCache>[0] = {},
  ) {
    this.#repository = repository;
    this.#bridge = bridge;
    this.#openRouterCache = new OpenRouterCatalogCache(options);
  }

  async #publicOpenRouterModels(
    force: boolean,
  ): Promise<ProviderModelCatalogWrite[]> {
    try {
      const read = await this.#openRouterCache.read({
        baseUrl: OPENROUTER_PUBLIC_BASE_URL,
        cacheKey: OPENROUTER_PUBLIC_CACHE_KEY,
        force,
      });
      return read.snapshot.models.map(normalizeOpenRouterModel);
    } catch (error) {
      serverLogger.rateLimited(
        "grok-catalog-openrouter-metadata-unavailable",
        "warn",
        "Grok catalog capability enrichment is temporarily unavailable",
        {
          event: "provider.grok.catalog_enrichment_unavailable",
          subsystem: "provider-catalog",
          operation: "enrich-grok-catalog",
          status: "degraded",
          reasonCode: "openrouter_public_catalog_unavailable",
          error: error instanceof Error ? error.message : String(error),
        },
        { summaryEvery: 10, windowMs: 60_000 },
      );
      return [];
    }
  }

  async markAccountUnavailable(
    ownerId: string,
    providerId: string,
    accountId: string,
  ): Promise<void> {
    const scopeKey = grokAccountScope(accountId);
    await this.#repository.reconcileProviderModelCatalog(ownerId, providerId, {
      models: [],
      availabilityScope: scopeKey,
      availabilityWorkerId: null,
      availabilityProviderAccountId: accountId,
      availableNativeModelIds: new Set(),
    });
    await this.#repository.setProviderCatalogSyncState(providerId, {
      scopeKey,
      workerId: null,
      providerAccountId: accountId,
      status: "current",
      error: null,
      lastSuccessAt: new Date(),
    });
  }

  async getProviderCatalog(
    ownerId: string,
    providerId: string,
    workerId: string,
    force = false,
    requestedAccountId?: string,
    quotaTrigger = force ? "manual-refresh" : "catalog-refresh",
  ): Promise<ProviderModelCatalogResult | null> {
    const [provider, worker, accounts] = await Promise.all([
      this.#repository.getModelProviderCatalogRuntime(ownerId, providerId),
      this.#repository.getWorker(ownerId, workerId),
      this.#repository.listModelProviderAccounts(ownerId, providerId),
    ]);
    if (!provider) return null;
    if (!worker) throw new Error("Worker not found.");
    if (!isGrokProvider(provider) || !accounts) {
      throw new Error("Provider is not a Grok provider.");
    }
    if (!this.#bridge.isConnected(workerId)) {
      throw new Error("Worker is offline.");
    }

    const selectedAccounts = accounts.filter(
      (account) =>
        account.enabled &&
        (!requestedAccountId || account.id === requestedAccountId),
    );
    if (requestedAccountId && selectedAccounts.length === 0) {
      throw new Error("Grok account not found.");
    }
    const existing = await this.#repository.getProviderModelCatalog(
      ownerId,
      providerId,
    );
    let publicMetadata: Promise<ProviderModelCatalogWrite[]> | null = null;
    let succeeded = 0;
    let lastError: unknown = null;
    for (const account of selectedAccounts) {
      const scopeKey = grokAccountScope(account.id);
      const sync = existing?.syncStates.find(
        (state) => state.scopeKey === scopeKey,
      );
      if (
        !force &&
        sync?.status === "current" &&
        sync.lastSuccessAt &&
        Date.now() - new Date(sync.lastSuccessAt).getTime() <
          FRESHNESS_WINDOW_MS
      ) {
        succeeded += 1;
        continue;
      }

      const runtime = await this.#repository.getModelProviderAccountRuntime(
        ownerId,
        providerId,
        account.id,
      );
      if (!runtime) continue;
      try {
        const knownBinding = account.workerBindings.find(
          (binding) => binding.workerId === workerId,
        );
        const legacyAvailable =
          account.credentialState === "migration-needed" &&
          knownBinding?.authState === "signed-in";
        if (account.credentialState !== "signed-in" && !legacyAvailable) {
          await this.markAccountUnavailable(ownerId, providerId, account.id);
          continue;
        }

        await this.#repository.setProviderCatalogSyncState(providerId, {
          scopeKey,
          workerId: null,
          providerAccountId: account.id,
          status: "refreshing",
          error: null,
          refreshStartedAt: new Date(),
        });
        const inventory = grokModelInventorySchema.parse(
          await this.#bridge.request(
            workerId,
            {
              type: "model.grok.catalog",
              provider: {
                id: providerId,
                name: "Grok",
                kind: "grok",
                baseUrl: provider.baseUrl,
                protectedApiKey: null,
                accountId: account.id,
                credentialHomeKey: runtime.credentialHomeKey,
              },
            },
            { ownerId, timeoutMs: DISCOVERY_TIMEOUT_MS },
          ),
        );
        if (inventory.quotaSnapshot) {
          await persistProviderQuotaSnapshot(
            this.#repository,
            {
              ownerId,
              providerId,
              accountId: account.id,
              accountPlanType: account.planType,
              workerId,
              trigger: quotaTrigger,
            },
            inventory.quotaSnapshot,
          );
        } else if (inventory.weeklyUsage) {
          await this.#repository.recordModelProviderAccountUsage({
            accountId: account.id,
            ownerId,
            planType: account.planType,
            providerId,
            resetsAt: inventory.weeklyUsage.resetsAt,
            usedPercent: inventory.weeklyUsage.usedPercent,
          });
        }
        let models = inventory.models.map(normalizeGrokCatalogModel);
        if (models.some((model) => model.supportsVision === null)) {
          publicMetadata ??= this.#publicOpenRouterModels(force);
          models = enrichGrokCatalogVisionFromOpenRouter(
            models,
            await publicMetadata,
          );
        }
        const visible = inventory.models.filter((model) => !model.hidden);
        await this.#repository.reconcileProviderModelCatalog(
          ownerId,
          providerId,
          {
            models,
            availabilityScope: scopeKey,
            availabilityWorkerId: null,
            availabilityProviderAccountId: account.id,
            availableNativeModelIds: new Set(
              models.map((model) => model.nativeModelId),
            ),
            autoCreateLogicalModels: true,
            autoCreateNativeModelIds: new Set(visible.map((model) => model.id)),
            defaultNativeModelId:
              visible.find((model) => model.isDefault)?.id ?? null,
          },
        );
        await this.#repository.setProviderCatalogSyncState(providerId, {
          scopeKey,
          workerId: null,
          providerAccountId: account.id,
          status: "current",
          error: null,
          lastSuccessAt: new Date(),
        });
        succeeded += 1;
      } catch (error) {
        lastError = error;
        await this.#repository.setProviderCatalogSyncState(providerId, {
          scopeKey,
          workerId: null,
          providerAccountId: account.id,
          status: existing?.models.length ? "stale" : "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (succeeded > 0 || existing?.models.length) {
      return this.#repository.getProviderModelCatalog(
        ownerId,
        providerId,
        succeeded === 0,
      );
    }
    if (lastError) throw lastError;
    throw new Error("No signed-in Grok account is available.");
  }
}
