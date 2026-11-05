import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import {
  nativeAutonomousAttemptSchema,
  nativeGoalRecoverySchema,
  type NativeAutonomousAttempt,
  type NativeCommandAdmission,
  type NativeCommandSession,
  type NativeSettingsBinding,
  type InferenceJournalRecord,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import type { ChatExecutionLaneRepository } from "./chat-execution-lanes.js";
import { NativeCommandError } from "./native-command-errors.js";
import { isNativeTransportClosure } from "./native-transport-evidence.js";
import { queueStateChanged } from "./native-command-queue.js";
import { validateWithdrawingGoalClaim } from "./native-handoff-goal-claim.js";
import type { GoalHandoffClaim } from "./native-goal-handoff-affinity.js";

type Command = typeof schema.nativeCommands.$inferSelect;
const fail = (): never => {
  throw new NativeCommandError("handoff-native-operation-pending");
};

/** This is an unstarted native cycle, not a GUI logical input or a Task's
 * private inference channel. Older commands without observed identity refuse. */
export function autonomousHandoffAttempt(
  command: Command,
): NativeAutonomousAttempt | null {
  const intent = command.intent as NativeCommandAdmission["intent"];
  const parsed = nativeAutonomousAttemptSchema.safeParse(
    intent.autonomousAttempt,
  );
  if (
    !parsed.success ||
    command.origin !== "autonomous" ||
    command.kind !== "start" ||
    command.method !== "turn/start" ||
    command.logicalOperationId ||
    command.previousOperationId ||
    command.operationId !==
      `native:${parsed.data.runnerGeneration}:${parsed.data.attemptId}` ||
    intent.expectedTurnId !== parsed.data.turnId ||
    (command.identity as NativeCommandSession).connectionId !==
      `autonomous:${parsed.data.runnerGeneration}`
  )
    return null;
  return parsed.data;
}

/** Called under the existing Chat lock, after the worker sealed its exact
 * source AND acknowledged actual native runner invalidation. No prompt is
 * re-enqueued: the portable native Goal remains responsible for its next cycle. */
export async function confirmAutonomousHandoffSource(
  tx: RepositoryTransaction,
  lanes: ChatExecutionLaneRepository,
  source: NativeSettingsBinding,
  root: Command,
  expected: NativeAutonomousAttempt,
  record: InferenceJournalRecord | null,
  goalClaim?: GoalHandoffClaim,
): Promise<void> {
  const attempt = autonomousHandoffAttempt(root);
  if (
    !attempt ||
    !isDeepStrictEqual(attempt, expected) ||
    root.chatId !== source.chatId ||
    root.workerId !== source.workerId ||
    !root.executionLaneId ||
    !root.activationGeneration
  )
    fail();
  const session = root.identity as NativeCommandSession;
  if (
    session.threadId !== source.threadId ||
    session.runtimeGeneration !== source.runtimeGeneration ||
    session.modelRouteId !== source.modelRouteId ||
    session.providerAccountId !== source.providerAccountId ||
    session.contextKind !== source.contextKind ||
    session.projectId !== source.projectId ||
    session.placementId !== source.placementId
  )
    fail();
  const [observed] = await tx
    .select({ id: schema.nativeCommandTurns.operationId })
    .from(schema.nativeCommandTurns)
    .where(eq(schema.nativeCommandTurns.operationId, root.operationId))
    .limit(1);
  const claims = await tx
    .select()
    .from(schema.managedQueueClaims)
    .where(
      and(
        eq(schema.managedQueueClaims.chatId, source.chatId),
        inArray(schema.managedQueueClaims.status, [
          "claimed",
          "accepted",
          "dispatched",
          "uncertain",
        ]),
      ),
    )
    .limit(2);
  if (observed || (!goalClaim && claims.length)) fail();
  const evidence = root.terminalEvidence as Record<string, unknown> | null;
  const alreadyDeferred =
    root.status === "rejected" &&
    root.rejectionCode === "worker-inference-deferred" &&
    root.logicalCompletedAt &&
    root.executionCompletedAt &&
    evidence?.kind === "not-started" &&
    evidence.source === "worker-inference-journal";
  if (goalClaim)
    await validateWithdrawingGoalClaim(
      tx,
      root,
      goalClaim,
      claims,
      Boolean(alreadyDeferred),
    );
  if (!record) {
    if (!alreadyDeferred) fail();
    await completeRecoveredGoalWithdrawal(tx, root);
    return;
  }
  const identity = record.identity.recovery;
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        record.workerGeneration,
        record.identity.runtimeGeneration,
        record.identity.operationId,
      ]),
    )
    .digest("hex");
  if (
    record.key !== key ||
    record.state !== "released" ||
    record.outcome !== "never-started" ||
    record.nativeExecution ||
    record.identity.operationId !== root.operationGeneration ||
    record.identity.chatId !== source.chatId ||
    (record.identity.projectId !== null &&
      record.identity.projectId !== source.projectId) ||
    identity?.commandId !== root.operationId ||
    identity.commandGeneration !== root.operationGeneration ||
    identity.threadId !== source.threadId ||
    identity.turnId !== expected.turnId ||
    (alreadyDeferred && evidence?.key !== record.key)
  )
    fail();
  if (alreadyDeferred) {
    await completeRecoveredGoalWithdrawal(tx, root);
    return;
  }
  const [activation] = await tx
    .select()
    .from(schema.nativeCommandActivations)
    .where(eq(schema.nativeCommandActivations.chatId, root.chatId));
  const sameActivation =
    activation?.generation === root.activationGeneration &&
    activation?.operationId === root.operationId &&
    activation?.executionLaneId === root.executionLaneId;
  if (
    root.resultDigest ||
    root.protectedResult ||
    root.terminalResultDigest ||
    root.protectedTerminalResult
  )
    fail();
  const persistNoStart = async (preserveCancellation = false) => {
    const now = new Date();
    await tx
      .update(schema.nativeCommands)
      .set({
        status: "rejected",
        rejectionCode: preserveCancellation
          ? root.rejectionCode
          : "worker-inference-deferred",
        terminalEvidence: {
          kind: "not-started",
          source: "worker-inference-journal",
          key: record.key,
          workerGeneration: record.workerGeneration,
          runtimeGeneration: record.identity.runtimeGeneration,
          revision: record.revision,
        },
        logicalCompletedAt: root.logicalCompletedAt ?? now,
        executionCompletedAt: root.executionCompletedAt ?? now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.nativeCommands.operationId, root.operationId),
          eq(
            schema.nativeCommands.operationGeneration,
            root.operationGeneration,
          ),
        ),
      );
  };
  // A Stop that won this race remains stopped. There is no prompt to restore.
  if (
    sameActivation &&
    activation?.logicalCancelled &&
    !activation.active &&
    root.status === "rejected" &&
    (root.executionCompletedAt ||
      root.rejectionCode === "cancelled-before-dispatch")
  ) {
    await persistNoStart(true);
    return;
  }
  const closedTransport =
    // Unlike GUI logical inputs, pure autonomous commands have no logical
    // root to receive transport-end timestamps. The exact positive worker
    // no-start proof above is still required; closure alone never suffices.
    (!root.terminalEvidence ||
      isNativeTransportClosure(root.terminalEvidence)) &&
    ((root.status === "rejected" && root.rejectionCode === "not-dispatched") ||
      (root.status === "uncertain" &&
        root.rejectionCode === "missing-native-receipt"));
  if (
    (root.status !== "accepted" && !closedTransport) ||
    (!closedTransport &&
      (root.logicalCompletedAt ||
        root.executionCompletedAt ||
        root.terminalEvidence)) ||
    (!closedTransport && (!sameActivation || !activation?.active)) ||
    (sameActivation &&
      activation &&
      (activation.logicalCancelled ||
        activation.runtimeGeneration !== session.runtimeGeneration ||
        (activation.nativeTurnId &&
          activation.nativeTurnId !== expected.turnId)))
  )
    fail();
  if (
    !closedTransport &&
    !(await lanes
      .inTransaction(tx)
      .finishChatExecutionLane(root.chatId, root.executionLaneId!, "idle", {
        markUnreadCompletion: false,
      }))
  )
    fail();
  await persistNoStart();
  await tx
    .update(schema.nativeCommandActivations)
    .set({ active: false })
    .where(
      and(
        eq(schema.nativeCommandActivations.chatId, root.chatId),
        eq(
          schema.nativeCommandActivations.generation,
          root.activationGeneration!,
        ),
        eq(schema.nativeCommandActivations.operationId, root.operationId),
      ),
    );
  if (goalClaim) {
    const updated = await tx
      .update(schema.managedQueueClaims)
      .set({ goalOperationId: null, goalOperationGeneration: null })
      .where(
        and(
          eq(schema.managedQueueClaims.id, goalClaim.id),
          eq(schema.managedQueueClaims.goalOperationId, root.operationId),
          eq(
            schema.managedQueueClaims.goalOperationGeneration,
            root.operationGeneration,
          ),
        ),
      )
      .returning({ id: schema.managedQueueClaims.id });
    if (updated.length !== 1) fail();
    await queueStateChanged(tx, root.chatId);
  }
  await completeRecoveredGoalWithdrawal(tx, root);
}

