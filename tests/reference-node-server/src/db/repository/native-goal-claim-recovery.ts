import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  nativeGoalClaimRecoverySchema,
  type NativeGoalClaimRecovery,
  type NativeGoalClaimRecoveryReceipt,
  type NativeCommandAdmission,
  type NativeCommandSession,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import {
  nativeCommandContext,
  samePlacement,
  sameRuntimeRoute,
} from "./native-command-context.js";
import { goalHandoffSessionMatches } from "./native-goal-handoff-affinity.js";
import { autonomousHandoffAttempt } from "./native-handoff-autonomous-source.js";
import { queueStateChanged } from "./native-command-queue.js";

/** Caller holds the canonical chat lock. The existing claim is the only input;
 * neither a prompt copy nor a fictitious native child is created here. */
export async function readGoalClaimRecovery(
  tx: RepositoryTransaction,
  ownerId: string,
  chatId: string,
): Promise<NativeGoalClaimRecovery | null> {
  const context = await nativeCommandContext(tx, ownerId, chatId);
  if (!context || context.experience !== "agent" || !context.threadId)
    return null;
  const [chat] = await tx
    .select({ id: schema.chats.id })
    .from(schema.chats)
    .where(
      and(
        eq(schema.chats.id, chatId),
        eq(schema.chats.ownerId, ownerId),
        isNull(schema.chats.archivedAt),
        eq(schema.chats.automationPaused, false),
        eq(schema.chats.managedAutonomyStopped, false),
        sql`NOT EXISTS (SELECT 1 FROM managed_queue_states s WHERE s.chat_id = ${chatId} AND s.goal_recovery IS NOT NULL)`,
        sql`NOT EXISTS (SELECT 1 FROM native_runtime_handoffs h WHERE h.chat_id = ${chatId} AND h.phase IN ('preparing','prepared','committed'))`,
        sql`NOT EXISTS (SELECT 1 FROM native_settings_states s WHERE s.chat_id = ${chatId} AND (
      EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(s.state->'pending','[]'::jsonb)) p WHERE p->'intent'->'permissionTransition' IS NOT NULL)
      OR (s.state->>'desiredStatus' = 'uncertain' AND s.state->'desired'->'permissionTransition' IS NOT NULL)))`,
      ),
    );
  if (!chat) return null;
  const rows = await tx
    .select({ claim: schema.managedQueueClaims, parent: schema.nativeCommands })
    .from(schema.managedQueueClaims)
    .innerJoin(
      schema.nativeCommands,
      and(
        eq(
          schema.nativeCommands.operationId,
          schema.managedQueueClaims.operationId,
        ),
        eq(
          schema.nativeCommands.operationGeneration,
          schema.managedQueueClaims.operationGeneration,
        ),
        eq(schema.nativeCommands.chatId, chatId),
        eq(schema.nativeCommands.ownerId, ownerId),
        eq(schema.nativeCommands.workerId, context.workerId),
        eq(schema.nativeCommands.method, "thread/goal/set"),
        eq(schema.nativeCommands.status, "applied"),
      ),
    )
    .innerJoin(
      schema.queuedPrompts,
      and(
        eq(schema.queuedPrompts.id, schema.managedQueueClaims.promptId),
        eq(schema.queuedPrompts.chatId, chatId),
        eq(
          schema.queuedPrompts.revision,
          schema.managedQueueClaims.promptRevision,
        ),
        eq(schema.queuedPrompts.state, "claimed"),
      ),
    )
    .where(
      and(
        eq(schema.managedQueueClaims.chatId, chatId),
        eq(schema.managedQueueClaims.awaitingGoal, true),
        eq(schema.managedQueueClaims.goalCancelled, false),
        isNull(schema.managedQueueClaims.nativeTurnId),
        inArray(schema.managedQueueClaims.status, ["dispatched", "uncertain"]),
      ),
    )
    .limit(2);
  if (rows.length !== 1) return null;
  const { claim, parent } = rows[0]!;
  if (!claim.goalEpoch || !claim.operationId || !claim.operationGeneration)
    return null;
  const [settings] = await tx
    .select({ state: schema.nativeSettingsStates.state })
    .from(schema.nativeSettingsStates)
    .where(eq(schema.nativeSettingsStates.chatId, chatId));
  const session: NativeCommandSession = {
    chatId,
    threadId: context.threadId,
    contextKind: context.contextKind,
    projectId: context.projectId,
    placementId: (context.worktreeId ?? context.scratchRootId)!,
    modelRouteId: context.modelRouteId,
    providerAccountId: context.providerAccountId,
    runtimeGeneration:
      settings?.state.binding?.runtimeGeneration ??
      (parent.identity as NativeCommandSession).runtimeGeneration,
    connectionId: null,
  };
  if (
    !(await goalHandoffSessionMatches(
      tx,
      ownerId,
      context.workerId,
      claim,
      parent.identity as NativeCommandSession,
      session,
    ))
  )
    return null;
  let admission: NativeGoalClaimRecovery["admission"] = null;
  if (claim.goalOperationId || claim.goalOperationGeneration) {
    if (!claim.goalOperationId || !claim.goalOperationGeneration) return null;
    const [child] = await tx
      .select()
      .from(schema.nativeCommands)
      .where(
        and(
          eq(schema.nativeCommands.operationId, claim.goalOperationId),
          eq(
            schema.nativeCommands.operationGeneration,
            claim.goalOperationGeneration,
          ),
          eq(schema.nativeCommands.ownerId, ownerId),
          eq(schema.nativeCommands.workerId, context.workerId),
          eq(schema.nativeCommands.chatId, chatId),
        ),
      );
    if (
      !child ||
      child.status !== "accepted" ||
      child.executionCompletedAt ||
      child.resultDigest ||
      child.protectedResult ||
      child.terminalResultDigest ||
      child.protectedTerminalResult ||
      autonomousHandoffAttempt(child)?.goalEpoch !== claim.goalEpoch
    )
      return null;
    const [observed] = await tx
      .select({ operationId: schema.nativeCommandTurns.operationId })
      .from(schema.nativeCommandTurns)
      .where(eq(schema.nativeCommandTurns.operationId, child.operationId))
      .limit(1);
    if (observed) return null;
    admission = {
      operationId: child.operationId,
      operationGeneration: child.operationGeneration,
      workerGeneration: (child.intent as NativeCommandAdmission["intent"])
        .workerGeneration!,
    };
  }
  const result = nativeGoalClaimRecoverySchema.safeParse({
    claimId: claim.id,
    promptId: claim.promptId,
    promptRevision: claim.promptRevision,
    operationId: claim.operationId,
    operationGeneration: claim.operationGeneration,
    threadId: context.threadId,
    goalEpoch: claim.goalEpoch,
    admission,
  });
  return result.success ? result.data : null;
}

