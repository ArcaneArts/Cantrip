import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import {
  nativeGoalRecoverySchema,
  type NativeGoalRecoveryWithdrawal,
  type NativeRuntimeHandoffQueuedSource,
  type NativeSettingsBinding,
  type NativeCommandSession,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import { NativeCommandError } from "./native-command-errors.js";
import { readNativeCommand } from "./native-command-context.js";
import { autonomousHandoffAttempt } from "./native-handoff-autonomous-source.js";
import {
  goalClaimIdentity,
  goalHandoffSessionMatches,
  type GoalClaimRow,
} from "./native-goal-handoff-affinity.js";
import {
  assertGoalClaimPrompt,
  retainedGoalClaimMatches,
} from "./native-handoff-goal-claim.js";
import { queueStateChanged } from "./native-command-queue.js";

const fail = (): never => {
  throw new NativeCommandError("handoff-native-operation-pending");
};
async function markerFor(tx: RepositoryTransaction, chatId: string) {
  const [row] = await tx
    .select({ recovery: schema.managedQueueStates.goalRecovery })
    .from(schema.managedQueueStates)
    .where(eq(schema.managedQueueStates.chatId, chatId));
  return row?.recovery ? nativeGoalRecoverySchema.parse(row.recovery) : null;
}

/** Actual routing commit, after native withdrawal. Leaving a provider ends
 * its FIFO episode even if the cycle later returns to the same provider. */
export async function commitGoalRecoveryProvider(
  tx: RepositoryTransaction,
  source: NativeSettingsBinding,
  queued: NativeRuntimeHandoffQueuedSource | null | undefined,
  targetProviderId: string,
): Promise<void> {
  const marker = await markerFor(tx, source.chatId);
  if (!marker) return;
  if (!queued?.withdrawn || marker.admission) fail();
  const [retired] = await tx
    .select()
    .from(schema.nativeCommands)
    .where(
      and(
        eq(schema.nativeCommands.operationId, queued!.operationId),
        eq(
          schema.nativeCommands.operationGeneration,
          queued!.operationGeneration,
        ),
        eq(schema.nativeCommands.chatId, source.chatId),
        eq(schema.nativeCommands.workerId, source.workerId),
      ),
    );
  if (
    !retired?.executionCompletedAt ||
    !isDeepStrictEqual(retired.goalRecoverySource, marker.source)
  )
    fail();
  let previousProviderId = marker.providerId;
  if (!previousProviderId && source.modelRouteId) {
    const [route] = await tx
      .select({ providerId: schema.modelRoutes.providerId })
      .from(schema.modelRoutes)
      .where(eq(schema.modelRoutes.id, source.modelRouteId));
    previousProviderId = route?.providerId;
  }
  const next = nativeGoalRecoverySchema.parse({
    ...marker,
    providerId: targetProviderId,
    orderEpoch:
      (marker.orderEpoch ?? 0) +
      (previousProviderId === targetProviderId ? 0 : 1),
  });
  await tx
    .update(schema.managedQueueStates)
    .set({ goalRecovery: next })
    .where(eq(schema.managedQueueStates.chatId, source.chatId));
  await queueStateChanged(tx, source.chatId);
}

async function validateClaim(
  tx: RepositoryTransaction,
  ownerId: string,
  source: NativeSettingsBinding,
  claims: GoalClaimRow[],
  epoch: string,
) {
  if (!claims.length) return undefined;
  const claim = claims[0]!;
  const identity = goalClaimIdentity(claim);
  if (
    claims.length !== 1 ||
    claim.chatId !== source.chatId ||
    !identity ||
    identity.goalEpoch !== epoch ||
    !retainedGoalClaimMatches(claim, identity)
  )
    fail();
  const parent = await readNativeCommand(
    tx,
    ownerId,
    source.workerId,
    identity!.operationId,
    identity!.operationGeneration,
  );
  if (
    parent.chatId !== source.chatId ||
    parent.method !== "thread/goal/set" ||
    parent.status !== "applied" ||
    !(await goalHandoffSessionMatches(
      tx,
      parent.ownerId,
      source.workerId,
      claim,
      parent.identity as NativeCommandSession,
      {
        chatId: source.chatId,
        threadId: source.threadId,
        runtimeGeneration: source.runtimeGeneration,
        contextKind: source.contextKind,
        projectId: source.projectId,
        placementId: source.placementId,
        modelRouteId: source.modelRouteId,
        providerAccountId: source.providerAccountId,
        connectionId: null,
      },
    ))
  )
    fail();
  await assertGoalClaimPrompt(tx, source.chatId, identity!);
  return identity!;
}

/** Called under the chat lock. A retained marker is positive no-dispatch
 * authority; the worker must still acknowledge actual native gate invalidation. */
export async function reserveGoalRecoveryHandoff(
  tx: RepositoryTransaction,
  source: NativeSettingsBinding,
  idle: boolean,
  claims: GoalClaimRow[],
): Promise<NativeRuntimeHandoffQueuedSource | undefined> {
  const marker = await markerFor(tx, source.chatId);
  if (!marker || marker.admission) return undefined;
  if (!idle || marker.source.threadId !== source.threadId) fail();
  const [root] = await tx
    .select()
    .from(schema.nativeCommands)
    .where(
      and(
        eq(schema.nativeCommands.operationId, marker.source.operationId),
        eq(
          schema.nativeCommands.operationGeneration,
          marker.source.operationGeneration,
        ),
        eq(schema.nativeCommands.chatId, source.chatId),
        eq(schema.nativeCommands.workerId, source.workerId),
      ),
    );
  const attempt = root && autonomousHandoffAttempt(root);
  if (
    !root?.executionCompletedAt ||
    !isDeepStrictEqual(root.goalRecoverySource, marker.source) ||
    !attempt ||
    attempt.goalEpoch !== marker.source.goalEpoch
  )
    fail();
  const goalClaim = await validateClaim(
    tx,
    root!.ownerId,
    source,
    claims,
    marker.source.goalEpoch,
  );
  return {
    operationId: marker.source.operationId,
    operationGeneration: marker.source.operationGeneration,
    withdrawn: false,
    goalRecovery: marker.source,
    autonomousAttempt: attempt!,
    ...(goalClaim ? { goalClaim } : {}),
  };
}

/** The reservation owns this cycle while the actual runner is fenced. A Stop
 * may remove the marker after reservation; never recreate it in that case. */
export async function confirmGoalRecoveryHandoff(
  tx: RepositoryTransaction,
  source: NativeSettingsBinding,
  queued: NativeRuntimeHandoffQueuedSource,
  operationId: string,
  receipt: NativeGoalRecoveryWithdrawal,
) {
  if (
    !queued.goalRecovery ||
    queued.operationId !== queued.goalRecovery.operationId ||
    queued.operationGeneration !== queued.goalRecovery.operationGeneration ||
    receipt.operationId !== operationId ||
    !isDeepStrictEqual(receipt.source, queued.goalRecovery) ||
    receipt.bindingId !== source.bindingId ||
    receipt.runtimeGeneration !== source.runtimeGeneration
  )
    fail();
  const marker = await markerFor(tx, source.chatId);
  if (
    marker &&
    (marker.admission || !isDeepStrictEqual(marker.source, queued.goalRecovery))
  )
    fail();
  const [root] = await tx
    .select()
    .from(schema.nativeCommands)
    .where(
      and(
        eq(schema.nativeCommands.operationId, queued.operationId),
        eq(
          schema.nativeCommands.operationGeneration,
          queued.operationGeneration,
        ),
        eq(schema.nativeCommands.chatId, source.chatId),
        eq(schema.nativeCommands.workerId, source.workerId),
      ),
    );
  if (
    !root?.executionCompletedAt ||
    !isDeepStrictEqual(root.goalRecoverySource, queued.goalRecovery)
  )
    fail();
  // assertIdle also verifies the exact retained claim/prompt under this lock.
}
