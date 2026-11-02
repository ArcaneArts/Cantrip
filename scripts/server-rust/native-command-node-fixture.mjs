import { taskEligibilityFixture } from "./task-eligibility-node-fixture.mjs";
import { taskWorkersFixture } from "./task-workers-node-fixture.mjs";
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
import { managedGuiFinishFixture } from "./managed-gui-finish-node-fixture.mjs";
import { acquireChatTurnExecution } from "../../cantrip_server/src/app/runtime/chat-turn-admission.ts";
import {
  validateChatTurnInput,
  chatTurnModelConfiguration,
} from "../../cantrip_server/src/app/runtime/chat-turn-configuration.ts";
import { receiptHandlerFixture } from "./receipt-handler-node-fixture.mjs";
import { protectChatInput } from "../../cantrip_server/src/app/runtime/protect-chat-input.ts";
import { turnPlacementFixture } from "./turn-placement-node-fixture.mjs";
import { turnBehaviorFixture } from "./turn-behavior-node-fixture.mjs";
import { guiTelemetryFixture } from "./gui-telemetry-node-fixture.mjs";
import { runtimeQuotaFixture } from "./gui-runtime-quota-node-fixture.mjs";
import { turnLiveFixture } from "./turn-live-node-fixture.mjs";
import { taskDispatchLeaseFixture } from "./task-dispatch-lease-node-fixture.mjs";
import { turnBootstrapFixture } from "./turn-bootstrap-node-fixture.mjs";
import { turnExecutionFixture } from "./turn-execution-node-fixture.mjs";
import { automaticTitleFixture } from "./automatic-title-node-fixture.mjs";
import { recoveryFixture } from "./recovery-node-fixture.mjs";
import { nativeHandoffFixture } from "./native-handoff-node-fixture.mjs";
import { accountFailoverFixture } from "./account-failover-node-fixture.mjs";
import { taskFixture } from "./task-node-fixture.mjs";
import { taskSchedulerFixture } from "./task-scheduler-node-fixture.mjs";
import { taskGoalFixture } from "./task-goal-node-fixture.mjs";
import { taskRetryFixture } from "./task-retry-node-fixture.mjs";

export async function nativeCommandFixture(repository, input) {
  if (input.op === "native-command-task-queue")
    return automaticTitleFixture(repository, input);
  if (input.op === "native-command-task-eligibility")
    return taskEligibilityFixture(repository, input);
  if (input.op === "native-command-task-workers")
    return taskWorkersFixture(repository, input);
  if (
    [
      "native-command-task-goal",
      "native-command-task-automatic",
      "native-command-automation-pause",
    ].includes(input.op)
  )
    return taskGoalFixture(repository, input);
  if (input.op === "native-command-task-retry")
    return taskRetryFixture(repository, input);
  if (input.op === "native-command-task-scheduler")
    return taskSchedulerFixture(repository, input);
  if (input.op === "native-command-task") return taskFixture(repository, input);
  if (input.op === "native-command-account-prepare")
    return accountFailoverFixture(repository, input);
  if (input.op === "native-command-runtime-handoff")
    return nativeHandoffFixture(repository, input);
  if (input.op === "native-command-recovery")
    return recoveryFixture(repository, input);
  if (input.op === "native-command-automatic-title")
    return automaticTitleFixture(repository, input);
  if (
    [
      "native-command-turn-execution",
      "native-command-task-claimed",
      "native-command-task-background",
      "native-command-turn-outcome",
    ].includes(input.op)
  )
    return turnExecutionFixture(repository, input);
  if (input.op === "native-command-turn-bootstrap")
    return turnBootstrapFixture(repository, input);
  if (input.op === "native-command-turn-live")
    return turnLiveFixture(repository, input);
  if (input.op === "native-command-task-lease")
    return taskDispatchLeaseFixture(repository, input);
  if (input.op === "native-command-gui-quota")
    return runtimeQuotaFixture(repository, input);
  if (input.op === "native-command-gui-telemetry")
    return guiTelemetryFixture(repository, input);
  if (input.op === "native-command-gui-behavior")
    return turnBehaviorFixture(input);
  if (
    ["native-command-gui-placement", "native-command-gui-worktree"].includes(
      input.op,
    )
  )
    return turnPlacementFixture(repository, input);
  if (input.op === "native-command-gui-protect") {
    let command;
    const result = await protectChatInput(
      {
        request: async (worker, request) => {
          command = { worker, command: request };
          if (input.failRequest)
            throw new Error("Controlled protection failure");
          return input.response;
        },
      },
      input.worker,
      input.input ?? {},
      input.attachments ?? [],
      input.reasoningEffort,
      input.role,
    );
    return { result, ...command };
  }
  if (input.op === "native-command-receipt-handler")
    return receiptHandlerFixture(repository, input);
  if (input.op === "native-command-gui-validate") {
    validateChatTurnInput(
      input.context,
      input.input ?? {},
      input.options ?? {},
    );
    return null;
  }
  if (input.op === "native-command-gui-configuration")
    return chatTurnModelConfiguration(
      input.context,
      input.input ?? {},
      input.model,
    );
  if (input.op === "native-command-gui-acquire") {
    const context =
      input.context ??
      (await repository.getChatExecutionContext(input.owner, input.chat));
    return acquireChatTurnExecution({
      repository,
      ownerId: input.owner,
      context,
      options: input.options ?? {},
      protectedAdmissionInput: input.protectedInput,
      observeTaskTurnBootstrapStage: (_stage, run) => run(),
    });
  }
  if (input.op === "native-command-logical-managed-finish")
    return managedGuiFinishFixture(repository, input);
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
