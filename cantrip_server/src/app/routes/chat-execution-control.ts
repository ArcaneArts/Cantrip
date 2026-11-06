import {
  managedTurnSessionContext,
  prepareManagedTurnLaunch,
  type ManagedConsoleRouting,
} from "../../terminals/managed-session.js";
import {
  chatCompactAcceptedSchema,
  chatInterruptAcceptedSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import {
  chatIsExecuting,
  effectivePermissionProfile,
} from "../../chats/execution-helpers.js";
import type {
  ChatExecutionContext,
  ModelRuntime,
  ServerRepository,
} from "../../db/repository.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { interruptTask } from "../runtime/task-interrupt-runtime.js";
import { ChatAutomationPauseError } from "../runtime/chat-automation-pause-error.js";
import {
  createDurableChatStopRuntime,
  DurableChatStopError,
} from "../runtime/durable-chat-stop.js";

export interface ChatExecutionControlRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  interruptLiveAgentInteractionRequests: (
    ...input: Parameters<ServerRepository["interruptAgentInteractionRequests"]>
  ) => ReturnType<ServerRepository["interruptAgentInteractionRequests"]>;
  repository: Pick<
    ServerRepository,
    | "getChatExecutionContext"
    | "nativeCommands"
    | "nativeSuspensions"
    | "chatExecutionLanes"
    | "taskAutomationPause"
    | "nativeRuntimeHandoffs"
    | "listEffectiveMcpServers"
    | "setChatModel"
    | "updateChatRuntime"
  >;
  routePairsForConfiguration: ManagedConsoleRouting["routePairsForConfiguration"];
  publishChatSummary: (chatId: string, projectId: string | null) => void;
  runtimeForContext: (
    context: ChatExecutionContext,
  ) => Promise<ModelRuntime | null>;
}

