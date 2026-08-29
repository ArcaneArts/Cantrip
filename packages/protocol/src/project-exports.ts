import { z } from "zod";

export const PROJECT_EXPORT_MAX_CHATS = 20;

export const projectExportTargetSchema = z
  .object({
    kind: z.literal("codex-local"),
  })
  .strict();

export const projectExportMappingSchema = z
  .object({
    id: z.string().min(1).max(100),
    label: z.string().min(1).max(200),
    description: z.string().min(1).max(1_000),
  })
  .strict();

export const projectExportPreviewRequestSchema = z
  .object({
    target: projectExportTargetSchema,
    worktreeId: z.string().min(1).max(200),
  })
  .strict();

export const projectExportTargetInspectionSchema = z
  .object({
    target: projectExportTargetSchema,
    available: z.boolean(),
    destinationLabel: z.string().min(1).max(500).nullable(),
    message: z.string().min(1).max(2_000).nullable(),
    platform: z.string().min(1).max(100),
  })
  .strict();

export const projectExportPreviewSchema = z
  .object({
    target: projectExportTargetSchema,
    targetLabel: z.string().min(1).max(200),
    available: z.boolean(),
    destinationLabel: z.string().min(1).max(500).nullable(),
    message: z.string().min(1).max(2_000).nullable(),
    worker: z
      .object({
        workerId: z.string().min(1).max(200),
        name: z.string().min(1).max(200),
        platform: z.string().min(1).max(100),
      })
      .strict(),
    worktree: z
      .object({
        worktreeId: z.string().min(1).max(200),
        name: z.string().min(1).max(500),
        displayPath: z.string().min(1).max(8_192),
      })
      .strict(),
    maxChats: z.number().int().min(1).max(PROJECT_EXPORT_MAX_CHATS),
    supportedChatExperiences: z.array(z.enum(["agent", "task"])).max(2),
    preserves: z.array(projectExportMappingSchema).max(32),
    flattens: z.array(projectExportMappingSchema).max(32),
  })
  .strict();

export const projectExportCreateSchema = z
  .object({
    operationId: z.string().uuid(),
    target: projectExportTargetSchema,
    worktreeId: z.string().min(1).max(200),
    chatIds: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(PROJECT_EXPORT_MAX_CHATS),
  })
  .strict()
  .refine((input) => new Set(input.chatIds).size === input.chatIds.length, {
    message: "Project export chat ids must be unique.",
    path: ["chatIds"],
  });

export const projectExportChatResultSchema = z
  .object({
    chatId: z.string().min(1).max(200),
    threadId: z.string().min(1).max(500),
    destinationLabel: z.string().min(1).max(500),
    messageCount: z.number().int().nonnegative(),
    reused: z.boolean(),
  })
  .strict();

export const projectExportItemOutcomeSchema = z.discriminatedUnion("status", [
  projectExportChatResultSchema.extend({ status: z.literal("exported") }),
  z
    .object({
      status: z.literal("failed"),
      chatId: z.string().min(1).max(200),
      code: z.enum([
        "target-unavailable",
        "encryption-unavailable",
        "runtime-incompatible",
        "worker-error",
      ]),
      message: z.string().min(1).max(2_000),
    })
    .strict(),
]);

export const projectExportResultSchema = z
  .object({
    operationId: z.string().uuid(),
    target: projectExportTargetSchema,
    workerId: z.string().min(1).max(200),
    worktreeId: z.string().min(1).max(200),
    outcomes: z
      .array(projectExportItemOutcomeSchema)
      .min(1)
      .max(PROJECT_EXPORT_MAX_CHATS),
  })
  .strict();

export const projectExportChatBeginResultSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("upload") }).strict(),
    projectExportChatResultSchema
      .omit({ reused: true })
      .extend({ status: z.literal("exported"), reused: z.literal(true) })
      .strict(),
  ],
);

export type ProjectExportTarget = z.infer<typeof projectExportTargetSchema>;
export type ProjectExportMapping = z.infer<typeof projectExportMappingSchema>;
export type ProjectExportPreviewRequest = z.infer<
  typeof projectExportPreviewRequestSchema
>;
export type ProjectExportTargetInspection = z.infer<
  typeof projectExportTargetInspectionSchema
>;
export type ProjectExportPreview = z.infer<typeof projectExportPreviewSchema>;
export type ProjectExportCreate = z.infer<typeof projectExportCreateSchema>;
export type ProjectExportChatResult = z.infer<
  typeof projectExportChatResultSchema
>;
export type ProjectExportItemOutcome = z.infer<
  typeof projectExportItemOutcomeSchema
>;
export type ProjectExportResult = z.infer<typeof projectExportResultSchema>;
export type ProjectExportChatBeginResult = z.infer<
  typeof projectExportChatBeginResultSchema
>;
