import type {
  NativeCommandAdmission,
  NativeCommandDispatch,
  NativeCommandSession,
  NativeCommandSettlement,
} from "@cantrip/protocol";
import type * as schema from "../schema.js";
import { NativeCommandError } from "./native-command-errors.js";
import { NativeSuspensionRepository } from "./native-suspensions.js";

type Command = typeof schema.nativeCommands.$inferSelect;

export async function assertSuspensionTerminalProof(
  repository: NativeSuspensionRepository,
  owner: string,
  row: Command,
  input: NativeCommandSettlement,
): Promise<void> {
  if (
    !input.executionComplete ||
    row.kind !== "start" ||
    input.deferred ||
    input.decline ||
    input.reconciliation?.terminalStatus
  )
    return;
  const state = await repository.read(owner, row.chatId);
  if (
    state?.active &&
    state.target.originalOperationId === row.operationId &&
    state.actor?.runtimeGeneration ===
      (row.identity as NativeCommandSession).runtimeGeneration &&
    !["stopped", "completed", "failed", "idle"].includes(state.phase)
  )
    throw new NativeCommandError("suspended-execution-not-terminal");
}

/** Called inside the command's locked dispatch transaction, before native IPC. */
export async function dispatchNativeSuspension(
  repository: NativeSuspensionRepository,
  owner: string,
  row: Command,
  input: NativeCommandDispatch,
): Promise<boolean> {
  const intent = row.intent as NativeCommandAdmission["intent"];
  if (!intent.durableSuspension && row.method !== "turn/interrupt")
    return false;
  const prior = await repository.read(owner, row.chatId);
  const stopping =
    row.method === "turn/interrupt" &&
    prior !== null &&
    !["stopped", "completed", "failed", "idle"].includes(prior.phase);
  if (!intent.durableSuspension && !stopping) return false;
  if (!intent.durableSuspension)
    throw new NativeCommandError("suspension-durable-control-required");
  if (
    !["turn/pause", "turn/interrupt"].includes(row.method) ||
    !input.workerGeneration ||
    !input.session.runtimeGeneration ||
    !input.session.threadId ||
    !intent.expectedTurnId
  )
    throw new NativeCommandError("invalid-suspension-control");
  const action =
    row.method === "turn/interrupt"
      ? "stop"
      : intent.paused
        ? "pause"
        : "resume";
  const requested = await repository.request(owner, row.chatId, action, {
    threadId: input.session.threadId,
    turnId: intent.expectedTurnId,
  });
  // A duplicate after acknowledgement needs no second owner or native action.
  if (["paused", "running", "stopped"].includes(requested.state.phase))
    throw new NativeCommandError("suspension-control-settled");
  await repository.claim(
    owner,
    row.chatId,
    requested.state.controlId,
    requested.state.actor,
    {
      workerGeneration: input.workerGeneration,
      runtimeGeneration: input.session.runtimeGeneration,
      operationId: row.operationId,
      operationGeneration: row.operationGeneration,
    },
    { threadId: input.session.threadId, turnId: intent.expectedTurnId },
  );
  return true;
}

/** Commit the native acknowledgement and command receipt atomically. */
export async function settleNativeSuspension(
  repository: NativeSuspensionRepository,
  owner: string,
  row: Command,
  input: NativeCommandSettlement,
): Promise<void> {
  const intent = row.intent as NativeCommandAdmission["intent"];
  if (!intent.durableSuspension) {
    if (input.durableSuspension || input.suspensionEvidence)
      throw new NativeCommandError("unexpected-suspension-evidence");
    return;
  }
  const state = await repository.read(owner, row.chatId);
  if (
    !state?.actor ||
    state.actor.operationId !== row.operationId ||
    state.actor.operationGeneration !== row.operationGeneration ||
    state.actor.runtimeGeneration !==
      (row.identity as NativeCommandSession).runtimeGeneration ||
    state.actor.workerGeneration !== input.workerGeneration ||
    !input.durableSuspension
  )
    throw new NativeCommandError("suspension-actor-stale");
  // A terminal native event may beat this control. Retain the terminal result.
  if (["completed", "failed", "stopped", "idle"].includes(state.phase)) return;
  if (input.status !== "applied") {
    await repository.failedControl(
      owner,
      row.chatId,
      state.controlId,
      state.actor,
      {
        code:
          state.action === "pause"
            ? "pause-failed"
            : state.action === "resume"
              ? "restore-failed"
              : "stop-failed",
        protectedDetails: null,
      },
    );
  } else if (state.action === "pause") {
    if (!input.suspensionEvidence)
      throw new NativeCommandError("suspension-evidence-required");
    await repository.paused(
      owner,
      row.chatId,
      state.controlId,
      state.actor,
      input.suspensionEvidence,
    );
  } else if (state.action === "resume") {
    if (input.suspensionEvidence)
      throw new NativeCommandError("unexpected-suspension-evidence");
    await repository.running(owner, row.chatId, state.controlId, state.actor);
  } else {
    await repository.stopped(owner, row.chatId, state.controlId, state.actor);
  }
}

/** Only a real native terminal result from the owning runtime retires recovery.
 * Transport closure/administrative finish is deliberately not terminal proof. */
export async function finishNativeSuspension(
  repository: NativeSuspensionRepository,
  owner: string,
  row: Command,
  input: NativeCommandSettlement,
): Promise<void> {
  if (
    !input.reconciliation?.terminalStatus ||
    input.deferred ||
    input.decline ||
    row.kind !== "start"
  )
    return;
  const state = await repository.read(owner, row.chatId);
  if (
    !state?.actor ||
    !state.active ||
    state.action === "stop" ||
    state.target.originalOperationId !== row.operationId ||
    state.active.turnId !== input.reconciliation.nativeTurnId ||
    state.actor.runtimeGeneration !== input.reconciliation.runtimeGeneration ||
    state.actor.runtimeGeneration !==
      (row.identity as NativeCommandSession).runtimeGeneration ||
    ["completed", "failed", "stopped", "idle"].includes(state.phase)
  )
    return;
  await repository.finished(
    owner,
    row.chatId,
    state.controlId,
    state.actor,
    state.active,
    input.reconciliation.terminalStatus === "failed" ? "failed" : "completed",
  );
}
