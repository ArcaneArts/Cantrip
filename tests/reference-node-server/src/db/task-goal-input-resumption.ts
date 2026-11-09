import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import {
  taskInferenceInputReceiptSchema,
  taskMessageOpaqueContentSchema,
  type TaskDispatchFence,
  type TaskTurnResumption,
} from "@cantrip/protocol";
import * as schema from "./schema.js";
import type {
  RepositoryDatabase,
  RepositoryTransaction,
} from "./repository/database.js";
import {
  NativeSuspensionRepository,
  sameNativeSuspensionSource,
} from "./repository/native-suspensions.js";
import { nativeCommandContext } from "./repository/native-command-context.js";
import { nativeTaskSuspensionContext } from "./repository/native-task-suspension-context.js";
import { assertTaskOperationDispatchFence } from "./task-operation-fence.js";
import { TaskDispatchConflictError } from "./task-dispatch.js";
import { taskCheckpointExecution } from "./task-input-execution-state.js";

export interface GoalResumptionRequest {
  resumption: TaskTurnResumption;
  lease: TaskDispatchFence;
  expectedInputRevision?: number;
}
function stale(): never {
  throw new TaskDispatchConflictError(
    "The saved Goal input or its native owner changed.",
    "stale-lease",
  );
}

async function readGoalResumption(
  tx: RepositoryTransaction,
  database: RepositoryDatabase,
  owner: string,
  input: GoalResumptionRequest,
) {
  const original = taskInferenceInputReceiptSchema.parse(
    input.resumption.source,
  );
  if (original.kind !== "goal") stale();
  await assertTaskOperationDispatchFence(
    tx,
    owner,
    original.chatId,
    original.dispatch.operationId,
    { kind: "leased", lease: input.lease },
  );
  const context = await nativeCommandContext(tx, owner, original.chatId);
  const source = context
    ? await nativeTaskSuspensionContext(tx, context)
    : null;
  const [chat] = await tx
    .select()
    .from(schema.chats)
    .where(eq(schema.chats.id, original.chatId));
  const [cycle] = await tx
    .select()
    .from(schema.taskDispatchCycles)
    .where(
      and(
        eq(schema.taskDispatchCycles.id, input.lease.cycleId),
        eq(schema.taskDispatchCycles.ownerId, owner),
        eq(schema.taskDispatchCycles.chatId, original.chatId),
      ),
    )
    .for("update");
  const state = cycle?.goalInput;
  const saved = await new NativeSuspensionRepository(database, tx).read(
    owner,
    original.chatId,
  );
  if (input.resumption.goalCycle) {
    const suspension = cycle?.goalCycleRecovery?.suspension;
    if (
      !cycle ||
      !source?.goalCycle ||
      !chat ||
      !state ||
      !suspension ||
      suspension.terminal ||
      !isDeepStrictEqual(source.goalCycle, input.resumption.goalCycle) ||
      !isDeepStrictEqual(source.goalCycle.parent, original) ||
      !isDeepStrictEqual(suspension.source, source.goalCycle) ||
      saved?.controlId !== input.resumption.controlId ||
      saved.phase !== "resuming" ||
      saved.action !== "resume" ||
      !isDeepStrictEqual(saved.checkpoint, input.resumption.checkpoint) ||
      !sameNativeSuspensionSource(
        source.context,
        chat,
        saved,
        source.taskRound,
        source.taskGoalCycle,
      ) ||
      (input.expectedInputRevision !== undefined &&
        chat.managedInputRevision !== input.expectedInputRevision)
    )
      stale();
    const checkpointActor = {
      ...source.nativeOwner,
      operationId: source.executionReceipt.operationId,
      operationGeneration: source.executionReceipt.operationId,
    };
    if (
      !isDeepStrictEqual(saved.actor, checkpointActor) ||
      saved.active?.threadId !== source.nativeExecution.threadId ||
      saved.active.turnId !== source.nativeExecution.turnId
    )
      stale();
    return {
      kind: "cycle" as const,
      original,
      state,
      saved,
      cycle,
      suspension,
      checkpointActor,
      checkpointExecution: source.nativeExecution,
    };
  }
  if (
    !source ||
    !chat ||
    !state ||
    state.terminal ||
    !state.publication ||
    !isDeepStrictEqual(state.receipt, original) ||
    saved?.controlId !== input.resumption.controlId ||
    saved.phase !== "resuming" ||
    saved.action !== "resume" ||
    !isDeepStrictEqual(saved.checkpoint, input.resumption.checkpoint) ||
    !sameNativeSuspensionSource(
      source.context,
      chat,
      saved,
      source.taskRound,
    ) ||
    (input.expectedInputRevision !== undefined &&
      chat.managedInputRevision !== input.expectedInputRevision)
  )
    stale();
  const checkpointOwner = taskCheckpointExecution(state);
  if (
    !checkpointOwner.nativeExecution ||
    !checkpointOwner.nativeOwner ||
    saved.actor?.operationId !== checkpointOwner.receipt.operationId ||
    saved.actor.operationGeneration !== checkpointOwner.receipt.operationId ||
    saved.actor.workerGeneration !==
      checkpointOwner.nativeOwner.workerGeneration ||
    saved.actor.runtimeGeneration !==
      checkpointOwner.nativeOwner.runtimeGeneration ||
    saved.active?.threadId !== checkpointOwner.nativeExecution.threadId ||
    saved.active.turnId !== checkpointOwner.nativeExecution.turnId
  )
    stale();
  return { kind: "input" as const, original, state, saved, checkpointOwner };
}

