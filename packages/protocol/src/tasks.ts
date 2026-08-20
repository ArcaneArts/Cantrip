import { z } from "zod";

import {
  encryptedPayloadEnvelopeSchema,
  encryptionBytesSchema,
  encryptionKeyBytesSchema,
  encryptionKeyRevisionSchema,
} from "./encryption.js";
import type { WorkflowJsonObject } from "./workflows.js";

export const TASK_MARKDOWN_LIMIT = 100_000;
export const TASK_QUESTION_LIMIT = 12;
export const TASK_QUESTION_HEADER_LIMIT = 80;
export const TASK_QUESTION_TEXT_LIMIT = 2_000;
export const TASK_QUESTION_OPTION_LIMIT = 6;
export const TASK_QUESTION_OPTION_LABEL_LIMIT = 120;
export const TASK_QUESTION_OPTION_DESCRIPTION_LIMIT = 1_000;
export const TASK_ANSWER_FREEFORM_LIMIT = 10_000;
export const TASK_ADDITIONAL_DIRECTION_LIMIT = 10_000;
export const TASK_GOAL_PROMPT_LIMIT = 100_000;
export const TASK_ERROR_MESSAGE_LIMIT = 4_000;
export const TASK_PROTECTED_CONTENT_BYTES_LIMIT = 4 * 1_024 * 1_024;
export const TASK_PLANNING_ROUND_PROTECTED_CONTENT_BYTES_LIMIT =
  6 * 1_024 * 1_024;
export const TASK_MESSAGE_PROTECTED_CONTENT_BYTES_LIMIT = 2 * 1_024 * 1_024;
export const TASK_GOAL_OBJECTIVE_PROTECTED_CONTENT_BYTES_LIMIT = 512 * 1_024;

export const chatExperienceSchema = z.enum(["agent", "task"]);

export const taskStateSchema = z.enum([
  "draft",
  "planning",
  "review",
  "finalizing",
  "implementing",
  "paused",
  "blocked",
  "complete",
  "failed",
]);

export const taskStableStateSchema = z.enum(["draft", "review"]);
export const taskOperationKindSchema = z.enum([
  "initial-plan",
  "continue-plan",
  "finalize",
]);
export const taskFailureOperationKindSchema = z.union([
  taskOperationKindSchema,
  z.literal("implementation"),
]);
export const taskPlanAuthorshipSchema = z.enum([
  "agent",
  "user-edited",
  "mixed",
]);
export const taskPlanningRoundStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "interrupted",
]);

export const taskQuestionOptionSchema = z.object({
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(TASK_QUESTION_OPTION_LABEL_LIMIT),
  description: z.string().max(TASK_QUESTION_OPTION_DESCRIPTION_LIMIT),
});

export const taskQuestionSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    header: z.string().trim().min(1).max(TASK_QUESTION_HEADER_LIMIT),
    question: z.string().trim().min(1).max(TASK_QUESTION_TEXT_LIMIT),
    options: z.array(taskQuestionOptionSchema).max(TASK_QUESTION_OPTION_LIMIT),
    recommendedOptionId: z.string().trim().min(1).max(200).nullable(),
    allowFreeform: z.boolean(),
    required: z.boolean().default(true),
  })
  .superRefine((question, context) => {
    const optionIds = new Set<string>();
    for (const [index, option] of question.options.entries()) {
      if (optionIds.has(option.id)) {
        context.addIssue({
          code: "custom",
          message: "Task question option IDs must be unique.",
          path: ["options", index, "id"],
        });
      }
      optionIds.add(option.id);
    }
    if (
      question.recommendedOptionId !== null &&
      !optionIds.has(question.recommendedOptionId)
    ) {
      context.addIssue({
        code: "custom",
        message: "The recommended option must exist in the question.",
        path: ["recommendedOptionId"],
      });
    }
    if (!question.options.length && !question.allowFreeform) {
      context.addIssue({
        code: "custom",
        message: "A question needs options or a freeform answer.",
        path: ["allowFreeform"],
      });
    }
  });

export const taskQuestionListSchema = z
  .array(taskQuestionSchema)
  .max(TASK_QUESTION_LIMIT)
  .superRefine((questions, context) => {
    const ids = new Set<string>();
    for (const [index, question] of questions.entries()) {
      if (ids.has(question.id)) {
        context.addIssue({
          code: "custom",
          message: "Task question IDs must be unique within a round.",
          path: [index, "id"],
        });
      }
      ids.add(question.id);
    }
  });

export const taskQuestionAnswerSchema = z
  .object({
    questionId: z.string().trim().min(1).max(200),
    optionId: z.string().trim().min(1).max(200).nullable(),
    freeform: z.string().max(TASK_ANSWER_FREEFORM_LIMIT).nullable(),
  })
  .superRefine((answer, context) => {
    if (!answer.optionId && !answer.freeform?.trim()) {
      context.addIssue({
        code: "custom",
        message: "A Task answer needs a selected option or freeform text.",
      });
    }
  });

