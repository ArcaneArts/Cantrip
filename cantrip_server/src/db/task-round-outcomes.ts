import type { TaskOperationRelayResult } from "@cantrip/protocol/tasks";
import {
  workerChatTurnOutcomeNotificationSchema,
  type WorkerNotification,
} from "@cantrip/protocol";
import { nativeHistoryPayloadDigest } from "./repository/native-history-digest.js";
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
  type TaskOperationDispatchFence,
} from "./task-operation-fence.js";
import { TaskDispatchConflictError } from "./task-dispatch.js";
import { parseTaskOperationRelayResult } from "../tasks/encrypted-relay.js";
import { TaskRetryRepository } from "./task-retries.js";
import { classifyTaskFailure } from "../tasks/automatic-retry.js";

type Outcome = Extract<WorkerNotification, { type: "chat.turn.outcome" }>;
interface Dependencies {
  database: RepositoryDatabase;
  lanes?: ChatExecutionLaneRepository;
  messages?: MessageWriteRepository;
  complete(
    tx: RepositoryTransaction,
    result: TaskOperationRelayResult,
    turnId: string | null,
    guard: TaskOperationDispatchFence,
  ): Promise<unknown>;
  fail(
    tx: RepositoryTransaction,
    guard: TaskOperationDispatchFence,
  ): Promise<unknown>;
}
function stale(): never {
  throw new TaskDispatchConflictError(
    "The Task outcome receipt was replaced or revoked.",
    "stale-lease",
  );
}

/** A worker terminal receipt settles its exact round even after lease expiry.
 * Finalization remains durable Goal startup on the SAME dispatch cycle.
 * This authority never grants inference or releases worker provider capacity. */
export async function recoverRoundOutcome(
  dependencies: Dependencies,
  owner: string,
  worker: string,
  n: Outcome,
) {
  const fence = n.taskDispatchFence;
  if (n.contextKind !== "project" || !fence || !n.taskInferenceInputOperationId)
    return null;
  const outcome = n.outcome.ok ? n.outcome.result : null;
  const guard: TaskOperationDispatchFence = {
    kind: "outcome",
    ...fence,
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
    if (!round) return null;
    let result: TaskOperationRelayResult | null = null;
    if (outcome) {
      try {
        result = parseTaskOperationRelayResult(
          outcome.structuredResult,
          round.relayRequest,
        );
      } catch {
        /* A terminal invalid result follows the canonical failure path. */
      }
    }
    const input = round.inferenceInput;
    const receipt = input?.receipt;
    if (
      !input ||
      (outcome !== null &&
        (!input.accepted || !input.dispatched || input.failedBeforeDispatch)) ||
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
    const failureKind = result
      ? null
      : classifyTaskFailure(
          n.outcome.ok ? "Recovered Task result was invalid." : n.outcome.error,
        );
    const outcomeDigest = nativeHistoryPayloadDigest(
      workerChatTurnOutcomeNotificationSchema.parse(n).outcome,
    );
    const terminal = input.terminal;
    if (terminal?.projectedAt) {
      if (
        terminal.ok !== (result !== null) ||
        terminal.failureKind !== failureKind ||
        terminal.outcomeDigest !== outcomeDigest ||
        (outcome &&
          (terminal.threadId !== outcome.threadId ||
            (outcome.turnId != null && terminal.turnId !== outcome.turnId)))
      )
        stale();
      // A prior transaction is positive terminal evidence. Validate current
      // read authorization, but never replay its Task/lane/dispatch mutations.
      const [authorization] = await tx
        .select({
          projectId: schema.projects.id,
          experience: schema.chats.experience,
        })
        .from(schema.chats)
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.id, schema.chats.projectId),
            eq(schema.projects.ownerId, owner),
          ),
        )
        .where(eq(schema.chats.id, n.chatId))
        .limit(1);
      if (!authorization || authorization.experience !== "task") return null;
      return {
        state: "owned" as const,
        message: null,
        chat: { ...authorization, experience: "task" as const },
        terminal,
      };
    }
    const [cycle] = await tx
      .select()
      .from(schema.taskDispatchCycles)
      .where(eq(schema.taskDispatchCycles.id, fence.cycleId))
      .for("update")
      .limit(1);
    // assertTaskOperationDispatchFence also requires this to be the latest cycle.
    if (!cycle || cycle.operationKind !== round.kind) stale();
    if (guard.kind !== "outcome" || !guard.inferenceInputOperationId) stale();
    guard.roundProjection = {
      control: {
        fencingToken: cycle.fencingToken,
        leaseOwner: cycle.leaseOwner,
        state: cycle.state,
      },
    };
    await assertTaskOperationDispatchFence(
      tx,
      owner,
      n.chatId,
      round.id,
      guard,
    );
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
      task.planningRound !== round.ordinal
    )
      stale();
    // The ownership guard above establishes the Task routing shape.
    const chat = placement.chat as typeof placement.chat & {
      experience: "task";
    };
    // A live launcher may already own implementation. Never replay its kickoff.
    if (
      cycle.goalInput ||
      (round.kind === "finalize" && task.implementationStartedAt)
    )
      return {
        state: "owned" as const,
        message: null,
        chat,
        terminal: undefined,
      };
    if (
      task.activeOperationId !== round.id &&
      !(round.relayResult && task.activeOperationId === null)
    )
      stale();
    // A contradictory failed redelivery cannot erase a completed round.
    if (round.relayResult && !result)
      return {
        state: "owned" as const,
        message: null,
        chat,
        terminal: undefined,
      };
    const goalStartup = result !== null && round.kind === "finalize";
    if (goalStartup && !task.planGoalEnabled) stale();
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
        "Task outcome recovery requires transactional history and lane ownership.",
      );
    let message: Awaited<
      ReturnType<MessageWriteRepository["appendTaskMessage"]>
    > = null;
    if (result && outcome) {
      await dependencies.complete(tx, result, outcome.turnId ?? null, guard);
      message = await dependencies.messages
        .inTransaction(tx)
        .appendTaskMessage(owner, n.chatId, result.assistantMessage, {
          executionLaneId: lane.id,
          worktreeId: receipt.worktreeId,
        });
      if (!message) stale();
      if (!goalStartup)
        await new TaskRetryRepository(tx).clearPending(owner, n.chatId, guard);
      await tx
        .update(schema.taskPlanningRounds)
        .set({
          executionLaneId: lane.id,
          userMessageId: receipt.clientMessageId,
          assistantMessageId: message.id,
        })
        .where(eq(schema.taskPlanningRounds.id, round.id));
    } else {
      await dependencies.fail(tx, guard);
      await new TaskRetryRepository(tx).noteFailure(
        owner,
        n.chatId,
        `dispatch:${fence.cycleId}:${fence.fencingToken}`,
        classifyTaskFailure(
          n.outcome.ok ? "Recovered Task result was invalid." : n.outcome.error,
        ),
        undefined,
        guard,
      );
    }
    await tx
      .update(schema.taskPlanningRounds)
      .set({ executionLaneId: lane.id, userMessageId: receipt.clientMessageId })
      .where(eq(schema.taskPlanningRounds.id, round.id));
    if (outcome)
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
      .finishChatExecutionLane(n.chatId, lane.id, result ? "idle" : "failed", {
        expectedActivatedAt: receipt.executionLaneActivatedAt,
        markUnreadCompletion: !goalStartup,
      });
    const now = new Date();
    const observedTerminal = {
      ok: result !== null,
      failureKind,
      outcomeDigest,
      observedAt: terminal?.observedAt ?? now.toISOString(),
      projectedAt: now.toISOString(),
      threadId: outcome?.threadId ?? cycle.codexThreadId,
      turnId: outcome?.turnId ?? cycle.turnId,
    };
    await tx
      .update(schema.taskPlanningRounds)
      .set({ inferenceInput: { ...input, terminal: observedTerminal } })
      .where(eq(schema.taskPlanningRounds.id, round.id));
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
        .set({ status: result ? "idle" : "failed", updatedAt: now })
        .where(eq(schema.chats.id, n.chatId));
    if (!goalStartup) {
      await tx
        .update(schema.taskDispatchCycles)
        .set({
          state: result ? "succeeded" : "failed",
          turnId: outcome?.turnId ?? cycle.turnId,
          codexThreadId: outcome?.threadId ?? cycle.codexThreadId,
          completedAt: now,
          eligibilityCode: null,
          updatedAt: now,
        })
        .where(eq(schema.taskDispatchCycles.id, cycle.id));
      return {
        state: "settled" as const,
        message,
        chat,
        ok: result !== null,
        terminal: observedTerminal,
      };
    }
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
        codexThreadId: outcome!.threadId,
        eligibilityCode: null,
        updatedAt: now,
      })
      .where(eq(schema.taskDispatchCycles.id, cycle.id));
    return {
      state: "queued" as const,
      message,
      chat,
      terminal: observedTerminal,
    };
  });
}

