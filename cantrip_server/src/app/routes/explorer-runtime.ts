import {
  encryptedExplorerWorktreeUpdateSchema,
  explorerWireSummarySchema,
  explorerOperationWireRequestSchema,
  surfaceStreamWireResponseSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface ExplorerWorktreeRouteDependencies {
  applicationOwnerId: () => string;
  repository: Pick<
    ServerRepository,
    "getExplorerExecutionContext" | "updateExplorerWorktree"
  >;
  requireProjectWorktrees: (projectId: string) => Promise<unknown>;
}

export interface ExplorerDeleteRouteDependencies {
  applicationOwnerId: () => string;
  repository: Pick<ServerRepository, "deleteExplorer">;
}

export interface ExplorerOperationRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "request">;
  repository: Pick<ServerRepository, "getExplorerExecutionContext">;
  serverId: string;
}

/** Registers Explorer retargeting before view-state mutations. */
export function installExplorerWorktreeRoute(
  app: FastifyInstance,
  {
    applicationOwnerId,
    repository,
    requireProjectWorktrees,
  }: ExplorerWorktreeRouteDependencies,
): void {
  app.patch<{ Params: { explorerId: string } }>(
    "/api/explorers/:explorerId/worktree",
    async (request, reply) => {
      const input = encryptedExplorerWorktreeUpdateSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = applicationOwnerId();
      const context = await repository.getExplorerExecutionContext(
        ownerId,
        request.params.explorerId,
      );
      if (context) await requireProjectWorktrees(context.projectId);
      const explorer = await repository.updateExplorerWorktree(
        ownerId,
        request.params.explorerId,
        input.data,
      );
      return explorer
        ? reply.send(explorerWireSummarySchema.parse(explorer))
        : reply.code(404).send({ error: "Explorer or worktree not found." });
    },
  );
}

/** Registers Explorer deletion after view-state mutations. */
export function installExplorerDeleteRoute(
  app: FastifyInstance,
  { applicationOwnerId, repository }: ExplorerDeleteRouteDependencies,
): void {
  app.delete<{ Params: { explorerId: string } }>(
    "/api/explorers/:explorerId",
    async (request, reply) => {
      const ownerId = applicationOwnerId();
      return (await repository.deleteExplorer(
        ownerId,
        request.params.explorerId,
      ))
        ? reply.code(204).send()
        : reply.code(404).send({ error: "Explorer not found." });
    },
  );
}

/** Registers the worker-backed Explorer operation relay after attachments. */
export function installExplorerOperationRoute(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    repository,
    serverId,
  }: ExplorerOperationRouteDependencies,
): void {
  app.post<{ Params: { explorerId: string } }>(
    "/api/explorers/:explorerId/operation",
    { bodyLimit: 4 * 1_024 * 1_024 },
    async (request, reply) => {
      const input = explorerOperationWireRequestSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getExplorerExecutionContext(
        applicationOwnerId(),
        request.params.explorerId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Explorer not found." });
      }
      const { binding, ...operation } = input.data;
      if (
        binding &&
        (binding.workerId !== context.workerId ||
          binding.projectId !== context.projectId ||
          binding.worktreeId !== context.worktreeId)
      ) {
        return reply.code(409).send({
          error:
            "This Explorer moved to another checkout. Reopen the file there; your draft has not been saved.",
        });
      }
      try {
        const result = await bridge.request(context.workerId, {
          type: "explorer.operation",
          explorerId: context.explorerId,
          serverId,
          root: context.root,
          ...operation,
        });
        return reply.send(surfaceStreamWireResponseSchema.parse(result));
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );
}