export const taskQuestionAnswerListSchema = z
  .array(taskQuestionAnswerSchema)
  .max(TASK_QUESTION_LIMIT)
  .superRefine((answers, context) => {
    const questionIds = new Set<string>();
    for (const [index, answer] of answers.entries()) {
      if (questionIds.has(answer.questionId)) {
        context.addIssue({
          code: "custom",
          message: "A Task question can have only one current answer.",
          path: [index, "questionId"],
        });
      }
      questionIds.add(answer.questionId);
    }
  });

export const taskLastErrorSchema = z.object({
  code: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(TASK_ERROR_MESSAGE_LIMIT),
  operationKind: taskFailureOperationKindSchema,
  occurredAt: z.iso.datetime(),
});

export const taskDetailSchema = z.object({
  chatId: z.string().min(1),
  state: taskStateSchema,
  stableStateBeforeFailure: taskStableStateSchema.nullable(),
  activeOperationId: z.string().min(1).max(200).nullable(),
  activeOperationKind: taskOperationKindSchema.nullable(),
  briefMarkdown: z.string().max(TASK_MARKDOWN_LIMIT),
  draftAttachmentIds: z.array(z.string().min(1)).max(100),
  planMarkdown: z.string().min(1).max(TASK_MARKDOWN_LIMIT).nullable(),
  planAuthorship: taskPlanAuthorshipSchema,
  currentQuestions: taskQuestionListSchema,
  currentAnswers: taskQuestionAnswerListSchema,
  additionalDirection: z.string().max(TASK_ADDITIONAL_DIRECTION_LIMIT),
  finalPlanMarkdown: z.string().min(1).max(TASK_MARKDOWN_LIMIT).nullable(),
  goalPrompt: z.string().min(1).max(TASK_GOAL_PROMPT_LIMIT).nullable(),
  planningRound: z.number().int().nonnegative(),
  implementationStartedAt: z.iso.datetime().nullable(),
  lastError: taskLastErrorSchema.nullable(),
  rowVersion: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const taskGoalStatusSchema = z.enum([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);

export const taskGoalSnapshotSchema = z.object({
  threadId: z.string().min(1),
  objective: z.string().min(1),
  status: taskGoalStatusSchema,
  tokenBudget: z.number().int().positive().nullable(),
  tokensUsed: z.number().int().nonnegative(),
  timeUsedSeconds: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

const taskGitImplementationPlacementSchema = z.object({
  kind: z.literal("git").default("git"),
  workerId: z.string().min(1),
  worktreeId: z.string().min(1),
  worktreeName: z.string().min(1),
  branch: z.string().min(1).nullable(),
  isPrimary: z.boolean(),
  dirty: z.boolean(),
  dirtyFileCount: z.number().int().nonnegative(),
});

const taskFolderImplementationPlacementSchema = z.object({
  kind: z.literal("folder"),
  workerId: z.string().min(1),
  rootId: z.string().min(1),
  displayPath: z.string().min(1),
});

export const taskImplementationPlacementSchema = z.union([
  taskGitImplementationPlacementSchema,
  taskFolderImplementationPlacementSchema,
]);

export const taskPullRequestAssociationSourceSchema = z.enum([
  "lane-branch",
  "worktree",
  "message-url",
]);

export const taskPullRequestAssociationKindSchema = z.enum([
  "explicit",
  "inferred",
]);

export const taskAssociatedPullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  url: z.url(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged: z.boolean(),
  headRef: z.string().min(1),
  headSha: z.string().min(1),
  baseRef: z.string().min(1),
  baseSha: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  associationKind: taskPullRequestAssociationKindSchema,
  associationSource: taskPullRequestAssociationSourceSchema,
  confidence: z.enum(["high", "medium"]),
  worktreeId: z.string().min(1).nullable(),
  worktreeName: z.string().min(1).nullable(),
});

export const taskAdvisoryWarningSchema = z.object({
  code: z.enum([
    "multiple-open-pull-requests",
    "new-worktree-before-merge",
    "closed-unmerged",
    "dirty-after-merge",
    "complete-with-open-pull-request",
  ]),
  message: z.string().min(1).max(2_000),
  pullRequestNumber: z.number().int().positive().nullable(),
  worktreeId: z.string().min(1).nullable(),
});

export const taskImplementationDashboardSchema = z.object({
  task: taskDetailSchema,
  goal: taskGoalSnapshotSchema.nullable(),
  goalUnavailableReason: z.string().min(1).max(2_000).nullable(),
  placement: taskImplementationPlacementSchema,
  pullRequests: z.array(taskAssociatedPullRequestSchema).max(200),
  pullRequestsUnavailableReason: z.string().min(1).max(2_000).nullable(),
  warnings: z.array(taskAdvisoryWarningSchema).max(200),
});

export const taskDraftUpdateSchema = z
  .object({
    rowVersion: z.number().int().positive(),
    briefMarkdown: z.string().max(TASK_MARKDOWN_LIMIT).optional(),
    draftAttachmentIds: z
      .array(z.string().min(1))
      .max(100)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Task attachment IDs must be unique.",
      )
      .optional(),
  })
  .refine(
    (value) =>
      value.briefMarkdown !== undefined ||
      value.draftAttachmentIds !== undefined,
    { message: "At least one Task draft field is required." },
  );

export const taskPlanUpdateSchema = z
  .object({
    rowVersion: z.number().int().positive(),
    planMarkdown: z.string().min(1).max(TASK_MARKDOWN_LIMIT).optional(),
    answers: taskQuestionAnswerListSchema.optional(),
    additionalDirection: z
      .string()
      .max(TASK_ADDITIONAL_DIRECTION_LIMIT)
      .optional(),
  })
  .refine(
    (value) =>
      value.planMarkdown !== undefined ||
      value.answers !== undefined ||
      value.additionalDirection !== undefined,
    { message: "At least one Task review field is required." },
  );

export const taskPlannerResultSchema = z.object({
  planMarkdown: z.string().min(1).max(TASK_MARKDOWN_LIMIT),
  questions: taskQuestionListSchema,
});

export const taskFinalizerResultSchema = z.object({
  finalPlanMarkdown: z.string().min(1).max(TASK_MARKDOWN_LIMIT),
  goalPrompt: z.string().min(1).max(TASK_GOAL_PROMPT_LIMIT),
});

export const taskOperationStartSchema = z.object({
  operationId: z.string().uuid(),
  rowVersion: z.number().int().positive(),
});

export const taskContinuationStartSchema = taskOperationStartSchema.extend({
  answers: taskQuestionAnswerListSchema,
  additionalDirection: z.string().max(TASK_ADDITIONAL_DIRECTION_LIMIT),
});

export const taskPlannerOutputJsonSchema: WorkflowJsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["planMarkdown", "questions"],
  properties: {
    planMarkdown: {
      type: "string",
      minLength: 1,
      maxLength: TASK_MARKDOWN_LIMIT,
    },
    questions: {
      type: "array",
      maxItems: TASK_QUESTION_LIMIT,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "header",
          "question",
          "options",
          "recommendedOptionId",
          "allowFreeform",
          "required",
        ],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 200 },
          header: {
            type: "string",
            minLength: 1,
            maxLength: TASK_QUESTION_HEADER_LIMIT,
          },
          question: {
            type: "string",
            minLength: 1,
            maxLength: TASK_QUESTION_TEXT_LIMIT,
          },
          options: {
            type: "array",
            maxItems: TASK_QUESTION_OPTION_LIMIT,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "label", "description"],
              properties: {
                id: { type: "string", minLength: 1, maxLength: 200 },
                label: {
                  type: "string",
                  minLength: 1,
                  maxLength: TASK_QUESTION_OPTION_LABEL_LIMIT,
                },
                description: {
                  type: "string",
                  maxLength: TASK_QUESTION_OPTION_DESCRIPTION_LIMIT,
                },
              },
            },
          },
          recommendedOptionId: {
            anyOf: [
              { type: "string", minLength: 1, maxLength: 200 },
              { type: "null" },
            ],
          },
          allowFreeform: { type: "boolean" },
          required: { type: "boolean" },
        },
      },
    },
  },
};

