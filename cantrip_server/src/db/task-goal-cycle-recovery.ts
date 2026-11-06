import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  taskGoalCycleRecoverySchema,
  taskGoalCycleRecoveryBinding,
  type NativeInferenceRecovery,
  type NativeInferenceRecoveryResult,
  type TaskGoalCycleDispatch,
  type TaskGoalCycleRecovery,
  type TaskGoalCycleIdentity,
  type TaskGoalCycleRecoveryReceipt,
} from "@cantrip/protocol";
import * as schema from "./schema.js";
import type {
  RepositoryDatabase,
  RepositoryTransaction,
} from "./repository/database.js";
import { projectChatExecutionLock } from "./repository/chat-execution-lock.js";
import { nativeCommandContext } from "./repository/native-command-context.js";
import { TaskDispatchConflictError } from "./task-dispatch.js";

/** Private Goal cycles have no new user input and no managed command receipt.
 * Reconcile their Task binding without manufacturing either authority. */
export class TaskGoalCycleRecoveryRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  private async write(
    tx: RepositoryTransaction,
    cycleId: string,
    chatId: string,
    marker: TaskGoalCycleRecovery,
    notify = true,
  ) {
    await tx
      .update(schema.taskDispatchCycles)
      .set({ goalCycleRecovery: marker })
      .where(eq(schema.taskDispatchCycles.id, cycleId));
    if (!notify) return;
    // Reuse the existing durable revision notice, without a second prompt queue
    // or scheduler. It also wakes journals on the Source's former worker.
    await tx
      .insert(schema.managedQueueStates)
      .values({ chatId, revision: 1 })
      .onConflictDoUpdate({
        target: schema.managedQueueStates.chatId,
        set: {
          revision: sql`${schema.managedQueueStates.revision}+1`,
          notificationDueAt: sql`now()`,
        },
      });
  }

  private async locked(
    tx: RepositoryTransaction,
    owner: string,
    chatId: string,
  ) {
    const [user] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, owner))
      .for("update")
      .limit(1);
    if (!user) return null;
    await tx.execute(projectChatExecutionLock(owner, chatId));
    const [task] = await tx
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.chatId, chatId))
      .for("update")
      .limit(1);
    const [cycle] = await tx
      .select()
      .from(schema.taskDispatchCycles)
      .where(
        and(
          eq(schema.taskDispatchCycles.ownerId, owner),
          eq(schema.taskDispatchCycles.chatId, chatId),
        ),
      )
      .orderBy(
        desc(schema.taskDispatchCycles.createdAt),
        desc(schema.taskDispatchCycles.id),
      )
      .for("update")
      .limit(1);
    const context = await nativeCommandContext(tx, owner, chatId);
    const [chat] = await tx
      .select()
      .from(schema.chats)
      .where(and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, owner)))
      .for("update")
      .limit(1);
    const [project] = context?.projectId
      ? await tx
          .select()
          .from(schema.projects)
          .where(
            and(
              eq(schema.projects.id, context.projectId),
              eq(schema.projects.ownerId, owner),
            ),
          )
          .limit(1)
      : [];
    if (!task || !cycle || !chat || !context || !project) return null;
    const [route] = cycle.modelRouteId
      ? await tx
          .select()
          .from(schema.modelRoutes)
          .where(eq(schema.modelRoutes.id, cycle.modelRouteId))
          .limit(1)
      : [];
    const [handoff] = await tx
      .select({ operationId: schema.nativeRuntimeHandoffs.operationId })
      .from(schema.nativeRuntimeHandoffs)
      .where(
        and(
          eq(schema.nativeRuntimeHandoffs.ownerId, owner),
          eq(schema.nativeRuntimeHandoffs.chatId, chatId),
          inArray(schema.nativeRuntimeHandoffs.phase, [
            "preparing",
            "prepared",
            "committed",
          ]),
        ),
      )
      .limit(1);
    return { task, cycle, chat, context, project, route, handoff };
  }

  private sameBinding(
    row: NonNullable<
      Awaited<ReturnType<TaskGoalCycleRecoveryRepository["locked"]>>
    >,
    workerId: string,
    providerId: string,
    threadId: string,
    cycle: Pick<
      TaskGoalCycleIdentity,
      "cycleId" | "modelRouteId" | "providerAccountId" | "orderEpoch"
    >,
  ) {
    return (
      row.context.experience === "task" &&
      row.context.contextKind === "project" &&
      row.cycle.id === cycle.cycleId &&
      row.cycle.operationKind === "finalize" &&
      row.cycle.startedAt !== null &&
      row.task.planGoalEnabled &&
      row.task.implementationStartedAt !== null &&
      row.task.hasFinalPlan &&
      row.task.hasGoalPrompt &&
      row.task.activeOperationId === null &&
      row.cycle.physicalWorkerId === workerId &&
      row.cycle.codexThreadId === threadId &&
      row.cycle.modelRouteId === cycle.modelRouteId &&
      row.cycle.providerAccountId === cycle.providerAccountId &&
      row.cycle.goalOrderEpoch === cycle.orderEpoch &&
      row.route?.providerId === providerId &&
      row.context.workerId === workerId &&
      row.context.threadId === threadId &&
      row.context.worktreeId === row.cycle.worktreeId &&
      row.context.modelRouteId === cycle.modelRouteId &&
      row.context.providerAccountId === cycle.providerAccountId &&
      row.chat.archivedAt === null
    );
  }

  private eligible(
    row: NonNullable<
      Awaited<ReturnType<TaskGoalCycleRecoveryRepository["locked"]>>
    >,
  ) {
    const input = row.cycle.goalInput;
    return (
      // The exact unused Source remains recoverable, but may not produce a new
      // native cycle while its canonical provider transfer owns the root.
      !row.handoff &&
      row.task.state !== "complete" &&
      row.task.state !== "failed" &&
      row.task.state !== "paused" &&
      !row.chat.automationPaused &&
      !row.chat.managedAutonomyStopped &&
      !row.project.taskSchedulingPaused &&
      row.cycle.state !== "paused" &&
      row.cycle.state !== "cancelled" &&
      // An explicit Goal input retains its own dispatch/result authority.
      !(
        input &&
        !input.deferred &&
        !input.failedBeforeDispatch &&
        input.firstDispatchedOperationId === null
      )
    );
  }

  async pending(
    owner: string,
    chatId: string,
  ): Promise<TaskGoalCycleRecovery | null> {
    return this.database.transaction(async (tx) => {
      const row = await this.locked(tx, owner, chatId);
      const marker = row?.cycle.goalCycleRecovery;
      if (
        !row ||
        !marker ||
        marker.settled ||
        !this.eligible(row) ||
        !this.sameBinding(
          row,
          row.context.workerId,
          marker.providerId,
          marker.threadId,
          taskGoalCycleRecoveryBinding(marker),
        )
      )
        return null;
      return taskGoalCycleRecoverySchema.parse(marker);
    });
  }

  async reconcile(
    owner: string,
    input: NativeInferenceRecovery,
  ): Promise<NativeInferenceRecoveryResult> {
    const { record } = input;
    const identity = record.identity.recovery;
    const cycle = identity?.taskGoalCycle;
    const chatId = record.identity.chatId;
    const result: NativeInferenceRecoveryResult = {
      key: record.key,
      chatId,
      disposition: "unresolved",
    };
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          record.workerGeneration,
          record.identity.runtimeGeneration,
          record.identity.operationId,
        ]),
      )
      .digest("hex");
    if (
      !cycle ||
      !identity.threadId ||
      !identity.turnId ||
      !chatId ||
      identity.messageId ||
      identity.commandId ||
      identity.commandGeneration ||
      identity.taskInput ||
      identity.autonomousGoal ||
      key !== record.key ||
      record.identity.operationId !==
        `native-inference:${identity.threadId}:${identity.turnId}:${cycle.scopeId}:${cycle.gateAttemptId}` ||
      (record.nativeExecution &&
        !(record.state === "released" && record.outcome === "never-started")) ||
      (record.workerGeneration === input.workerGeneration &&
        !(
          record.state === "released" &&
          ["never-started", "runtime-exited"].includes(record.outcome ?? "")
        ))
    )
      return result;
    return this.database.transaction(async (tx) => {
      const row = await this.locked(tx, owner, chatId);
      const retained = row?.cycle.goalCycleRecovery;
      const sameEpisode =
        retained &&
        retained.providerId === record.identity.providerId &&
        retained.threadId === identity.threadId &&
        retained.cycle.cycleId === cycle.cycleId &&
        retained.cycle.goalEpoch === cycle.goalEpoch &&
        retained.cycle.orderEpoch === cycle.orderEpoch;
      const currentBinding = sameEpisode
        ? taskGoalCycleRecoveryBinding(retained)
        : cycle;
      if (
        !row ||
        !this.sameBinding(
          row,
          input.workerId,
          record.identity.providerId,
          identity.threadId!,
          currentBinding,
        ) ||
        (record.identity.projectId &&
          record.identity.projectId !== row.context.projectId) ||
        row.task.state === "complete" ||
        row.chat.archivedAt
      )
        return { ...result, disposition: "retired" };
      if (!this.eligible(row)) return result;
      let marker = row.cycle.goalCycleRecovery;
      if (
        marker?.admission &&
        marker.admission.operationId === record.identity.operationId &&
        marker.admission.runtimeGeneration ===
          record.identity.runtimeGeneration &&
        marker.admission.workerGeneration === record.workerGeneration
      ) {
        // This exact physical producer is now actually fenced or positively
        // settled unused. An enqueue acknowledgement cannot suppress its wake.
        marker = { ...marker, admission: null };
        await this.write(tx, row.cycle.id, chatId, marker);
      }
      if (marker?.settled) {
        const sameEpisode =
          marker.cycle.goalEpoch === cycle.goalEpoch &&
          marker.cycle.orderEpoch === cycle.orderEpoch;
        const sameAttempt =
          marker.sourceKey === record.key ||
          marker.turnId === identity.turnId ||
          marker.settled.turnId === identity.turnId;
        // A failed dispatch acknowledgement may have been followed by a real
        // negative Core resolve. Its positive no-start receipt can retain FIFO.
        const rejectedReplacement =
          record.state === "released" &&
          record.outcome === "never-started" &&
          marker.settled.operationId === record.identity.operationId;
        if (sameEpisode && sameAttempt && !rejectedReplacement)
          return { ...result, disposition: "retired" };
        marker = null;
      }
      if (
        marker &&
        (marker.cycle.cycleId !== cycle.cycleId ||
          marker.threadId !== identity.threadId ||
          marker.cycle.goalEpoch !== cycle.goalEpoch ||
          marker.cycle.orderEpoch !== cycle.orderEpoch ||
          marker.providerId !== record.identity.providerId)
      )
        return result;
      if (!marker) {
        marker = taskGoalCycleRecoverySchema.parse({
          sourceKey: record.key,
          operationId: record.identity.operationId,
          runtimeGeneration: record.identity.runtimeGeneration,
          workerGeneration: record.workerGeneration,
          workerId: input.workerId,
          providerId: record.identity.providerId,
          threadId: identity.threadId,
          turnId: identity.turnId,
          cycle,
        });
        await this.write(tx, row.cycle.id, chatId, marker);
      }
      return {
        ...result,
        disposition: "requeued",
        taskGoalCycleNotDispatched: true,
        taskGoalRecovery: marker,
      };
    });
  }

  async dispatch(owner: string, input: TaskGoalCycleDispatch) {
    return this.database.transaction(async (tx) => {
      const row = await this.locked(tx, owner, input.chatId);
      if (
        !row ||
        !this.sameBinding(
          row,
          input.workerId,
          input.providerId,
          input.threadId,
          input.cycle,
        ) ||
        !this.eligible(row) ||
        input.operationId !==
          `native-inference:${input.threadId}:${input.turnId}:${input.cycle.scopeId}:${input.cycle.gateAttemptId}`
      )
        throw new TaskDispatchConflictError(
          "The native Task Goal binding changed.",
          "stale-lease",
        );
      const marker = row.cycle.goalCycleRecovery;
      if (
        !marker ||
        marker.sourceKey !== input.sourceKey ||
        marker.cycle.goalEpoch !== input.cycle.goalEpoch ||
        marker.providerId !== input.providerId ||
        taskGoalCycleRecoveryBinding(marker).orderEpoch !==
          input.cycle.orderEpoch ||
        (marker.settled && marker.settled.reason !== "dispatched") ||
        (marker.settled &&
          (marker.settled.operationId !== input.operationId ||
            marker.settled.turnId !== input.turnId))
      )
        throw new TaskDispatchConflictError(
          "The Task Goal recovery episode changed.",
          "stale-lease",
        );
      if (!marker.settled)
        await this.write(tx, row.cycle.id, input.chatId, {
          ...marker,
          settled: {
            reason: "dispatched",
            operationId: input.operationId,
            turnId: input.turnId,
          },
        });
      return { accepted: true as const };
    });
  }

  async confirmRecovery(
    owner: string,
    chatId: string,
    source: TaskGoalCycleRecovery,
    receipt: TaskGoalCycleRecoveryReceipt,
  ): Promise<TaskGoalCycleRecovery | null> {
    return this.database.transaction(async (tx) => {
      const row = await this.locked(tx, owner, chatId);
      const marker = row?.cycle.goalCycleRecovery;
      if (
        !row ||
        !marker ||
        marker.settled ||
        marker.sourceKey !== source.sourceKey ||
        receipt.sourceKey !== marker.sourceKey ||
        !this.sameBinding(
          row,
          row.context.workerId,
          marker.providerId,
          marker.threadId,
          taskGoalCycleRecoveryBinding(marker),
        ) ||
        !this.eligible(row)
      )
        return null;
      if (receipt.status === "scheduled") {
        const admission = {
          ...receipt.admission,
          workerGeneration: receipt.workerGeneration,
        };
        if (
          marker.admission?.operationId !== admission.operationId ||
          marker.admission.runtimeGeneration !== admission.runtimeGeneration ||
          marker.admission.workerGeneration !== admission.workerGeneration
        )
          await this.write(tx, row.cycle.id, chatId, { ...marker, admission });
        return null;
      }
      if (
        receipt.threadId !== marker.threadId ||
        receipt.modelRouteId !==
          taskGoalCycleRecoveryBinding(marker).modelRouteId ||
        receipt.providerAccountId !==
          taskGoalCycleRecoveryBinding(marker).providerAccountId ||
        (receipt.observedGoalEpoch === marker.cycle.goalEpoch &&
          receipt.observedGoalStatus === "active")
      )
        return null;
      const retired: TaskGoalCycleRecovery = {
        ...marker,
        settled: {
          reason: "ineligible",
          operationId: null,
          turnId: marker.turnId,
        },
      };
      await this.write(tx, row.cycle.id, chatId, retired);
      return retired;
    });
  }
}
