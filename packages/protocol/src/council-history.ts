import { z } from "zod";
import { standaloneChatIdentitySchema } from "./chats.js";
import { chatMessageRoleSchema } from "./agent-activity.js";
import { cantripMcpReadResultBaseSchema } from "./cantrip-mcp-tools.js";
import {
  chatMessageProtectedClassificationSchema,
  encryptedChatMessageProtectedContentSchema,
} from "./communication-content.js";

const sequence = z.number().int().nonnegative().safe();
const messageId = z.string().min(1).max(200);
const role = chatMessageRoleSchema;

export const councilHistorySourceRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("head") }).strict(),
  z
    .object({
      kind: z.literal("page"),
      afterSequence: sequence,
      throughSequence: sequence,
    })
    .strict(),
  z
    .object({
      kind: z.literal("changes"),
      afterRevision: sequence,
      afterSequence: sequence,
      throughRevision: sequence,
    })
    .strict(),
]);

export const councilHistoryHeadSchema = z
  .object({
    revision: sequence,
    throughSequence: sequence,
  })
  .strict();

const historyRecordSchema = chatMessageProtectedClassificationSchema.extend({
  id: messageId,
  sequence: sequence.positive(),
  createdAt: z.iso.datetime(),
  protectedContent: encryptedChatMessageProtectedContentSchema,
});

export const councilHistorySourcePageSchema = z
  .object({
    records: z.array(historyRecordSchema).max(128),
  })
  .strict();

export const councilHistorySourceChangesSchema = z
  .object({
    changes: z
      .array(
        z
          .object({
            messageId,
            revision: sequence,
            sequence: sequence.positive(),
            record: historyRecordSchema.nullable(),
          })
          .strict(),
      )
      .max(128),
  })
  .strict();

export const councilHistoryReadInputSchema = z.object({ messageId }).strict();

export const councilHistorySourceRangeSchema = z
  .object({
    availability: z.enum(["available", "unavailable"]),
    records: z.array(historyRecordSchema).max(9),
  })
  .strict();

export const councilHistorySearchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(400),
    mode: z.enum(["terms", "literal"]).default("terms"),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();

const evidence = z
  .object({
    agentId: standaloneChatIdentitySchema,
    messageId,
    sequence: sequence.positive(),
    role,
    source: z.enum(["message", "activity", "attachment"]),
    createdAt: z.iso.datetime(),
    link: z.string().min(1).max(800),
  })
  .strict();

export const councilHistorySearchResultSchema = z
  .object({
    coverage: z.enum(["complete", "partial"]),
    indexedMessages: sequence,
    unavailableMessages: sequence,
    matches: z.array(evidence.extend({ snippet: z.string().max(600) })).max(20),
  })
  .strict();

export const councilHistoryReadResultSchema = z
  .object({
    availability: z.enum(["available", "unavailable"]),
    messages: z
      .array(
        evidence.extend({
          text: z.string().max(1_200),
          attachments: z
            .array(
              z
                .object({ id: messageId, name: z.string().min(1).max(200) })
                .strict(),
            )
            .max(20),
        }),
      )
      .max(9),
  })
  .strict();

export const councilHistorySearchToolOutputSchema =
  cantripMcpReadResultBaseSchema.extend({
    data: councilHistorySearchResultSchema,
  });
export const councilHistoryReadToolOutputSchema =
  cantripMcpReadResultBaseSchema.extend({
    data: councilHistoryReadResultSchema,
  });
