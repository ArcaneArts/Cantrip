import {
  taskOperationRelayRequestSchema,
  taskOperationRelayResultSchema,
  taskPlanningRoundProtectedContentSchema,
  type TaskOperationRelayRequest,
  type TaskOperationRelayResult,
  type TaskPlanningRoundProtectedClassification,
  type TaskPlanningRoundProtectedContent,
} from "@cantrip/protocol/tasks";

import { bytesEqual, clearSensitiveBytes, decodeBase64Url } from "./bytes.js";
import { computeBlindLookupTag, deriveLookupKey } from "./kdf.js";
import {
  decryptTaskPlanningRoundProtectedContent,
  encryptTaskPlanningRoundProtectedContent,
} from "./task-content.js";

function taskOperationFingerprint(input: {
  chatId: string;
  componentKey: Uint8Array;
  content: TaskPlanningRoundProtectedContent;
  keyRevision: number;
  operationId: string;
  ownerId: string;
}): string {
  const content = taskPlanningRoundProtectedContentSchema.parse(input.content);
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
      JSON.stringify([1, input.chatId, input.operationId, content]),
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
}): Promise<TaskOperationRelayRequest> {
  const content = taskPlanningRoundProtectedContentSchema.parse(input.content);
  return taskOperationRelayRequestSchema.parse({
    chatId: input.chatId,
    operationId: input.operationId,
    fingerprint: taskOperationFingerprint({ ...input, content }),
    classification: content.classification,
    protectedInput: await encryptTaskPlanningRoundProtectedContent({
      ownerId: input.ownerId,
      roundId: input.operationId,
      keyRevision: input.keyRevision,
      componentKey: input.componentKey,
      content,
    }),
  });
}

export async function openTaskOperationRelayRequest(input: {
  componentKey: Uint8Array;
  keyRevision: number;
  ownerId: string;
  request: TaskOperationRelayRequest;
}): Promise<TaskPlanningRoundProtectedContent> {
  const request = taskOperationRelayRequestSchema.parse(input.request);
  const content = await decryptTaskPlanningRoundProtectedContent({
    ownerId: input.ownerId,
    roundId: request.operationId,
    keyRevision: input.keyRevision,
    componentKey: input.componentKey,
    encrypted: request.protectedInput,
    publicClassification: request.classification,
  });
  const expected = taskOperationFingerprint({
    ownerId: input.ownerId,
    chatId: request.chatId,
    operationId: request.operationId,
    keyRevision: input.keyRevision,
    componentKey: input.componentKey,
    content,
  });
  if (!fingerprintsMatch(request.fingerprint, expected)) {
    throw new Error("Encrypted Task operation fingerprint is invalid.");
  }
  return content;
}

export async function createTaskOperationRelayResult(input: {
  componentKey: Uint8Array;
  content: TaskPlanningRoundProtectedContent;
  goal: TaskOperationRelayResult["goal"];
  keyRevision: number;
  ownerId: string;
  request: TaskOperationRelayRequest;
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
    goal: input.goal,
  });
}

export async function openTaskOperationRelayResult(input: {
  componentKey: Uint8Array;
  keyRevision: number;
  ownerId: string;
  request: TaskOperationRelayRequest;
  result: TaskOperationRelayResult;
}): Promise<TaskPlanningRoundProtectedContent> {
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
  return decryptTaskPlanningRoundProtectedContent({
    ownerId: input.ownerId,
    roundId: result.operationId,
    keyRevision: input.keyRevision,
    componentKey: input.componentKey,
    encrypted: result.protectedResult,
    publicClassification: result.classification,
  });
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
