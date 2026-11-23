import {
  cantripVersionSchema,
  codeGraphActionAcknowledgementSchema,
  codeGraphProjectStatusSchema,
  managedWebRuntimeActionRequestSchema,
  managedWebRuntimeActionResultSchema,
} from "@cantrip/protocol";
import {
  workerEncryptionRefreshRequestSchema,
  workerEncryptionRefreshResultSchema,
} from "@cantrip/protocol/encryption";
import type { FastifyInstance } from "fastify";

import { principalOwnerId } from "../../auth/principal.js";
import type { ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import { workerEncryptionRefreshChangesSurfaceMaterial } from "../../worker-encryption-refresh.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface WorkerMaintenanceRouteDependencies {
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  repository: Pick<ServerRepository, "getProjectWorktreeContext" | "getWorker">;
  synchronizeTerminalServicesForWorker: (workerId: string) => Promise<void>;
}

/** Registers worker encryption, CodeGraph, web runtime, and version routes. */
export function installWorkerMaintenanceRoutes(
  app: FastifyInstance,
  {
    bridge,
    repository,
    synchronizeTerminalServicesForWorker,
  }: WorkerMaintenanceRouteDependencies,
): void {
  app.post<{ Params: { workerId: string } }>(
    "/api/workers/:workerId/encryption/refresh",
    async (request, reply) => {
      const input = workerEncryptionRefreshRequestSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = principalOwnerId(request);
      const worker = await repository.getWorker(
        ownerId,
        request.params.workerId,
      );
      if (!worker) return reply.code(404).send({ error: "Worker not found." });
      if (!bridge.isConnected(request.params.workerId)) {
        return reply.code(503).send({ error: "Worker is offline." });
      }
      try {
        const result = workerEncryptionRefreshResultSchema.parse(
          await bridge.request(
            request.params.workerId,
            {
              type: "worker.encryption.refresh",
              ...input.data,
            },
            { ownerId, timeoutMs: 20_000 },
          ),
        );
        if (
          workerEncryptionRefreshChangesSurfaceMaterial({
            after: result.status,
            before: worker.encryption,
            component: input.data.component,
          })
        ) {
          await synchronizeTerminalServicesForWorker(request.params.workerId);
        }
        return reply.send(result);
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { workerId: string } }>(
    "/api/workers/:workerId/codegraph/update-check",
    async (request, reply) => {
      const ownerId = principalOwnerId(request);
      const worker = await repository.getWorker(
        ownerId,
        request.params.workerId,
      );
      if (!worker) return reply.code(404).send({ error: "Worker not found." });
      try {
        return reply
          .code(202)
          .send(
            codeGraphActionAcknowledgementSchema.parse(
              await bridge.request(
                request.params.workerId,
                { type: "codegraph.update.check" },
                { ownerId, timeoutMs: 5_000 },
              ),
            ),
          );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { workerId: string } }>(
    "/api/workers/:workerId/web-runtimes/actions",
    async (request, reply) => {
      const input = managedWebRuntimeActionRequestSchema.safeParse(
        request.body,
      );
      if (!input.success)
        return reply.code(400).send(invalidBody(input.error.issues));
      const ownerId = principalOwnerId(request);
      const worker = await repository.getWorker(
        ownerId,
        request.params.workerId,
      );
      if (!worker) return reply.code(404).send({ error: "Worker not found." });
      try {
        return reply.send(
          managedWebRuntimeActionResultSchema.parse(
            await bridge.request(
              request.params.workerId,
              { type: "web-runtime.action", ...input.data },
              { ownerId, timeoutMs: 12 * 60_000 },
            ),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  const codeGraphWorktreeContext = async (
    ownerId: string,
    projectId: string,
    worktreeId: string,
  ) => repository.getProjectWorktreeContext(ownerId, projectId, worktreeId);

  app.get<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/codegraph",
    async (request, reply) => {
      const ownerId = principalOwnerId(request);
      const context = await codeGraphWorktreeContext(
        ownerId,
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context)
        return reply.code(404).send({ error: "Worktree not found." });
      try {
        return reply.send(
          codeGraphProjectStatusSchema.parse(
            await bridge.request(
              context.workerId,
              {
                type: "codegraph.status",
                projectId: request.params.projectId,
                worktreeId: request.params.worktreeId,
                rootKind: context.worktree.rootKind,
                sourcePath: context.sourcePath,
                worktreePath: context.worktree.path,
              },
              { ownerId, timeoutMs: 5_000 },
            ),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  for (const action of ["sync", "rebuild"] as const) {
    app.post<{ Params: { projectId: string; worktreeId: string } }>(
      `/api/projects/:projectId/worktrees/:worktreeId/codegraph/${action}`,
      async (request, reply) => {
        const ownerId = principalOwnerId(request);
        const context = await codeGraphWorktreeContext(
          ownerId,
          request.params.projectId,
          request.params.worktreeId,
        );
        if (!context)
          return reply.code(404).send({ error: "Worktree not found." });
        try {
          return reply.code(202).send(
            codeGraphActionAcknowledgementSchema.parse(
              await bridge.request(
                context.workerId,
                {
                  type:
                    action === "sync" ? "codegraph.sync" : "codegraph.rebuild",
                  projectId: request.params.projectId,
                  worktreeId: request.params.worktreeId,
                  rootKind: context.worktree.rootKind,
                  sourcePath: context.sourcePath,
                  worktreePath: context.worktree.path,
                },
                { ownerId, timeoutMs: 5_000 },
              ),
            ),
          );
        } catch (error) {
          return sendWorkerRequestFailure(reply, error);
        }
      },
    );
  }

  app.get<{ Params: { workerId: string } }>(
    "/api/workers/:workerId/version",
    { logLevel: "warn" },
    async (request, reply) => {
      const ownerId = principalOwnerId(request);
      const worker = await repository.getWorker(
        ownerId,
        request.params.workerId,
      );
      if (!worker) {
        return reply.code(404).send({ error: "Worker not found." });
      }
      if (!bridge.isConnected(request.params.workerId)) {
        return reply.code(503).send({ error: "Worker is offline." });
      }
      try {
        const version = await bridge.request(request.params.workerId, {
          type: "worker.version",
        });
        return reply.send(cantripVersionSchema.parse(version));
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );
}
