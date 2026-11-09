import { and, eq } from "drizzle-orm";
import * as schema from "../schema.js";
import type { RepositoryDatabase, RepositoryTransaction } from "./database.js";
import type { ChatExecutionLaneRepository } from "./chat-execution-lanes.js";
import { NativeCommandError } from "./native-command-errors.js";
import { NativeLogicalInputRepository } from "./native-logical-inputs.js";
import { NativeSuspensionRepository } from "./native-suspensions.js";
import {
  hasNativeSuspensionTerminalProof,
  ownsNativeSuspensionExecution,
} from "./native-suspended-execution.js";

/** The old GUI caller cannot retire a replacement worker's execution. Its
 * actual native terminal receipt and protected publication retire both owners
 * atomically; transport closure alone never reaches this path. */
export async function finishRestoredLogicalInput(
  tx: RepositoryTransaction,
  database: RepositoryDatabase,
  lanes: ChatExecutionLaneRepository,
  ownerId: string,
  row: typeof schema.nativeCommands.$inferSelect,
) {
  const logical = row.logicalOperationId;
  if (
    row.kind !== "start" ||
    row.method !== "thread/resume" ||
    !logical ||
    logical === row.operationId ||
    !row.executionCompletedAt ||
    !row.protectedTerminalResult ||
    !row.terminalResultDigest ||
    !row.intent ||
    typeof row.intent !== "object" ||
    !("restoredSuspension" in row.intent) ||
    !row.intent.restoredSuspension
  )
    return;
  const state = await new NativeSuspensionRepository(database)
    .inTransaction(tx)
    .read(ownerId, row.chatId);
  if (
    !state ||
    !ownsNativeSuspensionExecution(state, row) ||
    !hasNativeSuspensionTerminalProof(state, row)
  )
    return;
  const [root] = await tx
    .select()
    .from(schema.nativeCommands)
    .where(
      and(
        eq(schema.nativeCommands.operationId, logical),
        eq(schema.nativeCommands.ownerId, ownerId),
        eq(schema.nativeCommands.workerId, row.workerId),
        eq(schema.nativeCommands.chatId, row.chatId),
      ),
    );
  if (!root) throw new NativeCommandError("invalid-continuation-lineage");
  const proof = row.terminalEvidence as { terminalStatus: string };
  await new NativeLogicalInputRepository(
    database,
    lanes,
  ).finishLogicalGuiInTransaction(
    tx,
    ownerId,
    row.workerId,
    logical,
    root.operationGeneration,
    proof.terminalStatus === "failed" ? "failed" : "idle",
  );
}
