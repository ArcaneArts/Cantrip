import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  nativeGoalRecoverySchema,
  type NativeCommandAdmission,
  type NativeCommandSession,
  type NativeGoalRecovery,
  type NativeGoalRecoverySource,
  type NativeGoalRecoveryReceipt,
  type NativeInferenceRecovery,
  type NativeInferenceRecoveryResult,
  type NativeGoalRecoveryFence,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase, RepositoryTransaction } from "./database.js";
import type { ChatExecutionLaneRepository } from "./chat-execution-lanes.js";
import {
  nativeCommandContext,
  readNativeCommand,
  samePlacement,
  sameRuntimeRoute,
} from "./native-command-context.js";
import { lockNativeCommandChat } from "./native-command-lock.js";
import { NativeCommandError } from "./native-command-errors.js";
import { autonomousHandoffAttempt } from "./native-handoff-autonomous-source.js";
import { isNativeTransportClosure } from "./native-transport-evidence.js";
import { queueStateChanged } from "./native-command-queue.js";

type Command = typeof schema.nativeCommands.$inferSelect;

export async function readGoalRecovery(
  tx: RepositoryTransaction,
  chatId: string,
): Promise<NativeGoalRecovery | null> {
  const [state] = await tx
    .select({ recovery: schema.managedQueueStates.goalRecovery })
    .from(schema.managedQueueStates)
    .where(eq(schema.managedQueueStates.chatId, chatId));
  return state?.recovery
    ? nativeGoalRecoverySchema.parse(state.recovery)
    : null;
}

/** No journal reference is invented for an admission-before-enqueue crash.
 * Marker membership revokes canonical dispatch; the caller has separately
 * established actual replacement-worker ownership before issuing this call. */
export async function fenceGoalRecoveryAdmission(
  database: RepositoryDatabase,
  lanes: ChatExecutionLaneRepository,
  ownerId: string,
  input: NativeGoalRecoveryFence,
): Promise<{ recovery: NativeGoalRecovery | null }> {
  return database.transaction(async (tx) => {
    const captured = await readNativeCommand(
      tx,
      ownerId,
      input.workerId,
      input.admission.operationId,
      input.admission.operationGeneration,
    );
    await lockNativeCommandChat(tx, ownerId, captured.chatId);
    const marker = await readGoalRecovery(tx, captured.chatId);
    if (
      !marker ||
      !isDeepStrictEqual(marker.source, input.source) ||
      !isDeepStrictEqual(marker.admission, input.admission) ||
      input.admission.workerGeneration === input.workerGeneration
    )
      return { recovery: marker };
    if (!(await goalRecoveryUnblocked(tx, captured.chatId)))
      throw new NativeCommandError("goal-recovery-ineligible");
    const row = await readNativeCommand(
      tx,
      ownerId,
      input.workerId,
      input.admission.operationId,
      input.admission.operationGeneration,
    );
    const intent = row.intent as NativeCommandAdmission["intent"];
    const original =
      row.operationId === marker.source.operationId &&
      row.operationGeneration === marker.source.operationGeneration &&
      !intent.goalRecovery;
    if (
      intent.workerGeneration !== input.admission.workerGeneration ||
      (!original && !isDeepStrictEqual(intent.goalRecovery, marker.source)) ||
      !(await retireUnusedGoal(tx, lanes, row, marker.source, {
        kind: "not-dispatched",
        source: "canonical-goal-recovery",
        admission: input.admission,
        fencedByWorkerGeneration: input.workerGeneration,
      }))
    )
      throw new NativeCommandError("goal-recovery-source-unsettled");
    const recovery: NativeGoalRecovery = {
      source: marker.source,
      admission: null,
    };
    await tx
      .update(schema.managedQueueStates)
      .set({ goalRecovery: recovery })
      .where(eq(schema.managedQueueStates.chatId, row.chatId));
    await queueStateChanged(tx, row.chatId);
    return { recovery };
  });
}

