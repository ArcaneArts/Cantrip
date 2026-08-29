import { z } from "zod";

export const chatExecutionLaneActorSchema = z.enum(["agent", "user"]);
export const chatExecutionLaneStateSchema = z.enum([
  "active",
  "suspended",
  "delivering",
  "released",
]);
const chatExecutionLaneSummaryBaseSchema = z.object({
  id: z.string().min(1),
  chatId: z.string().min(1),
  workerId: z.string().min(1),
  acquiringActor: chatExecutionLaneActorSchema,
  exclusive: z.boolean(),
  purpose: z.string().min(1).nullable(),
  state: chatExecutionLaneStateSchema,
  baseRevision: z.string().min(1).nullable(),
  startingHead: z.string().min(1).nullable(),
  runtimeSessionId: z.string().min(1).nullable(),
  codexThreadId: z.string().min(1).nullable(),
  transitionKind: z.enum(["switch", "release"]).nullable(),
  createdAt: z.string().datetime(),
  activatedAt: z.string().datetime().nullable(),
  releasedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});

export const projectChatExecutionLaneSummarySchema =
  chatExecutionLaneSummaryBaseSchema.extend({
    contextKind: z.literal("project").default("project"),
    worktreeId: z.string().min(1),
    scratchRootId: z.null().default(null),
  });

export const standaloneChatExecutionLaneSummarySchema =
  chatExecutionLaneSummaryBaseSchema.extend({
    contextKind: z.literal("standalone"),
    worktreeId: z.null(),
    scratchRootId: z.string().min(1),
  });

export const contextualChatExecutionLaneSummarySchema = z.union([
  projectChatExecutionLaneSummarySchema,
  standaloneChatExecutionLaneSummarySchema,
]);

export const chatExecutionLaneSummarySchema =
  chatExecutionLaneSummaryBaseSchema.extend({
    contextKind: z.literal("project").optional(),
    worktreeId: z.string().min(1),
    scratchRootId: z.null().optional(),
  });

export const chatExecutionLaneListSchema = z.array(
  chatExecutionLaneSummarySchema,
);

export const chatExecutionLaneReleaseSchema = z.object({
  allowDirty: z.boolean().default(false),
  returnToPrimary: z.boolean().default(true),
});

export type ChatExecutionLaneActor = z.infer<
  typeof chatExecutionLaneActorSchema
>;
export type ChatExecutionLaneState = z.infer<
  typeof chatExecutionLaneStateSchema
>;
export type ProjectChatExecutionLaneSummary = z.infer<
  typeof projectChatExecutionLaneSummarySchema
>;
export type StandaloneChatExecutionLaneSummary = z.infer<
  typeof standaloneChatExecutionLaneSummarySchema
>;
export type ContextualChatExecutionLaneSummary = z.infer<
  typeof contextualChatExecutionLaneSummarySchema
>;
export type ChatExecutionLaneSummary = z.infer<
  typeof chatExecutionLaneSummarySchema
>;
export type ChatExecutionLaneRelease = z.infer<
  typeof chatExecutionLaneReleaseSchema
>;
