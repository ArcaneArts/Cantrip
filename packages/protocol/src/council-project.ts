import { z } from "zod";

import {
  agentChatSendWireSchema,
  agentChatWireDescriptorSchema,
  cantripMcpChatSendInputSchema,
} from "./agent-chat-tools.js";
import { cantripMcpReadResultBaseSchema } from "./cantrip-mcp-tools.js";

const projectId = z.string().min(1).max(255);

export const councilProjectSendInputSchema =
  cantripMcpChatSendInputSchema.extend({ projectId });

export const councilProjectSendExchangeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("resolve"),
      projectId,
      chatId: agentChatWireDescriptorSchema.shape.id,
    })
    .strict(),
  z
    .object({
      kind: z.literal("send"),
      projectId,
      delivery: agentChatSendWireSchema,
    })
    .strict(),
]);

export const councilProjectChatTargetWireSchema = z
  .object({
    chat: agentChatWireDescriptorSchema,
    sender: agentChatWireDescriptorSchema,
  })
  .strict();

export const councilProjectSendToolOutputSchema =
  cantripMcpReadResultBaseSchema.extend({
    mutated: z.literal(true),
    data: z
      .object({
        chatId: agentChatWireDescriptorSchema.shape.id,
        sourceChatId: agentChatWireDescriptorSchema.shape.id,
        operationId: z.uuid(),
        messageId: z.string().min(1),
        inputMessageId: z.string().min(1),
        delivery: z.literal("queued"),
      })
      .strict(),
  });
