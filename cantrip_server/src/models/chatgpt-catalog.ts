import {
  chatGptModelInventorySchema,
  type ChatGptModelInventoryItem,
  type ProviderModelCatalogResult,
} from "@cantrip/protocol";

import type {
  ModelProviderCatalogRuntime,
  ProviderModelCatalogWrite,
  ServerRepository,
} from "../db/repository.js";
import type { WorkerCommandBus } from "../workers/bridge.js";
import { accountProviderCatalogScope } from "./account-provider.js";

const FRESHNESS_WINDOW_MS = 15 * 60_000;
const DISCOVERY_TIMEOUT_MS = 2 * 60_000;

export function chatGptAccountScope(accountId: string): string {
  return accountProviderCatalogScope("chatgpt", accountId);
}

export function normalizeChatGptModel(
  model: ChatGptModelInventoryItem,
): ProviderModelCatalogWrite {
  const efforts = model.supportedReasoningEfforts.map((effort) => ({
    effort: effort.reasoningEffort,
    description: effort.description || null,
  }));
  return {
    nativeModelId: model.model,
    canonicalModelId: model.model,
    displayName: model.displayName,
    description: model.description || null,
    contextWindow: null,
    maxOutputTokens: null,
    inputModalities:
      model.inputModalities.length > 0 ? model.inputModalities : ["text"],
    outputModalities: ["text"],
    supportsTools: null,
    supportsParallelTools: null,
    supportsStructuredOutput: null,
    supportsVision: model.inputModalities.includes("image"),
    supportsReasoning: efforts.length > 0,
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
    reasoningMandatory: null,
    family: model.modelSpecialty,
    parameterSize: null,
    quantization: null,
    digest: null,
    metadataSource: "codex",
    matchConfidenceBasisPoints: 10_000,
    hidden: model.hidden,
    isDefault: model.isDefault,
    rawMetadata: {
      catalogId: model.id,
      upgrade: model.upgrade,
      upgradeInfo: model.upgradeInfo,
      availabilityNux: model.availabilityNux,
      supportsPersonality: model.supportsPersonality,
      additionalSpeedTiers: model.additionalSpeedTiers,
      serviceTiers: model.serviceTiers,
      defaultServiceTier: model.defaultServiceTier,
    },
  };
}

function isChatGptProvider(provider: ModelProviderCatalogRuntime): boolean {
  return provider.kind === "chatgpt";
}

export class ChatGptCatalogService {
  readonly #bridge: WorkerCommandBus;
  readonly #repository: ServerRepository;

  constructor(repository: ServerRepository, bridge: WorkerCommandBus) {
    this.#repository = repository;
    this.#bridge = bridge;
  }

  async markAccountUnavailable(
    ownerId: string,
    providerId: string,
    accountId: string,
  ): Promise<void> {
    const scopeKey = chatGptAccountScope(accountId);
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
  ): Promise<ProviderModelCatalogResult | null> {
    const [provider, worker, accounts] = await Promise.all([
      this.#repository.getModelProviderCatalogRuntime(ownerId, providerId),
      this.#repository.getWorker(ownerId, workerId),
      this.#repository.listModelProviderAccounts(ownerId, providerId),
    ]);
    if (!provider) return null;
    if (!worker) throw new Error("Worker not found.");
    if (!isChatGptProvider(provider) || !accounts) {
      throw new Error("Provider is not a ChatGPT provider.");
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
      throw new Error("ChatGPT account not found.");
    }
    const existing = await this.#repository.getProviderModelCatalog(
      ownerId,
      providerId,
    );
    let succeeded = 0;
    let lastError: unknown = null;
    for (const account of selectedAccounts) {
      const scopeKey = chatGptAccountScope(account.id);
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
        const inventory = chatGptModelInventorySchema.parse(
          await this.#bridge.request(
            workerId,
            {
              type: "model.chatgpt.catalog",
              provider: {
                id: providerId,
                name: "ChatGPT",
                kind: "chatgpt",
                baseUrl: provider.baseUrl,
                apiKey: null,
                accountId: account.id,
                credentialHomeKey: runtime.credentialHomeKey,
              },
            },
            { ownerId, timeoutMs: DISCOVERY_TIMEOUT_MS },
          ),
        );
        if (inventory.weeklyUsage) {
          await this.#repository.recordModelProviderAccountUsage({
            accountId: account.id,
            ownerId,
            planType: account.planType,
            providerId,
            resetsAt: inventory.weeklyUsage.resetsAt,
            usedPercent: inventory.weeklyUsage.usedPercent,
          });
        }
        const models = inventory.models.map(normalizeChatGptModel);
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
            autoCreateNativeModelIds: new Set(
              visible.map((model) => model.model),
            ),
            defaultNativeModelId:
              visible.find((model) => model.isDefault)?.model ?? null,
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
    throw new Error("No signed-in ChatGPT account is available.");
  }
}