/** Lease expiry itself is not native settlement. Only the worker's previously
 * authenticated, exact no-forward terminal failure marker can fail this round. */
export async function failConfirmedExpiredRound(
  dependencies: Pick<Dependencies, "database" | "fail">,
  owner: string,
  chat: string,
  guard: Extract<TaskOperationDispatchFence, { kind: "expired" }>,
) {
  return dependencies.database.transaction(async (tx) => {
    await assertTaskOperationDispatchFence(
      tx,
      owner,
      chat,
      guard.operationId,
      guard,
    );
    const [cycle] = await tx
      .select()
      .from(schema.taskDispatchCycles)
      .where(eq(schema.taskDispatchCycles.id, guard.cycleId))
      .for("update")
      .limit(1);
    const [round] = await tx
      .select()
      .from(schema.taskPlanningRounds)
      .where(
        and(
          eq(schema.taskPlanningRounds.id, guard.operationId),
          eq(schema.taskPlanningRounds.chatId, chat),
        ),
      )
      .for("update")
      .limit(1);
    const input = round?.inferenceInput;
    if (
      !cycle ||
      cycle.goalInput ||
      !round ||
      round.relayResult ||
      !input ||
      input.deferred ||
      !input.failedBeforeDispatch ||
      input.firstDispatchedOperationId !== null ||
      input.receipt.dispatch.cycleId !== guard.cycleId ||
      input.receipt.dispatch.operationId !== guard.operationId ||
      input.receipt.dispatch.fencingToken + 1 !== guard.fencingToken
    )
      return false;
    await tx.execute(projectChatExecutionLock(owner, chat));
    const [placement] = await tx
      .select({ chat: schema.chats, task: schema.tasks })
      .from(schema.chats)
      .innerJoin(schema.tasks, eq(schema.tasks.chatId, schema.chats.id))
      .where(and(eq(schema.chats.id, chat), eq(schema.chats.ownerId, owner)))
      .for("update")
      .limit(1);
    if (
      !placement ||
      placement.chat.archivedAt ||
      placement.task.activeOperationId !== round.id ||
      placement.task.planningRound !== round.ordinal ||
      round.status !== "running" ||
      ["failed", "complete"].includes(placement.task.state)
    )
      return false;
    await dependencies.fail(tx, guard);
    return true;
  });
}