export const taskFinalizerOutputJsonSchema: WorkflowJsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["finalPlanMarkdown", "goalPrompt"],
  properties: {
    finalPlanMarkdown: {
      type: "string",
      minLength: 1,
      maxLength: TASK_MARKDOWN_LIMIT,
    },
    goalPrompt: {
      type: "string",
      minLength: 1,
      maxLength: TASK_GOAL_PROMPT_LIMIT,
    },
  },
};

export const taskPlanningRoundSchema = z.object({
  id: z.string().min(1),
  chatId: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  kind: taskOperationKindSchema,
  status: taskPlanningRoundStatusSchema,
  inputBriefMarkdown: z.string().max(TASK_MARKDOWN_LIMIT),
  inputPlanMarkdown: z.string().max(TASK_MARKDOWN_LIMIT).nullable(),
  inputQuestions: taskQuestionListSchema,
  inputAnswers: taskQuestionAnswerListSchema,
  additionalDirection: z.string().max(TASK_ADDITIONAL_DIRECTION_LIMIT),
  outputPlanMarkdown: z.string().max(TASK_MARKDOWN_LIMIT).nullable(),
  outputQuestions: taskQuestionListSchema,
  outputGoalPrompt: z.string().max(TASK_GOAL_PROMPT_LIMIT).nullable(),
  userMessageId: z.string().min(1).nullable(),
  assistantMessageId: z.string().min(1).nullable(),
  executionLaneId: z.string().min(1).nullable(),
  turnId: z.string().min(1).nullable(),
  error: taskLastErrorSchema.nullable(),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

export const taskPlanningRoundListSchema = z
  .array(taskPlanningRoundSchema)
  .max(1_000);

function boundedTaskEnvelopeSchema(maximumPlaintextBytes: number) {
  const maximumCiphertextCharacters = Math.ceil(
    ((maximumPlaintextBytes + 16) * 4) / 3,
  );
  return z
    .object({
      formatVersion: z.literal(1),
      keyRevision: encryptionKeyRevisionSchema,
      envelope: encryptedPayloadEnvelopeSchema.extend({
        ciphertext: encryptionBytesSchema
          .min(22)
          .max(maximumCiphertextCharacters),
      }),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.envelope.version !== value.formatVersion ||
        value.envelope.keyRevision !== value.keyRevision
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Protected Task envelope metadata must match its outer metadata.",
          path: ["envelope"],
        });
      }
    });
}

