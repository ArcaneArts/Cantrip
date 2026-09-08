import { and, eq, or, sql, isNull, inArray } from "drizzle-orm";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import { NativeCommandError } from "./native-command-errors.js";
type CommandRow = typeof schema.nativeCommands.$inferSelect;
// These helpers run inside the caller's existing canonical chat transaction.
export async function settleQueueClaim(
  tx: RepositoryTransaction,
  row: CommandRow,
  nativeTurnId: string | null = null,
  goalEpoch?: string,
) {
  const [claim] = await tx
    .select()
    .from(schema.managedQueueClaims)
    .where(
      or(
        and(
          eq(schema.managedQueueClaims.operationId, row.operationId),
          eq(
            schema.managedQueueClaims.operationGeneration,
            row.operationGeneration,
          ),
        ),
        and(
          eq(schema.managedQueueClaims.goalOperationId, row.operationId),
          eq(
            schema.managedQueueClaims.goalOperationGeneration,
            row.operationGeneration,
          ),
        ),
      ),
    );
  if (!claim || ["consumed", "rejected"].includes(claim.status)) return;
  if (goalEpoch) {
    if (
      row.method !== "thread/goal/set" ||
      !claim.awaitingGoal ||
      (claim.goalEpoch && claim.goalEpoch !== goalEpoch)
    )
      throw new NativeCommandError("stale-goal-epoch");
    await tx
      .update(schema.managedQueueClaims)
      .set({ goalEpoch })
      .where(eq(schema.managedQueueClaims.id, claim.id));
  }
  const parentGoal =
    claim.awaitingGoal && claim.operationId === row.operationId;
  if (parentGoal && row.status === "applied" && !claim.goalEpoch && !goalEpoch)
    throw new NativeCommandError("goal-epoch-required");
  const consumed =
    !parentGoal &&
    row.status === "applied" &&
    Boolean(row.protectedResult && row.resultDigest);
  const rejected = row.status === "rejected";
  await tx
    .update(schema.managedQueueClaims)
    .set({
      status: consumed
        ? "consumed"
        : rejected
          ? "rejected"
          : row.status === "uncertain"
            ? "uncertain"
            : claim.status,
      ...(nativeTurnId ? { nativeTurnId } : {}),
    })
    .where(eq(schema.managedQueueClaims.id, claim.id));
  if (consumed || rejected) {
    await tx
      .update(schema.queuedPrompts)
      .set({
        state: consumed ? "consumed" : "pending",
        updatedAt: new Date(),
      })
      .where(eq(schema.queuedPrompts.id, claim.promptId));
    await tx
      .update(schema.managedQueueStates)
      .set({ revision: sql`${schema.managedQueueStates.revision}+1` })
      .where(eq(schema.managedQueueStates.chatId, claim.chatId));
  }
}
export async function cancelGoalHandoffs(
  tx: RepositoryTransaction,
  chatId: string,
) {
  const cancelled = await tx
    .update(schema.managedQueueClaims)
    .set({ status: "rejected" })
    .where(
      and(
        eq(schema.managedQueueClaims.chatId, chatId),
        eq(schema.managedQueueClaims.awaitingGoal, true),
        isNull(schema.managedQueueClaims.goalOperationId),
        inArray(schema.managedQueueClaims.status, [
          "accepted",
          "dispatched",
          "uncertain",
        ]),
      ),
    )
    .returning();
  for (const claim of cancelled) {
    if (claim.operationId)
      await tx
        .update(schema.nativeCommands)
        .set({
          status: "rejected",
          rejectionCode: "queue-goal-handoff-cancelled",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.nativeCommands.operationId, claim.operationId),
            eq(
              schema.nativeCommands.operationGeneration,
              claim.operationGeneration!,
            ),
            eq(schema.nativeCommands.status, "accepted"),
          ),
        );
    await tx
      .update(schema.queuedPrompts)
      .set({ state: "pending" })
      .where(eq(schema.queuedPrompts.id, claim.promptId));
  }
  if (cancelled.length) await queueStateChanged(tx, chatId);
}
export async function queueStateChanged(
  tx: RepositoryTransaction,
  chatId: string,
) {
  await tx
    .update(schema.managedQueueStates)
    .set({ revision: sql`${schema.managedQueueStates.revision}+1` })
    .where(eq(schema.managedQueueStates.chatId, chatId));
}
