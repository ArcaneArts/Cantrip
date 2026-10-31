import {
  nativeCommandContext,
  readNativeCommand,
} from "../../cantrip_server/src/db/repository/native-command-context.ts";
import {
  findObservedNativeCommandTurn,
  findObservedNativeInputTurn,
} from "../../cantrip_server/src/db/repository/native-command-turns.ts";
import { lockNativeCommandChat } from "../../cantrip_server/src/db/repository/native-command-lock.ts";
import { nativeSettingsFixture } from "./native-settings-node-fixture.mjs";
import { executionLaneFixture } from "./execution-lane-node-fixture.mjs";
import { queuedPromptFixture } from "./queued-prompt-node-fixture.mjs";
import { managedQueueFixture } from "./managed-queue-node-fixture.mjs";
import { nativeEventFixture } from "./native-event-node-fixture.mjs";
import { interactionFixture } from "./agent-interaction-node-fixture.mjs";

export async function nativeCommandFixture(repository, input) {
  if (input.op === "native-command-interaction")
    return interactionFixture(repository, input);
  const { owner, worker, operation, generation, chat } = input;
  if (input.op === "native-command-event-context")
    return nativeEventFixture(repository, input);
  if (input.op.startsWith("native-command-managed-queue-"))
    return managedQueueFixture(repository, input);
  if (input.op.startsWith("native-command-prompt-"))
    return queuedPromptFixture(repository, input);
  if (
    input.op === "native-command-observed-turn" ||
    input.op === "native-command-observed-input"
  )
    return repository.nativeCommands.database.transaction(async (tx) => {
      const row = await readNativeCommand(
        tx,
        owner,
        worker,
        operation,
        generation,
      );
      return (
        (input.op === "native-command-observed-input"
          ? await findObservedNativeInputTurn(tx, row)
          : await findObservedNativeCommandTurn(tx, row, {
              backfill: input.backfill,
            })) ?? null
      );
    });
  if (input.op === "native-command-logical-continue")
    return repository.nativeCommands.continueExecution(owner, input.input);
  if (input.op === "native-command-logical-root")
    return repository.nativeCommands.logicalGuiOutcomeRoot(
      owner,
      worker,
      input.input,
    );
  if (input.op === "native-command-logical-finish")
    return repository.nativeCommands.finishLogicalGui(
      owner,
      worker,
      operation,
      generation,
      input.status,
    );
  if (input.op === "native-command-logical-deferred")
    return repository.nativeCommands.hasDeferredLogicalGui(
      owner,
      worker,
      operation,
      generation,
    );
  if (input.op === "native-command-logical-pending")
    return repository.nativeCommands.listPendingLogicalCompletions(input.limit);
  if (input.op === "native-command-logical-get")
    return repository.nativeCommands.getLogicalCompletion(
      owner,
      worker,
      chat,
      operation,
      generation,
    );
  if (input.op === "native-command-logical-ack")
    return repository.nativeCommands.acknowledgeLogicalCompletion(
      owner,
      worker,
      chat,
      operation,
      generation,
    );
  if (input.op === "native-command-logical-defer")
    return repository.nativeCommands.deferLogicalCompletion(
      owner,
      worker,
      chat,
      operation,
      generation,
      new Date(input.nextAttemptAt),
    );
  if (input.op === "native-command-recovery-context")
    return repository.nativeCommands.recoveryContext(owner, chat);
  if (input.op === "native-command-recover")
    return repository.nativeCommands.recoverExecution(
      owner,
      worker,
      input.expected,
      input.observed,
    );
  if (input.op === "native-command-settle")
    return repository.nativeCommands.settle(owner, input.input);
  if (input.op === "native-command-evidence")
    return repository.nativeCommands.recordSettingsEvidence(owner, input.input);
  if (input.op === "native-command-stop-autonomy")
    return repository.nativeCommands.stopAutonomy(
      owner,
      chat,
      input.expected ?? null,
    );
  if (input.op === "native-command-resume-autonomy") {
    await repository.nativeCommands.resumeAutonomy(owner, chat);
    return null;
  }
  if (input.op === "native-command-cancel-preparing")
    return repository.nativeCommands.cancelPreparing(
      owner,
      chat,
      input.generation,
    );
  if (input.op === "native-command-control-context")
    return repository.nativeCommands.controlContext(owner, chat);
  if (input.op === "native-command-finish-execution")
    return repository.nativeCommands.finishExecution(
      owner,
      worker,
      operation,
      generation,
      input.status,
    );
  if (input.op === "native-command-dispatch")
    return repository.nativeCommands.dispatch(owner, input.input);
  if (input.op === "native-command-admit")
    return repository.nativeCommands.admit(
      owner,
      input.input,
      input.options ?? {},
    );
  if (input.op.startsWith("native-command-lane-"))
    return executionLaneFixture(repository, input);
  if (input.op.startsWith("native-command-settings-"))
    return nativeSettingsFixture(repository, input);
  if (input.op === "native-command-lookup")
    return repository.nativeCommands.lookup(owner, worker, operation);
  if (input.op === "native-command-get")
    return repository.nativeCommands.get(owner, worker, operation, generation);
  if (input.op === "native-command-existing-admission")
    return repository.nativeCommands.admit(owner, input.input);
  if (input.op === "native-command-bind-preparation")
    return repository.nativeCommands.bindPreparation(owner, input.input);
  if (input.op === "native-command-register-pending") {
    await repository.nativeCommands.registerPending(owner, input.input);
    return null;
  }
  if (
    ["native-command-context", "native-command-locked-context"].includes(
      input.op,
    )
  )
    return repository.nativeCommands.database.transaction(async (tx) => {
      if (input.op === "native-command-locked-context")
        await lockNativeCommandChat(tx, owner, chat);
      return nativeCommandContext(tx, owner, chat);
    });
  throw new Error("Unknown native command operation: " + input.op);
}
