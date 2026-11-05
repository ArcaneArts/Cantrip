import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { queuedPromptOpaqueContentSchema } from "@cantrip/protocol/communication-content";
import type {
  InferenceJournalRecord,
  NativeCommandSession,
  NativeRuntimeHandoffQueuedSource,
  NativeSettingsBinding,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryTransaction } from "./database.js";
import type { ChatExecutionLaneRepository } from "./chat-execution-lanes.js";
import { NativeCommandError } from "./native-command-errors.js";
import { readNativeCommand } from "./native-command-context.js";
import { deferGuiBeforeExecution } from "./native-undispatched-gui.js";
import {
  autonomousHandoffAttempt,
  confirmAutonomousHandoffSource,
} from "./native-handoff-autonomous-source.js";
import { captureHandoffGoalClaim } from "./native-handoff-goal-claim.js";

const pending = ["accepted", "dispatched", "uncertain"];
const fail = (): never => {
  throw new NativeCommandError("handoff-native-operation-pending");
};

/** Retarget only the original, unchanged standalone input. Later messages and
 * edits keep their own model choices. The encrypted content/AAD is unchanged. */
export async function retargetStandaloneHandoffInput(
  tx: RepositoryTransaction,
  chatId: string,
  source: NativeRuntimeHandoffQueuedSource,
  modelId: string,
): Promise<{ id: string; revision: number } | undefined> {
  const [item] = await tx
    .select({
      prompt: schema.queuedPrompts,
      revision: schema.managedQueueClaims.promptRevision,
    })
    .from(schema.managedQueueClaims)
    .innerJoin(
      schema.queuedPrompts,
      eq(schema.queuedPrompts.id, schema.managedQueueClaims.promptId),
    )
    .where(
      and(
        eq(schema.managedQueueClaims.chatId, chatId),
        eq(schema.managedQueueClaims.operationId, source.operationId),
        eq(
          schema.managedQueueClaims.operationGeneration,
          source.operationGeneration,
        ),
        eq(schema.managedQueueClaims.status, "deferred"),
        eq(schema.queuedPrompts.chatId, chatId),
        eq(schema.queuedPrompts.state, "pending"),
        eq(
          schema.queuedPrompts.revision,
          schema.managedQueueClaims.promptRevision,
        ),
      ),
    )
    .limit(1);
  if (!item) return undefined;
  const { prompt } = item;
  const revision = prompt.revision + 1;
  await tx
    .update(schema.queuedPrompts)
    .set({
      modelId,
      opaqueContent: prompt.opaqueContent
        ? queuedPromptOpaqueContentSchema.parse({
            ...prompt.opaqueContent,
            modelId,
          })
        : prompt.opaqueContent,
      revision,
      updatedAt: new Date(),
    })
    .where(eq(schema.queuedPrompts.id, prompt.id));
  return { id: prompt.id, revision };
}

/** Capture a candidate under the existing chat lock. Nothing here proves it
 * unstarted: the worker must seal the exact owner before any claim is deferred. */
export async function reserveHandoffQueuedSource(
  tx: RepositoryTransaction,
  source: NativeSettingsBinding,
): Promise<NativeRuntimeHandoffQueuedSource | null> {
  const lanes = await tx
    .select()
    .from(schema.chatExecutionLanes)
    .where(
      and(
        eq(schema.chatExecutionLanes.chatId, source.chatId),
        eq(schema.chatExecutionLanes.state, "active"),
      ),
    );
  const commands = await tx
    .select()
    .from(schema.nativeCommands)
    .where(
      and(
        eq(schema.nativeCommands.chatId, source.chatId),
        inArray(schema.nativeCommands.status, pending),
      ),
    );
  const claims = await tx
    .select()
    .from(schema.managedQueueClaims)
    .where(
      and(
        eq(schema.managedQueueClaims.chatId, source.chatId),
        inArray(schema.managedQueueClaims.status, ["claimed", ...pending]),
      ),
    );
  if (!lanes.length && !commands.length && !claims.length) return null;
  if (lanes.length !== 1 || commands.length !== 1) fail();
  const command = commands[0]!;
  const autonomousAttempt = autonomousHandoffAttempt(command);
  const goalClaim = autonomousAttempt
    ? await captureHandoffGoalClaim(tx, command, claims)
    : undefined;
  const session = command.identity as NativeCommandSession;
  if (
    command.status !== "accepted" ||
    command.kind !== "start" ||
    command.method !== "turn/start" ||
    command.previousOperationId ||
    command.logicalCompletedAt ||
    command.executionCompletedAt ||
    command.resultDigest ||
    command.protectedResult ||
    command.terminalResultDigest ||
    command.protectedTerminalResult ||
    command.terminalEvidence ||
    command.workerId !== source.workerId ||
    command.executionLaneId !== lanes[0]!.id ||
    session.chatId !== source.chatId ||
    session.threadId !== source.threadId ||
    session.runtimeGeneration !== source.runtimeGeneration ||
    session.modelRouteId !== source.modelRouteId ||
    session.providerAccountId !== source.providerAccountId ||
    session.contextKind !== source.contextKind ||
    session.projectId !== source.projectId ||
    session.placementId !== source.placementId
  )
    fail();
  if (autonomousAttempt) {
    if (claims.length && !goalClaim) fail();
  } else {
    const claim = claims[0];
    if (
      claims.length !== 1 ||
      !claim ||
      command.origin !== "gui" ||
      command.logicalOperationId !== command.operationId ||
      claim.status !== "accepted" ||
      claim.nativeTurnId ||
      claim.operationId !== command.operationId ||
      claim.operationGeneration !== command.operationGeneration
    )
      fail();
  }
  const consumed = await tx
    .select({ id: schema.nativeCommandTurns.operationId })
    .from(schema.nativeCommandTurns)
    .where(eq(schema.nativeCommandTurns.operationId, command.operationId))
    .limit(1);
  if (consumed.length) fail();
  return {
    operationId: command.operationId,
    operationGeneration: command.operationGeneration,
    withdrawn: false,
    ...(autonomousAttempt ? { autonomousAttempt } : {}),
    ...(goalClaim ? { goalClaim } : {}),
  };
}

