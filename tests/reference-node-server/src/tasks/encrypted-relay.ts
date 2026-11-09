import {
  taskOperationRelayRequestSchema,
  taskOperationRelayResultSchema,
  type TaskOperationRelayRequest,
  type TaskOperationRelayResult,
} from "@cantrip/protocol/tasks";

export const ENCRYPTED_TASK_OPERATION_PROMPT =
  "Execute the encrypted Cantrip Task operation.";

export function taskOperationRelayTurnFields(value: TaskOperationRelayRequest) {
  const operation = taskOperationRelayRequestSchema.parse(value);
  return {
    prompt: ENCRYPTED_TASK_OPERATION_PROMPT,
    resultMode: { kind: "task-encrypted" as const, operation },
  };
}

export function parseTaskOperationRelayResult(
  value: unknown,
  requestValue: TaskOperationRelayRequest,
): TaskOperationRelayResult {
  const request = taskOperationRelayRequestSchema.parse(requestValue);
  const result = taskOperationRelayResultSchema.parse(value);
  if (
    result.chatId !== request.chatId ||
    result.operationId !== request.operationId ||
    result.fingerprint !== request.fingerprint ||
    result.classification.ordinal !== request.classification.ordinal ||
    result.classification.kind !== request.classification.kind
  ) {
    throw new Error("Encrypted Task operation result metadata is invalid.");
  }
  return result;
}
