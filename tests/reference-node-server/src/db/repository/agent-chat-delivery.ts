import { and, eq, inArray } from "drizzle-orm";
import type { ServerRepository } from "../repository.js";
import type { RepositoryDatabase } from "./database.js";
import * as schema from "../schema.js";
import { projectChatExecutionLock } from "./chat-execution-lock.js";

/** Commit queue admission and both protected transcript copies as one delivery. */
export class AgentChatDeliveryRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly repositoryForTransaction: (
      tx: RepositoryDatabase,
    ) => ServerRepository,
  ) {}

  transaction<T>(
    ownerId: string,
    sourceId: string,
    targetId: string,
    apply: (repository: ServerRepository) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (tx) => {
      await tx.execute(projectChatExecutionLock(ownerId, sourceId));
      // Stable lock order also covers simultaneous A→B and B→A deliveries.
      await tx
        .select({ id: schema.chats.id })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.ownerId, ownerId),
            inArray(schema.chats.id, [sourceId, targetId]),
          ),
        )
        .orderBy(schema.chats.id)
        .for("update");
      return apply(this.repositoryForTransaction(tx));
    });
  }
}
