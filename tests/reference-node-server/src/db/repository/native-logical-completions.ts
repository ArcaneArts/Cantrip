import { and, eq, sql, asc, lte } from "drizzle-orm";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
/** Delivery state only; creation remains atomic with finishLogicalGui. */
export class NativeLogicalCompletionRepository {
  constructor(private readonly database: RepositoryDatabase) {}
  async listPendingLogicalCompletions(limit = 100) {
    const rows = await this.database
      .select()
      .from(schema.nativeLogicalCompletions)
      .where(lte(schema.nativeLogicalCompletions.nextAttemptAt, new Date()))
      .orderBy(
        asc(schema.nativeLogicalCompletions.nextAttemptAt),
        asc(schema.nativeLogicalCompletions.rootOperationId),
      )
      .limit(limit);
    return rows.map(({ nextAttemptAt: _due, createdAt, ...row }) => ({
      ...row,
      createdAt: createdAt.toISOString(),
    }));
  }
  async getLogicalCompletion(
    ownerId: string,
    workerId: string,
    chatId: string,
    rootOperationId: string,
    rootOperationGeneration: string,
  ) {
    const [row] = await this.database
      .select()
      .from(schema.nativeLogicalCompletions)
      .where(
        and(
          eq(schema.nativeLogicalCompletions.ownerId, ownerId),
          eq(schema.nativeLogicalCompletions.workerId, workerId),
          eq(schema.nativeLogicalCompletions.chatId, chatId),
          eq(schema.nativeLogicalCompletions.rootOperationId, rootOperationId),
          eq(
            schema.nativeLogicalCompletions.rootOperationGeneration,
            rootOperationGeneration,
          ),
        ),
      );
    if (!row) return null;
    const { nextAttemptAt: _due, createdAt, ...result } = row;
    return { ...result, createdAt: createdAt.toISOString() };
  }
  async acknowledgeLogicalCompletion(
    ownerId: string,
    workerId: string,
    chatId: string,
    rootOperationId: string,
    rootOperationGeneration: string,
  ): Promise<boolean> {
    const removed = await this.database
      .delete(schema.nativeLogicalCompletions)
      .where(
        and(
          eq(schema.nativeLogicalCompletions.ownerId, ownerId),
          eq(schema.nativeLogicalCompletions.workerId, workerId),
          eq(schema.nativeLogicalCompletions.chatId, chatId),
          eq(schema.nativeLogicalCompletions.rootOperationId, rootOperationId),
          eq(
            schema.nativeLogicalCompletions.rootOperationGeneration,
            rootOperationGeneration,
          ),
        ),
      )
      .returning();
    return removed.length === 1;
  }
  async deferLogicalCompletion(
    ownerId: string,
    workerId: string,
    chatId: string,
    rootOperationId: string,
    rootOperationGeneration: string,
    nextAttemptAt: Date,
  ): Promise<boolean> {
    const changed = await this.database
      .update(schema.nativeLogicalCompletions)
      .set({
        nextAttemptAt,
        attempts: sql`${schema.nativeLogicalCompletions.attempts}+1`,
      })
      .where(
        and(
          eq(schema.nativeLogicalCompletions.ownerId, ownerId),
          eq(schema.nativeLogicalCompletions.workerId, workerId),
          eq(schema.nativeLogicalCompletions.chatId, chatId),
          eq(schema.nativeLogicalCompletions.rootOperationId, rootOperationId),
          eq(
            schema.nativeLogicalCompletions.rootOperationGeneration,
            rootOperationGeneration,
          ),
        ),
      )
      .returning();
    return changed.length === 1;
  }
}
