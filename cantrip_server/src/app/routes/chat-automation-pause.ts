import { managedConsoleSessionContext } from "../../terminals/managed-session.js";
import { chatPauseStateSchema, chatPauseUpdateSchema } from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { STREAMING_WORKER_COMMAND_TIMEOUT_MS } from "../shared/constants.js";

export interface ChatAutomationPauseRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  publishChatSummary: (chatId: string, projectId: string | null) => void;
  repository: Pick<
    ServerRepository,
    | "getChatExecutionContext"
    | "listQueuedPrompts"
    | "setChatAutomationPaused"
    | "nativeCommands"
  >;
  resumeChatAutomation: (chatId: string) => Promise<void>;
}

/** Registers durable Chat automation pause and resume orchestration. */
export function installChatAutomationPauseRoute(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    publishChatSummary,
    repository,
    resumeChatAutomation,
  }: ChatAutomationPauseRouteDependencies,
): void {
  app.patch<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/pause",
    async (request, reply) => {
      const input = chatPauseUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const control = await repository.nativeCommands.controlContext(
        applicationOwnerId(),
        request.params.chatId,
      );
      const context = control.context;
      if (!context) {
        return reply.code(404).send({ error: "Chat source not found." });
      }

      if (
        !input.data.paused &&
        !bridge.isConnected(context.workerId) &&
        (context.threadId ||
          (
            await repository.listQueuedPrompts(
              applicationOwnerId(),
              context.chatId,
            )
          ).length > 0)
      ) {
        return reply.code(503).send({
          error:
            "The project worker is offline. This chat remains paused so its next action is not lost.",
        });
      }

      const managedNative = managedConsoleSessionContext(context) !== undefined;
      // Native goal/queue resume may start execution, so admission must observe
      // the user's durable unpause before the worker forwards that mutation.
      const resumed =
        managedNative && !input.data.paused
          ? await repository.setChatAutomationPaused(
              applicationOwnerId(),
              context.chatId,
              false,
            )
          : null;
      if (managedNative && !input.data.paused && !resumed)
        return reply.code(404).send({ error: "Chat source not found." });
      if (managedNative && !input.data.paused)
        await repository.nativeCommands.resumeAutonomy(
          applicationOwnerId(),
          context.chatId,
        );
      const workerConnected = bridge.isConnected(context.workerId);
      const pauseCommand = (paused: boolean) =>
        managedNative && control.activationGeneration
          ? {
              type: "chat.native-control" as const,
              chatId: context.chatId,
              threadId: context.threadId,
              nativeActivationGeneration: control.activationGeneration,
              nativeRuntimeGeneration: control.runtimeGeneration,
              modelRouteId: context.modelRouteId,
              providerAccountId: context.providerAccountId,
              control: { kind: "pause" as const, paused },
            }
          : { type: "chat.pause.set" as const, chatId: context.chatId, paused };

      if (!input.data.paused && workerConnected) {
        try {
          await bridge.request(context.workerId, pauseCommand(false), {
            timeoutMs: STREAMING_WORKER_COMMAND_TIMEOUT_MS,
          });
        } catch (error) {
          if (managedNative) {
            await repository.setChatAutomationPaused(
              applicationOwnerId(),
              context.chatId,
              true,
            );
            publishChatSummary(context.chatId, context.projectId);
          }
          return reply.code(502).send({
            error: `The worker could not resume this chat: ${errorMessage(error)}`,
          });
        }
      }

      if (input.data.paused && workerConnected) {
        try {
          await bridge.request(context.workerId, pauseCommand(true), {
            timeoutMs: STREAMING_WORKER_COMMAND_TIMEOUT_MS,
          });
        } catch (error) {
          return reply.code(502).send({
            error: `The worker could not pause this chat at a safe boundary: ${errorMessage(error)}`,
          });
        }
      }

      // Active native controls persist their intent at authorized dispatch. A
      // boundary acknowledgement may arrive after a newer pause/resume, so this
      // older HTTP request must not write its original intent a second time.
      const nativeOwnsPause =
        managedNative &&
        Boolean(control.activationGeneration) &&
        workerConnected;
      const updated = nativeOwnsPause
        ? await repository.getChatExecutionContext(
            applicationOwnerId(),
            context.chatId,
          )
        : (resumed ??
          (await repository.setChatAutomationPaused(
            applicationOwnerId(),
            context.chatId,
            input.data.paused,
          )));
      if (!updated) {
        if (workerConnected) {
          await bridge
            .request(context.workerId, pauseCommand(!input.data.paused), {
              timeoutMs: STREAMING_WORKER_COMMAND_TIMEOUT_MS,
            })
            .catch(() => undefined);
        }
        return reply.code(404).send({ error: "Chat source not found." });
      }

      publishChatSummary(context.chatId, context.projectId);

      if (!input.data.paused && !updated.automationPaused) {
        try {
          await resumeChatAutomation(context.chatId);
        } catch (error) {
          await repository.setChatAutomationPaused(
            applicationOwnerId(),
            context.chatId,
            true,
          );
          publishChatSummary(context.chatId, context.projectId);
          if (bridge.isConnected(context.workerId)) {
            await bridge
              .request(context.workerId, pauseCommand(true))
              .catch(() => undefined);
          }
          return reply.code(409).send({
            error: `This chat remains paused because its next action could not start: ${errorMessage(error)}`,
          });
        }
      }

      app.log.info(
        {
          event: updated.automationPaused
            ? "chat.automation.paused"
            : "chat.automation.resumed",
          subsystem: "chat-execution",
          operation: updated.automationPaused ? "pause" : "resume",
          status: updated.automationPaused ? "paused" : "active",
          chatId: context.chatId,
          projectId: context.projectId,
          workerId: context.workerId,
        },
        updated.automationPaused
          ? "Chat automation paused"
          : "Chat automation resumed",
      );

      return reply.send(
        chatPauseStateSchema.parse({ paused: updated.automationPaused }),
      );
    },
  );
}