function recoveredSource(row: Command): NativeGoalRecoverySource | undefined {
  if (row.goalRecoverySource) return row.goalRecoverySource;
  const evidence = row.terminalEvidence as {
    recoveryKind?: unknown;
    goalRecovery?: NativeGoalRecoverySource;
  } | null;
  return evidence?.recoveryKind === "managed-goal"
    ? evidence.goalRecovery
    : undefined;
}

async function goalRecoveryUnblocked(
  tx: RepositoryTransaction,
  chatId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.chats.id })
    .from(schema.chats)
    .where(
      and(
        eq(schema.chats.id, chatId),
        sql`NOT EXISTS (SELECT 1 FROM native_runtime_handoffs h WHERE h.chat_id = ${chatId} AND h.phase IN ('preparing','prepared','committed'))`,
        sql`NOT EXISTS (SELECT 1 FROM native_settings_states s WHERE s.chat_id = ${chatId} AND (
      EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(s.state->'pending','[]'::jsonb)) p WHERE p->'intent'->'permissionTransition' IS NOT NULL)
      OR (s.state->>'desiredStatus' = 'uncertain' AND s.state->'desired'->'permissionTransition' IS NOT NULL)))`,
      ),
    );
  return Boolean(row);
}

/** Positive no-input authority plus actual replacement-worker fencing is
 * required by the caller. Missing turn history is only a contradiction check. */
