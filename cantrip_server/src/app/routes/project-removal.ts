import {
  managedFolderDeleteResultSchema,
  projectRemoveSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import type { ProjectShareTunnelBroker } from "../../project-shares/tunnel.js";
import type { WorkerLinkService } from "../../worker-links/service.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import type { ProjectWorktreeCoordinator } from "../../worktrees/coordinator.js";

type ProjectRemovalRepository = Pick<
  ServerRepository,
  "deleteProject" | "getProjectRemovalContext" | "getWorker"
> & {
  projectGithubConversionJobs: Pick<
    ServerRepository["projectGithubConversionJobs"],
    "hasActiveProjectJob"
  >;
  projectReplicaJobs: Pick<ServerRepository["projectReplicaJobs"], "list">;
};

export interface ProjectRemovalRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  projectShareTunnel: Pick<ProjectShareTunnelBroker, "revokeProject">;
  repository: ProjectRemovalRepository;
  retireRunConfigurationRuntimes: (
    ownerId: string,
    projectId: string,
  ) => Promise<void>;
  workerLinks: Pick<WorkerLinkService, "revokeResource">;
  worktreeCoordinator: Pick<ProjectWorktreeCoordinator, "serialize">;
}

export function installProjectRemovalRoute(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    projectShareTunnel,
    repository,
    retireRunConfigurationRuntimes,
    workerLinks,
    worktreeCoordinator,
  }: ProjectRemovalRouteDependencies,
): void {
  app.delete<{ Params: { projectId: string } }>(
    "/api/projects/:projectId",
    async (request, reply) => {
      const input = projectRemoveSchema.safeParse(request.body ?? {});
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getProjectRemovalContext(
        applicationOwnerId(),
        request.params.projectId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Project not found." });
      }
      if (
        context.setupStatus === "cloning" ||
        context.setupStatus === "preparing"
      ) {
        return reply
          .code(409)
          .send({ error: "Wait for project setup to finish." });
      }
      const replicaJobs =
        (await repository.projectReplicaJobs.list(
          applicationOwnerId(),
          request.params.projectId,
        )) ?? [];
      if (
        replicaJobs.some(({ state }) => ["queued", "running"].includes(state))
      ) {
        return reply.code(409).send({
          error:
            "Cancel or wait for active project replica jobs before deleting the project.",
        });
      }
      if (
        await repository.projectGithubConversionJobs.hasActiveProjectJob(
          request.params.projectId,
        )
      ) {
        return reply.code(409).send({
          error:
            "Wait for the active GitHub conversion to finish before deleting the project.",
        });
      }
      await projectShareTunnel.revokeProject(
        request.params.projectId,
        applicationOwnerId(),
      );
      try {
        const removed = await worktreeCoordinator.serialize(
          request.params.projectId,
          async () => {
            await Promise.all(
              context.terminals.map(({ id }) =>
                workerLinks.revokeResource(
                  applicationOwnerId(),
                  "terminal",
                  id,
                  "resource-deleted",
                ),
              ),
            );
            if (input.data.deleteLocalFiles) {
              if (
                context.originKind === "managed-folder" &&
                context.folderManagement === "external"
              ) {
                return reply.code(409).send({
                  code: "external-folder-delete-forbidden",
                  error:
                    "Cantrip does not own this attached folder. Remove the project without deleting local files.",
                });
              }
              if (context.originKind === "managed-folder") {
                const workerId =
                  context.replicas[0]?.workerId ?? context.preferredWorkerId;
                if (!workerId) {
                  return reply.code(409).send({
                    error: "The folder project no longer has an owning worker.",
                  });
                }
                const worker = await repository.getWorker(
                  applicationOwnerId(),
                  workerId,
                );
                if (!worker?.managedFolders.remove) {
                  return reply.code(409).send({
                    code: "managed-folder-capability-unavailable",
                    error:
                      "The owning worker does not support safe managed folder deletion.",
                  });
                }
                if (!bridge.isConnected(workerId)) {
                  return reply.code(503).send({
                    error:
                      "The owning worker must be online before deleting local folder files.",
                  });
                }
              } else {
                const managedFolderSource =
                  context.convertedManagedFolderSource?.localFilesDeleted ===
                  false
                    ? context.convertedManagedFolderSource
                    : null;
                if (managedFolderSource) {
                  const worker = await repository.getWorker(
                    applicationOwnerId(),
                    managedFolderSource.workerId,
                  );
                  if (!worker?.managedFolders.remove) {
                    return reply.code(409).send({
                      code: "managed-folder-capability-unavailable",
                      error:
                        "The converted folder's worker does not support safe managed folder deletion.",
                    });
                  }
                  if (!bridge.isConnected(managedFolderSource.workerId)) {
                    return reply.code(503).send({
                      error:
                        "The converted folder's worker must be online before deleting its local files.",
                    });
                  }
                }
                const offlineReplica = context.replicas.find(
                  ({ id, ownershipKind, workerId }) =>
                    id !== managedFolderSource?.projectSourceId &&
                    ownershipKind === "cantrip" &&
                    !bridge.isConnected(workerId),
                );
                if (offlineReplica) {
                  return reply.code(503).send({
                    error:
                      "Every replica worker must be online before deleting local project files.",
                  });
                }
              }
              await retireRunConfigurationRuntimes(
                applicationOwnerId(),
                request.params.projectId,
              );
              await Promise.all(
                context.terminals.map(({ id, workerId }) =>
                  bridge.request(workerId, {
                    type: "terminal.close",
                    terminalId: id,
                  }),
                ),
              );
              if (context.originKind === "managed-folder") {
                const workerId =
                  context.replicas[0]?.workerId ?? context.preferredWorkerId!;
                managedFolderDeleteResultSchema.parse(
                  await bridge.request(workerId, {
                    type: "project.folder.delete",
                    projectId: request.params.projectId,
                    workspaceStorage: context.workspaceStorage,
                  }),
                );
              } else {
                const managedFolderSource =
                  context.convertedManagedFolderSource?.localFilesDeleted ===
                  false
                    ? context.convertedManagedFolderSource
                    : null;
                if (managedFolderSource) {
                  managedFolderDeleteResultSchema.parse(
                    await bridge.request(managedFolderSource.workerId, {
                      type: "project.folder.delete",
                      projectId: request.params.projectId,
                      workspaceStorage: context.workspaceStorage,
                    }),
                  );
                }
                for (const replica of context.replicas) {
                  if (replica.id === managedFolderSource?.projectSourceId)
                    continue;
                  if (replica.ownershipKind === "user") continue;
                  await bridge.request(replica.workerId, {
                    type: "project.files.delete",
                    path: replica.cwd,
                  });
                }
              }
            } else {
              await retireRunConfigurationRuntimes(
                applicationOwnerId(),
                request.params.projectId,
              );
              for (const terminal of context.terminals) {
                if (!bridge.isConnected(terminal.workerId)) continue;
                void bridge
                  .request(terminal.workerId, {
                    type: "terminal.close",
                    terminalId: terminal.id,
                  })
                  .catch(() => undefined);
              }
            }
            for (const surface of context.remoteSurfaces) {
              if (!bridge.isConnected(surface.workerId)) continue;
              await bridge
                .request(surface.workerId, {
                  type: "surface.close",
                  surfaceId: surface.id,
                })
                .catch(() => undefined);
            }
            return repository.deleteProject(
              applicationOwnerId(),
              request.params.projectId,
            );
          },
          { notifyProjectChanged: false },
        );
        if (typeof removed !== "boolean") return removed;
        return removed
          ? reply.code(204).send()
          : reply.code(404).send({ error: "Project not found." });
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );
}
