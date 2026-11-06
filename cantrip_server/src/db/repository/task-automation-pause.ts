import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { taskPauseScopeSchema, type TaskPauseIntent } from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase, RepositoryTransaction } from "./database.js";
import { projectChatExecutionLock } from "./chat-execution-lock.js";
import { nativeCommandContext } from "./native-command-context.js";
import { nativeTaskSuspensionContext } from "./native-task-suspension-context.js";
import { NativeSuspensionRepository } from "./native-suspensions.js";
import type { TaskInferenceInputRepository } from "../task-inference-inputs.js";

/** Durable Task control order shares the canonical chat lock and revision.
 * It neither schedules work nor owns a provider semaphore. */
export class TaskAutomationPauseRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly inputs: TaskInferenceInputRepository,
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
    const task = await nativeTaskSuspensionContext(tx, context);
    const source = task?.context ?? context;
    const suspension = await new NativeSuspensionRepository(
      this.database,
      tx,
    ).read(owner, chat);
    return {
      paused:
        suspension?.target.taskRound && suspension.phase === "resuming"
          ? false
          : context.automationPaused,
      scope: taskPauseScopeSchema.parse({
        revision: context.managedInputRevision,
        workerId: context.workerId,
        projectId: context.projectId,
        worktreeId: context.worktreeId,
        threadId: source.threadId,
        modelRouteId: source.modelRouteId,
        providerAccountId: source.providerAccountId,
        ...(task ? { taskRound: task.taskRound } : {}),
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
   * Resumed Task input cannot adopt its pre-Stop cycle's old FIFO ordinal. */
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
      if (cycle) {
        await this.inputs.deferForInterrupt(tx, owner, cycle);
        // Seal unused canonical input before the worker cancels its SDK wait.
        // A dispatch that already won this same owner/cycle lock stays physical
        // work and must settle through the native Stop path instead.
        if (cycle.operationKind === "finalize")
          await this.inputs.goals.deferForInterrupt(tx, owner, cycle);
        // Stop revokes launch authority even before an input receipt exists.
        // This is the existing paused dispatch state, not physical settlement.
        // Keep runtime affinity and timing for actual native cleanup/Resume.
        const stoppedAt = new Date();
        await tx
          .update(schema.taskDispatchCycles)
          .set({
            state: "paused",
            fencingToken: sql`${schema.taskDispatchCycles.fencingToken}+1`,
            pausedAt: stoppedAt,
            updatedAt: stoppedAt,
          })
          .where(
            and(
              eq(schema.taskDispatchCycles.id, cycle.id),
              inArray(schema.taskDispatchCycles.state, ["claimed", "running"]),
            ),
          );
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
      const [current] = await tx
        .select({ revision: schema.chats.managedInputRevision })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.ownerId, owner),
            eq(schema.chats.id, chat),
            eq(schema.chats.experience, "task"),
          ),
        );
      if (
        !current ||
        (expectedRevision !== undefined &&
          current.revision !== expectedRevision)
      )
        return null;
      const suspensions = new NativeSuspensionRepository(this.database, tx);
      const saved = await suspensions.read(owner, chat);
      const held = Boolean(
        saved?.target.taskRound &&
        saved.checkpoint &&
        ["paused", "pausing", "resuming", "error"].includes(saved.phase),
      );
      if (
        held &&
        saved?.action !== "stop" &&
        !(paused && saved?.phase === "error" && saved.action === "resume")
      )
        await suspensions.request(owner, chat, paused ? "pause" : "resume");
      const [updated] = await tx
        .update(schema.chats)
        .set({
          // Ordered Resume intent is distinct from releasing the durable hold.
          automationPaused: held ? true : paused,
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