async function retireUnusedGoal(
  tx: RepositoryTransaction,
  lanes: ChatExecutionLaneRepository,
  row: Command,
  source: NativeGoalRecoverySource,
  evidence: Record<string, unknown>,
): Promise<boolean> {
  const attempt = autonomousHandoffAttempt(row);
  if (!attempt || attempt.goalEpoch !== source.goalEpoch) return false;
  const reserved = isDeepStrictEqual(recoveredSource(row), source);
  if (reserved && row.executionCompletedAt) return true;
  const closed =
    (!row.terminalEvidence || isNativeTransportClosure(row.terminalEvidence)) &&
    ((row.status === "rejected" && row.rejectionCode === "not-dispatched") ||
      (row.status === "uncertain" &&
        row.rejectionCode === "missing-native-receipt"));
  if (
    (row.status !== "accepted" && !closed && !reserved) ||
    (!reserved &&
      (row.resultDigest ||
        row.protectedResult ||
        row.terminalResultDigest ||
        row.protectedTerminalResult)) ||
    (!closed &&
      !reserved &&
      (row.logicalCompletedAt ||
        row.executionCompletedAt ||
        row.terminalEvidence)) ||
    !row.executionLaneId ||
    !row.activationGeneration
  )
    return false;
  const [observed] = await tx
    .select({ id: schema.nativeCommandTurns.operationId })
    .from(schema.nativeCommandTurns)
    .where(eq(schema.nativeCommandTurns.operationId, row.operationId))
    .limit(1);
  if (observed) return false;
  const [activation] = await tx
    .select()
    .from(schema.nativeCommandActivations)
    .where(eq(schema.nativeCommandActivations.chatId, row.chatId));
  const same =
    activation?.generation === row.activationGeneration &&
    activation.operationId === row.operationId &&
    activation.executionLaneId === row.executionLaneId;
  if (
    (!closed && (!same || !activation?.active)) ||
    (activation?.active && !same) ||
    (same &&
      (activation.logicalCancelled ||
        activation.runtimeGeneration !==
          (row.identity as NativeCommandSession).runtimeGeneration ||
        (activation.nativeTurnId &&
          activation.nativeTurnId !== attempt.turnId)))
  )
    return false;
  const claims = await tx
    .select()
    .from(schema.managedQueueClaims)
    .where(
      and(
        eq(schema.managedQueueClaims.chatId, row.chatId),
        inArray(schema.managedQueueClaims.status, [
          "claimed",
          "accepted",
          "dispatched",
          "uncertain",
        ]),
      ),
    )
    .limit(2);
  const claim = claims[0];
  if (
    claims.length > 1 ||
    (claim &&
      (!claim.awaitingGoal ||
        claim.goalEpoch !== source.goalEpoch ||
        claim.goalOperationId !== row.operationId ||
        claim.goalOperationGeneration !== row.operationGeneration ||
        claim.nativeTurnId ||
        !["dispatched", "uncertain"].includes(claim.status) ||
        !claim.operationId ||
        !claim.operationGeneration))
  )
    return false;
  if (claim) {
    const [parent] = await tx
      .select()
      .from(schema.nativeCommands)
      .where(
        and(
          eq(schema.nativeCommands.operationId, claim.operationId!),
          eq(
            schema.nativeCommands.operationGeneration,
            claim.operationGeneration!,
          ),
          eq(schema.nativeCommands.ownerId, row.ownerId),
          eq(schema.nativeCommands.workerId, row.workerId),
          eq(schema.nativeCommands.chatId, row.chatId),
        ),
      );
    const [prompt] = await tx
      .select()
      .from(schema.queuedPrompts)
      .where(
        and(
          eq(schema.queuedPrompts.id, claim.promptId),
          eq(schema.queuedPrompts.chatId, row.chatId),
          eq(schema.queuedPrompts.revision, claim.promptRevision),
          eq(schema.queuedPrompts.state, "claimed"),
        ),
      );
    if (
      !parent ||
      parent.method !== "thread/goal/set" ||
      parent.status !== "applied" ||
      !prompt
    )
      return false;
  }
  if (
    same &&
    activation?.active &&
    !(await lanes
      .inTransaction(tx)
      .finishChatExecutionLane(row.chatId, row.executionLaneId, "idle", {
        markUnreadCompletion: false,
      }))
  )
    return false;
  const now = new Date();
  await tx
    .update(schema.nativeCommands)
    .set({
      ...(!reserved
        ? {
            status: "rejected" as const,
            rejectionCode: "worker-inference-deferred",
            terminalEvidence: {
              ...evidence,
              recoveryKind: "managed-goal",
              goalRecovery: source,
            },
          }
        : {}),
      goalRecoverySource: source,
      logicalCompletedAt: row.logicalCompletedAt ?? now,
      executionCompletedAt: row.executionCompletedAt ?? now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.nativeCommands.operationId, row.operationId),
        eq(schema.nativeCommands.operationGeneration, row.operationGeneration),
      ),
    );
  if (same)
    await tx
      .update(schema.nativeCommandActivations)
      .set({ active: false })
      .where(
        and(
          eq(schema.nativeCommandActivations.chatId, row.chatId),
          eq(
            schema.nativeCommandActivations.generation,
            row.activationGeneration,
          ),
          eq(schema.nativeCommandActivations.operationId, row.operationId),
        ),
      );
  // The applied setter, encrypted prompt, claim, revision and Goal epoch remain.
  if (claim)
    await tx
      .update(schema.managedQueueClaims)
      .set({ goalOperationId: null, goalOperationGeneration: null })
      .where(eq(schema.managedQueueClaims.id, claim.id));
  return true;
}

/** Called only from authenticated current-worker recovery after actual keeper
 * takeover. A reconstructed source stays on the marker until canonical dispatch.
 * Thus marker membership positively proves that it has not forwarded input. */
