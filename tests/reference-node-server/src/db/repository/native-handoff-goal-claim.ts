import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import type {
  NativeCommandAdmission,
  NativeCommandSession,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import { NativeCommandError } from "./native-command-errors.js";
import {
  goalClaimIdentity,
  goalHandoffSessionMatches,
  type GoalHandoffClaim,
  type GoalClaimRow,
} from "./native-goal-handoff-affinity.js";

const fail = (): never => {
  throw new NativeCommandError("handoff-native-operation-pending");
};

export function retainedGoalClaimMatches(
  claim: GoalClaimRow,
  expected: GoalHandoffClaim,
): boolean {
  return (
    isDeepStrictEqual(goalClaimIdentity(claim), expected) &&
    !claim.goalCancelled &&
    ["dispatched", "uncertain"].includes(claim.status) &&
    !claim.nativeTurnId &&
    !claim.goalOperationId &&
    !claim.goalOperationGeneration
  );
}

export async function assertGoalClaimPrompt(
  tx: RepositoryTransaction,
  chatId: string,
  expected: GoalHandoffClaim,
): Promise<void> {
  const [prompt] = await tx
    .select({ id: schema.queuedPrompts.id })
    .from(schema.queuedPrompts)
    .where(
      and(
        eq(schema.queuedPrompts.id, expected.promptId),
        eq(schema.queuedPrompts.chatId, chatId),
        eq(schema.queuedPrompts.revision, expected.promptRevision),
        eq(schema.queuedPrompts.state, "claimed"),
      ),
    )
    .limit(1);
  if (!prompt) fail();
}

/** Reserve only the immutable first-cycle claim already bound to this exact
 * native attempt. The parent setter and original ciphertext stay unchanged. */
export async function captureHandoffGoalClaim(
  tx: RepositoryTransaction,
  command: typeof schema.nativeCommands.$inferSelect,
  claims: GoalClaimRow[],
): Promise<GoalHandoffClaim | undefined> {
  if (!claims.length) return undefined;
  const claim = claims[0]!;
  const identity = goalClaimIdentity(claim);
  const attempt = (command.intent as NativeCommandAdmission["intent"])
    .autonomousAttempt;
  if (
    claims.length !== 1 ||
    claim.goalCancelled ||
    !identity ||
    !attempt?.goalEpoch ||
    identity.goalEpoch !== attempt.goalEpoch ||
    claim.chatId !== command.chatId ||
    !["dispatched", "uncertain"].includes(claim.status) ||
    claim.nativeTurnId ||
    claim.goalOperationId !== command.operationId ||
    claim.goalOperationGeneration !== command.operationGeneration
  )
    fail();
  const [parent] = await tx
    .select()
    .from(schema.nativeCommands)
    .where(
      and(
        eq(schema.nativeCommands.operationId, identity!.operationId),
        eq(
          schema.nativeCommands.operationGeneration,
          identity!.operationGeneration,
        ),
        eq(schema.nativeCommands.ownerId, command.ownerId),
        eq(schema.nativeCommands.workerId, command.workerId),
        eq(schema.nativeCommands.chatId, command.chatId),
      ),
    );
  if (
    !parent ||
    parent.method !== "thread/goal/set" ||
    parent.status !== "applied" ||
    !(await goalHandoffSessionMatches(
      tx,
      command.ownerId,
      command.workerId,
      claim,
      parent.identity as NativeCommandSession,
      command.identity as NativeCommandSession,
    ))
  )
    fail();
  await assertGoalClaimPrompt(tx, command.chatId, identity!);
  return identity!;
}

/** Retiring the first attempt never returns the already-applied Goal setter
 * to the prompt dispatcher. A Stop may instead have rejected this exact claim. */
export async function validateWithdrawingGoalClaim(
  tx: RepositoryTransaction,
  root: typeof schema.nativeCommands.$inferSelect,
  expected: GoalHandoffClaim,
  active: GoalClaimRow[],
  alreadyDeferred: boolean,
): Promise<void> {
  if (
    (root.intent as NativeCommandAdmission["intent"]).autonomousAttempt
      ?.goalEpoch !== expected.goalEpoch
  )
    fail();
  if (active.length > 1 || active.some((claim) => claim.id !== expected.id))
    fail();
  const [claim] = await tx
    .select()
    .from(schema.managedQueueClaims)
    .where(
      and(
        eq(schema.managedQueueClaims.id, expected.id),
        eq(schema.managedQueueClaims.chatId, root.chatId),
      ),
    );
  if (
    !claim ||
    !isDeepStrictEqual(goalClaimIdentity(claim), expected) ||
    claim.nativeTurnId
  )
    fail();
  const child =
    claim!.goalOperationId === root.operationId &&
    claim!.goalOperationGeneration === root.operationGeneration;
  const retired =
    alreadyDeferred &&
    !claim!.goalOperationId &&
    !claim!.goalOperationGeneration;
  if (!child && !retired) fail();
  if (["dispatched", "uncertain"].includes(claim!.status)) {
    await assertGoalClaimPrompt(tx, root.chatId, expected);
  } else if (!(
    (claim!.status === "rejected" && root.status === "rejected") ||
    (alreadyDeferred &&
      claim!.goalCancelled &&
      claim!.status === "consumed" &&
      root.status === "rejected")
  ))
    fail();
}
