import type { FastifyInstance } from "fastify";
import {
  chatPauseRuntimeStateSchema,
  type ChatPauseRuntimeState,
} from "@cantrip/protocol";
import { managedConsoleSessionContext } from "../../terminals/managed-session.js";
import type { ServerRepository } from "../../db/repository.js";
import { errorMessage } from "../../http/request-helpers.js";
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

export class ChatAutomationPauseError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** Shares durable pause state and native controls across Chat and Task-list actions. */
export function createChatAutomationPauseRuntime(
  {
    bridge,
    publishChatSummary,
    repository,
    resumeChatAutomation,
  }: Omit<ChatAutomationPauseRouteDependencies, "applicationOwnerId">,
  app: Pick<FastifyInstance, "log">,
) {
  return async function setChatAutomationPause(
    ownerId: string,
    chatId: string,
    paused: boolean,
    { resumeAutomation = true }: { resumeAutomation?: boolean } = {},
  ): Promise<ChatPauseRuntimeState> {
    const control = await repository.nativeCommands.controlContext(
      ownerId,
      chatId,
    );
    const context = control.context;
    if (!context) {
      throw new ChatAutomationPauseError(404, "Chat source not found.");
    }

    if (
      !paused &&
      !bridge.isConnected(context.workerId) &&
      (context.threadId ||
        (await repository.listQueuedPrompts(ownerId, context.chatId)).length >
          0)
    ) {
      throw new ChatAutomationPauseError(
        503,
        "The project worker is offline. This chat remains paused so its next action is not lost.",
      );
    }

    const managedNative = managedConsoleSessionContext(context) !== undefined;
    // Native goal/queue resume may start execution, so admission must observe
    // the user's durable unpause before the worker forwards that mutation.
    const resumed =
      managedNative && !paused
        ? await repository.setChatAutomationPaused(
            ownerId,
            context.chatId,
            false,
          )
        : null;
    if (managedNative && !paused && !resumed)
      throw new ChatAutomationPauseError(404, "Chat source not found.");
    if (managedNative && !paused)
      await repository.nativeCommands.resumeAutonomy(ownerId, context.chatId);
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

    let active: ChatPauseRuntimeState["active"] = null;

    if (workerConnected) {
      try {
        const receipt = chatPauseRuntimeStateSchema.parse(
          await bridge.request(context.workerId, pauseCommand(paused), {
            timeoutMs: STREAMING_WORKER_COMMAND_TIMEOUT_MS,
          }),
        );
        if (!managedNative && receipt.paused !== paused)
          throw new Error(
            "The worker did not acknowledge the requested pause state.",
          );
        active = receipt.active;
      } catch (error) {
        if (!paused && managedNative) {
          await repository.setChatAutomationPaused(
            ownerId,
            context.chatId,
            true,
          );
          publishChatSummary(context.chatId, context.projectId);
        }
        throw new ChatAutomationPauseError(
          502,
          paused
            ? `The worker could not pause this chat at a safe boundary: ${errorMessage(error)}`
            : `The worker could not resume this chat: ${errorMessage(error)}`,
        );
      }
    }

    // Active native controls persist their intent at authorized dispatch. A
    // boundary acknowledgement may arrive after a newer pause/resume, so this
    // older HTTP request must not write its original intent a second time.
    const nativeOwnsPause =
      managedNative && Boolean(control.activationGeneration) && workerConnected;
    const updated = nativeOwnsPause
      ? await repository.getChatExecutionContext(ownerId, context.chatId)
      : (resumed ??
        (await repository.setChatAutomationPaused(
          ownerId,
          context.chatId,
          paused,
        )));
    if (!updated) {
      if (workerConnected) {
        await bridge
          .request(context.workerId, pauseCommand(!paused), {
            timeoutMs: STREAMING_WORKER_COMMAND_TIMEOUT_MS,
          })
          .catch(() => undefined);
      }
      throw new ChatAutomationPauseError(404, "Chat source not found.");
    }

    publishChatSummary(context.chatId, context.projectId);

    if (resumeAutomation && !paused && !updated.automationPaused) {
      try {
        await resumeChatAutomation(context.chatId);
      } catch (error) {
        await repository.setChatAutomationPaused(ownerId, context.chatId, true);
        publishChatSummary(context.chatId, context.projectId);
        if (bridge.isConnected(context.workerId)) {
          await bridge
            .request(context.workerId, pauseCommand(true))
            .catch(() => undefined);
        }
        throw new ChatAutomationPauseError(
          409,
          `This chat remains paused because its next action could not start: ${errorMessage(error)}`,
        );
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
    return { paused: updated.automationPaused, active };
  };
}
