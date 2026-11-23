import {
  workerListSchema,
  workerInferenceStatusSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import { principalOwnerId } from "../../auth/principal.js";
import type { ServerRepository } from "../../db/repository.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface WorkerCatalogRouteDependencies {
  bridge: WorkerCommandBus;
  repository: ServerRepository;
  serverId: string;
}

export function installWorkerCatalogRoutes(
  app: FastifyInstance,
  { bridge, repository, serverId }: WorkerCatalogRouteDependencies,
): void {
  app.get<{ Params: { workerId: string } }>(
    "/api/workers/:workerId/inference",
    { logLevel: "warn" },
    async (request, reply) => {
      const ownerId = principalOwnerId(request);
      const workerId = request.params.workerId;
      if (
        !(await repository.listWorkers(ownerId)).some(
          (w) => w.workerId === workerId,
        )
      )
        return reply.code(404).send({ error: "Worker not found." });
      const identity = bridge.connectionIdentity?.(workerId);
      const status = workerInferenceStatusSchema.parse(
        await bridge.request(
          workerId,
          { type: "inference.status" },
          { ownerId, timeoutMs: 15_000 },
        ),
      );
      const current = bridge.connectionIdentity?.(workerId);
      // Fence an old HTTP response against an actual replacement peer.
      if (
        !identity ||
        !current ||
        !bridge.isConnected(workerId) ||
        current.ownerId !== ownerId ||
        status.ownerId !== ownerId ||
        status.serverId !== serverId ||
        status.workerId !== workerId ||
        status.workerGeneration !== identity.workerProcessGeneration ||
        status.workerGeneration !== current.workerProcessGeneration
      )
        return reply.code(409).send({
          error: "Worker inference status changed. Retry the snapshot.",
        });
      return reply.header("cache-control", "private, no-store").send(status);
    },
  );
  app.get("/api/workers", { logLevel: "warn" }, async (request, reply) => {
    const workers = (
      await repository.listWorkers(principalOwnerId(request))
    ).map((worker) => ({
      ...worker,
      online: bridge.isConnected(worker.workerId),
    }));
    return reply.send(workerListSchema.parse(workers));
  });
}
