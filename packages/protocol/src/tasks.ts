import { z } from "zod";

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
  operationKind: taskOperationKindSchema,
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

export const taskPlanUpdateSchema = z.object({
  rowVersion: z.number().int().positive(),
  planMarkdown: z.string().min(1).max(TASK_MARKDOWN_LIMIT),
});

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

export type ChatExperience = z.infer<typeof chatExperienceSchema>;
export type TaskState = z.infer<typeof taskStateSchema>;
export type TaskStableState = z.infer<typeof taskStableStateSchema>;
export type TaskOperationKind = z.infer<typeof taskOperationKindSchema>;
export type TaskPlanAuthorship = z.infer<typeof taskPlanAuthorshipSchema>;
export type TaskPlanningRoundStatus = z.infer<
  typeof taskPlanningRoundStatusSchema
>;
export type TaskQuestionOption = z.infer<typeof taskQuestionOptionSchema>;
export type TaskQuestion = z.infer<typeof taskQuestionSchema>;
export type TaskQuestionAnswer = z.infer<typeof taskQuestionAnswerSchema>;
export type TaskLastError = z.infer<typeof taskLastErrorSchema>;
export type TaskDetail = z.infer<typeof taskDetailSchema>;
export type TaskDraftUpdate = z.infer<typeof taskDraftUpdateSchema>;
export type TaskPlanUpdate = z.infer<typeof taskPlanUpdateSchema>;
export type TaskPlanningRound = z.infer<typeof taskPlanningRoundSchema>;
