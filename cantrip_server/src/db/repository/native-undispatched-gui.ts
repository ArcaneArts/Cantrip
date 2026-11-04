import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  inferenceNeverStarted,
  type InferenceJournalRecord,
  type NativeCommandAdmission,
  type NativeCommandSession,
  type NativeInferenceRecovery,
  type NativeInferenceRecoveryResult,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase, RepositoryTransaction } from "./database.js";
import type { ChatExecutionLaneRepository } from "./chat-execution-lanes.js";
import { readNativeCommand } from "./native-command-context.js";
import { lockNativeCommandChat } from "./native-command-lock.js";
import { queueStateChanged } from "./native-command-queue.js";
import { NativeCommandError } from "./native-command-errors.js";
import { managedQueueRecoveryEligible } from "./managed-queue.js";
import { isNativeTransportClosure } from "./native-transport-evidence.js";

/** Server-internal compensation for a command the limiter DID NOT delegate.
 * Never call this for worker errors, timeouts, missing output or lost sockets. */
export function deferUndispatchedGui(
  database: RepositoryDatabase,
  lanes: ChatExecutionLaneRepository,
  ownerId: string,
  workerId: string,
  operationId: string,
  generation: string,
): Promise<boolean> {
  return database.transaction((tx) =>
    deferGuiBeforeExecution(
      tx,
      lanes,
      ownerId,
      workerId,
      operationId,
      generation,
    ),
  );
}

async function deferGuiBeforeExecution(
  tx: RepositoryTransaction,
  lanes: ChatExecutionLaneRepository,
  ownerId: string,
  workerId: string,
  operationId: string,
  generation: string,
  proof?: InferenceJournalRecord,
): Promise<boolean> {
  const rejectionCode = proof
    ? "worker-inference-deferred"
    : "worker-transport-deferred";
  const captured = await readNativeCommand(
    tx,
    ownerId,
    workerId,
    operationId,
    generation,
  );
  await lockNativeCommandChat(tx, ownerId, captured.chatId);
  const row = await readNativeCommand(
    tx,
    ownerId,
    workerId,
    operationId,
    generation,
  );
  if (row.rejectionCode === rejectionCode && row.logicalCompletedAt)
    return true;
  const closedTransport = Boolean(
    proof &&
    row.logicalCompletedAt &&
    row.executionCompletedAt &&
    isNativeTransportClosure(row.terminalEvidence) &&
    ((row.status === "rejected" && row.rejectionCode === "not-dispatched") ||
      (row.status === "uncertain" &&
        row.rejectionCode === "missing-native-receipt")),
  );
  if (
    row.origin !== "gui" ||
    row.kind !== "start" ||
    row.method !== "turn/start" ||
    (row.status !== "accepted" && !closedTransport) ||
    row.logicalOperationId !== row.operationId ||
    row.previousOperationId ||
    (row.logicalCompletedAt && !closedTransport) ||
    (row.executionCompletedAt && !closedTransport) ||
    row.resultDigest ||
    row.terminalResultDigest ||
    row.protectedResult ||
    row.protectedTerminalResult ||
    (row.terminalEvidence && !closedTransport) ||
    !row.executionLaneId ||
    !row.activationGeneration
  )
    return false;
  const [activation] = await tx
    .select()
    .from(schema.nativeCommandActivations)
    .where(eq(schema.nativeCommandActivations.chatId, row.chatId));
  const [claim] = await tx
    .select()
    .from(schema.managedQueueClaims)
    .where(
      and(
        eq(schema.managedQueueClaims.operationId, operationId),
        eq(schema.managedQueueClaims.operationGeneration, generation),
      ),
    );
  // Consumption evidence contradicts either positive no-start proof. Missing
  // notifications alone never authorize returning a prompt to the queue.
  const [observed] = await tx
    .select({ id: schema.nativeCommandTurns.operationId })
    .from(schema.nativeCommandTurns)
    .where(eq(schema.nativeCommandTurns.operationId, operationId))
    .limit(1);
  const sameActivation =
    activation?.generation === row.activationGeneration &&
    activation?.operationId === operationId &&
    activation?.executionLaneId === row.executionLaneId;
  if (
    (!closedTransport && (!activation?.active || !sameActivation)) ||
    (sameActivation &&
      activation &&
      (activation.logicalCancelled ||
        (activation.nativeTurnId &&
          (!proof ||
            activation.nativeTurnId !==
              (row.intent as NativeCommandAdmission["intent"]).expectedTurnId ||
            (proof.identity.recovery?.turnId &&
              proof.identity.recovery.turnId !== activation.nativeTurnId))) ||
        (proof
          ? activation.runtimeGeneration !==
            (row.identity as NativeCommandSession).runtimeGeneration
          : activation.runtimeGeneration))) ||
    !claim ||
    (claim.status !== "accepted" &&
      !(
        closedTransport &&
        ["rejected", "uncertain", "dispatched"].includes(claim.status)
      )) ||
    claim.nativeTurnId ||
    observed
  )
    return false;
  const [prompt] = await tx
    .select()
    .from(schema.queuedPrompts)
    .where(eq(schema.queuedPrompts.id, claim.promptId));
  const removed = !prompt || ["removed", "consumed"].includes(prompt.state);
  if (
    !closedTransport &&
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
      status: "rejected",
      rejectionCode,
      terminalEvidence: proof
        ? {
            kind: "not-started",
            source: "worker-inference-journal",
            key: proof.key,
            workerGeneration: proof.workerGeneration,
            runtimeGeneration: proof.identity.runtimeGeneration,
            revision: proof.revision,
          }
        : {
            kind: "not-dispatched",
            source: "worker-command-admission",
          },
      logicalCompletedAt: now,
      executionCompletedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.nativeCommands.operationId, operationId),
        eq(schema.nativeCommands.operationGeneration, generation),
      ),
    );
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
        eq(schema.nativeCommandActivations.operationId, operationId),
      ),
    );
  await tx
    .update(schema.managedQueueClaims)
    .set({ status: removed ? "rejected" : "deferred" })
    .where(eq(schema.managedQueueClaims.id, claim.id));
  if (!removed)
    await tx
      .update(schema.queuedPrompts)
      .set({ state: "pending", updatedAt: now })
      .where(eq(schema.queuedPrompts.id, claim.promptId));
  await queueStateChanged(tx, row.chatId);
  return true;
}

