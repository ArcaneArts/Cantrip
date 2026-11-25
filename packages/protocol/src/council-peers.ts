import { z } from "zod";
import { cantripMcpReadResultBaseSchema } from "./cantrip-mcp-tools.js";
import { encryptedChatTurnCreateSchema } from "./chat-runtime.js";
import { councilPeerMessageSourceSchema } from "./council-input.js";
import {
  chatMessageOpaqueContentSchema,
  chatMessageProtectedClassificationSchema,
  encryptedChatMessageProtectedContentSchema,
} from "./communication-content.js";
import { modelConfigurationSchema } from "./model-configuration.js";
import { privateDisplayLabelOpaqueSchema } from "./private-labels.js";

export const councilPeerSendInputSchema = z
  .object({
    recipientAgentId: z.uuid(),
    operationId: z.uuid(),
    message: z.string().trim().min(1).max(12_000),
  })
  .strict();

export const councilPeerSendExchangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("resolve"), recipientAgentId: z.uuid() }).strict(),
  z
    .object({
      kind: z.literal("send"),
      source: councilPeerMessageSourceSchema,
      turn: encryptedChatTurnCreateSchema,
      sentMessage: chatMessageOpaqueContentSchema,
    })
    .strict(),
]);

export const councilPeerTargetWireSchema = z
  .object({
    senderAgentId: z.uuid(),
    recipientAgentId: z.uuid(),
    senderTitle: privateDisplayLabelOpaqueSchema,
    recipientTitle: privateDisplayLabelOpaqueSchema,
    configuration: modelConfigurationSchema,
  })
  .strict();

export const councilPeerSendOutputSchema =
  cantripMcpReadResultBaseSchema.extend({
    mutated: z.literal(true),
    data: councilPeerMessageSourceSchema.extend({
      inputMessageId: z.uuid(),
      messageId: z.uuid(),
      delivery: z.literal("queued"),
    }),
  });

export const councilPeerPageQuerySchema = z
  .object({ before: z.uuid().optional() })
  .strict();

export const councilPeerPageSchema = z
  .object({
    messages: z
      .array(
        chatMessageProtectedClassificationSchema.extend({
          id: z.uuid(),
          senderAgentId: z.uuid(),
          recipientAgentId: z.uuid(),
          operationId: z.uuid(),
          createdAt: z.iso.datetime(),
          senderHistoryId: z.string().min(1).max(200),
          recipientHistoryId: z.string().min(1).max(200).nullable(),
          protectedContent: encryptedChatMessageProtectedContentSchema,
        }),
      )
      .max(30),
    nextBefore: z.uuid().nullable(),
  })
  .strict();
