import {
  appLiveEventPayloadSchema,
  gitConflictListSchema,
  gitManagedOperationResponseSchema,
  gitStatusSchema,
  providerAuthLiveStatusSchema,
  type AppLiveResource,
  type CodeGraphProjectStatus,
  type GitConflictList,
  type GitManagedOperationRecord,
  type GitStatus,
  type ProviderAuthLiveStatus,
  type WorktreeStatusResult,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import type { AppLiveHub } from "../../live/hub.js";

export interface ProviderAuthObservation {
  accountId: string;
  expiresAt: number;
  lastSequence: number;
  ownerId: string;
  providerId: string;
  providerKind: "chatgpt" | "grok";
  startedAt: number;
  workerId: string;
}

export interface WorkerObservationPublicationRuntimeDependencies {
  app: Pick<FastifyInstance, "log">;
  applicationOwnerId: () => string;
  isLivePublishingEnabled: () => boolean;
  liveHub: Pick<AppLiveHub, "publish">;
  publishLiveInvalidation: (
    resource: AppLiveResource,
    input?: {
      chatId?: string | null;
      entityId?: string | null;
      projectId?: string | null;
    },
  ) => void;
  repository: ServerRepository;
}

/**
 * Owns worker-originated provider-auth and Git observation state together with
 * the exact live publications derived from those observations.
 */
export function createWorkerObservationPublicationRuntime({
  app,
  applicationOwnerId,
  isLivePublishingEnabled,
  liveHub,
  publishLiveInvalidation,
  repository,
}: WorkerObservationPublicationRuntimeDependencies) {
  const runningGitOperationRequests = new Set<string>();
  const gitOperationRequestRuntime = {
    isRequestRunning: (operationId: string): boolean =>
      runningGitOperationRequests.has(operationId),
    withRequestRunning: async <T>(
      operationId: string,
      request: () => Promise<T>,
    ): Promise<T> => {
      runningGitOperationRequests.add(operationId);
      try {
        return await request();
      } finally {
        runningGitOperationRequests.delete(operationId);
      }
    },
  };
  let gitLiveRevision = Date.now() * 1_000;
  let providerAuthLiveRevision = Date.now() * 1_000;
  const activeProviderAuthObservations = new Map<
    string,
    ProviderAuthObservation
  >();
  const nextProviderAuthLiveRevision = (): number => {
    providerAuthLiveRevision = Math.max(
      providerAuthLiveRevision + 1,
      Date.now() * 1_000,
    );
    return providerAuthLiveRevision;
  };
  const publishProviderAuthStatus = (
    status: Omit<ProviderAuthLiveStatus, "revision">,
  ): ProviderAuthLiveStatus => {
    const payload = providerAuthLiveStatusSchema.parse({
      ...status,
      revision: nextProviderAuthLiveRevision(),
    });
    if (isLivePublishingEnabled()) {
      liveHub.publish({
        ownerId: applicationOwnerId(),
        scope: { kind: "current-user" },
        resource: "provider-auth",
        action: "status",
        entityId: payload.providerAccountId,
        revision: payload.revision,
        payload: appLiveEventPayloadSchema.parse(payload),
      });
    }
    return payload;
  };
  const activeProviderAuthObservation = (
    ownerId: string,
    providerId: string,
    accountId: string,
  ) =>
    [...activeProviderAuthObservations.entries()].find(
      ([, observation]) =>
        observation.ownerId === ownerId &&
        observation.providerId === providerId &&
        observation.accountId === accountId,
    ) ?? null;
  const removeProviderAuthObservations = (
    ownerId: string,
    providerId: string,
    accountId: string,
  ): void => {
    for (const [observationId, observation] of activeProviderAuthObservations) {
      if (
        observation.ownerId === ownerId &&
        observation.providerId === providerId &&
        observation.accountId === accountId
      ) {
        activeProviderAuthObservations.delete(observationId);
      }
    }
  };
  const nextGitLiveRevision = (): number => {
    gitLiveRevision = Math.max(gitLiveRevision + 1, Date.now() * 1_000);
    return gitLiveRevision;
  };
  const publishWorktreeStatus = (
    projectId: string,
    worktreeId: string,
    status: GitStatus,
  ): void => {
    if (!isLivePublishingEnabled()) return;
    try {
      liveHub.publish({
        ownerId: applicationOwnerId(),
        scope: { kind: "project", projectId },
        resource: "worktree-status",
        action: "updated",
        entityId: worktreeId,
        revision: null,
        payload: appLiveEventPayloadSchema.parse(gitStatusSchema.parse(status)),
      });
    } catch (error) {
      app.log.error(
        { err: error, projectId, worktreeId },
        "Could not publish worktree status",
      );
    }
  };
  const publishCodeGraphStatus = (
    status: CodeGraphProjectStatus,
    revision: number,
  ): void => {
    if (!isLivePublishingEnabled()) return;
    try {
      liveHub.publish({
        ownerId: applicationOwnerId(),
        scope: { kind: "project", projectId: status.projectId },
        resource: "codegraph-status",
        action: "updated",
        entityId: status.worktreeId,
        revision,
        payload: appLiveEventPayloadSchema.parse(status),
      });
    } catch (error) {
      app.log.error(
        {
          err: error,
          projectId: status.projectId,
          worktreeId: status.worktreeId,
        },
        "Could not publish CodeGraph status",
      );
    }
  };
  const publishGitOperation = (operation: GitManagedOperationRecord): void => {
    if (!isLivePublishingEnabled()) return;
    try {
      liveHub.publish({
        ownerId: applicationOwnerId(),
        scope: { kind: "project", projectId: operation.projectId },
        resource: "git-operation",
        action: "updated",
        entityId: operation.id,
        revision: nextGitLiveRevision(),
        payload: appLiveEventPayloadSchema.parse(
          gitManagedOperationResponseSchema.parse({ operation }),
        ),
      });
    } catch (error) {
      app.log.warn(
        {
          err: error,
          operationId: operation.id,
          projectId: operation.projectId,
        },
        "Could not publish exact Git operation state",
      );
      publishLiveInvalidation("git-operation", {
        entityId: operation.id,
        projectId: operation.projectId,
      });
    }
  };
  const publishGitConflicts = (
    projectId: string,
    worktreeId: string,
    conflicts: GitConflictList,
  ): void => {
    if (!isLivePublishingEnabled()) return;
    try {
      liveHub.publish({
        ownerId: applicationOwnerId(),
        scope: { kind: "project", projectId },
        resource: "git-conflict",
        action: "updated",
        entityId: worktreeId,
        revision: nextGitLiveRevision(),
        payload: appLiveEventPayloadSchema.parse(
          gitConflictListSchema.parse(conflicts),
        ),
      });
    } catch (error) {
      app.log.warn(
        { err: error, projectId, worktreeId },
        "Could not publish exact Git conflict summary",
      );
      publishLiveInvalidation("git-conflict", {
        entityId: worktreeId,
        projectId,
      });
    }
  };
  const recordLiveWorktreeStatus = async (
    projectId: string,
    worktreeId: string,
    status: WorktreeStatusResult,
  ): Promise<void> => {
    const recorded = await repository.recordProjectWorktreeStatus(
      applicationOwnerId(),
      projectId,
      worktreeId,
      status,
    );
    if (!recorded) return;
    if (recorded.snapshotChanged) {
      publishWorktreeStatus(projectId, worktreeId, recorded.status.status);
    }
    if (recorded.metadataChanged) {
      publishLiveInvalidation("worktree", { entityId: worktreeId, projectId });
    }
  };

  return {
    activeProviderAuthObservation,
    activeProviderAuthObservations,
    gitOperationRequestRuntime,
    publishCodeGraphStatus,
    publishGitConflicts,
    publishGitOperation,
    publishProviderAuthStatus,
    recordLiveWorktreeStatus,
    removeProviderAuthObservations,
  };
}
