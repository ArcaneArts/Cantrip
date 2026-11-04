import { and, eq } from "drizzle-orm";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import type { ChatExecutionLaneRepository } from "./chat-execution-lanes.js";
import { readNativeCommand } from "./native-command-context.js";
import { lockNativeCommandChat } from "./native-command-lock.js";
import { queueStateChanged } from "./native-command-queue.js";

/** Server-internal compensation for a command the limiter DID NOT delegate.
 * Never call this for worker errors, timeouts, missing output or lost sockets. */
export function deferUndispatchedGui(
  database: RepositoryDatabase,
  lanes: ChatExecutionLaneRepository,
  ownerId: string,
  workerId: string,
  operationId: string,
  generation: string,
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const captured = await readNativeCommand(
      tx,
      ownerId,
      workerId,
      operationId,
      generation,
    );
    await lockNativeCommandChat(tx, ownerId, captured.chatId);
    const row = await readNativeCommand(
      tx,
      ownerId,
      workerId,
      operationId,
      generation,
    );
    if (
      row.rejectionCode === "worker-transport-deferred" &&
      row.logicalCompletedAt
    )
      return true;
    if (
      row.origin !== "gui" ||
      row.kind !== "start" ||
      row.method !== "turn/start" ||
      row.status !== "accepted" ||
      row.logicalOperationId !== row.operationId ||
      row.previousOperationId ||
      row.logicalCompletedAt ||
      row.executionCompletedAt ||
      row.resultDigest ||
      row.terminalResultDigest ||
      row.terminalEvidence ||
      !row.executionLaneId ||
      !row.activationGeneration
    )
      return false;
    const [activation] = await tx
      .select()
      .from(schema.nativeCommandActivations)
      .where(eq(schema.nativeCommandActivations.chatId, row.chatId));
    const [claim] = await tx
      .select()
      .from(schema.managedQueueClaims)
      .where(
        and(
          eq(schema.managedQueueClaims.operationId, operationId),
          eq(schema.managedQueueClaims.operationGeneration, generation),
        ),
      );
    // These reject contradictory consumption; the positive proof is the actual
    // pre-delegate limiter rejection, never absence of a start notification.
    const [observed] = await tx
      .select({ id: schema.nativeCommandTurns.operationId })
      .from(schema.nativeCommandTurns)
      .where(eq(schema.nativeCommandTurns.operationId, operationId))
      .limit(1);
    if (
      !activation?.active ||
      activation.logicalCancelled ||
      activation.generation !== row.activationGeneration ||
      activation.operationId !== operationId ||
      activation.executionLaneId !== row.executionLaneId ||
      activation.nativeTurnId ||
      activation.runtimeGeneration ||
      !claim ||
      claim.status !== "accepted" ||
      claim.nativeTurnId ||
      observed
    )
      return false;
    const [prompt] = await tx
      .select()
      .from(schema.queuedPrompts)
      .where(eq(schema.queuedPrompts.id, claim.promptId));
    const removed = !prompt || ["removed", "consumed"].includes(prompt.state);
    if (
      !(await lanes
        .inTransaction(tx)
        .finishChatExecutionLane(row.chatId, row.executionLaneId, "idle", {
          markUnreadCompletion: false,
        }))
    )
      return false;
    const now = new Date();
    await tx
      .update(schema.nativeCommands)
      .set({
        status: "rejected",
        rejectionCode: "worker-transport-deferred",
        terminalEvidence: {
          kind: "not-dispatched",
          source: "worker-command-admission",
        },
        logicalCompletedAt: now,
        executionCompletedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.nativeCommands.operationId, operationId),
          eq(schema.nativeCommands.operationGeneration, generation),
        ),
      );
    await tx
      .update(schema.nativeCommandActivations)
      .set({ active: false })
      .where(
        and(
          eq(schema.nativeCommandActivations.chatId, row.chatId),
          eq(
            schema.nativeCommandActivations.generation,
            row.activationGeneration,
          ),
        ),
      );
    await tx
      .update(schema.managedQueueClaims)
      .set({ status: removed ? "rejected" : "deferred" })
      .where(eq(schema.managedQueueClaims.id, claim.id));
    if (!removed)
      await tx
        .update(schema.queuedPrompts)
        .set({ state: "pending", updatedAt: now })
        .where(eq(schema.queuedPrompts.id, claim.promptId));
    await queueStateChanged(tx, row.chatId);
    return true;
  });
}
