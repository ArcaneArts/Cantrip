import {
  taskOperationRelayRequestSchema,
  taskOperationRelayResultSchema,
  taskMessageOpaqueContentSchema,
  taskPlanningRoundProtectedContentSchema,
  taskProtectedContentSchema,
  type TaskOperationRelayRequest,
  type TaskOperationRelayResult,
  type TaskMessageOpaqueContent,
  type TaskMessageProtectedContent,
  type TaskPlanningRoundProtectedClassification,
  type TaskPlanningRoundProtectedContent,
  type TaskProtectedContent,
} from "@cantrip/protocol/tasks";

import { bytesEqual, clearSensitiveBytes, decodeBase64Url } from "./bytes.js";
import { computeBlindLookupTag, deriveLookupKey } from "./kdf.js";
import {
  decryptTaskProtectedContent,
  decryptTaskPlanningRoundProtectedContent,
  decryptTaskMessageProtectedContent,
  encryptTaskProtectedContent,
  encryptTaskPlanningRoundProtectedContent,
} from "./task-content.js";

function taskOperationFingerprint(input: {
  chatId: string;
  componentKey: Uint8Array;
  content: TaskPlanningRoundProtectedContent;
  keyRevision: number;
  operationId: string;
  ownerId: string;
  taskContent: TaskProtectedContent;
  userMessage: TaskMessageOpaqueContent;
}): string {
  const content = taskPlanningRoundProtectedContentSchema.parse(input.content);
  const taskContent = taskProtectedContentSchema.parse(input.taskContent);
  const userMessage = taskMessageOpaqueContentSchema.parse(input.userMessage);
  const lookupKey = deriveLookupKey({
    componentKey: input.componentKey,
    ownerId: input.ownerId,
    component: "task-content",
    table: "task_planning_rounds",
    field: "operation_fingerprint",
    keyRevision: input.keyRevision,
  });
  try {
    return computeBlindLookupTag(
      lookupKey,
      JSON.stringify([
        1,
        input.chatId,
        input.operationId,
        content,
        taskContent,
        userMessage,
      ]),
    );
  } finally {
    clearSensitiveBytes(lookupKey);
  }
}

function fingerprintsMatch(left: string, right: string): boolean {
  const leftBytes = decodeBase64Url(left);
  const rightBytes = decodeBase64Url(right);
  try {
    return bytesEqual(leftBytes, rightBytes);
  } finally {
    clearSensitiveBytes(leftBytes);
    clearSensitiveBytes(rightBytes);
  }
}

export async function createTaskOperationRelayRequest(input: {
  chatId: string;
  componentKey: Uint8Array;
  content: TaskPlanningRoundProtectedContent;
  keyRevision: number;
  operationId: string;
  ownerId: string;
  taskContent: TaskProtectedContent;
  userMessage: TaskMessageOpaqueContent;
}): Promise<TaskOperationRelayRequest> {
  const content = taskPlanningRoundProtectedContentSchema.parse(input.content);
  return taskOperationRelayRequestSchema.parse({
    chatId: input.chatId,
    operationId: input.operationId,
    fingerprint: taskOperationFingerprint({
      ...input,
      content,
      taskContent: input.taskContent,
      userMessage: input.userMessage,
    }),
    classification: content.classification,
    protectedInput: await encryptTaskPlanningRoundProtectedContent({
      ownerId: input.ownerId,
      roundId: input.operationId,
      keyRevision: input.keyRevision,
      componentKey: input.componentKey,
      content,
    }),
    task: {
      classification: input.taskContent.classification,
      protectedContent: await encryptTaskProtectedContent({
        ownerId: input.ownerId,
        chatId: input.chatId,
        keyRevision: input.keyRevision,
        componentKey: input.componentKey,
        content: input.taskContent,
      }),
    },
    userMessage: input.userMessage,
  });
}

