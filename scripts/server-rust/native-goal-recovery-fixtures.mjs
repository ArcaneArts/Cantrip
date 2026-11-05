const source = {
  operationId: "original-goal-operation",
  operationGeneration: "original-goal-generation",
  threadId: "original-goal-thread",
  goalEpoch: "original-goal-epoch",
};
const admission = {
  operationId: "recovered-goal-operation",
  operationGeneration: "recovered-goal-generation",
  workerGeneration: "f57d812b-37d4-4d1e-b87a-3503b0d89b23",
};

export function nativeGoalRecoveryWireFixtures() {
  const recovery = { source, admission };
  return {
    nativeGoalRecoverySourceSchema: [source],
    nativeGoalRecoveryAdmissionSchema: [admission],
    nativeGoalRecoverySchema: [
      { source },
      { source, admission: null },
      recovery,
    ],
    nativeGoalRecoveryReceiptSchema: [
      { source, status: "admitted", admission },
      ...[
        "source-changed",
        "paused",
        "stopped",
        "epoch-changed",
        "not-active",
      ].map((reason) => ({
        source,
        status: "ineligible",
        workerGeneration: admission.workerGeneration,
        reason,
      })),
    ],
    nativeGoalRecoveryFenceSchema: [
      {
        serverId: "server",
        workerId: "worker",
        workerGeneration: "22222222-2222-4222-8222-222222222222",
        source,
        admission,
      },
    ],
    nativeGoalRecoveryFenceResultSchema: [{ recovery: null }, { recovery }],
  };
}
