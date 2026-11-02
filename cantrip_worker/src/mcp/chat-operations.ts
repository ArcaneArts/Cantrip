import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { clearSensitiveBytes } from "@cantrip/crypto";
import {
  agentChatReadWireSchema,
  agentChatWireDescriptorSchema,
  cantripMcpChatListInputSchema,
  cantripMcpChatReadInputSchema,
  cantripMcpChatSendInputSchema,
  cantripMcpChatWaitInputSchema,
  uniqueChatCommunicationMessages,
  type ChatMessage,
  type ChatCommunication,
  type CantripAgentOperationResult,
} from "@cantrip/protocol";
import { z } from "zod";
import {
  openMessage,
  protectChatMessage,
  protectChatTurn,
} from "../chat-message-encryption.js";
import {
  decodePrivateDisplayLabelForWorker,
  PrivateDisplayLabelWorkerError,
} from "../private-label-encryption.js";
import type { CantripMcpOperationOptions } from "./read-operations.js";

function stableId(value: string) {
  const bytes = createHash("sha256").update(value).digest();
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function executeCantripMcpChatOperation(
  options: CantripMcpOperationOptions,
): Promise<CantripAgentOperationResult> {
  if (
    options.binding.contextKind !== "project" ||
    options.service.ownerId() !== options.binding.ownerId
  )
    throw new Error(
      "Chat tools require the current project's authorized worker.",
    );
  const relay = (
    operation: "chat.list" | "chat.read" | "chat.send" | "chat.wait",
    arguments_: Record<string, unknown>,
  ) =>
    options.execute(
      options.binding,
      { operation, arguments: arguments_ },
      options.requestId,
    );
  const openTitle = async (
    chat: z.infer<typeof agentChatWireDescriptorSchema>,
  ) => {
    try {
      return await decodePrivateDisplayLabelForWorker({
        opaque: chat.titleProtection,
        ownerId: options.binding.ownerId,
        recordKind: "chat",
        rowId: chat.id,
        service: options.service,
      });
    } catch (error) {
      // Display labels are not routing authority; keep exact-ID access usable.
      if (
        error instanceof PrivateDisplayLabelWorkerError &&
        ["corrupt", "missing", "unsupported", "stale"].includes(error.state)
      )
        return `Agent ${chat.id}`;
      throw error;
    }
  };
  const openDescriptor = async (
    chat: z.infer<typeof agentChatWireDescriptorSchema>,
  ) => ({
    id: chat.id,
    title: await openTitle(chat),
    status: chat.status,
    automationPaused: chat.automationPaused,
    modelId: chat.configuration.modelId,
  });
  if (options.request.operation === "chat.list") {
    const args = cantripMcpChatListInputSchema.parse(options.request.arguments);
    const result = await relay("chat.list", args);
    const data = z
      .object({
        chats: z.array(agentChatWireDescriptorSchema).max(100),
        nextCursor: z.number().int().nullable(),
      })
      .strict()
      .parse(result.data);
    return {
      ...result,
      data: {
        chats: await Promise.all(data.chats.map(openDescriptor)),
        nextCursor: data.nextCursor,
      },
    };
  }
  if (options.request.operation === "chat.send") {
    const args = cantripMcpChatSendInputSchema.parse(options.request.arguments);
    const inspected = await relay("chat.read", {
      chatId: args.chatId,
      limit: 1,
    });
    const data = agentChatReadWireSchema.parse(inspected.data);
    if (
      data.chat.id !== args.chatId ||
      data.sender.id !== options.binding.chatId
    )
      throw new Error("The chat delivery context changed.");
    const [source, target] = await Promise.all([
      openDescriptor(data.sender),
      openDescriptor(data.chat),
    ]);
    if (!data.chat.configuration.modelId)
      throw new Error("Choose a model in the receiving chat first.");
    const key = `agent-chat:${source.id}:${target.id}:${args.operationId}`;
    const communication: ChatCommunication = {
      deliveryId: args.operationId,
      sourceChatId: source.id,
      sourceTitle: source.title,
      targetChatId: target.id,
      targetTitle: target.title,
      direction: "received",
    };
    const turn = await protectChatTurn({
      ...data.chat.configuration,
      modelId: data.chat.configuration.modelId,
      idempotencyKey: `${key}:input`,
      messageId: stableId(`${key}:input`),
      promptId: stableId(`${key}:prompt`),
      mode: "default",
      text: args.message,
      chatCommunication: communication,
      service: options.service,
    });
    const sentMessage = await protectChatMessage({
      id: stableId(`${key}:sent`),
      service: options.service,
      message: {
        role: "assistant",
        mode: "default",
        idempotencyKey: `${key}:sent`,
        content: [
          {
            type: "text",
            text: args.message,
            phase: "commentary",
            chatCommunication: { ...communication, direction: "sent" },
          },
        ],
      },
    });
    const receivedMessage = await protectChatMessage({
      id: stableId(`${key}:received`),
      service: options.service,
      message: {
        role: "assistant",
        mode: "default",
        idempotencyKey: `${key}:received`,
        content: [
          {
            type: "text",
            text: args.message,
            phase: "commentary",
            chatCommunication: communication,
          },
        ],
      },
    });
    const result = await relay("chat.send", {
      chatId: target.id,
      operationId: args.operationId,
      turn,
      sentMessage,
      receivedMessage,
    });
    return {
      ...result,
      summary: `Sent an agent message to ${target.title}.`,
      data: {
        ...z.record(z.string(), z.unknown()).parse(result.data),
        message: args.message,
        sourceTitle: source.title,
        targetTitle: target.title,
      },
    };
  }
  const waiting = options.request.operation === "chat.wait";
  const wait = waiting
    ? cantripMcpChatWaitInputSchema.parse(options.request.arguments)
    : null;
  const args = wait
    ? cantripMcpChatReadInputSchema.parse({ chatId: wait.chatId })
    : cantripMcpChatReadInputSchema.parse(options.request.arguments);
  const deadline = performance.now() + (wait?.timeoutMs ?? 0);
  let result: CantripAgentOperationResult;
  let wire: z.infer<typeof agentChatReadWireSchema>;
  let cursor: string;
  do {
    result = await relay(waiting ? "chat.wait" : "chat.read", args);
    wire = agentChatReadWireSchema.parse(result.data);
    if (
      wire.chat.id !== args.chatId ||
      wire.sender.id !== options.binding.chatId
    )
      throw new Error("Cantrip returned history for another chat.");
    cursor = wire.cursor;
    if (!wait || cursor !== wait.afterCursor || performance.now() >= deadline)
      break;
    await delay(Math.min(1000, Math.max(0, deadline - performance.now())));
  } while (true);
  let remaining = args.maxChars;
  let truncated = false;
  const keys = new Map<number, Uint8Array>();
  try {
    const openedMessages: ChatMessage[] = [];
    for (const message of wire.messages) {
      const revision = message.protectedContent.keyRevision;
      if (!keys.has(revision))
        keys.set(
          revision,
          options.service.componentKey("chat-content", revision).key,
        );
      const content = await openMessage({
        message,
        componentKey: keys.get(revision)!,
        ownerId: options.binding.ownerId,
      });
      openedMessages.push({ ...message, content });
    }
    const messages = [];
    for (const message of uniqueChatCommunicationMessages(
      openedMessages,
    ).reverse()) {
      const content = message.content;
      const text = content
        .flatMap((item) => (item.type === "text" ? [item.text] : []))
        .join("\n\n");
      const excerpt = text.slice(0, remaining);
      if (excerpt.length < text.length) truncated = true;
      remaining -= excerpt.length;
      const communication = content.flatMap((item) =>
        item.type === "text" && item.chatCommunication
          ? [item.chatCommunication]
          : [],
      )[0];
      messages.push({
        id: message.id,
        sequence: message.sequence,
        role: communication?.direction === "received" ? "agent" : message.role,
        text: excerpt,
        createdAt: message.createdAt,
        ...(communication ? { chatCommunication: communication } : {}),
      });
    }
    return {
      ...result,
      summary: wait
        ? cursor === wait.afterCursor
          ? "No chat changes before the wait timed out."
          : "The chat changed."
        : `Read ${messages.length} chat messages.`,
      data: {
        chat: await openDescriptor(wire.chat),
        messages: messages.reverse(),
        page: wire.page,
        cursor,
        truncated,
        ...(wait ? { timedOut: cursor === wait.afterCursor } : {}),
      },
    };
  } finally {
    for (const key of keys.values()) clearSensitiveBytes(key);
  }
}
