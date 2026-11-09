import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { AccountUsageMeter } from "../../account-usage/bandwidth-meter.js";
import { LiveTrafficMeter } from "../../account-usage/live-traffic-meter.js";
import { normalizeAccountEmail } from "../../auth/service.js";
import type { ServerConfig } from "../../config.js";
import type { ServerRepository } from "../../db/repository.js";
import { serverLogger } from "../../logger.js";
import { ChatGptCatalogService } from "../../models/chatgpt-catalog.js";
import { GrokCatalogService } from "../../models/grok-catalog.js";
import { OllamaCatalogService } from "../../models/ollama-catalog.js";
import { OpenRouterCatalogService } from "../../models/openrouter-catalog.js";
import { OpenRouterRuntimeCatalogHydrator } from "../../models/openrouter-runtime-catalog.js";
import { ProviderAccountLifecycleService } from "../../models/provider-account-lifecycle.js";
import { ProviderCredentialMigrationCoordinator } from "../../models/provider-credential-migrations.js";
import { ZaiCatalogService } from "../../models/zai-catalog.js";
import { RelayQuotaManager } from "../../operations/relay-quotas.js";
import { WorkerBridge } from "../../workers/bridge.js";
import { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";
import { MeteredWorkerCommandBus } from "../../workers/metered-command-bus.js";
import { installOperationalHooks } from "../http/operational-hooks.js";
import type { BuildAppOptions } from "../options.js";

export interface ApplicationServiceFoundationDependencies {
  app: FastifyInstance;
  applicationOwnerId: () => string;
  config: ServerConfig;
  coordinator: BuildAppOptions["coordinator"];
  providedProviderCatalogService: BuildAppOptions["providerCatalogService"];
  providedProviderCredentialMigrations: BuildAppOptions["providerCredentialMigrations"];
  providedRelayQuotas: BuildAppOptions["relayQuotas"];
  repository: ServerRepository;
  workerBridge: BuildAppOptions["workerBridge"];
}

/**
 * Builds the ordered provider, usage-metering, and worker-command service
 * foundation used by the application composition root.
 */
export function createApplicationServiceFoundation({
  app,
  applicationOwnerId,
  config,
  coordinator,
  providedProviderCatalogService,
  providedProviderCredentialMigrations,
  providedRelayQuotas,
  repository,
  workerBridge,
}: ApplicationServiceFoundationDependencies) {
  const providerCatalogService =
    providedProviderCatalogService ?? new OpenRouterCatalogService(repository);
  const openRouterRuntimeCatalogs = new OpenRouterRuntimeCatalogHydrator(
    async (providerId) => {
      try {
        return Boolean(
          await providerCatalogService.getProviderCatalog(
            applicationOwnerId(),
            providerId,
            false,
          ),
        );
      } catch (error) {
        app.log.warn(
          { err: error, providerId },
          "Unable to hydrate OpenRouter model metadata",
        );
        return false;
      }
    },
  );
  const licenseWhitelistConfigured =
    config.licenseWhitelistEnabled !== undefined;
  const licenseWhitelistEnabled = config.licenseWhitelistEnabled === true;
  const normalizedAdminEmail = config.adminEmail
    ? normalizeAccountEmail(config.adminEmail)
    : null;
  const liveTrafficMeter = new LiveTrafficMeter({
    instanceId: config.serverInstanceId ?? "local-single-instance",
  });
  const operationalMetrics = installOperationalHooks(app, liveTrafficMeter);
  const relayQuotas = providedRelayQuotas ?? new RelayQuotaManager(config);
  let publishAccountResourceUsageChange = (_ownerId: string): void => undefined;
  const accountUsageMeter = new AccountUsageMeter(
    repository.accountResourceUsage,
    serverLogger,
    {
      flushIntervalMs: config.bandwidthUsageFlushIntervalMs,
      flushThresholdBytes: config.bandwidthUsageFlushThresholdBytes,
      maxBufferedEntries: config.bandwidthUsageMaxBufferedEntries,
      meterId: `${config.serverInstanceId ?? "local-single-instance"}:${randomUUID()}`,
      onFlushed: (ownerIds) => {
        for (const ownerId of ownerIds)
          publishAccountResourceUsageChange(ownerId);
      },
      onMeasurement: (measurement) => liveTrafficMeter.record(measurement),
    },
  );
  const rawBridge = workerBridge ?? new WorkerBridge();
  const coordinationStats = () =>
    coordinator?.stats() ?? {
      cachedWorkers: rawBridge.stats?.().connectedWorkers ?? 0,
      instanceCount: 1,
      maximumInstances: 1,
      receivedMessages: 0,
      rejectedMessages: 0,
      sentMessages: 0,
      shared: false,
    };
  const bridge = new LimitedWorkerCommandBus(
    new MeteredWorkerCommandBus(rawBridge, accountUsageMeter),
    {
      accountConcurrency: config.accountCommandConcurrency ?? 128,
      accountRatePerMinute: config.accountCommandRatePerMinute ?? 2_400,
      consumeRelayBytes: (ownerId, workerId, bytes) =>
        relayQuotas.consumeRelay(ownerId, workerId, bytes),
      resolveOwnerId: (workerId) => repository.getWorkerOwnerId(workerId),
      workerConcurrency: config.workerCommandConcurrency ?? 64,
      workerRatePerMinute: config.workerCommandRatePerMinute ?? 1_200,
    },
  );
  const ollamaCatalogService = new OllamaCatalogService(repository, bridge);
  const chatGptCatalogService = new ChatGptCatalogService(repository, bridge);
  const grokCatalogService = new GrokCatalogService(repository, bridge);
  const zaiCatalogService = new ZaiCatalogService(repository);
  const providerCredentialMigrations =
    providedProviderCredentialMigrations ??
    new ProviderCredentialMigrationCoordinator(repository, bridge, {
      purgeEnabledKinds: new Set(["chatgpt", "grok"]),
    });
  const providerAccountLifecycle = new ProviderAccountLifecycleService(
    repository,
    bridge,
    {
      invalidateCatalog: ({ accountId, kind, ownerId, providerId }) =>
        (kind === "grok"
          ? grokCatalogService
          : chatGptCatalogService
        ).markAccountUnavailable(ownerId, providerId, accountId),
      logger: app.log,
    },
  );

  return {
    accountUsageMeter,
    bridge,
    chatGptCatalogService,
    coordinationStats,
    grokCatalogService,
    licenseWhitelistConfigured,
    licenseWhitelistEnabled,
    liveTrafficMeter,
    normalizedAdminEmail,
    ollamaCatalogService,
    openRouterRuntimeCatalogs,
    operationalMetrics,
    providerAccountLifecycle,
    providerCatalogService,
    providerCredentialMigrations,
    rawBridge,
    relayQuotas,
    setPublishAccountResourceUsageChange(
      publish: (ownerId: string) => void,
    ): void {
      publishAccountResourceUsageChange = publish;
    },
    zaiCatalogService,
  };
}
