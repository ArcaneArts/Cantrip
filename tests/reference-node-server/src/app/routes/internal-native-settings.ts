import type { FastifyInstance } from "fastify";
import {
  nativeSettingsRefreshRequestSchema,
  nativeSettingsObservationRequestSchema,
} from "@cantrip/protocol";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { authenticateWorkerRequest } from "../../workers/credentials.js";
import { NativeCommandError } from "../../db/repository/native-command-errors.js";
import type { installInternalNativeCommandRoutes } from "./internal-native-commands.js";

export function installInternalNativeSettingsRoutes(
  app: FastifyInstance,
  dependencies: Parameters<typeof installInternalNativeCommandRoutes>[1] & {
    bridge: Pick<WorkerCommandBus, "request">;
  },
): void {
  const { repository, config, runAsOwner, bridge, live } = dependencies;
  for (const phase of ["settings-refresh", "settings-observation"] as const) {
    app.post(
      `/api/internal/native-commands/${phase}`,
      { logLevel: "warn" },
      async (request, reply) => {
        const parsed = (
          phase === "settings-refresh"
            ? nativeSettingsRefreshRequestSchema
            : nativeSettingsObservationRequestSchema
        ).safeParse(request.body);
        if (!parsed.success)
          return reply.code(400).send({ code: "invalid-native-settings" });
        const authentication = await authenticateWorkerRequest(
          repository,
          config,
          request,
          parsed.data.workerId,
          "worker:agent-tools",
        );
        if (!authentication)
          return reply.code(401).send({ code: "unauthorized" });
        return runAsOwner(authentication.ownerId, async () => {
          try {
            if (phase === "settings-refresh") {
              const input = nativeSettingsRefreshRequestSchema.parse(
                parsed.data,
              );
              const result =
                await repository.nativeCommands.refreshSettingsState(
                  authentication.ownerId,
                  input.chatId,
                  (scope) => {
                    if (scope.workerId !== input.workerId)
                      throw new NativeCommandError(
                        "settings-worker-mismatch",
                        "The chat belongs to another worker.",
                        403,
                      );
                    return bridge.request(scope.workerId, {
                      type: "chat.settings.read",
                      scope,
                    });
                  },
                );
              live.publishChatInvalidation(input.chatId, "chat");
              return result;
            }
            const input = nativeSettingsObservationRequestSchema.parse(
              parsed.data,
            );
            const result = await repository.nativeCommands.observeSettingsState(
              authentication.ownerId,
              input,
            );
            live.publishChatInvalidation(input.snapshot.context.chatId, "chat");
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
}
