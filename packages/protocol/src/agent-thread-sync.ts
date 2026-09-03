import { z } from "zod";
import { boundedJsonObjectSchema } from "./bounded-json.js";
import { chatMessageOpaqueContentSchema } from "./communication-content.js";
import { taskOperationRelayRequestSchema } from "./tasks.js";
import {
  agentMessagePhaseSchema,
  codexEventCorrelationSchema,
  agentScopeSchema,
  agentTokenUsageSchema,
  agentActivitySchema,
} from "./agent-activity.js";

export const agentTurnResultSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1).optional(),
  text: z.string(),
  structuredResult: z.unknown().optional(),
  measuredUsage: agentTokenUsageSchema.nullable().optional(),
  status: z.literal("completed"),
});

export const agentTurnResultModeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("visible") }),
  z.object({
    kind: z.literal("structured"),
    outputSchema: boundedJsonObjectSchema,
  }),
  z.object({
    kind: z.literal("task-encrypted"),
    operation: taskOperationRelayRequestSchema,
  }),
  z.object({
    kind: z.literal("task-message-encrypted"),
    messageId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(200),
  }),
  z.object({
    kind: z.literal("chat-message-encrypted"),
    messageId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(200),
  }),
]);

export const chatMessageRelayResultSchema = z
  .object({
    message: chatMessageOpaqueContentSchema.nullable(),
  })
  .strict();

export const normalizedAgentMessageSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  phase: agentMessagePhaseSchema.nullable(),
  streaming: z.boolean().optional(),
  correlation: codexEventCorrelationSchema.nullable().optional(),
  agentScope: agentScopeSchema.optional(),
});

export const agentThreadSyncItemSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("userMessage"),
      id: z.string().min(1),
      text: z.string(),
      externalAttachmentIds: z.array(z.string().uuid()).max(20).default([]),
    })
    .refine(
      (item) =>
        item.text.trim().length > 0 || item.externalAttachmentIds.length > 0,
      { message: "User messages require text or an external attachment." },
    ),
  z.object({
    type: z.literal("agentMessage"),
    ...normalizedAgentMessageSchema.shape,
  }),
  z.object({
    type: z.literal("activity"),
    activity: agentActivitySchema,
  }),
]);

export const agentThreadSyncSchema = z.object({
  threadId: z.string().min(1),
  status: z.enum(["idle", "running", "failed"]),
  turns: z.array(
    z.object({
      id: z.string().min(1),
      status: z.enum(["completed", "failed", "interrupted", "inProgress"]),
      startedAt: z.number().int().nonnegative().nullable(),
      completedAt: z.number().int().nonnegative().nullable(),
      durationMs: z.number().int().nonnegative().nullable(),
      items: z.array(agentThreadSyncItemSchema),
    }),
  ),
});

export type AgentTurnResult = z.infer<typeof agentTurnResultSchema>;
export type AgentTurnResultMode = z.infer<typeof agentTurnResultModeSchema>;
export type NormalizedAgentMessage = z.infer<
  typeof normalizedAgentMessageSchema
>;
export type AgentThreadSync = z.infer<typeof agentThreadSyncSchema>;
export type AgentThreadSyncItem = z.infer<typeof agentThreadSyncItemSchema>;
