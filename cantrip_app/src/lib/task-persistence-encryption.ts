import {
  clearSensitiveBytes,
  decryptTaskProtectedContent,
  encryptTaskPlanningRoundProtectedContent,
  encryptTaskProtectedContent,
} from "@cantrip/crypto";
import {
  taskDetailSchema,
  taskDraftUpdateSchema,
  taskEncryptedOperationStartSchema,
  taskOpaqueMutationSchema,
  taskOpaqueSummarySchema,
  taskPlanUpdateSchema,
  type TaskDetail,
  type TaskDraftUpdate,
  type TaskEncryptedOperationStart,
  type TaskLastError,
  type TaskOpaqueContent,
  type TaskOpaqueMutation,
  type TaskOpaqueSummary,
  type TaskOperationKind,
  type TaskPlanUpdate,
  type TaskPlanningRoundProtectedContent,
  type TaskProtectedClassification,
  type TaskProtectedContent,
  type TaskQuestionAnswer,
} from "@cantrip/protocol/tasks";

import type { ClientSessionContext } from "./client-session";
import { getClientSession } from "./client-session";
import type { ClientEncryptionService } from "./client-encryption";
import { ClientEncryptionError, clientEncryption } from "./client-encryption";
import { prepareTaskOperationRelay } from "./task-operation-encryption";

type TrustedOptions = {
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
};

function encryptionContext(options: TrustedOptions) {
  const service = options.service ?? clientEncryption;
  const session = (options.session ?? getClientSession)();
  const snapshot = service.getSnapshot();
  if (
    !session ||
    snapshot.status !== "ready" ||
    !snapshot.masterKeyRevision ||
    snapshot.identity?.ownerId !== session.user.id ||
    snapshot.identity.serverId !== session.serverId
  ) {
    throw new ClientEncryptionError(
      "locked",
      "Encryption must be unlocked for this account.",
    );
  }
  return {
    identity: { ownerId: session.user.id, serverId: session.serverId },
    keyRevision: snapshot.masterKeyRevision,
    service,
  };
}

function lastErrorMetadata(error: TaskLastError | null) {
  return error
    ? {
        code: error.code,
        operationKind: error.operationKind,
        occurredAt: error.occurredAt,
      }
    : null;
}

function classificationForTask(task: TaskDetail): TaskProtectedClassification {
  return {
    state: task.state,
    stableStateBeforeFailure: task.stableStateBeforeFailure,
    activeOperationKind: task.activeOperationKind,
    planAuthorship: task.planAuthorship,
    planningRound: task.planningRound,
    hasPlan: task.planMarkdown !== null,
    hasQuestions: task.currentQuestions.length > 0,
    hasFinalPlan: task.finalPlanMarkdown !== null,
    hasGoalPrompt: task.goalPrompt !== null,
    lastError: lastErrorMetadata(task.lastError),
  };
}

function protectedContentForTask(task: TaskDetail): TaskProtectedContent {
  return {
    version: 1,
    classification: classificationForTask(task),
    briefMarkdown: task.briefMarkdown,
    planMarkdown: task.planMarkdown,
    currentQuestions: task.currentQuestions,
    currentAnswers: task.currentAnswers,
    additionalDirection: task.additionalDirection,
    finalPlanMarkdown: task.finalPlanMarkdown,
    goalPrompt: task.goalPrompt,
    lastError: task.lastError,
  };
}

async function encryptTaskContent(
  chatId: string,
  content: TaskProtectedContent,
  options: TrustedOptions,
): Promise<TaskOpaqueContent> {
  const context = encryptionContext(options);
  const componentKey = context.service.componentKey({
    component: "task-content",
    identity: context.identity,
    keyRevision: context.keyRevision,
  });
  try {
    return {
      classification: content.classification,
      protectedContent: await encryptTaskProtectedContent({
        ownerId: context.identity.ownerId,
        chatId,
        keyRevision: context.keyRevision,
        componentKey,
        content,
      }),
    };
  } finally {
    clearSensitiveBytes(componentKey);
  }
}

export async function createInitialTaskOpaqueContent(
  chatId: string,
  options: TrustedOptions = {},
): Promise<TaskOpaqueContent> {
  return encryptTaskContent(
    chatId,
    {
      version: 1,
      classification: {
        state: "draft",
        stableStateBeforeFailure: null,
        activeOperationKind: null,
        planAuthorship: "agent",
        planningRound: 0,
        hasPlan: false,
        hasQuestions: false,
        hasFinalPlan: false,
        hasGoalPrompt: false,
        lastError: null,
      },
      briefMarkdown: "",
      planMarkdown: null,
      currentQuestions: [],
      currentAnswers: [],
      additionalDirection: "",
      finalPlanMarkdown: null,
      goalPrompt: null,
      lastError: null,
    },
    options,
  );
}

