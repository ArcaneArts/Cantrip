import {
  encryptedRemoteDesktopCreateSchema,
  encryptedRemoteDesktopUpdateSchema,
  remoteDesktopProbeResultSchema,
  remoteDesktopWireSummarySchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import {
  ExecutionPlacementUnavailableError,
  SurfacePrivateStateConflictError,
  type ServerRepository,
} from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface RemoteDesktopManagementRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  repository: Pick<
    ServerRepository,
    | "createRemoteDesktop"
    | "getRemoteDesktop"
    | "getRemoteSurfaceExecutionContext"
    | "resolveProjectExecutionPlacement"
    | "updateRemoteSurface"
  >;
  serverId: string;
  updateRemoteSurfaceStatus: (
    surfaceId: string,
    status: Parameters<ServerRepository["setRemoteSurfaceStatus"]>[1],
    error?: string | null,
  ) => ReturnType<ServerRepository["setRemoteSurfaceStatus"]>;
}

/** Registers managed Remote Desktop mutation routes. */
export function installRemoteDesktopManagementRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    repository,
    serverId,
    updateRemoteSurfaceStatus,
  }: RemoteDesktopManagementRouteDependencies,
): void {
  app.patch<{ Params: { desktopId: string } }>(
    "/api/remote-desktops/:desktopId",
    async (request, reply) => {
      const input = encryptedRemoteDesktopUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getRemoteSurfaceExecutionContext(
        applicationOwnerId(),
        request.params.desktopId,
      );
      if (!context || context.surface.kind !== "desktop") {
        return reply.code(404).send({ error: "Remote Desktop not found." });
      }
      let updated;
      try {
        updated = await repository.updateRemoteSurface(
          applicationOwnerId(),
          context.surface.id,
          {
            expectedStateRevision: input.data.expectedStateRevision,
            stateProtection: input.data.stateProtection,
          },
        );
      } catch (error) {
        if (error instanceof SurfacePrivateStateConflictError) {
          return reply.code(409).send({
            code: "stale-state",
            error: "Remote Desktop state changed before this update.",
          });
        }
        throw error;
      }
      if (!updated) {
        return reply.code(404).send({ error: "Remote Desktop not found." });
      }
      if (bridge.isConnected(context.workerId)) {
        try {
          await bridge.request(
            context.workerId,
            {
              type: "surface.configure",
              surfaceId: context.surface.id,
              serverId,
              configuration: { kind: "desktop" },
              stateResource: "remote-desktop-row",
              stateRevision: updated.stateRevision,
              stateProtection: updated.stateProtection,
            },
            { timeoutMs: 20_000 },
          );
        } catch (error) {
          await updateRemoteSurfaceStatus(
            context.surface.id,
            "error",
            "The worker could not apply the encrypted Remote Desktop target.",
          );
        }
      } else {
        await updateRemoteSurfaceStatus(
          context.surface.id,
          "offline",
          "Worker is offline. The saved encrypted target will be restored when it reconnects.",
        );
      }
      const desktop = await repository.getRemoteDesktop(
        applicationOwnerId(),
        context.surface.id,
      );
      return desktop
        ? reply.send(remoteDesktopWireSummarySchema.parse(desktop))
        : reply.code(404).send({ error: "Remote Desktop not found." });
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/remote-desktops",
    async (request, reply) => {
      const input = encryptedRemoteDesktopCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      let workerId: string;
      try {
        workerId = (
          await repository.resolveProjectExecutionPlacement(
            applicationOwnerId(),
            request.params.projectId,
            "remote-desktop",
            input.data.target,
            (workerId) => bridge.isConnected(workerId),
          )
        ).placement.workerId;
      } catch (error) {
        if (error instanceof ExecutionPlacementUnavailableError) {
          return reply
            .code(error.code === "project-not-found" ? 404 : 409)
            .send({ code: error.code, error: error.message });
        }
        throw error;
      }
      if (!bridge.isConnected(workerId)) {
        return reply.code(409).send({
          code: "worker-offline",
          error: "The selected worker is offline.",
        });
      }

      try {
        const probe = remoteDesktopProbeResultSchema.parse(
          await bridge.request(
            workerId,
            { type: "surface.desktop.probe" },
            { timeoutMs: 20_000 },
          ),
        );
        if (!probe.available) {
          return reply.code(409).send({
            error:
              probe.message ??
              "The project worker could not start managed Remote Desktop.",
          });
        }
        const desktop = await repository.createRemoteDesktop(
          applicationOwnerId(),
          request.params.projectId,
          input.data.id,
          input.data.titleProtection,
          workerId,
          input.data.stateProtection,
          input.data.tabGroupId,
        );
        if (!desktop) {
          return reply
            .code(404)
            .send({ error: "Project or worker not found." });
        }
        return reply
          .code(201)
          .send(remoteDesktopWireSummarySchema.parse(desktop));
      } catch (error) {
        return reply.code(502).send({ error: errorMessage(error) });
      }
    },
  );
}
