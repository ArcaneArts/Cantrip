import type { AppLiveResource } from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import {
  ChatImportJobExecutor,
  type ChatImportLiveChange,
} from "../../chat-imports/executor.js";
import {
  ChatRelocationJobExecutor,
  type ChatRelocationLiveChange,
} from "../../chat-relocations/executor.js";
import type { ServerRepository } from "../../db/repository.js";
import type { AppLiveHub } from "../../live/hub.js";
import {
  ProjectFolderSetupJobExecutor,
  type ProjectFolderSetupLiveChange,
} from "../../project-folders/executor.js";
import {
  ProjectGithubConversionJobExecutor,
  type ProjectGithubConversionLiveChange,
} from "../../project-github-conversions/executor.js";
import {
  ProjectReplicaJobExecutor,
  type ProjectReplicaJobLiveChange,
} from "../../project-replicas/executor.js";
import {
  StandaloneChatRootJobExecutor,
  type StandaloneChatRootJobLiveChange,
} from "../../standalone-chats/root-job-executor.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";
import {
  WorkspaceRepositoryDiscoveryJobExecutor,
  type WorkspaceRepositoryDiscoveryLiveChange,
} from "../../workspace-repository-discovery/executor.js";
import {
  WorkflowExecutor,
  type WorkflowRunLiveChange,
} from "../../workflows/executor.js";
import { ProjectWorktreeCoordinator } from "../../worktrees/coordinator.js";

type OwnerRunner = <T>(ownerId: string, operation: () => T) => T;

export interface BackgroundJobRuntimeDependencies {
  app: Pick<FastifyInstance, "log">;
  applicationOwnerId: () => string;
  bridge: LimitedWorkerCommandBus;
  liveHub: Pick<AppLiveHub, "publish">;
  livePublishingEnabled: () => boolean;
  publishLiveInvalidation: (
    resource: AppLiveResource,
    input?: {
      chatId?: string | null;
      entityId?: string | null;
      projectId?: string | null;
    },
  ) => void;
  repository: ServerRepository;
  runAsOwner: OwnerRunner;
  scheduleProjectWorktreeObservation: (projectId: string) => Promise<void>;
  scheduleWorkerWorktreeObservation: (workerId: string) => void;
}

/**
 * Owns the worktree coordinator and durable workflow, project, and chat
 * background-job executors together with their live change publication.
 */
