import { nativeModelInventoryRequestSchema } from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../../config.js";
import type { ServerRepository } from "../../db/repository.js";
import type { ApplicationOwnerContext } from "../http/owner-context.js";
import { authenticateWorkerRequest } from "../../workers/credentials.js";
import {
  readNativeModelInventory,
  type NativeModelInventoryRepository,
} from "../../models/native-model-inventory.js";

export function installInternalNativeModelInventoryRoutes(
  app: FastifyInstance,
  dependencies: {
    config: ServerConfig;
    repository: NativeModelInventoryRepository &
      Pick<ServerRepository, "authenticateWorkerCredential" | "getWorker">;
    runAsOwner: ApplicationOwnerContext["runAsOwner"];
  },
): void {
  app.post(
    "/api/internal/native-model-inventory",
    { logLevel: "warn" },
    async (request, reply) => {
      const parsed = nativeModelInventoryRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: "invalid-native-model-inventory" });
      const authentication = await authenticateWorkerRequest(
        dependencies.repository,
        dependencies.config,
        request,
        parsed.data.workerId,
        "worker:agent-tools",
      );
      if (!authentication)
        return reply.code(401).send({ code: "unauthorized" });
      return dependencies.runAsOwner(authentication.ownerId, async () => {
        if (
          !(await dependencies.repository.getWorker(
            authentication.ownerId,
            parsed.data.workerId,
          ))
        )
          return reply.code(404).send({ code: "worker-not-found" });
        const inventory = await readNativeModelInventory(
          dependencies.repository,
          authentication.ownerId,
          parsed.data,
        );
        return (
          inventory ??
          reply
            .code(404)
            .send({ code: "native-model-inventory-scope-not-found" })
        );
      });
    },
  );
}