export async function openTaskOperationRelayRequest(input: {
  componentKey: Uint8Array;
  keyRevision: number;
  ownerId: string;
  request: TaskOperationRelayRequest;
}): Promise<{
  round: TaskPlanningRoundProtectedContent;
  task: TaskProtectedContent;
  userMessage: TaskMessageProtectedContent;
}> {
  const request = taskOperationRelayRequestSchema.parse(input.request);
  const round = await decryptTaskPlanningRoundProtectedContent({
    ownerId: input.ownerId,
    roundId: request.operationId,
    keyRevision: input.keyRevision,
    componentKey: input.componentKey,
    encrypted: request.protectedInput,
    publicClassification: request.classification,
  });
  const task = await decryptTaskProtectedContent({
    ownerId: input.ownerId,
    chatId: request.chatId,
    keyRevision: input.keyRevision,
    componentKey: input.componentKey,
    encrypted: request.task.protectedContent,
    publicClassification: request.task.classification,
  });
  const userMessage = await decryptTaskMessageProtectedContent({
    ownerId: input.ownerId,
    messageId: request.userMessage.id,
    keyRevision: input.keyRevision,
    componentKey: input.componentKey,
    encrypted: request.userMessage.protectedContent,
    publicClassification: request.userMessage.classification,
  });
  const expected = taskOperationFingerprint({
    ownerId: input.ownerId,
    chatId: request.chatId,
    operationId: request.operationId,
    keyRevision: input.keyRevision,
    componentKey: input.componentKey,
    content: round,
    taskContent: task,
    userMessage: request.userMessage,
  });
  if (!fingerprintsMatch(request.fingerprint, expected)) {
    throw new Error("Encrypted Task operation fingerprint is invalid.");
  }
  return { round, task, userMessage };
}

export async function createTaskOperationRelayResult(input: {
  componentKey: Uint8Array;
  content: TaskPlanningRoundProtectedContent;
  assistantMessage: TaskMessageOpaqueContent;
  goal: TaskOperationRelayResult["goal"];
  keyRevision: number;
  ownerId: string;
  request: TaskOperationRelayRequest;
  taskContent: TaskProtectedContent;
}): Promise<TaskOperationRelayResult> {
  const request = taskOperationRelayRequestSchema.parse(input.request);
  const content = taskPlanningRoundProtectedContentSchema.parse(input.content);
  return taskOperationRelayResultSchema.parse({
    chatId: request.chatId,
    operationId: request.operationId,
    fingerprint: request.fingerprint,
    classification: content.classification,
    protectedResult: await encryptTaskPlanningRoundProtectedContent({
      ownerId: input.ownerId,
      roundId: request.operationId,
      keyRevision: input.keyRevision,
      componentKey: input.componentKey,
      content,
    }),
    task: {
      classification: input.taskContent.classification,
      protectedContent: await encryptTaskProtectedContent({
        ownerId: input.ownerId,
        chatId: request.chatId,
        keyRevision: input.keyRevision,
        componentKey: input.componentKey,
        content: input.taskContent,
      }),
    },
    assistantMessage: input.assistantMessage,
    goal: input.goal,
  });
}

export async function openTaskOperationRelayResult(input: {
  componentKey: Uint8Array;
  keyRevision: number;
  ownerId: string;
  request: TaskOperationRelayRequest;
  result: TaskOperationRelayResult;
}): Promise<{
  round: TaskPlanningRoundProtectedContent;
  task: TaskProtectedContent;
  assistantMessage: TaskMessageProtectedContent;
}> {
  const request = taskOperationRelayRequestSchema.parse(input.request);
  const result = taskOperationRelayResultSchema.parse(input.result);
  if (
    result.chatId !== request.chatId ||
    result.operationId !== request.operationId ||
    !fingerprintsMatch(result.fingerprint, request.fingerprint) ||
    result.classification.ordinal !== request.classification.ordinal ||
    result.classification.kind !== request.classification.kind
  ) {
    throw new Error("Encrypted Task operation result metadata is invalid.");
  }
  const round = await decryptTaskPlanningRoundProtectedContent({
    ownerId: input.ownerId,
    roundId: result.operationId,
    keyRevision: input.keyRevision,
    componentKey: input.componentKey,
    encrypted: result.protectedResult,
    publicClassification: result.classification,
  });
  const task = await decryptTaskProtectedContent({
    ownerId: input.ownerId,
    chatId: result.chatId,
    keyRevision: input.keyRevision,
    componentKey: input.componentKey,
    encrypted: result.task.protectedContent,
    publicClassification: result.task.classification,
  });
  const assistantMessage = await decryptTaskMessageProtectedContent({
    ownerId: input.ownerId,
    messageId: result.assistantMessage.id,
    keyRevision: input.keyRevision,
    componentKey: input.componentKey,
    encrypted: result.assistantMessage.protectedContent,
    publicClassification: result.assistantMessage.classification,
  });
  return { round, task, assistantMessage };
}

export function taskOperationRunningClassification(input: {
  kind: TaskPlanningRoundProtectedClassification["kind"];
  ordinal: number;
}): TaskPlanningRoundProtectedClassification {
  return {
    ordinal: input.ordinal,
    kind: input.kind,
    status: "running",
    hasOutputPlan: false,
    hasOutputQuestions: false,
    hasOutputGoalPrompt: false,
    error: null,
  };
}