export async function openTaskOpaqueSummary(
  raw: unknown,
  options: TrustedOptions = {},
): Promise<TaskDetail> {
  const opaque = taskOpaqueSummarySchema.parse(raw);
  const context = encryptionContext(options);
  const componentKey = context.service.componentKey({
    component: "task-content",
    identity: context.identity,
    keyRevision: opaque.protectedContent.keyRevision,
  });
  try {
    const content = await decryptTaskProtectedContent({
      ownerId: context.identity.ownerId,
      chatId: opaque.chatId,
      keyRevision: opaque.protectedContent.keyRevision,
      componentKey,
      encrypted: opaque.protectedContent,
      publicClassification: {
        state: opaque.state,
        stableStateBeforeFailure: opaque.stableStateBeforeFailure,
        activeOperationKind: opaque.activeOperationKind,
        planAuthorship: opaque.planAuthorship,
        planningRound: opaque.planningRound,
        hasPlan: opaque.hasPlan,
        hasQuestions: opaque.hasQuestions,
        hasFinalPlan: opaque.hasFinalPlan,
        hasGoalPrompt: opaque.hasGoalPrompt,
        lastError: opaque.lastError,
      },
    });
    return taskDetailSchema.parse({
      chatId: opaque.chatId,
      planGoalEnabled: opaque.planGoalEnabled,
      priority: opaque.priority,
      requestedTaskWorkerId: opaque.requestedTaskWorkerId,
      continuityFamily: opaque.continuityFamily,
      lastTaskWorkerId: opaque.lastTaskWorkerId,
      dispatch: opaque.dispatch,
      state: opaque.state,
      stableStateBeforeFailure: opaque.stableStateBeforeFailure,
      activeOperationId: opaque.activeOperationId,
      activeOperationKind: opaque.activeOperationKind,
      briefMarkdown: content.briefMarkdown,
      draftAttachmentIds: opaque.draftAttachmentIds,
      planMarkdown: content.planMarkdown,
      planAuthorship: opaque.planAuthorship,
      currentQuestions: content.currentQuestions,
      currentAnswers: content.currentAnswers,
      additionalDirection: content.additionalDirection,
      finalPlanMarkdown: content.finalPlanMarkdown,
      goalPrompt: content.goalPrompt,
      planningRound: opaque.planningRound,
      implementationStartedAt: opaque.implementationStartedAt,
      completedAt: opaque.completedAt,
      lastError: content.lastError,
      schedulerRevision: opaque.schedulerRevision,
      rowVersion: opaque.rowVersion,
      createdAt: opaque.createdAt,
      updatedAt: opaque.updatedAt,
    });
  } finally {
    clearSensitiveBytes(componentKey);
  }
}

