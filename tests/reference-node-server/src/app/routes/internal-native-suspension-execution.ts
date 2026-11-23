import type { FastifyInstance } from "fastify";
import {
  nativeSuspensionExecutionAdmissionSchema,
  nativeSuspensionExecutionAdmissionResultSchema,
} from "@cantrip/protocol";
import {
  NativeCommandError,
  type NativeCommandAdmissionResult,
} from "../../db/repository/native-commands.js";
import { authenticateWorkerRequest } from "../../workers/credentials.js";
import type { installInternalNativeCommandRoutes } from "./internal-native-commands.js";

type Dependencies = Pick<
  Parameters<typeof installInternalNativeCommandRoutes>[1],
  "repository" | "config" | "runAsOwner" | "bridge" | "live"
> & {
  authority(ownerId: string, result: NativeCommandAdmissionResult): unknown;
};

export function installInternalNativeSuspensionExecutionRoutes(
  app: FastifyInstance,
  dependencies: Dependencies,
) {
  app.post(
    "/api/internal/native-commands/suspension-execution",
    { logLevel: "warn" },
    async (request, reply) => {
      const parsed = nativeSuspensionExecutionAdmissionSchema.safeParse(
        request.body,
      );
      if (!parsed.success)
        return reply.code(400).send({ code: "invalid-suspension-execution" });
      const input = parsed.data;
      const authentication = await authenticateWorkerRequest(
        dependencies.repository,
        dependencies.config,
        request,
        input.workerId,
        "worker:agent-tools",
      );
      if (!authentication)
        return reply.code(401).send({ code: "unauthorized" });
      const current = () => {
        const identity = dependencies.bridge?.connectionIdentity?.(
          input.workerId,
        );
        return (
          identity?.ownerId === authentication.ownerId &&
          identity.workerProcessGeneration === input.workerGeneration
        );
      };
      if (!current())
        return reply.code(409).send({ code: "stale-worker-generation" });
      return dependencies.runAsOwner(authentication.ownerId, async () => {
        try {
          const result =
            await dependencies.repository.nativeCommands.admitSuspendedExecution(
              authentication.ownerId,
              input,
            );
          if (!current())
            return reply.code(409).send({ code: "stale-worker-generation" });
          if (result.execution)
            dependencies.live.publishChatSummary(
              result.execution.chatId,
              result.execution.projectId,
            );
          return nativeSuspensionExecutionAdmissionResultSchema.parse(
            dependencies.authority(authentication.ownerId, result),
          );
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
