import { and, desc, eq } from "drizzle-orm";
import {
  workerChatTurnOutcomeNotificationSchema,
  inferenceNeverStarted,
  taskInferenceInputReceiptSchema,
  type WorkerNotification,
} from "@cantrip/protocol";
import type { RepositoryDatabase } from "./repository/database.js";
import type { MessageWriteRepository } from "./repository/message-writes.js";
import { projectChatExecutionLock } from "./repository/chat-execution-lock.js";
import { nativeHistoryPayloadDigest } from "./repository/native-history-digest.js";
import { TaskDispatchConflictError } from "./task-dispatch.js";
import { parseTaskOperationRelayResult } from "../tasks/encrypted-relay.js";
import { classifyTaskFailure } from "../tasks/automatic-retry.js";
import * as schema from "./schema.js";

type Outcome = Extract<WorkerNotification, { type: "chat.turn.outcome" }>;
function stale(): never {
  throw new TaskDispatchConflictError(
    "The historical Task round input does not match its receipt.",
    "stale-lease",
  );
}

/** Captured facts from definitively historical inputs may save protected history
 * only. This never changes Task, lane, dispatch, retry, queue or provider state. */
export async function persistHistoricalRoundOutcome(
  database: RepositoryDatabase,
  messages: MessageWriteRepository | undefined,
  owner: string,
  worker: string,
  n: Outcome,
) {
  const f = n.taskDispatchFence;
  if (!f || !n.taskInferenceInputOperationId) return null;
  return database.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, owner))
      .for("update")
      .limit(1);
    if (!user) return null;
    const [round] = await tx
      .select()
      .from(schema.taskPlanningRounds)
      .where(
        and(
          eq(schema.taskPlanningRounds.chatId, n.chatId),
          eq(schema.taskPlanningRounds.id, f.operationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!round) return null;
    await tx.execute(projectChatExecutionLock(owner, n.chatId));
    const [row] = await tx
      .select({
        chat: schema.chats,
        projectId: schema.projects.id,
        task: schema.tasks,
        inputMessage: schema.chatMessages,
      })
      .from(schema.chats)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, owner),
        ),
      )
      .innerJoin(schema.tasks, eq(schema.tasks.chatId, schema.chats.id))
      .innerJoin(
        schema.chatMessages,
        and(
          eq(schema.chatMessages.chatId, schema.chats.id),
          eq(schema.chatMessages.id, n.clientMessageId),
        ),
      )
      .where(eq(schema.chats.id, n.chatId))
      .for("update")
      .limit(1);
    if (!row) return null;
    const input = round.inferenceInput;
    const parsed = taskInferenceInputReceiptSchema.safeParse(input?.receipt);
    if (!input || !parsed.success) return null;
    const r = parsed.data;
    if (
      r.kind === "goal" ||
      input.deferred ||
      row.chat.experience !== "task" ||
      r.operationId !== n.taskInferenceInputOperationId ||
      r.chatId !== n.chatId ||
      r.workerId !== worker ||
      r.clientMessageId !== n.clientMessageId ||
      r.executionLaneId !== n.executionLaneId ||
      r.worktreeId !== n.worktreeId ||
      r.dispatch.cycleId !== f.cycleId ||
      r.dispatch.operationId !== f.operationId ||
      r.dispatch.fencingToken !== f.fencingToken ||
      r.dispatch.leaseOwner !== f.leaseOwner ||
      round.relayRequest.userMessage.id !== r.clientMessageId ||
      row.inputMessage.role !== "user" ||
      row.inputMessage.mode !==
        (round.kind === "direct" ? "default" : "plan") ||
      row.inputMessage.taskProtectedContent === null ||
      row.inputMessage.content ||
      (n.outcome.ok &&
        (!input.accepted || !input.dispatched || input.failedBeforeDispatch))
    )
      stale();
    const digest = nativeHistoryPayloadDigest(
      workerChatTurnOutcomeNotificationSchema.parse(n).outcome,
    );
    if (input.terminal?.projectedAt) {
      if (input.terminal.outcomeDigest !== digest) stale();
      return {
        state: "owned" as const,
        message: null,
        chat: { projectId: row.projectId, experience: "task" as const },
        terminal: input.terminal,
      };
    }
    const [cycle] = await tx
      .select()
      .from(schema.taskDispatchCycles)
      .where(
        and(
          eq(schema.taskDispatchCycles.id, f.cycleId),
          eq(schema.taskDispatchCycles.ownerId, owner),
          eq(schema.taskDispatchCycles.chatId, n.chatId),
        ),
      )
      .for("update")
      .limit(1);
    const [latest] = await tx
      .select({ id: schema.taskDispatchCycles.id })
      .from(schema.taskDispatchCycles)
      .where(
        and(
          eq(schema.taskDispatchCycles.ownerId, owner),
          eq(schema.taskDispatchCycles.chatId, n.chatId),
        ),
      )
      .orderBy(
        desc(schema.taskDispatchCycles.createdAt),
        desc(schema.taskDispatchCycles.id),
      )
      .limit(1);
    const [lane] = await tx
      .select({ activatedAt: schema.chatExecutionLanes.activatedAt })
      .from(schema.chatExecutionLanes)
      .where(
        and(
          eq(schema.chatExecutionLanes.id, r.executionLaneId),
          eq(schema.chatExecutionLanes.chatId, n.chatId),
        ),
      )
      .limit(1);
    const historical =
      row.chat.archivedAt !== null ||
      row.task.planningRound !== round.ordinal ||
      row.task.activeOperationId !== round.id ||
      row.chat.activeWorkerId !== r.workerId ||
      row.chat.activeWorktreeId !== r.worktreeId ||
      !cycle ||
      latest?.id !== cycle.id ||
      ["succeeded", "failed", "cancelled"].includes(cycle.state) ||
      cycle.goalInput !== null ||
      lane?.activatedAt?.toISOString() !== r.executionLaneActivatedAt;
    if (!historical) return null;
    let result: ReturnType<typeof parseTaskOperationRelayResult> | null = null;
    if (n.outcome.ok) {
      try {
        result = parseTaskOperationRelayResult(
          n.outcome.result.structuredResult,
          round.relayRequest,
        );
      } catch {
        /* Invalid output is a terminal fact, not permission to change this Task. */
      }
    }
    const now = new Date().toISOString();
    const terminal = {
      ok: result !== null,
      failureKind: result
        ? null
        : classifyTaskFailure(
            n.outcome.ok
              ? "Recovered Task result was invalid."
              : n.outcome.error,
          ),
      outcomeDigest: digest,
      historyOnly: true,
      observedAt: now,
      projectedAt: now,
      threadId: n.outcome.ok ? n.outcome.result.threadId : null,
      turnId: n.outcome.ok
        ? (n.outcome.result.turnId ?? null)
        : (n.outcome.inference?.turnId ?? null),
    };
    if (!messages)
      throw new Error(
        "Historical Task round outcomes require protected message storage.",
      );
    const [root] = await tx
      .select({ id: schema.projectWorktrees.id })
      .from(schema.projectWorktrees)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectWorktrees.projectId),
          eq(schema.projects.ownerId, owner),
        ),
      )
      .where(eq(schema.projectWorktrees.id, r.worktreeId))
      .limit(1);
    const worktreeId = root?.id ?? row.inputMessage.worktreeId;
    if (!worktreeId) stale();
    const saved = result
      ? await messages
          .inTransaction(tx)
          .appendTaskMessage(
            owner,
            r.chatId,
            result.assistantMessage,
            { executionLaneId: r.executionLaneId, worktreeId },
            { historical: true },
          )
      : null;
    if (result && !saved) stale();
    await tx
      .update(schema.taskPlanningRounds)
      .set({ inferenceInput: { ...input, terminal } })
      .where(eq(schema.taskPlanningRounds.id, round.id));
    return {
      state: "owned" as const,
      message: saved,
      chat: { projectId: row.projectId, experience: "task" as const },
      terminal,
    };
  });
}

