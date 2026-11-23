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
  const claim = {
    claimId: "claim",
    promptId: "prompt",
    promptRevision: 0,
    ...source,
    admission: null,
  };
  const providerEpisodes = [0, 1, Number.MAX_SAFE_INTEGER].map(
    (orderEpoch) => ({
      source,
      providerId: "configured-goal-provider",
      orderEpoch,
      admission: orderEpoch === 0 ? null : admission,
    }),
  );
  const fixtures = {
    nativeGoalClaimRecoverySchema: [claim, { ...claim, admission }],
    nativeGoalClaimRecoveryReceiptSchema: [
      { status: "queued", claim, admission },
      ...["recovering", "deferred"].map((status) => ({
        status,
        claim,
        workerGeneration: admission.workerGeneration,
      })),
      ...[
        null,
        "active",
        "paused",
        "blocked",
        "usageLimited",
        "budgetLimited",
        "complete",
      ].map((goalStatus) => ({
        status: "ineligible",
        claim,
        workerGeneration: admission.workerGeneration,
        observation: {
          chatId: "chat",
          workerId: "worker",
          threadId: source.threadId,
          contextKind: "project",
          projectId: "project",
          placementId: "worktree",
          modelRouteId: null,
          providerAccountId: null,
          runtimeGeneration: "runtime",
          nativeEpoch: "native-epoch",
          goalEpoch: goalStatus === null ? null : source.goalEpoch,
          goalStatus,
        },
      })),
    ],
    nativeGoalRecoverySourceSchema: [source],
    nativeGoalRecoveryAdmissionSchema: [admission],
    nativeGoalRecoverySchema: [
      { source },
      { source, admission: null },
      recovery,
      ...providerEpisodes,
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
    nativeGoalRecoveryFenceResultSchema: [
      { recovery: null },
      { recovery },
      ...providerEpisodes.map((recovery) => ({ recovery })),
    ],
  };
  for (const receipt of fixtures.nativeGoalRecoveryReceiptSchema.filter(
    (value) => value.status === "ineligible",
  ))
    for (const orderEpoch of [0, 1, Number.MAX_SAFE_INTEGER])
      fixtures.nativeGoalRecoveryReceiptSchema.push({
        ...receipt,
        observation: {
          chatId: "chat",
          workerId: "worker",
          threadId: source.threadId,
          contextKind: "project",
          projectId: "project",
          placementId: "worktree",
          modelRouteId: null,
          providerAccountId: null,
          runtimeGeneration: "runtime",
          nativeEpoch: "native-epoch",
          orderEpoch,
        },
      });
  return fixtures;
}
