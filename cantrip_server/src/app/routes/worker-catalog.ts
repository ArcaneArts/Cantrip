import { workerListSchema } from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import { principalOwnerId } from "../../auth/principal.js";
import type { ServerRepository } from "../../db/repository.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface WorkerCatalogRouteDependencies {
  bridge: WorkerCommandBus;
  repository: ServerRepository;
}

export function installWorkerCatalogRoutes(
  app: FastifyInstance,
  { bridge, repository }: WorkerCatalogRouteDependencies,
): void {
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