export async function reconcileUnstartedGoal(
  database: RepositoryDatabase,
  lanes: ChatExecutionLaneRepository,
  ownerId: string,
  input: NativeInferenceRecovery,
): Promise<NativeInferenceRecoveryResult> {
  const { record } = input;
  const identity = record.identity.recovery;
  const result: NativeInferenceRecoveryResult = {
    key: record.key,
    chatId: record.identity.chatId,
    disposition: "unresolved",
  };
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
    (record.workerGeneration === input.workerGeneration &&
      !(
        record.state === "released" &&
        ["never-started", "runtime-exited"].includes(record.outcome ?? "")
      )) ||
    key !== record.key ||
    record.nativeExecution ||
    !identity?.autonomousGoal ||
    identity.messageId ||
    identity.taskInput ||
    !identity.commandId ||
    !identity.commandGeneration ||
    !identity.threadId ||
    !identity.turnId ||
    record.identity.operationId !== identity.commandGeneration
  )
    return result;
  try {
    return await database.transaction(async (tx) => {
      const captured = await readNativeCommand(
        tx,
        ownerId,
        input.workerId,
        identity.commandId!,
        identity.commandGeneration!,
      );
      await lockNativeCommandChat(tx, ownerId, captured.chatId);
      const row = await readNativeCommand(
        tx,
        ownerId,
        input.workerId,
        identity.commandId!,
        identity.commandGeneration!,
      );
      const session = row.identity as NativeCommandSession;
      const attempt = autonomousHandoffAttempt(row);
      if (
        !attempt ||
        row.chatId !== record.identity.chatId ||
        session.threadId !== identity.threadId ||
        session.projectId !== record.identity.projectId ||
        attempt.turnId !== identity.turnId ||
        attempt.goalEpoch !== identity.autonomousGoal!.goalEpoch
      )
        return result;
      let marker = await readGoalRecovery(tx, row.chatId);
      const inherited = (row.intent as NativeCommandAdmission["intent"])
        .goalRecovery;
      const source = inherited ?? {
        operationId: row.operationId,
        operationGeneration: row.operationGeneration,
        threadId: identity.threadId!,
        goalEpoch: identity.autonomousGoal!.goalEpoch,
      };
      if (
        (inherited && !isDeepStrictEqual(marker?.source, source)) ||
        (marker && !isDeepStrictEqual(marker.source, source))
      )
        return { ...result, disposition: "retired" };
      const priorRecovery = recoveredSource(row);
      if (priorRecovery && !isDeepStrictEqual(priorRecovery, source))
        return result;
      if (priorRecovery && !marker)
        return { ...result, disposition: "retired" };
      if (
        row.logicalCompletedAt &&
        !priorRecovery &&
        !isNativeTransportClosure(row.terminalEvidence)
      )
        return { ...result, disposition: "retired" };
      const context = await nativeCommandContext(tx, ownerId, row.chatId);
      const [chat] = await tx
        .select()
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.id, row.chatId),
            eq(schema.chats.ownerId, ownerId),
          ),
        );
      const unblocked = await goalRecoveryUnblocked(tx, row.chatId);
      // A transfer still needs its exact worker withdrawal proof; a permission
      // transition owns its quiescent boundary. Neither becomes a restored head.
      if (!unblocked) return result;
      if (
        !samePlacement(context, input.workerId, session) ||
        !sameRuntimeRoute(context, session) ||
        context.threadId !== source.threadId ||
        !chat ||
        chat.archivedAt ||
        chat.managedAutonomyStopped
      )
        return { ...result, disposition: "retired" };
      const [route] = session.modelRouteId
        ? await tx
            .select({ providerId: schema.modelRoutes.providerId })
            .from(schema.modelRoutes)
            .where(eq(schema.modelRoutes.id, session.modelRouteId))
        : [];
      if (route?.providerId !== record.identity.providerId)
        return { ...result, disposition: "retired" };
      // Closure is not dispatch revocation. An unused durable waiter could not
      // reach dispatch; an ever-granted ambiguous closed attempt stays uncertain.
      if (!priorRecovery && row.status !== "accepted" && record.everGranted)
        return result;
      if (
        (!priorRecovery || !row.executionCompletedAt) &&
        !(await retireUnusedGoal(tx, lanes, row, source, {
          kind: "not-started",
          source: "worker-inference-journal",
          key: record.key,
          workerGeneration: record.workerGeneration,
          runtimeGeneration: record.identity.runtimeGeneration,
          revision: record.revision,
        }))
      )
        return result;
      marker ??= { source, admission: null };
      const admitted = marker.admission;
      if (admitted && admitted.workerGeneration !== input.workerGeneration) {
        // An older alias may predate this physical source. Obtain a fresh actual
        // keeper read AFTER learning its unpredictable identity, then compare
        // it under this same chat lock. Stale recovery cannot revoke a new owner.
        if (!isDeepStrictEqual(input.expectedGoalAdmission, admitted))
          return { ...result, goalOwnershipChallenge: admitted };
        const current = await readNativeCommand(
          tx,
          ownerId,
          input.workerId,
          admitted.operationId,
          admitted.operationGeneration,
        );
        const intent = current.intent as NativeCommandAdmission["intent"];
        if (
          intent.workerGeneration !== admitted.workerGeneration ||
          !isDeepStrictEqual(intent.goalRecovery, source) ||
          !(await retireUnusedGoal(tx, lanes, current, source, {
            kind: "not-dispatched",
            source: "canonical-goal-recovery",
            admission: admitted,
            fencedByWorkerGeneration: input.workerGeneration,
          }))
        )
          return result;
        marker = { source, admission: null };
      }
      const existing = await readGoalRecovery(tx, row.chatId);
      if (!isDeepStrictEqual(existing, marker)) {
        await tx
          .insert(schema.managedQueueStates)
          .values({ chatId: row.chatId, goalRecovery: marker })
          .onConflictDoUpdate({
            target: schema.managedQueueStates.chatId,
            set: { goalRecovery: marker },
          });
        await queueStateChanged(tx, row.chatId);
      }
      return {
        ...result,
        disposition: chat.automationPaused ? "retired" : "requeued",
        goalInputNotDispatched: true,
      };
    });
  } catch (error) {
    if (
      error instanceof NativeCommandError &&
      ["operation-not-found", "chat-not-found"].includes(error.code)
    )
      return { ...result, disposition: "retired" };
    throw error;
  }
}

