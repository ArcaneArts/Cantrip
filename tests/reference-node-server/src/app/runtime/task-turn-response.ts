import type {
  AgentTurnResult,
  TaskInferenceInputReceipt,
  TaskMessageOpaqueContent,
} from "@cantrip/protocol";
import { taskMessageRelayResultSchema } from "@cantrip/protocol/tasks";
import type { TaskGoalInferenceInputRepository } from "../../db/task-goal-inference-inputs.js";
import { taskResponsePublicationKind } from "../../db/task-response-publication.js";

/** The immediate command result needs the same canonical receipt validation as
 * durable notification delivery before it can reuse a native publisher. */
async function acceptTaskTurnResponse(
  goals: TaskGoalInferenceInputRepository,
  owner: string,
  worker: string,
  receipt: TaskInferenceInputReceipt | undefined,
  message: TaskMessageOpaqueContent,
  publication: { id: string; idempotencyKey: string },
  result: AgentTurnResult,
) {
  const kind = taskResponsePublicationKind(
    message,
    publication,
    result,
    result.turnId ? { threadId: result.threadId, turnId: result.turnId } : null,
  );
  if (kind === "assigned") return true;
  if (!kind || !receipt) return false;
  const saved = await goals.applyOutcome(
    owner,
    worker,
    {
      type: "chat.turn.outcome",
      chatId: receipt.chatId,
      clientMessageId: receipt.clientMessageId,
      executionLaneId: receipt.executionLaneId,
      worktreeId: receipt.worktreeId,
      contextKind: "project",
      scratchRootId: null,
      taskDispatchFence: receipt.dispatch,
      taskInferenceInputOperationId: receipt.operationId,
      outcome: { ok: true, result },
    },
    { recordOnly: true },
  );
  return saved?.terminal?.ok === true && saved.message?.id === message.id;
}

export async function taskTurnResponse(
  goals: TaskGoalInferenceInputRepository,
  owner: string,
  worker: string,
  receipt: TaskInferenceInputReceipt | undefined,
  publication: { id: string; idempotencyKey: string },
  result: AgentTurnResult,
  mode: TaskMessageOpaqueContent["classification"]["mode"],
) {
  const { message } = taskMessageRelayResultSchema.parse(
    result.structuredResult,
  );
  if (
    message.classification.mode !== mode ||
    !(await acceptTaskTurnResponse(
      goals,
      owner,
      worker,
      receipt,
      message,
      publication,
      result,
    ))
  )
    throw new Error("The encrypted Task message result metadata is invalid.");
  return message;
}
