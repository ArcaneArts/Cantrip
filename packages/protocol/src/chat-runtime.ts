import { z } from "zod";
import {
  chatPlanOpaqueStateSchema,
  chatMessageOpaqueContentSchema,
  chatMessageOpaqueSummarySchema,
  queuedPromptOpaqueContentSchema,
} from "./communication-content.js";
import { modelConfigurationSchema } from "./model-configuration.js";
import {
  chatAttachmentListSchema,
  chatAttachmentOpaqueListSchema,
} from "./attachment-content.js";
import {
  taskGoalObjectiveOpaqueSnapshotSchema,
  taskMessageOpaqueSummarySchema,
  taskOpaqueSummarySchema,
} from "./tasks.js";
import {
  reasoningEffortSchema,
  modelReasoningEffortOptionSchema,
} from "./providers.js";
import { chatTurnModeSchema, chatMessageSchema } from "./chat-messages.js";

export const chatMessageListSchema = z.array(chatMessageSchema);

export const CHAT_MESSAGE_PAGE_DEFAULT_LIMIT = 150;
export const CHAT_MESSAGE_PAGE_MAX_LIMIT = 200;
export const CHAT_MESSAGE_PAGE_BOUNDARY_MAX = 500;

export const chatMessagePageQuerySchema = z
  .object({
    beforeSequence: z.coerce.number().int().positive().optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(CHAT_MESSAGE_PAGE_MAX_LIMIT)
      .default(CHAT_MESSAGE_PAGE_DEFAULT_LIMIT),
  })
  .strict();

export const chatMessagePageInfoSchema = z
  .object({
    hasMore: z.boolean(),
    nextBeforeSequence: z.number().int().positive().nullable(),
    oldestSequence: z.number().int().positive().nullable(),
    newestSequence: z.number().int().positive().nullable(),
    startsAtUserTurn: z.boolean(),
  })
  .strict();

export const chatMessageWireListSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("task-encrypted"),
      messages: z.array(taskMessageOpaqueSummarySchema).max(100_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("chat-encrypted"),
      messages: z.array(chatMessageOpaqueSummarySchema).max(100_000),
    })
    .strict(),
]);

export const chatMessageWirePageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("task-encrypted"),
      messages: z
        .array(taskMessageOpaqueSummarySchema)
        .max(CHAT_MESSAGE_PAGE_BOUNDARY_MAX),
      page: chatMessagePageInfoSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("chat-encrypted"),
      messages: z
        .array(chatMessageOpaqueSummarySchema)
        .max(CHAT_MESSAGE_PAGE_BOUNDARY_MAX),
      page: chatMessagePageInfoSchema,
    })
    .strict(),
]);

export const encryptedQueuedPromptSchema = queuedPromptOpaqueContentSchema
  .extend({
    chatId: z.string().min(1).max(200),
    attachments: chatAttachmentOpaqueListSchema.default([]),
    position: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const encryptedQueuedPromptListSchema = z
  .array(encryptedQueuedPromptSchema)
  .max(1_000);

export const encryptedChatTurnCreateSchema = z
  .object({
    message: chatMessageOpaqueContentSchema,
    queuedPrompt: queuedPromptOpaqueContentSchema,
    modelId: z.string().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      JSON.stringify(value.message) !==
      JSON.stringify(value.queuedPrompt.pendingMessage)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "The queued prompt must carry the submitted encrypted message.",
        path: ["queuedPrompt", "pendingMessage"],
      });
    }
    if (
      value.modelId !== undefined &&
      value.modelId !== value.queuedPrompt.modelId
    ) {
      context.addIssue({
        code: "custom",
        message: "The queued prompt model must match the submitted model.",
        path: ["queuedPrompt", "modelId"],
      });
    }
  });

export const projectAutomationProtectedDispatchResultSchema = z
  .object({
    allowed: z.boolean(),
    protectedTurn: encryptedChatTurnCreateSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.allowed !== Boolean(value.protectedTurn)) {
      context.addIssue({
        code: "custom",
        message: "Allowed automation dispatches require a protected turn.",
        path: ["protectedTurn"],
      });
    }
  });