/** Rebuild result publication from the existing encrypted message. This does not
 * set a Goal, submit input or confer permission to run its saved prompt. */
export async function goalRestorationSource(
  database: RepositoryDatabase,
  owner: string,
  input: GoalResumptionRequest,
) {
  return database.transaction(async (tx) => {
    const read = await readGoalResumption(tx, database, owner, input);
    const { original, state } = read;
    const [message] = await tx
      .select()
      .from(schema.chatMessages)
      .where(
        and(
          eq(schema.chatMessages.id, original.clientMessageId),
          eq(schema.chatMessages.chatId, original.chatId),
        ),
      );
    if (!message) stale();
    return {
      publication:
        read.kind === "cycle"
          ? read.suspension.source.publication
          : state.publication!,
      message: taskMessageOpaqueContentSchema.parse({
        id: message.id,
        classification: {
          role: message.role,
          mode: message.mode,
          attachmentIds: message.taskAttachmentIds,
        },
        protectedContent: message.taskProtectedContent,
        reasoningEffort: message.reasoningEffort,
        idempotencyKey: message.idempotencyKey,
      }),
    };
  });
}

/** Advance only physical ownership under the explicitly resumed Task lease. */
export async function prepareGoalInputResumption(
  database: RepositoryDatabase,
  owner: string,
  input: GoalResumptionRequest,
) {
  return database.transaction(async (tx) => {
    const read = await readGoalResumption(tx, database, owner, input);
    const { original, saved } = read;
    const dispatch = {
      cycleId: input.lease.cycleId,
      operationId: input.lease.operationId,
      leaseOwner: input.lease.leaseOwner,
      fencingToken: input.lease.fencingToken,
    };
    if (read.kind === "cycle") {
      const prior = read.suspension.restoration;
      if (
        prior?.controlId === saved.controlId &&
        isDeepStrictEqual(prior.receipt.dispatch, dispatch)
      )
        return prior.receipt;
      const receipt = taskInferenceInputReceiptSchema.parse({
        ...original,
        operationId: randomUUID(),
        dispatch,
        modelRouteId: read.suspension.source.cycle.modelRouteId,
        providerId: read.cycle.goalCycleRecovery!.providerId,
        providerAccountId: read.suspension.source.cycle.providerAccountId,
      });
      await tx
        .update(schema.taskDispatchCycles)
        .set({
          goalCycleRecovery: {
            ...read.cycle.goalCycleRecovery!,
            suspension: {
              ...read.suspension,
              restoration: {
                controlId: saved.controlId,
                receipt,
                accepted: false,
                dispatched: false,
                checkpointActor: read.checkpointActor,
                checkpointExecution: read.checkpointExecution,
              },
            },
          },
        })
        .where(eq(schema.taskDispatchCycles.id, input.lease.cycleId));
      return receipt;
    }
    const { state, checkpointOwner } = read;
    if (
      state.resumption?.controlId === saved.controlId &&
      isDeepStrictEqual(state.resumption.receipt.dispatch, dispatch)
    )
      return state.resumption.receipt;
    const receipt = taskInferenceInputReceiptSchema.parse({
      ...original,
      operationId: randomUUID(),
      dispatch,
    });
    await tx
      .update(schema.taskDispatchCycles)
      .set({
        goalInput: {
          ...state,
          resumption: {
            controlId: saved.controlId,
            receipt,
            accepted: false,
            dispatched: false,
            checkpointOwner: {
              receipt: checkpointOwner.receipt,
              nativeExecution: checkpointOwner.nativeExecution!,
              nativeOwner: checkpointOwner.nativeOwner!,
            },
          },
        },
      })
      .where(eq(schema.taskDispatchCycles.id, input.lease.cycleId));
    return receipt;
  });
}
