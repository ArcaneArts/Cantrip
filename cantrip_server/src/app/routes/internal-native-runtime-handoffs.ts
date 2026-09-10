import type { FastifyInstance } from "fastify";
import { nativeRuntimeHandoffWorkerRequestSchema } from "@cantrip/protocol";
import type { ServerRepository } from "../../db/repository.js";
import { NativeCommandError } from "../../db/repository/native-command-errors.js";
import { authenticateWorkerRequest } from "../../workers/credentials.js";
import type { installInternalNativeCommandRoutes } from "./internal-native-commands.js";

export function installInternalNativeRuntimeHandoffRoutes(
  app: FastifyInstance,
  dependencies: Pick<
    Parameters<typeof installInternalNativeCommandRoutes>[1],
    "config" | "runAsOwner"
  > & {
    live: Pick<
      Parameters<typeof installInternalNativeCommandRoutes>[1]["live"],
      "publishChatInvalidation"
    >;
    repository: Pick<
      ServerRepository,
      "nativeRuntimeHandoffs" | "authenticateWorkerCredential" | "getWorker"
    >;
  },
): void {
  const { repository, config, runAsOwner, live } = dependencies;
  app.post(
    "/api/internal/native-runtime-handoffs",
    { logLevel: "warn" },
    async (request, reply) => {
      const parsed = nativeRuntimeHandoffWorkerRequestSchema.safeParse(
        request.body,
      );
      if (!parsed.success)
        return reply.code(400).send({ code: "invalid-native-runtime-handoff" });
      const input = parsed.data;
      const authentication = await authenticateWorkerRequest(
        repository,
        config,
        request,
        input.workerId,
        "worker:agent-tools",
      );
      if (!authentication)
        return reply.code(401).send({ code: "unauthorized" });
      return runAsOwner(authentication.ownerId, async () => {
        const ownerId = authentication.ownerId;
        const operations = repository.nativeRuntimeHandoffs;
        try {
          // The worker can advance only an operation already reserved for its
          // exact chat. This endpoint cannot select an account or begin migration.
          const state = await operations.get(
            ownerId,
            input.chatId,
            input.operationId,
          );
          if (!state || state.workerId !== input.workerId)
            return reply.code(404).send({ code: "handoff-not-found" });
          if (input.action === "read") return state;
          let result;
          switch (input.action) {
            case "prepared":
              result = await operations.prepared(
                ownerId,
                input.workerId,
                input.operationId,
                input.prepared,
                input.expectedPreparedRuntimeGeneration,
              );
              break;
            case "commit":
              result = await operations.commit(
                ownerId,
                input.workerId,
                input.operationId,
              );
              break;
            case "finish":
              result = await operations.finish(
                ownerId,
                input.workerId,
                input.operationId,
                input.outcome,
              );
              break;
            case "failure":
              result = await operations.failure(
                ownerId,
                input.workerId,
                input.operationId,
                input.errorCode,
              );
              break;
          }
          live.publishChatInvalidation(input.chatId, "chat");
          return result;
        } catch (error) {
          if (error instanceof NativeCommandError)
            return reply
              .code(error.statusCode)
              .send({ code: error.code, error: error.message });
          throw error;
        }
      });
    },
  );
}
