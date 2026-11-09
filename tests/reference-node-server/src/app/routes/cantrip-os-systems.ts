import {
  cantripOsSystemCreateSchema,
  cantripOsSystemControlSchema,
  cantripOsSystemListQuerySchema,
} from "@cantrip/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerRepository } from "../../db/repository.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { CantripOsSystemCoordinator } from "../../cantrip-os/systems.js";
import { CantripOsPlacementError } from "../../db/repository/cantrip-os-error.js";
import { invalidBody } from "../../http/request-helpers.js";
export function installCantripOsSystemRoutes(
  app: FastifyInstance,
  dependencies: {
    applicationOwnerId: () => string;
    serverId: string;
    repository: Pick<ServerRepository, "cantripOs" | "getWorker">;
    bridge: Pick<WorkerCommandBus, "request">;
  },
) {
  const coordinator = new CantripOsSystemCoordinator(
      dependencies.repository,
      dependencies.bridge,
      dependencies.serverId,
    ),
    owner = dependencies.applicationOwnerId;
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
              : "CantripOS system request failed. Observe its original admission before retrying.",
        });
      }
    };
  const base = "/api/cantrip-os/:instanceId";
  app.get<Params>(
    `${base}/system`,
    route((request) => coordinator.status(owner(), request.params.instanceId!)),
  );
  app.post<Params>(
    `${base}/system-operations`,
    route(async (request, reply) => {
      const parsed = cantripOsSystemCreateSchema.safeParse(request.body);
      return parsed.success
        ? coordinator.create(owner(), request.params.instanceId!, parsed.data)
        : reply.code(400).send(invalidBody(parsed.error.issues));
    }),
  );
  app.get<Params>(
    `${base}/system-operations`,
    route(async (request, reply) => {
      const parsed = cantripOsSystemListQuerySchema.safeParse(request.query);
      return parsed.success
        ? dependencies.repository.cantripOs.systems.list(
            owner(),
            request.params.instanceId!,
            parsed.data,
          )
        : reply.code(400).send(invalidBody(parsed.error.issues));
    }),
  );
  app.get<Params>(
    `${base}/system-operations/:operationId`,
    route((request) =>
      coordinator.get(
        owner(),
        request.params.instanceId!,
        request.params.operationId!,
      ),
    ),
  );
  app.post<Params>(
    `${base}/system-operations/:operationId/observe`,
    route((request) =>
      coordinator.observe(
        owner(),
        request.params.instanceId!,
        request.params.operationId!,
      ),
    ),
  );
  for (const mode of ["continue", "recover", "abandon"] as const)
    app.post<Params>(
      `${base}/system-operations/:operationId/${mode}`,
      route(async (request, reply) => {
        const parsed = cantripOsSystemControlSchema.safeParse(request.body);
        if (!parsed.success)
          return reply.code(400).send(invalidBody(parsed.error.issues));
        if (mode === "abandon")
          return coordinator.abandon(
            owner(),
            request.params.instanceId!,
            request.params.operationId!,
            parsed.data,
          );
        return mode === "continue"
          ? coordinator.control(
              owner(),
              request.params.instanceId!,
              request.params.operationId!,
              parsed.data,
            )
          : coordinator.recover(
              owner(),
              request.params.instanceId!,
              request.params.operationId!,
              parsed.data,
            );
      }),
    );
}
