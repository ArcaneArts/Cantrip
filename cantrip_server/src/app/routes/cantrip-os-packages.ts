import {
  cantripOsPackageCreateSchema,
  cantripOsPackageControlSchema,
  cantripOsPackageListQuerySchema,
} from "@cantrip/protocol";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ServerRepository } from "../../db/repository.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { CantripOsPackageCoordinator } from "../../cantrip-os/packages.js";
import { CantripOsPlacementError } from "../../db/repository/cantrip-os-error.js";
import { invalidBody } from "../../http/request-helpers.js";

export function installCantripOsPackageRoutes(
  app: FastifyInstance,
  dependencies: {
    applicationOwnerId: () => string;
    serverId: string;
    repository: Pick<ServerRepository, "cantripOs" | "getWorker">;
    bridge: Pick<WorkerCommandBus, "request">;
  },
) {
  const coordinator = new CantripOsPackageCoordinator(
    dependencies.repository,
    dependencies.bridge,
    dependencies.serverId,
  );
  const owner = dependencies.applicationOwnerId;
  type Params = { Params: Record<string, string> };
  type Request = FastifyRequest<Params>;
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
              : "CantripOS package request failed. Observe its original admission before retrying.",
        });
      }
    };
  const base = "/api/cantrip-os/:instanceId";
  app.get<Params>(
    `${base}/packages`,
    route((request) => coordinator.status(owner(), request.params.instanceId!)),
  );
  app.post<Params>(
    `${base}/package-operations`,
    route(async (request, reply) => {
      const parsed = cantripOsPackageCreateSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send(invalidBody(parsed.error.issues));
      return coordinator.create(
        owner(),
        request.params.instanceId!,
        parsed.data,
      );
    }),
  );
  app.get<Params>(
    `${base}/package-operations`,
    route(async (request, reply) => {
      const parsed = cantripOsPackageListQuerySchema.safeParse(request.query);
      if (!parsed.success)
        return reply.code(400).send(invalidBody(parsed.error.issues));
      return dependencies.repository.cantripOs.packages.list(
        owner(),
        request.params.instanceId!,
        parsed.data,
      );
    }),
  );
  app.get<Params>(
    `${base}/package-operations/:operationId`,
    route((request) =>
      coordinator.get(
        owner(),
        request.params.instanceId!,
        request.params.operationId!,
      ),
    ),
  );
  app.post<Params>(
    `${base}/package-operations/:operationId/observe`,
    route((request) =>
      coordinator.observe(
        owner(),
        request.params.instanceId!,
        request.params.operationId!,
      ),
    ),
  );
  for (const mode of ["continue", "abandon"] as const)
    app.post<Params>(
      `${base}/package-operations/:operationId/${mode}`,
      route(async (request, reply) => {
        const parsed = cantripOsPackageControlSchema.safeParse(request.body);
        if (!parsed.success)
          return reply.code(400).send(invalidBody(parsed.error.issues));
        return coordinator.control(
          owner(),
          request.params.instanceId!,
          request.params.operationId!,
          mode,
          parsed.data,
        );
      }),
    );
}