/** The handoff reservation prevents a new queue claim while this transaction
 * returns the original encrypted prompt to the canonical queue. */
export async function confirmHandoffQueuedSource(
  tx: RepositoryTransaction,
  lanes: ChatExecutionLaneRepository,
  ownerId: string,
  workerId: string,
  source: NativeSettingsBinding,
  expected: NativeRuntimeHandoffQueuedSource,
  record: InferenceJournalRecord | null,
): Promise<void> {
  const root = await readNativeCommand(
    tx,
    ownerId,
    workerId,
    expected.operationId,
    expected.operationGeneration,
  );
  if (expected.autonomousAttempt) {
    await confirmAutonomousHandoffSource(
      tx,
      lanes,
      source,
      root,
      expected.autonomousAttempt,
      record,
      expected.goalClaim,
    );
    return;
  }
  if (
    root.chatId !== source.chatId ||
    root.logicalOperationId !== root.operationId ||
    root.previousOperationId
  )
    fail();
  const consumed = await tx
    .select({ id: schema.nativeCommandTurns.operationId })
    .from(schema.nativeCommandTurns)
    .where(eq(schema.nativeCommandTurns.operationId, root.operationId))
    .limit(1);
  if (consumed.length) fail();
  const evidence = root.terminalEvidence as Record<string, unknown> | null;
  const alreadyDeferred =
    root.status === "rejected" &&
    root.rejectionCode === "worker-inference-deferred" &&
    root.logicalCompletedAt &&
    root.executionCompletedAt &&
    evidence?.kind === "not-started" &&
    evidence.source === "worker-inference-journal";
  if (!record) {
    if (!alreadyDeferred) fail();
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
    record.identity.operationId !== expected.operationGeneration ||
    record.identity.chatId !== source.chatId ||
    (record.identity.projectId !== null &&
      record.identity.projectId !== source.projectId) ||
    identity?.commandId !== expected.operationId ||
    identity.commandGeneration !== expected.operationGeneration ||
    !identity.messageId ||
    identity.messageId !== root.logicalClientMessageId ||
    (identity.threadId && identity.threadId !== source.threadId) ||
    (alreadyDeferred && evidence?.key !== record.key)
  )
    fail();
  // Stop can settle this source while its positive withdrawal acknowledgement
  // is in flight. Preserve that cancellation; do not re-add its removed input.
  const [cancelled] = await tx
    .select({ id: schema.nativeCommands.operationId })
    .from(schema.nativeCommands)
    .innerJoin(
      schema.nativeCommandActivations,
      and(
        eq(schema.nativeCommandActivations.chatId, root.chatId),
        eq(
          schema.nativeCommandActivations.generation,
          root.activationGeneration!,
        ),
        eq(schema.nativeCommandActivations.logicalCancelled, true),
        eq(schema.nativeCommandActivations.active, false),
      ),
    )
    .innerJoin(
      schema.managedQueueClaims,
      and(
        eq(schema.managedQueueClaims.operationId, root.operationId),
        eq(
          schema.managedQueueClaims.operationGeneration,
          root.operationGeneration,
        ),
        eq(schema.managedQueueClaims.status, "rejected"),
      ),
    )
    .innerJoin(
      schema.queuedPrompts,
      and(
        eq(schema.queuedPrompts.id, schema.managedQueueClaims.promptId),
        inArray(schema.queuedPrompts.state, ["removed", "consumed"]),
      ),
    )
    .where(
      and(
        eq(schema.nativeCommands.operationId, root.operationId),
        eq(schema.nativeCommands.status, "rejected"),
      ),
    )
    .limit(1);
  if (cancelled && root.logicalCompletedAt && root.executionCompletedAt) return;
  if (
    !(await deferGuiBeforeExecution(
      tx,
      lanes,
      ownerId,
      workerId,
      expected.operationId,
      expected.operationGeneration,
      record,
    ))
  )
    fail();
}