export const encryptedTaskProtectedContentSchema = boundedTaskEnvelopeSchema(
  TASK_PROTECTED_CONTENT_BYTES_LIMIT,
);
export const encryptedTaskPlanningRoundProtectedContentSchema =
  boundedTaskEnvelopeSchema(TASK_PLANNING_ROUND_PROTECTED_CONTENT_BYTES_LIMIT);
export const encryptedTaskMessageProtectedContentSchema =
  boundedTaskEnvelopeSchema(TASK_MESSAGE_PROTECTED_CONTENT_BYTES_LIMIT);
export const encryptedTaskGoalObjectiveSchema = boundedTaskEnvelopeSchema(
  TASK_GOAL_OBJECTIVE_PROTECTED_CONTENT_BYTES_LIMIT,
);

export const taskProtectedLastErrorMetadataSchema = taskLastErrorSchema
  .omit({ message: true })
  .strict();

export const taskProtectedClassificationSchema = z
  .object({
    state: taskStateSchema,
    stableStateBeforeFailure: taskStableStateSchema.nullable(),
    activeOperationKind: taskOperationKindSchema.nullable(),
    planAuthorship: taskPlanAuthorshipSchema,
    planningRound: z.number().int().nonnegative(),
    hasPlan: z.boolean(),
    hasQuestions: z.boolean(),
    hasFinalPlan: z.boolean(),
    hasGoalPrompt: z.boolean(),
    lastError: taskProtectedLastErrorMetadataSchema.nullable(),
  })
  .strict();

function sameLastErrorMetadata(
  metadata: z.infer<typeof taskProtectedLastErrorMetadataSchema> | null,
  error: z.infer<typeof taskLastErrorSchema> | null,
): boolean {
  return (
    metadata?.code === error?.code &&
    metadata?.operationKind === error?.operationKind &&
    metadata?.occurredAt === error?.occurredAt
  );
}

export const taskProtectedContentSchema = z
  .object({
    version: z.literal(1),
    classification: taskProtectedClassificationSchema,
    briefMarkdown: z.string().max(TASK_MARKDOWN_LIMIT),
    planMarkdown: z.string().min(1).max(TASK_MARKDOWN_LIMIT).nullable(),
    currentQuestions: taskQuestionListSchema,
    currentAnswers: taskQuestionAnswerListSchema,
    additionalDirection: z.string().max(TASK_ADDITIONAL_DIRECTION_LIMIT),
    finalPlanMarkdown: z.string().min(1).max(TASK_MARKDOWN_LIMIT).nullable(),
    goalPrompt: z.string().min(1).max(TASK_GOAL_PROMPT_LIMIT).nullable(),
    lastError: taskLastErrorSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = {
      hasPlan: value.planMarkdown !== null,
      hasQuestions: value.currentQuestions.length > 0,
      hasFinalPlan: value.finalPlanMarkdown !== null,
      hasGoalPrompt: value.goalPrompt !== null,
    };
    for (const [field, present] of Object.entries(expected)) {
      if (value.classification[field as keyof typeof expected] !== present) {
        context.addIssue({
          code: "custom",
          message: `Protected Task ${field} classification does not match its content.`,
          path: ["classification", field],
        });
      }
    }
    if (
      !sameLastErrorMetadata(value.classification.lastError, value.lastError)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Protected Task error classification does not match its content.",
        path: ["classification", "lastError"],
      });
    }
  });

export const taskPlanningRoundProtectedClassificationSchema = z
  .object({
    ordinal: z.number().int().nonnegative(),
    kind: taskOperationKindSchema,
    status: taskPlanningRoundStatusSchema,
    hasOutputPlan: z.boolean(),
    hasOutputQuestions: z.boolean(),
    hasOutputGoalPrompt: z.boolean(),
    error: taskProtectedLastErrorMetadataSchema.nullable(),
  })
  .strict();

