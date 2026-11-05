import type { TaskOperationRelayResult } from "@cantrip/protocol/tasks";
import type { WorkerNotification } from "@cantrip/protocol";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "./schema.js";
import type {
  RepositoryDatabase,
  RepositoryTransaction,
} from "./repository/database.js";
import type { ChatExecutionLaneRepository } from "./repository/chat-execution-lanes.js";
import type { MessageWriteRepository } from "./repository/message-writes.js";
import { projectChatExecutionLock } from "./repository/chat-execution-lock.js";
import {
  assertTaskOperationDispatchFence,
  type TaskOperationLeaseFence,
} from "./task-operation-fence.js";
import { TaskDispatchConflictError } from "./task-dispatch.js";
import { parseTaskOperationRelayResult } from "../tasks/encrypted-relay.js";

type Outcome = Extract<WorkerNotification, { type: "chat.turn.outcome" }>;
interface Dependencies {
  database: RepositoryDatabase;
  lanes?: ChatExecutionLaneRepository;
  messages?: MessageWriteRepository;
  complete(
    tx: RepositoryTransaction,
    result: TaskOperationRelayResult,
    turnId: string | null,
    guard: TaskOperationLeaseFence,
  ): Promise<unknown>;
}
function stale(): never {
  throw new TaskDispatchConflictError(
    "The finalized Task Goal was replaced or revoked.",
    "stale-lease",
  );
}

/** A completed finalizer is durable Goal startup work, not a completed Goal.
 * Commit its protected history and return the SAME canonical cycle to dispatch.
 * No provider ticket is granted/released here and no prompt is copied. */
