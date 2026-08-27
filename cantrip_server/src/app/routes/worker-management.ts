import {
  workerManagementListSchema,
  workerRestartAcknowledgementSchema,
  workerRestartResultSchema,
  workerUpdateSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import { principalOwnerId } from "../../auth/principal.js";
import type { ServerConfig } from "../../config.js";
import type { ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { serverLogger } from "../../logger.js";
import {
  type WorkerCommandBus,
  WorkerUnavailableError,
} from "../../workers/bridge.js";
import { developmentWorkerBootstrapAllowed } from "../../workers/credentials.js";

export interface WorkerManagementRouteDependencies {
  bridge: WorkerCommandBus;
  config: ServerConfig;
  markCredentialRevoked: (credentialId: string) => void;
  publishWorkerAvailability: (workerId: string) => void;
  repository: ServerRepository;
}

export function installWorkerManagementRoutes(
  app: FastifyInstance,
  {
    bridge,
    config,
    markCredentialRevoked,
    publishWorkerAvailability,
    repository,
  }: WorkerManagementRouteDependencies,
): void {
  app.get(
    "/api/workers/management",
    { logLevel: "warn" },
    async (request, reply) => {
      const ownerId = principalOwnerId(request);
      const records = await repository.listWorkerManagement(ownerId);
      const localBootstrap = developmentWorkerBootstrapAllowed(config);
      return reply.send(
        workerManagementListSchema.parse(
          records.map((record) => {
            const internal = localBootstrap && record.credentialCount === 0;
            return {
              ...record.worker,
              runtimeName: record.runtimeName,
              internal,
              editable: !internal,
              removable: !internal,
              credentialCount: record.credentialCount,
              activeCredentialCount: record.activeCredentialCount,
              sources: record.sources,
            };
          }),
        ),
      );
    },
  );

  app.post<{ Params: { workerId: string } }>(
    "/api/workers/:workerId/restart",
    { logLevel: "warn" },
    async (request, reply) => {
      const ownerId = principalOwnerId(request);
      const record = (await repository.listWorkerManagement(ownerId)).find(
        ({ worker }) => worker.workerId === request.params.workerId,
      );
      if (!record) {
        return reply.code(404).send({ error: "Worker not found." });
      }
      try {
        workerRestartAcknowledgementSchema.parse(
          await bridge.request(
            request.params.workerId,
            { type: "worker.restart" },
            { ownerId, timeoutMs: 10_000 },
          ),
        );
      } catch (error) {
        if (error instanceof WorkerUnavailableError) {
          return reply
            .code(409)
            .send({ error: "The worker is offline and cannot be restarted." });
        }
        throw error;
      }
      serverLogger.info("Worker restart requested", {
        event: "worker.runtime.restart-requested",
        subsystem: "worker-command",
        operation: "worker.restart",
        status: "accepted",
        requestId: request.id,
        workerId: request.params.workerId,
      });
      return reply.code(202).send(
        workerRestartResultSchema.parse({
          workerId: request.params.workerId,
          status: "restarting",
        }),
      );
    },
  );

  app.patch<{ Params: { workerId: string } }>(
    "/api/workers/:workerId",
    { logLevel: "warn" },
    async (request, reply) => {
      const input = workerUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = principalOwnerId(request);
      const record = (await repository.listWorkerManagement(ownerId)).find(
        ({ worker }) => worker.workerId === request.params.workerId,
      );
      if (!record) {
        return reply.code(404).send({ error: "Worker not found." });
      }
      if (
        developmentWorkerBootstrapAllowed(config) &&
        record.credentialCount === 0
      ) {
        return reply
          .code(409)
          .send({ error: "The internal worker cannot be renamed." });
      }
      const worker = await repository.updateWorkerDisplayName(
        ownerId,
        request.params.workerId,
        input.data.name,
      );
      return worker
        ? reply.send(worker)
        : reply.code(404).send({ error: "Worker not found." });
    },
  );

  app.delete<{ Params: { workerId: string } }>(
    "/api/workers/:workerId",
    { logLevel: "warn" },
    async (request, reply) => {
      const ownerId = principalOwnerId(request);
      const record = (await repository.listWorkerManagement(ownerId)).find(
        ({ worker }) => worker.workerId === request.params.workerId,
      );
      if (!record) {
        return reply.code(404).send({ error: "Worker not found." });
      }
      if (
        developmentWorkerBootstrapAllowed(config) &&
        record.credentialCount === 0
      ) {
        return reply
          .code(409)
          .send({ error: "The internal worker cannot be unlinked." });
      }
      const credentials = await repository.listWorkerCredentials(
        ownerId,
        request.params.workerId,
      );
      if (!(await repository.unlinkWorker(ownerId, request.params.workerId))) {
        return reply.code(404).send({ error: "Worker not found." });
      }
      for (const credential of credentials ?? []) {
        if (credential.active) markCredentialRevoked(credential.id);
      }
      bridge.disconnect?.(request.params.workerId, "Worker was unlinked");
      publishWorkerAvailability(request.params.workerId);
      serverLogger.info("Worker unlinked", {
        event: "worker.enrollment.unlinked",
        subsystem: "worker-auth",
        operation: "unlink",
        status: "completed",
        requestId: request.id,
        workerId: request.params.workerId,
        counts: { credentials: credentials?.length ?? 0 },
      });
      return reply.code(204).send();
    },
  );
}
