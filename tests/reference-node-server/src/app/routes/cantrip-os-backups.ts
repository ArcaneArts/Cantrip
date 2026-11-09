import type { FastifyInstance } from "fastify";
import {
  cantripOsBackupAdmissionSchema,
  cantripOsBackupListQuerySchema,
  cantripOsBackupRecoverySchema,
} from "@cantrip/protocol";
import { CantripOsBackups } from "../../cantrip-os/backups.js";
import type { installCantripOsRoutes } from "./cantrip-os.js";
import { CantripOsPlacementError } from "../../db/repository/cantrip-os-error.js";
import { invalidBody } from "../../http/request-helpers.js";

export function installCantripOsBackupRoutes(
  app: FastifyInstance,
  dependencies: Parameters<typeof installCantripOsRoutes>[1],
) {
  const service = new CantripOsBackups(
    dependencies.repository,
    dependencies.bridge,
    dependencies.serverId,
  );
  const owner = dependencies.applicationOwnerId;
  type Params = { Params: { instanceId: string; operationId: string } };
  const execute = async (
    reply: import("fastify").FastifyReply,
    operation: () => Promise<unknown>,
  ) => {
    try {
      return reply.send(await operation());
    } catch (error) {
      return reply.code(409).send({
        error:
          error instanceof CantripOsPlacementError
            ? error.message
            : "CantripOS backup request failed. Observe the original operation before retrying.",
      });
    }
  };
  for (const [url, captures] of [
    ["/api/cantrip-os/backups", true],
    ["/api/cantrip-os/backup-operations", false],
  ] as const)
    app.get(url, async (request, reply) => {
      const query = cantripOsBackupListQuerySchema.safeParse(request.query);
      if (!query.success)
        return reply.code(400).send(invalidBody(query.error.issues));
      return execute(reply, () => service.list(owner(), query.data, captures));
    });
  app.get<Params>(
    "/api/cantrip-os/backup-operations/:operationId",
    (request, reply) =>
      execute(reply, () => service.get(owner(), request.params.operationId)),
  );
  app.post<Params>(
    "/api/cantrip-os/:instanceId/backup-operations",
    (request, reply) => {
      const input = cantripOsBackupAdmissionSchema.safeParse(request.body);
      if (!input.success)
        return reply.code(400).send(invalidBody(input.error.issues));
      return execute(reply, () =>
        service.admit(owner(), request.params.instanceId, input.data),
      );
    },
  );
  app.post<Params>(
    "/api/cantrip-os/backup-operations/:operationId/recovery",
    (request, reply) => {
      const input = cantripOsBackupRecoverySchema.safeParse(request.body);
      if (!input.success)
        return reply.code(400).send(invalidBody(input.error.issues));
      return execute(reply, () =>
        service.recover(owner(), request.params.operationId, input.data),
      );
    },
  );
}
