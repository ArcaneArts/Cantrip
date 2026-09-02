import {
  browserServiceFleetDiscoverySchema,
  browserServiceListSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { errorMessage } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import { projectAllowsExecutionOnWorker } from "../../projects/worker-affinity.js";
import {
  type WorkerCommandBus,
  WorkerUnavailableError,
} from "../../workers/bridge.js";
import {
  BROWSER_FLEET_DISCOVERY_SERVICE_LIMIT,
  BROWSER_FLEET_DISCOVERY_TIMEOUT_MS,
  BROWSER_FLEET_DISCOVERY_WORKER_LIMIT,
} from "../shared/constants.js";

export interface BrowserServiceDiscoveryRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  repository: Pick<
    ServerRepository,
    "getProject" | "getRemoteSurfaceExecutionContext" | "listWorkers"
  >;
}

/** Registers project-fleet and existing-browser service discovery routes. */
export function installBrowserServiceDiscoveryRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    repository,
  }: BrowserServiceDiscoveryRouteDependencies,
): void {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/browser-services",
    async (request, reply) => {
      const ownerId = applicationOwnerId();
      const project = await repository.getProject(
        ownerId,
        request.params.projectId,
      );
      if (!project) {
        return reply.code(404).send({ error: "Project not found." });
      }
      const capableWorkers = (await repository.listWorkers(ownerId))
        .filter(
          (worker) =>
            worker.remoteSurfaces.browser &&
            projectAllowsExecutionOnWorker(project, worker.workerId),
        )
        .sort(
          (left, right) =>
            left.name.localeCompare(right.name) ||
            left.workerId.localeCompare(right.workerId),
        );
      const fleetTruncated =
        capableWorkers.length > BROWSER_FLEET_DISCOVERY_WORKER_LIMIT;
      const workerResults = await Promise.all(
        capableWorkers
          .slice(0, BROWSER_FLEET_DISCOVERY_WORKER_LIMIT)
          .map(async (worker) => {
            const workerName = worker.name.slice(0, 200);
            if (!worker.online || !bridge.isConnected(worker.workerId)) {
              return {
                workerId: worker.workerId,
                workerName,
                status: "offline" as const,
                services: [],
                error: {
                  code: "worker-offline" as const,
                  message: `${workerName} is offline.`,
                },
                truncated: false,
              };
            }
            try {
              const response = await bridge.request(
                worker.workerId,
                { type: "browser.services.discover" },
                { timeoutMs: BROWSER_FLEET_DISCOVERY_TIMEOUT_MS },
              );
              const services = browserServiceListSchema.parse(response);
              return {
                workerId: worker.workerId,
                workerName,
                status: "ok" as const,
                services: services.map((service) => ({
                  ...service,
                  workerId: worker.workerId,
                  workerName,
                  placement: {
                    projectId: request.params.projectId,
                    workerId: worker.workerId,
                    projectReplicaId: null,
                    worktreeId: null,
                    surface: null,
                  },
                })),
                error: null,
                truncated: false,
              };
            } catch (error) {
              const message = errorMessage(error).slice(0, 1_000);
              const unavailable = error instanceof WorkerUnavailableError;
              const timedOut = /timed out/iu.test(message);
              return {
                workerId: worker.workerId,
                workerName,
                status: unavailable
                  ? ("offline" as const)
                  : timedOut
                    ? ("timed-out" as const)
                    : ("error" as const),
                services: [],
                error: {
                  code: unavailable
                    ? ("worker-offline" as const)
                    : timedOut
                      ? ("worker-timeout" as const)
                      : ("worker-error" as const),
                  message: message || `Could not scan ${workerName}.`,
                },
                truncated: false,
              };
            }
          }),
      );
      let remainingServices = BROWSER_FLEET_DISCOVERY_SERVICE_LIMIT;
      let serviceTruncated = false;
      const boundedResults = workerResults.map((result) => {
        const services = result.services.slice(0, remainingServices);
        remainingServices -= services.length;
        const truncated = services.length < result.services.length;
        serviceTruncated ||= truncated;
        return { ...result, services, truncated };
      });
      const truncated = fleetTruncated || serviceTruncated;
      return reply.send(
        browserServiceFleetDiscoverySchema.parse({
          projectId: request.params.projectId,
          observedAt: new Date().toISOString(),
          partial:
            truncated ||
            boundedResults.some((result) => result.status !== "ok"),
          truncated,
          workers: boundedResults,
        }),
      );
    },
  );

  app.get<{ Params: { browserId: string } }>(
    "/api/browsers/:browserId/services",
    async (request, reply) => {
      const context = await repository.getRemoteSurfaceExecutionContext(
        applicationOwnerId(),
        request.params.browserId,
      );
      if (!context || context.surface.kind !== "browser") {
        return reply.code(404).send({ error: "Browser not found." });
      }
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        const services = await bridge.request(
          context.workerId,
          { type: "browser.services.discover" },
          { timeoutMs: 20_000 },
        );
        const discovered = browserServiceListSchema.parse(services);
        return reply.send(
          browserServiceListSchema.parse(
            discovered.map((service) => ({
              ...service,
              workerId: context.workerId,
            })),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );
}
