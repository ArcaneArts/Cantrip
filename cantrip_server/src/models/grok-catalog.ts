import {
  codexAuthStatusSchema,
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

const FRESHNESS_WINDOW_MS = 15 * 60_000;
const DISCOVERY_TIMEOUT_MS = 2 * 60_000;

export function grokAccountScope(workerId: string, accountId: string): string {
  return `worker:${workerId}:grok-account:${accountId}`;
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

function isGrokProvider(provider: ModelProviderCatalogRuntime): boolean {
  return provider.kind === "grok";
}

export class GrokCatalogService {
  readonly #bridge: WorkerCommandBus;
  readonly #repository: ServerRepository;

  constructor(repository: ServerRepository, bridge: WorkerCommandBus) {
    this.#repository = repository;
    this.#bridge = bridge;
  }

  async markAccountUnavailable(
    ownerId: string,
    providerId: string,
    workerId: string,
    accountId: string,
  ): Promise<void> {
    const scopeKey = grokAccountScope(workerId, accountId);
    await this.#repository.reconcileProviderModelCatalog(ownerId, providerId, {
      models: [],
      availabilityScope: scopeKey,
      availabilityWorkerId: workerId,
      availabilityProviderAccountId: accountId,
      availableNativeModelIds: new Set(),
    });
    await this.#repository.setProviderCatalogSyncState(providerId, {
      scopeKey,
      workerId,
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
    let succeeded = 0;
    let lastError: unknown = null;
    for (const account of selectedAccounts) {
      const scopeKey = grokAccountScope(workerId, account.id);
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
        if (knownBinding?.authState !== "signed-in") {
          const status = codexAuthStatusSchema.parse(
            await this.#bridge.request(
              workerId,
              {
                type: "codex.auth.status",
                providerId,
                providerKind: "grok",
                credentialHomeKey: runtime.credentialHomeKey,
              },
              { ownerId, timeoutMs: DISCOVERY_TIMEOUT_MS },
            ),
          );
          await this.#repository.recordModelProviderAccountStatus(
            account.id,
            workerId,
            status,
          );
          if (!status.authenticated || status.authMode !== "grok") {
            await this.markAccountUnavailable(
              ownerId,
              providerId,
              workerId,
              account.id,
            );
            continue;
          }
        }

        await this.#repository.setProviderCatalogSyncState(providerId, {
          scopeKey,
          workerId,
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
                apiKey: null,
                accountId: account.id,
                credentialHomeKey: runtime.credentialHomeKey,
              },
            },
            { ownerId, timeoutMs: DISCOVERY_TIMEOUT_MS },
          ),
        );
        const models = inventory.models.map(normalizeGrokCatalogModel);
        const visible = inventory.models.filter((model) => !model.hidden);
        await this.#repository.reconcileProviderModelCatalog(
          ownerId,
          providerId,
          {
            models,
            availabilityScope: scopeKey,
            availabilityWorkerId: workerId,
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
          workerId,
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
          workerId,
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
    throw new Error("No signed-in Grok account is available on this worker.");
  }
}
