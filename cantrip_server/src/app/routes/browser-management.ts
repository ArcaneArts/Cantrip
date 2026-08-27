import {
  browserTunnelWireRequestSchema,
  browserWireListSchema,
  browserWireSummarySchema,
  encryptedBrowserCreateSchema,
  encryptedBrowserUpdateSchema,
  tunnelWireSummarySchema,
  type EncryptedBrowserUpdate,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import {
  ExecutionPlacementUnavailableError,
  SurfacePrivateStateConflictError,
  TunnelManagementError,
  type ServerRepository,
} from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import type { TunnelRuntimeManager } from "../../tunnels/runtime.js";
import type { WorkerLinkService } from "../../worker-links/service.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface BrowserListRouteDependencies {
  applicationOwnerId: () => string;
  repository: Pick<ServerRepository, "listBrowsers">;
}

export interface BrowserManagementRouteDependencies {
  applicationOwnerId: () => string;
  applyBrowserUpdate: (
    ownerId: string,
    browserId: string,
    input: EncryptedBrowserUpdate,
  ) => ReturnType<ServerRepository["updateBrowser"]>;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  repository: Pick<
    ServerRepository,
    | "createBrowser"
    | "deleteBrowser"
    | "getManagedTunnel"
    | "getProject"
    | "getRemoteSurfaceExecutionContext"
    | "listWorkers"
    | "registerManagedTunnel"
    | "removeManagedTunnel"
  >;
  tunnelRuntime: Pick<TunnelRuntimeManager, "revoke">;
  workerLinks: Pick<WorkerLinkService, "revokeResource">;
}

/** Registers the project Browser inventory at its original early phase. */
export function installBrowserListRoute(
  app: FastifyInstance,
  { applicationOwnerId, repository }: BrowserListRouteDependencies,
): void {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/browsers",
    async (request, reply) =>
      reply.send(
        browserWireListSchema.parse(
          await repository.listBrowsers(
            applicationOwnerId(),
            request.params.projectId,
          ),
        ),
      ),
  );
}

/** Registers Browser tunnel and mutation routes after service discovery. */
export function installBrowserManagementRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    applyBrowserUpdate,
    bridge,
    repository,
    tunnelRuntime,
    workerLinks,
  }: BrowserManagementRouteDependencies,
): void {
  app.post<{ Params: { browserId: string } }>(
    "/api/browsers/:browserId/tunnel",
    async (request, reply) => {
      const input = browserTunnelWireRequestSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = applicationOwnerId();
      const context = await repository.getRemoteSurfaceExecutionContext(
        ownerId,
        request.params.browserId,
      );
      if (!context || context.surface.kind !== "browser") {
        return reply.code(404).send({ error: "Browser not found." });
      }
      const workerId = input.data.workerId;
      const project = await repository.getProject(
        ownerId,
        context.surface.projectId,
      );
      if (
        project?.originKind === "managed-folder" &&
        workerId !== project.preferredWorkerId
      ) {
        return reply.code(409).send({
          code: "target-mismatch",
          error: "This worker-managed folder is bound to its owning worker.",
        });
      }
      const workerOwned = (await repository.listWorkers(ownerId)).some(
        (worker) => worker.workerId === workerId,
      );
      if (!workerOwned) {
        return reply.code(404).send({ error: "Destination worker not found." });
      }
      const managedBy = {
        kind: "browser" as const,
        id: context.surface.id,
      };
      const existing = await repository.getManagedTunnel(ownerId, managedBy);
      const targetChanged = Boolean(
        existing &&
        (input.data.resetAttachments ||
          existing.destination.kind !== "worker-tcp" ||
          existing.destination.workerId !== workerId ||
          existing.protocolHint !== input.data.protocolHint),
      );
      let tunnel;
      try {
        tunnel = await repository.registerManagedTunnel(
          ownerId,
          {
            name: "Browser tunnel",
            description: null,
            projectId: context.surface.projectId,
            origin: "browser",
            management: "managed-ephemeral",
            protocolHint: input.data.protocolHint,
            source: { kind: "desktop-loopback" },
            destination: { kind: "worker-tcp", workerId },
            managedBy,
            desiredState: "started",
            status:
              existing && !targetChanged
                ? existing.status
                : bridge.isConnected(workerId)
                  ? "stopped"
                  : "offline",
          },
          {
            id: input.data.tunnelId,
            protectedRecord: input.data.protectedRecord,
          },
        );
      } catch (error) {
        if (error instanceof TunnelManagementError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
      if (targetChanged && existing && tunnel) {
        await Promise.all(
          existing.attachments.map(({ id }) =>
            tunnelRuntime.revoke(ownerId, id, {
              preserveTunnelState: true,
            }),
          ),
        );
        tunnel = await repository.getManagedTunnel(ownerId, managedBy);
      }
      return tunnel
        ? reply.send(tunnelWireSummarySchema.parse(tunnel))
        : reply.code(404).send({
            error: "Browser project or destination worker not found.",
          });
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/browsers",
    async (request, reply) => {
      const input = encryptedBrowserCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const browser = await repository.createBrowser(
          applicationOwnerId(),
          request.params.projectId,
          input.data,
          (workerId) => bridge.isConnected(workerId),
        );
        return browser
          ? reply.code(201).send(browserWireSummarySchema.parse(browser))
          : reply.code(404).send({ error: "Project source not found." });
      } catch (error) {
        if (error instanceof ExecutionPlacementUnavailableError) {
          return reply
            .code(error.code === "project-not-found" ? 404 : 409)
            .send({ code: error.code, error: error.message });
        }
        throw error;
      }
    },
  );

  app.patch<{ Params: { browserId: string } }>(
    "/api/browsers/:browserId",
    async (request, reply) => {
      const input = encryptedBrowserUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const browser = await applyBrowserUpdate(
          applicationOwnerId(),
          request.params.browserId,
          input.data,
        );
        return browser
          ? reply.send(browserWireSummarySchema.parse(browser))
          : reply.code(404).send({ error: "Browser not found." });
      } catch (error) {
        if (error instanceof SurfacePrivateStateConflictError) {
          return reply.code(409).send({
            code: "stale-state",
            error: "Browser state changed before this update.",
          });
        }
        throw error;
      }
    },
  );

  app.delete<{ Params: { browserId: string } }>(
    "/api/browsers/:browserId",
    async (request, reply) => {
      const ownerId = applicationOwnerId();
      const context = await repository.getRemoteSurfaceExecutionContext(
        ownerId,
        request.params.browserId,
      );
      const managedTunnel = await repository.getManagedTunnel(ownerId, {
        kind: "browser",
        id: request.params.browserId,
      });
      if (
        !(await repository.deleteBrowser(ownerId, request.params.browserId))
      ) {
        return reply.code(404).send({ error: "Browser not found." });
      }
      await workerLinks.revokeResource(
        ownerId,
        "browser",
        request.params.browserId,
        "resource-deleted",
      );
      if (managedTunnel) {
        await Promise.all(
          managedTunnel.attachments.map(({ id }) =>
            tunnelRuntime.revoke(ownerId, id),
          ),
        );
        await repository.removeManagedTunnel(ownerId, {
          kind: "browser",
          id: request.params.browserId,
        });
      }
      if (context && bridge.isConnected(context.workerId)) {
        void bridge
          .request(context.workerId, {
            type: "surface.close",
            surfaceId: context.surface.id,
          })
          .catch(() => undefined);
      }
      return reply.code(204).send();
    },
  );
}
