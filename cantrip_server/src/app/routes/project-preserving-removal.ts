import type { ServerRepository } from "../../db/repository.js";
import type { ProjectRemovalContext } from "../../db/repository/project-lifecycle.js";
import type { ProjectShareTunnelBroker } from "../../project-shares/tunnel.js";
import type { WorkerLinkService } from "../../worker-links/service.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import type { ProjectWorktreeCoordinator } from "../../worktrees/coordinator.js";

export type ProjectPreservingRemovalCleanupStage =
  | "project-share"
  | "run-configurations"
  | "terminal-link"
  | "terminal"
  | "remote-surface";

export interface ProjectPreservingRemovalDependencies {
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  projectShareTunnel: Pick<ProjectShareTunnelBroker, "revokeProject">;
  repository: Pick<ServerRepository, "deleteProject">;
  retireRunConfigurationRuntimes: (
    ownerId: string,
    projectId: string,
  ) => Promise<void>;
  workerLinks: Pick<WorkerLinkService, "revokeResource">;
  worktreeCoordinator: Pick<ProjectWorktreeCoordinator, "serialize">;
}

/**
 * Removes one project from Cantrip while preserving every repository,
 * worktree, and attached-folder path on its workers. Runtime cleanup is best
 * effort so an offline worker cannot prevent the server-owned records from
 * being removed.
 */
export async function removeProjectPreservingFiles(
  dependencies: ProjectPreservingRemovalDependencies,
  ownerId: string,
  projectId: string,
  context: ProjectRemovalContext,
  onCleanupError: (
    stage: ProjectPreservingRemovalCleanupStage,
    error: unknown,
  ) => void,
): Promise<boolean> {
  const attempt = async (
    stage: ProjectPreservingRemovalCleanupStage,
    operation: () => Promise<unknown>,
  ) => {
    try {
      await operation();
    } catch (error) {
      onCleanupError(stage, error);
    }
  };

  await attempt("project-share", () =>
    dependencies.projectShareTunnel.revokeProject(projectId, ownerId),
  );
  return dependencies.worktreeCoordinator.serialize(
    projectId,
    async () => {
      await Promise.all(
        context.terminals.map(({ id }) =>
          attempt("terminal-link", () =>
            dependencies.workerLinks.revokeResource(
              ownerId,
              "terminal",
              id,
              "resource-deleted",
            ),
          ),
        ),
      );
      await attempt("run-configurations", () =>
        dependencies.retireRunConfigurationRuntimes(ownerId, projectId),
      );
      await Promise.all([
        ...context.terminals.map(async ({ id, workerId }) => {
          if (!dependencies.bridge.isConnected(workerId)) return;
          await attempt("terminal", () =>
            dependencies.bridge.request(workerId, {
              type: "terminal.close",
              terminalId: id,
            }),
          );
        }),
        ...context.remoteSurfaces.map(async ({ id, workerId }) => {
          if (!dependencies.bridge.isConnected(workerId)) return;
          await attempt("remote-surface", () =>
            dependencies.bridge.request(workerId, {
              type: "surface.close",
              surfaceId: id,
            }),
          );
        }),
      ]);
      return dependencies.repository.deleteProject(ownerId, projectId);
    },
    { notifyProjectChanged: false },
  );
}