/** Registers worker-backed Chat compaction and interruption controls. */
export function installChatExecutionControlRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    interruptLiveAgentInteractionRequests,
    repository,
    publishChatSummary,
    runtimeForContext,
    routePairsForConfiguration,
  }: ChatExecutionControlRouteDependencies,
): void {
  const stopDurable = createDurableChatStopRuntime({
    repository,
    bridge,
    publishChatSummary,
    runtimeForContext,
    routePairsForConfiguration,
  });
  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/compact",
    async (request, reply) => {
      const context = await repository.getChatExecutionContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (chatIsExecuting(context.status)) {
        return reply
          .code(409)
          .send({ error: "Wait for the active turn to finish." });
      }
      if (!context.threadId) {
        return reply
          .code(409)
          .send({ error: "Send a message before compacting this chat." });
      }
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      const runtime = await runtimeForContext(context);
      if (!runtime) {
        return reply.code(400).send({ error: "Selected model was not found." });
      }
      const compactionStartedAtMs = Date.now();
      app.log.info(
        {
          event: "chat.compaction.started",
          subsystem: "chat-execution",
          operation: "compact",
          status: "running",
          chatId: context.chatId,
          projectId: context.projectId,
          workerId: context.workerId,
        },
        "Chat compaction started",
      );
      const managed = managedTurnSessionContext(context)
        ? await prepareManagedTurnLaunch(context, runtime, {
            ownerId: applicationOwnerId(),
            bridge,
            repository,
            routePairsForConfiguration,
          })
        : null;
      const result = await bridge.request(context.workerId, {
        ...(managed
          ? {
              session: managed.session,
              subagentDefaults: managed.subagentDefaults,
              mcpServers: managed.mcpServers,
              planMode: managed.planMode,
            }
          : {}),
        type: "chat.compact",
        executionProfile:
          context.contextKind === "standalone" ? "standalone-chat" : "ide",
        chatId: context.chatId,
        cwd: context.cwd,
        threadId: context.threadId,
        model: runtime.model,
        provider: runtime.provider,
        permissionProfileId: effectivePermissionProfile(context).effectiveId,
      });
      app.log.info(
        {
          event: "chat.compaction.completed",
          subsystem: "chat-execution",
          operation: "compact",
          status: "completed",
          durationMs: Date.now() - compactionStartedAtMs,
          chatId: context.chatId,
          projectId: context.projectId,
          workerId: context.workerId,
        },
        "Chat compaction completed",
      );
      return reply.send(chatCompactAcceptedSchema.parse(result));
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/interrupt",
    async (request, reply) => {
      const control = await repository.nativeCommands.controlContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      const context = control.context;
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }
      if (context.experience === "task") {
        try {
          return reply.send(
            await interruptTask(applicationOwnerId(), context.chatId, {
              repository,
              bridge,
              publishChatSummary,
              runtimeForContext,
            }),
          );
        } catch (error) {
          if (error instanceof ChatAutomationPauseError)
            return reply.code(error.statusCode).send({ error: error.message });
          throw error;
        }
      }
      const autonomyStopped = managedTurnSessionContext(context)
        ? await repository.nativeCommands.stopAutonomy(
            applicationOwnerId(),
            context.chatId,
            control.activationGeneration,
          )
        : false;
      const suspension = managedTurnSessionContext(context)
        ? await repository.nativeSuspensions.read(
            applicationOwnerId(),
            context.chatId,
          )
        : null;
      if (
        suspension?.active &&
        !["stopped", "completed", "failed", "idle"].includes(suspension.phase)
      ) {
        try {
          const result = await stopDurable(
            applicationOwnerId(),
            context,
            control,
            suspension,
          );
          if (result.interrupted && context.status === "waiting-for-approval")
            await interruptLiveAgentInteractionRequests(context.chatId);
          return reply.send(chatInterruptAcceptedSchema.parse(result));
        } catch (error) {
          if (error instanceof DurableChatStopError)
            return reply
              .code(409)
              .send({ code: "stop-failed", error: error.message });
          throw error;
        }
      }
      const chatCanBeInterrupted =
        context.status === "running" ||
        context.status === "waiting-for-approval";
      if (!chatCanBeInterrupted) {
        return reply.send(
          chatInterruptAcceptedSchema.parse({ interrupted: autonomyStopped }),
        );
      }
      const cancelledPreparation = control.activationGeneration
        ? await repository.nativeCommands.cancelPreparing(
            applicationOwnerId(),
            context.chatId,
            control.activationGeneration,
          )
        : null;
      if (cancelledPreparation) {
        if (cancelledPreparation.logicalRoot) {
          try {
            await bridge.request(
              cancelledPreparation.workerId,
              {
                type: "chat.native-logical.cancel",
                chatId: context.chatId,
                rootOperationId: cancelledPreparation.logicalRoot.operationId,
                rootOperationGeneration:
                  cancelledPreparation.logicalRoot.operationGeneration,
              },
              { timeoutMs: 5_000 },
            );
          } catch {
            app.log.warn(
              {
                event: "chat.preparation.cancel-notification-failed",
                chatId: context.chatId,
                workerId: cancelledPreparation.workerId,
                operationId: cancelledPreparation.logicalRoot.operationId,
              },
              "Preparation cancellation committed but worker notification failed",
            );
          }
        }
        publishChatSummary(context.chatId, context.projectId);
        return reply.send(
          chatInterruptAcceptedSchema.parse({ interrupted: true }),
        );
      }
      const result = await bridge.request(
        context.workerId,
        control.activationGeneration
          ? {
              type: "chat.native-control",
              chatId: context.chatId,
              threadId: context.threadId,
              nativeActivationGeneration: control.activationGeneration,
              nativeRuntimeGeneration: control.runtimeGeneration,
              modelRouteId: context.modelRouteId,
              providerAccountId: context.providerAccountId,
              control: { kind: "interrupt" },
            }
          : {
              type: "chat.interrupt",
              executionProfile:
                context.contextKind === "standalone"
                  ? "standalone-chat"
                  : "ide",
              chatId: context.chatId,
              threadId: context.threadId,
            },
      );
      const parsedResult = chatInterruptAcceptedSchema.parse(result);
      if (
        parsedResult.interrupted &&
        context.status === "waiting-for-approval"
      ) {
        await interruptLiveAgentInteractionRequests(context.chatId);
      }
      app.log.info(
        {
          event: "chat.interrupt.requested",
          subsystem: "chat-execution",
          operation: "interrupt",
          status: parsedResult.interrupted ? "accepted" : "not-active",
          chatId: context.chatId,
          projectId: context.projectId,
          workerId: context.workerId,
        },
        parsedResult.interrupted
          ? "Agent turn interruption accepted"
          : "Agent turn was not active",
      );
      return reply.send(parsedResult);
    },
  );
}
