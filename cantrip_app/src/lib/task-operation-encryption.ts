import {
  clearSensitiveBytes,
  createTaskOperationRelayRequest,
  decryptTaskGoalObjective,
  openTaskOperationRelayResult,
  taskOperationRunningClassification,
} from "@cantrip/crypto";
import type {
  TaskDetail,
  TaskOperationKind,
  TaskOperationRelayRequest,
  TaskOperationRelayResult,
  TaskPlanningRoundProtectedContent,
  TaskProtectedContent,
  TaskQuestionAnswer,
} from "@cantrip/protocol/tasks";

import type { ClientSessionContext } from "./client-session";
import { getClientSession } from "./client-session";
import type { ClientEncryptionService } from "./client-encryption";
import { ClientEncryptionError, clientEncryption } from "./client-encryption";
import { createTaskMessageOpaqueContent } from "./task-message-encryption";

function encryptionContext(input: {
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
}) {
  const service = input.service ?? clientEncryption;
  const session = (input.session ?? getClientSession)();
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

function runningTaskContent(input: {
  additionalDirection?: string;
  answers?: TaskQuestionAnswer[];
  kind: TaskOperationKind;
  task: TaskDetail;
}): TaskProtectedContent {
  const classification = {
    state:
      input.kind === "direct"
        ? ("implementing" as const)
        : input.kind === "finalize"
          ? ("finalizing" as const)
          : ("planning" as const),
    stableStateBeforeFailure:
      input.kind === "direct" || input.kind === "initial-plan"
        ? ("draft" as const)
        : ("review" as const),
    activeOperationKind: input.kind,
    planAuthorship: input.task.planAuthorship,
    planningRound: input.task.planningRound + 1,
    hasPlan: input.task.planMarkdown !== null,
    hasQuestions: input.task.currentQuestions.length > 0,
    hasFinalPlan: input.task.finalPlanMarkdown !== null,
    hasGoalPrompt: input.task.goalPrompt !== null,
    lastError: null,
  };
  return {
    version: 1,
    classification,
    briefMarkdown: input.task.briefMarkdown,
    planMarkdown: input.task.planMarkdown,
    currentQuestions: input.task.currentQuestions,
    currentAnswers: input.answers ?? input.task.currentAnswers,
    additionalDirection:
      input.additionalDirection ?? input.task.additionalDirection,
    finalPlanMarkdown: input.task.finalPlanMarkdown,
    goalPrompt: input.task.goalPrompt,
    lastError: null,
  };
}

function operationMessageText(input: {
  additionalDirection?: string;
  answers?: TaskQuestionAnswer[];
  kind: TaskOperationKind;
  task: TaskDetail;
}): string {
  if (input.kind === "direct") return input.task.briefMarkdown;
  if (input.kind === "initial-plan") {
    return `Plan this Task from the saved brief.\n\n${input.task.briefMarkdown}`;
  }
  const questions = new Map(
    input.task.currentQuestions.map((question) => [question.id, question]),
  );
  const answers = (input.answers ?? input.task.currentAnswers)
    .map((answer) => {
      const question = questions.get(answer.questionId);
      const option = question?.options.find(
        (candidate) => candidate.id === answer.optionId,
      );
      return `- ${question?.header ?? answer.questionId}: ${[
        option?.label,
        answer.freeform,
      ]
        .filter(Boolean)
        .join(" — ")}`;
    })
    .join("\n");
  const action =
    input.kind === "finalize"
      ? "Finalize this Task plan for implementation."
      : "Continue planning this Task.";
  return `${action}\n\n${answers || "No answers were supplied."}\n\n${
    input.additionalDirection?.trim() || "No additional direction was supplied."
  }`;
}

export async function prepareTaskOperationRelay(input: {
  additionalDirection?: string;
  answers?: TaskQuestionAnswer[];
  kind: TaskOperationKind;
  operationId: string;
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
  task: TaskDetail;
}): Promise<TaskOperationRelayRequest> {
  const context = encryptionContext(input);
  const componentKey = context.service.componentKey({
    component: "task-content",
    identity: context.identity,
    keyRevision: context.keyRevision,
  });
  const classification = taskOperationRunningClassification({
    kind: input.kind,
    ordinal: input.task.planningRound + 1,
  });
  const content: TaskPlanningRoundProtectedContent = {
    version: 1,
    classification,
    inputBriefMarkdown: input.task.briefMarkdown,
    inputPlanMarkdown: input.task.planMarkdown,
    inputQuestions: input.task.currentQuestions,
    inputAnswers: input.answers ?? input.task.currentAnswers,
    additionalDirection:
      input.additionalDirection ?? input.task.additionalDirection,
    outputPlanMarkdown: null,
    outputQuestions: [],
    outputGoalPrompt: null,
    error: null,
  };
  const taskContent = runningTaskContent(input);
  const userMessage = await createTaskMessageOpaqueContent(
    {
      content: [{ type: "text", text: operationMessageText(input) }],
      idempotencyKey: `task-operation:${input.operationId}`,
      messageId: crypto.randomUUID(),
      mode: input.kind === "direct" ? "default" : "plan",
      role: "user",
    },
    input,
  );
  try {
    return await createTaskOperationRelayRequest({
      ownerId: context.identity.ownerId,
      chatId: input.task.chatId,
      operationId: input.operationId,
      keyRevision: context.keyRevision,
      componentKey,
      content,
      taskContent,
      userMessage,
    });
  } finally {
    clearSensitiveBytes(componentKey);
  }
}

export async function openTaskOperationResult(input: {
  request: TaskOperationRelayRequest;
  result: TaskOperationRelayResult;
  service?: ClientEncryptionService;
  session?: () => ClientSessionContext | null;
}): Promise<{
  goalObjective: string | null;
  round: TaskPlanningRoundProtectedContent;
}> {
  const context = encryptionContext(input);
  const componentKey = context.service.componentKey({
    component: "task-content",
    identity: context.identity,
    keyRevision: context.keyRevision,
  });
  try {
    const opened = await openTaskOperationRelayResult({
      ownerId: context.identity.ownerId,
      keyRevision: context.keyRevision,
      componentKey,
      request: input.request,
      result: input.result,
    });
    const goalObjective = input.result.goal
      ? (
          await decryptTaskGoalObjective({
            ownerId: context.identity.ownerId,
            chatId: input.result.goal.classification.chatId,
            threadId: input.result.goal.classification.threadId,
            keyRevision: context.keyRevision,
            componentKey,
            encrypted: input.result.goal.protectedObjective,
            publicClassification: input.result.goal.classification,
          })
        ).objective
      : null;
    return { round: opened.round, goalObjective };
  } finally {
    clearSensitiveBytes(componentKey);
  }
}
