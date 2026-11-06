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
  if (!claim || ["consumed", "rejected", "deferred"].includes(claim.status))
    return;
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
    row.status === "applied" &&
    Boolean(row.protectedResult && row.resultDigest) &&
    (!parentGoal || claim.goalCancelled);
  const deferred =
    row.status === "rejected" &&
    row.rejectionCode === "native-settings-pending" &&
    row.terminalEvidence !== null &&
    typeof row.terminalEvidence === "object" &&
    "kind" in row.terminalEvidence &&
    row.terminalEvidence.kind === "deferred";
  const rejected = row.status === "rejected" && !deferred;
  // A child attempt can fail before execution, but its Goal setter already
  // changed native state. Returning that input to pending would repeat it.
  let appliedGoal = parentGoal && row.status === "applied";
  if (claim.awaitingGoal && !parentGoal && claim.operationId) {
    const [parent] = await tx
      .select({ status: schema.nativeCommands.status })
      .from(schema.nativeCommands)
      .where(
        and(
          eq(schema.nativeCommands.operationId, claim.operationId),
          eq(
            schema.nativeCommands.operationGeneration,
            claim.operationGeneration!,
          ),
          eq(schema.nativeCommands.chatId, claim.chatId),
          eq(schema.nativeCommands.ownerId, row.ownerId),
          eq(schema.nativeCommands.method, "thread/goal/set"),
        ),
      );
    appliedGoal = parent?.status === "applied";
  }
  await tx
    .update(schema.managedQueueClaims)
    .set({
      status: deferred
        ? "deferred"
        : consumed
          ? "consumed"
          : rejected
            ? "rejected"
            : row.status === "uncertain"
              ? "uncertain"
              : claim.status,
      ...(nativeTurnId ? { nativeTurnId } : {}),
    })
    .where(eq(schema.managedQueueClaims.id, claim.id));
  if (consumed || rejected || deferred) {
    await tx
      .update(schema.queuedPrompts)
      .set({
        state: consumed || appliedGoal ? "consumed" : "pending",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.queuedPrompts.id, claim.promptId),
          eq(schema.queuedPrompts.chatId, claim.chatId),
          eq(schema.queuedPrompts.revision, claim.promptRevision),
          eq(schema.queuedPrompts.state, "claimed"),
        ),
      );
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
  const removedRecovery = await tx
    .update(schema.managedQueueStates)
    .set({ goalRecovery: null })
    .where(
      and(
        eq(schema.managedQueueStates.chatId, chatId),
        sql`${schema.managedQueueStates.goalRecovery} IS NOT NULL`,
      ),
    )
    .returning({ chatId: schema.managedQueueStates.chatId });
  const cancelled = await tx
    .select()
    .from(schema.managedQueueClaims)
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
    );
  for (const claim of cancelled) {
    const [parent] =
      claim.operationId && claim.operationGeneration
        ? await tx
            .select()
            .from(schema.nativeCommands)
            .where(
              and(
                eq(schema.nativeCommands.operationId, claim.operationId),
                eq(
                  schema.nativeCommands.operationGeneration,
                  claim.operationGeneration,
                ),
                eq(schema.nativeCommands.chatId, chatId),
                eq(schema.nativeCommands.method, "thread/goal/set"),
              ),
            )
        : [];
    // Only accepted authority can be revoked before forwarding. A dispatched
    // setter with no response remains uncertain until its actual receipt; Stop
    // must neither replay it nor pretend that its native side effects ended.
    const consumed = parent?.status === "applied";
    const rejected =
      parent?.status === "accepted" || parent?.status === "rejected";
    if (parent?.status === "accepted")
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
      .update(schema.managedQueueClaims)
      .set({
        goalCancelled: true,
        status: consumed ? "consumed" : rejected ? "rejected" : "uncertain",
      })
      .where(eq(schema.managedQueueClaims.id, claim.id));
    await tx
      .update(schema.queuedPrompts)
      .set({
        state: consumed ? "consumed" : rejected ? "pending" : "claimed",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.queuedPrompts.id, claim.promptId),
          eq(schema.queuedPrompts.chatId, chatId),
          eq(schema.queuedPrompts.revision, claim.promptRevision),
          eq(schema.queuedPrompts.state, "claimed"),
        ),
      );
  }
  if (cancelled.length || removedRecovery.length)
    await queueStateChanged(tx, chatId);
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
