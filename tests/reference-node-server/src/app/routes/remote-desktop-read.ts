import { randomUUID } from "node:crypto";

import {
  remoteDesktopFleetWireSchema,
  remoteDesktopProtectedInventorySchema,
  remoteDesktopWireListSchema,
  remoteDesktopWireSummarySchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { errorMessage } from "../../http/request-helpers.js";
import { projectAllowsExecutionOnWorker } from "../../projects/worker-affinity.js";
import {
  type WorkerCommandBus,
  WorkerUnavailableError,
} from "../../workers/bridge.js";
import {
  REMOTE_DESKTOP_FLEET_SURFACE_LIMIT,
  REMOTE_DESKTOP_FLEET_TARGET_LIMIT,
  REMOTE_DESKTOP_FLEET_TIMEOUT_MS,
  REMOTE_DESKTOP_FLEET_WORKER_LIMIT,
} from "../shared/constants.js";

export interface RemoteDesktopReadRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  repository: Pick<
    ServerRepository,
    "getProject" | "getRemoteDesktop" | "listRemoteDesktops" | "listWorkers"
  >;
  serverId: string;
}

/** Registers Remote Desktop list, fleet-discovery, and detail reads. */
export function installRemoteDesktopReadRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    repository,
    serverId,
  }: RemoteDesktopReadRouteDependencies,
): void {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/remote-desktops",
    async (request, reply) =>
      reply.send(
        remoteDesktopWireListSchema.parse(
          await repository.listRemoteDesktops(
            applicationOwnerId(),
            request.params.projectId,
          ),
        ),
      ),
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/remote-desktop-fleet",
    async (request, reply) => {
      const ownerId = applicationOwnerId();
      const project = await repository.getProject(
        ownerId,
        request.params.projectId,
      );
      if (!project) {
        return reply.code(404).send({ error: "Project not found." });
      }
      const [workers, desktops] = await Promise.all([
        repository.listWorkers(ownerId),
        repository.listRemoteDesktops(ownerId, request.params.projectId),
      ]);
      const capableWorkers = workers
        .filter(
          (worker) =>
            worker.remoteSurfaces.desktop &&
            projectAllowsExecutionOnWorker(project, worker.workerId),
        )
        .sort(
          (left, right) =>
            left.name.localeCompare(right.name) ||
            left.workerId.localeCompare(right.workerId),
        );
      const fleetTruncated =
        capableWorkers.length > REMOTE_DESKTOP_FLEET_WORKER_LIMIT;
      const inspectedWorkers = capableWorkers.slice(
        0,
        REMOTE_DESKTOP_FLEET_WORKER_LIMIT,
      );
      const targetLimitPerWorker = inspectedWorkers.length
        ? Math.floor(
            REMOTE_DESKTOP_FLEET_TARGET_LIMIT / inspectedWorkers.length,
          )
        : 0;
      const results = await Promise.all(
        inspectedWorkers.map(async (worker) => {
          const workerName = worker.name.slice(0, 200);
          const workerDesktops = desktops.filter(
            (desktop) => desktop.workerId === worker.workerId,
          );
          const base = {
            workerId: worker.workerId,
            workerName,
            platform: worker.platform.slice(0, 100),
            architecture: worker.architecture.slice(0, 100),
            desktops: workerDesktops,
          };
          if (!worker.online || !bridge.isConnected(worker.workerId)) {
            return {
              ...base,
              status: "offline" as const,
              inventoryOperationId: null,
              inventoryProtection: null,
              monitorCount: 0,
              windowCount: 0,
              truncated: false,
              error: {
                code: "worker-offline" as const,
                message: `${workerName} is offline.`,
              },
            };
          }
          try {
            const operationId = randomUUID();
            const inventory = remoteDesktopProtectedInventorySchema.parse(
              await bridge.request(
                worker.workerId,
                {
                  type: "surface.desktop.targets",
                  serverId,
                  operationId,
                  resourceId: worker.workerId,
                  limit: targetLimitPerWorker,
                },
                { timeoutMs: REMOTE_DESKTOP_FLEET_TIMEOUT_MS },
              ),
            );
            return {
              ...base,
              status: "ok" as const,
              inventoryOperationId: inventory.operationId,
              inventoryProtection: inventory.stateProtection,
              monitorCount: inventory.monitorCount,
              windowCount: inventory.windowCount,
              truncated: inventory.truncated,
              error: null,
            };
          } catch (error) {
            const message = errorMessage(error).slice(0, 1_000);
            const unavailable = error instanceof WorkerUnavailableError;
            const timedOut = /timed out/iu.test(message);
            return {
              ...base,
              status: unavailable
                ? ("offline" as const)
                : timedOut
                  ? ("timed-out" as const)
                  : ("error" as const),
              inventoryOperationId: null,
              inventoryProtection: null,
              monitorCount: 0,
              windowCount: 0,
              truncated: false,
              error: {
                code: unavailable
                  ? ("worker-offline" as const)
                  : timedOut
                    ? ("worker-timeout" as const)
                    : ("worker-error" as const),
                message: unavailable
                  ? `${workerName} is offline.`
                  : timedOut
                    ? `Timed out inspecting ${workerName}.`
                    : `Could not inspect ${workerName}.`,
              },
            };
          }
        }),
      );
      let targetTruncated = false;
      let surfaceTruncated = false;
      const boundedWorkers = results.map((result) => {
        const targetWasTruncated = result.truncated;
        const boundedDesktops = result.desktops.slice(
          0,
          REMOTE_DESKTOP_FLEET_SURFACE_LIMIT,
        );
        const surfaceWasTruncated =
          boundedDesktops.length < result.desktops.length;
        targetTruncated ||= targetWasTruncated;
        surfaceTruncated ||= surfaceWasTruncated;
        return {
          ...result,
          desktops: boundedDesktops,
          truncated: targetWasTruncated || surfaceWasTruncated,
        };
      });
      const truncated = fleetTruncated || targetTruncated || surfaceTruncated;
      return reply.send(
        remoteDesktopFleetWireSchema.parse({
          projectId: request.params.projectId,
          observedAt: new Date().toISOString(),
          partial:
            truncated ||
            boundedWorkers.some((worker) => worker.status !== "ok"),
          truncated,
          workers: boundedWorkers,
        }),
      );
    },
  );

  app.get<{ Params: { desktopId: string } }>(
    "/api/remote-desktops/:desktopId",
    async (request, reply) => {
      const desktop = await repository.getRemoteDesktop(
        applicationOwnerId(),
        request.params.desktopId,
      );
      return desktop
        ? reply.send(remoteDesktopWireSummarySchema.parse(desktop))
        : reply.code(404).send({ error: "Remote Desktop not found." });
    },
  );
}