/** The same chat lock owns marker association, canonical lane acquisition and
 * admission. A different input cannot overtake this already-eligible cycle. */
export async function assertGoalRecoveryAdmission(
  tx: RepositoryTransaction,
  input: NativeCommandAdmission,
): Promise<NativeGoalRecovery | null> {
  const marker = await readGoalRecovery(tx, input.session.chatId);
  const source = input.intent.goalRecovery;
  if (input.method !== "turn/start") {
    if (source) throw new NativeCommandError("invalid-goal-recovery");
    return null;
  }
  if (!marker && !source) return null;
  if (
    !marker ||
    !source ||
    !isDeepStrictEqual(marker.source, source) ||
    input.origin !== "autonomous" ||
    input.intent.autonomousAttempt?.goalEpoch !== source.goalEpoch ||
    input.session.threadId !== source.threadId ||
    !input.intent.workerGeneration
  )
    throw new NativeCommandError("stale-goal-recovery");
  if (marker.admission)
    throw new NativeCommandError("goal-recovery-already-admitted");
  const [chat] = await tx
    .select({
      paused: schema.chats.automationPaused,
      stopped: schema.chats.managedAutonomyStopped,
    })
    .from(schema.chats)
    .where(eq(schema.chats.id, input.session.chatId));
  if (!chat || chat.paused || chat.stopped)
    throw new NativeCommandError("goal-recovery-ineligible");
  return marker;
}

export async function recordGoalRecoveryAdmission(
  tx: RepositoryTransaction,
  input: NativeCommandAdmission,
  row: Command,
): Promise<void> {
  if (row.status !== "accepted" || !input.intent.goalRecovery) return;
  const marker = await readGoalRecovery(tx, row.chatId);
  if (
    !marker ||
    marker.admission ||
    !input.intent.workerGeneration ||
    !isDeepStrictEqual(marker.source, input.intent.goalRecovery)
  )
    throw new NativeCommandError("stale-goal-recovery");
  await tx
    .update(schema.managedQueueStates)
    .set({
      goalRecovery: {
        source: marker.source,
        admission: {
          operationId: row.operationId,
          operationGeneration: row.operationGeneration,
          workerGeneration: input.intent.workerGeneration,
        },
      },
    })
    .where(eq(schema.managedQueueStates.chatId, row.chatId));
}

/** Actual worker ticket adoption precedes this dispatch. Clearing here, in the
 * same transaction as dispatch, closes the admission-before-journal crash gap. */
