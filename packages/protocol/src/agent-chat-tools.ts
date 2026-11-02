import { z } from "zod";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";
import { modelConfigurationSchema } from "./model-configuration.js";
import {
  chatMessageOpaqueSummarySchema,
  chatMessageOpaqueContentSchema,
} from "./communication-content.js";
import {
  encryptedChatTurnCreateSchema,
  chatMessagePageInfoSchema,
} from "./chat-runtime.js";

const chatId = z.string().min(1).max(200);
export const cantripMcpChatListInputSchema = z
  .object({
    cursor: z.number().int().min(0).max(100_000).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export const cantripMcpChatReadInputSchema = z
  .object({
    chatId,
    beforeSequence: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(50).default(20),
    maxChars: z.number().int().min(1).max(100_000).default(20_000),
  })
  .strict();
export const cantripMcpChatSendInputSchema = z
  .object({
    chatId,
    operationId: z.string().uuid(),
    message: z.string().trim().min(1).max(50_000),
  })
  .strict();
export const cantripMcpChatWaitInputSchema = z
  .object({
    chatId,
    afterCursor: z.string().regex(/^[a-f0-9]{64}$/),
    timeoutMs: z.number().int().min(0).max(30_000).default(15_000),
  })
  .strict();

export const agentChatWireDescriptorSchema = z
  .object({
    id: chatId,
    titleProtection: privateDisplayLabelOpaqueSchema,
    status: z.string().min(1).max(100),
    automationPaused: z.boolean(),
    configuration: modelConfigurationSchema,
  })
  .strict();
export const agentChatReadWireSchema = z
  .object({
    cursor: z.string().regex(/^[a-f0-9]{64}$/),
    chat: agentChatWireDescriptorSchema,
    sender: agentChatWireDescriptorSchema,
    messages: z.array(chatMessageOpaqueSummarySchema).max(500),
    page: chatMessagePageInfoSchema,
  })
  .strict();
export const agentChatSendWireSchema = z
  .object({
    chatId,
    operationId: z.string().uuid(),
    turn: encryptedChatTurnCreateSchema,
    sentMessage: chatMessageOpaqueContentSchema,
    receivedMessage: chatMessageOpaqueContentSchema,
  })
  .strict();
