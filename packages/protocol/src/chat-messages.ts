import { z } from "zod";
import { chatAttachmentSummarySchema } from "./attachment-content.js";
import { reasoningEffortSchema } from "./providers.js";
import { chatContextKindSchema } from "./chats.js";
import {
  chatMessageRoleSchema,
  agentMessagePhaseSchema,
  workerObservationEventIdentitySchema,
  codexEventCorrelationSchema,
  agentScopeSchema,
  agentActivitySchema,
} from "./agent-activity.js";

export const chatMessageContentSchema = z.array(
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("text"),
      text: z.string().min(1),
      phase: agentMessagePhaseSchema.nullable().optional(),
      streaming: z.boolean().optional(),
      correlation: codexEventCorrelationSchema.nullable().optional(),
      agentScope: agentScopeSchema.optional(),
      sourceEvent: workerObservationEventIdentitySchema.optional(),
    }),
    z.object({
      type: z.literal("activity"),
      activity: agentActivitySchema,
      sourceEvent: workerObservationEventIdentitySchema.optional(),
    }),
    z.object({
      type: z.literal("attachment"),
      attachment: chatAttachmentSummarySchema,
    }),
  ]),
);

export const chatTurnModeSchema = z.enum(["default", "plan", "goal"]);

export const chatComposerDraftSchema = z
  .object({
    text: z.string().max(100_000),
    mode: chatTurnModeSchema,
    reasoningEffort: reasoningEffortSchema.nullable(),
  })
  .strict();

export const chatMessageCreateSchema = z.object({
  role: chatMessageRoleSchema,
  content: chatMessageContentSchema.min(1),
  mode: chatTurnModeSchema.optional(),
  reasoningEffort: reasoningEffortSchema.nullable().optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const chatMessageSchema = chatMessageCreateSchema
  .omit({ idempotencyKey: true })
  .extend({
    id: z.string().min(1),
    chatId: z.string().min(1),
    contextKind: chatContextKindSchema.default("project"),
    worktreeId: z.string().min(1).nullable(),
    scratchRootId: z.string().min(1).nullable().default(null),
    executionLaneId: z.string().min(1).nullable(),
    sequence: z.number().int().positive(),
    mode: chatTurnModeSchema.default("default"),
    reasoningEffort: reasoningEffortSchema.nullable().default(null),
    modelId: z.string().min(1).nullable(),
    modelRouteId: z.string().min(1).nullable(),
    providerId: z.string().min(1).nullable(),
    providerName: z.string().min(1).nullable(),
    providerModelName: z.string().min(1).nullable(),
    appliedReasoningEffort: reasoningEffortSchema.nullable().default(null),
    reasoningAdjusted: z.boolean().default(false),
    createdAt: z.string().datetime(),
  })
  .superRefine((message, context) => {
    if (
      (message.contextKind === "project" &&
        message.worktreeId !== null &&
        message.scratchRootId === null) ||
      (message.contextKind === "standalone" &&
        message.worktreeId === null &&
        message.scratchRootId !== null)
    ) {
      return;
    }
    context.addIssue({
      code: "custom",
      message: "Chat message execution root is invalid.",
      path: ["contextKind"],
    });
  });

export type ChatComposerDraft = z.infer<typeof chatComposerDraftSchema>;
export type ChatMessageContent = z.infer<typeof chatMessageContentSchema>;
export type ChatMessageCreate = z.infer<typeof chatMessageCreateSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatTurnMode = z.infer<typeof chatTurnModeSchema>;