export async function recoverFinalizationGoalOutcome(
  dependencies: Dependencies,
  owner: string,
  worker: string,
  n: Outcome,
) {
  const fence = n.taskDispatchFence;
  if (
    !n.outcome.ok ||
    n.contextKind !== "project" ||
    !fence ||
    !n.taskInferenceInputOperationId
  )
    return null;
  const outcome = n.outcome.result;
  const guard: TaskOperationLeaseFence = {
    kind: "leased",
    lease: fence,
    inferenceInputOperationId: n.taskInferenceInputOperationId,
  };
  return dependencies.database.transaction(async (tx) => {
    // The same owner lock used by claim/enqueue protects the lookup as well as
    // the final write, including a missing late execution-association callback.
    const [ownerRow] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, owner))
      .for("update")
      .limit(1);
    if (!ownerRow) return null;
    const [round] = await tx
      .select()
      .from(schema.taskPlanningRounds)
      .where(
        and(
          eq(schema.taskPlanningRounds.chatId, n.chatId),
          eq(schema.taskPlanningRounds.id, fence.operationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!round || round.kind !== "finalize") return null;
    let result: TaskOperationRelayResult;
    try {
      result = parseTaskOperationRelayResult(
        outcome.structuredResult,
        round.relayRequest,
      );
    } catch {
      return null;
    } // Existing invalid-result handling owns this failure.
    if (!result.goal) return null;
    await assertTaskOperationDispatchFence(
      tx,
      owner,
      n.chatId,
      round.id,
      guard,
    );
    const [cycle] = await tx
      .select()
      .from(schema.taskDispatchCycles)
      .where(eq(schema.taskDispatchCycles.id, fence.cycleId))
      .for("update")
      .limit(1);
    // assertTaskOperationDispatchFence also requires this to be the latest cycle.
    if (!cycle || cycle.operationKind !== "finalize") stale();
    const input = round.inferenceInput;
    const receipt = input?.receipt;
    if (
      !input ||
      !input.accepted ||
      !input.dispatched ||
      input.failedBeforeDispatch ||
      !receipt ||
      receipt.kind === "goal" ||
      receipt.operationId !== n.taskInferenceInputOperationId ||
      receipt.workerId !== worker ||
      receipt.clientMessageId !== n.clientMessageId ||
      receipt.executionLaneId !== n.executionLaneId ||
      receipt.worktreeId !== n.worktreeId ||
      receipt.dispatch.cycleId !== fence.cycleId ||
      receipt.dispatch.operationId !== fence.operationId ||
      receipt.dispatch.fencingToken !== fence.fencingToken ||
      receipt.dispatch.leaseOwner !== fence.leaseOwner
    )
      stale();
    await tx.execute(projectChatExecutionLock(owner, n.chatId));
    const [placement] = await tx
      .select({ chat: schema.chats, project: schema.projects })
      .from(schema.chats)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, owner),
        ),
      )
      .where(eq(schema.chats.id, n.chatId))
      .for("update")
      .limit(1);
    const [task] = await tx
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.chatId, n.chatId))
      .for("update")
      .limit(1);
    if (
      !placement ||
      placement.chat.experience !== "task" ||
      placement.chat.archivedAt ||
      !task ||
      !task.planGoalEnabled ||
      task.planningRound !== round.ordinal
    )
      stale();
    // A live launcher may already own implementation. Never replay its kickoff.
    if (cycle.goalInput || task.implementationStartedAt)
      return { state: "owned" as const, message: null, chat: placement.chat };
    if (
      task.activeOperationId !== round.id ||
      ["complete", "failed"].includes(task.state)
    )
      stale();
    const [lane] = await tx
      .select()
      .from(schema.chatExecutionLanes)
      .where(
        and(
          eq(schema.chatExecutionLanes.id, receipt.executionLaneId),
          eq(schema.chatExecutionLanes.chatId, n.chatId),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !lane ||
      lane.activatedAt?.toISOString() !== receipt.executionLaneActivatedAt ||
      lane.workerId !== worker ||
      lane.worktreeId !== receipt.worktreeId ||
      placement.chat.activeWorkerId !== worker ||
      placement.chat.activeWorktreeId !== receipt.worktreeId
    )
      stale();
    if (!dependencies.messages || !dependencies.lanes)
      throw new Error(
        "Finalizer recovery requires transactional history and lane ownership.",
      );
    await dependencies.complete(tx, result, outcome.turnId ?? null, guard);
    const message = await dependencies.messages
      .inTransaction(tx)
      .appendTaskMessage(owner, n.chatId, result.assistantMessage, {
        executionLaneId: lane.id,
        worktreeId: receipt.worktreeId,
      });
    if (!message) stale();
    await tx
      .update(schema.taskPlanningRounds)
      .set({
        executionLaneId: lane.id,
        userMessageId: receipt.clientMessageId,
        assistantMessageId: message.id,
      })
      .where(eq(schema.taskPlanningRounds.id, round.id));
    await dependencies.lanes
      .inTransaction(tx)
      .updateChatExecutionLaneRuntime(
        n.chatId,
        lane.id,
        outcome.threadId,
        "ready",
      );
    await dependencies.lanes
      .inTransaction(tx)
      .finishChatExecutionLane(n.chatId, lane.id, "idle", {
        expectedActivatedAt: receipt.executionLaneActivatedAt,
        markUnreadCompletion: false,
      });
    const now = new Date();
    await tx
      .update(schema.agentInteractionRequests)
      .set({ status: "interrupted", resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.agentInteractionRequests.chatId, n.chatId),
          eq(schema.agentInteractionRequests.executionLaneId, lane.id),
          eq(schema.agentInteractionRequests.status, "pending"),
        ),
      );
    const [active] = await tx
      .select({ id: schema.chatExecutionLanes.id })
      .from(schema.chatExecutionLanes)
      .where(
        and(
          eq(schema.chatExecutionLanes.chatId, n.chatId),
          eq(schema.chatExecutionLanes.state, "active"),
        ),
      )
      .limit(1);
    if (!active)
      await tx
        .update(schema.chats)
        .set({ status: "idle", updatedAt: now })
        .where(eq(schema.chats.id, n.chatId));
    const paused =
      placement.chat.automationPaused ||
      placement.project.taskSchedulingPaused ||
      task.state === "paused";
    await tx
      .update(schema.taskDispatchCycles)
      .set({
        state: paused ? "paused" : "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: null,
        fencingToken: sql`${schema.taskDispatchCycles.fencingToken}+1`,
        // Reclaiming startup continues this finalization attempt; it is not a new
        // finalization/model retry. The next ordinary claim restores this count.
        attemptCount: Math.max(0, cycle.attemptCount - 1),
        claimedAt: null,
        startedAt: null,
        completedAt: null,
        pausedAt: paused ? now : null,
        turnId: null,
        codexThreadId: outcome.threadId,
        eligibilityCode: null,
        updatedAt: now,
      })
      .where(eq(schema.taskDispatchCycles.id, cycle.id));
    return { state: "queued" as const, message, chat: placement.chat };
  });
}
