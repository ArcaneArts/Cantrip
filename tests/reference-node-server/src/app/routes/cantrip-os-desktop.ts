import {
  cantripOsDesktopCreateSchema,
  cantripOsDesktopListQuerySchema,
} from "@cantrip/protocol";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ServerRepository } from "../../db/repository.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { CantripOsDesktopCoordinator } from "../../cantrip-os/desktop.js";
import { CantripOsPlacementError } from "../../db/repository/cantrip-os-error.js";
import { invalidBody } from "../../http/request-helpers.js";

export function installCantripOsDesktopRoutes(
  app: FastifyInstance,
  dependencies: {
    applicationOwnerId: () => string;
    serverId: string;
    repository: Pick<ServerRepository, "cantripOs" | "getWorker">;
    bridge: Pick<WorkerCommandBus, "request">;
  },
) {
  const coordinator = new CantripOsDesktopCoordinator(
    dependencies.repository,
    dependencies.bridge,
    dependencies.serverId,
  );
  const owner = dependencies.applicationOwnerId;
  type Request = FastifyRequest<{ Params: Record<string, string> }>;
  const route =
    (run: (request: Request, reply: FastifyReply) => Promise<unknown>) =>
    async (request: Request, reply: FastifyReply) => {
      try {
        return await run(request, reply);
      } catch (error) {
        return reply.code(409).send({
          error:
            error instanceof CantripOsPlacementError
              ? error.message
              : "CantripOS desktop request failed. Observe its original admission before retrying.",
        });
      }
    };
  app.get<{ Params: Record<string, string> }>(
    "/api/cantrip-os/:instanceId/workspaces/:workspaceId/desktop",
    route((request) =>
      coordinator.status(
        owner(),
        request.params.instanceId!,
        request.params.workspaceId!,
      ),
    ),
  );
  app.post<{ Params: Record<string, string> }>(
    "/api/cantrip-os/:instanceId/workspaces/:workspaceId/desktop-operations",
    route(async (request, reply) => {
      const input = cantripOsDesktopCreateSchema.safeParse(request.body);
      if (!input.success)
        return reply.code(400).send(invalidBody(input.error.issues));
      return coordinator.create(
        owner(),
        request.params.instanceId!,
        request.params.workspaceId!,
        input.data,
      );
    }),
  );
  app.get<{ Params: Record<string, string> }>(
    "/api/cantrip-os/:instanceId/workspaces/:workspaceId/desktop-operations",
    route(async (request, reply) => {
      const query = cantripOsDesktopListQuerySchema.safeParse(request.query);
      if (!query.success)
        return reply.code(400).send(invalidBody(query.error.issues));
      await dependencies.repository.cantripOs.desktop.context(
        owner(),
        request.params.instanceId!,
        request.params.workspaceId!,
      );
      return dependencies.repository.cantripOs.desktop.list(
        owner(),
        request.params.instanceId!,
        request.params.workspaceId!,
        query.data,
      );
    }),
  );
  app.get<{ Params: Record<string, string> }>(
    "/api/cantrip-os/:instanceId/workspaces/:workspaceId/desktop-operations/:operationId",
    route((request) =>
      coordinator.get(
        owner(),
        request.params.instanceId!,
        request.params.workspaceId!,
        request.params.operationId!,
      ),
    ),
  );
  app.post<{ Params: Record<string, string> }>(
    "/api/cantrip-os/:instanceId/workspaces/:workspaceId/desktop-operations/:operationId/observe",
    route((request) =>
      coordinator.observe(
        owner(),
        request.params.instanceId!,
        request.params.workspaceId!,
        request.params.operationId!,
      ),
    ),
  );
}
