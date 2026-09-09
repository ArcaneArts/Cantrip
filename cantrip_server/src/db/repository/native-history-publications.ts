import { and, asc, eq, exists, lte, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";

export interface NativeHistoryPublication {
  commitId: string;
  bindingId: string;
  ownerId: string;
  workerId: string;
  chatId: string;
  attempts: number;
}

/** Content has already committed. Publication retries neither import nor execute it again. */
export class NativeHistoryPublicationRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  listPending(limit = 64): Promise<NativeHistoryPublication[]> {
    return this.database
      .select({
        commitId: schema.nativeHistoryPublications.commitId,
        bindingId: schema.nativeHistoryPublications.bindingId,
        ownerId: schema.nativeHistoryBindings.ownerId,
        workerId: schema.nativeHistoryBindings.workerId,
        chatId: schema.nativeHistoryBindings.chatId,
        attempts: schema.nativeHistoryPublications.attempts,
      })
      .from(schema.nativeHistoryPublications)
      .innerJoin(
        schema.nativeHistoryBindings,
        eq(
          schema.nativeHistoryBindings.id,
          schema.nativeHistoryPublications.bindingId,
        ),
      )
      .innerJoin(
        schema.chats,
        and(
          eq(schema.chats.id, schema.nativeHistoryBindings.chatId),
          eq(schema.chats.ownerId, schema.nativeHistoryBindings.ownerId),
        ),
      )
      .where(lte(schema.nativeHistoryPublications.nextAttemptAt, new Date()))
      .orderBy(
        asc(schema.nativeHistoryPublications.nextAttemptAt),
        asc(schema.nativeHistoryPublications.commitId),
      )
      .limit(limit);
  }

  private owned(entry: NativeHistoryPublication) {
    return and(
      eq(schema.nativeHistoryPublications.commitId, entry.commitId),
      eq(schema.nativeHistoryPublications.bindingId, entry.bindingId),
      exists(
        this.database
          .select({ id: schema.nativeHistoryBindings.id })
          .from(schema.nativeHistoryBindings)
          .innerJoin(
            schema.chats,
            and(
              eq(schema.chats.id, schema.nativeHistoryBindings.chatId),
              eq(schema.chats.ownerId, schema.nativeHistoryBindings.ownerId),
            ),
          )
          .where(
            and(
              eq(schema.nativeHistoryBindings.id, entry.bindingId),
              eq(schema.nativeHistoryBindings.ownerId, entry.ownerId),
              eq(schema.nativeHistoryBindings.workerId, entry.workerId),
              eq(schema.nativeHistoryBindings.chatId, entry.chatId),
            ),
          ),
      ),
    );
  }

  async acknowledge(entry: NativeHistoryPublication): Promise<boolean> {
    const deleted = await this.database
      .delete(schema.nativeHistoryPublications)
      .where(this.owned(entry))
      .returning();
    return deleted.length === 1;
  }

  async defer(
    entry: NativeHistoryPublication,
    nextAttemptAt: Date,
  ): Promise<boolean> {
    const updated = await this.database
      .update(schema.nativeHistoryPublications)
      .set({
        nextAttemptAt,
        attempts: sql`${schema.nativeHistoryPublications.attempts} + 1`,
      })
      .where(this.owned(entry))
      .returning();
    return updated.length === 1;
  }
}