export function createBackgroundJobRuntime({
  app,
  applicationOwnerId,
  bridge,
  liveHub,
  livePublishingEnabled,
  publishLiveInvalidation,
  repository,
  runAsOwner,
  scheduleProjectWorktreeObservation,
  scheduleWorkerWorktreeObservation,
}: BackgroundJobRuntimeDependencies) {
  const worktreeCoordinator = new ProjectWorktreeCoordinator(
    repository,
    bridge,
    (projectId) => {
      publishLiveInvalidation("worktree", { projectId });
      void scheduleProjectWorktreeObservation(projectId);
    },
  );
  const publishWorkflowRunChange = (
    change: Omit<WorkflowRunLiveChange, "ownerId"> & { ownerId?: string },
  ): void => {
    if (!livePublishingEnabled()) return;
    try {
      const ownerId = change.ownerId ?? applicationOwnerId();
      liveHub.publish({
        ownerId,
        scope: { kind: "workflow-run", runId: change.runId },
        resource: change.resource,
        action: "invalidated",
        entityId: change.runId,
        revision: change.revision,
        payload: null,
      });
      if (change.projectId) {
        liveHub.publish({
          ownerId,
          scope: { kind: "project", projectId: change.projectId },
          resource: change.resource,
          action: "invalidated",
          entityId: change.runId,
          revision: change.revision,
          payload: null,
        });
      }
    } catch (error) {
      app.log.error(
        { err: error, workflowRunId: change.runId },
        "Could not publish workflow run live change",
      );
    }
  };
  const workflowExecutor = new WorkflowExecutor(
    repository,
    bridge,
    worktreeCoordinator,
    app.log,
    publishWorkflowRunChange,
  );
  const publishProjectReplicaJobChange = (
    change: ProjectReplicaJobLiveChange,
  ): void => {
    const replicaLogContext = {
      event: "replica.job.transitioned",
      subsystem: "project-replica",
      operation: change.job.kind,
      status: change.job.state,
      runId: change.job.id,
      projectId: change.job.projectId,
      workerId: change.job.workerId,
      attempt: change.job.attempt,
    };
    if (change.job.state === "failed") {
      app.log.error(replicaLogContext, "Project replica job failed");
    } else if (change.job.state === "blocked") {
      app.log.warn(replicaLogContext, "Project replica job blocked");
    } else if (change.job.state === "succeeded") {
      app.log.info(replicaLogContext, "Project replica job completed");
    } else {
      app.log.debug(replicaLogContext, "Project replica job transitioned");
    }
    if (!livePublishingEnabled()) return;
    try {
      liveHub.publish({
        ownerId: change.ownerId,
        scope: { kind: "project", projectId: change.job.projectId },
        resource: "project-replica-job",
        action: "invalidated",
        entityId: change.job.id,
        revision: change.job.stateRevision,
        payload: null,
      });
      // Running progress only changes the replica job. Invalidating the project
      // here makes every clone progress frame rehydrate every project through
      // its worker-backed encrypted metadata path.
      if (change.job.state !== "running") {
        liveHub.publish({
          ownerId: change.ownerId,
          scope: { kind: "project", projectId: change.job.projectId },
          resource: "project",
          action: "invalidated",
          entityId: change.job.projectId,
          revision: null,
          payload: null,
        });
        // A newly imported repository may not be selected yet, so its client
        // only retains the current-user scope. Notify that scope as well or
        // the global project list can remain stuck on "cloning" until reload.
        liveHub.publish({
          ownerId: change.ownerId,
          scope: { kind: "current-user" },
          resource: "project",
          action: "invalidated",
          entityId: change.job.projectId,
          revision: null,
          payload: null,
        });
      }
      if (change.job.state === "succeeded") {
        liveHub.publish({
          ownerId: change.ownerId,
          scope: { kind: "project", projectId: change.job.projectId },
          resource: "worktree",
          action: "invalidated",
          entityId: change.job.projectReplicaId,
          revision: null,
          payload: null,
        });
        scheduleWorkerWorktreeObservation(change.job.workerId);
      }
    } catch (error) {
      app.log.error(
        { err: error, projectReplicaJobId: change.job.id },
        "Could not publish project replica job change",
      );
    }
  };
  const projectReplicaJobExecutor = new ProjectReplicaJobExecutor(
    repository,
    bridge,
    app.log,
    publishProjectReplicaJobChange,
  );
  const publishProjectFolderSetupChange = (
    change: ProjectFolderSetupLiveChange,
  ): void => {
    const context = {
      event: "project-folder.setup.transitioned",
      subsystem: "project-folder",
      operation: "materialize",
      status: change.job.state,
      runId: change.job.id,
      projectId: change.job.projectId,
      workerId: change.job.workerId,
      attempt: change.job.attempt,
    };
    if (change.job.state === "failed") {
      app.log.error(context, "Project folder setup failed");
    } else if (change.job.state === "blocked") {
      app.log.warn(context, "Project folder setup blocked");
    } else if (change.job.state === "succeeded") {
      app.log.info(context, "Project folder setup completed");
    } else {
      app.log.debug(context, "Project folder setup transitioned");
    }
    if (!livePublishingEnabled()) return;
    try {
      liveHub.publish({
        ownerId: change.ownerId,
        scope: { kind: "project", projectId: change.job.projectId },
        resource: "project-folder-setup-job",
        action: "invalidated",
        entityId: change.job.id,
        revision: change.job.stateRevision,
        payload: null,
      });
      liveHub.publish({
        ownerId: change.ownerId,
        scope: { kind: "project", projectId: change.job.projectId },
        resource: "project",
        action: "invalidated",
        entityId: change.job.projectId,
        revision: null,
        payload: null,
      });
      if (change.job.state === "succeeded") {
        liveHub.publish({
          ownerId: change.ownerId,
          scope: { kind: "project", projectId: change.job.projectId },
          resource: "worktree",
          action: "invalidated",
          entityId: change.job.projectId,
          revision: null,
          payload: null,
        });
      }
    } catch (error) {
      app.log.error(
        { err: error, projectFolderSetupJobId: change.job.id },
        "Could not publish project folder setup change",
      );
    }
  };
  const projectFolderSetupJobExecutor = new ProjectFolderSetupJobExecutor(
    repository,
    bridge,
    app.log,
    publishProjectFolderSetupChange,
  );
  const publishWorkspaceRepositoryDiscoveryChange = (
    change: WorkspaceRepositoryDiscoveryLiveChange,
  ): void => {
    if (!change.progress) {
      const context = {
        event: "workspace.repository-discovery.transitioned",
        subsystem: "workspace-repository-discovery",
        operation: "discover",
        status: change.job.state,
        runId: change.job.id,
        workspaceId: change.job.workspaceId,
        workerId: change.job.workerId,
        attempt: change.job.attempt,
      };
      if (change.job.state === "failed") {
        app.log.error(context, "Workspace repository discovery failed");
      } else if (change.job.state === "blocked") {
        app.log.warn(context, "Workspace repository discovery blocked");
      } else if (change.job.state === "succeeded") {
        app.log.info(context, "Workspace repository discovery completed");
      } else {
        app.log.debug(context, "Workspace repository discovery transitioned");
      }
    }
    if (!livePublishingEnabled()) return;
    try {
      liveHub.publish({
        ownerId: change.ownerId,
        scope: { kind: "current-user" },
        resource: "workspace-repository-discovery-job",
        action: change.progress ? "status" : "invalidated",
        entityId: change.job.workspaceId,
        revision: change.job.stateRevision,
        payload: change.progress ? { progress: change.progress } : null,
      });
    } catch (error) {
      app.log.error(
        { err: error, workspaceRepositoryDiscoveryJobId: change.job.id },
        "Could not publish workspace repository discovery change",
      );
    }
  };
  const workspaceRepositoryDiscoveryJobExecutor =
    new WorkspaceRepositoryDiscoveryJobExecutor(
      repository,
      bridge,
      app.log,
      publishWorkspaceRepositoryDiscoveryChange,
    );
  const publishStandaloneChatRootJobChange = (
    change: StandaloneChatRootJobLiveChange,
  ): void => {
    runAsOwner(change.ownerId, () => {
      publishLiveInvalidation("chat", { entityId: change.job.chatId });
    });
    const context = {
      event: "standalone-chat.scratch.transitioned",
      subsystem: "standalone-chat-scratch",
      operation: change.job.kind,
      status: change.job.state,
      runId: change.job.id,
      chatId: change.job.chatId,
      workerId: change.job.workerId,
      attempt: change.job.attempt,
    };
    if (change.job.state === "failed") {
      app.log.error(context, "Standalone Chat scratch job failed");
    } else if (change.job.state === "blocked") {
      app.log.warn(context, "Standalone Chat scratch job blocked");
    } else if (change.job.state === "succeeded") {
      app.log.info(context, "Standalone Chat scratch job completed");
    } else {
      app.log.debug(context, "Standalone Chat scratch job transitioned");
    }
  };
  const standaloneChatRootJobExecutor = new StandaloneChatRootJobExecutor(
    repository,
    bridge,
    app.log,
    publishStandaloneChatRootJobChange,
  );
  const publishProjectGithubConversionChange = (
    change: ProjectGithubConversionLiveChange,
  ): void => {
    const context = {
      event: "project.github-conversion.transitioned",
      subsystem: "project-github-conversion",
      operation: "convert",
      status: change.job.state,
      runId: change.job.id,
      projectId: change.job.projectId,
      workerId: change.job.workerId,
      attempt: change.job.attempt,
      repository: change.job.repository.nameWithOwner,
    };
    if (change.job.state === "failed") {
      app.log.error(context, "Project GitHub conversion failed");
    } else if (change.job.state === "blocked") {
      app.log.warn(context, "Project GitHub conversion blocked");
    } else if (change.job.state === "succeeded") {
      app.log.info(context, "Project GitHub conversion completed");
    } else {
      app.log.debug(context, "Project GitHub conversion transitioned");
    }
    if (!livePublishingEnabled()) return;
    try {
      liveHub.publish({
        ownerId: change.ownerId,
        scope: { kind: "project", projectId: change.job.projectId },
        resource: "project-github-conversion-job",
        action: "invalidated",
        entityId: change.job.id,
        revision: change.job.stateRevision,
        payload: null,
      });
      liveHub.publish({
        ownerId: change.ownerId,
        scope: { kind: "project", projectId: change.job.projectId },
        resource: "project",
        action: "invalidated",
        entityId: change.job.projectId,
        revision: null,
        payload: null,
      });
      if (change.job.state === "succeeded") {
        for (const resource of [
          "worktree",
          "worktree-status",
          "git-operation",
          "settings",
        ] as const) {
          liveHub.publish({
            ownerId: change.ownerId,
            scope: { kind: "project", projectId: change.job.projectId },
            resource,
            action: "invalidated",
            entityId: change.job.projectId,
            revision: null,
            payload: null,
          });
        }
        scheduleWorkerWorktreeObservation(change.job.workerId);
      }
    } catch (error) {
      app.log.error(
        { err: error, projectGithubConversionJobId: change.job.id },
        "Could not publish project GitHub conversion change",
      );
    }
  };
  const projectGithubConversionJobExecutor =
    new ProjectGithubConversionJobExecutor(
      repository,
      bridge,
      app.log,
      publishProjectGithubConversionChange,
    );
  const publishChatImportChange = (change: ChatImportLiveChange): void => {
    const importLogContext = {
      event: "chat-import.job.transitioned",
      subsystem: "chat-import",
      operation: "import-chat",
      status: change.job.state,
      runId: change.job.id,
      projectId: change.job.projectId,
      ...(change.job.chatId ? { chatId: change.job.chatId } : {}),
      workerId: change.job.targetPlacement.workerId,
      attempt: change.job.attempt,
    };
    if (change.job.state === "failed") {
      app.log.error(importLogContext, "Chat import failed");
    } else if (change.job.state === "blocked") {
      app.log.warn(importLogContext, "Chat import needs attention");
    } else if (change.job.state === "succeeded") {
      app.log.info(importLogContext, "Chat import completed");
    } else {
      app.log.debug(importLogContext, "Chat import transitioned");
    }
    if (!livePublishingEnabled()) return;
    try {
      liveHub.publish({
        ownerId: change.ownerId,
        scope: { kind: "project", projectId: change.job.projectId },
        resource: "chat-import-job",
        action: "invalidated",
        entityId: change.job.id,
        revision: change.job.stateRevision,
        payload: null,
      });
      liveHub.publish({
        ownerId: change.ownerId,
        scope: { kind: "project", projectId: change.job.projectId },
        resource: "project",
        action: "invalidated",
        entityId: change.job.projectId,
        revision: null,
        payload: null,
      });
      if (change.job.chatId) {
        liveHub.publish({
          ownerId: change.ownerId,
          scope: { kind: "project", projectId: change.job.projectId },
          resource: "chat",
          action: "invalidated",
          entityId: change.job.chatId,
          revision: null,
          payload: null,
        });
        liveHub.publish({
          ownerId: change.ownerId,
          scope: { kind: "chat", chatId: change.job.chatId },
          resource: "chat-message",
          action: "invalidated",
          entityId: change.job.chatId,
          revision: null,
          payload: null,
        });
      }
    } catch (error) {
      app.log.error(
        { err: error, chatImportJobId: change.job.id },
        "Could not publish chat import change",
      );
    }
  };
  const chatImportJobExecutor = new ChatImportJobExecutor(
    repository,
    bridge,
    app.log,
    publishChatImportChange,
  );
  const publishChatRelocationChange = (
    change: ChatRelocationLiveChange,
  ): void => {
    const relocationLogContext = {
      event: "chat-relocation.job.transitioned",
      subsystem: "chat-relocation",
      operation: "relocate-chat",
      status: change.job.state,
      runId: change.job.id,
      projectId: change.job.projectId,
      chatId: change.job.chatId,
      workerId: change.job.targetPlacement.workerId,
      attempt: change.job.attempt,
    };
    if (change.job.state === "failed") {
      app.log.error(relocationLogContext, "Chat relocation failed");
    } else if (change.job.state === "blocked") {
      app.log.warn(relocationLogContext, "Chat relocation blocked");
    } else if (change.job.state === "succeeded") {
      app.log.info(relocationLogContext, "Chat relocation completed");
    } else {
      app.log.debug(relocationLogContext, "Chat relocation transitioned");
    }
    if (!livePublishingEnabled()) return;
    try {
      liveHub.publish({
        ownerId: change.ownerId,
        scope: { kind: "chat", chatId: change.job.chatId },
        resource: "chat-relocation-job",
        action: "invalidated",
        entityId: change.job.id,
        revision: change.job.stateRevision,
        payload: null,
      });
      liveHub.publish({
        ownerId: change.ownerId,
        scope: { kind: "project", projectId: change.job.projectId },
        resource: "chat",
        action: "invalidated",
        entityId: change.job.chatId,
        revision: change.chat?.placementRevision ?? null,
        payload: null,
      });
      if (change.chat) {
        liveHub.publish({
          ownerId: change.ownerId,
          scope: { kind: "chat", chatId: change.job.chatId },
          resource: "chat",
          action: "updated",
          entityId: change.job.chatId,
          revision: change.chat.placementRevision,
          payload: null,
        });
      }
    } catch (error) {
      app.log.error(
        { err: error, chatRelocationJobId: change.job.id },
        "Could not publish chat relocation change",
      );
    }
  };
  const chatRelocationJobExecutor = new ChatRelocationJobExecutor(
    repository,
    bridge,
    app.log,
    () => projectReplicaJobExecutor.queueAvailable(),
    publishChatRelocationChange,
  );

  return {
    chatImportJobExecutor,
    chatRelocationJobExecutor,
    projectFolderSetupJobExecutor,
    projectGithubConversionJobExecutor,
    projectReplicaJobExecutor,
    publishWorkspaceRepositoryDiscoveryChange,
    publishChatImportChange,
    publishChatRelocationChange,
    publishProjectFolderSetupChange,
    publishProjectGithubConversionChange,
    publishProjectReplicaJobChange,
    publishStandaloneChatRootJobChange,
    publishWorkflowRunChange,
    standaloneChatRootJobExecutor,
    workflowExecutor,
    workspaceRepositoryDiscoveryJobExecutor,
    worktreeCoordinator,
  };
}
