import {
  encryptedRemoteSurfaceCreateSchema,
  encryptedRemoteSurfaceUpdateSchema,
  remoteSurfaceWireListSchema,
  remoteSurfaceWireSummarySchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import {
  ExecutionPlacementUnavailableError,
  SurfacePrivateStateConflictError,
  type ServerRepository,
} from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import type { WorkerLinkService } from "../../worker-links/service.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface RemoteSurfaceManagementRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  repository: Pick<
    ServerRepository,
    | "createRemoteSurface"
    | "deleteRemoteSurface"
    | "getRemoteSurfaceExecutionContext"
    | "listRemoteSurfaces"
    | "resolveProjectExecutionPlacement"
    | "updateRemoteSurface"
  >;
  updateRemoteSurfaceStatus: (
    surfaceId: string,
    status: Parameters<ServerRepository["setRemoteSurfaceStatus"]>[1],
    error?: string | null,
  ) => ReturnType<ServerRepository["setRemoteSurfaceStatus"]>;
  workerLinks: Pick<WorkerLinkService, "revokeResource">;
}

/** Registers generic Remote Surface HTTP routes before the WebSocket relay. */
export function installRemoteSurfaceManagementRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    repository,
    updateRemoteSurfaceStatus,
    workerLinks,
  }: RemoteSurfaceManagementRouteDependencies,
): void {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/remote-surfaces",
    async (request, reply) =>
      reply.send(
        remoteSurfaceWireListSchema.parse(
          await repository.listRemoteSurfaces(
            applicationOwnerId(),
            request.params.projectId,
          ),
        ),
      ),
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/remote-surfaces",
    async (request, reply) => {
      const input = encryptedRemoteSurfaceCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      if (input.data.configuration.kind === "desktop") {
        return reply.code(400).send({
          error:
            "Create desktop surfaces through the managed Remote Desktop endpoint.",
        });
      }
      try {
        await repository.resolveProjectExecutionPlacement(
          applicationOwnerId(),
          request.params.projectId,
          "browser",
          {
            kind: "worker",
            projectId: request.params.projectId,
            workerId: input.data.workerId,
          },
          (workerId) => bridge.isConnected(workerId),
        );
      } catch (error) {
        if (error instanceof ExecutionPlacementUnavailableError) {
          return reply
            .code(error.code === "project-not-found" ? 404 : 409)
            .send({ code: error.code, error: error.message });
        }
        throw error;
      }
      const surface = await repository.createRemoteSurface(
        applicationOwnerId(),
        request.params.projectId,
        input.data,
      );
      return surface
        ? reply.code(201).send(remoteSurfaceWireSummarySchema.parse(surface))
        : reply.code(404).send({ error: "Project or worker not found." });
    },
  );

  app.patch<{ Params: { surfaceId: string } }>(
    "/api/remote-surfaces/:surfaceId",
    async (request, reply) => {
      const input = encryptedRemoteSurfaceUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      if (input.data.configuration?.kind === "desktop") {
        return reply.code(400).send({
          error:
            "Desktop surface configuration is managed by the project worker.",
        });
      }
      try {
        const surface = await repository.updateRemoteSurface(
          applicationOwnerId(),
          request.params.surfaceId,
          input.data,
        );
        return surface
          ? reply.send(remoteSurfaceWireSummarySchema.parse(surface))
          : reply.code(404).send({ error: "Remote Surface not found." });
      } catch (error) {
        if (error instanceof SurfacePrivateStateConflictError) {
          return reply.code(409).send({
            code: "stale-state",
            error: "Remote Surface state changed before this update.",
          });
        }
        throw error;
      }
    },
  );

  for (const action of ["suspend", "resume"] as const) {
    app.post<{ Params: { surfaceId: string } }>(
      `/api/remote-surfaces/:surfaceId/${action}`,
      async (request, reply) => {
        const context = await repository.getRemoteSurfaceExecutionContext(
          applicationOwnerId(),
          request.params.surfaceId,
        );
        if (!context) {
          return reply.code(404).send({ error: "Remote Surface not found." });
        }
        if (!bridge.isConnected(context.workerId)) {
          await updateRemoteSurfaceStatus(
            context.surface.id,
            "offline",
            "Worker is offline.",
          );
          return reply.code(503).send({ error: "Worker is offline." });
        }
        try {
          await bridge.request(context.workerId, {
            type: action === "suspend" ? "surface.suspend" : "surface.resume",
            surfaceId: context.surface.id,
          });
          await updateRemoteSurfaceStatus(
            context.surface.id,
            action === "suspend" ? "suspended" : "active",
          );
          const updated = await repository.getRemoteSurfaceExecutionContext(
            applicationOwnerId(),
            context.surface.id,
          );
          return updated
            ? reply.send(remoteSurfaceWireSummarySchema.parse(updated.surface))
            : reply.code(404).send({
                error: "Remote Surface was removed during the request.",
              });
        } catch (error) {
          return reply.code(502).send({ error: errorMessage(error) });
        }
      },
    );
  }

  app.delete<{ Params: { surfaceId: string } }>(
    "/api/remote-surfaces/:surfaceId",
    async (request, reply) => {
      const context = await repository.deleteRemoteSurface(
        applicationOwnerId(),
        request.params.surfaceId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Remote Surface not found." });
      }
      await workerLinks.revokeResource(
        applicationOwnerId(),
        context.surface.kind === "browser" ? "browser" : "remote-desktop",
        context.surface.id,
        "resource-deleted",
      );
      if (bridge.isConnected(context.workerId)) {
        void bridge
          .request(context.workerId, {
            type: "surface.close",
            surfaceId: context.surface.id,
          })
          .catch((error) => {
            app.log.warn(
              { err: error, surfaceId: context.surface.id },
              "Could not close deleted Remote Surface",
            );
          });
      }
      return reply.code(204).send();
    },
  );
}
