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
  TaskQuestionAnswer,
} from "@cantrip/protocol/tasks";

import type { ClientSessionContext } from "./client-session";
import { getClientSession } from "./client-session";
import type { ClientEncryptionService } from "./client-encryption";
import { ClientEncryptionError, clientEncryption } from "./client-encryption";

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
  try {
    return await createTaskOperationRelayRequest({
      ownerId: context.identity.ownerId,
      chatId: input.task.chatId,
      operationId: input.operationId,
      keyRevision: context.keyRevision,
      componentKey,
      content,
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
    const round = await openTaskOperationRelayResult({
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
    return { round, goalObjective };
  } finally {
    clearSensitiveBytes(componentKey);
  }
}
