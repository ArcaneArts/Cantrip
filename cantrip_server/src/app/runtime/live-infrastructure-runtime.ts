import type { AppLiveResource } from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { AccountUsageMeter } from "../../account-usage/bandwidth-meter.js";
import { AccountUsageHistoryMaintenanceService } from "../../account-usage/history-maintenance.js";
import { StorageReconciliationService } from "../../account-usage/storage-reconciler.js";
import type { ServerConfig } from "../../config.js";
import type { RelayCoordinator } from "../../coordination/relay-coordinator.js";
import type { ServerRepository } from "../../db/repository.js";
import { AppLiveHub } from "../../live/hub.js";
import { CoalescedInvalidations } from "../../live/coalesced-invalidations.js";
import { TaskLiveInvalidationRouter } from "../../live/task-live-routing.js";
import { serverLogger } from "../../logger.js";
import type { ApplicationOwnerContext } from "../http/owner-context.js";
import {
  ACCOUNT_RESOURCE_USAGE_LIVE_COALESCE_MS,
  ACCOUNT_RESOURCE_USAGE_LIVE_TIMER_LIMIT,
  PROJECT_TOKEN_USAGE_LIVE_COALESCE_MS,
  PROJECT_TOKEN_USAGE_LIVE_TIMER_LIMIT,
} from "../shared/constants.js";

export interface LiveInfrastructureRuntimeDependencies {
  accountUsageMeter: AccountUsageMeter;
  app: FastifyInstance;
  applicationOwnerId: ApplicationOwnerContext["applicationOwnerId"];
  config: ServerConfig;
  coordinator?: RelayCoordinator;
  repository: ServerRepository;
  runAsOwner: ApplicationOwnerContext["runAsOwner"];
  serverInstanceId: string;
  setPublishAccountResourceUsageChange(
    publish: (ownerId: string) => void,
  ): void;
}

/**
 * Owns the application live hub, cross-instance subscription, coalesced usage
 * invalidations, and account-usage maintenance lifecycle.
 */
export function createLiveInfrastructureRuntime({
  accountUsageMeter,
  app,
  applicationOwnerId,
  config,
  coordinator,
  repository,
  runAsOwner,
  serverInstanceId,
  setPublishAccountResourceUsageChange,
}: LiveInfrastructureRuntimeDependencies) {
  const liveHub = new AppLiveHub({
    usageRecorder: accountUsageMeter,
    publishExternal: coordinator
      ? (publication) =>
          coordinator.publish({ kind: "live-publication", publication })
      : undefined,
  });
  const unsubscribeLiveCoordination = coordinator?.subscribe((message) => {
    if (message.kind === "live-publication") {
      liveHub.receiveExternal(message.publication);
    }
  });
  app.log.info(
    {
      instanceId: serverInstanceId,
      sharedCoordination: Boolean(coordinator),
    },
    "Server relay instance initialized",
  );
  let livePublishingEnabled = true;
  const publishLiveInvalidation = (
    resource: AppLiveResource,
    input: {
      chatId?: string | null;
      entityId?: string | null;
      projectId?: string | null;
    } = {},
  ): void => {
    if (!livePublishingEnabled) return;
    try {
      liveHub.publish({
        ownerId: applicationOwnerId(),
        scope: input.projectId
          ? { kind: "project", projectId: input.projectId }
          : input.chatId
            ? { kind: "chat", chatId: input.chatId }
            : { kind: "current-user" },
        resource,
        action: "invalidated",
        entityId: input.entityId ?? null,
        revision: null,
        payload: null,
      });
    } catch (error) {
      app.log.error(
        { err: error, resource },
        "Could not publish application live invalidation",
      );
    }
  };
  const taskLiveInvalidationRouter = new TaskLiveInvalidationRouter(
    (ownerId, chatId) => repository.getChatLiveRouting(ownerId, chatId),
    ({ entityId, ownerId, projectId, resource }) =>
      runAsOwner(ownerId, () =>
        publishLiveInvalidation(resource, { entityId, projectId }),
      ),
  );
  const projectTokenUsageLiveInvalidations = new CoalescedInvalidations<{
    ownerId: string;
    projectId: string;
  }>({
    delayMs: PROJECT_TOKEN_USAGE_LIVE_COALESCE_MS,
    limit: PROJECT_TOKEN_USAGE_LIVE_TIMER_LIMIT,
    publish: ({ ownerId, projectId }) =>
      runAsOwner(ownerId, () =>
        publishLiveInvalidation("project-token-usage", { projectId }),
      ),
  });
  const accountResourceUsageLiveInvalidations =
    new CoalescedInvalidations<string>({
      delayMs: ACCOUNT_RESOURCE_USAGE_LIVE_COALESCE_MS,
      limit: ACCOUNT_RESOURCE_USAGE_LIVE_TIMER_LIMIT,
      publish: (ownerId) =>
        runAsOwner(ownerId, () =>
          publishLiveInvalidation("account-resource-usage"),
        ),
    });
  const publishAccountResourceUsageChange = (ownerId: string): void =>
    accountResourceUsageLiveInvalidations.schedule(ownerId, ownerId);
  setPublishAccountResourceUsageChange(publishAccountResourceUsageChange);
  const storageReconciler = new StorageReconciliationService(
    repository.accountResourceUsage,
    serverInstanceId,
    serverLogger,
    {
      intervalMs: config.storageReconciliationIntervalMs,
      onReconciled: ({ ownerIds }) => {
        for (const ownerId of ownerIds)
          publishAccountResourceUsageChange(ownerId);
      },
    },
  );
  const usageHistoryMaintenance = new AccountUsageHistoryMaintenanceService(
    repository.accountResourceUsage,
    serverInstanceId,
    serverLogger,
    {
      dailyRetentionDays: config.accountUsageDailyRetentionDays ?? 400,
      flushRetentionDays: config.accountUsageFlushRetentionDays ?? 7,
      hourlyRetentionDays: config.accountUsageHourlyRetentionDays ?? 30,
      intervalMs: config.accountUsageMaintenanceIntervalMs,
    },
  );
  app.addHook("onListen", () => {
    storageReconciler.start(false);
    usageHistoryMaintenance.start(false);
    void storageReconciler
      .reconcile()
      .finally(() => usageHistoryMaintenance.run());
  });
  const publishProjectTokenUsageChange = (
    ownerId: string,
    projectId: string,
    immediate: boolean,
  ): void => {
    const key = `${ownerId}:${projectId}`;
    projectTokenUsageLiveInvalidations.schedule(
      key,
      { ownerId, projectId },
      immediate,
    );
  };

  return {
    closeAccountResourceUsageInvalidations(): void {
      accountResourceUsageLiveInvalidations.close();
    },
    closeProjectTokenUsageInvalidations(): void {
      projectTokenUsageLiveInvalidations.close();
    },
    isLivePublishingEnabled: (): boolean => livePublishingEnabled,
    liveHub,
    publishLiveInvalidation,
    publishProjectTokenUsageChange,
    storageReconciler,
    stopPublishing(): void {
      livePublishingEnabled = false;
      unsubscribeLiveCoordination?.();
    },
    taskLiveInvalidationRouter,
    usageHistoryMaintenance,
  };
}