/** Actual deletion, replacement, or a proven unforwarded deferred failure only. */
export async function roundOutcomeRetirement(
  database: RepositoryDatabase,
  owner: string,
  worker: string,
  n: Outcome,
) {
  const f = n.taskDispatchFence;
  if (!f || !n.taskInferenceInputOperationId) return null;
  return database.transaction(async (tx) => {
    await tx.execute(projectChatExecutionLock(owner, n.chatId));
    const [row] = await tx
      .select({
        input: schema.taskPlanningRounds.inferenceInput,
        messageId: schema.chatMessages.id,
      })
      .from(schema.taskPlanningRounds)
      .innerJoin(
        schema.chats,
        eq(schema.chats.id, schema.taskPlanningRounds.chatId),
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, owner),
        ),
      )
      .leftJoin(
        schema.chatMessages,
        and(
          eq(schema.chatMessages.chatId, schema.chats.id),
          eq(schema.chatMessages.id, n.clientMessageId),
        ),
      )
      .where(
        and(
          eq(schema.taskPlanningRounds.id, f.operationId),
          eq(schema.taskPlanningRounds.chatId, n.chatId),
        ),
      )
      .limit(1);
    if (!row || !row.messageId) return "canonical-input-deleted" as const;
    const parsed = taskInferenceInputReceiptSchema.safeParse(
      row.input?.receipt,
    );
    if (
      !parsed.success ||
      parsed.data.chatId !== n.chatId ||
      parsed.data.dispatch.operationId !== f.operationId
    )
      return null;
    const r = parsed.data;
    if (r.operationId !== n.taskInferenceInputOperationId)
      return "canonical-input-replaced" as const;
    const proof = !n.outcome.ok ? n.outcome.inference : undefined;
    const neverForwarded =
      proof !== undefined &&
      inferenceNeverStarted(proof) &&
      proof.operationId === r.operationId &&
      proof.providerId === r.providerId &&
      proof.chatId === r.chatId &&
      proof.messageId === r.clientMessageId;
    if (
      !n.outcome.ok &&
      row.input?.deferred &&
      row.input.accepted &&
      row.input.allAttemptsEnforced &&
      row.input.firstDispatchedOperationId === null &&
      (row.input.failedBeforeDispatch || neverForwarded) &&
      r.workerId === worker &&
      r.clientMessageId === n.clientMessageId
    )
      return "canonical-input-deferred" as const;
    return null;
  });
}
