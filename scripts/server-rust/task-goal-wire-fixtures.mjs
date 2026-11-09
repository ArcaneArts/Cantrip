import { taskInputWireFixtures } from "./task-input-wire-fixtures.mjs";

export function taskGoalWireFixtures(fixtures) {
  const { cycleSource, cycleParent } = taskInputWireFixtures();
  const cycle = cycleSource.cycle;
  const base = fixtures.nativeInferenceRecoverySchema[0].record;
  const record = {
    ...base,
    identity: {
      ...base.identity,
      operationId: cycleSource.operationId,
      chatId: cycleParent.chatId,
      recovery: {
        threadId: cycleSource.threadId,
        turnId: cycleSource.turnId,
        taskGoalCycle: cycle,
      },
    },
  };
  const inputRecord = {
    ...base,
    identity: {
      ...base.identity,
      operationId: cycleParent.operationId,
      providerId: cycleParent.providerId,
      chatId: cycleParent.chatId,
      recovery: {
        threadId: cycleSource.threadId,
        messageId: cycleParent.clientMessageId,
        taskInput: cycleParent,
      },
    },
  };
  const originalSnapshot = fixtures.protectedNativeSettingsSnapshotSchema[0];
  const snapshot = {
    ...originalSnapshot,
    context: {
      ...originalSnapshot.context,
      chatId: cycleParent.chatId,
      threadId: cycleSource.threadId,
    },
  };
  const taskGoalInput = {
    goalEpoch: cycle.goalEpoch,
    runnerGeneration: cycle.runnerGeneration,
    orderEpoch: cycle.orderEpoch,
    sourceQueueRevision: 0,
  };
  const capture = { record, snapshot };
  const nativeExecution = {
    threadId: cycleSource.threadId,
    turnId: cycleSource.turnId,
    scopeId: cycle.scopeId,
  };
  const grantedRecord = {
    ...record,
    state: "granted",
    everGranted: true,
    nativeExecution,
  };
  const grantedCapture = { record: grantedRecord, snapshot };
  const inputCapture = { record: inputRecord, snapshot, taskGoalInput };
  const recovery = {
    sourceKey: cycleSource.sourceKey,
    operationId: cycleSource.operationId,
    runtimeGeneration: cycleSource.runtimeGeneration,
    workerGeneration: cycleSource.workerGeneration,
    workerId: cycleParent.workerId,
    providerId: cycleParent.providerId,
    threadId: cycleSource.threadId,
    turnId: cycleSource.turnId,
    cycle,
  };
  return {
    taskGoalCycleIdentitySchema: [
      cycle,
      { ...cycle, orderEpoch: Number.MAX_SAFE_INTEGER },
    ],
    taskGoalCycleRecoverySchema: [
      recovery,
      { ...recovery, suspension: { source: cycleSource } },
      {
        ...recovery,
        suspension: {
          source: cycleSource,
          restoration: {
            controlId: cycleSource.publication.id,
            receipt: {
              ...cycleParent,
              operationId: "00000000-0000-4000-8000-000000000011",
              dispatch: {
                ...cycleParent.dispatch,
                fencingToken: cycleParent.dispatch.fencingToken + 1,
              },
            },
            accepted: true,
            dispatched: true,
            claimWorkerGeneration: recovery.workerGeneration,
            nativeExecution: { ...nativeExecution, turnId: "restored-turn" },
            nativeOwner: {
              workerGeneration: recovery.workerGeneration,
              runtimeGeneration: recovery.runtimeGeneration,
            },
            checkpointActor: {
              workerGeneration: recovery.workerGeneration,
              runtimeGeneration: recovery.runtimeGeneration,
              operationId: recovery.operationId,
              operationGeneration: "original-generation",
            },
            checkpointExecution: nativeExecution,
          },
          terminal: {
            ok: true,
            failureKind: null,
            outcomeDigest: "b".repeat(64),
            historyOnly: false,
            observedAt: "2026-11-09T00:00:00.000Z",
            projectedAt: "2026-11-09T00:00:00.000Z",
            threadId: cycleSource.threadId,
            turnId: "restored-turn",
          },
        },
      },
      {
        ...recovery,
        binding: {
          modelRouteId: cycle.modelRouteId,
          providerAccountId: null,
          orderEpoch: 1,
        },
        admission: null,
        settled: {
          reason: "ineligible",
          turnId: cycleSource.turnId,
          operationId: null,
        },
      },
      {
        ...recovery,
        admission: {
          workerGeneration: cycleSource.workerGeneration,
          runtimeGeneration: cycleSource.runtimeGeneration,
          operationId: "recovered-cycle",
        },
      },
    ],
    taskGoalCycleDispatchSchema: [
      {
        sourceKey: recovery.sourceKey,
        operationId: recovery.operationId,
        serverId: "server",
        workerId: recovery.workerId,
        workerGeneration: recovery.workerGeneration,
        chatId: cycleParent.chatId,
        providerId: recovery.providerId,
        threadId: recovery.threadId,
        turnId: recovery.turnId,
        cycle,
      },
    ],
    taskGoalCycleDispatchResultSchema: [
      { accepted: true },
      { accepted: true, suspensionSource: cycleSource },
    ],
    taskGoalCycleRecoveryReceiptSchema: [
      {
        status: "scheduled",
        sourceKey: recovery.sourceKey,
        workerGeneration: recovery.workerGeneration,
        admission: {
          operationId: "scheduled-cycle",
          runtimeGeneration: recovery.runtimeGeneration,
        },
      },
      ...[
        null,
        "active",
        "paused",
        "blocked",
        "usageLimited",
        "budgetLimited",
        "complete",
      ].map((observedGoalStatus) => ({
        status: "ineligible",
        sourceKey: recovery.sourceKey,
        workerGeneration: recovery.workerGeneration,
        threadId: recovery.threadId,
        modelRouteId: cycle.modelRouteId,
        providerAccountId: cycle.providerAccountId,
        nativeEpoch: "native-epoch",
        observedGoalEpoch: observedGoalStatus === null ? null : cycle.goalEpoch,
        observedGoalStatus,
      })),
    ],
    nativeSuspensionTaskGoalCycleSchema: [
      {
        cycleId: cycle.cycleId,
        sourceKey: recovery.sourceKey,
        operationId: recovery.operationId,
        goalEpoch: cycle.goalEpoch,
        scopeId: cycle.scopeId,
      },
    ],
    taskGoalCycleSourceRecordSchema: [record, grantedRecord],
    taskGoalInputSourceRecordSchema: [inputRecord],
    taskGoalCycleCaptureSchema: [capture, grantedCapture],
    taskGoalInputTransferContextSchema: [taskGoalInput],
    taskGoalInputCaptureSchema: [inputCapture],
    taskGoalHandoffCaptureSchema: [capture, grantedCapture, inputCapture],
    nativeRuntimeHandoffTaskContextSchema: [
      {
        chatId: cycleParent.chatId,
        projectId: "project",
        worktreeId: cycleParent.worktreeId,
        rootKind: "git-worktree",
        computerUseEnabled: false,
        cycleId: cycle.cycleId,
        orderEpoch: cycle.orderEpoch,
        goalEpoch: cycle.goalEpoch,
      },
    ],
  };
}
