import {
  chatPlanUpdateSchema,
  encryptedChatPlanWireStateSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import { effectivePermissionProfile } from "../../chats/execution-helpers.js";
import type {
  ChatExecutionContext,
  ModelRuntime,
  ServerRepository,
} from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface ChatPlanRouteDependencies {
  applicationOwnerId: () => string;
  availableModelRuntimes: (
    context: ChatExecutionContext,
    modelId: string,
  ) => Promise<ModelRuntime[]>;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  repository: Pick<
    ServerRepository,
    "getChatExecutionContext" | "getChatPlanWireState" | "updateChatRuntime"
  >;
  resolveModelId: (context: ChatExecutionContext) => Promise<string>;
  runtimeCanResumeContext: (
    context: ChatExecutionContext,
    runtime: ModelRuntime,
  ) => boolean;
  runtimeForContext: (
    context: ChatExecutionContext,
  ) => Promise<ModelRuntime | null>;
  updateLiveChatPlanMode: (
    ...input: Parameters<ServerRepository["updateChatPlanMode"]>
  ) => ReturnType<ServerRepository["updateChatPlanMode"]>;
}

/** Registers native Plan Mode synchronization and mutation routes. */
export function installChatPlanRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    availableModelRuntimes,
    bridge,
    repository,
    resolveModelId,
    runtimeCanResumeContext,
    runtimeForContext,
    updateLiveChatPlanMode,
  }: ChatPlanRouteDependencies,
): void {
  app.get<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/plan",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (context.threadId && bridge.isConnected(context.workerId)) {
        try {
          const runtime = await runtimeForContext(context);
          if (runtime) {
            const result = (await bridge.request(context.workerId, {
              type: "chat.plan.get",
              cwd: context.cwd,
              threadId: context.threadId,
              fallbackMode: context.planMode,
              model: runtime.model,
              provider: runtime.provider,
              permissionProfileId:
                effectivePermissionProfile(context).effectiveId,
            })) as { mode?: unknown };
            const mode = chatPlanUpdateSchema.safeParse({ mode: result.mode });
            if (mode.success && mode.data.mode !== context.planMode) {
              await updateLiveChatPlanMode(
                applicationOwnerId(),
                context.chatId,
                mode.data.mode,
              );
            }
          }
        } catch (error) {
          app.log.warn(
            { chatId: context.chatId, err: error },
            "Could not refresh native Plan Mode state",
          );
        }
      }
      const state = await repository.getChatPlanWireState(
        applicationOwnerId(),
        context.chatId,
      );
      return reply.send(encryptedChatPlanWireStateSchema.parse(state));
    },
  );

  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/plan",
    async (request, reply) => {
      const input = chatPlanUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (context.status === "running") {
        return reply
          .code(409)
          .send({ error: "Wait for the active turn to finish." });
      }
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        const modelId = await resolveModelId(context);
        const runtime =
          (await runtimeForContext(context)) ??
          (await availableModelRuntimes(context, modelId))[0]!;
        const result = (await bridge.request(context.workerId, {
          type: "chat.plan.set",
          cwd: context.cwd,
          threadId: runtimeCanResumeContext(context, runtime)
            ? context.threadId
            : null,
          mode: input.data.mode,
          model: runtime.model,
          provider: runtime.provider,
          permissionProfileId: effectivePermissionProfile(context).effectiveId,
        })) as { mode: unknown; threadId: unknown };
        const nativeMode = chatPlanUpdateSchema.parse({ mode: result.mode });
        if (typeof result.threadId !== "string" || !result.threadId) {
          throw new Error("Codex did not return a Plan Mode thread.");
        }
        await repository.updateChatRuntime(
          context.chatId,
          context.workerId,
          context.worktreeId,
          result.threadId,
          runtime.routeId,
          "ready",
          runtime.provider.accountId,
        );
        const state = await updateLiveChatPlanMode(
          applicationOwnerId(),
          context.chatId,
          nativeMode.mode,
        );
        return reply.send(encryptedChatPlanWireStateSchema.parse(state));
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );
}
