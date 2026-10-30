import { z } from "zod";
import {
  chatWireSummarySchema,
  archivedChatWireSummarySchema,
} from "./chats.js";

/** Omission preserves the legacy restore-and-place behavior. */
export const conversationRestoreSchema = z
  .object({ attachToTabLayout: z.boolean().optional() })
  .strict();

export type ConversationRestore = z.infer<typeof conversationRestoreSchema>;

export const conversationCatalogQuerySchema = z
  .object({
    state: z.enum(["active", "archived"]).default("active"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();

const agentFields = {
  contextKind: z.literal("project"),
  experience: z.literal("agent"),
  lastUsedAt: z.string().datetime(),
};
export const conversationWireSummarySchema =
  chatWireSummarySchema.safeExtend(agentFields);
export const archivedConversationWireSummarySchema =
  archivedChatWireSummarySchema.safeExtend(agentFields);
const pageFields = {
  total: z.int().nonnegative(),
  nextCursor: z.string().nullable(),
};
export const conversationCatalogWirePageSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("active"),
      items: z.array(conversationWireSummarySchema),
      ...pageFields,
    })
    .strict(),
  z
    .object({
      state: z.literal("archived"),
      items: z.array(archivedConversationWireSummarySchema),
      ...pageFields,
    })
    .strict(),
]);

export const conversationUsageSchema = z
  .object({
    clientId: z.string().uuid(),
    operationId: z.string().uuid(),
    sequence: z.int().positive(),
  })
  .strict();
export const conversationUsageResultSchema = z
  .object({
    lastUsedAt: z.string().datetime(),
    applied: z.boolean(),
  })
  .strict();

/** Cursor scope is checked by the server; timestamps retain PostgreSQL precision. */
export const conversationCursorSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string().min(1),
    state: z.enum(["active", "archived"]),
    at: z.string().datetime(),
    createdAt: z.string().datetime(),
    id: z.string().min(1),
  })
  .strict();
export type ConversationCatalogQuery = z.infer<
  typeof conversationCatalogQuerySchema
>;
export type ConversationCatalogWirePage = z.infer<
  typeof conversationCatalogWirePageSchema
>;
export type ConversationUsage = z.infer<typeof conversationUsageSchema>;