export const encryptedQueuedPromptUpdateSchema = z
  .object({ prompt: queuedPromptOpaqueContentSchema })
  .strict();

export const encryptedChatPromptSubmitResultSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("started"),
        message: chatMessageOpaqueSummarySchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("queued"),
        prompt: encryptedQueuedPromptSchema,
      })
      .strict(),
  ],
);

export const chatTurnCreateSchema = z
  .object({
    text: z.string().trim().max(100_000).default(""),
    attachmentIds: z.array(z.string().min(1)).max(20).default([]),
    mode: chatTurnModeSchema.default("default"),
    idempotencyKey: z.string().min(1).max(200),
    modelId: z.string().min(1).optional(),
    reasoningEffort: reasoningEffortSchema.nullable().optional(),
  })
  .refine(
    ({ attachmentIds, text }) => text.length > 0 || attachmentIds.length > 0,
    { message: "A prompt needs text or at least one attachment." },
  )
  .refine(({ mode, text }) => mode !== "goal" || text.length > 0, {
    message: "Goal mode needs a text objective.",
  });

export const queuedPromptSchema = z.object({
  id: z.string().min(1),
  chatId: z.string().min(1),
  text: z.string().trim().max(100_000),
  attachments: chatAttachmentListSchema.default([]),
  mode: chatTurnModeSchema.default("default"),
  modelId: z.string().min(1),
  reasoningEffort: reasoningEffortSchema.nullable().default(null),
  customSubagentModel: z.boolean().default(false),
  subagentModelId: z.string().min(1).nullable().default(null),
  subagentReasoningEffort: reasoningEffortSchema.nullable().default(null),
  worktreeId: z.string().min(1).nullable(),
  position: z.number().int().nonnegative(),
  frozen: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const queuedPromptListSchema = z.array(queuedPromptSchema);

export const queuedPromptCreateSchema = chatTurnCreateSchema.extend({
  frozen: z.boolean().default(false),
  worktreeId: z.string().min(1).nullable().default(null),
});

export const queuedPromptUpdateSchema = z
  .object({
    text: z.string().trim().max(100_000).optional(),
    attachmentIds: z.array(z.string().min(1)).max(20).optional(),
    mode: chatTurnModeSchema.optional(),
    reasoningEffort: reasoningEffortSchema.nullable().optional(),
    frozen: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.text !== undefined ||
      value.attachmentIds !== undefined ||
      value.mode !== undefined ||
      value.reasoningEffort !== undefined ||
      value.frozen !== undefined,
    { message: "At least one queued prompt field is required." },
  );

export const queuedPromptOrderSchema = z.object({
  ids: z.array(z.string().min(1)).max(1_000),
});

export const chatModelUpdateSchema = z.object({
  modelId: z.string().min(1),
});

export const chatModelConfigurationUpdateSchema =
  modelConfigurationSchema.refine(
    (configuration) => configuration.modelId !== null,
    {
      message: "A root model must be selected.",
      path: ["modelId"],
    },
  );

export const chatRuntimeSelectionSchema = z.object({
  modelRouteId: z.string().min(1).nullable(),
  providerAccountId: z.string().min(1).nullable(),
});

export const chatReasoningOptionSchema = modelReasoningEffortOptionSchema;

export const chatReasoningStateSchema = z.object({
  modelId: z.string().min(1),
  reasoningEffort: reasoningEffortSchema.nullable(),
  options: z.array(chatReasoningOptionSchema).max(32),
  reasoningMandatory: z.boolean(),
  incompleteMetadata: z.boolean(),
});

export const chatReasoningUpdateSchema = z.object({
  reasoningEffort: reasoningEffortSchema.nullable(),
});

export const chatTurnAcceptedSchema = z.object({
  accepted: z.literal(true),
  message: chatMessageSchema,
});

export const chatPromptSubmitResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("started"), message: chatMessageSchema }),
  z.object({ status: z.literal("queued"), prompt: queuedPromptSchema }),
]);

export const chatPromptSteerResultSchema = z.object({
  steered: z.literal(true),
  message: chatMessageSchema,
});

export const encryptedChatPromptSteerResultSchema = z
  .object({
    steered: z.literal(true),
    message: chatMessageOpaqueSummarySchema,
  })
  .strict();

