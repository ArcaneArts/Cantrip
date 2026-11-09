import type { AgentThreadSync } from "@cantrip/protocol";
import { and, eq } from "drizzle-orm";
import * as schema from "../schema.js";
import type {
  ChatExecutionContext,
  ChatExecutionLaneRepository,
} from "./chat-execution-lanes.js";
import type { RepositoryDatabase } from "./database.js";
import { nativeCommandContext } from "./native-command-context.js";
import { lockNativeCommandChat } from "./native-command-lock.js";

/** History observations cannot finish, replace, or relabel an admitted native turn.
 * Keep legacy console reconciliation serialized with the actual admission write. */
export async function reconcileNativeThreadObservation(
  database: RepositoryDatabase,
  lanes: ChatExecutionLaneRepository,
  ownerId: string,
  expected: ChatExecutionContext,
  status: AgentThreadSync["status"],
): Promise<{ applied: boolean; execution: ChatExecutionContext }> {
  return database.transaction(async (tx) => {
    await lockNativeCommandChat(tx, ownerId, expected.chatId);
    const current = await nativeCommandContext(tx, ownerId, expected.chatId);
    const unchanged = { applied: false, execution: expected };
    if (
      !current ||
      current.contextKind !== "project" ||
      current.contextKind !== expected.contextKind ||
      current.workerId !== expected.workerId ||
      current.worktreeId !== expected.worktreeId ||
      current.threadId !== expected.threadId ||
      current.modelRouteId !== expected.modelRouteId ||
      current.providerAccountId !== expected.providerAccountId ||
      current.executionLaneId !== expected.executionLaneId
    )
      return unchanged;
    const [activation] = await tx
      .select()
      .from(schema.nativeCommandActivations)
      .where(eq(schema.nativeCommandActivations.chatId, current.chatId));
    // An idle thread is expected before turn/start, and an old terminal turn
    // remains readable after a successor is admitted. Neither retires its owner.
    if (activation?.active) return unchanged;
    const transactionalLanes = lanes.inTransaction(tx);
    if (status === "running" && !current.executionLaneId) {
      const acquired = await transactionalLanes.startChatExecutionLane(
        ownerId,
        current.chatId,
        "agent",
        "Linked Codex console turn",
      );
      return acquired ? { applied: true, execution: acquired } : unchanged;
    }
    if (current.executionLaneId && status !== "running") {
      const applied = await transactionalLanes.finishChatExecutionLane(
        current.chatId,
        current.executionLaneId,
        status,
      );
      return { applied, execution: current };
    }
    await tx
      .update(schema.chats)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(schema.chats.id, current.chatId),
          eq(schema.chats.ownerId, ownerId),
        ),
      );
    return { applied: true, execution: current };
  });
}