/** Called only after the exact journal withdrawal and native invalidation ACK.
 * The destination must not inherit a marker still owned by its sealed source.
 * Preserve the logical source across transfers without rewriting its receipt. */
async function completeRecoveredGoalWithdrawal(
  tx: RepositoryTransaction,
  root: Command,
): Promise<void> {
  const [state] = await tx
    .select({ recovery: schema.managedQueueStates.goalRecovery })
    .from(schema.managedQueueStates)
    .where(eq(schema.managedQueueStates.chatId, root.chatId));
  if (!state?.recovery) return;
  const marker = nativeGoalRecoverySchema.parse(state.recovery);
  if (
    marker.admission?.operationId !== root.operationId ||
    marker.admission.operationGeneration !== root.operationGeneration
  )
    return;
  const intent = root.intent as NativeCommandAdmission["intent"];
  if (
    !isDeepStrictEqual(intent.goalRecovery, marker.source) ||
    intent.workerGeneration !== marker.admission.workerGeneration
  )
    fail();
  await tx
    .update(schema.nativeCommands)
    .set({ goalRecoverySource: marker.source })
    .where(eq(schema.nativeCommands.operationId, root.operationId));
  await tx
    .update(schema.managedQueueStates)
    .set({ goalRecovery: { source: marker.source, admission: null } })
    .where(eq(schema.managedQueueStates.chatId, root.chatId));
  await queueStateChanged(tx, root.chatId);
}