export const chatCompactAcceptedSchema = z.object({
  accepted: z.literal(true),
});

export const chatInterruptAcceptedSchema = z.object({
  interrupted: z.boolean(),
});

export const chatTurnRollbackAcceptedSchema = z.object({
  rolledBack: z.literal(true),
});

export const chatPauseUpdateSchema = z.object({
  paused: z.boolean(),
});

export const chatPauseStateSchema = z.object({
  paused: z.boolean(),
});

export const chatPauseRuntimeStateSchema = z
  .object({
    paused: z.boolean(),
    active: z
      .object({
        threadId: z.string().min(1).max(500),
        turnId: z.string().min(1).max(500),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const threadGoalStatusSchema = z.enum([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);

export const threadGoalSchema = z.object({
  threadId: z.string().min(1),
  objective: z.string().min(1),
  status: threadGoalStatusSchema,
  tokenBudget: z.number().int().positive().nullable(),
  tokensUsed: z.number().int().nonnegative(),
  timeUsedSeconds: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const chatGoalResponseSchema = z.object({
  goal: threadGoalSchema.nullable(),
});

export const chatGoalWireResponseSchema = z.union([
  z
    .object({
      kind: z.literal("task-encrypted"),
      goal: taskGoalObjectiveOpaqueSnapshotSchema.nullable(),
    })
    .strict(),
  chatGoalResponseSchema,
]);

export const chatGoalCreateSchema = z.object({
  objective: z.string().trim().min(1).max(100_000),
  tokenBudget: z.number().int().positive().nullable().optional(),
});

export const chatGoalUpdateSchema = z.object({
  status: z.enum(["active", "paused"]),
});

export const chatGoalClearSchema = z.object({
  cleared: z.boolean(),
});

export const planModeSchema = z.enum(["default", "plan"]);

export const planStepSchema = z.object({
  step: z.string().min(1),
  status: z.enum(["pending", "inProgress", "completed"]),
});

export const planQuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string(),
});

export const planQuestionSchema = z.object({
  id: z.string().min(1),
  header: z.string().min(1),
  question: z.string().min(1),
  isOther: z.boolean(),
  isSecret: z.boolean(),
  options: z.array(planQuestionOptionSchema).min(1).nullable(),
});

export const pendingPlanQuestionSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  questions: z.array(planQuestionSchema).min(1).max(3),
  createdAt: z.string().datetime(),
});

export const chatPlanStateSchema = z.object({
  mode: planModeSchema,
  explanation: z.string().nullable(),
  steps: z.array(planStepSchema),
  question: pendingPlanQuestionSchema.nullable(),
});

export const encryptedChatPlanWireStateSchema = z
  .object({
    kind: z.literal("chat-encrypted"),
    chatId: z.string().min(1).max(200),
    mode: planModeSchema,
    hasQuestion: z.boolean(),
    state: chatPlanOpaqueStateSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.state &&
      value.state.classification.hasQuestion !== value.hasQuestion
    ) {
      context.addIssue({
        code: "custom",
        message: "Encrypted plan question metadata is inconsistent.",
        path: ["state", "classification", "hasQuestion"],
      });
    }
    if (!value.state && value.hasQuestion) {
      context.addIssue({
        code: "custom",
        message: "Pending encrypted plans require protected state.",
        path: ["state"],
      });
    }
  });

export const projectTaskWorkloadOpaqueItemSchema = z
  .object({
    task: taskOpaqueSummarySchema,
    plan: encryptedChatPlanWireStateSchema,
    messages: z
      .array(taskMessageOpaqueSummarySchema)
      .max(CHAT_MESSAGE_PAGE_BOUNDARY_MAX),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.plan.chatId !== value.task.chatId ||
      value.messages.some((message) => message.chatId !== value.task.chatId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Task workload material must belong to the same Task Chat.",
      });
    }
  });

export const projectTaskWorkloadOpaqueSchema = z
  .object({
    projectId: z.string().min(1).max(200),
    items: z.array(projectTaskWorkloadOpaqueItemSchema).max(10_000),
  })
  .strict();

export const chatPlanUpdateSchema = z.object({ mode: planModeSchema });

