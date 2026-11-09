import { and, eq, inArray, isNull } from "drizzle-orm";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import { readNativeCommand } from "./native-command-context.js";
import { lockNativeCommandChat } from "./native-command-lock.js";

/** A lost command channel cannot complete an unfinished, still-authorized GUI
 * input. Read under the same project/chat locks as cancellation and settlement. */
export function pendingLogicalGuiAfterTransportLoss(
  database: RepositoryDatabase,
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
    const root = await readNativeCommand(
      tx,
      ownerId,
      workerId,
      operationId,
      generation,
    );
    if (
      root.origin !== "gui" ||
      root.kind !== "start" ||
      root.logicalOperationId !== root.operationId ||
      root.logicalCompletedAt ||
      !root.executionLaneId
    )
      return false;
    const [pending] = await tx
      .select({ operationId: schema.nativeCommands.operationId })
      .from(schema.nativeCommandActivations)
      .innerJoin(
        schema.nativeCommands,
        and(
          eq(
            schema.nativeCommands.operationId,
            schema.nativeCommandActivations.operationId,
          ),
          eq(
            schema.nativeCommands.activationGeneration,
            schema.nativeCommandActivations.generation,
          ),
          eq(
            schema.nativeCommands.executionLaneId,
            schema.nativeCommandActivations.executionLaneId,
          ),
        ),
      )
      .innerJoin(
        schema.chatExecutionLanes,
        eq(schema.chatExecutionLanes.id, schema.nativeCommands.executionLaneId),
      )
      .where(
        and(
          eq(schema.nativeCommandActivations.chatId, root.chatId),
          eq(schema.nativeCommandActivations.workerId, workerId),
          eq(schema.nativeCommandActivations.active, true),
          eq(schema.nativeCommandActivations.logicalCancelled, false),
          eq(schema.nativeCommands.ownerId, ownerId),
          eq(schema.nativeCommands.workerId, workerId),
          eq(schema.nativeCommands.chatId, root.chatId),
          eq(schema.nativeCommands.origin, "gui"),
          eq(schema.nativeCommands.kind, "start"),
          eq(schema.nativeCommands.logicalOperationId, root.operationId),
          eq(schema.nativeCommands.executionLaneId, root.executionLaneId),
          inArray(schema.nativeCommands.status, [
            "dispatched",
            "applied",
            "uncertain",
          ]),
          isNull(schema.nativeCommands.executionCompletedAt),
          eq(schema.chatExecutionLanes.chatId, root.chatId),
          eq(schema.chatExecutionLanes.workerId, workerId),
          eq(schema.chatExecutionLanes.state, "active"),
        ),
      );
    return !!pending;
  });
}