export async function dispatchGoalRecovery(
  tx: RepositoryTransaction,
  row: Command,
  workerGeneration: string | undefined,
): Promise<void> {
  const intent = row.intent as NativeCommandAdmission["intent"];
  if (!intent.goalRecovery) return;
  const marker = await readGoalRecovery(tx, row.chatId);
  const [chat] = await tx
    .select({
      paused: schema.chats.automationPaused,
      stopped: schema.chats.managedAutonomyStopped,
    })
    .from(schema.chats)
    .where(eq(schema.chats.id, row.chatId));
  if (
    !marker ||
    !isDeepStrictEqual(marker.source, intent.goalRecovery) ||
    marker.admission?.operationId !== row.operationId ||
    marker.admission.operationGeneration !== row.operationGeneration ||
    !workerGeneration ||
    marker.admission.workerGeneration !== workerGeneration ||
    intent.workerGeneration !== workerGeneration ||
    !chat ||
    chat.paused ||
    chat.stopped
  )
    throw new NativeCommandError("stale-goal-recovery");
  await tx
    .update(schema.managedQueueStates)
    .set({ goalRecovery: null })
    .where(eq(schema.managedQueueStates.chatId, row.chatId));
  await queueStateChanged(tx, row.chatId);
}

/** Canonical acceptance is positive no-dispatch authority. Reserve recovery at
 * the first negative receipt, but retain its child until physical completion.
 * Otherwise generic partial settlement would reject the applied setter's claim
 * before the final native receipt can return that exact child to its producer. */
export async function settleGoalRecoveryBeforeDispatch(
  tx: RepositoryTransaction,
  row: Command,
  before: Command,
): Promise<boolean> {
  if (!["rejected", "uncertain"].includes(row.status)) return false;
  const intent = row.intent as NativeCommandAdmission["intent"];
  let marker = await readGoalRecovery(tx, row.chatId);
  if (!marker && !intent.goalRecovery && before.status === "accepted") {
    const attempt = autonomousHandoffAttempt(row);
    const session = row.identity as NativeCommandSession;
    const [chat] = await tx
      .select()
      .from(schema.chats)
      .where(eq(schema.chats.id, row.chatId));
    if (
      !attempt?.goalEpoch ||
      !session.threadId ||
      !intent.workerGeneration ||
      !chat ||
      chat.archivedAt ||
      chat.managedAutonomyStopped
    )
      return false;
    marker = {
      source: {
        operationId: row.operationId,
        operationGeneration: row.operationGeneration,
        threadId: session.threadId,
        goalEpoch: attempt.goalEpoch,
      },
      admission: {
        operationId: row.operationId,
        operationGeneration: row.operationGeneration,
        workerGeneration: intent.workerGeneration,
      },
    };
    await tx
      .insert(schema.managedQueueStates)
      .values({ chatId: row.chatId })
      .onConflictDoNothing();
  }
  if (
    !marker ||
    (intent.goalRecovery &&
      !isDeepStrictEqual(marker.source, intent.goalRecovery)) ||
    marker.admission?.operationId !== row.operationId ||
    marker.admission.operationGeneration !== row.operationGeneration
  )
    return false;
  const attempt = autonomousHandoffAttempt(row);
  if (!attempt || attempt.goalEpoch !== marker.source.goalEpoch)
    throw new NativeCommandError("stale-goal-recovery");
  const [observed] = await tx
    .select({ id: schema.nativeCommandTurns.operationId })
    .from(schema.nativeCommandTurns)
    .where(eq(schema.nativeCommandTurns.operationId, row.operationId))
    .limit(1);
  if (observed) throw new NativeCommandError("stale-goal-recovery");
  const claims = await tx
    .select()
    .from(schema.managedQueueClaims)
    .where(
      and(
        eq(schema.managedQueueClaims.goalOperationId, row.operationId),
        eq(
          schema.managedQueueClaims.goalOperationGeneration,
          row.operationGeneration,
        ),
      ),
    );
  for (const claim of claims) {
    if (
      !claim.awaitingGoal ||
      claim.chatId !== row.chatId ||
      claim.goalEpoch !== marker.source.goalEpoch ||
      claim.nativeTurnId ||
      !["dispatched", "uncertain"].includes(claim.status)
    )
      throw new NativeCommandError("stale-goal-recovery");
    if (row.executionCompletedAt)
      await tx
        .update(schema.managedQueueClaims)
        .set({ goalOperationId: null, goalOperationGeneration: null })
        .where(eq(schema.managedQueueClaims.id, claim.id));
  }
  // Keep terminalEvidence/protected results unchanged: a late retry must still
  // observe the same immutable native settlement instead of receipt-conflict.
  await tx
    .update(schema.nativeCommands)
    .set({ goalRecoverySource: marker.source })
    .where(eq(schema.nativeCommands.operationId, row.operationId));
  await tx
    .update(schema.managedQueueStates)
    .set({
      goalRecovery: {
        source: marker.source,
        admission: row.executionCompletedAt ? null : marker.admission,
      },
    })
    .where(eq(schema.managedQueueStates.chatId, row.chatId));
  await queueStateChanged(tx, row.chatId);
  return true;
}