/** Called only by the currently authenticated replacement worker after its
 * native scope takeover has fenced previous-generation execution. */
export async function reconcileUnstartedGui(
  database: RepositoryDatabase,
  lanes: ChatExecutionLaneRepository,
  ownerId: string,
  input: NativeInferenceRecovery,
): Promise<NativeInferenceRecoveryResult> {
  const { record } = input;
  const identity = record.identity.recovery;
  const unresolved: NativeInferenceRecoveryResult = {
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
    record.workerGeneration === input.workerGeneration ||
    key !== record.key ||
    !inferenceNeverStarted(record) ||
    !identity?.commandId ||
    !identity.commandGeneration ||
    !identity.messageId ||
    record.identity.operationId !== identity.commandGeneration
  )
    return unresolved;
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
      if (
        row.chatId !== record.identity.chatId ||
        row.logicalClientMessageId !== identity.messageId ||
        (identity.threadId &&
          (row.identity as NativeCommandSession).threadId !== identity.threadId)
      )
        return unresolved;
      if (
        row.logicalCompletedAt &&
        !isNativeTransportClosure(row.terminalEvidence) &&
        (row.rejectionCode !== "worker-inference-deferred" ||
          !row.terminalEvidence ||
          typeof row.terminalEvidence !== "object" ||
          !("key" in row.terminalEvidence) ||
          row.terminalEvidence.key !== record.key)
      )
        return { ...unresolved, disposition: "retired" };
      if (
        !(await deferGuiBeforeExecution(
          tx,
          lanes,
          ownerId,
          input.workerId,
          row.operationId,
          row.operationGeneration,
          record,
        ))
      )
        return unresolved;
      const [claim] = await tx
        .select()
        .from(schema.managedQueueClaims)
        .where(
          and(
            eq(schema.managedQueueClaims.operationId, row.operationId),
            eq(
              schema.managedQueueClaims.operationGeneration,
              row.operationGeneration,
            ),
          ),
        );
      const [prompt] = claim
        ? await tx
            .select()
            .from(schema.queuedPrompts)
            .where(eq(schema.queuedPrompts.id, claim.promptId))
        : [];
      return {
        ...unresolved,
        disposition:
          prompt &&
          (await managedQueueRecoveryEligible(
            tx,
            ownerId,
            input.workerId,
            row.chatId,
            prompt.id,
          ))
            ? "requeued"
            : "retired",
      };
    });
  } catch (error) {
    if (
      error instanceof NativeCommandError &&
      ["operation-not-found", "chat-not-found"].includes(error.code)
    )
      return { ...unresolved, disposition: "retired" };
    throw error;
  }
}