/** Negative actual Goal reads can consume only this unchanged applied input.
 * Observation deadlines and stale native bindings do not retire anything. */
export async function confirmGoalClaimRecovery(
  tx: RepositoryTransaction,
  ownerId: string,
  chatId: string,
  receipt: NativeGoalClaimRecoveryReceipt,
) {
  if (receipt.status !== "ineligible") return;
  const current = await readGoalClaimRecovery(tx, ownerId, chatId);
  if (
    !current ||
    current.admission ||
    !isDeepStrictEqual(current, receipt.claim)
  )
    return;
  const observed = receipt.observation;
  if (
    observed.goalEpoch === current.goalEpoch &&
    observed.goalStatus === "active"
  )
    return;
  const [settings] = await tx
    .select({ state: schema.nativeSettingsStates.state })
    .from(schema.nativeSettingsStates)
    .where(eq(schema.nativeSettingsStates.chatId, chatId));
  const binding = settings?.state.binding;
  const context = await nativeCommandContext(tx, ownerId, chatId);
  if (
    !binding ||
    !context ||
    !samePlacement(context, observed.workerId, {
      ...observed,
      connectionId: null,
    }) ||
    !sameRuntimeRoute(context, { ...observed, connectionId: null }) ||
    context.threadId !== observed.threadId ||
    !(
      [
        "chatId",
        "workerId",
        "threadId",
        "contextKind",
        "projectId",
        "placementId",
        "modelRouteId",
        "providerAccountId",
        "runtimeGeneration",
        "nativeEpoch",
      ] as const
    ).every((field) => binding[field] === observed[field])
  )
    return;
  await tx
    .update(schema.managedQueueClaims)
    .set({ status: "consumed" })
    .where(eq(schema.managedQueueClaims.id, current.claimId));
  await tx
    .update(schema.queuedPrompts)
    .set({ state: "consumed", updatedAt: new Date() })
    .where(
      and(
        eq(schema.queuedPrompts.id, current.promptId),
        eq(schema.queuedPrompts.chatId, chatId),
        eq(schema.queuedPrompts.revision, current.promptRevision),
        eq(schema.queuedPrompts.state, "claimed"),
      ),
    );
  await queueStateChanged(tx, chatId);
}
