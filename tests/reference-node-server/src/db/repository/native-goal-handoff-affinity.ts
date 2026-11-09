import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  nativeGoalRecoverySchema,
  type NativeCommandSession,
  type NativeRuntimeHandoffQueuedSource,
  type NativeCommandAdmission,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";

export type GoalHandoffClaim = NonNullable<
  NativeRuntimeHandoffQueuedSource["goalClaim"]
>;
export type GoalClaimRow = typeof schema.managedQueueClaims.$inferSelect;

export function goalClaimIdentity(
  claim: GoalClaimRow,
): GoalHandoffClaim | null {
  if (
    !claim.awaitingGoal ||
    !claim.operationId ||
    !claim.operationGeneration ||
    !claim.goalEpoch
  )
    return null;
  return {
    id: claim.id,
    promptId: claim.promptId,
    promptRevision: claim.promptRevision,
    operationId: claim.operationId,
    operationGeneration: claim.operationGeneration,
    goalEpoch: claim.goalEpoch,
  };
}

const normalized = (session: NativeCommandSession, route = true) => ({
  ...session,
  runtimeGeneration: null,
  connectionId: null,
  ...(route ? {} : { modelRouteId: null, providerAccountId: null }),
});

/** A positive unused-cycle marker survives a native binding replacement. It
 * may carry only this exact immutable first claim into the actual current binding. */
async function recoveryMarkerMatches(
  tx: RepositoryTransaction,
  ownerId: string,
  workerId: string,
  claim: GoalClaimRow,
  current: NativeCommandSession,
): Promise<boolean> {
  if (claim.nativeTurnId || !["dispatched", "uncertain"].includes(claim.status))
    return false;
  const [state] = await tx
    .select({ recovery: schema.managedQueueStates.goalRecovery })
    .from(schema.managedQueueStates)
    .where(eq(schema.managedQueueStates.chatId, current.chatId));
  if (!state?.recovery) return false;
  const marker = nativeGoalRecoverySchema.parse(state.recovery);
  if (
    marker.source.goalEpoch !== claim.goalEpoch ||
    marker.source.threadId !== current.threadId
  )
    return false;
  const [source] = await tx
    .select()
    .from(schema.nativeCommands)
    .where(
      and(
        eq(schema.nativeCommands.ownerId, ownerId),
        eq(schema.nativeCommands.workerId, workerId),
        eq(schema.nativeCommands.chatId, current.chatId),
        eq(schema.nativeCommands.operationId, marker.source.operationId),
        eq(
          schema.nativeCommands.operationGeneration,
          marker.source.operationGeneration,
        ),
      ),
    );
  if (
    !source?.executionCompletedAt ||
    !isDeepStrictEqual(source.goalRecoverySource, marker.source)
  )
    return false;
  if (!marker.admission)
    return !claim.goalOperationId && !claim.goalOperationGeneration;
  if (
    claim.goalOperationId !== marker.admission.operationId ||
    claim.goalOperationGeneration !== marker.admission.operationGeneration
  )
    return false;
  const [child] = await tx
    .select()
    .from(schema.nativeCommands)
    .where(
      and(
        eq(schema.nativeCommands.ownerId, ownerId),
        eq(schema.nativeCommands.workerId, workerId),
        eq(schema.nativeCommands.chatId, current.chatId),
        eq(schema.nativeCommands.operationId, marker.admission.operationId),
        eq(
          schema.nativeCommands.operationGeneration,
          marker.admission.operationGeneration,
        ),
      ),
    );
  if (!child || child.status !== "accepted" || child.executionCompletedAt)
    return false;
  const intent = child.intent as NativeCommandAdmission["intent"];
  const session = child.identity as NativeCommandSession;
  return (
    isDeepStrictEqual(intent.goalRecovery, marker.source) &&
    (intent.goalRecoveryOrderEpoch ?? 0) === (marker.orderEpoch ?? 0) &&
    intent.workerGeneration === marker.admission.workerGeneration &&
    session.runtimeGeneration === current.runtimeGeneration &&
    isDeepStrictEqual(normalized(session), normalized(current))
  );
}

/** Changing route cannot mutate the immutable, already-applied Goal setter.
 * Only a settled, worker-confirmed transfer of this exact pending claim may
 * provide affinity, and it must still own the current full settings binding. */
export async function goalHandoffSessionMatches(
  tx: RepositoryTransaction,
  ownerId: string,
  workerId: string,
  claim: GoalClaimRow,
  parent: NativeCommandSession,
  current: NativeCommandSession,
): Promise<boolean> {
  if (isDeepStrictEqual(normalized(parent), normalized(current))) return true;
  if (!isDeepStrictEqual(normalized(parent, false), normalized(current, false)))
    return false;
  const identity = goalClaimIdentity(claim);
  if (!identity) return false;
  const [settings] = await tx
    .select({ state: schema.nativeSettingsStates.state })
    .from(schema.nativeSettingsStates)
    .where(eq(schema.nativeSettingsStates.chatId, current.chatId));
  const binding = settings?.state.binding;
  if (
    !binding ||
    binding.workerId !== workerId ||
    binding.chatId !== current.chatId ||
    binding.threadId !== current.threadId ||
    binding.runtimeGeneration !== current.runtimeGeneration ||
    binding.modelRouteId !== current.modelRouteId ||
    binding.providerAccountId !== current.providerAccountId ||
    binding.contextKind !== current.contextKind ||
    binding.projectId !== current.projectId ||
    binding.placementId !== current.placementId
  )
    return false;
  if (await recoveryMarkerMatches(tx, ownerId, workerId, claim, current))
    return true;
  const [transfer] = await tx
    .select({ id: schema.nativeRuntimeHandoffs.operationId })
    .from(schema.nativeRuntimeHandoffs)
    .where(
      and(
        eq(schema.nativeRuntimeHandoffs.ownerId, ownerId),
        eq(schema.nativeRuntimeHandoffs.workerId, workerId),
        eq(schema.nativeRuntimeHandoffs.chatId, current.chatId),
        inArray(schema.nativeRuntimeHandoffs.phase, ["completed", "cancelled"]),
        sql`${schema.nativeRuntimeHandoffs.queuedSource}->>'withdrawn' = 'true'`,
        sql`${schema.nativeRuntimeHandoffs.queuedSource}->'goalClaim' = ${JSON.stringify(identity)}::jsonb`,
        sql`${schema.nativeRuntimeHandoffs.binding} = ${JSON.stringify(binding)}::jsonb`,
      ),
    )
    .limit(1);
  return Boolean(transfer);
}