export const taskPlanningRoundProtectedContentSchema = z
  .object({
    version: z.literal(1),
    classification: taskPlanningRoundProtectedClassificationSchema,
    inputBriefMarkdown: z.string().max(TASK_MARKDOWN_LIMIT),
    inputPlanMarkdown: z.string().max(TASK_MARKDOWN_LIMIT).nullable(),
    inputQuestions: taskQuestionListSchema,
    inputAnswers: taskQuestionAnswerListSchema,
    additionalDirection: z.string().max(TASK_ADDITIONAL_DIRECTION_LIMIT),
    outputPlanMarkdown: z.string().max(TASK_MARKDOWN_LIMIT).nullable(),
    outputQuestions: taskQuestionListSchema,
    outputGoalPrompt: z.string().max(TASK_GOAL_PROMPT_LIMIT).nullable(),
    error: taskLastErrorSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = {
      hasOutputPlan: value.outputPlanMarkdown !== null,
      hasOutputQuestions: value.outputQuestions.length > 0,
      hasOutputGoalPrompt: value.outputGoalPrompt !== null,
    };
    for (const [field, present] of Object.entries(expected)) {
      if (value.classification[field as keyof typeof expected] !== present) {
        context.addIssue({
          code: "custom",
          message: `Protected planning-round ${field} classification does not match its content.`,
          path: ["classification", field],
        });
      }
    }
    if (!sameLastErrorMetadata(value.classification.error, value.error)) {
      context.addIssue({
        code: "custom",
        message:
          "Protected planning-round error classification does not match its content.",
        path: ["classification", "error"],
      });
    }
  });

const taskMessageRoleSchema = z.enum(["user", "assistant", "system"]);
const taskMessageModeSchema = z.enum(["default", "plan", "goal"]);

export const taskMessageProtectedClassificationSchema = z
  .object({
    role: taskMessageRoleSchema,
    mode: taskMessageModeSchema,
    attachmentIds: z
      .array(z.string().min(1).max(200))
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Task message attachment IDs must be unique.",
      }),
  })
  .strict();

function protectedMessageAttachmentIds(content: readonly unknown[]): string[] {
  return content.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Record<string, unknown>;
    if (
      candidate.type !== "attachment" ||
      !candidate.attachment ||
      typeof candidate.attachment !== "object" ||
      Array.isArray(candidate.attachment)
    ) {
      return [];
    }
    const id = (candidate.attachment as Record<string, unknown>).id;
    return typeof id === "string" ? [id] : [];
  });
}

export const taskMessageProtectedContentSchema = z
  .object({
    version: z.literal(1),
    classification: taskMessageProtectedClassificationSchema,
    content: z.array(z.json()).min(1).max(1_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      JSON.stringify(value.classification.attachmentIds) !==
      JSON.stringify(protectedMessageAttachmentIds(value.content))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Protected Task message attachment classification does not match its content.",
        path: ["classification", "attachmentIds"],
      });
    }
  });

export const taskGoalObjectiveProtectedClassificationSchema = z
  .object({
    chatId: z.string().min(1).max(200),
    threadId: z.string().min(1).max(200),
    status: taskGoalStatusSchema,
  })
  .strict();

export const taskGoalObjectiveProtectedContentSchema = z
  .object({
    version: z.literal(1),
    classification: taskGoalObjectiveProtectedClassificationSchema,
    objective: z.string().min(1).max(TASK_GOAL_PROMPT_LIMIT),
  })
  .strict();

export const taskOpaqueContentSchema = z
  .object({
    classification: taskProtectedClassificationSchema,
    protectedContent: encryptedTaskProtectedContentSchema,
  })
  .strict();

export const taskMessageOpaqueContentSchema = z
  .object({
    id: z.string().uuid(),
    classification: taskMessageProtectedClassificationSchema,
    protectedContent: encryptedTaskMessageProtectedContentSchema,
    reasoningEffort: z.string().min(1).max(100).nullable().default(null),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();

export const taskPlanningRoundOpaqueContentSchema = z
  .object({
    classification: taskPlanningRoundProtectedClassificationSchema,
    protectedContent: encryptedTaskPlanningRoundProtectedContentSchema,
  })
  .strict();

export const taskOperationRelayRequestSchema = z
  .object({
    chatId: z.string().min(1).max(200),
    operationId: z.string().uuid(),
    fingerprint: encryptionKeyBytesSchema,
    classification: taskPlanningRoundProtectedClassificationSchema,
    protectedInput: encryptedTaskPlanningRoundProtectedContentSchema,
    task: taskOpaqueContentSchema,
    userMessage: taskMessageOpaqueContentSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.classification.status !== "running" ||
      value.classification.hasOutputPlan ||
      value.classification.hasOutputQuestions ||
      value.classification.hasOutputGoalPrompt ||
      value.classification.error !== null ||
      value.userMessage.classification.role !== "user" ||
      value.userMessage.classification.mode !== "plan"
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Encrypted Task relay input must describe a running operation.",
        path: ["classification"],
      });
    }
  });