/** Called after a response from the actual current worker connection. It
 * acknowledges ownership, never capacity; stale responses cannot remove a
 * newer admission or a superseding recovery marker. */
export async function confirmGoalRecoveryReceipt(
  tx: RepositoryTransaction,
  ownerId: string,
  chatId: string,
  receipt: NativeGoalRecoveryReceipt,
): Promise<void> {
  const marker = await readGoalRecovery(tx, chatId);
  if (!marker || !isDeepStrictEqual(marker.source, receipt.source)) return;
  if (receipt.status === "admitted") {
    if (!isDeepStrictEqual(marker.admission, receipt.admission))
      throw new NativeCommandError("stale-goal-recovery");
    const [row] = await tx
      .select()
      .from(schema.nativeCommands)
      .where(
        and(
          eq(schema.nativeCommands.ownerId, ownerId),
          eq(schema.nativeCommands.chatId, chatId),
          eq(schema.nativeCommands.operationId, receipt.admission.operationId),
          eq(
            schema.nativeCommands.operationGeneration,
            receipt.admission.operationGeneration,
          ),
        ),
      );
    if (
      !row ||
      row.status !== "accepted" ||
      row.executionCompletedAt ||
      !isDeepStrictEqual(
        (row.intent as NativeCommandAdmission["intent"]).goalRecovery,
        receipt.source,
      )
    )
      throw new NativeCommandError("stale-goal-recovery");
    return;
  }
  if (receipt.reason === "source-changed") return;
  if (receipt.reason === "paused") {
    const [chat] = await tx
      .select({ paused: schema.chats.automationPaused })
      .from(schema.chats)
      .where(eq(schema.chats.id, chatId));
    if (!chat?.paused) throw new NativeCommandError("stale-goal-recovery");
    return;
  }
  if (marker.admission)
    throw new NativeCommandError("goal-recovery-already-admitted");
  await tx
    .update(schema.managedQueueStates)
    .set({ goalRecovery: null })
    .where(eq(schema.managedQueueStates.chatId, chatId));
  const cancelled = await tx
    .update(schema.managedQueueClaims)
    .set({ status: "rejected" })
    .where(
      and(
        eq(schema.managedQueueClaims.chatId, chatId),
        eq(schema.managedQueueClaims.awaitingGoal, true),
        eq(schema.managedQueueClaims.goalEpoch, receipt.source.goalEpoch),
        isNull(schema.managedQueueClaims.goalOperationId),
        inArray(schema.managedQueueClaims.status, ["dispatched", "uncertain"]),
      ),
    )
    .returning();
  for (const claim of cancelled)
    await tx
      .update(schema.queuedPrompts)
      .set({ state: "pending" })
      .where(
        and(
          eq(schema.queuedPrompts.id, claim.promptId),
          eq(schema.queuedPrompts.revision, claim.promptRevision),
          eq(schema.queuedPrompts.state, "claimed"),
        ),
      );
  await queueStateChanged(tx, chatId);
}
