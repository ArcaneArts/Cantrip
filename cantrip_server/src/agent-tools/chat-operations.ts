import { createHash } from "node:crypto";
import {
  agentChatReadWireSchema,
  agentChatSendWireSchema,
  cantripMcpChatListInputSchema,
  cantripMcpChatReadInputSchema,
  type CantripAgentOperationRequest,
  type CantripAgentOperationResult,
  type ChatMessageOpaqueSummary,
} from "@cantrip/protocol";
import type {
  ChatExecutionContext,
  ServerRepository,
} from "../db/repository.js";
import { managedConsoleSessionContext } from "../terminals/managed-session.js";
import { mutateManagedGuiQueue } from "../app/runtime/managed-queue-input.js";
import { CliCommandRequestError } from "./errors.js";

export interface AgentChatOperationsDependencies {
  applicationOwnerId(): string;
  repository: ServerRepository;
  publishEncryptedChatMessage(message: ChatMessageOpaqueSummary): void;
  dispatchNextQueuedPrompt(chatId: string): Promise<void>;
}

/** The server routes opaque payloads; titles and messages are opened only on the worker. */
export function createAgentChatOperations(
  deps: AgentChatOperationsDependencies,
) {
  return async (
    source: ChatExecutionContext,
    call: CantripAgentOperationRequest,
  ): Promise<CantripAgentOperationResult> => {
    if (source.contextKind !== "project" || source.experience !== "agent")
      throw new CliCommandRequestError(
        "invalid",
        403,
        "Chat tools require a project Agent chat.",
      );
    const owner = deps.applicationOwnerId();
    const chats = (
      await deps.repository.listChats(owner, source.projectId)
    ).filter((chat) => chat.experience === "agent");
    const sender = chats.find((chat) => chat.id === source.chatId);
    if (!sender)
      throw new CliCommandRequestError(
        "not-found",
        404,
        "The sending chat is unavailable.",
      );
    const defaultModelId = chats.some((chat) => chat.modelId === null)
      ? (await deps.repository.getUserSettings(owner)).defaultModelId
      : null;
    const descriptor = (chat: typeof sender) => ({
      id: chat.id,
      titleProtection: chat.titleProtection,
      status: chat.status,
      automationPaused: chat.automationPaused,
      configuration: {
        modelId: chat.modelId ?? defaultModelId,
        reasoningEffort: chat.reasoningEffort,
        customSubagentModel: chat.customSubagentModel ?? false,
        subagentModelId: chat.subagentModelId ?? null,
        subagentReasoningEffort: chat.subagentReasoningEffort ?? null,
      },
    });
    const result = (
      summary: string,
      data: unknown,
      mutated = false,
    ): CantripAgentOperationResult => ({
      summary,
      data,
      mutated,
      target: null,
      worktreeId: source.worktreeId,
      continuationScheduled: false,
    });
    if (call.operation === "chat.list") {
      const input = cantripMcpChatListInputSchema.parse(call.arguments);
      const selected = chats.slice(input.cursor, input.cursor + input.limit);
      return result(`Found ${selected.length} project chats.`, {
        chats: selected.map(descriptor),
        nextCursor:
          input.cursor + selected.length < chats.length
            ? input.cursor + selected.length
            : null,
      });
    }
    const target = chats.find((chat) => chat.id === call.arguments.chatId);
    if (!target)
      throw new CliCommandRequestError(
        "not-found",
        404,
        "Chat not found in the current project.",
      );
    if (call.operation === "chat.read" || call.operation === "chat.wait") {
      const input = cantripMcpChatReadInputSchema.parse(call.arguments);
      const page = await deps.repository.listEncryptedMessagePage(
        owner,
        target.id,
        {
          limit: input.limit,
          beforeSequence: input.beforeSequence,
        },
      );
      const latest =
        input.limit === 20 && input.beforeSequence === undefined
          ? page
          : await deps.repository.listEncryptedMessagePage(owner, target.id, {
              limit: 20,
            });
      const cursor = createHash("sha256")
        .update(
          JSON.stringify({
            chatId: target.id,
            status: target.status,
            paused: target.automationPaused,
            messages: latest.messages.map((message) => [
              message.id,
              message.sequence,
              message.protectedContent,
            ]),
          }),
        )
        .digest("hex");
      // Keep the opaque relay below the worker's 8 MiB response ceiling, even
      // when individual messages are large. Older rows remain page-addressable.
      let bytes = 0;
      let first = page.messages.length;
      while (first > 0) {
        const size = Buffer.byteLength(
          JSON.stringify(page.messages[first - 1]),
        );
        if (bytes + size > 6 * 1024 * 1024) break;
        bytes += size;
        first--;
      }
      if (first > 0) {
        page.messages = page.messages.slice(first);
        const oldest = page.messages[0];
        page.page = {
          ...page.page,
          hasMore: true,
          nextBeforeSequence: oldest?.sequence ?? page.page.nextBeforeSequence,
          oldestSequence: oldest?.sequence ?? null,
          startsAtUserTurn: oldest?.role === "user",
        };
      }
      return result(
        "Read protected chat history.",
        agentChatReadWireSchema.parse({
          cursor,
          chat: descriptor(target),
          sender: descriptor(sender),
          ...page,
        }),
      );
    }
    const input = agentChatSendWireSchema.parse(call.arguments);
    if (target.id === sender.id)
      throw new CliCommandRequestError(
        "conflict",
        409,
        "Send to another chat, not the current chat.",
      );
    const expectedKey = `agent-chat:${source.chatId}:${target.id}:${input.operationId}`;
    if (
      input.turn.message.classification.role !== "user" ||
      input.sentMessage.classification.role !== "assistant" ||
      input.receivedMessage.classification.role !== "assistant" ||
      input.receivedMessage.idempotencyKey !== `${expectedKey}:received` ||
      input.receivedMessage.classification.mode !== "default" ||
      input.receivedMessage.classification.attachmentIds.length ||
      input.turn.message.idempotencyKey !== `${expectedKey}:input` ||
      input.turn.queuedPrompt.idempotencyKey !== `${expectedKey}:input` ||
      input.sentMessage.idempotencyKey !== `${expectedKey}:sent` ||
      input.turn.message.classification.mode !== "default" ||
      input.turn.queuedPrompt.classification.mode !== "default" ||
      input.turn.message.classification.attachmentIds.length ||
      input.turn.queuedPrompt.classification.attachmentIds.length ||
      input.sentMessage.classification.attachmentIds.length ||
      input.turn.queuedPrompt.protectedNativeInput !== undefined ||
      input.turn.queuedPrompt.nativeClientUserMessageId !== undefined ||
      (input.turn.queuedPrompt.executionMethod !== undefined &&
        input.turn.queuedPrompt.executionMethod !== "turn/start") ||
      (input.turn.queuedPrompt.nativeAction !== undefined &&
        input.turn.queuedPrompt.nativeAction !== "literal") ||
      input.turn.queuedPrompt.frozen ||
      input.turn.queuedPrompt.worktreeId !== null
    )
      throw new CliCommandRequestError(
        "invalid",
        403,
        "Invalid agent message delivery envelope.",
      );
    const context = await deps.repository.getChatExecutionContext(
      owner,
      target.id,
    );
    if (
      !context ||
      context.contextKind !== "project" ||
      context.projectId !== source.projectId ||
      context.experience !== "agent"
    )
      throw new CliCommandRequestError(
        "not-found",
        404,
        "The receiving chat is unavailable.",
      );
    const { received, sent } =
      await deps.repository.agentChatDelivery.transaction(
        owner,
        source.chatId,
        target.id,
        async (repository) => {
          const priorReceived =
            await repository.getEncryptedMessageByIdempotencyKey(
              owner,
              target.id,
              `${expectedKey}:received`,
            );
          const priorSent =
            await repository.getEncryptedMessageByIdempotencyKey(
              owner,
              source.chatId,
              `${expectedKey}:sent`,
            );
          if (priorReceived && priorSent)
            return { received: priorReceived, sent: priorSent };
          const current = await repository.getChatExecutionContext(
            owner,
            target.id,
          );
          if (
            !current ||
            current.contextKind !== "project" ||
            current.projectId !== source.projectId ||
            current.experience !== "agent"
          )
            throw new CliCommandRequestError(
              "not-found",
              404,
              "The receiving chat is unavailable.",
            );
          // The caller never selects the receiver's model or permission profile.
          const configuration = current.modelConfiguration;
          const modelId =
            configuration.modelId ??
            (await repository.getUserSettings(owner)).defaultModelId;
          if (!modelId)
            throw new CliCommandRequestError(
              "conflict",
              409,
              "Choose a model in the receiving chat first.",
            );
          const pendingMessage = {
            ...input.turn.message,
            reasoningEffort: configuration.reasoningEffort,
          };
          const prompt = {
            ...input.turn.queuedPrompt,
            ...configuration,
            modelId,
            pendingMessage,
          };
          const queued = managedConsoleSessionContext(current)
            ? ((
                await mutateManagedGuiQueue(
                  repository,
                  owner,
                  current,
                  { kind: "add", prompt, attachments: [] },
                  {
                    operationId: `agent-chat:queue:${source.chatId}:${target.id}:${input.operationId}`,
                    resumeAutonomy: false,
                  },
                )
              ).acceptedItem ??
              (await repository.getEncryptedQueuedPrompt(owner, prompt.id)))
            : await repository.createEncryptedQueuedPrompt(
                owner,
                target.id,
                prompt,
                [],
              );
          if (!queued)
            throw new Error("The receiving chat could not queue the message.");
          const received = await repository.appendEncryptedMessage(
            owner,
            target.id,
            input.receivedMessage,
          );
          const sent = await repository.appendEncryptedMessage(
            owner,
            source.chatId,
            input.sentMessage,
          );
          if (!received || !sent)
            throw new Error("Agent message history could not be saved.");
          return { received, sent };
        },
      );
    deps.publishEncryptedChatMessage(received);
    deps.publishEncryptedChatMessage(sent);
    void deps.dispatchNextQueuedPrompt(target.id);
    return result(
      "Agent message delivered to the receiving chat queue.",
      {
        chatId: target.id,
        sourceChatId: source.chatId,
        operationId: input.operationId,
        messageId: received.id,
        delivery: "queued",
      },
      true,
    );
  };
}