export const chatPlanAnswerSchema = z.object({
  answers: z.record(
    z.string().min(1),
    z.array(z.string().trim().min(1).max(10_000)).min(1).max(16),
  ),
});

export const chatPlanAcceptedSchema = z.object({
  accepted: z.literal(true),
  requestKey: z.string().min(1).optional(),
});

export type ChatMessagePageQuery = z.infer<typeof chatMessagePageQuerySchema>;
export type ChatMessagePageInfo = z.infer<typeof chatMessagePageInfoSchema>;
export type ChatMessageWirePage = z.infer<typeof chatMessageWirePageSchema>;
export type EncryptedChatTurnCreate = z.infer<
  typeof encryptedChatTurnCreateSchema
>;
export type EncryptedChatPromptSubmitResult = z.infer<
  typeof encryptedChatPromptSubmitResultSchema
>;
export type EncryptedQueuedPrompt = z.infer<typeof encryptedQueuedPromptSchema>;
export type EncryptedQueuedPromptUpdate = z.infer<
  typeof encryptedQueuedPromptUpdateSchema
>;
export type ChatTurnCreate = z.infer<typeof chatTurnCreateSchema>;
export type QueuedPrompt = z.infer<typeof queuedPromptSchema>;
export type QueuedPromptCreate = z.infer<typeof queuedPromptCreateSchema>;
export type QueuedPromptUpdate = z.infer<typeof queuedPromptUpdateSchema>;
export type QueuedPromptOrder = z.infer<typeof queuedPromptOrderSchema>;
export type ChatModelUpdate = z.infer<typeof chatModelUpdateSchema>;
export type ChatModelConfigurationUpdate = z.infer<
  typeof chatModelConfigurationUpdateSchema
>;
export type ChatRuntimeSelection = z.infer<typeof chatRuntimeSelectionSchema>;
export type ChatReasoningOption = z.infer<typeof chatReasoningOptionSchema>;
export type ChatReasoningState = z.infer<typeof chatReasoningStateSchema>;
export type ChatReasoningUpdate = z.infer<typeof chatReasoningUpdateSchema>;
export type ChatCompactAccepted = z.infer<typeof chatCompactAcceptedSchema>;
export type ChatInterruptAccepted = z.infer<typeof chatInterruptAcceptedSchema>;
export type ChatPauseUpdate = z.infer<typeof chatPauseUpdateSchema>;
export type ChatPauseState = z.infer<typeof chatPauseStateSchema>;
export type ChatPauseRuntimeState = z.infer<typeof chatPauseRuntimeStateSchema>;
export type ThreadGoalStatus = z.infer<typeof threadGoalStatusSchema>;
export type ThreadGoal = z.infer<typeof threadGoalSchema>;
export type ChatGoalResponse = z.infer<typeof chatGoalResponseSchema>;
export type ChatGoalCreate = z.infer<typeof chatGoalCreateSchema>;
export type ChatGoalUpdate = z.infer<typeof chatGoalUpdateSchema>;
export type ChatGoalClear = z.infer<typeof chatGoalClearSchema>;
export type PlanMode = z.infer<typeof planModeSchema>;
export type PlanStep = z.infer<typeof planStepSchema>;
export type PlanQuestionOption = z.infer<typeof planQuestionOptionSchema>;
export type PlanQuestion = z.infer<typeof planQuestionSchema>;
export type PendingPlanQuestion = z.infer<typeof pendingPlanQuestionSchema>;
export type ChatPlanState = z.infer<typeof chatPlanStateSchema>;
export type EncryptedChatPlanWireState = z.infer<
  typeof encryptedChatPlanWireStateSchema
>;
export type ProjectTaskWorkloadOpaqueItem = z.infer<
  typeof projectTaskWorkloadOpaqueItemSchema
>;
export type ProjectTaskWorkloadOpaque = z.infer<
  typeof projectTaskWorkloadOpaqueSchema
>;
export type ChatPlanUpdate = z.infer<typeof chatPlanUpdateSchema>;
export type ChatPlanAnswer = z.infer<typeof chatPlanAnswerSchema>;
export type ChatPlanAccepted = z.infer<typeof chatPlanAcceptedSchema>;