export const taskOperationRelayGoalSchema = z
  .object({
    classification: taskGoalObjectiveProtectedClassificationSchema,
    protectedObjective: encryptedTaskGoalObjectiveSchema,
    startMessage: taskMessageOpaqueContentSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.startMessage.classification.role !== "user" ||
      value.startMessage.classification.mode !== "goal"
    ) {
      context.addIssue({
        code: "custom",
        message: "An encrypted Task Goal requires an encrypted user message.",
        path: ["startMessage", "classification"],
      });
    }
  });

export const taskOperationRelayResultSchema = z
  .object({
    chatId: z.string().min(1).max(200),
    operationId: z.string().uuid(),
    fingerprint: encryptionKeyBytesSchema,
    classification: taskPlanningRoundProtectedClassificationSchema,
    protectedResult: encryptedTaskPlanningRoundProtectedContentSchema,
    task: taskOpaqueContentSchema,
    assistantMessage: taskMessageOpaqueContentSchema,
    goal: taskOperationRelayGoalSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const finalizing = value.classification.kind === "finalize";
    if (
      value.classification.status !== "completed" ||
      !value.classification.hasOutputPlan ||
      value.classification.error !== null ||
      value.classification.hasOutputGoalPrompt !== finalizing ||
      (value.goal !== null) !== finalizing
    ) {
      context.addIssue({
        code: "custom",
        message: "Encrypted Task relay result classification is inconsistent.",
        path: ["classification"],
      });
    }
    if (
      value.goal &&
      (value.goal.classification.chatId !== value.chatId ||
        value.goal.classification.status !== "active")
    ) {
      context.addIssue({
        code: "custom",
        message: "Encrypted Task Goal metadata does not match its operation.",
        path: ["goal", "classification"],
      });
    }
    const expectedState = finalizing ? "implementing" : "review";
    if (
      value.task.classification.state !== expectedState ||
      value.task.classification.stableStateBeforeFailure !== null ||
      value.task.classification.activeOperationKind !== null ||
      value.task.classification.planningRound !==
        value.classification.ordinal ||
      !value.task.classification.hasPlan ||
      value.task.classification.hasQuestions !==
        value.classification.hasOutputQuestions ||
      value.task.classification.hasFinalPlan !== finalizing ||
      value.task.classification.hasGoalPrompt !== finalizing ||
      value.task.classification.lastError !== null ||
      value.assistantMessage.classification.role !== "assistant" ||
      value.assistantMessage.classification.mode !== "plan"
    ) {
      context.addIssue({
        code: "custom",
        message: "Encrypted Task result state is inconsistent.",
        path: ["task", "classification"],
      });
    }
  });

export const taskMessageRelayResultSchema = z
  .object({ message: taskMessageOpaqueContentSchema })
  .strict()
  .superRefine((value, context) => {
    if (
      value.message.classification.role !== "assistant" ||
      value.message.classification.mode !== "goal"
    ) {
      context.addIssue({
        code: "custom",
        message:
          "An encrypted Task turn must return an assistant Goal message.",
        path: ["message", "classification"],
      });
    }
  });

