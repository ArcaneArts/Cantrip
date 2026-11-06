import { and, desc, eq, sql } from "drizzle-orm";
import { taskPauseScopeSchema, type TaskPauseIntent } from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase, RepositoryTransaction } from "./database.js";
import { projectChatExecutionLock } from "./chat-execution-lock.js";
import { nativeCommandContext } from "./native-command-context.js";
import type { TaskGoalInferenceInputRepository } from "../task-goal-inference-inputs.js";

/** Durable Task control order shares the canonical chat lock and revision.
 * It neither schedules work nor owns a provider semaphore. */
export class TaskAutomationPauseRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly goalInputs: TaskGoalInferenceInputRepository,
  ) {}

  private async scope(
    tx: RepositoryTransaction,
    owner: string,
    chat: string,
  ): Promise<TaskPauseIntent | null> {
    const context = await nativeCommandContext(tx, owner, chat);
    if (
      !context ||
      context.experience !== "task" ||
      context.contextKind !== "project" ||
      context.managedInputRevision! <= 0
    )
      return null;
    const [cycle] = await tx
      .select({
        id: schema.taskDispatchCycles.id,
        orderEpoch: schema.taskDispatchCycles.goalOrderEpoch,
      })
      .from(schema.taskDispatchCycles)
      .where(
        and(
          eq(schema.taskDispatchCycles.ownerId, owner),
          eq(schema.taskDispatchCycles.chatId, chat),
        ),
      )
      .orderBy(
        desc(schema.taskDispatchCycles.createdAt),
        desc(schema.taskDispatchCycles.id),
      )
      .limit(1);
    return {
      paused: context.automationPaused,
      scope: taskPauseScopeSchema.parse({
        revision: context.managedInputRevision,
        workerId: context.workerId,
        projectId: context.projectId,
        worktreeId: context.worktreeId,
        threadId: context.threadId,
        modelRouteId: context.modelRouteId,
        providerAccountId: context.providerAccountId,
        cycleId: cycle?.id ?? null,
        orderEpoch: cycle?.orderEpoch ?? 0,
      }),
    };
  }

  async read(owner: string, chat: string) {
    return this.database.transaction(async (tx) => {
      await tx.execute(projectChatExecutionLock(owner, chat));
      return this.scope(tx, owner, chat);
    });
  }

  /** Called after the actual transfer settles and only for the original Stop.
   * A resumed Goal cannot adopt an unused pre-Stop cycle's old FIFO ordinal. */
  async fenceInterrupt(owner: string, chat: string, revision: number) {
    return this.database.transaction(async (tx) => {
      await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, owner))
        .for("update")
        .limit(1);
      await tx.execute(projectChatExecutionLock(owner, chat));
      const current = await this.scope(tx, owner, chat);
      if (!current?.paused || current.scope.revision !== revision) return null;
      const [cycle] = await tx
        .select()
        .from(schema.taskDispatchCycles)
        .where(
          and(
            eq(schema.taskDispatchCycles.ownerId, owner),
            eq(schema.taskDispatchCycles.chatId, chat),
          ),
        )
        .orderBy(
          desc(schema.taskDispatchCycles.createdAt),
          desc(schema.taskDispatchCycles.id),
        )
        .for("update")
        .limit(1);
      if (cycle?.operationKind === "finalize") {
        // Seal unused canonical input before the worker cancels its SDK wait.
        // A dispatch that already won this same owner/cycle lock stays physical
        // work and must settle through the native Stop path instead.
        await this.goalInputs.deferForInterrupt(tx, owner, cycle);
        const marker = cycle.goalCycleRecovery;
        await tx
          .update(schema.taskDispatchCycles)
          .set({
            goalOrderEpoch: sql`${schema.taskDispatchCycles.goalOrderEpoch}+1`,
            ...(marker && !marker.settled
              ? {
                  goalCycleRecovery: {
                    ...marker,
                    admission: null,
                    settled: {
                      reason: "ineligible" as const,
                      turnId: marker.turnId,
                      operationId: null,
                    },
                  },
                }
              : {}),
          })
          .where(eq(schema.taskDispatchCycles.id, cycle.id));
      }
      return this.scope(tx, owner, chat);
    });
  }

  async request(
    owner: string,
    chat: string,
    paused: boolean,
    expectedRevision?: number,
  ) {
    return this.database.transaction(async (tx) => {
      await tx.execute(projectChatExecutionLock(owner, chat));
      const [updated] = await tx
        .update(schema.chats)
        .set({
          automationPaused: paused,
          managedInputRevision: sql`${schema.chats.managedInputRevision}+1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.chats.ownerId, owner),
            eq(schema.chats.id, chat),
            eq(schema.chats.experience, "task"),
            ...(expectedRevision === undefined
              ? []
              : [eq(schema.chats.managedInputRevision, expectedRevision)]),
          ),
        )
        .returning({ id: schema.chats.id });
      if (!updated) return null;
      await tx
        .insert(schema.managedQueueStates)
        .values({ chatId: chat, revision: 1 })
        .onConflictDoUpdate({
          target: schema.managedQueueStates.chatId,
          set: {
            revision: sql`${schema.managedQueueStates.revision}+1`,
            notificationDueAt: sql`now()`,
          },
        });
      return this.scope(tx, owner, chat);
    });
  }
}