async function mutationForTask(
  task: TaskDetail,
  next: TaskDetail,
  options: TrustedOptions,
  draftAttachmentIds?: string[],
  planGoalEnabled?: boolean,
  priority?: number,
  requestedTaskWorkerId?: string | null,
): Promise<TaskOpaqueMutation> {
  return taskOpaqueMutationSchema.parse({
    rowVersion: task.rowVersion,
    task: await encryptTaskContent(
      task.chatId,
      protectedContentForTask(next),
      options,
    ),
    ...(draftAttachmentIds ? { draftAttachmentIds } : {}),
    ...(planGoalEnabled !== undefined ? { planGoalEnabled } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(requestedTaskWorkerId !== undefined ? { requestedTaskWorkerId } : {}),
  });
}

export async function prepareTaskDraftPersistence(
  task: TaskDetail,
  rawInput: TaskDraftUpdate,
  options: TrustedOptions = {},
): Promise<TaskOpaqueMutation> {
  const input = taskDraftUpdateSchema.parse(rawInput);
  if (input.rowVersion !== task.rowVersion) {
    throw new Error(
      "The Task changed before its encrypted draft was prepared.",
    );
  }
  const next = taskDetailSchema.parse({
    ...task,
    ...(input.planGoalEnabled !== undefined
      ? { planGoalEnabled: input.planGoalEnabled }
      : {}),
    ...(input.briefMarkdown !== undefined
      ? { briefMarkdown: input.briefMarkdown }
      : {}),
    ...(input.draftAttachmentIds !== undefined
      ? { draftAttachmentIds: input.draftAttachmentIds }
      : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.requestedTaskWorkerId !== undefined
      ? { requestedTaskWorkerId: input.requestedTaskWorkerId }
      : {}),
  });
  return mutationForTask(
    task,
    next,
    options,
    input.draftAttachmentIds ?? task.draftAttachmentIds,
    input.planGoalEnabled,
    input.priority,
    input.requestedTaskWorkerId,
  );
}

function validateAnswers(
  task: TaskDetail,
  answers: TaskQuestionAnswer[],
): void {
  const questions = new Map(
    task.currentQuestions.map((question) => [question.id, question]),
  );
  for (const answer of answers) {
    const question = questions.get(answer.questionId);
    if (
      !question ||
      (answer.optionId &&
        !question.options.some((option) => option.id === answer.optionId)) ||
      (answer.freeform?.trim() && !question.allowFreeform)
    ) {
      throw new Error("Task answers no longer match the encrypted questions.");
    }
  }
}

export async function prepareTaskPlanPersistence(
  task: TaskDetail,
  rawInput: TaskPlanUpdate,
  options: TrustedOptions = {},
): Promise<TaskOpaqueMutation> {
  const input = taskPlanUpdateSchema.parse(rawInput);
  if (input.rowVersion !== task.rowVersion) {
    throw new Error("The Task changed before its encrypted plan was prepared.");
  }
  if (input.answers) validateAnswers(task, input.answers);
  const planChanged =
    input.planMarkdown !== undefined &&
    input.planMarkdown !== task.planMarkdown;
  const next = taskDetailSchema.parse({
    ...task,
    ...(input.planMarkdown !== undefined
      ? { planMarkdown: input.planMarkdown }
      : {}),
    ...(input.answers !== undefined ? { currentAnswers: input.answers } : {}),
    ...(input.additionalDirection !== undefined
      ? { additionalDirection: input.additionalDirection }
      : {}),
    ...(planChanged
      ? {
          planAuthorship:
            task.planAuthorship === "agent" ? "user-edited" : "mixed",
        }
      : {}),
  });
  return mutationForTask(task, next, options);
}

export async function prepareTaskEncryptedOperation(
  task: TaskDetail,
  input: {
    additionalDirection?: string;
    answers?: TaskQuestionAnswer[];
    kind: TaskOperationKind;
    operationId: string;
    rowVersion: number;
  },
  options: TrustedOptions = {},
): Promise<TaskEncryptedOperationStart> {
  if (input.rowVersion !== task.rowVersion) {
    throw new Error(
      "The Task changed before its encrypted operation was prepared.",
    );
  }
  if (input.kind !== "direct" && input.kind !== "initial-plan") {
    const answers = input.answers ?? task.currentAnswers;
    validateAnswers(task, answers);
    const answered = new Set(answers.map((answer) => answer.questionId));
    if (
      task.currentQuestions.some(
        (question) => question.required && !answered.has(question.id),
      )
    ) {
      throw new Error("Answer every required Task question before continuing.");
    }
  }
  const operation = await prepareTaskOperationRelay({
    task,
    kind: input.kind,
    operationId: input.operationId,
    answers: input.answers,
    additionalDirection: input.additionalDirection,
    ...options,
  });
  const occurredAt = new Date().toISOString();
  const error: TaskLastError = {
    code: "task-operation-failed",
    message:
      "The encrypted Task operation failed. Retry when the worker is ready.",
    operationKind: input.kind,
    occurredAt,
  };
  const failedClassification: TaskProtectedClassification = {
    ...operation.task.classification,
    state: "failed",
    stableStateBeforeFailure:
      input.kind === "direct" || input.kind === "initial-plan"
        ? "draft"
        : "review",
    activeOperationKind: null,
    lastError: lastErrorMetadata(error),
  };
  const failedTask: TaskProtectedContent = {
    ...protectedContentForTask(task),
    classification: failedClassification,
    currentAnswers: input.answers ?? task.currentAnswers,
    additionalDirection: input.additionalDirection ?? task.additionalDirection,
    lastError: error,
  };
  const failedRoundClassification = {
    ...operation.classification,
    status: "failed" as const,
    error: lastErrorMetadata(error),
  };
  const failedRound: TaskPlanningRoundProtectedContent = {
    version: 1,
    classification: failedRoundClassification,
    inputBriefMarkdown: task.briefMarkdown,
    inputPlanMarkdown: task.planMarkdown,
    inputQuestions: task.currentQuestions,
    inputAnswers: input.answers ?? task.currentAnswers,
    additionalDirection: input.additionalDirection ?? task.additionalDirection,
    outputPlanMarkdown: null,
    outputQuestions: [],
    outputGoalPrompt: null,
    error,
  };
  const context = encryptionContext(options);
  const componentKey = context.service.componentKey({
    component: "task-content",
    identity: context.identity,
    keyRevision: context.keyRevision,
  });
  try {
    return taskEncryptedOperationStartSchema.parse({
      rowVersion: input.rowVersion,
      operation,
      failure: {
        task: {
          classification: failedClassification,
          protectedContent: await encryptTaskProtectedContent({
            ownerId: context.identity.ownerId,
            chatId: task.chatId,
            keyRevision: context.keyRevision,
            componentKey,
            content: failedTask,
          }),
        },
        round: {
          classification: failedRoundClassification,
          protectedContent: await encryptTaskPlanningRoundProtectedContent({
            ownerId: context.identity.ownerId,
            roundId: input.operationId,
            keyRevision: context.keyRevision,
            componentKey,
            content: failedRound,
          }),
        },
      },
    });
  } finally {
    clearSensitiveBytes(componentKey);
  }
}

export function taskOpaqueSummaryFromCreate(input: {
  chatId: string;
  planGoalEnabled?: boolean;
  task: TaskOpaqueContent;
  createdAt: string;
}): TaskOpaqueSummary {
  return taskOpaqueSummarySchema.parse({
    chatId: input.chatId,
    planGoalEnabled: input.planGoalEnabled ?? false,
    ...input.task.classification,
    activeOperationId: null,
    draftAttachmentIds: [],
    protectedContent: input.task.protectedContent,
    implementationStartedAt: null,
    rowVersion: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}