export const taskGoalSyncContextSchema = z
  .object({
    task: taskOpaqueContentSchema,
    automationPaused: z.boolean(),
    chatStatus: z.enum([
      "idle",
      "running",
      "waiting-for-approval",
      "offline",
      "failed",
    ]),
    message: z
      .object({
        id: z.string().uuid(),
        idempotencyKey: z.string().min(1).max(200),
        kind: z.enum(["start", "resume"]),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();

export const taskOpaqueMutationSchema = z
  .object({
    rowVersion: z.number().int().positive(),
    task: taskOpaqueContentSchema,
    draftAttachmentIds: z
      .array(z.string().min(1).max(200))
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Task attachment IDs must be unique.",
      })
      .optional(),
  })
  .strict();

export const taskEncryptedOperationStartSchema = z
  .object({
    rowVersion: z.number().int().positive(),
    operation: taskOperationRelayRequestSchema,
    failure: z
      .object({
        task: taskOpaqueContentSchema,
        round: taskPlanningRoundOpaqueContentSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const { classification } = value.operation;
    const task = value.operation.task.classification;
    const failedTask = value.failure.task.classification;
    const failedRound = value.failure.round.classification;
    const expectedRunningState =
      classification.kind === "finalize" ? "finalizing" : "planning";
    const expectedStableState =
      classification.kind === "initial-plan" ? "draft" : "review";
    if (
      task.state !== expectedRunningState ||
      task.stableStateBeforeFailure !== expectedStableState ||
      task.activeOperationKind !== classification.kind ||
      task.planningRound !== classification.ordinal ||
      task.lastError !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "Encrypted Task operation state is inconsistent.",
        path: ["operation", "task", "classification"],
      });
    }
    if (
      failedTask.state !== "failed" ||
      failedTask.stableStateBeforeFailure !== expectedStableState ||
      failedTask.activeOperationKind !== null ||
      failedTask.planningRound !== classification.ordinal ||
      failedTask.lastError?.operationKind !== classification.kind
    ) {
      context.addIssue({
        code: "custom",
        message: "Encrypted Task failure state is inconsistent.",
        path: ["failure", "task", "classification"],
      });
    }
    if (
      failedRound.ordinal !== classification.ordinal ||
      failedRound.kind !== classification.kind ||
      failedRound.status !== "failed" ||
      failedRound.error?.operationKind !== classification.kind
    ) {
      context.addIssue({
        code: "custom",
        message: "Encrypted planning-round failure state is inconsistent.",
        path: ["failure", "round", "classification"],
      });
    }
  });

export const taskOpaqueSummarySchema = taskProtectedClassificationSchema
  .extend({
    chatId: z.string().min(1).max(200),
    activeOperationId: z.string().min(1).max(200).nullable(),
    draftAttachmentIds: z
      .array(z.string().min(1).max(200))
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Task attachment IDs must be unique.",
      }),
    protectedContent: encryptedTaskProtectedContentSchema,
    implementationStartedAt: z.iso.datetime().nullable(),
    rowVersion: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const taskPlanningRoundOpaqueSummarySchema =
  taskPlanningRoundProtectedClassificationSchema
    .extend({
      id: z.string().min(1).max(200),
      chatId: z.string().min(1).max(200),
      protectedContent: encryptedTaskPlanningRoundProtectedContentSchema,
      userMessageId: z.string().min(1).max(200).nullable(),
      assistantMessageId: z.string().min(1).max(200).nullable(),
      executionLaneId: z.string().min(1).max(200).nullable(),
      turnId: z.string().min(1).max(200).nullable(),
      startedAt: z.iso.datetime(),
      completedAt: z.iso.datetime().nullable(),
    })
    .strict();

export const taskMessageOpaqueSummarySchema =
  taskMessageProtectedClassificationSchema
    .extend({
      id: z.string().min(1).max(200),
      chatId: z.string().min(1).max(200),
      worktreeId: z.string().min(1).max(200),
      executionLaneId: z.string().min(1).max(200).nullable(),
      sequence: z.number().int().positive(),
      protectedContent: encryptedTaskMessageProtectedContentSchema,
      modelId: z.string().min(1).max(200).nullable(),
      modelRouteId: z.string().min(1).max(200).nullable(),
      providerId: z.string().min(1).max(200).nullable(),
      providerName: z.string().min(1).max(500).nullable(),
      providerModelName: z.string().min(1).max(500).nullable(),
      reasoningEffort: z.string().min(1).max(100).nullable(),
      appliedReasoningEffort: z.string().min(1).max(100).nullable(),
      reasoningAdjusted: z.boolean(),
      idempotencyKey: z.string().min(1).max(200).nullable(),
      createdAt: z.iso.datetime(),
    })
    .strict();

export const taskGoalObjectiveOpaqueSnapshotSchema =
  taskGoalObjectiveProtectedClassificationSchema
    .extend({
      protectedObjective: encryptedTaskGoalObjectiveSchema,
      tokenBudget: z.number().int().positive().nullable(),
      tokensUsed: z.number().int().nonnegative(),
      timeUsedSeconds: z.number().int().nonnegative(),
      createdAt: z.number().int().nonnegative(),
      updatedAt: z.number().int().nonnegative(),
    })
    .strict();

export const taskGoalWorkerResultSchema = z
  .object({
    goal: taskGoalObjectiveOpaqueSnapshotSchema.nullable(),
    task: taskOpaqueContentSchema,
    message: taskMessageOpaqueContentSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.message &&
      (value.message.classification.role !== "user" ||
        value.message.classification.mode !== "goal")
    ) {
      context.addIssue({
        code: "custom",
        message: "Encrypted Task Goal control messages must be user messages.",
        path: ["message", "classification"],
      });
    }
  });

export const taskImplementationOpaqueDashboardSchema =
  taskImplementationDashboardSchema
    .omit({ task: true, goal: true })
    .extend({
      task: taskOpaqueSummarySchema,
      goal: taskGoalObjectiveOpaqueSnapshotSchema.nullable(),
    })
    .strict();

export type ChatExperience = z.infer<typeof chatExperienceSchema>;
export type TaskState = z.infer<typeof taskStateSchema>;
export type TaskStableState = z.infer<typeof taskStableStateSchema>;
export type TaskOperationKind = z.infer<typeof taskOperationKindSchema>;
export type TaskFailureOperationKind = z.infer<
  typeof taskFailureOperationKindSchema
>;
export type TaskPlanAuthorship = z.infer<typeof taskPlanAuthorshipSchema>;
export type TaskPlanningRoundStatus = z.infer<
  typeof taskPlanningRoundStatusSchema
>;
export type TaskQuestionOption = z.infer<typeof taskQuestionOptionSchema>;
export type TaskQuestion = z.infer<typeof taskQuestionSchema>;
export type TaskQuestionAnswer = z.infer<typeof taskQuestionAnswerSchema>;
export type TaskLastError = z.infer<typeof taskLastErrorSchema>;
export type TaskDetail = z.infer<typeof taskDetailSchema>;
export type TaskGoalSnapshot = z.infer<typeof taskGoalSnapshotSchema>;
export type TaskImplementationPlacement = z.infer<
  typeof taskImplementationPlacementSchema
>;
export type TaskAssociatedPullRequest = z.infer<
  typeof taskAssociatedPullRequestSchema
>;
export type TaskAdvisoryWarning = z.infer<typeof taskAdvisoryWarningSchema>;
export type TaskImplementationDashboard = z.infer<
  typeof taskImplementationDashboardSchema
>;
export type TaskDraftUpdate = z.infer<typeof taskDraftUpdateSchema>;
export type TaskPlanUpdate = z.infer<typeof taskPlanUpdateSchema>;
export type TaskPlannerResult = z.infer<typeof taskPlannerResultSchema>;
export type TaskFinalizerResult = z.infer<typeof taskFinalizerResultSchema>;
export type TaskOperationStart = z.infer<typeof taskOperationStartSchema>;
export type TaskContinuationStart = z.infer<typeof taskContinuationStartSchema>;
export type TaskPlanningRound = z.infer<typeof taskPlanningRoundSchema>;
export type EncryptedTaskProtectedContent = z.infer<
  typeof encryptedTaskProtectedContentSchema
>;
export type EncryptedTaskPlanningRoundProtectedContent = z.infer<
  typeof encryptedTaskPlanningRoundProtectedContentSchema
>;
export type EncryptedTaskMessageProtectedContent = z.infer<
  typeof encryptedTaskMessageProtectedContentSchema
>;
export type EncryptedTaskGoalObjective = z.infer<
  typeof encryptedTaskGoalObjectiveSchema
>;
export type TaskProtectedLastErrorMetadata = z.infer<
  typeof taskProtectedLastErrorMetadataSchema
>;
export type TaskProtectedClassification = z.infer<
  typeof taskProtectedClassificationSchema
>;
export type TaskProtectedContent = z.infer<typeof taskProtectedContentSchema>;
export type TaskPlanningRoundProtectedClassification = z.infer<
  typeof taskPlanningRoundProtectedClassificationSchema
>;
export type TaskPlanningRoundProtectedContent = z.infer<
  typeof taskPlanningRoundProtectedContentSchema
>;
export type TaskMessageProtectedClassification = z.infer<
  typeof taskMessageProtectedClassificationSchema
>;
export type TaskMessageProtectedContent = z.infer<
  typeof taskMessageProtectedContentSchema
>;
export type TaskGoalObjectiveProtectedClassification = z.infer<
  typeof taskGoalObjectiveProtectedClassificationSchema
>;
export type TaskGoalObjectiveProtectedContent = z.infer<
  typeof taskGoalObjectiveProtectedContentSchema
>;
export type TaskOperationRelayRequest = z.infer<
  typeof taskOperationRelayRequestSchema
>;
export type TaskOperationRelayGoal = z.infer<
  typeof taskOperationRelayGoalSchema
>;
export type TaskOperationRelayResult = z.infer<
  typeof taskOperationRelayResultSchema
>;
export type TaskOpaqueContent = z.infer<typeof taskOpaqueContentSchema>;
export type TaskMessageOpaqueContent = z.infer<
  typeof taskMessageOpaqueContentSchema
>;
export type TaskPlanningRoundOpaqueContent = z.infer<
  typeof taskPlanningRoundOpaqueContentSchema
>;
export type TaskOpaqueMutation = z.infer<typeof taskOpaqueMutationSchema>;
export type TaskEncryptedOperationStart = z.infer<
  typeof taskEncryptedOperationStartSchema
>;
export type TaskMessageRelayResult = z.infer<
  typeof taskMessageRelayResultSchema
>;
export type TaskGoalSyncContext = z.infer<typeof taskGoalSyncContextSchema>;
export type TaskOpaqueSummary = z.infer<typeof taskOpaqueSummarySchema>;
export type TaskImplementationOpaqueDashboard = z.infer<
  typeof taskImplementationOpaqueDashboardSchema
>;
export type TaskPlanningRoundOpaqueSummary = z.infer<
  typeof taskPlanningRoundOpaqueSummarySchema
>;
export type TaskMessageOpaqueSummary = z.infer<
  typeof taskMessageOpaqueSummarySchema
>;
export type TaskGoalObjectiveOpaqueSnapshot = z.infer<
  typeof taskGoalObjectiveOpaqueSnapshotSchema
>;
export type TaskGoalWorkerResult = z.infer<typeof taskGoalWorkerResultSchema>;
