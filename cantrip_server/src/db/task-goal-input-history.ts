import { and, eq } from "drizzle-orm";
import {
  taskInferenceInputReceiptSchema,
  taskMessageRelayResultSchema,
  type WorkerNotification,
  type TaskMessageOpaqueContent,
} from "@cantrip/protocol";
import type { RepositoryTransaction } from "./repository/database.js";
import type { MessageWriteRepository } from "./repository/message-writes.js";
import { projectChatExecutionLock } from "./repository/chat-execution-lock.js";
import { TaskDispatchConflictError } from "./task-dispatch.js";
import { classifyTaskFailure } from "../tasks/automatic-retry.js";
import * as schema from "./schema.js";

function stale(): never {
  throw new TaskDispatchConflictError(
    "The historical Task Goal input receipt does not match its message.",
    "stale-lease",
  );
}
/** A retired placement/input may contribute history only. No Task, lane, Chat
 * status, interaction, dispatch, queue or provider ownership is changed here. */
export async function recoverGoalInputHistory(
  tx: RepositoryTransaction,
  owner: string,
  worker: string,
  n: Extract<WorkerNotification, { type: "chat.turn.outcome" }>,
  messages?: MessageWriteRepository,
) {
  await tx.execute(projectChatExecutionLock(owner, n.chatId));
  const [row] = await tx
    .select({
      message: schema.chatMessages,
      projectId: schema.projects.id,
      experience: schema.chats.experience,
    })
    .from(schema.chatMessages)
    .innerJoin(schema.chats, eq(schema.chats.id, schema.chatMessages.chatId))
    .innerJoin(
      schema.projects,
      and(
        eq(schema.projects.id, schema.chats.projectId),
        eq(schema.projects.ownerId, owner),
      ),
    )
    .where(
      and(
        eq(schema.chatMessages.id, n.clientMessageId),
        eq(schema.chatMessages.chatId, n.chatId),
      ),
    )
    .for("update")
    .limit(1);
  const state = row?.message.taskGoalInput;
  if (
    !row ||
    !state ||
    state.receipt.operationId !== n.taskInferenceInputOperationId
  )
    return null;
  const r = taskInferenceInputReceiptSchema.parse(state.receipt),
    f = n.taskDispatchFence;
  if (
    !f ||
    row.experience !== "task" ||
    r.kind !== "goal" ||
    state.deferred ||
    r.chatId !== n.chatId ||
    r.workerId !== worker ||
    r.clientMessageId !== n.clientMessageId ||
    r.worktreeId !== n.worktreeId ||
    r.executionLaneId !== n.executionLaneId ||
    r.dispatch.cycleId !== f.cycleId ||
    r.dispatch.operationId !== f.operationId ||
    r.dispatch.fencingToken !== f.fencingToken ||
    r.dispatch.leaseOwner !== f.leaseOwner ||
    row.message.mode !== "goal" ||
    !["user", "system"].includes(row.message.role) ||
    !row.message.taskProtectedContent ||
    row.message.content ||
    (n.outcome.ok &&
      (!state.accepted || !state.dispatched || state.failedBeforeDispatch))
  )
    stale();
  let message: TaskMessageOpaqueContent | null = null;
  if (n.outcome.ok) {
    try {
      const candidate = taskMessageRelayResultSchema.parse(
        n.outcome.result.structuredResult,
      ).message;
      if (candidate.idempotencyKey === `assistant:${r.clientMessageId}`)
        message = candidate;
    } catch {
      /* Invalid protected output is a terminal failure, not a new Task failure. */
    }
  }
  const ok = n.outcome.ok && message !== null;
  const failureKind = ok
    ? null
    : classifyTaskFailure(
        n.outcome.ok
          ? "Task Goal outcome omitted its canonical protected response."
          : n.outcome.error,
      );
  if (
    state.terminal &&
    (state.terminal.ok !== ok || state.terminal.failureKind !== failureKind)
  )
    stale();
  const terminal = state.terminal ?? {
    ok,
    failureKind,
    observedAt: new Date().toISOString(),
    projectedAt: null,
    threadId: n.outcome.ok ? n.outcome.result.threadId : null,
    turnId: n.outcome.ok
      ? (n.outcome.result.turnId ?? null)
      : (n.outcome.inference?.turnId ?? null),
  };
  if (!messages)
    throw new Error(
      "Historical Task Goal output requires protected message storage.",
    );
  const [physicalRoot] = await tx
    .select({ id: schema.projectWorktrees.id })
    .from(schema.projectWorktrees)
    .innerJoin(
      schema.projectSources,
      eq(schema.projectSources.id, schema.projectWorktrees.projectSourceId),
    )
    .innerJoin(
      schema.projects,
      and(
        eq(schema.projects.id, schema.projectSources.projectId),
        eq(schema.projects.ownerId, owner),
      ),
    )
    .where(eq(schema.projectWorktrees.id, r.worktreeId))
    .limit(1);
  const worktreeId = physicalRoot?.id ?? row.message.worktreeId;
  if (!worktreeId) stale();
  const saved = message
    ? await messages
        .inTransaction(tx)
        .appendTaskMessage(
          owner,
          r.chatId,
          message,
          { executionLaneId: r.executionLaneId, worktreeId },
          { historical: true },
        )
    : null;
  if (message && !saved) stale();
  await tx
    .update(schema.chatMessages)
    .set({ taskGoalInput: { ...state, terminal } })
    .where(
      and(
        eq(schema.chatMessages.id, r.clientMessageId),
        eq(schema.chatMessages.chatId, r.chatId),
      ),
    );
  return {
    receipt: r,
    terminal,
    message: saved,
    finished: false,
    historyOnly: true,
    chat: { projectId: row.projectId, experience: "task" as const },
  };
}
