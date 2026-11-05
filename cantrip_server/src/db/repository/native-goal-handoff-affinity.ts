import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, sql } from "drizzle-orm";
import type {
  NativeCommandSession,
  NativeRuntimeHandoffQueuedSource,
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
