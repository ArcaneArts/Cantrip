import {
  projectWorktreeCreateSchema,
  projectWorktreeListSchema,
  projectWorktreeLockSchema,
  projectWorktreePruneSchema,
  projectWorktreeRemoveSchema,
  projectWorktreeSummarySchema,
  worktreeMutationResultSchema,
  worktreePruneResultSchema,
  worktreeRemoveResultSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import {
  sendWorkerConflictFailure,
  sendWorkerRequestFailure,
} from "../../http/worker-request-failures.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import type { ProjectWorktreeCoordinator } from "../../worktrees/coordinator.js";

export interface ProjectWorktreeRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  repository: Pick<
    ServerRepository,
    | "getProjectSource"
    | "getProjectWorktreeContext"
    | "getWorktreeRemovalBlockers"
    | "listProjectWorktrees"
    | "reconcileProjectWorktrees"
    | "setProjectWorktreeLifecycle"
  >;
  retireRunConfigurationRuntimes: (
    ownerId: string,
    projectId: string,
    filter: { worktreeId: string },
  ) => Promise<void>;
  worktreeCoordinator: Pick<
    ProjectWorktreeCoordinator,
    "create" | "reconcile" | "serialize"
  >;
}

export function installProjectWorktreeRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    repository,
    retireRunConfigurationRuntimes,
    worktreeCoordinator,
  }: ProjectWorktreeRouteDependencies,
): void {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/worktrees",
    async (request, reply) => {
      const worktrees = await repository.listProjectWorktrees(
        applicationOwnerId(),
        request.params.projectId,
      );
      if (worktrees.length === 0) {
        const source = await repository.getProjectSource(
          applicationOwnerId(),
          request.params.projectId,
        );
        if (!source) {
          return reply.code(404).send({ error: "Project source not found." });
        }
      }
      return reply.send(projectWorktreeListSchema.parse(worktrees));
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/worktrees/reconcile",
    async (request, reply) => {
      try {
        const worktrees = await worktreeCoordinator.reconcile(
          applicationOwnerId(),
          request.params.projectId,
        );
        return worktrees
          ? reply.send(projectWorktreeListSchema.parse(worktrees))
          : reply.code(404).send({ error: "Project source not found." });
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/worktrees",
    async (request, reply) => {
      const input = projectWorktreeCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const created = await worktreeCoordinator.create(
          applicationOwnerId(),
          request.params.projectId,
          {
            mode: input.data.mode,
            name: input.data.name,
            origin: "user",
            sourceWorktreeId: input.data.sourceWorktreeId,
          },
        );
        return created
          ? reply.code(201).send(projectWorktreeSummarySchema.parse(created))
          : reply.code(404).send({ error: "Project source not found." });
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/lock",
    async (request, reply) => {
      const input = projectWorktreeLockSchema.safeParse(request.body ?? {});
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const worktree = await worktreeCoordinator.serialize(
          request.params.projectId,
          async () => {
            const context = await repository.getProjectWorktreeContext(
              applicationOwnerId(),
              request.params.projectId,
              request.params.worktreeId,
            );
            if (!context) return null;
            const result = worktreeMutationResultSchema.parse(
              await bridge.request(context.workerId, {
                type: "worktree.lock",
                sourcePath: context.sourcePath,
                worktreePath: context.worktree.path,
                reason: input.data.reason,
              }),
            );
            const reconciled = await repository.reconcileProjectWorktrees(
              applicationOwnerId(),
              request.params.projectId,
              context.workerId,
              result.inventory,
            );
            return (
              reconciled?.find(
                (item) => item.id === request.params.worktreeId,
              ) ?? null
            );
          },
        );
        return worktree
          ? reply.send(projectWorktreeSummarySchema.parse(worktree))
          : reply.code(404).send({ error: "Worktree not found." });
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/unlock",
    async (request, reply) => {
      try {
        const worktree = await worktreeCoordinator.serialize(
          request.params.projectId,
          async () => {
            const context = await repository.getProjectWorktreeContext(
              applicationOwnerId(),
              request.params.projectId,
              request.params.worktreeId,
            );
            if (!context) return null;
            const result = worktreeMutationResultSchema.parse(
              await bridge.request(context.workerId, {
                type: "worktree.unlock",
                sourcePath: context.sourcePath,
                worktreePath: context.worktree.path,
              }),
            );
            const reconciled = await repository.reconcileProjectWorktrees(
              applicationOwnerId(),
              request.params.projectId,
              context.workerId,
              result.inventory,
            );
            return (
              reconciled?.find(
                (item) => item.id === request.params.worktreeId,
              ) ?? null
            );
          },
        );
        return worktree
          ? reply.send(projectWorktreeSummarySchema.parse(worktree))
          : reply.code(404).send({ error: "Worktree not found." });
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.delete<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId",
    async (request, reply) => {
      const input = projectWorktreeRemoveSchema.safeParse(request.body ?? {});
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const worktree = await worktreeCoordinator.serialize(
          request.params.projectId,
          async () => {
            const context = await repository.getProjectWorktreeContext(
              applicationOwnerId(),
              request.params.projectId,
              request.params.worktreeId,
            );
            if (!context) return null;
            if (context.worktree.isPrimary) {
              throw new Error("Primary cannot be removed as a worktree.");
            }
            if (
              context.worktree.origin === "external" &&
              !input.data.allowExternal
            ) {
              throw new Error(
                "Removing an external worktree requires explicit authorization.",
              );
            }
            const blockers = await repository.getWorktreeRemovalBlockers(
              applicationOwnerId(),
              request.params.projectId,
              request.params.worktreeId,
            );
            if (
              blockers &&
              (blockers.activeChatIds.length > 0 ||
                blockers.activeLeaseChatIds.length > 0 ||
                blockers.boundCodeTabIds.length > 0 ||
                blockers.runningTerminalIds.length > 0 ||
                blockers.workflowLeaseIds.length > 0)
            ) {
              throw new Error(
                "Stop active chats and terminals, release chat and workflow leases, and retarget or delete bound Code tabs before removal.",
              );
            }
            await retireRunConfigurationRuntimes(
              applicationOwnerId(),
              request.params.projectId,
              { worktreeId: request.params.worktreeId },
            );
            const previousState = context.worktree.lifecycleState;
            await repository.setProjectWorktreeLifecycle(
              applicationOwnerId(),
              request.params.projectId,
              request.params.worktreeId,
              "removing",
            );
            try {
              const result = worktreeRemoveResultSchema.parse(
                await bridge.request(context.workerId, {
                  type: "worktree.remove",
                  sourcePath: context.sourcePath,
                  worktreePath: context.worktree.path,
                  force: input.data.force,
                  allowExternal: input.data.allowExternal,
                }),
              );
              const reconciled = await repository.reconcileProjectWorktrees(
                applicationOwnerId(),
                request.params.projectId,
                context.workerId,
                result.inventory,
              );
              return (
                reconciled?.find(
                  (item) => item.id === request.params.worktreeId,
                ) ?? null
              );
            } catch (error) {
              await repository.setProjectWorktreeLifecycle(
                applicationOwnerId(),
                request.params.projectId,
                request.params.worktreeId,
                previousState,
              );
              throw error;
            }
          },
        );
        return worktree
          ? reply.send(projectWorktreeSummarySchema.parse(worktree))
          : reply.code(404).send({ error: "Worktree not found." });
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/worktrees/prune",
    async (request, reply) => {
      const input = projectWorktreePruneSchema.safeParse(request.body ?? {});
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const worktrees = await worktreeCoordinator.serialize(
          request.params.projectId,
          async () => {
            const source = await repository.getProjectSource(
              applicationOwnerId(),
              request.params.projectId,
              {
                isWorkerAvailable: (workerId) => bridge.isConnected(workerId),
              },
            );
            if (!source) return null;
            const result = worktreePruneResultSchema.parse(
              await bridge.request(source.workerId, {
                type: "worktree.prune",
                sourcePath: source.cwd,
                allowExternal: input.data.allowExternal,
              }),
            );
            return repository.reconcileProjectWorktrees(
              applicationOwnerId(),
              request.params.projectId,
              source.workerId,
              result.inventory,
            );
          },
        );
        return worktrees
          ? reply.send(projectWorktreeListSchema.parse(worktrees))
          : reply.code(404).send({ error: "Project source not found." });
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );
}
