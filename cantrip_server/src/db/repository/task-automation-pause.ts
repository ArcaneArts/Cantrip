import { and, desc, eq, sql } from "drizzle-orm";
import { taskPauseScopeSchema, type TaskPauseIntent } from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase, RepositoryTransaction } from "./database.js";
import { projectChatExecutionLock } from "./chat-execution-lock.js";
import { nativeCommandContext } from "./native-command-context.js";

/** Durable Task control order shares the canonical chat lock and revision.
 * It neither schedules work nor owns a provider semaphore. */
export class TaskAutomationPauseRepository {
  constructor(private readonly database: RepositoryDatabase) {}

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
      .select({ id: schema.taskDispatchCycles.id })
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
      }),
    };
  }

  async read(owner: string, chat: string) {
    return this.database.transaction(async (tx) => {
      await tx.execute(projectChatExecutionLock(owner, chat));
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
