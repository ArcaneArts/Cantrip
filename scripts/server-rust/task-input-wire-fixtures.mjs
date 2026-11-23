// Canonical Task/Goal seeds shared by focused and full wire comparisons.
import * as protocol from "../../packages/protocol/dist/index.js";
import alternatives from "./worker-command-alternatives.json" with { type: "json" };
import { record as suspension } from "./native-suspension-oracle.mjs";

export function taskInputWireFixtures() {
  const envelope = structuredClone(
    alternatives.cases.find(
      ({ input }) =>
        input.command.type === "chat.turn" &&
        input.command.resultMode?.kind === "task-encrypted",
    ).input,
  );
  const command = envelope.command;
  const operation = command.resultMode.operation;
  command.clientMessageId = operation.userMessage.id;
  command.taskDispatchLease = {
    cycleId: "00000000-0000-4000-8000-000000000002",
    operationId: operation.operationId,
    leaseOwner: "fixture-task-owner",
    fencingToken: 1,
    leaseExpiresAt: "2026-11-05T00:00:00.000Z",
  };
  command.taskInferenceInput = {
    operationId: "00000000-0000-4000-8000-000000000003",
    chatId: command.chatId,
    clientMessageId: command.clientMessageId,
    workerId: "fixture-task-worker",
    worktreeId: command.worktreeId,
    executionLaneId: command.executionLaneId,
    executionLaneActivatedAt: "2026-11-05T00:00:00.000Z",
    providerId: command.provider.id,
    modelRouteId: command.model.routeId,
    providerAccountId: command.provider.accountId,
    dispatch: Object.fromEntries(
      ["cycleId", "operationId", "leaseOwner", "fencingToken"].map((key) => [
        key,
        command.taskDispatchLease[key],
      ]),
    ),
  };
  protocol.workerRequestEnvelopeSchema.parse(envelope);
  const dispatch = {
    serverId: "fixture-server",
    workerId: command.taskInferenceInput.workerId,
    workerGeneration: "00000000-0000-4000-8000-000000000004",
    receipt: command.taskInferenceInput,
  };
  const nativeBinding = {
    ...dispatch,
    phase: "native",
    nativeExecution: {
      threadId: "native-thread",
      turnId: "native-turn",
      scopeId: "native-scope",
    },
    nativeRuntimeGeneration: "00000000-0000-4000-8000-000000000005",
  };
  const samples = {
    taskTurnStopSchema: [
      {
        controlId: "00000000-0000-4000-8000-000000000008",
        source: command.taskInferenceInput,
        active: suspension.active,
        checkpoint: suspension.checkpoint,
        scope: {
          revision: 1,
          workerId: command.taskInferenceInput.workerId,
          projectId: command.policyProjectId,
          worktreeId: command.worktreeId,
          threadId: suspension.active.threadId,
          modelRouteId: command.model.routeId,
          providerAccountId: command.provider.accountId,
          cycleId: command.taskDispatchLease.cycleId,
          orderEpoch: 0,
          taskRound: {
            operationId: operation.operationId,
            inputOperationId: command.taskInferenceInput.operationId,
            cycleId: command.taskDispatchLease.cycleId,
          },
        },
      },
    ],
    taskTurnStopResultSchema: [
      {
        controlId: "00000000-0000-4000-8000-000000000008",
        interrupted: true,
        active: suspension.active,
        outcome: "stopped",
        actor: {
          workerGeneration: dispatch.workerGeneration,
          runtimeGeneration: nativeBinding.nativeRuntimeGeneration,
          operationId: "00000000-0000-4000-8000-000000000008",
          operationGeneration: "00000000-0000-4000-8000-000000000008",
        },
      },
    ],
    taskInferenceInputReceiptSchema: [command.taskInferenceInput],
    taskInferenceInputDispatchSchema: [
      dispatch,
      { ...dispatch, phase: "accepted" },
      { ...dispatch, phase: "claim" },
      nativeBinding,
    ],
    taskInferenceInputDispatchResultSchema: [
      { receipt: command.taskInferenceInput },
      {
        receipt: nativeBinding.receipt,
        nativeExecution: nativeBinding.nativeExecution,
        nativeRuntimeGeneration: nativeBinding.nativeRuntimeGeneration,
      },
    ],
  };
  const cycleParent = {
    ...structuredClone(command.taskInferenceInput),
    kind: "goal",
  };
  const cycleSource = {
    kind: "goal-cycle",
    sourceKey: "f".repeat(64),
    operationId: `native-inference:${suspension.active.threadId}:${suspension.active.turnId}:cycle-scope:cycle-attempt`,
    workerGeneration: dispatch.workerGeneration,
    runtimeGeneration: nativeBinding.nativeRuntimeGeneration,
    ...suspension.active,
    cycle: {
      cycleId: cycleParent.dispatch.cycleId,
      goalEpoch: "epoch",
      scopeId: "cycle-scope",
      gateAttemptId: "cycle-attempt",
      runnerGeneration: "runner",
      modelRouteId: cycleParent.modelRouteId,
      providerAccountId: cycleParent.providerAccountId,
      orderEpoch: 0,
    },
    parent: cycleParent,
    publication: {
      id: "00000000-0000-4000-8000-000000000010",
      idempotencyKey: "assistant:goal-cycle:fixture",
    },
  };
  protocol.taskGoalCycleSuspensionSourceSchema.parse(cycleSource);
  const cycleRestore = {
    controlId: "00000000-0000-4000-8000-000000000008",
    checkpoint: suspension.checkpoint,
    source: cycleParent,
    goalCycle: cycleSource,
  };
  const cycleDelivery = {
    version: 1,
    inputKind: "goal-cycle",
    deliveryId: cycleSource.publication.id,
    serverId: "fixture-server",
    ownerId: "fixture-owner",
    workerId: cycleParent.workerId,
    goalCycleSource: cycleSource,
    notification: {
      type: "chat.turn.outcome",
      chatId: cycleParent.chatId,
      clientMessageId: cycleParent.clientMessageId,
      executionLaneId: cycleParent.executionLaneId,
      contextKind: "project",
      scratchRootId: null,
      worktreeId: cycleParent.worktreeId,
      outcome: {
        ok: true,
        result: {
          ...suspension.active,
          text: "",
          status: "completed",
          structuredResult: {},
        },
      },
    },
  };
  Object.assign(samples, {
    taskGoalCycleSuspensionSourceSchema: [
      cycleSource,
      { ...cycleSource, parent: { ...cycleParent, kind: undefined } },
      { ...cycleSource, operationId: "another-native-operation" },
      {
        ...cycleSource,
        cycle: { ...cycleSource.cycle, cycleId: cycleSource.publication.id },
      },
    ],
    taskTurnResumptionSchema: [
      cycleRestore,
      {
        ...cycleRestore,
        source: { ...cycleParent, operationId: cycleSource.publication.id },
      },
      {
        ...cycleRestore,
        goalCycle: {
          ...cycleSource,
          turnId: "another-turn",
          operationId: `native-inference:${cycleSource.threadId}:another-turn:cycle-scope:cycle-attempt`,
        },
      },
    ],
    taskGoalOutcomeDeliverySchema: [
      cycleDelivery,
      { ...cycleDelivery, inputKind: "goal" },
      {
        ...cycleDelivery,
        notification: {
          ...cycleDelivery.notification,
          taskInferenceInputOperationId: cycleParent.operationId,
        },
      },
    ],
    taskGoalOutcomeCommitSchema: [
      {
        deliveryId: cycleSource.publication.id,
        goalCycleSourceKey: cycleSource.sourceKey,
        committed: true,
      },
      { deliveryId: cycleSource.publication.id, committed: true },
      {
        deliveryId: cycleSource.publication.id,
        goalCycleSourceKey: cycleSource.sourceKey,
        taskInferenceInputOperationId: cycleParent.operationId,
        committed: true,
      },
    ],
  });
  const invalidSamples = {};
  for (const name of [
    "taskGoalCycleSuspensionSourceSchema",
    "taskTurnResumptionSchema",
    "taskGoalOutcomeDeliverySchema",
    "taskGoalOutcomeCommitSchema",
  ]) {
    invalidSamples[name] = samples[name].slice(1);
    samples[name] = samples[name].slice(0, 1);
  }
  return {
    samples,
    invalidSamples,
    envelope,
    command,
    operation,
    dispatch,
    nativeBinding,
    cycleParent,
    cycleSource,
  };
}

export function taskInputWireCases(name) {
  if (
    ![
      "taskGoalCycleSuspensionSourceSchema",
      "taskTurnResumptionSchema",
      "taskGoalOutcomeDeliverySchema",
      "taskGoalOutcomeCommitSchema",
    ].includes(name)
  )
    return [];
  return taskInputWireFixtures().invalidSamples[name];
}
